"""SSE wire format and response lifetime for Processing-owned change hints."""

import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import Any

from starlette.responses import StreamingResponse
from starlette.requests import Request

from eolab_app.processing.models import ProcessingError
from eolab_app.processing.ports import JobSubscription
from eolab_app.routes.http_disconnect import wait_for_http_disconnect


class JobEventResponse(StreamingResponse):
    """A private bounded stream that never includes job data or owner identifiers."""

    def __init__(
        self,
        subscription: JobSubscription,
        headers: dict[str, str],
        *,
        heartbeat_seconds: float = 15,
        lifetime_seconds: float = 300,
    ) -> None:
        """Configure SSE and retain its already-authorized subscription.

        Args:
            subscription: Reserved session-specific hint source.
            headers: Existing session cookie/cache headers from the HTTP boundary.
            heartbeat_seconds: Maximum idle interval before sending a comment.
            lifetime_seconds: Stream lifetime before ordinary EventSource reconnect.
        """
        self.subscription = subscription
        self.heartbeat_seconds = heartbeat_seconds
        self.lifetime_seconds = lifetime_seconds
        self.previous_send_seconds = 0.0
        super().__init__(
            self._events(),
            media_type="text/event-stream",
            headers={
                **{
                    key: value
                    for key, value in headers.items()
                    if key.lower() != "content-length"
                },
                "cache-control": "private, no-store, no-transform",
                "x-accel-buffering": "no",
                "x-content-type-options": "nosniff",
            },
        )

    async def _events(self) -> AsyncIterator[str]:
        """Request an initial snapshot, then send hints or idle heartbeats.

        Yields:
            Fixed change hints and optional numeric timing frames. Timings measure
            listener receipt to stream handoff, never database commit or browser receipt.
        """
        # Subscribe-before-snapshot also closes the completion-before-connect race.
        yield "retry: 2000\nevent: changed\ndata: {}\n\n"
        try:
            while True:
                changed = await self.subscription.wait(self.heartbeat_seconds)
                if changed:
                    received_at = self.subscription.received_at
                    if received_at is not None:
                        timing = json.dumps(
                            {
                                "listenerToStreamSeconds": max(
                                    0.0, time.perf_counter() - received_at
                                ),
                                "previousSendSeconds": self.previous_send_seconds,
                            }
                        )
                        yield f"event: timing\ndata: {timing}\n\nevent: changed\ndata: {{}}\n\n"
                    else:
                        yield "event: changed\ndata: {}\n\n"
                else:
                    yield ": keepalive\n\n"
        except ProcessingError:
            return

    async def _send(self, send: Any) -> None:
        """Bound the entire stream, including slow-client backpressure.

        Args:
            send: ASGI sender; completion gets at most one extra second to flush.
        """
        try:

            async def measured_send(message: dict[str, Any]) -> None:
                """Measure ASGI handoff, not browser receipt, of the previous frame.

                Args:
                    message: Streaming response start, body, or terminator.
                """
                started = time.perf_counter()
                await send(message)
                self.previous_send_seconds = time.perf_counter() - started

            async with asyncio.timeout(self.lifetime_seconds):
                await self.stream_response(measured_send)
        except TimeoutError:
            async with asyncio.timeout(1):
                await send(
                    {"type": "http.response.body", "body": b"", "more_body": False}
                )

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        """Return subscription capacity even if streaming never starts.

        Args:
            scope: ASGI response scope.
            receive: ASGI request/disconnect receiver.
            send: ASGI streaming sender.
        """
        stream = asyncio.create_task(self._send(send))
        disconnect = asyncio.create_task(
            wait_for_http_disconnect(Request(scope, receive))
        )
        tasks = (stream, disconnect)
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            try:
                await asyncio.gather(*tasks, return_exceptions=True)
            finally:
                self.subscription.close()
