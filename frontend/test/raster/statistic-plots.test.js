import test from "node:test";
import assert from "node:assert/strict";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { renderOrdinalSeriesChart } from "../../src/charts/series-chart.js";
import { RasterSeriesPlotsView } from "../../src/raster/series-plots-view.js";

/** Render aligned series through the shared production renderer.
 * @param {Array<Array<number|null>>} values Y values for each series.
 * @param {Object} [options={}] Rendering options.
 * @return {Object} Rendered elements and inspection callbacks.
 */
function render(values, options = {}) {
    const documentContext = new FakeRasterControlDocument();
    const chart = documentContext.querySelector("#chart");
    const inspections = [];
    const series = values.map((numbers, index) => ({ id: String(index), label: `Statistic ${index}`, color: "blue", dash: index ? "7 3" : "none",
        points: numbers.map((yValue, i) => ({ xLabel: `Raster ${i}`, yValue })) }));
    const result = renderOrdinalSeriesChart({ documentContext, chart, series,
        chartType: "line", xAxisLabel: "Raster", yAxisLabel: "Value", ariaLabel: "Statistics",
        pointAccessibleLabel: (point, item) => `${item.label}: ${point.yValue}`,
        pointTooltip: point => point.xLabel, onInspect: value => inspections.push(value), ...options });
    /** Read all SVG descendants, including series groups.
     * @param {Object} element Root node. @return {Object[]} Descendants.
     */
    const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
    return { ...result, chart, inspections, elements: descendants(chart) };
}

test("multiple statistics share axes and raster positions while missing values break lines", () => {
    const result = render([[0, null, 10], [10, 5, 0]]);
    assert.deepEqual(result.pointElements.map(({circle}) => Number(circle.getAttribute("cx"))), [72, 656, 72, 364, 656]);
    assert.deepEqual(result.pointElements.map(({circle}) => Number(circle.getAttribute("cy"))), [268, 20, 20, 144, 268]);
    const paths = result.elements.filter(element => element.getAttribute("class") === "series-chart-line");
    assert.equal(paths[0].getAttribute("d"), "M72,268ZM656,20Z");
    assert.equal(paths[1].getAttribute("d"), "M72,20L364,144L656,268");
    assert.equal(paths[1].getAttribute("stroke-dasharray"), "7 3");
});

test("logarithmic spacing retains ordinal gaps for zero, negative and missing values", () => {
    const result = render([[1, 0, 10, -3, 100, null]], {yScale:"log"});
    assert.deepEqual(result.pointElements.map(({circle}) => Number(circle.getAttribute("cy"))), [268, 144, 20]);
    const path = result.elements.find(element => element.getAttribute("class") === "series-chart-line").getAttribute("d");
    assert.equal(path.split("M").length, 4);
    assert.ok(!path.includes("L"));
    assert.throws(() => render([[0, -1]], {yScale:"log"}), /finite Y value/);
    for (const value of [Number.MIN_VALUE, Number.MAX_VALUE]) {
        const extreme = render([[value]], {yScale:"log"});
        assert.ok(extreme.elements.every(element => !/Infinity|NaN/.test(element.getAttribute("d") ?? element.textContent)));
    }
});

test("line and point details work on pointer and keyboard without native duplicate tooltips", () => {
    const result = render([[1, 2], [1, 2]]);
    const line = result.elements.find(element => element.getAttribute("class") === "series-chart-line-hit");
    line.dispatchEvent(new Event("focus"));
    assert.equal(result.inspections.at(-1).series.label, "Statistic 0");
    assert.equal(result.inspections.at(-1).point, null);
    line.dispatchEvent(new Event("blur"));
    const point = result.pointElements[0].circle;
    point.dispatchEvent(new Event("pointermove"));
    assert.equal(result.inspections.at(-1).index, 0);
    point.dispatchEvent(new Event("pointerleave"));
    assert.equal(result.inspections.at(-1), null);
    point.dispatchEvent(new Event("focus"));
    line.dispatchEvent(new Event("pointerenter"));
    assert.equal(result.inspections.at(-1).index, 0, "scrolling beneath a stationary pointer must not replace keyboard details");
    line.dispatchEvent(new Event("pointermove"));
    assert.equal(result.inspections.at(-1).point, null);
    line.dispatchEvent(new Event("pointerleave"));
    assert.equal(result.inspections.at(-1).index, 0, "leaving the line restores the focused point's details");
    assert.equal(point.children.length, 0, "custom inspection has no SVG title fallback");
    const description = RasterSeriesPlotsView.prototype.describePoint([
        {label:"Mean · mean(a)",points:[{xLabel:"Full raster name.tif",yValue:1,rawValue:"1.0000000001",unit:""}]},
        {label:"Area · areaha(a > 0)",points:[{xLabel:"Full raster name.tif",yValue:1,rawValue:"1",unit:"ha"}]},
    ],0,"linear",false);
    assert.equal(description, "Full raster name.tif\nMean · mean(a): 1.0000000001\nArea · areaha(a > 0): 1 ha");
});

test("scatter plots keep point inspection and reject misaligned series", () => {
    const result = render([[2, 3], [4, 5]], {chartType:"scatter"});
    assert.equal(result.pointElements.length,4);
    assert.ok(!result.elements.some(element => element.getAttribute("class") === "series-chart-line"));
    assert.throws(() => render([[1, 2]], {series:[{points:[{xLabel:"A",yValue:1}]},{points:[{xLabel:"B",yValue:1}]}]}), /contract/);
});
