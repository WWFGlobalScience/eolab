"""Test recoverable raster publication and the GeoServer REST contract."""

import asyncio
import logging
from pathlib import Path

import httpx2
import pytest

from eolab_app.raster.errors import RasterPublicationError
from eolab_app.raster.geoserver import (
    GEOSERVER_ERROR_EXCERPT_LIMIT,
    GeoServerRasterPublisher,
    sanitize_geoserver_error_excerpt,
)
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.publication import RasterPublicationService
from eolab_app.raster.sources import PublishedRasterRegistry, source_signature


RESOURCE_NAME = "geotiff-0123456789abcdef01234567"


class _Catalog:
    """Return one controlled prepared catalog Item.

    Attributes:
        item: Authoritative controlled STAC Item returned by the test port.
    """

    def __init__(self, item: dict[str, object]) -> None:
        """Store the authoritative controlled Item.

        Args:
            item: STAC Item returned from every catalog lookup.

        Returns:
            None.
        """
        self.item = item

    async def get_item(self, request: object) -> dict[str, object]:
        """Return the authoritative controlled Item.

        Args:
            request: Ignored validated request supplied by the service.

        Returns:
            The controlled authoritative STAC Item.
        """
        return self.item


class _Resolver:
    """Return one controlled mounted raster path.

    Attributes:
        source_path: Canonical test path returned by the resolver port.
    """

    def __init__(self, source_path: Path) -> None:
        """Store the controlled mounted raster path.

        Args:
            source_path: Canonical path returned from every resolution.

        Returns:
            None.
        """
        self.source_path = source_path

    def resolve(self, item: object) -> Path:
        """Return the controlled mounted raster path.

        Args:
            item: Ignored authoritative Item supplied by the service.

        Returns:
            The controlled canonical mounted raster path.
        """
        return self.source_path


class _Publisher:
    """Record application-level publication calls.

    Attributes:
        calls: Ordered resource and source paths passed to the port.
    """

    def __init__(self) -> None:
        """Create an empty publication call log.

        Returns:
            None.
        """
        self.calls: list[tuple[str, Path]] = []

    async def publish(self, resource_name: str, source_path: Path) -> None:
        """Record one requested resource and source.

        Args:
            resource_name: Stable rendering resource name.
            source_path: Canonical mounted raster path.

        Returns:
            None.
        """
        self.calls.append((resource_name, source_path))


class _GeoServerScenario:
    """Model the GeoServer resource transitions used by adapter tests.

    Args:
        store_exists: Whether the raster coverage store initially exists.
        coverage_exists: Whether its configured coverage initially exists.
        layer_exists: Whether its WMS layer initially exists.
        create_responses: Optional ordered create statuses and bodies. Each
            failed response creates the observed coverage-store-only state.
        style_responses: Optional ordered style-assignment statuses and bodies.

    Attributes:
        requests: Ordered HTTP requests issued by the adapter.
        store_exists: Current simulated coverage-store existence.
        coverage_exists: Current simulated coverage existence.
        layer_exists: Current simulated layer existence.
    """

    def __init__(
        self,
        *,
        store_exists: bool = False,
        coverage_exists: bool = False,
        layer_exists: bool = False,
        create_responses: list[tuple[int, bytes]] | None = None,
        style_responses: list[tuple[int, bytes]] | None = None,
    ) -> None:
        """Create one stateful mock GeoServer scenario.

        Args:
            store_exists: Whether the raster coverage store initially exists.
            coverage_exists: Whether its configured coverage initially exists.
            layer_exists: Whether its WMS layer initially exists.
            create_responses: Optional ordered create statuses and bodies.
            style_responses: Optional ordered style statuses and bodies.

        Returns:
            None.
        """
        self.store_exists = store_exists
        self.coverage_exists = coverage_exists
        self.layer_exists = layer_exists
        self.create_responses = list(create_responses or [])
        self.style_responses = list(style_responses or [])
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        """Return the exact REST response implied by the current state.

        Args:
            request: GeoServer REST request issued by the adapter.

        Returns:
            Stateful mock GeoServer response.

        Raises:
            AssertionError: If the adapter issues an unexpected REST request.
        """
        self.requests.append(request)
        path = request.url.path
        if request.method == "GET":
            if path.endswith("/workspaces/eolab.json"):
                return httpx2.Response(200)
            if path.endswith("/styles/dynamic-raster.sld"):
                return httpx2.Response(200)
            if "/coverages/" in path:
                return httpx2.Response(200 if self.coverage_exists else 404)
            if path.endswith(f"/layers/{RESOURCE_NAME}.json"):
                return httpx2.Response(200 if self.layer_exists else 404)
            if path.endswith(f"/coveragestores/{RESOURCE_NAME}.json"):
                return httpx2.Response(200 if self.store_exists else 404)
        if request.method == "PUT" and path.endswith("/external.geotiff"):
            if self.create_responses:
                status, body = self.create_responses.pop(0)
                if status != 201:
                    self.store_exists = True
                    self.coverage_exists = False
                    self.layer_exists = False
                    return httpx2.Response(status, content=body)
            self.store_exists = True
            self.coverage_exists = True
            self.layer_exists = True
            return httpx2.Response(201)
        if request.method == "DELETE" and path.endswith(
            f"/coveragestores/{RESOURCE_NAME}"
        ):
            self.store_exists = False
            self.coverage_exists = False
            self.layer_exists = False
            return httpx2.Response(200)
        if request.method == "PUT" and path.endswith(
            f"/layers/{RESOURCE_NAME}.xml"
        ):
            if self.style_responses:
                status, body = self.style_responses.pop(0)
                return httpx2.Response(status, content=body)
            return httpx2.Response(200)
        if request.method == "PUT" and path.endswith(
            f"/gwc/rest/layers/eolab:{RESOURCE_NAME}.xml"
        ):
            return httpx2.Response(200)
        raise AssertionError(f"Unexpected GeoServer request: {request}")


def _catalog_item(source_path: Path) -> dict[str, object]:
    """Build one prepared authoritative Item for service tests.

    Args:
        source_path: Mounted raster path represented by the Item.

    Returns:
        Minimal prepared STAC Item accepted by the publication service.
    """
    return {
        "id": RESOURCE_NAME,
        "bbox": [-123, 48, -122, 49],
        "assets": {
            "data": {
                "href": source_path.as_uri(),
                "eolab:source": {
                    "source_signature": source_signature(
                        source_path
                    ).to_catalog(),
                },
            }
        },
    }


def _catalog_request() -> CatalogRasterRequest:
    """Build the validated request shared by publication service tests.

    Returns:
        Validated mounted-GeoTIFF Collection and Item identity.
    """
    return CatalogRasterRequest.model_validate(
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": RESOURCE_NAME,
        }
    )


async def _publish_adapter(
    scenario: _GeoServerScenario,
    source_path: Path,
) -> None:
    """Run the concrete adapter against one stateful mock GeoServer.

    Args:
        scenario: Stateful GeoServer REST mock.
        source_path: Canonical mounted raster path to publish.

    Returns:
        None after publication succeeds.

    Raises:
        RasterPublicationError: If the controlled scenario rejects an
            operation or exposes an unsafe resource state.
    """
    async with httpx2.AsyncClient(
        transport=httpx2.MockTransport(scenario)
    ) as client:
        adapter = GeoServerRasterPublisher(
            client,
            "http://geoserver:8080/geoserver",
        )
        await adapter.publish(RESOURCE_NAME, source_path)


def test_publication_coordinates_upstream_contract_and_authorization(
    tmp_path: Path,
) -> None:
    """Authorize exactly the source inspected before publication.

    Args:
        tmp_path: Temporary directory containing the controlled source.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
    publisher = _Publisher()
    registry = PublishedRasterRegistry()
    service = RasterPublicationService(
        _Catalog(_catalog_item(source_path)),
        _Resolver(source_path),
        publisher,
        registry,
    )

    result = asyncio.run(service.publish(_catalog_request()))

    assert result.layer_name == f"eolab:{RESOURCE_NAME}"
    assert publisher.calls == [(RESOURCE_NAME, source_path)]
    assert registry.require_current(result.layer_name).source_path == source_path


def test_clean_publication_creates_verifies_and_styles_exactly_once(
    tmp_path: Path,
) -> None:
    """Converge clean resources through create, verification, and style.

    Args:
        tmp_path: Temporary directory containing the controlled source.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
    scenario = _GeoServerScenario()

    asyncio.run(_publish_adapter(scenario, source_path))

    create_requests = [
        request
        for request in scenario.requests
        if request.url.path.endswith("/external.geotiff")
    ]
    style_requests = [
        request
        for request in scenario.requests
        if request.url.path.endswith(f"/layers/{RESOURCE_NAME}.xml")
    ]
    assert len(create_requests) == 1
    assert create_requests[0].content.decode() == source_path.as_uri()
    assert create_requests[0].url.params["configure"] == "first"
    assert create_requests[0].url.params["coverageName"] == RESOURCE_NAME
    assert len(style_requests) == 1
    assert str(style_requests[0].url) == (
        "http://geoserver:8080/geoserver/rest/workspaces/eolab/"
        f"layers/{RESOURCE_NAME}.xml"
    )
    layer_inspections = [
        str(request.url)
        for request in scenario.requests
        if request.url.path.endswith(f"/layers/{RESOURCE_NAME}.json")
    ]
    expected_layer_url = (
        "http://geoserver:8080/geoserver/rest/workspaces/eolab/"
        f"layers/{RESOURCE_NAME}.json?quietOnNotFound=true"
    )
    assert layer_inspections == [expected_layer_url, expected_layer_url]
    assert b"<name>dynamic-raster</name>" in style_requests[0].content
    assert scenario.store_exists
    assert scenario.coverage_exists
    assert scenario.layer_exists


def test_existing_complete_publication_is_preserved_and_restyled(
    tmp_path: Path,
) -> None:
    """Avoid recreating healthy existing resources after an app restart.

    Args:
        tmp_path: Temporary directory containing the controlled source.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
    scenario = _GeoServerScenario(
        store_exists=True,
        coverage_exists=True,
        layer_exists=True,
    )

    asyncio.run(_publish_adapter(scenario, source_path))

    assert not any(
        request.url.path.endswith("/external.geotiff")
        for request in scenario.requests
    )
    assert not any(request.method == "DELETE" for request in scenario.requests)
    assert sum(
        request.url.path.endswith(f"/layers/{RESOURCE_NAME}.xml")
        for request in scenario.requests
    ) == 1


def test_coverage_store_only_state_is_deleted_before_clean_creation(
    tmp_path: Path,
) -> None:
    """Recover the observed partial state without accumulating resources.

    Args:
        tmp_path: Temporary directory containing the controlled source.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
    scenario = _GeoServerScenario(store_exists=True)

    asyncio.run(_publish_adapter(scenario, source_path))

    mutation_methods = [
        request.method
        for request in scenario.requests
        if request.method != "GET"
    ]
    assert mutation_methods == ["DELETE", "PUT", "PUT", "PUT"]
    delete_request = next(
        request for request in scenario.requests if request.method == "DELETE"
    )
    assert delete_request.url.params["recurse"] == "true"
    assert scenario.store_exists
    assert scenario.coverage_exists
    assert scenario.layer_exists


def test_reader_failure_is_categorized_logged_sanitized_and_rolled_back(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Expose an actionable reader error and remove its new orphan store.

    Args:
        tmp_path: Temporary directory containing the controlled source.
        caplog: Captured application logs used to verify diagnostics.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
    reader_response = (
        500,
        (
            b"Could not acquire reader for coverage\n"
            b"file:///scan-source/private/raster.tif "
            b"password=super-secret"
        ),
    )
    scenario = _GeoServerScenario(
        create_responses=[reader_response, reader_response]
    )

    with caplog.at_level(logging.WARNING):
        with pytest.raises(RasterPublicationError) as first_failure:
            asyncio.run(_publish_adapter(scenario, source_path))
        with pytest.raises(RasterPublicationError) as retry_failure:
            asyncio.run(_publish_adapter(scenario, source_path))

    assert first_failure.value.category == "reader_rejection"
    assert retry_failure.value.category == first_failure.value.category
    assert retry_failure.value.detail == first_failure.value.detail
    assert "CRS" in first_failure.value.detail
    assert not scenario.store_exists
    assert not scenario.coverage_exists
    assert not scenario.layer_exists
    log_text = caplog.text
    assert "operation=create external GeoTIFF publication" in log_text
    assert "status=500" in log_text
    assert "Could not acquire reader for coverage" in log_text
    assert "super-secret" not in log_text
    assert "/scan-source/private/raster.tif" not in log_text


@pytest.mark.parametrize(
    ("status", "category"),
    [
        (201, "upstream_failure"),
        (204, "upstream_failure"),
        (401, "authentication"),
        (403, "authentication"),
        (500, "upstream_failure"),
    ],
)
def test_style_failure_preserves_publication_and_retry_only_restyles(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    status: int,
    category: str,
) -> None:
    """Retain healthy resources when styling fails and converge on retry.

    Args:
        tmp_path: Temporary directory containing the controlled source.
        caplog: Captured publication diagnostics.
        status: Rejected style-assignment HTTP status, including other 2xx.
        category: Expected public failure category.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
    scenario = _GeoServerScenario(
        style_responses=[
            (
                status,
                b"style update failed password=style-secret\n"
                b"file:///private/raster.tif",
            ),
            (200, b""),
        ]
    )

    with pytest.raises(RasterPublicationError) as raised:
        asyncio.run(_publish_adapter(scenario, source_path))

    assert raised.value.category == category
    assert "operation=assign raster style" in caplog.text
    assert f"status={status}" in caplog.text
    assert "style-secret" not in caplog.text
    assert "/private/raster.tif" not in caplog.text
    assert scenario.store_exists
    assert scenario.coverage_exists
    assert scenario.layer_exists
    asyncio.run(_publish_adapter(scenario, source_path))
    assert sum(
        request.url.path.endswith("/external.geotiff")
        for request in scenario.requests
    ) == 1
    assert not any(request.method == "DELETE" for request in scenario.requests)
    assert sum(
        request.url.path.endswith(f"/layers/{RESOURCE_NAME}.xml")
        for request in scenario.requests
    ) == 2


def test_app_restart_reauthorizes_existing_complete_publication(
    tmp_path: Path,
) -> None:
    """Rebuild process-local authorization without recreating GeoServer data.

    Args:
        tmp_path: Temporary directory containing the controlled source.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
    scenario = _GeoServerScenario(
        store_exists=True,
        coverage_exists=True,
        layer_exists=True,
    )
    registry = PublishedRasterRegistry()

    async def publish() -> object:
        """Publish through a fresh service and process-local registry.

        Returns:
            Published browser-safe raster model.
        """
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(scenario)
        ) as client:
            service = RasterPublicationService(
                _Catalog(_catalog_item(source_path)),
                _Resolver(source_path),
                GeoServerRasterPublisher(
                    client,
                    "http://geoserver:8080/geoserver",
                ),
                registry,
            )
            return await service.publish(_catalog_request())

    result = asyncio.run(publish())

    assert registry.require_current(result.layer_name).source_path == source_path
    assert not any(
        request.url.path.endswith("/external.geotiff")
        for request in scenario.requests
    )


def test_arbitrary_success_status_is_rejected_by_create_contract(
    tmp_path: Path,
) -> None:
    """Reject an undocumented 202 response instead of assuming success.

    Args:
        tmp_path: Temporary directory containing the controlled source.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
    scenario = _GeoServerScenario(create_responses=[(202, b"accepted")])

    with pytest.raises(RasterPublicationError) as raised:
        asyncio.run(_publish_adapter(scenario, source_path))

    assert raised.value.category == "upstream_failure"
    assert not scenario.store_exists


def test_ambiguous_existing_state_is_preserved_for_inspection(
    tmp_path: Path,
) -> None:
    """Preserve a coverage without its layer instead of deleting it.

    Args:
        tmp_path: Temporary directory containing the controlled source.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
    scenario = _GeoServerScenario(
        store_exists=True,
        coverage_exists=True,
        layer_exists=False,
    )

    with pytest.raises(RasterPublicationError) as raised:
        asyncio.run(_publish_adapter(scenario, source_path))

    assert raised.value.category == "configuration"
    assert not any(
        request.method in {"PUT", "POST", "DELETE"}
        for request in scenario.requests
    )
    assert scenario.store_exists
    assert scenario.coverage_exists


@pytest.mark.parametrize(
    ("exception_type", "expected_category"),
    [
        (httpx2.ConnectError, "connectivity"),
        (httpx2.ReadTimeout, "timeout"),
    ],
)
def test_transport_failures_expose_stable_categories(
    tmp_path: Path,
    exception_type: type[httpx2.RequestError],
    expected_category: str,
) -> None:
    """Distinguish connection and timeout failures without leaking URLs.

    Args:
        tmp_path: Temporary directory containing the controlled source.
        exception_type: Controlled HTTPX transport exception class.
        expected_category: Stable public category expected from the adapter.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")

    def fail_transport(request: httpx2.Request) -> httpx2.Response:
        """Raise the controlled transport failure for every request.

        Args:
            request: GeoServer request receiving the transport failure.

        Raises:
            httpx2.RequestError: Always, using the parameterized subtype.
        """
        raise exception_type("controlled transport failure", request=request)

    async def publish() -> None:
        """Run publication through the failing transport.

        Returns:
            None if publication unexpectedly succeeds.

        Raises:
            RasterPublicationError: Always, after transport classification.
        """
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(fail_transport)
        ) as client:
            await GeoServerRasterPublisher(
                client,
                "http://geoserver:8080/geoserver",
            ).publish(RESOURCE_NAME, source_path)

    with pytest.raises(RasterPublicationError) as raised:
        asyncio.run(publish())

    assert raised.value.category == expected_category


def test_authentication_response_exposes_stable_category(
    tmp_path: Path,
) -> None:
    """Distinguish rejected internal credentials from other upstream errors.

    Args:
        tmp_path: Temporary directory containing the controlled source.

    Returns:
        None.
    """
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")

    def reject_authentication(request: httpx2.Request) -> httpx2.Response:
        """Reject every GeoServer request as unauthorized.

        Args:
            request: Ignored GeoServer request receiving the response.

        Returns:
            Controlled 401 response without credential detail.
        """
        return httpx2.Response(401, content=b"Unauthorized")

    async def publish() -> None:
        """Run publication through the authentication rejection.

        Returns:
            None if publication unexpectedly succeeds.

        Raises:
            RasterPublicationError: Always, after response classification.
        """
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(reject_authentication)
        ) as client:
            await GeoServerRasterPublisher(
                client,
                "http://geoserver:8080/geoserver",
            ).publish(RESOURCE_NAME, source_path)

    with pytest.raises(RasterPublicationError) as raised:
        asyncio.run(publish())

    assert raised.value.category == "authentication"


def test_error_excerpt_is_bounded_single_line_and_redacts_secrets() -> None:
    """Keep response diagnostics safe even for large hostile bodies.

    Returns:
        None.
    """
    excerpt = sanitize_geoserver_error_excerpt(
        (
            b"Authorization: Bearer secret-token\n"
            b"https://admin:password@example.test/path "
            b"file:///scan-source/private/raster.tif "
            b"x" * GEOSERVER_ERROR_EXCERPT_LIMIT
        )
    )

    assert "secret-token" not in excerpt
    assert "admin:password" not in excerpt
    assert "/scan-source/private/raster.tif" not in excerpt
    assert "\n" not in excerpt
    assert len(excerpt) <= GEOSERVER_ERROR_EXCERPT_LIMIT + 1
    assert excerpt.endswith("…")
