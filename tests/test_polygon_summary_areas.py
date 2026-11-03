"""Exact annotation polygon inputs at the Processing and raster boundaries."""

from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pydantic import ValidationError
from rasterio.transform import from_origin

from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.polygon_areas import PolygonSummaryInput
from eolab_app.processing.raster_aggregate import calculate_raster_statistics_for_area
from raster_aggregate_support import make_spec, LIMITS
from raster_fixture_support import write_source


def rectangle(west: float, south: float, east: float, north: float) -> dict[str, Any]:
    """Create a closed GeoJSON polygon for an exact numeric test area.

    Args:
        west: Western longitude.
        south: Southern latitude.
        east: Eastern longitude.
        north: Northern latitude.

    Returns:
        Polygon geometry without feature properties.
    """
    return {
        "type": "Polygon",
        "coordinates": [
            [[west, south], [east, south], [east, north], [west, north], [west, south]]
        ],
    }


def test_polygon_validation_and_order_independent_identity() -> None:
    """Reject empty/invalid shapes and give reordered copies the same cache identity."""
    first, second = rectangle(0, 0, 2, 2), rectangle(1, 1, 3, 3)
    value = PolygonSummaryInput(polygons=[first, second])
    assert value.bounds() == (0, 0, 3, 3)
    assert (
        value.geometry_hash()
        == PolygonSummaryInput(polygons=[second, first, first]).geometry_hash()
    )
    for polygons in [
        [],
        [{"type": "Point", "coordinates": [0, 0]}],
        [
            {
                "type": "Polygon",
                "coordinates": [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]],
            }
        ],
        [{**first, "coordinates": first["coordinates"] * 2}],
    ]:
        with pytest.raises(ValidationError):
            PolygonSummaryInput(polygons=polygons)


def test_uploaded_polygons_use_the_existing_raster_mask(tmp_path: Path) -> None:
    """Sum the polygon union once, excluding gaps inside its bounding rectangle.

    Args:
        tmp_path: Scratch directory for the raster, mask and result files.
    """
    path = write_source(
        tmp_path / "source.tif",
        np.ones((10, 10), dtype="uint8"),
        transform=from_origin(0, 10, 1, 1),
    )
    polygons = PolygonSummaryInput(
        polygons=[rectangle(1, 1, 4, 4), rectangle(3, 3, 6, 6)]
    )
    area = AggregateArea(
        kind="polygons",
        bounds=polygons.bounds(),
        geometryHash=polygons.geometry_hash(),
        geometries=tuple(p.model_dump(mode="json") for p in polygons.polygons),
    )
    plan = make_spec(path, ["sum(a)", "mean(a)", "areaha(a > 0)"], area)
    output = tmp_path / "result"
    output.mkdir()
    result = calculate_raster_statistics_for_area(path, plan, output, LIMITS)
    assert float(result.rows[0]["value"]) == 17
    assert float(result.rows[1]["value"]) == 1
    assert float(result.rows[2]["value"]) > 0


def test_polygon_input_limits_coordinates_before_execution() -> None:
    """Reject aggregate vertex budgets and coordinates outside the editor's map extent."""
    from math import cos, sin, tau

    ring = [[cos(i * tau / 2000), sin(i * tau / 2000)] for i in range(2000)]
    ring.append(ring[0])
    polygon = {"type": "Polygon", "coordinates": [ring]}
    with pytest.raises(ValidationError, match="100,000 coordinates"):
        PolygonSummaryInput(polygons=[polygon] * 50)
    with pytest.raises(ValidationError):
        PolygonSummaryInput(polygons=[rectangle(0, 85, 1, 86)])


def test_annotation_and_catalog_polygon_statistics_match(tmp_path: Path) -> None:
    """The two area sources produce the same native sums, means and ground areas.

    Args:
        tmp_path: Directory for equivalent GeoPackage, raster and result fixtures.
    """
    from catalog_selection_support import write_selection

    geometries = [rectangle(1.25, 1.25, 4.25, 4.25), rectangle(3.25, 3.25, 6.25, 6.25)]
    selected = write_selection(tmp_path / "polygons.gpkg", geometries)
    polygons = PolygonSummaryInput(polygons=geometries)
    catalog_area = AggregateArea(
        kind="catalogSelection",
        bounds=polygons.bounds(),
        catalogSelection=selected.selection,
        resolved=selected,
    )
    annotation_area = AggregateArea(
        kind="polygons",
        bounds=polygons.bounds(),
        geometryHash=polygons.geometry_hash(),
        geometries=tuple(geometries),
    )
    raster = write_source(
        tmp_path / "source.tif",
        np.arange(100, dtype="uint8").reshape(10, 10),
        transform=from_origin(0, 10, 1, 1),
    )
    results = []
    for area in (catalog_area, annotation_area):
        plan = make_spec(raster, ["sum(a)", "mean(a)", "areaha(a > 0)"], area)
        if area.kind == "catalogSelection":
            plan = plan.model_copy(update={"area": area})
        directory = tmp_path / area.kind
        directory.mkdir()
        result = calculate_raster_statistics_for_area(raster, plan, directory, LIMITS)
        results.append([float(row["value"]) for row in result.rows])
    assert results[0] == pytest.approx(results[1], rel=1e-12)
