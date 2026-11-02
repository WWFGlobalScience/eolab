"""Bind Raster stack formulas to the existing temporal observation calculation."""

from collections.abc import Callable
from datetime import datetime
from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict

from eolab_app.processing.aggregate_models import (
    AggregateArea,
    GroundAreaPlan,
    RasterAggregateLimits,
)
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext
from eolab_app.processing.raster_operations import bind_area_arguments
from eolab_app.processing.temporal_series_operation import prepare_series_area
from eolab_app.processing.temporal_stack import temporal_stack_process_target
from eolab_app.processing.temporal_stack_models import (
    QueuedTemporalStack,
    TemporalStackMetrics,
    TemporalStackRequest,
    TemporalStackSpec,
)
from eolab_app.raster.temporal import ResolvedTemporalInterval


class TemporalStackNumericalPolicy(BaseModel):
    """Record formulas, native sampling rules and actual temporal coverage."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal["temporal.stack.v1"] = "temporal.stack.v1"
    grid: Literal["native"] = "native"
    resampling: Literal["none"] = "none"
    numericInclusion: Literal["cell_center"] = "cell_center"
    pixelValue: Literal["cell_containing_selected_point"] = (
        "cell_containing_selected_point"
    )
    standardDeviation: Literal["population"] = "population"
    temporalAggregation: Literal["none"] = "none"
    metrics: TemporalStackMetrics
    groundArea: GroundAreaPlan | None = None
    sourceUnit: str
    timeSupport: Literal["instantaneous", "mean_rate", "accumulation"]
    observationCount: int
    firstObservation: datetime
    lastObservation: datetime


def bind_temporal_stack(
    inputs: dict[str, Any],
    parameters: dict[str, Any],
    request_id: str,
    label: str,
) -> TemporalStackRequest:
    """Capture model-validated temporal formulas, retaining an area only if used.

    Args:
        inputs: Catalog interval, selected area and validated metrics.
        parameters: Empty settings required by this operation.
        request_id: Retry identity retained by the model-run service.
        label: User's run label retained by the model-run service.

    Returns:
        Path-free execution inputs. Point-only calculations do not authorize,
        copy or prepare an unrelated vector area.
    """
    metrics = TemporalStackMetrics.model_validate(inputs["metrics"])
    area = (
        bind_area_arguments(inputs["area"])
        if metrics._uses_area
        else {"wholeRaster": True}
    )
    return TemporalStackRequest(source=inputs["source"], metrics=metrics, **area)


def build_stack_submission(
    request: TemporalStackRequest,
    polygons: AggregateArea | None,
) -> PreparedJobPlan:
    """Queue one temporal selection and its formulas without reading observations.

    Args:
        request: Validated source, formulas, point and effective area.
        polygons: Selected upload retained by existing admission, if any.

    Returns:
        Durable inputs for the existing Processing worker.
    """
    queued = QueuedTemporalStack(request=request, polygonArea=polygons)
    return PreparedJobPlan(
        specification=queued.model_dump(mode="json", by_alias=True),
        summary={
            "source": request.source.model_dump(mode="json", by_alias=True),
            "metrics": request.metrics.model_dump(mode="json"),
            "grid": None,
        },
        reserved_bytes=0,
        operation=queued.operation,
    )


async def prepare_temporal_stack(
    context: OperationContext,
    queued: QueuedTemporalStack,
    source: ResolvedTemporalInterval,
) -> PreparedJobPlan:
    """Prepare one point/area grid for every observation and formula in the run.

    Args:
        context: Existing native execution and vector-source providers.
        queued: Captured formulas with any retained polygon input.
        source: Authorized observations and their admitted measurement metadata.

    Returns:
        Path-free native grid, requested formulas and actual observation coverage.

    Raises:
        ProcessingError: If no observations overlap or point/area planning fails.
    """
    if not source.observations:
        raise ProcessingError(
            "no_observations", "No observations are available in the selected period."
        )
    request = queued.request
    area = await prepare_series_area(context, request, queued.polygonArea)
    status, planned = await context.run_native(
        temporal_stack_process_target,
        (
            "plan",
            (
                source.observations[0],
                area,
                context.aggregate_limits,
                request.metrics.calculations,
                request.metrics.pixelPoint,
            ),
        ),
        None,
        context.native,
    )
    if status != "ok":
        raise ProcessingError(*planned)
    grid, ground_area = planned
    spec = TemporalStackSpec(
        source=request.source,
        metrics=request.metrics,
        area=area,
        grid=grid,
        groundArea=ground_area,
        sourceUnit=source.unit,
        timeSupport=source.time_support,
        observationCount=len(source.observations),
        firstObservation=source.observations[0].time,
        lastObservation=source.observations[-1].time,
    )
    return PreparedJobPlan(
        specification=spec.model_dump(mode="json", by_alias=True),
        summary={
            "source": spec.source.model_dump(mode="json", by_alias=True),
            "metrics": spec.metrics.model_dump(mode="json"),
            "grid": spec.grid.model_dump(mode="json"),
            "area": spec.area.model_dump(mode="json", by_alias=True),
        },
        reserved_bytes=0,
        operation=spec.operation,
    )


def select_stack_execution(
    spec: TemporalStackSpec,
    context: OperationContext,
) -> tuple[Callable[..., None], str, RasterAggregateLimits]:
    """Select the existing native supervisor settings for temporal formulas.

    Args:
        spec: Prepared temporal formula plan.
        context: Processing's unlimited-work calculation settings.

    Returns:
        Native target, stack action and existing numerical settings.
    """
    return temporal_stack_process_target, "stack", context.aggregate_limits


def describe_stack_policy(spec: TemporalStackSpec) -> TemporalStackNumericalPolicy:
    """Record the captured formulas, measurement rules and observation coverage.

    Args:
        spec: Prepared source, point, area and formula plan.

    Returns:
        Scientific settings retained in the run document.
    """
    return TemporalStackNumericalPolicy(
        metrics=spec.metrics,
        groundArea=spec.groundArea,
        sourceUnit=spec.sourceUnit,
        timeSupport=spec.timeSupport,
        observationCount=spec.observationCount,
        firstObservation=spec.firstObservation,
        lastObservation=spec.lastObservation,
    )


def describe_stack_result(
    summary: dict[str, Any],
    artifact: dict[str, Any],
    numerical_policy: dict[str, Any] | None,
) -> dict[str, Any]:
    """Describe the CSV formulas and coverage without copying rows into job status.

    Args:
        summary: Prepared choices retained by the model-run service.
        artifact: Published file identity.
        numerical_policy: The scientific settings captured for this result.

    Returns:
        Shared time-series result metadata. Arbitrary formulas have no inferred
        common output unit; each CSV row retains the scalar engine's unit.
    """
    policy = cast(dict[str, Any], numerical_policy)
    return {
        "calculations": policy["metrics"]["calculations"],
        "temporalCoverage": {
            "unit": "",
            **{
                name: policy[name]
                for name in (
                    "observationCount",
                    "firstObservation",
                    "lastObservation",
                )
            },
        },
    }
