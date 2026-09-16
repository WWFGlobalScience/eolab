/** Same-origin Processing API. Only catalog identities and opaque job/area IDs cross this boundary. */
import { normalizeRasterSamplingArea } from "../selected-area.js";
import { chunkPixels } from "./calculation-session.js";

/** Browser-safe HTTP failure; transport failures remain ordinary errors. */
export class ProcessingRequestError extends Error {
    /** @param {string} message User-facing detail. @param {number} status HTTP status. @param {string|null} code Stable reason. */
    constructor(message, status, code = null) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** Validate opaque API path identities. @param {string} id Candidate ID. @return {string} Validated ID. */
function opaqueId(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(id)) {
        throw new TypeError("Invalid processing identity.");
    }
    return id;
}

/** Validate fields used to review native output dimensions. @param {Object} grid API grid. @return {void} */
function validateGrid(grid) {
    if (!grid || ![grid.width, grid.height].every(value => Number.isSafeInteger(value) && value > 0) ||
        typeof grid.crs !== "string" || typeof grid.dtype !== "string" ||
        !Array.isArray(grid.transform) || grid.transform.length !== 6 || !grid.transform.every(Number.isFinite)) {
        throw new Error("Processing returned an invalid native grid.");
    }
    if (grid.execution) validateExecution(grid.execution);
}

/** Validate bounded execution metadata before presentation. @param {Object} value Plan. @return {void} */
function validateExecution(value) {
    chunkPixels(value.targetChunkPixels);
    if (![value.readWidth, value.readHeight, value.evaluationWidth, value.evaluationHeight, value.readWindows]
        .every(n => Number.isSafeInteger(n) && n > 0) || value.readWindows > 65536 ||
        value.evaluationWidth > value.readWidth || value.evaluationHeight > value.readHeight) {
        throw new Error("Processing returned invalid batch dimensions.");
    }
}

/** Validate durable timing measurements, including optional kernel stage details.
 * @param {Object|null} value Timings from a retained job.
 * @return {void}
 * @throws {Error} If required counters or present stage durations are invalid.
 */
function validatePerformance(value) {
    if (value == null) return;
    validateExecution(value.execution);
    validateStages(value.stages, ["sourceSetupSeconds", "selectionSetupSeconds", "groundAreaSetupSeconds", "gridCheckSeconds",
        "selectionMaskSeconds", "areaWeightsSeconds", "reductionSeconds"]);
    for (const name of ["maskPreparationSeconds", "maskReadSeconds"]) {
        if (value.stages?.[name] != null) validateStages(value.stages, [name]);
    }
    validateStages(value.stages?.selectionMaskBreakdown,
        ["featureReadingSeconds", "projectionSeconds", "rasterizationSeconds"]);
    if (![value.readSeconds, value.calculationSeconds, value.resultWriteSeconds, value.kernelSeconds]
        .every(n => Number.isFinite(n) && n >= 0 && n <= 86400) ||
        ![value.readWindows, value.evaluationTiles, value.reducerUpdates].every(n => Number.isSafeInteger(n) && n > 0) ||
        value.readWindows !== value.execution.readWindows) throw new Error("Processing returned invalid performance measurements.");
}

/** Validate optional stage durations, allowing legacy responses without them.
 * @param {Object|null} value Timing object. @param {string[]} fields Required stage names. @return {void}
 */
function validateStages(value, fields) {
    if (value == null) return;
    if (fields.some(key => !Number.isFinite(value[key]) || value[key] < 0)) {
        throw new Error("Processing returned invalid stage timings.");
    }
}

/** Validate optional native reuse/readiness metadata. @param {Object|null} value Process timing. @return {void} */
function validateProcessTiming(value) {
    if (value == null) return;
    validateStages(value, ["readyWaitSeconds", "operationSeconds", "overheadSeconds"]);
    if (typeof value.reusedProcess !== "boolean") throw new Error("Processing returned invalid process reuse metadata.");
}

/** Validate a public owned job before presenting actions. @param {Object} job API response. @return {Object} Validated job. */
function validateJob(job) {
    opaqueId(job?.jobId);
    if (!["queued", "running", "cancelling", "ready", "failed", "cancelled", "interrupted", "expired", "deleted"].includes(job.status) ||
        !job.progress || typeof job.progress !== "object") throw new Error("Processing returned an invalid job state.");
    if (job.grid) validateGrid(job.grid);
    if (job.result) {
        processingDownloadUrl(job.result.url, job.jobId, "result");
        processingDownloadUrl(job.result.provenanceUrl, job.jobId, "provenance");
        if (job.operation === "raster.aggregate.v1") {
            validateCalculationRows(job.result.rows);
            validatePerformance(job.result.performance);
            validateStages(job.result.executionTiming, ["queueSeconds", "preparationSeconds", "nativeProcessSeconds", "publicationSeconds"]);
            validateProcessTiming(job.result.executionTiming?.process);
            if (job.result.queuedToReadySeconds != null) validateStages(job.result, ["queuedToReadySeconds"]);
        }
    }
    return job;
}

/** Validate the bounded typed table consumed by inline results. @param {Object[]} rows API values. @return {void} */
function validateCalculationRows(rows) {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5 || rows.some(row =>
        typeof row.label !== "string" || typeof row.expression !== "string" ||
        !["ok", "no_matches", "no_valid_data", "invalid_arithmetic", "overflow"].includes(row.state) ||
        !(row.value === null || typeof row.value === "string" &&
            (row.valueType === "integer" ? /^-?\d+$/.test(row.value) : row.valueType === "float" && Number.isFinite(Number(row.value)))) ||
        !Array.isArray(row.aggregates) || row.aggregates.some(aggregate =>
            typeof aggregate.function !== "string" ||
            ![aggregate.validPixels, aggregate.matchedPixels, aggregate.invalidArithmeticPixels]
                .every(value => Number.isSafeInteger(value) && value >= 0)))) {
        throw new Error("Processing returned an invalid calculation result table.");
    }
}

/** Own HTTP serialization and cookie-session establishment for Downloads. */
export class ProcessingApiClient {
    /** @param {Function} [fetchImplementation=globalThis.fetch] Same-origin HTTP transport.
     * @param {Function|undefined} [eventSource=globalThis.EventSource] Optional browser SSE transport. */
    constructor(fetchImplementation = globalThis.fetch, eventSource = globalThis.EventSource) {
        this.fetch = fetchImplementation;
        this.EventSource = eventSource;
        this.session = null;
    }

    /** Watch hints after ordinary requests establish the owned session cookie.
     * @param {Function} changed Request an authoritative job refresh.
     * @return {Function|null} Close the connection, or null when SSE is unavailable. */
    watchJobs(changed) {
        if (typeof this.EventSource !== "function") return null;
        try {
            const source = new this.EventSource("/api/processing/events");
            let closed = false;
            const receive = event => { if (!closed && event.data === "{}") changed(); };
            source.addEventListener("changed", receive);
            return () => { if (!closed) { closed = true; source.removeEventListener("changed", receive); source.close(); } };
        } catch { return null; } // The existing two-second poll remains authoritative.
    }

    /** Establish the cookie before concurrent requests. @return {Promise<Object>} Initial job listing. */
    ensureSession() {
        this.session ??= this.request("/jobs").catch((error) => {
            this.session = null;
            throw error;
        });
        return this.session;
    }

    /** Recover owned jobs independently of current map state. @return {Promise<Object[]>} Recent jobs. */
    async listJobs() {
        const response = this.session === null
            ? await this.ensureSession()
            : (await this.ensureSession(), await this.request("/jobs"));
        if (!Array.isArray(response.jobs)) throw new Error("Invalid processing job list.");
        return response.jobs.map(validateJob);
    }

    /**
     * Review a catalog raster and explicit immutable area, without starting work.
     * @param {{collectionId:string,itemId:string}} source Catalog identity.
     * @param {Object} area Selected rectangle or immutable catalog descriptor.
     * @param {AbortSignal} signal Cancels superseded planning.
     * @return {Promise<Object>} Native-grid estimate and expiring plan.
     */
    async planClip(source, area, signal) {
        const selected = normalizeRasterSamplingArea(area);
        if (selected.kind === "wholeRaster") throw new Error("Select a box or catalog vector first.");
        if (![source.collectionId, source.itemId].every(value => typeof value === "string" && value.length > 0)) {
            throw new TypeError("A Catalog raster is required.");
        }
        await this.ensureSession();
        const plan = await this.request("/raster-clips/plan", "POST", {
            collectionId: source.collectionId, itemId: source.itemId,
            ...(selected.kind === "selectedArea"
                ? { selectedBounds: selected.selectedBounds }
                : { catalogSelection: selected.catalogSelection }),
        }, signal);
        opaqueId(plan.planId);
        validateGrid(plan.grid);
        if (!Number.isFinite(Date.parse(plan.expiresAt)) || !Number.isSafeInteger(plan.grid.estimatedRawBytes) ||
            plan.grid.estimatedRawBytes < 1 || !["bounds", "catalogSelection", "aoi"].includes(plan.area?.kind) ||
            !Array.isArray(plan.area.bounds) || plan.area.bounds.length !== 4 || !plan.area.bounds.every(Number.isFinite)) {
            throw new Error("Processing returned an invalid clip estimate.");
        }
        return plan;
    }

    /** Submit or safely retry one reviewed plan. @param {Object} submission Stable planId/requestId. @return {Promise<Object>} Owned job. */
    async submitClip(submission) {
        await this.ensureSession();
        return validateJob(await this.request("/raster-clips", "POST", submission));
    }

    /** Validate expressions without opening a raster. @param {Object[]} calculations Named expressions. @param {AbortSignal} signal Superseded edit. @return {Promise<Object>} Validation. */
    async validateCalculation(calculations, signal) {
        await this.ensureSession();
        return this.request("/raster-calculations/validate", "POST", { alias: "a", calculations }, signal);
    }

    /** Review one immutable calculation intent. @param {Object} intent Source, expressions, and area. @param {AbortSignal} signal Superseded plan. @return {Promise<Object>} Estimate. */
    async planCalculation(intent, signal) {
        const area = normalizeRasterSamplingArea(intent.area);
        const targetChunkPixels = chunkPixels(intent.targetChunkPixels);
        await this.ensureSession();
        const plan = await this.request("/raster-calculations/plan", "POST", {
            sources: { a: { collectionId: intent.source.collectionId, itemId: intent.source.itemId } },
            calculations: intent.calculations,
            ...(targetChunkPixels === null ? {} : { targetChunkPixels }),
            ...(area.kind === "selectedArea" ? { selectedBounds: area.selectedBounds }
                : area.kind === "catalogSelection" ? { catalogSelection: area.catalogSelection } : { wholeRaster: true }),
        }, signal);
        opaqueId(plan.planId);
        validateGrid(plan.grid);
        if (plan.operation !== "raster.aggregate.v1" || !Number.isFinite(Date.parse(plan.expiresAt)) ||
            !Number.isSafeInteger(plan.grid.nativeBlocks) || plan.grid.nativeBlocks < 1 ||
            !Number.isSafeInteger(plan.grid.decodedBytes) || plan.grid.decodedBytes < 1) {
            throw new Error("Processing returned an invalid calculation estimate.");
        }
        validateStages(plan.timing, ["reservationSeconds", "preparationSeconds", "nativeProcessSeconds", "finalizationSeconds"]);
        validateProcessTiming(plan.timing?.process);
        return plan;
    }

    /** Submit or recover the same calculation. @param {Object} submission Stable IDs. @return {Promise<Object>} Owned job. */
    async submitCalculation(submission) {
        await this.ensureSession();
        return validateJob(await this.request("/raster-calculations", "POST", submission));
    }

    /** Read a tracked job even if it falls outside recent history. @param {string} id Job ID. @return {Promise<Object>} Owned job. */
    async getJob(id) {
        await this.ensureSession();
        return validateJob(await this.request(`/jobs/${opaqueId(id)}`));
    }

    /** Release used or replaced review state; accepted jobs keep their snapshots. @param {string} id Plan ID. @return {Promise<Object>} Idempotent acknowledgement. */
    async discardPlan(id) {
        await this.ensureSession();
        return this.request(`/plans/${opaqueId(id)}`, "DELETE");
    }

    /** Cancel an owned active job. @param {string} id Job ID. @return {Promise<Object>} Updated job. */
    async cancelJob(id) {
        await this.ensureSession();
        return this.request(`/jobs/${opaqueId(id)}/cancel`, "POST");
    }

    /** Revoke an owned terminal result. @param {string} id Job ID. @return {Promise<Object>} Updated job. */
    async deleteJob(id) {
        await this.ensureSession();
        return this.request(`/jobs/${opaqueId(id)}`, "DELETE");
    }

    /**
     * Send one bounded JSON request and preserve classified API errors.
     * @param {string} path Owned endpoint suffix. @param {string} [method="GET"] HTTP method.
     * @param {Object|undefined} body JSON input. @param {AbortSignal|undefined} signal Planning cancellation.
     * @return {Promise<Object>} Parsed response.
     */
    async request(path, method = "GET", body, signal) {
        const response = await this.fetch.call(globalThis, `/api/processing${path}`, {
            method, credentials: "same-origin", cache: "no-store", signal,
            headers: {
                Accept: "application/json",
                ...(method === "GET" ? {} : { "X-EOLab-Processing": "1" }),
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const detail = data?.detail;
            throw new ProcessingRequestError(
                typeof detail === "string" ? detail : Array.isArray(detail)
                    ? detail.map(item => item.msg).join("; ")
                    : detail?.message ?? `Processing request failed (${response.status}).`,
                response.status, detail?.code ?? null,
            );
        }
        if (data === null) throw new Error("Processing returned an unreadable response. Retry to recover your jobs.");
        return data;
    }
}

/**
 * Allow direct browser navigation only to the owned result endpoints.
 * @param {string} value API-supplied relative URL. @param {string} id Owning job.
 * @param {"result"|"provenance"} kind Artifact type. @return {string} Safe local download URL.
 */
export function processingDownloadUrl(value, id, kind) {
    const expected = `/api/processing/jobs/${opaqueId(id)}/${kind}`;
    if (!["result", "provenance"].includes(kind) || value !== expected) {
        throw new TypeError("Invalid processing download address.");
    }
    return expected;
}
