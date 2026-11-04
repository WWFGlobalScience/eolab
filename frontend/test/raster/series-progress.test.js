import test from "node:test";
import assert from "node:assert/strict";
import { csvFormat } from "d3";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { RasterSeriesView } from "../../src/raster/series-view.js";
import { RasterSeriesController } from "../../src/raster/series.js";
import { RasterSeriesCalculations } from "../../src/processing/raster-series-calculations.js";
import { CalculationRequests } from "../../src/processing/calculation-requests.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";

/** Connect the real views, controller and shared job lifecycle to a deterministic server.
 * @return {Promise<{controller:RasterSeriesController,view:RasterSeriesView,document:FakeRasterControlDocument,jobs:ProcessingJobs,server:Map<string,Object>,submissions:Object[],attempts:Object[],downloads:string[],settle:()=>Promise<void>,tick:()=>Promise<void>,finish:(outcome:"ready"|"failed")=>Promise<void>,addPendingPlot:(preset:"max"|"min")=>Promise<void>,plot:(id:number)=>import("../../test-support/raster/fake-controls-document.js").FakeRasterControlElement,close:()=>void,loseNextSubmission:()=>void}>} Completed mean series, controlled job actions and cleanup.
 */
async function fixture() {
    const document = new FakeRasterControlDocument(), frames = new Map(), timers = new Map();
    let serial = 0, frameSerial = 0, loseNext = false;
    const createElement = document.createElement.bind(document);
    /** Preserve native className/attribute reflection in this test DOM.
     * @param {string} tag HTML element name.
     * @return {import("../../test-support/raster/fake-controls-document.js").FakeRasterControlElement} Native-like fake element.
     */
    document.createElement = tag => {
        const element = createElement(tag);
        Object.defineProperty(element, "className", {get: () => element.getAttribute("class") ?? "",
            set: value => element.setAttribute("class", value)});
        return element;
    };
    document.defaultView.ResizeObserver = class {
        /** Ignore layout observation in the deterministic DOM.
         * @param {Object} _element Observed fake control. @return {void}
         */
        observe(_element) {}
    };
    document.defaultView.requestAnimationFrame = callback => { frames.set(++frameSerial, callback); return frameSerial; };
    document.defaultView.cancelAnimationFrame = id => frames.delete(id);
    for (const id of ["order", "direction", "temporal-variable"]) {
        const label = document.createElement("label"); label.append(document.querySelector("#raster-series-" + id));
    }
    const clock = {
        /** Retain work until the test advances input timers.
         * @param {()=>void} callback Scheduled work. @param {number} delay Milliseconds. @return {number} Timer identity.
         */
        setTimeout(callback, delay) { timers.set(++serial, {callback, delay}); return serial; },
        /** Cancel a retained timer. @param {number|null|undefined} id Timer identity. @return {void} */
        clearTimeout(id) { timers.delete(id); }
    };
    const server = new Map(), saved = new Map(), submissions = [], attempts = [], downloads = [];
    const api = {
        /** Return the installed temporal model. @return {Promise<Object[]>} Discovery response. */
        async discoverModels() { return [{id: "temporal-raster-stack", version: "1.0.0", definitionSha256: "a".repeat(64)}]; },
        /** Accept an idempotent request, optionally losing its response after server admission.
         * @param {Object} submission Captured Processing request. @return {Promise<Object>} Accepted job.
         * @throws {Error} When the test simulates a lost response.
         */
        async submitCalculation(submission) {
            attempts.push(submission);
            const existing = [...server.values()].find(job => job.requestId === submission.requestId);
            if (existing) return existing;
            submissions.push(submission);
            const job = {jobId: String(++serial).padStart(32, "0"), requestId: submission.requestId,
                operation: "model.run.v1", status: "running", result: null,
                progress: {phase: "summarizing", description: "Calculating each observation", completed: 0, total: 3, unit: "blocks"}};
            server.set(job.jobId, job);
            if (loseNext) { loseNext = false; throw new Error("Submission response lost."); }
            return job;
        },
        /** Return this browser's server jobs. @return {Promise<Object[]>} Retained jobs. */
        async listJobs() { return [...server.values()]; },
        /** Read authoritative statuses for tracked jobs.
         * @param {string[]} ids Requested jobs. @return {Promise<{jobs:Object[],unavailableJobIds:string[]}>} Current statuses.
         */
        async readJobStatuses(ids) { return {jobs: ids.map(id => server.get(id)), unavailableJobIds: []}; },
        /** Acknowledge completed fixture cancellation.
         * @param {string} id Owned job. @return {Promise<Object>} Cancelled job.
         */
        async cancelJob(id) { const job = {...server.get(id), status: "cancelled"}; server.set(id, job); return job; },
        /** Return a completed job's captured observations and record its CSV read.
         * @param {Object} job Ready job. @return {Promise<{observations:Object[],csv:string}>} Captured result.
         */
        async readTemporalStackRows(job) { downloads.push(job.jobId); return job.csvResult; },
    };
    const storage = new CalculationSessionStorage({get length() { return saved.size; }, key: index => [...saved.keys()][index] ?? null,
        getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)});
    const jobs = new ProcessingJobs(api, clock), requests = new CalculationRequests({api, jobs, storage,
        requestId: () => "request-" + String(++serial).padStart(16, "0")});
    const calculations = new RasterSeriesCalculations({requests, api, clock});
    const view = new RasterSeriesView(document), controller = new RasterSeriesController({view, areaStatistics: calculations, onClose() {},
        getTemporalItem: async source => ({collection: source.collectionId, id: source.itemId,
            properties: {title: "Weather", "cube:variables": {temperature: {description: "Air temperature", unit: "K", "eolab:time_support": "instantaneous"}}}})});
    /** Drain asynchronous lifecycle callbacks and draw their final frame. @return {Promise<void>} Settled view. */
    const settle = async () => {
        for (let index = 0; index < 160; index++) await Promise.resolve();
        const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback();
    };
    /** Advance input debounce without running the status poller. @return {Promise<void>} Submitted work. */
    const tick = async () => { for (const [id, timer] of [...timers]) if (timer.delay <= 700) { timers.delete(id); timer.callback(); } await settle(); };
    /** Complete or fail the current shared temporal calculation.
     * @param {"ready"|"failed"} outcome Server result. @return {Promise<void>} Updated real view.
     */
    const finish = async outcome => {
        const job = [...server.values()].at(-1), submission = submissions.find(item => item.requestId === job.requestId);
        const observations = [0, 1, 2].map(hour => ({time: new Date(Date.UTC(2026, 6, 1, hour)).toISOString(),
            rows: submission.calculations.map((formula, index) => ({...formula, value: String(280 + hour + index),
                valueType: "float", unit: "K", state: "ok", aggregates: []}))}));
        const csv = csvFormat(observations.flatMap(observation => observation.rows.map(row => ({time_utc: observation.time,
            calculation: row.label, expression: row.expression, value: row.value, unit: row.unit, state: row.state}))));
        server.set(job.jobId, {...job, status: outcome, result: outcome === "ready" ? {kind: "timeSeries"} : null,
            error: outcome === "failed" ? {detail: "Calculation failed. Retry to try again."} : null, csvResult: {observations, csv}});
        await jobs.refresh(); await settle();
    };
    const dataset = {key: '["eolab-temporal-datasets","weather"]', collectionId: "eolab-temporal-datasets", itemId: "weather", label: "Weather"};
    controller.updateAvailableRasters([], [dataset]);
    controller.setArea({kind: "selectedArea", selectedBounds: {west: -64, south: -5, east: -62, north: -3}}, "Sampling box");
    await controller.chooseTimeRange(dataset.key);
    view.actions.onTemporalEdit({periodMode: "month", startTime: "2026-07-01T00:00", endTime: "2026-08-01T00:00"});
    controller.updateSamplingForPanelVisibility(true); await tick(); await finish("ready");
    /** Add a new statistic on its own secondary plot through the controller.
     * @param {"max"|"min"} preset Statistic choice. @return {Promise<void>} Pending replacement.
     */
    const addPendingPlot = async preset => { controller.addFormula(preset); controller.addPlot(); controller.changeStatisticDisplay(controller.formulaSerial, {plotId: controller.plotSerial}); await tick(); };
    /** Return one rendered plot's DOM boundary. @param {number} id Plot number. @return {import("../../test-support/raster/fake-controls-document.js").FakeRasterControlElement} Plot section. */
    const plot = id => view.plots.querySelectorAll("section").find(node => node.getAttribute("aria-label") === `Plot ${id}`);
    /** Detach every fixture observer and timer. @return {void} */
    const close = () => { calculations.destroy(); requests.destroy(); jobs.destroy(); };
    return {controller, view, document, jobs, server, submissions, attempts, downloads, settle, tick, finish, addPendingPlot, plot, close,
        /** Lose one accepted request's response to exercise same-job recovery. @return {void} */
        loseNextSubmission() { loseNext = true; }};
}

test("pending secondary plots show the shared job progress and complete without another action", async () => {
    const h = await fixture();
    try {
        await h.addPendingPlot("max");
        const plot2 = h.plot(2), pending = plot2.querySelector(".raster-series-pending-plot");
        assert.ok(pending, "the visible pending plot needs its own current-progress presentation");
        assert.equal(pending.hidden, false);
        assert.match(pending.querySelector("strong").textContent, /Calculating/);
        const bar = pending.querySelector("progress");
        assert.equal(bar.getAttribute("max"), "3");
        assert.equal(bar.getAttribute("value"), "0");
        assert.equal(h.view.plotProgress.classList.contains("is-summary"), true, "the shared live announcement no longer overlays the plot cards");
        const firstPoint = h.plot(1).querySelector(".series-chart-point"), scrolls = plot2.scrollRequests.length;
        h.view.actions.onPlotOptions(2, {scale: "linear", bounds: [270, 300], xBounds: null}); await h.settle();
        const focused = h.document.querySelector("#raster-series-add-plot"); focused.focus();
        const job = [...h.server.values()].at(-1);
        h.server.set(job.jobId, {...job, progress: {...job.progress, completed: 1}});
        await h.jobs.refresh(); await h.settle();
        assert.equal(bar.getAttribute("value"), "1");
        assert.equal(h.plot(1).querySelector(".series-chart-point"), firstPoint, "progress does not redraw previous results");
        assert.equal(plot2.scrollRequests.length, scrolls);
        assert.equal(h.document.activeElement, focused);
        assert.equal(h.submissions.length, 2, "one replacement job covers both plots");
        await h.finish("ready");
        assert.equal(pending.hidden, true);
        assert.ok(plot2.querySelector(".series-chart-point"));
        assert.deepEqual(h.controller.plots[1].bounds, [270, 300]);
        const counts = [h.submissions.length, h.downloads.length];
        h.view.actions.onStatisticDisplay(2, {plotId: 1}); await h.settle();
        h.view.actions.onStatisticDisplay(2, {plotId: 2}); await h.settle();
        assert.deepEqual([h.submissions.length, h.downloads.length], counts, "moving calculated values neither submits nor rereads CSV");
        await h.addPendingPlot("min");
        assert.equal(h.plot(3).querySelector(".raster-series-pending-plot").hidden, false);
    } finally { h.close(); }
});

for (const outcome of ["failed", "cancelled", "recovery"]) {
    test(`secondary-plot ${outcome} keeps the existing shared lifecycle and terminal presentation`, async () => {
        const h = await fixture();
        try {
            if (outcome === "recovery") h.loseNextSubmission();
            await h.addPendingPlot("max");
            if (outcome === "failed") await h.finish("failed");
            if (outcome === "cancelled") { h.view.actions.onCancel(); await h.settle(); }
            assert.equal(h.view.plotProgress.hidden, true);
            assert.equal(h.view.results.hidden, true, "terminal/recovery states retain the existing status presentation");
            assert.equal(h.view.status.hidden, false);
            if (outcome === "failed") {
                assert.match(h.view.status.textContent, /failed/);
                assert.equal(h.document.querySelector("#raster-series-retry").hidden, false);
            } else if (outcome === "cancelled") {
                assert.match(h.view.status.textContent, /cancelled/);
                assert.equal([...h.server.values()].at(-1).status, "cancelled");
            } else {
                assert.match(h.view.status.textContent, /Recover/);
                assert.equal(h.document.querySelector("#raster-series-recover").hidden, false);
                h.view.actions.onRecover(); await h.settle();
                assert.equal(h.server.size, 2, "recovery confirms the existing job");
                assert.equal(h.attempts.at(-1).requestId, h.attempts.at(-2).requestId);
                assert.equal(h.plot(2).querySelector(".raster-series-pending-plot").hidden, false);
                await h.finish("ready");
                assert.ok(h.plot(2).querySelector(".series-chart-point"));
            }
        } finally { h.close(); }
    });
}

test("completed NoData, errors, log exclusions, hidden statistics and unassigned plots do not become pending", async () => {
    const h = await fixture();
    try {
        h.controller.addPlot(); h.controller.changeStatisticDisplay(1, {plotId: 2}); await h.settle();
        const base = h.view.snapshot, original = base.statistics[0], row = original.rows[0];
        for (const [label, statistic, scale] of [
            ["NoData", {...original, rows: [{...row, state: "no_valid_data", value: null, rawValue: null}]}, "linear"],
            ["error", {...original, rows: [{...row, state: "error", value: null, rawValue: null}]}, "linear"],
            ["log exclusion", {...original, rows: [{...row, value: 0, rawValue: "0"}]}, "log"],
            ["hidden statistic", {...original, rows: [], visible: false}, "linear"],
            ["unassigned plot", {...original, rows: [], plotId: 1}, "linear"],
        ]) {
            h.view.plotsView.renderPlots({...base, busy: true, message: "Another statistic is calculating.",
                statistics: [statistic], plots: base.plots.map(plot => plot.id === 2 ? {...plot, scale} : plot)});
            assert.equal(h.plot(2).querySelector(".raster-series-pending-plot").hidden, true, label);
        }
    } finally { h.close(); }
});
