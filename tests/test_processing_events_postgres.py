"""Real transaction commit/rollback contract for owned job-change hints."""

import asyncio
from contextlib import contextmanager

import numpy as np
import pytest

from eolab_app.processing.job_notifications import (
    JOB_CHANGE_CHANNEL,
    PostgresNotifications,
)
from eolab_app.processing.clip_models import ClipArea
from eolab_app.processing.job_preparation import prepare_clip_job
from test_processing_jobs import store
from test_raster_clips import SOURCE, make_spec, write_source


def test_job_changes_notify_only_commits_and_changed_public_state(
    store, tmp_path, monkeypatch
):
    """Verify the migrated trigger through real storage and notification adapters.

    Args:
        store: Explicitly disposable PostgreSQL fixture, migrated twice.
        tmp_path: Confined raster fixture used for a valid admitted specification.
        monkeypatch: Inject rollback at the real transaction boundary.
    """
    owner = "a" * 64
    path = write_source(tmp_path / "source.tif", np.ones((100, 100), dtype="uint8"))
    spec = prepare_clip_job(
        make_spec(path, ClipArea(kind="bounds", bounds=(0.1, 9.1, 0.9, 9.9)))
    )

    async def scenario():
        """Exercise commit, rollback, idempotency, progress and failure transitions."""
        messages = asyncio.Queue()
        listener = PostgresNotifications(
            JOB_CHANGE_CHANNEL, messages.put_nowait, store.conninfo
        )
        await listener.ensure_connected()
        assert listener.reader is not None

        async def notified():
            """Require exactly the private owner hash from the next committed change."""
            assert await asyncio.wait_for(messages.get(), 1) == owner

        async def quiet():
            """No notification should be emitted for rolled-back or unchanged state."""
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(messages.get(), 0.05)

        transaction = store._transaction

        @contextmanager
        def rollback(*args, **kwargs):
            """Abort after the real INSERT/trigger ran, before transaction commit.

            Args:
                args: Existing transaction options.
                kwargs: Existing transaction keyword options.

            Yields:
                Real database cursor within a transaction that will roll back.
            """
            with transaction(*args, **kwargs) as cursor:
                yield cursor
                raise RuntimeError("rollback")

        try:
            with monkeypatch.context() as patch:
                patch.setattr(store, "_transaction", rollback)
                with pytest.raises(RuntimeError, match="rollback"):
                    await asyncio.to_thread(
                        store.submit, owner, "rolled-back", spec, "fixture-input-hash"
                    )
            await quiet()
            job = await asyncio.to_thread(
                store.submit, owner, "committed", spec, "fixture-input-hash"
            )
            await notified()
            await asyncio.to_thread(
                store.submit, owner, "committed", spec, "fixture-input-hash"
            )
            await quiet()
            claimed = await asyncio.to_thread(store.claim_next_job)
            await notified()
            assert claimed["id"] == job["id"]
            progress = {"phase": "reading"}
            await asyncio.to_thread(
                store.heartbeat, job["id"], claimed["attempt_id"], progress
            )
            await notified()
            await asyncio.to_thread(
                store.heartbeat, job["id"], claimed["attempt_id"], progress
            )
            await quiet()
            assert await asyncio.to_thread(
                store.finish,
                job["id"],
                claimed["attempt_id"],
                None,
                {"code": "test", "detail": "failed"},
            )
            await notified()
            assert not await asyncio.to_thread(
                store.finish, job["id"], claimed["attempt_id"], None
            )
            await quiet()
            await asyncio.to_thread(store.cancel, job["id"], owner, True)
            await notified()
        finally:
            await listener.close()

    with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
        runner.run(scenario())
