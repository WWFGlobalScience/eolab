"""Calculation API, real PostgreSQL admission, supervised worker, and downloads."""

import asyncio
from dataclasses import replace
import hashlib
from pathlib import Path
import time
from typing import Any
from unittest.mock import AsyncMock
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.processing.raster_aggregate import calculate_raster_statistics_for_area
import eolab_app.processing.worker as worker_module
from eolab_app.processing.models import Artifact, PreparedJobPlan
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


@pytest.mark.parametrize("batch", [False, True])
def test_submission_returns_committed_warm_worker_result(
    boundary: Any, store: Any, batch: bool
) -> None:
    """HTTP submission returns real results after PostgreSQL completion hints.

    Args:
        boundary: Real mounted raster, native worker and HTTP fixtures.
        store: Disposable PostgreSQL adapter with the real notification triggers.
        batch: Exercise the single endpoint or two jobs in the browser batch endpoint.
    """
    from fastapi import FastAPI
    from eolab_app.processing.job_events import PostgresJobEvents
    from eolab_app.processing.native_processes import create_native_process
    from eolab_app.processing.service import ProcessingService
    from eolab_app.routes.processing import create_processing_router

    _, worker, _, artifacts, _ = boundary
    hub = PostgresJobEvents(store.conninfo)
    service = ProcessingService(
        store, artifacts, changes=hub, submission_wait_seconds=0
    )
    app = FastAPI()
    app.include_router(create_processing_router(service))
    native = worker.native = create_native_process(store.limits)
    with TestClient(app, base_url="https://testserver") as client:
        client.portal.call(hub.listener.ensure_connected)
        primer = {
            **request_body(wholeRaster=True),
            "requestId": uuid4().hex,
            "calculations": [{"label": "Prime", "expression": "mean(a)+123"}],
        }
        assert client.post(ENDPOINT, json=primer, headers=HEADERS).status_code == 202
        assert client.portal.call(worker.run_once)
        service.submission_wait_seconds = 0.45
        items = [
            {
                **request_body(wholeRaster=True),
                "requestId": uuid4().hex,
                "calculations": [{"label": expression, "expression": expression}],
            }
            for expression in (["mean(a)", "max(a)"] if batch else ["mean(a)"])
        ]

        async def consume() -> None:
            """Claim and execute only the submitted fixture jobs on a warm lane."""
            completed = 0
            while completed < len(items):
                if await worker.run_once():
                    completed += 1
                else:
                    await asyncio.sleep(0.005)

        running = client.portal.start_task_soon(consume)
        try:
            path = ENDPOINT + "/batch" if batch else ENDPOINT
            body = {"items": items} if batch else items[0]
            response = client.post(path, json=body, headers=HEADERS)
            assert response.status_code == (200 if batch else 202), response.text
            jobs = (
                [item["job"] for item in response.json()["items"]]
                if batch
                else [response.json()]
            )
            assert [job["status"] for job in jobs] == ["ready"] * len(items)
            assert [
                float(job["result"]["rows"][0]["value"]) for job in jobs
            ] == pytest.approx([4999.5, 9999] if batch else [4999.5], abs=1e-10, rel=0)
            assert hub.count == 0
            running.result(timeout=5)
            retry = client.post(path, json=body, headers=HEADERS).json()
            retried = [item["job"] for item in retry["items"]] if batch else [retry]
            assert [job["jobId"] for job in retried] == [job["jobId"] for job in jobs]
            assert all(job["status"] == "ready" for job in retried)
        finally:
            running.cancel()
            client.portal.call(native.close)
            client.portal.call(hub.close)


@pytest.mark.parametrize(
    "limit,code",
    [
        ("max_waiting_jobs", "queue_full"),
        ("max_owner_waiting_jobs", "owner_queue_full"),
        ("max_job_records", "job_record_capacity"),
    ],
)
def test_batch_admission_is_one_transaction_with_partial_errors_and_safe_retries(
    boundary: Any, store: Any, monkeypatch: pytest.MonkeyPatch, limit: str, code: str
) -> None:
    """Batch admission counts once, preserves neighbors and recovers lost replies.

    Args:
        boundary: Real HTTP and Processing components.
        store: Disposable PostgreSQL adapter.
        monkeypatch: Observe transaction entry without replacing its behavior.
        limit: Capacity budget reduced to two records.
        code: Expected per-item capacity rejection.
    """
    from contextlib import contextmanager

    client, _, _, _, _ = boundary
    store.limits = replace(store.limits, **{limit: 2})
    transactions = []
    original = store._transaction

    @contextmanager
    def observe(acquire_lock: bool = False) -> Any:
        """Record the transaction contract while using the real database.

        Args:
            acquire_lock: Whether admission requests the shared lock.

        Yields:
            Real transactional cursor.
        """
        transactions.append(acquire_lock)
        with original(acquire_lock=acquire_lock) as cursor:
            yield cursor

    monkeypatch.setattr(store, "_transaction", observe)
    items = [
        {
            **request_body(wholeRaster=True),
            "requestId": uuid4().hex,
            "calculations": [{"label": "Result", "expression": expression}],
        }
        for expression in ["mean(a)", "bad(a)", "max(a)", "min(a)"]
    ]
    response = client.post(ENDPOINT + "/batch", json={"items": items}, headers=HEADERS)
    assert response.status_code == 200, response.text
    outcomes = response.json()["items"]
    assert transactions == [True]
    assert [item["index"] for item in outcomes] == [0, 1, 2, 3]
    assert outcomes[1]["error"]["status"] == 422
    assert outcomes[3]["error"]["code"] == code
    assert outcomes[3]["error"]["retryAfterSeconds"] == 5
    jobs = [outcomes[i]["job"] for i in [0, 2]]
    retry = client.post(
        ENDPOINT + "/batch", json={"items": items}, headers=HEADERS
    ).json()["items"]
    assert [retry[i]["job"]["jobId"] for i in [0, 2]] == [job["jobId"] for job in jobs]
    changed = {
        **items[0],
        "calculations": [{"label": "Changed", "expression": "sum(a)"}],
    }
    conflict = client.post(
        ENDPOINT + "/batch", json={"items": [changed]}, headers=HEADERS
    ).json()["items"][0]
    assert conflict["error"]["code"] == "request_conflict"
    assert (
        client.post(
            f"/api/processing/jobs/{jobs[0]['jobId']}/cancel", headers=HEADERS
        ).status_code
        == 202
    )
    if limit == "max_job_records":
        store.limits = replace(store.limits, max_job_records=3)
    accepted = client.post(
        ENDPOINT + "/batch", json={"items": [items[3]]}, headers=HEADERS
    ).json()["items"][0]
    assert accepted["job"]["status"] == "queued"


def test_batch_joins_duplicate_work_and_preserves_independent_ownership(
    boundary: Any, store: Any
) -> None:
    """Equal work shares execution across and within batches; handles stay owned.

    Args:
        boundary: Real HTTP, native worker and sources.
        store: Disposable PostgreSQL storage.
    """
    client, worker, _, _, app = boundary
    item = {**request_body(wholeRaster=True), "requestId": uuid4().hex}
    second = {**item, "requestId": uuid4().hex}
    outcomes = client.post(
        ENDPOINT + "/batch", json={"items": [item, item, second]}, headers=HEADERS
    ).json()["items"]
    first_id, repeated_id, second_id = [row["job"]["jobId"] for row in outcomes]
    assert first_id == repeated_id != second_id
    with TestClient(app, base_url="https://testserver") as other:
        foreign = other.post(
            ENDPOINT + "/batch", json={"items": [item]}, headers=HEADERS
        ).json()["items"][0]["job"]
        with psycopg.connect(store.conninfo) as connection:
            assert connection.execute(
                "SELECT count(*) FROM processing.jobs"
            ).fetchone() == (1,)
            assert connection.execute(
                "SELECT count(*) FROM processing.job_subscribers"
            ).fetchone() == (3,)
        assert client.get(f"/api/processing/jobs/{foreign['jobId']}").status_code == 404
        client.post(f"/api/processing/jobs/{first_id}/cancel", headers=HEADERS)
        assert asyncio.run(worker.run_once())
        assert (
            client.get(f"/api/processing/jobs/{second_id}").json()["status"] == "ready"
        )
        assert (
            other.get(f"/api/processing/jobs/{foreign['jobId']}").json()["status"]
            == "ready"
        )
        assert (
            client.get(f"/api/processing/jobs/{first_id}").json()["status"]
            == "cancelled"
        )


def test_batch_bounds_and_origin_checks_precede_admission(
    boundary: Any, store: Any
) -> None:
    """Reject oversized envelopes and hostile origins; isolate malformed items.

    Args:
        boundary: Real HTTP and Processing components.
        store: Disposable PostgreSQL to verify rejected envelopes create no work.
    """
    client, _, _, _, _ = boundary
    item = {**request_body(), "requestId": uuid4().hex}
    for items in [[], [item] * 51]:
        assert (
            client.post(
                ENDPOINT + "/batch", json={"items": items}, headers=HEADERS
            ).status_code
            == 422
        )
    assert (
        client.post(
            ENDPOINT + "/batch", content="x" * (802 * 1024), headers=HEADERS
        ).status_code
        == 413
    )
    assert client.post(ENDPOINT + "/batch", json={"items": [item]}).status_code == 403
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT count(*) FROM processing.jobs"
        ).fetchone() == (0,)
    reply = client.post(
        ENDPOINT + "/batch",
        json={"items": [None, {"huge": "x" * 17000}, item]},
        headers=HEADERS,
    ).json()["items"]
    assert [reply[i]["error"]["status"] for i in [0, 1]] == [422, 413]
    assert reply[2]["job"]["status"] == "queued"


def test_batch_retry_recovers_after_polygon_upload_expires(
    boundary: Any, store: Any
) -> None:
    """An accepted retry survives deletion of its temporary polygon reference.

    Args:
        boundary: Real HTTP and owned polygon-input storage.
        store: Disposable database shared by the request lifecycle.
    """
    client, _, _, _, _ = boundary
    area = client.post(
        "/api/processing/polygon-areas",
        json={
            "polygons": [
                {"type": "Polygon", "coordinates": [[[0, 9], [1, 9], [1, 10], [0, 9]]]}
            ]
        },
        headers=HEADERS,
    ).json()["polygonArea"]
    item = {**request_body(polygonArea=area), "requestId": uuid4().hex}
    first = client.post(
        ENDPOINT + "/batch", json={"items": [item]}, headers=HEADERS
    ).json()["items"][0]["job"]
    client.delete("/api/processing/polygon-areas/" + area["id"], headers=HEADERS)
    results = client.post(
        ENDPOINT + "/batch",
        json={"items": [item, {**item, "requestId": uuid4().hex}]},
        headers=HEADERS,
    ).json()["items"]
    assert results[0]["job"]["jobId"] == first["jobId"]
    assert results[1]["error"]["status"] == 409


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
    boundary: Any, store: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real native job survives reload and shares lifecycle without clip assumptions.

    Args:
        boundary: Real owners, native worker and HTTP app.
        store: Disposable PostgreSQL for deterministic expiry.
        monkeypatch: Observe the actual catalog source-authorization boundary.
    """
    client, worker, source, artifacts, app = boundary
    authorize = AsyncMock(wraps=worker.authorizer.authorize)
    monkeypatch.setattr(worker.authorizer, "authorize", authorize)
    plan = calculation_inputs(client, wholeRaster=True)
    key = uuid4().hex
    job = submit_calculation(client, plan, key)
    assert submit_calculation(client, plan, key)["jobId"] == job["jobId"]
    assert asyncio.run(worker.run_once())
    authorize.assert_awaited_once()
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


@pytest.mark.parametrize("remove_source", [False, True])
def test_summary_resolves_source_again_after_waiting_for_disk(
    boundary: Any,
    store: Any,
    monkeypatch: pytest.MonkeyPatch,
    remove_source: bool,
) -> None:
    """A queued prepared plan discards its source and revalidates on the next attempt.

    Args:
        boundary: Real HTTP, catalog authorization, native worker, and artifacts.
        store: Disposable PostgreSQL admission and prepared-plan storage.
        monkeypatch: Observe the actual source-authorization boundary.
        remove_source: Remove the fixture file during the wait to test rejection.
    """
    client, worker, source, _, _ = boundary
    blocker = store.submit("blocker", "blocker", PreparedJobPlan({}, {}, 1), "blocker")
    claimed = store.claim_next_job()
    assert store.finish(
        claimed["id"], claimed["attempt_id"], Artifact(1, "0" * 64, "blocker")
    )
    store.limits = replace(
        store.limits, max_stored_bytes=worker.aggregate_limits.result_reservation_bytes
    )
    authorize = AsyncMock(wraps=worker.authorizer.authorize)
    monkeypatch.setattr(worker.authorizer, "authorize", authorize)
    job = submit_calculation(client, calculation_inputs(client, wholeRaster=True))
    url = f"/api/processing/jobs/{job['jobId']}"
    assert asyncio.run(worker.run_once())
    waiting = client.get(url).json()
    assert waiting["status"] == "queued" and waiting["grid"] is not None
    authorize.assert_awaited_once()
    with psycopg.connect(store.conninfo) as connection:
        specification = connection.execute(
            "SELECT spec FROM processing.jobs WHERE id=%s", (job["jobId"],)
        ).fetchone()[0]
    assert "request" not in specification
    assert str(source) not in str(specification)
    assert not asyncio.run(worker.run_once())
    store.cancel(blocker["id"], "blocker", delete=True)
    store.cleaned(blocker["job_id"])
    if remove_source:
        source.unlink()
    assert asyncio.run(worker.run_once())
    assert authorize.await_count == 2
    completed = client.get(url).json()
    assert completed["status"] == ("failed" if remove_source else "ready")
    assert str(source) not in str(completed)
    if not remove_source:
        assert completed["result"]["rows"][0]["value"] == "4999"


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
        ).fetchall() == [(n,) for n in range(1, 15)]
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
