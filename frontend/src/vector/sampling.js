/** Select filtered polygons as an analysis area and track changes to that selection. */
import { validateVectorSelection } from "../selected-area.js";
import { EMPTY_VECTOR_FILTER, vectorFilterSummary } from "./filter.js";

/** Identify calculation inputs, excluding presentation-only annotation edits.
 * @param {Object|undefined} target Layer snapshot supplied by composition.
 * @return {string} Stable identity for detecting a changed or removed selection.
 */
const samplingTargetIdentity = target => target ? JSON.stringify([target.key, target.filter,
    target.selectionIdentity ? target.selectionIdentity(target.filter ?? EMPTY_VECTOR_FILTER) : target.item]) : "";

/** Prepare and follow a polygon layer's accepted filter as the sampling area. */
export class VectorSamplingController {
    /**
     * Connect polygon-layer choices to preparation and area adoption.
     * Initial target discovery does not read polygons or activate an area.
     *
     * @param {Object} dependencies Views, targets, selection transport and composed callbacks.
     * @param {(area:Object)=>void} [dependencies.releaseArea] Release obsolete uploaded inputs.
     * @param {Object|Object[]} dependencies.view One or more synchronized selection views.
     * @param {()=>Object[]} dependencies.getTargets Committed, independent layer snapshots with their display labels.
     * @param {(item:Object|null,filter:Object,signal:AbortSignal,target:Object)=>Promise<Object>} dependencies.createArea Prepare exact polygons from the source and accepted filter.
     * @param {(area:Object)=>void} dependencies.onActivate Adopt prepared polygons using the consumer's calculation policy.
     * @param {(selection:Object|undefined,area:Object)=>void} dependencies.onInvalidate Cancel work using an obsolete area.
     * @param {(key:string)=>void} dependencies.onEditFilter Open the selected layer's filter controls.
     * @param {(state:{phase:string,message:string,explicit:boolean,sequence:number})=>void} [dependencies.onSelectionState] Report progress, user intent and the existing cancellation sequence. Repeated renders retain that sequence; automatic refreshes are passive and choices, retries and explicit clearing are user intent.
     */
    constructor({ view, getTargets, createArea, onActivate, onInvalidate, onEditFilter, onSelectionState = () => {}, releaseArea = () => {} }) {
        Object.assign(this, { view, getTargets, createArea, onActivate, onInvalidate, onEditFilter });
        this.onSelectionState = onSelectionState;
        this.releaseArea = releaseArea;
        this.views = Array.isArray(view) ? view : [view];
        this.sequence = 0;
        this.explicitSelection = false;
        this.state = { targets: [], key: "", phase: "idle", area: null, message: "Choose a polygon layer." };
        this.views.forEach(target => target.bind({ onLayer: key => void this.choose(key), onRetry: () => void this.use(),
            onRemove: () => void this.choose(""),
            onFilter: () => this.onEditFilter(this.state.key) }));
        this.refresh();
    }
    /** Follow changed inputs only after the user has selected a vector area.
     * Populating the choices never prepares an area. Removing the requested
     * source clears it instead of adopting another layer.
     * @return {void}
     */
    refresh() {
        const targets = this.getTargets();
        const next = targets.find(target => target.key === this.state.key);
        const changed = this.sourceIdentity && this.sourceIdentity !== samplingTargetIdentity(next);
        this.state.targets = targets;
        if (changed) {
            if (next) void this.use({ key: next.key, explicit: false });
            else {
                this.state.key = "";
                this.invalidate("The selected polygon layer was removed.");
            }
        } else {
            if (!next) this.state.key = targets[0]?.key ?? "";
            this.render();
        }
    }
    /** Prepare the chosen layer's current filter, or clear an empty choice.
     * @param {string} key Retained polygon-layer key, or an empty string to clear.
     * @return {Promise<Object|null>} Adopted area, or null after clearing, failure or cancellation.
     */
    choose(key) {
        return this.use({ key });
    }

    /** Read the requested layer before its polygon preparation completes.
     * @return {Object|undefined} The selected target, or undefined if none is available.
     */
    getSelectedTarget() {
        return this.state.targets.find(target => target.key === this.state.key);
    }
    /**
     * Request the selected layer's filtered polygons, one request at a time.
     * A newer selection cancels the older request and discards its response.
     * @param {Object} [options={}] Explicit source choice.
     * @param {string} [options.key=this.state.key] Retained polygon-layer key.
     * @param {boolean} [options.explicit=true] A user chose or retried this area; false follows an accepted source/filter refresh.
     * @return {Promise<Object|null>} Adopted polygon area with the chosen layer's display label,
     * or null if no source, failed or superseded. Actual read failures remain visible in the controls.
     */
    async use({ key = this.state.key, explicit = true } = {}) {
        this.state.key = key;
        const target = this.getSelectedTarget();
        this.invalidate("");
        this.explicitSelection = explicit;
        if (!target) {
            this.state.message = "Choose a polygon layer.";
            this.render();
            return null;
        }
        const sequence = this.sequence;
        this.abort = new AbortController();
        const signal = this.abort.signal;
        const candidate = structuredClone(target.filter ?? EMPTY_VECTOR_FILTER);
        this.sourceIdentity = samplingTargetIdentity(target);
        this.state.phase = "reading"; this.state.message = "Reading filtered polygons…"; this.render();
        try {
            // Abort obsolete transport, then let its bounded read settle before
            // starting the next request. Release uploaded inputs from obsolete replies.
            await this.reading;
            if (sequence !== this.sequence) return null;
            const read = this.createArea(target.item, candidate, signal, target);
            this.reading = read.catch(() => {});
            const area = await read;
            if (sequence !== this.sequence) { this.releaseArea(area); return null; }
            area.label = target.label;
            this.state.area = area;
            this.state.phase = "active";
            this.state.message = `Sampling ${area.matched.toLocaleString()} of ${area.total.toLocaleString()} features.`;
            this.onActivate(area);
            this.render();
            return area;
        } catch (error) {
            if (sequence !== this.sequence) return null;
            this.state.phase = "error"; this.state.message = error.message; this.render();
            return null;
        }
    }
    /** Stop following the selected source, cancel reads and release its prepared area.
     * @param {string} message Visible explanation for invalidating the retained selection.
     * @return {void}
     */
    invalidate(message) {
        ++this.sequence;
        this.explicitSelection = false;
        this.abort?.abort();
        const area = this.state.area;
        this.state.area = null; this.state.phase = "idle"; this.state.message = message; this.sourceIdentity = null;
        if (area) { this.onInvalidate(area.selection, area); this.releaseArea(area); }
        this.render();
    }
    /** Render the source view's committed predicate and selection progress. @return {void} */
    render() {
        const target = this.getSelectedTarget();
        const state = { ...this.state, filterSummary: vectorFilterSummary(target?.filter ?? EMPTY_VECTOR_FILTER) };
        this.views.forEach(view => view.render(state));
        this.onSelectionState({ phase: state.phase, message: state.message, explicit: this.explicitSelection, sequence: this.sequence });
    }
    /** Cancel reading, release the prepared area and detach the controls. @return {void} */
    destroy() { this.invalidate(""); this.views.forEach(view => view.unbind()); }
}

/**
 * Select filtered polygons from a catalog layer or this browser's uploaded GeoPackage.
 * @param {{collectionId:string,itemId:string}|{uploadId:string}} source Public source identity, optionally with UI metadata.
 * @param {Object} filter Applied filter.
 * @param {AbortSignal} signal Native read cancellation.
 * @return {Promise<Object>} Immutable selection descriptor and exact feature counts.
 * @throws {Error} If selection fails or the response violates the selection contract.
 */
export async function createVectorSamplingArea(source, filter, signal) {
    const identity = source.uploadId ? { uploadId: source.uploadId } : { collectionId: source.collectionId, itemId: source.itemId };
    const response = await fetch("/api/vector-sampling/areas", { method: "POST", signal,
        headers: { "Content-Type": "application/json", ...(source.uploadId ? { "X-EOLab-Uploads": "1" } : {}) },
        credentials: "same-origin", cache: "no-store",
        body: JSON.stringify({ ...identity, filter }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.detail ?? "Could not select these features");
    value.selection = validateVectorSelection(value.selection);
    if (!Number.isSafeInteger(value.matched) || value.matched < 1 || !Number.isSafeInteger(value.total) || value.total < value.matched)
        throw new Error("Invalid vector sampling response");
    return value;
}
