"""Calculation-owned, disk-backed polygon masks aligned to the source raster."""

from contextlib import contextmanager
from pathlib import Path
import shutil
from typing import Iterator

import rasterio
from rasterio.features import rasterize
from rasterio.windows import Window, transform as window_transform

from eolab_app.bounded_vector import PolygonRasterizer
from eolab_app.processing.aggregate_models import AggregateSpec, RasterAggregateLimits
from eolab_app.processing.models import ProcessingError

MASK_TILE_SIDE = 512
MASK_METADATA_BYTES = 1024**2


def estimate_mask_disk_bytes(width: int, height: int) -> int:
    """Estimate disk bytes for an uncompressed, one-byte-per-pixel mask TIFF.

    Args:
        width: Width of the selected raster window in pixels.
        height: Height of the selected raster window in pixels.

    Returns:
        Conservative bytes for tile data, BigTIFF tile offsets and metadata.
    """
    tiles = ((width + MASK_TILE_SIDE - 1) // MASK_TILE_SIDE) * (
        (height + MASK_TILE_SIDE - 1) // MASK_TILE_SIDE
    )
    return tiles * (MASK_TILE_SIDE**2 + 16) + MASK_METADATA_BYTES


def estimate_calculation_disk_bytes(
    calculation_plan: AggregateSpec, limits: RasterAggregateLimits
) -> int:
    """Estimate disk bytes needed for one calculation's mask and result files.

    This function only computes the required space and checks the configured
    disk limit; the job store reserves that space when accepting the job.
    The estimate includes a temporary mask GeoTIFF plus an allowance for the
    result CSV and provenance JSON. Whole-raster calculations need no mask.
    Box selections include a mask allowance even when no mask is ultimately
    needed.

    Args:
        calculation_plan: AggregateSpec built by the Processing planning service
            from the requested raster, formulas and area, plus the grid returned
            by plan_aggregate(). This estimate uses area.kind to decide whether
            a mask may be needed, and grid.width/grid.height for its pixel count.
        limits: Calculation limits. result_reservation_bytes is the disk
            allowance for CSV/JSON outputs; max_stored_bytes is the total
            Processing disk budget shared by jobs. Both are bytes, not RAM.

    Returns:
        Disk bytes to reserve for the temporary mask and final result files.

    Raises:
        ProcessingError: If these files exceed the configured Processing disk
            budget, even with no other jobs using it.
    """
    mask_bytes = (
        0
        if calculation_plan.area.kind == "wholeRaster"
        else estimate_mask_disk_bytes(
            calculation_plan.grid.width, calculation_plan.grid.height
        )
    )
    reserved = limits.result_reservation_bytes + mask_bytes
    if reserved > limits.max_stored_bytes:
        raise ProcessingError(
            "mask_storage_limit",
            "The selected area's polygon mask exceeds the temporary storage limit. "
            "Choose a smaller area.",
            413,
        )
    return reserved


@contextmanager
def temporary_polygon_mask(
    dataset: rasterio.io.DatasetReader,
    raster_window: Window,
    polygons: tuple[dict[str, object], ...] | PolygonRasterizer,
    directory: Path,
    limits: RasterAggregateLimits,
) -> Iterator[rasterio.io.DatasetReader | None]:
    """Rasterize once to a tiled file, open it for window reads, then delete it.

    No full-size NumPy mask is allocated. GDAL manages bounded raster buffers
    under the calculation's existing GDAL cache setting. The worker owns the
    directory and removes abandoned files after a forcibly terminated process.

    Args:
        dataset: Open source raster supplying the CRS and pixel alignment.
        raster_window: Source-pixel rectangle covered by the mask.
        polygons: Polygons already transformed into dataset.crs by
            prepare_raster_area_tools(). Uploaded AOIs/boxes supply a tuple of
            GeoJSON geometry dictionaries, for example
            ({"type": "Polygon", "coordinates": ...},). A filtered vector
            supplies a PolygonRasterizer retaining those projected geometries.
            An empty tuple means the selected window needs no polygon mask.
            This function rasterizes these coordinates; it does not project them.
        directory: Existing private calculation attempt directory.
        limits: RasterAggregateLimits used for this calculation. The service
            and worker create it with with_lifecycle(their_processing_limits);
            standalone callers can use RasterAggregateLimits() defaults.
            This function reads result_reservation_bytes (CSV/JSON disk
            allowance), max_stored_bytes (shared job disk budget) and
            free_space_floor (disk bytes that must remain free).

    Yields:
        A read-only byte mask (one inside, zero outside), or None if unnecessary.

    Raises:
        ProcessingError: If scratch space is insufficient or output exceeds its budget.
        OSError: If the file cannot be created, read or removed.
        ValueError: If prepared geometry is unavailable or invalid.
    """
    if not polygons:
        yield None
        return
    path = directory / "polygon-mask.tif"
    width, height = int(raster_window.width), int(raster_window.height)
    reserved = estimate_mask_disk_bytes(width, height)
    if (
        reserved + limits.result_reservation_bytes > limits.max_stored_bytes
        or shutil.disk_usage(directory).free
        < reserved + limits.result_reservation_bytes + limits.free_space_floor
    ):
        raise ProcessingError(
            "storage_full",
            "There is not enough temporary storage for the polygon mask.",
            429,
        )
    transform = window_transform(raster_window, dataset.transform)
    try:
        shapes = (
            polygons.iter_projected_polygons()
            if isinstance(polygons, PolygonRasterizer)
            else iter(polygons)
        )
        rasterize(
            shapes,
            transform=transform,
            all_touched=False,
            default_value=1,
            fill=0,
            dtype="uint8",
            skip_invalid=False,
            dst_path=path,
            dst_kwds={
                "driver": "GTiff",
                "width": width,
                "height": height,
                "count": 1,
                "crs": dataset.crs,
                "transform": transform,
                "tiled": True,
                "blockxsize": MASK_TILE_SIDE,
                "blockysize": MASK_TILE_SIDE,
                "BIGTIFF": "YES",
            },
        )
        if path.stat().st_size > reserved:
            raise ProcessingError(
                "mask_storage_limit",
                "The polygon mask exceeded its scratch reservation.",
                413,
            )
        with rasterio.open(path) as mask:
            yield mask
    finally:
        path.unlink(missing_ok=True)
