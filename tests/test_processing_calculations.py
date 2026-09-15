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
    planned,
    submitted,
    write_geopackage_layer,
    register_selection,
)
from test_raster_clips import SOURCE

ENDPOINT = "/api/processing/raster-calculations"


def test_repeated_calculations_release_reviews_but_preserve_owned_job_recovery(
    boundary: Any, store: Any
) -> None:
    """Interactive clicks exceed five runs without retaining used review slots.

    Args:
        boundary: Real API and Processing composition.
        store: PostgreSQL adapter for the native-planning fence assertion.
    """
    from eolab_app.routes.processing import COOKIE

    client, _, _, _, app = boundary
    for _ in range(7):
        plan = plan_calculation(client)
        path = f"/api/processing/plans/{plan['planId']}"
        with TestClient(app, base_url="https://testserver") as stranger:
            assert stranger.delete(path, headers=HEADERS).status_code == 200
        key = uuid4().hex
        job = submit_calculation(client, plan, key)
        assert client.delete(path).status_code == 403
        assert client.delete(path, headers=HEADERS).status_code == 200
        assert client.delete(path, headers=HEADERS).status_code == 200
        assert submit_calculation(client, plan, key)["jobId"] == job["jobId"]
        assert (
            client.post(
                f"/api/processing/jobs/{job['jobId']}/cancel", headers=HEADERS
            ).json()["status"]
            == "cancelled"
        )
    owner = hashlib.sha256(client.cookies[COOKIE].encode()).hexdigest()
    active = store.reserve_plan(owner, request_body())
    assert (
        client.delete(f"/api/processing/plans/{active}", headers=HEADERS).status_code
        == 200
    )
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT planning_until IS NOT NULL FROM processing.plans WHERE id=%s",
            (active,),
        ).fetchone() == (True,)
    store.finish_plan(active, owner, None)


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


def plan_calculation(client: TestClient, **selection: Any) -> dict:
    """Review calculation intent through the real HTTP boundary.

    Args:
        client: Owned HTTPS browser session.
        selection: Explicit calculation area.

    Returns:
        Reviewable calculation plan.
    """
    response = client.post(
        ENDPOINT + "/plan", json=request_body(**selection), headers=HEADERS
    )
    assert response.status_code == 200, response.text
    return response.json()


def submit_calculation(client: TestClient, plan: dict, key: str | None = None) -> dict:
    """Submit or retry reviewed intent with a stable client key.

    Args:
        client: Owned browser session.
        plan: Reviewed immutable plan.
        key: Optional repeated request key.

    Returns:
        Accepted owned job.
    """
    response = client.post(
        ENDPOINT,
        json={"planId": plan["planId"], "requestId": key or uuid4().hex},
        headers=HEADERS,
    )
    assert response.status_code == 202, response.text
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
    plan = plan_calculation(client, wholeRaster=True)
    assert plan["timing"]["nativeProcessSeconds"] >= 0
    assert plan["inclusion"] == "cell_center"
    assert plan["grid"]["width"] == 100
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
    clip = submitted(client, planned(client))
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


def test_batched_plan_metrics_and_v3_worker_gate(boundary: Any, store: Any) -> None:
    """Reviewed batches survive storage, old-worker exclusion, execution and recovery.

    Args:
        boundary: Real API, native worker, source and artifact composition.
        store: Disposable PostgreSQL adapter.
    """
    client, worker, *_ = boundary
    plan = plan_calculation(client, wholeRaster=True, targetChunkPixels=65536)
    execution = plan["grid"]["execution"]
    assert execution["targetChunkPixels"] == 65536
    assert execution["readWindows"] < plan["grid"]["nativeBlocks"]
    job = submit_calculation(client, plan)
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT minimum_claim_version FROM processing.jobs WHERE id=%s",
            (job["jobId"],),
        ).fetchone() == (4,)
        assert (
            connection.execute(
                "SELECT id FROM processing.jobs WHERE status='queued' AND minimum_claim_version<=3"
            ).fetchall()
            == []
        )
    with pytest.raises(psycopg.errors.CheckViolation):
        with psycopg.connect(store.conninfo) as connection:
            connection.execute("SET LOCAL eolab.processing_claim_version = '3'")
            connection.execute(
                "UPDATE processing.jobs SET status='running' WHERE id=%s",
                (job["jobId"],),
            )
    assert asyncio.run(worker.run_once())
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    metrics = ready["result"]["performance"]
    assert metrics["execution"] == execution
    assert metrics["readWindows"] == execution["readWindows"]
    assert client.get(ready["result"]["provenanceUrl"]).json()["performance"] == metrics
    assert ready["result"]["rows"][0]["value"] == "4999"
    assert ready["progress"]["phase"] == "ready"


def test_operation_mismatch_and_language_rejected_before_admission(
    boundary: Any,
) -> None:
    """Clip and calculation commands cannot accidentally consume each other's plans.

    Args:
        boundary: Real processing HTTP composition.
    """
    client, *_ = boundary
    clip = planned(client)
    calc = plan_calculation(client)
    for endpoint, plan in [(ENDPOINT, clip), ("/api/processing/raster-clips", calc)]:
        response = client.post(
            endpoint,
            json={"planId": plan["planId"], "requestId": uuid4().hex},
            headers=HEADERS,
        )
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "operation_mismatch"
    key = uuid4().hex
    submit_calculation(client, calc, key)
    assert (
        client.post(
            "/api/processing/raster-clips",
            json={"planId": calc["planId"], "requestId": key},
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
            client.post(ENDPOINT + "/plan", json=body, headers=HEADERS).status_code
            == 422
        )
    assert client.post(ENDPOINT + "/plan", json=request_body()).status_code == 403
    assert (
        client.post(
            ENDPOINT + "/plan", content=b"x" * 20000, headers=HEADERS
        ).status_code
        == 413
    )


@pytest.mark.parametrize("area_expression", [False, True])
def test_catalog_selection_calculates_and_native_source_is_refenced(
    boundary: Any, tmp_path: Path, area_expression: bool
) -> None:
    """Catalog predicates drive calculations, while modified rasters never execute.

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
    plan = plan_calculation(client, catalogSelection=aoi, **expressions)
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
    plan = plan_calculation(client, selectedBounds=AREA, **expressions)
    stale = submit_calculation(client, plan)
    with source.open("ab") as stream:
        stream.write(b"changed")
    assert asyncio.run(worker.run_once())
    failed = client.get(f"/api/processing/jobs/{stale['jobId']}").json()
    assert failed["status"] == "failed" and failed["result"] is None


def test_legacy_claim_protocol_cannot_consume_calculations(
    boundary: Any, store: Any
) -> None:
    """Migration blocks legacy claim SQL before work starts, including redeployments.

    Args:
        boundary: Actual planning and worker composition.
        store: Disposable PostgreSQL adapter.
    """
    client, worker, *_ = boundary
    job = submit_calculation(client, plan_calculation(client))
    # An unmodified v1 worker runs a plain queued->running UPDATE.
    with pytest.raises(psycopg.errors.CheckViolation):
        with psycopg.connect(store.conninfo) as conn:
            conn.execute(
                "UPDATE processing.jobs SET status='running' WHERE id=%s",
                (job["jobId"],),
            )
    assert (
        client.get(f"/api/processing/jobs/{job['jobId']}").json()["status"] == "queued"
    )
    store.migrate()
    assert asyncio.run(worker.run_once())
    assert (
        client.get(f"/api/processing/jobs/{job['jobId']}").json()["status"] == "ready"
    )
    clip = submitted(client, planned(client))
    with psycopg.connect(store.conninfo) as conn:
        conn.execute(
            "UPDATE processing.jobs SET status='running' WHERE id=%s", (clip["jobId"],)
        )
        conn.rollback()  # Observe legacy admission without leaving an unfenced test job.
    with psycopg.connect(store.conninfo) as conn:
        conn.execute("DELETE FROM processing.schema_version WHERE version>1")
        conn.execute(
            "ALTER TABLE processing.schema_version ADD CONSTRAINT schema_version_version_check CHECK(version=1)"
        )
    store.migrate()
    with psycopg.connect(store.conninfo) as conn:
        assert conn.execute(
            "SELECT version FROM processing.schema_version ORDER BY version"
        ).fetchall() == [(1,), (2,), (3,)]


def paused_calculation(queue: Any, operation: str, arguments: tuple) -> None:
    """Pause after actual native reduction so cancellation races publication.

    Args:
        queue: Supervised child result channel.
        operation: Explicit calculation dispatch.
        arguments: Native kernel inputs.
    """
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
        client, plan_calculation(client, selectedBounds=AREA, **expressions)
    )
    monkeypatch.setattr(worker_module, "aggregate_process_target", paused_calculation)
    if stop == "deadline":
        worker.limits = replace(worker.limits, runtime_seconds=2)

    async def exercise() -> None:
        """Cancel after the actual native child has produced its private output."""
        task = asyncio.create_task(worker.run_once())
        try:
            async with asyncio.timeout(10):
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
