"""Source-authorized application service for bounded raster statistics."""

from eolab_app.catalog_selection import (
    CatalogSelectionReader,
    SelectionUnavailableError,
)
import asyncio
import logging
import math
import threading
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from typing import Any, Protocol, cast

import rasterio
from functools import partial

from eolab_app.polygon_areas import PolygonAreaReference, PolygonSummaryInput
from eolab_app.raster.categorical_statistics import (
    CATEGORICAL_STATISTICS_ALGORITHM,
    categorical_statistics_policy_parameters,
    read_raster_categorical_statistics,
)

from eolab_app.raster.reader import RasterData

from eolab_app.raster.errors import (
    RasterConflictError,
    RasterStatisticsCapacityError,
    RasterStatisticsQueueTimeoutError,
)
from eolab_app.raster.models import (
    CatalogRasterPairRequest,
    CatalogRasterStatisticsRequest,
    CanonicalWgs84Bounds,
    RasterPairedStatistics,
    RasterStatistics,
    RasterStatisticsCacheKey,
)
from eolab_app.raster.paired_statistics import (
    RASTER_PAIRED_STATISTICS_ALGORITHM,
    raster_paired_statistics_policy_parameters,
    read_raster_paired_statistics,
)
from eolab_app.raster.source_access import (
    RasterSourceAccess,
    RasterReadSource,
    read_private_raster,
)
from eolab_app.raster.source_models import (
    RasterStatisticsSourceRequest,
    RasterPairSourceRequest,
    raster_source_reference,
)
from eolab_app.source_files import finish_source_task
from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    RasterReadCancelled,
    require_active_raster_read,
)
from eolab_app.raster.statistics import (
    NoRasterBoundsOverlapError,
    NoValidRasterSamplesError,
    RASTER_STATISTICS_ALGORITHM,
    raster_statistics_policy_parameters,
    read_raster_statistics,
)
from eolab_app.sampling_area import (
    RasterSamplingArea,
    SelectedBoundsSamplingArea,
    SamplingBoxArea,
    CatalogSelectionSamplingArea,
    PolygonInputSamplingArea,
    WholeRasterSamplingArea,
)

_StatisticsResult = RasterStatistics | RasterPairedStatistics


class _CategoricalStatisticsReader(Protocol):
    """A callable that reads raster statistics and estimates areas for category codes."""

    def __call__(
        self,
        data: RasterData,
        sampling_area: RasterSamplingArea,
        cancellation_requested: RasterReadCancellationCheck,
        *,
        category_values: tuple[int, ...],
    ) -> RasterStatistics:
        """Read category coverage with the service's shared cancellation contract.

        Args:
            data: Authorized original file or selected temporal observation.
            sampling_area: Resolved whole-raster, rectangle, geodesic box or polygon selection.
            cancellation_requested: Last-waiter cancellation predicate.
            category_values: Canonically sorted numeric classification codes.

        Returns:
            Numeric statistics and bounded category-area estimates.
        """
        ...


_LOGGER = logging.getLogger(__name__)


@dataclass
class _InflightStatistics:
    """A statistics read shared by callers requesting the same source and area.

    Attributes:
        task: Shared queued or running computation around one Rasterio worker.
        cancellation_requested: Thread-safe last-waiter cancellation signal.
        waiter_count: Active callers awaiting this exact cache identity.
        started: Whether the task acquired bounded read capacity.
        finished: Whether computation completed its cache/error lifecycle.
    """

    task: asyncio.Task[_StatisticsResult]
    cancellation_requested: threading.Event
    waiter_count: int = 0
    started: bool = False
    finished: bool = False


class RasterStatisticsService:
    """Schedule authorized raster statistics reads and share identical requests.

    Distinct computations wait in FIFO order for configured read capacity.
    Callers requesting an identical cache identity share one queued or active read.
    Ordinary and paired completed results share one configured cache budget.
    """

    def __init__(
        self,
        source_access: RasterSourceAccess,
        read_concurrency: int,
        cache_entries: int,
        catalog_selection_reader: CatalogSelectionReader | None = None,
        statistics_reader: Callable[
            [RasterData, RasterSamplingArea, RasterReadCancellationCheck],
            RasterStatistics,
        ] = read_raster_statistics,
        paired_statistics_reader: Callable[
            [
                RasterData,
                RasterData,
                CanonicalWgs84Bounds | None,
                RasterReadCancellationCheck,
            ],
            RasterPairedStatistics,
        ] = read_raster_paired_statistics,
        *,
        polygon_area_reader: (
            Callable[[str, PolygonAreaReference], Awaitable[PolygonSummaryInput]] | None
        ) = None,
        categorical_statistics_reader: _CategoricalStatisticsReader = read_raster_categorical_statistics,
        queue_capacity: int = 32,
        queue_wait_seconds: float = 30,
        max_waiters: int = 256,
    ) -> None:
        """Create a bounded analysis workflow over authorized original rasters.

        Args:
            source_access: Scoped catalog/private source authorization.
            read_concurrency: Maximum simultaneous native raster reads.
            cache_entries: Maximum completed ordinary and paired statistics
                documents retained in one combined cache.
            catalog_selection_reader: Resolves catalog feature selections to
                source files and filters. Required for catalog selection requests.
            statistics_reader: Synchronous bounded native raster reader.
            paired_statistics_reader: Synchronous ordered-pair reader boundary.
            polygon_area_reader: Loads an unexpired temporary polygon input for
                its current browser session. Required for drawn polygon sampling.
            categorical_statistics_reader: Numeric category/area reader sharing
                the same admission, authorization and cancellation lifecycle.
            queue_capacity: Additional distinct reads allowed to wait for a reader.
            queue_wait_seconds: Maximum wait for read capacity, excluding reading.
            max_waiters: Maximum callers awaiting queued or active results,
                including callers sharing the same computation. Cache hits bypass it.

        Raises:
            ValueError: If capacity limits are invalid or the wait is not finite and positive.
        """
        if read_concurrency < 1:
            raise ValueError("Raster statistics concurrency must be positive")
        if cache_entries < 1:
            raise ValueError("Raster statistics cache size must be positive")
        if queue_capacity < 0 or max_waiters < 1:
            raise ValueError(
                "Statistics queue capacity must be nonnegative and max waiters positive"
            )
        if not math.isfinite(queue_wait_seconds) or queue_wait_seconds <= 0:
            raise ValueError("Statistics queue wait must be finite and positive")
        self._source_access = source_access
        self._read_semaphore = asyncio.Semaphore(read_concurrency)
        self._maximum_inflight = read_concurrency + queue_capacity
        self._queue_wait_seconds = queue_wait_seconds
        self._max_waiters = max_waiters
        self._waiter_count = 0
        self._tasks: set[asyncio.Task[_StatisticsResult]] = set()
        self._cache_entries = cache_entries
        self._catalog_selection_reader = catalog_selection_reader
        self._polygon_area_reader = polygon_area_reader
        self._categorical_statistics_reader = categorical_statistics_reader
        self._statistics_reader = statistics_reader
        self._paired_statistics_reader = paired_statistics_reader
        self._cache: OrderedDict[
            tuple[object, ...],
            _StatisticsResult,
        ] = OrderedDict()
        self._inflight: dict[tuple[object, ...], _InflightStatistics] = {}
        self._state_lock = asyncio.Lock()

    async def invalidate_temporal_items(
        self, item_keys: tuple[tuple[str, str], ...]
    ) -> None:
        """Discard statistics using temporal datasets refreshed by a catalog scan.

        The operator refreshes between calculations. Active reads are left alone;
        this method removes completed results without changing source identity.

        Args:
            item_keys: Collection and Item IDs successfully written by the scan.
                Every variable and observation of those temporal datasets is
                affected, including either source in paired statistics.
        """
        refreshed = set(item_keys)
        async with self._state_lock:
            for key in tuple(self._cache):
                identities = key[1:3] if key[0] == "paired" else key[:1]
                if any(
                    identity[0] == "temporal" and identity[1:3] in refreshed
                    for identity in identities
                ):
                    del self._cache[key]

    async def get(
        self,
        request: CatalogRasterStatisticsRequest | RasterStatisticsSourceRequest,
        owner: str | None = None,
        upload_owner: str | None = None,
    ) -> RasterStatistics:
        """Summarize original raster data while retaining its authorized source.

        Args:
            request: Existing catalog request or explicit raster source and area.
            owner: Server-derived session hash for a private raster or polygon area.
            upload_owner: Server-derived browser hash for uploaded polygon selections.

        Returns:
            Counts, ranges, percentiles and a histogram with sampling details.

        Raises:
            RasterFeatureError: If source, area or bounded reading is unavailable.
            SourceFileError: If private file access changes before delivery.
            VectorUploadError: If the polygon upload is unavailable to this browser.
        """
        async with self._source_access.open(
            raster_source_reference(request), owner
        ) as source:
            return await self._get_authorized_statistics(
                request, source, owner, upload_owner
            )

    async def _get_authorized_statistics(
        self,
        request: CatalogRasterStatisticsRequest | RasterStatisticsSourceRequest,
        authorized_raster: RasterReadSource,
        owner: str | None,
        upload_owner: str | None,
    ) -> RasterStatistics:
        """Reuse or calculate statistics for an authorized raster and sampling area.

        Args:
            request: Validated raster identity and strict sampling-area union.
            authorized_raster: Source retained by the calling access scope.
            owner: Server-derived session hash for a temporary polygon area.
            upload_owner: Browser identity for the selected uploaded polygons.

        Returns:
            Cached or newly computed rendering-independent statistics.

        Raises:
            RasterFeatureError: If catalog/source authorization fails.
            RasterConflictError: If raster, catalog selection, or bounded reading fails.
            RasterStatisticsCapacityError: If the pending-read or caller limit is full.
            RasterStatisticsQueueTimeoutError: If read capacity does not become available in time.
            VectorUploadError: If the selected upload is unavailable to this browser.
        """
        try:
            sampling_area = await self._resolve_sampling_area(
                request, owner, upload_owner
            )
        except SelectionUnavailableError as error:
            raise RasterConflictError(error.detail) from error
        category_values = (
            tuple(sorted(request.category_values))
            if request.category_values is not None
            else None
        )
        cache_key: RasterStatisticsCacheKey = (
            authorized_raster.cache_identity,
            (
                CATEGORICAL_STATISTICS_ALGORITHM
                if category_values is not None
                else RASTER_STATISTICS_ALGORITHM
            ),
            sampling_area.cache_identity(),
            (
                (
                    *categorical_statistics_policy_parameters(),
                    len(category_values),
                    *category_values,
                )
                if category_values is not None
                else raster_statistics_policy_parameters()
            ),
        )
        async with self._state_lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache.move_to_end(cache_key)
                work = None
            else:
                work = self._join_or_queue_read(
                    cache_key,
                    lambda cancellation: self._compute_statistics(
                        authorized_raster,
                        cache_key,
                        sampling_area,
                        cancellation,
                        category_values,
                    ),
                )

        if cached is not None:
            return cast(RasterStatistics, cached)

        if work is None:
            raise RuntimeError("Raster statistics work was not established")
        try:
            return cast(RasterStatistics, await asyncio.shield(work.task))
        except NoRasterBoundsOverlapError as error:
            detail = (
                "The selected polygons do not overlap the raster. Choose another "
                "polygon selection or use the whole raster."
                if isinstance(
                    sampling_area,
                    (CatalogSelectionSamplingArea, PolygonInputSamplingArea),
                )
                else "The selected area does not overlap the raster"
            )
            raise RasterConflictError(detail) from error
        except NoValidRasterSamplesError as error:
            detail = (
                "The selected polygons overlap the raster but contain no finite, "
                "non-nodata sampled pixels. Choose another polygon selection or raster."
                if isinstance(
                    sampling_area,
                    (CatalogSelectionSamplingArea, PolygonInputSamplingArea),
                )
                else "No finite, non-nodata pixels were found in the bounded "
                "raster sample"
            )
            raise RasterConflictError(detail) from error
        except SelectionUnavailableError as error:
            raise RasterConflictError(error.detail) from error
        except RasterReadCancelled:
            raise
        except RasterConflictError:
            raise
        except ValueError as error:
            raise RasterConflictError(str(error)) from error
        except (OSError, rasterio.errors.RasterioError) as error:
            raise RasterConflictError(
                "The selected raster statistics could not be read"
            ) from error
        finally:
            if authorized_raster.private:
                await finish_source_task(
                    asyncio.create_task(self._release_waiter(cache_key, work, True))
                )
            else:
                await self._release_waiter(cache_key, work)

    async def get_paired(
        self,
        request: CatalogRasterPairRequest | RasterPairSourceRequest,
        owner: str | None = None,
        upload_owner: str | None = None,
    ) -> RasterPairedStatistics:
        """Compare original data while holding both source access scopes.

        Args:
            request: Ordered raster references and optional sampling area.
            owner: Server-derived session hash for a private raster or polygon area.
            upload_owner: Server-derived browser hash for uploaded polygon selections.

        Returns:
            Joint and marginal histograms on the X raster's sampling grid.

        Raises:
            RasterFeatureError: If either source or the sampling area is unavailable.
            SourceFileError: If private access changes before delivery.
            VectorUploadError: If the polygon upload is unavailable to this browser.
        """
        async with AsyncExitStack() as stack:
            x = await stack.enter_async_context(
                self._source_access.open(request.x_raster, owner)
            )
            y = await stack.enter_async_context(
                self._source_access.open(request.y_raster, owner)
            )
            return await self._get_authorized_paired_statistics(
                request, x, y, owner, upload_owner
            )

    async def _get_authorized_paired_statistics(
        self,
        request: CatalogRasterPairRequest | RasterPairSourceRequest,
        authorized_x: RasterReadSource,
        authorized_y: RasterReadSource,
        owner: str | None,
        upload_owner: str | None,
    ) -> RasterPairedStatistics:
        """Return bounded paired statistics for two authorized original rasters.

        X and Y authorization is independent of rendering publication. The
        ordered identities, both source signatures, selected bounds, algorithm,
        and all fixed resource-policy parameters form one cache/coalescing key.

        Args:
            request: Validated ordered source pair and optional WGS 84 bounds.
            authorized_x: Retained X reference-grid source.
            authorized_y: Retained Y source for alignment.
            owner: Server-derived session hash for a temporary polygon area.
            upload_owner: Browser identity for the selected uploaded polygons.

        Returns:
            Cached or newly computed paired histogram on the X reference grid.

        Raises:
            RasterFeatureError: If either catalog/source authorization fails.
            RasterConflictError: If overlap, validity, source, or
                bounded-reading contracts fail.
            RasterStatisticsCapacityError: If the pending-read or caller limit is full.
            RasterStatisticsQueueTimeoutError: If read capacity does not become available in time.
            VectorUploadError: If the selected upload is unavailable to this browser.
        """
        selected_bounds = (
            request.selected_bounds.canonical_tuple()
            if request.selected_bounds is not None
            else None
        )
        try:
            sampling_area = await self._resolve_sampling_area(
                request, owner, upload_owner
            )
        except SelectionUnavailableError as error:
            raise RasterConflictError(error.detail) from error
        cache_key: tuple[object, ...] = (
            "paired",
            authorized_x.cache_identity,
            authorized_y.cache_identity,
            RASTER_PAIRED_STATISTICS_ALGORITHM,
            sampling_area.cache_identity(),
            raster_paired_statistics_policy_parameters(),
        )
        async with self._state_lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache.move_to_end(cache_key)
                work = None
            else:
                work = self._join_or_queue_read(
                    cache_key,
                    lambda cancellation: self._compute_paired(
                        authorized_x,
                        authorized_y,
                        selected_bounds,
                        cache_key,
                        cancellation,
                        sampling_area,
                    ),
                )

        if cached is not None:
            return cast(RasterPairedStatistics, cached)
        if work is None:
            raise RuntimeError("Paired raster statistics work was not established")
        try:
            return cast(
                RasterPairedStatistics,
                await asyncio.shield(work.task),
            )
        except NoRasterBoundsOverlapError as error:
            raise RasterConflictError(
                "The selected polygons do not overlap both rasters. Choose another polygon layer or area."
                if isinstance(sampling_area, PolygonInputSamplingArea)
                else "The selected rasters and bounds have no geographic overlap"
            ) from error
        except NoValidRasterSamplesError as error:
            raise RasterConflictError(
                "No finite, non-nodata paired pixels were found in the "
                "bounded raster sample"
            ) from error
        except RasterReadCancelled:
            raise
        except RasterConflictError:
            raise
        except ValueError as error:
            raise RasterConflictError(str(error)) from error
        except (OSError, rasterio.errors.RasterioError) as error:
            raise RasterConflictError(
                "The selected paired raster statistics could not be read"
            ) from error
        finally:
            if authorized_x.private or authorized_y.private:
                await finish_source_task(
                    asyncio.create_task(self._release_waiter(cache_key, work, True))
                )
            else:
                await self._release_waiter(cache_key, work)

    def _join_or_queue_read(
        self,
        cache_key: tuple[object, ...],
        compute: Callable[[threading.Event], Coroutine[Any, Any, _StatisticsResult]],
    ) -> _InflightStatistics:
        """Join identical work or queue a new read while the state lock is held.

        Args:
            cache_key: Authorized source, area, algorithm and sampling policy.
            compute: Create the ordinary or paired calculation with its cancellation signal.

        Returns:
            Shared work with this caller counted as a waiter.

        Raises:
            RasterStatisticsCapacityError: If the backlog or caller limit is full.
        """
        if self._waiter_count >= self._max_waiters:
            raise RasterStatisticsCapacityError(
                "Too many histogram requests are waiting. Try again shortly."
            )
        work = self._inflight.get(cache_key)
        if work is None:
            if sum(not task.done() for task in self._tasks) >= self._maximum_inflight:
                raise RasterStatisticsCapacityError(
                    "The histogram request queue is full. Try again shortly."
                )
            cancellation = threading.Event()
            task = asyncio.create_task(compute(cancellation))
            task.add_done_callback(self._retrieve_task_exception)
            self._tasks.add(task)
            work = _InflightStatistics(task, cancellation)
            self._inflight[cache_key] = work
        work.waiter_count += 1
        self._waiter_count += 1
        return work

    @asynccontextmanager
    async def _wait_for_read_capacity(
        self,
        cache_key: tuple[object, ...],
    ) -> AsyncIterator[None]:
        """Wait in arrival order, then retain capacity until the reader returns.

        Args:
            cache_key: Identity of the queued ordinary or paired calculation.

        Yields:
            None when this calculation may start its bounded raster read.

        Raises:
            RasterStatisticsQueueTimeoutError: If capacity is not available in time.
            RasterReadCancelled: If all callers have left before reading starts.
            asyncio.CancelledError: If the queued calculation is canceled.
        """
        queued_at = time.perf_counter()
        try:
            async with asyncio.timeout(self._queue_wait_seconds):
                await self._read_semaphore.acquire()
        except TimeoutError as error:
            _LOGGER.info(
                "Histogram queue wait expired after %.3f seconds",
                time.perf_counter() - queued_at,
            )
            raise RasterStatisticsQueueTimeoutError(
                "The histogram request waited too long for a reader. Try again shortly."
            ) from error
        read_started = time.perf_counter()
        try:
            async with self._state_lock:
                work = self._inflight.get(cache_key)
                if work is None or work.task is not asyncio.current_task():
                    raise RasterReadCancelled
                work.started = True
            yield
        finally:
            self._read_semaphore.release()
            _LOGGER.info(
                "Histogram read finished: kind=%s queue_wait_seconds=%.3f read_seconds=%.3f",
                "paired" if cache_key[0] == "paired" else "ordinary",
                read_started - queued_at,
                time.perf_counter() - read_started,
            )

    async def _compute_paired(
        self,
        authorized_x: RasterReadSource,
        authorized_y: RasterReadSource,
        selected_bounds: CanonicalWgs84Bounds | None,
        cache_key: tuple[object, ...],
        cancellation_requested: threading.Event,
        sampling_area: RasterSamplingArea,
    ) -> RasterPairedStatistics:
        """Compute one ordered source pair within shared bounded capacity.

        Args:
            authorized_x: Retained original source used as the X reference.
            authorized_y: Retained original source for nearest alignment.
            selected_bounds: Optional canonical WGS 84 sampling rectangle.
            cache_key: Ordered identities, signatures, bounds, and policy.
            cancellation_requested: Thread-safe last-waiter signal.
            sampling_area: Authorized polygon selection, rectangle or geodesic box descriptor.

        Returns:
            Newly computed bounded paired statistics.

        Raises:
            RasterConflictError: If a private native reader fails or times out.
            SelectionUnavailableError: If the selected vector cannot be read.
            NoRasterBoundsOverlapError: If pair/bounds do not overlap.
            NoValidRasterSamplesError: If no paired finite cells exist.
            RasterReadCancelled: If every request waiter disconnects.
            OSError: If either source cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot process a source.
            ValueError: If source or bounded-read contracts are invalid.
        """
        try:
            async with self._wait_for_read_capacity(cache_key):
                require_active_raster_read(cancellation_requested.is_set)
                options = {}
                if isinstance(sampling_area, CatalogSelectionSamplingArea):
                    options["catalog_selection"] = sampling_area
                elif isinstance(sampling_area, PolygonInputSamplingArea):
                    options["polygon_input"] = sampling_area
                elif isinstance(sampling_area, SamplingBoxArea):
                    options["sampling_box"] = sampling_area.box
                private = authorized_x.private or authorized_y.private
                execute = read_private_raster if private else asyncio.to_thread
                statistics = await execute(
                    partial(self._paired_statistics_reader, **options),
                    authorized_x.data,
                    authorized_y.data,
                    selected_bounds,
                    None if private else cancellation_requested.is_set,
                )
                require_active_raster_read(cancellation_requested.is_set)
                async with self._state_lock:
                    work = self._inflight.get(cache_key)
                    if (
                        work is None
                        or work.task is not asyncio.current_task()
                        or work.waiter_count == 0
                        or cancellation_requested.is_set()
                    ):
                        raise RasterReadCancelled
                    self._remember_completed(cache_key, statistics)
                return statistics
        finally:
            async with self._state_lock:
                work = self._inflight.get(cache_key)
                if work is not None and work.task is asyncio.current_task():
                    work.finished = True
                    if work.waiter_count == 0:
                        self._inflight.pop(cache_key)

    async def _release_waiter(
        self,
        cache_key: tuple[object, ...],
        work: _InflightStatistics,
        stop_native: bool = False,
    ) -> None:
        """Release a caller and stop work after its final waiter disconnects.

        Args:
            cache_key: Complete identity of the shared computation.
            work: Exact in-flight state joined by the caller.
            stop_native: Stop supervised private reads before releasing the last file scope.

        Returns:
            None after detaching the caller and updating worker ownership.
        """
        async with self._state_lock:
            work.waiter_count -= 1
            self._waiter_count -= 1
            if work.waiter_count != 0:
                return
            if work.finished:
                if self._inflight.get(cache_key) is work:
                    self._inflight.pop(cache_key)
                return
            work.cancellation_requested.set()
            if self._inflight.get(cache_key) is work:
                self._inflight.pop(cache_key)
            if not work.started or stop_native:
                work.task.cancel()
                self._tasks.discard(work.task)
        if stop_native:
            await finish_source_task(work.task)

    async def _compute_statistics(
        self,
        authorized_raster: RasterReadSource,
        cache_key: RasterStatisticsCacheKey,
        sampling_area: RasterSamplingArea,
        cancellation_requested: threading.Event,
        category_values: tuple[int, ...] | None = None,
    ) -> RasterStatistics:
        """Calculate and cache raster statistics while holding a reader slot.

        Args:
            authorized_raster: Original source retained by its access scope.
            cache_key: Source, area, algorithm, and parameter cache identity.
            sampling_area: Resolved whole-raster, rectangle, geodesic box or catalog-selection area.
            cancellation_requested: Thread-safe last-waiter signal.
            category_values: Sorted numeric classification codes, or None for
                the unchanged continuous distribution.

        Returns:
            Newly computed bounded raster statistics.

        Raises:
            RasterConflictError: If a private native reader fails or times out.
            SelectionUnavailableError: If the selected vector cannot be read.
            NoRasterBoundsOverlapError: If selected geometry misses the raster.
            NoValidRasterSamplesError: If no finite sample values exist.
            RasterReadCancelled: If every request waiter disconnects.
            OSError: If source pixels cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot read the source.
            ValueError: If source or sampling contracts are invalid.
        """
        try:
            async with self._wait_for_read_capacity(cache_key):
                require_active_raster_read(cancellation_requested.is_set)
                execute = (
                    read_private_raster
                    if authorized_raster.private
                    else asyncio.to_thread
                )
                statistics = await execute(
                    (
                        partial(
                            self._categorical_statistics_reader,
                            category_values=category_values,
                        )
                        if category_values is not None
                        else self._statistics_reader
                    ),
                    authorized_raster.data,
                    sampling_area,
                    (
                        None
                        if authorized_raster.private
                        else cancellation_requested.is_set
                    ),
                )
                require_active_raster_read(cancellation_requested.is_set)
                async with self._state_lock:
                    work = self._inflight.get(cache_key)
                    if (
                        work is None
                        or work.task is not asyncio.current_task()
                        or work.waiter_count == 0
                        or cancellation_requested.is_set()
                    ):
                        raise RasterReadCancelled
                    self._remember_completed(cache_key, statistics)
                return statistics
        finally:
            async with self._state_lock:
                work = self._inflight.get(cache_key)
                if work is not None and work.task is asyncio.current_task():
                    work.finished = True
                    if work.waiter_count == 0:
                        self._inflight.pop(cache_key)

    def _remember_completed(
        self,
        cache_key: tuple[object, ...],
        statistics: RasterStatistics | RasterPairedStatistics,
    ) -> None:
        """Retain one completed result within the combined LRU budget.

        The caller must hold ``_state_lock`` so ordinary and paired workers
        cannot transiently exceed the configured process-wide limit.

        Args:
            cache_key: Complete ordinary or paired computation identity.
            statistics: Valid completed result for that identity.

        Returns:
            None after retaining the result and evicting older entries.
        """
        self._cache[cache_key] = statistics
        self._cache.move_to_end(cache_key)
        while len(self._cache) > self._cache_entries:
            self._cache.popitem(last=False)

    async def _resolve_sampling_area(
        self,
        request: (
            CatalogRasterStatisticsRequest
            | RasterStatisticsSourceRequest
            | CatalogRasterPairRequest
            | RasterPairSourceRequest
        ),
        owner: str | None,
        upload_owner: str | None,
    ) -> RasterSamplingArea:
        """Resolve the area and check temporary polygon ownership before cache lookup.

        Args:
            request: Validated raster identity and exclusive sampling fields.
            owner: Server-derived session hash for a temporary polygon area.
            upload_owner: Browser identity used to authorize an uploaded selection.

        Returns:
            Whole-raster, rectangle, geodesic box or authorized polygon selection.

        Raises:
            SelectionUnavailableError: If the selection reader or source is unavailable.
            VectorUploadError: If the selected upload is unavailable to this browser.
            RasterConflictError: If the temporary polygon input is unavailable.
            RasterUpstreamError: If temporary polygon storage cannot be read.
        """
        if request.selected_bounds is not None:
            return SelectedBoundsSamplingArea(request.selected_bounds.canonical_tuple())
        if request.sampling_box is not None:
            return SamplingBoxArea(request.sampling_box)
        if request.polygon_area is not None:
            if owner is None or self._polygon_area_reader is None:
                raise RasterConflictError(
                    "This drawn polygon area is unavailable. Choose the polygon layer again."
                )
            polygons = await self._polygon_area_reader(owner, request.polygon_area)
            return PolygonInputSamplingArea(request.polygon_area, polygons)
        if request.catalog_selection is None:
            return WholeRasterSamplingArea()
        if self._catalog_selection_reader is None:
            raise SelectionUnavailableError(
                "Vector sampling is not available. Use the whole raster."
            )
        resolved = await self._catalog_selection_reader.resolve_for_sampling(
            request.catalog_selection, upload_owner
        )
        return CatalogSelectionSamplingArea(resolved)

    def _retrieve_task_exception(
        self,
        completed_task: asyncio.Task[_StatisticsResult],
    ) -> None:
        """Retrieve failures from shared work even when its waiters have left.

        Args:
            completed_task: Finished or canceled ordinary or paired task.

        Returns:
            None after consuming any worker exception.
        """
        self._tasks.discard(completed_task)
        if not completed_task.cancelled():
            completed_task.exception()
