"""PostgreSQL adapter for atomic job admission, leases, and owned processing state.

Operation owners validate and serialize their specifications, summaries, and
resource estimates before calling this adapter. Storage never interprets raster
grids, AOI geometry, or any other operation-specific input fields.
"""

from contextlib import contextmanager
from dataclasses import asdict
from importlib.resources import files
from typing import Any, Iterator
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from eolab_app.processing.job_notifications import JOB_QUEUE_CHANNEL

from eolab_app.processing.models import (
    Artifact,
    PreparedJobPlan,
    ProcessingError,
    ProcessingLimits,
)

# Processing owns this key in PostgreSQL's single-bigint, database-wide advisory
# lock namespace. It serializes schema migration and shared admission, job-state,
# storage, and transfer decisions; it is never held during native execution.
# The integer is an assigned identifier, not a limit or a generated random value.
# Keep it stable across releases so overlapping workers acquire the same lock.
# Other components using this database must allocate a different advisory key.
PROCESSING_ADVISORY_LOCK_ID = 7_610_329
UNFINISHED = ("queued", "running", "cancelling")
PUBLIC_COLUMNS = (
    "id,owner,request_key,plan_id,created_at,updated_at,expires_at,status,operation,"
    "CASE WHEN spec IS NULL THEN NULL ELSE summary END AS spec,"
    "reserved_bytes,attempt_id,lease_until,deadline_at,progress,artifact,error"
)


class PostgresJobStore:
    """Keep processing state independent of catalog persistence implementations."""

    def __init__(self, limits: ProcessingLimits, conninfo: str = "") -> None:
        """Configure the adapter without opening a startup-time connection.

        Args:
            limits: Shared deployment admission and lifecycle policy.
            conninfo: Optional test connection string; production uses PG* env.
        """
        self.limits = limits
        self.conninfo = conninfo

    @contextmanager
    def _transaction(self, locked: bool = False) -> Iterator[Any]:
        """Open a bounded transaction, optionally serializing admission changes.

        Args:
            locked: Acquire Processing's database-wide transaction advisory lock.

        Yields:
            Dictionary-row cursor; all operations are committed or rolled back.

        Raises:
            ProcessingError: If processing storage is unavailable or times out.
        """
        try:
            with psycopg.connect(
                self.conninfo,
                connect_timeout=3,
                row_factory=dict_row,
                options="-c statement_timeout=5000 -c lock_timeout=3000",
            ) as connection:
                with connection.cursor() as cursor:
                    if locked:
                        cursor.execute(
                            "SELECT pg_advisory_xact_lock(%s)",
                            (PROCESSING_ADVISORY_LOCK_ID,),
                        )
                    yield cursor
        except psycopg.Error as error:
            raise ProcessingError(
                "processing_unavailable",
                "Job processing is temporarily unavailable. Try again shortly.",
                503,
            ) from error

    def migrate(self) -> None:
        """Idempotently install the owned schema under the processing mutex.

        Raises:
            ProcessingError: If the database cannot apply the schema.
        """
        sql = files("eolab_app.processing").joinpath("schema.sql").read_text()
        with self._transaction(locked=True) as cursor:
            cursor.execute(sql)

    def reserve_plan(self, owner: str, request: dict[str, Any]) -> str:
        """Reserve the one global metadata child and bounded plan-record capacity.

        Args:
            owner: Hash of the opaque browser-session capability.
            request: Validated operation request, never a filesystem path.

        Returns:
            New opaque plan ID.

        Raises:
            ProcessingError: If a plan is already running or capacity is full.
        """
        identifier = uuid4().hex
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "DELETE FROM processing.plans WHERE expires_at <= now() AND (planning_until IS NULL OR planning_until <= now())"
            )
            cursor.execute(
                "SELECT count(*) AS total, count(*) FILTER (WHERE owner=%s) AS owned, count(*) FILTER (WHERE planning_until > now()) AS running FROM processing.plans",
                (owner,),
            )
            count = cursor.fetchone()
            if count["running"] or count["total"] >= 50 or count["owned"] >= 5:
                raise ProcessingError(
                    "plan_capacity",
                    "Job planning is busy or too many plans are open. Wait briefly and try again.",
                    429,
                )
            cursor.execute(
                "INSERT INTO processing.plans(id,owner,expires_at,planning_until,request) VALUES (%s,%s,now()+%s*interval '1 second',now()+%s*interval '1 second',%s)",
                (
                    identifier,
                    owner,
                    self.limits.plan_ttl_seconds,
                    self.limits.plan_timeout_seconds + 10,
                    Jsonb(request),
                ),
            )
        return identifier

    def finish_plan(
        self, identifier: str, owner: str, plan: PreparedJobPlan | None
    ) -> dict[str, Any] | None:
        """Release metadata capacity after native operation completion or child exit.

        Args:
            identifier: Reserved plan ID.
            owner: Original session owner hash.
            plan: Prepared operation data, or None to discard a failed plan.

        Returns:
            Completed plan row or None after removal.
        """
        with self._transaction(locked=True) as cursor:
            if plan is None:
                cursor.execute(
                    "DELETE FROM processing.plans WHERE id=%s AND owner=%s",
                    (identifier, owner),
                )
                return None
            cursor.execute(
                "UPDATE processing.plans SET planning_until=NULL,spec=%s WHERE id=%s AND owner=%s AND expires_at>now() RETURNING *",
                (Jsonb(plan.specification), identifier, owner),
            )
            return cursor.fetchone()

    def get_plan(self, identifier: str, owner: str) -> dict[str, Any]:
        """Read an owned, completed, unexpired plan.

        Args:
            identifier: Opaque plan ID.
            owner: Current session hash.

        Returns:
            Stored plan and original request for operation-owned revalidation.

        Raises:
            ProcessingError: If the plan is unavailable to this owner.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT * FROM processing.plans WHERE id=%s AND owner=%s AND expires_at>now() AND spec IS NOT NULL",
                (identifier, owner),
            )
            row = cursor.fetchone()
        if not row:
            raise ProcessingError(
                "plan_unavailable",
                "This job plan expired or is unavailable. Create a new plan.",
                404,
            )
        return row

    def find_request(self, owner: str, request_key: str) -> dict[str, Any] | None:
        """Recover a committed job after a lost submission response.

        Args:
            owner: Current session hash.
            request_key: Client idempotency key.

        Returns:
            Matching owned job, including a terminal tombstone, or None.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT * FROM processing.jobs WHERE owner=%s AND request_key=%s",
                (owner, request_key),
            )
            return cursor.fetchone()

    def discard_plan(self, identifier: str, owner: str) -> None:
        """Delete only completed owned review state; accepted jobs are independent.

        Args:
            identifier: Opaque plan ID, including an already removed plan.
            owner: Current session hash.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "DELETE FROM processing.plans WHERE id=%s AND owner=%s AND planning_until IS NULL",
                (identifier, owner),
            )

    def submit(
        self, owner: str, plan_id: str, request_key: str, expected: PreparedJobPlan
    ) -> dict[str, Any]:
        """Atomically enqueue a validated snapshot and reserve disk/queue budgets.

        Args:
            owner: Current session hash.
            plan_id: Plan revalidated by the application owner.
            request_key: Client idempotency key.
            expected: Prepared operation data revalidated immediately before admission.

        Returns:
            Existing idempotent or newly queued owned job.

        Raises:
            ProcessingError: If the plan expired or global/owner limits are full.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "SELECT * FROM processing.jobs WHERE owner=%s AND request_key=%s",
                (owner, request_key),
            )
            existing = cursor.fetchone()
            if existing:
                if existing["plan_id"] != plan_id:
                    raise ProcessingError(
                        "request_conflict",
                        "That request ID already belongs to another plan.",
                        409,
                    )
                return existing
            cursor.execute(
                "SELECT spec FROM processing.plans WHERE id=%s AND owner=%s AND expires_at>now() AND planning_until IS NULL",
                (plan_id, owner),
            )
            plan = cursor.fetchone()
            if not plan or plan["spec"] != expected.specification:
                raise ProcessingError(
                    "plan_unavailable",
                    "This job plan is no longer available. Create a new plan.",
                    409,
                )
            cursor.execute(
                "SELECT count(*) FILTER (WHERE status='queued') AS waiting, count(*) FILTER (WHERE owner=%s AND status=ANY(%s)) AS owned, COALESCE(sum(reserved_bytes),0) AS bytes FROM processing.jobs",
                (owner, list(UNFINISHED)),
            )
            count = cursor.fetchone()
            if (
                count["waiting"] >= self.limits.max_waiting
                or count["owned"] >= self.limits.max_owner_unfinished
            ):
                raise ProcessingError(
                    "queue_full",
                    "The processing queue is full. Wait for an existing job to finish.",
                    429,
                )
            if count["bytes"] + expected.reserved_bytes > self.limits.max_stored_bytes:
                raise ProcessingError(
                    "storage_full",
                    "Temporary processing storage is full. Delete an earlier result or try later.",
                    429,
                )
            cursor.execute(
                "INSERT INTO processing.jobs(id,owner,request_key,plan_id,expires_at,status,spec,reserved_bytes,summary,operation,minimum_claim_version) VALUES (%s,%s,%s,%s,now()+%s*interval '1 second','queued',%s,%s,%s,%s,%s) RETURNING *",
                (
                    uuid4().hex,
                    owner,
                    request_key,
                    plan_id,
                    self.limits.result_ttl_seconds,
                    Jsonb(expected.specification),
                    expected.reserved_bytes,
                    Jsonb(expected.summary),
                    expected.operation,
                    expected.minimum_claim_version,
                ),
            )
            row = cursor.fetchone()
            # PostgreSQL delivers this empty hint only if admission commits.
            # No job IDs, owner capabilities, or operation inputs are broadcast.
            cursor.execute("SELECT pg_notify(%s, '')", (JOB_QUEUE_CHANNEL,))
            return row

    def get(self, identifier: str, owner: str) -> dict[str, Any]:
        """Read one owned job without exposing another session's existence.

        Args:
            identifier: Opaque job ID.
            owner: Current session hash.

        Returns:
            Owned job record.

        Raises:
            ProcessingError: If no owned record exists.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT "
                + PUBLIC_COLUMNS
                + " FROM processing.jobs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            row = cursor.fetchone()
        if not row:
            raise ProcessingError(
                "job_not_found", "This processing job is unavailable.", 404
            )
        return row

    def list_owned(self, owner: str) -> list[dict[str, Any]]:
        """Return at most 50 recent jobs for session recovery.

        Args:
            owner: Current session hash.

        Returns:
            Newest owned jobs first, with no global listing.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT "
                + PUBLIC_COLUMNS
                + " FROM processing.jobs WHERE owner=%s AND status<>'deleted' ORDER BY created_at DESC LIMIT 50",
                (owner,),
            )
            return cursor.fetchall()

    def cancel(
        self, identifier: str, owner: str, delete: bool = False
    ) -> dict[str, Any]:
        """Request cancellation, or revoke a terminal result pending worker cleanup.

        Args:
            identifier: Owned job ID.
            owner: Current session hash.
            delete: Remove a terminal result; active jobs must first be cancelled.

        Returns:
            Updated owned job.

        Raises:
            ProcessingError: If deleting active work or an unowned job.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "SELECT * FROM processing.jobs WHERE id=%s AND owner=%s FOR UPDATE",
                (identifier, owner),
            )
            row = cursor.fetchone()
            if not row:
                raise ProcessingError(
                    "job_not_found", "This processing job is unavailable.", 404
                )
            if delete and row["status"] in UNFINISHED:
                raise ProcessingError(
                    "job_active",
                    "Cancel this job and wait for it to stop before deleting it.",
                    409,
                )
            status = (
                "deleted"
                if delete
                else {"queued": "cancelled", "running": "cancelling"}.get(
                    row["status"], row["status"]
                )
            )
            cursor.execute(
                "UPDATE processing.jobs SET status=%s,updated_at=now() WHERE id=%s RETURNING *",
                (status, identifier),
            )
            return cursor.fetchone()

    def claim(self) -> dict[str, Any] | None:
        """Claim one global execution slot and fence it with an attempt token.

        Crash recovery waits through the previous hard deadline plus exit grace.
        A lost DB connection cannot cause a second native child to start while
        the old child could still be running under its supervisor deadline.
        Claim protocol 3 adds fractional ellipsoidal area calculations. The
        existing database trigger fences workers supporting earlier protocols.
        Protocol 5 adds direct catalog-selection jobs without embedded geometry.

        Returns:
            Claimed job or None while another attempt reserves the slot.
        """

        with self._transaction(locked=True) as cursor:
            cursor.execute("SET LOCAL eolab.processing_claim_version = '6'")
            cursor.execute(
                "UPDATE processing.jobs SET status='interrupted',error=%s,updated_at=now() WHERE status IN ('running','cancelling') AND deadline_at<now()",
                (
                    Jsonb(
                        {
                            "code": "interrupted",
                            "detail": "The worker stopped before this job completed. Submit a new job to retry.",
                        }
                    ),
                ),
            )
            cursor.execute(
                "SELECT id FROM processing.jobs WHERE status IN ('running','cancelling') LIMIT 1"
            )
            if cursor.fetchone():
                return None
            cursor.execute(
                "SELECT id FROM processing.jobs WHERE status='queued' AND minimum_claim_version<=6 ORDER BY created_at LIMIT 1 FOR UPDATE"
            )
            row = cursor.fetchone()
            if not row:
                return None
            cursor.execute(
                "UPDATE processing.jobs SET status='running',attempt_id=%s,lease_until=now()+%s*interval '1 second',deadline_at=now()+%s*interval '1 second',updated_at=now() WHERE id=%s RETURNING *",
                (
                    uuid4().hex,
                    self.limits.lease_seconds,
                    self.limits.runtime_seconds + 15,
                    row["id"],
                ),
            )
            return cursor.fetchone()

    def heartbeat(
        self, identifier: str, attempt: str, progress: dict[str, Any]
    ) -> bool:
        """Renew one live attempt and report whether work should continue.

        Args:
            identifier: Running job.
            attempt: Current fencing token.
            progress: Bounded, owner-defined progress fields.

        Returns:
            False after cancellation, lost lease, or deadline expiration.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "UPDATE processing.jobs SET lease_until=now()+%s*interval '1 second',progress=%s,updated_at=now() WHERE id=%s AND attempt_id=%s AND status='running' AND lease_until>now() AND deadline_at>now() RETURNING id",
                (self.limits.lease_seconds, Jsonb(progress), identifier, attempt),
            )
            return cursor.fetchone() is not None

    def finish(
        self,
        identifier: str,
        attempt: str,
        artifact: Artifact | None,
        error: dict[str, str] | None = None,
    ) -> bool:
        """Commit only after native completion/cleanup and artifact publication.

        Args:
            identifier: Running job.
            attempt: Execution fencing token.
            artifact: Atomically published immutable result, or None on failure.
            error: Sanitized reason for a failed or interrupted operation.

        Returns:
            True only if the still-current attempt reached the requested state.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "SELECT * FROM processing.jobs WHERE id=%s AND attempt_id=%s AND status IN ('running','cancelling') FOR UPDATE",
                (identifier, attempt),
            )
            row = cursor.fetchone()
            if not row:
                return False
            if artifact is not None:
                cursor.execute(
                    "UPDATE processing.jobs SET status='ready',artifact=%s,reserved_bytes=%s,expires_at=now()+%s*interval '1 second',updated_at=now(),progress=%s WHERE id=%s AND status='running' AND lease_until>now() AND deadline_at>now() RETURNING id",
                    (
                        Jsonb(asdict(artifact)),
                        artifact.size + self.limits.result_metadata_reservation_bytes,
                        self.limits.result_ttl_seconds,
                        Jsonb({"phase": "ready"}),
                        identifier,
                    ),
                )
                return cursor.fetchone() is not None
            status = (
                "cancelled"
                if row["status"] == "cancelling"
                else (
                    "interrupted"
                    if error and error.get("code") == "interrupted"
                    else "failed"
                )
            )
            cursor.execute(
                "UPDATE processing.jobs SET status=%s,error=%s,updated_at=now() WHERE id=%s",
                (status, Jsonb(error), identifier),
            )
            return True

    def acquire_transfer(
        self, identifier: str, owner: str
    ) -> tuple[dict[str, Any], str]:
        """Atomically acquire a result lease before worker expiry can remove it.

        Args:
            identifier: Owned ready job.
            owner: Current session hash.

        Returns:
            Job metadata and renewable opaque transfer ID.

        Raises:
            ProcessingError: If the result is unavailable or transfer capacity is full.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute("DELETE FROM processing.transfers WHERE expires_at<=now()")
            cursor.execute(
                "SELECT * FROM processing.jobs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            row = cursor.fetchone()
            if not row:
                raise ProcessingError(
                    "job_not_found", "This processing job is unavailable.", 404
                )
            cursor.execute(
                "SELECT id FROM processing.jobs WHERE id=%s AND status='ready' AND expires_at>now()",
                (identifier,),
            )
            if not cursor.fetchone():
                raise ProcessingError(
                    "result_unavailable",
                    "This job result is not ready or its download has expired.",
                    409,
                )
            cursor.execute(
                "SELECT count(*) AS total, count(*) FILTER (WHERE job_id=%s) AS count FROM processing.transfers",
                (identifier,),
            )
            transfers = cursor.fetchone()
            if transfers["count"] >= 4 or transfers["total"] >= 64:
                raise ProcessingError(
                    "download_busy",
                    "Too many downloads of this job result are already open.",
                    429,
                )
            lease = uuid4().hex
            cursor.execute(
                "INSERT INTO processing.transfers VALUES (%s,%s,now()+%s*interval '1 second')",
                (lease, identifier, self.limits.transfer_seconds),
            )
            return row, lease

    def transfer_heartbeat(self, lease: str, release: bool = False) -> bool:
        """Renew or release a bounded download lease.

        Args:
            lease: Opaque transfer ID minted by acquire_transfer.
            release: Delete the lease after response completion/disconnection.

        Returns:
            Whether the transfer lease still exists.
        """
        with self._transaction() as cursor:
            if release:
                cursor.execute(
                    "DELETE FROM processing.transfers WHERE id=%s RETURNING id",
                    (lease,),
                )
            else:
                cursor.execute(
                    "UPDATE processing.transfers SET expires_at=now()+%s*interval '1 second' WHERE id=%s AND expires_at>now() RETURNING id",
                    (self.limits.transfer_seconds, lease),
                )
            return cursor.fetchone() is not None

    def cleanup_candidates(self) -> list[dict[str, Any]]:
        """Revoke expired results and return terminal attempts safe to remove.

        Returns:
            At most 100 rows with no active transfer; budgets remain reserved
            until the worker confirms filesystem cleanup.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "DELETE FROM processing.plans WHERE expires_at<=now() AND (planning_until IS NULL OR planning_until<=now())"
            )
            cursor.execute("DELETE FROM processing.transfers WHERE expires_at<=now()")
            cursor.execute(
                "UPDATE processing.jobs SET status='expired',updated_at=now() WHERE status='ready' AND expires_at<=now()"
            )
            cursor.execute(
                "SELECT j.* FROM processing.jobs j WHERE j.status NOT IN ('queued','running','cancelling','ready') AND (j.reserved_bytes>0 OR j.spec IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM processing.transfers t WHERE t.job_id=j.id) ORDER BY j.updated_at LIMIT 100"
            )
            return cursor.fetchall()

    def cleaned(self, identifier: str) -> None:
        """Release storage and operation payloads only after successful file removal.

        Args:
            identifier: Terminal job with completed cleanup.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "UPDATE processing.jobs SET reserved_bytes=0,spec=NULL,artifact=NULL WHERE id=%s AND status NOT IN ('queued','running','cancelling','ready') AND NOT EXISTS (SELECT 1 FROM processing.transfers WHERE job_id=%s)",
                (identifier, identifier),
            )
            # Retain bounded-time idempotency tombstones, without input payloads.
            cursor.execute(
                "DELETE FROM processing.jobs WHERE reserved_bytes=0 AND spec IS NULL AND updated_at<now()-interval '7 days'"
            )

    def active_attempts(self) -> set[str]:
        """Read attempt IDs that still own files, including ready results.

        Returns:
            IDs retained for active, ready, or transfer-leased jobs.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT attempt_id FROM processing.jobs WHERE attempt_id IS NOT NULL AND (reserved_bytes>0 OR status IN ('running','cancelling','ready'))"
            )
            return {row["attempt_id"] for row in cursor.fetchall()}
