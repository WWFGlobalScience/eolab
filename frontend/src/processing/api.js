/** Same-origin Processing API for catalog rasters, owned polygon inputs and job results. */
import { normalizeRasterSamplingArea } from "../selected-area.js";
import { normalizeCalculationArea, validatePolygonAreaReference } from "./calculation-area.js";
import { chunkPixels } from "./calculation-session.js";
import { ProcessingDiagnostics, captureRequestNetworkTiming } from "./diagnostics.js";

/** Browser-safe HTTP failure; transport failures remain ordinary errors. */
export class ProcessingRequestError extends Error {
    /** @param {string} message User-facing detail. @param {number} status HTTP status.
     * @param {string|null} [code=null] Stable reason.
     * @param {number|null} [retryAfterSeconds=null] Server's minimum retry delay.
     */
    constructor(message, status, code = null, retryAfterSeconds = null) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
    }
    /** Whether queue capacity or a stopping attempt temporarily prevented admission.
     * Storage exhaustion and unknown errors require attention instead of automatic retry.
     * @return {boolean} True when admission can be retried with the same request ID.
     */
    get isCapacityRejection() {
        return this.status === 429 && ["owner_queue_full", "queue_full", "previous_attempt_stopping"].includes(this.code);
    }
}

/** Pause before retrying a request rejected or expired while waiting for capacity.
 * Retry-After sets the minimum delay. Repeated rejections back off to 30 seconds,
 * with jitter so concurrent tabs do not all retry together. The caller retains the
 * request until it succeeds or is cancelled. The timer does not check server
 * capacity or submit work; its caller must try admission again after the delay.
 * @param {ProcessingRequestError} error Capacity rejection or planning-queue timeout.
 * @param {number} attempt Number of preceding capacity waits for this request.
 * @param {AbortSignal|undefined} signal Cancel this wait when its calculation changes.
 * @return {Promise<void>} Resolves when the retry delay has elapsed.
 * @throws {DOMException} AbortError when the caller cancels.
 */
export function waitBeforeCapacityRetry(error, attempt, signal) {
    signal?.throwIfAborted();
    const seconds = Math.max(error.retryAfterSeconds ?? 0, Math.min(30, 5 * 2 ** Math.min(attempt, 3)));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, seconds * 1000 + Math.random() * 1000);
        const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal.reason); };
        signal?.addEventListener("abort", cancel, { once: true });
    });
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

/** Validate a public owned job before presenting values or download actions.
 * @param {Object} job API response, including optional timing and cache metadata.
 * @return {Object} Validated job.
 * @throws {Error} If the lifecycle, results, metadata or download links are invalid.
 */
function validateJob(job) {
    opaqueId(job?.jobId);
    if (!["queued", "running", "cancelling", "ready", "failed", "cancelled", "interrupted", "expired", "deleted"].includes(job.status) ||
        !job.progress || typeof job.progress !== "object") throw new Error("Processing returned an invalid job state.");
    if (job.grid) validateGrid(job.grid);
    if (job.preparation != null) {
        validateStages(job.preparation, ["seconds"]);
        validateProcessTiming(job.preparation.process);
        if (job.operation === "raster.aggregate.v1" && typeof job.preparation.cacheHit !== "boolean") throw new Error("Processing returned invalid preparation cache metadata.");
    }
    if (job.result) {
        processingDownloadUrl(job.result.url, job.jobId, "result");
        processingDownloadUrl(job.result.provenanceUrl, job.jobId, "provenance");
        if (job.operation === "raster.aggregate.v1") {
            validateCalculationRows(job.result.rows);
            if (job.result.cacheHit != null && typeof job.result.cacheHit !== "boolean") {
                throw new Error("Processing returned invalid cache metadata.");
            }
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
        this.eventListeners = new Set();
        this.eventStream = null;
        this.diagnostics = new ProcessingDiagnostics();
        this.requestSequence = 0;
        this.requestsInFlight = 0;
        this.pendingCalculations = [];
    }

    /** Share one event stream for planning and job observers after cookie setup.
     * Connection events and optional numeric timing frames are recorded separately;
     * only fixed changed hints trigger authoritative status reads.
     * @param {Function} changed Request an authoritative job refresh.
     * @return {Function|null} Close the connection, or null when SSE is unavailable. */
    watchJobs(changed) {
        if (typeof this.EventSource !== "function") return null;
        try {
            let closed = false;
            if (!this.eventStream) {
                const source = new this.EventSource("/api/processing/events");
                const receive = event => {
                    if (event.data === "{}") {
                        this.diagnostics.record("sse-hint", {shared: true});
                        for (const listener of this.eventListeners) listener();
                    }
                };
                const opened = () => this.diagnostics.record("sse-open", {shared: true});
                const failed = () => this.diagnostics.record("sse-error", {shared: true});
                const timing = event => {
                    try {
                        const data = JSON.parse(event.data);
                        if (Number.isFinite(data.listenerToStreamSeconds) && data.listenerToStreamSeconds >= 0 &&
                            Number.isFinite(data.previousSendSeconds) && data.previousSendSeconds >= 0) {
                            this.diagnostics.record("sse-server-timing", {shared: true,
                                listenerToStreamSeconds: data.listenerToStreamSeconds, previousSendSeconds: data.previousSendSeconds});
                        }
                    } catch { /* Optional diagnostics never control refreshes. */ }
                };
                source.addEventListener("changed", receive);
                source.addEventListener("open", opened);
                source.addEventListener("error", failed);
                source.addEventListener("timing", timing);
                this.eventStream = {source, receive, opened, failed, timing};
            }
            // Give each subscription its own identity even if a callback is reused.
            const listener = () => { if (!closed) changed(); };
            this.eventListeners.add(listener);
            return () => {
                if (closed) return;
                closed = true;
                this.eventListeners.delete(listener);
                if (this.eventListeners.size === 0) {
                    const {source, receive, opened, failed, timing} = this.eventStream;
                    source.removeEventListener("changed", receive);
                    source.removeEventListener("open", opened);
                    source.removeEventListener("error", failed);
                    source.removeEventListener("timing", timing);
                    source.close();
                    this.diagnostics.record("sse-close", {shared: true});
                    this.eventStream = null;
                }
            };
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

    /** Read every requested job without relying on the recent-history limit.
     * Larger sets use batches of 100 IDs; no per-job HTTP lookups are needed.
     * @param {string[]} jobIds Public job IDs belonging to this browser session.
     * @return {Promise<{jobs:Object[], unavailableJobIds:string[]}>} Snapshots and unavailable IDs.
     * @throws {Error} If an ID, request, or response is invalid or incomplete.
     */
    async readJobStatuses(jobIds) {
        const requested = [...new Set(jobIds.map(opaqueId))];
        const result = {jobs: [], unavailableJobIds: []};
        await this.ensureSession();
        for (let offset = 0; offset < requested.length; offset += 100) {
            const batch = requested.slice(offset, offset + 100);
            const response = await this.request("/jobs/status", "POST", {jobIds: batch});
            if (!Array.isArray(response.jobs) || !Array.isArray(response.unavailableJobIds))
                throw new Error("Invalid processing status response.");
            const jobs = response.jobs.map(validateJob);
            const unavailable = response.unavailableJobIds.map(opaqueId);
            const returned = [...jobs.map(job => job.jobId), ...unavailable];
            if (returned.length !== batch.length || new Set(returned).size !== batch.length ||
                returned.some(id => !batch.includes(id))) throw new Error("Incomplete processing status response.");
            result.jobs.push(...jobs);
            result.unavailableJobIds.push(...unavailable);
        }
        return result;
    }

    /** Submit complete clip inputs with a stable retry key.
     * @param {Object} submission Captured catalog source, explicit area and requestId.
     * @return {Promise<Object>} Owned queued job; the worker supplies its grid later.
     * @throws {Error} If inputs, admission or the returned job are invalid.
     */
    async submitClip(submission) {
        const {source, requestId} = submission;
        const selected = normalizeRasterSamplingArea(submission.area);
        if (!["selectedArea", "catalogSelection"].includes(selected.kind)) throw new Error("Select a box or catalog vector first.");
        await this.ensureSession();
        return validateJob(await this.request("/raster-clips", "POST", {
            collectionId: source.collectionId, itemId: source.itemId, requestId,
            ...(selected.kind === "selectedArea" ? {selectedBounds: selected.selectedBounds}
                : {catalogSelection: selected.catalogSelection}),
        }));
    }

    /** Validate expressions without opening a raster. @param {Object[]} calculations Named expressions. @param {AbortSignal} signal Superseded edit. @return {Promise<Object>} Validation. */
    async validateCalculation(calculations, signal) {
        await this.ensureSession();
        return this.request("/raster-calculations/validate", "POST", { alias: "a", calculations }, signal);
    }

    /** Upload exact polygons once and receive a private, expiring calculation reference.
     * @param {Object[]} polygons GeoJSON Polygon geometries, excluding feature properties.
     * @param {AbortSignal} [signal] Optional cancellation of the upload request.
     * @return {Promise<Object>} Reference, geographic bounds and polygon count.
     * @throws {Error} If upload fails or the returned area is malformed.
     */
    async uploadPolygonArea(polygons, signal) {
        await this.ensureSession();
        const area = await this.request("/polygon-areas", "POST", { polygons }, signal);
        validatePolygonAreaReference(area.polygonArea);
        if (!Array.isArray(area.bbox) || area.bbox.length !== 4 || !area.bbox.every(Number.isFinite) ||
            !Number.isSafeInteger(area.matched) || area.matched < 1) throw new Error("Invalid polygon area response.");
        return area;
    }

    /** Release an obsolete polygon upload; submitted jobs retain their exact area.
     * @param {string} id Private Processing input ID.
     * @return {Promise<Object>} Idempotent deletion acknowledgement.
     * @throws {Error} If the request fails.
     */
    async discardPolygonArea(id) {
        await this.ensureSession();
        return this.request(`/polygon-areas/${opaqueId(id)}`, "DELETE");
    }

    /** Queue complete inputs, coalescing submissions ready in the same microtask turn.
     * Each caller retains its independent promise, retry key and cancellation lifecycle.
     * @param {Object} submission Source, area, formulas and stable requestId.
     * @return {Promise<Object>} Owned job with preparation details once the worker produces them.
     * @throws {ProcessingRequestError|Error} If admission fails or the response is invalid.
     */
    async submitCalculation(submission) {
        await this.ensureSession();
        const area = normalizeCalculationArea(submission.area);
        const body = {
            requestId: submission.requestId,
            sources: {a: {collectionId: submission.source.collectionId, itemId: submission.source.itemId}},
            calculations: submission.calculations,
            ...(chunkPixels(submission.targetChunkPixels) == null ? {} : {targetChunkPixels: submission.targetChunkPixels}),
            ...(area.kind === "selectedArea" ? {selectedBounds: area.selectedBounds}
                : area.kind === "catalogSelection" ? {catalogSelection: area.catalogSelection}
                : area.kind === "polygonArea" ? {polygonArea: area.polygonArea} : {wholeRaster: true}),
        };
        if (new TextEncoder().encode(JSON.stringify(body)).length > 16 * 1024) {
            throw new ProcessingRequestError("Each calculation must fit within 16 KiB.", 413, "request_too_large");
        }
        return new Promise((resolve, reject) => {
            this.pendingCalculations.push({body, resolve, reject});
            if (this.pendingCalculations.length === 1) queueMicrotask(() => {
                const pending = this.pendingCalculations;
                this.pendingCalculations = [];
                for (let offset = 0; offset < pending.length; offset += 50)
                    void this.sendCalculationBatch(pending.slice(offset, offset + 50));
            });
        });
    }

    /** Send one bounded admission batch and settle every independent submission.
     * Unknown outcomes reject with the original transport error so executors retain
     * their saved keys. Per-item capacity errors reuse the existing retry behavior.
     * @param {{body:Object, resolve:function(Object):void, reject:function(Error):void}[]} pending One to fifty submissions.
     * @return {Promise<void>} All entries settled; callers observe their own promises.
     */
    async sendCalculationBatch(pending) {
        try {
            const response = await this.request("/raster-calculations/batch", "POST", {items: pending.map(item => item.body)});
            const items = response.items;
            if (!Array.isArray(items) || items.length !== pending.length ||
                new Set(items.map(item => item?.index)).size !== pending.length ||
                items.some(item => !Number.isSafeInteger(item?.index) || item.index < 0 || item.index >= pending.length ||
                    Boolean(item.job) === Boolean(item.error))) {
                throw new Error("Incomplete calculation admission response. Retry to recover your jobs.");
            }
            for (const item of items) {
                const caller = pending[item.index];
                try {
                    if (item.job) caller.resolve(validateJob(item.job));
                    else {
                        const {message, status, code, retryAfterSeconds} = item.error;
                        if (typeof message !== "string" || !Number.isInteger(status) || status < 400 || status > 599 ||
                            typeof code !== "string" || !(retryAfterSeconds === null ||
                            Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 && retryAfterSeconds <= 86400))
                            throw new Error("Invalid calculation rejection. Retry to recover your jobs.");
                        caller.reject(new ProcessingRequestError(message, status, code, retryAfterSeconds));
                    }
                } catch (error) { caller.reject(error); }
            }
        } catch (error) { for (const caller of pending) caller.reject(error); }
    }

    /** Read a tracked job even if it falls outside recent history. @param {string} id Job ID. @return {Promise<Object>} Owned job. */
    async getJob(id) {
        await this.ensureSession();
        return validateJob(await this.request(`/jobs/${opaqueId(id)}`));
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
     * Retain bounded browser timings and numeric server durations, without bodies
     * or credentials. HTTP completion does not imply that a job is ready.
     * @param {string} path Owned endpoint suffix. @param {string} [method="GET"] HTTP method.
     * @param {Object|undefined} body JSON input. @param {AbortSignal|undefined} signal Request cancellation.
     * @return {Promise<Object>} Parsed response.
     * @throws {ProcessingRequestError|Error} HTTP rejection, failed transport, or unreadable JSON.
     */
    async request(path, method = "GET", body, signal) {
        const requestNumber = ++this.requestSequence;
        const identity = path.match(/^\/jobs\/([a-f0-9]{32})(?:\/|$)/);
        const fields = {requestNumber, method, path, jobId: identity?.[1],
            shared: path === "/jobs" || path === "/jobs/status" || path === "/raster-calculations/batch", inFlight: ++this.requestsInFlight};
        const startedAtMs = this.diagnostics.record("http-start", fields);
        const finishNetworkTiming = captureRequestNetworkTiming();
        let headersAtMs, response, serverTiming = {};
        try {
            response = await this.fetch.call(globalThis, `/api/processing${path}`, {
                method, credentials: "same-origin", cache: "no-store", signal,
                headers: {
                    Accept: "application/json",
                    ...(method === "GET" ? {} : { "X-EOLab-Processing": "1" }),
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            headersAtMs = this.diagnostics.now();
            // Only our fixed numeric Server-Timing metrics enter the report.
            for (const metric of (response.headers?.get("Server-Timing") ?? "").split(",")) {
                const match = metric.trim().match(/^(processing|admissionChecks|queueAdmission|submissionObservation|jobRead|appToHeaders|beforeRoute|afterRoute|eventLoopLag);dur=([\d.]+)$/);
                if (match && Number.isFinite(Number(match[2]))) serverTiming[match[1]] = Number(match[2]) / 1000;
            }
            const data = await response.json().catch(() => null);
            if (!response.ok) {
                const detail = data?.detail;
                const retryAfterHeader = response.headers?.get("Retry-After");
                const retryAfterSeconds = retryAfterHeader == null ? NaN : /^\d+(\.\d+)?$/.test(retryAfterHeader)
                    ? Number(retryAfterHeader) : (Date.parse(retryAfterHeader) - Date.now()) / 1000;
                throw new ProcessingRequestError(
                    typeof detail === "string" ? detail : Array.isArray(detail)
                        ? detail.map(item => item.msg).join("; ")
                        : detail?.message ?? `Processing request failed (${response.status}).`,
                    response.status, detail?.code ?? null,
                    Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 && retryAfterSeconds <= 86400 ? retryAfterSeconds : null,
                );
            }
            if (data === null) throw new Error("Processing returned an unreadable response. Retry to recover your jobs.");
            return data;
        } finally {
            const finishedAtMs = this.diagnostics.now();
            const headerId = response?.headers?.get("X-EOLab-Request-Id");
            const requestId = /^[a-f0-9]{32}$/.test(headerId ?? "") ? headerId : null;
            this.requestsInFlight--;
            this.diagnostics.record("http-finish", {...fields, status: response?.status ?? null,
                seconds: (finishedAtMs - startedAtMs) / 1000,
                headersSeconds: headersAtMs == null ? null : (headersAtMs - startedAtMs) / 1000,
                bodySeconds: headersAtMs == null ? null : (finishedAtMs - headersAtMs) / 1000,
                serverTiming, requestId, networkTiming: finishNetworkTiming(requestId, finishedAtMs)});
        }
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
