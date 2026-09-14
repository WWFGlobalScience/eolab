/** One durable execution lane for validated Processing calculation intents. */
import { ACTIVE_JOB_STATES } from "./jobs.js";
import { ProcessingRequestError } from "./api.js";
import { calculationIntent } from "./calculation-session.js";

/** Stable comparison of public intents. @param {Object|null} value Intent. @return {string} Identity. */
function identity(value) { return JSON.stringify(value); }

/**
 * Execution status delivered to the statistics owner. Snapshots never expose the
 * mutable submission record, pending target, or scheduler flags. Job and plan
 * payloads are read-only API values; the snapshot and recovery projection are frozen.
 * @typedef {Object} CalculationExecutionSnapshot
 * @property {boolean} settled No accepted or pending work remains on this lane.
 * @property {"busy"|"manual"|"ready"} admission Busy includes cancellation/recovery;
 * manual requires an explicit new request after failure; ready permits automatic work.
 * @property {{intent:Readonly<Object>,automatic:boolean,cancelRequested:boolean}|null} recovery Persisted work for restoring cards.
 * @property {boolean} recoverable Explicit retry can resume uncertain accepted work.
 * @property {string} phase Execution phase, independent of editor validation.
 * @property {string} message Execution feedback.
 * @property {Object|null} plan Review requiring explicit authorization.
 * @property {boolean} manualRequired Automatic policy requires confirmation.
 * @property {Object|null} current Current authoritative job snapshot.
 * @property {Object|null} result Last completed result, retained during replacement.
 * @property {Readonly<Object>|null} resultIntent Intent that produced the result.
 * @property {Object|null} resultTiming Browser stage timestamps for that result.
 * @property {ReadonlyArray<Object>} jobs Calculation history from the shared observer.
 * @property {string} historyError Shared history retrieval error.
 */

/** Own durable submission, cancellation, plan release and recovery for one lane. */
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
    /** Calculation matching the plan held for the user's Calculate confirmation. @type {Readonly<Object>|null} */
    #confirmationCalculation = null;

    /** Connect execution providers without an editor or DOM dependency.
     * @param {Object} dependencies Execution dependencies.
     * @param {import("./api.js").ProcessingApiClient} dependencies.api Processing transport.
     * @param {import("./jobs.js").ProcessingJobs} dependencies.jobs Shared job observer.
     * @param {import("./calculation-session.js").CalculationSessionStorage} dependencies.storage Durable per-tab recovery.
     * @param {function(CalculationExecutionSnapshot):void} dependencies.onChange Status callback.
     * @param {function(Object|null):void} [dependencies.onActivity] Area-associated activity.
     * @param {function():string} [dependencies.requestId] Idempotency key factory.
     * @param {function(Object,Readonly<Object>):boolean} [dependencies.canAutoSubmit] Caller-owned automatic admission policy.
     * @param {function():number} [dependencies.now] Monotonic browser clock.
     */
    constructor({ api, jobs, storage, onChange, onActivity = () => {},
        requestId = () => crypto.randomUUID(), canAutoSubmit = () => true,
        now = () => performance.now() }) {
        Object.assign(this, { api, jobs, storage, onChange, onActivity, requestId, canAutoSubmit, now });
        this.#executionStatus = { plan: null, phase: "idle", message: "", manualRequired: false,
            result: null, resultIntent: null, resultTiming: null, current: null, jobs: [], historyError: "" };
        this.#savedSubmission = storage.read();
        this.plansToRelease = new Set();
        this.destroyed = false;
        this.unsubscribe = jobs.subscribe(() => this.#receiveJobs());
    }

    /** Read a coherent status without exposing mutable scheduling state.
     * @return {CalculationExecutionSnapshot} Current execution snapshot.
     */
    get snapshot() {
        const settled = !this.#savedSubmission && !this.#pendingCalculation && !this.#isAdvancing &&
            (this.#retryRequired || this.plansToRelease.size === 0);
        const recovery = this.#savedSubmission ? Object.freeze({ intent: this.#savedSubmission.intent,
            automatic: this.#savedSubmission.automatic, cancelRequested: this.#savedSubmission.cancelRequested }) : null;
        return Object.freeze({ ...this.#executionStatus, jobs: Object.freeze([...this.#executionStatus.jobs]),
            settled, admission: !settled ? "busy" : this.#retryRequired ? "manual" : "ready",
            recovery, recoverable: !!this.#savedSubmission && this.#retryRequired });
    }

    /** Resume the same durable request or retry acknowledged plan cleanup.
     * @return {Promise<void>} Progress on the existing lane; never a new job intent.
     */
    async retry() { this.#retryRequired = false; await this.#advance(); }

    /** Recover accepted work; reload always pauses automatic sampling. @return {Promise<void>} Recovery. */
    async start() {
        if (this.#savedSubmission) {
            const { jobId } = this.#savedSubmission;
            if (jobId) this.jobs.tracked.add(jobId);
            try { this.storage.write(this.#savedSubmission); }
            catch (error) { this.#executionStatus.message = error.message; this.#retryRequired = true; this.#publish(); }
        }
        await this.jobs.refresh();
        await this.#advance();
    }

    /** Invalidate unaccepted intent and cancel obsolete automatic work. @return {void} */
    invalidate() {
        const target = this.#pendingCalculation;
        this.#pendingCalculation = null;
        this.#discardReview();
        if (target?.plan) this.plansToRelease.add(target.plan.planId);
        if (!this.#savedSubmission) this.#executionStatus.phase = "idle";
        if (this.#savedSubmission?.automatic) this.#requestCancellation();
        if (this.plansToRelease.size) void this.#advance();
    }

    /** Mark durable cancellation before recovering uncertain submissions. @return {void} */
    #requestCancellation() {
        if (!this.#savedSubmission) return;
        this.#savedSubmission.cancelRequested = true;
        try { this.storage.write(this.#savedSubmission); }
        catch (error) { this.#executionStatus.message = error.message; }
        void this.#advance();
    }

    /** Retain obsolete plan identities until the server acknowledges release. @return {void} */
    #discardReview() {
        const plan = this.#executionStatus.plan;
        this.#executionStatus.plan = null;
        this.#confirmationCalculation = null;
        if (plan) this.plansToRelease.add(plan.planId);
    }

    /** Drain unused plans on the executor's planning lane.
     * A failed release retains its identity for the next explicit attempt.
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

    /** Execute a validated card batch; preserve matching confirmation and idempotency.
     * Formula syntax belongs to the caller's validation workflow. This boundary
     * snapshots catalog identity, area and calculation structure before any work.
     * @param {Object} intent Complete public calculation intent.
     * @param {boolean} [automatic=false] Whether caller policy must approve submission.
     * @return {void}
     * @throws {TypeError} If the intent violates the calculation contract.
     */
    executeIntent(intent, automatic = false) {
        if (this.destroyed) return;
        const snapshot = calculationIntent(intent);
        if (this.#retryRequired && this.#savedSubmission) { this.invalidate(); this.#publish(); return; }
        // Repeated manual actions cannot create two jobs for the same intent.
        if (!automatic && ((this.#pendingCalculation && identity(this.#pendingCalculation.intent) === identity(snapshot)) ||
            (this.#savedSubmission && !this.#savedSubmission.cancelRequested && identity(this.#savedSubmission.intent) === identity(snapshot)))) return;
        const plan = this.#executionStatus.plan && identity(snapshot) === identity(this.#confirmationCalculation) ? this.#executionStatus.plan : null;
        if (plan) this.#executionStatus.plan = null;
        this.invalidate();
        this.#retryRequired = false;
        this.#executionStatus.manualRequired = false;
        this.#pendingCalculation = { intent: snapshot, plan, automatic };
        this.#requestCancellation();
        this.#executionStatus.phase = "waiting";
        this.#executionStatus.message = automatic
            ? this.#isAdvancing && !this.#savedSubmission
                ? "Waiting for the previous calculation check to finish…"
                : "Waiting for the latest sampling box…"
            : "Preparing calculation…";
        this.#publish();
        void this.#advance();
    }

    /** Cancel this calculation; a later map click is a new explicit request. @return {void} */
    stop() {
        this.invalidate();
        this.#requestCancellation();
        if (!this.#savedSubmission) this.#executionStatus.message = "Calculation cancelled.";
        this.#publish();
    }

    /**
     * Drain one durable workflow before admitting the newest requested area.
     * Unknown submissions retain their key; cancelling jobs retain their slot.
     * @return {Promise<void>} Current progress, never an unbounded polling loop.
     */
    async #advance() {
        if (this.#isAdvancing || this.destroyed || this.#retryRequired) return;
        this.#isAdvancing = true;
        try {
            if (this.plansToRelease.size) {
                this.#executionStatus.phase = "releasing";
                this.#executionStatus.message = "Releasing the previous calculation check…";
                this.#publish();
                await this.#releasePlans();
                if (!this.#savedSubmission) { this.#executionStatus.phase = "idle"; this.#executionStatus.message = ""; }
            }
            if (this.#savedSubmission?.pending) {
                this.#executionStatus.phase = "submitting";
                this.#executionStatus.message = "Confirming calculation submission…";
                this.#publish();
                let job;
                try {
                    if (this.trace) this.trace.submissionStarted = this.now();
                    job = await this.api.submitCalculation(this.#savedSubmission.pending);
                    if (this.trace) this.trace.submissionFinished = this.now();
                }
                catch (error) {
                    this.trace = null; // An uncertain/retried submission has no complete stage trace.
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
                this.#executionStatus.current = job;
                if (ACTIVE_JOB_STATES.has(job.status)) {
                    this.#executionStatus.phase = this.#savedSubmission.cancelRequested ? "cancelling" : job.status;
                    this.#executionStatus.message = this.#savedSubmission.cancelRequested ? "Cancelling calculation…" : "";
                    if (this.#savedSubmission.cancelRequested && job.status !== "cancelling") await this.jobs.action(job.jobId, "cancel");
                    return;
                }
                if (job.status === "ready" && !this.#savedSubmission.cancelRequested) {
                    this.#executionStatus.result = job; this.#executionStatus.resultIntent = this.#savedSubmission.intent;
                    this.#executionStatus.resultTiming = this.trace ?? null;
                    this.#executionStatus.message = "Calculation complete.";
                } else if (["failed", "interrupted"].includes(job.status) && !this.#savedSubmission.cancelRequested) {
                    this.#executionStatus.message = job.error?.detail ?? "Calculation interrupted. Click Calculate to try again.";
                } else if (this.#savedSubmission.cancelRequested || job.status === "cancelled") {
                    this.#executionStatus.message = this.#pendingCalculation ? "Waiting for the latest sampling box…" : "Calculation cancelled.";
                }
                this.jobs.tracked.delete(job.jobId);
                this.storage.clear(); this.#savedSubmission = null; this.#executionStatus.current = null;
                this.trace = null;
                this.#executionStatus.phase = "idle";
            }
            if (!this.#pendingCalculation) return;
            const target = this.#pendingCalculation;
            this.#executionStatus.phase = "planning";
            this.#executionStatus.message = "Checking calculation size…";
            this.#publish();
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
            const planningStarted = this.now();
            const planReused = !!target.plan;
            try { plan = target.plan ?? await this.api.planCalculation(target.intent); }
            catch (error) { if (target !== this.#pendingCalculation || error.name === "AbortError") return; throw error; }
            const planningFinished = this.now();
            if (target !== this.#pendingCalculation || this.destroyed) {
                this.plansToRelease.add(plan.planId);
                await this.#releasePlans();
                return;
            }
            target.plan = plan;
            if (target.automatic && !this.canAutoSubmit(plan, target.intent)) {
                this.#executionStatus.plan = plan;
                this.#confirmationCalculation = target.intent;
                this.#executionStatus.manualRequired = true;
                this.#pendingCalculation = null;
                this.#executionStatus.phase = "idle";
                this.#executionStatus.message = "Large or explicit area · Calculate to update.";
                return;
            }
            const record = { intent: target.intent, automatic: target.automatic, cancelRequested: false,
                pending: { planId: plan.planId, requestId: this.requestId() }, jobId: null };
            this.storage.write(record);
            this.#savedSubmission = record;
            this.trace = { planningStarted, planningFinished, planReused, serverPlan: plan.timing ?? null };
            this.#pendingCalculation = null;
        } catch (error) {
            this.#retryRequired = true;
            if (this.#pendingCalculation?.plan) this.plansToRelease.add(this.#pendingCalculation.plan.planId);
            this.#pendingCalculation = null;
            this.#executionStatus.phase = "error";
            this.#executionStatus.message = `${error.message}${this.#savedSubmission ? " Recover / retry to confirm or cancel the same job safely." : " Click Calculate or select a new sampling box to retry."}`;
        } finally {
            if (this.destroyed) await this.#releasePlans().catch(() => {});
            this.#isAdvancing = false;
            this.#publish();
            // Newest intent waits for both old metadata and acknowledged cleanup.
            if (!this.#retryRequired && !this.destroyed && !this.#savedSubmission &&
                (this.#pendingCalculation || this.plansToRelease.size)) {
                queueMicrotask(() => void this.#advance());
            }
        }
        if (this.#savedSubmission?.pending && !this.#retryRequired) await this.#advance();
        else if (this.#pendingCalculation && !this.#retryRequired) await this.#advance();
    }

    /** Consume shared progress without replacing current result with an older job. @return {void} */
    #receiveJobs() {
        this.#executionStatus.jobs = this.jobs.jobs.filter(job => job.operation === "raster.aggregate.v1");
        this.#executionStatus.historyError = this.jobs.error;
        if (this.#executionStatus.result) {
            this.#executionStatus.result = this.jobs.jobs.find(job => job.jobId === this.#executionStatus.result.jobId) ?? this.#executionStatus.result;
        }
        if (this.#savedSubmission?.jobId) {
            this.#executionStatus.current = this.jobs.jobs.find(job => job.jobId === this.#savedSubmission.jobId) ?? this.#executionStatus.current;
            if (!this.#isAdvancing) void this.#advance();
        }
        this.#publish();
    }

    /** Apply an explicit history action. @param {string} id Job ID. @param {string} action Intent. @return {Promise<void>} Action. */
    async jobAction(id, action) {
        if (id === this.#savedSubmission?.jobId && action === "cancel") { this.stop(); return; }
        try { await this.jobs.action(id, action); }
        catch (error) { this.#executionStatus.message = error.message; this.#publish(); }
    }

    /** Notify the owner with coherent status and area-associated activity.
     * @return {void}
     */
    #publish() {
        if (this.destroyed) return;
        this.onChange(this.snapshot);
        const active = this.#savedSubmission && !this.#savedSubmission.cancelRequested && !this.#retryRequired;
        this.onActivity(active ? this.#savedSubmission.intent.area : null);
    }

    /** Detach browser work, retaining server/recovery records. @return {void} */
    destroy() {
        this.destroyed = true;
        this.#discardReview();
        if (this.#pendingCalculation?.plan) this.plansToRelease.add(this.#pendingCalculation.plan.planId);
        this.#pendingCalculation = null;
        this.unsubscribe(); this.onActivity(null);
        if (!this.#isAdvancing) void this.#releasePlans().catch(() => {});
    }
}
