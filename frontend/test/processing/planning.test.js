import assert from "node:assert/strict";
import test from "node:test";
import { ProcessingApiClient, ProcessingRequestError } from "../../src/processing/api.js";

/** Let chained admission and snapshot promises settle. @return {Promise<void>} Microtask completion. */
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

test("planning and job observers share one event connection until the last subscriber leaves", () => {
    const streams = [];
    class Events {
        /** Capture the connection used by the client. */
        constructor() { streams.push(this); this.closed = false; }
        /** @param {string} type Event type. @param {Function} listener Listener. @return {void} */
        addEventListener(type, listener) { this.listener = listener; }
        /** @return {void} */
        removeEventListener() { this.listener = null; }
        /** @return {void} */
        close() { this.closed = true; }
    }
    const api = new ProcessingApiClient(null, Events);
    let planning = 0, jobs = 0;
    const stopPlanning = api.watchJobs(() => planning++);
    const stopJobs = api.watchJobs(() => jobs++);
    assert.equal(streams.length, 1);
    streams[0].listener({data:"{}"});
    assert.equal(planning, 1); assert.equal(jobs, 1);
    stopPlanning(); stopPlanning();
    streams[0].listener({data:"{}"});
    assert.equal(planning, 1); assert.equal(jobs, 2);
    assert.equal(streams[0].closed, false);
    stopJobs(); assert.equal(streams[0].closed, true);
    api.watchJobs(() => {})(); assert.equal(streams.length, 2);
});

/** Connect a queued plan to controlled HTTP and owner-scoped event hints.
 * @return {Object} Client, requests, cancellation and state controls.
 */
function fixture() {
    const requests = [];
    let state = "queued", changed, closed = false, id;
    const api = new ProcessingApiClient(async (url, options) => {
        requests.push({url, ...options});
        if (options.method === "DELETE") return {ok: true, json: async () => ({discarded: true})};
        id = url.split("/").at(-1);
        return {ok: true, json: async () => ({planId: id, status: state,
            result: state === "ready" ? {planId: id, value: 42} : null, error: null})};
    }, null);
    api.watchJobs = callback => { changed = callback; return () => { closed = true; }; };
    return {api, requests, abort: new AbortController(),
        notify: () => changed(), setState: value => { state = value; }, get closed() {return closed;} };
}

test("queued planning reacts to an SSE hint and fetches the authoritative result", async () => {
    const h = fixture(), progress = [];
    const result = h.api.preparePlan("raster-calculations", {a: 1}, h.abort.signal, value => progress.push(value));
    await flush();
    assert.deepEqual(progress, ["queued"]);
    assert.equal(h.requests.length, 1);
    h.setState("planning"); h.notify(); await flush();
    assert.deepEqual(progress, ["queued", "planning"]);
    h.setState("ready"); h.notify();
    const plan = await result;
    assert.equal(plan.value, 42);
    assert.deepEqual(plan.planningObservation, {sseHints: 2, sseRefreshes: 2, timerRefreshes: 0, readyResponse: "sse"});
    assert.equal(h.requests.filter(request => request.method === "POST").length, 1);
    assert.equal(h.requests.filter(request => request.method === "DELETE").length, 0);
    assert.equal(h.closed, true);
});

test("missing plan notifications retain two-second fallback polling", async context => {
    context.mock.timers.enable({apis: ["setTimeout"]});
    const h = fixture();
    const result = h.api.preparePlan("raster-clips", {}, h.abort.signal);
    await flush(); h.setState("ready");
    context.mock.timers.tick(1999); await flush();
    assert.equal(h.requests.length, 1);
    context.mock.timers.tick(1);
    const plan = await result;
    assert.equal(plan.value, 42);
    assert.deepEqual(plan.planningObservation, {sseHints: 0, sseRefreshes: 0, timerRefreshes: 1, readyResponse: "timer"});
    assert.equal(h.requests.length, 2);
});

test("superseding a waiting plan cancels its known identity and closes observation", async () => {
    const h = fixture();
    const result = h.api.preparePlan("raster-calculations", {}, h.abort.signal);
    await flush(); h.abort.abort();
    await assert.rejects(result, {name: "AbortError"});
    const first = h.requests[0].url.split("/").at(-1);
    assert.equal(h.requests.at(-1).url, `/api/processing/plans/${first}`);
    assert.equal(h.requests.at(-1).method, "DELETE");
    assert.equal(h.closed, true);
});

test("a lost admission response is recovered using the same client plan ID", async () => {
    const h = fixture(), fetch = h.api.fetch;
    h.setState("ready");
    h.api.fetch = async (url, options) => {
        if (options.method === "POST") { h.requests.push({url, ...options}); throw new TypeError("connection lost"); }
        return fetch(url, options);
    };
    const result = await h.api.preparePlan("raster-calculations", {}, h.abort.signal);
    assert.deepEqual(result.planningObservation, {sseHints: 0, sseRefreshes: 0, timerRefreshes: 0, readyResponse: "recovery"});
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests.every(request => request.url.endsWith(result.planId)));
});

test("an immediately ready admission is not attributed to polling or an earlier SSE hint", async () => {
    const h = fixture();
    h.setState("ready");
    const pending = h.api.preparePlan("raster-calculations", {}, h.abort.signal);
    h.notify();
    assert.deepEqual((await pending).planningObservation,
        {sseHints: 1, sseRefreshes: 0, timerRefreshes: 0, readyResponse: "submission"});
});

test("SSE received during a fallback read is retained for the next read without relabelling the current one", async context => {
    context.mock.timers.enable({apis: ["setTimeout"]});
    const h = fixture(), fetch = h.api.fetch;
    let firstRead = true;
    h.api.fetch = async (url, options) => {
        const response = await fetch(url, options);
        if (options.method === "GET" && firstRead) {
            firstRead = false;
            // This unrelated hint arrives after the timer has already prompted a GET.
            h.notify();
        }
        return response;
    };
    const pending = h.api.preparePlan("raster-calculations", {}, h.abort.signal);
    await flush();
    h.setState("ready");
    context.mock.timers.tick(2000);
    assert.deepEqual((await pending).planningObservation,
        {sseHints: 1, sseRefreshes: 0, timerRefreshes: 1, readyResponse: "timer"});
});

test("an admission that cannot be recovered is cancelled by its stable ID", async () => {
    const h = fixture(), fetch = h.api.fetch;
    h.api.fetch = async (url, options) => {
        if (options.method !== "DELETE") {h.requests.push({url, ...options}); throw new TypeError("connection lost");}
        return fetch(url, options);
    };
    await assert.rejects(h.api.preparePlan("raster-clips", {}, h.abort.signal), /connection lost/);
    const id = h.requests[0].url.split("/").at(-1);
    assert.ok(h.requests.every(request => request.url.endsWith(id)));
    assert.equal(h.requests.at(-1).method, "DELETE");
});

test("cancelling a capacity wait does not allocate a cancellation record", async () => {
    const h = fixture();
    h.api.fetch = async (url, options) => {
        h.requests.push({url, ...options});
        throw new ProcessingRequestError("Queue full", 429, "plan_queue_full");
    };
    const pending = h.api.preparePlan("raster-clips", {}, h.abort.signal);
    await flush(); h.abort.abort();
    await assert.rejects(pending, {name:"AbortError"});
    assert.equal(h.requests.length, 1);
    assert.equal(h.closed, true);
});

test("planning retries a full queue with Retry-After and the same plan identity", async context => {
    context.mock.timers.enable({apis:["setTimeout"]});
    const h=fixture(), fetch=h.api.fetch, progress=[];
    let attempts=0;
    h.setState("ready");
    h.api.fetch=async(url, options)=>{
        if(options.method==="POST" && ++attempts===1) {
            h.requests.push({url,...options});
            return new Response(JSON.stringify({detail:{code:"plan_queue_full",message:"Queue full"}}),
                {status:429,headers:{"Retry-After":"12"}});
        }
        return fetch(url,options);
    };
    const pending=h.api.preparePlan("raster-calculations",{},h.abort.signal,status=>progress.push(status));
    await flush(); assert.deepEqual(progress,["waiting-capacity"]);
    context.mock.timers.tick(11999); await flush(); assert.equal(attempts,1);
    context.mock.timers.tick(1001); await pending;
    assert.equal(attempts,2);
    assert.equal(h.requests[0].url,h.requests[1].url);
    assert.ok(h.requests.every(request=>request.method==="POST"));
});

test("unknown 429 and storage exhaustion remain explicit errors, not automatic retries", async () => {
    for(const code of ["storage_full","job_input_capacity","job_record_capacity",null]) {
        const h=fixture();
        h.api.fetch=async(url,options)=>{h.requests.push({url,...options});throw new ProcessingRequestError("Needs attention",429,code);};
        await assert.rejects(h.api.preparePlan("raster-calculations",{},h.abort.signal),/Needs attention/);
        assert.equal(h.requests.length,1);
    }
});

test("a server queue timeout releases the old plan and retries with a new identity",async context=>{
    context.mock.timers.enable({apis:["setTimeout"]});
    const requests=[];let attempts=0;
    const api=new ProcessingApiClient(async(url,options)=>{
        requests.push({url,...options});
        const id=url.split("/").at(-1);
        if(options.method==="DELETE") return Response.json({discarded:true});
        attempts++;
        return Response.json(attempts===1 ? {planId:id,status:"failed",error:{code:"plan_queue_timeout",detail:"Queue deadline"}}
            : {planId:id,status:"ready",result:{planId:id,value:42}});
    },null);
    const pending=api.preparePlan("raster-calculations",{},new AbortController().signal);
    await flush();assert.equal(requests.at(-1).method,"DELETE");
    context.mock.timers.tick(6000);assert.equal((await pending).value,42);
    assert.notEqual(requests[0].url,requests.at(-1).url);
    assert.equal(requests.length,3);
});
