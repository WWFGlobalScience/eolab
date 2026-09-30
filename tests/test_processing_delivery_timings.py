"""Request and notification timings preserve owner isolation and response semantics."""

import asyncio
import json
import logging
import re
import time

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.processing.job_events import PostgresJobEvents
from eolab_app.processing.request_timings import measure_request_stage, request_timings
from eolab_app.routes.processing import BoundedProcessingRoute
from eolab_app.routes.processing_events import JobEventResponse
from eolab_app.routes.processing_timings import ProcessingHttpTimings
from starlette.types import Message, Receive, Scope, Send


def test_route_reports_server_time_without_changing_body() -> None:
    """The real bounded route emits numeric timing headers and resets its context."""
    app = FastAPI()
    router = APIRouter(route_class=BoundedProcessingRoute)

    @router.get("/jobs")
    async def jobs() -> dict[str, list]:
        """Return a measured empty listing.

        Returns:
            An unchanged job-list response body.
        """
        with measure_request_stage("jobRead"):
            await asyncio.sleep(0)
        return {"jobs": []}

    app.include_router(router)
    with TestClient(app) as client:
        response = client.get("/jobs")
    assert response.json() == {"jobs": []}
    metrics = {
        metric.split(";")[0].strip(): float(metric.split("dur=")[1])
        for metric in response.headers["server-timing"].split(",")
    }
    assert 0 <= metrics["jobRead"] <= metrics["processing"]
    assert request_timings.get() is None


def test_concurrent_measurements_remain_request_local() -> None:
    """Concurrent tasks never combine their measurements or suppress exceptions."""

    async def scenario() -> None:
        """Overlap two measured request contexts."""

        async def measure(name: str) -> dict[str, float]:
            """Measure a yielding operation in its own context.

            Args:
                name: Distinct test stage.

            Returns:
                Only this task's measurements.
            """
            stages: dict[str, float] = {}
            token = request_timings.set(stages)
            try:
                with measure_request_stage(name):
                    await asyncio.sleep(0)
                with pytest.raises(ValueError), measure_request_stage("failure"):
                    raise ValueError("unchanged")
                return stages
            finally:
                request_timings.reset(token)

        first, second = await asyncio.gather(measure("one"), measure("two"))
        assert set(first) == {"one", "failure"}
        assert set(second) == {"two", "failure"}
        assert request_timings.get() is None

    asyncio.run(scenario())


def test_application_boundary_headers_and_final_send_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Slow pre-route work and transport handoff are distinct from the route timer.

    Args:
        caplog: Capture correlation and final send measurements without credentials.
    """
    app = FastAPI()
    router = APIRouter(prefix="/api/processing", route_class=BoundedProcessingRoute)
    transport_delays: list[float] = []

    @router.get("/jobs")
    async def jobs() -> dict[str, list]:
        """Return an empty job snapshot after briefly blocking the event loop.

        Returns:
            Unchanged public job-list body.
        """
        time.sleep(0.08)
        return {"jobs": []}

    app.include_router(router)

    async def delayed_app(scope: Scope, receive: Receive, send: Send) -> None:
        """Introduce pre-route delay at the real middleware boundary.

        Args:
            scope: Test request scope.
            receive: Original request receiver.
            send: Measured response sender.
        """
        await asyncio.sleep(0.01)
        await app(scope, receive, send)

    async def scenario() -> list[Message]:
        """Exercise ASGI delivery with a slow transport.

        Returns:
            Original response messages with optional timing headers.
        """
        messages: list[Message] = []

        async def receive() -> Message:
            """Return the empty GET body.

            Returns:
                ASGI request message.
            """
            return {"type": "http.request", "body": b""}

        async def send(message: Message) -> None:
            """Delay each response handoff.

            Args:
                message: Outgoing response metadata or bytes.
            """
            send_started = time.perf_counter()
            await asyncio.sleep(0.01)
            messages.append(message)
            transport_delays.append(time.perf_counter() - send_started)

        await ProcessingHttpTimings(delayed_app)(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "method": "GET",
                "path": "/api/processing/jobs",
                "headers": [],
                "query_string": b"",
                "scheme": "https",
                "server": ("test", 443),
            },
            receive,
            send,
        )
        return messages

    with caplog.at_level(logging.INFO, logger="uvicorn.error.processing_timing"):
        messages = asyncio.run(scenario())
    headers = messages[0]["headers"]
    metrics = b", ".join(
        value for key, value in headers if key == b"server-timing"
    ).decode()
    values = {
        name: float(value) for name, value in re.findall(r"(\w+);dur=([\d.]+)", metrics)
    }
    trace = dict(headers)[b"x-eolab-request-id"].decode()
    assert len(trace) == 32 and trace in metrics and trace in caplog.text
    assert values["beforeRoute"] >= 5
    assert values["eventLoopLag"] >= 20
    assert values["appToHeaders"] >= values["processing"]
    assert json.loads(messages[-1]["body"]) == {"jobs": []}
    assert "complete=True" in caplog.text
    reported_send = float(re.search(r"send_seconds=([\d.]+)", caplog.text)[1])
    assert reported_send == pytest.approx(sum(transport_delays), abs=0.002)
    assert len(transport_delays) == 2


def test_application_timing_preserves_errors_and_skips_streams() -> None:
    """Diagnostic middleware leaves validation, SSE, and non-Processing routes alone."""
    app = FastAPI()
    app.add_middleware(ProcessingHttpTimings)
    router = APIRouter(prefix="/api/processing", route_class=BoundedProcessingRoute)

    @router.get("/jobs")
    async def jobs(count: int) -> dict[str, int]:
        """Return a validated test count.

        Args:
            count: Required integer query field.

        Returns:
            Validated count.
        """
        return {"count": count}

    app.include_router(router)
    with TestClient(app) as client:
        error = client.get("/api/processing/jobs")
        assert error.status_code == 422 and "detail" in error.json()
        assert "x-eolab-request-id" in error.headers
        for path in (
            "/healthz",
            "/api/processing/events",
            "/api/processing/jobs/id/result",
        ):
            assert "x-eolab-request-id" not in client.get(path).headers


def test_sse_timing_is_coalesced_private_metadata_not_job_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Receipt-to-stream durations use one clock and retain the fixed change hint.

    Args:
        monkeypatch: Replace the shared monotonic clock with controlled values.
    """
    now = [10.0]
    monkeypatch.setattr(
        "eolab_app.processing.job_events.time.perf_counter", lambda: now[0]
    )

    async def scenario() -> None:
        """Consume an owner-scoped burst without exposing identity or job data."""
        hub = PostgresJobEvents()
        subscription = hub.subscribe("a" * 64)
        response = JobEventResponse(subscription, {})
        stream = response._events()
        assert await anext(stream) == "retry: 2000\nevent: changed\ndata: {}\n\n"
        hub._notify("b" * 64)
        assert not subscription.pending.is_set()
        hub._notify("a" * 64)
        now[0] = 10.2
        hub._notify("a" * 64)
        now[0] = 10.5
        event = await anext(stream)
        data = json.loads(event.split("data: ")[1].split("\n")[0])
        assert data == {"listenerToStreamSeconds": 0.5, "previousSendSeconds": 0.0}
        assert event.endswith("event: changed\ndata: {}\n\n")
        assert "a" * 64 not in event
        assert subscription.pending_received_at is None
        await stream.aclose()
        subscription.close()
        await hub.close()

    asyncio.run(scenario())
