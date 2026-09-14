/** Track one submitted calculation at a time, saving enough state to resume after reload. */
import { ACTIVE_JOB_STATES } from "./jobs.js";
import { ProcessingRequestError } from "./api.js";
import { calculationIntent } from "./calculation-session.js";

/** Compare calculation settings without relying on object identity.
 * @param {Object|null} value Raster, area and formula settings.
 * @return {string} Serialized comparison key.
 */
function identity(value) { return JSON.stringify(value); }

/**
 * Progress sent to the statistics controller. The saved submission and scheduler
 * fields stay private. The snapshot and unfinished-calculation description are
 * frozen; consumers also treat the enclosed job and plan API values as read-only.
 * @typedef {Object} CalculationExecutionSnapshot
 * @property {boolean} isIdle No calculation or API step remains in progress. This can follow
 * success, cancellation, failure, or a plan waiting for confirmation; it does not mean success.
 * @property {"busy"|"retry"|"ready"} admission Busy includes cancellation/recovery;
 * retry requires an explicit new request after failure; ready permits work.
 * @property {{calculation:Readonly<Object>,context:Readonly<Object>|null,cancelRequested:boolean}|null} unfinishedCalculation
 * Description of a submission still being tracked in this tab. Used to restore cards
 * after reload, including lost submission responses. Null when nothing needs resuming.
 * @property {boolean} recoverable A saved submission needs Recover / retry after an API or storage failure.
 * @property {string} phase Execution phase, independent of editor validation.
 * @property {string} message Execution feedback.
 * @property {Object|null} plan Prepared server plan awaiting a submit instruction.
 * @property {Readonly<Object>|null} plannedCalculation Settings that produced the prepared plan.
 * @property {Object|null} currentJob Job being tracked, including its ID, status and progress.
 * @property {Object|null} completedJob Last successfully completed job, retained during replacement.
 * Contains jobId/status/source metadata; its result property contains values and export URLs.
 * @property {Readonly<Object>|null} completedCalculation Calculation settings that produced completedJob.
 * @property {Object|null} completedTimings Planning/submission timestamps in browser-clock milliseconds
 * plus the server planning measurements; the summary computes elapsed durations.
 * @property {ReadonlyArray<Object>} jobs Calculation history from the shared observer.
 * @property {string} historyError Shared history retrieval error.
 */

/** Submit and track calculations, cancel replacements, and resume saved submissions after reload. */
export class CalculationExecutor {
    /** Latest progress, confirmation plan and completed job for the status callback. @type {Object} */
    #executionStatus;
    /** Session-stored submission, kept until completion/cancellation is confirmed.
     * Includes the request key even when the submission response was lost. @type {Object|null}
     */
    #savedSubmission;
    /** Newest calculation waiting for planning or for an older job to stop. @type {Object|null} */
    #pendingCalculation = null;
    /** An asynchronous execution step is already running; prevent overlapping API actions. @type {boolean} */
    #isAdvancing = false;
    /** A failed step needs an explicit retry or, when no job remains, a new request. @type {boolean} */
    #retryRequired = false;
    /** Calculation matching the prepared plan. @type {Readonly<Object>|null} */
    #plannedCalculation = null;
    /** Timing of the prepared plan, carried into submission. @type {Object|null} */
    #planTiming = null;

    /** Connect execution providers without an editor or DOM dependency.
     * @param {Object} dependencies Execution dependencies.
     * @param {import("./api.js").ProcessingApiClient} dependencies.api Processing transport.
     * @param {import("./jobs.js").ProcessingJobs} dependencies.jobs Shared job observer.
     * @param {import("./calculation-session.js").CalculationSessionStorage} dependencies.storage Saves unfinished submissions across reloads in this tab.
     * @param {function(CalculationExecutionSnapshot):void} dependencies.onChange Updates the owning statistics controller with execution progress.
     * @param {function(Object|null):void} [dependencies.onActivity] Sends the working sampling area (or null) to composition for its activity indicator.
     * @param {function():string} [dependencies.requestId] Idempotency key factory.
     * @param {function():number} [dependencies.now] Monotonic timestamp in milliseconds, normally performance.now().
     */
    constructor({ api, jobs, storage, onChange, onActivity = () => {},
        requestId = () => crypto.randomUUID(),
        now = () => performance.now() }) {
        Object.assign(this, { api, jobs, storage, onChange, onActivity, requestId, now });
        this.#executionStatus = { plan: null, phase: "idle", message: "",
            completedJob: null, completedCalculation: null, completedTimings: null, currentJob: null, jobs: [], historyError: "" };
        this.#savedSubmission = storage.read();
        this.plansToRelease = new Set();
        this.destroyed = false;
        this.unsubscribe = jobs.subscribe(() => this.#receiveJobs());
    }

    /** Read calculation progress and whether work remains.
     * @return {CalculationExecutionSnapshot} Current execution snapshot.
     */
    get snapshot() {
        const isIdle = !this.#savedSubmission && !this.#pendingCalculation && !this.#isAdvancing &&
            (this.#retryRequired || this.plansToRelease.size === 0);
        // Session storage names the calculation settings "intent".
        const unfinishedCalculation = this.#savedSubmission ? Object.freeze({ calculation: this.#savedSubmission.intent,
            context: this.#savedSubmission.context, cancelRequested: this.#savedSubmission.cancelRequested }) : null;
        return Object.freeze({ ...this.#executionStatus, jobs: Object.freeze([...this.#executionStatus.jobs]),
            isIdle, admission: !isIdle ? "busy" : this.#retryRequired ? "retry" : "ready",
            unfinishedCalculation, plannedCalculation: this.#plannedCalculation, recoverable: !!this.#savedSubmission && this.#retryRequired });
    }

    /** Retry a failed step using the saved submission or pending plan-release IDs.
     * Called by Recover / retry; a lost submission response keeps its request key.
     * @return {Promise<void>} Current progress without creating a new calculation request.
     */
    async retry() { this.#retryRequired = false; await this.#advanceExecution(); }

    /** Resume observing the job or submission recovered from session storage.
     * The caller requests any cancellation before start; recovery itself does not choose a policy.
     * @return {Promise<void>} Initial job refresh and any submission/cancellation steps.
     */
    async start() {
        if (this.#savedSubmission) {
            const { jobId } = this.#savedSubmission;
            if (jobId) this.jobs.tracked.add(jobId);
            try { this.storage.write(this.#savedSubmission); }
            catch (error) { this.#executionStatus.message = error.message; this.#retryRequired = true; this.#notifyListeners(); }
        }
        await this.jobs.refresh();
        await this.#advanceExecution();
    }

    /** Drop a requested calculation that has not reached submission yet.
     * The statistics controller calls this when the area or execution settings
     * change. Stop and replacement requests also use it to discard older work.
     * Release unused plans. Submitted work continues until the caller invokes stop().
     * @return {void}
     */
    discardPendingCalculation() {
        const target = this.#pendingCalculation;
        this.#pendingCalculation = null;
        this.#queuePlanRelease();
        if (target?.plan) this.plansToRelease.add(target.plan.planId);
        if (!this.#savedSubmission) this.#executionStatus.phase = "idle";
        if (this.plansToRelease.size) void this.#advanceExecution();
    }

    /** Save the cancellation request before contacting the server.
     * Saving it in session storage lets reload continue the cancellation. If a
     * submission response was lost, repeat that submission with the same request
     * key to obtain its job ID, then cancel that job rather than creating another.
     * A storage failure is reported; the in-memory cancellation still proceeds.
     * @return {void}
     */
    #requestCancellation() {
        if (!this.#savedSubmission) return;
        this.#savedSubmission.cancelRequested = true;
        try { this.storage.write(this.#savedSubmission); }
        catch (error) { this.#executionStatus.message = error.message; }
        void this.#advanceExecution();
    }

    /** Remove the prepared plan and queue its server release.
     * Keep its ID in plansToRelease so a failed DELETE can be retried. This method
     * only queues cleanup; releasePlans() performs the request and removes the ID
     * after success. Called when that calculation changes or the executor closes.
     * @return {void}
     */
    #queuePlanRelease() {
        const plan = this.#executionStatus.plan;
        this.#executionStatus.plan = null;
        this.#plannedCalculation = null;
        this.#planTiming = null;
        if (plan) this.plansToRelease.add(plan.planId);
    }

    /** Ask Processing to discard every queued unused plan before planning again.
     * Keep a plan ID until its DELETE succeeds so failure cannot silently lose cleanup.
     * @return {Promise<void>} Completion after every queued release is acknowledged.
     * @throws {Error} If Processing cannot acknowledge a plan release.
     */
    async #releasePlans() {
        while (this.plansToRelease.size) {
            const id = this.plansToRelease.values().next().value;
            await this.api.discardPlan(id);
            this.plansToRelease.delete(id);
        }
    }

    /** Prepare a calculation without submitting a job; replace older pending work.
     * Copy validated settings and reuse only a matching, unexpired plan. The caller
     * decides whether to submit the returned plan or wait for user confirmation.
     * A different calculation waits for cancellation of any submitted predecessor.
     * @param {Object} calculation Raster, area, formulas and optional targetChunkPixels.
     * @return {void} Progress and the prepared plan arrive through onChange.
     * @throws {TypeError} If calculation settings violate the input contract.
     */
    prepare(calculation) {
        if (this.destroyed) return;
        const snapshot = calculationIntent(calculation);
        if (this.#retryRequired && this.#savedSubmission) { this.discardPendingCalculation(); this.#notifyListeners(); return; }
        if ((this.#pendingCalculation && identity(this.#pendingCalculation.intent) === identity(snapshot)) ||
            (this.#savedSubmission && !this.#savedSubmission.cancelRequested && identity(this.#savedSubmission.intent) === identity(snapshot))) return;
        const plan = this.#executionStatus.plan && identity(snapshot) === identity(this.#plannedCalculation) ? this.#executionStatus.plan : null;
        if (plan) this.#executionStatus.plan = null;
        this.discardPendingCalculation();
        this.#retryRequired = false;
        this.#pendingCalculation = { intent: snapshot, plan };
        this.#requestCancellation();
        this.#executionStatus.phase = "waiting";
        this.#executionStatus.message = "Preparing calculation…";
        this.#notifyListeners();
        void this.#advanceExecution();
    }

    /** Submit the currently prepared plan on the caller's explicit instruction.
     * Stale plan IDs do nothing. Expired plans are prepared again and returned to
     * the caller for a new decision; they are never submitted without that decision.
     * Persist the request key before transport so a lost response cannot duplicate work.
     * @param {string} planId ID from the current plan snapshot.
     * @param {Readonly<Object>|null} [context=null] Caller-owned recovery metadata; execution never interprets it.
     * @return {void} Submission progress or a storage error arrives through onChange.
     */
    submit(planId, context = null) {
        const plan = this.#executionStatus.plan;
        if (this.destroyed || !plan || !this.snapshot.isIdle || this.#retryRequired || plan?.planId !== planId) return;
        if (Date.parse(plan.expiresAt) <= Date.now()) { this.prepare(this.#plannedCalculation); return; }
        const record = { intent: this.#plannedCalculation, context: context && Object.freeze({ ...context }), cancelRequested: false,
            pending: { planId, requestId: this.requestId() }, jobId: null };
        try { this.storage.write(record); }
        catch (error) {
            this.#retryRequired = true;
            this.#executionStatus.phase = "error";
            this.#executionStatus.message = error.message;
            this.#queuePlanRelease();
            this.#notifyListeners();
            return;
        }
        this.#savedSubmission = record;
        this.trace = this.#planTiming;
        this.#executionStatus.plan = null;
        this.#plannedCalculation = null;
        this.#planTiming = null;
        void this.#advanceExecution();
    }

    /** Cancel pending and submitted work; preserve cancellation across reloads. @return {void} */
    stop() {
        this.discardPendingCalculation();
        this.#requestCancellation();
        if (!this.#savedSubmission) this.#executionStatus.message = "Calculation cancelled.";
        this.#notifyListeners();
    }

    /**
     * Advance the calculation through planning, submission, cancellation and completion.
     * These are the fixed job lifecycle operations, not user-defined processing steps.
     * Session storage preserves unfinished submission details across reloads.
     * Reusing a request key after a lost response prevents duplicate jobs. Waiting
     * until cancellation finishes prevents the replacement from overlapping the
     * old job. Return while a job runs; the shared job observer calls back later.
     * @return {Promise<void>} Completion of the API operations that can proceed now.
     */
    async #advanceExecution() {
        if (this.#isAdvancing || this.destroyed || this.#retryRequired) return;
        this.#isAdvancing = true;
        try {
            if (this.plansToRelease.size) {
                this.#executionStatus.phase = "releasing";
                this.#executionStatus.message = "Releasing the previous calculation check…";
                this.#notifyListeners();
                await this.#releasePlans();
                if (!this.#savedSubmission) { this.#executionStatus.phase = "idle"; this.#executionStatus.message = ""; }
            }
            if (this.#savedSubmission?.pending) {
                this.#executionStatus.phase = "submitting";
                this.#executionStatus.message = "Confirming calculation submission…";
                this.#notifyListeners();
                let job;
                try {
                    if (this.trace) this.trace.submissionStartedAtMs = this.now();
                    job = await this.api.submitCalculation(this.#savedSubmission.pending);
                    if (this.trace) this.trace.submissionFinishedAtMs = this.now();
                }
                catch (error) {
                    this.trace = null; // A lost response prevents measuring the complete submission interval.
                    if (error instanceof ProcessingRequestError && error.status >= 400 && error.status < 500 && error.status !== 408) {
                        this.storage.clear(); this.#savedSubmission = null;
                    }
                    throw error;
                }
                this.#savedSubmission.jobId = job.jobId;
                this.#savedSubmission.releasePlanId = this.#savedSubmission.pending.planId;
                this.#savedSubmission.pending = null;
                this.storage.write(this.#savedSubmission);
                this.jobs.tracked.add(job.jobId);
                this.jobs.accept(job);
            }
            if (this.#savedSubmission?.releasePlanId) {
                await this.api.discardPlan(this.#savedSubmission.releasePlanId);
                this.#savedSubmission.releasePlanId = null;
                this.storage.write(this.#savedSubmission);
            }
            if (this.#savedSubmission?.jobId) {
                const job = this.jobs.jobs.find(item => item.jobId === this.#savedSubmission.jobId);
                if (!job) { await this.jobs.refresh(); return; }
                this.#executionStatus.currentJob = job;
                if (ACTIVE_JOB_STATES.has(job.status)) {
                    this.#executionStatus.phase = this.#savedSubmission.cancelRequested ? "cancelling" : job.status;
                    this.#executionStatus.message = this.#savedSubmission.cancelRequested ? "Cancelling calculation…" : "";
                    if (this.#savedSubmission.cancelRequested && job.status !== "cancelling") await this.jobs.action(job.jobId, "cancel");
                    return;
                }
                if (job.status === "ready" && !this.#savedSubmission.cancelRequested) {
                    this.#executionStatus.completedJob = job; this.#executionStatus.completedCalculation = this.#savedSubmission.intent;
                    this.#executionStatus.completedTimings = this.trace ?? null;
                    this.#executionStatus.message = "Calculation complete.";
                } else if (["failed", "interrupted"].includes(job.status) && !this.#savedSubmission.cancelRequested) {
                    this.#executionStatus.message = job.error?.detail ?? "Calculation interrupted. Click Calculate to try again.";
                } else if (this.#savedSubmission.cancelRequested || job.status === "cancelled") {
                    this.#executionStatus.message = this.#pendingCalculation ? "Waiting for the latest sampling box…" : "Calculation cancelled.";
                }
                this.jobs.tracked.delete(job.jobId);
                this.storage.clear(); this.#savedSubmission = null; this.#executionStatus.currentJob = null;
                this.trace = null;
                this.#executionStatus.phase = "idle";
            }
            if (!this.#pendingCalculation) return;
            const target = this.#pendingCalculation;
            this.#executionStatus.phase = "planning";
            this.#executionStatus.message = "Checking calculation size…";
            this.#notifyListeners();
            if (target.plan && Date.parse(target.plan.expiresAt) <= Date.now()) {
                this.plansToRelease.add(target.plan.planId);
                target.plan = null;
                await this.#releasePlans();
            }
            if (target !== this.#pendingCalculation || this.destroyed) return;
            let plan;
            // Aborting fetch cannot acknowledge native cleanup, and can lose the
            // ID of a plan already committed behind a proxy. Keep this bounded
            // request connected, then release a superseded result before reuse.
            // Monotonic browser timestamps in milliseconds, not dates or durations.
            const planningStartedAtMs = this.now();
            const planReused = !!target.plan;
            try { plan = target.plan ?? await this.api.planCalculation(target.intent); }
            catch (error) { if (target !== this.#pendingCalculation || error.name === "AbortError") return; throw error; }
            const planningFinishedAtMs = this.now();
            if (target !== this.#pendingCalculation || this.destroyed) {
                this.plansToRelease.add(plan.planId);
                await this.#releasePlans();
                return;
            }
            target.plan = plan;
            this.#executionStatus.plan = plan;
            this.#plannedCalculation = target.intent;
            this.#planTiming = { planningStartedAtMs, planningFinishedAtMs, planReused, serverPlan: plan.timing ?? null };
            this.#pendingCalculation = null;
            this.#executionStatus.phase = "idle";
            this.#executionStatus.message = "Calculation prepared.";
        } catch (error) {
            this.#retryRequired = true;
            if (this.#pendingCalculation?.plan) this.plansToRelease.add(this.#pendingCalculation.plan.planId);
            this.#pendingCalculation = null;
            this.#executionStatus.phase = "error";
            this.#executionStatus.message = `${error.message}${this.#savedSubmission ? " Recover / retry to confirm or cancel the same job safely." : " Click Calculate or select a new sampling box to retry."}`;
        } finally {
            if (this.destroyed) await this.#releasePlans().catch(() => {});
            this.#isAdvancing = false;
            this.#notifyListeners();
            // Finish the old plan request and its cleanup before processing a replacement.
            if (!this.#retryRequired && !this.destroyed && !this.#savedSubmission &&
                (this.#pendingCalculation || this.plansToRelease.size)) {
                queueMicrotask(() => void this.#advanceExecution());
            }
        }
        if (this.#savedSubmission?.pending && !this.#retryRequired) await this.#advanceExecution();
        else if (this.#pendingCalculation && !this.#retryRequired) await this.#advanceExecution();
    }

    /** Consume shared progress without replacing current result with an older job. @return {void} */
    #receiveJobs() {
        this.#executionStatus.jobs = this.jobs.jobs.filter(job => job.operation === "raster.aggregate.v1");
        this.#executionStatus.historyError = this.jobs.error;
        if (this.#executionStatus.completedJob) {
            this.#executionStatus.completedJob = this.jobs.jobs.find(job => job.jobId === this.#executionStatus.completedJob.jobId) ?? this.#executionStatus.completedJob;
        }
        if (this.#savedSubmission?.jobId) {
            this.#executionStatus.currentJob = this.jobs.jobs.find(job => job.jobId === this.#savedSubmission.jobId) ?? this.#executionStatus.currentJob;
            if (!this.#isAdvancing) void this.#advanceExecution();
        }
        this.#notifyListeners();
    }

    /** Cancel or delete a job selected in History & exports.
     * Cancelling this executor's current job also clears its pending replacement.
     * Other actions go through the shared job observer, which refreshes history.
     * Request failures are reported through the execution status callback.
     * @param {string} id Processing job ID selected by the user.
     * @param {"cancel"|"delete"} action Cancel running work or delete its retained result.
     * @return {Promise<void>} Completion of the requested action or error reporting.
     */
    async jobAction(id, action) {
        if (id === this.#savedSubmission?.jobId && action === "cancel") { this.stop(); return; }
        try { await this.jobs.action(id, action); }
        catch (error) { this.#executionStatus.message = error.message; this.#notifyListeners(); }
    }

    /** Send progress to the statistics controller and the working area to composition.
     * onChange receives status, outstanding work and the last completed job together.
     * onActivity receives the submitted calculation's area while work is active, or
     * null after cancellation/error/completion. Composition uses it for the map's
     * working indicator; this method neither draws the map nor sends an HTTP request.
     * @return {void}
     */
    #notifyListeners() {
        if (this.destroyed) return;
        this.onChange(this.snapshot);
        const active = this.#savedSubmission && !this.#savedSubmission.cancelRequested && !this.#retryRequired;
        this.onActivity(active ? this.#savedSubmission.intent.area : null);
    }

    /** Stop local observation and release unused plans when the controller is destroyed.
     * Submitted jobs and their session-storage records remain available after reload.
     * @return {void}
     */
    destroy() {
        this.destroyed = true;
        this.#queuePlanRelease();
        if (this.#pendingCalculation?.plan) this.plansToRelease.add(this.#pendingCalculation.plan.planId);
        this.#pendingCalculation = null;
        this.unsubscribe(); this.onActivity(null);
        if (!this.#isAdvancing) void this.#releasePlans().catch(() => {});
    }
}
