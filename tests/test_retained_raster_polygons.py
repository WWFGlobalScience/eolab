"""Calculation-local polygon reuse preserves masks, budgets and cleanup."""

from pathlib import Path
from typing import Any

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import MultiPolygon, Polygon, box, mapping

import eolab_app.bounded_vector as vector
import eolab_app.processing.raster_aggregate as kernel
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.models import ProcessingError
from eolab_app.raster.models import RasterMaskTimings
from eolab_app.raster.read_cancellation import RasterReadCancelled
from catalog_selection_support import write_selection
from test_raster_aggregates import make_spec
from test_raster_clips import write_source


@pytest.mark.parametrize("chunk_pixels", [None, 4096])
@pytest.mark.parametrize("fail_read", [False, True])
def test_calculation_reuses_polygons_and_releases_them(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    chunk_pixels: int | None,
    fail_read: bool,
) -> None:
    """The real kernel reuses prepared masks and releases them on either exit.

    Args:
        tmp_path: Isolated raster, vector and result files.
        monkeypatch: Count real projection calls and inject a raster-read failure.
        chunk_pixels: Native reads or combined native blocks.
        fail_read: Raise after polygon preparation to verify failure cleanup.
    """
    geometries = [
        mapping(
            Polygon(
                [(1, 1), (7, 1), (7, 7), (1, 7), (1, 1)],
                [[(2, 2), (2, 4), (4, 4), (4, 2), (2, 2)]],
            )
        ),
        mapping(MultiPolygon([box(5, 3, 8, 6), box(0, 0, 0.5, 0.5)])),
    ]
    selected = write_selection(tmp_path / "selected.gpkg", geometries)
    path = write_source(
        tmp_path / "raster.tif",
        np.ones((64, 64), dtype="uint16"),
        transform=from_origin(0, 8, 0.125, 0.125),
    )
    area = AggregateArea(
        kind="catalogSelection",
        bounds=(0, 0, 8, 7),
        catalogSelection=selected.selection,
        resolved=selected,
    )
    limits = RasterAggregateLimits()
    plan = make_spec(path, ["sum(a)"], area, target_chunk_pixels=chunk_pixels)
    plan = plan.model_copy(update={"area": area})
    original_project = vector.PolygonRasterizer.project
    prepared: list[vector.PolygonRasterizer] = []
    calls = 0

    def project(
        reader: vector.PolygonRasterizer, geometry: dict[str, Any]
    ) -> tuple[dict[str, object], ...]:
        """Count projections and retain the reader only to inspect its cleanup.

        Args:
            reader: Production reader being prepared.
            geometry: Validated source polygon.

        Returns:
            Unchanged production projection.
        """
        nonlocal calls
        calls += 1
        if reader not in prepared:
            prepared.append(reader)
        return original_project(reader, geometry)

    def forbidden_read(*args: Any, **kwargs: Any) -> Any:
        """Raise a simulated raster I/O error after area preparation.

        Args:
            args: Production read arguments.
            kwargs: Production read keyword arguments.

        Raises:
            OSError: Always, to exercise cleanup.
        """
        raise OSError("Injected raster read failure")

    monkeypatch.setattr(vector.PolygonRasterizer, "project", project)
    if fail_read:
        monkeypatch.setattr(kernel, "read_native_raster_block", forbidden_read)
        monkeypatch.setattr(kernel, "read_native_raster_window", forbidden_read)
        with pytest.raises(OSError, match="Injected"):
            kernel.calculate_raster_statistics_for_area(path, plan, tmp_path, limits)
    else:
        result = kernel.calculate_raster_statistics_for_area(
            path, plan, tmp_path, limits
        )
        reference_dir = tmp_path / "reference"
        reference_dir.mkdir()
        historical = AggregateArea(
            kind="aoi", bounds=(0, 0, 8, 7), geometries=tuple(geometries)
        )
        reference_plan = make_spec(
            path, ["sum(a)"], historical, target_chunk_pixels=chunk_pixels
        )
        reference = kernel.calculate_raster_statistics_for_area(
            path, reference_plan, reference_dir, limits
        )
        assert result.rows == reference.rows
        assert result.sha256 == reference.sha256
        assert result.performance["retainedPolygonBytes"] > 0
        assert result.performance["stages"]["selectionSetupSeconds"] > 0
        assert result.performance["temporaryMaskBytes"] > 0
        assert result.performance["stages"]["maskPreparationSeconds"] > 0
        assert result.performance["stages"]["maskReadSeconds"] > 0
        assert result.performance["stages"]["selectionMaskBreakdown"] is None
    assert not (tmp_path / "polygon-mask.tif").exists()
    assert calls == len(geometries)
    assert len(prepared) == 1
    assert prepared[0].retained_bytes == 0
    with pytest.raises(ValueError, match="released"):
        prepared[0].rasterize((1, 1), from_origin(0, 8, 1, 1), False)


@pytest.mark.parametrize("failure", ["budget", "cancel", "projection"])
def test_preparation_limits_and_cancellation_release_prior_features(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    """Stop incrementally, releasing the first polygon if the second fails.

    Args:
        tmp_path: Isolated native fixture files.
        monkeypatch: Observe projections and inject cancellation/native failure.
        failure: Cumulative memory, cancellation or projection failure.
    """
    selected = write_selection(
        tmp_path / "selected.gpkg", [mapping(box(1, 1, 2, 2)), mapping(box(3, 3, 4, 4))]
    )
    path = write_source(
        tmp_path / "raster.tif",
        np.ones((8, 8), dtype="uint8"),
        transform=from_origin(0, 8, 1, 1),
    )
    original = vector.PolygonRasterizer.project
    readers: list[vector.PolygonRasterizer] = []
    calls = 0
    cancelled = False

    def project(
        reader: vector.PolygonRasterizer, geometry: dict[str, Any]
    ) -> tuple[dict[str, object], ...]:
        """Inject a second-feature failure after retaining the first.

        Args:
            reader: Production reader with the first retained feature.
            geometry: Next source polygon.

        Returns:
            Unchanged projection unless testing failure.

        Raises:
            ValueError: For the simulated native projection error.
        """
        nonlocal calls, cancelled
        calls += 1
        readers.append(reader)
        if calls == 2:
            assert reader.retained_bytes > 0
            if failure == "projection":
                raise ValueError("Injected projection failure")
            cancelled = True
        return original(reader, geometry)

    monkeypatch.setattr(vector.PolygonRasterizer, "project", project)
    expected = {
        "budget": vector.ProjectedGeometryMemoryError,
        "cancel": RasterReadCancelled,
        "projection": ValueError,
    }[failure]
    with rasterio.open(path) as dataset, pytest.raises(expected):
        vector.PolygonRasterizer(
            dataset,
            selected,
            20,
            lambda: cancelled,
            max_retained_polygon_bytes=8000 if failure == "budget" else 100000,
        )
    assert calls == (1 if failure == "budget" else 2)
    assert all(reader.retained_bytes == 0 for reader in readers)


def test_retained_masks_do_not_reopen_sources_and_remain_cancellable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Once prepared, masks use no vector I/O and still observe cancellation.

    Args:
        tmp_path: Isolated vector and raster files.
        monkeypatch: Reject any source access after preparation.
    """
    selected = write_selection(tmp_path / "selected.gpkg", [mapping(box(1, 1, 4, 4))])
    path = write_source(
        tmp_path / "raster.tif",
        np.ones((8, 8), dtype="uint8"),
        transform=from_origin(0, 8, 1, 1),
    )
    cancelled = False
    with rasterio.open(path) as dataset:
        reader = vector.PolygonRasterizer(
            dataset, selected, 100, lambda: cancelled, max_retained_polygon_bytes=100000
        )

        def forbidden(*args: Any, **kwargs: Any) -> Any:
            """Reject source calls after preparation.

            Args:
                args: Source-call arguments.
                kwargs: Source-call keyword arguments.

            Raises:
                AssertionError: On any vector-source read during masking.
            """
            raise AssertionError("Unexpected per-tile source read")

        monkeypatch.setattr(vector, "polygon_features", forbidden)
        monkeypatch.setattr(vector, "native_bbox_for_grid", forbidden)
        timings = RasterMaskTimings()
        for _ in range(3):
            mask = reader.rasterize((8, 8), dataset.transform, False, timings)
            assert mask.sum() == 9
        cancelled = True
        with pytest.raises(RasterReadCancelled):
            reader.rasterize((8, 8), dataset.transform, False)
        reader.close()
        assert reader.retained_bytes == 0
        assert timings.feature_reading_seconds == timings.projection_seconds == 0


def test_polygon_memory_shares_the_calculation_budget(tmp_path: Path) -> None:
    """Raster buffers leave only their remaining memory for retained polygons.

    Args:
        tmp_path: Isolated raster/vector files.
    """
    selected = write_selection(tmp_path / "selected.gpkg", [mapping(box(1, 1, 4, 4))])
    path = write_source(
        tmp_path / "raster.tif",
        np.ones((8, 8), dtype="uint8"),
        transform=from_origin(0, 8, 1, 1),
    )
    area = AggregateArea(
        kind="catalogSelection",
        bounds=(1, 1, 4, 4),
        catalogSelection=selected.selection,
        resolved=selected,
    )
    plan = make_spec(path, ["sum(a)"], area).model_copy(update={"area": area})
    limits = RasterAggregateLimits(
        max_memory_bytes=plan.grid.estimatedMemoryBytes + 100
    )
    with rasterio.open(path) as dataset, pytest.raises(ProcessingError) as error:
        kernel.prepare_raster_area_tools(dataset, plan, limits)
    assert error.value.code == "polygon_memory_limit"
    assert error.value.status == 413
