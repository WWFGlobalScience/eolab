"""Exercise diagnostic execution and its real ASGI proxy boundary."""

import ast
import json
import time
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from pathlib import Path
from uuid import uuid4

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from job_service.app import create_app
from eolab_app.main import create_app as create_eolab
from eolab_app.routes.jobs_proxy import create_jobs_proxy_router

JOB = str(uuid4())
ARTIFACT = str(uuid4())
SUBMISSION = {
    "operation": "diagnostic.v1",
    "inputs": {"mode": "normal", "value": [10, 20, 30]},
    "priority": 10,
}
TOKEN = "a" * 48
KEY = {"Idempotency-Key": "demo-1", "Authorization": f"Bearer {TOKEN}"}
BASE = "/api/jobs"


@pytest.fixture(autouse=True)
def callers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure one isolated test caller.

    Args:
        monkeypatch: Environment isolation fixture.
    """
    monkeypatch.setenv("JOBS_CALLERS", json.dumps({"alice": TOKEN, "bob": "b" * 48}))


def wait_for(client: TestClient, job_id: str, expected: str) -> dict:
    """Wait briefly for an authoritative lifecycle state.

    Args:
        client: Running API test client.
        job_id: Submitted job identity.
        expected: Desired status.

    Returns:
        Matching status response.

    Raises:
        AssertionError: If the state never arrives.
    """
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f"{BASE}/{job_id}", headers=KEY)
        assert response.status_code == 200, response.text
        snapshot = response.json()
        if snapshot["status"] == expected:
            return snapshot
        time.sleep(0.02)
    raise AssertionError(snapshot)


@pytest.mark.parametrize("through_proxy", [False, True])
def test_success_lifecycle_through_real_boundary(through_proxy: bool) -> None:
    """Execute and retrieve results directly and through the existing proxy.

    Args:
        through_proxy: Whether to exercise the HTTP composition boundary.
    """
    service = create_app()
    if through_proxy:
        upstream = httpx2.AsyncClient(transport=httpx2.ASGITransport(app=service))

        @asynccontextmanager
        async def lifespan(app: FastAPI) -> AsyncIterator[None]:
            """Start the real service on the proxy loop and close its client.

            Args:
                app: Proxy application.

            Yields:
                Control while both components are available.
            """
            async with service.router.lifespan_context(service), upstream:
                yield

        app = FastAPI(lifespan=lifespan)
        app.include_router(create_jobs_proxy_router(upstream))
    else:
        app = service
    with TestClient(app) as browser:
        response = browser.post(BASE, json=SUBMISSION, headers=KEY)
        assert response.status_code == 202, response.text
        job_id = response.json()["jobId"]
        assert response.headers["location"] == f"{BASE}/{job_id}"
        wait_for(browser, job_id, "succeeded")
        assert browser.get(f"{BASE}/{job_id}/result", headers=KEY).json()["value"] == {
            "value": [10, 20, 30]
        }
        assert (
            browser.post(BASE, json=SUBMISSION, headers=KEY).json()["jobId"] == job_id
        )
        assert browser.get(BASE, headers=KEY).json()["jobs"][0]["jobId"] == job_id
        for suffix in ("events", f"artifacts/{ARTIFACT}"):
            assert (
                browser.get(f"{BASE}/{job_id}/{suffix}", headers=KEY).status_code == 501
            )
        assert browser.delete(f"{BASE}/{job_id}", headers=KEY).status_code == 204
        assert browser.get(f"{BASE}/{job_id}", headers=KEY).status_code == 404


def test_discovery_docs_and_schemas() -> None:
    """Discovery advertises the installed diagnostic and authenticated execution."""
    with TestClient(create_app()) as client:
        health = client.get(f"{BASE}/health").json()
        assert health == {
            "service": "jobs",
            "mode": "ephemeral",
            "ready": True,
            "acceptsJobs": True,
            "apiVersion": "0.2.0",
        }
        assert (
            client.get(f"{BASE}/operations").json()["operations"][0]["name"]
            == "diagnostic.v1"
        )
        assert f"{BASE}/openapi.json" in client.get(f"{BASE}/docs").text
        schema = client.get(f"{BASE}/openapi.json").json()
        assert schema["info"]["version"] == health["apiVersion"]
        post = schema["paths"][BASE]["post"]
        assert "401" in post["responses"]
        assert "202" in post["responses"]
        assert post["security"] == [{"HTTPBearer": []}]
        assert post["parameters"][0]["name"] == "Idempotency-Key"
        assert post["parameters"][0]["required"]
        models = schema["components"]["schemas"]
        assert models["SubmitJob"]["additionalProperties"] is False
        assert set(models["UpdateJob"]["properties"]) == {"priority"}
        assert "timed_out" in models["JobSnapshot"]["properties"]["status"]["enum"]


@pytest.mark.parametrize(
    "body,headers",
    [
        (SUBMISSION, {"Authorization": f"Bearer {TOKEN}"}),
        ({**SUBMISSION, "priority": True}, KEY),
        ({**SUBMISSION, "priority": 1001}, KEY),
        ({**SUBMISSION, "owner": "other"}, KEY),
        ({**SUBMISSION, "executionTimeoutSeconds": 0}, KEY),
        ({**SUBMISSION, "queueTimeoutSeconds": -1}, KEY),
        ({**SUBMISSION, "inputs": []}, KEY),
        ({**SUBMISSION, "operation": "../code.py"}, KEY),
    ],
)
def test_submission_boundary(body: dict, headers: dict) -> None:
    """Reject malformed contracts before admission without exposing raw inputs."""
    response = TestClient(create_app()).post(BASE, json=body, headers=headers)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize(
    "path",
    [
        f"{BASE}?limit=0",
        f"{BASE}?limit=101",
        f"{BASE}?status=unknown",
        f"{BASE}/not-a-uuid",
    ],
)
def test_invalid_job_identity_or_listing(path: str) -> None:
    """Listing and IDs are validated at the HTTP boundary."""
    assert TestClient(create_app()).get(path, headers=KEY).status_code == 422


def test_unknown_method_path_and_body_limit() -> None:
    """Keep direct container errors structured and reject oversized bodies."""
    client = TestClient(create_app())
    assert client.put(BASE, json={}).json()["error"]["code"] == "method_not_allowed"
    assert client.get(f"{BASE}/not/a/route").json()["error"]["code"] == "not_found"
    response = client.post(BASE, content=b"x" * 65537, headers=KEY)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "request_too_large"
    assert (
        client.post(
            BASE, content="{broken", headers={**KEY, "Content-Type": "application/json"}
        ).status_code
        == 422
    )


def test_composed_eolab_routes_to_independent_service(
    configured_environment: None, version_file_path: Path
) -> None:
    """The public prefix reaches the standalone service, not frontend fallback."""
    app = create_eolab(
        version_file_path, jobs_transport=httpx2.ASGITransport(app=create_app())
    )
    client = TestClient(app)
    assert client.get(f"{BASE}/health").json()["mode"] == "ephemeral"
    assert (
        client.get(f"{BASE}/operations").json()["operations"][0]["name"]
        == "diagnostic.v1"
    )
    assert client.get(f"{BASE}/docs").status_code == 200
    assert client.get(f"{BASE}/openapi.json").json()["info"]["version"] == "0.2.0"
    assert client.get("/healthz").status_code == 200
    assert "/api/processing/jobs" in app.openapi()["paths"]
    assert not any(path.startswith(BASE) for path in app.openapi()["paths"])


def test_proxy_is_bounded_and_forwards_only_explicit_bearer_credentials() -> None:
    """Only the fixed prefix and minimal API headers cross the new HTTP edge."""
    seen = []

    def respond(request: httpx2.Request) -> httpx2.Response:
        """Capture the request and simulate a bounded service response.

        Args:
            request: Outbound HTTP request.

        Returns:
            Stub result, oversized body or attempted redirect.
        """
        seen.append(request)
        if request.url.path.endswith("/health"):
            return httpx2.Response(200, content=b"x" * 1048577)
        if request.url.path.endswith("/docs"):
            return httpx2.Response(302, headers={"Location": "http://private/"})
        return httpx2.Response(
            501,
            json={"error": {"code": "not_implemented", "message": "stub"}},
            headers={"Set-Cookie": "unsafe=1"},
        )

    app = FastAPI()
    app.include_router(
        create_jobs_proxy_router(
            httpx2.AsyncClient(transport=httpx2.MockTransport(respond))
        )
    )
    browser = TestClient(app)
    response = browser.post(
        BASE,
        json=SUBMISSION,
        headers={**KEY, "Cookie": "session=private", "Authorization": "Bearer private"},
    )
    assert response.status_code == 501
    assert "set-cookie" not in response.headers
    assert seen[0].url.host == "jobs"
    assert seen[0].url.path == BASE
    assert seen[0].headers["idempotency-key"] == "demo-1"
    assert "cookie" not in seen[0].headers
    assert seen[0].headers["authorization"] == "Bearer private"
    assert browser.get(f"{BASE}/health").json()["error"]["code"] == "response_too_large"
    assert browser.get(f"{BASE}/docs").status_code == 502
    count = len(seen)
    assert browser.post(BASE, content=b"x" * 65537).status_code == 413
    assert browser.get(f"{BASE}/%2e%2e/private").status_code == 404
    assert len(seen) == count


def test_jobs_outage_is_local(
    configured_environment: None, version_file_path: Path
) -> None:
    """Job service absence does not break application creation or normal health."""

    def unavailable(request: httpx2.Request) -> httpx2.Response:
        """Simulate a disconnected internal service.

        Args:
            request: Job service request.

        Raises:
            httpx2.ConnectError: Always, to model an outage.
        """
        raise httpx2.ConnectError("private hostname", request=request)

    app = create_eolab(
        version_file_path, jobs_transport=httpx2.MockTransport(unavailable)
    )
    client = TestClient(app)
    assert client.get("/healthz").status_code == 200
    response = client.get(f"{BASE}/health")
    assert response.status_code == 502
    assert "private hostname" not in response.text


def test_scheduler_has_only_explicit_operation_registration_edge() -> None:
    """Only registration imports the approved domain operation, never services."""
    root = Path(__file__).parents[1]
    for path in (root / "services/jobs/job_service").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            imports = (
                [alias.name for alias in node.names]
                if isinstance(node, ast.Import)
                else ([node.module or ""] if isinstance(node, ast.ImportFrom) else [])
            )
            if path.name == "operations_registry.py":
                imports = [
                    name
                    for name in imports
                    if name
                    not in {
                        "eolab_app.vector.outline_operation",
                        "eolab_app.vector.selection_operation",
                        "eolab_app.vector.extent_operation",
                    }
                ]
            assert not any(
                name.startswith(
                    (
                        "eolab_app",
                        "eolab_infrastructure",
                        "fiona",
                        "rasterio",
                        "psycopg",
                    )
                )
                for name in imports
            )
    dockerfile = (root / "services/jobs/Dockerfile").read_text()
    assert "USER jobs" in dockerfile
    assert "COPY src/eolab_app/" in dockerfile
    compose = (
        (root / "docker-compose.yml")
        .read_text()
        .split("  jobs:\n", 1)[1]
        .split("  app:\n", 1)[0]
    )
    assert "dockerfile: services/jobs/Dockerfile" in compose
    assert "read_only: true" in compose
    assert "depends_on:" not in compose and "ports:" not in compose
    assert "target: /scan-source" in compose
    assert "mem_limit: 2g" in compose
    operation = (root / "src/eolab_app/vector/outline_operation.py").read_text()
    assert "VectorSamplingService" not in operation
    assert "geoserver" not in operation.lower()
    selection_operation = (root / "src/eolab_app/vector/selection_operation.py").read_text()
    assert "VectorSamplingService" not in selection_operation
    assert "geoserver" not in selection_operation.lower()
    sampling = (root / "src/eolab_app/vector/sampling.py").read_text()
    assert "run_bounded_process" not in sampling and "Semaphore" not in sampling


def test_jobs_pins_reuse_reviewed_application_resolution() -> None:
    """GIS operation packaging introduces no independent dependency resolution."""
    root = Path(__file__).parents[1]
    jobs = {
        line
        for line in (root / "services/jobs/requirements.txt").read_text().splitlines()
        if line and not line.startswith("#")
    }
    assert jobs == {"-r ../../deployment/application-runtime-requirements.txt"}
