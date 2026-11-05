"""Bind downstream recipes to the existing Processing admission and worker lifecycle."""

from typing import Any, Callable

from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.downstream_models import (
    DownstreamRequest,
    QueuedDownstream,
    DownstreamPlan,
    ClosedEdgeDownstreamNumericalPolicy,
    RasterStartingMask,
    VectorStartingMask,
)
from eolab_app.processing.downstream_calculation import (
    DownstreamSources,
    downstream_process_target,
)
from eolab_app.catalog_selection import CatalogSelection, SelectionUnavailableError
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext
from eolab_app.raster.models import AuthorizedRaster, CatalogRasterRequest
from eolab_app.raster.source_models import RasterSourceReference

# Stage wording belongs to this operation, not the generic Models interface.
DOWNSTREAM_PROGRESS_DESCRIPTIONS: tuple[tuple[str, str], ...] = (
    ("preparing", "Preparing inputs"),
    ("preparing_starting_mask", "Preparing starting cells"),
    ("routing_downstream", "Tracing downstream flow"),
    ("buffering_downstream_coverage", "Buffering downstream coverage"),
    ("summarizing_values", "Summarizing raster values"),
    ("writing_results", "Writing results"),
)


def bind_downstream(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> DownstreamRequest:
    """Bind a recipe's selected inputs and parameters to a downstream request.

    Args:
        inputs: Mask, values raster, configured hydrology sources and pit-filling settings.
        parameters: Buffer, optional cutoff and summary formula.
        request_id: Stable model submission identifier.
        label: User's result label.

    Returns:
        Validated downstream inputs with no paths or copied geometry.

    Raises:
        ValidationError: If any input or parameter violates the operation contract.
    """
    return DownstreamRequest(requestId=request_id, label=label, **inputs, **parameters)


def downstream_inputs(
    value: DownstreamRequest | QueuedDownstream | DownstreamPlan,
) -> DownstreamRequest:
    """Read the captured inputs from a request or stored downstream specification.

    Args:
        value: Validated request, queued job or prepared plan.

    Returns:
        The same captured downstream inputs at every lifecycle stage.
    """
    if isinstance(value, QueuedDownstream):
        return value.request
    return value.inputs if isinstance(value, DownstreamPlan) else value


def get_values_source(
    value: DownstreamRequest | QueuedDownstream | DownstreamPlan,
) -> RasterSourceReference:
    """Return the native values raster that supplies the downstream summary.

    Args:
        value: Request or stored downstream specification.

    Returns:
        Catalog raster identity or owned result-file reference.
    """
    return downstream_inputs(value).values


def get_additional_sources(
    value: DownstreamRequest | QueuedDownstream | DownstreamPlan,
) -> dict[str, CatalogRasterRequest]:
    """Declare DEM and optional raster-mask inputs for authorization and execution.

    Args:
        value: Request or stored downstream specification.

    Returns:
        Additional catalog rasters keyed by stable operation argument names.
    """
    request = downstream_inputs(value)
    result = {"dem": request.hydrology.dem}
    if isinstance(request.starting_mask, RasterStartingMask):
        result["starting_mask"] = request.starting_mask.source
    return result


def build_downstream_submission(
    request: DownstreamRequest, polygons: AggregateArea | None
) -> PreparedJobPlan:
    """Build a downstream submission with inputs for an independent model run.

    Args:
        request: Captured operation inputs.
        polygons: Always absent for the downstream input contract.

    Returns:
        Path-free queued specification awaiting worker source resolution.
    """
    queued = QueuedDownstream(request=request)
    return PreparedJobPlan(
        operation=queued.operation,
        specification=queued.model_dump(mode="json", by_alias=True),
        summary={},
        reserved_bytes=0,
    )


async def resolve_downstream_sources(
    context: OperationContext,
    request: DownstreamRequest,
    values: AuthorizedRaster,
    watershed_selection: CatalogSelection | None = None,
) -> DownstreamSources:
    """Resolve configured source files and selected catalog vectors for a calculation.

    Args:
        context: Worker capabilities with captured additional raster identities.
        request: Captured starting mask and model-configured hydrology sources.
        values: Already authorized primary values raster.
        watershed_selection: Source captured during preparation; None captures the
            currently configured layer without comparing registration history.

    Returns:
        Ephemeral native paths and exact selection readers.

    Raises:
        ProcessingError: If the configured watershed is missing or unreadable.
        SelectionUnavailableError: If the user-selected starting vector is unavailable.
    """
    if context.areas is None:
        raise ProcessingError(
            "selection_unavailable", "Catalog vector reading is unavailable.", 409
        )
    try:
        network = (
            await context.areas.resolve_source(request.hydrology.watersheds)
            if watershed_selection is None
            else await context.areas.resolve_for_sampling(watershed_selection)
        )
    except SelectionUnavailableError as error:
        raise ProcessingError(
            "watershed_unavailable",
            "The model's configured watershed layer is missing or unreadable. Check the configured source and try again.",
            409,
        ) from error
    starting = (
        await context.areas.resolve_for_sampling(request.starting_mask.selection)
        if isinstance(request.starting_mask, VectorStartingMask)
        else None
    )
    return DownstreamSources(
        {
            "values": values.source_path,
            **{name: source.source_path for name, source in context.rasters.items()},
        },
        network,
        starting,
    )


async def prepare_downstream(
    context: OperationContext, queued: QueuedDownstream, authorized: AuthorizedRaster
) -> PreparedJobPlan:
    """Prepare selected downstream sources in the supervised native process.

    Args:
        context: Existing worker source, native and resource capabilities.
        queued: Captured downstream request.
        authorized: Primary values raster authorized by the worker.

    Returns:
        Values grid metadata and the watershed identity captured for this run.

    Raises:
        ProcessingError: If preparation or source access fails.
        ProcessDeadlineError: If the supervised process exits without a result.
    """
    sources = await resolve_downstream_sources(context, queued.request, authorized)
    status, result = await context.run_native(
        downstream_process_target,
        ("plan", (sources, queued.request)),
        None,
        context.native,
    )
    if status != "ok":
        raise ProcessingError(*result)
    return PreparedJobPlan(
        operation=result.operation,
        specification=result.model_dump(mode="json", by_alias=True),
        summary={},
        reserved_bytes=result.reservedBytes,
    )


async def resolve_downstream_execution_inputs(
    context: OperationContext, spec: DownstreamPlan, authorized: AuthorizedRaster
) -> tuple[DownstreamSources, DownstreamPlan]:
    """Resolve an accepted downstream plan into the original sources the worker will read.

    A queued plan contains catalog/owned-output identities, never live file
    handles. This adapter resolves its vector inputs and binds its native
    arguments at execution. The worker supplies the values raster after
    authorizing its catalog source or accepted input grant.

    Args:
        context: Worker capabilities and additional authorized rasters.
        spec: Stored path-free plan.
        authorized: Primary values raster with its accepted identity.

    Returns:
        Ephemeral native sources and the unchanged numerical plan.

    Raises:
        ProcessingError: If source access fails.
    """
    return (
        await resolve_downstream_sources(
            context, spec.inputs, authorized, spec.watershedSelection
        ),
        spec,
    )


def select_downstream_execution(
    spec: DownstreamPlan, context: OperationContext
) -> tuple[Callable[..., None], str, RasterClipLimits]:
    """Select the original downstream model target for supervised execution.

    Args:
        spec: Prepared operation plan.
        context: Worker deployment limits.

    Returns:
        The supervised native target, action and worker limits.
    """
    return downstream_process_target, "calculate", context.limits


def describe_downstream_policy(
    spec: DownstreamPlan,
) -> ClosedEdgeDownstreamNumericalPolicy:
    """Describe the actual routing, distance and value policies of a prepared run.

    Args:
        spec: Prepared plan with effective model parameters.

    Returns:
        Versioned numerical rules for Run YAML and provenance.
    """
    return ClosedEdgeDownstreamNumericalPolicy(
        version="hydrology.downstream_beneficiaries.v3",
        pitFillSearchLimit=spec.inputs.settings.pit_fill_search_limit,
        bufferMetres=spec.inputs.buffer_m,
        cutoffMetres=spec.inputs.cutoff_m,
        wgs84PixelSize=spec.inputs.wgs84_pixel_size,
        distancePixelSizeMetres=spec.inputs.travel_time_pixel_size_m,
    )


def describe_downstream_result(
    summary: dict[str, Any],
    artifact: dict[str, Any],
    numerical_policy: dict[str, Any] | None,
) -> dict[str, Any]:
    """Expose completed downstream summary rows through the shared statistics contract.

    Args:
        summary: Captured operation metadata.
        artifact: Published primary statistics file and numerical rows.
        numerical_policy: Recorded calculation settings, or None after metadata expiry.

    Returns:
        Scalar rows; every run performs its own calculation.
    """
    return {"rows": artifact["rows"], "cacheHit": False}


def describe_downstream_outcome(artifact: dict[str, Any]) -> dict[str, Any]:
    """Retain the downstream summary in Run YAML after its files expire.

    Args:
        artifact: Completed statistics artifact.

    Returns:
        Scientific outcome fields; the common manifest records each raster.
    """
    return {"statistics": artifact["rows"]}
