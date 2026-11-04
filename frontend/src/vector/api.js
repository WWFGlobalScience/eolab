/** Request vector metadata, publication, styles and filters using source identities. */

import {
    normalizeVectorCategorySummary,
    normalizeVectorNumericClassification,
} from "./style.js";

/**
 * Path-free identity supplied by vector source selection.
 * @typedef {{collectionId:string,itemId:string}|{uploadId:string}} VectorFieldValueSource
 */

/**
 * Read one page of prepared string values without opening the original source.
 * Upload requests use the current browser's private ownership cookie. Nulls are
 * excluded by the endpoint; empty strings and whitespace are preserved exactly.
 * @param {VectorFieldValueSource} source Catalog identity or owned upload ID.
 * @param {{field:string,search:string,offset:number}} query Field and matching page.
 * @param {AbortSignal} signal Cancellation when the editor or query changes.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP transport.
 * @return {Promise<{field:string,values:string[],nextOffset:number|null,truncated:boolean}>} Up to 50 exact values and whether the field has values beyond the prepared choices.
 * @throws {Error} If the request fails, values are unavailable or the response is invalid.
 * @throws {DOMException} If the request is aborted.
 */
export async function getVectorFieldValues(source, query, signal, fetchImplementation = globalThis.fetch) {
    const page = { field: query.field, search: query.search, offset: query.offset, limit: 50 };
    const uploaded = "uploadId" in source;
    const url = uploaded
        ? `/api/vector-uploads/${encodeURIComponent(source.uploadId)}/field-values?${new URLSearchParams(page)}`
        : "/api/catalog/vector-field-values";
    let response;
    try {
        response = await fetchImplementation(url, {
            method: uploaded ? "GET" : "POST", signal, credentials: "same-origin", cache: "no-store",
            headers: { Accept: "application/json", ...(!uploaded ? { "Content-Type": "application/json" } : {}) },
            ...(!uploaded ? { body: JSON.stringify({ collectionId: source.collectionId, itemId: source.itemId, ...page }) } : {}),
        });
    } catch (error) {
        if (error.name === "AbortError") throw error;
        throw new Error("Could not load available values. Check your connection and try again.");
    }
    if (!response.ok) {
        if (uploaded && response.status === 404) {
            throw new Error("This private upload is unavailable. Open it in the browser that uploaded it, or upload it again.");
        }
        throw await vectorRenderingError(response, "available values");
    }
    const result = await response.json().catch(() => null);
    if (result?.field !== query.field || !Array.isArray(result.values) || result.values.length > page.limit ||
        result.values.some(value => typeof value !== "string") || typeof result.truncated !== "boolean" ||
        !(result.nextOffset === null || (Number.isSafeInteger(result.nextOffset) && result.values.length > 0 &&
            result.nextOffset === query.offset + result.values.length))) {
        throw new Error("Available values returned an invalid response. Try again.");
    }
    return result;
}

/**
 * Read the complete accepted filter's original-source extent independently of rendering.
 * @param {VectorFieldValueSource} source Path-free Catalog or owned upload identity.
 * @param {ReturnType<typeof import("./filter.js").normalizeVectorFilter>} filter Complete accepted predicate.
 * @param {AbortSignal} signal Cancellation when the view, predicate or map changes.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP transport.
 * @return {Promise<{matched:number,bbox:[number,number,number,number]|null}>} Combined WGS84 original-feature envelopes with densified native edges, including a valid point or empty result.
 * @throws {Error} If authorization, the bounded read or response validation fails.
 * @throws {DOMException} If the request is aborted.
 */
export async function getVectorFilterExtent(source, filter, signal, fetchImplementation = globalThis.fetch) {
    const uploaded = "uploadId" in source;
    let response;
    try {
        response = await fetchImplementation("/api/vector-sampling/extent", {
            method: "POST", signal, credentials: "same-origin", cache: "no-store",
            headers: { Accept: "application/json", "Content-Type": "application/json",
                ...(uploaded ? {"X-EOLab-Uploads": "1"} : {}) },
            body: JSON.stringify({ ...(uploaded ? {uploadId: source.uploadId}
                : {collectionId: source.collectionId, itemId: source.itemId}), filter }),
        });
    } catch (error) {
        if (error.name === "AbortError") throw error;
        throw new Error("Could not find filtered features. Check your connection and try again.");
    }
    if (!response.ok) throw await vectorRenderingError(response, "zoom");
    const result = await response.json().catch(() => null);
    const bbox = result?.bbox;
    if (!Number.isSafeInteger(result?.matched) || result.matched < 0 ||
        !(bbox === null || (result.matched > 0 && Array.isArray(bbox) && bbox.length === 4 &&
            bbox.every(Number.isFinite) && bbox[0] >= -180 && bbox[2] <= 180 &&
            bbox[1] >= -90 && bbox[3] <= 90 && bbox[0] <= bbox[2] && bbox[1] <= bbox[3]))) {
        throw new Error("Filtered features returned invalid bounds. Try again.");
    }
    return result;
}

/**
 * Admitted upload metadata tagged for the ordinary vector rendering pipeline.
 * @typedef {import("../vector-uploads/api.js").VectorUpload & {kind:"upload"}} UploadedVectorSource
 */

/**
 * Catalog identity or admitted upload metadata used by vector rendering.
 * @typedef {{collection:string,id:string,properties?:Object}|UploadedVectorSource} VectorSource
 */

const VECTOR_FAILURE_CATEGORIES = new Set([
    "reader_rejection",
    "connectivity",
    "authentication",
    "timeout",
    "configuration",
    "upstream_failure",
    "filter_count_queue_full",
    "filter_count_queue_timeout",
]);

/** Error returned by a vector assessment or publication boundary. */
export class VectorRenderingRequestError extends Error {
    /**
     * Create a rendering request failure.
     *
     * @param {string} message Browser-safe actionable detail.
     * @param {string|null} category Stable vector request failure category.
     */
    constructor(message, category = null) {
        super(message);
        this.name = "VectorRenderingRequestError";
        this.category = category;
    }
}

/**
 * Decode one failed vector rendering response.
 *
 * @param {Response} response Failed fetch response.
 * @param {string} action User-facing action phrase.
 * @return {Promise<VectorRenderingRequestError>} Decoded safe failure.
 */
async function vectorRenderingError(response, action) {
    let detail = null;
    try {
        detail = (await response.json())?.detail ?? null;
    } catch {
        detail = null;
    }
    if (
        detail !== null &&
        typeof detail === "object" &&
        VECTOR_FAILURE_CATEGORIES.has(detail.category) &&
        typeof detail.message === "string"
    ) {
        return new VectorRenderingRequestError(
            detail.message,
            detail.category
        );
    }
    if (typeof detail === "string" && detail.length > 0) {
        return new VectorRenderingRequestError(detail);
    }
    return new VectorRenderingRequestError(
        `Vector ${action} returned ${response.status}.`
    );
}

/**
 * Send a catalog identity or upload UUID to its vector rendering endpoint.
 *
 * @param {VectorSource} source Catalog Item or admitted upload.
 * @param {"assessments"|"layers"|"styles"|"category-summaries"|
 * "numeric-classifications"|"filters"|"filter-counts"} action
 * Rendering action path.
 * @param {string} actionLabel User-facing failure action.
 * @param {typeof fetch} fetchImplementation HTTP implementation.
 * @param {Object} [additionalBody={}] Additional action-owned request fields.
 * @param {AbortSignal} [signal] Optional HTTP cancellation signal.
 * @return {Promise<Object>} Parsed response document.
 * @throws {VectorRenderingRequestError} If HTTP or JSON contracts fail.
 */
async function postVectorAction(
    source,
    action,
    actionLabel,
    fetchImplementation,
    additionalBody = {},
    signal = undefined,
) {
    const uploaded = source.kind === "upload";
    const endpoint = uploaded ? `uploads/${source.id}/${action}` : action;
    let response;
    try {
        response = await fetchImplementation(`/api/vector-rendering/${endpoint}`, {
            method: "POST",
            ...(signal === undefined ? {} : { signal }),
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                ...(uploaded ? { "X-EOLab-Uploads": "1" } : {}),
            },
            body: JSON.stringify({
                ...(uploaded ? {} : { collectionId: source.collection, itemId: source.id }),
                ...additionalBody,
            }),
        });
    } catch (error) {
        if (error.name === "AbortError") throw error;
        throw new VectorRenderingRequestError(
            `Vector ${actionLabel} could not reach the application.`
        );
    }
    if (!response.ok) {
        throw await vectorRenderingError(response, actionLabel);
    }
    try {
        return await response.json();
    } catch (error) {
        throw new VectorRenderingRequestError(
            `Vector ${actionLabel} returned an invalid response.`
        );
    }
}

/**
 * Assess one exact catalog vector source layer.
 *
 * @param {Object} item Selected vector STAC Item.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP
 * implementation.
 * @return {Promise<Object>} Updated authoritative assessed Item.
 * @throws {VectorRenderingRequestError} If assessment fails.
 */
export function assessCatalogVector(item, fetchImplementation = globalThis.fetch) {
    return postVectorAction(
        item,
        "assessments",
        "assessment",
        fetchImplementation
    );
}

/**
 * Publish a catalog vector or this browser's uploaded polygons as a WMS layer.
 *
 * @param {VectorSource} source Catalog Item or admitted upload.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP
 * implementation.
 * @return {Promise<Object>} Published bounded-WMS layer contract.
 * @throws {VectorRenderingRequestError} If publication fails.
 */
export async function publishVector(
    source,
    fetchImplementation = globalThis.fetch
) {
    const publication = await postVectorAction(
        source,
        "layers",
        "publication",
        fetchImplementation
    );
    if (
        !Array.isArray(publication?.bbox) ||
        publication.bbox.length !== 4 ||
        !publication.bbox.every(Number.isFinite) ||
        typeof publication.layerName !== "string" ||
        !["point", "line", "polygon"].includes(publication.geometryKind) ||
        publication.styleName !== `vector-${publication.geometryKind}` ||
        publication.style?.geometryKind !== publication.geometryKind
    ) {
        throw new VectorRenderingRequestError(
            "Vector publication returned an invalid layer contract."
        );
    }
    return publication;
}

/**
 * Apply a complete style to a published catalog vector or uploaded polygon layer.
 *
 * @param {VectorSource} source Catalog Item or admitted upload.
 * @param {Object} style Validated geometry-specific browser style state.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP
 * implementation.
 * @return {Promise<Object>} Validated appearance and its opaque rendering approval.
 * @throws {VectorRenderingRequestError} If style application fails.
 */
export async function styleVector(
    source,
    style,
    fetchImplementation = globalThis.fetch,
) {
    const result = await postVectorAction(
        source,
        "styles",
        "styling",
        fetchImplementation,
        { style },
    );
    if (
        typeof result?.styleName !== "string" ||
        result.style?.geometryKind !== style.geometryKind
    ) {
        throw new VectorRenderingRequestError(
            "Vector styling returned an invalid style contract."
        );
    }
    return result;
}

/**
 * Summarize one authoritative scalar field through a bounded source read.
 *
 * @param {VectorSource} source Catalog Item or admitted upload.
 * @param {string} field Exact source attribute field.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP
 * implementation.
 * @return {Promise<Object>} Normalized typed category summary.
 * @throws {VectorRenderingRequestError} If summary or response validation fails.
 */
export async function summarizeVectorCategories(
    source,
    field,
    fetchImplementation = globalThis.fetch,
) {
    const result = await postVectorAction(
        source,
        "category-summaries",
        "category summary",
        fetchImplementation,
        { field },
    );
    try {
        const summary = normalizeVectorCategorySummary(result);
        if (summary.field !== field) {
            throw new TypeError("Category summary field does not match the request.");
        }
        return summary;
    } catch (error) {
        throw new VectorRenderingRequestError(
            "Vector category summary returned an invalid response."
        );
    }
}

/**
 * Classify one authoritative numeric field through a bounded source read.
 *
 * @param {VectorSource} source Catalog Item or admitted upload.
 * @param {string} field Exact numeric source attribute field.
 * @param {"equal-interval"|"quantile"|"percentile-interval"} method Classification method.
 * @param {number} classCount Requested class count.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP
 * implementation.
 * @return {Promise<Object>} Normalized numeric classification summary.
 * @throws {VectorRenderingRequestError} If classification or validation fails.
 */
export async function classifyVectorNumbers(
    source,
    field,
    method,
    classCount,
    fetchImplementation = globalThis.fetch,
) {
    const result = await postVectorAction(
        source,
        "numeric-classifications",
        "numeric classification",
        fetchImplementation,
        { field, method, classCount },
    );
    try {
        const summary = normalizeVectorNumericClassification(result);
        if (
            summary.field !== field || summary.method !== method ||
            summary.requestedClassCount !== classCount
        ) {
            throw new TypeError(
                "Numeric classification does not match the request."
            );
        }
        return summary;
    } catch (error) {
        throw new VectorRenderingRequestError(
            "Vector numeric classification returned an invalid response."
        );
    }
}

/**
 * Authorize a vector filter without changing global layer configuration.
 * @param {VectorSource} source Catalog Item or admitted upload.
 * @param {Object} filter Validated rule builder state.
 * @param {AbortSignal} [signal] Request cancellation.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP implementation.
 * @return {Promise<Object>} Applied rules and opaque rendering identity.
 * @throws {VectorRenderingRequestError} If filtering fails or its response is invalid.
 * @throws {DOMException} If the requesting layer cancels the operation.
 */
export async function filterVector(source, filter, signal, fetchImplementation = globalThis.fetch) {
    const result = await postVectorAction(source, "filters", "filtering", fetchImplementation, { filter }, signal);
    if (typeof result?.layerName !== "string" || !/^eolab:[a-zA-Z0-9_.:-]+$/.test(result.layerName) ||
        JSON.stringify(result.filter) !== JSON.stringify(filter)) {
        throw new VectorRenderingRequestError("Vector filtering returned an invalid response.");
    }
    return result;
}

/**
 * Request exact counts independently of rendering; never accept partial totals.
 * @param {VectorSource} source Catalog Item or admitted upload.
 * @param {Object} filter Applied rules.
 * @param {AbortSignal} [signal] Count cancellation.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP implementation.
 * @return {Promise<Object>} Exact counts or explicit unavailable counts.
 * @throws {VectorRenderingRequestError} If the queue is full, waiting expires,
 * or the request/response is invalid. Queue errors include their category.
 * @throws {DOMException} If the requesting layer cancels the count.
 */
export async function countVectorFilter(source, filter, signal, fetchImplementation = globalThis.fetch) {
    const result = await postVectorAction(source, "filter-counts", "filter count", fetchImplementation, { filter }, signal);
    const valid = result?.complete === false ? result.matched === null && result.total === null :
        result?.complete === true && Number.isSafeInteger(result.matched) && Number.isSafeInteger(result.total) &&
        result.matched >= 0 && result.total >= result.matched;
    if (!valid) throw new VectorRenderingRequestError("Vector filter count returned an invalid response.");
    return result;
}
