"""Reference values, native work and consumer integration for embedded masks."""

import json
import struct
from pathlib import Path
from typing import Literal

import numpy as np
import pytest
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.windows import Window

from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.clip_models import ClipArea
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_aggregate import calculate_raster_statistics_for_area
from eolab_app.processing.raster_clip import create_clip
from eolab_app.processing.raster_input import count_native_raster_blocks
from eolab_app.raster import exact_source, sample_grid, source_contract
from eolab_app.raster.categorical_statistics import read_raster_categorical_statistics
from eolab_app.raster.exact_source import (
    plan_exact_source_window,
    read_exact_source_window,
)
from eolab_app.raster.pixel import read_raster_pixel
from eolab_app.raster.read_cancellation import RasterReadCancelled
from eolab_app.raster.source_access import describe_raster_data
from eolab_app.raster.statistics import (
    NoValidRasterSamplesError,
    read_raster_statistics,
)
from eolab_app.raster.paired_statistics import read_raster_paired_statistics
from eolab_app.sampling_area import WholeRasterSamplingArea
from raster_aggregate_support import make_spec as summary_spec
from raster_clip_support import make_spec as clip_spec, LIMITS as CLIP_LIMITS
from catalog_selection_support import write_selection


def test_real_mask_with_different_native_blocks_is_counted_and_read(
    tmp_path: Path,
) -> None:
    """Read a TIFF whose mask strip is twice the height of its data strips.

    The small TIFF is encoded directly because GDAL's mask writer copies the
    data layout; independently produced TIFFs need not do so.

    Args:
        tmp_path: Isolated fixture storage.
    """
    width, height = 8, 8
    entry_count = 10
    ifd_bytes = 2 + 12 * entry_count + 4
    mask_ifd = 8 + ifd_bytes
    offsets = mask_ifd + ifd_bytes
    counts = offsets + 8
    data_offset = counts + 8
    mask_offset = data_offset + width * height

    def directory(mask: bool) -> bytes:
        """Encode the tags for one uncompressed, single-band TIFF directory.

        Args:
            mask: Emit the full-height mask instead of the two data strips.

        Returns:
            TIFF directory with its next-directory link.
        """
        tags = [
            (254, 4, 1, 4 if mask else 0),
            (256, 4, 1, width),
            (257, 4, 1, height),
            (258, 3, 1, 8),
            (259, 3, 1, 1),
            (262, 3, 1, 4 if mask else 1),
            (273, 4, 1 if mask else 2, mask_offset if mask else offsets),
            (277, 3, 1, 1),
            (278, 4, 1, height if mask else height // 2),
            (279, 4, 1 if mask else 2, width * height if mask else counts),
        ]
        return (
            struct.pack("<H", entry_count)
            + b"".join(struct.pack("<HHII", *tag) for tag in tags)
            + struct.pack("<I", 0 if mask else mask_ifd)
        )

    values = np.arange(64, dtype="uint8").reshape(8, 8)
    validity = np.full((8, 8), 255, dtype="uint8")
    validity[3:5, 3:5] = 0
    path = tmp_path / "different-blocks.tif"
    path.write_bytes(
        b"II"
        + struct.pack("<HI", 42, 8)
        + directory(False)
        + directory(True)
        + struct.pack("<IIII", data_offset, data_offset + 32, 32, 32)
        + values.tobytes()
        + validity.tobytes()
    )
    with (
        pytest.warns(rasterio.errors.NotGeoreferencedWarning),
        rasterio.open(path) as source,
    ):
        source_contract.require_signed_raster_dependencies(source, path)
        source_contract.require_bounded_source_structure(source)
        assert source.block_shapes == [(4, 8)]
        assert source_contract.internal_mask_block_shape(source) == (8, 8)
        assert source_contract.source_work_for_blocks(source, ((0, 0), (1, 0))) == (
            4,
            256,
        )
        sample = source_contract.read_native_raster_window(source, Window(0, 3, 8, 2))
        assert np.array_equal(~np.ma.getmaskarray(sample), validity[3:5] != 0)
        assert sample.compressed().tolist() == values[3:5][validity[3:5] != 0].tolist()


def write_masked_raster(
    path: Path,
    values: np.ndarray,
    validity: np.ndarray,
    nodata: float | None = None,
    overviews: Literal["none", "average", "stale"] = "none",
) -> Path:
    """Write original values and embedded validity, optionally with stale overviews.

    Args:
        path: Fixture file to create.
        values: Two-dimensional numeric values.
        validity: Equally shaped boolean validity.
        nodata: Optional band NoData declaration.
        overviews: Build averages after the mask, or before any exclusions.

    Returns:
        Closed, self-contained GeoTIFF path.
    """
    with (
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True),
        rasterio.open(
            path,
            "w",
            driver="GTiff",
            count=1,
            width=values.shape[1],
            height=values.shape[0],
            dtype=values.dtype,
            nodata=nodata,
            transform=from_origin(-2, 2, 4 / values.shape[1], 4 / values.shape[0]),
            crs="EPSG:4326",
            tiled=True,
            blockxsize=32,
            blockysize=32,
        ) as target,
    ):
        target.write(values, 1)
        if overviews == "stale":
            target.build_overviews([2, 4], Resampling.average)
        target.write_mask(validity.astype("uint8") * 255)
        if overviews == "average":
            target.build_overviews([2, 4], Resampling.average)
    return path


@pytest.mark.parametrize("nodata", [None, -9999.0, float("nan"), 0.0])
def test_exact_pixels_and_partial_blocks_share_all_validity_exclusions(
    tmp_path: Path, nodata: float | None
) -> None:
    """Combine masks, NoData and nonfinite exclusions without losing valid zero.

    Args:
        tmp_path: Native fixture directory.
        nodata: Exercise absent, finite, NaN and explicit zero NoData.
    """
    values = np.arange(35 * 37, dtype="float32").reshape(35, 37)
    values[0, :5] = [0, 99, -9999, np.nan, np.inf]
    validity = np.ones(values.shape, dtype=bool)
    validity[0, 1] = False
    validity[15:20, 29:34] = False
    expected = validity & np.isfinite(values)
    if nodata is not None:
        expected &= values != nodata
    path = write_masked_raster(tmp_path / "masked.tif", values, validity, nodata)
    result = read_raster_statistics(path, WholeRasterSamplingArea())
    assert result.valid_sample_count == int(expected.sum())
    assert (
        result.histogram.counts
        == np.histogram(values[expected], bins=np.array(result.histogram.edges))[
            0
        ].tolist()
    )
    for column in range(5):
        pixel = read_raster_pixel(path, -2 + (column + 0.5) * 4 / 37, 2 - 0.5 * 4 / 35)
        assert pixel.in_bounds
        assert pixel.value == (
            float(values[0, column]) if expected[0, column] else None
        )
    with rasterio.open(path) as source:
        plan = plan_exact_source_window(source, Window(30, 14, 7, 21))
        assert plan is not None
        sample = read_exact_source_window(source, plan)
        assert np.array_equal(~np.ma.getmaskarray(sample), expected[14:35, 30:37])
        assert np.array_equal(
            sample.compressed(), values[14:35, 30:37][expected[14:35, 30:37]]
        )
    assert describe_raster_data(path)["capabilities"]["statistics"]["supported"]


@pytest.mark.parametrize("overviews", ["none", "average", "stale"])
def test_sampled_continuous_categorical_and_paired_reads_keep_native_masks(
    tmp_path: Path, overviews: Literal["none", "average", "stale"]
) -> None:
    """Keep masked sample centers excluded regardless of overview content.

    Args:
        tmp_path: Native fixture directory.
        overviews: Missing, mask-aware average, or pre-mask overview pyramid.
    """
    values = (np.indices((600, 600)).sum(axis=0) % 3).astype("float32")
    validity = np.ones(values.shape, dtype=bool)
    validity[180:420, 180:420] = False
    values[300, 300] = np.nan
    path = write_masked_raster(
        tmp_path / "x.tif", values, validity, overviews=overviews
    )
    y_validity = validity.copy()
    y_validity[:150, :] = False
    y_path = write_masked_raster(
        tmp_path / "y.tif", values, y_validity, overviews=overviews
    )
    # Independent reference: the established 127-cell grid selects each cell's
    # original integer center, never a resampled category or overview mask.
    edges = np.floor(np.arange(128) * 600 / 127).astype(int)
    centers = edges[:-1] + (edges[1:] - edges[:-1]) // 2
    selected = values[np.ix_(centers, centers)]
    selected_valid = validity[np.ix_(centers, centers)] & np.isfinite(selected)
    with rasterio.open(path) as source:
        sampled, plan = sample_grid.read_source_window_sample_grid(
            source, Window(0, 0, 600, 600)
        )
        assert plan.width == plan.height == 127
        assert np.array_equal(~np.ma.getmaskarray(sampled), selected_valid)
        assert np.array_equal(sampled.compressed(), selected[selected_valid])
    continuous = read_raster_statistics(path, WholeRasterSamplingArea())
    assert continuous.valid_sample_count == int(selected_valid.sum())
    categorical = read_raster_categorical_statistics(
        path, WholeRasterSamplingArea(), category_values=(0, 1, 2)
    )
    assert categorical.valid_sample_count == int(selected_valid.sum())
    assert categorical.categorical_distribution.unmapped_area_hectares == 0
    paired = read_raster_paired_statistics(path, y_path, None)
    both = selected_valid & y_validity[np.ix_(centers, centers)]
    assert paired.paired_sample_count == int(both.sum())


def test_clip_output_can_be_summarized_and_clipped_again(tmp_path: Path) -> None:
    """Keep source exclusions and polygon holes through existing operation kernels.

    Args:
        tmp_path: Isolated native source and attempt directories.
    """
    values = np.arange(64, dtype="float32").reshape(8, 8)
    validity = np.ones((8, 8), dtype=bool)
    validity[0, 1] = False
    source = write_masked_raster(tmp_path / "source.tif", values, validity)
    polygon = {
        "type": "Polygon",
        "coordinates": [
            [[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]],
            [[-0.9, -0.9], [-0.9, 0.9], [0.9, 0.9], [0.9, -0.9], [-0.9, -0.9]],
        ],
    }
    selected = write_selection(tmp_path / "selected.gpkg", [polygon])
    area = ClipArea(
        kind="catalogSelection",
        bounds=(-2, -2, 2, 2),
        catalogSelection=selected.selection,
        resolved=selected,
    )
    attempt = tmp_path / "clip"
    attempt.mkdir()
    clip = create_clip(source, clip_spec(source, area), attempt, CLIP_LIMITS)
    # The hole touches its boundary cells; its four interior cells are excluded.
    expected = validity.copy()
    expected[3:5, 3:5] = False
    assert clip.valid_pixels == int(expected.sum()) == 59
    clipped = attempt / "result.tif"
    assert (
        read_raster_statistics(clipped, WholeRasterSamplingArea()).valid_sample_count
        == 59
    )
    summary_dir = tmp_path / "summary"
    summary_dir.mkdir()
    spec = summary_spec(clipped, ["count(a)", "sum(a)", "mean(a)"])
    summary = calculate_raster_statistics_for_area(
        clipped, spec, summary_dir, RasterAggregateLimits()
    )
    assert [float(row["value"]) for row in summary.rows] == pytest.approx(
        [59, values[expected].sum(), values[expected].mean()]
    )
    second_dir = tmp_path / "second"
    second_dir.mkdir()
    second = create_clip(clipped, clip_spec(clipped, area), second_dir, CLIP_LIMITS)
    assert second.valid_pixels == 59
    with rasterio.open(second_dir / "result.tif") as result:
        assert np.array_equal(result.read_masks(1) != 0, expected)
        assert result.read(1)[0, 0] == 0
    for directory in (attempt, summary_dir):
        assert (
            json.loads((directory / "provenance.json").read_text())["sourceValidity"]
            == source_contract.RASTER_VALIDITY_POLICY
        )


def test_mask_blocks_are_charged_before_reading_and_cancellation_is_preserved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Charge independent mask blocks and reject excessive work before pixel I/O.

    Args:
        tmp_path: Native fixture directory.
        monkeypatch: Tighten work limits and provide alternative mask block metadata.
    """
    path = write_masked_raster(
        tmp_path / "work.tif",
        np.ones((35, 37), dtype="uint8"),
        np.ones((35, 37), dtype=bool),
    )
    with rasterio.open(path) as source:
        assert source_contract.internal_mask_block_shape(source) == (32, 32)
        assert source_contract.source_work_for_blocks(source, ((1, 1),)) == (
            2,
            32 * 32 * 3,
        )
        plan = plan_exact_source_window(source, Window(0, 0, 35, 35))
        assert plan is not None
        with pytest.raises(RasterReadCancelled):
            read_exact_source_window(source, plan, lambda: True)
        monkeypatch.setattr(exact_source, "EXACT_SOURCE_MAX_BLOCK_READS", 4)
        assert plan_exact_source_window(source, Window(0, 0, 35, 35)) is None
        monkeypatch.setattr(
            source_contract, "internal_mask_block_shape", lambda _: (16, 16)
        )
        assert source_contract.source_work_for_blocks(source, ((0, 0),)) == (
            5,
            32 * 32 * 3,
        )
        assert count_native_raster_blocks(source, Window(0, 0, 35, 35)) == 4
        monkeypatch.setattr(
            source_contract, "internal_mask_block_shape", lambda _: (8192, 8192)
        )
        with pytest.raises(ValueError, match="mask blocks.*memory limit"):
            source_contract.require_bounded_source_structure(source)


def test_unsigned_external_mask_is_rejected_and_all_masked_data_stays_empty(
    tmp_path: Path,
) -> None:
    """Keep sidecar authorization and no-valid-data failures at their existing boundaries.

    Args:
        tmp_path: Native fixture directory.
    """
    values = np.ones((32, 32), dtype="uint8")
    path = write_masked_raster(
        tmp_path / "empty.tif", values, np.zeros(values.shape, dtype=bool)
    )
    with pytest.raises(NoValidRasterSamplesError):
        read_raster_statistics(path, WholeRasterSamplingArea())
    external = tmp_path / "external.tif"
    with (
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=False),
        rasterio.open(
            external,
            "w",
            driver="GTiff",
            width=32,
            height=32,
            count=1,
            dtype="uint8",
            crs="EPSG:4326",
            transform=from_origin(0, 1, 0.01, 0.01),
        ) as target,
    ):
        target.write(values, 1)
        target.write_mask(values * 255)
    assert Path(str(external) + ".msk").exists()
    with pytest.raises(ValueError, match="sidecars"):
        read_raster_statistics(external, WholeRasterSamplingArea())
