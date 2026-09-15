"""Neutral conversion of raster extents to geographic longitude coverage."""

import math

from pyproj import CRS as ProjCRS, Transformer
from pyproj.exceptions import ProjError
from rasterio.crs import CRS
from rasterio.warp import transform_bounds


def transform_bounds_to_wgs84(
    source_crs: CRS,
    source_bounds: tuple[float, float, float, float],
    *,
    densify_points: int = 21,
) -> tuple[float, float, float, float]:
    """Transform an extent without prematurely wrapping its longitudes.

    Args:
        source_crs: Coordinate reference system of the source extent.
        source_bounds: Left, bottom, right and top in source coordinates.
        densify_points: Intermediate samples per boundary edge.

    Returns:
        West, south, east and north in degrees. PROJ's unwrapped longitude
        output is preserved, including values outside [-180, 180]. Nonfinite
        output is retained so a caller can apply its projection fallback.
        Some projections can still report a date-line crossing as east < west.
        Geographic and Mercator/equidistant cylindrical systems use PROJ's
        +over control. Other projections retain GDAL's domain handling: +over
        can admit invalid outer corners for non-cylindrical world projections.

    Raises:
        ValueError: If PROJ cannot construct or execute the transformation.
        rasterio.errors.RasterioError: If GDAL cannot transform the extent.
    """
    try:
        crs = ProjCRS(source_crs)
        operation = crs.coordinate_operation
        cylindrical = operation is not None and operation.method_name in {
            "Popular Visualisation Pseudo Mercator",
            "Mercator (variant A)",
            "Mercator (variant B)",
            "Equidistant Cylindrical",
            "Equidistant Cylindrical (Spherical)",
        }
        if not (crs.is_geographic or cylindrical):
            return transform_bounds(
                source_crs,
                "EPSG:4326",
                *source_bounds,
                densify_pts=densify_points,
            )
        transformer = Transformer.from_crs(
            source_crs, "EPSG:4326", always_xy=True, force_over=True
        )
        return transformer.transform_bounds(*source_bounds, densify_pts=densify_points)
    except ProjError as error:
        raise ValueError("Raster bounds could not be transformed to WGS 84") from error


def normalize_wgs84_bounds(
    bounds: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    """Represent geographic coverage as one finite, non-wrapping envelope.

    Args:
        bounds: Transformed west, south, east and north, before longitude
            normalization. East < west denotes a library-reported crossing.

    Returns:
        A canonical envelope containing the longitude interval. Full-world
        intervals and date-line crossings use [-180, 180] because one
        non-wrapping box cannot represent two separated longitude intervals.
        Latitude pixel-edge overshoot is clipped to [-90, 90].

    Raises:
        ValueError: If the extent is nonfinite, empty or has no valid latitude.
    """
    if not all(math.isfinite(value) for value in bounds):
        raise ValueError("Raster WGS 84 bounds must be finite")
    west, south, east, north = bounds
    span = east - west
    if span == 0:
        raise ValueError("Raster WGS 84 bounds must have positive width")
    if span < 0 or span >= 360:
        west, east = -180.0, 180.0
    else:
        west = (west + 180.0) % 360.0 - 180.0
        east = west + span
        if east > 180.0:
            west, east = -180.0, 180.0
    south, north = max(-90.0, south), min(90.0, north)
    if south >= north:
        raise ValueError("Raster WGS 84 bounds must have positive height")
    return west, south, east, north
