"""HTTP endpoints for model discovery, processing jobs and result downloads.

Each browser session can submit work, inspect its jobs, cancel them and download
their results. Clips, raster summaries and model runs share the same job lifecycle.
"""

import asyncio
from contextlib import suppress
import hashlib
import json
import re
import secrets
from collections.abc import Awaitable, Callable
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Path, Query, Request, Response
from fastapi.routing import APIRoute
from pydantic import Field, ValidationError
from starlette.responses import FileResponse, StreamingResponse

from eolab_app.processing.models import (
    ArtifactDownload,
    JobListResponse,
    JobStatusRequest,
    JobStatusResponse,
    ProcessingError,
)
from eolab_app.processing.clip_models import ClipJobRequest, ClipJobResponse
from eolab_app.processing.aggregate_models import (
    AggregateJobResponse,
    AggregateJobRequest,
    AggregateValidationRequest,
    AggregateBatchRequest,
    AggregateBatchResponse,
    MAX_CALCULATION_BATCH_BYTES,
    MAX_CALCULATION_ITEM_BYTES,
)
from eolab_app.processing.polygon_areas import (
    MAX_POLYGON_AREA_BYTES,
    PolygonSummaryInput,
    PolygonAreaUploadResponse,
)
from eolab_app.processing.service import ProcessingService
from eolab_app.processing.model_run_contracts import (
    ModelJobResponse,
    ModelInvocation,
    ModelLibrary,
    ModelRunList,
    ModelRunNameRequest,
    ModelRunRequest,
    ModelArtifactManifest,
    ModelDeletionAction,
)
from eolab_app.routes.processing_events import JobEventResponse
from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.raster.errors import RasterFeatureError
from eolab_app.routes.raster_http import raster_http_exception
from eolab_app.routes.http_disconnect import wait_for_http_disconnect
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)
from eolab_app.rendering.artifact_preview import ArtifactPreviewError
from eolab_app.source_files import SourceFileError

SupportedJobResponse = Annotated[
    ClipJobResponse | AggregateJobResponse | ModelJobResponse,
    Field(discriminator="operation"),
]

COOKIE = "__Host-eolab-processing"
JobId = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
MUTATION_SCHEMA = {
    "parameters": [
        {
            "in": "header",
            "name": "X-EOLab-Processing",
            "required": True,
            "schema": {"type": "string", "enum": ["1"], "default": "1"},
        }
    ]
}


class RequestSizeLimitedRoute(APIRoute):
    """Reject oversized processing requests before FastAPI parses their JSON."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Wrap the endpoint with its request-body size check.

        Returns:
            A request handler enforcing upload, batch and ordinary mutation size limits.
        """
        handler = super().get_route_handler()

        async def check_request_size(request: Request) -> Response:
            """Read a POST or PATCH body and enforce this endpoint's byte limit.

            Args:
                request: The incoming HTTP request before JSON parsing.

            Returns:
                The endpoint's normal response when the body fits its limit.

            Raises:
                HTTPException: If the body exceeds this endpoint's byte limit.
            """
            if request.method not in {"POST", "PATCH"}:
                return await handler(request)
            limit = (
                MAX_POLYGON_AREA_BYTES
                if request.url.path == "/api/processing/polygon-areas"
                else (
                    MAX_CALCULATION_BATCH_BYTES
                    if request.url.path == "/api/processing/raster-calculations/batch"
                    else 16 * 1024
                )
            )
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > limit:
                    raise HTTPException(
                        413,
                        f"Processing requests on this endpoint must be smaller than {limit:,} bytes.",
                    )
                body.extend(chunk)
            delivered = False

            async def receive() -> dict[str, Any]:
                """Supply the checked body once, then pass through later disconnect messages.

                Returns:
                    An ASGI request-body message, followed by messages from the original request.
                """
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {
                        "type": "http.request",
                        "body": bytes(body),
                        "more_body": False,
                    }
                return await request.receive()

            return await handler(Request(request.scope, receive))

        return check_request_size


def get_processing_session_owner_hash(
    request: Request, response: Response, session_ttl_seconds: int
) -> str:
    """Identify the browser session allowed to access its processing jobs.

    Creates a random session cookie when needed, renews its lifetime and returns
    its hash for database ownership checks. The raw cookie remains HttpOnly.
    Mutation requests must come from the same origin and include the Processing header.

    Args:
        request: The incoming request and its session cookie.
        response: The response receiving session-cookie and private-cache headers.
        session_ttl_seconds: Cookie lifetime covering retained results and run metadata.

    Returns:
        The session-cookie hash used to keep this browser's jobs private.

    Raises:
        HTTPException: If a mutation fails the origin or Processing-header check.
    """
    if request.method in {"POST", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        if (
            request.headers.get("sec-fetch-site") == "cross-site"
            or (origin and urlsplit(origin).netloc != request.url.netloc)
            or request.headers.get("x-eolab-processing") != "1"
        ):
            raise HTTPException(
                403, "Use a same-origin processing request with X-EOLab-Processing: 1."
            )
    token = request.cookies.get(COOKIE, "")
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        token = secrets.token_hex(32)
    response.set_cookie(
        COOKIE,
        token,
        max_age=session_ttl_seconds,
        secure=True,
        httponly=True,
        samesite="lax",
        path="/",
    )
    response.headers["Cache-Control"] = "private, no-store"
    return hashlib.sha256(token.encode()).hexdigest()


async def _await_service_result(awaitable: Any) -> Any:
    """Await a service call and turn known Processing errors into HTTP errors.

    Args:
        awaitable: The asynchronous service operation to complete.

    Returns:
        The service result when the operation succeeds.

    Raises:
        HTTPException: For a Processing error or catalog-source authorization failure.
    """
    try:
        return await awaitable
    except ProcessingError as error:
        raise HTTPException(
            error.status,
            {"code": error.code, "message": error.detail},
            headers={"Retry-After": "5"} if error.status in {429, 503} else None,
        ) from error
    except RasterFeatureError as error:
        raise raster_http_exception(error) from error


class JobDownloadResponse(FileResponse):
    """Download a job result while keeping its files available for the transfer.

    Renews a transfer lease until delivery finishes or the browser disconnects,
    then releases it so normal cleanup can remove expired files. Supports HEAD
    and byte-range requests.
    """

    def __init__(self, artifact: ArtifactDownload, service: ProcessingService) -> None:
        """Prepare a download after the service has authorized access to the result.

        Args:
            artifact: The file or generated content, filename, media type and transfer lease.
            service: The Processing service that renews and releases the lease.
        """
        super().__init__(
            artifact.path,
            filename=artifact.filename,
            media_type=artifact.media_type,
            headers={
                "ETag": f'"{artifact.sha256}"',
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )
        self.lease = artifact.lease_id
        self.service = service
        self.content = artifact.content

    def _build_labeled_download_response(
        self, request: Request, content: bytes
    ) -> Response:
        """Build a CSV or JSON download containing this user's chosen result labels.

        Args:
            request: The download request, including HEAD and byte-range headers.
            content: Result bytes containing the requesting user's labels.

        Returns:
            The full content, a requested byte range, or a range-not-satisfiable response.
        """
        size = len(content)
        headers = dict(self.headers)
        headers["Content-Length"] = str(size)
        status = 200
        byte_range = request.headers.get("range")
        if (
            byte_range
            and request.headers.get("if-range", headers["etag"]) == headers["etag"]
        ):
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", byte_range)
            start, end = 0, size - 1
            if match and any(match.groups()):
                left, right = match.groups()
                start = int(left) if left else max(0, size - int(right))
                end = min(size - 1, int(right)) if left and right else size - 1
            if not match or not any(match.groups()) or start > end or start >= size:
                return Response(
                    status_code=416, headers={"Content-Range": f"bytes */{size}"}
                )
            content = content[start : end + 1]
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            headers["Content-Length"] = str(len(content))
            status = 206
        return Response(
            b"" if request.method == "HEAD" else content,
            status_code=status,
            headers=headers,
        )

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        """Send the download and keep its transfer lease active until delivery stops.

        Args:
            scope: ASGI request information.
            receive: ASGI function receiving disconnect messages.
            send: ASGI function sending response headers and content.

        Raises:
            RuntimeError: If the lease expires before the download completes.
            TimeoutError: If the download exceeds one hour.
        """

        async def renew_download_lease() -> None:
            """Renew the download lease while the response is being sent.

            Raises:
                RuntimeError: If the service can no longer retain the result for this transfer.
            """
            while True:
                await asyncio.sleep(30)
                if not await self.service.transfer_heartbeat(self.lease):
                    raise RuntimeError("Job transfer lease expired")

        # Keep file transfer completion inside this response's lifetime rather
        # than delegating it to an ASGI path-send extension after returning.
        scope = {
            **scope,
            "extensions": {
                name: value
                for name, value in scope.get("extensions", {}).items()
                if name != "http.response.pathsend"
            },
        }
        delivery = (
            self._build_labeled_download_response(Request(scope), self.content)
            if self.content is not None
            else super()
        )
        response = asyncio.create_task(delivery.__call__(scope, receive, send))
        heartbeat = asyncio.create_task(renew_download_lease())
        disconnect = asyncio.create_task(
            wait_for_http_disconnect(Request(scope, receive))
        )
        tasks = (response, heartbeat, disconnect)
        try:
            async with asyncio.timeout(3600):
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            with suppress(ProcessingError):
                await self.service.transfer_heartbeat(self.lease, release=True)


def create_processing_router(
    service: ProcessingService,
    *,
    session_ttl_seconds: int = 7 * 86_400,
    preview_artifact: (
        Callable[[str, str, str], Awaitable[dict[str, Any]]] | None
    ) = None,
) -> APIRouter:
    """Create endpoints for model discovery, job execution and result downloads.

    Args:
        service: The Processing service handling requests and checking job ownership.
        session_ttl_seconds: Browser cookie lifetime, chosen by application settings
            to cover retained results and metadata; defaults to seven days.
        preview_artifact: Optional display-only delivery callback, composed independently
            from Processing computation and downloads.

    Returns:
        The /api/processing router, usable independently of the map viewer.
    """
    router = APIRouter(
        prefix="/api/processing",
        tags=["processing"],
        route_class=RequestSizeLimitedRoute,
    )

    @router.get("/models", response_model=ModelLibrary)
    async def discover_models(request: Request, response: Response) -> dict[str, Any]:
        """List installed model recipes and their setup fields.

        Args:
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            Every installed model version, including inputs, parameters and definition checksum.
        """
        get_processing_session_owner_hash(request, response, session_ttl_seconds)
        return await _await_service_result(service.list_models())

    @router.get("/models/{model_id}/versions/{model_version}/yaml")
    async def download_model_yaml(
        model_id: Annotated[str, Path(pattern=r"^[a-z][a-z0-9_-]{0,63}$")],
        model_version: Annotated[str, Path(pattern=r"^\d+\.\d+\.\d+$", max_length=32)],
        request: Request,
        response: Response,
    ) -> Response:
        """Download an installed model's reusable YAML recipe.

        Args:
            model_id: The model ID returned by discovery.
            model_version: The installed version to download.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            A YAML attachment describing the model without selecting datasets for a run.

        Raises:
            HTTPException: If the requested model version is unavailable.
        """
        get_processing_session_owner_hash(request, response, session_ttl_seconds)
        data = await _await_service_result(
            service.export_installed_model_yaml(model_id, model_version)
        )
        return Response(
            data,
            media_type="application/yaml",
            headers={
                **dict(response.headers),
                "Content-Disposition": f'attachment; filename="{model_id}-{model_version}.yaml"',
                "X-Content-Type-Options": "nosniff",
            },
        )

    @router.post(
        "/model-runs",
        status_code=202,
        response_model=ModelJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def submit_model_run(
        body: ModelRunRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        """Queue a model run using the user's selected inputs and parameter values.

        Args:
            body: The chosen recipe, inputs, parameters, label and retry ID.
            request: HTTP request carrying Processing and private-upload browser cookies.
            response: Response renewing those cookies and private-cache headers.

        Returns:
            The new job, or the original job when the same submission is retried.

        Raises:
            HTTPException: If inputs are invalid, access is denied, or queue capacity is exhausted.
        """
        job = await _await_service_result(
            service.submit_model_run(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                body,
                upload_owner=get_browser_owner_hash(
                    request, response, mutation_header="X-EOLab-Processing"
                ),
            )
        )
        response.headers["Location"] = f"/api/processing/jobs/{job['jobId']}"
        return job

    @router.get("/model-runs", response_model=ModelRunList)
    async def list_model_runs(
        request: Request,
        response: Response,
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        cursor: Annotated[str | None, Query(max_length=256)] = None,
    ) -> dict[str, Any]:
        """List one page of this browser session's model runs.

        Args:
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.
            limit: Maximum runs to return on this page.
            cursor: The previous page's nextCursor, or None for the newest runs.

        Returns:
            Run statuses and a nextCursor when older runs are available.

        Raises:
            HTTPException: If pagination is invalid or job storage is unavailable.
        """
        return await _await_service_result(
            service.list_model_runs(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                limit,
                cursor,
            )
        )

    async def _download_saved_yaml(
        job_id: JobId,
        document_kind: str,
        request: Request,
        response: Response,
    ) -> Response:
        """Build a YAML download from the recipe or execution details saved with a run.

        Args:
            job_id: The model run to export.
            document_kind: model-yaml for its recipe, or run-yaml for the full run record.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            A YAML attachment using the saved recipe even if the installed model changed.

        Raises:
            HTTPException: If the run belongs to another session, was deleted, or its metadata expired.
        """
        data, filename = await _await_service_result(
            service.export_job_yaml(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
                run=document_kind == "run-yaml",
            )
        )
        return Response(
            data,
            media_type="application/yaml",
            headers={
                **dict(response.headers),
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Content-Type-Options": "nosniff",
            },
        )

    @router.get("/jobs/{job_id}/invocation", response_model=ModelInvocation)
    async def read_saved_model_inputs(
        job_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Return a run's original recipe and inputs with its current editable name.

        Args:
            job_id: The accepted model run's job ID.
            request: The request carrying the browser's Processing session cookie.
            response: The response receiving private-cache and session headers.

        Returns:
            Saved setup data suitable for creating a new editable draft.

        Raises:
            HTTPException: If the session cannot access the run or its metadata expired.
        """
        return await _await_service_result(
            service.get_model_invocation(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
            )
        )

    @router.get("/jobs/{job_id}/model-yaml")
    async def download_saved_model_yaml(
        job_id: JobId, request: Request, response: Response
    ) -> Response:
        """Download the exact Model YAML recipe saved when this run was accepted.

        Args:
            job_id: The job ID returned when the work was submitted.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            A reusable recipe attachment.

        Raises:
            HTTPException: If this session cannot access the saved recipe.
        """
        return await _download_saved_yaml(job_id, "model-yaml", request, response)

    @router.get("/jobs/{job_id}/run-yaml")
    async def download_run_yaml(
        job_id: JobId, request: Request, response: Response
    ) -> Response:
        """Download Run YAML describing this run's inputs, settings and outcome.

        Args:
            job_id: The job ID returned when the work was submitted.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            A run-record attachment.

        Raises:
            HTTPException: If this session cannot access the saved run details.
        """
        return await _download_saved_yaml(job_id, "run-yaml", request, response)

    @router.delete("/polygon-areas/{area_id}", openapi_extra=MUTATION_SCHEMA)
    async def discard_polygon_area(
        area_id: JobId, request: Request, response: Response
    ) -> dict[str, bool]:
        """Delete uploaded polygons without changing runs already using their own copy.

        Args:
            area_id: The uploaded-area ID to delete.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            A deletion acknowledgement, including when the area was already removed.

        Raises:
            HTTPException: If origin checks or storage access fail.
        """
        await _await_service_result(
            service.discard_polygon_area(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                area_id,
            )
        )
        return {"deleted": True}

    @router.post(
        "/polygon-areas",
        response_model=PolygonAreaUploadResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def upload_polygon_area(
        body: PolygonSummaryInput, request: Request, response: Response
    ) -> dict[str, Any]:
        """Upload polygons for use as the analysis area in raster calculations.

        Args:
            body: The polygons in longitude/latitude coordinates.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            A temporary area reference, bounding box and polygon count.

        Raises:
            HTTPException: If the request fails origin, input-size or storage checks.
        """
        return await _await_service_result(
            service.upload_polygon_area(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                body,
            )
        )

    @router.post(
        "/raster-clips",
        status_code=202,
        response_model=ClipJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def submit_raster_clip(
        body: ClipJobRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        """Queue a raster clip for the selected dataset and area.

        Args:
            body: Raster or exact temporal observation, clip area and retry ID.
            request: HTTP request carrying Processing and private-upload browser cookies.
            response: Response renewing those cookies and private-cache headers.

        Returns:
            The accepted job and its status URL, available after the browser disconnects.

        Raises:
            HTTPException: If the request is invalid, access is denied, or capacity is exhausted.
        """
        job = await _await_service_result(
            service.submit_raster_clip(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                body,
                upload_owner=get_browser_owner_hash(
                    request, response, mutation_header="X-EOLab-Processing"
                ),
            )
        )
        response.headers["Location"] = f"/api/processing/jobs/{job['jobId']}"
        return job

    @router.post("/raster-calculations/validate", openapi_extra=MUTATION_SCHEMA)
    async def validate_raster_calculation(
        body: AggregateValidationRequest, request: Request, response: Response
    ) -> dict[str, bool]:
        """Check raster-summary formulas without reading datasets or running calculations.

        Args:
            body: The formulas and source names to validate.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            A success acknowledgement after all formulas pass validation.

        Raises:
            HTTPException: If the request fails origin checks.
        """
        get_processing_session_owner_hash(request, response, session_ttl_seconds)
        return {"valid": True}

    @router.post(
        "/raster-calculations",
        status_code=202,
        response_model=AggregateJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def submit_raster_calculation(
        body: AggregateJobRequest,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Queue raster-summary formulas for the selected dataset and area.

        Args:
            body: The source, area, formulas and retry ID.
            request: HTTP request carrying Processing and private-upload browser cookies.
            response: Response renewing those cookies and private-cache headers.

        Returns:
            The accepted calculation job and its status URL.

        Raises:
            HTTPException: If inputs are invalid, a retry conflicts, or capacity is exhausted.
        """
        job = await _await_service_result(
            service.submit_calculation_inputs(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                body,
                upload_owner=get_browser_owner_hash(
                    request, response, mutation_header="X-EOLab-Processing"
                ),
            )
        )
        response.headers["Location"] = f"/api/processing/jobs/{job['jobId']}"
        return job

    @router.post(
        "/raster-calculations/batch",
        response_model=AggregateBatchResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def submit_raster_calculation_batch(
        body: AggregateBatchRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        """Queue several raster calculations and report success or failure for each.

        Args:
            body: The calculation requests to validate and submit together.
            request: HTTP request carrying Processing and private-upload browser cookies.
            response: Response renewing those cookies and private-cache headers.

        Returns:
            One indexed job or error per item; an invalid item does not reject valid neighbors.

        Raises:
            HTTPException: If the session checks or shared database transaction fail.
        """
        owner = get_processing_session_owner_hash(
            request, response, session_ttl_seconds
        )
        results: list[dict[str, Any]] = []
        valid: list[AggregateJobRequest] = []
        indices: list[int] = []
        for index, item in enumerate(body.items):
            results.append({"index": index})
            if (
                len(
                    json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode()
                )
                > MAX_CALCULATION_ITEM_BYTES
            ):
                results[index]["error"] = {
                    "status": 413,
                    "code": "request_too_large",
                    "message": "Each calculation must fit within 16 KiB.",
                    "retryAfterSeconds": None,
                }
                continue
            try:
                valid.append(AggregateJobRequest.model_validate(item))
                indices.append(index)
            except ValidationError as error:
                results[index]["error"] = {
                    "status": 422,
                    "code": "invalid_calculation",
                    "message": "; ".join(
                        part["msg"] for part in error.errors(include_input=False)
                    ),
                    "retryAfterSeconds": None,
                }
        if valid:
            outcomes = await _await_service_result(
                service.submit_calculation_batch(
                    owner,
                    valid,
                    upload_owner=get_browser_owner_hash(
                        request, response, mutation_header="X-EOLab-Processing"
                    ),
                )
            )
            for index, outcome in zip(indices, outcomes, strict=True):
                if isinstance(outcome, ProcessingError):
                    results[index]["error"] = {
                        "status": outcome.status,
                        "code": outcome.code,
                        "message": outcome.detail,
                        "retryAfterSeconds": (
                            5 if outcome.status in {429, 503} else None
                        ),
                    }
                else:
                    results[index]["job"] = outcome
        return {"items": results}

    @router.get("/jobs", response_model=JobListResponse[SupportedJobResponse])
    async def list_recent_jobs(request: Request, response: Response) -> dict[str, Any]:
        """List this browser's 50 most recent raster clip and statistics jobs.

        Args:
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            Recent job summaries. Older jobs remain readable by ID; model history uses /model-runs.

        Raises:
            HTTPException: If job storage is unavailable.
        """
        return {
            "jobs": await _await_service_result(
                service.list_owned(
                    get_processing_session_owner_hash(
                        request, response, session_ttl_seconds
                    )
                )
            )
        }

    @router.post(
        "/jobs/status",
        response_model=JobStatusResponse[SupportedJobResponse],
        openapi_extra=MUTATION_SCHEMA,
    )
    async def read_job_statuses(
        body: JobStatusRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        """Read the current status of several jobs belonging to this browser session.

        Args:
            body: One to 100 job IDs; duplicate IDs are returned once.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            Matching job statuses and IDs that are unavailable to this session.

        Raises:
            HTTPException: If the request fails origin checks or job storage is unavailable.
        """
        return await _await_service_result(
            service.read_job_statuses(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                body.jobIds,
            )
        )

    @router.get(
        "/events",
        response_class=StreamingResponse,
        responses={
            200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}
        },
    )
    async def stream_job_updates(request: Request, response: Response) -> Response:
        """Stream notifications when this browser session's jobs change.

        Args:
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            An event stream telling the client to refresh job statuses through the status endpoints.

        Raises:
            HTTPException: If the request is cross-origin or the event subscription is unavailable.
        """
        origin = request.headers.get("origin")
        if request.headers.get("sec-fetch-site") == "cross-site" or (
            origin and urlsplit(origin).netloc != request.url.netloc
        ):
            raise HTTPException(403, "Use same-origin job updates.")
        subscription = await _await_service_result(
            service.subscribe_jobs(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                )
            )
        )
        return JobEventResponse(subscription, dict(response.headers))

    @router.get("/jobs/{job_id}", response_model=SupportedJobResponse)
    async def get_job_status(
        job_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Read a job's status, progress, errors and result availability.

        Args:
            job_id: The job ID returned when the work was submitted.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            The current job status for this browser session.

        Raises:
            HTTPException: If the job is unavailable to this session.
        """
        return await _await_service_result(
            service.get(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
            )
        )

    @router.patch(
        "/jobs/{job_id}/name",
        response_model=ModelJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def rename_model_run(
        job_id: JobId,
        body: ModelRunNameRequest,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Rename a model run and its downloads without changing its calculation.

        Args:
            job_id: Owned model-run identity.
            body: Replacement name, without the run's fixed creation timestamp.
            request: Same-origin request carrying the browser session cookie.
            response: Response receiving the renewed session cookie.

        Returns:
            Updated run status and readable output names.

        Raises:
            HTTPException: If ownership, origin or run availability rejects the edit.
        """
        return await _await_service_result(
            service.rename_model_run(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
                body,
            )
        )

    @router.post(
        "/jobs/{job_id}/renew",
        response_model=SupportedJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def renew_model_run(
        job_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Extend an available model run's files and details by seven days from now.

        Args:
            job_id: The owned model run to keep available.
            request: Same-origin request carrying the browser session cookie.
            response: Response receiving the renewed session cookie.

        Returns:
            Updated run state; an already later expiry is preserved.

        Raises:
            HTTPException: If ownership, origin, run kind or availability rejects renewal.
        """
        return await _await_service_result(
            service.renew_model_run(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
            )
        )

    @router.post(
        "/jobs/{job_id}/cancel",
        status_code=202,
        response_model=SupportedJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def cancel_job(
        job_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Ask the worker to stop a job belonging to this browser session.

        Args:
            job_id: The job ID returned when the work was submitted.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            The updated job; a running job remains cancelling until its calculation stops.

        Raises:
            HTTPException: If the job is unavailable to this session.
        """
        return await _await_service_result(
            service.cancel(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
            )
        )

    @router.delete(
        "/jobs/{job_id}",
        response_model=SupportedJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def delete_job(
        job_id: JobId, request: Request, response: Response, undo: bool = False
    ) -> dict[str, Any]:
        """Delete a finished job's results from this browser session's history.

        Args:
            job_id: The job ID returned when the work was submitted.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.
            undo: Request thirty seconds to undo deletion of a model run.

        Returns:
            The deleted job status; file cleanup runs after active downloads finish.

        Raises:
            HTTPException: If the job is unavailable to this session or is still running.
        """
        return await _await_service_result(
            service.cancel(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
                delete=True,
                undo=undo,
            )
        )

    @router.post(
        "/jobs/{job_id}/deletion/{action}",
        response_model=ModelJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def resolve_model_deletion(
        job_id: JobId,
        action: Literal["undo", "dismiss"],
        body: ModelDeletionAction,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Restore a deleted model run or dismiss its thirty-second Undo offer.

        Args:
            job_id: Owned model run ID.
            action: Undo the exact deletion or dismiss its remaining Undo time.
            body: Identity returned by that deletion, preventing stale actions.
            request: Same-origin request carrying the browser session cookie.
            response: Response receiving refreshed session and private-cache headers.

        Returns:
            Current run state without changing its original expiry.

        Raises:
            HTTPException: If ownership, run kind, deletion identity or time rejects it.
        """
        return await _await_service_result(
            service.resolve_model_deletion(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
                body.deletionId,
                action == "undo",
            )
        )

    @router.get("/jobs/{job_id}/artifacts", response_model=ModelArtifactManifest)
    async def list_model_artifacts(
        job_id: JobId, request: Request, response: Response
    ) -> Any:
        """List the current session's complete files from one model run.

        Args:
            job_id: Owned model-run ID.
            request: Request carrying the Processing session cookie.
            response: Response receiving private-cache and session headers.

        Returns:
            File manifest with download availability and expiry.

        Raises:
            HTTPException: If this session cannot access the run.
        """
        return await _await_service_result(
            service.list_model_artifacts(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
            )
        )

    @router.get("/jobs/{job_id}/artifacts/{artifact_id}/preview")
    async def preview_model_artifact(
        job_id: JobId, artifact_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Read a private GeoJSON map preview while its requesting browser is connected.

        Args:
            job_id: Opaque model-run identity.
            artifact_id: Opaque file identity within the run.
            request: Browser-session credentials and disconnect observer.
            response: Response receiving private, no-store headers.

        Returns:
            Bounded vector geometry for display only.

        Raises:
            HTTPException: If unauthorized, expired, unsupported, busy or disconnected.
        """
        owner = get_processing_session_owner_hash(
            request, response, session_ttl_seconds
        )
        if preview_artifact is None:
            raise HTTPException(
                503,
                "Map previews are unavailable. Downloads still work.",
                headers={"Cache-Control": "private, no-store"},
            )
        try:
            return await run_until_http_disconnect(
                request,
                _await_service_result(preview_artifact(owner, job_id, artifact_id)),
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Map preview cancelled") from error
        except (ArtifactPreviewError, SourceFileError) as error:
            headers = {"Cache-Control": "private, no-store"}
            detail: str | dict[str, str] = str(error)
            if isinstance(error, SourceFileError) and error.code is not None:
                # Preserve the existing Processing failure response through the
                # neutral source-access port, including its retry guidance.
                detail = {"code": error.code, "message": str(error)}
                if error.status in {429, 503}:
                    headers["Retry-After"] = "5"
            raise HTTPException(error.status, detail, headers=headers) from error
        except HTTPException as error:
            error.headers = {
                **(error.headers or {}),
                "Cache-Control": "private, no-store",
            }
            raise

    @router.get("/jobs/{job_id}/artifacts/{artifact_id}")
    @router.head("/jobs/{job_id}/artifacts/{artifact_id}")
    async def download_model_artifact(
        job_id: JobId, artifact_id: JobId, request: Request, response: Response
    ) -> Response:
        """Download one named run file with ownership and transfer-lease protection.

        Args:
            job_id: Owned model-run ID.
            artifact_id: Opaque file ID from that run's manifest.
            request: Request carrying session credentials and an optional byte range.
            response: Response receiving private-cache and session headers.

        Returns:
            File response retaining the run's files through this download.

        Raises:
            HTTPException: If the range, file identity or access is invalid.
        """
        range_header = request.headers.get("range", "")
        if len(range_header) > 128 or "," in range_header:
            raise HTTPException(416, "Use one byte range per job download request.")
        artifact = await _await_service_result(
            service.download_model_artifact(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
                artifact_id,
            )
        )
        return JobDownloadResponse(artifact, service)

    @router.api_route("/jobs/{job_id}/result", methods=["GET", "HEAD"])
    async def download_job_result(
        job_id: JobId, request: Request, response: Response
    ) -> Response:
        """Download this job's result file, optionally as a single byte range.

        Args:
            job_id: The job ID returned when the work was submitted.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            A download response that keeps the result available while it is being sent.

        Raises:
            HTTPException: If the range is invalid or the result is unavailable to this session.
        """
        range_header = request.headers.get("range", "")
        if len(range_header) > 128 or "," in range_header:
            raise HTTPException(416, "Use one byte range per job download request.")
        artifact = await _await_service_result(
            service.download(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
            )
        )
        return JobDownloadResponse(artifact, service)

    @router.get("/jobs/{job_id}/provenance")
    async def download_job_provenance(
        job_id: JobId, request: Request, response: Response
    ) -> Response:
        """Download the inputs, calculation settings and checksum recorded for a result.

        Args:
            job_id: The job ID returned when the work was submitted.
            request: The HTTP request carrying the browser's Processing session cookie.
            response: The response receiving session-cookie and private-cache headers.

        Returns:
            A JSON provenance attachment.

        Raises:
            HTTPException: If the result is unavailable to this session.
        """
        artifact = await _await_service_result(
            service.download(
                get_processing_session_owner_hash(
                    request, response, session_ttl_seconds
                ),
                job_id,
                provenance=True,
            )
        )
        return JobDownloadResponse(artifact, service)

    return router
