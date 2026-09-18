import assert from "node:assert/strict";
import test from "node:test";
import { createAnnotationLeafletLayer } from "../../src/annotations/leaflet-layer.js";
import { DEFAULT_ANNOTATION_STYLE } from "../../src/annotations/model.js";

/** @return {Object} Plain-text element double for the label content contract. */
function element() {
    return { children: [], style: {}, textContent: "", hidden: false,
        append(child) { this.children.push(child); },
        querySelector(selector) { return this.children.find(child => `.${child.className}` === selector); },
        remove() {} };
}

/** @return {Object} Local annotation renderer with doubles for Leaflet's public layer methods. */
function setup() {
    const annotation = { filter: "", style: { ...DEFAULT_ANNOTATION_STYLE },
        polygons: [{ id: "polygon", name: "Riverbank", note: "Restore habitat", vertices: [[0, 0], [1, 0], [0, 1]] }] };
    const members = new Set();
    const leaflet = { DomUtil: { create: element }, svg: () => ({}),
        featureGroup: () => ({ addLayer: shape => members.add(shape), removeLayer: shape => members.delete(shape), clearLayers: () => members.clear() }),
        polygon: () => ({ setLatLngs() {}, setStyle() {},
            getTooltip() { return this.tooltip; },
            bindTooltip(content) { this.tooltip = { getContent: () => content, update() {} }; },
            unbindTooltip() { this.tooltip = undefined; } }) };
    const map = { getPane: element, getContainer: () => ({ ownerDocument: { createElement: element } }), removeLayer() {} };
    return { annotation, members, rendering: createAnnotationLeafletLayer(leaflet, map, annotation) };
}

test("text edits retain the same polygon and label instead of restarting tooltip fades", () => {
    const { annotation, members, rendering } = setup();
    const shape = [...members][0];
    const tooltip = shape.getTooltip();
    annotation.polygons[0].name = "Priority riverbank";
    rendering.refresh();
    assert.equal([...members][0], shape);
    assert.equal(shape.getTooltip(), tooltip);
    assert.equal(tooltip.getContent().querySelector(".annotation-polygon-name").textContent, "Priority riverbank");
    annotation.filter = "absent";
    rendering.refresh();
    assert.equal(members.size, 0);
    annotation.filter = "";
    rendering.refresh();
    assert.equal(members.size, 1);
    rendering.release();
    assert.equal(members.size, 0);
});

test("names and notes can each be shown alone, together, or hidden without blank labels", () => {
    const { annotation, members, rendering } = setup();
    const shape = [...members][0];
    let label = shape.getTooltip().getContent();
    assert.equal(label.querySelector(".annotation-polygon-name").hidden, false);
    assert.equal(label.querySelector(".annotation-polygon-note").hidden, true);
    annotation.style.notes = true;
    annotation.polygons[0].note = "<script>plain text</script>";
    rendering.refresh();
    assert.equal(label.querySelector(".annotation-polygon-note").textContent, "<script>plain text</script>");
    assert.equal(label.querySelector(".annotation-polygon-note").hidden, false);
    annotation.style.labels = false;
    rendering.refresh();
    assert.equal(label.querySelector(".annotation-polygon-name").hidden, true);
    assert.equal(label.querySelector(".annotation-polygon-note").hidden, false);
    annotation.style.notes = false;
    rendering.refresh();
    assert.equal(shape.getTooltip(), undefined);
    annotation.style.notes = true;
    annotation.polygons[0].note = "   ";
    rendering.refresh();
    assert.equal(shape.getTooltip(), undefined);
});
