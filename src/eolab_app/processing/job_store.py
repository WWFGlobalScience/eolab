"""PostgreSQL adapter for atomic job admission, leases, and owned processing state.

Operation owners validate and serialize their specifications, summaries, and
resource estimates before calling this adapter. Storage never interprets raster
grids, AOI geometry, or any other operation-specific input fields.
"""

from contextlib import contextmanager
from dataclasses import asdict
from importlib.resources import files
import json
import logging
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
# Keep it stable across releases so all Processing transactions use the same lock.
# Other components using this database must allocate a different advisory key.
PROCESSING_ADVISORY_LOCK_ID = 7_610_329
LOGGER = logging.getLogger(__name__)
UNFINISHED = ("queued", "running", "cancelling")
PUBLIC_COLUMNS = (
    "id,owner,request_key,created_at,updated_at,expires_at,status,operation,"
    "CASE WHEN spec IS NULL THEN NULL ELSE summary END AS spec,"
    "reserved_bytes,attempt_id,lease_until,deadline_at,progress,preparation,artifact,error,request_hash"
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

    def interrupt_unfinished_jobs_on_restart(self) -> int:
        """Discard pending work before the restarted worker consumes new jobs.

        Call once at worker startup, after stopping the previous worker and its
        native processes. Queued, running and cancelling jobs become interrupted;
        completed results and cached values are unchanged. Keep attempt files and
        reservations until the worker's normal cleanup removes them. Existing
        job notifications tell browsers to read the interrupted status.

        Returns:
            Number of unfinished jobs interrupted by this restart.

        Raises:
            ProcessingError: If PostgreSQL cannot update the jobs.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "UPDATE processing.jobs SET status='interrupted',error=%s,"
                "updated_at=clock_timestamp() "
                "WHERE status IN ('queued','running','cancelling')",
                (
                    Jsonb(
                        {
                            "code": "worker_restarted",
                            "detail": "The application restarted before this job finished. Submit a new job to retry.",
                        }
                    ),
                ),
            )
            return cursor.rowcount

    def save_input(self, owner: str, checksum: str, payload: dict[str, Any]) -> str:
        """Retain a bounded private input for one day or until its owner releases it.

        Args:
            owner: Current Processing browser-session hash.
            checksum: Operation-owned content identity.
            payload: Validated JSON input without filesystem paths or credentials.

        Returns:
            Opaque identifier usable only by the same owner.

        Raises:
            ProcessingError: If the input or shared storage capacity is exceeded.
        """
        size = len(json.dumps(payload, allow_nan=False).encode("utf-8"))
        if size > 8 * 1024**2:
            raise ProcessingError(
                "input_size",
                "This processing input exceeds the 8 MiB storage limit.",
                413,
            )
        with self._transaction(locked=True) as cursor:
            cursor.execute("DELETE FROM processing.inputs WHERE expires_at <= now()")
            cursor.execute(
                "SELECT count(*) AS total, count(*) FILTER (WHERE owner=%s) AS owned, coalesce(sum(bytes),0) AS bytes FROM processing.inputs",
                (owner,),
            )
            count = cursor.fetchone()
            if (
                count["total"] >= 128
                or count["owned"] >= 32
                or count["bytes"] + size > 64 * 1024**2
            ):
                raise ProcessingError(
                    "input_capacity",
                    "Temporary processing input storage is full. Release an unused input or try again later.",
                    429,
                )
            identifier = uuid4().hex
            cursor.execute(
                "INSERT INTO processing.inputs VALUES (%s,%s,%s,%s,%s,now()+interval '1 day')",
                (identifier, owner, checksum, Jsonb(payload), size),
            )
            return identifier

    def get_input(self, owner: str, identifier: str, checksum: str) -> dict[str, Any]:
        """Read an unexpired input belonging to the current Processing session.

        Args:
            owner: Current browser-session hash.
            identifier: Opaque input ID returned by save_input.
            checksum: Expected immutable content identity.

        Returns:
            Stored JSON to validate at the operation boundary.

        Raises:
            ProcessingError: If the reference is expired, changed or belongs to someone else.
        """
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT payload FROM processing.inputs WHERE id=%s AND owner=%s AND sha256=%s AND expires_at>now()",
                (identifier, owner, checksum),
            )
            row = cursor.fetchone()
        if row is None:
            raise ProcessingError(
                "input_unavailable",
                "This calculation area expired or is unavailable. Select the layer again.",
                409,
            )
        return row["payload"]

    def discard_input(self, owner: str, identifier: str) -> None:
        """Release an input after deselection; accepted jobs keep their own copy.

        Args:
            owner: Current browser-session hash.
            identifier: Input to delete, including an already deleted input.

        Raises:
            ProcessingError: If storage is unavailable.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "DELETE FROM processing.inputs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )

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

    def submit(
        self,
        owner: str,
        request_key: str,
        expected: PreparedJobPlan,
        request_hash: str,
    ) -> dict[str, Any]:
        """Queue a job within separate session, backlog, record and storage budgets.

        Running work does not consume waiting-job capacity. Finished jobs retain
        their input and disk reservations until cleanup has removed their files.
        Retrying an accepted request succeeds even when new admission is full.

        Args:
            owner: Current session hash.
            request_key: Client idempotency key.
            expected: Validated queued inputs and their initial resource reservation.
            request_hash: Stable identity of the submitted operation inputs.

        Returns:
            Existing idempotent or newly queued owned job.

        Raises:
            ProcessingError: If a waiting-job, retained-record,
                input-storage or artifact-storage budget is exhausted.
        """
        if not request_hash:
            raise ValueError("Direct jobs require a request hash")
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "SELECT * FROM processing.jobs WHERE owner=%s AND request_key=%s",
                (owner, request_key),
            )
            existing = cursor.fetchone()
            if existing:
                if (
                    existing.get("request_hash") != request_hash
                    or existing["operation"] != expected.operation
                ):
                    raise ProcessingError(
                        "request_conflict",
                        "That request ID already belongs to different job inputs.",
                        409,
                    )
                return existing
            self._delete_old_job_records(cursor)
            cursor.execute(
                "SELECT count(*) FILTER (WHERE status='queued') AS waiting, "
                "count(*) FILTER (WHERE owner=%s AND status='queued') AS owned, "
                "count(DISTINCT owner) FILTER (WHERE status='queued') AS owners, "
                "count(*) AS records, COALESCE(sum(input_bytes),0) AS inputs, "
                "COALESCE(sum(reserved_bytes),0) AS bytes, "
                "octet_length(%s::jsonb::text)::bigint + "
                "octet_length(%s::jsonb::text) AS new_input_bytes FROM processing.jobs",
                (owner, Jsonb(expected.specification), Jsonb(expected.summary)),
            )
            count = cursor.fetchone()
            if count["owned"] >= self.limits.max_owner_waiting_jobs:
                raise ProcessingError(
                    "owner_queue_full",
                    "This browser session has reached its waiting-job limit. "
                    "Cancel a queued job or wait for one to start.",
                    429,
                )
            if count["waiting"] >= self.limits.max_waiting_jobs:
                raise ProcessingError(
                    "queue_full",
                    "The processing waiting queue is full. Wait for a job to start.",
                    429,
                )
            if count["records"] >= self.limits.max_job_records:
                raise ProcessingError(
                    "job_record_capacity",
                    "Processing job history is full. Try later or ask the administrator "
                    "to increase its record limit.",
                    429,
                )
            if (
                count["inputs"] + count["new_input_bytes"]
                > self.limits.max_job_input_bytes
            ):
                raise ProcessingError(
                    "job_input_capacity",
                    "Processing input storage is full. Delete an earlier result "
                    "or wait for cleanup before trying again.",
                    429,
                )
            if count["bytes"] + expected.reserved_bytes > self.limits.max_stored_bytes:
                raise ProcessingError(
                    "storage_full",
                    "Temporary processing storage is full. Delete an earlier result or try later.",
                    429,
                )
            cursor.execute(
                "INSERT INTO processing.jobs(id,owner,request_key,expires_at,status,spec,reserved_bytes,summary,operation,input_bytes,request_hash) VALUES (%s,%s,%s,now()+%s*interval '1 second','queued',%s,%s,%s,%s,%s,%s) RETURNING *",
                (
                    uuid4().hex,
                    owner,
                    request_key,
                    self.limits.result_ttl_seconds,
                    Jsonb(expected.specification),
                    expected.reserved_bytes,
                    Jsonb(expected.summary),
                    expected.operation,
                    count["new_input_bytes"],
                    request_hash,
                ),
            )
            row = cursor.fetchone()
            # PostgreSQL delivers this empty hint only if admission commits.
            # No job IDs, owner capabilities, or operation inputs are broadcast.
            cursor.execute("SELECT pg_notify(%s, '')", (JOB_QUEUE_CHANNEL,))
            LOGGER.info(
                "Processing admission: waiting=%s/%s session_waiting=%s/%s "
                "waiting_sessions=%s records=%s/%s input_bytes=%s/%s reserved_bytes=%s/%s",
                count["waiting"] + 1,
                self.limits.max_waiting_jobs,
                count["owned"] + 1,
                self.limits.max_owner_waiting_jobs,
                count["owners"] + (count["owned"] == 0),
                count["records"] + 1,
                self.limits.max_job_records,
                count["inputs"] + count["new_input_bytes"],
                self.limits.max_job_input_bytes,
                count["bytes"] + expected.reserved_bytes,
                self.limits.max_stored_bytes,
            )
            return row

    def save_prepared_job(
        self,
        identifier: str,
        attempt: str,
        prepared: PreparedJobPlan,
        details: dict[str, Any],
    ) -> dict[str, Any]:
        """Reserve execution storage and publish prepared inputs for a running job.

        Args:
            identifier: Running job ID.
            attempt: Worker attempt that must still own the job.
            prepared: Validated execution inputs, public summary and disk estimate.
            details: Bounded public preparation measurements retained until cleanup.

        Returns:
            Updated job ready for execution, with prepared details visible to its owner.

        Raises:
            ProcessingError: If ownership was lost, cancellation won, or the new
                input and disk reservations exceed deployment limits.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "SELECT * FROM processing.jobs WHERE id=%s AND attempt_id=%s "
                "AND status='running' AND lease_until>now() AND deadline_at>now() FOR UPDATE",
                (identifier, attempt),
            )
            if cursor.fetchone() is None:
                raise ProcessingError(
                    "job_cancelled", "Job stopped during preparation.", 409
                )
            cursor.execute(
                "SELECT COALESCE(sum(reserved_bytes),0) AS bytes,COALESCE(sum(input_bytes),0) AS inputs "
                "FROM processing.jobs WHERE id<>%s",
                (identifier,),
            )
            used = cursor.fetchone()
            cursor.execute(
                "SELECT octet_length(%s::jsonb::text)+octet_length(%s::jsonb::text) AS bytes",
                (Jsonb(prepared.specification), Jsonb(prepared.summary)),
            )
            if (
                used["inputs"] + cursor.fetchone()["bytes"]
                > self.limits.max_job_input_bytes
            ):
                raise ProcessingError(
                    "job_input_capacity",
                    "Prepared job exceeds available input storage.",
                    429,
                )
            if used["bytes"] + prepared.reserved_bytes > self.limits.max_stored_bytes:
                raise ProcessingError(
                    "storage_full",
                    "Not enough temporary storage for this job.",
                    429,
                )
            cursor.execute(
                "UPDATE processing.jobs SET spec=%s,summary=%s,reserved_bytes=%s,preparation=%s,"
                "progress=%s,updated_at=clock_timestamp() WHERE id=%s RETURNING *",
                (
                    Jsonb(prepared.specification),
                    Jsonb(prepared.summary),
                    prepared.reserved_bytes,
                    Jsonb(details),
                    Jsonb({"phase": "calculating"}),
                    identifier,
                ),
            )
            return cursor.fetchone()

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
        """Give the least recently served session one job in the single execution lane.

        Sessions with no previous start go first. Ties use their oldest waiting
        job, and each session's jobs remain FIFO. A large stack therefore cannot
        take another turn ahead of a session that has been waiting since its
        previous turn. Running jobs are never preempted. Cancellation and failure
        still count as a turn once execution starts.

        While the worker is running, a lost DB connection cannot start a second
        native child before the current attempt's hard deadline plus exit grace.
        Worker startup separately interrupts work left by the stopped worker.

        Returns:
            Claimed job, or None when execution is busy or no job waits.

        Raises:
            ProcessingError: If the database cannot complete the claim.
        """

        with self._transaction(locked=True) as cursor:
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
                "SELECT waiting.id FROM ("
                "SELECT DISTINCT ON (owner) id,owner,created_at FROM processing.jobs "
                "WHERE status='queued' "
                "ORDER BY owner,created_at,id) waiting "
                "LEFT JOIN LATERAL (SELECT started_at FROM processing.jobs history "
                "WHERE history.owner=waiting.owner AND started_at IS NOT NULL "
                "ORDER BY started_at DESC LIMIT 1) served ON true "
                "ORDER BY served.started_at NULLS FIRST,waiting.created_at,waiting.id LIMIT 1"
            )
            row = cursor.fetchone()
            if not row:
                return None
            cursor.execute(
                "UPDATE processing.jobs SET status='running',attempt_id=%s,lease_until=now()+%s*interval '1 second',deadline_at=now()+%s*interval '1 second',started_at=clock_timestamp(),updated_at=now() WHERE id=%s RETURNING *",
                (
                    uuid4().hex,
                    self.limits.lease_seconds,
                    self.limits.runtime_seconds + 15,
                    row["id"],
                ),
            )
            claimed = cursor.fetchone()
            cursor.execute(
                "SELECT count(*) AS waiting,count(DISTINCT owner) AS owners "
                "FROM processing.jobs WHERE status='queued'"
            )
            backlog = cursor.fetchone()
            LOGGER.info(
                "Processing execution started: waiting=%s waiting_sessions=%s queue_seconds=%.3f",
                backlog["waiting"],
                backlog["owners"],
                (claimed["started_at"] - claimed["created_at"]).total_seconds(),
            )
            return claimed

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
                "UPDATE processing.jobs SET lease_until=now()+%s*interval '1 second',progress=CASE WHEN %s::jsonb='{}'::jsonb THEN progress ELSE %s::jsonb END,updated_at=now() WHERE id=%s AND attempt_id=%s AND status='running' AND lease_until>now() AND deadline_at>now() RETURNING id",
                (
                    self.limits.lease_seconds,
                    Jsonb(progress),
                    Jsonb(progress),
                    identifier,
                    attempt,
                ),
            )
            return cursor.fetchone() is not None

    def finish(
        self,
        identifier: str,
        attempt: str,
        artifact: Artifact | None,
        error: dict[str, str] | None = None,
        reusable_results: dict[str, dict[str, object]] | None = None,
    ) -> bool:
        """Publish completed work and cache values only while this attempt owns the job.

        Args:
            identifier: Running job.
            attempt: Execution fencing token.
            artifact: Atomically published immutable result, or None on failure.
            error: Sanitized reason for a failed or interrupted operation.
            reusable_results: Small completed values keyed by the operation's
                input hash. Stored only if this attempt becomes ready.

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
                completed = cursor.fetchone() is not None
                if (
                    completed
                    and reusable_results
                    and self.limits.calculation_cache_capacity > 0
                ):
                    cursor.execute(
                        "DELETE FROM processing.calculation_results WHERE expires_at <= now()"
                    )
                    for key, payload in reusable_results.items():
                        # Leave oversized results uncached rather than failing a completed job.
                        if (
                            len(json.dumps(payload, allow_nan=False).encode("utf-8"))
                            > 32768
                        ):
                            continue
                        cursor.execute(
                            "INSERT INTO processing.calculation_results(cache_key,payload,expires_at) "
                            "VALUES (%s,%s,now()+%s*interval '1 second') ON CONFLICT DO NOTHING",
                            (
                                key,
                                Jsonb(payload),
                                self.limits.calculation_cache_ttl_seconds,
                            ),
                        )
                    cursor.execute(
                        "DELETE FROM processing.calculation_results WHERE cache_key IN "
                        "(SELECT cache_key FROM processing.calculation_results "
                        "ORDER BY created_at DESC,cache_key OFFSET %s)",
                        (self.limits.calculation_cache_capacity,),
                    )
                return completed
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

    def get_cached_calculation_results(
        self, keys: list[str]
    ) -> dict[str, dict[str, object]]:
        """Read unexpired numerical results for operation-generated input hashes.

        Callers must authorize the current raster and area before using these
        shared values. This method returns no job IDs or download permissions.

        Args:
            keys: At most five hashes generated from validated calculation inputs.

        Returns:
            Matching payloads by hash; missing or expired entries are omitted.

        Raises:
            ProcessingError: If PostgreSQL is unavailable.
            ValueError: If more than five keys are requested.
        """
        if len(keys) > 5:
            raise ValueError("At most five cached calculations can be requested")
        if not keys or self.limits.calculation_cache_capacity <= 0:
            return {}
        with self._transaction() as cursor:
            cursor.execute(
                "SELECT cache_key,payload FROM processing.calculation_results "
                "WHERE cache_key=ANY(%s) AND expires_at>now()",
                (keys,),
            )
            return {row["cache_key"]: row["payload"] for row in cursor.fetchall()}

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
        """Expire abandoned plans and results, then find job files safe to remove.

        Returns:
            At most 100 rows with no active transfer; budgets remain reserved
            until the worker confirms filesystem cleanup.

        Raises:
            ProcessingError: If the database cannot update expiration or read jobs.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute("DELETE FROM processing.inputs WHERE expires_at<=now()")
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
                "UPDATE processing.jobs SET reserved_bytes=0,input_bytes=0,spec=NULL,artifact=NULL WHERE id=%s AND status NOT IN ('queued','running','cancelling','ready') AND NOT EXISTS (SELECT 1 FROM processing.transfers WHERE job_id=%s)",
                (identifier, identifier),
            )
            self._delete_old_job_records(cursor)

    def _delete_old_job_records(self, cursor: Any) -> None:
        """Forget cleaned terminal jobs after their seven-day idempotency lifetime.

        Args:
            cursor: Cursor inside the existing locked admission/cleanup transaction.
        """
        cursor.execute(
            "DELETE FROM processing.jobs WHERE reserved_bytes=0 AND spec IS NULL "
            "AND status NOT IN ('queued','running','cancelling','ready') "
            "AND updated_at<now()-interval '7 days' "
            "AND NOT EXISTS (SELECT 1 FROM processing.transfers WHERE job_id=jobs.id)"
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
