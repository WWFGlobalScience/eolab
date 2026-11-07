"""Catalog-vector and owned-polygon fixtures for numeric and HTTP boundary tests."""

import asyncio
from pathlib import Path
from typing import Any

import fiona

from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.bounded_vector import selection_summary
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.polygon_areas import PolygonSummaryInput
from eolab_app.vector.filters import CatalogVectorFilterRequest, VectorFilter
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.selection_source import resolve_selection


class FixtureCatalog:
    """Minimal authoritative metadata for an actual mounted vector fixture."""

    def __init__(self, source: ResolvedVectorSource) -> None:
        """Bind the exact fixture source."""
        self.source = source

    async def get_item(self, request: CatalogVectorFilterRequest) -> dict[str, Any]:
        """Return the fixture's native fields for source authorization."""
        with fiona.open(
            self.source.source_path, layer=self.source.layer_name
        ) as dataset:
            fields = dataset.schema["properties"]
        return {
            "id": request.item_id,
            "properties": {
                "table:columns": [
                    {"name": name, "type": kind} for name, kind in fields.items()
                ]
            },
        }

    def resolve(self, item: dict[str, Any]) -> ResolvedVectorSource:
        """Resolve authorized fixture metadata to its native mounted source."""
        return self.source


def write_selection(
    path: Path,
    geometries: list[dict[str, Any]],
    *,
    crs: str = "EPSG:4326",
    values: list[int] | None = None,
    candidate: VectorFilter | None = None,
) -> ResolvedCatalogSelection:
    """Write and authorize a real filtered GeoPackage without a geometry registry.

    Args:
        path: New fixture file.
        geometries: Exact native polygon mappings.
        crs: Native source CRS.
        values: Optional integer predicate values, one per feature.
        candidate: Predicate to authorize, defaulting to the whole layer.

    Returns:
        Current source capability issued through the production catalog boundary.
    """
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="polygons",
        crs=crs,
        schema={"geometry": "Unknown", "properties": {"selected": "int64"}},
    ) as dataset:
        for index, geometry in enumerate(geometries):
            dataset.write(
                {
                    "geometry": geometry,
                    "properties": {
                        "selected": values[index] if values is not None else 1,
                    },
                }
            )
    source = ResolvedVectorSource("mounted", "geopackage", path, "data", "polygons")
    catalog = FixtureCatalog(source)
    async def authorize() -> ResolvedCatalogSelection:
        """Issue and independently reauthorize the public selection descriptor."""
        resolved = await resolve_selection(
            catalog, catalog,
            CatalogVectorFilterRequest(
                collectionId="eolab-mounted-vectors",
                itemId=path.stem,
                filter=candidate or VectorFilter(),
            )
        )
        return await VectorSamplingService(catalog, catalog).resolve_for_sampling(resolved.selection)

    return asyncio.run(authorize())


def owned_polygon_area(geometries: list[dict[str, Any]]) -> AggregateArea:
    """Build a current owned-polygon calculation area for a numerical fixture.

    Args:
        geometries: Simple WGS84 polygons accepted by the upload contract.

    Returns:
        The validated polygons with their exact bounds and geometry identity.
    """
    polygons = PolygonSummaryInput(polygons=geometries)
    return AggregateArea(
        kind="polygons",
        bounds=polygons.bounds(),
        geometryHash=polygons.geometry_hash(),
        geometries=tuple(geometries),
    )


def write_aggregate_area(path: Path, geometries: list[dict[str, Any]]) -> AggregateArea:
    """Create a calculation area backed by a real authorized vector fixture.

    Args:
        path: New GeoPackage fixture path.
        geometries: WGS84 polygons, including holes and multipart geometries.

    Returns:
        A current catalog selection with its resolved native source and bounds.
    """
    resolved = write_selection(path, geometries)
    return AggregateArea(
        kind="catalogSelection",
        bounds=selection_summary(resolved)["bbox"],
        catalogSelection=resolved.selection,
        resolved=resolved,
    )


def write_geopackage_layer(
    path: Path,
    layer_name: str,
    *,
    crs: str | None = "EPSG:3857",
    geometry_type: str | None = "Polygon",
    geometry: dict[str, Any] | None = None,
    write_feature: bool = True,
) -> None:
    """Add one representative vector or nonspatial GeoPackage layer.

    Args:
        path: GeoPackage container path to create or extend.
        layer_name: Exact layer name to write.
        crs: Coordinate reference system, or ``None`` for a table.
        geometry_type: Fiona geometry schema, or ``None`` for a table.
        geometry: Optional fixture geometry in the source CRS.
        write_feature: Whether to write one row.

    Returns:
        None.
    """
    if geometry is None and geometry_type == "Polygon":
        geometry = {
            "type": "Polygon",
            "coordinates": [
                [
                    [0, 0],
                    [1_000, 0],
                    [1_000, 1_000],
                    [0, 1_000],
                    [0, 0],
                ]
            ],
        }
    with fiona.open(
        path,
        mode="w",
        driver="GPKG",
        layer=layer_name,
        crs=crs,
        schema={"geometry": geometry_type, "properties": {"secret": "str"}},
    ) as dataset:
        if write_feature:
            dataset.write(
                {
                    "geometry": geometry,
                    "properties": {"secret": "must not reach browser"},
                }
            )


def register_selection(client: Any, path: Path) -> dict[str, Any]:
    """Register a scanner-built fixture Item and select through the real HTTP API.

    Args:
        client: Processing boundary test client exposing its fixture catalog.
        path: Mounted GeoPackage below the fixture root.

    Returns:
        Public immutable descriptor returned by catalog selection.
    """
    from eolab_app.catalog.geopackage import build_stac_items

    item = build_stac_items(path.parent, path)[0]
    client.app.state.vector_items[item["id"]] = item
    response = client.post(
        "/api/vector-sampling/areas",
        json={
            "collectionId": item["collection"],
            "itemId": item["id"],
            "filter": {"enabled": True, "match": "all", "rules": []},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["selection"]
