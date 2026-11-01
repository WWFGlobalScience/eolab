import assert from "node:assert/strict";
import test from "node:test";

import { RasterControlsView } from "../../src/raster/controls-view.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import {
    EXACT_RASTER_STATISTICS,
    RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

/** Minimal DOM element used by the raster controls adapter tests. */
class FakeControlElement extends EventTarget {
    /**
     * Create an element with mutable DOM-like presentation state.
     *
     * @param {string} [type] Input type exposed to event handlers.
     */
    constructor(type = "", ownerDocument = null) {
        super();
        this.ownerDocument = ownerDocument;
        this.type = type;
        this.value = "";
        this.textContent = "";
        this.hidden = false;
        this.disabled = false;
        this.title = "";
        this.style = {};
        this.children = [];
        this.attributes = new Map();
        this.classNames = [];
        this.classList = {
            add: (className) => {
                if (!this.classNames.includes(className)) {
                    this.classNames.push(className);
                }
            },
            contains: (className) => this.classNames.includes(className),
            remove: (className) => {
                this.classNames = this.classNames.filter(
                    (candidate) => candidate !== className
                );
            },
        };
    }

    /**
     * Append child elements.
     *
     * @param {...FakeControlElement} children Elements to append.
     * @return {void}
     */
    append(...children) {
        this.children.push(...children);
    }

    /**
     * Replace all child elements.
     *
     * @param {...FakeControlElement} children Replacement elements.
     * @return {void}
     */
    replaceChildren(...children) {
        this.children = children;
    }

    /**
     * Store one element attribute.
     *
     * @param {string} name Attribute name.
     * @param {string} value Attribute value.
     * @return {void}
     */
    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    /**
     * Remove one element attribute.
     *
     * @param {string} name Attribute name.
     * @return {void}
     */
    removeAttribute(name) {
        this.attributes.delete(name);
    }

    /**
     * Return one element attribute.
     *
     * @param {string} name Attribute name.
     * @return {string|null} Attribute value or null when absent.
     */
    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    /**
     * Return deterministic control dimensions.
     *
     * @return {{width: number, height: number}} Element dimensions.
     */
    getBoundingClientRect() {
        return { width: 120, height: 48 };
    }

    /** Give this control focus in its fake document. @return {void} */
    focus() {
        if (this.ownerDocument !== null) {
            this.ownerDocument.activeElement = this;
        }
    }
}

/** Minimal selector and element factory contract used by the controls view. */
class FakeRasterDocument {
    /** Create an empty document-backed selector registry. */
    constructor() {
        this.activeElement = null;
        this.elements = new Map();
    }

    /**
     * Resolve or create one fake element for a raster selector.
     *
     * @param {string} selector CSS selector.
     * @return {FakeControlElement} Stable fake element.
     */
    querySelector(selector) {
        if (!this.elements.has(selector)) {
            const type = selector.endsWith("-color")
                ? "color"
                : selector.includes("percentile") || selector.endsWith("-range")
                    ? "range"
                    : selector.includes("minimum") ||
                        selector.includes("midpoint") ||
                        selector.includes("maximum") ||
                        selector.endsWith("-number")
                        ? "number"
                        : "";
            this.elements.set(selector, new FakeControlElement(type, this));
        }
        return this.elements.get(selector);
    }

    /**
     * Create one fake HTML element.
     *
     * @return {FakeControlElement} New fake element.
     */
    createElement() {
        return new FakeControlElement("", this);
    }

    /**
     * Create one fake SVG element.
     *
     * @return {FakeControlElement} New fake SVG element.
     */
    createElementNS() {
        return new FakeControlElement("", this);
    }
}

test("RasterControlsView owns style values and semantic control events", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    view.populatePalettes({
        viridis: {
            label: "Viridis",
        },
    });
    assert.equal(documentContext.querySelector("#raster-palette").children.length, 2);

    const style = {
        minimumOpacity: 1,
        midpointOpacity: 1,
        maximumOpacity: 1,
        minimum: -5,
        midpoint: 2,
        maximum: 9,
        minimumColor: "#000000",
        midpointColor: "#888888",
        maximumColor: "#ffffff",
    };
    view.setStyle(style, "viridis");
    view.setAppearanceStatus("Applied the Viridis palette.");
    assert.deepEqual(view.readStyle(), style);
    assert.equal(view.getPaletteName(), "viridis");
    assert.equal(
        documentContext.querySelector("#raster-appearance-status").textContent,
        "Applied the Viridis palette."
    );
    assert.match(
        documentContext.querySelector("#raster-legend").style.backgroundImage,
        /#000000/
    );

    const received = [];
    view.bind({
        onStyleInput: (isColor) => received.push(["style", isColor]),
        onStyleChange: () => received.push(["commit"]),
        onPaletteChange: () => received.push(["palette"]),
        onResetStyle: () => received.push(["reset"]),
        onRetryStatistics: () => received.push(["retry"]),
        onSampleWindowRangeInput: (value) => received.push(["range", value]),
        onSampleWindowNumberInput: (value) => received.push(["number", value]),
        onSampleWindowNumberChange: (value) => received.push(["change", value]),
        onClearSampleWindow: () => received.push(["whole"]),
        onUseMapWindow: () => received.push(["box"]),
    });
    documentContext
        .querySelector("#raster-minimum-color")
        .dispatchEvent(new Event("input"));
    view.setSampleWindowSize(80, 14152);
    documentContext
        .querySelector("#raster-sample-window-range")
        .dispatchEvent(new Event("input"));
    assert.deepEqual(received, [["style", true], ["range", "80"]]);

    documentContext.querySelector("#raster-histogram").hidden = true;
    documentContext.querySelector("#raster-appearance-controls").hidden = true;
    view.setControlsVisible(true);
    view.showHistogramWidget();
    assert.equal(documentContext.querySelector("#raster-histogram").hidden, false);
    view.setRenderingControlsAvailable(true);
    assert.equal(documentContext.querySelector("#raster-histogram").hidden, false);
    assert.equal(
        documentContext.querySelector("#raster-appearance-controls").hidden,
        false
    );

    view.unbind();
    documentContext
        .querySelector("#raster-minimum-color")
        .dispatchEvent(new Event("input"));
    assert.deepEqual(received, [["style", true], ["range", "80"]]);
});

test("RasterControlsView exposes accessible explicit histogram-area choices", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    const received = [];
    view.bind({
        onStyleInput() {},
        onStyleChange() {},
        onPaletteChange() {},
        onResetStyle() {},
        onRetryStatistics() {},
        onSampleWindowRangeInput() {},
        onSampleWindowNumberInput() {},
        onSampleWindowNumberChange() {},
        onClearSampleWindow: () => received.push("whole"),
        onUseMapWindow: () => received.push("box"),
        onUseVectorArea: () => received.push("vector"),
    });
    view.setSamplingAreaMode(
        "catalogSelection",
        "AOI · area.gpkg · boundary"
    );
    assert.equal(view.isSamplingBoxSelected(), false);
    const wholeChoice = documentContext.querySelector(
        "#clear-raster-sample-window"
    );
    const mapBoxChoice = documentContext.querySelector(
        "#use-map-window-for-raster"
    );
    const vectorChoice = documentContext.querySelector("#use-vector-for-raster");
    vectorChoice.checked = false;
    wholeChoice.checked = true;
    wholeChoice.dispatchEvent(new Event("change"));
    wholeChoice.checked = false;
    mapBoxChoice.checked = true;
    mapBoxChoice.dispatchEvent(new Event("change"));
    assert.equal(view.isSamplingBoxSelected(), true);
    mapBoxChoice.checked = false;
    vectorChoice.checked = true;
    vectorChoice.dispatchEvent(new Event("change"));

    assert.deepEqual(received, ["whole", "box", "vector"]);
    assert.equal(
        documentContext.querySelector("#raster-sampling-area-summary").textContent,
        "Sample area · AOI · area.gpkg · boundary"
    );
    view.setClearSampleWindowLabel("Clear selected histogram");
    view.setSamplingAreaMode("none");
    assert.equal(
        documentContext.querySelector("#raster-sampling-area-whole-label")
            .textContent,
        "Clear selected histogram"
    );
    for (const selector of [
        "#clear-raster-sample-window",
        "#use-map-window-for-raster",
    ]) {
        assert.equal(
            documentContext.querySelector(selector).checked,
            false
        );
    }
    assert.throws(
        () => view.setClearSampleWindowLabel(""),
        /must not be blank/
    );
});

test("composed controls present one catalog selection consistently", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    for (const mode of ["vector", "catalogSelection"]) {
        view.setSamplingAreaMode(mode, "Vector selection · Peru");
        assert.equal(documentContext.querySelector("#use-vector-for-raster").checked, true);
    }
    assert.equal(view.setTemporaryAoiAvailability, undefined);
});

test("RasterControlsView clears histogram visibility through its DOM contract", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    const chart = documentContext.querySelector("#raster-histogram-chart");
    chart.append(new FakeControlElement());

    view.clearStatistics();

    assert.equal(chart.children.length, 0);
    assert.equal(chart.getAttribute("hidden"), "");
    assert.equal(documentContext.querySelector("#retry-raster-statistics").hidden, true);
});

test("RasterControlsView delegates retained histogram summaries", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterControlsView(documentContext);

    view.renderLayerHistograms([
        {
            key: "retained-raster",
            canCalculate: true,
            label: "retained-raster.tif",
            state: "ready",
            counts: [1, 3, 2],
        },
    ], "retained-raster");
    view.setActiveLayer("retained-raster.tif");

    assert.equal(
        documentContext.querySelector("#raster-histogram-list").children.length,
        1
    );
    assert.equal(
        documentContext.querySelector("#raster-histogram-detail-layer")
            .textContent,
        "retained-raster.tif"
    );
    assert.equal(
        documentContext.querySelector("#raster-appearance-layer").textContent,
        ""
    );
    assert.equal(documentContext.querySelector("#retry-raster-statistics").disabled, false);
});

test("RasterControlsView updates histogram availability without hiding vector-area editing", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    const box = documentContext.querySelector("#use-map-window-for-raster");
    const vector = documentContext.querySelector("#use-vector-for-raster");
    const histogram = documentContext.querySelector("#raster-histogram");
    const samplingStatus = documentContext.querySelector(
        "#raster-sample-window-status"
    );
    const appearance = documentContext.querySelector(
        "#raster-appearance-controls"
    );

    view.setStatisticsBusy(true);
    view.setStatisticsStatus("Calculating selected-area histogram...");
    view.setSampleWindowStatus("Selected geographic map window.");
    view.setControlsVisible(false);

    assert.equal(box.disabled, true);
    assert.equal(vector.disabled, false);
    assert.equal(histogram.hidden, true);
    assert.equal(histogram.getAttribute("aria-busy"), "true");
    assert.equal(
        documentContext.querySelector("#raster-histogram-status").textContent,
        "Calculating selected-area histogram..."
    );
    assert.equal(samplingStatus.textContent, "Selected geographic map window.");
    assert.equal(appearance.hidden, false);

    view.setControlsVisible(true);
    assert.equal(box.disabled, false);
    assert.equal(histogram.hidden, false);
    assert.equal(appearance.hidden, false);
    view.setRenderingControlsAvailable(true);
    assert.equal(appearance.hidden, false);
    view.showHistogramWidget();
    assert.equal(histogram.hidden, false);
    assert.equal(histogram.getAttribute("aria-busy"), "true");
    assert.equal(samplingStatus.textContent, "Selected geographic map window.");
});

test("RasterControlsView reveals a successful histogram presentation", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterControlsView(documentContext);
    const chart = documentContext.querySelector("#raster-histogram-chart");
    chart.namespaceURI = "http://www.w3.org/2000/svg";
    chart.setAttribute("hidden", "");

    view.renderHistogram(RASTER_STATISTICS, DEFAULT_RASTER_STYLE);

    assert.equal(chart.getAttribute("hidden"), null);
    assert.equal(
        chart.children.filter(
            (child) => child.classNames.includes("raster-histogram-bar")
        ).length,
        64
    );
    assert.equal(
        chart.children.filter(
            (child) => child.classNames.includes("chart-tooltip")
        ).length,
        1
    );
    assert.equal(chart.getAttribute("viewBox"), "0 0 640 190");
    assert.match(chart.getAttribute("aria-label"), /percentage of valid sampled pixels/);

});

test("RasterControlsView labels exact bounded histogram provenance", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterControlsView(documentContext);
    const chart = documentContext.querySelector("#raster-histogram-chart");
    chart.namespaceURI = "http://www.w3.org/2000/svg";

    view.renderHistogram(EXACT_RASTER_STATISTICS, DEFAULT_RASTER_STYLE, "Raster value (K)");

    assert.match(chart.children[0].textContent, /^Exact bounded band 1/);
    assert.match(chart.getAttribute("aria-label"), /^Exact bounded band 1/);
    assert.match(chart.getAttribute("aria-label"), /Horizontal axis: Raster value \(K\)/);
});

test("RasterControlsView rejects an incomplete application document", () => {
    assert.throws(
        () => new RasterControlsView({ querySelector: () => null }),
        /Required raster control is missing: #raster-appearance-controls/
    );
});

test("RasterControlsView exposes the current raster viewer controls", () => {
    const view = new RasterControlsView(new FakeRasterDocument());
    const expectedMethods = [
        "populatePalettes",
        "setActiveLayer",
        "renderLayerHistograms",
        "bind",
        "unbind",
        "readStyle",
        "setStyle",
        "cancelCategoricalImport",
        "getPaletteName",
        "setPaletteName",
        "renderStyleError",
        "renderLegend",
        "clearStatistics",
        "setStatisticsBusy",
        "setStatisticsStatus",
        "renderHistogram",
        "clearHistogram",
        "setStatisticsRetryVisible",
        "setSampleWindowSize",
        "setSampleWindowInvalid",
        "setSampleWindowStatus",
        "setClearSampleWindowLabel",
        "setSamplingAreaMode",
        "showHistogramWidget",
        "setRenderingControlsAvailable",
        "setControlsVisible",
    ];

    for (const methodName of expectedMethods) {
        assert.equal(typeof view[methodName], "function", methodName);
    }
});

test("RasterControlsView forwards import cancellation without committing category drafts", async () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    view.bind({ onCategoricalStyleChange: () => assert.fail("Cancellation cannot commit") });
    let resolveRead;
    const fileRead = new Promise(resolve => { resolveRead = resolve; });
    const input = documentContext.querySelector("#raster-category-csv-file");
    input.files = [{ name: "pending.csv", size: 100, arrayBuffer: () => fileRead }];
    input.dispatchEvent(new Event("change"));
    view.cancelCategoricalImport();
    resolveRead(new TextEncoder().encode("value,label,color\n1,Forest,#112233").buffer);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(documentContext.querySelector("#raster-category-csv-preview").hidden, true);
    assert.equal(documentContext.querySelector("#raster-category-csv-status").textContent, "");
    assert.throws(() => view.readCategoricalStyle(), /Category 1 value/);
});
