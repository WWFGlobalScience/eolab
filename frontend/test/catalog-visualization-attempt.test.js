import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  catalogItemsMatch, CatalogMapActionRegistry, CatalogVectorAssessmentCache,
} from "../src/catalog-map-actions.js";
import { getCatalogItemKey } from "../src/catalog-item-identity.js";
import { getCatalogItemMapBounds } from "../src/map.js";
import {
  formatCatalogVisualizationReason, getCatalogVisualization,
} from "../src/catalog.js";

const SOURCE = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const MARKUP = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/** Read exact production functions, injecting only their owned boundaries. */
function sourceBetween(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  const end = SOURCE.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Missing source range: ${startMarker}`);
  return SOURCE.slice(start, end);
}

const ACTION_SOURCE = [
  sourceBetween("function refreshCatalogMapAction()", "let rasterVisualization ="),
  sourceBetween("function updateCatalogMapAction(item)", "function clearCatalogSelection()"),
  sourceBetween("async function toggleCatalogLayer(", 'catalogLayerToggle.addEventListener('),
].join("\n");

function raster(id) {
  return {
    collection: "eolab-mounted-geotiffs", id,
    properties: { title: `Mounted/Model_outputs/${id}.tif` },
    assets: { data: { "eolab:source": {
      source_signature: [1, 2, 3, 4, 5],
    } } },
  };
}

function vector(id, eligible = true, reason = null) {
  return {
    collection: "eolab-mounted-vectors", id, assets: { data: {} },
    properties: {
      title: `${id}.gpkg`,
      "eolab:vector_rendering": {
        policy: "vector-v1", eligible, reason,
      },
    },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Execute real refresh, pending registry, feedback, and Add flow. */
function harness({ selectedItem = null, prepare = async (item) => item,
  show = async () => ({ layerName: "eolab:test" }), retained = [] } = {}) {
  const calls = [];
  const state = {
    selectedItem, pendingMapActions: new CatalogMapActionRegistry(),
    vectorAssessments: new CatalogVectorAssessmentCache(),
    collectionsDocument: { collections: [] },
    resultViews: new Map(), mapActionFeedback: new Map(),
  };
  const retainedItems = new Set(retained.map(getCatalogItemKey));
  const classes = new Set();
  const layerButton = { classList: {
    toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    contains(name) { return classes.has(name); },
  } };
  const onMap = {}, actionContainer = { setAttribute() {} }, styleButton = new EventTarget();
  const zoomButton = new EventTarget();
  const actionStatus = { textContent: "" }, status = { textContent: "" };
  const visualization = {
    describe: getCatalogVisualization,
    noun: (item) => getCatalogVisualization(item).kind === "raster" ? "raster" : "vector layer",
    contains: (item) => retainedItems.has(getCatalogItemKey(item)),
    remove(item) { calls.push(["remove", item.id]); retainedItems.delete(getCatalogItemKey(item)); },
    async prepare(item) { calls.push(["prepare", item.id]); return prepare(item); },
    async show(item) {
      calls.push(["show", item.id]);
      const publication = await show(item);
      if (publication !== null) retainedItems.add(getCatalogItemKey(item));
      return publication;
    },
  };
  const dependencies = {
    catalogState: state, catalogVisualization: visualization,
    rasterVisualization: {
      activateAnalysis: (item) => calls.push(["activate-analysis", item.id]),
    },
    getCatalogItemKey, catalogItemsMatch, getCatalogVisualization,
    formatCatalogVisualizationReason,
    renderCatalogItemInspector: (item) => calls.push(["render-inspector", item.id]),
    appGlobalConfiguration: { scanDisplayPathPrefix: "Mounted" },
    catalogLayerToggle: layerButton, catalogMapActionStatus: actionStatus,
    catalogLayerStyle: styleButton,
    catalogLayerZoom: zoomButton, getCatalogItemMapBounds,
    leafletMap: { fitBounds: (bounds, options) => calls.push(["zoom", bounds, options]) },
    layerStyleEditor: { open: (key) => calls.push(["style", key]) },
    catalogLayerStatus: status, catalogMapActionsElement: actionContainer, catalogOnMap: onMap,
    onRenderingWorkspaceRequested: () => calls.push(["open-rendering"]),
  };
  const actions = new Function(...Object.keys(dependencies), `${ACTION_SOURCE}
    return { run: toggleCatalogLayer, style: styleCatalogLayer, zoom: zoomCatalogLayer, refresh: refreshCatalogMapAction };`
  )(...Object.values(dependencies));
  const addRow = (item) => {
    const row = { item, update(value) { this.state = value; } };
    state.resultViews.set(getCatalogItemKey(item), row);
    actions.refresh();
    return row;
  };
  const row = selectedItem === null ? null : addRow(selectedItem);
  actions.refresh();
  return {
    run: (item = state.selectedItem) => actions.run(item),
    refresh: actions.refresh, style: actions.style, zoom: actions.zoom, addRow, row, state, calls, layerButton, styleButton, zoomButton,
    onMap, actionContainer, actionStatus, status,
    removeExternally(item) { visualization.remove(item); actions.refresh(); },
  };
}

test("catalog publication and map feedback retain live regions", () => {
  assert.match(MARKUP, /id="toggle-catalog-layer"[\s\S]*?>\s*Add to map\s*</);
  assert.match(MARKUP, /id="catalog-on-map" hidden[\s\S]*?On map/);
  assert.match(MARKUP, /id="catalog-map-action-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/);
  assert.match(MARKUP, /id="map-layer-rendering-announcement"[\s\S]*?role="status"/);
  assert.doesNotMatch(MARKUP + SOURCE, /Assess for visualization|Reassess visualization|Check for full visualization/);
  const tileFailure = sourceBetween("function reportMapTileError(", "function refreshCatalogMapAction()");
  assert.match(tileFailure, /catalogLayerStatus\.textContent = message;\s*mapLayerRenderingAnnouncement\.textContent = message;/);
});

test("row and details Style reuse the editor with composite identity and no map or selection changes", () => {
  const first = raster("same-id"), second = vector("same-id");
  const h = harness({ selectedItem: second, retained: [first, second] });
  assert.match(SOURCE, /onStyle: styleCatalogLayer/);
  assert.match(MARKUP, /id="style-catalog-layer"[\s\S]*?aria-controls="layer-style-editor"[\s\S]*?hidden[\s\S]*?>\s*Style\s*</);
  assert.equal(h.styleButton.hidden, false);
  assert.equal(h.styleButton.disabled, false);
  h.style(first);
  h.styleButton.dispatchEvent(new Event("click"));
  assert.deepEqual(h.calls, [["style", getCatalogItemKey(first)], ["style", getCatalogItemKey(second)]]);
  assert.equal(h.state.selectedItem, second);
  assert.equal(h.row.state.retained, true);
});

test("Zoom to targets the requested raster or vector bbox without selection or layer mutations", () => {
  const first = { ...raster("same-id"), bbox: [-123, 48, -122, 49] };
  const second = { ...vector("same-id"), bbox: [10, 20, 100, 11, 21, 200] };
  const h = harness({ selectedItem: second, retained: [first, second] });
  assert.match(SOURCE, /onZoom: zoomCatalogLayer/);
  assert.match(MARKUP, /id="toggle-catalog-layer"[\s\S]*?id="zoom-catalog-layer"[\s\S]*?aria-controls="map"[\s\S]*?>\s*Zoom to\s*<[\s\S]*?id="style-catalog-layer"/);
  assert.equal(h.zoomButton.hidden, false);
  assert.equal(h.zoomButton.disabled, false);
  assert.equal(h.row.state.canZoom, true);
  h.zoom(first);
  h.zoomButton.dispatchEvent(new Event("click"));
  assert.deepEqual(h.calls, [
    ["zoom", [[48, -123], [49, -122]], { padding: [24, 24], maxZoom: 9 }],
    ["zoom", [[20, 10], [21, 11]], { padding: [24, 24], maxZoom: 9 }],
  ]);
  assert.equal(h.state.selectedItem, second);
  assert.equal(h.row.state.retained, true);
});

test("Zoom to rejects missing bounds, pending actions, and removed or unretained Items", () => {
  const item = raster("zoom-lifecycle"), h = harness({ selectedItem: item, retained: [item] });
  assert.equal(h.zoomButton.disabled, true);
  assert.match(h.zoomButton.title, /no usable bounding box/);
  assert.equal(h.row.state.canZoom, false);
  h.zoom(item);
  h.zoom(null);
  item.bbox = [10, 20, 10, 20];
  h.refresh();
  assert.equal(h.zoomButton.disabled, false);
  const pending = h.state.pendingMapActions.begin(item, "Adding...", "Checking");
  h.refresh();
  assert.equal(h.zoomButton.disabled, true);
  h.zoom(item);
  h.zoom({ ...vector("not-retained"), bbox: item.bbox });
  assert.deepEqual(h.calls, []);
  h.state.pendingMapActions.finish(pending);
  h.removeExternally(item);
  assert.equal(h.zoomButton.hidden, true);
  h.calls.length = 0;
  h.zoom(item);
  assert.deepEqual(h.calls, []);
});

test("Style is absent before adding and after removal, and stale or busy requests do nothing", async () => {
  const item = raster("style-lifecycle"), completion = deferred();
  const h = harness({ selectedItem: item, prepare: () => completion.promise });
  assert.equal(h.styleButton.hidden, true);
  h.style(item);
  h.style(null);
  assert.deepEqual(h.calls, []);
  const attempt = h.run();
  assert.equal(h.styleButton.disabled, true);
  h.style(item);
  assert.deepEqual(h.calls, [["prepare", item.id]]);
  completion.resolve(item);
  await attempt;
  assert.equal(h.styleButton.hidden, false);
  assert.equal(h.styleButton.disabled, false);
  const pending = h.state.pendingMapActions.begin(item, "Adding...", "Checking");
  h.calls.length = 0;
  h.style(item);
  assert.deepEqual(h.calls, []);
  h.state.pendingMapActions.finish(pending);
  h.removeExternally(item);
  assert.equal(h.styleButton.hidden, true);
  h.calls.length = 0;
  h.style(item);
  assert.deepEqual(h.calls, []);
});

test("pending row Add needs no selection, disables only its Item, and prevents duplicates", async () => {
  const item = raster("pending"), completion = deferred();
  const h = harness({ prepare: () => completion.promise });
  const row = h.addRow(item), other = h.addRow(vector("other"));
  const attempt = h.run(item);
  await h.run(item);
  assert.equal(row.state.pendingAction.buttonText, "Adding to map...");
  assert.equal(other.state.pendingAction, null);
  assert.deepEqual(h.calls, [["prepare", "pending"]]);
  completion.resolve(item);
  await attempt;
  assert.equal(row.state.pendingAction, null);
  assert.equal(row.state.retained, true);
  assert.equal(h.state.selectedItem, null);
  assert.equal(h.actionContainer.hidden, true);
  assert.deepEqual(h.calls.filter(([call]) => call === "open-rendering"), [["open-rendering"]]);
  assert.equal(h.calls.some(([call]) => call === "render-inspector"), false);
});

test("selected Item mirrors pending and success states", async () => {
  const item = raster("eligible"), completion = deferred();
  const h = harness({ selectedItem: item, prepare: () => completion.promise });
  const attempt = h.run();
  assert.equal(h.layerButton.disabled, true);
  assert.equal(h.layerButton.textContent, "Adding to map...");
  assert.equal(h.actionStatus.textContent, "Publishing this prepared raster.");
  completion.resolve(item);
  await attempt;
  assert.ok(h.calls.findIndex(([call]) => call === "prepare") < h.calls.findIndex(([call]) => call === "show"));
  assert.equal(h.layerButton.textContent, "Remove from map");
  assert.equal(h.layerButton.classList.contains("catalog-add-action"), false);
  assert.equal(h.onMap.hidden, false);
  assert.equal(h.row.state.retained, true);
  assert.equal(h.actionStatus.textContent, "Raster added to the map.");
  assert.equal(h.status.textContent, "This raster is on the map.");
});

test("inspector and row Add use the same panel-opening path", async () => {
  const h = harness({ selectedItem: raster("inspector") });
  await h.run();
  assert.deepEqual(h.calls.filter(([call]) => call === "open-rendering"), [["open-rendering"]]);
  assert.match(SOURCE, /toggleCatalogLayer\(catalogState\.selectedItem\)/);
  assert.match(SOURCE, /onMapAction: \(requestedItem\) => toggleCatalogLayer\(requestedItem\)/);
});

test("row removal skips assessment and updates row and matching inspector", async () => {
  const item = raster("retained");
  const h = harness({ selectedItem: item, retained: [item] });
  await h.run();
  assert.equal(h.calls.some(([call]) => call === "prepare" || call === "show"), false);
  assert.equal(h.layerButton.textContent, "Add to map");
  assert.equal(h.layerButton.classList.contains("catalog-add-action"), true);
  assert.equal(h.onMap.hidden, true);
  assert.equal(h.row.state.retained, false);
  assert.equal(h.actionStatus.textContent, "Raster removed from the map.");
  assert.equal(h.calls.some(([call]) => call === "open-rendering"), false);
});

test("ineligible vector assessment keeps its contextual reason and never publishes", async () => {
  const reason = "Visualization unavailable: this vector cannot be opened.";
  const h = harness({
    selectedItem: vector("ineligible"),
    prepare: async () => vector("ineligible", false, reason),
  });
  await h.run();
  assert.equal(h.calls.some(([call]) => call === "show"), false);
  assert.equal(h.row.state.feedback.isError, true);
  assert.equal(
    h.row.state.feedback.message,
    "Visualization for ineligible.gpkg unavailable: this vector cannot be opened.",
  );
  assert.equal(h.actionStatus.textContent, h.row.state.feedback.message);
  assert.equal(h.layerButton.disabled, false);
  assert.equal(h.layerButton.textContent, "Add to map");
  assert.equal(h.row.state.pendingAction, null);
});

test("preparation and publication errors are local and retryable", async () => {
  for (const boundary of ["prepare", "show"]) {
    const h = harness({ [boundary]: async () => { throw new Error("Service unavailable"); } });
    const item = raster(boundary), row = h.addRow(item), other = h.addRow(vector("unrelated"));
    await h.run(item);
    assert.equal(row.state.feedback.message, "Service unavailable");
    assert.equal(row.state.feedback.isError, true);
    assert.equal(row.state.retained, false);
    assert.equal(row.state.pendingAction, null);
    assert.equal(other.state.feedback, null);
    assert.equal(h.actionStatus.textContent, "");
    assert.equal(h.calls.some(([call]) => call === "open-rendering"), false);
    await h.run(item);
    assert.equal(h.calls.filter(([call]) => call === boundary).length, 2);
  }
});

test("selection changes during preparation do not cancel Add or overwrite another inspector", async () => {
  const first = raster("first"), second = raster("second"), completion = deferred();
  const h = harness({ selectedItem: first, prepare: () => completion.promise });
  const attempt = h.run();
  h.state.selectedItem = second;
  h.refresh();
  completion.resolve(first);
  await attempt;
  assert.equal(h.row.state.retained, true);
  assert.equal(h.state.selectedItem, second);
  assert.equal(h.onMap.hidden, true);
  assert.equal(h.actionStatus.textContent, "");
  assert.equal(h.calls.some(([call]) => call === "render-inspector"), false);
});

test("concurrent raster and vector Adds use collection plus Item ID", async () => {
  const first = raster("same-id"), second = vector("same-id");
  const a = deferred(), b = deferred();
  const h = harness({ prepare: (item) => item.collection === first.collection ? a.promise : b.promise });
  const rowA = h.addRow(first), rowB = h.addRow(second);
  const addA = h.run(first), addB = h.run(second);
  b.resolve(second);
  await addB;
  assert.equal(rowB.state.retained, true);
  assert.notEqual(rowA.state.pendingAction, null);
  a.resolve(first);
  await addA;
  assert.equal(rowA.state.retained, true);
  assert.equal(rowB.state.pendingAction, null);
  assert.equal(rowB.state.feedback.message, "Vector layer added to the map.");
  assert.equal(h.calls.filter(([call]) => call === "open-rendering").length, 2);
});

test("a successful addition opens Map layers even after browsing to another item", async () => {
  const item = raster("first"), completion = deferred();
  const h = harness({ selectedItem: item, show: () => completion.promise });
  const attempt = h.run(item);
  await Promise.resolve();
  h.state.selectedItem = raster("second");
  completion.resolve({ layerName: "eolab:first" });
  await attempt;
  assert.equal(h.row.state.retained, true);
  assert.deepEqual(h.calls.filter(([call]) => call === "open-rendering"), [["open-rendering"]]);
});

test("replacement search rows inherit in-flight actions and completion by Item identity", async () => {
  const item = raster("refreshed"), completion = deferred();
  const h = harness({ prepare: () => completion.promise });
  h.addRow(item);
  const attempt = h.run(item);
  h.state.resultViews.clear();
  h.state.mapActionFeedback.clear();
  const replacement = h.addRow(raster("refreshed"));
  assert.notEqual(replacement.state.pendingAction, null);
  completion.resolve(item);
  await attempt;
  assert.equal(replacement.state.pendingAction, null);
  assert.equal(replacement.state.retained, true);
  assert.equal(replacement.state.feedback.message, "Raster added to the map.");
});

test("external removal clears stale success and membership from both presentations", async () => {
  const item = raster("removed");
  const h = harness({ selectedItem: item });
  await h.run();
  h.removeExternally(item);
  assert.equal(h.row.state.retained, false);
  assert.equal(h.row.state.feedback, null);
  assert.equal(h.onMap.hidden, true);
  assert.equal(h.layerButton.textContent, "Add to map");
  assert.equal(h.actionStatus.textContent, "");
});

test("unsupported Items and canceled publication never claim to be on map", async () => {
  const h = harness({ show: async () => null });
  const unsupported = { collection: "remote", id: "metadata", assets: {}, properties: {} };
  const row = h.addRow(unsupported);
  await h.run(unsupported);
  assert.equal(row.state.supported, false);
  assert.equal(h.calls.length, 0);
  const canceled = h.addRow(raster("canceled"));
  await h.run(canceled.item);
  assert.equal(canceled.state.retained, false);
  assert.equal(canceled.state.feedback, null);
  assert.equal(canceled.state.pendingAction, null);
  assert.equal(h.calls.some(([call]) => call === "open-rendering"), false);
});
