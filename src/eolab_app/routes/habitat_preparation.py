"""Expose administrator-owned Habitat input preparation and retained reports."""

from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, ValidationError
from starlette.responses import JSONResponse

from eolab_app.catalog_selection import SelectionUnavailableError
from eolab_app.processing.habitat_preparation_models import (
    OPERATION,
    HabitatInputPreparationInputs,
    HabitatInputPreparationRequest,
    PreparationRequestId,
)
from eolab_app.processing.models import (
    JobProgressResponse,
    JobResponse,
    JobResultResponse,
    ProcessingError,
)
from eolab_app.processing.service import ProcessingService
from eolab_app.routes.admin_auth import create_administrator_dependency
from eolab_app.routes.processing import JobDownloadResponse, RequestSizeLimitedRoute

PreparationJobId = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]


class HabitatPreparationProgress(JobProgressResponse):
    """Report measured completed and total tiles once acquisition has planned them.

    Attributes:
        completed: Number of complete reusable tiles, including existing cache hits.
        total: Number of tiles needed for the selected polygons, or None while unknown.
        unit: Work unit supplied by the native progress producer.
    """

    completed: int | None = None
    total: int | None = None
    unit: str | None = None


class HabitatPreparationReport(JobResultResponse):
    """Describe a retained completion report without representing current coverage.

    Attributes:
        year: Assessment year of the prepared scientific stack.
        configurationSha256: Scientific identity recorded by this preparation.
        tileCount: Number of reusable input tiles covered when this job completed.
    """

    year: int
    configurationSha256: str
    tileCount: int


class HabitatPreparationJob(JobResponse):
    """Describe one administrator-owned preparation with separately expiring metadata.

    Attributes:
        operation: Habitat input-preparation discriminator, never a model run.
        inputs: Saved name, Catalog AOI, year and identity until metadata expiry.
        metadataExpiresAt: Saved-input expiry after completion, or None while active.
        progress: Actual work counts supplied by the existing worker.
        result: Downloadable completion report while ordinary result retention allows.
    """

    operation: Literal["habitat.prepare-inputs.v1"] = OPERATION
    inputs: HabitatInputPreparationInputs | None
    metadataExpiresAt: datetime | None
    progress: HabitatPreparationProgress
    result: HabitatPreparationReport | None


class HabitatPreparationList(BaseModel):
    """Return one page of administrator preparation history.

    Attributes:
        jobs: Matching jobs, newest first; excludes other operations and browser owners.
        nextCursor: Token for older retained jobs, or None at the end of history.
    """

    jobs: list[HabitatPreparationJob]
    nextCursor: str | None


class HabitatPreparationRetryRequest(BaseModel):
    """Identify an explicit retry command without changing the saved preparation inputs.

    Attributes:
        requestId: Stable command identifier for recovering a lost admission response.
    """

    model_config = ConfigDict(extra="forbid")
    requestId: PreparationRequestId


class HabitatPreparationRoute(RequestSizeLimitedRoute):
    """Preserve metadata-body limits and keep administration results and errors private."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Protect admin responses and translate the owning service's safe errors.

        Returns:
            Handler preserving authentication challenges and private error responses.
        """
        handler = super().get_route_handler()

        async def respond(request: Request) -> Response:
            """Return one preparation response with private browser-cache policy.

            Args:
                request: Incoming authenticated or rejected administration request.

            Returns:
                Operation result or sanitized source, storage and validation failure.
            """
            try:
                response = await handler(request)
            except HTTPException as error:
                response = JSONResponse(
                    {"detail": error.detail}, error.status_code, headers=error.headers
                )
            except RequestValidationError as error:
                response = await request_validation_exception_handler(request, error)
            except ProcessingError as error:
                response = JSONResponse({"detail": error.detail}, error.status)
            except SelectionUnavailableError as error:
                response = JSONResponse({"detail": error.detail}, 409)
            except ValidationError:
                response = JSONResponse(
                    {"detail": "This preparation's saved details could not be read."},
                    500,
                )
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return respond


def create_habitat_preparation_router(
    service: ProcessingService, password: str
) -> APIRouter:
    """Expose protected preparation commands through the existing Processing service.

    Args:
        service: Existing job lifecycle owner, including its Catalog source reader.
        password: Existing administrator password; blank disables all endpoints.

    Returns:
        Admin-only router using a fixed server scope rather than browser cookies.
        Mutations require the existing same-origin administrator request header.
    """
    router = APIRouter(
        prefix="/api/admin/habitat/input-preparations",
        tags=["Ecosystem Condition input administration"],
        route_class=HabitatPreparationRoute,
        dependencies=[Depends(create_administrator_dependency(password))],
    )

    @router.post("", status_code=202, response_model=HabitatPreparationJob)
    async def submit_preparation(
        body: HabitatInputPreparationRequest,
    ) -> dict[str, object]:
        """Queue one named Catalog AOI and assessment year without running the model.

        Args:
            body: Stable submission identifier and requested preparation inputs.

        Returns:
            Accepted job, including an unchanged retry of an earlier submission.

        Raises:
            ProcessingError: If input validation, conflict detection or admission fails.
            SelectionUnavailableError: If Catalog source authorization rejects the AOI.
        """
        return await service.submit_habitat_input_preparation(body)

    @router.get("", response_model=HabitatPreparationList)
    async def list_preparations(
        limit: int = Query(50, ge=1, le=100), cursor: str | None = Query(None)
    ) -> dict[str, object]:
        """Read one page of this site's administrator preparation history.

        Args:
            limit: Number of jobs to return, from one to 100.
            cursor: Previous continuation token, or None to start with newest jobs.

        Returns:
            Matching job statuses and a cursor for older retained entries.

        Raises:
            ProcessingError: If the cursor is invalid or job storage is unavailable.
        """
        return await service.list_habitat_input_preparations(limit, cursor)

    @router.get("/{job_id}", response_model=HabitatPreparationJob)
    async def get_preparation(job_id: PreparationJobId) -> dict[str, object]:
        """Read a preparation's current tile progress, state and report availability.

        Args:
            job_id: Preparation handle returned when the work was accepted.

        Returns:
            Current admin-owned preparation without worker paths or credentials.

        Raises:
            ProcessingError: If this preparation is unavailable to administration.
        """
        return await service.get_habitat_input_preparation(job_id)

    @router.post(
        "/{job_id}/cancel", status_code=202, response_model=HabitatPreparationJob
    )
    async def cancel_preparation(job_id: PreparationJobId) -> dict[str, object]:
        """Request cancellation while preserving all completed shared input tiles.

        Args:
            job_id: Preparation handle to stop through the existing worker lifecycle.

        Returns:
            Updated state, including cancelling until running native work exits.

        Raises:
            ProcessingError: If this preparation is unavailable or cancellation fails.
        """
        return await service.cancel_habitat_input_preparation(job_id)

    @router.post(
        "/{job_id}/retry", status_code=202, response_model=HabitatPreparationJob
    )
    async def retry_preparation(
        job_id: PreparationJobId, body: HabitatPreparationRetryRequest
    ) -> dict[str, object]:
        """Start a new attempt from saved inputs and reuse completed cached tiles.

        Args:
            job_id: Failed, cancelled, interrupted or expired preparation handle.
            body: Stable retry-command identifier for lost-response recovery.

        Returns:
            Newly accepted preparation or the earlier acceptance of this command.

        Raises:
            ProcessingError: If saved inputs expired, configuration changed or admission fails.
            SelectionUnavailableError: If the original Catalog AOI is unavailable.
        """
        return await service.retry_habitat_input_preparation(job_id, body.requestId)

    @router.api_route("/{job_id}/report", methods=["GET", "HEAD"])
    async def download_report(job_id: PreparationJobId, request: Request) -> Response:
        """Download the retained completion report with ordinary transfer protection.

        Args:
            job_id: Completed preparation handle whose report remains available.
            request: Authenticated request with an optional single byte range.

        Returns:
            Private JSON file response retaining the file until transfer completes.

        Raises:
            HTTPException: If the requested byte range is unsupported.
            ProcessingError: If the report is unavailable or expired.
        """
        byte_range = request.headers.get("range", "")
        if len(byte_range) > 128 or "," in byte_range:
            raise HTTPException(416, "Use one byte range per report download request.")
        artifact = await service.download_habitat_input_preparation(job_id)
        return JobDownloadResponse(artifact, service)

    @router.api_route("/{job_id}/provenance", methods=["GET", "HEAD"])
    async def download_provenance(job_id: PreparationJobId) -> Response:
        """Download retained preparation provenance without exposing credentials.

        Args:
            job_id: Completed preparation handle whose provenance remains available.

        Returns:
            Private provenance response with the existing renewable transfer lease.

        Raises:
            ProcessingError: If the preparation or retained provenance is unavailable.
        """
        artifact = await service.download_habitat_input_preparation(job_id, True)
        return JobDownloadResponse(artifact, service)

    return router
