import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ModelsView } from "../../src/models/view.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { ModelsController } from "../../src/models/controller.js";
import { VectorFilterControls } from "../../src/vector/filter-controls.js";
import { createVectorMapLayerAdapter } from "../../src/vector/map-layer-adapter.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingRequestError } from "../../src/processing/api.js";
import { captureModelSubmission, createModelDraft, modelSourceKey, modelViewportArea } from "../../src/models/inputs.js";
import { model, raster, area, invocation, selection, job, clipModel, seriesModel, timeSeriesResult, fileManifest } from "../../test-support/models/fixtures.js";

/** Compose the real controller and observer with controllable boundary responses.
 * @param {Object} [overrides={}] API behavior replacements.
 * @param {Object|null} [viewOverride=null] Optional real view for boundary tests.
 * @return {Object} Component and recorded user-visible effects.
 */
function fixture(overrides = {}, viewOverride = null) {
    const values = new Map(); const submitted = []; const cancelled = []; const filterRequests = []; const mapFilters = [];
    const api = {discoverModels: async () => [model], listModelRuns: async () => ({jobs: [], nextCursor: null}),
        getJob: async () => job(), readModelInvocation: async () => structuredClone(invocation),
        submitModelRun: async value => { submitted.push(value); return job(); },
        cancelJob: async id => { cancelled.push(id); return job({status: "cancelled"}); },
        readJobStatuses: async () => ({jobs: [job({status: "cancelled"})], unavailableJobIds: []}), listJobs: async () => [], ...overrides};
    const clock = {setTimeout: () => 1, clearTimeout: () => {}};
    const jobs = new ProcessingJobs(api, clock);
    const context = {rasters: [structuredClone(raster)], area: structuredClone(area)};
    let sequence = 0; let handlers;
    const view = viewOverride ?? {bind: value => { handlers = value; }, render: () => {}, focusHeading: () => {}, destroy: () => {}, getVectorFilterHost: () => ({id: "inline-host"})};
    const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
    const controller = new ModelsController({api, jobs, view, storage, clock, getContext: () => context,
        getTemporalItem: source => api.getTemporalItem(source),
        loadTemporalTimes: (...args) => api.loadTemporalTimes(...args),
        prepareVector: async source => ({selection: {...selection, filter: source.filter}, matched: 3, total: 8}), editVectorFilter: async request => { filterRequests.push(request); },
        closeVectorFilter: () => filterRequests.at(-1)?.close(),
        applyMapFilter: async (source, checkedArea) => {
            const filter = checkedArea.selection.filter;
            mapFilters.push({source, filter});
            context.vectors.find(value => value.key === source.key).filter = filter;
            controller.refreshMapLayers();
            return filter;
        }, onOpen: () => controller.setActive(true),
        onClose: () => controller.setActive(false), newId: () => String(++sequence).padStart(32, "0")});
    return {controller, api, jobs, context, storage, values, submitted, cancelled, filterRequests, mapFilters, handlers};
}

const periodModel = {...model, id: "regional-period-statistic", parameters: {}, inputs: {
    weather: {type: "temporal_interval", label: "Dataset and period"},
    region: {type: "summary_area", label: "Analysis area"},
    statistic: {type: "temporal_reduction", label: "Statistic"},
}, steps: [{id: "calculate", operation: "another.period-implementation.v2", inputs: {
    precipitation: {value: {inputUnit: "kg m**-2 s**-1", outputUnit: "mm", factor: 1}},
}}]};
const temporalDataset = {collectionId: "eolab-temporal-datasets", itemId: "observations", label: "Weather observations"};
const temporalItem = {collection: temporalDataset.collectionId, id: temporalDataset.itemId, properties: {
    title: "Weather observations", "cube:variables": {
        temperature: {description: "Air temperature", unit: "K", "eolab:time_support": "instantaneous"},
        rain: {description: "Rainfall rate", unit: "mm/day", "eolab:time_support": "mean_rate"},
    },
}};
const temporalChoices = {months: ["2000-01", "2000-03"], month: "2000-01",
    times: ["2000-01-01T00:00:00Z", "2000-01-02T12:30:00Z"]};

/** Open a temporal draft through the real controller with controlled Catalog replies.
 * @param {Object} [overrides={}] Catalog or Processing API replacements.
 * @param {Object|null} [view=null] Optional real view for user-input and submission tests.
 * @return {Promise<Object>} Existing controller fixture with a loaded temporal source.
 */
async function periodFixture(overrides = {}, view = null) {
    const h = fixture({getTemporalItem: async () => structuredClone(temporalItem),
        loadTemporalTimes: async () => structuredClone(temporalChoices), ...overrides}, view);
    h.context.rasters = [];
    h.context.temporalDatasets = [temporalDataset, {...temporalDataset, itemId: "second-dataset"}];
    h.controller.chooseModel(periodModel);
    await h.controller.chooseTemporalDataset(modelSourceKey(temporalDataset));
    return h;
}

/** Edit one exact UTC boundary through its date and time controls.
 * @param {Object} controls Temporal model controls.
 * @param {"start"|"end"} boundary Boundary to edit.
 * @param {string} value Date and time without a timezone suffix.
 * @param {string} [event="input"] Event completing the edit.
 * @return {void}
 */
function editExactTime(controls, boundary, value, event = "input") {
    const [date, time] = value.split("T");
    controls.period[`${boundary}Date`].value = date;
    controls.period[`${boundary}Time`].value = time;
    controls.period[`${boundary}Time`].dispatchEvent(new Event(event));
}

test("calendar controls capture whole years, months and inclusive days as the existing UTC interval", async () => {
    const view = new ModelsView(new SummaryControlDocument());
    const h = await periodFixture({}, view), controls = view.setup.temporal, draft = h.controller.state.draft;
    await h.controller.chooseTemporalVariable("temperature");
    assert.equal(controls.period.periodMode.value, "month");
    controls.period.periodMode.value = "year"; controls.period.periodMode.dispatchEvent(new Event("change"));
    controls.period.selectedYear.value = "2000"; controls.period.selectedYear.dispatchEvent(new Event("input"));
    assert.deepEqual(captureModelSubmission(draft, "e".repeat(32)).inputs.weather,
        {collectionId: temporalDataset.collectionId, itemId: temporalDataset.itemId, variable: "temperature",
            startTime: "2000-01-01T00:00:00.000Z", endTime: "2001-01-01T00:00:00.000Z"});
    controls.period.periodMode.value = "month"; controls.period.periodMode.dispatchEvent(new Event("change"));
    for (const [month, start, end] of [
        ["2000-02", "2000-02-01T00:00:00.000Z", "2000-03-01T00:00:00.000Z"],
        ["2000-12", "2000-12-01T00:00:00.000Z", "2001-01-01T00:00:00.000Z"],
    ]) {
        controls.period.selectedYear.value = month.slice(0, 4); controls.period.selectedMonth.value = month.slice(5);
        controls.period.selectedMonth.dispatchEvent(new Event("input"));
        const request = captureModelSubmission(draft, "e".repeat(32), -420);
        assert.deepEqual(request.inputs.weather, {collectionId: temporalDataset.collectionId, itemId: temporalDataset.itemId,
            variable: "temperature", startTime: start, endTime: end});
    }
    controls.period.periodMode.value = "days"; controls.period.periodMode.dispatchEvent(new Event("change"));
    for (const [first, last, end] of [
        ["2000-02-29", "2000-02-29", "2000-03-01T00:00:00.000Z"],
        ["2024-03-10", "2024-03-11", "2024-03-12T00:00:00.000Z"],
    ]) {
        controls.period.firstDay.value = first; controls.period.lastDay.value = last;
        controls.period.lastDay.dispatchEvent(new Event("input"));
        const request = captureModelSubmission(draft, "e".repeat(32), -420);
        assert.equal(request.inputs.weather.startTime, `${first}T00:00:00.000Z`);
        assert.equal(request.inputs.weather.endTime, end);
    }
    const expected = captureModelSubmission(draft, "e".repeat(32)).inputs;
    controls.period.periodMode.value = "times"; controls.period.periodMode.dispatchEvent(new Event("change"));
    assert.equal(controls.period.startDate.value, "2024-03-10"); assert.equal(controls.period.startTime.value, "00:00");
    assert.equal(controls.period.endDate.value, "2024-03-12"); assert.equal(controls.period.endTime.value, "00:00");
    assert.deepEqual(captureModelSubmission(draft, "e".repeat(32)).inputs, expected);
    editExactTime(controls, "start", "2024-03-10T12:30");
    editExactTime(controls, "end", "2024-03-11T05:15");
    controls.period.periodMode.value = "days"; controls.period.periodMode.dispatchEvent(new Event("change"));
    assert.equal(controls.period.firstDay.value, "2024-03-10"); assert.equal(controls.period.lastDay.value, "2024-03-11");
    assert.deepEqual(captureModelSubmission(draft, "e".repeat(32)).inputs, expected);
    assert.equal(h.submitted.length, 0);
    await h.controller.submit();
    assert.deepEqual(h.submitted[0].inputs, expected);
    h.controller.destroy();
});

test("typed years and ISO dates keep partial edits and reject invalid calendar days before submission", async () => {
    const view = new ModelsView(new SummaryControlDocument());
    const h = await periodFixture({}, view), period = view.setup.temporal.period, draft = h.controller.state.draft;
    await h.controller.chooseTemporalVariable("temperature");
    period.periodMode.value = "year"; period.periodMode.dispatchEvent(new Event("change"));
    period.selectedYear.focus(); period.selectedYear.value = "20"; period.selectedYear.dispatchEvent(new Event("input"));
    view.render(h.controller.state);
    assert.equal(period.selectedYear.value, "20"); assert.equal(draft.temporal.startTime, "");
    assert.match(period.selectedYear.validationMessage, /four-digit year/); assert.equal(view.setup.run.disabled, true);
    period.selectedYear.value = "2000"; period.selectedYear.dispatchEvent(new Event("input"));
    assert.equal(period.selectedYear.validationMessage, ""); assert.equal(view.setup.run.disabled, false);
    period.periodMode.value = "days"; period.periodMode.dispatchEvent(new Event("change"));
    period.firstDay.focus();
    for (const value of ["2000-0", "2000-02-31", "1900-02-29", "01/02/2000"]) {
        period.firstDay.value = value; period.firstDay.dispatchEvent(new Event("input"));
        view.render(h.controller.state);
        assert.equal(period.firstDay.value, value); assert.equal(view.document.activeElement, period.firstDay);
        assert.equal(draft.temporal.startTime, ""); assert.equal(view.setup.run.disabled, true);
        assert.match(period.firstDay.validationMessage, /valid date as YYYY-MM-DD/);
    }
    period.firstDay.value = "2000-02-29"; period.firstDay.dispatchEvent(new Event("input"));
    assert.equal(draft.temporal.startTime, "2000-02-29T00:00"); assert.equal(period.firstDay.validationMessage, "");
    assert.equal(view.setup.run.disabled, false);
    period.lastDayPicker.value = "2000-03-01"; period.lastDayPicker.dispatchEvent(new Event("change"));
    assert.equal(period.lastDay.value, "2000-03-01"); assert.equal(draft.temporal.endTime, "2000-03-02T00:00");
    assert.equal(period.lastDayPicker.getAttribute("aria-label"), "Choose last day (included) from calendar");
    period.periodMode.value = "times"; period.periodMode.dispatchEvent(new Event("change"));
    period.endDate.focus(); period.endDate.value = "2000-02-31"; period.endDate.dispatchEvent(new Event("input"));
    assert.equal(draft.temporal.endTime, ""); assert.equal(period.endDate.value, "2000-02-31");
    assert.equal(view.setup.run.disabled, true);
    period.endDatePicker.value = "2000-03-31"; period.endDatePicker.dispatchEvent(new Event("change"));
    assert.equal(draft.temporal.endTime, "2000-03-31T00:00"); assert.equal(view.setup.run.disabled, false);
    assert.equal(h.submitted.length, 0);
    h.controller.destroy();
});

test("temporal setup captures typed inputs in UTC without raster publication or automatic jobs", async () => {
    const h = await periodFixture(), draft = h.controller.state.draft;
    assert.equal(draft.inputs.raster, undefined);
    assert.equal(draft.temporal.variable, "");
    await h.controller.chooseTemporalVariable("temperature");
    h.handlers.onTemporalEdit({periodMode: "times", startTime: "2000-01-01T00:00", endTime: "2000-01-02T13:00"});
    h.controller.editDraft({reduction: {reducer: "percentile", percentile: 95}});
    assert.equal(h.submitted.length, 0);
    const request = captureModelSubmission(draft, "e".repeat(32), -420);
    assert.deepEqual(request.inputs.weather, {collectionId: temporalDataset.collectionId, itemId: temporalDataset.itemId,
        variable: "temperature", startTime: "2000-01-01T00:00:00.000Z", endTime: "2000-01-02T13:00:00.000Z"});
    assert.deepEqual(request.inputs.statistic, {reducer: "percentile", percentile: 95});
    assert.deepEqual(request.inputs.region, area);
    await h.controller.submit();
    assert.equal(h.submitted.length, 1);
    h.context.temporalDatasets[0] = {...temporalDataset, time: "2000-03-01T00:00:00Z", variable: "rain", visible: false};
    h.controller.refreshMapLayers();
    assert.deepEqual(h.submitted[0].inputs, request.inputs);
    h.controller.destroy();
});

test("refresh and map changes preserve the analysis interval; Use this month replaces it explicitly", async () => {
    let item = structuredClone(temporalItem), dates = structuredClone(temporalChoices);
    const h = await periodFixture({getTemporalItem: async () => structuredClone(item), loadTemporalTimes: async () => structuredClone(dates)});
    await h.controller.chooseTemporalVariable("temperature");
    const draft = h.controller.state.draft;
    h.handlers.onTemporalEdit({periodMode: "times", startTime: "2000-01-01T01:15", endTime: "2000-03-04T20:00"});
    dates = {months: ["2000-03"], month: "2000-03", times: ["2000-03-12T00:00:00Z"]};
    h.context.temporalDatasets[0] = {...temporalDataset, variable: "rain", visible: false};
    h.controller.refreshMapLayers();
    await h.controller.loadTemporalDates(undefined, true);
    assert.equal(draft.temporal.variable, "temperature");
    assert.equal(draft.temporal.startTime, "2000-01-01T01:15");
    assert.equal(draft.temporal.endTime, "2000-03-04T20:00");
    h.controller.useTemporalMonth();
    assert.equal(draft.temporal.startTime, "2000-03-01T00:00");
    assert.equal(draft.temporal.endTime, "2000-04-01T00:00");
    assert.equal(draft.temporal.periodMode, "month");
    assert.equal(h.submitted.length, 0);
    delete item.properties["cube:variables"].temperature;
    await h.controller.loadTemporalDates(undefined, true);
    assert.equal(draft.temporal.variable, "temperature");
    assert.throws(() => captureModelSubmission(draft, "e".repeat(32)), /Choose a variable/);
    h.context.temporalDatasets = [];
    h.controller.refreshMapLayers();
    assert.equal(draft.temporal.item, null);
    assert.throws(() => captureModelSubmission(draft, "e".repeat(32)), /Add a temporal dataset from Catalog/);
    h.controller.destroy();
});

test("availability replies preserve typed dates and cannot change a later model draft", async () => {
    const h = await periodFixture();
    await h.controller.chooseTemporalVariable("temperature");
    let finishDates;
    h.api.loadTemporalTimes = () => new Promise(resolve => { finishDates = resolve; });
    const pending = h.controller.loadTemporalDates("2000-03");
    h.handlers.onTemporalEdit({periodMode: "times", startTime: "2000-03-01T00:00", endTime: "2000-03-15T00:00"});
    finishDates(temporalChoices); await pending;
    assert.equal(h.controller.state.draft.temporal.loading, false);
    assert.equal(h.controller.state.draft.temporal.endTime, "2000-03-15T00:00");
    const obsolete = h.controller.loadTemporalDates();
    h.controller.chooseModel(model);
    finishDates(temporalChoices); await obsolete;
    assert.equal(h.controller.state.draft.temporal, null);
    assert.equal(h.controller.state.draft.model.id, model.id);
    h.controller.destroy();
});

test("period maps accept ordinary statistics for every observation type and date guidance does not authorize work", async () => {
    const item = structuredClone(temporalItem);
    item.properties["cube:variables"].energy = {description: "Stored energy", unit: "J m-2", "eolab:time_support": "accumulation"};
    const view = new ModelsView(new SummaryControlDocument());
    const h = await periodFixture({getTemporalItem: async () => structuredClone(item)}, view), draft = h.controller.state.draft;
    const controls = view.setup.temporal, statistics = ["mean", "sum", "min", "max", "median", "percentile", "stdev"];
    controls.period.periodMode.value = "times"; controls.period.periodMode.dispatchEvent(new Event("change"));
    editExactTime(controls, "start", "2000-01-01T00:10");
    editExactTime(controls, "end", "2000-02-01T00:20");
    for (const variable of ["temperature", "rain", "energy"]) {
        await h.controller.chooseTemporalVariable(variable);
        assert.deepEqual(controls.statistic.children.map(option => option.value), statistics);
        for (const reducer of statistics) {
            controls.statistic.value = reducer; controls.statistic.dispatchEvent(new Event("change"));
            const request = captureModelSubmission(draft, "e".repeat(32));
            assert.equal(request.inputs.weather.variable, variable);
            assert.equal(request.inputs.weather.startTime, "2000-01-01T00:10:00.000Z");
            assert.equal(request.inputs.weather.endTime, "2000-02-01T00:20:00.000Z");
            assert.deepEqual(request.inputs.statistic, reducer === "percentile" ? {reducer, percentile: 90} : {reducer});
        }
    }
    h.api.loadTemporalTimes = async () => { throw new Error("Offline"); };
    await h.controller.chooseTemporalVariable("temperature");
    assert.match(draft.temporal.datesError, /You can still enter a period/);
    assert.doesNotThrow(() => captureModelSubmission(draft, "e".repeat(32)));
    editExactTime(controls, "end", "2000-01-01T00:10");
    assert.throws(() => captureModelSubmission(draft, "e".repeat(32)), /end must be later/);
    editExactTime(controls, "end", "2000-02-01T00:00");
    h.controller.editDraft({reduction: {reducer: "percentile", percentile: 101}});
    assert.throws(() => captureModelSubmission(draft, "e".repeat(32)), /percentile from 0 to 100/);
    h.controller.editDraft({reduction: {reducer: "mean", percentile: 101}});
    assert.deepEqual(captureModelSubmission(draft, "e".repeat(32)).inputs.statistic, {reducer: "mean"});
    h.controller.destroy();
});

test("copying a temporal run preserves its original period, statistic and fixed area", async () => {
    const h = await periodFixture();
    const saved = {model: periodModel, label: "Original period", parameters: {}, inputs: {
        weather: {collectionId: temporalDataset.collectionId, itemId: temporalDataset.itemId, variable: "temperature",
            startTime: "2000-01-01T00:00:00Z", endTime: "2000-01-03T00:00:00Z"},
        statistic: {reducer: "percentile", percentile: 75}, region: area,
    }};
    h.controller.state.library = [periodModel]; h.controller.state.invocation = saved;
    await h.controller.duplicateRun();
    const draft = h.controller.state.draft;
    assert.equal(draft.inputs.region.areaMode, "captured");
    assert.equal(draft.temporal.periodMode, "times");
    h.context.area = {kind: "wholeRaster"};
    h.controller.refreshMapArea();
    const request = captureModelSubmission(draft, "e".repeat(32));
    assert.equal(request.inputs.weather.endTime, "2000-01-03T00:00:00.000Z");
    assert.deepEqual(request.inputs.statistic, saved.inputs.statistic);
    assert.deepEqual(request.inputs.region, area);
    assert.equal(h.submitted.length, 0);
    h.controller.destroy();
});

test("only selecting Precipitation total rounds UTC hours and submits those dates without changing the area", async () => {
    const item = structuredClone(temporalItem);
    item.properties["cube:variables"].water_flux = {description: "Precipitation rate", unit: "kg m**-2 s**-1", "eolab:time_support": "mean_rate"};
    const doc = new SummaryControlDocument(), view = new ModelsView(doc);
    const h = await periodFixture({getTemporalItem: async () => structuredClone(item)}, view);
    const draft = h.controller.state.draft, controls = view.setup.temporal;
    controls.period.periodMode.value = "times"; controls.period.periodMode.dispatchEvent(new Event("change"));
    await h.controller.chooseTemporalVariable("temperature");
    editExactTime(controls, "start", "2000-01-31T23:30");
    editExactTime(controls, "end", "2000-02-01T01:10");
    controls.period.startTime.focus();
    await h.controller.chooseTemporalVariable("water_flux");
    assert.equal(draft.reduction.reducer, "mean");
    assert.equal(draft.temporal.startTime, "2000-01-31T23:30");
    assert.equal(draft.temporal.endTime, "2000-02-01T01:10");
    assert.doesNotThrow(() => captureModelSubmission(draft, "e".repeat(32)));
    assert.deepEqual(controls.statistic.children.map(option => option.value),
        ["mean", "sum", "min", "max", "median", "percentile", "stdev", "precipitation_total"]);
    controls.statistic.value = "precipitation_total"; controls.statistic.dispatchEvent(new Event("change"));
    assert.equal(controls.period.startDate.value, "2000-02-01");
    assert.equal(controls.period.startTime.value, "00:00");
    assert.equal(controls.period.endTime.value, "01:00");
    assert.equal(draft.reduction.reducer, "precipitation_total");
    editExactTime(controls, "start", "2000-02-01T00:10");
    assert.throws(() => captureModelSubmission(draft, "e".repeat(32)), /whole UTC hours/);
    await h.controller.loadTemporalDates(undefined, true);
    assert.equal(controls.period.startTime.value, "00:10");
    assert.equal(draft.temporal.startTime, "2000-02-01T00:10");
    controls.period.startTime.dispatchEvent(new Event("blur"));
    assert.equal(controls.period.startTime.value, "00:00");
    assert.equal(draft.temporal.startTime, `${controls.period.startDate.value}T${controls.period.startTime.value}`);
    controls.period.endTime.focus(); editExactTime(controls, "end", "2000-02-01T00:20");
    controls.period.endTime.dispatchEvent(new Event("blur"));
    assert.equal(controls.period.endTime.value, "00:00");
    assert.match(controls.status.textContent, /end must be later/);
    assert.equal(view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(draft, "e".repeat(32)), /end must be later/);
    editExactTime(controls, "end", "2000-02-01T00:30");
    controls.period.endTime.dispatchEvent(new Event("change"));
    assert.equal(controls.period.endTime.value, "01:00");
    assert.equal(view.setup.run.disabled, false);
    controls.statistic.value = "mean"; controls.statistic.dispatchEvent(new Event("change"));
    assert.equal(draft.reduction.reducer, "mean");
    editExactTime(controls, "start", "2000-02-01T00:10");
    controls.period.startTime.dispatchEvent(new Event("change")); controls.period.startTime.dispatchEvent(new Event("blur"));
    assert.equal(draft.temporal.startTime, "2000-02-01T00:10");
    assert.deepEqual(captureModelSubmission(draft, "e".repeat(32)).inputs.statistic, {reducer: "mean"});
    controls.statistic.value = "precipitation_total"; controls.statistic.dispatchEvent(new Event("change"));
    const expected = captureModelSubmission(draft, "e".repeat(32));
    assert.equal(expected.inputs.weather.startTime, `${controls.period.startDate.value}T${controls.period.startTime.value}:00.000Z`);
    assert.equal(expected.inputs.weather.endTime, `${controls.period.endDate.value}T${controls.period.endTime.value}:00.000Z`);
    assert.equal(h.submitted.length, 0);
    await h.controller.submit();
    assert.deepEqual(h.submitted[0].inputs, expected.inputs);
    assert.deepEqual(h.submitted[0].inputs.region, area);
    h.controller.destroy();
});

test("a sole precipitation variable defaults to Mean and copied totals preserve their exact period and area", async () => {
    const item = structuredClone(temporalItem);
    item.properties["cube:variables"] = {water_flux: {description: "Precipitation rate", unit: "kg m**-2 s**-1", "eolab:time_support": "mean_rate"}};
    const h = await periodFixture({getTemporalItem: async () => structuredClone(item)});
    assert.equal(h.controller.state.draft.temporal.variable, "water_flux");
    assert.equal(h.controller.state.draft.reduction.reducer, "mean");
    const saved = {model: periodModel, label: "Rainfall", parameters: {}, inputs: {
        weather: {collectionId: temporalDataset.collectionId, itemId: temporalDataset.itemId, variable: "water_flux",
            startTime: "2000-01-31T23:00:00.000Z", endTime: "2000-02-01T01:00:00.000Z"},
        statistic: {reducer: "precipitation_total"}, region: area,
    }};
    h.controller.state.library = [periodModel]; h.controller.state.invocation = saved;
    await h.controller.duplicateRun();
    h.context.area = {kind: "wholeRaster"}; h.controller.refreshMapArea();
    await h.controller.loadTemporalDates(undefined, true);
    const request = captureModelSubmission(h.controller.state.draft, "e".repeat(32));
    assert.deepEqual(request.inputs, saved.inputs);
    assert.equal(h.controller.state.draft.inputs.region.areaMode, "captured");
    assert.equal(h.submitted.length, 0);
    h.controller.destroy();
});

test("recipe units add a precipitation total without restricting ordinary statistics or adding conversion settings to requests", async () => {
    const recipe = structuredClone(periodModel);
    recipe.steps[0].inputs.precipitation.value = {inputUnit: "mm/hour", outputUnit: "cm", factor: 1 / 36000};
    const item = structuredClone(temporalItem);
    item.properties["cube:variables"].rain.unit = "mm/hour";
    item.properties["cube:variables"].water_flux = {description: "Another precipitation rate", unit: "kg m**-2 s**-1", "eolab:time_support": "mean_rate"};
    const doc = new SummaryControlDocument(), view = new ModelsView(doc);
    const h = fixture({getTemporalItem: async () => structuredClone(item),
        loadTemporalTimes: async () => structuredClone(temporalChoices)}, view);
    h.context.temporalDatasets = [temporalDataset, {...temporalDataset, itemId: "second-dataset"}];
    h.controller.chooseModel(recipe);
    await h.controller.chooseTemporalDataset(modelSourceKey(temporalDataset));
    const controls = view.setup.temporal;
    controls.period.periodMode.value = "times"; controls.period.periodMode.dispatchEvent(new Event("change"));
    await h.controller.chooseTemporalVariable("water_flux");
    assert.deepEqual(controls.statistic.children.map(option => option.value), ["mean", "sum", "min", "max", "median", "percentile", "stdev"]);
    await h.controller.chooseTemporalVariable("rain");
    assert.equal(controls.variable.children.find(option => option.value === "rain").disabled, false);
    assert.equal(controls.variable.children.find(option => option.value === "water_flux").disabled, false);
    assert.equal(controls.statistic.children.at(-1).textContent, "Precipitation total (cm)");
    controls.statistic.value = "precipitation_total"; controls.statistic.dispatchEvent(new Event("change"));
    assert.match(controls.reductionHelp.textContent, /rate in mm\/hour.*converted to cm/);
    editExactTime(controls, "start", "2000-01-01T00:10", "change");
    editExactTime(controls, "end", "2000-01-01T02:30", "change");
    await h.controller.submit();
    assert.deepEqual(h.submitted[0].inputs, {weather: {collectionId: temporalDataset.collectionId, itemId: temporalDataset.itemId,
        variable: "rain", startTime: "2000-01-01T00:00:00.000Z", endTime: "2000-01-01T03:00:00.000Z"},
        region: area, statistic: {reducer: "precipitation_total"}});
    assert.deepEqual(h.submitted[0].parameters, {});
    h.controller.destroy();
});

test("area-series controls accept every observation type and capture scalar statistics without rounding dates", async () => {
    const item = structuredClone(temporalItem);
    item.properties["cube:variables"].energy = {description: "Stored energy", unit: "J m-2", "eolab:time_support": "accumulation"};
    const view = new ModelsView(new SummaryControlDocument());
    const h = fixture({discoverModels: async () => [model, seriesModel],
        getTemporalItem: async () => structuredClone(item), loadTemporalTimes: async () => structuredClone(temporalChoices)}, view);
    h.context.rasters = [];
    h.context.temporalDatasets = [temporalDataset, {...temporalDataset, itemId: "second-dataset"}];
    await h.controller.loadLibrary();
    h.controller.chooseModel(h.controller.state.library.find(recipe => recipe.id === seriesModel.id));
    await h.controller.chooseTemporalDataset(modelSourceKey(temporalDataset));
    const controls = view.setup.temporal, draft = h.controller.state.draft;
    controls.period.periodMode.value = "times"; controls.period.periodMode.dispatchEvent(new Event("change"));
    editExactTime(controls, "start", "2000-01-31T23:30:15.250");
    editExactTime(controls, "end", "2000-02-01T01:10:22.500");
    for (const variable of ["temperature", "rain", "energy"]) {
        await h.controller.chooseTemporalVariable(variable);
        assert.equal(controls.variable.children.find(option => option.value === variable).disabled, false);
        assert.deepEqual(controls.statistic.children.map(option => option.value), ["mean", "sum", "min", "max", "stdev", "count"]);
        for (const input of [controls.period.startTime, controls.period.endTime]) {
            input.dispatchEvent(new Event("change")); input.dispatchEvent(new Event("blur"));
        }
        for (const statistic of ["mean", "sum", "min", "max", "stdev", "count"]) {
            controls.statistic.value = statistic; controls.statistic.dispatchEvent(new Event("change"));
            const request = captureModelSubmission(draft, "e".repeat(32));
            assert.equal(request.inputs.statistic, statistic);
            assert.equal(request.inputs.source.variable, variable);
            assert.equal(request.inputs.source.startTime, "2000-01-31T23:30:15.250Z");
            assert.equal(request.inputs.source.endTime, "2000-02-01T01:10:22.500Z");
            assert.deepEqual(request.inputs.area, area);
            assert.deepEqual(request.parameters, {});
        }
        assert.equal(controls.period.startTime.step, "any"); assert.equal(controls.period.endTime.step, "any");
        assert.equal(controls.percentileField.hidden, true);
        assert.equal(view.setup.run.disabled, false);
    }
    assert.equal(h.submitted.length, 0);
    await h.controller.submit();
    assert.equal(h.submitted[0].inputs.statistic, "count");
    assert.equal(h.submitted[0].inputs.source.variable, "energy");
    h.controller.destroy();
});

test("copying an area series preserves its scalar statistic, exact period and area through refresh", async () => {
    const saved = {model: {...seriesModel, definition: seriesModel}, label: "Original series", parameters: {}, inputs: {
        source: {collectionId: temporalDataset.collectionId, itemId: temporalDataset.itemId, variable: "rain",
            startTime: "2000-01-31T23:30:15.250Z", endTime: "2000-02-01T01:10:22.500Z"},
        statistic: "stdev", area,
    }};
    const run = job({model: seriesModel, status: "ready", result: timeSeriesResult, expiresAt: "2099-01-01T00:00:00Z"});
    const view = new ModelsView(new SummaryControlDocument());
    const h = fixture({discoverModels: async () => [seriesModel], getJob: async () => run,
        readModelInvocation: async () => structuredClone(saved), getTemporalItem: async () => structuredClone(temporalItem),
        loadTemporalTimes: async () => structuredClone(temporalChoices)}, view);
    h.context.temporalDatasets = [temporalDataset];
    await h.controller.loadLibrary(); await h.controller.showRun(run.jobId); await h.controller.duplicateRun();
    assert.equal(h.controller.state.page, "setup");
    h.context.area = {kind: "wholeRaster"}; h.controller.refreshMapArea();
    await h.controller.loadTemporalDates(undefined, true);
    const draft = h.controller.state.draft;
    const controls = view.setup.temporal;
    assert.equal(controls.period.periodMode.value, "times");
    assert.equal(controls.period.startDate.value, "2000-01-31"); assert.equal(controls.period.startTime.value, "23:30:15.250");
    assert.equal(controls.period.endDate.value, "2000-02-01"); assert.equal(controls.period.endTime.value, "01:10:22.500");
    assert.equal(draft.inputs.area.areaMode, "captured");
    assert.deepEqual(captureModelSubmission(draft, "e".repeat(32)).inputs, saved.inputs);
    assert.equal(h.submitted.length, 0);
    h.controller.destroy();
});

test("model setup supports temporal input types and omits unknown controls while retaining run history", async () => {
    const temporal = {...model, id: "temporal-period-map", inputs: {
        source: {type: "temporal_interval", label: "Dataset and period"},
        area: model.inputs.area,
        reduction: {type: "temporal_reduction", label: "Statistic"},
    }};
    const unknown = {...model, id: "future-recipe", inputs: {unknown: {type: "unknown_input", label: "Unknown"}}};
    const run = job({model: unknown, status: "ready", expiresAt: "2099-01-01T00:00:00Z", result: timeSeriesResult});
    const saved = {...invocation, model: {...unknown, definition: unknown}, parameters: {}, inputs: {unknown: "Original input"}};
    const h = fixture({discoverModels: async () => [model, temporal, clipModel, seriesModel, unknown],
        getJob: async () => run, readModelInvocation: async () => saved,
        listModelRuns: async () => ({jobs: [run], nextCursor: null})});
    await h.controller.loadLibrary();
    await h.controller.loadRuns();
    assert.deepEqual(h.controller.state.library.map(value => value.id), [model.id, temporal.id, clipModel.id, seriesModel.id]);
    assert.deepEqual(h.controller.state.runs[0], run);
    await h.controller.showRun(run.jobId);
    await h.controller.duplicateRun();
    assert.equal(h.controller.state.error,
        "This model version is not available in model setup. Its YAML remains available until metadata expires.");
    assert.equal(h.controller.state.page, "run");
    assert.equal(h.submitted.length, 0);
    h.controller.chooseModel(model);
    assert.equal(h.controller.state.page, "setup");
    h.controller.destroy();
});

test("published results are explicit model choices without previews or map layers", async () => {
    const artifacts = fileManifest(), parent = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    const h = fixture({listModelRuns: async () => ({jobs: [parent], nextCursor: null})});
    h.context.rasters = [];
    await h.controller.loadRuns();
    const recipe = {...model, inputs: {habitat: {type: "raster", label: "Habitat"}, area: model.inputs.area}};
    h.controller.chooseModel(recipe);
    const draft = h.controller.state.draft;
    assert.equal(draft.inputs.habitat.raster, null);
    assert.equal(draft.sources.length, 2);
    assert.ok(draft.sources.every(source => source.kind === "runArtifact"));
    h.controller.editInput("habitat", {raster: draft.sources[1]});
    const request = captureModelSubmission(draft, "request-private-result");
    assert.deepEqual(request.inputs.habitat, {kind: "runArtifact", jobId: parent.jobId, artifactId: artifacts.files[1].artifactId});
    assert.deepEqual(request.inputs.area, area);
    h.controller.rememberRun({...parent, status: "expired", artifacts: {...artifacts, availability: "unavailable", files: []}});
    h.controller.refreshMapLayers();
    assert.equal(draft.inputs.habitat.raster.available, false);
    assert.match(draft.inputs.habitat.sourceReason, /no longer available/);
    assert.throws(() => captureModelSubmission(draft, "request-expired-result"), /no longer available/);
});

test("renewal updates the shared observer and all run consumers without resubmitting", async () => {
    const artifacts = fileManifest(), ready = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    const renewed = {...ready, expiresAt: "2099-02-01T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z"};
    const h = fixture({getJob: async () => ready, renewModelRun: async () => renewed});
    const changes = []; h.controller.onRunChange = value => changes.push(value);
    await h.controller.showRun(ready.jobId);
    await h.controller.renewRun();
    assert.equal(h.controller.runSnapshots.get(ready.jobId), renewed);
    assert.equal(h.jobs.jobs[0], renewed); assert.equal(changes.at(-1), renewed);
    assert.match(h.controller.state.actionMessage, /Results kept until/);
    h.controller.rememberRun(ready);
    assert.equal(h.controller.runSnapshots.get(ready.jobId), renewed);
    assert.equal(h.submitted.length, 0);
});

test("renaming an active run refreshes its consumers and duplicates the name without the old timestamp", async () => {
    const original = job({status: "running"}), renamed = job({status: "running", name: "Cuba biomass", updatedAt: "2026-10-09T00:00:00Z"});
    const requests = [], changes = [];
    const h = fixture({getJob: async () => original, renameModelRun: async (...args) => { requests.push(args); return renamed; }});
    h.controller.onRunChange = value => changes.push(value);
    await h.controller.loadLibrary(); await h.controller.showRun(original.jobId);
    assert.equal(await h.controller.renameRun(" Cuba biomass "), true);
    assert.deepEqual(requests, [[original.jobId, "Cuba biomass"]]);
    assert.equal(h.jobs.jobs[0], renamed); assert.equal(changes.at(-1), renamed);
    assert.equal(h.controller.state.invocation.label, renamed.name);
    assert.equal(h.controller.state.runs[0].nameTimestamp, original.nameTimestamp);
    h.controller.rememberRun(original); assert.equal(h.controller.state.runs[0], renamed);
    h.controller.state.invocation = {...h.controller.state.invocation, label: original.name};
    await h.controller.duplicateRun();
    assert.equal(h.controller.state.draft.label, "Cuba biomass");
    assert.deepEqual(h.submitted, []); assert.deepEqual(h.cancelled, []);
});

test("a rename failure preserves the run and a late rename does not edit a different run's inputs", async () => {
    const original = job(), h = fixture({getJob: async () => original,
        renameModelRun: async () => { throw new Error("Connection lost"); }});
    await h.controller.showRun(original.jobId);
    assert.equal(await h.controller.renameRun("New name"), false);
    assert.equal(h.controller.state.runs[0], original); assert.match(h.controller.state.error, /Could not rename.*Connection lost/);
    assert.equal(h.controller.state.actionBusy, false);
    let finish;
    h.api.renameModelRun = () => new Promise(resolve => { finish = resolve; });
    const pending = h.controller.renameRun("New name");
    const second = job({jobId: "2".repeat(32), name: "Other run"});
    h.api.getJob = async () => second; h.api.readModelInvocation = async () => ({...invocation, label: second.name});
    await h.controller.showRun(second.jobId);
    finish(job({name: "New name", updatedAt: "2026-10-09T00:00:00Z"})); await pending;
    assert.equal(h.controller.state.selectedRun, second.jobId);
    assert.equal(h.controller.state.invocation.label, second.name);
});

test("deletion needs confirmation and removes captured inputs and choices after success", async () => {
    const artifacts = fileManifest(), ready = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    const deleted = {...ready, status: "deleted", artifacts: {files: []}, updatedAt: "2026-10-10T00:00:00Z"};
    let calls = 0;
    const h = fixture({getJob: async () => ready, deleteModelRun: async () => { calls++; return deleted; },
        readJobStatuses: async () => ({jobs: [ready], unavailableJobIds: []})});
    await h.controller.showRun(ready.jobId);
    await h.controller.deleteRun(); assert.equal(calls, 0);
    h.controller.requestRunDeletion(); assert.equal(calls, 0);
    await h.controller.deleteRun();
    assert.equal(calls, 1); assert.equal(h.controller.state.deleteConfirmation, null);
    assert.equal(h.controller.state.invocation, null);
    assert.equal(h.controller.runSnapshots.get(ready.jobId).status, "deleted");
    assert.deepEqual(h.controller.state.runs, []);
    assert.equal(h.controller.state.page, "runs");
    assert.equal(h.controller.state.selectedRun, null);
    h.controller.rememberRun(ready);
    await h.controller.showRun(ready.jobId);
    assert.deepEqual(h.controller.state.runs, []);
    assert.equal(h.controller.state.page, "runs");
});

test("inline deletion returns focus on Keep or Escape and keeps a failed confirmation available", async () => {
    const doc = new SummaryControlDocument(), view = new ModelsView(doc);
    const ready = job({status: "ready", expiresAt: "2099-01-01T00:00:00Z"});
    let rejectDeletion, calls = 0;
    const h = fixture({getJob: async () => ready, deleteModelRun: () => {
        calls++; return new Promise((_resolve, reject) => { rejectDeletion = reject; });
    }}, view);
    await h.controller.showRun(ready.jobId);
    const remove = view.run.remove;
    remove.focus(); remove.dispatchEvent(new Event("click"));
    assert.equal(doc.activeElement, view.run.keep); assert.equal(calls, 0);
    view.run.keep.dispatchEvent(new Event("click"));
    assert.equal(h.controller.state.deleteConfirmation, null); assert.equal(doc.activeElement, remove);
    assert.equal(view.run.confirmation.hidden, true); assert.equal(calls, 0);

    remove.dispatchEvent(new Event("click"));
    const escape = new Event("keydown", {cancelable: true});
    Object.defineProperty(escape, "key", {value: "Escape"});
    view.run.confirmation.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(h.controller.state.deleteConfirmation, null); assert.equal(doc.activeElement, remove);
    assert.equal(calls, 0);

    remove.dispatchEvent(new Event("click")); view.run.confirm.focus();
    const confirmation = view.run.confirmation, confirm = view.run.confirm;
    const pending = h.controller.deleteRun();
    const busyEscape = new Event("keydown", {cancelable: true});
    Object.defineProperty(busyEscape, "key", {value: "Escape"});
    confirmation.dispatchEvent(busyEscape);
    assert.equal(h.controller.state.deleteConfirmation, ready.jobId);
    assert.equal(h.controller.state.runs[0].jobId, ready.jobId);
    rejectDeletion(new Error("Offline")); await pending;
    assert.equal(calls, 1); assert.equal(view.run.confirmation, confirmation);
    assert.equal(view.run.confirm, confirm); assert.equal(confirm.disabled, false);
    assert.equal(doc.activeElement, confirm); assert.match(view.elements.error.textContent, /Offline/);
    assert.equal(confirmation.hidden, false);

    h.api.deleteModelRun = async () => ({...ready, status: "deleted", updatedAt: "2026-10-10T00:00:00Z"});
    await h.controller.deleteRun();
    assert.equal(h.controller.state.page, "runs"); assert.deepEqual(h.controller.state.runs, []);
    assert.equal(doc.activeElement, view.elements.heading);
});

test("Undo restores its run and captured displays without extending expiry or changing the user's setup", async () => {
    const ready = job({status: "ready", expiresAt: "2099-01-01T00:00:00Z"});
    const deletionUndo = {deletionId: "d".repeat(32), expiresAt: new Date(Date.now() + 30000).toISOString()};
    const deleted = {...ready, status: "deleted", updatedAt: "2098-01-01T00:00:00Z", deletionUndo};
    const restored = {...ready, updatedAt: "2098-01-01T00:00:01Z"};
    const requests = [], layers = [{key: "hidden", visible: false}, {key: "visible", opacity: 0.4}];
    const h = fixture({getJob: async () => ready, deleteModelRun: async () => deleted,
        undoModelDeletion: async (...args) => { requests.push(args); return restored; }});
    h.controller.captureRunLayers = id => { assert.equal(id, ready.jobId); return layers; };
    h.controller.restoreRunLayers = async (snapshots, isCurrent) => { assert.equal(snapshots, layers); assert.ok(isCurrent()); };
    await h.controller.showRun(ready.jobId); h.controller.requestRunDeletion(); await h.controller.deleteRun();
    assert.equal(h.controller.deletions.size, 1); assert.equal(h.controller.state.runs.length, 0);
    const notice = h.controller.deletions.get(ready.jobId);
    h.controller.rememberRun(deleted); assert.equal(h.controller.deletions.get(ready.jobId), notice);
    h.controller.chooseModel(model); const draft = h.controller.state.draft;
    await h.controller.resolveDeletion(ready.jobId, true);
    assert.deepEqual(requests, [[ready.jobId, deletionUndo.deletionId]]);
    assert.equal(h.controller.state.runs[0].expiresAt, ready.expiresAt);
    assert.equal(h.controller.state.draft, draft); assert.equal(h.controller.state.page, "setup");
    assert.equal(h.controller.deletions.size, 0); assert.equal(h.values.size, 0);
    h.controller.rememberRun(deleted); assert.equal(h.controller.state.runs[0].status, "ready");
});

test("deletion notices survive reload, isolate dismissal, expire and retain retry on failure", async () => {
    const deletionUndo = {deletionId: "d".repeat(32), expiresAt: new Date(Date.now() + 30000).toISOString()};
    const first = job({status: "deleted", deletionUndo}), second = {...first, jobId: "2".repeat(32),
        deletionUndo: {...deletionUndo, deletionId: "e".repeat(32)}};
    const h = fixture(); h.controller.rememberRun(first); h.controller.rememberRun(second);
    const next = fixture({readJobStatuses: async ids => {
        assert.deepEqual(ids, [first.jobId, second.jobId]); return {jobs: [first, second], unavailableJobIds: []};
    }});
    next.controller.storage = h.storage; await next.controller.recoverDeletions();
    assert.equal(next.controller.deletions.size, 2); assert.equal(next.controller.state.runs.length, 0);
    next.api.dismissModelDeletion = async () => { throw new Error("Offline"); };
    await next.controller.resolveDeletion(first.jobId, false);
    assert.equal(next.controller.deletions.get(first.jobId).busy, false); assert.match(next.controller.state.error, /Offline/);
    next.api.dismissModelDeletion = async (id, deletionId) => {
        assert.equal(id, first.jobId); assert.equal(deletionId, deletionUndo.deletionId);
        return {...first, updatedAt: "2098-01-01T00:00:00Z", deletionUndo: null};
    };
    await next.controller.resolveDeletion(first.jobId, false);
    assert.equal(next.controller.deletions.size, 1); assert.ok(next.controller.deletions.has(second.jobId));
    next.controller.deletions.get(second.jobId).expiresAt = new Date(Date.now() - 1).toISOString();
    next.controller.scheduleDeletions(); assert.equal(next.controller.deletions.size, 0);
    assert.equal(h.values.size, 0);
});

test("deletion failure preserves the visible run and never offers Undo", async () => {
    const ready = job({status: "ready", expiresAt: "2099-01-01T00:00:00Z"});
    const h = fixture({getJob: async () => ready, deleteModelRun: async () => { throw new Error("Offline"); }});
    await h.controller.showRun(ready.jobId); h.controller.requestRunDeletion(); await h.controller.deleteRun();
    assert.equal(h.controller.state.runs.length, 1); assert.equal(h.controller.deletions.size, 0);
    assert.equal(h.controller.state.selectedRun, ready.jobId); assert.match(h.controller.state.error, /Offline/);
});

test("navigation during confirmation never deletes another run", async () => {
    const artifacts = fileManifest(), ready = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    let calls = 0;
    const h = fixture({getJob: async id => ({...ready, jobId: id}), deleteModelRun: async () => { calls++; return ready; }});
    await h.controller.showRun(ready.jobId); h.controller.requestRunDeletion();
    await h.controller.showRun("2".repeat(32)); await h.controller.deleteRun();
    assert.equal(calls, 0);
});

test("legacy catalog recipes exclude results and late history loads preserve the chosen input", async () => {
    const artifacts = fileManifest(), parent = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    const h = fixture({listModelRuns: async () => ({jobs: [parent], nextCursor: null})});
    h.context.rasters.push({kind: "runArtifact", jobId: parent.jobId, artifactId: artifacts.files[0].artifactId, label: "Displayed result"});
    h.controller.chooseModel(model); await h.controller.loadRuns();
    assert.equal(h.controller.state.draft.sources.length, 1);
    h.controller.chooseModel({...model, inputs: {...model.inputs, raster: {type: "raster", label: "Raster"}}});
    const draft = h.controller.state.draft;
    assert.equal(draft.sources.length, 3, "Displayed results and run history refer to the same original source");
    h.controller.editInput("raster", {raster: draft.sources[1]});
    await h.controller.loadRuns();
    assert.equal(draft.inputs.raster.raster.artifactId, artifacts.files[0].artifactId);
});

test("multiple map rasters require a choice; catalog-only inputs cannot become suggestions", () => {
    const hidden = {...raster, itemId: "hidden", visible: false};
    let draft = createModelDraft(model, {rasters: [raster, {...raster, itemId: "second"}, hidden]}, "draft");
    assert.equal(draft.inputs.raster.raster, null); assert.equal(draft.sources.length, 3);
    draft = createModelDraft(model, {rasters: [raster], selectedRaster: hidden}, "draft");
    assert.equal(draft.inputs.raster.raster.itemId, "population"); assert.equal(draft.sources.length, 1); assert.match(draft.inputs.raster.sourceReason, /Map layers/);
});

test("named raster and vector controls preserve distinct inputs through refresh, submission and duplication", async () => {
    const recipe = {...model, inputs: {
        observed: {type: "raster", label: "Observed values"}, expected: {type: "raster", label: "Expected values"},
        study: {type: "summary_area", label: "Study area"}, reference: {type: "summary_area", label: "Reference area"},
    }};
    const doc = new SummaryControlDocument(), view = new ModelsView(doc), h = fixture({discoverModels: async () => [recipe]}, view);
    h.context.rasters.push({...raster, itemId: "expected", label: "Expected values"});
    h.context.vectors = ["study", "reference"].map(name => ({...selection,
        key: `view:${name}`, label: `${name} basins`, fields: [{name: "BASIN", type: "str"}]}));
    h.controller.prepareVector = async source => ({selection: {...selection, filter: source.filter},
        matched: source.filter.rules[0].value === "North" ? 3 : 1, total: 8});
    await h.controller.loadLibrary(); h.controller.chooseModel(recipe);
    const controls = view.setup.inputs;
    for (const [name, index] of [["observed", 0], ["expected", 1]]) {
        controls[name].source.value = modelSourceKey(h.context.rasters[index]);
        controls[name].source.dispatchEvent(new Event("change"));
    }
    for (const [name, value, count] of [["study", "North", 3], ["reference", "South", 1]]) {
        controls[name].areaMode.value = "vector"; controls[name].areaMode.dispatchEvent(new Event("change"));
        controls[name].vector.value = `view:${name}`; controls[name].vector.dispatchEvent(new Event("change"));
        await new Promise(resolve => setImmediate(resolve));
        controls[name].editFilter.dispatchEvent(new Event("click"));
        await new Promise(resolve => setImmediate(resolve));
        const editing = h.filterRequests.at(-1), filter = structuredClone(selection.filter);
        assert.equal(editing.host, controls[name].filterHost);
        filter.rules[0].value = value;
        await editing.apply(filter); editing.complete();
        assert.equal(controls[name].selectedCount.textContent, `${count} of 8 features selected`);
    }
    assert.notEqual(controls.study.filterHost.id, controls.reference.filterHost.id);
    assert.notEqual(controls.observed.source.id, controls.expected.source.id);
    controls.expected.source.focus(); h.controller.refreshMapLayers(); h.controller.refreshMapArea();
    assert.equal(doc.activeElement, controls.expected.source);
    const expected = {observed: {collectionId: raster.collectionId, itemId: raster.itemId},
        expected: {collectionId: raster.collectionId, itemId: "expected"},
        study: {kind: "catalogSelection", selection}, reference: {kind: "catalogSelection", selection: {...selection,
            filter: {...selection.filter, rules: [{...selection.filter.rules[0], value: "South"}]}}}};
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "independent-inputs").inputs, expected);
    h.api.readModelInvocation = async () => ({...h.submitted[0], model: {...recipe, definition: recipe}});
    await h.controller.submit();
    assert.deepEqual(h.submitted[0].inputs, expected);
    await h.controller.duplicateRun();
    h.context.vectors[0].filter = {enabled: false, match: "all", rules: []};
    h.context.area = {kind: "wholeRaster"}; h.controller.refreshMapLayers(); h.controller.refreshMapArea();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "duplicate-inputs").inputs, expected);
    assert.equal(view.setup.inputs.study.areaMode.value, "captured");
    assert.equal(view.setup.inputs.reference.areaMode.value, "captured");
    assert.match(view.setup.inputs.study.areaDescription.textContent, /BASIN equals "North"/);
    assert.match(view.setup.inputs.reference.areaDescription.textContent, /BASIN equals "South"/);
    assert.equal(h.submitted.length, 1);
    h.controller.destroy();
});

test("vector reads finish, cancel and fail independently for each named area", async () => {
    const h = fixture(), recipe = {...model, inputs: {raster: model.inputs.raster,
        study: model.inputs.area, reference: model.inputs.area}};
    h.context.vectors = ["study", "reference"].map(name => ({...selection, key: `view:${name}`, label: "Basins"})); h.controller.chooseModel(recipe);
    const pending = [];
    h.controller.prepareVector = (source, signal) => new Promise((resolve, reject) => pending.push({source, signal, resolve, reject}));
    const north = structuredClone(selection.filter), south = structuredClone(north); south.rules[0].value = "South";
    for (const name of ["study", "reference"]) h.controller.chooseArea(name, "vector");
    const study = h.controller.selectVectorFeatures("study", "view:study", north);
    const reference = h.controller.selectVectorFeatures("reference", "view:reference", south);
    assert.equal(pending[0].signal.aborted, false);
    pending[1].resolve({selection: {...selection, filter: pending[1].source.filter}, matched: 1, total: 8}); await reference;
    assert.equal(h.controller.state.draft.inputs.study.selecting, true);
    pending[0].resolve({selection: {...selection, filter: pending[0].source.filter}, matched: 3, total: 8}); await study;
    const inputs = h.controller.state.draft.inputs;
    assert.equal(inputs.study.vectorInfo.matched, 3); assert.equal(inputs.reference.vectorInfo.matched, 1);
    assert.deepEqual(inputs.study.area.selection.filter, north); assert.deepEqual(inputs.reference.area.selection.filter, south);
    const cancelled = h.controller.selectVectorFeatures("study", "view:study", south);
    const replacement = h.controller.selectVectorFeatures("reference", "view:reference", north);
    h.controller.chooseArea("study", "whole");
    assert.equal(pending[2].signal.aborted, true); assert.equal(pending[3].signal.aborted, false);
    pending[2].resolve({selection: {...selection, filter: south}, matched: 1, total: 8}); await cancelled;
    pending[3].resolve({selection: {...selection, filter: north}, matched: 3, total: 8}); await replacement;
    const failed = h.controller.selectVectorFeatures("reference", "view:reference", south);
    pending[4].reject(new Error("Could not read features"));
    await assert.rejects(failed, /Could not read features/);
    assert.deepEqual(inputs.study.area, {kind: "wholeRaster"}); assert.equal(inputs.study.selectionError, "");
    assert.deepEqual(inputs.reference.area.selection.filter, north); assert.equal(inputs.reference.vectorInfo.matched, 3);
    assert.match(inputs.reference.selectionError, /previous selection is unchanged/);
    h.controller.destroy();
});

test("a mixed raster recipe offers completed results only to fields that accept them", async () => {
    const view = new ModelsView(new SummaryControlDocument()), h = fixture({}, view), artifacts = fileManifest();
    const parent = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    const recipe = {...model, inputs: {original: {type: "catalog_raster", label: "Original raster"},
        processed: {type: "raster", label: "Processed raster"}, area: model.inputs.area}};
    h.controller.rememberRun(parent); h.controller.chooseModel(recipe);
    const controls = view.setup.inputs, draft = h.controller.state.draft;
    assert.deepEqual(controls.original.source.children.map(option => option.value), ["", modelSourceKey(raster)]);
    assert.deepEqual(controls.processed.source.children.slice(1).map(group => group.label), ["Map layers", "Completed runs"]);
    const source = draft.sources.find(value => value.kind === "runArtifact");
    controls.processed.source.value = modelSourceKey(source); controls.processed.source.dispatchEvent(new Event("change"));
    assert.deepEqual(captureModelSubmission(draft, "mixed-inputs").inputs, {
        original: {collectionId: raster.collectionId, itemId: raster.itemId},
        processed: {kind: "runArtifact", jobId: source.jobId, artifactId: source.artifactId}, area});
    controls.original.source.value = ""; controls.original.source.dispatchEvent(new Event("change"));
    assert.equal(view.setup.run.disabled, true); assert.equal(draft.inputs.processed.raster.artifactId, source.artifactId);
    controls.original.source.value = modelSourceKey(raster); controls.original.source.dispatchEvent(new Event("change"));
    assert.equal(view.setup.run.disabled, false);
    h.context.rasters = []; h.controller.refreshMapLayers();
    assert.equal(draft.inputs.original.raster, null); assert.equal(draft.inputs.processed.raster.artifactId, source.artifactId);
    assert.equal(view.setup.run.disabled, true);
    h.controller.destroy();
});

test("Run captures the current box while later map edits and closing leave accepted work unchanged", async () => {
    const h = fixture(); h.controller.chooseModel(model);
    h.context.area.selectedBounds.west = -10; h.context.rasters[0].label = "Renamed layer";
    await h.controller.submit();
    assert.equal(h.submitted[0].inputs.raster.itemId, "population"); assert.equal(h.submitted[0].inputs.area.selectedBounds.west, -10);
    h.context.area.selectedBounds.west = -20; h.controller.refreshMapArea();
    assert.equal(h.submitted[0].inputs.area.selectedBounds.west, -10);
    h.handlers.onClose(); h.controller.navigate("library"); h.controller.destroy();
    assert.deepEqual(h.cancelled, []); assert.equal(h.values.size, 0);
});

test("a lost submission response survives reload and retries the exact captured request", async () => {
    const h = fixture({submitModelRun: async () => { throw new TypeError("Connection lost"); }});
    h.controller.chooseModel(model); await h.controller.submit();
    const captured = structuredClone(h.controller.state.pending); assert.ok(captured);
    assert.equal(captured.utcOffsetMinutes, 0 - new Date().getTimezoneOffset());
    assert.equal(captured.label, model.title);
    h.controller.chooseModel(model); h.controller.editDraft({label: "Different draft"});
    const next = fixture(); next.controller.storage = h.storage; next.controller.start();
    await next.controller.submit(true);
    assert.deepEqual(next.submitted[0], captured); assert.equal(next.controller.state.pending, null);
    assert.equal(next.controller.state.page, "run");
});

test("captured timezone offsets survive the recovery storage JSON round trip", () => {
    const draft = createModelDraft(model, {rasters: [raster], area}, "timezone-recovery");
    for (const offset of [-420, 0, -0, 330]) {
        const captured = captureModelSubmission(draft, "timezone-request", offset);
        assert.deepEqual(JSON.parse(JSON.stringify(captured)), captured);
    }
});

test("run names count Unicode characters consistently when capturing a submission", () => {
    const draft = createModelDraft(model, {rasters: [raster], area}, "unicode-name");
    draft.label = "🌳".repeat(80);
    assert.equal(captureModelSubmission(draft, "unicode-request", -420).label, draft.label);
    draft.label += "🌳";
    assert.throws(() => captureModelSubmission(draft, "unicode-request", -420), /1–80 characters/);
});

test("definite rejection leaves the draft editable and does not silently retry", async () => {
    const h = fixture({submitModelRun: async () => { throw new ProcessingRequestError("Invalid formula", 422); }});
    h.controller.chooseModel(model); await h.controller.submit();
    assert.equal(h.controller.state.pending, null); assert.match(h.controller.state.error, /Invalid formula/); assert.equal(h.values.size, 0);
});

test("late submission and saved-input replies cannot replace a newly selected draft", async () => {
    let accept; const h = fixture({submitModelRun: () => new Promise(resolve => { accept = resolve; })});
    h.controller.chooseModel(model); const pending = h.controller.submit();
    h.controller.chooseModel(model); const current = h.controller.state.draft.id;
    accept(job()); await pending;
    assert.equal(h.controller.state.page, "setup"); assert.equal(h.controller.state.draft.id, current); assert.equal(h.controller.state.runs.length, 1);
    let reply; h.api.readModelInvocation = () => new Promise(resolve => { reply = resolve; });
    const reading = h.controller.showRun(job().jobId); h.controller.chooseModel(model); reply(invocation); await reading;
    assert.equal(h.controller.state.page, "setup"); assert.equal(h.controller.state.invocation, null);
});

test("progress observation preserves setup and explicit cancellation targets just its run", async () => {
    const h = fixture(); h.controller.chooseModel(model); const draft = h.controller.state.draft;
    h.jobs.accept(job({status: "running", progress: {phase: "calculating", completed: 2, total: 4, unit: "blocks"}}));
    assert.equal(h.controller.state.draft, draft); assert.equal(h.controller.state.page, "setup");
    await h.controller.showRun(job().jobId); await h.controller.cancelRun();
    assert.deepEqual(h.cancelled, [job().jobId]); assert.equal(h.controller.state.runs[0].status, "cancelled");
});

test("Runs history controls load result inputs while preserving unfinished setup", async () => {
    const cursors = [], artifacts = fileManifest();
    const result = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    const recent = job({jobId: "2".repeat(32)}), older = job({jobId: "3".repeat(32)});
    const view = new ModelsView(new SummaryControlDocument());
    const h = fixture({listModelRuns: async cursor => {
        cursors.push(cursor);
        return {jobs: cursor ? [older, result] : [recent], nextCursor: cursor ? null : "older"};
    }}, view);
    h.controller.chooseModel({...model, inputs: {...model.inputs, raster: {type: "raster", label: "Raster"}}});
    const draft = h.controller.state.draft;
    h.controller.editDraft({label: "Unfinished summary", parameters: {summary: "mean(a)"}});
    view.navigation.runs.dispatchEvent(new Event("click")); await new Promise(resolve => setImmediate(resolve));
    view.elements.more.dispatchEvent(new Event("click")); await new Promise(resolve => setImmediate(resolve));
    view.elements["refresh-runs"].dispatchEvent(new Event("click")); await new Promise(resolve => setImmediate(resolve));
    view.navigation.setup.dispatchEvent(new Event("click"));
    assert.deepEqual(cursors, [null, "older", null]);
    assert.deepEqual([...h.jobs.tracked].sort(), [recent.jobId, older.jobId]);
    assert.equal(h.controller.state.draft, draft); assert.equal(h.controller.state.page, "setup");
    assert.equal(view.setup.label.value, "Unfinished summary");
    assert.equal(view.setup.parameters.summary.value, "mean(a)");
    const source = draft.sources.find(value => value.kind === "runArtifact" && value.artifactId === artifacts.files[0].artifactId);
    assert.ok(view.setup.inputs.raster.source.querySelectorAll("option").some(option => option.value === modelSourceKey(source)));
    view.setup.inputs.raster.source.value = modelSourceKey(source);
    view.setup.inputs.raster.source.dispatchEvent(new Event("change"));
    assert.deepEqual(captureModelSubmission(draft, "older-result-input").inputs.raster,
        {kind: "runArtifact", jobId: result.jobId, artifactId: artifacts.files[0].artifactId});
    assert.equal(h.submitted.length, 0);
    h.controller.destroy();
});

test("duplicate uses the saved recipe and inputs without submitting or changing its source run", async () => {
    const h = fixture(); await h.controller.loadLibrary(); await h.controller.showRun(job().jobId);
    await h.controller.duplicateRun();
    const draft = h.controller.state.draft;
    assert.deepEqual(captureModelSubmission(draft, "retry-key-1234567").inputs, invocation.inputs);
    draft.parameters.summary = "mean(a)";
    assert.equal(h.controller.state.invocation.parameters.summary, "sum(a)"); assert.equal(h.submitted.length, 0);
    h.controller.state.library = []; h.controller.state.page = "run";
    await h.controller.duplicateRun(); assert.match(h.controller.state.error, /not available in model setup/);
});

test("a late vector preparation cannot overwrite a newer area choice", async () => {
    const h = fixture();
    h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, label: "Basins", filter: selection.filter}];
    h.controller.chooseModel(model); const draft = h.controller.state.draft;
    let resolve; h.controller.prepareVector = () => new Promise(done => { resolve = done; });
    h.controller.chooseArea("area", "vector"); const reading = h.controller.chooseVector("area", JSON.stringify([selection.collectionId, selection.itemId]));
    h.controller.chooseArea("area", "whole"); resolve({selection, matched: 3, total: 8}); await reading;
    assert.deepEqual(draft.inputs.area.area, {kind: "wholeRaster"}); assert.equal(draft.inputs.area.selecting, false);
});

test("model modules do not import sibling controllers, rendering or map state", () => {
    const files = readdirSync(new URL("../../src/models/", import.meta.url)).filter(file => file.endsWith(".js"));
    for (const file of files) {
        const source = readFileSync(new URL(`../../src/models/${file}`, import.meta.url), "utf8");
        assert.doesNotMatch(source, /from ["'][^"']*(?:summary-statistics|raster-clips|raster\/|map-layers|vector\/|main\.js)/);
        assert.doesNotMatch(source, /beforeunload|pagehide|cancelOnClose/);
    }
});


test("captured map and run areas do not guess a live view from matching source predicates", async () => {
    const h = fixture();
    h.context.area = {kind: "catalogSelection", catalogSelection: selection};
    h.context.vectors = ["first", "second"].map(key => ({...selection, key: `view:${key}`, label: key}));
    let prepared = 0; h.controller.prepareVector = async () => { prepared += 1; return {selection, matched: 3, total: 8}; };
    h.controller.chooseModel(model);
    assert.equal(h.controller.state.draft.inputs.area.areaMode, "captured");
    assert.equal(h.controller.state.draft.inputs.area.vectorKey, "");
    assert.deepEqual(h.controller.state.draft.inputs.area.area.selection, selection);
    await h.controller.loadLibrary(); await h.controller.showRun(job().jobId); await h.controller.duplicateRun();
    await Promise.resolve();
    assert.equal(prepared, 0); assert.deepEqual(h.controller.state.draft.inputs.area.area, invocation.inputs.area);
    h.controller.chooseArea("area", "whole"); h.controller.chooseArea("area", "captured");
    assert.deepEqual(h.controller.state.draft.inputs.area.area, invocation.inputs.area);
});


test("visible map area follows map changes and Run captures the latest viewport", async () => {
    const h = fixture(); h.context.area = null;
    h.context.viewportBounds = {west: -10, south: -5, east: 10, north: 5};
    h.controller.chooseModel(model); h.controller.chooseArea("area", "viewport");
    assert.deepEqual(h.controller.state.draft.inputs.area.area, {kind: "selectedArea", selectedBounds: h.context.viewportBounds});
    h.context.viewportBounds.west = -20; h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.inputs.area.area.selectedBounds.west, -20);
    // Submission also reads the latest bounds if it precedes moveend.
    h.context.viewportBounds.west = -25;
    await h.controller.submit();
    assert.equal(h.submitted.length, 1); assert.equal(h.submitted[0].inputs.area.selectedBounds.west, -25);
    h.context.viewportBounds.west = -30; h.controller.refreshMapArea();
    assert.equal(h.submitted[0].inputs.area.selectedBounds.west, -25);
});

test("map box follows clicks and resizing; a cleared selection cannot run the previous box", async () => {
    const h = fixture(); h.controller.chooseModel(model);
    assert.equal(h.controller.state.draft.inputs.area.areaMode, "samplingArea");
    h.context.area.selectedBounds.west = -10; h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.inputs.area.area.selectedBounds.west, -10);
    h.context.area.selectedBounds.east = 10; h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.inputs.area.area.selectedBounds.east, 10);
    h.context.area = null; h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.inputs.area.area, null);
    assert.match(h.controller.state.draft.inputs.area.selectionError, /Click the map/);
    await h.controller.submit(); assert.equal(h.submitted.length, 0);
    h.context.area = structuredClone(area); h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.inputs.area.selectionError, "");
    await h.controller.submit(); assert.equal(h.submitted.length, 1);
});

test("map changes preserve duplicate areas, model vector filters and recoverable submissions", async () => {
    const h = fixture(); await h.controller.loadLibrary(); await h.controller.showRun(job().jobId);
    await h.controller.duplicateRun();
    h.context.area.selectedBounds.west = -10; h.controller.refreshMapArea();
    assert.deepEqual(h.controller.state.draft.inputs.area.area, invocation.inputs.area);
    await h.controller.submit(); assert.deepEqual(h.submitted[0].inputs.area, invocation.inputs.area);
    h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    const draft = h.controller.state.draft; draft.inputs.area.area = {kind: "catalogSelection", selection};
    h.controller.refreshMapArea(); assert.deepEqual(draft.inputs.area.area, {kind: "catalogSelection", selection});
    h.controller.chooseArea("area", "samplingArea");
    h.api.submitModelRun = async () => { throw new TypeError("Connection lost"); };
    await h.controller.submit(); const pending = structuredClone(h.controller.state.pending);
    h.context.area.selectedBounds.west = -20; h.controller.refreshMapArea();
    assert.deepEqual(h.controller.state.pending, pending);
    assert.deepEqual(draft.inputs.area.area, pending.inputs.area);
});

test("map-linked setup refreshes after navigation and an invalid viewport clears its old bounds", () => {
    const h = fixture(); h.controller.chooseModel(model);
    h.controller.navigate("library"); h.context.area.selectedBounds.west = -5;
    h.controller.navigate("setup"); assert.equal(h.controller.state.draft.inputs.area.area.selectedBounds.west, -5);
    h.context.viewportBounds = {west: -10, south: -5, east: 10, north: 5}; h.controller.chooseArea("area", "viewport");
    h.context.viewportBounds = null; h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.inputs.area.area, null); assert.match(h.controller.state.draft.inputs.area.selectionError, /unavailable/);
    h.context.viewportBounds = {west: -20, south: -5, east: 10, north: 5}; h.controller.setActive(true);
    assert.equal(h.controller.state.draft.inputs.area.area.selectedBounds.west, -20);
});

test("viewport capture excludes blank world margins and rejects unavailable or empty bounds", () => {
    assert.deepEqual(modelViewportArea({west: -240, south: -95, east: 240, north: 95}),
        {kind: "selectedArea", selectedBounds: {west: -180, south: -90, east: 180, north: 90}});
    assert.throws(() => modelViewportArea(null), /unavailable/);
    assert.throws(() => modelViewportArea({west: 0, east: 0, south: 0, north: 10}), /no visible area/);
    assert.throws(() => modelViewportArea({west: NaN, south: 0, east: 20, north: 10}), /unavailable/);
    assert.throws(() => modelViewportArea({west: 190, south: 0, east: 200, north: 10}), /inside the world/);
    const h = fixture(); h.controller.chooseModel(model); h.controller.chooseArea("area", "viewport");
    assert.equal(h.controller.state.draft.inputs.area.area, null); assert.match(h.controller.state.draft.inputs.area.selectionError, /unavailable/);
});


test("model filtering checks features then updates the map through composition without submitting a run", async () => {
    const h = fixture();
    h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, label: "Basins", filter: structuredClone(selection.filter)}];
    h.controller.prepareVector = async source => ({selection: {...selection, filter: structuredClone(source.filter)}, matched: source.filter.rules[0]?.value === "South" ? 1 : 3, total: 8});
    h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    await h.controller.chooseVector("area", JSON.stringify([selection.collectionId, selection.itemId]));
    const doc = new FakeRasterControlDocument(); let request;
    const controls = new VectorFilterControls({documentContext: doc,
        getTarget: () => ({label: "Basins", fields: [{name: "BASIN", type: "str"}], filter: selection.filter,
            apply: () => assert.fail("Composition must own the map update"), cancelPending: () => assert.fail("Model filter must not cancel map work")}),
        inspection: {showFilter() {}, hideFilter() {}, updateLayerEditorName() {}},
        setTimer: () => assert.fail("Model filter must require explicit application"), clearTimer() {},
    });
    h.controller.editVectorFilter = value => { request = value; controls.open(value.key, {...value, applyLabel: "Apply filter", filterLabel: "Selected features", onClose: value.close, help: "Choose features for this model."}); };
    h.controller.closeVectorFilter = () => controls.close();
    await h.controller.openVectorFilter("area");
    assert.match(request.key, /^model:/); assert.equal(controls.applyButton.textContent, "Apply filter");
    assert.match(controls.applied.textContent, /^Selected features:/); assert.equal(controls.help.textContent, "Choose features for this model.");
    const input = controls.rules.children[0].children[2]; input.value = "South"; input.dispatchEvent(new Event("input"));
    assert.equal(h.controller.state.draft.inputs.area.area.selection.filter.rules[0].value, "North");
    controls.applyButton.dispatchEvent(new Event("click")); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.controller.state.draft.inputs.area.area.selection.filter.rules[0].value, "South");
    assert.equal(h.controller.state.draft.inputs.area.vectorInfo.matched, 1); assert.equal(controls.key, null);
    assert.equal(h.context.vectors[0].filter.rules[0].value, "South"); assert.equal(h.submitted.length, 0);
    await h.controller.openVectorFilter("area");
    controls.rules.children[0].children[2].value = "West"; controls.rules.children[0].children[2].dispatchEvent(new Event("input"));
    controls.close(); assert.equal(h.controller.state.draft.inputs.area.area.selection.filter.rules[0].value, "South");
    await h.controller.openVectorFilter("area");
    h.controller.prepareVector = (_source, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Closed", "AbortError"))));
    controls.applyButton.dispatchEvent(new Event("click")); controls.close(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.controller.state.draft.inputs.area.area.selection.filter.rules[0].value, "South");
    assert.equal(h.controller.state.draft.inputs.area.selecting, false);
    await h.controller.submit(); assert.equal(h.submitted[0].inputs.area.selection.filter.rules[0].value, "South");
    assert.equal(h.context.vectors[0].filter.rules[0].value, "South"); controls.destroy();
});

for (const source of [
    {collectionId: selection.collectionId, itemId: selection.itemId},
    {uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", layerName: "basins"},
]) test(`model choices keep ${source.uploadId ? "uploaded" : "Catalog"} vector views and their filters separate`, async () => {
    const view = new ModelsView(new SummaryControlDocument());
    const h = fixture({}, view);
    const north = structuredClone(selection.filter), south = structuredClone(selection.filter), west = structuredClone(selection.filter);
    south.rules[0].value = "South"; west.rules[0].value = "West";
    h.context.vectors = [
        {...source, key: "view:north", label: "Northern basins", filter: north},
        {...source, key: "view:south", label: "Southern basins", filter: south},
    ];
    const selectedSource = source.uploadId ? source : selection;
    h.controller.prepareVector = async value => ({selection: {...selectedSource, filter: structuredClone(value.filter)}, matched: 1, total: 8});
    await h.controller.loadLibrary(); h.controller.chooseModel(model); h.controller.editInput("raster", {raster});
    const controls = view.setup.inputs.area;
    controls.areaMode.value = "vector"; controls.areaMode.dispatchEvent(new Event("change"));
    assert.deepEqual(controls.vector.children.map(option => [option.value, option.textContent]), [
        ["", "Choose a vector layer…"], ["view:north", "Northern basins"], ["view:south", "Southern basins"],
    ]);
    controls.vector.value = "view:south"; controls.vector.dispatchEvent(new Event("change"));
    await new Promise(resolve => setImmediate(resolve));
    const input = h.controller.state.draft.inputs.area;
    assert.equal(input.vectorKey, "view:south");
    assert.equal(input.vectorInfo.label, "Southern basins");
    assert.deepEqual(input.area.selection.filter, south);
    controls.editFilter.dispatchEvent(new Event("click"));
    await new Promise(resolve => setImmediate(resolve));
    const editing = h.filterRequests.at(-1);
    assert.equal(editing.source.key, "view:south");
    await editing.apply(west); editing.complete();
    h.context.vectors.reverse(); h.controller.refreshMapLayers();
    assert.equal(controls.vector.value, "view:south");
    assert.deepEqual(input.vectors.find(value => value.key === "view:north").filter, north);
    assert.deepEqual(h.context.vectors.find(value => value.key === "view:north").filter, north);
    assert.deepEqual(input.area.selection.filter, west);
    await h.controller.submit();
    assert.deepEqual(h.submitted[0].inputs.area.selection, {...selectedSource, filter: west});
    assert.doesNotMatch(JSON.stringify(h.submitted[0].inputs), /view:north|view:south/);

    h.context.vectors = h.context.vectors.filter(value => value.key === "view:north");
    h.controller.refreshMapLayers();
    assert.equal(input.vectorKey, "");
    assert.equal(input.area, null);
    h.context.vectors.push({...source, key: "view:south", label: "Southern basins", filter: south});
    h.api.readModelInvocation = async () => ({...h.submitted[0], model: {...model, definition: model}});
    await h.controller.showRun(job().jobId); await h.controller.duplicateRun();
    const copied = h.controller.state.draft.inputs.area;
    assert.equal(copied.vectorKey, "");
    assert.equal(copied.areaMode, "captured");
    assert.deepEqual(copied.area.selection.filter, west);
    assert.deepEqual(copied.vectors[0].filter, north);
    assert.deepEqual(copied.vectors[1].filter, south);
    assert.deepEqual(h.context.vectors[0].filter, north);
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "another-request-id").inputs, h.submitted[0].inputs);
});

test("failed and cancelled filter reads preserve the prior reviewed vector selection", async () => {
    const h = fixture(); h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    await h.controller.chooseVector("area", JSON.stringify([selection.collectionId, selection.itemId]));
    const previous = structuredClone(h.controller.state.draft.inputs.area.area);
    await h.controller.openVectorFilter("area"); const action = h.filterRequests[0];
    h.controller.prepareVector = async () => { throw Error("No polygons match"); };
    await assert.rejects(action.apply(selection.filter), /No polygons match/);
    assert.deepEqual(h.controller.state.draft.inputs.area.area, previous); assert.match(h.controller.state.draft.inputs.area.selectionError, /unchanged/);
    h.controller.prepareVector = (_source, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError"))));
    const pending = action.apply(selection.filter); action.cancel(); assert.equal(await pending, null);
    assert.deepEqual(h.controller.state.draft.inputs.area.area, previous); assert.equal(h.controller.state.draft.inputs.area.selecting, false);
    assert.equal(h.submitted.length, 0); assert.deepEqual(h.cancelled, []);
});

test("old filter actions and late selection replies cannot change a newer model area", async () => {
    const h = fixture(); h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    const key = JSON.stringify([selection.collectionId, selection.itemId]); await h.controller.chooseVector("area", key);
    await h.controller.openVectorFilter("area"); const action = h.filterRequests[0];
    let finish; h.controller.prepareVector = () => new Promise(resolve => { finish = resolve; });
    const pending = action.apply(selection.filter); h.controller.chooseArea("area", "whole");
    finish({selection, matched: 3, total: 8}); assert.equal(await pending, null);
    assert.deepEqual(h.controller.state.draft.inputs.area.area, {kind: "wholeRaster"});
    assert.throws(() => action.apply(selection.filter), /setup changed/);
    h.controller.chooseArea("area", "vector"); await h.controller.chooseVector("area", "");
    assert.equal(h.controller.state.draft.inputs.area.vectorKey, ""); assert.equal(h.controller.state.draft.inputs.area.area, null);
});

test("duplicated vector runs retain their original filter until a live view is chosen", async () => {
    const saved = structuredClone(invocation); saved.inputs.area = {kind: "catalogSelection", selection: structuredClone(selection)};
    const h = fixture({readModelInvocation: async () => saved});
    h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    await h.controller.loadLibrary(); await h.controller.showRun(job().jobId); await h.controller.duplicateRun();
    assert.equal(h.controller.state.draft.inputs.area.areaMode, "captured");
    await h.controller.openVectorFilter("area"); assert.equal(h.filterRequests.length, 0);
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "another-request-id").inputs, saved.inputs);
    const changed = structuredClone(selection.filter); changed.rules[0].value = "South";
    h.context.vectors[0].filter = changed; h.controller.refreshMapLayers();
    assert.deepEqual(h.controller.state.draft.inputs.area.area.selection.filter, selection.filter);
    h.controller.chooseArea("area", "vector");
    await h.controller.chooseVector("area", h.context.vectors[0].key);
    assert.deepEqual(h.controller.state.draft.inputs.area.area.selection.filter, changed);
    assert.equal(h.submitted.length, 0);
});

for (const recipe of [model, clipModel]) test(`${recipe.title} preserves uploaded choices and filters through selection and run duplication`, async () => {
    let saved;
    const h = fixture({discoverModels: async () => [recipe], readModelInvocation: async () => saved});
    const uploads = ["75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", "bc3e4f52-1477-44f4-a4d5-a36f74158028"];
    h.context.vectors = uploads.map((uploadId, index) => ({uploadId, key: `local:upload:${uploadId}`,
        label: `Uploaded basins ${index + 1}`, filter: structuredClone(selection.filter), fields: [{name: "BASIN", type: "str"}]}));
    const uploaded = {uploadId: uploads[1], layerName: "basins", filter: structuredClone(selection.filter)};
    h.context.area = {kind: "catalogSelection", catalogSelection: uploaded};
    h.controller.prepareVector = async source => ({selection: {uploadId: source.uploadId, layerName: "basins", filter: source.filter}, matched: 1, total: 3});
    await h.controller.loadLibrary(); h.controller.chooseModel(recipe); await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(modelSourceKey(h.context.vectors[0]), modelSourceKey(h.context.vectors[1]));
    assert.equal(h.controller.state.draft.inputs.area.areaMode, "captured");
    assert.equal(h.controller.state.draft.inputs.area.vectorKey, "");
    assert.deepEqual(h.controller.state.draft.inputs.area.area.selection, uploaded);
    h.controller.chooseArea("area", "vector");
    await h.controller.chooseVector("area", h.context.vectors[1].key);
    const filter = structuredClone(uploaded.filter); filter.rules[0].value = "South";
    await h.controller.selectVectorFeatures("area", h.context.vectors[1].key, filter);
    assert.equal(h.mapFilters[0].source.key, h.context.vectors[1].key);
    assert.deepEqual(h.context.vectors[0].filter, selection.filter);
    const submitted = captureModelSubmission(h.controller.state.draft, "uploaded-request");
    assert.deepEqual(submitted.inputs.area.selection, {...uploaded, filter});
    saved = {...submitted, model: {...recipe, definition: recipe}};
    await h.controller.submit();
    assert.deepEqual(h.submitted[0].inputs, submitted.inputs);
    h.context.vectors[1].filter = structuredClone(selection.filter);
    await h.controller.duplicateRun();
    const duplicate = h.controller.state.draft;
    assert.deepEqual(duplicate.inputs.area.vectors[1], h.context.vectors[1]);
    assert.equal(duplicate.inputs.area.areaMode, "captured");
    assert.deepEqual(captureModelSubmission(duplicate, "duplicate-upload").inputs, submitted.inputs);
    h.context.vectors.pop(); h.controller.refreshMapLayers();
    assert.deepEqual(captureModelSubmission(duplicate, "removed-upload-view").inputs, submitted.inputs);
});


test("late catalog metadata cannot open a filter after the Models panel closes", async () => {
    const h = fixture(); h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    await h.controller.chooseVector("area", JSON.stringify([selection.collectionId, selection.itemId]));
    h.controller.setActive(true); let release; let opened = false;
    h.controller.editVectorFilter = async request => { await new Promise(resolve => { release = resolve; }); opened = request.isCurrent(); };
    const opening = h.controller.openVectorFilter("area"); h.controller.setActive(false); release(); await opening;
    assert.equal(opened, false); assert.equal(h.controller.state.draft.inputs.area.filterOpening, false);
});


test("cancelling a replacement filter read preserves the last reviewed selection", async () => {
    const h = fixture(); h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    await h.controller.chooseVector("area", JSON.stringify([selection.collectionId, selection.itemId]));
    const previous = structuredClone(h.controller.state.draft.inputs.area.area); await h.controller.openVectorFilter("area");
    const replies = []; h.controller.prepareVector = () => new Promise(resolve => replies.push(resolve));
    const action = h.filterRequests[0]; const first = action.apply(selection.filter); const second = action.apply(selection.filter);
    action.cancel(); replies[1]({selection, matched: 3, total: 8}); assert.equal(await second, null);
    replies[0]({selection, matched: 3, total: 8}); assert.equal(await first, null);
    assert.deepEqual(h.controller.state.draft.inputs.area.area, previous); assert.equal(h.controller.state.draft.inputs.area.selecting, false);
});

test("model filter edits become the view filter used after switching areas", async () => {
    const h = fixture(); const source = {key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter};
    h.context.vectors = [source]; h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    const key = JSON.stringify([selection.collectionId, selection.itemId]); await h.controller.chooseVector("area", key);
    const edited = structuredClone(selection.filter); edited.rules[0].value = "South";
    h.controller.prepareVector = async value => ({selection: {...selection, filter: value.filter}, matched: 1, total: 8});
    await h.controller.openVectorFilter("area"); await h.filterRequests[0].apply(edited);
    h.controller.refreshMapLayers();
    h.controller.chooseArea("area", "whole"); h.controller.chooseArea("area", "vector"); await h.controller.chooseVector("area", key);
    assert.equal(h.controller.state.draft.inputs.area.area.selection.filter.rules[0].value, "South");
    assert.equal(h.context.vectors[0].filter.rules[0].value, "South");
});

test("live inputs using one vector view share edits while submitted recipes stay fixed", async () => {
    const recipe = {...model, inputs: {raster: model.inputs.raster, study: model.inputs.area, reference: model.inputs.area}};
    const h = fixture({discoverModels: async () => [recipe]}, new ModelsView(new SummaryControlDocument()));
    h.context.vectors = [{...selection, key: "view:basins", label: "Basins", fields: [{name: "BASIN", type: "str"}]}];
    h.controller.prepareVector = async source => ({selection: {...selection, filter: source.filter},
        matched: source.filter.rules[0].value === "North" ? 3 : 1, total: 8});
    const publication = {layerName: "eolab:basins", style: {geometryKind: "polygon", fillColor: "#123456", fillOpacity: 1,
        strokeColor: "#000000", strokeOpacity: 1, strokeWidth: 1, pointSize: null, categorical: null, graduated: null, label: null}};
    const item = {collection: selection.collectionId, id: selection.itemId,
        properties: {"table:columns": [{name: "BASIN", type: "str"}]}};
    const adapter = createVectorMapLayerAdapter({leaflet: {}, leafletMap: {}, wmsUrl: "/wms", onTileError() {},
        filter: async (_source, filter) => ({layerName: "eolab:filtered-basins", filter}),
        countFilter: async () => ({matched: 3, total: 8, complete: true}),
        onFilterChange: () => {
            h.context.vectors[0].filter = adapter.describeFilter(record).filter;
            h.controller.refreshMapLayers();
        }});
    const record = {entry: {key: "view:basins", item}, publication,
        state: adapter.createState({item, publication, source: {restore: {filter: selection.filter}}})};
    h.controller.applyMapFilter = (source, area) => {
        h.mapFilters.push({source, filter: area.selection.filter});
        return adapter.applyCheckedFilter(record, area.selection.filter, {matched: area.matched, total: area.total, complete: true});
    };
    await h.controller.loadLibrary(); h.controller.chooseModel(recipe);
    for (const name of ["study", "reference"]) {
        h.controller.chooseArea(name, "vector"); await h.controller.chooseVector(name, "view:basins");
    }
    const south = structuredClone(selection.filter); south.rules[0].value = "South";
    await h.controller.openVectorFilter("study");
    const editor = h.filterRequests.at(-1); await editor.apply(south); editor.complete();
    await new Promise(resolve => setImmediate(resolve));
    const inputs = h.controller.state.draft.inputs;
    for (const name of ["study", "reference"]) {
        assert.deepEqual(inputs[name].area.selection.filter, south);
        assert.equal(inputs[name].vectorInfo.matched, 1);
    }
    assert.equal(h.mapFilters.length, 1, "reading another input does not apply the filter again");
    assert.deepEqual(adapter.describeFilter(record).filter, south);
    assert.match(adapter.describeFilter(record).status, /1 of 8 features match/);
    await h.controller.submit();
    const submitted = structuredClone(h.submitted[0]);
    await adapter.applyFilterState(record, selection.filter);
    await new Promise(resolve => setImmediate(resolve));
    for (const name of ["study", "reference"]) {
        assert.deepEqual(inputs[name].area.selection.filter, selection.filter);
        assert.equal(inputs[name].vectorInfo.matched, 3);
    }
    assert.deepEqual(h.submitted[0], submitted);
    h.controller.destroy();
});

test("changed view filters cancel stale reads and cannot leave an older model area runnable", async () => {
    const h = fixture();
    h.context.vectors = [{...selection, key: "view:basins", label: "Basins"}];
    h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    await h.controller.chooseVector("area", "view:basins");
    const requests = [];
    h.controller.prepareVector = (source, signal) => new Promise((resolve, reject) => requests.push({source, signal, resolve, reject}));
    const south = structuredClone(selection.filter); south.rules[0].value = "South";
    h.context.vectors[0].filter = south; h.controller.refreshMapLayers();
    h.controller.refreshMapLayers();
    assert.equal(requests.length, 1, "unchanged view notifications do not restart the same read");
    const west = structuredClone(south); west.rules[0].value = "West";
    h.context.vectors[0].filter = west; h.controller.refreshMapLayers();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({selection: {...selection, filter: south}, matched: 1, total: 8});
    requests[1].reject(new Error("Could not read selected features"));
    await new Promise(resolve => setImmediate(resolve));
    const input = h.controller.state.draft.inputs.area;
    assert.equal(input.area, null);
    assert.equal(input.selecting, false);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "failed"), /Could not read selected features/);
    assert.deepEqual(h.context.vectors[0].filter, west);
    h.controller.destroy();
});


test("removed raster and vector inputs must be added to Map layers again before Run", async () => {
    const h = fixture(); h.controller.chooseModel(model);
    h.context.rasters = []; h.controller.refreshMapLayers();
    assert.equal(h.controller.state.draft.inputs.raster.raster, null);
    await h.controller.submit(); assert.equal(h.submitted.length, 0); assert.match(h.controller.state.error, /Map layers/);
    h.context.rasters = [raster]; h.controller.refreshMapLayers(); h.controller.editInput("raster", {raster});
    h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.refreshMapLayers(); h.controller.chooseArea("area", "vector");
    await h.controller.chooseVector("area", JSON.stringify([selection.collectionId, selection.itemId]));
    h.context.vectors = []; h.controller.refreshMapLayers();
    assert.equal(h.controller.state.draft.inputs.area.area, null); assert.equal(h.controller.state.draft.inputs.area.vectorKey, "");
    await h.controller.submit(); assert.equal(h.submitted.length, 0);
});

test("duplication preserves a captured vector area without adding its view to Map layers", async () => {
    const saved = structuredClone(invocation); saved.inputs.area = {kind: "catalogSelection", selection};
    const h = fixture({readModelInvocation: async () => saved}); h.context.rasters = [];
    await h.controller.loadLibrary(); await h.controller.showRun(job().jobId); await h.controller.duplicateRun();
    assert.equal(h.controller.state.draft.inputs.raster.raster, null);
    assert.deepEqual(h.controller.state.draft.inputs.area.area, saved.inputs.area);
    assert.deepEqual(h.controller.state.draft.sources, []); assert.deepEqual(h.controller.state.draft.inputs.area.vectors, []);
    assert.equal(h.controller.state.draft.inputs.area.areaMode, "captured");
});


test("filters can be edited during initial selection; closing before Apply leaves that check running", async () => {
    const h = fixture(); h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    let finish, signal;
    h.controller.prepareVector = (_source, abort) => { signal = abort; return new Promise(resolve => { finish = resolve; }); };
    const pending = h.controller.chooseVector("area", JSON.stringify([selection.collectionId, selection.itemId]));
    await h.controller.openVectorFilter("area");
    assert.equal(h.filterRequests.length, 1); assert.equal(h.controller.state.draft.inputs.area.filterEditing, true);
    h.filterRequests[0].close(); assert.equal(signal.aborted, false);
    finish({selection, matched: 3, total: 8}); await pending;
    assert.equal(h.controller.state.draft.inputs.area.vectorInfo.matched, 3); assert.equal(h.controller.state.draft.inputs.area.filterEditing, false);
});

test("applying while the original check runs cancels it and ignores its late reply", async () => {
    const h = fixture(); h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    const requests = [];
    h.controller.prepareVector = (source, signal) => new Promise(resolve => requests.push({source, signal, resolve}));
    const pending = h.controller.chooseVector("area", JSON.stringify([selection.collectionId, selection.itemId]));
    await h.controller.openVectorFilter("area"); const action = h.filterRequests[0];
    const changed = structuredClone(selection.filter); changed.rules[0].value = "South";
    const applying = action.apply(changed); assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve({selection: {...selection, filter: changed}, matched: 1, total: 8}); await applying; action.complete();
    requests[0].resolve({selection, matched: 3, total: 8}); await pending;
    assert.equal(h.controller.state.draft.inputs.area.vectorInfo.matched, 1);
    assert.equal(h.context.vectors[0].filter.rules[0].value, "South");
    assert.equal(h.mapFilters.length, 1); assert.equal(h.submitted.length, 0);
});

test("map filter failures do not prevent a checked model selection from running", async () => {
    const h = fixture(); h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.applyMapFilter = async () => { throw new Error("Map service unavailable"); };
    h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    await h.controller.chooseVector("area", JSON.stringify([selection.collectionId, selection.itemId]));
    await h.controller.openVectorFilter("area"); const action = h.filterRequests[0];
    await action.apply(selection.filter); action.complete();
    assert.match(h.controller.state.draft.inputs.area.mapFilterMessage, /Could not update the map filter: Map service unavailable/);
    await h.controller.submit(); assert.equal(h.submitted.length, 1);
});

test("late map filter feedback cannot overwrite a newer setup", async () => {
    const h = fixture(); h.context.vectors = [{key: modelSourceKey(selection), collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    let finish; h.controller.applyMapFilter = () => new Promise(resolve => { finish = resolve; });
    h.controller.chooseModel(model); h.controller.chooseArea("area", "vector");
    await h.controller.chooseVector("area", JSON.stringify([selection.collectionId, selection.itemId]));
    await h.controller.openVectorFilter("area"); await h.filterRequests[0].apply(selection.filter);
    h.controller.chooseModel(model); finish(selection.filter); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.controller.state.draft.inputs.area.mapFilterMessage, undefined);
});


test("choosing or clearing a raster immediately refreshes Run availability", () => {
    const view = new ModelsView(new SummaryControlDocument()); const h = fixture({}, view);
    h.context.rasters.push({...raster, itemId: "second"}); h.controller.chooseModel(model);
    assert.equal(view.setup.run.disabled, true);
    view.setup.inputs.raster.source.value = JSON.stringify([raster.collectionId, raster.itemId]);
    view.setup.inputs.raster.source.dispatchEvent(new Event("change"));
    assert.equal(view.setup.run.disabled, false);
    view.setup.inputs.raster.source.value = ""; view.setup.inputs.raster.source.dispatchEvent(new Event("change"));
    assert.equal(view.setup.run.disabled, true);
});


test("clip setup defaults to the visible map when the current area is unsupported", () => {
    const context = {rasters: [raster], area: {kind: "wholeRaster"}, viewportBounds: {west: 1, south: 2, east: 3, north: 4}};
    const draft = createModelDraft(clipModel, context, "clip");
    assert.equal(draft.inputs.area.areaMode, "viewport"); assert.deepEqual(draft.inputs.area.area.selectedBounds, context.viewportBounds);
    assert.deepEqual(captureModelSubmission(draft, "request").parameters, {});
    draft.inputs.area.area = {kind: "wholeRaster"}; assert.throws(() => captureModelSubmission(draft, "request"), /supported by this model/);
    const unavailable = createModelDraft(clipModel, {rasters: [raster]}, "no-view");
    assert.equal(unavailable.inputs.area.area, null); assert.match(unavailable.inputs.area.selectionError, /extent is unavailable/);
});

test("clip run duplication preserves its exact area and has no summary parameter", async () => {
    const saved = {...invocation, model: {...clipModel, definition: clipModel}, parameters: {}};
    const h = fixture({discoverModels: async () => [clipModel], readModelInvocation: async () => saved});
    await h.controller.loadLibrary(); await h.controller.showRun(job().jobId); await h.controller.duplicateRun();
    h.context.area.selectedBounds.west = -20; h.controller.refreshMapArea();
    assert.deepEqual(h.controller.state.draft.inputs.area.area, saved.inputs.area);
    assert.deepEqual(h.controller.state.draft.parameters, {});
    await h.controller.submit(); assert.deepEqual(h.submitted[0].inputs, saved.inputs);
    assert.equal(h.submitted[0].model.id, "raster-clip");
});
