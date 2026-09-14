"""Strict single-raster calculation plans and operation-specific result values."""

from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from dataclasses import dataclass, field, fields
from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    model_serializer,
    model_validator,
)

from eolab_app.processing.models import (
    Artifact,
    JobProgressResponse,
    JobResponse,
    JobResultResponse,
    OpaqueId,
    ProcessingLimits,
    ProcessingError,
)
from eolab_app.processing.raster_expression import FUNCTIONS, compile_expression, walk
from eolab_app.raster.models import CatalogRasterRequest, Wgs84Bounds

OPERATION_VERSION = "raster.aggregate.v1"
Alias = Annotated[str, Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,31}$")]
ChunkPixels = Annotated[int, Field(strict=True, ge=1, le=4_194_304)]


class NamedCalculation(BaseModel):
    """One user-labeled scalar expression, with no executable payload."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    label: Annotated[str, Field(min_length=1, max_length=80)]
    expression: Annotated[str, Field(min_length=1, max_length=4096)]


class AggregateValidationRequest(BaseModel):
    """Bounded language validation independent of source lookup and raster I/O."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    alias: Alias = "a"
    calculations: Annotated[
        tuple[NamedCalculation, ...], Field(min_length=1, max_length=5)
    ]

    @model_validator(mode="after")
    def validate_language(self) -> "AggregateValidationRequest":
        """Check the same bounded language used by planning and execution.

        Returns:
            The checked request.

        Raises:
            ValueError: For invalid aliases, labels, types, or expression budget.
        """
        alias = self.alias
        if alias in FUNCTIONS | {"where"}:
            raise ValueError("The raster alias cannot be a function or keyword")
        if len({item.label for item in self.calculations}) != len(self.calculations):
            raise ValueError("Calculation labels must be unique")
        if (
            sum(len(item.expression.encode("utf-8")) for item in self.calculations)
            > 4096
        ):
            raise ValueError("All expressions together must fit within 4 KiB")
        try:
            trees = [
                compile_expression(item.expression, alias) for item in self.calculations
            ]
        except ProcessingError as error:
            raise ValueError(error.detail) from error
        if sum(sum(1 for _ in walk(tree)) for tree in trees) > 256:
            raise ValueError(
                "All expressions together must use at most 256 syntax nodes"
            )
        return self


class AggregatePlanRequest(BaseModel):
    """Exactly one catalog binding, bounded expressions, and an explicit area."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    sources: Annotated[
        dict[Alias, CatalogRasterRequest], Field(min_length=1, max_length=1)
    ]
    calculations: Annotated[
        tuple[NamedCalculation, ...], Field(min_length=1, max_length=5)
    ]
    selectedBounds: Wgs84Bounds | None = None
    catalogSelection: CatalogSelection | None = None
    wholeRaster: Literal[True] | None = None
    targetChunkPixels: ChunkPixels | None = None

    @model_validator(mode="after")
    def validate_intent(self) -> "AggregatePlanRequest":
        """Validate area and reuse the I/O-free expression contract.

        Returns:
            The checked request.

        Raises:
            ValueError: For ambiguous area or invalid calculation language.
        """
        if (
            sum(
                value is not None
                for value in (
                    self.selectedBounds,
                    self.catalogSelection,
                    self.wholeRaster,
                )
            )
            != 1
        ):
            raise ValueError(
                "Choose one box, catalog selection, or explicit whole raster"
            )
        AggregateValidationRequest(
            alias=next(iter(self.sources)), calculations=self.calculations
        )
        return self


class AggregateArea(BaseModel):
    """Durable catalog, box, whole-raster intent or historical polygon job input."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["bounds", "catalogSelection", "aoi", "wholeRaster"]
    bounds: tuple[float, float, float, float] | None = None
    # Historical completed/pending jobs may contain v1 polygon snapshots.
    # New requests cannot submit them; no live AOI service is retained.
    geometries: tuple[dict[str, object], ...] = ()
    catalogSelection: CatalogSelection | None = None
    resolved: ResolvedCatalogSelection | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def require_area_contract(self) -> "AggregateArea":
        """Validate durable selection shape at the operation's storage boundary.

        Returns:
            Validated area with explicit whole-raster or geographic intent.

        Raises:
            ValueError: If fields disagree with the selection discriminator.
        """
        if self.kind == "wholeRaster":
            if (
                self.bounds is not None
                or self.geometries
                or self.catalogSelection is not None
                or self.resolved is not None
            ):
                raise ValueError("Whole-raster intent cannot contain selected geometry")
            return self
        # Clipping and aggregate selection shapes share the same persisted
        # geographic contract; this is an operation-owned value validation only.
        if self.bounds is None:
            raise ValueError("A geographic selection requires bounds")
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
        """Preserve old area fields and serialize new selections without geometry.

        Args:
            handler: Pydantic's serialization handler.

        Returns:
            The discriminator's path-free durable area representation.
        """
        data = handler(self)
        data.pop(
            "geometries" if self.kind == "catalogSelection" else "catalogSelection",
            None,
        )
        return data


class GroundAreaPlan(BaseModel):
    """Reviewed ellipsoidal measurement method and bounded geometry work."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    method: Literal["ellipsoidal_cylindrical_equal_area"] = (
        "ellipsoidal_cylindrical_equal_area"
    )
    ellipsoid: Literal["WGS84"] = "WGS84"
    units: Literal["ha"] = "ha"
    inclusion: Literal["fractional_cell_intersection"] = "fractional_cell_intersection"
    edgeToleranceMetres: float
    maximumSegmentMetres: float
    estimatedGeometryCells: int
    strategy: Literal["rectilinear", "cell_polygons"]


class AggregateExecutionPlan(BaseModel):
    """Immutable maximum read/tile dimensions; edge windows can be smaller."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    targetChunkPixels: ChunkPixels | None = None
    readWidth: Annotated[int, Field(gt=0)]
    readHeight: Annotated[int, Field(gt=0)]
    evaluationWidth: Annotated[int, Field(gt=0)]
    evaluationHeight: Annotated[int, Field(gt=0)]
    readWindows: Annotated[int, Field(gt=0, le=65_536)]


StageSeconds = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class AggregateKernelStages(BaseModel):
    """Nested wall times; mask, weights and reductions are inside calculation.

    Source setup includes compilation, signature checks and opening the raster.
    Selection setup reads/projects the area envelope. Mask time includes vector
    source reads, projection and rasterization. All times include I/O waits.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    sourceSetupSeconds: StageSeconds
    selectionSetupSeconds: StageSeconds
    groundAreaSetupSeconds: StageSeconds
    gridCheckSeconds: StageSeconds
    selectionMaskSeconds: StageSeconds
    areaWeightsSeconds: StageSeconds
    reductionSeconds: StageSeconds


class AggregatePerformance(BaseModel):
    """Final bounded wall-time measurements, independent of transient progress."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    execution: AggregateExecutionPlan
    readWindows: Annotated[int, Field(ge=1, le=65_536)]
    evaluationTiles: Annotated[int, Field(ge=1, le=2**53 - 1)]
    reducerUpdates: Annotated[int, Field(ge=1, le=2**53 - 1)]
    readSeconds: Annotated[float, Field(ge=0, le=86_400, allow_inf_nan=False)]
    calculationSeconds: Annotated[float, Field(ge=0, le=86_400, allow_inf_nan=False)]
    resultWriteSeconds: Annotated[float, Field(ge=0, le=86_400, allow_inf_nan=False)]
    kernelSeconds: Annotated[float, Field(ge=0, le=86_400, allow_inf_nan=False)]
    stages: AggregateKernelStages | None = None


class AggregateGrid(BaseModel):
    """Native grid, value domain, and conservative work/memory admission."""

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
    estimatedMemoryBytes: int
    scale: str
    offset: str
    storedUnit: str | None
    groundArea: GroundAreaPlan | None = None
    execution: AggregateExecutionPlan | None = None

    @model_serializer(mode="wrap")
    def serialize_grid(
        self, handler: SerializerFunctionWrapHandler
    ) -> dict[str, object]:
        """Preserve the existing wire shape for numeric-only accepted jobs.

        Args:
            handler: Pydantic's normal field serializer.

        Returns:
            Grid fields, with area metadata only when that method is required.
        """
        result = handler(self)
        if self.groundArea is None:
            result.pop("groundArea", None)
        if self.execution is None:
            result.pop("execution", None)
        return result


class AggregateSpec(BaseModel):
    """Versioned, source-fenced executable intent derived from an accepted plan."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["raster.aggregate.v1"] = OPERATION_VERSION
    sources: Annotated[
        dict[Alias, CatalogRasterRequest], Field(min_length=1, max_length=1)
    ]
    sourceSignature: tuple[int, int, int, int]
    calculations: tuple[NamedCalculation, ...]
    area: AggregateArea
    grid: AggregateGrid


class AggregateValue(BaseModel):
    """Lossless decimal value and explicit per-calculation data state."""

    label: str
    expression: str
    value: str | None
    valueType: Literal["integer", "float"] | None
    state: Literal[
        "ok", "no_matches", "no_valid_data", "invalid_arithmetic", "overflow"
    ]
    aggregates: list[dict[str, str | int]]
    unit: Literal["ha"] | None = None


class NativeProcessTiming(BaseModel):
    """Optional reusable-process timings, nested inside the native call duration."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    readyWaitSeconds: StageSeconds
    operationSeconds: StageSeconds
    overheadSeconds: StageSeconds
    reusedProcess: Annotated[bool, Field(strict=True)]


class AggregatePlanTiming(BaseModel):
    """Monotonic server durations within one successful planning request."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    reservationSeconds: StageSeconds
    preparationSeconds: StageSeconds
    nativeProcessSeconds: StageSeconds
    finalizationSeconds: StageSeconds
    process: NativeProcessTiming | None = None


class AggregateExecutionTiming(BaseModel):
    """Worker stages and database-clock queue interval for one successful attempt."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    queueSeconds: StageSeconds
    preparationSeconds: StageSeconds
    nativeProcessSeconds: StageSeconds
    publicationSeconds: StageSeconds
    process: NativeProcessTiming | None = None


class AggregateResultResponse(JobResultResponse):
    """Small inline results plus owned CSV and provenance downloads."""

    rows: list[AggregateValue]
    performance: AggregatePerformance | None = None
    executionTiming: AggregateExecutionTiming | None = None
    queuedToReadySeconds: StageSeconds | None = None


class AggregateProgress(JobProgressResponse):
    """Measured native-block progress and result publication phases."""

    completedBlocks: int | None = None
    totalBlocks: int | None = None


class AggregateJobResponse(JobResponse):
    """Calculation-specific details layered on the existing job lifecycle."""

    operation: Literal["raster.aggregate.v1"]
    sources: dict[str, CatalogRasterRequest] | None
    calculations: tuple[NamedCalculation, ...] | None
    area: dict[str, object] | None
    grid: AggregateGrid | None
    progress: AggregateProgress
    result: AggregateResultResponse | None


class AggregatePlanResponse(BaseModel):
    """Metadata-only review of the immutable source/area/expression intent."""

    planId: OpaqueId
    operation: Literal["raster.aggregate.v1"]
    sources: dict[str, CatalogRasterRequest]
    calculations: tuple[NamedCalculation, ...]
    area: dict[str, object]
    grid: AggregateGrid
    expiresAt: datetime
    resolution: Literal["native"] = "native"
    valueDomain: Literal["stored"] = "stored"
    inclusion: Literal["cell_center", "per_function"] = "cell_center"
    limits: dict[str, int | float]
    timing: AggregatePlanTiming | None = None


@dataclass(frozen=True)
class RasterAggregateLimits(ProcessingLimits):
    """Native work and expression memory budgets, independent of TIFF outputs."""

    max_decoded_bytes: int = 4 * 1024**3
    max_native_blocks: int = 65_536
    max_coordinates: int = 500_000
    max_memory_bytes: int = 512 * 1024**2
    result_reservation_bytes: int = 12 * 1024**2
    # Rectilinear grids use fractional masks and cached area weights, with no
    # pixel polygons. Other grids admit at most this many potential polygon cells.
    max_area_geometry_cells: int = 2_000_000
    max_area_transform_coordinates: int = 4_000_000
    area_edge_tolerance_metres: float = 0.1
    area_max_segment_metres: float = 10_000.0

    @classmethod
    def with_lifecycle(cls, limits: ProcessingLimits) -> "RasterAggregateLimits":
        """Keep operation admission aligned with the shared deployment lifecycle.

        Args:
            limits: Configured job scheduling, storage, and execution policy.

        Returns:
            Calculation-specific limits using the same shared job policy.
        """
        return cls(
            **{
                item.name: getattr(limits, item.name)
                for item in fields(ProcessingLimits)
            }
        )


@dataclass(frozen=True)
class AggregateArtifact(Artifact):
    """Server-generated CSV and bounded typed summary for an aggregate job."""

    rows: list[dict[str, object]]
    performance: dict[str, object] | None = field(default=None, kw_only=True)
    execution_timing: dict[str, object] | None = field(default=None, kw_only=True)
    media_type: str = field(default="text/csv", kw_only=True)
    result_name: str = field(default="result.csv", kw_only=True)
