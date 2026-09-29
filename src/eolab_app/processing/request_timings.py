"""Request-local Processing durations, independent of HTTP and job scheduling."""

from contextlib import contextmanager
from contextvars import ContextVar
from collections.abc import Iterator
import time

request_timings: ContextVar[dict[str, float] | None] = ContextVar(
    "processing_request_timings", default=None
)


@contextmanager
def measure_request_stage(name: str) -> Iterator[None]:
    """Accumulate one server-clock duration when a request is being measured.

    Args:
        name: Internal stage name; never user-provided text.

    Yields:
        Control to the measured operation. Exceptions propagate unchanged.
    """
    timings = request_timings.get()
    started = time.perf_counter()
    try:
        yield
    finally:
        if timings is not None:
            timings[name] = timings.get(name, 0.0) + time.perf_counter() - started
