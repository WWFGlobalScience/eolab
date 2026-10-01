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
    store: PostgresJobStore,
    caplog: pytest.LogCaptureFixture,
    request: pytest.FixtureRequest,
) -> None:
    """Admit a 32-job stack plus twelve four-job bursts while execution is held.

    Args:
        store: Real PostgreSQL with deployment defaults.
        caplog: Captured backlog logs, excluding session IDs and input payloads.
        request: Owns cleanup of the replacement worker adapter.
    """
    caplog.set_level("INFO", logger="eolab_app.processing.job_store")
    blocker = admit(store, "blocker", make_plan(store, "blocker"))
    active = store.claim_next_job()
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
    assert store.claim_next_job() is None
    assert "waiting=80/128" in caplog.text
    assert "waiting_sessions=13" in caplog.text

    finish(store, active)
    # A replacement worker uses the same durable turn history after deployment.
    worker_store = PostgresJobStore(store.limits, store.conninfo)
    request.addfinalizer(worker_store.close)
    worker_store.open()
    expected = {
        owner: sorted(
            (job for job in jobs if job["owner"] == owner),
            key=lambda job: (job["created_at"], job["id"]),
        )
        for owner in owners
    }
    order = []
    drain_started = time.perf_counter()
    while (job := worker_store.claim_next_job()) is not None:
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
    active = store.claim_next_job()
    admit(store, "stack", plan)
    admit(store, "stack", plan)
    with pytest.raises(ProcessingError, match="waiting-job limit"):
        admit(store, "stack", plan)
    newcomer = admit(store, "newcomer", make_plan(store, "newcomer"))
    finish(store, active)
    with ThreadPoolExecutor(max_workers=2) as workers:
        claims = list(workers.map(lambda _: store.claim_next_job(), range(2)))
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
            "SELECT spec,reserved_bytes FROM processing.jobs WHERE id=%s",
            (first["id"],),
        ).fetchone() == (plan[1].specification, first["reserved_bytes"])
    # Only post-cleanup acknowledgement releases retained inputs/disk.
    store.cleaned(first["id"])
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT spec,reserved_bytes FROM processing.jobs WHERE id=%s",
            (first["id"],),
        ).fetchone() == (None, 0)
    assert store.claim_next_job()["id"] == other["id"]
    assert (
        store.submit("one", key, plan[1], "fixture-input-hash")["status"] == "cancelled"
    )


def test_record_capacity_recovers_after_worker_maintenance(
    store: PostgresJobStore,
) -> None:
    """Submission retains expired history until worker maintenance reclaims it.

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
    with pytest.raises(ProcessingError) as awaiting_maintenance:
        admit(store, "owner", plan)
    assert awaiting_maintenance.value.code == "job_record_capacity"
    assert store.find_request("owner", job["request_key"]) is not None
    assert store.cleanup_candidates() == []
    assert store.find_request("owner", job["request_key"]) is None
    assert admit(store, "owner", plan)["status"] == "queued"


@pytest.mark.parametrize(
    "age_seconds,status,reserved_bytes,has_spec,transfer_seconds,pruned",
    [
        (604740, "cancelled", 0, False, None, False),
        (604860, "cancelled", 0, False, None, True),
        (604860, "cancelled", 0, False, 3600, False),
        (604860, "cancelled", 0, False, -60, True),
        (604860, "cancelled", 1, False, None, False),
        (604860, "cancelled", 0, True, None, False),
        (604860, "queued", 0, False, None, False),
        (604860, "running", 0, False, None, False),
        (604860, "cancelling", 0, False, None, False),
        (604860, "ready", 0, False, None, False),
    ],
)
def test_maintenance_prunes_only_old_cleaned_terminal_records(
    store: PostgresJobStore,
    age_seconds: int,
    status: str,
    reserved_bytes: int,
    has_spec: bool,
    transfer_seconds: int | None,
    pruned: bool,
) -> None:
    """Protect recent identities, active jobs, retained files and download leases.

    Args:
        store: Disposable PostgreSQL store.
        age_seconds: Time since the retained job's last update.
        status: Persisted lifecycle state to protect or prune.
        reserved_bytes: Disk reservation still owned by this job.
        has_spec: Whether operation inputs still await file cleanup.
        transfer_seconds: Remaining transfer lifetime, or no transfer.
        pruned: Whether this record is eligible for removal.
    """
    job = admit(store, "owner", make_plan(store, "owner"))
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET status=%s,reserved_bytes=%s,"
            "spec=CASE WHEN %s THEN spec ELSE NULL END,"
            "updated_at=now()-%s*interval '1 second' WHERE id=%s",
            (status, reserved_bytes, has_spec, age_seconds, job["job_id"]),
        )
        if transfer_seconds is not None:
            connection.execute(
                "INSERT INTO processing.transfers(id,job_id,expires_at) "
                "VALUES (%s,%s,now()+%s*interval '1 second')",
                (uuid4().hex, job["job_id"], transfer_seconds),
            )
    store.cleanup_candidates()
    assert (store.find_request("owner", job["request_key"]) is None) == pruned
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT count(*) FROM processing.jobs WHERE id=%s", (job["job_id"],)
        ).fetchone() == (0 if pruned else 1,)


def test_cleanup_acknowledgement_does_not_prune_other_jobs(
    store: PostgresJobStore,
) -> None:
    """Acknowledging one removed artifact must not sweep global job history.

    Args:
        store: Disposable PostgreSQL store.
    """
    plan = make_plan(store, "owner")
    old = admit(store, "owner", plan)
    store.cancel(old["id"], "owner")
    store.cleaned(old["job_id"])
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET updated_at=now()-interval '8 days' WHERE id=%s",
            (old["job_id"],),
        )
    new = admit(store, "owner", plan)
    store.cancel(new["id"], "owner")
    store.cleaned(new["job_id"])
    assert store.find_request("owner", old["request_key"]) is not None
    store.cleanup_candidates()
    assert store.find_request("owner", old["request_key"]) is None
    assert store.find_request("owner", new["request_key"]) is not None


def test_concurrent_maintenance_and_submission_preserve_record_limit(
    store: PostgresJobStore,
) -> None:
    """Maintenance and submissions serialize record reclamation and admission.

    Args:
        store: Disposable PostgreSQL store.
    """
    store.limits = replace(store.limits, max_job_records=1)
    plan = make_plan(store, "owner")
    old = admit(store, "owner", plan)
    store.cancel(old["id"], "owner")
    store.cleaned(old["job_id"])
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET updated_at=now()-interval '8 days' WHERE id=%s",
            (old["job_id"],),
        )
    with ThreadPoolExecutor(max_workers=8) as clients:
        requests = [clients.submit(admit, store, "owner", plan) for _ in range(12)]
        maintenance = clients.submit(store.cleanup_candidates)
        maintenance.result()
        accepted = []
        for request in requests:
            try:
                accepted.append(request.result())
            except ProcessingError as error:
                assert error.code == "job_record_capacity"
    if not accepted:
        accepted.append(admit(store, "owner", plan))
    assert len(accepted) == 1
    assert store.find_request("owner", old["request_key"]) is None
    assert store.find_request("owner", accepted[0]["request_key"]) is not None
    with pytest.raises(ProcessingError) as full:
        admit(store, "owner", plan)
    assert full.value.code == "job_record_capacity"


def test_migration_removes_metadata_accounting_and_preserves_jobs(
    store: PostgresJobStore,
) -> None:
    """Remove the old byte column, trigger and dependent view without losing jobs.

    Args:
        store: Disposable PostgreSQL store, rebuilt to the previous column shape.
    """
    plan = make_plan(store, "owner")
    first = admit(store, "owner", plan)
    active = store.claim_next_job()
    waiting = admit(store, "owner", plan)
    with psycopg.connect(store.conninfo) as connection:
        connection.execute("DROP VIEW processing.subscribed_jobs")
        connection.execute(
            "ALTER TABLE processing.jobs ADD COLUMN input_bytes bigint NOT NULL DEFAULT 0"
        )
        connection.execute(
            "CREATE FUNCTION processing.measure_job_input_bytes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.input_bytes := octet_length(NEW.spec::text); RETURN NEW; END $$"
        )
        connection.execute(
            "CREATE TRIGGER processing_job_input_bytes BEFORE INSERT OR UPDATE OF spec,summary ON processing.jobs FOR EACH ROW EXECUTE FUNCTION processing.measure_job_input_bytes()"
        )
        connection.execute(
            "CREATE OR REPLACE VIEW processing.subscribed_jobs AS SELECT s.*, j.input_bytes FROM processing.job_subscribers s JOIN processing.jobs j ON j.id=s.job_id"
        )
    store.migrate()
    store.migrate()
    with psycopg.connect(store.conninfo) as connection:
        rows = connection.execute(
            "SELECT id,spec,started_at FROM processing.jobs ORDER BY created_at"
        ).fetchall()
        assert (
            connection.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_schema='processing' AND table_name='jobs' AND column_name='input_bytes'"
            ).fetchone()
            is None
        )
        assert connection.execute(
            "SELECT to_regprocedure('processing.measure_job_input_bytes()')"
        ).fetchone() == (None,)
        assert (
            connection.execute(
                "SELECT 1 FROM pg_trigger WHERE tgrelid='processing.jobs'::regclass AND tgname='processing_job_input_bytes'"
            ).fetchone()
            is None
        )
    assert rows[0][1] == plan[1].specification and rows[0][2] is not None
    assert rows[1][0] == waiting["id"] and rows[1][2] is None
    assert store.claim_next_job() is None
    assert store.heartbeat(first["id"], active["attempt_id"], {})


def test_submission_defers_disk_admission_until_preparation(
    store: PostgresJobStore,
) -> None:
    """Admit an unprepared request with full disk reservations, then wait for space.

    Args:
        store: Disposable PostgreSQL with one retained result using its disk budget.
    """
    store.limits = replace(
        store.limits, max_stored_bytes=2048, result_metadata_reservation_bytes=2047
    )
    retained = admit(store, "first", make_plan(store, "first"))
    finish(store, store.claim_next_job())
    # Lowering the budget below retained files must not reject an unprepared request.
    store.limits = replace(store.limits, max_stored_bytes=1024)
    pending = store.submit("second", "new", PreparedJobPlan({}, {}, 0), "hash")
    assert store.claim_next_job() is None
    store.limits = replace(store.limits, max_stored_bytes=2048)
    claimed = store.claim_next_job()
    prepared = PreparedJobPlan({"input": "prepared"}, {}, 2048)
    waiting = store.save_prepared_job(
        claimed["id"], claimed["attempt_id"], prepared, {}
    )
    assert waiting["status"] == "queued" and waiting["reserved_bytes"] == 0
    assert store.claim_next_job() is None
    store.cancel(retained["id"], "first", delete=True)
    store.cleaned(retained["id"])
    assert store.claim_next_job()["id"] == pending["job_id"]


def test_identical_work_with_a_lost_lease_can_retry_after_attempt_stops(
    store: PostgresJobStore,
) -> None:
    """Distinguish a stopping identical attempt from a full queue.

    Args:
        store: Disposable PostgreSQL retaining the old worker's execution slot.
    """
    plan = PreparedJobPlan({}, {}, 0, work_key="same-work")
    first = store.submit("first", "one", plan, "hash")
    claimed = store.claim_next_job()
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET lease_until=now()-interval '1 second' WHERE id=%s",
            (claimed["id"],),
        )
    with pytest.raises(ProcessingError) as denied:
        store.submit("second", "two", plan, "hash")
    assert denied.value.code == "previous_attempt_stopping"
    assert denied.value.status == 429
    assert (
        denied.value.detail
        == "Waiting for the previous attempt to stop. Retrying shortly."
    )
    assert store.find_request("second", "two") is None
    store.interrupt_unfinished_jobs_on_restart()
    retry = store.submit("second", "two", plan, "hash")
    assert retry["job_id"] != first["job_id"]


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
