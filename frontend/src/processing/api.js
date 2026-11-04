/** Same-origin Processing API for catalog rasters, owned polygon inputs and job results. */
import { validateCalculationRows, validateModelResult } from "./model-results.js";
import { normalizeRasterSamplingArea } from "../selected-area.js";
import { normalizeCalculationArea, validatePolygonAreaReference } from "./calculation-area.js";
import { calculationPixelPoint, chunkPixels, validateModelIdentity } from "./calculation-session.js";
import { csvParse } from "d3";

/** Serialize one raster identity without carrying display state or file paths.
 * @param {Object} source Catalog item, exact temporal observation or owned run-file source.
 * @return {Object} Path-free source accepted by Processing operations.
 * @throws {Error} If a private source has invalid opaque identifiers.
 */
function processingRasterReference(source) {
    return source.kind === "runArtifact" ? {kind: "runArtifact", jobId: validateProcessingId(source.jobId), artifactId: validateProcessingId(source.artifactId)} :
        {collectionId: source.collectionId, itemId: source.itemId,
            ...(source.variable === undefined ? {} : {variable: source.variable, time: source.time})};
}

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

/** Check a job, artifact, polygon upload or deletion identifier used by the API.
 * @param {string} id Candidate 32-character identifier.
 * @return {string} Validated identifier.
 * @throws {TypeError} If the identifier contains unsupported characters or has the wrong length.
 */
function validateProcessingId(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(id)) {
        throw new TypeError("Invalid processing identity.");
    }
    return id;
}

/** Validate fields used to review native output dimensions.
 * @param {Object} grid API grid.
 * @param {string} operation Job operation, permitting empty aggregate reads outside coverage.
 * @return {void}
 * @throws {Error} If dimensions or execution metadata violate their bounded contract.
 */
function validateGrid(grid, operation) {
    const empty = grid?.width === 0 && grid?.height === 0;
    if (!grid || ![grid.width, grid.height].every(value => Number.isSafeInteger(value) && value >= 0) ||
        (grid.width === 0 || grid.height === 0) && !empty ||
        empty && (operation !== "raster.aggregate.v1" || grid.nativeBlocks !== 0 || grid.execution?.readWindows !== 0) ||
        typeof grid.crs !== "string" || typeof grid.dtype !== "string" ||
        !Array.isArray(grid.transform) || grid.transform.length !== 6 || !grid.transform.every(Number.isFinite)) {
        throw new Error("Processing returned an invalid native grid.");
    }
    if (grid.execution) validateExecution(grid.execution);
}

/** Check raster batch dimensions and the number of planned read windows.
 * A point outside raster coverage can have zero read windows.
 * @param {Object} execution Planned read and evaluation dimensions.
 * @return {void}
 * @throws {Error} If batch dimensions or read-window count are invalid.
 */
function validateExecution(execution) {
    chunkPixels(execution.targetChunkPixels);
    if (![execution.readWidth, execution.readHeight, execution.evaluationWidth, execution.evaluationHeight]
        .every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(execution.readWindows) || execution.readWindows < 0 ||
        execution.evaluationWidth > execution.readWidth || execution.evaluationHeight > execution.readHeight) {
        throw new Error("Processing returned invalid batch dimensions.");
    }
}

/** Check a job's status, progress, results and download links before displaying it.
 * Model stage descriptions are optional literal text: when present, they must
 * contain non-whitespace text and at most 200 Unicode code points.
 * @param {Object} job API response, including optional cache metadata.
 * @return {Object} Validated job.
 * @throws {Error} If the lifecycle, results, metadata or download links are invalid.
 */
function validateJob(job) {
    validateProcessingId(job?.jobId);
    if (!["queued", "running", "cancelling", "ready", "failed", "cancelled", "interrupted", "expired", "deleted"].includes(job.status) ||
        !job.progress || typeof job.progress !== "object") throw new Error("Processing returned an invalid job state.");
    if (job.operation === "model.run.v1") {
        validateModelIdentity(job.model);
        const description = job.progress.description;
        if (description != null && (typeof description !== "string" || !description.trim() || [...description].length > 200))
            throw new Error("Processing returned an invalid model progress description.");
        if (typeof job.name !== "string" || !job.name.trim() || [...job.name].length > 80 ||
            typeof job.nameTimestamp !== "string" || !/^\d{4}(?:_\d{2}){5}$/.test(job.nameTimestamp) ||
            job.label !== `${job.name} · ${job.nameTimestamp}` || !["createdAt", "updatedAt"].every(key => Number.isFinite(Date.parse(job[key]))) ||
            !["expiresAt", "metadataExpiresAt"].every(key => job[key] === null || Number.isFinite(Date.parse(job[key]))) ||
            ![job.progress.completed, job.progress.total].every(value => value == null || Number.isSafeInteger(value) && value >= 0) ||
            job.progress.completed != null && job.progress.total != null && job.progress.completed > job.progress.total)
            throw new Error("Processing returned invalid model run details.");
        validateModelArtifacts(job.artifacts, job);
        if (job.deletionUndo != null) {
            validateProcessingId(job.deletionUndo.deletionId);
            if (job.status !== "deleted" || !Number.isFinite(Date.parse(job.deletionUndo.expiresAt)))
                throw new Error("Processing returned invalid deletion Undo details.");
        }
    }
    if (job.grid) validateGrid(job.grid, job.operation);
    if (job.result) {
        processingDownloadUrl(job.result.url, job.jobId, "result");
        processingDownloadUrl(job.result.provenanceUrl, job.jobId, "provenance");
        if (job.operation === "model.run.v1") {
            validateModelResult(job.result);
        } else if (job.operation === "raster.aggregate.v1") {
            validateCalculationRows(job.result.rows);
            if (job.result.cacheHit != null && typeof job.result.cacheHit !== "boolean") {
                throw new Error("Processing returned invalid cache metadata.");
            }
        }
    }
    return job;
}

/** Check a run's output-file list, sizes and download URLs against its current status.
 * One declared output can produce many files, so the list has no fixed count limit.
 * Every file still requires valid metadata, a unique identity and a run-scoped URL.
 * @param {Object} manifest Complete file metadata from the server.
 * @param {Object} job Owning model job and its lifecycle snapshot.
 * @return {void}
 * @throws {Error} If identities, availability, sizes or download URLs are invalid.
 */
function validateModelArtifacts(manifest, job) {
    if (!manifest || manifest.jobId !== job.jobId || manifest.expiresAt !== job.expiresAt ||
        !["pending", "available", "unavailable"].includes(manifest.availability) ||
        !Array.isArray(manifest.files) ||
        !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 ||
        (manifest.availability === "available" ? job.status !== "ready" || !manifest.files.length : manifest.files.length || manifest.totalBytes))
        throw new Error("Processing returned invalid result file availability.");
    const ids = new Set(), names = new Set();
    let total = 0;
    for (const file of manifest.files) {
        if (!file || !/^[a-f0-9]{32}$/.test(file.artifactId) || ids.has(file.artifactId) ||
            typeof file.name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(file.name) || names.has(file.name) ||
            typeof file.label !== "string" || !file.label || file.label.length > 200 ||
            typeof file.displayName !== "string" || !file.displayName.trim() || [...file.displayName].length > 305 ||
            !["result", "intermediate", "provenance"].includes(file.role) ||
            typeof file.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(file.filename) ||
            typeof file.mediaType !== "string" || file.mediaType.length > 100 || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(file.mediaType) ||
            !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
            throw new Error("Processing returned invalid result file details.");
        processingArtifactDownloadUrl(file.url, job.jobId, file.artifactId);
        ids.add(file.artifactId); names.add(file.name); total += file.bytes;
    }
    if (!Number.isSafeInteger(total) || total > manifest.totalBytes)
        throw new Error("Processing returned invalid result file sizes.");
}

/** Check the recipe fields used to construct a setup form.
 * @param {Object} model Installed recipe with its checksum.
 * @return {Object} Validated recipe.
 * @throws {Error} If the recipe is missing its display or form fields.
 */
function validateAvailableModel(model) {
    validateModelIdentity(model);
    if (model.schema !== "eolab.model/v1" || typeof model.title !== "string" || typeof model.description !== "string" ||
        ![model.inputs, model.parameters, model.outputs].every(value => value && typeof value === "object" && !Array.isArray(value)) ||
        !Object.values(model.inputs).every(input => typeof input?.type === "string" && typeof input.label === "string") ||
        !Object.values(model.parameters).every(parameter => typeof parameter?.type === "string" && typeof parameter.label === "string"))
        throw new Error("Invalid model setup definition.");
    return model;
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
        this.pendingCalculations = [];
    }

    /** Share one event stream for planning and job observers after cookie setup.
     * Only fixed changed hints trigger authoritative status reads.
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
                        for (const listener of this.eventListeners) listener();
                    }
                };
                source.addEventListener("changed", receive);
                this.eventStream = {source, receive};
            }
            // Give each subscription its own identity even if a callback is reused.
            const listener = () => { if (!closed) changed(); };
            this.eventListeners.add(listener);
            return () => {
                if (closed) return;
                closed = true;
                this.eventListeners.delete(listener);
                if (this.eventListeners.size === 0) {
                    const {source, receive} = this.eventStream;
                    source.removeEventListener("changed", receive);
                    source.close();
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
     * @param {AbortSignal} [signal] Optional caller deadline or cancellation.
     * @return {Promise<{jobs:Object[], unavailableJobIds:string[]}>} Snapshots and unavailable IDs.
     * @throws {Error} If an ID, request, or response is invalid or incomplete.
     */
    async readJobStatuses(jobIds, signal) {
        const requested = [...new Set(jobIds.map(validateProcessingId))];
        const result = {jobs: [], unavailableJobIds: []};
        await this.ensureSession();
        for (let offset = 0; offset < requested.length; offset += 100) {
            const batch = requested.slice(offset, offset + 100);
            const response = await this.request("/jobs/status", "POST", {jobIds: batch}, signal);
            if (!Array.isArray(response.jobs) || !Array.isArray(response.unavailableJobIds))
                throw new Error("Invalid processing status response.");
            const jobs = response.jobs.map(validateJob);
            const unavailable = response.unavailableJobIds.map(validateProcessingId);
            const returned = [...jobs.map(job => job.jobId), ...unavailable];
            if (returned.length !== batch.length || new Set(returned).size !== batch.length ||
                returned.some(id => !batch.includes(id))) throw new Error("Incomplete processing status response.");
            result.jobs.push(...jobs);
            result.unavailableJobIds.push(...unavailable);
        }
        return result;
    }

    /** Submit complete clip inputs with a stable retry key.
     * @param {Object} submission Captured raster source, explicit area and requestId.
     * @return {Promise<Object>} Owned queued job; the worker supplies its grid later.
     * @throws {Error} If inputs, admission or the returned job are invalid.
     */
    async submitClip(submission) {
        const {source, requestId} = submission;
        const selected = normalizeRasterSamplingArea(submission.area);
        if (!["selectedArea", "samplingBox", "catalogSelection"].includes(selected.kind)) throw new Error("Select a box or vector layer first.");
        await this.ensureSession();
        return validateJob(await this.request("/raster-clips", "POST", {
            ...(source.kind === "runArtifact" ? {source: processingRasterReference(source)} : processingRasterReference(source)), requestId,
            ...(selected.kind === "selectedArea" ? {selectedBounds: selected.selectedBounds}
                : selected.kind === "samplingBox" ? {samplingBox: selected.samplingBox}
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
        return this.request(`/polygon-areas/${validateProcessingId(id)}`, "DELETE");
    }

    /** Submit temporal formulas as one model run, or batch independent raster requests.
     * Each caller retains its independent promise, retry key and cancellation lifecycle.
     * @param {Object} submission Captured calculation intent and stable requestId.
     * @return {Promise<Object>} Owned job with progress and results as the worker produces them.
     * @throws {ProcessingRequestError|Error} If admission fails or the response is invalid.
     */
    async submitCalculation(submission) {
        if (submission.kind === "temporal") {
            const {area, source, calculations, pixelPoint, model, requestId, utcOffsetMinutes} = submission;
            return this.submitModelRun({requestId, model, label: "Temporal raster stack", utcOffsetMinutes, parameters: {}, inputs: {
                source, area: area.kind === "catalogSelection" ? {kind: area.kind, selection: area.catalogSelection}
                    : area.kind === "polygonArea" ? {kind: area.kind, reference: area.polygonArea} : area,
                metrics: {calculations, ...(pixelPoint ? {pixelPoint} : {})},
            }});
        }
        await this.ensureSession();
        const area = normalizeCalculationArea(submission.area);
        const pixelPoint = calculationPixelPoint(submission.calculations, submission.pixelPoint);
        const body = {
            requestId: submission.requestId,
            sources: {a: processingRasterReference(submission.source)},
            calculations: submission.calculations,
            ...(pixelPoint ? { pixelPoint } : {}),
            ...(chunkPixels(submission.targetChunkPixels) == null ? {} : {targetChunkPixels: submission.targetChunkPixels}),
            ...(area.kind === "selectedArea" ? {selectedBounds: area.selectedBounds}
                : area.kind === "samplingBox" ? {samplingBox: area.samplingBox}
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

    /** Discover installed model recipes and their form fields.
     * @return {Promise<Object[]>} Recipes available on this server.
     * @throws {Error} If discovery fails or contains malformed definitions.
     */
    async discoverModels() {
        await this.ensureSession();
        const response = await this.request("/models");
        if (!Array.isArray(response.models)) throw new Error("Invalid model library.");
        return response.models.map(validateAvailableModel);
    }

    /** Read Habitat's source years, acquisition grid and linked input datasets.
     * @return {Promise<{defaultYear:number,minimumYear:number,maximumYear:number,grid:Object,datasets:Array<{label:string,url:string,roles:Array<"predictor"|"response">}>}>} Source choices without connection credentials.
     * @throws {Error} If the configuration request fails.
     */
    async getHabitatEarthEngineOptions() {
        return this.request("/models/habitat-condition/earth-engine-options");
    }

    /** Read a page of this browser session's model history.
     * @param {string|null} [cursor=null] Continuation returned by the preceding page.
     * @return {Promise<{jobs:Object[],nextCursor:string|null}>} Runs and the next page token.
     * @throws {Error} If the request fails or pagination data is invalid.
     */
    async listModelRuns(cursor = null) {
        await this.ensureSession();
        const response = await this.request(`/model-runs?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (!Array.isArray(response.jobs) || !(response.nextCursor === null || typeof response.nextCursor === "string"))
            throw new Error("Invalid model run history.");
        response.jobs.forEach(job => {
            validateJob(job);
            if (job.operation !== "model.run.v1") throw new Error("Unexpected job in model history.");
        });
        return response;
    }

    /** Submit the captured setup with the same request ID on every retry.
     * @param {Object} submission Model identity, inputs, parameters, label and request ID.
     * @return {Promise<Object>} Accepted job status.
     * @throws {ProcessingRequestError|Error} If admission fails or the reply is invalid.
     */
    async submitModelRun(submission) {
        await this.ensureSession();
        const job = validateJob(await this.request("/model-runs", "POST", submission));
        if (job.operation !== "model.run.v1") throw new Error("Unexpected model submission response.");
        return job;
    }

    /** Read a temporal stack's owned CSV without converting exact scalar text.
     * The current writer supplies chronological observations and named formula rows.
     * @param {Object} job Completed, validated temporal stack job.
     * @param {AbortSignal} [signal] Cancellation when the requested plot changes.
     * @return {Promise<{csv:string, observations:{time:string,rows:Object[]}[]}>} Original download and plot rows grouped by observation.
     * @throws {ProcessingRequestError|Error} If the owned download is unavailable, expired, cancelled or unreadable.
     */
    async readTemporalStackRows(job, signal) {
        const response = await this.fetch.call(globalThis, processingDownloadUrl(job.result.url, job.jobId, "result"),
            {credentials: "same-origin", cache: "no-store", headers: {Accept: "text/csv"}, signal});
        if (!response.ok) throw new ProcessingRequestError("The temporal result is unavailable or has expired. Calculate again.", response.status);
        const csv = await response.text();
        const observations = new Map();
        const expressions = new Map(job.result.calculations.map(value => [value.label, value.expression]));
        for (const row of csvParse(csv)) {
            if (!observations.has(row.time_utc)) observations.set(row.time_utc, {time: row.time_utc, rows: []});
            observations.get(row.time_utc).rows.push({label: row.calculation, expression: expressions.get(row.calculation),
                value: row.value === "" ? null : row.value, valueType: row.value_type, unit: row.unit,
                state: row.state, aggregates: JSON.parse(row.aggregates)});
        }
        return {csv, observations: [...observations.values()]};
    }

    /** Read the exact recipe and inputs originally accepted for a run.
     * @param {string} id Session-owned model run ID.
     * @return {Promise<Object>} Saved invocation for details or duplication.
     * @throws {Error} If access fails, metadata expired, or the reply is invalid.
     */
    async readModelInvocation(id) {
        await this.ensureSession();
        const invocation = await this.request(`/jobs/${validateProcessingId(id)}/invocation`);
        validateModelIdentity(invocation.model);
        validateAvailableModel({...invocation.model.definition, definitionSha256: invocation.model.definitionSha256});
        if (!invocation.inputs || !invocation.parameters || typeof invocation.label !== "string")
            throw new Error("Invalid saved model inputs.");
        return invocation;
    }

    /** Build the installed recipe's download address.
     * @param {Object} model Validated model identity.
     * @return {string} Same-origin Model YAML URL.
     * @throws {Error} If the model identity is invalid.
     */
    modelYamlUrl(model) {
        validateModelIdentity(model);
        return `/api/processing/models/${model.id}/versions/${model.version}/yaml`;
    }

    /** Read Model YAML for an inline, text-only preview.
     * @param {Object} model Installed recipe identity.
     * @param {string|null} [jobId=null] Read the accepted recipe instead when supplied.
     * @return {Promise<string>} YAML text.
     * @throws {ProcessingRequestError|Error} If access fails or metadata has expired.
     */
    async readModelYaml(model, jobId = null) {
        await this.ensureSession();
        const url = jobId ? processingDownloadUrl(`/api/processing/jobs/${jobId}/model-yaml`, jobId, "model-yaml") : this.modelYamlUrl(model);
        const response = await this.fetch.call(globalThis, url, {credentials: "same-origin", cache: "no-store", headers: {Accept: "application/yaml"}});
        if (!response.ok) throw new ProcessingRequestError("Model YAML is unavailable or has expired.", response.status);
        return response.text();
    }

    /** Read a tracked job even if it falls outside recent history. @param {string} id Job ID. @return {Promise<Object>} Owned job. */
    async getJob(id) {
        await this.ensureSession();
        return validateJob(await this.request(`/jobs/${validateProcessingId(id)}`));
    }

    /** Keep a completed model run and its outputs for another seven days.
     * @param {string} id Owned model run ID.
     * @return {Promise<Object>} Validated run with its effective expiry.
     * @throws {ProcessingRequestError|Error} If the run is unavailable or the request fails.
     */
    async renewModelRun(id) {
        await this.ensureSession();
        return validateJob(await this.request(`/jobs/${validateProcessingId(id)}/renew`, "POST"));
    }

    /** Rename a model run without changing its creation time, inputs or outputs.
     * @param {string} id Owned model run ID.
     * @param {string} label User's new name, excluding the automatic creation timestamp.
     * @return {Promise<Object>} Validated run with its updated display names.
     * @throws {ProcessingRequestError|Error} If the run is unavailable, renaming fails or the reply is invalid.
     */
    async renameModelRun(id, label) {
        await this.ensureSession();
        const job = validateJob(await this.request(`/jobs/${validateProcessingId(id)}/name`, "PATCH", {label}));
        if (job.operation !== "model.run.v1" || job.jobId !== id) throw new Error("Unexpected model rename response.");
        return job;
    }

    /** Delete a model run while keeping a thirty-second Undo opportunity.
     * @param {string} id Owned model run ID.
     * @return {Promise<Object>} Deleted run with its server-controlled Undo deadline.
     * @throws {ProcessingRequestError|Error} If deletion fails or the reply is invalid.
     */
    async deleteModelRun(id) {
        await this.ensureSession();
        return validateJob(await this.request(`/jobs/${validateProcessingId(id)}?undo=true`, "DELETE"));
    }

    /** Restore one exact model deletion before its Undo deadline.
     * @param {string} id Owned run ID.
     * @param {string} deletionId Deletion being undone.
     * @return {Promise<Object>} Restored run with its original expiry.
     * @throws {ProcessingRequestError|Error} If the deletion changed or Undo expired.
     */
    async undoModelDeletion(id, deletionId) {
        await this.ensureSession();
        return validateJob(await this.request(`/jobs/${validateProcessingId(id)}/deletion/undo`, "POST", {deletionId: validateProcessingId(deletionId)}));
    }

    /** End the Undo window for one exact deletion so ordinary cleanup can proceed.
     * @param {string} id Owned run ID.
     * @param {string} deletionId Deletion being dismissed.
     * @return {Promise<Object>} Authoritative run state after dismissal.
     * @throws {ProcessingRequestError|Error} If ownership or deletion identity changed.
     */
    async dismissModelDeletion(id, deletionId) {
        await this.ensureSession();
        return validateJob(await this.request(`/jobs/${validateProcessingId(id)}/deletion/dismiss`, "POST", {deletionId: validateProcessingId(deletionId)}));
    }

    /** Cancel an owned active job. @param {string} id Job ID. @return {Promise<Object>} Updated job. */
    async cancelJob(id) {
        await this.ensureSession();
        return this.request(`/jobs/${validateProcessingId(id)}/cancel`, "POST");
    }

    /** Revoke an owned terminal result. @param {string} id Job ID. @return {Promise<Object>} Updated job. */
    async deleteJob(id) {
        await this.ensureSession();
        return this.request(`/jobs/${validateProcessingId(id)}`, "DELETE");
    }

    /**
     * Send one bounded JSON request and preserve classified API errors.
     * HTTP completion does not imply that a job is ready.
     * @param {string} path Owned endpoint suffix. @param {string} [method="GET"] HTTP method.
     * @param {Object|undefined} body JSON input. @param {AbortSignal|undefined} signal Request cancellation.
     * @return {Promise<Object>} Parsed response.
     * @throws {ProcessingRequestError|Error} HTTP rejection, failed transport, or unreadable JSON.
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
    }
}

/**
 * Allow direct browser navigation only to the owned result endpoints.
 * @param {string} value API-supplied relative URL. @param {string} id Owning job.
 * @param {"result"|"provenance"|"model-yaml"|"run-yaml"} kind Artifact type. @return {string} Safe local download URL.
 */
export function processingDownloadUrl(value, id, kind) {
    const expected = `/api/processing/jobs/${validateProcessingId(id)}/${kind}`;
    if (!["result", "provenance", "model-yaml", "run-yaml"].includes(kind) || value !== expected) {
        throw new TypeError("Invalid processing download address.");
    }
    return expected;
}

/** Allow downloads only from a file's owning run and opaque artifact ID.
 * @param {string} value API-supplied relative download URL.
 * @param {string} jobId Owning model run.
 * @param {string} artifactId File identity from its validated manifest.
 * @return {string} Safe same-origin file URL.
 * @throws {TypeError} If an identity or address is invalid.
 */
export function processingArtifactDownloadUrl(value, jobId, artifactId) {
    const expected = `/api/processing/jobs/${validateProcessingId(jobId)}/artifacts/${validateProcessingId(artifactId)}`;
    if (value !== expected) throw new TypeError("Invalid result file download address.");
    return expected;
}
