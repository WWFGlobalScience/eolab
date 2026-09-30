"""Measure Processing JSON delivery outside the route, without retaining requests."""

import asyncio
import logging
import time
from uuid import uuid4

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger("uvicorn.error.processing_timing")


class ProcessingHttpTimings:
    """Add request correlation and application-boundary timings to Processing JSON.

    Response headers describe work before response sending. A matching log entry
    records send durations afterward. Neither boundary measures socket arrival,
    proxy transfer, or client receipt. Streams and downloads are excluded.
    """

    def __init__(self, app: ASGIApp) -> None:
        """Wrap an application without changing its request or response bodies.

        Args:
            app: Next application in the ASGI middleware stack.
        """
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Measure one JSON exchange and cancel its lag probe on every exit.

        Args:
            scope: ASGI connection metadata; no credentials are recorded.
            receive: Original request/disconnect receiver, passed through unchanged.
            send: Original response transport; awaiting it measures handoff only.

        Raises:
            Exception: Original application or transport failures, unchanged.
        """
        path = scope.get("path", "")
        if (
            scope["type"] != "http"
            or not path.startswith("/api/processing/")
            or path.endswith(("/events", "/result", "/provenance"))
        ):
            await self.app(scope, receive, send)
            return
        started = time.perf_counter()
        trace_id = uuid4().hex
        timing = {"entered": started}
        scope.setdefault("state", {})["processing_http_timing"] = timing
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 0.05
        maximum_lag = 0.0

        def sample_loop_delay() -> None:
            """Measure timer lateness while this request is active; retain one maximum."""
            nonlocal deadline, maximum_lag, probe
            now = loop.time()
            maximum_lag = max(maximum_lag, now - deadline)
            deadline = now + 0.05
            probe = loop.call_at(deadline, sample_loop_delay)

        probe = loop.call_at(deadline, sample_loop_delay)
        send_seconds = 0.0
        headers_at = None
        complete_at = None
        status = None

        async def measured_send(message: Message) -> None:
            """Append diagnostic headers and time transport handoff without buffering.

            Args:
                message: Original ASGI response start or body message.

            Raises:
                Exception: The original transport failure, unchanged.
            """
            nonlocal send_seconds, headers_at, complete_at, status
            if message["type"] == "http.response.start":
                headers_at = time.perf_counter()
                status = message["status"]
                values = {
                    "appToHeaders": headers_at - started,
                    "eventLoopLag": max(maximum_lag, loop.time() - deadline),
                }
                if "routeEntered" in timing:
                    values["beforeRoute"] = timing["routeEntered"] - started
                if "routeFinished" in timing:
                    values["afterRoute"] = headers_at - timing["routeFinished"]
                metrics = ", ".join(
                    f"{name};dur={seconds * 1000:.3f}"
                    for name, seconds in values.items()
                )
                headers = list(message.get("headers", []))
                headers.extend(
                    [
                        (b"x-eolab-request-id", trace_id.encode()),
                        (
                            b"server-timing",
                            f'{metrics}, requestId;desc="{trace_id}"'.encode(),
                        ),
                    ]
                )
                message = {**message, "headers": headers}
            send_started = time.perf_counter()
            try:
                await send(message)
            finally:
                send_seconds += time.perf_counter() - send_started
            if message["type"] == "http.response.body" and not message.get(
                "more_body", False
            ):
                complete_at = time.perf_counter()

        try:
            await self.app(scope, receive, measured_send)
        finally:
            probe.cancel()
            route = getattr(scope.get("route"), "path", "unmatched")
            logger.info(
                "processing_http request_id=%s route=%s status=%s app_seconds=%.6f "
                "send_seconds=%.6f headers_to_last_body_seconds=%s complete=%s",
                trace_id,
                route,
                status,
                time.perf_counter() - started,
                send_seconds,
                (
                    f"{complete_at - headers_at:.6f}"
                    if complete_at is not None and headers_at is not None
                    else "unavailable"
                ),
                complete_at is not None,
            )
