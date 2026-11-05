"""Calculate native-grid period statistics and valid-observation count rasters."""

from collections.abc import Callable, Iterator
from contextlib import ExitStack
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
import math
import mmap
from pathlib import Path
import time
from typing import Any, Literal, cast

import numpy as np
from numpy.typing import NDArray
import rasterio
from rasterio.shutil import copy as copy_raster
from rasterio.windows import Window, transform as window_transform

from eolab_app.bounded_vector import PolygonRasterizer
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_aggregate import prepare_raster_area_tools
from eolab_app.processing.raster_mask import temporary_polygon_mask
from eolab_app.processing.temporal_grid import (
    TemporalReadGrid,
    plan_temporal_grid,
    temporal_grid_windows,
)
from eolab_app.processing.temporal_models import (
    TemporalMapArtifact,
    TemporalMapSpec,
    TemporalReduction,
)
from eolab_app.raster.source_contract import read_native_raster_window
from eolab_app.raster.temporal import ResolvedTemporalInterval, TemporalRasterDataset

# Target retained accumulator cells; one native window is always processed.
STREAMING_BATCH_PIXELS = 1024 * 1024


def _batch_windows(grid: TemporalReadGrid) -> Iterator[tuple[Window, ...]]:
    """Group native windows to reuse observation handles with modest accumulators.

    A batch targets about one million selected cells. A larger native window
    remains a valid batch; this chooses working storage without limiting a job.

    Args:
        grid: Admitted native windows and selected crop.

    Yields:
        Nonempty batches in the original native-window order.
    """
    windows: list[Window] = []
    pixels = 0
    for window in temporal_grid_windows(grid):
        window_pixels = int(window.width) * int(window.height)
        if windows and pixels + window_pixels > STREAMING_BATCH_PIXELS:
            yield tuple(windows)
            windows, pixels = [], 0
        windows.append(window)
        pixels += window_pixels
    if windows:
        yield tuple(windows)


def _read_observations(
    interval: ResolvedTemporalInterval,
    window: Window,
    column_rotation: int,
    record_read: Callable[[], None],
) -> Iterator[np.ma.MaskedArray]:
    """Read one native tile per observation with one shared longitude origin.

    Args:
        interval: Authorized observations in increasing label order.
        window: Integral native tile inside the planned longitude view.
        column_rotation: Source-column shift chosen when the area was planned.
        record_read: Count a completed native observation-window read.

    Yields:
        Native finite values with declared NoData cells masked.

    Raises:
        OSError: If native storage cannot be read.
        ValueError: If a source chunk is corrupt or escapes its archive.
        rasterio.errors.RasterioError: If a native TIFF cannot be opened or read.
    """
    for observation in interval.observations:
        with TemporalRasterDataset(observation) as dataset:
            dataset.prepare_column_view(column_rotation)
            values = read_native_raster_window(dataset, window)
            record_read()
            yield values


def _reduce_ordered_values(
    interval: ResolvedTemporalInterval,
    window: Window,
    column_rotation: int,
    percentile: float,
    scratch: Path,
    record_read: Callable[[], None],
    record_ordering: Callable[[int], None],
) -> tuple[NDArray[np.float64], NDArray[np.uint64]]:
    """Calculate exact linear percentiles using disk-backed observation rows.

    Args:
        interval: Authorized observations in label order.
        window: One native spatial tile.
        column_rotation: Planned source-column shift.
        percentile: Validated percentile between zero and one hundred.
        scratch: Attempt-owned file reused for this tile's temporary values.
        record_read: Count a completed native observation-window read.
        record_ordering: Count processed pixel series; zero starts this phase.

    Returns:
        Two-dimensional percentile values and valid-observation counts.
        A cell with no valid observations has a NaN value and zero count.

    Raises:
        OSError: If source or scratch-file I/O fails.
        ValueError: If native decoding fails.
        rasterio.errors.RasterioError: If a native TIFF cannot be opened or read.
    """
    shape = (int(window.height), int(window.width))
    pixels = shape[0] * shape[1]
    observations = len(interval.observations)
    counts = np.zeros(pixels, dtype="uint64")
    result = np.full(pixels, np.nan, dtype="float64")
    size = pixels * observations * np.dtype("float64").itemsize
    try:
        with scratch.open("w+b") as stream:
            stream.truncate(size)
            with mmap.mmap(stream.fileno(), size) as storage:
                series = np.ndarray(
                    (pixels, observations), dtype="float64", buffer=storage
                )
                for index, values in enumerate(
                    _read_observations(interval, window, column_rotation, record_read)
                ):
                    valid = ~np.ma.getmaskarray(values)
                    series[:, index] = np.where(valid, values.data, np.nan).ravel()
                    counts += valid.ravel().astype("uint64")
                record_ordering(0)
                for pixel in range(pixels):
                    count = int(counts[pixel])
                    if count:
                        position = (count - 1) * percentile / 100
                        lower, upper = math.floor(position), math.ceil(position)
                        # NumPy orders NaNs after finite values. Partition works in
                        # place on this contiguous disk-backed row, not the cube.
                        series[pixel].partition((lower, upper))
                        low, high = series[pixel, lower], series[pixel, upper]
                        fraction = position - lower
                        result[pixel] = low * (1 - fraction) + high * fraction
                    record_ordering(1)
                del series
    finally:
        scratch.unlink(missing_ok=True)
    return result.reshape(shape), counts.reshape(shape)


def _reduce_streaming_batch(
    interval: ResolvedTemporalInterval,
    reduction: TemporalReduction,
    conversion_factor: float,
    windows: tuple[Window, ...],
    column_rotation: int,
    record_read: Callable[[], None],
) -> tuple[tuple[Window, NDArray[np.float64], NDArray[np.uint64]], ...]:
    """Reduce a spatial batch while opening each observation only once.

    Every cell retains the original observation order and float64 operations.
    Accumulators and precipitation scratch arrays are retained for this batch;
    observation handles close before opening the next or returning the arrays.

    Args:
        interval: Authorized observations in increasing label order.
        reduction: Streaming statistic or integrated precipitation total;
            median and percentile are handled separately.
        conversion_factor: Model-configured multiplier after rate times seconds;
            unused by ordinary statistics.
        windows: Native windows grouped by their selected-cell working target.
        column_rotation: Source-column shift shared by every observation.
        record_read: Count a native read after its accumulator update completes.

    Returns:
        Each native window, its statistic values and valid counts. All-missing
        cells contain NaN and zero, respectively.

    Raises:
        OSError: If a native source cannot be read.
        ValueError: If native decoding fails.
        FloatingPointError: If the statistic overflows float64 arithmetic.
        rasterio.errors.RasterioError: If a native TIFF cannot be opened or read.
    """
    shapes = [(int(window.height), int(window.width)) for window in windows]
    results = [np.zeros(shape, dtype="float64") for shape in shapes]
    counts = [np.zeros(shape, dtype="uint64") for shape in shapes]
    variances = [
        np.zeros(shape, dtype="float64") if reduction.reducer == "stdev" else None
        for shape in shapes
    ]
    precipitation_values = [
        (
            np.empty(shape, dtype="float64")
            if reduction.reducer == "precipitation_total"
            else None
        )
        for shape in shapes
    ]
    for observation in interval.observations:
        with TemporalRasterDataset(observation) as dataset:
            dataset.prepare_column_view(column_rotation)
            for window, result, count, variance_sum, converted_values in zip(
                windows, results, counts, variances, precipitation_values, strict=True
            ):
                values = read_native_raster_window(dataset, window)
                valid = ~np.ma.getmaskarray(values)
                if reduction.reducer in {"min", "max"}:
                    previous_counts = count[valid]
                np.add(count, valid, out=count)
                if reduction.reducer == "precipitation_total":
                    seconds = (
                        observation.interval_end - observation.interval_start
                    ).total_seconds()
                    np.multiply(
                        values.data,
                        seconds,
                        out=converted_values,
                        dtype="float64",
                        where=valid,
                    )
                    np.multiply(
                        converted_values,
                        conversion_factor,
                        out=converted_values,
                        where=valid,
                    )
                    np.add(result, converted_values, out=result, where=valid)
                elif reduction.reducer == "sum":
                    np.add(
                        result, values.data, out=result, dtype="float64", where=valid
                    )
                else:
                    current = values.data[valid].astype("float64")
                    if reduction.reducer in {"mean", "stdev"}:
                        delta = current - result[valid]
                        result[valid] += delta / count[valid]
                        if variance_sum is not None:
                            variance_sum[valid] += delta * (current - result[valid])
                    elif reduction.reducer == "min":
                        result[valid] = np.where(
                            previous_counts == 0,
                            current,
                            np.minimum(result[valid], current),
                        )
                    else:
                        result[valid] = np.where(
                            previous_counts == 0,
                            current,
                            np.maximum(result[valid], current),
                        )
                record_read()
    reduced = []
    for window, result, count, variance_sum in zip(
        windows, results, counts, variances, strict=True
    ):
        present = count > 0
        if variance_sum is not None:
            result[present] = np.sqrt(
                np.maximum(variance_sum[present], 0) / count[present]
            )
        result[~present] = np.nan
        reduced.append((window, result, count))
    return tuple(reduced)


def _reduce_windows(
    interval: ResolvedTemporalInterval,
    spec: TemporalMapSpec,
    directory: Path,
    record_read: Callable[[], None],
    record_ordering: Callable[[int], None],
) -> Iterator[tuple[Window, NDArray[np.float64], NDArray[np.uint64]]]:
    """Yield native results using batched streaming or exact disk-backed ordering.

    Args:
        interval: Authorized observations in the established chronological order.
        spec: Accepted native grid, reducer and precipitation conversion.
        directory: Attempt-owned scratch directory for exact order statistics.
        record_read: Count completed native observation-window reads.
        record_ordering: Count processed pixel series; zero starts the phase.

    Yields:
        Native windows with their statistic values and valid-observation counts.

    Raises:
        ProcessingError: If the statistic overflows float64 arithmetic.
        OSError: If source or scratch-file I/O fails.
        ValueError: If native decoding fails.
        rasterio.errors.RasterioError: If a native TIFF cannot be opened or read.
    """
    try:
        if spec.reduction.reducer in {"median", "percentile"}:
            percentile = (
                50.0
                if spec.reduction.reducer == "median"
                else cast(float, spec.reduction.percentile)
            )
            for window in temporal_grid_windows(spec.grid):
                with np.errstate(over="raise", invalid="raise"):
                    values, counts = _reduce_ordered_values(
                        interval,
                        window,
                        spec.grid.columnRotation,
                        percentile,
                        directory / "ordered-values.bin",
                        record_read,
                        record_ordering,
                    )
                yield window, values, counts
        else:
            for windows in _batch_windows(spec.grid):
                with np.errstate(over="raise", invalid="raise"):
                    reduced = _reduce_streaming_batch(
                        interval,
                        spec.reduction,
                        spec.conversionFactor,
                        windows,
                        spec.grid.columnRotation,
                        record_read,
                    )
                yield from reduced
                del reduced
    except FloatingPointError as error:
        raise ProcessingError(
            "numerical_error",
            "The temporal statistic exceeds float64 arithmetic.",
        ) from error


def _create_cog(
    stage: Path,
    destination: Path,
    grid: TemporalReadGrid,
    valid_pixels: int,
    unit: str,
) -> ProducedFile:
    """Convert a completed raster and verify its grid, validity mask and unit.

    Args:
        stage: Completed attempt-owned GeoTIFF to convert.
        destination: Ordinary COG result path in the same attempt.
        grid: Expected native output dimensions and georeferencing.
        valid_pixels: Number of cells that must remain valid after conversion.
        unit: Expected band unit.

    Returns:
        Completed file metadata and SHA-256 checksum for artifact publication.

    Raises:
        ProcessingError: If the generated file fails output-integrity checks.
        OSError: If conversion, verification or checksumming fails.
    """
    copy_raster(
        stage,
        destination,
        driver="COG",
        COMPRESS="DEFLATE",
        BLOCKSIZE=512,
        PREDICTOR="YES",
        OVERVIEW_RESAMPLING="NEAREST",
        NUM_THREADS="2",
        BIGTIFF="IF_SAFER",
    )
    with rasterio.open(destination) as result:
        if (
            result.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG"
            or result.width != grid.width
            or result.height != grid.height
            or result.count != 1
            or result.dtypes != ("float64",)
            or result.crs.to_wkt() != grid.crs
            or tuple(result.transform)[:6] != grid.transform
            or not math.isnan(result.nodata)
            or result.units != (unit,)
            or (max(result.shape) > 512 and not result.overviews(1))
        ):
            raise ProcessingError(
                "invalid_output", "The temporal result failed grid/COG validation.", 500
            )
        actual_valid = sum(
            int(np.count_nonzero(result.read_masks(1, window=window)))
            for _, window in result.block_windows(1)
        )
        if actual_valid != valid_pixels:
            raise ProcessingError(
                "invalid_output",
                "The temporal result failed validity-mask validation.",
                500,
            )
    with destination.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    stage.unlink()
    return ProducedFile(
        name="raster" if destination.stem == "result" else "count",
        storage_name=destination.name,
        filename=destination.name,
        media_type="image/tiff",
        size=destination.stat().st_size,
        sha256=digest,
    )


def create_temporal_map(
    interval: ResolvedTemporalInterval,
    spec: TemporalMapSpec,
    directory: Path,
    limits: RasterAggregateLimits,
) -> TemporalMapArtifact:
    """Write one period-statistic COG, its count COG and observation provenance.

    Args:
        interval: Authorized observations kept unchanged during this run.
        spec: Accepted native-grid plan and path-free source/area choices.
        directory: Private attempt directory owned and cleaned by Processing.
        limits: Existing Processing lifecycle and geometry settings.

    Returns:
        Primary statistic metadata, valid-cell count and the count-file inventory.
        All-missing areas still produce a valid result with zero count cells.

    Raises:
        ProcessingError: If numerical computation or output validation fails.
        OSError: If a native input or output cannot be read or written.
        ValueError: If native source decoding fails.
        rasterio.errors.RasterioError: If native raster I/O fails.
    """
    grid = spec.grid
    crop = Window(*grid.window)
    stage = directory / "statistic-stage.tif"
    count_stage = directory / "count-stage.tif"
    valid_pixels = count_pixels = 0
    total_reads = len(interval.observations) * grid.tileCount
    completed_reads = ordered_pixels = 0
    last_read_progress = last_ordering_progress = 0.0
    write_progress(directory, "reducing", 0, total_reads, unit="raster reads")

    def record_read() -> None:
        """Count a completed observation-window read and throttle its updates.

        Raises:
            OSError: If the attempt's atomic progress file cannot be written.
        """
        nonlocal completed_reads, last_read_progress
        completed_reads += 1
        now = time.monotonic()
        if completed_reads == total_reads or now - last_read_progress > 0.5:
            write_progress(
                directory, "reducing", completed_reads, total_reads, unit="raster reads"
            )
            last_read_progress = now

    def record_ordering(increment: int) -> None:
        """Count processed pixel series across exact median/percentile windows.

        Args:
            increment: One after a pixel is processed, or zero to enter the phase.

        Raises:
            OSError: If the attempt's atomic progress file cannot be written.
        """
        nonlocal ordered_pixels, last_ordering_progress
        ordered_pixels += increment
        now = time.monotonic()
        if (
            not increment
            or ordered_pixels == grid.width * grid.height
            or now - last_ordering_progress > 0.5
        ):
            write_progress(
                directory,
                "ordering",
                ordered_pixels,
                grid.width * grid.height,
                unit="pixels",
            )
            last_ordering_progress = now

    with (
        rasterio.Env(
            GDAL_CACHEMAX=64 * 1024**2,
            GDAL_NUM_THREADS="2",
            GDAL_TIFF_INTERNAL_MASK=True,
            CPL_TMPDIR=str(directory),
        ),
        ExitStack() as stack,
    ):
        source = stack.enter_context(TemporalRasterDataset(interval.observations[0]))
        source.prepare_column_view(grid.columnRotation)
        tools = prepare_raster_area_tools(source, spec.area, limits)
        polygons = tools.selected_polygons
        if isinstance(polygons, PolygonRasterizer):
            stack.callback(polygons.close)
        mask = stack.enter_context(
            temporary_polygon_mask(source, crop, polygons, directory, limits)
        )
        if isinstance(polygons, PolygonRasterizer):
            polygons.close()
        profile = dict(
            driver="GTiff",
            width=grid.width,
            height=grid.height,
            count=1,
            dtype="float64",
            crs=grid.crs,
            transform=window_transform(crop, source.transform),
            nodata=np.nan,
            tiled=True,
            blockxsize=512,
            blockysize=512,
            compress="DEFLATE",
            BIGTIFF="IF_SAFER",
        )
        with (
            rasterio.open(stage, "w", **profile) as statistic,
            rasterio.open(count_stage, "w", **profile) as count_raster,
        ):
            statistic.set_band_unit(1, spec.unit)
            count_raster.set_band_unit(1, "observations")
            statistic.update_tags(1, units=spec.unit, reducer=spec.reduction.reducer)
            count_raster.update_tags(1, units="observations")
            for window, values, counts in _reduce_windows(
                interval, spec, directory, record_read, record_ordering
            ):
                output_window = Window(
                    window.col_off - crop.col_off,
                    window.row_off - crop.row_off,
                    window.width,
                    window.height,
                )
                inside = (
                    mask.read(1, window=output_window) != 0
                    if mask is not None
                    else np.ones((int(window.height), int(window.width)), dtype=bool)
                )
                valid = inside & (counts > 0)
                valid_pixels += int(np.count_nonzero(valid))
                count_pixels += int(np.count_nonzero(inside))
                statistic.write(
                    np.where(valid, values, np.nan), 1, window=output_window
                )
                statistic.write_mask(valid.astype("uint8") * 255, window=output_window)
                count_raster.write(
                    np.where(inside, counts.astype("float64"), np.nan),
                    1,
                    window=output_window,
                )
                count_raster.write_mask(
                    inside.astype("uint8") * 255, window=output_window
                )
        write_progress(directory, "creating_cog", 0, 2, unit="files")
        result = _create_cog(
            stage, directory / "result.tif", grid, valid_pixels, spec.unit
        )
        write_progress(directory, "creating_cog", 1, 2, unit="files")
        count = _create_cog(
            count_stage, directory / "count.tif", grid, count_pixels, "observations"
        )
        write_progress(directory, "creating_cog", 2, 2, unit="files")
    artifact = TemporalMapArtifact(
        size=result.size,
        sha256=result.sha256,
        filename=result.filename,
        valid_pixels=valid_pixels,
        additional_outputs=(count,),
    )
    provenance = {
        **spec.model_dump(mode="json", by_alias=True),
        "observations": [
            {
                "time": item.time.isoformat(),
                "referenceTime": (
                    item.reference_time.isoformat() if item.reference_time else None
                ),
                "intervalStart": item.interval_start.isoformat(),
                "intervalEnd": item.interval_end.isoformat(),
            }
            for item in interval.observations
        ],
        "inputUnit": interval.unit,
        "availableDurationSeconds": sum(
            (item.interval_end - item.interval_start).total_seconds()
            for item in interval.observations
        ),
        "weighting": (
            "interval duration"
            if spec.reduction.reducer == "precipitation_total"
            else "equal observations"
        ),
        "allTouched": False,
        "standardDeviation": "population",
        "percentileMethod": "linear",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        **asdict(artifact),
    }
    (directory / "provenance.json").write_text(
        json.dumps(provenance, allow_nan=False), encoding="utf-8"
    )
    return artifact


def temporal_process_target(
    queue: ProcessResultWriter,
    operation: Literal["plan", "reduce"],
    arguments: tuple[Any, ...],
) -> None:
    """Run temporal planning or reduction under the existing native-process supervisor.

    Args:
        queue: Supervisor-owned single-result writer.
        operation: Metadata planning or raster reduction action.
        arguments: Picklable validated arguments for the selected operation.
    """
    try:
        value = (
            plan_temporal_grid(*arguments)
            if operation == "plan"
            else create_temporal_map(*arguments)
        )
        queue.put(("ok", value))
    except ProcessingError as error:
        queue.put(("error", (error.code, error.detail, error.status)))
    except (OSError, ValueError, rasterio.errors.RasterioError):
        queue.put(
            (
                "error",
                (
                    "temporal_read_failed",
                    "The temporal input or result file could not be read or written.",
                    409,
                ),
            )
        )
    except Exception:
        queue.put(
            (
                "error",
                ("processing_failed", "The temporal map could not be calculated.", 500),
            )
        )
