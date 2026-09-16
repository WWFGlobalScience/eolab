/**
 * SVG presentation adapter for raster histograms.
 *
 * This module renders and clears the fixed-bin histogram from already
 * validated statistics and a committed raster style. Statistics loading,
 * percentile decisions, and broader controls visibility remain outside it.
 */
import {
    formatRasterPixelValue
} from "./value-format.js";
import { getRasterStyleColor } from "./style.js";
import { drawHistogramAxes, formatHistogramTick, histogramScales } from "./histogram-axes.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HISTOGRAM_CHART_WIDTH = 640;
const HISTOGRAM_CHART_HEIGHT = 190;
const HISTOGRAM_PLOT_HEIGHT = 116;
const HISTOGRAM_TOOLTIP_HEIGHT = 42;
const HISTOGRAM_TOOLTIP_MARGIN = 4;
const chartObservers = new WeakMap();

/**
 * Build the immediate in-chart presentation for one histogram bin.
 *
 * @param {Document} documentContext DOM document used to create SVG nodes.
 * @param {number} width Tooltip width fitted inside its chart.
 * @return {{element: SVGGElement, text: SVGTextElement, counts: SVGTextElement}} Tooltip elements.
 */
function createHistogramTooltip(documentContext, width) {
    const tooltip = documentContext.createElementNS(SVG_NAMESPACE, "g");
    tooltip.classList.add("raster-histogram-tooltip");
    tooltip.setAttribute("hidden", "");
    tooltip.setAttribute("aria-hidden", "true");
    const background = documentContext.createElementNS(
        SVG_NAMESPACE,
        "rect"
    );
    background.setAttribute("width", String(width));
    background.setAttribute("height", String(HISTOGRAM_TOOLTIP_HEIGHT));
    background.setAttribute("rx", "3");
    const text = documentContext.createElementNS(SVG_NAMESPACE, "text");
    text.setAttribute("x", "8");
    text.setAttribute("y", "16");
    const counts = documentContext.createElementNS(SVG_NAMESPACE, "text");
    counts.setAttribute("x", "8");
    counts.setAttribute("y", "32");
    tooltip.append(background, text, counts);
    return { element: tooltip, text, counts };
}

/**
 * Format one bin's compact hover readout.
 *
 * @param {number} minimum Inclusive lower bin edge.
 * @param {number} maximum Exclusive upper bin edge.
 * @param {number} offset Shared x-axis offset for tightly spaced large values.
 * @return {string} Immediate tooltip text.
 */
function formatHistogramBinTooltip(
    minimum,
    maximum,
    offset
) {
    const precision = (maximum - minimum) / 100;
    return `${formatHistogramTick(minimum - offset, precision)}–${
        formatHistogramTick(maximum - offset, precision)
    }${offset === 0 ? "" : " + axis offset"}`;
}

/**
 * Draw candidate style thresholds over a histogram without changing its data.
 *
 * @param {SVGSVGElement} chart Histogram chart element.
 * @param {Object} plot Plot coordinates in SVG units.
 * @param {Object} scales Validated histogram scales.
 * @param {Array<{label:string,value:number,color:string}>} markers Candidate
 * style thresholds.
 * @param {Document} documentContext DOM document; injectable for tests.
 * @return {void}
 */
function drawHistogramThresholdMarkers(
    chart,
    plot,
    scales,
    markers,
    documentContext
) {
    if (markers.length === 0) return;
    const group = documentContext.createElementNS(SVG_NAMESPACE, "g");
    group.classList.add("raster-histogram-thresholds");
    group.setAttribute("aria-hidden", "true");
    for (const marker of markers) {
        const fraction = scales.xAxis.position(marker.value);
        if (!Number.isFinite(fraction)) continue;
        const x = Math.max(
            plot.left,
            Math.min(
                plot.left + plot.width,
                plot.left + fraction * plot.width
            )
        );
        const outline = documentContext.createElementNS(SVG_NAMESPACE, "line");
        outline.classList.add("raster-histogram-threshold-outline");
        outline.setAttribute("x1", String(x));
        outline.setAttribute("x2", String(x));
        outline.setAttribute("y1", String(plot.top));
        outline.setAttribute("y2", String(plot.bottom));
        const line = documentContext.createElementNS(SVG_NAMESPACE, "line");
        line.classList.add("raster-histogram-threshold");
        line.setAttribute("x1", String(x));
        line.setAttribute("x2", String(x));
        line.setAttribute("y1", String(plot.top));
        line.setAttribute("y2", String(plot.bottom));
        line.style.stroke = marker.color;
        const label = documentContext.createElementNS(SVG_NAMESPACE, "text");
        label.classList.add("raster-histogram-threshold-label");
        label.setAttribute("x", String(x));
        label.setAttribute("y", String(plot.top + 11));
        label.textContent = marker.label.slice(0, 1).toUpperCase();
        group.append(outline, line, label);
    }
    chart.append(group);
}

/**
 * Render the validated fixed-bin distribution into its SVG chart.
 *
 * SVG elements do not implement HTMLElement.hidden, so visibility is changed
 * through the actual attribute that the stylesheet consumes.
 *
 * @param {SVGSVGElement} chart Histogram chart element.
 * @param {Object} statistics Validated raster statistics.
 * @param {Object} style Committed raster color-map style.
 * @param {Document} documentContext DOM document; injectable for tests.
 * @param {number} width Current chart content width in CSS pixels.
 * @param {string} valueLabel X-axis name including known units.
 * @param {Array<{label:string,value:number,color:string}>} markers Candidate
 * style thresholds.
 * @param {Object|null} axes Optional resolved x/y display transforms.
 * @return {void}
 */
function drawRasterHistogramChart(
    chart,
    statistics,
    style,
    documentContext,
    width,
    valueLabel,
    markers,
    axes
) {
    const { counts, edges } = statistics.histogram;
    const plot = { left: 48, top: 28, width: width - 60, height: HISTOGRAM_PLOT_HEIGHT, bottom: 28 + HISTOGRAM_PLOT_HEIGHT };
    const scales = histogramScales(statistics, plot.width, axes);
    const tooltipWidth = Math.min(360, width - 2 * HISTOGRAM_TOOLTIP_MARGIN);
    chart.setAttribute("viewBox", `0 0 ${width} ${HISTOGRAM_CHART_HEIGHT}`);
    chart.setAttribute("preserveAspectRatio", "none");
    chart.setAttribute("role", "img");
    const bars = [];
    const title = documentContext.createElementNS(SVG_NAMESPACE, "title");
    const provenance = statistics.estimated
        ? "Approximate sampled"
        : "Exact bounded";
    const markerDescription = markers.length === 0
        ? ""
        : " Style thresholds: " + markers.map((marker) =>
            `${marker.label} at ${formatRasterPixelValue(marker.value)}`
        ).join(", ") + ".";
    title.textContent =
        `${provenance} band 1 histogram with ${counts.length} bins from ` +
        `${statistics.validSampleCount.toLocaleString()} valid values. ` +
        `Values range from ${formatRasterPixelValue(
            statistics.sampleMinimum
        )} to ${formatRasterPixelValue(statistics.sampleMaximum)}; ` +
        `the 5th, 50th, and 95th percentiles are ${formatRasterPixelValue(
            statistics.percentiles.p05
        )}, ${formatRasterPixelValue(statistics.percentiles.p50)}, and ` +
        `${formatRasterPixelValue(statistics.percentiles.p95)}. ` +
        `Horizontal axis: ${valueLabel}${scales.offset === 0 ? "" : `, tick offset ${scales.offset}`}. ` +
        `Vertical axis: percentage of valid sampled pixels, from ${scales.yAxis.minimum} to ${scales.maximumPercent}%. ` +
        `X scale: ${scales.xAxis.scale}; Y scale: ${scales.yAxis.scale}. ` +
        markerDescription;
    chart.replaceChildren(title);
    drawHistogramAxes(chart, plot, scales, valueLabel, documentContext);
    for (const [binIndex, count] of counts.entries()) {
        const samplePercent = count / statistics.validSampleCount * 100;
        const interval = scales.xAxis.interval(edges[binIndex], edges[binIndex + 1]);
        if (interval === null) continue;
        const barHeight = Math.max(0, Math.min(1, scales.yAxis.position(samplePercent))) * plot.height;
        const x = plot.left + interval[0] * plot.width;
        const barWidth = (interval[1] - interval[0]) * plot.width;
        const bar = documentContext.createElementNS(SVG_NAMESPACE, "rect");
        bar.classList.add("raster-histogram-bar");
        if (samplePercent > scales.yAxis.maximum || samplePercent < scales.yAxis.minimum ||
            edges[binIndex] < scales.minimum || edges[binIndex + 1] > scales.maximum) {
            bar.classList.add("histogram-axis-clipped");
        }
        bar.setAttribute("x", String(x));
        bar.setAttribute(
            "y",
            String(plot.bottom - barHeight)
        );
        bar.setAttribute("width", String(barWidth * 0.9));
        bar.setAttribute("height", String(barHeight));
        const binMidpoint = (edges[binIndex] + edges[binIndex + 1]) / 2;
        bar.style.fill = getRasterStyleColor(style, binMidpoint);
        const binDescription =
            `Bin midpoint ${formatRasterPixelValue(binMidpoint)}; ` +
            `${samplePercent.toFixed(2)}% of the valid sample ` +
            `(${count.toLocaleString()} pixels). Value range ` +
            `${formatRasterPixelValue(edges[binIndex])} to ` +
            `${formatRasterPixelValue(edges[binIndex + 1])}.`;
        bar.setAttribute("aria-label", binDescription);
        chart.append(bar);
        bars.push({ binIndex, bar, center: x + barWidth * 0.45 });
    }
    drawHistogramThresholdMarkers(
        chart,
        plot,
        scales,
        markers,
        documentContext
    );
    const tooltip = createHistogramTooltip(documentContext, tooltipWidth);
    let activeBar = null;
    for (const { binIndex, bar, center } of bars) {
        const count = counts[binIndex];
        const samplePercent = count / statistics.validSampleCount * 100;
        const preferredTooltipX =
            center - tooltipWidth / 2;
        const tooltipX = Math.max(
            HISTOGRAM_TOOLTIP_MARGIN,
            Math.min(
                preferredTooltipX,
                width - tooltipWidth -
                HISTOGRAM_TOOLTIP_MARGIN
            )
        );
        bar.addEventListener("pointerenter", () => {
            activeBar?.classList.remove("is-hovered");
            activeBar = bar;
            activeBar.classList.add("is-hovered");
            tooltip.text.textContent = formatHistogramBinTooltip(
                edges[binIndex],
                edges[binIndex + 1],
                scales.offset
            );
            tooltip.counts.textContent = `${count.toLocaleString()} pixels · ${samplePercent.toFixed(2)}% of sample`;
            tooltip.element.setAttribute(
                "transform",
                `translate(${tooltipX} ${HISTOGRAM_TOOLTIP_MARGIN})`
            );
            tooltip.element.removeAttribute("hidden");
        });
        bar.addEventListener("pointerleave", () => {
            if (activeBar !== bar) {
                return;
            }
            activeBar.classList.remove("is-hovered");
            activeBar = null;
            tooltip.element.setAttribute("hidden", "");
        });
    }
    chart.append(tooltip.element);
    chart.setAttribute("aria-label", title.textContent);
    chart.removeAttribute("hidden");
}

/**
 * Render a self-contained responsive chart, including axes and coordinates.
 * Resize observation keeps fonts/margins in CSS pixels rather than shrinking
 * labels along with the bars. Re-render/clear disconnects the previous owner.
 * @param {SVGSVGElement} chart Histogram SVG (static or dynamically created).
 * @param {Object} statistics Validated current statistics, with nonempty bins.
 * @param {Object} style Committed raster color-map style.
 * @param {Document} [documentContext=globalThis.document] Owning DOM document.
 * @param {string} [valueLabel="Raster value"] X-axis label with known units.
 * @param {Array<{label:string,value:number,color:string}>} [markers=[]]
 * Candidate style thresholds drawn over the distribution.
 * @param {Object|null} [axes=null] Optional resolved x/y display transforms.
 * @return {void}
 * @throws {TypeError} If marker identity, value, or color is invalid.
 */
export function renderRasterHistogramChart(
    chart,
    statistics,
    style,
    documentContext = globalThis.document,
    valueLabel = "Raster value",
    markers = [],
    axes = null
) {
    if (
        !Array.isArray(markers) ||
        markers.some((marker) => (
            marker === null ||
            typeof marker !== "object" ||
            typeof marker.label !== "string" ||
            marker.label === "" ||
            !Number.isFinite(marker.value) ||
            !/^#[0-9a-f]{6}$/i.test(marker.color)
        ))
    ) {
        throw new TypeError("Raster histogram threshold markers are invalid");
    }
    clearRasterHistogramChart(chart);
    let width = Math.max(180, chart.clientWidth || HISTOGRAM_CHART_WIDTH);
    drawRasterHistogramChart(
        chart,
        statistics,
        style,
        documentContext,
        width,
        valueLabel,
        markers,
        axes
    );
    const Observer = documentContext.defaultView?.ResizeObserver;
    if (!Observer) return;
    /** Refit live coordinates; never redraw a replaced or cleared chart. */
    const observer = new Observer(entries => {
        if (chartObservers.get(chart) !== observer) return;
        const nextWidth = entries[0]?.contentRect.width;
        // Ignore hidden/detached charts; they redraw when visible again.
        if (!(nextWidth > 0) || Math.abs(nextWidth - width) < 0.5) return;
        width = Math.max(180, nextWidth);
        drawRasterHistogramChart(
            chart,
            statistics,
            style,
            documentContext,
            width,
            valueLabel,
            markers,
            axes
        );
    });
    chartObservers.set(chart, observer);
    observer.observe(chart);
}

/**
 * Remove a histogram and hide its SVG through the SVG attribute contract.
 *
 * @param {SVGSVGElement} chart Histogram chart element.
 * @return {void}
 */
export function clearRasterHistogramChart(chart) {
    chartObservers.get(chart)?.disconnect();
    chartObservers.delete(chart);
    chart.replaceChildren();
    chart.setAttribute("hidden", "");
}
