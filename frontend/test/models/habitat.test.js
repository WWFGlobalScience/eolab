import test from "node:test";
import assert from "node:assert/strict";
import { ModelsController } from "../../src/models/controller.js";
import { ModelsView } from "../../src/models/view.js";
import { captureModelSubmission, createModelDraft, modelSourceKey } from "../../src/models/inputs.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { model, selection, job, fileManifest, clipResult } from "../../test-support/models/fixtures.js";

const habitat = {...model, id: "habitat-condition", title: "Ecosystem Condition",
    description: "Fit expected habitat responses from reference sites and map their similarity.", parameters: {}, inputs: {
    stack: {type: "habitat_stack", label: "Predictors and observed responses"},
    area: {type: "summary_area", label: "Analysis area"},
    references: {type: "habitat_references", label: "Reference sites"},
    habitat_mask: {type: "optional_raster", label: "Habitat assessment mask"},
    preparation: {type: "raster_preparation", label: "Raster preparation"},
}, steps: [{id: "calculate", operation: "habitat.condition.v1", inputs: {
    stack: {input: "stack"}, area: {input: "area"}, references: {input: "references"}, habitat_mask: {input: "habitat_mask"},
    preparation: {input: "preparation"}, settings: {value: {required_crs: "EPSG:6933",
    fold_count: 5, sampling_block_size_meters: 25000, validation_block_size_meters: 50000,
    minimum_predictor_coverage: 0.8, maximum_row_missing_fraction: 0.2, spline_knot_count: 6,
    minimum_response_coverage: 0.5, ridge_alpha: 1, samples_per_class_per_block: 100,
    random_seed: 42, tile_size_pixels: 128, tile_origin: [0, 0], window_size_pixels: 256, covariance_shrinkage: 0.1,
}}}, parameters: {}}], outputs: {
    reference_similarity: {type: "raster", label: "Reference similarity", source: "calculate.reference_similarity", role: "result", presentation: "map", saveEligible: true},
    diagnostics: {type: "raster", label: "Response diagnostics", source: "calculate.diagnostics", role: "intermediate", presentation: "download", saveEligible: false},
}};

/** Flush selection and view callbacks after a user action.
 * @return {Promise<void>} Resolves after pending promise reactions.
 */
const settle = () => new Promise(resolve => setImmediate(resolve));

const earthEngineOptions = {defaultYear: 2018, minimumYear: 2015, maximumYear: 2019,
    grid: {crs: "EPSG:6933", pixelSize: [500, 500], origin: [0, 0], unit: "metre", approximate: false}, datasets: [
        {label: "ERA5 daily aggregates", url: "https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_DAILY", roles: ["predictor"]},
        {label: "MODIS phenology", url: "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MCD12Q2", roles: ["predictor", "response"]},
        {label: "Landsat NDVI", url: "https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_COMPOSITES_C02_T1_L2_8DAY_NDVI", roles: ["response"]},
    ]};

/** Change a rendered form field through its actual event handler.
 * @param {HTMLElement} control Rendered input or select.
 * @param {string} value User-entered value.
 * @param {string} [event="change"] Event consumed by this control.
 * @return {void}
 */
function edit(control, value, event = "change") {
    control.value = value; control.dispatchEvent(new Event(event));
}

/** Open Habitat setup with real Models components and explicit API boundaries.
 * @param {Object} [contextOverrides={}] Map choices to replace in the starting context.
 * @return {Promise<Object>} Controller, view, source choices and captured API requests.
 */
async function fixture(contextOverrides = {}) {
    const requests = [], filters = [], values = new Map();
    const context = {
        rasters: ["Environment", "Habitat class", "Productivity", "Reference mask", "Assessment mask"].map((label, index) =>
            ({collectionId: "eolab-mounted-geotiffs", itemId: `geotiff-${index.toString(16).padStart(24, "0")}`, label, visible: false})),
        vectors: [{...selection, key: "view:basins", label: "Catalog basins", fields: [{name: "BASIN", type: "str"}]},
            {key: "view:sites", uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", layerName: "reference_sites", label: "Uploaded sites",
                filter: structuredClone(selection.filter), fields: [{name: "BASIN", type: "str"}]}],
        area: {kind: "selectedArea", selectedBounds: {west: 0, south: 0, east: 1, north: 1}},
        ...contextOverrides,
    };
    const api = {discoverModels: async () => [model, habitat], listModelRuns: async () => ({jobs: [], nextCursor: null}),
        getHabitatEarthEngineOptions: async () => structuredClone(earthEngineOptions),
        submitModelRun: async request => { requests.push(request); return job({model: habitat}); },
        getJob: async () => job({model: habitat}),
        readModelInvocation: async () => ({...requests[0], model: {...habitat, definition: habitat}})};
    const doc = new SummaryControlDocument(), view = new ModelsView(doc);
    const jobs = {subscribe: () => () => {}, tracked: new Set(), schedule() {}, accept() {}};
    let id = 0;
    const controller = new ModelsController({api, jobs, view, getContext: () => context,
        describeSource: async (source, _signal, targetCrs) => ({crs: "EPSG:4326",
            projectedGrid: {crs: targetCrs, pixelSize: [25000, 50000], origin: [0, 0], unit: "metre", approximate: true}}),
        prepareVector: async source => ({selection: source.uploadId
            ? {uploadId: source.uploadId, layerName: source.layerName, filter: source.filter}
            : {...selection, filter: source.filter}, matched: source.filter.rules[0].value === "North" ? 3 : 1, total: 8}),
        editVectorFilter: request => { filters.push(request); }, closeVectorFilter: () => filters.at(-1)?.close(),
        applyMapFilter: async (source, area) => {
            context.vectors.find(value => value.key === source.key).filter = area.selection.filter;
            controller.refreshMapLayers(); return area.selection.filter;
        }, onOpen: () => {}, onClose: () => {},
        storage: {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)},
        newId: () => String(++id).padStart(32, "0")});
    await controller.loadLibrary();
    assert.deepEqual(controller.state.library.map(recipe => recipe.id), [model.id, habitat.id]);
    controller.setActive(true); controller.chooseModel(habitat);
    await settle();
    return {controller, view, doc, context, api, jobs, requests, filters};
}

/** Select a vector and review the named input's filter using the composed editor.
 * @param {Object} harness Actual Models controller and view fixture.
 * @param {string} name Recipe input receiving this independent selection.
 * @param {Object} source Catalog or uploaded vector offered by the map.
 * @param {string} basin Attribute value to select.
 * @return {Promise<void>} Resolves after the filter is applied.
 */
async function chooseVector(harness, name, source, basin) {
    const controls = harness.view.setup.inputs[name];
    edit(controls.source, `vector:${source.key}`); await settle();
    controls.editFilter.dispatchEvent(new Event("click")); await settle();
    const action = harness.filters.at(-1), filter = structuredClone(selection.filter);
    assert.equal(action.host, controls.filterHost);
    filter.rules[0].value = basin; await action.apply(filter); action.complete();
}

/** Fill the predictor/response lists through their rendered controls.
 * @param {Object} harness Actual Models controller and view fixture.
 * @return {void}
 */
function chooseStack(harness) {
    const controls = harness.view.setup.inputs.stack;
    edit(controls.source, "manual");
    edit(controls.predictors[0].name, "environment", "input");
    edit(controls.predictors[0].source, modelSourceKey(harness.context.rasters[0]));
    controls.addPredictor.dispatchEvent(new Event("click"));
    edit(controls.predictors[1].name, "habitat_type", "input");
    edit(controls.predictors[1].source, modelSourceKey(harness.context.rasters[1]));
    edit(controls.responses[0].name, "productivity", "input");
    edit(controls.responses[0].source, modelSourceKey(harness.context.rasters[2]));
    edit(controls.categorical, "habitat_type");
}

test("Habitat starts with the original GEE configuration and linked datasets grouped by their roles", async () => {
    const h = await fixture(), stack = h.view.setup.inputs.stack;
    const chooser = h.view.elements["library-items"].querySelectorAll("button").find(button => button.textContent === "Ecosystem Condition");
    assert.equal(chooser.getAttribute("aria-label"), "Set up Ecosystem Condition");
    assert.equal(h.view.elements["setup-heading"].textContent, "Ecosystem Condition");
    assert.equal(h.view.setup.fields.getAttribute("aria-labelledby"), "models-setup-heading");
    assert.equal(h.view.setup.label.value, "Ecosystem Condition");
    assert.equal(stack.source.value, "earthEngine");
    assert.equal(stack.source.parentElement.textContent, "Input configuration");
    assert.equal(stack.source.children[0].textContent, "Original model inputs (Google Earth Engine)");
    assert.equal(stack.manual.hidden, true); assert.equal(stack.manual.disabled, true);
    assert.equal(stack.year.value, "2018");
    const links = stack.root.querySelectorAll("a");
    assert.equal(links[0].textContent, "NHI Terrestrial Integrity Modeling");
    assert.equal(links[0].href, "https://github.com/springinnovate/nhi-terrestrial-integrity-modeling");
    const administration = links.find(link => link.textContent === "Manage cached inputs");
    assert.equal(administration.href, "/admin-eolab/habitat");
    assert.equal(administration.target, "_blank");
    assert.equal(administration.rel, "noopener noreferrer");
    for (const [role, list] of Object.entries(stack.datasetLists)) {
        assert.deepEqual(list.children.map(item => ({label: item.children[0].textContent, url: item.children[0].href})),
            earthEngineOptions.datasets.filter(dataset => dataset.roles.includes(role)).map(({label, url}) => ({label, url})));
    }
    assert.deepEqual(h.controller.state.draft.inputs.area.area.selectedBounds, h.context.area.selectedBounds);
    assert.equal(h.requests.length, 0, "Opening the default configuration does not submit a calculation");
    h.controller.destroy();
});

for (const area of [undefined, {kind: "wholeRaster"}]) test(`Default GEE setup uses the visible area instead of ${area ? "a whole raster" : "an absent area"}`, () => {
    const viewportBounds = {west: -109, south: 46, east: -107, north: 48};
    const draft = createModelDraft(habitat, {area, viewportBounds}, "default-area");
    assert.equal(draft.inputs.stack.kind, "earthEngine");
    assert.equal(draft.inputs.area.areaMode, "viewport");
    assert.deepEqual(draft.inputs.area.area, {kind: "selectedArea", selectedBounds: viewportBounds});
});

test("Default GEE setup requires an explicit area when the map cannot supply one", async () => {
    const h = await fixture({area: undefined});
    await chooseVector(h, "references", h.context.vectors[0], "North");
    assert.equal(h.controller.state.draft.inputs.area.area, null);
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "no-area"), /visible map extent/i);
    h.controller.destroy();
});

for (const [label, areaIndex, referenceIndex, withMask] of [
    ["Catalog area and uploaded reference sites", 0, 1, false],
    ["uploaded area and Catalog reference sites", 1, 0, false],
    ["raster reference sites and an assessment mask", 0, null, true],
]) test(`Habitat submits ${label} through the ordinary Models workflow`, async () => {
    const h = await fixture(); chooseStack(h);
    await chooseVector(h, "area", h.context.vectors[areaIndex], "North");
    const references = h.view.setup.inputs.references;
    if (referenceIndex === null) {
        edit(references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
        assert.match(references.maskHint.textContent, /equal to 1/);
        assert.doesNotMatch(references.maskHint.textContent, /greater than zero/);
    } else {
        await chooseVector(h, "references", h.context.vectors[referenceIndex], "South");
        assert.equal(h.view.setup.inputs.area.selectedCount.textContent, "3 of 8 features selected");
        assert.equal(references.selectedCount.textContent, "1 of 8 features selected");
    }
    assert.equal(references.source.required, true);
    assert.equal(references.maskGroup.hidden, referenceIndex !== null);
    assert.equal(references.resampling.disabled, referenceIndex !== null);
    assert.equal(h.view.setup.inputs.habitat_mask.source.required, false);
    if (withMask) edit(h.view.setup.inputs.habitat_mask.source, modelSourceKey(h.context.rasters[4]));
    assert.equal(h.requests.length, 0); assert.equal(h.view.setup.run.disabled, false);
    assert.deepEqual(h.view.setup.parameters, {});
    await h.controller.submit();
    assert.equal(h.requests.length, 1); assert.equal(h.controller.state.error, "");
    const request = h.requests[0], sources = h.context.rasters.map(({collectionId, itemId}) => ({collectionId, itemId}));
    assert.deepEqual(request.inputs.stack, {predictors: [{name: "environment", source: sources[0]}, {name: "habitat_type", source: sources[1]}],
        responses: [{name: "productivity", source: sources[2]}], categoricalPredictor: "habitat_type"});
    assert.equal(request.inputs.area.selection.filter.rules[0].value, "North");
    assert.equal(request.inputs.area.selection.uploadId, h.context.vectors[areaIndex].uploadId);
    if (referenceIndex === null) assert.deepEqual(request.inputs.references, {kind: "raster", source: sources[3]});
    else {
        assert.equal(request.inputs.references.kind, "vector");
        assert.equal(request.inputs.references.selection.filter.rules[0].value, "South");
        assert.equal(request.inputs.references.selection.uploadId, h.context.vectors[referenceIndex].uploadId);
    }
    assert.deepEqual(request.inputs.habitat_mask, withMask ? sources[4] : null);
    assert.deepEqual(request.parameters, {});
    h.controller.destroy();
});

test("Habitat stack edits preserve other rows and require unambiguous roles before Run", async () => {
    const h = await fixture(), controls = h.view.setup.inputs.stack;
    assert.equal(h.view.setup.run.disabled, true);
    chooseStack(h);
    edit(h.view.setup.inputs.references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
    await settle();
    assert.equal(h.view.setup.run.disabled, false);
    const category = controls.predictors[1].name;
    category.focus(); edit(category, "", "input");
    assert.equal(h.view.setup.run.disabled, true);
    edit(category, "land_class", "input");
    assert.equal(h.doc.activeElement, category); assert.equal(controls.categorical.value, "land_class");
    edit(controls.responses[0].name, "environment", "input");
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "duplicate-name"), /unique|different|duplicate/i);
    edit(controls.responses[0].name, "response", "input");
    edit(controls.responses[0].source, modelSourceKey(h.context.rasters[4]));
    controls.addResponse.dispatchEvent(new Event("click"));
    assert.equal(h.view.setup.run.disabled, true);
    edit(controls.responses[1].name, "productivity", "input");
    edit(controls.responses[1].source, modelSourceKey(h.context.rasters[2]));
    edit(controls.responses[1].resampling, "cubic");
    const remaining = controls.responses[1].name;
    controls.responses[0].remove.dispatchEvent(new Event("click"));
    assert.equal(controls.responses[0].name, remaining);
    assert.equal(controls.responses[0].resampling.value, "cubic");
    const stack = captureModelSubmission(h.controller.state.draft, "edited-stack").inputs.stack;
    assert.deepEqual(stack.responses, [{name: "productivity", source: {collectionId: h.context.rasters[2].collectionId, itemId: h.context.rasters[2].itemId}}]);
    assert.equal(stack.predictors[0].name, "environment"); assert.equal(stack.categoricalPredictor, "land_class");
    controls.predictors[1].remove.dispatchEvent(new Event("click"));
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "removed-category"), /categorical/i);
    h.controller.destroy();
});

test("Habitat duplicates a large mixed stack and preserves unavailable private selections", async () => {
    const h = await fixture(), artifacts = fileManifest(), parentId = "2".repeat(32);
    artifacts.jobId = parentId;
    for (const file of artifacts.files) file.url = `/api/processing/jobs/${parentId}/artifacts/${file.artifactId}`;
    const parent = job({jobId: parentId, status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    h.controller.rememberRun(parent);
    h.context.rasters.push(...Array.from({length: 17}, (_, index) => ({collectionId: "eolab-mounted-geotiffs",
        itemId: `geotiff-${(index + 10).toString(16).padStart(24, "0")}`, label: `Response ${index + 1}`})));
    h.controller.refreshMapLayers(); chooseStack(h);
    const source = h.controller.state.draft.sources.find(value => value.kind === "runArtifact");
    const controls = h.view.setup.inputs.stack;
    edit(controls.responses[0].source, modelSourceKey(source));
    for (let index = 0; index < 17; index += 1) {
        controls.addResponse.dispatchEvent(new Event("click"));
        edit(controls.responses[index + 1].name, `response_${index + 1}`, "input");
        edit(controls.responses[index + 1].source, modelSourceKey(h.context.rasters[index + 5]));
    }
    await chooseVector(h, "area", h.context.vectors[0], "North");
    await chooseVector(h, "references", h.context.vectors[1], "South");
    edit(h.view.setup.inputs.habitat_mask.source, modelSourceKey(source));
    await h.controller.submit();
    assert.equal(h.requests.length, 1);
    const expected = structuredClone(h.requests[0].inputs);
    assert.equal(expected.stack.responses.length, 18);
    assert.deepEqual(expected.stack.responses[0].source, {kind: "runArtifact", jobId: parentId, artifactId: source.artifactId});
    assert.equal(new Set(expected.stack.responses.map(value => modelSourceKey(value.source))).size, 18);
    await h.controller.duplicateRun();
    assert.equal(h.controller.state.draft.inputs.stack.kind, "manual");
    const references = h.view.setup.inputs.references;
    assert.equal(references.source.value, "captured");
    assert.equal(references.source.children.find(option => option.value === "captured").textContent, "Area from original run");
    assert.match(references.areaDescription.textContent, /BASIN equals "South"/);
    assert.equal(references.vectorGroup.hidden, true);
    h.context.vectors.forEach(value => { value.filter = {enabled: false, match: "all", rules: []}; });
    h.context.area.selectedBounds.west = -5; h.controller.refreshMapLayers(); h.controller.refreshMapArea();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "copied-stack").inputs, expected);
    assert.equal(h.requests.length, 1);
    h.controller.rememberRun({...parent, status: "expired", updatedAt: "2026-10-09T00:00:00Z",
        artifacts: {...artifacts, availability: "unavailable", files: []}});
    h.controller.refreshMapLayers();
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "expired-parent"), /available|expired/i);
    const draft = h.controller.state.draft;
    assert.equal(draft.inputs.stack.responses[0].raster.artifactId, source.artifactId);
    assert.equal(draft.inputs.habitat_mask.raster.artifactId, source.artifactId);
    edit(h.view.setup.inputs.stack.responses[0].source, modelSourceKey(h.context.rasters[2]));
    assert.equal(h.view.setup.run.disabled, true, "The unavailable optional mask must not become an omitted mask");
    edit(h.view.setup.inputs.habitat_mask.source, "");
    assert.equal(h.view.setup.run.disabled, false);
    assert.equal(captureModelSubmission(draft, "mask-omitted").inputs.habitat_mask, null);
    h.controller.destroy();
});

test("Habitat keeps raster reference and assessment choices separate through duplication and removal", async () => {
    const h = await fixture(); chooseStack(h);
    edit(h.view.setup.inputs.references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
    edit(h.view.setup.inputs.habitat_mask.source, modelSourceKey(h.context.rasters[4]));
    await settle();
    await h.controller.submit(); await h.controller.duplicateRun();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "copied-masks").inputs, h.requests[0].inputs);
    h.context.rasters.pop(); h.controller.refreshMapLayers();
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "missing-mask"), /available|Map layers|mask/i);
    edit(h.view.setup.inputs.habitat_mask.source, "");
    assert.equal(h.view.setup.run.disabled, false);
    const inputs = captureModelSubmission(h.controller.state.draft, "without-mask").inputs;
    assert.deepEqual(inputs.references, h.requests[0].inputs.references); assert.equal(inputs.habitat_mask, null);
    const parentId = "2".repeat(32), artifacts = fileManifest();
    artifacts.jobId = parentId;
    for (const file of artifacts.files) file.url = `/api/processing/jobs/${parentId}/artifacts/${file.artifactId}`;
    const parent = job({jobId: parentId, status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    h.controller.rememberRun(parent); h.controller.refreshMapLayers();
    const privateReference = h.controller.state.draft.sources.find(source => source.kind === "runArtifact");
    const referenceControls = h.view.setup.inputs.references;
    edit(referenceControls.source, `raster:${modelSourceKey(privateReference)}`);
    assert.equal(h.jobs.tracked.has(parentId), true);
    edit(referenceControls.source, "");
    assert.equal(h.jobs.tracked.has(parentId), false);
    edit(referenceControls.source, `raster:${modelSourceKey(privateReference)}`);
    assert.equal(h.jobs.tracked.has(parentId), true); assert.equal(h.view.setup.run.disabled, false);
    edit(referenceControls.source, "");
    h.controller.rememberRun({...parent, status: "expired", updatedAt: "2026-10-09T00:00:00Z",
        artifacts: {...artifacts, availability: "unavailable", files: []}});
    h.controller.refreshMapLayers();
    const unavailable = referenceControls.source.querySelectorAll("option").find(option => option.value === `raster:${modelSourceKey(privateReference)}`);
    assert.equal(unavailable.disabled, true);
    assert.match(unavailable.textContent, /unavailable/);
    h.controller.chooseArea("references", "raster");
    assert.equal(h.controller.state.draft.inputs.references.maskRaster.artifactId, privateReference.artifactId);
    assert.equal(h.controller.state.draft.inputs.references.maskRaster.available, false);
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "expired-reference"), /available|expired/i);
    h.controller.destroy();
});

test("Habitat shows Reference similarity first and diagnostics under Details with an omitted mask", async () => {
    const h = await fixture(); chooseStack(h);
    edit(h.view.setup.inputs.references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
    const artifacts = fileManifest(), [primary, diagnostics, provenance] = artifacts.files;
    Object.assign(primary, {name: "reference_similarity", label: "Reference similarity", displayName: "Reference similarity · Habitat condition"});
    Object.assign(diagnostics, {name: "diagnostics", label: "Response diagnostics", displayName: "Response diagnostics · Habitat condition",
        filename: "diagnostics.zip", mediaType: "application/zip"});
    artifacts.files = [diagnostics, provenance, primary];
    h.api.getJob = async () => job({model: habitat, status: "ready", expiresAt: artifacts.expiresAt, artifacts,
        result: {...clipResult, name: primary.name, label: primary.label}});
    h.controller.outputState = (_jobId, _artifactId, file) => ({canShow: file.mediaType === "image/tiff"});
    await settle();
    await h.controller.submit();
    assert.equal(h.controller.state.error, "");
    const [result, details] = h.view.run.result.children;
    assert.equal(result.children[0].textContent, "Reference similarity");
    assert.equal(details.className, "models-details"); assert.equal(Boolean(details.open), false);
    assert.equal(result.children.at(-2).children[0].hidden, false);
    assert.equal(details.children[1].children[0].textContent, diagnostics.displayName);
    assert.equal(details.children[1].children.at(-2).children[0].hidden, true);
    assert.equal(details.children[1].children.at(-2).children[1].href, diagnostics.url);
    const savedInputs = h.view.run.inputsBody.children[0].children.map(node => node.textContent);
    assert.ok(savedInputs.includes("Predictor: environment")); assert.ok(savedInputs.includes("Observed response: productivity"));
    assert.ok(savedInputs.includes("Predictor: habitat_type (categorical)"));
    assert.equal(savedInputs[savedInputs.indexOf("Habitat assessment mask") + 1], "None");
    h.controller.destroy();
});

test("Habitat captures independent resampling and duplicates the exact chosen grid", async () => {
    const h = await fixture(), lookups = [];
    h.controller.describeSource = async (source, _signal, targetCrs) => {
        lookups.push({source, targetCrs});
        const native = source.itemId === h.context.rasters[1].itemId;
        return {crs: native ? "EPSG:6933" : "EPSG:4326", projectedGrid: {crs: targetCrs, unit: "metre",
            pixelSize: native ? [60, 30] : [25000, 50000], origin: native ? [17, 29] : [0, 0], approximate: !native}};
    };
    chooseStack(h);
    const stack = h.view.setup.inputs.stack, grid = h.view.setup.inputs.preparation;
    const references = h.view.setup.inputs.references, mask = h.view.setup.inputs.habitat_mask;
    edit(references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
    edit(mask.source, modelSourceKey(h.context.rasters[4]));
    edit(stack.responses[0].source, modelSourceKey(h.context.rasters[0]));
    await settle();
    assert.equal(grid.projection.value, "EPSG:6933"); assert.equal(grid.projection.disabled, true);
    assert.match(grid.requirement.textContent, /requires EPSG:6933/);
    assert.equal(Number(grid.pixelX.value), 25000); assert.equal(Number(grid.pixelY.value), 50000);
    assert.match(grid.unit.textContent, /metre/); assert.match(grid.description.textContent, /approximation/);
    const count = lookups.length;
    edit(stack.predictors[0].resampling, "bilinear"); edit(stack.predictors[1].resampling, "mode");
    edit(stack.responses[0].resampling, "average"); edit(references.resampling, "nearest"); edit(mask.resampling, "cubic");
    edit(stack.predictors[1].name, "renamed_class", "input");
    await settle();
    assert.equal(lookups.length, count, "Methods and variable names do not reload immutable grid metadata");
    edit(grid.resolution, modelSourceKey(h.context.rasters[1]));
    assert.equal(Number(grid.pixelX.value), 60); assert.equal(Number(grid.pixelY.value), 30);
    assert.deepEqual(h.controller.state.draft.inputs.preparation.origin, [17, 29]);
    edit(stack.predictors[1].source, modelSourceKey(h.context.rasters[4])); await settle();
    assert.equal(Number(grid.pixelX.value), 60); assert.deepEqual(h.controller.state.draft.inputs.preparation.origin, [17, 29]);
    assert.equal(stack.predictors[1].resampling.value, "mode");
    edit(grid.resolution, "custom"); edit(grid.pixelX, "12.5", "input"); edit(grid.pixelY, "25.25", "input");
    assert.equal(h.view.setup.run.disabled, false);
    await h.controller.submit();
    const expected = {crs: "EPSG:6933", pixelSize: [12.5, 25.25], origin: [0, 0],
        resampling: {predictor_0: "bilinear", predictor_1: "mode", response_0: "average", reference_mask: "nearest", habitat_mask: "cubic"}};
    assert.deepEqual(h.requests[0].inputs.preparation, expected);
    await h.controller.duplicateRun(); await settle();
    h.context.rasters.reverse(); h.controller.refreshMapLayers();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "copied-grid").inputs.preparation, expected);
    assert.equal(h.view.setup.inputs.stack.responses[0].resampling.value, "average");
    assert.equal(h.view.setup.inputs.habitat_mask.resampling.value, "cubic");
    edit(h.view.setup.inputs.references.source, "");
    await chooseVector(h, "references", h.context.vectors[1], "South");
    edit(h.view.setup.inputs.habitat_mask.source, "");
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "active-methods").inputs.preparation.resampling,
        {predictor_0: "bilinear", predictor_1: "mode", response_0: "average"});
    h.controller.destroy();
});

test("Habitat preserves custom grid choices through late and failed metadata lookups", async () => {
    const h = await fixture();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    h.controller.describeSource = async (_source, _signal, targetCrs) => {
        await pending;
        return {crs: "EPSG:4326", projectedGrid: {crs: targetCrs, unit: "metre", pixelSize: [5000, 9000], origin: [0, 0], approximate: true}};
    };
    chooseStack(h);
    edit(h.view.setup.inputs.references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
    const grid = h.view.setup.inputs.preparation;
    edit(grid.resolution, "custom"); edit(grid.pixelX, "100", "input"); edit(grid.pixelY, "200", "input");
    assert.equal(h.controller.state.draft.inputs.preparation.loading, true);
    assert.equal(h.view.setup.run.disabled, false, "Grid suggestions do not gate explicit grid choices");
    release(); await settle();
    assert.deepEqual(h.controller.state.draft.inputs.preparation.pixelSize, [100, 200]);
    h.controller.describeSource = async () => { throw new Error("Metadata temporarily unavailable"); };
    grid.retry.dispatchEvent(new Event("click")); await settle();
    assert.match(grid.status.textContent, /enter a custom size/);
    assert.equal(h.view.setup.run.disabled, false);
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "custom-after-error").inputs.preparation.pixelSize, [100, 200]);
    h.controller.destroy();
});

test("Earth Engine runs need no map rasters and duplicate the year, explicit area and reference filter", async () => {
    const h = await fixture();
    h.context.rasters = []; h.controller.refreshMapLayers();
    h.context.viewportBounds = {west: -109, south: 46, east: -107, north: 48};
    const stack = h.view.setup.inputs.stack;
    edit(stack.source, "manual");
    edit(h.view.setup.inputs.area.source, "whole");
    edit(stack.source, "earthEngine");
    assert.equal(stack.manual.hidden, true); assert.equal(stack.manual.disabled, true);
    assert.equal(stack.automatic.disabled, false); assert.equal(stack.year.value, "2018");
    assert.equal(h.view.setup.inputs.area.source.value, "viewport");
    assert.equal(h.view.setup.inputs.area.source.children.some(option => option.value === "whole"), false);
    await chooseVector(h, "references", h.context.vectors[1], "South");
    edit(stack.year, "2017");
    assert.equal(h.view.setup.run.disabled, false);
    await h.controller.submit();
    const expected = h.requests[0].inputs;
    assert.deepEqual(expected.stack, {kind: "earthEngine", year: 2017});
    assert.deepEqual(expected.area, {kind: "selectedArea", selectedBounds: h.context.viewportBounds});
    assert.deepEqual(expected.preparation, {crs: "EPSG:6933", pixelSize: [500, 500], origin: [0, 0], resampling: {}});
    const summary = h.view.run.inputsBody.children[0].children.map(child => child.textContent);
    assert.ok(summary.includes("Original model inputs from Earth Engine · Assessment year 2017"));
    await h.controller.duplicateRun();
    h.context.viewportBounds.west = -110; h.controller.refreshMapArea();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "duplicate-auto").inputs, expected);
    assert.equal(h.view.setup.inputs.stack.source.value, "earthEngine");
    assert.equal(h.view.setup.inputs.stack.year.value, "2017");
    h.controller.state.draft.inputs.area.area = {kind: "wholeRaster"};
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "missing-area"), /Choose an analysis area/);
    h.controller.destroy();
});

test("Earth Engine grid stays first with raster masks and preserves custom choices through duplication", async () => {
    const h = await fixture(), inputs = h.view.setup.inputs;
    edit(inputs.references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
    edit(inputs.habitat_mask.source, modelSourceKey(h.context.rasters[4]));
    await settle();
    assert.deepEqual(h.controller.state.draft.inputs.preparation.pixelSize, [500, 500]);
    assert.equal(inputs.preparation.resolution.value, "earthEngine");
    assert.equal(h.controller.state.draft.inputs.preparation.choices.length, 3);
    edit(inputs.habitat_mask.resampling, "mode");
    edit(inputs.preparation.resolution, "custom");
    edit(inputs.preparation.pixelX, "750", "input"); edit(inputs.preparation.pixelY, "750", "input");
    await h.controller.submit();
    assert.deepEqual(h.requests[0].inputs.preparation, {crs: "EPSG:6933", pixelSize: [750, 750], origin: [0, 0],
        resampling: {reference_mask: "nearest", habitat_mask: "mode"}});
    const saved = h.view.run.inputsBody.children[0].children.map(child => child.textContent);
    assert.ok(saved.includes("Reference raster resampling")); assert.ok(saved.includes("Most common value (mode)"));
    await h.controller.duplicateRun(); await settle();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "auto-masks").inputs, h.requests[0].inputs);
    h.controller.destroy();
});

test("Switching input sources preserves manual rows and ignores their late grid metadata", async () => {
    const h = await fixture();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    h.controller.describeSource = async () => {
        await pending;
        return {crs: "EPSG:6933", projectedGrid: {...earthEngineOptions.grid, pixelSize: [900, 900]}};
    };
    chooseStack(h);
    edit(h.view.setup.inputs.stack.predictors[0].resampling, "bilinear");
    const rows = structuredClone(h.controller.state.draft.inputs.stack.predictors);
    edit(h.view.setup.inputs.stack.source, "earthEngine");
    release(); await settle();
    assert.deepEqual(h.controller.state.draft.inputs.preparation.pixelSize, [500, 500]);
    assert.deepEqual(h.controller.state.draft.inputs.stack.predictors, rows);
    edit(h.view.setup.inputs.stack.source, "manual"); await settle();
    assert.equal(h.view.setup.inputs.stack.manual.disabled, false);
    assert.equal(h.view.setup.inputs.stack.automatic.disabled, true);
    assert.deepEqual(h.controller.state.draft.inputs.stack.predictors, rows);
    assert.equal(h.view.setup.inputs.stack.categorical.value, "habitat_type");
    assert.deepEqual(h.controller.state.draft.inputs.preparation.pixelSize, [900, 900]);
    h.controller.destroy();
});

test("Earth Engine configuration errors can be retried without blocking manual setup", async () => {
    const h = await fixture();
    h.api.getHabitatEarthEngineOptions = async () => { throw new Error("Service unavailable"); };
    h.controller.chooseModel(habitat); await settle(); chooseStack(h);
    await chooseVector(h, "references", h.context.vectors[0], "North");
    assert.equal(h.view.setup.run.disabled, false);
    const stack = h.view.setup.inputs.stack;
    edit(stack.source, "earthEngine");
    assert.equal(h.view.setup.run.disabled, true);
    assert.match(stack.acquisitionStatus.textContent, /Service unavailable/);
    assert.equal(stack.retry.hidden, false);
    h.api.getHabitatEarthEngineOptions = async () => structuredClone(earthEngineOptions);
    stack.retry.dispatchEvent(new Event("click")); await settle();
    assert.equal(stack.year.value, "2018"); assert.equal(h.view.setup.run.disabled, false);
    h.controller.destroy();
});

test("Late Habitat options preserve a chosen custom stack and cannot replace another model draft", async () => {
    const h = await fixture();
    let complete;
    h.api.getHabitatEarthEngineOptions = () => new Promise(resolve => { complete = resolve; });
    h.controller.chooseModel(habitat);
    chooseStack(h);
    const predictors = structuredClone(h.controller.state.draft.inputs.stack.predictors);
    complete(structuredClone(earthEngineOptions)); await settle();
    assert.equal(h.controller.state.draft.inputs.stack.kind, "manual");
    assert.deepEqual(h.controller.state.draft.inputs.stack.predictors, predictors);
    assert.equal(h.view.setup.inputs.stack.manual.hidden, false);
    h.controller.chooseModel(habitat);
    const abandoned = h.controller.state.draft;
    h.controller.chooseModel(model);
    const current = h.controller.state.draft;
    complete(structuredClone(earthEngineOptions)); await settle();
    assert.equal(h.controller.state.draft, current);
    assert.equal(abandoned.inputs.stack.configuration, null);
    assert.equal(h.requests.length, 0);
    h.controller.destroy();
});


test("direct spatial choices retain opaque view identity, independent filters and captured areas", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy()); chooseStack(h);
    const first = h.context.vectors[0], second = {...structuredClone(first),
        key: 'retained:view:raster:["basins"]:2', label: "Catalog basins · second view"};
    second.filter.rules[0].value = "South";
    h.context.vectors.push(second); h.controller.refreshMapLayers();
    const controls = h.view.setup.inputs, areaSource = controls.area.source, referenceSource = controls.references.source;
    assert.equal(controls.references.group.contains(referenceSource), true);
    assert.equal(controls.references.group.contains(controls.references.filterHost), true);
    assert.equal(controls.references.group.querySelectorAll("label").filter(label => label.textContent === "Reference sites").length, 1);
    assert.equal(controls.area.source.querySelectorAll("option").some(option => option.value.startsWith("raster:")), false);
    referenceSource.focus();
    edit(areaSource, `vector:${first.key}`); edit(referenceSource, `vector:${second.key}`); await settle();
    assert.equal(h.controller.state.draft.inputs.area.vectorKey, first.key);
    assert.equal(h.controller.state.draft.inputs.references.vectorKey, second.key);
    assert.equal(h.doc.activeElement, referenceSource);
    assert.match(controls.area.filterDescription.textContent, /North/);
    assert.match(controls.references.filterDescription.textContent, /South/);
    assert.equal(controls.references.resampling.disabled, true);
    await h.controller.openVectorFilter("references");
    const filter = structuredClone(second.filter); filter.rules[0].value = "West";
    await h.filters.at(-1).apply(filter); h.filters.at(-1).complete(); await settle();
    assert.equal(h.context.vectors[0].filter.rules[0].value, "North");
    assert.equal(h.context.vectors[2].filter.rules[0].value, "West");
    assert.equal(h.controller.state.draft.inputs.area.area.selection.filter.rules[0].value, "North");
    assert.equal(h.controller.state.draft.inputs.references.area.selection.filter.rules[0].value, "West");
    assert.equal(h.requests.length, 0);
    await h.controller.submit(); await h.controller.duplicateRun();
    const captured = structuredClone(h.requests[0].inputs);
    assert.equal(h.view.setup.inputs.references.source.value, "captured");
    h.context.vectors[2].filter.rules[0].value = "East"; h.controller.refreshMapLayers(); await settle();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "fixed-areas").inputs, captured);
    edit(h.view.setup.inputs.references.source, `vector:${second.key}`); await settle();
    assert.equal(h.controller.state.draft.inputs.references.area.selection.filter.rules[0].value, "East");
    assert.deepEqual(h.controller.state.draft.inputs.area.area, captured.area);
    edit(h.view.setup.inputs.references.source, "");
    assert.equal(h.controller.state.draft.inputs.references.area, null);
    assert.equal(h.view.setup.inputs.references.source.value, "");
    assert.equal(h.view.setup.inputs.references.selectionCard.hidden, true);
    assert.equal(h.view.setup.inputs.references.resampling.disabled, true);
    assert.equal(h.view.setup.run.disabled, true);
    assert.deepEqual(h.requests[0].inputs, captured);
});

test("an expired selected reference output stays identified and explained by the direct chooser", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy()); chooseStack(h);
    const parentId = "2".repeat(32), artifacts = fileManifest(); artifacts.jobId = parentId;
    const parent = job({jobId: parentId, status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    h.controller.rememberRun(parent); h.controller.refreshMapLayers();
    const source = h.controller.state.draft.sources.find(value => value.kind === "runArtifact");
    const references = h.view.setup.inputs.references;
    edit(references.source, `raster:${modelSourceKey(source)}`); await settle();
    assert.equal(h.view.setup.run.disabled, false);
    h.controller.rememberRun({...parent, status: "expired", updatedAt: "2026-10-09T00:00:00Z",
        artifacts: {...artifacts, availability: "unavailable", files: []}});
    h.controller.refreshMapLayers();
    assert.equal(references.source.value, `raster:${modelSourceKey(source)}`);
    const option = references.source.querySelectorAll("option").find(value => value.value === references.source.value);
    assert.equal(option.disabled, true); assert.match(option.textContent, /unavailable/);
    assert.equal(references.maskGroup.hidden, false); assert.match(references.rasterReason.textContent, /no longer available/);
    assert.ok(references.source.getAttribute("aria-describedby").split(" ").includes(references.rasterReason.id));
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "expired-source"), /available|expired/i);
    assert.equal(h.requests.length, 0);
});
