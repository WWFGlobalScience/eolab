"""Plan native single-raster calculations and stream scalar results to artifacts."""

from eolab_app.bounded_vector import selection_mask
from dataclasses import asdict
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
from eolab_app.processing.aggregate_windows import execution_plan, read_windows
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.ground_area import GroundArea
from eolab_app.processing.raster_expression import Calculation, compile_expression, walk
from eolab_app.processing.raster_input import (
    native_work,
    require_signature,
    require_source,
    select_area,
)
from eolab_app.raster.source_contract import (
    read_native_raster_block,
    read_native_raster_window,
)
from eolab_app.raster.models import RasterAreaMask

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


def selection(
    dataset: rasterio.io.DatasetReader,
    area: AggregateArea,
    limits: RasterAggregateLimits,
) -> tuple[Window, tuple[dict[str, object], ...] | RasterAreaMask]:
    """Resolve one explicit operation area without reading pixel values.

    Args:
        dataset: Validated native dataset.
        area: Frozen box/polygon selection or explicit whole-source selection.
        limits: Coordinate-transformation limits.

    Returns:
        Integral source window and optional projected masking geometries.
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
    )
    return selected.source_window, selected.projected_geometries


def grid(
    dataset: Any,
    window: Window,
    node_count: int,
    limits: RasterAggregateLimits,
    ground_area: GroundAreaPlan | None = None,
    target_chunk_pixels: int | None = None,
    include_execution: bool = True,
) -> AggregateGrid:
    """Admit native work and bounded expression memory for one plan.

    Args:
        dataset: Validated one-band source.
        window: Integral source window.
        node_count: Total bounded expression-tree nodes.
        limits: Work and memory ceilings.
        ground_area: Optional ellipsoidal measurement metadata and geometry work.
        target_chunk_pixels: Opt-in total-pixel budget for combined windows/tiles.
        include_execution: False only when rechecking a pre-batching stored plan.

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
        * (
            np.dtype(dataset.dtypes[0]).itemsize
            + NATIVE_MASK_BYTES_PER_PIXEL
            + (1 if target_chunk_pixels else 0)
        )
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
        execution=execution if include_execution else None,
    )


def plan_aggregate(
    path: Path,
    signature: tuple[int, ...],
    area: AggregateArea,
    calculations: tuple[NamedCalculation, ...],
    alias: str,
    limits: RasterAggregateLimits,
    target_chunk_pixels: int | None = None,
) -> AggregateGrid:
    """Plan only metadata, syntax and geometry inside a bounded child process.

    Args:
        path: Catalog-authorized mounted source.
        signature: Scanner-approved source signature.
        area: Explicit immutable selection.
        calculations: Validated named result expressions.
        alias: Single bound source alias.
        limits: Operation-owned resource ceilings.
        target_chunk_pixels: Optional combined read/evaluation pixel budget.

    Returns:
        Native grid and read/memory estimates, without reading the raster band.
    """
    roots = [compile_expression(item.expression, alias) for item in calculations]
    nodes = sum(sum(1 for _ in walk(root)) for root in roots)
    require_signature(path, signature)
    with rasterio.Env(
        GDAL_CACHEMAX=GDAL_CACHE_BYTES, GDAL_NUM_THREADS=str(GDAL_THREADS)
    ):
        with rasterio.open(path) as dataset:
            require_source(dataset, path)
            window, _ = selection(dataset, area, limits)
            ground = (
                GroundArea(dataset, area, limits, planning=True)
                if any(node.op == "areaha" for root in roots for node in walk(root))
                else None
            )
            if ground is not None:
                window = ground.window
            result = grid(
                dataset,
                window,
                nodes,
                limits,
                ground.metadata if ground else None,
                target_chunk_pixels,
            )
    require_signature(path, signature)
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


def stable_selection_mask(
    dataset: rasterio.io.DatasetReader,
    selected: Window,
    read: Window,
    geometries: tuple[dict[str, object], ...] | RasterAreaMask,
    tile_side: int,
) -> NDArray[np.bool_]:
    """Preserve legacy GDAL cell-center decisions independently of batch dimensions.

    GDAL rasterization at exact polygon boundaries can depend on the local affine
    and window clipping. Rasterize the same native-block/legacy-tile windows as
    before, then assemble their masks for the combined read.

    Args:
        dataset: Source metadata; no band reads are performed here.
        selected: Full admitted selection window.
        read: Combined block-aligned read inside that admitted block rectangle.
        geometries: Projected selection geometries using the established policy.
        tile_side: Legacy numeric or geometry-fallback evaluation ceiling.

    Returns:
        Boolean cell-center membership with the same shape as the combined read.
    """
    mask = np.zeros((int(read.height), int(read.width)), dtype=bool)
    legacy = execution_plan(
        read, dataset.block_shapes[0], dataset.width, dataset.height, None, tile_side
    )
    for block, _ in read_windows(
        read, dataset.block_shapes[0], dataset.width, dataset.height, legacy
    ):
        intersection = block.intersection(selected)
        for y in range(
            int(intersection.row_off),
            int(intersection.row_off + intersection.height),
            tile_side,
        ):
            for x in range(
                int(intersection.col_off),
                int(intersection.col_off + intersection.width),
                tile_side,
            ):
                tile = Window(
                    x,
                    y,
                    min(tile_side, intersection.col_off + intersection.width - x),
                    min(tile_side, intersection.row_off + intersection.height - y),
                )
                local = Window(
                    x - read.col_off, y - read.row_off, tile.width, tile.height
                )
                mask[local.toslices()] = selection_mask(
                    geometries,
                    out_shape=(int(tile.height), int(tile.width)),
                    transform=window_transform(tile, dataset.transform),
                    all_touched=False,
                    invert=True,
                )
    return mask


def create_aggregate(
    path: Path, spec: AggregateSpec, directory: Path, limits: RasterAggregateLimits
) -> AggregateArtifact:
    """Calculate summary statistics for a selected area of a raster.

    Read the raster in blocks, exclude nodata pixels and pixels outside the
    selected area, and evaluate the expressions in spec. Write the results
    to CSV and record the inputs and calculation details in a provenance file.

    Args:
        path: Path to the input raster.
        spec: Expressions to evaluate, area to summarize, expected source
            signature, and grid produced by plan_aggregate.
        directory: Existing directory for result files and progress updates.
        limits: Limits on raster reads, memory use, and geometry processing.

    Returns:
        An AggregateArtifact containing the calculated values, performance
        timings, and the CSV filename, size, and checksum.

    Raises:
        ProcessingError: If the source or grid differs from the plan, or
            the calculation exceeds a processing limit.
    """
    started = time.perf_counter()
    read_seconds = calculation_seconds = 0.0
    mask_seconds = weights_seconds = reduction_seconds = 0.0
    read_count = tile_count = completed_blocks = 0
    alias = next(iter(spec.sources))
    roots = [compile_expression(item.expression, alias) for item in spec.calculations]
    calculations = [Calculation(root) for root in roots]
    nodes = sum(sum(1 for _ in walk(root)) for root in roots)
    require_signature(path, spec.sourceSignature)
    with rasterio.Env(
        GDAL_CACHEMAX=GDAL_CACHE_BYTES, GDAL_NUM_THREADS=str(GDAL_THREADS)
    ):
        with rasterio.open(path) as dataset:
            require_source(dataset, path)
            source_ready = time.perf_counter()
            window, geometries = selection(dataset, spec.area, limits)
            selection_ready = time.perf_counter()
            ground = (
                GroundArea(dataset, spec.area, limits)
                if any(node.op == "areaha" for root in roots for node in walk(root))
                else None
            )
            if ground is not None:
                window = ground.window
            ground_ready = time.perf_counter()
            if (
                grid(
                    dataset,
                    window,
                    nodes,
                    limits,
                    ground.metadata if ground else None,
                    (
                        spec.grid.execution.targetChunkPixels
                        if spec.grid.execution
                        else None
                    ),
                    include_execution=spec.grid.execution is not None,
                )
                != spec.grid
            ):
                raise ProcessingError(
                    "plan_changed",
                    "The calculation grid or policy changed. Create a new plan.",
                    409,
                )
            grid_ready = time.perf_counter()
            last_progress = 0.0
            tile_side = (
                AREA_TILE_SIDE if ground and not ground.rectilinear else TILE_SIDE
            )
            execution = spec.grid.execution or execution_plan(
                window,
                dataset.block_shapes[0],
                dataset.width,
                dataset.height,
                None,
                tile_side,
            )
            windows = read_windows(
                window,
                dataset.block_shapes[0],
                dataset.width,
                dataset.height,
                execution,
            )
            reader = (
                read_native_raster_block
                if execution.targetChunkPixels is None
                else read_native_raster_window
            )
            for block, native_blocks in windows:
                read_started = time.perf_counter()
                native = reader(dataset, block)
                read_seconds += time.perf_counter() - read_started
                read_count += 1
                calculate_started = time.perf_counter()
                intersection = block.intersection(window)
                mask_started = time.perf_counter()
                selection_valid = (
                    stable_selection_mask(dataset, window, block, geometries, tile_side)
                    if geometries and execution.targetChunkPixels
                    else None
                )
                mask_seconds += time.perf_counter() - mask_started
                for y in range(
                    int(intersection.row_off),
                    int(intersection.row_off + intersection.height),
                    execution.evaluationHeight,
                ):
                    for x in range(
                        int(intersection.col_off),
                        int(intersection.col_off + intersection.width),
                        execution.evaluationWidth,
                    ):
                        tile = Window(
                            x,
                            y,
                            min(
                                execution.evaluationWidth,
                                intersection.col_off + intersection.width - x,
                            ),
                            min(
                                execution.evaluationHeight,
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
                        hectares = ground.weights(tile) if ground is not None else None
                        weights_seconds += time.perf_counter() - weights_started
                        area_valid = (
                            valid & (hectares > 0) if hectares is not None else None
                        )
                        mask_started = time.perf_counter()
                        if selection_valid is not None:
                            valid &= selection_valid[local.toslices()]
                        elif geometries:
                            valid &= selection_mask(
                                geometries,
                                out_shape=data.shape,
                                transform=window_transform(tile, dataset.transform),
                                all_touched=False,
                                invert=True,
                            )
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
                        spec.grid.nativeBlocks,
                    )
                    last_progress = time.monotonic()
    require_signature(path, spec.sourceSignature)
    calculate_started = time.perf_counter()
    rows = [
        {"label": item.label, "expression": item.expression, **calculation.result()}
        for item, calculation in zip(spec.calculations, calculations, strict=True)
    ]
    final_reduction_seconds = time.perf_counter() - calculate_started
    calculation_seconds += final_reduction_seconds
    reduction_seconds += final_reduction_seconds
    write_progress(
        directory, "writing_results", completed_blocks, spec.grid.nativeBlocks
    )
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
    source = next(iter(spec.sources.values()))
    performance = AggregatePerformance(
        execution=execution,
        readWindows=read_count,
        evaluationTiles=tile_count,
        reducerUpdates=tile_count * len(calculations),
        readSeconds=read_seconds,
        calculationSeconds=calculation_seconds,
        resultWriteSeconds=time.perf_counter() - writing_started,
        kernelSeconds=time.perf_counter() - started,
        stages=AggregateKernelStages(
            sourceSetupSeconds=source_ready - started,
            selectionSetupSeconds=selection_ready - source_ready,
            groundAreaSetupSeconds=ground_ready - selection_ready,
            gridCheckSeconds=grid_ready - ground_ready,
            selectionMaskSeconds=mask_seconds,
            areaWeightsSeconds=weights_seconds,
            reductionSeconds=reduction_seconds,
        ),
    )
    artifact = AggregateArtifact(
        size=result.stat().st_size,
        sha256=digest,
        filename=f"{source.item_id}-calculations.csv",
        rows=rows,
        performance=performance.model_dump(mode="json"),
    )
    provenance = {
        **spec.model_dump(mode="json", by_alias=True),
        "resolution": "native",
        "valueDomain": "stored",
        "inclusion": "per_function" if spec.grid.groundArea else "cell_center",
        "functionInclusion": (
            {"numeric": "cell_center", "areaha": "fractional_cell_intersection"}
            if spec.grid.groundArea
            else {"numeric": "cell_center"}
        ),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        **asdict(artifact),
    }
    (directory / "provenance.json").write_text(
        json.dumps(provenance, allow_nan=False), encoding="utf-8"
    )
    require_signature(path, spec.sourceSignature)
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
            value = create_aggregate(*arguments)
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
