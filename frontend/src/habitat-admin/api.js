/** Request Habitat administration and Catalog choices without browser-session job state. */
import {
    CatalogSearchClient, MOUNTED_VECTOR_COLLECTION_ID, buildCatalogSearchRequest,
    findPaginationLink,
} from "../catalog.js";
import { getCatalogItemKey } from "../catalog-item-identity.js";
import { validateVectorSelection } from "../selected-area.js";
import { EMPTY_VECTOR_FILTER, normalizeVectorFilter } from "../vector/filter.js";

const PREPARATIONS = "/api/admin/habitat/input-preparations";
const OPERATION = "habitat.prepare-inputs.v1";
const DIGEST = /^[a-f0-9]{64}$/;
const JOB_ID = /^[a-f0-9]{32}$/;
/** Preparation states whose server-side work has not finished.
 * @type {ReadonlySet<string>}
 */
export const ACTIVE_PREPARATION_STATES = new Set(["queued", "running", "cancelling"]);
const JOB_STATES = new Set([
    ...ACTIVE_PREPARATION_STATES, "ready", "failed", "cancelled",
    "interrupted", "expired", "deleted",
]);

/**
 * A failed request whose uncertainty determines whether a mutation must be recovered.
 */
export class HabitatAdminRequestError extends Error {
    /**
     * Record a safe error and whether the server might have accepted the command.
     * @param {string} message Explanation suitable for the administration page.
     * @param {number|null} [status=null] HTTP status, or null without a known response.
     * @param {boolean} [uncertain=false] Whether acceptance cannot be ruled out.
     */
    constructor(message, status = null, uncertain = false) {
        super(message);
        this.name = "HabitatAdminRequestError";
        this.status = status;
        this.uncertain = uncertain;
    }
}

/**
 * Read the server's preparation lifecycle contract and restrict downloads to that job.
 * @param {Object} value JSON returned by an administration endpoint.
 * @param {string|null} [expectedId=null] Requested handle for detail/cancellation reads.
 * @return {Object} Validated job with a copied, path-free Catalog selection.
 * @throws {TypeError} If lifecycle, identity, progress or report metadata is invalid.
 */
function readPreparation(value, expectedId = null) {
    if (!value || !JOB_ID.test(value.jobId) ||
        (expectedId !== null && value.jobId !== expectedId) ||
        value.operation !== OPERATION || !JOB_STATES.has(value.status)) {
        throw new TypeError("Invalid preparation identity or status");
    }
    for (const field of ["createdAt", "updatedAt", "expiresAt"]) {
        if (typeof value[field] !== "string" || !Number.isFinite(Date.parse(value[field]))) {
            throw new TypeError("Invalid preparation timestamp");
        }
    }
    if (value.metadataExpiresAt !== null &&
        (typeof value.metadataExpiresAt !== "string" || !Number.isFinite(Date.parse(value.metadataExpiresAt)))) {
        throw new TypeError("Invalid saved-input expiry");
    }
    let inputs = null;
    if (value.inputs !== null) {
        const source = value.inputs;
        if (!source || typeof source.name !== "string" || !source.name.trim() ||
            !Number.isInteger(source.year) || !DIGEST.test(source.configurationSha256) ||
            source.selection?.collectionId !== MOUNTED_VECTOR_COLLECTION_ID) {
            throw new TypeError("Invalid preparation inputs");
        }
        inputs = {name: source.name, year: source.year,
            configurationSha256: source.configurationSha256,
            selection: validateVectorSelection(source.selection)};
    }
    const progress = value.progress;
    if (!progress || !(progress.phase === null || typeof progress.phase === "string")) {
        throw new TypeError("Invalid preparation progress");
    }
    const completed = progress.completed ?? null, total = progress.total ?? null;
    if ((completed !== null && (!Number.isInteger(completed) || completed < 0)) ||
        (total !== null && (!Number.isInteger(total) || total < 0)) ||
        (completed !== null && total !== null && completed > total) ||
        !(progress.unit === undefined || progress.unit === null || progress.unit === "tiles")) {
        throw new TypeError("Invalid measured tile progress");
    }
    if (value.error !== null && (!value.error || typeof value.error.code !== "string" ||
        typeof value.error.detail !== "string")) throw new TypeError("Invalid preparation failure");
    const base = `${PREPARATIONS}/${value.jobId}`;
    const result = value.result;
    if (result !== null && (!result || value.status !== "ready" ||
        result.url !== `${base}/report` || result.provenanceUrl !== `${base}/provenance` ||
        typeof result.filename !== "string" || !result.filename || /[/\\]/.test(result.filename) ||
        !Number.isInteger(result.bytes) || result.bytes < 0 || !DIGEST.test(result.sha256) ||
        !Number.isInteger(result.year) || !DIGEST.test(result.configurationSha256) ||
        !Number.isInteger(result.tileCount) || result.tileCount < 0)) {
        throw new TypeError("Invalid preparation report");
    }
    return {...value, inputs, progress: {...progress, completed, total, unit: progress.unit ?? null}};
}

/**
 * Read Habitat's installed assessment-year and linked-source choices.
 * @param {Object} value JSON from the existing model-options endpoint.
 * @return {Object} Source years, acquisition grid and linked datasets.
 * @throws {TypeError} If year choices, grid metadata or dataset links are invalid.
 */
function readOptions(value) {
    if (!value || !Number.isInteger(value.minimumYear) || !Number.isInteger(value.maximumYear) ||
        !Number.isInteger(value.defaultYear) || value.minimumYear > value.defaultYear ||
        value.defaultYear > value.maximumYear || typeof value.grid?.crs !== "string" ||
        !Array.isArray(value.grid.pixelSize) || value.grid.pixelSize.length !== 2 ||
        value.grid.pixelSize.some(size => !Number.isFinite(size) || size <= 0) ||
        !Array.isArray(value.grid.origin) || value.grid.origin.length !== 2 ||
        value.grid.origin.some(coordinate => !Number.isFinite(coordinate)) ||
        !Array.isArray(value.datasets)) throw new TypeError("Invalid Habitat source choices");
    for (const dataset of value.datasets) {
        const url = new URL(dataset.url);
        if (typeof dataset.label !== "string" || !dataset.label ||
            !["https:", "http:"].includes(url.protocol) || url.username || url.password ||
            !Array.isArray(dataset.roles) || !dataset.roles.length ||
            dataset.roles.some(role => !["predictor", "response"].includes(role))) {
            throw new TypeError("Invalid Habitat source link");
        }
    }
    return value;
}

/**
 * Convert supported Catalog polygon metadata into a selectable source without reading it.
 * @param {Object} item Public STAC Item with Table and vector-source metadata.
 * @return {{key:string,label:string,selection:Object,fields:Array<{name:string,type:string}>}|null}
 * A mounted polygon choice, or null for another geometry or unsupported source format.
 * @throws {TypeError} If a supported source has malformed identity or field metadata.
 */
function readAreaSource(item) {
    if (item?.collection !== MOUNTED_VECTOR_COLLECTION_ID) return null;
    const properties = item.properties, source = properties?.["eolab:vector_source"];
    if (source?.kind !== "mounted" || !["geopackage", "shapefile"].includes(source.format)) return null;
    const columns = properties["table:columns"], geometry = properties["table:primary_geometry"];
    if (!Array.isArray(columns) || !["Polygon", "MultiPolygon"].includes(
        columns.find(column => column?.name === geometry)?.type,
    )) return null;
    const fields = columns.filter(column => column?.name !== geometry).map(column => {
        if (typeof column?.name !== "string" || !column.name || typeof column.type !== "string") {
            throw new TypeError("Invalid Catalog field metadata");
        }
        return {name: column.name, type: column.type};
    });
    const selection = validateVectorSelection({collectionId: item.collection, itemId: item.id,
        assetKey: source.asset_key, layerName: source.layer_name,
        filter: normalizeVectorFilter(EMPTY_VECTOR_FILTER, fields)});
    return {key: getCatalogItemKey(item),
        label: typeof properties.title === "string" && properties.title.trim() ? properties.title : item.id,
        selection, fields};
}

/** Use the existing administrator realm and path-free Catalog/Processing contracts. */
export class HabitatAdminApi {
    /**
     * Connect an injectable HTTP transport without storing passwords or ownership cookies.
     * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP transport invoked
     * with the global receiver required by browser fetch.
     */
    constructor(fetchImplementation = globalThis.fetch) {
        this.fetchImplementation = fetchImplementation.bind(globalThis);
        this.catalogSignal = undefined;
        this.catalogClient = new CatalogSearchClient("/stac",
            (url, options) => this.#fetch(url, options, this.catalogSignal));
    }

    /**
     * Fetch one endpoint with private-response handling and command uncertainty.
     * @param {string} url Application or same-origin Catalog proxy URL.
     * @param {RequestInit} options HTTP method, headers, body and cancellation.
     * @param {AbortSignal} [externalSignal] Additional caller cancellation for Catalog work.
     * @return {Promise<Response>} Successful HTTP response for its owning decoder.
     * @throws {HabitatAdminRequestError} For transport and non-success HTTP responses.
     * @throws {DOMException} When the caller or Catalog client aborts the request.
     */
    async #fetch(url, options = {}, externalSignal = undefined) {
        const headers = new Headers(options.headers);
        const method = options.method ?? "GET";
        if (!headers.has("Accept")) headers.set("Accept", "application/json");
        if (method === "POST") headers.set("X-EOLab-Admin", "1");
        const signal = externalSignal
            ? AbortSignal.any([options.signal, externalSignal].filter(Boolean)) : options.signal;
        let response;
        try {
            response = await this.fetchImplementation(url, {
                ...options, method, headers, signal, credentials: "same-origin", cache: "no-store",
            });
        } catch (error) {
            if (error.name === "AbortError") throw error;
            throw new HabitatAdminRequestError(
                "Could not reach EOLab. Check your connection and try again.", null, true,
            );
        }
        if (!response.ok) {
            const value = await response.json().catch(() => null);
            throw new HabitatAdminRequestError(
                typeof value?.detail === "string" ? value.detail : `EOLab returned ${response.status}.`,
                response.status, response.status < 400 || response.status >= 500,
            );
        }
        return response;
    }

    /**
     * Decode one JSON response at its external API boundary.
     * @template T
     * @param {string} url Existing endpoint URL.
     * @param {RequestInit} options Request parameters.
     * @param {(value:Object)=>T} decode Owning response-contract decoder.
     * @return {Promise<T>} Validated response data.
     * @throws {HabitatAdminRequestError} For rejected requests or invalid successful responses.
     * @throws {DOMException} When the caller cancels the HTTP request.
     */
    async #request(url, options, decode) {
        const response = await this.#fetch(url, options);
        try {
            return decode(await response.json());
        } catch (error) {
            if (error.name === "AbortError") throw error;
            throw new HabitatAdminRequestError(
                "EOLab returned an invalid response. Refresh the page or recover the request.",
                response.status, true,
            );
        }
    }

    /**
     * Read the installed assessment-year range and scientific source descriptions.
     * @param {AbortSignal} [signal] Cancel obsolete option loading.
     * @return {Promise<Object>} Source choices supplied by the existing Habitat endpoint.
     * @throws {HabitatAdminRequestError} If options cannot be read or violate their contract.
     * @throws {DOMException} When the request is cancelled.
     */
    getOptions(signal) {
        return this.#request("/api/processing/models/habitat-condition/earth-engine-options", {signal}, readOptions);
    }

    /**
     * Search mounted polygon sources or follow one Catalog continuation link.
     * @param {string} query Catalog text/date search; mounted vectors are always required.
     * @param {Object|null} [nextLink=null] Provider link returned by the preceding search page.
     * @param {AbortSignal} [signal] Cancel obsolete search or pagination work.
     * @return {Promise<{sources:Array<{key:string,label:string,selection:Object,fields:Array<{name:string,type:string}>}>,next:Object|null}>}
     * Selectable path-free sources and their next Catalog page link.
     * @throws {HabitatAdminRequestError} For Catalog failures, unsafe links or malformed metadata.
     * @throws {DOMException} When a search is cancelled or superseded.
     */
    async searchAreas(query, nextLink = null, signal = undefined) {
        this.catalogSignal = signal;
        let body;
        if (nextLink === null) {
            try {
                body = {...buildCatalogSearchRequest(query, 20), collections: [MOUNTED_VECTOR_COLLECTION_ID]};
            } catch (error) {
                throw new HabitatAdminRequestError(error.message, null, false);
            }
        }
        try {
            const page = nextLink
                ? await this.catalogClient.follow(this.#paginationLink(nextLink))
                : await this.catalogClient.request({href: "/stac/search", method: "POST", body});
            if (page === null) throw new DOMException("Catalog search superseded", "AbortError");
            const next = findPaginationLink(page, ["next"]);
            return {sources: page.features.map(readAreaSource).filter(Boolean),
                next: next === null ? null : this.#paginationLink(next)};
        } catch (error) {
            if (error.name === "AbortError" || error instanceof HabitatAdminRequestError) throw error;
            throw new HabitatAdminRequestError("Catalog returned an invalid response. Try searching again.", null, true);
        }
    }

    /**
     * Keep provider pagination within the same-origin Catalog proxy search endpoint.
     * @param {Object} link STAC continuation link, including provider-owned tokens/body.
     * @return {Object} Link with an absolute, credential-free Catalog search URL.
     * @throws {TypeError} If the link redirects requests outside Catalog search.
     */
    #paginationLink(link) {
        const search = new URL("/stac/search", globalThis.location?.href ?? "http://localhost/");
        const target = new URL(link.href, search);
        if (typeof link.href !== "string" || target.origin !== search.origin ||
            target.pathname !== search.pathname || target.username || target.password || target.hash) {
            throw new TypeError("Invalid Catalog continuation URL");
        }
        return {...link, href: target.href};
    }

    /**
     * Inspect current cache availability independently of accepting preparation work.
     * @param {Object} selection Immutable Catalog source and attribute predicate.
     * @param {number} year Assessment year to inspect.
     * @param {AbortSignal} [signal] Cancel an obsolete coverage check.
     * @return {Promise<{configurationSha256:string,year:number,requiredTiles:number,cachedTiles:number,missingTiles:number}>}
     * Advisory tile counts observed by the existing cache owner.
     * @throws {HabitatAdminRequestError} If inspection fails or returns invalid counts.
     * @throws {DOMException} When the check is cancelled.
     */
    coverage(selection, year, signal) {
        return this.#request("/api/admin/habitat/cache-coverage", {
            method: "POST", signal, headers: {"Content-Type": "application/json"},
            body: JSON.stringify({selection, year}),
        }, value => {
            if (!value || value.year !== year || !DIGEST.test(value.configurationSha256) ||
                [value.requiredTiles, value.cachedTiles, value.missingTiles].some(count => !Number.isInteger(count) || count < 0) ||
                value.requiredTiles !== value.cachedTiles + value.missingTiles) throw new TypeError("Invalid cache coverage");
            return value;
        });
    }

    /** Read the current cache-wide inventory without starting preparation work.
     * @param {AbortSignal} [signal] Cancel this explicit snapshot request.
     * @return {Promise<Array<{configurationSha256:string,year:number|null,cachedTiles:number,storedBytes:number}>>} Separate namespace counts and display metadata.
     * @throws {HabitatAdminRequestError} If inspection fails or its response is malformed.
     * @throws {DOMException} When the request is cancelled.
     */
    inventory(signal) {
        return this.#request("/api/admin/habitat/cache-inventory", {signal}, value => {
            if (!Array.isArray(value?.configurations)) throw new TypeError("Invalid cache inventory");
            const identities = new Set();
            return value.configurations.map(row => {
                if (!row || !DIGEST.test(row.configurationSha256) || identities.has(row.configurationSha256) ||
                    !Number.isSafeInteger(row.cachedTiles) || row.cachedTiles < 0 ||
                    !Number.isSafeInteger(row.storedBytes) || row.storedBytes < 0 ||
                    !(row.year === null || Number.isInteger(row.year))) throw new TypeError("Invalid cache inventory row");
                identities.add(row.configurationSha256);
                return {configurationSha256: row.configurationSha256, year: row.year,
                    cachedTiles: row.cachedTiles, storedBytes: row.storedBytes};
            });
        });
    }

    /**
     * Submit the exact captured command, including its stable idempotency identifier.
     * @param {{requestId:string,name:string,selection:Object,year:number}} request Captured preparation command.
     * @param {AbortSignal} [signal] HTTP cancellation; accepted server work continues.
     * @return {Promise<Object>} Accepted or previously accepted administrator-owned job.
     * @throws {HabitatAdminRequestError} On definite rejection or uncertain acceptance.
     * @throws {DOMException} When HTTP is aborted; retain the command for recovery.
     */
    submit(request, signal) {
        return this.#request(PREPARATIONS, {method: "POST", signal,
            headers: {"Content-Type": "application/json"}, body: JSON.stringify(request)}, readPreparation);
    }

    /**
     * Read one page of retained administration history without replacing earlier pages.
     * @param {{cursor?:string|null,limit?:number,signal?:AbortSignal}} [options={}] Opaque continuation and page size.
     * @return {Promise<{jobs:Object[],nextCursor:string|null}>} Retained jobs and older-page continuation.
     * @throws {HabitatAdminRequestError} If history fails or its response is invalid.
     * @throws {DOMException} When the history read is cancelled.
     */
    list({cursor = null, limit = 50, signal} = {}) {
        const query = new URLSearchParams({limit});
        if (cursor !== null) query.set("cursor", cursor);
        return this.#request(`${PREPARATIONS}?${query}`, {signal}, value => {
            if (!Array.isArray(value?.jobs) || !(value.nextCursor === null ||
                (typeof value.nextCursor === "string" && value.nextCursor))) throw new TypeError("Invalid preparation history");
            return {jobs: value.jobs.map(job => readPreparation(job)), nextCursor: value.nextCursor};
        });
    }

    /**
     * Read the authoritative status of one preparation handle.
     * @param {string} jobId Opaque handle returned by administration.
     * @param {AbortSignal} [signal] Cancel obsolete status polling.
     * @return {Promise<Object>} Current job and available report metadata.
     * @throws {HabitatAdminRequestError} If status cannot be read or identifies another job.
     * @throws {DOMException} When status polling is cancelled.
     */
    get(jobId, signal) {
        return this.#request(`${PREPARATIONS}/${encodeURIComponent(jobId)}`, {signal},
            value => readPreparation(value, jobId));
    }

    /**
     * Request cancellation while preserving tiles already published by the worker.
     * @param {string} jobId Opaque preparation handle to cancel.
     * @param {AbortSignal} [signal] Cancel HTTP waiting without assuming the command failed.
     * @return {Promise<Object>} Updated lifecycle snapshot, possibly still cancelling.
     * @throws {HabitatAdminRequestError} On definite rejection or uncertain cancellation.
     * @throws {DOMException} When HTTP waiting is cancelled.
     */
    cancel(jobId, signal) {
        return this.#request(`${PREPARATIONS}/${encodeURIComponent(jobId)}/cancel`,
            {method: "POST", signal}, value => readPreparation(value, jobId));
    }

    /**
     * Retry saved preparation inputs using one stable retry-command identifier.
     * @param {string} jobId Terminal preparation whose retained inputs should be reused.
     * @param {string} requestId Stable identifier reused when recovering this command.
     * @param {AbortSignal} [signal] HTTP cancellation; accepted new work continues.
     * @return {Promise<Object>} Newly accepted job or this command's earlier acceptance.
     * @throws {HabitatAdminRequestError} On definite rejection or uncertain retry acceptance.
     * @throws {DOMException} When HTTP waiting is cancelled.
     */
    retry(jobId, requestId, signal) {
        return this.#request(`${PREPARATIONS}/${encodeURIComponent(jobId)}/retry`, {
            method: "POST", signal, headers: {"Content-Type": "application/json"},
            body: JSON.stringify({requestId}),
        }, readPreparation);
    }
}
