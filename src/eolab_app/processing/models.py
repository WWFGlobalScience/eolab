"""Operation-neutral job lifecycle, storage values, and Processing policy."""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field

OpaqueId = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]


@dataclass(frozen=True)
class PreparedJobPlan:
    """Validated operation data supplied to storage by its application owner.

    Attributes:
        specification: JSON-compatible, path-free operation specification.
        summary: Bounded public operation metadata, excluding large input payloads.
        reserved_bytes: Conservative working/result storage reservation in bytes.
        operation: Opaque versioned operation discriminator supplied by its owner.
        minimum_claim_version: Required worker claim protocol; legacy jobs use 1.
    """

    specification: dict[str, object]
    summary: dict[str, object]
    reserved_bytes: int
    operation: str = ""
    minimum_claim_version: int = 1


class JobSubmitRequest(BaseModel):
    """Accept a reviewed operation plan with a client-generated idempotency key."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    planId: OpaqueId
    requestId: Annotated[
        str, Field(min_length=16, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    ]


class JobPlanLimits(BaseModel):
    """Published output-size, runtime, and download-lifetime limits."""

    maxRawBytes: int
    runtimeSeconds: float
    downloadLifetimeSeconds: int


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


@dataclass(frozen=True)
class ProcessingLimits:
    """Deployment-wide scheduling, execution and retention limits.

    calculation_cache_capacity bounds the number of shared numerical results;
    zero disables cache reads and writes. calculation_cache_ttl_seconds limits
    reuse to 24 hours by default, independently of job/download expiry. Each
    database cache payload is additionally limited to 32 KiB.
    """

    plan_timeout_seconds: float = 15
    runtime_seconds: float = 600
    plan_ttl_seconds: int = 300
    result_ttl_seconds: int = 86_400
    max_waiting: int = 10
    max_owner_unfinished: int = 2
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
    """Owned artifact plus its bounded, renewable transfer lease."""

    path: Path
    filename: str
    size: int
    sha256: str
    lease_id: str
    media_type: str
