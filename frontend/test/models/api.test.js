import test from "node:test";
import assert from "node:assert/strict";
import { ProcessingApiClient } from "../../src/processing/api.js";
import { model, invocation, job, clipModel, clipResult, statisticsResult, seriesModel, timeSeriesResult, fileManifest } from "../../test-support/models/fixtures.js";

/** Compose the transport over recorded same-origin HTTP replies.
 * @param {Function} reply Return the requested response body.
 * @return {Object} Client and recorded HTTP requests.
 */
function fixture(reply) {
    const calls = [];
    const api = new ProcessingApiClient(async (url, options) => {
        calls.push({url, options});
        return new Response(JSON.stringify(url.endsWith("/jobs") ? {jobs: []} : reply(url, options)), {headers: {"Content-Type": "application/json"}});
    }, null);
    return {api, calls};
}

test("discovery, pagination and saved inputs establish a same-origin session", async () => {
    const h = fixture(url => url.endsWith("/models") ? {models: [model]} : url.endsWith("/invocation") ? invocation : {jobs: [job()], nextCursor: null});
    assert.equal((await h.api.discoverModels())[0].id, model.id);
    await h.api.listModelRuns("a+b/="); await h.api.readModelInvocation(job().jobId);
    assert.match(h.calls[2].url, /cursor=a%2Bb%2F%3D/);
    for (const {options} of h.calls) { assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store"); }
    assert.equal(h.calls.filter(call => call.url.endsWith("/jobs")).length, 1);
});

test("Habitat setup reads scientific options from its model-owned endpoint", async () => {
    const options = {defaultYear: 2018, minimumYear: 2015, maximumYear: 2019,
        grid: {crs: "EPSG:6933", pixelSize: [500, 500], origin: [0, 0], unit: "metre", approximate: false},
        datasets: [{label: "ERA5 daily aggregates", url: "https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_DAILY", roles: ["predictor"]}]};
    const h = fixture(() => options);
    assert.deepEqual(await h.api.getHabitatEarthEngineOptions(), options);
    assert.equal(h.calls[0].url, "/api/processing/models/habitat-condition/earth-engine-options");
    assert.equal(h.calls[0].options.method, "GET");
});

test("submission uses the immutable request key and normal Processing mutation header", async () => {
    const h = fixture(() => job()); const body = {requestId: "x".repeat(32), model: invocation.model, inputs: invocation.inputs};
    await h.api.submitModelRun(body);
    assert.equal(h.calls[1].url, "/api/processing/model-runs");
    assert.equal(h.calls[1].options.headers["X-EOLab-Processing"], "1");
    assert.deepEqual(JSON.parse(h.calls[1].options.body), body);
});

test("renewal uses the owned run endpoint and validates the returned job", async () => {
    const h = fixture(() => job());
    await h.api.renewModelRun(job().jobId);
    assert.equal(h.calls[1].url, `/api/processing/jobs/${job().jobId}/renew`);
    assert.equal(h.calls[1].options.method, "POST");
    assert.equal(h.calls[1].options.headers["X-EOLab-Processing"], "1");
    const broken = fixture(() => job({expiresAt: "invalid"}));
    await assert.rejects(broken.api.renewModelRun(job().jobId), /invalid/);
});

test("renaming changes only the name through the owned mutation endpoint", async () => {
    const renamed = job({name: "Cuba biomass", updatedAt: "2026-10-09T00:00:00Z"});
    const h = fixture(() => renamed);
    assert.deepEqual(await h.api.renameModelRun(renamed.jobId, renamed.name), renamed);
    assert.equal(h.calls[1].url, `/api/processing/jobs/${renamed.jobId}/name`);
    assert.equal(h.calls[1].options.method, "PATCH");
    assert.equal(h.calls[1].options.headers["X-EOLab-Processing"], "1");
    assert.deepEqual(JSON.parse(h.calls[1].options.body), {label: "Cuba biomass"});
    const unicode = job({name: "🌳".repeat(80)}), unicodeApi = fixture(() => unicode);
    assert.deepEqual(await unicodeApi.api.renameModelRun(unicode.jobId, unicode.name), unicode);
    for (const change of [{name: ""}, {name: "x".repeat(81)}, {nameTimestamp: "2026-10-08"}, {label: "Missing creation time"},
        {jobId: "2".repeat(32)}]) {
        const broken = fixture(() => ({...renamed, ...change}));
        await assert.rejects(broken.api.renameModelRun(renamed.jobId, "Cuba biomass"));
    }
});

test("model deletion requests Undo and scopes restoration and dismissal to that exact deletion", async () => {
    const deletionUndo = {deletionId: "d".repeat(32), expiresAt: "2099-01-01T00:00:00Z"};
    const deleted = job({status: "deleted", deletionUndo}), h = fixture(() => deleted);
    assert.deepEqual(await h.api.deleteModelRun(deleted.jobId), deleted);
    await h.api.undoModelDeletion(deleted.jobId, deletionUndo.deletionId);
    await h.api.dismissModelDeletion(deleted.jobId, deletionUndo.deletionId);
    assert.equal(h.calls[1].url, `/api/processing/jobs/${deleted.jobId}?undo=true`);
    assert.equal(h.calls[1].options.method, "DELETE");
    for (const [index, action] of [[2, "undo"], [3, "dismiss"]]) {
        assert.equal(h.calls[index].url, `/api/processing/jobs/${deleted.jobId}/deletion/${action}`);
        assert.deepEqual(JSON.parse(h.calls[index].options.body), {deletionId: deletionUndo.deletionId});
        assert.equal(h.calls[index].options.headers["X-EOLab-Processing"], "1");
    }
    for (const change of [{status: "ready"}, {deletionUndo: {...deletionUndo, expiresAt: "bad"}},
        {deletionUndo: {...deletionUndo, deletionId: "../other"}}]) {
        const broken = fixture(() => ({...deleted, ...change}));
        await assert.rejects(broken.api.deleteModelRun(deleted.jobId));
    }
});

test("model results use the existing numeric-row and download safety validation", async () => {
    const result = {...statisticsResult, url: `/api/processing/jobs/${job().jobId}/result`, provenanceUrl: `/api/processing/jobs/${job().jobId}/provenance`, rows: [{label: "Sum", expression: "sum(a)", state: "ok", value: "not-a-number", valueType: "float", aggregates: []}]};
    const h = fixture(() => job({status: "ready", expiresAt: "2099-01-01T00:00:00Z", result}));
    await assert.rejects(h.api.getJob(job().jobId), /invalid calculation result/);
    result.url = "https://untrusted.invalid/result";
    await assert.rejects(h.api.getJob(job().jobId), /download address/);
});

test("malformed model definitions and inconsistent progress are rejected", async () => {
    const h = fixture(() => ({models: [{...model, id: "../other"}]}));
    await assert.rejects(h.api.discoverModels(), /model identity/);
    const broken = fixture(() => job({progress: {completed: 4, total: 2}}));
    await assert.rejects(broken.api.getJob(job().jobId), /model run details/);
});

test("model progress accepts optional descriptions and bounded literal text for unfamiliar phases", async () => {
    for (const progress of [{phase: "historical_stage"}, ...[null, "Measuring habitat", "x".repeat(200), "🌳".repeat(200), "Checking <strong>habitat</strong>"]
        .map(description => ({phase: "unfamiliar_stage", description}))]) {
        const h = fixture(() => job({status: "running", progress}));
        assert.deepEqual((await h.api.getJob(job().jobId)).progress, progress);
    }
});

test("model progress rejects malformed or oversized descriptions", async () => {
    for (const description of [false, 0, {}, [], "", " \t\n", "x".repeat(201), "🌳".repeat(201)]) {
        const h = fixture(() => job({status: "running", progress: {phase: "unfamiliar_stage", description}}));
        await assert.rejects(h.api.getJob(job().jobId), /invalid model progress description/);
    }
});


test("raster model results validate native grids, file metadata and owned download links", async () => {
    const result = structuredClone(clipResult);
    const h = fixture(() => job({model: clipModel, status: "ready", expiresAt: "2099-01-01T00:00:00Z", result}));
    assert.equal((await h.api.getJob(job().jobId)).result.kind, "raster");
    for (const change of [{kind: "unknown"}, {mediaType: "text/html"}, {bytes: -1}, {sha256: "bad"}, {validPixels: 101}, {rows: []},
        {grid: {...clipResult.grid, width: 0}}, {url: "https://other.invalid/result"}]) {
        Object.assign(result, structuredClone(clipResult), change);
        await assert.rejects(h.api.getJob(job().jobId));
        delete result.rows;
    }
});

test("unknown recipe identities and output names use shared result validation", async () => {
    for (const output of [clipResult, statisticsResult]) {
        const result = {...output, name: "habitat_result", label: "Habitat output"};
        const h = fixture(() => job({model: {...model, id: "custom-habitat-recipe"}, status: "ready", expiresAt: "2099-01-01T00:00:00Z", result}));
        assert.deepEqual((await h.api.getJob(job().jobId)).result, result);
    }
});

test("multiple run files require scoped URLs, unique IDs and valid availability", async () => {
    let artifacts = fileManifest();
    const h = fixture(() => job({status: "ready", expiresAt: artifacts.expiresAt, result: clipResult, artifacts}));
    assert.deepEqual((await h.api.getJob(job().jobId)).artifacts, artifacts);
    for (const damage of [
        value => { value.files[0].url = "https://elsewhere.invalid/file"; },
        value => { value.files[0].url = value.files[0].url.replace(value.jobId, "f".repeat(32)); },
        value => { value.files.push({...value.files[0]}); },
        value => { value.files[0].bytes = -1; },
        value => { value.files[0].sha256 = "bad"; },
        value => { value.files[0].filename = "../other"; },
        value => { value.files[0].displayName = ""; },
        value => { value.files[0].displayName = "x".repeat(306); },
        value => { value.availability = "pending"; },
        value => { value.totalBytes = 1; },
    ]) {
        artifacts = fileManifest(); damage(artifacts);
        await assert.rejects(h.api.getJob(job().jobId));
    }
});

test("model responses require a file inventory even when files are pending or unavailable", async () => {
    for (const status of ["queued", "running", "failed", "expired"]) {
        const response = job({status}), h = fixture(() => response);
        assert.deepEqual((await h.api.getJob(response.jobId)).artifacts, response.artifacts);
    }
    for (const artifacts of [undefined, null]) {
        const h = fixture(() => job({artifacts}));
        await assert.rejects(h.api.getJob(job().jobId), /invalid result file availability/);
    }
});

test("more than 64 distinct run files are accepted and the last file is still validated", async () => {
    const artifacts = fileManifest(), source = artifacts.files[0];
    artifacts.files = Array.from({length: 65}, (_, index) => {
        const artifactId = index.toString(16).padStart(32, "0"), name = `intermediate_${index}`;
        return {...source, artifactId, name, filename: `${name}.tif`, role: "intermediate",
            label: `Intermediate ${index + 1}`,
            url: `/api/processing/jobs/${artifacts.jobId}/artifacts/${artifactId}`};
    });
    artifacts.totalBytes = artifacts.files.reduce((total, file) => total + file.bytes, artifacts.totalBytes);
    const h = fixture(() => job({status: "ready", expiresAt: artifacts.expiresAt, result: statisticsResult, artifacts}));
    assert.deepEqual((await h.api.getJob(job().jobId)).artifacts, artifacts);
    const lastFile = artifacts.files.at(-1);
    for (const change of [{url: lastFile.url.replace(artifacts.jobId, "f".repeat(32))}, {sha256: "bad"}]) {
        artifacts.files[artifacts.files.length - 1] = {...lastFile, ...change};
        await assert.rejects(h.api.getJob(job().jobId), /result file details|result file download address/);
    }
});

test("period-map result coverage survives API validation and rejects malformed saved coverage", async () => {
    const temporalCoverage = {unit: "K", observationCount: 3,
        firstObservation: "2000-01-01T00:00:00Z", lastObservation: "2000-01-03T12:00:00Z"};
    const result = {...clipResult, temporalCoverage};
    const h = fixture(() => job({status: "ready", expiresAt: "2099-01-01T00:00:00Z", result}));
    assert.deepEqual((await h.api.getJob(job().jobId)).result.temporalCoverage, temporalCoverage);
    for (const coverage of [null, {...temporalCoverage, observationCount: 0},
        {...temporalCoverage, lastObservation: "not-a-date"}]) {
        result.temporalCoverage = coverage;
        await assert.rejects(h.api.getJob(job().jobId), /invalid temporal coverage/);
    }
});

test("time-series recipes and completed CSV runs coexist with the existing model library and history", async () => {
    const result = structuredClone(timeSeriesResult);
    const run = job({model: seriesModel, status: "ready", expiresAt: "2099-01-01T00:00:00Z", result});
    const ordinaryRun = job({jobId: "2".repeat(32)});
    const h = fixture(url => url.endsWith("/models") ? {models: [model, seriesModel]} :
        url.includes("/model-runs?") ? {jobs: [ordinaryRun, run], nextCursor: null} : run);
    assert.deepEqual(await h.api.discoverModels(), [model, seriesModel]);
    assert.deepEqual((await h.api.listModelRuns()).jobs, [ordinaryRun, run]);
    assert.deepEqual((await h.api.getJob(run.jobId)).result, result);
    result.calculations = [{label: "Scaled mean", expression: "mean(a) * 2"}, {label: "Positive area", expression: "areaha(a > 0)"}];
    result.temporalCoverage.unit = "";
    assert.deepEqual((await h.api.getJob(run.jobId)).result, result);
    delete result.temporalCoverage;
    await assert.rejects(h.api.getJob(run.jobId), /invalid temporal coverage/);
});

test("time-series results require the current named-calculation contract", async () => {
    const result = {...timeSeriesResult, calculations: []};
    const h = fixture(() => job({status: "ready", expiresAt: "2099-01-01T00:00:00Z", result}));
    await assert.rejects(h.api.getJob(job().jobId), /invalid time-series calculations/);
});
