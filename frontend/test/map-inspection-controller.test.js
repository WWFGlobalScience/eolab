import assert from "node:assert/strict";
import test from "node:test";
import { MapInspectionController } from "../src/map-inspection-controller.js";
import { FakeRasterControlDocument } from "../test-support/raster/fake-controls-document.js";

/** Build a retained, non-modal map surface with focus and lifecycle spies. */
function fixture() {
    const doc = new FakeRasterControlDocument();
    const events = new EventTarget();
    doc.addEventListener = events.addEventListener.bind(events);
    doc.removeEventListener = events.removeEventListener.bind(events);
    doc.dispatchEvent = events.dispatchEvent.bind(events);
    const root = doc.querySelector("#map-inspection");
    const histogram = doc.querySelector("#map-histogram-panel");
    const style = doc.querySelector("#layer-style-editor");
    const feature = doc.querySelector("#vector-feature-inspector");
    const featureDetails = doc.querySelector("#vector-feature-inspector-details");
    const featureDetailsToggle = doc.querySelector(
        "#toggle-vector-inspector-details"
    );
    const vectorTimeSeries = doc.querySelector("#vector-time-series");
    const vectorFeatureProfile = doc.querySelector("#vector-feature-profile");
    doc.querySelector("#vector-filter-panel").hidden = true;
    doc.querySelector("#downloads-panel").hidden = true;
    doc.querySelector("#calculations-panel").hidden = true;
    histogram.hidden = style.hidden = feature.hidden =
        vectorTimeSeries.hidden = vectorFeatureProfile.hidden = true;
    const close = doc.querySelector("#close-map-histogram");
    histogram.append(close);
    const calls = [];
    root.showPopover = () => calls.push("show");
    root.hidePopover = () => calls.push("hide");
    const controller = new MapInspectionController({ documentContext: doc });
    return {
        doc,
        histogram,
        style,
        feature,
        featureDetails,
        featureDetailsToggle,
        vectorTimeSeries,
        vectorFeatureProfile,
        panels: doc.querySelector("#map-inspection-panels"),
        dockTitle: doc.querySelector("#map-inspection-dock-title"),
        minimizeButton: doc.querySelector("#toggle-map-inspection-dock"),
        featureTab: doc.querySelector("#map-inspection-tab-feature"),
        timeSeriesTab: doc.querySelector("#map-inspection-tab-time-series"),
        featureProfileTab: doc.querySelector("#map-inspection-tab-feature-profile"),
        histogramTab: doc.querySelector("#map-inspection-tab-histogram"),
        styleTab: doc.querySelector("#map-inspection-tab-style"),
        close,
        calls,
        controller,
        analysisToolsButton: doc.querySelector("#open-analysis-tools"),
        map: doc.querySelector("#map"),
    };
}

test("automatic presentation does not move focus and close retains results", () => {
    const h = fixture();
    const chart = h.doc.createElement();
    chart.textContent = "Sampled drought distribution";
    h.histogram.append(chart);
    h.map.focus();
    h.controller.showHistogram();
    h.controller.showHistogram();
    assert.deepEqual(h.calls, ["show"]);
    assert.equal(h.doc.activeElement, h.map);
    assert.equal(h.histogram.hidden, false);
    assert.equal(h.analysisToolsButton.hidden, true);

    h.close.dispatchEvent(new Event("click"));
    assert.equal(h.histogram.hidden, true);
    assert.equal(h.analysisToolsButton.hidden, false);
    assert.equal(h.doc.activeElement, h.map);
    assert.deepEqual(h.calls, ["show", "hide"]);

    h.controller.showHistogram();
    assert.equal(h.histogram.children.at(-1), chart);
    assert.equal(chart.textContent, "Sampled drought distribution");
    assert.deepEqual(h.calls, ["show", "hide", "show"]);
    h.controller.destroy();
});

test("map-click summaries retain the chosen panel and expose unseen peer results", () => {
    const h = fixture();
    h.controller.showHistogram();
    h.map.focus();
    h.controller.beginMapClick({lat: 22, lng: 78});
    h.controller.showHistogram(null, {activate: false});
    h.controller.showFeatureInspector({activate: false});
    h.controller.setClickResult("histogram", {state: "loading", message: "Map box · Updating…"});
    h.controller.setClickResult("feature", {state: "ready", message: "3 features returned"});
    assert.equal(h.controller.activeTool, "histogram");
    assert.equal(h.doc.activeElement, h.map);
    assert.equal(h.doc.querySelector("#map-click-feature").getAttribute("data-unread"), "true");
    assert.equal(h.histogram.getAttribute("data-inspection-loading"), "true");
    h.doc.querySelector("#map-click-feature").dispatchEvent(new Event("click"));
    assert.equal(h.controller.activeTool, "feature");
    assert.equal(h.doc.querySelector("#map-click-feature").getAttribute("data-unread"), "false");
    h.controller.setClickResult("histogram", {state: "ready", message: "Map box · Ready"});
    assert.equal(h.controller.activeTool, "feature");
    assert.equal(h.histogramTab.getAttribute("data-unread"), "true");
    h.controller.beginMapClick({lat: 24, lng: 80});
    h.controller.showHistogram(null, {activate: false});
    h.controller.showFeatureInspector({activate: false});
    assert.equal(h.controller.activeTool, "feature");
    assert.equal(h.histogramTab.getAttribute("data-unread"), "false");
    assert.match(h.dockTitle.textContent, /24\.0000, 80\.0000/);
    h.controller.destroy();
});

test("result cards replace duplicate tabs while other tools remain keyboard accessible", () => {
    const h = fixture();
    const tabs = h.doc.querySelector("#map-inspection-tabs");
    const raster = h.doc.querySelector("#map-click-histogram");
    const feature = h.doc.querySelector("#map-click-feature");
    h.controller.showHistogram();
    h.controller.showFeatureInspector({activate: false});
    assert.equal(h.dockTitle.textContent, "Map tools");
    assert.equal(h.histogramTab.hidden, false);
    h.controller.beginMapClick({lat: 22, lng: 78});
    h.controller.setClickResult("histogram", {state: "ready", message: "Ready"});
    h.controller.setClickResult("feature", {state: "ready", message: "One feature"});
    assert.equal(h.histogramTab.hidden, true);
    assert.equal(h.featureTab.hidden, true);
    assert.equal(tabs.hidden, true);
    assert.equal(raster.getAttribute("aria-pressed"), "true");
    assert.equal(feature.getAttribute("aria-pressed"), "false");
    h.controller.showStyle("Countries");
    h.controller.showCalculations();
    raster.dispatchEvent(new Event("click"));
    assert.equal(tabs.hidden, false);
    const calculationsTab = h.doc.querySelector("#map-inspection-tab-calculations");
    assert.equal(calculationsTab.tabIndex, 0, "other tools remain reachable from a selected result card");
    const end = new Event("keydown");
    Object.defineProperty(end, "key", {value: "End"});
    calculationsTab.dispatchEvent(end);
    assert.equal(h.doc.activeElement, h.styleTab, "keyboard navigation skips replaced tabs");
    assert.equal(raster.getAttribute("aria-pressed"), "false");
    feature.dispatchEvent(new Event("click"));
    assert.equal(feature.getAttribute("aria-pressed"), "true");
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(tabs.hidden, true);
    assert.equal(h.doc.querySelector("#map-click-summary").hidden, true);
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(feature.getAttribute("aria-pressed"), "true");
    h.controller.setClickResult("histogram", null);
    assert.equal(h.histogramTab.hidden, false, "retained histogram remains reachable without a click card");
    h.controller.destroy();
});

test("empty and failed streams remain understandable without opening unavailable results", () => {
    const h = fixture();
    h.controller.beginMapClick({lat: 0, lng: 0});
    h.controller.setClickResult("histogram", null);
    h.controller.setClickResult("feature", {state: "empty", message: "No features at this click"});
    assert.equal(h.doc.querySelector("#map-click-histogram").hidden, true);
    assert.equal(h.doc.querySelector("#map-click-feature").disabled, true);
    assert.equal(h.controller.activeTool, null);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.setClickResult("feature", {state: "error", message: "Inspection unavailable"});
    h.doc.querySelector("#map-click-feature").dispatchEvent(new Event("click"));
    assert.equal(h.controller.activeTool, "feature");
    h.controller.showCalculations();
    h.controller.beginMapClick({lat: 1, lng: 1});
    h.controller.showFeatureInspector({activate:false});
    h.controller.showHistogram(null, {activate:false});
    assert.equal(h.controller.activeTool, "calculations");
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.doc.querySelector("#map-click-summary").hidden, true);
    h.controller.destroy();
});

test("History and exports is transient while retained analysis results remain available", () => {
    const h = fixture();
    h.controller.showHistogram();
    h.controller.showDownloads();
    const downloads = h.doc.querySelector("#downloads-panel");
    assert.equal(downloads.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.histogram.hidden, false);
    h.histogramTab.dispatchEvent(new Event("click"));
    assert.equal(downloads.hidden, true);
    assert.equal(h.histogram.getAttribute("data-map-inspection-active"), "true");
    h.controller.showDownloads();
    h.controller.hideDownloads();
    assert.equal(downloads.hidden, true);
    assert.equal(h.histogram.getAttribute("data-map-inspection-active"), "true");
    h.controller.destroy();
});

test("active-tool subscriptions report expanded presentation, support detachment, and clear on destroy", () => {
    const h = fixture(); const changes = [];
    const unsubscribe = h.controller.subscribeActiveTool(tool => changes.push(tool));
    h.controller.showCalculations();
    h.controller.showHistogram(1, {activate:false});
    h.controller.showFeatureInspector({activate:false});
    assert.deepEqual(changes, [null, "calculations"]);
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.dockTitle.textContent, "Map tools · Summarize");
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.dockTitle.textContent, "Map tools");
    h.histogramTab.dispatchEvent(new Event("click"));
    assert.deepEqual(changes, [null, "calculations", null, "calculations", "histogram"]);
    unsubscribe(); h.controller.showDownloads();
    assert.equal(changes.at(-1), "histogram");
    const final = []; h.controller.subscribeActiveTool(tool => final.push(tool));
    h.controller.destroy(); assert.deepEqual(final, ["downloads", null]);
});

test("histogram and style have independent visibility on one persistent surface", () => {
    const h = fixture();
    h.controller.showStyle("Coastal resistance.tif");
    assert.equal(h.analysisToolsButton.hidden, true);
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.styleTab.getAttribute("aria-selected"), "true");
    assert.equal(h.styleTab.textContent, "Style · Coastal resistance.tif");
    assert.equal(h.styleTab.title, "Style Coastal resistance.tif");
    h.controller.showHistogram(2);
    assert.equal(h.style.hidden, false);
    assert.equal(h.histogram.hidden, false);
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "false");
    assert.equal(h.histogram.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.styleTab.hidden, false);
    assert.equal(h.histogramTab.hidden, false);
    assert.equal(h.histogramTab.textContent, "Raster histograms");
    assert.equal(h.histogramTab.title, "2 raster results");
    h.controller.closeHistogram();
    assert.equal(h.style.hidden, false);
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.analysisToolsButton.hidden, true);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.showHistogram();
    h.controller.hideStyle();
    assert.equal(h.histogram.hidden, false);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.destroy();
    assert.equal(h.analysisToolsButton.hidden, false);
    assert.deepEqual(h.calls, ["show", "hide"]);
});

test("automatic histogram cleanup retains features and current focus", () => {
    const h = fixture();
    h.controller.showFeatureInspector();
    h.controller.showHistogram(1);
    h.featureTab.focus();

    h.controller.closeHistogram(false);

    assert.equal(h.histogram.hidden, true);
    assert.equal(h.histogramTab.hidden, true);
    assert.equal(h.feature.hidden, false);
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.doc.activeElement, h.featureTab);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.destroy();
});

test("combined map results prefer counted features and retain style context", () => {
    const h = fixture();
    h.controller.showStyle("Parcels");
    h.controller.showHistogram(1);
    h.controller.showFeatureInspector();
    assert.equal(h.featureTab.textContent, "Features…");
    assert.equal(h.featureTab.title, "Inspecting vector features");
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "true");

    h.controller.setFeatureResultCount(1, { loading: true });
    assert.equal(h.featureTab.textContent, "Features · 1…");
    assert.equal(
        h.featureTab.title,
        "1 feature found; vector inspection continues"
    );
    h.controller.setFeatureResultCount(3);
    assert.equal(h.featureTab.textContent, "Features · 3");
    assert.equal(
        h.featureTab.title,
        "3 features at the selected map location"
    );
    assert.equal(h.histogram.hidden, false);
    assert.equal(h.style.hidden, false);

    h.controller.hideFeatureInspector();
    assert.equal(h.featureTab.textContent, "Features");
    assert.equal(h.histogram.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.styleTab.textContent, "Style · Parcels");
    h.controller.hideStyle();
    assert.equal(h.styleTab.textContent, "Style");
    h.controller.destroy();
});

test("map result counts reject invalid presentation values", () => {
    const h = fixture();
    for (const count of [-1, 1.5, NaN]) {
        assert.throws(
            () => h.controller.showHistogram(count),
            /non-negative integer/
        );
        assert.throws(
            () => h.controller.setFeatureResultCount(count),
            /non-negative integer/
        );
    }
    assert.throws(() => h.controller.showStyle(""), /non-empty string/);
    assert.throws(
        () => h.controller.setVectorTimeSeriesIdentity({ label: "", title: "x" }),
        /non-empty label and title/
    );
    assert.throws(
        () => h.controller.setVectorFeatureProfileIdentity({
            label: "Feature · A",
            title: "",
        }),
        /non-empty label and title/
    );
    h.controller.destroy();
});

test("vector feature inspection shares the map-side surface independently", () => {
    const h = fixture();
    const retainedResult = h.doc.createElement();
    retainedResult.textContent = "R2024: -13.09";
    h.feature.append(retainedResult);
    h.controller.showFeatureInspector();
    assert.equal(h.feature.hidden, false);
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "true");
    assert.deepEqual(h.calls, ["show"]);
    h.controller.showStyle();
    assert.equal(h.feature.hidden, false);
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "false");
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "true");
    h.featureTab.dispatchEvent(new Event("click"));
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "false");
    assert.equal(retainedResult.textContent, "R2024: -13.09");
    h.controller.hideFeatureInspector();
    assert.equal(h.style.hidden, false);
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "true");
    assert.deepEqual(h.calls, ["show"]);
    h.controller.hideStyle();
    assert.deepEqual(h.calls, ["show", "hide"]);
    h.controller.destroy();
});

test("dock minimization retains open tools and selecting a tab expands it", () => {
    const h = fixture();
    h.controller.showFeatureInspector();
    h.controller.showStyle();

    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, true);
    assert.equal(h.minimizeButton.textContent, "Expand");
    assert.equal(h.minimizeButton.getAttribute("aria-expanded"), "false");
    assert.equal(h.feature.hidden, false);
    assert.equal(h.style.hidden, false);
    assert.equal(h.styleTab.getAttribute("aria-selected"), "true");

    h.featureTab.dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, false);
    assert.equal(h.minimizeButton.textContent, "Minimize");
    assert.equal(h.minimizeButton.getAttribute("aria-expanded"), "true");
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "false");
    h.controller.destroy();
});

test("open dock tabs support wrapping horizontal keyboard navigation", () => {
    const h = fixture();
    h.controller.showFeatureInspector();
    h.controller.showStyle();
    h.styleTab.focus();

    const left = new Event("keydown", { cancelable: true });
    Object.defineProperty(left, "key", { value: "ArrowLeft" });
    h.styleTab.dispatchEvent(left);
    assert.equal(left.defaultPrevented, true);
    assert.equal(h.doc.activeElement, h.featureTab);
    assert.equal(h.featureTab.getAttribute("aria-selected"), "true");

    const right = new Event("keydown", { cancelable: true });
    Object.defineProperty(right, "key", { value: "ArrowRight" });
    h.featureTab.dispatchEvent(right);
    assert.equal(right.defaultPrevented, true);
    assert.equal(h.doc.activeElement, h.styleTab);
    assert.equal(h.styleTab.getAttribute("aria-selected"), "true");
    h.controller.destroy();
});

test("vector time series is an independent retained map-side panel", () => {
    const h = fixture();
    h.controller.setVectorTimeSeriesIdentity({
        label: "R2024 · 4 features",
        title: "R2024 across 4 features · Layer: corridors.shp",
    });
    h.controller.showFeatureInspector();
    h.controller.showVectorTimeSeries();
    assert.equal(h.feature.hidden, false);
    assert.equal(h.vectorTimeSeries.hidden, false);
    assert.equal(h.vectorFeatureProfile.hidden, true);
    assert.equal(h.timeSeriesTab.textContent, "R2024 · 4 features");
    assert.equal(
        h.timeSeriesTab.title,
        "R2024 across 4 features · Layer: corridors.shp"
    );
    assert.deepEqual(h.calls, ["show"]);
    h.controller.hideFeatureInspector();
    assert.equal(h.vectorTimeSeries.hidden, false);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.hideVectorTimeSeries(true);
    assert.equal(h.doc.activeElement, h.map);
    assert.deepEqual(h.calls, ["show", "hide"]);
    h.controller.setVectorTimeSeriesIdentity(null);
    assert.equal(h.timeSeriesTab.textContent, "Field across features");
});

test("feature details collapse without closing retained series state", () => {
    const h = fixture();
    h.controller.showFeatureInspector();
    h.controller.showVectorTimeSeries();
    h.featureDetailsToggle.dispatchEvent(new Event("click"));
    assert.equal(h.feature.hidden, false);
    assert.equal(h.featureDetails.hidden, true);
    assert.equal(h.featureDetailsToggle.getAttribute("aria-expanded"), "false");
    assert.equal(h.featureDetailsToggle.textContent, "Expand");
    assert.equal(h.vectorTimeSeries.hidden, false);
    assert.deepEqual(h.calls, ["show"]);

    h.controller.showFeatureInspector();
    assert.equal(h.featureDetails.hidden, true);
    assert.equal(h.vectorTimeSeries.hidden, false);

    h.featureDetailsToggle.dispatchEvent(new Event("click"));
    assert.equal(h.featureDetails.hidden, false);
    assert.equal(h.featureDetailsToggle.getAttribute("aria-expanded"), "true");
    assert.equal(h.featureDetailsToggle.textContent, "Collapse");
    h.controller.destroy();
});

test("the two series modes share one exclusive presentation position", () => {
    const h = fixture();
    h.controller.setVectorFeatureProfileIdentity({
        label: "Feature · Northern corridor",
        title: "Fields from Northern corridor · Layer: corridors.shp",
    });
    h.controller.showFeatureInspector();
    h.controller.showVectorTimeSeries();
    h.controller.showVectorFeatureProfile();
    assert.equal(h.feature.hidden, false);
    assert.equal(h.vectorTimeSeries.hidden, true);
    assert.equal(h.vectorFeatureProfile.hidden, false);
    assert.equal(h.featureProfileTab.textContent, "Feature · Northern corridor");
    h.controller.showVectorTimeSeries();
    assert.equal(h.vectorTimeSeries.hidden, false);
    assert.equal(h.vectorFeatureProfile.hidden, true);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.hideVectorTimeSeries();
    h.controller.hideFeatureInspector();
    assert.deepEqual(h.calls, ["show", "hide"]);
});

test("Escape is focus-scoped and destroy detaches presentation listeners", () => {
    const h = fixture();
    /** Dispatch one keyboard Escape at the owning document. */
    const escape = () => {
        const event = new Event("keydown", { cancelable: true });
        Object.defineProperty(event, "key", { value: "Escape" });
        h.doc.dispatchEvent(event);
        return event.defaultPrevented;
    };
    h.controller.showHistogram();
    h.map.focus();
    assert.equal(escape(), false);
    assert.equal(h.histogram.hidden, false);
    h.close.focus();
    assert.equal(escape(), true);
    assert.equal(h.histogram.hidden, true);
    h.controller.destroy();
    h.close.dispatchEvent(new Event("click"));
    assert.equal(escape(), false);
    assert.equal(h.histogram.hidden, true);
    assert.deepEqual(h.calls, ["show", "hide"]);
});


test("closing the last tool hides its empty surface while result cards remain usable", () => {
    const h = fixture();
    h.controller.beginMapClick({ lat: -10, lng: -60 });
    h.controller.setClickResult("histogram", { state: "ready", message: "1 raster ready" });
    h.controller.showHistogram(1);
    const results = h.doc.querySelector("#map-click-summary");
    const reopen = h.doc.querySelector("#map-click-histogram");
    assert.equal(h.panels.hidden, false);

    h.close.dispatchEvent(new Event("click"));

    assert.equal(h.histogram.hidden, true);
    assert.equal(h.panels.hidden, true, "the empty top-layer container must not intercept map clicks");
    assert.equal(results.hidden, false);
    assert.equal(reopen.disabled, false);
    assert.deepEqual(h.calls, ["show"], "retained results keep their popover");
    assert.equal(h.doc.activeElement, h.map);

    h.minimizeButton.dispatchEvent(new Event("click"));
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, true, "expanding only the result cards must not restore an empty surface");

    reopen.dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, false);
    assert.equal(h.histogram.hidden, false);
    h.controller.showStyle("Raster");
    h.controller.showHistogram(1);
    h.close.dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, false, "an open fallback tool still needs its surface");
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "true");
    h.controller.hideStyle();
    assert.equal(h.panels.hidden, true);
    h.controller.destroy();
});
