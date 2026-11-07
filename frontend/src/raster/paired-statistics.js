/** Domain validation and lookup helpers for paired raster statistics. */
import { polygonAreaReferencesEqual, validatePolygonAreaReference, vectorSelectionsEqual, normalizeRasterSamplingArea } from "../selected-area.js";
import { validateRasterSelectedBounds } from "./geometry.js";
import { normalizeSamplingBox, samplingBoxesEqual } from "../sampling-box.js";
import { estimateHistogramPercentile } from "./statistics.js";

export const RASTER_PAIRED_HISTOGRAM_BIN_COUNT = 32;
export const RASTER_PAIRED_SAMPLE_GRID_MAX_DIMENSION = 127;
export const WHOLE_RASTER_OVERLAP_SAMPLING_AREA = Object.freeze({
    kind: "wholeOverlap",
});

/**
 * Estimate a percentile from one marginal of the current paired sample.
 * Only cells valid in both rasters contribute, exactly as in the 2D chart.
 *
 * @param {Object} statistics Validated paired-statistics response.
 * @param {"x"|"y"} axis Ordered paired axis.
 * @param {number} percentile Requested percentile from zero through 100.
 * @return {number} Bounded histogram estimate, not an exact quantile.
 * @throws {Error} If the axis or percentile is invalid.
 */
export function estimateRasterPairedHistogramPercentile(statistics, axis, percentile) {
    if (axis !== "x" && axis !== "y") throw new Error("Unknown paired axis.");
    return estimateHistogramPercentile({
        counts: statistics.histogram[`${axis}MarginalCounts`],
        edges: statistics.histogram[`${axis}Edges`],
    }, statistics.pairedSampleCount, statistics[`${axis}Minimum`],
    statistics[`${axis}Maximum`], percentile);
}

/**
 * Normalize the paired statistics sampling-area union.
 *
 * @param {Object} samplingArea Whole overlap, WGS 84 rectangle, geodesic box, filtered vector source or private polygon reference.
 * @return {Readonly<Object>} Immutable normalized sampling-area value.
 * @throws {TypeError|RangeError} If fields or a box boundary fall outside the paired public contract.
 */
export function normalizeRasterPairedSamplingArea(samplingArea) {
    if (["catalogSelection", "samplingBox", "polygonArea"].includes(samplingArea?.kind)) return normalizeRasterSamplingArea(samplingArea);
    if (
        samplingArea?.kind === "wholeOverlap" &&
        Object.keys(samplingArea).length === 1
    ) {
        return WHOLE_RASTER_OVERLAP_SAMPLING_AREA;
    }
    if (
        samplingArea?.kind === "selectedArea" &&
        Object.keys(samplingArea).length === 2
    ) {
        validateRasterSelectedBounds(samplingArea.selectedBounds);
        return Object.freeze({
            kind: "selectedArea",
            selectedBounds: Object.freeze({ ...samplingArea.selectedBounds }),
        });
    }
    throw new TypeError("Paired raster sampling area is invalid.");
}

/**
 * Build one stable paired-response contract error.
 *
 * @param {string} detail Invalid response aspect.
 * @return {Error} User-safe response contract error.
 */
function pairedContractError(detail) {
    return new Error(`Paired raster statistics returned invalid ${detail}.`);
}

/**
 * Return whether an array contains only nonnegative safe integers.
 *
 * @param {unknown} values Candidate count array.
 * @param {number} expectedLength Required fixed array length.
 * @return {boolean} Whether the count-array contract is satisfied.
 */
function isCountArray(values, expectedLength) {
    return Array.isArray(values) && values.length === expectedLength &&
        values.every((value) => Number.isSafeInteger(value) && value >= 0);
}

/**
 * Return whether finite edges are strictly increasing.
 *
 * @param {unknown} values Candidate fixed edge array.
 * @return {boolean} Whether the fixed edge-array contract is satisfied.
 */
function isEdgeArray(values) {
    return Array.isArray(values) &&
        values.length === RASTER_PAIRED_HISTOGRAM_BIN_COUNT + 1 &&
        values.every(Number.isFinite) &&
        values.slice(1).every((value, index) => value > values[index]);
}

/**
 * Validate one bounded paired-statistics response document.
 *
 * @param {Object} statistics Parsed response document.
 * @return {Object} The same validated response.
 * @throws {Error} If dimensions, provenance, matrix, or marginals disagree.
 */
export function validateRasterPairedStatistics(statistics) {
    if (statistics === null || typeof statistics !== "object") {
        throw pairedContractError("response data");
    }
    if (
        !["wholeOverlap", "selectedArea", "catalogSelection", "samplingBox", "polygonArea"].includes(statistics.scope) ||
        statistics.referenceGrid !== "x" ||
        statistics.resampling !== "nearest" ||
        !["sampleGrid", "exactReferenceGrid"].includes(
            statistics.samplingMethod
        ) ||
        statistics.approximate !==
            (statistics.samplingMethod === "sampleGrid")
    ) {
        throw pairedContractError("sampling provenance");
    }
    if ((statistics.scope === "catalogSelection") !== (statistics.catalogSelection != null)) throw pairedContractError("catalog selection scope");
    if (statistics.scope === "catalogSelection") normalizeRasterSamplingArea({ kind: "catalogSelection", catalogSelection: statistics.catalogSelection });
    if ((statistics.scope === "polygonArea") !== (statistics.polygonArea != null)) throw pairedContractError("polygon-area scope");
    if (statistics.scope === "polygonArea") validatePolygonAreaReference(statistics.polygonArea);
    if ((statistics.scope === "samplingBox") !== (statistics.samplingBox != null)) throw pairedContractError("sampling-box scope");
    if (statistics.samplingBox) normalizeSamplingBox(statistics.samplingBox);
    const hasBounds = statistics.selectedBounds !== null;
    if ((statistics.scope === "selectedArea") !== hasBounds) {
        throw pairedContractError("scope");
    }
    if (hasBounds) {
        validateRasterSelectedBounds(statistics.selectedBounds);
    }
    const dimensions = [
        statistics.sourceWidth,
        statistics.sourceHeight,
        statistics.sourcePixelCount,
        statistics.sampleWidth,
        statistics.sampleHeight,
        statistics.sampledCellCount,
        statistics.pairedSampleCount,
    ];
    if (!dimensions.every(
        (value) => Number.isSafeInteger(value) && value > 0
    )) {
        throw pairedContractError("sample dimensions");
    }
    if (
        statistics.sourcePixelCount !==
            statistics.sourceWidth * statistics.sourceHeight ||
        statistics.sampledCellCount !==
            statistics.sampleWidth * statistics.sampleHeight ||
        statistics.sampleWidth > statistics.sourceWidth ||
        statistics.sampleHeight > statistics.sourceHeight ||
        statistics.sampleWidth > RASTER_PAIRED_SAMPLE_GRID_MAX_DIMENSION ||
        statistics.sampleHeight > RASTER_PAIRED_SAMPLE_GRID_MAX_DIMENSION ||
        statistics.pairedSampleCount > statistics.sampledCellCount ||
        (
            statistics.samplingMethod === "exactReferenceGrid" &&
            (
                statistics.sampleWidth !== statistics.sourceWidth ||
                statistics.sampleHeight !== statistics.sourceHeight
            )
        )
    ) {
        throw pairedContractError("sample counts");
    }
    const ranges = [
        statistics.xMinimum,
        statistics.xMaximum,
        statistics.yMinimum,
        statistics.yMaximum,
    ];
    if (
        !ranges.every(Number.isFinite) ||
        statistics.xMinimum > statistics.xMaximum ||
        statistics.yMinimum > statistics.yMaximum
    ) {
        throw pairedContractError("axis ranges");
    }
    const histogram = statistics.histogram;
    const binCount = RASTER_PAIRED_HISTOGRAM_BIN_COUNT;
    if (
        histogram === null || typeof histogram !== "object" ||
        !isEdgeArray(histogram.xEdges) ||
        !isEdgeArray(histogram.yEdges) ||
        !Array.isArray(histogram.counts) ||
        histogram.counts.length !== binCount ||
        !histogram.counts.every((row) => isCountArray(row, binCount)) ||
        !isCountArray(histogram.xMarginalCounts, binCount) ||
        !isCountArray(histogram.yMarginalCounts, binCount)
    ) {
        throw pairedContractError("histogram dimensions");
    }
    const xMarginals = Array.from({ length: binCount }, (_, column) =>
        histogram.counts.reduce((sum, row) => sum + row[column], 0)
    );
    const yMarginals = histogram.counts.map((row) =>
        row.reduce((sum, count) => sum + count, 0)
    );
    if (
        !xMarginals.every(
            (count, index) => count === histogram.xMarginalCounts[index]
        ) ||
        !yMarginals.every(
            (count, index) => count === histogram.yMarginalCounts[index]
        ) ||
        xMarginals.reduce((sum, count) => sum + count, 0) !==
            statistics.pairedSampleCount ||
        histogram.xEdges[0] > statistics.xMinimum ||
        histogram.xEdges.at(-1) < statistics.xMaximum ||
        histogram.yEdges[0] > statistics.yMinimum ||
        histogram.yEdges.at(-1) < statistics.yMaximum
    ) {
        throw pairedContractError("histogram totals");
    }
    return statistics;
}

/**
 * Require a response to match the exact paired area requested by the browser.
 *
 * @param {Object} statistics Candidate response document.
 * @param {Object} samplingArea Requested paired sampling-area union.
 * @return {Object} Validated matching response.
 * @throws {Error} If the response describes another area.
 */
export function validateRasterPairedStatisticsForSelection(
    statistics,
    samplingArea,
) {
    const validated = validateRasterPairedStatistics(statistics);
    const area = normalizeRasterPairedSamplingArea(samplingArea);
    if (area.kind === "polygonArea") {
        if (validated.scope !== "polygonArea" || !polygonAreaReferencesEqual(validated.polygonArea, area.polygonArea)) throw pairedContractError("polygon-area identity");
        return validated;
    }
    if (area.kind === "catalogSelection") {
        if (validated.scope !== "catalogSelection" || !vectorSelectionsEqual(validated.catalogSelection, area.catalogSelection)) throw pairedContractError("catalog selection identity");
        return validated;
    }
    if (area.kind === "samplingBox") {
        if (validated.scope !== "samplingBox" || !samplingBoxesEqual(validated.samplingBox,area.samplingBox)) throw pairedContractError("sampling-box response identity");
        return validated;
    }
    if (area.kind === "wholeOverlap") {
        if (validated.scope !== "wholeOverlap") {
            throw pairedContractError("whole-overlap response scope");
        }
        return validated;
    }
    if (
        validated.scope !== "selectedArea" ||
        ["west", "south", "east", "north"].some(
            (field) => validated.selectedBounds[field] !==
                area.selectedBounds[field]
        )
    ) {
        throw pairedContractError("selected-area response scope");
    }
    return validated;
}

/**
 * Return the histogram index containing a finite value, including last edge.
 *
 * @param {number[]} edges Strictly increasing histogram edges.
 * @param {number} value Candidate axis value.
 * @return {number} Matching zero-based bin, or negative one outside the range.
 */
function findEdgeBin(edges, value) {
    if (!Number.isFinite(value) || value < edges[0] || value > edges.at(-1)) {
        return -1;
    }
    if (value === edges.at(-1)) {
        return edges.length - 2;
    }
    let low = 0;
    let high = edges.length - 1;
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (value < edges[middle]) high = middle;
        else low = middle;
    }
    return low;
}

/**
 * Locate one paired value in the fixed histogram matrix.
 *
 * @param {Object} statistics Validated paired statistics.
 * @param {number} xValue Finite X value.
 * @param {number} yValue Finite Y value.
 * @return {{xBin:number,yBin:number}|null} Matching matrix cell or null.
 */
export function findRasterPairedHistogramCell(
    statistics,
    xValue,
    yValue,
) {
    const xBin = findEdgeBin(statistics.histogram.xEdges, xValue);
    const yBin = findEdgeBin(statistics.histogram.yEdges, yValue);
    return xBin < 0 || yBin < 0 ? null : { xBin, yBin };
}

/**
 * Return the first highest-density cell in deterministic Y/X order.
 *
 * @param {Object} statistics Validated paired statistics.
 * @return {{xBin:number,yBin:number,count:number}} Densest populated cell.
 */
export function getHighestDensityPairedCell(statistics) {
    let highest = { xBin: 0, yBin: 0, count: -1 };
    statistics.histogram.counts.forEach((row, yBin) => {
        row.forEach((count, xBin) => {
            if (count > highest.count) {
                highest = { xBin, yBin, count };
            }
        });
    });
    return highest;
}
