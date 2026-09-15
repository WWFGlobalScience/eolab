"""Regressions for geographic coverage across longitude wrapping."""

from pathlib import Path

import numpy as np
import pytest
import rasterio
from pyproj import Transformer
from affine import Affine
from rasterio.crs import CRS
from rasterio.transform import from_bounds
from rasterio.warp import transform_bounds

from eolab_app.catalog.geotiff import build_stac_item
from eolab_app.raster.geographic_bounds import (
    normalize_wgs84_bounds,
    transform_bounds_to_wgs84,
)
from eolab_app.raster.paired_statistics import read_raster_paired_statistics
from eolab_app.raster.pixel import read_raster_pixel

WORLD_EDGE = 20037508.342789244


@pytest.mark.parametrize("pixel_size", [55660.0, 2 * WORLD_EDGE / 720])
def test_global_mercator_catalog_covers_readable_pixels(
    tmp_path: Path, pixel_size: float
) -> None:
    """Keep exact and rounded global grids searchable at a valid pixel.

    Args:
        tmp_path: Isolated raster directory.
        pixel_size: Source grid spacing, exact or rounded beyond the date line.
    """
    path = tmp_path / "global.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=720,
        height=720,
        count=1,
        dtype="float32",
        crs="EPSG:3857",
        transform=Affine(pixel_size, 0, -WORLD_EDGE, 0, -pixel_size, WORLD_EDGE),
        tiled=True,
        compress="DEFLATE",
        nodata=-9999,
    ) as dataset:
        dataset.write(np.full((720, 720), 2.55, dtype="float32"), 1)

    item = build_stac_item(tmp_path, path)
    west, south, east, north = item["bbox"]
    assert (west, east) == pytest.approx((-180, 180))
    assert west < -87.44567871093751 < east
    assert south < 36.798288873837045 < north
    assert item["geometry"]["coordinates"][0][1][0] == pytest.approx(180)
    pixel = read_raster_pixel(path, -87.44567871093751, 36.798288873837045)
    assert pixel.in_bounds
    assert pixel.value == pytest.approx(2.55)


@pytest.mark.parametrize(
    ("source_bounds", "expected"),
    [
        ((-180, -85, 180.002, 85), (-180, -85, 180, 85)),
        ((-180.002, -91, 180.002, 91), (-180, -90, 180, 90)),
        ((0, -80, 360, 80), (-180, -80, 180, 80)),
        ((270, -10, 280, 10), (-90, -10, -80, 10)),
        ((-200, -10, -190, 10), (160, -10, 170, 10)),
        ((170, -10, 190, 10), (-180, -10, 180, 10)),
        ((-190, -10, -170, 10), (-180, -10, 180, 10)),
        ((170, -10, -170, 10), (-180, -10, 180, 10)),
        ((-100, 30, -80, 40), (-100, 30, -80, 40)),
    ],
)
def test_geographic_longitude_intervals(
    source_bounds: tuple[float, float, float, float],
    expected: tuple[float, float, float, float],
) -> None:
    """Normalize coverage rather than clipping away wrapped longitudes.

    Args:
        source_bounds: Geographic interval before longitude normalization.
        expected: Conservative canonical envelope.
    """
    assert normalize_wgs84_bounds(source_bounds) == pytest.approx(expected)


@pytest.mark.parametrize("crs", ["EPSG:3857", "EPSG:32616", "EPSG:5070", "EPSG:4326"])
def test_regional_projection_bounds_are_preserved(crs: str) -> None:
    """Keep ordinary regional coverage when enabling PROJ's wrapping control.

    Args:
        crs: Geographic or projected source coordinate system.
    """
    source = CRS.from_user_input(crs)
    native = transform_bounds("EPSG:4326", source, -88, 35, -86, 37)
    expected = transform_bounds(source, "EPSG:4326", *native)
    actual = normalize_wgs84_bounds(transform_bounds_to_wgs84(source, native))
    assert actual == pytest.approx(expected)


@pytest.mark.parametrize(
    "bounds",
    [
        (float("inf"), 0, 10, 10),
        (0, 0, float("nan"), 10),
        (0, 0, 0, 10),
        (0, 20, 10, 10),
        (0, 91, 10, 95),
    ],
)
def test_invalid_geographic_envelopes_are_rejected(
    bounds: tuple[float, float, float, float],
) -> None:
    """Reject unusable geographic output at the normalization boundary.

    Args:
        bounds: Nonfinite, empty or invalid-latitude output.
    """
    with pytest.raises(ValueError):
        normalize_wgs84_bounds(bounds)


@pytest.mark.parametrize("swap", [False, True])
@pytest.mark.parametrize("selected", [None, (-88.0, 36.0, -87.0, 37.0)])
def test_global_mercator_pairs_with_regional_raster(
    tmp_path: Path,
    swap: bool,
    selected: tuple[float, float, float, float] | None,
) -> None:
    """Pair readable pixels in both orientations despite the global overshoot.

    Args:
        tmp_path: Isolated raster directory.
        swap: Whether the coarse global raster is the Y source.
        selected: Optional sampling box; None requests whole overlap.
    """
    global_path, regional_path = tmp_path / "global.tif", tmp_path / "regional.tif"
    for path, size, crs, affine, value in [
        (
            global_path,
            720,
            "EPSG:3857",
            Affine(55660, 0, -WORLD_EDGE, 0, -55660, WORLD_EDGE),
            2.55,
        ),
        (regional_path, 40, "EPSG:4326", from_bounds(-90, 34, -84, 40, 40, 40), 7.0),
    ]:
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            width=size,
            height=size,
            count=1,
            dtype="float32",
            crs=crs,
            transform=affine,
            tiled=True,
            compress="DEFLATE",
            nodata=-9999,
        ) as dataset:
            dataset.write(np.full((size, size), value, dtype="float32"), 1)
    x_path, y_path = (
        (regional_path, global_path) if swap else (global_path, regional_path)
    )
    result = read_raster_paired_statistics(x_path, y_path, selected)
    assert 0 < result.paired_sample_count <= 127 * 127
    assert result.x_minimum == pytest.approx(7.0 if swap else 2.55)
    assert result.y_minimum == pytest.approx(2.55 if swap else 7.0)
    assert sum(result.histogram.x_marginal_counts) == result.paired_sample_count


@pytest.mark.parametrize(
    "crs",
    [
        "EPSG:4326",
        "EPSG:3857",
        "EPSG:3395",
        "EPSG:4087",
        "+proj=merc +lon_0=30 +datum=WGS84 +units=m",
    ],
)
def test_global_coverage_uses_projection_method_not_epsg_number(crs: str) -> None:
    """Preserve full longitude coverage across supported cylindrical systems.

    Args:
        crs: Geographic, standard cylindrical or custom Mercator source CRS.
    """
    source = CRS.from_user_input(crs)
    native = Transformer.from_crs(
        "EPSG:4326", source, always_xy=True, force_over=True
    ).transform_bounds(-180, -70, 180.01, 70)
    bounds = normalize_wgs84_bounds(transform_bounds_to_wgs84(source, native))
    assert bounds == pytest.approx((-180, -70, 180, 70))
