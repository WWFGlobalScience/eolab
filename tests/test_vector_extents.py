"""Verify filtered extent reads across original sources, Jobs and browser boundaries."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from typing import Any
from uuid import uuid4

import fiona
import httpx2
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request
from starlette.responses import Response

from eolab_app.attribute_filter import VectorFilter, ogr_predicate
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import VectorReadLimits
from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.main import create_app
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.vector.catalog import StacVectorCatalog
from eolab_app.vector.extent_jobs import ExtentJobs
from eolab_app.vector.extent_operation import FeatureExtent, SelectionExtentResult
from eolab_app.vector.extents import read_selected_extent
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.sources import MountedVectorResolver
from eolab_jobs.client import JobsClient

from test_outline_jobs import outline_case

TOKEN = "test-outline-" + "a" * 40
EXTENT = {"matched": 1, "bbox": [0.0, 0.0, 4.0, 4.0]}


@pytest.mark.parametrize("case", ["valid", "empty", "wrong-layer"])
def test_registered_extent_reads_original_filtered_features(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    case: str,
) -> None:
    """Measure original coordinates through the registered operation's native runner.

    Args:
        outline_case: HTTP Catalog and mounted polygons used by outline tests too.
        tmp_path: Readable fixture mount, injected only as deployment configuration.
        case: Valid selection, empty predicate, or wrong native layer.
    """
    selection, _, url = outline_case
    if case == "empty":
        selection = selection.model_copy(
            update={
                "filter": VectorFilter(
                    rules=[{"field": "selected", "operator": "eq", "value": 99}]
                )
            }
        )
    if case == "wrong-layer":
        selection = selection.model_copy(update={"layerName": "other"})
    descriptor = selection.model_dump(mode="json", by_alias=True)
    command = (
        "from pathlib import Path; from eolab_app.vector import extent_operation as op; "
        f"op.CATALOG_URL={url!r}; op.SCAN_MOUNT=Path({str(tmp_path)!r}); "
        "from job_service.runner import main; main()"
    )
    result = subprocess.run(
        [sys.executable, "-c", command],
        cwd=Path(__file__).parents[1] / "services/jobs",
        input=json.dumps(
            {
                "operation": "vector.selection-extent.v1",
                "inputs": {
                    "selection": descriptor,
                },
            }
        ).encode(),
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr.decode()
    reply = json.loads(result.stdout)
    if case == "wrong-layer":
        assert reply["ok"]
        assert reply["value"]["extent"] is None
        assert "identity changed" in reply["value"]["error"]
    elif case == "empty":
        assert reply["ok"]
        assert reply["value"]["extent"] == {"matched": 0, "bbox": None}
        assert reply["value"]["error"] is None
    else:
        measured = SelectionExtentResult.model_validate(reply["value"])
        assert measured.error is None
        assert measured.extent.model_dump(mode="json") == EXTENT
        assert "geometry" not in reply["value"]


@pytest.mark.parametrize(
    "outcome",
    [
        "success",
        "empty",
        "full",
        "unauthorized",
        "restart",
        "expired",
        "timed_out",
        "failed",
    ],
)
def test_application_reads_extent_only_through_jobs(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    configured_environment: None,
    version_file_path: Path,
    outcome: str,
) -> None:
    """Preserve public selection results and errors through real app composition.

    Args:
        outline_case: Real authorized source and HTTP Catalog.
        tmp_path: Mounted fixture root.
        monkeypatch: Isolated app deployment settings.
        configured_environment: Complete application environment.
        version_file_path: Application version fixture.
        outcome: Jobs completion, rejection, or lifecycle failure.
    """
    selection, _, catalog_url = outline_case
    monkeypatch.setenv("CATALOG_INTERNAL_URL", catalog_url)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    job_id = str(uuid4())
    calls: list[httpx2.Request] = []

    def respond(request: httpx2.Request) -> httpx2.Response:
        """Return Jobs protocol responses without replacing application logic.

        Args:
            request: Authenticated request to the internal Jobs host.

        Returns:
            Controlled lifecycle state or operation result.
        """
        calls.append(request)
        assert request.url.host == "jobs"
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        if outcome in {"full", "unauthorized"}:
            return httpx2.Response(503 if outcome == "full" else 401)
        if request.method == "DELETE":
            return httpx2.Response(204)
        if outcome == "restart" and request.method == "GET":
            return httpx2.Response(404)
        if request.url.path.endswith("/result"):
            value = (
                {"extent": {"matched": 0, "bbox": None}}
                if outcome == "empty"
                else {"extent": EXTENT}
            )
            return httpx2.Response(200, json={"jobId": job_id, "value": value})
        status = (
            outcome if outcome in {"expired", "timed_out", "failed"} else "succeeded"
        )
        return httpx2.Response(202, json={"jobId": job_id, "status": status})

    def reject_rendering(request: httpx2.Request) -> httpx2.Response:
        """Reject any dependency on WMS publication while measuring source bounds.

        Args:
            request: Unexpected GeoServer request.

        Raises:
            AssertionError: Always, because original-source zoom needs no renderer.
        """
        raise AssertionError(f"Vector extent contacted rendering: {request.url}")

    app = create_app(
        version_file_path,
        jobs_transport=httpx2.MockTransport(respond),
        geoserver_transport=httpx2.MockTransport(reject_rendering),
    )
    with TestClient(app) as browser:
        response = browser.post(
            "/api/vector-sampling/extent",
            json={
                "collectionId": selection.collection_id,
                "itemId": selection.item_id,
                "filter": selection.filter.model_dump(mode="json"),
            },
        )
    payload = json.loads(calls[0].content)
    assert payload["operation"] == "vector.selection-extent.v1"
    assert payload["inputs"] == {
        "selection": selection.model_dump(mode="json", by_alias=True),
        "uploadOwner": None,
    }
    assert payload["priority"] > -10
    assert payload["executionTimeoutSeconds"] == 15
    assert payload["queueTimeoutSeconds"] == 30
    assert TOKEN not in response.text and str(tmp_path) not in response.text
    if outcome in {"success", "empty"}:
        assert response.status_code == 200, response.text
        assert response.json() == (
            EXTENT if outcome == "success" else {"matched": 0, "bbox": None}
        )
        assert calls[-1].method == "DELETE"
    else:
        assert response.status_code == 409, response.text
        expected = {
            "empty": "No matching",
            "full": "busy or unavailable",
            "unauthorized": "unavailable",
            "restart": "unavailable",
            "expired": "waited too long",
            "timed_out": "time budget",
            "failed": "could not be read",
        }[outcome]
        assert expected in response.text


@pytest.mark.parametrize("status", ["queued", "running"])
def test_route_disconnect_cancels_only_its_extent(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    status: str,
) -> None:
    """Propagate the route's disconnect to the exact admitted Jobs identity.

    Args:
        outline_case: Real catalog descriptor and source.
        tmp_path: Fixture source mount.
        status: State when the browser connection is lost.
    """
    selection, _, url = outline_case

    async def scenario() -> None:
        """Disconnect during admission, then verify cancellation and deletion."""
        admitted, disconnected, release = (
            asyncio.Event(),
            asyncio.Event(),
            asyncio.Event(),
        )
        job_id = str(uuid4())
        calls: list[tuple[str, str]] = []

        async def respond(request: httpx2.Request) -> httpx2.Response:
            """Keep the admission response in flight until the browser leaves.

            Args:
                request: Jobs lifecycle request.

            Returns:
                The admitted job or its cancellation acknowledgement.
            """
            calls.append((request.method, request.url.path))
            if request.url.path == "/api/jobs":
                admitted.set()
                await release.wait()
                return httpx2.Response(202, json={"jobId": job_id, "status": status})
            if request.url.path.endswith("/cancel"):
                return httpx2.Response(
                    200, json={"jobId": job_id, "status": "cancelled"}
                )
            return httpx2.Response(204)

        async def receive() -> dict[str, Any]:
            """Wait for the browser disconnect message.

            Returns:
                The ASGI disconnect event.
            """
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async with (
            httpx2.AsyncClient() as catalog_http,
            httpx2.AsyncClient(transport=httpx2.MockTransport(respond)) as job_http,
        ):
            service = VectorSamplingService(
                StacVectorCatalog(catalog_http, url),
                MountedVectorResolver(tmp_path),
                extent_executor=ExtentJobs(JobsClient(job_http, TOKEN)),
            )
            router = create_vector_sampling_router(service)
            endpoint = next(
                route.endpoint
                for route in router.routes
                if route.path.endswith("/extent")
            )
            task = asyncio.create_task(
                endpoint(
                    CatalogVectorFilterRequest(
                        collectionId=selection.collection_id,
                        itemId=selection.item_id,
                        filter=selection.filter,
                    ),
                    Request({"type": "http"}, receive),
                    Response(),
                )
            )
            await asyncio.wait_for(admitted.wait(), 5)
            disconnected.set()
            release.set()
            from fastapi import HTTPException

            with pytest.raises(HTTPException) as failure:
                await asyncio.wait_for(task, 5)
            assert failure.value.status_code == 499
        assert calls[-2:] == [
            ("POST", f"/api/jobs/{job_id}/cancel"),
            ("DELETE", f"/api/jobs/{job_id}"),
        ]

    asyncio.run(scenario())
