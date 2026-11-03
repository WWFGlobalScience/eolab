"""Build aggregate-specific native plans for real raster fixtures."""

from pathlib import Path

from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateSpec,
    NamedCalculation,
    PixelPoint,
    RasterAggregateLimits,
)
from eolab_app.processing.raster_aggregate import plan_aggregate
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity
from raster_source_support import SOURCE

LIMITS: RasterAggregateLimits = RasterAggregateLimits()


def make_spec(
    path: Path,
    expressions: list[str],
    area: AggregateArea | None = None,
    limits: RasterAggregateLimits = LIMITS,
    target_chunk_pixels: int | None = None,
    pixel_point: PixelPoint | None = None,
) -> AggregateSpec:
    """Plan raster formulas and round-trip their durable specification through JSON.

    The returned area retains the caller's resolved vector reader, which is
    deliberately excluded from the durable JSON representation.

    Args:
        path: Closed source fixture whose filesystem identity is recorded.
        expressions: Ordered scalar expressions for raster alias ``a``; result
            labels are ``Result 0``, ``Result 1`` and so on.
        area: Bounds, vector selection or polygons; defaults to the whole raster.
        limits: Aggregate lifecycle and ground-area accuracy settings.
        target_chunk_pixels: Optional pixel budget per read and calculation batch.
        pixel_point: Exact WGS84 map location required by pixelValue formulas.

    Returns:
        Immutable aggregate specification using the shared fixture catalog
        identity, with its resolved vector reader restored after JSON validation.

    Raises:
        OSError: If the fixture's filesystem identity cannot be read.
        rasterio.errors.RasterioIOError: If the native raster cannot be opened.
        ProcessingError: If a formula, raster or selected area cannot be planned.
        pydantic.ValidationError: If formulas or the specification violate the
            aggregate contract.
    """
    signature = tuple(RasterSourceIdentity.read(path).to_catalog())
    area = area or AggregateArea(kind="wholeRaster")
    calculations = tuple(
        NamedCalculation(label=f"Result {i}", expression=value)
        for i, value in enumerate(expressions)
    )
    spec = AggregateSpec(
        sources={"a": CatalogRasterRequest(**SOURCE)},
        sourceSignature=signature,
        area=area,
        calculations=calculations,
        pixelPoint=pixel_point,
        grid=plan_aggregate(
            path, area, calculations, "a", limits, target_chunk_pixels, pixel_point
        ),
    )
    restored = AggregateSpec.model_validate_json(spec.model_dump_json(by_alias=True))
    return restored.model_copy(
        update={"area": restored.area.model_copy(update={"resolved": area.resolved})}
    )
