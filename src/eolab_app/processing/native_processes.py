"""Configure the worker's native process for raster preparation and execution."""

from eolab_app.execution.reusable_process import ReusableProcess
from eolab_app.bounded_vector import summary_process
from eolab_app.processing.models import ProcessingLimits
from eolab_app.processing.raster_aggregate import aggregate_process_target
from eolab_app.processing.raster_clip import clip_process_target


def create_native_process(limits: ProcessingLimits) -> ReusableProcess:
    """Prepare one lane for both supported operations without admitting any work.

    The dedicated worker uses this process for preparation and execution after
    claiming a job from the database queue.

    Args:
        limits: Existing startup/planning deadline policy.

    Returns:
        Unstarted lane, recycled after 100 operations or 512 MiB Linux peak RSS.
        The configured Linux address-space ceiling applies to preparation and
        execution. Container limits additionally bound all children together.
    """
    return ReusableProcess(
        (clip_process_target, aggregate_process_target, summary_process),
        max_jobs=100,
        recycle_bytes=512 * 1024**2,
        startup_seconds=limits.plan_timeout_seconds,
        address_space_bytes=limits.process_memory_bytes,
    )
