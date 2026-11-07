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
import { createCategoricalRasterHistogram } from "./categorical-histogram-view.js";
import { HistogramAxisControls } from "./histogram-axis-controls.js";
import { RasterPercentileControlsView } from "./percentile-controls-view.js";
import { requireRasterControl } from "./required-control.js";

/**
 * @typedef {Object} RasterHistogramHandlers
 * @property {() => void} onRetryStatistics Retries raster statistics.
 * @property {(key: string) => void} onSelectHistogram Activates one retained
 * raster whose histogram summary was selected.
 * @property {(key: string) => void} onStyleHistogram Opens Style for one
 * retained raster represented by a histogram summary.
 * @property {(key:string)=>void} [onDownloadHistogram] Review a clip of this source and selection.
 * @property {(key:string)=>void} [onCalculateHistogram] Open statistics for this raster and area.
 * @property {(key:string)=>void} [onRetryHistogram] Retry this raster's histogram.
 * @property {(key:string,settings:import("./percentile-controls-view.js").HistogramPercentileSettings)=>void}
 * onHistogramPercentiles Update this view's percentile inspection and rescale choice.
 */

/**
 * @typedef {Object} RasterHistogramSummary
 * @property {string} key Opaque retained-layer identity.
 * @property {string} label Readable raster basename.
 * @property {"idle"|"loading"|"ready"|"error"} state Statistics lifecycle.
 * @property {number[]|null} counts Histogram bin counts when ready.
 * @property {string} [errorMessage] Reason the current sample is unavailable.
 * @property {string} [unavailableMessage] Presentation-only explanation replacing
 * the continuous chart, axes, and bin preview without changing statistics state.
 * @property {string} [valueLabel] X-axis name with explicit source units.
 * @property {import("./categorical-presentation.js").CategoricalAreaPresentation|null} [categorical] Prepared category rows.
 * @property {boolean} [automatic] Show the full chart within this card.
 * @property {Object|null} [statistics] Validated statistics for the full chart.
 * @property {Object} [style] Committed continuous raster style.
 * @property {boolean} [canRetry] Offer retry after a recoverable failure.
 * @property {boolean} canCalculate Offer Processing statistics and download actions for this source.
 * @property {import("./percentile-controls-view.js").HistogramPercentileSettings} [percentileSettings] Continuous histogram inspection settings.
 * @property {boolean} canRescale Whether this result may set this view's colors.
 * @property {string} percentileMessage Reason rescaling is unavailable, or empty text.
 */

/**
 * @typedef {Object} HistogramSummaryCard
 * @property {string} key Raster identity.
 * @property {string} signature Serialized presentation last rendered in the card.
 * @property {HTMLElement} root Article owning the chart and actions.
 * @property {HTMLButtonElement|null} button Optional detailed-histogram selection button.
 * @property {SVGSVGElement|null} chart Continuous chart with a resize observer.
 * @property {HistogramAxisControls|null} axisControls Continuous chart's axis editor.
 * @property {RasterPercentileControlsView|null} percentileControls Continuous histogram's percentile controls.
 * @property {import("./style.js").RasterStyle|undefined} style Current continuous colors and thresholds.
 * @property {(()=>void)|null} redraw Redraw the chart without replacing its controls.
 * @property {Array<{button:HTMLButtonElement,handleClick:()=>void}>} listeners Owned action listeners.
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
        /** @type {Map<string, HistogramSummaryCard>} */
        this.summaryCards = new Map();
        this.axisStates = new Map();
        this.categoryExpansions = new Map();
        this.detailAxisControls = null;
        this.detailPercentileControls = null;
        this.detailPresentation = null;
        this.detailAxesHost = documentContext.createElement("div");
        this.histogram.append(this.detailAxesHost);
        this.categoryHost = documentContext.createElement("div");
        this.histogram.append(this.categoryHost);
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
        for (const card of this.summaryCards.values()) this.#disposeSummaryCard(card);
        this.summaryCards.clear();
        this.clearHistogram();
        this.axisStates.clear();
        this.categoryExpansions.clear();
        this.handlers = null;
    }

    /**
     * Replace changed samples and redraw style edits without replacing controls.
     * Compare presentation values because callers recreate summary objects. Move
     * only out-of-order cards; detaching unchanged inputs would lose browser focus.
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
        const signatures = new Map();
        for (const summary of summaries) {
            const signature = this.#serializeSummaryPresentation(summary);
            if (signatures.has(summary.key)) {
                throw new TypeError("Raster histogram summary keys must be unique");
            }
            signatures.set(summary.key, signature);
        }
        const focusedElement = this.documentContext.activeElement;
        const focusedCard = [...this.summaryCards.values()].find(card => card.root.contains(focusedElement));
        const focusedIndex = focusedCard ? Array.from(this.histogramList.children).indexOf(focusedCard.root) : -1;
        for (const [key, card] of this.summaryCards) {
            if (!signatures.has(key) || signatures.get(key) !== card.signature) {
                this.#disposeSummaryCard(card);
                this.summaryCards.delete(key);
            }
        }
        this.activeHistogramKey = activeKey;
        this.automatic = summaries.some((summary) => summary.automatic);
        this.histogram.hidden = !this.isAvailable || !this.modeIsCompatible || this.automatic;
        for (const [index, summary] of summaries.entries()) {
            let card = this.summaryCards.get(summary.key);
            if (!card) {
                card = this.#createSummaryCard(summary, signatures.get(summary.key));
                this.summaryCards.set(summary.key, card);
            } else {
                const redraw = JSON.stringify(card.style) !== JSON.stringify(summary.style) ||
                    JSON.stringify(card.percentileControls?.settings) !== JSON.stringify(summary.percentileSettings);
                card.style = summary.style;
                card.percentileControls?.render(summary.statistics, summary.style,
                    summary.percentileSettings, summary.canRescale, summary.percentileMessage);
                if (redraw) card.redraw?.();
            }
            const current = this.histogramList.children[index] ?? null;
            if (current !== card.root) this.histogramList.insertBefore(card.root, current);
        }
        this.histogramEmpty.hidden = summaries.length > 0;
        this.#synchronizeSummaryExpansion();
        if (focusedCard) {
            // Reordering can blur a retained input. Removal instead needs a
            // surviving card (or the empty message) as a keyboard destination.
            const target = this.histogramList.contains(focusedElement) ? focusedElement
                : this.summaryCards.get(focusedCard.key)?.root
                    ?? this.histogramList.children[Math.min(focusedIndex, summaries.length - 1)]
                    ?? this.histogramEmpty;
            if (target === this.histogramEmpty) target.setAttribute("tabindex", "-1");
            if (this.documentContext.activeElement !== target) target.focus({ preventScroll: true });
        }
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
     * Explain whether an empty histogram needs a vector area or visible rasters.
     *
     * @param {"none"|"wholeRaster"|"selectedArea"|"catalogSelection"|"polygonArea"|"vector"} mode
     * Active sampling-area discriminator.
     * @return {void}
     */
    setSamplingAreaMode(mode) {
        this.histogramEmpty.textContent = mode === "vector" && this.summaryCards.size === 0
            ? "No polygon sample area is available."
            : "No visible raster layers. Show a raster layer to see its histogram.";
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
     * @param {{key:string,settings:import("./percentile-controls-view.js").HistogramPercentileSettings,
     * canRescale:boolean,message:string}|null} [percentileContext=null] View identity and optional color-rescaling controls.
     * @return {void}
     */
    renderHistogram(statistics, style, valueLabel = "Raster value", percentileContext = null) {
        this.categoryHost.replaceChildren();
        this.histogramChart.hidden = false;
        const key = percentileContext?.key ?? JSON.stringify([statistics.collectionId, statistics.itemId]);
        const previous = this.detailPresentation;
        if (previous?.key === key && previous.statistics === statistics && previous.valueLabel === valueLabel &&
            Boolean(this.detailPercentileControls) === (percentileContext !== null)) {
            previous.style = style;
            this.detailPercentileControls?.render(statistics, style, percentileContext.settings,
                percentileContext.canRescale, percentileContext.message);
            previous.redraw();
            return;
        }
        this.detailAxisControls?.dispose();
        this.detailPercentileControls?.dispose();
        const presentation = { key, statistics, style, valueLabel, redraw: null };
        this.detailPresentation = presentation;
        this.detailPercentileControls = percentileContext === null ? null
            : new RasterPercentileControlsView(this.documentContext, settings => {
                presentation.redraw();
                this.handlers?.onHistogramPercentiles(key, settings);
            });
        this.detailPercentileControls?.render(statistics, style, percentileContext.settings,
            percentileContext.canRescale, percentileContext.message);
        const { controls, redraw } = this.#createAxisControls(key, this.histogramChart, statistics,
            () => presentation.style, valueLabel, () => this.detailPercentileControls?.markers ?? []);
        this.detailAxisControls = controls;
        presentation.redraw = redraw;
        this.detailAxesHost.replaceChildren(
            ...(this.detailPercentileControls ? [this.detailPercentileControls.root] : []), controls.root);
    }

    /**
     * Render the active layer's prepared category distribution.
     * @param {import("./categorical-presentation.js").CategoricalAreaPresentation} presentation Category areas and appearance.
     * @return {void}
     */
    renderCategoricalHistogram(presentation) {
        this.clearHistogram();
        this.histogramChart.hidden = true;
        this.categoryHost.append(createCategoricalRasterHistogram(presentation, this.documentContext));
    }

    /** Hide and empty the fixed-bin histogram chart. @return {void} */
    clearHistogram() {
        this.detailAxisControls?.dispose();
        this.detailAxisControls = null;
        this.detailPercentileControls?.dispose();
        this.detailPercentileControls = null;
        this.detailPresentation = null;
        this.detailAxesHost.replaceChildren();
        this.categoryHost.replaceChildren();
        this.histogramChart.hidden = true;
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
     * Validate a summary and identify changes in its displayed data and actions.
     * Axis drafts and category expansion are local interaction state. Continuous
     * style changes redraw the chart in place. These do not require a new card
     * and are excluded from the signature. Summary property order is irrelevant.
     *
     * @param {RasterHistogramSummary} summary Incoming view model.
     * @return {string} Presentation values used to decide whether to rebuild a card.
     * @throws {TypeError} If required identity or presentation fields are bad.
     */
    #serializeSummaryPresentation(summary) {
        const allowedStates = new Set(["idle", "loading", "ready", "error"]);
        if (
            summary === null ||
            typeof summary !== "object" ||
            typeof summary.key !== "string" ||
            summary.key === "" ||
            typeof summary.label !== "string" ||
            summary.label === "" ||
            !allowedStates.has(summary.state) ||
            (summary.unavailableMessage !== undefined &&
                typeof summary.unavailableMessage !== "string") ||
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
        return JSON.stringify([
            summary.label, summary.state, summary.counts,
            summary.errorMessage ?? "", summary.unavailableMessage,
            summary.valueLabel ?? "Raster value", summary.categorical,
            Boolean(summary.automatic), summary.statistics,
            Boolean(summary.percentileSettings),
            Boolean(summary.canRetry), summary.canCalculate,
        ]);
    }

    /**
     * Construct a raster card and keep its listeners and chart cleanup together.
     * @param {RasterHistogramSummary} summary Validated view model.
     * @param {string} signature Serialized presentation used for reconciliation.
     * @return {HistogramSummaryCard} Owned card resources.
     */
    #createSummaryCard(summary, signature) {
        const container = this.documentContext.createElement("article");
        container.className = "raster-histogram-summary";
        container.setAttribute("aria-label", `Histogram — ${summary.label}`);
        container.setAttribute("tabindex", "-1");
        const card = { key: summary.key, signature, root: container,
            button: null, chart: null, axisControls: null, percentileControls: null, listeners: [],
            style: summary.style, redraw: null };
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
            card.button = content;
            this.#bindSummaryAction(card, content, "onSelectHistogram");
        }

        const name = this.documentContext.createElement("span");
        name.className = "raster-histogram-summary-name";
        name.textContent = summary.label;
        name.title = summary.label;
        const status = this.documentContext.createElement("span");
        status.className = "raster-histogram-summary-status";
        status.setAttribute("role", "status");
        const presentationUnavailable = summary.unavailableMessage !== undefined;
        status.textContent = summary.unavailableMessage ?? {
            idle: "Waiting for histogram",
            loading: "Updating histogram…",
            ready: "",
            error: summary.errorMessage
                ? `Histogram unavailable: ${summary.errorMessage}`
                : "Histogram unavailable",
        }[summary.state];
        status.hidden = !presentationUnavailable && summary.state === "ready";
        content.append(name, status);
        if (summary.automatic && summary.percentileSettings) {
            card.percentileControls = new RasterPercentileControlsView(this.documentContext, settings => {
                card.redraw?.();
                this.handlers?.onHistogramPercentiles(card.key, settings);
            });
            card.percentileControls.render(summary.statistics, summary.style,
                summary.percentileSettings, summary.canRescale, summary.percentileMessage);
        }
        if (summary.categorical && summary.state === "ready") {
            const chart = createCategoricalRasterHistogram(summary.categorical, this.documentContext, {
                expanded: this.categoryExpansions.get(summary.key) ?? false,
                onExpandedChange: (expanded) => this.categoryExpansions.set(summary.key, expanded),
            });
            // Keep chart buttons outside the optional summary selection button.
            (summary.automatic ? content : container).append(chart);
        } else if (!presentationUnavailable && summary.automatic && summary.state === "ready" && summary.statistics) {
            const chart = this.documentContext.createElementNS(
                "http://www.w3.org/2000/svg", "svg"
            );
            chart.classList.add("raster-histogram-chart");
            const { controls, redraw } = this.#createAxisControls(
                summary.key, chart, summary.statistics, () => card.style, summary.valueLabel,
                () => card.percentileControls?.markers ?? []
            );
            card.axisControls = controls;
            card.chart = chart;
            card.redraw = redraw;
            content.append(chart);
            if (card.percentileControls) content.append(card.percentileControls.root);
            content.append(controls.root);
        } else if (!presentationUnavailable && summary.state === "ready" && summary.counts !== null && summary.counts.length > 0) {
            content.append(this.#createSummaryPreview(summary));
        }
        if (card.percentileControls && card.chart === null) content.append(card.percentileControls.root);
        const actions = this.documentContext.createElement("div");
        actions.className = "raster-histogram-summary-actions";
        const style = this.documentContext.createElement("button");
        style.type = "button";
        style.className = "secondary-button";
        style.textContent = "Style this raster";
        style.setAttribute("aria-controls", "layer-style-editor");
        style.setAttribute("aria-label", `Style ${summary.label}`);
        this.#bindSummaryAction(card, style, "onStyleHistogram");
        actions.append(style);
        if (summary.canCalculate) {
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
            this.#bindSummaryAction(card, download, "onDownloadHistogram");
            const calculate = this.documentContext.createElement("button");
            calculate.type = "button";
            calculate.className = "secondary-button";
            calculate.textContent = "Calculate statistics for this area";
            calculate.setAttribute("aria-label", "Calculate statistics for " + summary.label + " over this area");
            this.#bindSummaryAction(card, calculate, "onCalculateHistogram");
            actions.append(calculate, download);
        }
        if (summary.automatic) {
            if (summary.canRetry) {
                const retry = this.documentContext.createElement("button");
                retry.type = "button";
                retry.className = "secondary-button";
                retry.textContent = "Retry histogram";
                retry.setAttribute("aria-label", `Retry histogram for ${summary.label}`);
                this.#bindSummaryAction(card, retry, "onRetryHistogram");
                actions.append(retry);
            }
        }
        container.append(actions);
        return card;
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
     * Create axis controls and a redraw callback that reads the current raster style.
     * Redrawing preserves the controls' focused inputs, drafts and pending edits.
     * @param {string} key Chart identity.
     * @param {SVGSVGElement} chart Target SVG.
     * @param {Object} statistics Validated sample.
     * @param {()=>import("./style.js").RasterStyle} getStyle Return the current committed raster style.
     * @param {string} valueLabel Value-axis units.
     * @param {()=>Array<{label:string,value:number,color:string}>} [getMarkers] Current percentile inspection markers.
     * @return {{controls:HistogramAxisControls,redraw:()=>void}} Axis editor and
     * local redraw using its accepted display settings.
     */
    #createAxisControls(key, chart, statistics, getStyle, valueLabel = "Raster value", getMarkers = () => []) {
        if (!this.axisStates.has(key)) this.axisStates.set(key, {});
        const distribution = { ...statistics.histogram, total: statistics.validSampleCount };
        /** Redraw the sample with current colors and supplied axes.
         * @param {Object} axes Accepted axis settings. @return {void}
         */
        const draw = axes => renderRasterHistogramChart(
            chart, statistics, getStyle(), this.documentContext, valueLabel, getMarkers(), axes,
        );
        const controls = new HistogramAxisControls(this.documentContext, [
            { ...distribution, key: "y", label: "Bar height (% of pixels)", frequency: true, nice: true },
            { ...distribution, key: "x", label: valueLabel },
        ], this.axisStates.get(key), draw);
        draw(controls.axes);
        return { controls, redraw: () => draw(controls.axes) };
    }

    /**
     * Bind one card action and retain its listener for removal with the card.
     * @param {HistogramSummaryCard} card Owning card.
     * @param {HTMLButtonElement} button Action control.
     * @param {keyof RasterHistogramHandlers} handler Semantic callback name.
     * @return {void}
     */
    #bindSummaryAction(card, button, handler) {
        const handleClick = () => this.handlers?.[handler]?.(card.key);
        button.addEventListener("click", handleClick);
        card.listeners.push({ button, handleClick });
    }

    /**
     * Release a removed or changed card's timers, observer and action listeners.
     * Committed axis settings and category expansion remain available if it returns.
     * @param {HistogramSummaryCard} card Card being replaced or removed.
     * @return {void}
     */
    #disposeSummaryCard(card) {
        card.axisControls?.dispose();
        card.percentileControls?.dispose();
        if (card.chart) clearRasterHistogramChart(card.chart);
        for (const { button, handleClick } of card.listeners) {
            button.removeEventListener("click", handleClick);
        }
        card.root.remove();
    }

    /** Synchronize active-summary disclosure state. @return {void} */
    #synchronizeSummaryExpansion() {
        for (const { button, key } of this.summaryCards.values()) {
            button?.setAttribute(
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
