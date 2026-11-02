"""Plan shared native windows for temporal maps and area time series."""

from collections.abc import Iterator
import math
from typing import Literal

from affine import Affine
from pydantic import BaseModel, ConfigDict
from rasterio.windows import Window, transform as window_transform

from eolab_app.bounded_vector import PolygonRasterizer
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    GroundAreaPlan,
    NamedCalculation,
    PixelPoint,
    RasterAggregateLimits,
)
from eolab_app.processing.raster_aggregate import (
    get_raster_window_and_mask_source,
    pixel_sample_window,
    prepare_raster_area_tools,
)
from eolab_app.processing.raster_expression import FUNCTIONS, compile_expression, walk
from eolab_app.raster.temporal import TemporalObservation, TemporalRasterDataset


class TemporalReadGrid(BaseModel):
    """Describe selected native cells and their shared temporal read windows.

    columnRotation is the integral source-column shift applied before selecting
    the crop; every observation uses the same shift. window is the crop in that
    shifted source grid. transform is the crop's affine transform. dtype is the
    calculation's floating-point type, not the source TIFF's storage type.
    tileHeight and tileWidth are native read-block dimensions, and tileCount is
    the number of spatial tiles intersecting the crop, independently of time.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    crs: str
    transform: tuple[float, float, float, float, float, float]
    window: tuple[int, int, int, int]
    width: int
    height: int
    dtype: Literal["float64"] = "float64"
    columnRotation: int
    tileHeight: int
    tileWidth: int
    tileCount: int


def temporal_grid_windows(grid: TemporalReadGrid) -> Iterator[Window]:
    """Yield native spatial blocks clipped to the selected crop.

    Args:
        grid: Native read dimensions and integral crop window.

    Yields:
        Integral source windows in increasing row and column order.
    """
    crop = Window(*grid.window)
    row_stop = math.ceil((crop.row_off + crop.height) / grid.tileHeight)
    column_stop = math.ceil((crop.col_off + crop.width) / grid.tileWidth)
    for row in range(int(crop.row_off) // grid.tileHeight, row_stop):
        for column in range(int(crop.col_off) // grid.tileWidth, column_stop):
            yield Window(
                column * grid.tileWidth,
                row * grid.tileHeight,
                grid.tileWidth,
                grid.tileHeight,
            ).intersection(crop)


def plan_temporal_grid(
    observation: TemporalObservation,
    area: AggregateArea,
    limits: RasterAggregateLimits,
) -> TemporalReadGrid:
    """Select a common crop and native tiles without reading observation values.

    Args:
        observation: One authorized observation representing the admitted common grid.
        area: Validated bounds, polygons, vector selection or whole-grid choice.
        limits: Existing Processing lifecycle and geometry settings.

    Returns:
        Native grid, including the longitude view reused by every observation.

    Raises:
        ProcessingError: If the area cannot be projected or does not overlap.
        OSError: If source metadata cannot be read.
    """
    with TemporalRasterDataset(observation) as dataset:
        window, polygons = get_raster_window_and_mask_source(dataset, area, limits)
        try:
            return describe_temporal_grid(dataset, window, observation.transform)
        finally:
            if isinstance(polygons, PolygonRasterizer):
                polygons.close()


def plan_temporal_calculation_grid(
    observation: TemporalObservation,
    area: AggregateArea,
    limits: RasterAggregateLimits,
    calculations: tuple[NamedCalculation, ...],
    pixel_point: PixelPoint | None,
) -> tuple[TemporalReadGrid, GroundAreaPlan | None]:
    """Plan the shared native cells needed by temporal scalar formulas.

    Point-only formulas select one cell without preparing the area. Other
    formulas use the ordinary selected-area tools, including the fractional
    hectare window when required. Planning reads no observation values.

    Args:
        observation: One authorized observation representing the admitted common grid.
        area: Validated selected area, ignored by point-only formulas.
        limits: Existing Processing lifecycle and geometry settings.
        calculations: Validated named formulas using the raster alias a.
        pixel_point: WGS84 point supplied when a formula uses pixelValue.

    Returns:
        Common native grid and the hectare strategy, or None when not used.

    Raises:
        ProcessingError: If the area cannot be projected or does not overlap.
        OSError: If source metadata cannot be read.
        rasterio.errors.RasterioError: If native metadata cannot be opened.
    """
    roots = [compile_expression(item.expression, "a") for item in calculations]
    functions = {
        node.op for root in roots for node in walk(root) if node.op in FUNCTIONS
    }
    with TemporalRasterDataset(observation) as dataset:
        if functions == {"pixelValue"}:
            return (
                describe_temporal_grid(
                    dataset,
                    pixel_sample_window(dataset, pixel_point),
                    observation.transform,
                ),
                None,
            )
        tools = prepare_raster_area_tools(
            dataset, area, limits, measure_hectares="areaha" in functions
        )
        try:
            return describe_temporal_grid(
                dataset, tools.raster_window, observation.transform
            ), (
                tools.pixel_area_calculator.metadata
                if tools.pixel_area_calculator is not None
                else None
            )
        finally:
            if isinstance(tools.selected_polygons, PolygonRasterizer):
                tools.selected_polygons.close()


def describe_temporal_grid(
    dataset: TemporalRasterDataset, window: Window, source_transform: Affine
) -> TemporalReadGrid:
    """Record a selected native window and its established longitude view.

    Args:
        dataset: Open observation after selection establishes its column view.
        window: Integral selected cell rectangle, possibly empty for an outside point.
        source_transform: Admitted affine before any integral column rotation.

    Returns:
        Serializable grid shared by every observation in this calculation.
    """
    tile_height, tile_width = dataset.block_shapes[0]
    rotation, _ = ~source_transform * (
        dataset.transform.c,
        dataset.transform.f,
    )
    rows = (
        math.ceil((window.row_off + window.height) / tile_height)
        - int(window.row_off) // tile_height
    )
    columns = (
        math.ceil((window.col_off + window.width) / tile_width)
        - int(window.col_off) // tile_width
    )
    return TemporalReadGrid(
        crs=dataset.crs.to_wkt(),
        transform=tuple(window_transform(window, dataset.transform))[:6],
        window=tuple(
            int(value)
            for value in (
                window.col_off,
                window.row_off,
                window.width,
                window.height,
            )
        ),
        width=int(window.width),
        height=int(window.height),
        columnRotation=round(rotation),
        tileHeight=tile_height,
        tileWidth=tile_width,
        tileCount=rows * columns,
    )
