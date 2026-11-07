"""Run period-map calculations through existing Processing jobs and raster outputs."""

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
from eolab_app.processing.temporal_models import (
    QueuedTemporalMap,
    TemporalMapRequest,
    TemporalMapSpec,
    TemporalReduction,
)
from eolab_app.processing.temporal_reduce import temporal_process_target
from eolab_app.raster.source_models import TemporalIntervalSelection
from eolab_app.raster.temporal import ResolvedTemporalInterval


class TemporalMapNumericalPolicy(BaseModel):
    """Record the exact observation statistic, coverage and native-grid rules used."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal["temporal.reduce.v1"] = "temporal.reduce.v1"
    grid: Literal["native"] = "native"
    resampling: Literal["none"] = "none"
    numericInclusion: Literal["cell_center"] = "cell_center"
    timeSupport: Literal["instantaneous", "mean_rate", "accumulation"]
    weighting: Literal["equal_observation", "interval_duration"] = "equal_observation"
    nodata: Literal["exclude_source_nodata_and_nonfinite"] = (
        "exclude_source_nodata_and_nonfinite"
    )
    emptyPixel: Literal["nodata_with_zero_count"] = "nodata_with_zero_count"
    standardDeviation: Literal["population"] = "population"
    percentileMethod: Literal["exact_linear"] = "exact_linear"
    valueDomain: Literal["decoded_native_values"] = "decoded_native_values"
    reduction: TemporalReduction
    unit: str
    observationCount: int
    firstObservation: datetime
    lastObservation: datetime


def bind_temporal_map(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> TemporalMapRequest:
    """Capture a recipe's dataset period, statistic and existing analysis area.

    Args:
        inputs: Source, reduction and area checked against the recipe's input types,
            plus the model's validated precipitation conversion.
        parameters: Empty mapping required by this operation's recipe.
        request_id: Submission retry identifier retained by the model-run service.
        label: Run name retained by the model-run service.

    Returns:
        Path-free inputs for one period-map calculation.

    Raises:
        ValueError: If an input violates the operation request contract.
    """
    return TemporalMapRequest(
        source=inputs["source"],
        reduction=inputs["reduction"],
        precipitation=inputs["precipitation"],
        **bind_area_arguments(inputs["area"]),
    )


def get_temporal_source(
    value: TemporalMapRequest | QueuedTemporalMap | TemporalMapSpec,
) -> TemporalIntervalSelection:
    """Return the dataset, variable and period captured by a request or saved plan.

    Args:
        value: Validated operation request, queued input or prepared plan.

    Returns:
        The path-free Catalog interval selection.
    """
    return (
        value.request.source if isinstance(value, QueuedTemporalMap) else value.source
    )


def get_temporal_polygon(request: TemporalMapRequest) -> PolygonAreaReference | None:
    """Return the owned polygon input that admission must retain, when selected.

    Args:
        request: Validated period-map inputs.

    Returns:
        Polygon upload reference, or None for another area kind.
    """
    return request.polygonArea


def build_temporal_submission(
    request: TemporalMapRequest, polygons: AggregateArea | None
) -> PreparedJobPlan:
    """Queue a captured period-map request without reading raster pixels.

    Args:
        request: Validated source, area and reducer choices.
        polygons: Owned polygon input copied by the existing admission service.

    Returns:
        A durable, path-free request for the existing worker.
    """
    queued = QueuedTemporalMap(request=request, polygonArea=polygons)
    return PreparedJobPlan(
        specification=queued.model_dump(mode="json", by_alias=True),
        summary={
            "source": request.source.model_dump(mode="json", by_alias=True),
            "reduction": request.reduction.model_dump(mode="json"),
            "grid": None,
        },
        reserved_bytes=0,
        operation=queued.operation,
    )


async def prepare_temporal_map(
    context: OperationContext,
    queued: QueuedTemporalMap,
    source: ResolvedTemporalInterval,
) -> PreparedJobPlan:
    """Plan a period map using the selected area and admitted observation metadata.

    Ordinary statistics retain the source units. Precipitation totals use the
    model's configured source units, output units and conversion factor.

    Args:
        context: Existing worker execution and vector-selection capabilities.
        queued: Captured period-map request with any retained polygon input.
        source: Authorized observations and admitted variable metadata.

    Returns:
        Path-free execution plan with actual observation coverage and output units.

    Raises:
        ProcessingError: If the statistic does not support this variable's units
            or time support, no observations overlap, or area preparation fails.
    """
    output_unit = source.unit
    conversion_factor = 1.0
    precipitation = queued.request.precipitation
    if queued.request.reduction.reducer == "precipitation_total":
        if source.time_support != "mean_rate" or source.unit != precipitation.inputUnit:
            raise ProcessingError(
                "unsupported_precipitation_source",
                f"Precipitation total requires mean rates in {precipitation.inputUnit}. "
                "Choose a precipitation-rate variable with those units.",
            )
        output_unit = precipitation.outputUnit
        conversion_factor = precipitation.factor
    if not source.observations:
        raise ProcessingError(
            "no_observations", "No observations are available in the selected period."
        )
    request = queued.request
    if queued.polygonArea is not None:
        area = queued.polygonArea
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
    status, grid = await context.run_native(
        temporal_process_target,
        ("plan", (source.observations[0], area, context.aggregate_limits)),
        None,
        context.native,
    )
    if status != "ok":
        raise ProcessingError(*grid)
    spec = TemporalMapSpec(
        source=request.source,
        reduction=request.reduction,
        area=area,
        grid=grid,
        unit=output_unit,
        timeSupport=source.time_support,
        conversionFactor=conversion_factor,
        observationCount=len(source.observations),
        firstObservation=source.observations[0].time,
        lastObservation=source.observations[-1].time,
    )
    return PreparedJobPlan(
        specification=spec.model_dump(mode="json", by_alias=True),
        summary={
            "source": spec.source.model_dump(mode="json", by_alias=True),
            "reduction": spec.reduction.model_dump(mode="json"),
            "grid": spec.grid.model_dump(mode="json"),
            "area": spec.area.model_dump(mode="json"),
        },
        reserved_bytes=0,
        operation=spec.operation,
    )


async def prepare_temporal_execution(
    context: OperationContext,
    spec: TemporalMapSpec,
    source: ResolvedTemporalInterval,
) -> tuple[ResolvedTemporalInterval, TemporalMapSpec]:
    """Supply authorized observations and the run's original vector selection.

    Args:
        context: Worker vector-source and retained-upload access.
        spec: Stored plan whose source files remain unchanged during calculation.
        source: Interval authorized for this execution attempt.

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


def select_temporal_execution(
    spec: TemporalMapSpec, context: OperationContext
) -> tuple[Callable[..., None], str, RasterAggregateLimits]:
    """Choose the existing native worker's period-map calculation and lifecycle.

    Args:
        spec: Validated prepared period-map plan.
        context: Processing's unlimited-work execution and lifecycle settings.

    Returns:
        Native target, reduce action and existing calculation settings.
    """
    return temporal_process_target, "reduce", context.aggregate_limits


def describe_temporal_policy(spec: TemporalMapSpec) -> TemporalMapNumericalPolicy:
    """Record the statistic's numerical rules and actual available observations.

    Args:
        spec: Prepared plan with units and actual period coverage.

    Returns:
        Scientific rules retained in the existing Run YAML.
    """
    total = spec.reduction.reducer == "precipitation_total"
    return TemporalMapNumericalPolicy(
        timeSupport=spec.timeSupport,
        weighting="interval_duration" if total else "equal_observation",
        reduction=spec.reduction,
        unit=spec.unit,
        observationCount=spec.observationCount,
        firstObservation=spec.firstObservation,
        lastObservation=spec.lastObservation,
    )


def describe_temporal_result(
    summary: dict[str, Any],
    artifact: dict[str, Any],
    numerical_policy: dict[str, Any] | None,
) -> dict[str, Any]:
    """Describe a completed period map and its recorded observation coverage.

    Args:
        summary: Prepared native grid retained by the model-run service.
        artifact: Published operation file metadata.
        numerical_policy: Recorded calculation settings. Period-map metadata
            remains available for the same lifetime as its completed result.

    Returns:
        Raster result fields used by the existing result cards and map actions.
    """
    policy = cast(dict[str, Any], numerical_policy)
    return {
        "grid": summary["grid"],
        "validPixels": artifact["valid_pixels"],
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


def describe_temporal_outcome(artifact: dict[str, Any]) -> dict[str, Any]:
    """Retain the completed raster's file identity and valid-cell count in Run YAML.

    Args:
        artifact: Published period-map artifact metadata.

    Returns:
        The shared raster outcome fields.
    """
    return {
        "statistics": None,
        "raster": {
            "filename": artifact["filename"],
            "bytes": artifact["size"],
            "sha256": artifact["sha256"],
            "validPixels": artifact["valid_pixels"],
        },
    }
