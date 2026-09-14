import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { VectorSamplingController } from "../../src/vector/sampling.js";
import { SummaryStatisticsController, canAutomaticallyCalculate } from "../../src/processing/summary-statistics-controller.js";
import { SummaryStatisticsView } from "../../src/processing/summary-statistics-view.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingApiClient } from "../../src/processing/api.js";
import { SummaryControlDocument, SUMMARY_MARKUP } from "../../test-support/processing/summary-document.js";

const source = { collectionId: "rasters", itemId: "hfp", label: "Human footprint" };
const resistance = { collectionId: "rasters", itemId: "resistance", label: "Resistance" };
const box = west => ({ kind: "selectedArea", selectedBounds: { west, south: 22, east: west + 1, north: 23 } });
const grid = { width: 100, height: 100, crs: "EPSG:3857", nativeBlocks: 4, decodedBytes: 10000 };
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };

test("the first active map click calculates and an unchanged completed box reuses its result", async () => {
    const h = fixture(); await h.open();
    assert.equal(h.submits(), 0);
    h.controller.calculateSelection(); await h.tick();
    assert.equal(h.submits(), 1);
    await h.finish();
    h.controller.calculateSelection(); await h.tick();
    assert.equal(h.submits(), 1);
    assert.equal(h.controller.state.statistics[0].current, true);
});

test("late formula checks and plans cannot submit after leaving the summary panel", async () => {
    for (const stage of ["validateCalculation", "planCalculation"]) {
        const response = deferred(); const h = fixture(); await h.open();
        const original = h.api[stage];
        h.api[stage] = async value => { const result = await original(value); await response.promise; return result; };
        h.controller.calculateSelection(); await h.tick();
        h.controller.setActive(false);
        response.resolve(); await flush();
        assert.equal(h.submits(), 0);
        assert.equal(h.requests.filter(([kind]) => kind === "discard").length, stage === "planCalculation" ? 1 : 0);
    }
});

test("clearing raster coverage cancels automatic work without relabeling the previous result", async () => {
    const h = fixture(); await h.open();
    h.controller.calculateSelection(); await h.tick(); await h.finish();
    const card = h.controller.state.statistics[0], previous = card.result;
    h.controller.setSelection(box(80));
    h.controller.calculateSelection(); await h.tick();
    h.controller.setSelection(null); await flush();
    assert.equal(h.requests.filter(([kind]) => kind === "cancel").length, 1);
    assert.equal(h.controller.isActive, true);
    assert.equal(h.controller.state.area, null);
    assert.equal(card.result, previous);
    assert.equal(card.current, false);
});

/** Build the real summary/controller/job boundary against current HTML identities.
 * @param {Object} [overrides={}] API fault overrides. @param {Map} [data=new Map()] Session storage.
 * @param {Object} [browserContext={}] Clipboard capability. @return {Object} Observable workflow harness.
 */
function fixture(overrides = {}, data = new Map(), browserContext = {}) {
    let serial = 0, jobSerial = 0, elapsed = 0;
    const timers = new Map(), requests = [], server = new Map(), plans = new Map();
    const clock = { setTimeout(fn, delay) { timers.set(++serial, { fn, delay }); return serial; }, clearTimeout(id) { timers.delete(id); } };
    const api = {
        listJobs: async () => [...server.values()], getJob: async id => server.get(id),
        validateCalculation: async rows => { requests.push(["validate", rows]); if (rows.some(row=>row.expression.includes("bad"))) throw Error("Unknown function bad"); return {valid:true}; },
        planCalculation: async intent => { const planId = String(++jobSerial).padStart(32,"0"); requests.push(["plan",intent]); plans.set(planId,intent); return {planId,grid,expiresAt:"2099-01-01T00:00:00Z"}; },
        discardPlan: async id => { requests.push(["discard",id]); },
        submitCalculation: async submission => {
            requests.push(["submit",submission]);
            const intent = plans.get(submission.planId);
            const job = { jobId:submission.planId,operation:"raster.aggregate.v1",status:"running",sources:{a:intent.source},calculations:intent.calculations,
                area:{kind:"bounds",bounds:[77,22,78,23]},grid,createdAt:"2026-09-08T00:00:00Z",progress:{phase:"calculating",totalBlocks:4,completedBlocks:0},result:null };
            server.set(job.jobId,job); return job;
        },
        cancelJob: async id => { requests.push(["cancel",id]);const job={...server.get(id),status:"cancelling"};server.set(id,job);return job; },
        deleteJob: async id => { const job={...server.get(id),status:"deleted",result:null};server.set(id,job);return job; },
        ...overrides,
    };
    const jobs = new ProcessingJobs(api,clock);
    const storage = new CalculationSessionStorage({getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)});
    const document = new SummaryControlDocument();
    const view = new SummaryStatisticsView(document, browserContext);
    let controller;
    controller = new SummaryStatisticsController({api,jobs,storage,view,clock,now:()=>elapsed,getContext:()=>({sources:[source,resistance],area:box(77)}),
        onOpen:()=>controller.setActive(true),onClose(){},onEditArea(){},requestId:()=>`request-${String(jobSerial).padStart(16,"0")}`});
    const tick = async (delay = 700) => { const due=[...timers.entries()].filter(([,t])=>t.delay===delay);for(const[id,t]of due){timers.delete(id);t.fn();}await flush(); };
    const finish = async (status="ready", values=["12.5"]) => {
        const old=server.get(controller.executor.snapshot.currentJob.jobId);
        const result=status==="ready"?{url:`/api/processing/jobs/${old.jobId}/result`,provenanceUrl:`/api/processing/jobs/${old.jobId}/provenance`,rows:old.calculations.map((row,i)=>({...row,value:values[i]??values[0],valueType:"float",state:"ok",aggregates:[{function:"mean",matchedPixels:8,validPixels:8,invalidArithmeticPixels:0}]}))}:null;
        server.set(old.jobId,{...old,status,result,error:status==="failed"?{detail:"Scan failed"}:null});
        await jobs.refresh();await flush();
    };
    const open = async()=>{controller.open();await tick();};
    const submits=()=>requests.filter(r=>r[0]==="submit").length;
    return {controller,api,jobs,storage,view,document,requests,server,plans,tick,finish,open,submits,data,elapse:ms=>{elapsed+=ms;}};
}

/** Read text throughout a fake DOM tree. @param {Object} node Test node. @return {string} Descendant text. */
function visibleText(node) { return [node.textContent, ...node.children.map(visibleText)].join(" "); }

/** Connect real selection and summary controllers through the production composition callback.
 * @param {Object} h Summary workflow harness.
 * @param {number[]} bbox Authoritative selection envelope.
 * @return {Object} Bound selection view and lifecycle cleanup.
 */
function composedVectorSelection(h, bbox) {
    const main = readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
    const start = main.indexOf("onActivate: (area, calculate) => {");
    const end = main.indexOf("\n        onInvalidate:", start);
    assert.ok(start >= 0 && end > start, "Production vector activation callback exists");
    const dependencies = {
        calculations: h.controller,
        vectorSamplingOverlay: { load() {} },
        // Raster sampling can change the active dock: composition must capture intent first.
        rasterVisualization: { setVectorSelection() { h.controller.setActive(false); } },
        mapInspection: { showCalculations() { h.controller.setActive(true); } },
    };
    const { onActivate } = new Function(...Object.keys(dependencies),
        `return ({${main.slice(start, end)}});`)(...Object.values(dependencies));
    const filter = { enabled: true, match: "all", rules: [{ field: "iso3", operator: "eq", value: "PER" }] };
    const view = { bind(handlers) { this.handlers = handlers; }, render(state) { this.state = state; }, unbind() {} };
    const controller = new VectorSamplingController({
        view, getTargets: () => [{ key: "countries", label: "Countries", item: { collection: "vectors", id: "countries" }, filter }],
        createArea: async () => ({ selection: CATALOG_SELECTION, label: "Countries", filter, bbox, matched: 1, total: 200 }),
        onActivate,
        onInvalidate: id => h.controller.invalidateSamplingArea(id), onEditFilter() {},
        clock: { setTimeout() {}, clearTimeout() {} },
    });
    return { view, destroy: () => controller.destroy() };
}

for (const [name, bbox, confirmations] of [
    ["small selection", [-81, -19, -68, 0], 0],
    ["reviewed selection", [-90, -30, -30, 30], 1],
    ["near-global selection", [-180, -85, 180, 85], 2],
]) {
    test(`direct Use these features calculates after final acceptance: ${name}`, async () => {
        const h = fixture(); await h.open(); h.controller.setAutomatic(false); h.controller.chooseArea("vector");
        const selection = composedVectorSelection(h, bbox);
        selection.view.handlers.onUse(); await flush(); await h.tick();
        for (let index = 0; index < confirmations; index++) {
            assert.equal(h.submits(), 0, "No calculation before the final feature confirmation");
            selection.view.handlers.onConfirm(); await h.tick();
        }
        assert.equal(h.submits(), 1);
        assert.deepEqual(h.controller.executor.snapshot.unfinishedCalculation.calculation.area.catalogSelection, CATALOG_SELECTION);
        assert.equal(h.controller.isActive, true);
        selection.view.handlers.onConfirm(); await h.tick();
        assert.equal(h.submits(), 1, "A repeated confirmation cannot resubmit");
        await h.finish(); assert.equal(h.controller.state.statistics[0].current, true);
        selection.destroy();
    });
}

test("direct Explore acceptance does not implicitly calculate", async () => {
    const h = fixture(); await h.open(); h.controller.setAutomatic(false); h.controller.setActive(false);
    const selection = composedVectorSelection(h, [-180, -85, 180, 85]);
    selection.view.handlers.onUse(); await flush(); await h.tick();
    selection.view.handlers.onConfirm(); selection.view.handlers.onConfirm(); await h.tick();
    assert.equal(selection.view.state.phase, "active"); assert.equal(h.submits(), 0);
    assert.equal(h.controller.isActive, false); selection.destroy();
});

test("direct feature acceptance with no statistics opens the editor", async () => {
    const h = fixture(); await h.open(); h.controller.removeStatistic(h.controller.state.statistics[0].id);
    const selection = composedVectorSelection(h, [-81, -19, -68, 0]);
    selection.view.handlers.onUse(); await flush(); await h.tick();
    assert.equal(h.submits(), 0); assert.equal(h.controller.state.statistics.length, 0);
    assert.equal(h.document.activeElement, h.view.elements.template); selection.destroy();
});

test("applied vector action runs configured valid statistics once even with automatic updates disabled", async () => {
    const h = fixture(); await h.open(); h.controller.setAutomatic(false);
    h.controller.addStatistic("custom"); await h.tick();
    h.controller.setVectorSamplingArea({ selection: CATALOG_SELECTION, label: "Canada" }, true); await h.tick();
    assert.equal(h.submits(), 1);
    assert.equal(h.controller.executor.snapshot.unfinishedCalculation.calculation.calculations.length, 1);
    assert.deepEqual(h.controller.executor.snapshot.unfinishedCalculation.calculation.area.catalogSelection, CATALOG_SELECTION);
    await h.finish(); assert.equal(h.controller.state.statistics[0].current, true);
    assert.equal(h.controller.state.statistics[1].result, null);
});

test("an applied selection with no statistics opens the editor without inventing a calculation", async () => {
    const h = fixture(); await h.open();
    h.controller.removeStatistic(h.controller.state.statistics[0].id);
    h.controller.setVectorSamplingArea({ selection: CATALOG_SELECTION, label: "Canada" }, true); await h.tick();
    assert.equal(h.controller.state.statistics.length, 0); assert.equal(h.submits(), 0);
    assert.equal(h.document.activeElement, h.view.elements.template);
});

test("selection progress greys previous values and exposes cancellation before planning", async () => {
    const h = fixture(); await h.open(); const card = h.controller.state.statistics[0];
    h.controller.request(card.id, "manual"); await flush(); await h.finish();
    h.controller.onCancelSelection = () => h.controller.setVectorSelectionState({ analysis: true, phase: "idle", message: "Selection cancelled" });
    h.controller.setVectorSelectionState({ analysis: true, phase: "reading", message: "Reading polygons" });
    const row = h.view.cards.get(card.id);
    assert.equal(card.current, false); assert.equal(row.root.classList.contains("is-previous"), true);
    assert.match(row.status.textContent, /Calculating/); assert.equal(row.stop.hidden, false);
    row.stop.dispatchEvent(new Event("click"));
    assert.match(row.status.textContent, /Selection cancelled/); assert.equal(row.stop.hidden, true);
    assert.equal(h.submits(), 1);
});

test("late vector plans are released before the newest applied area is submitted", async () => {
    const h = fixture(); await h.open(); const wait = deferred(), original = h.api.planCalculation;
    let first = true;
    h.api.planCalculation = async intent => { const plan = await original(intent); if (first) { first = false; await wait.promise; } return plan; };
    h.controller.setVectorSamplingArea({ selection: { ...CATALOG_SELECTION, itemId: "first" }, label: "First" }, true); await h.tick();
    h.controller.setVectorSelectionState({ analysis: true, phase: "reading", message: "Replacement" });
    h.controller.setVectorSamplingArea({ selection: { ...CATALOG_SELECTION, itemId: "second" }, label: "Second" }, true); await h.tick();
    assert.equal(h.submits(), 0); wait.resolve(); await flush();
    assert.equal(h.submits(), 1); assert.equal(h.controller.executor.snapshot.unfinishedCalculation.calculation.area.catalogSelection.itemId, "second");
    const operations = h.requests.map(row => row[0]);
    assert.ok(operations.indexOf("discard") < operations.lastIndexOf("plan"));
});

test("a late accepted vector job is cancelled before a replacement runs and cannot publish its value", async () => {
    const h = fixture(); await h.open(); const wait = deferred(), submit = h.api.submitCalculation;
    let first = true;
    h.api.submitCalculation = async request => { const job = await submit(request); if (first) { first = false; await wait.promise; } return job; };
    h.controller.setVectorSamplingArea({ selection: { ...CATALOG_SELECTION, itemId: "first" }, label: "First" }, true); await h.tick();
    h.controller.setVectorSelectionState({ analysis: true, phase: "reading", message: "Replacement" });
    h.controller.setVectorSamplingArea({ selection: { ...CATALOG_SELECTION, itemId: "second" }, label: "Second" }, true); await h.tick();
    wait.resolve(); await flush(); assert.equal(h.requests.filter(row => row[0] === "cancel").length, 1);
    assert.equal(h.submits(), 1); await h.finish("ready", ["99"]);
    assert.equal(h.controller.state.statistics[0].result, null); assert.equal(h.submits(), 2);
    await h.finish("ready", ["7"]); assert.equal(h.controller.state.statistics[0].result.row.value, "7");
});

test("the active summary view queries only current markup and rejects every missing required control", () => {
    const document = new SummaryControlDocument();
    const view = new SummaryStatisticsView(document);
    for (const selector of document.queries) {
        const markup = SUMMARY_MARKUP.replace(`id="${selector.slice(1)}"`, 'id="removed-for-contract-test"');
        assert.throws(() => new SummaryStatisticsView(new SummaryControlDocument(markup)), /absent from current HTML/);
    }
    assert.throws(() => document.querySelector("#calculations-editor"), /absent from current HTML/);
    assert.equal(view.openEditor, undefined);
    assert.equal(view.renderRows, undefined);
    view.unbind();
});

test("unbind releases current fixed controls without dispatching new calculations", async () => {
    const h = fixture(); await h.open();
    h.view.unbind();
    h.view.elements.template.value = "count";
    h.view.elements.template.dispatchEvent(new Event("change"));
    assert.equal(h.controller.state.statistics.length, 1);
    assert.equal(h.submits(), 0);
});

test("area presets remain editable and the current menu enforces five statistics", async () => {
    const h = fixture(); await h.open(); h.controller.setAutomatic(false);
    for (const [preset, formula] of [["area-threshold", "areaha(a > 10)"], ["area-class", "areaha(a == 4)"], ["count", "count(a > 10)"], ["range", "max(a) - min(a)"]]) {
        h.view.elements.template.value = preset;
        h.view.elements.template.dispatchEvent(new Event("change"));
        await h.tick();
        const card = h.controller.state.statistics.at(-1);
        assert.equal(h.view.cards.get(card.id).expression.value, formula);
    }
    assert.equal(h.view.elements.template.disabled, true);
    assert.equal(h.submits(), 0);
});

test("saved inspection preserves exact integers, coverage, exports and live formula focus", async () => {
    const h = fixture(); await h.open(); const card = h.controller.state.statistics[0];
    h.controller.request(card.id, "manual"); await flush(); await h.finish("ready", ["9007199254740993"]);
    const job = card.result.job;
    job.result.rows[0].valueType = "integer";
    h.controller.inspect(job.jobId);
    const root = h.view.elements.result, row = h.view.cards.get(card.id);
    assert.equal(root.children[0].textContent, "Previous / saved result");
    assert.match(visibleText(root), /Human footprint/);
    assert.match(visibleText(root), /Exact value: 9007199254740993/);
    assert.equal(root.children[2].children[1].textContent, BigInt("9007199254740993").toLocaleString());
    assert.match(visibleText(root), /8 matched \/ 8 valid cells/);
    const links = root.children.at(-1).children;
    assert.equal(links[0].href, `/api/processing/jobs/${job.jobId}/result`);
    assert.equal(links[1].href, `/api/processing/jobs/${job.jobId}/provenance`);
    assert.equal(links[0].getAttribute("download"), "");
    const savedRow = root.children[2]; savedRow.children.at(-1).open = true;
    row.expression.focus(); h.controller.render();
    assert.equal(h.document.activeElement, row.expression);
    assert.equal(root.children[2], savedRow);
    assert.equal(savedRow.children.at(-1).open, true);
    h.view.extra["close-saved"].dispatchEvent(new Event("click"));
    assert.equal(h.view.extra["saved-result"].hidden, true);
    assert.equal(h.view.cards.get(card.id), row);
    assert.equal(h.submits(), 1);
});

test("saved results retain typed empty and arithmetic explanations", async () => {
    const h = fixture(); await h.open(); const card = h.controller.state.statistics[0];
    h.controller.request(card.id, "manual"); await flush(); await h.finish();
    for (const [state, message] of [["no_matches", /No cells matched/], ["no_valid_data", /No valid cells/],
        ["invalid_arithmetic", /Undefined arithmetic/], ["overflow", /Numeric overflow/]]) {
        const job = structuredClone(card.result.job);
        job.result.rows[0] = { ...job.result.rows[0], state, value: null };
        h.controller.state.saved = job; h.controller.render();
        assert.match(visibleText(h.view.elements.result), message);
        assert.match(visibleText(h.view.elements.result), /Exact value: undefined/);
        assert.equal(h.view.elements.result.children[2].children[1].textContent, "—");
    }
});

test("saved jobs show progress and failure safely when their Catalog label is unavailable", async () => {
    const h = fixture(); await h.open(); const card = h.controller.state.statistics[0];
    h.controller.request(card.id, "manual"); await flush();
    const job = h.server.get(h.controller.executor.snapshot.currentJob.jobId);
    h.controller.state.sources = [];
    h.controller.inspect(job.jobId);
    assert.match(visibleText(h.view.elements.result), /hfp/);
    assert.match(visibleText(h.view.elements.result), /Calculating|Processing/);
    const message = '<img src=x onerror="alert(1)"> failed';
    h.controller.state.saved = { ...job, status: "failed", error: { detail: message } };
    h.controller.render();
    const error = h.view.elements.result.children.at(-1);
    assert.equal(error.textContent, message);
    assert.equal(error.children.length, 0);
});

test("live and saved area results preserve units and fractional-coverage context", async () => {
    const h = fixture(); await h.open(); const card = h.controller.state.statistics[0];
    h.controller.request(card.id, "manual"); await flush(); await h.finish();
    const job = structuredClone(card.result.job);
    job.grid.groundArea = { ellipsoid: "WGS84", edgeToleranceMetres: 0.1, maximumSegmentMetres: 10000, estimatedGeometryCells: 0, strategy: "rectilinear" };
    job.result.rows[0] = { ...job.result.rows[0], label: "Area", expression: "areaha(a == 4)", unit: "ha" };
    card.result = { ...card.result, job, row: job.result.rows[0] };
    h.controller.state.saved = job; h.controller.render();
    assert.equal(h.view.cards.get(card.id).value.textContent, "12.5 ha");
    assert.match(visibleText(h.view.cards.get(card.id).detailsBody), /WGS84 ellipsoid, hectares, including partial pixels/);
    assert.match(visibleText(h.view.elements.result), /Area measurement.*0.1 m chord-deviation target/);
    assert.match(visibleText(h.view.elements.result), /Result unit: ha/);
    assert.match(visibleText(h.view.elements.result), /numeric functions use pixel centers/);
});

test("saved result exports still reject arbitrary and mismatched job URLs", async () => {
    const h = fixture(); await h.open(); const card = h.controller.state.statistics[0];
    h.controller.request(card.id, "manual"); await flush(); await h.finish();
    for (const url of ["https://example.com/result", `/api/processing/jobs/${"x".repeat(32)}/result`]) {
        h.controller.state.saved = structuredClone(card.result.job);
        h.controller.state.saved.result.url = url;
        assert.throws(() => h.controller.render(), /Invalid processing download address/);
    }
});

for (const [code, message] of [["source_work_too_large", "The area needs 1,450 native blocks; the limit is 500."],
    ["source_work_too_large", "The area needs 3,570 decoded bytes; the limit is 3,500."],
    ["area_geometry_limit", "The current tile exceeds its retained geometry buffer. Filter the source more narrowly."]]) {
    test(`current cards preserve API refusal details: ${message}`, async () => {
        const h = fixture(); await h.open(); const card = h.controller.state.statistics[0];
        h.controller.request(card.id, "manual"); await flush(); await h.finish();
        const api = new ProcessingApiClient(async url => url.endsWith("/jobs")
            ? { ok: true, json: async () => ({ jobs: [] }) }
            : { ok: false, status: 413, json: async () => ({ detail: { code, message } }) });
        h.api.planCalculation = api.planCalculation.bind(api);
        h.controller.editStatistic(card.id, { expression: "sum(a)" }); await h.tick();
        const row = h.view.cards.get(card.id);
        assert.ok(row.status.textContent.includes(message));
        assert.equal(row.root.classList.contains("is-previous"), true);
        assert.equal(row.run.hidden, false);
        assert.equal(row.root.getAttribute("aria-busy"), "false");
        assert.equal(h.submits(), 1);
    });
}

test("opening and tab switching preserve cards and do not run native calculations", async()=>{
    const h=fixture();await h.open();assert.equal(h.submits(),0);
    h.controller.setActive(false);h.controller.setActive(true);await h.tick();assert.equal(h.submits(),0);
    const card=h.controller.state.statistics[0];assert.equal(card.valid,true);
    h.controller.request(card.id,"manual");await flush();await h.finish();
    h.controller.setActive(false);h.controller.open();await h.tick();assert.equal(h.submits(),1);
    assert.equal(card.current,true);
});

test("the summary Area selector offers inline vector controls and never calculates the old box while choosing polygons", async()=>{
    const h=fixture(); await h.open();
    const area=h.view.elements.area;
    assert.equal(area.children.find(option=>option.value==="vector").textContent,"Vector layer");
    const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual"); await flush();
    area.value="vector"; area.dispatchEvent(new Event("change")); await flush();
    assert.equal(h.controller.state.area,null);
    assert.equal(h.view.vectorAreaControls.hidden,false);
    assert.equal(h.view.elements["edit-area"].hidden,true);
    assert.ok(h.requests.some(request=>request[0]==="cancel"));
    assert.equal(h.view.cards.get(card.id).run.disabled,true);
    h.controller.setActive(false); h.controller.open(); await h.tick();
    assert.equal(h.controller.state.areaChoice,"vector");
    assert.equal(h.controller.state.area,null);
    assert.equal(h.submits(),1);
});

test("total wait includes debounce, planning, polling and the first result DOM update, then freezes", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.calculateSelection();h.elapse(700);await h.tick();
    h.elapse(3300);
    const render=h.view.render.bind(h.view);let displayed=false;
    h.view.render=state=>{render(state);if(card.result&&!displayed){displayed=true;h.elapse(25);}};
    await h.finish();
    assert.equal(card.result.totalWaitSeconds,4.025);
    const text=node=>[node.textContent,...node.children.map(text)].join(" ");
    assert.match(text(h.view.cards.get(card.id).detailsBody),/Total wait → result displayed: 4.025 s/);
    h.elapse(10000);h.controller.render();await h.jobs.refresh();
    assert.equal(card.result.totalWaitSeconds,4.025);
    h.controller.request(card.id,"manual");await flush();h.elapse(1500);await h.finish();
    assert.equal(card.result.totalWaitSeconds,1.5);
});

test("one explicit vector calculation includes planning and needs no second confirmation", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.setVectorSamplingArea({selection:CATALOG_SELECTION,label:"Peru"});await h.tick();
    h.controller.request(card.id,"manual");await flush();assert.equal(card.manualRequired,false);
    assert.equal(h.submits(),1);h.elapse(2500);await h.finish();
    assert.equal(card.result.totalWaitSeconds,2.5);
    assert.equal(h.requests.filter(r=>r[0]==="plan").length,1);
    assert.equal(card.result.stages.planReused,false);
    assert.equal(card.result.stages.planningSeconds,0);
});

test("browser stages add to total and distinguish planning from submission and delivery", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    const plan=h.api.planCalculation,submit=h.api.submitCalculation;
    h.api.planCalculation=async intent=>{h.elapse(1200);return {...await plan(intent),timing:{reservationSeconds:.1,preparationSeconds:.2,nativeProcessSeconds:.7,finalizationSeconds:.1}};};
    h.api.submitCalculation=async request=>{h.elapse(300);return submit(request);};
    h.controller.calculateSelection();h.elapse(700);await h.tick();h.elapse(4000);await h.finish();
    const s=card.result.stages;
    assert.equal(s.beforePlanningSeconds,.7);assert.equal(s.planningSeconds,1.2);
    assert.equal(s.submissionSeconds,.3);assert.equal(s.afterSubmissionSeconds,4);
    assert.ok(Math.abs(s.beforePlanningSeconds+s.planningSeconds+s.beforeSubmissionSeconds+s.submissionSeconds+s.afterSubmissionSeconds-card.result.totalWaitSeconds)<1e-9);
    assert.equal(s.serverPlan.nativeProcessSeconds,.7);
    const text=node=>[node.textContent,...node.children.map(text)].join(" ");
    assert.match(text(h.view.cards.get(card.id).detailsBody),/Planning round trip: 1.200 s/);
    assert.match(text(h.view.cards.get(card.id).detailsBody),/Submission response → result displayed: 4.000 s/);
});

test("replacement total wait includes obsolete job cancellation without inheriting its start", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();h.elapse(10000);
    h.controller.setSelection(box(80));h.elapse(700);await h.tick();
    h.elapse(2300);await h.finish("cancelled");await flush();h.elapse(1000);await h.finish();
    assert.equal(card.result.totalWaitSeconds,4);
});

test("choosing vector from an empty selection immediately shows its controls without another validation", async()=>{
    const h=fixture(); await h.open();
    h.controller.setSelection(null,false); await h.tick();
    assert.equal(h.controller.state.area,null);
    assert.equal(h.view.vectorAreaControls.hidden,true);
    const area=h.view.elements.area;
    area.value="vector"; area.dispatchEvent(new Event("change"));
    assert.equal(h.view.vectorAreaControls.hidden,false);
    assert.equal(h.view.elements["edit-area"].hidden,true);
    assert.match(h.view.elements["area-description"].textContent,/Choose a polygon layer below/);
    assert.equal(h.view.cards.get(h.controller.state.statistics[0].id).run.disabled,true);
    assert.equal(h.requests.filter(request=>request[0]==="plan").length,0);
    assert.equal(h.submits(),0);
});

test("vector calculation submits on the first click and invalidates results when removed", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    const id=CATALOG_SELECTION;
    h.controller.setVectorSamplingArea({selection:id,label:"Countries · 1 of 200 features"});await h.tick();
    assert.equal(h.controller.state.areaChoice,"vector");
    assert.equal(h.view.vectorAreaControls.hidden,false);
    assert.equal(h.submits(),0);
    h.controller.request(card.id,"manual");await flush();
    assert.equal(h.submits(),1);assert.equal(card.manualRequired,false);
    h.controller.request(card.id,"manual");await flush();assert.equal(h.submits(),1);
    assert.equal(h.view.cards.get(card.id).size.hidden,true);
    assert.deepEqual(h.controller.executor.snapshot.unfinishedCalculation.calculation.area,{kind:"catalogSelection",catalogSelection:id});
    await h.finish();assert.equal(card.current,true);
    assert.equal(h.view.cards.get(card.id).size.hidden,true);
    h.controller.setSelection(null,false);
    h.controller.invalidateSamplingArea(id);assert.equal(card.current,false);assert.equal(h.controller.state.area,null);
    assert.equal(h.controller.state.areaChoice,"vector");
    assert.equal(h.view.vectorAreaControls.hidden,false);
    assert.equal(h.view.cards.get(card.id).root.classList.contains("is-previous"),true);
});
test("a new card shows calculation controls without an empty value, then displays zero and retains previous results", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    const row=h.view.cards.get(card.id);
    assert.equal(row.valueActions.hidden,true);assert.equal(row.value.textContent,"");
    assert.equal(row.status.textContent,"Ready to calculate");assert.equal(row.run.hidden,false);
    assert.equal(Boolean(row.run.disabled),false);assert.equal(row.statusRow.hidden,false);
    row.run.dispatchEvent(new Event("click"));await flush();
    assert.equal(row.valueActions.hidden,true);assert.equal(row.stop.hidden,false);
    await h.finish("ready",["0"]);
    assert.equal(row.valueActions.hidden,false);assert.equal(row.value.textContent,"0");
    assert.equal(row.copy.disabled,false);assert.equal(row.run.hidden,true);assert.equal(row.statusRow.hidden,true);
    h.controller.editStatistic(card.id,{expression:"max(a)"});
    assert.equal(row.valueActions.hidden,false);assert.equal(row.value.textContent,"0");
    assert.equal(row.root.classList.contains("is-previous"),true);assert.equal(row.copy.disabled,true);
});
test("valid edits debounce, keep formula focus, and put the value in its own card",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    const row=h.view.cards.get(card.id);row.expression.focus();
    h.controller.editStatistic(card.id,{expression:"sum(a)"});assert.equal(h.submits(),0);
    assert.equal(h.document.activeElement,row.expression);await h.tick();assert.equal(h.submits(),1);
    assert.equal(card.pending,true);await h.finish("ready",["42"]);
    assert.equal(card.current,true);assert.equal(row.value.textContent,"42");assert.equal(row.statusRow.hidden,true);
    assert.equal(row.run.hidden,true);assert.equal(h.document.activeElement,row.expression);
    h.controller.editStatistic(card.id,{expression:"bad(a)"});await h.tick();
    assert.equal(h.submits(),1);assert.equal(row.value.textContent,"42");assert.equal(row.root.classList.contains("is-previous"),true);
    assert.match(row.status.textContent,/Unknown function/);assert.equal(row.expression.getAttribute("aria-invalid"),"true");
});
test("renaming pending and completed statistics neither cancels nor recalculates",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();const calls=h.requests.length;
    h.controller.editStatistic(card.id,{label:"My summary"});await h.tick();assert.equal(h.requests.length,calls);
    await h.finish();assert.equal(card.current,true);
    h.controller.editStatistic(card.id,{label:""});await h.tick();assert.equal(h.submits(),1);assert.equal(card.current,true);
});
test("previous values are marked as being replaced during validation, planning, and calculation", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();await h.finish();
    const row=h.view.cards.get(card.id);
    h.controller.editStatistic(card.id,{expression:"sum(a)"});
    assert.equal(row.root.classList.contains("is-previous"),true);
    assert.equal(row.status.textContent,"Checking formula…");
    assert.equal(row.statusRow.hidden,false);
    assert.equal(row.value.textContent,"12.5");
    await h.tick();
    assert.equal(row.status.textContent,"Calculating…");
    await h.finish("ready",["42"]);
    assert.equal(row.root.classList.contains("is-previous"),false);
    assert.equal(row.status.textContent,"");
    assert.equal(row.statusRow.hidden,true);
    assert.equal(row.value.textContent,"42");
    h.controller.editStatistic(card.id,{expression:"bad(a)"});await h.tick();
    assert.equal(row.root.classList.contains("is-previous"),true);
    assert.equal(row.status.textContent,"Unknown function bad");
});
test("copy uses exact current values without rounding or units and never submits work", async()=>{
    const copied=[];
    const h=fixture({},new Map(),{clipboard:{writeText:async value=>copied.push(value)}});
    await h.open();const card=h.controller.state.statistics[0],row=h.view.cards.get(card.id);
    assert.equal(row.copy.hidden,true);
    h.controller.request(card.id,"manual");await flush();await h.finish("ready",["9007199254740993"]);
    card.result.row.valueType="integer";card.result.row.unit="ha";h.controller.render();
    const requests=h.requests.length;
    row.copy.dispatchEvent(new Event("click"));await flush();
    assert.deepEqual(copied,["9007199254740993"]);
    assert.equal(row.copyStatus.textContent,"Copied exact value");
    assert.equal(h.requests.length,requests);
    h.controller.editStatistic(card.id,{expression:"sum(a)"});
    assert.equal(row.copy.disabled,true);assert.equal(row.copyStatus.hidden,true);
    await h.view.copyCurrentValue(card.id);assert.equal(copied.length,1);
    await h.tick();await h.finish("ready",["0"]);
    assert.equal(row.copy.disabled,false);await h.view.copyCurrentValue(card.id);
    assert.deepEqual(copied,["9007199254740993","0"]);
    card.result.row.value=null;card.result.row.state="no_valid_data";h.controller.render();
    assert.equal(row.copy.disabled,true);await h.view.copyCurrentValue(card.id);
    assert.equal(copied.length,2);
});
test("one status region beside the value retains manual controls and non-numeric result explanations", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0],row=h.view.cards.get(card.id);
    const heading=row.root.children[0];
    assert.equal(heading.contains(row.status),true);
    assert.equal(heading.contains(row.run),true);
    assert.equal(row.expression.getAttribute("aria-describedby"),row.status.id);
    assert.equal(row.status.textContent,"Ready to calculate");
    row.run.dispatchEvent(new Event("click"));await flush();
    assert.equal(h.submits(),1);assert.equal(row.stop.hidden,false);
    await h.finish();assert.equal(row.statusRow.hidden,true);
    for (const [state,message] of [
        ["no_matches","No cells matched the condition."],
        ["no_valid_data","No valid cells in this area."],
        ["invalid_arithmetic","Undefined arithmetic; no numeric result."],
        ["overflow","Numeric overflow; no finite result."],
    ]) {
        card.result.row.value=null;card.result.row.state=state;h.controller.render();
        assert.equal(row.status.textContent,message);
        assert.equal(row.statusRow.hidden,false);assert.equal(row.run.hidden,true);
        assert.equal(row.copy.disabled,true);
    }
});
test("unavailable or denied clipboard access exposes exact-value details without throwing", async()=>{
    for (const clipboard of [null,{writeText:async()=>{throw Error("Denied");}}]) {
        const h=fixture({},new Map(),{clipboard});await h.open();const card=h.controller.state.statistics[0];
        h.controller.request(card.id,"manual");await flush();await h.finish();
        const row=h.view.cards.get(card.id);await h.view.copyCurrentValue(card.id);
        assert.match(row.copyStatus.textContent,/Could not copy/);
        assert.equal(row.details.open,true);assert.equal(row.copy.disabled,false);
        assert.equal(h.submits(),1);
    }
});
test("late clipboard feedback cannot label an edited, replaced, removed, or disposed value as copied", async()=>{
    for (const change of ["edit","replace","remove","dispose"]) {
        const writing=deferred();let writes=0;
        const h=fixture({},new Map(),{clipboard:{writeText:()=>{writes++;return writing.promise;}}});
        await h.open();const card=h.controller.state.statistics[0];
        h.controller.request(card.id,"manual");await flush();await h.finish();
        const row=h.view.cards.get(card.id);
        const copying=h.view.copyCurrentValue(card.id);
        await h.view.copyCurrentValue(card.id);assert.equal(writes,1);
        if (change==="remove") h.controller.removeStatistic(card.id);
        else if (change==="dispose") h.view.unbind();
        else {
            h.controller.editStatistic(card.id,{expression:"sum(a)"});
            if (change==="replace") {await h.tick();await h.finish("ready",["42"]);}
        }
        writing.resolve();await copying;
        assert.notEqual(row.copyStatus.textContent,"Copied exact value");
        if (change==="edit") assert.equal(row.copy.disabled,true);
        if (change==="replace") assert.equal(row.copy.disabled,false);
    }
});
test("one invalid formula does not block a valid peer or move values between cards",async()=>{
    const h=fixture();await h.open();h.controller.addStatistic("count");
    const [first,second]=h.controller.state.statistics;
    h.controller.editStatistic(first.id,{expression:"bad(a)"});await h.tick();
    assert.equal(h.submits(),1);assert.equal(first.valid,false);assert.equal(second.pending,true);
    await h.finish("ready",["7"]);assert.equal(first.result,null);assert.equal(second.result.row.value,"7");
});
test("dirty statistics sharing a source use one scan; different sources run sequentially",async()=>{
    const h=fixture();await h.open();h.controller.setAutomatic(false);h.controller.addStatistic("count");await h.tick();
    h.controller.setAutomatic(true);const [a,b]=h.controller.state.statistics;
    h.controller.editStatistic(a.id,{expression:"max(a)"});h.controller.editStatistic(b.id,{expression:"count(a > 2)"});await h.tick();
    assert.equal(h.submits(),1);assert.equal(h.controller.executor.snapshot.unfinishedCalculation.calculation.calculations.length,2);
    await h.finish("ready",["22","8"]);assert.equal(a.result.row.value,"22");assert.equal(b.result.row.value,"8");
    h.controller.editStatistic(a.id,{expression:"min(a)"});h.controller.editStatistic(b.id,{source:resistance});await h.tick();
    assert.equal(h.submits(),2);await h.finish();assert.equal(h.submits(),3);
    assert.equal(h.controller.executor.snapshot.unfinishedCalculation.calculation.source.itemId,"resistance");await h.finish();
});
test("duplicate statistic names are valid and are not sent in one duplicate-label request",async()=>{
    const h=fixture();await h.open();h.controller.setAutomatic(false);h.controller.addStatistic("mean");await h.tick();
    for(const card of h.controller.state.statistics) h.controller.request(card.id,"manual");await flush();
    assert.equal(h.controller.executor.snapshot.unfinishedCalculation.calculation.calculations.length,1);await h.finish();assert.equal(h.submits(),2);await h.finish();
});
test("edits cancel obsolete work and wait for terminal cancellation before replacement",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();await h.finish("ready",["10"]);
    h.controller.editStatistic(card.id,{expression:"max(a)"});await h.tick();
    h.controller.editStatistic(card.id,{expression:"min(a)"});await h.tick();
    assert.equal(h.submits(),2);assert.equal(h.requests.filter(r=>r[0]==="cancel").length,1);
    await h.finish("ready",["999"]);assert.equal(card.result.row.value,"10");assert.equal(h.submits(),3);
    await h.finish("ready",["2"]);assert.equal(card.result.row.value,"2");assert.equal(card.current,true);
});
test("late validation cannot enqueue a superseded edit or a removed statistic",async()=>{
    const response=deferred();const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.api.validateCalculation=()=>response.promise;
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();
    h.controller.removeStatistic(card.id);response.resolve({valid:true});await flush();assert.equal(h.submits(),0);
    assert.equal(h.controller.state.statistics.length,0);h.controller.undoRemove();assert.equal(h.controller.state.statistics[0].expression,"sum(a)");
});
test("removing an earlier card preserves peer DOM, value, and formula identity; Undo restores it",async()=>{
    const h=fixture();await h.open();h.controller.addStatistic("count");await h.tick();await h.finish("ready",["7"]);
    const [a,b]=h.controller.state.statistics;const row=h.view.cards.get(b.id);
    const removed=h.view.cards.get(a.id);
    assert.equal(removed.root.children.includes(removed.remove),true);
    assert.equal(removed.remove.children[0].textContent,"Remove this calculation");
    removed.remove.dispatchEvent(new Event("click"));
    assert.equal(h.view.cards.get(b.id),row);assert.equal(row.value.textContent,"7");
    h.controller.undoRemove();assert.equal(h.controller.state.statistics[0].id,a.id);assert.equal(h.view.cards.get(b.id),row);
});
test("manual mode waits for Calculate and accepted manual jobs survive navigation",async()=>{
    const h=fixture();await h.open();h.controller.setAutomatic(false);const card=h.controller.state.statistics[0];
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();h.controller.calculateSelection();await h.tick();assert.equal(h.submits(),0);
    h.controller.request(card.id,"manual");h.controller.request(card.id,"manual");await flush();assert.equal(h.submits(),1);
    h.controller.setActive(false);assert.equal(h.requests.filter(r=>r[0]==="cancel").length,0);await h.finish();assert.equal(card.current,true);
});
test("automatic work pauses on navigation and does not restart merely on return",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();h.controller.setActive(false);await flush();
    assert.equal(h.requests.filter(r=>r[0]==="cancel").length,1);await h.finish("cancelled");
    h.controller.setActive(true);await h.tick();assert.equal(h.submits(),1);
});
test("large and explicit-area jobs require manual confirmation before submission",async()=>{
    assert.equal(canAutomaticallyCalculate({grid},{area:box(77)}),true);
    assert.equal(canAutomaticallyCalculate({grid:{...grid,decodedBytes:128*1024*1024}},{area:box(77)}),false);
    assert.equal(canAutomaticallyCalculate({grid},{area:{kind:"wholeRaster"}}),false);
    const h=fixture();await h.open();h.controller.chooseArea("whole");await h.tick();const card=h.controller.state.statistics[0];
    assert.equal(h.submits(),0);assert.equal(card.manualRequired,true);assert.equal(h.view.cards.get(card.id).run.hidden,false);
    h.controller.request(card.id,"manual");await flush();assert.equal(h.submits(),1);await h.finish();assert.equal(card.current,true);
});
test("a failed rerun cannot be mistaken for the prior successful job with the same formula",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];h.controller.request(card.id,"manual");await flush();await h.finish();
    h.controller.request(card.id,"manual");await flush();await h.finish("failed");
    assert.match(card.message,/Scan failed/);assert.equal(card.error,true);assert.equal(card.current,false);assert.equal(h.view.cards.get(card.id).run.hidden,false);assert.equal(h.submits(),2);
});
test("uncertain submissions retain the same request identity during recovery",async()=>{
    const h=fixture();await h.open();const original=h.api.submitCalculation;let failed=false;
    h.api.submitCalculation=async submission=>{if(!failed){failed=true;h.requests.push(["uncertain",submission]);throw Error("Connection lost");}return original(submission);};
    const card=h.controller.state.statistics[0];h.controller.request(card.id,"manual");await flush();
    assert.equal(h.controller.state.recoverable,true);const request=h.requests.find(r=>r[0]==="uncertain")[1].requestId;
    h.view.handlers.onRetry();await flush();assert.equal(h.requests.find(r=>r[0]==="submit")[1].requestId,request);
    await h.finish();assert.equal(card.current,true);
    assert.equal(card.result.stages,undefined);
});
test("exports retain exact integers, null explanations, source, and immutable formula context",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];h.controller.request(card.id,"manual");await flush();await h.finish();
    card.result.row={...card.result.row,value:"9007199254740993",valueType:"integer"};h.controller.render();
    const row=h.view.cards.get(card.id);assert.equal(row.value.textContent,BigInt("9007199254740993").toLocaleString());
    const text=node=>[node.textContent,...node.children.map(text)].join(" ");assert.match(text(row.detailsBody),/Human footprint/);
    assert.match(text(row.detailsBody),/mean\(a\)/);assert.match(row.detailsBody.children.at(-1).children[0].href,/\/result$/);
    card.result.row={...card.result.row,value:null,state:"no_valid_data"};h.controller.render();assert.equal(row.value.textContent,"—");assert.match(text(row.detailsBody),/No valid cells/);
});

test("an accepted manual scan continues in history when Explore changes the shared area",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();h.controller.setActive(false);h.controller.setSelection(box(80));
    assert.equal(h.requests.filter(r=>r[0]==="cancel").length,0);await h.finish();
    assert.equal(card.current,false);assert.equal(h.controller.state.jobs[0].status,"ready");
    h.controller.setActive(true);await h.tick();assert.equal(h.submits(),1);
});
test("clearing a queued automatic request prevents a later validation from running on return",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.editStatistic(card.id,{expression:"sum(a)"});h.controller.setActive(false);await h.tick();
    h.controller.setActive(true);await h.tick();assert.equal(h.submits(),0);assert.equal(card.valid,true);
});
test("metadata from an obsolete formula is released before planning its replacement",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];const response=deferred();
    const original=h.api.planCalculation;let first=true;
    h.api.planCalculation=async intent=>{const plan=await original(intent);if(first){first=false;await response.promise;}return plan;};
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();
    h.controller.editStatistic(card.id,{expression:"max(a)"});await h.tick();assert.equal(h.submits(),0);
    response.resolve();await flush();assert.equal(h.submits(),1);assert.equal(h.controller.executor.snapshot.unfinishedCalculation.calculation.calculations[0].expression,"max(a)");
    const operations=h.requests.map(r=>r[0]);assert.ok(operations.indexOf("discard")<operations.lastIndexOf("plan"));
});
test("unused-plan release failure pauses other automatic cards until an explicit retry",async()=>{
    const h=fixture();await h.open();h.controller.setAutomatic(false);h.controller.addStatistic("count");await h.tick();
    const [a,b]=h.controller.state.statistics;h.controller.setAutomatic(true);
    h.controller.chooseArea("whole");await h.tick();
    h.api.discardPlan=async()=>{throw Error("Release failed");};
    h.controller.chooseArea("selection");await h.tick();assert.equal(h.submits(),0);
    assert.equal(h.controller.executor.snapshot.admission,"retry");assert.equal(a.error,true);
    h.api.discardPlan=async()=>{};h.controller.request(b.id,"manual");await flush();assert.equal(h.submits(),1);
});

test("inspected history refreshes a running job without rewriting the editable cards",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();const jobId=h.controller.executor.snapshot.currentJob.jobId;
    h.controller.inspect(jobId);assert.equal(h.controller.state.saved.status,"running");
    await h.finish();assert.equal(h.controller.state.saved.status,"ready");assert.equal(h.controller.state.statistics[0],card);
    await h.controller.executor.jobAction(jobId,"delete");await flush();assert.equal(h.controller.state.saved,null);
});
test("reload recovers a manual job into its card without admitting another calculation",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();const id=h.controller.executor.snapshot.currentJob.jobId;h.controller.destroy();
    const restored=fixture({listJobs:async()=>[...h.server.values()],getJob:async id=>h.server.get(id)},h.data);
    await restored.controller.start();assert.equal(restored.submits(),0);assert.equal(restored.controller.executor.snapshot.currentJob.jobId,id);
    const old=h.server.get(id);h.server.set(id,{...old,status:"ready",result:{url:"/api/processing/jobs/"+id+"/result",provenanceUrl:"/api/processing/jobs/"+id+"/provenance",rows:[{...old.calculations[0],value:"9",valueType:"float",state:"ok",aggregates:[]}]}});
    await restored.jobs.refresh();await flush();assert.equal(restored.controller.state.statistics[0].result.row.value,"9");assert.equal(restored.submits(),0);
    assert.equal(restored.controller.state.statistics[0].result.totalWaitSeconds,undefined);
});
test("reload cancels recovered automatic work and never resumes sampling on its own",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();const id=h.controller.executor.snapshot.currentJob.jobId;h.controller.destroy();
    const restored=fixture({listJobs:async()=>[...h.server.values()],getJob:async id=>h.server.get(id),cancelJob:async id=>{const job={...h.server.get(id),status:"cancelled"};h.server.set(id,job);return job;}},h.data);
    await restored.controller.start();await flush();await restored.jobs.refresh();await flush();
    assert.equal(h.server.get(id).status,"cancelled");assert.equal(restored.submits(),0);assert.equal(restored.controller.state.statistics[0].result,null);
});

test("the summary rechecks automatic size policy when a plan expires before submission", async () => {
    const h = fixture(); await h.open();
    const originalPlan = h.api.planCalculation;
    let plans = 0;
    h.api.planCalculation = async calculation => {
        const plan = await originalPlan(calculation);
        return ++plans === 1 ? plan : { ...plan, grid: { ...grid, nativeBlocks: 1000 } };
    };
    const submit = h.controller.executor.submit.bind(h.controller.executor);
    let first = true;
    h.controller.executor.submit = (id, context) => {
        if (first) { first = false; h.controller.executor.snapshot.plan.expiresAt = "2000-01-01"; }
        submit(id, context);
    };
    h.controller.calculateSelection(); await h.tick();
    const card = h.controller.state.statistics[0];
    assert.equal(plans, 2);
    assert.equal(h.submits(), 0);
    assert.equal(card.manualRequired, true);
    h.controller.request(card.id, "manual"); await flush();
    assert.equal(plans, 2, "confirmation reuses the refreshed plan");
    assert.equal(h.submits(), 1);
});

test("the summary cancels a recovered automatic submission whose response was lost", async () => {
    const h = fixture(); await h.open();
    const submit = h.api.submitCalculation;
    h.api.submitCalculation = async request => { await submit(request); throw Error("Response lost"); };
    h.controller.calculateSelection(); await h.tick();
    const saved = JSON.parse([...h.data.values()][0]);
    assert.ok(saved.pending);
    assert.equal(saved.automatic, true);
    assert.equal(saved.cancelRequested, false);
    h.controller.destroy();
    const submissions = [];
    const restored = fixture({
        listJobs: async () => [...h.server.values()], getJob: async id => h.server.get(id),
        submitCalculation: async request => { submissions.push(request); return h.server.get(saved.pending.planId); },
        cancelJob: async id => {
            const record = JSON.parse([...h.data.values()][0]);
            assert.equal(record.cancelRequested, true, "the UI persists cancellation before transport");
            const job = { ...h.server.get(id), status: "cancelled" }; h.server.set(id, job); return job;
        },
    }, h.data);
    await restored.controller.start(); await flush(); await restored.jobs.refresh(); await flush();
    assert.deepEqual(submissions, [saved.pending]);
    assert.equal(h.server.get(saved.pending.planId).status, "cancelled");
    assert.equal(restored.controller.state.statistics[0].result, null);
});

test("batch tuning invalidates the result without running, persists on repeats, and can return to legacy", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();await h.finish();
    const input=h.view.extra["chunk-pixels"];
    input.value="65536";input.dispatchEvent(new Event("change"));await flush();
    assert.equal(card.current,false);assert.equal(card.plan,null);assert.equal(h.submits(),1);
    assert.equal(card.valid,true);assert.equal(h.view.cards.get(card.id).root.classList.contains("is-previous"),true);
    h.controller.request(card.id,"manual");await flush();
    assert.equal(h.controller.executor.snapshot.unfinishedCalculation.calculation.targetChunkPixels,65536);
    await h.finish();
    h.controller.setSelection(box(78));await h.tick();
    assert.equal(h.controller.executor.snapshot.unfinishedCalculation.calculation.targetChunkPixels,65536);
    await h.finish();
    input.value="";input.dispatchEvent(new Event("change"));await flush();
    h.controller.request(card.id,"manual");await flush();
    assert.equal(h.controller.executor.snapshot.unfinishedCalculation.calculation.targetChunkPixels,undefined);
    assert.equal(h.requests.filter(r=>r[0]==="plan").at(-1)[1].targetChunkPixels,undefined);
});

test("recovery preserves accepted batch settings without another submission",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.setChunkPixels(262144);h.controller.request(card.id,"manual");await flush();
    const id=h.controller.executor.snapshot.currentJob.jobId;h.controller.destroy();
    const restored=fixture({listJobs:async()=>[...h.server.values()],getJob:async id=>h.server.get(id)},h.data);
    await restored.controller.start();
    assert.equal(restored.submits(),0);assert.equal(restored.controller.executor.snapshot.currentJob.jobId,id);
    assert.equal(restored.controller.state.targetChunkPixels,262144);
    assert.equal(restored.view.extra["chunk-pixels"].value,"262144");
    assert.equal(restored.controller.executor.snapshot.unfinishedCalculation.calculation.targetChunkPixels,262144);
});

test("changing batch size cancels obsolete work and waits before the next explicit calculation",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.setChunkPixels(65536);h.controller.request(card.id,"manual");await flush();
    const oldIntent=h.controller.executor.snapshot.unfinishedCalculation.calculation;
    h.controller.setChunkPixels(262144);await flush();
    assert.equal(oldIntent.targetChunkPixels,65536);assert.ok(h.requests.some(r=>r[0]==="cancel"));
    h.controller.request(card.id,"manual");await flush();assert.equal(h.submits(),1);
    await h.finish("cancelled");await flush();
    assert.equal(h.submits(),2);assert.equal(h.controller.executor.snapshot.unfinishedCalculation.calculation.targetChunkPixels,262144);
});

test("performance details retain measured timings and source-work units in cards and history",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();await h.finish();
    const execution={targetChunkPixels:65536,readWidth:512,readHeight:128,evaluationWidth:512,evaluationHeight:128,readWindows:1};
    const performance={execution,readWindows:1,evaluationTiles:1,reducerUpdates:1,readSeconds:.125,calculationSeconds:.25,resultWriteSeconds:.01,kernelSeconds:.6};
    const job=card.result.job;
    card.result.job={...job,grid:{...job.grid,execution,estimatedMemoryBytes:150*1024**2},result:{...job.result,performance}};
    const root=h.document.createElement("div");h.view.renderValueDetails(root,card.result);
    const text=node=>[node.textContent,...node.children.map(text)].join(" ");
    assert.match(text(root),/4 native blocks in 1 reads/);
    assert.match(text(root),/Kernel elapsed: 0.600 s/);
    assert.match(text(root),/Queueing, worker startup/);
    h.controller.state.saved = card.result.job;
    h.controller.render();
    assert.match(text(h.view.elements.result),/Read\/decode and source mask: 0.125 s/);
});
