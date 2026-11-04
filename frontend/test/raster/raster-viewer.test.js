import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { MapLayerController } from "../../src/map-layers/controller.js";
import { ModelOutputLayers, artifactLayerKey } from "../../src/model-output-preview/controller.js";
import { fileManifest, job } from "../../test-support/models/fixtures.js";
import { MapLayerStyleEditor } from "../../src/map-layers/style-editor.js";
import { LeafletLayerSet } from "../../src/map-layers/leaflet-layer-set.js";
import { CatalogVisualizationCoordinator } from "../../src/catalog-visualization.js";
import { VectorSamplingController } from "../../src/vector/sampling.js";
import {
    initializeRasterViewer,
    RASTER_SAMPLE_WINDOW_RESIZE_DEBOUNCE_MILLISECONDS,
} from "../../src/raster/raster-viewer.js";
import { RasterAnalysisRequestError } from "../../src/raster/analysis-api.js";
import { RasterCursorValuesView } from "../../src/raster/cursor-values-view.js";
import { RasterAppearanceControlsView } from "../../src/raster/appearance-controls-view.js";
import { RasterSamplingAreaControlsView } from "../../src/raster/sampling-area-controls-view.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { BivariateRasterControlsView } from "../../src/raster/bivariate-controls-view.js";
import { buildRasterLegend, DEFAULT_RASTER_STYLE, deriveRasterStyleFromStatistics } from "../../src/raster/style.js";
import { buildRasterStyleEnvironment } from "../../src/raster/wms.js";
import { normalizeCategoricalRasterStyle } from "../../src/raster/categorical-style.js";
import { createSavedMapView, parseSavedMapView, serializeSavedMapView } from "../../src/saved-map-view/model.js";
import {
    EXACT_RASTER_STATISTICS,
    MOUNTED_GEOTIFF_ITEM,
    RASTER_STATISTICS,
    CATALOG_SELECTION,
    CATALOG_SELECTION_RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

/** Minimal add/remove event source with inspectable listener ownership. */
class FakeEventSource {
    /** Create an event source without listeners. */
    constructor() {
        this.listeners = new Map();
    }

    /**
     * Attach one listener.
     *
     * @param {string} type Event type.
     * @param {(event: Object) => void} listener Event callback.
     * @return {void}
     */
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type).add(listener);
    }

    /**
     * Remove one listener.
     *
     * @param {string} type Event type.
     * @param {(event: Object) => void} listener Event callback.
     * @return {void}
     */
    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
    }

    /**
     * Count listeners attached for one event type.
     *
     * @param {string} type Event type.
     * @return {number} Attached listener count.
     */
    listenerCount(type) {
        return this.listeners.get(type)?.size ?? 0;
    }
}

/**
 * Create a Leaflet-compatible map with inspectable layers and handlers.
 *
 * @return {Object} Fake Leaflet map.
 */
function createFakeMap() {
    const container = new FakeEventSource();
    const handlers = new Map();
    const layers = new Set();
    const panes = new Map();
    return {
        container,
        handlers,
        layers,
        panes,
        getPane(name) {
            return panes.get(name);
        },
        createPane(name) {
            const pane = { style: {} };
            panes.set(name, pane);
            return pane;
        },
        getContainer() {
            return container;
        },
        getCenter() {
            return { lng: 0, lat: 0 };
        },
        on(type, handler) {
            if (!handlers.has(type)) {
                handlers.set(type, new Set());
            }
            handlers.get(type).add(handler);
        },
        off(type, handler) {
            handlers.get(type)?.delete(handler);
        },
        emit(type, event) {
            for (const handler of handlers.get(type) ?? []) {
                handler(event);
            }
        },
        removeLayer(layer) {
            layers.delete(layer);
            layer.detach?.();
        },
    };
}

/**
 * Create one Leaflet-compatible layer owned by a fake map.
 *
 * @param {Object} [details={}] Inspectable layer construction details.
 * @return {Object} Fake WMS or rectangle layer.
 */
function createFakeLayer(details = {}) {
    let container = { style: {} };
    return {
        ...details,
        wmsParams: { ...details.wmsOptions },
        eventHandlers: new Map(),
        parameters: null,
        parameterUpdates: [],
        boundsHistory: details.bounds === undefined ? [] : [details.bounds],
        get container() {
            return container;
        },
        getContainer() {
            return container;
        },
        addTo(map) {
            container ??= { style: {} };
            map.layers.add(this);
            return this;
        },
        detach() {
            container = null;
        },
        once(type, handler) {
            this.eventHandlers.set(type, handler);
        },
        setBounds(bounds) {
            this.boundsHistory.push(bounds);
        },
        setParams(parameters) {
            Object.assign(this.wmsParams, parameters);
            this.parameters = parameters;
            this.parameterUpdates.push(parameters);
        },
        setOpacity(opacity) {
            this.opacity = opacity;
        },
        setZIndex(zIndex) {
            this.zIndex = zIndex;
        },
    };
}

/**
 * Build the paired-result fields consumed by composition tests.
 *
 * @return {Object} Contract-shaped paired ranges and fixed histogram edges.
 */
function pairedStatistics() {
    return {
        scope: "wholeOverlap",
        pairedSampleCount: 32,
        xMinimum: 0,
        xMaximum: 32,
        yMinimum: 100,
        yMaximum: 132,
        histogram: {
            counts: Array.from({ length: 32 }, (_, y) =>
                Array.from({ length: 32 }, (_, x) => x === y ? 1 : 0)),
            xEdges: Array.from({ length: 33 }, (_, index) => index),
            yEdges: Array.from({ length: 33 }, (_, index) => index + 100),
            xMarginalCounts: Array(32).fill(1),
            yMarginalCounts: Array(32).fill(1),
        },
    };
}

/**
 * Create the Leaflet namespace used by the raster viewer.
 *
 * @return {{leaflet: Object, wmsLayers: Object[], rectangleLayers: Object[]}}
 * Namespace and created layers.
 */
function createFakeLeaflet() {
    const wmsLayers = [];
    const rectangleLayers = [];
    return {
        wmsLayers,
        rectangleLayers,
        leaflet: {
            layerGroup: () => createFakeLayer({kind: "empty"}),
            tileLayer: {
                wms(url, options) {
                    const layer = createFakeLayer({
                        kind: "wms",
                        url,
                        wmsOptions: options,
                    });
                    wmsLayers.push(layer);
                    return layer;
                },
            },
            rectangle(bounds, options) {
                const layer = createFakeLayer({
                    bounds,
                    kind: options.fill === false ? "preview" : "selection",
                    rectangleOptions: options,
                });
                rectangleLayers.push(layer);
                return layer;
            },
        },
    };
}

/**
 * Create a semantic controls adapter for coordinator lifecycle tests.
 *
 * @return {Object} Fake controls view with inspectable presentation state.
 */
function createFakeControlsView() {
    return {
        controlsVisible: false,
        paletteName: "yellow-red",
        style: null,
        handlers: null,
        displayedStatistics: null,
        renderedStatistics: [],
        styleHistogram: null,
        styleHistogramState: null,
        statisticsStatus: "",
        appearanceStatus: "",
        populatePalettes() {},
        bind(handlers) {
            this.handlers = handlers;
        },
        unbind() {
            this.handlers = null;
        },
        readStyle() {
            return { ...this.style };
        },
        setStyle(style, paletteName) {
            this.style = { ...style };
            this.paletteName = paletteName;
        },
        /** @param {"continuous"|"categorical"} mode Editor selection. @return {void} */
        setAppearanceMode(mode) {
            this.appearanceMode = mode;
        },
        /** @param {Object|null} style Committed table or empty editor. @return {void} */
        setCategoricalStyle(style) {
            this.categoricalStyle = structuredClone(style);
        },
        /**
         * Read and validate the draft like the real categorical view boundary.
         * @return {Object} Independent normalized categorical appearance.
         * @throws {Error} If the current draft is invalid.
         */
        readCategoricalStyle() {
            return normalizeCategoricalRasterStyle(this.categoricalStyle);
        },
        /** @param {Error|null} [error=null] Current draft failure. @return {void} */
        renderCategoricalError(error = null) {
            this.categoricalError = error;
        },
        getPaletteName() {
            return this.paletteName;
        },
        setPaletteName(paletteName) {
            this.paletteName = paletteName;
        },
        renderStyleError() {},
        setAppearanceStatus(message) {
            this.appearanceStatus = message;
        },
        renderLegend(style) {
            this.legendStyle = { ...style };
        },
        clearStatistics() {
            this.displayedStatistics = null;
        },
        setStatisticsBusy() {},
        setStatisticsStatus(message) {
            this.statisticsStatus = message;
        },
        renderHistogram(statistics, _style, valueLabel, context) {
            this.histogramPercentileContext = context;
            this.displayedStatistics = statistics;
            this.histogramValueLabel = valueLabel;
            this.renderedStatistics.push(statistics);
        },
        /** Record unavailable state and remove both kinds of prior distribution.
         * @param {string} scopeLabel Current scope. @param {string} message Feedback.
         * @param {boolean} isBusy Whether loading. @return {void}
         */
        renderStyleHistogramState(scopeLabel, message, isBusy) {
            this.styleHistogram = null;
            this.categoricalStyleHistogram = null;
            this.styleHistogramState = { scopeLabel, message, isBusy };
        },
        /** Clear distribution and request feedback for a closed style target. @return {void} */
        clearStyleHistogram() {
            this.styleHistogram = null;
            this.categoricalStyleHistogram = null;
            this.styleHistogramState = null;
        },
        /** @param {Object} presentation Category rows. @return {void} */
        renderCategoricalHistogram(presentation) { this.categoricalHistogram = presentation; },
        /** @param {Object} presentation Category rows. @param {string} scopeLabel Scope.
         * @param {Object} [feedback] Current request feedback. @return {void} */
        renderCategoricalStyleHistogram(presentation, scopeLabel, feedback) {
            this.categoricalStyleHistogram = { presentation, scopeLabel, feedback };
            this.styleHistogram = null; this.styleHistogramState = null;
        },
        clearHistogram() {
            this.categoricalHistogram = null;
            this.displayedStatistics = null;
        },
        setStatisticsRetryVisible(isVisible) {
            this.statisticsRetryVisible = isVisible;
        },
        setSampleWindowSize(sizeKm) {
            this.sampleWindowSizeKm = sizeKm;
        },
        setSampleWindowInvalid() {},
        setSampleWindowStatus(message) {
            this.sampleWindowStatus = message;
        },
        setClearSampleWindowLabel(label) {
            this.clearSampleWindowLabel = label;
        },
        setSamplingAreaMode(mode, label = "") {
            this.samplingAreaMode = mode;
            this.samplingAreaLabel = label;
        },
        /** @return {boolean} Whether the presented area is a sampling box. */
        isSamplingBoxSelected() {
            return this.samplingAreaMode === "selectedArea";
        },
        showHistogramWidget() {
            this.histogramWidgetOpenCount =
                (this.histogramWidgetOpenCount ?? 0) + 1;
        },
        renderLayerHistograms(summaries, activeKey) {
            this.layerHistograms = summaries.map((summary) => ({
                ...summary,
                counts: summary.counts === null
                    ? null
                    : [...summary.counts],
            }));
            this.activeHistogramKey = activeKey;
        },
        setRenderingControlsAvailable(isAvailable) {
            this.renderingControlsAvailable = isAvailable;
        },
        setControlsVisible(isVisible) {
            this.controlsVisible = isVisible;
        },
        setAppearanceEnabled(isEnabled) {
            this.appearanceEnabled = isEnabled;
        },
        setUnivariateHistogramVisible(isVisible) {
            this.univariateHistogramVisible = isVisible;
        },
        setBivariateAvailability(canEnter, guidance) {
            this.bivariateAvailability = { canEnter, guidance };
        },
        readBivariatePercentiles(axis) {
            return this.bivariatePercentiles?.[axis] ?? { lower: 5, middle: 50, upper: 95 };
        },
        renderBivariatePercentiles(axis, state) {
            this.bivariateRanges ??= {};
            this.bivariateRanges[axis] = state;
        },
        renderBivariateMode(state) {
            this.bivariateMode = state;
        },
        setPairedStatisticsLoading(message) {
            this.pairedStatisticsLoading = message;
        },
        renderPairedStatistics(statistics, presentation) {
            this.pairedStatistics = statistics;
            this.pairedPresentation = presentation;
        },
        renderPairedStatisticsError(error, canRetry) {
            this.pairedStatisticsError = { error, canRetry };
        },
        clearPairedStatistics() {
            this.pairedStatistics = null;
            this.pairedStatisticsClearCount =
                (this.pairedStatisticsClearCount ?? 0) + 1;
        },
        highlightPairedStatistics(xValue, yValue) {
            this.pairedHighlight = { xValue, yValue };
        },
        setActiveLayer(label) {
            this.activeLayer = { label };
        },
    };
}

/**
 * Create a semantic layer-stack adapter for coordinator tests.
 *
 * @return {Object} Fake stack view with retained snapshots and handlers.
 */
function createFakeLayerStackView() {
    return {
        handlers: null,
        layers: [],
        activeKey: null,
        status: "",
        announcement: "",
        bind(handlers) {
            this.handlers = handlers;
        },
        unbind() {
            this.handlers = null;
        },
        render(layers, activeKey) {
            this.layers = layers;
            this.activeKey = activeKey;
        },
        setStatus(message) {
            this.status = message;
            this.announcement = message;
        },
        announceStatus(message) {
            this.status = "";
            this.announcement = message;
        },
    };
}

/**
 * Create an externally resolvable promise.
 *
 * @return {{promise: Promise<*>, resolve: (value: *) => void,
 * reject: (error: Error) => void}} Deferred promise contract.
 */
function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

/**
 * Build a distinct mounted GeoTIFF Item for layer-stack tests.
 *
 * @param {string} suffix Stable Item and filename suffix.
 * @return {Object} Catalog Item with valid composite identity and Asset URL.
 */
function createRasterItem(suffix) {
    return {
        collection: "eolab-mounted-geotiffs",
        id: `geotiff-${suffix}`,
        assets: {
            data: {
                href: `file:///scan-source/folder/${suffix}.tif`,
            },
        },
    };
}

/**
 * Build recognizable statistics for one layer and optional selected area.
 *
 * @param {Object} item Catalog Item owning the statistics.
 * @param {Object|null} [selectedBounds=null] Optional selected-area bounds.
 * @return {Object} Valid statistics with test-only layer identity.
 */
function createLayerStatistics(item, selectedBounds = null) {
    return {
        ...RASTER_STATISTICS,
        itemId: item.id,
        scope: selectedBounds === null ? "wholeRaster" : "selectedArea",
        selectedBounds,
    };
}

/**
 * Add category ground areas to a statistics fixture.
 * @param {Object} item Catalog Item.
 * @param {Object|null} bounds Selected rectangle.
 * @param {number[]|null} codes Numeric classification.
 * @return {Object} Statistics matching the requested classification.
 */
function createCategoryStatistics(item, bounds, codes) {
    const result = createLayerStatistics(item, bounds);
    if (codes) {
        const canonical = [...codes].sort((a, b) => a - b);
        result.categoricalDistribution = { categoryValues: canonical, areasHectares: canonical.map(() => 10),
            validAreaHectares: canonical.length * 10 + 5, unmappedAreaHectares: 5, nodataAreaHectares: 3,
            areaEstimated: true, areaMethod: "sample-cell-equal-area-v1", selectionSubdivisions: 4 };
    }
    return result;
}

/**
 * Return rectangular bounds from one normalized test sampling area.
 *
 * @param {Object} samplingArea Whole, rectangular, or catalog-vector area.
 * @return {Object|null} Selected rectangle or null for another scope.
 */
function selectedBoundsFromArea(samplingArea) {
    return samplingArea.kind === "selectedArea"
        ? samplingArea.selectedBounds
        : null;
}

/**
 * Allow pending async controller continuations to update their views.
 *
 * @return {Promise<void>} Resolves on the next event-loop turn.
 */
function flushPromises() {
    return new Promise((resolve) => setImmediate(resolve));
}

/** Return a controllable clock for scheduled viewer updates. @return {Object} Clock, pending callbacks and one-step flush. */
function createManualClock() {
    const pending = new Map();
    let nextId = 0;
    return {
        pending,
        /** @param {Function} callback Scheduled work. @param {number} delay Milliseconds. @return {number} Timer ID. */
        setTimeout(callback, delay) { pending.set(++nextId, {callback, delay}); return nextId; },
        /** @param {number} id Timer ID. @return {void} */
        clearTimeout(id) { pending.delete(id); },
        /** Run the current batch; callbacks may schedule a later batch. @return {void} */
        flush() { const batch = [...pending.values()]; pending.clear(); for (const {callback} of batch) callback(); },
    };
}

test("histogram rescaling is opt-in, coalesced during input, and isolated to one view", async () => {
    const clock = createManualClock();
    const item = createRasterItem("percentile-views");
    let catalog;
    let reads = 0;
    const h = visibleLayerFixture(async (item, area) => {
        reads++; return createLayerStatistics(item, selectedBoundsFromArea(area));
    }, {clock}, {}, {restoreRemovedLayer: (snapshot, isCurrent) =>
        catalog.restoreRemovedLayer(snapshot, async () => item, isCurrent)});
    catalog = new CatalogVisualizationCoordinator(h.viewer, h.mapLayers, {});
    try {
        await h.viewer.show(item); await flushPromises();
        const first = h.mapLayers.retainedRecords[0];
        const other = h.mapLayers.getRecord(await h.mapLayers.addAnotherView(first.entry.key));
        await flushPromises();
        h.viewer.openStyle(other.entry.key);
        const original = {...first.state.rasterStyle}, otherStyle = {...other.state.rasterStyle};
        const count = reads;
        const settings = {lower: 10, middle: 40, upper: 90, rescale: false};
        h.controlsView.handlers.onHistogramPercentiles(first.entry.key, settings);
        assert.equal(clock.pending.size, 0);
        assert.deepEqual(first.state.rasterStyle, original);
        h.controlsView.handlers.onHistogramPercentiles(first.entry.key, {...settings, rescale: true});
        const scheduled = [...clock.pending.values()][0];
        h.controlsView.handlers.onHistogramPercentiles(first.entry.key, {...settings, middle: 60, rescale: true});
        assert.equal(clock.pending.size, 1);
        assert.equal([...clock.pending.values()][0], scheduled, "Dragging keeps the existing deadline");
        assert.equal(scheduled.delay, 200);
        clock.flush();
        const applied = deriveRasterStyleFromStatistics(original, first.state.analysis.rasterStatistics,
            {...settings, middle: 60});
        assert.deepEqual(first.state.rasterStyle, applied);
        assert.deepEqual(other.state.rasterStyle, otherStyle);
        assert.deepEqual(h.controlsView.style, otherStyle, "Another open style editor keeps its inputs");
        assert.equal(reads, count, "Slider edits do not read statistics again");
        h.controlsView.handlers.onHistogramPercentiles(first.entry.key, {...settings, middle: 20, rescale: true});
        assert.equal(clock.pending.size, 1, "A continued drag schedules its next update");
        h.controlsView.handlers.onHistogramPercentiles(first.entry.key, {...settings, lower: 80, rescale: true});
        assert.equal(clock.pending.size, 0, "Invalid ordering cancels an older valid candidate");
        assert.match(h.controlsView.layerHistograms.find(value => value.key === first.entry.key).percentileMessage, /increasing order/);
        h.controlsView.handlers.onHistogramPercentiles(first.entry.key, {...settings, rescale: true});
        h.controlsView.handlers.onHistogramPercentiles(first.entry.key, settings);
        clock.flush();
        assert.deepEqual(first.state.rasterStyle, applied, "Disabling retains the last applied colors");
    } finally { h.destroy(); }
});

test("automatic rescaling waits for accepted replacement samples and releases removed views", async () => {
    const clock = createManualClock(), requests = [];
    const h = visibleLayerFixture((item, area, signal) => {
        if (area.kind === "wholeRaster") return Promise.resolve(createLayerStatistics(item));
        const request = {...createDeferred(), item, area, signal}; requests.push(request); return request.promise;
    }, {clock});
    try {
        await h.viewer.show(createRasterItem("percentile-areas")); await flushPromises();
        const record = h.mapLayers.retainedRecords[0], original = {...record.state.rasterStyle};
        const settings = {lower: 10, middle: 40, upper: 90, rescale: true};
        h.controlsView.handlers.onHistogramPercentiles(record.entry.key, settings);
        h.viewer.exploreAt({lng: 14, lat: 37});
        clock.flush();
        assert.deepEqual(record.state.rasterStyle, original, "A queued old-area stretch is discarded");
        const obsolete = requests.at(-1);
        h.viewer.exploreAt({lng: 15, lat: 38});
        assert.equal(obsolete.signal.aborted, true);
        obsolete.resolve(createLayerStatistics(obsolete.item, obsolete.area.selectedBounds));
        await flushPromises();
        assert.equal(clock.pending.size, 0, "A late cancelled result cannot rescale");
        const current = requests.at(-1), statistics = createLayerStatistics(current.item, current.area.selectedBounds);
        current.resolve(statistics); await flushPromises();
        assert.equal(clock.pending.size, 1, "The enabled view follows its accepted new sample");
        clock.flush();
        assert.deepEqual(record.state.rasterStyle, deriveRasterStyleFromStatistics(original, statistics, settings));
        h.controlsView.handlers.onHistogramPercentiles(record.entry.key, {...settings, middle: 60});
        h.controlsView.handlers.onSampleWindowNumberInput("500");
        const [styleTimerId, styleTimer] = [...clock.pending].find(([, timer]) => timer.delay === 200);
        clock.pending.delete(styleTimerId); styleTimer.callback();
        assert.equal(h.controlsView.layerHistograms[0].canRescale, false);
        h.controlsView.handlers.onSampleWindowNumberInput("invalid");
        assert.equal(clock.pending.size, 1, "Cancelling the resize resumes the enabled stretch for the accepted area");
        clock.flush();
        assert.deepEqual(record.state.rasterStyle, deriveRasterStyleFromStatistics(original, statistics, {...settings, middle: 60}));
        h.controlsView.handlers.onHistogramPercentiles(record.entry.key, settings);
        h.mapLayers.removeKey(record.entry.key);
        assert.equal(clock.pending.size, 0);
    } finally { h.destroy(); assert.equal(clock.pending.size, 0); }
});

test("rescaling reports rendering failures and keeps existing constant-histogram range handling", async () => {
    const clock = createManualClock();
    const h = visibleLayerFixture(async item => ({...createLayerStatistics(item),
        sampleMinimum: 5, sampleMaximum: 5, percentiles: {p05: 5, p50: 5, p95: 5},
        suggestedRange: {minimum: 4, midpoint: 5, maximum: 6}}), {clock});
    try {
        await h.viewer.show(createRasterItem("constant-percentiles")); await flushPromises();
        const record = h.mapLayers.retainedRecords[0];
        const settings = {lower: 10, middle: 40, upper: 90, rescale: true};
        h.controlsView.handlers.onHistogramPercentiles(record.entry.key, settings);
        clock.flush();
        assert.ok(record.state.rasterStyle.minimum < 5 && record.state.rasterStyle.maximum > 5);
        const previous = {...record.state.rasterStyle};
        record.state.layer.setParams = () => {throw new Error("Map layer unavailable");};
        h.controlsView.handlers.onHistogramPercentiles(record.entry.key, {...settings, middle: 60});
        assert.doesNotThrow(() => clock.flush());
        assert.deepEqual(record.state.rasterStyle, previous);
        assert.match(h.controlsView.layerHistograms[0].percentileMessage, /Could not rescale this raster: Map layer unavailable/);
    } finally { h.destroy(); }
});

/**
 * Exercise the application's visible-layer policy and neutral controller.
 *
 * @param {Function} [loadStatistics] Raster statistics loader.
 * @param {Object} [dependencies={}] Raster-viewer dependency overrides.
 * @param {Object} [configuration={}] Raster-viewer configuration overrides.
 * @param {Object} [layerConfiguration={}] Neutral layer-controller dependencies.
 * @return {Object} Viewer, map, views, layers, and cleanup helper.
 */
function visibleLayerFixture(
    loadStatistics = async (item, area, _signal, _fetch, codes) => createCategoryStatistics(item, selectedBoundsFromArea(area), codes),
    dependencies = {},
    configuration = {},
    layerConfiguration = {},
) {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    let viewer;
    const mapLayers = new MapLayerController({ leafletMap, view: layerStackView,
        onLayersChange: () => viewer?.syncVisibleLayers(), ...layerConfiguration });
    viewer = initializeRasterViewer({
        leafletMap,
        leaflet,
        wmsUrl: '/geoserver/eolab/wms',
        onTileError() {},
        ...configuration,
    }, {
        controlsView, mapLayerController: mapLayers, loadStatistics,
        publishRaster: async item => ({ layerName: `eolab:${item.id}`, bbox: [-180, -90, 180, 90] }),
        samplePixel: async () => ({ inBounds: true, value: 1 }),
        loadPairedStatistics: async () => pairedStatistics(),
        ...dependencies,
    });
    viewer.syncVisibleLayers();
    return { viewer, controlsView, mapLayers, layerStackView, wmsLayers, leaflet, leafletMap,
        destroy() { viewer.destroy(); mapLayers.destroy(); } };
}

test("composed box selection and resize publish geometry without a histogram raster", () => {
    const clock = createManualClock(), areas = [], reads = [];
    const h = visibleLayerFixture(async (...args) => { reads.push(args); throw new Error("No raster requested"); },
        {clock}, {onSamplingAreaChange: area => areas.push(area)});
    try {
        h.viewer.selectSamplingBox();
        const initial = h.viewer.getSelectedArea();
        assert.equal(initial.kind, "selectedArea");
        assert.deepEqual(areas.at(-1), initial);
        h.controlsView.handlers.onSampleWindowRangeInput("100");
        clock.flush();
        const resized = h.viewer.getSelectedArea();
        assert.ok(resized.selectedBounds.east < initial.selectedBounds.east);
        assert.deepEqual(areas.at(-1), resized);
        assert.equal(reads.length, 0);
        assert.equal(h.mapLayers.retainedRecords.length, 0);
    } finally { h.destroy(); }
});

/**
 * Build a complete categorical appearance with ordered codes and independent alpha.
 * @return {Object} Valid table suitable for an editor draft or saved state.
 */
function categoricalAppearance() {
    return {
        mode: "categorical",
        categories: [
            { value: 41, label: "Forest", color: "#228b22", opacity: 0.75 },
            { value: 0, label: "Background", color: "#000000", opacity: 0 },
            { value: -1, label: "Other", color: "#aabbcc", opacity: 1 },
        ],
        unmapped: { color: "#808080", opacity: 0.25 },
    };
}

/**
 * Configure one keyed layer through the same callbacks as the manual editor.
 * @param {Object} harness Real viewer/controller with semantic view doubles.
 * @param {string} key Retained style target.
 * @param {Object} [style=categoricalAppearance()] Complete category draft.
 * @return {void}
 */
function editCategoricalAppearance(harness, key, style = categoricalAppearance()) {
    assert.equal(harness.viewer.openStyle(key), true);
    harness.controlsView.handlers.onAppearanceModeChange("categorical");
    harness.controlsView.categoricalStyle = structuredClone(style);
    harness.controlsView.handlers.onCategoricalStyleInput();
    harness.controlsView.handlers.onCategoricalStyleChange();
}

test("inspection summaries describe bounded raster participation and asynchronous results", async () => {
    const snapshots = [];
    const h = visibleLayerFixture(async (item, area) =>
        createLayerStatistics(item, selectedBoundsFromArea(area)), {}, {
        onHistogramChange: snapshot => snapshots.push(snapshot),
    });
    for (let index = 0; index < 17; index += 1) {
        await h.viewer.show(createRasterItem(`summary-${index}`));
    }
    h.viewer.exploreAt({ lng: 78, lat: 22 });
    assert.ok(snapshots.some(snapshot => snapshot?.state === "loading"));
    await flushPromises();
    assert.equal(snapshots.at(-1).state, "ready");
    assert.match(snapshots.at(-1).message, /Top 16 of 17 visible rasters/);
    assert.equal(snapshots.at(-1).source, "Top 16 of 17 visible rasters");
    assert.match(snapshots.at(-1).scope, /Sampling box/);
    assert.match(snapshots.at(-1).message, /Sampling box/);
    h.controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();
    assert.equal(snapshots.at(-1).state, "ready");
    assert.match(snapshots.at(-1).message, /2D/);
    assert.equal(snapshots.at(-1).source, "Top 2 of 17 visible rasters");
    assert.match(snapshots.at(-1).scope, /2D/);
    assert.match(snapshots.at(-1).message, /Top 2 of 17 visible rasters/);
    assert.equal(h.controlsView.layerHistograms.length, 2);
    h.controlsView.handlers.onBivariateModeChange("overlay");
    await flushPromises();
    assert.equal(h.controlsView.layerHistograms.length, 16);
    assert.match(snapshots.at(-1).message, /Top 16 of 17 visible rasters/);
    h.viewer.clear();
    assert.equal(snapshots.at(-1), null);
    h.destroy();
});

test("retained custom names reach histograms and paired axes without new calculations", async () => {
    let reads = 0, pairReads = 0;
    const h = visibleLayerFixture(async item => { reads++; return createLayerStatistics(item); }, {
        loadPairedStatistics: async () => { pairReads++; return pairedStatistics(); },
    });
    await h.viewer.show(createRasterItem("named-a"));
    await h.viewer.show(createRasterItem("named-b"));
    h.viewer.exploreAt({ lng: 78, lat: 22 });
    await flushPromises();
    const record = h.mapLayers.retainedRecords[0];
    const priorReads = reads;
    h.mapLayers.renameLayer(record.entry.key, "My rainfall");
    assert.equal(record.state.label, "My rainfall");
    assert.equal(reads, priorReads);
    h.controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();
    const priorPairs = pairReads;
    h.mapLayers.renameLayer(record.entry.key, "Annual rainfall");
    assert.ok([h.controlsView.pairedPresentation.xLabel, h.controlsView.pairedPresentation.yLabel].includes("Annual rainfall"));
    assert.equal(pairReads, priorPairs);
    h.destroy();
});

test("download intents preserve distinct 1D and 2D boxes without waiting for statistics", async () => {
    const downloads = [];
    const h = visibleLayerFixture(async () => { throw new Error("Statistics busy"); }, {}, {
        onDownloadRequested: (item, area) => downloads.push({ item, area }),
    });
    await h.viewer.show(createRasterItem("download-x"));
    await h.viewer.show(createRasterItem("download-y"));
    await flushPromises();
    assert.equal(h.viewer.getSelectedArea(), null);
    h.viewer.exploreAt({ lng: 78, lat: 22 });
    const oneD = h.viewer.getSelectedArea();
    assert.ok(Object.isFrozen(oneD.selectedBounds));
    h.controlsView.handlers.onDownloadHistogram(h.layerStackView.activeKey);
    assert.deepEqual(downloads.at(-1).area, oneD);
    h.controlsView.handlers.onBivariateModeChange("bivariate");
    h.viewer.exploreAt({ lng: 80, lat: 24 });
    const twoD = h.viewer.getSelectedArea();
    assert.notDeepEqual(twoD, oneD);
    h.controlsView.handlers.onDownloadPairedHistogram("x");
    h.controlsView.handlers.onDownloadPairedHistogram("y");
    assert.deepEqual(downloads.at(-1).area, twoD);
    assert.deepEqual(downloads.at(-2).area, twoD);
    assert.notEqual(downloads.at(-1).item.id, downloads.at(-2).item.id);
    h.controlsView.handlers.onBivariateModeChange("overlay");
    assert.deepEqual(h.viewer.getSelectedArea(), oneD);
    h.destroy();
});

test("calculation entry points emit source identities and committed areas without reading histogram results", async () => {
    const calculations = [], areas = [], committed = [];
    const h = visibleLayerFixture(async () => { throw new Error("Statistics busy"); }, {}, {
        onCalculateRequested: (item, area) => calculations.push({ item, area }),
        onSamplingAreaChange: area => areas.push(area),
    });
    await h.viewer.show(createRasterItem("calculate-x"));
    await h.viewer.show(createRasterItem("calculate-y"));
    h.viewer.exploreAt({ lng: 78, lat: 22 }, {onSelected: area => committed.push(area)});
    const oneD = h.viewer.getSelectedArea();
    assert.deepEqual(committed, [oneD], "a successful click synchronously reports its committed area");
    h.controlsView.handlers.onCalculateHistogram(h.layerStackView.activeKey);
    assert.deepEqual(calculations.at(-1).area, oneD);
    assert.deepEqual(areas.at(-1), oneD);
    h.controlsView.handlers.onBivariateModeChange("bivariate");
    h.viewer.exploreAt({ lng: 80, lat: 24 }, {onSelected: area => committed.push(area)});
    assert.deepEqual(committed.at(-1), h.viewer.getSelectedArea());
    h.controlsView.handlers.onCalculatePairedHistogram("x");
    h.controlsView.handlers.onCalculatePairedHistogram("y");
    assert.deepEqual(calculations.at(-1).area, h.viewer.getSelectedArea());
    assert.notEqual(calculations.at(-1).item.id, calculations.at(-2).item.id);
    h.destroy();
});

for (const outcome of ["success", "read error", "no matches", "no polygon layer"]) {
    test(`first vector sampling has no stale box or histogram after ${outcome}`, async () => {
        let sampling;
        const read = createDeferred(), requests = [], events = [], snapshots = [];
        const h = visibleLayerFixture(async (item, area) => {
            requests.push(area);
            return createLayerStatistics(item, selectedBoundsFromArea(area));
        }, {}, {
            onSamplingAreaChange: area => events.push({area}),
            onHistogramChange: value => snapshots.push(value),
            onSamplingMethodChange: method => {
                events.push({method});
                if (method === "vector") void sampling.use();
                else sampling.invalidate("");
            },
        });
        sampling = new VectorSamplingController({
            view: {bind() {}, render() {}, unbind() {}},
            getTargets: () => outcome === "no polygon layer" ? [] : [{key: "county-view",
                item: {collectionId: "vectors", itemId: "counties"}, filter: CATALOG_SELECTION.filter}],
            createArea: () => read.promise,
            onActivate: area => h.viewer.setVectorSelection(area),
            onInvalidate: () => h.viewer.setVectorSelection(null),
            onEditFilter() {},
        });
        await h.viewer.show(createRasterItem("first-vector"));
        h.viewer.exploreAt({lng: -100, lat: 40});
        await flushPromises();
        assert.ok(h.viewer.getSelectedArea());
        assert.equal(h.controlsView.layerHistograms.length, 1);
        const previousReads = requests.length;
        events.length = 0;
        h.controlsView.handlers.onUseVectorArea();
        await flushPromises();
        assert.deepEqual(events.slice(0, 2), [{area: null}, {method: "vector"}]);
        h.viewer.syncVisibleLayers();
        assert.equal(h.viewer.getSelectedArea(), null);
        assert.equal(h.controlsView.samplingAreaMode, "vector");
        assert.equal(h.controlsView.sampleWindowStatus, "");
        assert.deepEqual(h.controlsView.layerHistograms, []);
        assert.equal(h.controlsView.displayedStatistics, null);
        assert.equal(snapshots.at(-1), null);
        assert.equal(requests.length, previousReads);

        if (outcome === "success") {
            read.resolve({selection: CATALOG_SELECTION, label: "Counties", matched: 30, total: 3144});
        } else if (outcome !== "no polygon layer") {
            read.reject(new Error(outcome === "no matches" ? "No features match this filter." : "Cannot read polygons."));
        }
        await flushPromises();
        if (outcome === "success") {
            assert.deepEqual(h.viewer.getSelectedArea(), {kind: "catalogSelection", catalogSelection: CATALOG_SELECTION});
            assert.equal(requests.at(-1).kind, "catalogSelection");
            assert.equal(h.controlsView.layerHistograms.length, 1);
            h.controlsView.handlers.onClearSampleWindow();
            await flushPromises();
            assert.equal(h.controlsView.samplingAreaMode, "wholeRaster", "releasing the accepted vector does not reopen pending selection");
        } else {
            assert.equal(h.viewer.getSelectedArea(), null);
            assert.equal(h.controlsView.samplingAreaMode, "vector");
            assert.deepEqual(h.controlsView.layerHistograms, []);
            assert.equal(requests.length, previousReads);
            assert.equal(sampling.state.phase, outcome === "no polygon layer" ? "idle" : "error");
            h.controlsView.handlers.onClearSampleWindow();
            await flushPromises();
            assert.equal(h.controlsView.layerHistograms.length, 1);

        }
        sampling.destroy();
        h.destroy();
    });
}

for (const mode of ["overlay", "bivariate"]) {
    test(`vector sampling cancels pending ${mode} histograms and ignores their late result`, async () => {
        const read = createDeferred();
        let signal;
        const h = visibleLayerFixture(async (item, area, cancellation) => {
            if (area.kind === "selectedArea") { signal = cancellation; return read.promise; }
            return createLayerStatistics(item);
        }, {
            loadPairedStatistics: async (_x, _y, area, cancellation) => {
                if (area.kind === "selectedArea") { signal = cancellation; return read.promise; }
                return pairedStatistics();
            },
        });
        await h.viewer.show(createRasterItem("pending-vector-x"));
        await h.viewer.show(createRasterItem("pending-vector-y"));
        h.controlsView.handlers.onBivariateModeChange(mode);
        await flushPromises();
        h.viewer.exploreAt({lng: -100, lat: 40});
        await flushPromises();
        h.controlsView.handlers.onUseVectorArea();
        assert.equal(signal.aborted, true);
        read.resolve(mode === "bivariate" ? pairedStatistics() : createLayerStatistics(createRasterItem("pending-vector-x")));
        await flushPromises();
        assert.equal(h.viewer.getSelectedArea(), null);
        assert.equal(h.controlsView.displayedStatistics, null);
        assert.equal(h.controlsView.pairedStatistics, null);
        assert.deepEqual(h.controlsView.layerHistograms, []);
        h.destroy();
    });
}

for (const method of ["whole", "box"]) {
    test(`choosing ${method} cancels pending vector adoption without a late switch back`, async () => {
        let sampling, complete, signal;
        const choices = [];
        const h = visibleLayerFixture(async (item, area) => createLayerStatistics(item, selectedBoundsFromArea(area)), {}, {
            onSamplingMethodChange: choice => {
                choices.push(choice);
                if (choice === "vector") void sampling.use();
                else sampling.invalidate("");
            },
        });
        sampling = new VectorSamplingController({
            view: {bind() {}, render() {}, unbind() {}},
            getTargets: () => [{key: "county-view", item: {collectionId: "vectors", itemId: "counties"}, filter: CATALOG_SELECTION.filter}],
            createArea: (_source, _filter, cancellation) => {
                signal = cancellation;
                return new Promise(resolve => { complete = resolve; });
            },
            onActivate: area => h.viewer.setVectorSelection(area),
            onInvalidate: () => h.viewer.setVectorSelection(null),
            onEditFilter() {},
        });
        await h.viewer.show(createRasterItem("cancel-vector"));
        assert.deepEqual(choices, [], "loading a raster does not select an area method");
        h.controlsView.handlers.onUseVectorArea();
        await flushPromises();
        if (method === "whole") h.controlsView.handlers.onClearSampleWindow();
        else h.controlsView.handlers.onUseMapWindow();
        const chosenArea = h.viewer.getSelectedArea();
        assert.equal(signal.aborted, true);
        complete({selection: CATALOG_SELECTION, label: "Washington counties", matched: 30, total: 3144});
        await flushPromises();
        assert.deepEqual(h.viewer.getSelectedArea(), chosenArea);
        assert.deepEqual(choices, ["vector", method]);
        sampling.destroy();
        h.destroy();
    });
}

for (const mode of ["overlay", "bivariate"]) {
    for (const retainSelection of [false, true]) {
        test(`rejected maximum box keeps ${mode} controls available with retained selection ${retainSelection}`, async () => {
            const requests = [], timers = new Map(), committed = [];
            let timerId = 0, histogramRequests = 0, pixelRequests = 0;
            const h = visibleLayerFixture(async (item, area) => {
                requests.push(area);
                return createLayerStatistics(item, selectedBoundsFromArea(area));
            }, {
                clock: {
                    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
                    clearTimeout(id) { timers.delete(id); },
                },
                loadPairedStatistics: async (_x, _y, area) => {
                    requests.push(area);
                    return pairedStatistics();
                },
                samplePixel: async () => { pixelRequests += 1; return {inBounds: true, value: 1}; },
            }, {
                onHistogramRequested: () => { histogramRequests += 1; },
            });
            const documentContext = new FakeRasterControlDocument();
            const sampling = new RasterSamplingAreaControlsView(documentContext);
            sampling.bind(h.controlsView.handlers);
            const setSize = h.controlsView.setSampleWindowSize.bind(h.controlsView);
            h.controlsView.setSampleWindowSize = (size, maximum) => {
                setSize(size);
                sampling.setSampleWindowSize(size, maximum);
            };
            h.controlsView.setSampleWindowStatus = (message, showMessage) => {
                h.controlsView.sampleWindowStatus = message;
                sampling.setSampleWindowStatus(message, showMessage);
            };
            h.controlsView.setSampleWindowInvalid = invalid => sampling.setSampleWindowInvalid(invalid);
            sampling.disclosure.open = false;
            try {
                await h.viewer.show(createRasterItem("rejected-box-x"));
                await h.viewer.show(createRasterItem("rejected-box-y"));
                h.controlsView.handlers.onBivariateModeChange(mode);
                if (retainSelection) h.viewer.exploreAt({lng: -60, lat: -20});
                await flushPromises();
                const previousArea = h.viewer.getSelectedArea();
                const previousPlot = mode === "overlay"
                    ? h.controlsView.displayedStatistics : h.controlsView.pairedStatistics;
                const requestCount = requests.length, pixelCount = pixelRequests;
                const range = documentContext.querySelector("#raster-sample-window-range");
                range.value = "1000";
                range.dispatchEvent(new Event("input"));
                assert.equal(h.controlsView.sampleWindowSizeKm, 14152);
                for (const callback of timers.values()) callback();
                timers.clear();
                // Both the map click and reopening Analysis tools use exploreAt.
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    const presentationsBefore = histogramRequests;
                    assert.equal(h.viewer.exploreAt({lng: -60, lat: -20}, {onSelected: area => committed.push(area)}), true);
                    assert.equal(committed.length, 0, "a rejected box must not recalculate the retained old area");
                    assert.equal(histogramRequests, presentationsBefore + 1);
                    assert.match(h.controlsView.sampleWindowStatus, /pole or date line/);
                    assert.equal(sampling.sampleWindowStatus.classList.contains("visually-hidden"), false);
                    assert.equal(sampling.sampleWindowNumber.getAttribute("aria-invalid"), null);
                    assert.equal(sampling.disclosure.open, false, "boundary guidance is outside the collapsed form");
                    assert.deepEqual(h.viewer.getSelectedArea(), previousArea);
                }
                await flushPromises();
                assert.equal(requests.length, requestCount);
                assert.equal(pixelRequests, pixelCount);
                assert.equal(mode === "overlay"
                    ? h.controlsView.displayedStatistics : h.controlsView.pairedStatistics, previousPlot);
                const number = documentContext.querySelector("#raster-sample-window-number");
                number.value = "1000";
                number.dispatchEvent(new Event("input"));
                assert.equal(h.viewer.exploreAt({lng: -60, lat: -20}, {onSelected: area => committed.push(area)}), true);
                assert.deepEqual(committed, [h.viewer.getSelectedArea()]);
                await flushPromises();
                assert.ok(requests.length > requestCount);
                assert.notDeepEqual(h.viewer.getSelectedArea(), previousArea);
                assert.match(h.controlsView.samplingAreaLabel, /1000 km/);
                assert.equal(sampling.sampleWindowStatus.classList.contains("visually-hidden"), true,
                    "valid selection restores the ordinary screen-reader announcement");
            } finally { sampling.unbind(); h.destroy(); }
        });
    }

    test(`continental box controls debounce ${mode} analysis and preserve a rejected selection`, async () => {
        const requests = [], timers = new Map();
        let timerId = 0;
        const h = visibleLayerFixture(async (item, area) => {
            requests.push(area);
            return createLayerStatistics(item, selectedBoundsFromArea(area));
        }, {
            clock: {
                setTimeout(callback, delay) { const id = ++timerId; timers.set(id, {callback, delay}); return id; },
                clearTimeout(id) { timers.delete(id); },
            },
            loadPairedStatistics: async (_x, _y, area) => { requests.push(area); return pairedStatistics(); },
        });
        const documentContext = new FakeRasterControlDocument();
        const sampling = new RasterSamplingAreaControlsView(documentContext);
        sampling.bind(h.controlsView.handlers);
        const originalSetSize = h.controlsView.setSampleWindowSize.bind(h.controlsView);
        h.controlsView.setSampleWindowSize = (size, maximum) => { originalSetSize(size); sampling.setSampleWindowSize(size, maximum); };
        try {
            await h.viewer.show(createRasterItem("large-box-x"));
            await h.viewer.show(createRasterItem("large-box-y"));
            await flushPromises();
            const range = documentContext.querySelector("#raster-sample-window-range");
            assert.ok(Number.isFinite(Number(range.value)));
            assert.equal(range.getAttribute("aria-valuetext"), "600 kilometers");
            h.viewer.exploreAt({lng: 78, lat: 22});
            await flushPromises();
            const original = h.viewer.getSelectedArea();
            // Entering 2D copies bounds: the origin must survive that value copy.
            h.controlsView.handlers.onBivariateModeChange(mode);
            await flushPromises();
            const before = requests.length;
            const number = documentContext.querySelector("#raster-sample-window-number");
            for (const size of [1000, 5000]) {
                number.value = String(size);
                number.dispatchEvent(new Event("input"));
            }
            assert.equal(requests.length, before);
            assert.equal(timers.size, 1);
            const pending = [...timers.values()][0];
            assert.equal(pending.delay, RASTER_SAMPLE_WINDOW_RESIZE_DEBOUNCE_MILLISECONDS);
            timers.clear(); pending.callback();
            await flushPromises();
            const selected = h.viewer.getSelectedArea();
            assert.ok(selected.selectedBounds.east - selected.selectedBounds.west > 40);
            assert.deepEqual(requests.at(-1).selectedBounds, selected.selectedBounds);
            assert.match(h.controlsView.samplingAreaLabel, /5000 km/);
            h.viewer.activateAnalysis(h.mapLayers.snapshots()[1].item);
            assert.ok(Number.isFinite(Number(range.value)));
            assert.equal(h.viewer.exploreAt({lng: 170, lat: 0}), true);
            assert.deepEqual(h.viewer.getSelectedArea(), selected);
            assert.match(h.controlsView.sampleWindowStatus, /Whole raster/);
            number.value = "600";
            number.dispatchEvent(new Event("input"));
            const shrink = [...timers.values()][0];
            timers.clear(); shrink.callback();
            await flushPromises();
            assert.deepEqual(h.viewer.getSelectedArea(), original);
            h.controlsView.handlers.onClearSampleWindow();
            await flushPromises();
            assert.equal(requests.at(-1).kind, mode === "overlay" ? "wholeRaster" : "wholeOverlap");
        } finally { sampling.unbind(); h.destroy(); }
    });
}

test('histogram axis units follow each analyzed data asset', async () => {
    const h = visibleLayerFixture();
    const item = { ...MOUNTED_GEOTIFF_ITEM, assets: { data: {
        ...MOUNTED_GEOTIFF_ITEM.assets.data, "raster:bands": [{unit:"%"}],
    } } };
    await h.viewer.show(item);
    await flushPromises();
    assert.equal(h.controlsView.histogramValueLabel, "Raster value (%)");
    assert.equal(h.controlsView.layerHistograms[0].valueLabel, "Raster value (%)");
    h.destroy();
});

test("categorical style keeps a previous whole distribution separate from a failed map request", async () => {
    const reads = [];
    const h = visibleLayerFixture((item, area, signal, _fetch, codes) => {
        const pending = createDeferred(); reads.push({ item, area, signal, codes, pending });
        return area.kind === "wholeRaster" ? Promise.resolve(createCategoryStatistics(item, null, codes)) : pending.promise;
    });
    const item = createRasterItem("style-scope-categorical");
    await h.viewer.show(item); await flushPromises();
    const record = h.mapLayers.retainedRecords[0], key = record.entry.key;
    editCategoricalAppearance(h, key); await flushPromises();
    const whole = record.state.analysis.wholeRasterStatistics;
    await h.viewer.show(createRasterItem("style-scope-neighbor")); await flushPromises();
    h.viewer.openStyle(key);
    const preview = () => h.controlsView.categoricalStyleHistogram;
    assert.equal(preview().scopeLabel, "Whole raster");
    h.viewer.closeStyle(); h.viewer.exploreAt({ lng: 14, lat: 37.5 }); await flushPromises();
    h.viewer.openStyle(key);
    assert.equal(preview().scopeLabel, "Previous histogram · Whole raster");
    assert.match(preview().feedback.message, /Sampling box\b.*: Calculating/i);
    assert.equal(preview().feedback.isBusy, true);
    const selectedRead = reads.find(read => read.item === item && read.area.kind === "selectedArea");
    selectedRead.pending.reject(new Error("The selected area does not overlap the raster")); await flushPromises();
    h.viewer.closeStyle(); h.viewer.openStyle(key);
    assert.equal(preview().scopeLabel, "Previous histogram · Whole raster");
    assert.match(preview().feedback.message, /Sampling box\b.*: Histogram unavailable: The selected area does not overlap/i);
    assert.equal(preview().feedback.isBusy, false);
    assert.equal(record.state.analysis.wholeRasterStatistics, whole, "Retained whole data remains available");
    assert.equal(record.state.analysis.rasterStatistics.itemId, item.id, "Preview retains its keyed raster source");
    h.controlsView.handlers.onClearSampleWindow(); await flushPromises(); h.viewer.openStyle(key);
    assert.equal(preview().scopeLabel, "Whole raster"); assert.equal(preview().feedback.message, "");
    assert.equal(record.state.analysis.wholeRasterStatistics.itemId, item.id);
    h.destroy();
});

test("categorical style scopes successful polygons and labels a cancelled replacement as previous", async () => {
    const reads = [];
    const h = visibleLayerFixture((item, area, signal, _fetch, codes) => {
        if (area.kind === "wholeRaster") return Promise.resolve(createCategoryStatistics(item, null, codes));
        const pending = createDeferred(); reads.push({ item, area, signal, codes, pending }); return pending.promise;
    });
    const item = createRasterItem("style-polygon-categorical");
    await h.viewer.show(item); await flushPromises();
    const record = h.mapLayers.retainedRecords[0], key = record.entry.key;
    editCategoricalAppearance(h, key); await flushPromises();
    const selection = { selection: CATALOG_SELECTION, label: "Countries.gpkg" };
    h.viewer.setVectorSelection(selection); await flushPromises();
    const polygonRead = reads.at(-1);
    polygonRead.pending.resolve({ ...createCategoryStatistics(item, null, polygonRead.codes),
        scope: "catalogSelection", catalogSelection: CATALOG_SELECTION }); await flushPromises();
    h.viewer.openStyle(key);
    const preview = () => h.controlsView.categoricalStyleHistogram;
    assert.equal(preview().scopeLabel, "Selected polygons · Countries.gpkg");
    assert.equal(preview().feedback.message, "");
    h.controlsView.handlers.onUseMapWindow(); await flushPromises(); h.viewer.openStyle(key);
    assert.equal(preview().scopeLabel, "Previous histogram · Selected polygons · countries");
    const mapRead = reads.at(-1);
    mapRead.pending.resolve(createCategoryStatistics(item, mapRead.area.selectedBounds, mapRead.codes)); await flushPromises();
    assert.match(preview().scopeLabel, /^Sampling box\b/i);
    assert.equal(preview().feedback.message, ""); assert.equal(preview().feedback.isBusy, false);
    h.viewer.exploreAt({ lng: 15, lat: 38 }); await flushPromises();
    const replacement = reads.at(-1);
    assert.notEqual(replacement, mapRead);
    h.layerStackView.handlers.onAllVisibility(false); h.viewer.openStyle(key);
    assert.equal(replacement.signal.aborted, true);
    assert.equal(preview().feedback.isBusy, false);
    assert.equal(preview().scopeLabel, "Previous histogram · Sampling box");
    assert.match(preview().feedback.message, /Sampling box\b.*:/i);
    replacement.pending.resolve(createCategoryStatistics(item, replacement.area.selectedBounds, replacement.codes)); await flushPromises();
    assert.equal(preview().scopeLabel, "Previous histogram · Sampling box", "Late cancelled reply cannot relabel the preview");
    h.destroy();
});

test("style category changes preserve map scope and never display unmatched cached codes", async () => {
    const reads = [];
    const h = visibleLayerFixture((item, area, signal, _fetch, codes) => {
        if (area.kind === "wholeRaster") return Promise.resolve(createCategoryStatistics(item, null, codes));
        const pending = createDeferred(); reads.push({ item, area, signal, codes, pending }); return pending.promise;
    });
    const item = createRasterItem("style-category-scope");
    await h.viewer.show(item); await flushPromises();
    const key = h.mapLayers.retainedRecords[0].entry.key;
    editCategoricalAppearance(h, key); await flushPromises();
    h.viewer.exploreAt({ lng: 14, lat: 37.5 }); await flushPromises();
    reads[0].pending.resolve(createCategoryStatistics(item, reads[0].area.selectedBounds, reads[0].codes)); await flushPromises();
    h.viewer.openStyle(key);
    const changed = categoricalAppearance(); changed.categories[0].value = 42;
    editCategoricalAppearance(h, key, changed);
    assert.equal(h.controlsView.categoricalStyleHistogram, null);
    assert.match(h.controlsView.styleHistogramState.scopeLabel, /^Sampling box\b/i);
    assert.equal(h.controlsView.styleHistogramState.isBusy, true);
    const read = reads.at(-1);
    read.pending.resolve(createCategoryStatistics(item, read.area.selectedBounds, read.codes)); await flushPromises();
    const count = reads.length;
    changed.categories[0] = { ...changed.categories[0], label: "Renamed forest", color: "#112233", opacity: 0.2 };
    editCategoricalAppearance(h, key, changed); await flushPromises();
    const preview = h.controlsView.categoricalStyleHistogram;
    assert.equal(reads.length, count, "Presentation-only changes reuse the sample");
    assert.match(preview.scopeLabel, /^Sampling box\b/i); assert.equal(preview.feedback.message, "");
    assert.deepEqual(preview.presentation.rows.find(row => row.code === 42), {
        code: 42, label: "Renamed forest", color: "#112233", opacity: 0.2, hectares: 10, percentage: 100 * 10 / 35,
    });
    assert.equal(preview.presentation.rows.some(row => row.code === 41), false);
    h.destroy();
});

test("raster adapter exports and reapplies only validated portable appearance", async () => {
    const h = visibleLayerFixture();
    await h.viewer.show(createRasterItem("portable"));
    const record = h.mapLayers.retainedRecords[0];

    const exported = record.adapter.exportSavedState(record);
    assert.equal(exported.kind, "raster");
    assert.equal(exported.appearanceVersion, 1);
    assert.equal(exported.mode, "continuous");
    assert.deepEqual(exported.continuous.definition, record.state.rasterStyle);
    assert.equal(exported.continuous.paletteName, "blue-yellow-red");
    assert.equal(exported.categorical, null);
    assert.equal(
        record.adapter.checkSavedStateCompatibility(record, exported),
        null,
    );
    assert.match(
        record.adapter.checkSavedStateCompatibility(record, {
            kind: "vector",
            definition: {},
        }),
        /Only copied raster styles/,
    );
    assert.match(
        record.adapter.checkSavedStateCompatibility(record, {
            ...exported,
            continuous: { ...exported.continuous, paletteName: "not-a-palette" },
        }),
        /palette is invalid/,
    );
    const restoredStyle = {
        ...DEFAULT_RASTER_STYLE,
        minimum: -5,
        midpoint: 0,
        maximum: 20,
        minimumColor: "#000000",
    };
    const restoredAppearance = {
        ...exported,
        continuous: { definition: restoredStyle, paletteName: "custom", styleWasEdited: true },
    };
    record.adapter.applySavedState(record, restoredAppearance);

    assert.deepEqual(record.state.rasterStyle, restoredStyle);
    assert.equal(record.state.paletteName, "custom");
    assert.equal(h.wmsLayers[0].parameters.styles, "dynamic-raster");
    assert.match(h.wmsLayers[0].parameters.env, /min:-5/);
    assert.throws(
        () => record.adapter.applySavedState(record, {
            ...restoredAppearance,
            continuous: { ...restoredAppearance.continuous,
                definition: { ...restoredStyle, sourcePath: "file:///data.tif" } },
        }),
        /unsupported fields/,
    );
    h.destroy();
});

test("saved style updates a staged raster before it is attached", async () => {
    const h = visibleLayerFixture();
    const staged = await h.viewer.stage(
        createRasterItem("staged-portable"),
        { visible: true, opacity: 0.6 },
    );
    const restoredStyle = {
        ...DEFAULT_RASTER_STYLE,
        minimum: 0.25,
        midpoint: 0.5,
        maximum: 0.75,
    };

    assert.equal(h.mapLayers.retainedRecords.length, 0);
    assert.equal(h.leafletMap.layers.size, 0);
    staged.record.adapter.applySavedState(staged.record, {
        ...staged.record.adapter.exportSavedState(staged.record),
        continuous: { definition: restoredStyle, paletteName: "blue-yellow-red", styleWasEdited: true },
    });

    assert.deepEqual(staged.record.state.rasterStyle, restoredStyle);
    assert.equal(staged.layer.parameters.styles, "dynamic-raster");
    assert.match(staged.layer.parameters.env, /min:0.25/);
    assert.match(staged.layer.parameters.env, /med:0.5/);
    assert.match(staged.layer.parameters.env, /max:0.75/);
    assert.equal(h.leafletMap.layers.size, 0);

    h.mapLayers.commitStaged([staged], { fitToBounds: false });
    assert.equal(h.leafletMap.layers.has(staged.layer), true);
    assert.equal(staged.layer.opacity, 0.6);
    h.destroy();
});

test("views sharing one Catalog Item keep separate styles and histogram categories", async () => {
    const requestedCodes = [];
    const h = visibleLayerFixture(async (item, area, _signal, _fetch, codes) => {
        requestedCodes.push(codes);
        return createCategoryStatistics(item, selectedBoundsFromArea(area), codes);
    });
    const item = createRasterItem("same-source");
    const first = await h.viewer.stage(item, { key: "local:view:first", visible: true, opacity: 1 });
    const second = await h.viewer.stage(item, { key: "local:view:second", visible: true, opacity: 0.5 });
    const appearances = [categoricalAppearance(), {
        mode: "categorical", categories: [{value: 7, label: "Seven", color: "#0000ff", opacity: 1}],
        unmapped: {color: "#808080", opacity: 0},
    }];
    for (const [index, staged] of [first, second].entries()) {
        const {record} = staged;
        record.adapter.applySavedState(record, {
            ...record.adapter.exportSavedState(record), mode: "categorical", categorical: appearances[index],
        });
    }
    h.mapLayers.commitStaged([first, second], { fitToBounds: false });
    await flushPromises();

    assert.equal(first.record.state.item, second.record.state.item);
    assert.notEqual(first.record.state.analysis, second.record.state.analysis);
    for (const [index, staged] of [first, second].entries()) {
        const codes = appearances[index].categories.map(row => row.value).sort((a, b) => a - b);
        assert.ok(requestedCodes.some(requested => JSON.stringify([...requested].sort((a, b) => a - b)) === JSON.stringify(codes)));
        assert.deepEqual(staged.record.state.analysis.wholeRasterStatistics.categoricalDistribution.categoryValues, codes);
        assert.deepEqual(staged.record.adapter.exportSavedState(staged.record).categorical, appearances[index]);
    }
    h.mapLayers.removeKey(first.key);
    assert.equal(h.mapLayers.findLayerKey(item), second.key);
    assert.equal(h.mapLayers.isAttached(second.key), true);
    assert.deepEqual(second.record.adapter.exportSavedState(second.record).categorical, appearances[1]);
    h.destroy();
});

test("categorical editor commits exact tables to both rendering boundaries and preserves both modes", async () => {
    const h = visibleLayerFixture();
    await h.viewer.show(createRasterItem("categorical-modes"));
    await flushPromises();
    const record = h.mapLayers.retainedRecords[0];
    const key = record.entry.key;
    h.viewer.openStyle(key);
    h.controlsView.style = { ...h.controlsView.style, minimum: -5, midpoint: 0, maximum: 30 };
    h.controlsView.paletteName = "custom";
    h.controlsView.handlers.onStyleInput(false);
    h.controlsView.handlers.onStyleChange();
    const continuous = record.adapter.exportSavedState(record).continuous;
    const style = categoricalAppearance();
    assert.ok(h.controlsView.layerHistograms.every((summary) =>
        !Object.hasOwn(summary, "unavailableMessage")
    ));

    editCategoricalAppearance(h, key, style);

    assert.equal(h.controlsView.categoricalError, null);
    assert.match(h.controlsView.appearanceStatus, /Applied categorical styling/);
    await flushPromises();
    assert.match(h.controlsView.statisticsStatus, /categorical/i);
    assert.equal(record.state.appearanceMode, "categorical");
    assert.deepEqual(record.adapter.renderDescriptor(record), {
        layerName: record.publication.layerName,
        styleName: "dynamic-raster",
        styleDefinition: style,
    });
    assert.deepEqual(JSON.parse(record.state.layer.wmsParams.raster_style), style);
    assert.equal(Object.hasOwn(record.state.layer.wmsParams, "env"), false);
    assert.deepEqual(record.adapter.exportSavedState(record).continuous, continuous);
    h.mapLayers.setOpacity(key, 0.4);
    const categoricalSnapshot = h.mapLayers.snapshots().find((layer) => layer.key === key);
    assert.equal(categoricalSnapshot.legend.kind, "categories");
    assert.deepEqual(categoricalSnapshot.legend.entries.map((entry) => entry.label),
        ["Forest (41)", "Background (0)", "Other (-1)", "Unmapped"]);
    assert.deepEqual(categoricalSnapshot.legend.entries.map((entry) => entry.symbol.fill),
        ["#228b22", "#000000", "#aabbcc", "#808080"]);
    assert.deepEqual(categoricalSnapshot.legend.entries.map((entry) => entry.symbol.fillOpacity),
        [0.75, 0, 1, 0.25]);
    assert.equal(categoricalSnapshot.effectiveOpacity, 0.4);

    h.controlsView.handlers.onAppearanceModeChange("continuous");
    await flushPromises();
    assert.equal(Object.hasOwn(record.state.layer.wmsParams, "raster_style"), false);
    assert.match(record.state.layer.wmsParams.env, /min:-5;med:0;max:30/);
    assert.equal(Object.hasOwn(record.adapter.renderDescriptor(record), "styleDefinition"), false);
    assert.equal(h.mapLayers.snapshots().find((layer) => layer.key === key).legend.kind, "gradient");
    assert.deepEqual(h.controlsView.style, continuous.definition);
    assert.deepEqual(record.adapter.exportSavedState(record).categorical, style);
    assert.match(h.controlsView.appearanceStatus, /Restored continuous styling/);
    assert.match(h.controlsView.statisticsStatus, /whole-raster/i);
    assert.doesNotMatch(h.controlsView.statisticsStatus, /categorical/i);
    assert.ok(h.controlsView.displayedStatistics);
    assert.ok(h.controlsView.layerHistograms.every((summary) =>
        !Object.hasOwn(summary, "unavailableMessage")
    ));
    h.controlsView.handlers.onAppearanceModeChange("categorical");
    assert.deepEqual(record.adapter.renderDescriptor(record).styleDefinition, style);
    assert.deepEqual(record.adapter.exportSavedState(record).continuous, continuous);
    assert.match(h.controlsView.appearanceStatus, /Applied categorical styling/);
    await flushPromises();
    assert.match(h.controlsView.statisticsStatus, /categorical/i);
    h.destroy();
});

test("committed categories refresh retained pixels and clipboard without resampling pending locations", async () => {
    const timers = new Map();
    let timerId = 0;
    const clock = {
        /** @param {()=>void} callback Timer work. @return {number} Timer identity. */
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
        /** @param {number} id Timer to cancel. @return {void} */
        clearTimeout(id) { timers.delete(id); },
        /** Run the next scheduled cursor dwell. @return {void} */
        runNext() {
            const [id, callback] = timers.entries().next().value;
            timers.delete(id);
            callback();
        },
    };
    const documentContext = new FakeRasterControlDocument();
    const copied = [];
    const cursorValuesView = new RasterCursorValuesView(documentContext, {
        /** @param {string} text Clipboard output. @return {Promise<void>} */
        async writeText(text) { copied.push(text); },
    });
    const cursorRequests = [];
    let pointReads = 0;
    const h = visibleLayerFixture(undefined, {
        clock, cursorValuesView,
        /** Return the original numeric code. @return {Promise<Object>} Exact result. */
        samplePixel: async () => { pointReads += 1; return { inBounds: true, value: 41 }; },
        /**
         * Retain a numeric cursor request for controlled completion.
         * @param {Object} item Catalog source.
         * @param {Object} point Geographic position.
         * @param {AbortSignal} signal Cancellation boundary.
         * @return {Promise<Object>} Exact pixel result.
         */
        sampleCursorPixel: (item, point, signal) => {
            const deferred = createDeferred();
            cursorRequests.push({ ...deferred, item, point, signal });
            return deferred.promise;
        },
    });
    await h.viewer.show(createRasterItem("category-pixel-refresh"));
    await flushPromises();
    const record = h.mapLayers.retainedRecords[0];
    const key = record.entry.key;
    editCategoricalAppearance(h, key);
    h.mapLayers.setOpacity(key, 0);
    h.viewer.exploreAt({ lng: 1, lat: 1 });
    await flushPromises();

    h.leafletMap.emit("mousemove", {
        latlng: { lng: 1, lat: 1 }, originalEvent: { clientX: 101, clientY: 100 },
    });
    clock.runNext();
    cursorRequests[0].resolve({ inBounds: true, value: 41 });
    await flushPromises();
    const list = documentContext.querySelector("#raster-cursor-value-list");
    const marker = documentContext.querySelector("#raster-cursor-marker");
    const root = documentContext.querySelector("#raster-cursor-values");
    const position = documentContext.querySelector("#raster-cursor-position");
    const pending = documentContext.querySelector("#raster-cursor-pending");
    assert.equal(list.children[0].children[1].textContent, "Forest (41)");

    h.leafletMap.emit("mousemove", {
        latlng: { lng: 2, lat: 1 }, originalEvent: { clientX: 202, clientY: 100 },
    });
    clock.runNext();
    const renamed = categoricalAppearance();
    renamed.categories[0] = { value: 41, label: "Woodland", color: "#115511", opacity: 0 };
    renamed.categories.reverse();
    h.controlsView.categoricalStyle = renamed;
    h.controlsView.handlers.onCategoricalStyleChange();
    assert.equal(pointReads, 0);
    assert.equal(cursorRequests.length, 2);
    assert.equal(cursorRequests[1].signal.aborted, false);
    assert.equal(list.children[0].children[1].textContent, "Woodland (41)");
    assert.equal(marker.style.left, "101px");
    assert.equal(position.textContent, "Lat 1.00000 · Lng 1.00000");
    assert.equal(pending.hidden, false);
    assert.equal(root.getAttribute("aria-busy"), "true");
    const legend = h.mapLayers.snapshots().find((layer) => layer.key === key).legend;
    assert.deepEqual(legend.entries.map((entry) => entry.label),
        ["Other (-1)", "Background (0)", "Woodland (41)", "Unmapped"]);
    assert.equal(legend.entries[2].symbol.fill, "#115511");
    assert.equal(legend.entries[2].symbol.fillOpacity, 0);

    const copyEvent = new Event("keydown", { cancelable: true });
    Object.assign(copyEvent, { key: "c", ctrlKey: true });
    documentContext.dispatchEvent(copyEvent);
    await flushPromises();
    assert.match(copied.at(-1), /Longitude\t1\n/);
    assert.match(copied.at(-1), /Woodland \(41\)/);

    h.controlsView.categoricalStyle = { ...renamed, categories: [] };
    h.controlsView.handlers.onCategoricalStyleChange();
    assert.equal(list.children[0].children[1].textContent, "Woodland (41)");
    h.controlsView.categoricalStyle = renamed;
    h.controlsView.handlers.onAppearanceModeChange("continuous");
    assert.equal(list.children[0].children[1].textContent, "4.100e+1");
    h.controlsView.handlers.onAppearanceModeChange("categorical");
    assert.equal(h.mapLayers.copyStyle(key), true);
    h.controlsView.handlers.onAppearanceModeChange("continuous");
    assert.equal(await h.mapLayers.pasteStyle(key), true);
    assert.equal(list.children[0].children[1].textContent, "Woodland (41)");
    assert.equal(cursorRequests.length, 2);
    assert.equal(pointReads, 0);
    assert.equal(marker.style.left, "101px");
    assert.equal(pending.hidden, false);

    cursorRequests[1].resolve({ inBounds: true, value: 42.5 });
    await flushPromises();
    assert.equal(list.children[0].children[1].textContent, "Unmapped (42.5)");
    assert.equal(marker.style.left, "202px");
    assert.equal(pending.hidden, true);
    h.leafletMap.emit("mousemove", {
        latlng: { lng: 3, lat: 1 }, originalEvent: { clientX: 303, clientY: 100 },
    });
    clock.runNext();
    cursorRequests[2].resolve({ inBounds: true, value: null });
    await flushPromises();
    assert.equal(list.children[0].children[1].textContent, "No data");
    h.destroy();
    assert.equal(root.hidden, true);
});

test("empty and invalid category drafts never replace the last valid rendering or saved appearance", async () => {
    const h = visibleLayerFixture();
    await h.viewer.show(createRasterItem("categorical-invalid"));
    await flushPromises();
    const record = h.mapLayers.retainedRecords[0];
    h.viewer.openStyle(record.entry.key);
    const original = record.adapter.exportSavedState(record);
    const initialUpdates = record.state.layer.parameterUpdates.length;
    h.controlsView.handlers.onAppearanceModeChange("categorical");
    assert.ok(h.controlsView.categoricalError instanceof Error);
    assert.equal(record.state.layer.parameterUpdates.length, initialUpdates);
    assert.deepEqual(record.adapter.exportSavedState(record), original);

    editCategoricalAppearance(h, record.entry.key);
    const committed = record.adapter.exportSavedState(record);
    const descriptor = record.adapter.renderDescriptor(record);
    const params = structuredClone(record.state.layer.wmsParams);
    const updates = record.state.layer.parameterUpdates.length;
    h.controlsView.categoricalStyle.categories[1].value = 41;
    h.controlsView.handlers.onCategoricalStyleInput();
    h.controlsView.handlers.onCategoricalStyleChange();
    assert.match(h.controlsView.categoricalError.message, /duplicates/);
    assert.match(h.controlsView.appearanceStatus, /last valid appearance/);
    assert.equal(h.controlsView.categoricalStyle.categories[1].value, 41);
    assert.equal(record.state.layer.parameterUpdates.length, updates);
    assert.deepEqual(record.state.layer.wmsParams, params);
    assert.deepEqual(record.adapter.renderDescriptor(record), descriptor);
    assert.deepEqual(record.adapter.exportSavedState(record), committed);
    assert.equal(h.mapLayers.copyStyle(record.entry.key), true);
    assert.deepEqual(h.mapLayers.styleClipboard.savedState, committed);
    h.viewer.closeStyle();
    assert.equal(record.state.layer.parameterUpdates.length, updates);
    h.destroy();
});

test("late active and inactive whole-raster statistics cannot replace categorical appearances", async () => {
    const first = createRasterItem("categorical-late-first");
    const second = createRasterItem("categorical-late-second");
    const results = new Map([[first.id, createDeferred()], [second.id, createDeferred()]]);
    const h = visibleLayerFixture((item, area, _signal, _fetch, codes) => codes
        ? Promise.resolve(createCategoryStatistics(item, selectedBoundsFromArea(area), codes))
        : results.get(item.id).promise);
    await h.viewer.show(first);
    await h.viewer.show(second);
    const records = [...h.mapLayers.retainedRecords];
    for (const record of records) editCategoricalAppearance(h, record.entry.key);
    const committed = records.map((record) => record.adapter.exportSavedState(record));
    const updates = records.map((record) => record.state.layer.parameterUpdates.length);

    results.get(first.id).resolve(createLayerStatistics(first));
    results.get(second.id).resolve(createLayerStatistics(second));
    await flushPromises();

    for (const [index, record] of records.entries()) {
        assert.equal(record.state.analysis.wholeRasterStatisticsState, "ready");
        assert.deepEqual(record.adapter.exportSavedState(record), committed[index]);
        assert.equal(record.state.layer.parameterUpdates.length, updates[index]);
        assert.equal(Object.hasOwn(record.state.layer.wmsParams, "env"), false);
    }
    assert.equal(h.controlsView.displayedStatistics, null);
    assert.equal(h.controlsView.styleHistogram, null);
    assert.equal(h.controlsView.layerHistograms[0].percentileSettings, undefined);
    assert.ok(h.controlsView.layerHistograms.every((summary) =>
        summary.state === "ready" && summary.counts === null &&
        summary.statistics === null && summary.categorical?.rows.length === 4
    ));
    h.destroy();
});

test("categorical styles round-trip through save, copy/paste and removed-layer undo", async () => {
    let catalog;
    const source = createRasterItem("categorical-copy-source");
    const target = createRasterItem("categorical-copy-target");
    const items = new Map([[source.id, source], [target.id, target]]);
    const h = visibleLayerFixture(undefined, {}, {}, {
        restoreRemovedLayer: (snapshot, isCurrent) => catalog.restoreRemovedLayer(
            snapshot, async (identity) => items.get(identity.id), isCurrent,
        ),
    });
    catalog = new CatalogVisualizationCoordinator(h.viewer, h.mapLayers, {});
    await h.viewer.show(source);
    await h.viewer.show(target);
    await flushPromises();
    const [targetRecord, sourceRecord] = h.mapLayers.retainedRecords;
    editCategoricalAppearance(h, sourceRecord.entry.key);
    h.mapLayers.setOpacity(sourceRecord.entry.key, 0.4);
    const savedAppearance = sourceRecord.adapter.exportSavedState(sourceRecord);
    assert.equal(h.mapLayers.copyStyle(sourceRecord.entry.key), true);
    h.viewer.openStyle(targetRecord.entry.key);
    h.controlsView.handlers.onAppearanceModeChange("continuous");
    assert.match(h.controlsView.appearanceStatus, /Restored continuous styling/);
    assert.equal(await h.mapLayers.pasteStyle(targetRecord.entry.key), true);
    assert.equal(h.controlsView.appearanceStatus, "");
    assert.deepEqual(targetRecord.adapter.exportSavedState(targetRecord), savedAppearance);
    assert.equal(targetRecord.entry.opacity, 0.4);

    const saved = createSavedMapView({
        viewer: { version: "test", origin: "https://example.test" },
        createdAt: "2026-10-06T00:00:00Z",
        viewport: { center: { latitude: 0, longitude: 0 }, zoom: 2 },
        layers: [{
            catalogItem: { collection: source.collection, id: source.id },
            visible: true, opacity: 0.4, style: savedAppearance,
        }],
    });
    const restored = parseSavedMapView(serializeSavedMapView(saved));
    assert.deepEqual(restored.layers[0].style, savedAppearance);
    const staged = await h.viewer.stage(createRasterItem("categorical-saved"), {
        visible: false, opacity: restored.layers[0].opacity,
    });
    staged.record.adapter.applySavedState(staged.record, restored.layers[0].style);
    assert.deepEqual(staged.record.adapter.exportSavedState(staged.record), savedAppearance);
    assert.equal(Object.hasOwn(staged.layer.wmsParams, "env"), false);
    assert.deepEqual(JSON.parse(staged.layer.wmsParams.raster_style), savedAppearance.categorical);
    assert.equal(h.leafletMap.layers.has(staged.layer), false);

    const sourceKey = sourceRecord.entry.key;
    assert.equal(h.mapLayers.removeWithUndo(sourceKey), true);
    assert.equal(h.mapLayers.getRecord(sourceKey), null);
    await h.mapLayers.undoLayerRemoval();
    const undoRecord = h.mapLayers.getRecord(sourceKey);
    assert.notEqual(undoRecord, null);
    assert.deepEqual(undoRecord.adapter.exportSavedState(undoRecord), savedAppearance);
    assert.equal(undoRecord.entry.opacity, 0.4);
    assert.deepEqual(undoRecord.adapter.renderDescriptor(undoRecord).styleDefinition, savedAppearance.categorical);
    assert.equal(h.mapLayers.removedLayer, null);
    await flushPromises();
    assert.ok(h.controlsView.layerHistograms.every(summary => summary.state === "ready" && summary.categorical));
    h.destroy();
});

test("another Catalog raster view copies appearance and keeps histogram actions tied to that view", async () => {
    let catalog;
    const item = createRasterItem("two-views");
    const calculations = [], downloads = [];
    const h = visibleLayerFixture(undefined, {}, {
        onCalculateRequested: (...args) => calculations.push(args),
        onDownloadRequested: (...args) => downloads.push(args),
    }, {restoreRemovedLayer: (snapshot, isCurrent) =>
        catalog.restoreRemovedLayer(snapshot, async () => item, isCurrent)});
    catalog = new CatalogVisualizationCoordinator(h.viewer, h.mapLayers, {});
    try {
        await h.viewer.show(item);
        const original = h.mapLayers.retainedRecords[0];
        editCategoricalAppearance(h, original.entry.key);
        h.mapLayers.renameLayer(original.entry.key, "Land cover");
        h.mapLayers.setOpacity(original.entry.key, 0.4);
        const appearance = original.adapter.exportSavedState(original);
        const copiedKey = await h.mapLayers.addAnotherView(original.entry.key);
        const copied = h.mapLayers.getRecord(copiedKey);
        assert.equal(copied.entry.item, item);
        assert.notEqual(copied.state.analysis, original.state.analysis);
        assert.deepEqual(copied.adapter.exportSavedState(copied), appearance);
        assert.equal(copied.entry.label, "Land cover");
        assert.equal(copied.entry.opacity, 0.4);
        h.mapLayers.renameLayer(copiedKey, "Forest only");
        const changed = categoricalAppearance();
        changed.categories[0].color = "#ff0000";
        editCategoricalAppearance(h, copiedKey, changed);
        assert.deepEqual(original.adapter.exportSavedState(original), appearance);
        h.controlsView.handlers.onCalculateHistogram(copiedKey);
        h.controlsView.handlers.onDownloadHistogram(copiedKey);
        assert.deepEqual(calculations[0], [item, null, "Forest only", copiedKey]);
        assert.deepEqual(downloads[0], [item, null, "Forest only"]);
        h.mapLayers.removeKey(original.entry.key);
        assert.equal(h.mapLayers.findLayerKey(item), copiedKey);
        assert.equal(h.mapLayers.getRecord(copiedKey), copied);
    } finally { h.destroy(); }
});

test("Reverse colors commits only the editing view and survives percentile edits, duplication and saved maps", async () => {
    const item = createRasterItem("reverse-colors");
    let catalog;
    const h = visibleLayerFixture(undefined, {}, {}, { restoreRemovedLayer: (snapshot, isCurrent) =>
        catalog.restoreRemovedLayer(snapshot, async () => item, isCurrent) });
    catalog = new CatalogVisualizationCoordinator(h.viewer, h.mapLayers, {});
    const document = new FakeRasterControlDocument();
    const appearance = new RasterAppearanceControlsView(document);
    appearance.bind(h.controlsView.handlers);
    for (const method of ["readStyle", "setStyle", "getPaletteName", "setPaletteName", "renderLegend"]) {
        h.controlsView[method] = appearance[method].bind(appearance);
    }
    try {
        await h.viewer.show(item);
        await flushPromises();
        const original = h.mapLayers.retainedRecords[0];
        const originalState = original.adapter.exportSavedState(original);
        const key = await h.mapLayers.addAnotherView(original.entry.key);
        const edited = h.mapLayers.getRecord(key);
        h.mapLayers.activate(key);
        h.controlsView.handlers.onClearSampleWindow();
        await flushPromises();
        h.viewer.openStyle(key);
        const before = { ...appearance.readStyle(), minimumOpacity: 0.25, midpointOpacity: 0.5, maximumOpacity: 0.75 };
        appearance.setStyle(before, "blue-yellow-red");
        h.controlsView.handlers.onStyleInput(false);
        h.controlsView.handlers.onStyleChange();
        h.mapLayers.setOpacity(key, 0.4);
        const selectedPercentiles = { lower: 25, middle: 60, upper: 100 };
        h.controlsView.handlers.onHistogramPercentiles(key, {...selectedPercentiles, rescale: false});
        const reversed = { ...before, minimumColor: before.maximumColor, maximumColor: before.minimumColor };
        appearance.reverseColorsButton.dispatchEvent(new Event("click"));
        assert.deepEqual(appearance.readStyle(), reversed);
        assert.equal(appearance.getPaletteName(), "custom");
        assert.deepEqual(edited.state.rasterStyle, reversed);
        assert.equal(edited.state.layer.wmsParams.env, buildRasterStyleEnvironment(reversed));
        assert.equal(appearance.legend.getAttribute("aria-label"), buildRasterLegend(reversed).description);
        assert.deepEqual(edited.state.histogramPercentiles, {...selectedPercentiles, rescale: false});
        assert.equal(edited.entry.opacity, 0.4);
        assert.deepEqual(original.adapter.exportSavedState(original), originalState);
        appearance.reverseColorsButton.dispatchEvent(new Event("click"));
        assert.deepEqual(edited.state.rasterStyle, before);
        appearance.reverseColorsButton.dispatchEvent(new Event("click"));
        const savedAppearance = edited.adapter.exportSavedState(edited);
        const saved = createSavedMapView({
            viewer: { version: "test", origin: "https://example.test" }, createdAt: "2026-10-06T00:00:00Z",
            viewport: { center: { latitude: 0, longitude: 0 }, zoom: 2 },
            layers: [{ catalogItem: { collection: item.collection, id: item.id },
                visible: true, opacity: 0.4, style: savedAppearance }],
        });
        assert.deepEqual(parseSavedMapView(serializeSavedMapView(saved)).layers[0].style, savedAppearance);
        const copied = h.mapLayers.getRecord(await h.mapLayers.addAnotherView(key));
        assert.deepEqual(copied.adapter.exportSavedState(copied), savedAppearance);
        h.viewer.openStyle(key);
        appearance.palette.value = "blue-yellow-red";
        appearance.palette.dispatchEvent(new Event("change"));
        assert.deepEqual(edited.state.rasterStyle, {
            ...savedAppearance.continuous.definition,
            minimumColor: before.minimumColor, maximumColor: before.maximumColor,
        });
        assert.equal(appearance.getPaletteName(), "blue-yellow-red");
    } finally {
        appearance.unbind();
        h.destroy();
    }
});

test("CSV preview commits through the category editor and persists through the existing appearance contract", async () => {
    const h = visibleLayerFixture();
    const appearance = new RasterAppearanceControlsView(new FakeRasterControlDocument());
    const editor = appearance.categoricalEditor;
    appearance.bind(h.controlsView.handlers);
    for (const method of ["setCategoricalStyle", "readCategoricalStyle", "setAppearanceMode",
        "renderCategoricalError", "cancelCategoricalImport"]) {
        h.controlsView[method] = appearance[method].bind(appearance);
    }
    h.controlsView.setAppearanceEnabled = appearance.setEnabled.bind(appearance);
    const csv = 'value,label,color,opacity\r\n0,"Water, clear",#2166AC,0\r\n41,Forest,#228b22,\r\n-1,Other,#808080,0.5\r\n';
    const bytes = new TextEncoder().encode(csv);
    /**
     * Select a file through the actual editor input boundary.
     * @param {Promise<ArrayBuffer>} content Asynchronous bounded file content.
     * @return {void}
     */
    const select = (content = Promise.resolve(bytes.buffer)) => {
        editor.csvFile.files = [{ name: "categories.csv", size: bytes.byteLength,
            arrayBuffer: () => content }];
        editor.csvFile.dispatchEvent(new Event("change"));
    };
    try {
        await h.viewer.show(createRasterItem("csv-import"));
        const record = h.mapLayers.retainedRecords[0];
        h.viewer.openStyle(record.entry.key);
        const before = record.adapter.exportSavedState(record);
        h.controlsView.handlers.onAppearanceModeChange("categorical");
        editor.unmappedColor.value = "#123456";
        editor.unmappedOpacity.value = "25";
        select();
        await flushPromises();
        assert.equal(editor.csvPreview.hidden, false);
        assert.equal(editor.csvApply.disabled, false);
        assert.deepEqual(record.adapter.exportSavedState(record), before,
            "preview leaves rendered and persisted appearance unchanged");
        editor.csvApply.dispatchEvent(new Event("click"));
        const applied = record.adapter.exportSavedState(record);
        assert.equal(applied.mode, "categorical");
        assert.deepEqual(applied.continuous, before.continuous);
        assert.deepEqual(applied.categorical.unmapped, { color: "#123456", opacity: 0.25 });
        assert.deepEqual(applied.categorical.categories, [
            { value: 0, label: "Water, clear", color: "#2166ac", opacity: 0 },
            { value: 41, label: "Forest", color: "#228b22", opacity: 1 },
            { value: -1, label: "Other", color: "#808080", opacity: 0.5 },
        ]);
        assert.deepEqual(JSON.parse(record.state.layer.wmsParams.raster_style), applied.categorical);
        assert.equal(h.mapLayers.snapshots()[0].legend.entries[0].label, "Water, clear (0)");
        editor.rows[1].inputs.label.value = "Imported forest";
        editor.rows[1].inputs.label.dispatchEvent(new Event("change"));
        assert.equal(record.adapter.exportSavedState(record).categorical.categories[1].label, "Imported forest");
        const saved = createSavedMapView({
            viewer: { version: "test", origin: "https://example.test" },
            createdAt: "2026-10-06T00:00:00Z",
            viewport: { center: { latitude: 0, longitude: 0 }, zoom: 2 },
            layers: [{ catalogItem: { collection: record.entry.item.collection, id: record.entry.item.id },
                visible: true, opacity: 1,
                style: record.adapter.exportSavedState(record) }],
        });
        const restored = parseSavedMapView(serializeSavedMapView(saved));
        const staged = await h.viewer.stage(createRasterItem("csv-restored"), { visible: false, opacity: 1 });
        staged.record.adapter.applySavedState(staged.record, restored.layers[0].style);
        assert.deepEqual(staged.record.adapter.exportSavedState(staged.record), restored.layers[0].style);
        h.viewer.closeStyle();
        h.viewer.openStyle(record.entry.key);
        assert.equal(editor.readStyle().categories[1].label, "Imported forest");

        for (const leave of [() => h.viewer.closeStyle(), () => h.viewer.openStyle("missing"),
            () => h.viewer.clear()]) {
            h.viewer.openStyle(record.entry.key);
            const pending = createDeferred();
            select(pending.promise);
            leave();
            pending.resolve(bytes.buffer);
            await flushPromises();
            assert.equal(editor.csvPreview.hidden, true, "a released target cannot receive a late import");
            assert.equal(editor.csvApply.disabled, true);
        }
    } finally {
        appearance.unbind();
        h.destroy();
    }
});

test("hidden raster category edits remain independent of active analysis and visibility", async () => {
    const reads = [];
    const h = visibleLayerFixture(async (item, area) => {
        reads.push({ item, area });
        return createLayerStatistics(item, selectedBoundsFromArea(area));
    });
    await h.viewer.show(createRasterItem("categorical-hidden"));
    await h.viewer.show(createRasterItem("categorical-visible"));
    await flushPromises();
    const [active, hidden] = h.mapLayers.retainedRecords;
    h.mapLayers.setVisible(hidden.entry.key, false);
    const readCount = reads.length;
    const activeAppearance = active.adapter.exportSavedState(active);
    editCategoricalAppearance(h, hidden.entry.key);
    assert.equal(hidden.entry.visible, false);
    assert.equal(h.mapLayers.isAttached(hidden.entry.key), false);
    assert.equal(h.mapLayers.activeKey, active.entry.key);
    assert.deepEqual(active.adapter.exportSavedState(active), activeAppearance);
    assert.equal(reads.length, readCount);
    assert.deepEqual(h.controlsView.layerHistograms.map((summary) => summary.key), [active.entry.key]);
    h.viewer.closeStyle();
    h.viewer.openStyle(hidden.entry.key);
    assert.equal(h.controlsView.appearanceMode, "categorical");
    assert.deepEqual(h.controlsView.readCategoricalStyle(), categoricalAppearance());
    h.destroy();
});

test("categorical guards prevent 2D ramps while numerical statistics remain available", async () => {
    const statisticsReads = [];
    const pixelReads = [];
    let pairedReads = 0;
    let pendingCategoricalStatistics = null;
    const h = visibleLayerFixture(async (item, area, _signal, _fetch, codes) => {
        statisticsReads.push({ item, area, codes });
        if (area.kind !== "wholeRaster" && item.id === "geotiff-categorical-sampling" &&
            pendingCategoricalStatistics !== null) {
            return pendingCategoricalStatistics.promise;
        }
        return createCategoryStatistics(item, selectedBoundsFromArea(area), codes);
    }, {
        samplePixel: async (item) => {
            pixelReads.push(item.id);
            return { inBounds: true, value: 41 };
        },
        loadPairedStatistics: async () => {
            pairedReads += 1;
            return pairedStatistics();
        },
    });
    await h.viewer.show(createRasterItem("continuous-sampling"));
    await h.viewer.show(createRasterItem("categorical-sampling"));
    await flushPromises();
    const [categorical, continuous] = h.mapLayers.retainedRecords;
    assert.equal(h.controlsView.bivariateAvailability.canEnter, true);
    editCategoricalAppearance(h, categorical.entry.key);
    assert.equal(h.controlsView.bivariateAvailability.canEnter, false);
    assert.match(h.controlsView.bivariateAvailability.guidance, /categorical/i);
    h.controlsView.handlers.onBivariateModeChange("bivariate");
    assert.equal(h.controlsView.bivariateMode.active, false);
    assert.equal(pairedReads, 0);
    const readsBefore = statisticsReads.length;
    assert.equal(h.viewer.exploreAt({ lng: 1, lat: 1 }), true);
    await flushPromises();
    assert.equal(statisticsReads.length, readsBefore + 2);
    assert.deepEqual(pixelReads, []);
    assert.equal(categorical.state.analysis.rasterStatistics.scope, "selectedArea");
    const summary = h.controlsView.layerHistograms.find((entry) => entry.key === categorical.entry.key);
    assert.equal(summary.state, "ready");
    assert.equal(summary.counts, null);
    assert.equal(summary.statistics, null);
    assert.equal(summary.categorical.rows.length, 4);
    assert.equal(summary.categorical.nodataHectares, 3);

    pendingCategoricalStatistics = createDeferred();
    assert.equal(h.viewer.exploreAt({ lng: 2, lat: 2 }), true);
    await flushPromises();
    assert.equal(categorical.state.analysis.selectedRasterStatisticsState, "loading");
    assert.equal(h.controlsView.layerHistograms.find((entry) => entry.key === categorical.entry.key).state, "loading");
    assert.match(h.controlsView.statisticsStatus, /categorical/i);
    assert.doesNotMatch(h.controlsView.statisticsStatus, /previous histogram/);
    assert.equal(h.controlsView.displayedStatistics, null);
    pendingCategoricalStatistics.reject(new Error("Selected sample unavailable"));
    await flushPromises();
    assert.equal(categorical.state.analysis.selectedRasterStatisticsState, "error");
    assert.equal(h.controlsView.layerHistograms.find((entry) => entry.key === categorical.entry.key).state, "error");
    assert.match(h.controlsView.statisticsStatus, /categorical/i);
    assert.doesNotMatch(h.controlsView.statisticsStatus, /previous histogram/);
    assert.equal(h.controlsView.displayedStatistics, null);
    assert.match(h.controlsView.statisticsStatus, /unavailable: Selected sample unavailable/);
    pendingCategoricalStatistics = null;
    assert.equal(h.viewer.exploreAt({ lng: 3, lat: 3 }), true);
    await flushPromises();
    assert.equal(categorical.state.analysis.selectedRasterStatisticsState, "ready");

    h.controlsView.handlers.onAppearanceModeChange("continuous");
    await flushPromises();
    assert.equal(h.controlsView.bivariateAvailability.canEnter, true);
    const continuousSummary = h.controlsView.layerHistograms.find((entry) => entry.key === categorical.entry.key);
    assert.ok(continuousSummary.statistics);
    assert.equal(Object.hasOwn(continuousSummary, "unavailableMessage"), false);
    assert.match(h.controlsView.appearanceStatus, /Restored continuous styling/);
    h.controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();
    assert.equal(h.controlsView.bivariateMode.active, true);
    assert.equal(pairedReads, 1);
    h.destroy();
});

test("automatic raster range refreshes the composite rendering plan", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const statistics = createDeferred();
    const compositeUpdates = [];
    const leafletLayers = new LeafletLayerSet(leafletMap, {
        update(rendering) {
            compositeUpdates.push(structuredClone(rendering));
        },
        clear() {},
    });
    let viewer;
    const mapLayers = new MapLayerController({
        leafletMap,
        view: layerStackView,
        leafletLayers,
        onLayersChange: () => viewer?.syncVisibleLayers(),
    });
    const item = createRasterItem("automatic-composite-style");
    viewer = initializeRasterViewer(
        {
            leafletMap,
            leaflet,
            wmsUrl: "/geoserver/eolab/wms",
            onTileError() {},
        },
        {
            controlsView,
            mapLayerController: mapLayers,
            loadStatistics: () => statistics.promise,
            publishRaster: async () => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            loadPairedStatistics: async () => pairedStatistics(),
        },
    );
    viewer.syncVisibleLayers();

    await viewer.show(item);
    const updatesBeforeStatistics = compositeUpdates.length;
    assert.match(
        compositeUpdates.at(-1)[0].styleEnvironment,
        /min:0;med:50;max:100/,
    );

    statistics.resolve(createLayerStatistics(item));
    await flushPromises();

    assert.equal(compositeUpdates.length, updatesBeforeStatistics + 1);
    assert.match(
        compositeUpdates.at(-1)[0].styleEnvironment,
        /min:-4;med:3;max:20/,
    );
    assert.deepEqual(
        mapLayers.snapshots()[0].legend.labels,
        [-4, 3, 20],
    );
    assert.equal(mapLayers.snapshots()[0].datasetKind, "raster");

    viewer.remove(item);
    const firstUpdateAfterRemoval = compositeUpdates.length;
    await viewer.show(item);
    await flushPromises();

    const readditionUpdates = compositeUpdates.slice(firstUpdateAfterRemoval);
    assert.ok(readditionUpdates.length > 0);
    assert.match(
        readditionUpdates.at(-1)[0].styleEnvironment,
        /min:-4;med:3;max:20/,
    );
    viewer.destroy();
    mapLayers.destroy();
});

test('two uncached 1D histograms are submitted independently and both complete', async () => {
    const reads = [];
    let inflight = 0;
    const h = visibleLayerFixture((item, area, signal) => {
        inflight++;
        const result = createDeferred();
        reads.push({ item, area, signal, result });
        return result.promise.finally(() => { inflight--; });
    });
    const first = createRasterItem('capacity-first'), second = createRasterItem('capacity-second');
    await h.viewer.show(first);
    reads[0].result.resolve(createLayerStatistics(first));
    await flushPromises();
    await h.viewer.show(second);
    reads[1].result.resolve(createLayerStatistics(second));
    await flushPromises();
    h.viewer.exploreAt({ lng: -74, lat: 41 });
    assert.equal(reads.length, 4);
    assert.equal(inflight, 2);
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.state), ['loading', 'loading']);
    reads[2].result.resolve(createLayerStatistics(reads[2].item, reads[2].area.selectedBounds));
    await flushPromises();
    assert.equal(reads.length, 4);
    reads[3].result.resolve(createLayerStatistics(reads[3].item, reads[3].area.selectedBounds));
    await flushPromises();
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.state), ['ready', 'ready']);
    assert.equal(inflight, 0);
    h.destroy();
});

test('rapid samples abort obsolete and hidden-layer requests and ignore late results', async () => {
    const reads = [];
    const h = visibleLayerFixture((item, area, signal) => {
        if (area.kind === 'wholeRaster') return Promise.resolve(createLayerStatistics(item));
        const result = createDeferred();
        reads.push({ item, area, signal, result });
        return result.promise;
    });
    await h.viewer.show(createRasterItem('first'));
    await h.viewer.show(createRasterItem('second'));
    await flushPromises();
    h.controlsView.handlers.onSampleWindowRangeInput(200);
    h.viewer.exploreAt({ lng: -74, lat: 41 });
    h.viewer.exploreAt({ lng: -72, lat: 43 });
    assert.equal(reads.length, 4);
    assert.ok(reads.slice(0, 2).every(read => read.signal.aborted));
    const [, bottom] = h.mapLayers.snapshots();
    h.mapLayers.setVisible(bottom.key, false);
    assert.equal(reads.filter(read => !read.signal.aborted).length, 1);
    for (const read of reads) read.result.resolve(createLayerStatistics(read.item, read.area.selectedBounds));
    await flushPromises();
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.state), ['ready']);
    assert.ok(h.controlsView.layerHistograms[0].statistics.selectedBounds.west > -74);
    h.viewer.exploreAt({ lng: -70, lat: 45 });
    h.destroy();
    assert.equal(reads[4].signal.aborted, true);
    reads[4].result.resolve(createLayerStatistics(reads[4].item, reads[4].area.selectedBounds));
    await flushPromises();
    assert.equal(reads.length, 5);
});

test('mode changes cancel 1D requests and submit 2D without a browser queue', async () => {
    const reads = [];
    let pairedCalls = 0;
    const h = visibleLayerFixture((item, area, signal) => {
        if (area.kind === 'wholeRaster') return Promise.resolve(createLayerStatistics(item));
        const result = createDeferred();
        reads.push({ item, area, signal, result });
        return result.promise;
    }, { loadPairedStatistics: async () => { pairedCalls++; return pairedStatistics(); } });
    await h.viewer.show(createRasterItem('first'));
    await h.viewer.show(createRasterItem('second'));
    await flushPromises();
    h.viewer.exploreAt({ lng: -74, lat: 41 });
    h.controlsView.handlers.onBivariateModeChange('bivariate');
    assert.equal(reads.length, 2);
    assert.ok(reads.every(read => read.signal.aborted));
    assert.equal(pairedCalls, 1);
    for (const read of reads) read.result.resolve(createLayerStatistics(read.item, read.area.selectedBounds));
    await flushPromises();
    h.controlsView.handlers.onBivariateModeChange('overlay');
    assert.equal(reads.length, 4);
    for (const read of reads.slice(2)) read.result.resolve(createLayerStatistics(read.item, read.area.selectedBounds));
    await flushPromises();
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.state), ['ready', 'ready']);
    h.destroy();
});

test('one-shot map exploration replaces its footprint without a hidden pause mode', async () => {
    const requests = [];
    const h = visibleLayerFixture(async (item, area) => {
        requests.push({ item, area });
        return createLayerStatistics(item, selectedBoundsFromArea(area));
    });
    await h.viewer.show(createRasterItem('first'));
    await h.viewer.show(createRasterItem('second'));
    await flushPromises();
    h.viewer.exploreAt({ lng: 0, lat: 0 });
    await flushPromises();
    const statistics = h.controlsView.displayedStatistics;
    const footprint = [...h.leafletMap.layers].find(layer => layer.kind === 'selection');
    assert.ok(footprint);
    assert.equal(statistics.scope, 'selectedArea');
    const bounds = [...footprint.boundsHistory];
    const count = requests.length;
    h.leafletMap.emit('moveend', {});
    h.leafletMap.emit('zoomend', {});
    assert.equal(requests.length, count);
    assert.deepEqual(footprint.boundsHistory, bounds);
    h.viewer.exploreAt({ lng: 4, lat: 4 });
    await flushPromises();
    assert.ok(requests.length > count);
    assert.equal(h.leafletMap.layers.has(footprint), true);
    assert.equal(footprint.boundsHistory.length, bounds.length + 1);
    assert.notDeepEqual(h.controlsView.displayedStatistics.selectedBounds, statistics.selectedBounds);
    h.destroy();
});

test('visible raster histograms follow order, skip vectors and never follow the style editor', async () => {
    const h = visibleLayerFixture();
    const first = createRasterItem('first'), second = createRasterItem('second');
    await h.viewer.show(first);
    await h.viewer.show(second);
    await flushPromises();
    const [secondKey, firstKey] = h.mapLayers.snapshots().map(layer => layer.key);
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.label), ['second.tif', 'first.tif']);
    assert.ok(h.controlsView.layerHistograms.every(s => s.automatic && s.state === 'ready'));
    assert.equal(h.controlsView.bivariateMode.active, false);
    assert.equal(h.viewer.openStyle(firstKey), true);
    h.controlsView.style = { ...h.controlsView.style, minimum: -2, midpoint: 4, maximum: 25 };
    h.controlsView.handlers.onStyleInput(false);
    h.controlsView.handlers.onStyleChange();
    assert.equal(h.mapLayers.activeKey, secondKey);
    assert.equal(h.mapLayers.getRecord(firstKey).state.rasterStyle.minimum, -2);
    assert.notEqual(h.mapLayers.getRecord(secondKey).state.rasterStyle.minimum, -2);
    h.mapLayers.reorder(firstKey, 0);
    assert.equal(h.controlsView.style.minimum, -2);
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.label), ['first.tif', 'second.tif']);
    h.mapLayers.setVisible(firstKey, false);
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.label), ['second.tif']);
    h.controlsView.paletteName = 'viridis';
    h.controlsView.handlers.onPaletteChange();
    assert.equal(h.mapLayers.getRecord(firstKey).entry.visible, false);
    assert.equal(h.mapLayers.getRecord(firstKey).state.paletteName, 'viridis');
    assert.equal(h.mapLayers.getRecord(secondKey).state.paletteName, 'blue-yellow-red');
    const vector = { collection: 'vectors', id: 'volcanoes' };
    await h.mapLayers.show(vector, {
        label: () => 'volcanoes.gpkg', publish: async () => ({}), createState: () => ({}),
        createLayer: () => h.leaflet.tileLayer.wms('/geoserver/eolab/wms', {}),
        renderDescriptor: () => ({
            layerName: 'eolab:volcanoes',
            styleName: 'vector-point',
            styleDefinition: { geometryKind: 'point' },
        }),
        snapshot: () => ({ legend: { kind: 'fixed' } }), tileErrorMessage: 'Vector tile error',
    });
    const vectorRecord = h.mapLayers.retainedRecords.find(
        (record) => record.entry.item.id === vector.id,
    );
    assert.equal(vectorRecord.entry.visible, true);
    assert.equal(h.mapLayers.isAttached(vectorRecord.entry.key), true);
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.label), ['second.tif']);
    h.mapLayers.setVisible(secondKey, false);
    assert.deepEqual(h.controlsView.layerHistograms, []);
    assert.equal(h.controlsView.controlsVisible, false);
    h.viewer.activateAnalysis(first);
    assert.deepEqual(h.controlsView.layerHistograms, [], 'Catalog details cannot steal histogram input');
    h.mapLayers.removeKey(firstKey);
    h.viewer.closeStyle();
    h.destroy();
});

test('sequential raster removals release analysis before a vector is added', async () => {
    const h = visibleLayerFixture();
    await h.viewer.show(createRasterItem('bottom'));
    await h.viewer.show(createRasterItem('top'));
    await flushPromises();
    const [top, bottom] = h.mapLayers.snapshots();

    h.mapLayers.removeKey(top.key);
    assert.equal(h.mapLayers.activeKey, bottom.key);
    assert.equal(h.layerStackView.activeKey, bottom.key);
    assert.doesNotThrow(() => h.mapLayers.removeKey(bottom.key));

    const vector = { collection: 'vectors', id: 'reported-vector' };
    await assert.doesNotReject(() => h.mapLayers.show(vector, {
        label: () => 'SOKNOT_2024_node_score_comparison.shp',
        publish: async () => ({}),
        createState: () => ({}),
        createLayer: () => h.leaflet.tileLayer.wms('/geoserver/eolab/wms', {}),
        renderDescriptor: () => ({
            layerName: 'eolab:reported-vector',
            styleName: 'vector-point',
            styleDefinition: { geometryKind: 'point' },
        }),
        snapshot: () => ({ legend: { kind: 'fixed' } }),
        tileErrorMessage: 'Vector tile error',
    }));
    assert.equal(h.mapLayers.contains(vector), true);
    assert.deepEqual(h.controlsView.layerHistograms, []);
    h.destroy();
});

test('three visible rasters render and receive ordinary histograms', async () => {
    const requests = [];
    const pointRequests = [];
    const h = visibleLayerFixture(async (item, area) => {
        requests.push({
            id: item.id.replace(/^geotiff-/, ''),
            area: area.kind,
        });
        return createLayerStatistics(item, selectedBoundsFromArea(area));
    }, {
        samplePixel: async (item) => {
            pointRequests.push(item.id.replace(/^geotiff-/, ''));
            return { inBounds: true, value: 1 };
        },
    });
    const bottom = createRasterItem('bottom');
    const middle = createRasterItem('middle');
    const top = createRasterItem('top');
    await h.viewer.show(bottom);
    await h.viewer.show(middle);
    await h.viewer.show(top);
    await flushPromises();

    assert.equal(h.mapLayers.visibleCount, 3);
    assert.equal(
        h.wmsLayers.filter((layer) => h.leafletMap.layers.has(layer)).length,
        3,
    );
    assert.deepEqual(
        h.controlsView.layerHistograms.map((summary) => summary.label),
        ['top.tif', 'middle.tif', 'bottom.tif'],
    );

    requests.length = 0;
    h.viewer.exploreAt({ lng: -74, lat: 41 });
    await flushPromises();
    assert.deepEqual(
        requests.map(({ id }) => id).sort(),
        ['bottom', 'middle', 'top'],
    );
    assert.deepEqual(pointRequests, [], 'Ordinary histogram clicks do not request unused pixel values');
    h.destroy();
});

test('cursor sampling follows every visible raster regardless of published bounds and pauses for map dragging', async () => {
    const timers = new Map();
    let nextTimerId = 1;
    const clock = {
        setTimeout(callback) {
            const id = nextTimerId;
            nextTimerId += 1;
            timers.set(id, callback);
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        runNext() {
            const entry = timers.entries().next().value;
            assert.ok(entry, 'expected a pending cursor dwell timer');
            const [id, callback] = entry;
            timers.delete(id);
            callback();
        },
    };
    const cursorValuesView = {
        snapshots: [],
        clearCount: 0,
        moves: [],
        enabled: null,
        handlers: null,
        render(snapshot) {
            this.snapshots.push(snapshot);
        },
        clear() {
            this.clearCount += 1;
        },
        move(position) {
            this.moves.push(position);
        },
        setEnabled(enabled) {
            this.enabled = enabled;
        },
        bind(handlers) {
            this.handlers = handlers;
        },
        unbind() {
            this.handlers = null;
        },
    };
    const cursorRequests = [];
    const h = visibleLayerFixture(undefined, {
        clock,
        cursorValuesView,
        publishRaster: async item => ({
            layerName: `eolab:${item.id}`,
            bbox: item.id.endsWith('outside')
                ? [-180, -85.05127083678795, -179.99835325853354, 85.05112877980659]
                : [-180, -90, 180, 90],
        }),
        sampleCursorPixel: async (item, point) => {
            cursorRequests.push({ item, point });
            return { inBounds: true, value: cursorRequests.length };
        },
    });
    const bottom = createRasterItem('cursor-bottom');
    const outside = createRasterItem('cursor-outside');
    const top = createRasterItem('cursor-top');
    await h.viewer.show(bottom);
    await h.viewer.show(outside);
    await h.viewer.show(top);
    await flushPromises();

    h.leafletMap.emit('mousemove', {
        latlng: { lng: -87.44567871093751, lat: 36.798288873837045 },
        originalEvent: { clientX: 600, clientY: 300 },
    });
    assert.deepEqual(cursorValuesView.moves, [{ clientX: 600, clientY: 300 }]);
    assert.equal(cursorRequests.length, 0);
    clock.runNext();
    await flushPromises();
    assert.deepEqual(
        cursorRequests.map(({ item }) => item.id),
        [top.id, outside.id, bottom.id],
    );
    assert.deepEqual(
        cursorValuesView.snapshots.at(-1).samples.map(({ label, state }) => ({
            label,
            state,
        })),
        [
            { label: 'cursor-top', state: 'value' },
            { label: 'cursor-outside', state: 'value' },
            { label: 'cursor-bottom', state: 'value' },
        ],
    );

    const hidden = h.mapLayers.snapshots().find(layer => layer.item.id === bottom.id);
    h.mapLayers.setVisible(hidden.key, false);
    cursorRequests.length = 0;
    clock.runNext();
    await flushPromises();
    assert.deepEqual(cursorRequests.map(({ item }) => item.id), [top.id, outside.id]);

    h.viewer.setPointerInspectionEnabled(false);
    h.leafletMap.emit('mousemove', { latlng: { lng: 1, lat: 1 } });
    assert.equal(timers.size, 0, 'editing mode must not schedule pixel reads');
    assert.equal(cursorValuesView.enabled, true, 'editing preserves the picker preference');
    h.viewer.setPointerInspectionEnabled(true);
    h.leafletMap.emit('mousemove', { latlng: { lng: 1, lat: 1 } });
    assert.equal(timers.size, 1, 'inspection resumes after editing');
    h.viewer.setPointerInspectionEnabled(false);
    assert.equal(timers.size, 0, 'entering editing cancels an outstanding dwell');
    cursorValuesView.handlers.onHide();
    h.viewer.setPointerInspectionEnabled(true);
    assert.equal(cursorValuesView.enabled, false);
    h.leafletMap.emit('mousemove', { latlng: { lng: 1, lat: 1 } });
    assert.equal(timers.size, 0);
    cursorValuesView.handlers.onShow();
    assert.equal(cursorValuesView.enabled, true);
    h.leafletMap.emit('mousemove', { latlng: { lng: 1, lat: 1 } });
    assert.equal(timers.size, 1);
    clock.runNext();
    await flushPromises();

    h.leafletMap.emit('dragstart', {});
    h.leafletMap.emit('mousemove', { latlng: { lng: 1, lat: 1 } });
    assert.equal(timers.size, 0);
    h.leafletMap.emit('dragend', {});
    h.leafletMap.emit('mousemove', { latlng: { lng: 1, lat: 1 } });
    assert.equal(timers.size, 1);

    for (const listener of h.leafletMap.container.listeners.get('mouseleave')) {
        listener(new Event('mouseleave'));
    }
    assert.equal(timers.size, 0);
    assert.ok(cursorValuesView.clearCount > 0);
    h.destroy();
    assert.equal(cursorValuesView.handlers, null);
});

test('cursor sampling and DOM hand off positions atomically and reject stale reads', async () => {
    const timers = new Map();
    let nextTimerId = 1;
    const clock = {
        setTimeout(callback) { const id = nextTimerId++; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
        runNext() {
            const [id, callback] = timers.entries().next().value;
            timers.delete(id);
            callback();
        },
    };
    const documentContext = new FakeRasterControlDocument();
    const cursorValuesView = new RasterCursorValuesView(documentContext);
    const root = documentContext.querySelector('#raster-cursor-values');
    const marker = documentContext.querySelector('#raster-cursor-marker');
    const position = documentContext.querySelector('#raster-cursor-position');
    const list = documentContext.querySelector('#raster-cursor-value-list');
    const requests = [];
    const h = visibleLayerFixture(undefined, {
        clock, cursorValuesView,
        publishRaster: async item => ({
            layerName: `eolab:${item.id}`,
            bbox: [-180, -85.05127083678795, -179.99835325853354, 85.05112877980659],
        }),
        sampleCursorPixel: (_item, point, signal) => {
            const deferred = createDeferred();
            requests.push({ ...deferred, point, signal });
            return deferred.promise;
        },
    });
    await h.viewer.show(createRasterItem('anchored-picker'));
    await flushPromises();
    /**
     * Send one pointer event through the actual viewer-to-sampler boundary.
     * @param {number} x Longitude and screen-coordinate test seed.
     * @return {void}
     */
    function move(x) {
        h.leafletMap.emit('mousemove', {
            latlng: { lng: x, lat: 1 },
            originalEvent: { clientX: 100 + x, clientY: 100 },
        });
    }
    move(1);
    clock.runNext();
    requests[0].resolve({ inBounds: true, value: 11 });
    await flushPromises();
    const oldPosition = position.textContent;
    const oldRows = list.children;
    move(2);
    assert.equal(root.hidden, false);
    assert.equal(marker.style.left, '101px');
    clock.runNext();
    assert.equal(position.textContent, oldPosition);
    assert.equal(list.children, oldRows);
    assert.equal(marker.style.left, '101px');
    move(3);
    assert.equal(requests[1].signal.aborted, true);
    requests[1].resolve({ inBounds: true, value: 99 });
    await flushPromises();
    assert.equal(list.children, oldRows);
    clock.runNext();
    requests[2].resolve({ inBounds: true, value: 33 });
    await flushPromises();
    assert.equal(marker.style.left, '103px');
    assert.equal(root.style.left, '117px');
    assert.equal(position.textContent, 'Lat 1.00000 · Lng 3.00000');
    assert.equal(list.children[0].children[1].textContent, '3.300e+1');

    move(4);
    clock.runNext();
    h.leafletMap.emit('movestart', {});
    assert.equal(requests[3].signal.aborted, true);
    assert.equal(root.hidden, true);
    assert.equal(marker.hidden, true);
    move(5);
    assert.equal(timers.size, 0);
    requests[3].resolve({ inBounds: true, value: 44 });
    await flushPromises();
    assert.equal(marker.hidden, true);
    h.leafletMap.emit('moveend', {});
    move(6);
    clock.runNext();
    requests[4].resolve({ inBounds: true, value: 66 });
    await flushPromises();
    assert.equal(marker.hidden, false);
    h.leafletMap.emit('resize', {});
    assert.equal(root.hidden, true);
    assert.equal(marker.hidden, true);
    move(7);
    clock.runNext();
    requests[5].resolve({ inBounds: false, value: null });
    await flushPromises();
    assert.equal(root.hidden, true);
    assert.equal(marker.hidden, true);
    h.destroy();
    for (const event of ['mousemove', 'movestart', 'moveend', 'resize']) {
        assert.equal(h.leafletMap.handlers.get(event).size, 0);
    }
});

test('2D click requests both axes even when neither published extent contains the point', async () => {
    const requests = [];
    const h = visibleLayerFixture(undefined, {
        publishRaster: async item => ({
            layerName: `eolab:${item.id}`,
            bbox: item.id.endsWith('regional')
                ? [-90, 35, -80, 40]
                : [-180, -85.05127083678795, -179.99835325853354, 85.05112877980659],
        }),
        samplePixel: async item => {
            requests.push(item.id);
            return { inBounds: true, value: 2.55 };
        },
    });
    await h.viewer.show(createRasterItem('regional'));
    await h.viewer.show(createRasterItem('first'));
    await h.viewer.show(createRasterItem('second'));
    h.controlsView.handlers.onBivariateModeChange('bivariate');
    await flushPromises();
    assert.equal(h.viewer.exploreAt({ lng: -87.44567871093751, lat: 36.798288873837045 }), false);
    await flushPromises();
    assert.deepEqual(requests, ['geotiff-second', 'geotiff-first']);
    assert.deepEqual(h.controlsView.pairedHighlight, {xValue: 2.55, yValue: 2.55});
    h.destroy();
});

test('active 2D analysis follows the top raster pair and exposes X Y badges', async () => {
    const pairedRequests = [];
    const pointRequests = [];
    const renderingSelections = [];
    const h = visibleLayerFixture(undefined, {
        publishRaster: async item => ({
            layerName: `eolab:${item.id}`,
            bbox: item.id.endsWith('middle')
                ? [-180, -85.05127083678795, -179.99835325853354, 85.05112877980659]
                : [-180, -90, 180, 90],
        }),
        loadPairedStatistics: async (xItem, yItem) => {
            pairedRequests.push([
                xItem.id.replace(/^geotiff-/, ''),
                yItem.id.replace(/^geotiff-/, ''),
            ]);
            return pairedStatistics();
        },
        samplePixel: async (item) => {
            pointRequests.push(item.id);
            return { inBounds: true, value: item.id.endsWith('top') ? 9 : 4 };
        },
    }, {
        onBivariateRenderingChange: (keys) =>
            renderingSelections.push(keys === null ? null : [...keys]),
    });
    await h.viewer.show(createRasterItem('bottom'));
    await h.viewer.show(createRasterItem('middle'));
    await h.viewer.show(createRasterItem('top'));
    await flushPromises();
    const [top, middle, bottom] = h.mapLayers.snapshots();
    h.mapLayers.setOpacity(middle.key, 0.35);
    h.mapLayers.setOpacity(bottom.key, 0.4);

    h.controlsView.handlers.onBivariateModeChange('bivariate');
    await flushPromises();
    assert.deepEqual(pairedRequests.at(-1), ['top', 'middle']);
    assert.deepEqual(
        new Set(renderingSelections.at(-1)),
        new Set([top.key, middle.key]),
    );
    assert.deepEqual(
        h.mapLayers.snapshots().map((layer) => layer.roleBadge?.label ?? null),
        ['X', 'Y', null],
    );
    assert.deepEqual(
        h.mapLayers.snapshots().map((layer) => layer.opacityLocked),
        [true, true, false],
    );
    assert.deepEqual(h.mapLayers.snapshots().map(layer => layer.legend.label), [
        'X color contribution; combines with the other raster on the map.',
        'Y color contribution; combines with the other raster on the map.',
        'Raster values',
    ]);
    assert.equal(h.mapLayers.getLeafletLayer(bottom.key).opacity, 0.4);
    h.viewer.exploreAt({ lng: -74, lat: 41 });
    await flushPromises();

    h.controlsView.handlers.onBivariateSwapAxes();
    await flushPromises();
    assert.deepEqual(
        h.mapLayers.snapshots().map((layer) => layer.roleBadge?.label ?? null),
        ['Y', 'X', null],
    );
    assert.deepEqual(pairedRequests.at(-1), ['middle', 'top']);
    assert.equal(pointRequests.length, 2);
    assert.deepEqual(h.controlsView.pairedHighlight, {xValue: 4, yValue: 9});

    h.mapLayers.reorder(bottom.key, 1);
    await flushPromises();
    assert.equal(h.controlsView.bivariateMode.active, true);
    assert.deepEqual(
        h.mapLayers.snapshots().map((layer) => [
            layer.item.id.replace(/^geotiff-/, ''),
            layer.roleBadge?.label ?? null,
        ]),
        [['top', 'Y'], ['bottom', 'X'], ['middle', null]],
    );
    assert.deepEqual(pairedRequests.at(-1), ['bottom', 'top']);
    assert.deepEqual(
        new Set(renderingSelections.at(-1)),
        new Set([top.key, bottom.key]),
    );
    assert.equal(h.mapLayers.getLeafletLayer(middle.key).opacity, 0.35);
    assert.equal(
        h.mapLayers.getLeafletLayer(middle.key).container.style.mixBlendMode,
        'normal',
    );

    h.mapLayers.setVisible(top.key, false);
    await flushPromises();
    assert.equal(h.controlsView.bivariateMode.active, true);
    assert.deepEqual(
        h.mapLayers.snapshots().map((layer) => [
            layer.item.id.replace(/^geotiff-/, ''),
            layer.roleBadge?.label ?? null,
        ]),
        [['top', null], ['bottom', 'Y'], ['middle', 'X']],
    );
    assert.deepEqual(pairedRequests.at(-1), ['middle', 'bottom']);
    assert.deepEqual(
        new Set(renderingSelections.at(-1)),
        new Set([middle.key, bottom.key]),
    );

    h.mapLayers.setVisible(middle.key, false);
    assert.equal(h.controlsView.bivariateMode.active, false);
    assert.equal(renderingSelections.at(-1), null);
    assert.ok(h.mapLayers.snapshots().every((layer) => layer.roleBadge === null));
    assert.equal(h.mapLayers.getLeafletLayer(bottom.key).opacity, 0.4);
    h.destroy();
});

test('visible policy keeps 2D explicit and restores ordinary opacity when a pair is hidden', async () => {
    const h = visibleLayerFixture();
    await h.viewer.show(createRasterItem('x'));
    await h.viewer.show(createRasterItem('y'));
    await flushPromises();
    const [top, bottom] = h.mapLayers.snapshots();
    h.mapLayers.setOpacity(bottom.key, 0.35);
    assert.equal(h.controlsView.bivariateMode.active, false);
    h.controlsView.handlers.onBivariateModeChange('bivariate');
    await flushPromises();
    assert.equal(h.controlsView.bivariateMode.active, true);
    assert.ok(h.mapLayers.snapshots().every(layer => layer.opacityLocked));
    h.viewer.openStyle(bottom.key);
    assert.equal(h.controlsView.appearanceEnabled, false);
    h.mapLayers.setVisible(top.key, false);
    assert.equal(h.controlsView.bivariateMode.active, false);
    assert.equal(h.mapLayers.getLeafletLayer(bottom.key).opacity, 0.35);
    assert.equal(h.controlsView.appearanceEnabled, true);
    h.destroy();
});

test('color opacity stays per-layer, survives 2D, and resets with the style', async () => {
    const h = visibleLayerFixture();
    await h.viewer.show(createRasterItem('bottom'));
    await h.viewer.show(createRasterItem('top'));
    await flushPromises();
    const [top, bottom] = h.mapLayers.snapshots();
    h.viewer.openStyle(bottom.key);
    h.controlsView.style = { ...h.controlsView.style,
        minimumOpacity: 0, midpointOpacity: 0.25, maximumOpacity: 0.8 };
    h.controlsView.handlers.onStyleInput(false);
    h.viewer.closeStyle(); // A pending opacity edit must be committed on close.
    const ordinary = { ...h.mapLayers.getRecord(bottom.key).state.rasterStyle };
    assert.equal(ordinary.midpointOpacity, 0.25);
    assert.equal(h.mapLayers.getRecord(top.key).state.rasterStyle.midpointOpacity, 1);
    h.viewer.openStyle(top.key);
    assert.equal(h.controlsView.style.minimumOpacity, 1);
    h.viewer.openStyle(bottom.key);
    assert.equal(h.controlsView.style.minimumOpacity, 0);
    h.controlsView.handlers.onBivariateModeChange('bivariate');
    await flushPromises();
    assert.match(h.mapLayers.getLeafletLayer(bottom.key).parameters.env, /;amin:1;amed:1;amax:1$/);
    h.controlsView.handlers.onBivariateModeChange('overlay');
    assert.deepEqual(h.mapLayers.getRecord(bottom.key).state.rasterStyle, ordinary);
    assert.match(h.mapLayers.getLeafletLayer(bottom.key).parameters.env, /;amin:0;amed:0.25;amax:0.8$/);
    h.controlsView.handlers.onResetStyle();
    assert.equal(h.mapLayers.getRecord(bottom.key).state.rasterStyle.minimumOpacity, 1);
    assert.equal(h.mapLayers.getRecord(bottom.key).state.rasterStyle.midpointOpacity, 1);
    assert.equal(h.mapLayers.getRecord(bottom.key).state.rasterStyle.maximumOpacity, 1);
    h.destroy();
});

test('accepting a vector area without a raster keeps its editor available without calculating', () => {
    const requests = [];
    const h = visibleLayerFixture((...args) => { requests.push(args); return RASTER_STATISTICS; });
    const document = new FakeRasterControlDocument();
    const sampling = new RasterSamplingAreaControlsView(document);
    sampling.bind(h.controlsView.handlers);
    h.controlsView.setSamplingAreaMode = (mode, label) => sampling.setSamplingAreaMode(mode, label);
    sampling.setActiveRasterAvailable(false);
    sampling.vectorChoice.checked = true;
    document.querySelector('#raster-sampling-area-controls').dispatchEvent(new Event('change'));
    sampling.openAreaEditor();

    h.viewer.setVectorSelection({ selection: CATALOG_SELECTION, label: 'Countries' });

    assert.equal(sampling.vectorChoice.checked, true);
    assert.equal(sampling.vectorControls.hidden, false, 'accepted status and Clear selection stay accessible');
    assert.equal(sampling.useMapWindowButton.disabled, true);
    assert.equal(sampling.clearSampleWindowButton.disabled, true);
    assert.equal(h.viewer.getSelectedArea(), null, 'editor visibility does not authorize a histogram');
    assert.deepEqual(requests, []);
    sampling.disclosure.open = false;
    sampling.disclosure.dispatchEvent(new Event('toggle'));
    assert.equal(sampling.samplingAreaSummary.textContent, 'Sample area · Polygon layer');
    sampling.unbind();
    h.destroy();
});

test('a vector AOI drives both histogram modes and invalidation cannot fall back to the whole raster', async () => {
    const areas = [], pairedAreas = [];
    const h = visibleLayerFixture(async (_item, area) => {
        areas.push(area); return area.kind === 'catalogSelection' ? CATALOG_SELECTION_RASTER_STATISTICS : RASTER_STATISTICS;
    }, { loadPairedStatistics: async (_x, _y, area) => { pairedAreas.push(area); return pairedStatistics(); } });
    await h.viewer.show(createRasterItem('bottom'));
    await h.viewer.show(createRasterItem('top'));
    await flushPromises();
    const aoi = { selection: CATALOG_SELECTION, label: 'Countries · 1 of 200 features' };
    h.viewer.setVectorSelection(aoi); await flushPromises();
    assert.deepEqual(h.viewer.getSelectedArea().catalogSelection, aoi.selection);
    assert.deepEqual(areas.at(-1).catalogSelection, aoi.selection);
    await h.viewer.show(createRasterItem('added-after-selection')); await flushPromises();
    assert.deepEqual(h.viewer.getSelectedArea().catalogSelection, aoi.selection);
    assert.deepEqual(areas.at(-1).catalogSelection, aoi.selection);
    for (const record of h.mapLayers.retainedRecords) {
        assert.deepEqual(h.viewer.getSelectedArea(record.entry.key, "1d").catalogSelection, aoi.selection);
    }
    h.controlsView.handlers.onBivariateModeChange('bivariate');await flushPromises();
    assert.deepEqual(pairedAreas.at(-1).catalogSelection, aoi.selection);
    assert.deepEqual(h.viewer.getSelectedArea().catalogSelection, aoi.selection);
    h.viewer.exploreAt({lng:-74,lat:41}); await flushPromises();
    assert.deepEqual(h.viewer.getSelectedArea().catalogSelection, aoi.selection);
    const count=areas.length+pairedAreas.length;
    h.viewer.setVectorSelection(null);await flushPromises();
    assert.equal(h.viewer.getSelectedArea(),null);
    assert.equal(h.controlsView.samplingAreaMode,"vector");
    assert.equal(h.controlsView.sampleWindowStatus,"");
    assert.deepEqual(h.controlsView.layerHistograms,[]);
    assert.equal(areas.length+pairedAreas.length,count);
    h.controlsView.handlers.onClearSampleWindow(); await flushPromises();
    assert.equal(h.controlsView.samplingAreaMode,"wholeRaster");
    h.destroy();
});

test('a late histogram cannot overwrite another layer editor or an edited range', async () => {
    const pending = createDeferred();
    const h = visibleLayerFixture(item => item.id.endsWith('later')
        ? pending.promise : Promise.resolve(createLayerStatistics(item)));
    const first = createRasterItem('first'), later = createRasterItem('later');
    await h.viewer.show(first);
    await flushPromises();
    const firstKey = h.mapLayers.snapshots()[0].key;
    await h.viewer.show(later);
    h.viewer.openStyle(firstKey);
    h.controlsView.style = { ...h.controlsView.style, minimum: -2, midpoint: 4, maximum: 25 };
    h.controlsView.handlers.onStyleInput(false);
    pending.resolve(createLayerStatistics(later));
    await flushPromises();
    assert.equal(h.controlsView.style.minimum, -2);
    h.mapLayers.removeKey(firstKey);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.notEqual(h.mapLayers.snapshots()[0].legend.labels[0], -2);
    h.destroy();
});

test('automatic histograms exclude rasters below the top-16 cap', async () => {
    const requests = [];
    const h = visibleLayerFixture(async item => {
        requests.push(item.id);
        return createLayerStatistics(item);
    });
    const items = Array.from({ length: 17 }, (_, index) => createRasterItem(`sample-${index}`));
    for (const item of items) await h.viewer.show(item);
    await flushPromises();
    requests.length = 0;
    h.viewer.exploreAt({ lng: -74, lat: 41 });
    await flushPromises();
    assert.equal(requests.length, 16);
    assert.equal(requests.includes(items[0].id), false);
    const first = h.mapLayers.snapshots().at(-1);
    h.mapLayers.reorder(first.key, 0);
    await flushPromises();
    assert.deepEqual(
        h.controlsView.layerHistograms.map(s => s.label),
        ['sample-0.tif', ...Array.from({ length: 15 }, (_, index) => `sample-${16 - index}.tif`)],
    );
    h.destroy();
});

test("selecting 2D opens paired analysis without a map interaction", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const pairedRequests = [];
    const pixelRequests = [];
    let histogramPresentationRequests = 0;
    const firstItem = createRasterItem("first");
    const secondItem = createRasterItem("second");
    const mapLayerController = new MapLayerController({ leafletMap, view: layerStackView });
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
            onHistogramRequested() {
                histogramPresentationRequests += 1;
            },
        },
        {
            controlsView,
            layerStackView,
            mapLayerController,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async () => RASTER_STATISTICS,
            loadPairedStatistics: async (xItem, yItem, area) => {
                pairedRequests.push({ xItem, yItem, area });
                return pairedStatistics();
            },
            samplePixel: async (item, point) => {
                pixelRequests.push({ item, point });
                return {
                    inBounds: true,
                    value: item === secondItem ? 9 : 4,
                };
            },
            viewport: { innerWidth: 1280, innerHeight: 720 },
        },
    );

    viewer.activateAnalysis(firstItem);
    await flushPromises();
    await viewer.show(firstItem);
    await flushPromises();
    viewer.activateAnalysis(secondItem);
    await flushPromises();
    await viewer.show(secondItem);
    await flushPromises();
    assert.equal(controlsView.bivariateAvailability.canEnter, true);
    const [top, bottom] = layerStackView.layers;
    mapLayerController.setOpacity(bottom.key, 0.4);
    controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();

    assert.deepEqual(
        pairedRequests.map(({ xItem, yItem, area }) => ({
            x: xItem.id,
            y: yItem.id,
            area: area.kind,
        })),
        [{ x: secondItem.id, y: firstItem.id, area: "wholeOverlap" }],
    );
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(histogramPresentationRequests, 1);
    assert.equal(pixelRequests.length, 0);
    assert.match(
        controlsView.bivariateAvailability.guidance,
        /2D analyzes the X\/Y-badged rasters.*blending at 100% opacity/
    );
    assert.equal(controlsView.appearanceEnabled, false);
    assert.equal(controlsView.univariateHistogramVisible, false);
    assert.ok(layerStackView.layers.every((layer) => layer.opacityLocked));
    assert.ok(layerStackView.layers.every(
        (layer) => layer.effectiveOpacity === 1,
    ));
    assert.equal(wmsLayers[0].opacity, 1);
    assert.equal(wmsLayers[1].opacity, 1);
    assert.equal(wmsLayers[0].container.style.mixBlendMode, "normal");
    assert.equal(wmsLayers[1].container.style.mixBlendMode, "plus-lighter");
    assert.deepEqual(
        [
            controlsView.bivariateMode.xStyle.minimum,
            controlsView.bivariateMode.xStyle.midpoint,
            controlsView.bivariateMode.xStyle.maximum,
        ],
        [-4, 3, 20],
    );
    assert.deepEqual(
        [
            controlsView.bivariateMode.yStyle.minimum,
            controlsView.bivariateMode.yStyle.midpoint,
            controlsView.bivariateMode.yStyle.maximum,
        ],
        [-4, 3, 20],
    );

    controlsView.handlers.onBivariatePaletteChange("steelRose");
    assert.equal(controlsView.bivariateMode.paletteName, "steelRose");
    assert.match(wmsLayers[0].parameters.env, /cmin:#111827/);
    assert.match(wmsLayers[1].parameters.env, /cmin:#111827/);

    const renderingUpdatesBeforeMapSample = wmsLayers.map(
        (layer) => layer.parameterUpdates.length
    );
    viewer.exploreAt({ lng: -122, lat: 49 });
    await flushPromises();
    assert.deepEqual(
        wmsLayers.map((layer) => layer.parameterUpdates.length),
        renderingUpdatesBeforeMapSample,
        "a new 2D histogram sample must not refresh unchanged WMS layers"
    );
    assert.deepEqual(
        pixelRequests.map(({ item, point }) => ({ id: item.id, point })),
        [
            { id: secondItem.id, point: { longitude: -122, latitude: 49 } },
            { id: firstItem.id, point: { longitude: -122, latitude: 49 } },
        ]
    );
    assert.deepEqual(controlsView.pairedHighlight, { xValue: 9, yValue: 4 });

    wmsLayers[0].eventHandlers.get("tileerror")();
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(controlsView.bivariateAvailability.canEnter, true);

    layerStackView.handlers.onVisibility(top.key, false);
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(controlsView.bivariateAvailability.canEnter, true);
    assert.equal(controlsView.appearanceEnabled, false);
    assert.equal(controlsView.univariateHistogramVisible, false);
    assert.equal(wmsLayers[0].opacity, 1);
    assert.equal(wmsLayers[0].container.style.mixBlendMode, "normal");
    assert.equal(wmsLayers[1].container, null);

    controlsView.handlers.onBivariateModeChange("overlay");
    assert.equal(controlsView.bivariateMode.active, false);
    controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();
    assert.equal(wmsLayers[0].container.style.mixBlendMode, "normal");
    assert.equal(wmsLayers[1].container, null);

    layerStackView.handlers.onVisibility(top.key, true);
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(wmsLayers[1].container.style.mixBlendMode, "plus-lighter");
    layerStackView.handlers.onRemove(bottom.key);
    assert.equal(controlsView.bivariateMode.active, true);
    assert.equal(controlsView.bivariateAvailability.canEnter, true);
    assert.equal(wmsLayers[1].container.style.mixBlendMode, "normal");
    assert.equal(viewer.contains(firstItem), false);
    assert.equal(viewer.contains(secondItem), true);
    controlsView.handlers.onBivariateModeChange("overlay");
    assert.equal(controlsView.bivariateMode.active, false);
    viewer.destroy();
    mapLayerController.destroy();
});

test("2D percentiles restyle current axes without changing ordinary styles or reading again", async () => {
    let pairedReads = 0;
    const h = visibleLayerFixture(undefined, {
        loadPairedStatistics: async () => { pairedReads++; return pairedStatistics(); },
    });
    await h.viewer.show(createRasterItem("first"));
    await h.viewer.show(createRasterItem("second"));
    await flushPromises();
    const originals = h.mapLayers.retainedRecords.map(record => structuredClone(record.state.rasterStyle));
    h.controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();
    const xKey = h.layerStackView.layers.find(layer => layer.roleBadge?.label === "X").key;
    const xLayer = h.mapLayers.getLeafletLayer(xKey);
    const initialY = h.controlsView.bivariateMode.yStyle;
    h.controlsView.bivariatePercentiles = { x: { lower: 10, middle: 25, upper: 90 } };
    h.controlsView.handlers.onBivariatePercentileInput("x");
    assert.equal(h.controlsView.bivariateRanges.x.applicable, true);
    const before = xLayer.parameterUpdates.length;
    h.controlsView.handlers.onApplyBivariatePercentiles("x");
    assert.equal(xLayer.parameterUpdates.length, before + 1);
    assert.match(xLayer.parameters.env, /min:3\.2;med:8;max:28\.8/);
    assert.deepEqual(h.controlsView.bivariateMode.yStyle, initialY);
    assert.deepEqual(h.controlsView.pairedPresentation.xStyle, h.controlsView.bivariateMode.xStyle);
    assert.deepEqual(h.layerStackView.layers.find(layer => layer.key === xKey).legend.labels, [3.2, 8, 28.8]);
    assert.equal(pairedReads, 1);
    assert.deepEqual(h.mapLayers.retainedRecords.map(record => record.state.rasterStyle), originals);

    h.controlsView.handlers.onBivariateSwapAxes();
    await flushPromises();
    assert.equal(h.controlsView.bivariateMode.yStyle.midpoint, 8);
    assert.equal(h.layerStackView.layers.find(layer => layer.key === xKey).roleBadge.label, "Y");
    h.controlsView.handlers.onBivariatePaletteChange("steelRose");
    assert.equal(h.controlsView.bivariateMode.yStyle.midpoint, 8);
    h.controlsView.handlers.onBivariateModeChange("overlay");
    await flushPromises();
    assert.deepEqual(h.mapLayers.retainedRecords.map(record => record.state.rasterStyle), originals);
    assert.match(xLayer.parameters.env, /min:-4;med:3;max:20/);
    h.controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();
    assert.equal(h.controlsView.bivariateMode.xStyle.midpoint, 3);
    h.destroy();
});

test("2D histogram DOM controls preview and apply each axis without resampling", async () => {
    const documentContext = new FakeRasterControlDocument();
    const pairedView = new BivariateRasterControlsView(documentContext);
    const controlsView = createFakeControlsView();
    for (const [adapter, method] of Object.entries({
        readBivariatePercentiles: "readPercentiles",
        renderBivariatePercentiles: "renderPercentiles",
        renderBivariateMode: "renderMode",
        openBivariateStyle: "openStyle",
        renderPairedStatistics: "renderStatistics",
        setPairedStatisticsLoading: "setStatisticsLoading",
        renderPairedStatisticsError: "renderStatisticsError",
        clearPairedStatistics: "clearStatistics",
    })) controlsView[adapter] = pairedView[method].bind(pairedView);
    for (const axis of ["x", "y"]) {
        for (const [name, value] of Object.entries({ lower: 5, middle: 50, upper: 95 })) {
            pairedView.rangeControls[axis].inputs[name].value = String(value);
        }
    }
    let pairedReads = 0;
    let histogramOpens = 0;
    const h = visibleLayerFixture(undefined, {
        controlsView,
        loadPairedStatistics: async () => { pairedReads++; return pairedStatistics(); },
    }, {
        onHistogramRequested: () => { histogramOpens++; },
    });
    pairedView.bind(controlsView.handlers);
    await h.viewer.show(createRasterItem("first"));
    await h.viewer.show(createRasterItem("second"));
    await flushPromises();
    const originals = h.mapLayers.retainedRecords.map(record => structuredClone(record.state.rasterStyle));
    const styleKey = h.mapLayers.retainedRecords[0].entry.key;
    assert.equal(h.viewer.openPairedStyle(styleKey), false);
    pairedView.mode.value = "bivariate";
    pairedView.mode.dispatchEvent(new Event("change"));
    await flushPromises();
    documentContext.querySelectorAll = () => [];
    let ordinaryStyleOpens = 0;
    const editor = new MapLayerStyleEditor({
        documentContext, mapLayers: h.mapLayers, rasterViewer: h.viewer,
        inspection: { showStyle() { ordinaryStyleOpens++; }, hideStyle() {}, updateLayerEditorName() {} },
    });
    const beforeNavigation = histogramOpens;
    editor.open(styleKey);
    assert.equal(editor.key, null);
    assert.equal(ordinaryStyleOpens, 0);
    assert.equal(histogramOpens, beforeNavigation + 1);
    assert.equal(pairedView.styleRanges.open, true);
    assert.equal(documentContext.activeElement, pairedView.palette);
    assert.equal(h.viewer.openPairedStyle("missing"), false);
    const initialY = { ...pairedView.labels.yStyle };
    pairedView.rangeControls.x.inputs.middle.value = "25";
    pairedView.rangeControls.x.inputs.middle.dispatchEvent(new Event("input"));
    const xMarkers = pairedView.thresholdMarkers.children[0];
    assert.equal(xMarkers.getAttribute("data-threshold-mode"), "preview");
    assert.equal(xMarkers.children.find(child => child.getAttribute("data-threshold") === "midpoint")
        .getAttribute("data-value"), "8");
    assert.notEqual(pairedView.labels.xStyle.midpoint, 8);
    pairedView.rangeControls.x.apply.dispatchEvent(new Event("click"));
    assert.equal(pairedView.labels.xStyle.midpoint, 8);
    assert.deepEqual(pairedView.labels.yStyle, initialY);
    pairedView.rangeControls.y.inputs.middle.value = "75";
    pairedView.rangeControls.y.inputs.middle.dispatchEvent(new Event("input"));
    pairedView.rangeControls.y.apply.dispatchEvent(new Event("click"));
    assert.equal(pairedView.labels.yStyle.midpoint, 124);
    assert.equal(pairedView.labels.xStyle.midpoint, 8);
    assert.equal(pairedReads, 1);
    assert.deepEqual(h.mapLayers.retainedRecords.map(record => record.state.rasterStyle), originals);
    pairedView.palette.value = "steelRose";
    pairedView.palette.dispatchEvent(new Event("change"));
    assert.equal(pairedView.labels.paletteName, "steelRose");
    assert.equal(pairedView.labels.xStyle.midpoint, 8);
    assert.equal(pairedView.labels.yStyle.midpoint, 124);
    assert.equal(pairedReads, 1);
    pairedView.styleRanges.open = false;
    pairedView.styleRanges.dispatchEvent(new Event("toggle"));
    assert.equal(pairedView.thresholdMarkers.children[0].getAttribute("data-threshold-mode"), "committed");
    pairedView.swapButton.dispatchEvent(new Event("click"));
    await flushPromises();
    assert.equal(pairedView.labels.xStyle.midpoint, 124);
    assert.equal(pairedView.labels.yStyle.midpoint, 8);
    assert.equal(pairedView.rangeControls.x.label.textContent, pairedView.labels.xLabel);
    pairedView.mode.value = "overlay";
    pairedView.mode.dispatchEvent(new Event("change"));
    assert.equal(h.viewer.openPairedStyle(styleKey), false);
    editor.destroy();
    pairedView.unbind();
    h.destroy();
});

test("2D range application rejects stale samples, failed reads, invalid drafts, and constant data", async () => {
    const reads = [];
    const h = visibleLayerFixture(undefined, { loadPairedStatistics: () => {
        const read = createDeferred(); reads.push(read); return read.promise;
    } });
    await h.viewer.show(createRasterItem("first"));
    await h.viewer.show(createRasterItem("second"));
    await flushPromises();
    h.controlsView.handlers.onBivariateModeChange("bivariate");
    await flushPromises();
    const layers = h.wmsLayers;
    const updates = () => layers.map(layer => layer.parameterUpdates.length);
    let before = updates();
    h.controlsView.handlers.onApplyBivariatePercentiles("x");
    assert.equal(h.controlsView.bivariateRanges.x.applicable, false);
    assert.deepEqual(updates(), before);
    reads[0].resolve(pairedStatistics());
    await flushPromises();
    h.controlsView.bivariatePercentiles = { x: { lower: 50, middle: 50, upper: 95 } };
    before = updates();
    h.controlsView.handlers.onApplyBivariatePercentiles("x");
    assert.equal(h.controlsView.bivariateRanges.x.invalid, true);
    assert.deepEqual(updates(), before);
    h.controlsView.bivariatePercentiles = null;
    h.viewer.exploreAt({ lng: 1, lat: 1 });
    await flushPromises();
    assert.equal(h.controlsView.bivariateRanges.x.applicable, false);
    h.controlsView.handlers.onApplyBivariatePercentiles("x");
    assert.deepEqual(updates(), before);
    reads[1].reject(new Error("Sample failed"));
    await flushPromises();
    assert.equal(h.controlsView.bivariateRanges.x.applicable, false);
    h.viewer.exploreAt({ lng: 2, lat: 2 });
    await flushPromises();
    reads[2].resolve({ ...pairedStatistics(), scope: "selectedArea", xMinimum: 4, xMaximum: 4 });
    await flushPromises();
    h.controlsView.handlers.onApplyBivariatePercentiles("x");
    assert.equal(h.controlsView.bivariateRanges.x.applicable, false);
    assert.match(h.controlsView.bivariateRanges.x.message, /same value/);
    assert.equal(h.controlsView.bivariateRanges.y.applicable, true);
    assert.match(h.controlsView.bivariateRanges.y.message, /sample area/);
    assert.deepEqual(updates(), before);
    h.destroy();
});

test("raster viewer owns the displayed layer lifecycle and detaches cleanly", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async () => ({
                layerName: "eolab:test-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: () => new Promise(() => {}),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
        }
    );

    assert.equal(leafletMap.container.listenerCount("pointermove"), 0);
    assert.equal(leafletMap.handlers.get("mousemove").size, 1);
    const published = await viewer.show(MOUNTED_GEOTIFF_ITEM);
    assert.equal(published.layerName, "eolab:test-raster");
    assert.equal(viewer.isDisplayed, true);
    assert.equal(controlsView.controlsVisible, true);
    assert.equal(wmsLayers.length, 1);
    assert.equal(leafletMap.layers.has(wmsLayers[0]), true);

    layerStackView.setStatus("Previous layer message");
    viewer.clear();
    assert.equal(viewer.isDisplayed, false);
    assert.equal(controlsView.controlsVisible, false);
    assert.equal(layerStackView.status, "");
    assert.equal(leafletMap.layers.has(wmsLayers[0]), false);
    assert.equal(leafletMap.handlers.get("mousemove").size, 1);

    viewer.destroy();
    assert.equal(controlsView.handlers, null);
    assert.equal(leafletMap.container.listenerCount("pointermove"), 0);
    assert.equal(leafletMap.handlers.get("mousemove").size, 0);
});

test("renderer-independent analysis supports exact windows without publication", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const statisticsRequests = [];
    const pixelRequests = [];
    let publicationCalls = 0;
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => {
                publicationCalls += 1;
                throw new Error("analysis must not publish a raster");
            },
            loadStatistics: async (item, samplingArea, signal) => {
                statisticsRequests.push({ item, samplingArea, signal });
                return samplingArea.kind === "wholeRaster"
                    ? EXACT_RASTER_STATISTICS
                    : {
                        ...EXACT_RASTER_STATISTICS,
                        scope: "selectedArea",
                        selectedBounds: samplingArea.selectedBounds,
                    };
            },
            samplePixel: async (item, point) => {
                pixelRequests.push({ item, point });
                return { inBounds: true, value: 17 };
            },
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    viewer.activateAnalysis(MOUNTED_GEOTIFF_ITEM);
    await flushPromises();

    assert.equal(viewer.isDisplayed, false);
    assert.equal(publicationCalls, 0);
    assert.equal(wmsLayers.length, 0);
    assert.equal(controlsView.controlsVisible, true);
    assert.equal(controlsView.renderingControlsAvailable, false);
    assert.equal(controlsView.activeLayer.label, "annual temperature.tif");
    assert.deepEqual(
        statisticsRequests.map(({ samplingArea }) => samplingArea.kind),
        ["wholeRaster"]
    );
    assert.match(controlsView.statisticsStatus, /Whole-raster exact/);
    assert.equal(controlsView.displayedStatistics.estimated, false);

    leafletMap.emit("mousemove", { latlng: { lng: -122, lat: 48.5 } });
    assert.deepEqual(pixelRequests, []);
    viewer.exploreAt({ lng: -122, lat: 48.5 });
    await flushPromises();
    assert.deepEqual(pixelRequests, []);
    assert.equal(controlsView.histogramWidgetOpenCount, 1);
    assert.equal(statisticsRequests.at(-1).samplingArea.kind, "selectedArea");
    assert.match(controlsView.statisticsStatus, /Selected-area exact/);

    controlsView.setPaletteName("viridis");
    controlsView.handlers.onPaletteChange();
    assert.equal(controlsView.legendStyle.minimumColor, "#440154");
    assert.equal(controlsView.appearanceStatus, "Applied the Viridis palette.");
    const context = controlsView.histogramPercentileContext;
    assert.equal(context.canRescale, false);
    controlsView.handlers.onHistogramPercentiles(context.key, {lower: 10, middle: 40, upper: 90, rescale: false});
    assert.equal(controlsView.histogramPercentileContext.settings.middle, 40);
    assert.equal(publicationCalls, 0);
    controlsView.handlers.onResetStyle();
    assert.match(controlsView.statisticsStatus, /exact bounded histogram/);
    assert.equal(
        controlsView.appearanceStatus,
        "Restored the initial colors and range."
    );

    viewer.deactivateAnalysis(MOUNTED_GEOTIFF_ITEM);
    assert.equal(controlsView.controlsVisible, false);
    viewer.destroy();
});

test("WMS activation adopts the existing renderer-neutral analysis session", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    let statisticsRequests = 0;
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => ({
                layerName: "eolab:test-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async () => {
                statisticsRequests += 1;
                return RASTER_STATISTICS;
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    viewer.activateAnalysis(MOUNTED_GEOTIFF_ITEM);
    await flushPromises();
    assert.equal(statisticsRequests, 1);
    assert.equal(controlsView.activeLayer.label, "annual temperature.tif");

    await viewer.show(MOUNTED_GEOTIFF_ITEM);

    assert.equal(statisticsRequests, 1);
    assert.equal(wmsLayers.length, 1);
    assert.equal(viewer.isDisplayed, true);
    assert.equal(controlsView.renderingControlsAvailable, true);
    assert.equal(controlsView.displayedStatistics, RASTER_STATISTICS);
    viewer.exploreAt({lng: 0, lat: 0});
    const selectedArea = viewer.getSelectedArea();
    await viewer.show(MOUNTED_GEOTIFF_ITEM);
    assert.deepEqual(viewer.getSelectedArea(), selectedArea, "Re-selecting the retained source keeps the area chosen after handoff");
    viewer.destroy();
});

test("independently staged views copy detached sampling state without sharing mutable analysis", async () => {
    const {leaflet} = createFakeLeaflet();
    const viewer = initializeRasterViewer({leafletMap: createFakeMap(), leaflet,
        wmsUrl: "/wms", onTileError() {}}, {
        controlsView: createFakeControlsView(), layerStackView: createFakeLayerStackView(),
        publishRaster: async () => ({layerName: "eolab:test", bbox: [-180, -90, 180, 90]}),
        loadStatistics: async () => RASTER_STATISTICS,
        samplePixel: async () => ({inBounds: true, value: 1}),
    });
    try {
        viewer.activateAnalysis(MOUNTED_GEOTIFF_ITEM);
        viewer.exploreAt({lng: 0, lat: 0});
        await flushPromises();
        const first = await viewer.stage(MOUNTED_GEOTIFF_ITEM, {key: "local:view:first", visible: true, opacity: 1});
        const second = await viewer.stage(MOUNTED_GEOTIFF_ITEM, {key: "local:view:second", visible: true, opacity: 1});
        assert.notEqual(first.record.state.analysis, second.record.state.analysis);
        assert.deepEqual(first.record.state.analysis.selectedRasterBounds, second.record.state.analysis.selectedRasterBounds);
        const selectedBounds = first.record.state.analysis.selectedRasterBounds;
        viewer.exploreAt({lng: 10, lat: 10});
        assert.equal(first.record.state.analysis.selectedRasterBounds, selectedBounds);
        assert.equal(second.record.state.analysis.selectedRasterBounds, selectedBounds);
    } finally {viewer.destroy();}
});

test("WMS handoff keeps the selected area and rejects an obsolete detached result", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const reads = [];
    const item = createRasterItem("pending-analysis-handoff");
    const viewer = initializeRasterViewer({
        wmsUrl: "/geoserver/eolab/wms", leafletMap, leaflet, onTileError() {},
    }, {
        controlsView, layerStackView: createFakeLayerStackView(),
        publishRaster: async () => ({ layerName: "eolab:handoff", bbox: [-180, -90, 180, 90] }),
        loadStatistics: (source, area, signal) => {
            if (area.kind === "wholeRaster") return Promise.resolve(createLayerStatistics(source));
            const pending = createDeferred();
            reads.push({ source, area, signal, pending });
            return pending.promise;
        },
        samplePixel: async () => ({ inBounds: true, value: 1 }),
    });
    try {
        viewer.activateAnalysis(item);
        await flushPromises();
        viewer.exploreAt({ lng: -74, lat: 41 });
        const area = viewer.getSelectedArea();
        const detachedRead = reads.at(-1);
        controlsView.setPaletteName("viridis");
        controlsView.handlers.onPaletteChange();

        await viewer.show(item);
        const retainedRead = reads.at(-1);
        assert.notEqual(retainedRead, detachedRead);
        assert.equal(detachedRead.signal.aborted, true);
        assert.equal(retainedRead.signal.aborted, false);
        assert.deepEqual(retainedRead.area, detachedRead.area);
        assert.deepEqual(viewer.getSelectedArea(), area);
        assert.equal(controlsView.paletteName, "viridis");
        assert.equal(wmsLayers.length, 1);
        assert.equal(controlsView.renderingControlsAvailable, true);

        const obsolete = { ...createLayerStatistics(item, area.selectedBounds), sampleMinimum: -999 };
        detachedRead.pending.resolve(obsolete);
        await flushPromises();
        assert.equal(controlsView.renderedStatistics.includes(obsolete), false);
        assert.equal(controlsView.histogramPercentileContext.canRescale, false);

        const current = createLayerStatistics(item, area.selectedBounds);
        retainedRead.pending.resolve(current);
        await flushPromises();
        assert.equal(controlsView.displayedStatistics, current);
        assert.equal(controlsView.statisticsRetryVisible, false);
        assert.equal(controlsView.paletteName, "viridis");
    } finally {
        viewer.destroy();
    }
});

test("a pending WMS publication cannot steal newer Catalog analysis", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const publication = createDeferred();
    const publishing = createRasterItem("pending-publication");
    const selected = createRasterItem("newer-analysis");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: () => publication.promise,
            loadStatistics: async (item, samplingArea) =>
                createLayerStatistics(
                    item,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    viewer.activateAnalysis(publishing);
    await flushPromises();
    const pendingShow = viewer.show(publishing);
    viewer.activateAnalysis(selected);
    await flushPromises();
    publication.resolve({
        layerName: `eolab:${publishing.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await pendingShow;
    await flushPromises();

    assert.equal(viewer.contains(publishing), true);
    assert.equal(layerStackView.activeKey, null);
    assert.match(controlsView.activeLayer.label, /newer-analysis/);
    assert.equal(controlsView.activeLayer.label, "newer-analysis.tif");
    assert.equal(controlsView.displayedStatistics.itemId, selected.id);
    viewer.destroy();
});

test("reaffirming Catalog analysis invalidates a pending WMS activation", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const publication = createDeferred();
    const item = createRasterItem("reaffirmed-analysis");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: () => publication.promise,
            loadStatistics: async (requestedItem, samplingArea) =>
                createLayerStatistics(
                    requestedItem,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    viewer.activateAnalysis(item);
    await flushPromises();
    const pendingShow = viewer.show(item);
    viewer.activateAnalysis(item);
    publication.resolve({
        layerName: `eolab:${item.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await pendingShow;

    assert.equal(viewer.contains(item), true);
    assert.equal(layerStackView.activeKey, null);
    assert.match(controlsView.activeLayer.label, /reaffirmed-analysis/);
    assert.equal(controlsView.activeLayer.label, "reaffirmed-analysis.tif");
    assert.equal(controlsView.displayedStatistics.itemId, item.id);
    viewer.destroy();
});

test("clearing analysis invalidates a pending renderer activation", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const publication = createDeferred();
    const item = createRasterItem("cleared-analysis");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: () => publication.promise,
            loadStatistics: async (requestedItem, samplingArea) =>
                createLayerStatistics(
                    requestedItem,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    viewer.activateAnalysis(item);
    const pendingShow = viewer.show(item);
    viewer.deactivateAnalysis(item);
    publication.resolve({
        layerName: `eolab:${item.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await pendingShow;

    assert.equal(controlsView.controlsVisible, false);
    assert.equal(viewer.contains(item), true);
    viewer.destroy();
});

test("sampling radios stop hover boxes and clear the previous area while vector features are pending", async () => {
    const timers = new Map(), cursorRequests = [];
    let timerId = 0;
    const h = visibleLayerFixture(undefined, {
        clock: {
            setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
            clearTimeout(id) { timers.delete(id); },
        },
        sampleCursorPixel: async (_item, point) => {
            cursorRequests.push(point);
            return {inBounds: true, value: 7};
        },
    });
    const sampling = new RasterSamplingAreaControlsView(new FakeRasterControlDocument());
    sampling.bind(h.controlsView.handlers);
    h.controlsView.setSamplingAreaMode = (mode, label) => sampling.setSamplingAreaMode(mode, label);
    h.controlsView.isSamplingBoxSelected = () => sampling.isSamplingBoxSelected();
    /** Simulate native radio exclusivity before dispatching its change. @param {Object} choice Radio to select. @return {void} */
    const choose = choice => {
        for (const radio of [sampling.useMapWindowButton, sampling.clearSampleWindowButton, sampling.vectorChoice]) radio.checked = radio === choice;
        choice.dispatchEvent(new Event("change"));
    };
    /** Move the pointer and complete its existing pixel dwell. @param {number} lng Longitude. @return {Promise<void>} Settled pixel reads. */
    const hover = async lng => {
        h.leafletMap.emit("mousemove", {latlng: {lng, lat: 0}});
        for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
        await flushPromises();
    };
    /** @return {boolean} Whether a pointer-preview rectangle is on the map. */
    const hasPreview = () => [...h.leafletMap.layers].some(layer => layer.kind === "preview");
    try {
        await h.viewer.show(createRasterItem("preview-area"));
        await flushPromises();
        await hover(0);
        assert.equal(hasPreview(), false, "Whole raster starts without a box preview");
        assert.equal(cursorRequests.length, 1);
        choose(sampling.useMapWindowButton);
        await hover(1);
        assert.equal(hasPreview(), true);
        choose(sampling.clearSampleWindowButton);
        assert.equal(hasPreview(), false, "Whole raster removes an existing preview immediately");
        await hover(2);
        assert.equal(hasPreview(), false);
        assert.equal(cursorRequests.length, 3, "whole-raster pixel picking stays active");
        choose(sampling.useMapWindowButton);
        await hover(3);
        assert.equal(hasPreview(), true);
        choose(sampling.vectorChoice);
        assert.equal(hasPreview(), false, "opening Vector layer immediately removes the preview");
        assert.equal(h.viewer.getSelectedArea(), null, "the previous box is unavailable while reading vector features");
        await hover(4);
        assert.equal(hasPreview(), false);
        assert.equal(cursorRequests.length, 5, "pixel picking also stays active while choosing polygons");
        h.viewer.setVectorSelection({selection: CATALOG_SELECTION, label: "Countries"});
        await hover(5);
        assert.equal(hasPreview(), false, "accepted polygons also have no box preview");
        assert.equal(cursorRequests.length, 6);
    } finally { sampling.unbind(); h.destroy(); }
});

test("raster viewer selects histogram areas only inside the single map world", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, rectangleLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const pixelRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => ({
                layerName: "eolab:test-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: () => new Promise(() => {}),
            samplePixel: async (item, point) => {
                pixelRequests.push({ item, point });
                return { inBounds: true, value: 1 };
            },
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(MOUNTED_GEOTIFF_ITEM);
    for (const invalid of [{ lng: 238, lat: 48 }, { lng: 0, lat: 91 }, { lng: NaN, lat: 0 }]) {
        assert.equal(viewer.exploreAt(invalid), false);
    }
    assert.equal(pixelRequests.length, 0);
    leafletMap.emit("mousemove", { latlng: { lng: 238, lat: 48 } });
    assert.equal(pixelRequests.length, 0);
    assert.equal(rectangleLayers.length, 0);

    leafletMap.emit("mousemove", { latlng: { lng: -122, lat: 48 } });
    assert.deepEqual(pixelRequests, []);
    assert.equal(rectangleLayers.length, 0, "Whole raster does not preview a box");
    viewer.exploreAt({ lng: -122, lat: 48 });
    await flushPromises();
    assert.deepEqual(pixelRequests, []);
    assert.ok(rectangleLayers.some((layer) => layer.kind === "selection"));
    viewer.destroy();
});

test("raster viewer ignores publication completed after a reset", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const publication = createDeferred();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: () => publication.promise,
            loadStatistics: () => new Promise(() => {}),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    const showResult = viewer.show(MOUNTED_GEOTIFF_ITEM);
    viewer.reset();
    publication.resolve({
        layerName: "eolab:stale-raster",
        bbox: [-180, -90, 180, 90],
    });

    assert.equal(await showResult, null);
    assert.equal(viewer.isDisplayed, false);
    assert.equal(controlsView.controlsVisible, false);
    assert.equal(wmsLayers.length, 0);
    viewer.destroy();
});

for (const wholeState of ["ready", "error"]) {
    test(`restoring a cached ${wholeState} whole-raster result replaces the box histogram card`, async () => {
        const requests = [];
        const h = visibleLayerFixture(async (item, area) => {
            requests.push(area.kind);
            if (area.kind === "wholeRaster" && wholeState === "error") {
                throw new Error("Whole-raster read exceeds the bounded-work limit");
            }
            return createLayerStatistics(item, selectedBoundsFromArea(area));
        });
        await h.viewer.show(createRasterItem(`whole-restore-${wholeState}`));
        await flushPromises();
        const wholeStatistics = h.controlsView.layerHistograms[0].statistics;
        h.viewer.exploreAt({ lng: -74, lat: 41 });
        await flushPromises();

        assert.equal(h.controlsView.layerHistograms[0].state, "ready");

        h.controlsView.handlers.onClearSampleWindow();

        const summary = h.controlsView.layerHistograms[0];

        assert.equal(summary.state, wholeState);
        assert.equal(summary.statistics, wholeStatistics);
        assert.equal(summary.errorMessage, wholeState === "error"
            ? "Whole-raster read exceeds the bounded-work limit" : "");
        if (wholeState === "error") assert.equal(summary.counts, null);
        await flushPromises();
        assert.deepEqual(requests, ["wholeRaster", "selectedArea"], "restoring cached state does not read again");
        h.destroy();
    });
}

test("manual style edits prevent late whole-raster automatic rescaling", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const wholeStatistics = createDeferred();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => ({
                layerName: "eolab:test-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: () => wholeStatistics.promise,
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    await viewer.show(MOUNTED_GEOTIFF_ITEM);

    controlsView.style.minimum = 1;
    controlsView.handlers.onStyleInput(false);
    controlsView.handlers.onStyleChange();
    assert.equal(wmsLayers[0].parameterUpdates.length, 1);

    wholeStatistics.resolve(RASTER_STATISTICS);
    await flushPromises();
    assert.equal(wmsLayers[0].parameterUpdates.length, 1);
    assert.equal(controlsView.style.minimum, 1);
    assert.match(
        controlsView.statisticsStatus,
        /current appearance was preserved/
    );
    viewer.destroy();
});

test("raster viewer renders every retained layer", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const publicationCounts = new Map();
    const mapLayerController = new MapLayerController({ leafletMap, view: layerStackView });
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            mapLayerController,
            publishRaster: async (item) => {
                publicationCounts.set(
                    item.id,
                    (publicationCounts.get(item.id) ?? 0) + 1
                );
                return {
                    layerName: `eolab:${item.id}`,
                    bbox: [-180, -90, 180, 90],
                };
            },
            loadStatistics: () => new Promise(() => {}),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("first");
    const second = createRasterItem("second");
    const third = createRasterItem("third");

    await viewer.show(first);
    await viewer.show(second);
    await viewer.show(third);

    assert.equal(layerStackView.layers.length, 3);
    assert.deepEqual(
        layerStackView.layers.map((layer) => [layer.item.id, layer.visible]),
        [
            [third.id, true],
            [second.id, true],
            [first.id, true],
        ]
    );
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        3
    );
    assert.deepEqual(controlsView.activeLayer, {
        label: "third.tif",
    });

    const thirdKey = layerStackView.layers[0].key;
    const firstKey = layerStackView.layers[2].key;
    layerStackView.handlers.onVisibility(firstKey, false);
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        2
    );
    layerStackView.handlers.onVisibility(firstKey, true);
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        3
    );
    assert.equal(wmsLayers[2].opacity, 1);
    mapLayerController.setOpacity(thirdKey, 0.4);
    assert.equal(wmsLayers[2].opacity, 0.4);
    assert.deepEqual(
        [...publicationCounts.values()],
        [1, 1, 1]
    );

    await viewer.show(third);
    assert.equal(publicationCounts.get(third.id), 1);
    assert.equal(viewer.contains(third), true);
    viewer.destroy();
    mapLayerController.destroy();
});

test("active layers restore isolated styles and completed statistics", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const first = createRasterItem("first-state");
    const second = createRasterItem("second-state");
    const statisticsById = new Map([
        [first.id, RASTER_STATISTICS],
        [
            second.id,
            {
                ...RASTER_STATISTICS,
                sampleMinimum: 100,
                sampleMaximum: 200,
                histogram: {
                    counts: [...RASTER_STATISTICS.histogram.counts],
                    edges: Array.from(
                        { length: 65 },
                        (_, index) => 100 + index * 100 / 64
                    ),
                },
            },
        ],
    ]);
    const statisticsCounts = new Map();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item) => {
                statisticsCounts.set(
                    item.id,
                    (statisticsCounts.get(item.id) ?? 0) + 1
                );
                return statisticsById.get(item.id);
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(first);
    await flushPromises();
    const firstKey = layerStackView.activeKey;
    assert.equal(controlsView.displayedStatistics, RASTER_STATISTICS);
    controlsView.style = {
        ...controlsView.style,
        minimum: -5,
        midpoint: 5,
        maximum: 15,
    };
    controlsView.handlers.onStyleChange();
    const firstStyle = { ...controlsView.style };

    await viewer.show(second);
    await flushPromises();
    const secondKey = layerStackView.activeKey;
    assert.notEqual(secondKey, firstKey);
    assert.equal(controlsView.displayedStatistics, statisticsById.get(second.id));
    assert.notDeepEqual(controlsView.style, firstStyle);

    viewer.activateAnalysis(layerStackView.layers.find(({ key }) => key === firstKey).item);
    assert.deepEqual(controlsView.style, firstStyle);
    assert.equal(controlsView.displayedStatistics, RASTER_STATISTICS);
    assert.equal(statisticsCounts.get(first.id), 1);
    assert.equal(statisticsCounts.get(second.id), 1);
    assert.ok(wmsLayers[0].parameterUpdates.length > 0);
    viewer.destroy();
});

test("raster analysis summaries select a labeled retained histogram", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const statisticsCounts = new Map();
    let histogramPresentationRequests = 0;
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
            onHistogramRequested() {
                histogramPresentationRequests += 1;
            },
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, samplingArea) => {
                statisticsCounts.set(
                    item.id,
                    (statisticsCounts.get(item.id) ?? 0) + 1
                );
                return createLayerStatistics(
                    item,
                    selectedBoundsFromArea(samplingArea)
                );
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("tool-first");
    const second = createRasterItem("tool-second");
    await viewer.show(first);
    await flushPromises();
    await viewer.show(second);
    await flushPromises();
    const firstLayer = layerStackView.layers.find(({ item }) => item === first);
    const firstHistogram = controlsView.layerHistograms.find(
        ({ key }) => key === firstLayer.key
    );

    assert.equal(controlsView.layerHistograms.length, 2);

    assert.equal(firstHistogram.state, "ready");
    assert.equal(firstHistogram.counts.length, 64);

    controlsView.handlers.onSelectHistogram(firstLayer.key);
    await flushPromises();

    assert.equal(layerStackView.activeKey, firstLayer.key);
    assert.equal(controlsView.activeHistogramKey, firstLayer.key);
    assert.equal(controlsView.histogramWidgetOpenCount, 1);
    assert.equal(histogramPresentationRequests, 1);
    assert.equal(statisticsCounts.get(first.id), 1);
    assert.equal(statisticsCounts.get(second.id), 1);
    viewer.destroy();
});

test("a restored whole-raster statistics error retries the active layer", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const first = createRasterItem("retry-error-first");
    const second = createRasterItem("retry-error-second");
    const statisticsRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, samplingArea, signal) => {
                const selectedBounds = selectedBoundsFromArea(samplingArea);
                statisticsRequests.push({ item, selectedBounds, signal });
                const firstAttemptCount = statisticsRequests.filter(
                    (request) => request.item === first
                ).length;
                if (item === first && firstAttemptCount === 1) {
                    throw new Error("First histogram failed");
                }
                return createLayerStatistics(item, selectedBounds);
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(first);
    await flushPromises();
    const firstKey = layerStackView.activeKey;
    assert.match(controlsView.statisticsStatus, /First histogram failed/);
    assert.equal(controlsView.statisticsRetryVisible, true);

    await viewer.show(second);
    await flushPromises();
    assert.equal(controlsView.displayedStatistics.itemId, second.id);
    viewer.activateAnalysis(layerStackView.layers.find(({ key }) => key === firstKey).item);
    assert.match(controlsView.statisticsStatus, /First histogram failed/);
    assert.equal(controlsView.statisticsRetryVisible, true);

    controlsView.handlers.onRetryStatistics();
    await flushPromises();
    const firstRequests = statisticsRequests.filter(
        ({ item }) => item === first
    );
    assert.equal(firstRequests.length, 2);
    assert.equal(firstRequests[1].selectedBounds, null);
    assert.equal(firstRequests[1].signal.aborted, false);
    assert.equal(controlsView.displayedStatistics.itemId, first.id);
    assert.equal(controlsView.displayedStatistics.scope, "wholeRaster");
    assert.equal(controlsView.statisticsRetryVisible, false);
    viewer.destroy();
});

test("selected-area failure survives a layer switch and retries its original area", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const first = createRasterItem("retry-selected-first");
    const second = createRasterItem("retry-selected-second");
    const reads = [];
    let failSelected = true;
    const viewer = initializeRasterViewer({
        wmsUrl: "/geoserver/eolab/wms", leafletMap, leaflet, onTileError() {},
    }, {
        controlsView, layerStackView: createFakeLayerStackView(),
        publishRaster: async item => ({ layerName: `eolab:${item.id}`, bbox: [-180, -90, 180, 90] }),
        loadStatistics: async (item, area, signal) => {
            reads.push({ item, area, signal });
            if (item === first && area.kind === "selectedArea" && failSelected) {
                throw new Error("Selected-area read failed");
            }
            return createLayerStatistics(item, selectedBoundsFromArea(area));
        },
        samplePixel: async () => ({ inBounds: true, value: 1 }),
    });
    try {
        await viewer.show(first);
        await flushPromises();
        viewer.exploreAt({ lng: -74, lat: 41 });
        await flushPromises();
        const failedRead = reads.at(-1);
        assert.equal(failedRead.item, first);
        assert.equal(failedRead.area.kind, "selectedArea");
        assert.match(controlsView.statisticsStatus, /Selected-area read failed/);
        assert.equal(controlsView.statisticsRetryVisible, true);

        await viewer.show(second);
        await flushPromises();
        assert.equal(controlsView.displayedStatistics.itemId, second.id);
        const beforeRestore = reads.length;
        viewer.activateAnalysis(first);
        assert.equal(reads.length, beforeRestore, "Restoring an error does not silently retry");
        assert.match(controlsView.statisticsStatus, /Selected-area read failed/);
        assert.equal(controlsView.statisticsRetryVisible, true);
        assert.deepEqual(viewer.getSelectedArea().selectedBounds, failedRead.area.selectedBounds);

        failSelected = false;
        controlsView.handlers.onRetryStatistics();
        await flushPromises();
        const retriedReads = reads.slice(beforeRestore);
        const activeRetries = retriedReads.filter(read => read.item === first);
        assert.equal(activeRetries.length, 1);
        for (const read of retriedReads) assert.deepEqual(read.area, failedRead.area);
        assert.equal(activeRetries[0].signal.aborted, false);
        assert.equal(controlsView.displayedStatistics.itemId, first.id);
        assert.equal(controlsView.displayedStatistics.scope, "selectedArea");
        assert.deepEqual(controlsView.displayedStatistics.selectedBounds, failedRead.area.selectedBounds);
        assert.equal(controlsView.statisticsRetryVisible, false);
        assert.doesNotMatch(controlsView.statisticsStatus, /read failed/);
    } finally {
        viewer.destroy();
    }
});

test("exhausted capacity retries offer manual recovery without stale histograms", async () => {
    const timers = new Map();
    const clock = {
        /** Retain the next retry until explicitly advanced. @return {Function} Timer token. */
        setTimeout(callback, delay) { timers.set(callback, delay); return callback; },
        /** Remove an aborted retry timer. @return {void} */
        clearTimeout(callback) { timers.delete(callback); },
    };
    let busy = true;
    let attempts = 0;
    const h = visibleLayerFixture(async (item) => {
        attempts++;
        if (busy) throw new RasterAnalysisRequestError("Capacity occupied", 409, "statistics_capacity_busy");
        return createLayerStatistics(item);
    }, { clock });
    await h.viewer.show(MOUNTED_GEOTIFF_ITEM);
    for (const delay of [250, 500, 1000, 2000, 4000]) {
        await flushPromises();
        assert.equal(h.controlsView.layerHistograms[0].state, "loading");
        assert.deepEqual([...timers.values()], [delay]);
        const callback = timers.keys().next().value;
        timers.delete(callback);
        callback();
    }
    await flushPromises();
    assert.equal(attempts, 6);
    assert.equal(h.controlsView.layerHistograms[0].state, "error");
    assert.equal(h.controlsView.statisticsRetryVisible, true);
    busy = false;
    h.controlsView.handlers.onRetryStatistics();
    await flushPromises();
    assert.equal(attempts, 7);
    assert.equal(h.controlsView.layerHistograms[0].state, "ready");
    assert.equal(h.controlsView.statisticsRetryVisible, false);
    h.destroy();
});

test("a deterministic selected-area conflict does not offer Retry", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => ({
                layerName: "eolab:striped-raster",
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (_item, samplingArea) => {
                if (samplingArea.kind === "wholeRaster") {
                    return RASTER_STATISTICS;
                }
                throw new RasterAnalysisRequestError(
                    "The native raster block is too large for bounded reads.",
                    409
                );
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(MOUNTED_GEOTIFF_ITEM);
    await flushPromises();
    viewer.exploreAt({ lng: -122, lat: 48.5 });
    await flushPromises();

    assert.match(
        controlsView.statisticsStatus,
        /native raster block is too large/
    );
    assert.equal(controlsView.statisticsRetryVisible, false);
    viewer.destroy();
});

test("out-of-order publications do not steal the latest active selection", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const first = createRasterItem("slow-first");
    const second = createRasterItem("fast-second");
    const publications = new Map([
        [first.id, createDeferred()],
        [second.id, createDeferred()],
    ]);
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: (item) => publications.get(item.id).promise,
            loadStatistics: () => new Promise(() => {}),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    const firstRequest = viewer.show(first);
    const secondRequest = viewer.show(second);
    publications.get(second.id).resolve({
        layerName: `eolab:${second.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await secondRequest;
    const expectedActiveKey = layerStackView.activeKey;
    publications.get(first.id).resolve({
        layerName: `eolab:${first.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await firstRequest;

    assert.equal(layerStackView.layers.length, 2);
    assert.equal(layerStackView.activeKey, expectedActiveKey);
    assert.deepEqual(
        layerStackView.layers.map((layer) => layer.item.id),
        [second.id, first.id]
    );
    assert.equal(
        layerStackView.layers.find((layer) => layer.key === expectedActiveKey)
            .item.id,
        second.id
    );
    viewer.destroy();
});

test("manual activation outranks an earlier deferred publication", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const slowPublication = createDeferred();
    const statisticsRequests = [];
    const retained = createRasterItem("manual-activation-retained");
    const slow = createRasterItem("manual-activation-slow");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => {
                if (item === slow) {
                    return slowPublication.promise;
                }
                return {
                    layerName: `eolab:${item.id}`,
                    bbox: [-180, -90, 180, 90],
                };
            },
            loadStatistics: async (item, samplingArea, signal) => {
                const selectedBounds = selectedBoundsFromArea(samplingArea);
                statisticsRequests.push({ item, signal, selectedBounds });
                return createLayerStatistics(item, selectedBounds);
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(retained);
    await flushPromises();
    const retainedKey = layerStackView.activeKey;
    const slowRequest = viewer.show(slow);
    viewer.activateAnalysis(layerStackView.layers.find(({ key }) => key === retainedKey).item);
    slowPublication.resolve({
        layerName: `eolab:${slow.id}`,
        bbox: [-180, -90, 180, 90],
    });
    await slowRequest;

    assert.equal(viewer.contains(slow), true);
    assert.equal(layerStackView.layers.length, 2);
    assert.equal(layerStackView.activeKey, retainedKey);
    assert.deepEqual(controlsView.activeLayer, {
        label: "manual-activation-retained.tif",
    });
    assert.equal(controlsView.displayedStatistics.itemId, retained.id);
    assert.equal(
        statisticsRequests.filter(({ item }) => item === slow).length,
        0
    );
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        2
    );
    viewer.destroy();
});

test("hidden WMS renderers do not gate active Catalog analysis", async () => {
    const leafletMap = createFakeMap();
    const { leaflet } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const statisticsRequests = [];
    const pixelRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: (item, samplingArea, signal) => {
                const selectedBounds = selectedBoundsFromArea(samplingArea);
                if (item.id !== "geotiff-hidden-work-third") {
                    return Promise.resolve(createLayerStatistics(item, selectedBounds));
                }
                const deferred = createDeferred();
                signal.addEventListener("abort", () => deferred.reject(signal.reason), { once: true });
                statisticsRequests.push({
                    deferred,
                    item,
                    selectedBounds,
                    signal,
                });
                return deferred.promise;
            },
            samplePixel: async (item, point) => {
                pixelRequests.push({ item, point });
                return { inBounds: true, value: 1 };
            },
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("hidden-work-first");
    const second = createRasterItem("hidden-work-second");
    const third = createRasterItem("hidden-work-third");

    await viewer.show(first);
    await viewer.show(second);
    await viewer.show(third);
    const thirdKey = layerStackView.layers.find(
        ({ item }) => item === third,
    ).key;
    layerStackView.handlers.onVisibility(thirdKey, false);

    const wholeThirdRequest = statisticsRequests.find(
        ({ item, selectedBounds }) => item === third && selectedBounds === null
    );
    assert.ok(wholeThirdRequest);
    assert.equal(wholeThirdRequest.signal.aborted, false);
    assert.deepEqual(controlsView.activeLayer, {
        label: "hidden-work-third.tif",
    });

    viewer.exploreAt({ lng: -74, lat: 41 });
    await flushPromises();
    const selectedThirdRequest = statisticsRequests.find(
        ({ item, selectedBounds }) =>
            item === third && selectedBounds !== null
    );
    assert.ok(selectedThirdRequest);
    assert.equal(wholeThirdRequest.signal.aborted, true);
    assert.equal(selectedThirdRequest.signal.aborted, false);
    assert.equal(pixelRequests.length, 0);

    const firstKey = layerStackView.layers.find(
        ({ item }) => item === first
    ).key;
    layerStackView.handlers.onVisibility(firstKey, false);
    layerStackView.handlers.onVisibility(thirdKey, true);
    layerStackView.handlers.onVisibility(thirdKey, false);
    assert.equal(selectedThirdRequest.signal.aborted, false);

    selectedThirdRequest.deferred.resolve(
        createLayerStatistics(third, selectedThirdRequest.selectedBounds)
    );
    await flushPromises();
    assert.equal(controlsView.displayedStatistics.itemId, third.id);
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");
    wholeThirdRequest.deferred.resolve(createLayerStatistics(third));
    await flushPromises();
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");

    layerStackView.handlers.onVisibility(thirdKey, true);
    const thirdRequests = statisticsRequests.filter(
        ({ item }) => item === third
    );
    assert.equal(thirdRequests.length, 2);
    assert.equal(controlsView.displayedStatistics.itemId, third.id);
    viewer.destroy();
});

test("map box resizes immediately while committing only the final debounced area", async () => {
    const timers = new Map();
    let nextTimerId = 1;
    const clock = {
        setTimeout(callback, delay) {
            const id = nextTimerId;
            nextTimerId += 1;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
    };
    const leafletMap = createFakeMap();
    const { leaflet, rectangleLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const statisticsRequests = [], committed = [], presentations = [];
    let opened = 0;
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
            onSamplingAreaChange: area => committed.push(area),
            onHistogramChange: snapshot => presentations.push(snapshot),
            onHistogramRequested: () => { opened += 1; },
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, samplingArea) => {
                const selectedBounds = selectedBoundsFromArea(samplingArea);
                statisticsRequests.push({ item, selectedBounds });
                return createLayerStatistics(item, selectedBounds);
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
            clock,
        }
    );

    await viewer.show(createRasterItem("centered-box"));
    await flushPromises();
    controlsView.handlers.onSampleWindowRangeInput(200);
    controlsView.handlers.onUseMapWindow();
    await flushPromises();

    const centeredRequest = statisticsRequests.find(
        ({ selectedBounds }) => selectedBounds !== null
    );
    assert.ok(centeredRequest);
    assert.equal(
        (centeredRequest.selectedBounds.west + centeredRequest.selectedBounds.east) / 2,
        0
    );
    assert.equal(
        (centeredRequest.selectedBounds.south + centeredRequest.selectedBounds.north) / 2,
        0
    );
    assert.match(controlsView.samplingAreaLabel, /Sampling box · 200 × 200 km/);

    const rectangle = rectangleLayers.find(layer => layer.kind === "selection");
    const oldGeometry = rectangle.boundsHistory.at(-1);
    const before = statisticsRequests.length, committedBefore = committed.length, openedBefore = opened;
    controlsView.handlers.onSampleWindowRangeInput(75);
    const firstResize = rectangle.boundsHistory.at(-1);
    assert.notDeepEqual(firstResize, oldGeometry);
    controlsView.handlers.onSampleWindowNumberInput("90");
    const finalGeometry = rectangle.boundsHistory.at(-1);
    assert.notDeepEqual(finalGeometry, firstResize);
    assert.equal(rectangleLayers.length, 1, "reuse the selected rectangle");
    assert.equal(statisticsRequests.length, before);
    assert.equal(committed.length, committedBefore);
    assert.deepEqual(viewer.getSelectedArea().selectedBounds, centeredRequest.selectedBounds);
    assert.equal(presentations.at(-1).state, "loading");
    assert.match(presentations.at(-1).message, /results show the previous area/);
    assert.equal((finalGeometry[0][1] + finalGeometry[1][1]) / 2, 0);
    assert.ok(Math.abs((finalGeometry[0][0] + finalGeometry[1][0]) / 2) < 1e-12);
    assert.equal(timers.size, 1);
    const pending = [...timers.values()][0];
    assert.equal(
        pending.delay,
        RASTER_SAMPLE_WINDOW_RESIZE_DEBOUNCE_MILLISECONDS
    );
    assert.match(
        controlsView.sampleWindowStatus,
        /Updating the selected map box to 90 km × 90 km/
    );
    timers.clear();
    pending.callback();
    await flushPromises();

    const resizedRequest = statisticsRequests.at(-1);
    assert.notDeepEqual(resizedRequest.selectedBounds, centeredRequest.selectedBounds);
    assert.match(controlsView.samplingAreaLabel, /Sampling box · 90 × 90 km/);
    viewer.destroy();
});

for (const transition of ["whole", "vector", "close", "center", "invalid", "original"]) {
    test(`pending resize cannot replace a newer ${transition} choice`, async () => {
        const timers = new Map(), requests = [];
        let timerId = 0;
        const h = visibleLayerFixture(async (item, area) => {
            requests.push(area);
            return createLayerStatistics(item, selectedBoundsFromArea(area));
        }, {clock: {
            setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
            clearTimeout(id) { timers.delete(id); },
        }});
        await h.viewer.show(createRasterItem("resize-cancellation"));
        h.viewer.exploreAt({lng: -75, lat: 40});
        await flushPromises();
        const original = h.viewer.getSelectedArea();
        h.controlsView.handlers.onSampleWindowRangeInput(90);
        assert.equal(timers.size, 1);
        if (transition === "whole") h.controlsView.handlers.onClearSampleWindow();
        if (transition === "vector") h.controlsView.handlers.onUseVectorArea();
        if (transition === "close") h.viewer.cancelSampleWindowResize();
        if (transition === "center") h.viewer.exploreAt({lng: -80, lat: 35});
        if (transition === "invalid") h.controlsView.handlers.onSampleWindowNumberInput("");
        if (transition === "original") h.controlsView.handlers.onSampleWindowRangeInput(600);
        assert.equal(timers.size, 0);
        await flushPromises();
        if (["whole", "vector"].includes(transition)) {
            assert.equal(h.viewer.getSelectedArea(), null);
            assert.equal([...h.leafletMap.layers].some(layer => layer.kind === "selection"), false);
            const count = requests.length;
            h.controlsView.handlers.onSampleWindowNumberInput("75");
            assert.equal(timers.size, 0);
            assert.equal(requests.length, count);
            assert.equal([...h.leafletMap.layers].some(layer => layer.kind === "selection"), false);
        } else {
            const area = h.viewer.getSelectedArea();
            if (transition === "center") assert.notDeepEqual(area, original);
            else assert.deepEqual(area, original);
            const bounds = area.selectedBounds;
            const rectangle = [...h.leafletMap.layers].find(layer => layer.kind === "selection");
            assert.deepEqual(rectangle.boundsHistory.at(-1), [[bounds.south, bounds.west], [bounds.north, bounds.east]]);
        }
        h.destroy();
    });
}

test("late histogram results stay scoped to the old area during a resize", async () => {
    const requests = [], timers = new Map(), presentations = [];
    let timerId = 0;
    const h = visibleLayerFixture((item, area, signal) => {
        if (area.kind === "wholeRaster") return Promise.resolve(createLayerStatistics(item));
        const deferred = createDeferred();
        requests.push({item, area, signal, deferred});
        return deferred.promise;
    }, {clock: {
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
    }}, {onHistogramChange: snapshot => presentations.push(snapshot)});
    await h.viewer.show(createRasterItem("late-resize-result"));
    h.viewer.exploreAt({lng: -75, lat: 40});
    await flushPromises();
    h.controlsView.handlers.onSampleWindowNumberInput("75");
    requests[0].deferred.resolve(createLayerStatistics(requests[0].item, requests[0].area.selectedBounds));
    await flushPromises();
    assert.deepEqual(h.controlsView.displayedStatistics.selectedBounds, requests[0].area.selectedBounds);
    assert.equal(presentations.at(-1).state, "loading");
    assert.match(presentations.at(-1).message, /results show the previous area/);
    const commit = [...timers.values()][0]; timers.clear(); commit();
    await flushPromises();
    assert.equal(requests.length, 2);
    requests[1].deferred.resolve(createLayerStatistics(requests[1].item, requests[1].area.selectedBounds));
    await flushPromises();
    assert.deepEqual(h.controlsView.displayedStatistics.selectedBounds, h.viewer.getSelectedArea().selectedBounds);
    assert.equal(presentations.at(-1).state, "ready");
    assert.equal(h.controlsView.layerHistograms[0].canRescale, true);
    h.controlsView.handlers.onSampleWindowNumberInput("100");
    assert.equal(h.controlsView.layerHistograms[0].canRescale, false);
    assert.match(h.controlsView.layerHistograms[0].percentileMessage, /Waiting/);
    h.controlsView.handlers.onSampleWindowNumberInput("75");
    assert.equal(h.controlsView.layerHistograms[0].canRescale, true);
    h.destroy();
});

test("histogram clicks use visible coverage without requesting unused pixel values", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, rectangleLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const pixelRequests = [];
    let histogramPresentationRequests = 0;
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
            onHistogramRequested() {
                histogramPresentationRequests += 1;
            },
        },
        {
            controlsView,
            layerStackView: createFakeLayerStackView(),
            publishRaster: async () => ({
                layerName: "eolab:regional-raster",
                bbox: [70, 15, 90, 30],
            }),
            loadStatistics: () => new Promise(() => {}),
            samplePixel: async (item, point) => {
                pixelRequests.push({ item, point });
                return { inBounds: point.longitude !== 0, value: point.longitude === 0 ? null : 1 };
            },
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(MOUNTED_GEOTIFF_ITEM);
    assert.equal(viewer.exploreAt({ lng: 0, lat: 20 }), false);
    await flushPromises();
    assert.equal(pixelRequests.length, 0);
    assert.equal(histogramPresentationRequests, 0);
    assert.equal(
        rectangleLayers.some((layer) => layer.kind === "selection"),
        false
    );

    assert.equal(viewer.exploreAt({ lng: 80, lat: 20 }), true);
    await flushPromises();
    assert.equal(pixelRequests.length, 0);
    assert.equal(histogramPresentationRequests, 1);
    assert.ok(rectangleLayers.some((layer) => layer.kind === "selection"));
    assert.equal(viewer.exploreAt({ lng: -50, lat: 20 }), false);
    await flushPromises();
    assert.equal(pixelRequests.length, 0);
    assert.equal(histogramPresentationRequests, 1);
    viewer.destroy();

    const areaRequests = [], clickRequests = [];
    const h = visibleLayerFixture(async (item, area) => {
        if (area.kind !== 'wholeRaster') areaRequests.push({ item, area });
        return createLayerStatistics(item, selectedBoundsFromArea(area));
    }, {
        publishRaster: async item => ({
            layerName: 'eolab:' + item.id,
            bbox: item.id.endsWith('-11') ? [70, 15, 90, 30]
                : item.id.endsWith('-0') ? [100, 15, 120, 30] : [-90, 35, -60, 55],
        }),
        samplePixel: async item => {
            clickRequests.push(item.id);
            return { inBounds: false, value: null };
        },
    });
    const items = Array.from({ length: 17 }, (_, index) => createRasterItem('coverage-' + index));
    for (const item of items) await h.viewer.show(item);
    await flushPromises();
    areaRequests.length = 0;
    assert.equal(h.viewer.exploreAt({ lng: 80, lat: 20 }), true);
    await flushPromises();
    assert.equal(areaRequests.length, 16);
    assert.ok(areaRequests.some(({ item }) => item.id === items[11].id));
    assert.deepEqual(clickRequests, []);
    assert.equal(h.controlsView.layerHistograms.length, 16);

    // Even the seventeenth extent can open a box without raising the read cap.
    areaRequests.length = 0;
    assert.equal(h.viewer.exploreAt({ lng: 110, lat: 20 }), true);
    await flushPromises();
    assert.equal(areaRequests.length, 16);
    assert.equal(areaRequests.some(({ item }) => item.id === items[0].id), false);
    const previousArea = h.viewer.getSelectedArea();
    const regional = h.mapLayers.snapshots().find(layer => layer.item.id === items[11].id);
    h.mapLayers.setVisible(regional.key, false);
    await flushPromises();
    areaRequests.length = 0;
    assert.equal(h.viewer.exploreAt({ lng: 80, lat: 20 }), false);
    await flushPromises();
    assert.equal(areaRequests.length, 0);
    assert.deepEqual(h.viewer.getSelectedArea(), previousArea);
    h.destroy();
});

test("explicit sampling refreshes every raster layer to one shared area", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, rectangleLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const statisticsRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, samplingArea, signal) => {
                const selectedBounds = selectedBoundsFromArea(samplingArea);
                statisticsRequests.push({ item, selectedBounds, signal });
                return createLayerStatistics(item, selectedBounds);
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("selection-first");
    const second = createRasterItem("selection-second");

    await viewer.show(first);
    await flushPromises();
    const firstKey = layerStackView.activeKey;
    controlsView.handlers.onSampleWindowNumberInput("42");
    viewer.exploreAt({ lng: -74, lat: 41 });
    await flushPromises();
    const firstSelectedRequest = statisticsRequests.find(
        ({ item, selectedBounds }) =>
            item === first && selectedBounds !== null
    );
    assert.ok(firstSelectedRequest);
    const firstSelectionLayer = rectangleLayers.find(
        (layer) => layer.kind === "selection" &&
            leafletMap.layers.has(layer)
    );
    assert.ok(firstSelectionLayer);
    assert.equal(controlsView.displayedStatistics.itemId, first.id);
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");
    await viewer.show(second);
    await flushPromises();
    controlsView.handlers.onSampleWindowNumberInput("80");
    viewer.exploreAt({ lng: 12, lat: 34 });
    await flushPromises();
    assert.equal(controlsView.displayedStatistics.itemId, second.id);
    assert.equal(controlsView.sampleWindowSizeKm, 80);

    const firstSelectedRequests = statisticsRequests.filter(
        ({ item, selectedBounds }) =>
            item === first && selectedBounds !== null
    );
    assert.equal(firstSelectedRequests.length, 2);
    const sharedFirstRequest = firstSelectedRequests.at(-1);
    const secondSelectedRequest = statisticsRequests.findLast(
        ({ item, selectedBounds }) =>
            item === second && selectedBounds !== null
    );
    assert.deepEqual(
        sharedFirstRequest.selectedBounds,
        secondSelectedRequest.selectedBounds
    );
    viewer.activateAnalysis(layerStackView.layers.find(({ key }) => key === firstKey).item);

    assert.equal(controlsView.sampleWindowSizeKm, 80);
    assert.equal(controlsView.displayedStatistics.itemId, first.id);
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");
    assert.deepEqual(
        controlsView.displayedStatistics.selectedBounds,
        sharedFirstRequest.selectedBounds
    );
    assert.equal(
        statisticsRequests.filter(
            ({ item, selectedBounds }) =>
                item === first && selectedBounds !== null
        ).length,
        firstSelectedRequests.length
    );
    const attachedSelections = rectangleLayers.filter(
        (layer) => layer.kind === "selection" && leafletMap.layers.has(layer)
    );
    assert.equal(attachedSelections.length, 1);
    assert.deepEqual(
        attachedSelections[0].boundsHistory.at(-1),
        [
            [
                sharedFirstRequest.selectedBounds.south,
                sharedFirstRequest.selectedBounds.west,
            ],
            [
                sharedFirstRequest.selectedBounds.north,
                sharedFirstRequest.selectedBounds.east,
            ],
        ]
    );
    assert.equal(leafletMap.layers.has(firstSelectionLayer), false);
    viewer.destroy();
});

test("removing an active WMS renderer preserves analysis before adjacent restore", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const statisticsRequests = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, samplingArea) => {
                statisticsRequests.push({ item, samplingArea });
                return createLayerStatistics(
                    item,
                    selectedBoundsFromArea(samplingArea)
                );
            },
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("remove-first");
    const second = createRasterItem("remove-second");
    const third = createRasterItem("remove-third");

    await viewer.show(first);
    await flushPromises();
    await viewer.show(second);
    await flushPromises();
    await viewer.show(third);
    await flushPromises();
    const keys = new Map(
        layerStackView.layers.map(({ item, key }) => [item, key])
    );

    viewer.exploreAt({ lng: -73, lat: 42 });
    await flushPromises();
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");
    controlsView.setPaletteName("viridis");
    controlsView.handlers.onPaletteChange();
    const thirdRequestCount = statisticsRequests.filter(
        ({ item }) => item === third
    ).length;

    layerStackView.handlers.onRemove(keys.get(third));
    assert.equal(layerStackView.activeKey, null);
    assert.match(controlsView.activeLayer.label, /remove-third/);
    assert.equal(controlsView.activeLayer.label, "remove-third.tif");
    assert.equal(controlsView.displayedStatistics.itemId, third.id);
    assert.equal(controlsView.displayedStatistics.scope, "selectedArea");
    assert.equal(controlsView.paletteName, "viridis");
    assert.equal(
        statisticsRequests.filter(({ item }) => item === third).length,
        thirdRequestCount
    );
    assert.equal(
        wmsLayers.some(
            (layer) =>
                layer.wmsOptions.layers === `eolab:${third.id}` &&
                leafletMap.layers.has(layer)
        ),
        false
    );

    viewer.deactivateAnalysis(third);
    assert.equal(layerStackView.activeKey, keys.get(second));
    assert.equal(controlsView.displayedStatistics.itemId, second.id);
    layerStackView.handlers.onRemove(keys.get(second));
    assert.equal(layerStackView.activeKey, null);
    assert.match(controlsView.activeLayer.label, /remove-second/);
    assert.equal(controlsView.activeLayer.label, "remove-second.tif");
    viewer.deactivateAnalysis(second);
    assert.equal(layerStackView.activeKey, keys.get(first));
    assert.equal(controlsView.displayedStatistics.itemId, first.id);
    layerStackView.handlers.onRemove(keys.get(first));
    assert.equal(layerStackView.layers.length, 0);
    assert.equal(controlsView.controlsVisible, true);
    assert.equal(controlsView.activeLayer.label, "remove-first.tif");
    viewer.deactivateAnalysis(first);
    assert.equal(controlsView.controlsVisible, false);
    assert.equal(
        wmsLayers.some((layer) => leafletMap.layers.has(layer)),
        false
    );
    viewer.destroy();
});

test("tile failures remain associated with their owning raster layer", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const tileErrors = [];
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError: (message, item) => tileErrors.push({ message, item }),
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (item, samplingArea) =>
                createLayerStatistics(
                    item,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("tile-error-first");
    const second = createRasterItem("tile-error-second");

    await viewer.show(first);
    await flushPromises();
    await viewer.show(second);
    await flushPromises();
    const firstLayer = wmsLayers.find(
        (layer) => layer.wmsOptions.layers === `eolab:${first.id}`
    );
    firstLayer.eventHandlers.get("tileerror")();

    assert.deepEqual(tileErrors, [{
        message: "Map tiles could not be rendered.",
        item: first,
    }]);
    assert.equal(
        layerStackView.layers.find(({ item }) => item === first).error,
        "Map tiles could not be rendered."
    );
    assert.equal(
        layerStackView.layers.find(({ item }) => item === second).error,
        null
    );
    assert.equal(layerStackView.activeKey,
        layerStackView.layers.find(({ item }) => item === second).key);
    assert.equal(controlsView.displayedStatistics.itemId, second.id);
    viewer.destroy();
});

test("a removed layer's late tile failure cannot mark its replacement", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const tileErrors = [];
    const item = createRasterItem("tile-error-replacement");
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError: (message, failedItem) =>
                tileErrors.push({ message, item: failedItem }),
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async () => ({
                layerName: `eolab:${item.id}`,
                bbox: [-180, -90, 180, 90],
            }),
            loadStatistics: async (requestedItem, samplingArea) =>
                createLayerStatistics(
                    requestedItem,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );

    await viewer.show(item);
    await flushPromises();
    const removedLayer = wmsLayers[0];
    viewer.remove(item);
    await viewer.show(item);
    await flushPromises();
    assert.equal(wmsLayers.length, 2);

    removedLayer.eventHandlers.get("tileerror")();

    assert.deepEqual(tileErrors, []);
    assert.equal(layerStackView.layers[0].error, null);
    assert.equal(controlsView.displayedStatistics.itemId, item.id);
    viewer.destroy();
});

test("a failed publication preserves existing layers and can be retried", async () => {
    const leafletMap = createFakeMap();
    const { leaflet, wmsLayers } = createFakeLeaflet();
    const controlsView = createFakeControlsView();
    const layerStackView = createFakeLayerStackView();
    const publicationCounts = new Map();
    const viewer = initializeRasterViewer(
        {
            wmsUrl: "/geoserver/eolab/wms",
            leafletMap,
            leaflet,
            onTileError() {},
        },
        {
            controlsView,
            layerStackView,
            publishRaster: async (item) => {
                const count = (publicationCounts.get(item.id) ?? 0) + 1;
                publicationCounts.set(item.id, count);
                if (item.id.endsWith("publication-second") && count === 1) {
                    throw new Error("GeoServer publication failed");
                }
                return {
                    layerName: `eolab:${item.id}`,
                    bbox: [-180, -90, 180, 90],
                };
            },
            loadStatistics: async (item, samplingArea) =>
                createLayerStatistics(
                    item,
                    selectedBoundsFromArea(samplingArea)
                ),
            samplePixel: async () => ({ inBounds: true, value: 1 }),
            viewport: { innerWidth: 1280, innerHeight: 720 },
        }
    );
    const first = createRasterItem("publication-first");
    const second = createRasterItem("publication-second");

    await viewer.show(first);
    await flushPromises();
    const firstKey = layerStackView.activeKey;
    await assert.rejects(
        viewer.show(second),
        /GeoServer publication failed/
    );
    assert.equal(viewer.contains(first), true);
    assert.equal(viewer.contains(second), false);
    assert.equal(layerStackView.activeKey, firstKey);
    assert.equal(controlsView.displayedStatistics.itemId, first.id);
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        1
    );

    await viewer.show(second);
    await flushPromises();
    assert.equal(publicationCounts.get(second.id), 2);
    assert.equal(viewer.contains(second), true);
    assert.equal(layerStackView.layers.length, 2);
    assert.equal(
        wmsLayers.filter((layer) => leafletMap.layers.has(layer)).length,
        2
    );
    viewer.destroy();
});

test("catalog selection replacement aborts stale requests and clears a map box", async () => {
    const requests=[];
    const h=visibleLayerFixture(async (_item,area,signal) => {
        if (area.kind !== "catalogSelection") return RASTER_STATISTICS;
        const deferred=createDeferred(); requests.push({deferred,area,signal}); return deferred.promise;
    });
    await h.viewer.show(createRasterItem("one")); await flushPromises();
    h.viewer.setVectorSelection({selection:CATALOG_SELECTION,label:"First"});
    await flushPromises();
    const changed={...CATALOG_SELECTION,itemId:"other-countries"};
    h.viewer.setVectorSelection({selection:changed,label:"Replacement"});
    assert.ok(requests[0].signal.aborted);
    requests[0].deferred.resolve(CATALOG_SELECTION_RASTER_STATISTICS); await flushPromises();
    assert.deepEqual(h.viewer.getSelectedArea().catalogSelection,changed);
    for (const request of requests.slice(1)) request.deferred.resolve({...CATALOG_SELECTION_RASTER_STATISTICS,catalogSelection:changed});
    await flushPromises();
    h.viewer.setVectorSelection(null); await flushPromises();
    assert.equal(h.viewer.getSelectedArea(),null);
    h.destroy();
});

test("hide all cancels pending histograms and drops late results; show all restores analysis", async () => {
    const reads = [];
    const h = visibleLayerFixture((item, area, signal) => {
        if (area.kind === "wholeRaster") return Promise.resolve(createLayerStatistics(item));
        const result = createDeferred();
        reads.push({ item, area, signal, result });
        return result.promise;
    });
    await h.viewer.show(createRasterItem("bulk-first"));
    await h.viewer.show(createRasterItem("bulk-second"));
    await flushPromises();
    h.viewer.exploreAt({ lng: -74, lat: 41 });
    assert.equal(reads.length, 2);
    h.layerStackView.handlers.onAllVisibility(false);
    assert.ok(reads.every(read => read.signal.aborted));
    assert.deepEqual(h.controlsView.layerHistograms, []);
    assert.equal(h.controlsView.controlsVisible, false);
    for (const read of reads) read.result.resolve(createLayerStatistics(read.item, read.area.selectedBounds));
    await flushPromises();
    assert.equal(reads.length, 2, "No additional requests for hidden layers");
    assert.deepEqual(h.controlsView.layerHistograms, [], "Late results cannot reopen hidden histograms");
    h.layerStackView.handlers.onAllVisibility(true);
    await flushPromises();
    for (let i = 2; i <= 3; i++) {
        assert.equal(reads.length, 4);
        reads[i].result.resolve(createLayerStatistics(reads[i].item, reads[i].area.selectedBounds));
        await flushPromises();
    }
    assert.deepEqual(h.controlsView.layerHistograms.map(s => s.state), ["ready", "ready"]);
    h.destroy();
});

for (const outcome of ["result", "error"]) {
    test(`a removed raster's late statistics ${outcome} cannot replace its re-added analysis`, async () => {
        const reads = [];
        const h = visibleLayerFixture((item, area, signal) => {
            const pending = createDeferred();
            reads.push({ item, area, signal, pending });
            return pending.promise;
        });
        try {
            const item = createRasterItem("replaced-analysis");
            await h.viewer.show(item);
            h.viewer.remove(item);
            const obsoleteReads = [...reads];
            assert.ok(obsoleteReads.length > 0);
            assert.ok(obsoleteReads.every(read => read.signal.aborted));

            await h.viewer.show(item);
            const currentRead = reads.at(-1);
            assert.equal(obsoleteReads.includes(currentRead), false);
            assert.equal(currentRead.signal.aborted, false);
            const current = { ...createLayerStatistics(item), sampleMaximum: 777 };
            currentRead.pending.resolve(current);
            await flushPromises();
            assert.equal(h.controlsView.displayedStatistics, current);

            for (const read of obsoleteReads) {
                if (outcome === "error") read.pending.reject(new Error("Removed raster read failed"));
                else read.pending.resolve({ ...createLayerStatistics(item), sampleMaximum: -999 });
            }
            await flushPromises();
            assert.equal(h.controlsView.displayedStatistics, current);
            assert.equal(h.controlsView.statisticsRetryVisible, false);
            assert.doesNotMatch(h.controlsView.statisticsStatus, /Removed raster read failed/);
            assert.deepEqual(h.controlsView.layerHistograms.map(histogram => histogram.state), ["ready"]);
        } finally {
            h.destroy();
        }
    });
}


test("category code changes cancel stale statistics while label, color and opacity reuse area samples", async () => {
    const reads = [];
    const h = visibleLayerFixture((item, area, signal, _fetch, codes) => {
        const pending = createDeferred();
        reads.push({ item, area, signal, codes, pending });
        return codes ? pending.promise : Promise.resolve(createLayerStatistics(item));
    });
    const item = createRasterItem("category-areas");
    await h.viewer.show(item); await flushPromises();
    const record = h.mapLayers.retainedRecords[0];
    editCategoricalAppearance(h, record.entry.key);
    const first = reads.at(-1);
    assert.deepEqual([...first.codes].sort((a, b) => a - b), [-1, 0, 41]);
    const edited = categoricalAppearance();
    edited.categories[0] = { ...edited.categories[0], label: "Updated forest", color: "#123456", opacity: 0.2 };
    editCategoricalAppearance(h, record.entry.key, edited);
    assert.equal(reads.at(-1), first, "appearance-only edit does not restart pending numeric work");
    edited.categories[0].value = 42;
    editCategoricalAppearance(h, record.entry.key, edited);
    const second = reads.at(-1);
    assert.equal(first.signal.aborted, true);
    first.pending.resolve(createCategoryStatistics(item, null, first.codes));
    second.pending.resolve(createCategoryStatistics(item, null, second.codes));
    await flushPromises();
    const chart = h.controlsView.layerHistograms[0].categorical;
    assert.equal(chart.rows.find(row => row.code === 42).opacity, 0.2);
    assert.equal(chart.rows.find(row => row.code === 42).color, "#123456");
    assert.equal(chart.rows.some(row => row.code === 41), false);
    const count = reads.length;
    edited.categories[0].label = "Final forest";
    editCategoricalAppearance(h, record.entry.key, edited);
    await flushPromises();
    assert.equal(reads.length, count);
    assert.equal(h.controlsView.layerHistograms[0].categorical.rows.find(row => row.code === 42).label, "Final forest");
    h.destroy();
});


/** Connect result ownership to the ordinary map and raster controllers.
 * @param {Object} [dependencies={}] Raster transport overrides.
 * @return {Object} Real controllers with an authorized result and cleanup helper.
 */
function resultLayerFixture(dependencies = {}) {
    const artifacts = fileManifest(), run = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    const file = artifacts.files[0];
    let owner;
    const h = visibleLayerFixture(undefined, {
        publishRaster: async raster => ({layerName: `eolab:result_${raster.source.artifactId}`, bbox: raster.bbox}),
        ...dependencies,
    }, {}, {restoreRemovedLayer: (snapshot, isCurrent) => owner.restore(snapshot, isCurrent)});
    const api = {getJob: async () => run, readJobStatuses: async () => ({jobs: [run], unavailableJobIds: []})};
    owner = new ModelOutputLayers({api, clock: {setTimeout() {}, clearTimeout() {}},
        describe: async source => ({source, version: file.sha256, bounds: [77,20,79,24],
            capabilities: {pixels: {supported: true}, statistics: {supported: true}}}),
        addRaster: (raster, lifecycle, presentation) => h.viewer.showSource(raster, lifecycle, presentation),
        updateLayer: (key, presentation) => h.mapLayers.updateLocalPresentation(key, presentation),
        removeLayer: key => h.mapLayers.removeKey(key), onChange() {}, openRun() {}});
    return {...h, owner, api, run, file, destroy() {owner.destroy(); h.destroy();}};
}

test("result views share an artifact while style, visibility, name, order and Undo remain independent", async () => {
    const h = resultLayerFixture();
    await h.owner.show(h.run, h.file);
    const originalKey = artifactLayerKey(h.run.jobId, h.file.artifactId);
    const original = h.mapLayers.getRecord(originalKey);
    const originalStyle = original.adapter.exportSavedState(original);
    assert.equal(h.mapLayers.snapshots()[0].canAddView, true);
    const copyKey = await h.mapLayers.addAnotherView(originalKey);
    const copy = h.mapLayers.getRecord(copyKey);
    assert.notEqual(copyKey, originalKey);
    assert.deepEqual(copy.state.source, original.state.source);
    assert.equal(copy.state.layer.wmsParams.layers, original.state.layer.wmsParams.layers);
    editCategoricalAppearance(h, copyKey);
    h.mapLayers.setOpacity(copyKey, 0.4);
    h.mapLayers.setVisible(copyKey, false);
    h.mapLayers.renameLayer(copyKey, "Comparison");
    h.mapLayers.reorder(copyKey, 0);
    const copyStyle = copy.adapter.exportSavedState(copy);
    assert.deepEqual(original.adapter.exportSavedState(original), originalStyle);
    assert.notEqual(copy.state.layer.wmsParams.raster_style, original.state.layer.wmsParams.raster_style);
    assert.equal(original.entry.opacity, 1);
    assert.equal(original.entry.visible, true);
    assert.equal(original.entry.label, h.file.displayName);
    assert.equal(h.mapLayers.snapshots()[0].key, copyKey);

    const main = readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
    const exportSource = main.match(/exportAnnotation: (record => \{[\s\S]*?\n        \}),\r?\n        restoreAnnotation:/)[1];
    const exportAnnotation = new Function("outputLayers", "vectorMapLayerAdapter", "annotationSessions", `return ${exportSource}`)(
        h.owner, {}, {getMapReference() {assert.fail("A private result must not be exported as shared polygons");}});
    assert.equal(exportAnnotation(original), null);
    assert.equal(exportAnnotation(copy), null);
    assert.equal(h.viewer.exportTemporal(copy), null);

    h.mapLayers.removeWithUndo(copyKey);
    assert.equal(h.owner.state(h.run.jobId, h.file.artifactId, h.file).onMap, true);
    assert.equal(h.owner.ownsLayer(copyKey), false);
    await h.mapLayers.undoLayerRemoval();
    const restored = h.mapLayers.getRecord(copyKey);
    assert.deepEqual(restored.adapter.exportSavedState(restored), copyStyle);
    assert.equal(restored.entry.opacity, 0.4);
    assert.equal(restored.entry.visible, false);
    assert.equal(restored.entry.label, "Comparison");
    h.mapLayers.removeKey(originalKey);
    await h.owner.show(h.run, h.file);
    assert.equal(h.mapLayers.snapshots().length, 1, "Show on map recognizes the remaining view");
    assert.equal(h.owner.state(h.run.jobId, h.file.artifactId, h.file).onMap, true);
    assert.equal(h.run.artifacts.files.length, 3);
    h.destroy();
});

test("expiry, run deletion, artifact removal and loss of access remove every result view", async t => {
    for (const reason of ["expiry", "deletion", "artifact", "access"]) await t.test(reason, async () => {
        const h = resultLayerFixture();
        await h.owner.show(h.run, h.file);
        const key = artifactLayerKey(h.run.jobId, h.file.artifactId);
        await h.mapLayers.addAnotherView(key);
        assert.equal(h.mapLayers.snapshots().length, 2);
        if (reason === "access") h.api.readJobStatuses = async () => ({jobs: [], unavailableJobIds: [h.run.jobId]});
        else h.owner.updateRun({...h.run, updatedAt: "2099-01-01T00:00:00Z",
            ...(reason === "expiry" ? {expiresAt: "2000-01-01T00:00:00Z"} :
                reason === "deletion" ? {status: "deleted", artifacts: null} : {artifacts: {...h.run.artifacts, files: []}})});
        if (reason === "access") await h.owner.refreshAvailability();
        assert.equal(h.mapLayers.snapshots().length, 0);
        assert.equal(h.owner.state(h.run.jobId, h.file.artifactId, h.file).onMap, false);
        assert.match(h.owner.state(h.run.jobId, h.file.artifactId, h.file).error, /no longer available/);
        h.destroy();
    });
});

test("private sources use the same style, histogram, percentile, pixel and paired controls as catalog rasters", async () => {
    const reads = [], pixels = [], paired = [];
    const clock = createManualClock();
    let removed = 0;
    const h = visibleLayerFixture(async (source, area, _signal, _fetch, codes) => {
        reads.push({source, area, codes});
        return createCategoryStatistics(source, selectedBoundsFromArea(area), codes);
    }, {clock, publishRaster: async item => ({layerName: item.source ? `eolab:model_${item.source.jobId}_${item.source.artifactId}` : "eolab:catalog", bbox: item.bbox ?? [77,20,79,24]}), sampleCursorPixel: async source => {pixels.push(source); return {inBounds: true, value: 0};},
        loadPairedStatistics: async (x, y) => {paired.push([x,y]); return pairedStatistics();}});
    const source = {kind: "runArtifact", jobId: "a".repeat(32), artifactId: "b".repeat(32)};
    const raster = {source, label: "Clipped habitat", bbox: [77,20,79,24], version: "c".repeat(64),
        group: {id: source.jobId, label: "My clip"}, capabilities: {pixels: true, statistics: true, calculations: true, modelInput: true}};
    const record = await h.viewer.showSource(raster, {removed() {removed++;}, info() {}, copy: appearance => ({kind: "test", source, appearance})});
    await flushPromises();
    assert.equal(record.entry.item, null); assert.deepEqual(h.mapLayers.snapshots()[0].source, source);
    assert.equal(h.viewer.openStyle(record.entry.key), true);
    h.viewer.exploreAt({lng: 78, lat: 22}); await flushPromises();
    assert.ok(reads.some(read => read.source.source?.jobId === source.jobId));
    h.leafletMap.emit("mousemove", {latlng: {lng: 78, lat: 22}, originalEvent: {clientX: 100, clientY: 100}});
    clock.flush(); await flushPromises();
    assert.ok(pixels.some(value => value.source?.jobId === source.jobId));
    editCategoricalAppearance(h, record.entry.key); await flushPromises();
    assert.ok(record.state.layer.wmsParams.raster_style);
    assert.equal(record.state.layer.wmsParams.env, undefined);
    assert.equal(record.state.layer.wmsParams.layers, `eolab:model_${source.jobId}_${source.artifactId}`);
    assert.ok(reads.some(read => read.codes?.includes(0)));
    assert.equal(h.mapLayers.snapshots()[0].legend.kind, "categories");
    h.controlsView.handlers.onAppearanceModeChange("continuous"); await flushPromises();
    h.controlsView.handlers.onHistogramPercentiles(record.entry.key, {lower: 10, middle: 50, upper: 90, rescale: false});
    assert.ok(record.state.layer.wmsParams.env);
    assert.equal(record.state.layer.wmsParams.raster_style, undefined);
    const continuousEnvironment = record.state.layer.wmsParams.env;
    await h.viewer.show(createRasterItem("private-pair")); await flushPromises();
    h.controlsView.handlers.onBivariateModeChange("bivariate"); await flushPromises();
    assert.ok(paired.some(pair => pair.some(item => item.source?.jobId === source.jobId)));
    h.controlsView.handlers.onBivariateModeChange("overlay");
    assert.equal(record.state.layer.wmsParams.env, continuousEnvironment);
    assert.equal(record.state.layer.wmsParams.raster_style, undefined);
    const appearance = record.adapter.exportSavedState(record);
    const copy = record.adapter.copyLayerForUndo(record);
    assert.deepEqual(copy.appearance, appearance);
    h.mapLayers.removeKey(record.entry.key);
    assert.equal(removed, 1); h.destroy();
});

test("pixel-capable outputs remain pickable when their format cannot provide distributions", async () => {
    const pixels=[], clock=createManualClock();
    const h=visibleLayerFixture(async () => {throw new Error("Distributions are unsupported");}, {
        clock, publishRaster: async item => ({layerName: "eolab:output", bbox: item.bbox}), sampleCursorPixel: async item => {pixels.push(item);return {inBounds:true,value:0};}});
    const raster={source:{kind:"runArtifact",jobId:"a".repeat(32),artifactId:"b".repeat(32)},label:"Pixel-only raster",
        version:"c".repeat(64),bbox:[77,20,79,24],capabilities:{pixels:true,statistics:false,calculations:true,modelInput:true}};
    await h.viewer.showSource(raster,{removed(){},copy(){},info(){}});
    h.leafletMap.emit("mousemove", {latlng:{lng:78,lat:22}, originalEvent:{clientX:100,clientY:100}});
    clock.flush(); await flushPromises();
    assert.ok(pixels.some(item=>item.source?.artifactId===raster.source.artifactId));h.destroy();
});


test("an obsolete output publication never attaches a WMS layer", async () => {
    let complete;
    const h=visibleLayerFixture(async () => RASTER_STATISTICS, {publishRaster: () => new Promise(resolve => {complete=resolve;})});
    const raster={source:{kind:"runArtifact",jobId:"a".repeat(32),artifactId:"b".repeat(32)},label:"Output",bbox:[77,20,79,24]};
    const abort=new AbortController();
    const pending=h.viewer.showSource(raster,{}, {signal:abort.signal});
    abort.abort(); complete({layerName:"eolab:output",bbox:raster.bbox});
    assert.equal(await pending,null); assert.equal(h.mapLayers.snapshots().length,0); h.destroy();
});

test("updating output names preserves raster rendering and custom labels", async () => {
    let finish;
    const reads = [];
    const h = visibleLayerFixture(async source => { reads.push(source); return RASTER_STATISTICS; }, {
        publishRaster: () => new Promise(resolve => { finish = resolve; })});
    const raster = {source: {kind: "runArtifact", jobId: "a".repeat(32), artifactId: "b".repeat(32)},
        label: "Original output", bbox: [77,20,79,24], group: {id: "run", label: "Original run"}};
    const presentation = {label: "Output · First run", sourceName: "Output · First run", group: {id: "run", label: "First run"}};
    const pending = h.viewer.showSource(raster, {removed() {}, copy() {}, info() {}}, presentation);
    finish({layerName: "eolab:output", bbox: raster.bbox});
    const record = await pending;
    await flushPromises();
    assert.equal(record.entry.label, presentation.label);
    assert.equal(h.mapLayers.snapshots()[0].group.label, "First run");
    const layer = record.state.layer;
    const readCount = reads.length;
    h.mapLayers.updateLocalPresentation(record.entry.key, {sourceName: "Output · Latest run", group: {id: "run", label: "Latest run"}});
    await flushPromises();
    assert.equal(record.state.label, "Output · Latest run");
    assert.equal(record.state.layer, layer);
    assert.equal(reads.length, readCount);
    h.mapLayers.renameLayer(record.entry.key, "My output");
    h.mapLayers.updateLocalPresentation(record.entry.key, {sourceName: "Output · Final run", group: {id: "run", label: "Final run"}});
    assert.equal(record.state.label, "My output");
    assert.equal(h.mapLayers.snapshots()[0].group.label, "Final run");
    h.destroy();
});

/** Build a temporal Item with two variables whose values have different units.
 * @return {Object} Admitted public Catalog metadata.
 */
function temporalItem() {
    return {collection: "eolab-temporal-datasets", id: "weather", bbox: [-180, -90, 180, 90], properties: {
        title: "Weather", "cube:variables": {temperature: {description: "Temperature", unit: "K"}, rain: {description: "Rain", unit: "m"}},
        "cube:dimensions": {time: {extent: ["2020-01-01T00:00:00Z", "2020-01-01T02:00:00Z"]}},
    }};
}

/** Exercise temporal rows through the real retained-layer and analysis owners.
 * @param {Object} [dependencies={}] Boundary replacements for the tested behavior.
 * @return {Object} Ordinary viewer fixture plus captured temporal controls.
 */
function temporalFixture(dependencies = {}) {
    const temporalViews = [];
    let restoreTemporal;
    const fixture = visibleLayerFixture(undefined, {
        loadTimes: async () => ({months: ["2020-01"], month: "2020-01", times: ["2020-01-01T00:00:00Z", "2020-01-01T02:00:00Z"]}),
        getTemporalItem: async () => temporalItem(),
        temporalControlsFactory: handlers => {
            const view = {element: {}, handlers, render(value) { this.state = value; }, destroy() {this.destroyed = true;}};
            temporalViews.push(view);
            return view;
        },
        publishRaster: async raster => ({layerName: `eolab:${raster.source.variable}-${raster.source.time}`, bbox: raster.bbox}),
        ...dependencies,
    }, {}, {restoreRemovedLayer: (snapshot, isCurrent) => restoreTemporal(snapshot, isCurrent)});
    const main = readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
    const restoreSource = main.slice(main.indexOf("async function restoreRemovedTemporal("),
        main.indexOf("savedMapViewController = new SavedMapViewController({"));
    restoreTemporal = new Function("catalogItemClient", "rasterVisualization", "mapLayerController",
        `${restoreSource}; return restoreRemovedTemporal;`)(
        {get: async () => temporalItem()}, fixture.viewer, fixture.mapLayers);
    return {...fixture, temporalViews};
}

test("automatic percentile rescaling drops a queued old timestamp and follows the new sample", async () => {
    const clock = createManualClock(), requests = [];
    const h = temporalFixture({clock, loadStatistics: (item, area, signal) => {
        if (item.source.time === "2020-01-01T00:00:00Z") return Promise.resolve(createLayerStatistics(item));
        const request = {...createDeferred(), item, area, signal}; requests.push(request); return request.promise;
    }});
    try {
        const record = await h.viewer.showTemporal(temporalItem()); await flushPromises();
        const original = {...record.state.rasterStyle};
        const settings = {lower: 10, middle: 40, upper: 90, rescale: true};
        h.controlsView.handlers.onHistogramPercentiles(record.entry.key, settings);
        assert.equal(clock.pending.size, 1);
        await h.temporalViews[0].handlers.onTimeChange("2020-01-01T02:00:00Z");
        clock.flush();
        assert.deepEqual(record.state.rasterStyle, original);
        assert.equal(h.controlsView.layerHistograms[0].canRescale, false);
        const current = requests.at(-1), statistics = createLayerStatistics(current.item);
        current.resolve(statistics); await flushPromises();
        assert.equal(clock.pending.size, 1);
        clock.flush();
        assert.deepEqual(record.state.rasterStyle, deriveRasterStyleFromStatistics(original, statistics, settings));
        h.controlsView.handlers.onHistogramPercentiles(record.entry.key, {...settings, middle: 60});
        assert.equal(clock.pending.size, 1);
    } finally { h.destroy(); assert.equal(clock.pending.size, 0); }
});

test("temporal time changes retain the row and style while late publication cannot replace the new frame", async () => {
    const requests = [];
    const fixture = temporalFixture({publishRaster: (raster, _fetch, signal) => {
        const deferred = createDeferred(); requests.push({raster, signal, ...deferred}); return deferred.promise;
    }});
    try {
        const first = fixture.viewer.showTemporal(temporalItem());
        await flushPromises();
        const record = fixture.mapLayers.retainedRecords[0];
        assert.equal(fixture.wmsLayers.length, 0, "pending row creates no WMS requests");
        assert.equal(record.state.item.source.time, "2020-01-01T00:00:00Z");
        assert.match(record.entry.label, /^Weather · Temperature · .*00:00 UTC$/);
        assert.equal(record.state.item.capabilities.statistics, true, "analysis does not wait for WMS");
        const appearance = structuredClone(record.adapter.exportSavedState(record));
        appearance.continuous.definition.minimum = -20;
        appearance.continuous.definition.midpoint = 0;
        appearance.continuous.definition.maximum = 20;
        appearance.continuous.styleWasEdited = true;
        record.adapter.applySavedState(record, appearance);
        fixture.mapLayers.setOpacity(record.entry.key, .45);
        const changed = fixture.temporalViews[0].handlers.onTimeChange("2020-01-01T02:00:00Z");
        assert.equal(requests[0].signal.aborted, true);
        requests[1].resolve({layerName: "eolab:new", bbox: record.state.item.bbox});
        await changed;
        requests[0].resolve({layerName: "eolab:old", bbox: record.state.item.bbox});
        await first;
        assert.equal(fixture.mapLayers.retainedRecords.length, 1);
        assert.equal(fixture.mapLayers.retainedRecords[0], record);
        assert.equal(record.publication.layerName, "eolab:new");
        assert.equal(record.entry.opacity, .45);
        assert.equal(record.state.rasterStyle.minimum, -20);
        assert.equal(record.state.rasterStyle.maximum, 20);
        assert.equal(fixture.viewer.exportTemporal(record).temporalSource.time, "2020-01-01T02:00:00Z");
    } finally {fixture.destroy();}
});

test("independent temporal views preserve explicit saved selections and reset ranges when units change", async () => {
    const fixture = temporalFixture();
    try {
        const first = await fixture.viewer.showTemporal(temporalItem());
        await flushPromises();
        const secondKey = await fixture.mapLayers.addAnotherView(first.entry.key);
        const second = fixture.mapLayers.getRecord(secondKey);
        assert.notEqual(first.entry.key, second.entry.key);
        assert.equal(fixture.mapLayers.retainedRecords.length, 2);
        await fixture.temporalViews[1].handlers.onTimeChange("2020-01-01T02:00:00Z");
        assert.equal(first.state.item.source.time, "2020-01-01T00:00:00Z");
        assert.equal(second.state.item.source.time, "2020-01-01T02:00:00Z");
        const saved = fixture.viewer.exportTemporal(second);
        const restoredKey = await fixture.viewer.restoreTemporal(saved, temporalItem(), () => true);
        assert.notEqual(restoredKey, second.entry.key);
        assert.equal(fixture.mapLayers.getRecord(restoredKey).state.item.source.time, saved.temporalSource.time);
        const appearance = structuredClone(first.adapter.exportSavedState(first));
        appearance.continuous.definition.minimum = 100;
        appearance.continuous.definition.midpoint = 200;
        appearance.continuous.definition.maximum = 300;
        appearance.continuous.styleWasEdited = true;
        first.adapter.applySavedState(first, appearance);
        await fixture.temporalViews[0].handlers.onVariableChange("rain");
        await flushPromises();
        assert.equal(first.state.item.source.variable, "rain");
        assert.equal(first.state.rasterStyleWasEdited, false);
        assert.notEqual(first.state.rasterStyle.minimum, 100);
        assert.equal(second.state.item.source.variable, "temperature");
        assert.equal(first.state.item.capabilities.calculations, true);
    } finally {fixture.destroy();}
});

test("refresh keeps a removed observation explicit and retry recovers publication without losing the row", async () => {
    let times = ["2020-01-01T00:00:00Z", "2020-01-01T02:00:00Z"];
    let failPublication = false;
    const fixture = temporalFixture({
        loadTimes: async () => ({months: ["2020-01"], month: "2020-01", times}),
        publishRaster: async raster => {
            if (failPublication) throw new Error("GeoServer unavailable");
            return {layerName: "eolab:frame", bbox: raster.bbox};
        },
    });
    try {
        const record = await fixture.viewer.showTemporal(temporalItem(), {variable: "temperature", time: times[1]});
        times = times.slice(0, 1);
        await fixture.viewer.refreshTemporalLayers();
        assert.equal(record.state.item.source.time, "2020-01-01T02:00:00Z");
        assert.equal(record.publication, null);
        assert.equal(record.state.item.capabilities.statistics, false);
        assert.match(fixture.temporalViews[0].state.error, /no longer available/);
        failPublication = true;
        await fixture.temporalViews[0].handlers.onTimeChange(times[0]);
        assert.equal(record.state.item.capabilities.statistics, true);
        assert.match(fixture.temporalViews[0].state.error, /GeoServer unavailable/);
        failPublication = false;
        await fixture.temporalViews[0].handlers.onRetry();
        assert.equal(record.publication.layerName, "eolab:frame");
        assert.equal(fixture.temporalViews[0].state.error, null);
    } finally {fixture.destroy();}
});

test("removing a temporal row cancels pending publication and cannot resurrect it", async () => {
    const publication = createDeferred();
    let signal;
    const fixture = temporalFixture({publishRaster: (_raster, _fetch, requestSignal) => {signal = requestSignal; return publication.promise;}});
    try {
        const shown = fixture.viewer.showTemporal(temporalItem());
        await flushPromises();
        fixture.viewer.removeTemporal(temporalItem());
        assert.equal(signal.aborted, true);
        publication.resolve({layerName: "eolab:late", bbox: [-180, -90, 180, 90]});
        assert.equal(await shown, null);
        assert.equal(fixture.mapLayers.retainedRecords.length, 0);
        assert.equal(fixture.temporalViews[0].destroyed, true);
    } finally {fixture.destroy();}
});


test("temporal source changes cancel old statistics and exact pixels before accepting new values", async () => {
    const statistics = [], pixels = [], cursorValues = [], clock = createManualClock();
    const fixture = temporalFixture({
        clock, cursorValuesView: {render: snapshot => cursorValues.push(snapshot), clear: () => cursorValues.push(null)},
        loadStatistics: (item, area, signal) => {const deferred = createDeferred(); statistics.push({item, area, signal, ...deferred}); return deferred.promise;},
        sampleCursorPixel: (item, _point, signal) => {const deferred = createDeferred(); pixels.push({item, signal, ...deferred}); return deferred.promise;},
    });
    try {
        const record = await fixture.viewer.showTemporal(temporalItem());
        fixture.viewer.exploreAt({lng: 1, lat: 1});
        fixture.leafletMap.emit("mousemove", {latlng:{lng:1,lat:1}, originalEvent:{clientX:100,clientY:100}});
        clock.flush();
        await flushPromises();
        const obsoleteStatistics = [...statistics], oldPixel = pixels[0];
        await fixture.temporalViews[0].handlers.onTimeChange("2020-01-01T02:00:00Z");
        const current = statistics.at(-1);
        assert.ok(obsoleteStatistics.every(request => request.signal.aborted));
        assert.equal(oldPixel.signal.aborted, true);
        assert.equal(current.item.source.time, "2020-01-01T02:00:00Z");
        current.resolve({...createLayerStatistics(current.item, selectedBoundsFromArea(current.area)), mean: 222});
        for (const request of obsoleteStatistics) request.resolve({...createLayerStatistics(request.item, selectedBoundsFromArea(request.area)), mean: 111});
        oldPixel.resolve({inBounds: true, value: 111});
        await flushPromises();
        assert.equal(record.state.analysis.rasterStatistics.mean, 222);
        assert.equal(cursorValues.at(-1), null);
        fixture.viewer.exploreAt({lng: 1, lat: 1});
        fixture.leafletMap.emit("mousemove", {latlng:{lng:1,lat:1}, originalEvent:{clientX:100,clientY:100}});
        clock.flush();
        await flushPromises();
        assert.equal(pixels.at(-1).item.source.time, "2020-01-01T02:00:00Z");
        pixels.at(-1).resolve({inBounds: true, value: 222});
        await flushPromises();
        assert.equal(cursorValues.at(-1).samples[0].value, 222);
    } finally {fixture.destroy();}
});

test("temporal timestamp changes preserve automatic ranges and refresh an active paired analysis", async () => {
    const paired = [];
    const fixture = temporalFixture({loadPairedStatistics: (xItem, yItem, _area, signal) => {
        const deferred = createDeferred(); paired.push({xItem, yItem, signal, ...deferred}); return deferred.promise;
    }});
    try {
        const first = await fixture.viewer.showTemporal(temporalItem());
        await fixture.viewer.showTemporal(temporalItem());
        await flushPromises();
        const range = {...first.state.rasterStyle};
        fixture.controlsView.handlers.onBivariateModeChange("bivariate");
        await flushPromises();
        assert.equal(paired.length, 1);
        await fixture.temporalViews[0].handlers.onTimeChange("2020-01-01T02:00:00Z");
        assert.equal(paired[0].signal.aborted, true);
        assert.equal(fixture.controlsView.bivariateMode.active, true);
        assert.equal(paired.length, 2);
        assert.equal(paired[1].yItem.source.time, "2020-01-01T02:00:00Z");
        const replacement = fixture.mapLayers.getLeafletLayer(first.entry.key);
        assert.equal(replacement.wmsParams.env, buildRasterStyleEnvironment(fixture.controlsView.bivariateMode.yStyle));
        assert.equal(replacement.opacity, 1);
        paired[1].resolve({...pairedStatistics(), marker: "current"});
        paired[0].resolve({...pairedStatistics(), marker: "obsolete"});
        await flushPromises();
        assert.equal(fixture.controlsView.pairedStatistics.marker, "current");
        assert.deepEqual(first.state.rasterStyle, range);
    } finally {fixture.destroy();}
});


test("temporal histogram and paired presentation offer ordinary Processing calculations", async () => {
    const fixture = temporalFixture({
        publishRaster: async item => ({layerName: `eolab:${item.id}`, bbox: [-180, -90, 180, 90]}),
        loadPairedStatistics: async () => pairedStatistics(),
    });
    try {
        const temporal = await fixture.viewer.showTemporal(temporalItem());
        await fixture.viewer.show(createRasterItem("ordinary"));
        await flushPromises();
        const summaries = fixture.controlsView.layerHistograms;
        assert.equal(summaries.find(summary => summary.key === temporal.entry.key).canCalculate, true);
        assert.equal(summaries.find(summary => summary.key !== temporal.entry.key).canCalculate, true);
        assert.equal(summaries.find(summary => summary.key === temporal.entry.key).state, "ready");
        fixture.controlsView.handlers.onBivariateModeChange("bivariate");
        await flushPromises();
        const {xItem, yItem} = fixture.controlsView.pairedPresentation;
        assert.equal([xItem, yItem].filter(item => item.capabilities?.calculations === false).length, 0);
    } finally { fixture.destroy(); }
});
