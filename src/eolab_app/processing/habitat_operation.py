"""Run Habitat condition through existing Processing source and worker contracts."""

from typing import Any, Callable, cast

from eolab_app.bounded_vector import summary_process
from eolab_app.catalog_selection import VectorSelection
from eolab_app.sampling_box import sampling_box_bounds
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.habitat_calculation import (
    HabitatSources,
    habitat_process_target,
)
from eolab_app.processing.habitat_models import (
    OPERATION,
    HabitatCalculationInputs,
    HabitatEarthEngineStack,
    HabitatRequest,
    HabitatSettings,
    PolygonReferenceSites,
    QueuedHabitat,
    VectorReferenceSites,
)
from eolab_app.processing.habitat_earth_engine import HabitatEarthEngineRuntime
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext
from eolab_app.processing.polygon_areas import PolygonAreaReference
from eolab_app.processing.raster_operations import bind_area_arguments
from eolab_app.raster.source_models import RasterSourceReference


def bind_habitat(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> HabitatRequest:
    """Bind the recipe's explicit layer choices and settings to a Habitat request.

    Args:
        inputs: Validated layers, area, preparation choices and fixed settings.
        parameters: Empty mapping; scientific settings come from the recipe.
        request_id: Submission identifier retained by the model-run service.
        label: Run name retained by the model-run service.

    Returns:
        Path-free operation inputs using the existing assessment-area fields.

    Raises:
        ValidationError: If the selected layers or settings are invalid.
    """
    return HabitatRequest(
        stack=inputs["stack"],
        references=inputs["references"],
        habitat_mask=inputs["habitat_mask"],
        preparation=inputs["preparation"],
        settings=inputs["settings"],
        **bind_area_arguments(inputs["area"]),
    )


def get_habitat_request(
    value: HabitatRequest | QueuedHabitat | HabitatCalculationInputs,
) -> HabitatRequest:
    """Return the Habitat request from submitted, queued or prepared inputs.

    Args:
        value: Validated Habitat inputs at any stage of the job.

    Returns:
        The request containing the selected layer identities and fixed settings.
    """
    if isinstance(value, QueuedHabitat):
        return value.request
    return value.inputs if isinstance(value, HabitatCalculationInputs) else value


def get_habitat_raster_sources(
    value: HabitatRequest | QueuedHabitat | HabitatCalculationInputs,
) -> dict[str, RasterSourceReference]:
    """Declare all selected rasters for ordinary authorization and retention.

    Keys identify captured stack positions and selected mask roles. Automatic
    inputs have no pre-existing raster source except any user-selected masks.

    Args:
        value: Validated request or saved specification.

    Returns:
        Manual predictors/responses, raster references and optional habitat mask.
    """
    return get_habitat_request(value).get_raster_sources()


def get_habitat_vector_selections(
    request: HabitatRequest,
) -> dict[str, VectorSelection]:
    """Return independently selected AOI and reference vectors for upload retention.

    Args:
        request: Validated Habitat inputs.

    Returns:
        Vector descriptors keyed by area or reference_sites, when selected.
    """
    selections = {}
    if request.catalogSelection is not None:
        selections["area"] = request.catalogSelection
    if isinstance(request.references, VectorReferenceSites):
        selections["reference_sites"] = request.references.selection
    return selections


def get_habitat_polygon_inputs(
    request: HabitatRequest,
) -> dict[str, PolygonAreaReference]:
    """Identify the drawn assessment and reference polygons for admission.

    Args:
        request: Validated Habitat inputs.

    Returns:
        Owned polygon references keyed by area or reference_sites when selected.
    """
    inputs = {}
    if request.polygonArea is not None:
        inputs["area"] = request.polygonArea
    if isinstance(request.references, PolygonReferenceSites):
        inputs["reference_sites"] = request.references.reference
    return inputs


def build_habitat_submission(
    request: HabitatRequest, polygons: dict[str, AggregateArea]
) -> PreparedJobPlan:
    """Queue selected Habitat inputs without opening raster or vector data.

    Args:
        request: Validated layer selections and scientific settings.
        polygons: Owned assessment and reference polygons copied at admission.

    Returns:
        A durable, path-free request for an independent model run.
    """
    queued = QueuedHabitat(
        request=request,
        polygonArea=polygons.get("area"),
        referencePolygons=polygons.get("reference_sites"),
    )
    return PreparedJobPlan(
        operation=queued.operation,
        specification=queued.model_dump(mode="json", by_alias=True),
        summary={},
        reserved_bytes=0,
    )


async def resolve_habitat_sources(
    context: OperationContext, request: HabitatRequest
) -> HabitatSources:
    """Resolve the selected vectors and collect authorized raster paths for native work.

    Args:
        context: Existing worker capabilities and authorized additional rasters.
        request: Captured layer and area selections.

    Returns:
        Ephemeral native sources; no paths or resolved vectors enter stored inputs.

    Raises:
        ProcessingError: If vector reading is unavailable.
        SelectionUnavailableError: If a selected vector cannot be read.
    """
    selections = get_habitat_vector_selections(request)
    if selections and context.areas is None:
        raise ProcessingError(
            "selection_unavailable", "Vector selection reader is unavailable.", 409
        )
    vectors = {
        name: await context.areas.resolve_for_sampling(selection)
        for name, selection in selections.items()
    }
    return HabitatSources(
        rasters={name: source.source_path for name, source in context.rasters.items()},
        vectors=vectors,
    )


async def prepare_habitat(
    context: OperationContext, queued: QueuedHabitat, primary: None
) -> PreparedJobPlan:
    """Prepare the selected area and requested grid in the supervised worker process.

    Args:
        context: Existing source, lifecycle and native-execution capabilities.
        queued: Accepted inputs and any retained assessment or reference polygons.
        primary: None; all selected raster roles use ordinary additional sources.

    Returns:
        Saved calculation inputs with the area descriptor and calculated output grid.

    Raises:
        ProcessingError: If selected features cannot be read or the grid cannot
            be calculated.
        SelectionUnavailableError: If a selected vector is unavailable.
    """
    request = queued.request
    sources = await resolve_habitat_sources(context, request)
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
        resolved = sources.vectors["area"]
        success, summary = await context.run_native(
            summary_process, (resolved, None), None, context.native
        )
        if not success:
            raise ProcessingError("selection_unavailable", summary, 409)
        area = AggregateArea(
            kind="catalogSelection",
            bounds=summary["bbox"],
            catalogSelection=request.catalogSelection,
        )
    status, prepared = await context.run_native(
        habitat_process_target,
        ("prepare", (sources, request, area, queued.referencePolygons)),
        None,
        context.native,
    )
    if status != "ok":
        raise ProcessingError(*prepared)
    return PreparedJobPlan(
        operation=prepared.operation,
        specification=prepared.model_dump(mode="json", by_alias=True),
        summary={},
        reserved_bytes=0,
    )


async def prepare_habitat_execution(
    context: OperationContext, spec: HabitatCalculationInputs, primary: None
) -> tuple[HabitatSources, HabitatCalculationInputs]:
    """Resolve original sources for the saved Habitat calculation inputs.

    Args:
        context: Worker capabilities and authorized additional rasters.
        spec: Saved area, grid and scientific settings.
        primary: None; Habitat declares its individual raster roles explicitly.

    Returns:
        Authorized file paths and vector readers, plus the saved calculation inputs.

    Raises:
        ProcessingError: If vector reading or automatic-input configuration is unavailable.
        SelectionUnavailableError: If a selected vector cannot be read.
    """
    sources = await resolve_habitat_sources(context, spec.inputs)
    if isinstance(spec.inputs.stack, HabitatEarthEngineStack):
        runtime = cast(
            HabitatEarthEngineRuntime | None, context.operation_settings.get(OPERATION)
        )
        if runtime is None:
            raise ProcessingError(
                "habitat_earth_engine_unavailable",
                "Earth Engine inputs are not configured. Ask the administrator to "
                "configure Ecosystem Condition's Earth Engine project and credentials.",
                503,
            )
        sources = HabitatSources(sources.rasters, sources.vectors, runtime)
    return sources, spec


def select_habitat_execution(
    spec: HabitatCalculationInputs, context: OperationContext
) -> tuple[Callable[..., None], str, RasterAggregateLimits]:
    """Select the Habitat native target and existing Processing lifecycle settings.

    Args:
        spec: Saved Habitat calculation inputs.
        context: Worker execution capabilities.

    Returns:
        Native calculation target, action and shared lifecycle settings.
    """
    return habitat_process_target, "calculate", context.aggregate_limits


def describe_habitat_policy(spec: HabitatCalculationInputs) -> HabitatSettings:
    """Return the scientific settings captured for Run YAML provenance.

    Args:
        spec: Saved Habitat calculation inputs.

    Returns:
        The fixed settings used for sampling, fitting and prediction.
    """
    return spec.inputs.settings
