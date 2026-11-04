import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RasterSeriesCalculations } from "../../src/processing/raster-series-calculations.js";
import { RasterSeriesController } from "../../src/raster/series.js";
import { CalculationRequests } from "../../src/processing/calculation-requests.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingApiClient, ProcessingRequestError } from "../../src/processing/api.js";
import { VectorSamplingController } from "../../src/vector/sampling.js";
import { VectorSamplingView } from "../../src/vector/sampling-view.js";
import { VectorFilterControls } from "../../src/vector/filter-controls.js";
import { EMPTY_VECTOR_FILTER, normalizeVectorFilter } from "../../src/vector/filter.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { RasterSeriesView } from "../../src/raster/series-view.js";
import { RasterSamplingAreaControlsView } from "../../src/raster/sampling-area-controls-view.js";

/** @param {number} west Longitude. @return {Object} Valid sampling box. */
const box = west => ({kind:"selectedArea",selectedBounds:{west,south:0,east:west+1,north:1}});
/** @param {string} id Catalog item ID. @return {Object} Retained raster snapshot. */
const source = id => ({key:id,label:"Raster "+id,item:{collection:"catalog",id},visible:true});
/** @return {Promise<void>} Drain queued lifecycle callbacks. */
const flush = async () => { for (let i=0;i<120;i++) await Promise.resolve(); };
/** @return {{promise:Promise,resolve:Function,reject:Function}} Controllable transport response. */
const deferred = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };

/** Exercise independent calculation requests and their shared observer against a controlled Processing API.
 * @param {Object} [overrides={}] API fault injection.
 * @param {Map} [data=new Map()] Saved recovery record.
 * @param {(choice:string)=>void} [onAreaChoice] Composed response to a user's area choice.
 * @return {Object} Controllers, captured requests and explicit clock/job completion.
 */
function fixture(overrides = {}, data = new Map(), onAreaChoice = () => {}) {
    const requests=[],plans=new Map(),server=new Map(),timers=new Map();let serial=0,time=0;
    const clock={setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,delay,at:time+delay});return id;},clearTimeout(id){timers.delete(id);}};
    const grid={nativeBlocks:1,width:10,height:10,crs:"EPSG:4326"};
    const api={
        validateCalculation:async formulas=>{requests.push(["validate",formulas]);return {valid:true};},
        planCalculation:async intent=>{const planId=String(++serial).padStart(32,"0");requests.push(["plan",intent]);plans.set(planId,intent);return {planId,grid,expiresAt:"2099-01-01T00:00:00Z"};},
        discardPlan:async id=>{requests.push(["discard",id]);},
        submitCalculation:async submission=>{
            requests.push(["submit",submission]);
            const existing=[...server.values()].find(job=>job.requestId===submission.requestId); if(existing)return existing;
            const intent=submission.planId ? plans.get(submission.planId) : submission;
            const job={jobId:submission.planId ?? String(++serial).padStart(32,"0"),requestId:submission.requestId,operation:"raster.aggregate.v1",status:"running",progress:{phase:"calculating",completedBlocks:0,totalBlocks:1},grid,
                calculations:intent.calculations,sources:{a:intent.source},result:null};
            server.set(job.jobId,job);return job;
        },
        listJobs:async()=>[...server.values()],getJob:async id=>server.get(id),
        cancelJob:async id=>{requests.push(["cancel",id]);const job={...server.get(id),status:"cancelling"};server.set(id,job);return job;},
        /** @param {string[]} ids Requested IDs. @return {Promise<Object>} Owned statuses. */
        async readJobStatuses(ids) {
            const records = await this.listJobs();
            return {jobs: records.filter(job => ids.includes(job.jobId)),
                unavailableJobIds: ids.filter(id => !records.some(job => job.jobId === id))};
        },
        ...overrides,
    };
    const storage=new CalculationSessionStorage({get length(){return data.size;},key:index=>[...data.keys()][index]??null,
        getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)});
    const jobs=new ProcessingJobs(api,clock);
    const calculationRequests=new CalculationRequests({api,jobs,storage,requestId:()=>"request-"+String(++serial).padStart(16,"0")});
    const area=new RasterSeriesCalculations({requests:calculationRequests,clock});
    const view={bind(actions){this.actions=actions;},render(state){this.state=state;},downloadCsv(csv){this.csv=csv;}};
    const controller=new RasterSeriesController({view,areaStatistics:area,onClose(){},onEditArea(){},onAreaChoice});
    controller.updateAvailableRasters([source("1"),source("2")]); controller.setArea(box(0),"First box");
    const tick=async(delay=0)=>{for(const[id,t]of [...timers])if(t.delay===delay){timers.delete(id);t.fn();}await flush();};
    /** Advance the browser clock and execute only callbacks whose deadlines passed.
     * @param {number} milliseconds Elapsed time. @return {Promise<void>} Settled lifecycle callbacks.
     */
    const advance=async milliseconds=>{time+=milliseconds;for(const[id,t]of [...timers])if(t.at<=time){timers.delete(id);t.fn();}await flush();};
    const finish=async(status="ready",cacheHit=false,itemId=null)=>{
        const old=[...server.values()].find(job=>["running","cancelling","queued"].includes(job.status) && (!itemId || job.sources.a.itemId===itemId));
        assert.ok(old,"an active job exists");
        time+=100;
        server.set(old.jobId,{...old,status,result:status==="ready"?{cacheHit,rows:old.calculations.map((row,i)=>({...row,value:i?"22":"-123.4567890123456789",unit:row.expression.startsWith("areaha")?"ha":null,state:"ok",valueType:"float",aggregates:[]}))}:null,error:status==="failed"?{detail:"Raster unavailable"}:null});
        await jobs.refresh();await flush();return old.jobId;
    };
    const open=async()=>{controller.updateSamplingForPanelVisibility(true);await tick();};
    const close=()=>{area.destroy();calculationRequests.destroy();jobs.destroy();};
    return {api,calculationRequests,jobs,storage,data,area,controller,view,requests,plans,server,grid,tick,advance,finish,open,close};
}

/** Bind production stack entry points to the real controller/execution boundary.
 * @param {Object} h Raster stack harness.
 * @param {Object|null} [area=null] Area already published through composition.
 * @return {Map<string,Function>} Click callbacks for the existing HTML controls.
 */
function stackOpeners(h, area = null) {
    const main = readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
    const start = main.indexOf('for (const id of ["open-raster-series",');
    const end = main.indexOf("    const vectorTimeSeries", start);
    assert.ok(start >= 0 && end > start, "Production stack entry points are present");
    const callbacks = new Map();
    new Function("document", "mapInspection", "rasterSeries", "rasterSeriesArea", main.slice(start, end))({
        querySelector: id => ({ addEventListener: (_, callback) => callbacks.set(id, callback) }),
    }, { showRasterSeries: () => h.controller.updateSamplingForPanelVisibility(true) }, h.controller, area);
    return callbacks;
}

test("normal stack openers preserve a deliberate whole-raster choice through background area changes", async () => {
    for (const id of ["open-raster-series", "open-raster-series-dock"]) {
        const h = fixture(); h.controller.chooseArea("whole"); h.controller.setArea(box(10), "Background map selection");
        stackOpeners(h, box(10)).get(`#${id}`)(); await h.tick();
        assert.equal(h.view.state.area.areaChoice, "whole");
        assert.ok(h.requests.filter(([kind]) => kind === "submit").every(([, intent]) => intent.area.kind === "wholeRaster"));
        h.close();
    }
});

test("layer and histogram actions select one hidden source and preserve the requested area", async () => {
    const h = fixture();
    const selected = {collectionId: "catalog", itemId: "hidden", label: "Hidden raster"};
    h.controller.chooseArea("whole");
    h.controller.selectSource(selected); h.controller.updateSamplingForPanelVisibility(true); h.view.actions.onRetry(); await flush();
    const first = h.requests.find(([kind]) => kind === "submit")[1];
    assert.deepEqual(first.source, selected); assert.deepEqual(first.area, {kind: "wholeRaster"});
    h.controller.selectSource(selected, box(10)); await flush();
    assert.equal(h.requests.filter(([kind]) => kind === "cancel").length, 1);
    await h.finish("cancelled"); h.view.actions.onRetry(); await flush();
    assert.deepEqual(h.requests.filter(([kind]) => kind === "submit").at(-1)[1].area, box(10));
    assert.equal(h.view.state.area.sources.length, 1);
    h.close();
});

test("a histogram source selects an existing view without adding another statistics input", async () => {
    const h = fixture();
    const first = {...source("1"), key: "local:view:first", label: "First view"};
    const second = {...source("1"), key: "local:view:second", label: "Second view"};
    h.controller.updateAvailableRasters([first, second]);

    h.controller.selectSource({collectionId: "catalog", itemId: "1", label: "Second view"}, undefined, second.key);
    h.controller.updateSamplingForPanelVisibility(true); h.view.actions.onRetry(); await flush();

    assert.deepEqual(h.controller.sources.map(item => item.key), [first.key, second.key]);
    assert.deepEqual([...h.controller.selectedKeys], [second.key]);
    const submissions = h.requests.filter(([kind]) => kind === "submit");
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0][1].source.itemId, "1");
    assert.equal(submissions[0][1].source.label, "Second view");
    h.close();
});


test("changing a live snapshot replaces automatic work under its retained view key", async () => {
    const h = fixture();
    const snapshot = {key: "weather-view", visible: true, label: "Temperature at 00:00",
        source: {collectionId: "eolab-temporal-datasets", itemId: "weather", variable: "temperature", time: "2000-01-01T00:00:00Z"}};
    try {
        h.controller.updateAvailableRasters([snapshot]); await h.open();
        h.controller.updateAvailableRasters([{...snapshot, label: "Temperature at 01:00",
            source: {...snapshot.source, time: "2000-01-01T01:00:00Z"}}]);
        await h.tick();
        assert.equal(h.requests.filter(([kind]) => kind === "cancel").length, 1);
        await h.finish("cancelled"); await h.tick(); await flush();
        const submissions = h.requests.filter(([kind]) => kind === "submit");
        assert.equal(submissions.length, 2);
        assert.equal(submissions[1][1].source.time, "2000-01-01T01:00:00Z");
        assert.deepEqual([...h.controller.selectedKeys], [snapshot.key]);
    } finally { h.close(); }
});

test("catalog, upload and drawing selections preserve captured background work when invalidated", async () => {
    for (const info of [{selection: CATALOG_SELECTION},
        {selection: {uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", layerName: "basins", filter: CATALOG_SELECTION.filter}},
        {polygonArea: {id: "a".repeat(32), sha256: "b".repeat(64)}}]) {
        const h = fixture(); h.controller.updateSamplingForPanelVisibility(true);
        h.view.actions.onArea("vector");
        h.controller.setVectorSelectionState({phase: "reading", explicit: false, sequence: 1});
        assert.equal(h.view.state.area.area, null);
        h.controller.setVectorSamplingArea({...info, label: "Reviewed polygons"});
        h.view.actions.onRetry(); await flush();
        const expected = info.polygonArea ? {kind: "polygonArea", polygonArea: info.polygonArea}
            : {kind: "catalogSelection", catalogSelection: info.selection};
        assert.deepEqual(h.requests.filter(([kind]) => kind === "submit").map(([, request]) => request.area), [expected, expected]);
        h.controller.updateSamplingForPanelVisibility(false);
        h.controller.setVectorSelectionState({phase: "reading", explicit: false, sequence: 2});
        assert.deepEqual(h.area.area, expected, "passive selection progress preserves hidden explicit inputs");
        assert.equal(h.requests.filter(([kind]) => kind === "cancel").length, 0);
        h.controller.invalidateArea(expected); await flush();
        assert.equal(h.requests.filter(([kind]) => kind === "cancel").length, 0);
        await h.finish(); await h.finish();
        assert.equal(h.area.results.size, 2, "results retain the polygons captured when Calculate was chosen");
        h.close();
    }
});

test("invalidating the active automatic vector area cancels its work and ignores late results", async () => {
    const h = fixture();
    h.view.actions.onArea("vector");
    h.controller.setVectorSamplingArea({selection: CATALOG_SELECTION, label: "Selected countries"});
    await h.open();
    h.controller.invalidateArea({kind: "catalogSelection", catalogSelection: CATALOG_SELECTION});
    await flush();
    assert.equal(h.requests.filter(([kind]) => kind === "cancel").length, 2);
    await h.finish(); await h.finish();
    assert.equal(h.area.results.size, 0);
    h.close();
});

test("accepting polygon features automatically starts recoverable background work", async () => {
    const choices = [];
    const h = fixture({}, new Map(), choice => choices.push(choice));
    h.view.actions.onArea("vector");
    await h.open();
    assert.equal(h.requests.length, 0, "choosing Vector waits for its selected features");
    h.controller.setVectorSamplingArea({selection: CATALOG_SELECTION, label: "Selected counties"});
    await h.tick();
    assert.equal(h.requests.filter(([kind]) => kind === "submit").length, 2);
    assert.equal(h.area.hasCapturedInputs, true, "all submitted calculations survive closing the panel");
    h.view.actions.onArea("vector");
    assert.equal(h.view.state.area.area, null, "retrying Vector clears the previous selected features");
    assert.deepEqual(choices, ["vector", "vector"]);
    h.close();
});

test("changing area mode cancels polygon selection and ignores its late reply", async () => {
    const read = deferred();
    let sampling, signal;
    const h = fixture({}, new Map(), choice => {
        if (choice === "vector") void sampling.use();
        else sampling.invalidate("Selection cancelled");
    });
    sampling = new VectorSamplingController({
        view: {bind() {}, render() {}, unbind() {}},
        getTargets: () => [{key: "counties", label: "Counties", item: CATALOG_SELECTION, filter: CATALOG_SELECTION.filter}],
        createArea: async (_item, _filter, requestedSignal) => { signal = requestedSignal; return read.promise; },
        onActivate: area => h.controller.setVectorSamplingArea({selection: area.selection, label: area.label}),
        onInvalidate: selection => h.controller.invalidateArea({kind: "catalogSelection", catalogSelection: selection}),
        onEditFilter() {},
    });
    h.view.actions.onArea("vector"); await h.open();
    h.view.actions.onArea("whole"); await h.tick();
    assert.equal(signal.aborted, true);
    read.resolve({selection: CATALOG_SELECTION, label: "Counties", matched: 2, total: 10,
        bbox: [-120, 30, -70, 50], filter: CATALOG_SELECTION.filter});
    await flush(); await h.tick();
    assert.equal(h.view.state.area.areaChoice, "whole");
    const submissions = h.requests.filter(([kind]) => kind === "submit");
    assert.equal(submissions.length, 2);
    assert.ok(submissions.every(([, request]) => request.area.kind === "wholeRaster"));
    sampling.destroy(); h.close();
});


test("standard deviation submits the population formula per raster and retains results in series CSV", async () => {
    const h = fixture(); h.controller.addFormula("stdev"); await h.open();
    const submissions = h.requests.filter(([kind]) => kind === "submit");
    assert.equal(submissions.length, 2);
    for (const [, request] of submissions) assert.equal(request.calculations[1].expression, "stdev(a)");
    await h.finish(); await h.finish("ready", true);
    const statistic = h.view.state.statistics.find(row => row.expression === "stdev(a)");
    assert.equal(statistic.label, "Standard deviation");
    assert.deepEqual(statistic.rows.map(row => row.rawValue), ["22", "22"]);
    assert.match(h.controller.exportCsv(), /"Standard deviation","stdev\(a\)"/);
    h.close();
});

test("explicit calculations keep their sources, point and area while hidden and recover finished peers after reload", async () => {
    const h = fixture();

    h.controller.addFormula("pixel");
    h.controller.setPosition({longitude: 0.5, latitude: 0.5});
    await h.open();
    assert.equal(h.requests.filter(([kind]) => kind === "submit").length, 2);
    h.view.actions.onCancel(); await flush();
    await h.finish("cancelled"); await h.finish("cancelled");
    h.view.actions.onRetry(); await flush();
    await h.finish("ready", false, "1");
    h.controller.updateSamplingForPanelVisibility(false);
    h.controller.setArea(box(10), "Another map box");
    h.controller.setVectorSamplingArea({selection: CATALOG_SELECTION, label: "A different polygon area"});
    h.controller.setVectorSelectionState({phase: "reading", explicit: false, sequence: 1});
    h.controller.setPosition({longitude: 10.5, latitude: 0.5});
    h.controller.updateAvailableRasters([source("3")]);
    await flush();
    assert.equal(h.requests.filter(([kind]) => kind === "cancel").length, 2, "only the earlier automatic jobs were cancelled");
    assert.deepEqual(h.area.area, box(0));
    assert.deepEqual(h.area.sources.map(source => source.key), ["1", "2"]);
    assert.equal(h.data.size, 2, "finished and unfinished requests are retained together");
    h.close();
    const restored = fixture(h.api, h.data);
    await restored.controller.start(); await flush();
    assert.deepEqual(restored.controller.formulas.map(formula => formula.expression), ["mean(a)", "pixelValue(a)"]);
    assert.deepEqual(restored.area.pixelPoint, {longitude: 0.5, latitude: 0.5});
    assert.equal(restored.area.results.size, 1);
    assert.equal(restored.area.pending.size, 1);
    assert.equal(h.requests.filter(([kind]) => kind === "submit").length, 4, "reload observes existing jobs");
    await h.finish("ready", false, "2");
    await restored.jobs.refresh(); await flush();
    assert.equal(restored.area.complete, true);
    assert.equal(restored.view.state.rows.filter(row => row.state === "value").length, 4);
    restored.view.actions.onCancel(); await flush();
    assert.equal(h.data.size, 0);
    await restored.open();
    restored.controller.setArea(box(20), "New area after recovery"); await restored.tick();
    assert.equal(h.requests.filter(([kind]) => kind === "submit").length, 6, "new edits calculate automatically after recovery");
    restored.close();
});

test("retrying a failed raster keeps the successful peer's saved result", async () => {
    const h = fixture(); h.controller.updateSamplingForPanelVisibility(true);
    h.view.actions.onRetry(); await flush();
    await h.finish("ready", false, "1"); await h.finish("failed", false, "2");
    h.view.actions.onRetry(); await flush();
    assert.equal(h.requests.filter(([kind]) => kind === "submit").length, 3);
    const records = [...h.data.values()].map(value => JSON.parse(value));
    assert.deepEqual(records.map(record => record.intent.source.itemId).sort(), ["1", "2"]);
    h.close();
});

test("formulas share one job per source, retain exact scalar/unit CSV, and presentation edits do not recalculate",async()=>{
    const h=fixture();h.controller.addFormula("area");await h.open();
    assert.equal(h.requests.filter(([k])=>k==="submit").length,2);
    assert.equal(h.requests.find(([k])=>k==="submit")[1].calculations.length,2);
    await h.finish();await h.finish("ready",true);
    assert.equal(h.area.complete,true);
    assert.equal(h.requests.filter(([k])=>k==="submit").length,2);
    const before=h.requests.length;
    h.view.actions.onOrder("name","reverse");
    h.view.actions.onChartType("scatter");
    h.controller.editFormula(1,{label:"Renamed"});
    h.view.actions.onAddPlot();
    h.view.actions.onStatisticDisplay(2, {plotId:2});
    h.view.actions.onPlotOptions(2,{scale:"log",bounds:[1,30],xBounds:null});
    h.view.actions.onStatisticDisplay(1, {visible:false});
    assert.deepEqual(h.view.state.plots.map(({id,scale})=>({id,scale})),[{id:1,scale:"linear"},{id:2,scale:"log"}]);
    assert.deepEqual(h.view.state.statistics.map(row=>[row.id,row.visible,row.plotId,row.styleIndex]),[[1,false,1,0],[2,true,2,1]]);
    assert.deepEqual(h.view.state.statistics[1].rows.map(row=>[row.rawValue,row.unit]),[["22","ha"],["22","ha"]]);
    assert.equal(h.view.state.rows.length,4,"table retains hidden statistics");
    h.view.actions.onRemovePlot(2);
    h.view.actions.onRemovePlot(1);
    assert.deepEqual(h.view.state.plots.map(({id,scale})=>({id,scale})),[{id:1,scale:"linear"}]);
    assert.equal(h.view.state.statistics[1].plotId,1);
    const csv=h.controller.exportCsv();
    assert.match(csv,/"-123.4567890123456789"/);
    assert.match(csv,/"Renamed","mean\(a\)"/);
    assert.match(csv,/"area"/);
    assert.match(csv,/"job_id"/);
    assert.equal(h.requests.length,before);
    h.close();
});





test("rapid area changes cancel submitted work and never mix old-area rows",async()=>{
    const h=fixture();await h.open();await h.finish();await h.finish();
    h.controller.setArea(box(10),"Second");await h.tick();
    assert.ok(h.view.state.previousRows);assert.equal(h.view.state.rows.some(row=>row.state==="value"),false);
    h.controller.setArea(box(20),"Third");await h.tick();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,2);
    await h.finish("cancelled");await h.finish("cancelled");await flush();
    const planned=h.requests.filter(([kind])=>kind==="submit").at(-1)[1];
    assert.equal(planned.area.selectedBounds.west,20);
    await h.finish();await h.finish();
    assert.equal(h.area.results.size,2);
    for(const result of h.area.results.values())assert.equal(result.calculationInputs.area.selectedBounds.west,20);
    h.close();
});

test("committed areas submit on the next turn and coalesce synchronous replacements",async()=>{
    const h=fixture();await h.open();await h.finish();await h.finish();
    h.controller.setArea(box(10),"Second");
    h.controller.setArea(box(20),"Latest");
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2,"dispatch waits until the current event completes");
    await h.advance(0);
    const replacements=h.requests.filter(([kind])=>kind==="submit").slice(2);
    assert.equal(replacements.length,2);
    assert.ok(replacements.every(([,request])=>request.area.selectedBounds.west===20));
    await h.finish();await h.finish();
    await h.advance(700);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,4,"no stale delayed submission follows");
    h.close();
});

test("opening area statistics and changing selected rasters require no editing pause",async()=>{
    const h=fixture();h.controller.updateSamplingForPanelVisibility(true);
    assert.equal(h.requests.length,0);
    await h.advance(0);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
    await h.finish();await h.finish();
    h.controller.selectRaster("2",false);await h.advance(0);
    const submissions=h.requests.filter(([kind])=>kind==="submit");
    assert.equal(submissions.length,3);
    assert.equal(submissions.at(-1)[1].source.itemId,"1");
    h.close();
});


test("formula typing waits 700 ms after the latest expression and submits only that expression",async()=>{
    const h=fixture();await h.open();await h.finish();await h.finish();
    h.controller.editFormula(1,{expression:"mean(a)+1"});
    await h.advance(699);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
    h.controller.editFormula(1,{expression:"mean(a)+2"});
    await h.advance(699);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2,"the later edit restarts the pause");
    await h.advance(1);
    const replacements=h.requests.filter(([kind])=>kind==="submit").slice(2);
    assert.equal(replacements.length,2);
    assert.ok(replacements.every(([,request])=>request.calculations[0].expression==="mean(a)+2"));
    await h.finish();await h.finish();
    h.close();
});

for(const action of ["hide","cancel"]) {
    test(`${action} before the next turn prevents a committed-area submission`,async()=>{
        const h=fixture();await h.open();await h.finish();await h.finish();
        h.controller.setArea(box(10),"Pending");
        if(action==="hide")h.controller.updateSamplingForPanelVisibility(false);
        else h.area.cancelRemainingRasters();
        await h.advance(0);await h.advance(1000);
        assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
        assert.equal(h.area.pending.size,0);
        h.close();
    });
}

test("hiding and reopening raster statistics keeps the same submitted work running",async()=>{
    const h=fixture();await h.open();h.controller.updateSamplingForPanelVisibility(false);await flush();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,0);
    h.controller.updateSamplingForPanelVisibility(true); await h.tick();
    await h.finish();await h.finish();
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
    assert.equal(h.area.results.size,2);h.close();
});

test("retained raster visibility refreshes stack defaults and subsequent map-click calculations", async () => {
    const h = fixture();
    const rasters = Array.from({ length: 6 }, (_, index) => source(String(index + 1)));
    h.controller.updateAvailableRasters(rasters.map(raster => ({ ...raster, visible: false })));
    assert.equal(h.area.sources.length, 0, "hide-all clears untouched default choices");
    h.controller.updateAvailableRasters(rasters.map((raster, index) => ({ ...raster, visible: index < 3 })));
    h.controller.addFormula("pixel");
    h.controller.setPosition({ longitude: 1, latitude: 2 });
    await h.open();
    assert.deepEqual(h.area.sources.map(raster => raster.key), ["1", "2", "3"]);
    for (const raster of rasters.slice(0, 3)) await h.finish("ready", false, raster.key);

    h.controller.updateAvailableRasters(rasters);
    await h.advance(0);
    assert.deepEqual(h.view.state.sources.filter(raster => raster.selected).map(raster => raster.key),
        rasters.map(raster => raster.key));
    assert.deepEqual(h.area.sources.map(raster => raster.key), rasters.map(raster => raster.key));
    for (const raster of rasters) await h.finish("ready", false, raster.key);
    assert.equal(h.area.results.size, 6);

    h.controller.setPosition({ longitude: 3, latitude: 4 });
    h.controller.setArea(box(10), "Second clicked area");
    await h.advance(0);
    const replacements = h.requests.filter(([kind]) => kind === "submit").slice(-6);
    assert.deepEqual(replacements.map(([, request]) => request.source.itemId), rasters.map(raster => raster.key));
    assert.ok(replacements.every(([, request]) => request.pixelPoint.longitude === 3 &&
        request.pixelPoint.latitude === 4 && request.area.selectedBounds.west === 10));
    for (const raster of rasters) await h.finish("ready", false, raster.key);
    assert.equal(h.view.state.rows.length, 12, "both formulas have values for all six rasters");
    h.close();
});

test("explicit raster choices survive visibility, rename, reorder, clicks and panel switches", async () => {
    const h = fixture();
    h.controller.updateAvailableRasters([source("1"), source("2"), { ...source("hidden"), visible: false }]);
    h.view.actions.onSelect("1", false);
    h.view.actions.onSelect("hidden", true);
    h.controller.updateAvailableRasters([
        { ...source("hidden"), label: "Renamed hidden raster", visible: false },
        { ...source("2"), visible: false }, source("1"), source("new"),
    ]);
    assert.deepEqual(h.controller.orderedSources().map(raster => raster.key), ["hidden", "new"]);
    h.controller.setPosition({ longitude: 5, latitude: 6 });
    await h.open();
    assert.deepEqual(h.area.sources.map(raster => raster.key), ["hidden", "new"]);
    await h.finish("ready", false, "hidden"); await h.finish("ready", false, "new");
    h.controller.updateSamplingForPanelVisibility(false);
    h.controller.updateAvailableRasters([source("1"), source("2"), source("hidden"), source("new")]);
    h.controller.setPosition({ longitude: 7, latitude: 8 });
    await h.open();
    assert.deepEqual(h.area.sources.map(raster => raster.key), ["hidden", "new"], "opening preserves the captured calculation");
    h.view.actions.onSelect("2",true); await h.tick();
    assert.deepEqual(h.area.sources.map(raster => raster.key), ["2", "hidden", "new"]);
    assert.equal(h.view.state.sources.find(raster => raster.key === "1").selected, false);
    h.close();
});

test("removing a source clears its checklist override and re-adding uses current visibility", () => {
    const h = fixture();
    h.view.actions.onSelect("1", false);
    h.view.actions.onSelect("2", true);
    h.controller.updateAvailableRasters([]);
    h.controller.updateAvailableRasters([source("1"), { ...source("2"), visible: false }]);
    assert.deepEqual(h.controller.orderedSources().map(raster => raster.key), ["1"]);
    assert.equal(h.requests.length, 0, "source changes in an inactive panel submit no work");
    h.close();
});

test("visibility replacement cancels old jobs and ignores their late values", async () => {
    const h = fixture(); await h.open();
    h.controller.updateAvailableRasters([
        { ...source("1"), visible: false }, { ...source("2"), visible: false }, source("3"),
    ]);
    await h.advance(0);
    assert.equal(h.requests.filter(([kind]) => kind === "cancel").length, 2);
    assert.deepEqual(h.area.sources.map(raster => raster.key), ["3"]);
    await h.finish("ready", false, "1"); await h.finish("ready", false, "2");
    assert.equal(h.area.results.size, 0, "late hidden-source values cannot become current results");
    await h.finish("ready", false, "3");
    assert.deepEqual(h.view.state.rows.map(row => row.key), ["3"]);
    h.close();
});

test("source removal cancels older work and hidden rasters may be explicitly selected",async()=>{
    const h=fixture();await h.open();
    h.controller.updateAvailableRasters([{...source("hidden"),visible:false}]);await h.advance(0);
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,2);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2,"hidden sources start unchecked");
    assert.match(h.view.state.message,/Select at least one raster/);
    await h.finish("cancelled");await h.finish("cancelled");
    h.view.actions.onSelect("hidden",true);await h.advance(0);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").at(-1)[1].source.itemId,"hidden");
    await h.finish();
    assert.deepEqual(h.view.state.rows.map(row=>row.key),["hidden"]);
    h.close();
});

test("completed series CSV escapes spreadsheet text and reopening reuses its results",async()=>{
    const h=fixture();
    h.controller.updateAvailableRasters([{...source("1"),label:'=SUM(1,2) "test"'}]);
    await h.open();await h.finish();
    const requests=h.requests.length;
    h.controller.updateSamplingForPanelVisibility(false);await h.open();
    assert.equal(h.requests.length,requests);
    const csv=h.controller.exportCsv();
    assert.ok(csv.includes('"\'=SUM(1,2) ""test"""'));
    assert.ok(csv.includes('"-123.4567890123456789"'));
    assert.match(csv,/"catalog","1"/);
    h.close();
});

test("Pixel value uses the same jobs as area formulas and captures the exact clicked point",async()=>{
    const h=fixture();
    h.controller.setPosition({longitude:0.123456789,latitude:0.87654321});
    h.controller.addFormula("pixel");await h.open();
    const submissions=h.requests.filter(([kind])=>kind==="submit").map(([,value])=>value);
    assert.equal(submissions.length,2,"one job per raster contains both formulas");
    assert.ok(submissions.every(value=>value.calculations[1].expression==="pixelValue(a)"));
    assert.deepEqual(submissions.map(value=>value.pixelPoint),[
        {longitude:0.123456789,latitude:0.87654321},{longitude:0.123456789,latitude:0.87654321}]);
    await h.finish();await h.finish();
    assert.equal(h.view.state.statistics[1].label,"Pixel value");
    assert.match(h.controller.exportCsv(),/""longitude"":0\.123456789,""latitude"":0\.87654321/);
    h.close();
});

test("changing the click affects pixel formulas but leaves unchanged area-only work cached",async()=>{
    const h=fixture();h.controller.chooseArea("whole");await h.open();await h.finish();await h.finish();
    h.controller.setPosition({longitude:1,latitude:2});await h.advance(0);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
    assert.ok(h.requests.filter(([kind])=>kind==="submit").every(([,value])=>!Object.hasOwn(value,"pixelPoint")));
    h.controller.editFormula(1,{expression:"pixelValue(a)"});await h.advance(700);
    h.controller.setPosition({longitude:3,latitude:4});await h.advance(0);
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,2);
    await h.finish("cancelled");await h.finish("cancelled");await flush();
    const replacements=h.requests.filter(([kind])=>kind==="submit").slice(-2);
    assert.ok(replacements.every(([,value])=>value.pixelPoint.longitude===3&&value.pixelPoint.latitude===4));
    assert.ok(h.view.state.rows.every(row=>row.state!=="value"),"old-point responses cannot become current values");
    await h.finish();await h.finish();
    h.close();
});

test("pixel formulas explain missing clicks and clear invalid map coordinates",async()=>{
    const h=fixture();h.controller.editFormula(1,{expression:"pixelValue(a)"});await h.open();
    assert.equal(h.requests.length,0);
    assert.match(h.view.state.message,/Click the map.*pixelValue/);
    h.controller.setPosition({longitude:1,latitude:2});await h.advance(0);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
    h.controller.setPosition({longitude:200,latitude:2});await h.advance(0);
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,2);
    assert.match(h.view.state.message,/Click the map.*pixelValue/);
    await h.finish("cancelled");await h.finish("cancelled");
    assert.equal(h.area.results.size,0);
    h.close();
});

test("per-raster failure leaves a gap and proceeds to the next raster",async()=>{
    const h=fixture();await h.open();await h.finish("failed");await h.finish();
    assert.equal(h.area.complete,true);
    assert.equal(h.view.state.rows[0].state,"error");
    assert.equal(h.view.state.rows[1].state,"value");
    assert.match(h.controller.exportCsv(),/Raster unavailable/);h.close();
});

test("uncertain submissions recover with their original key",async()=>{
    const h=fixture();const submit=h.api.submitCalculation;let lost=true;
    h.api.submitCalculation=async input=>{const job=await submit(input);if(lost){lost=false;throw Error("Connection lost");}return job;};
    await h.open();
    assert.equal(h.area.needsRecovery,true);
    const saved=h.storage.forClient("raster-series:0").read();
    await h.area.retryInterruptedCalculations();await flush();
    const submissions=h.requests.filter(([kind])=>kind==="submit");
    assert.equal(submissions.length,3);assert.deepEqual(submissions[0][1],submissions[2][1]);
    await h.finish();await h.finish();
    assert.equal(h.area.complete,true);
    assert.equal(h.area.results.size,2);
    const recoveredResult=[...h.area.results.values()].find(result=>result.job.requestId===saved.pending.requestId);
    h.close();
});

test("reload recovers automatically started work without cancelling or resubmitting",async()=>{
    const h=fixture();await h.open();
    const originals=[...h.server.values()];h.close();
    const recovered=fixture({},h.data);
    for(const job of originals)recovered.server.set(job.jobId,job);
    await recovered.area.start();await flush();
    assert.equal(recovered.requests.filter(([kind])=>kind==="cancel").length,0);
    await recovered.finish();await recovered.finish();
    assert.equal(recovered.requests.filter(([kind])=>kind==="submit").length,0);
    assert.equal(recovered.area.results.size,2);recovered.close();
});

test("catalog predicates and annotation uploads remain exact per-raster inputs",async()=>{
    for (const area of [{kind:"catalogSelection",catalogSelection:CATALOG_SELECTION},
        {kind:"polygonArea",polygonArea:{id:"a".repeat(32),sha256:"b".repeat(64)}}]) {
        const h=fixture();h.controller.setArea(area,"Selected polygons");await h.open();

        await h.area.calculateRemainingRasters();await flush();await h.finish();await h.finish();
        for(const [,intent]of h.requests.filter(([kind])=>kind==="submit"))assert.deepEqual(intent.area,area);
        assert.equal(h.area.complete,true);h.close();
        const restored = fixture({}, h.data);
        for (const [id, job] of h.server) restored.server.set(id, job);
        try {
            await restored.controller.start();
            assert.equal(restored.view.state.area.areaChoice, "vector");
            assert.deepEqual(restored.view.state.area.area, area);
            assert.equal(restored.requests.filter(([kind]) => kind === "submit").length, 0);
        } finally { restored.close(); }
    }
});

test("inline cached completions retain all source positions without queuing extra jobs",async()=>{
    const h=fixture(),submit=h.api.submitCalculation;
    h.api.submitCalculation=async input=>{
        const job=await submit(input);
        const ready={...job,status:"ready",result:{cacheHit:true,rows:job.calculations.map(row=>({...row,value:"0",state:"ok",valueType:"float",aggregates:[]}))}};
        h.server.set(job.jobId,ready);return ready;
    };
    h.controller.chooseArea("whole");await h.open();await flush();
    assert.equal(h.area.complete,true);
    assert.deepEqual(h.view.state.rows.map(row=>row.value),[0,0]);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);h.close();
});

test("submission rejects invalid formulas with one shared explanation and retains the five-formula limit",async()=>{
    const h=fixture({submitCalculation:async()=>{throw new ProcessingRequestError("Unknown function bad",422);}});
    h.controller.editFormula(1,{expression:"bad(a)"});
    for(let i=0;i<8;i++)h.controller.addFormula("mean");
    assert.equal(h.controller.formulas.length,5);
    await h.open();
    assert.deepEqual(h.view.state.statistics.map(statistic=>statistic.styleIndex),[0,1,2,3,4]);
    h.controller.removeFormula(2);h.controller.addFormula("sum");
    assert.equal(h.controller.formulas.at(-1).id,6,"formula identities can exceed the number of available styles");
    assert.deepEqual(h.view.state.statistics.map(statistic=>statistic.styleIndex),[0,2,3,4,1],"reuse the removed formula's style without changing the others");
    h.controller.addFormula("mean");
    assert.equal(h.controller.formulas.length,5,"a sixth active formula is not accepted");
    await h.tick(700);
    assert.match(h.view.state.message,/Unknown function bad/);
    assert.equal(h.requests.filter(([kind])=>kind==="validate").length,0);
    assert.equal(h.area.results.size,2);
    assert.ok(h.view.state.rows.every(row=>row.errorMessage==="Not calculated. See the message above."));
    assert.deepEqual(h.storage.savedClientNames(),[],"known rejection needs no recovery");h.close();
});

test("all 25 rasters submit without a formula preflight and an edited rejection can succeed",async()=>{
    const h=fixture({validateCalculation:()=>{throw Error("Unexpected validation preflight");}});
    h.controller.updateAvailableRasters(Array.from({length:25},(_,i)=>source(String(i))));
    const submit=h.api.submitCalculation;
    h.api.submitCalculation=async value=>{
        if(value.calculations[0].expression==="bad(a)") throw new ProcessingRequestError("Unknown function bad",422);
        return submit(value);
    };
    h.controller.editFormula(1,{expression:"bad(a)"});await h.open();
    assert.equal(h.area.results.size,25);assert.match(h.area.commonError,/Unknown function bad/);
    h.controller.editFormula(1,{expression:"mean(a)"});await h.tick(700);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,25);
    assert.equal(h.area.commonError,"");assert.equal(h.area.pending.size,25);
    for(let i=0;i<25;i++) await h.finish();
    assert.equal(h.area.complete,true);assert.equal(h.area.hasErrors,false);h.close();
});

test("mixed raster failures retain their own explanations instead of a shared formula error",async()=>{
    const h=fixture();const submit=h.api.submitCalculation;
    h.api.submitCalculation=async value=>{
        if(value.source.itemId==="2") throw new ProcessingRequestError("Source is unavailable",404);
        return submit(value);
    };
    await h.open();await h.finish();
    assert.equal(h.area.commonError,"");assert.match(h.area.message,/Some rasters failed/);
    assert.match(h.view.state.rows.find(row=>row.key==="2").errorMessage,/Source is unavailable/);h.close();
});

test("closing and reopening a completed area plot preserves its result and completion message",async()=>{
    const h=fixture();await h.open();await h.finish();await h.finish();
    const count=h.requests.length;
    h.controller.updateSamplingForPanelVisibility(false);h.controller.updateSamplingForPanelVisibility(true);await h.tick();
    assert.match(h.view.state.message,/Raster series complete/);
    assert.equal(h.requests.length,count);h.close();
});

test("all statistics keep identities and raster positions through out-of-order results and new areas",async()=>{
    const h=fixture();h.controller.addFormula("min");h.controller.addFormula("max");await h.open();
    await h.finish("ready",false,"2");
    for(const statistic of h.view.state.statistics){
        assert.equal(statistic.visible,true);
        assert.equal(statistic.plotId,1);
        assert.deepEqual(statistic.rows.map(row=>[row.key,row.state]),[["1","waiting"],["2","value"]]);
    }
    const styles=h.view.state.statistics.map(statistic=>statistic.styleIndex);
    await h.finish();h.controller.setArea(box(10),"Next area");await h.tick();
    assert.equal(h.view.state.showingPrevious,true);
    assert.ok(h.view.state.statistics.every(statistic=>statistic.previousRows.every(row=>row.state==="value")));
    await h.finish("ready",false,"2");
    assert.equal(h.view.state.showingPrevious,false);
    assert.ok(h.view.state.statistics.every(statistic=>statistic.previousRows===null && statistic.rows[0].state==="waiting"));
    h.view.actions.onOrder("name","reverse");
    assert.deepEqual(h.view.state.statistics.map(statistic=>statistic.styleIndex),styles);
    assert.ok(h.view.state.statistics.every(statistic=>statistic.rows[0].key==="2"));
    h.controller.removeFormula(2);h.controller.addFormula("sum");
    assert.equal(h.view.state.statistics.find(statistic=>statistic.id===3).styleIndex,2);
    assert.equal(new Set(h.view.state.statistics.map(statistic=>statistic.styleIndex)).size,3);
    h.close();
});

test("later raster can finish while the first raster's submission response is still in flight",async()=>{
    const h=fixture(), gate=deferred(), submit=h.api.submitCalculation;
    h.api.submitCalculation=async intent=>{
        const result=await submit(intent);
        if(intent.source.itemId==="1")await gate.promise;
        return result;
    };
    await h.open();
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
    await h.finish("ready",false,"2");
    assert.deepEqual(h.view.state.rows.map(row=>row.state),["waiting","value"]);
    assert.equal(h.area.busy,true);
    gate.resolve();await flush();await h.finish("ready",false,"1");
    assert.equal(h.area.complete,true);h.close();
});

test("unclassified submission rejection leaves an actionable gap and retries only failed rows",async()=>{
    const h=fixture(), submit=h.api.submitCalculation;let full=true;
    h.api.submitCalculation=async intent=>{
        if(full&&intent.source.itemId==="1")throw new ProcessingRequestError("Submission rejected. Try again.",429);
        return submit(intent);
    };
    await h.open();await h.finish("ready",false,"2");
    assert.match(h.view.state.rows[0].errorMessage,/Submission rejected/);
    assert.equal(h.area.hasErrors,true);assert.equal(h.area.busy,false);
    full=false;await h.area.calculateRemainingRasters();await flush();await h.finish("ready",false,"1");
    assert.equal(h.area.hasErrors,false);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);h.close();
});

test("64 rasters dispatch without a browser worker limit and one cancel stops all",async()=>{
    const h=fixture();
    h.controller.updateAvailableRasters(Array.from({length:64},(_,i)=>source(String(i+1))));
    h.area.updateCalculationInputs(Array.from({length:64},(_,i)=>source(String(i+1))),box(0),"Box",[{id:1,label:"Mean",expression:"mean(a)"}]);
    h.area.updateCalculationForPanelVisibility(true);await h.tick();
    assert.equal(h.server.size,64);assert.equal(h.storage.savedClientNames().length,64);
    assert.equal(h.jobs.listeners.size,64,"all executors share the same observer");
    h.area.cancelRemainingRasters();await flush();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,64);
    h.close();
});

test("all 64 rasters finish automatically through a smaller job queue",async context=>{
    context.mock.timers.enable({apis:["setTimeout"]});
    const h=fixture(), submit=h.api.submitCalculation;
    const attempts=new Map();let jobRejections=0;
    h.api.submitCalculation=async request=>{
        const prior=attempts.get(request.source.itemId);
        if(prior) assert.equal(request.requestId,prior,"capacity retries keep the same request key");
        attempts.set(request.source.itemId,request.requestId);
        if([...h.server.values()].filter(job=>job.status==="running").length>=4) {
            jobRejections++;throw new ProcessingRequestError("Queue full",429,"owner_queue_full",5);
        }
        return submit(request);
    };
    h.controller.updateAvailableRasters(Array.from({length:64},(_,i)=>source(String(i))));
    await h.open();
    assert.equal(h.area.hasErrors,false);
    assert.equal(h.server.size,4);
    assert.ok([...h.area.progress.values()].some(value=>/retrying automatically/.test(value.message)));
    for(let round=0;round<20 && !h.area.complete;round++) {
        for(const job of [...h.server.values()].filter(job=>job.status==="running")) await h.finish("ready",false,job.sources.a.itemId);
        context.mock.timers.tick(31000);await flush();
    }
    assert.ok(jobRejections>0);
    assert.equal(h.area.complete,true);
    assert.equal(h.area.hasErrors,false);
    assert.equal(h.area.results.size,64);
    assert.equal(h.view.state.rows.length,64);
    assert.equal(h.server.size,64,"each raster was accepted exactly once");
    assert.equal(h.requests.filter(([kind])=>kind==="plan").length,0);
    assert.equal(h.storage.savedClientNames().length,64,"completed results remain recoverable");
    h.close();
});

test("reload recovers all 64 independent submissions without cancelling them",async()=>{
    const h=fixture();
    h.controller.updateAvailableRasters(Array.from({length:64},(_,i)=>source(String(i))));
    await h.open();h.close();
    const recovered=fixture(h.api,h.data);
    await recovered.area.start();await flush();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,0);
    assert.equal(recovered.area.pending.size,64);
    assert.ok([...h.server.values()].every(job=>job.status==="running"));
    recovered.close();
});





test("cancelling a series leaves concurrent clip jobs running",async()=>{
    const h=fixture();
    const clip={jobId:"c".repeat(32),operation:"raster.clip.v1",status:"running",sources:{a:{itemId:"clip"}}};
    h.server.set(clip.jobId,clip);h.jobs.accept(clip);
    await h.open();h.area.cancelRemainingRasters();await flush();
    const cancelled=h.requests.filter(([kind])=>kind==="cancel").map(([,id])=>h.server.get(id).sources.a.itemId);
    assert.deepEqual(cancelled.sort(),["1","2"]);
    assert.equal(h.server.get(clip.jobId).status,"running");h.close();
});

test("cancellation during uncertain concurrent submissions recovers all original keys",async()=>{
    const h=fixture(), submit=h.api.submitCalculation;
    h.api.submitCalculation=async input=>{await submit(input);throw Error("Lost reply");};
    await h.open();assert.equal(h.area.needsRecovery,true);
    const originals=h.requests.filter(([kind])=>kind==="submit").map(([,input])=>input);
    h.area.cancelRemainingRasters();h.api.submitCalculation=submit;
    await h.area.retryInterruptedCalculations();await flush();
    for(const input of originals)assert.equal(h.requests.filter(([kind,value])=>kind==="submit"&&value.requestId===input.requestId).length,2);
    assert.equal(h.server.size,2);assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,2);
    await h.finish("cancelled");await h.finish("cancelled");
    assert.equal(h.area.results.size,0);assert.deepEqual(h.storage.savedClientNames(),[]);h.close();
});



test("reload recovers multiple lost submissions with original keys before cancellation",async()=>{
    const h=fixture(), submit=h.api.submitCalculation;
    h.api.submitCalculation=async input=>{await submit(input);throw Error("Lost reply");};
    await h.open();
    const originals=h.requests.filter(([kind])=>kind==="submit").map(([,input])=>input);
    const oldJobs=[...h.server];h.close();
    const restored=fixture({},h.data);
    for(const [id,job]of oldJobs)restored.server.set(id,job);
    await restored.area.start();await flush();
    assert.deepEqual(restored.requests.filter(([kind])=>kind==="submit").map(([,input])=>input),originals);
    assert.equal(restored.server.size,2);
    restored.area.cancelRemainingRasters(); await flush();
    assert.equal(restored.requests.filter(([kind])=>kind==="cancel").length,2);
    await restored.finish("cancelled");await restored.finish("cancelled");
    assert.deepEqual(restored.storage.savedClientNames(),[]);restored.close();
});

test("a full recovery store prevents submission of that raster without losing a peer record",async()=>{
    const h=fixture(), write=h.storage.storage.setItem;
    h.storage.storage.setItem=(key,value)=>{
        if(key.endsWith("raster-series:1"))throw Error("Storage full");
        write(key,value);
    };
    await h.open();
    assert.equal(h.server.size,1);
    assert.match(h.area.results.get("2").error,/Storage full/);
    assert.deepEqual(h.storage.savedClientNames(),["raster-series:0"]);
    await h.finish();h.close();
});

test("the shared activity indicator stays active until every submitted calculation settles",async()=>{
    const h=fixture(), activity=[];
    h.calculationRequests.dependencies.onActivity=area=>activity.push(area);
    await h.open();await h.finish();
    assert.deepEqual(activity.at(-1),box(0));
    await h.finish();assert.equal(activity.at(-1),null);h.close();
});

test("a box choice publishes its intent before composition commits a rectangle", () => {
    let h;
    h = fixture({}, new Map(), choice => {
        assert.equal(h.view.state.area.areaChoice, choice);
        h.controller.setArea(box(10), "New box");
    });
    try {
        h.controller.chooseArea("selection");
        assert.deepEqual(h.view.state.area.area, box(10));
        assert.equal(h.view.state.area.areaChoice, "selection");
    } finally { h.close(); }
});


/** Connect the production root's two polygon workflows to real statistics and DOM adapters.
 * Source transport, retained map records, dock foreground and viewport are fakes.
 * @param {Object} h Existing real Processing/calculation fixture.
 * @return {Object} Accepted filters, both controls, filter actions, scope presentation and recorded viewport events/fits.
 */
function samplingComposition(h) {
    const document = new FakeRasterControlDocument();
    document.defaultView.requestAnimationFrame = () => 1;
    document.defaultView.cancelAnimationFrame = () => {};
    document.defaultView.ResizeObserver = class {observe() {}};
    const oldDocument = globalThis.document; globalThis.document = document;
    const floating = new RasterSamplingAreaControlsView(document);
    const presentation = new RasterSeriesView(document, {onContextChange: context => floating.setAreaContext(context)});
    h.view.actions.onOpenArea = () => floating.openAreaEditor();
    presentation.bind(h.view.actions);
    const originalRender = h.view.render.bind(h.view);
    h.view.render = state => { originalRender(state); presentation.render(state); };
    const fields = [{name: "iso3", type: "string"}];
    const records = ["countries", "copy"].map(key => ({entry: {key, label: key === "copy" ? "Other countries view" : "Countries"},
        filter: structuredClone(EMPTY_VECTOR_FILTER)}));
    const reads = [], pendingFilters = [], pendingReads = [];
    let composed, delayedFilters = false, delayedReads = false, foreground = "raster-series";
    /** Refresh accepted source snapshots through the actual root's layer-change statements.
     * @return {void}
     */
    const refresh = () => new Function("vectorSampling", "summarySampling",
        main.match(/        vectorSampling\?\.refresh\(\);\s*summarySampling\?\.refresh\(\);/)[0])
        (composed?.vectorSampling, composed?.summarySampling);
    const adapter = {
        describeSource: () => ({geometryKind: "polygon", source: {collectionId: CATALOG_SELECTION.collectionId,
            itemId: CATALOG_SELECTION.itemId}, fields}),
        exportFilterState: record => structuredClone(record.filter),
        describeFilter: record => ({filter: structuredClone(record.filter), status: "Authoritative layer count"}),
        cancelPendingFilter: () => {},
        applyFilterState: async (record, candidate) => {
            if (delayedFilters) await new Promise((resolve, reject) => pendingFilters.push({resolve, reject}));
            record.filter = normalizeVectorFilter(candidate, fields); refresh(); return record.filter;
        },
    };
    for (const record of records) record.adapter = adapter;
    const layers = {retainedRecords: records, getRecord: key => records.find(record => record.entry.key === key) ?? null};
    const inspection = {showFilter() {foreground = "filter"; h.controller.updateSamplingForPanelVisibility(false);},
        hideFilter() {foreground = "raster-series"; h.controller.updateSamplingForPanelVisibility(true);}, updateLayerEditorName() {}};
    const viewportEvents = new Map(), fits = [];
    const viewport = {
        /** Register the composition root's map listener.
         * @param {string} event Map event name. @param {()=>void} handler Listener.
         * @return {void}
         */
        on(event, handler) {viewportEvents.set(event, handler);},
        /** Record a composed fit and emit its ordinary map-movement event.
         * @param {Object} bounds Padded geographic envelope. @param {Object} options Fit settings.
         * @return {void}
         */
        fitBounds(bounds, options) {fits.push({bounds, options}); viewportEvents.get("movestart")?.();},
    };
    const leaflet = {
        /** Retain the bounds and padding supplied by browser composition.
         * @param {number[][]} positions South/west and north/east corners.
         * @return {{pad:(padding:number)=>{positions:number[][],padding:number}}} Inspectable bounds adapter.
         */
        latLngBounds(positions) {return {pad: padding => ({positions, padding})};},
    };
    const main = readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
    const editor = main.slice(main.indexOf("    let modelFilterControls = null;"), main.indexOf("    models = new ModelsController({"));
    const workflows = main.slice(main.indexOf("    vectorSampling = new VectorSamplingController({"),
        main.indexOf("    const vectorStyleControls = new VectorStyleControls();"));
    assert.ok(editor.includes("const getPolygonTargets") && workflows.includes("summarySampling ="));
    const createArea = async (_source, filter, signal) => {
        reads.push({filter, signal});
        if (delayedReads) await new Promise((resolve, reject) => pendingReads.push({resolve, reject}));
        return {selection: {...CATALOG_SELECTION, filter}, matched: filter.rules.length ? 1 : 253,
            total: 253, filter, bbox: [-180, -85, 180, 85]};
    };
    const updateArea = (area, label) => h.controller.setArea(area, label);
    composed = new Function("document", "VectorFilterControls", "VectorSamplingController", "VectorSamplingView",
        "createVectorSamplingArea", "VectorSelectionOverlay", "leafletMap", "L", "mapInspection", "mapLayerController",
        "vectorMapLayerAdapter", "annotations", "processingApi", "rasterSeries", "updateRasterSeriesArea",
        "rasterVisualization", "models", "EMPTY_VECTOR_FILTER", `
        let vectorFilterControls, vectorSampling, summarySampling, modelArea, modelAreaDescription;
        ${editor} ${workflows}
        return {vectorFilterControls, vectorSampling, summarySampling};`)(document, VectorFilterControls,
        VectorSamplingController, VectorSamplingView, createArea, class {load() {} clear() {}}, viewport, leaflet, inspection,
        layers, adapter, {filterTarget: () => null, summaryTargets: () => []}, {}, h.controller, updateArea,
        {setVectorSelection: area => { if (area) updateArea({kind: "catalogSelection", catalogSelection: area.selection}, area.label); }},
        {refreshMapArea() {}}, EMPTY_VECTOR_FILTER);
    h.controller.onAreaChoice = choice => {
        if (choice === "vector") void composed.summarySampling.use();
        else composed.summarySampling.invalidate("");
    };
    h.controller.render();
    return {...composed, document, floating, presentation, records, reads, pendingFilters, pendingReads, viewportEvents, fits,
        get foreground() {return foreground;},
        delayFilters: () => {delayedFilters = true;}, delayReads: () => {delayedReads = true;},
        /** Apply a complete editor draft without waiting for its debounce timer.
         * @param {string} value Accepted country code. @return {Promise<void>} Settled composition callbacks.
         */
        async apply(value) {
            const controls = composed.vectorFilterControls;
            controls.draft = {enabled: true, match: "all", rules: [{field: "iso3", operator: "eq", value}]};
            controls.applyButton.dispatchEvent(new Event("click")); await flush();
        },
        /** Release callbacks, source reads and the fake global document. @return {void} */
        close() {
            composed.vectorFilterControls.destroy(); composed.vectorSampling.destroy(); composed.summarySampling.destroy();
            globalThis.document = oldDocument;
        },
    };
}

test("statistics-origin filter commits replace captured inputs through both production workflow instances", async () => {
    const h = fixture(), c = samplingComposition(h);
    try {
        await h.open(); await c.vectorSampling.choose("countries"); await c.summarySampling.choose("countries"); await h.tick();
        const initial = h.requests.filter(([kind]) => kind === "submit").length;
        assert.equal(c.floating.samplingAreaSummary.textContent, "Sample area · Countries · 253 of 253 features");
        c.summarySampling.views[0].elements.filter.dispatchEvent(new Event("click"));
        assert.equal(c.foreground, "filter");
        await c.apply("PER");
        assert.equal(h.controller.active, false, "an explicit area choice does not fake panel visibility");
        assert.equal(c.records[0].filter.rules[0].value, "PER");
        assert.equal(c.records[1].filter.rules.length, 0, "another retained view keeps its independent accepted predicate");
        assert.equal(c.vectorSampling.views[0].elements.status.textContent, "Sampling 1 of 253 features.");
        assert.equal(c.summarySampling.views[0].elements.status.textContent, "Sampling 1 of 253 features.");
        assert.equal(c.floating.samplingAreaSummary.textContent, "Sample area · Countries · 1 of 253 features");
        assert.equal(h.view.state.area.area.catalogSelection.filter.rules[0].value, "PER");
        assert.equal(h.requests.filter(([kind]) => kind === "submit").length, initial, "hidden editing schedules no replacement jobs");
        assert.ok(h.requests.some(([kind]) => kind === "cancel"), "committed explicit intent cancels the superseded calculation");
        c.vectorFilterControls.close(); await h.finish("cancelled"); await h.finish("cancelled"); await h.tick();
        const replacements = h.requests.filter(([kind]) => kind === "submit").slice(initial);
        assert.equal(replacements.length, 2);
        assert.ok(replacements.every(([, intent]) => intent.area.catalogSelection.filter.rules[0].value === "PER"));
        const count = h.requests.length;
        c.summarySampling.views[0].elements.filter.dispatchEvent(new Event("click")); await c.apply("PER");
        assert.equal(h.requests.length, count, "reapplying the same predicate does not restart captured work");
    } finally {c.close(); h.close();}
});

test("map-origin edits retain captured counts and explain different predicates even with equal totals", async () => {
    const h = fixture(), c = samplingComposition(h);
    try {
        c.records[0].filter = {enabled: true, match: "all", rules: [{field: "iso3", operator: "eq", value: "PER"}]};
        c.vectorSampling.refresh(); c.summarySampling.refresh();
        await h.open(); await c.vectorSampling.choose("countries"); await c.summarySampling.choose("countries"); await h.tick();
        const captured = h.view.state.area.area, count = h.requests.length;
        c.vectorFilterControls.open("countries"); await c.apply("ECU");
        assert.deepEqual(h.view.state.area.area, captured);
        assert.equal(h.requests.length, count, "outside filter changes neither cancel nor submit captured calculations");
        assert.match(h.view.state.message, /These statistics use the previous filter/);
        assert.match(h.view.state.message, /Use current polygon filter/);
        assert.equal(c.floating.samplingAreaSummary.textContent, "Sample area · Countries · 1 of 253 features");
        c.vectorFilterControls.close(); await h.tick();
        assert.deepEqual(h.view.state.area.area, captured, "reopening preserves the captured predicate");
        c.records[0].entry.label = "Renamed countries"; c.vectorSampling.refresh(); c.summarySampling.refresh();
        assert.equal(h.requests.length, count, "renaming does not become a new calculation intent");
        c.presentation.renderAreaControls(h.view.state);
        const adopt = c.document.querySelector("#raster-series-use-current-filter");
        assert.equal(adopt.hidden, false);
        adopt.dispatchEvent(new Event("click")); await flush();
        assert.equal(c.document.activeElement, c.document.querySelector("#raster-series-open-area"));
        assert.equal(h.view.state.area.area.catalogSelection.filter.rules[0].value, "ECU");
        c.presentation.renderAreaControls(h.view.state); assert.equal(adopt.hidden, true);
        assert.doesNotMatch(h.view.state.message, /previous filter/);
    } finally {c.close(); h.close();}
});

test("failed stats filters preserve captured jobs and cleared selections ignore late prepared areas", async () => {
    const h = fixture(), c = samplingComposition(h);
    try {
        await h.open(); await c.summarySampling.choose("countries"); await h.tick();
        const captured = h.view.state.area.area, count = h.requests.length;
        c.delayFilters(); c.summarySampling.views[0].elements.filter.dispatchEvent(new Event("click"));
        const applying = c.apply("PER"); await flush(); c.pendingFilters.at(-1).reject(Error("Filter unavailable")); await applying; await flush();
        assert.deepEqual(h.view.state.area.area, captured); assert.equal(h.requests.length, count);
        assert.match(c.vectorFilterControls.status.textContent, /previous applied filter remains/);
        c.vectorFilterControls.close(); c.delayReads();
        h.view.actions.onArea("vector"); await flush();
        h.view.actions.onArea("whole"); await h.tick();
        c.pendingReads.at(-1).resolve(); await flush();
        assert.equal(h.view.state.area.areaChoice, "whole");
        assert.deepEqual(h.view.state.area.area, {kind: "wholeRaster"});
    } finally {c.close(); h.close();}
});


test("closing an in-flight statistics filter respects subsequent explicit area choices", async () => {
    for (const chooseWhole of [false, true]) {
        const h = fixture(), c = samplingComposition(h);
        try {
            await h.open(); await c.summarySampling.choose("countries"); await h.tick();
            c.delayFilters(); c.summarySampling.views[0].elements.filter.dispatchEvent(new Event("click"));
            await c.apply("PER"); c.vectorFilterControls.close();
            if (chooseWhole) h.view.actions.onArea("whole");
            c.pendingFilters.at(-1).resolve(); await flush();
            if (chooseWhole) {
                assert.deepEqual(h.view.state.area.area, {kind: "wholeRaster"}, "a closed editor cannot override the later whole-raster intent");
            } else {
                assert.equal(h.view.state.area.area.catalogSelection.filter.rules[0].value, "PER",
                    "the foreground workflow follows the accepted filter through its ordinary selection lifecycle");
                assert.equal(c.floating.samplingAreaSummary.textContent, "Sample area · Countries · 1 of 253 features");
            }
        } finally {c.close(); h.close();}
    }
});


test("passive polygon reads preserve their captured area when statistics reopens before the reply", async () => {
    for (const areaChoice of ["vector", "selection"]) {
        const h = fixture(), c = samplingComposition(h);
        try {
            await c.vectorSampling.choose("countries"); await c.summarySampling.choose("countries");
            if (areaChoice === "selection") h.controller.selectSource({collectionId: "catalog", itemId: "1"}, h.view.state.area.area);
            await h.open();
            const captured = h.view.state.area.area, count = h.requests.length;
            const scope = c.floating.samplingAreaSummary.textContent;
            c.delayReads(); c.vectorFilterControls.open("countries"); await c.apply("PER");
            assert.equal(c.pendingReads.length, 2);
            c.vectorFilterControls.close();
            c.summarySampling.refresh();
            for (const read of c.pendingReads) read.resolve(); await flush();
            assert.deepEqual(h.view.state.area.area, captured, "both preceding map-area publication and vector adoption preserve the captured descriptor");
            assert.equal(h.requests.length, count, "reopening during passive preparation never cancels or resubmits work");
            assert.equal(h.view.state.area.hasPendingVectorArea, true);
            assert.equal(c.floating.samplingAreaSummary.textContent, scope);
        } finally {c.close(); h.close();}
    }
});

test("late map-filter acceptance preserves capture or respects a newer explicit polygon/whole choice", async () => {
    for (const laterChoice of ["none", "whole", "copy"]) {
        const h = fixture(), c = samplingComposition(h);
        try {
            await c.vectorSampling.choose("countries"); await c.summarySampling.choose("countries"); await h.open();
            const captured = h.view.state.area.area;
            c.delayFilters(); c.vectorFilterControls.open("countries"); await c.apply("PER");
            c.vectorFilterControls.close();
            if (laterChoice === "whole") h.view.actions.onArea("whole");
            if (laterChoice === "copy") {
                const layer = c.summarySampling.views[0].elements.layer;
                layer.value = "copy"; layer.dispatchEvent(new Event("change")); await flush();
                assert.equal(h.view.state.area.areaLabel, "Other countries view · 253 of 253 features");
            }
            const count = h.requests.length;
            c.pendingFilters.at(-1).resolve(); await flush();
            assert.equal(h.requests.length, count, "the late passive filter does not replace the selected calculation");
            if (laterChoice === "whole") assert.deepEqual(h.view.state.area.area, {kind: "wholeRaster"});
            else if (laterChoice === "copy") {
                assert.equal(c.summarySampling.views[0].elements.layer.value, "copy");
                assert.equal(h.view.state.area.areaLabel, "Other countries view · 253 of 253 features");
                assert.equal(h.view.state.area.area.catalogSelection.filter.rules.length, 0);
            } else {
                assert.deepEqual(h.view.state.area.area, captured);
                assert.equal(h.view.state.area.hasPendingVectorArea, true);
                assert.match(h.view.state.message, /Use current polygon filter/);
            }
        } finally {c.close(); h.close();}
    }
});


test("explicit Clear selection supersedes delayed passive filter and area replies without reviving work", async () => {
    for (const delay of ["filter", "area"]) {
        const h = fixture(), c = samplingComposition(h);
        try {
            await c.vectorSampling.choose("countries"); await c.summarySampling.choose("countries"); await h.open();
            if (delay === "filter") c.delayFilters(); else c.delayReads();
            c.vectorFilterControls.open("countries"); await c.apply("PER"); c.vectorFilterControls.close();
            c.summarySampling.views[0].elements.remove.dispatchEvent(new Event("click")); await flush();
            assert.equal(c.summarySampling.views[0].elements.layer.value, "");
            assert.equal(h.view.state.area.area, null);
            assert.equal(h.view.state.area.hasPendingVectorArea, false);
            const count = h.requests.length;
            if (delay === "filter") c.pendingFilters.at(-1).resolve();
            else for (const read of c.pendingReads) read.resolve();
            await flush(); await h.tick();
            assert.equal(h.view.state.area.area, null);
            assert.equal(h.requests.length, count, "late replies never restart a cleared calculation");
        } finally {c.close(); h.close();}
    }
});


test("an older map-filter operation keeps its passive origin after explicitly selecting its view", async () => {
    for (const initiallyCaptured of [true, false]) for (const choices of [["copy"], ["copy", "countries"]]) {
        const h = fixture(), c = samplingComposition(h);
        try {
            await c.vectorSampling.choose("countries"); await c.summarySampling.choose("countries");
            if (initiallyCaptured) await h.open();
            c.delayFilters(); c.vectorFilterControls.open(choices.at(-1)); await c.apply("PER"); c.vectorFilterControls.close();
            for (const key of choices) {
                const layer = c.summarySampling.views[0].elements.layer;
                layer.value = key; layer.dispatchEvent(new Event("change")); await flush();
                while ([...h.server.values()].some(job => job.status === "cancelling")) await h.finish("cancelled");
                await h.tick();
            }
            const captured = h.view.state.area.area, count = h.requests.length;
            assert.equal(captured.catalogSelection.filter.rules.length, 0);
            assert.equal(h.area.hasCapturedInputs, true);
            c.pendingFilters.at(-1).resolve(); await flush();
            assert.deepEqual(h.view.state.area.area, captured);
            assert.equal(h.requests.length, count, "the older passive operation cannot cancel work captured before or after its request began");
            assert.equal(c.summarySampling.views[0].elements.layer.value, choices.at(-1));
            assert.equal(h.view.state.area.hasPendingVectorArea, true);
        } finally {c.close(); h.close();}
    }
});


test("a histogram-owned pending area opens choices without adopting another statistics layer", async () => {
    const h = fixture(), c = samplingComposition(h);
    try {
        c.records[0].filter = {enabled: true, match: "all", rules: [{field: "iso3", operator: "eq", value: "PER"}]};
        c.records[1].filter = {enabled: true, match: "all", rules: [{field: "iso3", operator: "eq", value: "ECU"}]};
        c.vectorSampling.refresh(); c.summarySampling.refresh();
        await c.vectorSampling.choose("copy"); await c.summarySampling.choose("countries");
        h.controller.selectSource({collectionId: "catalog", itemId: "1"},
            {kind: "catalogSelection", catalogSelection: c.vectorSampling.state.area.selection});
        await h.open();
        c.vectorFilterControls.open("copy"); await c.apply("MEX"); c.vectorFilterControls.close();
        const captured = h.view.state.area.area, count = h.requests.length;
        assert.equal(captured.catalogSelection.filter.rules[0].value, "ECU");
        assert.equal(h.view.state.area.areaChoice, "selection");
        c.presentation.renderAreaControls(h.view.state);
        const button = c.document.querySelector("#raster-series-use-current-filter");
        button.dispatchEvent(new Event("click")); await flush();
        assert.deepEqual(h.view.state.area.area, captured, "opening choices cannot silently substitute statistics layer A/PER for pending map layer B/MEX");
        assert.equal(h.requests.length, count);
        assert.equal(c.floating.disclosure.open, true);
        assert.equal(button.textContent, "Choose polygon layer");
        assert.match(h.view.state.message, /Choose polygon layer/);
        assert.equal(c.summarySampling.views[0].elements.layer.value, "countries");
        const radio = c.document.querySelector("#raster-series-area-vector");
        radio.checked = true; radio.dispatchEvent(new Event("change")); await flush();
        const layer = c.summarySampling.views[0].elements.layer;
        layer.value = "copy"; layer.dispatchEvent(new Event("change")); await flush();
        assert.equal(h.view.state.area.area.catalogSelection.filter.rules[0].value, "MEX");
        assert.equal(h.view.state.area.areaChoice, "vector");
    } finally {c.close(); h.close();}
});


test("composed filtered zoom preserves statistics filter intent and rejects obsolete fits", async () => {
    const h = fixture(), c = samplingComposition(h), pendingExtents = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
        assert.equal(url, "/api/vector-sampling/extent");
        return new Promise(resolve => pendingExtents.push({input: JSON.parse(options.body), signal: options.signal, resolve}));
    };
    try {
        await h.open(); await c.vectorSampling.choose("countries"); await c.summarySampling.choose("countries"); await h.tick();
        const captured = h.view.state.area.area, initialCalls = h.requests.length;
        c.summarySampling.views[0].elements.filter.dispatchEvent(new Event("click"));
        c.vectorFilterControls.zoomButton.dispatchEvent(new Event("click")); await flush();
        assert.deepEqual(pendingExtents[0].input.filter, EMPTY_VECTOR_FILTER);
        assert.deepEqual(h.view.state.area.area, captured);
        assert.equal(h.requests.length, initialCalls, "zoom does not invoke the filter opening's statistics commit callback");

        await c.apply("PER");
        assert.equal(pendingExtents[0].signal.aborted, true, "accepted filter replacement cancels its old extent");
        assert.equal(h.view.state.area.area.catalogSelection.filter.rules[0].value, "PER");
        assert.equal(h.requests.filter(([kind]) => kind === "cancel").length, 2,
            "the statistics-origin commit still replaces its two captured jobs");
        pendingExtents[0].resolve(Response.json({matched: 253, bbox: [-180, -85, 180, 85]})); await flush();
        assert.equal(c.fits.length, 0, "obsolete pre-commit bounds cannot move the map");

        const committedCalls = h.requests.length;
        c.vectorFilterControls.zoomButton.dispatchEvent(new Event("click")); await flush();
        assert.equal(pendingExtents[1].input.filter.rules[0].value, "PER");
        pendingExtents[1].resolve(Response.json({matched: 1, bbox: [-5, -4, 3, 2]})); await flush();
        assert.deepEqual(c.fits, [{bounds: {positions: [[-4, -5], [2, 3]], padding: 0.15},
            options: {padding: [24, 24], maxZoom: 14}}]);
        assert.match(c.vectorFilterControls.zoomStatus.textContent, /Showing 1 matching feature/);
        assert.equal(h.requests.length, committedCalls, "a successful fit neither resubmits nor cancels statistics");

        c.vectorFilterControls.zoomButton.dispatchEvent(new Event("click")); await flush();
        c.viewportEvents.get("movestart")();
        assert.equal(pendingExtents[2].signal.aborted, true);
        pendingExtents[2].resolve(Response.json({matched: 1, bbox: [10, 10, 11, 11]})); await flush();
        assert.equal(c.fits.length, 1, "a user pan invalidates a pending composed fit");
        assert.equal(h.requests.length, committedCalls);
    } finally {globalThis.fetch = originalFetch; c.close(); h.close();}
});
