"""Cooperative cancellation contract for bounded Rasterio reads."""

from collections.abc import Callable


RasterReadCancellationCheck = Callable[[], bool]


class RasterReadCancelled(Exception):
    """Raised when every waiter has abandoned one bounded raster read."""


def require_active_raster_read(
    cancellation_requested: RasterReadCancellationCheck | None,
) -> None:
    """Raise RasterReadCancelled if the caller's cancellation check is true.

    The argument is a callback, not a Boolean captured earlier. Calling it here
    reads the current cancellation state. Repeated checks let long operations
    stop between expensive steps. A coalescing service normally requests
    cancellation when its last waiter leaves.

    Args:
        cancellation_requested: Optional thread-safe callable returning True
            when this operation should stop.

    Returns:
        None if no callback was supplied or it returns False.

    Raises:
        RasterReadCancelled: If the callback returns True.
    """
    if cancellation_requested is not None and cancellation_requested():
        raise RasterReadCancelled
