"""Planning queue, cancellation and recovery through real PostgreSQL and HTTP."""

from concurrent.futures import ThreadPoolExecutor
import asyncio
from dataclasses import replace
from datetime import datetime, timezone
import time
import threading
import json
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from httpx2 import Response
import psycopg
import pytest

from eolab_app.processing.job_store import (
    PROCESSING_ADVISORY_LOCK_ID,
    PostgresJobStore,
)
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.planning_queue import PlanningQueue
from eolab_app.processing.job_notifications import (
    JOB_CHANGE_CHANNEL,
    PostgresNotifications,
)
from test_processing_jobs import boundary, store, HEADERS, AREA
from test_processing_calculations import request_body
from test_processing_calculations import plan_calculation, submit_calculation
import eolab_app.processing.service as service_module
from test_raster_clips import SOURCE


def wait_for_plan(
    client: TestClient,
    identifier: str,
    states: set[str],
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Wait for an owned HTTP plan to reach a state, with a test deadline.

    Args:
        client: Browser-session HTTP client.
        identifier: Admitted request ID.
        states: Acceptable final or intermediate states.
        headers: Optional cookie header representing another browser session.

    Returns:
        Matching public snapshot.

    Raises:
        AssertionError: If HTTP fails or the state does not arrive within 20 seconds.
    """
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        response = client.get(f"/api/processing/plans/{identifier}", headers=headers)
        assert response.status_code == 200, response.text
        snapshot = response.json()
        if snapshot["status"] in states:
            return snapshot
        assert snapshot["status"] not in {"failed", "cancelled"}, snapshot
        time.sleep(0.025)
    raise AssertionError(f"Plan did not reach {states}: {snapshot}")


def hold_planner(store: PostgresJobStore) -> str:
    """Reserve native capacity to reproduce overlapping HTTP requests deterministically.

    Args:
        store: Real isolated PostgreSQL store.

    Returns:
        Plan ID whose native reservation the test must settle.
    """
    identifier = store.reserve_plan("held", SOURCE)
    store.queue_native_plan(identifier, "held")
    assert store.claim_native_plan(identifier, "held")
    return identifier


def test_planning_changes_notify_the_owner_without_publishing_inputs(
    store: PostgresJobStore,
) -> None:
    """Queued, active and cancelled plans emit only owner-scoped refresh hints.

    Args:
        store: Real PostgreSQL store with the planning trigger installed.
    """

    async def scenario() -> None:
        """Observe committed planning changes through the production listener."""
        messages: asyncio.Queue[str] = asyncio.Queue()
        listener = PostgresNotifications(
            JOB_CHANGE_CHANNEL, messages.put_nowait, store.conninfo
        )
        await listener.ensure_connected()
        owner = "e" * 64
        identifier = store.reserve_plan(owner, SOURCE)
        try:
            store.queue_native_plan(identifier, owner)
            assert await asyncio.wait_for(messages.get(), 1) == owner
            assert store.claim_native_plan(identifier, owner)
            assert await asyncio.wait_for(messages.get(), 1) == owner
            store.discard_plan(identifier, owner)
            assert await asyncio.wait_for(messages.get(), 1) == owner
            store.settle_planning(identifier, owner, None)
            assert await asyncio.wait_for(messages.get(), 1) == owner
            store.discard_plan(identifier, owner)
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(messages.get(), 0.05)
        finally:
            await listener.close()

    with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
        runner.run(scenario())


def test_graceful_shutdown_awaits_cleanup_and_retains_an_interrupted_result(
    store: PostgresJobStore,
) -> None:
    """Stopping the app settles requests only after their active preparation exits.

    Args:
        store: Real PostgreSQL planning state.
    """

    async def scenario() -> None:
        """Start a held operation, stop its queue, and inspect its terminal record."""
        queue = PlanningQueue(store, store.limits)
        entered, cleaned = asyncio.Event(), asyncio.Event()
        identifier = uuid4().hex

        async def prepare(admission_seconds: float) -> dict[str, Any]:
            """Hold preparation until shutdown requests cancellation.

            Args:
                admission_seconds: Measured record admission duration.

            Returns:
                Never returns a value because this operation is deliberately held.

            Raises:
                asyncio.CancelledError: After simulated native cleanup completes.
            """
            async with queue.native_planner(identifier, "owner"):
                entered.set()
                try:
                    await asyncio.Future()
                finally:
                    await asyncio.sleep(0.02)
                    cleaned.set()

        await queue.start(identifier, "owner", SOURCE, prepare)
        await asyncio.wait_for(entered.wait(), 3)
        await queue.close()
        assert cleaned.is_set()
        snapshot = await queue.get(identifier, "owner")
        assert snapshot["status"] == "failed"
        assert snapshot["error"]["code"] == "planning_interrupted"
        assert store.get_planning(identifier, "owner")["planning_until"] is None

    asyncio.run(scenario())


def test_queue_wait_does_not_consume_the_active_planning_deadline(
    store: PostgresJobStore,
) -> None:
    """A wait longer than the execution limit still permits a short operation.

    Args:
        store: Real PostgreSQL store, including an independently held planner.
    """

    async def scenario() -> None:
        """Wait behind a held claim, then finish inside the active-work timeout."""
        limits = replace(store.limits, plan_timeout_seconds=0.5, plan_queue_seconds=3)
        queue = PlanningQueue(PostgresJobStore(limits, store.conninfo), limits)
        held = hold_planner(store)
        identifier = uuid4().hex

        async def prepare(admission_seconds: float) -> dict[str, Any]:
            """Return the measured queue wait after a brief admitted operation.

            Args:
                admission_seconds: Measured database admission duration.

            Returns:
                Measured time waiting for native capacity.
            """
            async with queue.native_planner(identifier, "owner") as waited:
                await asyncio.sleep(0.01)
                return {"waited": waited}

        try:
            await queue.start(identifier, "owner", SOURCE, prepare)
            await asyncio.sleep(0.7)
            assert (await queue.get(identifier, "owner"))["status"] == "queued"
            store.settle_planning(held, "held", None)
            queue.changed.set()
            result = await asyncio.wait_for(queue.wait(identifier, "owner"), 3)
            assert result["waited"] > limits.plan_timeout_seconds
        finally:
            await queue.close()

    asyncio.run(scenario())


def test_clip_and_calculation_wait_then_finish_with_fresh_expiry(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Independent HTTP owners queue both operations behind the same native planner.

    Args:
        boundary: Real app, sources and source authorization.
        store: Isolated PostgreSQL queue.
    """
    client, _, _, _, app = boundary
    held = hold_planner(store)
    first, second = uuid4().hex, uuid4().hex
    other = {**HEADERS, "Cookie": "__Host-eolab-processing=" + "b" * 64}
    started = time.monotonic()
    response = client.post(
        f"/api/processing/raster-calculations/plans/{first}",
        json=request_body(),
        headers=HEADERS,
    )
    assert response.status_code == 202, response.text
    assert time.monotonic() - started < 2  # Does not wait for our held native lane.
    assert (
        client.get(f"/api/processing/plans/{first}", headers=other).status_code == 404
    )
    wait_for_plan(client, first, {"queued"})
    response = client.post(
        f"/api/processing/raster-clips/plans/{second}",
        json={**SOURCE, "selectedBounds": AREA},
        headers=other,
    )
    assert response.status_code == 202, response.text
    wait_for_plan(client, second, {"queued"}, other)
    time.sleep(0.15)
    store.settle_planning(held, "held", None)
    calculation = wait_for_plan(client, first, {"ready"})["result"]
    clip = wait_for_plan(client, second, {"ready"}, other)["result"]
    assert calculation["timing"]["queueSeconds"] >= 0.15
    assert clip["queueSeconds"] >= 0.15
    assert (
        datetime.fromisoformat(clip["expiresAt"]) - datetime.now(timezone.utc)
    ).total_seconds() > store.limits.plan_ttl_seconds - 3
    retry = client.post(
        f"/api/processing/raster-calculations/plans/{first}",
        json=request_body(),
        headers=HEADERS,
    )
    assert retry.status_code == 202 and retry.json()["result"] == calculation
    conflict = client.post(
        f"/api/processing/raster-calculations/plans/{first}",
        json=request_body(wholeRaster=True),
        headers=HEADERS,
    )
    assert conflict.status_code == 409


def test_cancel_queued_and_uncertain_admission_without_starting_native_work(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Cancellation removes waiting work and a late POST cannot undo an earlier DELETE.

    Args:
        boundary: Real HTTP routes and source authorization.
        store: Isolated PostgreSQL queue.
    """
    client, _, _, _, _ = boundary
    held = hold_planner(store)
    identifier = uuid4().hex
    endpoint = f"/api/processing/raster-calculations/plans/{identifier}"
    assert (
        client.post(endpoint, json=request_body(), headers=HEADERS).status_code == 202
    )
    wait_for_plan(client, identifier, {"queued"})
    assert (
        client.delete(
            f"/api/processing/plans/{identifier}", headers=HEADERS
        ).status_code
        == 200
    )
    wait_for_plan(client, identifier, {"cancelled"})
    assert (
        client.post(endpoint, json=request_body(), headers=HEADERS).json()["status"]
        == "cancelled"
    )
    late = uuid4().hex
    assert (
        client.delete(f"/api/processing/plans/{late}", headers=HEADERS).status_code
        == 200
    )
    response = client.post(
        f"/api/processing/raster-calculations/plans/{late}",
        json=request_body(),
        headers=HEADERS,
    )
    assert response.status_code == 202 and response.json()["status"] == "cancelled"
    store.settle_planning(held, "held", None)
    assert not store.claim_native_plan(identifier, "held")


def test_lost_http_admission_response_can_be_recovered_without_duplicate_work(
    boundary: Any, store: PostgresJobStore
) -> None:
    """A disconnected POST response leaves one recoverable, cancellable request.

    Args:
        boundary: Real HTTP app and source authorization.
        store: Real PostgreSQL admission records.
    """
    client, _, _, _, app = boundary
    held = hold_planner(store)
    identifier = uuid4().hex
    path = f"/api/processing/raster-calculations/plans/{identifier}"
    headers = {**HEADERS, "Cookie": "__Host-eolab-processing=" + "d" * 64}

    async def lose_response() -> None:
        """Deliver the real POST but simulate a broken response transport."""
        delivered = False

        async def receive() -> dict[str, Any]:
            """Deliver request bytes once, then await the next transport event.

            Returns:
                ASGI request message containing the validated test body.
            """
            nonlocal delivered
            if not delivered:
                delivered = True
                return {
                    "type": "http.request",
                    "body": json.dumps(request_body()).encode(),
                    "more_body": False,
                }
            return await asyncio.Future()

        async def send(message: dict[str, Any]) -> None:
            """Reject response delivery after admission has committed.

            Args:
                message: Response headers or body from the real route.

            Raises:
                OSError: Simulated broken network connection.
            """
            raise OSError("Admission response connection lost")

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "https",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "server": ("testserver", 443),
            "client": ("127.0.0.1", 1234),
            "headers": [
                (b"host", b"testserver"),
                (b"content-type", b"application/json"),
                *[
                    (key.lower().encode(), value.encode())
                    for key, value in headers.items()
                ],
            ],
        }
        with pytest.raises(OSError, match="connection lost"):
            await app(scope, receive, send)

    client.portal.call(lose_response)
    wait_for_plan(client, identifier, {"queued"}, headers)
    retry = client.post(path, json=request_body(), headers=headers)
    assert retry.status_code == 202 and retry.json()["planId"] == identifier
    assert (
        client.delete(
            f"/api/processing/plans/{identifier}", headers=headers
        ).status_code
        == 200
    )
    wait_for_plan(client, identifier, {"cancelled"}, headers)
    store.settle_planning(held, "held", None)


def test_six_concurrent_calculations_from_one_session_can_repeat(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Six plans queue together and release their session capacity after submission.

    Args:
        boundary: Real HTTP routes, raster planning and calculation worker.
        store: Isolated PostgreSQL store using the deployment's default limits.
    """
    client, worker, _, _, _ = boundary
    client.get("/api/processing/jobs").raise_for_status()
    body = request_body()
    for batch in range(2):
        body["calculations"] = [{"label": "Mean", "expression": f"mean(a) + {batch}"}]
        held = hold_planner(store)
        identifiers = [uuid4().hex for _ in range(6)]

        def request_plan(identifier: str) -> Response:
            """Send a plan from the same established browser session.

            Args:
                identifier: Unique request ID retained for status and cleanup.

            Returns:
                HTTP response to the asynchronous planning request.
            """
            return client.post(
                f"/api/processing/raster-calculations/plans/{identifier}",
                json=body,
                headers=HEADERS,
            )

        try:
            with ThreadPoolExecutor(max_workers=6) as pool:
                responses = list(pool.map(request_plan, identifiers))
            assert [response.status_code for response in responses] == [202] * 6
            for identifier in identifiers:
                wait_for_plan(client, identifier, {"queued"})
        finally:
            store.settle_planning(held, "held", None)

        jobs = []
        for identifier in identifiers:
            plan = wait_for_plan(client, identifier, {"ready"})["result"]
            job = submit_calculation(client, plan)
            jobs.append(job)
            # CalculationExecutor releases the estimate as soon as submission
            # succeeds; the queued job retains the calculation it needs.
            assert (
                client.delete(
                    f"/api/processing/plans/{identifier}", headers=HEADERS
                ).status_code
                == 200
            )
        for _ in jobs:
            assert asyncio.run(worker.run_once())
        for job in jobs:
            result = client.get(f"/api/processing/jobs/{job['jobId']}").json()
            assert result["status"] == "ready", result


def test_ready_plans_still_obey_session_and_record_limits(
    store: PostgresJobStore,
) -> None:
    """Released estimates free the session allowance but retain bounded retry records.

    Args:
        store: Real PostgreSQL adapter shared by independent browser sessions.
    """
    limits = replace(store.limits, max_owner_plans=2, plan_record_capacity=3)
    adapter = PostgresJobStore(limits, store.conninfo)
    identifiers = [adapter.reserve_plan("owner", SOURCE) for _ in range(2)]
    for identifier in identifiers:
        adapter.settle_planning(identifier, "owner", {"estimate": 1})
    with pytest.raises(ProcessingError) as rejected:
        adapter.reserve_plan("owner", SOURCE)
    assert rejected.value.code == "plan_record_capacity"
    assert rejected.value.status == 429
    adapter.discard_plan(identifiers[0], "owner")
    adapter.reserve_plan("owner", SOURCE)
    with pytest.raises(ProcessingError) as rejected:
        adapter.reserve_plan("another", SOURCE)
    assert rejected.value.code == "plan_record_capacity"
    assert rejected.value.status == 429


def test_planning_capacity_and_fifo_claims_across_database_connections(
    store: PostgresJobStore,
) -> None:
    """A full pending queue rejects excess work but ordinary contention does not.

    Args:
        store: Real PostgreSQL adapter.
    """
    limits = replace(store.limits, plan_queue_capacity=3, max_owner_plans=3)
    adapters = [PostgresJobStore(limits, store.conninfo) for _ in range(4)]

    def admit(index: int) -> str:
        """Submit from one independent store connection.

        Args:
            index: Adapter and owner index.

        Returns:
            Admitted ID, or the classified overload code.
        """
        try:
            return adapters[index].reserve_plan(str(index), SOURCE)
        except ProcessingError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(admit, range(4)))
    assert results.count("plan_queue_full") == 1
    waiting = [
        (index, identifier)
        for index, identifier in enumerate(results)
        if identifier != "plan_queue_full"
    ]
    for index, identifier in waiting:
        adapters[index].queue_native_plan(identifier, str(index))
    first_owner, first = waiting[0]
    last_owner, last = waiting[-1]
    assert not adapters[last_owner].claim_native_plan(last, str(last_owner))
    assert adapters[first_owner].claim_native_plan(first, str(first_owner))
    adapters[first_owner].discard_plan(first, str(first_owner))
    assert store.get_planning(first, str(first_owner))["state"] == "cancelling"
    next_owner, next_id = waiting[1]
    assert not adapters[next_owner].claim_native_plan(next_id, str(next_owner))
    adapters[first_owner].settle_planning(first, str(first_owner), None)
    assert adapters[next_owner].claim_native_plan(next_id, str(next_owner))


def test_status_reads_do_not_wait_for_admission_lock(store: PostgresJobStore) -> None:
    """Concurrent status reads finish while admission is locked by another client.

    Args:
        store: Isolated PostgreSQL adapter.
    """
    identifier = store.reserve_plan("reader", SOURCE)
    with ThreadPoolExecutor(max_workers=25) as pool:
        with psycopg.connect(store.conninfo) as connection:
            connection.execute(
                "SELECT pg_advisory_xact_lock(%s)", (PROCESSING_ADVISORY_LOCK_ID,)
            )
            futures = [
                pool.submit(store.get_planning, identifier, "reader") for _ in range(25)
            ]
            for future in futures:
                assert future.result(timeout=2)["state"] == "checking"


@pytest.mark.parametrize("deadline", ["request_deadline", "planning_until"])
def test_status_reports_expiration_without_changing_records(
    store: PostgresJobStore, deadline: str
) -> None:
    """Reads report expired work immediately without expiring other owners' work.

    Args:
        store: Isolated PostgreSQL adapter.
        deadline: The request or native-planner deadline to expire.
    """
    identifier = store.reserve_plan("reader", SOURCE)
    other = store.reserve_plan("other", SOURCE)
    ready = store.reserve_plan("ready", SOURCE)
    store.settle_planning(ready, "ready", {"complete": True})
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            f"UPDATE processing.plans SET {deadline}=now()-interval '1 second'"
        )
        before = connection.execute(
            "SELECT * FROM processing.plans ORDER BY id"
        ).fetchall()
    snapshot = store.get_planning(identifier, "reader")
    assert snapshot["state"] == "failed"
    assert snapshot["error"]["code"] == "planning_interrupted"
    assert snapshot["planning_until"] is None
    assert "planning_expired" not in snapshot
    assert store.get_planning(ready, "ready")["state"] == "ready"
    with pytest.raises(ProcessingError) as unavailable:
        store.get_planning(other, "reader")
    assert unavailable.value.status == 404
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute("SELECT * FROM processing.plans ORDER BY id").fetchall()
            == before
        )
        connection.execute(
            "UPDATE processing.plans SET expires_at=now()-interval '1 second' WHERE id=%s",
            (identifier,),
        )
    with pytest.raises(ProcessingError) as unavailable:
        store.get_planning(identifier, "reader")
    assert unavailable.value.status == 404


def test_worker_cleanup_expires_abandoned_plans(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Worker maintenance expires abandoned plans but retains a live planner slot.

    Args:
        boundary: Real application and worker composition.
        store: Isolated PostgreSQL adapter.
    """
    _, worker, _, _, _ = boundary
    active = hold_planner(store)
    abandoned = store.reserve_plan("abandoned", SOURCE)
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.plans SET request_deadline=now()-interval '1 second' WHERE id=%s",
            (abandoned,),
        )
    asyncio.run(worker.cleanup())
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT state,planning_until,error->>'code' FROM processing.plans WHERE id=%s",
            (abandoned,),
        ).fetchone() == ("failed", None, "planning_interrupted")
    assert store.get_planning(active, "held")["state"] == "planning"
    assert store.get_planning(active, "held")["planning_until"] is not None


@pytest.mark.parametrize("finish_inputs", [False, True])
def test_completion_cannot_revive_expired_plan(
    store: PostgresJobStore, finish_inputs: bool
) -> None:
    """Late completion cannot publish success after read-only expiration reporting.

    Args:
        store: Isolated PostgreSQL adapter.
        finish_inputs: Whether operation inputs arrive before the public result.
    """
    identifier = hold_planner(store)
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.plans SET planning_until=now()-interval '1 second' WHERE id=%s",
            (identifier,),
        )
    assert store.get_planning(identifier, "held")["state"] == "failed"
    if finish_inputs:
        prepared = PreparedJobPlan(
            specification={"operation": "test.summary.v1"},
            summary={"label": "Test"},
            reserved_bytes=4096,
        )
        assert store.finish_plan(identifier, "held", prepared) is None
    store.settle_planning(identifier, "held", {"complete": True})
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT state,result,planning_until,spec FROM processing.plans WHERE id=%s",
            (identifier,),
        ).fetchone() == ("failed", None, None, None)


def test_abandoned_requests_and_queue_timeouts_are_observable(
    store: PostgresJobStore,
) -> None:
    """A restart never silently replays a plan; orphaned requests expire visibly.

    Args:
        store: Isolated PostgreSQL adapter.
    """
    abandoned = store.reserve_plan("one", SOURCE)
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.plans SET request_deadline=now()-interval '1 second' WHERE id=%s",
            (abandoned,),
        )
    restarted = PostgresJobStore(store.limits, store.conninfo)
    snapshot = restarted.get_planning(abandoned, "one")
    assert snapshot["state"] == "failed"
    assert snapshot["error"]["code"] == "planning_interrupted"
    queued = store.reserve_plan("two", SOURCE)
    store.queue_native_plan(queued, "two")
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.plans SET queued_at=now()-interval '2 minutes' WHERE id=%s",
            (queued,),
        )
    assert not store.claim_native_plan(queued, "two")
    assert store.get_planning(queued, "two")["error"]["code"] == "plan_queue_timeout"


def test_async_plan_routes_require_same_origin_and_valid_ids(
    boundary: Any, store: PostgresJobStore
) -> None:
    """New lifecycle routes preserve request and owner boundaries.

    Args:
        boundary: Real HTTP application.
        store: Explicit disposable database fixture.
    """
    client, _, _, _, _ = boundary
    path = f"/api/processing/raster-calculations/plans/{uuid4().hex}"
    assert client.post(path, json=request_body()).status_code == 403
    assert (
        client.post(
            path,
            json=request_body(),
            headers={**HEADERS, "Origin": "https://elsewhere"},
        ).status_code
        == 403
    )
    assert (
        client.post(path + "bad", json=request_body(), headers=HEADERS).status_code
        == 422
    )


def test_cached_calculation_bypasses_busy_native_planner(
    boundary: Any, store: PostgresJobStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An authorized cached result finishes while unrelated native work stays held.

    Args:
        boundary: Real HTTP, native calculation and numerical result cache.
        store: PostgreSQL plan and result records.
        monkeypatch: Prevent native calls on the cached path.
    """
    client, worker, _, _, _ = boundary
    submit_calculation(client, plan_calculation(client))
    assert asyncio.run(worker.run_once())
    held = hold_planner(store)

    async def forbid_native(*args: Any, **kwargs: Any) -> None:
        """Reject accidental native planning on a cache hit.

        Args:
            args: Native operation inputs.
            kwargs: Native operation options.

        Raises:
            AssertionError: Always, since the result is already cached.
        """
        raise AssertionError("Cached planning must skip native work")

    monkeypatch.setattr(service_module, "run_process", forbid_native)
    identifier = uuid4().hex
    assert (
        client.post(
            f"/api/processing/raster-calculations/plans/{identifier}",
            json=request_body(),
            headers=HEADERS,
        ).status_code
        == 202
    )
    result = wait_for_plan(client, identifier, {"ready"})["result"]
    assert result["cacheHit"] and result["timing"]["queueSeconds"] == 0
    assert store.get_planning(held, "held")["state"] == "planning"
    store.settle_planning(held, "held", None)


def test_active_cancellation_waits_for_native_cleanup_before_next_plan(
    boundary: Any, store: PostgresJobStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Queued work cannot enter the native runner while its predecessor is stopping.

    Args:
        boundary: Real service, HTTP routes and source authorization.
        store: PostgreSQL planner claims.
        monkeypatch: Hold the native boundary until cleanup is explicitly released.
    """
    client, _, _, _, _ = boundary
    original = service_module.run_process
    entered, stopping, release = threading.Event(), threading.Event(), threading.Event()
    calls = []

    async def controlled_native(*args: Any, **kwargs: Any) -> Any:
        """Delay one native call and its cleanup, then run later calls normally.

        Args:
            args: Production native operation and arguments.
            kwargs: Production runner options.

        Returns:
            Real native outcome for calls after the deliberately held first call.

        Raises:
            asyncio.CancelledError: For the first call, after cleanup is allowed.
        """
        calls.append(args)
        if len(calls) != 1:
            return await original(*args, **kwargs)
        entered.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            stopping.set()
            while not release.is_set():
                await asyncio.sleep(0.01)
            raise

    monkeypatch.setattr(service_module, "run_process", controlled_native)
    first, second = uuid4().hex, uuid4().hex
    try:
        assert (
            client.post(
                f"/api/processing/raster-calculations/plans/{first}",
                json=request_body(),
                headers=HEADERS,
            ).status_code
            == 202
        )
        assert entered.wait(3)
        assert (
            client.post(
                f"/api/processing/raster-calculations/plans/{second}",
                json=request_body(),
                headers=HEADERS,
            ).status_code
            == 202
        )
        wait_for_plan(client, second, {"queued"})
        assert (
            client.delete(f"/api/processing/plans/{first}", headers=HEADERS).status_code
            == 200
        )
        assert stopping.wait(3)
        assert (
            client.get(f"/api/processing/plans/{first}").json()["status"]
            == "cancelling"
        )
        time.sleep(0.3)
        assert len(calls) == 1
        assert (
            client.get(f"/api/processing/plans/{second}").json()["status"] == "queued"
        )
    finally:
        release.set()
    wait_for_plan(client, first, {"cancelled"})
    wait_for_plan(client, second, {"ready"})
    assert len(calls) == 2
