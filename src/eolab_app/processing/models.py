"""Operation-neutral job lifecycle, storage values, and Processing policy."""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, Field

OpaqueId = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]


@dataclass(frozen=True)
class PreparedJobPlan:
    """Validated operation data supplied to storage by its application owner.

    Attributes:
        specification: JSON-compatible, path-free operation specification.
        summary: Bounded public operation metadata, excluding large input payloads.
        reserved_bytes: Conservative working/result storage reservation in bytes.
        operation: Opaque versioned operation discriminator supplied by its owner.
        work_key: Complete computation identity; None means never join active work.
        presentation: Small caller-specific labels, separate from shared execution.
    """

    specification: dict[str, object]
    summary: dict[str, object]
    reserved_bytes: int
    operation: str = ""
    work_key: str | None = None
    presentation: dict[str, object] | None = None


@dataclass(frozen=True)
class JobSubmission:
    """One retryable admission, including an optional input-resolution failure.

    Attributes:
        request_key: Owner-scoped retry identifier.
        request_hash: Complete validated request identity.
        operation: Expected operation, including when input resolution failed.
        prepared: Operation data or its sanitized resolution error. Storage first
            recovers an existing retry, which may outlive its original input.
    """

    request_key: str
    request_hash: str
    operation: str
    prepared: "PreparedJobPlan | ProcessingError"


class JobResultResponse(BaseModel):
    """Owned download metadata shared by operation-specific result contracts."""

    url: str
    provenanceUrl: str
    filename: str
    bytes: int
    sha256: str


class JobFailureResponse(BaseModel):
    """Sanitized terminal failure retained with its processing job."""

    code: str
    detail: str


class JobProgressResponse(BaseModel):
    """Named operation progress, extended with operation-specific work counts."""

    phase: str | None = None


class JobResponse(BaseModel):
    """Shared owned job lifecycle, independent of operation inputs and algorithms."""

    jobId: OpaqueId
    operation: str
    status: Literal[
        "queued",
        "running",
        "cancelling",
        "ready",
        "failed",
        "cancelled",
        "interrupted",
        "expired",
        "deleted",
    ]
    createdAt: datetime
    updatedAt: datetime
    expiresAt: datetime
    progress: JobProgressResponse
    error: JobFailureResponse | None
    result: JobResultResponse | None


JobResponseType = TypeVar("JobResponseType", bound=JobResponse)


class JobListResponse(BaseModel, Generic[JobResponseType]):
    """Bounded owned job listing, parameterized by supported operation contracts."""

    jobs: list[JobResponseType]


class JobStatusRequest(BaseModel):
    """Read up to 100 public job IDs belonging to the current session.

    Duplicate IDs are accepted and returned once. This reads statuses without
    submitting work or changing the requested jobs.
    """

    jobIds: list[OpaqueId] = Field(min_length=1, max_length=100)


class JobStatusResponse(JobListResponse[JobResponseType], Generic[JobResponseType]):
    """Requested job snapshots and IDs unavailable to the current session.

    Foreign and nonexistent IDs are both unavailable; no other owner's job
    information is disclosed. Each distinct requested ID appears in one list.
    """

    unavailableJobIds: list[OpaqueId]


@dataclass(frozen=True)
class ProcessingLimits:
    """Deployment-wide scheduling, execution and retention limits.

    Waiting-job limits count only queued work, not running attempts.
    Each active attempt reserves process_memory_bytes before preparation.
    max_execution_memory_bytes bounds their combined native address-space limits;
    container memory must additionally cover idle processes and the supervisor.
    max_job_records includes finished jobs and seven-day idempotency records.
    Metadata retention uses record counts and individual request size limits.
    max_stored_bytes bounds artifact and scratch disk reservations after preparation.

    calculation_cache_capacity bounds the number of shared numerical results;
    zero disables cache reads and writes. calculation_cache_ttl_seconds limits
    reuse to 24 hours by default, independently of job/download expiry. Each
    database cache payload is additionally limited to 32 KiB.
    """

    plan_timeout_seconds: float = 15
    worker_count: int = 1
    process_memory_bytes: int = 2 * 1024**3
    max_execution_memory_bytes: int = 2 * 1024**3
    runtime_seconds: float = 600
    result_ttl_seconds: int = 86_400
    max_waiting_jobs: int = 128
    max_owner_waiting_jobs: int = 32
    max_job_records: int = 4096
    max_stored_bytes: int = 20 * 1024**3
    free_space_floor: int = 2 * 1024**3
    result_metadata_reservation_bytes: int = 9 * 1024**2
    lease_seconds: int = 20
    transfer_seconds: int = 120
    # Shared numerical results; independent of owned job/download lifetimes.
    calculation_cache_capacity: int = 1_000
    calculation_cache_ttl_seconds: int = 86_400


class ProcessingError(Exception):
    """Sanitized, stable error at the processing API boundary."""

    def __init__(self, code: str, detail: str, status: int = 422) -> None:
        """Create a safe processing failure.

        Args:
            code: Machine-readable reason, also retained on failed jobs.
            detail: User-facing explanation without private paths or raw errors.
            status: Appropriate HTTP response status.
        """
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status = status


@dataclass(frozen=True)
class Artifact:
    """Validated immutable file metadata, extended by its operation if needed."""

    size: int
    sha256: str
    filename: str
    media_type: str = field(default="application/octet-stream", kw_only=True)


@dataclass(frozen=True)
class ArtifactDownload:
    """Owned artifact plus its bounded, renewable transfer lease.

    Attributes:
        path: Confined shared result file retained by the lease.
        filename: Suggested download name.
        size: Delivered byte count.
        sha256: Delivered content checksum.
        lease_id: Transfer capability keeping shared files alive.
        media_type: Download content type.
        content: Optional small CSV/JSON personalized with the caller's labels.
    """

    path: Path
    filename: str
    size: int
    sha256: str
    lease_id: str
    media_type: str
    content: bytes | None = None
