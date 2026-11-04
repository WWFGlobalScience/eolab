/** Same-origin adapters for rendering-independent raster analysis. */

import { rasterSourceReference } from "../raster-source.js";

import {
    normalizeRasterSamplingArea,
    validateRasterStatisticsForSelection,
} from "./statistics.js";
import { normalizeCategoryValues, rasterStatisticsMatchCategories } from "./categorical-statistics.js";
import {
    normalizeRasterPairedSamplingArea,
    validateRasterPairedStatisticsForSelection,
} from "./paired-statistics.js";

/**
 * Represent one browser-safe raster-analysis failure.
 *
 * @property {number} status Analysis API HTTP response status.
 * @property {string|null} code Machine-readable failure classification.
 */
export class RasterAnalysisRequestError extends Error {
    /**
     * Create an analysis failure.
     *
     * @param {string} message Concise user-facing failure explanation.
     * @param {number} status Analysis API HTTP response status.
     * @param {string|null} [code=null] Optional machine-readable failure code.
     */
    constructor(message, status, code = null) {
        super(message);
        this.name = "RasterAnalysisRequestError";
        this.status = status;
        this.code = code;
    }
}

/**
 * Distinguish temporary statistics admission conflicts from invalid requests.
 * @param {Error} error Current analysis failure.
 * @return {boolean} Whether waiting and retrying may acquire read capacity.
 */
export function isRasterStatisticsCapacityError(error) {
    return error instanceof RasterAnalysisRequestError && error.status === 409 &&
        error.code === "statistics_capacity_busy";
}

/**
 * Convert one failed analysis response into a browser-safe error.
 *
 * @param {Response} response Failed analysis response.
 * @param {string} action User-facing request description.
 * @return {Promise<RasterAnalysisRequestError>} Structured detail or a status
 * fallback.
 */
async function analysisRequestError(response, action) {
    const fallbackMessage = `${action} failed (${response.status})`;
    if (!response.headers.get("content-type")?.toLowerCase().includes(
        "application/json"
    )) {
        return new RasterAnalysisRequestError(fallbackMessage, response.status);
    }
    try {
        const errorDocument = await response.json();
        const detail = errorDocument.detail;
        const message = typeof detail === "string" ? detail : detail?.message;
        return new RasterAnalysisRequestError(
            typeof message === "string" && message.trim() !== ""
                ? message
                : fallbackMessage,
            response.status,
            typeof detail?.code === "string" ? detail.code : null
        );
    } catch {
        return new RasterAnalysisRequestError(fallbackMessage, response.status);
    }
}

/**
 * Read one band-one pixel from the selected raster source.
 *
 * @param {Object} item Catalog Item or original-source descriptor.
 * @param {{longitude: number, latitude: number}} position WGS 84 position.
 * @param {AbortSignal} signal Cancellation signal for a superseded position.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Source cell, bounds state, and value.
 * @throws {RasterAnalysisRequestError} If EOLab cannot sample the raster.
 */
export async function sampleRasterPixel(
    item,
    position,
    signal,
    fetchImplementation = globalThis.fetch
) {
    const response = await fetchImplementation.call(
        globalThis,
        "/api/raster-analysis/pixels",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-EOLab-Processing": "1"
            },
            body: JSON.stringify({
                ...analysisSourceBody(item),
                longitude: position.longitude,
                latitude: position.latitude
            }),
            signal, credentials: "same-origin", cache: "no-store"
        }
    );
    if (!response.ok) {
        throw await analysisRequestError(response, "Pixel sample request");
    }
    return response.json();
}

/**
 * Load bounded band-1 statistics for one original raster and sampling area.
 *
 * @param {Object} item Catalog Item or original-source descriptor.
 * @param {Object} samplingArea Whole raster, rectangle, geodesic box or filtered catalog/uploaded polygons.
 * @param {AbortSignal} signal Cancellation signal for stale UI intent.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @param {number[]|null} [categoryValues=null] Optional exact category codes.
 * @return {Promise<Object>} Validated statistics and optional ground areas.
 * @throws {Error} If the area or response violates the analysis contract.
 */
export async function loadRasterStatistics(
    item,
    samplingArea,
    signal,
    fetchImplementation = globalThis.fetch,
    categoryValues = null
) {
    const normalizedArea = normalizeRasterSamplingArea(samplingArea);
    const codes = categoryValues === null ? null : normalizeCategoryValues(categoryValues);
    const requestDocument = analysisSourceBody(item);
    if (normalizedArea.kind === "selectedArea") {
        requestDocument.selectedBounds = normalizedArea.selectedBounds;
    }
    if (normalizedArea.kind === "samplingBox") {
        requestDocument.samplingBox = normalizedArea.samplingBox;
    } else if (normalizedArea.kind === "catalogSelection") {
        requestDocument.catalogSelection = normalizedArea.catalogSelection;
    }
    if (codes !== null) requestDocument.categoryValues = codes;
    const response = await fetchImplementation.call(
        globalThis,
        "/api/raster-analysis/statistics",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-EOLab-Processing": "1",
                ...(normalizedArea.catalogSelection?.uploadId ? { "X-EOLab-Uploads": "1" } : {}),
            },
            body: JSON.stringify(requestDocument),
            signal, credentials: "same-origin", cache: "no-store"
        }
    );
    if (!response.ok) {
        throw await analysisRequestError(
            response,
            "Raster statistics request"
        );
    }
    const statistics = validateRasterStatisticsForSelection(await response.json(), normalizedArea);
    if (!rasterStatisticsMatchCategories(statistics, codes)) {
        throw new Error("Raster statistics returned a different category classification.");
    }
    return statistics;
}

/**
 * Load bounded paired statistics for two ordered original raster sources.
 *
 * @param {Object} xItem Raster source assigned to the X reference grid.
 * @param {Object} yItem Raster source aligned to X, possibly the same source.
 * @param {Object} samplingArea Whole overlap, rectangle, geodesic box or filtered catalog/uploaded polygons.
 * @param {AbortSignal} signal Cancellation signal for stale pair intent.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @return {Promise<Object>} Validated 2D histogram and marginals.
 * @throws {Error} If request or response violates the paired contract.
 */
export async function loadRasterPairedStatistics(
    xItem,
    yItem,
    samplingArea,
    signal,
    fetchImplementation = globalThis.fetch
) {
    const normalizedArea = normalizeRasterPairedSamplingArea(samplingArea);
    const requestDocument = {
        xRaster: rasterSourceReference(xItem),
        yRaster: rasterSourceReference(yItem),
    };
    if (normalizedArea.kind === "selectedArea") {
        requestDocument.selectedBounds = normalizedArea.selectedBounds;
    }
    if (normalizedArea.kind === "samplingBox") requestDocument.samplingBox = normalizedArea.samplingBox;
    if (normalizedArea.kind === "catalogSelection") requestDocument.catalogSelection = normalizedArea.catalogSelection;
    const response = await fetchImplementation.call(
        globalThis,
        "/api/raster-analysis/paired-statistics",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-EOLab-Processing": "1",
                ...(normalizedArea.catalogSelection?.uploadId ? { "X-EOLab-Uploads": "1" } : {}),
            },
            body: JSON.stringify(requestDocument),
            signal, credentials: "same-origin", cache: "no-store"
        }
    );
    if (!response.ok) {
        throw await analysisRequestError(
            response,
            "Paired raster statistics request"
        );
    }
    return validateRasterPairedStatisticsForSelection(
        await response.json(),
        normalizedArea
    );
}

/** Build analysis fields for a Catalog raster or an explicit source selection.
 * @param {Object} value Catalog Item or source descriptor.
 * @return {Object} Path-free analysis request fields.
 * @throws {TypeError} If the source identity is invalid.
 */
function analysisSourceBody(value) {
    const source = rasterSourceReference(value);
    return source.kind === "runArtifact" || source.variable !== undefined ? {source} : {...source};
}
