"""One reusable, killable native process; no application or operation policy."""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
import gc
from multiprocessing import get_context
from multiprocessing.connection import Connection
import pickle
import signal
import sys
import time
from typing import Any

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    run_bounded_process,
)


@dataclass(frozen=True)
class ProcessTiming:
    """Per-call durations and the identity of the process that performed the call.

    The first three durations partition the call. startupSeconds measures the
    whole process startup, including any prewarming before this call; it must
    not be added to the call durations. startReason explains why this process
    was created, and recycledFor explains replacement after this operation.
    """

    readyWaitSeconds: float
    operationSeconds: float
    overheadSeconds: float
    reusedProcess: bool
    processId: int | None = None
    operationNumber: int | None = None
    startupSeconds: float | None = None
    startReason: str | None = None
    recycledFor: str | None = None


@dataclass(frozen=True)
class ProcessOutcome:
    """Opaque owner result and optional reusable-process timing."""

    value: Any
    timing: ProcessTiming | None = None


class _Result:
    """Capture one result until the entire target has returned."""

    def __init__(self) -> None:
        """Start with no emitted result."""
        self.values = []

    def put(self, value: Any) -> None:
        """Capture one owner-defined envelope without acknowledging completion.

        Args:
            value: Picklable operation result.
        """
        if self.values:
            raise RuntimeError("A native operation must return exactly one result")
        self.values.append(value)


def _invoke(target: Callable, arguments: tuple) -> tuple[Any, float]:
    """Finish the target's stack, including context-manager cleanup, before reply.

    Args:
        target: Preloaded, owner-supplied operation entry point.
        arguments: One admitted request's native inputs.

    Returns:
        Opaque result and monotonic target duration.
    """
    result = _Result()
    started = time.perf_counter()
    target(result, *arguments)
    if len(result.values) != 1:
        raise RuntimeError("Native operation returned no result")
    return result.values[0], time.perf_counter() - started


def _memory_exceeded(limit: int) -> bool:
    """Check this Linux worker's peak resident memory, excluding its parent.

    Linux getrusage() can carry the parent's peak RSS through fork/exec into a
    fresh interpreter. /proc/self/status reports the current program's VmHWM,
    so a large supervisor does not force a small worker to recycle every job.

    Args:
        limit: Peak resident bytes after which this process should be replaced.

    Returns:
        Whether this worker's peak RSS exceeds the recycling threshold. False
        on other platforms, which do not provide this Linux memory measurement.

    Raises:
        OSError: If Linux process-memory information cannot be read.
        ValueError: If the expected peak-memory field is absent or malformed.
    """
    if sys.platform != "linux":
        return False
    with open("/proc/self/status", encoding="ascii") as status:
        for line in status:
            if line.startswith("VmHWM:"):
                _, peak_kib, unit = line.split()
                if unit != "kB":
                    raise ValueError("Unexpected Linux peak-memory unit")
                return int(peak_kib) * 1024 > limit
    raise ValueError("Linux process status has no peak-memory field")


def _worker(
    connection: Connection,
    targets: tuple[Callable[..., None], ...],
    recycle_bytes: int,
    address_space_bytes: int | None,
) -> None:
    """Load targets once, then run one fully acknowledged request at a time.

    Args:
        connection: Child-only endpoint; parent death produces EOF while idle.
        targets: Fixed preloaded entry points; requests select an index only.
        recycle_bytes: Linux peak-RSS threshold for between-job replacement.
        address_space_bytes: Optional Linux address-space ceiling including native
            libraries and preparation; other platforms retain container limits.
    """
    try:
        if address_space_bytes is not None and sys.platform == "linux":
            import resource

            _, hard = resource.getrlimit(resource.RLIMIT_AS)
            ceiling = (
                address_space_bytes
                if hard == resource.RLIM_INFINITY
                else min(address_space_bytes, hard)
            )
            resource.setrlimit(resource.RLIMIT_AS, (ceiling, ceiling))
        connection.send("ready")
        while True:
            sequence, index, arguments, deadline = connection.recv()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            if hasattr(signal, "setitimer"):
                signal.signal(signal.SIGALRM, signal.SIG_DFL)
                signal.setitimer(signal.ITIMER_REAL, remaining)
            value, elapsed = _invoke(targets[index], arguments)
            recycle = "memory_limit" if _memory_exceeded(recycle_bytes) else None
            payload = pickle.dumps((sequence, value, elapsed, recycle))
            # No request frames, results or cycles survive into the next job.
            del value, arguments
            gc.collect()
            connection.send_bytes(payload)
            del payload
            if hasattr(signal, "setitimer"):
                signal.setitimer(signal.ITIMER_REAL, 0)
            if recycle:
                return
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


def _exchange(connection: Connection, message: tuple) -> Any:
    """Send and receive on the sole per-process I/O lane.

    Args:
        connection: Parent endpoint, exclusively held for this request.
        message: Admitted request and deadline.

    Returns:
        Child response after its target returned and request cleanup finished.
    """
    connection.send(message)
    return connection.recv()


@dataclass
class _Child:
    """One generation's process, pipe and startup acknowledgment."""

    process: Any
    connection: Connection
    started: float
    start_reason: str
    startup: asyncio.Task | None = None
    startup_seconds: float | None = None
    completed: int = 0


class ReusableProcess:
    """One warm process, with no internal job queue or concurrent native work."""

    def __init__(
        self,
        targets: tuple[Callable[..., None], ...],
        *,
        recycle_bytes: int = 1024**3,
        startup_seconds: float = 15,
        address_space_bytes: int | None = None,
    ) -> None:
        """Configure a neutral process lane; creation waits for warm/run.

        Args:
            targets: Fixed operation entry points imported before readiness.
            recycle_bytes: Linux peak-RSS recycling threshold, not an admission limit.
            startup_seconds: Maximum time to initialize a replacement process.
            address_space_bytes: Optional positive Linux address-space cap for
                every operation; None retains the existing OS limit.

        Raises:
            ValueError: If targets or process limits are invalid.
        """
        if not targets or recycle_bytes < 1 or startup_seconds <= 0:
            raise ValueError("Reusable process limits and targets must be positive")
        self.targets = targets
        self.recycle_bytes = recycle_bytes
        self.startup_seconds = startup_seconds
        if address_space_bytes is not None and address_space_bytes < 1:
            raise ValueError("Process address-space limit must be positive")
        self.address_space_bytes = address_space_bytes
        self.child: _Child | None = None
        self.active: asyncio.Task | None = None
        self.closed = False
        self.sequence = 0
        self.next_start_reason = "initial"

    def _retire(self, child: _Child, reason: str = "failure") -> None:
        """Confirm native exit synchronously before allowing admission to release.

        Args:
            child: Exact process generation to terminate and reap.
            reason: Lifecycle event requiring replacement, recorded on the next child.
        """
        if self.child is not child:
            return
        self.child = None
        self.next_start_reason = reason
        if child.startup and child.startup is not asyncio.current_task():
            child.startup.cancel()
        process = child.process
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
                process.join(2)
            if process.is_alive():
                process.kill()
            process.join()
            process.close()
        child.connection.close()

    async def _ready(self, child: _Child) -> None:
        """Bound startup and consume only this generation's readiness message.

        Args:
            child: Newly spawned process, exclusively owned until readiness.
        """
        try:
            async with asyncio.timeout(self.startup_seconds):
                if await asyncio.to_thread(child.connection.recv) != "ready":
                    raise ProcessDeadlineError("Native process did not become ready")
                child.startup_seconds = time.perf_counter() - child.started
        except BaseException:
            self._retire(child)
            raise

    def warm(self) -> None:
        """Prestart one child in the background without accepting any native work."""
        if self.closed or self.child is not None:
            return
        context = get_context("spawn")
        parent, child_pipe = context.Pipe(duplex=True)
        process = context.Process(
            target=_worker,
            args=(
                child_pipe,
                self.targets,
                self.recycle_bytes,
                self.address_space_bytes,
            ),
            daemon=True,
        )
        child = _Child(process, parent, time.perf_counter(), self.next_start_reason)
        self.child = child
        try:
            process.start()
            child.startup = asyncio.create_task(self._ready(child))
            # Background readiness failures are surfaced by run or replaced on
            # its next attempt; always retrieve them to avoid abandoned tasks.
            child.startup.add_done_callback(
                lambda task: None if task.cancelled() else task.exception()
            )
        except BaseException:
            self._retire(child)
            raise
        finally:
            child_pipe.close()

    async def run(
        self, target: Callable, arguments: tuple, timeout_seconds: float
    ) -> ProcessOutcome:
        """Run admitted work; cancellation/deadline/crash always retires its child.

        Args:
            target: One of the preloaded entry points.
            arguments: Immutable admitted operation inputs.
            timeout_seconds: Deadline including readiness, transfer and cleanup.

        Returns:
            Opaque completed result and durations from this invocation.

        Raises:
            RuntimeError: If closed or another operation is active on this lane.
            ValueError: If the target or timeout is outside the configured contract.
            ProcessDeadlineError: If startup, transport or native execution fails.
            asyncio.CancelledError: Only after native exit is confirmed.
        """
        if self.closed or self.active is not None:
            raise RuntimeError("Native process lane is closed or already active")
        if target not in self.targets or timeout_seconds <= 0:
            raise ValueError("Invalid native process target or deadline")
        self.active = asyncio.current_task()
        started = time.perf_counter()
        deadline = time.monotonic() + timeout_seconds
        child = None
        try:
            self.warm()
            child = self.child
            async with asyncio.timeout(timeout_seconds):
                await asyncio.shield(child.startup)
                ready = time.perf_counter()
                self.sequence += 1
                response = await asyncio.to_thread(
                    _exchange,
                    child.connection,
                    (self.sequence, self.targets.index(target), arguments, deadline),
                )
                sequence, value, operation, recycle = response
                if sequence != self.sequence:
                    raise ProcessDeadlineError(
                        "Native response did not match its request"
                    )
                reused = child.completed > 0
                child.completed += 1
                process_id = child.process.pid
                if recycle:
                    self._retire(child, recycle)
                finished = time.perf_counter()
                return ProcessOutcome(
                    value,
                    ProcessTiming(
                        ready - started,
                        operation,
                        max(0, finished - ready - operation),
                        reused,
                        process_id,
                        child.completed,
                        child.startup_seconds,
                        child.start_reason,
                        recycle,
                    ),
                )
        except asyncio.CancelledError:
            if child is not None:
                self._retire(child, "cancelled")
            raise
        except (TimeoutError, EOFError, OSError, ValueError) as error:
            if child is not None:
                self._retire(child)
            raise ProcessDeadlineError(
                "Native process failed or exceeded its deadline"
            ) from error
        except BaseException:
            if child is not None:
                self._retire(child)
            raise
        finally:
            self.active = None
            if not self.closed and self.child is None:
                asyncio.get_running_loop().call_soon(self.warm)

    async def close(self) -> None:
        """Stop startup or active work and prevent any replacement on shutdown."""
        self.closed = True
        active, child = self.active, self.child
        if active and active is not asyncio.current_task():
            active.cancel()
        if child is not None:
            self._retire(child)
        pending = [
            task
            for task in (active, child.startup if child else None)
            if task is not None and task is not asyncio.current_task()
        ]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)


async def run_process(
    target: Callable,
    arguments: tuple,
    timeout_seconds: float,
    reusable: ReusableProcess | None = None,
) -> ProcessOutcome:
    """Use the supplied managed lane, retaining one-shot behavior for other callers.

    Args:
        target: Owner-supplied operation entry point.
        arguments: Admitted native inputs.
        timeout_seconds: Complete operation deadline.
        reusable: Lifecycle-managed warm process supplied by composition, if any.

    Returns:
        Completed owner result with optional reusable-process measurements.
    """
    if reusable is not None:
        return await reusable.run(target, arguments, timeout_seconds)
    return ProcessOutcome(await run_bounded_process(target, arguments, timeout_seconds))
