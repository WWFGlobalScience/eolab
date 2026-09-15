"""Streaming polygon source reads with bounded per-feature geometry allocation."""

from collections.abc import Iterator
from contextlib import contextmanager
import math
import time
import json
from time import monotonic
from typing import Any
import sys

from affine import Affine
from numpy.typing import NDArray
from rasterio.io import DatasetReader

from eolab_app.execution.bounded_process import ProcessResultWriter

import fiona
from fiona.model import to_dict
from fiona.transform import transform_geom
import numpy as np
from rasterio.features import geometry_mask
from rasterio.crs import CRS
from rasterio.warp import transform
from rasterio.windows import Window
from shapely.geometry import shape

from eolab_app.bounded_geometry import GeometryValidationError, _geometry_positions
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.raster.bounded_window import (
    BOUNDED_WGS84_DENSIFY_POINTS,
    NoRasterBoundsOverlapError,
    _polygon_rings,
    project_wgs84_polygons,
    BOUNDED_SOURCE_WINDOW_PADDING_PIXELS,
)
from eolab_app.raster.read_cancellation import require_active_raster_read
from eolab_app.raster.read_cancellation import RasterReadCancellationCheck
from eolab_app.raster.models import RasterAreaMask, RasterMaskTimings
from eolab_app.attribute_filter import matches_filter, validate_filter

# Existing native-read and projection budgets now bound actual streamed work
# and individual retained features, rather than admission by serialized GeoJSON.
MAX_SCANNED_FEATURES = 1_000_000
READ_SECONDS = 15.0
MAX_FEATURE_COORDINATES = 500_000


@contextmanager
def _source_collection(
    resolved: ResolvedCatalogSelection,
) -> Iterator[fiona.Collection]:
    """Open only the authorized native layer and sanitize external-driver failures.

    Args:
        resolved: Current private source capability.

    Yields:
        Original native layer, closed before its source signature is rechecked.

    Raises:
        SelectionUnavailableError: If the source changed or its driver cannot read it.
    """
    resolved.require_current()
    try:
        with fiona.open(
            resolved.path,
            enabled_drivers=[resolved.driver],
            layer=resolved.selection.layerName,
        ) as dataset:
            yield dataset
    except (fiona.errors.FionaError, OSError) as error:
        raise SelectionUnavailableError(
            "The catalog vector could not be read safely."
        ) from error
    resolved.require_current()


@contextmanager
def polygon_features(
    resolved: ResolvedCatalogSelection,
    bbox: tuple[float, float, float, float] | None = None,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> Iterator[Iterator[dict[str, Any]]]:
    """Open the original dataset and yield exact WGS84 polygons, one at a time.

    Args:
        resolved: Authorized source and compiled attribute predicate.
        bbox: Conservative native-CRS candidate envelope, or no spatial filter.
        cancellation_requested: Optional cancellation predicate.

    Yields:
        An iterator whose geometries never outlive the owning source context.

    Raises:
        GeometryValidationError: For invalid topology or actual read-work limits.
        SelectionUnavailableError: If a source component changed.
    """
    resolved.require_current()
    deadline = monotonic() + READ_SECONDS
    with fiona.Env(OGR_CT_FORCE_TRADITIONAL_GIS_ORDER="YES"):
        with _source_collection(resolved) as dataset:
            validate_filter(
                resolved.selection.filter, dataset.schema.get("properties", {})
            )
            if not dataset.crs:
                raise GeometryValidationError(
                    "The catalog vector has no coordinate reference system"
                )

            def iterate() -> Iterator[dict[str, Any]]:
                """Yield validated exact polygons within the source-read budget."""
                options = {}
                if resolved.where:
                    options["where"] = resolved.where
                if bbox is not None:
                    options["bbox"] = bbox
                for count, feature in enumerate(dataset.filter(**options), 1):
                    require_active_raster_read(cancellation_requested)
                    if count > MAX_SCANNED_FEATURES or monotonic() > deadline:
                        raise GeometryValidationError(
                            "Vector reading exceeded its feature/time budget"
                        )
                    if not matches_filter(
                        resolved.selection.filter, feature.properties
                    ):
                        continue
                    if feature.geometry is None:
                        raise GeometryValidationError(
                            "Sampling requires non-null polygons"
                        )
                    raw = to_dict(feature.geometry)
                    for positions, _ in enumerate(
                        _geometry_positions(raw, canonical=False), 1
                    ):
                        if positions > MAX_FEATURE_COORDINATES:
                            raise GeometryValidationError(
                                "A source feature exceeds the bounded coordinate buffer"
                            )
                    geometry = to_dict(
                        transform_geom(
                            dataset.crs, "EPSG:4326", raw, antimeridian_cutting=False
                        )
                    )
                    if (
                        geometry.get("type") not in {"Polygon", "MultiPolygon"}
                        or not shape(geometry).is_valid
                    ):
                        raise GeometryValidationError(
                            "Sampling requires valid polygons; repair the source first"
                        )
                    for positions, _ in enumerate(_geometry_positions(geometry), 1):
                        if positions > MAX_FEATURE_COORDINATES:
                            raise GeometryValidationError(
                                "A transformed feature exceeds the bounded coordinate buffer"
                            )
                    yield geometry

            yield iterate()
    resolved.require_current()


def selection_summary(
    resolved: ResolvedCatalogSelection,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> dict[str, Any]:
    """Measure exact bounds/counts without collecting coordinates.

    Args:
        resolved: Authorized immutable selection.
        cancellation_requested: Optional cancellation predicate.

    Returns:
        Bounds, counts, and measured coordinate/ring work.

    Raises:
        GeometryValidationError: If no polygon matches or reading is invalid.
    """
    bounds = [math.inf, math.inf, -math.inf, -math.inf]
    matched = coordinates = rings = exact_bytes = 0
    with polygon_features(
        resolved, cancellation_requested=cancellation_requested
    ) as features:
        for geometry in features:
            matched += 1
            exact_bytes += (
                len(
                    json.dumps(
                        {"type": "Feature", "properties": {}, "geometry": geometry},
                        allow_nan=False,
                    ).encode("utf-8")
                )
                + 2
            )
            groups = _polygon_rings(geometry)
            rings += len(groups)
            for ring in groups:
                coordinates += len(ring)
                for x, y in ring:
                    bounds[0] = min(bounds[0], x)
                    bounds[1] = min(bounds[1], y)
                    bounds[2] = max(bounds[2], x)
                    bounds[3] = max(bounds[3], y)
    if not matched:
        raise GeometryValidationError("No matching polygon features; change the filter")
    with _source_collection(resolved) as dataset:
        total = len(dataset)
    resolved.require_current()
    return {
        "bbox": tuple(bounds),
        "matched": matched,
        "total": total,
        "coordinates": coordinates,
        "rings": rings,
        "exactGeometryBytes": exact_bytes + 48,
    }


def native_bbox_for_grid(
    resolved: ResolvedCatalogSelection,
    crs: CRS | str,
    affine: Affine,
    out_shape: tuple[int, int],
) -> tuple[float, float, float, float] | None:
    """Return a conservative native-source filter for separable WGS84 grids.

    EPSG:4326, 3857 and 6933 have monotone, separate x/y transformations
    within the supported canonical world. An affine window's corner envelope,
    padded by a pixel, therefore contains its entire WGS84 footprint. Other
    transformations deliberately use an unrestricted candidate stream: sampled
    transformed bounds alone do not prove containment of a curved boundary.

    Args:
        resolved: Authorized vector source.
        crs: Raster grid CRS.
        affine: Affine of the exact numeric window.
        out_shape: Numeric window rows and columns.

    Returns:
        Native-source envelope, or None when containment is not established.
    """
    crs = CRS.from_user_input(crs)
    if crs.to_epsg() not in {4326, 3857, 6933}:
        return None
    with _source_collection(resolved) as source:
        if source.crs.to_epsg() != 4326:
            return None
    h, w = out_shape
    points = [affine * p for p in ((-1, -1), (w + 1, -1), (w + 1, h + 1), (-1, h + 1))]
    xs, ys = transform(crs, "EPSG:4326", [p[0] for p in points], [p[1] for p in points])
    if not all(math.isfinite(v) for v in (*xs, *ys)) or max(xs) - min(xs) >= 180:
        return None
    # A native window outside the canonical world can wrap every corner back
    # inside it. Check the native domain before trusting inverse corner bounds.
    world_x, world_y = transform("EPSG:4326", crs, [-180, 180], [-90, 90])
    if (
        min(p[0] for p in points) < min(world_x)
        or max(p[0] for p in points) > max(world_x)
        or min(p[1] for p in points) < min(world_y)
        or max(p[1] for p in points) > max(world_y)
    ):
        return None
    return (
        math.nextafter(min(xs), -math.inf),
        math.nextafter(min(ys), -math.inf),
        math.nextafter(max(xs), math.inf),
        math.nextafter(max(ys), math.inf),
    )


class ProjectedGeometryMemoryError(ValueError):
    """The caller's calculation-local polygon memory allowance was exhausted."""


def _geometry_memory_bytes(value: object) -> int:
    """Count retained Python containers and coordinates conservatively.

    Shared references are counted again, so this is an upper estimate rather
    than a process RSS measurement. Projection output contains only shallow
    GeoJSON containers and scalar values.

    Args:
        value: Projected polygon mappings or their coordinate containers.

    Returns:
        Bytes occupied by the value and its children.
    """
    total = sys.getsizeof(value)
    if isinstance(value, dict):
        total += sum(
            _geometry_memory_bytes(key) + _geometry_memory_bytes(child)
            for key, child in value.items()
        )
    elif isinstance(value, (tuple, list)):
        total += sum(_geometry_memory_bytes(child) for child in value)
    return total


class ProjectedCatalogSelection:
    """Project selected polygons for streaming or caller-bounded reusable masks."""

    def __init__(
        self,
        dataset: DatasetReader,
        filtered_vector: ResolvedCatalogSelection,
        maximum_coordinates: int,
        cancellation_requested: RasterReadCancellationCheck | None = None,
        *,
        retain_projected_bytes: int = 0,
    ) -> None:
        """Measure the projected envelope, optionally retaining polygons for reuse.

        Args:
            dataset: Open, georeferenced raster metadata.
            filtered_vector: Vector source and filter identifying the features to read.
            maximum_coordinates: Existing projection-buffer policy.
            cancellation_requested: Optional cancellation predicate.
            retain_projected_bytes: Caller-owned cumulative memory allowance.
                Zero keeps streaming behavior. A positive allowance retains exact
                polygons until close(); no files or cross-request cache are used.

        Raises:
            ProjectedGeometryMemoryError: If projected polygons cannot fit.
            NoRasterBoundsOverlapError: If all polygons miss the raster.
            ValueError: If a source feature cannot fit the projection buffer.
        """
        self.dataset = dataset
        self.filtered_vector = filtered_vector
        self.maximum_coordinates = maximum_coordinates
        self.cancellation_requested = cancellation_requested
        self._retained: (
            list[
                tuple[tuple[float, float, float, float], tuple[dict[str, object], ...]]
            ]
            | None
        ) = ([] if retain_projected_bytes else None)
        self.retained_bytes = (
            sys.getsizeof(self._retained) if self._retained is not None else 0
        )
        self._closed = False
        try:
            summary = selection_summary(filtered_vector, cancellation_requested)
            segments = summary["coordinates"] - summary["rings"]
            self.densify = min(
                BOUNDED_WGS84_DENSIFY_POINTS,
                max(0, (maximum_coordinates - summary["rings"]) // segments - 1),
            )
            left = top = math.inf
            right = bottom = -math.inf
            inverse = ~dataset.transform
            with polygon_features(
                filtered_vector, cancellation_requested=cancellation_requested
            ) as features:
                for geometry in features:
                    require_active_raster_read(cancellation_requested)
                    if self._retained is not None:
                        rings = _polygon_rings(geometry)
                        count = sum(len(ring) - 1 for ring in rings) * (
                            self.densify + 1
                        ) + len(rings)
                        # Coordinate tuples/floats, projection temporaries, ring and
                        # feature containers; reserve before expanding this feature.
                        required = count * 256 + len(rings) * 1024 + 4096
                        if self.retained_bytes + required > retain_projected_bytes:
                            raise ProjectedGeometryMemoryError(
                                "Selected polygons exceed the retained geometry allowance"
                            )
                    projected_group = self.project(geometry)
                    require_active_raster_read(cancellation_requested)
                    feature_left = feature_top = math.inf
                    feature_right = feature_bottom = -math.inf
                    for projected in projected_group:
                        for ring in _polygon_rings(projected):
                            for position in ring:
                                x, y = inverse * position
                                feature_left = min(feature_left, x)
                                feature_top = min(feature_top, y)
                                feature_right = max(feature_right, x)
                                feature_bottom = max(feature_bottom, y)
                    left, top = min(left, feature_left), min(top, feature_top)
                    right, bottom = max(right, feature_right), max(
                        bottom, feature_bottom
                    )
                    if self._retained is not None:
                        entry = (
                            (feature_left, feature_top, feature_right, feature_bottom),
                            projected_group,
                        )
                        required = _geometry_memory_bytes(entry) + 64
                        if self.retained_bytes + required > retain_projected_bytes:
                            raise ProjectedGeometryMemoryError(
                                "Selected polygons exceed the retained geometry allowance"
                            )
                        self._retained.append(entry)
                        self.retained_bytes += required
            pad = BOUNDED_SOURCE_WINDOW_PADDING_PIXELS
            left, top = max(0, math.floor(left) - pad), max(0, math.floor(top) - pad)
            right, bottom = min(dataset.width, math.ceil(right) + pad), min(
                dataset.height, math.ceil(bottom) + pad
            )
            if left >= right or top >= bottom:
                raise NoRasterBoundsOverlapError
            self.source_window = Window(left, top, right - left, bottom - top)
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        """Release retained polygons and prevent use after the calculation ends."""
        if self._retained is not None:
            self._retained.clear()
        self.retained_bytes = 0
        self._closed = True

    def project(self, geometry: dict[str, Any]) -> tuple[dict[str, object], ...]:
        """Project one feature with the selection-wide legacy densification rate.

        Args:
            geometry: Exact validated WGS84 polygon.

        Returns:
            Projected exact polygonal mappings, without envelope clipping.

        Raises:
            ValueError: If the feature exceeds the retained projection buffer.
        """
        rings = _polygon_rings(geometry)
        count = sum(len(r) - 1 for r in rings) * (self.densify + 1) + len(rings)
        if count > self.maximum_coordinates:
            raise ValueError("A feature exceeds the transformed-coordinate buffer")
        return project_wgs84_polygons(self.dataset, (geometry,), count)

    def read_polygon_mask(
        self,
        out_shape: tuple[int, int],
        affine: Affine,
        all_touched: bool,
        timings: RasterMaskTimings | None = None,
    ) -> NDArray[np.bool_]:
        """Rasterize retained polygons, or read/project them in streaming mode.

        Args:
            out_shape: Already admitted raster output dimensions.
            affine: Existing numeric grid's affine transform.
            all_touched: Caller-owned pixel inclusion policy.
            timings: Optional accumulator; excludes mask allocation and union.

        Returns:
            Boolean inclusion mask, counting overlaps once and preserving holes.
            True marks included pixels; False marks excluded pixels.

        Raises:
            ValueError: If source geometry or bounded reading is invalid.
        """
        if self._closed:
            raise ValueError("Selected polygons have been released")
        require_active_raster_read(self.cancellation_requested)
        inside = np.zeros(out_shape, dtype=bool)
        if self._retained is not None:
            # A conservative tile envelope in source pixels avoids rasterizing
            # distant features without a spatial index or changing tile edges.
            height, width = out_shape
            to_pixels = ~self.dataset.transform * affine
            corners = [
                to_pixels * point
                for point in (
                    (-1, -1),
                    (width + 1, -1),
                    (width + 1, height + 1),
                    (-1, height + 1),
                )
            ]
            left, right = min(p[0] for p in corners), max(p[0] for p in corners)
            top, bottom = min(p[1] for p in corners), max(p[1] for p in corners)
            for bounds, projected in self._retained:
                require_active_raster_read(self.cancellation_requested)
                if (
                    bounds[2] < left
                    or bounds[0] > right
                    or bounds[3] < top
                    or bounds[1] > bottom
                ):
                    continue
                started = time.perf_counter()
                feature_mask = geometry_mask(
                    projected,
                    out_shape=out_shape,
                    transform=affine,
                    all_touched=all_touched,
                    invert=True,
                )
                if timings is not None:
                    timings.rasterization_seconds += time.perf_counter() - started
                inside |= feature_mask
                del feature_mask
            return inside
        reading_started = time.perf_counter() if timings is not None else 0.0
        bbox = native_bbox_for_grid(
            self.filtered_vector, self.dataset.crs, affine, out_shape
        )
        with polygon_features(
            self.filtered_vector, bbox, self.cancellation_requested
        ) as features:
            for geometry in features:
                if timings is not None:
                    projection_started = time.perf_counter()
                    timings.feature_reading_seconds += (
                        projection_started - reading_started
                    )
                projected = self.project(geometry)
                if timings is not None:
                    rasterization_started = time.perf_counter()
                    timings.projection_seconds += (
                        rasterization_started - projection_started
                    )
                feature_mask = geometry_mask(
                    projected,
                    out_shape=out_shape,
                    transform=affine,
                    all_touched=all_touched,
                    invert=True,
                )
                if timings is not None:
                    timings.rasterization_seconds += (
                        time.perf_counter() - rasterization_started
                    )
                inside |= feature_mask
                del feature_mask
                if timings is not None:
                    reading_started = time.perf_counter()
        if timings is not None:
            timings.feature_reading_seconds += time.perf_counter() - reading_started
        return inside


def pixels_inside_area(
    selected_polygons: tuple[dict[str, object], ...] | RasterAreaMask,
    *,
    out_shape: tuple[int, int],
    transform: Affine,
    all_touched: bool,
    timings: RasterMaskTimings | None = None,
) -> NDArray[np.bool_]:
    """Return a boolean inclusion mask for polygons on the supplied raster grid.

    Args:
        selected_polygons: Polygon coordinates in the raster CRS, or a reader that
            projects selected catalog features into that CRS.
        out_shape: Number of rows and columns in the output mask.
        transform: Mapping from output pixel coordinates to the raster CRS.
        all_touched: Include every pixel touched by a polygon when True;
            otherwise use Rasterio's default pixel-center inclusion rule.
        timings: Optional accumulator; existing polygon tuples only rasterize.

    Returns:
        Boolean array with out_shape dimensions: True for included pixels
        and False for excluded pixels.

    Raises:
        ValueError: If source geometry or bounded reading is invalid.
    """
    if not isinstance(selected_polygons, tuple):
        return selected_polygons.read_polygon_mask(
            out_shape, transform, all_touched, timings
        )
    rasterization_started = time.perf_counter() if timings is not None else 0.0
    inside = geometry_mask(
        selected_polygons,
        out_shape=out_shape,
        transform=transform,
        all_touched=all_touched,
        invert=True,
    )
    if timings is not None:
        timings.rasterization_seconds += time.perf_counter() - rasterization_started
    return inside


@contextmanager
def _limit_memory() -> Iterator[None]:
    """Bound Linux selection memory without changing later operations' limits.

    Yields:
        Control with at most 2 GiB of address space, respecting stricter existing
        limits. The original soft limit is restored on success and failure; the
        process hard limit is never changed.

    Raises:
        OSError: If the operating system cannot apply or restore the limit.
        ValueError: If the operating system rejects the configured limit.
    """
    if sys.platform != "linux":
        yield
        return
    import resource

    previous = resource.getrlimit(resource.RLIMIT_AS)
    ceiling = min(
        [2 * 1024**3] + [value for value in previous if value != resource.RLIM_INFINITY]
    )
    resource.setrlimit(resource.RLIMIT_AS, (ceiling, previous[1]))
    try:
        yield
    finally:
        resource.setrlimit(resource.RLIMIT_AS, previous)


def summary_process(
    writer: ProcessResultWriter, resolved: ResolvedCatalogSelection
) -> None:
    """Measure direct-source metadata in a supervised native process.

    Args:
        writer: Supervisor-owned result channel.
        resolved: Authorized original source and predicate.
    """
    try:
        with _limit_memory():
            result = selection_summary(resolved)
        writer.put((True, result))
    except (GeometryValidationError, SelectionUnavailableError) as error:
        writer.put((False, str(error)))
    except Exception:
        writer.put((False, "The catalog selection could not be read safely"))
