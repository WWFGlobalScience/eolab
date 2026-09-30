/** Raster clips own immutable submissions, recovery, and clip lifecycle presentation. */
import { normalizeRasterSamplingArea } from "../selected-area.js";
import { ProcessingRequestError } from "./api.js";

import { ProcessingJobs } from "./jobs.js";
export { ACTIVE_JOB_STATES } from "./jobs.js";

/** Copy catalog identity without retaining a mutable Item. @param {Object} source Catalog source plus label. @return {Readonly<Object>} Snapshot. */
function snapshotSource(source) {
    return Object.freeze({ collectionId: source.collectionId, itemId: source.itemId, label: source.label });
}

/** Omit whole-raster areas from the download contract. @param {Object|null} area Sampling selection. @return {Readonly<Object>|null} Explicit area. */
function explicitArea(area) {
    if (area === null || area === undefined || ["wholeRaster", "wholeOverlap"].includes(area.kind)) return null;
    return normalizeRasterSamplingArea(area);
}

/** Retain clip state and show it only while the raster clip tool is active. */
export class RasterClipsController {
    /**
     * @param {Object} dependencies Owned adapters and composition callbacks.
     * @param {Object} dependencies.api Processing API client.
     * @param {ProcessingJobs} [dependencies.jobs] Shared session polling/history.
     * @param {Object} dependencies.view Raster clip DOM adapter.
     * @param {Object} dependencies.storage Pending-submission storage.
     * @param {Function} dependencies.getContext Returns catalog sources and the presented area.
     * @param {Function} dependencies.onOpen Opens the dock's raster clip tool.
     * @param {Function} dependencies.onClose Closes that tool.
     * @param {Function} dependencies.onEditArea Opens existing sampling controls.
     * @param {Object} [dependencies.clock=globalThis] Timer provider.
     * @param {Function} [dependencies.requestId] Generates a unique idempotency key.
     */
    constructor({ api, jobs, view, storage, getContext, onOpen, onClose, onEditArea,
        clock = globalThis, requestId = () => globalThis.crypto.randomUUID() }) {
        Object.assign(this, { api, view, storage, getContext, onOpen, clock, requestId });
        this.state = { sources: [], source: null, area: null, selectedArea: null,
            areaChoice: "selection", jobs: [],
            message: "", jobMessage: "", pending: storage.read(),
            submitting: false, jobActions: new Set() };
        this.destroyed = false;
        this.active = false;
        this.ownsJobs = !jobs;
        this.jobs = jobs ?? new ProcessingJobs(api, clock);
        this.unsubscribe = this.jobs.subscribe(store => {
            this.state.jobs = store.jobs.filter(job => job.operation === "raster.clip.v1");
            this.state.jobMessage = store.error;
            this.render();
        });
        view.bind({
            onOpen: () => this.open(), onClose,
            onSource: (index) => this.selectSource(index),
            onArea: (choice) => this.selectArea(choice),
            onEditArea,
            onCreate: () => void this.submit(),
            onRetrySubmission: () => void this.submit(),
            onRefresh: () => void this.refresh(),
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
     * Capture current intent when explicitly opening Raster clips.
     * @param {Object|null} [source=null] Requested Catalog raster.
     * @param {Object|undefined} area Explicit entry-point selection; undefined uses presented selection.
     * @return {void}
     */
    open(source = null, area) {
        if (!this.state.pending && !this.state.submitting) {
            const context = this.getContext();
            this.state.message = "";
            this.state.sources = context.sources.map(snapshotSource);
            if (source && !this.state.sources.some(item => item.collectionId === source.collectionId && item.itemId === source.itemId)) {
                this.state.sources.unshift(snapshotSource(source));
            }
            this.state.source = source ? snapshotSource(source) : this.state.sources[0] ?? null;
            this.state.selectedArea = explicitArea(area === undefined ? context.area : area);
            this.state.area = this.state.selectedArea;
            this.state.areaChoice = "selection";
        }
        this.active = true;
        this.onOpen();
        this.render();
    }

    /** Select one offered catalog source. @param {number} index Source option index. @return {void} */
    selectSource(index) {
        if (this.state.pending || this.state.submitting) return;
        this.state.message = "";
        this.state.source = this.state.sources[index] ?? null;
        this.render();
    }

    /** Select the captured box or catalog-vector selection. @param {string} choice Area option. @return {void} */
    selectArea(choice) {
        if (this.state.pending || this.state.submitting) return;
        this.state.message = "";
        this.state.areaChoice = choice;
        this.state.area = choice === "selection" ? this.state.selectedArea
            : null;
        this.render();
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
            this.jobs.accept(job);
            this.storage.clear();
            this.state.pending = null;
            this.state.message = "Clip accepted. Its raster and area are fixed; you can keep exploring the map.";
        } catch (error) {
            // A definitive rejection creates no job. Server/transport failures can
            // occur after commit and must keep their original idempotency identity.
            if (error instanceof ProcessingRequestError && error.status >= 400 && error.status < 500 && error.status !== 408 && !error.isCapacityRejection) {
                this.storage.clear();
                this.state.pending = null;
                this.state.message = `${error.message} Create the clip again when the problem is resolved.`;
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
