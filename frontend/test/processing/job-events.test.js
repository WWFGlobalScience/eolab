import test from "node:test";
import assert from "node:assert/strict";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingApiClient } from "../../src/processing/api.js";

const tick = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r=>resolve=r); return {promise,resolve}; };
function clock() { return {next:0,timers:new Map(),setTimeout(fn,ms) { const id=++this.next; this.timers.set(id,{fn,ms}); return id; },clearTimeout(id) {this.timers.delete(id);}}; }

test("one shared event stream refreshes clips and calculations while keeping two-second fallback", async () => {
    const timer=clock(); let changed, opens=0, closes=0, reads=0;
    let state=[{jobId:"clip",status:"running"},{jobId:"calculation",status:"queued"}];
    const jobs=new ProcessingJobs({listJobs:async()=>{reads++;return state;},watchJobs:callback=>{opens++;changed=callback;return ()=>closes++;}},timer);
    await jobs.refresh(); jobs.accept(state[1]);
    assert.equal(opens,1); assert.equal([...timer.timers.values()][0].ms,2000);
    state=state.map(job=>({...job,status:"ready"})); changed(); await tick();
    assert.equal(reads,2); assert.deepEqual(jobs.jobs,state); assert.equal(closes,1);
    assert.equal([...timer.timers.values()][0].ms,30000);
    jobs.destroy(); changed(); await tick(); assert.equal(reads,2);
});

test("notification during an in-flight read forces one follow-up and cannot lose a ready result", async () => {
    const timer=clock(), pending=deferred(); let changed,reads=0;
    const queued={jobId:"a",status:"queued"},ready={...queued,status:"ready"};
    const jobs=new ProcessingJobs({listJobs:()=>++reads===1?pending.promise:Promise.resolve([ready]),watchJobs:callback=>{changed=callback;return ()=>{};}},timer);
    jobs.accept(queued); const first=jobs.refresh();
    for(let i=0;i<100;i++) changed();
    assert.equal(reads,1);
    pending.resolve([queued]); await first; await tick();
    assert.equal(reads,2); assert.equal(jobs.jobs[0].status,"ready");
    jobs.destroy();
});

test("missing events, unsupported SSE and recovery still poll at two seconds", async () => {
    const timer=clock(); let reads=0;
    const jobs=new ProcessingJobs({listJobs:async()=>[{jobId:"a",status:++reads===1?"running":"ready"}]},timer);
    await jobs.refresh(); const fallback=[...timer.timers.values()][0];
    assert.equal(fallback.ms,2000); fallback.fn(); await tick();
    assert.equal(jobs.jobs[0].status,"ready"); jobs.destroy();
});

test("a new submission preserves itself without delaying another job's ready result", async () => {
    const pending = deferred(), timer = clock();
    const jobs = new ProcessingJobs({listJobs: () => pending.promise}, timer);
    jobs.accept({jobId: "old-history", status: "ready"});
    jobs.accept({jobId: "a", status: "running"});
    const refresh = jobs.refresh();
    const submitted = {jobId: "b", status: "queued"};
    jobs.accept(submitted);
    const ready = {jobId: "a", status: "ready"};
    pending.resolve([ready]);
    await refresh;
    assert.deepEqual(jobs.jobs, [submitted, ready]);
    // History absent from the next authoritative response is still removed.
    await jobs.refresh();
    assert.deepEqual(jobs.jobs, [ready]);
    jobs.destroy();
});

for (const action of ["cancel", "delete"]) {
    test(`${action} protects only the changed job from an older list response`, async () => {
        const pending = deferred(), timer = clock();
        const updated = {jobId: "a", status: action === "cancel" ? "cancelling" : "deleted"};
        const jobs = new ProcessingJobs({listJobs: () => pending.promise,
            cancelJob: async () => updated, deleteJob: async () => updated}, timer);
        jobs.accept({jobId: "a", status: "running"});
        jobs.accept({jobId: "b", status: "running"});
        const refresh = jobs.refresh();
        const mutation = jobs.action("a", action);
        await tick();
        const ready = {jobId: "b", status: "ready"};
        pending.resolve([{jobId: "a", status: "ready"}, ready]);
        await Promise.all([refresh, mutation]);
        assert.deepEqual(jobs.jobs, [updated, ready]);
        jobs.destroy();
    });
}

test("local changes during a tracked-job lookup protect only that job", async () => {
    const pending = deferred(), timer = clock();
    const ready = {jobId: "a", status: "ready"};
    const jobs = new ProcessingJobs({listJobs: async () => [ready], getJob: () => pending.promise}, timer);
    jobs.tracked.add("b");
    jobs.accept({jobId: "a", status: "running"});
    jobs.accept({jobId: "b", status: "running"});
    const refresh = jobs.refresh();
    await tick();
    const cancelled = {jobId: "b", status: "cancelled"};
    jobs.accept(cancelled);
    pending.resolve({jobId: "b", status: "running"});
    await refresh;
    assert.deepEqual(jobs.jobs, [cancelled, ready]);
    jobs.destroy();
});

test("destroy closes a live stream and drops a racing notification and read", async () => {
    const timer=clock(), pending=deferred(); let changed,closed=0;
    const jobs=new ProcessingJobs({listJobs:()=>pending.promise,watchJobs:callback=>{changed=callback;return ()=>closed++;}},timer);
    jobs.accept({jobId:"a",status:"running"}); changed(); jobs.destroy(); changed();
    pending.resolve([]); await tick();
    assert.equal(closed,1); assert.equal(timer.timers.size,0); assert.equal(jobs.jobs.length,1);
});

test("EventSource accepts only the fixed hint and owns no results or session identifiers", () => {
    let instance,changed=0;
    class Source {
        constructor(url) {instance=this;this.url=url;this.listeners=new Map();}
        addEventListener(name,fn) {this.listeners.set(name,fn);}
        removeEventListener(name,fn) {assert.equal(this.listeners.get(name),fn);this.listeners.delete(name);}
        close() {this.closed=true;}
    }
    const api=new ProcessingApiClient(()=>{throw Error("no fetch on subscription");},Source);
    const close=api.watchJobs(()=>changed++);
    assert.equal(instance.url,"/api/processing/events");
    const hint=instance.listeners.get("changed");
    hint({data:'{"jobId":"untrusted"}'}); assert.equal(changed,0);
    hint({data:"{}"}); hint({data:"{}"}); assert.equal(changed,2); // Initial/reconnect frames refresh too.
    close(); assert.equal(instance.closed,true); assert.equal(instance.listeners.size,0);
    hint({data:"{}"}); close(); assert.equal(changed,2);
    assert.equal(new ProcessingApiClient(undefined,null).watchJobs(()=>{}),null);
    assert.equal(new ProcessingApiClient(undefined,class {constructor(){throw Error("disabled");}}).watchJobs(()=>{}),null);
});
