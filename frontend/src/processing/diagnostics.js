/** Bounded browser-clock evidence for Processing requests and result observation. */
export class ProcessingDiagnostics {
    /** @param {function():number} [now] Monotonic milliseconds.
     * @param {number} [capacity=512] Maximum retained events; older events are dropped.
     */
    constructor(now = () => performance.now(), capacity = 512) {
        this.now = now;
        this.capacity = capacity;
        this.events = [];
        this.lastDroppedAtMs = -Infinity;
    }

    /** Record timing metadata only; callers must not supply bodies, cookies or source paths.
     * @param {string} kind Processing activity.
     * @param {Object} [fields={}] Durations, opaque IDs and non-sensitive state.
     * @return {number} Event time in this tab's monotonic clock.
     */
    record(kind, fields = {}) {
        const atMs = this.now();
        this.events.push({...fields, kind, atMs, hidden: globalThis.document?.hidden ?? false});
        if (this.events.length > this.capacity) this.lastDroppedAtMs = this.events.shift().atMs;
        return atMs;
    }

    /** Copy this calculation's events and explicitly shared observer/transport events.
     * @param {number} sinceMs Start of the calculation's submission interval.
     * @param {string} planId Plan being submitted.
     * @param {string} jobId Accepted job identity.
     * @return {{partial:boolean, events:Object[]}} Bounded snapshot; shared events are not job-specific.
     */
    snapshot(sinceMs, planId, jobId) {
        return {partial: this.lastDroppedAtMs >= sinceMs, events: this.events
            .filter(event => event.atMs >= sinceMs &&
                (event.shared || event.kind.startsWith("http-") || event.planId === planId || event.jobId === jobId))
            .map(event => ({...event, afterSubmissionSeconds: (event.atMs - sinceMs) / 1000}))};
    }
}
