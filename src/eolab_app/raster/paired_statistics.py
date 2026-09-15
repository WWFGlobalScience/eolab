"""Bounded X-reference pairing and two-dimensional raster statistics."""

from eolab_app.bounded_vector import pixels_inside_area, selection_summary
import math
from pathlib import Path

import numpy
import rasterio
from affine import TransformNotInvertibleError
from rasterio.transform import array_bounds, xy
from rasterio.warp import transform, transform_bounds
from rasterio.windows import Window, transform as window_transform
from eolab_app.sampling_area import CatalogSelectionSamplingArea

from eolab_app.raster.bounded_window import (
    BOUNDED_SOURCE_WINDOW_PADDING_PIXELS,
    BOUNDED_WGS84_DENSIFY_POINTS,
    NoRasterBoundsOverlapError,
    selected_raster_area_for_wgs84_bounds,
)
from eolab_app.raster.models import (
    CanonicalWgs84Bounds,
    RASTER_PAIRED_STATISTICS_BIN_COUNT,
    RasterPairedHistogram,
    RasterPairedStatistics,
    Wgs84Bounds,
)
from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    require_active_raster_read,
)
from eolab_app.raster.sample_grid import (
    SAMPLE_GRID_MAX_TRANSFORMED_POSITIONS,
    SourcePosition,
    overview_sample_grid_policy_parameters,
    plan_sample_grid_for_source_positions,
    plan_source_window_sample_grid,
    read_planned_sample_grid,
    read_planned_sample_grid_from_overview,
    sample_grid_policy_parameters,
)
from eolab_app.raster.source_contract import (
    BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
)
from eolab_app.raster.statistics import (
    NoValidRasterSamplesError,
    selected_raster_area_for_catalog_selection,
    RASTER_STATISTICS_SELECTION_ALL_TOUCHED,
)

RASTER_PAIRED_STATISTICS_ALGORITHM = "x-reference-nearest-paired-v4-catalog-selection"


def raster_paired_statistics_policy_parameters() -> tuple[int, ...]:
    """Return every fixed resource and histogram input in cache identity.

    Returns:
        Histogram, grid, overview, transformation, native-block, and
        decoded-work limits.
    """
    return (
        RASTER_PAIRED_STATISTICS_BIN_COUNT,
        BOUNDED_WGS84_DENSIFY_POINTS,
        BOUNDED_SOURCE_WINDOW_PADDING_PIXELS,
        *sample_grid_policy_parameters(),
        *overview_sample_grid_policy_parameters(),
        BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES,
    )


def _source_window_for_positions(
    cell_positions: tuple[tuple[SourcePosition, ...], ...],
) -> Window | None:
    """Return the smallest integral window containing explicit positions.

    Args:
        cell_positions: Row-major source positions with empty tuples for cells
            outside the source.

    Returns:
        Minimal positive source-pixel window, or ``None`` when every cell is
        empty.
    """
    positions = [position for cell in cell_positions for position in cell]
    if not positions:
        return None
    rows = [position[0] for position in positions]
    columns = [position[1] for position in positions]
    row_start = min(rows)
    column_start = min(columns)
    return Window(
        column_start,
        row_start,
        max(columns) - column_start + 1,
        max(rows) - row_start + 1,
    )


def _dataset_wgs84_bounds(
    dataset: rasterio.io.DatasetReader,
) -> CanonicalWgs84Bounds:
    """Return one finite non-wrapping WGS 84 source envelope.

    Args:
        dataset: Open georeferenced raster source.

    Returns:
        Canonical WGS 84 source bounds.

    Raises:
        ValueError: If transformation produces an empty or non-finite envelope.
        rasterio.errors.RasterioError: If CRS transformation fails.
    """
    source_bounds = array_bounds(
        dataset.height,
        dataset.width,
        dataset.transform,
    )
    west, south, east, north = transform_bounds(
        dataset.crs,
        "EPSG:4326",
        *source_bounds,
        densify_pts=BOUNDED_WGS84_DENSIFY_POINTS,
    )
    bounds = (
        max(-180.0, float(west)),
        max(-90.0, float(south)),
        min(180.0, float(east)),
        min(90.0, float(north)),
    )
    if not all(math.isfinite(value) for value in bounds) or not (
        bounds[0] < bounds[2] and bounds[1] < bounds[3]
    ):
        raise ValueError("Raster WGS 84 bounds are invalid for pairing")
    return bounds


def _intersect_bounds(
    *bounds_values: CanonicalWgs84Bounds,
) -> CanonicalWgs84Bounds:
    """Intersect canonical rectangles without antimeridian wrapping.

    Args:
        *bounds_values: Two or more ordered WGS 84 rectangles.

    Returns:
        Strict geographic intersection.

    Raises:
        NoRasterBoundsOverlapError: If the rectangles do not overlap.
    """
    intersection = (
        max(bounds[0] for bounds in bounds_values),
        max(bounds[1] for bounds in bounds_values),
        min(bounds[2] for bounds in bounds_values),
        min(bounds[3] for bounds in bounds_values),
    )
    if not (
        intersection[0] < intersection[2]
        and intersection[1] < intersection[3]
    ):
        raise NoRasterBoundsOverlapError
    return intersection


def _aligned_y_positions(
    x_dataset: rasterio.io.DatasetReader,
    y_dataset: rasterio.io.DatasetReader,
    x_positions: tuple[tuple[SourcePosition, ...], ...],
    selected_bounds: CanonicalWgs84Bounds,
) -> tuple[tuple[SourcePosition, ...], ...]:
    """Map X-cell centers to nearest Y cells under a bounded point count.

    X owns the sample grid. Every valid X cell contributes at most one Y
    source position, and cells outside the exact geographic intersection are
    represented as empty cells rather than being clamped to a raster edge.

    Args:
        x_dataset: Open X reference source.
        y_dataset: Open Y source aligned to X.
        x_positions: Admitted row-major X grid positions.
        selected_bounds: Exact WGS 84 overlap or selected intersection.

    Returns:
        Row-major Y source positions matching the X grid shape.

    Raises:
        ValueError: If transforms are non-invertible or non-finite.
        rasterio.errors.RasterioError: If CRS transformation fails.
    """
    flattened_x = [cell[0] for cell in x_positions if cell]
    if len(flattened_x) > SAMPLE_GRID_MAX_TRANSFORMED_POSITIONS:
        raise ValueError("Paired raster grid exceeds its transformed-point limit")
    rows = [position[0] for position in flattened_x]
    columns = [position[1] for position in flattened_x]
    x_coordinates, y_coordinates = xy(
        x_dataset.transform,
        rows,
        columns,
        offset="center",
    )
    longitudes, latitudes = transform(
        x_dataset.crs,
        "EPSG:4326",
        list(x_coordinates),
        list(y_coordinates),
    )
    target_x, target_y = transform(
        x_dataset.crs,
        y_dataset.crs,
        list(x_coordinates),
        list(y_coordinates),
    )
    try:
        inverse_y_transform = ~y_dataset.transform
    except TransformNotInvertibleError:
        raise ValueError("Y raster affine transform is not invertible") from None

    west, south, east, north = selected_bounds
    aligned: list[tuple[SourcePosition, ...]] = []
    transformed_index = 0
    for cell in x_positions:
        if not cell:
            aligned.append(())
            continue
        longitude = float(longitudes[transformed_index])
        latitude = float(latitudes[transformed_index])
        target_coordinate = (
            float(target_x[transformed_index]),
            float(target_y[transformed_index]),
        )
        transformed_index += 1
        if not all(
            math.isfinite(value)
            for value in (longitude, latitude, *target_coordinate)
        ):
            raise ValueError("Paired raster position transformation is non-finite")
        if not (
            west <= longitude <= east and south <= latitude <= north
        ):
            aligned.append(())
            continue
        column_position, row_position = inverse_y_transform * target_coordinate
        row = math.floor(row_position)
        column = math.floor(column_position)
        aligned.append(
            ((row, column),)
            if 0 <= row < y_dataset.height and 0 <= column < y_dataset.width
            else ()
        )
    return tuple(aligned)


def _strict_histogram_range(
    minimum: float,
    maximum: float,
) -> tuple[float, float]:
    """Return an ordered finite histogram range for varying or constant data.

    Args:
        minimum: Finite sample minimum.
        maximum: Finite sample maximum no lower than ``minimum``.

    Returns:
        Strict lower and upper histogram bounds containing the sample.
    """
    if minimum < maximum:
        return minimum, maximum
    padding = max(abs(minimum) * 1e-6, 1e-12)
    lower = minimum - padding
    upper = maximum + padding
    if not math.isfinite(lower):
        lower = minimum
    if not math.isfinite(upper):
        upper = maximum
    if lower < upper:
        return lower, upper
    return (
        math.nextafter(minimum, -math.inf),
        math.nextafter(maximum, math.inf),
    )


def read_raster_paired_statistics(
    x_source_path: Path,
    y_source_path: Path,
    selected_bounds: CanonicalWgs84Bounds | None,
    cancellation_requested: RasterReadCancellationCheck | None = None,
    catalog_selection: CatalogSelectionSamplingArea | None = None,
) -> RasterPairedStatistics:
    """Read bounded paired values on X and align Y with nearest neighbor.

    The X raster is asymmetric by design: its geographic overlap window owns
    the reference grid and sampling density. Swapping X and Y can therefore
    change sampled positions and counts when source grids differ. Each source
    prefers one bounded signed internal-overview read and otherwise uses its
    admitted native-block plan. At most 127 by 127 paired cells reach the
    histogram.

    Args:
        x_source_path: Authorized mounted X-reference GeoTIFF.
        y_source_path: Authorized mounted Y GeoTIFF.
        selected_bounds: Optional canonical WGS 84 sampling rectangle.
        catalog_selection: Optional immutable polygon selection; exclusive of bounds.
        cancellation_requested: Optional thread-safe obsolescence predicate.

    Returns:
        Bounded 32-by-32 paired histogram, marginals, ranges, and provenance.

    Raises:
        NoRasterBoundsOverlapError: If sources or selected bounds do not overlap.
        NoValidRasterSamplesError: If no cell is valid in both rasters.
        RasterReadCancelled: If every coalesced request waiter disconnects.
        OSError: If a source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open, transform, or read.
        ValueError: If source, grid, transform, or work limits are invalid.
    """
    require_active_raster_read(cancellation_requested)
    with (
        rasterio.open(x_source_path) as x_dataset,
        rasterio.open(y_source_path) as y_dataset,
    ):
        for dataset, source_path in (
            (x_dataset, x_source_path),
            (y_dataset, y_source_path),
        ):
            require_signed_raster_dependencies(dataset, source_path)
            require_raster_analysis_georeferencing(dataset)
        overlap_inputs = (
            _dataset_wgs84_bounds(x_dataset),
            _dataset_wgs84_bounds(y_dataset),
        )
        if catalog_selection is not None:
            overlap_inputs = (
                *overlap_inputs,
                selection_summary(catalog_selection.resolved, cancellation_requested)[
                    "bbox"
                ],
            )
        if selected_bounds is not None:
            overlap_inputs = (*overlap_inputs, selected_bounds)
        overlap_bounds = _intersect_bounds(*overlap_inputs)
        x_area = selected_raster_area_for_wgs84_bounds(
            x_dataset,
            overlap_bounds,
        )
        polygon_area = (
            selected_raster_area_for_catalog_selection(
                x_dataset, catalog_selection, cancellation_requested
            )
            if catalog_selection
            else None
        )
        x_window = x_area.source_window
        x_plan = plan_source_window_sample_grid(x_dataset, x_window)
        y_positions = _aligned_y_positions(
            x_dataset,
            y_dataset,
            x_plan.cell_positions,
            overlap_bounds,
        )
        y_plan = plan_sample_grid_for_source_positions(
            y_dataset,
            x_plan.width,
            x_plan.height,
            y_positions,
        )
        y_window = _source_window_for_positions(y_plan.cell_positions)
        x_sample = read_planned_sample_grid_from_overview(
            x_dataset,
            x_window,
            x_plan,
            cancellation_requested,
        )
        if x_sample is None:
            x_sample = read_planned_sample_grid(
                x_dataset,
                x_plan,
                cancellation_requested,
            )
        y_sample = (
            read_planned_sample_grid_from_overview(
                y_dataset,
                y_window,
                y_plan,
                cancellation_requested,
            )
            if y_window is not None
            else None
        )
        if y_sample is None:
            y_sample = read_planned_sample_grid(
                y_dataset,
                y_plan,
                cancellation_requested,
            )
        if polygon_area is not None:
            sample_transform = window_transform(x_window, x_dataset.transform) * rasterio.Affine.scale(
                x_window.width / x_plan.width, x_window.height / x_plan.height,
            )
            outside = ~pixels_inside_area(
                polygon_area.projected_geometries,
                out_shape=x_sample.shape,
                transform=sample_transform,
                all_touched=RASTER_STATISTICS_SELECTION_ALL_TOUCHED,
            )
            x_sample = numpy.ma.array(numpy.ma.getdata(x_sample),
                mask=numpy.logical_or(numpy.ma.getmaskarray(x_sample), outside))
        require_active_raster_read(cancellation_requested)

    paired_mask = numpy.logical_or(
        numpy.ma.getmaskarray(x_sample),
        numpy.ma.getmaskarray(y_sample),
    )
    x_values = numpy.asarray(
        numpy.ma.array(numpy.ma.getdata(x_sample), mask=paired_mask).compressed(),
        dtype=numpy.float64,
    )
    y_values = numpy.asarray(
        numpy.ma.array(numpy.ma.getdata(y_sample), mask=paired_mask).compressed(),
        dtype=numpy.float64,
    )
    finite = numpy.logical_and(numpy.isfinite(x_values), numpy.isfinite(y_values))
    x_values = x_values[finite]
    y_values = y_values[finite]
    if x_values.size == 0:
        raise NoValidRasterSamplesError

    x_minimum = float(numpy.min(x_values))
    x_maximum = float(numpy.max(x_values))
    y_minimum = float(numpy.min(y_values))
    y_maximum = float(numpy.max(y_values))
    x_range = _strict_histogram_range(x_minimum, x_maximum)
    y_range = _strict_histogram_range(y_minimum, y_maximum)
    counts_xy, x_edges, y_edges = numpy.histogram2d(
        x_values,
        y_values,
        bins=RASTER_PAIRED_STATISTICS_BIN_COUNT,
        range=(x_range, y_range),
    )
    counts_yx = counts_xy.astype(numpy.int64).T
    x_marginals = numpy.sum(counts_yx, axis=0)
    y_marginals = numpy.sum(counts_yx, axis=1)
    source_width = int(x_window.width)
    source_height = int(x_window.height)
    is_exact = (
        x_plan.width == source_width and x_plan.height == source_height
    )
    selected_bounds_model = (
        Wgs84Bounds(
            west=selected_bounds[0],
            south=selected_bounds[1],
            east=selected_bounds[2],
            north=selected_bounds[3],
        )
        if selected_bounds is not None
        else None
    )
    return RasterPairedStatistics(
        scope=(
            "catalogSelection"
            if catalog_selection
            else "selectedArea" if selected_bounds is not None else "wholeOverlap"
        ),
        catalogSelection=(
            catalog_selection.resolved.selection if catalog_selection else None
        ),
        selectedBounds=selected_bounds_model,
        sourceWidth=source_width,
        sourceHeight=source_height,
        sourcePixelCount=source_width * source_height,
        sampleWidth=x_plan.width,
        sampleHeight=x_plan.height,
        sampledCellCount=x_plan.width * x_plan.height,
        pairedSampleCount=int(x_values.size),
        samplingMethod="exactReferenceGrid" if is_exact else "sampleGrid",
        approximate=not is_exact,
        xMinimum=x_minimum,
        xMaximum=x_maximum,
        yMinimum=y_minimum,
        yMaximum=y_maximum,
        histogram=RasterPairedHistogram(
            xEdges=[float(edge) for edge in x_edges],
            yEdges=[float(edge) for edge in y_edges],
            counts=[[int(count) for count in row] for row in counts_yx],
            xMarginalCounts=[int(count) for count in x_marginals],
            yMarginalCounts=[int(count) for count in y_marginals],
        ),
    )
