"""Independent ellipsoidal references and real native-grid area boundaries."""

from dataclasses import replace
import csv
import json
import math
from pathlib import Path
from typing import Any

from affine import Affine
import numpy as np
from pyproj import Geod, Transformer
import pytest
from rasterio.shutil import copy as copy_raster
from rasterio.transform import from_origin
from shapely.geometry import Polygon, box, mapping

from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_aggregate import calculate_raster_statistics_for_area
import eolab_app.processing.raster_aggregate as kernel
from test_raster_aggregates import LIMITS, make_spec
from test_raster_clips import write_source


def reference_area(polygon: Polygon, crs: str = "EPSG:4326") -> float:
    """Measure densely sampled native edges with independent geodesic integration.

    Args:
        polygon: Native-coordinate polygon, including optional holes.
        crs: CRS in which each edge is straight.

    Returns:
        Ground hectares on the WGS84 ellipsoid.
    """
    transform = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    geod = Geod(ellps="WGS84")
    areas = []
    for ring in [polygon.exterior, *polygon.interiors]:
        points = np.asarray(ring.coords)
        sampled = np.concatenate(
            [
                start + (end - start) * np.linspace(0, 1, 2001, endpoint=False)[:, None]
                for start, end in zip(points[:-1], points[1:], strict=True)
            ]
        )
        longitude, latitude = transform.transform(sampled[:, 0], sampled[:, 1])
        areas.append(abs(geod.polygon_area_perimeter(longitude, latitude)[0]))
    return (areas[0] - sum(areas[1:])) / 10_000


@pytest.mark.parametrize("latitude", [0, 45, 75])
def test_geographic_cells_match_independent_ellipsoid_integral(
    tmp_path: Path, latitude: float
) -> None:
    """One-degree cells vary correctly with latitude rather than map pixel size.

    Args:
        tmp_path: Isolated input and result files.
        latitude: Southern edge of the known geographic cell.
    """
    path = write_source(
        tmp_path / "cell.tif",
        np.array([[4]], dtype="uint8"),
        transform=from_origin(10, latitude + 1, 1, 1),
    )
    spec = make_spec(path, ["areaha(a == 4)"])
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    row = artifact.rows[0]
    assert float(row["value"]) == pytest.approx(
        reference_area(box(10, latitude, 11, latitude + 1)), rel=1e-8
    )
    assert row["unit"] == "ha" and row["valueType"] == "float"
    assert row["aggregates"][0]["matchedPixels"] == 1
    assert spec.grid.groundArea.ellipsoid == "WGS84"
    assert spec.grid.groundArea.estimatedGeometryCells == 0


@pytest.mark.parametrize("latitude", [0, 60])
def test_web_mercator_uses_ground_hectares(tmp_path: Path, latitude: float) -> None:
    """A nominal square kilometre in Web Mercator is not 100 ground hectares.

    Args:
        tmp_path: Isolated source/results.
        latitude: Location of the one-kilometre map pixel.
    """
    _, y = Transformer.from_crs(4326, 3857, always_xy=True).transform(0, latitude)
    path = write_source(
        tmp_path / "cell.tif",
        np.array([[4]], dtype="uint8"),
        crs="EPSG:3857",
        transform=from_origin(0, y + 1000, 1000, 1000),
    )
    artifact = calculate_raster_statistics_for_area(
        path, make_spec(path, ["areaha(a == 4)"]), tmp_path, LIMITS
    )
    measured = float(artifact.rows[0]["value"])
    assert measured == pytest.approx(
        reference_area(box(0, y, 1000, y + 1000), "EPSG:3857"), rel=1e-8
    )
    assert 24 < measured < 26 if latitude else 99 < measured < 100


def test_partial_cell_sliver_is_area_even_when_center_is_outside(
    tmp_path: Path,
) -> None:
    """Area and numeric aggregates intentionally use different inclusion masks.

    Args:
        tmp_path: Isolated source/results.
    """
    path = write_source(
        tmp_path / "cell.tif",
        np.array([[4]], dtype="uint8"),
        transform=from_origin(0, 1, 1, 1),
    )
    area = AggregateArea(kind="bounds", bounds=(0.999, 0, 1, 1))
    spec = make_spec(
        path,
        ["areaha(a == 4)", "count(a)", "100 * areaha(a == 4) / areaha(a == a)"],
        area,
    )
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert float(artifact.rows[0]["value"]) == pytest.approx(
        reference_area(box(0.999, 0, 1, 1)), rel=1e-8
    )
    assert artifact.rows[0]["aggregates"][0]["validPixels"] == 1
    assert artifact.rows[1]["value"] is None
    assert artifact.rows[1]["state"] == "no_valid_data"
    assert float(artifact.rows[2]["value"]) == 100
    assert artifact.rows[2]["unit"] is None
    provenance = json.loads((tmp_path / "provenance.json").read_text())
    assert provenance["inclusion"] == "per_function"
    assert provenance["functionInclusion"] == {
        "numeric": "cell_center",
        "areaha": "fractional_cell_intersection",
    }
    assert provenance["grid"]["groundArea"]["units"] == "ha"
    assert provenance["grid"]["groundArea"]["edgeToleranceMetres"] == 0.1
    rows = list(csv.DictReader((tmp_path / "result.csv").open(newline="")))
    assert rows[0]["unit"] == "ha" and rows[2]["unit"] == ""


def test_aoi_union_holes_and_fractional_edges(tmp_path: Path) -> None:
    """Overlapping AOIs count once and holes retain fractional exclusions.

    Args:
        tmp_path: Isolated source/results.
    """
    path = write_source(
        tmp_path / "cells.tif",
        np.full((4, 4), 4, dtype="uint8"),
        transform=from_origin(0, 4, 1, 1),
    )
    first = Polygon(
        box(0.2, 0.2, 3.8, 3.8).exterior.coords,
        [box(1.1, 1.1, 2.3, 2.3).exterior.coords],
    )
    second = box(0.2, 0.2, 1, 2)
    area = AggregateArea(
        kind="aoi",
        bounds=(0.2, 0.2, 3.8, 3.8),
        geometries=(mapping(first), mapping(second)),
    )
    artifact = calculate_raster_statistics_for_area(
        path, make_spec(path, ["areaha(a==4)", "count(a)"], area), tmp_path, LIMITS
    )
    assert float(artifact.rows[0]["value"]) == pytest.approx(
        reference_area(first), rel=1e-8
    )
    assert artifact.rows[0]["aggregates"][0]["matchedPixels"] == 16
    assert artifact.rows[1]["value"] == "15"


@pytest.mark.parametrize(
    "transform,crs",
    [
        (Affine(0.01, 0.002, 10, 0.001, -0.01, 45), "EPSG:4326"),
        (Affine(1000, 200, 500_000, 100, -1000, 5_000_000), "EPSG:32632"),
        (from_origin(0, 1_000_000, 1000, 1000), "EPSG:6933"),
    ],
)
def test_rotated_and_projected_cell_footprints(
    tmp_path: Path, transform: Affine, crs: str
) -> None:
    """Native cell edges are transformed; area never assumes square map units.

    Args:
        tmp_path: Isolated source/results.
        transform: Native affine, including rotation/shear.
        crs: WGS84 geographic/projected source CRS.
    """
    path = write_source(
        tmp_path / "cells.tif",
        np.full((2, 2), 4, dtype="uint8"),
        transform=transform,
        crs=crs,
    )
    footprint = Polygon([transform * p for p in [(0, 0), (2, 0), (2, 2), (0, 2)]])
    spec = make_spec(path, ["areaha(a==4)"])
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert float(artifact.rows[0]["value"]) == pytest.approx(
        reference_area(footprint, crs), rel=1e-5
    )


def test_area_missing_and_empty_matches(tmp_path: Path) -> None:
    """NoData is excluded, and zero matches differ from no valid ground coverage.

    Args:
        tmp_path: Isolated source/results.
    """
    path = write_source(
        tmp_path / "cells.tif",
        np.array([[4, -9999], [0, 4]], dtype="int16"),
        transform=from_origin(0, 2, 1, 1),
        nodata=-9999,
    )
    result = calculate_raster_statistics_for_area(
        path,
        make_spec(path, ["areaha(a==4)", "areaha(a>100)", "areaha(a == a)"]),
        tmp_path,
        LIMITS,
    )
    assert float(result.rows[0]["value"]) == pytest.approx(
        reference_area(box(0, 1, 1, 2)) + reference_area(box(1, 0, 2, 1)), rel=1e-8
    )
    assert (
        result.rows[1]["state"] == "no_matches" and float(result.rows[1]["value"]) == 0
    )
    assert result.rows[2]["aggregates"][0]["validPixels"] == 3
    area = AggregateArea(kind="bounds", bounds=(1.1, 1.1, 1.9, 1.9))
    missing = calculate_raster_statistics_for_area(
        path, make_spec(path, ["areaha(a==4)"], area), tmp_path, LIMITS
    )
    assert missing.rows[0]["state"] == "no_valid_data"
    assert missing.rows[0]["value"] is None


@pytest.mark.parametrize("crs", ["EPSG:3857", "EPSG:32632"])
def test_small_box_inside_projected_rotated_pixel(tmp_path: Path, crs: str) -> None:
    """A partial projected cell measures the geographic box, excluding its center.

    Args:
        tmp_path: Isolated native source and artifacts.
        crs: Projected WGS84 coordinate system.
    """
    transform = Affine(10_000, 2000, 500_000, 1000, -10_000, 5_000_000)
    path = write_source(
        tmp_path / "rotated.tif",
        np.full((2, 2), 4, dtype="uint8"),
        transform=transform,
        crs=crs,
    )
    longitude, latitude = Transformer.from_crs(crs, 4326, always_xy=True).transform(
        *(transform * (0.1, 0.1))
    )
    bounds = (longitude, latitude, longitude + 0.001, latitude + 0.001)
    area = AggregateArea(kind="bounds", bounds=bounds)
    result = calculate_raster_statistics_for_area(
        path, make_spec(path, ["areaha(a==4)", "count(a)"], area), tmp_path, LIMITS
    )
    assert float(result.rows[0]["value"]) == pytest.approx(
        reference_area(box(*bounds)), rel=1e-6
    )
    assert result.rows[0]["aggregates"][0]["matchedPixels"] == 1
    assert result.rows[1]["state"] == "no_valid_data"


def test_area_expression_excludes_invalid_arithmetic(tmp_path: Path) -> None:
    """Undefined predicates never contribute their cell's ground area.

    Args:
        tmp_path: Isolated raster and result directory.
    """
    path = write_source(
        tmp_path / "cells.tif",
        np.array([[0, 2]], dtype="uint8"),
        transform=from_origin(0, 1, 1, 1),
    )
    result = calculate_raster_statistics_for_area(
        path, make_spec(path, ["areaha(1 / a > 0)"]), tmp_path, LIMITS
    )
    assert float(result.rows[0]["value"]) == pytest.approx(
        reference_area(box(1, 0, 2, 1)), rel=1e-8
    )
    assert result.rows[0]["aggregates"][0]["invalidArithmeticPixels"] == 1


def test_execution_geometry_budget_and_reviewed_tolerance(tmp_path: Path) -> None:
    """Execution refuses excessive refinement or a changed measurement policy.

    Args:
        tmp_path: Isolated source and private output directory.
    """
    path = write_source(
        tmp_path / "cells.tif",
        np.ones((10, 10), dtype="uint8"),
        transform=Affine(0.01, 0.002, 10, 0.001, -0.01, 45),
    )
    spec = make_spec(path, ["areaha(a>0)"])
    with pytest.raises(ProcessingError, match="transformed coordinates"):
        calculate_raster_statistics_for_area(
            path, spec, tmp_path, replace(LIMITS, max_area_transform_coordinates=100)
        )
    assert not (tmp_path / "result.csv").exists()
    with pytest.raises(ProcessingError, match="policy changed"):
        calculate_raster_statistics_for_area(
            path, spec, tmp_path, replace(LIMITS, area_edge_tolerance_metres=0.2)
        )


def test_global_rectilinear_area_has_no_half_globe_limitation(tmp_path: Path) -> None:
    """Summed ground cells match the full ellipsoid's analytic surface area.

    Args:
        tmp_path: Isolated global raster and results.
    """
    path = write_source(
        tmp_path / "world.tif",
        np.ones((180, 360), dtype="uint8"),
        transform=from_origin(-180, 90, 1, 1),
    )
    spec = make_spec(path, ["areaha(a==1)"])
    result = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    geod = Geod(ellps="WGS84")
    e = math.sqrt(geod.f * (2 - geod.f))
    expected = 2 * math.pi * geod.a**2 * (1 + (1 - e**2) / e * math.atanh(e)) / 10_000
    assert float(result.rows[0]["value"]) == pytest.approx(expected, rel=1e-12)
    assert spec.grid.groundArea.estimatedGeometryCells == 0


def test_area_admission_is_metadata_only_and_keeps_resource_fences(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Area planning rejects bounded work without reading pixels or weakening limits.

    Args:
        tmp_path: Native fixture directory.
        monkeypatch: Guard native reads during planning.
    """
    path = write_source(
        tmp_path / "cells.tif",
        np.ones((10, 10), dtype="uint8"),
        transform=Affine(0.01, 0.002, 10, 0.001, -0.01, 45),
    )

    def forbidden(*args: Any) -> None:
        """Reject pixel I/O during metadata admission.

        Args:
            args: Unused reader arguments.
        """
        pytest.fail("Area planning must not read source values")

    monkeypatch.setattr(kernel, "read_native_raster_block", forbidden)
    spec = make_spec(path, ["areaha(a>0)"])
    assert spec.grid.groundArea.estimatedGeometryCells == 100
    with pytest.raises(ProcessingError, match="100 raster cells.*99"):
        make_spec(
            path, ["areaha(a>0)"], limits=replace(LIMITS, max_area_geometry_cells=99)
        )
    with pytest.raises(ProcessingError, match="memory"):
        make_spec(path, ["areaha(a>0)"], limits=replace(LIMITS, max_memory_bytes=1))
    with pytest.raises(ProcessingError, match="decoded"):
        make_spec(path, ["areaha(a>0)"], limits=replace(LIMITS, max_decoded_bytes=1))
    aoi = AggregateArea(
        kind="aoi",
        bounds=(10, 44.9, 10.1, 45),
        geometries=(mapping(Polygon([(10, 44.9), (10.1, 45), (10, 45)])),),
    )
    with pytest.raises(ProcessingError, match="coordinates"):
        make_spec(path, ["areaha(a>0)"], aoi, replace(LIMITS, max_coordinates=10))


@pytest.mark.parametrize("rows", [1000, 1001])
def test_country_scale_mask_admission_is_independent_of_pixel_polygon_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, rows: int
) -> None:
    """Large rectilinear AOIs require no pixel-polygon budget or band reads.

    Args:
        tmp_path: Isolated native fixture directory.
        monkeypatch: Guard source-value reads during planning.
        rows: Raster height below or above the old two-million-pixel window cap.
    """
    polygon = Polygon([(0, 0), (20, 0), (20, 10), (0, 0)])
    area = AggregateArea(
        kind="aoi", bounds=polygon.bounds, geometries=(mapping(polygon),)
    )
    path = write_source(
        tmp_path / "country.tif",
        np.ones((rows, 2000), dtype="uint8"),
        transform=from_origin(0, 10, 0.01, 10 / rows),
    )

    def forbidden(*args: Any) -> None:
        """Fail if metadata admission attempts to inspect raster values.

        Args:
            args: Unused native-reader arguments.
        """
        pytest.fail("Area planning must not read source values")

    monkeypatch.setattr(kernel, "read_native_raster_block", forbidden)
    spec = make_spec(
        path, ["areaha(a>0)"], area, replace(LIMITS, max_area_geometry_cells=0)
    )
    assert spec.grid.groundArea.estimatedGeometryCells == 0
    assert spec.grid.groundArea.inclusion == "fractional_cell_intersection"
    assert spec.grid.width * spec.grid.height == rows * 2000
    with pytest.raises(ProcessingError, match="decoded"):
        make_spec(path, ["areaha(a>0)"], area, replace(LIMITS, max_decoded_bytes=1))
    with pytest.raises(ProcessingError, match="memory"):
        make_spec(path, ["areaha(a>0)"], area, replace(LIMITS, max_memory_bytes=1))


def test_area_rejects_unreviewed_datum_and_wrapped_grid(tmp_path: Path) -> None:
    """Unsupported geographic operations fail explicitly instead of estimating.

    Args:
        tmp_path: Native fixture directory.
    """
    nad = write_source(
        tmp_path / "nad.tif",
        np.ones((1, 1), dtype="uint8"),
        crs="EPSG:4267",
        transform=from_origin(-100, 45, 1, 1),
    )
    with pytest.raises(ProcessingError, match="WGS84"):
        make_spec(nad, ["areaha(a>0)"])
    wrapped = write_source(
        tmp_path / "wrap.tif",
        np.ones((1, 2), dtype="uint8"),
        transform=from_origin(179, 10, 1, 1),
    )
    with pytest.raises(ProcessingError, match="-180 to 180"):
        make_spec(wrapped, ["areaha(a>0)"])


def test_area_results_do_not_depend_on_source_blocks_or_processing_tiles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Latitude weights and fractional masks stay aligned across arbitrary tiles.

    Args:
        tmp_path: Isolated GeoTIFF copies with distinct block layouts.
        monkeypatch: Vary the processing tile size independently of native blocks.
    """
    rows, columns = np.indices((257, 273))
    values = ((rows + 3 * columns) % 5).astype("int16")
    values[80:100, 90:110] = -9999
    path = write_source(
        tmp_path / "source.tif",
        values,
        nodata=-9999,
        transform=from_origin(10, 75, 0.01, 0.01),
    )
    polygon = Polygon(
        [
            (10.0311, 72.5013),
            (12.7017, 72.5119),
            (12.5011, 74.9613),
            (10.1023, 74.8127),
        ],
        [
            [
                (10.7013, 73.5011),
                (11.3017, 73.5019),
                (11.2011, 74.2013),
                (10.7019, 74.2023),
            ]
        ],
    )
    area = AggregateArea(
        kind="aoi", bounds=polygon.bounds, geometries=(mapping(polygon),)
    )
    baseline = None
    baseline_counts = None
    for side, tile in [(32, 17), (128, 64), (512, 256), (512, 512)]:
        directory = tmp_path / f"block-{side}-tile-{tile}"
        directory.mkdir()
        tiled = directory / "source.tif"
        copy_raster(
            path, tiled, driver="GTiff", tiled=True, blockxsize=side, blockysize=side
        )
        monkeypatch.setattr(kernel, "TILE_SIDE", tile)
        spec = make_spec(tiled, ["areaha(a>0)", "areaha(a == a)", "count(a>0)"], area)
        result = calculate_raster_statistics_for_area(tiled, spec, directory, LIMITS)
        measured = [float(row["value"]) for row in result.rows]
        counts = [row["aggregates"] for row in result.rows]
        if baseline is None:
            baseline = measured
            baseline_counts = counts
        else:
            assert measured == pytest.approx(baseline, rel=1e-11)
            assert counts == baseline_counts
        assert spec.grid.groundArea.estimatedGeometryCells == 0


@pytest.mark.parametrize("crs", ["EPSG:3857", "EPSG:6933"])
def test_projected_polygon_masks_match_independent_ground_area(
    tmp_path: Path, crs: str
) -> None:
    """Projected row-weight masks retain ellipsoidal area and fractional holes.

    Args:
        tmp_path: Isolated native projected raster and outputs.
        crs: Supported projected grid with separable row/column area weights.
    """
    x, y = Transformer.from_crs(4326, crs, always_xy=True).transform(12, 65)
    path = write_source(
        tmp_path / "projected.tif",
        np.ones((100, 100), dtype="uint8"),
        transform=from_origin(x - 50_000, y + 50_000, 1000, 1000),
        crs=crs,
    )
    polygon = Polygon(
        [(11.8, 64.9), (12.2, 64.92), (12.1, 65.1), (11.85, 65.05)],
        [[(11.95, 64.98), (12.02, 64.98), (12, 65.02)]],
    )
    area = AggregateArea(
        kind="aoi", bounds=polygon.bounds, geometries=(mapping(polygon),)
    )
    # Separate mask accuracy from the existing 0.1 m boundary-refinement policy.
    limits = replace(
        LIMITS, max_area_geometry_cells=0, area_edge_tolerance_metres=0.001
    )
    spec = make_spec(path, ["areaha(a>0)"], area, limits)
    result = calculate_raster_statistics_for_area(path, spec, tmp_path, limits)
    assert float(result.rows[0]["value"]) == pytest.approx(
        reference_area(polygon), rel=1e-7
    )
    assert spec.grid.groundArea.estimatedGeometryCells == 0
