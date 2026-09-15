"""Direct-source reading preserves established exact numeric grid semantics."""

from pathlib import Path
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any
import json
import math
from multiprocessing import get_context
import sys

from affine import Affine
import numpy as np
import pytest
import rasterio
from rasterio.features import geometry_mask
from rasterio.transform import from_origin
from rasterio.windows import Window, transform as window_transform
from shapely.geometry import Polygon, box, mapping

from eolab_app.bounded_vector import (
    ProjectedCatalogSelection,
    pixels_inside_area,
    polygon_features,
    selection_summary,
)
from eolab_app.bounded_vector import native_bbox_for_grid
from eolab_app.catalog_selection import SelectionUnavailableError
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.ground_area import PixelAreaCalculator
from eolab_app.raster.bounded_window import selected_raster_area_for_wgs84_polygons
from eolab_app.vector.filters import VectorFilter
from catalog_selection_support import write_selection
from test_raster_clips import write_source


@pytest.mark.skipif(sys.platform != "linux", reason="Linux address-space contract")
def test_selection_memory_limit_is_scoped_to_the_operation() -> None:
    """A vector read cannot lower a reused worker's later operation limits."""
    import resource
    from eolab_app.bounded_vector import _limit_memory

    original = resource.getrlimit(resource.RLIMIT_AS)
    try:
        for fail in (False, True):
            try:
                with _limit_memory():
                    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
                    assert 0 <= soft <= 2 * 1024**3
                    assert hard == original[1]
                    if fail:
                        raise RuntimeError("Simulated native failure")
            except RuntimeError:
                pass
            assert resource.getrlimit(resource.RLIMIT_AS) == original
        resource.setrlimit(resource.RLIMIT_AS, (1024**3, original[1]))
        with _limit_memory():
            assert resource.getrlimit(resource.RLIMIT_AS) == (1024**3, original[1])
        assert resource.getrlimit(resource.RLIMIT_AS) == (1024**3, original[1])
    finally:
        resource.setrlimit(resource.RLIMIT_AS, original)


@pytest.mark.filterwarnings("ignore::PendingDeprecationWarning")
def test_large_selection_reaches_all_numeric_consumers(
    tmp_path: Path,
) -> None:
    """Compare 850 polygons in isolation from subsequent process-memory tests.

    The complete historical geometry oracle intentionally allocates what the
    streaming implementation avoids. Native allocators can retain that memory,
    affecting Linux child high-water RSS and legitimate worker recycling later.

    Args:
        tmp_path: Isolated mounted vectors, rasters, and operation outputs.
    """
    process = get_context("spawn").Process(
        target=_check_large_selection_numeric_consumers, args=(tmp_path,)
    )
    process.start()
    try:
        process.join(180)
        assert not process.is_alive(), "Large-selection comparison exceeded 180 seconds"
        assert process.exitcode == 0, "Large-selection comparison failed in its child"
    finally:
        if process.is_alive():
            process.kill()
            process.join()
        process.close()


def _check_large_selection_numeric_consumers(tmp_path: Path) -> None:
    """Exercise every numeric consumer against complete historical geometry.

    Args:
        tmp_path: Isolated mounted vectors, rasters, and operation outputs.

    Raises:
        AssertionError: If exact masks, values, or persistence contracts differ.
    """
    import warnings

    warnings.filterwarnings("ignore", category=PendingDeprecationWarning)
    from eolab_app.processing.clip_models import ClipArea, ClipSpec, RasterClipLimits
    from eolab_app.processing.raster_clip import plan_clip, create_clip
    from eolab_app.processing.raster_aggregate import (
        calculate_raster_statistics_for_area,
    )
    from eolab_app.raster.models import CatalogRasterRequest
    from eolab_app.raster.source_identity import RasterSourceIdentity
    from eolab_app.raster.statistics import read_raster_statistics
    from eolab_app.raster.paired_statistics import read_raster_paired_statistics
    from eolab_app.sampling_area import CatalogSelectionSamplingArea
    from test_raster_aggregates import make_spec
    from test_raster_clips import SOURCE

    geometries = []
    for index in range(850):
        x, y = index % 34 + 0.5, index // 34 + 0.5
        ring = [
            (x + 0.42 * math.cos(angle), y + 0.42 * math.sin(angle))
            for angle in np.linspace(0, 2 * math.pi, 256, endpoint=False)
        ]
        geometries.append(mapping(Polygon(ring)))
    resolved = write_selection(tmp_path / "large.gpkg", geometries)
    summary = selection_summary(resolved)
    assert summary["matched"] == summary["total"] == 850
    assert summary["exactGeometryBytes"] > 7 * 1024**2
    print(f"large selection: {summary}")
    assert len(resolved.selection.model_dump_json()) < 1024
    values = np.arange(68 * 50, dtype="int16").reshape(50, 68)
    path = write_source(
        tmp_path / "source.tif", values, transform=from_origin(0, 25, 0.5, 0.5)
    )
    with rasterio.open(path) as dataset:
        original = selected_raster_area_for_wgs84_polygons(
            dataset, tuple(geometries), 500000
        )
        masks = {
            touched: geometry_mask(
                original.projected_geometries,
                out_shape=values.shape,
                transform=dataset.transform,
                all_touched=touched,
                invert=True,
            )
            for touched in (False, True)
        }
    area = CatalogSelectionSamplingArea(resolved)
    single = read_raster_statistics(path, area)
    expected = values[masks[True]]
    assert single.valid_sample_count == expected.size
    assert single.sample_minimum == expected.min()
    assert single.sample_maximum == expected.max()
    counts, _ = np.histogram(expected, bins=64, range=(expected.min(), expected.max()))
    assert single.histogram.counts == counts.tolist()
    paired = read_raster_paired_statistics(path, path, None, catalog_selection=area)
    import eolab_app.raster.paired_statistics as paired_reader

    def historical_mask(dataset: rasterio.io.DatasetReader, *unused: object) -> object:
        """Return the old complete-geometry mask on the same paired reference grid.

        Args:
            dataset: The existing paired reader's open reference source.
            unused: Descriptor and cancellation arguments unused by the oracle.

        Returns:
            The complete precise projected polygon selection.
        """
        return selected_raster_area_for_wgs84_polygons(
            dataset, tuple(geometries), 500000
        )

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(
            paired_reader, "selected_raster_area_for_catalog_selection", historical_mask
        )
        baseline_paired = read_raster_paired_statistics(
            path, path, None, catalog_selection=area
        )
    assert paired == baseline_paired

    native_area = AggregateArea(
        kind="catalogSelection",
        bounds=summary["bbox"],
        catalogSelection=resolved.selection,
        resolved=resolved,
    )
    spec = make_spec(path, ["count(a)", "sum(a)"], native_area)
    assert "geometries" not in json.loads(spec.model_dump_json())["area"]
    spec = spec.model_copy(
        update={"area": spec.area.model_copy(update={"resolved": resolved})}
    )
    output = tmp_path / "summary"
    output.mkdir()
    artifact = calculate_raster_statistics_for_area(
        path, spec, output, RasterAggregateLimits()
    )
    assert float(artifact.rows[0]["value"]) == np.count_nonzero(masks[False])
    assert float(artifact.rows[1]["value"]) == values[masks[False]].sum()

    clip_area = ClipArea(
        kind="catalogSelection",
        bounds=summary["bbox"],
        catalogSelection=resolved.selection,
        resolved=resolved,
    )
    signature = tuple(RasterSourceIdentity.read(path).to_catalog())
    limits = RasterClipLimits()
    clip_spec = ClipSpec(
        source=CatalogRasterRequest(**SOURCE),
        sourceSignature=signature,
        area=clip_area,
        grid=plan_clip(path, clip_area, limits),
    )
    output = tmp_path / "clip"
    output.mkdir()
    create_clip(path, clip_spec, output, limits)
    with rasterio.open(output / "result.tif") as result:
        assert np.array_equal(result.read_masks(1) > 0, masks[True])
        assert np.array_equal(result.read(1)[masks[True]], values[masks[True]])

    historical = AggregateArea(
        kind="aoi", bounds=summary["bbox"], geometries=tuple(geometries)
    )
    with rasterio.open(path) as dataset:
        baseline = PixelAreaCalculator(dataset, historical, RasterAggregateLimits())
        direct = PixelAreaCalculator(dataset, native_area, RasterAggregateLimits())
        assert direct.window == baseline.window
        np.testing.assert_allclose(
            direct.calculate_hectares(direct.window),
            baseline.calculate_hectares(baseline.window),
            rtol=1e-11,
            atol=1e-7,
        )
        print(f"large fractional area: {direct.budget.used} transformed positions")


@pytest.mark.parametrize("crs", ["EPSG:4326", "EPSG:3857", "EPSG:6933"])
def test_dateline_candidates_fall_back_without_losing_polygons(
    tmp_path: Path, crs: str
) -> None:
    """Canonical-edge windows never prune features after wrapped corner transforms.

    Args:
        tmp_path: Isolated native vector file.
        crs: A supported separable raster projection.
    """
    from rasterio.warp import transform

    resolved = write_selection(
        tmp_path / "dateline.gpkg",
        [mapping(box(179, -1, 180, 1)), mapping(box(-180, -1, -179, 1))],
    )
    xs, ys = transform("EPSG:4326", crs, [179, 180], [1, 0])
    affine = from_origin(xs[0], ys[0], xs[1] - xs[0], abs(ys[0] - ys[1]))
    assert native_bbox_for_grid(resolved, crs, affine, (2, 2)) is None


def test_cancelled_selection_stops_the_original_source_stream(tmp_path: Path) -> None:
    """A disconnected analysis cannot continue scanning selected source features.

    Args:
        tmp_path: Isolated native vector source.
    """
    from eolab_app.raster.read_cancellation import RasterReadCancelled

    resolved = write_selection(tmp_path / "cancel.gpkg", [mapping(box(0, 0, 1, 1))])
    with pytest.raises(RasterReadCancelled):
        selection_summary(resolved, lambda: True)


@pytest.mark.parametrize(
    "crs,affine",
    [
        ("EPSG:4326", from_origin(0, 8, 0.25, 0.25)),
        ("EPSG:3857", from_origin(0, 900000, 28000, 28000)),
        ("EPSG:6933", from_origin(0, 1000000, 24000, 31000)),
        ("EPSG:4326", Affine(0.25, 0.02, 0, 0.02, -0.25, 8)),
    ],
)
@pytest.mark.parametrize("all_touched", [False, True])
def test_streamed_masks_match_complete_exact_geometry(
    tmp_path: Path,
    crs: str,
    affine: Affine,
    all_touched: bool,
) -> None:
    """Verify inclusion and exclusion masks for both polygon source types.

    Args:
        tmp_path: Directory for the vector and raster fixtures.
        crs: Raster coordinate reference system.
        affine: Raster pixel-to-map transform.
        all_touched: Whether any polygon contact includes a pixel.
    """
    geometries = [
        mapping(
            Polygon(
                [(0.5, 1), (6, 1), (6, 7), (0.5, 7), (0.5, 1)],
                [[(2, 2), (2, 5), (4, 5), (4, 2), (2, 2)]],
            )
        ),
        mapping(box(3, 3, 7, 6)),
        mapping(box(-4, 2, -2, 4)),
    ]
    resolved = write_selection(tmp_path / "selection.gpkg", geometries)
    path = write_source(
        tmp_path / "raster.tif",
        np.ones((32, 32), dtype="int16"),
        transform=affine,
        crs=crs,
    )
    with rasterio.open(path) as dataset:
        original = selected_raster_area_for_wgs84_polygons(
            dataset, tuple(geometries), 500000
        )
        direct = ProjectedCatalogSelection(dataset, resolved, 500000)
        assert direct.source_window == original.source_window
        for tile in [Window(0, 0, 32, 32), Window(8, 8, 8, 8), Window(24, 24, 8, 8)]:
            shape = (int(tile.height), int(tile.width))
            transform = window_transform(tile, dataset.transform)
            expected = geometry_mask(
                original.projected_geometries,
                out_shape=shape,
                transform=transform,
                all_touched=all_touched,
                invert=True,
            )
            for mask_source in (direct, original.projected_geometries):
                inside = pixels_inside_area(
                    mask_source,
                    out_shape=shape,
                    transform=transform,
                    all_touched=all_touched,
                )
                np.testing.assert_array_equal(inside, expected)
                outside = geometry_mask(
                    original.projected_geometries,
                    out_shape=shape,
                    transform=transform,
                    all_touched=all_touched,
                )
                np.testing.assert_array_equal(~inside, outside)


@pytest.mark.parametrize(
    "crs,affine",
    [
        ("EPSG:4326", from_origin(0, 8, 0.5, 0.5)),
        ("EPSG:3857", from_origin(0, 900000, 56000, 56000)),
        ("EPSG:6933", from_origin(0, 1000000, 48000, 62000)),
        ("EPSG:4326", Affine(0.5, 0.02, 0, 0.02, -0.5, 8)),
    ],
)
def test_fractional_union_matches_historical_exact_area(
    tmp_path: Path,
    crs: str,
    affine: Affine,
) -> None:
    """Native cells retain fractional union, hole and overlap behavior per tile."""
    geometries = [
        mapping(
            Polygon(
                [(1, 1), (6, 1), (6, 7), (1, 7), (1, 1)],
                [[(2, 2), (2, 5), (4, 5), (4, 2), (2, 2)]],
            )
        ),
        mapping(box(3, 3, 7, 6)),
    ]
    resolved = write_selection(tmp_path / "selection.gpkg", geometries)
    bounds = selection_summary(resolved)["bbox"]
    path = write_source(
        tmp_path / "raster.tif",
        np.ones((16, 16), dtype="int16"),
        transform=affine,
        crs=crs,
    )
    old = AggregateArea(kind="aoi", bounds=bounds, geometries=tuple(geometries))
    new = AggregateArea(
        kind="catalogSelection",
        bounds=bounds,
        catalogSelection=resolved.selection,
        resolved=resolved,
    )
    with rasterio.open(path) as dataset:
        baseline = PixelAreaCalculator(dataset, old, RasterAggregateLimits())
        direct = PixelAreaCalculator(dataset, new, RasterAggregateLimits())
        assert direct.window == baseline.window
        for y in range(
            int(direct.window.row_off),
            int(direct.window.row_off + direct.window.height),
            4,
        ):
            for x in range(
                int(direct.window.col_off),
                int(direct.window.col_off + direct.window.width),
                4,
            ):
                tile = Window(
                    x,
                    y,
                    min(4, direct.window.col_off + direct.window.width - x),
                    min(4, direct.window.row_off + direct.window.height - y),
                )
                np.testing.assert_allclose(
                    direct.calculate_hectares(tile),
                    baseline.calculate_hectares(tile),
                    rtol=1e-12,
                    atol=1e-7,
                )


def test_predicate_source_signature_and_spatial_candidates(tmp_path: Path) -> None:
    """Native pruning keeps exact selected values and rejects changed source files."""
    candidate = VectorFilter(
        rules=[{"field": "selected", "operator": "eq", "value": 6060007000}]
    )
    resolved = write_selection(
        tmp_path / "selection.gpkg",
        [mapping(box(i, 0, i + 0.5, 0.5)) for i in range(4)],
        values=[6060007000, 2, 6060007000, 2],
        candidate=candidate,
    )
    assert selection_summary(resolved)["matched"] == 2
    with polygon_features(resolved, (1.9, -1, 2.9, 1)) as features:
        assert len(list(features)) == 1
    with resolved.path.open("ab") as source:
        source.write(b"changed")
    with pytest.raises(SelectionUnavailableError, match="changed"):
        selection_summary(resolved)


@pytest.mark.parametrize("streamed", [False, True])
def test_mask_stage_timings_partition_real_geometry_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, streamed: bool
) -> None:
    """Attribute controlled delays while preserving actual polygon masks.

    Args:
        tmp_path: Directory for real raster/vector fixtures.
        monkeypatch: Replaces the clock and wraps real source operations.
        streamed: Read original features instead of using projected polygons.
    """
    import eolab_app.bounded_vector as reader
    from eolab_app.raster.models import RasterMaskTimings

    polygons = [mapping(box(1, 1, 4, 4)), mapping(box(3, 3, 6, 6))]
    resolved = write_selection(tmp_path / "selection.gpkg", polygons)
    path = write_source(
        tmp_path / "raster.tif",
        np.ones((8, 8), dtype="int16"),
        transform=from_origin(0, 8, 1, 1),
    )
    clock = [0.0]
    calls = {"bbox": 0, "read": 0, "open": 0, "close": 0, "project": 0, "rasterize": 0}

    def delayed(
        function: Callable[..., Any], key: str, duration: float
    ) -> Callable[..., Any]:
        """Wrap an operation without changing its result.

        Args:
            function: Real operation to invoke.
            key: Counter for this operation.
            duration: Extra time charged to the operation.

        Returns:
            Callable that performs the operation and advances the clock.
        """

        def invoke(*args: Any, **kwargs: Any) -> Any:
            """Invoke the wrapped operation.

            Args:
                *args: Original positional arguments.
                **kwargs: Original keyword arguments.

            Returns:
                Unchanged operation result.
            """
            result = function(*args, **kwargs)
            calls[key] += 1
            clock[0] += duration
            return result

        return invoke

    original_features = reader.polygon_features

    @contextmanager
    def timed_features(*args: Any, **kwargs: Any) -> Iterator[Iterator[dict[str, Any]]]:
        """Charge source lifetime and iteration separately from feature processing.

        Args:
            *args: Original polygon reader arguments.
            **kwargs: Original polygon reader keyword arguments.

        Yields:
            Real polygon features with deterministic reading delays.
        """

        def iterate(features: Iterator[dict[str, Any]]) -> Iterator[dict[str, Any]]:
            """Yield source features, charging reads including exhaustion.

            Args:
                features: Source feature iterator.

            Yields:
                Unchanged source geometries.
            """
            while True:
                clock[0] += 3
                calls["read"] += 1
                try:
                    geometry = next(features)
                except StopIteration:
                    return
                yield geometry

        with original_features(*args, **kwargs) as features:
            clock[0] += 2
            calls["open"] += 1
            yield iterate(iter(features))
        clock[0] += 5
        calls["close"] += 1

    with rasterio.open(path) as dataset:
        source = (
            ProjectedCatalogSelection(dataset, resolved, 500000)
            if streamed
            else tuple(polygons)
        )
        expected = pixels_inside_area(
            source, out_shape=(8, 8), transform=dataset.transform, all_touched=False
        )
        monkeypatch.setattr(reader.time, "perf_counter", lambda: clock[0])
        monkeypatch.setattr(
            reader,
            "native_bbox_for_grid",
            delayed(reader.native_bbox_for_grid, "bbox", 7),
        )
        monkeypatch.setattr(reader, "polygon_features", timed_features)
        monkeypatch.setattr(
            ProjectedCatalogSelection,
            "project",
            delayed(ProjectedCatalogSelection.project, "project", 11),
        )
        monkeypatch.setattr(
            reader, "geometry_mask", delayed(reader.geometry_mask, "rasterize", 13)
        )
        timings = RasterMaskTimings()
        for _ in range(2):
            actual = pixels_inside_area(
                source,
                out_shape=(8, 8),
                transform=dataset.transform,
                all_touched=False,
                timings=timings,
            )
            np.testing.assert_array_equal(actual, expected)
        assert timings.feature_reading_seconds == (
            calls["bbox"] * 7
            + calls["open"] * 2
            + calls["read"] * 3
            + calls["close"] * 5
        )
        assert timings.projection_seconds == calls["project"] * 11
        assert timings.rasterization_seconds == calls["rasterize"] * 13 > 0
        assert clock[0] == (
            timings.feature_reading_seconds
            + timings.projection_seconds
            + timings.rasterization_seconds
        )
        assert bool(timings.feature_reading_seconds) == streamed
        assert bool(timings.projection_seconds) == streamed
