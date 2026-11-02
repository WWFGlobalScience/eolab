"""Verify period-map calculations using native GeoTIFF inputs and completed COGs."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
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
from eolab_app.processing.temporal_grid import plan_temporal_grid
from eolab_app.raster.source_models import TemporalIntervalSelection
from eolab_app.raster.temporal import ResolvedTemporalInterval, TemporalObservation
from eolab_app.vector.filters import VectorFilter
from catalog_selection_support import write_selection


def _write_observation(
    path: Path,
    values: NDArray[np.float32],
    transform: Affine,
    nodata: float | None,
) -> Path:
    """Write one native observation used by the period-calculation tests.

    Args:
        path: New GeoTIFF location inside the isolated archive.
        values: Native observation values in published column order.
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
        dtype="float32",
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


def test_unreadable_observation_fails_without_publishing_a_partial_median(
    interval: ResolvedTemporalInterval, tmp_path: Path
) -> None:
    """Expose an actual native read failure instead of publishing a partial median.

    Args:
        interval: Admitted regional observations whose second TIFF will be unreadable.
        tmp_path: Isolated attempt root.
    """
    interval.observations[1].path.write_bytes(b"unreadable GeoTIFF")
    directory = tmp_path / "corrupt"
    with pytest.raises((OSError, ValueError)):
        _calculate(
            interval,
            TemporalReduction(reducer="median"),
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
