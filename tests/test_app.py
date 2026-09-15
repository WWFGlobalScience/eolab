"""Test the EOLab application and its runtime settings contract."""

import asyncio
import base64
import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx2
import fiona
import numpy
import pytest
import rasterio
from fastapi.testclient import TestClient
from rasterio.transform import from_origin

from eolab_app.main import create_app
from eolab_app.settings import load_settings
from tests.app_support import (
    GeoServerPublicationMock,
    TEST_GEOTIFF_ITEM_ID,
    mounted_geotiff_item as _mounted_geotiff_item,
    write_geotiff as _write_geotiff,
)


def test_healthz(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Report liveness using the baked Git-derived application version."""
    response = TestClient(create_app(version_file_path)).get("/healthz")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "eolab",
        "version": "0.5.0-2-gabcdef0",
    }


def test_configuration_endpoint_reads_environment(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Expose the deployment environment through the public configuration."""
    monkeypatch.setenv("APP_TITLE", "WWF EOLab")
    monkeypatch.setenv("CATALOG_URL", "https://catalog.example.test")

    response = TestClient(create_app(version_file_path)).get("/api/config")

    assert response.status_code == 200
    assert response.json() == {
        "appTitle": "WWF EOLab",
        "appSubtitle": "Explore, visualize, and analyze Earth observation data",
        "appVersion": "0.5.0-2-gabcdef0",
        "catalogUrl": "https://catalog.example.test",
        "wmsUrl": "/geoserver/eolab/wms",
        "scanDisplayPathPrefix": "bigboi -- Z:\\bigbucket",
        "scanDisplayPaths": ["bigboi -- Z:\\bigbucket"],
        "basemap": {
            "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "attribution": "&copy; OpenStreetMap contributors",
        },
        "initialView": {
            "latitude": 20,
            "longitude": 0,
            "zoom": 2,
        },
    }
    settings = load_settings(version_file_path)
    assert (
        settings.raster_pixel_read_concurrency,
        settings.raster_statistics_read_concurrency,
        settings.raster_statistics_cache_entries,
        settings.composite_tile_cache_bytes,
    ) == (2, 1, 32, 134217728)
    assert "valid-admin-password" not in repr(settings)
    assert "http://geoserver:8080" not in response.text
    assert "http://geoserver:9404" not in response.text


def test_public_scan_paths_use_the_user_facing_prefix(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Expose configured scan directories without leaking the container mount.

    Args:
        configured_environment: Complete baseline environment fixture.
        monkeypatch: Pytest environment mutation fixture.
        tmp_path: Isolated mounted-directory fixture root.
        version_file_path: File containing the test application version.
    """
    scan_mount = tmp_path / "scan-source"
    (scan_mount / "incoming").mkdir(parents=True)
    (scan_mount / "archive" / "2025").mkdir(parents=True)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(scan_mount))
    monkeypatch.setenv(
        "SCAN_PATHS_WITHIN_MOUNT",
        '["incoming", "archive/2025"]',
    )

    settings = load_settings(version_file_path)

    assert settings.scan_display_paths() == (
        "bigboi -- Z:\\bigbucket\\incoming",
        "bigboi -- Z:\\bigbucket\\archive\\2025",
    )
    assert settings.as_public_dict()["scanDisplayPaths"] == [
        "bigboi -- Z:\\bigbucket\\incoming",
        "bigboi -- Z:\\bigbucket\\archive\\2025",
    ]
    assert str(scan_mount) not in str(settings.as_public_dict())


def test_load_settings_reads_scan_operational_limits(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Load deployer-controlled scan bounds without exposing them publicly."""
    configured_limits = {
        "SCAN_ERROR_DETAIL_LIMIT": "17",
        "SCAN_RECONCILIATION_PAGE_SIZE": "211",
        "SCAN_RECONCILIATION_CONCURRENCY": "3",
        "SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES": "4096",
        "SCAN_CATALOG_WRITE_TIMEOUT_SECONDS": "45.5",
        "SCAN_CATALOG_ERROR_DETAIL_LIMIT": "73",
    }
    for environment_variable_name, value in configured_limits.items():
        monkeypatch.setenv(environment_variable_name, value)

    settings = load_settings(version_file_path)

    assert settings.scan_error_detail_limit == 17
    assert settings.scan_reconciliation_page_size == 211
    assert settings.scan_reconciliation_concurrency == 3
    assert settings.scan_reconciliation_spool_memory_bytes == 4096
    assert settings.scan_catalog_write_timeout_seconds == 45.5
    assert settings.scan_catalog_error_detail_limit == 73
    assert not set(configured_limits).intersection(settings.as_public_dict())


def test_app_closes_every_http_pool_when_lifespan_exits_with_an_error(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Keep connection-pool cleanup unconditional during abnormal shutdown."""

    class ClosingTransport(httpx2.AsyncBaseTransport):
        def __init__(self) -> None:
            self.close_count = 0

        async def handle_async_request(
            self,
            request: httpx2.Request,
        ) -> httpx2.Response:
            raise AssertionError(f"Unexpected request: {request.url}")

        async def aclose(self) -> None:
            self.close_count += 1

    catalog_transport = ClosingTransport()
    geoserver_transport = ClosingTransport()
    diagnostics_transport = ClosingTransport()
    application = create_app(
        version_file_path,
        catalog_transport=catalog_transport,
        geoserver_transport=geoserver_transport,
        geoserver_diagnostics_transport=diagnostics_transport,
    )

    with pytest.raises(RuntimeError, match="lifespan failed"):
        with TestClient(application):
            raise RuntimeError("lifespan failed")

    assert catalog_transport.close_count == 1
    assert geoserver_transport.close_count == 2
    assert diagnostics_transport.close_count == 1


def test_scan_status_is_available_before_first_scan(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Expose an idle scanner state for the browser on initial startup."""
    monkeypatch.setenv("SCAN_BATCH_SIZE", "250")
    response = TestClient(create_app(version_file_path)).get("/api/scans/current")

    assert response.status_code == 200
    assert response.json()["state"] == "not_started"
    assert response.json()["discovered"] == 0
    assert response.json()["workerCount"] == 8
    assert response.json()["writerCount"] == 4
    assert response.json()["batchSize"] == 250
    assert response.json()["reconciliation"] == {
        "state": "not_started",
        "checked": 0,
        "missing": 0,
        "removed": 0,
        "error": None,
    }
    assert response.json()["timing"] == {
        "elapsedSeconds": 0.0,
        "catalogInventorySeconds": 0.0,
        "discoverySeconds": 0.0,
        "metadataResultWaitSeconds": 0.0,
        "metadataWorkerSeconds": 0.0,
        "metadataProcessingSeconds": 0.0,
        "metadataIoWaitSeconds": 0.0,
        "catalogWriteSeconds": 0.0,
        "reconciliationSeconds": 0.0,
        "cacheInvalidationSeconds": 0.0,
    }


@pytest.mark.parametrize(
    "asset_media_type",
    (
        "image/tiff; application=geotiff",
        "image/tiff; application=geotiff; profile=cloud-optimized",
    ),
    ids=("geotiff", "cog"),
)
def test_catalog_geotiff_is_published_idempotently(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
    asset_media_type: str,
) -> None:
    """Resolve STAC server-side and reuse one deterministic GeoServer layer.

    Args:
        configured_environment: Applied baseline application environment.
        monkeypatch: Environment mutation fixture for the scan mount.
        tmp_path: Temporary directory containing the controlled raster.
        version_file_path: Baked application-version fixture path.
        asset_media_type: GeoTIFF or COG Asset media type under test.

    Returns:
        None.
    """
    source_path = tmp_path / "nested" / "raster with spaces.tif"
    _write_geotiff(source_path)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri(), asset_media_type)
    item["bbox"] = [
        -180.000823370733,
        -90.0004116853666,
        180.000823370733,
        90.0004116853666,
    ]
    resource_name = TEST_GEOTIFF_ITEM_ID
    publication_mock = GeoServerPublicationMock(resource_name)

    def upstream_response(request: httpx2.Request) -> httpx2.Response:
        """Return the controlled catalog or GeoServer response.

        Args:
            request: Upstream request issued by the application.

        Returns:
            Catalog Item or stateful GeoServer publication response.

        Raises:
            AssertionError: If authorization or a mutation contract differs.
        """
        if request.url.host == "stac-api":
            assert request.url.path == (
                "/collections/eolab-mounted-geotiffs/items/"
                + TEST_GEOTIFF_ITEM_ID
            )
            assert "authorization" not in request.headers
            return httpx2.Response(200, json=item)

        expected_authorization = "Basic " + base64.b64encode(
            b"eolab:valid-admin-password"
        ).decode()
        assert request.headers["authorization"] == expected_authorization
        external_geotiff_path = (
            "/geoserver/rest/workspaces/eolab/coveragestores/"
            f"{resource_name}/external.geotiff"
        )
        layer_path = f"/geoserver/rest/workspaces/eolab/layers/{resource_name}"
        response = publication_mock(request)
        if request.url.path == external_geotiff_path:
            assert request.method == "PUT"
            assert request.headers["accept"] == "application/json"
            assert request.headers["content-type"] == "text/plain"
            assert request.url.params["configure"] == "first"
            assert request.url.params["coverageName"] == resource_name
            assert request.content.decode() == source_path.resolve().as_uri()
        if request.url.path == f"{layer_path}.xml":
            assert request.method == "PUT"
            assert request.headers["content-type"] == "application/xml"
            assert b"<name>dynamic-raster</name>" in request.content
            assert b"<workspace>eolab</workspace>" in request.content
        return response

    with TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(upstream_response),
            geoserver_transport=httpx2.MockTransport(upstream_response),
        )
    ) as client:
        first_response = client.post(
            "/api/rendering/layers",
            json={
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
            },
        )
        repeated_response = client.post(
            "/api/rendering/layers",
            json={
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
            },
        )

    expected_response = {
        "layerName": f"eolab:{resource_name}",
        "bbox": item["bbox"],
    }
    assert first_response.status_code == 200
    assert first_response.json() == expected_response
    assert repeated_response.json() == expected_response
    mutation_requests = [
        request
        for request in publication_mock.requests
        if request.method != "GET"
    ]
    assert [request.method for request in mutation_requests] == ["PUT"] * 5
    assert len({request.url.path for request in mutation_requests}) == 3


@pytest.mark.parametrize(
    "request_body",
    (
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-id",
            "href": "file:///etc/passwd",
        },
        {"collectionId": "eolab-mounted-vectors", "itemId": "vector-id"},
        {"collectionId": 1, "itemId": "geotiff-id"},
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "../geotiff?item#fragment",
        },
        {
            "collection_id": "eolab-mounted-geotiffs",
            "item_id": "geotiff-0123456789abcdef01234567",
        },
    ),
)
def test_raster_actions_reject_browser_paths_and_unsupported_items(
    configured_environment: None,
    version_file_path: Path,
    request_body: dict[str, object],
) -> None:
    """Reject invalid public input before making any upstream request."""
    upstream_request = AsyncMock()
    client = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(upstream_request),
            geoserver_transport=httpx2.MockTransport(upstream_request),
        )
    )

    response = client.post("/api/rendering/layers", json=request_body)

    assert response.status_code == 422
    upstream_request.assert_not_awaited()


@pytest.mark.parametrize(
    "asset_location",
    ("remote", "outside", "traversal"),
)
def test_raster_publication_rejects_assets_outside_the_scan_mount(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
    asset_location: str,
) -> None:
    """Never let a catalog record expand GeoServer's filesystem boundary."""
    scan_mount_path = tmp_path / "scan-source"
    scan_mount_path.mkdir()
    outside_path = tmp_path / "outside.tif"
    outside_path.write_bytes(b"outside")
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(scan_mount_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    asset_hrefs = {
        "remote": "https://example.test/raster.tif",
        "outside": outside_path.as_uri(),
        "traversal": f"{scan_mount_path.as_uri()}/../outside.tif",
    }
    item = _mounted_geotiff_item(asset_hrefs[asset_location])
    geoserver_requests = []

    def catalog_response(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=item)

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        geoserver_requests.append(request)
        return httpx2.Response(500)

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ).post(
        "/api/rendering/layers",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
        },
    )

    assert response.status_code == 422
    assert geoserver_requests == []


def test_raster_publication_rejects_a_mismatched_catalog_item(
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Require the authoritative STAC response to match the requested Item."""
    item = _mounted_geotiff_item("file:///scan-source/raster.tif")
    item["id"] = "geotiff-abcdef0123456789abcdef01"
    geoserver_requests = []

    def catalog_response(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=item)

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        geoserver_requests.append(request)
        return httpx2.Response(500)

    response = TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ).post(
        "/api/rendering/layers",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
        },
    )

    assert response.status_code == 502
    assert geoserver_requests == []


def test_pixel_probe_samples_catalog_raster_without_geoserver(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Read value, nodata, and bounds without a rendering dependency.

    Args:
        configured_environment: Applied baseline application environment.
        monkeypatch: Environment mutation fixture for the scan mount.
        tmp_path: Temporary directory containing the controlled raster.
        version_file_path: Baked application-version fixture path.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    with rasterio.open(
        source_path,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="uint8",
        nodata=255,
        crs="EPSG:3857",
        transform=from_origin(-100_000, 100_000, 100_000, 100_000),
    ) as dataset:
        dataset.write(
            numpy.array([[12, 255], [34, 56]], dtype="uint8"),
            1,
        )
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri())
    geoserver_requests: list[httpx2.Request] = []

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        """Return the controlled catalog Item.

        Args:
            request: Upstream request issued by the application.

        Returns:
            Authoritative scanner-owned Item.
        """
        assert request.url.host == "stac-api"
        return httpx2.Response(200, json=item)

    def geoserver_response(request: httpx2.Request) -> httpx2.Response:
        """Record any forbidden pixel dependency on GeoServer.

        Args:
            request: Unexpected GeoServer request.

        Returns:
            Controlled unavailable response.
        """
        geoserver_requests.append(request)
        return httpx2.Response(503)

    request_identity = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": TEST_GEOTIFF_ITEM_ID,
    }
    with TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(catalog_response),
            geoserver_transport=httpx2.MockTransport(geoserver_response),
        )
    ) as client:
        value_response = client.post(
            "/api/raster-analysis/pixels",
            json={**request_identity, "longitude": -0.5, "latitude": 0.5},
        )
        nodata_response = client.post(
            "/api/raster-analysis/pixels",
            json={**request_identity, "longitude": 0.5, "latitude": 0.5},
        )
        outside_response = client.post(
            "/api/raster-analysis/pixels",
            json={**request_identity, "longitude": 10, "latitude": 10},
        )

    assert geoserver_requests == []
    assert value_response.status_code == 200
    assert value_response.json() == {
        "longitude": -0.5,
        "latitude": 0.5,
        "row": 0,
        "column": 0,
        "inBounds": True,
        "value": 12.0,
    }
    assert nodata_response.json() == {
        "longitude": 0.5,
        "latitude": 0.5,
        "row": 0,
        "column": 1,
        "inBounds": True,
        "value": None,
    }
    assert outside_response.json() == {
        "longitude": 10.0,
        "latitude": 10.0,
        "row": None,
        "column": None,
        "inBounds": False,
        "value": None,
    }


def test_raster_statistics_sample_a_projected_catalog_raster(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Analyze a prepared projected source without consulting GeoServer.

    Args:
        configured_environment: Applied baseline application environment.
        monkeypatch: Environment mutation fixture for the scan mount.
        tmp_path: Temporary directory containing the controlled raster.
        version_file_path: Baked application-version fixture path.

    Returns:
        None.
    """
    source_path = tmp_path / "projected.tif"
    aoi_path = tmp_path / "sampling-area.gpkg"
    with rasterio.open(
        source_path,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="int16",
        crs="EPSG:3857",
        transform=from_origin(-100_000, 100_000, 100_000, 100_000),
    ) as dataset:
        dataset.write(
            numpy.array([[10, 20], [30, 40]], dtype="int16"),
            1,
        )
    with fiona.open(
        aoi_path,
        mode="w",
        driver="GPKG",
        layer="left-half",
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": {}},
    ) as dataset:
        dataset.write({
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    (-2, -2),
                    (0, -2),
                    (0, 2),
                    (-2, 2),
                    (-2, -2),
                ]],
            },
            "properties": {},
        })
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", '["."]')
    item = _mounted_geotiff_item(source_path.as_uri())
    from eolab_app.catalog.geopackage import build_stac_items

    vector_item = build_stac_items(tmp_path, aoi_path)[0]
    geoserver_requests: list[httpx2.Request] = []

    def upstream_response(request: httpx2.Request) -> httpx2.Response:
        """Return the Item and fail any forbidden GeoServer dependency.

        Args:
            request: Upstream request issued by the application.

        Returns:
            Catalog Item or a controlled unavailable GeoServer response.
        """
        if request.url.host == "stac-api":
            return httpx2.Response(
                200,
                json=(
                    vector_item
                    if "/eolab-mounted-vectors/" in request.url.path
                    else item
                ),
            )
        geoserver_requests.append(request)
        return httpx2.Response(503)

    request_identity = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": TEST_GEOTIFF_ITEM_ID,
    }
    with TestClient(
        create_app(
            version_file_path,
            catalog_transport=httpx2.MockTransport(upstream_response),
            geoserver_transport=httpx2.MockTransport(upstream_response),
        )
    ) as client:
        response = client.post(
            "/api/raster-analysis/statistics",
            json=request_identity,
        )
        selected_response = client.post(
            "/api/raster-analysis/statistics",
            json={
                **request_identity,
                "selectedBounds": {
                    "west": -2,
                    "south": -2,
                    "east": 0,
                    "north": 2,
                },
            },
        )
        outside_response = client.post(
            "/api/raster-analysis/statistics",
            json={
                **request_identity,
                "selectedBounds": {
                    "west": 10,
                    "south": 10,
                    "east": 11,
                    "north": 11,
                },
            },
        )
        selected = client.post(
            "/api/vector-sampling/areas",
            json={
                "collectionId": vector_item["collection"],
                "itemId": vector_item["id"],
                "filter": {"enabled": True, "match": "all", "rules": []},
            },
        )
        assert selected.status_code == 200, selected.text
        catalog_selection = selected.json()["selection"]
        aoi_response = client.post(
            "/api/raster-analysis/statistics",
            json={
                **request_identity,
                "catalogSelection": catalog_selection,
            },
        )
        with aoi_path.open("ab") as source:
            source.write(b"changed")
        removed_aoi_response = client.post(
            "/api/raster-analysis/statistics",
            json={
                **request_identity,
                "catalogSelection": catalog_selection,
            },
        )

    assert geoserver_requests == []
    assert response.status_code == 200
    response_document = response.json()
    assert response_document == {
        "band": 1,
        "scope": "wholeRaster",
        "selectedBounds": None,
        "sourceWidth": 2,
        "sourceHeight": 2,
        "sourcePixelCount": 4,
        "sampleWidth": 2,
        "sampleHeight": 2,
        "sampledPixelCount": 4,
        "validSampleCount": 4,
        "samplingMethod": "exactSourceWindow",
        "estimated": False,
        "sampleMinimum": 10.0,
        "sampleMaximum": 40.0,
        "percentiles": {"p05": 11.5, "p50": 25.0, "p95": 38.5},
        "histogram": response_document["histogram"],
        "suggestedRange": {
            "minimum": 11.5,
            "midpoint": 25.0,
            "maximum": 38.5,
        },
    }
    assert len(response_document["histogram"]["counts"]) == 64
    assert len(response_document["histogram"]["edges"]) == 65
    assert sum(response_document["histogram"]["counts"]) == 4

    assert selected_response.status_code == 200
    selected_document = selected_response.json()
    assert selected_document == {
        "band": 1,
        "scope": "selectedArea",
        "selectedBounds": {
            "west": -2.0,
            "south": -2.0,
            "east": 0.0,
            "north": 2.0,
        },
        "sourceWidth": 2,
        "sourceHeight": 2,
        "sourcePixelCount": 4,
        "sampleWidth": 2,
        "sampleHeight": 2,
        "sampledPixelCount": 4,
        "validSampleCount": 2,
        "samplingMethod": "exactSourceWindow",
        "estimated": False,
        "sampleMinimum": 10.0,
        "sampleMaximum": 30.0,
        "percentiles": {"p05": 11.0, "p50": 20.0, "p95": 29.0},
        "histogram": selected_document["histogram"],
        "suggestedRange": {
            "minimum": 11.0,
            "midpoint": 20.0,
            "maximum": 29.0,
        },
    }
    assert sum(selected_document["histogram"]["counts"]) == 2

    assert aoi_response.status_code == 200
    aoi_document = aoi_response.json()
    assert aoi_document["scope"] == "catalogSelection"
    assert aoi_document["selectedBounds"] is None
    assert aoi_document["catalogSelection"] == catalog_selection
    assert aoi_document["sampleMinimum"] == 10.0
    assert aoi_document["sampleMaximum"] == 30.0
    assert sum(aoi_document["histogram"]["counts"]) == 2

    assert removed_aoi_response.status_code == 409
    assert "identity changed" in removed_aoi_response.json()["detail"]

    assert outside_response.status_code == 409
    assert outside_response.json() == {
        "detail": "The selected area does not overlap the raster"
    }


@pytest.mark.parametrize(
    ("service_method", "request_path", "request_document"),
    (
        (
            "get",
            "/api/raster-analysis/statistics",
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
            },
        ),
        (
            "get_paired",
            "/api/raster-analysis/paired-statistics",
            {
                "xRaster": {
                    "collectionId": "eolab-mounted-geotiffs",
                    "itemId": TEST_GEOTIFF_ITEM_ID,
                },
                "yRaster": {
                    "collectionId": "eolab-mounted-geotiffs",
                    "itemId": "geotiff-abcdef0123456789abcdef01",
                },
            },
        ),
    ),
    ids=("single-raster", "paired-rasters"),
)
def test_raster_statistics_disconnect_cancels_the_service_waiter(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
    service_method: str,
    request_path: str,
    request_document: dict[str, object],
) -> None:
    """Discard queued statistics work when an aborted fetch disconnects.

    Args:
        configured_environment: Fixture configuring all application providers.
        monkeypatch: Fixture replacing the real bounded statistics service.
        version_file_path: Controlled application version file.
        service_method: Service method owned by the requested endpoint.
        request_path: Raster-analysis endpoint under test.
        request_document: Valid catalog-identity request document.

    Returns:
        None after asserting route-level cancellation behavior.
    """

    class BlockingStatisticsService:
        """Expose route cancellation through either statistics method.

        Attributes:
            started: Signal set when the expected service method begins.
            canceled: Signal set when request cancellation reaches the method.
        """

        def __init__(self) -> None:
            """Create route-observation and cancellation signals."""
            self.started = asyncio.Event()
            self.canceled = asyncio.Event()

        async def _block(self, method: str) -> None:
            """Block the expected route method until its task is canceled.

            Args:
                method: Name of the service method invoked by the route.

            Returns:
                None if the controlled request were allowed to finish.

            Raises:
                AssertionError: If the endpoint invokes the wrong service API.
                asyncio.CancelledError: When the browser disconnects.
            """
            assert method == service_method
            self.started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.canceled.set()
                raise

        async def get(self, _request: object) -> None:
            """Block one ordinary-statistics request until cancellation.

            Args:
                _request: Validated ordinary-statistics request.

            Returns:
                None if the request were allowed to finish.

            Raises:
                asyncio.CancelledError: When the browser disconnects.
            """
            await self._block("get")

        async def get_paired(self, _request: object) -> None:
            """Block one paired-statistics request until cancellation.

            Args:
                _request: Validated paired-statistics request.

            Returns:
                None if the request were allowed to finish.

            Raises:
                asyncio.CancelledError: When the browser disconnects.
            """
            await self._block("get_paired")

    statistics_service = BlockingStatisticsService()
    monkeypatch.setattr(
        "eolab_app.main.RasterStatisticsService",
        lambda _registry, _read_concurrency, _cache_entries, **_kwargs: (
            statistics_service
        ),
    )
    application = create_app(version_file_path)
    request_body = json.dumps(request_document).encode()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": request_path,
        "raw_path": request_path.encode(),
        "query_string": b"",
        "headers": [
            (b"host", b"testserver"),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(request_body)).encode()),
        ],
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
        "root_path": "",
        "state": {},
    }

    async def exercise_disconnect() -> list[dict[str, object]]:
        """Send an ASGI disconnect while statistics work is pending.

        Returns:
            ASGI response messages emitted after route cancellation.
        """
        request_messages: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        await request_messages.put(
            {
                "type": "http.request",
                "body": request_body,
                "more_body": False,
            }
        )
        response_messages: list[dict[str, object]] = []

        async def receive() -> dict[str, object]:
            """Return the next controlled ASGI request message.

            Returns:
                Request body or disconnect message queued by this test.
            """
            return await request_messages.get()

        async def send(message: dict[str, object]) -> None:
            """Record one ASGI response message.

            Args:
                message: Response message emitted by the application.

            Returns:
                None after recording the response message.
            """
            response_messages.append(message)

        async with application.router.lifespan_context(application):
            request_task = asyncio.create_task(
                application(scope, receive, send)
            )
            await asyncio.wait_for(statistics_service.started.wait(), 1)
            await request_messages.put({"type": "http.disconnect"})
            await asyncio.wait_for(request_task, 1)
        return response_messages

    response_messages = asyncio.run(exercise_disconnect())

    assert statistics_service.canceled.is_set()
    assert next(
        message["status"]
        for message in response_messages
        if message["type"] == "http.response.start"
    ) == 499


@pytest.mark.parametrize(
    ("request_body", "expected_status"),
    (
        (
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
            },
            502,
        ),
        (
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
                "href": "file:///etc/passwd",
            },
            422,
        ),
        (
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
                "selectedBounds": {
                    "west": 170,
                    "south": -10,
                    "east": -170,
                    "north": 10,
                },
            },
            422,
        ),
        (
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
                "selectedBounds": {
                    "west": -10,
                    "south": 5,
                    "east": 10,
                    "north": 5,
                },
            },
            422,
        ),
        (
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": TEST_GEOTIFF_ITEM_ID,
                "histogramBins": 1_000_000,
            },
            422,
        ),
    ),
)
def test_raster_statistics_require_the_catalog_identity_contract(
    configured_environment: None,
    version_file_path: Path,
    request_body: dict[str, object],
    expected_status: int,
) -> None:
    """Reject unavailable catalog identities and browser-owned read controls."""
    response = TestClient(create_app(version_file_path)).post(
        "/api/raster-analysis/statistics",
        json=request_body,
    )

    assert response.status_code == expected_status


@pytest.mark.parametrize(
    "request_body",
    (
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
            "longitude": 181,
            "latitude": 0,
        },
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
            "longitude": 0,
            "latitude": -91,
        },
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
            "longitude": "0",
            "latitude": 0,
        },
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": TEST_GEOTIFF_ITEM_ID,
            "longitude": 0,
            "latitude": 0,
            "href": "file:///etc/passwd",
        },
        {
            "collectionId": "eolab-mounted-vectors",
            "itemId": TEST_GEOTIFF_ITEM_ID,
            "longitude": 0,
            "latitude": 0,
        },
    ),
)
def test_pixel_probe_rejects_input_outside_its_public_contract(
    configured_environment: None,
    version_file_path: Path,
    request_body: dict[str, object],
) -> None:
    """Accept only mounted-raster identity and finite WGS 84 coordinates."""
    response = TestClient(create_app(version_file_path)).post(
        "/api/raster-analysis/pixels",
        json=request_body,
    )

    assert response.status_code == 422


def test_load_settings_requires_complete_environment(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Reject a deployment that omits a contracted environment variable."""
    monkeypatch.delenv("APP_TITLE")

    with pytest.raises(KeyError, match="APP_TITLE"):
        load_settings(version_file_path)


def test_load_settings_requires_version_file(
    configured_environment: None,
    tmp_path: Path,
) -> None:
    """Reject a deployment without its baked Git-derived version file."""
    with pytest.raises(FileNotFoundError):
        load_settings(tmp_path / "missing-version")


def test_load_settings_rejects_blank_version(
    configured_environment: None,
    tmp_path: Path,
) -> None:
    """Reject a deployment whose baked version file is blank."""
    blank_version_path = tmp_path / "version"
    blank_version_path.write_text("  \n", encoding="utf-8")

    with pytest.raises(ValueError, match="application version"):
        load_settings(blank_version_path)


@pytest.mark.parametrize(
    ("environment_variable_name", "invalid_value"),
    (
        ("INITIAL_ZOOM", "not-a-number"),
        ("SCAN_WORKER_COUNT", "1.5"),
        ("SCAN_WRITER_COUNT", "1.5"),
        ("SCAN_BATCH_SIZE", "1.5"),
        ("SCAN_ERROR_DETAIL_LIMIT", "1.5"),
        ("SCAN_RECONCILIATION_PAGE_SIZE", "1.5"),
        ("SCAN_RECONCILIATION_CONCURRENCY", "1.5"),
        ("SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES", "1.5"),
        ("SCAN_CATALOG_ERROR_DETAIL_LIMIT", "1.5"),
        ("GEOSERVER_WMS_RENDER_COUNT", "1.5"),
        ("COMPOSITE_TILE_CACHE_BYTES", "1.5"),
        ("RASTER_PIXEL_READ_CONCURRENCY", "1.5"),
        ("RASTER_STATISTICS_READ_CONCURRENCY", "1.5"),
        ("RASTER_STATISTICS_CACHE_ENTRIES", "1.5"),
    ),
)
def test_load_settings_rejects_malformed_number(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    environment_variable_name: str,
    invalid_value: str,
    version_file_path: Path,
) -> None:
    """Reject a numeric setting that cannot be parsed as a number."""
    monkeypatch.setenv(environment_variable_name, invalid_value)

    with pytest.raises(ValueError):
        load_settings(version_file_path)


def test_load_settings_requires_an_existing_absolute_scan_directory(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Reject a missing or relative internal scan mount."""
    monkeypatch.setenv("SCAN_MOUNT_PATH", "relative/path")
    with pytest.raises(ValueError, match="absolute path"):
        load_settings(version_file_path)

    monkeypatch.setenv(
        "SCAN_MOUNT_PATH",
        str((Path.cwd() / "missing-scan-directory").resolve()),
    )
    with pytest.raises(ValueError, match="existing directory"):
        load_settings(version_file_path)


def test_load_settings_rejects_invalid_scan_path_lists(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    version_file_path: Path,
) -> None:
    """Reject malformed, escaping, missing, duplicate, or overlapping paths."""
    (tmp_path / "first" / "nested").mkdir(parents=True)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))

    monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", "not JSON")
    with pytest.raises(ValueError):
        load_settings(version_file_path)

    invalid_path_lists = (
        ('"first"', "JSON array"),
        ("[]", "at least one"),
        (json.dumps([str(tmp_path / "first")]), "relative"),
        ('["../outside"]', "must not contain"),
        ('["missing"]', "existing directories"),
        ('["first", "first"]', "duplicated"),
        ('["first", "first/nested"]', "overlap"),
    )
    for scan_paths, expected_error in invalid_path_lists:
        monkeypatch.setenv("SCAN_PATHS_WITHIN_MOUNT", scan_paths)
        with pytest.raises(ValueError, match=expected_error):
            load_settings(version_file_path)


@pytest.mark.parametrize(
    ("environment_variable_name", "invalid_value"),
    (
        ("INITIAL_LATITUDE", "91"),
        ("INITIAL_LONGITUDE", "-181"),
        ("INITIAL_ZOOM", "23"),
        ("SCAN_WORKER_COUNT", "0"),
        ("SCAN_WRITER_COUNT", "0"),
        ("SCAN_BATCH_SIZE", "0"),
        ("SCAN_ERROR_DETAIL_LIMIT", "0"),
        ("SCAN_RECONCILIATION_PAGE_SIZE", "0"),
        ("SCAN_RECONCILIATION_CONCURRENCY", "0"),
        ("SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES", "0"),
        ("SCAN_CATALOG_WRITE_TIMEOUT_SECONDS", "0"),
        ("SCAN_CATALOG_WRITE_TIMEOUT_SECONDS", "nan"),
        ("SCAN_CATALOG_ERROR_DETAIL_LIMIT", "0"),
        ("GEOSERVER_WMS_RENDER_COUNT", "0"),
        ("COMPOSITE_TILE_CACHE_BYTES", "0"),
        ("RASTER_PIXEL_READ_CONCURRENCY", "0"),
        ("RASTER_STATISTICS_READ_CONCURRENCY", "0"),
        ("RASTER_STATISTICS_CACHE_ENTRIES", "0"),
    ),
)
def test_load_settings_rejects_out_of_range_number(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    environment_variable_name: str,
    invalid_value: str,
    version_file_path: Path,
) -> None:
    """Reject a numeric setting outside its documented range."""
    monkeypatch.setenv(environment_variable_name, invalid_value)

    with pytest.raises(ValueError, match=environment_variable_name):
        load_settings(version_file_path)
