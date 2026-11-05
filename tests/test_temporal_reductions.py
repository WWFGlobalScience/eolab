"""Verify period-map calculations using native GeoTIFF inputs and completed COGs."""

from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
import hashlib
from itertools import count
import json
from pathlib import Path
from types import SimpleNamespace, TracebackType
from typing import Literal

import numpy as np
from numpy.typing import NDArray
import pytest
import rasterio
from affine import Affine
from pydantic import ValidationError
from rasterio.crs import CRS
from rasterio.windows import Window

from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.polygon_areas import PolygonSummaryInput
from eolab_app.processing.temporal_models import (
    PrecipitationConversion,
    TemporalMapArtifact,
    TemporalMapRequest,
    TemporalMapSpec,
    TemporalReduction,
)
from eolab_app.processing.temporal_operation import describe_temporal_policy
from eolab_app.processing.temporal_reduce import create_temporal_map
import eolab_app.processing.temporal_reduce as temporal_reduce
from eolab_app.processing.temporal_grid import plan_temporal_grid
from eolab_app.raster.source_models import TemporalIntervalSelection
from eolab_app.raster.temporal import (
    ResolvedTemporalInterval,
    TemporalObservation,
    TemporalRasterDataset,
)
from eolab_app.vector.filters import VectorFilter
from catalog_selection_support import write_selection


def _write_observation(
    path: Path,
    values: NDArray[np.float32] | NDArray[np.float64],
    transform: Affine,
    nodata: float | None,
) -> Path:
    """Write one native observation used by the period-calculation tests.

    Args:
        path: New GeoTIFF location inside the isolated archive.
        values: Native float32 or float64 values in published column order.
        transform: Affine mapping native pixel edges to EPSG:4326.
        nodata: Declared invalid value, or None when no explicit value is declared.

    Returns:
        The written observation path.

    Raises:
        OSError: If the fixture directory or raster cannot be written.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=values.shape[0],
        width=values.shape[1],
        count=1,
        dtype=values.dtype.name,
        crs="EPSG:4326",
        transform=transform,
        nodata=nodata,
        tiled=True,
        blockxsize=16,
        blockysize=16,
        compress="deflate",
    ) as raster:
        raster.write(values, 1)
    return path


@pytest.fixture
def interval(tmp_path: Path) -> ResolvedTemporalInterval:
    """Create gapped observations containing NaN, declared NoData and finite values.

    Args:
        tmp_path: Isolated source and output root.

    Returns:
        Three instantaneous observations on a regional native grid.
    """
    values = np.array(
        [
            [[1, 2, np.nan, np.inf], [np.nan, -9999, 3, 5]],
            [[3, np.nan, np.nan, 4], [np.nan, 2, 7, -9999]],
            [[5, 6, -9999, 8], [np.nan, 4, 11, 9]],
        ],
        dtype="float32",
    )
    start = datetime(2000, 1, 1, tzinfo=timezone.utc)
    observations = tuple(
        TemporalObservation(
            path=_write_observation(
                tmp_path / "archive" / f"weather-{hour}.tif",
                values[index],
                Affine(1, 0, 10, 0, -1, 12),
                -9999,
            ),
            time=start + timedelta(hours=hour),
            reference_time=None,
            interval_start=start + timedelta(hours=hour),
            interval_end=start + timedelta(hours=hour),
            transform=Affine(1, 0, 10, 0, -1, 12),
            crs=CRS.from_epsg(4326),
            nodata=-9999,
        )
        for index, hour in enumerate((0, 1, 5))
    )
    return ResolvedTemporalInterval(
        observations=observations, unit="K", time_support="instantaneous"
    )


def _calculate(
    interval: ResolvedTemporalInterval,
    reduction: TemporalReduction,
    area: AggregateArea,
    directory: Path,
    conversion: PrecipitationConversion | None = None,
) -> tuple[TemporalMapSpec, TemporalMapArtifact]:
    """Plan and execute a real period-map operation in one private attempt.

    Args:
        interval: Real GeoTIFF observations and variable metadata.
        reduction: Requested statistic.
        area: Validated spatial area.
        directory: New attempt output directory.
        conversion: Model units and factor for an integrated precipitation total.

    Returns:
        Native plan and completed artifact metadata.

    Raises:
        OSError: If source or output files cannot be read or written.
        ProcessingError: If planning, numerical calculation or output validation fails.
        ValueError: If native source decoding fails.
    """
    directory.mkdir()
    limits = RasterAggregateLimits()
    grid = plan_temporal_grid(interval.observations[0], area, limits)
    spec = TemporalMapSpec(
        source=TemporalIntervalSelection(
            collectionId="eolab-temporal-datasets",
            itemId="weather",
            variable="temperature",
            startTime=interval.observations[0].interval_start,
            endTime=(
                interval.observations[-1].interval_end
                if reduction.reducer == "precipitation_total"
                else interval.observations[-1].time + timedelta(hours=1)
            ),
        ),
        reduction=reduction,
        area=area,
        grid=grid,
        unit=conversion.outputUnit if conversion else interval.unit,
        timeSupport=interval.time_support,
        conversionFactor=conversion.factor if conversion else 1.0,
        observationCount=len(interval.observations),
        firstObservation=interval.observations[0].time,
        lastObservation=interval.observations[-1].time,
    )
    return spec, create_temporal_map(interval, spec, directory, limits)


@pytest.fixture
def tiled_interval(
    interval: ResolvedTemporalInterval, tmp_path: Path
) -> tuple[ResolvedTemporalInterval, NDArray[np.float32]]:
    """Repeat real observations across four native tiles, retaining invalid cells.

    Args:
        interval: Three admitted observations with mixed validity.
        tmp_path: Isolated archive root.

    Returns:
        A 32-by-32 interval and its stored values, including one cell whose
        floating-point sum distinguishes chronological addition from reordering.
    """
    native_values = []
    for observation in interval.observations:
        with rasterio.open(observation.path) as source:
            native_values.append(source.read(1))
    values = np.tile(np.stack(native_values), (1, 16, 8))
    values[:, 0, 0] = [2**60, -(2**60), 1]
    transform = Affine(0.1, 0, 10, 0, -0.1, 12)
    observations = tuple(
        replace(
            observation,
            path=_write_observation(
                tmp_path / "tiled-archive" / f"weather-{index}.tif",
                values[index],
                transform,
                -9999,
            ),
            transform=transform,
        )
        for index, observation in enumerate(interval.observations)
    )
    return replace(interval, observations=observations), values


@dataclass(frozen=True)
class TemporalProgressSnapshot:
    """Record reported work alongside completed native reads and output files.

    Attributes:
        phase: Operation-owned stage being reported.
        completed: Reported completed work for that stage.
        total: Reported total work for that stage.
        unit: Work unit carried by the existing progress contract.
        reads: Native observation-window reads completed when reported.
        result_exists: Whether the primary COG exists at this update.
        count_exists: Whether the count COG exists at this update.
    """

    phase: str
    completed: int
    total: int
    unit: str
    reads: int
    result_exists: bool
    count_exists: bool


@dataclass
class TemporalExecutionTrace:
    """Retain real observation-handle lifetimes, native reads and progress.

    Attributes:
        opened: Observation paths in native-handle creation order.
        active: Observation handles not yet closed; output writers are separate.
        maximum_active: Most observation handles open simultaneously.
        reads: Source paths and native windows read in execution order.
        progress: Reported work and the corresponding actual execution state.
    """

    opened: list[Path] = field(default_factory=list)
    active: set[TemporalRasterDataset] = field(default_factory=set)
    maximum_active: int = 0
    reads: list[tuple[Path, tuple[int, int, int, int]]] = field(default_factory=list)
    progress: list[TemporalProgressSnapshot] = field(default_factory=list)


def _trace_temporal_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> TemporalExecutionTrace:
    """Observe the real period-map entrypoint without replacing source reads.

    Args:
        monkeypatch: Isolated wrappers around this operation's existing providers.

    Returns:
        Mutable trace populated by native reads, handle closure and real progress
        writes. A local clock advances each call so throttled updates need no sleep.
    """
    trace = TemporalExecutionTrace()
    read_window = temporal_reduce.read_native_raster_window
    write_progress = temporal_reduce.write_progress
    ticks = count(1)

    class TrackedTemporalRasterDataset(TemporalRasterDataset):
        """Count only observation handles while retaining the real native reader."""

        def __init__(self, observation: TemporalObservation) -> None:
            """Open the admitted source and record its active native handle.

            Args:
                observation: Unchanged admitted GeoTIFF observation.

            Raises:
                rasterio.errors.RasterioError: If the native source cannot open.
            """
            super().__init__(observation)
            trace.opened.append(observation.path)
            trace.active.add(self)
            trace.maximum_active = max(trace.maximum_active, len(trace.active))

        def __exit__(
            self,
            exc_type: type[BaseException] | None,
            exc_value: BaseException | None,
            traceback: TracebackType | None,
        ) -> None:
            """Close the native source and record that its handle was released.

            Args:
                exc_type: Exception type passed by the real context manager.
                exc_value: Active exception, if any.
                traceback: Active exception traceback, if any.
            """
            try:
                super().__exit__(exc_type, exc_value, traceback)
            finally:
                trace.active.remove(self)

    def record_read(
        dataset: TemporalRasterDataset, window: Window
    ) -> np.ma.MaskedArray:
        """Read native values and record the successfully completed source window.

        Args:
            dataset: Open observation using the existing native validity contract.
            window: Native window selected by the operation.

        Returns:
            The real reader's finite, non-NoData masked values.

        Raises:
            rasterio.errors.RasterioError: If the native values cannot be read.
        """
        values = read_window(dataset, window)
        trace.reads.append(
            (
                Path(dataset.name),
                (
                    int(window.col_off),
                    int(window.row_off),
                    int(window.width),
                    int(window.height),
                ),
            )
        )
        return values

    def record_progress(
        directory: Path, phase: str, complete: int, total: int, *, unit: str = "blocks"
    ) -> None:
        """Publish the real progress record and capture its corresponding work.

        Args:
            directory: Attempt-owned output directory.
            phase: Operation-owned stage.
            complete: Completed work for this stage.
            total: Total work for this stage.
            unit: Work unit passed to the existing progress writer.

        Raises:
            OSError: If the actual progress file cannot be written.
        """
        write_progress(directory, phase, complete, total, unit=unit)
        trace.progress.append(
            TemporalProgressSnapshot(
                phase,
                complete,
                total,
                unit,
                len(trace.reads),
                (directory / "result.tif").exists(),
                (directory / "count.tif").exists(),
            )
        )

    def advance_progress_clock() -> float:
        """Return advancing operation-local seconds so each read can report work.

        Returns:
            One more second than the previous call, without changing library clocks.
        """
        return float(next(ticks))

    monkeypatch.setattr(
        temporal_reduce, "TemporalRasterDataset", TrackedTemporalRasterDataset
    )
    monkeypatch.setattr(temporal_reduce, "read_native_raster_window", record_read)
    monkeypatch.setattr(temporal_reduce, "write_progress", record_progress)
    monkeypatch.setattr(
        temporal_reduce, "time", SimpleNamespace(monotonic=advance_progress_clock)
    )
    return trace


def _expected_tiled_reduction(
    values: NDArray[np.float32] | NDArray[np.float64],
    reducer: str,
    durations: tuple[float, ...],
    nodata: float = -9999,
    factor: float = 1.0,
) -> tuple[NDArray[np.float64], NDArray[np.uint64]]:
    """Calculate independent scalar references from the actual stored observations.

    Args:
        values: Chronological native values, including NaN and declared NoData.
        reducer: Statistic requested by the test.
        durations: Seconds represented by each observation for precipitation totals.
        nodata: Declared missing value to exclude alongside nonfinite values.
        factor: Precipitation conversion applied after multiplying by duration.

    Returns:
        Statistic and valid-observation counts for every native cell. Sum and
        precipitation use chronological scalar float64 addition; other references
        use NumPy's independent scalar statistical functions.
    """
    valid = np.isfinite(values) & (values != nodata)
    counts = valid.sum(axis=0, dtype="uint64")
    expected = np.full(values.shape[1:], np.nan, dtype="float64")
    for row, column in np.ndindex(expected.shape):
        selected = valid[:, row, column]
        current = values[:, row, column].astype("float64")[selected]
        if not current.size:
            continue
        if reducer in {"sum", "precipitation_total"}:
            if reducer == "precipitation_total":
                current = current * np.asarray(durations)[selected] * factor
            total = 0.0
            for value in current:
                total += float(value)
            expected[row, column] = total
        elif reducer == "percentile":
            expected[row, column] = np.percentile(current, 25, method="linear")
        elif reducer == "stdev":
            expected[row, column] = np.std(current, ddof=0)
        else:
            expected[row, column] = getattr(np, reducer)(current)
    return expected, counts


@pytest.mark.parametrize(
    "reducer",
    [
        "sum",
        "mean",
        "min",
        "max",
        "stdev",
        "precipitation_total",
        "median",
        "percentile",
    ],
)
def test_tiled_period_maps_reuse_observation_handles_and_report_actual_work(
    tiled_interval: tuple[ResolvedTemporalInterval, NDArray[np.float32]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    reducer: str,
) -> None:
    """Preserve real multi-tile results while reusing handles and reporting reads.

    Args:
        tiled_interval: Three observations spanning four native source tiles.
        tmp_path: Isolated attempt output root.
        monkeypatch: Operation-local tracing and a small scratch-batch target.
        reducer: Every streaming statistic and both exact order statistics.
    """
    interval, values = tiled_interval
    conversion = None
    durations = (3600.0, 7200.0, 3600.0)
    if reducer == "precipitation_total":
        origin = interval.observations[0].time
        interval = replace(
            interval,
            unit="kg m**-2 s**-1",
            time_support="mean_rate",
            observations=tuple(
                replace(
                    observation,
                    time=origin + timedelta(hours=end),
                    interval_start=origin + timedelta(hours=start),
                    interval_end=origin + timedelta(hours=end),
                )
                for observation, (start, end) in zip(
                    interval.observations, ((0, 1), (1, 3), (5, 6))
                )
            ),
        )
        conversion = PrecipitationConversion(
            inputUnit=interval.unit, outputUnit="mm", factor=1
        )
    trace = _trace_temporal_execution(monkeypatch)
    monkeypatch.setattr(temporal_reduce, "STREAMING_BATCH_PIXELS", 512)
    directory = tmp_path / "tiled-output"
    spec, _ = _calculate(
        interval,
        TemporalReduction(
            reducer=reducer, percentile=25 if reducer == "percentile" else None
        ),
        AggregateArea(kind="wholeRaster"),
        directory,
        conversion,
    )
    expected, counts = _expected_tiled_reduction(values, reducer, durations)
    with (
        rasterio.open(directory / "result.tif") as result,
        rasterio.open(directory / "count.tif") as count_raster,
    ):
        np.testing.assert_allclose(result.read(1), expected, equal_nan=True)
        np.testing.assert_array_equal(result.read_masks(1) != 0, counts > 0)
        np.testing.assert_array_equal(count_raster.read(1), counts)
        assert (count_raster.read_masks(1) == 255).all()
        if reducer == "sum":
            assert result.read(1)[0, 0] == 1.0
    assert spec.grid.tileCount == 4
    batches = 4 if reducer in {"median", "percentile"} else 2
    paths = [observation.path for observation in interval.observations]
    assert trace.opened == [paths[0], *(path for _ in range(batches) for path in paths)]
    assert trace.maximum_active <= 2
    assert not trace.active
    windows = {window for _, window in trace.reads}
    assert len(windows) == spec.grid.tileCount
    for window in windows:
        assert [
            path for path, read_window in trace.reads if read_window == window
        ] == paths
    reads = len(interval.observations) * spec.grid.tileCount
    assert len(trace.reads) == reads
    reducing = [update for update in trace.progress if update.phase == "reducing"]
    assert reducing[0].completed == reducing[0].reads == 0
    assert reducing[-1].completed == reducing[-1].reads == reads
    assert all(
        update.total == reads and update.unit == "raster reads" for update in reducing
    )
    assert [update.completed for update in reducing] == sorted(
        update.completed for update in reducing
    )
    assert all(update.completed == update.reads for update in reducing)
    first_read_update = next(update for update in reducing if update.completed)
    assert first_read_update.reads < len(interval.observations)
    ordering = [update for update in trace.progress if update.phase == "ordering"]
    if reducer in {"median", "percentile"}:
        assert ordering[0].completed == 0
        assert ordering[-1].completed == spec.grid.width * spec.grid.height
        assert all(
            update.total == spec.grid.width * spec.grid.height
            and update.unit == "pixels"
            for update in ordering
        )
        assert [update.completed for update in ordering] == sorted(
            update.completed for update in ordering
        )
        assert ordering[0].reads == len(interval.observations)
    else:
        assert not ordering
    preparing = [update for update in trace.progress if update.phase == "creating_cog"]
    assert [(update.completed, update.total, update.unit) for update in preparing] == [
        (0, 2, "files"),
        (1, 2, "files"),
        (2, 2, "files"),
    ]
    assert [(update.result_exists, update.count_exists) for update in preparing] == [
        (False, False),
        (True, False),
        (True, True),
    ]
    assert not (directory / "ordered-values.bin").exists()


def test_native_tile_larger_than_streaming_batch_target_is_still_processed(
    tiled_interval: tuple[ResolvedTemporalInterval, NDArray[np.float32]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Treat the scratch-batch target as a grouping choice, not an input ceiling.

    Args:
        tiled_interval: Four native 256-cell tiles with real observations.
        tmp_path: Isolated attempt output root.
        monkeypatch: Scratch target smaller than one native source tile.
    """
    interval, values = tiled_interval
    trace = _trace_temporal_execution(monkeypatch)
    monkeypatch.setattr(temporal_reduce, "STREAMING_BATCH_PIXELS", 128)
    directory = tmp_path / "larger-native-tile"
    spec, _ = _calculate(
        interval,
        TemporalReduction(reducer="sum"),
        AggregateArea(kind="wholeRaster"),
        directory,
    )
    expected, counts = _expected_tiled_reduction(values, "sum", ())
    with rasterio.open(directory / "result.tif") as result:
        np.testing.assert_allclose(result.read(1), expected, equal_nan=True)
        np.testing.assert_array_equal(result.read_masks(1) != 0, counts > 0)
    assert spec.grid.tileCount == 4
    assert len(trace.opened) == 1 + len(interval.observations) * spec.grid.tileCount
    assert trace.maximum_active <= 2
    assert not trace.active


@pytest.mark.parametrize(
    "reducer", ["sum", "mean", "min", "max", "median", "percentile", "stdev"]
)
@pytest.mark.parametrize(
    "support,unit",
    [("instantaneous", "K"), ("mean_rate", "mm/hour"), ("accumulation", "J/m2")],
)
def test_reducers_match_native_values_and_preserve_count_nodata(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
    reducer: str,
    support: Literal["instantaneous", "mean_rate", "accumulation"],
    unit: str,
) -> None:
    """Match independent scalar references and publish ordinary native-grid COGs.

    Args:
        interval: Gapped observations with mixed validity.
        tmp_path: Isolated attempt root.
        reducer: Each supported equal-weight statistic.
        support: Admitted meaning of each observation's values.
        unit: Source units retained by ordinary statistics.
    """
    interval = replace(interval, time_support=support, unit=unit)
    reduction = TemporalReduction(
        reducer=reducer, percentile=25 if reducer == "percentile" else None
    )
    directory = tmp_path / reducer
    source_files = {
        path: path.read_bytes()
        for path in (tmp_path / "archive").rglob("*")
        if path.is_file()
    }
    spec, artifact = _calculate(
        interval, reduction, AggregateArea(kind="wholeRaster"), directory
    )
    series = [[1, 3, 5], [2, 6], [], [4, 8], [], [2, 4], [3, 7, 11], [5, 9]]
    expected = []
    for values in series:
        if not values:
            expected.append(np.nan)
        elif reducer == "percentile":
            expected.append(np.percentile(values, 25, method="linear"))
        elif reducer == "stdev":
            expected.append(np.std(values, ddof=0))
        else:
            expected.append(getattr(np, reducer)(values))
    with rasterio.open(directory / "result.tif") as result:
        np.testing.assert_allclose(
            result.read(1), np.array(expected).reshape(2, 4), equal_nan=True
        )
        np.testing.assert_array_equal(
            result.read_masks(1) != 0, np.isfinite(expected).reshape(2, 4)
        )
        assert result.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert result.transform == interval.observations[0].transform
        assert result.units == (unit,)
        assert result.dtypes == ("float64",)
    with rasterio.open(directory / "count.tif") as count:
        np.testing.assert_array_equal(count.read(1), [[3, 2, 0, 2], [0, 2, 3, 2]])
        assert (count.read_masks(1) == 255).all()
        assert count.units == ("observations",)
        assert count.transform == interval.observations[0].transform
    assert artifact.valid_pixels == 6
    assert (
        artifact.sha256
        == hashlib.sha256((directory / "result.tif").read_bytes()).hexdigest()
    )
    assert artifact.additional_outputs[0].name == "count"
    assert (
        artifact.additional_outputs[0].sha256
        == hashlib.sha256((directory / "count.tif").read_bytes()).hexdigest()
    )
    assert not (directory / "ordered-values.bin").exists()
    provenance = json.loads((directory / "provenance.json").read_text())
    assert [item["time"] for item in provenance["observations"]] == [
        item.time.isoformat() for item in interval.observations
    ]
    assert provenance["allTouched"] is False
    assert provenance["unit"] == unit
    assert provenance["timeSupport"] == support
    policy = describe_temporal_policy(spec)
    assert policy.timeSupport == support
    assert policy.weighting == "equal_observation"
    assert str(tmp_path / "archive") not in json.dumps(provenance)
    assert "observations" not in spec.model_dump()
    assert source_files == {path: path.read_bytes() for path in source_files}


def test_all_missing_area_produces_zero_count_instead_of_failure(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
) -> None:
    """Retain a valid zero count where an entire selected cell lacks observations.

    Args:
        interval: Regional source containing one permanently missing cell.
        tmp_path: Isolated attempt root.
    """
    directory = tmp_path / "missing"
    _, artifact = _calculate(
        interval,
        TemporalReduction(reducer="mean"),
        AggregateArea(kind="bounds", bounds=(12.1, 11.1, 12.9, 11.9)),
        directory,
    )
    assert artifact.valid_pixels == 0
    with (
        rasterio.open(directory / "result.tif") as result,
        rasterio.open(directory / "count.tif") as count,
    ):
        assert result.read(1, masked=True).mask.all()
        values = count.read(1, masked=True)
        assert values.count() == 1
        assert values.compressed().tolist() == [0.0]


@pytest.mark.parametrize("area_kind", ["polygons", "catalogSelection"])
def test_polygon_uses_cell_centres_and_masks_count_outside_area(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
    area_kind: str,
) -> None:
    """Exclude touched-only cells from both ordinary outputs using one polygon mask.

    Args:
        interval: Regional native-grid source.
        tmp_path: Isolated attempt root.
        area_kind: Inline polygons or a filtered original GeoPackage.
    """
    polygon = PolygonSummaryInput(
        polygons=(
            {
                "type": "Polygon",
                "coordinates": [
                    [(10.1, 10.1), (12.1, 11.9), (10.1, 11.9), (10.1, 10.1)]
                ],
            },
        )
    )
    area = AggregateArea(
        kind="polygons",
        bounds=polygon.bounds(),
        geometryHash=polygon.geometry_hash(),
        geometries=tuple(item.model_dump() for item in polygon.polygons),
    )
    if area_kind == "catalogSelection":
        resolved = write_selection(
            tmp_path / "polygons.gpkg",
            [
                polygon.polygons[0].model_dump(),
                {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            (12.1, 10.1),
                            (13.8, 10.1),
                            (13.8, 11.8),
                            (12.1, 11.8),
                            (12.1, 10.1),
                        ]
                    ],
                },
            ],
            values=[1, 0],
            candidate=VectorFilter(
                enabled=True,
                match="all",
                rules=[{"field": "selected", "operator": "eq", "value": 1}],
            ),
        )
        area = AggregateArea(
            kind="catalogSelection",
            bounds=polygon.bounds(),
            catalogSelection=resolved.selection,
            resolved=resolved,
        )
    directory = tmp_path / "polygon"
    _calculate(interval, TemporalReduction(reducer="sum"), area, directory)
    with rasterio.open(directory / "count.tif") as count:
        # Three cell centres are inside; the lower-left has no observations.
        selected = count.read(1, masked=True)
        assert selected.count() == 3
        assert selected.compressed().tolist() == [3.0, 2.0, 0.0]
    with rasterio.open(directory / "result.tif") as result:
        assert result.read(1, masked=True).compressed().tolist() == [9.0, 8.0]
    assert not (directory / "polygon-mask.tif").exists()


def test_rotated_seam_view_applies_to_every_observation(tmp_path: Path) -> None:
    """Use the same physical longitude cells across time after area-driven rotation.

    Args:
        tmp_path: Isolated global archive and result directory.
    """
    transform = Affine(11.25, 0, -180, 0, -45, 67.5)
    values = np.broadcast_to(
        np.arange(32)[None, None, :] + np.array([0, 10, 20])[:, None, None],
        (3, 3, 32),
    ).astype("float32")
    values = np.roll(values, 16, axis=2)
    paths = [
        _write_observation(
            tmp_path / "archive" / f"global-{index}.tif",
            observation_values,
            transform,
            None,
        )
        for index, observation_values in enumerate(values)
    ]
    start = datetime(2000, 1, 1, tzinfo=timezone.utc)
    first = TemporalObservation(
        path=paths[0],
        time=start,
        reference_time=None,
        interval_start=start,
        interval_end=start,
        transform=transform,
        crs=CRS.from_epsg(4326),
        nodata=None,
        cyclic_x=True,
    )
    interval = ResolvedTemporalInterval(
        observations=tuple(
            replace(first, path=path, time=start + timedelta(hours=index))
            for index, path in enumerate(paths)
        ),
        unit="K",
        time_support="instantaneous",
    )
    directory = tmp_path / "seam"
    spec, _ = _calculate(
        interval,
        TemporalReduction(reducer="mean"),
        AggregateArea(kind="bounds", bounds=(-179, -10, -170, 10)),
        directory,
    )
    assert spec.grid.columnRotation != 0
    with (
        rasterio.open(directory / "result.tif") as result,
        rasterio.open(directory / "count.tif") as count,
    ):
        assert result.read(1, masked=True).compressed().tolist() == [26.0]
        assert count.read(1, masked=True).compressed().tolist() == [3.0]


def test_percentile_choice_is_validated_at_input_boundary() -> None:
    """Reject ambiguous reducer requests rather than interpreting ignored parameters."""
    for choice in (
        {"reducer": "percentile"},
        {"reducer": "sum", "percentile": 50},
        {"reducer": "percentile", "percentile": 101},
    ):
        with pytest.raises(ValidationError):
            TemporalReduction.model_validate(choice)


def test_single_observation_has_zero_population_deviation(
    interval: ResolvedTemporalInterval, tmp_path: Path
) -> None:
    """Retain the one-observation cells with zero deviation and count one.

    Args:
        interval: Regional source with valid and missing cells.
        tmp_path: Isolated attempt root.
    """
    single = replace(interval, observations=interval.observations[:1])
    directory = tmp_path / "singleton"
    _calculate(
        single,
        TemporalReduction(reducer="stdev"),
        AggregateArea(kind="wholeRaster"),
        directory,
    )
    with (
        rasterio.open(directory / "result.tif") as result,
        rasterio.open(directory / "count.tif") as count,
    ):
        assert result.read(1, masked=True).compressed().tolist() == [0.0] * 4
        np.testing.assert_array_equal(count.read(1), [[1, 1, 0, 0], [0, 0, 1, 1]])


@pytest.mark.parametrize("reducer", ["sum", "median"])
def test_unreadable_observation_fails_without_publishing_partial_outputs(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
    reducer: Literal["sum", "median"],
) -> None:
    """Expose native read failures without publishing streaming or ordered outputs.

    Args:
        interval: Admitted regional observations whose second TIFF will be unreadable.
        tmp_path: Isolated attempt root.
        reducer: Streaming sum or exact disk-backed median.
    """
    interval.observations[1].path.write_bytes(b"unreadable GeoTIFF")
    directory = tmp_path / "corrupt"
    with pytest.raises((OSError, ValueError)):
        _calculate(
            interval,
            TemporalReduction(reducer=reducer),
            AggregateArea(kind="wholeRaster"),
            directory,
        )
    assert not (directory / "ordered-values.bin").exists()
    assert not (directory / "result.tif").exists()
    assert not (directory / "count.tif").exists()


@pytest.mark.parametrize(
    "conversion",
    [
        PrecipitationConversion(inputUnit="kg m**-2 s**-1", outputUnit="mm", factor=1),
        PrecipitationConversion(inputUnit="m s**-1", outputUnit="cm", factor=100),
    ],
)
def test_precipitation_total_uses_recorded_durations_and_valid_cells(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
    conversion: PrecipitationConversion,
) -> None:
    """Integrate actual interval lengths without filling gaps or discarding zero rates.

    Args:
        interval: Native values with NaN and explicit NoData on a regional grid.
        tmp_path: Isolated output directory.
        conversion: Source units, output units and factor configured by the model.
    """
    origin = datetime(2000, 1, 1, tzinfo=timezone.utc)
    rates = replace(
        interval,
        time_support="mean_rate",
        unit=conversion.inputUnit,
        observations=tuple(
            replace(
                observation,
                time=origin + timedelta(hours=end),
                interval_start=origin + timedelta(hours=start),
                interval_end=origin + timedelta(hours=end),
            )
            for observation, (start, end) in zip(
                interval.observations, ((0, 1), (1, 3), (5, 6))
            )
        ),
    )
    with rasterio.open(rates.observations[0].path, "r+") as source:
        source.write(np.array([[0]], dtype="float32"), 1, window=Window(1, 0, 1, 1))
    directory = tmp_path / "precipitation"
    spec, artifact = _calculate(
        rates,
        TemporalReduction(reducer="precipitation_total"),
        AggregateArea(kind="wholeRaster"),
        directory,
        conversion,
    )
    with (
        rasterio.open(directory / "result.tif") as total,
        rasterio.open(directory / "count.tif") as count,
    ):
        np.testing.assert_allclose(
            total.read(1),
            np.array([[43200, 21600, np.nan, 57600], [np.nan, 28800, 100800, 50400]])
            * conversion.factor,
            equal_nan=True,
        )
        np.testing.assert_array_equal(count.read(1), [[3, 2, 0, 2], [0, 2, 3, 2]])
        assert total.units == (conversion.outputUnit,)
        assert count.units == ("observations",)
        assert artifact.valid_pixels == 6
    policy = describe_temporal_policy(spec)
    assert policy.timeSupport == "mean_rate"
    assert policy.weighting == "interval_duration"
    assert policy.unit == conversion.outputUnit
    provenance = json.loads((directory / "provenance.json").read_text())
    assert provenance["inputUnit"] == conversion.inputUnit
    assert provenance["unit"] == conversion.outputUnit
    assert provenance["conversionFactor"] == conversion.factor
    assert provenance["availableDurationSeconds"] == 4 * 3600
    assert provenance["weighting"] == "interval duration"
    assert [
        (item["intervalStart"], item["intervalEnd"])
        for item in provenance["observations"]
    ] == [
        (item.interval_start.isoformat(), item.interval_end.isoformat())
        for item in rates.observations
    ]


@pytest.mark.parametrize("source_dtype", ["float32", "float64"])
@pytest.mark.parametrize("reducer", ["sum", "precipitation_total"])
def test_streaming_arithmetic_preserves_native_validity_and_float64_operations(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
    source_dtype: Literal["float32", "float64"],
    reducer: Literal["sum", "precipitation_total"],
) -> None:
    """Skip masked native values and retain ordered float64 rate conversion.

    Args:
        interval: Metadata used to create admitted observations with mixed validity.
        tmp_path: Isolated native archive and output root.
        source_dtype: Native precision, including float32 values whose duration
            product exceeds float32 but is valid in float64.
        reducer: Ordinary summation or duration-weighted precipitation total.
    """
    nodata = float(np.finfo("float32").max) if source_dtype == "float32" else 1e308
    large_value = 1e38 if source_dtype == "float32" else 1e290
    values = np.array(
        [
            [
                [1.2345678901234567, 0.1, np.inf, nodata],
                [0, large_value, 2**60, np.nan],
            ],
            [[nodata, 0.15, -np.inf, np.nan], [0, large_value, -(2**60), nodata]],
            [[np.nan, -0.2, np.nan, nodata], [0, large_value, 1, np.inf]],
        ],
        dtype=source_dtype,
    )
    origin = interval.observations[0].time
    observations = tuple(
        replace(
            observation,
            path=_write_observation(
                tmp_path / "arithmetic-archive" / f"observation-{index}.tif",
                values[index],
                observation.transform,
                nodata,
            ),
            nodata=nodata,
            time=origin + timedelta(hours=end),
            interval_start=origin + timedelta(hours=start),
            interval_end=origin + timedelta(hours=end),
        )
        for index, (observation, (start, end)) in enumerate(
            zip(interval.observations, ((0, 1), (1, 3), (5, 6)))
        )
    )
    interval = replace(
        interval,
        observations=observations,
        unit="kg m**-2 s**-1",
        time_support="mean_rate",
    )
    factor = 0.12345678901234567
    conversion = (
        PrecipitationConversion(inputUnit=interval.unit, outputUnit="mm", factor=factor)
        if reducer == "precipitation_total"
        else None
    )
    directory = tmp_path / "arithmetic-output"
    _calculate(
        interval,
        TemporalReduction(reducer=reducer),
        AggregateArea(kind="wholeRaster"),
        directory,
        conversion,
    )
    expected, counts = _expected_tiled_reduction(
        values, reducer, (3600.0, 7200.0, 3600.0), nodata=nodata, factor=factor
    )
    with (
        rasterio.open(directory / "result.tif") as result,
        rasterio.open(directory / "count.tif") as count_raster,
    ):
        np.testing.assert_array_equal(result.read(1), expected)
        np.testing.assert_array_equal(result.read_masks(1) != 0, counts > 0)
        np.testing.assert_array_equal(count_raster.read(1), counts)
        if reducer == "precipitation_total":
            rate = float(values[0, 0, 0])
            assert (rate * 3600.0) * factor != rate * (3600.0 * factor)
            assert result.read(1)[0, 0] == (rate * 3600.0) * factor
        else:
            assert result.read(1)[1, 2] == 1.0


def test_precipitation_total_keeps_only_valid_observation_contributions(
    interval: ResolvedTemporalInterval, tmp_path: Path
) -> None:
    """Ignore later NoData, Inf and NaN after an extreme but valid conversion.

    Args:
        interval: Metadata for three observations on one shared native grid.
        tmp_path: Isolated archive and completed output root.
    """
    nodata, factor = 1e308, 1e308
    values = np.array(
        [
            [[1e-308, 1e-308, 1e-308, 0]],
            [[nodata, np.inf, np.nan, 0]],
            [[np.nan, nodata, -np.inf, 0]],
        ],
        dtype="float64",
    )
    origin = interval.observations[0].time
    observations = tuple(
        replace(
            observation,
            path=_write_observation(
                tmp_path / "masked-rate-archive" / f"observation-{index}.tif",
                values[index],
                observation.transform,
                nodata,
            ),
            nodata=nodata,
            time=origin + timedelta(hours=index + 1),
            interval_start=origin + timedelta(hours=index),
            interval_end=origin + timedelta(hours=index + 1),
        )
        for index, observation in enumerate(interval.observations)
    )
    interval = replace(
        interval,
        observations=observations,
        unit="kg m**-2 s**-1",
        time_support="mean_rate",
    )
    directory = tmp_path / "masked-rate-output"
    _calculate(
        interval,
        TemporalReduction(reducer="precipitation_total"),
        AggregateArea(kind="wholeRaster"),
        directory,
        PrecipitationConversion(
            inputUnit=interval.unit, outputUnit="mm", factor=factor
        ),
    )
    expected, counts = _expected_tiled_reduction(
        values, "precipitation_total", (3600.0,) * 3, nodata=nodata, factor=factor
    )
    with (
        rasterio.open(directory / "result.tif") as result,
        rasterio.open(directory / "count.tif") as count_raster,
    ):
        np.testing.assert_array_equal(result.read(1), expected)
        assert (result.read_masks(1) == 255).all()
        np.testing.assert_array_equal(count_raster.read(1), [[1, 1, 1, 3]])
        np.testing.assert_array_equal(count_raster.read(1), counts)


@pytest.mark.parametrize("reducer", ["sum", "precipitation_total"])
def test_valid_streaming_overflow_fails_without_publishing_partial_outputs(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
    reducer: Literal["sum", "precipitation_total"],
) -> None:
    """Keep numerical errors for overflowing valid additions or rate products.

    Args:
        interval: Metadata used to admit finite float64 observations.
        tmp_path: Isolated archive and failed attempt root.
        reducer: Summation overflows on addition; precipitation overflows on its
            first multiplication even though reassociating its tiny factor would fit.
    """
    origin = interval.observations[0].time
    observations = tuple(
        replace(
            observation,
            path=_write_observation(
                tmp_path / "overflow-archive" / f"observation-{index}.tif",
                np.array([[1e308]], dtype="float64"),
                observation.transform,
                None,
            ),
            nodata=None,
            time=origin + timedelta(hours=index + 1),
            interval_start=origin + timedelta(hours=index),
            interval_end=origin + timedelta(hours=index + 1),
        )
        for index, observation in enumerate(interval.observations)
    )
    interval = replace(
        interval,
        observations=observations,
        unit="kg m**-2 s**-1",
        time_support="mean_rate",
    )
    conversion = (
        PrecipitationConversion(inputUnit=interval.unit, outputUnit="mm", factor=1e-308)
        if reducer == "precipitation_total"
        else None
    )
    directory = tmp_path / "overflow-output"
    with pytest.raises(ProcessingError) as failure:
        _calculate(
            interval,
            TemporalReduction(reducer=reducer),
            AggregateArea(kind="wholeRaster"),
            directory,
            conversion,
        )
    assert failure.value.code == "numerical_error"
    assert not (directory / "result.tif").exists()
    assert not (directory / "count.tif").exists()


def test_precipitation_total_requires_whole_utc_hours_at_request_boundary() -> None:
    """Reject partial UTC hours without rounding persisted or API inputs silently."""
    source = {
        "collectionId": "eolab-temporal-datasets",
        "itemId": "weather",
        "variable": "rainfall",
        "startTime": "2000-01-01T00:00:00Z",
        "endTime": "2000-01-01T06:00:00Z",
    }
    conversion = PrecipitationConversion(
        inputUnit="kg m**-2 s**-1", outputUnit="mm", factor=1
    )
    for name, value in (
        ("startTime", "2000-01-01T00:30:00Z"),
        ("endTime", "2000-01-01T06:00:01Z"),
        ("endTime", "2000-01-01T06:00:00.000001Z"),
    ):
        with pytest.raises(ValidationError, match="whole UTC hours"):
            TemporalMapRequest(
                source={**source, name: value},
                reduction={"reducer": "precipitation_total"},
                precipitation=conversion,
                wholeRaster=True,
            )
    # The boundary is a UTC hour even when its supplied offset has half hours.
    request = TemporalMapRequest(
        source={**source, "startTime": "2000-01-01T05:30:00+05:30"},
        reduction={"reducer": "precipitation_total"},
        precipitation=conversion,
        wholeRaster=True,
    )
    assert request.source.start_time.astimezone(timezone.utc).hour == 0
    # Ordinary statistics retain arbitrary half-open periods.
    TemporalMapRequest(
        source={**source, "startTime": "2000-01-01T00:30:00Z"},
        reduction={"reducer": "mean"},
        precipitation=conversion,
        wholeRaster=True,
    )
