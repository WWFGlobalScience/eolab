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
                "SELECT * FROM processing.subscribed_jobs WHERE owner=%s AND request_key=%s",
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
        """Subscribe to matching active work, or admit one new computation.

        Joining, cancellation and completion serialize in a short transaction.
        Storage treats work keys and presentation as opaque operation-owned data.
        Each subscriber consumes a record and its owner's waiting allowance;
        shared computation inputs and disk reservations are counted only once.

        Args:
            owner: Current browser session hash.
            request_key: Stable retry key scoped to that browser.
            expected: Validated inputs, storage reservation and optional work key.
            request_hash: Exact request hash used to reject conflicting retries.

        Returns:
            Owned subscriber handle joined with current computation state.

        Raises:
            ProcessingError: If retry inputs conflict or resource limits are full.
            ValueError: If no request hash was supplied.
        """
        if not request_hash:
            raise ValueError("Direct jobs require a request hash")
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE owner=%s AND request_key=%s",
                (owner, request_key),
            )
            existing = cursor.fetchone()
            if existing:
                if (
                    existing["request_hash"] != request_hash
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
                "SELECT id,status FROM processing.jobs WHERE work_key=%s AND status IN ('queued','running') "
                "AND (status='queued' OR (lease_until>now() AND deadline_at>now()))",
                (expected.work_key,),
            )
            shared = cursor.fetchone()
            # A lease-lost running attempt still owns its slot and work key until
            # its deadline. Do not join it or create a conflicting replacement.
            if expected.work_key and not shared:
                cursor.execute(
                    "SELECT 1 FROM processing.jobs WHERE work_key=%s AND status='running'",
                    (expected.work_key,),
                )
                if cursor.fetchone():
                    raise ProcessingError(
                        "queue_full",
                        "Matching work is stopping. Try again shortly.",
                        429,
                    )
            cursor.execute(
                "SELECT count(*) FILTER (WHERE status='queued') AS waiting, "
                "COALESCE(sum(input_bytes),0) AS inputs, COALESCE(sum(reserved_bytes),0) AS bytes "
                "FROM processing.jobs"
            )
            count = cursor.fetchone()
            cursor.execute(
                "SELECT count(*) AS records, count(*) FILTER (WHERE owner=%s AND status='queued') AS owned "
                "FROM processing.subscribed_jobs",
                (owner,),
            )
            subscribers = cursor.fetchone()
            if (not shared or shared["status"] == "queued") and subscribers[
                "owned"
            ] >= self.limits.max_owner_waiting_jobs:
                raise ProcessingError(
                    "owner_queue_full",
                    "This browser session has reached its waiting-job limit. Cancel a queued job or wait for one to start.",
                    429,
                )
            if subscribers["records"] >= self.limits.max_job_records:
                raise ProcessingError(
                    "job_record_capacity",
                    "Processing job history is full. Try later or increase its record limit.",
                    429,
                )
            cursor.execute(
                "SELECT coalesce(sum(octet_length(presentation::text)),0) AS bytes FROM processing.job_subscribers"
            )
            presentation_bytes = cursor.fetchone()["bytes"]
            cursor.execute(
                "SELECT octet_length(%s::jsonb::text)+octet_length(%s::jsonb::text) AS inputs, "
                "coalesce(octet_length(%s::jsonb::text),0) AS presentation",
                (
                    Jsonb(expected.specification),
                    Jsonb(expected.summary),
                    (
                        Jsonb(expected.presentation)
                        if expected.presentation is not None
                        else None
                    ),
                ),
            )
            sizes = cursor.fetchone()
            if (
                count["inputs"]
                + presentation_bytes
                + sizes["presentation"]
                + (0 if shared else sizes["inputs"])
                > self.limits.max_job_input_bytes
            ):
                raise ProcessingError(
                    "job_input_capacity",
                    "Processing input storage is full. Delete an earlier result or wait for cleanup.",
                    429,
                )
            identifier = uuid4().hex
            if shared:
                job_id = shared["id"]
            else:
                if count["waiting"] >= self.limits.max_waiting_jobs:
                    raise ProcessingError(
                        "queue_full",
                        "The processing waiting queue is full. Wait for a job to start.",
                        429,
                    )
                if (
                    count["bytes"] + expected.reserved_bytes
                    > self.limits.max_stored_bytes
                ):
                    raise ProcessingError(
                        "storage_full",
                        "Temporary processing storage is full. Delete an earlier result or try later.",
                        429,
                    )
                job_id = identifier
                cursor.execute(
                    "INSERT INTO processing.jobs(id,expires_at,status,spec,reserved_bytes,summary,operation,input_bytes,work_key) "
                    "VALUES (%s,now()+%s*interval '1 second','queued',%s,%s,%s,%s,%s,%s)",
                    (
                        job_id,
                        self.limits.result_ttl_seconds,
                        Jsonb(expected.specification),
                        expected.reserved_bytes,
                        Jsonb(expected.summary),
                        expected.operation,
                        sizes["inputs"],
                        expected.work_key,
                    ),
                )
                cursor.execute("SELECT pg_notify(%s, '')", (JOB_QUEUE_CHANNEL,))
            cursor.execute(
                "INSERT INTO processing.job_subscribers(id,job_id,owner,request_key,request_hash,presentation) VALUES (%s,%s,%s,%s,%s,%s)",
                (
                    identifier,
                    job_id,
                    owner,
                    request_key,
                    request_hash,
                    (
                        Jsonb(expected.presentation)
                        if expected.presentation is not None
                        else None
                    ),
                ),
            )
            cursor.execute(
                "SELECT count(DISTINCT owner) AS owners FROM processing.subscribed_jobs WHERE status='queued'"
            )
            LOGGER.info(
                "Processing admission: waiting=%s/%s session_waiting=%s/%s "
                "waiting_sessions=%s records=%s/%s input_bytes=%s/%s reserved_bytes=%s/%s shared=%s",
                count["waiting"] + (not shared),
                self.limits.max_waiting_jobs,
                subscribers["owned"] + (not shared or shared["status"] == "queued"),
                self.limits.max_owner_waiting_jobs,
                cursor.fetchone()["owners"],
                subscribers["records"] + 1,
                self.limits.max_job_records,
                count["inputs"]
                + presentation_bytes
                + sizes["presentation"]
                + (0 if shared else sizes["inputs"]),
                self.limits.max_job_input_bytes,
                count["bytes"] + (0 if shared else expected.reserved_bytes),
                self.limits.max_stored_bytes,
                bool(shared),
            )
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s", (identifier,)
            )
            return cursor.fetchone()

    def save_prepared_job(
        self,
        identifier: str,
        attempt: str,
        prepared: PreparedJobPlan,
        details: dict[str, Any],
    ) -> dict[str, Any]:
        """Save preparation and reserve disk, or queue the prepared job until it fits.

        Args:
            identifier: Running job ID.
            attempt: Worker attempt that must still own the job.
            prepared: Validated execution inputs, public summary and disk estimate.
            details: Bounded public preparation measurements retained until cleanup.

        Returns:
            Updated job with prepared details. Temporary disk contention returns
            it to queued without an attempt; preparation created no attempt files.

        Raises:
            ProcessingError: If ownership was lost, cancellation won, or the new
                inputs exceed capacity or this job alone exceeds the disk budget.
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
                "SELECT COALESCE(sum(reserved_bytes),0) AS bytes,COALESCE(sum(input_bytes),0) + "
                "(SELECT coalesce(sum(octet_length(presentation::text)),0) FROM processing.job_subscribers) AS inputs "
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
            if prepared.reserved_bytes > self.limits.max_stored_bytes:
                raise ProcessingError(
                    "storage_full",
                    "This calculation needs more temporary storage than the configured limit.",
                    422,
                )
            waiting = (
                used["bytes"] + prepared.reserved_bytes > self.limits.max_stored_bytes
            )
            cursor.execute(
                "UPDATE processing.jobs SET spec=%s,summary=%s,reserved_bytes=%s,preparation=%s,"
                "required_disk_bytes=%s,status=%s,"
                "attempt_id=CASE WHEN %s THEN NULL ELSE attempt_id END,"
                "lease_until=CASE WHEN %s THEN NULL ELSE lease_until END,"
                "deadline_at=CASE WHEN %s THEN NULL ELSE deadline_at END,"
                "execution_memory_bytes=CASE WHEN %s THEN 0 ELSE execution_memory_bytes END,"
                "progress=%s,updated_at=clock_timestamp() WHERE id=%s RETURNING *",
                (
                    Jsonb(prepared.specification),
                    Jsonb(prepared.summary),
                    0 if waiting else prepared.reserved_bytes,
                    Jsonb(details),
                    prepared.reserved_bytes,
                    "queued" if waiting else "running",
                    waiting,
                    waiting,
                    waiting,
                    waiting,
                    Jsonb({} if waiting else {"phase": "calculating"}),
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
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
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
                "SELECT * FROM processing.subscribed_jobs WHERE owner=%s AND status<>'deleted' ORDER BY subscribed_at DESC LIMIT 50",
                (owner,),
            )
            return cursor.fetchall()

    def cancel(
        self,
        identifier: str,
        owner: str,
        delete: bool = False,
    ) -> dict[str, Any]:
        """Cancel only this subscriber; stop computation when nobody needs it.

        Deleting a completed handle removes only that caller's access. Shared
        files remain until the last subscriber deletes them or results expire.

        Args:
            identifier: Caller-owned public job handle.
            owner: Current session hash.
            delete: Delete a terminal handle instead of cancelling active work.

        Returns:
            Updated subscriber state, including cancelling while its last worker exits.

        Raises:
            ProcessingError: If the handle is unowned or deletion targets active work.
        """
        with self._transaction(locked=True) as cursor:
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
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
            if delete or row["status"] in UNFINISHED:
                cursor.execute(
                    "UPDATE processing.job_subscribers SET status=%s,updated_at=clock_timestamp() WHERE id=%s",
                    ("deleted" if delete else "cancelled", identifier),
                )
                cursor.execute(
                    "UPDATE processing.jobs SET status=CASE "
                    "WHEN status='queued' THEN 'cancelled' WHEN status='running' THEN 'cancelling' "
                    "WHEN status='ready' THEN 'deleted' ELSE status END,updated_at=clock_timestamp() "
                    "WHERE id=%s AND NOT EXISTS (SELECT 1 FROM processing.job_subscribers WHERE job_id=%s AND status IS NULL) RETURNING status",
                    (row["job_id"], row["job_id"]),
                )
                stopped = cursor.fetchone()
                if not delete and stopped and stopped["status"] == "cancelling":
                    cursor.execute(
                        "UPDATE processing.job_subscribers SET status='cancelling' WHERE id=%s",
                        (identifier,),
                    )
            cursor.execute(
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s", (identifier,)
            )
            return cursor.fetchone()

    def claim_next_job(self) -> dict[str, Any] | None:
        """Claim a fitting queued job and reserve its execution capacity atomically.

        Sessions with no previous start go first. Ties use their oldest waiting
        fitting job, and each session's fitting jobs remain FIFO. A large stack cannot
        take another turn ahead of a session that has been waiting since its
        previous turn. Running jobs are never preempted. Cancellation and failure
        still count as a turn once execution starts.
        Shared work serves all subscribed sessions in one turn. The returned
        owner identifies the session whose turn selected it, not exclusive ownership.

        Running and cancelling jobs keep slots and memory until native work exits
        or its hard deadline plus exit grace passes. A lost heartbeat alone never
        frees capacity. Prepared jobs waiting for disk reuse their saved inputs.

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
                "SELECT count(*) FILTER (WHERE status IN ('running','cancelling')) AS active,"
                "coalesce(sum(execution_memory_bytes) FILTER (WHERE status IN ('running','cancelling')),0) AS memory,"
                "coalesce(sum(reserved_bytes),0) AS disk FROM processing.jobs"
            )
            capacity = cursor.fetchone()
            if (
                capacity["active"] >= self.limits.worker_count
                or capacity["memory"] + self.limits.process_memory_bytes
                > self.limits.max_execution_memory_bytes
            ):
                return None
            cursor.execute(
                "SELECT waiting.id,waiting.owner FROM ("
                "SELECT DISTINCT ON (s.owner) j.id,s.owner,j.created_at FROM processing.jobs j "
                "JOIN processing.job_subscribers s ON s.job_id=j.id "
                "WHERE j.status='queued' AND s.status IS NULL "
                "AND j.required_disk_bytes-j.reserved_bytes<=%s "
                "ORDER BY s.owner,j.created_at,j.id) waiting "
                "LEFT JOIN LATERAL (SELECT j.started_at FROM processing.jobs j "
                "JOIN processing.job_subscribers s ON s.job_id=j.id "
                "WHERE s.owner=waiting.owner AND j.started_at IS NOT NULL "
                "ORDER BY j.started_at DESC LIMIT 1) served ON true "
                "ORDER BY served.started_at NULLS FIRST,waiting.created_at,waiting.id LIMIT 1",
                (self.limits.max_stored_bytes - capacity["disk"],),
            )
            row = cursor.fetchone()
            if not row:
                return None
            cursor.execute(
                "UPDATE processing.jobs SET status='running',attempt_id=%s,lease_until=now()+%s*interval '1 second',deadline_at=now()+%s*interval '1 second',"
                "execution_memory_bytes=%s,reserved_bytes=greatest(reserved_bytes,required_disk_bytes),"
                "started_at=clock_timestamp(),updated_at=now() WHERE id=%s RETURNING *",
                (
                    uuid4().hex,
                    self.limits.lease_seconds,
                    self.limits.runtime_seconds + 15,
                    self.limits.process_memory_bytes,
                    row["id"],
                ),
            )
            claimed = cursor.fetchone()
            cursor.execute(
                "SELECT count(DISTINCT job_id) AS waiting,count(DISTINCT owner) AS owners "
                "FROM processing.subscribed_jobs WHERE status='queued'"
            )
            backlog = cursor.fetchone()
            LOGGER.info(
                "Processing execution started: waiting=%s waiting_sessions=%s queue_seconds=%.3f",
                backlog["waiting"],
                backlog["owners"],
                (claimed["started_at"] - claimed["created_at"]).total_seconds(),
            )
            claimed["owner"] = row["owner"]
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
                "SELECT * FROM processing.subscribed_jobs WHERE id=%s AND owner=%s",
                (identifier, owner),
            )
            row = cursor.fetchone()
            if not row:
                raise ProcessingError(
                    "job_not_found", "This processing job is unavailable.", 404
                )
            cursor.execute(
                "SELECT id FROM processing.jobs WHERE id=%s AND status='ready' AND expires_at>now()",
                (row["job_id"],),
            )
            if not cursor.fetchone() or row["status"] != "ready":
                raise ProcessingError(
                    "result_unavailable",
                    "This job result is not ready or its download has expired.",
                    409,
                )
            cursor.execute(
                "SELECT count(*) AS total, count(*) FILTER (WHERE job_id=%s) AS count FROM processing.transfers",
                (row["job_id"],),
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
                (lease, row["job_id"], self.limits.transfer_seconds),
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
