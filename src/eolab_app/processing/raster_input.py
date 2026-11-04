"""Shared source checks and native-area planning for clip and aggregate kernels."""

from eolab_app.bounded_vector import (
    PolygonRasterizer,
    ProjectedGeometryMemoryError,
)
from eolab_app.sampling_box import Wgs84SamplingBox
from eolab_app.catalog_selection import ResolvedCatalogSelection
import math
from typing import Any
from rasterio.io import DatasetReader

from eolab_app.processing.models import ProcessingError
from eolab_app.raster.source_models import (
    RasterAnalysisSourceReference,
    RunArtifactReference,
)
from eolab_app.raster.reader import RasterData
from eolab_app.raster.bounded_window import (
    NoRasterBoundsOverlapError,
    selected_raster_area_for_wgs84_bounds,
    selected_raster_area_for_sampling_box,
    selected_raster_area_for_wgs84_polygons,
)
from eolab_app.raster.models import SelectedRasterArea, CanonicalWgs84Bounds
from eolab_app.raster.source_contract import (
    require_signed_raster_dependencies,
    require_raster_analysis_georeferencing,
    require_bounded_source_structure,
)


def raster_source_filename_prefix(source: RasterAnalysisSourceReference) -> str:
    """Name a derived file using its catalog item or published artifact identity.

    Args:
        source: Validated path-free raster reference.

    Returns:
        A portable filename prefix containing no server path or user-supplied label.
    """
    return (
        source.artifact_id
        if isinstance(source, RunArtifactReference)
        else source.item_id
    )


def validate_supported_raster(dataset: Any, raster_data: RasterData) -> None:
    """Validate that an opened raster is supported for calculations and clipping.

    Args:
        dataset: Open catalog-authorized dataset.
        raster_data: Confined source path or admitted temporal observation.

    Raises:
        ProcessingError: For unsupported input structure or unsigned dependencies.
    """
    try:
        require_signed_raster_dependencies(dataset, raster_data)
        require_raster_analysis_georeferencing(dataset)
        require_bounded_source_structure(dataset, maximum_block_bytes=None)
        if dataset.driver != "GTiff":
            raise ValueError("GeoTIFF required")
    except ValueError as error:
        raise ProcessingError("unsupported_source", str(error)) from error


def select_area(
    dataset: DatasetReader,
    kind: str,
    bounds: CanonicalWgs84Bounds | None,
    geometries: tuple[dict[str, object], ...],
    max_coordinates: int | None,
    resolved: ResolvedCatalogSelection | None = None,
    *,
    max_retained_polygon_bytes: int | None = 0,
    sampling_box: Wgs84SamplingBox | None = None,
) -> SelectedRasterArea:
    """Locate a selected area on the raster grid and prepare its polygon-mask source.

    Args:
        dataset: Validated open native raster.
        kind: Explicit box, catalog descriptor, or owned polygon input.
        bounds: Canonical WGS84 envelope retained with the area.
        sampling_box: Validated descriptor when kind is samplingBox; no stored ring.
        geometries: Immutable polygon selection polygons.
        max_coordinates: Transformation coordinate ceiling, or None for no ceiling.
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
                read_limits=None,
            )
            return SelectedRasterArea(
                source_window=reader.source_window, projected_geometries=reader
            )
        if kind == "samplingBox":
            return selected_raster_area_for_sampling_box(
                dataset, sampling_box, max_coordinates
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
            "The selected area could not be projected onto this raster. Check its geometry and coordinate system.",
        ) from error


def count_native_raster_blocks(dataset: Any, window: Any) -> int:
    """Count source blocks intersecting a window using grid metadata alone.

    Args:
        dataset: Validated native raster with regular block dimensions.
        window: Integral source window.

    Returns:
        Number of data blocks used for progress, without enumerating or reading
        blocks or estimating the calculation's memory and disk requirements.
    """
    height, width = dataset.block_shapes[0]
    columns = math.ceil((window.col_off + window.width) / width) - math.floor(
        window.col_off / width
    )
    rows = math.ceil((window.row_off + window.height) / height) - math.floor(
        window.row_off / height
    )
    return columns * rows
