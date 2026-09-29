"""Request and notification timings preserve owner isolation and response semantics."""

import asyncio
import json

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.processing.job_events import PostgresJobEvents
from eolab_app.processing.request_timings import measure_request_stage, request_timings
from eolab_app.routes.processing import BoundedProcessingRoute
from eolab_app.routes.processing_events import JobEventResponse


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
