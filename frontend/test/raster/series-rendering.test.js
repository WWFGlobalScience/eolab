import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { RasterSeriesView } from "../../src/raster/series-view.js";
import { RasterSeriesPlotsView } from "../../src/raster/series-plots-view.js";

/** Create a real view with a manually advanced browser frame clock.
 * @return {Object} View, fake document and pending frame callbacks.
 */
function fixture() {
    const document = new FakeRasterControlDocument();
    document.defaultView.ResizeObserver = class {
        /** Retain the native callback for explicit layout notifications.
         * @param {Function} callback Resize notifications. */
        constructor(callback) { this.callback = callback; }
        /** Record the observed root in this document without a layout engine.
         * @param {Object} element Target element. @return {void} */
        observe(element) { this.element = element; }
    };
    for (const id of ["order", "direction", "temporal-variable"]) {
        const label = document.createElement("label");
        label.append(document.querySelector("#raster-series-" + id));
    }
    const frames = new Map();
    let serial = 0;
    document.defaultView.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
    document.defaultView.cancelAnimationFrame = id => frames.delete(id);
    const view = new RasterSeriesView(document);
    const frame = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); };
    return { document, view, frames, frame };
}

/** Create area-series controls and record calls to their plot view.
 * @return {Object} Frame fixture, mutable presentation and plot-call snapshots.
 */
function controlsFixture() {
    const h = fixture();
    const create = h.document.createElement.bind(h.document);
    h.document.createElement = tag => {
        const element = create(); element.tagName = tag; element.dataset = {};
        return element;
    };
    const plots = [];
    h.view.plotsView = { renderPlots: state => { plots.push(state); return false; } };
    h.view.actions = {};
    const source = { key: "a", label: "Raster A", selected: true };
    const formula = { id: 1, label: "Mean", expression: "mean(a)", visible: true, plotId: 1, styleIndex: 0,
        rows: [{ label: "Raster A", statisticLabel: "Mean", state: "waiting", value: null, rawValue: null }] };
    const state = { active: true, busy: true, sources: [source], rows: formula.rows, previousRows: null,
        showingPrevious: false, message: "Preparing", canDownload: false, chartType: "line",
        statistics: [formula], plots: [{ id: 1, scale: "linear" }],
        area: { formulas: [formula], sources: [source], results: new Map(), areaChoice: "whole",
            hasErrors: false, recoverable: false } };
    const draw = () => { h.view.render(state); h.frame(); };
    return { ...h, plots, state, draw };
}

test("raster statistics places visible inputs before execution and results", async () => {
    const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
    const panel = html.slice(html.indexOf('<section id="raster-series"'), html.indexOf('<section id="annotations-panel"'));
    const positions = ["raster-series-data-inputs", 'id="raster-series-statistics"',
        "raster-series-status", 'id="raster-series-plots"', "Values &amp; download", "raster-series-data-settings", "Formula reference"]
        .map(name => panel.indexOf(name));
    assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])));
    assert.match(panel, /<button id="raster-series-toggle-inputs" type="button" aria-expanded="true" aria-controls="raster-series-inputs">Inputs · Hide<\/button>/);
    assert.ok(!panel.includes("raster-series-input-summary"));
    assert.ok(!panel.includes('id="raster-series-calculate"'));
    assert.ok(!panel.includes('id="raster-series-edit-area"'));
    assert.ok(!panel.includes('id="raster-series-area-controls"'), "editable areas live only in the floating tool");
    assert.match(panel, />Axis and plot options<\/summary>/);
    assert.ok(!panel.includes("raster-series-source-mode"));
    assert.ok(!panel.includes("raster-series-temporal-dataset"));
    for (const id of ["temporal-variable", "period", "sources",
        "status", "open-area", "retry", "cancel", "recover", "add-plot"]) {
        const attribute = `id="raster-series-${id}"`;
        assert.equal(panel.split(attribute).length - 1, 1, `${id} has one control`);
    }
});

test("named sources align individual raster and time-range checkboxes without repeating timestamps", () => {
    const h = controlsFixture(), events = [];
    h.view.actions = {onSelect: (...args) => events.push(["snapshot", ...args]), onTimeRange: key => events.push(["range", key])};
    h.state.sources = [h.state.sources[0], {key: "pressure-view", label: "Weather · Pressure", selected: true,
        temporalDatasetKey: "weather", rangeSelected: false},
    {key: "other-dataset", label: "Other weather", hasSnapshot: false, temporalDatasetKey: "other-dataset", rangeSelected: false}];
    h.draw();
    /** @return {Object[]} Current named source rows, excluding headings and guidance. */
    const rows = () => [...h.view.sources.children].filter(node => node.className === "raster-series-source");
    const row = rows()[1];
    const [checkbox, range] = row.querySelectorAll("input");
    assert.deepEqual([...h.view.sources.children[0].children].map(node => node.textContent),
        ["Include in raster statistics", "Analyze a time range"]);
    assert.equal(row.querySelector("small"), null);
    assert.equal(range.getAttribute("aria-label"), "Analyze a time range for Weather · Pressure");
    assert.equal(range.checked, false);
    checkbox.checked = false; checkbox.dispatchEvent(new Event("change"));
    range.focus(); range.checked = true; range.dispatchEvent(new Event("change"));
    h.state.sources[1].rangeSelected = true; h.draw();
    assert.equal(h.document.activeElement.dataset.sourceChoice, "range");
    assert.equal(h.document.activeElement.checked, true);
    const dataset = rows()[2];
    assert.equal(dataset.querySelectorAll("input").length, 1, "a retained dataset needs no published snapshot");
    dataset.querySelector("input").checked = true; dataset.querySelector("input").dispatchEvent(new Event("change"));
    assert.deepEqual(events, [["snapshot", "pressure-view", false], ["range", "pressure-view"], ["range", "other-dataset"]]);
});

test("series publishes selected raster and owned area context while inactive without drawing", () => {
    const h = controlsFixture(), contexts = [];
    const view = new RasterSeriesView(h.document, { onContextChange: context => contexts.push(context) });
    view.render({ ...h.state, active: false });
    assert.deepEqual(contexts.at(-1), { source: "Raster A", scope: "Whole raster", usesSamplingBox: false });
    assert.equal(h.frames.size, 0);
    view.render({ ...h.state, active: false, sources: [...h.state.sources, { label: "Raster B", selected: true }],
        area: { ...h.state.area, areaChoice: "selection", area: {kind: "catalogSelection"}, areaLabel: "Selected watershed polygons" } });
    assert.deepEqual(contexts.at(-1), { source: "2 selected rasters", scope: "Selected watershed polygons", usesSamplingBox: false });
    assert.equal(h.frames.size, 0);
    view.render({ ...h.state, active: false, area: { ...h.state.area, areaChoice: "selection",
        area: { kind: "selectedArea" }, areaLabel: "Sampling box" } });
    assert.equal(contexts.at(-1).usesSamplingBox, true);
});

/** Observe writes to existing controls, including redundant assignments a fake DOM normally hides.
 * @param {FakeRasterControlDocument} document Fake owning document.
 * @return {Object[]} Mutable log of presentation writes.
 */
function observeControlWrites(document) {
    const writes = [], visited = new Set();
    const elements = [...document.elements.values()];
    while (elements.length) {
        const element = elements.pop();
        if (visited.has(element)) continue;
        visited.add(element); elements.push(...element.children);
        for (const property of ["textContent", "hidden", "disabled", "checked", "value"]) {
            let value = element[property];
            Object.defineProperty(element, property, { configurable: true, get: () => value,
                set: next => { writes.push({ element, property, value: next }); value = next; } });
        }
        for (const method of ["setAttribute", "replaceChildren"]) {
            const original = element[method].bind(element);
            element[method] = (...args) => { writes.push({ element, property: method }); return original(...args); };
        }
        const toggle = element.classList.toggle;
        element.classList.toggle = (...args) => { writes.push({ element, property: "classList.toggle" }); return toggle(...args); };
    }
    return writes;
}

test("unchanged area snapshots perform no control writes; progress changes only its displayed text", () => {
    const h = controlsFixture(); h.draw();
    const writes = observeControlWrites(h.document);
    for (let i = 0; i < 25; i++) h.draw();
    assert.deepEqual(writes, []);
    h.state.message = "1 of 25 complete"; h.draw();
    assert.deepEqual(writes, [{ element: h.view.status, property: "textContent", value: "1 of 25 complete" }]);
});

test("changed controls remain current without overwriting a focused formula edit", () => {
    const h = controlsFixture(); h.draw();
    const row = h.view.formulaRows.children[0];
    const inputs = row.querySelectorAll("input");
    const expression = inputs.find(input => input.dataset.field === "expression");
    expression.value = "mean(a) + "; expression.focus();
    Object.assign(h.state.statistics[0], { label: "Average", visible: false, plotId: 2 });
    h.state.plots.push({ id: 2, scale: "log" });
    h.state.sources[0].label = "Renamed raster";
    h.state.busy = false; h.state.canDownload = true;
    h.state.area.recoverable = true;
    h.draw();
    assert.equal(expression.value, "mean(a) + ");
    assert.equal(h.document.activeElement, expression);
    assert.equal(inputs.find(input => input.dataset.field === "label").value, "Average");
    assert.equal(inputs[0].checked, false);
    assert.equal(inputs[0].getAttribute("aria-label"), "Show Average on plot");
    assert.equal(row.querySelector("select").value, "2");
    assert.equal(row.querySelector("select").getAttribute("aria-label"), "Plot for Average");
    assert.equal(h.view.sources.children[0].children[0].children[1].textContent, "Renamed raster");
    assert.equal(h.view.root.getAttribute("aria-busy"), "false");
    assert.equal(h.view.download.disabled, false);
    assert.equal(h.document.querySelector("#raster-series-retry").hidden, true);
    assert.equal(h.document.querySelector("#raster-series-cancel").hidden, false);
    assert.equal(h.document.querySelector("#raster-series-recover").hidden, false);
    h.document.activeElement = null; h.draw();
    assert.equal(expression.value, "mean(a)", "unfocused inputs reflect the supplied state");
});

test("retry is available only for failed work, not ordinary pending inputs", () => {
    const h = controlsFixture();
    h.state.busy = false;
    h.draw();
    const calculate = h.document.querySelector("#raster-series-retry");
    assert.equal(calculate.hidden, true);
    h.draw();
    assert.equal(calculate.hidden, true);
    h.state.area.hasErrors = true; h.draw();
    assert.equal(calculate.hidden, false);
    h.state.busy = true; h.draw();
    assert.equal(calculate.hidden, true, "running work is controlled by Cancel");
});

test("one raster opens the existing values table for every statistic instead of drawing a chart", () => {
    const h = controlsFixture();
    h.state.rows = [{label:"Raster A",statisticLabel:"Pixel value",state:"value",value:3,rawValue:"3"},
        {label:"Raster A",statisticLabel:"Mean",state:"value",value:2.5,rawValue:"2.5000000000000001",unit:"K"}];
    h.draw();
    assert.equal(h.plots.length,0);
    assert.equal(h.view.chartToolbar.hidden,true,"a scalar result needs no chart geometry controls");
    assert.equal(h.view.values.open,true);
    assert.equal(h.view.root.classList.contains("raster-series-single-result"),true);
    assert.deepEqual(h.view.table.children.map(row=>row.children.map(cell=>cell.textContent)),[
        ["Raster A","Pixel value","3","Value"],["Raster A","Mean","2.5000000000000001 K","Value"]]);
    assert.equal(h.view.valueCaption.textContent,"Raster A");
});

test("result presentation counts requested positions, including waiting, failed and NoData values", () => {
    const h = controlsFixture();
    const rows = h.state.statistics[0].rows;
    h.state.rows = rows;
    h.draw();
    assert.equal(h.view.values.open, true, "one pending position already uses the table");
    assert.equal(h.view.results.hidden, true, "setup and progress replace the empty result card");
    assert.equal(h.view.plots.hidden, true);
    assert.equal(h.view.addPlot.hidden, true);
    for (const [state, status] of [["error", "Unavailable"], ["no_valid_data", "No valid data"]]) {
        rows[0].state = state; h.draw();
        assert.equal(h.view.table.children[0].children[3].textContent, status);
        assert.equal(h.view.results.hidden, false, "completed nonnumeric outcomes remain inspectable");
        assert.equal(h.view.plots.hidden, true);
        assert.equal(h.plots.length, 0);
    }
    rows.push({...rows[0], label: "Raster B", state: "value", value: 4, rawValue: "4"});
    h.draw();
    assert.equal(h.view.values.open, false);
    assert.equal(h.plots.length, 1, "one successful value among several positions remains a graph");
    assert.equal(h.plots[0], h.state);
    assert.equal(h.view.plots.hidden, false);
    assert.equal(h.view.addPlot.hidden, false);
    h.view.values.open = true; h.view.values.dispatchEvent(new Event("toggle"));
    assert.equal(h.view.table.children.length, 2);
    assert.equal(h.view.valueCaption.textContent, "");
    assert.equal(h.view.root.classList.contains("raster-series-single-result"), false);
    h.view.values.open = false; h.view.values.dispatchEvent(new Event("toggle"));
    rows.length = 0; h.draw();
    assert.equal(h.view.values.open, false, "zero positions do not masquerade as a scalar");
    assert.equal(h.view.results.hidden, true);
    assert.equal(h.view.plots.hidden, true, "the retained old plot does not show for empty input");
});

test("previous numerical results remain visible while their replacements are pending", () => {
    const h = controlsFixture();
    h.state.statistics[0].rows.push({...h.state.rows[0], label: "Raster B"});
    h.state.statistics[0].previousRows = h.state.rows.map(row => ({...row, state: "value", value: 2, rawValue: "2"}));
    h.state.showingPrevious = true;
    h.draw();
    assert.equal(h.view.results.hidden, false);
    assert.equal(h.view.plots.hidden, false);
    assert.equal(h.view.chartNote.hidden, false);
    assert.equal(h.plots.at(-1), h.state);
    h.state.showingPrevious = false;
    h.state.busy = false;
    for (const row of h.state.rows) row.state = "no_valid_data";
    h.draw();
    assert.equal(h.view.results.hidden, false);
    assert.equal(h.view.plots.hidden, true, "NoData outcomes keep the table without an empty graph");
});

test("one temporal observation uses values; several timestamps in the same dataset use plots", () => {
    const h = controlsFixture();
    h.view.renderTemporalControls = () => {};
    h.state.sources = [];
    h.state.temporal = {item: {properties: {title: "Temperature", "cube:variables": {temperature: {description: "Air temperature",unit:"K"}}}}, variable: "temperature",
        periodMode: "times", startTime: "2000-01-01T00:00", endTime: "2000-01-01T02:00"};
    const rows = h.state.statistics[0].rows;
    rows.length = 0; h.draw();
    assert.equal(h.view.values.open, false, "pending temporal results have an unknown observation count");
    const row = {label: "2000-01-01 00:00 UTC", statisticLabel: "Mean", state: "value",
        value: 280.5, rawValue: "280.5", unit: "K"};
    rows.push(row); h.state.rows = rows; h.draw();
    assert.equal(h.view.values.open, true);
    assert.equal(h.view.valueCaption.textContent, row.label);
    assert.deepEqual(h.view.table.children[0].children.map(cell => cell.textContent),
        [row.label, "Mean", "280.5 K", "Value"]);
    rows.push({...row, label: "2000-01-01 01:00 UTC", state: "no_valid_data", value: null, rawValue: null});
    h.draw();
    assert.equal(h.view.values.open, false);
    assert.equal(h.plots.at(-1), h.state);
    h.view.values.open = true; h.view.values.dispatchEvent(new Event("toggle"));
    assert.equal(h.view.table.children.length, 2);
});

test("closed values create no table rows and opening shows the latest results", () => {
    const h = controlsFixture();
    const rows = Array.from({length: 1000}, (_, index) => ({label: `Observation ${index}`,
        statisticLabel: "Mean", state: "value", value: index, rawValue: String(index), unit: "K"}));
    h.state.rows = rows; h.state.statistics[0].rows = rows;
    h.state.canDownload = true;
    h.draw();
    assert.equal(h.view.values.open, false);
    assert.equal(h.view.table.children.length, 0);
    assert.equal(h.view.download.disabled, false, "downloads do not depend on opening the table");
    rows.at(-1).rawValue = "999.125"; rows.at(-1).value = 999.125;
    h.draw();
    assert.equal(h.view.table.children.length, 0, "closed updates leave all values in the owner snapshot");
    h.view.values.open = true; h.view.values.dispatchEvent(new Event("toggle"));
    assert.equal(h.view.table.children.length, rows.length);
    assert.deepEqual(h.view.table.children.at(-1).children.map(cell => cell.textContent),
        ["Observation 999", "Mean", "999.125 K", "Value"]);
    const firstRow = h.view.table.children[0];
    h.view.values.dispatchEvent(new Event("toggle"));
    assert.equal(h.view.table.children[0], firstRow, "unchanged opening events retain table nodes");
    h.state.active = false; h.view.render(h.state);
    rows.at(-1).rawValue = "1000";
    h.view.values.dispatchEvent(new Event("toggle"));
    assert.equal(h.view.table.children[0], firstRow, "a queued disclosure event does not draw after closing the panel");
});

test("the first temporal calculation opens a prominent plot progress area with measured work", () => {
    const h = controlsFixture();
    h.view.renderTemporalControls = () => {};
    h.state.temporal = {periodMode: "month", startTime: "2000-01-01T00:00", endTime: "2000-02-01T00:00"};
    h.state.area.area = {kind: "wholeRaster"};
    h.state.statistics[0].rows = []; h.state.rows = [];
    h.state.message = "Preparing calculation…";
    h.draw();
    assert.equal(h.view.results.hidden, false, "the result area opens before any values arrive");
    assert.equal(h.view.plotProgress.hidden, false);
    assert.equal(h.view.status.hidden, true, "progress has one prominent presentation");
    assert.equal(h.view.chartToolbar.hidden, false);
    assert.equal(h.view.plotProgressBar.getAttribute("value"), null, "preparation has no invented percentage");
    h.state.temporal.selectionError = "Enter a valid period."; h.draw();
    assert.equal(h.view.plotProgress.hidden, true, "incomplete inputs do not flash a calculation indicator");
    h.state.temporal.selectionError = "";
    h.state.workProgress = {completed: 2, total: 8, unit: "blocks"};
    h.state.message = "Summarizing each observation · 2 of 8 blocks";
    h.draw();
    assert.equal(h.view.plotProgressDetail.textContent, "Summarizing each observation · 2 of 8 blocks · 6 remaining");
    assert.equal(h.view.plotProgressBar.getAttribute("max"), "8");
    assert.equal(h.view.plotProgressBar.getAttribute("value"), "2");
    h.state.busy = false; h.state.message = "Calculation cancelled."; h.draw();
    assert.equal(h.view.results.hidden, true);
    assert.equal(h.view.plotProgress.hidden, true);
    assert.equal(h.view.status.hidden, false);
    h.state.busy = true; h.state.workProgress = null; h.state.message = "Preparing calculation…"; h.draw();
    assert.equal(h.view.plotProgressBar.getAttribute("value"), null, "replacement work does not inherit an old counter");
    h.state.busy = false;
    const row = {label: "2000-01-01 00:00 UTC", statisticLabel: "Mean", state: "value", value: 280, rawValue: "280"};
    h.state.statistics[0].rows = [row]; h.state.rows = [row]; h.draw();
    assert.equal(h.view.plotProgress.hidden, true);
    assert.equal(h.view.results.hidden, false);
    assert.equal(h.view.values.open, true, "one returned observation uses the existing scalar presentation");
});

test("progress preserves the values disclosure and focus; changing result count restores the presentation", () => {
    const h = controlsFixture(); h.draw();
    const row = h.state.statistics[0].rows[0];
    h.view.values.open = false;
    h.view.download.focus();
    h.state.message = "Calculating"; h.draw();
    assert.equal(h.view.values.open, false, "do not reopen a disclosure the user closed");
    assert.equal(h.document.activeElement, h.view.download);
    h.state.statistics[0].rows.push({...row, label: "Raster B"}); h.draw();
    h.view.values.open = true; h.draw();
    assert.equal(h.view.values.open, true, "multi-result table also retains the user's choice");
    h.state.statistics[0].rows.pop(); h.draw();
    assert.equal(h.view.values.open, true);
    assert.equal(h.plots.length, 0, "pending and single-result updates never create an empty plot");
    h.state.showingPrevious = true; h.draw();
    assert.equal(h.view.chartNote.hidden, true, "the current-values table does not claim to show previous-area plots");
});

test("compact rows retain focused drafts and editor disclosures when other statistics change", () => {
    const h = controlsFixture(); h.draw();
    const row = h.view.formulaRows.children[0], editor = row.querySelector("details");
    assert.equal(editor.open, false, "preset editors start collapsed");
    editor.open = true;
    const expression = row.querySelectorAll("input").find(input => input.dataset.field === "expression");
    expression.value = "mean(a) + "; expression.focus();
    const custom = { ...h.state.statistics[0], id: 2, label: "Custom", expression: "", styleIndex: 1 };
    h.state.statistics.push(custom); h.state.area.formulas = h.state.statistics;
    h.draw();
    assert.equal(h.view.formulaRows.children[0], row);
    assert.equal(h.document.activeElement, expression);
    assert.equal(expression.value, "mean(a) + ");
    assert.equal(editor.open, true);
    assert.equal(h.view.formulaRows.children[1].querySelector("details").open, true, "blank custom formulas expose their editor");
    assert.equal(row.querySelector("button").disabled, false);
    h.state.statistics.pop(); h.draw();
    assert.equal(h.view.formulaRows.children[0], row);
    assert.equal(expression.value, "mean(a) + ");
    assert.equal(editor.open, true);
    assert.equal(row.querySelector("button").disabled, true, "the remaining statistic cannot be removed");
    assert.equal(h.view.formulaNodes.size, 1, "removed rows are released");
});

test("removing a focused statistic returns focus to Add statistic", () => {
    const h = controlsFixture();
    h.state.area.formulas = h.state.statistics;
    h.state.statistics.push({ ...h.state.statistics[0], id: 2, styleIndex: 1 });
    h.draw();
    h.view.formulaRows.children[1].querySelector("button").focus();
    h.state.statistics.pop(); h.draw();
    assert.equal(h.document.activeElement, h.document.querySelector("#raster-series-add-formula"));
});

test("the selected area name opens the existing sample control", () => {
    const h = controlsFixture();
    h.document.querySelector("#raster-series-order").value = "name";
    h.document.querySelector("#raster-series-direction").value = "reverse";
    h.state.chartType = "scatter";
    h.state.sources.push({ key: "b", label: "Raster B", selected: false });
    h.draw();
    h.state.sources[1].selected = true;
    h.state.area.areaChoice = "selection"; h.state.area.areaLabel = "Watershed polygons";
    h.draw();
    h.state.chartType = "bar";
    h.draw();
    for (const [area, label] of [[null, "No area selected"], [{kind: "selectedArea"}, "Sampling box"],
        [{kind: "catalogSelection"}, "Selected polygons"], [{kind: "polygonArea"}, "Selected polygons"]]) {
        h.state.area.area = area; h.draw();
        assert.equal(h.document.querySelector("#raster-series-area-summary").textContent, "Watershed polygons");
        assert.equal(h.document.querySelector("#raster-series-open-area").getAttribute("aria-label"), "Change sample area: Watershed polygons");
    }
});

test("graph context identifies its rasters, variable, period and area independently of Inputs", () => {
    const h = controlsFixture();
    h.view.period = {render() {}};
    const title = h.document.querySelector("#raster-series-plot-title");
    const context = h.document.querySelector("#raster-series-plot-context");
    h.state.statistics[0].rows = h.state.rows = [1, 2].map(value => ({label: `Raster ${value}`, state: "value", value}));
    h.draw();
    assert.equal(h.view.plotHeading.hidden, false);
    assert.equal(title.textContent, "Raster A");
    assert.equal(context.textContent, "Whole raster");
    h.document.querySelector("#raster-series-inputs").hidden = true;
    h.state.sources.push({key: "b", label: "Raster B", selected: true});
    h.state.area.areaChoice = "vector"; h.state.area.areaLabel = "Selected county polygons";
    h.draw();
    assert.equal(title.textContent, "Raster comparison");
    assert.equal(context.textContent, "Selected county polygons");
    h.state.temporal = {item: {properties: {title: "Weather observations", "cube:variables": {
        pressure: {description: "Surface pressure"}}}}, variable: "pressure", variableBound: true,
        periodMode: "month", startTime: "2000-01-01T00:00", endTime: "2000-02-01T00:00", selectionError: ""};
    h.draw();
    assert.equal(title.textContent, "Surface pressure");
    assert.match(context.textContent, /^Weather observations · Selected county polygons · January 2000/);
    const originalContext = context.textContent;
    h.state.showingPrevious = true;
    h.state.statistics[0].previousRows = h.state.rows;
    h.state.area.areaLabel = "A different county";
    h.state.temporal.startTime = "2000-02-01T00:00"; h.state.temporal.endTime = "2000-03-01T00:00";
    h.draw();
    assert.equal(context.textContent, originalContext, "retained results must not be labelled with replacement inputs");
    h.state.showingPrevious = false; h.draw();
    assert.match(context.textContent, /A different county · February 2000/);
});

test("temporal controls reuse the period editor and preserve focused input while availability changes", () => {
    const h = controlsFixture();
    const actions = Object.fromEntries(["onClose", "onSelect", "onOrder", "onChartType", "onDownload", "onArea", "onOpenArea",
        "onEditArea", "onAddFormula", "onEditFormula", "onRemoveFormula", "onStatisticDisplay", "onAddPlot",
        "onRemovePlot", "onPlotOptions", "onRetry", "onCancel", "onRecover", "onTimeRange",
        "onTemporalVariable"].map(key => [key, () => assert.fail(key)]));
    actions.onTemporalEdit = change => { Object.assign(h.state.temporal, change); h.draw(); };
    actions.onTimeRange = key => {
        assert.equal(key, null);
        h.state.temporal = null; h.state.sources[1].rangeSelected = false; h.draw();
    };
    h.view.bind(actions);
    h.view.plotsView = {renderPlots() {}};
    const inputBody = h.document.querySelector("#raster-series-inputs");
    const inputToggle = h.document.querySelector("#raster-series-toggle-inputs");
    inputToggle.focus(); h.view.root.scrollTop = 300;
    inputToggle.dispatchEvent(new Event("click"));
    assert.equal(inputBody.hidden, true);
    assert.equal(inputToggle.getAttribute("aria-expanded"), "false");
    assert.equal(inputToggle.textContent, "Inputs · Show");
    assert.equal(h.view.root.scrollTop, 0, "collapsing reveals the graph rather than leaving the panel scrolled below it");
    h.draw();
    assert.equal(inputBody.hidden, true, "result updates preserve the user's disclosure choice");
    assert.equal(h.document.activeElement, inputToggle);
    inputToggle.dispatchEvent(new Event("click"));
    assert.equal(inputBody.hidden, false);
    assert.equal(inputToggle.getAttribute("aria-expanded"), "true");
    assert.equal(inputToggle.textContent, "Inputs · Hide");
    h.state.busy = false;
    h.state.area.area = {kind: "wholeRaster"};
    h.state.temporal = {datasets: [{key: "observations", label: "Weather observations"}], datasetKey: "observations",
        item: {properties: {title: "Weather observations", "cube:variables": {temperature: {
            description: "Air temperature", unit: "K", "eolab:time_support": "instantaneous"}}}},
        variable: "temperature", periodMode: "month", startTime: "2000-01-01T00:00", endTime: "2000-02-01T00:00",
        loading: false, selectionError: ""};
    h.state.sources = [h.state.sources[0], {key: "weather-view", label: "Weather · Jan 1, 2000 00:00 UTC",
        selected: true, temporalDatasetKey: "observations", rangeSelected: true}];
    h.draw();
    /** @return {Object[]} Current individual-raster and time-range controls. */
    const inputs = () => h.view.sources.querySelectorAll("input");
    assert.equal(inputs()[0].disabled, true, "ordinary rasters are disabled during time-range analysis");
    assert.equal(inputs()[1].disabled, true, "temporal snapshots are disabled too");
    assert.equal(inputs()[1].checked, true, "the ordinary checklist retains its selections");
    assert.equal(inputs()[2].disabled, false);
    assert.equal(inputs()[1].parentElement.title, "Turn off time-range analysis to select individual rasters.");
    assert.equal(inputs()[1].getAttribute("aria-describedby"), "raster-series-source-help");
    assert.match([...h.view.sources.children].find(node => node.id === "raster-series-source-help").textContent, /Turn off time-range analysis/);
    const field = id => h.document.querySelector("#raster-series-" + id);
    assert.notEqual(field("data-settings").open, true, "choosing a temporal source does not open optional chart settings");
    assert.equal(field("order").parentElement.hidden, true);
    assert.equal(field("value-source").textContent, "Time (UTC)");
    assert.equal(field("temporal-variable").children[1].textContent, "Air temperature (K)");
    assert.equal(h.view.period.periodMode.value, "month");
    h.view.period.periodMode.value = "times";
    h.view.period.periodMode.dispatchEvent(new Event("change"));
    h.view.period.startTime.focus();
    h.view.period.startTime.value = "03:15";
    h.view.period.startTime.dispatchEvent(new Event("input"));
    assert.equal(h.state.temporal.startTime, "2000-01-01T03:15");
    h.state.temporal.loading = true; h.draw();
    assert.equal(h.document.activeElement, h.view.period.startTime);
    assert.equal(h.view.period.startTime.value, "03:15");
    assert.equal(h.view.period.startTime.step, "any");
    inputs()[2].focus(); inputs()[2].checked = false; inputs()[2].dispatchEvent(new Event("change"));
    assert.equal(inputs()[0].disabled, false);
    assert.equal(inputs()[1].disabled, false);
    assert.equal(inputs()[1].checked, true);
    assert.equal(h.document.activeElement, inputs()[2], "focus stays on the range toggle when it is turned off");
    assert.equal(field("temporal").hidden, true);
    assert.equal(field("order").parentElement.hidden, false);
    assert.equal(field("sources").hidden, false);
    assert.equal(field("value-source").textContent, "Raster");
});

test("compact statistic controls send stable identities through the existing owner callbacks", () => {
    const h = controlsFixture(), events = [];
    h.view.actions = {
        onStatisticDisplay: (...args) => events.push(["display", ...args]),
        onEditFormula: (...args) => events.push(["edit", ...args]),
        onRemoveFormula: id => events.push(["remove", id]),
    };
    h.draw();
    const row = h.view.formulaRows.children[0];
    const inputs = row.querySelectorAll("input");
    const visible = inputs.find(input => input.dataset.field === "visible");
    visible.checked = false; visible.dispatchEvent(new Event("change"));
    const name = inputs.find(input => input.dataset.field === "label");
    name.value = "Average"; name.dispatchEvent(new Event("input"));
    const expression = inputs.find(input => input.dataset.field === "expression");
    expression.value = "mean(a) + 1"; expression.dispatchEvent(new Event("input"));
    const color = inputs.find(input => input.dataset.field === "color");
    color.value = "#ff0000"; color.dispatchEvent(new Event("input"));
    const plot = row.querySelector("select"); plot.value = "2"; plot.dispatchEvent(new Event("change"));
    assert.deepEqual(events, [["display", 1, { visible: false }], ["edit", 1, { label: "Average" }],
        ["edit", 1, { expression: "mean(a) + 1" }], ["display", 1, {color: "#ff0000"}], ["display", 1, { plotId: 2 }]]);
});

test("results return immediately and a burst draws only its latest snapshot", () => {
    const h = fixture(), drawn = [];
    h.view.draw = state => drawn.push(state);
    for (let i = 0; i < 25; i++) h.view.render({ active: true, completed: i + 1, sources: [], area: {} });
    assert.equal(drawn.length, 0, "receiving results never calls drawing synchronously");
    assert.equal(h.frames.size, 1);
    h.frame();
    assert.deepEqual(drawn, [{ active: true, completed: 25, sources: [], area: {} }]);
    assert.equal(h.frames.size, 0);
});

test("updates during drawing schedule one subsequent frame with the latest state", () => {
    const h = fixture(), drawn = [];
    h.view.draw = state => {
        drawn.push(state.completed);
        if (state.completed === 1) {
            h.view.render({ active: true, completed: 2, sources: [], area: {} });
            h.view.render({ active: true, completed: 3, sources: [], area: {} });
        }
    };
    h.view.render({ active: true, completed: 1, sources: [], area: {} });
    h.frame();
    assert.deepEqual(drawn, [1]);
    assert.equal(h.frames.size, 1);
    h.frame();
    assert.deepEqual(drawn, [1, 3]);
});

test("closing cancels drawing; reopening draws current inputs rather than an old area", () => {
    const h = fixture(), drawn = [];
    h.view.draw = state => drawn.push(state.area.areaLabel);
    h.view.render({ active: true, sources: [], area: { areaLabel: "old" } });
    h.view.render({ active: false, sources: [], area: { areaLabel: "old" } });
    assert.equal(h.frames.size, 0);
    h.view.render({ active: false, sources: [], area: { areaLabel: "new" } });
    h.frame();
    assert.deepEqual(drawn, []);
    h.view.render({ active: true, sources: [], area: { areaLabel: "new" } });
    h.frame();
    assert.deepEqual(drawn, ["new"]);
});

test("plot signatures ignore progress and catalog metadata, but retain display changes", () => {
    const h = fixture(), calls = [];
    const view = new RasterSeriesPlotsView(h.document, {});
    view.cards.set(1, view.createPlotCard({id:1,scale:"linear"}));
    view.renderPlot = (...args) => calls.push(args);
    const row = { label: "Raster", state: "value", value: 2, rawValue: "2.000", unit: "ha",
        item: { toJSON() { throw Error("Catalog metadata must never be serialized for drawing"); } } };
    const statistic = { id: 1, label: "Mean", expression: "mean(a)", styleIndex: 0, visible: true, plotId: 1, rows: [row] };
    const state = { plots: [{ id: 1, scale: "linear" }], statistics: [statistic], chartType: "line", showingPrevious: false };
    view.renderPlots(state);
    row.errorMessage = "Progress changed";
    view.renderPlots(state);
    assert.equal(calls.length, 1);
    row.value = 3; row.rawValue = "3.000";
    view.renderPlots(state);
    statistic.label = "Average";
    view.renderPlots(state);
    state.plots[0].scale = "log";
    view.renderPlots(state);
    state.showingPrevious = true; statistic.previousRows = [{ ...row, value: 4 }];
    view.renderPlots(state);
    statistic.visible = false;
    view.renderPlots(state);
    assert.equal(calls.length, 6);
});

test("temporal plots use actual UTC spacing and retain NoData gaps through presentation changes", () => {
    const h = controlsFixture();
    const view = new RasterSeriesPlotsView(h.document, {});
    const rows = [0, 1, 2, 6].map(hour => ({
        label: `1 Jan 2000 ${String(hour).padStart(2, "0")}:00 UTC`,
        xValue: Date.UTC(2000, 0, 1, hour), state: hour === 2 ? "no_valid_data" : "value",
        value: hour === 2 ? null : hour + 1, rawValue: hour === 2 ? null : `${hour + 1}.0000000000000001`, unit: "K",
    }));
    const state = { plots: [{ id: 1, scale: "linear" }], chartType: "line", temporal: {}, showingPrevious: false,
        statistics: [{ id: 1, label: "Mean", expression: "mean(a)", styleIndex: 0, visible: true, plotId: 1, rows }] };
    view.renderPlots(state);
    const chart = view.cards.get(1).chart;
    assert.equal(view.cards.get(1).title.parentElement.hidden, true, "one plot needs no numbered title above its legend");
    assert.equal(view.cards.get(1).legend.hidden, false, "even one statistic has a color and marker legend");
    assert.equal(view.cards.get(1).legend.children[0].querySelector("span").textContent, "Mean");
    const points = chart.querySelectorAll(".series-chart-point");
    const x = points.map(point => Number(point.getAttribute("cx")));
    assert.deepEqual(points.map(point => point.getAttribute("data-point-index")), ["0", "1", "3"]);
    assert.ok(Math.abs((x[1] - x[0]) / (x[2] - x[0]) - 1 / 6) < 1e-12);
    assert.equal(chart.querySelector(".series-chart-line").getAttribute("d").split("M").length - 1, 2,
        "the unavailable observation breaks the line rather than becoming zero");
    assert.equal(chart.querySelector(".series-chart-axis-title").textContent, "Time (UTC)");
    const yTitle = chart.querySelectorAll(".series-chart-axis-title")[1];
    assert.equal(yTitle.textContent, "Value (K)");
    assert.equal(yTitle.getAttribute("transform"), null, "the Y label sits above the plot, matching histograms");
    assert.equal(yTitle.getAttribute("text-anchor"), "start");
    assert.equal(yTitle.getAttribute("y"), "15");
    assert.equal(yTitle.getAttribute("style"), "font-size: 12px");
    assert.equal(chart.querySelector(".series-chart-x-axis").querySelector("text").style.getPropertyValue("font-size"), "11px");
    chart.querySelector(".series-chart-line-hit").dispatchEvent(new Event("pointermove"));
    assert.equal(view.cards.get(1).tooltip.element.getAttribute("hidden"), "", "the line does not repeat the statistic name on hover");
    points[1].dispatchEvent(new Event("pointermove"));
    assert.equal(view.cards.get(1).tooltip.element.getAttribute("hidden"), null, "points retain their observation values");
    points[0].dispatchEvent(new Event("focus"));
    assert.match(view.cards.get(1).tooltip.element.textContent, /1\.0000000000000001 K/);
    const escape = new Event("keydown", {cancelable:true}); Object.defineProperty(escape, "key", {value:"Escape"});
    points[0].dispatchEvent(escape);
    assert.equal(view.cards.get(1).tooltip.element.getAttribute("hidden"), "");
    assert.equal(escape.defaultPrevented, true, "inspection owns its first Escape");
    assert.match(points[1].getAttribute("aria-label"), /1 Jan 2000 01:00 UTC/);
    assert.match(points[1].getAttribute("aria-label"), /2\.0000000000000001 K/);
    state.chartType = "scatter";
    view.renderPlots(state);
    assert.deepEqual(chart.querySelectorAll(".series-chart-point").map(point => Number(point.getAttribute("cx"))), x);
    assert.equal(chart.querySelector(".series-chart-line"), null);
    state.chartType = "bar";
    view.renderPlots(state);
    const bars = chart.querySelectorAll(".series-chart-bar");
    const barX = bars.map(point => Number(point.getAttribute("cx")));
    assert.equal(bars.length, 3);
    assert.ok(Math.abs((barX[1] - barX[0]) / (barX[2] - barX[0]) - 1 / 6) < 1e-12);
    assert.match(bars[1].getAttribute("aria-label"), /2\.0000000000000001 K/);
    state.plots[0].scale = "log";
    view.renderPlots(state);
    assert.match(view.cards.get(1).note.textContent, /Bars start at the displayed axis bound/);
    state.chartType = "scatter";
    state.temporal = null;
    view.renderPlots(state);
    assert.equal(chart.querySelector(".series-chart-axis-title").textContent, "Raster");
    const ordinalX = chart.querySelectorAll(".series-chart-point").map(point => Number(point.getAttribute("cx")));
    assert.ok(Math.abs((ordinalX[1] - ordinalX[0]) / (ordinalX[2] - ordinalX[0]) - 1 / 3) < 1e-12);
});

test("axis editors redraw retained observations and preserve the valid plot during incomplete edits", () => {
    const h = fixture();
    const rows = [0,1,6].map(hour => ({label: `${hour}:00 UTC`, xValue: Date.UTC(2000,0,1,hour),
        state:"value",value:hour+1,rawValue:String(hour+1),unit:"K"}));
    const state = {plots:[{id:1,scale:"linear",bounds:null,xBounds:null}],chartType:"bar",temporal:{},showingPrevious:false,
        statistics:[{id:1,label:"Mean",expression:"mean(a)",styleIndex:0,visible:true,plotId:1,rows}]};
    const original = JSON.stringify(rows), changes = [];
    const view = new RasterSeriesPlotsView(h.document, {onPlotOptions(id, change) {
        changes.push(change); Object.assign(state.plots[0],change); view.renderPlots(state);
    }});
    view.renderPlots(state);
    const controls = view.cards.get(1), y = controls.axes.y, x = controls.axes.x;
    for (const [name, value] of [["pointSize", 3], ["xTickCount", 3], ["yTickCount", 7], ["axisFontSize", 14]]) {
        controls.appearance[name].value = String(value); controls.appearance[name].dispatchEvent(new Event("input"));
        assert.equal(state.plots[0][name], value);
    }
    state.chartType = "scatter"; view.renderPlots(state);
    assert.equal(controls.chart.querySelector(".series-chart-point").getAttribute("r"), "1.5");
    assert.equal(controls.chart.querySelector(".series-chart-axis-title").getAttribute("style"), "font-size: 15px");
    assert.equal(controls.chart.querySelector(".series-chart-x-axis").querySelector("text").style.getPropertyValue("font-size"), "14px");
    state.statistics[0].color = "#ff0000"; view.renderPlots(state);
    assert.match(controls.chart.querySelectorAll("g").find(node => node.getAttribute("data-series-id") === "1").getAttribute("style"), /#ff0000/);
    state.chartType = "bar"; view.renderPlots(state);
    y.range.value="custom"; y.range.dispatchEvent(new Event("change"));
    y.fields[0].value="1"; y.fields[0].dispatchEvent(new Event("input"));
    y.fields[1].value="8"; y.fields[1].dispatchEvent(new Event("input"));
    assert.deepEqual(state.plots[0].bounds,[1,8]);
    const beforeInvalid = controls.signature;
    y.fields[0].value="9"; y.fields[0].dispatchEvent(new Event("input"));
    assert.equal(controls.error.hidden,false); assert.equal(controls.signature,beforeInvalid);
    y.fields[0].value="1"; y.fields[0].dispatchEvent(new Event("input"));
    controls.scale.value="log"; controls.scale.dispatchEvent(new Event("change"));
    assert.equal(state.plots[0].scale,"log");
    x.range.value="custom"; x.range.dispatchEvent(new Event("change"));
    x.fields[0].value="2000-01-01 00:30"; x.fields[0].dispatchEvent(new Event("input"));
    x.fields[1].value="2000-01-01 03:00"; x.fields[1].dispatchEvent(new Event("input"));
    assert.deepEqual(state.plots[0].xBounds,[Date.UTC(2000,0,1,0,30),Date.UTC(2000,0,1,3)]);
    assert.equal(controls.chart.querySelectorAll("rect").filter(node=>node.getAttribute("data-point-index")!==null).length,1);
    assert.equal(JSON.stringify(rows),original,"display bounds never remove observations from the result contract");
    assert.ok(changes.length>0); assert.equal(controls.error.hidden,true);
    const temporalBounds = state.plots[0].xBounds;
    state.temporal=null; view.renderPlots(state);
    y.fields[1].value="9"; y.fields[1].dispatchEvent(new Event("input"));
    assert.deepEqual(state.plots[0].xBounds,temporalBounds,"editing Y for ordinary rasters preserves hidden temporal display bounds");
});

test("adding a secondary plot reveals it once; initial drawing and updates preserve scroll and focus", () => {
    const h = fixture();
    const view = new RasterSeriesPlotsView(h.document, {});
    const state = { plots: [{ id: 1, scale: "linear" }], statistics: [], chartType: "line", showingPrevious: false };
    view.renderPlots(state);
    assert.deepEqual(view.cards.get(1).card.scrollRequests, []);
    state.plots.push({ id: 2, scale: "linear" });
    view.renderPlots(state);
    const added = view.cards.get(2);
    assert.equal(view.cards.get(1).title.parentElement.hidden, false);
    assert.equal(added.title.parentElement.hidden, false);
    assert.equal(added.empty.textContent, "Choose this plot beside a statistic to show it here.");
    assert.deepEqual(added.card.scrollRequests, [{ block: "start", inline: "nearest" }]);
    added.scale.focus();
    view.renderPlots(state);
    state.plots[1].scale = "log";
    view.renderPlots(state);
    state.showingPrevious = true;
    view.renderPlots(state);
    assert.equal(added.card.scrollRequests.length, 1);
    assert.equal(h.document.activeElement, added.scale);
    assert.equal(view.cards.get(1).scale.value, "linear");
    assert.equal(added.scale.value, "log");
});
