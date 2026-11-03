"""Verify admitted temporal selections through the existing raster API and refresh."""

import asyncio
from pathlib import Path
import shutil
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx2
import numpy
import pytest
import rasterio
from rasterio.windows import Window
from contextlib import closing
import sqlite3

from eolab_app.raster.catalog import StacRasterCatalog
from eolab_app.raster.errors import RasterAssetError
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.models import RasterStatistics
from eolab_app.raster.read_cancellation import RasterReadCancellationCheck
from eolab_app.raster.reader import RasterData
from eolab_app.raster.statistics import read_raster_statistics
from eolab_app.sampling_area import RasterSamplingArea
from eolab_app.raster.source_access import RasterSourceAccess
from eolab_app.raster.source_authorization import CatalogRasterSourceAuthorizer
from eolab_app.raster.source_models import TemporalIntervalSelection
from eolab_app.raster.sources import MountedRasterResolver
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.raster.reader import open_raster_data
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.routes.catalog import create_catalog_router
from tests.test_catalog_temporal import (
    ITEM_KEY,
    PRECIPITATION,
    RADIATION,
    TEMPERATURE,
    VARIABLES,
    create_scanner,
    era5_archive,
    publish_month,
    observation_path,
    scan,
)


def populate_month(archive: Path, variable: str, values: tuple[float, ...]) -> None:
    """Write sparse February values into published GeoTIFF observations.

    Args:
        archive: Test producer archive with published February coverage.
        variable: Variable already recorded in SQLite.
        values: Native values for hours zero, one and two; absent hours stay absent.
    """
    with closing(sqlite3.connect(archive / "catalog.sqlite")) as connection:
        rows = connection.execute(
            "SELECT path, valid_time FROM observations WHERE variable = ? "
            "AND strftime('%Y-%m', valid_time, 'unixepoch') = '2000-02'",
            (variable,),
        ).fetchall()
    for relative_path, time in rows:
        value = values[(time - 949363200) // 3600]
        with rasterio.open(archive / relative_path, "r+") as raster:
            raster.write(
                numpy.full((3, 3), value, dtype="float32"),
                1,
                window=Window(720, 359, 3, 3),
            )
            raster.write(
                numpy.full((3, 3), value + 2, dtype="float32"),
                1,
                window=Window(717, 359, 3, 3),
            )


def test_api_reads_selections_and_refreshes_statistics(era5_archive: Path) -> None:
    """Read two dates and variables without rendering, then refresh changed values.

    Args:
        era5_archive: Published partial months with actual per-variable gaps.
    """
    populate_month(era5_archive, TEMPERATURE, (10, 20, 30))
    populate_month(era5_archive, PRECIPITATION, (1, 99, 3))
    other_archive = era5_archive.parent / "other-weather"
    shutil.copytree(era5_archive, other_archive)
    descriptor = other_archive / "dataset.yaml"
    descriptor.write_text(
        descriptor.read_text(encoding="utf-8").replace("era5-test", "era5-other"),
        encoding="utf-8",
    )
    # Each scanner refreshes one archive in the common mounted source directory.
    scanner, writer = create_scanner(era5_archive)
    other_scanner, other_writer = create_scanner(other_archive)

    async def catalog_response(request: httpx2.Request) -> httpx2.Response:
        """Expose the scanner's current Item through the actual Catalog adapter.

        Args:
            request: Internal Catalog request.

        Returns:
            Current persisted Item, without a map or rendering service.
        """
        parts = request.url.path.split("/")
        key = (parts[-3], parts[-1])
        items = {**writer.write_session.items, **other_writer.write_session.items}
        return httpx2.Response(200, json=items[key])

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(catalog_response))
    sources = RasterSourceAccess(
        CatalogRasterSourceAuthorizer(
            StacRasterCatalog(client, "http://catalog"),
            MountedRasterResolver(era5_archive.parent),
        )
    )
    read_count = 0

    def count_statistics_reads(
        data: RasterData,
        area: RasterSamplingArea,
        cancellation_requested: RasterReadCancellationCheck,
    ) -> RasterStatistics:
        """Count native reads while executing the ordinary numerical reader.

        Args:
            data: Authorized original file or temporal observation.
            area: Sampling area resolved by the real analysis service.
            cancellation_requested: Shared read cancellation predicate.

        Returns:
            Statistics calculated from the fixture's actual source cells.
        """
        nonlocal read_count
        read_count += 1
        return read_raster_statistics(data, area, cancellation_requested)

    statistics = RasterStatisticsService(
        sources, 1, 20, statistics_reader=count_statistics_reads
    )
    scanner.items_updated = statistics.invalidate_temporal_items
    asyncio.run(scan(scanner))
    assert scanner.status()["errors"] == []
    asyncio.run(scan(other_scanner))
    assert other_scanner.status()["errors"] == []
    app = FastAPI()
    app.include_router(
        create_raster_analysis_router(
            RasterPixelService(sources, 1),
            statistics,
            source_access=sources,
        )
    )
    source = {
        "collectionId": ITEM_KEY[0],
        "itemId": ITEM_KEY[1],
        "variable": TEMPERATURE,
        "time": "2000-02-01T00:00:00Z",
    }
    bounds = {"west": -0.3, "south": -0.1, "east": 0.3, "north": 0.1}
    with TestClient(app) as api:
        description = api.post("/api/raster-analysis/sources", json={"source": source})
        assert description.status_code == 200, description.text
        assert description.json()["width"] == 1440
        assert description.json()["capabilities"]["pixels"]["supported"]
        pixel = api.post(
            "/api/raster-analysis/pixels",
            json={
                "source": source,
                "longitude": 0,
                "latitude": 0,
            },
        )
        assert pixel.status_code == 200, pixel.text
        assert pixel.json()["value"] == 10
        assert pixel.json()["column"] == 720
        request = {"source": source, "selectedBounds": bounds}
        result = api.post("/api/raster-analysis/statistics", json=request)
        assert result.status_code == 200, result.text
        assert result.json()["sampleMinimum"] == 10
        assert result.json()["sampleMaximum"] == 12
        assert read_count == 1
        equivalent_time = {**source, "time": "2000-01-31T16:00:00-08:00"}
        equivalent = api.post(
            "/api/raster-analysis/statistics",
            json={
                **request,
                "source": equivalent_time,
            },
        )
        assert equivalent.status_code == 200, equivalent.text
        assert equivalent.json() == result.json()
        assert read_count == 1
        unrelated_request = {**request, "source": {**source, "itemId": "era5-other"}}
        unrelated = api.post("/api/raster-analysis/statistics", json=unrelated_request)
        assert unrelated.status_code == 200, unrelated.text
        assert unrelated.json() == result.json()
        assert read_count == 2
        categorical_request = {**request, "categoryValues": [10, 12, 40, 42]}
        categories = api.post(
            "/api/raster-analysis/statistics", json=categorical_request
        )
        assert categories.status_code == 200, categories.text
        category_areas = categories.json()["categoricalDistribution"]["areasHectares"]
        assert category_areas[0] > 0 and category_areas[1] > 0
        assert category_areas[2:] == [0, 0]
        changed_time = {**source, "time": "2000-02-01T01:00:00Z"}
        later = api.post(
            "/api/raster-analysis/statistics", json={**request, "source": changed_time}
        )
        assert later.status_code == 200, later.text
        assert later.json()["sampleMinimum"] == 20
        east = api.post(
            "/api/raster-analysis/statistics",
            json={
                **request,
                "selectedBounds": {**bounds, "west": 0.1, "east": 0.3},
            },
        )
        assert east.status_code == 200, east.text
        assert east.json()["sampleMaximum"] == 10
        pair_request = {
            "xRaster": source,
            "yRaster": changed_time,
            "selectedBounds": bounds,
        }
        paired = api.post("/api/raster-analysis/paired-statistics", json=pair_request)
        assert paired.status_code == 200, paired.text
        assert paired.json()["xMinimum"] == 10
        assert paired.json()["yMinimum"] == 20
        same_observation_request = {**pair_request, "yRaster": source}
        same_observation = api.post(
            "/api/raster-analysis/paired-statistics", json=same_observation_request
        )
        assert same_observation.status_code == 200, same_observation.text
        histogram = same_observation.json()["histogram"]
        assert histogram["xEdges"] == histogram["yEdges"]
        assert histogram["xMarginalCounts"] == histogram["yMarginalCounts"]
        numpy.testing.assert_array_equal(
            histogram["counts"], numpy.diag(histogram["xMarginalCounts"])
        )
        precipitation = {**source, "variable": PRECIPITATION}
        other = api.post(
            "/api/raster-analysis/statistics", json={**request, "source": precipitation}
        )
        assert other.status_code == 200, other.text
        assert other.json()["sampleMinimum"] == 1
        missing = api.post(
            "/api/raster-analysis/pixels",
            json={
                "source": {**precipitation, "time": "2000-02-01T01:00:00Z"},
                "longitude": 0,
                "latitude": 0,
            },
        )
        assert missing.status_code == 409
        assert "No observation" in missing.json()["detail"]
        absent_cell = api.post(
            "/api/raster-analysis/pixels",
            json={
                "source": source,
                "longitude": 50,
                "latitude": 30,
            },
        )
        assert absent_cell.status_code == 200
        assert absent_cell.json()["value"] is None
        unknown = api.post(
            "/api/raster-analysis/pixels",
            json={
                "source": {**source, "variable": "not_a_variable"},
                "longitude": 0,
                "latitude": 0,
            },
        )
        assert unknown.status_code == 422
        for invalid_source in (
            {key: value for key, value in source.items() if key != "time"},
            {**source, "time": "2000-02-01T00:00:00"},
            {**source, "time": "not-a-date"},
        ):
            invalid = api.post(
                "/api/raster-analysis/pixels",
                json={
                    "source": invalid_source,
                    "longitude": 0,
                    "latitude": 0,
                },
            )
            assert invalid.status_code == 422, invalid.text
        populate_month(era5_archive, TEMPERATURE, (40, 50, 60))
        # Operator update -> scan -> calculate; no mutation probes during reads.
        api.portal.call(scan, scanner)
        assert scanner.status()["errors"] == []
        refreshed = api.post("/api/raster-analysis/statistics", json=request)
        assert refreshed.status_code == 200, refreshed.text
        assert refreshed.json()["sampleMinimum"] == 40
        assert refreshed.json()["sampleMaximum"] == 42
        refreshed_pair = api.post(
            "/api/raster-analysis/paired-statistics", json=pair_request
        )
        assert refreshed_pair.status_code == 200, refreshed_pair.text
        assert refreshed_pair.json()["xMinimum"] == 40
        assert refreshed_pair.json()["yMinimum"] == 50
        refreshed_same_observation = api.post(
            "/api/raster-analysis/paired-statistics", json=same_observation_request
        )
        assert (
            refreshed_same_observation.status_code == 200
        ), refreshed_same_observation.text
        assert refreshed_same_observation.json()["xMinimum"] == 40
        assert refreshed_same_observation.json()["yMinimum"] == 40
        refreshed_categories = api.post(
            "/api/raster-analysis/statistics", json=categorical_request
        )
        assert refreshed_categories.status_code == 200, refreshed_categories.text
        new_areas = refreshed_categories.json()["categoricalDistribution"][
            "areasHectares"
        ]
        assert new_areas[:2] == [0, 0]
        assert new_areas[2:] == pytest.approx(category_areas[:2])
        reads_before_unrelated = read_count
        retained = api.post("/api/raster-analysis/statistics", json=unrelated_request)
        assert retained.status_code == 200, retained.text
        assert retained.json() == unrelated.json()
        assert read_count == reads_before_unrelated
        raster = observation_path(era5_archive, TEMPERATURE, 2, 0)
        raster.write_bytes(b"unreadable raster")
        unreadable = api.post(
            "/api/raster-analysis/pixels",
            json={
                "source": source,
                "longitude": 0,
                "latitude": 0,
            },
        )
        assert unreadable.status_code == 409
        assert "could not be sampled" in unreadable.json()["detail"]
    asyncio.run(client.aclose())


def test_interval_selection_preserves_gaps_and_time_support(era5_archive: Path) -> None:
    """Resolve admitted variable metadata and original intervals without filling gaps.

    Args:
        era5_archive: Two partial months with a gap in precipitation coverage.
    """
    populate_month(era5_archive, PRECIPITATION, (1, 99, 3))
    scanner, writer = create_scanner(era5_archive.parent)
    asyncio.run(scan(scanner))

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        """Return the scanner's persisted Item through the real Catalog adapter.

        Args:
            request: Internal request for the selected Catalog Item.

        Returns:
            The admitted Item or the ordinary missing-Item response.
        """
        parts = request.url.path.split("/")
        item = writer.write_session.items.get((parts[-3], parts[-1]))
        return httpx2.Response(404) if item is None else httpx2.Response(200, json=item)

    async def resolve_periods() -> None:
        """Read real source metadata, gaps and native values through authorization."""
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(catalog_response)
        ) as client:
            authorizer = CatalogRasterSourceAuthorizer(
                StacRasterCatalog(client, "http://catalog"),
                MountedRasterResolver(era5_archive.parent),
            )
            period = {
                "collectionId": ITEM_KEY[0],
                "itemId": ITEM_KEY[1],
                "variable": PRECIPITATION,
                "startTime": "2000-01-31T23:00:00Z",
                "endTime": "2000-02-01T02:00:00Z",
            }
            metadata = await authorizer.get_temporal_metadata(
                TemporalIntervalSelection(**period)
            )
            assert metadata.unit == "kg m**-2 s**-1"
            assert metadata.time_support == "mean_rate"
            interval = await authorizer.get_temporal_interval(
                TemporalIntervalSelection(**period)
            )
            assert interval.unit == "kg m**-2 s**-1"
            assert interval.time_support == "mean_rate"
            observations = interval.observations
            assert [value.time.hour for value in observations] == [0, 2]
            assert observations[0].crs is observations[1].crs
            assert observations[0].transform is observations[1].transform
            assert [
                (value.time - value.reference_time).total_seconds()
                for value in observations
            ] == [6 * 3600, 6 * 3600]
            assert [
                (value.interval_end - value.interval_start).total_seconds()
                for value in observations
            ] == [3600, 3600]
            values = []
            for observation in observations:
                with open_raster_data(observation) as dataset:
                    values.append(
                        float(dataset.read(1, window=Window(720, 360, 1, 1))[0, 0])
                    )
            assert values == [1, 3]
            partial = await authorizer.get_temporal_interval(
                TemporalIntervalSelection(
                    **{
                        **period,
                        "startTime": "2000-01-31T23:30:00Z",
                        "endTime": "2000-02-01T01:30:00Z",
                    }
                )
            )
            assert [
                (value.time, value.interval_start, value.interval_end)
                for value in partial.observations
            ] == [
                (value.time, value.interval_start, value.interval_end)
                for value in observations
            ]
            instant = await authorizer.get_temporal_interval(
                TemporalIntervalSelection(
                    **{
                        **period,
                        "variable": TEMPERATURE,
                        "endTime": "2000-02-01T00:00:00Z",
                    }
                )
            )
            assert instant.unit == "K" and instant.time_support == "instantaneous"
            assert len(instant.observations) == 1
            assert (
                instant.observations[0].time.isoformat() == "2000-01-31T23:00:00+00:00"
            )
            assert instant.observations[0].reference_time is None
            accumulated = await authorizer.get_temporal_interval(
                TemporalIntervalSelection(**{**period, "variable": RADIATION})
            )
            assert accumulated.unit == "W m**-2 s"
            assert accumulated.time_support == "accumulation"
            assert len(accumulated.observations) == 1
            with pytest.raises(RasterAssetError, match="selected variable"):
                await authorizer.get_temporal_metadata(
                    TemporalIntervalSelection(**{**period, "variable": "unknown"})
                )
            with pytest.raises(RasterAssetError, match="selected variable"):
                await authorizer.get_temporal_interval(
                    TemporalIntervalSelection(**{**period, "variable": "unknown"})
                )

    asyncio.run(resolve_periods())


@pytest.mark.parametrize(
    "location", ["descriptor", "raster", "absolute-raster", "symlink"]
)
def test_catalog_source_path_cannot_escape_mount(
    era5_archive: Path, location: str
) -> None:
    """Confine descriptor and raster paths when a selection resolves its source.

    Args:
        era5_archive: Valid archive used to construct authoritative metadata.
        location: External path or symlink introduced at the source boundary.
    """
    from eolab_app.raster.errors import RasterAssetError
    from eolab_app.raster.source_models import TemporalRasterSelection

    scanner, writer = create_scanner(era5_archive.parent)
    asyncio.run(scan(scanner))
    item = writer.write_session.items[ITEM_KEY]
    if location == "descriptor":
        item["assets"]["eolab:temporal-source"]["href"] = (
            era5_archive.parent.parent / "outside.yaml"
        ).as_uri()
    elif location == "symlink":
        path = observation_path(era5_archive, TEMPERATURE, 2, 0)
        external = era5_archive.parent / "outside.tif"
        path.rename(external)
        try:
            path.symlink_to(external)
        except OSError as error:
            pytest.skip(f"Creating a test symlink is unavailable: {error}")
    else:
        path = (
            "../outside.tif"
            if location == "raster"
            else (era5_archive / "absolute.tif").as_posix()
        )
        with closing(sqlite3.connect(era5_archive / "catalog.sqlite")) as db, db:
            db.execute(
                "UPDATE coverage SET path = ? WHERE variable = ?", (path, TEMPERATURE)
            )
    with pytest.raises(RasterAssetError, match="outside"):
        MountedRasterResolver(era5_archive.parent).get_observations(
            item,
            TemporalRasterSelection(
                collectionId=ITEM_KEY[0],
                itemId=ITEM_KEY[1],
                variable=TEMPERATURE,
                time="2000-02-01T00:00:00Z",
            ),
        )


def test_catalog_time_choices_follow_actual_labels_and_explicit_refresh(
    era5_archive: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Discover actual dates for arbitrary variables without a renderer or pixel reads.

    Args:
        era5_archive: Two published partial months with variable-specific gaps.
        monkeypatch: Add a fixture variable and prevent native reads during discovery.
    """

    monkeypatch.setitem(
        VARIABLES, "vegetation_index", ("instant", "1", "Vegetation index")
    )
    publish_month(era5_archive, 3, {"vegetation_index": (12, 36, 84)})
    scanner, writer = create_scanner(era5_archive.parent)
    asyncio.run(scan(scanner))

    async def catalog_response(request: httpx2.Request) -> httpx2.Response:
        """Return the scanner's current authoritative Item through STAC.

        Args:
            request: Catalog request identifying the dataset.

        Returns:
            Current Item, or HTTP 404 for an unknown dataset.
        """
        parts = request.url.path.split("/")
        item = writer.write_session.items.get((parts[-3], parts[-1]))
        return httpx2.Response(404) if item is None else httpx2.Response(200, json=item)

    def reject_raster_read(*args: object, **kwargs: object) -> None:
        """Fail if listing labels attempts a native array read.

        Args:
            args: Unexpected positional array arguments.
            kwargs: Unexpected named array arguments.

        Raises:
            AssertionError: Always, because this request only needs SQLite coverage.
        """
        raise AssertionError("Time discovery must not open GeoTIFFs")

    monkeypatch.setattr(rasterio, "open", reject_raster_read)
    catalog_client = httpx2.AsyncClient(
        transport=httpx2.MockTransport(catalog_response)
    )
    authorizer = CatalogRasterSourceAuthorizer(
        StacRasterCatalog(catalog_client, "http://catalog"),
        MountedRasterResolver(era5_archive.parent),
    )
    application = FastAPI()
    application.include_router(
        create_catalog_router(AsyncMock(), authorizer.get_time_choices, AsyncMock())
    )
    query = {
        "collectionId": ITEM_KEY[0],
        "itemId": ITEM_KEY[1],
        "variable": PRECIPITATION,
    }
    with TestClient(application) as api:
        latest = api.post("/api/catalog/temporal-times", json=query)
        assert latest.status_code == 200, latest.text
        assert latest.headers["Cache-Control"] == "no-store"
        assert latest.json() == {
            "months": ["2000-01", "2000-02"],
            "month": "2000-02",
            "times": ["2000-02-01T00:00:00.000Z", "2000-02-01T02:00:00.000Z"],
        }
        assert str(era5_archive) not in latest.text
        january = api.post(
            "/api/catalog/temporal-times", json={**query, "month": "2000-01"}
        )
        # February's midnight accumulation covers January's final hour, but its
        # observation label belongs only to February's selectable coordinates.
        assert january.json()["times"] == ["2000-01-31T22:00:00.000Z"]
        temperature = api.post(
            "/api/catalog/temporal-times", json={**query, "variable": TEMPERATURE}
        )
        assert temperature.json()["times"] == [
            "2000-02-01T00:00:00.000Z",
            "2000-02-01T01:00:00.000Z",
            "2000-02-01T02:00:00.000Z",
        ]
        radiation = api.post(
            "/api/catalog/temporal-times", json={**query, "variable": RADIATION}
        )
        assert radiation.json()["months"] == ["2000-02"]
        vegetation = api.post(
            "/api/catalog/temporal-times",
            json={**query, "variable": "vegetation_index"},
        )
        assert vegetation.status_code == 200, vegetation.text
        assert vegetation.json() == {
            "months": ["2000-03"],
            "month": "2000-03",
            "times": [
                "2000-03-01T12:00:00.000Z",
                "2000-03-02T12:00:00.000Z",
                "2000-03-04T12:00:00.000Z",
            ],
        }
        absent = api.post(
            "/api/catalog/temporal-times", json={**query, "month": "2000-03"}
        )
        assert absent.json() == {
            "months": ["2000-01", "2000-02"],
            "month": "2000-03",
            "times": [],
        }
        for invalid_month in ("2000-13", "200001", "2000-1", "2000-W01"):
            invalid = api.post(
                "/api/catalog/temporal-times", json={**query, "month": invalid_month}
            )
            assert invalid.status_code == 422
        unknown = api.post(
            "/api/catalog/temporal-times", json={**query, "variable": "unknown"}
        )
        assert unknown.status_code == 422
        missing = api.post(
            "/api/catalog/temporal-times", json={**query, "itemId": "unknown"}
        )
        assert missing.status_code == 404

        # Operator update -> explicit scan -> read new choices. Retain an explicit
        # month, and list only observations currently published by the producer.
        monkeypatch.undo()
        publish_month(
            era5_archive, 2, {TEMPERATURE: (0,), PRECIPITATION: (0,), RADIATION: (0,)}
        )
        publish_month(era5_archive, 3, {TEMPERATURE: (0,), PRECIPITATION: (0,)})
        api.portal.call(scan, scanner)
        assert scanner.status()["errors"] == []
        refreshed = api.post(
            "/api/catalog/temporal-times", json={**query, "month": "2000-02"}
        )
        assert refreshed.json() == {
            "months": ["2000-01", "2000-02", "2000-03"],
            "month": "2000-02",
            "times": ["2000-02-01T00:00:00.000Z"],
        }
        assert (
            api.post("/api/catalog/temporal-times", json=query).json()["month"]
            == "2000-03"
        )
        (era5_archive / "catalog.sqlite").unlink()
        unreadable = api.post("/api/catalog/temporal-times", json=query)
        assert unreadable.status_code == 409
        assert unreadable.json() == {
            "detail": "The temporal dataset metadata could not be read."
        }
        assert unreadable.headers["Cache-Control"] == "no-store"
        writer.write_session.items[ITEM_KEY]["assets"]["eolab:temporal-source"][
            "href"
        ] = (era5_archive.parent.parent / "outside.yaml").as_uri()
        outside = api.post("/api/catalog/temporal-times", json=query)
        assert outside.status_code == 422
        assert str(era5_archive.parent) not in outside.text
    asyncio.run(catalog_client.aclose())
