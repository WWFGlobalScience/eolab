import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationModel, readAnnotationLayers, matchingAnnotationPolygons, MAX_ANNOTATION_LAYERS, MAX_POLYGON_VERTICES } from "../../src/annotations/model.js";
import { polygonValidationMessage } from "../../src/annotations/geometry.js";
import { EMPTY_VECTOR_FILTER } from "../../src/vector/filter.js";

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

test("storage round trip preserves layer appearance, filter rules and notes", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    assert.deepEqual(layer.filter, EMPTY_VECTOR_FILTER);
    const polygon = triangle(annotations, layer.id);
    polygon.note = "Workshop priority";
    layer.filter = { enabled: true, match: "all", rules: [{ field: "note", operator: "contains", value: "priority" }] };
    layer.opacity = 0.6;
    layer.visible = false;
    layer.style.color = "#123456";
    layer.style.labels = false;
    const restored = readAnnotationLayers(annotations.document());
    assert.deepEqual(restored, annotations.layers);
    assert.deepEqual(matchingAnnotationPolygons(restored[0]), [polygon]);
    restored[0].filter.rules[0].value = "absent";
    assert.deepEqual(matchingAnnotationPolygons(restored[0]), []);
    assert.equal(layer.filter.rules[0].value, "priority");
});

test("unreadable stored filters are cleared while drawings and supported filters remain unchanged", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    const polygon = triangle(annotations, layer.id);
    layer.name = "Reference sites";
    polygon.name = "North site"; polygon.note = "Retain these vertices and notes.";
    layer.position = 3; layer.opacity = 0.4; layer.visible = false;
    layer.style.color = "#123456";
    const filtered = annotations.createLayer();
    triangle(annotations, filtered.id);
    filtered.filter = { enabled: true, match: "all", rules: [{ field: "name", operator: "contains", value: "site" }] };
    for (const filter of ["", "Forest", null, { enabled: true, match: "all", rules: [{ field: "obsolete", operator: "eq", value: "x" }] }]) {
        const saved = annotations.document();
        saved.layers.find(candidate => candidate.id === layer.id).filter = filter;
        const original = structuredClone(saved);
        const cleared = [];
        const restored = readAnnotationLayers(saved, id => cleared.push(id));
        assert.deepEqual(restored, annotations.layers);
        assert.deepEqual(cleared, [layer.id]);
        assert.deepEqual(saved, original);
        const repeatedClears = [];
        assert.deepEqual(readAnnotationLayers({ version: 1, layers: restored }, id => repeatedClears.push(id)), restored);
        assert.deepEqual(repeatedClears, []);
    }
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
    invalid.layers[0].style.fillOpacity = 0.25;
    invalid.layers[0].filter = "obsolete filter";
    invalid.layers[0].polygons[0].vertices = [[0, 0], [1, 1]];
    const original = structuredClone(invalid);
    assert.throws(() => readAnnotationLayers(invalid), /invalid polygon/);
    assert.deepEqual(invalid, original);
    annotations.beginPolygon(layer.id);
    annotations.draft.polygon.vertices = Array.from({length: MAX_POLYGON_VERTICES}, () => [0, 0]);
    assert.throws(() => annotations.addVertex([0, 0]), /at most/);
    assert.throws(() => annotations.beginPolygon(layer.id), /Save or cancel/);
});

test("legacy name and note preferences become one persistent label preference", () => {
    const annotations = model();
    annotations.createLayer();
    const saved = annotations.document();
    const restored = readAnnotationLayers(saved);
    assert.equal(restored[0].style.labels, true);
    assert.equal("notes" in restored[0].style, false);
    for (const labels of [true, false]) {
        for (const notes of [true, false, undefined]) {
            Object.assign(saved.layers[0].style, { labels, notes });
            const migrated = readAnnotationLayers(saved);
            assert.equal(migrated[0].style.labels, labels || notes === true);
            assert.equal("notes" in migrated[0].style, false);
            assert.deepEqual(readAnnotationLayers({ version: 1, layers: migrated }), migrated);
        }
    }
    saved.layers[0].style.notes = "yes";
    assert.throws(() => readAnnotationLayers(saved), /style/);
});

test("stored contributor names must be bounded text before label rendering", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    const polygon = triangle(annotations, layer.id);
    polygon.contributor = "";
    assert.equal(readAnnotationLayers(annotations.document())[0].polygons[0].contributor, "");
    polygon.contributor = 123;
    assert.throws(() => readAnnotationLayers(annotations.document()), /text/);
    polygon.contributor = "x".repeat(161);
    assert.throws(() => readAnnotationLayers(annotations.document()), /text/);
});


test("saved positions accept older documents and reject invalid stack indices", () => {
    const annotations = model();
    annotations.createLayer(); annotations.createLayer();
    const saved = annotations.document();
    saved.layers.forEach(layer => { delete layer.position; });
    assert.deepEqual(readAnnotationLayers(saved).map(layer => layer.position), [0, 1]);
    for (const position of [-1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
        saved.layers[0].position = position;
        assert.throws(() => readAnnotationLayers(saved), /position/);
    }
});


test("shape, name and notes remain private through outline closure and commit together", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    const polygon = triangle(annotations, layer.id);
    const saved = annotations.document();
    annotations.beginPolygon(layer.id, polygon.id);
    annotations.updateDraftText("  Corridor  ", "Survey the river");
    annotations.addVertex([-73.5, -5], 1);
    annotations.closePolygonOutline();
    assert.deepEqual(annotations.document(), saved);
    assert.equal(annotations.draft.outlineClosed, true);
    assert.equal(annotations.savePolygon(), polygon);
    assert.equal(polygon.name, "Corridor");
    assert.equal(polygon.note, "Survey the river");
    assert.equal(polygon.vertices.length, 4);
});

test("invalid saves and Cancel preserve all committed polygon fields", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    const polygon = triangle(annotations, layer.id);
    const saved = annotations.document();
    annotations.beginPolygon(layer.id, polygon.id);
    annotations.updateDraftText("Draft", "Not sent");
    annotations.draft.polygon.vertices = [[0, 0], [1, 1]];
    assert.throws(() => annotations.closePolygonOutline(), /3 vertices/);
    assert.throws(() => annotations.savePolygon(), /3 vertices/);
    assert.deepEqual(annotations.document(), saved);
    assert.throws(() => annotations.updateDraftText("x".repeat(161), "note"), /too long/);
    assert.equal(annotations.draft.polygon.name, "Draft");
    annotations.cancelPolygon();
    assert.deepEqual(annotations.document(), saved);
    annotations.beginPolygon(layer.id);
    annotations.updateDraftText("", "New draft");
    annotations.cancelPolygon();
    assert.deepEqual(annotations.document(), saved);
});

test("edge insertion preserves ring order and remains an isolated edit until Save", () => {
    const annotations = model();
    const layer = annotations.createLayer();
    const polygon = triangle(annotations, layer.id);
    const saved = annotations.document();
    annotations.beginPolygon(layer.id, polygon.id);
    annotations.addVertex([-73.5, -5], 1);
    assert.deepEqual(annotations.draft.polygon.vertices, [[-75, -5], [-73.5, -5], [-72, -5], [-74, -2]]);
    annotations.addVertex([-74.5, -3.5], 4);
    assert.deepEqual(annotations.document(), saved);
    annotations.cancelPolygon();
    assert.deepEqual(annotations.document(), saved);
    annotations.beginPolygon(layer.id, polygon.id);
    annotations.addVertex([-73.5, -5], 1);
    assert.equal(annotations.savePolygon().vertices.length, 4);
    assert.equal(layer.polygons[0].id, polygon.id);
});

test("invalid insertion indices and the vertex cap leave the draft unchanged", () => {
    const annotations = model();
    assert.throws(() => annotations.addVertex([0, 0], 1), /Start a polygon/);
    const layer = annotations.createLayer();
    annotations.beginPolygon(layer.id);
    annotations.addVertex([0, 0]); annotations.addVertex([2, 0]);
    const original = structuredClone(annotations.draft);
    for (const index of [-1, 3, 0.5, null, "1"]) {
        assert.throws(() => annotations.addVertex([1, 0], index), /Choose an edge/);
        assert.deepEqual(annotations.draft, original);
    }
    annotations.draft.polygon.vertices = Array.from({ length: MAX_POLYGON_VERTICES }, () => [0, 0]);
    assert.throws(() => annotations.addVertex([1, 0], 1), /at most/);
    assert.equal(annotations.draft.polygon.vertices.length, MAX_POLYGON_VERTICES);
});

test("creating and loading annotations enforce the same layer limit", () => {
    const annotations = model();
    for (let index = 0; index < MAX_ANNOTATION_LAYERS; index += 1) annotations.createLayer();
    const saved = annotations.document();
    assert.equal(readAnnotationLayers(saved).length, MAX_ANNOTATION_LAYERS);
    assert.throws(() => annotations.createLayer(), {
        message: `This device already has ${MAX_ANNOTATION_LAYERS} polygon layers.`,
    });
    assert.deepEqual(annotations.document(), saved);
    saved.layers.push({ ...structuredClone(saved.layers[0]), id: "extra-layer" });
    assert.throws(() => readAnnotationLayers(saved), /exceed the storage limit/);
});

test("layer restoration keeps committed geometry, notes, names, filter and appearance with original IDs", () => {
    const model = new AnnotationModel();
    const layer = model.createLayer();
    layer.name = "Workshop";
    layer.filter = { enabled: true, match: "all", rules: [{ field: "name", operator: "contains", value: "river" }] };
    layer.position = 3; layer.visible = false; layer.opacity = 0.4;
    model.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => model.addVertex(point));
    const polygon = model.savePolygon(); polygon.name = "River"; polygon.note = "Flooding";
    const snapshot = structuredClone(layer);
    model.layers = [];
    const restored = model.restoreRemovedLayer(snapshot);
    assert.deepEqual(restored, snapshot);
    assert.notEqual(restored, snapshot);
    assert.deepEqual(readAnnotationLayers(model.document()), [snapshot]);
    assert.throws(() => model.restoreRemovedLayer(snapshot), /already on the map/);
    assert.equal(model.layers.length, 1);
});

test("restoring a removed annotation respects collection capacity without replacing existing layers", () => {
    const model = new AnnotationModel();
    const snapshot = structuredClone(model.createLayer());
    model.layers = [];
    for (let i = 0; i < 32; i++) model.createLayer();
    const before = model.document();
    assert.throws(() => model.restoreRemovedLayer(snapshot), /already has 32/);
    assert.deepEqual(model.document(), before);
});

test("layer Undo rejects a document exceeding device storage capacity without mutating the collection", () => {
    const model = new AnnotationModel();
    const snapshot = structuredClone(model.createLayer());
    model.layers = [];
    const current = model.createLayer();
    for (const layer of [snapshot, current]) {
        layer.polygons = Array.from({ length: 450 }, (_, index) => ({
            id: `${layer.id}-${index}`, name: "Site", note: "n".repeat(10000), vertices: [[0, 0], [2, 0], [1, 2]],
        }));
    }
    assert.throws(() => model.restoreRemovedLayer(snapshot), /8 MiB/);
    assert.equal(model.layers.length, 1);
    assert.equal(model.layers[0], current);
});
