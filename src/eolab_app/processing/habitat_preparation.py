"""Prepare Habitat's shared Earth Engine inputs through ordinary Processing jobs."""

from dataclasses import asdict
import json
from pathlib import Path
from typing import Any, Literal, cast

import rasterio
from rasterio.crs import CRS
from shapely.geometry import shape
from shapely.ops import unary_union

from eolab_app.catalog_selection import (
    CatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.habitat_calculation import (
    HabitatSources,
    describe_habitat_file,
    read_habitat_polygons,
)
from eolab_app.processing.habitat_earth_engine import (
    HabitatEarthEngineRuntime,
    get_habitat_tiles,
    load_habitat_stack,
)
from eolab_app.processing.habitat_preparation_models import (
    OPERATION,
    HabitatInputPreparationArtifact,
    HabitatInputPreparationInputs,
    HabitatInputPreparationReport,
    HabitatInputPreparationRequest,
    HabitatInputPreparationSpec,
    QueuedHabitatInputPreparation,
)
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext


def bind_habitat_input_preparation(
    inputs: dict[str, Any],
    parameters: dict[str, Any],
    request_id: str,
    name: str,
) -> HabitatInputPreparationRequest:
    """Bind an existing Catalog area argument and year to preparation inputs.

    Args:
        inputs: Existing summary-area argument under the literal key "area".
        parameters: Assessment year under the literal key "year".
        request_id: Stable Processing submission identifier.
        name: Administrator's description of the area being prepared.

    Returns:
        Validated preparation request for one Catalog source and predicate.

    Raises:
        ValueError: If the area is not a Catalog selection or inputs are invalid.
    """
    area = inputs["area"]
    if area["kind"] != "catalogSelection":
        raise ValueError("Habitat input preparation requires a Catalog polygon area.")
    return HabitatInputPreparationRequest(
        requestId=request_id,
        name=name,
        selection=CatalogSelection.model_validate(area["selection"]),
        year=parameters["year"],
    )


def build_habitat_input_preparation_submission(
    request: HabitatInputPreparationRequest, polygons: AggregateArea | None = None
) -> PreparedJobPlan:
    """Capture scientific identity and queue a path-free input-preparation job.

    Args:
        request: Named Catalog selection, assessment year and submission identifier.
        polygons: Unused ordinary operation argument; this request is Catalog-only.

    Returns:
        Queued inputs with independent execution and the configured job retention.
        Summary and retained metadata contain descriptors, never AOI geometry.

    Raises:
        ValueError: If the packaged scientific configuration rejects the year.
        OSError: If the packaged scientific configuration cannot be read.
    """
    configuration = load_habitat_stack(request.year)
    inputs = HabitatInputPreparationInputs(
        name=request.name,
        selection=request.selection,
        year=request.year,
        configurationSha256=configuration.raster_configuration_sha256,
    )
    captured = inputs.model_dump(mode="json", by_alias=True)
    queued = QueuedHabitatInputPreparation(request=inputs)
    return PreparedJobPlan(
        operation=OPERATION,
        specification=queued.model_dump(mode="json", by_alias=True),
        summary=captured,
        retained_metadata={"inputs": captured},
        reserved_bytes=0,
    )


async def prepare_habitat_input_preparation(
    context: OperationContext, queued: QueuedHabitatInputPreparation, primary: None
) -> PreparedJobPlan:
    """Prepare the captured descriptor for execution without scanning its source.

    Args:
        context: Existing worker execution and lifecycle capabilities.
        queued: Admitted named selection, year and scientific configuration identity.
        primary: None; acquisition does not require an existing primary raster.

    Returns:
        Typed native input specification preserving the original retained metadata.
    """
    spec = HabitatInputPreparationSpec(inputs=queued.request)
    captured = queued.request.model_dump(mode="json", by_alias=True)
    return PreparedJobPlan(
        operation=OPERATION,
        specification=spec.model_dump(mode="json", by_alias=True),
        summary=captured,
        retained_metadata={"inputs": captured},
        reserved_bytes=0,
    )


async def prepare_habitat_input_preparation_execution(
    context: OperationContext, spec: HabitatInputPreparationSpec, primary: None
) -> tuple[HabitatSources, HabitatInputPreparationSpec]:
    """Resolve the original Catalog source and server-only acquisition settings.

    Args:
        context: Worker-owned source reader and operation-specific server settings.
        spec: Persisted preparation inputs without paths or reusable geometry.
        primary: None; this operation has no pre-existing primary raster.

    Returns:
        Authorized native area source and Habitat runtime, plus the unchanged inputs.

    Raises:
        ProcessingError: If source reading or Earth Engine configuration is unavailable.
        SelectionUnavailableError: If the original Catalog identity cannot be resolved.
    """
    if context.areas is None:
        raise ProcessingError(
            "selection_unavailable", "Catalog selection reader is unavailable.", 409
        )
    runtime = cast(
        HabitatEarthEngineRuntime | None, context.operation_settings.get(OPERATION)
    )
    if runtime is None:
        raise ProcessingError(
            "habitat_earth_engine_unavailable",
            "Earth Engine inputs are not configured. Ask the administrator to "
            "configure Habitat's Earth Engine project and credentials.",
            503,
        )
    resolved = await context.areas.resolve_for_sampling(spec.inputs.selection)
    return HabitatSources({}, {"area": resolved}, runtime), spec


def prepare_habitat_input_cache(
    sources: HabitatSources, spec: HabitatInputPreparationSpec, directory: Path
) -> HabitatInputPreparationArtifact:
    """Acquire the selected area's Habitat tiles and write its completion receipt.

    Args:
        sources: Authorized original Catalog polygons and server acquisition runtime.
        spec: Captured selection, year and scientific configuration identity.
        directory: Ordinary worker attempt directory beside the persistent cache.

    Returns:
        JSON report metadata for ordinary atomic publication. Shared cache TIFFs
        are neither copied into the attempt nor declared as result downloads.

    Raises:
        ProcessingError: If scientific identity changed or Earth Engine acquisition fails.
        SelectionUnavailableError: If original selected polygons cannot be read.
        ValueError: If selected geometry or a downloaded tile is invalid.
        RasterioError: If downloaded raster data cannot be admitted.
        OSError: If cache, staging or report files cannot be written.
    """
    inputs = spec.inputs
    configuration = load_habitat_stack(inputs.year)
    if configuration.raster_configuration_sha256 != inputs.configurationSha256:
        raise ProcessingError(
            "habitat_configuration_changed",
            "Habitat's input configuration changed. Submit a new preparation request.",
            409,
        )
    runtime = cast(HabitatEarthEngineRuntime, sources.earth_engine)
    polygons = read_habitat_polygons(
        sources.vectors["area"], CRS.from_string(configuration.grid.crs)
    )
    area = unary_union([shape(polygon) for polygon in polygons])
    try:
        tiles = get_habitat_tiles(
            area,
            configuration,
            runtime.connection,
            cache_directory=runtime.cache_directory,
            working_directory=directory,
            progress=lambda complete, total: write_progress(
                directory, "fetching_habitat_tiles", complete, total, unit="tiles"
            ),
            # The existing supervisor stops and joins blocked native acquisition.
            check_cancelled=lambda: None,
        )
    except RuntimeError as error:
        raise ProcessingError("habitat_earth_engine_failed", str(error), 502) from error
    report = HabitatInputPreparationReport(
        **inputs.model_dump(), tileCount=len(tiles.tiles)
    )
    path = directory / "result.json"
    path.write_text(report.model_dump_json(by_alias=True), encoding="utf-8")
    produced = describe_habitat_file(path, "report", "application/json")
    artifact = HabitatInputPreparationArtifact(
        size=produced.size,
        sha256=produced.sha256,
        filename="habitat-input-preparation-report.json",
        year=inputs.year,
        configuration_sha256=inputs.configurationSha256,
        tile_count=len(tiles.tiles),
    )
    provenance = {
        "operation": OPERATION,
        "inputs": inputs.model_dump(mode="json", by_alias=True),
        "report": report.model_dump(mode="json", by_alias=True),
        **asdict(artifact),
    }
    (directory / "provenance.json").write_text(
        json.dumps(provenance, allow_nan=False), encoding="utf-8"
    )
    return artifact


def habitat_input_preparation_process_target(
    writer: ProcessResultWriter,
    action: Literal["acquire"],
    arguments: tuple[HabitatSources, HabitatInputPreparationSpec, Path, None],
) -> None:
    """Run acquisition and return safe errors through the ordinary native supervisor.

    Args:
        writer: Worker-owned result channel receiving an artifact or safe failure.
        action: Registered acquisition action, supplied by the operation adapter.
        arguments: Authorized sources, captured inputs, attempt directory and settings.
    """
    sources, spec, directory, _ = arguments
    try:
        writer.put(("ok", prepare_habitat_input_cache(sources, spec, directory)))
    except ProcessingError as error:
        writer.put(("error", (error.code, error.detail, error.status)))
    except SelectionUnavailableError as error:
        writer.put(("error", ("selection_unavailable", error.detail, 409)))
    except ValueError as error:
        detail = str(error)
        runtime = cast(HabitatEarthEngineRuntime, sources.earth_engine)
        for path, label in (
            (sources.vectors["area"].path, "selected polygon source"),
            (directory, "preparation files"),
            (runtime.cache_directory, "Habitat input cache"),
            (runtime.connection.credentials_file, "Earth Engine credentials"),
        ):
            detail = detail.replace(str(path), label).replace(path.as_posix(), label)
        writer.put(("error", ("invalid_habitat_inputs", detail, 422)))
    except (OSError, rasterio.errors.RasterioError):
        writer.put(
            (
                "error",
                (
                    "habitat_preparation_read_failed",
                    "The selected area or Habitat input files could not be read or written.",
                    409,
                ),
            )
        )
    except Exception:
        writer.put(
            (
                "error",
                (
                    "habitat_preparation_failed",
                    "Habitat inputs could not be prepared. Try again later.",
                    500,
                ),
            )
        )


def describe_habitat_input_preparation_outcome(
    artifact: dict[str, Any],
) -> dict[str, Any]:
    """Return the scientific identity and tile count recorded by a completed job.

    Args:
        artifact: Validated metadata from a successful preparation artifact.

    Returns:
        Public report facts without cache paths, pixels or credential settings.
    """
    return {
        "year": artifact["year"],
        "configurationSha256": artifact["configuration_sha256"],
        "tileCount": artifact["tile_count"],
    }
