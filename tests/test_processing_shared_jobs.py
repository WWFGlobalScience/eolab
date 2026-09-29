"""Identical callers share native work while retaining independent job handles."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import time
from typing import Any
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from eolab_app.processing.models import Artifact, PreparedJobPlan, ProcessingError
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.shared_calculations import identify_shared_calculation
from eolab_app.processing.aggregate_models import (
    AggregatePlanRequest,
    UnpreparedCalculation,
)
from eolab_app.processing.job_notifications import (
    JOB_CHANGE_CHANNEL,
    PostgresNotifications,
)
import eolab_app.processing.worker as worker_module
from test_processing_jobs import boundary, store, clip_inputs, HEADERS
from test_processing_calculations import request_body, ENDPOINT


def test_concurrent_subscribers_share_one_claim_and_reservation(
    store: PostgresJobStore,
) -> None:
    """Twelve simultaneous callers reserve and execute one computation.

    Args:
        store: Disposable PostgreSQL adapter.
    """
    plan = PreparedJobPlan({"input": "same"}, {}, 1024, work_key="same")
    store.limits = replace(store.limits, max_waiting_jobs=1, max_stored_bytes=1024)
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=12) as clients:
        jobs = list(
            clients.map(
                lambda index: store.submit(str(index), "request", plan, "hash"),
                range(12),
            )
        )
    assert len({job["id"] for job in jobs}) == 12
    assert len({job["job_id"] for job in jobs}) == 1
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT count(*),sum(reserved_bytes) FROM processing.jobs"
        ).fetchone() == (1, 1024)
    claimed = store.claim()
    assert store.claim() is None
    assert store.finish(
        claimed["id"], claimed["attempt_id"], Artifact(1, "0" * 64, "test.csv")
    )
    assert all(
        store.get(job["id"], str(index))["status"] == "ready"
        for index, job in enumerate(jobs)
    )
    assert store.claim() is None
    print(f"12 concurrent subscribers, 1 claim: {time.perf_counter() - started:.3f}s")


@pytest.mark.parametrize("running", [False, True])
def test_only_last_cancellation_stops_shared_work(
    store: PostgresJobStore, running: bool
) -> None:
    """Leaving shared work neither cancels another subscriber nor permits late publication.

    Args:
        store: Disposable PostgreSQL adapter.
        running: Cancel before or after the worker claims execution.
    """
    plan = PreparedJobPlan({}, {}, 1024, work_key="same")
    first = store.submit("first", "one", plan, "hash")
    second = store.submit("second", "two", plan, "hash")
    claimed = store.claim() if running else None
    assert store.cancel(first["id"], "first")["status"] == "cancelled"
    assert store.get(second["id"], "second")["status"] == (
        "running" if running else "queued"
    )
    if running:
        assert store.heartbeat(claimed["id"], claimed["attempt_id"], {})
    with pytest.raises(ProcessingError) as denied:
        store.cancel(second["id"], "first")
    assert denied.value.status == 404
    assert store.cancel(second["id"], "second")["status"] == (
        "cancelling" if running else "cancelled"
    )
    if running:
        assert store.get(first["id"], "first")["status"] == "cancelled"
        assert not store.heartbeat(claimed["id"], claimed["attempt_id"], {})
        assert store.finish(claimed["id"], claimed["attempt_id"], None)
    assert store.claim() is None
    replacement = store.submit("third", "three", plan, "hash")
    assert replacement["job_id"] != first["job_id"]


@pytest.mark.parametrize("operation", ["summary", "clip"])
def test_two_browsers_join_during_preparation_and_download_independently(
    boundary: Any,
    store: PostgresJobStore,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    """Run exactly one native preparation and execution for two real HTTP callers.

    Args:
        boundary: Real API, source, artifacts and native worker.
        store: Disposable PostgreSQL adapter.
        monkeypatch: Observe native calls and join a second browser during preparation.
        operation: Summary CSV or clipped GeoTIFF.
    """
    first, worker, _, _, app = boundary
    endpoint = ENDPOINT if operation == "summary" else "/api/processing/raster-clips"
    inputs = request_body() if operation == "summary" else clip_inputs(first)
    one = first.post(
        endpoint, json={**inputs, "requestId": uuid4().hex}, headers=HEADERS
    ).json()
    native = worker_module.run_process
    calls = []
    joined = {}
    with TestClient(app, base_url="https://testserver") as second:
        other_inputs = {**inputs}
        if operation == "summary":
            other_inputs["calculations"] = [
                {**item, "label": f"Other {index}"}
                for index, item in enumerate(inputs["calculations"])
            ]

        async def observe_native(target: Any, args: tuple, *rest: Any) -> Any:
            """Join another browser once the first preparation has started.

            Args:
                target: Native function supplied by Processing.
                args: Operation and validated inputs.
                rest: Deadline and process provider.

            Returns:
                Unmodified native operation result.
            """
            calls.append(args[0])
            if len(calls) == 1:
                response = second.post(
                    endpoint,
                    json={**other_inputs, "requestId": uuid4().hex},
                    headers=HEADERS,
                )
                assert response.status_code == 202, response.text
                joined.update(response.json())
                assert joined["status"] == "running"
            return await native(target, args, *rest)

        monkeypatch.setattr(worker_module, "run_process", observe_native)
        assert asyncio.run(worker.run_once())
        assert calls == ["plan", "calculate" if operation == "summary" else "clip"]
        assert not asyncio.run(worker.run_once())
        assert one["jobId"] != joined["jobId"]
        assert first.get(f"/api/processing/jobs/{joined['jobId']}").status_code == 404
        results = []
        for client, job, expected in (
            (first, one, inputs),
            (second, joined, other_inputs),
        ):
            ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
            assert ready["status"] == "ready", ready
            result = ready["result"]
            downloaded = client.get(result["url"])
            assert downloaded.status_code == 200
            assert len(downloaded.content) == result["bytes"]
            assert hashlib.sha256(downloaded.content).hexdigest() == result["sha256"]
            assert (
                client.get(result["url"], headers={"Range": "bytes=0-19"}).content
                == downloaded.content[:20]
            )
            provenance = client.get(result["provenanceUrl"]).json()
            if operation == "summary":
                assert ready["calculations"] == expected["calculations"]
                assert provenance["calculations"] == expected["calculations"]
                assert [row["label"] for row in result["rows"]] == [
                    item["label"] for item in expected["calculations"]
                ]
                assert provenance["sha256"] == result["sha256"]
                assert (
                    client.get(
                        result["url"], headers={"Range": "bytes=99999999-"}
                    ).status_code
                    == 416
                )
            results.append(result)
        first.delete(f"/api/processing/jobs/{one['jobId']}", headers=HEADERS)
        asyncio.run(worker.cleanup())
        assert second.get(results[1]["url"]).status_code == 200
        second.delete(f"/api/processing/jobs/{joined['jobId']}", headers=HEADERS)
        asyncio.run(worker.cleanup())
        assert second.get(results[1]["url"]).status_code == 409


def test_work_identity_includes_computation_and_ignores_labels(
    store: PostgresJobStore,
) -> None:
    """Different source, area or formula cannot join identical work.

    Args:
        store: Disposable database used by the complete integration lane.
    """
    inputs = request_body()

    def key(payload: dict[str, Any]) -> str:
        """Validate request inputs and return their computation hash.

        Args:
            payload: Public summary request without a browser retry key.

        Returns:
            Stable complete computation hash.
        """
        return identify_shared_calculation(
            UnpreparedCalculation(request=AggregatePlanRequest.model_validate(payload))
        )

    original = key(inputs)
    renamed = [
        {**item, "label": f"Another label {index}"}
        for index, item in enumerate(inputs["calculations"])
    ]
    assert key({**inputs, "calculations": renamed}) == original
    assert (
        key({**inputs, "calculations": [{"label": "Mean", "expression": "mean(a)"}]})
        != original
    )
    assert key(request_body(wholeRaster=True)) != original
    assert (
        key(
            {
                **inputs,
                "sources": {
                    "a": {**inputs["sources"]["a"], "itemId": "geotiff-" + "f" * 24}
                },
            }
        )
        != original
    )


def test_polygon_inputs_are_authorized_before_joining(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Identical owned uploads join, but knowing another browser's upload ID grants no access.

    Args:
        boundary: Real upload and calculation HTTP routes.
        store: Disposable PostgreSQL adapter.
    """
    first, _, _, _, app = boundary
    polygons = {
        "polygons": [
            {
                "type": "Polygon",
                "coordinates": [[[0.1, 9.1], [0.9, 9.1], [0.9, 9.9], [0.1, 9.1]]],
            }
        ]
    }
    reference = first.post(
        "/api/processing/polygon-areas", json=polygons, headers=HEADERS
    ).json()["polygonArea"]
    inputs = request_body(polygonArea=reference)
    one = first.post(
        ENDPOINT, json={**inputs, "requestId": uuid4().hex}, headers=HEADERS
    )
    assert one.status_code == 202
    with TestClient(app, base_url="https://testserver") as second:
        denied = second.post(
            ENDPOINT, json={**inputs, "requestId": uuid4().hex}, headers=HEADERS
        )
        assert denied.status_code == 409
        own_reference = second.post(
            "/api/processing/polygon-areas", json=polygons, headers=HEADERS
        ).json()["polygonArea"]
        assert own_reference["id"] != reference["id"]
        accepted = second.post(
            ENDPOINT,
            json={**request_body(polygonArea=own_reference), "requestId": uuid4().hex},
            headers=HEADERS,
        )
        assert accepted.status_code == 202, accepted.text
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT count(*) FROM processing.jobs"
        ).fetchone() == (1,)


def test_upgrade_preserves_existing_owner_handles(store: PostgresJobStore) -> None:
    """Move old owner fields into subscriptions without changing public IDs or ready files.

    Args:
        store: Disposable PostgreSQL rebuilt to the previous ownership layout.
    """
    plan = PreparedJobPlan({}, {}, 1024)
    one = store.submit("first", "one", plan, "hash")
    claimed = store.claim()
    store.finish(
        claimed["id"], claimed["attempt_id"], Artifact(1, "0" * 64, "test.csv")
    )
    two = store.submit("second", "two", plan, "other-hash")
    with psycopg.connect(store.conninfo) as connection:
        connection.execute("DROP VIEW processing.subscribed_jobs")
        connection.execute(
            "ALTER TABLE processing.jobs ADD COLUMN owner text, ADD COLUMN request_key text, ADD COLUMN request_hash text"
        )
        connection.execute(
            "UPDATE processing.jobs j SET owner=s.owner,request_key=s.request_key,request_hash=s.request_hash FROM processing.job_subscribers s WHERE s.job_id=j.id"
        )
        connection.execute("DROP TABLE processing.job_subscribers")
    store.migrate()
    store.migrate()
    assert store.get(one["id"], "first")["status"] == "ready"
    assert store.find_request("second", "two")["id"] == two["id"]
    assert store.interrupt_unfinished_jobs_on_restart() == 1
    assert store.get(two["id"], "second")["status"] == "interrupted"
    assert store.get(one["id"], "first")["artifact"]["filename"] == "test.csv"


def test_shared_progress_notifies_each_subscriber(store: PostgresJobStore) -> None:
    """One computation update sends refresh hints to both independent browser owners.

    Args:
        store: Disposable PostgreSQL including real committed notification triggers.
    """
    plan = PreparedJobPlan({}, {}, 1024, work_key="same")
    store.submit("first", "one", plan, "hash")
    store.submit("second", "two", plan, "hash")

    async def scenario() -> None:
        """Observe fanout from a real worker claim and committed completion."""
        messages = asyncio.Queue()
        listener = PostgresNotifications(
            JOB_CHANGE_CHANNEL, messages.put_nowait, store.conninfo
        )
        await listener.ensure_connected()
        try:
            claimed = await asyncio.to_thread(store.claim)
            assert {await asyncio.wait_for(messages.get(), 2) for _ in range(2)} == {
                "first",
                "second",
            }
            await asyncio.to_thread(
                store.finish,
                claimed["id"],
                claimed["attempt_id"],
                Artifact(1, "0" * 64, "test.csv"),
            )
            assert {await asyncio.wait_for(messages.get(), 2) for _ in range(2)} == {
                "first",
                "second",
            }
        finally:
            await listener.close()

    with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
        runner.run(scenario())


@pytest.mark.parametrize("ending", ["failure", "restart"])
def test_shared_failure_and_restart_allow_fresh_work(
    store: PostgresJobStore, ending: str
) -> None:
    """Subscribers see the same failure and fresh retries get a new fenced attempt.

    Args:
        store: Disposable PostgreSQL adapter.
        ending: A failed native operation or deployment interrupting execution.
    """
    plan = PreparedJobPlan({}, {}, 1024, work_key="same")
    one = store.submit("first", "one", plan, "hash")
    two = store.submit("second", "two", plan, "hash")
    claimed = store.claim()
    if ending == "failure":
        assert store.finish(
            claimed["id"],
            claimed["attempt_id"],
            None,
            {"code": "failed", "detail": "Calculation failed"},
        )
    else:
        assert store.interrupt_unfinished_jobs_on_restart() == 1
    expected = "failed" if ending == "failure" else "interrupted"
    assert store.get(one["id"], "first")["status"] == expected
    assert store.get(two["id"], "second")["status"] == expected
    retry = store.submit("second", "fresh", plan, "hash")
    assert retry["job_id"] != one["job_id"]
    assert not store.finish(
        claimed["id"], claimed["attempt_id"], Artifact(1, "late", "late.csv")
    )
    assert store.claim()["id"] == retry["job_id"]


def test_cancellation_racing_a_new_subscriber_keeps_new_work_live(
    store: PostgresJobStore,
) -> None:
    """Atomic admission either joins before cancellation or creates a fresh computation.

    Args:
        store: Disposable PostgreSQL adapter.
    """
    plan = PreparedJobPlan({}, {}, 1024, work_key="same")
    one = store.submit("first", "one", plan, "hash")
    with ThreadPoolExecutor(max_workers=2) as clients:
        cancelled = clients.submit(store.cancel, one["id"], "first")
        joined = clients.submit(store.submit, "second", "two", plan, "hash")
        assert cancelled.result()["status"] == "cancelled"
        two = joined.result()
    assert store.get(two["id"], "second")["status"] == "queued"
    assert store.claim()["id"] == two["job_id"]
    assert store.claim() is None
