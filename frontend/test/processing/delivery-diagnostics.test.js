import test from "node:test";
import assert from "node:assert/strict";
import { ProcessingDiagnostics, readRequestNetworkTiming, captureRequestNetworkTiming } from "../../src/processing/diagnostics.js";
import { ProcessingApiClient } from "../../src/processing/api.js";


/** Adapt controlled list fixtures to the batch transport contract. */
class TestJobs extends ProcessingJobs {
    /** @param {Object} api Test transport. @param {Object} [timer] Test clock. */
    constructor(api, timer) {
        super({
            /** @param {string[]} ids Requested IDs. @return {Promise<Object>} Owned statuses. */
            async readJobStatuses(ids) {
                const records = await api.listJobs();
                return {jobs: records.filter(job => ids.includes(job.jobId)),
                    unavailableJobIds: ids.filter(id => !records.some(job => job.jobId === id))};
            }, ...api,
        }, timer);
    }
}
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

test("network timings match the response ID rather than the most recent identical URL", () => {
    const id = "a".repeat(32);
    const resource = {initiatorType: "fetch", serverTiming: [{name: "requestId", description: id}],
        startTime: 100, requestStart: 130, responseStart: 230, responseEnd: 250,
        domainLookupStart: 100, domainLookupEnd: 110, connectStart: 110, connectEnd: 125,
        secureConnectionStart: 115, nextHopProtocol: "h2", encodedBodySize: 30, decodedBodySize: 100};
    const clock = {getEntriesByType: () => [resource, {...resource, requestStart: 999,
        serverTiming: [{name: "requestId", description: "b".repeat(32)}]}]};
    assert.deepEqual(readRequestNetworkTiming(id, 260, clock), {
        beforeRequestSeconds: .03, dnsSeconds: .01, connectSeconds: .015, tlsSeconds: .01,
        firstByteSeconds: .1, downloadSeconds: .02, afterDownloadSeconds: .01,
        protocol: "h2", encodedBytes: 30, decodedBytes: 100,
    });
    assert.equal(readRequestNetworkTiming("c".repeat(32), 260, clock), null);
    assert.equal(readRequestNetworkTiming(id, 260, {}), null);
    assert.equal(readRequestNetworkTiming(id, 260, {getEntriesByType: () => {throw Error();}}), null);
});

test("resource observers release subscriptions even when there is no response ID", context => {
    let disconnected = 0, observed = 0;
    const original = globalThis.PerformanceObserver;
    context.after(() => { if (original) globalThis.PerformanceObserver = original; else delete globalThis.PerformanceObserver; });
    globalThis.PerformanceObserver = class {
        observe() { observed++; }
        takeRecords() { return []; }
        disconnect() { disconnected++; }
    };
    const finish = captureRequestNetworkTiming();
    assert.equal(finish(null, 100), null);
    assert.equal(observed, 1);
    assert.equal(disconnected, 1);
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

test("observer accepts ready results on the first response despite another submission and coalesced hints", async () => {
    let resolve, changed, now = 0, reads = 0;
    const trace = new ProcessingDiagnostics(() => now);
    const ready = {jobId:"a",status:"ready"};
    const api = {diagnostics:trace,
        listJobs:() => ++reads === 1 ? new Promise(r => {resolve = r;}) : Promise.resolve([ready]),
        watchJobs:callback => {changed = callback; return () => {};}};
    const jobs = new TestJobs(api);
    jobs.tracked.add("a"); jobs.accept({...ready,status:"running"});
    const pending = jobs.refresh();
    now = 100; changed();
    jobs.accept({jobId:"b",status:"queued"});
    now = 500; resolve([ready]);
    await pending; await flush();
    assert.equal(reads, 2);
    assert.equal(trace.events.filter(e => e.kind === "refresh-discarded").length, 0);
    assert.equal(trace.events.filter(e => e.kind === "refresh-coalesced").length, 1);
    assert.equal(trace.events.filter(e => e.kind === "ready-received").length, 2);
    assert.equal(trace.events.find(e => e.kind === "ready-accepted").trigger, "explicit");
    assert.equal(trace.events.find(e => e.kind === "ready-accepted").atMs,
        trace.events.find(e => e.kind === "ready-received").atMs);
    assert.equal(trace.events.find(e => e.kind === "refresh-finish").seconds, .5);
    jobs.destroy();
});

test("diagnostics count skipped same-job updates without discarding unrelated results", async () => {
    let resolve;
    const trace = new ProcessingDiagnostics();
    const jobs = new TestJobs({diagnostics: trace, listJobs: () => new Promise(r => { resolve = r; })});
    jobs.tracked.add("a"); jobs.tracked.add("b");
    const pending = jobs.refresh();
    jobs.accept({jobId: "a", status: "deleted"});
    resolve([{jobId: "a", status: "ready"}, {jobId: "b", status: "ready"}]);
    await pending;
    assert.deepEqual(trace.events.filter(e => e.kind === "job-update-skipped").map(e => e.jobId), ["a"]);
    assert.deepEqual(trace.events.filter(e => e.kind === "ready-accepted").map(e => e.jobId), ["b"]);
    assert.equal(trace.events.filter(e => e.kind === "refresh-discarded").length, 0);
    jobs.destroy();
});

test("fallback records late timers and uses one batch lookup", async () => {
    let now = 0, callback;
    const trace = new ProcessingDiagnostics(() => now);
    const jobs = new TestJobs({diagnostics:trace,listJobs:async()=>[{jobId:"a",status:"ready"}]},
        {setTimeout:fn=>{callback=fn;return 1;},clearTimeout:()=>{}});
    jobs.tracked.add("a"); jobs.schedule();
    now = 2700; callback(); await flush();
    assert.equal(trace.events.find(e => e.kind === "fallback-timer").lateSeconds, .7);
    assert.equal(trace.events.some(e => e.kind === "extra-job-read"), false);
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
