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
