import assert from "node:assert/strict";
import test from "node:test";
import { HabitatAdminController } from "../../src/habitat-admin/controller.js";

const selection = { collectionId: "eolab-mounted-vectors", itemId: "areas", assetKey: "data", layerName: "polygons",
    filter: { enabled: true, match: "all", rules: [] } };
const source = { key: "areas", label: "Project areas", selection, fields: [{ name: "project", type: "int64" }] };
const options = { minimumYear: 2015, maximumYear: 2019, defaultYear: 2018 };

/** Supply a controlled external response without starting timers or native work.
 * @returns {{promise:Promise<unknown>,resolve:Function,reject:Function}} Response controls.
 */
function deferred() {
    let resolve, reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
}

/** Create an authoritative job snapshot for transport-boundary tests.
 * @param {Object} [changes={}] Server fields changed by the scenario.
 * @returns {Object} Administrator preparation job.
 */
function job(changes = {}) {
    return { jobId: "a".repeat(32), operation: "habitat.prepare-inputs.v1", status: "queued", createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z", expiresAt: "2030-01-01T00:00:00Z", metadataExpiresAt: null,
        inputs: { name: "North", selection: structuredClone(selection), year: 2018, configurationSha256: "b".repeat(64) },
        progress: {}, error: null, result: null, ...changes };
}

/** Compose the controller with observable browser, storage and transport boundaries.
 * @param {Object} [overrides={}] API methods replaced by the test.
 * @param {Map<string,string>} [values=new Map()] Persistent command storage shared across reloads.
 * @returns {Object} Controller, handlers and recorded boundary effects.
 */
function fixture(overrides = {}, values = new Map()) {
    const document = new EventTarget(), window = new EventTarget();
    document.hidden = false; document.visibilityState = "visible";
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    window.localStorage = storage;
    const timers = new Map(); let nextTimer = 0, nextId = 0;
    const clock = { setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; }, clearTimeout: id => timers.delete(id) };
    const submitted = [], retried = [], checked = [], listed = [], fetched = [], cancelled = [];
    const api = { getOptions: async () => structuredClone(options), searchAreas: async () => ({ sources: [structuredClone(source)], next: null }),
        coverage: async (value, year) => { checked.push({ value, year }); return { year, cachedTiles: 1, missingTiles: 1, requiredTiles: 2 }; },
        submit: async value => { submitted.push(structuredClone(value)); return job({ jobId: String(submitted.length).padStart(32, "0") }); },
        list: async request => { listed.push(request); return { jobs: [], nextCursor: null }; },
        get: async id => { fetched.push(id); return job({ jobId: id }); },
        cancel: async id => { cancelled.push(id); return job({ jobId: id, status: "cancelled", updatedAt: "2026-01-01T00:01:00Z" }); },
        retry: async (id, requestId) => { retried.push({ id, requestId }); return job({ jobId: "c".repeat(32) }); }, ...overrides };
    let handlers; const renders = [];
    const view = { bind: value => { handlers = value; }, render: state => renders.push(structuredClone(state)), destroy() {} };
    const controller = new HabitatAdminController({ api, view, documentContext: document, windowContext: window, clock,
        newId: () => (++nextId).toString(16).padStart(32, "0") });
    return { controller, api, document, window, storage, values, timers, submitted, retried, checked, listed, fetched, cancelled, renders, handlers };
}

/** Load metadata and capture the fixture Catalog area without checking it.
 * @param {Object} context Controller fixture.
 * @returns {Promise<void>} Resolves once an area and default year are available.
 */
async function chooseArea(context) {
    await context.controller.start(); await context.handlers.search("project");
    assert.equal(context.handlers.addArea("North", source.key, selection.filter), true);
}

/** Allow event-triggered promise continuations to finish.
 * @returns {Promise<void>} Resolves on the next Node event-loop turn.
 */
function flush() { return new Promise(resolve => setImmediate(resolve)); }

test("initial metadata/history reads do not check coverage or start preparations", async t => {
    const h = fixture(); t.after(() => h.controller.destroy());
    await h.controller.start();
    assert.deepEqual(h.controller.state.years, [2018]);
    assert.deepEqual(h.checked, []); assert.deepEqual(h.submitted, []);
    assert.equal(h.controller.state.sources.length, 0);
    assert.equal([...h.timers.values()][0].delay, 30000);
});

test("named Catalog filters are validated and frozen without preparing or checking", async t => {
    const h = fixture(); t.after(() => h.controller.destroy());
    await h.controller.start(); await h.handlers.search("areas");
    const filter = { enabled: true, match: "all", rules: [{ field: "project", operator: "eq", value: 1 }] };
    assert.equal(h.handlers.addArea("North", source.key, filter), true);
    filter.rules[0].value = 9;
    const captured = h.controller.state.areas[0];
    assert.equal(captured.selection.filter.rules[0].value, 1);
    assert.equal(Object.isFrozen(captured.selection.filter.rules[0]), true);
    assert.equal(h.handlers.addArea("Duplicate", source.key, { ...filter, rules: [{ field: "project", operator: "eq", value: 1 }] }), false);
    assert.equal(h.handlers.addArea("Invalid", source.key, { ...filter, rules: [{ field: "project", operator: "eq", value: "1" }] }), false);
    h.handlers.setYears([2019, 2018, 2019]);
    assert.deepEqual(h.controller.state.years, [2018, 2019]);
    assert.equal(h.controller.state.coverageRows.length, 2);
    assert.equal(h.controller.state.canPrepare, true);
    assert.deepEqual(h.checked, []); assert.deepEqual(h.submitted, []);
});

test("editing the area or years aborts an explicit coverage check and ignores its late reply", async t => {
    const pending = deferred(); let signal;
    const h = fixture({ coverage: async (value, year, requestSignal) => { signal = requestSignal; return pending.promise; } });
    t.after(() => h.controller.destroy()); await chooseArea(h);
    const checking = h.handlers.check();
    assert.equal(h.controller.state.checking, true);
    h.handlers.setYears([2019]);
    assert.equal(signal.aborted, true);
    pending.resolve({ cachedTiles: 99 }); await checking;
    assert.equal(h.controller.state.coverageRows[0].year, 2019);
    assert.equal(h.controller.state.coverageRows[0].coverage, null);
    assert.equal(h.controller.state.checking, false);
});

test("multiple years submit distinct commands once and continue definite row failures", async t => {
    const requests = [];
    const h = fixture({ submit: async request => { requests.push(structuredClone(request));
        if (request.year === 2018) throw Object.assign(new Error("This area is unavailable."), { status: 409, uncertain: false });
        return job({ jobId: "d".repeat(32), status: "ready" }); } });
    t.after(() => h.controller.destroy()); await chooseArea(h); h.handlers.setYears([2018, 2019]);
    await h.handlers.prepare();
    assert.equal(requests.length, 2); assert.notEqual(requests[0].requestId, requests[1].requestId);
    assert.deepEqual(h.controller.state.submissions.map(row => row.status), ["failed", "accepted"]);
    assert.equal(h.controller.state.requestedJobs, 1); assert.equal(h.controller.state.completedJobs, 1);
    assert.equal(h.renders.at(-1).completedJobs, 1);
    assert.equal(h.values.size, 0); assert.equal(h.controller.state.canPrepare, true);
    await h.handlers.prepare();
    assert.equal(requests.length, 3); assert.equal(requests.at(-1).year, 2018);
    assert.notEqual(requests.at(-1).requestId, requests[0].requestId);
});

test("double preparation clicks cannot duplicate accepted area/year commands", async t => {
    const pending = deferred(); let calls = 0;
    const h = fixture({ submit: async () => { calls++; return pending.promise; } });
    t.after(() => h.controller.destroy()); await chooseArea(h);
    const first = h.handlers.prepare(); await h.handlers.prepare();
    assert.equal(calls, 1); assert.equal(h.values.size, 1);
    pending.resolve(job()); await first; await h.handlers.prepare();
    assert.equal(calls, 1); assert.equal(h.controller.state.canPrepare, false);
});

test("unknown acceptance survives reload and recovers the exact original request explicitly", async t => {
    const values = new Map(), attempts = [];
    const first = fixture({ submit: async request => { attempts.push(structuredClone(request));
        throw Object.assign(new Error("Connection lost"), { status: null, uncertain: true }); } }, values);
    await chooseArea(first); await first.handlers.prepare();
    const key = first.controller.state.submissions[0].key;
    assert.equal(first.controller.state.submissions[0].status, "uncertain");
    first.controller.destroy();
    const second = fixture({ submit: async request => { attempts.push(structuredClone(request)); return job(); } }, values);
    t.after(() => second.controller.destroy()); await second.controller.start();
    assert.equal(attempts.length, 1); assert.equal(second.controller.state.submissions[0].status, "uncertain");
    await second.handlers.search("project"); second.handlers.addArea("Renamed draft", source.key, selection.filter);
    await second.handlers.prepare(); assert.equal(attempts.length, 1);
    await second.handlers.recover(key);
    assert.deepEqual(attempts[1], attempts[0]); assert.equal(values.size, 0);
    assert.equal(second.controller.state.requestedJobs, 1);
});

test("storage failure prevents POSTs whose request identity cannot be recovered", async t => {
    const h = fixture(); t.after(() => h.controller.destroy()); await chooseArea(h);
    h.storage.setItem = () => { throw new Error("Browser storage is full."); };
    await h.handlers.prepare();
    assert.equal(h.submitted.length, 0);
    assert.equal(h.controller.state.submissions[0].status, "failed");
    assert.match(h.controller.state.submissions[0].error, /storage is full/);
});

test("explicit retry keeps the original handle and command ID across an uncertain response", async t => {
    const attempts = []; let fail = true;
    const original = job({ status: "interrupted" });
    const h = fixture({ list: async () => ({ jobs: [original], nextCursor: null }), retry: async (id, requestId) => {
        attempts.push({ id, requestId }); if (fail) throw Object.assign(new Error("Server response lost"), { status: 503, uncertain: true });
        return job({ jobId: "e".repeat(32) }); } });
    t.after(() => h.controller.destroy()); await h.controller.start(); await h.handlers.retry(original.jobId);
    const row = h.controller.state.submissions[0]; assert.equal(row.kind, "retry"); assert.equal(row.status, "uncertain");
    fail = false; await h.handlers.recover(row.key);
    assert.deepEqual(attempts[1], attempts[0]); assert.equal(attempts[0].id, original.jobId);
    assert.equal(h.controller.state.jobs.find(value => value.jobId === original.jobId).status, "interrupted");
    assert.equal(h.controller.state.submissions[0].jobId, "e".repeat(32)); assert.equal(h.values.size, 0);
});

test("expired saved-input metadata cannot create a fresh retry from an old history snapshot", async t => {
    const original = job({ status: "failed", metadataExpiresAt: "2000-01-01T00:00:00Z" });
    const h = fixture({ list: async () => ({ jobs: [original], nextCursor: null }) });
    t.after(() => h.controller.destroy()); await h.controller.start(); await h.handlers.retry(original.jobId);
    assert.deepEqual(h.retried, []); assert.equal(h.controller.state.submissions.length, 0);
    assert.match(h.controller.state.error, /saved inputs have expired/);
});

test("a definite admission failure without HTTP status still permits correcting and preparing again", async t => {
    const h = fixture({ submit: async () => { throw Object.assign(new Error("Invalid metadata"), { status: null, uncertain: false }); } });
    t.after(() => h.controller.destroy()); await chooseArea(h); await h.handlers.prepare();
    assert.equal(h.controller.state.submissions[0].status, "failed");
    assert.equal(h.controller.state.canPrepare, true); assert.equal(h.values.size, 0);
});

test("older history responses cannot undo a cancellation acknowledgement", async t => {
    const pending = deferred(); let reads = 0;
    const h = fixture({ list: async () => ++reads === 1 ? { jobs: [job()], nextCursor: null } : pending.promise });
    t.after(() => h.controller.destroy()); await h.controller.start();
    const refresh = h.handlers.refreshHistory(); await h.handlers.cancel(job().jobId);
    pending.resolve({ jobs: [job()], nextCursor: null }); await refresh;
    assert.equal(h.controller.state.jobs[0].status, "cancelled");
});

test("history polling retains older pages and refreshes active jobs outside the first page", async t => {
    const older = job({ jobId: "f".repeat(32), createdAt: "2025-01-01T00:00:00Z" });
    const h = fixture({ list: async ({ cursor }) => cursor ? { jobs: [older], nextCursor: "tail" } : { jobs: [job()], nextCursor: "older" },
        get: async id => job({ ...older, jobId: id, status: "ready", updatedAt: "2026-01-01T00:02:00Z" }) });
    t.after(() => h.controller.destroy()); await h.controller.start(); await h.handlers.loadMore();
    assert.equal(h.controller.state.jobs.length, 2); assert.equal(h.controller.state.nextCursor, "tail");
    const timer = [...h.timers.values()].at(-1); assert.equal(timer.delay, 2000);
    await timer.callback();
    assert.equal(h.controller.state.jobs.length, 2); assert.equal(h.controller.state.nextCursor, "tail");
    assert.equal(h.controller.state.jobs.find(value => value.jobId === older.jobId).status, "ready");
});

test("visibility changes stop reads/timers and immediately refresh on return", async t => {
    const pending = deferred(); let reads = 0, hiddenSignal;
    const h = fixture({ list: async ({ signal }) => { reads++; if (reads === 2) { hiddenSignal = signal; return pending.promise; }
        return { jobs: [job({ status: "ready" })], nextCursor: null }; } });
    t.after(() => h.controller.destroy()); await h.controller.start();
    const reading = h.handlers.refreshHistory();
    h.document.hidden = true; h.document.visibilityState = "hidden"; h.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(hiddenSignal.aborted, true); assert.equal(h.timers.size, 0);
    pending.resolve({ jobs: [job()], nextCursor: null }); await reading;
    assert.equal(h.controller.state.jobs[0].status, "ready");
    h.document.hidden = false; h.document.visibilityState = "visible"; h.document.dispatchEvent(new Event("visibilitychange")); await flush();
    assert.equal(reads, 3); assert.equal([...h.timers.values()][0].delay, 30000);
});

test("destroy aborts page-owned requests and never cancels accepted server work", async () => {
    const pending = deferred(); let signal;
    const h = fixture({ coverage: async (value, year, requestSignal) => { signal = requestSignal; return pending.promise; } });
    await chooseArea(h); const checking = h.handlers.check(); const renders = h.renders.length;
    h.controller.destroy(); assert.equal(signal.aborted, true); assert.equal(h.timers.size, 0);
    pending.resolve({ cachedTiles: 10 }); await checking;
    h.document.dispatchEvent(new Event("visibilitychange")); h.window.dispatchEvent(new Event("pageshow")); await flush();
    assert.equal(h.renders.length, renders); assert.deepEqual(h.cancelled, []);
});


test("inventory reads require explicit refresh and remain separate from coverage and history", async t => {
    const reads = [], h = fixture({inventory: async signal => { reads.push(signal); return []; }});
    t.after(() => h.controller.destroy());
    await chooseArea(h);
    assert.equal(reads.length, 0);
    await h.handlers.refreshInventory();
    assert.equal(reads.length, 1); assert.deepEqual(h.controller.state.inventory, []);
    assert.ok(h.controller.state.inventoryCheckedAt);
    assert.equal(h.controller.state.inventoryLoading, false);
    assert.equal(h.controller.state.areas.length, 1);
    assert.equal(h.controller.state.coverageRows[0].coverage, null);
    assert.equal(h.submitted.length, 0); assert.equal(h.checked.length, 0);
    await h.handlers.refreshHistory();
    assert.equal(reads.length, 1);
    h.api.inventory = async () => { throw new Error("Private cache is temporarily unavailable."); };
    await h.handlers.refreshInventory();
    assert.deepEqual(h.controller.state.inventory, []);
    assert.match(h.controller.state.inventoryError, /temporarily unavailable/);
});


test("hiding the page cancels inventory reads and late replies cannot replace an explicit newer snapshot", async t => {
    const pending = deferred(); let signal, calls = 0;
    const h = fixture({inventory: async requestSignal => { calls++; signal = requestSignal; return pending.promise; }});
    t.after(() => h.controller.destroy());
    await h.controller.start();
    const read = h.handlers.refreshInventory();
    assert.equal(h.controller.state.inventoryLoading, true);
    h.document.hidden = true; h.document.visibilityState = "hidden";
    h.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(signal.aborted, true); assert.equal(h.controller.state.inventoryLoading, false);
    h.document.hidden = false; h.document.visibilityState = "visible";
    h.document.dispatchEvent(new Event("visibilitychange")); await flush();
    assert.equal(calls, 1, "visibility/history must not schedule inventory reads");
    h.api.inventory = async () => [{configurationSha256: "b".repeat(64)}];
    await h.handlers.refreshInventory();
    pending.resolve([{configurationSha256: "a".repeat(64)}]); await read;
    assert.deepEqual(h.controller.state.inventory, [{configurationSha256: "b".repeat(64)}]);
    assert.equal(h.controller.state.inventoryError, "");
});
