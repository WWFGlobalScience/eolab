"""Plan native single-raster calculations and stream scalar results to artifacts."""

from eolab_app.bounded_vector import PolygonRasterizer
from contextlib import ExitStack
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import csv
import hashlib
import json
from pathlib import Path
import time
from typing import Any, Literal

import numpy as np
import rasterio
from numpy.typing import NDArray
from rasterio.windows import Window, transform as window_transform

from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateArtifact,
    AggregateGrid,
    AggregateSpec,
    AggregatePerformance,
    AggregateKernelStages,
    GroundAreaPlan,
    NamedCalculation,
    RasterAggregateLimits,
)
from eolab_app.processing.aggregate_windows import (
    execution_plan,
    iter_raster_read_windows,
)
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.ground_area import PixelAreaCalculator
from eolab_app.processing.raster_expression import Calculation, compile_expression, walk
from eolab_app.processing.raster_input import (
    native_work,
    validate_supported_raster,
    select_area,
)
from eolab_app.raster.source_contract import (
    read_native_raster_block,
    read_native_raster_window,
)
from eolab_app.raster.models import RasterAreaMask
from eolab_app.processing.raster_mask import temporary_polygon_mask

# Evaluate at most 65,536 pixels per expression tile, even when the source's
# native blocks are larger. Keep admission and execution on this same tile size.
TILE_SIDE = 256
# Area intersections retain bounded GEOS objects alongside the numerical tile.
AREA_TILE_SIDE = 64
AREA_GEOMETRY_MEMORY_BYTES = 128 * 1024**2
# Each native block retains its source values and one NumPy boolean validity mask.
NATIVE_MASK_BYTES_PER_PIXEL = np.dtype(np.bool_).itemsize
# GDAL's cache plus a separate 64 MiB allowance for geometry/native bookkeeping
# make up the fixed 128 MiB portion of the conservative working-set estimate.
GDAL_CACHE_BYTES = 64 * 1024**2
NATIVE_BOOKKEEPING_BYTES = 64 * 1024**2
GDAL_THREADS = 2
# Additional calculation-local polygons must fit alongside the planned raster
# buffers. This is a ceiling, not a cross-job cache or an unconditional allocation.
RETAINED_POLYGON_MEMORY_BYTES = 128 * 1024**2
# A cached expression node holds float64 values (8 bytes) and validity (1 byte).
# Round up to 16 bytes per pixel to allow evaluation temporaries. Eight additional
# tile-sized allocations cover input conversion, polygon selection/eligibility masks, selected
# values and reduction temporaries. These are admission allowances, not measured
# resident memory or a count of arrays every expression necessarily allocates.
EXPRESSION_BYTES_PER_PIXEL = 16
EXPRESSION_SCRATCH_ARRAYS = 8
# Fractional coverage's row integrals, winding, masks and broadcast temporaries.
# The fixed area allowance continues to cover cached axes, edges and GEOS setup.
AREA_MASK_BYTES_PER_PIXEL = 160
# Publish progress at most twice per second to bound filesystem update overhead.
PROGRESS_INTERVAL_SECONDS = 0.5


def get_raster_window_and_mask_source(
    dataset: rasterio.io.DatasetReader,
    area: AggregateArea,
    limits: RasterAggregateLimits,
    *,
    max_retained_polygon_bytes: int = 0,
) -> tuple[Window, tuple[dict[str, object], ...] | RasterAreaMask]:
    """Get the raster pixel window and the source for per-tile area masks.

    This does not read raster pixel values or create the per-tile masks.

    Args:
        dataset: Open raster with validated georeferencing.
        area: Sampling box, filtered catalog features, historical polygon
            geometry, or the whole raster.
        limits: Processing limits; max_coordinates bounds geometry work here.
        max_retained_polygon_bytes: Optional allowance to retain catalog polygons
            for this calculation; zero uses the streaming reader.

    Returns:
        A window in raster rows and columns, and projected polygons or a
        reader that creates polygon masks for each tile. An empty tuple
        indicates that no additional polygon mask is needed.

    Raises:
        ProcessingError: If the area does not overlap the raster, cannot be
            projected, or exceeds the geometry limits.
    """
    if area.kind == "wholeRaster":
        return Window(0, 0, dataset.width, dataset.height), ()
    selected = select_area(
        dataset,
        area.kind,
        area.bounds,
        area.geometries,
        limits.max_coordinates,
        area.resolved,
        max_retained_polygon_bytes=max_retained_polygon_bytes,
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
        selection_setup_seconds: Time spent preparing the window and selected polygons.
        retained_polygon_bytes: Conservative retained geometry size, additional
            to the saved plan's raster-buffer estimate.
        pixel_area_setup_seconds: Time spent preparing the hectare calculator
            and choosing the final window.
    """

    raster_window: Window
    selected_polygons: tuple[dict[str, object], ...] | RasterAreaMask
    pixel_area_calculator: PixelAreaCalculator | None
    selection_setup_seconds: float
    pixel_area_setup_seconds: float
    retained_polygon_bytes: int


def prepare_raster_area_tools(
    dataset: rasterio.io.DatasetReader,
    calculation_plan: AggregateSpec,
    limits: RasterAggregateLimits,
) -> RasterAreaTools:
    """Prepare the final window, selected polygons and optional hectare calculator.

    The saved plan records whether its formulas require area measurement.
    For those plans, use the hectare calculator's window, matching its cached
    pixel coordinates. Other plans use the ordinary selection window. This
    retains the existing projection and boundary rules of both tools.

    Args:
        dataset: Open, validated raster; it must remain open while tools are used.
        calculation_plan: Accepted calculation plan, including its selected area
            and the ground-area metadata produced by plan_aggregate.
        limits: Limits used by the existing geometry readers and area calculator.

    Returns:
        Tools with one final pixel window and the separate setup timings.
        No raster pixel values are read during setup. The caller must close any
        returned PolygonRasterizer when the calculation ends.

    Raises:
        ProcessingError: If the area cannot be read or projected, does not
            overlap the raster, or exceeds geometry-processing limits.
    """
    started = time.perf_counter()
    polygon_budget = 0
    if calculation_plan.area.kind == "catalogSelection":
        polygon_budget = min(
            RETAINED_POLYGON_MEMORY_BYTES,
            limits.max_memory_bytes - calculation_plan.grid.estimatedMemoryBytes,
        )
        if polygon_budget <= 0:
            raise ProcessingError(
                "polygon_memory_limit",
                "The planned raster buffers leave no memory for selected polygons. "
                "Use a smaller batch or simplify the calculation.",
                413,
            )
    selection_window, selected_polygons = get_raster_window_and_mask_source(
        dataset,
        calculation_plan.area,
        limits,
        max_retained_polygon_bytes=polygon_budget,
    )
    selection_ready = time.perf_counter()
    try:
        pixel_area_calculator = None
        if calculation_plan.grid.groundArea is not None:
            pixel_area_calculator = PixelAreaCalculator(
                dataset, calculation_plan.area, limits
            )
            raster_window = pixel_area_calculator.window
        else:
            raster_window = selection_window
    except BaseException:
        if isinstance(selected_polygons, PolygonRasterizer):
            selected_polygons.close()
        raise
    area_ready = time.perf_counter()
    return RasterAreaTools(
        raster_window=raster_window,
        selected_polygons=selected_polygons,
        pixel_area_calculator=pixel_area_calculator,
        selection_setup_seconds=selection_ready - started,
        pixel_area_setup_seconds=area_ready - selection_ready,
        retained_polygon_bytes=(
            selected_polygons.retained_bytes
            if isinstance(selected_polygons, PolygonRasterizer)
            else 0
        ),
    )


def grid(
    dataset: Any,
    window: Window,
    node_count: int,
    limits: RasterAggregateLimits,
    ground_area: GroundAreaPlan | None = None,
    target_chunk_pixels: int | None = None,
) -> AggregateGrid:
    """Admit native work and bounded expression memory for one plan.

    Args:
        dataset: Validated one-band source.
        window: Integral source window.
        node_count: Total bounded expression-tree nodes.
        limits: Work and memory ceilings.
        ground_area: Optional ellipsoidal measurement metadata and geometry work.
        target_chunk_pixels: Opt-in total-pixel budget for combined windows/tiles.

    Returns:
        Deterministic metadata and conservative memory estimate.
    """
    blocks, decoded = native_work(
        dataset, window, limits.max_native_blocks, limits.max_decoded_bytes
    )
    bh, bw = dataset.block_shapes[0]
    tile_side = (
        AREA_TILE_SIDE
        if ground_area and ground_area.strategy != "rectilinear"
        else TILE_SIDE
    )
    execution = execution_plan(
        window, (bh, bw), dataset.width, dataset.height, target_chunk_pixels, tile_side
    )
    read_pixels = execution.readWidth * execution.readHeight
    tile_pixels = execution.evaluationWidth * execution.evaluationHeight
    # Sum the retained native block, fixed native overhead, and tile-sized
    # expression/scratch budget. Counting all syntax nodes is conservative because
    # scalar nodes and successive reductions need not hold full tiles together.
    memory = (
        (read_pixels if target_chunk_pixels else bh * bw)
        * (np.dtype(dataset.dtypes[0]).itemsize + NATIVE_MASK_BYTES_PER_PIXEL + 1)
        + GDAL_CACHE_BYTES
        + NATIVE_BOOKKEEPING_BYTES
        + (tile_pixels if target_chunk_pixels else TILE_SIDE**2)
        * (node_count + EXPRESSION_SCRATCH_ARRAYS)
        * EXPRESSION_BYTES_PER_PIXEL
        + (AREA_GEOMETRY_MEMORY_BYTES if ground_area is not None else 0)
        + (
            tile_pixels * AREA_MASK_BYTES_PER_PIXEL
            if target_chunk_pixels
            and ground_area
            and ground_area.strategy == "rectilinear"
            else 0
        )
    )
    if memory > limits.max_memory_bytes:
        raise ProcessingError(
            "expression_memory_limit",
            f"The source, batch and expression need an estimated {memory / 1024**2:.1f} MiB of memory; the limit is {limits.max_memory_bytes / 1024**2:.0f} MiB. Choose a smaller batch, simplify the calculation or use a tiled source.",
            413,
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
        decodedBytes=decoded,
        estimatedMemoryBytes=memory,
        scale=str(dataset.scales[0]),
        offset=str(dataset.offsets[0]),
        storedUnit=dataset.units[0],
        groundArea=ground_area,
        execution=execution,
    )


def plan_aggregate(
    path: Path,
    area: AggregateArea,
    calculations: tuple[NamedCalculation, ...],
    alias: str,
    limits: RasterAggregateLimits,
    target_chunk_pixels: int | None = None,
) -> AggregateGrid:
    """Estimate raster reads and memory needed for the requested formulas.

    For north-up WGS84, Web Mercator and equal-area cylindrical rasters,
    estimate filtered-vector work from its server-measured bounding rectangle.
    These projections have independent, monotonic longitude/latitude axes, so
    the rectangle contains the selected polygons. Read and project the exact
    polygons later, in the cancellable calculation job. Other grids retain
    exact geometry planning because their projected envelopes can curve.

    Args:
        path: Path to the input raster.
        area: Selected box, filtered vector, historical polygons or whole raster.
        calculations: Labeled formulas to evaluate, such as sum(a).
        alias: Variable representing the raster in those formulas, such as a.
        limits: Maximum raster reads, memory, and geometry work.
        target_chunk_pixels: Optional maximum pixels per read/calculation batch.

    Returns:
        Raster grid and conservative read/memory estimates, without reading
        pixel values. The saved calculation keeps the exact area descriptor.

    Raises:
        ProcessingError: If the area misses the raster or exceeds work limits.
        rasterio.errors.RasterioIOError: If the raster cannot be opened.
    """
    roots = [compile_expression(item.expression, alias) for item in calculations]
    nodes = sum(sum(1 for _ in walk(root)) for root in roots)
    with rasterio.Env(
        GDAL_CACHEMAX=GDAL_CACHE_BYTES, GDAL_NUM_THREADS=str(GDAL_THREADS)
    ):
        with rasterio.open(path) as dataset:
            validate_supported_raster(dataset, path)
            planning_area = area
            if (
                area.kind == "catalogSelection"
                and dataset.crs.to_epsg() in {4326, 3857, 6933}
                and dataset.transform.b == dataset.transform.d == 0
            ):
                planning_area = AggregateArea(kind="bounds", bounds=area.bounds)
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
            result = grid(
                dataset,
                raster_window,
                nodes,
                limits,
                pixel_area_calculator.metadata if pixel_area_calculator else None,
                target_chunk_pixels,
            )
    return result


def csv_text(value: str) -> str:
    """Keep user-provided labels/expressions inert in spreadsheet applications.

    Args:
        value: Bounded user-provided text field.

    Returns:
        Text escaped against spreadsheet formula interpretation.
    """
    return (
        "'" + value
        if value.lstrip().startswith(("=", "+", "-", "@"))
        or value.startswith(("\t", "\r", "\n"))
        else value
    )


def calculate_raster_statistics_for_area(
    raster_path: Path,
    calculation_plan: AggregateSpec,
    directory: Path,
    limits: RasterAggregateLimits,
) -> AggregateArtifact:
    """Calculate summary statistics for a selected area of a raster.

    Read the raster in blocks, exclude nodata pixels and pixels outside the
    selected area, and evaluate the expressions in calculation_plan. Write the
    results to CSV and record the inputs and calculation details in a
    provenance file.

    Args:
        raster_path: Path to the input raster.
        calculation_plan: Expressions to evaluate, area to summarize,
            catalog source identity, and grid produced by plan_aggregate.
        directory: Existing directory for result files and progress updates.
        limits: Limits on raster reads, memory use, and geometry processing.

    Returns:
        An AggregateArtifact containing the calculated values, performance
        timings, and the CSV filename, size, and checksum.

    Raises:
        ProcessingError: If the raster or area is unsupported, or the
            calculation exceeds a processing limit.
    """
    started = time.perf_counter()
    read_seconds = calculation_seconds = 0.0
    mask_seconds = weights_seconds = reduction_seconds = 0.0
    mask_read_seconds = 0.0
    read_count = tile_count = completed_blocks = 0
    alias = next(iter(calculation_plan.sources))
    roots = [
        compile_expression(item.expression, alias)
        for item in calculation_plan.calculations
    ]
    calculations = [Calculation(root) for root in roots]
    with rasterio.Env(
        GDAL_CACHEMAX=GDAL_CACHE_BYTES, GDAL_NUM_THREADS=str(GDAL_THREADS)
    ):
        with rasterio.open(raster_path) as dataset, ExitStack() as resources:
            validate_supported_raster(dataset, raster_path)
            source_ready = time.perf_counter()
            write_progress(directory, "preparing_selected_polygons", 0, 0)
            raster_area_tools = prepare_raster_area_tools(
                dataset, calculation_plan, limits
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
            mask_started = time.perf_counter()
            polygon_mask = resources.enter_context(
                temporary_polygon_mask(
                    dataset,
                    raster_area_tools.raster_window,
                    polygons,
                    directory,
                    limits,
                )
            )
            mask_preparation_seconds = time.perf_counter() - mask_started
            mask_bytes = (
                0 if polygon_mask is None else Path(polygon_mask.name).stat().st_size
            )
            if isinstance(polygons, PolygonRasterizer):
                polygons.close()
            pixel_area_calculator = raster_area_tools.pixel_area_calculator
            last_progress = 0.0
            tile_side = (
                AREA_TILE_SIDE
                if pixel_area_calculator and not pixel_area_calculator.rectilinear
                else TILE_SIDE
            )
            if calculation_plan.grid.execution:
                raster_batch_plan = calculation_plan.grid.execution
            else:
                raster_batch_plan = execution_plan(
                    raster_area_tools.raster_window,
                    dataset.block_shapes[0],
                    dataset.width,
                    dataset.height,
                    None,
                    tile_side,
                )
            iter_windows = iter_raster_read_windows(
                raster_area_tools.raster_window,
                dataset.block_shapes[0],
                dataset.width,
                dataset.height,
                raster_batch_plan,
            )
            reader = (
                read_native_raster_block
                if raster_batch_plan.targetChunkPixels is None
                else read_native_raster_window
            )
            for block, native_blocks in iter_windows:
                read_started = time.perf_counter()
                native = reader(dataset, block)
                read_seconds += time.perf_counter() - read_started
                read_count += 1
                calculate_started = time.perf_counter()
                intersection = block.intersection(raster_area_tools.raster_window)
                mask_started = time.perf_counter()
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
                    mask_read_seconds += time.perf_counter() - mask_started
                mask_seconds += time.perf_counter() - mask_started
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
                        data = values.data.astype(np.float64)
                        valid = ~np.ma.getmaskarray(values) & np.isfinite(data)
                        weights_started = time.perf_counter()
                        hectares = (
                            pixel_area_calculator.calculate_hectares(tile)
                            if pixel_area_calculator is not None
                            else None
                        )
                        weights_seconds += time.perf_counter() - weights_started
                        area_valid = (
                            valid & (hectares > 0) if hectares is not None else None
                        )
                        mask_started = time.perf_counter()
                        if selection_valid is not None:
                            mask_local = Window(
                                x - intersection.col_off,
                                y - intersection.row_off,
                                tile.width,
                                tile.height,
                            )
                            valid &= selection_valid[mask_local.toslices()]
                        mask_seconds += time.perf_counter() - mask_started
                        reduction_started = time.perf_counter()
                        for calculation in calculations:
                            calculation.process_tile(data, valid, hectares, area_valid)
                        reduction_seconds += time.perf_counter() - reduction_started
                        tile_count += 1
                        # Release the tile before allocating the next one; no old
                        # source view may retain the previous combined read.
                        del values, data, valid, hectares, area_valid
                del native, selection_valid
                calculation_seconds += time.perf_counter() - calculate_started
                completed_blocks += native_blocks
                if time.monotonic() - last_progress > PROGRESS_INTERVAL_SECONDS:
                    write_progress(
                        directory,
                        "calculating",
                        completed_blocks,
                        calculation_plan.grid.nativeBlocks,
                    )
                    last_progress = time.monotonic()
    calculate_started = time.perf_counter()
    rows = [
        {"label": item.label, "expression": item.expression, **calculation.result()}
        for item, calculation in zip(
            calculation_plan.calculations, calculations, strict=True
        )
    ]
    final_reduction_seconds = time.perf_counter() - calculate_started
    calculation_seconds += final_reduction_seconds
    reduction_seconds += final_reduction_seconds
    write_progress(
        directory,
        "writing_results",
        completed_blocks,
        calculation_plan.grid.nativeBlocks,
    )
    performance = AggregatePerformance(
        execution=raster_batch_plan,
        readWindows=read_count,
        evaluationTiles=tile_count,
        reducerUpdates=tile_count * len(calculations),
        readSeconds=read_seconds,
        calculationSeconds=calculation_seconds,
        resultWriteSeconds=0.0,
        kernelSeconds=time.perf_counter() - started,
        retainedPolygonBytes=raster_area_tools.retained_polygon_bytes,
        temporaryMaskBytes=mask_bytes,
        stages=AggregateKernelStages(
            sourceSetupSeconds=source_ready - started,
            selectionSetupSeconds=raster_area_tools.selection_setup_seconds,
            groundAreaSetupSeconds=raster_area_tools.pixel_area_setup_seconds,
            gridCheckSeconds=0.0,
            selectionMaskSeconds=mask_seconds,
            maskPreparationSeconds=mask_preparation_seconds,
            maskReadSeconds=mask_read_seconds,
            areaWeightsSeconds=weights_seconds,
            reductionSeconds=reduction_seconds,
        ),
    )
    return write_statistics_result(
        calculation_plan, rows, directory, performance=performance
    )


def write_statistics_result(
    calculation_plan: AggregateSpec,
    rows: list[dict[str, object]],
    directory: Path,
    *,
    performance: AggregatePerformance | None = None,
    cache_hit: bool = False,
) -> AggregateArtifact:
    """Write this calculation's CSV and provenance, including reused values.

    Args:
        calculation_plan: Raster, area and formulas recorded for this request.
        rows: Completed result rows with the current labels and formula text.
        directory: Existing private job directory in which to write both files.
        performance: Measurements through calculation completion, when executed.
            CSV writing time is added here. Omit for cached results.
        cache_hit: Whether all values came from the shared result cache.

    Returns:
        CSV size, checksum, inline values and this request's cache/timing metadata.

    Raises:
        OSError: If result files cannot be written.
        ValueError: If result metadata cannot be serialized as finite JSON.
    """
    writing_started = time.perf_counter()
    result = directory / "result.csv"
    with result.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["label", "expression", "value", "value_type", "state", "unit"])
        for row in rows:
            writer.writerow(
                [
                    csv_text(row["label"]),
                    csv_text(row["expression"]),
                    row["value"],
                    row["valueType"],
                    row["state"],
                    row["unit"],
                ]
            )
    with result.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    source = next(iter(calculation_plan.sources.values()))
    if performance is not None:
        write_seconds = time.perf_counter() - writing_started
        performance = performance.model_copy(
            update={
                "resultWriteSeconds": write_seconds,
                "kernelSeconds": performance.kernelSeconds + write_seconds,
            }
        )
    artifact = AggregateArtifact(
        size=result.stat().st_size,
        sha256=digest,
        filename=f"{source.item_id}-calculations.csv",
        rows=rows,
        performance=performance.model_dump(mode="json") if performance else None,
        cache_hit=cache_hit,
    )
    provenance = {
        **calculation_plan.model_dump(mode="json", by_alias=True),
        "resolution": "native",
        "valueDomain": "stored",
        "inclusion": (
            "per_function" if calculation_plan.grid.groundArea else "cell_center"
        ),
        "functionInclusion": (
            {"numeric": "cell_center", "areaha": "fractional_cell_intersection"}
            if calculation_plan.grid.groundArea
            else {"numeric": "cell_center"}
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
