import assert from "node:assert/strict";
import test from "node:test";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { renderOrdinalSeriesChart } from "../../src/charts/series-chart.js";

/**
 * Render points through the production SVG chart contract.
 *
 * @param {Object[]} points Chart points.
 * @param {"ordinal"|"numeric"} xScale Horizontal scale mode.
 * @return {number[]} Rendered circle X coordinates.
 */
function renderedXCoordinates(points, xScale) {
  const documentContext = new FakeRasterControlDocument();
  const chart = documentContext.querySelector("#vector-time-series-chart");
  renderOrdinalSeriesChart({
    documentContext,
    chart,
    points,
    chartType: "scatter",
    xScale,
    xAxisLabel: "Feature",
    yAxisLabel: "Value",
    ariaLabel: "Test chart",
    pointAccessibleLabel: (point) => point.xLabel,
    pointTooltip: (point) => point.xLabel,
  });
  return chart.children
    .filter((element) =>
      element.getAttribute("class") === "series-chart-point"
    )
    .map((element) => Number(element.getAttribute("cx")));
}

test("ordinal observations span the chart even when labels repeat", () => {
  const positions = renderedXCoordinates([
    { xLabel: "same layer", yValue: 1 },
    { xLabel: "same layer", yValue: 2 },
    { xLabel: "same layer", yValue: 3 },
  ], "ordinal");
  assert.deepEqual(positions, [72, 364, 656]);
});

test("equal numeric observations share a safe centered coordinate", () => {
  const positions = renderedXCoordinates([
    { xValue: 7, xLabel: "7", yValue: 1 },
    { xValue: 7, xLabel: "7", yValue: 2 },
  ], "numeric");
  assert.deepEqual(positions, [364, 364]);
});

test("large numeric series retain complete domains for scatter and bar charts", () => {
  const points = Array.from({length: 200000}, (_, index) => ({
    xValue: index, xLabel: String(index), yValue: index % 17 - 8,
  }));
  for (const chartType of ["scatter", "bar"]) {
    const documentContext = new FakeRasterControlDocument();
    const chart = documentContext.querySelector("#vector-time-series-chart");
    const rendered = renderOrdinalSeriesChart({
      documentContext, chart, points, chartType, xScale: "numeric", xBounds: [0, 0.5],
      xAxisLabel: "Time", yAxisLabel: "Value", ariaLabel: "Large series",
      pointAccessibleLabel: point => point.xLabel, pointTooltip: point => point.xLabel,
    });
    assert.deepEqual(rendered.xDomain, [0, 0.5]);
    assert.deepEqual(rendered.yDomain, [-8, 8], "all observations contribute to the automatic Y domain");
    assert.equal(rendered.pointElements.length, 1, "custom bounds display only the first observation");
    if (chartType === "bar") {
      const barWidth = Number(rendered.pointElements[0].circle.getAttribute("width"));
      assert.ok(Number.isFinite(barWidth) && barWidth > 0);
    }
  }
});
