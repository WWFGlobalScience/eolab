"""Exercise GeoPackage geographic envelopes through the catalog boundary."""

from pathlib import Path

import fiona
import pytest
from pyproj import Transformer
from shapely.geometry import Point, box, shape

from eolab_app.catalog.geopackage import build_stac_items


def write_source(path: Path, crs: str, coordinates: list[list[float]]) -> None:
    """Write a small source whose native envelope is known.

    Args:
        path: Temporary GeoPackage destination.
        crs: Native coordinate reference system.
        coordinates: Native point positions determining the layer envelope.

    Returns:
        None.
    """
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="source",
        crs=crs,
        schema={"geometry": "MultiPoint", "properties": {}},
    ) as dataset:
        dataset.write(
            {
                "geometry": {"type": "MultiPoint", "coordinates": coordinates},
                "properties": {},
            }
        )


def test_projected_dateline_source_is_searchable_on_both_sides(tmp_path: Path) -> None:
    """Preserve wrapped bounds while producing an indexable split footprint.

    Args:
        tmp_path: Isolated source directory.

    Returns:
        None.
    """
    path = tmp_path / "dateline.gpkg"
    # Pacific Mercator supplies a native envelope spanning the date line.
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3832", always_xy=True)
    write_source(
        path,
        "EPSG:3832",
        [
            list(transformer.transform(170, -10)),
            list(transformer.transform(-170, 10)),
        ],
    )
    before = path.read_bytes()
    (item,) = build_stac_items(tmp_path, path)
    assert item["bbox"] == pytest.approx([170, -10, -170, 10])
    footprint = shape(item["geometry"])
    assert footprint.geom_type == "MultiPolygon"
    assert footprint.is_valid
    assert footprint.area == pytest.approx(400)
    for longitude in (175, 180, -180, -175):
        assert footprint.covers(Point(longitude, 0))
    assert footprint.intersects(box(174, -1, 176, 1))
    assert footprint.intersects(box(-176, -1, -174, 1))
    assert not footprint.intersects(box(-1, -1, 1, 1))
    assert not footprint.covers(Point(175, 11))
    assert path.read_bytes() == before


def test_padus_projection_envelope_imports_without_reading_all_features(
    tmp_path: Path,
) -> None:
    """Reproduce the real PADUS envelope with a two-point native fixture.

    Args:
        tmp_path: Isolated source directory.

    Returns:
        None.
    """
    path = tmp_path / "padus-envelope.gpkg"
    write_source(
        path,
        "ESRI:102039",
        [
            [-7113625.207551438, 272786.5227952529],
            [2256084.584889949, 6198630.6262],
        ],
    )
    (item,) = build_stac_items(tmp_path, path)
    assert item["bbox"] == pytest.approx(
        [
            160.6201789137425,
            3.0577730594034485,
            -44.30759224976934,
            88.37927505643152,
        ],
        abs=0.00001,
    )
    assert item["geometry"]["type"] == "MultiPolygon"
    assert shape(item["geometry"]).is_valid


@pytest.mark.parametrize(
    ("bounds", "kind"),
    [
        ([170, -10, -170, 10], "MultiPolygon"),
        ([170, 0, -170, 0], "MultiLineString"),
        ([180, -10, -170, 10], "Polygon"),
        ([170, -10, -180, 10], "Polygon"),
        ([180, -10, -180, 10], "MultiLineString"),
        ([180, 0, -180, 0], "MultiPoint"),
        ([-180, -90, 180, 90], "Polygon"),
        ([180, 0, 180, 0], "Point"),
        ([-180, 0, -180, 10], "LineString"),
    ],
)
def test_transformed_boundary_extents(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    bounds: list[float],
    kind: str,
) -> None:
    """Handle exact transform endpoints without empty or invalid polygon parts.

    Args:
        tmp_path: Isolated source directory.
        monkeypatch: Inject exact native-library transform outputs.
        bounds: Geographic transform result.
        kind: Expected GeoJSON geometry family.

    Returns:
        None.
    """
    path = tmp_path / "edges.gpkg"
    write_source(path, "EPSG:4326", [[0, 0], [1, 1]])
    monkeypatch.setattr(
        "eolab_app.catalog.geopackage.transform_bounds",
        lambda *args: bounds,
    )
    (item,) = build_stac_items(tmp_path, path)
    assert item["bbox"] == bounds
    footprint = shape(item["geometry"])
    assert footprint.geom_type == kind
    assert footprint.is_valid
    assert not footprint.is_empty


@pytest.mark.parametrize(
    "bounds",
    [
        [float("nan"), 0, 1, 1],
        [0, 0, float("inf"), 1],
        [-181, 0, 1, 1],
        [0, 0, 181, 1],
        [0, -91, 1, 1],
        [0, 0, 1, 91],
        [0, 2, 1, 1],
    ],
)
def test_invalid_geographic_bounds_are_rejected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    bounds: list[float],
) -> None:
    """Keep invalid external transform results out of catalog metadata.

    Args:
        tmp_path: Isolated source directory.
        monkeypatch: Inject invalid native-library transform outputs.
        bounds: Non-finite, out-of-world, or latitude-reversed bounds.

    Returns:
        None.
    """
    path = tmp_path / "bad-bounds.gpkg"
    write_source(path, "EPSG:4326", [[0, 0], [1, 1]])
    monkeypatch.setattr(
        "eolab_app.catalog.geopackage.transform_bounds",
        lambda *args: bounds,
    )
    with pytest.raises(ValueError, match="no catalogable spatial vector layers"):
        build_stac_items(tmp_path, path)
