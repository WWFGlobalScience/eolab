import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationModel, readAnnotationLayers, matchingAnnotationPolygons, MAX_POLYGON_VERTICES } from "../../src/annotations/model.js";
import { polygonValidationMessage } from "../../src/annotations/geometry.js";

/** @return {AnnotationModel} Model with deterministic local identifiers. */
function model() {
    let next = 0;
    return new AnnotationModel([], () => `id-${++next}`);
}

/**
 * Draw one valid triangle through the editing contract.
 * @param {AnnotationModel} annotations Model under test.
 * @param {string} layerId Target layer.
 * @return {Object} Saved polygon.
 */
function triangle(annotations, layerId) {
    annotations.beginPolygon(layerId);
    [[-75, -5], [-72, -5], [-74, -2]].forEach(point => annotations.addVertex(point));
    return annotations.savePolygon();
}

test("unfinished and cancelled edits never replace persisted polygons", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    const polygon = triangle(annotations, layer.id);
    const original = annotations.document();
    annotations.beginPolygon(layer.id, polygon.id);
    annotations.draft.polygon.vertices[0] = [-80, -8];
    assert.deepEqual(annotations.document(), original);
    annotations.cancelPolygon();
    assert.deepEqual(annotations.document(), original);
    annotations.beginPolygon(layer.id);
    annotations.addVertex([0, 0]);
    assert.throws(() => annotations.savePolygon(), /at least 3 vertices/);
    assert.deepEqual(annotations.document(), original);
    assert.ok(annotations.draft);
});

test("save, delete and single undo retain notes and polygon identity", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    const first = triangle(annotations, layer.id);
    first.note = "Protect this area <script>plain text</script>";
    const second = triangle(annotations, layer.id);
    annotations.deletePolygon(layer.id, first.id);
    annotations.deletePolygon(layer.id, second.id);
    assert.equal(layer.polygons.length, 0);
    assert.equal(annotations.undoDeletion(), true);
    assert.deepEqual(layer.polygons, [second]);
    assert.equal(annotations.undoDeletion(), false);
    annotations.beginPolygon(layer.id, second.id);
    annotations.draft.polygon.vertices[0] = [-76, -5];
    const edited = annotations.savePolygon();
    assert.equal(edited.id, second.id);
    assert.deepEqual(edited.vertices[0], [-76, -5]);
});

test("deleting an edited saved polygon undoes to its saved geometry", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    const saved = triangle(annotations, layer.id);
    const original = structuredClone(saved);
    annotations.beginPolygon(layer.id, saved.id);
    annotations.draft.polygon.vertices[0] = [5, 6];
    annotations.deletePolygon(layer.id, saved.id);
    assert.equal(annotations.draft, null);
    annotations.undoDeletion();
    assert.deepEqual(layer.polygons, [original]);
});

test("first-vertex deletion of an unfinished drawing can be undone", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    annotations.beginPolygon(layer.id);
    annotations.addVertex([4, 5]);
    const draft = structuredClone(annotations.draft);
    annotations.deletePolygon(layer.id, draft.polygon.id);
    assert.equal(annotations.draft, null);
    annotations.undoDeletion();
    assert.deepEqual(annotations.draft, draft);
    assert.deepEqual(layer.polygons, []);
});

test("invalid polygons explain too few vertices, crossings, duplicate and empty geometry", () => {
    for (const vertices of [[], [[0,0]], [[0,0],[1,1]]]) assert.match(polygonValidationMessage(vertices), /at least 3/);
    assert.match(polygonValidationMessage([[0,0],[2,2],[0,2],[2,0]]), /edges cross/);
    assert.match(polygonValidationMessage([[0,0],[1,0],[2,0]]), /enclose an area|overlap/);
    assert.match(polygonValidationMessage([[0,0],[2,0],[2,2],[0,0]]), /same position/);
    assert.match(polygonValidationMessage([[0,0],[200,0],[0,2]]), /map bounds/);
    assert.equal(polygonValidationMessage([[0,0],[2,0],[2,2],[1,1],[0,2]]), null);
});

test("storage round trip preserves layer appearance, text filter and notes", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    const polygon = triangle(annotations, layer.id);
    polygon.note = "Workshop priority";
    layer.filter = "PRIORITY";
    layer.opacity = 0.6;
    layer.visible = false;
    layer.style.color = "#123456";
    layer.style.labels = false;
    layer.style.notes = true;
    const restored = readAnnotationLayers(annotations.document());
    assert.deepEqual(restored, annotations.layers);
    assert.deepEqual(matchingAnnotationPolygons(restored[0]), [polygon]);
    restored[0].filter = "absent";
    assert.deepEqual(matchingAnnotationPolygons(restored[0]), []);
    assert.equal(layer.filter, "PRIORITY");
});

test("stored identities, appearance and drawing limits are validated", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    triangle(annotations, layer.id);
    const invalid = annotations.document();
    invalid.layers[0].polygons[0].id = layer.id;
    assert.throws(() => readAnnotationLayers(invalid), /identifiers/);
    invalid.layers[0].polygons[0].id = "polygon";
    invalid.layers[0].style.fillOpacity = 5;
    assert.throws(() => readAnnotationLayers(invalid), /style/);
    annotations.beginPolygon(layer.id);
    annotations.draft.polygon.vertices = Array.from({length: MAX_POLYGON_VERTICES}, () => [0, 0]);
    assert.throws(() => annotations.addVertex([0, 0]), /at most/);
    assert.throws(() => annotations.beginPolygon(layer.id), /Save or cancel/);
});

test("existing saved annotation styles keep notes hidden and reject invalid note settings", () => {
    const annotations = model();
    annotations.createLayer();
    const saved = annotations.document();
    delete saved.layers[0].style.notes;
    const restored = readAnnotationLayers(saved);
    assert.equal(restored[0].style.labels, true);
    assert.equal(restored[0].style.notes, false);
    saved.layers[0].style.notes = "yes";
    assert.throws(() => readAnnotationLayers(saved), /style/);
});
