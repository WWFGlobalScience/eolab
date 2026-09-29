"""Prepare raster calculation inputs and reserve their result and mask storage."""

from eolab_app.processing.aggregate_models import AggregateSpec, RasterAggregateLimits
from eolab_app.processing.models import PreparedJobPlan
from eolab_app.processing.raster_mask import estimate_calculation_disk_bytes


def prepare_aggregate_job(
    spec: AggregateSpec, limits: RasterAggregateLimits
) -> PreparedJobPlan:
    """Build the stored calculation job fields and its disk-space reservation.

    Args:
        spec: Calculation plan containing the raster, formulas, area and grid.
        limits: Calculation result and temporary mask reservation policy.

    Returns:
        Stored job data, display summary, and the required
        result and temporary mask storage reservation.

    Raises:
        ProcessingError: If mask and result reservations exceed the storage limit.
    """
    data = spec.model_dump(mode="json", by_alias=True)
    return PreparedJobPlan(
        specification=data,
        summary={
            **{key: data[key] for key in ("sources", "calculations", "grid")},
            "area": {"kind": spec.area.kind, "bounds": spec.area.bounds},
        },
        reserved_bytes=estimate_calculation_disk_bytes(spec, limits),
        operation=spec.operation,
    )
