"""Native-grid numerical, geographic, provenance, and work-budget boundaries."""

from dataclasses import replace
import csv
import json
import statistics
from pathlib import Path
from unittest.mock import Mock

from affine import Affine
import numpy as np
import pytest
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin, xy

from eolab_app.processing.aggregate_models import (
    AggregateArea,
    NamedCalculation,
    PixelPoint,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.polygon_areas import PolygonSummaryInput
from eolab_app.processing.raster_aggregate import calculate_raster_statistics_for_area
import eolab_app.processing.raster_aggregate as kernel
from eolab_app.bounded_vector import pixels_inside_area
from raster_fixture_support import write_source
from catalog_selection_support import write_aggregate_area
from raster_aggregate_support import LIMITS, make_spec


@pytest.mark.parametrize("block_side", [16, 32, 64])
@pytest.mark.parametrize("target_chunk_pixels", [None, 256, 4096])
@pytest.mark.parametrize(
    "area_kind", ["wholeRaster", "bounds", "polygons", "catalogSelection"]
)
def test_stdev_native_masks_selections_blocks_csv_and_provenance(
    tmp_path: Path,
    block_side: int,
    target_chunk_pixels: int | None,
    area_kind: str,
) -> None:
    """Real native reads preserve population semantics across block/batch layouts.

    Args:
        tmp_path: Private native source and artifacts.
        block_side: GeoTIFF block shape, independent of evaluation tiling.
        target_chunk_pixels: Optional Processing read/evaluation batch budget.
        area_kind: Whole extent, map box, uploaded polygons or a catalog selection
            containing a hole.
    """
    values = 1e12 + np.arange(65 * 73, dtype="float64").reshape(65, 73) % 29
    values[12, 15] = -9999
    values[13, 16] = np.nan
    values[14, 17] = np.inf
    values[15, 18] = -9999
    valid = np.isfinite(values) & (values != -9999)
    transform = from_origin(0, 10, 0.01, 0.01)
    path = tmp_path / "source.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=73,
        height=65,
        count=1,
        dtype="float64",
        crs="EPSG:4326",
        transform=transform,
        nodata=-9999,
        tiled=True,
        blockxsize=block_side,
        blockysize=block_side,
    ) as dataset:
        dataset.write(values, 1)
    bounds = (0.101, 9.401, 0.599, 9.899)
    inside = np.ones(values.shape, dtype=bool)
    if area_kind != "wholeRaster":
        inside[:] = False
        inside[10:60, 10:60] = True
    if area_kind in {"polygons", "catalogSelection"}:
        geometry = {
            "type": "Polygon",
            "coordinates": [
                [
                    [0.101, 9.401],
                    [0.599, 9.401],
                    [0.599, 9.899],
                    [0.101, 9.899],
                    [0.101, 9.401],
                ],
                [
                    [0.201, 9.701],
                    [0.201, 9.799],
                    [0.299, 9.799],
                    [0.299, 9.701],
                    [0.201, 9.701],
                ],
            ],
        }
        if area_kind == "catalogSelection":
            inside[20:30, 20:30] = False
            area = write_aggregate_area(tmp_path / "selected.gpkg", [geometry])
        else:
            geometry["coordinates"] = geometry["coordinates"][:1]
            polygons = PolygonSummaryInput(polygons=(geometry,))
            area = AggregateArea(
                kind="polygons",
                bounds=polygons.bounds(),
                geometryHash=polygons.geometry_hash(),
                geometries=(geometry,),
            )
    else:
        area = AggregateArea(
            kind=area_kind, bounds=bounds if area_kind == "bounds" else None
        )
    expressions = ["stdev(a)", "stdev(a * 2 - 1, where=a < 1000000000010)"]
    spec = make_spec(path, expressions, area, target_chunk_pixels=target_chunk_pixels)
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    expected_values = values[valid & inside]
    expected = [
        statistics.pstdev(expected_values.tolist()),
        statistics.pstdev(
            (expected_values[expected_values < 1000000000010] * 2 - 1).tolist()
        ),
    ]
    for row, reference in zip(artifact.rows, expected, strict=True):
        assert row["state"] == "ok"
        assert row["valueType"] == "float"
        assert float(row["value"]) == pytest.approx(reference, rel=2e-13)
        assert row["aggregates"][0]["validPixels"] == len(expected_values)
    with (tmp_path / "result.csv").open(newline="", encoding="utf-8") as stream:
        csv_rows = list(csv.DictReader(stream))
    assert [row["expression"] for row in csv_rows] == expressions
    assert [float(row["value"]) for row in csv_rows] == pytest.approx(expected)
    provenance = json.loads((tmp_path / "provenance.json").read_text())
    assert provenance["rows"] == artifact.rows
    assert provenance["area"]["kind"] == area_kind
    assert provenance["functionInclusion"]["numeric"] == "cell_center"


@pytest.mark.parametrize(
    "transform,crs",
    [
        (from_origin(0, 10, 0.01, 0.01), "EPSG:4326"),
        (from_origin(0, 1_000_000, 1000, 1000), "EPSG:3857"),
        (Affine(0.01, 0.002, 0, 0.001, -0.01, 10), "EPSG:4326"),
    ],
)
def test_pixel_value_matches_exact_map_sample_with_one_cell_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    transform: Affine,
    crs: str,
) -> None:
    """Native point formulas share direct pixel values across different grids.

    Args:
        tmp_path: Private source and result files.
        monkeypatch: Observe the real bounded read rather than replace its result.
        transform: Native affine, including a rotated grid.
        crs: Native source coordinate reference system.
    """
    from rasterio.warp import transform as project
    from eolab_app.raster.pixel import read_raster_pixel

    values = np.arange(10_000, dtype="int16").reshape(100, 100)
    path = write_source(tmp_path / "pixel.tif", values, transform=transform, crs=crs)
    native_x, native_y = transform * (17.8, 22.6)
    longitude, latitude = project(crs, "EPSG:4326", [native_x], [native_y])
    point = PixelPoint(longitude=longitude[0], latitude=latitude[0])
    expected = read_raster_pixel(path, point.longitude, point.latitude)
    reads = []
    original = kernel.read_native_raster_window

    def observed(
        dataset: rasterio.io.DatasetReader, window: rasterio.windows.Window
    ) -> np.ma.MaskedArray:
        """Retain the admitted read dimensions while reading real stored values.

        Args:
            dataset: Authorized open native source.
            window: One admitted source read.

        Returns:
            The real native values with their nodata mask.
        """
        reads.append(tuple(window.flatten()))
        return original(dataset, window)

    monkeypatch.setattr(kernel, "read_native_raster_window", observed)
    spec = make_spec(path, ["pixelValue(a)"], pixel_point=point)
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert float(artifact.rows[0]["value"]) == expected.value == values[22, 17]
    assert reads == [(17, 22, 1, 1)]
    assert spec.grid.width == spec.grid.height == spec.grid.nativeBlocks == 1
    provenance = json.loads((tmp_path / "provenance.json").read_text())
    assert provenance["pixelPoint"] == point.model_dump()
    assert (
        provenance["functionInclusion"]["pixelValue"]
        == "cell_containing_selected_point"
    )


@pytest.mark.parametrize("sample", [-9999.0, float("nan"), float("inf")])
def test_pixel_value_reports_nodata_and_nonfinite_samples(
    tmp_path: Path,
    sample: float,
) -> None:
    """A missing selected cell remains missing despite valid surrounding cells.

    Args:
        tmp_path: Private source and result files.
        sample: Native nodata or nonfinite value at the selected point.
    """
    values = np.ones((10, 10), dtype="float64")
    values[5, 5] = sample
    path = write_source(tmp_path / "pixel.tif", values, nodata=-9999)
    spec = make_spec(
        path, ["pixelValue(a)"], pixel_point=PixelPoint(longitude=0.055, latitude=9.945)
    )
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert artifact.rows[0]["value"] is None
    assert artifact.rows[0]["state"] == "no_valid_data"
    assert artifact.rows[0]["aggregates"][0]["validPixels"] == 0


@pytest.mark.parametrize("longitude,latitude", [(2, 7), (0, 10), (10, 5), (5, 0)])
def test_pixel_value_preserves_direct_picker_cell_boundary_rules(
    tmp_path: Path,
    longitude: float,
    latitude: float,
) -> None:
    """Exact cell and outer boundaries match the established pixel inspector.

    Args:
        tmp_path: Private source and result files.
        longitude: WGS84 longitude on an exact grid boundary.
        latitude: WGS84 latitude on an exact grid boundary.
    """
    from eolab_app.raster.pixel import read_raster_pixel

    path = write_source(
        tmp_path / "pixel.tif",
        np.arange(100, dtype="int16").reshape(10, 10),
        transform=from_origin(0, 10, 1, 1),
    )
    point = PixelPoint(longitude=longitude, latitude=latitude)
    expected = read_raster_pixel(path, longitude, latitude)
    spec = make_spec(path, ["pixelValue(a)"], pixel_point=point)
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    actual = artifact.rows[0]["value"]
    assert (float(actual) if actual is not None else None) == expected.value


def test_outside_pixel_has_empty_grid_and_no_raster_reads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Out-of-raster point results stay missing without scanning the selected area.

    Args:
        tmp_path: Private source and result files.
        monkeypatch: Fail if execution attempts a pixel read.
    """
    path = write_source(tmp_path / "pixel.tif", np.ones((100, 100), dtype="uint8"))
    spec = make_spec(
        path,
        ["pixelValue(a)"],
        target_chunk_pixels=256,
        pixel_point=PixelPoint(longitude=40, latitude=40),
    )

    def unexpected(*args: object) -> np.ma.MaskedArray:
        """Reject a source read for an outside point.

        Args:
            args: Unused arguments identifying the forbidden read.

        Raises:
            AssertionError: Every call is unexpected.
        """
        raise AssertionError("An outside point must not read source pixels")

    monkeypatch.setattr(kernel, "read_native_raster_window", unexpected)
    monkeypatch.setattr(kernel, "read_native_raster_block", unexpected)
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert spec.grid.window == (0, 0, 0, 0)
    assert spec.grid.nativeBlocks == 0
    assert artifact.rows[0]["state"] == "no_valid_data"


def test_mixed_pixel_and_area_formulas_keep_independent_selection_and_limits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A selected pixel outside the area retains its value and admitted read work.

    Args:
        tmp_path: Private source and result files.
        monkeypatch: Count real native area and selected-pixel reads.
    """
    path = write_source(
        tmp_path / "mixed.tif", np.arange(10_000, dtype="int16").reshape(100, 100)
    )
    area = AggregateArea(kind="bounds", bounds=(0.001, 9.901, 0.099, 9.999))
    point = PixelPoint(longitude=0.755, latitude=9.245)
    spec = make_spec(
        path,
        ["pixelValue(a)", "mean(a)", "pixelValue(a)-mean(a)"],
        area,
        pixel_point=point,
    )
    point_reader = Mock(wraps=kernel.read_native_raster_window)
    area_reader = Mock(wraps=kernel.read_native_raster_block)
    monkeypatch.setattr(kernel, "read_native_raster_window", point_reader)
    monkeypatch.setattr(kernel, "read_native_raster_block", area_reader)
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert [float(row["value"]) for row in artifact.rows] == pytest.approx(
        [7575, 454.5, 7120.5]
    )
    assert point_reader.call_count == area_reader.call_count == 1
    assert spec.grid.nativeBlocks == 2
    assert artifact.rows[0]["aggregates"][0]["validPixels"] == 1
    assert artifact.rows[1]["aggregates"][0]["validPixels"] == 100
    area_only = make_spec(path, ["mean(a)"], area)


def test_outside_pixel_does_not_discard_independent_area_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Separate result rows preserve a valid mean when the sampled point misses.

    Args:
        tmp_path: Private source and result files.
        monkeypatch: Count real native area and selected-pixel reads.
    """
    path = write_source(
        tmp_path / "mixed.tif", np.arange(100, dtype="int16").reshape(10, 10)
    )
    spec = make_spec(
        path,
        ["pixelValue(a)", "mean(a)"],
        pixel_point=PixelPoint(longitude=40, latitude=40),
    )
    point_reader = Mock(wraps=kernel.read_native_raster_window)
    area_reader = Mock(wraps=kernel.read_native_raster_block)
    monkeypatch.setattr(kernel, "read_native_raster_window", point_reader)
    monkeypatch.setattr(kernel, "read_native_raster_block", area_reader)
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert artifact.rows[0]["state"] == "no_valid_data"
    assert float(artifact.rows[1]["value"]) == 49.5
    assert artifact.rows[1]["state"] == "ok"
    point_reader.assert_not_called()
    assert area_reader.call_count == spec.grid.nativeBlocks == 1


@pytest.mark.parametrize("whole_raster", [False, True])
@pytest.mark.parametrize("include_hectares", [False, True])
def test_prepared_area_tools_window_and_masks(
    tmp_path: Path, whole_raster: bool, include_hectares: bool
) -> None:
    """Return usable masks and the final window for numeric and hectare plans.

    Args:
        tmp_path: Directory for a real georeferenced raster fixture.
        whole_raster: Select every pixel instead of a fractional-boundary box.
        include_hectares: Include an area formula alongside the numeric sum.
    """
    path = write_source(
        tmp_path / "area-tools.tif",
        np.ones((10, 10), dtype="uint8"),
        transform=from_origin(0, 10, 1, 1),
    )
    area = (
        AggregateArea(kind="wholeRaster")
        if whole_raster
        else AggregateArea(kind="bounds", bounds=(2.25, 4.25, 5.75, 7.75))
    )
    with rasterio.open(path) as dataset:
        tools = kernel.prepare_raster_area_tools(
            dataset, area, LIMITS, measure_hectares=include_hectares
        )
        expected_window = (
            (0, 0, 10, 10)
            if whole_raster
            else ((2, 2, 4, 4) if include_hectares else (1, 1, 6, 6))
        )
        assert tuple(tools.raster_window.flatten()) == expected_window
        shape = (int(tools.raster_window.height), int(tools.raster_window.width))
        if whole_raster:
            assert tools.selected_polygons == ()
        else:
            mask = pixels_inside_area(
                tools.selected_polygons,
                out_shape=shape,
                transform=rasterio.windows.transform(
                    tools.raster_window, dataset.transform
                ),
                all_touched=False,
            )
            assert np.count_nonzero(mask) == 16
        if include_hectares:
            assert tools.pixel_area_calculator is not None
            hectares = tools.pixel_area_calculator.calculate_hectares(
                tools.raster_window
            )
            assert hectares.shape == shape
            assert np.all(hectares > 0)
        else:
            assert tools.pixel_area_calculator is None


def test_native_values_not_overviews_scale_or_histogram_statistics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Real overview-equipped TIFF still reduces every native valid value once.

    Args:
        tmp_path: Isolated native and artifact files.
        monkeypatch: Observe the bounded native-reader boundary.
    """
    values = np.arange(260 * 270, dtype="int32").reshape(260, 270)
    values[10:20, 10:20] = -9999
    path = write_source(tmp_path / "source.tif", values, nodata=-9999)
    with rasterio.open(path, "r+") as dataset:
        dataset.build_overviews([2, 4, 8], Resampling.average)
    spec = make_spec(
        path, ["sum(a)", "count(a>10)", "sum(a,where=a>10)", "mean(a)", "max(a)-min(a)"]
    )
    reads = []
    reader = kernel.read_native_raster_block

    def observed(dataset, window):
        """Read one real native block and retain its identity.

        Args:
            dataset: Open native source.
            window: Admitted native block.

        Returns:
            Actual masked source values.
        """
        reads.append(tuple(window.flatten()))
        return reader(dataset, window)

    monkeypatch.setattr(kernel, "read_native_raster_block", observed)
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    selected = values[values != -9999]
    expected = [
        selected.sum(),
        np.count_nonzero(selected > 10),
        selected[selected > 10].sum(),
        selected.mean(),
        selected.max() - selected.min(),
    ]
    assert [float(row["value"]) for row in artifact.rows] == pytest.approx(expected)
    assert len(reads) == spec.grid.nativeBlocks == len(set(reads))
    assert spec.grid.scale == "2.0" and spec.grid.offset == "-1.0"
    assert artifact.media_type == "text/csv"
    rows = list(
        csv.DictReader((tmp_path / "result.csv").open(newline="", encoding="utf-8"))
    )
    assert rows[1]["value"] == artifact.rows[1]["value"]
    provenance = json.loads((tmp_path / "provenance.json").read_text())
    assert provenance["valueDomain"] == "stored"
    assert provenance["inclusion"] == "cell_center"
    assert provenance["sourceSignature"] == list(spec.sourceSignature)
    assert str(path) not in json.dumps(provenance)


@pytest.mark.parametrize(
    "transform,crs",
    [
        (from_origin(0, 10, 0.01, 0.01), "EPSG:4326"),
        (from_origin(0, 1_000_000, 1000, 1000), "EPSG:3857"),
        (Affine(0.01, 0.002, 0, 0.001, -0.01, 10), "EPSG:4326"),
    ],
)
def test_catalog_hole_center_inclusion_on_rotated_and_projected_grids(
    tmp_path: Path, transform: Affine, crs: str
) -> None:
    """Known pixel-center membership is preserved through polygon reprojection.

    Args:
        tmp_path: Isolated input/output directory.
        transform: Native affine, including rotation.
        crs: Native source CRS.
    """
    from rasterio.warp import transform_geom

    values = np.arange(100, dtype="int16").reshape(10, 10)
    path = write_source(tmp_path / "source.tif", values, transform=transform, crs=crs)
    # Offset edges avoid ambiguous centers; the hole removes rows/columns 4..5.
    outer = [
        transform * point
        for point in [(1.1, 1.1), (8.9, 1.1), (8.9, 8.9), (1.1, 8.9), (1.1, 1.1)]
    ]
    hole = [
        transform * point
        for point in [(4.1, 4.1), (4.1, 5.9), (5.9, 5.9), (5.9, 4.1), (4.1, 4.1)]
    ]
    geometry = transform_geom(
        crs, "EPSG:4326", {"type": "Polygon", "coordinates": [outer, hole]}
    )
    area = write_aggregate_area(tmp_path / "selected.gpkg", [geometry])
    spec = make_spec(path, ["count(a)", "sum(a)"], area)
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert artifact.rows[0]["value"] == "60"
    assert (
        float(artifact.rows[1]["value"])
        == values[1:9, 1:9].sum() - values[4:6, 4:6].sum()
    )


def test_bounds_center_policy_missing_values_and_zero(tmp_path: Path) -> None:
    """A partially intersecting cell is excluded unless its center lies inside.

    Args:
        tmp_path: Native source and result directory.
    """
    path = write_source(
        tmp_path / "source.tif",
        np.array([[0, 1, 2], [3, np.nan, 5], [6, 7, 8]], dtype="float32"),
        transform=from_origin(0, 3, 1, 1),
    )
    area = AggregateArea(kind="bounds", bounds=(0.6, 0.6, 2.9, 2.9))
    artifact = calculate_raster_statistics_for_area(
        path, make_spec(path, ["count(a)", "sum(a)"], area), tmp_path, LIMITS
    )
    assert artifact.rows[0]["value"] == "3"
    assert float(artifact.rows[1]["value"]) == 8
    artifact = calculate_raster_statistics_for_area(
        path, make_spec(path, ["count(a)", "min(a)"]), tmp_path, LIMITS
    )
    assert artifact.rows[0]["value"] == "8"
    assert float(artifact.rows[1]["value"]) == 0


def test_metadata_admission_and_csv_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Planning reads metadata only and rejects excess native work before execution.

    Args:
        tmp_path: Source and output files.
        monkeypatch: Fail if planning attempts to read band values.
    """
    path = write_source(tmp_path / "source.tif", np.ones((100, 100), dtype="uint8"))

    def forbidden(*args):
        """Reject unexpected pixel I/O during metadata planning.

        Args:
            args: Unused native-reader arguments.
        """
        pytest.fail("Planning must not read pixels")

    with monkeypatch.context() as patch:
        patch.setattr(kernel, "read_native_raster_block", forbidden)
        spec = make_spec(path, ["count(a)"])
    spec = spec.model_copy(
        update={
            "calculations": (
                NamedCalculation(label="=IMPORTXML(1)", expression="count(a)"),
            )
        }
    )
    calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert "'=IMPORTXML(1)" in (tmp_path / "result.csv").read_text()
