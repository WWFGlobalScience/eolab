import { rasterSourceKey } from "../raster-source.js";
/** Accessible raster clip controls. No map, histogram, or vector implementation knowledge. */
import { ACTIVE_JOB_STATES } from "./jobs.js";
import { processingDownloadUrl } from "./api.js";

import { describeClipCrs, formatDownloadBytes, describeClipArea, describeJobProgress } from "./presentation.js";
export { describeClipCrs, formatDownloadBytes, describeClipArea, describeJobProgress } from "./presentation.js";

/** Own contextual review, the current download and compact recovery navigation. */
export class RasterClipsView {
    /** Find clip controls and publish their owned review context through composition.
     * @param {Document} [documentContext=globalThis.document] Owning document.
     * @param {Object} [options] Presentation callbacks.
     * @param {(context:{source:string,scope:string,usesSamplingBox:boolean})=>void} [options.onContextChange] Display-only source, area and editable-box context.
     */
    constructor(documentContext = globalThis.document, { onContextChange = () => {} } = {}) {
        this.document = documentContext;
        this.onContextChange = onContextChange;
        this.elements = Object.fromEntries([
            "source", "source-name", "area-description", "create", "message", "current", "job-message",
            "pending", "retry-submission", "edit-area", "close", "form", "inputs", "new",
            "recent", "recent-label", "jobs",
        ].map(name => [name, documentContext.querySelector(`#raster-clips-${name}`)]));
        this.opener = documentContext.querySelector("#open-raster-clips");
        this.listeners = [];
        this.sourceSignature = "";
        this.jobSignature = "";
        this.recentSignature = "";
    }

    /** Connect fixed controls to semantic callbacks without owning shell navigation.
     * @param {Object} handlers User intent handlers.
     * @param {()=>void} handlers.onOpen Open clip review.
     * @param {()=>void} handlers.onClose Close clip review.
     * @param {(index:number)=>void} handlers.onSource Select a raster.
     * @param {()=>void} handlers.onNew Review another unsubmitted download.
     * @param {(id:string)=>void} handlers.onShowJob Inspect an owned recent download.
     * @param {()=>void} handlers.onCreate Submit current intent.
     * @param {()=>void} handlers.onRetrySubmission Recover an uncertain submission.
     * @param {()=>void} handlers.onEditArea Edit the selected area.
     * @param {(id:string)=>void} handlers.onCancel Cancel an owned job.
     * @param {(id:string)=>void} handlers.onDelete Delete an owned job.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        const events = [
            [this.opener, "click", handlers.onOpen],
            [this.elements.close, "click", handlers.onClose],
            [this.elements.source, "change", () => handlers.onSource(Number(this.elements.source.value))],
            [this.elements.new, "click", handlers.onNew],
            [this.elements.form, "submit", event => { event.preventDefault(); handlers.onCreate(); }],
            ...[["retry-submission", "onRetrySubmission"], ["edit-area", "onEditArea"]]
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

    /** Render captured review or the current owned download without changing accepted inputs.
     * Pending recovery uses its persisted source/area even without current map layers.
     * Review disclosures and source controls retain their nodes; rebuilt job controls
     * restore focus and disclosure state.
     * @param {Object} state Clip controller presentation and owned job snapshot.
     * @return {void}
     * @throws {TypeError} If a ready job contains an invalid owned download address.
     */
    render(state) {
        const e = this.elements;
        const current = state.jobs.find(job => job.jobId === state.currentJobId && job.status !== "deleted");
        const review = !!state.pending || state.submitting || state.review || !current;
        const source = state.pending?.source ?? state.source;
        const area = state.pending?.area ?? state.area;
        const signature = JSON.stringify(state.sources);
        if (signature !== this.sourceSignature) {
            e.source.replaceChildren(...state.sources.map((source, index) => {
                const option = this.element("option", source.label);
                option.value = String(index);
                return option;
            }));
            this.sourceSignature = signature;
        }
        e.source.value = String(state.sources.findIndex(item => source && rasterSourceKey(item) === rasterSourceKey(source)));
        const locked = !!state.pending || state.submitting;
        e.source.disabled = locked || state.sources.length === 0;
        e["edit-area"].disabled = locked;
        e["source-name"].textContent = state.pending?.label ?? source?.label ?? "Choose a raster";
        e["area-description"].textContent = describeClipArea(area);
        e.form.hidden = !review;
        if (review && (!source || !area)) e.inputs.open = true;
        e.current.hidden = review;
        e.new.hidden = review;
        this.onContextChange({ source: review ? e["source-name"].textContent : this.sourceName(current, state.sources),
            scope: review ? e["area-description"].textContent : describeClipArea(current.area),
            usesSamplingBox: review && !locked && ["selectedArea", "samplingBox"].includes(area?.kind) });
        e.create.disabled = locked || !source || !area;
        e.create.textContent = state.submitting ? "Submitting download…" : "Prepare download";
        e.message.textContent = state.message;
        e["job-message"].textContent = state.jobMessage;
        e.pending.hidden = !state.pending;
        e.pending.textContent = state.pending ? `${state.submitting ? "Confirming" : "Unconfirmed submission for"} ${state.pending.label}. Its area and raster are fixed until this request is recovered.` : "";
        e["retry-submission"].hidden = !state.pending;
        e["retry-submission"].disabled = state.submitting;
        const jobSignature = JSON.stringify([current, [...state.jobActions], state.sources]);
        if (this.jobSignature !== jobSignature) {
            const focused = e.current.contains(this.document.activeElement);
            const focus = focused ? this.document.activeElement?.getAttribute("data-download-action") : null;
            const detailsOpen = e.current.querySelector("details")?.open ?? false;
            const card = current ? this.jobCard(current, state) : null;
            e.current.replaceChildren(...(card ? [card] : []));
            if (card && detailsOpen) card.querySelector("details").open = true;
            if (focused && !review) (e.current.querySelector?.(`[data-download-action="${focus}"]`) ?? e.current).focus();
            this.jobSignature = jobSignature;
        }
        this.renderRecent(state, review ? null : current?.jobId);
    }

    /** Describe a job's catalog identity without requiring a retained map layer.
     * @param {Object} job Validated owned clip job.
     * @param {Object[]} sources Offered original-source identities and display labels.
     * @return {string} Source label or saved filename/item identity.
     */
    sourceName(job, sources) {
        const identity = job.source ?? Object.values(job.sources ?? {})[0];
        return sources.find(item => identity && rasterSourceKey(item) === rasterSourceKey(identity))?.label
            ?? identity?.itemId ?? job.result?.filename ?? "Raster clip";
    }

    /** Present other active or downloadable owned clips as compact recovery choices.
     * Expiration is server-owned; only authoritative job status determines availability.
     * @param {Object} state Clip jobs, action state and available catalog display labels.
     * @param {string|null|undefined} currentId Job already displayed outside the disclosure.
     * @return {void}
     */
    renderRecent(state, currentId) {
        const recent = state.jobs.filter(job => job.jobId !== currentId && (ACTIVE_JOB_STATES.has(job.status) || job.status === "ready"));
        this.elements.recent.hidden = recent.length === 0;
        this.elements["recent-label"].textContent = `Recent downloads (${recent.length})`;
        const signature = JSON.stringify([recent, state.sources, !!state.pending, state.submitting, [...state.jobActions]]);
        if (this.recentSignature === signature) return;
        const focused = this.elements.jobs.contains(this.document.activeElement);
        const focus = focused ? this.document.activeElement?.getAttribute("data-download-action") : null;
        const buttons = recent.map(job => {
            const row = this.element("div", ""); row.className = "raster-clip-recent-entry";
            const button = this.element("button", ""); button.type = "button"; button.className = "raster-clip-recent";
            button.disabled = !!state.pending || state.submitting;
            button.setAttribute("data-download-action", `${job.jobId}-inspect`);
            button.append(this.element("strong", this.sourceName(job, state.sources)),
                this.element("span", `${describeJobProgress(job)} · ${describeClipArea(job.area)}`));
            button.addEventListener("click", () => this.handlers?.onShowJob(job.jobId));
            row.append(button);
            if (ACTIVE_JOB_STATES.has(job.status)) {
                const cancel = this.element("button", "Cancel"); cancel.type = "button"; cancel.className = "secondary-button";
                cancel.setAttribute("aria-label", `Cancel download of ${this.sourceName(job, state.sources)}`);
                cancel.setAttribute("data-download-action", `${job.jobId}-cancel`);
                cancel.disabled = state.jobActions.has(job.jobId) || job.status === "cancelling";
                cancel.addEventListener("click", () => this.handlers?.onCancel(job.jobId)); row.append(cancel);
            }
            return row;
        });
        this.elements.jobs.replaceChildren(...buttons);
        if (focused) (this.elements.jobs.querySelector(`[data-download-action="${focus}"]`) ?? this.elements["recent-label"]).focus();
        this.recentSignature = signature;
    }

    /** Focus the selected download after an explicit recovery choice. @return {void} */
    focusCurrent() { this.elements.current.focus(); this.elements.current.scrollIntoView({ block: "nearest" }); }

    /** Build one immutable download's progress, result and secondary metadata.
     * @param {Object} job Validated owned clip job with source, area and optional result.
     * @param {Object} state Available display labels and in-flight lifecycle actions.
     * @return {HTMLElement} Current download card.
     * @throws {TypeError} If an artifact URL violates the owned download contract.
     */
    jobCard(job, state) {
        const card = this.element("article", "");
        card.className = "download-job";
        const status = this.element("p", describeJobProgress(job)); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
        card.append(this.element("h3", this.sourceName(job, state.sources)), status);
        if (job.area) card.append(this.element("p", describeClipArea(job.area)));
        if (job.status === "running" && job.progress.phase === "clipping" && job.progress.totalBlocks > 0) {
            const progress = this.element("progress", "");
            progress.max = job.progress.totalBlocks;
            progress.value = job.progress.completedBlocks ?? 0;
            progress.setAttribute("aria-label", "Source blocks clipped");
            card.append(progress);
        }
        if (job.error) card.append(this.element("p", `${job.error.detail} (${job.error.code})`));
        const details = this.element("details", "");
        const summary = this.element("summary", "Download details"); summary.setAttribute("data-download-action", `${job.jobId}-details`); details.append(summary);
        const identity = job.source ?? Object.values(job.sources ?? {})[0];
        if (identity) details.append(this.element("p", identity.kind === "runArtifact" ? `Model result: run ${identity.jobId}, file ${identity.artifactId}` : `Catalog source: ${identity.collectionId} / ${identity.itemId}`));
        if (job.grid) details.append(this.element("p", `${job.grid.width} × ${job.grid.height} pixels · ${describeClipCrs(job.grid.crs)}`),
            this.element("p", `COG · native resolution · ${formatDownloadBytes(job.grid.estimatedRawBytes)} estimated uncompressed`));
        const actions = this.element("div", ""); actions.className = "downloads-actions";
        if (job.result && job.status === "ready") {
            const expiry = this.element("time", new Date(job.expiresAt).toLocaleString()); expiry.setAttribute("datetime", job.expiresAt);
            const availability = this.element("p", `${formatDownloadBytes(job.result.bytes)} · Expires `); availability.append(expiry); card.append(availability);
            for (const [kind, label, url] of [["result", "Download GeoTIFF", job.result.url], ["provenance", "Download provenance", job.result.provenanceUrl]]) {
                const link = this.element("a", label);
                link.className = kind === "result" ? "primary-button" : "secondary-button";
                link.href = processingDownloadUrl(url, job.jobId, kind);
                link.setAttribute("download", "");
                link.setAttribute("data-download-action", `${job.jobId}-${kind}`);
                (kind === "result" ? actions : details).append(link);
            }
        }
        const active = ACTIVE_JOB_STATES.has(job.status);
        const action = active ? "cancel" : "delete";
        const button = this.element("button", active ? "Cancel download" : "Delete result");
        button.type = "button";
        button.className = "secondary-button";
        button.disabled = state.jobActions.has(job.jobId) || job.status === "cancelling";
        button.setAttribute("data-download-action", `${job.jobId}-${action}`);
        button.addEventListener("click", () => active ? this.handlers?.onCancel(job.jobId) : this.handlers?.onDelete(job.jobId));
        (active ? actions : details).append(button);
        card.append(actions, details);
        return card;
    }
}
