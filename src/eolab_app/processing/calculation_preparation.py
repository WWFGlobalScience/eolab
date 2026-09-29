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
        Stored job data, display summary, required disk bytes and the minimum
        worker version that can execute this calculation.

    Raises:
        ProcessingError: If mask and result reservations exceed the storage limit.
    """
    data = spec.model_dump(mode="json", by_alias=True)
    if spec.area.kind == "polygons":
        minimum_claim_version = 8
    elif spec.cachedRows is not None:
        minimum_claim_version = 7
    elif spec.area.kind != "wholeRaster":
        minimum_claim_version = 6
    elif spec.grid.execution:
        minimum_claim_version = 4
    elif spec.grid.groundArea:
        minimum_claim_version = 3
    else:
        minimum_claim_version = 2
    return PreparedJobPlan(
        specification=data,
        summary={
            **{key: data[key] for key in ("sources", "calculations", "grid")},
            "area": {"kind": spec.area.kind, "bounds": spec.area.bounds},
        },
        reserved_bytes=estimate_calculation_disk_bytes(spec, limits),
        operation=spec.operation,
        minimum_claim_version=minimum_claim_version,
    )
