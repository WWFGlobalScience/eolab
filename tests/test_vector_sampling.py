"""Catalog identity, direct native reads, and independent display admission."""

import asyncio
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from shapely.geometry import Polygon, box, mapping, shape

from catalog_selection_support import FixtureCatalog, write_selection
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import polygon_features, selection_summary
from eolab_app.catalog_selection import (
    CatalogSelection,
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.filters import CatalogVectorFilterRequest, VectorFilter
from eolab_app.vector.models import ResolvedVectorSource, VectorFormat, VectorSourceKind
from eolab_app.vector.sampling import VectorSamplingService


@pytest.mark.parametrize(
    "kind,format",
    [("remote", "geopackage"), ("mounted", "geojson")],
)
def test_unsupported_selection_reports_source_without_private_path(
    tmp_path: Path, kind: VectorSourceKind, format: VectorFormat
) -> None:
    """Explain the actual unsupported source without exposing its location."""

    class UnsupportedCatalog(FixtureCatalog):
        """Return metadata for a source that must never reach native reading."""

        async def get_item(self, request: CatalogVectorFilterRequest) -> dict[str, Any]:
            """Return the requested identity without opening an unsupported file."""
            return {"id": request.item_id}

    private_path = tmp_path / "private.geojson" if kind == "mounted" else None
    catalog = UnsupportedCatalog(
        ResolvedVectorSource(kind, format, private_path, "data", "polygons")
    )
    service = VectorSamplingService(catalog, catalog)
    request = CatalogVectorFilterRequest(
        collectionId="eolab-mounted-vectors", itemId="polygons", filter=VectorFilter()
    )
    with pytest.raises(VectorConflictError) as failure:
        asyncio.run(service.select(request))
    assert str(failure.value) == (
        f"The selected source is {kind} {format}; "
        "sampling requires a mounted Shapefile or GeoPackage polygon layer."
    )
    assert str(tmp_path) not in str(failure.value)


@pytest.fixture
def source(tmp_path: Path) -> ResolvedCatalogSelection:
    """Create real polygons with a hole and an exact 64-bit selection attribute."""
    return write_selection(
        tmp_path / "polygons.gpkg",
        [
            mapping(
                Polygon(
                    [(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)],
                    [[(1, 1), (1, 2), (2, 2), (2, 1), (1, 1)]],
                )
            ),
            mapping(box(10, 0, 14, 4)),
        ],
        values=[6060007000, 3],
        candidate=VectorFilter(
            rules=[
                {"field": "selected", "operator": "eq", "value": 6060007000},
            ]
        ),
    )


def test_complete_filtered_polygon_preserves_hole_without_snapshot(
    source: ResolvedCatalogSelection,
) -> None:
    """Keep exact topology while returning only measured metadata and a descriptor."""
    result = selection_summary(source)
    assert (result["matched"], result["total"]) == (1, 2)
    assert result["bbox"] == (0, 0, 4, 4)
    assert "geometry" not in result
    with polygon_features(source) as features:
        polygons = list(features)
    assert len(polygons) == 1 and shape(polygons[0]).area == 15
    assert "coordinates" not in source.selection.model_dump_json()


def test_native_read_never_falls_back_after_zero_matches(
    source: ResolvedCatalogSelection,
) -> None:
    """An empty native predicate is an explicit failure, never an unfiltered read."""
    with pytest.raises(GeometryValidationError, match="No matching"):
        selection_summary(replace(source, where='"selected" = 123'))


def test_selection_only_service_cannot_launch_local_outline(
    source: ResolvedCatalogSelection,
) -> None:
    """Omitting the Jobs adapter never revives the removed local outline path.

    Args:
        source: Real valid source that the former local path could outline.
    """
    catalog = FixtureCatalog(
        ResolvedVectorSource("mounted", "geopackage", source.path, "data", "polygons")
    )
    service = VectorSamplingService(catalog, catalog)
    with pytest.raises(VectorConflictError, match="executor is unavailable"):
        asyncio.run(service.outline(source.selection))


def test_actual_feature_and_coordinate_budgets(
    source: ResolvedCatalogSelection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Limits apply to retained feature geometry and actual scanned work."""
    with monkeypatch.context() as patch:
        patch.setattr("eolab_app.bounded_vector.MAX_SCANNED_FEATURES", 0)
        with pytest.raises(GeometryValidationError, match="budget"):
            selection_summary(source)
    monkeypatch.setattr("eolab_app.bounded_vector.MAX_FEATURE_COORDINATES", 4)
    with pytest.raises(GeometryValidationError, match="coordinate buffer"):
        selection_summary(source)


@pytest.mark.parametrize(
    "field,value",
    [("assetKey", "other"), ("layerName", "other"), ("sourceSignature", "f" * 64)],
)
def test_descriptor_reauthorization_checks_all_source_identity(
    source: ResolvedCatalogSelection,
    field: str,
    value: str,
) -> None:
    """A caller cannot substitute an asset, native layer, or stale source signature."""
    catalog = FixtureCatalog(
        ResolvedVectorSource("mounted", "geopackage", source.path, "data", "polygons")
    )
    service = VectorSamplingService(catalog, catalog)
    with pytest.raises(SelectionUnavailableError, match="identity changed"):
        asyncio.run(
            service.resolve_for_sampling(
                source.selection.model_copy(update={field: value})
            )
        )


def test_selection_reauthorizes_after_restart_without_storage(
    source: ResolvedCatalogSelection,
) -> None:
    """Fresh service instances reauthorize the same selection without a registry."""
    catalog = FixtureCatalog(
        ResolvedVectorSource("mounted", "geopackage", source.path, "data", "polygons")
    )
    request = CatalogVectorFilterRequest(
        collectionId=source.selection.collection_id,
        itemId=source.selection.item_id,
        filter=source.selection.filter,
    )

    async def scenario() -> None:
        """Exercise the production native selector independently of map outlines."""
        first = VectorSamplingService(catalog, catalog)
        response = await first.select(request)
        descriptor = CatalogSelection.model_validate(response["selection"])
        assert not {"id", "expiresAt", "geometry"}.intersection(response)
        assert descriptor == source.selection
        restarted = VectorSamplingService(catalog, catalog)
        assert (
            await restarted.resolve_for_sampling(descriptor)
        ).selection == descriptor
        invalid = request.model_copy(
            update={
                "filter": VectorFilter(
                    rules=[{"field": "unknown", "operator": "eq", "value": 1}]
                )
            }
        )
        with pytest.raises(VectorConflictError, match="not in this layer"):
            await first.select(invalid)

    asyncio.run(scenario())
