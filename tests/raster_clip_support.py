"""Build clip-specific native plans for real raster fixtures."""

from pathlib import Path

from eolab_app.processing.clip_models import ClipArea, ClipSpec, RasterClipLimits
from eolab_app.processing.raster_clip import plan_clip
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity
from raster_source_support import SOURCE

LIMITS: RasterClipLimits = RasterClipLimits()


def make_spec(
    path: Path, area: ClipArea, limits: RasterClipLimits = LIMITS
) -> ClipSpec:
    """Plan a fixture's native-resolution clip without reading band values.

    Args:
        path: Closed source fixture whose filesystem identity is recorded.
        area: Explicit bounds or vector selection, including its resolved reader
            when the caller has authorized a vector source.
        limits: Clip lifecycle settings passed unchanged to the native planner.

    Returns:
        Immutable clip specification using the shared fixture catalog identity
        and the supplied area, without a serialization round-trip.

    Raises:
        OSError: If the fixture's filesystem identity cannot be read.
        rasterio.errors.RasterioIOError: If the native raster cannot be opened.
        ProcessingError: If the raster or selected clip area is unsupported.
    """
    signature = tuple(RasterSourceIdentity.read(path).to_catalog())
    return ClipSpec(
        source=CatalogRasterRequest(**SOURCE),
        sourceSignature=signature,
        area=area,
        grid=plan_clip(path, area, limits),
    )
