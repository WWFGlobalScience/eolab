"""Job persistence and artifact storage contracts used by Processing workflows."""

from typing import Protocol, Any
from pathlib import Path
from eolab_app.processing.models import Artifact, PreparedJobPlan, ProcessingLimits


class JobSubscription(Protocol):
    """A bounded owner-specific change hint, never a result or authorization."""

    async def wait(self, timeout: float) -> bool:
        """Consume a coalesced hint or time out for a transport heartbeat.

        Args:
            timeout: Maximum wait in seconds.

        Returns:
            True for a pending hint, False after the timeout.
        """
        ...

    def close(self) -> None:
        """Release this subscription and its connection-capacity reservation."""
        ...


class JobChanges(Protocol):
    """Processing's session-isolated change-subscription provider."""

    def subscribe(self, owner: str) -> JobSubscription:
        """Register before the consumer refreshes its authoritative job state.

        Args:
            owner: Hash obtained from the existing HTTP session capability.

        Returns:
            Bounded subscription that the consumer must close.
        """
        ...


class JobWakeup(Protocol):
    """Queue hints only; callers must still use durable admission and claims."""

    async def arm(self) -> None:
        """Arm notifications before checking the queue, clearing only older hints."""
        ...

    async def wait(self, timeout: float) -> bool:
        """Wait for work without depending on notification delivery.

        Args:
            timeout: Maximum idle seconds before the caller checks storage again.

        Returns:
            Whether a hint arrived before the fallback polling deadline.
        """
        ...

    async def close(self) -> None:
        """Release listener resources when the worker shuts down."""
        ...


class JobStore(Protocol):
    """Storage capability; implementations do not invoke application services."""

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
        ...

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
        ...

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
        ...

    def find_request(self, owner: str, request_key: str) -> dict[str, Any] | None:
        """Recover a committed job after a lost submission response.

        Args:
            owner: Current session hash.
            request_key: Client idempotency key.

        Returns:
            Matching owned job, including a terminal tombstone, or None.
        """
        ...

    def discard_plan(self, identifier: str, owner: str) -> None:
        """Release an owned completed plan without touching native-work fencing.

        Args:
            identifier: Opaque completed plan ID.
            owner: Current session hash.
        """
        ...

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
        ...

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
        ...

    def list_owned(self, owner: str) -> list[dict[str, Any]]:
        """Return at most 50 recent jobs for session recovery.

        Args:
            owner: Current session hash.

        Returns:
            Newest owned jobs first, with no global listing.
        """
        ...

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
        ...

    def claim(self) -> dict[str, Any] | None:
        """Claim one global execution slot and fence it with an attempt token.

        Crash recovery waits through the previous hard deadline plus exit grace.
        A lost DB connection cannot cause a second native child to start while
        the old child could still be running under its supervisor deadline.

        Returns:
            Claimed job or None while another attempt reserves the slot.
        """
        ...

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
        ...

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
        ...

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
        ...

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
        ...

    def transfer_heartbeat(self, lease: str, release: bool = False) -> bool:
        """Renew or release a bounded download lease.

        Args:
            lease: Opaque transfer ID minted by acquire_transfer.
            release: Delete the lease after response completion/disconnection.

        Returns:
            Whether the transfer lease still exists.
        """
        ...

    def cleanup_candidates(self) -> list[dict[str, Any]]:
        """Revoke expired results and return terminal attempts safe to remove.

        Returns:
            At most 100 rows with no active transfer; budgets remain reserved
            until the worker confirms filesystem cleanup.
        """
        ...

    def cleaned(self, identifier: str) -> None:
        """Release storage and operation payloads only after successful file removal.

        Args:
            identifier: Terminal job with completed cleanup.
        """
        ...

    def active_attempts(self) -> set[str]:
        """Read attempt IDs that still own files, including ready results.

        Returns:
            IDs retained for active, ready, or transfer-leased jobs.
        """
        ...


class JobArtifactStore(Protocol):
    """Storage capability; implementations do not invoke application services."""

    def prepare(self, attempt: str, reservation: int, limits: ProcessingLimits) -> Path:
        """Check actual disk headroom and create one unique private attempt.

        Args:
            attempt: Fenced worker attempt ID.
            reservation: Admitted worst-case scratch/output byte reservation.
            limits: Free-space floor and global on-disk ceiling.

        Returns:
            Empty attempt directory.

        Raises:
            ProcessingError: If physical disk headroom is insufficient.
        """
        ...

    def publish(self, attempt: str, reservation: int) -> None:
        """Atomically rename a closed, validated attempt on the same volume.

        Args:
            attempt: Fenced attempt whose native operation completed successfully.
            reservation: Admitted scratch/output ceiling, checked before publish.

        Raises:
            ProcessingError: If the completed output exceeds its reservation.
            OSError: If atomic publication fails.
        """
        ...

    def result_path(
        self, attempt: str, provenance: bool = False, result_name: str = "result.tif"
    ) -> Path:
        """Locate a finished file after the caller verifies owner and transfer lease.

        Args:
            attempt: Job-owned published attempt ID.
            provenance: Select the immutable provenance JSON instead of GeoTIFF.
            result_name: Server-owned artifact descriptor, defaulting to legacy clips.

        Returns:
            Confined, existing artifact path.

        Raises:
            ProcessingError: If the immutable artifact is absent or not a file.
        """
        ...

    def progress(self, attempt: str) -> dict[str, Any]:
        """Read only bounded progress fields from the private child output.

        Args:
            attempt: Current fenced execution ID.

        Returns:
            Latest complete phase/progress record, or an empty mapping.
        """
        ...

    def remove(self, attempt: str) -> None:
        """Remove only one verified attempt after native and transfer leases end.

        Args:
            attempt: Terminal job's strict internal attempt ID.

        Raises:
            OSError: If cleanup failed; the caller must retain its reservation.
        """
        ...

    def remove_orphans(self, retained: set[str], minimum_age_seconds: float) -> None:
        """Reap abandoned attempts only after their maximum possible runtime.

        Args:
            retained: IDs that still own database reservations or transfer leases.
            minimum_age_seconds: Conservative hard-deadline plus exit grace.
        """
        ...
