"""Serialize prepared raster jobs and reserve their output storage."""

from eolab_app.processing.aggregate_models import AggregateSpec, RasterAggregateLimits
from eolab_app.processing.clip_models import ClipSpec
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


def prepare_clip_job(spec: ClipSpec) -> PreparedJobPlan:
    """Build the stored clip inputs, display details and disk reservation.

    Args:
        spec: Raster identity, selected area, and output grid measured during preparation.

    Returns:
        Clip inputs for the worker, details for the browser, and required disk space.
    """
    return PreparedJobPlan(
        specification=spec.model_dump(mode="json", by_alias=True),
        summary={
            "source": spec.source.model_dump(by_alias=True),
            "grid": spec.grid.model_dump(mode="json"),
            "area": {"kind": spec.area.kind, "bounds": list(spec.area.bounds)},
        },
        reserved_bytes=spec.grid.reservedBytes,
        operation=spec.operation,
    )
