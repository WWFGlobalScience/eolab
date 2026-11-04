import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HabitatAdminView } from "../../src/habitat-admin/view.js";
import { HabitatAdminController } from "../../src/habitat-admin/controller.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";

const markup = readFileSync(new URL("../../../src/eolab_app/annotation_sessions/admin.habitat.html", import.meta.url), "utf8");
const selection = {collectionId: "vectors", itemId: "areas", assetKey: "data", layerName: "polygons",
    filter: {enabled: true, match: "all", rules: []}};
/** Dispatch an explicit user click.
 * @param {EventTarget} node Button.
 * @return {void}
 */
function click(node) { node.dispatchEvent(new Event("click")); }

/** Compose the actual page and view using the established small DOM fixture.
 * @return {Object} View, state, actions and owning document.
 */
function fixture() {
    const document = new SummaryControlDocument(markup), actions = [];
    const template = document.querySelector("#vector-filter-panel");
    template.cloneNode = () => {
        const root = document.createElement("section"), controls = new Map();
        for (const [, id] of markup.matchAll(/\sid="([^"]+)"/g)) if (id !== "habitat-admin" && id !== "vector-filter-panel") {
            const control = document.createElement(id.includes("match") ? "select" : id.includes("enabled") ? "input" : "button");
            control.id = id; controls.set(`#${id}`, control); root.append(control);
        }
        const query = root.querySelector.bind(root);
        root.querySelector = selector => controls.get(selector) ?? query(selector);
        return root;
    };
    const view = new HabitatAdminView(document);
    view.bind(Object.fromEntries(["search", "searchMore", "addArea", "removeArea", "setYears", "check", "prepare", "recover", "refreshHistory", "loadMore", "cancel", "retry"]
        .map(name => [name, (...args) => actions.push([name, ...args])])));
    const state = {options: {minimumYear: 2017, maximumYear: 2019}, sources: [{key: "areas", label: "Country polygons", selection,
        fields: [{name: "code", type: "int"}]}], searching: false, searchError: "", nextSearch: null,
        areas: [], years: [2018], coverageRows: [], checking: false, submissions: [], jobs: [], nextCursor: null,
        historyLoading: false, historyError: "", error: "", submitting: false, canPrepare: false, completedJobs: 0, requestedJobs: 0};
    view.render(state);
    return {view, state, actions, document};
}

/** Create one retained administrator job with overridable lifecycle state.
 * @param {Object} [changes={}] Snapshot overrides.
 * @return {Object} Path-free preparation job.
 */
function job(changes = {}) {
    return {jobId: "a".repeat(32), inputs: {name: "Northern area", year: 2018}, status: "running",
        progress: ["ready", "expired"].includes(changes.status) ? {phase: "ready", completed: null, total: null, unit: null} :
            {phase: "fetching_habitat_tiles", completed: 2, total: 6, unit: "tiles"},
        updatedAt: "2026-11-03T08:00:00Z", expiresAt: "2099-11-04T08:00:00Z", metadataExpiresAt: "2099-11-10T08:00:00Z", error: null, result: null, ...changes};
}

test("long Catalog labels can be added with their suggested names and original source identity", async t => {
    const labels = [
        ["corridor_precontext_resistance_shapefiles/India_CentralIndia_corridor_precontext_resistance.shp",
            "India_CentralIndia_corridor_precontext_resistance.shp"],
        [`project\\${"🌍".repeat(85)}.shp`, "🌍".repeat(80)],
    ];
    for (const [label, suggestedName] of labels) {
        const h = fixture(), original = structuredClone(h.state.sources[0]); original.label = label;
        original.selection.collectionId = "eolab-mounted-vectors";
        const controller = new HabitatAdminController({view: h.view, documentContext: h.document,
            windowContext: new EventTarget(), storage: null,
            api: {getOptions: async () => ({...h.state.options, defaultYear: 2018}),
                list: async () => ({jobs: [], nextCursor: null}),
                searchAreas: async () => ({sources: [original], next: null}),
                coverage: async () => assert.fail("Adding an area must not check coverage"),
                submit: async () => assert.fail("Adding an area must not prepare inputs")}});
        t.after(() => controller.destroy());
        await controller.start(); await controller.search("");
        h.view.source.value = original.key; h.view.source.dispatchEvent(new Event("change"));
        assert.equal(h.view.name.value, suggestedName);
        assert.match(h.view.name.parentNode.textContent, /Area name \(1–80 characters\)/);
        assert.equal(h.view.addArea.disabled, false);
        click(h.view.addArea);
        assert.equal(controller.state.error, "");
        assert.equal(controller.state.areas.length, 1);
        assert.equal(controller.state.areas[0].name, suggestedName);
        assert.deepEqual(controller.state.areas[0].selection, original.selection);
        assert.equal(original.label, label);
        assert.equal(h.view.source.children[1].textContent, label);
        assert.equal(h.view.check.disabled, false); assert.equal(h.view.prepare.disabled, false);
        controller.destroy();
    }
});

test("choosing another Catalog layer preserves an entered area name", () => {
    const h = fixture();
    h.state.sources.push({...h.state.sources[0], key: "other", label: "Folder/Other polygons.shp"});
    h.view.render(h.state);
    h.view.name.value = "Central India corridor"; h.view.name.dispatchEvent(new Event("input"));
    h.view.source.value = "other"; h.view.source.dispatchEvent(new Event("change"));
    assert.equal(h.view.name.value, "Central India corridor");
    click(h.view.addArea);
    assert.deepEqual(h.actions.at(-1), ["addArea", "Central India corridor", "other", selection.filter]);
    h.view.destroy();
});

test("area predicates and multiple years use explicit actions without checking or preparing", async () => {
    const h = fixture();
    h.view.source.value = "areas"; h.view.source.dispatchEvent(new Event("change"));
    h.view.name.value = "Selected district"; h.view.name.dispatchEvent(new Event("input"));
    click(h.view.editFilter);
    assert.equal(h.view.addArea.disabled, true);
    const editor = h.view.filterControls;
    click(editor.add);
    const input = editor.rules.children[0].children[2];
    input.value = "7"; input.dispatchEvent(new Event("input"));
    assert.equal(h.actions.length, 0);
    click(editor.applyButton); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.view.addArea.disabled, false);
    click(h.view.addArea);
    assert.deepEqual(h.actions[0], ["addArea", "Selected district", "areas", {enabled: true, match: "all", rules: [{field: "code", operator: "eq", value: 7}]}]);
    h.view.yearControls.get(2019).checked = true; h.view.yearControls.get(2019).dispatchEvent(new Event("change"));
    assert.deepEqual(h.actions.at(-1), ["setYears", [2018, 2019]]);
    assert.equal(h.actions.some(([action]) => ["check", "prepare"].includes(action)), false);
    h.state.areas = [{id: "district", name: "Selected district", selection, filterSummary: "code equals 7"}]; h.state.canPrepare = true; h.view.render(h.state);
    click(h.view.check); click(h.view.prepare);
    assert.deepEqual(h.actions.slice(-2), [["check"], ["prepare"]]);
    h.view.destroy();
});

test("coverage snapshots stay separate from historical completion and job counts", () => {
    const h = fixture();
    h.state.coverageRows = [{key: "north:2018", name: "Northern area", year: 2018, coverage: {requiredTiles: 6, cachedTiles: 4, missingTiles: 2}, checkedAt: "2026-11-03T08:00:00Z", error: ""},
        {key: "south:2018", name: "Overlapping area", year: 2018, coverage: {requiredTiles: 6, cachedTiles: 4, missingTiles: 2}, checkedAt: "2026-11-03T08:00:00Z", error: ""}];
    h.state.jobs = [job({status: "ready"})]; h.state.requestedJobs = 2; h.state.completedJobs = 1;
    h.view.render(h.state);
    assert.match(h.view.cards.get("coverage:north:2018").detail.textContent, /^4 cached · 2 missing · 6 required tiles/);
    assert.match(h.view.cards.get("coverage:south:2018").detail.textContent, /^4 cached · 2 missing · 6 required tiles/);
    assert.equal(h.view.submissionStatus.textContent, "1 of 2 requested jobs completed.");
    assert.equal(h.view.cards.get(`job:${"a".repeat(32)}`).detail.textContent, "Completed");
    assert.match(markup, /Habitat cached inputs/); assert.match(markup, /\/assets\/habitat-admin\.js/);
    h.view.destroy();
});

test("history actions respect retained inputs and preserve focus during progress refresh", () => {
    const h = fixture(), running = job(); h.state.jobs = [running]; h.view.render(h.state);
    const card = h.view.cards.get(`job:${running.jobId}`);
    assert.match(card.detail.textContent, /2 of 6 tiles/); assert.equal(card.cancel.hidden, false); assert.equal(card.retry.hidden, true);
    card.cancel.focus(); running.progress.completed = 3; h.view.render(h.state);
    assert.equal(h.document.activeElement, card.cancel); assert.equal(h.view.cards.get(`job:${running.jobId}`), card);
    click(card.cancel); assert.deepEqual(h.actions.at(-1), ["cancel", running.jobId]);
    for (const status of ["failed", "cancelled", "interrupted", "expired"]) {
        running.status = status; h.view.render(h.state); assert.equal(card.retry.hidden, false); assert.equal(card.cancel.hidden, true);
    }
    assert.equal(h.document.activeElement, card.title);
    click(card.retry); assert.deepEqual(h.actions.at(-1), ["retry", running.jobId]);
    running.inputs = null; h.view.render(h.state); assert.equal(card.retry.hidden, true);
    assert.equal(card.title.textContent, "Preparation details expired");
    h.view.destroy();
});

test("stopped preparation history retains measured tile counts without inventing missing measurements", () => {
    const h = fixture(), current = job({progress: {phase: "fetching_habitat_tiles", completed: 3, total: 8, unit: "tiles"}});
    h.state.jobs = [current];
    for (const [status, label] of [["failed", "Failed"], ["interrupted", "Interrupted"], ["cancelling", "Cancelling…"], ["cancelled", "Cancelled"]]) {
        current.status = status; h.view.render(h.state);
        assert.equal(h.view.cards.get(`job:${current.jobId}`).detail.textContent, `${label} · 3 of 8 tiles`);
    }
    current.progress.completed = 0; h.view.render(h.state);
    assert.equal(h.view.cards.get(`job:${current.jobId}`).detail.textContent, "Cancelled · 0 of 8 tiles");
    current.progress.completed = null; h.view.render(h.state);
    assert.equal(h.view.cards.get(`job:${current.jobId}`).detail.textContent, "Cancelled");
    current.progress.completed = 3; current.progress.total = null; h.view.render(h.state);
    assert.equal(h.view.cards.get(`job:${current.jobId}`).detail.textContent, "Cancelled");
    h.view.destroy();
});

test("reports, partial failures and uncertain submissions retain distinct visible actions", () => {
    const h = fixture(), ready = job({status: "ready", result: {url: "/api/admin/habitat/input-preparations/a/report", provenanceUrl: "/api/admin/habitat/input-preparations/a/provenance"}});
    h.state.jobs = [ready]; h.state.submissions = [{key: "north:2018", name: "Northern area", year: 2018, status: "uncertain", error: "Connection lost"},
        {key: "south:2018", name: "Southern area", year: 2018, status: "failed", error: "Catalog source unavailable"}];
    h.view.render(h.state);
    const card = h.view.cards.get(`job:${ready.jobId}`), uncertain = h.view.cards.get("submission:north:2018");
    assert.equal(card.report.hidden, false); assert.equal(card.report.href, ready.result.url); assert.equal(card.provenance.href, ready.result.provenanceUrl);
    assert.match(uncertain.detail.textContent, /unknown/); assert.equal(uncertain.error.textContent, "Connection lost");
    assert.match(h.view.submissionStatus.textContent, /No preparations have been confirmed yet/);
    click(uncertain.recover); assert.deepEqual(h.actions.at(-1), ["recover", "north:2018"]);
    assert.equal(h.view.cards.get("submission:south:2018").error.textContent, "Catalog source unavailable");
    assert.equal(h.view.cards.get("submission:south:2018").recover.hidden, true);
    assert.match(h.view.cards.get("submission:south:2018").detail.textContent, /use Prepare inputs/);
    ready.expiresAt = "2000-01-01T00:00:00Z"; h.view.render(h.state); assert.equal(card.report.hidden, true);
    h.state.submitting = true; h.view.render(h.state); assert.equal(uncertain.recover.disabled, true); assert.equal(h.view.prepare.disabled, true);
    h.view.destroy();
});

test("new history appears in server order while existing rows keep their controls", () => {
    const h = fixture(), older = job(), newer = job({jobId: "b".repeat(32)});
    h.state.jobs = [older]; h.view.render(h.state);
    const olderCard = h.view.cards.get(`job:${older.jobId}`); olderCard.cancel.focus();
    h.state.jobs = [newer, older]; h.view.render(h.state);
    assert.equal(h.view.history.children[0], h.view.cards.get(`job:${newer.jobId}`).root);
    assert.equal(h.view.history.children[1], olderCard.root); assert.equal(h.document.activeElement, olderCard.cancel);
    h.state.jobs = [newer]; h.view.render(h.state);
    assert.equal(h.view.cards.has(`job:${older.jobId}`), false); assert.equal(h.document.activeElement, h.view.refresh);
    const before = h.actions.length; click(olderCard.cancel); assert.equal(h.actions.length, before);
    h.view.destroy();
});

test("active job placeholders never appear as report-retention deadlines", () => {
    const h = fixture(), current = job({metadataExpiresAt: null, expiresAt: "2000-01-01T00:00:00Z"});
    h.state.jobs = [current];
    for (const status of ["queued", "running", "cancelling"]) {
        current.status = status; h.view.render(h.state);
        assert.match(h.view.cards.get(`job:${current.jobId}`).times.textContent,
            /Report expires After completion · Saved inputs expire After completion$/);
    }
    current.status = "ready"; current.expiresAt = "2099-11-04T08:00:00Z";
    current.progress = {phase: "ready", completed: null, total: null, unit: null};
    current.metadataExpiresAt = "2099-11-10T08:00:00Z"; h.view.render(h.state);
    assert.doesNotMatch(h.view.cards.get(`job:${current.jobId}`).times.textContent, /After completion/);
    h.view.destroy();
});

test("loaded history follows report and saved-input deadlines before another server read", () => {
    const h = fixture(), retained = job({status: "ready", expiresAt: "2000-01-01T00:00:00Z"});
    h.state.jobs = [retained]; h.view.render(h.state);
    const card = h.view.cards.get(`job:${retained.jobId}`);
    assert.equal(card.detail.textContent, "Report expired"); assert.equal(card.report.hidden, true);
    assert.equal(card.retry.hidden, false); click(card.retry);
    assert.deepEqual(h.actions.at(-1), ["retry", retained.jobId]);
    retained.metadataExpiresAt = "2000-01-08T00:00:00Z"; h.view.render(h.state);
    assert.notEqual(retained.inputs, null); assert.equal(card.retry.hidden, true);
    assert.equal(card.title.textContent, "Preparation details expired");
    h.view.destroy();
});

test("an original job explains its existing retry while recovery stays on the saved command", () => {
    const h = fixture(), original = job({status: "failed"}); h.state.jobs = [original];
    const retry = {key: `retry:${original.jobId}`, kind: "retry", sourceJobId: original.jobId,
        name: original.inputs.name, year: original.inputs.year, status: "uncertain", error: "Connection lost"};
    h.state.submissions = [retry]; h.view.render(h.state);
    const card = h.view.cards.get(`job:${original.jobId}`), submission = h.view.cards.get(`submission:${retry.key}`);
    assert.equal(card.retry.disabled, true); assert.equal(card.retry.textContent, "Retry needs recovery");
    assert.equal(submission.recover.hidden, false); click(submission.recover);
    assert.deepEqual(h.actions.at(-1), ["recover", retry.key]);
    retry.status = "submitting"; h.view.render(h.state);
    assert.equal(card.retry.disabled, true); assert.equal(card.retry.textContent, "Submitting retry…");
    retry.status = "accepted"; h.view.render(h.state);
    assert.equal(card.retry.disabled, true); assert.equal(card.retry.textContent, "Retry requested");
    retry.status = "failed"; h.view.render(h.state);
    assert.equal(card.retry.disabled, false); assert.equal(card.retry.textContent, "Retry missing inputs");
    h.view.destroy();
});

test("refresh keeps source/name drafts and teardown detaches actions", () => {
    const h = fixture(); h.view.source.value = "areas"; h.view.source.dispatchEvent(new Event("change"));
    h.view.name.value = "Unsubmitted area"; h.view.name.focus(); h.view.query.value = "district";
    h.state.historyLoading = true; h.state.error = "<script>private failure</script>"; h.view.render(h.state);
    assert.equal(h.document.activeElement, h.view.name); assert.equal(h.view.name.value, "Unsubmitted area");
    assert.equal(h.view.source.value, "areas"); assert.equal(h.view.error.textContent, h.state.error);
    h.state.historyLoading = false; h.view.render(h.state); click(h.view.refresh);
    assert.deepEqual(h.actions.at(-1), ["refreshHistory"]);
    const before = h.actions.length; h.view.destroy(); click(h.view.refresh); click(h.view.searchButton);
    assert.equal(h.actions.length, before);
});
