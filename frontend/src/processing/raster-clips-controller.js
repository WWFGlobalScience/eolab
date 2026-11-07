/** Submit raster clips, recover pending requests and present download progress. */
import { labeledRasterSource, rasterSourceKey } from "../raster-source.js";
import { normalizeRasterSamplingArea } from "../selected-area.js";
import { ProcessingRequestError } from "./api.js";

import { ProcessingJobs } from "./jobs.js";
export { ACTIVE_JOB_STATES } from "./jobs.js";

/** Copy original raster identity and its label. @param {Object} source Labeled raster source. @return {Readonly<Object>} Snapshot. @throws {TypeError} If identity or label is invalid. */
function copyClipRasterSource(source) {
    return labeledRasterSource(source, source.label);
}

/** Validate a clip's rectangle, sampling box or original vector selection.
 * @param {Object|null|undefined} area Sampling selection.
 * @return {Readonly<Object>|null} Validated area, or null when no clipping area is selected.
 * @throws {TypeError|Error} If a selected rectangle or polygon reference is invalid.
 */
function normalizeClipArea(area) {
    if (area === null || area === undefined || ["wholeRaster", "wholeOverlap"].includes(area.kind)) return null;
    const selection = normalizeRasterSamplingArea(area);
    if (selection.kind === "polygonArea") {
        throw new TypeError("Choose a sampling box, Catalog layer or uploaded polygon layer to clip a raster.");
    }
    return selection;
}

/** Retain clip state and show it only while the raster clip tool is active. */
export class RasterClipsController {
    /** Connect clip controls to the Processing API, job history and map area callbacks.
     * @param {Object} dependencies API clients, view, request storage and map callbacks.
     * @param {import("./api.js").ProcessingApiClient} dependencies.api Processing API client.
     * @param {ProcessingJobs} [dependencies.jobs] Shared session polling/history.
     * @param {import("./raster-clips-view.js").RasterClipsView} dependencies.view Raster clip DOM adapter.
     * @param {import("./pending-submission.js").PendingSubmissionStorage} dependencies.storage Pending-submission storage.
     * @param {()=>{sources:Object[],area:Object|null}} dependencies.getContext Catalog sources and the presented area.
     * @param {((area:Object|null)=>Object[])|null} [dependencies.getQuerySources=null] Composed default candidates; explicit raster choices remain available.
     * @param {()=>void} dependencies.onOpen Opens the dock's raster clip tool.
     * @param {()=>void} dependencies.onClose Closes that tool.
     * @param {()=>void} dependencies.onEditArea Opens existing sampling controls.
     * @param {Object} [dependencies.clock=globalThis] Timer provider.
     * @param {()=>string} [dependencies.requestId] Generates a unique idempotency key.
     */
    constructor({ api, jobs, view, storage, getContext, getQuerySources = null, onOpen, onClose, onEditArea,
        clock = globalThis, requestId = () => globalThis.crypto.randomUUID() }) {
        Object.assign(this, { api, view, storage, getContext, getQuerySources, onOpen, onEditArea, clock, requestId });
        this.state = { sources: [], source: null, area: null, jobs: [], currentJobId: null, review: false,
            message: "", jobMessage: "", pending: storage.read(),
            submitting: false, jobActions: new Set() };
        this.destroyed = false;
        this.active = false;
        this.ownsJobs = !jobs;
        this.jobs = jobs ?? new ProcessingJobs(api, clock);
        this.unsubscribe = this.jobs.subscribe(store => {
            this.state.jobs = store.jobs.filter(job => job.operation === "raster.clip.v1");
            if (!this.state.jobs.some(job => job.jobId === this.state.currentJobId && job.status !== "deleted")) {
                this.state.currentJobId = this.state.jobs.find(job => job.status !== "deleted")?.jobId ?? null;
            }
            this.state.jobMessage = store.error;
            this.render();
        });
        view.bind({
            onOpen: () => this.open(), onClose,
            onSource: (index) => this.selectSource(index),
            onEditArea: () => this.editArea(),
            onNew: () => this.open(null, this.getContext().area ?? null),
            onShowJob: id => this.showJob(id),
            onCreate: () => void this.submit(),
            onRetrySubmission: () => void this.submit(),
            onCancel: (id) => void this.jobAction(id, "cancel"),
            onDelete: (id) => void this.jobAction(id, "delete"),
        });
        this.render();
    }

    /** Start session recovery without blocking the map. @return {Promise<void>} Initial refresh. */
    async start() {
        await this.refresh();
        if (this.state.pending) await this.submit();
    }

    /**
     * Review explicit entry-point inputs, or resume the current owned download.
     * Returning from area controls updates only unsubmitted intent. A pending
     * submission always retains its original inputs and request key.
     * @param {Object|null} [source=null] Requested Catalog raster.
     * @param {Object|null|undefined} [area] Explicit entry-point selection; undefined uses presented selection.
     * @return {void}
     * @throws {TypeError} If an explicit sampling descriptor violates the neutral area contract.
     */
    open(source = null, area) {
        if (!this.state.pending && !this.state.submitting) {
            const context = this.getContext();
            this.state.message = "";
            this.state.sources = context.sources.map(copyClipRasterSource);
            this.state.review = source !== null || area !== undefined || !!this.editingArea || !this.state.currentJobId;
            if (this.state.review) {
                this.state.area = normalizeClipArea(area === undefined ? context.area : area);
                const fixed = source ?? (this.editingArea && this.sourceWasChosen ? this.state.source : null);
                const chosen = fixed ?? (this.getQuerySources ? this.getQuerySources(this.state.area)[0] : this.state.sources[0]) ?? null;
                this.sourceWasChosen = !!fixed;
                if (chosen && !this.state.sources.some(item => rasterSourceKey(item) === rasterSourceKey(chosen))) {
                    this.state.sources.unshift(copyClipRasterSource(chosen));
                }
                this.state.source = chosen ? copyClipRasterSource(chosen) : null;
            }
        }
        this.editingArea = false;
        this.active = true;
        this.onOpen();
        this.render();
    }

    /** Select one offered catalog source. @param {number} index Source option index. @return {void} */
    selectSource(index) {
        if (this.state.pending || this.state.submitting) return;
        this.state.message = "";
        this.state.source = this.state.sources[index] ?? null;
        this.sourceWasChosen = this.state.source !== null;
        this.render();
    }

    /** Open composed sampling controls for unsubmitted intent only. @return {void} */
    editArea() {
        if (this.state.pending || this.state.submitting) return;
        this.editingArea = true;
        this.onEditArea();
    }

    /** Update the open clip form after a shared sampling-area edit.
     * Submitted jobs and uncertain submissions retain their original inputs.
     * @param {Readonly<Object>|null} area Validated, immutable map box or polygon selection; null clears it.
     * @return {void}
     */
    setSelection(area) {
        if (!this.active || !this.state.review || this.state.pending || this.state.submitting) return;
        this.state.area = area;
        this.render();
    }

    /** Inspect one owned download without changing submitted inputs or dispatching work.
     * @param {string} id Owned clip job selected from the current listing.
     * @return {void}
     */
    showJob(id) {
        if (this.state.pending || this.state.submitting || !this.state.jobs.some(job => job.jobId === id && job.status !== "deleted")) return;
        this.state.currentJobId = id;
        this.state.review = false;
        this.state.message = "";
        this.render();
        this.view.focusCurrent?.();
    }

    /** Submit once; persist and reuse the same key on uncertain responses or reload. @return {Promise<void>} Acceptance or recoverable error. */
    async submit() {
        if (this.state.submitting || this.destroyed) return;
        if (!this.state.pending) {
            if (!this.state.source || !this.state.area) return;
            const pending = { source: this.state.source, area: this.state.area,
                requestId: this.requestId(), label: this.state.source.label.slice(0, 512) };
            try { this.storage.write(pending); } catch (error) {
                this.state.message = `Cannot save download recovery information: ${error.message}`;
                this.render();
                return;
            }
            this.state.pending = pending;
        }
        this.state.submitting = true;
        this.state.message = "";
        this.render();
        try {
            const job = await this.api.submitClip(this.state.pending);
            this.state.currentJobId = job.jobId;
            this.state.review = false;
            this.jobs.accept(job);
            this.storage.clear();
            this.state.pending = null;
            this.state.message = "";
        } catch (error) {
            // A definitive rejection creates no job. Server/transport failures can
            // occur after commit and must keep their original idempotency identity.
            if (error instanceof ProcessingRequestError && error.status >= 400 && error.status < 500 && error.status !== 408 && !error.isCapacityRejection) {
                this.storage.clear();
                this.state.pending = null;
                this.state.message = `${error.message} Prepare the download again when the problem is resolved.`;
            } else {
                this.state.message = `Submission not confirmed: ${error.message} Retry the same request to recover it safely.`;
            }
        } finally {
            this.state.submitting = false;
            this.render();
            this.scheduleRefresh();
        }
    }

    /** Refresh owned history with a single in-flight poll. @return {Promise<void>} Current listing. */
    refresh() {
        return this.jobs.refresh();
    }

    /** Poll active work promptly and retained result expiration less often. @return {void} */
    scheduleRefresh() {
        this.jobs.schedule();
    }

    /** Perform one lifecycle action while preventing duplicate button dispatch. @param {string} id Job identity. @param {"cancel"|"delete"} action Intent. @return {Promise<void>} Action and refresh completion. */
    async jobAction(id, action) {
        if (this.state.jobActions.has(id)) return;
        this.state.jobActions.add(id);
        this.render();
        try {
            await this.jobs.action(id, action);
        } catch (error) { this.state.jobMessage = error.message; }
        finally { this.state.jobActions.delete(id); this.render(); }
    }

    /**
     * Show the latest retained clip state when the dock activates this tool.
     * Closing it leaves accepted jobs and uncertain-submission recovery intact.
     * @param {boolean} active Whether the raster clip tool is visible.
     * @return {void}
     */
    setActive(active) {
        if (this.active === active) return;
        this.active = active;
        this.render();
    }

    /** Draw clip controls only while their tool is visible. @return {void} */
    render() { if (!this.destroyed && this.active) this.view.render(this.state); }

    /** Release browser work without cancelling accepted server jobs. @return {void} */
    destroy() {
        this.destroyed = true;
        this.state.message = "";
        this.unsubscribe();
        if (this.ownsJobs) this.jobs.destroy();
        this.view.unbind();
    }
}
