import assert from "node:assert/strict";
import test from "node:test";

import {
    RasterHistogramControlsView,
} from "../../src/raster/histogram-controls-view.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";
import { RASTER_STATISTICS } from "../../test-support/raster/fixtures.js";
import { createFakeResizeObservers } from "../../test-support/raster/fakes.js";
import {
    FakeRasterControlDocument,
    FakeRasterControlElement,
} from "../../test-support/raster/fake-controls-document.js";

test("an empty vector histogram describes the missing area instead of missing rasters", () => {
    const doc = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(doc);
    view.renderLayerHistograms([], null);
    view.setSamplingAreaMode("vector");
    const empty = doc.querySelector("#raster-histogram-empty");
    assert.equal(empty.hidden, false);
    assert.equal(empty.textContent, "No polygon sample area is available.");
    view.setSamplingAreaMode("wholeRaster");
    assert.match(empty.textContent, /No visible raster layers/);
    view.unbind();
});

test("histogram adapter owns status, chart, retry, and direct presentation", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(documentContext);
    const received = [];
    view.bind({
        onRetryStatistics: () => received.push("retry"),
    });
    view.setActiveRasterAvailable(true);
    view.setSamplingAreaMode("selectedArea");
    view.showWidget();
    view.setStatisticsBusy(true);
    view.setStatisticsStatus("Ready.");
    view.renderHistogram(RASTER_STATISTICS, DEFAULT_RASTER_STYLE);
    view.setStatisticsRetryVisible(true);
    view.enableActiveRasterActions();

    documentContext.querySelector("#retry-raster-statistics")
        .dispatchEvent(new Event("click"));

    assert.deepEqual(received, ["retry"]);
    assert.equal(
        documentContext.querySelector("#raster-histogram").hidden,
        false
    );
    assert.deepEqual(
        documentContext.querySelector("#raster-histogram").scrollRequests,
        []
    );
    assert.equal(
        documentContext.querySelector("#raster-histogram")
            .getAttribute("aria-busy"),
        "true"
    );
    assert.equal(
        documentContext.querySelector("#raster-histogram-chart")
            .getAttribute("hidden"),
        null
    );
    view.clearStatistics();
    assert.equal(
        documentContext.querySelector("#raster-histogram-chart")
            .getAttribute("hidden"),
        ""
    );

    view.setActiveRasterAvailable(false);
    assert.equal(
        documentContext.querySelector("#raster-histogram").hidden,
        true
    );
    view.setActiveRasterAvailable(true);
    view.showWidget(true);
    assert.equal(
        documentContext.activeElement,
        documentContext.querySelector("#raster-histogram-chart")
    );

    view.unbind();
    documentContext.querySelector("#retry-raster-statistics")
        .dispatchEvent(new Event("click"));
    assert.equal(received.length, 1);
});

test("histogram adapter clears an independently populated chart", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(documentContext);
    const chart = documentContext.querySelector("#raster-histogram-chart");
    chart.append(new FakeRasterControlElement());

    view.clearHistogram();

    assert.equal(chart.children.length, 0);
    assert.equal(chart.getAttribute("hidden"), "");
});

test("unchanged cards retain chart observers; changed cards and unbinding release them", () => {
    const doc = new FakeRasterControlDocument();
    const { ResizeObserver, instances } = createFakeResizeObservers();
    doc.defaultView = { ResizeObserver };
    const view = new RasterHistogramControlsView(doc);
    const summary = { key: "first", label: "drought.tif", canCalculate: true,
        automatic: true, state: "ready", counts: RASTER_STATISTICS.histogram.counts,
        statistics: RASTER_STATISTICS, style: DEFAULT_RASTER_STYLE };
    view.renderLayerHistograms([summary], "first");
    const replaced = instances[0].target;
    view.renderLayerHistograms([summary], "first");
    assert.equal(instances.length, 1);
    assert.equal(instances[0].disconnected, false);
    view.renderLayerHistograms([{ ...summary, label: "Renamed raster" }], "first");
    assert.equal(instances[0].disconnected, true);
    instances[0].resize(391);
    assert.equal(replaced.children.length, 0);
    view.renderHistogram(RASTER_STATISTICS, DEFAULT_RASTER_STYLE);
    view.unbind();
    assert.equal(instances.length, 3);
    assert.ok(instances.every(observer => observer.disconnected));
});

test("pending and failed summaries do not present cached charts as the current sample", () => {
    const doc = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(doc);
    const summary = {
        key: "first", label: "drought.tif", canCalculate: true,
        automatic: true, counts: [1, 4, 2], statistics: RASTER_STATISTICS,
        style: DEFAULT_RASTER_STYLE, valueLabel: "Raster value (%)",
    };
    const list = doc.querySelector("#raster-histogram-list");
    for (const state of ["loading", "error", "ready"]) {
        view.renderLayerHistograms([{ ...summary, state }], "first");
        const row = list.children[0];
        assert.equal(row.children[0].title, "drought.tif");
        assert.equal(row.children.some(child => child.classList.contains("raster-histogram-chart")), state === "ready");
        assert.equal(row.children[1].textContent, {
            loading: "Updating histogram…", error: "Histogram unavailable", ready: "",
        }[state]);
        assert.equal(row.children[1].hidden, state === "ready");
        if (state === "ready") {
            assert.equal(row.children[2].classList.contains("raster-histogram-chart"), true);
            assert.equal(row.children[2].getAttribute("viewBox"), "0 0 640 190");
            assert.match(row.children[2].getAttribute("aria-label"), /Horizontal axis: Raster value \(%\)/);
        }
    }
    view.renderLayerHistograms([{ ...summary, state: "error", errorMessage: "No finite pixels in this sample." }], "first");
    assert.equal(list.children[0].children[1].textContent, "Histogram unavailable: No finite pixels in this sample.");
});

test("unavailable presentation replaces continuous charts without changing lifecycle or actions", () => {
    const doc = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(doc);
    const actions = [];
    view.bind({
        onStyleHistogram: (key) => actions.push(["style", key]),
        onCalculateHistogram: (key) => actions.push(["summarize", key]),
        onDownloadHistogram: (key) => actions.push(["download", key]),
    });
    const unavailableMessage = "Categorical area summaries are not available yet.";
    const list = doc.querySelector("#raster-histogram-list");
    for (const automatic of [false, true]) {
        for (const state of ["idle", "loading", "ready", "error"]) {
            const summary = Object.freeze({
                key: "landcover", label: "landcover.tif", canCalculate: true,
                automatic, state, counts: RASTER_STATISTICS.histogram.counts,
                statistics: RASTER_STATISTICS, style: DEFAULT_RASTER_STYLE,
                unavailableMessage,
            });
            view.renderLayerHistograms([summary], "landcover");
            const row = list.children[0];
            const content = automatic ? row : row.children[0];
            assert.equal(content.children[1].textContent, unavailableMessage);
            assert.equal(content.children[1].hidden, false);
            assert.equal(content.children[1].getAttribute("role"), "status");
            assert.equal(content.children.some((child) =>
                child.classList.contains("raster-histogram-chart") ||
                child.classList.contains("raster-histogram-summary-preview")
            ), false);
            assert.equal(view.summaryCards.get("landcover").axisControls, null);
            assert.equal(summary.state, state);
        }
    }
    for (const button of list.children[0].children.at(-1).children) {
        button.dispatchEvent(new Event("click"));
    }
    assert.deepEqual(actions, [
        ["style", "landcover"], ["summarize", "landcover"], ["download", "landcover"],
    ]);
    view.unbind();
});

test("unavailable presentation releases previous chart observers and can resume ordinary charts", () => {
    const doc = new FakeRasterControlDocument();
    const { ResizeObserver, instances } = createFakeResizeObservers();
    doc.defaultView = { ResizeObserver };
    const view = new RasterHistogramControlsView(doc);
    const summary = {
        key: "landcover", label: "landcover.tif", canCalculate: true,
        automatic: true, state: "ready", counts: RASTER_STATISTICS.histogram.counts,
        statistics: RASTER_STATISTICS, style: DEFAULT_RASTER_STYLE,
    };
    view.renderLayerHistograms([summary], "landcover");
    const previousChart = instances[0].target;
    view.renderLayerHistograms([{
        ...summary, counts: null, statistics: null,
        unavailableMessage: "Categorical area summaries are not available yet.",
    }], "landcover");
    assert.equal(instances[0].disconnected, true);
    instances[0].resize(391);
    assert.equal(previousChart.children.length, 0);
    assert.equal(instances.length, 1);
    view.renderLayerHistograms([summary], "landcover");
    assert.equal(instances.length, 2);
    assert.ok(view.summaryCards.get("landcover").axisControls);
    assert.throws(() => view.renderLayerHistograms([{
        ...summary, unavailableMessage: false,
    }], "landcover"), /summary is invalid/);
    view.unbind();
});

test("histogram adapter owns labeled per-raster summaries without double binding", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(documentContext);
    const selected = [];
    const styled = [];
    const summarized = [];
    const downloaded = [];
    view.bind({
        onRetryStatistics() {},
        onSelectHistogram: (key) => selected.push(key),
        onStyleHistogram: (key) => styled.push(key),
        onCalculateHistogram: (key) => summarized.push(key),
        onDownloadHistogram: (key) => downloaded.push(key),
    });
    view.setActiveRasterAvailable(true);
    view.setActiveLayer("second-raster.tif");
    const summaries = [
        {
            key: "first",
            label: "first-raster.tif",
            state: "ready",
            canCalculate: true,
            counts: [1, 4, 2],
        },
        {
            key: "second",
            label: "second-raster.tif",
            state: "loading",
            canCalculate: true,
            counts: null,
        },
    ];

    view.renderLayerHistograms(summaries, "second");
    const list = documentContext.querySelector("#raster-histogram-list");
    const firstRow = list.children[0];
    const secondRow = list.children[1];
    const firstButton = firstRow.children[0];
    const secondButton = secondRow.children[0];
    firstButton.dispatchEvent(new Event("click"));
    firstRow.children.at(-1).children[0].dispatchEvent(new Event("click"));
    const actions = firstRow.children.at(-1).children;
    assert.deepEqual(actions.map(button => button.getAttribute("aria-label")), [
        "Style first-raster.tif", "Calculate statistics for first-raster.tif over this area", "Download clip of first-raster.tif",
    ]);
    assert.equal(actions[2].title, "Download clip");
    actions[1].dispatchEvent(new Event("click"));
    actions[2].dispatchEvent(new Event("click"));
    view.showWidget();

    assert.deepEqual(selected, ["first"]);
    assert.deepEqual(styled, ["first"]);
    assert.deepEqual(summarized, ["first"]);
    assert.deepEqual(downloaded, ["first"]);
    assert.equal(list.children.length, 2);
    assert.equal(firstRow.getAttribute("aria-label"),
        "Histogram — first-raster.tif");
    assert.equal(firstButton.getAttribute("aria-label"),
        "Show detailed histogram for first-raster.tif");
    assert.equal(
        firstButton.getAttribute("aria-controls"),
        "raster-histogram"
    );
    assert.equal(firstButton.children.at(-1).classNames.includes(
        "raster-histogram-summary-preview"
    ), true);
    assert.equal(secondButton.getAttribute("aria-expanded"), "true");
    assert.equal(
        documentContext.querySelector("#raster-histogram-empty").hidden,
        true
    );
    assert.equal(
        documentContext.querySelector("#raster-histogram-detail-layer")
            .textContent,
        "second-raster.tif"
    );
    assert.equal(documentContext.querySelector("#raster-histogram-detail-layer").title,
        "second-raster.tif");

    secondButton.focus();
    view.renderLayerHistograms(summaries, "first");
    assert.equal(documentContext.activeElement, list.children[1].children[0]);
    assert.ok(firstButton === list.children[0].children[0]);
    list.children[0].children[0].dispatchEvent(new Event("click"));
    assert.deepEqual(selected, ["first", "first"]);

    view.unbind();
    firstButton.dispatchEvent(new Event("click"));
    assert.equal(list.children.length, 0);
    assert.deepEqual(selected, ["first", "first"]);
});

test("axis edits redraw only the local chart and persist through a new sample", () => {
    const doc = new FakeRasterControlDocument(), view = new RasterHistogramControlsView(doc);
    view.bind({ onRetryStatistics: () => assert.fail("Axes must not request statistics") });
    view.renderHistogram(RASTER_STATISTICS, DEFAULT_RASTER_STYLE);
    const original = structuredClone(RASTER_STATISTICS);
    const fields = view.detailAxisControls.rows.get("y").fields;
    fields.bounds.input.value = "values";
    fields.bounds.input.dispatchEvent(new Event("change"));
    fields.maximum.input.value = "1";
    fields.maximum.input.dispatchEvent(new Event("change"));
    assert.equal(view.detailAxisControls.axes.y.maximum, 1);
    view.renderHistogram({ ...RASTER_STATISTICS }, DEFAULT_RASTER_STYLE);
    assert.equal(view.detailAxisControls.axes.y.maximum, 1);
    assert.deepEqual(RASTER_STATISTICS, original);
    view.clearStatistics();
    assert.equal(view.detailAxesHost.children.length, 0);
    view.unbind();
});

test("another raster completing preserves a pending axis edit and its focused controls", async () => {
    const doc = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(doc);
    const first = { key: "first", label: "drought.tif", canCalculate: true,
        automatic: true, state: "ready", counts: RASTER_STATISTICS.histogram.counts,
        statistics: RASTER_STATISTICS, style: DEFAULT_RASTER_STYLE };
    const second = { ...first, key: "second", label: "rain.tif", state: "loading" };
    view.renderLayerHistograms([first, second], "first");
    const list = doc.querySelector("#raster-histogram-list");
    const card = list.children[0];
    const { root: editor, rows } = view.summaryCards.get("first").axisControls;
    assert.equal(editor.children[1].children[0].textContent, "Bar height (% of pixels)");
    editor.open = true;
    editor.dispatchEvent(new Event("toggle"));
    const { bounds: { input: range }, maximum: { input: maximum } } = rows.get("y").fields;
    range.value = "values";
    range.dispatchEvent(new Event("change"));
    maximum.focus();
    maximum.value = "1";
    maximum.dispatchEvent(new Event("input"));
    view.renderLayerHistograms([structuredClone(first), { ...second, state: "ready" }], "first");
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.ok(list.children[0] === card, "The unchanged card must retain its DOM identity");
    assert.ok(list.contains(maximum));
    assert.ok(doc.activeElement === maximum);
    assert.equal(maximum.value, "1");
    assert.equal(editor.open, true);
    assert.equal(view.axisStates.get("first").options.y.maximum, "1");
    view.unbind();
});

test("card reordering preserves action focus; removing the focused card moves focus and disables old actions", () => {
    const doc = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(doc);
    const styled = [];
    view.bind({ onStyleHistogram: key => styled.push(key) });
    const first = { key: "first", label: "drought.tif", canCalculate: true,
        automatic: true, state: "ready", counts: [1, 2, 3] };
    const second = { ...first, key: "second", label: "rain.tif" };
    view.renderLayerHistograms([first, second], "first");
    const list = doc.querySelector("#raster-histogram-list");
    const firstCard = list.children[0];
    const secondCard = list.children[1];
    const style = firstCard.children.at(-1).children[0];
    style.focus();
    view.renderLayerHistograms([second, first], "first");
    assert.ok(list.children[0] === secondCard && list.children[1] === firstCard);
    assert.ok(doc.activeElement === style);
    style.dispatchEvent(new Event("click"));
    assert.deepEqual(styled, ["first"]);
    view.renderLayerHistograms([second], "second");
    assert.ok(doc.activeElement === secondCard);
    style.dispatchEvent(new Event("click"));
    assert.deepEqual(styled, ["first"]);
    view.renderLayerHistograms([], null);
    assert.ok(doc.activeElement === view.histogramEmpty);
    assert.equal(view.histogramEmpty.hidden, false);
    assert.equal(list.children.length, 0);
    view.unbind();
    view.bind({ onStyleHistogram: key => styled.push(key) });
    view.renderLayerHistograms([first], "first");
    style.dispatchEvent(new Event("click"));
    list.children[0].children.at(-1).children[0].dispatchEvent(new Event("click"));
    assert.deepEqual(styled, ["first", "first"]);
    view.unbind();
});

test("categorical expansion and focus survive another result, then continuous and legacy transitions clean up", () => {
    const doc = new FakeRasterControlDocument();
    const { ResizeObserver, instances } = createFakeResizeObservers();
    doc.defaultView = { ResizeObserver };
    const view = new RasterHistogramControlsView(doc);
    const first = { key: "land", label: "landcover.tif", canCalculate: true,
        automatic: true, state: "ready", counts: null,
        categorical: { validHectares: 15, nodataHectares: 0, sampledPixelCount: 15,
            rows: Array.from({ length: 15 }, (_, code) => ({ code, label: `Class ${code}`,
                hectares: 1, percentage: 100 / 15, color: "#ffffff", opacity: 1 })) } };
    const second = { key: "second", label: "rain.tif", canCalculate: true,
        automatic: true, state: "loading", counts: null };
    view.renderLayerHistograms([first, second], "land");
    const list = doc.querySelector("#raster-histogram-list");
    const card = list.children[0];
    const categoryChart = card.children[2];
    const toggle = categoryChart.children[2];
    toggle.dispatchEvent(new Event("click"));
    toggle.focus();
    view.renderLayerHistograms([structuredClone(first), { ...second, state: "error", canRetry: true }], "land");
    assert.ok(list.children[0] === card);
    assert.ok(doc.activeElement === toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(categoryChart.children[1].children.length, 15);
    const continuous = { ...first, categorical: null, statistics: RASTER_STATISTICS,
        style: DEFAULT_RASTER_STYLE, counts: RASTER_STATISTICS.histogram.counts };
    view.renderLayerHistograms([continuous], "land");
    assert.ok(view.summaryCards.get("land").axisControls);
    assert.equal(instances.length, 1);
    view.renderLayerHistograms([{ ...first, automatic: false }], "land");
    assert.equal(instances[0].disconnected, true);
    const legacyCard = view.summaryCards.get("land");
    assert.equal(legacyCard.axisControls, null);
    const restoredChart = legacyCard.root.children[1];
    assert.equal(restoredChart.className, "categorical-area-chart");
    assert.ok(!legacyCard.button.contains(restoredChart), "Category controls must not be nested inside a button");
    assert.equal(restoredChart.children[2].getAttribute("aria-expanded"), "true");
    view.unbind();
});

test("invalid axis drafts survive unrelated updates; removal and unbinding cancel pending edits", async () => {
    const doc = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(doc);
    const first = { key: "first", label: "drought.tif", canCalculate: true,
        automatic: true, state: "ready", counts: RASTER_STATISTICS.histogram.counts,
        statistics: RASTER_STATISTICS, style: DEFAULT_RASTER_STYLE };
    view.renderLayerHistograms([first], "first");
    const editor = view.summaryCards.get("first").axisControls;
    const { fields, status } = editor.rows.get("y");
    fields.bounds.input.value = "values";
    fields.bounds.input.dispatchEvent(new Event("change"));
    fields.maximum.input.value = "-1";
    fields.maximum.input.dispatchEvent(new Event("change"));
    assert.match(status.textContent, /Chart unchanged/);
    const error = status.textContent;
    view.renderLayerHistograms([first, { ...first, key: "second", state: "error" }], "first");
    assert.ok(view.summaryCards.get("first").axisControls === editor);
    assert.equal(fields.maximum.input.value, "-1");
    assert.equal(status.textContent, error);
    const options = structuredClone(view.axisStates.get("first").options);
    fields.maximum.input.value = "1";
    fields.maximum.input.dispatchEvent(new Event("input"));
    view.renderLayerHistograms([], null);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(view.axisStates.get("first").options, options);
    view.renderLayerHistograms([first], "first");
    const lastEditor = view.summaryCards.get("first").axisControls;
    const retainedState = view.axisStates.get("first");
    const lastMaximum = lastEditor.rows.get("y").fields.maximum.input;
    lastMaximum.value = "1";
    lastMaximum.dispatchEvent(new Event("input"));
    view.unbind();
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(retainedState.options, options);
    assert.equal(view.summaryCards.size, 0);
    assert.equal(view.axisStates.size, 0);
});

test("style changes repaint the chart without interrupting pending axis edits", async () => {
    const doc = new FakeRasterControlDocument();
    const { ResizeObserver, instances } = createFakeResizeObservers();
    doc.defaultView = { ResizeObserver };
    const view = new RasterHistogramControlsView(doc);
    const first = { key: "first", label: "drought.tif", canCalculate: true,
        automatic: true, state: "ready", counts: RASTER_STATISTICS.histogram.counts,
        statistics: RASTER_STATISTICS, style: DEFAULT_RASTER_STYLE };
    const second = { ...first, key: "second", label: "rain.tif" };
    view.renderLayerHistograms([first, second], "first");
    const card = view.summaryCards.get("first"), untouched = view.summaryCards.get("second");
    const chart = card.chart, editor = card.axisControls;
    const otherChartContents = [...untouched.chart.children];
    editor.root.open = true;
    editor.root.dispatchEvent(new Event("toggle"));
    const fields = editor.rows.get("y").fields;
    fields.bounds.input.value = "values";
    fields.bounds.input.dispatchEvent(new Event("change"));
    fields.maximum.input.focus();
    fields.maximum.input.value = "1";
    fields.maximum.input.dispatchEvent(new Event("input"));
    const recolored = { ...first, style: { ...DEFAULT_RASTER_STYLE,
        minimumColor: "#000000", midpointColor: "#000000", maximumColor: "#000000" } };
    view.renderLayerHistograms([recolored, second], "first");
    assert.ok(view.summaryCards.get("first") === card);
    assert.ok(card.chart === chart && card.axisControls === editor);
    assert.ok(doc.activeElement === fields.maximum.input);
    assert.equal(editor.root.open, true);
    assert.equal(fields.maximum.input.value, "1");
    const bars = chart.children.filter(child => child.classList.contains("raster-histogram-bar"));
    assert.ok(bars.length > 0 && bars.every(bar => bar.style.fill === "#000000"));
    assert.ok(view.summaryCards.get("second") === untouched);
    assert.ok(untouched.chart.children.every((child, index) => child === otherChartContents[index]));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(editor.axes.y.maximum, 1, "The pending edit still commits after a style repaint");
    fields.maximum.input.value = "2";
    fields.maximum.input.dispatchEvent(new Event("change"));
    assert.equal(editor.axes.y.maximum, 2);
    assert.deepEqual(chart.children.filter(child => child.classList.contains("raster-histogram-bar"))
        .map(bar => bar.style.fill), bars.map(() => "#000000"), "Later axis edits use the latest colors");
    view.renderLayerHistograms([second], "second");
    assert.equal(editor.enabled, false);
    assert.equal(chart.children.length, 0);
    assert.ok(instances.filter(observer => observer.target === chart).every(observer => observer.disconnected));
    view.unbind();
});

test("changed sample, units and retry state refresh only that card", () => {
    const doc = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(doc);
    const retries = [];
    view.bind({ onRetryHistogram: key => retries.push(key) });
    const first = { key: "first", label: "drought.tif", canCalculate: true,
        automatic: true, state: "ready", counts: RASTER_STATISTICS.histogram.counts,
        statistics: RASTER_STATISTICS, style: DEFAULT_RASTER_STYLE };
    const second = { ...first, key: "second", label: "rain.tif" };
    view.renderLayerHistograms([first, second], "first");
    const untouched = view.summaryCards.get("second");
    let previous = view.summaryCards.get("first");
    for (const change of [
        { label: "Renamed raster" },
        { valueLabel: "Rainfall (mm)" },
        { statistics: { ...RASTER_STATISTICS, validSampleCount: RASTER_STATISTICS.validSampleCount - 1 } },
        { state: "error", errorMessage: "Try again", canRetry: true },
    ]) {
        view.renderLayerHistograms([{ ...first, ...change }, second], "first");
        assert.ok(view.summaryCards.get("second") === untouched);
        const current = view.summaryCards.get("first");
        assert.ok(current !== previous);
        assert.equal(previous.axisControls?.enabled, previous.axisControls ? false : undefined);
        previous = current;
    }
    const retry = previous.root.children.at(-1).children.at(-1);
    retry.dispatchEvent(new Event("click"));
    assert.deepEqual(retries, ["first"]);
    view.renderLayerHistograms([first, second], "first");
    retry.dispatchEvent(new Event("click"));
    assert.deepEqual(retries, ["first"]);
    assert.throws(() => view.renderLayerHistograms([first, first], "first"), /keys must be unique/);
    assert.ok(view.summaryCards.get("second") === untouched);
    view.unbind();
});


test("histogram Processing actions follow the source capability while interactive controls remain", () => {
    const doc = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(doc);
    const summary = {
        key: "weather", label: "Temperature", state: "ready",
        counts: [1, 3, 2], canCalculate: false,
    };
    view.renderLayerHistograms([summary], "weather");
    const list = doc.querySelector("#raster-histogram-list");
    assert.deepEqual(list.children[0].children.at(-1).children.map(button => button.getAttribute("aria-label")), [
        "Style Temperature",
    ]);
    assert.equal(list.children[0].children[0].getAttribute("aria-label"), "Show detailed histogram for Temperature");
    view.renderLayerHistograms([{ ...summary, canCalculate: true }], "weather");
    assert.deepEqual(list.children[0].children.at(-1).children.map(button => button.getAttribute("aria-label")), [
        "Style Temperature", "Calculate statistics for Temperature over this area", "Download clip of Temperature",
    ]);
    view.renderLayerHistograms([summary], "weather");
    assert.equal(list.children[0].children.at(-1).children.length, 1);
    view.unbind();
});


test("each histogram inspects percentiles immediately and keeps controls through recoloring and pending data", () => {
    const doc = new FakeRasterControlDocument(), view = new RasterHistogramControlsView(doc);
    const received = [];
    view.bind({ onHistogramPercentiles: (key, settings) => received.push({ key, settings }) });
    const settings = { lower: 5, middle: 50, upper: 95, rescale: false };
    const first = { key: "first", label: "Temperature", canCalculate: true,
        automatic: true, state: "ready", counts: RASTER_STATISTICS.histogram.counts,
        statistics: RASTER_STATISTICS, style: DEFAULT_RASTER_STYLE,
        percentileSettings: settings, canRescale: true, percentileMessage: "" };
    const second = { ...first, key: "second" };
    view.renderLayerHistograms([first, second], "first");
    const card = view.summaryCards.get("first"), other = view.summaryCards.get("second");
    const input = card.percentileControls.inputs.lower;
    input.focus();
    input.value = "20";
    input.dispatchEvent(new Event("input"));
    assert.match(card.chart.getAttribute("aria-label"), /lower 20%/);
    assert.deepEqual(received, [{ key: "first", settings: { ...settings, lower: 20 } }]);
    assert.equal(other.percentileControls.inputs.lower.value, "5");
    assert.equal(card.style, DEFAULT_RASTER_STYLE, "Inspection leaves committed colors alone");

    card.percentileControls.rescaleInput.checked = true;
    card.percentileControls.rescaleInput.dispatchEvent(new Event("change"));
    const applied = { ...first, percentileSettings: received.at(-1).settings,
        style: { ...DEFAULT_RASTER_STYLE, minimumColor: "#000000" } };
    view.renderLayerHistograms([applied, second], "first");
    assert.equal(view.summaryCards.get("first"), card);
    assert.equal(card.percentileControls.inputs.lower, input);
    assert.equal(doc.activeElement, input);
    assert.equal(input.value, "20");
    assert.equal(card.percentileControls.markers[0].color, "#000000");
    assert.equal(view.summaryCards.get("second"), other);

    const oldControls = card.percentileControls;
    view.renderLayerHistograms([{ ...applied, state: "loading", statistics: null, counts: null,
        canRescale: false, percentileMessage: "Updating this histogram…" }, second], "first");
    const pending = view.summaryCards.get("first");
    assert.equal(pending.chart, null);
    assert.equal(pending.percentileControls.inputs.lower.disabled, true);
    assert.equal(pending.percentileControls.rescaleInput.checked, true);
    assert.equal(pending.percentileControls.rescaleInput.disabled, false);
    const before = received.length;
    oldControls.inputs.lower.dispatchEvent(new Event("input"));
    assert.equal(received.length, before, "Replaced controls detach their listeners");
    pending.percentileControls.rescaleInput.checked = false;
    pending.percentileControls.rescaleInput.dispatchEvent(new Event("change"));
    assert.deepEqual(received.at(-1), { key: "first", settings: { ...settings, lower: 20, rescale: false } });
    view.unbind();
});

test("detached histogram percentile inspection works without a rendering target and survives redraw", () => {
    const doc = new FakeRasterControlDocument(), view = new RasterHistogramControlsView(doc);
    const received = [];
    view.bind({ onHistogramPercentiles: (key, settings) => received.push({ key, settings }) });
    const context = { key: "catalog-temperature", settings: { lower: 5, middle: 50, upper: 95, rescale: false },
        canRescale: false, message: "Add this raster to the map to rescale its colors." };
    view.renderHistogram(RASTER_STATISTICS, DEFAULT_RASTER_STYLE, "Temperature (K)", context);
    const controls = view.detailPercentileControls, axes = view.detailAxisControls;
    assert.equal(controls.rescaleInput.disabled, true);
    assert.equal(controls.inputs.lower.disabled, false);
    controls.inputs.lower.focus();
    controls.inputs.lower.value = "15";
    controls.inputs.lower.dispatchEvent(new Event("input"));
    assert.equal(received[0].key, "catalog-temperature");
    assert.equal(received[0].settings.rescale, false);
    assert.match(doc.querySelector("#raster-histogram-chart").getAttribute("aria-label"), /lower 15%/);
    view.renderHistogram(RASTER_STATISTICS, { ...DEFAULT_RASTER_STYLE, maximumColor: "#000000" },
        "Temperature (K)", { ...context, settings: received[0].settings });
    assert.equal(view.detailPercentileControls, controls);
    assert.equal(view.detailAxisControls, axes);
    assert.equal(doc.activeElement, controls.inputs.lower);
    assert.equal(controls.markers[2].color, "#000000");
    view.clearHistogram();
    controls.inputs.lower.dispatchEvent(new Event("input"));
    assert.equal(received.length, 1);
    assert.equal(view.detailPercentileControls, null);
    view.unbind();
});
