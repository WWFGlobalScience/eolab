"""Real raster tests for the full-resolution clip operation and native limits."""

import asyncio
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import time

from affine import Affine
import numpy
import pytest
import rasterio
from rasterio.features import geometry_mask
from rasterio.transform import from_origin
from pydantic import ValidationError

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    run_bounded_process,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.clip_models import (
    ClipArea,
    ClipPlanRequest,
    ClipSpec,
    RasterClipLimits,
)
from eolab_app.processing.raster_clip import create_clip, plan_clip
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity

SOURCE = {
    "collectionId": "eolab-mounted-geotiffs",
    "itemId": "geotiff-0123456789abcdef01234567",
}
LIMITS = RasterClipLimits()


def write_source(
    path: Path,
    values: numpy.ndarray,
    nodata: float | None = None,
    transform: Affine | None = None,
    crs: str = "EPSG:4326",
) -> Path:
    """Write a signed-source-compatible real tiled numeric GeoTIFF fixture.

    Args:
        path: New fixture output.
        values: Native band values.
        nodata: Optional signed nodata sentinel.
        transform: Optional rotated or projected affine.
        crs: Declared source reference system.

    Returns:
        Closed one-band source path.
    """
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        count=1,
        width=values.shape[1],
        height=values.shape[0],
        dtype=values.dtype,
        crs=crs,
        transform=transform or from_origin(0, 10, 0.01, 0.01),
        nodata=nodata,
        tiled=True,
        blockxsize=32,
        blockysize=32,
    ) as dataset:
        dataset.write(values, 1)
        dataset.scales = (2,)
        dataset.offsets = (-1,)
        dataset.units = ("m",)
        dataset.set_band_description(1, "Risk value")
        dataset.update_tags(1, STATISTICS_MINIMUM="99999", LONG_NAME="Risk value")
    return path


def make_spec(
    path: Path, area: ClipArea, limits: RasterClipLimits = LIMITS
) -> ClipSpec:
    """Plan a real fixture without reading its data band.

    Args:
        path: Closed fixture source.
        area: Explicit immutable bounds or polygon selection.
        limits: Optional test admission policy.

    Returns:
        Immutable spec suitable for durable JSON round-trip and execution.
    """
    signature = tuple(RasterSourceIdentity.read(path).to_catalog())
    return ClipSpec(
        source=CatalogRasterRequest(**SOURCE),
        sourceSignature=signature,
        area=area,
        grid=plan_clip(path, area, limits),
    )


@pytest.mark.parametrize(
    "extra",
    [
        {},
        {
            "selectedBounds": {"west": 0, "south": 1, "east": 2, "north": 3},
            "temporaryAoiId": "a" * 32,
        },
        {"sourcePath": "/secret.tif"},
        {"url": "https://example.org/file.tif"},
        {"selectedBounds": {"west": 170, "south": 0, "east": -170, "north": 1}},
    ],
)
def test_plan_rejects_implicit_whole_arbitrary_sources_and_ambiguous_area(
    extra: dict,
) -> None:
    """Keep the public boundary explicit and confined.

    Args:
        extra: Invalid or ambiguous request fields.
    """
    with pytest.raises(ValidationError):
        ClipPlanRequest(**SOURCE, **extra)


def test_clip_preserves_native_grid_values_zero_metadata_and_cog(
    tmp_path: Path,
) -> None:
    """Compare every exported pixel and validity value against the original grid.

    Args:
        tmp_path: Isolated source and attempt directories.
    """
    values = numpy.arange(720 * 720, dtype="int32").reshape(720, 720) - 100
    values[10:20, 10:20] = -9999
    values[100:120, 100:120] = 0
    path = write_source(tmp_path / "input.tif", values, nodata=-9999)
    area = ClipArea(kind="bounds", bounds=(0.03, 3.1, 6.8, 9.98))
    spec = make_spec(path, area)
    spec = ClipSpec.model_validate_json(spec.model_dump_json(by_alias=True))
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    artifact = create_clip(path, spec, attempt, LIMITS)
    with rasterio.open(attempt / "result.tif") as result:
        assert result.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert result.overviews(1)
        assert result.dtypes == ("int32",)
        assert result.nodata == -9999
        assert result.scales == (2,)
        assert result.offsets == (-1,)
        assert result.units == ("m",)
        assert result.descriptions == ("Risk value",)
        assert "STATISTICS_MINIMUM" not in result.tags(1)
        assert tuple(result.transform)[:6] == spec.grid.transform
        data = result.read(1, masked=True)
        col, row, width, height = spec.grid.window
        expected = values[row : row + height, col : col + width]
        assert numpy.array_equal(data.data[~data.mask], expected[~data.mask])
        assert numpy.count_nonzero((data.data == 0) & ~data.mask) >= 400
        assert data.count() == artifact.valid_pixels
    provenance = json.loads((attempt / "provenance.json").read_text())
    assert provenance["source"] == SOURCE
    assert str(tmp_path) not in json.dumps(provenance)
    assert (
        artifact.sha256
        == hashlib.sha256((attempt / "result.tif").read_bytes()).hexdigest()
    )
    assert not list(attempt.glob("*.msk"))
    assert not (attempt / "window.tif").exists()


def test_polygon_union_holes_and_nodata_free_zero_are_masked_exactly(
    tmp_path: Path,
) -> None:
    """Mask AOI exteriors/holes while retaining valid zeros without a sentinel.

    Args:
        tmp_path: Isolated test storage.
    """
    path = write_source(tmp_path / "zero.tif", numpy.zeros((100, 100), dtype="uint8"))
    polygon = {
        "type": "Polygon",
        "coordinates": [
            [[0.1, 9.1], [0.9, 9.1], [0.9, 9.9], [0.1, 9.9], [0.1, 9.1]],
            [[0.3, 9.3], [0.7, 9.3], [0.7, 9.7], [0.3, 9.7], [0.3, 9.3]],
        ],
    }
    # A separate overlapping polygon fills only part of the hole.
    overlap = {
        "type": "MultiPolygon",
        "coordinates": [[[[0.5, 9.5], [0.8, 9.5], [0.8, 9.8], [0.5, 9.8], [0.5, 9.5]]]],
    }
    area = ClipArea(
        kind="aoi", bounds=(0.1, 9.1, 0.9, 9.9), geometries=(polygon, overlap)
    )
    spec = make_spec(path, area)
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    artifact = create_clip(path, spec, attempt, LIMITS)
    with rasterio.open(attempt / "result.tif") as result:
        expected = geometry_mask(
            [polygon, overlap],
            result.shape,
            result.transform,
            invert=True,
            all_touched=True,
        )
        assert numpy.array_equal(result.read_masks(1) > 0, expected)
        assert result.nodata is None
        assert result.read(1, masked=True).count() == artifact.valid_pixels
        assert numpy.all(result.read(1) == 0)
        assert 0 < artifact.valid_pixels < result.width * result.height


@pytest.mark.parametrize(
    "transform,crs,bounds",
    [
        (Affine(0.01, 0.002, 0, 0.001, -0.01, 10), "EPSG:4326", (0.1, 9.2, 0.8, 9.8)),
        (from_origin(0, 1_000_000, 1000, 1000), "EPSG:3857", (0.1, 8.3, 0.5, 8.7)),
    ],
)
def test_rotated_and_projected_clips_keep_source_affine(
    tmp_path: Path, transform: Affine, crs: str, bounds: tuple
) -> None:
    """A native clip never silently warps or coarsens a source grid.

    Args:
        tmp_path: Isolated test storage.
        transform: Rotated or projected affine.
        crs: Source CRS.
        bounds: WGS 84 selection intersecting the source.
    """
    path = write_source(
        tmp_path / "grid.tif",
        numpy.ones((100, 100), dtype="float32"),
        transform=transform,
        crs=crs,
    )
    spec = make_spec(path, ClipArea(kind="bounds", bounds=bounds))
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    create_clip(path, spec, attempt, LIMITS)
    with rasterio.open(attempt / "result.tif") as result:
        assert result.crs == rasterio.crs.CRS.from_string(crs)
        assert result.transform.a == transform.a
        assert result.transform.b == transform.b
        assert result.transform.d == transform.d
        assert result.transform.e == transform.e


def test_clips_reject_outside_empty_stale_and_excessive_work(tmp_path: Path) -> None:
    """Boundary failures produce explicit reasons and never a downloadable result.

    Args:
        tmp_path: Isolated test storage.
    """
    path = write_source(
        tmp_path / "empty.tif", numpy.full((100, 100), -9999, dtype="int16"), -9999
    )
    with pytest.raises(ProcessingError) as outside:
        make_spec(path, ClipArea(kind="bounds", bounds=(20, 20, 21, 21)))
    assert outside.value.code == "no_overlap"
    area = ClipArea(kind="bounds", bounds=(0.1, 9.1, 0.9, 9.9))
    with pytest.raises(ProcessingError) as large:
        make_spec(path, area, replace(LIMITS, max_raw_bytes=100))
    assert large.value.code == "clip_too_large"
    with pytest.raises(ProcessingError) as work:
        make_spec(path, area, replace(LIMITS, max_decoded_bytes=100))
    assert work.value.code == "source_work_too_large"
    spec = make_spec(path, area)
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    with pytest.raises(ProcessingError) as empty:
        create_clip(path, spec, attempt, LIMITS)
    assert empty.value.code == "no_valid_data"
    assert not (attempt / "result.tif").exists()


def _slow_writer(queue: object, path: Path) -> None:
    """Simulate native work whose late side effect must be prevented.

    Args:
        queue: Supervisor result queue.
        path: Side-effect marker.
    """
    time.sleep(2)
    path.write_text("late")
    queue.put("finished")


def test_supervisor_stops_native_work_on_deadline_and_cancellation(
    tmp_path: Path,
) -> None:
    """A timed-out or cancelled child cannot keep writing after capacity returns.

    Args:
        tmp_path: Isolated late-side-effect markers.
    """

    async def exercise() -> None:
        """Exercise both caller cancellation and the hard deadline."""
        with pytest.raises(ProcessDeadlineError):
            await run_bounded_process(_slow_writer, (tmp_path / "deadline",), 0.01)
        task = asyncio.create_task(
            run_bounded_process(_slow_writer, (tmp_path / "cancelled",), 10)
        )
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(2.2)
        assert not list(tmp_path.iterdir())

    asyncio.run(exercise())
