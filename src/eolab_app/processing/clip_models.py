"""Raster-clip inputs and result details layered on shared Processing contracts."""

from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from dataclasses import dataclass, field
from typing import Annotated, Literal
from datetime import datetime

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    model_validator,
    model_serializer,
    SerializerFunctionWrapHandler,
)

from eolab_app.processing.models import (
    Artifact,
    JobListResponse,
    JobPlanLimits,
    JobProgressResponse,
    JobResponse,
    JobResultResponse,
    OpaqueId,
    ProcessingLimits,
)
from eolab_app.raster.models import CatalogRasterRequest, Wgs84Bounds

OPERATION_VERSION = "raster.clip.v1"


class ClipPlanRequest(CatalogRasterRequest):
    """A catalog raster and exactly one explicit, lifecycle-valid clip area."""

    selectedBounds: Wgs84Bounds | None = None
    catalogSelection: CatalogSelection | None = None

    @model_validator(mode="after")
    def require_explicit_area(self) -> "ClipPlanRequest":
        """Require one area; omission must never become a whole-raster export.

        Returns:
            Validated request.

        Raises:
            ValueError: If neither or both selection variants were supplied.
        """
        if (self.selectedBounds is None) == (self.catalogSelection is None):
            raise ValueError("Choose exactly one histogram box or catalog selection")
        return self


class ClipArea(BaseModel):
    """Durable box or catalog descriptor, with a reader for historical polygon jobs."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["bounds", "catalogSelection", "aoi"]
    bounds: tuple[float, float, float, float]
    # Historical completed/pending jobs may contain v1 polygon snapshots.
    # New requests cannot submit them; no live AOI service is retained.
    geometries: tuple[dict[str, object], ...] = ()
    catalogSelection: CatalogSelection | None = None
    resolved: ResolvedCatalogSelection | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def require_area_contract(self) -> "ClipArea":
        """Validate the persisted selection discriminator before native execution.

        Returns:
            The validated operation-owned area.

        Raises:
            ValueError: For inconsistent catalog, box, or historical inputs.
        """
        Wgs84Bounds(
            west=self.bounds[0],
            south=self.bounds[1],
            east=self.bounds[2],
            north=self.bounds[3],
        )
        if self.kind == "catalogSelection":
            if self.catalogSelection is None or self.geometries:
                raise ValueError(
                    "Catalog areas require only a catalog selection descriptor"
                )
            if (
                self.resolved is not None
                and self.resolved.selection != self.catalogSelection
            ):
                raise ValueError("Resolved source does not match the catalog selection")
        elif self.catalogSelection is not None or self.resolved is not None:
            raise ValueError("Only catalog areas may carry a catalog source")
        elif (self.kind == "aoi") != bool(self.geometries):
            raise ValueError("Only historical polygon areas contain geometry")
        return self

    @model_serializer(mode="wrap")
    def serialize_area(
        self, handler: SerializerFunctionWrapHandler
    ) -> dict[str, object]:
        """Preserve historical wire fields while new selections contain no geometry.

        Args:
            handler: Pydantic's serialization handler.

        Returns:
            Path-free area matching its versioned discriminator.
        """
        data = handler(self)
        data.pop(
            "geometries" if self.kind == "catalogSelection" else "catalogSelection",
            None,
        )
        return data


class ClipGrid(BaseModel):
    """Planned native window and conservative work/storage estimates."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    crs: str
    transform: tuple[float, float, float, float, float, float]
    window: tuple[int, int, int, int]
    width: int
    height: int
    dtype: str
    nodata: str | None
    nativeBlocks: int
    decodedBytes: int
    estimatedRawBytes: int
    reservedBytes: int


class ClipSpec(BaseModel):
    """Durable, path-free clip plan with catalog identity retained for provenance."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["raster.clip.v1"] = OPERATION_VERSION
    source: CatalogRasterRequest
    sourceSignature: tuple[int, int, int, int]
    area: ClipArea
    grid: ClipGrid


class ClipAreaSummary(BaseModel):
    """Browser-safe area description without copying geometry into every poll."""

    kind: Literal["bounds", "catalogSelection", "aoi"]
    bounds: tuple[float, float, float, float]


class ClipPlanResponse(BaseModel):
    """Versioned, reviewable native-grid plan returned before job admission."""

    planId: OpaqueId
    operation: Literal["raster.clip.v1"]
    source: CatalogRasterRequest
    area: ClipAreaSummary
    grid: ClipGrid
    expiresAt: datetime
    format: Literal["COG"]
    resolution: Literal["native"]
    allTouched: Literal[True]
    limits: JobPlanLimits


class ClipResultResponse(JobResultResponse):
    """Add raster validity counts to shared owned download metadata."""

    validPixels: int


class ClipProgressResponse(JobProgressResponse):
    """Add bounded native block progress and supported clip execution phases."""

    phase: (
        Literal["clipping", "creating_cog", "validating", "checksumming", "ready"]
        | None
    ) = None
    completedBlocks: int | None = None
    totalBlocks: int | None = None


class ClipJobResponse(JobResponse):
    """Add raster context to the shared job lifecycle without redefining it."""

    operation: Literal["raster.clip.v1"]
    source: CatalogRasterRequest | None
    grid: ClipGrid | None
    area: ClipAreaSummary | None
    progress: ClipProgressResponse
    result: ClipResultResponse | None


# The listing reuses the common envelope; adding a supported operation can extend
# its response union without copying job ownership, status, failure, or timestamps.
ClipJobsResponse = JobListResponse[ClipJobResponse]


@dataclass(frozen=True)
class RasterClipLimits(ProcessingLimits):
    """Native raster/geometry budgets in addition to shared scheduling policy."""

    max_raw_bytes: int = 1024**3
    max_decoded_bytes: int = 4 * 1024**3
    max_native_blocks: int = 65_536
    max_coordinates: int = 500_000


@dataclass(frozen=True)
class ClipArtifact(Artifact):
    """Extend shared artifact metadata with the clip's valid-pixel count."""

    valid_pixels: int
    media_type: str = field(default="image/tiff", kw_only=True)
