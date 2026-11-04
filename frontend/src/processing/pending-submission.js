/** Save a raster-clip request for retry after reloading or losing the server response.
 * Only source and area references, the retry identifier and label are stored.
 */
import { labeledRasterSource } from "../raster-source.js";
import { normalizeRasterSamplingArea } from "../selected-area.js";
const KEY = "eolab.processing.pending.v2";

/** Store one pending raster-clip request in this browser tab's session storage. */
export class PendingSubmissionStorage {
    /** @param {Storage|null} storage Browser session storage; null disables submission recovery. */
    constructor(storage) { this.storage = storage; }

    /** Restore a pending clip request, ignoring malformed or oversized saved records.
     * @return {Object|null} Source, area, retry identifier and label, or null if unavailable.
     */
    read() {
        try {
            const text = this.storage?.getItem(KEY);
            if (!text || text.length > 16384) return null;
            const value = JSON.parse(text);
            const source = labeledRasterSource(value.source, value.source?.label);
            if (
                !/^[A-Za-z0-9_-]{16,80}$/.test(value.requestId) ||
                typeof value.label !== "string" || value.label.length > 512) return null;
            const area = normalizeRasterSamplingArea(value.area);
            if (!["selectedArea", "samplingBox", "catalogSelection"].includes(area.kind)) return null;
            return { source, area, requestId: value.requestId, label: value.label };
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
