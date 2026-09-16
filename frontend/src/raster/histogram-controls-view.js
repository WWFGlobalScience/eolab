/**
 * DOM presentation adapter for raster histograms.
 *
 * This adapter owns the histogram region, status, chart, retry and
 * result visibility, and its direct listeners. The neutral SVG
 * construction functions remain in histogram-view.js; this class only
 * supplies their owned chart element and presents coordinator-provided state.
 */
import {
    clearRasterHistogramChart,
    renderRasterHistogramChart,
} from "./histogram-view.js";
import { HistogramAxisControls } from "./histogram-axis-controls.js";
import { requireRasterControl } from "./required-control.js";
import { formatRasterPixelValue } from "./value-format.js";

/**
 * @typedef {Object} RasterHistogramHandlers
 * @property {() => void} onRetryStatistics Retries raster statistics.
 * @property {(key: string) => void} onSelectHistogram Activates one retained
 * raster whose histogram summary was selected.
 * @property {(key: string) => void} onStyleHistogram Opens Style for one
 * retained raster represented by a histogram summary.
 * @property {(key:string)=>void} [onDownloadHistogram] Review a clip of this source and selection.
 */

/**
 * @typedef {Object} RasterHistogramSummary
 * @property {string} key Opaque retained-layer identity.
 * @property {string} label Readable raster basename.
 * @property {"idle"|"loading"|"ready"|"error"} state Statistics lifecycle.
 * @property {string} scope Readable geographic sampling scope.
 * @property {number[]|null} counts Histogram bin counts when ready.
 * @property {string} [errorMessage] Reason the current sample is unavailable.
 * @property {string} [valueLabel] X-axis name with explicit source units.
 */

/** Own direct DOM interaction and presentation for raster histograms. */
export class RasterHistogramControlsView {
    /**
     * Resolve the required histogram elements once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the controls and creates histogram SVG nodes.
     * @throws {Error} If any required histogram element is missing.
     */
    constructor(documentContext = globalThis.document) {
        this.documentContext = documentContext;
        this.histogram = requireRasterControl(
            documentContext,
            "#raster-histogram"
        );
        this.histogramScope = requireRasterControl(
            documentContext,
            "#raster-histogram-scope"
        );
        this.mapScope = requireRasterControl(documentContext, "#map-histogram-scope");
        this.histogramStatus = requireRasterControl(
            documentContext,
            "#raster-histogram-status"
        );
        this.histogramChart = requireRasterControl(
            documentContext,
            "#raster-histogram-chart"
        );
        this.retryStatisticsButton = requireRasterControl(
            documentContext,
            "#retry-raster-statistics"
        );
        this.histogramList = requireRasterControl(
            documentContext,
            "#raster-histogram-list"
        );
        this.histogramEmpty = requireRasterControl(
            documentContext,
            "#raster-histogram-empty"
        );
        this.histogramDetailLayer = requireRasterControl(
            documentContext,
            "#raster-histogram-detail-layer"
        );
        this.pointSamples = requireRasterControl(
            documentContext,
            "#raster-point-samples"
        );
        this.pointSampleList = requireRasterControl(
            documentContext,
            "#raster-point-sample-list"
        );
        this.summaryButtons = [];
        this.summaryCharts = [];
        this.axisStates = new Map();
        this.summaryAxisControls = [];
        this.detailAxisControls = null;
        this.detailAxesHost = documentContext.createElement("div");
        this.histogram.append(this.detailAxesHost);
        this.activeHistogramKey = null;
        this.handlers = null;
        this.boundRetryStatistics = this.#handleRetryStatistics.bind(this);
        this.isAvailable = false;
        this.modeIsCompatible = true;
    }

    /**
     * Attach direct histogram-control listeners to semantic handlers.
     *
     * @param {RasterHistogramHandlers} handlers Histogram event handlers.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        this.retryStatisticsButton.addEventListener(
            "click",
            this.boundRetryStatistics
        );
    }

    /** Remove every direct listener installed by {@link bind}. @return {void} */
    unbind() {
        this.retryStatisticsButton.removeEventListener(
            "click",
            this.boundRetryStatistics
        );
        this.#clearSummaryButtonListeners();
        this.#clearSummaryCharts();
        this.clearHistogram();
        this.axisStates.clear();
        this.handlers = null;
    }

    /**
     * Render one clearly labeled histogram summary for every retained raster.
     * Dynamic buttons own their direct listeners and are replaced atomically,
     * so repeated lifecycle renders cannot double-bind an action.
     *
     * @param {RasterHistogramSummary[]} summaries Presentation-ready summaries.
     * @param {string|null} activeKey Active retained raster key, or null when
     * analysis is detached from the layer stack.
     * @return {void}
     * @throws {TypeError} If a summary violates the view boundary contract.
     */
    renderLayerHistograms(summaries, activeKey) {
        if (!Array.isArray(summaries)) {
            throw new TypeError("Raster histogram summaries must be an array");
        }
        const focusedKey = this.summaryButtons.find(
            ({ button }) => button === this.documentContext.activeElement
        )?.key ?? null;
        this.#clearSummaryButtonListeners();
        this.#clearSummaryCharts();
        this.activeHistogramKey = activeKey;
        this.automatic = summaries.some((summary) => summary.automatic);
        this.histogram.hidden = !this.isAvailable || !this.modeIsCompatible || this.automatic;
        const buttons = summaries.map((summary) =>
            this.#createSummaryButton(summary)
        );
        this.histogramList.replaceChildren(...buttons);
        this.histogramEmpty.hidden = summaries.length > 0;
        this.#synchronizeSummaryExpansion();
        if (focusedKey !== null) {
            this.summaryButtons.find(({ key }) => key === focusedKey)
                ?.button.focus();
        }
    }

    /**
     * Render exact in-bounds raster values retained from one map click.
     *
     * @param {{position:Readonly<Object>,samples:ReadonlyArray<Object>}}
     * snapshot Immutable point-result snapshot from the raster owner.
     * @return {void}
     * @throws {TypeError} If result identity, axis, state, or value fields are
     * outside the closed presentation contract.
     */
    renderPointSamples(snapshot) {
        const allowedStates = new Set([
            "loading", "value", "nodata", "outside", "error",
        ]);
        if (
            snapshot === null ||
            typeof snapshot !== "object" ||
            !Array.isArray(snapshot.samples) ||
            snapshot.samples.length === 0 ||
            snapshot.samples.some((sample) => (
                sample === null ||
                typeof sample !== "object" ||
                typeof sample.key !== "string" ||
                sample.key === "" ||
                typeof sample.label !== "string" ||
                sample.label === "" ||
                ![null, "X", "Y"].includes(sample.axis) ||
                !allowedStates.has(sample.state) ||
                (sample.state === "value" && !Number.isFinite(sample.value)) ||
                (sample.state !== "value" && sample.value !== null) ||
                typeof sample.errorMessage !== "string"
            ))
        ) {
            throw new TypeError("Raster point-sample snapshot is invalid");
        }
        const samples = snapshot.samples.filter(
            (sample) => sample.state !== "outside"
        );
        if (samples.length === 0) {
            this.clearPointSamples();
            return;
        }
        const rows = samples.map((sample) => {
            const row = this.documentContext.createElement("div");
            row.className = "raster-point-sample-row";
            row.setAttribute("data-state", sample.state);
            const name = this.documentContext.createElement("dt");
            name.className = "raster-point-sample-name";
            if (sample.axis !== null) {
                const badge = this.documentContext.createElement("span");
                badge.className = "raster-point-sample-axis";
                badge.textContent = sample.axis;
                name.append(badge);
            }
            const label = this.documentContext.createElement("span");
            label.textContent = sample.label;
            label.title = sample.label;
            name.append(label);
            const value = this.documentContext.createElement("dd");
            value.className = "raster-point-sample-value";
            value.textContent = {
                loading: "Reading…",
                value: sample.state === "value"
                    ? formatRasterPixelValue(sample.value)
                    : "",
                nodata: "No data",
                error: sample.errorMessage === ""
                    ? "Unavailable"
                    : `Unavailable: ${sample.errorMessage}`,
            }[sample.state];
            row.append(name, value);
            return row;
        });
        this.pointSampleList.replaceChildren(...rows);
        this.pointSamples.hidden = false;
        this.pointSamples.setAttribute(
            "aria-busy",
            String(samples.some((sample) => sample.state === "loading"))
        );
    }

    /** Hide and remove exact values from the previous map click. @return {void} */
    clearPointSamples() {
        this.pointSampleList.replaceChildren();
        this.pointSamples.hidden = true;
        this.pointSamples.setAttribute("aria-busy", "false");
    }

    /**
     * Identify the raster represented by the detailed histogram.
     *
     * @param {string} label Readable raster label.
     * @return {void}
     */
    setActiveLayer(label) {
        this.histogramDetailLayer.textContent = label;
        this.histogramDetailLayer.title = label;
    }

    /**
     * Show the detailed histogram for an active raster, or hide it when no
     * raster owns the controls.
     *
     * @param {boolean} isAvailable Whether an active raster can own a result.
     * @return {void}
     */
    setActiveRasterAvailable(isAvailable) {
        this.isAvailable = isAvailable;
        const isVisible = isAvailable && this.modeIsCompatible && !this.automatic;
        this.histogram.hidden = !isVisible;
        this.histogram.setAttribute("aria-hidden", String(!isVisible));
        this.#synchronizeSummaryExpansion();
    }

    /**
     * Set whether the active comparison mode accepts a univariate histogram.
     *
     * @param {boolean} isCompatible Whether the detailed histogram may show.
     * @return {void}
     */
    setModeCompatible(isCompatible) {
        this.modeIsCompatible = isCompatible;
        // In 1D each layer labels its own scope; only 2D has one shared scope.
        this.mapScope.hidden = isCompatible;
        this.histogramList.hidden = !isCompatible;
        const isVisible = isCompatible && this.isAvailable && !this.automatic;
        this.histogram.hidden = !isVisible;
        this.histogram.setAttribute("aria-hidden", String(!isVisible));
        this.#synchronizeSummaryExpansion();
    }

    /**
     * Reveal the contextual histogram. By default this preserves focus on the
     * action that initiated sampling; callers may instead focus the chart.
     * The composition root reveals the map-side panel; this adapter must not
     * scroll the page or any sidebar when a map sample completes.
     *
     * @param {boolean} [moveFocus=false] Whether to focus the chart.
     * @return {void}
     */
    showWidget(moveFocus = false) {
        if (!this.isAvailable || !this.modeIsCompatible || this.automatic) {
            return;
        }
        this.histogram.hidden = false;
        this.histogram.setAttribute("aria-hidden", "false");
        this.#synchronizeSummaryExpansion();
        if (moveFocus) {
            this.histogramChart.focus?.();
        }
    }

    /**
     * Hide the histogram presentation while retaining its current result.
     *
     * @return {void}
     */
    hideWidget() {
        this.histogram.hidden = true;
        this.histogram.setAttribute("aria-hidden", "true");
        this.#synchronizeSummaryExpansion();
    }

    /**
     * Label the histogram with the geographic area that produced it.
     * Matching map-overlay and widget colors provide the visual connection.
     *
     * @param {"none"|"wholeRaster"|"selectedArea"|"catalogSelection"|"vector"} mode
     * Active sampling-area discriminator.
     * @param {string} [label=""] Optional semantic sampling-area description.
     * @return {void}
     * @throws {TypeError} If the mode is outside the sampling-area contract.
     */
    setSamplingAreaMode(mode, label = "") {
        const labels = {
            none: "No sampled area",
            wholeRaster: "Whole raster",
            selectedArea: "Map sample",
            catalogSelection: "Historical polygon selection",
            vector: "Vector selection"
        };
        if (!(mode in labels)) {
            throw new TypeError(`Unsupported histogram sampling area: ${mode}`);
        }
        this.histogram.setAttribute("data-sampling-area", mode);
        this.histogramScope.textContent = label || labels[mode];
        this.mapScope.textContent = label || labels[mode];
    }

    /** Enable statistics retry for an active raster. @return {void} */
    enableActiveRasterActions() {
        this.retryStatisticsButton.disabled = false;
    }

    /** Remove histogram content and hide result-only controls. @return {void} */
    clearStatistics() {
        this.histogram.setAttribute("aria-busy", "false");
        this.histogramStatus.textContent = "";
        this.clearHistogram();
        this.retryStatisticsButton.hidden = true;
    }

    /**
     * Set whether the statistics region is awaiting a response.
     *
     * @param {boolean} isBusy Whether statistics are loading.
     * @return {void}
     */
    setStatisticsBusy(isBusy) {
        this.detailAxisControls?.setEnabled(!isBusy);
        this.histogram.setAttribute("aria-busy", String(isBusy));
    }

    /**
     * Replace the current user-facing statistics status.
     *
     * @param {string} message Statistics status message.
     * @return {void}
     */
    setStatisticsStatus(message) {
        this.histogramStatus.textContent = message;
    }

    /**
     * Render the fixed-bin histogram using the committed raster style.
     *
     * @param {Object} statistics Validated raster statistics.
     * @param {Object} style Committed raster style.
     * @param {string} [valueLabel="Raster value"] Axis label with known units.
     * @return {void}
     */
    renderHistogram(statistics, style, valueLabel = "Raster value") {
        this.detailAxisControls?.dispose();
        const key = JSON.stringify([statistics.collectionId, statistics.itemId]);
        this.detailAxisControls = this.#axisControls(key, this.histogramChart, statistics, style, valueLabel);
        this.detailAxesHost.replaceChildren(this.detailAxisControls.root);
    }

    /** Hide and empty the fixed-bin histogram chart. @return {void} */
    clearHistogram() {
        this.detailAxisControls?.dispose();
        this.detailAxisControls = null;
        this.detailAxesHost.replaceChildren();
        clearRasterHistogramChart(this.histogramChart);
    }

    /**
     * Set whether the statistics retry action is available.
     *
     * @param {boolean} isVisible Whether the retry action should be visible.
     * @return {void}
     */
    setStatisticsRetryVisible(isVisible) {
        this.retryStatisticsButton.hidden = !isVisible;
    }

    /**
     * Construct a chart-first raster summary with sampling context underneath.
     *
     * @param {RasterHistogramSummary} summary Validated view model.
     * @return {HTMLElement} Automatic chart article or bound summary button.
     * @throws {TypeError} If required identity or presentation fields are bad.
     */
    #createSummaryButton(summary) {
        const allowedStates = new Set(["idle", "loading", "ready", "error"]);
        if (
            summary === null ||
            typeof summary !== "object" ||
            typeof summary.key !== "string" ||
            summary.key === "" ||
            typeof summary.label !== "string" ||
            summary.label === "" ||
            typeof summary.scope !== "string" ||
            summary.scope === "" ||
            !allowedStates.has(summary.state) ||
            !(
                summary.counts === null ||
                (
                    Array.isArray(summary.counts) &&
                    summary.counts.every(
                        (count) => Number.isFinite(count) && count >= 0
                    )
                )
            )
        ) {
            throw new TypeError("Raster histogram summary is invalid");
        }
        const container = this.documentContext.createElement("article");
        container.className = "raster-histogram-summary";
        container.setAttribute("aria-label", `Histogram — ${summary.label}`);
        const content = summary.automatic
            ? container
            : this.documentContext.createElement("button");
        if (!summary.automatic) {
            content.type = "button";
            content.className = "raster-histogram-summary-select";
            content.setAttribute("aria-controls", "raster-histogram");
            content.setAttribute("aria-expanded", "false");
            content.setAttribute(
                "aria-label",
                `Show detailed histogram for ${summary.label}`
            );
            container.append(content);
        }

        const name = this.documentContext.createElement("span");
        name.className = "raster-histogram-summary-name";
        name.textContent = summary.label;
        name.title = summary.label;
        const scope = this.documentContext.createElement("span");
        scope.className = "raster-histogram-summary-scope";
        scope.textContent = summary.scope;
        const status = this.documentContext.createElement("span");
        status.className = "raster-histogram-summary-status";
        status.setAttribute("role", "status");
        status.textContent = {
            idle: "Waiting for histogram",
            loading: "Updating histogram…",
            ready: "",
            error: summary.errorMessage
                ? `Histogram unavailable: ${summary.errorMessage}`
                : "Histogram unavailable",
        }[summary.state];
        status.hidden = summary.state === "ready";
        content.append(name, status);
        if (summary.automatic && summary.state === "ready" && summary.statistics) {
            const chart = this.documentContext.createElementNS(
                "http://www.w3.org/2000/svg", "svg"
            );
            chart.classList.add("raster-histogram-chart");
            const controls = this.#axisControls(summary.key, chart, summary.statistics, summary.style, summary.valueLabel);
            this.summaryAxisControls.push(controls);
            this.summaryCharts.push(chart);
            content.append(chart, controls.root);
        } else if (summary.state === "ready" && summary.counts !== null && summary.counts.length > 0) {
            content.append(this.#createSummaryPreview(summary));
        }
        content.append(scope);
        const actions = this.documentContext.createElement("div");
        actions.className = "raster-histogram-summary-actions";
        const style = this.documentContext.createElement("button");
        style.type = "button";
        style.className = "secondary-button";
        style.textContent = "Style this raster";
        style.setAttribute("aria-controls", "layer-style-editor");
        style.setAttribute("aria-label", `Style ${summary.label}`);
        style.addEventListener("click", () =>
            this.handlers?.onStyleHistogram(summary.key)
        );
        actions.append(style);
        const download = this.documentContext.createElement("button");
        download.type = "button";
        download.className = "secondary-button raster-histogram-download";
        download.title = "Download clip";
        const downloadIcon = this.documentContext.createElementNS("http://www.w3.org/2000/svg", "svg");
        downloadIcon.setAttribute("viewBox", "0 0 24 24");
        downloadIcon.setAttribute("width", "16");
        downloadIcon.setAttribute("height", "16");
        downloadIcon.setAttribute("aria-hidden", "true");
        downloadIcon.setAttribute("focusable", "false");
        const downloadPath = this.documentContext.createElementNS("http://www.w3.org/2000/svg", "path");
        downloadPath.setAttribute("d", "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5");
        downloadPath.setAttribute("fill", "none");
        downloadPath.setAttribute("stroke", "currentColor");
        downloadPath.setAttribute("stroke-width", "1.75");
        downloadPath.setAttribute("stroke-linecap", "round");
        downloadPath.setAttribute("stroke-linejoin", "round");
        downloadIcon.append(downloadPath);
        download.append(downloadIcon);
        download.setAttribute("aria-label", `Download clip of ${summary.label}`);
        download.addEventListener("click", () => this.handlers?.onDownloadHistogram?.(summary.key));
        const calculate = this.documentContext.createElement("button");
        calculate.type = "button";
        calculate.className = "secondary-button";
        calculate.textContent = "Summarize this area";
        calculate.setAttribute("aria-label", "Summarize " + summary.label + " over this area");
        calculate.addEventListener("click", () => this.handlers?.onCalculateHistogram?.(summary.key));
        actions.append(calculate, download);
        if (summary.automatic) {
            if (summary.canRetry) {
                const retry = this.documentContext.createElement("button");
                retry.type = "button";
                retry.className = "secondary-button";
                retry.textContent = "Retry histogram";
                retry.setAttribute("aria-label", `Retry histogram for ${summary.label}`);
                retry.addEventListener("click", () =>
                    this.handlers?.onRetryHistogram(summary.key)
                );
                actions.append(retry);
            }
            container.append(actions);
            return container;
        }
        const handleSelect = () => {
            this.handlers?.onSelectHistogram(summary.key);
        };
        content.addEventListener("click", handleSelect);
        this.summaryButtons.push({
            button: content,
            handleSelect,
            key: summary.key,
        });
        container.append(actions);
        return container;
    }

    /**
     * Draw a compact, non-interactive bar preview for one summary.
     *
     * @param {RasterHistogramSummary} summary Ready histogram summary.
     * @return {SVGElement} Accessible-hidden preview SVG.
     */
    #createSummaryPreview(summary) {
        const preview = this.documentContext.createElementNS(
            "http://www.w3.org/2000/svg",
            "svg"
        );
        preview.classList.add("raster-histogram-summary-preview");
        preview.setAttribute("viewBox", `0 0 ${summary.counts.length} 24`);
        preview.setAttribute("preserveAspectRatio", "none");
        preview.setAttribute("aria-hidden", "true");
        const maximum = Math.max(...summary.counts, 1);
        for (const [index, count] of summary.counts.entries()) {
            const height = 22 * count / maximum;
            const bar = this.documentContext.createElementNS(
                "http://www.w3.org/2000/svg",
                "rect"
            );
            bar.setAttribute("x", String(index));
            bar.setAttribute("y", String(23 - height));
            bar.setAttribute("width", "0.8");
            bar.setAttribute("height", String(height));
            preview.append(bar);
        }
        return preview;
    }

    /**
     * Create a display-only editor retaining settings for this histogram identity.
     * @param {string} key Chart identity.
     * @param {SVGSVGElement} chart Target SVG.
     * @param {Object} statistics Validated sample.
     * @param {Object} style Committed raster style.
     * @param {string} valueLabel Value-axis units.
     * @return {HistogramAxisControls} Editor owning only local redraws.
     */
    #axisControls(key, chart, statistics, style, valueLabel = "Raster value") {
        if (!this.axisStates.has(key)) this.axisStates.set(key, {});
        const distribution = { ...statistics.histogram, total: statistics.validSampleCount };
        const draw = axes => renderRasterHistogramChart(
            chart, statistics, style, this.documentContext, valueLabel, [], axes,
        );
        const controls = new HistogramAxisControls(this.documentContext, [
            { ...distribution, key: "x", label: valueLabel },
            { ...distribution, key: "y", label: "Bar height (% of pixels)", frequency: true, nice: true },
        ], this.axisStates.get(key), draw);
        draw(controls.axes);
        return controls;
    }

    /** Release resize observers before replacing dynamic charts. @return {void} */
    #clearSummaryCharts() {
        for (const controls of this.summaryAxisControls) controls.dispose();
        this.summaryAxisControls = [];
        for (const chart of this.summaryCharts) clearRasterHistogramChart(chart);
        this.summaryCharts = [];
    }

    /** Remove listeners owned by superseded summary buttons. @return {void} */
    #clearSummaryButtonListeners() {
        for (const { button, handleSelect } of this.summaryButtons) {
            button.removeEventListener("click", handleSelect);
        }
        this.summaryButtons = [];
    }

    /** Synchronize active-summary disclosure state. @return {void} */
    #synchronizeSummaryExpansion() {
        for (const { button, key } of this.summaryButtons) {
            button.setAttribute(
                "aria-expanded",
                String(key === this.activeHistogramKey && !this.histogram.hidden)
            );
        }
    }

    /** Forward the retry-statistics action. @return {void} */
    #handleRetryStatistics() {
        this.handlers.onRetryStatistics();
    }

}
