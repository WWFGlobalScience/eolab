"""Plan native single-raster calculations and stream scalar results to artifacts."""

from eolab_app.processing.statistics_csv import statistics_csv
from eolab_app.processing.raster_input import raster_source_filename_prefix

from eolab_app.bounded_vector import PolygonRasterizer
from contextlib import ExitStack
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import time
from typing import Any, Literal

import numpy as np
import rasterio
from numpy.typing import NDArray
from rasterio.windows import Window, transform as window_transform
from rasterio.warp import transform as project_coordinates

from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateArtifact,
    AggregateGrid,
    AggregateExecutionPlan,
    AggregateSpec,
    GroundAreaPlan,
    NamedCalculation,
    PixelPoint,
    RasterAggregateLimits,
)
from eolab_app.processing.aggregate_windows import (
    plan_raster_read_windows,
    iter_raster_read_windows,
)
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.ground_area import PixelAreaCalculator
from eolab_app.processing.raster_expression import (
    FUNCTIONS,
    Calculation,
    compile_expression,
    walk,
)
from eolab_app.processing.raster_input import (
    count_native_raster_blocks,
    validate_supported_raster,
    select_area,
)
from eolab_app.raster.source_contract import (
    RASTER_VALIDITY_POLICY,
    read_native_raster_block,
    read_native_raster_window,
)
from eolab_app.raster.models import RasterAreaMask
from eolab_app.raster.reader import RasterData, RasterDataset, open_raster_data
from eolab_app.processing.raster_mask import temporary_polygon_mask

# Evaluate at most 65,536 pixels per expression tile, even when the source's
# native blocks are larger. Keep admission and execution on this same tile size.
TILE_SIDE = 256
# Area intersections retain bounded GEOS objects alongside the numerical tile.
AREA_TILE_SIDE = 64
GDAL_CACHE_BYTES = 64 * 1024**2
GDAL_THREADS = 2
# Publish progress at most twice per second to bound filesystem update overhead.
PROGRESS_INTERVAL_SECONDS = 0.5


def pixel_sample_window(dataset: RasterDataset, point: PixelPoint) -> Window:
    """Locate the native band-one cell containing an exact WGS84 position.

    Args:
        dataset: Open source with validated georeferencing.
        point: Validated longitude and latitude of the selected map position.

    Returns:
        One source cell, or an empty window when the position is outside the
        raster or cannot be represented in its coordinate reference system.
        The containing-cell rule matches direct map pixel inspection.

    Raises:
        rasterio.errors.RasterioError: If coordinate transformation fails.
    """
    xs, ys = project_coordinates(
        "EPSG:4326", dataset.crs, [point.longitude], [point.latitude]
    )
    if all(math.isfinite(value) for value in (xs[0], ys[0])):
        row, column = dataset.index(xs[0], ys[0])
        if 0 <= row < dataset.height and 0 <= column < dataset.width:
            return Window(column, row, 1, 1)
    return Window(0, 0, 0, 0)


def read_raster_pixel_value(dataset: RasterDataset, window: Window) -> float | None:
    """Read one selected cell, returning None for NoData or an outside point.

    Args:
        dataset: Open native source containing the selected cell.
        window: One-cell or empty window returned by pixel_sample_window.

    Returns:
        The stored valid value, or None when the point has no valid source cell.

    Raises:
        rasterio.errors.RasterioError: If the source cell cannot be read.
    """
    if not window.width:
        return None
    sample = read_native_raster_window(dataset, window)
    return float(sample[0, 0]) if sample.count() else None


def get_raster_window_and_mask_source(
    dataset: RasterDataset,
    area: AggregateArea,
    limits: RasterAggregateLimits,
    *,
    max_retained_polygon_bytes: int | None = 0,
) -> tuple[Window, tuple[dict[str, object], ...] | RasterAreaMask]:
    """Get the raster pixel window and the source for per-tile area masks.

    This does not read raster pixel values or create the per-tile masks.

    Args:
        dataset: Open raster with validated georeferencing.
        area: Sampling box, filtered catalog features, owned polygon
            geometry, or the whole raster.
        limits: Shared lifecycle and ground-area accuracy settings.
        max_retained_polygon_bytes: Optional allowance to retain catalog polygons
            for this calculation; zero uses the streaming reader.

    Returns:
        A window in raster rows and columns, and projected polygons or a
        reader that creates polygon masks for each tile. An empty tuple
        indicates that no additional polygon mask is needed.

    Raises:
        ProcessingError: If the area does not overlap the raster, cannot be
            projected.
    """
    if area.kind == "wholeRaster":
        return Window(0, 0, dataset.width, dataset.height), ()
    selected = select_area(
        dataset,
        area.kind,
        area.bounds,
        area.geometries,
        None,
        area.resolved,
        max_retained_polygon_bytes=max_retained_polygon_bytes,
        sampling_box=area.samplingBox,
    )
    return selected.source_window, selected.projected_geometries


@dataclass(frozen=True)
class RasterAreaTools:
    """Hold the final raster window and tools for processing the selected area.

    Use these tools only while their source raster remains open. They are
    local to one calculation and are not serialized into the saved plan.

    Attributes:
        raster_window: Final rectangle of source pixels to process.
        selected_polygons: Polygon coordinates or a reader for the selected features.
            An empty tuple means no additional polygon mask is needed.
        pixel_area_calculator: Per-pixel hectare calculator, or None when
            the plan contains no area-measurement formulas.
    """

    raster_window: Window
    selected_polygons: tuple[dict[str, object], ...] | RasterAreaMask
    pixel_area_calculator: PixelAreaCalculator | None


def prepare_raster_area_tools(
    dataset: RasterDataset,
    area: AggregateArea,
    limits: RasterAggregateLimits,
    *,
    measure_hectares: bool = False,
) -> RasterAreaTools:
    """Prepare the final window, selected polygons and optional hectare calculator.

    For formulas requiring area measurement, use the hectare calculator's window,
    matching its cached pixel coordinates. Other formulas use the ordinary
    selection window. Both retain their existing projection and boundary rules.

    Args:
        dataset: Open, validated raster; it must remain open while tools are used.
        area: Accepted box, polygons, vector selection or whole-raster area.
        limits: Limits used by the existing geometry readers and area calculator.
        measure_hectares: Whether the formulas need fractional cell areas.

    Returns:
        Tools with one final pixel window.
        No raster pixel values are read during setup. The caller must close any
        returned PolygonRasterizer when the calculation ends.

    Raises:
        ProcessingError: If the area cannot be read or projected, does not
            overlap the raster.
    """
    polygon_budget = None if area.kind == "catalogSelection" else 0
    selection_window, selected_polygons = get_raster_window_and_mask_source(
        dataset,
        area,
        limits,
        max_retained_polygon_bytes=polygon_budget,
    )
    try:
        pixel_area_calculator = None
        if measure_hectares:
            pixel_area_calculator = PixelAreaCalculator(dataset, area, limits)
            raster_window = pixel_area_calculator.window
        else:
            raster_window = selection_window
    except BaseException:
        if isinstance(selected_polygons, PolygonRasterizer):
            selected_polygons.close()
        raise
    return RasterAreaTools(
        raster_window=raster_window,
        selected_polygons=selected_polygons,
        pixel_area_calculator=pixel_area_calculator,
    )


def accumulate_raster_tile(
    calculations: list[Calculation],
    values: np.ma.MaskedArray,
    selection_valid: NDArray[np.bool_] | None,
    hectares: NDArray[np.float64] | None,
) -> None:
    """Accumulate formulas using numeric cell centres and fractional hectare areas.

    Hectare formulas include each valid cell's intersecting fraction even when
    its centre is outside the selected area.

    Args:
        calculations: Scalar accumulators for this source observation.
        values: Native values with source NoData and nonfinite values masked.
        selection_valid: Cell-centre membership in the selected area, or None
            when every cell in the tile belongs to it.
        hectares: Each cell's selected ground area, or None when unused.
    """
    data = values.data.astype(np.float64)
    valid = ~np.ma.getmaskarray(values)
    area_valid = valid & (hectares > 0) if hectares is not None else None
    if selection_valid is not None:
        valid &= selection_valid
    for calculation in calculations:
        calculation.process_tile(data, valid, hectares, area_valid)


def plan_statistics_grid(
    dataset: Any,
    window: Window,
    node_count: int,
    limits: RasterAggregateLimits,
    ground_area: GroundAreaPlan | None = None,
    target_chunk_pixels: int | None = None,
    pixel_window: Window | None = None,
) -> AggregateGrid:
    """Describe the statistics grid and choose windows for tiled execution.

    Args:
        dataset: Validated one-band source.
        window: Integral source window.
        node_count: Total bounded expression-tree nodes.
        limits: Shared lifecycle and ground-area accuracy settings.
        ground_area: Optional ellipsoidal measurement metadata and geometry work.
        target_chunk_pixels: Opt-in total-pixel budget for combined windows/tiles.
        pixel_window: Optional additional single-cell read for a mixed point
            and area calculation, conservatively charged as another native block.

    Returns:
        Source grid metadata and read-window sizes.

    Raises:
        ProcessingError: If grid metadata cannot describe valid execution windows.
    """
    blocks = (
        count_native_raster_blocks(dataset, window)
        if window.width and window.height
        else 0
    )
    if pixel_window is not None and pixel_window.width:
        blocks += count_native_raster_blocks(dataset, pixel_window)
    bh, bw = dataset.block_shapes[0]
    tile_side = (
        AREA_TILE_SIDE
        if ground_area and ground_area.strategy != "rectilinear"
        else TILE_SIDE
    )
    execution = (
        plan_raster_read_windows(
            window,
            (bh, bw),
            dataset.width,
            dataset.height,
            target_chunk_pixels,
            tile_side,
        )
        if window.width and window.height
        else AggregateExecutionPlan(
            targetChunkPixels=target_chunk_pixels,
            readWidth=1,
            readHeight=1,
            evaluationWidth=1,
            evaluationHeight=1,
            readWindows=0,
        )
    )
    if pixel_window is not None and pixel_window.width:
        execution = execution.model_copy(
            update={"readWindows": execution.readWindows + 1}
        )
    return AggregateGrid(
        crs=dataset.crs.to_wkt(),
        transform=tuple(window_transform(window, dataset.transform))[:6],
        window=(
            int(window.col_off),
            int(window.row_off),
            int(window.width),
            int(window.height),
        ),
        width=int(window.width),
        height=int(window.height),
        dtype=dataset.dtypes[0],
        nodata=None if dataset.nodata is None else str(dataset.nodata),
        nativeBlocks=blocks,
        scale=str(dataset.scales[0]),
        offset=str(dataset.offsets[0]),
        storedUnit=dataset.units[0],
        groundArea=ground_area,
        execution=execution,
    )


def plan_aggregate(
    raster_data: RasterData,
    area: AggregateArea,
    calculations: tuple[NamedCalculation, ...],
    alias: str,
    limits: RasterAggregateLimits,
    target_chunk_pixels: int | None = None,
    pixel_point: PixelPoint | None = None,
) -> AggregateGrid:
    """Plan the native grid and calculation batches for the requested formulas.

    For north-up WGS84, Web Mercator and equal-area cylindrical rasters,
    use the filtered vector's server-measured bounding rectangle.
    These projections have independent, monotonic longitude/latitude axes, so
    the rectangle contains the selected polygons. Read and project the exact
    polygons later, in the cancellable calculation job. Other grids retain
    exact geometry planning because their projected envelopes can curve.

    Args:
        raster_data: Confined raster path or admitted temporal observation.
        area: Selected box, filtered vector, owned polygons or whole raster.
        calculations: Labeled formulas to evaluate, such as sum(a).
        alias: Variable representing the raster in those formulas, such as a.
        limits: Shared lifecycle and ground-area accuracy settings.
        target_chunk_pixels: Optional maximum pixels per read/calculation batch.
        pixel_point: Exact selected map position required by pixelValue.
            Point-only formulas ignore the area and admit only one source cell.

    Returns:
        Raster grid and block counts from metadata, without reading pixel values
        or estimating memory consumption. The saved calculation keeps the exact area descriptor.

    Raises:
        ProcessingError: If the area misses the raster or cannot be projected.
        rasterio.errors.RasterioIOError: If the raster cannot be opened.
    """
    roots = [compile_expression(item.expression, alias) for item in calculations]
    nodes = sum(sum(1 for _ in walk(root)) for root in roots)
    functions = {
        node.op for root in roots for node in walk(root) if node.op in FUNCTIONS
    }
    with rasterio.Env(
        GDAL_CACHEMAX=GDAL_CACHE_BYTES, GDAL_NUM_THREADS=str(GDAL_THREADS)
    ):
        with open_raster_data(raster_data) as dataset:
            validate_supported_raster(dataset, raster_data)
            pixel_window = (
                pixel_sample_window(dataset, pixel_point)
                if "pixelValue" in functions
                else None
            )
            planning_area = area
            if (
                area.kind == "catalogSelection"
                and dataset.crs.to_epsg() in {4326, 3857, 6933}
                and dataset.transform.b == dataset.transform.d == 0
            ):
                planning_area = AggregateArea(kind="bounds", bounds=area.bounds)
            pixel_only = functions == {"pixelValue"}
            raster_window = pixel_window
            if not pixel_only:
                raster_window, _ = get_raster_window_and_mask_source(
                    dataset, planning_area, limits
                )
            needs_ground_area = any(
                node.op == "areaha" for root in roots for node in walk(root)
            )
            pixel_area_calculator = None
            if needs_ground_area:
                pixel_area_calculator = PixelAreaCalculator(
                    dataset, planning_area, limits, planning=True
                )
            if pixel_area_calculator is not None:
                raster_window = pixel_area_calculator.window
            result = plan_statistics_grid(
                dataset,
                raster_window,
                nodes,
                limits,
                pixel_area_calculator.metadata if pixel_area_calculator else None,
                target_chunk_pixels,
                pixel_window if not pixel_only else None,
            )
            if pixel_only:
                result = result.model_copy(
                    update={
                        "execution": AggregateExecutionPlan(
                            targetChunkPixels=target_chunk_pixels,
                            readWidth=1,
                            readHeight=1,
                            evaluationWidth=1,
                            evaluationHeight=1,
                            readWindows=int(bool(pixel_window.width)),
                        )
                    }
                )
    return result


def calculate_raster_statistics_for_area(
    raster_data: RasterData,
    calculation_plan: AggregateSpec,
    directory: Path,
    limits: RasterAggregateLimits,
) -> AggregateArtifact:
    """Calculate summary statistics for a selected area of a raster.

    Read the raster in saved batches, exclude nodata pixels and pixels outside the
    selected area, and evaluate the expressions in calculation_plan. Write the
    results to CSV and record the inputs and calculation details in a
    provenance file.

    Args:
        raster_data: Confined raster path or admitted temporal observation.
        calculation_plan: Expressions to evaluate, area to summarize,
            catalog source identity, and grid produced by plan_aggregate.
        directory: Existing directory for result files and progress updates.
        limits: Shared lifecycle and ground-area accuracy settings.

    Returns:
        An AggregateArtifact containing the calculated values and the CSV
        filename, size, and checksum.

    Raises:
        ProcessingError: If the raster or area is unsupported, or the
            calculation inputs are invalid.
    """
    completed_blocks = 0
    alias = next(iter(calculation_plan.sources))
    roots = [
        compile_expression(item.expression, alias)
        for item in calculation_plan.calculations
    ]
    functions = {
        node.op for root in roots for node in walk(root) if node.op in FUNCTIONS
    }
    pixel_only = functions == {"pixelValue"}
    with rasterio.Env(
        GDAL_CACHEMAX=GDAL_CACHE_BYTES, GDAL_NUM_THREADS=str(GDAL_THREADS)
    ):
        with open_raster_data(raster_data) as dataset, ExitStack() as resources:
            validate_supported_raster(dataset, raster_data)
            pixel_window = (
                pixel_sample_window(dataset, calculation_plan.pixelPoint)
                if "pixelValue" in functions
                else None
            )
            pixel_value = (
                read_raster_pixel_value(dataset, pixel_window)
                if pixel_window is not None
                else None
            )
            if pixel_window is not None:
                completed_blocks = int(bool(pixel_window.width))
            calculations = [Calculation(root, pixel_value) for root in roots]
            write_progress(directory, "preparing_selected_polygons", 0, 0)
            raster_area_tools = (
                RasterAreaTools(
                    raster_window=pixel_window,
                    selected_polygons=(),
                    pixel_area_calculator=None,
                )
                if pixel_only
                else prepare_raster_area_tools(
                    dataset,
                    calculation_plan.area,
                    limits,
                    measure_hectares=calculation_plan.grid.groundArea is not None,
                )
            )
            polygons = raster_area_tools.selected_polygons
            if isinstance(polygons, PolygonRasterizer):
                resources.callback(polygons.close)
            write_progress(
                directory,
                "preparing_polygon_mask",
                0,
                calculation_plan.grid.nativeBlocks,
            )
            polygon_mask = resources.enter_context(
                temporary_polygon_mask(
                    dataset,
                    raster_area_tools.raster_window,
                    polygons,
                    directory,
                    limits,
                )
            )
            if isinstance(polygons, PolygonRasterizer):
                polygons.close()
            pixel_area_calculator = raster_area_tools.pixel_area_calculator
            last_progress = 0.0
            raster_batch_plan = calculation_plan.grid.execution
            iter_windows = (
                ()
                if pixel_only
                else iter_raster_read_windows(
                    raster_area_tools.raster_window,
                    dataset.block_shapes[0],
                    dataset.width,
                    dataset.height,
                    raster_batch_plan,
                )
            )
            reader = (
                read_native_raster_block
                if raster_batch_plan.targetChunkPixels is None
                else read_native_raster_window
            )
            for block, native_blocks in iter_windows:
                native = reader(dataset, block)
                intersection = block.intersection(raster_area_tools.raster_window)
                if polygon_mask is None:
                    selection_valid = None
                else:
                    mask_window = Window(
                        intersection.col_off - raster_area_tools.raster_window.col_off,
                        intersection.row_off - raster_area_tools.raster_window.row_off,
                        intersection.width,
                        intersection.height,
                    )
                    selection_valid = polygon_mask.read(1, window=mask_window).view(
                        np.bool_
                    )
                for y in range(
                    int(intersection.row_off),
                    int(intersection.row_off + intersection.height),
                    raster_batch_plan.evaluationHeight,
                ):
                    for x in range(
                        int(intersection.col_off),
                        int(intersection.col_off + intersection.width),
                        raster_batch_plan.evaluationWidth,
                    ):
                        tile = Window(
                            x,
                            y,
                            min(
                                raster_batch_plan.evaluationWidth,
                                intersection.col_off + intersection.width - x,
                            ),
                            min(
                                raster_batch_plan.evaluationHeight,
                                intersection.row_off + intersection.height - y,
                            ),
                        )
                        local = Window(
                            x - block.col_off,
                            y - block.row_off,
                            tile.width,
                            tile.height,
                        )
                        values = native[local.toslices()]
                        hectares = (
                            pixel_area_calculator.calculate_hectares(tile)
                            if pixel_area_calculator is not None
                            else None
                        )
                        tile_selection = None
                        if selection_valid is not None:
                            mask_local = Window(
                                x - intersection.col_off,
                                y - intersection.row_off,
                                tile.width,
                                tile.height,
                            )
                            tile_selection = selection_valid[mask_local.toslices()]
                        accumulate_raster_tile(
                            calculations, values, tile_selection, hectares
                        )
                        # Release the tile before allocating the next one; no old
                        # source view may retain the previous combined read.
                        del values, hectares, tile_selection
                del native, selection_valid
                completed_blocks += native_blocks
                if time.monotonic() - last_progress > PROGRESS_INTERVAL_SECONDS:
                    write_progress(
                        directory,
                        "calculating",
                        completed_blocks,
                        calculation_plan.grid.nativeBlocks,
                    )
                    last_progress = time.monotonic()
    rows = [
        {"label": item.label, "expression": item.expression, **calculation.result()}
        for item, calculation in zip(
            calculation_plan.calculations, calculations, strict=True
        )
    ]
    write_progress(
        directory,
        "writing_results",
        completed_blocks,
        calculation_plan.grid.nativeBlocks,
    )
    return write_statistics_result(calculation_plan, rows, directory)


def write_statistics_result(
    calculation_plan: AggregateSpec,
    rows: list[dict[str, object]],
    directory: Path,
    *,
    cache_hit: bool = False,
) -> AggregateArtifact:
    """Write this calculation's CSV and provenance, including reused values.

    Args:
        calculation_plan: Raster, area and formulas recorded for this request.
        rows: Completed result rows with the current labels and formula text.
        directory: Existing private job directory in which to write both files.
        cache_hit: Whether all values came from the shared result cache.

    Returns:
        CSV size, checksum, inline values and this request's cache status.

    Raises:
        OSError: If result files cannot be written.
        ValueError: If result metadata cannot be serialized as finite JSON.
    """
    result = directory / "result.csv"
    result.write_bytes(statistics_csv(rows))
    with result.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    source = next(iter(calculation_plan.sources.values()))
    pixel_inclusion = (
        {"pixelValue": "cell_containing_selected_point"}
        if any(
            item["function"] == "pixelValue"
            for row in rows
            for item in row["aggregates"]
        )
        else {}
    )
    artifact = AggregateArtifact(
        size=result.stat().st_size,
        sha256=digest,
        filename=f"{raster_source_filename_prefix(source)}-calculations.csv",
        rows=rows,
        cache_hit=cache_hit,
    )
    provenance = {
        **calculation_plan.model_dump(mode="json", by_alias=True),
        "resolution": "native",
        "valueDomain": "stored",
        "sourceValidity": RASTER_VALIDITY_POLICY,
        "inclusion": (
            "per_function"
            if calculation_plan.grid.groundArea or pixel_inclusion
            else "cell_center"
        ),
        "functionInclusion": (
            {
                "numeric": "cell_center",
                "areaha": "fractional_cell_intersection",
                **pixel_inclusion,
            }
            if calculation_plan.grid.groundArea
            else {"numeric": "cell_center", **pixel_inclusion}
        ),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        **asdict(artifact),
    }
    (directory / "provenance.json").write_text(
        json.dumps(provenance, allow_nan=False), encoding="utf-8"
    )
    return artifact


def aggregate_process_target(
    queue: ProcessResultWriter,
    operation: Literal["plan", "calculate"],
    arguments: tuple[Any, ...],
) -> None:
    """Run only the reviewed calculation kernels with sanitized IPC failures.

    Args:
        queue: Bounded one-result process channel.
        operation: Explicit plan or calculate dispatch.
        arguments: Validated picklable inputs.
    """
    try:
        if operation == "plan":
            value = plan_aggregate(*arguments)
        elif operation == "calculate":
            value = calculate_raster_statistics_for_area(*arguments)
        else:
            raise ValueError("Unsupported calculation operation")
        queue.put(("ok", value))
    except ProcessingError as error:
        queue.put(("error", (error.code, error.detail, error.status)))
    except Exception:
        queue.put(
            (
                "error",
                (
                    "processing_failed",
                    "The raster calculation could not be completed safely.",
                    500,
                ),
            )
        )
