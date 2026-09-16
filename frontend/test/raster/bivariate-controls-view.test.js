import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getBivariateColorForValues } from "../../src/raster/bivariate.js";

import {
  BivariateRasterControlsView,
} from "../../src/raster/bivariate-controls-view.js";

class FakeElement extends EventTarget {
  /** Create a minimal HTML/SVG element for focused view testing. */
  constructor(tagName, documentContext) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = documentContext;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.textContent = "";
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
  }

  /** Return select options as the current child list. */
  get options() {
    return this.children;
  }

  /** Append one or more child elements. */
  append(...children) {
    this.children.push(...children);
  }

  /** Replace every child element. */
  replaceChildren(...children) {
    this.children = children;
  }

  /** Store one string attribute and synchronize class names. */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") {
      this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    }
  }

  /** Remove one attribute. */
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /** Read one attribute or null. */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  /** Focus this control in its owning fake document. @return {void} */
  focus() {
    this.ownerDocument.activeElement = this;
  }
}

class FakeBivariateDocument {
  /** Create all fixed bivariate-control elements. */
  constructor() {
    const selectors = [
      "#raster-bivariate-controls",
      "#raster-comparison-mode",
      "#raster-bivariate-status",
      "#raster-bivariate-panel",
      "#raster-bivariate-palette",
      "#swap-raster-bivariate-axes",
      "#download-bivariate-x", "#download-bivariate-y",
      "#calculate-bivariate-x", "#calculate-bivariate-y",
      "#raster-bivariate-legend",
      "#raster-bivariate-legend-x-range",
      "#raster-bivariate-legend-y-range",
      "#raster-bivariate-statistics",
      "#raster-bivariate-statistics-heading",
      "#raster-bivariate-statistics-status",
      "#raster-bivariate-statistics-x-label",
      "#raster-bivariate-statistics-y-label",
      "#retry-raster-paired-statistics",
      "#raster-bivariate-histogram",
      "#raster-bivariate-axis-controls",
      "#raster-bivariate-histogram-summary",
      "#raster-bivariate-style-ranges",
      ...["x", "y"].flatMap((axis) => [
        `#bivariate-${axis}-range-label`,
        `#bivariate-${axis}-range-status`, `#apply-bivariate-${axis}-range`,
        ...["lower", "middle", "upper"].flatMap((name) => [
          `#bivariate-${axis}-${name}`, `#bivariate-${axis}-${name}-value`,
        ]),
      ]),
    ];
    this.elements = new Map(selectors.map((selector) => [
      selector,
      new FakeElement(selector.slice(1), this),
    ]));
    const mode = this.elements.get("#raster-comparison-mode");
    for (const axis of ["x", "y"]) {
      for (const [name, value] of Object.entries({ lower: 5, middle: 50, upper: 95 })) {
        this.elements.get(`#bivariate-${axis}-${name}`).value = String(value);
      }
    }
    for (const value of ["overlay", "bivariate"]) {
      const option = new FakeElement("option", this);
      option.value = value;
      mode.append(option);
    }
  }

  /** Resolve one fixed ID selector. */
  querySelector(selector) {
    return this.elements.get(selector) ?? null;
  }

  /** Create one HTML element. */
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  /** Create one SVG element. */
  createElementNS(_namespace, tagName) {
    return new FakeElement(tagName, this);
  }
}

function pairedStatistics() {
  const size = 32;
  const counts = Array.from({ length: size }, () => Array(size).fill(0));
  counts[4][6] = 9;
  return {
    approximate: true,
    pairedSampleCount: 9,
    sampleWidth: 8,
    sampleHeight: 8,
    xMinimum: 0,
    xMaximum: 32,
    yMinimum: 0,
    yMaximum: 32,
    histogram: {
      xEdges: Array.from({ length: size + 1 }, (_, index) => index),
      yEdges: Array.from({ length: size + 1 }, (_, index) => index),
      counts,
      xMarginalCounts: Array.from(
        { length: size },
        (_, index) => index === 6 ? 9 : 0,
      ),
      yMarginalCounts: Array.from(
        { length: size },
        (_, index) => index === 4 ? 9 : 0,
      ),
    },
  };
}

const PRESENTATION = {
  paletteName: "orangeBlue",
  xLabel: "temperature.tif",
  yLabel: "moisture.tif",
  xStyle: {
    minimum: 0,
    midpoint: 16,
    maximum: 32,
    minimumColor: "#000000",
    midpointColor: "#ff8000",
    maximumColor: "#ffcc00",
  },
  yStyle: {
    minimum: 0,
    midpoint: 16,
    maximum: 32,
    minimumColor: "#000000",
    midpointColor: "#408020",
    maximumColor: "#00ffff",
  },
};

test("bivariate controls render labeled legend and inspectable ESOS-C histogram", () => {
  const documentContext = new FakeBivariateDocument();
  const view = new BivariateRasterControlsView(documentContext);
  view.populatePalettes();
  view.renderMode({ active: true, ...PRESENTATION });
  view.renderStatistics(pairedStatistics(), PRESENTATION);

  assert.equal(view.palette.children.length, 8);
  assert.equal(view.panel.hidden, false);
  assert.equal(view.statisticsPanel.hidden, false);
  assert.equal(
    view.statisticsHeading.textContent,
    "temperature.tif vs. moisture.tif",
  );
  assert.equal(view.statisticsXLabel.textContent, "temperature.tif");
  assert.equal(view.statisticsYLabel.textContent, "moisture.tif");
  assert.equal(view.legend.children.length, 145);
  assert.match(view.legend.getAttribute("aria-label"), /temperature\.tif/);
  assert.match(view.legend.getAttribute("aria-label"), /moisture\.tif/);
  assert.equal(view.cells.size, 1);
  const cell = view.cells.get("6:4");
  assert.equal(cell.getAttribute("tabindex"), "0");
  assert.equal(cell.getAttribute("role"), "button");
  assert.match(cell.getAttribute("aria-label"), /9 pixels/);
  assert.match(view.histogram.getAttribute("aria-label"), /temperature\.tif/);
  assert.doesNotMatch(view.histogram.getAttribute("aria-label"), /Raster A/);
  assert.match(view.histogram.getAttribute("aria-label"), /Densest bin/);
  assert.equal(
    view.histogram.children.some((child) => child.tagName === "TITLE"),
    false,
  );
  assert.match(view.histogramSummary.textContent, /^Densest · X 6–7 · Y 4–5/);
  const tooltip = view.histogram.children.find(
    (child) => child.classList.contains("raster-bivariate-tooltip"),
  );
  assert.ok(tooltip);
  assert.equal(tooltip.getAttribute("hidden"), "");
  const xMarginals = view.histogram.children.filter(
    (child) => child.classList.contains("raster-bivariate-marginal") &&
      child.getAttribute("data-marginal-axis") === "x",
  );
  const yMarginals = view.histogram.children.filter(
    (child) => child.classList.contains("raster-bivariate-marginal") &&
      child.getAttribute("data-marginal-axis") === "y",
  );
  const xGuide = view.histogram.children.find(
    (child) => child.getAttribute("data-projection-axis") === "x",
  );
  const yGuide = view.histogram.children.find(
    (child) => child.getAttribute("data-projection-axis") === "y",
  );
  assert.equal(xMarginals.length, 32);
  assert.equal(yMarginals.length, 32);
  assert.equal(xGuide.getAttribute("hidden"), "");
  assert.equal(yGuide.getAttribute("hidden"), "");

  cell.dispatchEvent(new Event("pointerenter"));
  assert.equal(cell.classList.contains("is-hovered"), true);
  assert.equal(xGuide.getAttribute("hidden"), null);
  assert.equal(yGuide.getAttribute("hidden"), null);
  assert.equal(xGuide.getAttribute("x"), "238.75");
  assert.equal(xGuide.getAttribute("width"), "13.125");
  assert.equal(yGuide.getAttribute("y"), "428.375");
  assert.equal(yGuide.getAttribute("height"), "13.125");
  assert.equal(xMarginals[6].classList.contains("is-projected"), true);
  assert.equal(yMarginals[4].classList.contains("is-projected"), true);
  assert.equal(tooltip.getAttribute("hidden"), null);
  assert.deepEqual(
    tooltip.children.slice(1).map((line) => line.textContent),
    ["X: 6–7", "Y: 4–5", "9 pixels · 100.00% of sample"],
  );
  const [, tooltipX, tooltipY] = tooltip.getAttribute("transform").match(
    /translate\((\S+) (\S+)\)/,
  );
  const viewBoxHeight = Number(view.histogram.getAttribute("viewBox").split(" ").at(-1));
  assert.ok(Number(tooltipX) >= 4 && Number(tooltipX) + 360 <= 656);
  assert.ok(
    Number(tooltipY) >= 4 &&
      Number(tooltipY) + Number(tooltip.children[0].getAttribute("height")) <=
        viewBoxHeight - 4,
  );
  cell.dispatchEvent(new Event("pointerleave"));
  assert.equal(cell.classList.contains("is-hovered"), false);
  assert.equal(xGuide.getAttribute("hidden"), "");
  assert.equal(yGuide.getAttribute("hidden"), "");
  assert.equal(xMarginals[6].classList.contains("is-projected"), false);
  assert.equal(yMarginals[4].classList.contains("is-projected"), false);
  assert.equal(tooltip.getAttribute("hidden"), "");

  xMarginals[6].dispatchEvent(new Event("pointerenter"));
  assert.equal(xMarginals[6].classList.contains("is-hovered"), true);
  assert.equal(xMarginals[6].classList.contains("is-projected"), true);
  assert.equal(xGuide.getAttribute("hidden"), null);
  assert.equal(yGuide.getAttribute("hidden"), "");
  assert.deepEqual(
    tooltip.children.slice(1, 3).map((line) => line.textContent),
    ["X: 6–7", "9 pixels · 100.00% of sample"],
  );
  assert.equal(tooltip.children[3].getAttribute("hidden"), "");
  assert.match(xMarginals[6].getAttribute("aria-label"), /temperature\.tif/);
  xMarginals[6].dispatchEvent(new Event("pointerleave"));
  assert.equal(xGuide.getAttribute("hidden"), "");
  assert.equal(xMarginals[6].classList.contains("is-projected"), false);

  yMarginals[4].dispatchEvent(new Event("pointerenter"));
  assert.equal(yMarginals[4].classList.contains("is-hovered"), true);
  assert.equal(yMarginals[4].classList.contains("is-projected"), true);
  assert.equal(xGuide.getAttribute("hidden"), "");
  assert.equal(yGuide.getAttribute("hidden"), null);
  assert.deepEqual(
    tooltip.children.slice(1, 3).map((line) => line.textContent),
    ["Y: 4–5", "9 pixels · 100.00% of sample"],
  );
  assert.match(yMarginals[4].getAttribute("aria-label"), /moisture\.tif/);
  yMarginals[4].dispatchEvent(new Event("pointerleave"));
  assert.equal(yGuide.getAttribute("hidden"), "");
  assert.equal(yMarginals[4].classList.contains("is-projected"), false);
  assert.equal(tooltip.getAttribute("hidden"), "");
  const xAxisTitles = view.histogram.children.filter(
    (child) => child.getAttribute("data-axis") === "x",
  );
  const yAxisTitles = view.histogram.children.filter(
    (child) => child.getAttribute("data-axis") === "y",
  );
  assert.deepEqual(xAxisTitles.map((title) => title.textContent), [
    "temperature.tif",
  ]);
  assert.deepEqual(yAxisTitles.map((title) => title.textContent), [
    "moisture.tif",
  ]);

  const keyboardEvent = new Event("keydown");
  Object.defineProperty(keyboardEvent, "key", { value: "Enter" });
  cell.dispatchEvent(keyboardEvent);
  assert.equal(cell.classList.contains("is-selected"), true);
  assert.match(view.histogramSummary.textContent, /100\.0%/);

  view.highlightPair(6.5, 4.5);
  assert.equal(cell.classList.contains("is-sampled"), true);
  assert.match(view.histogramSummary.textContent, /Probe/);
});

test("bivariate histogram wraps long raster basenames clear of Y ticks", () => {
  const documentContext = new FakeBivariateDocument();
  const view = new BivariateRasterControlsView(documentContext);
  const longPresentation = {
    ...PRESENTATION,
    xLabel: "barley_NitrogenApplication_Rate_for_2026_scenario_output.tif",
    yLabel: "grassland_carbon_sequestration_reference_projection_2026.tif",
  };
  view.renderMode({ active: true, ...longPresentation });
  view.renderStatistics(pairedStatistics(), longPresentation);

  const xAxisTitles = view.histogram.children.filter(
    (child) => child.getAttribute("data-axis") === "x",
  );
  const yAxisTitles = view.histogram.children.filter(
    (child) => child.getAttribute("data-axis") === "y",
  );
  assert.ok(xAxisTitles.length > 1);
  assert.ok(yAxisTitles.length > 1);
  assert.equal(
    xAxisTitles.map((title) => title.textContent).join(""),
    longPresentation.xLabel,
  );
  assert.equal(
    yAxisTitles.map((title) => title.textContent).join(""),
    longPresentation.yLabel,
  );
  assert.ok(
    yAxisTitles.every((title) => Number(title.getAttribute("x")) < 100),
  );
  assert.equal(
    view.statisticsHeading.textContent,
    `${longPresentation.xLabel} vs. ${longPresentation.yLabel}`,
  );
});

test("bivariate controls forward native mode, palette, swap, and retry actions", () => {
  const documentContext = new FakeBivariateDocument();
  const view = new BivariateRasterControlsView(documentContext);
  const actions = [];
  view.populatePalettes();
  view.bind({
    onBivariatePercentileInput: (axis) => actions.push(["percentile", axis]),
    onApplyBivariatePercentiles: (axis) => actions.push(["apply", axis]),
    onBivariateModeChange: (mode) => actions.push(["mode", mode]),
    onBivariatePaletteChange: (palette) => actions.push(["palette", palette]),
    onBivariateSwapAxes: () => actions.push(["swap"]),
    onRetryPairedStatistics: () => actions.push(["retry"]),
  });

  view.mode.value = "bivariate";
  view.mode.dispatchEvent(new Event("change"));
  view.palette.value = "steelRose";
  view.palette.dispatchEvent(new Event("change"));
  view.swapButton.dispatchEvent(new Event("click"));
  view.retryButton.dispatchEvent(new Event("click"));
  view.rangeControls.x.inputs.lower.dispatchEvent(new Event("input"));
  view.rangeControls.y.apply.dispatchEvent(new Event("click"));
  view.unbind();
  view.rangeControls.x.inputs.lower.dispatchEvent(new Event("input"));
  view.rangeControls.y.apply.dispatchEvent(new Event("click"));

  assert.deepEqual(actions, [
    ["mode", "bivariate"],
    ["palette", "steelRose"],
    ["swap"],
    ["retry"],
    ["percentile", "x"],
    ["apply", "y"],
  ]);
});

test("paired range controls show estimates, validity, and disabled unavailable actions", () => {
  const view = new BivariateRasterControlsView(new FakeBivariateDocument());
  assert.deepEqual(view.readPercentiles("x"), { lower: 5, middle: 50, upper: 95 });
  view.renderPercentiles("x", {
    values: { lower: "2", middle: "4", upper: "9" },
    message: "Estimated from the map sample", applicable: true, invalid: false,
  });
  assert.equal(view.rangeControls.x.values.middle.textContent, "50% ≈ 4");
  assert.equal(view.rangeControls.x.apply.disabled, false);
  view.renderPercentiles("x", {
    values: null, message: "Waiting", applicable: false, invalid: false,
  });
  assert.equal(view.rangeControls.x.apply.disabled, true);
  assert.equal(view.rangeControls.x.values.middle.textContent, "50% ≈ —");
  view.renderPercentiles("y", {
    values: null, message: "Choose increasing percentiles", applicable: false, invalid: true,
  });
  assert.equal(view.rangeControls.y.inputs.lower.getAttribute("aria-invalid"), "true");
});

test("the 2D legend uses actual threshold spacing including an off-center midpoint", () => {
  const view = new BivariateRasterControlsView(new FakeBivariateDocument());
  const state = {
    ...PRESENTATION, active: true,
    xStyle: { ...PRESENTATION.xStyle, minimum: 2, midpoint: 3, maximum: 20 },
    yStyle: { ...PRESENTATION.yStyle, minimum: 100, midpoint: 125, maximum: 132 },
  };
  view.renderMode(state);
  assert.equal(view.legend.children[1].style.fill, getBivariateColorForValues(
    state.paletteName, state.xStyle, state.yStyle, 2 + 18 / 24, 100 + 32 / 24,
  ));
  assert.equal(view.legendXRange.textContent, "temperature.tif: 2.000e+0 to 2.000e+1");
});

test("bivariate projection guides remain transient and pointer-transparent", () => {
  const stylesheet = readFileSync(
    new URL("../../src/style.css", import.meta.url),
    "utf8",
  );

  assert.match(
    stylesheet,
    /\.raster-bivariate-projection-guide\s*\{[^}]*pointer-events:\s*none/s,
  );
  assert.match(
    stylesheet,
    /\.raster-bivariate-projection-guide\[hidden\]\s*\{[^}]*display:\s*none/s,
  );
});

/**
 * Return the three rendered threshold lines for one paired axis.
 * @param {BivariateRasterControlsView} view Rendered controls view.
 * @param {"x"|"y"} axis Marginal axis.
 * @return {FakeElement[]} Lines in L/M/U order.
 */
function thresholdLines(view, axis) {
  const group = view.thresholdMarkers.children.find(
    (element) => element.getAttribute("data-threshold-axis") === axis,
  );
  return group?.children.filter((element) => element.getAttribute("data-threshold")) ?? [];
}

test("marginal markers use numeric thresholds and inverted vertical coordinates", () => {
  const view = new BivariateRasterControlsView(new FakeBivariateDocument());
  view.renderMode({ active: true, ...PRESENTATION });
  view.renderStatistics(pairedStatistics(), {
    ...PRESENTATION,
    xStyle: { ...PRESENTATION.xStyle, minimum: -2, midpoint: 8, maximum: 40 },
  });
  assert.deepEqual(thresholdLines(view, "x").map(line => Number(line.getAttribute("x1"))),
    [160, 265, 580]);
  assert.deepEqual(thresholdLines(view, "y").map(line => Number(line.getAttribute("y1"))),
    [494, 284, 74]);
  assert.deepEqual(thresholdLines(view, "x").map(line => Number(line.getAttribute("data-value"))),
    [-2, 8, 40]);
  assert.equal(view.rangeControls.x.label.textContent, PRESENTATION.xLabel);
  assert.equal(view.rangeControls.y.label.textContent, PRESENTATION.yLabel);
  for (const group of view.thresholdMarkers.children) {
    assert.deepEqual(group.children.filter(child => child.tagName === "TEXT").map(child => child.textContent),
      ["L", "M", "U"]);
  }
});

test("range previews preserve histogram interactions and clear on stale or invalid data", () => {
  const view = new BivariateRasterControlsView(new FakeBivariateDocument());
  view.bind({});
  view.renderStatistics(pairedStatistics(), PRESENTATION);
  const cell = view.cells.get("6:4");
  cell.dispatchEvent(new Event("focus"));
  const candidate = {
    values: { lower: "4", middle: "8", upper: "24" },
    range: { minimum: 4, midpoint: 8, maximum: 24 },
    message: "Estimated", applicable: true, invalid: false,
  };
  view.renderPercentiles("x", candidate);
  assert.equal(thresholdLines(view, "x")[1].getAttribute("data-value"), "16");
  view.styleRanges.open = true;
  view.styleRanges.dispatchEvent(new Event("toggle"));
  assert.equal(thresholdLines(view, "x")[1].getAttribute("data-value"), "8");
  assert.equal(thresholdLines(view, "y")[1].getAttribute("data-value"), "16");
  assert.equal(view.cells.get("6:4"), cell);
  assert.equal(cell.classList.contains("is-hovered"), true);
  view.renderPercentiles("x", { ...candidate, applicable: false, invalid: true });
  assert.equal(thresholdLines(view, "x")[1].getAttribute("data-value"), "16");
  view.renderPercentiles("x", candidate);
  view.setStatisticsLoading("Loading");
  assert.equal(view.thresholdMarkers.children.length, 0);
  view.renderStatisticsError(new Error("Unavailable"), true);
  view.styleRanges.dispatchEvent(new Event("toggle"));
  assert.equal(view.thresholdMarkers.children.length, 0);
  view.renderStatistics(pairedStatistics(), { ...PRESENTATION,
    xStyle: PRESENTATION.yStyle, yStyle: PRESENTATION.xStyle });
  assert.equal(thresholdLines(view, "x")[1].getAttribute("data-value"), "16");
  view.clearStatistics();
  view.styleRanges.dispatchEvent(new Event("toggle"));
  assert.equal(view.histogram.children.length, 0);
  view.unbind();
});

test("2D range disclosure lives beside its histogram and markers cannot intercept hover", () => {
  const markup = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const section = markup.slice(markup.indexOf('<section class="raster-bivariate-statistics"'))
    .split("</section>")[0];
  assert.match(section, /<details[^>]*id="raster-bivariate-style-ranges"[^>]*>\s*<summary>Style rasters<\/summary>/);
  assert.doesNotMatch(section.match(/<details[^>]*>/)[0], /\bopen\b/);
  assert.ok(section.indexOf('id="raster-bivariate-style-ranges"') > section.indexOf("</svg>"));
  for (const id of ['raster-bivariate-palette', 'swap-raster-bivariate-axes', 'raster-bivariate-legend']) {
    assert.ok(section.includes(`id="${id}"`));
    assert.equal(markup.split(`id="${id}"`).length, 2);
    assert.ok(section.indexOf(`id="${id}"`) > section.indexOf('id="raster-bivariate-style-ranges"'));
  }
  assert.doesNotMatch(markup, /id="layer-paired-style"|id="raster-bivariate-[xy]-label"/);
  assert.doesNotMatch(section, /id="layer-style-opacity"/);
  for (const axis of ["x", "y"]) {
    for (const name of ["lower", "middle", "upper"]) {
      assert.ok(section.includes(`id="bivariate-${axis}-${name}"`));
      assert.equal(markup.split(`id="bivariate-${axis}-${name}"`).length, 2);
    }
  }
  const stylesheet = readFileSync(new URL("../../src/style.css", import.meta.url), "utf8");
  assert.match(stylesheet, /\.raster-bivariate-thresholds\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(stylesheet, /\.raster-bivariate-style-ranges > summary\s*\{[^}]*display:\s*list-item/s);
});

test('paired style navigation expands the histogram controls and focuses the palette', () => {
  const documentContext = new FakeBivariateDocument();
  const view = new BivariateRasterControlsView(documentContext);
  view.renderMode({ active: true, ...PRESENTATION });
  view.renderStatistics(pairedStatistics(), PRESENTATION);
  view.openStyle();
  assert.equal(view.styleRanges.open, true);
  assert.equal(documentContext.activeElement, view.palette);
  assert.equal(view.statisticsPanel.hidden, false);
});

test("2D log axes align cells, marginal hover bands and markers without new analysis", () => {
  const doc = new FakeBivariateDocument(), view = new BivariateRasterControlsView(doc);
  const statistics = pairedStatistics(), original = structuredClone(statistics);
  view.bind({
    onBivariateModeChange: () => assert.fail("Display edits must not change analysis mode"),
    onBivariatePercentileInput: () => assert.fail("Display edits must not change styling"),
    onRetryPairedStatistics: () => assert.fail("Display edits must not resample"),
  });
  view.renderStatistics(statistics, PRESENTATION);
  view.highlightPair(6.5, 4.5);
  for (const key of ["x", "y"]) {
    const input = view.axisControls.rows.get(key).fields.scale.input;
    input.value = "log";
    input.dispatchEvent(new Event("change"));
  }
  const cell = view.cells.get("6:4");
  assert.equal(cell.classList.contains("is-sampled"), true);
  cell.dispatchEvent(new Event("pointerenter"));
  const xGuide = view.histogram.children.find(child => child.getAttribute("data-projection-axis") === "x");
  const yGuide = view.histogram.children.find(child => child.getAttribute("data-projection-axis") === "y");
  assert.ok(Math.abs(Number(xGuide.getAttribute("x")) - (160 + Math.log(6) / Math.log(32) * 420)) < 1e-10);
  assert.ok(Math.abs(Number(yGuide.getAttribute("y")) - (74 + (1 - Math.log(5) / Math.log(32)) * 420)) < 1e-10);
  const xBars = view.histogram.children.filter(child => child.getAttribute("data-marginal-axis") === "x");
  const hovered = xBars.find(child => child.classList.contains("is-projected"));
  assert.ok(hovered);
  assert.equal(Number(hovered.getAttribute("x")), Number(xGuide.getAttribute("x")));
  hovered.dispatchEvent(new Event("pointerenter"));
  assert.equal(yGuide.getAttribute("hidden"), "");
  const group = view.thresholdMarkers.children.find(child => child.getAttribute("data-threshold-axis") === "x");
  const middle = group.children.find(child => child.getAttribute("data-threshold") === "midpoint");
  assert.ok(Math.abs(Number(middle.getAttribute("x1")) - (160 + Math.log(16) / Math.log(32) * 420)) < 1e-10);
  assert.deepEqual(statistics, original);

  const frequency = view.axisControls.rows.get("yFrequency").fields;
  frequency.bounds.input.value = "values";
  frequency.bounds.input.dispatchEvent(new Event("change"));
  frequency.maximum.input.value = "50";
  frequency.maximum.input.dispatchEvent(new Event("change"));
  assert.ok(view.histogram.children.some(child => child.getAttribute("data-marginal-axis") === "y" &&
    child.classList.contains("histogram-axis-clipped")));
  view.setStatisticsLoading("New sample");
  assert.equal(frequency.maximum.input.disabled, true);
  view.clearStatistics();
  assert.equal(view.axesHost.children.length, 0);
});
