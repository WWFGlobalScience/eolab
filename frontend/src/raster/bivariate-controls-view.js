/** Focused presentation for bivariate map controls and paired histograms. */
import { HistogramAxisControls } from "./histogram-axis-controls.js";
import { requireRasterControl } from "./required-control.js";
import {
    BIVARIATE_RASTER_PALETTES,
    getBivariateAxisCssColor,
    getBivariateColorForValues,
    getBivariateDensityWeight,
    getBivariateHistogramCellColor,
} from "./bivariate.js";
import {
    findRasterPairedHistogramCell,
    getHighestDensityPairedCell,
} from "./paired-statistics.js";
import { formatHistogramTick } from "./histogram-axes.js";
import { formatRasterPixelValue } from "./value-format.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const LEGEND_GRID_SIZE = 12;
const HISTOGRAM_VIEWBOX_WIDTH = 660;
const HISTOGRAM_BASE_VIEWBOX_HEIGHT = 620;
const HISTOGRAM_PLOT_X = 160;
const HISTOGRAM_PLOT_Y = 74;
const HISTOGRAM_PLOT_SIZE = 420;
const HISTOGRAM_MARGINAL_SIZE = 54;
const HISTOGRAM_TOOLTIP_WIDTH = 360;
const HISTOGRAM_TOOLTIP_LINE_HEIGHT = 16;
const HISTOGRAM_TOOLTIP_MARGIN = 4;
const AXIS_TITLE_MAXIMUM_LINE_LENGTH = 40;
const AXIS_TITLE_LINE_HEIGHT = 22;

/**
 * Create one SVG element with a compact attribute mapping.
 *
 * @param {Document} documentContext Owning document.
 * @param {string} name SVG element name.
 * @param {Object} [attributes={}] Stringifiable SVG attributes.
 * @return {SVGElement} Newly created SVG element.
 */
function svgElement(documentContext, name, attributes = {}) {
    const element = documentContext.createElementNS(SVG_NAMESPACE, name);
    for (const [attribute, value] of Object.entries(attributes)) {
        element.setAttribute(attribute, String(value));
    }
    return element;
}

/**
 * Format one closed numeric range for accessible paired summaries.
 *
 * @param {number} minimum Finite lower value.
 * @param {number} maximum Finite upper value.
 * @return {string} Readable inclusive range.
 */
function formatRange(minimum, maximum) {
    return `${formatRasterPixelValue(minimum)} to ` +
        formatRasterPixelValue(maximum);
}

/**
 * Format one histogram bin with the compact precision used by 1D hover text.
 *
 * @param {number} minimum Inclusive lower bin edge.
 * @param {number} maximum Exclusive upper bin edge.
 * @return {string} Readable compact range.
 */
function formatHistogramBinRange(minimum, maximum) {
    const precision = (maximum - minimum) / 100;
    return `${formatHistogramTick(minimum, precision)}–${
        formatHistogramTick(maximum, precision)
    }`;
}

/**
 * Format one paired-histogram count with its share of the paired sample.
 *
 * @param {number} count Pixels represented by the cell or marginal bin.
 * @param {number} sampleCount Total valid paired pixels.
 * @return {string} Pixel count and percentage matching 1D hover language.
 */
function formatPairedSampleCount(count, sampleCount) {
    const percentage = count / sampleCount * 100;
    return `${count.toLocaleString()} pixels · ${percentage.toFixed(2)}% of sample`;
}

/**
 * Build the reusable in-chart tooltip for cells and marginal bars.
 *
 * The tooltip shares the standalone histogram's visual class while retaining
 * a bivariate-specific hook for focused tests and future layout changes.
 *
 * @param {Document} documentContext Owning DOM document.
 * @return {{element:SVGGElement,background:SVGRectElement,lines:SVGTextElement[]}}
 * Tooltip group, background, and three reusable text rows.
 */
function createBivariateHistogramTooltip(documentContext) {
    const element = svgElement(documentContext, "g");
    element.classList.add(
        "raster-histogram-tooltip",
        "raster-bivariate-tooltip"
    );
    element.setAttribute("hidden", "");
    element.setAttribute("aria-hidden", "true");
    const background = svgElement(documentContext, "rect", {
        width: HISTOGRAM_TOOLTIP_WIDTH,
        rx: 3,
    });
    const lines = Array.from({ length: 3 }, (_, index) => svgElement(
        documentContext,
        "text",
        {
            x: 8,
            y: 17 + index * HISTOGRAM_TOOLTIP_LINE_HEIGHT,
        }
    ));
    element.append(background, ...lines);
    return { element, background, lines };
}

/**
 * Build one pointer-transparent band that projects a marginal bin across the
 * paired plot.
 *
 * @param {Document} documentContext Owning DOM document.
 * @param {"x"|"y"} axis Projected histogram axis.
 * @return {SVGRectElement} Hidden guide owned by the bivariate SVG.
 */
function createBivariateProjectionGuide(documentContext, axis) {
    const guide = svgElement(documentContext, "rect", {
        "aria-hidden": "true",
        "data-projection-axis": axis,
        hidden: "",
    });
    guide.classList.add("raster-bivariate-projection-guide");
    return guide;
}

/**
 * Show compact text beside one SVG datum without leaving the chart view box.
 *
 * @param {Object} tooltip Tooltip returned by
 * {@link createBivariateHistogramTooltip}.
 * @param {SVGElement} target Hovered cell or marginal bar.
 * @param {string[]} textLines Two or three non-empty tooltip lines.
 * @param {number} viewBoxHeight Current chart view-box height.
 * @return {void}
 */
function showBivariateHistogramTooltip(
    tooltip,
    target,
    textLines,
    viewBoxHeight
) {
    const tooltipHeight = 10 +
        textLines.length * HISTOGRAM_TOOLTIP_LINE_HEIGHT;
    tooltip.background.setAttribute("height", String(tooltipHeight));
    tooltip.lines.forEach((line, index) => {
        line.textContent = textLines[index] ?? "";
        if (index < textLines.length) {
            line.removeAttribute("hidden");
        } else {
            line.setAttribute("hidden", "");
        }
    });
    const targetX = Number(target.getAttribute("x"));
    const targetY = Number(target.getAttribute("y"));
    const targetWidth = Number(target.getAttribute("width"));
    const targetHeight = Number(target.getAttribute("height"));
    const preferredX = targetX + targetWidth / 2 -
        HISTOGRAM_TOOLTIP_WIDTH / 2;
    const tooltipX = Math.max(
        HISTOGRAM_TOOLTIP_MARGIN,
        Math.min(
            preferredX,
            HISTOGRAM_VIEWBOX_WIDTH - HISTOGRAM_TOOLTIP_WIDTH -
                HISTOGRAM_TOOLTIP_MARGIN
        )
    );
    const preferredY = targetY > tooltipHeight + 2 * HISTOGRAM_TOOLTIP_MARGIN
        ? targetY - tooltipHeight - HISTOGRAM_TOOLTIP_MARGIN
        : targetY + targetHeight + HISTOGRAM_TOOLTIP_MARGIN;
    const tooltipY = Math.max(
        HISTOGRAM_TOOLTIP_MARGIN,
        Math.min(
            preferredY,
            viewBoxHeight - tooltipHeight - HISTOGRAM_TOOLTIP_MARGIN
        )
    );
    tooltip.element.setAttribute(
        "transform",
        `translate(${tooltipX} ${tooltipY})`
    );
    tooltip.element.removeAttribute("hidden");
}

/**
 * Wrap a raster filename at readable separators without dropping characters.
 *
 * Long uninterrupted filename segments are split at the same maximum length
 * so every catalog-provided basename remains visible in the SVG.
 *
 * @param {string} label Catalog-owned raster display basename.
 * @return {string[]} Ordered, non-empty SVG title lines.
 */
function wrapAxisTitle(label) {
    const source = label.trim();
    const tokens = source.match(/[^_.\s-]+(?:[_.\s-]+|$)/g) ?? [source];
    const fragments = [];
    for (const token of tokens) {
        for (
            let start = 0;
            start < token.length;
            start += AXIS_TITLE_MAXIMUM_LINE_LENGTH
        ) {
            fragments.push(token.slice(
                start,
                start + AXIS_TITLE_MAXIMUM_LINE_LENGTH
            ));
        }
    }
    const lines = [];
    let line = "";
    for (const fragment of fragments) {
        if (
            line.length > 0 &&
            line.length + fragment.length > AXIS_TITLE_MAXIMUM_LINE_LENGTH
        ) {
            lines.push(line);
            line = fragment;
        } else {
            line += fragment;
        }
    }
    if (line.length > 0) {
        lines.push(line);
    }
    return lines.length > 0 ? lines : [source];
}

/** Own bivariate DOM listeners and already-validated result presentation. */
export class BivariateRasterControlsView {
    /**
     * Resolve the fixed bivariate-control markup.
     *
     * @param {Document} [documentContext=globalThis.document] Owning document.
     */
    constructor(documentContext = globalThis.document) {
        this.documentContext = documentContext;
        this.root = requireRasterControl(
            documentContext,
            "#raster-bivariate-controls"
        );
        this.mode = requireRasterControl(
            documentContext,
            "#raster-comparison-mode"
        );
        this.status = requireRasterControl(
            documentContext,
            "#raster-bivariate-status"
        );
        this.panel = requireRasterControl(
            documentContext,
            "#raster-bivariate-panel"
        );
        this.palette = requireRasterControl(
            documentContext,
            "#raster-bivariate-palette"
        );
        this.swapButton = requireRasterControl(
            documentContext,
            "#swap-raster-bivariate-axes"
        );
        this.legend = requireRasterControl(
            documentContext,
            "#raster-bivariate-legend"
        );
        this.legendXRange = requireRasterControl(
            documentContext,
            "#raster-bivariate-legend-x-range"
        );
        this.legendYRange = requireRasterControl(
            documentContext,
            "#raster-bivariate-legend-y-range"
        );
        this.statisticsPanel = requireRasterControl(
            documentContext,
            "#raster-bivariate-statistics"
        );
        this.statisticsHeading = requireRasterControl(
            documentContext,
            "#raster-bivariate-statistics-heading"
        );
        this.statisticsStatus = requireRasterControl(
            documentContext,
            "#raster-bivariate-statistics-status"
        );
        this.statisticsXLabel = requireRasterControl(
            documentContext,
            "#raster-bivariate-statistics-x-label"
        );
        this.statisticsYLabel = requireRasterControl(
            documentContext,
            "#raster-bivariate-statistics-y-label"
        );
        this.retryButton = requireRasterControl(
            documentContext,
            "#retry-raster-paired-statistics"
        );
        this.histogram = requireRasterControl(
            documentContext,
            "#raster-bivariate-histogram"
        );
        this.axesHost = requireRasterControl(documentContext, "#raster-bivariate-axis-controls");
        this.axisState = {};
        this.axisControls = null;
        this.axes = null;
        this.histogramSummary = requireRasterControl(
            documentContext,
            "#raster-bivariate-histogram-summary"
        );
        this.handlers = null;
        this.styleRanges = requireRasterControl(
            documentContext, "#raster-bivariate-style-ranges"
        );
        this.rangePreviews = { x: null, y: null };
        this.thresholdMarkers = null;
        this.statisticsIsCurrent = false;
        this.rangeControls = Object.fromEntries(["x", "y"].map((axis) => [axis, {
            label: requireRasterControl(documentContext, `#bivariate-${axis}-range-label`),
            inputs: Object.fromEntries(["lower", "middle", "upper"].map((name) => [
                name, requireRasterControl(documentContext, `#bivariate-${axis}-${name}`),
            ])),
            values: Object.fromEntries(["lower", "middle", "upper"].map((name) => [
                name, requireRasterControl(documentContext, `#bivariate-${axis}-${name}-value`),
            ])),
            status: requireRasterControl(documentContext, `#bivariate-${axis}-range-status`),
            apply: requireRasterControl(documentContext, `#apply-bivariate-${axis}-range`),
            onInput: () => this.handlers?.onBivariatePercentileInput(axis),
            onApply: () => this.handlers?.onApplyBivariatePercentiles(axis),
        }]));
        this.cells = new Map();
        this.activeCell = null;
        this.statistics = null;
        this.labels = null;
        this.boundModeChange = this.#handleModeChange.bind(this);
        this.boundPaletteChange = this.#handlePaletteChange.bind(this);
        this.boundSwap = this.#handleSwap.bind(this);
        this.boundRetry = this.#handleRetry.bind(this);
        this.boundRangeToggle = this.#renderThresholdMarkers.bind(this);
        this.downloadButtons = ["x", "y"].flatMap(axis => [
            { axis, calculate: true, button: requireRasterControl(documentContext, `#calculate-bivariate-${axis}`),
                onClick: () => this.handlers?.onCalculatePairedHistogram?.(axis) }, {
            axis, button: requireRasterControl(documentContext, `#download-bivariate-${axis}`),
            onClick: () => this.handlers?.onDownloadPairedHistogram?.(axis),
        }]);
    }

    /** Populate the eight shared palette definitions exactly once. @return {void} */
    populatePalettes() {
        if (this.palette.children.length > 0) {
            return;
        }
        for (const [name, definition] of Object.entries(
            BIVARIATE_RASTER_PALETTES
        )) {
            const option = this.documentContext.createElement("option");
            option.value = name;
            option.textContent = definition.label;
            this.palette.append(option);
        }
    }

    /**
     * Attach semantic bivariate handlers.
     *
     * @param {Object} handlers Viewer-owned mode and request actions.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        for (const { button, onClick } of this.downloadButtons) button.addEventListener("click", onClick);
        this.mode.addEventListener("change", this.boundModeChange);
        this.palette.addEventListener("change", this.boundPaletteChange);
        this.swapButton.addEventListener("click", this.boundSwap);
        this.retryButton.addEventListener("click", this.boundRetry);
        this.styleRanges.addEventListener("toggle", this.boundRangeToggle);
        for (const controls of Object.values(this.rangeControls)) {
            for (const input of Object.values(controls.inputs)) {
                input.addEventListener("input", controls.onInput);
            }
            controls.apply.addEventListener("click", controls.onApply);
        }
    }

    /** Remove every direct listener installed by {@link bind}. @return {void} */
    unbind() {
        this.axisControls?.dispose();
        for (const { button, onClick } of this.downloadButtons) button.removeEventListener("click", onClick);
        this.mode.removeEventListener("change", this.boundModeChange);
        this.palette.removeEventListener("change", this.boundPaletteChange);
        this.swapButton.removeEventListener("click", this.boundSwap);
        this.retryButton.removeEventListener("click", this.boundRetry);
        this.styleRanges.removeEventListener("toggle", this.boundRangeToggle);
        for (const controls of Object.values(this.rangeControls)) {
            for (const input of Object.values(controls.inputs)) {
                input.removeEventListener("input", controls.onInput);
            }
            controls.apply.removeEventListener("click", controls.onApply);
        }
        this.handlers = null;
    }

    /**
     * Read the draft percentile positions for an axis without applying them.
     * @param {"x"|"y"} axis Paired axis.
     * @return {{lower:number,middle:number,upper:number}} Slider percentages.
     */
    readPercentiles(axis) {
        return Object.fromEntries(Object.entries(this.rangeControls[axis].inputs)
            .map(([name, input]) => [name, Number(input.value)]));
    }

    /**
     * Present estimates and availability supplied by the raster coordinator.
     * @param {"x"|"y"} axis Paired axis.
     * @param {{values:Object|null,range:Object|null,message:string,applicable:boolean,invalid:boolean}} state
     * Formatted estimates, exact candidate thresholds, sample scope or failure,
     * and validity. Only applicable ranges may appear as draft markers.
     * @return {void}
     */
    renderPercentiles(axis, state) {
        const controls = this.rangeControls[axis];
        const percentiles = this.readPercentiles(axis);
        for (const name of ["lower", "middle", "upper"]) {
            controls.inputs[name].setAttribute("aria-invalid", String(state.invalid));
            controls.values[name].textContent = `${percentiles[name]}% ≈ ${state.values?.[name] ?? "—"}`;
        }
        controls.status.textContent = state.message;
        controls.apply.disabled = !state.applicable;
        this.rangePreviews[axis] = state.applicable ? state.range ?? null : null;
        this.#renderThresholdMarkers();
    }

    /**
     * Present whether the explicit bivariate choice can currently start.
     *
     * @param {boolean} canEnter Whether two catalog raster candidates exist.
     * @param {string} guidance Concise eligibility guidance.
     * @return {void}
     */
    setAvailability(canEnter, guidance) {
        const option = [...this.mode.options].find(
            (candidate) => candidate.value === "bivariate"
        );
        if (option !== undefined) {
            option.disabled = !canEnter && this.mode.value !== "bivariate";
        }
        this.status.textContent = guidance;
    }

    /**
     * Render mode state, a compact titled identity, and the coordinated legend.
     *
     * @param {Object} state Viewer-owned mode presentation state.
     * @return {void}
     */
    renderMode(state) {
        this.mode.value = state.active ? "bivariate" : "overlay";
        this.panel.hidden = !state.active;
        this.statisticsPanel.hidden = !state.active;
        if (!state.active) {
            this.clearStatistics();
            return;
        }
        this.palette.value = state.paletteName;
        this.statisticsHeading.textContent =
            `${state.xLabel} vs. ${state.yLabel}`;
        this.statisticsHeading.title = this.statisticsHeading.textContent;
        this.statisticsXLabel.textContent = state.xLabel;
        this.statisticsYLabel.textContent = state.yLabel;
        for (const { axis, button, calculate } of this.downloadButtons) {
            button.textContent = calculate ? `Calculator · ${axis.toUpperCase()}` : `Download ${axis.toUpperCase()} clip`;
            button.setAttribute("aria-label", `${calculate ? "Raster calculator of" : "Download clip of"} ${axis.toUpperCase()}: ${state[`${axis}Label`]}`);
        }
        this.rangeControls.x.label.textContent = state.xLabel;
        this.rangeControls.y.label.textContent = state.yLabel;
        this.swapButton.setAttribute(
            "aria-label",
            `Swap X axis ${state.xLabel} with Y axis ${state.yLabel}`
        );
        this.#renderLegend(state);
    }

    /**
     * Reveal the current pair's consolidated controls and focus its palette.
     * The caller owns opening the histogram workspace before this navigation.
     *
     * @return {void}
     */
    openStyle() {
        this.styleRanges.open = true;
        this.#renderThresholdMarkers();
        this.palette.focus();
    }

    /**
     * Show paired loading state without discarding the last valid chart.
     *
     * @param {string} message Current paired request guidance.
     * @return {void}
     */
    setStatisticsLoading(message) {
        this.axisControls?.setEnabled(false);
        this.statisticsIsCurrent = false;
        this.rangePreviews = { x: null, y: null };
        this.#renderThresholdMarkers();
        this.statisticsStatus.textContent = message;
        this.retryButton.hidden = true;
        this.histogram.setAttribute("aria-busy", "true");
    }

    /**
     * Present a current paired failure and optional retry action.
     *
     * @param {Error} error Current paired request failure.
     * @param {boolean} canRetry Whether repeating may change the outcome.
     * @return {void}
     */
    renderStatisticsError(error, canRetry) {
        this.axisControls?.setEnabled(false);
        this.statisticsIsCurrent = false;
        this.rangePreviews = { x: null, y: null };
        this.#renderThresholdMarkers();
        this.statisticsStatus.textContent = error.message;
        this.retryButton.hidden = !canRetry;
        this.histogram.removeAttribute("aria-busy");
    }

    /**
     * Render a color-faithful 2D histogram and X/Y marginals.
     *
     * @param {Object} statistics Validated paired response.
     * @param {Object} presentation Axis labels, styles, and palette identity.
     * @return {void}
     */
    renderStatistics(statistics, presentation) {
        this.statistics = statistics;
        this.statisticsIsCurrent = true;
        this.labels = presentation;
        this.axisControls?.dispose();
        const definitions = ["x", "y"].flatMap(axis => {
            const distribution = {
                edges: statistics.histogram[`${axis}Edges`],
                counts: statistics.histogram[`${axis}MarginalCounts`],
                total: statistics.pairedSampleCount,
            };
            return [
                { ...distribution, key: axis, label: `${axis.toUpperCase()} · ${presentation[`${axis}Label`]}` },
                { ...distribution, key: `${axis}Frequency`, frequency: true,
                    label: `${axis.toUpperCase()} outer histogram · bar height (% of pixels)` },
            ];
        });
        this.axisControls = new HistogramAxisControls(this.documentContext, definitions, this.axisState, axes => {
            const selected = this.activeCell && {
                xBin: Number(this.activeCell.dataset.xBin), yBin: Number(this.activeCell.dataset.yBin),
                sampled: this.activeCell.classList.contains("is-sampled"),
            };
            this.axes = axes;
            this.#drawStatistics();
            if (selected) {
                const cell = this.cells.get(`${selected.xBin}:${selected.yBin}`);
                if (cell) {
                    this.#selectCell(selected.xBin, selected.yBin,
                        this.#compactCellDescription(selected.xBin, selected.yBin,
                            this.statistics.histogram.counts[selected.yBin][selected.xBin]), cell);
                    if (selected.sampled) cell.classList.add("is-sampled");
                }
            }
        });
        this.axesHost.replaceChildren(this.axisControls.root);
        this.axes = this.axisControls.axes;
        this.#drawStatistics();
    }

    /** Redraw the current paired sample using the current display transforms. @return {void} */
    #drawStatistics() {
        const statistics = this.statistics, presentation = this.labels;
        const { x: xAxis, y: yAxis, xFrequency, yFrequency } = this.axes;
        this.cells.clear();
        this.activeCell = null;
        const { histogram } = statistics;
        const maximumCount = Math.max(...histogram.counts.flat());
        const xIntervals = histogram.xMarginalCounts.map((_, i) => xAxis.interval(histogram.xEdges[i], histogram.xEdges[i + 1]));
        const yIntervals = histogram.yMarginalCounts.map((_, i) => yAxis.interval(histogram.yEdges[i], histogram.yEdges[i + 1]));
        const highest = getHighestDensityPairedCell(statistics);
        const highestDescription = this.#cellDescription(
            highest.xBin,
            highest.yBin,
            highest.count
        );
        const provenance = statistics.approximate
            ? "Approximate bounded sample"
            : "Exact X-reference sample";
        const summary =
            `${presentation.xLabel}, horizontal range ${formatRange(
                statistics.xMinimum,
                statistics.xMaximum
            )}. ${presentation.yLabel}, vertical range ${formatRange(
                statistics.yMinimum,
                statistics.yMaximum
            )}. ${statistics.pairedSampleCount.toLocaleString()} paired ` +
            `pixels. ${provenance}; the vertical raster uses nearest-neighbor ` +
            "alignment. " +
            `Densest bin: ${highestDescription}. ` +
            `Displayed X: ${formatRange(xAxis.minimum, xAxis.maximum)} (${xAxis.scale}); ` +
            `Y: ${formatRange(yAxis.minimum, yAxis.maximum)} (${yAxis.scale}).`;
        const xAxisTitleLines = wrapAxisTitle(presentation.xLabel + (xAxis.scale === "log" ? " · log" : ""));
        const yAxisTitleLines = wrapAxisTitle(presentation.yLabel + (yAxis.scale === "log" ? " · log" : ""));
        const xAxisTitleY = HISTOGRAM_PLOT_Y + HISTOGRAM_PLOT_SIZE + 58;
        const viewBoxHeight = Math.max(
            HISTOGRAM_BASE_VIEWBOX_HEIGHT,
            xAxisTitleY +
                (xAxisTitleLines.length - 1) * AXIS_TITLE_LINE_HEIGHT + 24
        );
        this.histogram.setAttribute(
            "viewBox",
            `0 0 ${HISTOGRAM_VIEWBOX_WIDTH} ${viewBoxHeight}`
        );
        const plotRight = HISTOGRAM_PLOT_X + HISTOGRAM_PLOT_SIZE;
        const plotBottom = HISTOGRAM_PLOT_Y + HISTOGRAM_PLOT_SIZE;
        const children = [
            svgElement(this.documentContext, "rect", {
                x: HISTOGRAM_PLOT_X,
                y: HISTOGRAM_PLOT_Y,
                width: HISTOGRAM_PLOT_SIZE,
                height: HISTOGRAM_PLOT_SIZE,
                class: "raster-bivariate-plot",
            }),
        ];
        const projectionGuides = {
            x: createBivariateProjectionGuide(this.documentContext, "x"),
            y: createBivariateProjectionGuide(this.documentContext, "y"),
        };
        children.push(projectionGuides.x, projectionGuides.y);
        const marginalBars = { x: [], y: [] };
        const tooltip = createBivariateHistogramTooltip(
            this.documentContext
        );
        let activeHover = null;
        /** Clear every transient plot band and projected marginal. @return {void} */
        const clearProjection = () => {
            projectionGuides.x.setAttribute("hidden", "");
            projectionGuides.y.setAttribute("hidden", "");
            for (const bar of [...marginalBars.x, ...marginalBars.y].filter(Boolean)) {
                bar.classList.remove("is-projected");
            }
        };
        /**
         * Project selected X and Y bins through the plot and into marginals.
         *
         * @param {{xBin?:number,yBin?:number}} projection Active bin indices.
         * @return {void}
         */
        const showProjection = ({ xBin, yBin }) => {
            clearProjection();
            if (xBin !== undefined) {
                projectionGuides.x.setAttribute(
                    "x",
                    String(HISTOGRAM_PLOT_X + xIntervals[xBin][0] * HISTOGRAM_PLOT_SIZE)
                );
                projectionGuides.x.setAttribute("y", String(HISTOGRAM_PLOT_Y));
                projectionGuides.x.setAttribute("width", String((xIntervals[xBin][1] - xIntervals[xBin][0]) * HISTOGRAM_PLOT_SIZE));
                projectionGuides.x.setAttribute(
                    "height",
                    String(HISTOGRAM_PLOT_SIZE)
                );
                projectionGuides.x.removeAttribute("hidden");
                marginalBars.x[xBin]?.classList.add("is-projected");
            }
            if (yBin !== undefined) {
                projectionGuides.y.setAttribute("x", String(HISTOGRAM_PLOT_X));
                projectionGuides.y.setAttribute(
                    "y",
                    String(
                        HISTOGRAM_PLOT_Y +
                        (1 - yIntervals[yBin][1]) * HISTOGRAM_PLOT_SIZE
                    )
                );
                projectionGuides.y.setAttribute(
                    "width",
                    String(HISTOGRAM_PLOT_SIZE)
                );
                projectionGuides.y.setAttribute("height", String((yIntervals[yBin][1] - yIntervals[yBin][0]) * HISTOGRAM_PLOT_SIZE));
                projectionGuides.y.removeAttribute("hidden");
                marginalBars.y[yBin]?.classList.add("is-projected");
            }
        };
        /**
         * Emphasize one datum and show its transient in-chart readout.
         *
         * @param {SVGElement} target Hovered cell or marginal bar.
         * @param {string[]} lines Compact tooltip rows.
         * @param {{xBin?:number,yBin?:number}} projection Projected bins.
         * @return {void}
         */
        const showHover = (target, lines, projection) => {
            activeHover?.classList.remove("is-hovered");
            activeHover = target;
            target.classList.add("is-hovered");
            showProjection(projection);
            showBivariateHistogramTooltip(
                tooltip,
                target,
                lines,
                viewBoxHeight
            );
        };
        /**
         * Clear hover feedback only when the departing datum still owns it.
         *
         * @param {SVGElement} target Departing cell or marginal bar.
         * @return {void}
         */
        const hideHover = (target) => {
            if (activeHover !== target) return;
            target.classList.remove("is-hovered");
            activeHover = null;
            clearProjection();
            tooltip.element.setAttribute("hidden", "");
        };
        for (const fraction of [0.25, 0.5, 0.75]) {
            const offset = HISTOGRAM_PLOT_SIZE * fraction;
            children.push(
                svgElement(this.documentContext, "line", {
                    x1: HISTOGRAM_PLOT_X + offset,
                    y1: HISTOGRAM_PLOT_Y,
                    x2: HISTOGRAM_PLOT_X + offset,
                    y2: plotBottom,
                    class: "raster-bivariate-grid-line",
                }),
                svgElement(this.documentContext, "line", {
                    x1: HISTOGRAM_PLOT_X,
                    y1: HISTOGRAM_PLOT_Y + offset,
                    x2: plotRight,
                    y2: HISTOGRAM_PLOT_Y + offset,
                    class: "raster-bivariate-grid-line",
                })
            );
        }

        histogram.counts.forEach((row, yBin) => {
            row.forEach((count, xBin) => {
                const xInterval = xIntervals[xBin], yInterval = yIntervals[yBin];
                if (count === 0 || xInterval === null || yInterval === null) return;
                const density = getBivariateDensityWeight(
                    count,
                    maximumCount
                );
                const shrink = -0.05 + 0.5 * (1 - density);
                const width = (xInterval[1] - xInterval[0]) * HISTOGRAM_PLOT_SIZE;
                const height = (yInterval[1] - yInterval[0]) * HISTOGRAM_PLOT_SIZE;
                const left = HISTOGRAM_PLOT_X + xInterval[0] * HISTOGRAM_PLOT_SIZE + width * shrink / 2;
                const top = HISTOGRAM_PLOT_Y + (1 - yInterval[1]) * HISTOGRAM_PLOT_SIZE + height * shrink / 2;
                const xValue = (
                    histogram.xEdges[xBin] + histogram.xEdges[xBin + 1]
                ) / 2;
                const yValue = (
                    histogram.yEdges[yBin] + histogram.yEdges[yBin + 1]
                ) / 2;
                const cell = svgElement(this.documentContext, "rect", {
                    x: Math.max(HISTOGRAM_PLOT_X, left),
                    y: Math.max(HISTOGRAM_PLOT_Y, top),
                    width: Math.min(plotRight, left + width * (1 - shrink)) - Math.max(HISTOGRAM_PLOT_X, left),
                    height: Math.min(plotBottom, top + height * (1 - shrink)) - Math.max(HISTOGRAM_PLOT_Y, top),
                    tabindex: 0,
                    role: "button",
                });
                cell.classList.add("raster-bivariate-cell");
                cell.style.fill = getBivariateHistogramCellColor(
                    getBivariateColorForValues(
                        presentation.paletteName,
                        presentation.xStyle,
                        presentation.yStyle,
                        xValue,
                        yValue
                    ),
                    density
                );
                cell.style.strokeOpacity = String(
                    0.15 * Math.pow(density, 0.7)
                );
                const description = this.#cellDescription(xBin, yBin, count);
                const compactDescription = this.#compactCellDescription(
                    xBin,
                    yBin,
                    count
                );
                const tooltipLines = [
                    `X: ${formatHistogramBinRange(
                        histogram.xEdges[xBin],
                        histogram.xEdges[xBin + 1]
                    )}`,
                    `Y: ${formatHistogramBinRange(
                        histogram.yEdges[yBin],
                        histogram.yEdges[yBin + 1]
                    )}`,
                    formatPairedSampleCount(
                        count,
                        statistics.pairedSampleCount
                    ),
                ];
                cell.setAttribute("aria-label", description);
                /** Select and announce this histogram cell. @return {void} */
                const select = () => this.#selectCell(
                    xBin,
                    yBin,
                    compactDescription,
                    cell
                );
                cell.addEventListener("pointerenter", () => {
                    select();
                    showHover(cell, tooltipLines, { xBin, yBin });
                });
                cell.addEventListener("pointerleave", () => hideHover(cell));
                cell.addEventListener("focus", () => {
                    select();
                    showHover(cell, tooltipLines, { xBin, yBin });
                });
                cell.addEventListener("blur", () => hideHover(cell));
                cell.addEventListener("click", select);
                cell.addEventListener("keydown", (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        select();
                    }
                });
                this.cells.set(`${xBin}:${yBin}`, cell);
                children.push(cell);
            });
        });

        histogram.xMarginalCounts.forEach((count, xBin) => {
            const interval = xIntervals[xBin];
            if (interval === null) return;
            const percent = count / statistics.pairedSampleCount * 100;
            const height = Math.max(0, Math.min(1, xFrequency.position(percent))) * HISTOGRAM_MARGINAL_SIZE;
            const binWidth = (interval[1] - interval[0]) * HISTOGRAM_PLOT_SIZE;
            const bar = svgElement(this.documentContext, "rect", {
                x: HISTOGRAM_PLOT_X + interval[0] * HISTOGRAM_PLOT_SIZE,
                y: HISTOGRAM_PLOT_Y - height,
                width: binWidth - Math.min(1, binWidth * 0.1),
                height,
                "data-marginal-axis": "x",
            });
            bar.classList.add("raster-bivariate-marginal");
            if (percent > xFrequency.maximum || percent < xFrequency.minimum ||
                histogram.xEdges[xBin] < xAxis.minimum || histogram.xEdges[xBin + 1] > xAxis.maximum) {
                bar.classList.add("histogram-axis-clipped");
            }
            const midpoint = (
                histogram.xEdges[xBin] + histogram.xEdges[xBin + 1]
            ) / 2;
            bar.style.fill = getBivariateAxisCssColor(
                presentation.xStyle,
                midpoint
            );
            bar.setAttribute(
                "aria-label",
                `${presentation.xLabel} ${formatRange(
                    histogram.xEdges[xBin],
                    histogram.xEdges[xBin + 1]
                )}; ${formatPairedSampleCount(
                    count,
                    statistics.pairedSampleCount
                )}.`
            );
            const tooltipLines = [
                `X: ${formatHistogramBinRange(
                    histogram.xEdges[xBin],
                    histogram.xEdges[xBin + 1]
                )}`,
                formatPairedSampleCount(
                    count,
                    statistics.pairedSampleCount
                ),
            ];
            bar.addEventListener(
                "pointerenter",
                () => showHover(bar, tooltipLines, { xBin })
            );
            bar.addEventListener("pointerleave", () => hideHover(bar));
            marginalBars.x[xBin] = bar;
            children.push(bar);
        });
        histogram.yMarginalCounts.forEach((count, yBin) => {
            const interval = yIntervals[yBin];
            if (interval === null) return;
            const percent = count / statistics.pairedSampleCount * 100;
            const width = Math.max(0, Math.min(1, yFrequency.position(percent))) * HISTOGRAM_MARGINAL_SIZE;
            const binHeight = (interval[1] - interval[0]) * HISTOGRAM_PLOT_SIZE;
            const bar = svgElement(this.documentContext, "rect", {
                x: HISTOGRAM_PLOT_X + HISTOGRAM_PLOT_SIZE,
                y: HISTOGRAM_PLOT_Y + (1 - interval[1]) * HISTOGRAM_PLOT_SIZE,
                width,
                height: binHeight - Math.min(1, binHeight * 0.1),
                "data-marginal-axis": "y",
            });
            bar.classList.add("raster-bivariate-marginal");
            if (percent > yFrequency.maximum || percent < yFrequency.minimum ||
                histogram.yEdges[yBin] < yAxis.minimum || histogram.yEdges[yBin + 1] > yAxis.maximum) {
                bar.classList.add("histogram-axis-clipped");
            }
            const midpoint = (
                histogram.yEdges[yBin] + histogram.yEdges[yBin + 1]
            ) / 2;
            bar.style.fill = getBivariateAxisCssColor(
                presentation.yStyle,
                midpoint
            );
            bar.setAttribute(
                "aria-label",
                `${presentation.yLabel} ${formatRange(
                    histogram.yEdges[yBin],
                    histogram.yEdges[yBin + 1]
                )}; ${formatPairedSampleCount(
                    count,
                    statistics.pairedSampleCount
                )}.`
            );
            const tooltipLines = [
                `Y: ${formatHistogramBinRange(
                    histogram.yEdges[yBin],
                    histogram.yEdges[yBin + 1]
                )}`,
                formatPairedSampleCount(
                    count,
                    statistics.pairedSampleCount
                ),
            ];
            bar.addEventListener(
                "pointerenter",
                () => showHover(bar, tooltipLines, { yBin })
            );
            bar.addEventListener("pointerleave", () => hideHover(bar));
            marginalBars.y[yBin] = bar;
            children.push(bar);
        });

        children.push(
            svgElement(this.documentContext, "line", {
                x1: HISTOGRAM_PLOT_X,
                y1: plotBottom,
                x2: plotRight,
                y2: plotBottom,
                class: "raster-bivariate-axis",
            }),
            svgElement(this.documentContext, "line", {
                x1: HISTOGRAM_PLOT_X,
                y1: HISTOGRAM_PLOT_Y,
                x2: HISTOGRAM_PLOT_X,
                y2: plotBottom,
                class: "raster-bivariate-axis",
            })
        );
        const axisLabels = [];
        for (const [fraction, value, anchor] of [
            [0, xAxis.valueAt(0), "start"],
            [0.5, xAxis.valueAt(0.5), "middle"],
            [1, xAxis.valueAt(1), "end"],
        ]) {
            const x = HISTOGRAM_PLOT_X + HISTOGRAM_PLOT_SIZE * fraction;
            children.push(svgElement(this.documentContext, "line", {
                x1: x,
                y1: plotBottom,
                x2: x,
                y2: plotBottom + 7,
                class: "raster-bivariate-axis",
            }));
            axisLabels.push([
                formatRasterPixelValue(value),
                x,
                plotBottom + 25,
                anchor,
            ]);
        }
        for (const [fraction, value] of [
            [0, yAxis.valueAt(0)],
            [0.5, yAxis.valueAt(0.5)],
            [1, yAxis.valueAt(1)],
        ]) {
            const y = plotBottom - HISTOGRAM_PLOT_SIZE * fraction;
            children.push(svgElement(this.documentContext, "line", {
                x1: HISTOGRAM_PLOT_X - 7,
                y1: y,
                x2: HISTOGRAM_PLOT_X,
                y2: y,
                class: "raster-bivariate-axis",
            }));
            axisLabels.push([
                formatRasterPixelValue(value),
                HISTOGRAM_PLOT_X - 12,
                y + 5,
                "end",
            ]);
        }
        for (const [text, x, y, anchor] of axisLabels) {
            const label = svgElement(this.documentContext, "text", {
                x,
                y,
                "text-anchor": anchor,
                class: "raster-bivariate-axis-label",
            });
            label.textContent = text;
            children.push(label);
        }
        xAxisTitleLines.forEach((line, index) => {
            const xAxisLabel = svgElement(this.documentContext, "text", {
                x: HISTOGRAM_PLOT_X + HISTOGRAM_PLOT_SIZE / 2,
                y: xAxisTitleY + index * AXIS_TITLE_LINE_HEIGHT,
                "text-anchor": "middle",
                class: "raster-bivariate-axis-title",
                "data-axis": "x",
            });
            xAxisLabel.textContent = line;
            children.push(xAxisLabel);
        });
        const yAxisTitleStartX = Math.max(
            14,
            48 - (yAxisTitleLines.length - 1) * AXIS_TITLE_LINE_HEIGHT / 2
        );
        yAxisTitleLines.forEach((line, index) => {
            const x = yAxisTitleStartX + index * AXIS_TITLE_LINE_HEIGHT;
            const y = HISTOGRAM_PLOT_Y + HISTOGRAM_PLOT_SIZE / 2;
            const yAxisLabel = svgElement(this.documentContext, "text", {
                x,
                y,
                "text-anchor": "middle",
                class: "raster-bivariate-axis-title",
                "data-axis": "y",
                transform: `rotate(-90 ${x} ${y})`,
            });
            yAxisLabel.textContent = line;
            children.push(yAxisLabel);
        });
        this.thresholdMarkers = svgElement(this.documentContext, "g", {
            class: "raster-bivariate-thresholds",
            "aria-hidden": "true",
        });
        children.push(this.thresholdMarkers, tooltip.element);

        this.histogram.replaceChildren(...children);
        this.#renderThresholdMarkers();
        this.histogram.setAttribute("aria-label", summary);
        this.histogram.removeAttribute("aria-busy");
        this.histogram.removeAttribute("hidden");
        this.histogramSummary.textContent =
            `Densest · ${this.#compactCellDescription(
                highest.xBin,
                highest.yBin,
                highest.count
            )}`;
        this.statisticsStatus.textContent =
            `${statistics.pairedSampleCount.toLocaleString()} paired pixels · ` +
            `${statistics.approximate ? "approximate" : "exact"}`;
        this.retryButton.hidden = true;
    }

    /**
     * Draw committed or draft L/M/U stops on the two marginal histograms.
     * Replaces only the marker group so slider previews preserve the plot's
     * hover, keyboard focus, and sampled-cell state. Drafts are shown only
     * while the disclosure is open and the paired sample is current.
     *
     * @return {void}
     */
    #renderThresholdMarkers() {
        if (this.thresholdMarkers === null) return;
        this.thresholdMarkers.replaceChildren();
        if (!this.statisticsIsCurrent || this.statistics === null) return;
        for (const axis of ["x", "y"]) {
            const style = this.labels[`${axis}Style`];
            const preview = this.styleRanges.open ? this.rangePreviews[axis] : null;
            const range = preview ?? style;
            const displayAxis = this.axes[axis];
            const group = svgElement(this.documentContext, "g", {
                "data-threshold-axis": axis,
                "data-threshold-mode": preview === null ? "committed" : "preview",
            });
            for (const [index, name] of ["minimum", "midpoint", "maximum"].entries()) {
                const rawFraction = displayAxis.position(range[name]);
                if (!Number.isFinite(rawFraction)) continue;
                const fraction = Math.max(0, Math.min(1, rawFraction));
                const position = axis === "x"
                    ? HISTOGRAM_PLOT_X + fraction * HISTOGRAM_PLOT_SIZE
                    : HISTOGRAM_PLOT_Y + (1 - fraction) * HISTOGRAM_PLOT_SIZE;
                const coordinates = axis === "x"
                    ? { x1: position, x2: position,
                        y1: HISTOGRAM_PLOT_Y - HISTOGRAM_MARGINAL_SIZE,
                        y2: HISTOGRAM_PLOT_Y }
                    : { x1: HISTOGRAM_PLOT_X + HISTOGRAM_PLOT_SIZE,
                        x2: HISTOGRAM_PLOT_X + HISTOGRAM_PLOT_SIZE + HISTOGRAM_MARGINAL_SIZE,
                        y1: position, y2: position };
                const outline = svgElement(this.documentContext, "line", {
                    ...coordinates, class: "raster-histogram-threshold-outline",
                });
                const line = svgElement(this.documentContext, "line", {
                    ...coordinates, class: "raster-histogram-threshold",
                    "data-threshold": name, "data-value": range[name],
                });
                line.style.stroke = style[`${name}Color`];
                const label = svgElement(this.documentContext, "text", {
                    x: axis === "x" ? position
                        : HISTOGRAM_PLOT_X + HISTOGRAM_PLOT_SIZE + 12 + index * 16,
                    y: axis === "x"
                        ? HISTOGRAM_PLOT_Y - HISTOGRAM_MARGINAL_SIZE + 14 + index * 16
                        : position + 5,
                    class: "raster-histogram-threshold-label",
                });
                label.textContent = ["L", "M", "U"][index];
                group.append(outline, line, label);
            }
            this.thresholdMarkers.append(group);
        }
    }

    /**
     * Mark the histogram cell containing a dual point-sample result.
     *
     * @param {number} xValue Current X pixel value.
     * @param {number} yValue Current Y pixel value.
     * @return {void}
     */
    highlightPair(xValue, yValue) {
        if (this.statistics === null) return;
        const bin = findRasterPairedHistogramCell(
            this.statistics,
            xValue,
            yValue
        );
        if (bin === null) return;
        const cell = this.cells.get(`${bin.xBin}:${bin.yBin}`);
        if (cell === undefined) return;
        this.#selectCell(
            bin.xBin,
            bin.yBin,
            `Probe · ${this.#compactCellDescription(
                bin.xBin,
                bin.yBin,
                this.statistics.histogram.counts[bin.yBin][bin.xBin]
            )}`,
            cell
        );
        cell.classList.add("is-sampled");
    }

    /** Clear paired result content while preserving explicit mode controls. @return {void} */
    clearStatistics() {
        this.axisControls?.dispose();
        this.axisControls = null;
        this.axesHost.replaceChildren();
        this.statistics = null;
        this.statisticsIsCurrent = false;
        this.rangePreviews = { x: null, y: null };
        this.thresholdMarkers = null;
        this.labels = null;
        this.cells.clear();
        this.activeCell = null;
        this.histogram.replaceChildren();
        this.histogram.setAttribute("hidden", "");
        this.histogram.removeAttribute("aria-busy");
        this.histogramSummary.textContent = "";
        this.statisticsStatus.textContent = "";
        this.retryButton.hidden = true;
    }

    /**
     * Render one compact 2D legend through the same additive surface.
     *
     * @param {Object} state Current palette, labels, and coordinated styles.
     * @return {void}
     */
    #renderLegend(state) {
        const children = [];
        const cellSize = 100 / LEGEND_GRID_SIZE;
        for (let yIndex = 0; yIndex < LEGEND_GRID_SIZE; yIndex += 1) {
            for (let xIndex = 0; xIndex < LEGEND_GRID_SIZE; xIndex += 1) {
                const x = (xIndex + 0.5) / LEGEND_GRID_SIZE;
                const y = (yIndex + 0.5) / LEGEND_GRID_SIZE;
                const cell = svgElement(this.documentContext, "rect", {
                    x: xIndex * cellSize,
                    y: (LEGEND_GRID_SIZE - 1 - yIndex) * cellSize,
                    width: cellSize + 0.1,
                    height: cellSize + 0.1,
                });
                cell.style.fill = getBivariateColorForValues(
                    state.paletteName,
                    state.xStyle,
                    state.yStyle,
                    state.xStyle.minimum + x * (state.xStyle.maximum - state.xStyle.minimum),
                    state.yStyle.minimum + y * (state.yStyle.maximum - state.yStyle.minimum)
                );
                children.push(cell);
            }
        }
        const description =
            `Bivariate additive color encoding. Horizontal X axis ` +
            `${state.xLabel}, range ${formatRange(
                state.xStyle.minimum,
                state.xStyle.maximum
            )}. Vertical Y axis ${state.yLabel}, range ${formatRange(
                state.yStyle.minimum,
                state.yStyle.maximum
            )}. Channel clipping and finite RGB precision can make different ` +
            "value pairs share a displayed color.";
        const title = svgElement(this.documentContext, "title");
        title.textContent = description;
        this.legend.replaceChildren(title, ...children);
        this.legend.setAttribute("aria-label", description);
        this.legendXRange.textContent =
            `${state.xLabel}: ${formatRange(
                state.xStyle.minimum,
                state.xStyle.maximum
            )}`;
        this.legendYRange.textContent =
            `${state.yLabel}: ${formatRange(
                state.yStyle.minimum,
                state.yStyle.maximum
            )}`;
    }

    /**
     * Build one cell's axis ranges, count, and sample percentage.
     *
     * @param {number} xBin Zero-based X histogram bin.
     * @param {number} yBin Zero-based Y histogram bin.
     * @param {number} count Paired samples in the cell.
     * @return {string} Accessible paired-cell description.
     */
    #cellDescription(xBin, yBin, count) {
        const histogram = this.statistics.histogram;
        const percentage = count / this.statistics.pairedSampleCount * 100;
        return `${this.labels.xLabel} ${formatRange(
            histogram.xEdges[xBin],
            histogram.xEdges[xBin + 1]
        )}; ${this.labels.yLabel} ${formatRange(
            histogram.yEdges[yBin],
            histogram.yEdges[yBin + 1]
        )}; ${count.toLocaleString()} pixels (${percentage.toFixed(2)}%).`;
    }

    /**
     * Build the compact visible filename readout for one populated cell.
     *
     * @param {number} xBin Zero-based horizontal-raster histogram bin.
     * @param {number} yBin Zero-based vertical-raster histogram bin.
     * @param {number} count Paired pixels in the cell.
     * @return {string} Direct filename ranges, count, and percentage.
     */
    #compactCellDescription(xBin, yBin, count) {
        const histogram = this.statistics.histogram;
        const percentage = count / this.statistics.pairedSampleCount * 100;
        return `X ${formatHistogramBinRange(
            histogram.xEdges[xBin],
            histogram.xEdges[xBin + 1]
        )} · Y ${formatHistogramBinRange(
            histogram.yEdges[yBin],
            histogram.yEdges[yBin + 1]
        )} · ` +
            `${count.toLocaleString()} pixels (${percentage.toFixed(1)}%)`;
    }

    /**
     * Persist pointer, keyboard, or touch selection for useful inspection.
     *
     * @param {number} xBin Zero-based X histogram bin.
     * @param {number} yBin Zero-based Y histogram bin.
     * @param {string} summary Compact selected-cell summary.
     * @param {SVGElement} cell Selected SVG rectangle.
     * @return {void}
     */
    #selectCell(xBin, yBin, summary, cell) {
        this.activeCell?.classList.remove("is-selected", "is-sampled");
        this.activeCell = cell;
        cell.classList.add("is-selected");
        cell.dataset.xBin = String(xBin);
        cell.dataset.yBin = String(yBin);
        this.histogramSummary.textContent = summary;
    }

    /** Forward explicit overlay/bivariate selection. @return {void} */
    #handleModeChange() {
        this.handlers?.onBivariateModeChange(this.mode.value);
    }

    /** Forward one coordinated palette selection. @return {void} */
    #handlePaletteChange() {
        this.handlers?.onBivariatePaletteChange(this.palette.value);
    }

    /** Forward the deterministic X/Y role swap. @return {void} */
    #handleSwap() {
        this.handlers?.onBivariateSwapAxes();
    }

    /** Forward paired-statistics retry. @return {void} */
    #handleRetry() {
        this.handlers?.onRetryPairedStatistics();
    }
}
