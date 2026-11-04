"""Protect read-only Habitat cache checks with the existing administrator login."""

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict
from starlette.responses import JSONResponse

from eolab_app.catalog_selection import CatalogSelection, CatalogSelectionReader
from eolab_app.catalog_selection import SelectionUnavailableError
from eolab_app.processing.habitat_cache import get_habitat_cache_coverage
from eolab_app.processing.habitat_earth_engine import HabitatCacheCoverage
from eolab_app.processing.models import ProcessingError
from eolab_app.routes.admin_auth import create_administrator_dependency
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)


class HabitatCacheCoverageRequest(BaseModel):
    """Choose one Catalog polygon selection and assessment year to inspect.

    Attributes:
        selection: Catalog identity and exact attribute predicate for the AOI.
        year: Assessment year supported by the installed scientific configuration.
    """

    model_config = ConfigDict(extra="forbid")
    selection: CatalogSelection
    year: int


class HabitatCacheCoverageResponse(BaseModel):
    """Report current tile availability without exposing files or credentials.

    Attributes:
        configurationSha256: Scientific stack identity including year and grid.
        year: Assessment year checked against the installed scientific stack.
        requiredTiles: Distinct acquisition tiles intersecting the exact polygons.
        cachedTiles: Required tiles already published in the persistent cache.
        missingTiles: Required tiles not yet published; inspection does not fetch them.
    """

    configurationSha256: str
    year: int
    requiredTiles: int
    cachedTiles: int
    missingTiles: int


class HabitatAdminRoute(APIRoute):
    """Keep Habitat administration results and errors private."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Wrap admin responses with private headers and safe application errors.

        Returns:
            Handler preserving authentication challenges and validation responses.
        """
        handler = super().get_route_handler()

        async def respond(request: Request) -> Response:
            """Return one admin result or expected error without allowing caching.

            Args:
                request: Incoming authenticated or rejected administration request.

            Returns:
                Private endpoint response or safe authorization/validation failure.
            """
            try:
                response = await handler(request)
            except HTTPException as error:
                response = JSONResponse(
                    {"detail": error.detail}, error.status_code, headers=error.headers
                )
            except RequestValidationError as error:
                response = await request_validation_exception_handler(request, error)
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return respond


def create_habitat_admin_router(
    selections: CatalogSelectionReader, cache_directory: Path, password: str
) -> APIRouter:
    """Create a protected cache-count API without Earth Engine credentials.

    Args:
        selections: Existing Catalog reader authorizing original vector selections.
        cache_directory: Server-controlled Habitat cache on the read-only volume.
        password: Existing administrator password; blank disables this endpoint.

    Returns:
        Router serializing native inspections until completion or disconnection.
        POST requests require the existing same-origin administrator header.
    """
    router = APIRouter(
        tags=["Ecosystem Condition administration"],
        route_class=HabitatAdminRoute,
        dependencies=[Depends(create_administrator_dependency(password))],
    )
    inspection_lock = asyncio.Lock()

    async def inspect_selected_area(
        payload: HabitatCacheCoverageRequest,
    ) -> HabitatCacheCoverage:
        """Read one selected area after previous native inspection has stopped.

        Args:
            payload: Validated Catalog selection and scientific year.

        Returns:
            Advisory cache coverage for the exact selected polygons.

        Raises:
            SelectionUnavailableError: If the Catalog selection is unavailable.
            ProcessingError: If native polygon or cache inspection fails.
        """
        async with inspection_lock:
            return await get_habitat_cache_coverage(
                payload.selection, payload.year, selections, cache_directory
            )

    @router.post("/api/admin/habitat/cache-coverage")
    async def inspect_cache(
        payload: HabitatCacheCoverageRequest, request: Request
    ) -> HabitatCacheCoverageResponse:
        """Count available Habitat input tiles without downloading or fitting.

        Args:
            payload: One path-free Catalog polygon selection and assessment year.
            request: Connection whose disconnection cancels native inspection.

        Returns:
            Scientific configuration identity and current tile counts.

        Raises:
            HTTPException: If disconnected, invalid, unavailable or unreadable.
        """
        try:
            coverage = await run_until_http_disconnect(
                request, inspect_selected_area(payload)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Cache check cancelled.") from error
        except SelectionUnavailableError as error:
            raise HTTPException(409, error.detail) from error
        except ProcessingError as error:
            raise HTTPException(error.status, error.detail) from error
        return HabitatCacheCoverageResponse(
            configurationSha256=coverage.configuration_sha256,
            year=coverage.year,
            requiredTiles=coverage.required_tiles,
            cachedTiles=coverage.cached_tiles,
            missingTiles=coverage.missing_tiles,
        )

    return router
