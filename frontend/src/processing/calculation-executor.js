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
    #state;
    #record;
    #desired = null;
    #advanceRunning = false;
    #blocked = false;
    #reviewIntent = null;

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
        this.#state = { plan: null, phase: "idle", message: "", manualRequired: false,
            result: null, resultIntent: null, resultTiming: null, current: null, jobs: [], historyError: "" };
        this.#record = storage.read();
        this.plansToRelease = new Set();
        this.destroyed = false;
        this.unsubscribe = jobs.subscribe(() => this.#receiveJobs());
    }

    /** Read a coherent status without exposing mutable scheduling state.
     * @return {CalculationExecutionSnapshot} Current execution snapshot.
     */
    get snapshot() {
        const settled = !this.#record && !this.#desired && !this.#advanceRunning &&
            (this.#blocked || this.plansToRelease.size === 0);
        const recovery = this.#record ? Object.freeze({ intent: this.#record.intent,
            automatic: this.#record.automatic, cancelRequested: this.#record.cancelRequested }) : null;
        return Object.freeze({ ...this.#state, jobs: Object.freeze([...this.#state.jobs]),
            settled, admission: !settled ? "busy" : this.#blocked ? "manual" : "ready",
            recovery, recoverable: !!this.#record && this.#blocked });
    }

    /** Resume the same durable request or retry acknowledged plan cleanup.
     * @return {Promise<void>} Progress on the existing lane; never a new job intent.
     */
    async retry() { this.#blocked = false; await this.#advance(); }

    /** Recover accepted work; reload always pauses automatic sampling. @return {Promise<void>} Recovery. */
    async start() {
        if (this.#record) {
            const { jobId } = this.#record;
            if (jobId) this.jobs.tracked.add(jobId);
            try { this.storage.write(this.#record); }
            catch (error) { this.#state.message = error.message; this.#blocked = true; this.#publish(); }
        }
        await this.jobs.refresh();
        await this.#advance();
    }

    /** Invalidate unaccepted intent and cancel obsolete automatic work. @return {void} */
    invalidate() {
        const target = this.#desired;
        this.#desired = null;
        this.#discardReview();
        if (target?.plan) this.plansToRelease.add(target.plan.planId);
        if (!this.#record) this.#state.phase = "idle";
        if (this.#record?.automatic) this.#requestCancellation();
        if (this.plansToRelease.size) void this.#advance();
    }

    /** Mark durable cancellation before recovering uncertain submissions. @return {void} */
    #requestCancellation() {
        if (!this.#record) return;
        this.#record.cancelRequested = true;
        try { this.storage.write(this.#record); }
        catch (error) { this.#state.message = error.message; }
        void this.#advance();
    }

    /** Retain obsolete plan identities until the server acknowledges release. @return {void} */
    #discardReview() {
        const plan = this.#state.plan;
        this.#state.plan = null;
        this.#reviewIntent = null;
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
        if (this.#blocked && this.#record) { this.invalidate(); this.#publish(); return; }
        // Repeated manual actions cannot create two jobs for the same intent.
        if (!automatic && ((this.#desired && identity(this.#desired.intent) === identity(snapshot)) ||
            (this.#record && !this.#record.cancelRequested && identity(this.#record.intent) === identity(snapshot)))) return;
        const plan = this.#state.plan && identity(snapshot) === identity(this.#reviewIntent) ? this.#state.plan : null;
        if (plan) this.#state.plan = null;
        this.invalidate();
        this.#blocked = false;
        this.#state.manualRequired = false;
        this.#desired = { intent: snapshot, plan, automatic };
        this.#requestCancellation();
        this.#state.phase = "waiting";
        this.#state.message = automatic
            ? this.#advanceRunning && !this.#record
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
        if (!this.#record) this.#state.message = "Calculation cancelled.";
        this.#publish();
    }

    /**
     * Drain one durable workflow before admitting the newest requested area.
     * Unknown submissions retain their key; cancelling jobs retain their slot.
     * @return {Promise<void>} Current progress, never an unbounded polling loop.
     */
    async #advance() {
        if (this.#advanceRunning || this.destroyed || this.#blocked) return;
        this.#advanceRunning = true;
        try {
            if (this.plansToRelease.size) {
                this.#state.phase = "releasing";
                this.#state.message = "Releasing the previous calculation check…";
                this.#publish();
                await this.#releasePlans();
                if (!this.#record) { this.#state.phase = "idle"; this.#state.message = ""; }
            }
            if (this.#record?.pending) {
                this.#state.phase = "submitting";
                this.#state.message = "Confirming calculation submission…";
                this.#publish();
                let job;
                try {
                    if (this.trace) this.trace.submissionStarted = this.now();
                    job = await this.api.submitCalculation(this.#record.pending);
                    if (this.trace) this.trace.submissionFinished = this.now();
                }
                catch (error) {
                    this.trace = null; // An uncertain/retried submission has no complete stage trace.
                    if (error instanceof ProcessingRequestError && error.status >= 400 && error.status < 500 && error.status !== 408) {
                        this.storage.clear(); this.#record = null;
                    }
                    throw error;
                }
                this.#record.jobId = job.jobId;
                this.#record.releasePlanId = this.#record.pending.planId;
                this.#record.pending = null;
                this.storage.write(this.#record);
                this.jobs.tracked.add(job.jobId);
                this.jobs.accept(job);
            }
            if (this.#record?.releasePlanId) {
                await this.api.discardPlan(this.#record.releasePlanId);
                this.#record.releasePlanId = null;
                this.storage.write(this.#record);
            }
            if (this.#record?.jobId) {
                const job = this.jobs.jobs.find(item => item.jobId === this.#record.jobId);
                if (!job) { await this.jobs.refresh(); return; }
                this.#state.current = job;
                if (ACTIVE_JOB_STATES.has(job.status)) {
                    this.#state.phase = this.#record.cancelRequested ? "cancelling" : job.status;
                    this.#state.message = this.#record.cancelRequested ? "Cancelling calculation…" : "";
                    if (this.#record.cancelRequested && job.status !== "cancelling") await this.jobs.action(job.jobId, "cancel");
                    return;
                }
                if (job.status === "ready" && !this.#record.cancelRequested) {
                    this.#state.result = job; this.#state.resultIntent = this.#record.intent;
                    this.#state.resultTiming = this.trace ?? null;
                    this.#state.message = "Calculation complete.";
                } else if (["failed", "interrupted"].includes(job.status) && !this.#record.cancelRequested) {
                    this.#state.message = job.error?.detail ?? "Calculation interrupted. Click Calculate to try again.";
                } else if (this.#record.cancelRequested || job.status === "cancelled") {
                    this.#state.message = this.#desired ? "Waiting for the latest sampling box…" : "Calculation cancelled.";
                }
                this.jobs.tracked.delete(job.jobId);
                this.storage.clear(); this.#record = null; this.#state.current = null;
                this.trace = null;
                this.#state.phase = "idle";
            }
            if (!this.#desired) return;
            const target = this.#desired;
            this.#state.phase = "planning";
            this.#state.message = "Checking calculation size…";
            this.#publish();
            if (target.plan && Date.parse(target.plan.expiresAt) <= Date.now()) {
                this.plansToRelease.add(target.plan.planId);
                target.plan = null;
                await this.#releasePlans();
            }
            if (target !== this.#desired || this.destroyed) return;
            let plan;
            // Aborting fetch cannot acknowledge native cleanup, and can lose the
            // ID of a plan already committed behind a proxy. Keep this bounded
            // request connected, then release a superseded result before reuse.
            const planningStarted = this.now();
            const planReused = !!target.plan;
            try { plan = target.plan ?? await this.api.planCalculation(target.intent); }
            catch (error) { if (target !== this.#desired || error.name === "AbortError") return; throw error; }
            const planningFinished = this.now();
            if (target !== this.#desired || this.destroyed) {
                this.plansToRelease.add(plan.planId);
                await this.#releasePlans();
                return;
            }
            target.plan = plan;
            if (target.automatic && !this.canAutoSubmit(plan, target.intent)) {
                this.#state.plan = plan;
                this.#reviewIntent = target.intent;
                this.#state.manualRequired = true;
                this.#desired = null;
                this.#state.phase = "idle";
                this.#state.message = "Large or explicit area · Calculate to update.";
                return;
            }
            const record = { intent: target.intent, automatic: target.automatic, cancelRequested: false,
                pending: { planId: plan.planId, requestId: this.requestId() }, jobId: null };
            this.storage.write(record);
            this.#record = record;
            this.trace = { planningStarted, planningFinished, planReused, serverPlan: plan.timing ?? null };
            this.#desired = null;
        } catch (error) {
            this.#blocked = true;
            if (this.#desired?.plan) this.plansToRelease.add(this.#desired.plan.planId);
            this.#desired = null;
            this.#state.phase = "error";
            this.#state.message = `${error.message}${this.#record ? " Recover / retry to confirm or cancel the same job safely." : " Click Calculate or select a new sampling box to retry."}`;
        } finally {
            if (this.destroyed) await this.#releasePlans().catch(() => {});
            this.#advanceRunning = false;
            this.#publish();
            // Newest intent waits for both old metadata and acknowledged cleanup.
            if (!this.#blocked && !this.destroyed && !this.#record &&
                (this.#desired || this.plansToRelease.size)) {
                queueMicrotask(() => void this.#advance());
            }
        }
        if (this.#record?.pending && !this.#blocked) await this.#advance();
        else if (this.#desired && !this.#blocked) await this.#advance();
    }

    /** Consume shared progress without replacing current result with an older job. @return {void} */
    #receiveJobs() {
        this.#state.jobs = this.jobs.jobs.filter(job => job.operation === "raster.aggregate.v1");
        this.#state.historyError = this.jobs.error;
        if (this.#state.result) {
            this.#state.result = this.jobs.jobs.find(job => job.jobId === this.#state.result.jobId) ?? this.#state.result;
        }
        if (this.#record?.jobId) {
            this.#state.current = this.jobs.jobs.find(job => job.jobId === this.#record.jobId) ?? this.#state.current;
            if (!this.#advanceRunning) void this.#advance();
        }
        this.#publish();
    }

    /** Apply an explicit history action. @param {string} id Job ID. @param {string} action Intent. @return {Promise<void>} Action. */
    async jobAction(id, action) {
        if (id === this.#record?.jobId && action === "cancel") { this.stop(); return; }
        try { await this.jobs.action(id, action); }
        catch (error) { this.#state.message = error.message; this.#publish(); }
    }

    /** Notify the owner with coherent status and area-associated activity.
     * @return {void}
     */
    #publish() {
        if (this.destroyed) return;
        this.onChange(this.snapshot);
        const active = this.#record && !this.#record.cancelRequested && !this.#blocked;
        this.onActivity(active ? this.#record.intent.area : null);
    }

    /** Detach browser work, retaining server/recovery records. @return {void} */
    destroy() {
        this.destroyed = true;
        this.#discardReview();
        if (this.#desired?.plan) this.plansToRelease.add(this.#desired.plan.planId);
        this.#desired = null;
        this.unsubscribe(); this.onActivity(null);
        if (!this.#advanceRunning) void this.#releasePlans().catch(() => {});
    }
}
