"""Register trusted operations available to YAML models and the Processing worker.

Adding a recipe reuses this registry. Adding an algorithm requires an operation
adapter with its own contracts; YAML never imports or executes arbitrary Python.
"""

from pathlib import Path
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Awaitable, Callable, Generic, Literal, TypeVar
from pydantic import BaseModel, TypeAdapter

from eolab_app.catalog_selection import VectorSelection
from eolab_app.processing.models import Artifact, PreparedJobPlan, ProcessingError
from eolab_app.processing.polygon_areas import PolygonAreaReference
from eolab_app.processing.aggregate_models import (
    AggregateJobRequest,
    AggregateSpec,
    UnpreparedCalculation,
    AggregateArea,
)
from eolab_app.processing.clip_models import ClipJobRequest, ClipSpec, UnpreparedClip
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_models import (
    RasterSourceReference,
    RasterAnalysisSourceReference,
    TemporalIntervalSelection,
)
from eolab_app.raster.temporal import ResolvedTemporalInterval, TemporalObservation
from eolab_app.processing import temporal_operation as temporal
from eolab_app.processing import temporal_series_operation as series
from eolab_app.processing import temporal_stack_operation as stack
from eolab_app.processing.temporal_stack_models import (
    QueuedTemporalStack,
    TemporalStackMetrics,
    TemporalStackRequest,
    TemporalStackSpec,
)
from eolab_app.processing.temporal_series_models import (
    AreaStatistic,
    QueuedTemporalSeries,
    TemporalSeriesRequest,
    TemporalSeriesSpec,
)
from eolab_app.processing.temporal_models import (
    PrecipitationConversion,
    TemporalMapRequest,
    QueuedTemporalMap,
    TemporalMapSpec,
    TemporalReduction,
)
from eolab_app.processing import raster_operations as raster
from eolab_app.processing.operation_context import OperationContext
from eolab_app.processing import downstream_operation as downstream
from eolab_app.processing.downstream_models import (
    DownstreamRequest,
    DownstreamSettings,
    QueuedDownstream,
    DownstreamPlan,
    ClosedEdgeDownstreamNumericalPolicy,
    StartingMask,
    VectorStartingMask,
)
from eolab_app.processing.prepared_hydrology import HydrologySources
from eolab_app.processing import habitat_operation as habitat
from eolab_app.processing import habitat_preparation as habitat_inputs
from eolab_app.processing.habitat_preparation_models import (
    OPERATION as HABITAT_INPUT_PREPARATION_OPERATION,
    HabitatInputPreparationInputs,
    HabitatInputPreparationRequest,
    HabitatInputPreparationSpec,
    QueuedHabitatInputPreparation,
)
from eolab_app.processing.habitat_models import (
    HabitatRequest,
    QueuedHabitat,
    HabitatCalculationInputs,
    HabitatStack,
    HabitatReferences,
    HabitatSettings,
    HabitatPreparation,
)

Request = TypeVar("Request", bound=BaseModel)
Queued = TypeVar("Queued", bound=BaseModel)
Prepared = TypeVar("Prepared", bound=BaseModel)


@dataclass(frozen=True)
class OperationOutput:
    """The result type a registered operation produces, independent of recipe naming.

    Attributes:
        name: Operation output referenced by a recipe's step.output binding.
        kind: Shared result contract, including acquisition completion reports.
        presentation: Supported display mode for that type.
        media_type: Format written by the operation.
        label: Default display label, overridable by the recipe.
        role: Whether this is a final result or a retained scientific intermediate.
        multiple_files: Whether the output contains individually named files.
            Each member keeps its operation-supplied name and appends its member
            label to the recipe's display label.
    """

    name: str
    kind: Literal["statistics", "raster", "vector", "timeSeries", "report"]
    presentation: Literal["table", "map", "download"]
    media_type: str
    label: str
    role: Literal["result", "intermediate"] = "result"
    multiple_files: bool = False


@dataclass(frozen=True)
class ModelOperation(Generic[Request, Queued, Prepared]):
    """One installed calculation's contracts and application-level adapters.

    Attributes:
        id: Versioned operation identity selected by YAML.
        inputs: Operation argument names and supported model input types.
        parameters: Parameter names and supported setting types.
        output: Primary result contract, required by every recipe using this operation.
        additional_outputs: Other complete files recipes may explicitly retain.
        execution_profile: Server resource policy required by compatible recipes.
        queued_type: Persisted input schema before preparation.
        prepared_type: Persisted execution schema after preparation.
        policy_type: Schema validating recorded numerical implementation facts.
        bind: Translate recipe-bound arguments into the existing request contract.
        source: Extract the primary Catalog or owned run-file reference. None
            declares that the operation needs no pre-existing primary raster;
            primary_input must also be None.
        polygon: Identify an owned polygon upload that admission must copy.
        vector_selections: Return selected vectors keyed by operation input name;
            admission retains their uploaded sources. Return an empty mapping
            when the request has no vector selections.
        queue: Capture inputs and ordinary sharing identity; model admission removes it.
        prepare: Resolve captured inputs into a native calculation plan. Receives
            None as its primary source when source is None.
        execution: Select the native target, action and execution settings.
        policy: Report effective numerical settings from a prepared plan.
        result: Describe completed values and grid metadata using the saved
            summary, published artifact and recorded numerical policy, when
            that metadata remains available.
        outcome: Describe retained scientific metadata in Run YAML.
        cached: Optional cache reader; None means the operation always computes results.
        reusable: Optional cache-value extractor; None disables result-cache writes.
        primary_input: Argument bound to the primary raster or temporal source,
            or None when source is None.
        extra_sources: Additional raster references to authorize and retain with the run.
        execution_inputs: Resolve ephemeral native arguments from the stored plan.
            Operations without a primary source supply a callback accepting None;
            the default callback requires an authorized raster.
        fixed_input_models: Argument names and schemas for values fixed in Model YAML.
        input_adapters: Additional operation-owned types accepted by selected inputs.
        progress_descriptions: Native phase names and their plain user-facing
            descriptions, each containing non-whitespace text up to 200 characters.
            Missing phases use the client's generic running-state description.
            Native progress writers supply the measured work units separately.
    """

    id: str
    inputs: tuple[tuple[str, str], ...]
    parameters: tuple[tuple[str, str], ...]
    output: OperationOutput
    execution_profile: str
    queued_type: type[Queued]
    prepared_type: type[Prepared]
    policy_type: type[BaseModel]
    bind: Callable[[dict[str, Any], dict[str, Any], str, str], Request]
    source: (
        Callable[
            [Request | Queued | Prepared],
            RasterAnalysisSourceReference | TemporalIntervalSelection,
        ]
        | None
    )
    polygon: Callable[[Request], PolygonAreaReference | None]
    vector_selections: Callable[[Request], dict[str, VectorSelection]]
    queue: Callable[[Request, AggregateArea | None], PreparedJobPlan]
    prepare: Callable[
        [
            OperationContext,
            Queued,
            AuthorizedRaster | TemporalObservation | ResolvedTemporalInterval | None,
        ],
        Awaitable[PreparedJobPlan],
    ]
    execution: Callable[
        [Prepared, OperationContext],
        tuple[Callable[..., None], str, Any],
    ]
    policy: Callable[[Prepared], BaseModel]
    result: Callable[
        [dict[str, Any], dict[str, Any], dict[str, Any] | None], dict[str, Any]
    ]
    outcome: Callable[[dict[str, Any]], dict[str, Any]]
    cached: (
        Callable[[OperationContext, Prepared, Path], Awaitable[Artifact | None]] | None
    ) = None
    reusable: (
        Callable[[Prepared, Artifact], dict[str, dict[str, object]] | None] | None
    ) = None
    additional_outputs: tuple[OperationOutput, ...] = ()
    primary_input: str | None = "raster"
    extra_sources: (
        Callable[[Request | Queued | Prepared], dict[str, RasterSourceReference]] | None
    ) = None
    execution_inputs: Callable[
        [
            OperationContext,
            Prepared,
            AuthorizedRaster | TemporalObservation | ResolvedTemporalInterval | None,
        ],
        Awaitable[tuple[Any, Prepared]],
    ] = raster.prepare_raster_execution
    fixed_input_models: tuple[tuple[str, type[BaseModel]], ...] = ()
    input_adapters: tuple[tuple[str, TypeAdapter[Any]], ...] = ()
    progress_descriptions: tuple[tuple[str, str], ...] = ()

    def parse_specification(
        self, value: BaseModel | dict[str, Any]
    ) -> Queued | Prepared:
        """Parse stored operation data or reuse its validated specification.

        Args:
            value: Persisted operation specification or its validated model instance.

        Returns:
            Validated queued inputs or prepared execution plan.

        Raises:
            ValueError: If persisted fields or operation identity are invalid.
        """
        if isinstance(value, (self.queued_type, self.prepared_type)):
            return value
        return (
            self.queued_type if "request" in value else self.prepared_type
        ).model_validate(value)


OPERATIONS = MappingProxyType(
    {
        operation.id: operation
        for operation in (
            ModelOperation[
                HabitatInputPreparationRequest,
                QueuedHabitatInputPreparation,
                HabitatInputPreparationSpec,
            ](
                id=HABITAT_INPUT_PREPARATION_OPERATION,
                inputs=(("area", "summary_area"),),
                parameters=(("year", "number"),),
                output=OperationOutput(
                    "report",
                    "report",
                    "download",
                    "application/json",
                    "Ecosystem Condition input preparation report",
                ),
                execution_profile="habitat-condition",
                queued_type=QueuedHabitatInputPreparation,
                prepared_type=HabitatInputPreparationSpec,
                policy_type=HabitatInputPreparationInputs,
                bind=habitat_inputs.bind_habitat_input_preparation,
                source=None,
                polygon=lambda request: None,
                vector_selections=lambda request: {"area": request.selection},
                queue=habitat_inputs.build_habitat_input_preparation_submission,
                prepare=habitat_inputs.prepare_habitat_input_preparation,
                execution=lambda spec, context: (
                    habitat_inputs.habitat_input_preparation_process_target,
                    "acquire",
                    None,
                ),
                policy=lambda spec: spec.inputs,
                result=lambda summary, artifact, policy: (
                    habitat_inputs.describe_habitat_input_preparation_outcome(artifact)
                ),
                outcome=habitat_inputs.describe_habitat_input_preparation_outcome,
                primary_input=None,
                execution_inputs=habitat_inputs.prepare_habitat_input_preparation_execution,
                progress_descriptions=(
                    (
                        "fetching_habitat_tiles",
                        "Preparing Ecosystem Condition input tiles",
                    ),
                ),
            ),
            ModelOperation[HabitatRequest, QueuedHabitat, HabitatCalculationInputs](
                id="habitat.condition.v1",
                inputs=(
                    ("stack", "habitat_stack"),
                    ("area", "summary_area"),
                    ("references", "habitat_references"),
                    ("habitat_mask", "optional_raster"),
                    ("preparation", "raster_preparation"),
                    ("settings", "habitat_settings"),
                ),
                parameters=(),
                output=OperationOutput(
                    "reference_similarity",
                    "raster",
                    "map",
                    "image/tiff",
                    "Reference similarity",
                ),
                additional_outputs=(
                    OperationOutput(
                        "diagnostics",
                        "raster",
                        "download",
                        "application/zip",
                        "Response diagnostics",
                        "intermediate",
                    ),
                ),
                execution_profile="habitat-condition",
                queued_type=QueuedHabitat,
                prepared_type=HabitatCalculationInputs,
                policy_type=HabitatSettings,
                bind=habitat.bind_habitat,
                source=None,
                polygon=habitat.get_habitat_polygon,
                vector_selections=habitat.get_habitat_vector_selections,
                queue=habitat.build_habitat_submission,
                prepare=habitat.prepare_habitat,
                execution=habitat.select_habitat_execution,
                policy=habitat.describe_habitat_policy,
                result=raster.describe_clip_result,
                outcome=raster.describe_clip_outcome,
                primary_input=None,
                extra_sources=habitat.get_habitat_raster_sources,
                execution_inputs=habitat.prepare_habitat_execution,
                fixed_input_models=(("settings", HabitatSettings),),
                input_adapters=(
                    ("habitat_stack", TypeAdapter(HabitatStack)),
                    ("habitat_references", TypeAdapter(HabitatReferences)),
                    ("optional_raster", TypeAdapter(RasterSourceReference | None)),
                    ("raster_preparation", TypeAdapter(HabitatPreparation)),
                ),
                progress_descriptions=(
                    (
                        "fetching_habitat_tiles",
                        "Loading Ecosystem Condition input tiles",
                    ),
                    ("preparing_rasters", "Preparing model rasters"),
                )
                + tuple(
                    (phase, phase)
                    for phase in (
                        "Selecting sample pixels",
                        "Reading sample values",
                        "Preparing model samples",
                        "Fitting response models",
                        "Calibrating reference departures",
                        "Predicting raster windows",
                    )
                ),
            ),
            ModelOperation[
                TemporalStackRequest, QueuedTemporalStack, TemporalStackSpec
            ](
                id="temporal.stack.v1",
                inputs=(
                    ("source", "temporal_interval"),
                    ("area", "summary_area"),
                    ("metrics", "temporal_stack_metrics"),
                ),
                parameters=(),
                output=OperationOutput(
                    "series",
                    "timeSeries",
                    "download",
                    "text/csv",
                    "Temporal raster stack",
                ),
                execution_profile="temporal-area-series",
                queued_type=QueuedTemporalStack,
                prepared_type=TemporalStackSpec,
                policy_type=stack.TemporalStackNumericalPolicy,
                bind=stack.bind_temporal_stack,
                source=series.get_series_source,
                polygon=series.get_series_polygon,
                vector_selections=lambda request: (
                    {"area": request.catalogSelection}
                    if request.catalogSelection is not None
                    else {}
                ),
                queue=stack.build_stack_submission,
                prepare=stack.prepare_temporal_stack,
                execution=stack.select_stack_execution,
                policy=stack.describe_stack_policy,
                result=stack.describe_stack_result,
                outcome=series.describe_series_outcome,
                primary_input="source",
                execution_inputs=series.prepare_series_execution,
                input_adapters=(
                    ("temporal_interval", TypeAdapter(TemporalIntervalSelection)),
                    ("temporal_stack_metrics", TypeAdapter(TemporalStackMetrics)),
                ),
                progress_descriptions=(
                    ("summarizing", "Calculating each observation"),
                ),
            ),
            ModelOperation[
                TemporalSeriesRequest, QueuedTemporalSeries, TemporalSeriesSpec
            ](
                id="temporal.series.v1",
                inputs=(
                    ("source", "temporal_interval"),
                    ("area", "summary_area"),
                    ("statistic", "area_statistic"),
                ),
                parameters=(),
                output=OperationOutput(
                    "series", "timeSeries", "download", "text/csv", "Area time series"
                ),
                execution_profile="temporal-area-series",
                queued_type=QueuedTemporalSeries,
                prepared_type=TemporalSeriesSpec,
                policy_type=series.TemporalSeriesNumericalPolicy,
                bind=series.bind_temporal_series,
                source=series.get_series_source,
                polygon=series.get_series_polygon,
                vector_selections=lambda request: (
                    {"area": request.catalogSelection}
                    if request.catalogSelection is not None
                    else {}
                ),
                queue=series.build_series_submission,
                prepare=series.prepare_temporal_series,
                execution=series.select_series_execution,
                policy=series.describe_series_policy,
                result=series.describe_series_result,
                outcome=series.describe_series_outcome,
                primary_input="source",
                execution_inputs=series.prepare_series_execution,
                input_adapters=(
                    ("temporal_interval", TypeAdapter(TemporalIntervalSelection)),
                    ("area_statistic", TypeAdapter(AreaStatistic)),
                ),
                progress_descriptions=(
                    ("summarizing", "Summarizing each observation"),
                ),
            ),
            ModelOperation[TemporalMapRequest, QueuedTemporalMap, TemporalMapSpec](
                id="temporal.reduce.v1",
                inputs=(
                    ("source", "temporal_interval"),
                    ("area", "summary_area"),
                    ("reduction", "temporal_reduction"),
                    ("precipitation", "precipitation_conversion"),
                ),
                parameters=(),
                output=OperationOutput(
                    "raster", "raster", "map", "image/tiff", "Period map"
                ),
                additional_outputs=(
                    OperationOutput(
                        "count",
                        "raster",
                        "map",
                        "image/tiff",
                        "Valid observation count",
                    ),
                ),
                execution_profile="temporal-period-map",
                queued_type=QueuedTemporalMap,
                prepared_type=TemporalMapSpec,
                policy_type=temporal.TemporalMapNumericalPolicy,
                bind=temporal.bind_temporal_map,
                source=temporal.get_temporal_source,
                polygon=temporal.get_temporal_polygon,
                vector_selections=lambda request: (
                    {"area": request.catalogSelection}
                    if request.catalogSelection is not None
                    else {}
                ),
                queue=temporal.build_temporal_submission,
                prepare=temporal.prepare_temporal_map,
                execution=temporal.select_temporal_execution,
                policy=temporal.describe_temporal_policy,
                result=temporal.describe_temporal_result,
                outcome=temporal.describe_temporal_outcome,
                primary_input="source",
                execution_inputs=temporal.prepare_temporal_execution,
                fixed_input_models=(("precipitation", PrecipitationConversion),),
                input_adapters=(
                    ("temporal_interval", TypeAdapter(TemporalIntervalSelection)),
                    ("temporal_reduction", TypeAdapter(TemporalReduction)),
                ),
                progress_descriptions=(
                    ("reducing", "Calculating the period map"),
                    ("ordering", "Calculating the period statistic"),
                    ("creating_cog", "Preparing result rasters"),
                ),
            ),
            ModelOperation[DownstreamRequest, QueuedDownstream, DownstreamPlan](
                id="hydrology.downstream_beneficiaries.v1",
                inputs=(
                    ("starting_mask", "mask_source"),
                    ("hydrology", "hydrology_sources"),
                    ("settings", "downstream_settings"),
                    ("values", "raster"),
                ),
                parameters=(
                    ("buffer_m", "number"),
                    ("cutoff_m", "optional_number"),
                    ("summary", "summary_expression"),
                    ("wgs84_pixel_size", "number"),
                    ("travel_time_pixel_size_m", "number"),
                ),
                output=OperationOutput(
                    "statistics",
                    "statistics",
                    "table",
                    "text/csv",
                    "Downstream statistics",
                ),
                additional_outputs=(
                    OperationOutput(
                        "masked_values",
                        "raster",
                        "map",
                        "image/tiff",
                        "Values within downstream coverage",
                    ),
                    OperationOutput(
                        "coverage", "raster", "map", "image/tiff", "Downstream coverage"
                    ),
                    OperationOutput(
                        "starting_mask",
                        "raster",
                        "map",
                        "image/tiff",
                        "Starting mask",
                        "intermediate",
                    ),
                    OperationOutput(
                        "routing_dem",
                        "raster",
                        "map",
                        "image/tiff",
                        "Routing DEM (pit-filled)",
                        "intermediate",
                        multiple_files=True,
                    ),
                ),
                execution_profile="downstream-small-region",
                queued_type=QueuedDownstream,
                prepared_type=DownstreamPlan,
                policy_type=ClosedEdgeDownstreamNumericalPolicy,
                bind=downstream.bind_downstream,
                source=downstream.get_values_source,
                polygon=downstream.get_uploaded_polygon,
                vector_selections=lambda request: (
                    {"starting_mask": request.starting_mask.selection}
                    if isinstance(request.starting_mask, VectorStartingMask)
                    else {}
                ),
                queue=downstream.build_downstream_submission,
                prepare=downstream.prepare_downstream,
                execution=downstream.select_downstream_execution,
                policy=downstream.describe_downstream_policy,
                result=downstream.describe_downstream_result,
                outcome=downstream.describe_downstream_outcome,
                primary_input="values",
                extra_sources=downstream.get_additional_sources,
                execution_inputs=downstream.resolve_downstream_execution_inputs,
                fixed_input_models=(
                    ("hydrology", HydrologySources),
                    ("settings", DownstreamSettings),
                ),
                input_adapters=(("mask_source", TypeAdapter(StartingMask)),),
                progress_descriptions=downstream.DOWNSTREAM_PROGRESS_DESCRIPTIONS,
            ),
            ModelOperation[AggregateJobRequest, UnpreparedCalculation, AggregateSpec](
                id="raster.aggregate.v1",
                inputs=(("raster", "raster"), ("area", "summary_area")),
                parameters=(("expression", "summary_expression"),),
                output=OperationOutput(
                    "statistics", "statistics", "table", "text/csv", "Statistics"
                ),
                execution_profile="raster-summary",
                queued_type=UnpreparedCalculation,
                prepared_type=AggregateSpec,
                policy_type=raster.SummaryNumericalPolicy,
                bind=raster.bind_summary,
                source=raster.get_summary_source,
                polygon=raster.get_summary_polygon,
                vector_selections=lambda request: (
                    {"area": request.catalogSelection}
                    if request.catalogSelection is not None
                    else {}
                ),
                queue=raster.build_summary_submission,
                prepare=raster.prepare_summary,
                execution=raster.select_summary_execution,
                policy=raster.describe_summary_policy,
                result=raster.describe_summary_result,
                outcome=raster.describe_summary_outcome,
                cached=raster.restore_summary_result,
                reusable=raster.collect_summary_cache_values,
                progress_descriptions=raster.SUMMARY_PROGRESS_DESCRIPTIONS,
            ),
            ModelOperation[ClipJobRequest, UnpreparedClip, ClipSpec](
                id="raster.clip.v1",
                inputs=(("raster", "raster"), ("area", "clip_area")),
                parameters=(),
                output=OperationOutput(
                    "raster", "raster", "map", "image/tiff", "Raster"
                ),
                execution_profile="raster-clip",
                queued_type=UnpreparedClip,
                prepared_type=ClipSpec,
                policy_type=raster.ClipNumericalPolicy,
                bind=raster.bind_clip,
                source=raster.get_clip_source,
                polygon=raster.get_clip_polygon,
                vector_selections=lambda request: (
                    {"area": request.catalogSelection}
                    if request.catalogSelection is not None
                    else {}
                ),
                queue=raster.build_clip_submission,
                prepare=raster.prepare_clip,
                execution=raster.select_clip_execution,
                policy=raster.describe_clip_policy,
                result=raster.describe_clip_result,
                outcome=raster.describe_clip_outcome,
                progress_descriptions=raster.CLIP_PROGRESS_DESCRIPTIONS,
            ),
        )
    }
)


def get_model_operation(identifier: str) -> ModelOperation[Any, Any, Any]:
    """Look up the trusted adapter for a versioned operation.

    Args:
        identifier: Operation ID supplied by a validated recipe or stored job.

    Returns:
        Registered contracts and application adapters.

    Raises:
        ProcessingError: If no installed implementation supports this operation.
    """
    try:
        return OPERATIONS[identifier]
    except KeyError as error:
        raise ProcessingError(
            "unsupported_model_operation", "This operation is not installed.", 422
        ) from error
