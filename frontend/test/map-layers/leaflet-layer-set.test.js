import assert from "node:assert/strict";
import test from "node:test";

import { LeafletLayerSet } from "../../src/map-layers/leaflet-layer-set.js";

/** Create a Leaflet-compatible layer with inspectable presentation state. */
function createLayer() {
    const handlers = new Map();
    const container = { style: {} };
    return {
        redrawCount: 0,
        addTo(map) {
            map.attached.add(this);
            return this;
        },
        setOpacity(opacity) {
            this.opacity = opacity;
        },
        setZIndex(zIndex) {
            this.zIndex = zIndex;
        },
        getContainer() {
            return container;
        },
        on(event, handler) {
            const eventHandlers = handlers.get(event) ?? new Set();
            eventHandlers.add(handler);
            handlers.set(event, eventHandlers);
        },
        off(event, handler) {
            handlers.get(event)?.delete(handler);
        },
        emit(event) {
            for (const handler of handlers.get(event) ?? []) handler();
        },
        redraw() {
            this.redrawCount += 1;
            return this;
        },
        container,
    };
}

test("Leaflet layer set owns attachment, opacity, order, and cleanup", () => {
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    const layers = new LeafletLayerSet(map);
    const bottom = createLayer();
    const top = createLayer();

    layers.add("bottom", bottom, { visible: true, opacity: 0.8 });
    layers.add("top", top, { visible: false, opacity: 1 });
    layers.setOrder(["top", "bottom"]);
    layers.setVisible("top", true);
    layers.setVisible("bottom", false);
    layers.setOpacity("top", 0.4);

    assert.equal(layers.get("top"), top);
    assert.equal(layers.isAttached("top"), true);
    assert.equal(layers.isAttached("bottom"), false);
    assert.equal(top.opacity, 0.4);
    assert.ok(top.zIndex > bottom.zIndex);
    assert.throws(() => layers.setOrder(["top", "top"]), Error);

    layers.clear();

    assert.equal(map.attached.size, 0);
    assert.equal(layers.get("top"), null);
});

test("Leaflet layer set atomically isolates selected individual grids", () => {
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    const updates = [];
    let clears = 0;
    const layers = new LeafletLayerSet(map, {
        update(rendering) {
            updates.push(rendering);
        },
        clear() {
            clears += 1;
        },
    });
    const top = createLayer();
    const bottom = createLayer();
    const unrelated = createLayer();
    layers.add("top", top, { visible: true, opacity: 0.8 });
    layers.add("bottom", bottom, { visible: true, opacity: 0.4 });
    layers.add("unrelated", unrelated, { visible: true, opacity: 1 });
    layers.render([
        {
            key: "top",
            visible: true,
            opacity: 0.8,
            descriptor: { layerName: "eolab:top" },
        },
        {
            key: "bottom",
            visible: true,
            opacity: 0.4,
            descriptor: { layerName: "eolab:bottom" },
        },
        {
            key: "unrelated",
            visible: true,
            opacity: 1,
            descriptor: { layerName: "eolab:unrelated" },
        },
    ]);

    assert.equal(map.attached.size, 0);
    assert.deepEqual(updates.at(-1), [
        { layerName: "eolab:top", opacity: 0.8 },
        { layerName: "eolab:bottom", opacity: 0.4 },
        { layerName: "eolab:unrelated", opacity: 1 },
    ]);
    assert.throws(
        () => layers.setIndividualRendering(["top", "top"]),
        /distinct retained layer keys/,
    );
    assert.throws(
        () => layers.setIndividualRendering(["missing"]),
        /Unknown retained map layer/,
    );
    layers.setIndividualRendering(["top", "bottom"]);
    assert.equal(clears, 0, "composite remains until both grids load");
    assert.deepEqual(map.attached, new Set([bottom, top]));
    assert.equal(top.container.style.visibility, "hidden");
    assert.equal(bottom.container.style.visibility, "hidden");
    assert.equal(unrelated.container.style.visibility, undefined);

    top.emit("load");
    assert.equal(clears, 0);
    assert.equal(top.container.style.visibility, "hidden");
    bottom.emit("load");
    assert.equal(clears, 1);
    assert.equal(top.container.style.visibility, "");
    assert.equal(bottom.container.style.visibility, "");

    layers.setIndividualRendering(null);
    assert.equal(map.attached.size, 0);
    assert.equal(updates.length, 2);
});

test("Leaflet layer set ignores stale loads and retries only a failed grid", () => {
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    let clears = 0;
    const layers = new LeafletLayerSet(map, {
        update() {},
        clear() {
            clears += 1;
        },
    });
    const first = createLayer();
    const second = createLayer();
    const replacement = createLayer();
    layers.add("first", first, { visible: true, opacity: 1 });
    layers.add("second", second, { visible: true, opacity: 1 });
    layers.add("replacement", replacement, { visible: true, opacity: 1 });
    layers.render([
        { key: "first", visible: true, opacity: 1, descriptor: {} },
        { key: "second", visible: true, opacity: 1, descriptor: {} },
        { key: "replacement", visible: true, opacity: 1, descriptor: {} },
    ]);

    layers.setIndividualRendering(["first", "second"]);
    layers.setIndividualRendering(["second", "replacement"]);
    first.emit("load");
    second.emit("load");
    assert.equal(clears, 0);
    assert.equal(replacement.container.style.visibility, "hidden");

    replacement.emit("tileerror");
    replacement.emit("load");
    assert.equal(clears, 0);
    assert.equal(replacement.redrawCount, 1);
    assert.deepEqual(map.attached, new Set([second, replacement]));
    assert.equal(second.container.style.visibility, "hidden");
    assert.equal(replacement.container.style.visibility, "hidden");

    replacement.emit("load");
    assert.equal(clears, 1);
    assert.deepEqual(map.attached, new Set([second, replacement]));
    assert.equal(second.container.style.visibility, "");
    assert.equal(replacement.container.style.visibility, "");
});

test("Leaflet layer set keeps the composite after the bounded retry fails", () => {
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    let clears = 0;
    const layers = new LeafletLayerSet(map, {
        update() {},
        clear() {
            clears += 1;
        },
    });
    const first = createLayer();
    const second = createLayer();
    layers.add("first", first, { visible: true, opacity: 1 });
    layers.add("second", second, { visible: true, opacity: 1 });
    layers.render([
        { key: "first", visible: true, opacity: 1, descriptor: {} },
        { key: "second", visible: true, opacity: 1, descriptor: {} },
    ]);

    layers.setIndividualRendering(["first", "second"]);
    first.emit("tileerror");
    first.emit("load");
    second.emit("load");
    assert.equal(first.redrawCount, 1);
    assert.equal(clears, 0);

    first.emit("tileerror");
    first.emit("load");
    assert.equal(clears, 0);
    assert.equal(map.attached.size, 0);
});

test("local layers interleave with source grids and never enter a server composite", () => {
    const map = {attached: new Set(), removeLayer(layer) { this.attached.delete(layer); }};
    const composites = [];
    const layers = new LeafletLayerSet(map, {clear() {}, update(rendering) { composites.push(rendering); }});
    const raster = createLayer(), local = createLayer();
    layers.add("raster", raster, {visible: true, opacity: 1});
    layers.add("local", local, {visible: true, opacity: 0.5});
    const descriptors = [
        {key: "local", visible: true, opacity: 0.5, descriptor: null},
        {key: "raster", visible: true, opacity: 1, descriptor: {layerName: "eolab:raster"}},
    ];
    layers.render(descriptors);
    assert.deepEqual(map.attached, new Set([raster, local]));
    assert.ok(local.zIndex > raster.zIndex);
    layers.render([...descriptors].reverse());
    assert.ok(raster.zIndex > local.zIndex);
    layers.setIndividualRendering(["raster"]);
    assert.equal(layers.isAttached("local"), true);
    layers.setIndividualRendering(null);
    layers.render(descriptors.map(entry => entry.key === "local" ? {...entry, visible: false} : entry));
    assert.equal(map.attached.size, 0);
    assert.deepEqual(composites.at(-1), [{layerName: "eolab:raster", opacity: 1}]);
});
