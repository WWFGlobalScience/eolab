"""Configure the worker's native process for registered Processing calculations."""

from eolab_app.execution.reusable_process import ReusableProcess
from eolab_app.bounded_vector import summary_process
from eolab_app.processing.models import ProcessingLimits
from eolab_app.processing.raster_aggregate import aggregate_process_target
from eolab_app.processing.raster_clip import clip_process_target
from eolab_app.processing.downstream_calculation import downstream_process_target
from eolab_app.processing.temporal_reduce import temporal_process_target
from eolab_app.processing.temporal_series import temporal_series_process_target
from eolab_app.processing.temporal_stack import temporal_stack_process_target
from eolab_app.processing.habitat_calculation import habitat_process_target
from eolab_app.processing.habitat_preparation import (
    habitat_input_preparation_process_target,
)


def create_native_process(limits: ProcessingLimits) -> ReusableProcess:
    """Configure a reusable native process for Processing calculations.

    Args:
        limits: Shared Processing policy; native calculations have no memory or
            total-runtime ceiling.

    Returns:
        An unstarted process with cancellation and Linux parent-death protection.
        A child exceeding 1 GiB peak RSS is recycled after it finishes; this never
        rejects or interrupts a calculation. Startup still has a readiness timeout.
    """

    return ReusableProcess(
        (
            clip_process_target,
            aggregate_process_target,
            downstream_process_target,
            temporal_process_target,
            temporal_series_process_target,
            temporal_stack_process_target,
            habitat_process_target,
            habitat_input_preparation_process_target,
            summary_process,
        ),
        recycle_bytes=1024**3,
    )
