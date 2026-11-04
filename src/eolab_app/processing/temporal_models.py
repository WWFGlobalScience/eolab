"""Describe a temporal period map, its native grid and completed raster files."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ModelWrapValidatorHandler,
    model_validator,
)

from eolab_app.catalog_selection import VectorSelection
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.models import Artifact
from eolab_app.processing.temporal_grid import TemporalReadGrid
from eolab_app.processing.polygon_areas import PolygonAreaReference
from eolab_app.sampling_box import Wgs84SamplingBox
from eolab_app.raster.models import Wgs84Bounds
from eolab_app.raster.source_models import TemporalIntervalSelection


class PrecipitationConversion(BaseModel):
    """Configure the source units and conversion used for precipitation totals.

    Attributes:
        inputUnit: Exact unit required on the admitted mean-rate variable.
        outputUnit: Unit written on the resulting total raster.
        factor: Positive multiplier applied after rate times interval seconds:
            total = sum(rate * seconds * factor).
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    inputUnit: Annotated[str, Field(strict=True, min_length=1)]
    outputUnit: Annotated[str, Field(strict=True, min_length=1)]
    factor: Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)]


class TemporalReduction(BaseModel):
    """Select an observation statistic or precipitation total at each cell.

    Statistics give valid observations equal weight. Standard deviation is the
    population statistic; percentiles use exact linear interpolation and require
    a percentile value. Sum retains the source units without integration.
    Precipitation total integrates mean rates over their recorded intervals,
    using the model's configured units and conversion factor.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    reducer: Literal[
        "sum",
        "mean",
        "min",
        "max",
        "median",
        "percentile",
        "stdev",
        "precipitation_total",
    ]
    percentile: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)] | None = None

    @model_validator(mode="wrap")
    @classmethod
    def require_percentile_choice(
        cls, value: Any, handler: ModelWrapValidatorHandler[Self]
    ) -> Self:
        """Require a percentile value exactly when the percentile reducer is chosen.

        Args:
            value: External or persisted input, or an already validated choice.
            handler: Pydantic's field validation and construction handler.

        Returns:
            The validated statistic choice.

        Raises:
            ValueError: If the chosen statistic and percentile value disagree.
        """
        choice = handler(value)
        if choice is not value and (choice.reducer == "percentile") != (
            choice.percentile is not None
        ):
            raise ValueError("Supply percentile only for the percentile reducer")
        return choice


class TemporalMapRequest(BaseModel):
    """Request a period statistic for one temporal variable and one explicit area."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    source: TemporalIntervalSelection
    reduction: TemporalReduction
    precipitation: PrecipitationConversion
    selectedBounds: Wgs84Bounds | None = None
    samplingBox: Wgs84SamplingBox | None = None
    catalogSelection: VectorSelection | None = None
    polygonArea: PolygonAreaReference | None = None
    wholeRaster: Literal[True] | None = None

    @model_validator(mode="wrap")
    @classmethod
    def require_area_and_period(
        cls, value: Any, handler: ModelWrapValidatorHandler[Self]
    ) -> Self:
        """Require one area and whole UTC hours for precipitation totals.

        Args:
            value: Input dictionary or an already validated request.
            handler: Pydantic's field validation and construction handler.

        Returns:
            The validated request.

        Raises:
            ValueError: If the request lacks exactly one area or a precipitation
                total uses a partial-hour boundary.
        """
        request = handler(value)
        if request is value:
            return request
        if (
            sum(
                area is not None
                for area in (
                    request.selectedBounds,
                    request.samplingBox,
                    request.catalogSelection,
                    request.polygonArea,
                    request.wholeRaster,
                )
            )
            != 1
        ):
            raise ValueError(
                "Choose one box, vector selection, polygon area, or whole raster"
            )
        if request.reduction.reducer == "precipitation_total":
            for boundary in (request.source.start_time, request.source.end_time):
                utc = boundary.astimezone(timezone.utc)
                if utc.minute or utc.second or utc.microsecond:
                    raise ValueError("Precipitation totals require whole UTC hours")
        return request


class QueuedTemporalMap(BaseModel):
    """Submitted interval and area retained until a worker can open the sources."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["temporal.reduce.v1"] = "temporal.reduce.v1"
    request: TemporalMapRequest
    polygonArea: AggregateArea | None = None


class TemporalMapSpec(BaseModel):
    """A path-free period-map plan with a compact observation summary.

    The authorized observations and their file locations stay in worker memory.
    Detailed observation labels and support intervals belong in provenance.json.
    unit describes the output values; original units remain in source metadata.
    timeSupport retains the admitted meaning of each observation.
    conversionFactor multiplies each rate after integration over interval seconds;
    ordinary statistics use 1.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["temporal.reduce.v1"] = "temporal.reduce.v1"
    source: TemporalIntervalSelection
    reduction: TemporalReduction
    area: AggregateArea
    grid: TemporalReadGrid
    unit: str
    timeSupport: Literal["instantaneous", "mean_rate", "accumulation"]
    conversionFactor: float
    observationCount: int
    firstObservation: datetime
    lastObservation: datetime


@dataclass(frozen=True)
class TemporalMapArtifact(Artifact):
    """Completed statistic raster, count raster and statistic's valid-cell count."""

    valid_pixels: int
    media_type: str = field(default="image/tiff", kw_only=True)
