"""Owned SSE delivery, bounded fanout and database notification boundaries."""

import asyncio
import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.processing.job_events import PostgresJobEvents
from eolab_app.processing.job_notifications import (
    PostgresNotifications,
    JOB_CHANGE_CHANNEL,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.service import ProcessingService
from eolab_app.routes.processing import COOKIE, create_processing_router
from eolab_app.routes.processing_events import JobEventResponse
from test_processing_wakeup import Connection


def test_notifications_are_owner_isolated_coalesced_and_bounded(monkeypatch):
    """Do not broadcast another session's job changes or retain unbounded events.

    Args:
        monkeypatch: Replace only PostgreSQL's notification transport.
    """

    async def scenario():
        """Fan out real adapter messages to two owners and reclaim stream slots."""
        connection = Connection()
        monkeypatch.setattr(
            psycopg.AsyncConnection, "connect", AsyncMock(return_value=connection)
        )
        hub = PostgresJobEvents(max_streams=3, max_owner_streams=2)
        hub.start()
        await asyncio.sleep(0)
        a, another_a, b = (
            hub.subscribe("a" * 64),
            hub.subscribe("a" * 64),
            hub.subscribe("b" * 64),
        )
        try:
            with pytest.raises(ProcessingError):
                hub.subscribe("a" * 64)
            with pytest.raises(ProcessingError):
                hub.subscribe("c" * 64)
            for _ in range(100):
                connection.messages.put_nowait(SimpleNamespace(payload="a" * 64))
            await asyncio.sleep(0)
            assert await a.wait(0.1) and await another_a.wait(0.1)
            assert not await b.wait(0.01)
            assert not await a.wait(0.01)
            connection.messages.put_nowait(SimpleNamespace(payload="not-an-owner"))
            assert not await b.wait(0.01)
            a.close()
            a.close()
            c = hub.subscribe("c" * 64)
            # A lost connection asks all active owners to fetch fresh snapshots.
            connection.messages.put_nowait(psycopg.OperationalError("lost"))
            assert await b.wait(0.1) and await c.wait(0.1)
        finally:
            await hub.close()
        assert hub.count == 0
        connection.close.assert_awaited()
        with pytest.raises(ProcessingError):
            hub.subscribe("a" * 64)

    asyncio.run(scenario())


def test_close_before_listener_starts_releases_capacity():
    """Application shutdown also handles a listener task that never entered."""

    async def scenario():
        """Close immediately after composition starts the provider."""
        hub = PostgresJobEvents()
        subscription = hub.subscribe("a" * 64)
        hub.start()
        await hub.close()
        assert hub.count == 0
        with pytest.raises(ProcessingError):
            await subscription.wait(0.1)

    asyncio.run(scenario())


def scope(headers=(), spec="2.0"):
    """Construct a real ASGI request for the public events endpoint.

    Args:
        headers: Raw HTTP request headers.
        spec: ASGI response/disconnect contract to exercise.

    Returns:
        Complete HTTPS scope without application internals.
    """
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": spec},
        "method": "GET",
        "scheme": "https",
        "path": "/api/processing/events",
        "raw_path": b"/api/processing/events",
        "query_string": b"",
        "root_path": "",
        "headers": list(headers),
        "server": ("testserver", 443),
        "client": ("127.0.0.1", 1234),
        "http_version": "1.1",
    }


@pytest.mark.parametrize("asgi_spec", ["2.0", "2.4"])
def test_sse_route_streams_hints_then_releases_on_disconnect(monkeypatch, asgi_spec):
    """Exercise actual ASGI streaming with the existing session service boundary.

    Args:
        monkeypatch: Replace PostgreSQL transport, leaving routing/service intact.
        asgi_spec: Server's ASGI streaming and disconnect contract.
    """

    async def scenario():
        """Connect, observe immediate and committed-change frames, then disconnect."""
        connection = Connection()
        monkeypatch.setattr(
            psycopg.AsyncConnection, "connect", AsyncMock(return_value=connection)
        )
        hub = PostgresJobEvents()
        hub.start()
        await asyncio.sleep(0)
        service = ProcessingService(None, None, changes=hub)
        app = FastAPI()
        app.include_router(create_processing_router(service))
        assert (
            "text/event-stream"
            in app.openapi()["paths"]["/api/processing/events"]["get"]["responses"][
                "200"
            ]["content"]
        )
        token = "a" * 64
        owner = hashlib.sha256(token.encode()).hexdigest()
        disconnect, initial, changed = asyncio.Event(), asyncio.Event(), asyncio.Event()
        messages = []

        async def receive():
            """Hold the connection until the simulated browser disconnects."""
            await disconnect.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            """Collect frames as they arrive, without buffering the full response.

            Args:
                message: Real ASGI HTTP start/body message.
            """
            messages.append(message)
            if message[
                "type"
            ] == "http.response.body" and b"event: changed" in message.get("body", b""):
                (changed if initial.is_set() else initial).set()

        task = asyncio.create_task(
            app(
                scope([(b"cookie", f"{COOKIE}={token}".encode())], asgi_spec),
                receive,
                send,
            )
        )
        try:
            await asyncio.wait_for(initial.wait(), 1)
            assert hub.count == 1
            headers = dict(messages[0]["headers"])
            assert headers[b"content-type"].startswith(b"text/event-stream")
            assert b"no-store" in headers[b"cache-control"]
            assert headers[b"x-accel-buffering"] == b"no"
            assert b"content-length" not in headers
            connection.messages.put_nowait(SimpleNamespace(payload=owner))
            await asyncio.wait_for(changed.wait(), 1)
            body = b"".join(m.get("body", b"") for m in messages)
            assert b"retry: 2000" in body
            assert owner.encode() not in body and token.encode() not in body
            disconnect.set()
            await asyncio.wait_for(task, 1)
            assert hub.count == 0
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await hub.close()

    asyncio.run(scenario())


def test_sse_origin_and_unavailable_provider_use_normal_http_errors():
    """Cross-origin streams and unavailable providers never consume stream slots."""
    service = ProcessingService(None, None)
    app = FastAPI()
    app.include_router(create_processing_router(service))
    with TestClient(app, base_url="https://testserver") as client:
        assert (
            client.get(
                "/api/processing/events", headers={"Origin": "https://other.example"}
            ).status_code
            == 403
        )
        assert (
            client.get(
                "/api/processing/events", headers={"Sec-Fetch-Site": "cross-site"}
            ).status_code
            == 403
        )
        response = client.get("/api/processing/events")
        assert response.status_code == 503 and response.headers["retry-after"] == "5"


@pytest.mark.parametrize("failed_send", [False, True])
def test_stream_heartbeat_lifetime_and_send_failure_release_capacity(failed_send):
    """Bound slow/abandoned streams and close even before their first body frame.

    Args:
        failed_send: Fail ASGI sending before the body starts instead of expiring.
    """

    async def scenario():
        """Use short transport limits without changing production limits."""
        hub = PostgresJobEvents()
        subscription = hub.subscribe("a" * 64)
        calls = 0

        async def wait(timeout):
            """Provide one heartbeat then wait until the response deadline.

            Args:
                timeout: Requested transport heartbeat bound.

            Returns:
                False for the first heartbeat; subsequent waits are cancelled.
            """
            nonlocal calls
            calls += 1
            if calls == 1:
                return False
            await asyncio.Future()

        response = JobEventResponse(
            SimpleNamespace(wait=wait, close=subscription.close),
            {},
            heartbeat_seconds=0.005,
            lifetime_seconds=0.02,
        )
        messages = []

        async def send(message):
            """Record writes or simulate a socket failure.

            Args:
                message: ASGI response frame.
            """
            if failed_send:
                raise OSError("closed")
            messages.append(message)

        async def receive():
            """Keep the peer connected until the bounded stream ends."""
            await asyncio.Future()

        if failed_send:
            with pytest.raises(Exception):
                await response(scope(spec="2.4"), receive, send)
        else:
            await response(scope(spec="2.4"), receive, send)
            assert any(b": keepalive" in m.get("body", b"") for m in messages)
        assert hub.count == 0
        await hub.close()

    asyncio.run(scenario())


def test_slow_sse_send_cannot_hold_stream_capacity_forever():
    """A client stalled on a data frame still obeys the response lifetime bound."""

    async def scenario():
        """Hold the first body write and require bounded closure without a peer EOF."""
        hub = PostgresJobEvents()
        subscription = hub.subscribe("a" * 64)
        response = JobEventResponse(subscription, {}, lifetime_seconds=0.02)
        frames = []

        async def send(message):
            """Block data, while allowing the final response terminator to flush.

            Args:
                message: ASGI start/data/terminator frame.
            """
            frames.append(message)
            if message.get("more_body"):
                await asyncio.Future()

        async def receive():
            """The client never actively disconnects."""
            await asyncio.Future()

        async with asyncio.timeout(1):
            await response(scope(), receive, send)
        assert frames[-1]["more_body"] is False
        assert hub.count == 0
        await hub.close()

    asyncio.run(scenario())
