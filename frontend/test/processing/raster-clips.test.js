import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { RasterClipsController } from "../../src/processing/raster-clips-controller.js";
import { RasterClipsView, describeJobProgress, describeClipCrs } from "../../src/processing/raster-clips-view.js";
import { ProcessingApiClient, ProcessingRequestError, processingDownloadUrl } from "../../src/processing/api.js";
import { PendingSubmissionStorage } from "../../src/processing/pending-submission.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

const source = { collectionId: "rasters", itemId: "human-footprint", label: "Human footprint" };
const box = { kind: "selectedArea", selectedBounds: { west: 77, south: 22, east: 78, north: 23 } };
const id = "a".repeat(32);
const plan = { planId: id, expiresAt: "2099-01-01T00:00:00Z", area: { kind: "bounds", bounds: [77,22,78,23] },
    grid: { transform: [1000, 0, 0, 0, -1000, 0], width: 100, height: 120, crs: "EPSG:3857", dtype: "float32", estimatedRawBytes: 60000 } };
const job = { jobId: id, operation: "raster.clip.v1", status: "queued", source, area: plan.area, grid: plan.grid, progress: {}, result: null };
const markup = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const ready = { ...job, status: "ready", expiresAt: plan.expiresAt,
    result: { url: `/api/processing/jobs/${id}/result`, provenanceUrl: `/api/processing/jobs/${id}/provenance`, bytes: 100, filename: "clip.tif" } };
/** Complete queued transport and job observer microtasks. @return {Promise<void>} Settled fixture updates. */
const flush = async () => { for (let n = 0; n < 60; n++) await Promise.resolve(); };

/** Read safe text across a fake clip DOM tree. @param {Object} node DOM fixture node. @return {string} Descendant text. */
function textOf(node) { return [node.textContent, ...node.children.map(textOf)].join(" "); }

/** Clip DOM fixture which rejects controls absent from the actual application markup. */
class ClipControlDocument extends FakeRasterControlDocument {
    /** Record the current HTML controls. */
    constructor() { super(); this.controlIds = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1])); }
    /** Preserve native tag selectors for clip details, links and focus recovery.
     * @param {string} tag HTML tag.
     * @return {Object} Detached fake element.
     */
    createElement(tag) { const node = super.createElement(); node.tagName = tag; return node; }
    /** Resolve only declared clip controls.
     * @param {string} selector Exact ID selector.
     * @return {Object} Retained fake control.
     * @throws {Error} If presentation queries a removed HTML control.
     */
    querySelector(selector) {
        if (!selector.startsWith("#") || !this.controlIds.has(selector.slice(1))) throw Error(`Missing clip control: ${selector}`);
        return super.querySelector(selector);
    }
}

/** Create isolated clip lifecycles with real recovery storage and optional production DOM.
 * @param {Object} [overrides={}] Processing transport overrides.
 * @param {Map<string,string>} [data=new Map()] Session data shared across reload tests.
 * @param {boolean} [realView=false] Bind the actual clip view and HTML controls.
 * @param {Function|null} [getQuerySources=null] Composed default candidate policy.
 * @return {Object} Observable controller, storage, DOM and transport harness.
 */
function fixture(overrides = {}, data = new Map(), realView = false, getQuerySources = null) {
    const storage = new PendingSubmissionStorage({ getItem: key => data.get(key), setItem: (key,value) => data.set(key,value), removeItem: key => data.delete(key) });
    const requests = [];
    const api = { listJobs: async () => [],
        /** @param {string[]} ids Requested IDs. @return {Promise<Object>} Owned statuses. */
        async readJobStatuses(ids) {
            const records = await this.listJobs();
            return {jobs: records.filter(value => ids.includes(value.jobId)),
                unavailableJobIds: ids.filter(id => !records.some(value => value.jobId === id))};
        },
        submitClip: async value => { requests.push(value); return structuredClone(job); },
        cancelJob: async value => requests.push(["cancel",value]), deleteJob: async value => requests.push(["delete",value]), ...overrides };
    let context = { sources: [structuredClone(source)], area: structuredClone(box) };
    const doc = realView ? new ClipControlDocument() : null;
    const contexts = [];
    const view = realView ? new RasterClipsView(doc, { onContextChange: context => contexts.push(context) })
        : { bind(handlers) { this.handlers = handlers; }, render(state) { this.state = state; }, unbind() {} };
    const timers = [];
    let controller;
    const options = { api, view, storage, getQuerySources, getContext: () => context, onOpen() {}, onClose: () => controller.setActive(false), onEditArea() {},
        clock: { setTimeout(callback, delay) { timers.push([callback,delay]); return timers.length; }, clearTimeout() {} }, requestId: () => "request-1234567890" };
    controller = new RasterClipsController(options);
    return { controller, api, view, storage, requests, timers, options, data, doc, contexts, get context() { return context; }, setContext(value) { context = value; } };
}

test("submission freezes the selected source and box independently of later map changes", async () => {
    const h = fixture(); h.controller.open();
    h.context.area.selectedBounds.west = 60;
    h.context.sources[0].label = "Changed";
    await h.controller.submit();
    assert.equal(h.requests[0].area.selectedBounds.west, 77);
    assert.equal(h.requests[0].source.label, "Human footprint");
    assert.ok(Object.isFrozen(h.requests[0].area.selectedBounds));
    await h.controller.submit();
    h.controller.open(source, { ...box, selectedBounds: { west: 1, south: 2, east: 3, north: 4 } });
    assert.deepEqual(h.view.state.jobs[0].area.bounds, [77,22,78,23]);
});

test("the clip form rejects a histogram drawing without changing the selected clip area", async t => {
    const h = fixture();
    t.after(() => h.controller.destroy());
    h.controller.open(source, box);
    const drawing = {kind: "polygonArea", polygonArea: {id, sha256: "a".repeat(64)}};
    assert.throws(() => h.controller.open(source, drawing), /uploaded polygon layer to clip/);
    assert.deepEqual(h.view.state.area, box);
    await h.controller.submit();
    assert.deepEqual(h.requests.map(request => request.area), [box]);
});

test("clip choices distinguish two files from the same run and preserve the chosen original source", async () => {
    const first={kind:"runArtifact",jobId:"a".repeat(32),artifactId:"b".repeat(32),label:"First output"};
    const second={...first,artifactId:"c".repeat(32),label:"Second output"};
    const h=fixture({},new Map(),true);h.setContext({sources:[first,second],area:box});h.controller.open(second);
    assert.equal(h.view.elements.source.value,"1");assert.equal(h.view.sourceName({...job,source:second},[first,second]),"Second output");
    await h.controller.submit();assert.deepEqual(h.requests[0].source,second);
    h.controller.destroy();
});

test("generic clip review uses query candidates while explicit hidden raster choices remain available", async () => {
    const hidden = { ...source, itemId: "hidden" }, enabled = { ...source, itemId: "enabled" };
    let candidates = [enabled];
    const h = fixture({}, new Map(), true, area => area ? candidates : []);
    h.setContext({ sources: [hidden, enabled], area: box });
    h.controller.open(); assert.equal(h.controller.state.source.itemId, "enabled");
    assert.equal(h.requests.length, 0);
    h.controller.open(hidden, box); assert.equal(h.controller.state.source.itemId, "hidden");
    h.controller.editArea(); h.controller.open(); assert.equal(h.controller.state.source.itemId, "hidden");
    h.controller.open(null, box); assert.equal(h.controller.state.source.itemId, "enabled");
    candidates = []; h.controller.editArea(); h.controller.open();
    assert.equal(h.controller.state.source, null); await h.controller.submit(); assert.equal(h.requests.length, 0);
    h.controller.selectSource(0); await h.controller.submit();
    assert.equal(h.requests[0].source.itemId, "hidden", "explicit selection is not gated by visibility or overlap");
    h.controller.destroy();
});

test("query defaults never rewrite an uncertain clip submission", async () => {
    const enabled = { ...source, itemId: "enabled" }; let candidates = [enabled];
    const h = fixture({ submitClip: async intent => { h.requests.push(intent); throw Error("Response lost"); } }, new Map(), false, () => candidates);
    h.controller.open(); await h.controller.submit(); const original = structuredClone(h.controller.state.pending);
    candidates = []; h.setContext({ sources: [], area: null }); h.controller.open();
    await h.controller.submit();
    assert.deepEqual(h.requests, [original, original]); assert.deepEqual(h.controller.state.pending, original);
    h.controller.destroy();
});

test("whole-raster context never becomes an implicit clip export", async () => {
    const h=fixture(); h.setContext({sources:[source],area:{kind:"wholeRaster"}});
    h.controller.open();
    assert.equal(h.requests.length,0); assert.equal(h.view.state.area,null);
    h.controller.open(source,{kind:"catalogSelection",catalogSelection:CATALOG_SELECTION});
    await h.controller.submit();
    assert.deepEqual(h.requests[0].area,{kind:"catalogSelection",catalogSelection:CATALOG_SELECTION});
});

test("new catalog intent replaces the selection while an accepted job preserves its area", async () => {
    const h=fixture(); h.controller.open(source,{kind:"catalogSelection",catalogSelection:CATALOG_SELECTION});
    const changed={...CATALOG_SELECTION,itemId:"other-countries"};
    h.controller.open(source,{kind:"catalogSelection",catalogSelection:changed});
    await h.controller.submit();
    const accepted=structuredClone(h.view.state.jobs[0]);
    h.controller.open(source,box);
    assert.deepEqual(h.view.state.jobs[0],accepted);
});



test("uncertain submission survives reload and retries the original inputs/key", async () => {
    const h = fixture({ submitClip: async value => { h.requests.push(value); throw new Error("Network disconnected"); } });
    h.controller.open(); await h.controller.submit();
    const saved = h.storage.read(); assert.deepEqual(saved.source, source); assert.deepEqual(saved.area, box);
    h.controller.open(source, null); assert.deepEqual(h.storage.read(), saved);
    const recovered = new RasterClipsController({ ...h.options, api: { ...h.api, listJobs: async () => [job], submitClip: async value => { h.requests.push(value); return job; } } });
    await recovered.start();
    assert.deepEqual(h.requests.at(-1), h.requests.at(-2));
    assert.equal(h.storage.read(), null); assert.equal(recovered.state.jobs.length, 1);
});

test("definitive capacity rejection releases intent; server error retains it", async () => {
    const h = fixture({ submitClip: async () => { throw new ProcessingRequestError("Storage busy", 429, "storage_full"); } });
    h.controller.open(); await h.controller.submit();
    assert.equal(h.storage.read(), null);
    assert.match(h.view.state.message, /Storage busy/);
    h.api.submitClip = async () => { throw new ProcessingRequestError("Restarting", 503); };
    await h.controller.submit();
    assert.ok(h.storage.read());
});


test("polling recovers owned jobs without any map layers and lifecycle buttons call the API", async () => {
    const h = fixture({ listJobs: async () => [job] });
    h.setContext({ sources: [], area: null }); await h.controller.start();
    assert.equal(h.controller.state.jobs.length, 1); assert.equal(h.timers.at(-1)[1], 2000);
    await h.controller.jobAction(id,"cancel"); await h.controller.jobAction(id,"delete");
    assert.deepEqual(h.requests, [["cancel",id],["delete",id]]);
});

test("raster clips retain only clip jobs without drawing while closed", async () => {
    const calculation = { ...job, jobId: "b".repeat(32), operation: "raster.aggregate.v1",
        area: { kind: "wholeRaster", bounds: null }, source: undefined };
    const h = fixture({ listJobs: async () => [calculation, job] });
    await h.controller.start();
    assert.deepEqual(h.controller.state.jobs, [job]);
    assert.equal(h.controller.state.jobMessage, "");
    assert.equal(h.view.state, undefined);
    h.controller.open();
    assert.deepEqual(h.view.state.jobs, [job]);
});

test("closed clip controls retain updates and reopen with the latest clip without submitting", () => {
    const h = fixture();
    let drawings = 0;
    h.view.render = state => { drawings++; h.view.state = structuredClone(state); };
    h.controller.open();
    assert.equal(drawings, 1);
    h.controller.setActive(false);
    for (let i = 0; i < 25; i++) {
        h.controller.jobs.accept({ ...job, jobId: String(i), operation: "raster.aggregate.v1" });
    }
    const ready = { ...job, status: "ready" };
    h.controller.jobs.accept(ready);
    assert.equal(drawings, 1);
    assert.deepEqual(h.controller.state.jobs, [ready]);
    h.controller.setActive(true);
    assert.equal(drawings, 2);
    assert.deepEqual(h.view.state.jobs, [ready]);
    assert.deepEqual(h.requests, []);
    h.controller.setActive(true);
    assert.equal(drawings, 2);
    h.controller.destroy();
    h.controller.setActive(true);
    assert.equal(drawings, 2);
});

test("clip labels target the retained controls", () => {
    const markup = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    assert.doesNotMatch(markup, /History &amp; exports|id="downloads-|id="open-downloads/);
    for (const name of ["source"]) {
        assert.ok(markup.includes(`for="raster-clips-${name}"`));
        assert.ok(markup.includes(`id="raster-clips-${name}"`));
    }
    assert.doesNotMatch(markup, /id="raster-clips-area"|Your clips|id="raster-clips-refresh"/);
});

test("an older job listing cannot erase a newly accepted clip", async () => {
    let finishList;
    const h = fixture({ listJobs: () => new Promise(resolve => { finishList = resolve; }) });
    const listing = h.controller.refresh();
    h.controller.open(); await h.controller.submit();
    finishList([]); await listing;
    assert.equal(h.view.state.jobs[0].jobId, id);
    assert.equal(h.timers.at(-1)[1], 2000);
});

test("clip submission and recovery preserve source identities and exact areas without paths", async () => {
    const requests=[];
    const api = new ProcessingApiClient(async (url,options) => {
        requests.push([url,options]);
        return new Response(JSON.stringify(url.endsWith("/jobs") ? { jobs: [] }
            : job));
    });
    await Promise.all([api.submitClip({source: { ...source, path: "private" }, area: box, requestId: "request-1234567890"}), api.listJobs()]);
    assert.equal(requests[0][0], "/api/processing/jobs");
    const sent = requests.find(([url]) => url.endsWith("/raster-clips"))[1];
    assert.deepEqual(JSON.parse(sent.body), { collectionId: source.collectionId, itemId: source.itemId, selectedBounds: box.selectedBounds, requestId: "request-1234567890" });
    assert.equal(sent.headers["X-EOLab-Processing"], "1"); assert.equal(sent.credentials, "same-origin");
    const uploaded = {uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", layerName: "basins", filter: CATALOG_SELECTION.filter};
    const h = fixture();
    const submission = {source, area: {kind: "catalogSelection", catalogSelection: uploaded}, requestId: "request-1234567890", label: "Uploaded basin clip"};
    h.storage.write(submission);
    const recovered = h.storage.read();
    assert.deepEqual(recovered, submission);
    await api.submitClip(recovered);
    const uploadRequest = requests.at(-1)[1];
    assert.deepEqual(JSON.parse(uploadRequest.body), {collectionId: source.collectionId, itemId: source.itemId,
        catalogSelection: uploaded, requestId: submission.requestId});
    assert.equal(uploadRequest.headers["X-EOLab-Processing"], "1");
    await assert.rejects(api.submitClip({source, area:{kind:"wholeRaster"}}), /Select a box/);
});

test("API preserves actionable no-overlap and capacity errors", async () => {
    const api = new ProcessingApiClient(async () => new Response(JSON.stringify({ detail: { code: "no_overlap", message: "Area does not overlap the raster" } }),{ status:422 }));
    await assert.rejects(api.listJobs(), error => error.code === "no_overlap" && error.status === 422);
    assert.equal(api.session, null);
});

test("download navigation is limited to direct owned artifact endpoints", () => {
    assert.equal(processingDownloadUrl(`/api/processing/jobs/${id}/result`,id,"result"), `/api/processing/jobs/${id}/result`);
    for (const bad of ["https://other.org/file", "javascript:alert(1)", `/api/processing/jobs/${"b".repeat(32)}/result`]) {
        assert.throws(() => processingDownloadUrl(bad,id,"result"));
    }
});

test("clip form and job cards show grid, real progress, direct links and independent actions", async () => {
    const h = fixture();
    const contexts = [];
    const doc = new ClipControlDocument(); const view = new RasterClipsView(doc, { onContextChange: context => contexts.push(context) });
    const actions=[]; view.bind({ onOpen() {}, onClose() {}, onSource() {}, onNew() {}, onShowJob() {}, onCreate() {}, onRetrySubmission() {}, onEditArea() {}, onCancel: id => actions.push(id), onDelete: id => actions.push(id) });
    h.controller.open();
    view.render(h.view.state);
    assert.equal(contexts.at(-1).source, source.label);
    assert.equal(contexts.at(-1).scope, doc.querySelector("#raster-clips-area-description").textContent);
    assert.match(contexts.at(-1).scope, /W 77\.0000/);
    const text = element => element.textContent + element.children.map(text).join(" ");
    assert.equal(doc.querySelector("#raster-clips-create").disabled, false);
    h.view.state.jobs = [{ ...job, status:"ready", expiresAt: plan.expiresAt,
        result: { url:`/api/processing/jobs/${id}/result`, provenanceUrl:`/api/processing/jobs/${id}/provenance`, bytes:100, filename:"clip.tif" } }];
    h.view.state.currentJobId = id; h.view.state.review = false;
    view.render(h.view.state);
    const card = doc.querySelector("#raster-clips-current").children[0];
    assert.match(text(card), /100 × 120 pixels/);
    assert.match(text(card), /EPSG:3857/);
    const link = card.children.find(child => child.className === "downloads-actions").children[0];
    assert.equal(link.href, `/api/processing/jobs/${id}/result`);
    card.children.at(-1).children.at(-1).dispatchEvent(new Event("click")); assert.deepEqual(actions,[id]);
    view.render({ ...h.view.state, jobs: [{ ...job, status: "running" }] });
    assert.equal(describeJobProgress({ ...job, status:"running", progress:{phase:"clipping",completedBlocks:3,totalBlocks:10} }),"Clipping · 3 of 10 source blocks");
    assert.equal(describeJobProgress({ ...job, status:"running", progress:{phase:"preparing"} }), "Preparing clip…");
    assert.equal(describeJobProgress({ ...job, status:"running", progress:{phase:"calculating"} }), "Starting clip…");
    assert.match(describeJobProgress({ ...job, status:"running", progress:{phase:"creating_cog"} }),/Preparing download/);
    view.unbind();
});

test("layer, 1D and X/Y review intents retain their distinct captured source and area", async () => {
    const h = fixture({}, new Map(), true);
    const other = { ...source, itemId: "other-raster", label: "Other raster" };
    const pairedArea = { kind: "selectedArea", selectedBounds: { west: 1, south: 2, east: 3, north: 4 } };
    h.controller.open(source); assert.deepEqual(h.controller.state.area, box);
    h.controller.open(other, pairedArea);
    assert.equal(h.view.elements["source-name"].textContent, other.label);
    assert.match(h.view.elements["area-description"].textContent, /W 1.0000/);
    assert.deepEqual(h.controller.state.area, pairedArea);
    h.context.area.selectedBounds.west = 60;
    assert.equal(h.controller.state.area.selectedBounds.west, 1);
    h.controller.open(source, box); await h.controller.submit();
    const accepted = structuredClone(h.controller.state.jobs[0]);
    h.controller.open(other, pairedArea);
    assert.equal(h.view.elements.form.hidden, false);
    assert.equal(h.view.elements.current.hidden, true);
    assert.equal(h.view.elements.recent.hidden, false);
    assert.equal(Boolean(h.view.elements.recent.open), false);
    assert.deepEqual(h.controller.state.jobs[0], accepted);
    h.view.elements.jobs.children[0].children[0].dispatchEvent(new Event("click"));
    assert.equal(h.view.elements.current.hidden, false);
    assert.equal(h.view.elements.form.hidden, true);
    assert.match(h.contexts.at(-1).scope, /W 77.0000/);
    assert.equal(h.doc.activeElement, h.view.elements.current);
    assert.equal(h.requests.length, 1);
    h.view.elements.close.dispatchEvent(new Event("click")); h.controller.destroy();
    assert.equal(h.requests.length, 1, "closing and teardown neither cancel nor delete accepted work");
});

test("changing unsubmitted sampling intent keeps the chosen raster and accepted work intact", async () => {
    const h = fixture({}, new Map(), true); h.controller.open(); await h.controller.submit();
    const accepted = structuredClone(h.controller.state.jobs[0]);
    const other = { ...source, itemId: "other", label: "Other" };
    h.context.sources.push(other);
    h.view.elements.new.dispatchEvent(new Event("click"));
    h.view.elements.source.value = "1"; h.view.elements.source.dispatchEvent(new Event("change"));
    h.view.elements["edit-area"].dispatchEvent(new Event("click"));
    h.controller.setSelection({ ...box, selectedBounds: { ...box.selectedBounds, west: 76 } });
    assert.equal(h.contexts.at(-1).usesSamplingBox, true);
    assert.equal(h.controller.state.review, true);
    assert.equal(h.controller.state.source.itemId, "other");
    assert.equal(h.controller.state.area.selectedBounds.west, 76);
    assert.deepEqual(h.controller.state.jobs[0], accepted);
    assert.equal(h.requests.length, 1);
    h.controller.destroy();
});

test("ready downloads show the server deadline and preserve direct owned exports", async () => {
    const h = fixture({ listJobs: async () => [ready] }, new Map(), true);
    h.setContext({ sources: [], area: null }); await h.controller.start(); h.controller.open();
    assert.equal(h.view.elements.form.hidden, true);
    assert.equal(h.view.elements.current.hidden, false);
    assert.equal(h.view.elements.recent.hidden, true);
    const card = h.view.elements.current.children[0];
    assert.match(textOf(card), /Expires/);
    assert.equal(card.querySelector("time").getAttribute("datetime"), plan.expiresAt);
    const links = card.querySelectorAll("a");
    assert.deepEqual(links.map(link => link.href), [ready.result.url, ready.result.provenanceUrl]);
    assert.equal(links.every(link => link.getAttribute("download") === ""), true);
    assert.match(h.contexts.at(-1).scope, /W 77.0000/);
    h.controller.jobs.accept({ ...ready, status: "expired" });
    assert.equal(h.view.elements.current.children[0].querySelectorAll("a").length, 0);
    assert.match(textOf(h.view.elements.current), /Expired/);
    assert.equal(h.requests.length, 0, "observing expiry never deletes server data");
    h.controller.destroy();
});

test("uncertain download recovery stays visible with original inputs after map context changes", async () => {
    const h = fixture({ submitClip: async value => { h.requests.push(value); throw Error("Response lost"); } }, new Map(), true);
    h.controller.open(); await h.controller.submit();
    const saved = h.storage.read();
    h.controller.setSelection({ ...box, selectedBounds: { ...box.selectedBounds, west: 76 } });
    assert.deepEqual(h.storage.read(), saved);
    h.setContext({ sources: [], area: null }); h.controller.open(source, null);
    assert.equal(h.view.elements["source-name"].textContent, source.label);
    assert.equal(h.view.elements["retry-submission"].hidden, false);
    assert.equal(h.view.elements.source.disabled, true);
    assert.equal(h.view.elements["edit-area"].disabled, true);
    assert.equal(h.contexts.at(-1).usesSamplingBox, false);
    assert.equal(h.view.elements.create.disabled, true);
    assert.match(h.contexts.at(-1).scope, /W 77.0000/);
    h.controller.destroy();
    const restored = fixture({ listJobs: async () => [ready], submitClip: async value => { restored.requests.push(value); return ready; } }, h.data, true);
    restored.setContext({ sources: [], area: null }); await restored.controller.start(); restored.controller.open();
    assert.deepEqual(restored.requests[0], saved);
    assert.equal(restored.storage.read(), null);
    assert.equal(restored.view.elements.current.hidden, false);
    assert.equal(restored.view.elements.form.hidden, true);
    assert.equal(restored.contexts.at(-1).source, source.itemId);
    assert.match(restored.contexts.at(-1).scope, /W 77.0000/);
    assert.equal(restored.view.elements["retry-submission"].hidden, true);
    restored.controller.destroy();
});

test("reloaded active downloads remain cancellable without map layers and suppress duplicate actions", async () => {
    let resolveCancel;
    const h = fixture({ listJobs: async () => [job], cancelJob: value => { h.requests.push(["cancel", value]); return new Promise(resolve => { resolveCancel = resolve; }); } }, new Map(), true);
    h.setContext({ sources: [], area: null }); await h.controller.start(); h.controller.open();
    const cancel = h.view.elements.current.children[0].querySelector("button");
    cancel.dispatchEvent(new Event("click")); cancel.dispatchEvent(new Event("click"));
    assert.deepEqual(h.requests, [["cancel", id]]);
    assert.equal(h.controller.state.jobActions.has(id), true);
    const cancelling = { ...job, status: "cancelling" }; h.api.listJobs = async () => [cancelling]; resolveCancel(cancelling); await flush();
    assert.equal(h.view.elements.current.children[0].querySelector("button").disabled, true);
    h.controller.destroy();
});

test("recent downloads contain only other active or downloadable clips and selecting one does not submit", async () => {
    const other = { ...job, jobId: "b".repeat(32), source: { ...source, itemId: "other" } };
    const discarded = ["expired", "failed", "cancelled", "deleted"].map((status, index) => ({ ...job, jobId: String(index), status }));
    const h = fixture({ listJobs: async () => [ready, other, ...discarded, { ...job, jobId: "c".repeat(32), operation: "raster.aggregate.v1" }] }, new Map(), true);
    await h.controller.start(); h.controller.open();
    assert.equal(h.view.elements["recent-label"].textContent, "Recent downloads (1)");
    assert.equal(h.view.elements.jobs.children.length, 1);
    h.view.elements.jobs.children[0].children[0].dispatchEvent(new Event("click"));
    assert.equal(h.controller.state.currentJobId, other.jobId);
    assert.equal(h.view.elements["recent-label"].textContent, "Recent downloads (1)");
    assert.match(textOf(h.view.elements.current), /Queued/);
    assert.equal(h.requests.length, 0);
    h.controller.destroy();
});

test("current download preserves safe resource errors and rejects arbitrary result and provenance URLs", async () => {
    const h = fixture({}, new Map(), true); h.controller.open(); await h.controller.submit();
    const detail = '<img src=x onerror="alert(1)"> exceeds the native-work limit';
    h.controller.jobs.accept({ ...job, status: "failed", error: { code: "source_work_too_large", detail } });
    assert.match(textOf(h.view.elements.current), /exceeds the native-work limit/);
    const error = h.view.elements.current.children[0].children.find(node => node.textContent.includes(detail));
    assert.equal(error.children.length, 0);
    for (const [kind, address] of [["url", "https://example.com/result"], ["provenanceUrl", `/api/processing/jobs/${"x".repeat(32)}/provenance`]]) {
        assert.throws(() => h.controller.jobs.accept({ ...ready, result: { ...ready.result, [kind]: address } }), /Invalid processing download address/);
    }
    h.controller.destroy();
});

test("other accepted downloads remain cancellable while the current submission is uncertain", async () => {
    const h = fixture({ listJobs: async () => [job], submitClip: async () => { throw Error("Response lost"); } }, new Map(), true);
    await h.controller.start(); h.controller.open(source, box); await h.controller.submit();
    const saved = h.storage.read(), row = h.view.elements.jobs.children[0];
    assert.equal(row.children[0].disabled, true, "uncertain intent cannot be replaced by a different review");
    row.children[1].dispatchEvent(new Event("click")); await flush();
    assert.deepEqual(h.requests, [["cancel", id]]);
    assert.deepEqual(h.storage.read(), saved);
    h.controller.destroy();
});

test("pending recovery ignores corrupt and oversized browser data", () => {
    for (const value of ["bad JSON", "x".repeat(3000), JSON.stringify({planId:"bad", requestId:"valid-request-1234",label:"raster"})]) {
        assert.equal(new PendingSubmissionStorage({ getItem: () => value }).read(),null);
    }
});

test("native CRS presentation uses the root authority, not the embedded geographic datum", () => {
    assert.equal(describeClipCrs('PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]],AUTHORITY["EPSG","3857"]]'), "WGS 84 / Pseudo-Mercator (EPSG:3857)");
    assert.equal(describeClipCrs('PROJCRS["Custom grid",ID["EPSG",32643]]'), "Custom grid (EPSG:32643)");
    assert.equal(describeClipCrs('PROJCS["Custom grid",GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]],UNIT["metre",1]]'), "Custom grid");
    assert.equal(describeClipCrs("EPSG:4326"), "EPSG:4326");
});

test("Downloads and sampling share only neutral selection values; peers never import Processing", () => {
    const root = new URL("../../src/",import.meta.url);
    const markup = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    assert.doesNotMatch(markup, /upload[\s\S]{0,24}AOI|temporary[- ]AOI/i);
    for (const directory of ["raster", "map-layers", "vector"]) {
        for (const file of readdirSync(new URL(`${directory}/`,root)).filter(name=>name.endsWith(".js"))) {
            const source = readFileSync(new URL(`${directory}/${file}`,root),"utf8");
            assert.doesNotMatch(source,/from\s+["'][^"']*processing\//);
        }
    }
    for (const file of readdirSync(new URL("processing/",root))) {
        const source = readFileSync(new URL(`processing/${file}`,root),"utf8");
        assert.doesNotMatch(source,/from\s+["'][^"']*(?:raster\/|map-layers\/|vector\/|map-inspection)/);
        assert.doesNotMatch(source,/\.blob\(|createObjectURL/);
    }
    const selectedArea=readFileSync(new URL("selected-area.js",root),"utf8");
    assert.deepEqual([...selectedArea.matchAll(/from\s+["']([^"']+)["']/g)].map(match=>match[1]),["./sampling-box.js"]);
    assert.doesNotMatch(selectedArea,/\bfetch\b|\bdocument\b/);
    assert.doesNotMatch(readFileSync(new URL("sampling-box.js",root),"utf8"),/\bimport\b|\bfetch\b|\bdocument\b/);
});


test("clip capture, recovery and HTTP submission retain the exact observation and geodesic box", async () => {
    const area = {kind: "samplingBox", samplingBox: {center: {longitude: 0, latitude: 60}, sideLengthKm: 600}};
    const reference = {collectionId: "eolab-temporal-datasets", itemId: "era5-cog",
        variable: "surface_pressure", time: "2026-07-01T00:00:00Z"};
    const h = fixture();
    h.setContext({sources: [{...reference, label: "ERA5 surface pressure"}], area});
    h.controller.open();
    area.samplingBox.center.latitude = 0;
    await h.controller.submit();
    const captured = h.requests[0];
    assert.equal(captured.area.samplingBox.center.latitude, 60);
    assert.ok(Object.isFrozen(captured.area.samplingBox.center));
    h.storage.write(captured);
    const recovered = h.storage.read();
    assert.deepEqual(recovered, captured);
    let body;
    const api = new ProcessingApiClient(async (url, options) => {
        if (url.endsWith("/jobs")) return new Response(JSON.stringify({jobs: []}));
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({...job, area: {kind: "samplingBox", samplingBox: captured.area.samplingBox}}));
    });
    await api.submitClip(recovered);
    assert.deepEqual(body, {source: reference, samplingBox: captured.area.samplingBox,
        requestId: captured.requestId});
});


test("ordinary and temporal calculations submit the captured geodesic box", async () => {
    const area = {kind: "samplingBox", samplingBox: {center: {longitude: 0, latitude: 60}, sideLengthKm: 600}};
    let body;
    const api = new ProcessingApiClient(async (url, options) => {
        if (url.endsWith("/jobs")) return new Response(JSON.stringify({jobs: []}));
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({items: [{index: 0, job: {...job, operation: "raster.aggregate.v1"}}]}));
    });
    await api.submitCalculation({source, area, requestId: "box-calculation-123", calculations: [{label: "Mean", expression: "mean(a)"}]});
    assert.deepEqual(body.items[0].samplingBox, area.samplingBox);
    assert.equal(Object.hasOwn(body.items[0], "selectedBounds"), false);
    let modelSubmission;
    api.submitModelRun = async value => { modelSubmission = value; return job; };
    await api.submitCalculation({kind: "temporal", source, area, model: {id: "temporal", version: "1", definitionSha256: "a".repeat(64)},
        requestId: "temporal-box-123456", calculations: [{label: "Mean", expression: "mean(a)"}]});
    assert.deepEqual(modelSubmission.inputs.area, area);
});
