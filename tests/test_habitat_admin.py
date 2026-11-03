"""Inspect Habitat input coverage through authenticated, path-free HTTP requests."""

import asyncio
from base64 import b64encode
from collections.abc import Callable
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from shapely.geometry import Point, box, mapping
from starlette.types import ASGIApp, Message, Scope

from catalog_selection_support import FixtureCatalog, write_selection
from eolab_app.attribute_filter import VectorFilter
from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.execution.bounded_process import ProcessDeadlineError
from eolab_app.main import create_app
from eolab_app.processing.habitat_earth_engine import (
    HabitatCacheCoverage,
    load_habitat_stack,
)
from eolab_app.routes.habitat_admin import create_habitat_admin_router
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sampling import VectorSamplingService

PASSWORD = "test-habitat-admin-password"
API = "/api/admin/habitat/cache-coverage"
ADMIN_HEADERS = {"X-EOLab-Admin": "1"}


@pytest.fixture
def source(tmp_path: Path) -> ResolvedCatalogSelection:
    """Write two separated polygons inside distinct acquisition tiles.

    Args:
        tmp_path: Isolated directory for the original mounted GeoPackage.

    Returns:
        Unfiltered catalog descriptor for tiles 0_0 and 3_0 on the original grid.
    """
    grid = load_habitat_stack(2018).grid
    span = grid.pixel_size_meters * grid.tile_size_pixels
    geometries = [
        mapping(
            box(
                grid.origin_x + (column + 0.25) * span,
                grid.origin_y - 0.75 * span,
                grid.origin_x + (column + 0.75) * span,
                grid.origin_y - 0.25 * span,
            )
        )
        for column in (0, 3)
    ]
    return write_selection(
        tmp_path / "habitat-areas.gpkg",
        geometries,
        crs=grid.crs,
        values=[1, 2],
    )


def _create_client(
    source: ResolvedCatalogSelection,
    cache_directory: Path,
    password: str = PASSWORD,
) -> TestClient:
    """Build the real admin router with native fixture source authorization.

    Args:
        source: Mounted GeoPackage and public selection issued by the catalog.
        cache_directory: Existing or absent persistent Habitat cache.
        password: Configured admin password, or blank to disable administration.

    Returns:
        HTTP client whose requests still require administrator credentials.
    """
    catalog = FixtureCatalog(
        ResolvedVectorSource("mounted", "geopackage", source.path, "data", "polygons")
    )
    selections = VectorSamplingService(catalog, catalog)
    app = FastAPI()
    app.include_router(
        create_habitat_admin_router(selections, cache_directory, password)
    )
    return TestClient(app)


def _request_body(source: ResolvedCatalogSelection, year: int = 2018) -> dict[str, Any]:
    """Capture the public catalog descriptor and requested assessment year.

    Args:
        source: Authorized fixture selection whose private path is excluded.
        year: Source year to inspect without downloading inputs.

    Returns:
        JSON-compatible request containing only the selection and year.
    """
    return {
        "selection": source.selection.model_dump(mode="json", by_alias=True),
        "year": year,
    }


def _start_admin_request(
    application: ASGIApp, payload: dict[str, Any]
) -> tuple[asyncio.Task[None], asyncio.Queue[Message], list[Message], asyncio.Event]:
    """Start an authenticated ASGI request whose connection can be disconnected.

    Args:
        application: Application exposing the production cache-inspection route.
        payload: Public catalog selection and assessment year.

    Returns:
        Running request, incoming messages, captured responses and an event set
        when the route begins monitoring the connection after reading its body.
    """
    messages: asyncio.Queue[Message] = asyncio.Queue()
    messages.put_nowait(
        {
            "type": "http.request",
            "body": json.dumps(payload).encode(),
            "more_body": False,
        }
    )
    responses: list[Message] = []
    monitoring_disconnect = asyncio.Event()
    body_delivered = False

    async def receive() -> Message:
        """Deliver the body, then permit explicit client-disconnect messages.

        Returns:
            Next body or disconnect message supplied by the test.
        """
        nonlocal body_delivered
        if body_delivered:
            monitoring_disconnect.set()
        message = await messages.get()
        body_delivered = True
        return message

    async def send(message: Message) -> None:
        """Capture responses sent by the real HTTP route.

        Args:
            message: Response headers or body sent by the ASGI application.
        """
        responses.append(message)

    scope: Scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": API,
        "query_string": b"",
        "headers": [
            (b"content-type", b"application/json"),
            (b"x-eolab-admin", b"1"),
            (b"authorization", b"Basic " + b64encode(f"admin:{PASSWORD}".encode())),
        ],
    }
    task = asyncio.create_task(application(scope, receive, send))
    return task, messages, responses, monitoring_disconnect


def test_filtered_source_reports_exact_cold_partial_and_warm_coverage(
    source: ResolvedCatalogSelection, tmp_path: Path
) -> None:
    """Count exact selected polygons and trust published tiles without pixel reads.

    Args:
        source: Two separated native polygons whose bounding box spans four tiles.
        tmp_path: Isolated initially absent cache directory.
    """
    cache_directory = tmp_path / "habitat-cache"
    configuration = load_habitat_stack(2018)
    identity = configuration.raster_configuration_sha256
    client = _create_client(source, cache_directory)
    client.auth = ("admin", PASSWORD)
    payload = _request_body(source)
    expected = {
        "configurationSha256": identity,
        "year": 2018,
        "requiredTiles": 2,
        "cachedTiles": 0,
        "missingTiles": 2,
    }

    response = client.post(API, json=payload, headers=ADMIN_HEADERS)
    assert response.status_code == 200, response.text
    assert response.json() == expected
    assert response.headers["cache-control"] == "private, no-store"
    assert not cache_directory.exists()

    tile = cache_directory / identity / "0_0"
    tile.mkdir(parents=True)
    (tile / "tile.tif").write_bytes(
        b"Published pixels must not be opened by inspection."
    )
    response = client.post(API, json=payload, headers=ADMIN_HEADERS)
    assert response.status_code == 200, response.text
    assert response.json() == {**expected, "cachedTiles": 1, "missingTiles": 1}

    payload["selection"]["filter"] = VectorFilter(
        rules=[{"field": "selected", "operator": "eq", "value": 1}]
    ).model_dump(mode="json")
    response = client.post(API, json=payload, headers=ADMIN_HEADERS)
    assert response.status_code == 200, response.text
    assert response.json() == {
        **expected,
        "requiredTiles": 1,
        "cachedTiles": 1,
        "missingTiles": 0,
    }
    assert str(tmp_path) not in response.text

    tile = cache_directory / identity / "3_0"
    tile.mkdir()
    (tile / "tile.tif").write_bytes(
        b"The other immutable tile also needs no pixel read."
    )
    response = client.post(API, json=_request_body(source), headers=ADMIN_HEADERS)
    assert response.status_code == 200, response.text
    assert response.json() == {**expected, "cachedTiles": 2, "missingTiles": 0}


@pytest.mark.parametrize(
    "password,credentials,expected",
    [
        ("", ("admin", PASSWORD), 404),
        (PASSWORD, None, 401),
        (PASSWORD, ("admin", "incorrect-password"), 401),
        (PASSWORD, ("contributor", PASSWORD), 401),
    ],
)
def test_cache_coverage_requires_configured_admin_credentials(
    source: ResolvedCatalogSelection,
    tmp_path: Path,
    password: str,
    credentials: tuple[str, str] | None,
    expected: int,
) -> None:
    """Keep disabled and unauthorized cache inspection private.

    Args:
        source: Valid source that must not be read without admin access.
        tmp_path: Isolated cache parent.
        password: Configured or disabled administration.
        credentials: Supplied HTTP Basic credentials, if any.
        expected: Authentication or disabled-route response status.
    """
    cache_directory = tmp_path / "cache"
    client = _create_client(source, cache_directory, password)
    response = client.post(
        API,
        json=_request_body(source),
        headers=ADMIN_HEADERS,
        auth=credentials,
    )
    assert response.status_code == expected
    assert response.headers["cache-control"] == "private, no-store"
    assert not cache_directory.exists()
    if expected == 401:
        assert "Basic" in response.headers["www-authenticate"]


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-EOLab-Admin": "1", "Origin": "https://other.test"},
        {"X-EOLab-Admin": "1", "Sec-Fetch-Site": "cross-site"},
    ],
)
def test_cache_coverage_rejects_cross_origin_requests(
    source: ResolvedCatalogSelection, tmp_path: Path, headers: dict[str, str]
) -> None:
    """Require the existing administrator request protection on inspection POSTs.

    Args:
        source: Valid public fixture descriptor.
        tmp_path: Isolated cache parent.
        headers: Missing custom header or explicit cross-origin browser request.
    """
    client = _create_client(source, tmp_path / "cache")
    response = client.post(
        API, json=_request_body(source), headers=headers, auth=("admin", PASSWORD)
    )
    assert response.status_code == 403
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("year", [2014, 2020])
def test_cache_coverage_rejects_unsupported_years(
    source: ResolvedCatalogSelection, tmp_path: Path, year: int
) -> None:
    """Reject assessment years outside the scientific configuration contract.

    Args:
        source: Valid native vector source.
        tmp_path: Isolated cache parent.
        year: Year immediately outside the packaged supported range.
    """
    cache_directory = tmp_path / "cache"
    client = _create_client(source, cache_directory)
    response = client.post(
        API,
        json=_request_body(source, year),
        headers=ADMIN_HEADERS,
        auth=("admin", PASSWORD),
    )
    assert response.status_code == 422
    assert response.headers["cache-control"] == "private, no-store"
    assert str(tmp_path) not in response.text
    assert not cache_directory.exists()


@pytest.mark.parametrize("field", ["assetKey", "layerName"])
def test_cache_coverage_reauthorizes_catalog_source_identity(
    source: ResolvedCatalogSelection, tmp_path: Path, field: str
) -> None:
    """Reject descriptor identities that differ from the authoritative catalog.

    Args:
        source: Mounted file authorized under its original asset and layer names.
        tmp_path: Isolated cache parent.
        field: Public identity field changed after admission.
    """
    payload = _request_body(source)
    payload["selection"][field] = "different-source"
    client = _create_client(source, tmp_path / "cache")
    response = client.post(
        API, json=payload, headers=ADMIN_HEADERS, auth=("admin", PASSWORD)
    )
    assert response.status_code == 409
    assert response.headers["cache-control"] == "private, no-store"
    assert str(tmp_path) not in response.text


def test_cache_coverage_rejects_empty_filtered_area(
    source: ResolvedCatalogSelection, tmp_path: Path
) -> None:
    """Report an empty exact predicate without inventing tile coverage.

    Args:
        source: Actual catalog polygons with integer selection values 1 and 2.
        tmp_path: Isolated cache parent.
    """
    payload = _request_body(source)
    payload["selection"]["filter"] = VectorFilter(
        rules=[{"field": "selected", "operator": "eq", "value": 999}]
    ).model_dump(mode="json")
    client = _create_client(source, tmp_path / "cache")
    response = client.post(
        API, json=payload, headers=ADMIN_HEADERS, auth=("admin", PASSWORD)
    )
    assert response.status_code == 422
    assert response.headers["cache-control"] == "private, no-store"
    assert str(tmp_path) not in response.text


def test_cache_coverage_rejects_nonpolygon_catalog_features(tmp_path: Path) -> None:
    """Require polygon areas even when a catalog descriptor identifies a real layer.

    Args:
        tmp_path: Isolated point GeoPackage and absent cache directory.
    """
    source = write_selection(tmp_path / "points.gpkg", [mapping(Point(0, 0))])
    client = _create_client(source, tmp_path / "cache")
    response = client.post(
        API,
        json=_request_body(source),
        headers=ADMIN_HEADERS,
        auth=("admin", PASSWORD),
    )
    assert response.status_code == 422
    assert response.headers["cache-control"] == "private, no-store"
    assert str(tmp_path) not in response.text


@pytest.mark.parametrize("kind", ["requestPath", "selectionPath", "upload"])
def test_cache_coverage_accepts_only_path_free_catalog_requests(
    source: ResolvedCatalogSelection, tmp_path: Path, kind: str
) -> None:
    """Reject filesystem paths and private-upload descriptors at the HTTP boundary.

    Args:
        source: Valid public catalog descriptor used as the starting request.
        tmp_path: Isolated private source and cache directories.
        kind: Unsupported extra path or upload descriptor to submit.
    """
    payload = _request_body(source)
    if kind == "requestPath":
        payload["path"] = str(source.path)
    elif kind == "selectionPath":
        payload["selection"]["path"] = str(source.path)
    else:
        payload["selection"] = {
            "uploadId": "090aca16-b62a-4572-b4a4-142853ca6f30",
            "layerName": "polygons",
            "filter": VectorFilter().model_dump(mode="json"),
        }
    client = _create_client(source, tmp_path / "cache")
    response = client.post(
        API, json=payload, headers=ADMIN_HEADERS, auth=("admin", PASSWORD)
    )
    assert response.status_code == 422
    assert response.headers["cache-control"] == "private, no-store"


def test_habitat_cache_admin_route_is_composed_with_private_settings(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Expose the optional route in the full application without public credentials.

    Args:
        configured_environment: Complete isolated application settings.
        version_file_path: Application version fixture.
        monkeypatch: Set and then disable the existing administration password.
    """
    monkeypatch.setenv("ADMIN_PASSWORD", PASSWORD)
    client = TestClient(create_app(version_file_path))
    response = client.post(API, json={}, headers=ADMIN_HEADERS)
    assert response.status_code == 401
    assert response.headers["cache-control"] == "private, no-store"
    assert PASSWORD not in client.get("/api/config").text

    monkeypatch.delenv("ADMIN_PASSWORD")
    disabled = TestClient(create_app(version_file_path))
    response = disabled.post(API, json={}, headers=ADMIN_HEADERS)
    assert response.status_code == 404
    assert response.headers["cache-control"] == "private, no-store"


def test_disconnect_keeps_native_cleanup_serial_and_skips_cancelled_waiters(
    source: ResolvedCatalogSelection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep inspection serialized through cleanup and discard disconnected waiters.

    Args:
        source: Real catalog source retained for authorization before native work.
        tmp_path: Isolated cache parent.
        monkeypatch: Gate native execution while preserving HTTP and adapter wiring.
    """

    async def exercise() -> None:
        """Disconnect active and queued requests, then admit the remaining request."""
        entered = asyncio.Event()
        cleanup_started = asyncio.Event()
        release_cleanup = asyncio.Event()
        cleanup_finished = asyncio.Event()
        native_years: list[int] = []

        async def run_native(
            target: Callable[..., None],
            arguments: tuple[Any, ...],
            timeout_seconds: float | None,
        ) -> tuple[str, HabitatCacheCoverage]:
            """Hold the first native call until cancellation cleanup is released.

            Args:
                target: Production inspection target passed to the execution boundary.
                arguments: Authorized source, assessment year and private cache root.
                timeout_seconds: Production deadline policy, passed through unchanged.

            Returns:
                Coverage for the final request after the first native call stops.

            Raises:
                asyncio.CancelledError: After the first request completes cleanup.
            """
            year = arguments[1]
            native_years.append(year)
            if year == 2018:
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cleanup_started.set()
                    await release_cleanup.wait()
                    cleanup_finished.set()
            assert year == 2019
            assert cleanup_finished.is_set()
            return "ok", HabitatCacheCoverage("a" * 64, year, 2, 0, 2)

        monkeypatch.setattr(
            "eolab_app.processing.habitat_cache.run_bounded_process", run_native
        )
        application = _create_client(source, tmp_path / "cache").app
        active = _start_admin_request(application, _request_body(source, 2018))
        requests = [active]
        try:
            await asyncio.wait_for(entered.wait(), 2)
            queued = _start_admin_request(application, _request_body(source, 2017))
            requests.append(queued)
            await asyncio.wait_for(queued[3].wait(), 2)
            await queued[1].put({"type": "http.disconnect"})
            await asyncio.wait_for(queued[0], 2)
            assert native_years == [2018]

            await active[1].put({"type": "http.disconnect"})
            await asyncio.wait_for(cleanup_started.wait(), 2)
            final = _start_admin_request(application, _request_body(source, 2019))
            requests.append(final)
            await asyncio.wait_for(final[3].wait(), 2)
            assert native_years == [2018]
            assert not active[0].done()
            assert not cleanup_finished.is_set()

            release_cleanup.set()
            await asyncio.wait_for(asyncio.gather(active[0], final[0]), 2)
            assert native_years == [2018, 2019]
            for request, expected_status in (
                (active, 499),
                (queued, 499),
                (final, 200),
            ):
                response = next(
                    message
                    for message in request[2]
                    if message["type"] == "http.response.start"
                )
                assert response["status"] == expected_status
                assert (
                    dict(response["headers"])[b"cache-control"] == b"private, no-store"
                )
        finally:
            release_cleanup.set()
            for request in requests:
                request[0].cancel()
            await asyncio.gather(
                *(request[0] for request in requests), return_exceptions=True
            )

    asyncio.run(exercise())


def test_child_without_result_returns_safe_private_failure(
    source: ResolvedCatalogSelection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Translate a native child exiting without a result into a private HTTP error.

    Args:
        source: Real catalog source authorized before the failed native execution.
        tmp_path: Isolated private source and cache directories.
        monkeypatch: Represent the execution mechanism's child-exit failure.
    """

    async def stopped_without_result(
        target: Callable[..., None],
        arguments: tuple[Any, ...],
        timeout_seconds: float | None,
    ) -> None:
        """Raise the execution boundary's failure without exposing its raw context.

        Args:
            target: Production target supplied to the native supervisor.
            arguments: Authorized native inputs that must remain private.
            timeout_seconds: Caller-owned deadline policy.

        Raises:
            ProcessDeadlineError: Always, representing a child exiting without a result.
        """
        raise ProcessDeadlineError(f"Child exited while reading {source.path}")

    monkeypatch.setattr(
        "eolab_app.processing.habitat_cache.run_bounded_process", stopped_without_result
    )
    client = _create_client(source, tmp_path / "cache")
    response = client.post(
        API,
        json=_request_body(source),
        headers=ADMIN_HEADERS,
        auth=("admin", PASSWORD),
    )
    assert response.status_code == 500
    assert response.json() == {
        "detail": "Cached Habitat inputs could not be checked. Try again later."
    }
    assert response.headers["cache-control"] == "private, no-store"
    assert str(tmp_path) not in response.text
    assert "Child exited" not in response.text
