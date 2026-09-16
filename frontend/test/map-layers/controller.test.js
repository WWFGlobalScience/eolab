import assert from "node:assert/strict";
import test from "node:test";

import { getCatalogItemKey } from "../../src/catalog-item-identity.js";
import { MapLayerController } from "../../src/map-layers/controller.js";

/** Create a Catalog Item with the identity required by the layer boundary. */
function catalogItem(id) {
    return { collection: "observations", id };
}

/** Create an inspectable semantic view adapter. */
function createView() {
    return {
        handlers: null,
        layers: [],
        activeKey: null,
        status: "",
        announcement: "",
        bind(handlers) {
            this.handlers = handlers;
        },
        unbind() {
            this.handlers = null;
        },
        render(layers, activeKey) {
            this.layers = layers;
            this.activeKey = activeKey;
        },
        setStatus(status) {
            this.status = status;
            this.announcement = status;
        },
        announceStatus(status) {
            this.status = "";
            this.announcement = status;
        },
    };
}

/** Create an inspectable Leaflet-compatible map. */
function createMap() {
    return {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
}

/** Create an independently owned map-layer adapter. */
function createAdapter(owner, publish = async (item) => ({ id: item.id })) {
    const events = [];
    return {
        events,
        label: (item) => `${owner} ${item.id}`,
        publish,
        createState: ({ item }) => ({ owner, item }),
        renderDescriptor: (record) => ({
            layerName: `eolab:${record.entry.item.id}`,
            styleName: `${owner}-style`,
            styleDefinition: { owner },
        }),
        createLayer: (record, onTileError) => ({
            record,
            onTileError,
            addTo(targetMap) {
                targetMap.attached.add(this);
                return this;
            },
            setOpacity(opacity) {
                this.opacity = opacity;
            },
            setZIndex(zIndex) {
                this.zIndex = zIndex;
            },
        }),
        snapshot: (record) => ({
            legend: {
                kind: "gradient",
                gradient: "linear-gradient(#000000, #ffffff)",
                description: `${record.state.owner} test gradient`,
                labels: [0, 0.5, 1],
            },
        }),
        deactivate: (record, next) =>
            events.push(["deactivate", record.entry.key, next.entry.key]),
        activate: (record) => events.push(["activate", record.entry.key]),
        visibilityChanged: (record, visible) =>
            events.push(["visibility", record.entry.key, visible]),
        orderChanged: (record) =>
            events.push(["order", record.entry.key]),
        tileErrorMessage: `${owner} tiles unavailable`,
    };
}

test("controller owns cross-adapter visibility, ordering, and removal", async () => {
    const map = createMap();
    const view = createView();
    const controller = new MapLayerController({ leafletMap: map, view });
    const firstOwner = createAdapter("first");
    const secondOwner = createAdapter("second");
    const first = catalogItem("one");
    const second = catalogItem("two");
    const third = catalogItem("three");

    await controller.show(first, firstOwner);
    await controller.show(second, secondOwner);
    await controller.show(third, firstOwner);

    assert.equal(view.status, "");
    assert.equal(view.announcement, "first three was added and is visible.");

    assert.equal(controller.retainedRecords.length, 3);
    assert.deepEqual(secondOwner.events, [
        ["activate", getCatalogItemKey(second)],
        [
            "deactivate",
            getCatalogItemKey(second),
            getCatalogItemKey(third),
        ],
    ]);
    assert.equal(controller.visibleCount, 3);
    assert.equal(controller.isAttached(getCatalogItemKey(third)), true);

    view.handlers.onVisibility(getCatalogItemKey(first), false);
    assert.equal(controller.visibleCount, 2);
    view.handlers.onVisibility(getCatalogItemKey(first), true);
    assert.equal(controller.visibleCount, 3);
    controller.setOpacity(getCatalogItemKey(third), 0.35);
    view.handlers.onReorder(getCatalogItemKey(first), 1);

    assert.equal(controller.getLeafletLayer(getCatalogItemKey(third)).opacity, 0.35);
    assert.deepEqual(firstOwner.events.at(-1), [
        "order",
        getCatalogItemKey(first),
    ]);
    assert.deepEqual(
        controller.snapshots().map(({ item }) => item.id),
        ["three", "one", "two"],
    );
    assert.equal(
        view.status,
        "first one moved to position 2 of 3 in the map drawing order.",
    );

    controller.removeOwned(firstOwner);

    assert.deepEqual(
        controller.snapshots().map(({ item }) => item.id),
        ["two"],
    );
    assert.equal(controller.contains(second), true);
    assert.equal(controller.contains(first), false);
});

test("removal preserves a replacement presentation activated by its adapter", async () => {
    const view = createView();
    const controller = new MapLayerController({
        leafletMap: createMap(),
        view,
    });
    const fallback = catalogItem("fallback");
    const removed = catalogItem("removed");
    const fallbackKey = getCatalogItemKey(fallback);
    const fallbackAdapter = createAdapter("fallback");
    const removedAdapter = createAdapter("removed");
    removedAdapter.beforeRemove = () => ({ activateFallback: false });
    removedAdapter.removed = () => controller.activate(fallbackKey);

    await controller.show(fallback, fallbackAdapter);
    await controller.show(removed, removedAdapter);
    controller.remove(removed);

    assert.equal(controller.activeKey, fallbackKey);
    assert.equal(view.activeKey, fallbackKey);
    assert.deepEqual(fallbackAdapter.events.at(-1), ["activate", fallbackKey]);
});

test("controller forwards authoritative Items to composition callbacks", async () => {
    const view = createView();
    const received = [];
    const controller = new MapLayerController({
        leafletMap: createMap(),
        view,
        onItemZoom: (item) => received.push(["zoom", item]),
        onItemInfo: (item) => received.push(["info", item]),
    });
    const item = catalogItem("navigation");
    const key = getCatalogItemKey(item);
    await controller.show(item, createAdapter("test"));

    view.handlers.onZoom(key);
    view.handlers.onInfo(key);

    assert.deepEqual(received, [
        ["zoom", item],
        ["info", item],
    ]);
});

test("controller rejects invalid Item navigation boundaries", () => {
    assert.throws(
        () => new MapLayerController({
            leafletMap: createMap(),
            view: createView(),
            onItemZoom: null,
        }),
        /navigation callbacks must be callable/,
    );
    assert.throws(
        () => new MapLayerController({
            leafletMap: createMap(),
            view: createView(),
            onItemInfo: "details",
        }),
        /navigation callbacks must be callable/,
    );
});

test("on-map membership survives hiding a layer until it is removed", async () => {
    const map = createMap();
    const controller = new MapLayerController({ leafletMap: map, view: createView() });
    const item = catalogItem("membership");
    const key = getCatalogItemKey(item);

    await controller.show(item, createAdapter("test"));
    assert.equal(controller.contains(item), true);
    assert.equal(controller.isAttached(key), true);

    controller.setVisible(key, false);
    assert.equal(controller.contains(item), true);
    assert.equal(controller.isAttached(key), false);

    controller.remove(item);
    assert.equal(controller.contains(item), false);
});

test("controller coalesces publication and invalidates removed pending work", async () => {
    const map = createMap();
    const view = createView();
    let resolvePublication;
    let calls = 0;
    const publication = new Promise((resolve) => {
        resolvePublication = resolve;
    });
    const adapter = createAdapter("delayed", async () => {
        calls += 1;
        return publication;
    });
    const item = catalogItem("pending");
    const controller = new MapLayerController({ leafletMap: map, view });
    const firstRequest = controller.show(item, adapter);
    const repeatedRequest = controller.show({ ...item }, adapter);
    controller.remove(item);
    resolvePublication({ id: item.id });

    assert.equal(await firstRequest, null);
    assert.equal(await repeatedRequest, null);
    assert.equal(calls, 1);
    assert.equal(controller.contains(item), false);
    assert.equal(map.attached.size, 0);
});

test("controller stages layers detached and commits one ordered snapshot", async () => {
    const map = createMap();
    const view = createView();
    let renderCount = 0;
    const render = view.render.bind(view);
    view.render = (...arguments_) => {
        renderCount += 1;
        render(...arguments_);
    };
    const layerChanges = [];
    const controller = new MapLayerController({
        leafletMap: map,
        view,
        onLayersChange: (layers) => layerChanges.push(
            layers.map(({ item }) => item.id)
        ),
    });
    const adapter = createAdapter("batch");
    adapter.added = (record, context) =>
        adapter.events.push(["added", record.entry.key, context.fitToBounds]);
    const top = await controller.stage(
        catalogItem("top"),
        adapter,
        { visible: true, opacity: 0.4 }
    );
    const bottom = await controller.stage(
        catalogItem("bottom"),
        adapter,
        { visible: false, opacity: 0.7 }
    );

    assert.equal(map.attached.size, 0);
    assert.deepEqual(controller.retainedRecords, []);
    assert.equal(renderCount, 1);
    assert.deepEqual(layerChanges, [[]]);

    const committed = controller.commitStaged(
        [top, bottom],
        { fitToBounds: false }
    );

    assert.deepEqual(committed.map(({ entry }) => entry.item.id), [
        "top",
        "bottom",
    ]);
    assert.deepEqual(view.layers.map(({ item }) => item.id), ["top", "bottom"]);
    assert.equal(map.attached.size, 1);
    assert.equal(controller.isAttached(top.key), true);
    assert.equal(controller.isAttached(bottom.key), false);
    assert.equal(controller.getLeafletLayer(top.key).opacity, 0.4);
    assert.equal(controller.getLeafletLayer(bottom.key).opacity, 0.7);
    assert.ok(
        controller.getLeafletLayer(top.key).zIndex >
        controller.getLeafletLayer(bottom.key).zIndex
    );
    assert.equal(renderCount, 2);
    assert.deepEqual(layerChanges, [[], ["top", "bottom"]]);
    assert.deepEqual(
        adapter.events.filter(([event]) => event === "added"),
        [
            ["added", top.key, false],
            ["added", bottom.key, false],
        ]
    );
});

test("controller copies portable style and layer opacity onto a compatible target", async () => {
    const map = createMap();
    const view = createView();
    const adapter = createAdapter("raster");
    adapter.createState = ({ item }) => ({
        owner: "raster",
        item,
        style: { color: item.id === "source" ? "red" : "blue" },
    });
    adapter.exportSavedState = (record) => ({
        kind: "raster",
        definition: record.state.style,
    });
    adapter.checkSavedStateCompatibility = (_record, savedState) =>
        savedState.kind === "raster" ? null : "Raster style required.";
    adapter.applySavedState = async (record, savedState) => {
        record.state.style = structuredClone(savedState.definition);
    };
    const controller = new MapLayerController({ leafletMap: map, view });
    const source = catalogItem("source");
    const target = catalogItem("target");
    await controller.show(source, adapter);
    await controller.show(target, adapter);
    const sourceKey = getCatalogItemKey(source);
    const targetKey = getCatalogItemKey(target);
    controller.setOpacity(sourceKey, 0.37);
    controller.setOpacity(targetKey, 0.82);

    assert.equal(
        controller.snapshots().find(({ key }) => key === targetKey)
            .styleClipboard.canPaste,
        false,
    );
    assert.equal(controller.copyStyle(sourceKey), true);
    controller.getRecord(sourceKey).state.style.color = "green";
    const targetClipboard = controller.snapshots().find(
        ({ key }) => key === targetKey,
    ).styleClipboard;
    assert.equal(targetClipboard.canPaste, true);
    assert.equal(targetClipboard.sourceLabel, "raster source");

    assert.equal(await controller.pasteStyle(targetKey), true);
    assert.deepEqual(controller.getRecord(targetKey).state.style, { color: "red" });
    assert.equal(controller.getRecord(targetKey).entry.opacity, 0.37);
    assert.equal(controller.getLeafletLayer(targetKey).opacity, 0.37);
    assert.equal(
        view.status,
        "Style and opacity from raster source pasted onto raster target.",
    );
});

test("controller rejects incompatible and failed pastes without changing opacity", async () => {
    const map = createMap();
    const view = createView();
    const raster = createAdapter("raster");
    raster.createState = ({ item }) => ({ owner: "raster", item, style: "source" });
    raster.exportSavedState = (record) => ({
        kind: "raster",
        definition: record.state.style,
    });
    raster.checkSavedStateCompatibility = () => null;
    raster.applySavedState = async () => {};
    const vector = createAdapter("vector");
    vector.createState = ({ item }) => ({ owner: "vector", item, style: "target" });
    vector.exportSavedState = (record) => ({
        kind: "vector",
        definition: record.state.style,
    });
    vector.checkSavedStateCompatibility = (_record, savedState) =>
        savedState.kind === "vector" ? null : "Only vector styles are compatible.";
    vector.applySavedState = async () => {
        throw new Error("The target fields changed.");
    };
    const controller = new MapLayerController({ leafletMap: map, view });
    const source = catalogItem("source");
    const target = catalogItem("target");
    await controller.show(source, raster);
    await controller.show(target, vector);
    const sourceKey = getCatalogItemKey(source);
    const targetKey = getCatalogItemKey(target);
    controller.setOpacity(sourceKey, 0.25);
    controller.setOpacity(targetKey, 0.75);
    controller.copyStyle(sourceKey);

    const incompatible = controller.snapshots().find(
        ({ key }) => key === targetKey,
    ).styleClipboard;
    assert.equal(incompatible.canPaste, false);
    assert.equal(incompatible.pasteReason, "Only vector styles are compatible.");
    assert.equal(await controller.pasteStyle(targetKey), false);
    assert.equal(controller.getRecord(targetKey).state.style, "target");
    assert.equal(controller.getRecord(targetKey).entry.opacity, 0.75);

    vector.checkSavedStateCompatibility = () => null;
    assert.equal(await controller.pasteStyle(targetKey), false);
    assert.equal(controller.getRecord(targetKey).state.style, "target");
    assert.equal(controller.getRecord(targetKey).entry.opacity, 0.75);
    assert.match(view.status, /The target fields changed/);
});

test("bulk visibility preserves layers and notifies owners and composition once", async () => {
    const map = createMap();
    const basemap = {};
    map.attached.add(basemap);
    map.fitBounds = () => assert.fail("Visibility must not change the viewport");
    const view = createView();
    const changes = [];
    const controller = new MapLayerController({
        leafletMap: map, view, onLayersChange: layers => changes.push(layers),
    });
    const raster = createAdapter("raster");
    const vector = createAdapter("vector");
    for (const adapter of [raster, vector]) {
        const originalSnapshot = adapter.snapshot;
        adapter.snapshot = record => ({
            ...originalSnapshot(record), datasetKind: record.state.owner,
        });
    }
    await controller.show(catalogItem("raster"), raster);
    await controller.show(catalogItem("vector"), vector);
    const [vectorRecord, rasterRecord] = controller.retainedRecords;
    vectorRecord.state.filter = { field: "year", value: 2020 };
    rasterRecord.state.style = { minimum: 0, maximum: 100 };
    controller.setOpacity(rasterRecord.entry.key, 0.35);
    controller.setVisible(vectorRecord.entry.key, false);
    const before = controller.snapshots();
    const state = controller.retainedRecords.map(record => structuredClone(record.state));
    const activeKey = controller.activeKey;
    const layers = controller.retainedRecords.map(record => controller.getLeafletLayer(record.entry.key));
    changes.length = 0;
    raster.events.length = 0;
    vector.events.length = 0;

    view.handlers.onAllVisibility(false);
    assert.equal(changes.length, 1);
    assert.deepEqual(raster.events, [["visibility", rasterRecord.entry.key, false]]);
    assert.deepEqual(vector.events, [], "Already hidden layers are untouched");
    assert.deepEqual([...map.attached], [basemap]);
    assert.equal(view.announcement, "1 map layer hidden.");
    view.handlers.onAllVisibility(false);
    assert.equal(changes.length, 1, "A no-op does not refresh consumers");

    view.handlers.onAllVisibility(true);
    assert.equal(changes.length, 2);
    assert.ok(changes[1].every(layer => layer.visible));
    assert.deepEqual(controller.snapshots(), before.map(layer => ({ ...layer, visible: true })));
    assert.deepEqual(controller.retainedRecords.map(record => record.state), state);
    assert.equal(controller.activeKey, activeKey);
    assert.deepEqual(
        controller.retainedRecords.map(record => controller.getLeafletLayer(record.entry.key)), layers,
    );
    assert.equal(map.attached.size, 3);
    assert.deepEqual(vector.events, [["visibility", vectorRecord.entry.key, true]]);
    view.handlers.onAllVisibility(true);
    assert.equal(changes.length, 2);
    view.handlers.onVisibility(vectorRecord.entry.key, false);
    assert.equal(controller.visibleCount, 1, "Individual toggles still work");
    assert.equal(changes.length, 3);
});

test("bulk visibility does not change empty stacks or pending additions", async () => {
    const view = createView();
    const changes = [];
    const controller = new MapLayerController({
        leafletMap: createMap(), view, onLayersChange: layers => changes.push(layers),
    });
    changes.length = 0;
    view.handlers.onAllVisibility(false);
    view.handlers.onAllVisibility(true);
    assert.equal(changes.length, 0);
    assert.throws(() => controller.setAllVisible(null), /visibility must be boolean/);
    let finish;
    const pending = controller.show(catalogItem("pending"), createAdapter("raster",
        () => new Promise(resolve => { finish = resolve; })));
    view.handlers.onAllVisibility(false);
    finish({ id: "pending" });
    await pending;
    assert.equal(controller.visibleCount, 1);
});
