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
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.clip_models import ClipSpec, RasterClipLimits
from eolab_app.processing.aggregate_models import (
    AggregateSpec,
    RasterAggregateLimits,
    AggregateExecutionTiming,
)
from eolab_app.processing.raster_aggregate import aggregate_process_target
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
        """
        self.areas = areas
        self.authorizer = authorizer
        self.jobs = jobs
        self.artifacts = artifacts
        self.limits = limits
        self.native = native
        self.aggregate_limits = RasterAggregateLimits.with_lifecycle(limits)

    async def _execute(self, row: dict[str, Any]) -> Any:
        """Authorize, run a native child, and publish only a validated result.

        Args:
            row: Job claimed with a unique execution fencing token.

        Returns:
            Validated artifact metadata after an atomic filesystem rename.

        Raises:
            ProcessingError: If the source, resources, or native operation fail.
        """
        started = time.perf_counter()
        operation = row["spec"]["operation"]
        if operation == "raster.clip.v1":
            spec = ClipSpec.model_validate(row["spec"])
            source = spec.source
            target, action, limits = clip_process_target, "clip", self.limits
        elif operation == "raster.aggregate.v1":
            spec = AggregateSpec.model_validate(row["spec"])
            required_disk_bytes = estimate_calculation_disk_bytes(
                spec, self.aggregate_limits
            )
            # Queued jobs survive deployments and retain their original disk
            # reservation. Compare it with the files this worker will create.
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
        authorized = await self.authorizer.authorize(source)
        directory = await asyncio.to_thread(
            self.artifacts.prepare,
            row["attempt_id"],
            row["reserved_bytes"],
            self.limits,
        )
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
        row = await asyncio.to_thread(self.jobs.claim)
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
                finished = await asyncio.to_thread(
                    self.jobs.finish, identifier, attempt, artifact
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
                    "detail": "The catalog source is unavailable or changed. Create a new plan after checking the layer.",
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


async def serve(worker: ProcessingWorker, wakeup: JobWakeup | None = None) -> None:
    """Consume the queue using dependencies supplied by application composition.

    Args:
        worker: Composed worker with migrated storage and confined artifact paths.
        wakeup: Optional queue-change hints; durable claims remain authoritative.

    Raises:
        asyncio.CancelledError: After stopping active native work on shutdown.
    """
    try:
        while True:
            try:
                if wakeup is not None:
                    await wakeup.arm()
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
