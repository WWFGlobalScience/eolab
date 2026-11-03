"""Disk-backed masks preserve the grid, bound storage and follow job cleanup."""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

from affine import Affine
import numpy as np
import pytest
import rasterio
from rasterio.features import geometry_mask
from rasterio.windows import Window, transform as window_transform
from shapely.geometry import Polygon, box, mapping
from shapely.ops import transform as transform_geometry

import eolab_app.processing.raster_mask as masks
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.job_preparation import prepare_aggregate_job
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.raster.read_cancellation import RasterReadCancelled
from raster_aggregate_support import make_spec
from raster_fixture_support import write_source


@pytest.mark.parametrize("rotated", [False, True])
def test_file_mask_matches_full_grid_and_window_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, rotated: bool
) -> None:
    """Rasterize holes/overlaps once to disk and preserve pixel-aligned reads.

    Args:
        tmp_path: Isolated source and scratch storage.
        monkeypatch: Observe the real direct-to-file rasterization call.
        rotated: Exercise both north-up and rotated source grids.
    """
    affine = (
        Affine.translation(100, 200)
        * Affine.rotation(12 if rotated else 0)
        * Affine.scale(2, -2)
    )
    source = write_source(
        tmp_path / "source.tif",
        np.ones((64, 64), dtype="uint8"),
        transform=affine,
        crs="EPSG:3857",
    )
    window = Window(3, 5, 35, 27)
    pixel_polygons = [
        Polygon(
            [(5, 6), (30, 8), (29, 29), (5, 26)],
            [[(10, 10), (15, 10), (15, 15), (10, 15)]],
        ),
        box(22, 12, 36, 22),
    ]
    polygons = tuple(
        mapping(transform_geometry(lambda x, y, z=None: affine * (x, y), geometry))
        for geometry in pixel_polygons
    )
    actual_rasterize = masks.rasterize
    calls = []

    def observe(*args: Any, **kwargs: Any) -> None:
        """Verify file output instead of a full in-memory array.

        Args:
            args: Projected polygons.
            kwargs: Output raster options.
        """
        calls.append(kwargs)
        assert kwargs["dst_path"] == tmp_path / "polygon-mask.tif"
        assert "out_shape" not in kwargs and "out" not in kwargs
        actual_rasterize(*args, **kwargs)

    monkeypatch.setattr(masks, "rasterize", observe)
    with rasterio.open(source) as dataset:
        expected = geometry_mask(
            polygons,
            out_shape=(27, 35),
            transform=window_transform(window, affine),
            invert=True,
            all_touched=False,
        )
        with masks.temporary_polygon_mask(
            dataset, window, polygons, tmp_path, RasterAggregateLimits()
        ) as mask:
            assert mask is not None and mask.is_tiled
            assert mask.crs == dataset.crs
            assert mask.transform == window_transform(window, affine)
            assert mask.dtypes == ("uint8",)
            np.testing.assert_array_equal(mask.read(1), expected)
            np.testing.assert_array_equal(
                mask.read(1, window=Window(7, 9, 10, 11)), expected[9:20, 7:17]
            )
            assert Path(mask.name).stat().st_size > 0
        assert not (tmp_path / "polygon-mask.tif").exists()
    assert len(calls) == 1


@pytest.mark.parametrize("failure", [OSError, RasterReadCancelled])
def test_partial_mask_is_removed_on_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: type[Exception]
) -> None:
    """Even a failed or cancelled native rasterization leaves no partial mask.

    Args:
        tmp_path: Isolated source and scratch.
        monkeypatch: Fail after creating a partial file.
        failure: I/O failure or cooperative cancellation.
    """
    source = write_source(tmp_path / "source.tif", np.ones((8, 8), dtype="uint8"))

    def fail(*args: Any, **kwargs: Any) -> None:
        """Create a partial mask then raise the requested failure.

        Args:
            args: Unused geometries.
            kwargs: Includes the confined destination path.

        Raises:
            Exception: The injected I/O or cancellation error.
        """
        kwargs["dst_path"].write_bytes(b"partial")
        raise failure("injected")

    monkeypatch.setattr(masks, "rasterize", fail)
    with rasterio.open(source) as dataset, pytest.raises(failure):
        with masks.temporary_polygon_mask(
            dataset,
            Window(0, 0, 8, 8),
            (mapping(box(0, 0, 1, 1)),),
            tmp_path,
            RasterAggregateLimits(),
        ):
            pytest.fail("a failed mask must not be yielded")
    assert not (tmp_path / "polygon-mask.tif").exists()


def test_polygon_mask_writes_without_disk_estimates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Write and clean the mask without a free-space query or prior reservation.

    Args:
        tmp_path: Isolated raster and attempt storage.
        monkeypatch: Rejects disk admission queries.
    """
    import shutil

    def forbidden(path: object) -> None:
        """Reject disk preflight checks.

        Args:
            path: Unused volume path.
        """
        pytest.fail("Mask creation must not estimate available disk space")

    monkeypatch.setattr(shutil, "disk_usage", forbidden)
    source = write_source(tmp_path / "source.tif", np.ones((8, 8), dtype="uint8"))
    with rasterio.open(source) as dataset:
        area = AggregateArea(kind="bounds", bounds=tuple(dataset.bounds))
        plan = make_spec(source, ["sum(a)"], area)
        assert prepare_aggregate_job(plan, RasterAggregateLimits()).reserved_bytes == 0
        with masks.temporary_polygon_mask(
            dataset,
            Window(0, 0, 8, 8),
            (mapping(box(*dataset.bounds)),),
            tmp_path,
            RasterAggregateLimits(),
        ) as mask:
            assert mask is not None
            assert np.all(mask.read(1) == 1)
    assert not (tmp_path / "polygon-mask.tif").exists()
