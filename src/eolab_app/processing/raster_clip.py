"""Bounded full-resolution clip kernel; no job, HTTP, or rendering services."""

from eolab_app.bounded_vector import selection_mask
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import time
from typing import Any, Literal

import numpy
import rasterio
from eolab_app.execution.bounded_process import ProcessResultWriter
from rasterio.shutil import copy as copy_raster
from rasterio.windows import Window, transform as window_transform

from eolab_app.processing.models import ProcessingError
from eolab_app.processing.artifacts import write_progress as _progress
from eolab_app.processing.raster_input import (
    require_signature as _require_signature,
    validate_supported_raster as _validate_supported_raster,
    select_area,
    native_work,
)
from eolab_app.processing.clip_models import (
    ClipArtifact,
    ClipArea,
    ClipGrid,
    ClipSpec,
    RasterClipLimits,
)
from eolab_app.raster.models import SelectedRasterArea
from eolab_app.raster.source_contract import (
    read_native_raster_block,
    source_block_indexes_for_window,
)


def _selection(
    dataset: Any, area: ClipArea, limits: RasterClipLimits
) -> SelectedRasterArea:
    """Delegate the clip's explicit area to shared native-input mechanisms.

    Args:
        dataset: Validated open native raster.
        area: Immutable clip bounds/polygon selection.
        limits: Geometry budget owned by clipping.

    Returns:
        Native window and projected mask geometry.
    """
    return select_area(
        dataset,
        area.kind,
        area.bounds,
        area.geometries,
        limits.max_coordinates,
        area.resolved,
    )


def _grid(
    dataset: Any, selected: SelectedRasterArea, limits: RasterClipLimits
) -> ClipGrid:
    """Admit source work before materializing block indexes or reading pixels.

    Args:
        dataset: Validated one-band native grid.
        selected: Projected area and integral source window.
        limits: Work and output ceilings.

    Returns:
        Exact grid metadata and conservative reservation.

    Raises:
        ProcessingError: If output or source work exceeds clip capacity.
    """
    window = selected.source_window
    width, height = int(window.width), int(window.height)
    raw_bytes = width * height * (numpy.dtype(dataset.dtypes[0]).itemsize + 1)
    bh, bw = dataset.block_shapes[0]
    # Conservative O(1) ceiling prevents allocating an unbounded index tuple.
    possible_blocks = (math.ceil(width / bw) + 1) * (math.ceil(height / bh) + 1)
    if raw_bytes > limits.max_raw_bytes or possible_blocks > limits.max_native_blocks:
        raise ProcessingError(
            "clip_too_large",
            "This clip exceeds the native-resolution size or block limit. Choose a smaller area.",
            413,
        )
    block_count, decoded = native_work(
        dataset, window, limits.max_native_blocks, limits.max_decoded_bytes
    )
    return ClipGrid(
        crs=dataset.crs.to_wkt(),
        transform=tuple(window_transform(window, dataset.transform))[:6],
        window=(int(window.col_off), int(window.row_off), width, height),
        width=width,
        height=height,
        dtype=dataset.dtypes[0],
        nodata=None if dataset.nodata is None else str(dataset.nodata),
        nativeBlocks=block_count,
        decodedBytes=decoded,
        estimatedRawBytes=raw_bytes,
        # Source-window staging + COG and overviews + finalization scratch.
        reservedBytes=4 * raw_bytes + 32 * 1024**2,
    )


def plan_clip(
    path: Path, signature: tuple[int, ...], area: ClipArea, limits: RasterClipLimits
) -> ClipGrid:
    """Inspect only metadata and geometry under the caller's process deadline.

    Args:
        path: Authorized local source.
        signature: Scanner-approved full source identity.
        area: Explicit immutable area value.
        limits: Processing-owned resource policy.

    Returns:
        Planned native grid; this function does not read raster values.
    """
    _require_signature(path, signature)
    with rasterio.Env(GDAL_CACHEMAX=64 * 1024**2, GDAL_NUM_THREADS="2"):
        with rasterio.open(path) as dataset:
            _validate_supported_raster(dataset, path)
            grid = _grid(dataset, _selection(dataset, area, limits), limits)
    _require_signature(path, signature)
    return grid


def create_clip(
    path: Path, spec: ClipSpec, directory: Path, limits: RasterClipLimits
) -> ClipArtifact:
    """Stream native blocks to a masked, lossless COG and validate the result.

    Args:
        path: Source freshly authorized by the worker's catalog port.
        spec: Immutable admitted source, geometry, and native-grid contract.
        directory: Empty attempt-owned directory outside all source mounts.
        limits: Same processing policy used for planning and admission.

    Returns:
        Validated artifact metadata. Publication remains the job owner's duty.

    Raises:
        ProcessingError: For stale source, changed plan, or no valid pixels.
        OSError: If writing or validating the private artifact fails.
    """
    _require_signature(path, spec.sourceSignature)
    stage = directory / "window.tif"
    result = directory / "result.tif"
    valid_count = 0
    with rasterio.Env(
        GDAL_CACHEMAX=64 * 1024**2,
        GDAL_NUM_THREADS="2",
        GDAL_TIFF_INTERNAL_MASK=True,
        CPL_TMPDIR=str(directory),
    ):
        with rasterio.open(path) as source:
            _validate_supported_raster(source, path)
            selected = _selection(source, spec.area, limits)
            if _grid(source, selected, limits) != spec.grid:
                raise ProcessingError(
                    "plan_changed",
                    "The source grid changed; create a new clip plan.",
                    409,
                )
            window = selected.source_window
            blocks = source_block_indexes_for_window(window, source.block_shapes[0])
            profile = dict(
                driver="GTiff",
                width=spec.grid.width,
                height=spec.grid.height,
                count=1,
                dtype=source.dtypes[0],
                crs=source.crs,
                transform=window_transform(window, source.transform),
                nodata=source.nodata,
                tiled=True,
                blockxsize=512,
                blockysize=512,
                compress="DEFLATE",
                BIGTIFF="IF_SAFER",
            )
            with rasterio.open(stage, "w", **profile) as destination:
                destination.scales = source.scales
                destination.offsets = source.offsets
                destination.units = source.units
                if source.descriptions[0]:
                    destination.set_band_description(1, source.descriptions[0])
                # Copy descriptive metadata, excluding stale full-source stats
                # and internal paths/provenance belonging to the source file.
                for namespace in (None,):
                    for band in (0, 1):
                        tags = {
                            key: value
                            for key, value in source.tags(band, ns=namespace).items()
                            if key.upper()
                            in {
                                "AREA_OR_POINT",
                                "UNITTYPE",
                                "LONG_NAME",
                                "STANDARD_NAME",
                            }
                        }
                        destination.update_tags(band, **tags)
                destination.update_tags(
                    EOLAB_OPERATION=spec.operation,
                    EOLAB_ITEM=spec.source.item_id,
                    EOLAB_COLLECTION=spec.source.collection_id,
                    EOLAB_MASK_RULE="all_touched",
                    EOLAB_SOURCE_SIGNATURE=json.dumps(spec.sourceSignature),
                    EOLAB_AREA_BOUNDS=json.dumps(spec.area.bounds),
                    EOLAB_AREA_KIND=spec.area.kind,
                )
                last_progress = 0.0
                for index, (row, column) in enumerate(blocks):
                    native_window = source.block_window(1, row, column)
                    native = read_native_raster_block(source, native_window)
                    intersection = native_window.intersection(window)
                    local = Window(
                        intersection.col_off - native_window.col_off,
                        intersection.row_off - native_window.row_off,
                        intersection.width,
                        intersection.height,
                    )
                    values = native[local.toslices()]
                    inside = selection_mask(
                        selected.projected_geometries,
                        out_shape=values.shape,
                        transform=window_transform(intersection, source.transform),
                        all_touched=True,
                        invert=True,
                    )
                    valid = (
                        inside
                        & ~numpy.ma.getmaskarray(values)
                        & numpy.isfinite(values.data)
                    )
                    valid_count += int(numpy.count_nonzero(valid))
                    output = Window(
                        intersection.col_off - window.col_off,
                        intersection.row_off - window.row_off,
                        intersection.width,
                        intersection.height,
                    )
                    data = numpy.where(
                        valid,
                        values.data,
                        source.nodata if source.nodata is not None else 0,
                    )
                    destination.write(
                        data.astype(source.dtypes[0], copy=False), 1, window=output
                    )
                    destination.write_mask(valid.astype("uint8") * 255, window=output)
                    if time.monotonic() - last_progress > 0.5:
                        _progress(directory, "clipping", index + 1, len(blocks))
                        last_progress = time.monotonic()
            if not valid_count:
                raise ProcessingError(
                    "no_valid_data",
                    "There are no valid raster pixels in the selected area.",
                )
        _require_signature(path, spec.sourceSignature)
        _progress(directory, "creating_cog", len(blocks), len(blocks))
        copy_raster(
            stage,
            result,
            driver="COG",
            COMPRESS="DEFLATE",
            BLOCKSIZE=512,
            PREDICTOR="YES",
            OVERVIEW_RESAMPLING="NEAREST",
            NUM_THREADS="2",
            BIGTIFF="IF_SAFER",
        )
        _progress(directory, "validating", len(blocks), len(blocks))
        with rasterio.open(result) as check:
            if (
                check.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG"
                or check.width != spec.grid.width
                or check.height != spec.grid.height
                or check.count != 1
                or check.dtypes[0] != spec.grid.dtype
                or check.crs.to_wkt() != spec.grid.crs
                or tuple(check.transform)[:6] != spec.grid.transform
                or (None if check.nodata is None else str(check.nodata))
                != spec.grid.nodata
                or (max(check.shape) > 512 and not check.overviews(1))
            ):
                raise ProcessingError(
                    "invalid_output",
                    "The generated clip failed grid/COG validation.",
                    500,
                )
            counted = sum(
                int(numpy.count_nonzero(check.read_masks(1, window=block)))
                for _, block in check.block_windows(1)
            )
            if counted != valid_count:
                raise ProcessingError(
                    "invalid_output",
                    "The generated clip failed validity-mask validation.",
                    500,
                )
    _require_signature(path, spec.sourceSignature)
    _progress(directory, "checksumming", len(blocks), len(blocks))
    with result.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    artifact = ClipArtifact(
        size=result.stat().st_size,
        sha256=digest,
        filename=f"{spec.source.item_id}-clip.tif",
        valid_pixels=valid_count,
    )
    provenance = {
        "operation": spec.operation,
        "source": spec.source.model_dump(by_alias=True),
        "sourceSignature": spec.sourceSignature,
        "area": spec.area.model_dump(),
        "grid": spec.grid.model_dump(),
        "allTouched": True,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        **asdict(artifact),
    }
    (directory / "provenance.json").write_text(
        json.dumps(provenance, allow_nan=False), encoding="utf-8"
    )
    stage.unlink()
    return artifact


def clip_process_target(
    queue: ProcessResultWriter,
    operation: Literal["plan", "clip"],
    arguments: tuple[Any, ...],
) -> None:
    """Run one allowlisted native kernel with a sanitized IPC error contract.

    Args:
        queue: Single-result supervisor queue.
        operation: Explicit metadata-plan or raster-clip operation.
        arguments: Picklable validated kernel arguments.
    """
    try:
        if operation == "plan":
            value = plan_clip(*arguments)
        elif operation == "clip":
            value = create_clip(*arguments)
        else:
            raise ValueError("Unknown clip operation")
        queue.put(("ok", value))
    except ProcessingError as error:
        queue.put(("error", (error.code, error.detail, error.status)))
    except Exception:
        queue.put(
            (
                "error",
                ("processing_failed", "The clip could not be processed safely.", 500),
            )
        )
