"""Shared source checks and native-area planning for clip and aggregate kernels."""

from eolab_app.bounded_vector import (
    PolygonRasterizer,
    ProjectedGeometryMemoryError,
)
from eolab_app.catalog_selection import ResolvedCatalogSelection
import math
from pathlib import Path
from typing import Any
from rasterio.io import DatasetReader

from eolab_app.processing.models import ProcessingError
from eolab_app.raster.bounded_window import (
    NoRasterBoundsOverlapError,
    selected_raster_area_for_wgs84_bounds,
    selected_raster_area_for_wgs84_polygons,
)
from eolab_app.raster.models import SelectedRasterArea, CanonicalWgs84Bounds
from eolab_app.raster.source_contract import (
    decoded_source_bytes_for_blocks,
    source_block_indexes_for_window,
    require_signed_raster_dependencies,
    require_raster_analysis_georeferencing,
    require_bounded_source_structure,
)

def validate_supported_raster(dataset: Any, path: Path) -> None:
    """Validate that an opened raster is supported for calculations and clipping.

    Args:
        dataset: Open catalog-authorized dataset.
        path: Catalog-authorized source path.

    Raises:
        ProcessingError: For unsupported input structure or unsigned dependencies.
    """
    try:
        require_signed_raster_dependencies(dataset, path)
        require_raster_analysis_georeferencing(dataset)
        require_bounded_source_structure(dataset)
        if dataset.driver != "GTiff":
            raise ValueError("GeoTIFF required")
    except ValueError as error:
        raise ProcessingError("unsupported_source", str(error)) from error


def select_area(
    dataset: DatasetReader,
    kind: str,
    bounds: CanonicalWgs84Bounds | None,
    geometries: tuple[dict[str, object], ...],
    max_coordinates: int,
    resolved: ResolvedCatalogSelection | None = None,
    *,
    max_retained_polygon_bytes: int = 0,
) -> SelectedRasterArea:
    """Project an already-validated bounds/polygon selection value through neutral mechanisms.

    Args:
        dataset: Validated open native raster.
        kind: Explicit box, catalog descriptor, or historical polygon variant.
        bounds: Canonical WGS84 rectangle.
        geometries: Immutable polygon selection polygons.
        max_coordinates: Transformation budget.
        resolved: Reauthorized original vector source for catalog selections only.
        max_retained_polygon_bytes: Optional calculation-local polygon memory budget;
            zero preserves the streaming reader used by clips and planning.

    Returns:
        Native window and projected geometry for operation-owned inclusion rules.

    Raises:
        ProcessingError: If the area is unavailable, invalid, or exceeds bounded work.
    """
    try:
        if kind == "catalogSelection":
            if resolved is None:
                raise ValueError(
                    "Catalog source must be authorized before native execution"
                )
            reader = PolygonRasterizer(
                dataset,
                resolved,
                max_coordinates,
                max_retained_polygon_bytes=max_retained_polygon_bytes,
            )
            return SelectedRasterArea(
                source_window=reader.source_window, projected_geometries=reader
            )
        if kind == "bounds":
            return selected_raster_area_for_wgs84_bounds(dataset, bounds)
        return selected_raster_area_for_wgs84_polygons(
            dataset, geometries, max_coordinates
        )
    except ProjectedGeometryMemoryError as error:
        raise ProcessingError(
            "polygon_memory_limit",
            f"Selected polygons cannot fit within the "
            f"{max_retained_polygon_bytes / 1024**2:.1f} MiB geometry allowance. "
            "Filter the vector more narrowly or select a smaller area.",
            413,
        ) from error
    except NoRasterBoundsOverlapError as error:
        raise ProcessingError(
            "no_overlap", "The selected area does not overlap this raster."
        ) from error
    except (ValueError, TypeError, OverflowError) as error:
        raise ProcessingError(
            "invalid_area",
            "The selected area cannot be projected within the processing geometry limit.",
        ) from error


def native_work(
    dataset: Any, window: Any, max_blocks: int, max_decoded_bytes: int
) -> tuple[int, int]:
    """Bound block-index allocation and total decoded source work before reading.

    Args:
        dataset: Validated native dataset.
        window: Integral requested source window.
        max_blocks: Maximum number of intersecting blocks.
        max_decoded_bytes: Maximum decoded bytes across those blocks.

    Returns:
        Native block count and decoded byte count.

    Raises:
        ProcessingError: If the conservative block estimate or decoded byte
            count exceeds its limit, with both amounts in the public detail.
    """
    bh, bw = dataset.block_shapes[0]
    # Include one boundary block per axis to bound index allocation before
    # constructing the tuple. This is an admission estimate, not an exact count.
    estimated_blocks = (math.ceil(window.width / bw) + 1) * (
        math.ceil(window.height / bh) + 1
    )
    if estimated_blocks > max_blocks:
        raise ProcessingError(
            "source_work_too_large",
            f"The selected area's conservative estimate is {estimated_blocks:,} "
            f"native blocks; the limit is {max_blocks:,} "
            f"({estimated_blocks - max_blocks:,} over the limit). "
            f"Choose a smaller area with an estimate of {max_blocks:,} blocks or fewer.",
            413,
        )
    blocks = source_block_indexes_for_window(window, dataset.block_shapes[0])
    decoded = decoded_source_bytes_for_blocks(dataset, blocks)
    if decoded > max_decoded_bytes:
        raise ProcessingError(
            "source_work_too_large",
            f"The selected area requires {decoded:,} decoded bytes for source "
            f"values and validity masks; the limit is {max_decoded_bytes:,} bytes "
            f"({decoded - max_decoded_bytes:,} bytes over). Choose a smaller area "
            f"requiring at most {max_decoded_bytes:,} decoded bytes.",
            413,
        )
    return len(blocks), decoded
