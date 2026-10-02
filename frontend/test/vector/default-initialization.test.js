import assert from "node:assert/strict";
import test from "node:test";
import { MapLayerController } from "../../src/map-layers/controller.js";
import { getCatalogItemKey } from "../../src/catalog-item-identity.js";
import { createVectorMapLayerAdapter } from "../../src/vector/map-layer-adapter.js";
import { VECTOR_LABEL_DEFAULTS } from "../../src/vector/defaults.js";

const ITEM = {
    collection: "eolab-mounted-vectors", id: "named-measurements",
    properties: { "table:columns": [
        { name: "name", type: "str" }, { name: "fid", type: "int" },
        { name: "score", type: "float" },
    ] },
};
const STYLE = {
    geometryKind: "polygon", fillColor: "#2b83ba", fillOpacity: 0.7,
    strokeColor: "#000000", strokeOpacity: 1, strokeWidth: 0.75,
    pointSize: null, categorical: null, graduated: null, label: null,
};
const SUMMARY = {
    field: "score", fieldType: "float", method: "percentile-interval",
    requestedClassCount: 5, actualClassCount: 3,
    classes: [
        { minimum: null, maximum: 10, count: 3 },
        { minimum: 10, maximum: 20, count: 3 },
        { minimum: 20, maximum: null, count: 3 },
    ],
    observedMinimum: 1, observedMaximum: 30, numericValueCount: 9,
    scannedFeatureCount: 10, featureCount: 10, nullCount: 1,
    unsupportedValueCount: 0, complete: true,
    defaultClassCount: 5, minimumClassCount: 2, maximumClassCount: 9,
};

/**
 * Connect the real vector adapter and neutral layer controller with API ports.
 * @param {Object} [overrides={}] Optional publication, classification, or style ports.
 * @return {Object} Controller, vector adapter, recorded calls, and attached layers.
 */
function fixture(overrides = {}) {
    const calls = [];
    const map = { attached: new Set(), removeLayer(layer) { this.attached.delete(layer); } };
    const leaflet = { tileLayer: { wms(_url, options) {
        calls.push(["wms", options]);
        return {
            options, once() {}, setParams(params) { Object.assign(this.options, params); },
            addTo(target) { target.attached.add(this); return this; },
            setOpacity() {}, setZIndex() {},
        };
    } } };
    const controller = new MapLayerController({
        leafletMap: map,
        view: { bind() {}, unbind() {}, render() {}, setStatus() {}, announceStatus() {} },
    });
    const adapter = createVectorMapLayerAdapter({
        leaflet, leafletMap: map, wmsUrl: "/geoserver/eolab/wms",
        onTileError() {}, fitToBounds: false,
        async publish(item) {
            calls.push(["publish", item]);
            return { geometryKind: "polygon", layerName: "eolab:measurements",
                styleName: "vector-polygon", style: STYLE, bbox: [0, 0, 1, 1] };
        },
        async classify(item, field, method, classCount) {
            calls.push(["classify", item, field, method, classCount]);
            return SUMMARY;
        },
        async style(item, candidate) {
            calls.push(["style", item, candidate]);
            return { styleName: "vector-style-0123456789abcdef01234567-aaaaaaaaaaaa", style: candidate };
        },
        ...overrides,
    });
    return { controller, adapter, calls, map };
}

test("new vectors get authorized named numeric styles before WMS and preserve later edits", async () => {
    const f = fixture();
    const publication = await f.controller.show(ITEM, f.adapter);
    assert.deepEqual(f.calls.map(call => call[0]), ["publish", "classify", "style", "wms"]);
    assert.equal(publication.style.label, null);
    assert.equal(publication.style.graduated.field, "score");
    assert.deepEqual(publication.style.graduated.rules.map(rule => rule.color), ["#2b83ba", "#ffffbf", "#d7191c"]);
    assert.equal(publication.style.graduated.missingColor, "#d1d5db");
    assert.equal(f.calls.at(-1)[1].styles, publication.styleName);
    const record = f.controller.getRecord(getCatalogItemKey(ITEM));
    assert.equal(f.adapter.snapshot(record).legend.kind, "graduated");
    await f.adapter.applyStyle(record, { ...STYLE, fillColor: "#abcdef" });
    const count = f.calls.length;
    await f.controller.show(ITEM, f.adapter);
    assert.equal(f.calls.length, count);
    assert.equal(record.state.style.fillColor, "#abcdef");
    assert.equal(record.state.style.label, null);
});

test("multiple numeric fields initialize classified colors with labels off", async () => {
    const f = fixture();
    const item = { ...ITEM, properties: { "table:columns": [
        ...ITEM.properties["table:columns"], { name: "area", type: "float" },
    ] } };
    const result = await f.adapter.publish(item);
    assert.equal(f.calls.some(call => call[0] === "classify"), true);
    assert.equal(result.style.graduated.field, "score");
    assert.equal(result.style.label, null);
});

test("workshop annual fields automatically classify R2024 before attaching WMS", async () => {
    const f = fixture({ async classify(item, field, method, classCount) {
        f.calls.push(["classify", item, field, method, classCount]);
        return { ...SUMMARY, field };
    } });
    const item = { ...ITEM, properties: { "table:columns": [
        { name: "FID", type: "int" }, { name: "node_nm", type: "str:80" },
        ...Array.from({ length: 25 }, (_, index) => ({ name: `R${2000 + index}`, type: "float:24.15" })),
    ] } };
    const result = await f.controller.show(item, f.adapter);
    assert.deepEqual(f.calls.map(call => call[0]), ["publish", "classify", "style", "wms"]);
    assert.equal(f.calls[1][2], "R2024");
    assert.equal(result.style.graduated.field, "R2024");
    assert.equal(result.style.label, null);
});

test("solid defaults also receive a new style identity instead of reusing old fixed-style tiles", async () => {
    const f = fixture();
    const result = await f.adapter.publish({ ...ITEM, properties: {} });
    assert.deepEqual(f.calls.map(call => call[0]), ["publish", "style"]);
    assert.notEqual(result.styleName, "vector-polygon");
    assert.deepEqual(result.style, STYLE);
});

test("failed automatic styles fall back to authorized fixed WMS without hiding the layer", async () => {
    const f = fixture({ async style() { throw new Error("upstream unavailable"); } });
    const result = await f.controller.show(ITEM, f.adapter);
    assert.equal(result.styleName, "vector-polygon");
    assert.equal(f.map.attached.size, 1);
    assert.match(f.controller.getRecord(getCatalogItemKey(ITEM)).state.defaultStyleNotice, /could not be applied/);
});

test("saved appearance takes precedence before a staged vector reaches the map", async () => {
    const f = fixture();
    const staged = await f.controller.stage(ITEM, f.adapter);
    assert.equal(f.map.attached.size, 0);
    const saved = { ...STYLE, fillColor: "#654321",
        label: { ...VECTOR_LABEL_DEFAULTS, field: "name", placement: "center" } };
    await f.adapter.applySavedState(staged.record, { kind: "vector", definition: saved });
    assert.deepEqual(f.adapter.exportSavedState(staged.record), { kind: "vector", definition: saved });
    assert.equal(f.map.attached.size, 0);
});

test("invalidating a pending default classification prevents late layer attachment", async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture({ classify: () => pending });
    const showing = f.controller.show(ITEM, f.adapter);
    await new Promise(resolve => setTimeout(resolve, 0));
    f.controller.removeOwned(f.adapter);
    finish(SUMMARY);
    assert.equal(await showing, null);
    assert.equal(f.map.attached.size, 0);
    assert.equal(f.calls.some(call => call[0] === "wms"), false);
});

test("publication failures are not disguised as optional styling failures", async () => {
    const f = fixture({ async publish() { throw new Error("source changed"); } });
    await assert.rejects(f.controller.show(ITEM, f.adapter), /source changed/);
    assert.equal(f.map.attached.size, 0);
});
