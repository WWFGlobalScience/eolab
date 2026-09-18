import test from "node:test";
import assert from "node:assert/strict";
import { parseAnnotationGeoJSON, exportAnnotationGeoJSON, readAnnotationGeoJSONFile } from "../../src/annotations/geojson.js";
import { AnnotationModel, readAnnotationLayers, MAX_ANNOTATION_LAYERS, MAX_ANNOTATION_DOCUMENT_BYTES,
    MAX_POLYGON_VERTICES, MAX_POLYGONS_PER_LAYER } from "../../src/annotations/model.js";
import { AnnotationController } from "../../src/annotations/controller.js";

/** @return {Object} A closed counterclockwise Polygon with optional feature text. */
function feature() {
    return { type: "Feature", id: "external", properties: { name: "Forest", note: "Keep trees\n<plain text>" },
        geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [1, 2], [0, 0]]] } };
}

/** @return {Object} Named collection with one valid feature. */
function collection() { return { type: "FeatureCollection", name: "Workshop areas", features: [feature()] }; }

/** @return {AnnotationModel} Local collection with deterministic unique identifiers. */
function model() {
    let next = 0;
    return new AnnotationModel([], () => `id-${++next}`);
}

test("EOLab GeoJSON preserves names, notes and shapes across import, export and device storage", () => {
    const annotations = model();
    const imported = parseAnnotationGeoJSON(JSON.stringify(collection()));
    const layer = annotations.importLayer(imported);
    layer.filter = "does not match";
    layer.visible = false;
    annotations.beginPolygon(layer.id);
    annotations.addVertex([40, 40]);
    const exported = exportAnnotationGeoJSON(layer);
    assert.equal(exported.type, "FeatureCollection");
    assert.equal(exported.name, "Workshop areas");
    assert.equal(exported.features.length, 1, "ignore display filtering and unfinished drafts");
    assert.deepEqual(exported.features[0].properties, feature().properties);
    assert.deepEqual(exported.features[0].geometry, feature().geometry);
    assert.equal(exported.features[0].id, layer.polygons[0].id);
    assert.equal(exported.filter, undefined);
    assert.equal(exported.style, undefined);
    assert.deepEqual(parseAnnotationGeoJSON(JSON.stringify(exported)), imported);
    assert.deepEqual(readAnnotationLayers(annotations.document()), annotations.layers);
    assert.equal(layer.visible, false, "export does not modify its source");
});

test("external optional properties use strings or defaults and never enter local records wholesale", () => {
    const document = collection();
    document.name = 45;
    document.style = { color: "red" };
    document.features[0].properties = { name: 42, title: "From title", note: {}, description: "From description", secret: "ignored" };
    const imported = parseAnnotationGeoJSON(JSON.stringify(document), "My file");
    assert.deepEqual(imported, { name: "My file", polygons: [{ name: "From title", note: "From description", vertices: [[0, 0], [2, 0], [1, 2]] }] });
    for (const properties of [null, undefined, {}, { name: [], title: false, note: 4 }, { name: "   " }]) {
        document.features[0].properties = properties;
        const polygon = parseAnnotationGeoJSON(JSON.stringify(document)).polygons[0];
        assert.equal(polygon.name, "Polygon 1");
        assert.equal(polygon.note, "");
    }
});

test("single Feature, Polygon, empty collection and UTF-8 BOM are supported", () => {
    assert.equal(parseAnnotationGeoJSON(JSON.stringify(feature())).polygons[0].name, "Forest");
    assert.equal(parseAnnotationGeoJSON(JSON.stringify(feature().geometry)).polygons[0].name, "Polygon 1");
    assert.deepEqual(parseAnnotationGeoJSON('{"type":"FeatureCollection","name":"Empty","features":[]}'), { name: "Empty", polygons: [] });
    assert.equal(parseAnnotationGeoJSON("\uFEFF" + JSON.stringify(collection())).polygons.length, 1);
});

test("export closes and orients clockwise rings without changing local geometry", () => {
    const annotations = model();
    const layer = annotations.importLayer(parseAnnotationGeoJSON(JSON.stringify(collection())));
    layer.polygons[0].vertices.reverse();
    const before = annotations.document();
    const ring = exportAnnotationGeoJSON(layer).features[0].geometry.coordinates[0];
    assert.deepEqual(ring[0], ring.at(-1));
    const area = ring.slice(0, -1).reduce((sum, p, i) => sum + p[0] * ring[i + 1][1] - ring[i + 1][0] * p[1], 0);
    assert.ok(area > 0);
    assert.deepEqual(annotations.document(), before);
});

test("reimport generates independent layer and feature IDs and resets presentation", () => {
    const annotations = model();
    const first = annotations.importLayer(parseAnnotationGeoJSON(JSON.stringify(collection())));
    first.filter = "forest";
    first.visible = false;
    const second = annotations.importLayer(parseAnnotationGeoJSON(JSON.stringify(exportAnnotationGeoJSON(first))));
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.polygons[0].id, second.polygons[0].id);
    assert.equal(second.visible, true);
    assert.equal(second.filter, "");
    second.polygons[0].vertices[0][0] = -3;
    assert.equal(first.polygons[0].vertices[0][0], 0);
});

test("unsupported geometries identify the failing feature and reason", () => {
    for (const [geometry, message] of [
        [null, /missing geometry/],
        [{ type: "MultiPolygon", coordinates: [] }, /MultiPolygon/],
        [{ type: "Point", coordinates: [0, 0] }, /Point/],
        [{ type: "LineString", coordinates: [[0, 0], [1, 1]] }, /LineString/],
        [{ type: "GeometryCollection", geometries: [] }, /GeometryCollection/],
        [{ type: "Polygon", coordinates: [feature().geometry.coordinates[0], feature().geometry.coordinates[0]] }, /holes/],
        [{ type: "Polygon", coordinates: [] }, /exterior ring/],
        [{ type: "Polygon", coordinates: [[]] }, /at least 3 vertices/],
        [{ type: "Polygon", coordinates: [[[0, 0], [2, 0], [1, 2], [1, 1]]] }, /not closed/],
        [{ type: "Polygon", coordinates: [[[0, 0, 1], [2, 0], [1, 2], [0, 0, 1]]] }, /Altitude/],
        [{ type: "Polygon", coordinates: [[[0, 0], [2, 0], [1, 90], [0, 0]]] }, /map bounds/],
        [{ type: "Polygon", coordinates: [[[0, 0], [200, 0], [1, 2], [0, 0]]] }, /WGS84/],
        [{ type: "Polygon", coordinates: [[[0, 0], ["2", 0], [1, 2], [0, 0]]] }, /finite numbers/],
        [{ type: "Polygon", coordinates: [[[0, 0], [null, 0], [1, 2], [0, 0]]] }, /finite numbers/],
        [{ type: "Polygon", coordinates: [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]] }, /edges cross/],
        [{ type: "Polygon", coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] }, /overlap|enclose an area/],
    ]) {
        const document = collection();
        document.features.push({ ...feature(), geometry });
        assert.throws(() => parseAnnotationGeoJSON(JSON.stringify(document)), error => {
            assert.match(error.message, /^Feature 2:/);
            assert.match(error.message, message);
            return true;
        });
    }
});

test("invalid JSON, envelopes, legacy CRS and recognized overlong text produce descriptive errors", () => {
    assert.throws(() => parseAnnotationGeoJSON("{"), /not valid JSON/);
    for (const value of [null, 12, [], "Polygon"]) assert.throws(() => parseAnnotationGeoJSON(JSON.stringify(value)), /Expected a GeoJSON/);
    assert.throws(() => parseAnnotationGeoJSON('{"type":"FeatureCollection"}'), /features array/);
    assert.throws(() => parseAnnotationGeoJSON('{"type":"FeatureCollection","features":[null]}'), /Feature 1/);
    for (const target of ["document", "feature", "geometry"]) {
        const document = collection();
        const object = target === "document" ? document : target === "feature" ? document.features[0] : document.features[0].geometry;
        object.crs = { type: "name", properties: { name: "EPSG:3857" } };
        assert.throws(() => parseAnnotationGeoJSON(JSON.stringify(document)), /Export GeoJSON in WGS84/);
    }
    const document = collection();
    document.features[0].properties.note = "a".repeat(10001);
    assert.throws(() => parseAnnotationGeoJSON(JSON.stringify(document)), /Feature 1 note exceeds the 10000-character limit/);
    document.name = "a".repeat(161);
    assert.throws(() => parseAnnotationGeoJSON(JSON.stringify(document)), /Layer name exceeds/);
});

test("file, feature and vertex limits are checked before expensive geometry work", async () => {
    let read = false;
    await assert.rejects(() => readAnnotationGeoJSONFile({ size: MAX_ANNOTATION_DOCUMENT_BYTES + 1, text() { read = true; } }), /8 MiB/);
    assert.equal(read, false);
    assert.throws(() => parseAnnotationGeoJSON(" ".repeat(MAX_ANNOTATION_DOCUMENT_BYTES + 1)), /8 MiB/);
    const document = collection();
    document.features = Array.from({ length: MAX_POLYGONS_PER_LAYER + 1 }, () => null);
    assert.throws(() => parseAnnotationGeoJSON(JSON.stringify(document)), /at most 500/);
    const geometry = { type: "Polygon", coordinates: [Array.from({ length: MAX_POLYGON_VERTICES + 2 }, () => [0, 0])] };
    assert.throws(() => parseAnnotationGeoJSON(JSON.stringify(geometry)), /2000-vertex/);
    await assert.rejects(() => readAnnotationGeoJSONFile({ size: 12, text() { throw new Error("Denied"); } }), /Could not read/);
    const file = new File([JSON.stringify(feature())], "Field areas.geojson");
    assert.equal((await readAnnotationGeoJSONFile(file)).name, "Field areas");
});

test("model refuses imports during edits or beyond capacity without mutating existing annotations", () => {
    const annotations = model();
    const imported = parseAnnotationGeoJSON(JSON.stringify(collection()));
    const layer = annotations.importLayer(imported);
    annotations.beginPolygon(layer.id);
    assert.throws(() => annotations.importLayer(imported), /Save or cancel/);
    annotations.cancelPolygon();
    while (annotations.layers.length < MAX_ANNOTATION_LAYERS) annotations.createLayer();
    const before = annotations.document();
    assert.throws(() => annotations.importLayer(imported), /32 annotation layers/);
    assert.deepEqual(annotations.document(), before);
    const full = model();
    const existing = full.createLayer();
    const polygon = imported.polygons[0];
    existing.polygons = Array.from({ length: MAX_POLYGONS_PER_LAYER }, (_, i) => ({ ...polygon, id: `old-${i}`, note: "a".repeat(10000) }));
    const large = { name: "Another", polygons: existing.polygons.map(({ id, ...polygon }) => polygon) };
    assert.throws(() => full.importLayer(large), /8 MiB annotation storage limit/);
    assert.equal(full.layers.length, 1);
});

/**
 * Connect file import to the real parser/model with minimal presentation and storage fakes.
 * @return {AnnotationController} Controller exposing attached and saved layers for assertions.
 */
function importController() {
    const controller = Object.create(AnnotationController.prototype);
    Object.assign(controller, { model: model(), loaded: true, importing: false, attached: [], saved: [],
        importButton: { disabled: false }, importInput: { value: "file" },
        fileStatus: { textContent: "", classList: { add() {}, remove() {} } },
        attachLayer(layer) { this.attached.push(layer); },
        async save() { this.saved.push(this.model.document()); },
    });
    return controller;
}

test("one invalid feature rejects the entire file and errors survive until another file action", async () => {
    const controller = importController();
    const existing = controller.model.createLayer();
    const document = collection();
    document.features.push({ ...feature(), geometry: { type: "Point", coordinates: [1, 2] } });
    await controller.importGeoJSONFile(new File([JSON.stringify(document)], "mixed.geojson"));
    assert.match(controller.fileStatus.textContent, /Feature 2: Point/);
    assert.deepEqual(controller.model.layers, [existing]);
    assert.equal(controller.attached.length, 0);
    assert.equal(controller.saved.length, 0);
    assert.equal(controller.importButton.disabled, false);
    await controller.importGeoJSONFile(new File([JSON.stringify(collection())], "good.geojson"));
    assert.equal(controller.model.layers.length, 2);
    assert.equal(controller.attached.length, 1);
    assert.equal(controller.saved.length, 1);
    assert.match(controller.fileStatus.textContent, /Imported 1 polygon/);
});

test("concurrent imports are not admitted and changes during file reading are respected", async () => {
    const controller = importController();
    let finishReading;
    const reading = controller.importGeoJSONFile({ name: "slow.geojson", size: 1,
        text: () => new Promise(resolve => { finishReading = resolve; }) });
    assert.equal(controller.importButton.disabled, true);
    await controller.importGeoJSONFile(new File([JSON.stringify(collection())], "second.geojson"));
    const layer = controller.model.createLayer();
    controller.model.beginPolygon(layer.id);
    finishReading(JSON.stringify(collection()));
    await reading;
    assert.match(controller.fileStatus.textContent, /Save or cancel/);
    assert.equal(controller.attached.length, 0);
    assert.equal(controller.importButton.disabled, false);
});

test("notes preserve empty strings, whitespace and multiline text exactly", () => {
    for (const note of ["", "   ", "\n", "  Field note\nLine two  "]) {
        const document = collection();
        document.features[0].properties.note = note;
        document.features[0].properties.description = "Must not replace an explicit note";
        assert.equal(parseAnnotationGeoJSON(JSON.stringify(document)).polygons[0].note, note);
    }
});
