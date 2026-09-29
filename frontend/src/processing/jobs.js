/** Shared owned-job polling for clip and calculation presentations. */
export const ACTIVE_JOB_STATES = new Set(["queued", "running", "cancelling"]);

/** Own one session listing, mutations, and poll clock independently of editors. */
export class ProcessingJobs {
    /** @param {Object} api Processing transport. @param {Object} [clock=globalThis] Timer provider. */
    constructor(api, clock = globalThis) {
        Object.assign(this, { api, clock });
        this.jobs = [];
        this.error = "";
        this.listeners = new Set();
        this.tracked = new Set();
        /** @type {Set<string>|null} Jobs changed locally during the current refresh. */
        this.jobsChangedDuringRefresh = null;
        this.refreshing = null;
        this.timer = null;
        this.destroyed = false;
        this.stopEvents = null;
        this.eventRevision = 0;
        this.refreshSequence = 0;
    }
    /** Observe shared history. @param {Function} listener Receives store. @return {Function} Unsubscribe. */
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    /** Notify editors without changing their intent. @return {void} */
    notify() { if (!this.destroyed) for (const listener of this.listeners) listener(this); }
    /** Keep a submission or action response when an older status read is pending.
     * Other jobs in that read can still update normally.
     * @param {Object} job Job snapshot returned by submission, cancellation, or deletion.
     * @return {void}
     */
    accept(job) {
        this.jobsChangedDuringRefresh?.add(job.jobId);
        this.jobs = [job, ...this.jobs.filter(item => item.jobId !== job.jobId)];
        this.notify();
        this.schedule();
    }
    /** Refresh job history, preserving local changes made while the read was pending.
     * Merge by job ID so one submission or action cannot delay unrelated results.
     * Jobs absent from server history are removed unless tracked or changed locally.
     * @param {string} [trigger="explicit"] SSE, timer, follow-up, or explicit caller.
     * @return {Promise<void>} The existing in-flight read, or a new refresh.
     */
    refresh(trigger = "explicit") {
        const diagnostics = this.api.diagnostics;
        if (this.refreshing) {
            diagnostics?.record("refresh-coalesced", {shared: true, trigger, refreshNumber: this.refreshSequence});
            return this.refreshing;
        }
        const refreshNumber = ++this.refreshSequence;
        const startedAtMs = diagnostics?.record("refresh-start", {shared: true, trigger, refreshNumber});
        const changedJobs = new Set();
        this.jobsChangedDuringRefresh = changedJobs;
        const eventRevision = this.eventRevision;
        this.refreshing = (async () => {
            try {
                const jobs = await this.api.listJobs();
                for (const job of jobs) if (job.status === "ready" && this.tracked.has(job.jobId)) {
                    diagnostics?.record("ready-received", {jobId: job.jobId, trigger, refreshNumber});
                }
                for (const id of this.tracked) {
                    if (!jobs.some(job => job.jobId === id)) {
                        diagnostics?.record("extra-job-read", {jobId: id, trigger, refreshNumber});
                        const job = await this.api.getJob(id);
                        jobs.push(job);
                        if (job.status === "ready") diagnostics?.record("ready-received", {jobId: id, trigger, refreshNumber});
                    }
                }
                if (!this.destroyed) {
                    const accepted = jobs.filter(job => {
                        if (!changedJobs.has(job.jobId)) return true;
                        diagnostics?.record("job-update-skipped", {jobId: job.jobId, trigger, refreshNumber});
                        return false;
                    });
                    this.jobs = [...this.jobs.filter(job => changedJobs.has(job.jobId)), ...accepted];
                    this.error = "";
                    for (const job of accepted) if (job.status === "ready" && this.tracked.has(job.jobId)) {
                        diagnostics?.record("ready-accepted", {jobId: job.jobId, trigger, refreshNumber});
                    }
                } else diagnostics?.record("refresh-discarded", {shared: true, trigger, refreshNumber,
                    reason: "destroyed"});
            } catch (error) {
                diagnostics?.record("refresh-error", {shared: true, trigger, refreshNumber});
                this.error = `Processing history unavailable: ${error.message}`;
            }
        })().finally(() => {
            diagnostics?.record("refresh-finish", {shared: true, trigger, refreshNumber,
                seconds: (diagnostics.now() - startedAtMs) / 1000});
            this.jobsChangedDuringRefresh = null;
            this.refreshing = null; this.notify(); this.schedule();
            // An event arriving during a read may describe a newer commit than
            // that read saw. Coalesce the burst into exactly one subsequent read.
            if (!this.destroyed && eventRevision !== this.eventRevision) void this.refresh("sse-follow-up");
        });
        return this.refreshing;
    }
    /** Schedule progress/expiry updates. @return {void} */
    schedule() {
        this.clock.clearTimeout(this.timer);
        const active = this.jobs.some(job => ACTIVE_JOB_STATES.has(job.status)) || this.tracked.size;
        if (!this.destroyed && active && !this.stopEvents) this.stopEvents = this.api.watchJobs?.(() => {
            if (this.destroyed) return;
            this.eventRevision += 1;
            void this.refresh("sse");
        }) ?? null;
        if ((!active || this.destroyed) && this.stopEvents) { this.stopEvents(); this.stopEvents = null; }
        if (!this.destroyed) {
            const delay = active ? 2000 : 30000;
            const scheduledAtMs = this.api.diagnostics?.now();
            this.timer = this.clock.setTimeout(() => {
                this.api.diagnostics?.record("fallback-timer", {shared: true,
                    lateSeconds: Math.max(0, (this.api.diagnostics.now() - scheduledAtMs - delay) / 1000)});
                void this.refresh("timer");
            }, delay);
        }
    }
    /** Mutate one owned job and refresh. @param {string} id Job ID. @param {string} action Cancel or delete. @return {Promise<Object|undefined>} Updated job. */
    async action(id, action) {
        const job = action === "cancel" ? await this.api.cancelJob(id) : await this.api.deleteJob(id);
        if (job?.jobId) this.accept(job);
        await this.refresh();
        return job;
    }
    /** Stop the shared poller. @return {void} */
    destroy() {
        this.destroyed = true; this.clock.clearTimeout(this.timer); this.listeners.clear();
        this.stopEvents?.(); this.stopEvents = null;
    }
}
