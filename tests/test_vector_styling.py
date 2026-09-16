"""Test validated vector styles, authoritative workflow, and GeoServer SLDs."""

import asyncio
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import httpx2
import pytest
from pydantic import ValidationError

from eolab_app.rendering.geoserver import GEOSERVER_WORKSPACE_NAME
from eolab_app.vector.errors import VectorConflictError, VectorPublicationError
from eolab_app.vector.fields import OgrVectorFieldReader
from eolab_app.vector.geoserver import GeoServerVectorPublisher
from eolab_app.vector.models import (
    CatalogVectorStyleRequest,
    CatalogVectorNumericClassificationRequest,
    VectorLabelStyle,
    VectorStyle,
    VectorStylePublication,
)
from eolab_app.vector.sources import (
    MountedVectorResolver,
    PublishedVectorRegistry,
    vector_source_signature,
)
from eolab_app.vector.styles import (
    OGC_NAMESPACE,
    SLD_NAMESPACE,
    build_vector_sld,
    default_vector_style,
    vector_label_rendering_buffer,
    vector_style_name,
)
from eolab_app.vector.styling import VectorStyleService
from tests.test_vector_publication import StaticCatalog, assessed_geopackage_item
from tests.test_vector_categories import assessed_category_item


class RecordingStyler:
    """Record server-derived resource identities and validated styles."""

    def __init__(self) -> None:
        """Create an empty style request log."""
        self.requests: list[tuple[str, VectorStyle]] = []

    async def apply_style(
        self,
        resource_name: str,
        style: VectorStyle,
    ) -> VectorStylePublication:
        """Record one style request and return its deterministic name.

        Args:
            resource_name: Server-derived layer resource name.
            style: Validated vector style.

        Returns:
            Style identity and published geometry attribute.
        """
        self.requests.append((resource_name, style))
        return VectorStylePublication(
            vector_style_name(resource_name, style, geometry_name="shape"), "shape",
        )


class UnusedFieldReader:
    """Fail if an apply-only test unexpectedly reads source field values."""

    def read_categories(self, *_args: Any, **_kwargs: Any) -> None:
        """Reject an unexpected category read.

        Args:
            *_args: Unexpected positional category-reader arguments.
            **_kwargs: Unexpected keyword category-reader arguments.

        Raises:
            AssertionError: Always, because apply tests must not read values.
        """
        raise AssertionError("Category reader must not run while applying a style")

    def read_numbers(self, *_args: Any, **_kwargs: Any) -> None:
        """Reject an unexpected numeric read.

        Args:
            *_args: Unexpected positional field-reader arguments.
            **_kwargs: Unexpected keyword field-reader arguments.

        Raises:
            AssertionError: Always, because these apply tests use fixed or
                categorical styles.
        """
        raise AssertionError("Numeric reader must not run while applying a style")


def polygon_request(
    item: dict[str, Any],
    geometry_kind: str = "polygon",
    label_field: str | None = None,
) -> CatalogVectorStyleRequest:
    """Build one style request for an assessed Item.

    Args:
        item: Authoritative catalog Item.
        geometry_kind: Requested geometry class.
        label_field: Optional authoritative field selected for labels.

    Returns:
        Validated style request.
    """
    style: dict[str, Any] = {
        "geometryKind": geometry_kind,
        "strokeColor": "#112233",
        "strokeOpacity": 0.8,
        "strokeWidth": 2.5,
    }
    if geometry_kind != "line":
        style.update(fillColor="#abcdef", fillOpacity=0.45)
    if geometry_kind == "point":
        style["pointSize"] = 11
    if label_field is not None:
        style["label"] = {
            "field": label_field,
            "fontFamily": "SansSerif",
            "fontSize": 12,
            "fontWeight": "normal",
            "fontColor": "#112233",
            "haloColor": "#FFFFFF",
            "haloWidth": 1.5,
            "placement": (
                "follow-line" if geometry_kind == "line" else "center"
            ),
            "minimumZoom": 6,
        }
    return CatalogVectorStyleRequest(
        collectionId=item["collection"],
        itemId=item["id"],
        style=style,
    )


def test_style_model_requires_geometry_specific_controls() -> None:
    """Normalize colors and reject controls belonging to another geometry."""
    line = VectorStyle(
        geometryKind="line",
        strokeColor="#F97316",
        strokeOpacity=1,
        strokeWidth=3,
    )

    assert line.stroke_color == "#f97316"
    assert line.label is None
    with pytest.raises(ValidationError):
        VectorStyle(
            geometryKind="line",
            fillColor="#ffffff",
            fillOpacity=1,
            strokeColor="#000000",
            strokeOpacity=1,
            strokeWidth=2,
        )
    with pytest.raises(ValidationError, match="follow line"):
        VectorStyle(
            geometryKind="point",
            fillColor="#ffffff",
            fillOpacity=1,
            strokeColor="#000000",
            strokeOpacity=1,
            strokeWidth=2,
            pointSize=8,
            label={
                "field": "name",
                "fontFamily": "SansSerif",
                "fontSize": 12,
                "fontWeight": "normal",
                "fontColor": "#000000",
                "haloColor": "#ffffff",
                "haloWidth": 1,
                "placement": "follow-line",
                "minimumZoom": 4,
            },
        )
    with pytest.raises(ValidationError):
        VectorStyle(
            geometryKind="point",
            fillColor="#ffffff",
            fillOpacity=1,
            strokeColor="#000000",
            strokeOpacity=1,
            strokeWidth=2,
        )


@pytest.mark.parametrize(
    (
        "geometry_kind",
        "fill_color",
        "fill_opacity",
        "stroke_color",
        "stroke_opacity",
    ),
    [
        ("point", "#2b83ba", 0.7, "#000000", 1),
        ("line", None, None, "#2b83ba", 1),
        ("polygon", "#2b83ba", 0.7, "#000000", 1),
    ],
)
def test_default_vector_styles_use_translucent_fills_and_black_outlines(
    geometry_kind: str,
    fill_color: str | None,
    fill_opacity: float | None,
    stroke_color: str,
    stroke_opacity: float,
) -> None:
    """Keep default vector colors and geometry-safe opacity explicit.

    Args:
        geometry_kind: Geometry family whose default is under test.
        fill_color: Expected fill, absent for lines.
        fill_opacity: Expected fill opacity, absent for lines.
        stroke_color: Expected outline or line color.
        stroke_opacity: Expected visible outline or line opacity.

    Returns:
        None.
    """
    style = default_vector_style(geometry_kind)

    assert style.fill_color == fill_color
    assert style.fill_opacity == fill_opacity
    assert style.stroke_color == stroke_color
    assert style.stroke_opacity == stroke_opacity
    assert style.stroke_width == (2 if geometry_kind == "line" else 0.75)


@pytest.mark.parametrize("geometry_kind", ["point", "line", "polygon"])
def test_initialized_vector_slds_match_generated_defaults(
    geometry_kind: str,
) -> None:
    """Keep bootstrap GeoServer styles aligned with canonical defaults."""
    initialized = ElementTree.fromstring(
        (Path("geoserver") / f"vector-{geometry_kind}.sld").read_bytes()
    )
    generated = ElementTree.fromstring(
        build_vector_sld(
            f"vector-{geometry_kind}",
            default_vector_style(geometry_kind),
        )
    )

    def parameters(root: ElementTree.Element) -> list[tuple[str, str]]:
        return [
            (parameter.attrib["name"], parameter.text or "")
            for parameter in root.findall(f".//{{{SLD_NAMESPACE}}}CssParameter")
        ]

    assert parameters(initialized) == parameters(generated)


@pytest.mark.parametrize("geometry_kind", ["point", "line", "polygon"])
def test_selected_vector_slds_render_only_a_dark_outline(
    geometry_kind: str,
) -> None:
    """Keep feature selection above the map without repainting its fill."""
    initialized = ElementTree.parse(
        Path("geoserver") / f"vector-highlight-{geometry_kind}.sld"
    )

    assert initialized.findall(f".//{{{SLD_NAMESPACE}}}Fill") == []
    stroke_colors = initialized.findall(
        f".//{{{SLD_NAMESPACE}}}CssParameter[@name='stroke']"
    )
    assert [parameter.text for parameter in stroke_colors] == ["#111827"]


@pytest.mark.parametrize(
    ("geometry_kind", "symbolizer"),
    [
        ("point", "PointSymbolizer"),
        ("line", "LineSymbolizer"),
        ("polygon", "PolygonSymbolizer"),
    ],
)
def test_sld_generation_uses_only_the_geometry_symbolizer(
    geometry_kind: str,
    symbolizer: str,
) -> None:
    """Serialize complete safe geometry-specific SLD parameters.

    Args:
        geometry_kind: Default style geometry.
        symbolizer: Expected SLD symbolizer element.
    """
    style_name = "vector-style-0123456789abcdef01234567-89abcdef0123"
    root = ElementTree.fromstring(
        build_vector_sld(style_name, default_vector_style(geometry_kind))
    )
    namespace = {"sld": SLD_NAMESPACE}

    assert root.find(f".//sld:{symbolizer}", namespace) is not None
    assert sum(
        root.find(f".//sld:{candidate}", namespace) is not None
        for candidate in (
            "PointSymbolizer",
            "LineSymbolizer",
            "PolygonSymbolizer",
        )
    ) == 1
    parameter_names = {
        parameter.attrib["name"]
        for parameter in root.findall(".//sld:CssParameter", namespace)
    }
    assert {"stroke", "stroke-opacity", "stroke-width"} <= parameter_names
    assert ("fill" in parameter_names) is (geometry_kind != "line")


@pytest.mark.parametrize(
    ("geometry_kind", "placement", "placement_element"),
    [
        ("point", "above", "PointPlacement"),
        ("line", "follow-line", "LinePlacement"),
        ("line", "center", "PointPlacement"),
        ("polygon", "center", "PointPlacement"),
    ],
)
@pytest.mark.parametrize("minimum_zoom", [0, 6])
def test_sld_generation_adds_independently_scaled_vector_labels(
    geometry_kind: str,
    placement: str,
    placement_element: str,
    minimum_zoom: int,
) -> None:
    """Serialize authoritative fields, font, halo, placement, and scale.

    Args:
        geometry_kind: Point, line, or polygon style family.
        placement: Geometry-appropriate label placement.
        placement_element: Expected SLD placement element.
        minimum_zoom: Zero for all scales, or an explicit label cutoff.

    Returns:
        None. Asserts the public SLD output for every geometry and scale policy.
    """
    base_style = default_vector_style(geometry_kind)
    label = VectorLabelStyle(
        field="display name",
        fontFamily="Serif",
        fontSize=14,
        fontWeight="bold",
        fontColor="#123456",
        haloColor="#FEDCBA",
        haloWidth=2,
        placement=placement,
        minimumZoom=minimum_zoom,
    )
    style = VectorStyle.model_validate({
        **base_style.model_dump(by_alias=True),
        "label": label.model_dump(by_alias=True),
    })
    root = ElementTree.fromstring(build_vector_sld("labeled-style", style, geometry_name="shape"))
    namespaces = {"sld": SLD_NAMESPACE, "ogc": OGC_NAMESPACE}

    assert len(root.findall(".//sld:Rule", namespaces)) == 2
    assert root.find(
        f".//sld:{placement_element}", namespaces
    ) is not None
    assert root.find(".//sld:Label/ogc:PropertyName", namespaces).text == "display name"
    maximum_scale = root.find(".//sld:MaxScaleDenominator", namespaces)
    if minimum_zoom == 0:
        assert maximum_scale is None
    else:
        assert float(maximum_scale.text) == pytest.approx(559082264.0287178 / 64)
    text_symbolizer = root.find(".//sld:TextSymbolizer", namespaces)
    font_parameters = {
        parameter.attrib["name"]: parameter.text
        for parameter in text_symbolizer.findall(
            "./sld:Font/sld:CssParameter", namespaces
        )
    }
    assert font_parameters["font-family"] == "Serif"
    assert font_parameters["font-weight"] == "bold"
    assert font_parameters["font-size"] == "14"
    assert text_symbolizer.find(
        "./sld:Halo/sld:Fill/sld:CssParameter", namespaces
    ).text == "#fedcba"
    assert text_symbolizer.find(
        "./sld:Fill/sld:CssParameter", namespaces
    ).text == "#123456"
    vendor_options = {
        option.attrib["name"]: option.text
        for option in text_symbolizer.findall("./sld:VendorOption", namespaces)
    }
    assert vendor_options["conflictResolution"] == "false"
    assert vendor_options.get("goodnessOfFit") == (
        "0" if geometry_kind == "polygon" else None
    )
    fixed_placement = geometry_kind != "line" or placement == "center"
    assert ("followLine" in vendor_options) is not fixed_placement
    assert vendor_options.get("partials") == ("true" if fixed_placement else None)
    assert vendor_options.get("autoWrap") == ("168" if fixed_placement else None)
    anchor = text_symbolizer.find("./sld:Geometry/ogc:Function", namespaces)
    if geometry_kind == "polygon" or (geometry_kind == "line" and fixed_placement):
        assert anchor.attrib["name"] == ("interiorPoint" if geometry_kind == "polygon" else "centroid")
        assert anchor.find("ogc:PropertyName", namespaces).text == "shape"
        assert list(text_symbolizer)[0].tag == f"{{{SLD_NAMESPACE}}}Geometry"
    else:
        assert anchor is None
    child_names = [child.tag.rsplit("}", 1)[-1] for child in text_symbolizer]
    assert child_names.index("Fill") < child_names.index("VendorOption")


def test_sld_generation_uses_typed_categories_and_separate_label_style() -> None:
    """Keep equality, null, and else rules independent from label rendering."""
    style = VectorStyle.model_validate({
        **default_vector_style("polygon").model_dump(by_alias=True),
        "categorical": {
            "field": "risk class",
            "limit": 20,
            "rules": [
                {
                    "value": {"kind": "string", "value": "High & rising"},
                    "color": "#d60000",
                },
                {
                    "value": {"kind": "string", "value": "Low"},
                    "color": "#018700",
                },
            ],
            "otherColor": "#9ca3af",
            "missingColor": "#d1d5db",
        },
        "label": {
            "field": "name",
            "fontFamily": "SansSerif",
            "fontSize": 12,
            "fontWeight": "normal",
            "fontColor": "#111827",
            "haloColor": "#ffffff",
            "haloWidth": 1.5,
            "placement": "center",
            "minimumZoom": 4,
        },
    })

    root = ElementTree.fromstring(build_vector_sld("categories", style, geometry_name="shape"))
    namespaces = {"sld": SLD_NAMESPACE, "ogc": OGC_NAMESPACE}
    feature_styles = root.findall(".//sld:FeatureTypeStyle", namespaces)
    geometry_rules = feature_styles[0].findall("./sld:Rule", namespaces)

    assert len(feature_styles) == 2
    assert len(geometry_rules) == 4
    assert [
        literal.text
        for literal in feature_styles[0].findall(".//ogc:Literal", namespaces)
    ] == ["High & rising", "Low"]
    assert feature_styles[0].find(".//ogc:PropertyIsNull", namespaces) is not None
    assert feature_styles[0].find(".//sld:ElseFilter", namespaces) is not None
    assert feature_styles[1].find(".//sld:TextSymbolizer", namespaces) is not None
    fill_colors = [
        parameter.text
        for parameter in feature_styles[0].findall(
            ".//sld:CssParameter[@name='fill']",
            namespaces,
        )
    ]
    assert fill_colors == ["#d60000", "#018700", "#d1d5db", "#9ca3af"]


def test_sld_generation_uses_open_numeric_ranges_and_missing_rule() -> None:
    """Serialize graduated bounds without gaps or duplicate null rendering."""
    style = VectorStyle.model_validate({
        **default_vector_style("polygon").model_dump(by_alias=True),
        "graduated": {
            "field": "score",
            "method": "equal-interval",
            "classCount": 3,
            "palette": "blues",
            "rules": [
                {"minimum": None, "maximum": 1.0, "color": "#f7fbff"},
                {"minimum": 1.0, "maximum": 2.0, "color": "#6baed6"},
                {"minimum": 2.0, "maximum": None, "color": "#08306b"},
            ],
            "missingColor": "#d1d5db",
        },
    })

    root = ElementTree.fromstring(build_vector_sld("graduated", style, geometry_name="shape"))
    namespaces = {"sld": SLD_NAMESPACE, "ogc": OGC_NAMESPACE}
    rules = root.findall(".//sld:FeatureTypeStyle/sld:Rule", namespaces)

    assert len(rules) == 4
    assert root.find(".//ogc:PropertyIsGreaterThan", namespaces) is not None
    assert root.find(".//ogc:PropertyIsLessThanOrEqualTo", namespaces) is not None
    assert root.find(".//ogc:And", namespaces) is not None
    assert root.find(".//ogc:PropertyIsNull", namespaces) is not None
    assert root.find(".//sld:ElseFilter", namespaces) is None


def test_vector_style_name_changes_only_with_resource_or_rendering() -> None:
    """Give each distinct layer rendering its own stable WMS cache identity."""
    resource_name = "geopackage-0123456789abcdef01234567"
    default_style = default_vector_style("point")
    changed_style = VectorStyle(
        geometryKind="point",
        fillColor="#00ff66",
        fillOpacity=0.65,
        strokeColor="#083344",
        strokeOpacity=1,
        strokeWidth=1.5,
        pointSize=14,
    )

    assert vector_style_name(resource_name, default_style) == (
        vector_style_name(resource_name, default_style)
    )
    assert vector_style_name(resource_name, default_style) != (
        vector_style_name(resource_name, changed_style)
    )
    assert vector_style_name(resource_name, default_style) != (
        vector_style_name("another-resource", default_style)
    )


def test_vector_style_identity_includes_generated_rendering_policy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Invalidate cached tiles when SLD policy changes for saved settings.

    Args:
        monkeypatch: Fixture replacing the SLD generator at its owning boundary.

    Returns:
        None. Asserts that unchanged settings acquire a new rendering identity.
    """
    style = default_vector_style("polygon")
    before = vector_style_name("polygon-resource", style)

    def changed_renderer(
        style_name: str, style: VectorStyle, *, geometry_name: str | None = None,
    ) -> bytes:
        """Simulate a deployment changing its generated SLD policy.

        Args:
            style_name: Stable style name passed to the generator.
            style: Complete validated appearance to render.
            geometry_name: Authorized geometry carried through the SLD contract.

        Returns:
            Valid XML with distinct generated content.
        """
        return build_vector_sld(style_name, style, geometry_name=geometry_name) + b"<!-- updated policy -->"

    monkeypatch.setattr("eolab_app.vector.styles.build_vector_sld", changed_renderer)
    assert vector_style_name("polygon-resource", style) != before


def test_style_service_uses_catalog_identity_and_current_publication(
    tmp_path: Path,
) -> None:
    """Apply only through authoritative source and registry identities.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    item, _ = assessed_geopackage_item(tmp_path)
    resolver = MountedVectorResolver(tmp_path)
    source = resolver.resolve(item)
    signature = vector_source_signature(source)
    registry = PublishedVectorRegistry()
    registry.authorize(
        f"{GEOSERVER_WORKSPACE_NAME}:{item['id']}",
        source,
        signature,
        "vector-polygon",
    )
    styler = RecordingStyler()
    service = VectorStyleService(
        StaticCatalog(item),
        resolver,
        styler,
        registry,
        UnusedFieldReader(),
    )
    request = polygon_request(item, label_field="name")

    result = asyncio.run(service.apply(request))

    assert styler.requests == [(item["id"], request.style)]
    assert result.style == request.style
    authorization = registry.require_current(
        f"{GEOSERVER_WORKSPACE_NAME}:{item['id']}"
    )
    assert authorization.style_name == vector_style_name(
        item["id"], request.style, geometry_name="shape",
    )
    assert authorization.geometry_name == "shape"
    composite = authorization.build_composite_sld(
        f"eolab:{item['id']}", result.style_name, None,
        result.style.model_dump(by_alias=True), 0.5,
    )
    anchor = ElementTree.fromstring(composite).find(
        f".//{{{SLD_NAMESPACE}}}Geometry/{{{OGC_NAMESPACE}}}Function/{{{OGC_NAMESPACE}}}PropertyName"
    )
    assert anchor.text == "shape"


def test_style_service_rejects_unpublished_or_wrong_geometry(
    tmp_path: Path,
) -> None:
    """Reject missing authorization and client geometry disagreements.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    item, _ = assessed_geopackage_item(tmp_path)
    resolver = MountedVectorResolver(tmp_path)
    registry = PublishedVectorRegistry()
    service = VectorStyleService(
        StaticCatalog(item),
        resolver,
        RecordingStyler(),
        registry,
        UnusedFieldReader(),
    )
    with pytest.raises(VectorConflictError, match="add the current vector"):
        asyncio.run(service.apply(polygon_request(item)))
    source = resolver.resolve(item)
    registry.authorize(
        f"{GEOSERVER_WORKSPACE_NAME}:{item['id']}",
        source,
        vector_source_signature(source),
        "vector-polygon",
    )
    with pytest.raises(VectorConflictError, match="does not match"):
        asyncio.run(service.apply(polygon_request(item, "line")))


def test_style_service_rejects_label_fields_outside_authoritative_table(
    tmp_path: Path,
) -> None:
    """Reject a browser field that is absent from current Catalog metadata.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    item, _ = assessed_geopackage_item(tmp_path)
    resolver = MountedVectorResolver(tmp_path)
    source = resolver.resolve(item)
    registry = PublishedVectorRegistry()
    registry.authorize(
        f"{GEOSERVER_WORKSPACE_NAME}:{item['id']}",
        source,
        vector_source_signature(source),
        "vector-polygon",
    )
    service = VectorStyleService(
        StaticCatalog(item),
        resolver,
        RecordingStyler(),
        registry,
        UnusedFieldReader(),
    )

    with pytest.raises(VectorConflictError, match="authoritative vector Item"):
        asyncio.run(service.apply(polygon_request(
            item,
            label_field="browser-invented-field",
        )))


def test_style_service_revalidates_categorical_field_and_value_types(
    tmp_path: Path,
) -> None:
    """Reject a typed rule that disagrees with current Catalog field metadata.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    item, _ = assessed_geopackage_item(tmp_path)
    resolver = MountedVectorResolver(tmp_path)
    source = resolver.resolve(item)
    registry = PublishedVectorRegistry()
    registry.authorize(
        f"{GEOSERVER_WORKSPACE_NAME}:{item['id']}",
        source,
        vector_source_signature(source),
        "vector-polygon",
    )
    service = VectorStyleService(
        StaticCatalog(item),
        resolver,
        RecordingStyler(),
        registry,
        UnusedFieldReader(),
    )
    base_request = polygon_request(item)
    request = CatalogVectorStyleRequest(
        collectionId=item["collection"],
        itemId=item["id"],
        style={
            **base_request.style.model_dump(by_alias=True),
            "categorical": {
                "field": "name",
                "limit": 20,
                "rules": [{
                    "value": {"kind": "integer", "value": 1},
                    "color": "#d60000",
                }],
                "otherColor": "#9ca3af",
                "missingColor": None,
            },
        },
    )

    with pytest.raises(VectorConflictError, match="value type"):
        asyncio.run(service.apply(request))


@pytest.mark.parametrize("method", ["equal-interval", "percentile-interval"])
def test_style_service_revalidates_numeric_field_and_accepts_exact_ranges(
    tmp_path: Path,
    method: str,
) -> None:
    """Keep current-source checks while publishing valid user-entered breaks.

    Args:
        tmp_path: Isolated mounted scan source.
        method: Classification method used to validate the current field read.
    """
    item, _ = assessed_category_item(tmp_path)
    resolver = MountedVectorResolver(tmp_path)
    source = resolver.resolve(item)
    registry = PublishedVectorRegistry()
    registry.authorize(
        f"{GEOSERVER_WORKSPACE_NAME}:{item['id']}",
        source,
        vector_source_signature(source),
        "vector-polygon",
    )
    styler = RecordingStyler()
    service = VectorStyleService(
        StaticCatalog(item),
        resolver,
        styler,
        registry,
        OgrVectorFieldReader(),
    )
    summary = asyncio.run(service.classify_numeric(
        CatalogVectorNumericClassificationRequest(
            collectionId=item["collection"],
            itemId=item["id"],
            field="score",
            method=method,
            classCount=3,
        )
    ))
    colors = ("#f7fbff", "#6baed6", "#08306b")
    rules = [
        {
            "minimum": classification.minimum,
            "maximum": classification.maximum,
            "color": colors[index],
        }
        for index, classification in enumerate(summary.classes)
    ]
    valid_request = CatalogVectorStyleRequest(
        collectionId=item["collection"],
        itemId=item["id"],
        style={
            **default_vector_style("polygon").model_dump(by_alias=True),
            "graduated": {
                "field": "score",
                "method": method,
                "classCount": 3,
                "palette": "blue-yellow-red",
                "rules": rules,
                "missingColor": None,
            },
        },
    )

    applied = asyncio.run(service.apply(valid_request))

    assert applied.style.graduated is not None
    assert styler.requests == [(item["id"], valid_request.style)]
    drifted_rules = [dict(rule) for rule in rules]
    drifted_rules[0]["maximum"] = 0.5
    drifted_rules[1]["minimum"] = 0.5
    drifted_request = CatalogVectorStyleRequest(
        collectionId=item["collection"],
        itemId=item["id"],
        style={
            **default_vector_style("polygon").model_dump(by_alias=True),
            "graduated": {
                "field": "score",
                "method": method,
                "classCount": 3,
                "palette": "blue-yellow-red",
                "rules": drifted_rules,
                "missingColor": None,
            },
        },
    )
    exact = asyncio.run(service.apply(drifted_request))

    assert exact.style.graduated is not None
    assert exact.style.graduated.rules[0].maximum == 0.5
    assert exact.style.graduated.rules[1].minimum == 0.5
    assert styler.requests == [
        (item["id"], valid_request.style),
        (item["id"], drifted_request.style),
    ]


@pytest.mark.parametrize("attributes", [[], [{"name": "name", "binding": "java.lang.String"}], [
    {"name": "a", "binding": "org.locationtech.jts.geom.Polygon"},
    {"name": "b", "binding": "org.locationtech.jts.geom.Point"},
]])
def test_label_publication_rejects_missing_or_ambiguous_geometry(attributes: list[dict]) -> None:
    """Stop before style mutation when published geometry cannot be identified.

    Args:
        attributes: Missing, non-geometric, or ambiguous GeoServer schema.

    Returns:
        None. Verifies rejection at the real REST adapter boundary.
    """
    def handler(request: httpx2.Request) -> httpx2.Response:
        """Supply schema metadata while rejecting unexpected writes.

        Args:
            request: GeoServer REST request under test.

        Returns:
            Existing layer or supplied feature type metadata.
        """
        assert request.method == "GET"
        if "/featuretypes/" in request.url.path:
            return httpx2.Response(200, json={"featureType": {"attributes": {"attribute": attributes}}})
        return httpx2.Response(200)

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    publisher = GeoServerVectorPublisher(client, "http://geoserver/geoserver")
    request = polygon_request({"collection": "eolab-mounted-vectors", "id": "test-layer"}, label_field="name")
    with pytest.raises(VectorPublicationError, match="unique vector label geometry"):
        asyncio.run(publisher.apply_style("test-layer", request.style))
    asyncio.run(client.aclose())


def test_fixed_label_identity_requires_and_includes_geometry_attribute() -> None:
    """Reject guessed geometry and distinguish otherwise identical anchors.

    Returns:
        None. Checks generated-style identities and required geometry metadata.
    """
    style = polygon_request({"collection": "eolab-mounted-vectors", "id": "test-layer"}, label_field="name").style
    with pytest.raises(ValueError, match="authorized geometry"):
        build_vector_sld("test-style", style)
    assert vector_style_name("test-layer", style, geometry_name="shape") != vector_style_name(
        "test-layer", style, geometry_name="different_shape",
    )


@pytest.mark.parametrize("label_font_size", [None, 12, 72])
def test_geoserver_style_adapter_uses_content_addressed_layer_slds(
    label_font_size: int | None,
) -> None:
    """Assign content-addressed styles with their bounded tile-edge margins.

    Args:
        label_font_size: No labels, the ordinary font, or its validated maximum.

    Returns:
        None. Verifies the GeoServer REST request sequence and margin reset.
    """
    resource_name = "geopackage-0123456789abcdef01234567"
    style_names: set[str] = set()
    requests: list[httpx2.Request] = []
    assigned_buffers: list[int] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        path = request.url.path.removeprefix("/geoserver/rest")
        if request.method == "GET" and path.endswith(
            f"/layers/{resource_name}.json"
        ):
            return httpx2.Response(200)
        if request.method == "GET" and "/styles/" in path:
            inspected_style_name = path.rsplit("/", 1)[-1].removesuffix(
                ".sld"
            )
            return httpx2.Response(
                200 if inspected_style_name in style_names else 404
            )
        if request.method == "GET" and "/featuretypes/" in path:
            return httpx2.Response(200, json={"featureType": {"attributes": {"attribute": [
                {"name": "custom_shape", "binding": "org.locationtech.jts.geom.MultiPolygon"},
                {"name": "name", "binding": "java.lang.String"},
            ]}}})
        if request.method == "POST" and path.endswith(
            "/workspaces/eolab/styles"
        ):
            style_name = request.url.params["name"]
            assert request.headers["content-type"] == (
                "application/vnd.ogc.sld+xml"
            )
            document = ElementTree.fromstring(request.content)
            anchor = document.find(f".//{{{SLD_NAMESPACE}}}Geometry/{{{OGC_NAMESPACE}}}Function/{{{OGC_NAMESPACE}}}PropertyName")
            if anchor is not None:
                assert anchor.text == "custom_shape"
            style_names.add(style_name)
            return httpx2.Response(201)
        if request.method == "PUT" and "/styles/" in path:
            assert path.rsplit("/", 1)[-1] in style_names
            ElementTree.fromstring(request.content)
            return httpx2.Response(200)
        if request.method == "PUT" and path.endswith(
            f"/layers/{resource_name}.json"
        ):
            document = __import__("json").loads(request.content)
            assigned_style_name = document["layer"]["defaultStyle"]["name"]
            assert assigned_style_name in style_names
            assert document["layer"]["defaultStyle"]["workspace"] == "eolab"
            metadata_entry = document["layer"]["metadata"]["entry"]
            assert metadata_entry["@key"] == "buffer"
            assigned_buffers.append(int(metadata_entry["$"]))
            return httpx2.Response(200)
        raise AssertionError(f"Unexpected request: {request.method} {path}")

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    publisher = GeoServerVectorPublisher(client, "http://geoserver/geoserver")

    first = asyncio.run(
        publisher.apply_style(resource_name, default_vector_style("polygon"))
    )
    changed_style = polygon_request({
        "collection": "eolab-mounted-vectors",
        "id": resource_name,
    }).style
    if label_font_size is not None:
        changed_style = VectorStyle.model_validate({
            **changed_style.model_dump(by_alias=True),
            "label": {
                "field": "name", "fontFamily": "SansSerif", "fontSize": label_font_size,
                "fontWeight": "normal", "fontColor": "#111827", "haloColor": "#ffffff",
                "haloWidth": 10, "placement": "center", "minimumZoom": 0,
            },
        })
    second = asyncio.run(
        publisher.apply_style(resource_name, changed_style)
    )
    third = asyncio.run(
        publisher.apply_style(resource_name, default_vector_style("polygon"))
    )
    asyncio.run(client.aclose())

    assert first != second
    assert first == third
    assert style_names == {first.style_name, second.style_name}
    assert second.geometry_name == ("custom_shape" if label_font_size is not None else None)
    expected_buffer = 0 if label_font_size is None else max(256, label_font_size * 12 + 20)
    assert assigned_buffers == [0, expected_buffer, 0]
    assert vector_label_rendering_buffer(changed_style) == expected_buffer
    assert sum(request.method == "POST" for request in requests) == 2
    assert any(
        request.method == "PUT" and "/styles/" in request.url.path
        for request in requests
    )
