/** DOM presentation for raster values anchored at the last picked location. */
import { formatRasterPixelValue } from "./value-format.js";
import { requireRasterControl } from "./required-control.js";

const POINTER_OFFSET_PIXELS = 14;
const VIEWPORT_EDGE_PIXELS = 8;
const COPY_FEEDBACK_MILLISECONDS = 1200;

/**
 * Return whether a keyboard event belongs to an editable control.
 *
 * @param {EventTarget|null} target Event target.
 * @return {boolean} Whether application shortcuts must leave it alone.
 */
function isEditableTarget(target) {
    const tagName = String(target?.tagName ?? "").toLowerCase();
    return target?.isContentEditable === true ||
        ["input", "select", "textarea"].includes(tagName);
}

/**
 * Format the current geographic position for compact on-map presentation.
 *
 * @param {{latitude:number,longitude:number}} position Canonical WGS 84 point.
 * @return {string} Readable latitude and longitude.
 */
function formatPosition(position) {
    return `Lat ${position.latitude.toFixed(5)} · Lng ${position.longitude.toFixed(5)}`;
}

/**
 * Produce a tab-separated clipboard representation of one picker snapshot.
 *
 * @param {{position:Object,samples:Object[],omittedCount:number}} snapshot
 * Current immutable pixel-picker snapshot.
 * @return {string} Geographic position followed by visible raster values.
 */
export function formatRasterCursorValuesForClipboard(snapshot) {
    const lines = [
        `Latitude\t${snapshot.position.latitude}`,
        `Longitude\t${snapshot.position.longitude}`,
    ];
    for (const sample of snapshot.samples) {
        if (sample.state === "outside") continue;
        const value = sample.state === "value"
            ? formatRasterPixelValue(sample.value)
            : sample.state === "nodata"
                ? "No data"
                : sample.state === "loading"
                    ? "Reading"
                    : `Unavailable: ${sample.errorMessage}`;
        lines.push(`${sample.label}\t${value}`);
    }
    if (snapshot.omittedCount > 0) {
        lines.push(`Additional rasters omitted\t${snapshot.omittedCount}`);
    }
    return lines.join("\n");
}

/** Present immutable pixel-picker snapshots without owning sampling policy. */
export class RasterCursorValuesView {
    /**
     * Resolve the pixel-picker DOM contract.
     *
     * @param {Document} [documentContext=globalThis.document] Owning document.
     * @param {{writeText:(text:string)=>Promise<void>}|null} [clipboard=null]
     * Clipboard boundary; null resolves it from the owning window when possible.
     * @param {{setTimeout:Function,clearTimeout:Function}} [clock=globalThis]
     * Injectable timer boundary for copy confirmation.
     */
    constructor(
        documentContext = globalThis.document,
        clipboard = null,
        clock = globalThis
    ) {
        this.documentContext = documentContext;
        this.clipboard = clipboard ??
            documentContext.defaultView?.navigator?.clipboard ?? null;
        this.clock = clock;
        this.root = requireRasterControl(
            documentContext,
            "#raster-cursor-values"
        );
        this.position = requireRasterControl(
            documentContext,
            "#raster-cursor-position"
        );
        this.list = requireRasterControl(
            documentContext,
            "#raster-cursor-value-list"
        );
        this.limit = requireRasterControl(
            documentContext,
            "#raster-cursor-value-limit"
        );
        this.copyFeedback = requireRasterControl(
            documentContext,
            "#raster-cursor-copy-feedback"
        );
        this.restore = requireRasterControl(
            documentContext,
            "#restore-raster-cursor-values"
        );
        this.marker = requireRasterControl(documentContext, "#raster-cursor-marker");
        this.pending = requireRasterControl(documentContext, "#raster-cursor-pending");
        this.pointerPosition = null;
        this.anchorPosition = null;
        this.snapshot = null;
        this.copyFeedbackTimeout = null;
        this.handlers = null;
        this.handleKeyDown = this.#handleKeyDown.bind(this);
        this.handleRestoreClick = this.#handleRestoreClick.bind(this);
    }

    /**
     * Connect the DOM controls to picker policy owned by the raster viewer.
     *
     * @param {{onHide:()=>void,onShow:()=>void}} handlers Interaction callbacks.
     * @return {void}
     */
    bind(handlers) {
        if (
            typeof handlers?.onHide !== "function" ||
            typeof handlers?.onShow !== "function"
        ) {
            throw new TypeError("Pixel-picker handlers are incomplete");
        }
        this.unbind();
        this.handlers = handlers;
        this.restore.addEventListener("click", this.handleRestoreClick);
        this.documentContext.addEventListener("keydown", this.handleKeyDown);
    }

    /** Detach picker controls from their event sources. @return {void} */
    unbind() {
        this.restore.removeEventListener("click", this.handleRestoreClick);
        this.documentContext.removeEventListener("keydown", this.handleKeyDown);
        this.#clearCopyFeedback();
        this.handlers = null;
    }

    /**
     * Retain the next pointer position while keeping the current pick anchored.
     *
     * @param {{clientX:number,clientY:number}} position Viewport coordinates.
     * @return {void}
     */
    move(position) {
        if (
            !Number.isFinite(position?.clientX) ||
            !Number.isFinite(position?.clientY)
        ) {
            return;
        }
        this.pointerPosition = { ...position };
        if (this.snapshot !== null) {
            this.pending.hidden = false;
            this.root.setAttribute("aria-busy", "true");
        }
    }

    /**
     * Expose whether the picker is available or intentionally hidden.
     *
     * @param {boolean} enabled Whether pointer sampling is enabled.
     * @return {void}
     */
    setEnabled(enabled) {
        if (typeof enabled !== "boolean") {
            throw new TypeError("Pixel-picker enabled state must be boolean");
        }
        this.restore.hidden = enabled;
        if (!enabled) this.clear();
    }

    /**
     * Render visible results beside their picked location. Keep the prior pick
     * during replacement loading, then commit the new position and values
     * together on the first available result. Outside-only results disappear.
     *
     * @param {{position:Object,samples:Object[],omittedCount:number}} snapshot
     * Pixel-picker snapshot.
     * @return {void}
     */
    render(snapshot) {
        if (
            snapshot === null ||
            typeof snapshot !== "object" ||
            !Number.isFinite(snapshot.position?.latitude) ||
            !Number.isFinite(snapshot.position?.longitude) ||
            !Array.isArray(snapshot.samples) ||
            !Number.isInteger(snapshot.omittedCount) ||
            snapshot.omittedCount < 0
        ) {
            throw new TypeError("Raster cursor snapshot is invalid");
        }
        const samples = snapshot.samples.filter(
            (sample) => sample.state !== "outside"
        );
        if (this.snapshot !== null && samples.length > 0 &&
            samples.every((sample) => sample.state === "loading")) {
            this.pending.hidden = false;
            this.root.setAttribute("aria-busy", "true");
            return;
        }
        if (samples.length === 0) {
            this.clear();
            return;
        }
        const rows = samples.map((sample) => {
            const row = this.documentContext.createElement("div");
            row.className = "raster-cursor-value-row";
            row.setAttribute("data-state", sample.state);
            const name = this.documentContext.createElement("dt");
            name.textContent = sample.label;
            name.title = sample.label;
            const value = this.documentContext.createElement("dd");
            value.textContent = sample.state === "loading"
                ? "Reading…"
                : sample.state === "value"
                    ? formatRasterPixelValue(sample.value)
                    : sample.state === "nodata"
                        ? "No data"
                        : `Unavailable: ${sample.errorMessage}`;
            row.append(name, value);
            return row;
        });
        const changedPosition = this.snapshot === null ||
            this.snapshot.position.latitude !== snapshot.position.latitude ||
            this.snapshot.position.longitude !== snapshot.position.longitude;
        if (changedPosition) {
            this.anchorPosition = this.pointerPosition;
            this.#clearCopyFeedback();
        }
        this.snapshot = snapshot;
        this.pending.hidden = true;
        this.position.textContent = formatPosition(snapshot.position);
        this.list.replaceChildren(...rows);
        this.limit.textContent = snapshot.omittedCount > 0
            ? `${snapshot.omittedCount} additional rasters omitted.`
            : "";
        this.limit.hidden = snapshot.omittedCount === 0;
        this.root.setAttribute(
            "aria-busy",
            String(samples.some((sample) => sample.state === "loading"))
        );
        this.root.hidden = false;
        this.#applyPointerPosition();
    }

    /** Hide and empty the transient pixel-picker readout. @return {void} */
    clear() {
        this.#clearCopyFeedback();
        this.snapshot = null;
        this.anchorPosition = null;
        this.marker.hidden = true;
        this.pending.hidden = true;
        this.position.textContent = "";
        this.list.replaceChildren();
        this.limit.textContent = "";
        this.limit.hidden = true;
        this.root.setAttribute("aria-busy", "false");
        this.root.hidden = true;
    }

    /** Remove any pending clipboard confirmation and its visual emphasis. */
    #clearCopyFeedback() {
        if (this.copyFeedbackTimeout !== null) {
            this.clock.clearTimeout(this.copyFeedbackTimeout);
            this.copyFeedbackTimeout = null;
        }
        this.copyFeedback.hidden = true;
        this.root.classList.remove("is-copy-confirmed");
    }

    /** Briefly confirm a successful clipboard write without a live announcement. */
    #showCopyFeedback() {
        this.#clearCopyFeedback();
        this.copyFeedback.hidden = false;
        this.root.classList.add("is-copy-confirmed");
        this.copyFeedbackTimeout = this.clock.setTimeout(() => {
            this.copyFeedbackTimeout = null;
            this.copyFeedback.hidden = true;
            this.root.classList.remove("is-copy-confirmed");
        }, COPY_FEEDBACK_MILLISECONDS);
    }

    /** Copy the current resolved presentation and confirm only after success. */
    async #copyCurrentValues() {
        if (this.snapshot === null || typeof this.clipboard?.writeText !== "function") {
            return;
        }
        try {
            await this.clipboard.writeText(
                formatRasterCursorValuesForClipboard(this.snapshot)
            );
        } catch {
            return;
        }
        this.#showCopyFeedback();
    }

    /** Place marker and panel at the accepted pick, within the viewport. @return {void} */
    #applyPointerPosition() {
        if (this.anchorPosition === null || this.root.hidden) return;
        const { clientX, clientY } = this.anchorPosition;
        this.marker.style.left = `${clientX}px`;
        this.marker.style.top = `${clientY}px`;
        this.marker.hidden = false;
        const { width, height } = this.root.getBoundingClientRect();
        const viewportWidth = this.documentContext.defaultView?.innerWidth ?? 1024;
        const viewportHeight = this.documentContext.defaultView?.innerHeight ?? 768;
        let left = clientX + POINTER_OFFSET_PIXELS;
        let top = clientY + POINTER_OFFSET_PIXELS;
        if (left + width > viewportWidth - VIEWPORT_EDGE_PIXELS) {
            left = clientX - width - POINTER_OFFSET_PIXELS;
        }
        if (top + height > viewportHeight - VIEWPORT_EDGE_PIXELS) {
            top = clientY - height - POINTER_OFFSET_PIXELS;
        }
        this.root.style.left = `${Math.max(VIEWPORT_EDGE_PIXELS, left)}px`;
        this.root.style.top = `${Math.max(VIEWPORT_EDGE_PIXELS, top)}px`;
    }

    /** Restore pointer sampling from its persistent on-map prompt. */
    #handleRestoreClick() {
        this.handlers?.onShow();
    }

    /**
     * Handle only picker-specific shortcuts outside editable controls.
     *
     * @param {KeyboardEvent} event Keyboard input.
     * @return {void}
     */
    #handleKeyDown(event) {
        if (isEditableTarget(event.target)) return;
        const key = String(event.key ?? "").toLowerCase();
        if (key === "escape" && !this.root.hidden) {
            event.preventDefault();
            this.handlers?.onHide();
            return;
        }
        if (key === "p" && this.restore.hidden === false &&
            !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            this.handlers?.onShow();
            return;
        }
        if (key === "c" && (event.ctrlKey || event.metaKey) &&
            !event.altKey && !this.root.hidden && this.snapshot !== null) {
            event.preventDefault();
            void this.#copyCurrentValues();
        }
    }
}
