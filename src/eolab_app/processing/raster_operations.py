"""Adapters for existing raster operations used by Processing and YAML recipes.

Each operation owns its numerical policy, preparation and result interpretation.
The worker supplies source authorization, admission, cancellation and file publication.
"""

import asyncio
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict

from eolab_app.bounded_vector import summary_process
from eolab_app.sampling_box import sampling_box_bounds
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateArtifact,
    AggregateJobRequest,
    AggregateSpec,
    UnpreparedCalculation,
    RasterAggregateLimits,
    GroundAreaPlan,
)
from eolab_app.processing.clip_models import (
    ClipArea,
    ClipInputs,
    ClipJobRequest,
    ClipSpec,
    UnpreparedClip,
    RasterClipLimits,
)
from eolab_app.processing.models import PreparedJobPlan, ProcessingError, Artifact
from eolab_app.processing.shared_calculations import identify_shared_calculation
from eolab_app.processing.raster_aggregate import (
    aggregate_process_target,
    write_statistics_result,
)
from eolab_app.processing.raster_clip import clip_process_target
from eolab_app.processing.job_preparation import prepare_aggregate_job, prepare_clip_job
from eolab_app.processing.calculation_cache import (
    calculation_result_cache_keys,
    restore_cached_calculation_plan,
    restore_cached_calculation_rows,
    prepare_calculation_values_for_cache,
)
from eolab_app.processing.polygon_areas import PolygonAreaReference
from eolab_app.raster.models import AuthorizedRaster, CatalogRasterRequest
from eolab_app.raster.source_models import (
    RasterSourceReference,
    RasterAnalysisSourceReference,
    TemporalRasterSelection,
)
from eolab_app.raster.reader import RasterData
from eolab_app.raster.temporal import TemporalObservation
from eolab_app.processing.operation_context import OperationContext

# Plain stage descriptions supplied by the registered raster operations.
SUMMARY_PROGRESS_DESCRIPTIONS: tuple[tuple[str, str], ...] = (
    ("preparing", "Preparing inputs"),
    ("preparing_selected_polygons", "Reading selected features"),
    ("preparing_polygon_mask", "Creating the analysis mask"),
    ("calculating", "Calculating"),
    ("writing_results", "Writing results"),
)
CLIP_PROGRESS_DESCRIPTIONS: tuple[tuple[str, str], ...] = (
    ("preparing", "Preparing inputs"),
    ("clipping", "Clipping raster"),
    ("creating_cog", "Preparing GeoTIFF"),
    ("validating", "Checking GeoTIFF"),
    ("checksumming", "Finishing download"),
)


async def prepare_raster_execution(
    context: OperationContext,
    spec: AggregateSpec | ClipSpec,
    authorized: AuthorizedRaster | TemporalObservation,
) -> tuple[RasterData, AggregateSpec | ClipSpec]:
    """Resolve the exact analysis area before running a summary or clip.

    Args:
        context: Worker source, selection and lifecycle capabilities.
        spec: Stored summary or clip plan.
        authorized: Confined raster file or exact admitted temporal observation.

    Returns:
        Native raster data and plan with an ephemeral resolved vector selection.

    Raises:
        ProcessingError: If the catalog selection is unavailable.
    """
    if spec.area.kind == "catalogSelection":
        if context.areas is None:
            raise ProcessingError(
                "selection_unavailable", "Catalog selection reader is unavailable.", 409
            )
        resolved = await context.areas.resolve_for_sampling(spec.area.catalogSelection)
        spec = spec.model_copy(
            update={"area": spec.area.model_copy(update={"resolved": resolved})}
        )
    raster_data = (
        authorized
        if isinstance(authorized, TemporalObservation)
        else authorized.source_path
    )
    return raster_data, spec


class SummaryNumericalPolicy(BaseModel):
    """Numerical rules actually used by the native raster-summary operation.

    ``sourceValidity`` versions the combined mask, NoData and finite-value rule.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal["raster.aggregate.v1"]
    grid: Literal["native"]
    resampling: Literal["none"]
    numericInclusion: Literal["cell_center"]
    nodata: Literal["exclude_source_nodata_and_nonfinite"] = (
        "exclude_source_nodata_and_nonfinite"
    )
    valueDomain: Literal["stored_native_values"]
    groundArea: GroundAreaPlan | None = None
    sourceValidity: Literal["finite-unmasked-non-nodata-v1"]


class ClipNumericalPolicy(BaseModel):
    """Numerical rules actually used by the native raster-clip operation.

    ``sourceValidity`` versions the combined mask, NoData and finite-value rule.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal["raster.clip.v1"]
    grid: Literal["native"]
    resampling: Literal["none"]
    numericInclusion: Literal["all_touched"]
    nodata: Literal["preserve_source_nodata_and_mask_invalid"] = (
        "preserve_source_nodata_and_mask_invalid"
    )
    valueDomain: Literal["stored_native_values"]
    overviewResampling: Literal["nearest"]
    sourceValidity: Literal["finite-unmasked-non-nodata-v1"]


async def prepare_summary(
    context: OperationContext,
    queued: UnpreparedCalculation,
    authorized: AuthorizedRaster | TemporalObservation,
) -> PreparedJobPlan:
    """Measure summary work using its existing cache, polygon and native-grid rules.

    Args:
        context: Worker capabilities and resource limits for this attempt.
        queued: Validated summary inputs, including any owned polygon copy.
        authorized: Confined raster file or exact admitted temporal observation.

    Returns:
        Prepared summary plan and its disk reservation.

    Raises:
        ProcessingError: If the selection, native planning or resource limits fail.
    """
    request = queued.request
    alias = next(iter(request.sources))
    signature = (
        tuple(authorized.source_signature.to_catalog())
        if not isinstance(authorized, TemporalObservation)
        and authorized.source_signature is not None
        else None
    )
    resolved = None
    if request.catalogSelection:
        if context.areas is None:
            raise ProcessingError(
                "selection_unavailable",
                "Vector selection reader is unavailable.",
                409,
            )
        resolved = await context.areas.resolve_for_sampling(request.catalogSelection)
    spec = None
    if context.reuse_results and not isinstance(
        request.sources[alias], TemporalRasterSelection
    ):
        cached_results = await asyncio.to_thread(
            context.jobs.get_cached_calculation_results,
            calculation_result_cache_keys(request, signature, context.source_checksum),
        )
        spec = restore_cached_calculation_plan(
            request,
            signature,
            cached_results,
            queued.polygonArea,
            context.source_checksum,
        )
    # Cache reuse is selected by the caller; fresh runs measure their own grid.
    if spec is None:
        if queued.polygonArea:
            area = queued.polygonArea
        elif request.wholeRaster:
            area = AggregateArea(kind="wholeRaster")
        elif request.samplingBox is not None:
            area = AggregateArea(
                kind="samplingBox",
                bounds=sampling_box_bounds(request.samplingBox),
                samplingBox=request.samplingBox,
            )
        elif request.selectedBounds:
            bounds = request.selectedBounds
            area = AggregateArea(
                kind="bounds",
                bounds=(bounds.west, bounds.south, bounds.east, bounds.north),
            )
        else:
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
            aggregate_process_target,
            (
                "plan",
                (
                    (
                        authorized
                        if isinstance(authorized, TemporalObservation)
                        else authorized.source_path
                    ),
                    area,
                    request.calculations,
                    alias,
                    context.aggregate_limits,
                    request.targetChunkPixels,
                    request.pixelPoint,
                ),
            ),
            None,
            context.native,
        )
        if status != "ok":
            raise ProcessingError(*grid)
        spec = AggregateSpec(
            sources=request.sources,
            sourceSignature=signature,
            sourceChecksum=context.source_checksum,
            calculations=request.calculations,
            pixelPoint=request.pixelPoint,
            area=area,
            grid=grid,
        )
    prepared = prepare_aggregate_job(spec, context.aggregate_limits)
    return prepared


async def prepare_clip(
    context: OperationContext,
    queued: UnpreparedClip,
    authorized: AuthorizedRaster,
) -> PreparedJobPlan:
    """Measure clip work using its existing native-grid and selected-polygon rules.

    Args:
        context: Worker capabilities and resource limits for this attempt.
        queued: Validated explicit clip inputs.
        authorized: Source already authorized by the worker.

    Returns:
        Prepared clip plan and its disk reservation.

    Raises:
        ProcessingError: If the selection, native planning or resource limits fail.
    """
    request = queued.request
    source = get_clip_source(queued)
    signature = (
        tuple(authorized.source_signature.to_catalog())
        if authorized.source_signature is not None
        else None
    )
    if request.samplingBox is not None:
        area = ClipArea(
            kind="samplingBox",
            bounds=sampling_box_bounds(request.samplingBox),
            samplingBox=request.samplingBox,
        )
    elif request.selectedBounds:
        area = ClipArea(kind="bounds", bounds=request.selectedBounds.canonical_tuple())
    else:
        if context.areas is None:
            raise ProcessingError(
                "selection_unavailable",
                "Vector selection reader is unavailable.",
                409,
            )
        resolved = await context.areas.resolve_for_sampling(request.catalogSelection)
        success, summary = await context.run_native(
            summary_process, (resolved, None), None, context.native
        )
        if not success:
            raise ProcessingError("selection_unavailable", summary, 409)
        area = ClipArea(
            kind="catalogSelection",
            bounds=summary["bbox"],
            catalogSelection=request.catalogSelection,
            resolved=resolved,
        )
    status, grid = await context.run_native(
        clip_process_target,
        ("plan", (authorized.source_path, area, context.limits)),
        None,
        context.native,
    )
    if status != "ok":
        raise ProcessingError(*grid)
    spec = ClipSpec(
        source=source,
        sourceSignature=signature,
        sourceChecksum=context.source_checksum,
        area=area,
        grid=grid,
    )
    return prepare_clip_job(spec)


def bind_summary(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> AggregateJobRequest:
    """Bind validated recipe arguments to the summary operation's public request.

    Args:
        inputs: Raster and area keyed by operation argument name.
        parameters: Effective expression keyed by operation parameter name.
        request_id: Stable submission retry identifier.
        label: User's calculation label.

    Returns:
        Validated existing summary request.

    Raises:
        ValueError: If arguments violate the summary request contract.
    """
    return AggregateJobRequest(
        requestId=request_id,
        sources={"a": inputs["raster"]},
        calculations=[{"label": label, "expression": parameters["expression"]}],
        **bind_area_arguments(inputs["area"]),
    )


def bind_clip(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> ClipJobRequest:
    """Bind validated recipe arguments to the clip operation's public request.

    Args:
        inputs: Raster and explicit area keyed by operation argument name.
        parameters: Empty mapping required by the clip contract.
        request_id: Stable submission retry identifier.
        label: Run label; clip filenames remain source-derived.

    Returns:
        Validated existing clip request.

    Raises:
        ValueError: If arguments violate the clip request contract.
    """
    return ClipJobRequest(
        requestId=request_id,
        source=inputs["raster"],
        **bind_area_arguments(inputs["area"]),
    )


def bind_area_arguments(area: dict[str, Any]) -> dict[str, Any]:
    """Translate a validated model area into existing raster-operation arguments.

    Args:
        area: Area already checked against the recipe's declared input type.

    Returns:
        The existing operation's explicit area keyword arguments.

    Raises:
        KeyError: If an internal caller supplies an unvalidated area kind.
    """
    fields = {
        "selectedArea": ("selectedBounds", "selectedBounds"),
        "samplingBox": ("samplingBox", "samplingBox"),
        "catalogSelection": ("catalogSelection", "selection"),
        "polygonArea": ("polygonArea", "reference"),
    }
    if area["kind"] == "wholeRaster":
        return {"wholeRaster": True}
    argument, field = fields[area["kind"]]
    return {argument: area[field]}


def get_summary_source(
    value: AggregateJobRequest | UnpreparedCalculation | AggregateSpec,
) -> RasterAnalysisSourceReference:
    """Return the source from a validated summary request or execution plan.

    Args:
        value: Summary request, queued inputs or prepared specification.

    Returns:
        The operation's catalog raster, temporal observation or published-raster reference.
    """
    return next(
        iter(
            (
                value.request if isinstance(value, UnpreparedCalculation) else value
            ).sources.values()
        )
    )


def get_clip_source(
    value: ClipJobRequest | UnpreparedClip | ClipSpec,
) -> RasterSourceReference:
    """Return the source from a validated clip request or execution plan.

    Args:
        value: Clip request, queued inputs or prepared specification.

    Returns:
        The operation's catalog or owned published-raster reference.
    """
    if isinstance(value, ClipSpec):
        return value.source
    request = value.request if isinstance(value, UnpreparedClip) else value
    return request.source or CatalogRasterRequest(
        collectionId=request.collection_id, itemId=request.item_id
    )


def get_summary_polygon(request: AggregateJobRequest) -> PolygonAreaReference | None:
    """Return the owned polygon reference requiring capture before summary admission.

    Args:
        request: Validated summary request.

    Returns:
        Uploaded-polygon reference, or None for other area kinds.
    """
    return request.polygonArea


def get_clip_polygon(request: ClipJobRequest) -> None:
    """Report that clipping accepts no uploaded polygon references.

    Args:
        request: Validated clip request.

    Returns:
        None; clip areas are explicit bounds or catalog predicates.
    """
    return None


def build_summary_submission(
    request: AggregateJobRequest, polygons: AggregateArea | None
) -> PreparedJobPlan:
    """Build a summary submission containing inputs the worker will prepare.

    Args:
        request: Validated summary request.
        polygons: Owned uploaded polygons copied at admission, when requested.

    Returns:
        Queued plan with the ordinary sharing identity. Model admission removes
        that identity before storage so each model run remains independent.

    Raises:
        ValueError: If copied polygons do not match the request.
    """
    queued = UnpreparedCalculation(request=request, polygonArea=polygons)
    bounds = request.selectedBounds
    if request.samplingBox is not None:
        area = {
            "kind": "samplingBox",
            "bounds": sampling_box_bounds(request.samplingBox),
            "samplingBox": request.samplingBox.model_dump(mode="json"),
        }
    elif bounds:
        area = {"kind": "bounds", "bounds": bounds.canonical_tuple()}
    elif polygons:
        area = {"kind": "polygons", "bounds": polygons.bounds}
    elif request.catalogSelection:
        area = {"kind": "catalogSelection", "bounds": None}
    else:
        area = {"kind": "wholeRaster", "bounds": None}
    summary = {
        "sources": {
            alias: source.model_dump(mode="json", by_alias=True)
            for alias, source in request.sources.items()
        },
        "calculations": [item.model_dump() for item in request.calculations],
        "grid": None,
        "area": area,
    }
    return PreparedJobPlan(
        specification=queued.model_dump(mode="json", by_alias=True),
        summary=summary,
        reserved_bytes=0,
        operation=queued.operation,
        work_key=identify_shared_calculation(queued),
        presentation={"calculations": summary["calculations"]},
    )


def build_clip_submission(request: ClipJobRequest, polygons: None) -> PreparedJobPlan:
    """Build a clip submission containing inputs the worker will prepare.

    Args:
        request: Validated clip request.
        polygons: Always None under the clip input contract.

    Returns:
        Queued clip plan with its ordinary sharing identity and no native reads.
        Model admission removes the sharing identity before storage.
    """
    inputs = ClipInputs.model_validate(
        request.model_dump(exclude={"requestId"}, by_alias=True)
    )
    queued = UnpreparedClip(request=inputs)
    bounds = inputs.selectedBounds
    return PreparedJobPlan(
        specification=queued.model_dump(mode="json", by_alias=True),
        summary={
            "source": get_clip_source(request).model_dump(by_alias=True),
            "grid": None,
            "area": {
                "kind": (
                    "samplingBox"
                    if inputs.samplingBox
                    else "bounds" if bounds else "catalogSelection"
                ),
                "bounds": (
                    sampling_box_bounds(inputs.samplingBox)
                    if inputs.samplingBox
                    else bounds.canonical_tuple() if bounds else None
                ),
                **(
                    {"samplingBox": inputs.samplingBox.model_dump(mode="json")}
                    if inputs.samplingBox
                    else {}
                ),
            },
        },
        reserved_bytes=0,
        operation=queued.operation,
        work_key=identify_shared_calculation(queued),
    )


def describe_summary_policy(spec: AggregateSpec) -> SummaryNumericalPolicy:
    """Describe the numerical rules resolved during summary preparation.

    Args:
        spec: Prepared summary grid and calculations.

    Returns:
        Actual summary policy, including fractional ground-area settings when used.
    """
    return SummaryNumericalPolicy(
        version="raster.aggregate.v1",
        grid="native",
        resampling="none",
        numericInclusion="cell_center",
        nodata="exclude_source_nodata_and_nonfinite",
        sourceValidity="finite-unmasked-non-nodata-v1",
        valueDomain="stored_native_values",
        groundArea=spec.grid.groundArea,
    )


def describe_clip_policy(spec: ClipSpec) -> ClipNumericalPolicy:
    """Describe the fixed native-grid rules used by the clip implementation.

    Args:
        spec: Prepared clip specification.

    Returns:
        Actual clip policy; recipe YAML cannot override these implementation facts.
    """
    return ClipNumericalPolicy(
        version="raster.clip.v1",
        grid="native",
        resampling="none",
        numericInclusion="all_touched",
        nodata="preserve_source_nodata_and_mask_invalid",
        sourceValidity="finite-unmasked-non-nodata-v1",
        valueDomain="stored_native_values",
        overviewResampling="nearest",
    )


def select_summary_execution(
    spec: AggregateSpec, context: OperationContext
) -> tuple[Callable[..., None], str, RasterAggregateLimits]:
    """Select the native summary target and execution settings.

    Args:
        spec: Prepared summary specification.
        context: Worker limits and execution capabilities.

    Returns:
        Native target, action and calculation limits.
    """
    return aggregate_process_target, "calculate", context.aggregate_limits


def select_clip_execution(
    spec: ClipSpec, context: OperationContext
) -> tuple[Callable[..., None], str, RasterClipLimits]:
    """Select the native clip target and execution settings.

    Args:
        spec: Prepared clip specification.
        context: Worker limits and execution capabilities.

    Returns:
        Native target, action and clipping limits.
    """
    return clip_process_target, "clip", context.limits


def describe_summary_result(
    summary: dict[str, Any],
    artifact: dict[str, Any],
    numerical_policy: dict[str, Any] | None,
) -> dict[str, Any]:
    """Describe scalar results produced by a completed summary operation.

    Args:
        summary: Persisted public operation metadata.
        artifact: Completed summary file and calculated values.
        numerical_policy: Recorded calculation settings, or None after metadata expiry.

    Returns:
        Result-type fields, without file links or lifecycle decisions.
    """
    return {"rows": artifact["rows"], "cacheHit": False}


def describe_clip_result(
    summary: dict[str, Any],
    artifact: dict[str, Any],
    numerical_policy: dict[str, Any] | None,
) -> dict[str, Any]:
    """Describe the raster produced by a completed clip operation.

    Args:
        summary: Persisted public output grid, independent of YAML retention.
        artifact: Completed clip file and validity count.
        numerical_policy: Recorded calculation settings, or None after metadata expiry.

    Returns:
        Raster-type fields, without file links or lifecycle decisions.
    """
    return {"grid": summary["grid"], "validPixels": artifact["valid_pixels"]}


def describe_summary_outcome(artifact: dict[str, Any]) -> dict[str, Any]:
    """Retain completed summary values in the existing Run YAML contract.

    Args:
        artifact: Completed summary file metadata and values.

    Returns:
        Operation-owned scientific outcome metadata.
    """
    return {"statistics": artifact["rows"]}


def describe_clip_outcome(artifact: dict[str, Any]) -> dict[str, Any]:
    """Retain completed clip file metadata in the Run YAML contract.

    Args:
        artifact: Completed clip file metadata and validity count.

    Returns:
        Operation-owned scientific outcome metadata without a download URL.
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


async def restore_summary_result(
    context: OperationContext, spec: AggregateSpec, directory: Path
) -> Artifact | None:
    """Write a summary result from complete cached values when available.

    Args:
        context: Existing cache access and worker limits.
        spec: Authorized, prepared calculation.
        directory: Private attempt directory already admitted for this job.

    Returns:
        Completed CSV artifact, or None when native execution is required.
        Temporal observations do not use the completed-value cache because
        explicit temporal refresh does not invalidate that cache.
    """
    if isinstance(get_summary_source(spec), TemporalRasterSelection):
        return None
    if spec.cachedRows is not None:
        rows = [row.model_dump(mode="json") for row in spec.cachedRows]
    else:
        cached = await asyncio.to_thread(
            context.jobs.get_cached_calculation_results,
            calculation_result_cache_keys(spec),
        )
        rows = restore_cached_calculation_rows(spec, cached)
    # Keep these small writes synchronous so cancellation cannot race cleanup.
    return (
        write_statistics_result(spec, rows, directory, cache_hit=True)
        if rows is not None
        else None
    )


def collect_summary_cache_values(
    spec: AggregateSpec, artifact: AggregateArtifact
) -> dict[str, dict[str, object]] | None:
    """Return reusable scalar values from a newly calculated summary.

    Args:
        spec: Completed summary's prepared specification.
        artifact: Summary artifact containing rows and its cache-hit flag.

    Returns:
        Cache entries, or None for cached results or temporal observations.
        Explicit temporal refresh does not invalidate this completed-value cache.
    """
    return (
        None
        if artifact.cache_hit
        or isinstance(get_summary_source(spec), TemporalRasterSelection)
        else prepare_calculation_values_for_cache(spec, artifact.rows)
    )
