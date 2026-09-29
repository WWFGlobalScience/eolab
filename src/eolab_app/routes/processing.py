"""Thin same-origin HTTP delivery for owned processing jobs and downloads.

Job listing, status, cancellation, deletion, and leased artifact delivery share
one lifecycle. Raster-clip planning and submission are explicitly named operation
commands, alongside single-raster calculation planning and submission.
"""

import asyncio
from contextlib import suppress
import hashlib
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from typing import Annotated, Any
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Path, Request, Response
from fastapi.routing import APIRoute
from pydantic import Field
from starlette.responses import FileResponse, StreamingResponse

from eolab_app.processing.models import (
    ArtifactDownload,
    JobSubmitRequest,
    JobListResponse,
    ProcessingError,
    PlanningResponse,
)
from eolab_app.processing.clip_models import (
    ClipPlanRequest,
    ClipJobResponse,
    ClipPlanResponse,
)
from eolab_app.processing.aggregate_models import (
    AggregateJobResponse,
    AggregateJobRequest,
    AggregatePlanRequest,
    AggregatePlanResponse,
    AggregateValidationRequest,
)
from eolab_app.processing.polygon_areas import (
    MAX_POLYGON_AREA_BYTES,
    PolygonSummaryInput,
    PolygonAreaUploadResponse,
)
from eolab_app.processing.service import ProcessingService
from eolab_app.processing.request_timings import request_timings
from eolab_app.routes.processing_events import JobEventResponse
from eolab_app.raster.errors import RasterFeatureError
from eolab_app.routes.raster_http import raster_http_exception
from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
    wait_for_http_disconnect,
)

SupportedJobResponse = Annotated[
    ClipJobResponse | AggregateJobResponse, Field(discriminator="operation")
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


class BoundedProcessingRoute(APIRoute):
    """Bound calculation requests and polygon uploads before parsing their JSON."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        """Limit polygon uploads to 8 MiB and other POST bodies to 16 KiB.

        Returns:
            Handler retaining normal validation and disconnect semantics.
        """
        handler = super().get_route_handler()

        async def bounded(request: Request) -> Response:
            """Buffer a small POST body and reject oversized chunked bodies.

            Args:
                request: Incoming ASGI request, before JSON parsing.

            Returns:
                The normal route response after bounded input validation.

            Raises:
                HTTPException: If the endpoint-specific body limit is exceeded.
            """
            if request.method != "POST":
                return await handler(request)
            limit = (
                MAX_POLYGON_AREA_BYTES
                if request.url.path == "/api/processing/polygon-areas"
                else 16 * 1024
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
                """Replay the bounded body, then preserve the real disconnect channel.

                Returns:
                    One body message followed by original ASGI receive messages.
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

        async def timed(request: Request) -> Response:
            """Report server handling time without changing validation or errors.

            Args:
                request: Incoming request before body validation.

            Returns:
                Response with optional numeric Server-Timing metadata. The total
                includes serialization but excludes ASGI send and proxy transfer.

            Raises:
                Exception: The original handler's error, unchanged.
            """
            timings: dict[str, float] = {}
            token = request_timings.set(timings)
            started = time.perf_counter()
            try:
                response = await bounded(request)
                timings["processing"] = time.perf_counter() - started
                response.headers["Server-Timing"] = ", ".join(
                    f"{name};dur={seconds * 1000:.3f}"
                    for name, seconds in timings.items()
                )
                return response
            finally:
                request_timings.reset(token)

        return timed


def _owner(request: Request, response: Response) -> str:
    """Mint or read an unguessable session capability without exposing it to JS.

    Args:
        request: Incoming same-origin request.
        response: Response receiving a new secure, HttpOnly cookie when needed.

    Returns:
        One-way session hash used in the job database.

    Raises:
        HTTPException: If a browser attempts a cross-origin mutation.
    """
    if request.method in {"POST", "DELETE"}:
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
            max_age=7 * 86_400,
            secure=True,
            httponly=True,
            samesite="lax",
            path="/",
        )
    response.headers["Cache-Control"] = "private, no-store"
    return hashlib.sha256(token.encode()).hexdigest()


async def _result(awaitable: Any) -> Any:
    """Translate only owned sanitized errors into HTTP responses.

    Args:
        awaitable: Application operation already supplied with validated input.

    Returns:
        Public application result.

    Raises:
        HTTPException: For known processing or catalog authorization failures.
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
    except HttpClientDisconnectedError as error:
        raise HTTPException(499, "The processing plan request was cancelled") from error


class LeasedJobResponse(FileResponse):
    """Range-capable file delivery that keeps expiry cleanup away from transfers."""

    def __init__(self, artifact: ArtifactDownload, service: ProcessingService) -> None:
        """Configure an immutable result response after owner authorization.

        Args:
            artifact: Confined file, media type, and transfer capability.
            service: Owner of the transfer lifecycle.
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

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        """Send bounded chunks/ranges and stop on disconnection or lease loss.

        Args:
            scope: ASGI response scope.
            receive: ASGI disconnection receiver.
            send: ASGI response sender.

        Raises:
            RuntimeError: If the transfer can no longer retain its artifact.
        """

        async def renew() -> None:
            """Renew only while a live response consumes its owned file."""
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
        response = asyncio.create_task(super().__call__(scope, receive, send))
        heartbeat = asyncio.create_task(renew())
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


def create_processing_router(service: ProcessingService) -> APIRouter:
    """Expose owned job lifecycle and explicitly supported operation commands.

    Args:
        service: Composed processing application owner.

    Returns:
        Router independent of map visibility, publication, and histogram state.
    """
    router = APIRouter(
        prefix="/api/processing",
        tags=["processing"],
        route_class=BoundedProcessingRoute,
    )

    @router.delete("/polygon-areas/{area_id}", openapi_extra=MUTATION_SCHEMA)
    async def discard_polygon_area(
        area_id: JobId, request: Request, response: Response
    ) -> dict[str, bool]:
        """Release an uploaded area without changing already accepted calculations.

        Args:
            area_id: Opaque input identifier.
            request: Request carrying the Processing session cookie.
            response: Response receiving private cache headers.

        Returns:
            Idempotent deletion acknowledgement, including unknown IDs.

        Raises:
            HTTPException: If origin checks or storage access fail.
        """
        await _result(service.discard_polygon_area(_owner(request, response), area_id))
        return {"deleted": True}

    @router.post(
        "/polygon-areas",
        response_model=PolygonAreaUploadResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def upload_polygon_area(
        body: PolygonSummaryInput, request: Request, response: Response
    ) -> dict[str, Any]:
        """Upload exact polygons and return a private reference for raster summaries.

        Args:
            body: Bounded WGS84 polygons, without labels or renderer state.
            request: Same-origin request and browser ownership context.
            response: Private cookie and cache headers.

        Returns:
            Expiring area reference, envelope and polygon count.

        Raises:
            HTTPException: If origin checks, input limits or storage access fail.
        """
        return await _result(
            service.upload_polygon_area(_owner(request, response), body)
        )

    @router.post(
        "/raster-clips/plan",
        response_model=ClipPlanResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def plan_raster_clip(
        body: ClipPlanRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        """Plan a bounded native clip from a catalog source and explicit area.

        Args:
            body: Validated source and area request.
            request: HTTP owner and origin context.
            response: Cookie and cache-control response.

        Returns:
            Reviewable expiring clip plan.
        """
        return await _result(
            run_until_http_disconnect(
                request, service.plan_raster_clip(_owner(request, response), body)
            )
        )

    @router.post(
        "/raster-clips/plans/{plan_id}",
        status_code=202,
        response_model=PlanningResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def start_clip_plan(
        body: ClipPlanRequest, plan_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Admit clip planning under a client ID; repeating identical input is safe.

        Args:
            body: Validated catalog raster and explicit area.
            plan_id: Client-generated ID retained across uncertain admission retries.
            request: Same-origin session context.
            response: Private headers and session cookie.

        Returns:
            Current planning state; no clip job has been submitted.

        Raises:
            HTTPException: On ownership, capacity, input or storage failure.
        """
        response.headers["Location"] = f"/api/processing/plans/{plan_id}"
        return await _result(
            service.start_clip_plan(_owner(request, response), plan_id, body)
        )

    @router.post(
        "/raster-calculations/plans/{plan_id}",
        status_code=202,
        response_model=PlanningResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def start_calculation_plan(
        body: AggregatePlanRequest, plan_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Admit calculation planning without holding HTTP open for a planner.

        Args:
            body: Validated catalog source, area and expressions.
            plan_id: Client-generated ID reused on retries with identical input.
            request: Same-origin session context.
            response: Private headers and session cookie.

        Returns:
            Current planning state; callers still explicitly submit the ready plan.

        Raises:
            HTTPException: On ownership, capacity, input or storage failure.
        """
        response.headers["Location"] = f"/api/processing/plans/{plan_id}"
        return await _result(
            service.start_calculation_plan(_owner(request, response), plan_id, body)
        )

    @router.get("/plans/{plan_id}", response_model=PlanningResponse)
    async def get_planning(
        plan_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Read the authoritative planning state, including queued and cancelled work.

        Args:
            plan_id: Owned plan ID.
            request: Current browser session.
            response: Private cache headers.

        Returns:
            Status, completed operation plan and sanitized error.

        Raises:
            HTTPException: If the request expired or is not available to this owner.
        """
        return await _result(service.get_planning(_owner(request, response), plan_id))

    @router.post(
        "/raster-clips",
        status_code=202,
        response_model=ClipJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def submit_raster_clip(
        body: JobSubmitRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        """Accept one reviewed plan with idempotent durable queue admission.

        Args:
            body: Plan ID and client request key.
            request: HTTP owner/origin context.
            response: Response cookie and headers.

        Returns:
            Accepted public job, recoverable after the browser disconnects.
        """
        job = await _result(service.submit_raster_clip(_owner(request, response), body))
        response.headers["Location"] = f"/api/processing/jobs/{job['jobId']}"
        return job

    @router.post("/raster-calculations/validate", openapi_extra=MUTATION_SCHEMA)
    async def validate_raster_calculation(
        body: AggregateValidationRequest, request: Request, response: Response
    ) -> dict[str, bool]:
        """Validate bounded expressions without source, storage, or native I/O.

        Args:
            body: Expressions checked by Processing's shared language schema.
            request: Same-origin request context.
            response: Private cookie and cache headers.

        Returns:
            Success after the language contract has validated all expressions.
        """
        _owner(request, response)
        return {"valid": True}

    @router.post(
        "/raster-calculations/plan",
        response_model=AggregatePlanResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def plan_raster_calculation(
        body: AggregatePlanRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        """Review a native single-raster calculation without starting a job.

        Args:
            body: Validated source, explicit area, and named expressions.
            request: Owner, origin, and disconnect context.
            response: Private cookie and cache headers.

        Returns:
            Reviewable expiring native calculation plan.
        """
        return await _result(
            run_until_http_disconnect(
                request,
                service.plan_raster_calculation(_owner(request, response), body),
            )
        )

    @router.post(
        "/raster-calculations",
        status_code=202,
        response_model=AggregateJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def submit_raster_calculation(
        body: AggregateJobRequest | JobSubmitRequest,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Queue calculation inputs, or accept a prepared plan from an older client.

        Args:
            body: Source, area, formulas and retry key; alternatively a legacy plan ID and key.
            request: Same-origin owner context.
            response: Private cookie and job location headers.

        Returns:
            Accepted owned calculation job.

        Raises:
            HTTPException: For invalid inputs, conflicting retries or exhausted capacity.
        """
        job = await _result(
            service.submit_calculation_inputs(_owner(request, response), body)
            if isinstance(body, AggregateJobRequest)
            else service.submit_raster_calculation(_owner(request, response), body)
        )
        response.headers["Location"] = f"/api/processing/jobs/{job['jobId']}"
        return job

    @router.delete("/plans/{plan_id}", openapi_extra=MUTATION_SCHEMA)
    async def discard_plan(
        plan_id: JobId, request: Request, response: Response
    ) -> dict[str, bool]:
        """Cancel planning or discard a completed review after replacement, idempotently.

        Args:
            plan_id: Opaque review ID.
            request: Same-origin owner context.
            response: Private cookie/cache headers.

        Returns:
            Acknowledgement, without revealing another owner's plans.
        """
        await _result(service.discard_plan(_owner(request, response), plan_id))
        return {"discarded": True}

    @router.get("/jobs", response_model=JobListResponse[SupportedJobResponse])
    async def jobs(request: Request, response: Response) -> dict[str, Any]:
        """Recover the current session's recent jobs and establish its cookie.

        Args:
            request: Current browser session context.
            response: Secure owner-cookie response.

        Returns:
            Bounded owned job summaries.
        """
        return {"jobs": await _result(service.list_owned(_owner(request, response)))}

    @router.get(
        "/events",
        response_class=StreamingResponse,
        responses={
            200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}
        },
    )
    async def events(request: Request, response: Response) -> Response:
        """Stream same-origin owned-job hints; clients still use authorized reads.

        Args:
            request: Existing browser session and origin context.
            response: Secure cookie and private-cache headers.

        Returns:
            Bounded SSE connection with an immediate snapshot-refresh hint.
        """
        origin = request.headers.get("origin")
        if request.headers.get("sec-fetch-site") == "cross-site" or (
            origin and urlsplit(origin).netloc != request.url.netloc
        ):
            raise HTTPException(403, "Use same-origin job updates.")
        subscription = await _result(service.subscribe_jobs(_owner(request, response)))
        return JobEventResponse(subscription, dict(response.headers))

    @router.get("/jobs/{job_id}", response_model=SupportedJobResponse)
    async def get(
        job_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Read one owned job's progress and result availability.

        Args:
            job_id: Strict opaque job ID.
            request: Current browser session.
            response: Private cache policy response.

        Returns:
            Public job state.
        """
        return await _result(service.get(_owner(request, response), job_id))

    @router.post(
        "/jobs/{job_id}/cancel",
        status_code=202,
        response_model=SupportedJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def cancel(
        job_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Request cancellation without releasing active native-work capacity.

        Args:
            job_id: Strict owned job ID.
            request: Current owner/origin context.
            response: Private response metadata.

        Returns:
            Updated job; cancellation completes only after child exit.
        """
        return await _result(service.cancel(_owner(request, response), job_id))

    @router.delete(
        "/jobs/{job_id}",
        response_model=SupportedJobResponse,
        openapi_extra=MUTATION_SCHEMA,
    )
    async def delete(
        job_id: JobId, request: Request, response: Response
    ) -> dict[str, Any]:
        """Revoke a terminal job result and schedule safe artifact cleanup.

        Args:
            job_id: Strict owned terminal job ID.
            request: Current owner/origin context.
            response: Private response metadata.

        Returns:
            Deleted public job state.
        """
        return await _result(
            service.cancel(_owner(request, response), job_id, delete=True)
        )

    @router.api_route("/jobs/{job_id}/result", methods=["GET", "HEAD"])
    async def result(job_id: JobId, request: Request, response: Response) -> Response:
        """Download an owned immutable job result using standard HTTP ranges.

        Args:
            job_id: Strict owned job ID.
            request: Current owner capability and Range headers.
            response: Owner-cookie context.

        Returns:
            Streaming attachment retaining a renewable transfer lease.
        """
        range_header = request.headers.get("range", "")
        if len(range_header) > 128 or "," in range_header:
            raise HTTPException(416, "Use one byte range per job download request.")
        artifact = await _result(service.download(_owner(request, response), job_id))
        return LeasedJobResponse(artifact, service)

    @router.get("/jobs/{job_id}/provenance")
    async def provenance(
        job_id: JobId, request: Request, response: Response
    ) -> Response:
        """Download the owned job's path-free provenance and checksum.

        Args:
            job_id: Strict owned job ID.
            request: Current owner capability.
            response: Owner-cookie context.

        Returns:
            Immutable provenance JSON attachment.
        """
        artifact = await _result(
            service.download(_owner(request, response), job_id, provenance=True)
        )
        return LeasedJobResponse(artifact, service)

    return router
