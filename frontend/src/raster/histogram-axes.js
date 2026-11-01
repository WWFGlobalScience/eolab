/** Compute scales, tick text and unit labels for single-band histograms. */

import { createHistogramAxis } from "./histogram-axis-scale.js";

/**
 * Format a tick with enough precision for its spacing, without scientific
 * notation for ordinary values or floating-point tails around zero.
 * @param {number} value Tick value.
 * @param {number} step Distance between adjacent ticks.
 * @return {string} Compact, distinct numeric label.
 */
export function formatHistogramTick(value, step) {
    if (Math.abs(value) < Math.abs(step) * 1e-8 || value === 0) return "0";
    const magnitude = Math.floor(Math.log10(Math.abs(value)));
    const precision = Math.min(15, Math.max(0, magnitude - Math.floor(Math.log10(step)) + 1));
    if (Math.abs(value) >= 1e6 || Math.abs(value) < 0.001) {
        const [mantissa, exponent] = value.toExponential(Math.max(1, precision)).split("e");
        return `${Number(mantissa)}e${Number(exponent)}`;
    }
    return String(Number(value.toFixed(Math.min(15, Math.max(0, 1 - Math.floor(Math.log10(step)))))));
}

/**
 * Name the value axis from the analyzed data asset's explicit band metadata.
 * Never infer units from a filename or from unrelated assets.
 * @param {Object|null} item Catalog Item; only its first data band is analyzed.
 * @return {string} Axis label, including units only when provided.
 */
export function getHistogramValueLabel(item) {
    const unit = item?.assets?.data?.["raster:bands"]?.[0]?.unit;
    return typeof unit === "string" && unit.trim() !== ""
        ? `Raster value (${unit.trim()})` : "Raster value";
}

/**
 * Create linear x ticks and a zero-based percentage scale for one chart.
 * Actual bin edges, not sample extrema, define the x domain (including padded
 * constant-value bins). A labeled offset preserves small differences around
 * large values without overlapping long tick labels.
 * @param {Object} statistics Validated histogram counts and edges.
 * @param {number} plotWidth Horizontal drawing space in CSS pixels.
 * @param {Object|null} [axes=null] Resolved display-only x/y transforms.
 * @return {Object} X domain, positioned labels, optional offset, and y maximum.
 */
export function histogramScales(statistics, plotWidth, axes = null) {
    const { counts, edges } = statistics.histogram;
    const distribution = { edges, counts, total: statistics.validSampleCount };
    const xAxis = axes?.x ?? createHistogramAxis(distribution);
    const yAxis = axes?.y ?? createHistogramAxis({ ...distribution, frequency: true, nice: true });
    const { minimum, maximum, offset } = xAxis;
    const span = maximum - minimum;
    /** Format a fractional position; intervals determine numeric precision. */
    const label = (fraction, intervals) => formatHistogramTick(
        xAxis.valueAt(fraction) - offset, xAxis.scale === "log" ? xAxis.valueAt(fraction) / 10 : span / intervals
    );
    const longest = Math.max(...[0, 0.25, 0.5, 0.75, 1].map(fraction => label(fraction, 4).length));
    const intervals = plotWidth >= 4 * (longest * 7 + 16) ? 4 : 2;
    const ticks = Array.from({ length: intervals + 1 }, (_, index) => ({
        fraction: index / intervals, label: label(index / intervals, intervals),
    }));
    return { minimum, maximum, span, offset, ticks, maximumPercent: yAxis.maximum, xAxis, yAxis };
}
