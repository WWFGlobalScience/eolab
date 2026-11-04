"""Serialize raster job plans and calculate the storage the job store must reserve."""

from eolab_app.processing.aggregate_models import AggregateSpec, RasterAggregateLimits
from eolab_app.processing.clip_models import ClipSpec
from eolab_app.processing.models import PreparedJobPlan


def prepare_aggregate_job(
    spec: AggregateSpec, limits: RasterAggregateLimits
) -> PreparedJobPlan:
    """Serialize a prepared raster calculation for the job store.

    Args:
        spec: Calculation inputs, formulas, selected area and native grid.
        limits: Shared job and numerical settings; storage estimates are not required.

    Returns:
        Path-free worker inputs and browser summary with no disk reservation.
    """
    data = spec.model_dump(mode="json", by_alias=True)
    return PreparedJobPlan(
        specification=data,
        summary={
            **{key: data[key] for key in ("sources", "calculations", "grid")},
            "area": {
                "kind": spec.area.kind,
                "bounds": spec.area.bounds,
                **(
                    {"samplingBox": spec.area.samplingBox.model_dump(mode="json")}
                    if spec.area.samplingBox
                    else {}
                ),
            },
        },
        reserved_bytes=0,
        operation=spec.operation,
    )


def prepare_clip_job(spec: ClipSpec) -> PreparedJobPlan:
    """Serialize prepared raster clip inputs and display metadata.

    Args:
        spec: Raster identity, selected area and output grid measured during preparation.

    Returns:
        Path-free worker inputs and browser summary with no disk reservation.
    """
    return PreparedJobPlan(
        specification=spec.model_dump(mode="json", by_alias=True),
        summary={
            "source": spec.source.model_dump(by_alias=True),
            "grid": spec.grid.model_dump(mode="json"),
            "area": {
                "kind": spec.area.kind,
                "bounds": list(spec.area.bounds),
                **(
                    {"samplingBox": spec.area.samplingBox.model_dump(mode="json")}
                    if spec.area.samplingBox
                    else {}
                ),
            },
        },
        reserved_bytes=0,
        operation=spec.operation,
    )
