import test from "node:test";
import assert from "node:assert/strict";
import { ModelsView } from "../../src/models/view.js";
import { describeModelProgress } from "../../src/processing/presentation.js";
import { createModelDraft, modelSourceKey } from "../../src/models/inputs.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { model, raster, area, invocation, job, clipModel, clipResult, statisticsResult, seriesModel, timeSeriesResult, fileManifest } from "../../test-support/models/fixtures.js";

/** Render the actual Models view over current application markup.
 * @return {Object} View, document, mutable state and action log.
 */
function fixture() {
    const doc = new SummaryControlDocument(); const actions = [];
    const view = new ModelsView(doc);
    const callbacks = Object.fromEntries(["Open", "Close", "Page", "Query", "Choose", "Edit", "Input", "Area", "Vector", "EditFilter", "Submit", "Retry", "Refresh", "RefreshRuns", "More", "Run", "Cancel", "Duplicate", "Yaml", "ShowOutput", "Renew", "Rename", "Delete", "ConfirmDelete", "KeepRun", "UndoDelete", "DismissDelete", "TemporalDataset", "TemporalVariable", "TemporalMonth", "UseTemporalMonth", "RefreshTemporal", "TemporalEdit"]
        .map(name => [`on${name}`, (...values) => actions.push([name, ...values])]));
    view.bind(callbacks);
    const state = {page: "setup", library: [model], query: "", draft: createModelDraft(model, {rasters: [raster], area}, "draft-1"),
        runs: [], selectedRun: null, pending: null, error: "", yaml: null};
    view.render(state); return {doc, view, state, actions};
}

test("separate Undo offers retain full names, action identity and the other notice's focus", () => {
    const h = fixture(), first = {jobId: "1".repeat(32), deletionId: "d".repeat(32),
        label: "Downstream beneficiaries for the full watershed and coastal communities · 2026_10_08_00_00_00"};
    const second = {jobId: "2".repeat(32), deletionId: "e".repeat(32), label: "Cuba population · 2026_10_08_00_00_01"};
    h.state.deletions = [first, second]; h.view.render(h.state);
    const firstNotice = h.view.deletionNotices.get(first.deletionId), secondNotice = h.view.deletionNotices.get(second.deletionId);
    assert.equal(h.view.elements.deletions.children.length, 2);
    for (const [deletion, notice] of [[first, firstNotice], [second, secondNotice]]) {
        assert.ok(notice.root.children[0].textContent.includes(deletion.label));
        assert.equal(notice.root.children[0].getAttribute("role"), "status");
        assert.equal(notice.undo.getAttribute("aria-label"), `Undo deletion of ${deletion.label}`);
        assert.equal(notice.dismiss.getAttribute("aria-label"), `Dismiss Undo for ${deletion.label}`);
    }
    secondNotice.undo.focus(); h.view.render(h.state);
    assert.equal(h.view.deletionNotices.get(second.deletionId).undo, secondNotice.undo);
    assert.equal(h.doc.activeElement, secondNotice.undo);
    firstNotice.dismiss.dispatchEvent(new Event("click")); secondNotice.undo.dispatchEvent(new Event("click"));
    assert.deepEqual(h.actions.slice(-2), [["DismissDelete", first.jobId], ["UndoDelete", second.jobId]]);
    h.state.deletions = [second]; h.view.render(h.state);
    assert.equal(h.view.deletionNotices.has(first.deletionId), false);
    assert.equal(h.doc.activeElement, secondNotice.undo);
    h.state.deletions = []; h.view.render(h.state);
    assert.equal(h.view.elements.deletions.children.length, 0); assert.equal(h.doc.activeElement, h.view.elements.heading);
});

test("Undo busy and failed-retry states preserve the named notice and its controls", () => {
    const h = fixture(), deletion = {jobId: "1".repeat(32), deletionId: "d".repeat(32), label: "Cuba population"};
    h.state.deletions = [deletion]; h.view.render(h.state);
    const notice = h.view.deletionNotices.get(deletion.deletionId);
    notice.undo.focus(); deletion.busy = true; h.view.render(h.state);
    assert.equal(notice.undo.disabled, true); assert.equal(notice.dismiss.disabled, true);
    assert.equal(notice.root.getAttribute("aria-busy"), "true");
    assert.ok(notice.root.children[0].textContent.includes(deletion.label));
    assert.match(notice.root.children[0].textContent, /Updating…/);
    deletion.busy = false; h.state.error = "Could not undo deletion: Offline"; h.view.render(h.state);
    assert.equal(h.view.deletionNotices.get(deletion.deletionId), notice);
    assert.equal(notice.undo.disabled, false); assert.equal(notice.dismiss.disabled, false);
    assert.notEqual(notice.root.getAttribute("aria-busy"), "true");
    assert.equal(h.doc.activeElement, notice.undo);
    assert.equal(h.view.elements.error.hidden, false);
    assert.equal(h.view.elements.error.textContent, h.state.error);
    notice.undo.dispatchEvent(new Event("click"));
    assert.deepEqual(h.actions.at(-1), ["UndoDelete", deletion.jobId]);
});

test("raster choices separate map layers from completed runs and explain unavailable results", () => {
    const h = fixture(), recipe = {...model, inputs: {...model.inputs, raster: {type: "raster", label: "Raster"}}};
    const result = {kind: "runArtifact", jobId: "1".repeat(32), artifactId: "a".repeat(32), label: "Cuba clip · Clipped raster", expiresAt: "2099-01-01T00:00:00Z"};
    h.state.draft = createModelDraft(recipe, {rasters: [raster, result], area}, "private-draft");
    h.state.draft.inputs.raster.raster = result; h.state.nextCursor = "older";
    h.view.render(h.state);
    assert.deepEqual(h.view.setup.inputs.raster.source.children.slice(1).map(group => group.label), ["Map layers", "Completed runs"]);
    assert.equal(h.view.setup.run.disabled, false);
    assert.equal(h.view.setup.form.querySelectorAll("button").some(button =>
        ["Refresh results", "Load older results"].includes(button.textContent)), false);
    h.state.draft.inputs.raster.raster.available = false; h.state.draft.sources[1].available = false; h.view.render(h.state);
    assert.equal(h.view.setup.run.disabled, true);
    assert.match(h.view.setup.inputs.raster.source.children[2].children[0].textContent, /unavailable/);
    assert.equal(h.view.setup.inputs.raster.source.children[2].children[0].disabled, true);
});

test("removed history entries leave the DOM while unrelated run cards retain their controls", () => {
    const h = fixture(), first = job(), second = job({jobId: "2".repeat(32), label: "Another run"});
    Object.assign(h.state, {page: "runs", runs: [first, second]}); h.view.render(h.state);
    const retained = h.view.runCards.get(second.jobId).button;
    h.state.runs = [second]; h.view.render(h.state);
    assert.equal(h.view.runCards.has(first.jobId), false);
    assert.equal(h.view.elements["runs-list"].children.length, 1);
    assert.equal(h.view.runCards.get(second.jobId).button, retained);
    h.state.runs = []; h.view.render(h.state);
    assert.equal(h.view.elements["runs-list"].children.length, 0);
    assert.match(h.view.elements["runs-status"].textContent, /No model runs/);
});

test("library and run cards use the same presentation and invoke their existing navigation", () => {
    const h = fixture(), run = job();
    Object.assign(h.state, {page: "library", runs: [run]}); h.view.render(h.state);
    const libraryCard = h.view.elements["library-items"].children[0];
    const libraryButton = libraryCard.children[0].children[0];
    const runCard = h.view.runCards.get(run.jobId);
    assert.equal(libraryCard.className, runCard.root.className);
    assert.equal(libraryButton.className, runCard.button.className);
    assert.equal(libraryButton.type, "button"); assert.equal(runCard.button.type, "button");
    assert.equal(libraryButton.getAttribute("aria-label"), `Set up ${model.title}`);
    libraryButton.dispatchEvent(new Event("click")); runCard.button.dispatchEvent(new Event("click"));
    assert.deepEqual(h.actions.slice(-2), [["Choose", model], ["Run", run.jobId]]);
    libraryButton.focus(); h.view.render(h.state);
    assert.equal(h.view.elements["library-items"].children[0], libraryCard);
    assert.equal(libraryCard.contains(h.doc.activeElement), true);
});

test("run renewal and deletion have explicit scope, confirmation and busy feedback", () => {
    const h = fixture(), artifacts = fileManifest();
    const ready = job({name: "Downstream beneficiaries for the full watershed and coastal communities",
        status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    Object.assign(h.state, {page: "run", runs: [ready], selectedRun: ready.jobId});
    h.view.render(h.state);
    assert.equal(h.view.run.renew.hidden, false);
    assert.equal(h.view.run.remove.hidden, false);
    assert.equal(h.view.run.confirmation.hidden, true);
    assert.equal(h.view.run.remove.parentNode, h.view.run.confirmation.parentNode);
    assert.ok(h.view.run.remove.className.split(" ").includes("models-action-danger"));
    assert.ok(h.view.run.confirm.className.split(" ").includes("models-action-danger"));
    assert.equal(h.view.run.keep.className.split(" ").includes("models-action-danger"), false);
    assert.equal(h.view.run.confirmation.getAttribute("role"), "group");
    assert.equal(h.view.run.confirmation.getAttribute("aria-describedby"), h.view.run.warning.id);
    assert.ok(h.view.run.warning.id);
    assert.equal(h.view.run.keep.textContent, "Keep run");
    assert.equal(h.view.run.confirm.textContent, "Delete run and results");
    h.view.run.remove.dispatchEvent(new Event("click")); assert.equal(h.actions.at(-1)[0], "Delete");
    h.state.deleteConfirmation = ready.jobId; h.view.render(h.state);
    assert.ok(h.view.run.warning.textContent.includes(ready.label));
    assert.match(h.view.run.warning.textContent, /all its result files/);
    assert.match(h.view.run.warning.textContent, /removed from the map/);
    assert.equal(h.view.run.remove.hidden, true); assert.equal(h.view.run.confirmation.hidden, false);
    assert.equal(h.state.runs[0], ready);
    h.view.focusDeleteConfirmation(); assert.equal(h.doc.activeElement, h.view.run.keep);
    const keep = h.view.run.keep, confirm = h.view.run.confirm;
    h.view.render(h.state); assert.equal(h.doc.activeElement, keep);
    keep.dispatchEvent(new Event("click")); assert.equal(h.actions.at(-1)[0], "KeepRun");
    confirm.focus(); confirm.dispatchEvent(new Event("click")); assert.equal(h.actions.at(-1)[0], "ConfirmDelete");
    h.state.actionBusy = true; h.view.render(h.state);
    assert.equal(h.view.run.confirm.disabled, true); assert.equal(h.view.run.renew.disabled, true);
    assert.equal(h.view.run.keep.disabled, true); assert.equal(h.view.run.confirm.textContent, "Please wait…");
    assert.equal(h.view.run.confirmation.getAttribute("aria-busy"), "true");
    assert.equal(h.view.run.confirm, confirm); assert.equal(h.view.run.keep, keep);
    Object.assign(h.state, {actionBusy: false, error: "Deletion could not be confirmed: Offline"}); h.view.render(h.state);
    assert.equal(h.view.run.confirm.disabled, false); assert.equal(h.view.run.keep.disabled, false);
    assert.equal(h.view.run.confirm.textContent, "Delete run and results");
    assert.notEqual(h.view.run.confirmation.getAttribute("aria-busy"), "true");
    assert.equal(h.view.run.confirmation.hidden, false); assert.equal(h.doc.activeElement, confirm);
    assert.equal(h.view.elements.error.textContent, h.state.error);
    Object.assign(h.state, {actionBusy: false, actionMessage: "Results kept until tomorrow."}); h.view.render(h.state);
    assert.equal(h.view.run.feedback.textContent, h.state.actionMessage);
    ready.status = "deleted"; h.view.render(h.state);
    assert.equal(h.view.run.confirmation.hidden, true); assert.equal(h.view.run.remove.hidden, true);
    assert.equal(h.view.run.renew.hidden, true); assert.equal(h.view.run.inputs.hidden, true);
});

test("all model controls exist in production markup and progress retains field focus", () => {
    const h = fixture(); const field = h.view.setup.parameters.summary;
    field.value = "mean(a)"; field.focus();
    h.state.runs = [job({status: "running", progress: {phase: "calculating", completed: 5, total: 10, unit: "blocks"}})];
    h.view.render(h.state);
    assert.equal(h.doc.activeElement, field); assert.equal(field.value, "mean(a)"); assert.equal(h.view.setup.parameters.summary, field);
    assert.match(h.view.setup.inputs.area.areaDescription.textContent, /Box/);
    assert.match(h.view.setup.inputs.area.areaDescription.textContent, /W 0\.0000°/);
});

test("ready results show exact integer values and safe CSV/provenance/YAML links", () => {
    const h = fixture(); const id = job().jobId;
    const row = {label: "Total", expression: "sum(a)", state: "ok", value: "9007199254740993", valueType: "integer", aggregates: []};
    h.state.page = "run"; h.state.selectedRun = id; h.state.invocation = invocation;
    h.state.runs = [job({status: "ready", expiresAt: "2099-01-01T00:00:00Z", result: {...statisticsResult, rows: [row], url: `/api/processing/jobs/${id}/result`, provenanceUrl: `/api/processing/jobs/${id}/provenance`}})];
    h.view.render(h.state);
    assert.equal(h.view.run.result.children[1].children[2].textContent.replaceAll(",", ""), row.value);
    assert.equal(h.view.run.cancel.hidden, true); assert.equal(h.view.run.duplicate.disabled, false);
    assert.match(h.view.run.details.run.href, /run-yaml$/);
    h.state.runs[0].status = "expired"; h.state.runs[0].result = null; h.view.render(h.state);
    assert.equal(h.view.run.result.children.length, 0); assert.match(h.view.run.status.textContent, /expired/);
});

test("primary output comes first even when the inventory lists supporting files first", () => {
    const h = fixture(), artifacts = fileManifest();
    const [primary, coverage, provenance] = artifacts.files;
    artifacts.files = [coverage, provenance, primary];
    h.state.page = "run"; h.state.selectedRun = artifacts.jobId;
    h.state.runs = [job({status: "ready", expiresAt: artifacts.expiresAt, result: clipResult, artifacts})];
    h.view.render(h.state);
    const children = h.view.run.result.children;
    assert.equal(children.length, 2);
    assert.equal(children[0].children[0].textContent, clipResult.label);
    const details = children[1];
    assert.equal(details.className, "models-details"); assert.equal(Boolean(details.open), false);
    assert.equal(details.children[0].textContent, "Details");
    assert.match(details.children[1].children[1].textContent, /Intermediate result/);
    assert.equal(details.children[2].children[0].textContent, provenance.displayName);
    const cards = [children[0], ...details.children.slice(1)];
    assert.deepEqual(cards.map(card => card.children.at(-2).children[1].href), [primary.url, coverage.url, provenance.url]);
    h.state.runs[0].expiresAt = "2000-01-01T00:00:00Z";
    h.view.render(h.state);
    assert.equal(h.view.run.result.children.length, 0);
});

test("run controls and open details remain stable through progress updates", () => {
    const h = fixture(); h.state.page = "run"; h.state.selectedRun = job().jobId; h.state.runs = [job({status: "running"})];
    h.view.render(h.state); const cancel = h.view.run.cancel; cancel.focus(); h.view.run.details.root.open = true;
    h.state.runs[0].progress = {phase: "unfamiliar_stage", description: "Measuring habitat", completed: 3, total: 8, unit: "blocks"}; h.view.render(h.state);
    assert.equal(h.view.run.cancel, cancel); assert.equal(h.doc.activeElement, cancel); assert.equal(h.view.run.details.root.open, true);
    assert.equal(h.view.run.progress.value, 3); assert.equal(h.view.run.status.textContent, "Measuring habitat · 3 of 8 blocks");
    h.state.runs[0].status = "cancelling"; h.view.render(h.state); assert.equal(cancel.disabled, true);
});

test("the inline run name survives progress updates and closes only after a successful save", async () => {
    const h = fixture(), running = job({status: "running"});
    Object.assign(h.state, {page: "run", selectedRun: running.jobId, runs: [running]}); h.view.render(h.state);
    assert.equal(h.view.run.rename.getAttribute("aria-label"), "Rename run");
    assert.equal(h.view.run.rename.children[0].getAttribute("aria-hidden"), "true");
    h.view.run.rename.dispatchEvent(new Event("click"));
    const input = h.view.run.nameInput;
    assert.equal(input.value, running.name); assert.equal(h.doc.activeElement, input);
    input.value = "Cuba biomass";
    running.progress = {phase: "calculating", completed: 3, total: 8}; h.view.render(h.state);
    assert.equal(h.view.run.nameInput, input); assert.equal(input.value, "Cuba biomass"); assert.equal(h.doc.activeElement, input);
    h.view.handlers.onRename = async label => { assert.equal(label, "Cuba biomass"); return false; };
    await h.view.saveRunName(); assert.equal(h.view.run.nameEditor.hidden, false);
    h.state.actionBusy = true; h.state.renamingRun = running.jobId; h.view.render(h.state);
    assert.equal(input.disabled, true); assert.equal(h.view.run.saveName.textContent, "Saving…");
    h.state.actionBusy = false; h.view.handlers.onRename = async () => true;
    await h.view.saveRunName(); assert.equal(h.view.run.nameEditor.hidden, true); assert.equal(h.doc.activeElement, h.view.run.rename);
});

test("run and output headings show complete names with separate download actions", () => {
    const h = fixture(), artifacts = fileManifest();
    const ready = job({status: "ready", expiresAt: artifacts.expiresAt, result: clipResult, artifacts});
    Object.assign(h.state, {page: "run", selectedRun: ready.jobId, runs: [ready]}); h.view.render(h.state);
    const card = h.view.runCards.get(ready.jobId);
    assert.equal(card.button.textContent, ready.label); assert.equal(card.button.title, ready.label);
    assert.equal(card.button.getAttribute("aria-label"), ready.label); assert.match(card.status.textContent, /2026-10-08 00:00:00/);
    assert.equal(h.view.run.title.textContent, ready.label);
    assert.equal(h.view.elements.run.querySelectorAll("summary").some(summary => summary.textContent === "Full name"), false);
    const fileCards = [h.view.run.result.children[0], ...h.view.run.result.children[1].children.slice(1)];
    for (const [index, file] of artifacts.files.entries()) {
        const fileCard = fileCards[index], label = index === 0 ? clipResult.label : file.displayName;
        assert.equal(fileCard.children[0].textContent, label);
        assert.equal(fileCard.children[index === 0 ? 1 : 2].textContent, index === 0 ? clipResult.filename : file.filename);
        const download = fileCard.children.at(-2).children[1];
        assert.equal(download.textContent, "Download");
        assert.equal(download.getAttribute("aria-label"), `Download ${label}`);
        assert.equal(download.href, file.url); assert.equal(download.download, "");
    }
    h.state.runs = [job({...ready, name: "Cuba biomass"})]; h.view.render(h.state);
    assert.equal(h.view.run.title.textContent, `Cuba biomass · ${ready.nameTimestamp}`);
});

test("run history shows distinct complete names and refreshes a renamed run without losing focus", () => {
    const h = fixture(), first = job({name: "Downstream ecosystem beneficiaries"});
    const second = job({jobId: "2".repeat(32), name: first.name, nameTimestamp: "2026_10_08_00_00_01"});
    Object.assign(h.state, {page: "runs", runs: [first, second]}); h.view.render(h.state);
    const firstButton = h.view.runCards.get(first.jobId).button;
    const secondButton = h.view.runCards.get(second.jobId).button;
    assert.equal(firstButton.textContent, first.label);
    assert.equal(secondButton.textContent, second.label);
    assert.notEqual(firstButton.textContent, secondButton.textContent);
    firstButton.focus();
    const renamed = job({...first, name: "Cuba biomass"});
    h.state.runs = [renamed, second]; h.view.render(h.state);
    assert.equal(h.view.runCards.get(first.jobId).button, firstButton);
    assert.equal(h.doc.activeElement, firstButton);
    assert.equal(firstButton.textContent, `Cuba biomass · ${first.nameTimestamp}`);
    assert.equal(firstButton.title, renamed.label);
    assert.equal(firstButton.getAttribute("aria-label"), renamed.label);
    firstButton.dispatchEvent(new Event("click"));
    assert.deepEqual(h.actions.at(-1), ["Run", first.jobId]);
});

test("file cards show independent opt-in map actions and display loading and map inclusion", () => {
    const h = fixture(), artifacts = fileManifest();
    const rasterFiles = artifacts.files.filter(file => file.mediaType === "image/tiff");
    const firstFile = rasterFiles[0];
    h.state.page = "run"; h.state.selectedRun = artifacts.jobId;
    h.state.runs = [job({status: "ready", expiresAt: artifacts.expiresAt, result: clipResult, artifacts})];
    h.state.outputPreviews = Object.fromEntries(rasterFiles.map(file => [file.artifactId, {canShow: true}]));
    h.view.render(h.state);
    const details = h.view.run.result.children[1], cards = [h.view.run.result.children[0], ...details.children.slice(1)];
    details.open = true;
    for (const [index, file] of rasterFiles.entries()) {
        const card = cards[index], button = card.children.at(-2).children[0], label = index === 0 ? clipResult.label : file.displayName;
        assert.equal(card.children[0].textContent, label);
        assert.equal(card.children.at(-2).children[1].href, file.url);
        assert.equal(button.textContent, "Show on map");
        assert.equal(button.getAttribute("aria-label"), `Show on map: ${label}`);
        button.dispatchEvent(new Event("click"));
        assert.deepEqual(h.actions.at(-1), ["ShowOutput", file.artifactId]);
    }
    const card = cards[0], button = card.children.at(-2).children[0];
    const otherButton = cards[1].children.at(-2).children[0];
    button.focus();
    const actionCount = h.actions.length;
    h.state.outputPreviews[firstFile.artifactId].busy = true; h.view.render(h.state);
    assert.equal(h.view.run.result.children[0], card);
    assert.equal(h.view.run.result.children[1], details); assert.equal(details.open, true);
    assert.equal(h.view.run.result.contains(button), true);
    assert.equal(h.doc.activeElement, button);
    assert.equal(button.textContent, "Adding to map…"); assert.equal(button.getAttribute("aria-disabled"), "true");
    button.dispatchEvent(new Event("click")); assert.equal(h.actions.length, actionCount);
    assert.equal(otherButton.textContent, "Show on map"); assert.equal(otherButton.getAttribute("aria-disabled"), "false");
    h.state.outputPreviews[firstFile.artifactId] = {canShow: true, onMap: true}; h.view.render(h.state);
    assert.equal(button.textContent, "On map"); assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.equal(h.doc.activeElement, button); assert.equal(h.view.run.result.contains(button), true);
    button.dispatchEvent(new Event("click")); assert.equal(h.actions.length, actionCount);
    assert.equal(otherButton.textContent, "Show on map"); assert.equal(otherButton.getAttribute("aria-disabled"), "false");
    const download = card.children.at(-2).children[1]; download.focus();
    h.state.outputPreviews[firstFile.artifactId] = {canShow: true, error: "Could not add this output. Try again."}; h.view.render(h.state);
    assert.equal(h.doc.activeElement, download); assert.equal(h.view.run.result.contains(download), true);
    const error = card.children.at(-1);
    assert.equal(error.hidden, false); assert.match(error.textContent, /Try again/);
    assert.equal(button.getAttribute("aria-disabled"), "false");
    button.dispatchEvent(new Event("click")); assert.equal(h.actions.length, actionCount + 1);
    h.state.outputPreviews[firstFile.artifactId] = {canShow: false}; h.view.render(h.state);
    assert.equal(button.hidden, true); assert.equal(error.hidden, true);
    button.dispatchEvent(new Event("click")); assert.equal(h.actions.length, actionCount + 1);
});

test("model progress uses the supplied description without reading operation phases", () => {
    const progress = {description: "Measuring habitat", completed: 2, total: 5, unit: "regions"};
    Object.defineProperty(progress, "phase", {get: () => assert.fail("Models must not inspect operation phases.")});
    const run = job({model: {...model, id: "unfamiliar-habitat-model"}, status: "running", progress});
    assert.equal(describeModelProgress(run), "Measuring habitat · 2 of 5 regions");
    progress.completed = null; progress.unit = null;
    assert.equal(describeModelProgress(run), "Measuring habitat · 0 of 5 units");
    progress.total = null;
    assert.equal(describeModelProgress(run), "Measuring habitat…");
});

test("model stages without a description use a running label while lifecycle states take precedence", () => {
    for (const progress of [{phase: "preparing_polygon_mask"}, {phase: "unfamiliar_stage", description: null}, {}]) {
        assert.equal(describeModelProgress(job({status: "running", progress})), "Running model…");
        assert.equal(describeModelProgress(job({status: "running", progress: {...progress, completed: 2, total: 5, unit: "blocks"}})), "Running model · 2 of 5 blocks");
    }
    for (const [status, expected] of Object.entries({queued: "Queued", cancelling: "Cancelling…", ready: "Ready", failed: "Failed",
        cancelled: "Cancelled", interrupted: "Interrupted", expired: "Results expired", deleted: "Deleted"})) {
        assert.equal(describeModelProgress(job({status, expiresAt: "2099-01-01T00:00:00Z", progress: {description: "Measuring habitat"}})), expected);
    }
    assert.equal(describeModelProgress(job({status: "ready", expiresAt: "2000-01-01T00:00:00Z", progress: {description: "Measuring habitat"}})), "Results expired");
});

test("run and history progress render descriptions as text and keep unknown totals indeterminate", () => {
    const h = fixture(), description = '<img src=x onerror="alert(1)">';
    const run = job({status: "running", progress: {phase: "unfamiliar_stage", description, completed: 1, total: 4, unit: "regions"}});
    Object.assign(h.state, {page: "run", selectedRun: run.jobId, runs: [run]});
    h.view.render(h.state);
    const status = h.view.run.status, historyStatus = h.view.runCards.get(run.jobId).status;
    assert.equal(status.textContent, `${description} · 1 of 4 regions`);
    assert.equal(historyStatus.textContent, `${description} · 1 of 4 regions · 2026-10-08 00:00:00`);
    for (const node of [status, historyStatus]) {
        assert.equal(node.children.length, 0);
        Object.defineProperty(node, "innerHTML", {set: () => assert.fail("Progress must remain literal text.")});
    }
    h.view.run.progress.setAttribute("value", "1");
    run.progress = {phase: "another_unfamiliar_stage", description: "Checking <strong>habitat</strong>"};
    h.view.render(h.state);
    assert.equal(h.view.run.status, status); assert.equal(h.view.runCards.get(run.jobId).status, historyStatus);
    assert.equal(status.textContent, "Checking <strong>habitat</strong>…");
    assert.equal(historyStatus.textContent, "Checking <strong>habitat</strong>… · 2026-10-08 00:00:00");
    assert.equal(h.view.run.progress.hidden, false); assert.equal(h.view.run.progress.getAttribute("value"), null);
});


test("area choices use histogram terminology and follow the map without Update controls", () => {
    const h = fixture();
    const labels = () => h.view.setup.inputs.area.source.children.map(option => option.textContent);
    assert.deepEqual(labels(), ["Choose an area…", "Whole raster", "Visible map area", "Sampling box"]);
    assert.equal(h.view.setup.bounds, undefined); assert.equal(h.view.setup.updateArea, undefined);
    assert.match(h.view.setup.inputs.area.mapHelp.textContent, /sampling box shown in Histograms/);
    h.state.draft.inputs.area.areaOrigin = "run"; h.state.draft.inputs.area.areaMode = "captured"; h.view.render(h.state);
    assert.equal(labels().at(-1), "Area from original run"); assert.match(h.view.setup.inputs.area.mapHelp.textContent, /exact area from the original run/);
    h.state.draft = createModelDraft(model, {rasters: [raster]}, "no-selected-area"); h.view.render(h.state);
    assert.ok(labels().includes("Sampling box"));
    h.state.draft.inputs.area.areaMode = "viewport"; h.state.draft.inputs.area.area = area; h.view.render(h.state);
    assert.equal(h.view.setup.run.disabled, false); assert.match(h.view.setup.inputs.area.mapHelp.textContent, /Pan or zoom/);
    h.state.draft.inputs.area.area = null; h.view.render(h.state); assert.equal(h.view.setup.run.disabled, true);
});


test("vector setup offers Edit filter and describes the predicate belonging to this run", () => {
    const h = fixture(); h.state.draft.inputs.area.areaMode = "vector"; h.view.render(h.state);
    assert.equal(h.view.setup.inputs.area.editFilter.disabled, true);
    const source = {key: "view:basins", collectionId: "eolab-mounted-vectors", itemId: "basins", label: "Basins", filter: {enabled: true, match: "all", rules: [{field: "BASIN", operator: "eq", value: "North"}]}};
    h.state.draft.inputs.area.vectors = [source]; h.state.draft.inputs.area.vectorKey = source.key;
    h.state.draft.inputs.area.area = null; h.view.render(h.state);
    assert.equal(h.view.setup.inputs.area.editFilter.disabled, false); assert.match(h.view.setup.inputs.area.filterDescription.textContent, /BASIN equals "North"/);
    h.view.setup.inputs.area.editFilter.dispatchEvent(new Event("click")); assert.equal(h.actions.at(-1)[0], "EditFilter");
    h.state.draft.inputs.area.filterOpening = true; h.state.draft.inputs.area.filterEditing = true; h.view.render(h.state);
    assert.equal(h.view.setup.inputs.area.editFilter.disabled, true); assert.equal(h.view.setup.inputs.area.editFilter.textContent, "Opening filter…");
});


test("setup offers only map layers and explains how to add a missing raster", () => {
    const h = fixture();
    assert.equal(h.view.setup.rasterSearch, undefined); assert.equal(h.view.setup.vectorSearch, undefined);
    h.state.draft = createModelDraft(model, {}, "empty-map"); h.view.render(h.state);
    assert.match(h.view.setup.inputs.raster.reason.textContent, /Add a raster to Map layers/);
    assert.equal(h.view.setup.run.disabled, true);
});


test("vector checks leave Edit filter available and show selection errors next to the count", () => {
    const h = fixture(); const draft = h.state.draft;
    draft.inputs.area.areaMode = "vector"; draft.inputs.area.vectorKey = "view:countries";
    draft.inputs.area.vectors = [{key: "view:countries", collectionId: "vectors", itemId: "countries", label: "Countries"}];
    draft.inputs.area.area = null; draft.inputs.area.selecting = true; h.view.render(h.state);
    assert.equal(h.view.setup.inputs.area.editFilter.textContent, "Edit filter");
    assert.equal(h.view.setup.inputs.area.editFilter.disabled, false);
    assert.match(h.view.setup.inputs.area.selectedCount.textContent, /Checking selected features/);
    assert.equal(h.view.setup.inputs.area.vectorStatus.getAttribute("role"), "status");
    assert.match(h.view.setup.inputs.area.vectorStatus.textContent, /You can edit the filter while this check runs/);
    assert.equal(h.view.setup.run.disabled, true);
    draft.inputs.area.selecting = false; draft.inputs.area.selectionError = "Could not read this layer."; h.view.render(h.state);
    assert.equal(h.view.setup.inputs.area.vectorStatus.textContent, "Could not read this layer.");
    assert.equal(h.view.setup.inputs.area.editFilter.textContent, "Edit filter");
    assert.equal(h.view.setup.inputs.area.editFilter.disabled, false);
    assert.equal(h.view.setup.inputs.area.areaDescription.hidden, true);
});


test("selected features have one prominent count and predicate; removed layers keep their error visible", () => {
    const h = fixture(), draft = h.state.draft;
    const filter = {enabled: true, match: "all", rules: [{field: "NAME", operator: "eq", value: "Cuba"}]};
    draft.inputs.area.areaMode = "vector"; draft.inputs.area.vectorKey = "view:countries";
    draft.inputs.area.vectors = [{key: "view:countries", collectionId: "vectors", itemId: "countries", label: "Countries", filter}];
    draft.inputs.area.area = {kind: "catalogSelection", selection: {filter}}; draft.inputs.area.vectorInfo = {matched: 1, total: 253};
    h.view.render(h.state);
    assert.equal(h.view.setup.inputs.area.selectedCount.textContent, "1 of 253 features selected");
    assert.equal(h.view.setup.inputs.area.filterDescription.textContent, 'NAME equals "Cuba"');
    assert.equal(h.view.setup.inputs.area.areaDescription.hidden, true);
    draft.inputs.area.filterEditing = true; h.view.render(h.state);
    assert.equal(h.view.getVectorFilterHost("area").hidden, false);
    assert.equal(h.view.setup.inputs.area.editFilter.getAttribute("aria-expanded"), "true");
    assert.equal(h.view.setup.run.disabled, true);
    draft.inputs.area.vectors = []; draft.inputs.area.vectorKey = ""; draft.inputs.area.area = null;
    draft.inputs.area.selectionError = "Add the vector layer to Map layers, or choose another layer."; h.view.render(h.state);
    assert.equal(h.view.setup.inputs.area.selectionCard.hidden, true);
    assert.equal(h.view.setup.inputs.area.areaDescription.hidden, false);
    assert.equal(h.view.setup.inputs.area.areaDescription.textContent, draft.inputs.area.selectionError);
});


test("clip setup shows supported areas and no summary formula", () => {
    const h = fixture(); h.state.draft = createModelDraft(clipModel, {rasters: [raster], area}, "clip"); h.view.render(h.state);
    assert.deepEqual(h.view.setup.inputs.area.source.children.map(option => option.textContent), ["Choose an area…", "Visible map area", "Sampling box"]);
    assert.deepEqual(h.view.setup.parameters, {}); assert.equal(h.view.setup.run.disabled, false);
});

test("clip results offer a GeoTIFF with dimensions and expire correctly", () => {
    const h = fixture(), id = job().jobId;
    h.state.page = "run"; h.state.selectedRun = id;
    h.state.invocation = {...invocation, model: {...clipModel, definition: clipModel}, parameters: {}};
    h.state.runs = [job({model: clipModel, status: "ready", expiresAt: "2099-01-01T00:00:00Z", result: clipResult, artifacts: fileManifest()})];
    h.view.render(h.state);
    assert.equal(h.view.run.result.children[0].children[0].textContent, "Clipped raster");
    assert.equal(h.view.run.result.children[0].children[1].textContent, clipResult.filename);
    assert.equal(h.view.run.result.children[0].children[2].textContent, "10 × 10 pixels · 90 valid pixels");
    h.state.runs[0].status = "expired"; h.view.render(h.state); assert.equal(h.view.run.result.children.length, 0);
});

test("result cards use captured YAML labels for unfamiliar models", () => {
    for (const output of [clipResult, statisticsResult, timeSeriesResult]) {
        const h = fixture(); h.state.page = "run"; h.state.selectedRun = job().jobId;
        h.state.runs = [job({model: {...model, id: "habitat-model"}, status: "ready", expiresAt: "2099-01-01T00:00:00Z",
            result: {...output, name: "habitat", label: "Habitat output <script>"}})];
        h.view.render(h.state);
        const first = h.view.run.result.children[0];
        assert.equal(output.kind === "statistics" ? first.textContent : first.children[0].textContent, "Habitat output <script>");
    }
});

test("time-series runs show saved coverage, their statistic and the ordinary CSV download", () => {
    const h = fixture(), artifacts = fileManifest();
    artifacts.files = [{...artifacts.files[0], name: timeSeriesResult.name, label: timeSeriesResult.label,
        filename: timeSeriesResult.filename, mediaType: timeSeriesResult.mediaType, bytes: timeSeriesResult.bytes}];
    artifacts.totalBytes = timeSeriesResult.bytes;
    const run = job({model: seriesModel, status: "ready", expiresAt: artifacts.expiresAt, result: timeSeriesResult, artifacts});
    Object.assign(h.state, {page: "run", selectedRun: run.jobId, runs: [run],
        invocation: {model: {...seriesModel, definition: seriesModel}, parameters: {}, inputs: {
            source: {collectionId: "eolab-temporal-datasets", itemId: "weather", variable: "temperature",
                startTime: "2000-01-01T00:00:00Z", endTime: "2000-01-04T00:00:00Z"}, area, statistic: "mean",
        }}});
    h.view.render(h.state);
    const card = h.view.run.result.children[0];
    assert.equal(card.className, "models-result");
    const text = card.children.map(node => node.textContent);
    for (const value of ["Area time series", "series.csv", "Statistic: Mean", "Units: K", "Observations in this run: 3",
        "First observation: 2000-01-01 00:00:00 UTC", "Last observation: 2000-01-03 12:00:00 UTC"])
        assert.ok(text.includes(value), value);
    assert.ok(text.includes("Download the CSV for values and per-calculation pixel counts."));
    assert.deepEqual(h.view.run.inputsBody.children[0].children.slice(-2).map(node => node.textContent), ["Statistic", "Mean"]);
    const actions = card.children.at(-2);
    assert.equal(actions.children[0].hidden, true);
    assert.equal(actions.children[1].textContent, "Download");
    assert.equal(actions.children[1].href, artifacts.files[0].url);
    assert.equal(h.actions.length, 0);
});


/** Render a temporal recipe with real draft construction and admitted Catalog metadata.
 * @return {Object} Existing view harness with a complete period independent of map imagery.
 */
function temporalFixture() {
    const h = fixture();
    const recipe = {...model, id: "vegetation-period", title: "Vegetation over a period", parameters: {}, inputs: {
        observations: {type: "temporal_interval", label: "Dataset and period"},
        region: {type: "summary_area", label: "Analysis area"},
        statistic: {type: "temporal_reduction", label: "Period statistic"},
    }, steps: [{id: "calculate", operation: "another.period-implementation.v2", inputs: {
        precipitation: {value: {inputUnit: "kg m**-2 s**-1", outputUnit: "mm", factor: 1}},
    }}]};
    const dataset = {collectionId: "eolab-temporal-datasets", itemId: "vegetation", label: "Vegetation observations"};
    const draft = createModelDraft(recipe, {temporalDatasets: [dataset], area}, "temporal-draft");
    Object.assign(draft.temporal, {datasetKey: modelSourceKey(dataset), variable: "vegetation_index", periodMode: "times",
        startTime: "2020-01-01T00:00", endTime: "2020-02-01T00:00",
        item: {collection: dataset.collectionId, id: dataset.itemId, properties: {title: "Vegetation observations", "cube:variables": {
            vegetation_index: {description: "Vegetation index", unit: "1", "eolab:time_support": "instantaneous"},
            precipitation: {description: "Precipitation rate", unit: "kg m-2 s-1", "eolab:time_support": "mean_rate"},
        }}}, choices: {months: ["2020-01", "2020-02"], month: "2020-01",
            times: ["2020-01-01T04:30:00.000Z", "2020-01-02T09:15:00.000Z", "2020-01-04T16:45:00.000Z"]}});
    h.state.draft = draft; h.view.render(h.state);
    return {...h, draft, controls: h.view.setup.temporal};
}

test("temporal recipes show UTC period fields and reuse area choices without an ordinary raster", () => {
    const h = temporalFixture(), controls = h.controls;
    assert.equal(h.view.setup.inputs.raster, undefined);
    assert.equal(h.view.setup.run.textContent, "Run analysis");
    assert.equal(h.view.setup.run.disabled, false);
    assert.deepEqual(h.view.setup.inputs.region.source.children.map(option => option.textContent),
        ["Choose an area…", "Whole raster", "Visible map area", "Sampling box"]);
    assert.match(h.view.setup.inputs.region.mapHelp.textContent, /Run analysis/);
    assert.equal(controls.period.startDate.type, "text"); assert.equal(controls.period.endDate.type, "text");
    assert.equal(controls.period.startDate.placeholder, "YYYY-MM-DD");
    assert.equal(controls.period.startDatePicker.type, "date");
    assert.equal(controls.period.startTime.type, "time"); assert.equal(controls.period.startTime.step, "any");
    assert.equal(controls.period.endTime.type, "time"); assert.equal(controls.period.endTime.step, "any");
    assert.equal(controls.period.startTime.parentNode.textContent, "Start time (UTC)");
    assert.equal(controls.period.endTime.parentNode.textContent, "End time (excluded, UTC)");
    assert.deepEqual(controls.period.periodMode.children.map(option => option.textContent), ["Whole year", "Whole month", "Date range", "Exact times"]);
    assert.equal(controls.statistic.parentNode.textContent, "Period statistic");
    assert.equal(controls.dataset.children[1].textContent, "Vegetation observations");
    assert.equal(controls.variable.children[1].textContent, "Vegetation index (1)");
    assert.equal(controls.variable.children[2].disabled, false);
    assert.equal(Boolean(controls.availability.open), false);
    assert.match(controls.coverage.textContent, /^3 observations in 2020-01/);
    assert.match(controls.coverage.textContent, /UTC/);
    assert.match(controls.reductionHelp.textContent, /Result units: 1/);
    assert.match(controls.reductionHelp.textContent, /second map counts valid observations/);
    assert.equal(controls.percentileField.hidden, true); assert.equal(controls.percentile.disabled, true);
});

test("time entry modes expose only their own required fields and describe the captured UTC period", () => {
    const h = temporalFixture(), controls = h.controls;
    const groups = {month: [controls.period.selectedMonth], days: [controls.period.firstDay, controls.period.lastDay],
        times: [controls.period.startDate, controls.period.startTime, controls.period.endDate, controls.period.endTime]};
    for (const mode of ["year", "month", "days", "times"]) {
        h.draft.temporal.periodMode = mode; h.view.render(h.state);
        assert.equal(controls.period.periodMode.value, mode);
        for (const [name, inputs] of Object.entries(groups)) {
            for (const input of inputs) assert.equal(input.disabled, name !== mode);
        }
        assert.equal(controls.period.selectedYear.disabled, !["year", "month"].includes(mode));
        assert.equal(controls.period.firstDayPicker.disabled, mode !== "days");
        assert.equal(controls.period.startDatePicker.disabled, mode !== "times");
    }
    assert.equal(controls.period.selectedMonth.value, "01"); assert.equal(controls.period.selectedYear.value, "2020");
    assert.equal(controls.period.selectedMonth.children.length, 12);
    assert.equal(controls.period.firstDay.type, "text"); assert.equal(controls.period.lastDay.type, "text");
    assert.equal(controls.period.firstDay.value, "2020-01-01"); assert.equal(controls.period.lastDay.value, "2020-01-31");
    assert.equal(controls.period.lastDay.parentNode.parentNode.children[0].textContent, "Last day (included) (YYYY-MM-DD)");
    assert.equal(h.actions.length, 0);
});

test("temporal edits and availability actions preserve focused dates and never submit a run", () => {
    const h = temporalFixture(), controls = h.controls;
    controls.availability.open = true;
    controls.period.startTime.focus(); controls.period.startTime.value = "03:27:41.250";
    controls.period.startTime.dispatchEvent(new Event("input"));
    assert.deepEqual(h.actions.at(-1), ["TemporalEdit", {startTime: "2020-01-01T03:27:41.250"}]);
    h.draft.temporal.loading = true; h.view.render(h.state);
    assert.equal(h.view.setup.temporal, controls); assert.equal(h.doc.activeElement, controls.period.startTime);
    assert.equal(controls.period.startTime.value, "03:27:41.250");
    assert.equal(controls.availability.open, true); assert.equal(controls.refresh.disabled, true);
    assert.equal(controls.sourceRoot.getAttribute("aria-busy"), "true");
    h.draft.temporal.loading = false; h.view.render(h.state);
    controls.month.value = "2020-02"; controls.month.dispatchEvent(new Event("change"));
    controls.useMonth.dispatchEvent(new Event("click")); controls.refresh.dispatchEvent(new Event("click"));
    assert.deepEqual(h.actions.slice(-3).map(([action]) => action), ["TemporalMonth", "UseTemporalMonth", "RefreshTemporal"]);
    assert.equal(h.actions.at(-3)[1], "2020-02");
    assert.equal(h.draft.temporal.endTime, "2020-02-01T00:00");
    assert.equal(h.actions.some(([action]) => action === "Submit"), false);
    h.view.setup.form.dispatchEvent(new Event("submit", {cancelable: true}));
    assert.equal(h.actions.at(-1)[0], "Submit");
});

test("temporal validation and statistic settings remain local to the relevant controls", () => {
    const h = temporalFixture(), controls = h.controls;
    controls.statistic.value = "percentile"; controls.statistic.dispatchEvent(new Event("change"));
    assert.deepEqual(h.actions.at(-1), ["Edit", {reduction: {reducer: "percentile", percentile: 90}}]);
    h.draft.reduction.reducer = "percentile"; h.view.render(h.state);
    assert.equal(controls.percentileField.hidden, false); assert.equal(controls.percentile.disabled, false);
    controls.percentile.value = "97.5"; controls.percentile.dispatchEvent(new Event("input"));
    assert.deepEqual(h.actions.at(-1), ["Edit", {reduction: {reducer: "percentile", percentile: 97.5}}]);
    h.draft.reduction.percentile = 101; h.view.render(h.state);
    assert.match(controls.reductionStatus.textContent, /0 to 100/); assert.equal(h.view.setup.run.disabled, true);
    h.draft.reduction = {reducer: "stdev", percentile: 101}; h.view.render(h.state);
    assert.equal(controls.percentileField.hidden, true); assert.equal(controls.reductionStatus.hidden, true);
    assert.match(controls.reductionHelp.textContent, /population formula/); assert.equal(h.view.setup.run.disabled, false);
    h.draft.temporal.endTime = h.draft.temporal.startTime; h.view.render(h.state);
    assert.match(controls.status.textContent, /end must be later/); assert.equal(h.view.setup.run.disabled, true);
    h.draft.temporal.endTime = "2020-02-01T00:00";
    h.draft.temporal.choices = {months: ["2020-01"], month: "2020-01", times: []}; h.view.render(h.state);
    assert.match(controls.coverage.textContent, /No observations are available in this month/);
    assert.equal(controls.useMonth.disabled, true); assert.equal(h.view.setup.run.disabled, false);
    h.draft.temporal.datesError = "Available dates could not be loaded. Try again."; h.view.render(h.state);
    assert.match(controls.coverage.textContent, /Available dates could not be loaded/);
    assert.equal(h.view.setup.run.disabled, false);
    h.draft.temporal.error = "The selected dataset is no longer in Map layers."; h.view.render(h.state);
    assert.match(controls.status.textContent, /no longer in Map layers/); assert.equal(h.view.setup.run.disabled, true);
});

test("area-series setup describes spatial statistics and complete overlapping intervals without period-map controls", () => {
    const h = fixture();
    const dataset = {collectionId: "eolab-temporal-datasets", itemId: "observations", label: "Weather observations"};
    const draft = createModelDraft(seriesModel, {temporalDatasets: [dataset], area}, "series-draft");
    Object.assign(draft.temporal, {datasetKey: modelSourceKey(dataset), variable: "temperature", periodMode: "times",
        startTime: "2000-01-31T23:30", endTime: "2000-02-01T01:10",
        item: {collection: dataset.collectionId, id: dataset.itemId, properties: {title: dataset.label, "cube:variables": {
            temperature: {description: "Air temperature", unit: "K", "eolab:time_support": "instantaneous"},
            rain: {description: "Rainfall rate", unit: "mm/day", "eolab:time_support": "mean_rate"},
            energy: {description: "Stored energy", unit: "J m-2", "eolab:time_support": "accumulation"},
        }}}});
    h.state.draft = draft; h.view.render(h.state);
    const controls = h.view.setup.temporal;
    assert.equal(h.view.setup.inputs.raster, undefined);
    assert.equal(controls.period.startTime.parentNode.textContent, "Start time (UTC)");
    assert.equal(controls.period.endTime.parentNode.textContent, "End time (excluded, UTC)");
    assert.equal(controls.statistic.parentNode.textContent, "Statistic");
    assert.ok(controls.variable.children.slice(1).every(option => !option.disabled));
    assert.deepEqual(controls.statistic.children.map(option => option.value), ["mean", "sum", "min", "max", "stdev", "count"]);
    assert.match(controls.periodHelp.textContent, /start.*includ|at or after.*start/i);
    assert.match(controls.periodHelp.textContent, /end.*exclud|before.*end/i);
    assert.match(controls.reductionHelp.textContent, /equal weight/i);
    assert.match(controls.reductionHelp.textContent, /CSV/);
    assert.doesNotMatch(controls.reductionHelp.textContent, /second map/);
    for (const variable of ["rain", "energy"]) {
        draft.temporal.variable = variable; draft.reduction.reducer = "count"; h.view.render(h.state);
        assert.match(controls.periodHelp.textContent, /overlap/i);
        assert.match(controls.periodHelp.textContent, /full|complete/i);
        assert.match(controls.periodHelp.textContent, /prorat|scal/i);
        assert.match(controls.reductionHelp.textContent, /cells/);
        assert.equal(controls.percentileField.hidden, true); assert.equal(controls.percentile.disabled, true);
        assert.equal(controls.period.startTime.step, "any"); assert.equal(controls.period.endTime.step, "any");
        assert.equal(h.view.setup.run.disabled, false);
    }
    draft.reduction.reducer = "stdev"; h.view.render(h.state);
    assert.match(controls.reductionHelp.textContent, /population/i);
    assert.match(controls.reductionHelp.textContent, /J m-2/);
    assert.equal(h.actions.length, 0);
});

test("precipitation controls explain duration totals and round changed dates visibly across calendar boundaries", () => {
    const h = temporalFixture(), controls = h.controls;
    h.draft.temporal.item.properties["cube:variables"].precipitation.unit = "kg m**-2 s**-1";
    h.draft.temporal.variable = "precipitation"; h.draft.reduction.reducer = "precipitation_total";
    h.view.render(h.state);
    assert.equal(controls.variable.children[2].disabled, false);
    assert.equal(controls.statistic.children.at(-1).textContent, "Precipitation total (mm)");
    assert.equal(controls.period.startTime.step, "3600"); assert.equal(controls.period.endTime.step, "3600");
    assert.match(controls.periodHelp.textContent, /30 minutes rounds forward/);
    assert.match(controls.availabilityHelp.textContent, /observation labels, not the boundaries/);
    assert.match(controls.reductionHelp.textContent, /interval duration in seconds/);
    assert.match(controls.reductionHelp.textContent, /converted to mm/);
    assert.match(controls.reductionHelp.textContent, /omitted, not filled with zero/);
    assert.match(controls.reductionHelp.textContent, /counts valid available observations/);
    controls.period.endDate.value = "2020-02-29";
    controls.period.endTime.focus(); controls.period.endTime.value = "23:30";
    controls.period.endTime.dispatchEvent(new Event("change"));
    assert.equal(controls.period.endDate.value, "2020-03-01"); assert.equal(controls.period.endTime.value, "00:00");
    assert.deepEqual(h.actions.at(-1), ["TemporalEdit", {endTime: "2020-03-01T00:00"}]);
    controls.period.startDate.value = "2019-12-31";
    controls.period.startTime.focus(); controls.period.startTime.value = "23:29:59.999";
    controls.period.startTime.dispatchEvent(new Event("blur"));
    assert.equal(controls.period.startDate.value, "2019-12-31"); assert.equal(controls.period.startTime.value, "23:00");
    assert.deepEqual(h.actions.at(-1), ["TemporalEdit", {startTime: "2019-12-31T23:00"}]);
    h.draft.reduction.reducer = "mean"; h.view.render(h.state);
    assert.equal(controls.period.startTime.step, "any"); assert.equal(controls.period.endTime.step, "any");
    assert.match(controls.periodHelp.textContent, /complete observation.*overlaps.*Dates are not rounded/);
    assert.match(controls.reductionHelp.textContent, /equal weight.*Result units: kg m\*\*-2 s\*\*-1/);
    assert.doesNotMatch(controls.reductionHelp.textContent, /converted to mm/);
    assert.equal(h.actions.some(([action]) => action === "Submit"), false);
});

test("saved temporal run inputs describe the captured interval and statistic independently of map changes", () => {
    const h = temporalFixture();
    const period = {collectionId: "eolab-temporal-datasets", itemId: "vegetation", variable: "vegetation_index",
        startTime: "2020-01-01T03:27:41.250Z", endTime: "2020-01-04T18:00:00.000Z"};
    h.state.page = "run"; h.state.selectedRun = job().jobId; h.state.runs = [job({model: h.draft.model})];
    h.state.invocation = {model: {...h.draft.model, definition: h.draft.model}, parameters: {},
        inputs: {observations: period, region: area, statistic: {reducer: "percentile", percentile: 97.5}}};
    h.view.render(h.state);
    const details = h.view.run.inputsBody.children[0].children;
    assert.match(details[1].textContent, /vegetation_index/);
    assert.match(details[1].textContent, /2020-01-01T03:27:41.250Z/);
    assert.match(details[1].textContent, /2020-01-04T18:00:00.000Z/);
    assert.equal(details[5].textContent, "Percentile 97.5");
    h.draft.temporal.variable = "precipitation"; h.draft.temporal.startTime = "2025-01-01T00:00";
    h.view.render(h.state);
    assert.equal(h.view.run.inputsBody.children[0].children[1], details[1]);
    assert.match(details[1].textContent, /vegetation_index/);
});

test("completed period maps acquire a descriptive title from saved inputs, not the current draft", () => {
    const h = temporalFixture(), artifacts = fileManifest();
    const result = {...clipResult, label: "Period map"};
    Object.assign(h.state, {page: "run", selectedRun: artifacts.jobId,
        runs: [job({model: h.draft.model, status: "ready", expiresAt: artifacts.expiresAt, result, artifacts})]});
    h.view.render(h.state);
    assert.equal(h.view.run.result.children[0].children[0].textContent, "Period map");
    h.state.invocation = {model: {...h.draft.model, definition: h.draft.model}, parameters: {}, inputs: {
        observations: {collectionId: "eolab-temporal-datasets", itemId: "vegetation", variable: "vegetation_index",
            startTime: "2020-01-01T00:00:00Z", endTime: "2020-02-01T00:00:00Z"},
        region: area, statistic: {reducer: "mean"},
    }};
    h.state.outputPreviews = {[artifacts.files[0].artifactId]: {canShow: true}};
    h.view.render(h.state);
    const card = h.view.run.result.children[0], actions = card.children.at(-2);
    const title = "Mean · vegetation index · January 2020";
    assert.equal(card.children[0].textContent, title);
    assert.equal(actions.children[0].getAttribute("aria-label"), `Show on map: ${title}`);
    assert.equal(actions.children[1].getAttribute("aria-label"), `Download ${title}`);
    assert.equal(actions.children[1].href, artifacts.files[0].url);
    actions.children[0].dispatchEvent(new Event("click"));
    assert.deepEqual(h.actions.at(-1), ["ShowOutput", artifacts.files[0].artifactId]);
    h.draft.temporal.variable = "precipitation"; h.draft.reduction.reducer = "max";
    h.view.render(h.state);
    assert.equal(h.view.run.result.children[0], card);
    assert.equal(card.children[0].textContent, title);
});
