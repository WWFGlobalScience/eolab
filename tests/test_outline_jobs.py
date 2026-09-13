"""Exercise Jobs-only outlines across Catalog, native and HTTP boundaries."""

import asyncio
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx2
import fiona
import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Polygon, box, mapping

from eolab_app.catalog.geopackage import build_stac_items
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.vector.catalog import StacVectorCatalog
from eolab_app.vector.filters import CatalogVectorFilterRequest, VectorFilter
from eolab_app.vector.geometry import build_outline
from eolab_app.vector.outline_jobs import OutlineJobs
from eolab_jobs.client import JobsClient
from eolab_app.settings import load_settings
from eolab_app.main import create_app
from eolab_app.vector.outline_operation import OutlineInput
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.sources import MountedVectorResolver
from eolab_app.vector.errors import VectorConflictError


def test_outline_result_display_byte_budget() -> None:
    """Accept the producer's exact byte boundary and reject one extra byte."""
    from eolab_app.vector.display_geometry import MAX_DISPLAY_BYTES
    from eolab_app.vector.outline_operation import (
        MAX_OUTLINE_GEOMETRY_BYTES,
        OutlineResult,
    )

    assert MAX_OUTLINE_GEOMETRY_BYTES == MAX_DISPLAY_BYTES
    geometry = {"type": "FeatureCollection", "features": [], "padding": ""}
    overhead = len(json.dumps(geometry, separators=(",", ":")).encode())
    geometry["padding"] = " " * (MAX_DISPLAY_BYTES - overhead)
    OutlineResult(geometry=geometry, bbox=(0, 0, 1, 1))
    geometry["padding"] += " "
    with pytest.raises(ValueError, match="Invalid bounded outline result"):
        OutlineResult(geometry=geometry, bbox=(0, 0, 1, 1))


@pytest.fixture
def outline_case(tmp_path: Path) -> tuple[CatalogSelection, dict[str, Any], str]:
    """Serve authoritative fixture Catalog metadata beside real filtered polygons."""
    path = tmp_path / "polygons.gpkg"
    geometries = [
        mapping(
            Polygon(
                [(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)],
                [[(1, 1), (1, 2), (2, 2), (2, 1), (1, 1)]],
            )
        ),
        mapping(box(10, 0, 14, 4)),
    ]
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="polygons",
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": {"selected": "int64"}},
    ) as dataset:
        for index, geometry in enumerate(geometries, 1):
            dataset.write({"geometry": geometry, "properties": {"selected": index}})
    item = build_stac_items(tmp_path, path)[0]

    class CatalogHandler(BaseHTTPRequestHandler):
        """Serve only the exact fixture Item URL."""

        def do_GET(self) -> None:
            """Return authoritative JSON or a not-found response."""
            if self.path != f'/collections/{item["collection"]}/items/{item["id"]}':
                self.send_error(404)
                return
            body = json.dumps(item).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            """Keep fixture request logs out of test output."""

    server = ThreadingHTTPServer(("127.0.0.1", 0), CatalogHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"

    async def select() -> tuple[CatalogSelection, dict[str, Any]]:
        """Authorize using the real source resolver and HTTP Catalog adapter."""
        async with httpx2.AsyncClient() as client:
            service = VectorSamplingService(
                StacVectorCatalog(client, url), MountedVectorResolver(tmp_path)
            )
            result = await service.select(
                CatalogVectorFilterRequest(
                    collectionId=item["collection"],
                    itemId=item["id"],
                    filter=VectorFilter(
                        rules=[{"field": "selected", "operator": "eq", "value": 1}]
                    ),
                )
            )
            selection = CatalogSelection.model_validate(result["selection"])
            resolved = await service.resolve_for_sampling(selection)
            return selection, build_outline(resolved)

    selection, expected = asyncio.run(select())
    try:
        yield selection, expected, url
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize("stale", [False, True])
def test_registered_native_outline_preserves_algorithm_result(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    stale: bool,
) -> None:
    """Run the real registered operation/runner against HTTP Catalog and Fiona.

    Only deployment endpoints are injected into the child; the submitted input
    remains the exact production path-free contract.

    Args:
        outline_case: Real source, authorized descriptor and algorithm output.
        tmp_path: Source mount supplied to the native child.
        stale: Submit an obsolete source signature instead of the current one.
    """
    selection, expected, url = outline_case
    if stale:
        selection = selection.model_copy(update={"sourceSignature": "f" * 64})
    command = (
        "from pathlib import Path; "
        "from eolab_app.vector import outline_operation as op; "
        f"op.CATALOG_URL={url!r}; op.SCAN_MOUNT=Path({str(tmp_path)!r}); "
        "from job_service.runner import main; main()"
    )
    result = subprocess.run(
        [sys.executable, "-c", command],
        cwd=Path(__file__).parents[1] / "services/jobs",
        input=json.dumps(
            {
                "operation": "vector.outline.v1",
                "inputs": {
                    "selection": selection.model_dump(mode="json", by_alias=True),
                },
            }
        ).encode(),
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr.decode()
    reply = json.loads(result.stdout)
    if stale:
        assert reply == {"ok": False}
    else:
        assert reply == {
            "ok": True,
            "value": json.loads(json.dumps(expected)),
        }, result.stderr.decode()
        assert reply["value"]["bbox"] == [0, 0, 4, 4]
        assert (
            len(reply["value"]["geometry"]["features"][0]["geometry"]["coordinates"])
            == 2
        )


def test_operation_accepts_no_paths_or_geometry(outline_case: tuple) -> None:
    """Reject caller-supplied source locations and complete geometry snapshots."""
    selection, _, _ = outline_case
    for extra in ({"path": "/etc/passwd"}, {"url": "http://private"}, {"geometry": {}}):
        with pytest.raises(ValueError):
            OutlineInput(selection=selection, **extra)


@pytest.mark.parametrize("lost_submit", [False, True])
def test_adapter_result_and_uncertain_submission_cleanup(
    outline_case: tuple, lost_submit: bool
) -> None:
    """Recover the same admitted job after a lost submission response, then cancel."""
    selection, expected, _ = outline_case
    job_id = str(uuid4())
    calls = []

    def respond(request: httpx2.Request) -> httpx2.Response:
        """Model real Jobs wire semantics and record cleanup actions."""
        calls.append(request)
        assert request.url.host == "jobs"
        assert request.headers["authorization"] == "Bearer server-secret"
        if request.method == "POST" and request.url.path == "/api/jobs":
            if lost_submit and len(calls) == 1:
                raise httpx2.ReadError("lost reply", request=request)
            return httpx2.Response(202, json={"jobId": job_id, "status": "queued"})
        if request.url.path.endswith("/cancel"):
            return httpx2.Response(200, json={"jobId": job_id, "status": "cancelled"})
        if request.method == "DELETE":
            return httpx2.Response(204)
        if request.url.path.endswith("/result"):
            return httpx2.Response(200, json={"jobId": job_id, "value": expected})
        return httpx2.Response(200, json={"jobId": job_id, "status": "succeeded"})

    async def scenario() -> None:
        """Exercise adapter lifecycle without substituting its logic."""
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(respond)
        ) as client:
            adapter = OutlineJobs(JobsClient(client, "server-secret"))
            if lost_submit:
                with pytest.raises(VectorConflictError):
                    await adapter(selection)
            else:
                assert await adapter(selection) == json.loads(json.dumps(expected))

    asyncio.run(scenario())
    assert calls[-1].method == "DELETE"
    submits = [r for r in calls if r.url.path == "/api/jobs"]
    assert len(submits) == (2 if lost_submit else 1)
    assert len({r.headers["idempotency-key"] for r in submits}) == 1


def test_disconnect_cancels_admitted_job(outline_case: tuple) -> None:
    """A cancellation during submission waits for identity and cancels that job."""
    selection, _, _ = outline_case

    async def scenario() -> None:
        """Keep submission in flight while the caller disconnects."""
        admitted, release = asyncio.Event(), asyncio.Event()
        job_id = str(uuid4())
        cancelled = []

        async def respond(request: httpx2.Request) -> httpx2.Response:
            """Delay the admitted response until the disconnect is observed."""
            if request.url.path == "/api/jobs":
                admitted.set()
                await release.wait()
                return httpx2.Response(202, json={"jobId": job_id, "status": "running"})
            if request.url.path.endswith("/cancel"):
                cancelled.append(request.url.path)
                return httpx2.Response(
                    200, json={"jobId": job_id, "status": "cancelled"}
                )
            return httpx2.Response(204)

        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(respond)
        ) as client:
            task = asyncio.create_task(
                OutlineJobs(JobsClient(client, "secret"))(selection)
            )
            await admitted.wait()
            task.cancel()
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert cancelled == [f"/api/jobs/{job_id}/cancel"]

    asyncio.run(scenario())


def test_explicit_configuration(
    monkeypatch: pytest.MonkeyPatch,
    configured_environment: None,
    version_file_path: Path,
) -> None:
    """Require a private Jobs credential even without an execution-mode switch.

    Args:
        monkeypatch: Isolates credential mutations.
        configured_environment: Complete application settings fixture.
        version_file_path: Valid application version file.
    """
    monkeypatch.delenv("JOBS_TOKEN", raising=False)
    with pytest.raises(ValueError, match="JOBS_TOKEN"):
        load_settings(version_file_path)
    for invalid in ("", "a" * 31, "a" * 257, "a" * 32 + " ", "a" * 32 + "/"):
        monkeypatch.setenv("JOBS_TOKEN", invalid)
        with pytest.raises(ValueError, match="JOBS_TOKEN"):
            load_settings(version_file_path)
    token = "test-outline-" + "a" * 40
    monkeypatch.setenv("JOBS_TOKEN", token)
    settings = load_settings(version_file_path)
    assert settings.jobs_token == token
    assert token not in repr(settings)
    assert token not in json.dumps(settings.as_public_dict())


@pytest.mark.parametrize("outcome", ["success", "offline", "unauthorized", "stale"])
def test_application_routes_outlines_only_through_jobs(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    configured_environment: None,
    version_file_path: Path,
    outcome: str,
) -> None:
    """Keep default composition on Jobs and local selection independent.

    Args:
        outline_case: Real source, authorized selection and expected outline.
        tmp_path: Mounted fixture root.
        monkeypatch: Sets deployment configuration and guards local execution.
        configured_environment: Complete app settings including private token.
        version_file_path: Application version file.
        outcome: Successful reply, outage, rejected credential or changed source.
    """
    selection, expected, catalog_url = outline_case
    monkeypatch.setenv("CATALOG_INTERNAL_URL", catalog_url)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    calls: list[httpx2.Request] = []
    job_id = str(uuid4())

    def respond(request: httpx2.Request) -> httpx2.Response:
        """Substitute only remote Jobs HTTP, preserving the application's routing.

        Args:
            request: Authenticated lifecycle request from the actual Jobs client.

        Returns:
            Lifecycle response or an unavailable-service response.
        """
        calls.append(request)
        assert request.headers["Authorization"] == "Bearer test-outline-" + "a" * 40
        if outcome in {"offline", "unauthorized"}:
            return httpx2.Response(503 if outcome == "offline" else 401)
        if request.url.path.endswith("/result"):
            if outcome == "stale":
                source = tmp_path / "polygons.gpkg"
                # Appending changes its signature without replacing the source.
                with source.open("ab") as stream:
                    stream.write(b"changed")
            return httpx2.Response(200, json={"jobId": job_id, "value": expected})
        if request.method == "DELETE":
            return httpx2.Response(204)
        return httpx2.Response(202, json={"jobId": job_id, "status": "succeeded"})

    async def forbidden_local(*args: Any, **kwargs: Any) -> None:
        """Fail if outline routing attempts local bounded-process execution.

        Args:
            args: Unexpected positional process arguments.
            kwargs: Unexpected keyword process arguments.

        Raises:
            AssertionError: Always; local outlines have been removed.
        """
        raise AssertionError("Outline requested a local process")

    app = create_app(version_file_path, jobs_transport=httpx2.MockTransport(respond))
    with TestClient(app) as client:
        with monkeypatch.context() as guard:
            guard.setattr(
                "eolab_app.vector.sampling.run_bounded_process", forbidden_local
            )
            response = client.post(
                "/api/vector-sampling/outline",
                json=selection.model_dump(mode="json", by_alias=True),
            )
        assert calls, "The application's outline route did not call Jobs"
        submitted = json.loads(calls[0].content)
        assert submitted["operation"] == "vector.outline.v1"
        assert submitted["inputs"]["selection"] == selection.model_dump(
            mode="json", by_alias=True
        )
        if outcome == "success":
            assert response.status_code == 200, response.text
            assert response.json() == json.loads(json.dumps(expected))
        else:
            assert response.status_code == 409, response.text
        if outcome != "stale":
            previous_calls = len(calls)
            selected = client.post(
                "/api/vector-sampling/areas",
                json={
                    "collectionId": selection.collection_id,
                    "itemId": selection.item_id,
                    "filter": selection.filter.model_dump(mode="json"),
                },
            )
            assert selected.status_code == 200, selected.text
            assert selected.json()["matched"] == 1
            assert len(calls) == previous_calls


def test_remote_outlines_do_not_gate_selection(
    outline_case: tuple, tmp_path: Path
) -> None:
    """Concurrent remote display work cannot occupy the local selection lane."""
    selection, expected, url = outline_case

    async def scenario() -> None:
        """Hold remote work, select locally, then model optional service failure."""
        started = 0
        ready, release = asyncio.Event(), asyncio.Event()

        async def remote(_: CatalogSelection) -> dict[str, Any]:
            """Hold three independent Jobs submissions until local selection ends."""
            nonlocal started
            started += 1
            if started == 3:
                ready.set()
            await release.wait()
            raise VectorConflictError("Jobs offline")

        async with httpx2.AsyncClient() as client:
            service = VectorSamplingService(
                StacVectorCatalog(client, url), MountedVectorResolver(tmp_path), remote
            )
            requests = [
                asyncio.create_task(service.outline(selection)) for _ in range(3)
            ]
            try:
                await asyncio.wait_for(ready.wait(), 5)
                result = await service.select(
                    CatalogVectorFilterRequest(
                        collectionId=selection.collection_id,
                        itemId=selection.item_id,
                        filter=selection.filter,
                    )
                )
                assert result["matched"] == 1
                assert result["bbox"] == tuple(expected["bbox"])
            finally:
                release.set()
                results = await asyncio.gather(*requests, return_exceptions=True)
            assert all(isinstance(result, VectorConflictError) for result in results)

    asyncio.run(scenario())
