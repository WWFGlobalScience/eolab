/** Reload recovery for one uncertain submission. No cookies, geometry, or result files are stored. */
import { normalizeRasterSamplingArea } from "../selected-area.js";
const KEY = "eolab.processing.pending.v2";

/** Own the minimal per-tab idempotency record. */
export class PendingSubmissionStorage {
    /** @param {Storage|null} storage Browser session storage; null disables submission recovery. */
    constructor(storage) { this.storage = storage; }

    /** Read a bounded validated record after reload. @return {Object|null} Submission identity and display label. */
    read() {
        try {
            const text = this.storage?.getItem(KEY);
            if (!text || text.length > 16384) return null;
            const value = JSON.parse(text);
            if (![value.source?.collectionId, value.source?.itemId].every(id => typeof id === "string" && id.length > 0 && id.length <= 512) ||
                !/^[A-Za-z0-9_-]{16,80}$/.test(value.requestId) ||
                typeof value.label !== "string" || value.label.length > 512) return null;
            const area = normalizeRasterSamplingArea(value.area);
            if (!["selectedArea", "catalogSelection"].includes(area.kind)) return null;
            return { source: value.source, area, requestId: value.requestId, label: value.label };
        } catch { return null; }
    }

    /** Persist before dispatch so a lost response can be retried safely.
     * @param {Object} value Captured source, area, request key and label.
     * @return {void}
     * @throws {Error} If storage is unavailable, full, or the record exceeds the recovery limit.
     */
    write(value) {
        if (!this.storage) throw new Error("Browser session storage is unavailable. Enable it to create recoverable downloads.");
        const text = JSON.stringify(value);
        if (text.length > 16384) throw new Error("This clip request is too large to save for recovery.");
        this.storage.setItem(KEY, text);
    }

    /** Clear a confirmed submission. @return {void} */
    clear() { this.storage?.removeItem(KEY); }
}
