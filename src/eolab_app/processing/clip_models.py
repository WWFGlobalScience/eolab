"""Raster-clip inputs and result details layered on shared Processing contracts."""

from eolab_app.catalog_selection import ResolvedCatalogSelection, VectorSelection
from dataclasses import dataclass, field
from typing import Annotated, Literal

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
    JobProgressResponse,
    JobResponse,
    JobResultResponse,
    ProcessingLimits,
)
from eolab_app.sampling_box import Wgs84SamplingBox, sampling_box_bounds
from eolab_app.raster.models import CatalogRasterRequest, Wgs84Bounds
from eolab_app.raster.source_models import RasterSourceReference, RunArtifactReference

OPERATION_VERSION = "raster.clip.v1"


class ClipInputs(BaseModel):
    """A catalog or private raster and an explicit geographic clip area.

    Catalog requests use collectionId/itemId or a nested ``source`` reference.
    Private run-file requests use ``source`` with the owned artifact identity.
    The clip area may be a geodesic sampling box, geographic rectangle, or
    features selected from a Catalog vector or private upload.
    """

    model_config = ConfigDict(extra="forbid")
    source: RasterSourceReference | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    collection_id: str | None = Field(
        default=None, alias="collectionId", exclude_if=lambda value: value is None
    )
    item_id: str | None = Field(
        default=None, alias="itemId", exclude_if=lambda value: value is None
    )

    selectedBounds: Wgs84Bounds | None = None
    samplingBox: Wgs84SamplingBox | None = None
    catalogSelection: VectorSelection | None = None

    @model_validator(mode="after")
    def validate_clip_inputs(self) -> "ClipInputs":
        """Require one raster reference and one explicit geographic clip area.

        Returns:
            Validated request.

        Raises:
            ValueError: If source identities conflict or the area is absent or ambiguous.
        """
        if self.source is None:
            CatalogRasterRequest(collectionId=self.collection_id, itemId=self.item_id)
        elif self.collection_id is not None or self.item_id is not None:
            raise ValueError("Choose one raster source")
        if (
            sum(
                value is not None
                for value in (
                    self.selectedBounds,
                    self.samplingBox,
                    self.catalogSelection,
                )
            )
            != 1
        ):
            raise ValueError("Choose exactly one map area or vector selection")
        return self


class ClipJobRequest(ClipInputs):
    """Raster and area to clip, with a stable key for retrying one submission."""

    requestId: Annotated[
        str, Field(min_length=16, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    ]


class UnpreparedClip(BaseModel):
    """Saved clip inputs awaiting metadata inspection by the job worker."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["raster.clip.v1"] = OPERATION_VERSION
    request: ClipInputs


class ClipArea(BaseModel):
    """Retain a rectangle, geodesic box or vector predicate for a native clip.

    Geodesic boxes keep their center and kilometer side length; their bounds are
    only the geographic envelope. Workers derive polygon rings for their own grid."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["bounds", "samplingBox", "catalogSelection"]
    bounds: tuple[float, float, float, float]
    samplingBox: Wgs84SamplingBox | None = None
    catalogSelection: VectorSelection | None = None
    resolved: ResolvedCatalogSelection | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def require_area_contract(self) -> "ClipArea":
        """Validate the persisted selection discriminator before native execution.

        Returns:
            The validated operation-owned area.

        Raises:
            ValueError: For inconsistent vector or box inputs.
        """
        Wgs84Bounds(
            west=self.bounds[0],
            south=self.bounds[1],
            east=self.bounds[2],
            north=self.bounds[3],
        )
        if self.kind == "samplingBox":
            if (
                self.samplingBox is None
                or self.bounds != sampling_box_bounds(self.samplingBox)
                or self.catalogSelection is not None
                or self.resolved is not None
            ):
                raise ValueError(
                    "Sampling boxes require only their descriptor and geographic envelope"
                )
            return self
        if self.samplingBox is not None:
            raise ValueError("Only sampling boxes may carry a samplingBox descriptor")
        if self.kind == "catalogSelection":
            if self.catalogSelection is None:
                raise ValueError(
                    "Vector areas require only a vector selection descriptor"
                )
            if (
                self.resolved is not None
                and self.resolved.selection != self.catalogSelection
            ):
                raise ValueError("Resolved source does not match the vector selection")
        elif self.catalogSelection is not None or self.resolved is not None:
            raise ValueError("Only vector areas may carry a vector source")
        return self

    @model_serializer(mode="wrap")
    def serialize_area(
        self, handler: SerializerFunctionWrapHandler
    ) -> dict[str, object]:
        """Omit the vector descriptor when serializing a box.

        Args:
            handler: Pydantic's serialization handler.

        Returns:
            Path-free area matching its versioned discriminator.
        """
        data = handler(self)
        if self.kind != "samplingBox":
            data.pop("samplingBox", None)
        if self.kind != "catalogSelection":
            data.pop("catalogSelection", None)
        return data


class ClipGrid(BaseModel):
    """Native clip window, source block count and estimated uncompressed size."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    crs: str
    transform: tuple[float, float, float, float, float, float]
    window: tuple[int, int, int, int]
    width: int
    height: int
    dtype: str
    nodata: str | None
    nativeBlocks: int
    estimatedRawBytes: int


class ClipSpec(BaseModel):
    """A path-free clip plan with catalog identity or a published-file checksum."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["raster.clip.v1"] = OPERATION_VERSION
    source: RasterSourceReference
    sourceSignature: tuple[int, int, int, int] | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    sourceChecksum: str | None = Field(
        default=None, pattern=r"^[a-f0-9]{64}$", exclude_if=lambda value: value is None
    )
    area: ClipArea
    grid: ClipGrid

    @model_validator(mode="after")
    def check_source_checksum(self) -> "ClipSpec":
        """Require catalog metadata or a published checksum for the plan's source.

        Returns:
            The prepared clip with the correct source identity contract.

        Raises:
            ValueError: If the signature or checksum disagrees with the source type.
        """
        private = isinstance(self.source, RunArtifactReference)
        if private != (self.sourceChecksum is not None):
            raise ValueError("Private raster plans require their published checksum")
        if private != (self.sourceSignature is None):
            raise ValueError("Only catalog raster plans require a source signature")
        return self


class ClipAreaSummary(BaseModel):
    """Browser-safe area description without copying geometry into every poll."""

    kind: Literal["bounds", "samplingBox", "catalogSelection"]
    bounds: tuple[float, float, float, float] | None
    samplingBox: Wgs84SamplingBox | None = Field(
        default=None, exclude_if=lambda value: value is None
    )


class ClipResultResponse(JobResultResponse):
    """Add raster validity counts to shared owned download metadata."""

    validPixels: int


class ClipProgressResponse(JobProgressResponse):
    """Add bounded native block progress and supported clip execution phases."""

    phase: (
        Literal[
            "preparing",
            "calculating",
            "clipping",
            "creating_cog",
            "validating",
            "checksumming",
            "ready",
        ]
        | None
    ) = None
    completedBlocks: int | None = None
    totalBlocks: int | None = None


class ClipJobResponse(JobResponse):
    """Add raster context to the shared job lifecycle without redefining it."""

    operation: Literal["raster.clip.v1"]
    source: RasterSourceReference | None
    grid: ClipGrid | None
    area: ClipAreaSummary | None
    progress: ClipProgressResponse
    result: ClipResultResponse | None


# The listing reuses the common envelope; adding a supported operation can extend
# its response union without copying job ownership, status, failure, or timestamps.
ClipJobsResponse = JobListResponse[ClipJobResponse]


@dataclass(frozen=True)
class RasterClipLimits(ProcessingLimits):
    """Configure clip job scheduling and result retention.

    Clipping streams native blocks without a total-work or storage ceiling.
    """


@dataclass(frozen=True)
class ClipArtifact(Artifact):
    """Extend shared artifact metadata with the clip's valid-pixel count."""

    valid_pixels: int
    media_type: str = field(default="image/tiff", kw_only=True)
