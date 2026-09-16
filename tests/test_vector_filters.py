"""Exercise vector filter semantics, exact reads, authorization, and delivery."""

import asyncio
from pathlib import Path
from threading import Event
from xml.etree import ElementTree as ET

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from eolab_app.rendering.errors import PublishedLayerChangedError
from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.routes.wms_proxy import create_wms_proxy_router
from eolab_app.routes.vectors import create_vector_feature
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.fields import OgrVectorFieldReader
from eolab_app.vector.filters import (
    OGC, SLD, CatalogVectorFilterRequest, VectorFilter, VectorFilterCount,
    filter_ecql, filter_vector_sld, matches_filter, validate_filter,
)
from eolab_app.vector.models import CatalogVectorRequest
from eolab_app.vector.publication import VectorPublicationService
from eolab_app.vector.sources import MountedVectorResolver, PublishedVectorRegistry
from eolab_app.vector.styles import build_vector_sld, default_vector_style
from tests.test_vector_categories import assessed_category_item
from tests.test_vector_publication import StaticCatalog, RecordingPublisher


def predicate(*rules, match="all", enabled=True):
    """Construct a bounded test predicate.

    Args:
        *rules: Field/operator/value triples.
        match: Boolean group mode.
        enabled: Whether the rule set restricts the view.

    Returns:
        Validated structural filter model.
    """
    return VectorFilter(enabled=enabled, match=match, rules=[
        {"field": field, "operator": operator, "value": value}
        for field, operator, value in rules
    ])


def context(tmp_path, reader=None):
    """Publish a real assessed fixture through the vector application boundary.

    Args:
        tmp_path: Isolated mounted source root.
        reader: Optional bounded reader override.

    Returns:
        Service, registry, authoritative Item, publication, and source path.
    """
    item, path = assessed_category_item(tmp_path)
    registry = PublishedVectorRegistry()
    service = VectorPublicationService(
        StaticCatalog(item), MountedVectorResolver(tmp_path), RecordingPublisher(),
        registry, field_reader=reader or OgrVectorFieldReader(),
    )
    publication = asyncio.run(service.publish(CatalogVectorRequest(
        collectionId=item["collection"], itemId=item["id"],
    )))
    return service, registry, item, publication, path


def request_for(item, candidate):
    """Build a browser-safe request for an authoritative fixture.

    Args:
        item: Assessed Catalog Item.
        candidate: Bounded rule builder state.

    Returns:
        Public filter request with no source path.
    """
    return CatalogVectorFilterRequest(collectionId=item["collection"], itemId=item["id"], filter=candidate)


def test_boolean_groups_nulls_literal_text_and_disabled_rules():
    """Keep logical/null behavior explicit and treat expression-like text literally."""
    fields = {"year": "int", "mag": "float", "name": "str", "ok": "bool", "date": "date"}
    candidate = validate_filter(predicate(("year", "gt", 2020), ("mag", "ge", 5)), fields)
    assert matches_filter(candidate, {"year": 2021, "mag": 5})
    assert not matches_filter(candidate, {"year": 2020, "mag": 9})
    assert not matches_filter(candidate, {"year": 2021, "mag": None})
    assert matches_filter(candidate.model_copy(update={"enabled": False}), {})
    assert matches_filter(predicate(("year", "gt", 2020), ("mag", "missing", None), match="any"), {"year": 1990})
    assert not matches_filter(predicate(("name", "ne", "A")), {"name": None})
    literal = "O'Brien %_ *? AND year > 2020"
    text = validate_filter(predicate(("name", "contains", literal)), fields)
    assert matches_filter(text, {"name": f"prefix {literal} suffix"})
    assert not matches_filter(text, {"name": literal.lower()})
    assert "O''Brien" in filter_ecql(text)
    assert "strIndexOf" in filter_ecql(text)
    assert matches_filter(validate_filter(predicate(("ok", "eq", False)), fields), {"ok": False})
    assert matches_filter(validate_filter(predicate(("date", "gt", "2020-01-01")), fields), {"date": "2021-01-01"})


@pytest.mark.parametrize("rule", [
    ("absent", "eq", 1), ("year", "contains", "2"), ("year", "eq", "2020"),
    ("year", "eq", True), ("name", "gt", "A"), ("ok", "eq", "true"),
    ("date", "eq", "2021-02-30"), ("year", "missing", 0),
])
def test_catalog_rejects_unknown_fields_and_type_mismatches(rule):
    """Reject incompatible rules before any rendering or count.

    Args:
        rule: Invalid Catalog comparison triple.
    """
    with pytest.raises(VectorConflictError):
        validate_filter(predicate(rule), {"year": "int", "name": "str", "ok": "bool", "date": "date"})


def test_public_filter_contract_rejects_expressions_unbounded_input_and_nonfinite_values():
    """Reject executable extensions, unsafe numbers, control text, and excess rules."""
    for value in [float("inf"), float("nan"), 2**54, "a" * 257, "a\x00b"]:
        with pytest.raises(ValidationError):
            predicate(("field", "eq", value))
    with pytest.raises(ValidationError):
        VectorFilter(expression="year > 2020")
    with pytest.raises(ValidationError):
        predicate(*[("year", "gt", 2020)] * 13)
    quoted = predicate(('strange"field', "eq", "' OR INCLUDE"))
    assert '"strange""field"' in filter_ecql(quoted)
    assert "''' OR INCLUDE'" in filter_ecql(quoted)


def test_exact_counts_and_partial_counts_share_bounded_field_reader(tmp_path):
    """Count the complete source, omit partial numbers, and honor cancellation.

    Args:
        tmp_path: Isolated vector source fixture root.
    """
    item, _ = assessed_category_item(tmp_path)
    source = MountedVectorResolver(tmp_path).resolve(item)
    reader = OgrVectorFieldReader()
    candidate = predicate(("category", "eq", "A"), ("score", "ge", 1))
    exact = reader.count_filter(source, candidate, 8, Event())
    assert exact == VectorFilterCount(matched=2, total=8, complete=True)
    assert reader.count_filter(source, candidate, 4, Event()) == VectorFilterCount()
    cancel = Event(); cancel.set()
    assert reader.count_filter(source, candidate, 8, cancel) == VectorFilterCount()
    assert reader.count_filter(source, predicate(("observed", "ge", "2026-08-01")), 8, Event()).matched == 8


def test_filtered_publications_are_isolated_current_bounded_and_style_preserving(tmp_path):
    """Keep base authorization unchanged and invalidate stale or evicted aliases.

    Args:
        tmp_path: Isolated assessed mounted source.
    """
    service, registry, item, publication, path = context(tmp_path)
    candidate = predicate(("score", "ge", 1))
    applied = asyncio.run(service.apply_filter(request_for(item, candidate)))
    other = asyncio.run(service.apply_filter(request_for(item, predicate(("score", "ge", 2)))))
    assert applied.layerName != other.layerName != publication.layer_name
    assert registry.require_current(publication.layer_name).filter is None
    authorization = registry.require_current(applied.layerName)
    assert authorization.filter == candidate
    assert authorization.upstream_layer_name == publication.layer_name
    assert authorization.style_name == publication.style_name
    document = authorization.build_composite_sld(applied.layerName, publication.style_name, None,
        publication.style.model_dump(by_alias=True), 1)
    root = ET.fromstring(document)
    assert root.find(f"{{{SLD}}}NamedLayer/{{{SLD}}}Name").text == publication.layer_name
    assert all(rule.find(f"{{{OGC}}}Filter") is not None for rule in root.iter(f"{{{SLD}}}Rule"))
    result = asyncio.run(service.count_filter(request_for(item, candidate)))
    assert result == VectorFilterCount(matched=5, total=8, complete=True)
    assert asyncio.run(service.count_filter(request_for(item, candidate))) == result
    disabled = asyncio.run(service.apply_filter(request_for(item, candidate.model_copy(update={"enabled": False}))))
    assert disabled.layerName == publication.layer_name
    for number in range(257):
        registry.authorize_filter(publication.layer_name, predicate(("score", "ge", number + 1000)))
    with pytest.raises(PublishedLayerChangedError, match="expired"):
        registry.require_current(other.layerName)
    current = registry.authorize_filter(publication.layer_name, candidate)
    path.touch()
    with pytest.raises(PublishedLayerChangedError):
        registry.require_current(current)
    with pytest.raises(VectorConflictError):
        asyncio.run(service.count_filter(request_for(item, candidate)))


def test_selection_intersects_category_else_rules_and_label_rules():
    """Preserve the category complement and restrict the independent label rule."""
    document = f'''<sld:StyledLayerDescriptor xmlns:sld="{SLD}" xmlns:ogc="{OGC}">
      <sld:NamedLayer><sld:UserStyle><sld:FeatureTypeStyle>
      <sld:Rule><sld:Name>A</sld:Name><ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>category</ogc:PropertyName><ogc:Literal>A</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter><sld:PolygonSymbolizer/></sld:Rule>
      <sld:Rule><sld:Name>Other</sld:Name><sld:ElseFilter/><sld:PolygonSymbolizer/></sld:Rule>
      </sld:FeatureTypeStyle><sld:FeatureTypeStyle><sld:Rule><sld:Name>Label</sld:Name><sld:TextSymbolizer/></sld:Rule></sld:FeatureTypeStyle>
      </sld:UserStyle></sld:NamedLayer></sld:StyledLayerDescriptor>'''.encode()
    root = ET.fromstring(filter_vector_sld(document, predicate(("score", "gt", 1))))
    rules = list(root.iter(f"{{{SLD}}}Rule"))
    assert len(rules) == 3
    assert all(rule.find(f"{{{OGC}}}Filter") is not None for rule in rules)
    assert rules[1].find(f"{{{SLD}}}ElseFilter") is None
    assert rules[1].find(f"{{{OGC}}}Filter/{{{OGC}}}And/{{{OGC}}}Not/{{{OGC}}}PropertyIsEqualTo") is not None
    assert [child.tag for child in rules[2]] == [f"{{{SLD}}}Name", f"{{{OGC}}}Filter", f"{{{SLD}}}TextSymbolizer"]


def test_filter_wms_boundary_translates_render_inspection_and_highlight(tmp_path):
    """Apply one server-owned predicate through the real restricted WMS route.

    Args:
        tmp_path: Isolated assessed vector fixture.
    """
    service, registry, item, publication, _ = context(tmp_path)
    applied = asyncio.run(service.apply_filter(request_for(item, predicate(("score", "ge", 1)))))
    captured = []

    def upstream(request):
        """Record authorized requests without allowing arbitrary filter input.

        Args:
            request: Internal GeoServer HTTP request.

        Returns:
            Bounded test map or feature information response.
        """
        captured.append(dict(request.url.params))
        if request.url.params.get("request") == "GetFeatureInfo":
            return httpx2.Response(200, json={"type": "FeatureCollection", "features": []})
        return httpx2.Response(200, content=b"png", headers={"content-type": "image/png"})

    app = FastAPI()
    client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    app.include_router(create_wms_proxy_router(client, "http://geoserver/geoserver", (registry,), GetMapRequestTracker(2)))
    params = {"service": "WMS", "version": "1.1.1", "request": "GetMap", "layers": applied.layerName,
        "styles": publication.style_name, "srs": "EPSG:4326", "bbox": "-1,-1,2,2", "width": "256", "height": "256", "format": "image/png", "tiled": "true"}
    with TestClient(app) as browser:
        assert browser.get("/geoserver/eolab/wms", params=params).status_code == 200
        assert captured[-1]["layers"] == publication.layer_name
        assert "tiled" not in captured[-1]
        assert '"score" >= 1' in captured[-1]["cql_filter"]
        info = {**params, "request": "GetFeatureInfo", "query_layers": applied.layerName, "info_format": "application/json", "feature_count": "5", "x": "128", "y": "128"}
        info.pop("tiled")
        assert browser.get("/geoserver/eolab/wms", params=info).status_code == 200
        assert captured[-1]["query_layers"] == publication.layer_name
        assert browser.get("/geoserver/eolab/wms", params={**params, "styles": "vector-highlight-polygon", "featureid": "categories.1"}).status_code == 200
        assert "AND IN ('categories.1')" in captured[-1]["cql_filter"]
        assert "featureid" not in captured[-1]
        assert browser.get("/geoserver/eolab/wms", params={**params, "cql_filter": "INCLUDE"}).status_code == 400
    asyncio.run(client.aclose())


def test_count_cancellation_holds_capacity_until_worker_exits(tmp_path):
    """Keep bounded reader slots occupied during cooperative cancellation.

    Args:
        tmp_path: Isolated mounted source fixture.
    """
    started, release = Event(), Event()

    class BlockingReader:
        """Simulate a reader inside a bounded native read when canceled."""

        def count_filter(self, source, candidate, feature_limit, cancel_event):
            """Retain the worker until the controlled native read completes.

            Args:
                source: Authorized source.
                candidate: Validated filter.
                feature_limit: Bounded row count.
                cancel_event: Cooperative cancellation signal.

            Returns:
                Unavailable count after cancellation.
            """
            started.set()
            release.wait(3)
            assert cancel_event.is_set()
            return VectorFilterCount()

    service, _, item, _, _ = context(tmp_path, BlockingReader())
    service._filter_slots = asyncio.Semaphore(1)
    request = request_for(item, predicate(("score", "ge", 1)))

    async def exercise():
        """Cancel the HTTP owner and verify a second caller cannot start a scan.

        Returns:
            None after the worker has released its held slot.
        """
        task = asyncio.create_task(service.count_filter(request))
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert service._filter_slots.locked()
        assert await service.count_filter(request) == VectorFilterCount()
        release.set()
        await asyncio.sleep(0.05)
        assert not service._filter_slots.locked()

    asyncio.run(exercise())


def test_filter_routes_validate_catalog_fields_and_return_exact_counts(tmp_path):
    """Exercise thin HTTP filter/count delivery with the production vector owner.

    Args:
        tmp_path: Isolated assessed source fixture.
    """
    service, registry, item, _, _ = context(tmp_path)
    app = FastAPI()
    app.include_router(create_vector_feature(None, service, None, registry).router)
    body = request_for(item, predicate(("score", "ge", 1))).model_dump(by_alias=True, mode="json")
    with TestClient(app) as browser:
        applied = browser.post("/api/vector-rendering/filters", json=body)
        assert applied.status_code == 200
        assert applied.json()["layerName"].startswith("eolab:filtered-")
        count = browser.post("/api/vector-rendering/filter-counts", json=body)
        assert count.status_code == 200
        assert count.json() == {"matched": 5, "total": 8, "complete": True}
        assert browser.post("/api/vector-rendering/filters", json={**body, "path": "/tmp/other.gpkg"}).status_code == 422
        body["filter"]["rules"][0]["field"] = "untrusted_field"
        assert browser.post("/api/vector-rendering/filters", json=body).status_code == 409
