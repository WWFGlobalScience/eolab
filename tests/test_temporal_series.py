"""Verify per-observation area summaries from real TIFFs and their CSV results."""

import csv
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from queue import SimpleQueue
from threading import Barrier, Event, Lock

import numpy as np
import pytest
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.windows import Window

from eolab_app.processing.aggregate_models import (
    AggregateArea,
    NamedCalculation,
    PixelPoint,
    RasterAggregateLimits,
)
from eolab_app.processing.polygon_areas import PolygonSummaryInput
from eolab_app.processing.raster_aggregate import (
    calculate_raster_statistics_for_area,
    plan_statistics_grid,
)
from eolab_app.processing.temporal_grid import (
    plan_temporal_calculation_grid,
    plan_temporal_grid,
)
from eolab_app.processing.temporal_series import (
    calculate_temporal_observations,
    create_temporal_series,
    temporal_series_process_target,
)
from eolab_app.processing.temporal_series_models import (
    AreaStatistic,
    TemporalSeriesArtifact,
    TemporalSeriesSpec,
)
from eolab_app.processing.temporal_stack import create_temporal_stack
from eolab_app.processing.temporal_stack_models import (
    TemporalStackMetrics,
    TemporalStackSpec,
)
from eolab_app.raster.source_models import TemporalIntervalSelection
from eolab_app.raster.source_contract import (
    read_native_raster_window,
    require_signed_raster_dependencies,
)
from eolab_app.raster.temporal import (
    ResolvedTemporalInterval,
    TemporalObservation,
    TemporalRasterDataset,
)
from tests.test_temporal_reductions import _write_observation, interval
from tests.test_raster_aggregates import make_spec


def calculate_series(
    source: ResolvedTemporalInterval,
    statistic: AreaStatistic,
    area: AggregateArea,
    directory: Path,
) -> tuple[TemporalSeriesSpec, TemporalSeriesArtifact, list[dict[str, str]]]:
    """Calculate a real native series and read its exported CSV.

    Args:
        source: Published TIFF observations and their original units.
        statistic: Spatial statistic applied independently to each observation.
        area: Selected area shared by all dates.
        directory: New private attempt directory.

    Returns:
        Accepted plan, completed artifact and exported rows.
    """
    directory.mkdir()
    limits = RasterAggregateLimits()
    spec = TemporalSeriesSpec(
        source=TemporalIntervalSelection(
            collectionId="eolab-temporal-datasets",
            itemId="weather",
            variable="temperature",
            startTime=source.observations[0].interval_start,
            endTime=source.observations[-1].time + timedelta(hours=1),
        ),
        statistic=statistic,
        area=area,
        grid=plan_temporal_grid(source.observations[0], area, limits),
        unit="cells" if statistic == "count" else source.unit,
        timeSupport=source.time_support,
        observationCount=len(source.observations),
        firstObservation=source.observations[0].time,
        lastObservation=source.observations[-1].time,
    )
    artifact = create_temporal_series(source, spec, directory, limits)
    with (directory / "result.csv").open(encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream))
    return spec, artifact, rows


@pytest.mark.parametrize("metadata", ["files", "scales", "offsets", "units"])
def test_series_leaves_unused_native_metadata_for_its_consumers(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    metadata: str,
) -> None:
    """Skip unused metadata in series reads while preserving ordinary reader access.

    Args:
        interval: Real TIFF observations on a common admitted grid.
        tmp_path: Private calculation output directory.
        monkeypatch: Observe the native metadata getter without replacing reads.
        metadata: File dependencies or band metadata unused by the series.
    """
    native_metadata = getattr(rasterio.io.DatasetReader, metadata)
    requested: list[str] = []

    def read_metadata(dataset: rasterio.io.DatasetReader) -> object:
        """Record native metadata access and return its original value.

        Args:
            dataset: Open real TIFF whose metadata is being requested.

        Returns:
            The selected native file list or band metadata, unchanged.
        """
        requested.append(dataset.name)
        return native_metadata.__get__(dataset, type(dataset))

    monkeypatch.setattr(rasterio.io.DatasetReader, metadata, property(read_metadata))
    _, _, rows = calculate_series(
        interval, "mean", AggregateArea(kind="wholeRaster"), tmp_path / "series"
    )
    assert [float(row["value"]) for row in rows] == pytest.approx([2.75, 4, 43 / 6])
    assert requested == []
    observation = interval.observations[0]
    with TemporalRasterDataset(observation) as dataset:
        if metadata == "files":
            require_signed_raster_dependencies(dataset, observation)
        else:
            grid = plan_statistics_grid(
                dataset,
                Window(0, 0, dataset.width, dataset.height),
                1,
                RasterAggregateLimits(),
            )
            assert (grid.scale, grid.offset, grid.storedUnit) == ("1.0", "0.0", None)
    assert requested == [str(observation.path)]


@pytest.mark.parametrize("statistic", ["count", "sum", "mean", "min", "max", "stdev"])
def test_series_matches_each_observations_valid_cells(
    interval: ResolvedTemporalInterval, tmp_path: Path, statistic: AreaStatistic
) -> None:
    """Export each available date independently, preserving gaps and scalar values.

    Args:
        interval: Gapped TIFF observations containing NoData and nonfinite values.
        tmp_path: Isolated result root.
        statistic: Each supported statistic from the shared scalar engine.
    """
    directory = tmp_path / "result"
    spec, artifact, rows = calculate_series(
        interval, statistic, AggregateArea(kind="wholeRaster"), directory
    )
    valid = ([1, 2, 3, 5], [3, 4, 2, 7], [5, 6, 8, 4, 11, 9])
    expected = {
        "count": [4, 4, 6],
        "sum": [11, 16, 43],
        "mean": [2.75, 4, 43 / 6],
        "min": [1, 2, 4],
        "max": [5, 7, 11],
        "stdev": [float(np.std(values)) for values in valid],
    }[statistic]
    assert [float(row["value"]) for row in rows] == pytest.approx(expected)
    assert [row["valid_pixels"] for row in rows] == ["4", "4", "6"]
    assert [row["time_utc"] for row in rows] == [
        observation.time.isoformat() for observation in interval.observations
    ]
    assert all(row["state"] == "ok" and row["unit"] == spec.unit for row in rows)
    if statistic == "count":
        assert [row["value"] for row in rows] == ["4", "4", "6"]
    assert artifact.row_count == 3
    assert artifact.size == (directory / "result.csv").stat().st_size
    assert (
        artifact.sha256
        == hashlib.sha256((directory / "result.csv").read_bytes()).hexdigest()
    )
    provenance_text = (directory / "provenance.json").read_text()
    provenance = json.loads(provenance_text)
    assert all(
        observation.path.name not in provenance_text
        for observation in interval.observations
    )
    assert provenance["inputUnit"] == "K"
    assert provenance["weighting"] == "equal_valid_pixel"
    assert provenance["temporalAggregation"] == "none"
    assert len(provenance["observations"]) == len(rows)


def test_series_combines_multiple_native_tiles(
    interval: ResolvedTemporalInterval, tmp_path: Path
) -> None:
    """Accumulate one statistic across all native tiles of a selected observation.

    Args:
        interval: Time metadata for the new regional observation.
        tmp_path: Isolated TIFF and result root.
    """
    values = np.arange(1, 41, dtype="float32").reshape(2, 20)
    transform = Affine(0.5, 0, 10, 0, -0.5, 12)
    observation = replace(
        interval.observations[0],
        path=_write_observation(tmp_path / "wide.tif", values, transform, None),
        transform=transform,
        nodata=None,
    )
    source = replace(interval, observations=(observation,))
    spec, _, rows = calculate_series(
        source, "stdev", AggregateArea(kind="wholeRaster"), tmp_path / "result"
    )
    assert spec.grid.tileCount == 2
    assert rows[0]["valid_pixels"] == "40"
    assert float(rows[0]["value"]) == pytest.approx(float(np.std(values)))


def test_series_replenishes_two_readers_and_writes_in_time_order(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep reading later dates while a slow first TIFF waits, then write in order.

    Args:
        interval: Three observations whose first read waits for the third.
        tmp_path: Isolated result root.
        monkeypatch: Coordinate native reads without elapsed-time assertions.
    """
    first, second, third = (item.path for item in interval.observations)
    together = Barrier(2, timeout=5)
    third_finished = Event()
    lock = Lock()
    active = peak = 0
    finished: list[Path] = []
    datasets: list[TemporalRasterDataset] = []

    def read_out_of_order(
        dataset: TemporalRasterDataset, window: Window
    ) -> np.ma.MaskedArray:
        """Read real pixels while holding the first timestamp until the third ends.

        Args:
            dataset: Observation handle owned by the calling read thread.
            window: The calculation's spatial crop.

        Returns:
            Native values and validity from the original reader.
        """
        nonlocal active, peak
        path = Path(dataset.name)
        with lock:
            datasets.append(dataset)
            active += 1
            peak = max(peak, active)
        try:
            if path in (first, second):
                together.wait()
            if path == first:
                assert third_finished.wait(5)
            values = read_native_raster_window(dataset, window)
            with lock:
                finished.append(path)
            if path == third:
                third_finished.set()
            return values
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(
        "eolab_app.processing.temporal_series.read_native_raster_window",
        read_out_of_order,
    )
    directory = tmp_path / "result"
    _, _, rows = calculate_series(
        interval, "mean", AggregateArea(kind="wholeRaster"), directory
    )
    assert peak == 2 and active == 0
    assert finished == [second, third, first]
    assert all(dataset.native_dataset.closed for dataset in datasets)
    assert [float(row["value"]) for row in rows] == pytest.approx([2.75, 4, 43 / 6])
    assert [row["time_utc"] for row in rows] == [
        item.time.isoformat() for item in interval.observations
    ]
    assert json.loads((directory / "progress.json").read_text()) == {
        "phase": "summarizing",
        "completedBlocks": 3,
        "totalBlocks": 3,
    }


@pytest.mark.parametrize("statistic", ["count", "mean"])
def test_series_retains_all_nodata_rows_and_embedded_validity(
    interval: ResolvedTemporalInterval, tmp_path: Path, statistic: AreaStatistic
) -> None:
    """Keep null rows for present empty observations and honor native TIFF masks.

    Args:
        interval: Published observations modified before calculation begins.
        tmp_path: Isolated output directory.
        statistic: Count and a numeric statistic share the scalar empty-data state.
    """
    with rasterio.open(interval.observations[1].path, "r+") as raster:
        raster.write(np.full(raster.shape, -9999, dtype="float32"), 1)
    with rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True):
        with rasterio.open(interval.observations[2].path, "r+") as raster:
            mask = np.zeros(raster.shape, dtype="uint8")
            mask[0, 3] = 255
            raster.write_mask(mask)
    _, _, rows = calculate_series(
        interval, statistic, AggregateArea(kind="wholeRaster"), tmp_path / "result"
    )
    assert len(rows) == 3
    assert rows[1]["value"] == ""
    assert rows[1]["valid_pixels"] == "0"
    assert rows[1]["state"] == "no_valid_data"
    assert float(rows[2]["value"]) == (1 if statistic == "count" else 8)
    assert rows[2]["valid_pixels"] == "1"


def test_series_uses_cell_centres_and_cleans_its_shared_polygon_mask(
    interval: ResolvedTemporalInterval, tmp_path: Path
) -> None:
    """Apply the same exact polygon to each date and remove its attempt-owned mask.

    Args:
        interval: Native TIFF observations on the same regional grid.
        tmp_path: Isolated output root.
    """
    polygons = PolygonSummaryInput(
        polygons=(
            {
                "type": "Polygon",
                "coordinates": [
                    [(11.1, 10.1), (12.8, 10.1), (11.1, 11.8), (11.1, 10.1)]
                ],
            },
        )
    )
    area = AggregateArea(
        kind="polygons",
        bounds=polygons.bounds(),
        geometryHash=polygons.geometry_hash(),
        geometries=tuple(item.model_dump() for item in polygons.polygons),
    )
    directory = tmp_path / "result"
    _, _, rows = calculate_series(interval, "sum", area, directory)
    assert [row["value"] for row in rows] == ["", "2.0", "4.0"]
    assert [row["valid_pixels"] for row in rows] == ["0", "1", "1"]
    assert not (directory / "polygon-mask.tif").exists()


@pytest.mark.parametrize("support", ["mean_rate", "accumulation"])
def test_series_preserves_interval_support_without_temporal_integration(
    interval: ResolvedTemporalInterval, tmp_path: Path, support: str
) -> None:
    """Summarize stored interval measurements without scaling or splitting them.

    Args:
        interval: Values reused as rates or accumulations on their declared intervals.
        tmp_path: Isolated output root.
        support: An interval-based source interpretation.
    """
    source = replace(
        interval,
        observations=tuple(
            replace(
                observation,
                interval_start=observation.time - timedelta(minutes=90),
                interval_end=observation.time,
            )
            for observation in interval.observations
        ),
        unit="kg m**-2 s**-1" if support == "mean_rate" else "J m**-2",
        time_support=support,
    )
    _, _, rows = calculate_series(
        source, "mean", AggregateArea(kind="wholeRaster"), tmp_path / "result"
    )
    assert [float(row["value"]) for row in rows] == pytest.approx([2.75, 4, 43 / 6])
    assert all(row["unit"] == source.unit for row in rows)
    assert [row["interval_start_utc"] for row in rows] == [
        observation.interval_start.isoformat() for observation in source.observations
    ]
    assert [row["interval_end_utc"] for row in rows] == [
        observation.interval_end.isoformat() for observation in source.observations
    ]


def test_series_preserves_cyclic_cells_across_dates(tmp_path: Path) -> None:
    """Select the same native edge cell in each global observation.

    Args:
        tmp_path: Isolated source and result directory.
    """
    transform = Affine(11.25, 0, -180, 0, -45, 67.5)
    start = datetime(2000, 1, 1, tzinfo=timezone.utc)
    observations = tuple(
        TemporalObservation(
            path=_write_observation(
                tmp_path / "archive" / f"global-{index}.tif",
                np.broadcast_to(np.arange(32) + index * 10, (3, 32)).astype("float32"),
                transform,
                None,
            ),
            time=start + timedelta(hours=index),
            reference_time=None,
            interval_start=start + timedelta(hours=index),
            interval_end=start + timedelta(hours=index),
            transform=transform,
            crs=CRS.from_epsg(4326),
            nodata=None,
            cyclic_x=True,
        )
        for index in range(3)
    )
    source = ResolvedTemporalInterval(observations, "K", "instantaneous")
    spec, _, rows = calculate_series(
        source,
        "mean",
        AggregateArea(kind="bounds", bounds=(-179, -10, -170, 10)),
        tmp_path / "result",
    )
    assert spec.grid.columnRotation != 0
    assert [float(row["value"]) for row in rows] == [0, 10, 20]
    assert [row["valid_pixels"] for row in rows] == ["1", "1", "1"]
    with rasterio.open(observations[1].path, "r+") as dataset:
        dataset.write(
            np.array([[np.nan]], dtype="float32"), 1, window=Window(31, 1, 1, 1)
        )
    calculations = (
        NamedCalculation(label="Area mean", expression="mean(a)"),
        NamedCalculation(label="Point", expression="pixelValue(a)"),
        NamedCalculation(label="Selected hectares", expression="areaha(a >= 0)"),
    )
    point = PixelPoint(longitude=179.0, latitude=0.0)
    limits = RasterAggregateLimits()
    grid, _ = plan_temporal_calculation_grid(
        source.observations[0], spec.area, limits, calculations, point
    )
    directory = tmp_path / "formulas"
    directory.mkdir()
    results = list(
        calculate_temporal_observations(
            source, spec.area, grid, calculations, point, directory, limits
        )
    )
    assert [float(rows[0]["value"]) for _, rows in results] == [0, 10, 20]
    assert [rows[1]["value"] for _, rows in results] == ["31.0", None, "51.0"]
    hectares = [float(rows[2]["value"]) for _, rows in results]
    assert hectares[0] > 0 and hectares == pytest.approx([hectares[0]] * 3)


def test_unreadable_observation_returns_native_failure_without_artifact(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Close active TIFF reads and leave no artifact when an observation fails.

    Args:
        interval: TIFF observations whose second file is removed before the attempt.
        tmp_path: Isolated private output root.
        monkeypatch: Record successful native opens during the failing calculation.
    """
    spec, _, _ = calculate_series(
        interval,
        "mean",
        AggregateArea(kind="bounds", bounds=(10, 10, 14, 12)),
        tmp_path / "complete",
    )
    interval.observations[1].path.unlink()
    datasets: list[TemporalRasterDataset] = []

    def observe_read(
        dataset: TemporalRasterDataset, window: Window
    ) -> np.ma.MaskedArray:
        """Record a live TIFF handle and return its original pixels.

        Args:
            dataset: Observation handle owned by the calling read thread.
            window: The calculation's spatial crop.

        Returns:
            Native values and validity from the original reader.
        """
        datasets.append(dataset)
        return read_native_raster_window(dataset, window)

    monkeypatch.setattr(
        "eolab_app.processing.temporal_series.read_native_raster_window",
        observe_read,
    )
    directory = tmp_path / "failed"
    directory.mkdir()
    queue: SimpleQueue[tuple[object, ...]] = SimpleQueue()
    temporal_series_process_target(
        queue, "series", (interval, spec, directory, RasterAggregateLimits())
    )
    assert queue.get() == (
        "error",
        (
            "temporal_read_failed",
            "The temporal input or result file could not be read or written.",
            409,
        ),
    )
    assert not (directory / "provenance.json").exists()
    assert not (directory / "polygon-mask.tif").exists()
    assert datasets and all(dataset.native_dataset.closed for dataset in datasets)


@pytest.mark.parametrize("area_kind", ["bounds", "polygons"])
def test_temporal_formulas_match_ordinary_raster_calculations(
    interval: ResolvedTemporalInterval, tmp_path: Path, area_kind: str
) -> None:
    """Reuse point, formula, cell-centre and fractional-hectare semantics per date.

    Args:
        interval: Native TIFFs with different NoData patterns on the same grid.
        tmp_path: Separate temporal and ordinary calculation directories.
        area_kind: A partial-cell box or triangular polygon.
    """
    bounds = (11.25, 10.25, 13.75, 11.75)
    if area_kind == "polygons":
        polygons = PolygonSummaryInput(
            polygons=(
                {
                    "type": "Polygon",
                    "coordinates": [
                        [(11.25, 10.25), (13.75, 10.25), (11.25, 11.75), (11.25, 10.25)]
                    ],
                },
            )
        )
        area = AggregateArea(
            kind="polygons",
            bounds=polygons.bounds(),
            geometryHash=polygons.geometry_hash(),
            geometries=tuple(item.model_dump() for item in polygons.polygons),
        )
    else:
        area = AggregateArea(kind="bounds", bounds=bounds)
    expressions = [
        "mean(a)",
        "count(a > 3)",
        "areaha(a > 0)",
        "pixelValue(a)",
        "(pixelValue(a) - mean(a)) / stdev(a)",
    ]
    calculations = tuple(
        NamedCalculation(label=f"Result {index}", expression=expression)
        for index, expression in enumerate(expressions)
    )
    point = PixelPoint(longitude=10.5, latitude=11.5)
    limits = RasterAggregateLimits()
    grid, ground_area = plan_temporal_calculation_grid(
        interval.observations[0], area, limits, calculations, point
    )
    assert ground_area is not None and ground_area.strategy == "rectilinear"
    directory = tmp_path / "temporal"
    directory.mkdir()
    actual = list(
        calculate_temporal_observations(
            interval, area, grid, calculations, point, directory, limits
        )
    )
    assert [observation.time for observation, _ in actual] == [
        observation.time for observation in interval.observations
    ]
    for index, (observation, rows) in enumerate(actual):
        reference_directory = tmp_path / f"ordinary-{index}"
        reference_directory.mkdir()
        spec = make_spec(observation.path, expressions, area, pixel_point=point)
        reference = calculate_raster_statistics_for_area(
            observation.path, spec, reference_directory, limits
        )
        for row, expected in zip(rows, reference.rows, strict=True):
            assert {key: value for key, value in row.items() if key != "value"} == {
                key: value for key, value in expected.items() if key != "value"
            }
            if expected["value"] is None:
                assert row["value"] is None
            else:
                assert isinstance(row["value"], str)
                assert float(row["value"]) == pytest.approx(float(expected["value"]))
    assert [rows[3]["value"] for _, rows in actual] == ["1.0", "3.0", "5.0"]
    assert all(rows[2]["unit"] == "ha" for _, rows in actual)
    assert not (directory / "polygon-mask.tif").exists()


@pytest.mark.parametrize("outside", [False, True])
def test_temporal_point_formulas_ignore_area_and_read_only_the_selected_cell(
    interval: ResolvedTemporalInterval,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    outside: bool,
) -> None:
    """Read one native cell per observation and retain NoData or outside states.

    Args:
        interval: Native TIFFs whose selected cell is valid, NoData, then valid.
        tmp_path: Isolated result directory.
        monkeypatch: Observe native reads and reject unused area preparation.
        outside: Place the point outside the grid, requiring no pixel reads.
    """
    import eolab_app.processing.raster_aggregate as aggregate
    import eolab_app.processing.temporal_grid as planning
    import eolab_app.processing.temporal_series as series

    def reject_area(*args: object, **kwargs: object) -> None:
        """Reject area preparation that point-only formulas must never request."""
        pytest.fail("Point-only formulas must not prepare an area")

    reads: list[Window] = []

    def observe_read(
        dataset: TemporalRasterDataset, window: Window
    ) -> np.ma.MaskedArray:
        """Record a requested native window and return its actual source values.

        Args:
            dataset: Observation-owned TIFF handle.
            window: Exact selected native cell.

        Returns:
            Native values with their original validity mask.
        """
        reads.append(window)
        return read_native_raster_window(dataset, window)

    monkeypatch.setattr(planning, "prepare_raster_area_tools", reject_area)
    monkeypatch.setattr(series, "prepare_raster_area_tools", reject_area)
    monkeypatch.setattr(series, "read_native_raster_window", observe_read)
    monkeypatch.setattr(aggregate, "read_native_raster_window", observe_read)
    point = PixelPoint(longitude=0.5 if outside else 11.5, latitude=11.5)
    area = AggregateArea(kind="bounds", bounds=(-20, -20, -19, -19))
    calculations = (NamedCalculation(label="Point", expression="pixelValue(a)"),)
    limits = RasterAggregateLimits()
    grid, ground_area = plan_temporal_calculation_grid(
        interval.observations[0], area, limits, calculations, point
    )
    assert ground_area is None
    assert reads == []
    directory = tmp_path / "point"
    directory.mkdir()
    results = list(
        calculate_temporal_observations(
            interval, area, grid, calculations, point, directory, limits
        )
    )
    assert len(results) == 3
    if outside:
        assert reads == []
        assert [rows[0]["state"] for _, rows in results] == ["no_valid_data"] * 3
    else:
        assert len(reads) == 3 and all(window == Window(1, 0, 1, 1) for window in reads)
        assert [rows[0]["value"] for _, rows in results] == ["2.0", None, "6.0"]
        assert [rows[0]["state"] for _, rows in results] == [
            "ok",
            "no_valid_data",
            "ok",
        ]
    assert not (directory / "polygon-mask.tif").exists()


def test_temporal_stack_csv_preserves_named_results_and_path_free_provenance(
    interval: ResolvedTemporalInterval, tmp_path: Path
) -> None:
    """Write ordered real-TIFF results without losing values, states or coverage.

    Args:
        interval: Gapped observations with a selected pixel that is NoData on one date.
        tmp_path: Private native calculation and CSV publication directories.
    """
    metrics = TemporalStackMetrics(
        calculations=(
            NamedCalculation(label="Point", expression="pixelValue(a)"),
            NamedCalculation(label="Area mean", expression="mean(a)"),
            NamedCalculation(label="Difference", expression="pixelValue(a) - mean(a)"),
            NamedCalculation(label="Positive hectares", expression="areaha(a > 0)"),
            NamedCalculation(
                label="Division by zero", expression="mean(a) / (max(a) - max(a))"
            ),
        ),
        pixelPoint=PixelPoint(longitude=11.5, latitude=11.5),
    )
    area = AggregateArea(kind="wholeRaster")
    limits = RasterAggregateLimits()
    grid, ground_area = plan_temporal_calculation_grid(
        interval.observations[0], area, limits, metrics.calculations, metrics.pixelPoint
    )
    spec = TemporalStackSpec(
        source=TemporalIntervalSelection(
            collectionId="eolab-temporal-datasets",
            itemId="weather",
            variable="temperature",
            startTime=interval.observations[0].time,
            endTime=interval.observations[-1].time + timedelta(hours=1),
        ),
        metrics=metrics,
        area=area,
        grid=grid,
        groundArea=ground_area,
        sourceUnit=interval.unit,
        timeSupport=interval.time_support,
        observationCount=len(interval.observations),
        firstObservation=interval.observations[0].time,
        lastObservation=interval.observations[-1].time,
    )
    reference_directory = tmp_path / "reference"
    reference_directory.mkdir()
    expected = [
        (observation, row)
        for observation, rows in calculate_temporal_observations(
            interval,
            area,
            grid,
            metrics.calculations,
            metrics.pixelPoint,
            reference_directory,
            limits,
        )
        for row in rows
    ]
    directory = tmp_path / "csv"
    directory.mkdir()
    artifact = create_temporal_stack(interval, spec, directory, limits)
    result_path = directory / "result.csv"
    with result_path.open(encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream))
    assert artifact.row_count == len(rows) == 15
    for exported, (observation, result) in zip(rows, expected, strict=True):
        assert {
            key: value for key, value in exported.items() if key != "aggregates"
        } == {
            "time_utc": observation.time.isoformat(),
            "interval_start_utc": observation.interval_start.isoformat(),
            "interval_end_utc": observation.interval_end.isoformat(),
            "variable": "temperature",
            "calculation": result["label"],
            "expression": result["expression"],
            "value": result["value"] if result["value"] is not None else "",
            "value_type": result["valueType"] or "",
            "unit": result["unit"] or "",
            "state": result["state"],
        }
        assert json.loads(exported["aggregates"]) == result["aggregates"]
    assert [row["value"] for row in rows[::5]] == ["2.0", "", "6.0"]
    assert [row["state"] for row in rows[::5]] == ["ok", "no_valid_data", "ok"]
    assert all(row["state"] == "invalid_arithmetic" for row in rows[4::5])
    assert all(row["unit"] == "ha" for row in rows[3::5])
    assert artifact.sha256 == hashlib.sha256(result_path.read_bytes()).hexdigest()
    assert artifact.size == result_path.stat().st_size
    provenance_text = (directory / "provenance.json").read_text(encoding="utf-8")
    provenance = json.loads(provenance_text)
    assert provenance["metrics"] == metrics.model_dump(mode="json")
    assert provenance["source"] == spec.source.model_dump(mode="json", by_alias=True)
    assert provenance["sourceUnit"] == "K"
    assert provenance["groundArea"]["strategy"] == "rectilinear"
    assert provenance["temporalAggregation"] == "none"
    assert [item["time"] for item in provenance["observations"]] == [
        observation.time.isoformat() for observation in interval.observations
    ]
    assert all(
        observation.path.name not in provenance_text
        for observation in interval.observations
    )
