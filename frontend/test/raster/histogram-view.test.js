import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  clearRasterHistogramChart,
  renderRasterHistogramChart,
} from "../../src/raster/histogram-view.js";
import { resolveHistogramAxis } from "../../src/raster/histogram-axis-scale.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";
import {
  FAKE_SVG_DOCUMENT,
  FakeSvgElement,
  createFakeResizeObservers,
} from "../../test-support/raster/fakes.js";
import { RASTER_STATISTICS } from "../../test-support/raster/fixtures.js";

test("raster histogram rendering displays all 64 SVG bars", () => {
  const chart = new FakeSvgElement("svg");
  chart.setAttribute("hidden", "");

  renderRasterHistogramChart(
    chart,
    RASTER_STATISTICS,
    DEFAULT_RASTER_STYLE,
    FAKE_SVG_DOCUMENT,
  );

  assert.equal(chart.hasAttribute("hidden"), false);
  assert.equal(chart.children[0].tagName, "title");
  const bars = chart.children.filter(
    (child) => child.classNames.includes("raster-histogram-bar"),
  );
  const tooltip = chart.children.find(
    (child) => child.classNames.includes("raster-histogram-tooltip"),
  );
  assert.equal(bars.length, 64);
  assert.ok(bars.every(
    (bar) => bar.tagName === "rect" &&
      bar.classNames.includes("raster-histogram-bar") &&
      bar.children.length === 0 &&
      bar.attributes.get("aria-label").includes("Bin midpoint") &&
      bar.attributes.get("aria-label").includes("1.56% of the valid sample") &&
      /^#[0-9a-f]{6}$/.test(bar.style.fill),
  ));
  assert.equal(tooltip.tagName, "g");
  assert.equal(tooltip.hasAttribute("hidden"), true);
  assert.deepEqual(
    tooltip.children.map((child) => child.tagName),
    ["rect", "text", "text"],
  );

  bars[0].dispatchEvent(new Event("pointerenter"));
  assert.equal(bars[0].classList.contains("is-hovered"), true);
  assert.equal(tooltip.hasAttribute("hidden"), false);
  assert.equal(tooltip.attributes.get("transform"), "translate(4 4)");
  assert.equal(tooltip.children[1].textContent, "-10–-9.375");
  assert.match(tooltip.children[2].textContent, /125 pixels · 1\.56%/);

  bars[63].dispatchEvent(new Event("pointerenter"));
  assert.equal(bars[0].classList.contains("is-hovered"), false);
  assert.equal(bars[63].classList.contains("is-hovered"), true);
  assert.equal(tooltip.attributes.get("transform"), "translate(276 4)");
  bars[0].dispatchEvent(new Event("pointerleave"));
  assert.equal(tooltip.hasAttribute("hidden"), false);
  bars[63].dispatchEvent(new Event("pointerleave"));
  assert.equal(bars[63].classList.contains("is-hovered"), false);
  assert.equal(tooltip.hasAttribute("hidden"), true);

  clearRasterHistogramChart(chart);
  assert.equal(chart.hasAttribute("hidden"), true);
  assert.equal(chart.children.length, 0);
});

test("every bin fits inside labeled axes across container widths", () => {
  for (const width of [280, 320, 391, 600, 1000]) {
    const chart = new FakeSvgElement("svg");
    chart.clientWidth = width;
    renderRasterHistogramChart(chart, RASTER_STATISTICS, DEFAULT_RASTER_STYLE, FAKE_SVG_DOCUMENT);
    assert.equal(chart.attributes.get("viewBox"), `0 0 ${width} 190`);
    assert.equal(chart.attributes.get("preserveAspectRatio"), "none");
    assert.equal(chart.attributes.get("role"), "img");
    const bars = chart.children.filter(child => child.classList.contains("raster-histogram-bar"));
    assert.equal(bars.length, 64);
    assert.equal(Number(bars[0].attributes.get("height")), 125 / 8000 * 100 / 2 * 116);
    for (const bar of bars) {
      const x = Number(bar.attributes.get("x")), y = Number(bar.attributes.get("y"));
      assert.ok(x >= 48 && x + Number(bar.attributes.get("width")) <= width - 12);
      assert.ok(y >= 28 && Math.abs(y + Number(bar.attributes.get("height")) - 144) < 1e-8);
    }
    const axes = chart.children.find(child => child.attributes.get("class") === "raster-histogram-axes");
    const labels = axes.children.filter(child => child.tagName === "text").map(child => child.textContent);
    assert.ok(labels.includes("Sampled pixels (%)"));
    assert.ok(labels.includes("Raster value"));
    assert.deepEqual(labels.slice(0, 3), ["0", "1", "2"]);
    assert.ok(labels.includes("-10") && labels.includes("30"));
    bars.at(-1).dispatchEvent(new Event("pointerenter"));
    const tooltip = chart.children.at(-1);
    const tooltipX = Number(tooltip.attributes.get("transform").match(/translate\((\S+)/)[1]);
    assert.ok(tooltipX >= 4 && tooltipX + Number(tooltip.children[0].attributes.get("width")) <= width - 4);
  }
});

test("constant and non-uniform bins retain correct positions and finite heights", () => {
  const chart = new FakeSvgElement("svg");
  chart.clientWidth = 391;
  const data = { ...RASTER_STATISTICS, sampleMinimum: 0, sampleMaximum: 0, validSampleCount: 64,
    histogram: { counts: Array.from({length:64}, (_, i) => i === 32 ? 64 : 0),
      edges: Array.from({length:65}, (_, i) => -0.5 + i / 64) } };
  renderRasterHistogramChart(chart, data, DEFAULT_RASTER_STYLE, FAKE_SVG_DOCUMENT);
  let bars = chart.children.filter(child => child.classList.contains("raster-histogram-bar"));
  assert.equal(Number(bars[32].attributes.get("height")), 116);
  assert.equal(Number(bars[32].attributes.get("x")), 48 + (391 - 60) / 2);
  assert.equal(bars.filter(bar => Number(bar.attributes.get("height")) > 0).length, 1);
  data.histogram.edges = Array.from({length:65}, (_, i) => (i / 64) ** 2);
  renderRasterHistogramChart(chart, data, DEFAULT_RASTER_STYLE, FAKE_SVG_DOCUMENT);
  bars = chart.children.filter(child => child.classList.contains("raster-histogram-bar"));
  assert.equal(Number(bars[32].attributes.get("x")), 48 + (391 - 60) / 4);
  assert.ok(bars.every(bar => [...bar.attributes.values()].every(value => !/NaN|Infinity/.test(value))));
});

test("candidate style thresholds are colored, labeled, and clamped to the plot", () => {
  const chart = new FakeSvgElement("svg");
  chart.clientWidth = 391;
  const markers = [
    { label: "lower 5%", value: -100, color: "#123456" },
    { label: "middle 50%", value: 10, color: "#abcdef" },
    { label: "upper 95%", value: 100, color: "#fedcba" },
  ];

  renderRasterHistogramChart(
    chart,
    RASTER_STATISTICS,
    DEFAULT_RASTER_STYLE,
    FAKE_SVG_DOCUMENT,
    "Raster value",
    markers,
  );

  const group = chart.children.find(child =>
    child.classList.contains("raster-histogram-thresholds")
  );
  const lines = group.children.filter(child =>
    child.classList.contains("raster-histogram-threshold")
  );
  const labels = group.children.filter(child =>
    child.classList.contains("raster-histogram-threshold-label")
  );
  assert.deepEqual(lines.map(line => line.style.stroke), markers.map(marker => marker.color));
  assert.deepEqual(lines.map(line => Number(line.attributes.get("x1"))), [48, 213.5, 379]);
  assert.deepEqual(labels.map(label => label.textContent), ["L", "M", "U"]);
  assert.match(chart.attributes.get("aria-label"), /lower 5% at -1\.000e\+2/);

  assert.throws(
    () => renderRasterHistogramChart(
      chart,
      RASTER_STATISTICS,
      DEFAULT_RASTER_STYLE,
      FAKE_SVG_DOCUMENT,
      "Raster value",
      [{ label: "lower", value: 0, color: "red" }],
    ),
    /threshold markers are invalid/,
  );
});

test("resizing redraws the plot and stale observers cannot revive cleared charts", () => {
  const { ResizeObserver, instances } = createFakeResizeObservers();
  const documentContext = { ...FAKE_SVG_DOCUMENT, defaultView: { ResizeObserver } };
  const chart = new FakeSvgElement("svg");
  renderRasterHistogramChart(chart, RASTER_STATISTICS, DEFAULT_RASTER_STYLE, documentContext);
  instances[0].resize(280);
  assert.equal(chart.attributes.get("viewBox"), "0 0 280 190");
  instances[0].resize(600);
  assert.equal(chart.attributes.get("viewBox"), "0 0 600 190");
  instances[0].resize(0);
  assert.equal(chart.attributes.get("viewBox"), "0 0 600 190");
  renderRasterHistogramChart(chart, RASTER_STATISTICS, DEFAULT_RASTER_STYLE, documentContext);
  assert.equal(instances[0].disconnected, true);
  instances[0].resize(999);
  assert.equal(chart.attributes.get("viewBox"), "0 0 640 190");
  clearRasterHistogramChart(chart);
  assert.equal(instances[1].disconnected, true);
  instances[1].resize(391);
  assert.equal(chart.children.length, 0);
  assert.equal(chart.hasAttribute("hidden"), true);
});

test("raster histogram hover styles emphasize only the active bar", () => {
  const stylesheet = readFileSync(
    new URL("../../src/style.css", import.meta.url),
    "utf8",
  );

  assert.match(
    stylesheet,
    /\.raster-histogram-bar\.is-hovered\s*\{[^}]*opacity:\s*1[^}]*stroke:/s,
  );
  assert.match(
    stylesheet,
    /\.raster-histogram-tooltip\[hidden\]\s*\{[^}]*display:\s*none/s,
  );
  assert.match(
    stylesheet,
    /\.raster-histogram-tooltip\s*\{[^}]*pointer-events:\s*none/s,
  );
});

test("log and clipped 1D axes preserve bin identity, hover counts and style marker coordinates", () => {
  const chart = new FakeSvgElement("svg");
  const statistics = { ...RASTER_STATISTICS, validSampleCount: 10,
    histogram: { edges: [-1, 1, 10, 100], counts: [3, 5, 2] } };
  const original = structuredClone(statistics);
  const distribution = { ...statistics.histogram, total: 10 };
  const x = resolveHistogramAxis(distribution, { scale: "log", bounds: "auto", minimum: "", maximum: "" });
  const y = resolveHistogramAxis({ ...distribution, frequency: true },
    { scale: "linear", bounds: "values", minimum: "0", maximum: "40" });
  renderRasterHistogramChart(chart, statistics, DEFAULT_RASTER_STYLE, FAKE_SVG_DOCUMENT,
    "Raster value", [{ label: "Middle", value: 10, color: "#123456" }], { x, y });
  const bars = chart.children.filter(child => child.classNames.includes("raster-histogram-bar"));
  assert.equal(bars.length, 2, "The crossing-zero bin is omitted whole");
  assert.equal(Number(bars[0].attributes.get("height")), 116);
  assert.ok(bars[0].classNames.includes("histogram-axis-clipped"));
  assert.equal(Number(bars[1].attributes.get("x")), 338);
  bars[0].dispatchEvent(new Event("pointerenter"));
  const tooltip = chart.children.find(child => child.classNames.includes("raster-histogram-tooltip"));
  assert.equal(tooltip.children[1].textContent, "1–10");
  assert.match(tooltip.children[2].textContent, /5 pixels · 50.00%/);
  const markers = chart.children.find(child => child.classNames.includes("raster-histogram-thresholds"));
  assert.equal(Number(markers.children[0].attributes.get("x1")), 338);
  assert.deepEqual(statistics, original);
});
