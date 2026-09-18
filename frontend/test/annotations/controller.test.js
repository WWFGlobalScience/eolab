import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationController } from "../../src/annotations/controller.js";
import { AnnotationModel } from "../../src/annotations/model.js";

/**
 * Connect controller status behavior to a model and minimal browser/storage substitutes.
 * @return {AnnotationController} Controller with collapsed tools and successful empty storage.
 */
function controller() {
    const annotations = Object.create(AnnotationController.prototype);
    Object.assign(annotations, {
        model: new AnnotationModel(), loaded: true, dirty: false, saving: false, pendingSave: false,
        toolsDisclosure: { open: false }, status: { textContent: "" },
        fileStatus: { textContent: "", classList: { add() {}, remove() {} } },
        retryButton: { hidden: true }, createButton: { disabled: true }, importButton: { disabled: true },
        storage: { async load() { return []; }, async save() {} },
        document: { createElement() { return { remove() {} }; } },
    });
    return annotations;
}

test("storage failure reveals Retry saving without discarding unsaved annotation data", async () => {
    const annotations = controller();
    annotations.model.createLayer();
    const before = annotations.model.document();
    annotations.storage.save = async () => { throw new Error("Device storage is full"); };
    await annotations.save();
    assert.equal(annotations.toolsDisclosure.open, true);
    assert.equal(annotations.retryButton.hidden, false);
    assert.equal(annotations.dirty, true);
    assert.match(annotations.status.textContent, /Not saved: Device storage is full/);
    assert.deepEqual(annotations.model.document(), before);
    annotations.toolsDisclosure.open = false;
    annotations.storage.save = async () => {};
    await annotations.save();
    assert.equal(annotations.toolsDisclosure.open, false, "successful autosave does not force tools open");
    assert.equal(annotations.dirty, false);
    assert.equal(annotations.retryButton.hidden, true);
});

test("successful startup leaves tools closed but a storage load failure expands them", async () => {
    const annotations = controller();
    annotations.loaded = false;
    await annotations.load();
    assert.equal(annotations.toolsDisclosure.open, false);
    assert.equal(annotations.createButton.disabled, false);
    const failed = controller();
    failed.loaded = false;
    failed.storage.load = async () => { throw new Error("Cannot open database"); };
    await failed.load();
    assert.equal(failed.toolsDisclosure.open, true);
    assert.equal(failed.loaded, false);
    assert.equal(failed.createButton.disabled, true);
    assert.match(failed.status.textContent, /Cannot open saved annotations/);
});

test("action and export errors expand tools while draft errors stay in the map editor", () => {
    const annotations = controller();
    annotations.perform(() => { throw new Error("Layer limit reached"); });
    assert.equal(annotations.toolsDisclosure.open, true);
    assert.equal(annotations.status.textContent, "Layer limit reached");
    annotations.toolsDisclosure.open = false;
    annotations.exportGeoJSONFile("missing-layer");
    assert.equal(annotations.toolsDisclosure.open, true);
    assert.match(annotations.fileStatus.textContent, /Cannot export GeoJSON/);
    annotations.toolsDisclosure.open = false;
    const layer = annotations.model.createLayer();
    annotations.model.beginPolygon(layer.id);
    let editorMessage;
    annotations.renderEditor = message => { editorMessage = message; };
    annotations.perform(() => annotations.model.savePolygon());
    assert.match(editorMessage, /at least 3 vertices/);
    assert.equal(annotations.toolsDisclosure.open, false);
    assert.ok(annotations.model.draft);
});

test("polygon deletion expands tools so its existing Undo action remains discoverable", () => {
    const annotations = controller();
    const layer = annotations.model.createLayer();
    annotations.model.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    const polygon = annotations.model.savePolygon();
    annotations.updateEditor = () => {};
    annotations.refreshLayer = () => {};
    annotations.save = async () => {};
    annotations.deletePolygon(layer.id, polygon.id);
    assert.equal(annotations.toolsDisclosure.open, true);
    assert.equal(annotations.model.deleted.polygon.id, polygon.id);
});
