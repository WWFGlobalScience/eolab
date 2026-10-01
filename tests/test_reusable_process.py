"""Real reusable native children: acknowledgement, cancellation and isolation."""

import asyncio
import os
from multiprocessing import active_children
from pathlib import Path
import time
import sys

import pytest

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
)
from eolab_app.execution.reusable_process import ReusableProcess


def echo(writer, value):
    """Return process identity and an arbitrary payload.

    Args:
        writer: Single-result capture supplied by the supervisor.
        value: Picklable test payload.
    """
    writer.put((os.getpid(), value))


def slow(writer, marker, seconds=2):
    """Emit early, then continue native work to test the completion boundary.

    Args:
        writer: Result capture that must wait until this function returns.
        marker: Path recording execution and subsequent completion.
        seconds: Delay after the early result.
    """
    marker.write_text(str(os.getpid()))
    writer.put("early")
    time.sleep(seconds)
    marker.with_suffix(".finished").write_text("finished")


def crash(writer):
    """Exit without a result, as a failed native library might.

    Args:
        writer: Unused result capture.
    """
    os._exit(9)


async def started(path):
    """Wait for real child work, excluding platform-dependent spawn latency.

    Args:
        path: Marker written when the child enters its operation.
    """
    async with asyncio.timeout(10):
        while not path.exists():
            await asyncio.sleep(0.01)


def test_reuses_process_large_payloads_and_recycles() -> None:
    """Reuse preloaded code but never reuse per-request results or pipe messages."""

    async def scenario() -> None:
        """Run three calls through a lane that recycles after two."""
        lane = ReusableProcess((echo,), max_jobs=2)
        lane.warm()
        try:
            first = await lane.run(echo, (b"x" * 2_000_000,), 10)
            second = await lane.run(echo, ("second",), 10)
            third = await lane.run(echo, ("third",), 10)
            assert first.value[0] == second.value[0] != third.value[0]
            assert len(first.value[1]) == 2_000_000
            assert second.value[1] == "second" and third.value[1] == "third"
            assert not first.timing.reusedProcess
            assert second.timing.reusedProcess and not third.timing.reusedProcess
            assert second.timing.readyWaitSeconds < 0.1
            assert first.timing.processId == first.value[0]
            assert first.timing.operationNumber == 1
            assert second.timing.operationNumber == 2
            assert third.timing.operationNumber == 1
            assert first.timing.startReason == "initial"
            assert second.timing.recycledFor == "operation_limit"
            assert third.timing.startReason == "operation_limit"
            assert first.timing.startupSeconds > 0
            assert first.timing.startupSeconds == second.timing.startupSeconds
        finally:
            await lane.close()
        with pytest.raises(RuntimeError):
            await lane.run(echo, ("closed",), 10)

    asyncio.run(scenario())


def test_result_acknowledges_full_return_not_early_put(tmp_path: Path):
    """A result cannot free native admission while target cleanup still runs.

    Args:
        tmp_path: Child completion evidence.
    """

    async def scenario():
        """Wait through work occurring after put, then inspect the completed marker."""
        lane = ReusableProcess((slow,))
        marker = tmp_path / "operation"
        try:
            result = await lane.run(slow, (marker, 0.1), 10)
            assert result.value == "early"
            assert marker.with_suffix(".finished").exists()
            assert result.timing.operationSeconds >= 0.1
        finally:
            await lane.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("mode", ["cancel", "deadline", "crash", "close"])
def test_failure_stops_old_work_before_replacement(tmp_path: Path, mode: str):
    """Replace failed children, never overlapping unfinished native operations.

    Args:
        tmp_path: Child liveness/completion markers.
        mode: Failure boundary being exercised.
    """

    async def scenario():
        """Enter real native work, interrupt it, and exercise a fresh child."""
        lane = ReusableProcess((echo, slow, crash))
        try:
            first = await lane.run(echo, ("ready",), 10)
            if mode == "crash":
                with pytest.raises(ProcessDeadlineError):
                    await lane.run(crash, (), 10)
            else:
                marker = tmp_path / mode
                task = asyncio.create_task(
                    lane.run(slow, (marker,), 0.15 if mode == "deadline" else 10)
                )
                await started(marker)
                with pytest.raises(RuntimeError):
                    await lane.run(echo, ("overlap",), 10)
                if mode == "close":
                    await lane.close()
                elif mode == "cancel":
                    task.cancel()
                with pytest.raises(
                    ProcessDeadlineError
                    if mode == "deadline"
                    else asyncio.CancelledError
                ):
                    await task
                assert not marker.with_suffix(".finished").exists()
            if mode != "close":
                assert first.value[0] not in {child.pid for child in active_children()}
                second = await lane.run(echo, ("replacement",), 10)
                assert first.value[0] != second.value[0]
                assert not second.timing.reusedProcess
            await asyncio.sleep(0.05)
            assert not list(tmp_path.glob("*.finished"))
        finally:
            await lane.close()

    asyncio.run(scenario())


def test_shutdown_during_startup_and_between_recycling_calls():
    """Close also reaps children before their readiness reader starts."""

    async def scenario():
        """Cancel startup immediately, including any queued replacement callback."""
        lane = ReusableProcess((echo,))
        lane.warm()
        await lane.close()
        assert lane.child is None
        lane = ReusableProcess((echo,), max_jobs=1)
        await lane.run(echo, ("last",), 10)
        await lane.close()
        await asyncio.sleep(0)
        assert lane.child is None

    asyncio.run(scenario())


def test_startup_deadline_reaps_unready_child():
    """An interpreter that cannot become ready in time holds no native capacity."""

    async def scenario():
        """Force startup expiration before a spawned interpreter can initialize."""
        lane = ReusableProcess((echo,), startup_seconds=0.000001)
        try:
            with pytest.raises(ProcessDeadlineError):
                await lane.run(echo, ("unready",), 10)
        finally:
            await lane.close()
        assert lane.child is None

    asyncio.run(scenario())


@pytest.mark.skipif(sys.platform != "linux", reason="Linux RSS recycling policy")
def test_parent_memory_does_not_recycle_small_child() -> None:
    """Reuse a small worker even when its parent exceeds the recycling threshold."""

    async def scenario() -> None:
        """Keep parent pages resident while two calls use the same small worker."""
        parent_memory = bytearray(256 * 1024**2)
        parent_memory[::4096] = b"x" * (len(parent_memory) // 4096)
        lane = ReusableProcess((echo,), recycle_bytes=128 * 1024**2)
        try:
            first = await lane.run(echo, ("first",), 10)
            second = await lane.run(echo, ("second",), 10)
            assert first.value[0] == second.value[0]
            assert second.timing.reusedProcess
            assert parent_memory[0] == ord("x")
        finally:
            await lane.close()

    asyncio.run(scenario())


@pytest.mark.skipif(sys.platform != "linux", reason="Linux RSS recycling policy")
def test_peak_memory_recycles_process() -> None:
    """Crossing the RSS threshold retires the process before the next request."""

    async def scenario() -> None:
        """Use a one-byte threshold so even an empty interpreter must recycle."""
        lane = ReusableProcess((echo,), recycle_bytes=1)
        try:
            first = await lane.run(echo, ("first",), 10)
            second = await lane.run(echo, ("second",), 10)
            assert first.value[0] != second.value[0]
            assert not second.timing.reusedProcess
            assert first.timing.recycledFor == "memory_limit"
            assert second.timing.startReason == "memory_limit"
        finally:
            await lane.close()

    asyncio.run(scenario())


def report_address_space_limit(writer: ProcessResultWriter) -> None:
    """Return the real Linux limit from inside the supervised child.

    Args:
        writer: Native supervisor's result channel.
    """
    import resource

    writer.put(resource.getrlimit(resource.RLIMIT_AS))


@pytest.mark.skipif(
    sys.platform != "linux", reason="Linux native address-space contract"
)
def test_native_memory_reservation_has_an_os_limit() -> None:
    """Preparation and execution share an enforced child address-space ceiling."""

    async def scenario() -> None:
        """Inspect the limit over the real process pipe."""
        ceiling = 2 * 1024**3
        native = ReusableProcess(
            (report_address_space_limit,), address_space_bytes=ceiling
        )
        try:
            result = await native.run(report_address_space_limit, (), 15)
            assert result.value == (ceiling, ceiling)
        finally:
            await native.close()

    asyncio.run(scenario())
