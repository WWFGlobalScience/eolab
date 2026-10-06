import assert from "node:assert/strict";
import test from "node:test";
import { ProcessingApiClient, ProcessingRequestError } from "../../src/processing/api.js";
import { CalculationRequests } from "../../src/processing/calculation-requests.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";

/** @param {number} n Raster identity. @return {Object} Independent valid submission. */
function submission(n) {
    return {requestId: `request-${String(n).padStart(16, "0")}`, source: {collectionId: "rasters", itemId: `r${n}`, label: `Raster ${n}`},
        area: {kind: "wholeRaster"}, calculations: [{label: "Mean", expression: "mean(a)"}]};
}
/** @param {number} n Identifier. @return {Object} Accepted queued job. */
function job(n) { return {jobId: String(n + 1).padStart(32, "0"), status: "queued", operation: "raster.aggregate.v1", progress: {}}; }
/** @return {Promise<void>} Settle queued microtasks and promise continuations. */
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

test("completed submission results use one batch request and only pending jobs open events", async () => {
    for (const statuses of [["ready", "ready"], ["ready", "queued"], ["failed", "ready"]]) {
        const paths = [], streams = [];
        /** Event transport that records subscriptions without emitting hints. */
        class Events {
            /** @param {string} path Event URL. */
            constructor(path) { streams.push(path); }
            /** @param {string} name Event name. @param {Function} callback Listener. @return {void} */
            addEventListener(name, callback) {}
            /** @param {string} name Event name. @param {Function} callback Listener. @return {void} */
            removeEventListener(name, callback) {}
            /** @return {void} Release the test transport. */
            close() {}
        }
        const api = new ProcessingApiClient(async (path, options) => {
            paths.push(path);
            if (path.endsWith("/jobs")) return Response.json({jobs: []});
            assert.equal(path, "/api/processing/raster-calculations/batch");
            const items = JSON.parse(options.body).items;
            return Response.json({items: items.map((item, index) => {
                const value = {...job(index), status: statuses[index], error: {code: "source_unavailable", detail: "Unavailable"}};
                if (value.status === "ready") value.result = {
                    url: `/api/processing/jobs/${value.jobId}/result`, provenanceUrl: `/api/processing/jobs/${value.jobId}/provenance`,
                    rows: [{label: "Mean", expression: "mean(a)", state: "ok", value: "12.5", valueType: "float", unit: null, aggregates: []}],
                };
                return {index, job: value};
            })});
        }, Events);
        await api.ensureSession(); paths.length = 0;
        const data = new Map(); let key = 0;
        const storage = new CalculationSessionStorage({getItem: k => data.get(k), setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k)});
        const jobs = new ProcessingJobs(api, {setTimeout: () => 1, clearTimeout: () => {}});
        const requests = new CalculationRequests({api, jobs, storage, requestId: () => submission(key++).requestId});
        const clients = [0,1].map(i => requests.createClient(`raster-series:${i}`, () => {}));
        clients.forEach((client,i) => client.submit(submission(i)));
        await flush(); await flush();
        assert.deepEqual(paths, ["/api/processing/raster-calculations/batch"]);
        assert.equal(streams.length, statuses.includes("queued") ? 1 : 0);
        assert.equal(jobs.tracked.size, statuses.filter(state => state === "queued").length);
        for (const [i, state] of statuses.entries()) if (state === "ready") {
            assert.equal(clients[i].snapshot.completedJob.result.rows[0].value, "12.5");
            assert.equal(clients[i].snapshot.currentJob, null);
            const events = clients[i].snapshot.completedTimings.deliveryDiagnostics.events;
            assert.equal(events.filter(event => event.kind === "http-finish").length, 1);
            assert.equal(events.find(event => event.kind === "ready-received").trigger, "submission");
        }
        requests.destroy(); jobs.destroy();
    }
});

test("25 submissions use one HTTP batch; larger stacks split without dropping rasters", async () => {
    for (const size of [25, 64, 125]) {
        const batches = [];
        const api = new ProcessingApiClient(async (path, options) => {
            if (path.endsWith("/jobs")) return Response.json({jobs: []});
            assert.equal(path, "/api/processing/raster-calculations/batch");
            assert.equal(options.headers["X-EOLab-Processing"], "1");
            const items = JSON.parse(options.body).items;
            batches.push(items);
            return Response.json({items: items.map((item, index) => ({index, job: job(Number(item.sources.a.itemId.slice(1)))})).reverse()});
        });
        const results = await Promise.all(Array.from({length: size}, (_, i) => api.submitCalculation(submission(i))));
        assert.equal(batches.length, Math.ceil(size / 50));
        assert.ok(batches.every(items => items.length <= 50));
        assert.deepEqual(batches.flat().map(item => item.requestId), Array.from({length: size}, (_, i) => submission(i).requestId));
        assert.deepEqual(results, Array.from({length: size}, (_, i) => job(i)));
    }
});

test("partial acceptance separates job, validation and capacity outcomes", async () => {
    const api = new ProcessingApiClient(async path => Response.json(path.endsWith("/jobs") ? {jobs: []} : {items: [
        {index: 2, error: {status: 429, code: "queue_full", message: "Busy", retryAfterSeconds: 5}},
        {index: 0, job: job(0)},
        {index: 1, error: {status: 422, code: "invalid_calculation", message: "Invalid formula", retryAfterSeconds: null}},
    ]}));
    const results = await Promise.allSettled([0, 1, 2].map(i => api.submitCalculation(submission(i))));
    assert.deepEqual(results[0].value, job(0));
    assert.equal(results[1].reason.status, 422);
    assert.equal(results[1].reason.isCapacityRejection, false);
    assert.equal(results[2].reason.isCapacityRejection, true);
    assert.equal(results[2].reason.retryAfterSeconds, 5);
});

test("incomplete replies remain uncertain and oversized items do not block neighbors", async () => {
    const api = new ProcessingApiClient(async path => Response.json(path.endsWith("/jobs") ? {jobs: []} : {items: []}));
    const results = await Promise.allSettled([0, 1].map(i => api.submitCalculation(submission(i))));
    assert.ok(results.every(result => result.reason instanceof Error && !(result.reason instanceof ProcessingRequestError)));
    await assert.rejects(api.submitCalculation({...submission(2), calculations: [{label: "x".repeat(17000), expression: "mean(a)"}]}),
        error => error.status === 413);
});

test("executors retain batch retry keys after lost replies and cancel only the superseded raster", async () => {
    const server = new Map(), batches = [], cancellations = [];
    let loseResponse = true;
    const api = new ProcessingApiClient(async (path, options) => {
        if (path.endsWith("/jobs")) return Response.json({jobs: [...server.values()]});
        if (path.endsWith("/jobs/status")) {
            const ids = JSON.parse(options.body).jobIds;
            return Response.json({jobs: [...server.values()].filter(item => ids.includes(item.jobId)), unavailableJobIds: []});
        }
        if (path.endsWith("/cancel")) {
            const id = path.split("/").at(-2);
            cancellations.push(id);
            const value = [...server.values()].find(item => item.jobId === id);
            value.status = "cancelled";
            return Response.json(value);
        }
        const items = JSON.parse(options.body).items;
        batches.push(items);
        const result = items.map((item, index) => {
            if (!server.has(item.requestId)) server.set(item.requestId, job(server.size));
            return {index, job: server.get(item.requestId)};
        });
        if (loseResponse) { loseResponse = false; throw new Error("Response lost"); }
        return Response.json({items: result});
    }, undefined);
    const data = new Map(); let key = 0;
    const storage = new CalculationSessionStorage({getItem: k => data.get(k), setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k)});
    const jobs = new ProcessingJobs(api, {setTimeout: () => 1, clearTimeout: () => {}});
    const requests = new CalculationRequests({api, jobs, storage, requestId: () => submission(key++).requestId});
    const clients = [0,1].map(i => requests.createClient(`raster-series:${i}`, () => {}));
    clients.forEach((client,i) => client.submit(submission(i)));
    await flush();
    assert.ok(clients.every(client => client.snapshot.recoverable));
    clients[0].stop();
    await Promise.all(clients.map(client => client.retry()));
    await flush();
    assert.equal(server.size, 2);
    assert.deepEqual(batches[1].map(item => item.requestId), batches[0].map(item => item.requestId));
    assert.deepEqual(cancellations, [job(0).jobId]);
    assert.equal(clients[1].snapshot.currentJob.jobId, job(1).jobId);
    requests.destroy(); jobs.destroy();
});
