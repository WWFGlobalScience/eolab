"""Verify geodesic sampling-box intent across statistics and Processing workflows."""

import asyncio
import csv
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from typing import Literal

import httpx2
import numpy as np
from numpy.typing import NDArray
from pydantic import TypeAdapter
import pytest
from rasterio.crs import CRS
from rasterio.transform import from_bounds

from eolab_app.catalog.geotiff import build_stac_item
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    RasterAggregateLimits,
    UnpreparedCalculation,
)
from eolab_app.processing.clip_models import UnpreparedClip
from eolab_app.processing.model_run_contracts import SummaryArea, ClipModelArea
from eolab_app.processing.raster_operations import (
    bind_area_arguments,
    bind_summary,
    bind_clip,
    build_summary_submission,
    build_clip_submission,
)
from eolab_app.processing.temporal_grid import (
    plan_temporal_grid,
    plan_temporal_calculation_grid,
)
from eolab_app.processing.temporal_series import create_temporal_series
from eolab_app.processing.temporal_series_models import TemporalSeriesSpec
from eolab_app.processing.temporal_stack import create_temporal_stack
from eolab_app.processing.temporal_stack_models import (
    TemporalStackMetrics,
    TemporalStackSpec,
)
from eolab_app.raster.catalog import StacRasterCatalog
from eolab_app.raster.errors import RasterNotFoundError
from eolab_app.raster.models import (
    CatalogRasterStatisticsRequest,
    CatalogRasterPairRequest,
    RasterStatistics,
    RasterPairedStatistics,
    CanonicalWgs84Bounds,
)
from eolab_app.raster.paired_statistics import read_raster_paired_statistics
from eolab_app.raster.read_cancellation import RasterReadCancellationCheck
from eolab_app.raster.reader import RasterData
from eolab_app.raster.source_access import RasterSourceAccess
from eolab_app.raster.source_authorization import CatalogRasterSourceAuthorizer
from eolab_app.raster.source_models import TemporalIntervalSelection
from eolab_app.raster.sources import MountedRasterResolver
from eolab_app.raster.statistics import read_raster_statistics
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.raster.temporal import TemporalObservation, ResolvedTemporalInterval
from eolab_app.sampling_area import RasterSamplingArea
from eolab_app.sampling_box import Wgs84SamplingBox, sampling_box_bounds
from raster_fixture_support import write_source

BOX = Wgs84SamplingBox(center={"longitude": 10.0, "latitude": 60.0}, sideLengthKm=2000)
TRANSFORM = from_bounds(-35.13, 35.17, 55.23, 80.34, 100, 80)


def write_workflow_rasters(directory: Path) -> tuple[list[Path], NDArray[np.float64]]:
    """Write immutable aligned sources with distinguishable values and shared NoData.

    Args:
        directory: Isolated caller-owned fixture directory.

    Returns:
        Two original GeoTIFF paths and the first source's stored native values.
    """
    values = np.arange(80 * 100, dtype="float64").reshape(80, 100)
    values[40, 50] = -9999
    second = np.where(values == -9999, -9999, values + 5000)
    paths = [
        write_source(directory / name, data, nodata=-9999, transform=TRANSFORM)
        for name, data in [("first.tif", values), ("second.tif", second)]
    ]
    return paths, values


def test_statistics_service_retains_box_identity_through_authorization_cache_and_pair_reads(
    tmp_path: Path,
) -> None:
    """Keep box geometry separate from its envelope across real source reads and warm cache.

    Args:
        tmp_path: Confined mount for actual original raster sources.
    """
    paths, _ = write_workflow_rasters(tmp_path)
    items = [build_stac_item(tmp_path, path) for path in paths]
    documents = {item["id"]: item for item in items}
    catalog_calls: list[str] = []
    ordinary_reads: list[RasterSamplingArea] = []
    paired_reads: list[Wgs84SamplingBox | None] = []
    denied = False

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        """Serve authoritative metadata only; no renderer or publication API exists.

        Args:
            request: Original-source Catalog lookup.

        Returns:
            Current scanner metadata, or a controlled missing-source response.
        """
        assert request.url.host == "catalog"
        identity = request.url.path.rsplit("/", 1)[-1]
        catalog_calls.append(identity)
        return (
            httpx2.Response(404)
            if denied
            else httpx2.Response(200, json=documents[identity])
        )

    def read_statistics(
        data: RasterData,
        area: RasterSamplingArea,
        cancellation: RasterReadCancellationCheck,
    ) -> RasterStatistics:
        """Observe the real service/read boundary while retaining native calculations.

        Args:
            data: Authorized original source.
            area: Resolved box or rectangle, including its exact intent.
            cancellation: Shared last-waiter cancellation predicate.

        Returns:
            Actual bounded source statistics.
        """
        ordinary_reads.append(area)
        return read_raster_statistics(data, area, cancellation)

    def read_pair(
        x: RasterData,
        y: RasterData,
        bounds: CanonicalWgs84Bounds | None,
        cancellation: RasterReadCancellationCheck,
        sampling_box: Wgs84SamplingBox | None = None,
    ) -> RasterPairedStatistics:
        """Observe the paired read's explicit descriptor without replacing its math.

        Args:
            x: Authorized reference-grid source.
            y: Authorized aligned source.
            bounds: Original rectangular bounds, absent for a geodesic box.
            cancellation: Shared last-waiter cancellation predicate.
            sampling_box: Exact accepted box descriptor, or no geodesic selection.

        Returns:
            Actual bounded paired histogram.
        """
        paired_reads.append(sampling_box)
        return read_raster_paired_statistics(
            x, y, bounds, cancellation, sampling_box=sampling_box
        )

    async def scenario() -> None:
        """Exercise accepted source identities through the actual service entry points."""
        nonlocal denied
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(catalog_response)
        ) as client:
            service = RasterStatisticsService(
                RasterSourceAccess(
                    CatalogRasterSourceAuthorizer(
                        StacRasterCatalog(client, "http://catalog"),
                        MountedRasterResolver(tmp_path),
                    )
                ),
                read_concurrency=1,
                cache_entries=32,
                statistics_reader=read_statistics,
                paired_statistics_reader=read_pair,
            )
            sources = [
                {"collectionId": item["collection"], "itemId": item["id"]}
                for item in items
            ]
            request = CatalogRasterStatisticsRequest(**sources[0], samplingBox=BOX)
            first, coalesced = await asyncio.gather(
                service.get(request), service.get(request)
            )
            assert first is coalesced
            assert first.scope == "samplingBox" and first.sampling_box == BOX
            assert first.selected_bounds is None
            assert (
                await service.get(
                    CatalogRasterStatisticsRequest.model_validate_json(
                        request.model_dump_json(by_alias=True)
                    )
                )
                is first
            )
            assert len(ordinary_reads) == 1 and len(catalog_calls) == 3
            moved_box = Wgs84SamplingBox(
                center={"longitude": 11.0, "latitude": 60.0}, sideLengthKm=2000
            )
            moved = await service.get(
                CatalogRasterStatisticsRequest(**sources[0], samplingBox=moved_box)
            )
            assert moved.sampling_box == moved_box and len(ordinary_reads) == 2
            smaller = Wgs84SamplingBox(center=BOX.center, sideLengthKm=1000)
            await service.get(
                CatalogRasterStatisticsRequest(**sources[0], samplingBox=smaller)
            )
            assert len(ordinary_reads) == 3
            west, south, east, north = sampling_box_bounds(BOX)
            rectangle = await service.get(
                CatalogRasterStatisticsRequest(
                    **sources[0],
                    selectedBounds={
                        "west": west,
                        "south": south,
                        "east": east,
                        "north": north,
                    },
                )
            )
            assert rectangle.scope == "selectedArea" and rectangle.sampling_box is None
            assert first.valid_sample_count < rectangle.valid_sample_count
            assert len(ordinary_reads) == 4
            pair_request = CatalogRasterPairRequest(
                xRaster=sources[0], yRaster=sources[1], samplingBox=BOX
            )
            pair = await service.get_paired(pair_request)
            assert pair.scope == "samplingBox" and pair.sampling_box == BOX
            assert pair.selected_bounds is None
            assert pair.y_minimum - pair.x_minimum == pytest.approx(5000)
            assert await service.get_paired(pair_request) is pair
            assert paired_reads == [BOX]
            await service.get_paired(
                CatalogRasterPairRequest(
                    xRaster=sources[0], yRaster=sources[1], samplingBox=moved_box
                )
            )
            await service.get_paired(
                CatalogRasterPairRequest(
                    xRaster=sources[1], yRaster=sources[0], samplingBox=BOX
                )
            )
            assert paired_reads == [BOX, moved_box, BOX]
            rectangle_pair = await service.get_paired(
                CatalogRasterPairRequest(
                    xRaster=sources[0],
                    yRaster=sources[1],
                    selectedBounds={
                        "west": west,
                        "south": south,
                        "east": east,
                        "north": north,
                    },
                )
            )
            assert (
                rectangle_pair.scope == "selectedArea"
                and rectangle_pair.sampling_box is None
            )
            assert pair.paired_sample_count < rectangle_pair.paired_sample_count
            assert paired_reads == [BOX, moved_box, BOX, None]
            denied = True
            with pytest.raises(RasterNotFoundError):
                await service.get(request)
            with pytest.raises(RasterNotFoundError):
                await service.get_paired(pair_request)
            assert len(ordinary_reads) == 4 and len(paired_reads) == 4

    asyncio.run(scenario())


@pytest.mark.parametrize("area_type", ["summary", "clip"])
def test_model_box_capture_binds_and_persists_descriptor_without_polygon_snapshot(
    area_type: Literal["summary", "clip"],
) -> None:
    """Carry an accepted model area's descriptor into durable summary and clip jobs.

    Args:
        area_type: Existing model input union used by summary or clip recipes.
    """
    submitted = {"kind": "samplingBox", "samplingBox": BOX.model_dump(mode="json")}
    adapter = TypeAdapter(SummaryArea if area_type == "summary" else ClipModelArea)
    captured = adapter.validate_json(
        adapter.dump_json(adapter.validate_python(submitted))
    )
    area = captured.model_dump(mode="json")
    assert bind_area_arguments(area) == {"samplingBox": BOX.model_dump(mode="json")}
    raster = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": "geotiff-0123456789abcdef01234567",
    }
    summary = bind_summary(
        {"raster": raster, "area": area},
        {"expression": "mean(a)"},
        "summary-box-capture-1057",
        "Mean",
    )
    clip = bind_clip(
        {"raster": raster, "area": area}, {}, "clip-box-capture-1057", "Clip"
    )
    summary_plan = build_summary_submission(summary, None)
    clip_plan = build_clip_submission(clip, None)
    restored_summary = UnpreparedCalculation.model_validate_json(
        json.dumps(summary_plan.specification)
    )
    restored_clip = UnpreparedClip.model_validate_json(
        json.dumps(clip_plan.specification)
    )
    submitted["samplingBox"]["sideLengthKm"] = 500
    assert restored_summary.request.samplingBox == BOX
    assert restored_clip.request.samplingBox == BOX
    assert (
        restored_summary.request.selectedBounds is None
        and restored_clip.request.selectedBounds is None
    )
    for plan in (summary_plan, clip_plan):
        assert plan.summary["area"]["kind"] == "samplingBox"
        assert plan.summary["area"]["samplingBox"] == BOX.model_dump(mode="json")
        assert "coordinates" not in json.dumps(plan.specification)
    rectangle = adapter.validate_python(
        {
            "kind": "selectedArea",
            "selectedBounds": {"west": 0, "south": 0, "east": 1, "north": 1},
        }
    )
    assert set(bind_area_arguments(rectangle.model_dump(mode="json"))) == {
        "selectedBounds"
    }


def test_temporal_series_and_stack_preserve_box_descriptor_and_mask_for_each_observation(
    tmp_path: Path,
) -> None:
    """Use the same geodesic selection in actual per-observation series and formula CSVs.

    Args:
        tmp_path: Immutable observations and private calculation output directories.
    """
    paths, _ = write_workflow_rasters(tmp_path)
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    observations = tuple(
        TemporalObservation(
            path=path,
            time=start + timedelta(hours=index),
            reference_time=None,
            interval_start=start + timedelta(hours=index),
            interval_end=start + timedelta(hours=index),
            transform=TRANSFORM,
            crs=CRS.from_epsg(4326),
            nodata=-9999,
        )
        for index, path in enumerate(paths)
    )
    interval = ResolvedTemporalInterval(
        observations=observations, unit="K", time_support="instantaneous"
    )
    source = TemporalIntervalSelection(
        collectionId="eolab-temporal-datasets",
        itemId="weather",
        variable="temperature",
        startTime=start,
        endTime=start + timedelta(days=1),
    )
    area = AggregateArea(
        kind="samplingBox", bounds=sampling_box_bounds(BOX), samplingBox=BOX
    )
    limits = RasterAggregateLimits()
    common = {
        "source": source,
        "area": area,
        "timeSupport": interval.time_support,
        "observationCount": len(observations),
        "firstObservation": observations[0].time,
        "lastObservation": observations[-1].time,
    }
    series = TemporalSeriesSpec(
        **common,
        statistic="mean",
        grid=plan_temporal_grid(observations[0], area, limits),
        unit="K",
    )
    metrics = TemporalStackMetrics(
        calculations=[{"label": "Mean", "expression": "mean(a)"}]
    )
    grid, ground = plan_temporal_calculation_grid(
        observations[0], area, limits, metrics.calculations, None
    )
    stack = TemporalStackSpec(
        **common, metrics=metrics, grid=grid, groundArea=ground, sourceUnit="K"
    )
    restored_series = TemporalSeriesSpec.model_validate_json(
        series.model_dump_json(by_alias=True)
    )
    restored_stack = TemporalStackSpec.model_validate_json(
        stack.model_dump_json(by_alias=True)
    )
    rows = []
    for name, spec, execute in [
        ("series", restored_series, create_temporal_series),
        ("stack", restored_stack, create_temporal_stack),
    ]:
        directory = tmp_path / name
        directory.mkdir()
        artifact = execute(interval, spec, directory, limits)
        assert artifact.row_count == 2
        provenance = json.loads(
            (directory / "provenance.json").read_text(encoding="utf-8")
        )
        assert provenance["area"]["samplingBox"] == BOX.model_dump(mode="json")
        assert provenance["area"]["kind"] == "samplingBox"
        with (directory / "result.csv").open(encoding="utf-8", newline="") as stream:
            rows.append(list(csv.DictReader(stream)))
    assert [row["value"] for row in rows[0]] == [row["value"] for row in rows[1]]
    assert float(rows[0][1]["value"]) - float(rows[0][0]["value"]) == pytest.approx(
        5000
    )
    assert all(row["state"] == "ok" for group in rows for row in group)

    rectangle = AggregateArea(kind="bounds", bounds=area.bounds)
    rectangle_spec = TemporalSeriesSpec(
        **{**common, "area": rectangle},
        statistic="mean",
        grid=plan_temporal_grid(observations[0], rectangle, limits),
        unit="K",
    )
    rectangle_directory = tmp_path / "rectangle"
    rectangle_directory.mkdir()
    create_temporal_series(interval, rectangle_spec, rectangle_directory, limits)
    with (rectangle_directory / "result.csv").open(
        encoding="utf-8", newline=""
    ) as stream:
        rectangle_rows = list(csv.DictReader(stream))
    assert int(rows[0][0]["valid_pixels"]) < int(rectangle_rows[0]["valid_pixels"])
    assert float(rows[0][0]["value"]) != pytest.approx(
        float(rectangle_rows[0]["value"])
    )
