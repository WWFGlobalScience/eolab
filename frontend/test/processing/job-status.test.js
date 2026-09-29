import test from "node:test";
import assert from "node:assert/strict";
import {ProcessingApiClient} from "../../src/processing/api.js";
import {ProcessingJobs} from "../../src/processing/jobs.js";

const clock = {setTimeout() {return 1;}, clearTimeout() {}};
const ids = Array.from({length: 251}, (_, i) => i.toString(16).padStart(32, "0"));
/** @param {string} jobId Public ID. @return {Object} Valid minimal queued calculation. */
const job = jobId => ({jobId, operation: "raster.aggregate.v1", status: "queued", progress: {}});

test("requested statuses use complete bounded batches, not recent history or individual reads", async () => {
    const requests = [];
    const api = new ProcessingApiClient(async (url, options) => {
        if (url.endsWith("/jobs")) return Response.json({jobs: []});
        assert.equal(url, "/api/processing/jobs/status");
        assert.equal(options.method, "POST");
        assert.equal(options.credentials, "same-origin");
        assert.equal(options.headers["X-EOLab-Processing"], "1");
        const batch = JSON.parse(options.body).jobIds;
        requests.push(batch);
        return Response.json({jobs: batch.filter(id => id !== ids[0]).map(job),
            unavailableJobIds: batch.includes(ids[0]) ? [ids[0]] : []});
    });
    const result = await api.readJobStatuses([...ids, ids[0]]);
    assert.deepEqual(requests.map(batch => batch.length), [100, 100, 51]);
    assert.deepEqual(result.jobs.map(j => j.jobId), ids.slice(1));
    assert.deepEqual(result.unavailableJobIds, [ids[0]]);
    assert.ok(api.diagnostics.events.filter(e => e.path === "/jobs/status").every(e => e.shared));
});

test("batch response must account for exactly the requested IDs", async () => {
    for (const response of [
        {jobs: [], unavailableJobIds: []},
        {jobs: [job(ids[1])], unavailableJobIds: []},
        {jobs: [job(ids[0])], unavailableJobIds: [ids[0]]},
        {jobs: [job(ids[0])]},
    ]) {
        const api = new ProcessingApiClient(async url => Response.json(url.endsWith("/jobs") ? {jobs: []} : response));
        await assert.rejects(api.readJobStatuses([ids[0]]), /processing status response/);
    }
});

test("unavailable tracked IDs do not suppress ready peers or continue polling forever", async () => {
    let requested;
    const jobs = new ProcessingJobs({
        readJobStatuses: async values => {
            requested = values;
            return {jobs: [{jobId: "ready", status: "ready"}], unavailableJobIds: ["missing"]};
        },
        listJobs: () => {throw Error("must not read history while tracking jobs");},
        getJob: () => {throw Error("must not read individual jobs");},
    }, clock);
    jobs.tracked.add("missing");
    jobs.accept({jobId: "missing", status: "running"});
    jobs.accept({jobId: "ready", status: "running"});
    await jobs.refresh();
    assert.deepEqual(requested, ["missing", "ready"]);
    assert.deepEqual(jobs.jobs, [{jobId: "ready", status: "ready"}]);
    assert.match(jobs.error, /unavailable/);
    assert.equal(jobs.tracked.size, 0);
    jobs.destroy();
});

test("a submission during a batch read is not mistaken for an unavailable job", async () => {
    let finish;
    const jobs = new ProcessingJobs({readJobStatuses: () => new Promise(resolve => {finish = resolve;})}, clock);
    jobs.accept({jobId: "a", status: "running"});
    const pending = jobs.refresh();
    jobs.tracked.add("b");
    jobs.accept({jobId: "b", status: "queued"});
    finish({jobs: [{jobId: "a", status: "ready"}], unavailableJobIds: []});
    await pending;
    assert.deepEqual(jobs.jobs.map(j => [j.jobId, j.status]), [["b", "queued"], ["a", "ready"]]);
    assert.equal(jobs.error, "");
    jobs.destroy();
});
