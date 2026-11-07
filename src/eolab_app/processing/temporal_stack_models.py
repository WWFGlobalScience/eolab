"""Capture named Raster stack formulas for one temporal dataset and period."""

from datetime import datetime
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ModelWrapValidatorHandler,
    PrivateAttr,
    model_validator,
)

from eolab_app.catalog_selection import VectorSelection
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateValidationRequest,
    GroundAreaPlan,
    NamedCalculation,
    PixelPoint,
)
from eolab_app.polygon_areas import PolygonAreaReference
from eolab_app.processing.temporal_grid import TemporalReadGrid
from eolab_app.sampling_box import Wgs84SamplingBox
from eolab_app.raster.models import Wgs84Bounds
from eolab_app.raster.source_models import TemporalIntervalSelection


class TemporalStackMetrics(BaseModel):
    """Validate one to five formulas and the map point used by pixelValue(a).

    Formulas use the same grammar, labels and expression limits as ordinary
    Raster stack calculations. The alias is always a.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    _uses_area: bool = PrivateAttr(default=True)
    calculations: Annotated[
        tuple[NamedCalculation, ...], Field(min_length=1, max_length=5)
    ]
    pixelPoint: PixelPoint | None = None

    @model_validator(mode="wrap")
    @classmethod
    def validate_formulas_and_point(
        cls, value: Any, handler: ModelWrapValidatorHandler[Self]
    ) -> Self:
        """Apply the existing formula contract and require any referenced point.

        Args:
            value: Submitted or persisted metrics, or already validated metrics.
            handler: Pydantic's field validation and construction handler.

        Returns:
            The accepted formulas and optional exact map location.

        Raises:
            ValueError: If a formula, label or required map point is invalid.
        """
        metrics = handler(value)
        if metrics is value:
            return metrics
        language = AggregateValidationRequest(calculations=metrics.calculations)
        metrics._uses_area = language._uses_area
        if language._uses_pixel_point and metrics.pixelPoint is None:
            raise ValueError("Choose a map location for pixelValue(a)")
        return metrics


class TemporalStackRequest(BaseModel):
    """Retain validated formulas and one model-bound area for a temporal slice.

    Admission validates the source, metrics and area before binding this internal
    request. Point-only formulas ignore the area when preparing native reads.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    source: TemporalIntervalSelection
    metrics: TemporalStackMetrics
    selectedBounds: Wgs84Bounds | None = None
    samplingBox: Wgs84SamplingBox | None = None
    catalogSelection: VectorSelection | None = None
    polygonArea: PolygonAreaReference | None = None
    wholeRaster: Literal[True] | None = None


class QueuedTemporalStack(BaseModel):
    """Keep the submitted formulas and owned polygons until a worker can run."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["temporal.stack.v1"] = "temporal.stack.v1"
    request: TemporalStackRequest
    polygonArea: AggregateArea | None = None


class TemporalStackSpec(BaseModel):
    """Describe native observation reads and formulas without source file paths.

    sourceUnit describes the input measurements; arbitrary formula units are
    not inferred. groundArea records the existing hectare calculator's plan
    only when a formula measures area.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["temporal.stack.v1"] = "temporal.stack.v1"
    source: TemporalIntervalSelection
    metrics: TemporalStackMetrics
    area: AggregateArea
    grid: TemporalReadGrid
    groundArea: GroundAreaPlan | None = None
    sourceUnit: str
    timeSupport: Literal["instantaneous", "mean_rate", "accumulation"]
    observationCount: int
    firstObservation: datetime
    lastObservation: datetime
