"""Test bounded categorical value discovery for authoritative vector Items."""

import asyncio
from pathlib import Path
from threading import Event
from typing import Any

import fiona
import pytest

from eolab_app.catalog.geopackage import build_stac_items
from eolab_app.vector.assessment import VectorAssessmentFinalizer
from eolab_app.vector.fields import OgrVectorFieldReader
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import CatalogVectorCategoryRequest
from eolab_app.vector.sources import MountedVectorResolver, PublishedVectorRegistry
from eolab_app.vector.styling import VectorStyleService
from tests.test_vector_assessment import RecordingVectorAssessor, compatible_reader
from tests.test_vector_publication import StaticCatalog


class UnusedStyler:
    """Fail if category discovery unexpectedly reaches GeoServer styling."""

    async def apply_style(self, *_args: Any, **_kwargs: Any) -> str:
        """Reject an unexpected style operation.

        Args:
            *_args: Unexpected positional style arguments.
            **_kwargs: Unexpected keyword style arguments.

        Raises:
            AssertionError: Always, because summaries do not require GeoServer.
        """
        raise AssertionError("Category summary must not apply a GeoServer style")


def write_category_geopackage(path: Path) -> None:
    """Write repeated, null, numeric, and oversized category fixture values.

    Args:
        path: GeoPackage container path to create.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    geometry = {
        "type": "Polygon",
        "coordinates": [[(0, 0), (1, 0), (1, 1), (0, 0)]],
    }
    categories = ["A", "A", "A", "B", "B", "C", None, "x" * 300]
    with fiona.open(
        path,
        mode="w",
        driver="GPKG",
        layer="categories",
        crs="EPSG:4326",
        schema={
            "geometry": "Polygon",
            "properties": {
                "category": "str:512",
                "rank": "int",
                "score": "float",
                "observed": "date",
            },
        },
    ) as dataset:
        for index, category in enumerate(categories):
            dataset.write({
                "geometry": geometry,
                "properties": {
                    "category": category,
                    "rank": index % 2,
                    "score": float(index % 3),
                    "observed": "2026-08-31",
                },
            })


def assessed_category_item(tmp_path: Path) -> tuple[dict[str, Any], Path]:
    """Build one assessed Catalog Item around the category fixture.

    Args:
        tmp_path: Isolated mounted source root.

    Returns:
        Assessed Item and exact GeoPackage path.
    """
    source_path = tmp_path / "categories.gpkg"
    write_category_geopackage(source_path)
    item = build_stac_items(tmp_path, source_path)[0]
    resolver = MountedVectorResolver(tmp_path)
    item = asyncio.run(VectorAssessmentFinalizer(
        resolver,
        RecordingVectorAssessor(compatible_reader("polygon")),
    ).finalize(item))
    return item, source_path


def category_service(item: dict[str, Any], tmp_path: Path) -> VectorStyleService:
    """Create the real bounded-reader service without a GeoServer dependency.

    Args:
        item: Authoritative assessed Catalog Item.
        tmp_path: Mounted source root.

    Returns:
        Vector style service using the production OGR batch field adapter.
    """
    return VectorStyleService(
        StaticCatalog(item),
        MountedVectorResolver(tmp_path),
        UnusedStyler(),
        PublishedVectorRegistry(),
        OgrVectorFieldReader(),
    )


def test_category_service_returns_typed_complete_ranked_summary(
    tmp_path: Path,
) -> None:
    """Rank safe values and expose explicit completeness and limits.

    Args:
        tmp_path: Isolated mounted source root.
    """
    item, _ = assessed_category_item(tmp_path)
    request = CatalogVectorCategoryRequest(
        collectionId=item["collection"],
        itemId=item["id"],
        field="category",
    )

    summary = asyncio.run(category_service(item, tmp_path).summarize_categories(
        request
    ))

    assert [(entry.value.kind, entry.value.value, entry.count) for entry in summary.values] == [
        ("string", "A", 3),
        ("string", "B", 2),
        ("string", "C", 1),
    ]
    assert summary.feature_count == summary.scanned_feature_count == 8
    assert summary.observed_distinct_count == summary.distinct_count == 3
    assert summary.null_count == 1
    assert summary.unsupported_value_count == 1
    assert summary.complete is True
    assert summary.default_limit == 20
    assert summary.maximum_limit == 50


def test_fiona_reader_is_feature_bounded_and_cooperatively_cancelled(
    tmp_path: Path,
) -> None:
    """Stop after the caller's row cap and honor a pre-set cancel signal.

    Args:
        tmp_path: Isolated mounted source root.
    """
    item, _ = assessed_category_item(tmp_path)
    source = MountedVectorResolver(tmp_path).resolve(item)
    reader = OgrVectorFieldReader()

    partial = reader.read_categories(source, "category", 4, Event())
    cancelled = Event()
    cancelled.set()
    empty = reader.read_categories(source, "category", 4, cancelled)

    assert partial.scanned_feature_count == 4
    assert partial.complete is False
    assert partial.counts == (("A", 3), ("B", 1))
    assert empty.scanned_feature_count == 0
    assert empty.complete is False


def test_category_service_rejects_stale_sources_and_non_scalar_fields(
    tmp_path: Path,
) -> None:
    """Recheck assessment signatures and reject date fields at the owner.

    Args:
        tmp_path: Isolated mounted source root.
    """
    item, source_path = assessed_category_item(tmp_path)
    service = category_service(item, tmp_path)
    date_request = CatalogVectorCategoryRequest(
        collectionId=item["collection"],
        itemId=item["id"],
        field="observed",
    )
    with pytest.raises(VectorConflictError, match="text, integer, number"):
        asyncio.run(service.summarize_categories(date_request))

    with fiona.open(source_path, mode="a", layer="categories") as dataset:
        dataset.write({
            "geometry": {
                "type": "Polygon",
                "coordinates": [[(0, 0), (1, 0), (1, 1), (0, 0)]],
            },
            "properties": {
                "category": "changed",
                "rank": 1,
                "score": 1.0,
                "observed": "2026-09-01",
            },
        })
    category_request = CatalogVectorCategoryRequest(
        collectionId=item["collection"],
        itemId=item["id"],
        field="category",
    )

    with pytest.raises(VectorConflictError, match="reassess"):
        asyncio.run(service.summarize_categories(category_request))
