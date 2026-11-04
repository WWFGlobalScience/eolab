"""Measure exact original-coordinate extents independently of app and rendering."""

from pathlib import Path
from typing import Any

import fiona
import pytest
from shapely.affinity import translate
from shapely.geometry import mapping, shape

from eolab_app.attribute_filter import VectorFilter, ogr_predicate
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import VectorReadLimits
from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.vector.extent_operation import FeatureExtent, SelectionExtentResult
from eolab_app.vector.extents import read_selected_extent


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "Point", "coordinates": [0, 1000]},
        {"type": "LineString", "coordinates": [[0, 0], [1000, 1000]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1000, 0], [1000, 1000], [0, 0]]]},
    ],
)
@pytest.mark.parametrize("driver", ["GPKG", "ESRI Shapefile"])
def test_extent_projects_original_geometry_types_and_exact_predicate(
    tmp_path: Path,
    geometry: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    driver: str,
) -> None:
    """Read points, lines and polygons without a display outline or geometry snapshot.

    Args:
        tmp_path: Isolated original GeoPackage.
        geometry: Native projected geometry whose coordinates should be measured.
        monkeypatch: Control elapsed time without relying on native read speed.
        driver: Mounted format supported by the original-source selection contract.
    """
    path = tmp_path / ("features.gpkg" if driver == "GPKG" else "features.shp")
    with fiona.open(
        path,
        "w",
        driver=driver,
        layer="features",
        crs="EPSG:3857",
        schema={"geometry": geometry["type"], "properties": {"name": "str"}},
    ) as dataset:
        dataset.write({"geometry": geometry, "properties": {"name": "Exact"}})
        dataset.write(
            {
                "geometry": mapping(translate(shape(geometry), xoff=1_000_000)),
                "properties": {"name": "exact"},
            }
        )
    predicate = VectorFilter(
        rules=[{"field": "name", "operator": "eq", "value": "Exact"}]
    )
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="features",
        assetKey="data",
        layerName="features",
        filter=predicate,
    )
    resolved = ResolvedCatalogSelection(
        selection, path, driver, ogr_predicate(predicate)
    )
    result = read_selected_extent(resolved)
    assert result["matched"] == 1
    assert set(result) == {"matched", "bbox"}
    west, south, east, north = result["bbox"]
    assert west == pytest.approx(0)
    assert east == pytest.approx(0 if geometry["type"] == "Point" else 0.00898315284)
    assert north == pytest.approx(0.0089831528)
    assert south == pytest.approx(north if geometry["type"] == "Point" else 0)
    for limits in [
        VectorReadLimits(features=0),
        VectorReadLimits(coordinates_per_feature=0),
    ]:
        with pytest.raises(GeometryValidationError, match="budget|coordinate buffer"):
            read_selected_extent(resolved, limits=limits)
    empty = selection.model_copy(
        update={
            "filter": VectorFilter(
                rules=[{"field": "name", "operator": "eq", "value": "absent"}]
            )
        }
    )
    assert read_selected_extent(
        ResolvedCatalogSelection(empty, path, driver, ogr_predicate(empty.filter))
    ) == {"matched": 0, "bbox": None}
    ticks = iter([0, 100])
    monkeypatch.setattr("eolab_app.vector.extents.monotonic", lambda: next(ticks))
    with pytest.raises(GeometryValidationError, match="time budget"):
        read_selected_extent(resolved)


def test_extent_contract_accepts_points_and_rejects_invalid_native_results() -> None:
    """Keep empty/point bounds valid while rejecting partial or malformed results."""
    assert FeatureExtent(matched=1, bbox=(5, 10, 5, 10)).bbox == (5, 10, 5, 10)
    assert FeatureExtent(matched=0, bbox=None).bbox is None
    for result in [
        {},
        {"extent": {"matched": 1, "bbox": [0, 0, 1, 1]}, "error": "bad"},
        {"extent": {"matched": 0, "bbox": [0, 0, 1, 1]}},
        {"extent": {"matched": 1, "bbox": [1, 0, 0, 1]}},
        {"extent": {"matched": 1, "bbox": [0, 0, 1, float("inf")]}},
        {"extent": {"matched": 1, "bbox": [-181, 0, 1, 1]}},
    ]:
        with pytest.raises(ValueError):
            SelectionExtentResult.model_validate(result)


def test_extent_counts_matches_without_coordinates(tmp_path: Path) -> None:
    """Return no bounds for a matching null geometry without falling back to the source extent.

    Args:
        tmp_path: Isolated original GeoPackage.
    """
    path = tmp_path / "null.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="features",
        crs="EPSG:4326",
        schema={"geometry": "Point", "properties": {"name": "str"}},
    ) as dataset:
        dataset.write({"geometry": None, "properties": {"name": "chosen"}})
        dataset.write(
            {
                "geometry": {"type": "Point", "coordinates": [50, 60]},
                "properties": {"name": "other"},
            }
        )
    predicate = VectorFilter(
        rules=[{"field": "name", "operator": "eq", "value": "chosen"}]
    )
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="null",
        assetKey="data",
        layerName="features",
        filter=predicate,
    )
    assert read_selected_extent(
        ResolvedCatalogSelection(selection, path, "GPKG", ogr_predicate(predicate))
    ) == {"matched": 1, "bbox": None}


def test_projected_line_extent_includes_curved_edge_between_stored_vertices(
    tmp_path: Path,
) -> None:
    """Include a polar line's northern bulge that transforming endpoints alone misses.

    Args:
        tmp_path: Isolated original GeoPackage in the Arctic polar projection.
    """
    path = tmp_path / "polar.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="features",
        crs="EPSG:3413",
        schema={"geometry": "LineString", "properties": {}},
    ) as dataset:
        dataset.write(
            {
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[-1_000_000, -1_000_000], [1_000_000, -1_000_000]],
                },
                "properties": {},
            }
        )
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="polar",
        assetKey="data",
        layerName="features",
        filter=VectorFilter(),
    )
    bbox = read_selected_extent(
        ResolvedCatalogSelection(selection, path, "GPKG", None)
    )["bbox"]
    assert bbox[0] == pytest.approx(-90)
    assert bbox[2] == pytest.approx(0)
    assert bbox[1] == pytest.approx(76.9988155)
    assert bbox[3] == pytest.approx(80.787813)
    assert bbox[3] > 80  # The two stored endpoints both lie below 77 degrees N.
