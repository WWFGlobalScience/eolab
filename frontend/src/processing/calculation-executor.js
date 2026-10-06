/** Submit and observe a calculation whose preparation and execution share one job. */
import { ACTIVE_JOB_STATES } from "./jobs.js";
import { ProcessingRequestError, waitBeforeCapacityRetry } from "./api.js";
import { calculationIntent } from "./calculation-session.js";
import { describeJobProgress } from "./presentation.js";

/**
 * @typedef {Object} CalculationExecutionSnapshot
 * @property {boolean} isIdle No submission, cancellation or replacement remains.
 * @property {"busy"|"retry"|"ready"} admission Whether another calculation can proceed.
 * @property {Object|null} unfinishedCalculation Inputs, caller context and cancellation intent.
 * @property {boolean} recoverable A saved submission requires retry after a failure.
 * @property {string} phase Job phase or local submission state.
 * @property {string} message Progress or error description.
 * @property {Object|null} currentJob Job including prepared grid and estimates when available.
 * @property {Object|null} completedJob Last successful job.
 * @property {Object|null} completedCalculation Inputs for the last successful job.
 * @property {Object|null} completedTimings Submission and result-observation measurements.
 * @property {ReadonlyArray<Object>} jobs Summary history.
 * @property {string} historyError History retrieval error.
 */

/** Preserve submission identity and cancellation across browser reloads. */
export class CalculationExecutor {
    #status;
    #saved;
    #pending = null;
    #advancing = false;
    #retryRequired = false;
    #capacityWait = null;
    #observationChanged = false;

    /** Connect transport, job observation and per-caller recovery storage.
     * @param {Object} options Providers.
     * @param {Object} options.api Processing API client.
     * @param {Object} options.jobs Shared job observer.
     * @param {Object} options.storage Per-caller session storage.
     * @param {(snapshot:CalculationExecutionSnapshot)=>void} options.onChange Progress consumer.
     * @param {(area:Object|null)=>void} [options.onActivity] Working-area callback.
     * @param {()=>string} [options.requestId] Submission key factory.
     * @param {()=>number} [options.now] Monotonic clock in milliseconds.
     */
    constructor({api, jobs, storage, onChange, onActivity = () => {},
        requestId = () => crypto.randomUUID(), now = () => performance.now()}) {
        Object.assign(this, {api, jobs, storage, onChange, onActivity, requestId, now});
        this.#status = {phase: "idle", message: "", currentJob: null, completedJob: null,
            completedCalculation: null, completedTimings: null, jobs: [], historyError: ""};
        this.#saved = storage.read();
        this.destroyed = false;
        this.unsubscribe = jobs.subscribe(() => this.#receiveJobs());
    }

    /** Read progress and admission state together. @return {CalculationExecutionSnapshot} Current snapshot. */
    get snapshot() {
        const isIdle = !this.#saved && !this.#pending && !this.#advancing;
        return Object.freeze({...this.#status, jobs: Object.freeze([...this.#status.jobs]), isIdle,
            admission: !isIdle ? "busy" : this.#retryRequired ? "retry" : "ready",
            recoverable: !!this.#saved && this.#retryRequired,
            unfinishedCalculation: this.#saved ? Object.freeze({calculation: this.#saved.intent,
                context: this.#saved.context, cancelRequested: this.#saved.cancelRequested}) : null});
    }

    /** Resume saved work or recover an uncertain submission. @return {Promise<void>} Initial observation and actions. */
    async start() {
        if (this.#saved?.jobId) this.jobs.tracked.add(this.#saved.jobId);
        await this.jobs.refresh();
        await this.#advance();
    }

    /** Retry using the original request key. @return {Promise<void>} Currently available lifecycle actions. */
    async retry() { this.#retryRequired = false; await this.#advance(); }

    /** Forget an unsent replacement; stop() cancels accepted work. @return {void} */
    discardPendingCalculation() { this.#pending = null; }

    /** Submit complete inputs; the worker prepares and executes without another browser instruction.
     * @param {Object} calculation Raster, selected area and named formulas.
     * @param {Object|null} [context=null] Caller-owned recovery metadata.
     * @return {void} Progress is delivered through onChange.
     * @throws {TypeError} If the calculation inputs violate the browser contract.
     */
    submit(calculation, context = null) {
        if (this.destroyed) return;
        const intent = calculationIntent(calculation);
        if (this.#retryRequired && this.#saved) return;
        if ([this.#pending, this.#saved].some(item => item && !item.cancelRequested &&
            JSON.stringify(item.intent) === JSON.stringify(intent))) return;
        this.#pending = {intent, context: context && Object.freeze({...context})};
        this.#retryRequired = false;
        if (this.#saved) this.#cancelSaved();
        void this.#advance();
    }

    /** Record cancellation before contacting the server. @return {void} */
    #cancelSaved() {
        if (!this.#saved) return;
        this.#saved.cancelRequested = true;
        this.#capacityWait?.abort();
        try { this.storage.write(this.#saved); }
        catch (error) { this.#status.message = error.message; }
    }

    /** Cancel current work and discard its pending replacement. @return {void} */
    stop() {
        this.#pending = null;
        this.#cancelSaved();
        if (!this.#saved) this.#status.message = "Calculation cancelled.";
        void this.#advance();
        this.#notify();
    }

    /** Retry capacity rejections with the same submission key.
     * @return {Promise<Object|null>} Accepted job or null after a known rejection and cancellation.
     * @throws {Error} If admission fails or its outcome remains uncertain.
     */
    async #submitWhenCapacityAvailable() {
        const saved = this.#saved;
        for (let attempt = 0; ; attempt++) {
            try {
                if (this.trace) this.trace.submissionAttempts = attempt + 1;
                return await this.api.submitCalculation({...saved.intent, requestId: saved.pending.requestId});
            } catch (error) {
                if (error instanceof ProcessingRequestError && error.isCapacityRejection) {
                    const wait = this.#capacityWait = new AbortController();
                    if (saved.cancelRequested || this.destroyed) wait.abort();
                    this.#status.phase = "waiting";
                    this.#status.message = error.code === "previous_attempt_stopping" ? error.message : "Waiting for server capacity; retrying automatically…";
                    this.#notify();
                    const started = this.now();
                    try { await waitBeforeCapacityRetry(error, attempt, wait.signal); continue; }
                    catch (cancelled) { if (cancelled.name !== "AbortError") throw cancelled; }
                    finally {
                        if (this.trace) this.trace.capacityWaitSeconds = (this.trace.capacityWaitSeconds ?? 0) + (this.now()-started)/1000;
                        this.#capacityWait = null;
                    }
                } else if (!(error instanceof ProcessingRequestError) || error.status < 400 || error.status >= 500 || error.status === 408) {
                    throw error;
                }
                this.storage.clear();
                this.#saved = null;
                if (saved.cancelRequested || this.destroyed) return null;
                throw error;
            }
        }
    }

    /** Advance submission and cancellation; completed submissions use ordinary result handling.
     * Observation resumes only jobs which are still active.
     * @return {Promise<void>} Completion of currently available actions.
     */
    async #advance() {
        if (this.#advancing || this.destroyed || this.#retryRequired) return;
        this.#advancing = true;
        this.#observationChanged = false;
        try {
            if (!this.#saved && this.#pending) {
                const record = {...this.#pending, cancelRequested: false, pending: {requestId: this.requestId()}, jobId: null};
                this.storage.write(record);
                this.#saved = record;
                this.#pending = null;
                this.trace = {submissionStartedAtMs: this.now()};
            }
            if (this.#saved?.pending) {
                this.#status.phase = "submitting";
                this.#status.message = "Submitting calculation…";
                this.#notify();
                const job = await this.#submitWhenCapacityAvailable();
                if (!job) return;
                if (this.trace) { this.trace.submissionFinishedAtMs = this.now(); this.trace.jobId = job.jobId; }
                this.#saved.jobId = job.jobId;
                this.#saved.pending = null;
                this.storage.write(this.#saved);
                if (job.status === "ready") this.api.diagnostics?.record("ready-received", {jobId: job.jobId, trigger: "submission"});
                if (ACTIVE_JOB_STATES.has(job.status)) this.jobs.tracked.add(job.jobId);
                this.jobs.accept(job);
                if (job.status === "ready") this.api.diagnostics?.record("ready-accepted", {jobId: job.jobId, trigger: "submission"});
            }
            if (!this.#saved?.jobId) return;
            let job = this.jobs.jobs.find(item => item.jobId === this.#saved.jobId);
            if (!job) {
                await this.jobs.refresh();
                job = this.jobs.jobs.find(item => item.jobId === this.#saved.jobId);
                if (!job) throw new Error(this.jobs.error || "The saved calculation could not be retrieved.");
            }
            this.#status.currentJob = job;
            if (ACTIVE_JOB_STATES.has(job.status)) {
                this.#status.phase = this.#saved.cancelRequested ? "cancelling" : job.progress?.phase ?? job.status;
                this.#status.message = this.#saved.cancelRequested ? "Cancelling calculation…" : describeJobProgress(job);
                if (this.#saved.cancelRequested && job.status !== "cancelling") await this.jobs.action(job.jobId, "cancel");
                return;
            }
            if (job.status === "ready" && !this.#saved.cancelRequested) {
                if (this.trace) {
                    this.trace.executorReadyAtMs = this.now();
                    this.trace.deliveryDiagnostics = this.api.diagnostics?.snapshot(this.trace.submissionStartedAtMs, null, job.jobId);
                }
                this.#status.completedJob = job;
                this.#status.completedCalculation = this.#saved.intent;
                this.#status.completedTimings = this.trace ?? null;
                this.#status.message = "Calculation complete.";
            } else this.#status.message = this.#saved.cancelRequested || job.status === "cancelled"
                ? "Calculation cancelled." : job.error?.detail ?? "Calculation interrupted. Calculate to try again.";
            this.jobs.tracked.delete(job.jobId);
            this.storage.clear();
            this.#saved = null;
            this.trace = null;
            this.#status.currentJob = null;
            this.#status.phase = "idle";
        } catch (error) {
            this.#retryRequired = true;
            this.trace = null;
            this.#pending = null;
            this.#status.phase = "error";
            this.#status.message = `${error.message}${this.#saved ? " Recover / retry to confirm or cancel the same job safely." : " Click Calculate to retry."}`;
        } finally {
            this.#advancing = false;
            this.#notify();
            if (((!this.#saved && this.#pending) || this.#observationChanged) && !this.#retryRequired && !this.destroyed)
                queueMicrotask(() => void this.#advance());
        }
    }

    /** Apply job history and continue this caller's observed work. @return {void} */
    #receiveJobs() {
        this.#status.jobs = this.jobs.jobs.filter(job => job.operation === "raster.aggregate.v1");
        this.#status.historyError = this.jobs.error;
        if (this.#status.completedJob) this.#status.completedJob = this.jobs.jobs.find(job =>
            job.jobId === this.#status.completedJob.jobId) ?? this.#status.completedJob;
        if (this.#saved?.jobId) {
            if (this.#advancing) this.#observationChanged = true;
            else void this.#advance();
        }
        this.#notify();
    }

    /** Cancel or delete a job from history.
     * @param {string} id Job ID. @param {"cancel"|"delete"} action Requested action.
     * @return {Promise<void>} Completion or displayed failure.
     */
    async jobAction(id, action) {
        if (id === this.#saved?.jobId && action === "cancel") { this.stop(); return; }
        try { await this.jobs.action(id, action); }
        catch (error) { this.#status.message = error.message; this.#notify(); }
    }

    /** Publish progress and working-area activity. @return {void} */
    #notify() {
        if (this.destroyed) return;
        this.onChange(this.snapshot);
        this.onActivity(this.#saved && !this.#saved.cancelRequested && !this.#retryRequired ? this.#saved.intent.area : null);
    }

    /** Detach observation; accepted jobs remain recoverable after reload. @return {void} */
    destroy() {
        this.destroyed = true;
        this.#capacityWait?.abort();
        this.#pending = null;
        this.unsubscribe();
        this.onActivity(null);
    }
}
