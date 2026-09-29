"""Bounded session fanout over one Processing-owned PostgreSQL listener."""

import asyncio
from collections.abc import Callable
import re
import time

from eolab_app.processing.job_notifications import (
    JOB_CHANGE_CHANNEL,
    PostgresNotifications,
)
from eolab_app.processing.models import ProcessingError


class Subscription:
    """One coalescing bit per stream; no retained job payloads or event history."""

    def __init__(self, release: Callable[[], None]) -> None:
        """Reserve a stream until closed.

        Args:
            release: Remove this subscription from its owner's bounded fanout.
        """
        self.pending = asyncio.Event()
        self.release = release
        self.closed = False
        self.received_at: float | None = None
        self.pending_received_at: float | None = None

    async def wait(self, timeout: float) -> bool:
        """Consume the pending hint without dropping changes between waits.

        Args:
            timeout: Heartbeat wait bound in seconds.

        Returns:
            True for a hint or closure, False for a heartbeat timeout.
        """
        try:
            async with asyncio.timeout(timeout):
                await self.pending.wait()
            if self.closed:
                raise ProcessingError("events_closed", "Live job updates closed.", 503)
            self.pending.clear()
            self.received_at = self.pending_received_at
            self.pending_received_at = None
            return True
        except TimeoutError:
            return False

    def close(self) -> None:
        """Idempotently return stream capacity and unblock any pending wait."""
        if not self.closed:
            self.closed = True
            self.release()
            self.pending.set()


class PostgresJobEvents:
    """Share database notifications across bounded, owner-isolated streams."""

    def __init__(
        self, conninfo: str = "", *, max_streams: int = 128, max_owner_streams: int = 4
    ) -> None:
        """Configure fanout without allocating a database connection.

        Args:
            conninfo: Processing database connection or deployment PG* settings.
            max_streams: Per-API-process stream capacity.
            max_owner_streams: Per-session capacity within this API process.
        """
        if max_streams < 1 or max_owner_streams < 1:
            raise ValueError("Stream limits must be positive")
        self.max_streams = max_streams
        self.max_owner_streams = max_owner_streams
        self.owners: dict[str, set[Subscription]] = {}
        self.count = 0
        self.closed = False
        self.task: asyncio.Task | None = None
        self.listener = PostgresNotifications(
            JOB_CHANGE_CHANNEL, self._notify, conninfo
        )

    def _notify(self, owner: str | None) -> None:
        """Wake only the named owner, or all subscribers after reconnect/disconnect.

        Args:
            owner: Validated database owner hash, never the browser capability.
                None requests a fresh snapshot after a transport interruption.
        """
        if owner is not None and not re.fullmatch(r"[a-f0-9]{64}", owner):
            return
        groups = (
            self.owners.values() if owner is None else (self.owners.get(owner, ()),)
        )
        for group in groups:
            for subscription in group:
                if not subscription.pending.is_set():
                    subscription.pending_received_at = time.perf_counter()
                subscription.pending.set()

    def start(self) -> None:
        """Maintain one listener independently of individual browser connections."""
        if not self.closed and self.task is None:
            self.task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        """Reconnect with bounded backoff and refresh snapshots after any gap."""
        try:
            while True:
                if await self.listener.ensure_connected():
                    self._notify(None)
                await asyncio.sleep(5)
        finally:
            await self.listener.close()

    def subscribe(self, owner: str) -> Subscription:
        """Reserve stream capacity for an authenticated session hash.

        Args:
            owner: Current HTTP session's hashed capability.

        Returns:
            Subscription registered before the initial snapshot notification.

        Raises:
            ProcessingError: If closed or stream capacity is exhausted.
            ValueError: If an invalid internal owner identifier is supplied.
        """
        if not re.fullmatch(r"[a-f0-9]{64}", owner):
            raise ValueError("Invalid processing owner")
        if (
            self.closed
            or self.count >= self.max_streams
            or len(self.owners.get(owner, ())) >= self.max_owner_streams
        ):
            raise ProcessingError(
                "events_unavailable",
                "Live job updates are unavailable; status polling remains active.",
                503,
            )

        def release() -> None:
            """Return exactly this stream's reserved fanout capacity."""
            group = self.owners[owner]
            group.remove(subscription)
            self.count -= 1
            if not group:
                del self.owners[owner]

        subscription = Subscription(release)
        self.owners.setdefault(owner, set()).add(subscription)
        self.count += 1
        return subscription

    async def close(self) -> None:
        """Stop the listener and release every remaining stream reservation."""
        self.closed = True
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None
        await self.listener.close()
        for group in list(self.owners.values()):
            for subscription in list(group):
                subscription.close()
