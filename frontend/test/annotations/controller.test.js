import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationController } from "../../src/annotations/controller.js";
import { AnnotationModel, readAnnotationLayers } from "../../src/annotations/model.js";
import { exportAnnotationGeoJSON } from "../../src/annotations/geojson.js";
import { EMPTY_VECTOR_FILTER } from "../../src/vector/filter.js";

/**
 * Connect controller status behavior to a model and minimal browser/storage substitutes.
 * @return {AnnotationController} Controller with closed panel and successful empty storage.
 */
function controller() {
    const annotations = Object.create(AnnotationController.prototype);
    Object.assign(annotations, {
        model: new AnnotationModel(), layers: new Map(), shared: new Map(), loaded: true, dirty: false, saving: false, pendingSave: false,
        controls: new Map(), clearedFilterLayerIds: new Set(), inspectionMatches: [], inspectedPolygon: null, onHoverInvalidated() {},
        panel: { open: false, show() { this.open = true; }, showLayer(key) { this.open = true; this.selectedKey = key; } }, status: { textContent: "" },
        fileStatus: { textContent: "", classList: { add() {}, remove() {} } },
        retryButton: { hidden: true }, drawButton: { disabled: true }, importButton: { disabled: true },
        storage: { async load() { return []; }, async save() {} },
        document: { createElement() { return { remove() {} }; } },
    });
    return annotations;
}

test("contributor zoom uses current saved geometry for that person and layer without changing filters or ownership", () => {
    const annotations = controller();
    const layer = annotations.model.createLayer();
    layer.polygons = [{ id: "own-polygon", vertices: [[10, 20], [12, 20], [10, 22]] }];
    layer.filter = { enabled: true, match: "all", rules: [{ field: "name", operator: "eq", value: "matches nothing" }] };
    layer.visible = false;
    annotations.model.createLayer().polygons = [{ id: "unrelated", vertices: [[-100, -50]] }];
    const contributors = [{ id: "own", own: true }, { id: "peer", own: false }, { id: "empty", own: false }];
    const peer = { id: "peer-polygon", contributorId: "peer", vertices: [[30, 40], [32, 40], [30, 42]] };
    annotations.shared.set(layer.id, { contributors, polygons: [peer], canContribute: false });
    const fits = [];
    annotations.leaflet = { latLngBounds: () => ({ points: [], extend(point) { this.points.push(point); }, isValid() { return this.points.length > 0; } }) };
    annotations.map = { fitBounds: (bounds, options) => fits.push({ points: bounds.points, options }) };
    const before = structuredClone(layer);
    annotations.zoomToContributorPolygons(layer.id, "own");
    assert.deepEqual(fits[0], { points: [[20, 10], [20, 12], [22, 10]], options: { padding: [40, 40], maxZoom: 12 } });
    annotations.zoomToContributorPolygons(layer.id, "peer");
    assert.deepEqual(fits[1].points, [[40, 30], [40, 32], [42, 30]], "read-only viewers can zoom to peers");
    assert.deepEqual(layer, before, "zoom leaves visibility, filters, polygons and ownership unchanged");
    peer.vertices = [[35, 45], [36, 45], [35, 46]];
    annotations.zoomToContributorPolygons(layer.id, "peer");
    assert.deepEqual(fits[2].points, [[45, 35], [45, 36], [46, 35]], "later clicks use updated geometry");
    annotations.model.draft = { layerId: layer.id, polygon: { vertices: [[-80, -40]] } };
    annotations.zoomToContributorPolygons(layer.id, "own");
    assert.deepEqual(fits[3].points, fits[0].points, "unfinished edits are excluded");
    annotations.zoomToContributorPolygons(layer.id, "empty");
    annotations.zoomToContributorPolygons(layer.id, "unknown");
    annotations.zoomToContributorPolygons("removed-layer", "peer");
    annotations.shared.get(layer.id).polygons = [];
    annotations.zoomToContributorPolygons(layer.id, "peer");
    layer.polygons = [];
    annotations.zoomToContributorPolygons(layer.id, "own");
    assert.equal(fits.length, 4, "empty, unloaded, removed or unknown contributions leave the map unchanged");
});

test("shared viewer keeps private layers stored but never attaches or exposes them as summary targets", async () => {
    const annotations = controller();
    const privateLayer = annotations.model.createLayer("Private notes");
    privateLayer.name = "Private notes";
    const original = annotations.model.document();
    const attached = [];
    annotations.storage.load = async () => structuredClone(original.layers);
    annotations.attachLayer = layer => { attached.push(layer.id); annotations.layers.set(layer.id, {}); };
    await annotations.load({ attachSavedLayers: false });
    assert.deepEqual(attached, []);
    assert.deepEqual(annotations.summaryTargets(), []);
    await annotations.restoreSharedContribution("Included shared layer", { type: "FeatureCollection", features: [] });
    assert.equal(attached.length, 1);
    assert.equal(annotations.model.layer(privateLayer.id).name, "Private notes");
    assert.equal(annotations.sharableLayers().some(layer => layer.id === privateLayer.id), true, "private data is retained during saves");
    assert.equal(annotations.summaryTargets().length, 1);
});

test("root startup retains cached polygons but attaches shared layers only when its saved map asks for them", async () => {
    const annotations = controller();
    const root = annotations.model.createLayer("Root layer");
    const visited = annotations.model.createLayer("Published-map layer");
    const imported = annotations.model.createLayer("Imported polygons");
    const original = annotations.model.document();
    annotations.storage.load = async () => structuredClone(original.layers);
    const attached = [];
    annotations.attachLayer = layer => { attached.push(layer.id); annotations.layers.set(layer.id, {}); };
    await annotations.load({ sharedLayerIds: [root.id, visited.id] });
    assert.deepEqual(attached, [imported.id]);
    assert.equal(annotations.sharableLayers().length, 3, "cached edits remain available off-map");
    await annotations.restoreSharedContribution(root.name, exportAnnotationGeoJSON(root), { localId: root.id });
    assert.equal(annotations.isLayerOnMap(root.id), true);
    assert.equal(annotations.isLayerOnMap(visited.id), false);
    assert.deepEqual(annotations.model.layer(visited.id), visited);
});

/** Connect the drawing lifecycle to the real model and recorded presentation/save boundaries.
 * @return {Object} Controller, layer and observed UI transitions.
 */
function drawingController() {
    const annotations = controller();
    const layer = annotations.model.createLayer("Habitat areas");
    const calls = [];
    annotations.controls = new Map([[layer.id, { clearPolygonInspection() {}, refresh() { calls.push("controls"); } }]]);
    annotations.layers = new Map();
    annotations.undoButton = {};
    annotations.onEditingChange = editing => calls.push(["editing", editing]);
    annotations.mapLayers = { setVisible() {} };
    annotations.editor = {
        render(draft, message, style, name) { calls.push(["render", !!draft, name, message]); },
        focusTextField(field) { calls.push(["focus", field]); },
    };
    annotations.refreshLayer = (...args) => calls.push(["refresh", ...args]);
    return { annotations, layer, calls };
}

/** Connect private layer creation to existing drawing and device-save boundaries.
 * @return {{annotations:AnnotationController,calls:Array<unknown[]|string>}} Empty annotation controller and observed editor/layer actions.
 */
function privateDrawingController() {
    const { annotations, calls } = drawingController();
    annotations.model = new AnnotationModel();
    annotations.controls.clear();
    annotations.attachLayer = layer => {
        calls.push(["attach", layer.id]);
        annotations.layers.set(layer.id, { setEditingPolygon() {}, setInspectedPolygon() {} });
        annotations.controls.set(layer.id, { clearPolygonInspection() {} });
    };
    return { annotations, calls };
}

test("Draw polygon creates a private device layer whose saved polygons enter ordinary analysis targets", async () => {
    const { annotations, calls } = privateDrawingController();
    const saved = [];
    annotations.storage.save = async document => saved.push(structuredClone(document));
    annotations.drawPrivatePolygon();
    await annotations.savePromise;
    const [layer] = annotations.model.layers;
    assert.equal(layer.name, "Polygon layer 1");
    assert.equal(annotations.shared.size, 0);
    assert.equal(annotations.layers.has(layer.id), true);
    assert.equal(annotations.panel.selectedKey, `local:annotation:${layer.id}`);
    assert.equal(annotations.model.draft.layerId, layer.id);
    assert.equal(calls.some(call => call[0] === "editing" && call[1]), true);
    annotations.model.updateDraftText("Assessment forest", "Private sketch");
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    assert.deepEqual(saved[0].layers[0].polygons, [], "unfinished drawing is never persisted");
    assert.deepEqual(annotations.summaryTargets()[0].polygons, [], "unfinished drawing is never sampled");
    annotations.finishPolygon();
    await annotations.savePromise;
    assert.equal(annotations.model.draft, null);
    assert.equal(annotations.summaryTargets()[0].polygons[0].note, "Private sketch");
    assert.deepEqual(readAnnotationLayers(saved.at(-1)), annotations.model.layers);
    assert.equal(annotations.shared.size, 0, "saving never creates a shared membership");
});

test("private layer creation preserves an existing draft and creates no extra layer", async () => {
    const { annotations, calls } = privateDrawingController();
    annotations.drawPrivatePolygon();
    await annotations.savePromise;
    annotations.model.updateDraftText("Keep this", "Unfinished notes");
    annotations.model.addVertex([2, 3]);
    const before = structuredClone(annotations.model.draft);
    const beforeLayers = annotations.model.document();
    annotations.drawPrivatePolygon();
    assert.deepEqual(annotations.model.draft, before);
    assert.deepEqual(annotations.model.document(), beforeLayers);
    assert.match(calls.filter(call => call[0] === "render").at(-1)[3], /Save or cancel/);
    assert.equal(calls.filter(call => call[0] === "attach").length, 1);
});

test("private drawing cannot replace polygons while device storage is unavailable", async () => {
    const { annotations } = privateDrawingController();
    annotations.loaded = false;
    annotations.storage.load = async () => { throw new Error("Cannot open database"); };
    let writes = 0;
    annotations.storage.save = async () => { writes++; };
    await annotations.load();
    annotations.drawPrivatePolygon();
    assert.equal(annotations.drawButton.disabled, true);
    assert.equal(annotations.model.layers.length, 0);
    assert.equal(annotations.model.draft, null);
    assert.equal(writes, 0);
    assert.match(annotations.status.textContent, /Cannot open database/);
});

test("a new private drawing survives a failed device save and can retry without losing the draft", async () => {
    const { annotations } = privateDrawingController();
    annotations.storage.save = async () => { throw new Error("Storage full"); };
    annotations.drawPrivatePolygon();
    annotations.model.updateDraftText("Keep this polygon", "Keep these notes");
    annotations.model.addVertex([2, 3]);
    await annotations.savePromise;
    const before = structuredClone(annotations.model.draft);
    assert.equal(annotations.model.layers.length, 1);
    assert.equal(annotations.dirty, true);
    assert.equal(annotations.retryButton.hidden, false);
    assert.match(annotations.status.textContent, /Not saved: Storage full/);
    const saved = [];
    annotations.storage.save = async document => saved.push(document);
    await annotations.save();
    assert.equal(annotations.dirty, false);
    assert.deepEqual(annotations.model.draft, before);
    assert.equal(saved[0].layers[0].id, before.layerId);
    assert.deepEqual(saved[0].layers[0].polygons, []);
});

/** @return {Object} Real annotation owner/model with observable panel, hit and highlight boundaries. */
function inspectionController() {
    const annotations = controller();
    const layer = annotations.model.createLayer("Habitats");
    layer.name = "Habitats";
    annotations.model.beginPolygon(layer.id);
    for (const vertex of [[0, 0], [2, 0], [1, 2]]) annotations.model.addVertex(vertex);
    const own = annotations.model.savePolygon();
    const peer = { ...own, id: "peer-0", name: "A neighbour's polygon", contributor: "Maria" };
    annotations.shared.set(layer.id, { contributors: [{ own: true, name: "Lee" }], polygons: [peer], canContribute: true });
    const controls = { inspection: { scrollIntoView() {} }, clearPolygonInspection() { this.hit = null; },
        showPolygonInspection(hit, matches, select) { Object.assign(this, { hit, matches, select }); }, setCollaboration() {} };
    const rendering = { polygonsAt: () => annotations.displayLayer(layer).polygons.slice().reverse(),
        setInspectedPolygon(id) { this.highlight = id; }, refresh() {} };
    annotations.layers.set(layer.id, rendering); annotations.controls.set(layer.id, controls);
    annotations.mapLayers = { render() {} };
    return { annotations, layer, own, peer, controls, rendering };
}

test("click selects the topmost peer read-only and offers the author's own polygon without changing ownership", () => {
    const h = inspectionController();
    assert.equal(h.annotations.inspectAt({ lat: 0.5, lng: 1 }), true);
    assert.equal(h.controls.hit.polygon.id, h.peer.id);
    assert.equal(h.controls.hit.canEdit, false);
    assert.equal(h.rendering.highlight, h.peer.id);
    assert.equal(h.annotations.panel.selectedKey, `local:annotation:${h.layer.id}`);
    h.controls.select(1);
    assert.equal(h.controls.hit.polygon.id, h.own.id);
    assert.equal(h.controls.hit.canEdit, true);
    assert.equal(h.rendering.highlight, h.own.id);
    h.annotations.shared.get(h.layer.id).canContribute = false;
    h.annotations.refreshInspection();
    assert.equal(h.controls.hit.canEdit, false, "a membership change removes editing actions");
});

test("hiding, filtering, deleting, drawing and empty clicks cannot retain stale polygon details", () => {
    const h = inspectionController();
    const click = () => h.annotations.inspectAt({ lat: 0.5, lng: 1 });
    click(); h.layer.visible = false; h.annotations.refreshInspection();
    assert.equal(h.controls.hit, null); assert.equal(h.rendering.highlight, null);
    assert.equal(click(), false);
    h.layer.visible = true; click();
    h.layer.filter = { enabled: true, match: "all", rules: [{ field: "name", operator: "eq", value: "no match" }] };
    h.annotations.refreshInspection();
    assert.equal(h.controls.hit, null);
    h.layer.filter = structuredClone(EMPTY_VECTOR_FILTER); click(); h.annotations.shared.get(h.layer.id).polygons = []; h.annotations.refreshInspection();
    assert.equal(h.controls.hit, null);
    click(); h.layer.polygons = []; h.annotations.refreshInspection();
    assert.equal(h.controls.hit, null);
    h.layer.polygons = [h.own]; h.annotations.model.beginPolygon(h.layer.id);
    assert.equal(click(), false);
    h.annotations.model.cancelPolygon(); h.layer.opacity = 0;
    assert.equal(click(), false);
});

test("layer order decides overlapping hits and background updates do not reopen or focus the panel", () => {
    const h = inspectionController();
    const upper = h.annotations.model.createLayer("Upper layer");
    upper.name = "Upper layer";
    upper.position = 0; h.layer.position = 1;
    h.annotations.layers.set(upper.id, { polygonsAt: () => [h.peer] });
    assert.deepEqual(h.annotations.polygonsAt({ lat: 0.5, lng: 1 }).map(hit => hit.layerName), ["Upper layer", "Habitats", "Habitats"]);
    h.annotations.layers.delete(upper.id);
    h.annotations.inspectAt({ lat: 0.5, lng: 1 }); h.controls.select(1);
    h.annotations.panel.open = false;
    h.own.note = "Updated note"; h.annotations.refreshInspection();
    assert.equal(h.controls.hit.polygon.note, "Updated note");
    assert.equal(h.annotations.panel.open, false);
});

test("replacing a peer contribution clears its selection instead of selecting a reused positional ID", () => {
    const h = inspectionController();
    h.annotations.inspectAt({ lat: 0.5, lng: 1 });
    const collection = exportAnnotationGeoJSON(h.layer);
    collection.features[0].id = h.peer.id;
    collection.features[0].properties.contributor = "Maria";
    h.annotations.updateSharedLayer(h.layer.id, { contributors: [], collections: [collection], canContribute: true });
    assert.equal(h.controls.hit, null);
    assert.equal(h.rendering.highlight, null);
});

test("new geometry and text remain private until one Save; repeat drawing starts an empty draft", async () => {
    const { annotations, layer } = drawingController();
    let writes = 0, shares = 0;
    annotations.storage.save = async () => { writes++; };
    annotations.onCommittedChange = () => { shares++; };
    annotations.beginPolygon(layer.id);
    annotations.model.updateDraftText("River corridor", "Connect habitats");
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.model.closePolygonOutline();
    assert.equal(layer.polygons.length, 0, "closing the outline must not commit geometry or text");
    assert.equal(writes, 0); assert.equal(shares, 0);
    assert.equal(annotations.hasUnsavedChanges(), true);
    annotations.finishPolygon(true);
    await annotations.savePromise;
    assert.equal(writes, 1); assert.equal(shares, 1);
    assert.equal(annotations.sharableLayers()[0].collection.features[0].properties.name, "River corridor");
    assert.equal(layer.polygons[0].note, "Connect habitats");
    assert.equal(annotations.model.draft.isNew, true);
    assert.equal(annotations.model.draft.layerId, layer.id);
    assert.equal(annotations.model.draft.polygon.note, "");
    assert.deepEqual(annotations.model.draft.polygon.vertices, []);
});

test("Cancel discards new geometry and text, and restores existing geometry and text together", async () => {
    const { annotations, layer } = drawingController();
    annotations.beginPolygon(layer.id);
    annotations.model.updateDraftText("Unsaved", "Private note");
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.model.cancelPolygon(); annotations.updateEditor();
    assert.equal(layer.polygons.length, 0);
    annotations.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.finishPolygon(); await annotations.savePromise;
    const before = annotations.model.document();
    let writes = 0; annotations.storage.save = async () => { writes++; };
    annotations.beginPolygon(layer.id, layer.polygons[0].id, "note");
    annotations.model.updateDraftText("Changed", "New note");
    annotations.model.draft.polygon.vertices[0] = [-1, 0];
    await annotations.save(); // Unrelated appearance saves cannot publish draft data.
    assert.deepEqual(annotations.model.document(), before);
    assert.equal(annotations.sharableLayers()[0].collection.features[0].properties.note, "");
    annotations.model.cancelPolygon(); annotations.updateEditor();
    assert.deepEqual(annotations.model.document(), before);
    assert.equal(writes, 1, "Cancel must not save");
    assert.equal(annotations.hasUnsavedChanges(), false);
});

test("editing an existing polygon saves geometry and text once with no second phase", async () => {
    const { annotations, layer, calls } = drawingController();
    annotations.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.finishPolygon(); await annotations.savePromise;
    const polygon = layer.polygons[0];
    annotations.beginPolygon(layer.id, polygon.id, "note");
    assert.ok(calls.some(call => call[0] === "focus" && call[1] === "note"));
    annotations.model.updateDraftText("Wetland", "Complete note");
    annotations.model.draft.polygon.vertices[0] = [-1, 0];
    let writes = 0, shares = 0;
    annotations.storage.save = async () => { writes++; };
    annotations.onCommittedChange = () => { shares++; };
    annotations.finishPolygon(); await annotations.savePromise;
    assert.equal(annotations.model.draft, null);
    assert.equal(writes, 1); assert.equal(shares, 1);
    assert.equal(polygon.name, "Wetland"); assert.equal(polygon.note, "Complete note");
    assert.deepEqual(polygon.vertices[0], [-1, 0]);
    assert.deepEqual(calls.filter(call => call[0] === "editing").at(-1), ["editing", false]);
});

test("switching polygons preserves the open draft; returning to it only focuses the requested field", () => {
    const { annotations, layer, calls } = drawingController();
    annotations.beginPolygon(layer.id);
    annotations.model.updateDraftText("Private name", "Private note");
    const draft = annotations.model.draft;
    annotations.beginPolygon(layer.id, "another");
    assert.equal(annotations.model.draft, draft);
    assert.match(calls.filter(call => call[0] === "render").at(-1)[3], /Save or cancel/);
    annotations.beginPolygon(layer.id, draft.polygon.id, "note");
    assert.equal(annotations.model.draft, draft);
    assert.deepEqual(calls.at(-1), ["focus", "note"]);
});

test("invalid geometry and lost edit permission preserve the entire draft for correction or cancel", () => {
    const { annotations, layer } = drawingController();
    annotations.beginPolygon(layer.id);
    annotations.model.updateDraftText("Keep this name", "Keep this note");
    annotations.model.addVertex([0, 0]);
    assert.throws(() => annotations.model.closePolygonOutline(), /at least 3 vertices/);
    assert.throws(() => annotations.finishPolygon(), /at least 3 vertices/);
    assert.equal(annotations.model.draft.polygon.name, "Keep this name");
    assert.equal(layer.polygons.length, 0);
    annotations.shared.set(layer.id, { canContribute: false });
    assert.throws(() => annotations.finishPolygon(), /Join this layer/);
    assert.ok(annotations.model.draft);
});

test("a failed persistence attempt retains the whole committed polygon for the existing Retry action", async () => {
    const { annotations, layer } = drawingController();
    annotations.storage.save = async () => { throw new Error("Storage full"); };
    annotations.beginPolygon(layer.id);
    annotations.model.updateDraftText("Keep this", "Unsaved notes");
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.finishPolygon(); await annotations.savePromise;
    assert.equal(annotations.dirty, true);
    assert.match(annotations.status.textContent, /Storage full/);
    assert.equal(layer.polygons[0].note, "Unsaved notes");
    assert.equal(layer.polygons[0].vertices.length, 3);
    annotations.storage.save = async () => {};
    await annotations.save();
    assert.equal(annotations.dirty, false);
    annotations.deletePolygon(layer.id, layer.polygons[0].id);
    assert.equal(layer.polygons.length, 0);
});

test("contributor colors update rendering and legends without changing summary geometry or edit ownership", () => {
    const annotations = controller(); const layer = annotations.model.createLayer();
    annotations.model.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point)); annotations.model.savePolygon();
    const peer = exportAnnotationGeoJSON(layer); peer.features[0].id = "peer";
    peer.features[0].properties.contributorId = "other"; peer.features[0].properties.contributor = "Maria";
    annotations.shared = new Map(); annotations.controls = new Map([[layer.id, { setCollaboration() {} }]]);
    let redraws = 0; annotations.layers = new Map([[layer.id, { refresh() { redraws++; } }]]); annotations.mapLayers = { render() {} };
    const data = { collections: [peer], contributors: [{ id: "me", name: "Rich", own: true, color: "#FFBE0B" }, { id: "other", name: "Maria", color: "#FB5607" }] };
    annotations.updateSharedLayer(layer.id, structuredClone(data));
    data.contributors[1].color = "#FF006E";
    assert.equal(annotations.updateSharedLayer(layer.id, data), false, "color changes must not rerun summary calculations");
    assert.equal(redraws, 2);
    assert.deepEqual(annotations.displayLayer(layer).polygons.map(p => p.contributorColor), ["#FFBE0B", "#FF006E"]);
    assert.deepEqual(annotations.layerLegend(layer).entries.map(e => [e.label, e.symbol.fill]), [["Rich (you)", "#FFBE0B"], ["Maria", "#FF006E"]]);
    assert.equal(layer.polygons.length, 1); assert.throws(() => annotations.model.beginPolygon(layer.id, "peer"));
});

test("saved-map legacy label switches restore as one local preference", async () => {
    const annotations = controller();
    const layer = annotations.model.createLayer();
    const changes = [];
    annotations.mapLayers = { setVisible: (...args) => changes.push(args), setOpacity: (...args) => changes.push(args) };
    annotations.refreshLayer = () => {};
    const appearance = { outline: "#202020", weight: 1, fillOpacity: 0.25, labels: false, notes: true };
    annotations.restoreMapAppearance(layer.id, { visible: true, opacity: 0.5, appearance });
    await annotations.savePromise;
    assert.equal(layer.style.labels, true);
    assert.equal("notes" in layer.style, false);
    assert.equal(appearance.labels, false, "the published map is not modified");
    annotations.restoreMapAppearance(layer.id, { visible: true, opacity: 0.5, appearance: { ...appearance, notes: false } });
    await annotations.savePromise;
    assert.equal(layer.style.labels, false);
    assert.equal(changes.length, 4);
});

test("draft rendering receives current contributor names without writing them into the draft", () => {
    const annotations = controller();
    const layer = annotations.model.createLayer();
    annotations.model.beginPolygon(layer.id);
    const before = structuredClone(annotations.model.draft);
    const calls = [];
    annotations.editor = { render: (...args) => calls.push(args) };
    annotations.shared.set(layer.id, { contributors: [{ own: true, name: "Rich" }] });
    annotations.renderEditor();
    assert.equal(calls.at(-1)[4], "Rich");
    annotations.shared.get(layer.id).contributors[0].name = "Richard";
    annotations.renderEditor();
    assert.equal(calls.at(-1)[4], "Richard");
    annotations.shared.clear();
    annotations.renderEditor();
    assert.equal(calls.at(-1)[4], null, "an imported draft must not inherit the previous shared contributor");
    assert.deepEqual(annotations.model.draft, before);
});

test("combined shared polygons are filterable summary inputs but never become editable or uploaded as mine", async () => {
    const annotations = controller();
    const layer = annotations.model.createLayer();
    annotations.model.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.model.savePolygon();
    const peer = exportAnnotationGeoJSON(layer);
    peer.features[0].id = "peer-polygon";
    peer.features[0].properties = { name: "Maria's polygon", note: "River", contributor: "Maria" };
    let rendered = 0;
    annotations.shared = new Map();
    annotations.controls = new Map([[layer.id, { setCollaboration() {} }]]);
    annotations.layers = new Map([[layer.id, { refresh() { rendered++; } }]]);
    annotations.mapLayers = { render() {} };
    const data = { collections: [peer], contributors: [], status: "Saved" };
    assert.equal(annotations.updateSharedLayer(layer.id, data), true);
    assert.equal(annotations.updateSharedLayer(layer.id, data), false);
    assert.equal(rendered, 1, "status polling does not rebuild unchanged polygons");
    assert.equal(annotations.summaryTargets()[0].polygons.length, 2);
    assert.match(annotations.filterTarget(`local:annotation:${layer.id}`).status, /2 of 2/);
    assert.equal(layer.polygons.length, 1);
    assert.throws(() => annotations.model.beginPolygon(layer.id, "peer-polygon"));
    await annotations.save();
    assert.equal(annotations.sharableLayers()[0].collection.features.length, 1);
    layer.filter = { enabled: true, match: "all", rules: [{ field: "name", operator: "contains", value: "Maria" }] };
    assert.match(annotations.filterTarget(`local:annotation:${layer.id}`).status, /1 of 2/);
});

test("rejoining restores own polygons with safe local identities without retaining supplied IDs", async () => {
    const annotations = controller();
    annotations.attachLayer = () => {};
    const source = { type: "FeatureCollection", name: "Shared", features: [{ type: "Feature", id: 'untrusted"id',
        properties: { name: "Mine", note: "Keep this" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [1, 2], [0, 0]]] } }] };
    const id = await annotations.restoreSharedContribution("Shared", source);
    const restored = annotations.model.layer(id);
    assert.equal(restored.polygons[0].note, "Keep this");
    assert.notEqual(restored.polygons[0].id, source.features[0].id);
    assert.equal(annotations.sharableLayers()[0].collection.features.length, 1);
});

test("storage failure reveals Retry saving without discarding unsaved annotation data", async () => {
    const annotations = controller();
    annotations.model.createLayer();
    const before = annotations.model.document();
    annotations.storage.save = async () => { throw new Error("Device storage is full"); };
    await annotations.save();
    assert.equal(annotations.panel.open, true);
    assert.equal(annotations.retryButton.hidden, false);
    assert.equal(annotations.dirty, true);
    assert.match(annotations.status.textContent, /Not saved: Device storage is full/);
    assert.deepEqual(annotations.model.document(), before);
    annotations.panel.open = false;
    annotations.storage.save = async () => {};
    await annotations.save();
    assert.equal(annotations.panel.open, false, "successful autosave does not force tools open");
    assert.equal(annotations.dirty, false);
    assert.equal(annotations.retryButton.hidden, true);
});

test("startup retains storage failure in the closed editor and clears it after a successful load", async () => {
    const annotations = controller();
    annotations.loaded = false;
    annotations.storage.load = async () => { throw new Error("Cannot open database"); };
    await annotations.load();
    assert.equal(annotations.panel.open, false);
    assert.equal(annotations.loaded, false);
    assert.equal(annotations.importButton.disabled, true);
    assert.equal(annotations.drawButton.disabled, true);
    assert.equal(annotations.status.textContent, "Cannot open saved polygons: Cannot open database");
    await assert.rejects(annotations.saveForSharing(), /Cannot open database/);
    annotations.storage.load = async () => [];
    await annotations.load();
    assert.equal(annotations.panel.open, false);
    assert.equal(annotations.status.textContent, "");
    assert.equal(annotations.loaded, true);
    assert.equal(annotations.importButton.disabled, false);
    assert.equal(annotations.drawButton.disabled, false);
});

test("empty polygon storage keeps the editor closed in every startup mode", async () => {
    for (const attachSavedLayers of [true, false]) {
        const annotations = controller();
        annotations.loaded = false;
        await annotations.load({ attachSavedLayers });
        assert.equal(annotations.loaded, true);
        assert.equal(annotations.panel.open, false);
        assert.equal(annotations.status.textContent, "");
    }
});

test("invalid saved drawings stay in the closed editor without overwriting stored layers in every startup mode", async () => {
    const model = new AnnotationModel();
    model.createLayer();
    const saved = model.document();
    saved.layers[0].polygons.push({ id: "invalid-polygon", name: "Preserve this drawing", note: "", vertices: [[0, 0], [1, 1]] });
    const original = structuredClone(saved);
    for (const attachSavedLayers of [true, false]) {
        const annotations = controller();
        annotations.loaded = false;
        annotations.storage.load = async () => readAnnotationLayers(saved);
        let writes = 0;
        annotations.storage.save = async () => { writes++; };
        await annotations.load({ attachSavedLayers });
        assert.equal(annotations.panel.open, false);
        assert.equal(annotations.loaded, false);
        assert.equal(annotations.importButton.disabled, true);
        assert.match(annotations.status.textContent, /invalid polygon/);
        await assert.rejects(annotations.restoreSharedContribution("Shared layer", { type: "FeatureCollection", features: [] }),
            /Cannot open saved polygons: Saved polygons contain an invalid polygon/);
        await annotations.save();
        assert.equal(writes, 0);
        assert.deepEqual(saved, original);
    }
});

test("recovered filter notices belong to their layers and clear when a filter is applied", async () => {
    const model = new AnnotationModel();
    const affected = model.createLayer(), unchanged = model.createLayer();
    affected.filter = "";
    const saved = model.document();
    for (const attachSavedLayers of [true, false]) {
        const annotations = controller();
        annotations.loaded = false;
        annotations.storage.load = async onFilterCleared => readAnnotationLayers(saved, onFilterCleared);
        annotations.attachLayer = layer => annotations.layers.set(layer.id, {});
        annotations.refreshLayer = () => {};
        await annotations.load({ attachSavedLayers });
        assert.equal(annotations.loaded, true);
        assert.equal(annotations.panel.open, false);
        assert.equal(annotations.importButton.disabled, false);
        assert.equal(annotations.status.textContent, "");
        assert.deepEqual([...annotations.clearedFilterLayerIds], [affected.id]);
        assert.deepEqual(annotations.model.layer(unchanged.id), unchanged);
        annotations.filterTarget(`local:annotation:${affected.id}`).apply(EMPTY_VECTOR_FILTER);
        assert.equal(annotations.clearedFilterLayerIds.size, 0);
        await annotations.savePromise;
    }
});

test("action and export errors open the panel while draft errors stay in the map editor", () => {
    const annotations = controller();
    annotations.perform(() => { throw new Error("Layer limit reached"); });
    assert.equal(annotations.panel.open, true);
    assert.equal(annotations.status.textContent, "Layer limit reached");
    annotations.panel.open = false;
    annotations.exportGeoJSONFile("missing-layer");
    assert.equal(annotations.panel.open, true);
    assert.match(annotations.fileStatus.textContent, /Cannot export GeoJSON/);
    annotations.panel.open = false;
    const layer = annotations.model.createLayer();
    annotations.model.beginPolygon(layer.id);
    let editorMessage;
    annotations.renderEditor = message => { editorMessage = message; };
    annotations.perform(() => annotations.model.savePolygon());
    assert.match(editorMessage, /at least 3 vertices/);
    assert.equal(annotations.panel.open, false);
    assert.ok(annotations.model.draft);
});

test("polygon deletion opens the panel so its existing Undo action remains discoverable", () => {
    const annotations = controller();
    const layer = annotations.model.createLayer();
    annotations.model.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    const polygon = annotations.model.savePolygon();
    annotations.updateEditor = () => {};
    annotations.refreshLayer = () => {};
    annotations.save = async () => {};
    annotations.deletePolygon(layer.id, polygon.id);
    assert.equal(annotations.panel.open, true);
    assert.equal(annotations.model.deleted.polygon.id, polygon.id);
});

test("callers awaiting a coalesced save wait for the final document, including the restored layer", async () => {
    const annotations = controller();
    let release;
    const documents = [];
    annotations.storage.save = async document => {
        documents.push(document);
        if (documents.length === 1) await new Promise(resolve => { release = resolve; });
    };
    const first = annotations.save();
    const layer = annotations.model.createLayer();
    let finished = false;
    const second = annotations.save().then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    release();
    await Promise.all([first, second]);
    assert.equal(documents.length, 2);
    assert.equal(documents[1].layers[0].id, layer.id);
    assert.equal(annotations.dirty, false);
});

test("sharing waits for storage loading and existing saves without writing clean layers", async () => {
    const annotations = controller();
    annotations.loaded = false;
    annotations.status.textContent = "Opening local polygons…";
    let finishLoading;
    annotations.storage.load = () => new Promise(resolve => { finishLoading = resolve; });
    const loading = annotations.load();
    await assert.rejects(annotations.saveForSharing(), /Opening local polygons/);
    finishLoading([]);
    await loading;
    let writes = 0, finishSaving;
    annotations.storage.save = () => { writes++; return new Promise(resolve => { finishSaving = resolve; }); };
    await annotations.saveForSharing();
    assert.equal(writes, 0);
    const saving = annotations.save();
    let ready = false;
    const sharing = annotations.saveForSharing().then(() => { ready = true; });
    await Promise.resolve();
    assert.equal(ready, false);
    finishSaving();
    await Promise.all([saving, sharing]);
    assert.equal(writes, 1);
    annotations.storage.save = async () => { throw new Error("Storage full"); };
    await annotations.save();
    await assert.rejects(annotations.saveForSharing(), /Storage full/);
    annotations.storage.save = async () => {};
    await annotations.saveForSharing();
    assert.equal(annotations.dirty, false);
});

test("failed Undo persistence can retry without overwriting the restored annotation's edits", async () => {
    const annotations = controller();
    annotations.restoredLayers = new WeakMap();
    annotations.layers = new Map(); annotations.controls = new Map();
    annotations.attachLayer = () => {};
    annotations.mapLayers = { reorder() {}, snapshots: () => annotations.model.layers };
    const layer = annotations.model.createLayer();
    const snapshot = { local: structuredClone(layer), key: `local:annotation:${layer.id}`, index: 0 };
    annotations.model.layers = [];
    annotations.storage.save = async () => { throw new Error("Device storage is full"); };
    await assert.rejects(annotations.restoreRemovedLayer(snapshot, () => true), /Device storage is full/);
    const restored = annotations.model.layer(layer.id);
    restored.name = "Edited after restoring";
    annotations.storage.save = async () => {};
    await annotations.restoreRemovedLayer(snapshot, () => true);
    assert.equal(annotations.model.layer(layer.id), restored);
    assert.equal(restored.name, "Edited after restoring");
    annotations.model.layers = [structuredClone(restored)];
    await assert.rejects(annotations.restoreRemovedLayer(snapshot, () => true), /already on the map/);
    await assert.rejects(annotations.restoreRemovedLayer(snapshot, () => false), /superseded/);
});

test("sharing reads the last device-saved polygons while a new save is pending or fails", async () => {
    const annotations = controller();
    const layer = annotations.model.createLayer();
    await annotations.save();
    const saved = annotations.sharableLayers();
    let release;
    annotations.storage.save = () => new Promise(resolve => { release = resolve; });
    layer.name = "Changed layer";
    const saving = annotations.save();
    assert.deepEqual(annotations.sharableLayers(), saved);
    release(); await saving;
    assert.equal(annotations.sharableLayers()[0].collection.name, "Changed layer");
    annotations.storage.save = async () => { throw new Error("Storage full"); };
    layer.name = "Unsaved layer";
    await annotations.save();
    assert.equal(annotations.sharableLayers()[0].collection.name, "Changed layer");
});

test("restoring a shared contribution exposes it only after successful device saving", async () => {
    const annotations = controller();
    annotations.savedSharingLayers = [];
    annotations.attachLayer = () => {};
    const events = []; let release;
    annotations.onCommittedChange = () => events.push(["saved", annotations.sharableLayers().map(layer => layer.id)]);
    annotations.storage.save = () => new Promise(resolve => { release = resolve; });
    const collection = { type: "FeatureCollection", features: [] };
    const restoring = annotations.restoreSharedContribution("Shared", collection);
    assert.deepEqual(events, []);
    assert.deepEqual(annotations.sharableLayers(), []);
    release(); const id = await restoring;
    assert.deepEqual(events, [["saved", [id]]]);
    annotations.storage.save = async () => { throw new Error("Storage full"); };
    await assert.rejects(annotations.restoreSharedContribution("Unsaved", collection), /Storage full/);
    assert.deepEqual(annotations.sharableLayers().map(layer => layer.id), [id]);
});


test("successful local saves clear the transient status instead of retaining a success paragraph", async () => {
    const annotations = controller();
    let finish;
    annotations.storage.save = () => new Promise(resolve => { finish = resolve; });
    const saving = annotations.save();
    assert.match(annotations.status.textContent, /Saving/);
    finish(); await saving;
    assert.equal(annotations.status.textContent, "");
    assert.equal(annotations.panel.open, false);
});
