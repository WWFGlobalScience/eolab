"""Application service coordinating authorized raster pixel reads."""

import asyncio
from collections.abc import Callable
from pathlib import Path

import rasterio

from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogPixelRequest,
    RasterPixel,
)
from eolab_app.raster.pixel import read_raster_pixel
from eolab_app.raster.ports import RasterSourceAuthorizer


class RasterPixelService:
    """Authorize and schedule rendering-independent pixel reads."""

    def __init__(
        self,
        source_authorizer: RasterSourceAuthorizer,
        read_concurrency: int,
        pixel_reader: Callable[[Path, float, float], RasterPixel] = (
            read_raster_pixel
        ),
    ) -> None:
        """Create a bounded pixel-read service.

        Args:
            source_authorizer: Catalog-owned mounted-source authorization.
            read_concurrency: Maximum simultaneous Rasterio reads.
            pixel_reader: Synchronous pixel boundary, replaceable in tests.
        """
        self._source_authorizer = source_authorizer
        self._read_semaphore = asyncio.Semaphore(read_concurrency)
        self._pixel_reader = pixel_reader

    async def _read_current(
        self,
        authorized_raster: AuthorizedRaster,
        request: CatalogPixelRequest,
    ) -> RasterPixel:
        """Sample one source while retaining read capacity and identity.

        Args:
            authorized_raster: Catalog source authorized at request start.
            request: Validated Item identity and WGS 84 position.

        Returns:
            The sampled band-one value and source cell.

        Raises:
            RasterConflictError: If the source changes around the read.
            OSError: If the source cannot be read.
            rasterio.errors.RasterioError: If GDAL cannot sample it.
            ValueError: If its CRS cannot transform the position.
        """

        pixel = await asyncio.to_thread(
            self._pixel_reader,
            authorized_raster.source_path,
            request.longitude,
            request.latitude,
        )
        return pixel

    async def get(self, request: CatalogPixelRequest) -> RasterPixel:
        """Sample one catalog raster without rendering-state authorization.

        Args:
            request: Validated Item identity and WGS 84 position.

        Returns:
            The sampled band-one value and source cell.

        Raises:
            RasterFeatureError: If the catalog source cannot be authorized.
            RasterConflictError: If the source is stale or cannot be sampled.
        """
        authorized_raster = await self._source_authorizer.authorize(request)
        await self._read_semaphore.acquire()
        read_task = asyncio.create_task(
            self._read_current(authorized_raster, request)
        )

        def retrieve_task_exception(
            completed_task: asyncio.Task[RasterPixel],
        ) -> None:
            """Retrieve a worker failure after HTTP cancellation.

            Args:
                completed_task: Finished pixel-read task.
            """
            self._read_semaphore.release()
            if not completed_task.cancelled():
                completed_task.exception()

        read_task.add_done_callback(retrieve_task_exception)
        try:
            return await asyncio.shield(read_task)
        except RasterConflictError:
            raise
        except (OSError, ValueError, rasterio.errors.RasterioError) as error:
            raise RasterConflictError(
                "The selected raster could not be sampled"
            ) from error
