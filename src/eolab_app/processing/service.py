"""Owned processing lifecycle and explicit raster operation commands."""

import asyncio
import hashlib
import json
from datetime import datetime, timezone
from pathlib import PurePath
from typing import Any

from eolab_app.processing.shared_calculations import (
    identify_shared_calculation,
    present_calculation_rows,
)
from eolab_app.processing.statistics_csv import statistics_csv
from eolab_app.processing.request_timings import measure_request_stage
from eolab_app.processing.models import (
    ArtifactDownload,
    PreparedJobPlan,
    JobSubmission,
    ProcessingError,
)
from eolab_app.processing.clip_models import ClipInputs, ClipJobRequest, UnpreparedClip
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateJobRequest,
    UnpreparedCalculation,
)
from eolab_app.processing.polygon_areas import PolygonAreaReference, PolygonSummaryInput
from eolab_app.processing.ports import (
    JobArtifactStore,
    JobStore,
    JobChanges,
    JobSubscription,
)
from eolab_app.raster.models import CatalogRasterRequest


def require_operation(row: dict[str, Any], operation: str) -> None:
    """Keep idempotent retries on their original operation.

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


def public_job(row: dict[str, Any]) -> dict[str, Any]:
    """Project a durable row onto the path-free, owner-safe HTTP result contract.

    Args:
        row: An already-authorized owned job record.

    Returns:
        Public lifecycle, grid, source, and result links without storage metadata.
    """
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
            {"kind": spec["area"]["kind"], "bounds": spec["area"]["bounds"]}
            if spec
            else None
        ),
        "progress": row["progress"],
        "preparation": row.get("preparation"),
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
                        "performance": row["artifact"].get("performance"),
                        "executionTiming": row["artifact"].get("execution_timing"),
                        "queuedToReadySeconds": max(
                            0, (row["updated_at"] - row["created_at"]).total_seconds()
                        ),
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
    """Own job lifecycle and supported operation commands through narrow providers."""

    def __init__(
        self,
        jobs: JobStore,
        artifacts: JobArtifactStore,
        *,
        changes: JobChanges | None = None,
        submission_wait_seconds: float = 0.45,
    ) -> None:
        """Compose job storage and currently supported raster-operation capabilities.

        Args:
            jobs: Durable job and admission adapter.
            artifacts: Confined result-file adapter.
            changes: Lifecycle-managed owned-job notification provider.
            submission_wait_seconds: Observation budget per calculation submission,
                from zero (immediate acknowledgement) to one second. The final
                owned-state read also incurs the ordinary database access latency.

        Raises:
            ValueError: If the submission observation budget is outside its bounds.
        """
        if not 0 <= submission_wait_seconds <= 1:
            raise ValueError("Submission wait must be between zero and one second")
        self.jobs = jobs
        self.artifacts = artifacts
        self.changes = changes
        self.submission_wait_seconds = submission_wait_seconds

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
        self, owner: str, request: ClipJobRequest
    ) -> dict[str, Any]:
        """Join identical active clipping work or queue a clip with its complete inputs.

        Args:
            owner: Current browser-session hash.
            request: Catalog raster, explicit area and stable submission key.

        Returns:
            The caller's handle for shared/new work, or the same handle on retry.

        Raises:
            ProcessingError: If the retry changes inputs or admission is full.
        """
        inputs = ClipInputs.model_validate(
            request.model_dump(exclude={"requestId"}, by_alias=True)
        )
        queued = UnpreparedClip(request=inputs)
        request_hash = hashlib.sha256(
            json.dumps(
                inputs.model_dump(mode="json", by_alias=True), sort_keys=True
            ).encode()
        ).hexdigest()
        source = CatalogRasterRequest(
            collectionId=inputs.collection_id, itemId=inputs.item_id
        )
        bounds = inputs.selectedBounds
        summary = {
            "source": source.model_dump(by_alias=True),
            "grid": None,
            "area": {
                "kind": "bounds" if bounds else "catalogSelection",
                "bounds": bounds.canonical_tuple() if bounds else None,
            },
        }
        with measure_request_stage("queueAdmission"):
            row = await asyncio.to_thread(
                self.jobs.submit,
                owner,
                request.requestId,
                PreparedJobPlan(
                    specification=queued.model_dump(mode="json", by_alias=True),
                    summary=summary,
                    reserved_bytes=0,
                    operation=queued.operation,
                    work_key=identify_shared_calculation(queued),
                ),
                request_hash,
            )
        require_operation(row, queued.operation)
        return public_job(row)

    async def submit_calculation_inputs(
        self, owner: str, request: AggregateJobRequest
    ) -> dict[str, Any]:
        """Join identical active statistics work or queue a calculation with its inputs.

        Args:
            owner: Current browser-session hash.
            request: Validated catalog source, selected area, formulas and stable
                retry key. Direct callers must construct AggregateJobRequest
                through its normal validation, just as the HTTP boundary does.

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
        with measure_request_stage("admissionChecks"):
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
            with measure_request_stage("queueAdmission"):
                row = await asyncio.to_thread(
                    self.jobs.submit,
                    owner,
                    request.requestId,
                    submission.prepared,
                    request_hash,
                )
        return (await self._observe_submitted_calculations(owner, [public_job(row)]))[0]

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
        queued = UnpreparedCalculation(request=request, polygonArea=polygons)
        bounds = request.selectedBounds
        if bounds:
            area_summary = {
                "kind": "bounds",
                "bounds": (bounds.west, bounds.south, bounds.east, bounds.north),
            }
        elif polygons:
            area_summary = {"kind": "polygons", "bounds": polygons.bounds}
        elif request.catalogSelection:
            area_summary = {"kind": "catalogSelection", "bounds": None}
        else:
            area_summary = {"kind": "wholeRaster", "bounds": None}
        summary = {
            "sources": {
                alias: source.model_dump(by_alias=True)
                for alias, source in request.sources.items()
            },
            "calculations": [item.model_dump() for item in request.calculations],
            "grid": None,
            "area": area_summary,
        }
        prepared = PreparedJobPlan(
            specification=queued.model_dump(mode="json", by_alias=True),
            summary=summary,
            reserved_bytes=0,
            operation=queued.operation,
            work_key=identify_shared_calculation(queued),
            presentation={"calculations": summary["calculations"]},
        )
        return JobSubmission(
            request.requestId, request_hash, queued.operation, prepared
        )

    async def submit_calculation_batch(
        self, owner: str, requests: list[AggregateJobRequest]
    ) -> list[dict[str, Any] | ProcessingError]:
        """Submit independent calculations through one store admission transaction.

        Args:
            owner: Current browser-session hash.
            requests: One to fifty requests validated at the HTTP boundary.

        Returns:
            Public job snapshots or sanitized per-item rejections, in input order.
            Workers prepare and execute accepted jobs after admission commits.
            Observe accepted work within one submission budget before returning
            the same snapshots used by ordinary status reads.

        Raises:
            ProcessingError: If the shared admission transaction is unavailable.
        """
        polygon_inputs: dict[PolygonAreaReference, AggregateArea | ProcessingError] = {}
        with measure_request_stage("admissionChecks"):
            submissions = [
                await self.build_calculation_submission(owner, request, polygon_inputs)
                for request in requests
            ]
        with measure_request_stage("queueAdmission"):
            results = await asyncio.to_thread(
                self.jobs.submit_batch, owner, submissions
            )
        return await self._observe_submitted_calculations(
            owner,
            [
                result if isinstance(result, ProcessingError) else public_job(result)
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
            with measure_request_stage("submissionObservation"):
                while True:
                    status = await self.read_job_statuses(owner, identifiers)
                    snapshots.update({job["jobId"]: job for job in status["jobs"]})
                    if all(
                        snapshots[key]["status"] not in active for key in identifiers
                    ):
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
        with measure_request_stage("jobRead"):
            row = await asyncio.to_thread(self.jobs.get, identifier, owner)
        return public_job(row)

    async def list_owned(self, owner: str) -> list[dict[str, Any]]:
        """Recover bounded recent jobs for the current browser session.

        Args:
            owner: Current session hash.

        Returns:
            At most 50 public job summaries, newest first.
        """
        with measure_request_stage("jobRead"):
            rows = await asyncio.to_thread(self.jobs.list_owned, owner)
        return [public_job(row) for row in rows]

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
        with measure_request_stage("jobRead"):
            rows = await asyncio.to_thread(
                self.jobs.read_owned_jobs, owner, identifiers
            )
        by_id = {row["id"]: row for row in rows}
        requested = list(dict.fromkeys(identifiers))
        return {
            "jobs": [public_job(by_id[value]) for value in requested if value in by_id],
            "unavailableJobIds": [value for value in requested if value not in by_id],
        }

    async def cancel(
        self, owner: str, identifier: str, delete: bool = False
    ) -> dict[str, Any]:
        """Request explicit cancellation or remove a terminal job's result.

        Args:
            owner: Current session hash.
            identifier: Owned opaque job ID.
            delete: Revoke a terminal result rather than cancel active work.

        Returns:
            Updated public state; running cancellation completes after child exit.
        """
        return public_job(
            await asyncio.to_thread(self.jobs.cancel, identifier, owner, delete)
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
                # Results created before media types were recorded were all
                # raster clips; preserve their existing download content type.
                media_type = artifact.get("media_type", "image/tiff")
                if path.stat().st_size != size:
                    raise ProcessingError(
                        "result_changed",
                        "This result file is no longer intact. Submit a new job.",
                        410,
                    )
            content = None
            if row.get("presentation"):
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
            return ArtifactDownload(
                path, filename, size, sha256, lease, media_type, content
            )
        except BaseException:
            await asyncio.to_thread(self.jobs.transfer_heartbeat, lease, True)
            raise

    async def transfer_heartbeat(self, lease: str, release: bool = False) -> bool:
        """Renew or release a response-owned download lease.

        Args:
            lease: Opaque transfer capability from download authorization.
            release: Release after the response ends or disconnects.

        Returns:
            Whether the transfer lease existed.
        """
        return await asyncio.to_thread(self.jobs.transfer_heartbeat, lease, release)
