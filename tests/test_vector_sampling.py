"""Catalog identity, direct native reads, and independent display admission."""

import asyncio
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
import fiona
from shapely.geometry import Polygon, box, mapping, shape

from catalog_selection_support import FixtureCatalog, write_selection
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import (
    VectorReadLimits,
    polygon_features,
    count_selected_features,
    selection_summary,
)
from eolab_app.catalog_selection import (
    CatalogSelection,
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.filters import CatalogVectorFilterRequest, VectorFilter
from eolab_app.vector.models import ResolvedVectorSource, VectorFormat, VectorSourceKind
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.attribute_filter import ogr_predicate
from eolab_app.raster.read_cancellation import RasterReadCancelled


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
        "reading original features requires a mounted Shapefile or GeoPackage layer."
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


@pytest.mark.parametrize("driver", ["GPKG", "ESRI Shapefile"])
def test_count_selected_features_read_only_filter_attributes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, driver: str
) -> None:
    """Count exact typed predicates without decoding geometry or unused fields.

    Args:
        tmp_path: Isolated native vector files.
        monkeypatch: Observe the real Fiona records returned by the reader.
        driver: Mounted format supported by vector selection.
    """
    path = tmp_path / ("counties.gpkg" if driver == "GPKG" else "counties.shp")
    with fiona.open(
        path,
        "w",
        driver=driver,
        layer="counties",
        crs="EPSG:4326",
        schema={
            "geometry": "Polygon",
            "properties": {
                "name": "str",
                "selected": "int64",
                "unused": "str",
            },
        },
    ) as dataset:
        for name, value in [
            ("Washington County", 6060007000),
            ("Washington county", 3),
            (None, None),
        ]:
            dataset.write(
                {
                    "geometry": mapping(box(0, 0, 1, 1)),
                    "properties": {
                        "name": name,
                        "selected": value,
                        "unused": "Not requested",
                    },
                }
            )
    catalog = FixtureCatalog(
        ResolvedVectorSource(
            "mounted",
            "geopackage" if driver == "GPKG" else "shapefile",
            path,
            "data",
            "counties",
        )
    )
    service = VectorSamplingService(catalog, catalog)
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="counties",
        assetKey="data",
        layerName="counties",
        filter=VectorFilter(),
    )
    resolved = asyncio.run(service.resolve_for_sampling(selection))
    read_filter = fiona.Collection.filter
    expected_fields: set[str] = set()

    def filtered_records(
        collection: fiona.Collection, *args: Any, **kwargs: Any
    ) -> Iterator[Any]:
        """Inspect native records while preserving the collection's iterator.

        Args:
            collection: Open original source.
            args: Native filter positional arguments.
            kwargs: Native predicate supplied by the reader.

        Yields:
            Actual geometry-free records with only requested attributes.
        """
        for feature in read_filter(collection, *args, **kwargs):
            assert feature.geometry is None
            assert set(feature.properties) == expected_fields
            yield feature

    monkeypatch.setattr(fiona.Collection, "filter", filtered_records)
    for rule in [
        None,
        {"field": "name", "operator": "eq", "value": "Washington County"},
        {"field": "name", "operator": "missing", "value": None},
        {"field": "selected", "operator": "eq", "value": 6060007000},
    ]:
        candidate = VectorFilter(rules=[] if rule is None else [rule])
        expected_fields = set() if rule is None else {rule["field"]}
        filtered = replace(
            resolved,
            selection=selection.model_copy(update={"filter": candidate}),
            where=ogr_predicate(candidate),
        )
        limit = 1 if rule and rule["field"] == "selected" else 3
        assert count_selected_features(
            filtered, limits=VectorReadLimits(features=limit)
        ) == {
            "matched": 3 if rule is None else 1,
            "total": 3,
        }


def test_count_selected_features_preserve_empty_budget_cancellation_and_read_errors(
    source: ResolvedCatalogSelection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep selection failures while deferring coordinate work to polygon readers.

    Args:
        source: Authorized real polygon source.
        monkeypatch: Advance the reader clock past its actual work deadline.
    """
    assert count_selected_features(
        source, limits=VectorReadLimits(coordinates_per_feature=0)
    ) == {"matched": 1, "total": 2}
    with pytest.raises(GeometryValidationError, match="No matching"):
        count_selected_features(replace(source, where='"selected" = 123'))
    with pytest.raises(GeometryValidationError, match="feature budget"):
        count_selected_features(source, limits=VectorReadLimits(features=0))
    with pytest.raises(RasterReadCancelled):
        count_selected_features(source, lambda: True)
    with pytest.raises(SelectionUnavailableError):
        count_selected_features(
            replace(source, path=source.path.with_name("missing.gpkg"))
        )
    clock = iter([0, 16])
    monkeypatch.setattr("eolab_app.bounded_vector.monotonic", lambda: next(clock))
    with pytest.raises(GeometryValidationError, match="15-second time budget"):
        count_selected_features(source)


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
    source: ResolvedCatalogSelection,
) -> None:
    """Interactive reads enforce feature and coordinate budgets; supervised work can opt out.

    Args:
        source: Authorized polygon fixture exceeding the reduced reader budgets.
    """
    from eolab_app.bounded_vector import VectorReadLimits

    with pytest.raises(GeometryValidationError, match="budget"):
        selection_summary(source, limits=VectorReadLimits(features=0))
    with pytest.raises(GeometryValidationError, match="coordinate buffer"):
        selection_summary(source, limits=VectorReadLimits(coordinates_per_feature=4))
    assert selection_summary(source, limits=None) == selection_summary(source)


@pytest.mark.parametrize(
    "field,value",
    [("assetKey", "other"), ("layerName", "other")],
)
def test_descriptor_reauthorization_checks_all_source_identity(
    source: ResolvedCatalogSelection,
    field: str,
    value: str,
) -> None:
    """A caller cannot substitute an asset or native layer."""
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
        """Reauthorize the descriptor after its feature count completes."""

        async def count_features(
            selection: CatalogSelection, upload_owner: str | None
        ) -> dict[str, int]:
            """Count the real fixture features for the requested descriptor.

            Args:
                selection: Expected descriptor passed to the execution boundary.
                upload_owner: Unused browser identity for this catalog selection.

            Returns:
                Matched and total feature counts, without simulating job scheduling.
            """
            assert selection == source.selection
            return count_selected_features(source)

        first = VectorSamplingService(
            catalog, catalog, selection_executor=count_features
        )
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


def test_configured_source_trusts_immutable_identity_without_scanning(
    source: ResolvedCatalogSelection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Resolve the configured source without scanning its features.

    Args:
        source: Real configured polygon layer.
        monkeypatch: Reject feature access during source resolution.
    """
    from eolab_app.catalog.vector_contract import CatalogVectorRequest
    from unittest.mock import AsyncMock

    catalog = FixtureCatalog(
        ResolvedVectorSource("mounted", "geopackage", source.path, "data", "polygons")
    )
    request = CatalogVectorRequest(
        collectionId=source.selection.collection_id, itemId=source.selection.item_id
    )
    metadata = asyncio.run(catalog.get_item(request))
    with monkeypatch.context() as context:
        context.setattr(catalog, "get_item", AsyncMock(return_value=metadata))
        context.setattr(
            "fiona.open",
            lambda *args, **kwargs: pytest.fail(
                "Source resolution must not read features"
            ),
        )
        first = asyncio.run(
            VectorSamplingService(catalog, catalog).resolve_source(request)
        )
    assert not first.selection.filter.active
    with pytest.raises(ValueError):
        CatalogSelection.model_validate(
            {**first.selection.model_dump(), "path": "/private"}
        )
    restarted = VectorSamplingService(catalog, catalog)
    assert (
        asyncio.run(restarted.resolve_for_sampling(first.selection)).selection
        == first.selection
    )
