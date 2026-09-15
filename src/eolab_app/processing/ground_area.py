"""Bounded ellipsoidal intersections of native cells with a job-owned selection.

WGS84 cylindrical equal-area coordinates preserve ellipsoid surface area.
Only boundaries are transformed; raster values stay on their original grid.
Rectilinear EPSG:4326/3857/6933 grids multiply cached row/column area weights
by numerical fractional polygon selection masks. Other grids retain bounded cell geometry.
"""

import math
from typing import Any, Callable

import numpy as np
from pyproj import CRS, Transformer
from pyproj.exceptions import ProjError
from rasterio.windows import Window, transform as window_transform
import shapely
from shapely.geometry import Polygon, box, shape
from shapely.geometry.base import BaseGeometry

from eolab_app.processing.aggregate_models import (
    AggregateArea,
    GroundAreaPlan,
    RasterAggregateLimits,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.area_coverage import AreaCoverage
from eolab_app.bounded_vector import polygon_features, native_bbox_for_grid

# lat_ts=0 makes the x domain exactly +/- pi * WGS84's semimajor axis.
AREA_CRS = "+proj=cea +lat_ts=0 +lon_0=0 +datum=WGS84 +units=m +type=crs"
WGS84 = CRS.from_epsg(4326)
MAXIMUM_X = math.pi * 6_378_137.0
HECTARE_SQUARE_METRES = 10_000.0
WINDOW_TOLERANCE_PIXELS = 0.01
MAX_SUBDIVISIONS = 20


class CoordinateBudget:
    """Bound all projection input allocations within one planning/execution pass."""

    def __init__(self, maximum: int) -> None:
        """Start a coordinate-work counter.

        Args:
            maximum: Maximum positions passed through coordinate transformations.
        """
        self.maximum = maximum
        self.used = 0

    def consume(self, count: int) -> None:
        """Reserve positions before allocating projection arrays.

        Args:
            count: Number of positions about to be projected.

        Raises:
            ProcessingError: When cumulative geometry work exceeds its limit.
        """
        self.used += count
        if self.used > self.maximum:
            raise ProcessingError(
                "area_geometry_limit",
                f"Ground-area measurement needs more than {self.maximum:,} transformed "
                "coordinates. Choose a smaller area or filter the source more narrowly.",
                413,
            )


def project_points(
    points: np.ndarray, transformer: Transformer, budget: CoordinateBudget
) -> np.ndarray:
    """Transform bounded positions and reject undefined or wrapped coordinates.

    Args:
        points: N by 2 source coordinates in conventional x/y order.
        transformer: Reusable, non-ballpark coordinate operation.
        budget: Cumulative coordinate-work guard.

    Returns:
        Finite N by 2 transformed coordinates.

    Raises:
        ProcessingError: For unsupported/discontinuous projection input.
    """
    budget.consume(len(points))
    try:
        x, y = transformer.transform(points[:, 0], points[:, 1], errcheck=True)
    except ProjError as error:
        raise ProcessingError(
            "unsupported_area_crs",
            "Ground-area boundaries cannot be transformed continuously. Choose a smaller area or a WGS84 raster.",
        ) from error
    result = np.column_stack((x, y))
    if not np.isfinite(result).all():
        raise ProcessingError(
            "unsupported_area_crs",
            "Ground-area boundaries contain undefined projected coordinates.",
        )
    return result


def densified_ring(
    coordinates: Any,
    project: Callable[[np.ndarray], np.ndarray],
    tolerance: float,
    maximum_segment: float,
) -> np.ndarray:
    """Refine straight source edges until transformed chords meet a bounded tolerance.

    Quarter, midpoint and three-quarter probes detect curvature; maximum chord
    length bounds long edges even when their probes happen to be collinear.

    Args:
        coordinates: Closed ring of source-coordinate positions.
        project: Budgeted coordinate transformation.
        tolerance: Maximum tested perpendicular deviation in destination units.
        maximum_segment: Maximum destination chord length.

    Returns:
        Closed, densified ring in destination coordinates.

    Raises:
        ProcessingError: If the required refinement exceeds bounded work/depth.
    """
    points = np.asarray(coordinates, dtype=np.float64)[:, :2]
    for _ in range(MAX_SUBDIVISIONS):
        projected = project(points)
        start, end = points[:-1], points[1:]
        probes = (
            start[:, None, :]
            + (end - start)[:, None, :] * np.array([0.25, 0.5, 0.75])[None, :, None]
        )
        tested = project(probes.reshape(-1, 2)).reshape(-1, 3, 2)
        vector = projected[1:] - projected[:-1]
        length_squared = np.sum(vector**2, axis=1)
        relative = tested - projected[:-1, None, :]
        fraction = np.clip(
            np.sum(relative * vector[:, None, :], axis=2)
            / np.maximum(length_squared[:, None], 1e-30),
            0,
            1,
        )
        deviation = np.linalg.norm(
            relative - fraction[:, :, None] * vector[:, None, :], axis=2
        ).max(axis=1)
        split = (deviation > tolerance) | (length_squared > maximum_segment**2)
        if not split.any():
            return projected
        counts = 1 + split.astype(int)
        offsets = np.concatenate(([0], np.cumsum(counts)))
        refined = np.empty((int(offsets[-1]) + 1, 2))
        refined[offsets[:-1]] = start
        refined[offsets[:-1][split] + 1] = (start[split] + end[split]) / 2
        refined[-1] = points[-1]
        points = refined
    raise ProcessingError(
        "area_geometry_limit",
        "Ground-area edge refinement could not meet its tolerance. Choose a smaller area.",
        413,
    )


def transformed_polygon(
    geometry: BaseGeometry,
    project: Callable[[np.ndarray], np.ndarray],
    tolerance: float,
    maximum_segment: float,
) -> BaseGeometry:
    """Transform polygon rings while preserving holes and multipart boundaries.

    Args:
        geometry: Valid Polygon or MultiPolygon in source coordinates.
        project: Bounded transform callback.
        tolerance: Transformed chord-deviation tolerance.
        maximum_segment: Maximum transformed chord length.

    Returns:
        Valid projected polygonal geometry.

    Raises:
        ProcessingError: For invalid topology after transformation.
    """
    if geometry.geom_type == "MultiPolygon":
        result = shapely.multipolygons(
            [
                transformed_polygon(part, project, tolerance, maximum_segment)
                for part in geometry.geoms
            ]
        )
    else:
        result = Polygon(
            densified_ring(
                geometry.exterior.coords, project, tolerance, maximum_segment
            ),
            [
                densified_ring(ring.coords, project, tolerance, maximum_segment)
                for ring in geometry.interiors
            ],
        )
    if not result.is_valid:
        raise ProcessingError(
            "unsupported_area_crs",
            "Ground-area boundaries become invalid after transformation. Choose a smaller area or filter the source more narrowly.",
        )
    return result


class PixelAreaCalculator:
    """Calculate each raster pixel's area inside the selected region, in hectares.

    Reuse coordinate transformations and cached grid coordinates across tiles.
    Raster pixel values are read and evaluated separately by the caller.
    """

    def __init__(
        self,
        dataset: Any,
        area: AggregateArea,
        limits: RasterAggregateLimits,
        *,
        planning: bool = False,
    ) -> None:
        """Prepare a job's geometry and metadata without reading its raster band.

        Args:
            dataset: Authorized, validated native raster.
            area: Immutable box/polygon selection or whole-raster selection.
            limits: Processing-owned geometry and transformation policy.
            planning: Use the smaller metadata-stage coordinate budget.

        Raises:
            ProcessingError: For unsupported CRS/topology or excessive work.
        """
        self.transform = dataset.transform
        self.catalog_source = area.resolved if area.kind == "catalogSelection" else None
        self.dataset = dataset
        self.limits = limits
        self.budget = CoordinateBudget(
            limits.max_coordinates
            if planning
            else limits.max_area_transform_coordinates
        )
        crs = CRS.from_user_input(dataset.crs)
        if not (
            crs.is_geographic or crs.is_projected
        ) or not crs.geodetic_crs.to_2d().equals(WGS84, ignore_axis_order=True):
            raise ProcessingError(
                "unsupported_area_crs",
                "Ground-area calculations currently require a geographic or projected WGS84 raster. Other datums need an explicit area transformation policy.",
            )
        try:
            self.to_area = Transformer.from_crs(
                crs,
                AREA_CRS,
                always_xy=True,
                allow_ballpark=False,
                only_best=True,
                force_over=True,
            )
            wgs_area = Transformer.from_crs(
                WGS84,
                AREA_CRS,
                always_xy=True,
                allow_ballpark=False,
                only_best=True,
                force_over=True,
            )
            wgs_native = Transformer.from_crs(
                WGS84,
                crs,
                always_xy=True,
                allow_ballpark=False,
                only_best=True,
                force_over=True,
            )
        except ProjError as error:
            raise ProcessingError(
                "unsupported_area_crs",
                "A precise WGS84 ground-area transformation is unavailable for this raster.",
            ) from error
        self.rectilinear = (
            crs.to_epsg() in {4326, 3857, 6933}
            and self.transform.b == self.transform.d == 0
        )
        inverse = ~self.transform

        def pixels(points: np.ndarray) -> np.ndarray:
            """Project selection boundaries into source pixel coordinates.

            Args:
                points: Bounded WGS84 positions.

            Returns:
                Floating column/row positions for conservative window admission.
            """
            native = project_points(points, wgs_native, self.budget)
            return np.column_stack(
                (
                    inverse.a * native[:, 0] + inverse.b * native[:, 1] + inverse.c,
                    inverse.d * native[:, 0] + inverse.e * native[:, 1] + inverse.f,
                )
            )

        self.geometry = None
        self.rectangle = None
        self.window = Window(0, 0, dataset.width, dataset.height)
        if area.kind == "catalogSelection":
            self.wgs_area = wgs_area
            # A streaming planning pass uses the existing total transformation
            # work ceiling while retaining only one feature at a time.
            self.budget = CoordinateBudget(limits.max_area_transform_coordinates)
            pixel_bounds = [math.inf, math.inf, -math.inf, -math.inf]
            with polygon_features(self.catalog_source) as features:
                for item in features:
                    projected = transformed_polygon(
                        shape(item), pixels, WINDOW_TOLERANCE_PIXELS, 64
                    )
                    left, top, right, bottom = projected.bounds
                    pixel_bounds = [
                        min(pixel_bounds[0], left),
                        min(pixel_bounds[1], top),
                        max(pixel_bounds[2], right),
                        max(pixel_bounds[3], bottom),
                    ]
            left, top, right, bottom = pixel_bounds
            pad = 2 * WINDOW_TOLERANCE_PIXELS
            x0, y0 = max(0, math.floor(left - pad)), max(0, math.floor(top - pad))
            x1, y1 = min(dataset.width, math.ceil(right + pad)), min(
                dataset.height, math.ceil(bottom + pad)
            )
            if x0 >= x1 or y0 >= y1:
                raise ProcessingError(
                    "no_overlap", "The selected area does not overlap this raster."
                )
            self.window = Window(x0, y0, x1 - x0, y1 - y0)
        elif area.kind != "wholeRaster":
            originals = (
                [box(*area.bounds)]
                if area.kind == "bounds"
                else [shape(item) for item in area.geometries]
            )
            if not originals or any(
                g.geom_type not in {"Polygon", "MultiPolygon"}
                or g.is_empty
                or not g.is_valid
                for g in originals
            ):
                raise ProcessingError(
                    "invalid_area",
                    "Ground-area selection must contain valid polygons with positive area.",
                )
            if (
                sum(shapely.get_num_coordinates(g) for g in originals)
                > limits.max_coordinates
            ):
                raise ProcessingError(
                    "area_geometry_limit",
                    "The polygon selection has too many coordinates for ground-area measurement. Simplify it.",
                    413,
                )
            if area.kind == "bounds" and self.rectilinear:
                coordinates = np.asarray(originals[0].exterior.coords)
                pixel_points = pixels(coordinates)
                projected = project_points(coordinates, wgs_area, self.budget)
                self.geometry = box(
                    *np.min(projected, axis=0), *np.max(projected, axis=0)
                )
                pixel_bounds = (*pixel_points.min(axis=0), *pixel_points.max(axis=0))
            else:
                projected = [
                    transformed_polygon(
                        g,
                        lambda p: project_points(p, wgs_area, self.budget),
                        limits.area_edge_tolerance_metres,
                        limits.area_max_segment_metres,
                    )
                    for g in originals
                ]
                self.geometry = shapely.union_all(projected)
                native_polygons = [
                    transformed_polygon(g, pixels, WINDOW_TOLERANCE_PIXELS, 64)
                    for g in originals
                ]
                pixel_bounds = shapely.total_bounds(native_polygons)
            if (
                not self.geometry.is_valid
                or shapely.get_num_coordinates(self.geometry) > limits.max_coordinates
            ):
                raise ProcessingError(
                    "area_geometry_limit",
                    "The polygon selection union exceeds the ground-area geometry limit. Simplify it.",
                    413,
                )
            left, top, right, bottom = pixel_bounds
            pad = 2 * WINDOW_TOLERANCE_PIXELS
            x0, y0 = max(0, math.floor(left - pad)), max(0, math.floor(top - pad))
            x1, y1 = min(dataset.width, math.ceil(right + pad)), min(
                dataset.height, math.ceil(bottom + pad)
            )
            if x0 >= x1 or y0 >= y1:
                raise ProcessingError(
                    "no_overlap", "The selected area does not overlap this raster."
                )
            self.window = Window(x0, y0, x1 - x0, y1 - y0)
            if self.geometry.equals(self.geometry.envelope):
                self.rectangle = self.geometry.bounds
        geometry_cells = (
            0 if self.rectilinear else int(self.window.width * self.window.height)
        )
        if geometry_cells > limits.max_area_geometry_cells:
            raise ProcessingError(
                "area_geometry_limit",
                f"Ground-area measurement may need to check {geometry_cells:,} raster cells in the selected area's bounding rectangle; the limit is {limits.max_area_geometry_cells:,}. Choose a smaller area or a rectangular box on a north-up WGS84/Web Mercator grid.",
                413,
            )
        self.metadata = GroundAreaPlan(
            edgeToleranceMetres=limits.area_edge_tolerance_metres,
            maximumSegmentMetres=limits.area_max_segment_metres,
            estimatedGeometryCells=geometry_cells,
            strategy="rectilinear" if self.rectilinear else "cell_polygons",
        )
        # Probe the selected grid domain before accepting work. The per-tile
        # transformation repeats this guard as native footprints are measured.
        self._project_native(self._corners(self.window))
        self.axis_x = self.axis_y = None
        self.coverage = None
        if self.rectilinear:
            # One cached coordinate per row/column, rather than repeated
            # projection for every pixel/tile in the selected raster window.
            axis_count = int(self.window.width + self.window.height + 2)
            if axis_count > limits.max_coordinates:
                raise ProcessingError(
                    "area_geometry_limit",
                    f"The area grid needs {axis_count:,} axis coordinates; the limit is {limits.max_coordinates:,}. Choose a smaller area.",
                    413,
                )
            columns = np.arange(
                self.window.col_off,
                self.window.col_off + self.window.width + 1,
                dtype=np.float64,
            )
            rows = np.arange(
                self.window.row_off,
                self.window.row_off + self.window.height + 1,
                dtype=np.float64,
            )
            self.axis_x = self._project_native(
                np.column_stack(
                    (
                        self.transform.a * columns + self.transform.c,
                        np.full(
                            columns.shape, self.transform.e * rows[0] + self.transform.f
                        ),
                    )
                )
            )[:, 0]
            self.axis_y = self._project_native(
                np.column_stack(
                    (
                        np.full(
                            rows.shape, self.transform.a * columns[0] + self.transform.c
                        ),
                        self.transform.e * rows + self.transform.f,
                    )
                )
            )[:, 1]
            if self.geometry is not None and self.rectangle is None:
                oriented = shapely.orient_polygons(self.geometry)
                self.coverage = AreaCoverage(
                    np.asarray(ring.coords)
                    for polygon in shapely.get_parts(oriented)
                    for ring in [polygon.exterior, *polygon.interiors]
                )

    def _corners(self, window: Window) -> np.ndarray:
        """Construct the closed native footprint of an integral grid window.

        Args:
            window: Native pixel window, including a single cell.

        Returns:
            Five native coordinate pairs, preserving rotated/sheared affine edges.
        """
        x, y, w, h = window.col_off, window.row_off, window.width, window.height
        return np.asarray(
            [
                self.transform * p
                for p in [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]
            ]
        )

    def _project_native(self, points: np.ndarray) -> np.ndarray:
        """Transform native boundaries into the canonical equal-area world.

        Args:
            points: Native x/y positions.

        Returns:
            WGS84 ellipsoidal equal-area positions in metres.

        Raises:
            ProcessingError: For footprints wrapping outside the supported world.
        """
        result = project_points(points, self.to_area, self.budget)
        if np.any(np.abs(result[:, 0]) > MAXIMUM_X + 1e-6):
            raise ProcessingError(
                "unsupported_area_crs",
                "Ground-area measurement requires a continuous grid within longitudes -180 to 180. Select an area away from the wrapped edge or reproject the raster.",
            )
        return result

    def calculate_hectares(self, tile: Window) -> np.ndarray:
        """Calculate hectares inside the selected region for each pixel in a tile.

        Args:
            tile: Window contained in the admitted native area.

        Returns:
            Float64 hectares per cell, independent of values and source NoData.

        Raises:
            ProcessingError: For excessive or unsupported transformed geometry.
        """
        height, width = int(tile.height), int(tile.width)
        if self.catalog_source is not None:
            # Union only projected candidates intersecting this tile. Union is
            # essential for fractional areas: summing features double-counts
            # overlap. No geometry is persisted or retained between tiles.
            self.geometry = self.rectangle = self.coverage = None
            # Corner envelopes prove containment only for a separable grid.
            # For general projections, keep the conservative predicate stream.
            footprint = None
            if self.rectilinear:
                corners = self._project_native(self._corners(tile))
                footprint = box(*corners.min(axis=0), *corners.max(axis=0))
            retained = []
            count = 0
            bbox = native_bbox_for_grid(
                self.catalog_source,
                self.dataset.crs,
                window_transform(tile, self.transform),
                (height, width),
            )
            with polygon_features(self.catalog_source, bbox) as features:
                for item in features:
                    geometry = transformed_polygon(
                        shape(item),
                        lambda p: project_points(p, self.wgs_area, self.budget),
                        self.limits.area_edge_tolerance_metres,
                        self.limits.area_max_segment_metres,
                    )
                    if footprint is None or geometry.intersects(footprint):
                        count += shapely.get_num_coordinates(geometry)
                        if count > self.limits.max_coordinates:
                            raise ProcessingError(
                                "area_geometry_limit",
                                "The current raster tile exceeds the retained geometry buffer.",
                                413,
                            )
                        retained.append(geometry)
            if not retained:
                return np.zeros((height, width), dtype=np.float64)
            self.geometry = shapely.union_all(retained)
            if (
                not self.geometry.is_valid
                or shapely.get_num_coordinates(self.geometry)
                > self.limits.max_coordinates
            ):
                raise ProcessingError(
                    "area_geometry_limit",
                    "The current raster tile exceeds the union geometry buffer.",
                    413,
                )
            self.rectangle = (
                self.geometry.bounds
                if self.geometry.equals(self.geometry.envelope)
                else None
            )
            if self.rectilinear and self.rectangle is None:
                oriented = shapely.orient_polygons(self.geometry)
                self.coverage = AreaCoverage(
                    np.asarray(ring.coords)
                    for polygon in shapely.get_parts(oriented)
                    for ring in [polygon.exterior, *polygon.interiors]
                )
        if self.rectilinear:
            x, y = int(tile.col_off - self.window.col_off), int(
                tile.row_off - self.window.row_off
            )
            xs = self.axis_x[x : x + width + 1]
            ys = self.axis_y[y : y + height + 1]
            west, east = np.minimum(xs[:-1], xs[1:]), np.maximum(xs[:-1], xs[1:])
            south, north = np.minimum(ys[:-1], ys[1:]), np.maximum(ys[:-1], ys[1:])
            if self.geometry is None or self.rectangle is not None:
                if self.rectangle is not None:
                    west = np.maximum(west, self.rectangle[0])
                    east = np.minimum(east, self.rectangle[2])
                    south = np.maximum(south, self.rectangle[1])
                    north = np.minimum(north, self.rectangle[3])
                return (
                    np.maximum(north - south, 0)[:, None]
                    * np.maximum(east - west, 0)[None, :]
                    / HECTARE_SQUARE_METRES
                )
            cell_hectares = (
                (north - south)[:, None]
                * (east - west)[None, :]
                / HECTARE_SQUARE_METRES
            )
            return self.coverage.mask(xs, ys) * cell_hectares
        areas = np.zeros((height, width), dtype=np.float64)
        for row in range(height):
            for column in range(width):
                corners = self._corners(
                    Window(tile.col_off + column, tile.row_off + row, 1, 1)
                )
                ring = densified_ring(
                    corners,
                    self._project_native,
                    self.limits.area_edge_tolerance_metres,
                    self.limits.area_max_segment_metres,
                )
                polygon = Polygon(ring)
                if not polygon.is_valid:
                    raise ProcessingError(
                        "unsupported_area_crs",
                        "A native pixel has a discontinuous ground-area footprint. Choose a smaller area.",
                    )
                if self.geometry is not None:
                    polygon = polygon.intersection(self.geometry)
                if shapely.get_num_coordinates(polygon) > self.limits.max_coordinates:
                    raise ProcessingError(
                        "area_geometry_limit",
                        "A clipped pixel exceeds the area coordinate limit. Simplify the polygon selection.",
                        413,
                    )
                areas[row, column] = polygon.area / HECTARE_SQUARE_METRES
        return areas
