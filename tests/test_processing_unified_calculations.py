"""One-request summaries through the real HTTP, database and native worker boundaries."""

import asyncio
import hashlib
import json
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import uuid4
from unittest.mock import patch

import psycopg
import pytest
from fastapi.testclient import TestClient

from eolab_app.routes.processing import COOKIE
from eolab_app.processing import aggregate_models
from eolab_app.processing.aggregate_models import (
    AggregateJobRequest,
    AggregatePlanRequest,
)
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.service import ProcessingService
from test_processing_jobs import boundary, store, HEADERS
from test_processing_calculations import request_body, ENDPOINT
from test_processing_jobs import write_geopackage_layer, register_selection
import eolab_app.processing.worker as worker_module


def test_http_and_direct_submission_reuse_validated_inputs(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Keep legacy request hashes while validating each caller's inputs only once.

    Args:
        boundary: Real HTTP route, source and worker composition.
        store: Disposable PostgreSQL job store shared by HTTP and direct callers.
    """
    client, _, _, artifacts, _ = boundary
    body = {**request_body(), "requestId": uuid4().hex}
    original_inputs = AggregatePlanRequest.model_validate(request_body())
    original_hash = hashlib.sha256(
        json.dumps(
            original_inputs.model_dump(mode="json", by_alias=True), sort_keys=True
        ).encode()
    ).hexdigest()
    with patch.object(
        aggregate_models,
        "compile_expression",
        wraps=aggregate_models.compile_expression,
    ) as compiler:
        response = client.post(ENDPOINT, json=body, headers=HEADERS)
        assert response.status_code == 202, response.text
        assert compiler.call_count == len(body["calculations"])
        request = AggregateJobRequest(**{**body, "requestId": uuid4().hex})
        validated_calls = compiler.call_count
        service = ProcessingService(store, artifacts)
        direct = asyncio.run(service.submit_calculation_inputs("direct-owner", request))
        assert compiler.call_count == validated_calls
        assert (
            asyncio.run(service.submit_calculation_inputs("direct-owner", request))[
                "jobId"
            ]
            == direct["jobId"]
        )
        assert compiler.call_count == validated_calls
    owner = hashlib.sha256(client.cookies[COOKIE].encode()).hexdigest()
    http_row = store.get(response.json()["jobId"], owner)
    direct_row = store.get(direct["jobId"], "direct-owner")
    assert http_row["request_hash"] == direct_row["request_hash"] == original_hash
    assert http_row["job_id"] == direct_row["job_id"]
    assert http_row["id"] != direct_row["id"]
    with psycopg.connect(store.conninfo) as connection:
        stored_spec = connection.execute(
            "SELECT spec FROM processing.jobs WHERE id=%s", (http_row["job_id"],)
        ).fetchone()[0]
    assert stored_spec["request"] == original_inputs.model_dump(
        mode="json", by_alias=True
    )


def test_summary_prepares_and_calculates_without_a_plan_request(
    boundary: Any, store: Any
) -> None:
    """Publish prepared details and the result under the originally admitted job ID.

    Args:
        boundary: Real API, raster source and supervised worker.
        store: Disposable PostgreSQL job store.
    """
    client, worker, _, _, app = boundary
    paths = app.openapi()["paths"]
    assert not any(
        "/plan" in path for path in paths if path.startswith("/api/processing")
    )
    for endpoint in (ENDPOINT, "/api/processing/raster-clips"):
        legacy = client.post(
            endpoint,
            json={"planId": uuid4().hex, "requestId": uuid4().hex},
            headers=HEADERS,
        )
        assert legacy.status_code == 422
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
            "SELECT count(*) FROM information_schema.tables WHERE table_schema='processing' AND table_name='plans'"
        ).fetchone() == (0,)
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


@pytest.mark.parametrize("mixed", [False, True])
@pytest.mark.parametrize("outside", [False, True])
def test_pixel_formula_uses_same_batch_worker_cache_and_owned_provenance(
    boundary: Any, store: PostgresJobStore, mixed: bool, outside: bool
) -> None:
    """Execute point and mixed formulas through the existing durable calculation job.

    Args:
        boundary: Real HTTP, catalog authorization, native worker and raster.
        store: Disposable PostgreSQL job and result-cache store.
        mixed: Include mean over the whole raster alongside the point formula.
        outside: Choose a point beyond the raster, retaining independent area results.
    """
    client, worker, _, _, app = boundary
    point = (
        {"longitude": 40.0, "latitude": 40.0}
        if outside
        else {"longitude": 0.055, "latitude": 9.945}
    )
    formulas = ["pixelValue(a)", "mean(a)"] if mixed else ["pixelValue(a)"]
    body = {
        **request_body(wholeRaster=True),
        "requestId": uuid4().hex,
        "pixelPoint": point,
        "calculations": [
            {"label": expression, "expression": expression} for expression in formulas
        ],
    }
    response = client.post(ENDPOINT + "/batch", json={"items": [body]}, headers=HEADERS)
    assert response.status_code == 200, response.text
    submitted = response.json()["items"][0]["job"]
    owner = hashlib.sha256(client.cookies[COOKIE].encode()).hexdigest()
    shared_job_id = store.get(submitted["jobId"], owner)["job_id"]
    with psycopg.connect(store.conninfo) as connection:
        queued_spec = connection.execute(
            "SELECT spec FROM processing.jobs WHERE id=%s", (shared_job_id,)
        ).fetchone()[0]
    assert queued_spec["request"]["pixelPoint"] == point
    assert asyncio.run(worker.run_once())
    completed = client.get(f"/api/processing/jobs/{submitted['jobId']}").json()
    assert completed["status"] == "ready", completed
    rows = completed["result"]["rows"]
    assert rows[0]["state"] == ("no_valid_data" if outside else "ok")
    assert (float(rows[0]["value"]) if rows[0]["value"] is not None else None) == (
        None if outside else 505
    )
    if mixed:
        assert rows[1]["state"] == "ok"
        assert float(rows[1]["value"]) == pytest.approx(4999.5, abs=1e-10, rel=0)
    else:
        assert (
            completed["grid"]["width"]
            == completed["grid"]["height"]
            == (0 if outside else 1)
        )
        assert completed["result"]["performance"]["readWindows"] == (
            0 if outside else 1
        )
    provenance_url = completed["result"]["provenanceUrl"]
    assert client.get(provenance_url).json()["pixelPoint"] == point
    with TestClient(app, base_url="https://testserver") as stranger:
        assert stranger.get(provenance_url).status_code == 404
    with psycopg.connect(store.conninfo) as connection:
        prepared_spec = connection.execute(
            "SELECT spec FROM processing.jobs WHERE id=%s", (shared_job_id,)
        ).fetchone()[0]
    assert prepared_spec["pixelPoint"] == point
    retry = client.post(
        ENDPOINT + "/batch", json={"items": [body]}, headers=HEADERS
    ).json()["items"][0]["job"]
    assert retry["jobId"] == completed["jobId"]
    changed = {**body, "pixelPoint": {"longitude": 0.065, "latitude": 9.945}}
    conflict = client.post(
        ENDPOINT + "/batch", json={"items": [changed]}, headers=HEADERS
    ).json()["items"][0]
    assert conflict["error"]["code"] == "request_conflict"
    cached = client.post(
        ENDPOINT + "/batch",
        json={"items": [{**body, "requestId": uuid4().hex}]},
        headers=HEADERS,
    ).json()["items"][0]["job"]
    assert asyncio.run(worker.run_once())
    cached = client.get(f"/api/processing/jobs/{cached['jobId']}").json()
    assert cached["status"] == "ready", cached
    assert cached["preparation"]["cacheHit"] and cached["result"]["cacheHit"]
    assert cached["result"]["rows"] == rows
    assert client.get(cached["result"]["provenanceUrl"]).json()["pixelPoint"] == point


@pytest.mark.parametrize("operation", ["summary", "clip"])
def test_queued_job_cancels_without_starting_preparation(
    boundary: Any, store: Any, operation: str
) -> None:
    """Cancellation before claim leaves no plan, prepared grid or raster result.

    Args:
        boundary: Real API and worker.
        store: Disposable PostgreSQL job store.
        operation: Summary or clip sharing the same queue and cancellation.
    """
    client, worker, *_ = boundary
    from test_processing_jobs import clip_inputs

    endpoint = ENDPOINT if operation == "summary" else "/api/processing/raster-clips"
    inputs = request_body() if operation == "summary" else clip_inputs(client)
    response = client.post(
        endpoint, json={**inputs, "requestId": uuid4().hex}, headers=HEADERS
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
@pytest.mark.parametrize("operation", ["summary", "clip"])
def test_preparation_and_execution_are_observed_and_cancelled_through_one_job(
    boundary: Any, monkeypatch: pytest.MonkeyPatch, phase: str, operation: str
) -> None:
    """Observe preparation and its estimates, cancelling either phase with the original ID.

    Args:
        boundary: Real HTTP, database and worker.
        monkeypatch: Pause the requested phase at the native process boundary.
        phase: Native operation at which to observe and cancel the job.
        operation: Summary or clip using the same job lifecycle.
    """
    client, worker, *_ = boundary
    from test_processing_jobs import clip_inputs

    endpoint = ENDPOINT if operation == "summary" else "/api/processing/raster-clips"
    inputs = request_body() if operation == "summary" else clip_inputs(client)
    job = client.post(
        endpoint, json={**inputs, "requestId": uuid4().hex}, headers=HEADERS
    ).json()
    native_phase = "clip" if operation == "clip" and phase == "calculate" else phase
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
            if args[0] == native_phase:
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
