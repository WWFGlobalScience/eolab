/**
 * Validate raster statistics and estimate percentile values from histograms.
 *
 * This module validates the analysis API's statistics contract, determines
 * whether results match the active whole-raster or selected-area scope, and
 * estimates values from histogram percentiles. It performs no I/O or rendering.
 */
import { validateRasterSelectedBounds } from "./geometry.js";
import { normalizeSamplingBox, samplingBoxesEqual } from "../sampling-box.js";
import { validateCategoricalDistribution } from "./categorical-statistics.js";

/** Default histogram percentiles used to derive raster color thresholds. */
export const DEFAULT_RASTER_PERCENTILES = Object.freeze({
    lower: 5,
    middle: 50,
    upper: 95
});

import { vectorSelectionsEqual, normalizeRasterSamplingArea, WHOLE_RASTER_SAMPLING_AREA } from "../selected-area.js";
export { normalizeRasterSamplingArea, WHOLE_RASTER_SAMPLING_AREA } from "../selected-area.js";

/**
 * Build a stable error for a malformed statistics response.
 *
 * @param {string} detail Name of the response contract that failed.
 * @return {Error} User-safe response validation error.
 */
function rasterStatisticsContractError(detail) {
    return new Error(`Raster statistics returned invalid ${detail}.`);
}

/**
 * Test whether a value is a positive integer.
 *
 * @param {*} value Candidate value.
 * @return {boolean} Whether value is an integer greater than zero.
 */
function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

/**
 * Check a raster statistics response's sampling area, counts, bins and numeric values.
 *
 * @param {Object} statistics Candidate response from EOLab.
 * @return {Object} The validated response.
 * @throws {Error} If the document violates the analysis API contract.
 */
export function validateRasterStatistics(statistics) {
    if (statistics === null || typeof statistics !== "object") {
        throw rasterStatisticsContractError("response data");
    }
    if (statistics.band !== 1) {
        throw rasterStatisticsContractError("band identity");
    }
    const catalogSelection = statistics.catalogSelection ?? null;
    const samplingBox = statistics.samplingBox ?? null;
    if ((statistics.scope === "samplingBox") !== (samplingBox !== null)) throw rasterStatisticsContractError("sampling-box scope");
    if (samplingBox) normalizeSamplingBox(samplingBox);
    const hasValidCatalogSelectionId =
        catalogSelection !== null && !!normalizeRasterSamplingArea({ kind: "catalogSelection", catalogSelection });
    if (
        statistics.scope === "wholeRaster" &&
        (statistics.selectedBounds !== null || catalogSelection !== null)
    ) {
        throw rasterStatisticsContractError("whole-raster scope");
    }
    if (statistics.scope === "selectedArea") {
        validateRasterSelectedBounds(statistics.selectedBounds);
        if (catalogSelection !== null) {
            throw rasterStatisticsContractError("selected-area scope");
        }
    } else if (statistics.scope === "catalogSelection") {
        if (statistics.selectedBounds !== null || !hasValidCatalogSelectionId) {
            throw rasterStatisticsContractError("catalog-selection scope");
        }
    } else if (statistics.scope === "samplingBox") {
        if (statistics.selectedBounds !== null || catalogSelection !== null) throw rasterStatisticsContractError("sampling-box scope");
    } else if (statistics.scope !== "wholeRaster") {
        throw rasterStatisticsContractError("statistics scope");
    }

    const dimensions = [
        statistics.sourceWidth,
        statistics.sourceHeight,
        statistics.sourcePixelCount,
        statistics.sampleWidth,
        statistics.sampleHeight,
        statistics.sampledPixelCount,
        statistics.validSampleCount
    ];
    if (!dimensions.every(isPositiveInteger)) {
        throw rasterStatisticsContractError("sample dimensions");
    }
    if (
        statistics.sampleWidth > statistics.sourceWidth ||
        statistics.sampleHeight > statistics.sourceHeight ||
        statistics.sampleWidth > 512 ||
        statistics.sampleHeight > 512 ||
        statistics.sourcePixelCount !==
            statistics.sourceWidth * statistics.sourceHeight ||
        statistics.sampledPixelCount !==
            statistics.sampleWidth * statistics.sampleHeight ||
        statistics.validSampleCount > statistics.sampledPixelCount
    ) {
        throw rasterStatisticsContractError("sample counts");
    }
    if (typeof statistics.estimated !== "boolean") {
        throw rasterStatisticsContractError("estimate metadata");
    }
    if (
        !["sampleGrid", "exactSourceWindow"].includes(
            statistics.samplingMethod
        ) ||
        statistics.estimated !== (statistics.samplingMethod === "sampleGrid")
    ) {
        throw rasterStatisticsContractError("sampling provenance");
    }
    if (
        statistics.samplingMethod === "sampleGrid" &&
        Math.max(statistics.sampleWidth, statistics.sampleHeight) > 127
    ) {
        throw rasterStatisticsContractError("sample-grid bounds");
    }
    if (
        statistics.samplingMethod === "exactSourceWindow" &&
        (
            statistics.sampleWidth !== statistics.sourceWidth ||
            statistics.sampleHeight !== statistics.sourceHeight
        )
    ) {
        throw rasterStatisticsContractError("exact-window dimensions");
    }

    const sampleValues = [
        statistics.sampleMinimum,
        statistics.sampleMaximum,
        statistics.percentiles?.p05,
        statistics.percentiles?.p50,
        statistics.percentiles?.p95
    ];
    if (!sampleValues.every(Number.isFinite)) {
        throw rasterStatisticsContractError("sample values");
    }
    const [sampleMinimum, sampleMaximum, p05, p50, p95] = sampleValues;
    if (!(
        sampleMinimum <= p05 &&
        p05 <= p50 &&
        p50 <= p95 &&
        p95 <= sampleMaximum
    )) {
        throw rasterStatisticsContractError("percentile order");
    }

    const counts = statistics.histogram?.counts;
    const edges = statistics.histogram?.edges;
    if (
        !Array.isArray(counts) ||
        counts.length !== 64 ||
        !counts.every((count) => Number.isInteger(count) && count >= 0) ||
        counts.reduce((total, count) => total + count, 0) !==
            statistics.validSampleCount
    ) {
        throw rasterStatisticsContractError("histogram counts");
    }
    if (
        !Array.isArray(edges) ||
        edges.length !== counts.length + 1 ||
        !edges.every(Number.isFinite) ||
        !edges.slice(1).every((edge, index) => edge > edges[index]) ||
        edges[0] > sampleMinimum ||
        edges.at(-1) < sampleMaximum
    ) {
        throw rasterStatisticsContractError("histogram edges");
    }

    const suggestedRange = statistics.suggestedRange;
    if (
        suggestedRange === null ||
        typeof suggestedRange !== "object" ||
        ![
            suggestedRange.minimum,
            suggestedRange.midpoint,
            suggestedRange.maximum
        ].every(Number.isFinite) ||
        !(
            suggestedRange.minimum < suggestedRange.midpoint &&
            suggestedRange.midpoint < suggestedRange.maximum
        )
    ) {
        throw rasterStatisticsContractError("suggested range");
    }
    if (statistics.categoricalDistribution != null) {
        validateCategoricalDistribution(statistics.categoricalDistribution);
    }
    return statistics;
}

/**
 * Validate that statistics describe the exact scope requested by the client.
 *
 * @param {Object} statistics Candidate analysis API response.
 * @param {Object} samplingArea Normalized requested sampling-area union.
 * @return {Object} The validated response for the requested scope.
 * @throws {Error} If the response data, scope, or selected bounds differ.
 */
export function validateRasterStatisticsForSelection(
    statistics,
    samplingArea
) {
    const normalizedArea = normalizeRasterSamplingArea(samplingArea);
    const validatedStatistics = validateRasterStatistics(statistics);
    if (
        normalizedArea.kind === "wholeRaster" &&
        validatedStatistics.scope !== "wholeRaster"
    ) {
        throw rasterStatisticsContractError("whole-raster response scope");
    }
    if (normalizedArea.kind === "selectedArea") {
        if (validatedStatistics.scope !== "selectedArea") {
            throw rasterStatisticsContractError("selected-area response scope");
        }
        for (const fieldName of ["west", "south", "east", "north"]) {
            if (
                validatedStatistics.selectedBounds[fieldName] !==
                normalizedArea.selectedBounds[fieldName]
            ) {
                throw rasterStatisticsContractError(
                    "selected-area response bounds"
                );
            }
        }
    }
    if (normalizedArea.kind === "samplingBox" && (validatedStatistics.scope !== "samplingBox" ||
        !samplingBoxesEqual(validatedStatistics.samplingBox, normalizedArea.samplingBox))) {
        throw rasterStatisticsContractError("sampling-box response identity");
    }
    if (
        normalizedArea.kind === "catalogSelection" &&
        (
            validatedStatistics.scope !== "catalogSelection" ||
            !vectorSelectionsEqual(validatedStatistics.catalogSelection, normalizedArea.catalogSelection)
        )
    ) {
        throw rasterStatisticsContractError("catalog-selection response identity");
    }
    return validatedStatistics;
}

/**
 * Return whether one distribution belongs to the active histogram scope.
 *
 * @param {Object} statistics Validated raster statistics.
 * @param {Object} samplingArea Normalized active sampling-area union.
 * @return {boolean} Whether statistics describe the active scope exactly.
 */
export function rasterStatisticsMatchesSelection(
    statistics,
    samplingArea
) {
    const normalizedArea = normalizeRasterSamplingArea(samplingArea);
    if (normalizedArea.kind === "catalogSelection") {
        return (
            statistics.scope === "catalogSelection" &&
            vectorSelectionsEqual(statistics.catalogSelection, normalizedArea.catalogSelection)
        );
    }
    if (normalizedArea.kind === "wholeRaster") {
        return statistics.scope === "wholeRaster";
    }
    if (normalizedArea.kind === "samplingBox") return statistics.scope === "samplingBox" &&
        samplingBoxesEqual(statistics.samplingBox, normalizedArea.samplingBox);
    return (
        statistics.scope === "selectedArea" &&
        ["west", "south", "east", "north"].every(
            (fieldName) =>
                statistics.selectedBounds?.[fieldName] ===
                normalizedArea.selectedBounds[fieldName]
        )
    );
}

/**
 * Estimate one percentile from the validated fixed-bin histogram.
 *
 * Exact p05, p50, and p95 sample percentiles are retained from the backend;
 * other positions are interpolated within the containing histogram bin.
 *
 * @param {Object} statistics Validated raster statistics.
 * @param {number} percentile Percentile from 0 through 100.
 * @return {number} Approximate value used by histogram analysis.
 * @throws {Error} If percentile is nonfinite or outside 0-100.
 */
export function estimateRasterHistogramPercentile(statistics, percentile) {
    if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
        throw new Error("Raster percentile must be between 0 and 100.");
    }
    if (statistics.sampleMinimum === statistics.sampleMaximum) {
        return statistics.sampleMinimum;
    }
    if (percentile === 0) {
        return statistics.sampleMinimum;
    }
    if (percentile === 5) {
        return statistics.percentiles.p05;
    }
    if (percentile === 50) {
        return statistics.percentiles.p50;
    }
    if (percentile === 95) {
        return statistics.percentiles.p95;
    }
    if (percentile === 100) {
        return statistics.sampleMaximum;
    }

    const value = estimateHistogramPercentile(
        statistics.histogram, statistics.validSampleCount,
        statistics.sampleMinimum, statistics.sampleMaximum, percentile
    );
    let lowerBound = statistics.sampleMinimum;
    let upperBound = statistics.percentiles.p05;
    if (percentile > 5 && percentile < 50) {
        lowerBound = statistics.percentiles.p05;
        upperBound = statistics.percentiles.p50;
    } else if (percentile > 50 && percentile < 95) {
        lowerBound = statistics.percentiles.p50;
        upperBound = statistics.percentiles.p95;
    } else if (percentile > 95) {
        lowerBound = statistics.percentiles.p95;
        upperBound = statistics.sampleMaximum;
    }
    return Math.max(lowerBound, Math.min(upperBound, value));
}

/**
 * Interpolate a percentile from a validated histogram or paired marginal.
 * No exact quantiles are implied by these fixed-bin estimates.
 *
 * @param {{counts:number[],edges:number[]}} histogram Validated distribution.
 * @param {number} sampleCount Positive total count.
 * @param {number} minimum Observed sample minimum.
 * @param {number} maximum Observed sample maximum.
 * @param {number} percentile Percentile from zero through 100.
 * @return {number} Estimate clamped to the observed sample range.
 * @throws {Error} If the requested percentile is invalid.
 */
export function estimateHistogramPercentile(
    histogram, sampleCount, minimum, maximum, percentile
) {
    if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
        throw new Error("Raster percentile must be between 0 and 100.");
    }
    if (minimum === maximum || percentile === 0) return minimum;
    if (percentile === 100) return maximum;
    const { counts, edges } = histogram;
    const target = sampleCount * percentile / 100;
    let cumulative = 0;
    for (let binIndex = 0; binIndex < counts.length; binIndex += 1) {
        const nextCumulative = cumulative + counts[binIndex];
        if (target <= nextCumulative && counts[binIndex] > 0) {
            const fraction = (target - cumulative) / counts[binIndex];
            const value = edges[binIndex] +
                fraction * (edges[binIndex + 1] - edges[binIndex]);
            return Math.max(minimum, Math.min(maximum, value));
        }
        cumulative = nextCumulative;
    }
    return maximum;
}
