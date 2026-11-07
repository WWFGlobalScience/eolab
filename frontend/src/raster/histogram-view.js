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
import { scaleLinear } from "d3";
import { bindChartInspection, createChartTooltip, drawChartAxes } from "../charts/chart-presentation.js";
import { formatHistogramTick, histogramScales } from "./histogram-axes.js";
import { appendHistogramThresholdMarkers } from "./histogram-threshold-markers.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HISTOGRAM_CHART_WIDTH = 640;
const HISTOGRAM_CHART_HEIGHT = 190;
const HISTOGRAM_PLOT_HEIGHT = 116;
const chartObservers = new WeakMap();

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
 * Draw candidate style thresholds above the plot.
 *
 * @param {SVGSVGElement} chart Histogram chart element.
 * @param {Object} plot Plot coordinates in SVG units.
 * @param {Object} scales Validated histogram scales.
 * @param {Array<{label:string,value:number,color:string}>} markers Candidate
 * style thresholds.
 * @param {Document} documentContext DOM document; injectable for tests.
 * @return {SVGElement[]} Focusable threshold markers.
 */
function drawHistogramThresholdMarkers(
    chart,
    plot,
    scales,
    markers,
    documentContext
) {
    if (markers.length === 0) return [];
    const group = documentContext.createElementNS(SVG_NAMESPACE, "g");
    group.classList.add("raster-histogram-thresholds");
    const right = plot.left + plot.width;
    const projected = markers.flatMap((marker, index) => {
        const fraction = scales.xAxis.position(marker.value);
        return Number.isFinite(fraction) ? [{
            ...marker, id: String(index), label: marker.label.slice(0, 1).toUpperCase(),
            description: `${marker.label} at ${formatRasterPixelValue(marker.value)}`,
            position: Math.max(plot.left, Math.min(right, plot.left + fraction * plot.width)),
        }] : [];
    });
    const targets = appendHistogramThresholdMarkers(documentContext, group, projected, {
        axis: "x", edge: plot.top, guideEnd: plot.bottom, minimum: plot.left, maximum: right, glyphSize: 10,
    });
    chart.append(group);
    return targets;
}

/**
 * Render the validated bins and retain keyboard focus through redraws.
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
    const focusedElement = chart.contains(documentContext.activeElement) ? documentContext.activeElement : null;
    const focusedBin = focusedElement?.getAttribute("data-bin-index");
    const focusedMarker = focusedElement?.getAttribute("data-threshold-id");
    const { counts, edges } = statistics.histogram;
    const plot = { left: 48, top: 28, width: width - 60, height: HISTOGRAM_PLOT_HEIGHT, bottom: 28 + HISTOGRAM_PLOT_HEIGHT };
    const scales = histogramScales(statistics, plot.width, axes);
    chart.setAttribute("viewBox", `0 0 ${width} ${HISTOGRAM_CHART_HEIGHT}`);
    chart.setAttribute("preserveAspectRatio", "none");
    chart.setAttribute("role", "group");
    chart.setAttribute("tabindex", "-1");
    const bars = [];
    const title = documentContext.createElementNS(SVG_NAMESPACE, "title");
    const provenance = statistics.estimated
        ? "Approximate sampled"
        : "Exact bounded";
    const markerDescription = markers.length === 0
        ? ""
        : " Markers: " + markers.map((marker) =>
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
    const yTicks = [0, 0.5, 1];
    drawChartAxes(documentContext, chart, plot,
        {scale: scaleLinear([0, 1], [plot.left, plot.left + plot.width]), values: scales.ticks.map(tick => tick.fraction),
            format: fraction => scales.ticks.find(tick => tick.fraction === fraction).label, edgeLabels: true},
        {scale: scaleLinear([0, 1], [plot.bottom, plot.top]), values: yTicks,
            format: fraction => formatHistogramTick(scales.yAxis.valueAt(fraction), scales.yAxis.scale === "log" ?
                scales.yAxis.valueAt(fraction) / 10 : (scales.yAxis.maximum - scales.yAxis.minimum) / 2)}, [
            {text: `Sampled pixels (%)${scales.yAxis.scale === "log" ? " · log" : ""}`, x: plot.left, y: markers.length ? 12 : 15, anchor: "start"},
            {text: (scales.offset === 0 ? valueLabel : `${valueLabel} (offset ${scales.offset >= 0 ? "+" : ""}${scales.offset})`) +
                (scales.xAxis.scale === "log" ? " · log" : ""), x: plot.left + plot.width / 2, y: plot.bottom + 38},
        ]);
    for (const [binIndex, count] of counts.entries()) {
        const samplePercent = count / statistics.validSampleCount * 100;
        const interval = scales.xAxis.interval(edges[binIndex], edges[binIndex + 1]);
        if (interval === null) continue;
        const barHeight = Math.max(0, Math.min(1, scales.yAxis.position(samplePercent))) * plot.height;
        const x = plot.left + interval[0] * plot.width;
        const barWidth = (interval[1] - interval[0]) * plot.width;
        const bar = documentContext.createElementNS(SVG_NAMESPACE, "rect");
        bar.classList.add("raster-histogram-bar");
        bar.setAttribute("tabindex", "0");
        bar.setAttribute("role", "img");
        bar.setAttribute("data-bin-index", String(binIndex));
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
    const thresholdTargets = drawHistogramThresholdMarkers(
        chart,
        plot,
        scales,
        markers,
        documentContext
    );
    const tooltip = createChartTooltip(documentContext, chart);
    let activeBar = null;
    const inspectionState = {focused: null, hovered: null};
    /** Show one bin's exact counts through the shared chart inspection contract.
     * @param {{binIndex:number,bar:SVGRectElement,center:number}|null} inspection Inspected bin, or dismissal.
     * @return {void}
     */
    const inspectBin = inspection => {
        activeBar?.classList.remove("is-hovered");
        activeBar = inspection?.bar ?? null;
        if (!inspection) { tooltip.hide(); return; }
        activeBar.classList.add("is-hovered");
        const {binIndex, center} = inspection;
        const count = counts[binIndex];
        tooltip.show(formatHistogramBinTooltip(edges[binIndex], edges[binIndex + 1], scales.offset) + "\n" +
            `${count.toLocaleString()} pixels · ${(count / statistics.validSampleCount * 100).toFixed(2)}% of sample`, center);
    };
    for (const { binIndex, bar, center } of bars) {
        bindChartInspection(bar, {binIndex, bar, center}, inspectBin, inspectionState);
    }
    chart.setAttribute("aria-label", title.textContent);
    chart.removeAttribute("hidden");
    if (focusedMarker != null) {
        (thresholdTargets.find(marker => marker.getAttribute("data-threshold-id") === focusedMarker) ?? chart)
            .focus({preventScroll: true});
    } else if (focusedBin != null) {
        (bars.find(item => String(item.binIndex) === focusedBin)?.bar ?? chart).focus({preventScroll: true});
    }
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
    chartObservers.get(chart)?.disconnect();
    chartObservers.delete(chart);
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
