/** Accessible Downloads DOM adapter. No map, histogram, or vector implementation knowledge. */
import { ACTIVE_JOB_STATES } from "./jobs.js";
import { processingDownloadUrl } from "./api.js";

import { describeClipCrs, formatDownloadBytes, describeClipArea, describeJobProgress } from "./presentation.js";
export { describeClipCrs, formatDownloadBytes, describeClipArea, describeJobProgress } from "./presentation.js";

/** Own fixed controls, review details, and retained job cards. */
export class DownloadsView {
    /** @param {Document} [documentContext=globalThis.document] Owning document. */
    constructor(documentContext = globalThis.document) {
        this.document = documentContext;
        this.elements = Object.fromEntries([
            "source", "area", "area-description", "create", "message", "jobs", "job-message",
            "pending", "retry-submission", "refresh", "edit-area", "close", "form",
        ].map(name => [name, documentContext.querySelector(`#downloads-${name}`)]));
        this.openers = [
            documentContext.querySelector("#open-downloads"),
            documentContext.querySelector("#open-downloads-dock"),
        ];
        this.moreSummaries = [
            documentContext.querySelector("#map-tools-more-summary"),
            documentContext.querySelector("#map-inspection-more-summary"),
        ];
        this.moreMenus = [
            documentContext.querySelector("#map-tools-more"),
            documentContext.querySelector("#map-inspection-more"),
        ];
        this.listeners = [];
        this.sourceSignature = "";
        this.jobSignature = "";
    }

    /** Connect fixed controls to semantic callbacks. @param {Object} handlers User intent handlers. @return {void} */
    bind(handlers) {
        this.handlers = handlers;
        const openEvents = this.openers.map((opener, index) => [
            opener,
            "click",
            () => {
                this.moreMenus[index].open = false;
                handlers.onOpen();
            },
        ]);
        const events = [
            ...openEvents,
            [this.elements.close, "click", handlers.onClose],
            [this.elements.source, "change", () => handlers.onSource(Number(this.elements.source.value))],
            [this.elements.area, "change", () => handlers.onArea(this.elements.area.value)],
            [this.elements.form, "submit", event => { event.preventDefault(); handlers.onCreate(); }],
            ...[["retry-submission", "onRetrySubmission"],
                ["refresh", "onRefresh"], ["edit-area", "onEditArea"]]
                .map(([element, handler]) => [this.elements[element], "click", handlers[handler]]),
        ];
        for (const [element, event, handler] of events) element.addEventListener(event, handler);
        this.listeners = events;
    }

    /** Detach all fixed listeners. @return {void} */
    unbind() {
        for (const [element, event, handler] of this.listeners) element.removeEventListener(event, handler);
        this.listeners = [];
        this.handlers = null;
    }

    /** Create an element with safe text. @param {string} tag HTML tag. @param {string} text Display text. @return {HTMLElement} Detached element. */
    element(tag, text) {
        const element = this.document.createElement(tag);
        element.textContent = text;
        return element;
    }

    /** Render form state without discarding keyboard focus on each poll. @param {Object} state Controller snapshot. @return {void} */
    render(state) {
        const e = this.elements;
        const signature = JSON.stringify(state.sources);
        if (signature !== this.sourceSignature) {
            e.source.replaceChildren(...state.sources.map((source, index) => {
                const option = this.element("option", source.label);
                option.value = String(index);
                return option;
            }));
            this.sourceSignature = signature;
        }
        e.source.value = String(state.sources.findIndex(source => source.collectionId === state.source?.collectionId && source.itemId === state.source?.itemId));
        const selection = this.element("option", "Selected histogram area (captured when opened)");
        selection.value = "selection";
        e.area.replaceChildren(selection);
        e.area.value = state.areaChoice;
        const locked = !!state.pending || state.submitting;
        e.source.disabled = locked || state.sources.length === 0;
        e.area.disabled = locked;
        e["edit-area"].disabled = locked;
        e["area-description"].textContent = describeClipArea(state.area);
        e.create.disabled = locked || !state.source || !state.area;
        e.create.textContent = state.submitting ? "Submitting clip…" : "Create clip";
        e.message.textContent = state.message;
        e["job-message"].textContent = state.jobMessage;
        e.pending.hidden = !state.pending;
        e.pending.textContent = state.pending ? `${state.submitting ? "Confirming" : "Unconfirmed submission for"} ${state.pending.label}. Its area and raster are fixed until this request is recovered.` : "";
        e["retry-submission"].hidden = !state.pending;
        e["retry-submission"].disabled = state.submitting;
        const active = state.jobs.filter(job => ACTIVE_JOB_STATES.has(job.status)).length;
        const ready = state.jobs.filter(job => job.status === "ready").length;
        const activity = active
            ? String(active) + " working"
            : state.pending ? "action needed" : "";
        const readyLabel = ready ? " \u00b7 " + ready + " ready" : "";
        for (const summary of this.moreSummaries) {
            summary.textContent = "More" + (activity ? " \u00b7 " + activity : "");
            summary.title = activity
                ? "Open more map tools; " + activity
                : "Open more map tools";
        }
        for (const opener of this.openers) {
            opener.textContent = "History & exports" + readyLabel;
            opener.title = "Open calculation history and raster clip exports";
        }
        const jobSignature = JSON.stringify([state.jobs, [...state.jobActions], state.sources]);
        if (this.jobSignature !== jobSignature) {
            const focus = this.document.activeElement?.getAttribute("data-download-action");
            const cards = state.jobs.filter(job => job.status !== "deleted").map(job => this.jobCard(job, state));
            e.jobs.replaceChildren(...(cards.length ? cards : [this.element("p", "No clips yet. Choose a raster and area, then create your clip.")]));
            if (focus) e.jobs.querySelector?.(`[data-download-action="${focus}"]`)?.focus();
            this.jobSignature = jobSignature;
        }
    }

    /** Build one owned lifecycle card. @param {Object} job Public job. @param {Object} state Current presentation state. @return {HTMLElement} Job card. */
    jobCard(job, state) {
        const card = this.element("article", "");
        card.className = "download-job";
        const identity = job.source ?? Object.values(job.sources ?? {})[0];
        const calculation = job.operation === "raster.aggregate.v1";
        const source = state.sources.find(item => item.collectionId === identity?.collectionId && item.itemId === identity?.itemId);
        card.append(this.element("h3", source?.label ?? job.result?.filename ?? job.source?.itemId ?? "Raster calculation"),
            this.element("p", describeJobProgress(job)));
        if (job.area) card.append(this.element("p", describeClipArea(job.area)));
        if (job.status === "running" && job.progress.phase === "clipping" && job.progress.totalBlocks > 0) {
            const progress = this.element("progress", "");
            progress.max = job.progress.totalBlocks;
            progress.value = job.progress.completedBlocks ?? 0;
            progress.setAttribute("aria-label", "Source blocks clipped");
            card.append(progress);
        }
        if (job.grid) card.append(this.element("p", `${job.grid.width} × ${job.grid.height} pixels · ${describeClipCrs(job.grid.crs)}`));
        if (!calculation && job.grid) card.append(this.element("p",
            `COG · native resolution · ${formatDownloadBytes(job.grid.estimatedRawBytes)} estimated uncompressed`));
        if (job.error) card.append(this.element("p", `${job.error.detail} (${job.error.code})`));
        if (job.result && job.status === "ready") {
            card.append(this.element("p", `${formatDownloadBytes(job.result.bytes)} · expires ${new Date(job.expiresAt).toLocaleString()}`));
            for (const [kind, label, url] of [["result", calculation ? "Download CSV" : "Download COG", job.result.url], ["provenance", "Provenance", job.result.provenanceUrl]]) {
                const link = this.element("a", label);
                link.className = "secondary-button";
                link.href = processingDownloadUrl(url, job.jobId, kind);
                link.setAttribute("download", "");
                link.setAttribute("data-download-action", `${job.jobId}-${kind}`);
                card.append(link);
            }
        }
        if (calculation) {
            const inspect = this.element("button", "View calculation results");
            inspect.type = "button";
            inspect.className = "secondary-button";
            inspect.setAttribute("data-download-action", `${job.jobId}-inspect`);
            inspect.addEventListener("click", () => this.handlers?.onInspectCalculation?.(job.jobId));
            card.append(inspect);
        }
        const active = ACTIVE_JOB_STATES.has(job.status);
        const action = active ? "cancel" : "delete";
        const button = this.element("button", active ? "Cancel job" : "Delete result");
        button.type = "button";
        button.className = "secondary-button";
        button.disabled = state.jobActions.has(job.jobId) || job.status === "cancelling";
        button.setAttribute("data-download-action", `${job.jobId}-${action}`);
        button.addEventListener("click", () => active ? this.handlers?.onCancel(job.jobId) : this.handlers?.onDelete(job.jobId));
        card.append(button);
        return card;
    }
}
