"""One-request summaries through the real HTTP, database and native worker boundaries."""

import asyncio
import hashlib
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from eolab_app.routes.processing import COOKIE
from test_processing_jobs import boundary, store, HEADERS
from test_processing_calculations import request_body, ENDPOINT
from test_processing_jobs import write_geopackage_layer, register_selection
import eolab_app.processing.worker as worker_module


def test_summary_prepares_and_calculates_without_a_plan_request(
    boundary: Any, store: Any
) -> None:
    """Publish prepared details and the result under the originally admitted job ID.

    Args:
        boundary: Real API, raster source and supervised worker.
        store: Disposable PostgreSQL job store.
    """
    client, worker, _, _, app = boundary
    body = {**request_body(), "requestId": uuid4().hex}
    response = client.post(ENDPOINT, json=body, headers=HEADERS)
    assert response.status_code == 202, response.text
    job = response.json()
    assert job["status"] == "queued"
    assert job["grid"] is None
    assert job["preparation"] is None
    assert (
        client.post(ENDPOINT, json=body, headers=HEADERS).json()["jobId"]
        == job["jobId"]
    )
    changed = {**body, "calculations": [{"label": "Mean", "expression": "mean(a)"}]}
    assert client.post(ENDPOINT, json=changed, headers=HEADERS).status_code == 409
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT count(*) FROM processing.plans"
        ).fetchone() == (0,)
        assert connection.execute(
            "SELECT minimum_claim_version FROM processing.jobs"
        ).fetchone() == (9,)
    with pytest.raises(psycopg.errors.CheckViolation):
        with psycopg.connect(store.conninfo) as connection:
            connection.execute("SET LOCAL eolab.processing_claim_version = '8'")
            connection.execute(
                "UPDATE processing.jobs SET status='running' WHERE id=%s",
                (job["jobId"],),
            )
    assert asyncio.run(worker.run_once())
    completed = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert completed["status"] == "ready", completed
    assert completed["grid"]["nativeBlocks"] > 0
    assert completed["preparation"]["seconds"] >= 0
    assert completed["preparation"]["cacheHit"] is False
    assert len(completed["result"]["rows"]) == 2
    assert (
        client.post(ENDPOINT, json=body, headers=HEADERS).json()["jobId"]
        == job["jobId"]
    )
    with TestClient(app, base_url="https://testserver") as stranger:
        assert stranger.get(f"/api/processing/jobs/{job['jobId']}").status_code == 404
    cached = client.post(
        ENDPOINT, json={**body, "requestId": uuid4().hex}, headers=HEADERS
    ).json()
    assert asyncio.run(worker.run_once())
    cached = client.get(f"/api/processing/jobs/{cached['jobId']}").json()
    assert cached["status"] == "ready", cached
    assert cached["preparation"]["cacheHit"]
    assert cached["preparation"]["process"] is None
    assert cached["result"]["cacheHit"]
    assert cached["result"]["rows"] == completed["result"]["rows"]


def test_queued_summary_cancels_without_starting_preparation(
    boundary: Any, store: Any
) -> None:
    """Cancellation before claim leaves no plan, prepared grid or raster result.

    Args:
        boundary: Real API and worker.
        store: Disposable PostgreSQL job store.
    """
    client, worker, *_ = boundary
    response = client.post(
        ENDPOINT, json={**request_body(), "requestId": uuid4().hex}, headers=HEADERS
    )
    assert response.status_code == 202, response.text
    job = response.json()
    cancelled = client.post(
        f"/api/processing/jobs/{job['jobId']}/cancel", headers=HEADERS
    ).json()
    assert cancelled["status"] == "cancelled"
    assert not asyncio.run(worker.run_once())
    owner = hashlib.sha256(client.cookies[COOKIE].encode()).hexdigest()
    assert store.get(job["jobId"], owner)["preparation"] is None


@pytest.mark.parametrize("kind", ["whole", "catalog", "polygons"])
def test_direct_summary_area_inputs(boundary: Any, tmp_path: Path, kind: str) -> None:
    """Retain exact area semantics, including polygon uploads deleted after admission.

    Args:
        boundary: Real API, source and worker.
        tmp_path: Temporary catalog vector directory.
        kind: Supported non-rectangle area representation.
    """
    client, worker, *_ = boundary
    polygon = {
        "type": "Polygon",
        "coordinates": [[[0.1, 9.1], [0.9, 9.1], [0.9, 9.9], [0.1, 9.9], [0.1, 9.1]]],
    }
    if kind == "whole":
        area = {"wholeRaster": True}
    elif kind == "catalog":
        path = tmp_path / "selection.gpkg"
        write_geopackage_layer(
            path, "area", crs="EPSG:4326", geometry_type="Polygon", geometry=polygon
        )
        area = {"catalogSelection": register_selection(client, path)}
    else:
        response = client.post(
            "/api/processing/polygon-areas",
            json={"polygons": [polygon]},
            headers=HEADERS,
        )
        assert response.status_code == 200, response.text
        area = {"polygonArea": response.json()["polygonArea"]}
    body = {**request_body(**area), "requestId": uuid4().hex}
    response = client.post(ENDPOINT, json=body, headers=HEADERS)
    assert response.status_code == 202, response.text
    if kind == "polygons":
        client.delete(
            f"/api/processing/polygon-areas/{area['polygonArea']['id']}",
            headers=HEADERS,
        )
        assert (
            client.post(ENDPOINT, json=body, headers=HEADERS).json()["jobId"]
            == response.json()["jobId"]
        )
    assert asyncio.run(worker.run_once())
    job = client.get(f"/api/processing/jobs/{response.json()['jobId']}").json()
    assert job["status"] == "ready", job
    assert job["result"]["rows"][0]["value"] == ("4999" if kind == "whole" else "3200")


@pytest.mark.parametrize("phase", ["plan", "calculate"])
def test_preparation_and_execution_are_observed_and_cancelled_through_one_job(
    boundary: Any, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    """Observe preparation and its estimates, cancelling either phase with the original ID.

    Args:
        boundary: Real HTTP, database and worker.
        monkeypatch: Pause the requested phase at the native process boundary.
        phase: Native operation at which to observe and cancel the job.
    """
    client, worker, *_ = boundary
    job = client.post(
        ENDPOINT, json={**request_body(), "requestId": uuid4().hex}, headers=HEADERS
    ).json()
    native = worker_module.run_process

    async def exercise() -> None:
        """Wait for the selected native operation, then cancel its job."""
        operation_started = asyncio.Event()

        async def pause_native_operation(target: Any, args: tuple, *rest: Any) -> Any:
            """Pause the chosen operation while allowing other native work.

            Args:
                target: Native operation function.
                args: Operation and validated inputs.
                rest: Timeout and process provider.

            Returns:
                Native result; the chosen operation waits for cancellation.
            """
            if args[0] == phase:
                operation_started.set()
                await asyncio.Event().wait()
            return await native(target, args, *rest)

        monkeypatch.setattr(worker_module, "run_process", pause_native_operation)
        task = asyncio.create_task(worker.run_once())
        try:
            await asyncio.wait_for(operation_started.wait(), 15)
            snapshot = client.get(f"/api/processing/jobs/{job['jobId']}").json()
            assert snapshot["status"] == "running"
            if phase == "calculate":
                assert snapshot["progress"]["phase"] == "calculating"
                assert snapshot["preparation"] and snapshot["grid"]
            else:
                assert snapshot["progress"]["phase"] == "preparing"
                assert snapshot["preparation"] is None and snapshot["grid"] is None
            assert snapshot["result"] is None
            client.post(f"/api/processing/jobs/{job['jobId']}/cancel", headers=HEADERS)
            await asyncio.wait_for(task, 5)
            assert (
                client.get(f"/api/processing/jobs/{job['jobId']}").json()["status"]
                == "cancelled"
            )
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())


def test_preparation_rejects_insufficient_disk_before_execution(
    boundary: Any, store: Any
) -> None:
    """Defer disk estimation, but reserve it before creating calculation files.

    Args:
        boundary: Real API, raster and worker.
        store: Adapter whose aggregate reservation is intentionally constrained.
    """
    client, worker, _, artifacts, _ = boundary
    store.limits = replace(store.limits, max_stored_bytes=1)
    response = client.post(
        ENDPOINT, json={**request_body(), "requestId": uuid4().hex}, headers=HEADERS
    )
    assert response.status_code == 202, response.text
    assert asyncio.run(worker.run_once())
    job = client.get(f"/api/processing/jobs/{response.json()['jobId']}").json()
    assert job["status"] == "failed", job
    assert job["error"]["code"] == "storage_full"
    assert not list((artifacts.root / "attempts").iterdir())
