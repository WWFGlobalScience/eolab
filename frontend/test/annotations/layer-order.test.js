import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationController } from "../../src/annotations/controller.js";
import { AnnotationModel, readAnnotationLayers } from "../../src/annotations/model.js";
import { MapLayerController } from "../../src/map-layers/controller.js";

/**
 * Connect annotation ordering to the real layer controller without drawing DOM controls.
 * @return {Object} Annotation owner, layer stack, saved documents and source adapter.
 */
function fixture() {
    const saved = [];
    const annotations = Object.create(AnnotationController.prototype);
    Object.assign(annotations, { model: new AnnotationModel(), loaded: false, orderRestored: false,
        save() { saved.push(this.model.document()); } });
    const layers = new MapLayerController({
        leafletMap: { removeLayer() {} },
        view: { bind() {}, render() {}, setStatus() {}, announceStatus() {} },
        onLayersChange: snapshots => annotations.observeLayerOrder(snapshots),
        onOrderChange: snapshots => annotations.observeLayerOrder(snapshots, true),
    });
    annotations.mapLayers = layers;
    const adapter = {
        tileErrorMessage: "Test tiles unavailable", label: item => item.id, publish: async () => ({}), createState: () => ({}), snapshot: () => ({}),
        renderDescriptor: () => ({ layerName: "test", styleName: "test", styleDefinition: {} }),
        createLayer: () => ({ addTo() { return this; }, setOpacity() {}, setZIndex() {} }),
    };
    return { annotations, layers, saved, adapter };
}

/**
 * Load saved annotations through the layer boundary, as the annotation owner does on startup.
 * @param {Object} context Fixture with annotation and map-layer owners.
 * @param {Object} document Previously saved annotation document.
 * @return {void}
 */
function loadAnnotations({ annotations, layers, adapter }, document) {
    annotations.model.layers = readAnnotationLayers(document);
    for (const layer of [...annotations.model.layers].reverse()) {
        layers.addLocal({ key: `local:annotation:${layer.id}`, label: layer.name, visible: layer.visible }, adapter);
    }
    annotations.loaded = true;
}

test("annotation positions round trip between Catalog layers whichever startup load finishes first", async () => {
    const model = new AnnotationModel();
    const bottom = model.createLayer(), middle = model.createLayer(), top = model.createLayer();
    [top.position, middle.position, bottom.position] = [0, 2, 4];
    middle.visible = false;
    const document = model.document();
    for (const annotationFirst of [true, false]) {
        const context = fixture();
        const { annotations, layers, saved, adapter } = context;
        if (annotationFirst) loadAnnotations(context, document);
        const staged = await Promise.all(["raster", "vector"].map(id => layers.stage({ collection: "catalog", id }, adapter)));
        layers.commitStaged(staged);
        if (!annotationFirst) loadAnnotations(context, document);
        assert.equal(saved.length, 0, "startup insertions must not overwrite saved positions");
        annotations.restoreLayerOrder();
        const order = layers.snapshots().map(layer => layer.key);
        assert.deepEqual(order, [`local:annotation:${top.id}`, staged[0].key,
            `local:annotation:${middle.id}`, staged[1].key, `local:annotation:${bottom.id}`]);
        assert.equal(layers.getRecord(`local:annotation:${middle.id}`).entry.visible, false);
        assert.deepEqual(annotations.model.document(), document);
        layers.reorder(staged[1].key, 0);
        assert.deepEqual(saved.at(-1).layers.map(layer => layer.position), [1, 3, 4]);
        annotations.restoreLayerOrder();
        assert.equal(layers.snapshots()[0].key, staged[1].key, "startup order applies only once");
    }
});

test("unavailable Catalog layers clamp saved positions while preserving annotation order", () => {
    const model = new AnnotationModel();
    const second = model.createLayer(), first = model.createLayer();
    first.position = 3; second.position = 8;
    const context = fixture();
    loadAnnotations(context, model.document());
    context.annotations.restoreLayerOrder();
    assert.deepEqual(context.saved.at(-1).layers.map(layer => [layer.id, layer.position]), [[first.id, 0], [second.id, 1]]);
});

test("a user reorder before startup finishes replaces the saved annotation position", async () => {
    const model = new AnnotationModel();
    const annotation = model.createLayer();
    annotation.position = 0;
    const context = fixture();
    const staged = await context.layers.stage({ collection: "catalog", id: "raster" }, context.adapter);
    context.layers.commitStaged([staged]);
    loadAnnotations(context, model.document());
    context.layers.reorder(`local:annotation:${annotation.id}`, 1);
    context.annotations.restoreLayerOrder();
    assert.deepEqual(context.layers.snapshots().map(layer => layer.key), [staged.key, `local:annotation:${annotation.id}`]);
    assert.equal(context.saved.at(-1).layers[0].position, 1);
});
