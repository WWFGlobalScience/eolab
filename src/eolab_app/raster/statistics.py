"""Bounded raster sampling and distribution algorithms."""

from eolab_app.bounded_vector import ProjectedCatalogSelection, pixels_inside_area
import math
from pathlib import Path

import numpy
import rasterio
from rasterio.warp import transform
from rasterio.windows import Window, transform as window_transform

from eolab_app.raster.bounded_window import (
    selected_raster_area_for_wgs84_polygons,
    BOUNDED_SOURCE_WINDOW_PADDING_PIXELS as RASTER_STATISTICS_SOURCE_WINDOW_PADDING_PIXELS,
    BOUNDED_WGS84_DENSIFY_POINTS as RASTER_STATISTICS_BOUNDS_DENSIFY_POINTS,
    NoRasterBoundsOverlapError,
    densified_wgs84_bounds_ring,
    selected_raster_area_for_wgs84_bounds as _selected_raster_area_for_wgs84_bounds,
)
from eolab_app.raster.exact_source import (
    EXACT_SOURCE_MAX_BLOCK_READS,
    EXACT_SOURCE_MAX_DECODED_BYTES,
    EXACT_SOURCE_MAX_DIMENSION,
    plan_exact_source_window,
    read_exact_source_window,
)
from eolab_app.raster.models import (
    CanonicalWgs84Bounds,
    RasterHistogram,
    RasterPercentiles,
    RasterStatistics,
    RasterValueRange,
    SelectedRasterArea,
    Wgs84Bounds,
)
from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    require_active_raster_read,
)
from eolab_app.raster.sample_grid import (
    overview_sample_grid_policy_parameters,
    read_source_window_sample_grid,
    sample_grid_policy_parameters,
)
from eolab_app.raster.source_contract import (
    BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
)
from eolab_app.sampling_area import (
    RasterSamplingArea,
    SelectedBoundsSamplingArea,
    CatalogSelectionSamplingArea,
    WholeRasterSamplingArea,
)

RASTER_STATISTICS_ALGORITHM = "rendering-independent-bounded-area-v7"
RASTER_STATISTICS_BIN_COUNT = 64
RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES = 500_000
# Match the ESOS-C catalog selection contract: a resampled cell contributes when the
# transformed selection touches it, including cells crossed only at an edge.
RASTER_STATISTICS_SELECTION_ALL_TOUCHED = True


def raster_statistics_policy_parameters() -> tuple[int, ...]:
    """Return every fixed planning input used by cache identity.

    Returns:
        Native-block, sampling-grid, exact-window, geometry, and point-location
        parameters.
    """
    return (
        RASTER_STATISTICS_BIN_COUNT,
        RASTER_STATISTICS_BOUNDS_DENSIFY_POINTS,
        RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES,
        RASTER_STATISTICS_SOURCE_WINDOW_PADDING_PIXELS,
        int(RASTER_STATISTICS_SELECTION_ALL_TOUCHED),
        BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES,
        *sample_grid_policy_parameters(),
        *overview_sample_grid_policy_parameters(),
        EXACT_SOURCE_MAX_DIMENSION,
        EXACT_SOURCE_MAX_BLOCK_READS,
        EXACT_SOURCE_MAX_DECODED_BYTES,
    )


class NoValidRasterSamplesError(ValueError):
    """Raised when a bounded sample contains no finite data values."""


def selected_raster_area_for_wgs84_bounds(
    dataset: rasterio.io.DatasetReader,
    selected_bounds: CanonicalWgs84Bounds,
) -> SelectedRasterArea:
    """Preserve the statistics module's public bounded-window contract.

    Args:
        dataset: Open source raster with a coordinate reference system.
        selected_bounds: Canonical west, south, east, north WGS 84 bounds.

    Returns:
        Projected selection polygon and clipped source-pixel envelope.

    Raises:
        NoRasterBoundsOverlapError: If the selection misses the raster.
        ValueError: If the bounds cannot be transformed to the raster CRS.
    """
    return _selected_raster_area_for_wgs84_bounds(
        dataset,
        selected_bounds,
        coordinate_transform=transform,
    )


def strict_raster_value_range(
    sample_minimum: float,
    sample_maximum: float,
    p05: float,
    p50: float,
    p95: float,
) -> RasterValueRange:
    """Derive a finite, strictly ordered style range from sample values.

    Args:
        sample_minimum: Lowest sampled value.
        sample_maximum: Highest sampled value.
        p05: Fifth sample percentile.
        p50: Median sample value.
        p95: Ninety-fifth sample percentile.

    Returns:
        Strict range safe for downstream color and style controls.
    """
    if p05 < p50 < p95:
        return RasterValueRange(minimum=p05, midpoint=p50, maximum=p95)

    percentile_padding = max(
        max(abs(value) for value in (p05, p50, p95)) * 1e-6,
        1e-12,
    )
    padded_minimum = p05 - percentile_padding if p05 == p50 else p05
    padded_maximum = p95 + percentile_padding if p50 == p95 else p95
    if (
        all(
            math.isfinite(value)
            for value in (padded_minimum, p50, padded_maximum)
        )
        and padded_minimum < p50 < padded_maximum
    ):
        return RasterValueRange(
            minimum=padded_minimum,
            midpoint=p50,
            maximum=padded_maximum,
        )

    if sample_minimum < sample_maximum:
        midpoint = sample_minimum / 2 + sample_maximum / 2
        if sample_minimum < midpoint < sample_maximum:
            return RasterValueRange(
                minimum=sample_minimum,
                midpoint=midpoint,
                maximum=sample_maximum,
            )

        lower_value = math.nextafter(sample_minimum, -math.inf)
        if math.isfinite(lower_value):
            return RasterValueRange(
                minimum=lower_value,
                midpoint=sample_minimum,
                maximum=sample_maximum,
            )
        upper_value = math.nextafter(sample_maximum, math.inf)
        return RasterValueRange(
            minimum=sample_minimum,
            midpoint=sample_maximum,
            maximum=upper_value,
        )

    constant_value = sample_minimum
    scale_relative_padding = max(abs(constant_value) * 1e-6, 1e-12)
    lower_value = constant_value - scale_relative_padding
    upper_value = constant_value + scale_relative_padding
    if (
        all(
            math.isfinite(value)
            for value in (lower_value, constant_value, upper_value)
        )
        and lower_value < constant_value < upper_value
    ):
        return RasterValueRange(
            minimum=lower_value,
            midpoint=constant_value,
            maximum=upper_value,
        )

    lower_value = math.nextafter(constant_value, -math.inf)
    upper_value = math.nextafter(constant_value, math.inf)
    if math.isfinite(lower_value) and math.isfinite(upper_value):
        return RasterValueRange(
            minimum=lower_value,
            midpoint=constant_value,
            maximum=upper_value,
        )
    if math.isfinite(lower_value):
        return RasterValueRange(
            minimum=math.nextafter(lower_value, -math.inf),
            midpoint=lower_value,
            maximum=constant_value,
        )
    return RasterValueRange(
        minimum=constant_value,
        midpoint=upper_value,
        maximum=math.nextafter(upper_value, math.inf),
    )


def selected_raster_area_for_catalog_selection(
    dataset: rasterio.io.DatasetReader,
    sampling_area: CatalogSelectionSamplingArea,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> SelectedRasterArea:
    """Read a catalog selection using the statistics owner's transformation budget.

    Args:
        dataset: Open, georeferenced source raster.
        sampling_area: Immutable catalog descriptor and authorized original source.
        cancellation_requested: Optional thread-safe cancellation predicate.

    Returns:
        Projected polygon union and bounded source window.

    Raises:
        ValueError: If projection fails or exceeds the statistics budget.
        NoRasterBoundsOverlapError: If the selection misses the source grid.
    """
    reader = ProjectedCatalogSelection(
        dataset,
        sampling_area.resolved,
        RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES,
        cancellation_requested,
    )
    return SelectedRasterArea(
        source_window=reader.source_window, projected_geometries=reader
    )


def read_raster_statistics(
    source_path: Path,
    sampling_area: RasterSamplingArea,
    cancellation_requested: RasterReadCancellationCheck | None = None,
) -> RasterStatistics:
    """Read band-1 statistics through one bounded source-work planner.

    Every scope first resolves a finite integral source envelope. Envelopes
    satisfying the exact dimension, block, and decoded-byte ceilings are read
    completely one native block at a time. Broader envelopes use the fixed
    127-longest-edge center grid, whose unique blocks and cumulative decoded
    work are proven before I/O. Broad grids prefer a suitable signed embedded
    overview and otherwise retain exact native-block center sampling. Neither
    path relies on WMS publication or rendering state.

    Args:
        source_path: Authorized mounted GeoTIFF.
        sampling_area: Explicit whole, selected-bounds, or resolved catalog selection.
        cancellation_requested: Optional thread-safe obsolescence predicate.

    Returns:
        Finite sample distribution and a suggested display range.

    Raises:
        NoRasterBoundsOverlapError: If selected geometry misses the raster.
        NoValidRasterSamplesError: If the sample has no finite data values.
        OSError: If the source cannot be read.
        rasterio.errors.RasterioError: If GDAL cannot open or sample it.
        RasterReadCancelled: If every coalesced request waiter disconnects.
        TypeError: If the sampling area is outside the strict area union.
        ValueError: If source structure, CRS, transformation, or bounded-read
            admission is invalid.
    """
    require_active_raster_read(cancellation_requested)
    with rasterio.open(source_path) as dataset:
        require_active_raster_read(cancellation_requested)
        require_signed_raster_dependencies(dataset, source_path)
        require_raster_analysis_georeferencing(dataset)
        if isinstance(sampling_area, SelectedBoundsSamplingArea):
            selected_area = selected_raster_area_for_wgs84_bounds(
                dataset,
                sampling_area.bounds,
            )
        elif isinstance(sampling_area, CatalogSelectionSamplingArea):
            selected_area = selected_raster_area_for_catalog_selection(
                dataset,
                sampling_area,
                cancellation_requested,
            )
        elif isinstance(sampling_area, WholeRasterSamplingArea):
            selected_area = None
        else:
            raise TypeError("Unsupported raster sampling area")
        source_window = selected_area.source_window if selected_area else Window(
            0,
            0,
            dataset.width,
            dataset.height,
        )
        source_width = int(source_window.width)
        source_height = int(source_window.height)
        exact_plan = plan_exact_source_window(dataset, source_window)
        if exact_plan is None:
            sample, _ = read_source_window_sample_grid(
                dataset,
                source_window,
                cancellation_requested,
            )
            sampling_method = "sampleGrid"
        else:
            sample = read_exact_source_window(
                dataset,
                exact_plan,
                cancellation_requested,
            )
            sampling_method = "exactSourceWindow"
        sample_height, sample_width = sample.shape
        if selected_area is not None:
            source_sample_transform = window_transform(
                source_window,
                dataset.transform,
            ) * rasterio.Affine.scale(
                source_width / sample_width,
                source_height / sample_height,
            )
            outside_selection = ~pixels_inside_area(
                selected_area.projected_geometries,
                out_shape=(sample_height, sample_width),
                transform=source_sample_transform,
                all_touched=RASTER_STATISTICS_SELECTION_ALL_TOUCHED,
            )
            if numpy.all(outside_selection):
                raise NoRasterBoundsOverlapError
            sample = numpy.ma.array(
                numpy.ma.getdata(sample),
                mask=numpy.logical_or(
                    numpy.ma.getmaskarray(sample),
                    outside_selection,
                ),
            )
        require_active_raster_read(cancellation_requested)

    sample_values = numpy.asarray(sample.compressed(), dtype=numpy.float64)
    sample_values = sample_values[numpy.isfinite(sample_values)]
    if sample_values.size == 0:
        raise NoValidRasterSamplesError

    sample_minimum = float(numpy.min(sample_values))
    sample_maximum = float(numpy.max(sample_values))
    p05, p50, p95 = (
        float(value)
        for value in numpy.percentile(sample_values, (5, 50, 95))
    )
    suggested_range = strict_raster_value_range(
        sample_minimum,
        sample_maximum,
        p05,
        p50,
        p95,
    )
    histogram_minimum = (
        sample_minimum
        if sample_minimum < sample_maximum
        else suggested_range.minimum
    )
    histogram_maximum = (
        sample_maximum
        if sample_minimum < sample_maximum
        else suggested_range.maximum
    )
    counts, edges = numpy.histogram(
        sample_values,
        bins=RASTER_STATISTICS_BIN_COUNT,
        range=(histogram_minimum, histogram_maximum),
    )
    source_pixel_count = source_width * source_height
    sampled_pixel_count = sample_width * sample_height
    selected_bounds_model = (
        Wgs84Bounds(
            west=sampling_area.bounds[0],
            south=sampling_area.bounds[1],
            east=sampling_area.bounds[2],
            north=sampling_area.bounds[3],
        )
        if isinstance(sampling_area, SelectedBoundsSamplingArea)
        else None
    )
    catalog_selection = (
        sampling_area.resolved.selection
        if isinstance(sampling_area, CatalogSelectionSamplingArea)
        else None
    )
    return RasterStatistics(
        scope=sampling_area.kind,
        selectedBounds=selected_bounds_model,
        catalogSelection=catalog_selection,
        sourceWidth=source_width,
        sourceHeight=source_height,
        sourcePixelCount=source_pixel_count,
        sampleWidth=sample_width,
        sampleHeight=sample_height,
        sampledPixelCount=sampled_pixel_count,
        validSampleCount=int(sample_values.size),
        samplingMethod=sampling_method,
        estimated=sampling_method == "sampleGrid",
        sampleMinimum=sample_minimum,
        sampleMaximum=sample_maximum,
        percentiles=RasterPercentiles(p05=p05, p50=p50, p95=p95),
        histogram=RasterHistogram(
            counts=[int(count) for count in counts],
            edges=[float(edge) for edge in edges],
        ),
        suggestedRange=suggested_range,
    )
