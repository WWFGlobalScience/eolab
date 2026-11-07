"""Run spatial summaries of each observation through existing Processing jobs."""

from collections.abc import Callable
from datetime import datetime
from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict

from eolab_app.bounded_vector import summary_process
from eolab_app.sampling_box import sampling_box_bounds
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext
from eolab_app.polygon_areas import PolygonAreaReference
from eolab_app.processing.raster_operations import bind_area_arguments
from eolab_app.processing.temporal_series import temporal_series_process_target
from eolab_app.processing.temporal_series_models import (
    AreaStatistic,
    QueuedTemporalSeries,
    TemporalSeriesRequest,
    TemporalSeriesSpec,
)
from eolab_app.raster.source_models import TemporalIntervalSelection
from eolab_app.raster.temporal import ResolvedTemporalInterval
from eolab_app.processing.temporal_stack_models import (
    QueuedTemporalStack,
    TemporalStackRequest,
    TemporalStackSpec,
)


class TemporalSeriesNumericalPolicy(BaseModel):
    """Record the spatial statistic, pixel inclusion and original time support.

    Each observation is summarized separately, without temporal integration or
    unit conversion. Missing observations are absent from the CSV; observations
    with no valid selected cells retain their scalar engine result state.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal["temporal.series.v1"] = "temporal.series.v1"
    grid: Literal["native"] = "native"
    resampling: Literal["none"] = "none"
    numericInclusion: Literal["cell_center"] = "cell_center"
    weighting: Literal["equal_valid_pixel"] = "equal_valid_pixel"
    nodata: Literal["exclude_source_nodata_and_nonfinite"] = (
        "exclude_source_nodata_and_nonfinite"
    )
    standardDeviation: Literal["population"] = "population"
    statistic: AreaStatistic
    timeSupport: Literal["instantaneous", "mean_rate", "accumulation"]
    unit: str
    observationCount: int
    firstObservation: datetime
    lastObservation: datetime


def bind_temporal_series(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> TemporalSeriesRequest:
    """Capture validated model inputs for a per-observation area summary.

    Args:
        inputs: Source period, area and statistic checked by the model contract.
        parameters: Empty settings required by this operation.
        request_id: Retry identifier retained by the model-run service.
        label: Run name retained by the model-run service.

    Returns:
        Path-free calculation inputs with the selected area bound for Processing.
    """
    return TemporalSeriesRequest(
        source=inputs["source"],
        statistic=inputs["statistic"],
        **bind_area_arguments(inputs["area"]),
    )


def get_series_source(
    value: (
        TemporalSeriesRequest
        | QueuedTemporalSeries
        | TemporalSeriesSpec
        | TemporalStackRequest
        | QueuedTemporalStack
        | TemporalStackSpec
    ),
) -> TemporalIntervalSelection:
    """Return the Catalog variable and period captured by a request or saved plan.

    Args:
        value: Validated operation request, queued input or prepared plan.

    Returns:
        The path-free temporal source selection.
    """
    return (
        value.request.source
        if isinstance(value, (QueuedTemporalSeries, QueuedTemporalStack))
        else value.source
    )


def get_series_polygon(
    request: TemporalSeriesRequest | TemporalStackRequest,
) -> PolygonAreaReference | None:
    """Return the owned polygon input that admission must retain, if selected.

    Args:
        request: Validated area-summary inputs.

    Returns:
        Owned polygon reference, or None for another area kind.
    """
    return request.polygonArea


def build_series_submission(
    request: TemporalSeriesRequest, polygons: AggregateArea | None
) -> PreparedJobPlan:
    """Queue the captured period and area without reading observations.

    Args:
        request: Validated variable, period, statistic and area.
        polygons: Owned polygon input retained by the admission service.

    Returns:
        Durable inputs for the existing Processing worker.
    """
    queued = QueuedTemporalSeries(request=request, polygonArea=polygons)
    return PreparedJobPlan(
        specification=queued.model_dump(mode="json", by_alias=True),
        summary={
            "source": request.source.model_dump(mode="json", by_alias=True),
            "statistic": request.statistic,
            "grid": None,
        },
        reserved_bytes=0,
        operation=queued.operation,
    )


async def prepare_temporal_series(
    context: OperationContext,
    queued: QueuedTemporalSeries,
    source: ResolvedTemporalInterval,
) -> PreparedJobPlan:
    """Prepare the common native grid and record available observation coverage.

    Args:
        context: Existing worker execution and vector-selection capabilities.
        queued: Captured request with any retained polygon input.
        source: Authorized observations and admitted variable metadata.

    Returns:
        Path-free plan with output units and actual observation coverage.

    Raises:
        ProcessingError: If no observations overlap or the selected area fails
            to resolve or cannot be read on the native grid.
    """
    if not source.observations:
        raise ProcessingError(
            "no_observations", "No observations are available in the selected period."
        )
    request = queued.request
    area = await prepare_series_area(context, request, queued.polygonArea)
    status, grid = await context.run_native(
        temporal_series_process_target,
        ("plan", (source.observations[0], area, context.aggregate_limits)),
        None,
        context.native,
    )
    if status != "ok":
        raise ProcessingError(*grid)
    spec = TemporalSeriesSpec(
        source=request.source,
        statistic=request.statistic,
        area=area,
        grid=grid,
        unit="cells" if request.statistic == "count" else source.unit,
        timeSupport=source.time_support,
        observationCount=len(source.observations),
        firstObservation=source.observations[0].time,
        lastObservation=source.observations[-1].time,
    )
    return PreparedJobPlan(
        specification=spec.model_dump(mode="json", by_alias=True),
        summary={
            "source": spec.source.model_dump(mode="json", by_alias=True),
            "statistic": spec.statistic,
            "grid": spec.grid.model_dump(mode="json"),
            "area": spec.area.model_dump(mode="json"),
        },
        reserved_bytes=0,
        operation=spec.operation,
    )


async def prepare_series_area(
    context: OperationContext,
    request: TemporalSeriesRequest | TemporalStackRequest,
    polygons: AggregateArea | None,
) -> AggregateArea:
    """Resolve the submitted area once for all observations in a temporal run.

    Args:
        context: Existing worker and vector-selection capabilities.
        request: Model-bound area choice.
        polygons: Owned polygons already retained during admission, if selected.

    Returns:
        The selected area with its original vector reader when needed.

    Raises:
        ProcessingError: If the vector selection cannot be read.
    """
    if polygons is not None:
        area = polygons
    elif request.wholeRaster:
        area = AggregateArea(kind="wholeRaster")
    elif request.samplingBox is not None:
        area = AggregateArea(
            kind="samplingBox",
            bounds=sampling_box_bounds(request.samplingBox),
            samplingBox=request.samplingBox,
        )
    elif request.selectedBounds is not None:
        area = AggregateArea(
            kind="bounds", bounds=request.selectedBounds.canonical_tuple()
        )
    else:
        if context.areas is None:
            raise ProcessingError(
                "selection_unavailable", "Vector selection reader is unavailable.", 409
            )
        resolved = await context.areas.resolve_for_sampling(request.catalogSelection)
        success, summary = await context.run_native(
            summary_process, (resolved, None), None, context.native
        )
        if not success:
            raise ProcessingError("selection_unavailable", summary, 409)
        area = AggregateArea(
            kind="catalogSelection",
            bounds=summary["bbox"],
            catalogSelection=request.catalogSelection,
            resolved=resolved,
        )
    return area


async def prepare_series_execution(
    context: OperationContext,
    spec: TemporalSeriesSpec | TemporalStackSpec,
    source: ResolvedTemporalInterval,
) -> tuple[ResolvedTemporalInterval, TemporalSeriesSpec | TemporalStackSpec]:
    """Supply authorized observations and the run's original vector selection.

    Args:
        context: Worker vector-source and retained-upload access.
        spec: Stored plan whose source files stay unchanged during calculation.
        source: Observations authorized for this execution attempt.

    Returns:
        Native observation metadata and the plan with its ephemeral vector reader.

    Raises:
        ProcessingError: If the selected vector source cannot be read.
    """
    if spec.area.kind == "catalogSelection":
        if context.areas is None:
            raise ProcessingError(
                "selection_unavailable", "Vector selection reader is unavailable.", 409
            )
        resolved = await context.areas.resolve_for_sampling(spec.area.catalogSelection)
        spec = spec.model_copy(
            update={"area": spec.area.model_copy(update={"resolved": resolved})}
        )
    return source, spec


def select_series_execution(
    spec: TemporalSeriesSpec,
    context: OperationContext,
) -> tuple[Callable[..., None], str, RasterAggregateLimits]:
    """Select the native worker target for this area time series.

    Args:
        spec: Validated prepared series plan.
        context: Processing's unlimited-work execution and lifecycle settings.

    Returns:
        Native target, series action and existing calculation settings.
    """
    return temporal_series_process_target, "series", context.aggregate_limits


def describe_series_policy(spec: TemporalSeriesSpec) -> TemporalSeriesNumericalPolicy:
    """Record the spatial statistic's rules and actual observation coverage.

    Args:
        spec: Prepared plan with output units and source time support.

    Returns:
        Scientific rules retained in the existing Run YAML.
    """
    return TemporalSeriesNumericalPolicy(
        statistic=spec.statistic,
        timeSupport=spec.timeSupport,
        unit=spec.unit,
        observationCount=spec.observationCount,
        firstObservation=spec.firstObservation,
        lastObservation=spec.lastObservation,
    )


def describe_series_result(
    summary: dict[str, Any],
    artifact: dict[str, Any],
    numerical_policy: dict[str, Any] | None,
) -> dict[str, Any]:
    """Describe a completed CSV without copying its observation rows into the API.

    Args:
        summary: Prepared grid and choices retained by the model-run service.
        artifact: Published CSV file metadata.
        numerical_policy: Recorded settings retained for the result's lifetime.

    Returns:
        Statistic and observation coverage for the shared result card.
    """
    policy = cast(dict[str, Any], numerical_policy)
    return {
        "calculations": [
            {"label": policy["statistic"], "expression": f"{policy['statistic']}(a)"}
        ],
        "temporalCoverage": {
            name: policy[name]
            for name in (
                "unit",
                "observationCount",
                "firstObservation",
                "lastObservation",
            )
        },
    }


def describe_series_outcome(artifact: dict[str, Any]) -> dict[str, Any]:
    """Leave CSV file identity to the shared artifact inventory in Run YAML.

    Args:
        artifact: Published CSV metadata already recorded by the model-run service.

    Returns:
        An empty scalar summary; time-series values remain in the downloadable CSV.
    """
    return {"statistics": None}
