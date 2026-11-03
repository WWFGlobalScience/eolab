"""Batch coverage, native semantics, immutable plans, memory contracts."""

from pathlib import Path
from typing import Any

from affine import Affine
import numpy as np
from pydantic import ValidationError
import pytest
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.windows import Window
from shapely.geometry import Polygon, mapping

from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregatePlanRequest,
    AggregateSpec,
)
from eolab_app.processing.aggregate_windows import (
    plan_raster_read_windows,
    iter_raster_read_windows,
)
from eolab_app.processing.models import ProcessingError
import eolab_app.processing.raster_aggregate as kernel
from eolab_app.processing.job_preparation import prepare_aggregate_job
from eolab_app.raster.source_contract import source_block_indexes_for_window
from raster_aggregate_support import make_spec, LIMITS
from raster_fixture_support import write_source
from raster_source_support import SOURCE
from catalog_selection_support import write_aggregate_area


@pytest.mark.parametrize(
    "shape,width,height,window",
    [
        ((32, 64), 701, 611, Window(65, 33, 613, 560)),
        ((1, 997), 997, 411, Window(14, 3, 800, 397)),
        ((16, 701), 701, 51, Window(700, 50, 1, 1)),
        ((512, 512), 513, 513, Window(511, 511, 2, 2)),
    ],
)
@pytest.mark.parametrize("target", [None, 1, 65536, 262144, 1048576, 4194304])
@pytest.mark.parametrize("tile_side", [64, 256])
def test_streamed_windows_cover_only_admitted_blocks_once(
    shape, width, height, window, target, tile_side
):
    """Non-square, striped and partial-edge windows retain exactly admitted work.

    Args:
        shape: Native block dimensions.
        width: Source width.
        height: Source height.
        window: Offset selection.
        target: Requested total-pixel budget.
        tile_side: Legacy numerical or geometry-fallback tile ceiling.
    """
    plan = plan_raster_read_windows(window, shape, width, height, target, tile_side)
    seen, counts, reads = (
        [],
        [],
        list(iter_raster_read_windows(window, shape, width, height, plan)),
    )
    for read, count in reads:
        blocks = source_block_indexes_for_window(read, shape)
        assert len(blocks) == count
        seen.extend(blocks)
        counts.append(count)
        assert read.col_off % shape[1] == read.row_off % shape[0] == 0
        assert read.col_off + read.width <= width
        assert read.row_off + read.height <= height
        assert read.width <= plan.readWidth and read.height <= plan.readHeight
    expected = set(source_block_indexes_for_window(window, shape))
    assert len(seen) == len(set(seen)) == len(expected) == sum(counts)
    assert set(seen) == expected
    assert len(reads) == plan.readWindows
    if target:
        assert plan.evaluationWidth * plan.evaluationHeight <= target


def test_width_first_expansion():
    """A million-pixel target groups four 512 blocks horizontally before vertically."""
    plan = plan_raster_read_windows(
        Window(0, 0, 4096, 4096), (512, 512), 4096, 4096, 1048576, 256
    )
    assert (plan.readWidth, plan.readHeight) == (2048, 512)
    assert (plan.evaluationWidth, plan.evaluationHeight) == (2048, 512)


@pytest.mark.parametrize("value", [0, -1, 4194305, True, 1.5, "65536"])
def test_invalid_tuning_rejected_by_request(value):
    """Invalid tuning never enters source lookup or resource admission.

    Args:
        value: Untrusted public request value.
    """
    with pytest.raises(ValidationError):
        AggregatePlanRequest(
            sources={"a": SOURCE},
            wholeRaster=True,
            calculations=[{"label": "Mean", "expression": "mean(a)"}],
            targetChunkPixels=value,
        )


@pytest.mark.parametrize("target", [65536, 262144, 1048576])
def test_batched_native_results_and_read_counts(tmp_path, monkeypatch, target):
    """Larger reads reduce actual calls while respecting native masks and overviews.

    Args:
        tmp_path: Native fixture and artifacts.
        monkeypatch: Observe read windows and progress at their owning boundaries.
        target: Requested total pixels.
    """
    values = (np.arange(601 * 703, dtype="float32").reshape(601, 703) % 100) / 3
    values[5, :5] = [np.nan, np.inf, -np.inf, -9999, 0]
    path = write_source(tmp_path / "source.tif", values, nodata=-9999)
    with rasterio.open(path, "r+") as ds:
        ds.build_overviews([2, 4], Resampling.average)
    expressions = [
        "count(a)",
        "sum(a)",
        "mean(a,where=a>10)",
        "max(a)-min(a)",
        "sum(a / (a-a))",
    ]
    baseline = kernel.calculate_raster_statistics_for_area(
        path, make_spec(path, expressions), tmp_path, LIMITS
    )
    spec = make_spec(path, expressions, target_chunk_pixels=target)
    reads, progress = [], []
    reader = kernel.read_native_raster_window

    def observed(ds, window):
        """Read admitted native values and record the actual window.

        Args:
            ds: Native reader.
            window: Admitted combined window.

        Returns:
            Actual native masked values.
        """
        reads.append(window)
        return reader(ds, window)

    monkeypatch.setattr(kernel, "read_native_raster_window", observed)
    monkeypatch.setattr(
        kernel,
        "write_progress",
        lambda directory, phase, done, total: progress.append((done, total)),
    )
    result = kernel.calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    for left, right in zip(baseline.rows, result.rows, strict=True):
        assert left["aggregates"] == right["aggregates"]
        assert left["state"] == right["state"]
        if left["value"] is None:
            assert right["value"] is None
        else:
            assert float(left["value"]) == pytest.approx(
                float(right["value"]), rel=1e-12
            )
    assert len(reads) == spec.grid.execution.readWindows < spec.grid.nativeBlocks
    assert progress[-1] == (spec.grid.nativeBlocks, spec.grid.nativeBlocks)


@pytest.mark.parametrize(
    "transform,crs",
    [
        (from_origin(-82, 0, 0.01, 0.01), "EPSG:4326"),
        (from_origin(500000, 5000000, 1000, 1000), "EPSG:3857"),
        (from_origin(500000, 5000000, 1000, 1000), "EPSG:6933"),
        (Affine(1000, 200, 500000, 100, -1000, 5000000), "EPSG:32632"),
    ],
)
def test_polygon_masks_weights_and_mixed_statistics_across_batch_sizes(
    tmp_path, transform, crs
):
    """Fractional edges, holes and overlapping AOIs retain membership and area.

    Args:
        tmp_path: Source and artifact location.
        transform: Native grid including a rotated fallback.
        crs: Source CRS.
    """
    from rasterio.warp import transform_geom

    values = np.arange(96 * 128, dtype="int16").reshape(96, 128) % 5
    values[40:42, 50:52] = -1
    path = write_source(
        tmp_path / "source.tif", values, nodata=-1, transform=transform, crs=crs
    )
    polygon = Polygon(
        [transform * p for p in [(2.2, 3.1), (119.8, 4.2), (125.2, 80.8), (4.3, 85.4)]],
        [[transform * p for p in [(30.2, 30.7), (54.1, 30.7), (45.4, 60.3)]]],
    )
    geo = transform_geom(crs, "EPSG:4326", mapping(polygon))
    area = write_aggregate_area(tmp_path / "selected.gpkg", [geo, geo])
    expressions = ["areaha(a>0)", "count(a>0)", "sum(a)", "areaha(a==0)"]
    results = []
    for target in [None, 1024, 65536, 262144]:
        spec = make_spec(path, expressions, area, target_chunk_pixels=target)
        if crs == "EPSG:32632":
            assert spec.grid.execution.evaluationWidth <= 64
            assert spec.grid.execution.evaluationHeight <= 64
        results.append(
            kernel.calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
        )
    for result in results[1:]:
        for left, right in zip(results[0].rows, result.rows, strict=True):
            assert left["aggregates"] == right["aggregates"]
            assert float(left["value"]) == pytest.approx(
                float(right["value"]), rel=1e-8
            )


@pytest.mark.parametrize("target_chunk_pixels", [None, 65536])
def test_metadata_planning_and_execution_without_grid_recheck(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    target_chunk_pixels: int | None,
) -> None:
    """Planning reads metadata only; execution uses the persisted batch sizes.

    Args:
        tmp_path: Source fixture and output.
        monkeypatch: Prevent band reads during planning and replanning during execution.
        target_chunk_pixels: Default one-block reads or a requested batch size.
    """
    path = write_source(tmp_path / "source.tif", np.ones((2048, 2048), dtype="uint8"))

    def forbidden(*args: Any) -> None:
        """Reject accidental pixel reads.

        Args:
            args: Unused native read arguments.
        """
        pytest.fail("metadata admission read pixel values")

    with monkeypatch.context() as patch:
        patch.setattr(kernel, "read_native_raster_window", forbidden)
        patch.setattr(kernel, "read_native_raster_block", forbidden)
        make_spec(path, ["sum(a)"], target_chunk_pixels=4194304)
        spec = make_spec(path, ["sum(a)"], target_chunk_pixels=target_chunk_pixels)
    prepared = prepare_aggregate_job(spec, LIMITS)
    assert prepared.specification == spec.model_dump(mode="json", by_alias=True)
    stored_plan = AggregateSpec.model_validate(prepared.specification)

    def unexpected_replanning(*args: Any, **kwargs: Any) -> None:
        """Fail if execution replans the saved grid or read windows.

        Args:
            *args: Unexpected planning arguments.
            **kwargs: Unexpected planning keyword arguments.
        """
        pytest.fail("execution replanned the saved grid or read windows")

    monkeypatch.setattr(kernel, "plan_statistics_grid", unexpected_replanning)
    monkeypatch.setattr(kernel, "plan_raster_read_windows", unexpected_replanning)
    result = kernel.calculate_raster_statistics_for_area(
        path, stored_plan, tmp_path, LIMITS
    )
    assert float(result.rows[0]["value"]) == 2048**2


def test_large_polygon_boundary_counts_do_not_depend_on_tile_width(
    tmp_path: Path,
) -> None:
    """Guard the benchmark regression where cumulative areas left tiny false matches.

    Args:
        tmp_path: Private fixture and result storage.
    """
    path = tmp_path / "source.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=2000,
        height=1000,
        count=1,
        dtype="uint16",
        crs="EPSG:4326",
        transform=from_origin(-82, 0, 0.01, 0.02),
        tiled=True,
        blockxsize=512,
        blockysize=512,
    ) as dataset:
        dataset.write(
            np.broadcast_to(np.arange(2000, dtype="uint16") % 50, (1000, 2000)).copy(),
            1,
        )
    polygon = Polygon(
        [(-81.98, -19.9), (-63.1, -19.8), (-62.5, -1.4), (-70, -2), (-81.98, 0)],
        [[(-75, -15), (-72, -15), (-74, -11)]],
    )
    area = write_aggregate_area(tmp_path / "selected.gpkg", [mapping(polygon)])
    baseline = None
    for target in [None, 65536, 262144]:
        spec = make_spec(
            path, ["areaha(a>10)", "count(a>10)"], area, target_chunk_pixels=target
        )
        result = kernel.calculate_raster_statistics_for_area(
            path, spec, tmp_path, LIMITS
        )
        if baseline is None:
            baseline = result.rows
        for expected, actual in zip(baseline, result.rows, strict=True):
            assert expected["aggregates"] == actual["aggregates"]
            assert float(expected["value"]) == pytest.approx(
                float(actual["value"]), rel=1e-10
            )
