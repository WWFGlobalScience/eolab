import test from "node:test";
import assert from "node:assert/strict";
import { csvFormat, csvParse } from "d3";
import { RasterSeriesController } from "../../src/raster/series.js";
import { RasterSeriesCalculations } from "../../src/processing/raster-series-calculations.js";
import { CalculationRequests } from "../../src/processing/calculation-requests.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";

const DATASET = {key: '["eolab-temporal-datasets","weather"]', collectionId: "eolab-temporal-datasets", itemId: "weather", label: "Weather"};
const AREA = {kind: "selectedArea", selectedBounds: {west: -64, south: -5, east: -62, north: -3}};
const ORDINARY = {key: "raster", label: "Raster", item: {collection: "catalog", id: "raster"}, visible: true};

/** Drain asynchronous request and observer callbacks without advancing browser timers.
 * @return {Promise<void>} Queued lifecycle callbacks have settled.
 */
const flush = async () => { for (let index = 0; index < 120; index++) await Promise.resolve(); };

/** Connect the real stack controller and execution lifecycle to a controlled server.
 * @param {Object} [options={}] Controlled source metadata and retained server/browser state.
 * @param {Map<string,Object>} [options.server] Jobs retained across reload.
 * @param {Map<string,string>} [options.saved] Browser recovery records retained across reload.
 * @param {Object<string,Object>} [options.variables] Admitted Catalog variable metadata.
 * @return {Object} User actions, captured API requests and explicit server completion.
 */
function fixture({server = new Map(), saved = new Map(), variables = {
    temperature: {description: "Temperature", unit: "K", "eolab:time_support": "instantaneous"},
}} = {}) {
    const submitted = [], cancelled = [], downloads = [], discovery = [], timers = new Map();
    let serial = 0;
    const clock = {setTimeout(callback, delay) { const id = ++serial; timers.set(id, {callback, delay}); return id; },
        clearTimeout(id) { timers.delete(id); }};
    const api = {
        async discoverModels() { discovery.push("models"); return [{id: "temporal-raster-stack", version: "1.0.0", definitionSha256: "a".repeat(64)}]; },
        async submitCalculation(submission) {
            submitted.push(submission);
            const job = {jobId: String(++serial).padStart(32, "0"), requestId: submission.requestId,
                operation: submission.kind === "temporal" ? "model.run.v1" : "raster.aggregate.v1", status: "running",
                progress: submission.kind === "temporal"
                    ? {phase: "summarizing", description: "Calculating each observation", completed: 0, total: 3, unit: "blocks"}
                    : {phase: "calculating", completedBlocks: 0, totalBlocks: 3}, result: null};
            server.set(job.jobId, job); return job;
        },
        async listJobs() { return [...server.values()]; },
        async getJob(id) { return server.get(id); },
        async readJobStatuses(ids) { return {jobs: ids.map(id => server.get(id)), unavailableJobIds: []}; },
        async cancelJob(id) { cancelled.push(id); const job = {...server.get(id), status: "cancelling"}; server.set(id, job); return job; },
        async readTemporalStackRows(job) { downloads.push(job.jobId); return job.csvResult; },
    };
    const storage = new CalculationSessionStorage({get length() { return saved.size; }, key: index => [...saved.keys()][index] ?? null,
        getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)});
    const jobs = new ProcessingJobs(api, clock);
    const requests = new CalculationRequests({api, jobs, storage, requestId: () => "request-" + String(++serial).padStart(16, "0")});
    const calculations = new RasterSeriesCalculations({requests, api, clock});
    const view = {bind(actions) { this.actions = actions; }, render(state) { this.state = state; }, downloadCsv(csv) { this.csv = csv; }};
    const controller = new RasterSeriesController({view, areaStatistics: calculations, onClose() {}, onEditArea() {},
        async getTemporalItem(source) {
            discovery.push(source.itemId);
            return {collection: source.collectionId, id: source.itemId, properties: {title: "Weather", "cube:variables": variables}};
        },
    });
    controller.updateAvailableRasters([ORDINARY], [DATASET]); controller.setArea(AREA, "Selected box");
    /** Advance scheduled input edits without running status-poll timers.
     * @return {Promise<void>} Input dispatch and its lifecycle callbacks have settled.
     */
    const tick = async () => { for (const [id, timer] of [...timers]) if (timer.delay <= 700) { timers.delete(id); timer.callback(); } await flush(); };
    const finish = async (id, status, csvResult = null) => {
        server.set(id, {...server.get(id), status, csvResult, result: status === "ready" ? {kind: "timeSeries"} : null});
        await jobs.refresh(); await flush();
    };
    const close = () => { calculations.destroy(); requests.destroy(); jobs.destroy(); };
    return {controller, view, calculations, api, submitted, cancelled, downloads, discovery, server, saved, tick, finish, close};
}

test("accepting a vector area automatically calculates its complete temporal period", async () => {
    const h = fixture();
    try {
        await h.controller.chooseTimeRange(DATASET.key);
        h.view.actions.onTemporalEdit({periodMode: "month", startTime: "2000-01-01T00:00", endTime: "2000-02-01T00:00"});
        h.view.actions.onArea("vector");
        h.controller.updateSamplingForPanelVisibility(true);
        h.controller.setVectorSamplingArea({selection: CATALOG_SELECTION, label: "Selected counties"});
        await h.tick();
        assert.equal(h.submitted.length, 1);
        assert.equal(h.calculations.hasCapturedInputs, true);
        assert.deepEqual(h.submitted[0].area, {kind: "catalogSelection", catalogSelection: CATALOG_SELECTION});
    } finally { h.close(); }
});

test("a temporal request restores its period, formulas and result after reload without resubmitting", async () => {
    const h = fixture();
    await h.controller.chooseTimeRange(DATASET.key);
    h.view.actions.onTemporalEdit({periodMode: "month", startTime: "2000-01-01T00:00", endTime: "2000-02-01T00:00"}); h.controller.updateSamplingForPanelVisibility(true);
    h.view.actions.onRetry(); await flush();
    const job = [...h.server.values()][0];
    h.close();
    const restored = fixture(h);
    const starting = restored.controller.start();
    restored.controller.setArea(null, "No map area during startup");
    restored.controller.updateAvailableRasters([ORDINARY], [DATASET]);
    await starting;
    assert.equal(restored.view.state.temporal.datasetKey, DATASET.key);
    assert.equal(restored.view.state.temporal.datasets.length, 1);
    assert.equal(restored.view.state.temporal.variable, "temperature");
    assert.equal(restored.view.state.temporal.startTime, "2000-01-01T00:00:00.000");
    assert.deepEqual(restored.view.state.area.area,AREA,"an empty startup map cannot replace the recovered calculation's area");
    restored.controller.updateSamplingForPanelVisibility(true); await restored.tick();
    restored.controller.setArea(null,"No map area while another view loads"); await restored.tick();
    assert.deepEqual(restored.view.state.area.area,AREA,"passive map refresh does not invalidate an active calculation's committed area");
    assert.equal(restored.submitted.length, 0);
    assert.equal(restored.cancelled.length, 0);
    const observations = [{time: "2000-01-01T00:00:00Z", rows: [{label: "stat-1", value: "298.5", state: "ok", unit: "K"}]}];
    await restored.finish(job.jobId, "ready", {observations, csv: "time_utc,calculation,value\n2000-01-01T00:00:00Z,stat-1,298.5"});
    assert.equal(restored.view.state.rows[0].value, 298.5);
    assert.deepEqual(restored.calculations.temporalSource,h.submitted[0].source,"retained raster-layer choices do not change a captured interval");
    const snapshot = {key: "restored-weather-view", label: "Weather snapshot", visible: true,
        source: {...DATASET, variable: "temperature", time: "2000-01-01T00:00:00Z"}};
    restored.controller.updateAvailableRasters([ORDINARY, snapshot, {...snapshot, key: "another-weather-view"}], [DATASET]);
    assert.deepEqual(restored.view.state.sources.filter(source => source.rangeSelected).map(source => source.key),
        [snapshot.key], "a recovered dataset identifies one switchable range even without a saved map-view key");
    await restored.controller.chooseTimeRange(null);
    assert.equal(restored.view.state.temporal, undefined);
    assert.equal(restored.submitted.length, 0, "turning off the recovered range does not start another temporal job");
    restored.close();
});

test("temporal stack automatically samples one period and axis edits reuse its exact values", async () => {
    const h = fixture();
    try {
        await h.controller.chooseTimeRange(DATASET.key);
        assert.equal(h.view.state.temporal.startTime, "", "availability does not select a period");
        h.view.actions.onTemporalEdit({periodMode: "month", startTime: "2000-01-01T00:00", endTime: "2000-02-01T00:00"});
        h.controller.setPosition({longitude: -63, latitude: -4});
        h.view.actions.onAddFormula("pixel"); h.view.actions.onAddFormula("custom");
        h.view.actions.onEditFormula(3, {expression: "pixelValue(a) - mean(a)"});
        h.controller.updateSamplingForPanelVisibility(true); await h.tick();
        assert.equal(h.submitted.length, 1);
        const request = h.submitted[0], job = [...h.server.values()][0];
        assert.equal(h.view.state.message, "Calculating each observation · 0 of 3 blocks");
        assert.deepEqual(h.view.state.workProgress, job.progress);
        h.server.set(job.jobId, {...job, progress: {...job.progress, completed: 2}});
        await h.finish(job.jobId, "running");
        assert.equal(h.view.state.message, "Calculating each observation · 2 of 3 blocks");
        assert.equal(h.view.state.workProgress.completed, 2);
        assert.equal(h.view.state.workProgress.total, 3);
        assert.deepEqual(request.source, {collectionId: DATASET.collectionId, itemId: DATASET.itemId, variable: "temperature",
            startTime: "2000-01-01T00:00:00.000Z", endTime: "2000-02-01T00:00:00.000Z"});
        assert.deepEqual(request.area, AREA);
        assert.deepEqual(request.pixelPoint, {longitude: -63, latitude: -4});
        assert.deepEqual(request.calculations.map(({expression}) => expression), ["mean(a)", "pixelValue(a)", "pixelValue(a) - mean(a)"]);
        const observations = [0, 1, 6].map(hour => ({time: `2000-01-01T${String(hour).padStart(2, "0")}:00:00+00:00`,
            rows: request.calculations.map((formula, index) => ({...formula, value: hour === 1 && index === 0 ? null : "298.1234567890123456",
                valueType: "float", unit: "", state: hour === 1 && index === 0 ? "no_valid_data" : "ok", aggregates: []}))}));
        const csv = csvFormat(observations.flatMap(observation => observation.rows.map(row => ({time_utc: observation.time,
            interval_start_utc: "", interval_end_utc: "", variable: request.source.variable, calculation: row.label,
            expression: row.expression, value: row.value, value_type: row.valueType, unit: row.unit, state: row.state,
            aggregates: JSON.stringify(row.aggregates)}))));
        await h.finish(job.jobId, "ready", {observations, csv});
        assert.equal(h.view.state.workProgress, null);
        assert.deepEqual(h.view.state.statistics[0].rows.map(row => row.xValue), observations.map(row => Date.parse(row.time)));
        assert.equal(h.view.state.rows.length, 9);
        assert.equal(h.view.state.statistics[0].rows[1].state, "no_valid_data");
        assert.equal(h.view.state.statistics[0].rows[1].value, null);
        assert.equal(h.view.state.statistics[0].rows[0].rawValue, "298.1234567890123456");
        assert.match(h.view.state.statistics[0].rows[0].label, /UTC$/);
        assert.equal(csvParse(h.controller.exportCsv())[0].calculation, "Mean");
        const reads = h.discovery.length;
        h.view.actions.onChartType("scatter"); h.view.actions.onAddPlot();
        h.view.actions.onStatisticDisplay(1, {plotId: 2, visible: false});
        h.view.actions.onPlotOptions(2, {scale: "log", bounds: [1, 1000], xBounds: [Date.UTC(2000,0,1), Date.UTC(2000,0,1,3)]});
        h.view.actions.onEditFormula(1, {label: "Average"});
        h.view.actions.onStatisticDisplay(1, {color: "#ff0000"});
        h.view.actions.onPlotOptions(2, {pointSize: 3, xTickCount: 4, yTickCount: 6, axisFontSize: 12});
        h.controller.updateAvailableRasters([{...ORDINARY, visible: false}], [{...DATASET, time: "2001-06-01T00:00:00Z"}]);
        h.view.actions.onDownload(); await h.tick();
        const exported = csvParse(h.view.csv), original = csvParse(csv);
        const names = {"stat-1": "Average", "stat-2": "Pixel value", "stat-3": "Custom"};
        assert.deepEqual(exported.columns, original.columns);
        assert.deepEqual([...exported], original.map(row => ({...row, calculation: names[row.calculation]})),
            "download uses the edited statistic names while preserving every other field, including exact decimal text");
        assert.equal(h.view.state.temporal.startTime, "2000-01-01T00:00");
        assert.equal(h.submitted.length, 1);
        assert.deepEqual(h.downloads, [job.jobId]);
        assert.equal(h.discovery.length, reads);
        await h.controller.loadTemporalItem();
        assert.deepEqual(h.view.state.rows, [], "explicit refresh releases the completed plot for a new calculation");
        await h.tick();
        assert.equal(h.submitted.length, 2);
        assert.deepEqual(h.submitted[1].source, request.source, "the same logical interval can be recalculated after refresh");
        await h.finish([...h.server.values()][1].jobId, "ready", {observations, csv});
        h.view.actions.onAddFormula("sum");
        assert.deepEqual(h.view.state.rows, [], "new formulas cannot be joined to the old result rows");
        assert.equal(h.view.state.canDownload, false);
        h.view.actions.onEditFormula(1, {expression: "max(a)"});
        await h.tick();
        assert.equal(h.submitted.length, 3, "formula replacement automatically uses the latest expression");
    } finally { h.close(); }
});

test("failed temporal downloads retry the completed job and discard a cancelled late CSV", async () => {
    const h = fixture();
    try {
        await h.controller.chooseTimeRange(DATASET.key);
        h.view.actions.onTemporalEdit({periodMode: "month", startTime: "2000-01-01T00:00", endTime: "2000-02-01T00:00"}); h.controller.updateSamplingForPanelVisibility(true);
        h.view.actions.onRetry(); await flush();
        const job = [...h.server.values()][0];
        const result = {csv: "time_utc,calculation,value\n2000-01-01T00:00:00Z,stat-1,12\n",
            observations: [{time: "2000-01-01T00:00:00Z", rows: [{label: "stat-1", expression: "mean(a)",
                value: "12", valueType: "float", unit: "", state: "ok", aggregates: []}]}]};
        let attempts = 0, release, downloadSignal;
        const lateResponse = new Promise(resolve => { release = resolve; });
        h.api.readTemporalStackRows = async (_, signal) => {
            attempts++;
            if (attempts === 1) throw new Error("Download interrupted");
            if (attempts === 2) { downloadSignal = signal; return lateResponse; }
            return result;
        };
        await h.finish(job.jobId, "ready", result);
        assert.match(h.view.state.message, /Download interrupted/);
        h.view.actions.onRetry(); await flush();
        assert.equal(attempts, 2);
        assert.equal(h.submitted.length, 1);
        h.view.actions.onCancel();
        assert.equal(downloadSignal.aborted, true);
        release(result); await flush();
        assert.deepEqual(h.view.state.rows, []);
        assert.equal(h.view.state.canDownload, false);
        h.view.actions.onRetry(); await flush();
        assert.equal(attempts, 3);
        assert.equal(h.submitted.length, 1, "retrying a CSV never resubmits its calculation");
        assert.equal(h.view.state.rows[0].rawValue, "12");
        assert.deepEqual([...csvParse(h.controller.exportCsv())], [{time_utc: "2000-01-01T00:00:00Z", calculation: "Mean", value: "12"}]);
    } finally { h.close(); }
});

test("replacing a temporal slice cancels obsolete work; closing keeps the explicit calculation running", async () => {
    const h = fixture();
    try {
        await h.controller.chooseTimeRange(DATASET.key);
        h.view.actions.onTemporalEdit({periodMode: "month", startTime: "2000-01-01T00:00", endTime: "2000-02-01T00:00"}); h.controller.updateSamplingForPanelVisibility(true);
        h.view.actions.onRetry(); await flush();
        const first = [...h.server.values()][0];
        h.view.actions.onPlotOptions(1,{scale:"linear",bounds:[270,310],xBounds:null});
        h.view.actions.onOrder("map","reverse"); await h.tick();
        assert.equal(h.submitted.length,1,"axis edits do not replace a pending calculation");
        assert.deepEqual(h.cancelled,[]);
        h.view.actions.onTemporalEdit({periodMode: "times", startTime: "2000-01-01T01:00", endTime: "2000-01-01T07:00"});
        await h.tick();
        assert.deepEqual(h.cancelled, [first.jobId]);
        assert.equal(h.submitted.length, 1);
        await h.finish(first.jobId, "cancelled");
        h.view.actions.onRetry(); await flush();
        assert.equal(h.submitted.length, 2);
        assert.equal(h.submitted[1].source.startTime, "2000-01-01T01:00:00.000Z");
        const second = [...h.server.values()][1];
        h.controller.updateSamplingForPanelVisibility(false); await flush();
        assert.deepEqual(h.cancelled, [first.jobId]);
        h.controller.updateSamplingForPanelVisibility(true); await h.tick();
        assert.equal(h.submitted.length, 2);
        await h.controller.chooseTimeRange(null); await h.tick();
        assert.deepEqual(h.cancelled, [first.jobId, second.jobId]);
        await h.finish(second.jobId, "cancelled");
        assert.equal(h.submitted.length, 3, "ordinary raster selection retains automatic calculation");
        assert.equal(h.submitted[2].source.itemId, "raster");
        assert.equal(h.submitted[2].kind, undefined);
    } finally { h.close(); }
});

test("named temporal views supply their variables and retain ordinary multi-raster choices", async () => {
    const h = fixture({variables: {
        temperature: {description: "Temperature", unit: "K", "eolab:time_support": "instantaneous"},
        pressure: {description: "Pressure", unit: "Pa", "eolab:time_support": "instantaneous"},
    }});
    const snapshot = {key: "pressure-view", label: "Weather - Pressure", sourceName: "Weather - Pressure", item: null, visible: true,
        source: {...DATASET, variable: "pressure", time: "2000-01-01T00:00:00Z"}};
    const independent = {...snapshot, key: "other-view", label: "Other pressure view", visible: false};
    try {
        h.controller.updateAvailableRasters([ORDINARY, snapshot, independent], [DATASET]);
        h.view.actions.onSelect(independent.key, true);
        h.controller.selectSource(snapshot.source, undefined, snapshot.key);
        h.view.actions.onSelect(ORDINARY.key, true);
        h.view.actions.onSelect(independent.key, true);
        await h.controller.chooseTimeRange(snapshot.key);
        assert.equal(h.view.state.temporal.datasetKey, DATASET.key);
        assert.equal(h.view.state.temporal.variable, "pressure", "the named view supplies the initial variable despite multiple variables");
        assert.equal(h.view.state.temporal.startTime, "2000-01-01T00:00", "the selected view supplies its initial month");
        assert.equal(h.view.state.temporal.endTime, "2000-02-01T00:00");
        assert.deepEqual(h.view.state.sources.map(source => source.selected), [true, true, true],
            "range mode preserves the ordinary checklist choices while the view disables them");
        assert.equal(h.view.state.sources.find(source => source.key === snapshot.key).rangeSelected, true);
        assert.equal(h.view.state.sources.find(source => source.key === independent.key).rangeSelected, false);
        assert.equal(h.view.state.temporal.variableBound, true);
        h.view.actions.onTemporalEdit({periodMode: "times", startTime: "2000-01-03T01:00", endTime: "2000-01-03T02:00"});
        await flush();
        h.controller.updateAvailableRasters([ORDINARY, {...snapshot, source: {...snapshot.source,
            variable: "pressure", time: "2000-02-01T00:00:00Z"}}, independent], [DATASET]);
        assert.equal(h.view.state.temporal.variable, "pressure");
        assert.equal(h.view.state.temporal.startTime, "2000-01-03T01:00");
        await h.tick();
        assert.equal(h.submitted.length, 0, "an inactive panel does not start new work");
        await h.controller.chooseTimeRange(null);
        assert.equal(h.view.state.temporal, undefined);
        assert.deepEqual(h.view.state.sources.filter(source => source.selected).map(source => source.key),
            [ORDINARY.key, snapshot.key, independent.key], "the ordinary mixed-view checklist survives the range intent");
        await h.controller.chooseTimeRange(snapshot.key);
        assert.equal(h.view.state.temporal.variable, "pressure", "returning to a named view uses its variable");
        assert.equal(h.view.state.temporal.endTime, "2000-01-03T02:00");
        const metadataReads = h.discovery.filter(entry => typeof entry === "string").length;
        await h.controller.chooseTimeRange(independent.key);
        assert.equal(h.view.state.temporal.variable, "pressure", "explicitly choosing another view uses its displayed variable");
        assert.equal(h.view.state.temporal.startTime, "2000-01-03T01:00", "the analysis period survives an explicit view choice");
        assert.equal(h.discovery.filter(entry => typeof entry === "string").length, metadataReads,
            "another view of the same dataset reuses its loaded Catalog metadata");
    } finally { h.close(); }
});

test("a named retained dataset offers a range without a displayed or published snapshot", async () => {
    const h = fixture();
    try {
        h.controller.updateAvailableRasters([], [DATASET]);
        assert.deepEqual(h.view.state.sources, [{...DATASET, hasSnapshot: false, selected: false,
            temporalDatasetKey: DATASET.key, rangeSelected: false}]);
        await h.controller.chooseTimeRange(DATASET.key);
        assert.equal(h.view.state.temporal.variable, "temperature");
        assert.equal(h.view.state.sources[0].rangeSelected, true);
        assert.equal(h.view.state.temporal.startTime, "");
        h.controller.updateSamplingForPanelVisibility(true); await h.tick();
        assert.equal(h.submitted.length, 0);
        h.controller.updateAvailableRasters([], []);
        assert.equal(h.view.state.temporal, undefined, "removing the active dataset returns to individual raster selection");
    } finally { h.close(); }
});

test("a second named view can replace a range choice while its Catalog metadata is loading", async () => {
    const h = fixture(), reads = [];
    const views = ["temperature", "pressure"].map(variable => ({key: variable, label: variable, visible: true,
        source: {...DATASET, variable, time: "2000-01-01T00:00:00Z"}}));
    h.controller.getTemporalItem = () => new Promise(resolve => reads.push(resolve));
    try {
        h.controller.updateAvailableRasters(views, [DATASET]);
        const first = h.controller.chooseTimeRange(views[0].key);
        const second = h.controller.chooseTimeRange(views[1].key);
        const item = {collection: DATASET.collectionId, id: DATASET.itemId, properties: {title: DATASET.label,
            "cube:variables": Object.fromEntries(views.map(view => [view.key,
                {description: view.key, unit: "", "eolab:time_support": "instantaneous"}]))}};
        reads[1](item); await second;
        reads[0](item); await first;
        assert.equal(h.view.state.temporal.variable, "pressure");
        assert.equal(h.view.state.temporal.loading, false);
        assert.equal(h.view.state.temporal.error, "");
        assert.equal(h.submitted.length, 0);
    } finally { h.close(); }
});


test("completed temporal statistics can be repeated without another run or download and keep exact CSV rows", async () => {
    const h = fixture();
    try {
        await h.controller.chooseTimeRange(DATASET.key);
        h.view.actions.onTemporalEdit({periodMode: "month", startTime: "2000-01-01T00:00", endTime: "2000-02-01T00:00"});
        h.view.actions.onAddFormula("min"); h.controller.updateSamplingForPanelVisibility(true); await h.tick();
        const job = [...h.server.values()][0], request = h.submitted[0];
        const observations = [0, 1].map(hour => ({time: `2000-01-01T0${hour}:00:00Z`,
            rows: request.calculations.map((calculation, index) => ({...calculation, value: index ? null : "298.1234567890123456",
                valueType: "float", unit: "K", state: index ? "no_valid_data" : "ok", aggregates: []}))}));
        const originalRows = observations.flatMap(observation => observation.rows.map(row => ({time_utc: observation.time,
            interval_start_utc: observation.time, interval_end_utc: observation.time, variable: request.source.variable,
            calculation: row.label, expression: row.expression, value: row.value, value_type: row.valueType, unit: row.unit,
            state: row.state, aggregates: JSON.stringify(row.aggregates)})));
        const csv = csvFormat(originalRows);
        await h.finish(job.jobId, "ready", {observations, csv});
        const captured = h.calculations.temporalResult;
        h.view.actions.onAddFormula("mean"); h.view.actions.onAddFormula("min");
        assert.equal(h.view.state.busy, false);
        assert.equal(h.view.state.rows.length, 8);
        for (const [duplicate, original] of [[2, 0], [3, 1]]) {
            assert.deepEqual(h.view.state.statistics[duplicate].rows.map(row => [row.rawValue, row.unit, row.state]),
                h.view.state.statistics[original].rows.map(row => [row.rawValue, row.unit, row.state]));
        }
        h.view.actions.onEditFormula(3, {label: "=Another mean"});
        h.view.actions.onEditFormula(4, {label: "Another minimum"});
        h.view.actions.onAddPlot(); h.view.actions.onStatisticDisplay(3, {plotId: 2, color: "#ff0000"});
        h.view.actions.onStatisticDisplay(1, {visible: false});
        assert.deepEqual(h.view.state.statistics.map(statistic => [statistic.id, statistic.label, statistic.visible, statistic.plotId, statistic.styleIndex]),
            [[1, "Mean", false, 1, 0], [2, "Minimum", true, 1, 1], [3, "=Another mean", true, 2, 2], [4, "Another minimum", true, 1, 3]]);
        const exported = csvParse(h.controller.exportCsv()), original = csvParse(csv);
        assert.deepEqual(exported.columns, original.columns);
        const names = ["Mean", "Minimum", "'=Another mean", "Another minimum"];
        assert.deepEqual([...exported], observations.flatMap(observation => names.map((calculation, index) => ({
            ...original.find(row => row.time_utc === observation.time && row.expression === request.calculations[index % 2].expression), calculation,
        }))));
        await h.tick();
        assert.equal(h.submitted.length, 1); assert.deepEqual(h.downloads, [job.jobId]); assert.deepEqual(h.cancelled, []);
        assert.equal(h.calculations.temporalResult, captured);
        assert.equal(captured.csv, csv); assert.equal(captured.calculationInputs.calculations.length, 2);
        h.view.actions.onRemoveFormula(1); await h.tick();
        assert.equal(h.submitted.length, 1);
        assert.equal(h.view.state.statistics.find(statistic => statistic.id === 3).rows[0].rawValue, "298.1234567890123456");
        assert.deepEqual([...csvParse(h.controller.exportCsv())].map(row => row.calculation),
            observations.flatMap(() => ["Minimum", "'=Another mean", "Another minimum"]));
        h.view.actions.onRemoveFormula(2); h.view.actions.onRemoveFormula(4);
        h.view.actions.onAddFormula("min"); await h.tick();
        assert.equal(h.submitted.length, 1, "an expression removed from display is still covered by the same captured result");
        assert.equal(h.view.state.statistics[1].id, 5);
        assert.deepEqual(h.view.state.statistics[1].rows.map(row => [row.rawValue, row.unit, row.state]),
            observations.map(() => [null, "K", "no_valid_data"]));
    } finally { h.close(); }
});


for (const change of ["area", "predicate", "period", "variable", "dataset", "pixel point", "refresh", "expression"]) {
    test(`captured statistic reuse stops after a changed ${change}`, async () => {
        const h = fixture({variables: {
            temperature: {description: "Temperature", unit: "K", "eolab:time_support": "instantaneous"},
            pressure: {description: "Pressure", unit: "Pa", "eolab:time_support": "instantaneous"},
        }});
        try {
            await h.controller.chooseTimeRange(DATASET.key);
            h.view.actions.onTemporalVariable("temperature");
            h.view.actions.onTemporalEdit({periodMode: "month", startTime: "2000-01-01T00:00", endTime: "2000-02-01T00:00"});
            h.controller.setPosition({longitude: -63, latitude: -4}); h.view.actions.onAddFormula("pixel");
            if (change === "predicate") h.controller.setVectorSamplingArea({selection: CATALOG_SELECTION, label: "Selected counties"});
            h.controller.updateSamplingForPanelVisibility(true); await h.tick();
            const first = [...h.server.values()][0], request = h.submitted[0];
            const observations = [{time: "2000-01-01T00:00:00Z", rows: request.calculations.map(calculation =>
                ({...calculation, value: "298.1234567890123456", valueType: "float", unit: "K", state: "ok", aggregates: []}))}];
            const csv = csvFormat(observations.flatMap(observation => observation.rows.map(row =>
                ({time_utc: observation.time, calculation: row.label, expression: row.expression, value: row.value}))));
            await h.finish(first.jobId, "ready", {observations, csv});
            h.view.actions.onAddFormula("mean"); await h.tick();
            assert.equal(h.submitted.length, 1);
            assert.equal(h.view.state.statistics[2].rows[0].rawValue, "298.1234567890123456");
            if (change === "area") h.controller.setArea({...AREA, selectedBounds: {...AREA.selectedBounds, west: -65}}, "Another box");
            if (change === "predicate") {
                const selection = structuredClone(CATALOG_SELECTION);
                selection.filter.rules[0].value = "Another county";
                h.controller.setVectorSamplingArea({selection, label: "Other counties"});
            }
            if (change === "period") h.view.actions.onTemporalEdit({periodMode: "times", startTime: "2000-01-01T01:00", endTime: "2000-02-01T00:00"});
            if (change === "variable") h.view.actions.onTemporalVariable("pressure");
            if (change === "dataset") {
                const other = {...DATASET, key: "other-weather", itemId: "other-weather"};
                h.controller.updateAvailableRasters([ORDINARY], [DATASET, other]);
                await h.controller.chooseTimeRange(other.key);
                h.view.actions.onTemporalVariable("temperature");
            }
            if (change === "pixel point") h.controller.setPosition({longitude: -62, latitude: -4});
            if (change === "refresh") await h.controller.loadTemporalItem();
            if (change === "expression") h.view.actions.onEditFormula(3, {expression: "sum(a)"});
            assert.deepEqual(h.view.state.rows, [], "old values cannot become current rows after inputs or availability change");
            assert.equal(h.view.state.canDownload, false);
            await h.tick();
            assert.equal(h.submitted.length, 2);
            const replacement = h.submitted[1];
            if (change === "area") assert.equal(replacement.area.selectedBounds.west, -65);
            if (change === "predicate") assert.equal(replacement.area.catalogSelection.filter.rules[0].value, "Another county");
            if (change === "period") assert.equal(replacement.source.startTime, "2000-01-01T01:00:00.000Z");
            if (change === "variable") assert.equal(replacement.source.variable, "pressure");
            if (change === "dataset") assert.equal(replacement.source.itemId, "other-weather");
            if (change === "pixel point") assert.equal(replacement.pixelPoint.longitude, -62);
            if (change === "refresh") assert.deepEqual(replacement.source, request.source);
            if (change === "expression") assert.equal(replacement.calculations[2].expression, "sum(a)");
        } finally { h.close(); }
    });
}
