import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CalculationExecutor } from "../../src/processing/calculation-executor.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingApiClient, ProcessingRequestError } from "../../src/processing/api.js";

const source = { collectionId: "rasters", itemId: "hfp", label: "Human footprint" };
const box = west => ({ kind: "selectedArea", selectedBounds: { west, south: 22, east: west + 1, north: 23 } });
const grid = { width: 100, height: 100, crs: "EPSG:3857", dtype: "float32", transform: [1,0,0,0,-1,0], nativeBlocks: 4, decodedBytes: 10000 };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };

test("the executor does not import the statistics controller or its view", () => {
    const source = readFileSync(new URL("../../src/processing/calculation-executor.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*["'][^"']*summary-statistics-(?:controller|view)/);
});

test("job queue capacity waits automatically, keeps the request key, and can be cancelled",async context=>{
    context.mock.timers.enable({apis:["setTimeout"]});
    for(const cancel of [false,true]) {
        const h=fixture(), submit=h.api.submitCalculation, attempts=[];
        h.api.submitCalculation=async request=>{
            attempts.push(request);
            if(attempts.length===1) throw new ProcessingRequestError("Queue full",429,"owner_queue_full",5);
            return submit(request);
        };
        await h.run(true);
        assert.match(h.controller.snapshot.message,/Waiting for server capacity/);
        assert.equal(h.controller.snapshot.recoverable,false);
        assert.ok(h.storage.read()?.pending);
        if(cancel) {
            h.controller.stop(); await flush();
            assert.equal(h.storage.read(),null);
            assert.equal(h.server.size,0);
            assert.equal(h.requests.some(([kind])=>kind==="plan"||kind==="discard"),false);
        }
        context.mock.timers.tick(6000); await flush();
        assert.equal(attempts.length,cancel?1:2);
        if(!cancel) { assert.deepEqual(attempts[0],attempts[1]); await h.finish(); }
        h.controller.destroy();h.jobs.destroy();
    }
});



test("cancellation during an in-flight submission still obtains and cancels an accepted job",async()=>{
    const h=fixture(), submit=h.api.submitCalculation, response=deferred();
    h.api.submitCalculation=async request=>{const job=await submit(request);await response.promise;return job;};
    await h.run(true);h.controller.stop();response.resolve();await flush();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,1);
    await h.finish("cancelled");h.controller.destroy();h.jobs.destroy();
});

test("a lost response after a capacity retry preserves the original recoverable request",async context=>{
    context.mock.timers.enable({apis:["setTimeout"]});
    const h=fixture(), submit=h.api.submitCalculation, attempts=[];
    h.api.submitCalculation=async request=>{
        attempts.push(request);
        if(attempts.length===1) throw new ProcessingRequestError("Queue full",429,"queue_full");
        const job=await submit(request);
        if(attempts.length===2) throw Error("Response lost");
        return job;
    };
    await h.run(true);context.mock.timers.tick(6000);await flush();
    assert.equal(h.controller.snapshot.recoverable,true);
    assert.equal(h.storage.read().pending.requestId,attempts[0].requestId);
    await h.controller.retry();await flush();
    assert.equal(attempts.length,3);
    assert.ok(attempts.every(request=>JSON.stringify(request)===JSON.stringify(attempts[0])));
    assert.equal(h.server.size,1);await h.finish();h.controller.destroy();h.jobs.destroy();
});

/** Connect the executor to real recovery storage and job observation with controlled transport.
 * @param {Object} [overrides={}] API responses for lifecycle and failure scenarios.
 * @param {Map<string,string>} [data=new Map()] Persisted session contents.
 * @return {Object} Execution harness and observable API requests.
 */
function fixture(overrides = {}, data = new Map()) {
    const timers = new Map(); let serial = 0; let id = 0;
    const clock = { setTimeout(fn,delay) { timers.set(++serial,{fn,delay}); return serial; }, clearTimeout(key) { timers.delete(key); } };
    const requests = []; const server = new Map();
    const storage = new CalculationSessionStorage({ getItem: key => data.get(key), setItem: (key,value) => data.set(key,value), removeItem: key => data.delete(key) });
    const api = {
        listJobs: async () => [...server.values()], getJob: async id => server.get(id),
        validateCalculation: async rows => { requests.push(["validate",rows]); return {valid:true}; },
        submitCalculation: async submission => {
            requests.push(["submit",submission]);
            const intent = submission;
            const existing=[...server.values()].find(job=>job.requestId===submission.requestId); if(existing)return existing;
            const jobId = String(++id).padStart(32,"0");
            const job = {jobId,requestId:submission.requestId,operation:"raster.aggregate.v1",status:"running", sources:{a:intent.source},calculations:intent.calculations,
                grid,area:{kind:"bounds",bounds:[intent.area.selectedBounds?.west ?? 0,22,(intent.area.selectedBounds?.west ?? 0)+1,23]},progress:{phase:"calculating",completedBlocks:0,totalBlocks:4},result:null};
            server.set(jobId,job); return job;
        },
        cancelJob: async id => { requests.push(["cancel",id]); const job = {...server.get(id),status:"cancelling"}; server.set(id,job); return job; },
        deleteJob: async id => { const job={...server.get(id),status:"deleted",result:null};server.set(id,job);return job; },
        ...overrides,
    };
    const jobs = new ProcessingJobs(api,clock);
    const view = {}; const snapshots = [];
    const activity = [];
    const options = {api,jobs,storage,onChange: state => {
        view.state=state; snapshots.push(state);
    },
        onActivity: area=>activity.push(area),requestId:()=>`request-${String(id).padStart(16,"0")}`};
    const controller = new CalculationExecutor(options);
    view.state=controller.snapshot;
    const intent = change => ({source,area:box(77),calculations:[{label:"Mean",expression:"mean(a)"}],...change});
    const execute = (calculation, automatic = false) => {
        controller.submit(calculation, Object.freeze({automatic}));
    };
    const click = west => { controller.stop(); execute(intent({area:box(west)}), true); };
    const tick = async delay => { const due=[...timers.entries()].filter(([,item])=>item.delay===delay); for(const [key,item]of due){timers.delete(key);item.fn();}await flush(); };
    const finish = async (status="ready",value="12.5") => {
        const old=server.get(controller.snapshot.currentJob.jobId);
        server.set(old.jobId,{...old,status,result:status==="ready"?{url:`/api/processing/jobs/${old.jobId}/result`,provenanceUrl:`/api/processing/jobs/${old.jobId}/provenance`,rows:[{label:"Mean",expression:"mean(a)",value,valueType:"float",state:"ok",aggregates:[{function:"mean",matchedPixels:8,validPixels:8,invalidArithmeticPixels:0}]}]}:null});
        await jobs.refresh(); await flush();
    };
    const run = async automatic => { execute(intent(),automatic); await flush(); };
    return {controller,api,jobs,storage,view,requests,server,tick,finish,run,activity,data,options,click,intent,snapshots,execute};
}

test("execution snapshots remain busy through cancellation and replacement admission", async () => {
    const h = fixture();
    const initial = h.controller.snapshot;
    assert.equal(initial.admission, "ready");
    await h.run(true);
    const accepted = h.controller.snapshot;
    assert.equal(accepted.admission, "busy");
    assert.equal(accepted.isIdle, false);
    assert.equal(accepted.unfinishedCalculation.cancelRequested, false);
    assert.ok(Object.isFrozen(accepted));
    assert.ok(Object.isFrozen(accepted.unfinishedCalculation));
    assert.equal(accepted.unfinishedCalculation.pending, undefined, "submission identity stays private");
    assert.equal(accepted.record, undefined);
    assert.equal(accepted.desired, undefined);
    const offset = h.snapshots.length;
    h.click(80);
    await flush();
    assert.equal(h.controller.snapshot.unfinishedCalculation.cancelRequested, true);
    assert.equal(accepted.unfinishedCalculation.cancelRequested, false, "prior snapshots cannot change underneath a consumer");
    await h.finish("cancelled");
    assert.ok(h.snapshots.slice(offset).every(state =>
        (!state.isIdle && state.admission === "busy") || (state.isIdle && state.plan)),
        "only a prepared plan may wait for the caller between cancellation and submission");
    await h.finish();
    assert.equal(h.controller.snapshot.admission, "ready");
    assert.equal(h.controller.snapshot.isIdle, true);
    assert.deepEqual(h.controller.snapshot.completedCalculation.area, box(80));
    assert.equal(initial.completedJob, null);
});

test("failed submission retains exclusive admission until explicit recovery", async () => {
    const h = fixture(); const submit = h.api.submitCalculation;
    h.api.submitCalculation = async submission => { await submit(submission); throw Error("Response lost"); };
    await h.run(false);
    assert.equal(h.controller.snapshot.admission, "busy");
    assert.equal(h.controller.snapshot.isIdle, false);
    assert.equal(h.controller.snapshot.recoverable, true);
    h.click(80); await flush();
    assert.equal(h.requests.filter(([kind]) => kind === "submit").length, 1);
    h.api.submitCalculation = submit;
    await h.controller.retry(); await flush();
    const submissions = h.requests.filter(([kind]) => kind === "submit");
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[0][1], submissions[1][1]);
    await h.finish();
    assert.equal(h.controller.snapshot.admission, "ready");
});

test("intent is copied before asynchronous submission and no editor validation is invoked", async () => {
    const h = fixture(); const pending = deferred(); const submit = h.api.submitCalculation;
    h.api.submitCalculation = async intent => { await pending.promise; return submit(intent); };
    const input = h.intent();
    h.execute(input);
    input.calculations[0].expression = "sum(a)";
    input.area.selectedBounds.west = 80;
    pending.resolve(); await flush();
    assert.equal(h.requests.some(([kind]) => kind === "validate"), false);
    assert.equal(h.controller.snapshot.unfinishedCalculation.calculation.calculations[0].expression, "mean(a)");
    assert.deepEqual(h.controller.snapshot.unfinishedCalculation.calculation.area, box(77));
});

test("an unavailable saved job waits for explicit recovery rather than refreshing in a loop", async () => {
    const h = fixture();
    await h.run(true);
    h.controller.destroy();
    h.jobs.jobs = [];
    h.server.clear();
    let reads = 0;
    h.api.getJob = async () => { reads++; throw Error("Job unavailable"); };
    const recovered = new CalculationExecutor(h.options);
    await recovered.start();
    await flush();
    assert.equal(recovered.snapshot.recoverable, true);
    assert.match(recovered.snapshot.message, /Job unavailable/);
    const attempts = reads;
    await flush();
    assert.equal(reads, attempts);
    assert.equal(h.requests.filter(([kind]) => kind === "submit").length, 1);
    recovered.destroy(); h.jobs.destroy();
});

test("failed cancellation keeps the accepted job exclusive until recovery acknowledges it", async () => {
    const h = fixture(); await h.run(true);
    const cancel = h.api.cancelJob;
    h.api.cancelJob = async () => { throw Error("Cancellation response lost"); };
    h.click(80); await flush();
    assert.equal(h.controller.snapshot.recoverable, true);
    assert.equal(h.controller.snapshot.admission, "busy");
    assert.equal(h.controller.snapshot.unfinishedCalculation.cancelRequested, true);
    assert.equal(h.requests.filter(([kind]) => kind === "submit").length, 1);
    h.api.cancelJob = cancel;
    await h.controller.retry(); await flush();
    assert.equal(h.controller.snapshot.admission, "busy");
    await h.finish("cancelled");
    assert.equal(h.controller.snapshot.admission, "ready");
    assert.equal(h.requests.filter(([kind]) => kind === "submit").length, 1,
        "recovery does not automatically replay the failed replacement");
});

test("explicit cancellation of an uncertain submission is persisted before retry", async () => {
    const h = fixture(); const submit = h.api.submitCalculation;
    h.api.submitCalculation = async submission => { await submit(submission); throw Error("Response lost"); };
    await h.run(true);
    h.click(80); await flush();
    assert.equal(h.controller.snapshot.unfinishedCalculation.cancelRequested, true);
    h.api.submitCalculation = submit;
    await h.controller.retry(); await flush();
    assert.equal(h.controller.snapshot.currentJob.status, "cancelling");
    await h.finish("cancelled");
    assert.equal(h.controller.snapshot.completedJob, null);
});

test("repeating identical inputs during submission admits only one job", async () => {
    const response = deferred(); const h = fixture(); const original = h.api.submitCalculation;
    h.api.submitCalculation = async intent => { const job = await original(intent); await response.promise; return job; };
    h.execute(h.intent()); h.execute(h.intent());
    response.resolve(); await flush();
    assert.equal(h.requests.filter(r => r[0] === "plan").length, 0);
    assert.equal(h.requests.filter(r => r[0] === "submit").length, 1);
    assert.equal(h.controller.snapshot.unfinishedCalculation.context.automatic, false);

});

test("explicit Run freezes intent, publishes measured progress and inline result", async () => {
    const h=fixture();await h.run(false);
    assert.equal(h.view.state.currentJob.progress.totalBlocks,4);
    assert.deepEqual(h.activity.at(-1),box(77));
    h.controller.discardPendingCalculation();assert.equal(h.requests.filter(r=>r[0]==="cancel").length,0);
    await h.finish();assert.equal(h.view.state.completedJob.result.rows[0].value,"12.5");
    assert.deepEqual(h.view.state.completedCalculation.area,box(77));assert.equal(h.storage.read(),null);
    assert.equal(h.activity.at(-1),null);
});

test("replacement requests cancel old work and retain only the latest area until cancellation completes", async () => {
    const h=fixture();await h.run(true);h.click(78);h.click(79);
    await h.tick(650);assert.equal(h.requests.filter(r=>r[0]==="submit").length,1);
    assert.equal(h.requests.filter(r=>r[0]==="cancel").length,1);
    assert.equal(h.activity.at(-1),null);
    await h.finish("cancelled");
    assert.equal(h.requests.filter(r=>r[0]==="submit").length,2);
    assert.deepEqual(h.controller.snapshot.unfinishedCalculation.calculation.area,box(79));
    await h.finish();assert.deepEqual(h.view.state.completedCalculation.area,box(79));
});











test("click during submission cancels its eventual accepted job before admitting a replacement", async () => {
    const h=fixture();const acceptance=deferred();const original=h.api.submitCalculation;
    h.api.submitCalculation=async value=>{const job=await original(value);await acceptance.promise;return job;};
    h.execute(h.intent(),true);await flush();
    h.click(79);await h.tick(650);
    assert.equal(h.storage.read().cancelRequested,true);
    acceptance.resolve();await flush();assert.equal(h.view.state.currentJob.status,"cancelling");
    h.api.submitCalculation=original;await h.finish("cancelled");
    assert.deepEqual(h.controller.snapshot.unfinishedCalculation.calculation.area,box(79));
});

test("uncertain submission persists its key and superseded cancellation through reload", async () => {
    const h=fixture();const original=h.api.submitCalculation;
    h.api.submitCalculation=async value=>{await original(value);throw new Error("Response lost");};
    await h.run(true);const saved=h.storage.read();assert.ok(saved.pending);assert.equal(h.view.state.recoverable,true);
    h.controller.destroy();h.api.submitCalculation=original;
    h.controller.stop();
    const recovered=new CalculationExecutor({...h.options,onChange:()=>{}});await recovered.start();await flush();
    const submissions=h.requests.filter(r=>r[0]==="submit");assert.deepEqual(submissions[0][1],submissions[1][1]);
    assert.equal(recovered.snapshot.unfinishedCalculation.cancelRequested,true);assert.equal([...h.server.values()].find(job=>job.requestId===saved.pending.requestId).status,"cancelling");
});



test("a completed superseded job cannot replace the prior visible result", async () => {
    const h=fixture();await h.run(true);await h.finish("ready","1");const result=h.view.state.completedJob;
    h.click(78);await h.tick(650);
    h.click(79);await h.finish("ready","999");
    assert.equal(h.view.state.completedJob.jobId,result.jobId);
    assert.deepEqual(h.view.state.completedCalculation.area,box(77));
});



test("capacity refusal pauses follow and errors preserve the last visible result", async () => {
    const h=fixture();await h.run(true);await h.finish();const result=h.view.state.completedJob;
    h.api.submitCalculation=async()=>{throw new ProcessingRequestError("Native work limit",422);};
    h.click(79);await h.tick(650);
    assert.equal(h.view.state.phase,"error");assert.equal(h.controller.snapshot.admission,"retry");
    assert.equal(h.view.state.completedJob,result);assert.match(h.view.state.message,/Native work limit/);
});

for (const [kind, code, message] of [
    ["native blocks", "source_work_too_large", "The selected area's conservative estimate is 1,450 native blocks; the limit is 500 (950 over the limit). Choose a smaller area with an estimate of 500 blocks or fewer."],
    ["decoded bytes", "source_work_too_large", "The selected area requires 3,570 decoded bytes for source values and validity masks; the limit is 3,500 bytes (70 bytes over). Choose a smaller area requiring at most 3,500 decoded bytes."],
    ["AOI geometry", "aoi_too_large", "The selected area's serialized geometry is 240 bytes; the processing limit is 100 bytes (140 bytes over). Simplify the AOI geometry so its processing snapshot is at most 100 bytes, then try again."],
]) {
    test(`${kind} limit details survive the API and lifecycle controller`, async () => {
        const h = fixture();
        await h.run(true);
        await h.finish();
        const previous = h.view.state.completedJob;
        const client = new ProcessingApiClient(async url => url.endsWith("/jobs")
            ? { ok: true, json: async () => ({ jobs: [] }) }
            : { ok: false, status: 413, json: async () => ({ detail: { code, message } }) });
        h.api.submitCalculation = client.submitCalculation.bind(client);
        h.click(79);
        await h.tick(650);

        assert.equal(h.controller.snapshot.admission, "retry");
        assert.equal(h.view.state.message, `${message} Click Calculate to retry.`);
        assert.equal(h.view.state.completedJob, previous);
        assert.equal(h.requests.filter(request => request[0] === "submit").length, 1);
    });
}



test("shared job polling coalesces concurrent editors and protects accepted jobs", async () => {
    const response=deferred();const h=fixture({listJobs:()=>response.promise});
    const one=h.jobs.refresh();const two=h.jobs.refresh();assert.equal(one,two);
    h.jobs.accept({jobId:"a",status:"queued"});response.resolve([]);await one;
    assert.equal(h.jobs.jobs.length,1);
});



test("calculation API serializes identities, explicit scopes, and useful validation errors", async () => {
    const calls=[];
    const api=new ProcessingApiClient(async(url,options)=>{
        calls.push([url,options]);
        if(url.endsWith("/jobs"))return {ok:true,json:async()=>({jobs:[]})};
        return {ok:false,status:422,json:async()=>({detail:[{msg:"Unknown alias b"}]})};
    });
    await assert.rejects(api.validateCalculation([{label:"N",expression:"sum(b)"}]),/Unknown alias b/);
    assert.deepEqual(JSON.parse(calls[1][1].body),{alias:"a",calculations:[{label:"N",expression:"sum(b)"}]});
    assert.equal(calls[1][1].headers["X-EOLab-Processing"],"1");
});






test("caller metadata survives the legacy storage format without choosing reload cancellation", async () => {
    const h = fixture();
    const context = { automatic: true };
    h.controller.submit(h.intent(), context); await flush();
    context.automatic = false;
    const stored = JSON.parse([...h.data.values()][0]);
    assert.equal(stored.automatic, true);
    assert.equal(stored.context, undefined, "the v1 session format is unchanged");
    assert.equal(stored.cancelRequested, false);
    assert.equal(h.storage.read().cancelRequested, false, "reading storage makes no cancellation decision");
    h.controller.discardPendingCalculation(); await flush();
    assert.equal(h.requests.some(([kind]) => kind === "cancel"), false);
    h.controller.destroy();
    const restored = new CalculationExecutor({ ...h.options, onChange: () => {} });
    await restored.start(); await flush();
    assert.equal(restored.snapshot.unfinishedCalculation.context.automatic, true);
    assert.equal(restored.snapshot.unfinishedCalculation.cancelRequested, false);
    assert.equal(h.requests.some(([kind]) => kind === "cancel"), false,
        "the executor only cancels when its caller requests cancellation");
    restored.stop(); await flush();
    assert.equal(h.requests.filter(([kind]) => kind === "cancel").length, 1);
    restored.destroy();
});


test("polygon uploads use owned transport and recovery stores only their small reference", async () => {
    const polygonArea = { id: "a".repeat(32), sha256: "b".repeat(64) };
    const requests = [];
    const api = new ProcessingApiClient(async (url, options) => {
        requests.push({url, ...options});
        const response = url.endsWith("/jobs") ? {jobs:[]} : url.endsWith("/polygon-areas") && options.method === "POST"
            ? {polygonArea,bbox:[0,0,1,1],matched:1} : url.endsWith("/raster-calculations")
                ? {jobId:"d".repeat(32),operation:"raster.aggregate.v1",status:"queued",sources:{a:source},calculations:[{label:"Mean",expression:"mean(a)"}],area:{kind:"polygons",bounds:[0,0,1,1]},grid:null,progress:{},result:null} : {deleted:true};
        return new Response(JSON.stringify(response), {status:200,headers:{"Content-Type":"application/json"}});
    });
    const polygons = [{type:"Polygon",coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}];
    await api.uploadPolygonArea(polygons);
    const h = fixture(); const intent = h.intent({area:{kind:"polygonArea",polygonArea}});
    await api.submitCalculation({...intent,requestId:"r".repeat(32)});
    await api.discardPolygonArea(polygonArea.id);
    assert.equal(requests[0].url,"/api/processing/jobs");
    assert.deepEqual(JSON.parse(requests[1].body),{polygons});
    assert.equal(requests[1].headers["X-EOLab-Processing"],"1");
    const planned = JSON.parse(requests[2].body);
    assert.deepEqual(planned.polygonArea,polygonArea);
    assert.equal(planned.wholeRaster,undefined);
    assert.equal(planned.polygons,undefined);
    assert.equal(requests[3].method,"DELETE");
    h.storage.write({intent,jobId:"d".repeat(32),pending:null,cancelRequested:false});
    assert.deepEqual(h.storage.read().intent.area,intent.area);
    assert.ok([...h.data.values()][0].length<1000);
    await assert.rejects(api.submitCalculation({...intent,requestId:"r".repeat(32),area:{...intent.area,polygons}}),/Invalid polygon calculation area/);
});
