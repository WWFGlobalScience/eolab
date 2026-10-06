import test from "node:test";
import assert from "node:assert/strict";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { RasterSeriesView } from "../../src/raster/series-view.js";
import { RasterSeriesPlotsView } from "../../src/raster/series-plots-view.js";

/** Create a real view with a manually advanced browser frame clock.
 * @return {Object} View, fake document and pending frame callbacks.
 */
function fixture() {
    const document = new FakeRasterControlDocument();
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
    h.view.plotsView = { renderPlots: state => plots.push(state) };
    h.view.actions = {};
    const source = { key: "a", label: "Raster A", selected: true };
    const formula = { id: 1, label: "Mean", expression: "mean(a)", visible: true, plotId: 1, styleIndex: 0 };
    const state = { active: true, busy: true, sources: [source], rows: [], previousRows: null,
        showingPrevious: false, message: "Preparing", canDownload: false, chartType: "line",
        statistics: [formula], plots: [{ id: 1, scale: "linear" }],
        area: { formulas: [formula], sources: [source], results: new Map(), areaChoice: "whole",
            elapsedSeconds: null, complete: false, recoverable: false } };
    const draw = () => { h.view.render(state); h.frame(); };
    return { ...h, plots, state, draw };
}

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
    h.state.area.complete = true; h.state.area.recoverable = true;
    h.draw();
    assert.equal(expression.value, "mean(a) + ");
    assert.equal(h.document.activeElement, expression);
    assert.equal(inputs.find(input => input.dataset.field === "label").value, "Average");
    assert.equal(inputs[0].checked, false);
    assert.equal(inputs[0].getAttribute("aria-label"), "Show Average on plot");
    assert.equal(row.querySelector("select").value, "2");
    assert.equal(row.querySelector("select").getAttribute("aria-label"), "Plot for Average");
    assert.equal(h.view.sources.children[0].children[1].textContent, "Renamed raster");
    assert.equal(h.view.root.getAttribute("aria-busy"), "false");
    assert.equal(h.view.download.disabled, false);
    assert.equal(h.document.querySelector("#raster-series-calculate").hidden, true);
    assert.equal(h.document.querySelector("#raster-series-cancel").hidden, true);
    assert.equal(h.document.querySelector("#raster-series-recover").hidden, false);
    h.document.activeElement = null; h.draw();
    assert.equal(expression.value, "mean(a)", "unfocused inputs reflect the supplied state");
});

test("series renders each statistic through the same plots and values table", () => {
    const h = controlsFixture();
    h.state.rows = [{label:"Raster A",statisticLabel:"Pixel value",state:"value",value:3,rawValue:"3"},
        {label:"Raster A",statisticLabel:"Mean",state:"value",value:2.5,rawValue:"2.5"}];
    h.draw();
    assert.equal(h.plots.length,1);
    assert.equal(h.plots[0],h.state);
    assert.deepEqual(h.view.table.children.map(row=>row.children.map(cell=>cell.textContent)),[
        ["Raster A","Pixel value","3","Value"],["Raster A","Mean","2.5","Value"]]);
    assert.equal(h.view.context.textContent,"Whole extent of each raster");
});

test("results return immediately and a burst draws only its latest snapshot", () => {
    const h = fixture(), drawn = [];
    h.view.draw = state => drawn.push(state);
    for (let i = 0; i < 25; i++) h.view.render({ active: true, completed: i + 1 });
    assert.equal(drawn.length, 0, "receiving results never calls drawing synchronously");
    assert.equal(h.frames.size, 1);
    h.frame();
    assert.deepEqual(drawn, [{ active: true, completed: 25 }]);
    assert.equal(h.frames.size, 0);
});

test("updates during drawing schedule one subsequent frame with the latest state", () => {
    const h = fixture(), drawn = [];
    h.view.draw = state => {
        drawn.push(state.completed);
        if (state.completed === 1) {
            h.view.render({ active: true, completed: 2 });
            h.view.render({ active: true, completed: 3 });
        }
    };
    h.view.render({ active: true, completed: 1 });
    h.frame();
    assert.deepEqual(drawn, [1]);
    assert.equal(h.frames.size, 1);
    h.frame();
    assert.deepEqual(drawn, [1, 3]);
});

test("closing cancels drawing; reopening draws current inputs rather than an old area", () => {
    const h = fixture(), drawn = [];
    h.view.draw = state => drawn.push(state.area);
    h.view.render({ active: true, area: "old" });
    h.view.render({ active: false, area: "old" });
    assert.equal(h.frames.size, 0);
    h.view.render({ active: false, area: "new" });
    h.frame();
    assert.deepEqual(drawn, []);
    h.view.render({ active: true, area: "new" });
    h.frame();
    assert.deepEqual(drawn, ["new"]);
});

test("plot signatures ignore progress, diagnostics and catalog metadata, but retain display changes", () => {
    const h = fixture(), calls = [];
    const view = new RasterSeriesPlotsView(h.document, {});
    view.cards.set(1, { scale: {}, signature: null });
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

test("completed timing reports retain open details and are removed for a new calculation", () => {
    const h = fixture();
    const result = { job: { jobId: "a" }, elapsedSeconds: 1, performanceLines: ["A measured interval"] };
    const state = { busy: false, statistics: [], plots: [], area: { formulas: [], sources: [{ key: "a", label: "A" }],
        results: new Map([["a", result]]), areaChoice: "whole", elapsedSeconds: null } };
    h.view.renderAreaControls(state);
    const report = h.document.querySelector("#raster-series-performance").children[0];
    report.open = true;
    state.area.results.set("b", { ...result, job: { jobId: "b" } });
    h.view.renderAreaControls(state);
    const reports = h.document.querySelector("#raster-series-performance").children;
    assert.equal(reports.length, 2);
    assert.equal(reports[0], report);
    assert.equal(report.open, true);
    state.area.sources[0].label = "Renamed";
    h.view.renderAreaControls(state);
    assert.equal(report.children[0].textContent, "Renamed — 1.000 s");
    state.area.results = new Map();
    h.view.renderAreaControls(state);
    assert.equal(h.document.querySelector("#raster-series-performance").children.length, 0);
});
