"""Test raster statistics caching and source-identity lifecycle."""

import asyncio
import threading
from pathlib import Path

import pytest

from eolab_app.raster.errors import RasterStatisticsCapacityError
from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogRasterPairRequest,
    CatalogRasterStatisticsRequest,
    CanonicalWgs84Bounds,
    RasterHistogram,
    RasterPairedHistogram,
    RasterPairedStatistics,
    RasterPercentiles,
    RasterStatistics,
    RasterValueRange,
)
from eolab_app.raster.read_cancellation import RasterReadCancellationCheck
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.sampling_area import RasterSamplingArea


class _SourceAuthorizer:
    """Return a replaceable authorized source identity."""

    def __init__(self, source_path: Path) -> None:
        """Authorize an initial source signature."""
        self.authorization = AuthorizedRaster(source_path, (1, 2, 3, 4, 5))

    async def authorize(self, _: object) -> AuthorizedRaster:
        """Return the current controlled authorization."""
        return self.authorization


def _statistics(value: float) -> RasterStatistics:
    """Build one valid bounded statistics result."""
    return RasterStatistics(
        scope="wholeRaster",
        selectedBounds=None,
        sourceWidth=1,
        sourceHeight=1,
        sourcePixelCount=1,
        sampleWidth=1,
        sampleHeight=1,
        sampledPixelCount=1,
        validSampleCount=1,
        samplingMethod="exactSourceWindow",
        estimated=False,
        sampleMinimum=value,
        sampleMaximum=value,
        percentiles=RasterPercentiles(p05=value, p50=value, p95=value),
        histogram=RasterHistogram(
            counts=[1, *([0] * 63)],
            edges=[float(index) for index in range(65)],
        ),
        suggestedRange=RasterValueRange(
            minimum=value - 1,
            midpoint=value,
            maximum=value + 1,
        ),
    )


def _paired_statistics(value: float) -> RasterPairedStatistics:
    """Build one valid bounded paired-statistics result.

    Args:
        value: Single finite value represented in both axes.

    Returns:
        Valid exact paired response with one populated matrix cell.
    """
    counts = [[0 for _ in range(32)] for _ in range(32)]
    counts[0][0] = 1
    return RasterPairedStatistics(
        scope="wholeOverlap",
        selectedBounds=None,
        sourceWidth=1,
        sourceHeight=1,
        sourcePixelCount=1,
        sampleWidth=1,
        sampleHeight=1,
        sampledCellCount=1,
        pairedSampleCount=1,
        samplingMethod="exactReferenceGrid",
        approximate=False,
        xMinimum=value,
        xMaximum=value,
        yMinimum=value,
        yMaximum=value,
        histogram=RasterPairedHistogram(
            xEdges=[float(index) for index in range(33)],
            yEdges=[float(index) for index in range(33)],
            counts=counts,
            xMarginalCounts=[1, *([0] * 31)],
            yMarginalCounts=[1, *([0] * 31)],
        ),
    )


class _PairSourceAuthorizer:
    """Authorize two independently replaceable catalog source identities.

    Attributes:
        authorizations: Current authorization keyed by catalog Item ID.
    """

    def __init__(self, directory: Path) -> None:
        """Create controlled X and Y authorizations.

        Args:
            directory: Directory used for inert source path identities.
        """
        self.authorizations = {
            "geotiff-0123456789abcdef01234567": AuthorizedRaster(
                directory / "x.tif", (1, 2, 3, 4, 5)
            ),
            "geotiff-abcdef0123456789abcdef01": AuthorizedRaster(
                directory / "y.tif", (6, 7, 8, 9, 10)
            ),
        }

    async def authorize(self, request: object) -> AuthorizedRaster:
        """Return the authorization for one request Item.

        Args:
            request: Catalog request containing an ``item_id`` field.

        Returns:
            Current controlled source authorization.
        """
        return self.authorizations[request.item_id]


def test_statistics_service_caches_by_approved_source_signature(
    tmp_path: Path,
) -> None:
    """Reuse one source version and recompute after authorization changes.

    Args:
        tmp_path: Directory used for the controlled source path identity.

    Returns:
        None after verifying cache reuse and signature invalidation.
    """
    source_authorizer = _SourceAuthorizer(tmp_path / "raster.tif")
    read_count = 0

    def reader(
        _: Path,
        __: RasterSamplingArea,
        ___: RasterReadCancellationCheck,
    ) -> RasterStatistics:
        """Return a distinguishable ordinary result for each cache miss.

        Args:
            _: Ignored authorized source path.
            __: Ignored normalized sampling area.
            ___: Ignored cancellation predicate.

        Returns:
            Valid statistics carrying the current read count.
        """
        nonlocal read_count
        read_count += 1
        return _statistics(float(read_count))

    service = RasterStatisticsService(
        source_authorizer,
        read_concurrency=1,
        cache_entries=32,
        statistics_reader=reader,
    )
    request = CatalogRasterStatisticsRequest.model_validate(
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        }
    )

    async def exercise_cache() -> None:
        first = await service.get(request)
        assert await service.get(request) is first
        source_authorizer.authorization = AuthorizedRaster(
            source_authorizer.authorization.source_path,
            (1, 2, 3, 4, 6),
        )
        replacement = await service.get(request)
        assert replacement.sample_minimum == 2

    asyncio.run(exercise_cache())
    assert read_count == 2


def test_statistics_service_keys_pairs_by_ordered_identities_and_signatures(
    tmp_path: Path,
) -> None:
    """Coalesce an ordered pair and recompute after either source changes.

    Args:
        tmp_path: Directory used for controlled source path identities.

    Returns:
        None after verifying coalescing, signatures, and ordered-pair keys.
    """
    source_authorizer = _PairSourceAuthorizer(tmp_path)
    read_count = 0
    read_started = threading.Event()
    release_read = threading.Event()

    def reader(
        _: Path,
        __: Path,
        ___: CanonicalWgs84Bounds | None,
        ____: RasterReadCancellationCheck,
    ) -> RasterPairedStatistics:
        """Return a new controlled result for each admitted computation.

        Args:
            _: Ignored authorized X source path.
            __: Ignored authorized Y source path.
            ___: Ignored optional selected bounds.
            ____: Ignored cancellation predicate.

        Returns:
            Valid paired statistics carrying the current read count.
        """
        nonlocal read_count
        read_count += 1
        read_started.set()
        assert release_read.wait(timeout=2)
        return _paired_statistics(float(read_count))

    service = RasterStatisticsService(
        source_authorizer,
        read_concurrency=1,
        cache_entries=32,
        paired_statistics_reader=reader,
    )
    request = CatalogRasterPairRequest.model_validate({
        "xRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        },
        "yRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-abcdef0123456789abcdef01",
        },
    })
    swapped_request = CatalogRasterPairRequest.model_validate({
        "xRaster": request.y_raster.model_dump(by_alias=True),
        "yRaster": request.x_raster.model_dump(by_alias=True),
    })

    async def exercise_cache() -> None:
        """Coalesce the pair, then invalidate it through Y identity.

        Returns:
            None after exercising the paired cache lifecycle.
        """
        first_request = asyncio.create_task(service.get_paired(request))
        assert await asyncio.to_thread(read_started.wait, 2)
        second_request = asyncio.create_task(service.get_paired(request))
        await asyncio.sleep(0)
        release_read.set()
        first, coalesced = await asyncio.gather(
            first_request,
            second_request,
        )
        assert coalesced is first
        assert await service.get_paired(request) is first
        source_authorizer.authorizations[request.y_raster.item_id] = (
            AuthorizedRaster(tmp_path / "y.tif", (6, 7, 8, 9, 11))
        )
        replacement = await service.get_paired(request)
        assert replacement.x_minimum == 2
        swapped = await service.get_paired(swapped_request)
        assert swapped.x_minimum == 3
        assert await service.get_paired(swapped_request) is swapped

    asyncio.run(exercise_cache())
    assert read_count == 3


def test_paired_statistics_cancellation_preserves_a_coalesced_waiter(
    tmp_path: Path,
) -> None:
    """Keep shared paired work alive while one of two callers still waits.

    Args:
        tmp_path: Directory used for controlled source path identities.

    Returns:
        None after verifying one cancellation preserves the shared worker.
    """
    source_authorizer = _PairSourceAuthorizer(tmp_path)
    read_started = threading.Event()
    release_read = threading.Event()
    cancellation_check: RasterReadCancellationCheck | None = None

    def reader(
        _: Path,
        __: Path,
        ___: CanonicalWgs84Bounds | None,
        requested: RasterReadCancellationCheck,
    ) -> RasterPairedStatistics:
        """Block one shared reader while exposing its cancellation predicate.

        Args:
            _: Ignored authorized X source path.
            __: Ignored authorized Y source path.
            ___: Ignored optional selected bounds.
            requested: Shared-work cancellation predicate to expose.

        Returns:
            Valid paired statistics after the controlled read is released.
        """
        nonlocal cancellation_check
        cancellation_check = requested
        read_started.set()
        assert release_read.wait(timeout=2)
        return _paired_statistics(1)

    service = RasterStatisticsService(
        source_authorizer,
        read_concurrency=1,
        cache_entries=4,
        paired_statistics_reader=reader,
    )
    request = CatalogRasterPairRequest.model_validate({
        "xRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        },
        "yRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-abcdef0123456789abcdef01",
        },
    })

    async def exercise_cancellation() -> None:
        """Cancel one waiter without signaling its shared synchronous read.

        Returns:
            None after the remaining waiter receives the shared result.
        """
        first = asyncio.create_task(service.get_paired(request))
        assert await asyncio.to_thread(read_started.wait, 2)
        second = asyncio.create_task(service.get_paired(request))
        async with asyncio.timeout(2):
            while next(iter(service._inflight.values())).waiter_count < 2:
                await asyncio.sleep(0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert cancellation_check is not None
        assert cancellation_check() is False
        release_read.set()
        assert (await second).paired_sample_count == 1

    asyncio.run(exercise_cancellation())


def test_paired_last_waiter_cancellation_retains_shared_capacity(
    tmp_path: Path,
) -> None:
    """Hold admission until a canceled synchronous pair reader really exits.

    Args:
        tmp_path: Directory used for controlled source path identities.

    Returns:
        None after verifying canceled work retains capacity until completion.
    """
    source_authorizer = _PairSourceAuthorizer(tmp_path)
    read_started = threading.Event()
    cancellation_observed = threading.Event()
    release_read = threading.Event()
    reader_finished = threading.Event()

    def paired_reader(
        _: Path,
        __: Path,
        ___: CanonicalWgs84Bounds | None,
        cancellation_requested: RasterReadCancellationCheck,
    ) -> RasterPairedStatistics:
        """Observe cancellation but remain alive until explicitly released.

        Args:
            _: Ignored authorized X source path.
            __: Ignored authorized Y source path.
            ___: Ignored optional selected bounds.
            cancellation_requested: Shared-work cancellation predicate.

        Returns:
            Valid paired statistics after explicit release.
        """
        read_started.set()
        while not release_read.wait(timeout=0.01):
            if cancellation_requested():
                cancellation_observed.set()
        reader_finished.set()
        return _paired_statistics(1)

    def ordinary_reader(
        _: Path,
        __: RasterSamplingArea,
        ___: RasterReadCancellationCheck,
    ) -> RasterStatistics:
        """Return an ordinary result after paired capacity is released.

        Args:
            _: Ignored authorized source path.
            __: Ignored normalized sampling area.
            ___: Ignored cancellation predicate.

        Returns:
            Valid ordinary statistics.
        """
        return _statistics(1)

    service = RasterStatisticsService(
        source_authorizer,
        read_concurrency=1,
        cache_entries=4,
        statistics_reader=ordinary_reader,
        paired_statistics_reader=paired_reader,
    )
    pair_request = CatalogRasterPairRequest.model_validate({
        "xRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        },
        "yRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-abcdef0123456789abcdef01",
        },
    })
    ordinary_request = CatalogRasterStatisticsRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": "geotiff-0123456789abcdef01234567",
    })

    async def exercise_capacity() -> None:
        """Reject distinct work until the canceled paired reader returns.

        Returns:
            None after verifying shared-capacity release.
        """
        paired_task = asyncio.create_task(service.get_paired(pair_request))
        assert await asyncio.to_thread(read_started.wait, 2)
        paired_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await paired_task
        assert await asyncio.to_thread(cancellation_observed.wait, 2)
        with pytest.raises(RasterStatisticsCapacityError, match="capacity is busy"):
            await service.get(ordinary_request)
        with pytest.raises(RasterStatisticsCapacityError, match="finishing canceled work"):
            await service.get_paired(pair_request)
        release_read.set()
        assert await asyncio.to_thread(reader_finished.wait, 2)
        async with asyncio.timeout(2):
            while service._inflight:
                await asyncio.sleep(0)
        assert (await service.get(ordinary_request)).sample_minimum == 1

    asyncio.run(exercise_capacity())


def test_statistics_service_shares_one_completed_cache_budget(
    tmp_path: Path,
) -> None:
    """Evict ordinary and paired results through one configured LRU limit.

    Args:
        tmp_path: Directory used for controlled source path identities.

    Returns:
        None after verifying both result types share one cache budget.
    """
    source_authorizer = _PairSourceAuthorizer(tmp_path)
    ordinary_read_count = 0
    paired_read_count = 0

    def ordinary_reader(
        _: Path,
        __: RasterSamplingArea,
        ___: RasterReadCancellationCheck,
    ) -> RasterStatistics:
        """Return a distinguishable ordinary result for each cache miss.

        Args:
            _: Ignored authorized source path.
            __: Ignored normalized sampling area.
            ___: Ignored cancellation predicate.

        Returns:
            Valid ordinary statistics carrying the current read count.
        """
        nonlocal ordinary_read_count
        ordinary_read_count += 1
        return _statistics(float(ordinary_read_count))

    def paired_reader(
        _: Path,
        __: Path,
        ___: CanonicalWgs84Bounds | None,
        ____: RasterReadCancellationCheck,
    ) -> RasterPairedStatistics:
        """Return a distinguishable paired result for each cache miss.

        Args:
            _: Ignored authorized X source path.
            __: Ignored authorized Y source path.
            ___: Ignored optional selected bounds.
            ____: Ignored cancellation predicate.

        Returns:
            Valid paired statistics carrying the current read count.
        """
        nonlocal paired_read_count
        paired_read_count += 1
        return _paired_statistics(float(paired_read_count))

    service = RasterStatisticsService(
        source_authorizer,
        read_concurrency=1,
        cache_entries=1,
        statistics_reader=ordinary_reader,
        paired_statistics_reader=paired_reader,
    )
    ordinary_request = CatalogRasterStatisticsRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": "geotiff-0123456789abcdef01234567",
    })
    paired_request = CatalogRasterPairRequest.model_validate({
        "xRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        },
        "yRaster": {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-abcdef0123456789abcdef01",
        },
    })

    async def exercise_combined_limit() -> None:
        """Prove each result type evicts the other at a one-entry limit.

        Returns:
            None after exercising cross-result eviction.
        """
        first_ordinary = await service.get(ordinary_request)
        assert await service.get(ordinary_request) is first_ordinary
        first_paired = await service.get_paired(paired_request)
        assert await service.get_paired(paired_request) is first_paired
        second_ordinary = await service.get(ordinary_request)
        assert second_ordinary is not first_ordinary
        second_paired = await service.get_paired(paired_request)
        assert second_paired is not first_paired

    asyncio.run(exercise_combined_limit())
    assert ordinary_read_count == 2
    assert paired_read_count == 2
