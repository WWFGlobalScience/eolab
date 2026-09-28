import test from "node:test";
import assert from "node:assert/strict";
import { ProcessingDiagnostics } from "../../src/processing/diagnostics.js";
import { ProcessingApiClient } from "../../src/processing/api.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";

/** Drain observer promise chains. @return {Promise<void>} Completion. */
async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); }

test("bounded traces retain shared transport activity and report truncation", () => {
    let now = 0;
    const trace = new ProcessingDiagnostics(() => ++now, 3);
    trace.record("ready-received", {jobId:"other"});
    trace.record("ready-received", {jobId:"mine"});
    trace.record("http-start", {planId:"other",inFlight:2});
    trace.record("sse-hint", {shared:true});
    const snapshot = trace.snapshot(0,"plan","mine");
    assert.equal(snapshot.partial, true);
    assert.equal(snapshot.events.length, 3);
    assert.equal(snapshot.events[0].afterSubmissionSeconds, .002);
    assert.equal(trace.snapshot(2,"plan","mine").partial, false);
});

test("HTTP diagnostics separate headers from body parsing and retain only fixed numeric server metrics", async () => {
    let now = 0;
    const api = new ProcessingApiClient(async () => {
        now = 100;
        return {ok:true,status:200,headers:new Headers({"Server-Timing":"processing;dur=90, jobRead;dur=50, secret;dur=1"}),
            json:async () => { now = 140; return {jobs:[]}; }};
    }, null);
    api.diagnostics = new ProcessingDiagnostics(() => now);
    await api.request("/jobs");
    const result = api.diagnostics.events.at(-1);
    assert.equal(result.seconds, .14);
    assert.equal(result.headersSeconds, .1);
    assert.equal(result.bodySeconds, .04);
    assert.deepEqual(result.serverTiming, {processing:.09,jobRead:.05});
    assert.equal(api.requestsInFlight, 0);
    api.fetch = async () => {throw Error("unavailable");};
    await assert.rejects(api.request("/jobs"));
    assert.equal(api.requestsInFlight, 0);
    assert.equal(api.diagnostics.events.at(-1).status, null);
});

test("observer records discarded ready responses, coalesced hints and the eventual accepted refresh", async () => {
    let resolve, changed, now = 0, reads = 0;
    const trace = new ProcessingDiagnostics(() => now);
    const ready = {jobId:"a",status:"ready"};
    const api = {diagnostics:trace,
        listJobs:() => ++reads === 1 ? new Promise(r => {resolve = r;}) : Promise.resolve([ready]),
        watchJobs:callback => {changed = callback; return () => {};}};
    const jobs = new ProcessingJobs(api);
    jobs.tracked.add("a"); jobs.accept({...ready,status:"running"});
    const pending = jobs.refresh();
    now = 100; changed();
    jobs.accept({jobId:"b",status:"queued"});
    now = 500; resolve([ready]);
    await pending; await flush();
    assert.equal(reads, 2);
    assert.equal(trace.events.filter(e => e.kind === "refresh-discarded").length, 1);
    assert.equal(trace.events.filter(e => e.kind === "refresh-coalesced").length, 1);
    assert.equal(trace.events.filter(e => e.kind === "ready-received").length, 2);
    assert.equal(trace.events.find(e => e.kind === "ready-accepted").trigger, "sse-follow-up");
    assert.equal(trace.events.find(e => e.kind === "refresh-finish").seconds, .5);
    jobs.destroy();
});

test("fallback records late timers and individual lookups without changing polling", async () => {
    let now = 0, callback;
    const trace = new ProcessingDiagnostics(() => now);
    const jobs = new ProcessingJobs({diagnostics:trace,listJobs:async()=>[],getJob:async()=>({jobId:"a",status:"ready"})},
        {setTimeout:fn=>{callback=fn;return 1;},clearTimeout:()=>{}});
    jobs.tracked.add("a"); jobs.schedule();
    now = 2700; callback(); await flush();
    assert.equal(trace.events.find(e => e.kind === "fallback-timer").lateSeconds, .7);
    assert.equal(trace.events.find(e => e.kind === "extra-job-read").jobId, "a");
    assert.equal(trace.events.find(e => e.kind === "ready-accepted").trigger, "timer");
    jobs.destroy();
});

test("connection and server timing events remain diagnostics, never completion signals", () => {
    let source, hints = 0;
    /** EventSource test double with explicit listener cleanup. */
    class Source {
        /** Capture this connection. */
        constructor() {source=this; this.listeners=new Map();}
        /** @param {string} name Event type. @param {Function} fn Listener. @return {void} */
        addEventListener(name, fn) {this.listeners.set(name,fn);}
        /** @param {string} name Event type. @return {void} */
        removeEventListener(name) {this.listeners.delete(name);}
        /** End the test connection. @return {void} */
        close() {}
    }
    const api = new ProcessingApiClient(undefined,Source);
    const close = api.watchJobs(()=>hints++);
    source.listeners.get("open")(); source.listeners.get("error")(); source.listeners.get("open")();
    const timing = source.listeners.get("timing");
    timing({data:'{"listenerToStreamSeconds":0.3,"previousSendSeconds":0.1}'});
    timing({data:'{"listenerToStreamSeconds":-1}'}); timing({data:'bad'});
    assert.equal(hints,0);
    assert.equal(api.diagnostics.events.filter(e=>e.kind==="sse-open").length,2);
    assert.equal(api.diagnostics.events.filter(e=>e.kind==="sse-server-timing").length,1);
    close(); assert.equal(source.listeners.size,0);
});
