"""Durable multi-session admission, fair claims and independent resource budgets."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import time
from typing import Any
from uuid import uuid4

import psycopg
import pytest

from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.models import Artifact, PreparedJobPlan, ProcessingError
from test_processing_jobs import boundary, store, clip_inputs, HEADERS
from test_processing_calculations import calculation_inputs


def make_plan(
    store: PostgresJobStore, owner: str, payload: str = "small"
) -> tuple[str, PreparedJobPlan]:
    """Store opaque prepared inputs without involving raster algorithms.

    Args:
        store: Empty disposable PostgreSQL store.
        owner: Session identity used by these storage-boundary tests.
        payload: Text retained in the operation specification.

    Returns:
        Plan ID and the immutable data admitted by its application owner.
    """
    plan = PreparedJobPlan({"input": payload}, {"label": "test"}, 1024)
    return payload, plan


def admit(
    store: PostgresJobStore, owner: str, plan: tuple[str, PreparedJobPlan]
) -> dict[str, Any]:
    """Submit one distinct request for prepared test inputs.

    Args:
        store: Disposable job store.
        owner: Session that owns the plan.
        plan: Prepared plan ID and data.

    Returns:
        Newly accepted job.

    Raises:
        ProcessingError: If an admission budget is exhausted.
    """
    return store.submit(owner, uuid4().hex, plan[1], "fixture-input-hash")


def finish(store: PostgresJobStore, job: dict[str, Any]) -> None:
    """Complete an attempt at the storage boundary without running native work.

    Args:
        store: Disposable job store.
        job: Claimed job whose attempt remains current.
    """
    assert store.finish(job["id"], job["attempt_id"], Artifact(1, "0" * 64, "test.csv"))


def test_twelve_sessions_and_full_stack_wait_then_take_turns(
    store: PostgresJobStore, caplog: pytest.LogCaptureFixture
) -> None:
    """Admit a 32-job stack plus twelve four-job bursts while execution is held.

    Args:
        store: Real PostgreSQL with deployment defaults.
        caplog: Captured backlog logs, excluding session IDs and input payloads.
    """
    caplog.set_level("INFO", logger="eolab_app.processing.job_store")
    blocker = admit(store, "blocker", make_plan(store, "blocker"))
    active = store.claim()
    assert active["id"] == blocker["id"]
    owners = ["stack", *(f"session-{index}" for index in range(12))]
    plans = {owner: make_plan(store, owner) for owner in owners}
    requests = ["stack"] * 32 + [owner for owner in owners[1:] for _ in range(4)]
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=12) as clients:
        jobs = list(
            clients.map(lambda owner: admit(store, owner, plans[owner]), requests)
        )
    admission_seconds = time.perf_counter() - started
    assert len(jobs) == 80 and all(job["status"] == "queued" for job in jobs)
    assert store.claim() is None
    assert "waiting=80/128" in caplog.text
    assert "waiting_sessions=13" in caplog.text

    finish(store, active)
    # A replacement worker uses the same durable turn history after deployment.
    worker_store = PostgresJobStore(store.limits, store.conninfo)
    expected = {
        owner: sorted(
            (job for job in jobs if job["owner"] == owner),
            key=lambda job: (job["created_at"], job["id"]),
        )
        for owner in owners
    }
    order = []
    drain_started = time.perf_counter()
    while (job := worker_store.claim()) is not None:
        owner = job["owner"]
        assert job["id"] == expected[owner].pop(0)["id"]
        assert job["started_at"] >= job["created_at"]
        order.append(owner)
        finish(worker_store, job)
    assert len(order) == 80
    # Every waiting session gets one turn in each of the first four rounds.
    for offset in range(0, 52, 13):
        assert set(order[offset : offset + 13]) == set(owners)
    assert order[52:] == ["stack"] * 28
    assert "queue_seconds=" in caplog.text
    assert all(owner not in caplog.text for owner in owners[1:])
    print(
        f"80 queued jobs, 13 waiting sessions: admission={admission_seconds:.3f}s; "
        f"claim/completion drain={time.perf_counter() - drain_started:.3f}s"
    )


@pytest.mark.parametrize(
    "changes,code",
    [
        ({"max_owner_waiting_jobs": 1}, "owner_queue_full"),
        ({"max_waiting_jobs": 1}, "queue_full"),
        ({"max_job_records": 1}, "job_record_capacity"),
        ({"max_job_input_bytes": 50}, "job_input_capacity"),
        ({"max_stored_bytes": 1024}, "storage_full"),
    ],
)
def test_each_budget_rejects_explicitly_and_idempotency_still_recovers(
    store: PostgresJobStore, changes: dict[str, int], code: str
) -> None:
    """Differentiate real exhaustion without rejecting retries of accepted jobs.

    Args:
        store: Disposable PostgreSQL store.
        changes: Budget made deliberately too small for a second job.
        code: Public error expected from that budget.
    """
    store.limits = replace(store.limits, **changes)
    plan = make_plan(store, "one")
    first = admit(store, "one", plan)
    assert first["input_bytes"] <= 50 < first["input_bytes"] * 2
    with pytest.raises(ProcessingError) as denied:
        admit(store, "one", plan)
    assert denied.value.code == code and denied.value.status == 429
    retried = store.submit("one", first["request_key"], plan[1], "fixture-input-hash")
    assert retried["id"] == first["id"]


def test_running_job_does_not_use_waiting_allowance_and_new_session_goes_next(
    store: PostgresJobStore,
) -> None:
    """Keep running capacity separate and schedule a newcomer before a stack tail.

    Args:
        store: Disposable PostgreSQL store.
    """
    store.limits = replace(store.limits, max_owner_waiting_jobs=2)
    plan = make_plan(store, "stack")
    admit(store, "stack", plan)
    active = store.claim()
    admit(store, "stack", plan)
    admit(store, "stack", plan)
    with pytest.raises(ProcessingError, match="waiting-job limit"):
        admit(store, "stack", plan)
    newcomer = admit(store, "newcomer", make_plan(store, "newcomer"))
    finish(store, active)
    with ThreadPoolExecutor(max_workers=2) as workers:
        claims = list(workers.map(lambda _: store.claim(), range(2)))
    assert sum(job is not None for job in claims) == 1
    claimed = next(job for job in claims if job)
    assert claimed["id"] == newcomer["id"]


def test_concurrent_owners_cannot_overfill_global_backlog(
    store: PostgresJobStore,
) -> None:
    """Serialize admission so excess concurrent requests get a clear overload error.

    Args:
        store: Disposable PostgreSQL with room for four waiting jobs.
    """
    store.limits = replace(store.limits, max_waiting_jobs=4)
    owners = [f"owner-{index}" for index in range(12)]
    plans = {owner: make_plan(store, owner) for owner in owners}

    def submit(owner: str) -> str:
        """Return the accepted job ID or classified overload for one session.

        Args:
            owner: Session submitting its own prepared plan.

        Returns:
            New ID or the explicit queue-full code.
        """
        try:
            return admit(store, owner, plans[owner])["id"]
        except ProcessingError as error:
            assert error.code == "queue_full" and error.status == 429
            return error.code

    with ThreadPoolExecutor(max_workers=12) as clients:
        results = list(clients.map(submit, owners))
    assert results.count("queue_full") == 8
    assert (
        len({identifier for identifier in results if identifier != "queue_full"}) == 4
    )


def test_duplicate_concurrent_submission_and_owner_cancel_are_isolated(
    store: PostgresJobStore,
) -> None:
    """Repeated submission creates one job; cancellation frees only its queue place.

    Args:
        store: Disposable PostgreSQL store.
    """
    plan = make_plan(store, "one")
    key = uuid4().hex
    with ThreadPoolExecutor(max_workers=12) as clients:
        jobs = list(
            clients.map(
                lambda _: store.submit("one", key, plan[1], "fixture-input-hash"),
                range(12),
            )
        )
    assert len({job["id"] for job in jobs}) == 1
    first = jobs[0]
    other = admit(store, "two", make_plan(store, "two"))
    with pytest.raises(ProcessingError) as denied:
        store.cancel(first["id"], "two")
    assert denied.value.code == "job_not_found"
    assert store.cancel(first["id"], "one")["status"] == "cancelled"
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT input_bytes,reserved_bytes FROM processing.jobs WHERE id=%s",
            (first["id"],),
        ).fetchone() == (first["input_bytes"], first["reserved_bytes"])
    # Only post-cleanup acknowledgement releases retained inputs/disk.
    store.cleaned(first["id"])
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT input_bytes,reserved_bytes FROM processing.jobs WHERE id=%s",
            (first["id"],),
        ).fetchone() == (0, 0)
    assert store.claim()["id"] == other["id"]
    assert (
        store.submit("one", key, plan[1], "fixture-input-hash")["status"] == "cancelled"
    )


def test_record_budget_keeps_recent_idempotency_but_prunes_old_cleaned_jobs(
    store: PostgresJobStore,
) -> None:
    """Record capacity recovers only after the existing seven-day retention ends.

    Args:
        store: Disposable PostgreSQL store.
    """
    store.limits = replace(store.limits, max_job_records=1)
    plan = make_plan(store, "owner")
    job = admit(store, "owner", plan)
    store.cancel(job["id"], "owner")
    store.cleaned(job["id"])
    with pytest.raises(ProcessingError) as denied:
        admit(store, "owner", plan)
    assert denied.value.code == "job_record_capacity"
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET updated_at=now()-interval '8 days' WHERE id=%s",
            (job["id"],),
        )
    assert admit(store, "owner", plan)["status"] == "queued"


def test_migration_accounts_for_previously_accepted_jobs(
    store: PostgresJobStore,
) -> None:
    """Existing queued/running inputs retain their budget and history after upgrade.

    Args:
        store: Disposable PostgreSQL store, rebuilt to the previous column shape.
    """
    plan = make_plan(store, "owner")
    first = admit(store, "owner", plan)
    active = store.claim()
    waiting = admit(store, "owner", plan)
    with psycopg.connect(store.conninfo) as connection:
        connection.execute("DROP VIEW processing.subscribed_jobs")
        connection.execute("ALTER TABLE processing.jobs DROP COLUMN input_bytes")
        connection.execute("ALTER TABLE processing.jobs DROP COLUMN started_at")
    store.migrate()
    store.migrate()
    with psycopg.connect(store.conninfo) as connection:
        rows = connection.execute(
            "SELECT id,input_bytes,started_at FROM processing.jobs ORDER BY created_at"
        ).fetchall()
    assert rows[0][1] == first["input_bytes"] and rows[0][2] is not None
    assert rows[1][0] == waiting["id"] and rows[1][2] is None
    assert store.claim() is None
    assert store.heartbeat(first["id"], active["attempt_id"], {})


def test_database_measures_retained_inputs_on_insert_and_cleanup(
    store: PostgresJobStore,
) -> None:
    """Count retained computation inputs independently of the supplied byte estimate.

    Args:
        store: Migrated PostgreSQL receiving the previous writer's column set.
    """
    with psycopg.connect(store.conninfo) as connection:
        row = connection.execute(
            "INSERT INTO processing.jobs "
            "(id,expires_at,status,spec,summary,reserved_bytes) "
            "VALUES (%s,now()+interval '1 day','queued',"
            '\'{"input":"retained"}\',\'{"label":"old"}\',1024) '
            "RETURNING id,input_bytes,octet_length(spec::text)+octet_length(summary::text)",
            (uuid4().hex,),
        ).fetchone()
        assert row[1] == row[2] > 0
        connection.execute(
            "UPDATE processing.jobs SET status='cancelled',reserved_bytes=0,spec=NULL "
            "WHERE id=%s",
            (row[0],),
        )
        assert connection.execute(
            "SELECT input_bytes FROM processing.jobs WHERE id=%s", (row[0],)
        ).fetchone() == (0,)


@pytest.mark.parametrize("operation", ["raster-clips", "raster-calculations"])
def test_clip_and_calculation_http_report_session_backlog(
    boundary: Any, store: PostgresJobStore, operation: str
) -> None:
    """Both public submission endpoints admit a burst and describe true exhaustion.

    Args:
        boundary: Real API, source authorization and Processing providers.
        store: Disposable PostgreSQL with a deliberately small waiting budget.
        operation: Public operation endpoint under test.
    """
    client, _, _, _, _ = boundary
    store.limits = replace(store.limits, max_owner_waiting_jobs=3)
    plan = (
        clip_inputs(client)
        if operation == "raster-clips"
        else calculation_inputs(client)
    )
    keys = [uuid4().hex for _ in range(4)]
    responses = [
        client.post(
            f"/api/processing/{operation}",
            json={**plan, "requestId": key},
            headers=HEADERS,
        )
        for key in keys
    ]
    assert [response.status_code for response in responses] == [202, 202, 202, 429]
    assert all(response.json()["status"] == "queued" for response in responses[:3])
    assert responses[-1].json()["detail"]["code"] == "owner_queue_full"
