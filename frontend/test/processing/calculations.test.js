import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import { CalculationExecutor } from "../../src/processing/calculation-executor.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingApiClient, ProcessingRequestError } from "../../src/processing/api.js";

const source = { collectionId: "rasters", itemId: "hfp", label: "Human footprint" };
const box = west => ({ kind: "selectedArea", selectedBounds: { west, south: 22, east: west + 1, north: 23 } });
const grid = { width: 100, height: 100, crs: "EPSG:3857", dtype: "float32", transform: [1,0,0,0,-1,0], nativeBlocks: 4, decodedBytes: 10000 };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };

/** Connect the executor to real recovery storage and job observation with controlled transport.
 * @param {Object} [overrides={}] API responses for lifecycle and failure scenarios.
 * @param {Map<string,string>} [data=new Map()] Persisted session contents.
 * @return {Object} Execution harness and observable API requests.
 */
function fixture(overrides = {}, data = new Map()) {
    const timers = new Map(); let serial = 0; let id = 0;
    const clock = { setTimeout(fn,delay) { timers.set(++serial,{fn,delay}); return serial; }, clearTimeout(key) { timers.delete(key); } };
    const requests = []; const server = new Map(); const plans = new Map();
    const storage = new CalculationSessionStorage({ getItem: key => data.get(key), setItem: (key,value) => data.set(key,value), removeItem: key => data.delete(key) });
    const api = {
        listJobs: async () => [...server.values()], getJob: async id => server.get(id),
        validateCalculation: async rows => { requests.push(["validate",rows]); return {valid:true}; },
        discardPlan: async id => { requests.push(["discard",id]); },
        planCalculation: async intent => {
            requests.push(["plan", intent]); const planId = String(++id).padStart(32,"0");
            plans.set(planId,intent);
            return {planId, grid, operation:"raster.aggregate.v1", expiresAt:"2099-01-01T00:00:00Z"};
        },
        submitCalculation: async submission => {
            requests.push(["submit",submission]);
            const intent = plans.get(submission.planId) ?? {source,area:box(77),calculations:[{label:"Mean",expression:"mean(a)"}]};
            const jobId = submission.planId;
            const job = {jobId,operation:"raster.aggregate.v1",status:"running", sources:{a:intent.source},calculations:intent.calculations,
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
    const options = {api,jobs,storage,onChange: state => { view.state=state; snapshots.push(state); },
        onActivity: area=>activity.push(area),requestId:()=>`request-${String(id).padStart(16,"0")}`};
    const controller = new CalculationExecutor(options);
    view.state=controller.snapshot;
    const intent = change => ({source,area:box(77),calculations:[{label:"Mean",expression:"mean(a)"}],...change});
    const click = west => controller.executeIntent(intent({area:box(west)}), true);
    const review = async () => {
        controller.canAutoSubmit=()=>false;
        controller.executeIntent(intent(),true);
        await flush();
        controller.canAutoSubmit=()=>true;
    };
    const tick = async delay => { const due=[...timers.entries()].filter(([,item])=>item.delay===delay); for(const [key,item]of due){timers.delete(key);item.fn();}await flush(); };
    const finish = async (status="ready",value="12.5") => {
        const old=server.get(controller.snapshot.current.jobId);
        server.set(old.jobId,{...old,status,result:status==="ready"?{url:`/api/processing/jobs/${old.jobId}/result`,provenanceUrl:`/api/processing/jobs/${old.jobId}/provenance`,rows:[{label:"Mean",expression:"mean(a)",value,valueType:"float",state:"ok",aggregates:[{function:"mean",matchedPixels:8,validPixels:8,invalidArithmeticPixels:0}]}]}:null});
        await jobs.refresh(); await flush();
    };
    const run = async automatic => { controller.executeIntent(intent(),automatic); await flush(); };
    return {controller,api,jobs,storage,view,requests,server,plans,tick,finish,run,activity,data,options,click,review,intent,snapshots};
}

test("execution snapshots remain busy through cancellation and replacement admission", async () => {
    const h = fixture();
    const initial = h.controller.snapshot;
    assert.equal(initial.admission, "ready");
    await h.run(true);
    const accepted = h.controller.snapshot;
    assert.equal(accepted.admission, "busy");
    assert.equal(accepted.settled, false);
    assert.equal(accepted.recovery.cancelRequested, false);
    assert.ok(Object.isFrozen(accepted));
    assert.ok(Object.isFrozen(accepted.recovery));
    assert.equal(accepted.recovery.pending, undefined, "submission identity stays private");
    assert.equal(accepted.record, undefined);
    assert.equal(accepted.desired, undefined);
    const offset = h.snapshots.length;
    h.click(80);
    await flush();
    assert.equal(h.controller.snapshot.recovery.cancelRequested, true);
    assert.equal(accepted.recovery.cancelRequested, false, "prior snapshots cannot change underneath a consumer");
    await h.finish("cancelled");
    assert.ok(h.snapshots.slice(offset).every(state => !state.settled && state.admission === "busy"));
    await h.finish();
    assert.equal(h.controller.snapshot.admission, "ready");
    assert.equal(h.controller.snapshot.settled, true);
    assert.deepEqual(h.controller.snapshot.resultIntent.area, box(80));
    assert.equal(initial.result, null);
});

test("failed submission retains exclusive admission until explicit recovery", async () => {
    const h = fixture(); const submit = h.api.submitCalculation;
    h.api.submitCalculation = async submission => { await submit(submission); throw Error("Response lost"); };
    await h.run(false);
    assert.equal(h.controller.snapshot.admission, "busy");
    assert.equal(h.controller.snapshot.settled, false);
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

test("intent is copied before asynchronous planning and no editor validation is invoked", async () => {
    const h = fixture(); const pending = deferred(); const plan = h.api.planCalculation;
    h.api.planCalculation = async intent => { await pending.promise; return plan(intent); };
    const input = h.intent();
    h.controller.executeIntent(input);
    input.calculations[0].expression = "sum(a)";
    input.area.selectedBounds.west = 80;
    pending.resolve(); await flush();
    assert.equal(h.requests.some(([kind]) => kind === "validate"), false);
    assert.equal(h.controller.snapshot.recovery.intent.calculations[0].expression, "mean(a)");
    assert.deepEqual(h.controller.snapshot.recovery.intent.area, box(77));
});

test("failed cancellation keeps the accepted job exclusive until recovery acknowledges it", async () => {
    const h = fixture(); await h.run(true);
    const cancel = h.api.cancelJob;
    h.api.cancelJob = async () => { throw Error("Cancellation response lost"); };
    h.click(80); await flush();
    assert.equal(h.controller.snapshot.recoverable, true);
    assert.equal(h.controller.snapshot.admission, "busy");
    assert.equal(h.controller.snapshot.recovery.cancelRequested, true);
    assert.equal(h.requests.filter(([kind]) => kind === "submit").length, 1);
    h.api.cancelJob = cancel;
    await h.controller.retry(); await flush();
    assert.equal(h.controller.snapshot.admission, "busy");
    await h.finish("cancelled");
    assert.equal(h.controller.snapshot.admission, "ready");
    assert.equal(h.requests.filter(([kind]) => kind === "submit").length, 1,
        "recovery does not automatically replay the failed replacement");
});

test("superseding an uncertain automatic submission persists cancellation before retry", async () => {
    const h = fixture(); const submit = h.api.submitCalculation;
    h.api.submitCalculation = async submission => { await submit(submission); throw Error("Response lost"); };
    await h.run(true);
    h.click(80); await flush();
    assert.equal(h.controller.snapshot.recovery.cancelRequested, true);
    h.api.submitCalculation = submit;
    await h.controller.retry(); await flush();
    assert.equal(h.controller.snapshot.current.status, "cancelling");
    await h.finish("cancelled");
    assert.equal(h.controller.snapshot.result, null);
});

test("double Calculate during size checking admits only one manual job", async () => {
    const response = deferred(); const h = fixture(); const original = h.api.planCalculation;
    h.api.planCalculation = async intent => { const plan = await original(intent); await response.promise; return plan; };
    h.controller.executeIntent(h.intent()); h.controller.executeIntent(h.intent());
    response.resolve(); await flush();
    assert.equal(h.requests.filter(r => r[0] === "plan").length, 1);
    assert.equal(h.requests.filter(r => r[0] === "submit").length, 1);
    assert.equal(h.controller.snapshot.recovery.automatic, false);

});

test("explicit Run freezes intent, publishes measured progress and inline result", async () => {
    const h=fixture();await h.run(false);
    assert.equal(h.view.state.current.progress.totalBlocks,4);
    assert.deepEqual(h.activity.at(-1),box(77));
    h.controller.invalidate();assert.equal(h.requests.filter(r=>r[0]==="cancel").length,0);
    await h.finish();assert.equal(h.view.state.result.result.rows[0].value,"12.5");
    assert.deepEqual(h.view.state.resultIntent.area,box(77));assert.equal(h.storage.read(),null);
    assert.equal(h.activity.at(-1),null);
});

test("follow clicks cancel old work and retain only the latest area until cancellation completes", async () => {
    const h=fixture();await h.run(true);h.click(78);h.click(79);
    await h.tick(650);assert.equal(h.requests.filter(r=>r[0]==="submit").length,1);
    assert.equal(h.requests.filter(r=>r[0]==="cancel").length,1);
    assert.equal(h.activity.at(-1),null);
    await h.finish("cancelled");
    assert.equal(h.requests.filter(r=>r[0]==="submit").length,2);
    assert.deepEqual(h.controller.snapshot.recovery.intent.area,box(79));
    await h.finish();assert.deepEqual(h.view.state.resultIntent.area,box(79));
});

test("a stale plan resolving after a newer box never submits and does not strand the latest box", async () => {
    const h=fixture();await h.run(true);await h.finish();
    const old=deferred();let signal;
    const original=h.api.planCalculation;
    h.api.planCalculation=(intent,s)=>{signal=s;return old.promise;};
    h.click(78);await h.tick(650);
    h.api.planCalculation=original;h.click(79);await h.tick(650);
    assert.equal(signal?.aborted ?? false, false);old.resolve({planId:"z".repeat(32)});await flush();
    assert.equal(h.requests.filter(r=>r[0]==="submit").length,2);
    assert.deepEqual(h.controller.snapshot.recovery.intent.area,box(79));
});

test("superseded HTTP planning drains before replacement and releases its returned identity", async () => {
    const h = fixture(); const response = deferred(); const calls = []; let busy = false;
    const client = new ProcessingApiClient(async (url, options) => {
        if (url.endsWith('/jobs')) return {ok:true,json:async()=>({jobs:[]})};
        calls.push([url, options]);
        if (options.method === 'DELETE') return {ok:true,json:async()=>({discarded:true})};
        if (busy) return {ok:false,status:429,json:async()=>({detail:{code:'plan_capacity',message:'Job planning is busy'}})};
        busy = true;
        // The server remains busy even if fetch rejects on a local abort.
        const aborted = new Promise((_, reject) => options.signal?.addEventListener('abort',
            () => reject(new DOMException('Superseded', 'AbortError')), {once:true}));
        return Promise.race([response.promise, aborted]);
    });
    h.api.planCalculation = client.planCalculation.bind(client);
    h.api.discardPlan = client.discardPlan.bind(client);
    h.controller.executeIntent(h.intent(),true); await flush();
    for (const west of [78,79,80]) { h.click(west); await h.tick(650); }
    assert.equal(calls.filter(([url])=>url.endsWith('/plan')).length, 1,
        'a browser abort must not free the server planning lane');
    assert.equal(h.controller.snapshot.admission !== "manual", true);
    const oldId = 'e'.repeat(32); busy = false;
    response.resolve({ok:true,json:async()=>({planId:oldId,grid,operation:'raster.aggregate.v1',expiresAt:'2099-01-01T00:00:00Z'})});
    // Subsequent planning uses the normal fixture once the old HTTP response drains.
    h.api.planCalculation = async intent => {
        assert.ok(calls.some(([url,options])=>url.endsWith(oldId)&&options.method==='DELETE'));
        h.plans.set('f'.repeat(32),intent);
        return {planId:'f'.repeat(32),grid,expiresAt:'2099-01-01T00:00:00Z'};
    };
    await flush();
    assert.equal(h.requests.filter(r=>r[0]==='submit').length,1);
    assert.deepEqual(h.controller.snapshot.recovery.intent.area,box(80));
});

test("completed plan release is acknowledged before a replacement uses the last owner slot", async () => {
    const h = fixture(); const release = deferred(); let occupied = true; let planCalls = 0;
    const client = new ProcessingApiClient(async (url, options) => {
        if (url.endsWith('/jobs')) return {ok:true,json:async()=>({jobs:[]})};
        if (options.method === 'DELETE') {
            await release.promise; occupied = false;
            return {ok:true,json:async()=>({discarded:true})};
        }
        planCalls++;
        if (occupied) return {ok:false,status:429,json:async()=>({detail:{code:'plan_capacity',message:'Too many plans'}})};
        return {ok:true,json:async()=>({planId:'f'.repeat(32),grid,operation:'raster.aggregate.v1',expiresAt:'2099-01-01T00:00:00Z'})};
    });
    await h.review();
    h.api.planCalculation = client.planCalculation.bind(client);
    h.api.discardPlan = client.discardPlan.bind(client);
    h.click(79); await h.tick(650);
    assert.equal(planCalls,0,'cleanup must finish before allocating another plan');
    release.resolve(); await flush();
    assert.equal(planCalls,1); assert.equal(h.controller.snapshot.admission !== "manual",true);
    assert.equal(h.requests.filter(r=>r[0]==='submit').length,1);
});

test("failed unused-plan cleanup is retained and retried before explicit replacement", async () => {
    const h = fixture(); await h.review();
    const original = h.api.discardPlan; let fail = true;
    h.api.discardPlan = async id => { if(fail)throw new Error('Release connection lost'); return original(id); };
    h.click(78); await h.tick(650);
    assert.equal(h.controller.snapshot.admission,"manual");
    assert.equal(h.requests.filter(r=>r[0]==='plan').length,1);
    assert.match(h.view.state.message,/Release connection lost/);
    fail=false;h.click(79);await h.tick(650);
    assert.equal(h.controller.snapshot.admission !== "manual",true);
    assert.equal(h.requests.filter(r=>r[0]==='submit').length,1);
    assert.deepEqual(h.controller.snapshot.recovery.intent.area,box(79));
});

test("destroy releases completed and late planning results without submitting", async () => {
    for (const pending of [false,true]) {
        const response=deferred(); const h=fixture();
        if(pending)h.api.planCalculation=()=>response.promise;
        await h.review();h.controller.destroy();
        if(pending)response.resolve({planId:'d'.repeat(32)});
        await flush();
        assert.equal(h.requests.filter(r=>r[0]==='discard').length,1);
        assert.equal(h.requests.filter(r=>r[0]==='submit').length,0);
    }
});

test("click during submission cancels its eventual accepted job before admitting a replacement", async () => {
    const h=fixture();const acceptance=deferred();const original=h.api.submitCalculation;
    h.api.submitCalculation=async value=>{const job=await original(value);await acceptance.promise;return job;};
    h.controller.executeIntent(h.intent(),true);await flush();
    h.click(79);await h.tick(650);
    assert.equal(h.storage.read().cancelRequested,true);
    acceptance.resolve();await flush();assert.equal(h.view.state.current.status,"cancelling");
    h.api.submitCalculation=original;await h.finish("cancelled");
    assert.deepEqual(h.controller.snapshot.recovery.intent.area,box(79));
});

test("uncertain submission persists its key and superseded cancellation through reload", async () => {
    const h=fixture();const original=h.api.submitCalculation;
    h.api.submitCalculation=async value=>{await original(value);throw new Error("Response lost");};
    await h.run(true);const saved=h.storage.read();assert.ok(saved.pending);assert.equal(h.view.state.recoverable,true);
    h.controller.destroy();h.api.submitCalculation=original;
    const recovered=new CalculationExecutor(h.options);await recovered.start();await flush();
    const submissions=h.requests.filter(r=>r[0]==="submit");assert.deepEqual(submissions[0][1],submissions[1][1]);
    assert.equal(recovered.snapshot.recovery.cancelRequested,true);assert.equal(h.server.get(saved.pending.planId).status,"cancelling");
});



test("a completed superseded job cannot replace the prior visible result", async () => {
    const h=fixture();await h.run(true);await h.finish("ready","1");const result=h.view.state.result;
    h.click(78);await h.tick(650);
    h.click(79);await h.finish("ready","999");
    assert.equal(h.view.state.result.jobId,result.jobId);
    assert.deepEqual(h.view.state.resultIntent.area,box(77));
});



test("capacity refusal pauses follow and errors preserve the last visible result", async () => {
    const h=fixture();await h.run(true);await h.finish();const result=h.view.state.result;
    h.api.planCalculation=async()=>{throw new ProcessingRequestError("Native work limit",422);};
    h.click(79);await h.tick(650);
    assert.equal(h.view.state.phase,"error");assert.equal(h.controller.snapshot.admission,"manual");
    assert.equal(h.view.state.result,result);assert.match(h.view.state.message,/Native work limit/);
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
        const previous = h.view.state.result;
        const client = new ProcessingApiClient(async url => url.endsWith("/jobs")
            ? { ok: true, json: async () => ({ jobs: [] }) }
            : { ok: false, status: 413, json: async () => ({ detail: { code, message } }) });
        h.api.planCalculation = client.planCalculation.bind(client);
        h.click(79);
        await h.tick(650);

        assert.equal(h.controller.snapshot.admission, "manual");
        assert.equal(h.view.state.message, `${message} Click Calculate or select a new sampling box to retry.`);
        assert.equal(h.view.state.result, previous);
        assert.equal(h.requests.filter(request => request[0] === "submit").length, 1);
    });
}

test("expired estimates refresh automatically and unavailable storage refuses submission", async () => {
    const h=fixture();await h.review();h.view.state.plan.expiresAt="2000-01-01";
    await h.controller.executeIntent(h.intent());await flush();
    assert.equal(h.requests.filter(r=>r[0]==="plan").length,2);
    assert.equal(h.requests.filter(r=>r[0]==="submit").length,1);
    await h.finish();
    h.controller.storage=new CalculationSessionStorage(null);await h.controller.executeIntent(h.intent());await flush();
    assert.equal(h.requests.filter(r=>r[0]==="submit").length,1);assert.match(h.view.state.message,/storage/);
});

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

test("stopping planning releases its late result and settles the execution lane", async () => {
    const response=deferred();const h=fixture({planCalculation:()=>response.promise});
    await h.review();h.controller.stop();
    response.resolve({planId:"x".repeat(32)});await flush();
    assert.equal(h.view.state.phase,"idle");assert.equal(h.view.state.plan,null);assert.equal(h.view.state.settled,true);
});



test("a used review is released after acceptance; failed release is recoverable without resubmitting", async () => {
    const h=fixture({discardPlan:async()=>{throw new Error("Connection lost");}});
    await h.run(false);assert.equal(h.view.state.recoverable,true);
    assert.ok(h.storage.read().releasePlanId);assert.equal(h.requests.filter(r=>r[0]==="submit").length,1);
    h.api.discardPlan=async()=>({discarded:true});void h.controller.retry();await flush();
    assert.equal(h.storage.read().releasePlanId,null);
    assert.equal(h.requests.filter(r=>r[0]==="submit").length,1);
});

test("card confirmation reuses only an unexpired plan for the complete reviewed intent", async () => {
    const changes = [
        {},
        { source: {...source,itemId:"other"} },
        { area:box(80) },
        { area:{kind:"catalogSelection",catalogSelection:CATALOG_SELECTION} },
        { calculations:[{label:"Mean",expression:"mean(a + 1)"}] },
        { calculations:[{label:"Renamed",expression:"mean(a)"}] },
        { calculations:[{label:"Mean",expression:"mean(a)"},{label:"Min",expression:"min(a)"}] },
        { targetChunkPixels:1048576 },
    ];
    for (const change of changes) {
        const h=fixture();await h.review();
        const reviewed=h.controller.snapshot.plan;
        h.controller.executeIntent({...h.intent(),...change});await flush();
        const reused=Object.keys(change).length===0;
        assert.equal(h.requests.filter(r=>r[0]==="plan").length,reused?1:2);
        assert.equal(h.storage.read().pending,null);
        await h.finish(); assert.equal(h.controller.snapshot.resultTiming.planReused,reused);
        assert.equal(h.requests.find(r=>r[0]==="submit")[1].planId===reviewed.planId,reused);
        assert.ok(h.requests.some(r=>r[0]==="discard"&&r[1]===reviewed.planId));
    }
    const h=fixture();await h.review();
    const expired=h.controller.snapshot.plan;expired.expiresAt="2000-01-01";
    h.controller.executeIntent(h.intent());await flush();
    assert.equal(h.requests.filter(r=>r[0]==="plan").length,2);
    await h.finish(); assert.equal(h.controller.snapshot.resultTiming.planReused,false);
    assert.ok(h.requests.findIndex(r=>r[0]==="discard"&&r[1]===expired.planId)<h.requests.findIndex(r=>r[0]==="submit"));
});

test("server rejection of a reused plan does not submit a replacement or accept stale work", async () => {
    const h=fixture();await h.review();
    h.api.submitCalculation=async()=>{throw new ProcessingRequestError("The raster changed. Create a new plan.",409);};
    h.controller.executeIntent(h.intent());await flush();
    assert.equal(h.requests.filter(r=>r[0]==="plan").length,1);
    assert.equal(h.controller.snapshot.recovery,null);
    assert.equal(h.controller.snapshot.admission,"manual");
    assert.match(h.view.state.message,/raster changed/);
});
