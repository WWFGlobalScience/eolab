"""Owned processing lifecycle and explicit raster operation commands."""

import asyncio
import hashlib
import json
import math
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import PurePath
from typing import Any
from eolab_app.processing.artifact_manifest import read_artifact_manifest

from eolab_app.processing.shared_calculations import (
    present_calculation_rows,
)
from eolab_app.processing.statistics_csv import statistics_csv
from eolab_app.processing.models import (
    ArtifactDownload,
    JobInputFile,
    JobSubmission,
    ProcessingError,
    PreparedJobPlan,
)
from eolab_app.raster.source_models import (
    RasterSourceReference,
    RasterAnalysisSourceReference,
    RunArtifactReference,
    TemporalIntervalSelection,
    TemporalVariableMetadata,
)
from eolab_app.processing.clip_models import ClipInputs, ClipJobRequest
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateJobRequest,
)
from eolab_app.processing.polygon_areas import PolygonAreaReference, PolygonSummaryInput
from eolab_app.processing.ports import (
    JobArtifactStore,
    JobStore,
    JobChanges,
    JobSubscription,
)
from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.ports import RasterSourceAuthorizer
from eolab_app.processing.model_definitions import ModelRegistry
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.habitat_preparation import (
    build_habitat_input_preparation_submission,
)
from eolab_app.processing.habitat_preparation_models import (
    OPERATION as HABITAT_PREPARATION_OPERATION,
    HabitatInputPreparationInputs,
    HabitatInputPreparationRequest,
    HabitatInputPreparationSpec,
)
from eolab_app.processing.model_run_contracts import (
    MODEL_OPERATION,
    MODEL_DELETION_UNDO_SECONDS,
    MODEL_RUN_RETENTION_SECONDS,
    ModelRunNameRequest,
    ModelRunRequest,
)
from eolab_app.processing.model_runs import (
    build_model_job_submission,
    decode_model_run_cursor,
    encode_model_run_cursor,
    export_model_job_yaml,
    read_model_invocation,
    serialize_model_job,
    serialize_model_artifacts,
    build_model_download_filename,
    build_model_calculation_request,
)
from eolab_app.processing.model_yaml import (
    encode_canonical_json,
    export_yaml,
)
from eolab_app.source_files import ResolvedSourceFile, finish_source_task
from eolab_app.catalog_selection import (
    CatalogSelectionReader,
    SelectionUnavailableError,
    UploadedSelection,
    VectorSelection,
)
from eolab_app.vector_uploads import VectorUploadError, VectorUploadStore

HABITAT_PREPARATION_OWNER = "administration:habitat-input-preparation:v1"
"""Server-controlled job scope outside the hexadecimal browser-owner namespace."""


def get_retained_habitat_preparation_inputs(
    row: dict[str, Any],
) -> HabitatInputPreparationInputs | None:
    """Read a preparation's saved inputs while its metadata remains available.

    Args:
        row: Authorized persisted job record, including retained metadata.

    Returns:
        Validated path-free inputs, or None after their metadata lifetime ends.
        The physical summary never extends access beyond that lifetime.

    Raises:
        ValueError: If persisted preparation metadata violates its schema.
    """
    metadata = row.get("retained_metadata")
    expires_at = row.get("metadata_expires_at")
    if metadata is None or (
        expires_at is not None and expires_at <= datetime.now(timezone.utc)
    ):
        return None
    return HabitatInputPreparationSpec.model_validate(metadata).inputs


def serialize_habitat_input_preparation(row: dict[str, Any]) -> dict[str, Any]:
    """Describe an authorized preparation job and its retained report.

    Args:
        row: Job record already authorized to the fixed administrator scope.

    Returns:
        Lifecycle, measured tile progress and unexpired inputs/report links,
        excluding private paths, worker settings and the internal owner scope.

    Raises:
        ValueError: If persisted preparation inputs violate their schema.
    """
    inputs = get_retained_habitat_preparation_inputs(row)
    status = row["status"]
    if status == "ready" and row["expires_at"] <= datetime.now(timezone.utc):
        status = "expired"
    artifact = row.get("artifact")
    base = f"/api/admin/habitat/input-preparations/{row['id']}"
    return {
        "jobId": row["id"],
        "operation": HABITAT_PREPARATION_OPERATION,
        "status": status,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "expiresAt": row["expires_at"],
        "metadataExpiresAt": row.get("metadata_expires_at"),
        "inputs": (
            inputs.model_dump(mode="json", by_alias=True)
            if inputs is not None
            else None
        ),
        "progress": row["progress"],
        "error": row["error"],
        "result": (
            {
                "url": f"{base}/report",
                "provenanceUrl": f"{base}/provenance",
                "filename": artifact["filename"],
                "bytes": artifact["size"],
                "sha256": artifact["sha256"],
                "year": artifact["year"],
                "configurationSha256": artifact["configuration_sha256"],
                "tileCount": artifact["tile_count"],
            }
            if status == "ready" and artifact is not None
            else None
        ),
    }


def require_operation(row: dict[str, Any], operation: str) -> None:
    """Reject a submission retry that names a different calculation operation.

    Args:
        row: Authorized job row.
        operation: Explicit operation supported by the submitting endpoint.

    Raises:
        ProcessingError: When the supplied job belongs to a different operation.
    """

    actual = (
        row.get("operation")
        or (row.get("spec") or {}).get("operation")
        or "raster.clip.v1"
    )
    if actual != operation:
        raise ProcessingError(
            "operation_mismatch",
            "This job belongs to a different processing operation.",
            409,
        )


def serialize_processing_job(row: dict[str, Any]) -> dict[str, Any]:
    """Serialize an authorized job record as its browser-visible status and result links.

    Args:
        row: An already-authorized owned job record.

    Returns:
        Public lifecycle, grid, source, and result links without storage metadata.
    """
    if row.get("operation") == MODEL_OPERATION:
        return serialize_model_job(row)
    if row.get("operation") == HABITAT_PREPARATION_OPERATION:
        return serialize_habitat_input_preparation(row)
    identifier = row["id"]
    spec = row.get("spec") or {}
    if "request" in spec:
        spec = row["summary"]
    presentation = row.get("presentation")
    if presentation and spec:
        spec = {**spec, **presentation}
        if row.get("artifact"):
            artifact = dict(row["artifact"])
            artifact["rows"] = present_calculation_rows(artifact["rows"], presentation)
            content = statistics_csv(artifact["rows"])
            artifact.update(
                size=len(content), sha256=hashlib.sha256(content).hexdigest()
            )
            row = {**row, "artifact": artifact}
    status = row["status"]
    if status == "ready" and row["expires_at"] <= datetime.now(timezone.utc):
        status = "expired"
    ready = status == "ready"
    operation = row.get("operation") or spec.get("operation") or "raster.clip.v1"
    calculation = operation == "raster.aggregate.v1"
    return {
        "jobId": identifier,
        "operation": operation,
        "status": status,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "expiresAt": row["expires_at"],
        **(
            {"sources": spec.get("sources"), "calculations": spec.get("calculations")}
            if calculation
            else {"source": spec.get("source")}
        ),
        "grid": spec.get("grid"),
        "area": (
            {
                "kind": spec["area"]["kind"],
                "bounds": spec["area"]["bounds"],
                **(
                    {"samplingBox": spec["area"]["samplingBox"]}
                    if spec["area"]["kind"] == "samplingBox"
                    else {}
                ),
            }
            if spec
            else None
        ),
        "progress": row["progress"],
        "error": row["error"],
        "result": (
            {
                "url": f"/api/processing/jobs/{identifier}/result",
                "provenanceUrl": f"/api/processing/jobs/{identifier}/provenance",
                "filename": row["artifact"]["filename"],
                "bytes": row["artifact"]["size"],
                "sha256": row["artifact"]["sha256"],
                **(
                    {
                        "rows": row["artifact"]["rows"],
                        "cacheHit": row["artifact"].get("cache_hit", False),
                    }
                    if calculation
                    else {"validPixels": row["artifact"]["valid_pixels"]}
                ),
            }
            if ready and row["artifact"]
            else None
        ),
    }


class ProcessingService:
    """Submit calculations and manage browser-owned and administrator-owned jobs."""

    def __init__(
        self,
        jobs: JobStore,
        artifacts: JobArtifactStore,
        *,
        changes: JobChanges | None = None,
        submission_wait_seconds: float = 0.45,
        model_registry: ModelRegistry | None = None,
        model_authorizer: RasterSourceAuthorizer | None = None,
        uploads: VectorUploadStore | None = None,
        areas: CatalogSelectionReader | None = None,
    ) -> None:
        """Configure job storage, source access and the installed model library.

        Args:
            jobs: Durable job and admission adapter.
            artifacts: Confined result-file adapter.
            changes: Lifecycle-managed owned-job notification provider.
            submission_wait_seconds: Observation budget per calculation submission,
                finite and non-negative; zero gives immediate acknowledgement. The final
                owned-state read also incurs the ordinary database access latency.
            model_registry: Validated installed recipes; bundled definitions load
                eagerly when omitted, failing readiness if invalid.
            model_authorizer: Catalog-only source authority for capturing model
                inputs at admission. Existing raster endpoints retain their behavior.
            uploads: Original GeoPackages and retained links for accepted jobs.
            areas: Existing reader authorizing Catalog and uploaded vector selections.

        Raises:
            ValueError: If the submission observation budget is negative or non-finite.
        """
        if submission_wait_seconds < 0 or not math.isfinite(submission_wait_seconds):
            raise ValueError("Submission wait must be finite and non-negative")
        self.jobs = jobs
        self.artifacts = artifacts
        self.changes = changes
        self.submission_wait_seconds = submission_wait_seconds
        self.model_registry = (
            model_registry
            if model_registry is not None
            else ModelRegistry.load_installed()
        )
        self.model_authorizer = model_authorizer
        self.uploads = uploads
        self.areas = areas
        self._upload_admission_lock = asyncio.Lock()

    async def _recover_habitat_preparation_request(
        self, request_id: str, request_hash: str
    ) -> dict[str, Any] | None:
        """Recover an accepted admin submission before checking its original inputs.

        Args:
            request_id: Administrator command's stable retry identifier.
            request_hash: Complete submission or retry-command identity.

        Returns:
            Previously accepted preparation, or None when this command is new.

        Raises:
            ProcessingError: If the identifier belongs to different inputs or an
                operation outside Habitat preparation, or storage is unavailable.
        """
        existing = await asyncio.to_thread(
            self.jobs.find_request, HABITAT_PREPARATION_OWNER, request_id
        )
        if existing is None:
            return None
        require_operation(existing, HABITAT_PREPARATION_OPERATION)
        if existing["request_hash"] != request_hash:
            raise ProcessingError(
                "request_conflict",
                "That request ID already belongs to different preparation inputs.",
                409,
            )
        return serialize_habitat_input_preparation(existing)

    async def _admit_habitat_input_preparation(
        self,
        request: HabitatInputPreparationRequest,
        request_hash: str,
        expected_configuration_sha256: str | None = None,
    ) -> dict[str, Any]:
        """Authorize one Catalog AOI and queue preparation under the admin scope.

        Args:
            request: Validated area, year, name and submission identifier.
            request_hash: Identity already checked against previous submissions.
            expected_configuration_sha256: Original scientific identity for an
                explicit retry, or None for a fresh preparation request.

        Returns:
            Newly accepted preparation or an atomic, unchanged concurrent retry.

        Raises:
            ProcessingError: If the scientific configuration or job storage is
                unavailable, the year is unsupported, or request inputs conflict.
            SelectionUnavailableError: If Catalog authorization rejects the area.
        """
        if self.areas is None:
            raise ProcessingError(
                "selection_unavailable", "Catalog vector access is unavailable.", 503
            )
        try:
            prepared = build_habitat_input_preparation_submission(request)
        except ValueError as error:
            raise ProcessingError(
                "invalid_habitat_year",
                "Choose an assessment year supported by the installed Ecosystem Condition inputs.",
                422,
            ) from error
        except OSError as error:
            raise ProcessingError(
                "habitat_inputs_unavailable",
                "Ecosystem Condition input preparation is temporarily unavailable. Try again later.",
                503,
            ) from error
        if (
            expected_configuration_sha256 is not None
            and prepared.summary["configurationSha256"] != expected_configuration_sha256
        ):
            raise ProcessingError(
                "habitat_configuration_changed",
                "The Ecosystem Condition input configuration changed. Start a new preparation request.",
                409,
            )
        await self.areas.resolve_for_sampling(request.selection)
        row = await asyncio.to_thread(
            self.jobs.submit,
            HABITAT_PREPARATION_OWNER,
            request.requestId,
            prepared,
            request_hash,
        )
        return serialize_habitat_input_preparation(row)

    async def submit_habitat_input_preparation(
        self, request: HabitatInputPreparationRequest
    ) -> dict[str, Any]:
        """Start preparing Habitat inputs independently of a model calculation.

        Args:
            request: One Catalog AOI, supported assessment year and job name.

        Returns:
            Queued preparation, or the original job for the same request ID and
            inputs. The server-controlled owner is independent of browser cookies
            and administrator passwords; downloads remain admin-only.

        Raises:
            ProcessingError: If inputs conflict, configuration is unavailable or
                admission fails.
            SelectionUnavailableError: If Catalog authorization rejects the AOI.
        """
        request_hash = hashlib.sha256(
            encode_canonical_json(
                request.model_dump(mode="json", exclude={"requestId"})
            )
        ).hexdigest()
        existing = await self._recover_habitat_preparation_request(
            request.requestId, request_hash
        )
        if existing is not None:
            return existing
        return await self._admit_habitat_input_preparation(request, request_hash)

    async def list_habitat_input_preparations(
        self, limit: int, cursor: str | None
    ) -> dict[str, Any]:
        """Return one page of admin-owned Habitat preparation history.

        Args:
            limit: Maximum jobs to return, from one to 100.
            cursor: Previous nextCursor value, or None for the newest jobs.

        Returns:
            Operation-filtered job statuses and a continuation cursor. No browser
            owner's jobs or other administrator operations can appear here.

        Raises:
            ProcessingError: If pagination is invalid or storage is unavailable.
        """
        if not 1 <= limit <= 100:
            raise ProcessingError(
                "invalid_limit", "Choose between one and 100 input preparations."
            )
        try:
            before = decode_model_run_cursor(cursor)
        except ProcessingError as error:
            raise ProcessingError(
                "invalid_cursor", "This preparation-list cursor is invalid.", 422
            ) from error
        rows = await asyncio.to_thread(
            self.jobs.list_session_jobs_page,
            HABITAT_PREPARATION_OWNER,
            (HABITAT_PREPARATION_OPERATION,),
            limit + 1,
            before,
        )
        return {
            "jobs": [serialize_habitat_input_preparation(row) for row in rows[:limit]],
            "nextCursor": (
                encode_model_run_cursor(rows[limit - 1]) if len(rows) > limit else None
            ),
        }

    async def get_habitat_input_preparation(self, identifier: str) -> dict[str, Any]:
        """Read one Habitat preparation belonging to the server's admin scope.

        Args:
            identifier: Public preparation handle returned at admission.

        Returns:
            Current lifecycle, measured tile progress and retained report links.

        Raises:
            ProcessingError: If unavailable, of another operation or storage fails.
        """
        row = await asyncio.to_thread(
            self.jobs.get, identifier, HABITAT_PREPARATION_OWNER
        )
        require_operation(row, HABITAT_PREPARATION_OPERATION)
        return serialize_habitat_input_preparation(row)

    async def cancel_habitat_input_preparation(self, identifier: str) -> dict[str, Any]:
        """Ask the existing worker to stop one admin-owned Habitat preparation.

        Args:
            identifier: Public preparation handle returned at admission.

        Returns:
            Updated state; running work remains cancelling until native exit.
            Already published cache tiles remain available to later calculations.

        Raises:
            ProcessingError: If the job is unavailable, of another operation or
                the cancellation cannot be recorded.
        """
        row = await asyncio.to_thread(
            self.jobs.get, identifier, HABITAT_PREPARATION_OWNER
        )
        require_operation(row, HABITAT_PREPARATION_OPERATION)
        return serialize_habitat_input_preparation(
            await asyncio.to_thread(
                self.jobs.cancel, identifier, HABITAT_PREPARATION_OWNER
            )
        )

    async def retry_habitat_input_preparation(
        self, identifier: str, request_id: str
    ) -> dict[str, Any]:
        """Start a new preparation using a failed or expired job's retained inputs.

        Args:
            identifier: Failed, cancelled, interrupted or expired preparation handle.
            request_id: Stable identifier for this retry command.

        Returns:
            New preparation using the saved Catalog descriptor, year and name,
            or this command's accepted job even if the old metadata has expired.
            Completed cached tiles are reused by ordinary Habitat acquisition.

        Raises:
            ProcessingError: If the original job is active, ready, unavailable,
                outside this operation, or its retained inputs have expired.
            SelectionUnavailableError: If Catalog authorization now rejects the AOI.
        """
        request_hash = hashlib.sha256(
            encode_canonical_json({"retryOf": identifier})
        ).hexdigest()
        existing = await self._recover_habitat_preparation_request(
            request_id, request_hash
        )
        if existing is not None:
            return existing
        row = await asyncio.to_thread(
            self.jobs.get, identifier, HABITAT_PREPARATION_OWNER
        )
        require_operation(row, HABITAT_PREPARATION_OPERATION)
        if serialize_habitat_input_preparation(row)["status"] not in {
            "failed",
            "cancelled",
            "interrupted",
            "expired",
        }:
            raise ProcessingError(
                "preparation_not_retryable",
                "Retry a failed, cancelled, interrupted or expired input preparation.",
                409,
            )
        inputs = get_retained_habitat_preparation_inputs(row)
        if inputs is None:
            raise ProcessingError(
                "preparation_inputs_expired",
                "This preparation's saved inputs have expired. Choose the area and year again.",
                409,
            )
        return await self._admit_habitat_input_preparation(
            HabitatInputPreparationRequest(
                requestId=request_id,
                name=inputs.name,
                selection=inputs.selection,
                year=inputs.year,
            ),
            request_hash,
            inputs.configurationSha256,
        )

    async def download_habitat_input_preparation(
        self, identifier: str, provenance: bool = False
    ) -> ArtifactDownload:
        """Lease an admin-owned preparation report through ordinary result delivery.

        Args:
            identifier: Public preparation handle.
            provenance: Select provenance instead of the primary JSON report.

        Returns:
            Confined retained file and its renewable transfer lease. Report expiry
            and transfer cleanup never remove persistent Habitat cache entries.

        Raises:
            ProcessingError: If the handle is unavailable, belongs to another
                operation or its report has expired.
        """
        row = await asyncio.to_thread(
            self.jobs.get, identifier, HABITAT_PREPARATION_OWNER
        )
        require_operation(row, HABITAT_PREPARATION_OPERATION)
        artifact = await self.download(
            HABITAT_PREPARATION_OWNER, identifier, provenance
        )
        return (
            replace(artifact, filename="habitat-input-preparation-provenance.json")
            if provenance
            else artifact
        )

    async def submit_model_run(
        self, owner: str, request: ModelRunRequest, upload_owner: str | None = None
    ) -> dict[str, Any]:
        """Start a model run, or recover a previously accepted submission.

        Checks the selected model and its declared sources, fills in defaults,
        and saves the inputs before queueing work. Repeating the same request ID
        and inputs returns the original run even if its model or source is no
        longer installed.

        Args:
            owner: Hash of the requesting browser's Processing session cookie.
            request: The chosen model, input datasets, area, parameters and run label.
            upload_owner: Separate browser identity authorizing private GeoPackages.

        Returns:
            The newly queued run, or the original run for an unchanged retry.

        Raises:
            ProcessingError: If the retry conflicts, model inputs are invalid,
                an additional source is unavailable, or submission cannot be admitted.
            RasterFeatureError: If the catalog cannot authorize the selected raster.
        """
        request_data = request.model_dump(mode="json", exclude={"requestId"})
        request_hash = hashlib.sha256(encode_canonical_json(request_data)).hexdigest()
        existing = await asyncio.to_thread(
            self.jobs.find_request, owner, request.requestId
        )
        if existing is not None:
            require_operation(existing, MODEL_OPERATION)
            if existing["request_hash"] != request_hash:
                raise ProcessingError(
                    "request_conflict",
                    "That request ID has different model inputs.",
                    409,
                )
            return serialize_processing_job(existing)
        calculation, invocation = build_model_calculation_request(
            request, self.model_registry
        )
        operation = get_model_operation(invocation.model.definition.steps[0].operation)
        source = operation.source(calculation) if operation.source is not None else None
        reference = operation.polygon(calculation)
        polygons = await self.read_polygon_area(owner, reference) if reference else None
        operation_plan = operation.queue(calculation, polygons)
        source_metadata: (
            tuple[int, int, int, int] | TemporalVariableMetadata | JobInputFile | None
        ) = None
        if isinstance(source, TemporalIntervalSelection):
            if self.model_authorizer is None:
                raise ProcessingError(
                    "models_unavailable",
                    "Model source authorization is unavailable.",
                    503,
                )
            source_metadata = await self.model_authorizer.get_temporal_metadata(source)
        elif source is not None:
            operation_plan, source_metadata = await self._capture_model_raster_metadata(
                owner, source, operation_plan
            )
        additional_sources: dict[str, tuple[int, int, int, int] | JobInputFile] = {}
        if operation.extra_sources:
            for name, additional_source in operation.extra_sources(calculation).items():
                try:
                    operation_plan, additional_sources[name] = (
                        await self._capture_model_raster_metadata(
                            owner, additional_source, operation_plan
                        )
                    )
                except RasterFeatureError as error:
                    raise ProcessingError(
                        "source_unavailable",
                        f"The model's {name} input is unavailable. {error.detail}",
                        422,
                    ) from error
        prepared = build_model_job_submission(
            operation_plan,
            invocation,
            source_metadata,
            additional_sources,
        )
        prepared = replace(
            prepared, presentation={"utcOffsetMinutes": request.utcOffsetMinutes}
        )
        row = await self._submit_job(
            owner,
            request.requestId,
            prepared,
            request_hash,
            operation.vector_selections(calculation),
            upload_owner,
        )
        return serialize_processing_job(row)

    async def _capture_model_raster_metadata(
        self,
        owner: str,
        source: RasterSourceReference,
        prepared: PreparedJobPlan,
    ) -> tuple[PreparedJobPlan, tuple[int, int, int, int] | JobInputFile]:
        """Authorize a model raster, returning its metadata and updated job inputs.

        Args:
            owner: Processing session requesting the model run.
            source: Catalog raster or owned published-file reference.
            prepared: Queued plan containing any previously captured inputs.

        Returns:
            Plan retaining the private input when needed, and this source's
            catalog metadata or published file identity for Run YAML.

        Raises:
            ProcessingError: If model authorization is unavailable or the
                published file cannot be used by this session.
            RasterFeatureError: If the Catalog raster cannot be authorized.
        """
        if isinstance(source, RunArtifactReference):
            prepared = await self.capture_input_file(owner, source, prepared)
            file = next(
                file
                for file in prepared.input_files
                if (file.run_id, file.artifact_id)
                == (source.job_id, source.artifact_id)
            )
            return prepared, file
        if self.model_authorizer is None:
            raise ProcessingError(
                "models_unavailable",
                "Model source authorization is unavailable.",
                503,
            )
        authorized = await self.model_authorizer.authorize(source)
        return prepared, tuple(authorized.source_signature.to_catalog())

    async def _submit_job(
        self,
        owner: str,
        request_key: str,
        prepared: PreparedJobPlan,
        request_hash: str,
        selections: dict[str, VectorSelection],
        upload_owner: str | None,
    ) -> dict[str, Any]:
        """Queue one job after retaining all its uploaded polygon inputs.

        Args:
            owner: Processing session that owns the submitted job.
            request_key: Stable browser retry identifier.
            prepared: Queued operation data and captured raster inputs.
            request_hash: Complete public request identity.
            selections: Vector selections keyed by the operation's input names.
            upload_owner: Browser identity for private GeoPackage access.

        Returns:
            The accepted job or its previously accepted retry.

        Raises:
            ProcessingError: If source access or job admission fails.
        """
        if not any(
            isinstance(selection, UploadedSelection)
            for selection in selections.values()
        ):
            return await asyncio.to_thread(
                self.jobs.submit, owner, request_key, prepared, request_hash
            )
        results = await self._submit_jobs_with_uploaded_inputs(
            owner,
            [JobSubmission(request_key, request_hash, prepared.operation, prepared)],
            [selections],
            upload_owner,
        )
        result = results[0]
        if isinstance(result, ProcessingError):
            raise result
        return result

    async def _submit_jobs_with_uploaded_inputs(
        self,
        owner: str,
        submissions: list[JobSubmission],
        selections: list[dict[str, VectorSelection]],
        upload_owner: str | None,
    ) -> list[dict[str, Any] | ProcessingError]:
        """Submit jobs and keep their uploaded polygon files available until they stop.

        A hard link to each authorized GeoPackage lets an accepted job read the
        file even if the user deletes the upload. Cleanup removes that link once
        the job stops. A batch may also contain jobs without uploaded inputs.

        Link creation and job submission share a lock with cleanup. If the caller
        cancels, submission finishes before that lock is released. Failed or
        duplicate submissions can leave unused links for the next cleanup pass.

        Args:
            owner: Processing session receiving each job handle.
            submissions: Queued plans or input errors, in request order.
            selections: Each job's vector selections keyed by operation input name,
                in the same order as submissions. Every uploaded selection's
                predicate is authorized; selections sharing an upload retain one
                file per job.
            upload_owner: Browser identity used only while authorizing uploads.

        Returns:
            Accepted jobs or per-item errors, including unchanged retry results.

        Raises:
            ProcessingError: If the shared database admission fails.
            asyncio.CancelledError: After file linking and job submission have stopped.
        """

        async def retain_and_submit() -> list[dict[str, Any] | ProcessingError]:
            """Create hard links to uploaded GeoPackages, then submit the batch.

            Returns:
                The store's accepted jobs and per-item failures.

            Raises:
                ProcessingError: If the admission transaction fails.
            """
            captured = []
            for submission, inputs in zip(submissions, selections, strict=True):
                prepared = submission.prepared
                uploaded = [
                    selection
                    for selection in inputs.values()
                    if isinstance(selection, UploadedSelection)
                ]
                if uploaded and isinstance(prepared, PreparedJobPlan):
                    try:
                        if (
                            self.uploads is None
                            or self.areas is None
                            or upload_owner is None
                        ):
                            raise VectorUploadError(
                                404, "This upload is not available to this browser."
                            )
                        retained: dict[str, str] = {}
                        for selection in uploaded:
                            resolved = await self.areas.resolve_for_sampling(
                                selection, upload_owner
                            )
                            upload_id = str(selection.uploadId)
                            if upload_id not in retained:
                                retained[upload_id] = await asyncio.to_thread(
                                    self.uploads.retain_source, resolved.path
                                )
                        prepared = replace(
                            prepared,
                            input_uploads=retained,
                            work_key=None,
                        )
                    except VectorUploadError as error:
                        prepared = ProcessingError(
                            "source_unavailable", str(error), error.status
                        )
                    except SelectionUnavailableError as error:
                        prepared = ProcessingError(
                            "source_unavailable", error.detail, 409
                        )
                captured.append(replace(submission, prepared=prepared))
            return await asyncio.to_thread(self.jobs.submit_batch, owner, captured)

        async with self._upload_admission_lock:
            task = asyncio.create_task(retain_and_submit())
            try:
                return await asyncio.shield(task)
            finally:
                await finish_source_task(task)

    async def reconcile_upload_inputs(self) -> None:
        """Release uploaded files once no queued or executing job needs them.

        The API is the upload volume's sole writer. Its periodic reconciliation
        shares the admission lock, so a file cannot be removed between retention
        and the database commit. Database unavailability leaves all files intact.

        Raises:
            ProcessingError: If active job inputs cannot be read.
            VectorUploadError: If retained files cannot be removed.
        """
        if self.uploads is None:
            return

        async def release_unused() -> None:
            """Remove retained links absent from the active job snapshot.

            Raises:
                ProcessingError: If the job snapshot is unavailable.
                VectorUploadError: If the upload directory cannot be cleaned.
            """
            retained = await asyncio.to_thread(self.jobs.active_input_uploads)
            await asyncio.to_thread(self.uploads.remove_unretained_sources, retained)

        async with self._upload_admission_lock:
            task = asyncio.create_task(release_unused())
            try:
                await asyncio.shield(task)
            finally:
                await finish_source_task(task)

    async def capture_input_file(
        self,
        owner: str,
        source: RasterAnalysisSourceReference | TemporalIntervalSelection,
        prepared: PreparedJobPlan,
    ) -> PreparedJobPlan:
        """Add a published raster identity to the files retained at job admission.

        Args:
            owner: Requesting browser session hash.
            source: Catalog raster, temporal observation/interval or owned published-file reference.
            prepared: Operation-owned queued specification.

        Returns:
            Plan retaining each distinct private file once, including inputs
            already captured. Private work is not coalesced with another
            submission; catalog sharing stays unchanged.

        Raises:
            ProcessingError: If the file is unavailable or is not published raster data.
        """
        if not isinstance(source, RunArtifactReference):
            return prepared
        if any(
            (file.run_id, file.artifact_id) == (source.job_id, source.artifact_id)
            for file in prepared.input_files
        ):
            return prepared
        file = await asyncio.to_thread(
            self.jobs.inspect_input_file, owner, source.job_id, source.artifact_id
        )
        if (
            file.media_type != "image/tiff"
            or file.role not in {"result", "intermediate"}
            or file.size <= 0
        ):
            raise ProcessingError(
                "invalid_raster_input",
                "Choose a published raster result or scientific raster intermediate.",
                422,
            )
        return replace(
            prepared, input_files=(*prepared.input_files, file), work_key=None
        )

    async def list_models(self) -> dict[str, Any]:
        """List every installed model recipe and its setup fields.

        Returns:
            Model definitions, versions and checksums, without accessing datasets or rendering.
        """
        return {"models": self.model_registry.list_models()}

    async def export_installed_model_yaml(self, identifier: str, version: str) -> bytes:
        """Export an installed model definition as reusable Model YAML.

        Args:
            identifier: The model ID returned by discovery.
            version: The installed model version to export.

        Returns:
            UTF-8 YAML bytes describing the recipe.

        Raises:
            ProcessingError: If the model version is unavailable or cannot be exported.
        """
        return export_yaml(self.model_registry.get(identifier, version).to_document())

    async def export_job_yaml(
        self, owner: str, identifier: str, *, run: bool
    ) -> tuple[bytes, str]:
        """Export the recipe or run details saved with this browser session's job.

        Args:
            owner: Hash of the requesting browser's Processing session cookie.
            identifier: The model run's job ID.
            run: True for Run YAML including inputs and execution details; False for
                only the reusable Model YAML recipe.

        Returns:
            UTF-8 YAML bytes and a filename using the run's current name and creation
            timestamp. The saved recipe is independent of the current library.

        Raises:
            ProcessingError: If the job is unavailable to this session or its metadata expired.
        """
        row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        document_kind = "run-yaml" if run else "model-yaml"
        return export_model_job_yaml(row, run=run), build_model_download_filename(
            row, document_kind, "document.yaml", "application/yaml"
        )

    async def rename_model_run(
        self, owner: str, identifier: str, request: ModelRunNameRequest
    ) -> dict[str, Any]:
        """Rename an owned model run without changing its calculation or retained files.

        Args:
            owner: Hash of the requesting browser's Processing session cookie.
            identifier: The model run's public job ID.
            request: Validated replacement name, without a creation timestamp.

        Returns:
            Updated run status and download names using its original creation time.

        Raises:
            ProcessingError: If the run is unowned, deleted or not a model run.
        """
        row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        require_operation(row, MODEL_OPERATION)
        updated = await asyncio.to_thread(
            self.jobs.update_presentation,
            identifier,
            owner,
            {"label": request.label},
        )
        return serialize_processing_job(updated)

    async def get_model_invocation(self, owner: str, identifier: str) -> dict[str, Any]:
        """Read a run's original setup for inspection or duplication.

        Args:
            owner: Hash of the requesting browser's Processing session cookie.
            identifier: The accepted model run's job ID.

        Returns:
            The saved recipe, inputs and effective parameter values as JSON data.

        Raises:
            ProcessingError: If the session cannot access the run or its metadata
                is no longer available.
        """
        row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        return read_model_invocation(row).model_dump(mode="json", by_alias=True)

    async def list_model_runs(
        self, owner: str, limit: int, cursor: str | None
    ) -> dict[str, Any]:
        """Return one page of the requesting browser session's model runs.

        Args:
            owner: Hash of the browser's Processing session cookie.
            limit: Maximum runs to return on this page, between one and 100.
            cursor: The previous response's nextCursor, or None for the newest runs.

        Returns:
            Model run statuses and a nextCursor when older matching runs exist.

        Raises:
            ProcessingError: If pagination values are invalid or job storage is unavailable.
        """
        if not 1 <= limit <= 100:
            raise ProcessingError(
                "invalid_limit", "Choose between one and 100 model runs."
            )
        rows = await asyncio.to_thread(
            self.jobs.list_session_jobs_page,
            owner,
            (MODEL_OPERATION,),
            limit + 1,
            decode_model_run_cursor(cursor),
        )
        return {
            "jobs": [serialize_processing_job(row) for row in rows[:limit]],
            "nextCursor": (
                encode_model_run_cursor(rows[limit - 1]) if len(rows) > limit else None
            ),
        }

    async def subscribe_jobs(self, owner: str) -> JobSubscription:
        """Subscribe to hints for the same owner used by ordinary job reads.

        Args:
            owner: Hashed session capability from the HTTP boundary.

        Returns:
            A subscription which the transport must close on every exit path.

        Raises:
            ProcessingError: If live updates are disabled or at capacity.
        """
        if self.changes is None:
            raise ProcessingError(
                "events_unavailable",
                "Live updates are unavailable; use job status polling.",
                503,
            )
        return self.changes.subscribe(owner)

    async def upload_polygon_area(
        self, owner: str, polygons: PolygonSummaryInput
    ) -> dict[str, Any]:
        """Retain submitted polygon geometry for this browser's summary calculations.

        Args:
            owner: Current Processing browser-session hash.
            polygons: Validated committed polygons after the user's filter.

        Returns:
            Small area reference, geographic envelope and polygon count.

        Raises:
            ProcessingError: If temporary input storage is full or unavailable.
        """
        checksum = polygons.geometry_hash()
        identifier = await asyncio.to_thread(
            self.jobs.save_input, owner, checksum, polygons.model_dump(mode="json")
        )
        return {
            "polygonArea": {"id": identifier, "sha256": checksum},
            "bbox": polygons.bounds(),
            "matched": len(polygons.polygons),
        }

    async def read_polygon_area(
        self, owner: str, reference: PolygonAreaReference
    ) -> AggregateArea:
        """Load exact polygons from an input owned by the requesting browser.

        Args:
            owner: Current Processing browser-session hash.
            reference: Expiring input ID and expected geometry hash.

        Returns:
            Validated geometry copied into this calculation job.

        Raises:
            ProcessingError: If the input expired or is not owned by the caller.
            ValueError: If persisted geometry violates its input contract.
        """
        payload = await asyncio.to_thread(
            self.jobs.get_input, owner, reference.id, reference.sha256
        )
        polygons = PolygonSummaryInput.model_validate(payload)
        return AggregateArea(
            kind="polygons",
            bounds=polygons.bounds(),
            geometryHash=reference.sha256,
            geometries=tuple(p.model_dump(mode="json") for p in polygons.polygons),
        )

    async def discard_polygon_area(self, owner: str, identifier: str) -> None:
        """Release polygons that this browser no longer uses for new calculations.

        Args:
            owner: Current Processing session hash.
            identifier: Uploaded polygon-area ID.

        Raises:
            ProcessingError: If the storage operation fails.
        """
        await asyncio.to_thread(self.jobs.discard_input, owner, identifier)

    async def submit_raster_clip(
        self, owner: str, request: ClipJobRequest, upload_owner: str | None = None
    ) -> dict[str, Any]:
        """Join identical active clipping work or queue a clip with its complete inputs.

        Args:
            owner: Current browser-session hash.
            request: Catalog or private raster, explicit area and stable retry key.
            upload_owner: Browser identity authorizing an uploaded clipping area.

        Returns:
            The caller's handle for shared/new work, or the same handle on retry.

        Raises:
            ProcessingError: If the retry changes inputs or admission is full.
        """
        inputs = ClipInputs.model_validate(
            request.model_dump(exclude={"requestId"}, by_alias=True)
        )
        request_hash = hashlib.sha256(
            json.dumps(
                inputs.model_dump(mode="json", by_alias=True), sort_keys=True
            ).encode()
        ).hexdigest()
        operation = get_model_operation("raster.clip.v1")
        prepared = operation.queue(request, None)
        try:
            prepared = await self.capture_input_file(
                owner, operation.source(request), prepared
            )
        except ProcessingError:
            existing = await asyncio.to_thread(
                self.jobs.find_request, owner, request.requestId
            )
            if existing is None:
                raise
            require_operation(existing, operation.id)
            if existing["request_hash"] != request_hash:
                raise ProcessingError(
                    "request_conflict",
                    "That request ID has different clip inputs.",
                    409,
                )
            return serialize_processing_job(existing)
        row = await self._submit_job(
            owner,
            request.requestId,
            prepared,
            request_hash,
            operation.vector_selections(request),
            upload_owner,
        )
        require_operation(row, operation.id)
        return serialize_processing_job(row)

    async def submit_calculation_inputs(
        self, owner: str, request: AggregateJobRequest, upload_owner: str | None = None
    ) -> dict[str, Any]:
        """Join identical active statistics work or queue a calculation with its inputs.

        Args:
            owner: Current browser-session hash.
            request: Validated raster reference, selected area, formulas and stable
                retry key. Direct callers must construct AggregateJobRequest
                through its normal validation, just as the HTTP boundary does.
            upload_owner: Browser identity authorizing an uploaded summary area.

        Returns:
            The caller's observed job and labels, or the same handle after a retry.
            Completion observation uses the same budget as a calculation batch.

        Raises:
            ProcessingError: For conflicting retries, unavailable polygon inputs,
                or exhausted queue and job-record capacity.
        """
        inputs = request
        request_hash = hashlib.sha256(
            json.dumps(
                inputs.model_dump(mode="json", by_alias=True, exclude={"requestId"}),
                sort_keys=True,
            ).encode()
        ).hexdigest()
        existing = await asyncio.to_thread(
            self.jobs.find_request, owner, request.requestId
        )
        if existing:
            require_operation(existing, "raster.aggregate.v1")
            if existing.get("request_hash") != request_hash:
                raise ProcessingError(
                    "request_conflict",
                    "That request ID has different calculation inputs.",
                    409,
                )
        else:
            submission = await self.build_calculation_submission(
                owner, request, {}, request_hash
            )
            if isinstance(submission.prepared, ProcessingError):
                raise submission.prepared
        if existing:
            row = existing
        else:
            row = await self._submit_job(
                owner,
                request.requestId,
                submission.prepared,
                request_hash,
                get_model_operation("raster.aggregate.v1").vector_selections(request),
                upload_owner,
            )
        return (
            await self._observe_submitted_calculations(
                owner, [serialize_processing_job(row)]
            )
        )[0]

    async def build_calculation_submission(
        self,
        owner: str,
        request: AggregateJobRequest,
        polygon_inputs: dict[PolygonAreaReference, AggregateArea | ProcessingError],
        request_hash: str | None = None,
    ) -> JobSubmission:
        """Capture validated inputs and resolve each owned polygon reference once.

        Args:
            owner: Current session hash.
            request: Already validated calculation request.
            polygon_inputs: Request-local resolution results for repeated areas.
            request_hash: Previously computed request identity for single-request recovery.

        Returns:
            Storage admission data, or a resolution error carried with its retry
            identity so a previously accepted request can still be recovered.

        Raises:
            ValueError: If persisted polygon input violates its storage contract.
        """
        request_hash = (
            request_hash
            or hashlib.sha256(
                json.dumps(
                    request.model_dump(
                        mode="json", by_alias=True, exclude={"requestId"}
                    ),
                    sort_keys=True,
                ).encode()
            ).hexdigest()
        )
        polygons = None
        if request.polygonArea:
            reference = request.polygonArea
            if reference not in polygon_inputs:
                try:
                    polygon_inputs[reference] = await self.read_polygon_area(
                        owner, reference
                    )
                except ProcessingError as error:
                    polygon_inputs[reference] = error
            polygons = polygon_inputs[reference]
            if isinstance(polygons, ProcessingError):
                return JobSubmission(
                    request.requestId, request_hash, "raster.aggregate.v1", polygons
                )
        operation = get_model_operation("raster.aggregate.v1")
        prepared = operation.queue(request, polygons)
        try:
            prepared = await self.capture_input_file(
                owner, operation.source(request), prepared
            )
        except ProcessingError as error:
            return JobSubmission(request.requestId, request_hash, operation.id, error)
        return JobSubmission(request.requestId, request_hash, operation.id, prepared)

    async def submit_calculation_batch(
        self,
        owner: str,
        requests: list[AggregateJobRequest],
        upload_owner: str | None = None,
    ) -> list[dict[str, Any] | ProcessingError]:
        """Submit independent calculations through one store admission transaction.

        Args:
            owner: Current browser-session hash.
            requests: One to fifty requests validated at the HTTP boundary.
            upload_owner: Browser identity authorizing uploaded summary areas.

        Returns:
            Public job snapshots or sanitized per-item rejections, in input order.
            Workers prepare and execute accepted jobs after admission commits.
            Observe accepted work within one submission budget before returning
            the same snapshots used by ordinary status reads.

        Raises:
            ProcessingError: If the shared admission transaction is unavailable.
        """
        polygon_inputs: dict[PolygonAreaReference, AggregateArea | ProcessingError] = {}
        submissions = [
            await self.build_calculation_submission(owner, request, polygon_inputs)
            for request in requests
        ]
        operation = get_model_operation("raster.aggregate.v1")
        selections = [operation.vector_selections(request) for request in requests]
        if any(
            isinstance(selection, UploadedSelection)
            for inputs in selections
            for selection in inputs.values()
        ):
            results = await self._submit_jobs_with_uploaded_inputs(
                owner, submissions, selections, upload_owner
            )
        else:
            results = await asyncio.to_thread(
                self.jobs.submit_batch, owner, submissions
            )
        return await self._observe_submitted_calculations(
            owner,
            [
                (
                    result
                    if isinstance(result, ProcessingError)
                    else serialize_processing_job(result)
                )
                for result in results
            ],
        )

    async def _observe_submitted_calculations(
        self, owner: str, outcomes: list[dict[str, Any] | ProcessingError]
    ) -> list[dict[str, Any] | ProcessingError]:
        """Observe committed jobs within one deadline, preserving admission outcomes.

        Subscribe before reading owned state so a completion between admission
        and registration is recovered by that read. Hints prompt fresh snapshots;
        a final deadline read also recovers missed hints. No transaction or result
        payload is retained by the subscription. Unavailable observation preserves
        accepted snapshots for the normal browser status/retry flow.

        Args:
            owner: Session hash that admitted the calculations.
            outcomes: Public accepted jobs and independent admission errors.

        Returns:
            Latest owned snapshots and original errors in admission order. Ready
            results and unfinished jobs retain the existing response contract.

        Raises:
            asyncio.CancelledError: After releasing subscription capacity; committed
                jobs remain recoverable through their original request keys.
        """
        active = {"queued", "running", "cancelling"}
        snapshots = {
            outcome["jobId"]: outcome
            for outcome in outcomes
            if isinstance(outcome, dict)
        }
        identifiers = [key for key, job in snapshots.items() if job["status"] in active]
        if not identifiers or not self.submission_wait_seconds:
            return outcomes
        try:
            subscription = await self.subscribe_jobs(owner)
        except ProcessingError:
            return outcomes
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.submission_wait_seconds
        try:
            while True:
                status = await self.read_job_statuses(owner, identifiers)
                snapshots.update({job["jobId"]: job for job in status["jobs"]})
                if all(snapshots[key]["status"] not in active for key in identifiers):
                    break
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                await subscription.wait(remaining)
        except ProcessingError:
            pass
        finally:
            subscription.close()
        return [
            snapshots[outcome["jobId"]] if isinstance(outcome, dict) else outcome
            for outcome in outcomes
        ]

    async def get(self, owner: str, identifier: str) -> dict[str, Any]:
        """Read one owner's public job state.

        Args:
            owner: Current session hash.
            identifier: Opaque job ID.

        Returns:
            Public lifecycle and ready download links.
        """
        row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        return serialize_processing_job(row)

    async def list_owned(self, owner: str) -> list[dict[str, Any]]:
        """Recover bounded recent jobs for the current browser session.

        Args:
            owner: Current session hash.

        Returns:
            At most 50 public job summaries, newest first.
        """
        rows = await asyncio.to_thread(
            self.jobs.list_owned, owner, ("raster.clip.v1", "raster.aggregate.v1")
        )
        return [serialize_processing_job(row) for row in rows]

    async def read_job_statuses(
        self, owner: str, identifiers: list[str]
    ) -> dict[str, Any]:
        """Return requested job statuses without reading unrelated job history.

        Args:
            owner: Current session hash.
            identifiers: Validated public job IDs, at most 100.

        Returns:
            Public jobs and unavailable IDs, each in request order with duplicates
            removed. Foreign and nonexistent IDs are indistinguishable.
        """
        rows = await asyncio.to_thread(self.jobs.read_owned_jobs, owner, identifiers)
        by_id = {row["id"]: row for row in rows}
        requested = list(dict.fromkeys(identifiers))
        return {
            "jobs": [
                serialize_processing_job(by_id[value])
                for value in requested
                if value in by_id
            ],
            "unavailableJobIds": [value for value in requested if value not in by_id],
        }

    async def renew_model_run(self, owner: str, identifier: str) -> dict[str, Any]:
        """Keep a completed model run and its files for at least another seven days.

        Args:
            owner: Hash of the requesting browser session.
            identifier: Owned model run's public job ID.

        Returns:
            Updated run state, with later existing expiry dates preserved.

        Raises:
            ProcessingError: If the run is unavailable, expired, or not a model run.
        """
        row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        require_operation(row, MODEL_OPERATION)
        return serialize_processing_job(
            await asyncio.to_thread(
                self.jobs.extend_result_lifetime,
                identifier,
                owner,
                MODEL_RUN_RETENTION_SECONDS,
            )
        )

    async def cancel(
        self, owner: str, identifier: str, delete: bool = False, undo: bool = False
    ) -> dict[str, Any]:
        """Request explicit cancellation or remove a terminal job's result.

        Args:
            owner: Current session hash.
            identifier: Owned opaque job ID.
            delete: Revoke a terminal result rather than cancel active work.
            undo: Offer thirty seconds to undo a model run deletion.

        Returns:
            Updated public state; running cancellation completes after child exit.

        Raises:
            ProcessingError: If ownership, job kind or lifecycle rejects the action.
        """
        if undo:
            require_operation(
                await asyncio.to_thread(self.jobs.get, identifier, owner),
                MODEL_OPERATION,
            )
        return serialize_processing_job(
            await asyncio.to_thread(
                self.jobs.cancel,
                identifier,
                owner,
                delete,
                MODEL_DELETION_UNDO_SECONDS if undo else 0,
            )
        )

    async def resolve_model_deletion(
        self, owner: str, identifier: str, deletion_id: str, restore: bool
    ) -> dict[str, Any]:
        """Undo or dismiss the requesting browser's exact model run deletion.

        Args:
            owner: Hash of the browser session.
            identifier: Owned model run ID.
            deletion_id: Identity captured by the original delete action.
            restore: Undo the deletion when true; end its Undo window otherwise.

        Returns:
            Updated public model run, without extending its original expiry.

        Raises:
            ProcessingError: If the run, deletion or Undo window is unavailable.
        """
        require_operation(
            await asyncio.to_thread(self.jobs.get, identifier, owner), MODEL_OPERATION
        )
        return serialize_processing_job(
            await asyncio.to_thread(
                self.jobs.resolve_deletion,
                identifier,
                owner,
                deletion_id,
                restore,
            )
        )

    async def download(
        self, owner: str, identifier: str, provenance: bool = False
    ) -> ArtifactDownload:
        """Authorize a finished artifact and acquire its transfer lifetime.

        Args:
            owner: Current session hash.
            identifier: Owned job ID.
            provenance: Download JSON provenance instead of the result file.

        Returns:
            Confined file, response metadata and transfer lease. Summary CSV/JSON
            also carries small replacement bytes using this caller's formula labels.

        Raises:
            ProcessingError: If unavailable, expired, or transfer capacity is full.
        """
        row, lease = await asyncio.to_thread(
            self.jobs.acquire_transfer, identifier, owner
        )
        try:
            artifact = row["artifact"]
            path = await asyncio.to_thread(
                self.artifacts.result_path,
                row["attempt_id"],
                provenance,
                result_name=artifact.get("result_name", "result.tif"),
            )
            if provenance:
                data = await asyncio.to_thread(path.read_bytes)
                size = len(data)
                sha256 = hashlib.sha256(data).hexdigest()
                filename = str(PurePath(artifact["filename"]).with_suffix(".json"))
                media_type = "application/json"
            else:
                size, sha256, filename = (
                    artifact["size"],
                    artifact["sha256"],
                    artifact["filename"],
                )
                media_type = artifact["media_type"]
            content = None
            if row.get("presentation") and row["operation"] != MODEL_OPERATION:
                rows = present_calculation_rows(artifact["rows"], row["presentation"])
                content = statistics_csv(rows)
                if provenance:
                    document = json.loads(data)
                    document.update(row["presentation"])
                    if document.get("cachedRows") is not None:
                        document["cachedRows"] = present_calculation_rows(
                            document["cachedRows"], row["presentation"]
                        )
                    document.update(
                        rows=rows,
                        size=len(content),
                        sha256=hashlib.sha256(content).hexdigest(),
                    )
                    content = json.dumps(document, allow_nan=False).encode("utf-8")
                size = len(content)
                sha256 = hashlib.sha256(content).hexdigest()
            if row["operation"] == MODEL_OPERATION:
                output_name = (
                    "provenance" if provenance else row["summary"]["output"]["name"]
                )
                filename = build_model_download_filename(
                    row, output_name, filename, media_type
                )
            return ArtifactDownload(
                path, filename, size, sha256, lease, media_type, content
            )
        except BaseException:
            await asyncio.to_thread(self.jobs.transfer_heartbeat, lease, True)
            raise

    async def list_model_artifacts(self, owner: str, identifier: str) -> dict[str, Any]:
        """List complete retained files belonging to this browser session's run.

        Args:
            owner: Current session hash.
            identifier: Public model-run ID.

        Returns:
            File metadata and availability, without private filesystem information.

        Raises:
            ProcessingError: If the model run is unavailable to this session.
            ValidationError: If persisted file metadata is malformed.
        """
        row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        require_operation(row, MODEL_OPERATION)
        return serialize_model_artifacts(row)

    async def download_model_artifact(
        self, owner: str, identifier: str, artifact_id: str
    ) -> ArtifactDownload:
        """Authorize one run file and retain all its files until transfer finishes.

        Args:
            owner: Current session hash.
            identifier: Public model-run ID.
            artifact_id: Opaque file ID from this run's manifest.

        Returns:
            Confined file and renewable transfer lease for the existing response.

        Raises:
            ProcessingError: If ownership, expiry, file identity or availability checks fail.
            ValidationError: If the persisted manifest is malformed.
        """
        row, lease = await asyncio.to_thread(
            self.jobs.acquire_transfer, identifier, owner
        )
        try:
            require_operation(row, MODEL_OPERATION)
            stored = row["artifact"].get("manifest")
            manifest = read_artifact_manifest(stored) if stored else None
            file = (
                next((item for item in manifest.files if item.id == artifact_id), None)
                if manifest
                else None
            )
            if file is None:
                raise ProcessingError(
                    "artifact_not_found", "This result file is unavailable.", 404
                )
            path = await asyncio.to_thread(
                self.artifacts.artifact_path, row["attempt_id"], file.storage_name
            )
            return ArtifactDownload(
                path,
                build_model_download_filename(
                    row, file.name, file.filename, file.media_type
                ),
                file.size,
                file.sha256,
                lease,
                file.media_type,
            )
        except BaseException:
            await asyncio.to_thread(self.jobs.transfer_heartbeat, lease, True)
            raise

    async def model_artifact_is_available(
        self, identifier: str, artifact_id: str
    ) -> bool:
        """Check output lifetime for internal publication cleanup, without granting access.

        Args:
            identifier: Opaque run handle recorded by the application.
            artifact_id: Opaque file identity from a registered publication.

        Returns:
            Whether the ready run still offers this original file.

        Raises:
            ProcessingError: If storage is unavailable; cleanup must retry.
            ValidationError: If persisted file metadata is malformed.
        """
        row = await asyncio.to_thread(self.jobs.available_result, identifier)
        if row is None:
            return False
        require_operation(row, MODEL_OPERATION)
        stored = (row.get("artifact") or {}).get("manifest")
        return bool(
            stored
            and any(
                file.id == artifact_id for file in read_artifact_manifest(stored).files
            )
        )

    async def resolve_model_artifact(
        self, owner: str, identifier: str, artifact_id: str
    ) -> ResolvedSourceFile:
        """Resolve an owned, unexpired output for a short original-file read.

        Published outputs are immutable and the API mounts their storage read-only.
        No transfer lease or full-file checksum is needed for an interactive read;
        callers handle a missing file if cleanup runs after this check.

        Args:
            owner: Server-derived session hash.
            identifier: Opaque model-run identity.
            artifact_id: Opaque published file identity.

        Returns:
            Confined original file and its publication metadata.

        Raises:
            ProcessingError: If ownership, expiry, format or availability fails.
            ValidationError: If persisted file metadata is invalid.
        """
        row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        require_operation(row, MODEL_OPERATION)
        if serialize_model_artifacts(row)["availability"] != "available":
            raise ProcessingError(
                "result_unavailable", "This result is no longer available.", 409
            )
        manifest = read_artifact_manifest(row["artifact"]["manifest"])
        file = next((file for file in manifest.files if file.id == artifact_id), None)
        if file is None:
            raise ProcessingError(
                "artifact_not_found", "This result file is unavailable.", 404
            )
        path = await asyncio.to_thread(
            self.artifacts.artifact_path, row["attempt_id"], file.storage_name
        )
        return ResolvedSourceFile(path, file.size, file.sha256, file.media_type)

    async def check_model_artifact(
        self, owner: str, identifier: str, artifact_id: str
    ) -> None:
        """Recheck a retained file's ownership and availability before delivery.

        This does not acquire another transfer slot or authorize a new filesystem
        read. Callers already holding a lease use it before delivering a result.

        Args:
            owner: Server-derived session hash.
            identifier: Opaque run identity.
            artifact_id: Opaque published file identity.

        Raises:
            ProcessingError: If the session, run or file is no longer available.
            ValidationError: If persisted file metadata is malformed.
        """
        manifest = await self.list_model_artifacts(owner, identifier)
        if manifest["availability"] != "available":
            raise ProcessingError(
                "result_unavailable", "This result is no longer available.", 409
            )
        file = next(
            (file for file in manifest["files"] if file["artifactId"] == artifact_id),
            None,
        )
        if file is None:
            raise ProcessingError(
                "artifact_not_found", "This result file is unavailable.", 404
            )

    async def transfer_heartbeat(self, lease: str, release: bool = False) -> bool:
        """Renew or release a response-owned download lease.

        Args:
            lease: Opaque transfer capability from download authorization.
            release: Release after the response ends or disconnects.

        Returns:
            Whether the transfer lease existed.
        """
        return await asyncio.to_thread(self.jobs.transfer_heartbeat, lease, release)
