/** Capture fresh resource entries even when map tiles have filled the browser buffer.
 * @return {function(string|null, number):Object|null} Finish measurement and release
 * the observer; call on success, error, and cancellation. Never waits for an entry.
 */
export function captureRequestNetworkTiming() {
    let observer;
    const entries = [];
    try {
        observer = new PerformanceObserver(list => {
            entries.push(...list.getEntries().filter(entry => entry.initiatorType === "fetch"));
            if (entries.length > 64) entries.splice(0, entries.length - 64);
        });
        observer.observe({type: "resource"});
    } catch { /* Resource observation is optional. */ }
    return (requestId, finishedAtMs) => {
        try {
            entries.push(...(observer?.takeRecords() ?? []));
            return readRequestNetworkTiming(requestId, finishedAtMs, {
                getEntriesByType: () => [...(globalThis.performance?.getEntriesByType?.("resource") ?? []), ...entries],
            });
        } catch { return null; }
        finally { observer?.disconnect(); }
    };
}

/** Find network timings for an exact response, including concurrent identical URLs.
 * The server-generated ID in Server-Timing prevents associating another request's
 * measurements. Missing/evicted browser entries remain unavailable, never guessed.
 * @param {string|null} requestId Server-generated correlation ID, not a job ID.
 * @param {number} finishedAtMs JSON completion on the browser performance clock.
 * @param {Performance|undefined} [clock=globalThis.performance] Browser resource timeline.
 * @return {Object|null} Numeric seconds/bytes and protocol, or unavailable.
 */
export function readRequestNetworkTiming(requestId, finishedAtMs, clock = globalThis.performance) {
    if (!/^[a-f0-9]{32}$/.test(requestId ?? "")) return null;
    try {
        const entries = clock?.getEntriesByType?.("resource") ?? [];
        const entry = entries.findLast(item => item.initiatorType === "fetch" &&
            item.serverTiming?.some(metric => metric.name === "requestId" && metric.description === requestId));
        if (!entry || !(entry.requestStart > 0) || entry.responseEnd < entry.responseStart) return null;
        return {
            beforeRequestSeconds: (entry.requestStart - entry.startTime) / 1000,
            dnsSeconds: (entry.domainLookupEnd - entry.domainLookupStart) / 1000,
            connectSeconds: (entry.connectEnd - entry.connectStart) / 1000,
            tlsSeconds: entry.secureConnectionStart > 0 ? (entry.connectEnd - entry.secureConnectionStart) / 1000 : 0,
            firstByteSeconds: (entry.responseStart - entry.requestStart) / 1000,
            downloadSeconds: (entry.responseEnd - entry.responseStart) / 1000,
            afterDownloadSeconds: Math.max(0, finishedAtMs - entry.responseEnd) / 1000,
            protocol: ["h2", "h3", "http/1.1"].includes(entry.nextHopProtocol) ? entry.nextHopProtocol : "unavailable",
            encodedBytes: entry.encodedBodySize, decodedBytes: entry.decodedBodySize,
        };
    } catch { return null; } // Optional instrumentation cannot fail the request.
}

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
