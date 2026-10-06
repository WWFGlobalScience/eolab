"""Bounded submission observation through owned storage and notification ports."""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import Mock

import pytest

from eolab_app.processing.aggregate_models import AggregateJobRequest
from eolab_app.processing.job_events import PostgresJobEvents
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.service import ProcessingService
from test_raster_clips import SOURCE


def queued_row(identifier: str) -> dict[str, Any]:
    """Create the owned queued snapshot returned by a storage port.

    Args:
        identifier: Public subscriber identifier.

    Returns:
        Path-free lifecycle fixture without a result artifact.
    """
    now = datetime.now(timezone.utc)
    return dict(
        id=identifier,
        operation="raster.aggregate.v1",
        status="queued",
        spec={},
        created_at=now,
        updated_at=now,
        expires_at=now + timedelta(hours=1),
        progress={},
        error=None,
        artifact=None,
    )


@pytest.mark.parametrize(
    "mode", ["hint", "missed", "mixed", "failed", "closed", "capacity", "cancelled"]
)
def test_submission_observes_committed_state_and_releases_capacity(mode: str) -> None:
    """One deadline preserves outcomes, missed hints, ownership and subscription cleanup.

    Args:
        mode: Notification, lifecycle or capacity transition under observation.
    """

    async def scenario() -> None:
        """Submit through the service using controlled storage and real fanout."""
        owner = "a" * 64
        hub = PostgresJobEvents(max_streams=1)
        rows = [queued_row("1" * 32), queued_row("2" * 32)]
        rejection = ProcessingError("queue_full", "Busy", 429)
        store = Mock()
        store.submit_batch.return_value = [dict(row) for row in rows] + [rejection]
        first_read = asyncio.Event()
        loop = asyncio.get_running_loop()

        def read(asked_owner: str, identifiers: list[str]) -> list[dict[str, Any]]:
            """Read only requested owned snapshots and signal waiter registration.

            Args:
                asked_owner: Hash provided to the storage port.
                identifiers: Requested public job IDs.

            Returns:
                Current authoritative fixture states.
            """
            assert asked_owner == owner
            assert hub.count == 1
            loop.call_soon_threadsafe(first_read.set)
            return [dict(row) for row in rows if row["id"] in identifiers]

        store.read_owned_jobs.side_effect = read
        service = ProcessingService(
            store, Mock(), changes=hub, submission_wait_seconds=0.03
        )
        request = AggregateJobRequest(
            requestId="submission-wait-fixture",
            sources={"a": SOURCE},
            wholeRaster=True,
            calculations=[{"label": "Mean", "expression": "mean(a)"}],
        )
        occupied = hub.subscribe(owner) if mode == "capacity" else None
        task = asyncio.create_task(
            service.submit_calculation_batch(owner, [request] * 3)
        )
        try:
            if mode == "capacity":
                result = await task
                store.read_owned_jobs.assert_not_called()
                assert [job["status"] for job in result[:2]] == ["queued", "queued"]
            else:
                await asyncio.wait_for(first_read.wait(), 1)
                if mode == "cancelled":
                    task.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await task
                    assert rows[0]["status"] == "queued"
                else:
                    rows[0]["status"] = "failed" if mode == "failed" else "ready"
                    if mode != "mixed":
                        rows[1]["status"] = rows[0]["status"]
                    if mode == "failed":
                        for row in rows:
                            row["error"] = {
                                "code": "source_unavailable",
                                "detail": "Unavailable",
                            }
                    if mode == "closed":
                        for subscription in tuple(hub.owners[owner]):
                            subscription.close()
                    elif mode != "missed":
                        hub._notify("b" * 64)
                        assert not next(iter(hub.owners[owner])).pending.is_set()
                        hub._notify(owner)
                    result = await task
                    if mode != "closed":
                        assert result[0]["status"] == rows[0]["status"]
                        assert result[1]["status"] == rows[1]["status"]
                    assert result[2] is rejection
                    assert store.read_owned_jobs.call_count <= 3
            store.submit_batch.assert_called_once()
        finally:
            if occupied:
                occupied.close()
            assert hub.count == 0
            await hub.close()

    asyncio.run(scenario())
