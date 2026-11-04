"""Area-weighted numeric category distributions over bounded native samples."""

import numpy
import rasterio
from numpy.typing import NDArray
from pyproj import Transformer
from pyproj.exceptions import ProjError
from rasterio.windows import Window, transform as window_transform

from eolab_app.bounded_vector import PolygonRasterizer, pixels_inside_area
from eolab_app.raster.exact_source import (
    plan_exact_source_window,
    read_exact_source_window,
)
from eolab_app.raster.models import RasterCategoricalDistribution, RasterStatistics
from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    require_active_raster_read,
)
from eolab_app.raster.sample_grid import (
    SAMPLE_GRID_MAX_DIMENSION,
    plan_source_window_sample_grid,
    read_planned_sample_grid,
    sample_grid_policy_parameters,
)
from eolab_app.raster.reader import RasterData, RasterDataset, open_raster_data
from eolab_app.raster.source_contract import (
    geographic_cell_edges,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
)
from eolab_app.raster.bounded_window import selected_raster_area_for_sampling_box
from eolab_app.raster.statistics import (
    selected_raster_area_for_wgs84_bounds,
    selected_raster_area_for_catalog_selection,
    RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES,
    summarize_raster_sample,
)
from eolab_app.sampling_area import (
    RasterSamplingArea,
    SelectedBoundsSamplingArea,
    SamplingBoxArea,
    CatalogSelectionSamplingArea,
    WholeRasterSamplingArea,
)

CATEGORICAL_STATISTICS_ALGORITHM = "native-categorical-ground-area-v2"
CATEGORICAL_AREA_SUBDIVISIONS = 4
CATEGORICAL_AREA_MAX_COORDINATES = 500_000
CATEGORICAL_EQUAL_AREA_CRS = (
    "+proj=cea +lat_ts=0 +lon_0=0 +datum=WGS84 +units=m +no_defs"
)


def categorical_statistics_policy_parameters() -> tuple[int, ...]:
    """Return the fixed native-sampling and ground-area cache policy.

    Returns:
        Native-work, sample-grid, subcell-mask and coordinate limits.
    """
    return (
        *sample_grid_policy_parameters(),
        CATEGORICAL_AREA_SUBDIVISIONS,
        CATEGORICAL_AREA_MAX_COORDINATES,
    )


def estimate_sample_cell_areas_hectares(
    dataset: RasterDataset,
    source_window: Window,
    sample_shape: tuple[int, int],
    projected_geometries: tuple[dict[str, object], ...] | PolygonRasterizer | None,
    cancellation_requested: RasterReadCancellationCheck | None,
) -> NDArray[numpy.float64]:
    """Estimate the area in hectares that each sample cell represents in the selection.

    Each cell is subdivided into a fixed four-by-four grid. Subcell areas are
    measured in an equal-area projection and included when their centers fall
    inside the selection. Polygon holes are excluded and overlaps count once.
    These are sampling estimates, distinct from Processing's per-pixel areas.

    Args:
        dataset: Open georeferenced raster whose native block sizes passed read limits.
        source_window: Clipped integral source envelope represented by the sample.
        sample_shape: Bounded grid height and width, at most 127 per edge.
        projected_geometries: Selected polygons in the raster CRS, or a reader that rasterizes them.
        cancellation_requested: Optional last-waiter cancellation predicate.

    Returns:
        Nonnegative selected hectares per representative sample cell.

    Raises:
        ValueError: If coordinate work, CRS transformation or longitude domain
            is unsupported, or no selected coverage is represented.
        RasterReadCancelled: If all request waiters have disconnected.
    """
    require_active_raster_read(cancellation_requested)
    height, width = sample_shape
    subdivisions = CATEGORICAL_AREA_SUBDIVISIONS
    fine_height, fine_width = height * subdivisions, width * subdivisions
    if (fine_height + 1) * (fine_width + 1) > CATEGORICAL_AREA_MAX_COORDINATES:
        raise ValueError("Categorical ground-area grid exceeds its coordinate limit")
    sample_transform = window_transform(
        source_window, dataset.transform
    ) * rasterio.Affine.scale(
        source_window.width / fine_width, source_window.height / fine_height
    )
    columns, rows = numpy.meshgrid(
        numpy.arange(fine_width + 1), numpy.arange(fine_height + 1)
    )
    native_x = (
        sample_transform.a * columns + sample_transform.b * rows + sample_transform.c
    )
    native_y = (
        sample_transform.d * columns + sample_transform.e * rows + sample_transform.f
    )
    try:
        to_wgs84 = Transformer.from_crs(
            dataset.crs,
            "EPSG:4326",
            always_xy=True,
            allow_ballpark=False,
            only_best=True,
            force_over=True,
        )
        longitudes, latitudes = to_wgs84.transform(native_x, native_y, errcheck=True)
        longitudes, latitudes = geographic_cell_edges(dataset, longitudes, latitudes)
        to_equal_area = Transformer.from_crs(
            "EPSG:4326",
            CATEGORICAL_EQUAL_AREA_CRS,
            always_xy=True,
            allow_ballpark=False,
            only_best=True,
            force_over=True,
        )
        x, y = to_equal_area.transform(longitudes, latitudes, errcheck=True)
    except ProjError as error:
        raise ValueError(
            "Raster coordinates cannot be transformed for categorical ground-area estimates"
        ) from error
    require_active_raster_read(cancellation_requested)
    # Relative vertex vectors avoid subtracting large absolute-coordinate products.
    ax, ay = x[:-1, :-1], y[:-1, :-1]
    bx, by = x[:-1, 1:] - ax, y[:-1, 1:] - ay
    cx, cy = x[1:, 1:] - ax, y[1:, 1:] - ay
    dx, dy = x[1:, :-1] - ax, y[1:, :-1] - ay
    subcell_areas_hectares = numpy.abs(bx * cy - by * cx + cx * dy - cy * dx) / 20_000
    if not numpy.all(numpy.isfinite(subcell_areas_hectares)):
        raise ValueError("Categorical ground-area weights must be finite")
    if projected_geometries is not None:
        subcells_inside_selection = pixels_inside_area(
            projected_geometries,
            out_shape=(fine_height, fine_width),
            transform=sample_transform,
            all_touched=False,
        )
        subcell_areas_hectares = numpy.where(
            subcells_inside_selection, subcell_areas_hectares, 0
        )
    sample_areas_hectares = subcell_areas_hectares.reshape(
        height, subdivisions, width, subdivisions
    ).sum(axis=(1, 3))
    if not numpy.any(sample_areas_hectares > 0):
        raise ValueError(
            "No selected ground area was represented by the categorical sample. Use a smaller sampling area."
        )
    require_active_raster_read(cancellation_requested)
    return sample_areas_hectares


def read_raster_categorical_statistics(
    source: RasterData,
    sampling_area: RasterSamplingArea,
    cancellation_requested: RasterReadCancellationCheck | None = None,
    *,
    category_values: tuple[int, ...],
) -> RasterStatistics:
    """Read native numeric categories and estimate selected ground coverage.

    Args:
        source: Authorized raster file or selected temporal observation.
        sampling_area: Validated whole, bounds or original Catalog selection.
        cancellation_requested: Optional last-waiter cancellation predicate.
        category_values: Boundary-validated, sorted distinct integer codes.

    Returns:
        Numeric statistics plus estimated area totals for supplied codes,
        Unmapped and NoData. Areas are explicitly approximate.

    Raises:
        NoRasterBoundsOverlapError: If the selected envelope misses the raster.
        NoValidRasterSamplesError: If no finite selected samples remain.
        RasterReadCancelled: If the request loses all active waiters.
        OSError: If the signed source cannot be opened.
        rasterio.errors.RasterioError: If a bounded native read fails.
        TypeError: If the sampling area is outside the strict union.
        ValueError: If source structure, area transformation or limits fail.
    """
    require_active_raster_read(cancellation_requested)
    selected_area = None
    with open_raster_data(source) as dataset:
        require_signed_raster_dependencies(dataset, source)
        require_raster_analysis_georeferencing(dataset)
        if isinstance(sampling_area, SelectedBoundsSamplingArea):
            selected_area = selected_raster_area_for_wgs84_bounds(
                dataset, sampling_area.bounds
            )
        elif isinstance(sampling_area, SamplingBoxArea):
            selected_area = selected_raster_area_for_sampling_box(
                dataset,
                sampling_area.box,
                RASTER_STATISTICS_MAX_TRANSFORMED_COORDINATES,
            )
        elif isinstance(sampling_area, CatalogSelectionSamplingArea):
            selected_area = selected_raster_area_for_catalog_selection(
                dataset, sampling_area, cancellation_requested
            )
        elif not isinstance(sampling_area, WholeRasterSamplingArea):
            raise TypeError("Unsupported raster sampling area")
        source_window = (
            selected_area.source_window
            if selected_area
            else Window(0, 0, dataset.width, dataset.height)
        )
        try:
            exact_plan = (
                plan_exact_source_window(dataset, source_window)
                if max(source_window.width, source_window.height)
                <= SAMPLE_GRID_MAX_DIMENSION
                else None
            )
            if exact_plan is not None:
                sample = read_exact_source_window(
                    dataset, exact_plan, cancellation_requested
                )
                sampling_method = "exactSourceWindow"
            else:
                plan = plan_source_window_sample_grid(dataset, source_window)
                sample = read_planned_sample_grid(dataset, plan, cancellation_requested)
                sampling_method = "sampleGrid"
            sample_areas_hectares = estimate_sample_cell_areas_hectares(
                dataset,
                source_window,
                sample.shape,
                selected_area.projected_geometries if selected_area else None,
                cancellation_requested,
            )
        finally:
            if selected_area and isinstance(
                selected_area.projected_geometries, PolygonRasterizer
            ):
                selected_area.projected_geometries.close()
    values = numpy.asarray(numpy.ma.getdata(sample), dtype=numpy.float64)
    valid_sample_mask = ~numpy.ma.getmaskarray(sample) & numpy.isfinite(values)
    selected_valid_sample_mask = valid_sample_mask & (sample_areas_hectares > 0)
    sample = numpy.ma.array(values, mask=~selected_valid_sample_mask)
    statistics = summarize_raster_sample(
        sample, source_window, sampling_area, sampling_method
    )
    valid_area_hectares = float(sample_areas_hectares[selected_valid_sample_mask].sum())
    category_areas_hectares = [
        float(
            sample_areas_hectares[selected_valid_sample_mask & (values == code)].sum()
        )
        for code in category_values
    ]
    unmapped_area_hectares = float(
        sample_areas_hectares[
            selected_valid_sample_mask & ~numpy.isin(values, category_values)
        ].sum()
    )
    distribution = RasterCategoricalDistribution(
        categoryValues=category_values,
        areasHectares=category_areas_hectares,
        unmappedAreaHectares=unmapped_area_hectares,
        validAreaHectares=valid_area_hectares,
        nodataAreaHectares=float(sample_areas_hectares[~valid_sample_mask].sum()),
    )
    require_active_raster_read(cancellation_requested)
    return statistics.model_copy(update={"categorical_distribution": distribution})
