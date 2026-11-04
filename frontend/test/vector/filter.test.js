import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVectorFilter, vectorFilterStatus, vectorFilterSummary } from "../../src/vector/filter.js";
import { VectorFilterControls } from "../../src/vector/filter-controls.js";
import { createVectorMapLayerAdapter } from "../../src/vector/map-layer-adapter.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

const fields = [{ name: "year", type: "int" }, { name: "name", type: "str" }];
const filter = (value = 2020, enabled = true) => ({ enabled, match: "all", rules: [{ field: "year", operator: "gt", value }] });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("rule validation keeps numeric and text types explicit and excludes expressions", () => {
    assert.deepEqual(normalizeVectorFilter(filter(), fields), filter());
    for (const value of ["2020", true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => normalizeVectorFilter(filter(value), fields));
    }
    assert.throws(() => normalizeVectorFilter({ ...filter(), expression: "year > 2020" }, fields));
    assert.throws(() => normalizeVectorFilter({ ...filter(), rules: [{ field: "absent", operator: "eq", value: 0 }] }, fields));
    assert.match(vectorFilterSummary(filter(2020, false)), /^Disabled:/);
    assert.equal(vectorFilterStatus({ filter: filter(), filterCounting: true }), "Filter active · Counting…");
    assert.equal(vectorFilterStatus({ filter: filter(), filterCount: { matched: 0, total: 100, complete: true } }), "0 of 100 features match");
    assert.equal(vectorFilterStatus({ filter: filter(), filterCounting: false }), "Filter active · Count unavailable");
});

test("filter editor debounces valid drafts and leaves applied rules visible during invalid edits", async () => {
    const doc = new FakeRasterControlDocument();
    let current = filter(), pending = null;
    const applied = [], canceled = [];
    const controls = new VectorFilterControls({ documentContext: doc,
        getTarget: () => ({ fields, filter: current, label: "Earthquakes", status: "5 of 100 features match",
            cancelPending: () => canceled.push(true),
            apply: async (candidate) => { applied.push(candidate); current = candidate; return candidate; } }),
        inspection: { showFilter() {}, hideFilter() {}, updateLayerEditorName() {} },
        setTimer: (handler, delay) => { assert.equal(delay, 450); pending = handler; return 1; },
        clearTimer: () => { pending = null; },
    });
    controls.open("quakes");
    const input = controls.rules.children[0].children[2];
    input.value = "2021"; input.dispatchEvent(new Event("input"));
    input.value = "2022"; input.dispatchEvent(new Event("input"));
    assert.equal(applied.length, 0);
    const run = pending; pending = null; run(); await flush();
    assert.deepEqual(applied, [filter(2022)]);
    input.value = ""; input.dispatchEvent(new Event("input"));
    assert.equal(pending, null);
    assert.match(controls.status.textContent, /previous applied filter remains/);
    assert.match(controls.applied.textContent, /2022/);
    controls.clear.dispatchEvent(new Event("click")); await flush();
    assert.equal(current.rules.length, 0);
    assert.ok(canceled.length >= 3);
    controls.destroy();
});

test("renaming an open filter keeps its draft and updates its panel and tab names", () => {
    const doc = new FakeRasterControlDocument();
    const target = { fields, filter: filter(), label: "Earthquakes", status: "" };
    const names = [];
    let opened = 0;
    const controls = new VectorFilterControls({ documentContext: doc,
        getTarget: () => target,
        inspection: { showFilter() { opened++; }, hideFilter() {},
            updateLayerEditorName(editor, name) { names.push([editor, name]); } },
    });
    controls.open("quakes");
    const rule = controls.rules.children[0];
    target.label = "Recent earthquakes";
    controls.refresh();
    assert.equal(controls.title.textContent, target.label);
    assert.deepEqual(names.at(-1), ["filter", target.label]);
    assert.equal(controls.rules.children[0], rule);
    assert.equal(opened, 1);
    controls.destroy();
});

test("reopening a filter uses changes accepted elsewhere instead of closed-editor drafts", () => {
    const doc = new FakeRasterControlDocument();
    const target = { fields, filter: filter(), label: "Earthquakes", status: "", cancelPending() {} };
    const controls = new VectorFilterControls({ documentContext: doc,
        getTarget: () => target,
        inspection: { showFilter() {}, hideFilter() {}, updateLayerEditorName() {} },
    });
    controls.open("quakes");
    const input = controls.rules.children[0].children[2];
    input.value = ""; input.dispatchEvent(new Event("input"));
    controls.close();
    target.filter = filter(2024);
    controls.open("quakes");
    assert.equal(String(controls.rules.children[0].children[2].value), "2024");
    assert.match(controls.applied.textContent, /2024/);
    assert.equal(controls.applyButton.disabled, false);
    controls.destroy();
});

test("filter enable toggle preserves rules and closing applies pending valid edits", async () => {
    const doc = new FakeRasterControlDocument();
    let current = filter();
    const controls = new VectorFilterControls({ documentContext: doc,
        getTarget: () => ({ fields, filter: current, label: "Earthquakes", status: "",
            cancelPending() {}, apply: async (candidate) => { current = candidate; return candidate; } }),
        inspection: { showFilter() {}, hideFilter() {}, updateLayerEditorName() {} },
        setTimer: () => 1, clearTimer() {},
    });
    controls.open("quakes");
    controls.enabled.checked = false;
    controls.enabled.dispatchEvent(new Event("change"));
    controls.close(); await flush();
    assert.deepEqual(current, filter(2020, false));
    controls.open("quakes");
    assert.equal(controls.enabled.checked, false);
    assert.equal(controls.rules.children.length, 1);
    controls.destroy();
});

test("default debounce timers retain the browser global receiver", () => {
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
    let scheduled = 0, cleared = 0;
    globalThis.setTimeout = function () { assert.equal(this, globalThis); scheduled++; return 123; };
    globalThis.clearTimeout = function () { assert.equal(this, globalThis); cleared++; };
    try {
        const doc = new FakeRasterControlDocument();
        const controls = new VectorFilterControls({ documentContext: doc,
            getTarget: () => ({ fields, filter: filter(), label: "Earthquakes", status: "", cancelPending() {} }),
            inspection: { showFilter() {}, hideFilter() {}, updateLayerEditorName() {} },
        });
        controls.open("quakes");
        const input = controls.rules.children[0].children[2];
        input.value = "2024"; input.dispatchEvent(new Event("input"));
        controls.destroy();
        assert.equal(scheduled, 1); assert.equal(cleared, 1);
    } finally {
        globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
    }
});

test("adapter ignores out-of-order filter replies, preserves styles, and cancels removed-layer counts", async () => {
    const requests = [], counts = [], changes = [];
    const item = { collection: "vectors", id: "quakes", properties: { "table:columns": fields } };
    const publication = { layerName: "eolab:quakes", styleName: "vector-point", style: {
        geometryKind: "point", fillColor: "#112233", fillOpacity: 1, strokeColor: "#000000",
        strokeOpacity: 1, strokeWidth: 1, pointSize: 9, categorical: null, graduated: null, label: null,
    } };
    const adapter = createVectorMapLayerAdapter({ leaflet: {}, leafletMap: {}, wmsUrl: "/wms", onTileError() {},
        filter: (_item, candidate, signal) => new Promise((resolve) => requests.push({ candidate, signal, resolve })),
        countFilter: (_item, candidate, signal) => new Promise((resolve) => counts.push({ candidate, signal, resolve })),
        onFilterChange: () => changes.push(true),
    });
    const record = { publication, entry: { item }, state: adapter.createState({ item, publication }) };
    const beforeStyle = structuredClone(record.state.style);
    const a = adapter.applyFilterState(record, filter(2020));
    const b = adapter.applyFilterState(record, filter(2021));
    assert.ok(requests[0].signal.aborted);
    requests[1].resolve({ layerName: "eolab:filtered-b", filter: filter(2021) }); await b;
    requests[0].resolve({ layerName: "eolab:filtered-a", filter: filter(2020) });
    assert.equal(await a, null);
    assert.equal(record.publication.layerName, "eolab:filtered-b");
    assert.deepEqual(record.state.style, beforeStyle);
    assert.equal(Object.hasOwn(adapter.exportSavedState(record), "filter"), false);
    assert.deepEqual(adapter.exportFilterState(record), filter(2021));
    assert.equal(adapter.snapshot(record).filterActive, true);
    assert.equal(counts.length, 1);
    adapter.removed(record);
    assert.ok(counts[0].signal.aborted);
    counts[0].resolve({ matched: 5, total: 100, complete: true }); await flush();
    assert.equal(record.state.filterCount, null);
    assert.equal(changes.length, 1);
});

test("analysis filters submit only the explicitly applied complete draft and expose cancellation", async () => {
    const doc = new FakeRasterControlDocument(), applied = [], completed = [];
    let resolve, cancellations = 0;
    const controls = new VectorFilterControls({ documentContext: doc,
        getTarget: () => ({ fields, filter: filter(), label: "Countries", status: "",
            cancelPending() { throw Error("Analysis must not cancel rendering"); },
            apply() { throw Error("Analysis must not require rendering authorization"); } }),
        inspection: { showFilter() {}, hideFilter() {}, updateLayerEditorName() {} },
        setTimer() { throw Error("An analysis draft must not auto-apply"); }, clearTimer() {},
    });
    const action = { apply: candidate => { applied.push(candidate); return new Promise(done => { resolve = done; }); },
        complete: area => completed.push(area), cancel: () => { cancellations++; resolve(null); } };
    controls.open("countries", action);
    assert.equal(controls.applyButton.textContent, "Use filtered features & calculate");
    const input = controls.rules.children[0].children[2];
    input.value = "2024"; input.dispatchEvent(new Event("input"));
    assert.equal(applied.length, 0);
    controls.applyButton.dispatchEvent(new Event("click"));
    assert.deepEqual(applied, [filter(2024)]);
    assert.equal(controls.cancelButton.hidden, false);
    controls.cancelButton.dispatchEvent(new Event("click")); await flush();
    assert.equal(cancellations, 1); assert.equal(completed.length, 0);
    input.value = ""; input.dispatchEvent(new Event("input"));
    assert.equal(controls.applyButton.disabled, true);
    controls.close(); assert.equal(applied.length, 1);
    controls.open("countries", action);
    const next = controls.rules.children[0].children[2];
    next.value = "2025"; next.dispatchEvent(new Event("input"));
    controls.applyButton.dispatchEvent(new Event("click"));
    resolve({ id: "new-area" }); await flush();
    assert.deepEqual(completed, [{ id: "new-area" }]); assert.equal(controls.key, null);
    controls.open("countries"); assert.equal(controls.applyButton.textContent, "Apply filter");
    controls.open("countries", action);
    controls.applyButton.dispatchEvent(new Event("click"));
    controls.destroy();
    await flush();
    assert.equal(cancellations, 2); assert.equal(completed.length, 1);
});

test("queued count replies and errors cannot replace a newer filter; busy counts leave filtering applied", async () => {
    const counts = [];
    const item = { collection: "vectors", id: "quakes", properties: { "table:columns": fields } };
    const publication = { layerName: "eolab:quakes", styleName: "vector-point", style: {
        geometryKind: "point", fillColor: "#112233", fillOpacity: 1, strokeColor: "#000000",
        strokeOpacity: 1, strokeWidth: 1, pointSize: 9, categorical: null, graduated: null, label: null,
    } };
    const adapter = createVectorMapLayerAdapter({ leaflet: {}, leafletMap: {}, wmsUrl: "/wms", onTileError() {},
        filter: async (_item, candidate) => ({ layerName: `eolab:filtered-${candidate.rules[0].value}`, filter: candidate }),
        countFilter: (_item, candidate, signal) => new Promise((resolve, reject) => counts.push({ candidate, signal, resolve, reject })),
    });
    const record = { publication, entry: { item }, state: adapter.createState({ item, publication }) };
    await adapter.applyFilterState(record, filter(2020));
    assert.equal(vectorFilterStatus(record.state), "Filter active · Counting…");
    await adapter.applyFilterState(record, filter(2021));
    assert.ok(counts[0].signal.aborted);
    counts[0].resolve({ matched: 50, total: 100, complete: true }); await flush();
    assert.equal(record.state.filterCount, null);
    assert.equal(record.state.filterCounting, true);
    counts[1].reject(Object.assign(Error("Full"), { category: "filter_count_queue_full" })); await flush();
    assert.equal(record.publication.layerName, "eolab:filtered-2021");
    assert.deepEqual(record.state.filter, filter(2021));
    assert.equal(vectorFilterStatus(record.state), "Filter active · Count queue full; apply filter again to retry");

    await adapter.applyFilterState(record, filter(2022));
    await adapter.applyFilterState(record, filter(2023));
    counts[2].reject(Object.assign(Error("Late timeout"), { category: "filter_count_queue_timeout" })); await flush();
    assert.equal(record.state.filterCountError, null);
    assert.equal(record.state.filterCounting, true);
    counts[3].reject(Object.assign(Error("Timeout"), { category: "filter_count_queue_timeout" })); await flush();
    assert.equal(vectorFilterStatus(record.state), "Filter active · Count wait expired; apply filter again to retry");

    await adapter.applyFilterState(record, filter(2023));
    assert.equal(record.state.filterCountError, null);
    counts[4].resolve({ matched: 5, total: 100, complete: true }); await flush();
    assert.equal(vectorFilterStatus(record.state), "5 of 100 features match");
    await adapter.applyFilterState(record, filter(2024));
    adapter.removed(record);
    assert.ok(counts[5].signal.aborted);
    counts[5].reject(Object.assign(Error("Late full"), { category: "filter_count_queue_full" })); await flush();
    assert.equal(record.state.filterCountError, null);
});


test("map filter commit callbacks belong to one opening and only changed accepted rules", async () => {
    const doc = new FakeRasterControlDocument(), notifications = [], replies = [];
    let current = filter(), label = "Countries";
    const context = Symbol("caller intent");
    const controls = new VectorFilterControls({documentContext: doc,
        getTarget: () => ({fields, filter: current, label, cancelPending() {},
            apply: (candidate, applyContext) => new Promise((resolve, reject) => replies.push({candidate, applyContext, resolve, reject}))}),
        inspection: {showFilter() {}, hideFilter() {}, updateLayerEditorName() {}},
        setTimer: () => 1, clearTimer() {},
    });
    /** Open a new filter edit with its own intent callback. @return {void} */
    const opening = () => controls.open("countries", null, {applyContext: context, onApplied: () => notifications.push(current)});
    /** Send a complete draft to the controlled transport.
     * @param {number} value Year threshold. @return {Object} Controllable accepted-filter reply.
     */
    const apply = value => {
        const input = controls.rules.children[0].children[2];
        input.value = String(value); input.dispatchEvent(new Event("input"));
        controls.applyButton.dispatchEvent(new Event("click"));
        return replies.at(-1);
    };
    opening();
    controls.applyButton.dispatchEvent(new Event("click"));
    assert.equal(replies.at(-1).applyContext, context, "the generic editor forwards opaque caller context unchanged");
    replies.at(-1).resolve(current); await flush();
    label = "Renamed countries"; controls.refresh();
    assert.equal(notifications.length, 0, "unchanged rules and presentation refreshes are not calculation intents");

    const changed = apply(2024); current = changed.candidate; changed.resolve(current); await flush();
    assert.deepEqual(notifications, [filter(2024)]);
    controls.applyButton.dispatchEvent(new Event("click")); replies.at(-1).resolve(undefined); await flush();
    assert.equal(notifications.length, 1, "annotation-style void apply results still compare the authoritative accepted predicate");
    apply(2025).reject(Error("Filter failed")); await flush();
    assert.equal(notifications.length, 1);
    assert.match(controls.status.textContent, /previous applied filter remains/);
    apply(2026).resolve(null); await flush();
    assert.equal(notifications.length, 1, "superseded or cancelled map filters cannot commit an intent");

    const stale = apply(2027); controls.open("other-view");
    stale.resolve(stale.candidate); await flush();
    assert.equal(notifications.length, 1, "another opening owns its own commit callback");
    opening(); const closed = apply(2028); controls.close();
    current = closed.candidate; closed.resolve(current); await flush();
    assert.equal(notifications.length, 1, "a closed editor does not replace a later foreground choice");
    opening(); const destroyed = apply(2029); controls.destroy();
    destroyed.resolve(destroyed.candidate); await flush();
    assert.equal(notifications.length, 1);
});
