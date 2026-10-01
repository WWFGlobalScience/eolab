"""Calculation API, real PostgreSQL admission, supervised worker, and downloads."""

import asyncio
from dataclasses import replace
import hashlib
from pathlib import Path
import time
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.processing.raster_aggregate import calculate_raster_statistics_for_area
import eolab_app.processing.worker as worker_module
from test_processing_jobs import (
    boundary,
    store,
    HEADERS,
    AREA,
    clip_inputs,
    submitted,
    write_geopackage_layer,
    register_selection,
)
from test_raster_clips import SOURCE

ENDPOINT = "/api/processing/raster-calculations"


def request_body(**selection: Any) -> dict:
    """Build explicit calculation intent for the signed fixture raster.

    Args:
        selection: Box, AOI ID, or explicit whole source, defaulting to the fixture box.

    Returns:
        Bounded public calculation request.
    """
    return {
        "sources": {"a": SOURCE},
        "calculations": [
            {"label": "Matching pixels", "expression": "count(a > 5000)"},
            {"label": "Selected sum", "expression": "sum(a, where=a > 5000)"},
        ],
        **(selection or {"selectedBounds": AREA}),
    }


def calculation_inputs(client: TestClient, **selection: Any) -> dict:
    """Build immutable source, area and formula inputs for the calculation endpoint.

    Args:
        client: Test client retained for shared fixture call sites.
        **selection: Area and formula overrides.

    Returns:
        Valid calculation request fields without an idempotency key.
    """
    return request_body(**selection)


def submit_calculation(
    client: TestClient, inputs: dict, key: str | None = None
) -> dict:
    """Submit or retry reviewed intent with a stable client key.

    Args:
        client: Owned browser session.
        inputs: Raster, area and formulas for the queued calculation.
        key: Optional repeated request key.

    Returns:
        Accepted owned job.
    """
    response = client.post(
        ENDPOINT,
        json={**inputs, "requestId": key or uuid4().hex},
        headers=HEADERS,
    )
    assert response.status_code == 202, response.text
    timings = response.headers["server-timing"]
    assert "admissionChecks;dur=" in timings
    assert "processing;dur=" in timings
    return response.json()


def test_calculation_http_lifecycle_mixed_history_and_owned_csv(
    boundary: Any, store: Any
) -> None:
    """A real native job survives reload and shares lifecycle without clip assumptions.

    Args:
        boundary: Real owners, native worker and HTTP app.
        store: Disposable PostgreSQL for deterministic expiry.
    """
    client, worker, source, artifacts, app = boundary
    plan = calculation_inputs(client, wholeRaster=True)
    key = uuid4().hex
    job = submit_calculation(client, plan, key)
    assert submit_calculation(client, plan, key)["jobId"] == job["jobId"]
    assert asyncio.run(worker.run_once())
    url = f"/api/processing/jobs/{job['jobId']}"
    ready = client.get(url).json()
    assert ready["status"] == "ready", ready
    assert ready["result"]["executionTiming"]["queueSeconds"] >= 0
    assert ready["result"]["queuedToReadySeconds"] >= 0
    assert (
        ready["result"]["executionTiming"]["nativeProcessSeconds"]
        >= ready["result"]["performance"]["kernelSeconds"]
    )
    assert ready["result"]["rows"][0]["value"] == "4999"
    assert float(ready["result"]["rows"][1]["value"]) == sum(range(5001, 10000))
    download = client.get(ready["result"]["url"])
    assert download.headers["content-type"].startswith("text/csv")
    assert hashlib.sha256(download.content).hexdigest() == ready["result"]["sha256"]
    assert (
        client.get(url + "/result", headers={"Range": "bytes=0-19"}).content
        == download.content[:20]
    )
    provenance = client.get(ready["result"]["provenanceUrl"])
    assert provenance.json()["sources"] == {"a": SOURCE}
    assert str(source) not in provenance.text
    with TestClient(app, base_url="https://testserver") as reloaded:
        reloaded.cookies.update(client.cookies)
        assert reloaded.get(url).json()["result"] == ready["result"]
    clip = submitted(client, clip_inputs(client))
    jobs = client.get("/api/processing/jobs").json()["jobs"]
    assert {item["operation"] for item in jobs} == {
        "raster.clip.v1",
        "raster.aggregate.v1",
    }
    with TestClient(app, base_url="https://testserver") as stranger:
        assert stranger.get(url).status_code == 404
        assert stranger.get(url + "/result").status_code == 404
        assert stranger.get("/api/processing/jobs").json() == {"jobs": []}
    # Hold a real transfer while the result expires; cleanup must retain it.
    from eolab_app.routes.processing import COOKIE

    owner = hashlib.sha256(client.cookies[COOKIE].encode()).hexdigest()
    row, lease = store.acquire_transfer(job["jobId"], owner)
    with psycopg.connect(store.conninfo) as conn:
        conn.execute(
            "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
            (job["jobId"],),
        )
    asyncio.run(worker.cleanup())
    assert artifacts.result_path(row["attempt_id"], result_name="result.csv").exists()
    store.transfer_heartbeat(lease, True)
    asyncio.run(worker.cleanup())
    expired = client.get(url).json()
    assert expired["operation"] == "raster.aggregate.v1"
    assert expired["status"] == "expired" and expired["result"] is None
    assert expired["sources"] is None
    assert asyncio.run(worker.run_once())
    assert (
        client.get(f"/api/processing/jobs/{clip['jobId']}").json()["status"] == "ready"
    )


def test_batched_plan_metrics_and_execution(boundary: Any, store: Any) -> None:
    """Prepared batch metrics survive storage, execution and result publication.

    Args:
        boundary: Real API, native worker, source and artifact composition.
        store: Disposable PostgreSQL adapter.
    """
    client, worker, *_ = boundary
    plan = calculation_inputs(client, wholeRaster=True, targetChunkPixels=65536)
    job = submit_calculation(client, plan)
    assert asyncio.run(worker.run_once())
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    metrics = ready["result"]["performance"]
    execution = ready["grid"]["execution"]
    assert execution["targetChunkPixels"] == 65536
    assert execution["readWindows"] < ready["grid"]["nativeBlocks"]
    assert metrics["execution"] == execution
    assert metrics["readWindows"] == execution["readWindows"]
    assert client.get(ready["result"]["provenanceUrl"]).json()["performance"] == metrics
    assert ready["result"]["rows"][0]["value"] == "4999"
    assert ready["progress"]["phase"] == "ready"


def test_operation_mismatch_and_language_rejected_before_admission(
    boundary: Any,
) -> None:
    """Clip and calculation endpoints reject inputs for the other operation.

    Args:
        boundary: Real processing HTTP composition.
    """
    client, *_ = boundary
    clip = clip_inputs(client)
    calc = calculation_inputs(client)
    for endpoint, plan in [(ENDPOINT, clip), ("/api/processing/raster-clips", calc)]:
        response = client.post(
            endpoint,
            json={**plan, "requestId": uuid4().hex},
            headers=HEADERS,
        )
        assert response.status_code == 422
    key = uuid4().hex
    submit_calculation(client, calc, key)
    assert (
        client.post(
            "/api/processing/raster-clips",
            json={**clip, "requestId": key},
            headers=HEADERS,
        ).status_code
        == 409
    )
    for body in [
        {
            **request_body(),
            "calculations": [{"label": "No", "expression": "sum(a[0])"}],
        },
        {**request_body(), "selectedBounds": None},
        {**request_body(), "wholeRaster": True},
        {**request_body(), "sources": {"a": SOURCE, "b": SOURCE}},
    ]:
        assert (
            client.post(
                ENDPOINT, json={**body, "requestId": uuid4().hex}, headers=HEADERS
            ).status_code
            == 422
        )
    assert (
        client.post(
            ENDPOINT, json={**request_body(), "requestId": uuid4().hex}
        ).status_code
        == 403
    )
    assert (
        client.post(ENDPOINT, content=b"x" * 20000, headers=HEADERS).status_code == 413
    )


@pytest.mark.parametrize("area_expression", [False, True])
def test_catalog_selection_calculates(
    boundary: Any, tmp_path: Path, area_expression: bool
) -> None:
    """Calculate numeric summaries and ground area using catalog predicates.

    Args:
        boundary: Native source, worker, AOI and HTTP owners.
        tmp_path: AOI fixture storage.
        area_expression: Exercise fractional area as well as numeric aggregates.
    """
    client, worker, source, artifacts, app = boundary
    upload = tmp_path / "aoi.gpkg"
    geometry = {
        "type": "Polygon",
        "coordinates": [[[0.1, 9.1], [0.9, 9.1], [0.9, 9.9], [0.1, 9.9], [0.1, 9.1]]],
    }
    write_geopackage_layer(
        upload, "area", crs="EPSG:4326", geometry_type="Polygon", geometry=geometry
    )
    aoi = register_selection(client, upload)
    expressions = (
        {"calculations": [{"label": "Area", "expression": "areaha(a > 5000)"}]}
        if area_expression
        else {}
    )
    plan = calculation_inputs(client, catalogSelection=aoi, **expressions)
    job = submit_calculation(client, plan)
    assert asyncio.run(worker.run_once())
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    if area_expression:
        from shapely.geometry import box
        from test_ground_area import reference_area

        assert float(ready["result"]["rows"][0]["value"]) == pytest.approx(
            reference_area(box(0.1, 9.1, 0.9, 9.5)), rel=1e-8
        )
    else:
        assert ready["result"]["rows"][0]["value"] == "3200"


def test_worker_restart_invalidates_legacy_queued_jobs(
    boundary: Any, store: Any
) -> None:
    """Migrate old schemas and interrupt their queued jobs before execution.

    Args:
        boundary: Actual HTTP and worker composition.
        store: Disposable PostgreSQL adapter.
    """
    client, worker, *_ = boundary
    completed = submit_calculation(client, calculation_inputs(client))
    assert asyncio.run(worker.run_once())
    completed_job = client.get(f"/api/processing/jobs/{completed['jobId']}").json()
    assert completed_job["status"] == "ready", completed_job
    result_url = completed_job["result"]["url"]
    original_csv = client.get(result_url).content
    job = submit_calculation(client, calculation_inputs(client))
    with psycopg.connect(store.conninfo) as conn:
        conn.execute(
            "CREATE TABLE processing.plans (id text PRIMARY KEY, request jsonb)"
        )
        conn.execute("INSERT INTO processing.plans VALUES ('old-plan', '{}'::jsonb)")
        conn.execute("ALTER TABLE processing.jobs ADD COLUMN plan_id text")
        conn.execute(
            "ALTER TABLE processing.jobs ADD COLUMN job_format_version integer NOT NULL DEFAULT 1"
        )
        conn.execute(
            "ALTER TABLE processing.jobs ADD COLUMN minimum_claim_version integer NOT NULL DEFAULT 1"
        )
        conn.execute("DELETE FROM processing.schema_version WHERE version>1")
        conn.execute(
            "ALTER TABLE processing.schema_version ADD CONSTRAINT schema_version_version_check CHECK(version=1)"
        )
    store.migrate()
    store.migrate()
    store.interrupt_unfinished_jobs_on_restart()
    asyncio.run(worker.cleanup())
    assert not asyncio.run(worker.run_once())
    failed = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert failed["status"] == "interrupted"
    assert failed["error"]["code"] == "worker_restarted"
    assert failed["sources"] is None
    assert client.get(result_url).content == original_csv
    with psycopg.connect(store.conninfo) as conn:
        assert conn.execute(
            "SELECT version FROM processing.schema_version ORDER BY version"
        ).fetchall() == [(n,) for n in range(1, 14)]
        assert (
            conn.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_schema='processing' "
                "AND table_name='jobs' AND column_name IN ('minimum_claim_version','job_format_version','plan_id')"
            ).fetchone()
            is None
        )
        assert conn.execute("SELECT to_regclass('processing.plans')").fetchone() == (
            None,
        )


def paused_calculation(queue: Any, operation: str, arguments: tuple) -> None:
    """Pause after actual native reduction so cancellation races publication.

    Args:
        queue: Supervised child result channel.
        operation: Explicit calculation dispatch.
        arguments: Native kernel inputs.
    """
    if operation == "plan":
        from eolab_app.processing.raster_aggregate import aggregate_process_target

        aggregate_process_target(queue, operation, arguments)
        return
    assert operation == "calculate"
    artifact = calculate_raster_statistics_for_area(*arguments)
    directory = arguments[2]
    (directory / "checkpoint").write_text("ready")
    time.sleep(5)
    queue.put(("ok", artifact))


@pytest.mark.parametrize("stop", ["cancel", "shutdown", "deadline"])
@pytest.mark.parametrize("area_expression", [False, True])
def test_calculation_cancel_joins_native_child_and_removes_private_results(
    boundary: Any, monkeypatch: pytest.MonkeyPatch, stop: str, area_expression: bool
) -> None:
    """Cancellation cannot expose a CSV finalized just before the request.

    Args:
        boundary: Real HTTP, worker, files and PostgreSQL.
        monkeypatch: Controlled pause at the native publication boundary.
        stop: Explicit user cancellation, worker shutdown, or execution deadline.
        area_expression: Exercise the area-capable worker and its private artifacts.
    """
    client, worker, source, artifacts, app = boundary
    expressions = (
        {"calculations": [{"label": "Area", "expression": "areaha(a > 5000)"}]}
        if area_expression
        else {}
    )
    job = submit_calculation(
        client, calculation_inputs(client, selectedBounds=AREA, **expressions)
    )
    monkeypatch.setattr(worker_module, "aggregate_process_target", paused_calculation)
    if stop == "deadline":
        worker.limits = replace(worker.limits, runtime_seconds=2)

    async def exercise() -> None:
        """Cancel after the actual native child has produced its private output."""
        task = asyncio.create_task(worker.run_once())
        try:
            if stop != "deadline":
                async with asyncio.timeout(15):
                    while not list((artifacts.root / "attempts").glob("*/checkpoint")):
                        await asyncio.sleep(0.05)
            url = f"/api/processing/jobs/{job['jobId']}"
            if stop == "cancel":
                assert (
                    client.post(url + "/cancel", headers=HEADERS).json()["status"]
                    == "cancelling"
                )
            elif stop == "shutdown":
                task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                assert stop == "shutdown"
            state = client.get(url).json()
            assert (
                state["status"]
                == {
                    "cancel": "cancelled",
                    "shutdown": "interrupted",
                    "deadline": "failed",
                }[stop]
            )
            if stop == "deadline":
                assert state["error"]["code"] == "time_limit"
            assert client.get(url + "/result").status_code == 409
            await worker.cleanup()
            assert not list((artifacts.root / "results").iterdir())
            assert not list((artifacts.root / "attempts").iterdir())
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())
