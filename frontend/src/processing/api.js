/** Same-origin Processing API for catalog rasters, owned polygon inputs and job results. */
import { normalizeRasterSamplingArea } from "../selected-area.js";
import { normalizeCalculationArea, validatePolygonAreaReference } from "./calculation-area.js";
import { chunkPixels } from "./calculation-session.js";
import { ProcessingDiagnostics } from "./diagnostics.js";

/** Browser-only observation of one planning attempt, not persisted on the server.
 * SSE hints can concern any owned plan or job, including the stream's initial hint.
 * @typedef {Object} PlanningObservation
 * @property {number} sseHints Number of hints received while observing this plan.
 * @property {number} sseRefreshes Status reads prompted by an SSE hint.
 * @property {number} timerRefreshes Status reads prompted by the two-second fallback.
 * @property {"submission"|"recovery"|"sse"|"timer"} readyResponse What prompted the response that first reported ready.
 */

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
    /** Whether capacity, rather than the calculation's inputs, prevented admission.
     * Storage exhaustion and unknown errors require attention instead of automatic retry.
     * @return {boolean} True only for a classified temporary queue/plan limit.
     */
    get isCapacityRejection() {
        return this.status === 429 && ["plan_queue_full", "plan_record_capacity", "owner_queue_full", "queue_full"].includes(this.code);
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

    /**
     * Review a catalog raster and explicit immutable area, without starting work.
     * @param {{collectionId:string,itemId:string}} source Catalog identity.
     * @param {Object} area Selected rectangle or immutable catalog descriptor.
     * @param {AbortSignal} signal Cancels superseded planning.
     * @param {function(string):void} [onProgress] Receives checking/queued/planning status.
     * @return {Promise<Object>} Native-grid estimate and expiring plan.
     */
    async planClip(source, area, signal, onProgress) {
        const selected = normalizeRasterSamplingArea(area);
        if (selected.kind === "wholeRaster") throw new Error("Select a box or catalog vector first.");
        if (![source.collectionId, source.itemId].every(value => typeof value === "string" && value.length > 0)) {
            throw new TypeError("A Catalog raster is required.");
        }
        await this.ensureSession();
        const plan = await this.preparePlan("raster-clips", {
            collectionId: source.collectionId, itemId: source.itemId,
            ...(selected.kind === "selectedArea"
                ? { selectedBounds: selected.selectedBounds }
                : { catalogSelection: selected.catalogSelection }),
        }, signal, onProgress);
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

    /** Prepare cached results or estimate a new calculation.
     * @param {Object} intent Source, expressions and area.
     * @param {AbortSignal} signal Superseded request.
     * @param {function(string):void} [onProgress] Receives checking/queued/planning status.
     * @return {Promise<Object>} Validated plan with an optional cache-hit flag.
     * @throws {Error} If the request fails or returned plan metadata is invalid.
     */
    async planCalculation(intent, signal, onProgress) {
        const area = normalizeCalculationArea(intent.area);
        const targetChunkPixels = chunkPixels(intent.targetChunkPixels);
        await this.ensureSession();
        const plan = await this.preparePlan("raster-calculations", {
            sources: { a: { collectionId: intent.source.collectionId, itemId: intent.source.itemId } },
            calculations: intent.calculations,
            ...(targetChunkPixels === null ? {} : { targetChunkPixels }),
            ...(area.kind === "selectedArea" ? { selectedBounds: area.selectedBounds }
                : area.kind === "catalogSelection" ? { catalogSelection: area.catalogSelection }
                : area.kind === "polygonArea" ? { polygonArea: area.polygonArea } : { wholeRaster: true }),
        }, signal, onProgress);
        opaqueId(plan.planId);
        validateGrid(plan.grid);
        if (plan.cacheHit != null && typeof plan.cacheHit !== "boolean") {
            throw new Error("Processing returned invalid cache metadata.");
        }
        if (plan.operation !== "raster.aggregate.v1" || !Number.isFinite(Date.parse(plan.expiresAt)) ||
            !Number.isSafeInteger(plan.grid.nativeBlocks) || plan.grid.nativeBlocks < 1 ||
            !Number.isSafeInteger(plan.grid.decodedBytes) || plan.grid.decodedBytes < 1) {
            throw new Error("Processing returned an invalid calculation estimate.");
        }
        validateStages(plan.timing, ["reservationSeconds", "preparationSeconds", "nativeProcessSeconds", "finalizationSeconds"]);
        validateProcessTiming(plan.timing?.process);
        if (plan.timing?.queueSeconds != null) validateStages(plan.timing, ["queueSeconds"]);
        return plan;
    }

    /** Prepare an estimate, automatically waiting for space in the planning queue.
     * A request whose server queue deadline expires is released before a fresh
     * attempt. Actual calculation/planning errors are reported without retry.
     * @param {"raster-clips"|"raster-calculations"} operation Planning endpoint.
     * @param {Object} body Validated source, area and expressions.
     * @param {AbortSignal|undefined} signal Cancels waiting and admitted planning.
     * @param {function(string):void|undefined} onProgress Planning or capacity-wait status.
     * @return {Promise<Object>} Completed estimate, ready for explicit submission.
     * @throws {Error} If planning fails for a non-capacity reason or the caller cancels.
     */
    async preparePlan(operation, body, signal, onProgress) {
        for (let attempt = 0; ; attempt++) {
            try { return await this.submitAndObservePlan(operation, body, signal, onProgress); }
            catch (error) {
                if (!(error instanceof ProcessingRequestError) || error.code !== "plan_queue_timeout") throw error;
                onProgress?.("waiting-capacity");
                await waitBeforeCapacityRetry(error, attempt, signal);
            }
        }
    }

    /** Submit and observe one queued plan using a stable ID and existing SSE hints.
     * A cancelled or uncertain admission is deleted by ID, including when DELETE
     * reaches the server before POST. Server deadlines bound work after tab closure.
     * @param {"raster-clips"|"raster-calculations"} operation Planning endpoint.
     * @param {Object} body Validated source, area and expressions.
     * @param {AbortSignal|undefined} signal Superseded request.
     * @param {function(string):void|undefined} onProgress Planning stage, including waiting-capacity before admission.
     * @return {Promise<Object>} Completed operation plan, with browser-only
     * planningObservation counters for this attempt and the response that found it ready.
     * @throws {Error} If admission, observation or planning fails, or the caller cancels.
     */
    async submitAndObservePlan(operation, body, signal, onProgress) {
        signal?.throwIfAborted();
        const id = crypto.randomUUID().replaceAll("-", "");
        /** @type {PlanningObservation} */
        const observation = {sseHints: 0, sseRefreshes: 0, timerRefreshes: 0, readyResponse: "submission"};
        let notified = false;
        let wake = null;
        const changed = () => { observation.sseHints++; notified = true; wake?.("sse"); };
        const cancelled = () => { wake?.("cancelled"); };
        const close = this.watchJobs(changed);
        signal?.addEventListener("abort", cancelled);
        let discardOnExit = true;
        try {
            let snapshot;
            try {
                // Do not abandon admission when the UI changes: recover or delete
                // its stable ID even if its response is lost behind a proxy.
                for (let attempt = 0; ; attempt++) {
                    signal?.throwIfAborted();
                    discardOnExit = true;
                    try {
                        snapshot = await this.request(`/${operation}/plans/${id}`, "POST", body, AbortSignal.timeout(10000));
                        break;
                    } catch (error) {
                        if (!(error instanceof ProcessingRequestError) || !error.isCapacityRejection) throw error;
                        discardOnExit = false; // No admitted plan to delete while waiting.
                        onProgress?.("waiting-capacity");
                        await waitBeforeCapacityRetry(error, attempt, signal);
                    }
                }
            } catch (error) {
                if (!discardOnExit) throw error;
                if (error instanceof ProcessingRequestError && error.status < 500 && error.status !== 408) {
                    discardOnExit = false; // Definitive admission rejection created no work.
                    throw error;
                }
                observation.readyResponse = "recovery";
                snapshot = await this.request(`/plans/${id}`, "GET", undefined, AbortSignal.timeout(10000));
            }
            while (true) {
                signal?.throwIfAborted();
                if (snapshot?.planId !== id || !["checking", "queued", "planning", "cancelling", "ready", "failed", "cancelled"].includes(snapshot.status)) {
                    throw new Error("Processing returned invalid planning progress.");
                }
                if (snapshot.status === "ready") {
                    if (snapshot.result?.planId !== id) throw new Error("Processing returned an invalid completed plan.");
                    discardOnExit = false;
                    return {...snapshot.result, planningObservation: observation};
                }
                if (["failed", "cancelled", "cancelling"].includes(snapshot.status)) {
                    throw new ProcessingRequestError(snapshot.error?.detail ?? "Planning was cancelled.", 422,
                        snapshot.error?.code ?? "plan_cancelled");
                }
                onProgress?.(snapshot.status);
                const trigger = notified ? "sse" : await new Promise(resolve => {
                    const timer = setTimeout(() => { wake = null; resolve("timer"); }, 2000);
                    wake = reason => { clearTimeout(timer); wake = null; resolve(reason); };
                });
                notified = false;
                signal?.throwIfAborted();
                observation.readyResponse = trigger;
                if (trigger === "sse") observation.sseRefreshes++;
                else observation.timerRefreshes++;
                snapshot = await this.request(`/plans/${id}`, "GET", undefined, signal);
            }
        } finally {
            close?.();
            signal?.removeEventListener("abort", cancelled);
            if (discardOnExit) await this.request(`/plans/${id}`, "DELETE", undefined, AbortSignal.timeout(10000));
        }
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
     * Retain bounded browser timings and numeric server durations, without bodies
     * or credentials. HTTP completion does not imply that a job is ready.
     * @param {string} path Owned endpoint suffix. @param {string} [method="GET"] HTTP method.
     * @param {Object|undefined} body JSON input. @param {AbortSignal|undefined} signal Planning cancellation.
     * @return {Promise<Object>} Parsed response.
     * @throws {ProcessingRequestError|Error} HTTP rejection, failed transport, or unreadable JSON.
     */
    async request(path, method = "GET", body, signal) {
        const requestNumber = ++this.requestSequence;
        const identity = path.match(/^\/jobs\/([a-f0-9]{32})(?:\/|$)/);
        const plan = path.match(/\/plans\/([a-f0-9]{32})$/);
        const fields = {requestNumber, method, path, jobId: identity?.[1], planId: plan?.[1] ?? body?.planId,
            shared: path === "/jobs", inFlight: ++this.requestsInFlight};
        const startedAtMs = this.diagnostics.record("http-start", fields);
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
                const match = metric.trim().match(/^(processing|admissionChecks|queueAdmission|jobRead);dur=([\d.]+)$/);
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
            this.requestsInFlight--;
            this.diagnostics.record("http-finish", {...fields, status: response?.status ?? null,
                seconds: (finishedAtMs - startedAtMs) / 1000,
                headersSeconds: headersAtMs == null ? null : (headersAtMs - startedAtMs) / 1000,
                bodySeconds: headersAtMs == null ? null : (finishedAtMs - headersAtMs) / 1000,
                serverTiming});
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
