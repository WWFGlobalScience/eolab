"""Application workflow and supervision for explicitly supported processing jobs."""

from eolab_app.catalog_selection import (
    CatalogSelectionReader,
    SelectionUnavailableError,
)
import asyncio
from dataclasses import asdict, replace
from contextlib import suppress
import logging
import time
from typing import Any

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
)
from eolab_app.execution.reusable_process import ReusableProcess, run_process
from eolab_app.processing.models import Artifact, ProcessingError
from eolab_app.processing.clip_models import (
    ClipArea,
    ClipSpec,
    UnpreparedClip,
    RasterClipLimits,
)
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateSpec,
    UnpreparedCalculation,
    RasterAggregateLimits,
    AggregateExecutionTiming,
)
from eolab_app.processing.raster_aggregate import (
    aggregate_process_target,
    write_statistics_result,
)
from eolab_app.processing.calculation_cache import (
    calculation_result_cache_keys,
    restore_cached_calculation_rows,
    prepare_calculation_values_for_cache,
    restore_cached_calculation_plan,
)
from eolab_app.processing.job_preparation import prepare_aggregate_job, prepare_clip_job
from eolab_app.raster.models import AuthorizedRaster, CatalogRasterRequest
from eolab_app.bounded_vector import summary_process, READ_SECONDS
from eolab_app.processing.raster_mask import estimate_calculation_disk_bytes
from eolab_app.processing.ports import JobArtifactStore, JobStore, JobWakeup
from eolab_app.processing.raster_clip import clip_process_target
from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.ports import RasterSourceAuthorizer

LOGGER = logging.getLogger(__name__)


class ProcessingWorker:
    """Own one attempt's workflow without teaching storage about application services."""

    def __init__(
        self,
        authorizer: RasterSourceAuthorizer,
        jobs: JobStore,
        artifacts: JobArtifactStore,
        limits: RasterClipLimits,
        *,
        native: ReusableProcess | None = None,
        areas: CatalogSelectionReader | None = None,
    ) -> None:
        """Compose the worker's narrow capabilities.

        Args:
            authorizer: Independent catalog source authorization.
            jobs: Durable global admission and attempt fencing.
            artifacts: Confined scratch and atomic result-file storage.
            limits: Deployment-wide bounded processing policy.
            native: Lifecycle-managed execution lane supplied by composition.
            areas: Catalog vector reader used to resolve filtered calculation areas.
        """
        self.areas = areas
        self.authorizer = authorizer
        self.jobs = jobs
        self.artifacts = artifacts
        self.limits = limits
        self.native = native
        self.aggregate_limits = RasterAggregateLimits.with_lifecycle(limits)

    async def _prepare_calculation(self, row: dict[str, Any]) -> AuthorizedRaster:
        """Prepare queued summary inputs and publish their estimates on the same job.

        Args:
            row: Claimed job, updated in place with its prepared inputs and reservation.

        Returns:
            Source resolved for this attempt, reusable by immediate execution.
            It is not persisted; a job returned to the queue resolves it again
            when a later attempt executes the stored plan.

        Raises:
            ProcessingError: For unavailable sources, rejected resource estimates,
                cancellation or insufficient storage.
            TimeoutError: If preparation exceeds its separate time limit.
        """
        started = time.perf_counter()
        queued = UnpreparedCalculation.model_validate(row["spec"])
        request = queued.request
        async with asyncio.timeout(self.limits.plan_timeout_seconds):
            alive = await asyncio.to_thread(
                self.jobs.heartbeat,
                row["id"],
                row["attempt_id"],
                {"phase": "preparing"},
            )
            if not alive:
                raise ProcessingError(
                    "job_cancelled", "Calculation stopped before preparation.", 409
                )
            alias, source = next(iter(request.sources.items()))
            authorized = await self.authorizer.authorize(source)
            signature = tuple(authorized.source_signature.to_catalog())
            resolved = None
            if request.catalogSelection:
                if self.areas is None:
                    raise ProcessingError(
                        "selection_unavailable",
                        "Vector selection reader is unavailable.",
                        409,
                    )
                resolved = await self.areas.resolve_for_sampling(
                    request.catalogSelection
                )
            cached = await asyncio.to_thread(
                self.jobs.get_cached_calculation_results,
                calculation_result_cache_keys(request, signature),
            )
            spec = restore_cached_calculation_plan(
                request, signature, cached, queued.polygonArea
            )
            outcome = None
            if spec is None:
                if queued.polygonArea:
                    area = queued.polygonArea
                elif request.wholeRaster:
                    area = AggregateArea(kind="wholeRaster")
                elif request.selectedBounds:
                    bounds = request.selectedBounds
                    area = AggregateArea(
                        kind="bounds",
                        bounds=(bounds.west, bounds.south, bounds.east, bounds.north),
                    )
                else:
                    measured = await run_process(
                        summary_process, (resolved,), READ_SECONDS, self.native
                    )
                    success, summary = measured.value
                    if not success:
                        raise ProcessingError("selection_unavailable", summary, 409)
                    area = AggregateArea(
                        kind="catalogSelection",
                        bounds=summary["bbox"],
                        catalogSelection=request.catalogSelection,
                        resolved=resolved,
                    )
                outcome = await run_process(
                    aggregate_process_target,
                    (
                        "plan",
                        (
                            authorized.source_path,
                            area,
                            request.calculations,
                            alias,
                            self.aggregate_limits,
                            request.targetChunkPixels,
                        ),
                    ),
                    self.limits.plan_timeout_seconds,
                    self.native,
                )
                status, grid = outcome.value
                if status != "ok":
                    raise ProcessingError(*grid)
                if resolved is not None:
                    await self.areas.resolve_for_sampling(request.catalogSelection)
                spec = AggregateSpec(
                    sources=request.sources,
                    sourceSignature=signature,
                    calculations=request.calculations,
                    area=area,
                    grid=grid,
                )
            updated = await asyncio.to_thread(
                self.jobs.save_prepared_job,
                row["id"],
                row["attempt_id"],
                prepare_aggregate_job(spec, self.aggregate_limits),
                {
                    "seconds": time.perf_counter() - started,
                    "cacheHit": spec.cachedRows is not None,
                    "process": (
                        asdict(outcome.timing) if outcome and outcome.timing else None
                    ),
                },
            )
            # Preserve the original execution start used for queue timing.
            updated["updated_at"] = row["updated_at"]
            row.update(updated)
            return authorized

    async def _prepare_clip(self, row: dict[str, Any]) -> None:
        """Measure a queued clip and reserve its output storage on the same job.

        Args:
            row: Claimed job, updated with the grid and selected area after preparation.

        Raises:
            ProcessingError: If the source, area, storage or attempt is unavailable.
            TimeoutError: If source inspection exceeds its time limit.
        """
        started = time.perf_counter()
        request = UnpreparedClip.model_validate(row["spec"]).request
        async with asyncio.timeout(self.limits.plan_timeout_seconds):
            if not await asyncio.to_thread(
                self.jobs.heartbeat,
                row["id"],
                row["attempt_id"],
                {"phase": "preparing"},
            ):
                raise ProcessingError(
                    "job_cancelled", "Clip stopped before preparation.", 409
                )
            source = CatalogRasterRequest(
                collectionId=request.collection_id, itemId=request.item_id
            )
            authorized = await self.authorizer.authorize(source)
            if request.selectedBounds:
                area = ClipArea(
                    kind="bounds", bounds=request.selectedBounds.canonical_tuple()
                )
            else:
                if self.areas is None:
                    raise ProcessingError(
                        "selection_unavailable",
                        "Vector selection reader is unavailable.",
                        409,
                    )
                resolved = await self.areas.resolve_for_sampling(
                    request.catalogSelection
                )
                measured = await run_process(
                    summary_process, (resolved,), READ_SECONDS, self.native
                )
                success, summary = measured.value
                if not success:
                    raise ProcessingError("selection_unavailable", summary, 409)
                area = ClipArea(
                    kind="catalogSelection",
                    bounds=summary["bbox"],
                    catalogSelection=request.catalogSelection,
                    resolved=resolved,
                )
            outcome = await run_process(
                clip_process_target,
                ("plan", (authorized.source_path, area, self.limits)),
                self.limits.plan_timeout_seconds,
                self.native,
            )
            status, grid = outcome.value
            if status != "ok":
                raise ProcessingError(*grid)
            if request.catalogSelection:
                await self.areas.resolve_for_sampling(request.catalogSelection)
            spec = ClipSpec(
                source=source,
                sourceSignature=tuple(authorized.source_signature.to_catalog()),
                area=area,
                grid=grid,
            )
            updated = await asyncio.to_thread(
                self.jobs.save_prepared_job,
                row["id"],
                row["attempt_id"],
                prepare_clip_job(spec),
                {"seconds": time.perf_counter() - started},
            )
            updated["updated_at"] = row["updated_at"]
            row.update(updated)

    async def _execute(self, row: dict[str, Any]) -> Artifact | None:
        """Authorize the inputs, reuse or calculate values, and publish result files.

        Args:
            row: Job claimed with a unique execution fencing token.

        Returns:
            Result-file metadata, or None after preparation returns the job to
            the existing queue until its disk reservation fits. Successful calculations
            include disjoint preparation intervals measured by this worker.

        Raises:
            ProcessingError: If the source, resources, or native operation fail.
        """
        started = time.perf_counter()
        operation = row["spec"]["operation"]
        authorized = None
        if operation == "raster.aggregate.v1" and "request" in row["spec"]:
            authorized = await self._prepare_calculation(row)
        elif operation == "raster.clip.v1" and "request" in row["spec"]:
            await self._prepare_clip(row)
        preparation_completed = time.perf_counter()
        if row["status"] == "queued":
            return None
        if operation == "raster.clip.v1":
            spec = ClipSpec.model_validate(row["spec"])
            source = spec.source
            target, action, limits = clip_process_target, "clip", self.limits
        elif operation == "raster.aggregate.v1":
            spec = AggregateSpec.model_validate(row["spec"])
            required_disk_bytes = estimate_calculation_disk_bytes(
                spec, self.aggregate_limits
            )
            # Keep execution within the reservation established during preparation.
            if row["reserved_bytes"] < required_disk_bytes:
                raise ProcessingError(
                    "insufficient_disk_reservation",
                    "This job reserved less disk space than its calculation now requires. "
                    "Run the calculation again to reserve enough space.",
                    409,
                )
            source = next(iter(spec.sources.values()))
            target, action, limits = (
                aggregate_process_target,
                "calculate",
                self.aggregate_limits,
            )
        else:
            raise ProcessingError(
                "unsupported_operation",
                "This worker does not support the requested operation.",
                422,
            )
        resolved_area = None
        if spec.area.kind == "catalogSelection":
            if self.areas is None:
                raise ProcessingError(
                    "selection_unavailable",
                    "Catalog selection reader is unavailable.",
                    409,
                )
            resolved_area = await self.areas.resolve_for_sampling(
                spec.area.catalogSelection
            )
            spec = spec.model_copy(
                update={
                    "area": spec.area.model_copy(update={"resolved": resolved_area})
                }
            )
        if authorized is None:
            authorized = await self.authorizer.authorize(source)
        sources_authorized = time.perf_counter()
        directory = await asyncio.to_thread(
            self.artifacts.prepare,
            row["attempt_id"],
            row["reserved_bytes"],
            self.limits,
        )
        scratch_prepared = time.perf_counter()
        if operation == "raster.aggregate.v1":
            if spec.cachedRows is not None:
                cached_rows = [row.model_dump(mode="json") for row in spec.cachedRows]
            else:
                cached = await asyncio.to_thread(
                    self.jobs.get_cached_calculation_results,
                    calculation_result_cache_keys(spec),
                )
                cached_rows = restore_cached_calculation_rows(spec, cached)
            if cached_rows is not None:
                # These tiny writes stay synchronous so cancellation cannot race
                # a background writer against attempt-directory cleanup.
                value = write_statistics_result(
                    spec, cached_rows, directory, cache_hit=True
                )
                if resolved_area is not None:
                    await self.areas.resolve_for_sampling(resolved_area.selection)
                self.artifacts.publish(row["attempt_id"], row["reserved_bytes"])
                return value
        prepared = time.perf_counter()
        outcome = await run_process(
            target,
            (action, (authorized.source_path, spec, directory, limits)),
            self.limits.runtime_seconds,
            self.native,
        )
        status, value = outcome.value
        calculated = time.perf_counter()
        if status != "ok":
            raise ProcessingError(*value)
        if resolved_area is not None:
            await self.areas.resolve_for_sampling(resolved_area.selection)
        # The heartbeat/fencing check in finish is still required after rename;
        # if cancellation wins the race, this private file is never advertised.
        # This bounded local-directory rename must finish before cancellation
        # can mark the attempt terminal and permit cleanup of its files.
        self.artifacts.publish(row["attempt_id"], row["reserved_bytes"])
        if operation == "raster.aggregate.v1":
            value = replace(
                value,
                execution_timing=AggregateExecutionTiming(
                    queueSeconds=max(
                        0, (row["updated_at"] - row["created_at"]).total_seconds()
                    ),
                    preparationSeconds=prepared - started,
                    planPreparationSeconds=preparation_completed - started,
                    sourceAuthorizationSeconds=sources_authorized
                    - preparation_completed,
                    scratchPreparationSeconds=scratch_prepared - sources_authorized,
                    resultCacheLookupSeconds=prepared - scratch_prepared,
                    nativeProcessSeconds=calculated - prepared,
                    publicationSeconds=time.perf_counter() - calculated,
                    process=asdict(outcome.timing) if outcome.timing else None,
                ).model_dump(),
            )
        return value

    async def run_once(self) -> bool:
        """Claim and fully supervise one attempt, or report that the slot is busy.

        Returns:
            True after handling a claimed job; False when nothing can be claimed.

        Raises:
            ProcessingError: If durable storage is unavailable.
            asyncio.CancelledError: After stopping native work on worker shutdown.
        """
        row = await asyncio.to_thread(self.jobs.claim_next_job)
        if row is None:
            return False
        identifier, attempt = row["id"], row["attempt_id"]
        task = asyncio.create_task(self._execute(row))
        finished = False
        try:
            async with asyncio.timeout(self.limits.runtime_seconds):
                while not task.done():
                    progress = await asyncio.to_thread(self.artifacts.progress, attempt)
                    if not await asyncio.to_thread(
                        self.jobs.heartbeat, identifier, attempt, progress
                    ):
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                        await asyncio.to_thread(
                            self.jobs.finish,
                            identifier,
                            attempt,
                            None,
                            {
                                "code": "interrupted",
                                "detail": "The job was cancelled or its worker lease ended.",
                            },
                        )
                        finished = True
                        return True
                    await asyncio.wait((task,), timeout=2)
                artifact = task.result()
                if artifact is None:
                    # Preparation has stopped and durable storage owns the wait.
                    finished = True
                    return True
                reusable_results = None
                if (
                    row["spec"]["operation"] == "raster.aggregate.v1"
                    and not artifact.cache_hit
                ):
                    reusable_results = prepare_calculation_values_for_cache(
                        AggregateSpec.model_validate(row["spec"]), artifact.rows
                    )
                finished = await asyncio.to_thread(
                    self.jobs.finish,
                    identifier,
                    attempt,
                    artifact,
                    reusable_results=reusable_results,
                )
                if not finished:
                    await asyncio.to_thread(
                        self.jobs.finish,
                        identifier,
                        attempt,
                        None,
                        {
                            "code": "interrupted",
                            "detail": "This job was cancelled before publication.",
                        },
                    )
                    finished = True
        except asyncio.CancelledError:
            raise
        except Exception as error:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if isinstance(error, ProcessingError):
                detail = {"code": error.code, "detail": error.detail}
            elif isinstance(error, (TimeoutError, ProcessDeadlineError)):
                detail = {
                    "code": "time_limit",
                    "detail": "The job exceeded its processing time limit. Choose a smaller area.",
                }
            elif isinstance(error, (RasterFeatureError, SelectionUnavailableError)):
                detail = {
                    "code": "source_unavailable",
                    "detail": "The catalog source is unavailable or changed. Check the layer, then submit the job again.",
                }
            else:
                detail = {
                    "code": "processing_failed",
                    "detail": "The job worker could not complete this operation.",
                }
            # Log no raw source paths, session capabilities, or connection strings.
            LOGGER.warning("Processing job %s failed: %s", identifier, detail["code"])
            finished = await asyncio.to_thread(
                self.jobs.finish, identifier, attempt, None, detail
            )
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if not finished:
                with suppress(ProcessingError):
                    await asyncio.to_thread(
                        self.jobs.finish,
                        identifier,
                        attempt,
                        None,
                        {
                            "code": "interrupted",
                            "detail": "The worker stopped before the job completed. Submit a new job to retry.",
                        },
                    )
        return True

    async def cleanup(self) -> None:
        """Remove terminal files/snapshots only after native and transfer leases end.

        Raises:
            ProcessingError: If storage state cannot be read safely.
            OSError: If filesystem cleanup failed; reservations are then retained.
        """
        for row in await asyncio.to_thread(self.jobs.cleanup_candidates):
            if row["attempt_id"]:
                await asyncio.to_thread(self.artifacts.remove, row["attempt_id"])
            await asyncio.to_thread(self.jobs.cleaned, row["id"])
        retained = await asyncio.to_thread(self.jobs.active_attempts)
        await asyncio.to_thread(
            self.artifacts.remove_orphans, retained, self.limits.runtime_seconds + 30
        )


async def serve(
    worker: ProcessingWorker,
    wakeup: JobWakeup | None = None,
    cleanup_lock: asyncio.Lock | None = None,
) -> None:
    """Consume the queue using dependencies supplied by application composition.

    Args:
        worker: Composed worker with migrated storage and confined artifact paths.
        wakeup: Optional queue-change hints; durable claims remain authoritative.
        cleanup_lock: Shared by loops in the worker container so filesystem
            cleanup and its database acknowledgement cannot overlap.

    Raises:
        asyncio.CancelledError: After stopping active native work on shutdown.
    """
    try:
        while True:
            try:
                if wakeup is not None:
                    await wakeup.arm()
                if cleanup_lock is None:
                    await worker.cleanup()
                else:
                    async with cleanup_lock:
                        await worker.cleanup()
                if not await worker.run_once():
                    if wakeup is None:
                        await asyncio.sleep(2)
                    else:
                        await wakeup.wait(2)
            except (ProcessingError, OSError):
                LOGGER.warning(
                    "Processing worker storage is unavailable; retrying in five seconds"
                )
                await asyncio.sleep(5)
    finally:
        if wakeup is not None:
            await wakeup.close()
