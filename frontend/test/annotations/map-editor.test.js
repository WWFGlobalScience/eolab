import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationMapEditor } from "../../src/annotations/map-editor.js";
import { AnnotationModel } from "../../src/annotations/model.js";

/**
 * Supply the small Leaflet projection and point contract used by polygon dragging.
 * @param {number} x Horizontal coordinate.
 * @param {number} y Vertical coordinate.
 * @return {Object} Immutable point with vector addition and subtraction.
 */
function point(x, y) {
    return { x, y, add: other => point(x + other.x, y + other.y),
        subtract: other => point(x - other.x, y - other.y) };
}

/**
 * Exercise drag gestures against an isolated model draft and a small Leaflet double.
 * @param {boolean} [mapDragging=true] Existing map-pan preference.
 * @return {Object} Gesture subject, saved model, capture target and map-pan state.
 */
function setup(mapDragging = true) {
    const model = new AnnotationModel([], () => "test-id");
    const layer = model.createLayer();
    model.beginPolygon(layer.id);
    [[1, 1], [3, 1], [2, 3]].forEach(vertex => model.addVertex(vertex));
    const polygon = model.savePolygon();
    model.beginPolygon(layer.id, polygon.id);
    let captured = null;
    const target = { setPointerCapture: id => { captured = id; },
        hasPointerCapture: id => captured === id,
        releasePointerCapture: () => { captured = null; } };
    const editor = Object.create(AnnotationMapEditor.prototype);
    editor.draft = model.draft;
    editor.polygonDrag = null;
    editor.map = { getZoom: () => 5,
        mouseEventToContainerPoint: event => point(event.clientX, event.clientY),
        project: ([lat, lng]) => point(lng * 10, lat * 10),
        unproject: position => ({ lng: position.x / 10, lat: position.y / 10 }),
        dragging: { enabled: () => mapDragging, disable: () => { mapDragging = false; }, enable: () => { mapDragging = true; } },
        getContainer: () => ({ classList: { add() {}, remove() {} } }) };
    editor.vertexMarkers = model.draft.polygon.vertices.map(() => ({ setLatLng() {} }));
    const shape = { setLatLngs() {} };
    const event = (x, y) => ({ pointerId: 7, button: 0, isPrimary: true,
        currentTarget: target, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
    return { model, editor, target, shape, event, panEnabled: () => mapDragging };
}

test("interior dragging translates the draft as a whole and leaves saved geometry untouched", () => {
    const { model, editor, target, shape, event, panEnabled } = setup();
    const saved = model.document();
    editor.startPolygonDrag(event(100, 100), shape);
    assert.equal(panEnabled(), false);
    assert.equal(target.hasPointerCapture(7), true);
    editor.movePolygon(event(120, 130));
    assert.deepEqual(model.draft.polygon.vertices, [[3, 4], [5, 4], [4, 6]]);
    assert.deepEqual(model.document(), saved);
    editor.finishPolygonDrag(false);
    assert.equal(target.hasPointerCapture(7), false);
    assert.equal(panEnabled(), true);
    assert.equal(editor.suppressClick, true);
    assert.deepEqual(model.savePolygon().vertices, [[3, 4], [5, 4], [4, 6]]);
});

test("canceling a drag restores its starting vertices without enabling disabled map panning", () => {
    const { model, editor, shape, event, panEnabled } = setup(false);
    const original = structuredClone(model.draft.polygon.vertices);
    editor.startPolygonDrag(event(10, 10), shape);
    editor.movePolygon(event(30, 40));
    editor.finishPolygonDrag(true);
    assert.deepEqual(model.draft.polygon.vertices, original);
    assert.equal(panEnabled(), false);
    editor.finishPolygonDrag(true);
});

test("a click or another pointer cannot accidentally move the polygon", () => {
    const { model, editor, shape, event } = setup();
    const original = structuredClone(model.draft.polygon.vertices);
    editor.startPolygonDrag({ ...event(10, 10), button: 2 }, shape);
    assert.equal(editor.polygonDrag, null);
    editor.startPolygonDrag(event(10, 10), shape);
    editor.movePolygon({ ...event(100, 100), pointerId: 9 });
    editor.movePolygon(event(11, 11));
    assert.deepEqual(model.draft.polygon.vertices, original);
    assert.equal(editor.polygonDrag.moved, false);
    editor.finishPolygonDrag(false);
});
