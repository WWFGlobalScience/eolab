"""Prepare real raster sources on one grid without changing their originals."""

from pathlib import Path

import numpy
import pytest
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from rasterio.transform import from_origin

from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.raster_preparation import (
    calculate_raster_grid,
    prepare_raster_stack,
)
from raster_fixture_support import write_source

LIMITS = RasterAggregateLimits()
PROJECTED = CRS.from_epsg(3857)


@pytest.mark.parametrize(
    "bounds,pixel_size,origin,expected_transform,expected_shape",
    [
        (
            (250, 150, 2250, 1250),
            (1000, 500),
            (0, 0),
            from_origin(0, 1500, 1000, 500),
            (3, 3),
        ),
        (
            (125, 1350, 1625, 2350),
            (500, 250),
            (125, 2350),
            from_origin(125, 2350, 500, 250),
            (4, 3),
        ),
        (
            (17.3 + 2 * 0.1, 18.7 - 9 * 0.1, 17.3 + 7 * 0.1, 18.7 - 3 * 0.1),
            (0.1, 0.1),
            (17.3, 18.7),
            from_origin(17.5, 18.4, 0.1, 0.1),
            (6, 5),
        ),
    ],
)
def test_grid_covers_aoi_and_preserves_requested_alignment(
    bounds: tuple[float, float, float, float],
    pixel_size: tuple[float, float],
    origin: tuple[float, float],
    expected_transform: Affine,
    expected_shape: tuple[int, int],
) -> None:
    """Snap custom bounds outward or retain an already aligned source grid.

    Args:
        bounds: AOI bounds in the target CRS.
        pixel_size: Requested positive X and Y spacing.
        origin: An intersection of the requested grid lines.
        expected_transform: Independently specified output pixel alignment.
        expected_shape: Expected height and width covering the AOI.
    """
    grid = calculate_raster_grid(bounds, PROJECTED, pixel_size, origin)
    assert grid.crs == PROJECTED
    assert grid.transform == expected_transform
    assert (grid.height, grid.width) == expected_shape


def test_different_source_grids_share_the_aoi_without_cropping_to_overlap(
    tmp_path: Path,
) -> None:
    """Keep named sources on one AOI grid across differing CRS and coverage.

    Args:
        tmp_path: Original rasters and a separate calculation attempt.
    """
    projected = write_source(
        tmp_path / "projected.tif",
        numpy.full((3, 3), 7, dtype="int16"),
        transform=from_origin(-500, 4500, 2000, 2000),
        crs="EPSG:3857",
    )
    geographic = write_source(
        tmp_path / "geographic.tif",
        numpy.full((4, 2), 11, dtype="int16"),
        transform=from_origin(0.01, 0.04, 0.01, 0.01),
    )
    originals = {path: path.read_bytes() for path in (projected, geographic)}
    grid = calculate_raster_grid((0, 0, 4000, 4000), PROJECTED, (1000, 1000), (0, 0))
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    inputs = {
        "coarse predictor": (projected, Resampling.nearest),
        "geographic response": (geographic, Resampling.nearest),
    }
    with prepare_raster_stack(
        inputs, grid, (), attempt, LIMITS, all_touched=False
    ) as paths:
        assert set(paths) == set(inputs)
        assert len(set(paths.values())) == 2
        for name, path in paths.items():
            assert path.is_relative_to(attempt)
            with rasterio.open(path) as prepared:
                assert prepared.crs == grid.crs
                assert prepared.transform == grid.transform
                assert prepared.shape == (4, 4)
                assert prepared.scales == (2,)
                assert prepared.offsets == (-1,)
                assert prepared.units == ("m",)
                values = prepared.read(1, masked=True)
                if name == "coarse predictor":
                    assert values.count() == 16
                    numpy.testing.assert_array_equal(values, numpy.full((4, 4), 7))
                else:
                    numpy.testing.assert_array_equal(
                        numpy.ma.getmaskarray(values),
                        numpy.tile([True, False, False, True], (4, 1)),
                    )
                    numpy.testing.assert_array_equal(
                        values.compressed(), numpy.full(8, 11)
                    )
    assert all(not path.exists() for path in paths.values())
    assert all(path.read_bytes() == contents for path, contents in originals.items())


def test_each_input_uses_its_requested_resampling(tmp_path: Path) -> None:
    """Compare nearest and bilinear samples at known positions within a ramp.

    Args:
        tmp_path: Source raster and calculation attempt.
    """
    values = numpy.arange(4)[:, None] * 10 + numpy.arange(4)[None, :]
    source = write_source(
        tmp_path / "ramp.tif",
        values.astype("int16"),
        transform=from_origin(0, 4000, 1000, 1000),
        crs="EPSG:3857",
    )
    grid = calculate_raster_grid(
        (250, 750, 3250, 3750), PROJECTED, (1000, 1000), (250, 3750)
    )
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    with prepare_raster_stack(
        {
            "category": (source, Resampling.nearest),
            "continuous": (source, Resampling.bilinear),
        },
        grid,
        (),
        attempt,
        LIMITS,
        all_touched=False,
    ) as paths:
        with rasterio.open(paths["category"]) as category:
            numpy.testing.assert_array_equal(category.read(1), values[:3, :3])
        with rasterio.open(paths["continuous"]) as continuous:
            numpy.testing.assert_allclose(continuous.read(1), values[:3, :3] + 2.75)


@pytest.mark.parametrize("mosaic", [False, True])
def test_masks_nodata_and_missing_coverage_are_excluded_from_resampling(
    tmp_path: Path,
    mosaic: bool,
) -> None:
    """Preserve valid zero while excluding both source masks and NoData values.

    Args:
        tmp_path: Partly invalid and disjoint sources plus the attempt directory.
        mosaic: Read the masked input through a VRT containing two source regions.
    """
    values = numpy.full((4, 4), 10, dtype="float32")
    values[0, 0] = 0
    values[1, 1] = -9999
    values[2, 2] = 99999
    values[3, 3] = numpy.nan
    values[0, 3] = numpy.inf
    values[3, 0] = -numpy.inf
    source = write_source(
        tmp_path / "masked.tif",
        values,
        nodata=-9999,
        transform=from_origin(0, 4, 1, 1),
        crs="EPSG:3857",
    )
    validity = numpy.full((4, 4), 255, dtype="uint8")
    validity[2, 2] = 0
    with (
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True),
        rasterio.open(source, "r+") as dataset,
    ):
        dataset.write_mask(validity)
    if mosaic:
        source = tmp_path / "mosaic.vrt"
        regions = "".join(f"""<ComplexSource>
                <SourceFilename relativeToVRT="1">masked.tif</SourceFilename>
                <SourceBand>1</SourceBand>
                <SrcRect xOff="{column}" yOff="0" xSize="2" ySize="4"/>
                <DstRect xOff="{column}" yOff="0" xSize="2" ySize="4"/>
                <NODATA>-9999</NODATA>
            </ComplexSource>""" for column in (0, 2))
        source.write_text(
            f"""<VRTDataset rasterXSize="4" rasterYSize="4">
                <SRS>EPSG:3857</SRS><GeoTransform>0,1,0,4,0,-1</GeoTransform>
                <VRTRasterBand dataType="Float32" band="1">
                    <NoDataValue>-9999</NoDataValue>{regions}
                </VRTRasterBand>
                <MaskBand><VRTRasterBand dataType="Byte">
                    <SimpleSource>
                        <SourceFilename relativeToVRT="1">masked.tif</SourceFilename>
                        <SourceBand>mask,1</SourceBand>
                    </SimpleSource>
                </VRTRasterBand></MaskBand>
            </VRTDataset>""",
            encoding="utf-8",
        )
    disjoint = write_source(
        tmp_path / "disjoint.tif",
        numpy.full((4, 4), 91, dtype="float32"),
        transform=from_origin(100, 104, 1, 1),
        crs="EPSG:3857",
    )
    originals = {
        path: path.read_bytes() for path in (tmp_path / "masked.tif", source, disjoint)
    }
    grid = calculate_raster_grid((0, 0, 4, 4), PROJECTED, (0.5, 0.5), (0, 0))
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    with prepare_raster_stack(
        {
            "nearest": (source, Resampling.nearest),
            "bilinear": (source, Resampling.bilinear),
            "outside": (disjoint, Resampling.nearest),
        },
        grid,
        (),
        attempt,
        LIMITS,
        all_touched=False,
    ) as paths:
        expected_validity = (validity != 0) & (values != -9999) & numpy.isfinite(values)
        expected_validity = expected_validity.repeat(2, axis=0).repeat(2, axis=1)
        with rasterio.open(paths["nearest"]) as nearest:
            result = nearest.read(1, masked=True)
            numpy.testing.assert_array_equal(
                ~numpy.ma.getmaskarray(result), expected_validity
            )
            assert result[0, 0] == 0
            assert result.count() == 44
        with rasterio.open(paths["bilinear"]) as bilinear:
            result = bilinear.read(1, masked=True)
            assert result.count() > 0
            assert result.min() >= 0
            assert result.max() <= 10
            assert not numpy.ma.getmaskarray(result)[5, 6]
            assert result[5, 6] == 10
            assert result[1, 5] == 10
            assert result[5, 1] == 10
        with rasterio.open(paths["outside"]) as outside:
            assert outside.read(1, masked=True).count() == 0
    assert all(path.read_bytes() == contents for path, contents in originals.items())


@pytest.mark.parametrize("all_touched", [False, True])
def test_polygon_holes_follow_the_callers_pixel_inclusion_rule(
    tmp_path: Path, all_touched: bool
) -> None:
    """Apply the exact projected AOI after warping without filling its holes.

    Args:
        tmp_path: Raster and attempt storage.
        all_touched: Include intersected pixels or only pixels whose centers lie inside.
    """
    transform = from_origin(0, 4, 1, 1)
    source = write_source(
        tmp_path / "source.tif",
        numpy.arange(16, dtype="int16").reshape(4, 4),
        transform=transform,
        crs="EPSG:3857",
    )
    polygons = (
        {
            "type": "Polygon",
            "coordinates": [
                [(0.2, 0.2), (3.2, 0.2), (3.2, 3.2), (0.2, 3.2), (0.2, 0.2)],
                [(0.9, 0.9), (0.9, 2.1), (2.1, 2.1), (2.1, 0.9), (0.9, 0.9)],
            ],
        },
    )
    expected_mask = geometry_mask(polygons, (4, 4), transform, all_touched=all_touched)
    grid = calculate_raster_grid((0.2, 0.2, 3.2, 3.2), PROJECTED, (1, 1), (0, 0))
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    with prepare_raster_stack(
        {"values": (source, Resampling.nearest)},
        grid,
        polygons,
        attempt,
        LIMITS,
        all_touched=all_touched,
    ) as paths:
        with rasterio.open(paths["values"]) as prepared:
            result = prepared.read(1, masked=True)
            numpy.testing.assert_array_equal(
                numpy.ma.getmaskarray(result), expected_mask
            )
            assert result.count() == (15 if all_touched else 8)
    assert not list(attempt.rglob("*.tif"))


@pytest.mark.parametrize("failure", ["consumer", "source"])
def test_failed_preparation_or_consumer_removes_only_owned_files(
    tmp_path: Path, failure: str
) -> None:
    """Clean temporary rasters on errors without deleting other attempt artifacts.

    Args:
        tmp_path: Original source and the calculation attempt directory.
        failure: Raise in the consumer or fail while opening the second source.
    """
    source = write_source(
        tmp_path / "source.tif",
        numpy.ones((4, 4), dtype="float32"),
        transform=from_origin(0, 4, 1, 1),
        crs="EPSG:3857",
    )
    original = source.read_bytes()
    grid = calculate_raster_grid((0, 0, 4, 4), PROJECTED, (1, 1), (0, 0))
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    sibling = attempt / "other-output.txt"
    sibling.write_text("owned by the caller")
    inputs = {"first": (source, Resampling.nearest)}
    if failure == "source":
        inputs["missing"] = (tmp_path / "missing.tif", Resampling.nearest)
    with pytest.raises(
        RuntimeError if failure == "consumer" else rasterio.errors.RasterioIOError
    ):
        with prepare_raster_stack(
            inputs, grid, (), attempt, LIMITS, all_touched=False
        ) as paths:
            assert all(path.exists() for path in paths.values())
            raise RuntimeError("consumer stopped")
    assert sibling.read_text() == "owned by the caller"
    assert not list(attempt.rglob("*.tif"))
    assert not [path for path in attempt.iterdir() if path.is_dir()]
    assert source.read_bytes() == original
