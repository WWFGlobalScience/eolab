"""HTTP routes for raster metadata, pixel values and sampled distributions."""

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from eolab_app.catalog_selection import UploadedSelection
from eolab_app.polygon_areas import PolygonAreaReference
from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.vector_uploads import VectorUploadError

from eolab_app.raster.errors import RasterFeatureError
from eolab_app.raster.models import (
    CatalogPixelRequest,
    CatalogRasterStatisticsRequest,
    RasterPixel,
    RasterPairedStatistics,
    RasterStatistics,
)
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.raster.source_access import RasterSourceAccess
from eolab_app.raster.source_models import (
    RasterSourceDescription,
    RasterSourceDescriptionRequest,
    RasterPixelSourceRequest,
    RasterStatisticsSourceRequest,
    RasterPairSourceRequest,
    RunArtifactReference,
    raster_source_reference,
)
from eolab_app.source_files import SourceFileError
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)
from eolab_app.routes.raster_http import raster_http_exception


def create_raster_analysis_router(
    pixel_service: RasterPixelService,
    statistics_service: RasterStatisticsService,
    *,
    source_access: RasterSourceAccess | None = None,
    session_owner: Callable[[Request, Response], str] | None = None,
) -> APIRouter:
    """Create raster-analysis routes that read sources without publishing map layers.

    Args:
        pixel_service: Source-authorized, capacity-limited pixel workflow.
        statistics_service: Source-authorized bounded histogram workflow.
        source_access: Shared original-source metadata and capability access.
        session_owner: Composition-supplied session authority for private references.

    Returns:
        Router that does not depend on visualization or publication state.
    """
    router = APIRouter(
        prefix="/api/raster-analysis",
        tags=["raster-analysis"],
    )

    def owner_context(
        references: tuple[object, ...], request: Request, response: Response
    ) -> dict[str, str]:
        """Obtain private ownership only when a source reference requires it.

        Args:
            references: Validated source identities in this request.
            request: Incoming HTTP request.
            response: Response receiving private-cache and session headers.

        Returns:
            Service keyword arguments containing only server-derived ownership.

        Raises:
            HTTPException: If private source access or same-origin checks fail.
        """
        response.headers["Cache-Control"] = "private, no-store"
        context = {}
        if any(
            isinstance(reference, (RunArtifactReference, PolygonAreaReference))
            for reference in references
        ):
            if session_owner is None:
                raise HTTPException(
                    404,
                    (
                        "This polygon area is unavailable."
                        if any(
                            isinstance(reference, PolygonAreaReference)
                            for reference in references
                        )
                        else "This raster result is unavailable."
                    ),
                    headers={"Cache-Control": "private, no-store"},
                )
            context["owner"] = session_owner(request, response)
        if any(isinstance(reference, UploadedSelection) for reference in references):
            context["upload_owner"] = get_browser_owner_hash(
                request, response, mutation_header="X-EOLab-Uploads"
            )
        return context

    def source_error(
        error: RasterFeatureError | SourceFileError | VectorUploadError,
    ) -> HTTPException:
        """Translate a source failure without allowing private derived data to be cached.

        Args:
            error: Sanitized source or numerical failure.

        Returns:
            HTTP failure with existing raster or source status and no-store headers.
        """
        failure = (
            HTTPException(error.status, str(error))
            if isinstance(error, (SourceFileError, VectorUploadError))
            else raster_http_exception(error)
        )
        failure.headers = {
            **(failure.headers or {}),
            "Cache-Control": "private, no-store",
        }
        return failure

    @router.post("/sources", response_model=RasterSourceDescription)
    async def describe_raster_source(
        body: RasterSourceDescriptionRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        """Describe original raster data and reader support for the selected source.

        Args:
            body: Path-free raster or observation reference and optional target CRS.
            request: HTTP session and cancellation context.
            response: Private response headers.

        Returns:
            Original metadata, source identity, reader capabilities and any
            requested projected pixel-size suggestion.

        Raises:
            HTTPException: If authorization, inspection or cancellation fails.
        """
        context = owner_context((body.source,), request, response)
        if source_access is None:
            raise HTTPException(503, "Raster metadata access is unavailable.")
        try:
            return await run_until_http_disconnect(
                request,
                source_access.describe(
                    body.source, target_crs=body.target_crs, **context
                ),
            )
        except (RasterFeatureError, SourceFileError) as error:
            raise source_error(error) from error
        except HttpClientDisconnectedError as error:
            raise HTTPException(
                499, "The raster metadata request was canceled"
            ) from error

    @router.post(
        "/pixels",
        response_model=RasterPixel,
    )
    async def sample_raster_pixel(
        request: CatalogPixelRequest | RasterPixelSourceRequest,
        http_request: Request,
        response: Response,
    ) -> RasterPixel:
        """Read one pixel from an authorized original raster.

        Args:
            request: Catalog or private source and WGS 84 coordinate.
            http_request: HTTP session and cancellation context.
            response: Private response headers.

        Returns:
            Band-one pixel position and value or out-of-bounds result.

        Raises:
            HTTPException: If the source is not current or cannot be sampled.
        """
        try:
            context = owner_context(
                (raster_source_reference(request),), http_request, response
            )
            return await run_until_http_disconnect(
                http_request, pixel_service.get(request, **context)
            )
        except (RasterFeatureError, SourceFileError) as error:
            raise source_error(error) from error
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "The raster pixel request was canceled") from error

    @router.post(
        "/statistics",
        response_model=RasterStatistics,
    )
    async def sample_raster_statistics(
        request: CatalogRasterStatisticsRequest | RasterStatisticsSourceRequest,
        http_request: Request,
        response: Response,
    ) -> RasterStatistics:
        """Summarize one original raster and normalized sampling area.

        Args:
            request: Raster source and an optional bounds, box or polygon area.
            http_request: Incoming request used to detect cancellation.
            response: Private response headers.

        Returns:
            Bounded band-1 statistics independent of rendering state.

        Raises:
            HTTPException: If analysis fails or the browser disconnects.
        """

        try:
            context = owner_context(
                (
                    raster_source_reference(request),
                    request.catalog_selection,
                    request.polygon_area,
                ),
                http_request,
                response,
            )
            return await run_until_http_disconnect(
                http_request,
                statistics_service.get(request, **context),
            )
        except (RasterFeatureError, SourceFileError, VectorUploadError) as error:
            raise source_error(error) from error
        except HttpClientDisconnectedError as error:
            raise HTTPException(
                status_code=499,
                detail="The raster statistics request was canceled",
            ) from error

    @router.post(
        "/paired-statistics",
        response_model=RasterPairedStatistics,
    )
    async def sample_paired_raster_statistics(
        request: RasterPairSourceRequest,
        http_request: Request,
        response: Response,
    ) -> RasterPairedStatistics:
        """Summarize valid paired cells on the ordered X reference grid.

        Args:
            request: Two catalog or private identities and optional bounds, box or polygon area.
            http_request: Incoming request used to detect cancellation.
            response: Private response headers.

        Returns:
            Bounded two-dimensional histogram, marginals, and provenance.

        Raises:
            HTTPException: If analysis fails or the browser disconnects.
        """
        try:
            context = owner_context(
                (
                    request.x_raster,
                    request.y_raster,
                    request.catalog_selection,
                    request.polygon_area,
                ),
                http_request,
                response,
            )
            return await run_until_http_disconnect(
                http_request,
                statistics_service.get_paired(request, **context),
            )
        except (RasterFeatureError, SourceFileError, VectorUploadError) as error:
            raise source_error(error) from error
        except HttpClientDisconnectedError as error:
            raise HTTPException(
                status_code=499,
                detail="The paired raster statistics request was canceled",
            ) from error

    return router
