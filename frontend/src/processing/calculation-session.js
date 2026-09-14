/** Bounded per-tab recovery for a calculation, including superseded submissions. */
import { normalizeRasterSamplingArea } from "../selected-area.js";
const KEY = "eolab.processing.calculation.v1";
const ID = /^[A-Za-z0-9_-]{32}$/;

/** Validate the optional total-pixel execution budget. @param {number|null} value Setting. @return {number|null} Budget. */
export function chunkPixels(value) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 1 || value > 4194304) throw new TypeError("Batch size must be 1 to 4,194,304 pixels.");
    return value;
}

/** Copy only the public calculation intent. @param {Object} value Candidate intent. @return {Readonly<Object>} Immutable snapshot. */
export function calculationIntent(value) {
    const { collectionId, itemId, label } = value.source;
    if (![collectionId, itemId, label].every(text => typeof text === "string" && text.length > 0 && text.length <= 512)) {
        throw new TypeError("Choose a Catalog raster.");
    }
    if (!Array.isArray(value.calculations) || value.calculations.length < 1 || value.calculations.length > 5) {
        throw new TypeError("Use one to five calculations.");
    }
    const calculations = value.calculations.map(({ label, expression }) => {
        if (typeof label !== "string" || !label.trim() || label.length > 80 ||
            typeof expression !== "string" || !expression.trim() || expression.length > 4096) {
            throw new TypeError("Each calculation needs a label and expression.");
        }
        return Object.freeze({ label, expression });
    });
    return Object.freeze({ source: Object.freeze({ collectionId, itemId, label }),
        ...(chunkPixels(value.targetChunkPixels) === null ? {} : { targetChunkPixels: value.targetChunkPixels }),
        area: normalizeRasterSamplingArea(value.area), calculations: Object.freeze(calculations) });
}

/** Keep idempotency and cancellation intent across reloads, without persisting cookies. */
export class CalculationSessionStorage {
    /** @param {Storage|null} storage Browser sessionStorage. */
    constructor(storage) { this.storage = storage; }
    /** Recover validated execution data and caller context without choosing whether to cancel. @return {Object|null} Owned workflow. */
    read() {
        try {
            const text = this.storage?.getItem(KEY);
            if (!text || text.length > 16384) return null;
            const value = JSON.parse(text);
            if (typeof value.automatic !== "boolean" || typeof value.cancelRequested !== "boolean" ||
                !(value.jobId === null || ID.test(value.jobId)) ||
                !(value.pending === null || (ID.test(value.pending?.planId) && /^[A-Za-z0-9_-]{16,80}$/.test(value.pending?.requestId))) ||
                (!value.jobId && !value.pending)) return null;
            if (!(value.releasePlanId === undefined || value.releasePlanId === null || ID.test(value.releasePlanId))) return null;
            return { intent: calculationIntent(value.intent), jobId: value.jobId, pending: value.pending,
                releasePlanId: value.releasePlanId ?? null,
                context: Object.freeze({ automatic: value.automatic }), cancelRequested: value.cancelRequested };
        } catch { return null; }
    }
    /** Persist execution data using the existing v1 record format.
     * The statistics owner supplies automatic/manual recovery metadata as context.
     * This adapter maps it to the legacy automatic field without applying policy.
     * @param {Object} record Execution data and optional caller context.
     * @return {void}
     * @throws {Error} If storage is unavailable, full, or the record exceeds its bound.
     */
    write(record) {
        if (!this.storage) throw new Error("Browser session storage is needed for recoverable calculations.");
        const { context, ...execution } = record;
        const text = JSON.stringify({ ...execution, automatic: context?.automatic ?? false });
        if (text.length > 16384) throw new Error("Calculation recovery information is too large.");
        this.storage.setItem(KEY, text);
    }
    /** Remove a confirmed terminal workflow. @return {void} */
    clear() { this.storage?.removeItem(KEY); }
}
