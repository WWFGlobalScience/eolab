"""Write real raster fixtures shared by native raster and Processing tests."""

from pathlib import Path

from affine import Affine
import numpy
from numpy.typing import NDArray
import rasterio
from rasterio.transform import from_origin


def write_source(
    path: Path,
    values: NDArray[numpy.generic],
    nodata: float | None = None,
    transform: Affine | None = None,
    crs: str = "EPSG:4326",
) -> Path:
    """Write a one-band tiled GeoTIFF with descriptive numeric metadata.

    The fixture carries a scale of 2, offset of -1, metre units, a band name
    and tags so tests can check metadata preservation alongside native values.
    The caller owns the output path and its cleanup.

    Args:
        path: Output file in an existing caller-owned directory.
        values: Two-dimensional array of native band values and their dtype.
        nodata: Optional NoData sentinel written to the raster metadata.
        transform: Native affine transform, defaulting to a north-up grid with
            0.01-degree cells and upper-left corner at longitude 0, latitude 10.
        crs: Coordinate reference system declared for the source grid.

    Returns:
        The supplied path after the one-band GeoTIFF has been closed.

    Raises:
        rasterio.errors.RasterioIOError: If the GeoTIFF cannot be created or written.
        ValueError: If the native writer rejects the dtype, NoData value or grid.
    """
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        count=1,
        width=values.shape[1],
        height=values.shape[0],
        dtype=values.dtype,
        crs=crs,
        transform=transform or from_origin(0, 10, 0.01, 0.01),
        nodata=nodata,
        tiled=True,
        blockxsize=32,
        blockysize=32,
    ) as dataset:
        dataset.write(values, 1)
        dataset.scales = (2,)
        dataset.offsets = (-1,)
        dataset.units = ("m",)
        dataset.set_band_description(1, "Risk value")
        dataset.update_tags(1, STATISTICS_MINIMUM="99999", LONG_NAME="Risk value")
    return path
