/** Keep opt-in output displays tied to their originating run and file lifetime. */
import { readArtifactPreview } from "./api.js";
import { describeRasterSource } from "../raster/source-api.js";
import { normalizeVectorStyle, vectorStyleLegend } from "../vector/style.js";

/** Output formats displayed through ordinary raster rendering or GeoJSON previews.
 * @type {Set<string>}
 */
const MAP_OUTPUT_MEDIA_TYPES = new Set(["image/tiff", "application/geo+json"]);

/** Return a result's default map-view key, also used for its file-level messages.
 * @param {string} jobId Run identity. @param {string} artifactId File identity.
 * @return {string} Local map identity, independent of catalog keys.
 */
export function artifactLayerKey(jobId, artifactId) { return `local:artifact:${jobId}:${artifactId}`; }

/** Choose the standard solid symbol for a vector result preview.
 * @param {Object} data Checked display data.
 * @return {Object} Normalized solid vector appearance.
 */
function initialAppearance(data) {
    return normalizeVectorStyle({geometryKind: data.geometryKind, fillColor: data.geometryKind === "line" ? null : "#3388ff",
        fillOpacity: data.geometryKind === "line" ? null : 0.35, strokeColor: "#0066aa", strokeOpacity: 1, strokeWidth: 2, pointSize: data.geometryKind === "point" ? 8 : null,
        label: null, categorical: null, graduated: null});
}

/** Keep private result layers tied to their originating run and file lifetime. */
export class ModelOutputLayers {
    /** Connect authorized transport and explicit map presentation callbacks.
     * @param {Object} dependencies Composition-supplied interfaces.
     * @param {Object} dependencies.api Processing status API.
     * @param {(source:Object,adapter:Object)=>void} dependencies.addLayer Attach a local display through the map owner.
     * @param {(key:string,presentation:Object)=>void} dependencies.updateLayer Update generated names through the map owner, preserving custom names.
     * @param {(key:string)=>void} dependencies.removeLayer Remove a displayed layer only.
     * @param {()=>void} dependencies.refreshLayers Refresh neutral layer presentations.
     * @param {(key:string,data:Object,appearance:Object)=>Object} dependencies.createLayer Create a Leaflet-compatible display.
     * @param {(jobId:string)=>void} dependencies.openRun Open the originating run's details.
     * @param {()=>void} dependencies.onChange Refresh output buttons and the private-map notice.
     * @param {(job:Object)=>void} [dependencies.onRunObserved] Share revalidated run state through composition.
     * @param {(raster:Object,lifecycle:Object,presentation:Object)=>Promise<Object|null>} dependencies.addRaster Attach through the common raster owner.
     * @param {Function} [dependencies.describe=describeRasterSource] Original-source metadata reader.
     * @param {(jobId:string,file:Object,signal:AbortSignal)=>Promise<Object>} [dependencies.read=readArtifactPreview] Bounded GeoJSON preview reader.
     * @param {Object} [dependencies.clock=globalThis] Timer and wall-clock provider.
     */
    constructor({api, addLayer, updateLayer, removeLayer, refreshLayers, createLayer, openRun, onChange, addRaster, onRunObserved = () => {}, describe = describeRasterSource, read = readArtifactPreview, clock = globalThis}) {
        Object.assign(this, {api, addLayer, updateLayer, removeLayer, refreshLayers, createLayer, openRun, onChange, addRaster, onRunObserved, describe, read, clock});
        this.layers = new Map(); this.pending = new Map(); this.messages = new Map(); this.timer = null; this.expiryTimer = null; this.destroyed = false;
        this.runStates = new Map();
    }

    /** Describe whether any view of a file is displayed or being added.
     * @param {string} jobId Run identity. @param {string} artifactId File identity.
     * @param {Object} file Validated file format and role.
     * @return {{canShow:boolean,onMap:boolean,busy:boolean,error:string}} Presentation-only status.
     */
    state(jobId, artifactId, file) {
        const key = artifactLayerKey(jobId, artifactId);
        return {canShow: MAP_OUTPUT_MEDIA_TYPES.has(file.mediaType) && file.role !== "provenance",
            onMap: [...this.layers.values()].some(state => state.jobId === jobId && state.file.artifactId === artifactId),
            busy: [...this.pending.values()].some(state => state.jobId === jobId && state.artifactId === artifactId),
            error: this.messages.get(key) ?? ""};
    }

    /** Identify private result views, including attachment still in progress, for saved-map exclusion.
     * @param {string} key Map view identity. @return {boolean} Whether this owner retains or is adding the view.
     */
    ownsLayer(key) { return this.layers.has(key) || this.pending.has(key); }

    /** Read an output's latest generated name and run group for map presentation.
     * @param {string} jobId Known owning run identity.
     * @param {Object} file Original artifact identity and scientific label.
     * @return {{label:string,sourceName:string,group:Object}} Names from the latest accepted run snapshot.
     */
    outputPresentation(jobId, file) {
        const job = this.runStates.get(jobId);
        const latestFile = job.artifacts?.files.find(value => value.artifactId === file.artifactId) ?? file;
        const label = latestFile.displayName ?? `${latestFile.label} · ${job.label}`;
        return {label, sourceName: label, group: {id: jobId, label: job.label, actionLabel: "Delete run and results"}};
    }

    /** Explicitly load a file, then attach it only if its run is still available.
     * Run-name changes during raster publication are applied through the map owner
     * after attachment completes.
     * @param {Object} job Validated owning run snapshot.
     * @param {Object} file Validated manifest file.
     * @param {Object} [restore] Optional Undo or additional-view identity and presentation.
     * @param {()=>boolean} [isCurrent] Whether the restored or additional view is still wanted.
     * @return {Promise<void>} Completion after attachment or visible failure.
     * @throws {Error} On failure during restoration, allowing the shared map action to report it.
     */
    async show(job, file, restore = null, isCurrent = () => true) {
        const sourceKey = artifactLayerKey(job.jobId, file.artifactId);
        const key = restore?.key ?? sourceKey;
        if (this.ownsLayer(key)) return;
        const display = this.state(job.jobId, file.artifactId, file);
        if (!restore && (display.onMap || display.busy)) return;
        this.updateRun(job);
        job = this.runStates.get(job.jobId);
        const abort = new AbortController();
        this.pending.set(key, {abort, jobId: job.jobId, artifactId: file.artifactId});
        this.messages.delete(sourceKey); this.onChange();
        let layer;
        try {
            if (this.layers.size + this.pending.size > 8) throw new Error("Remove a result layer before adding another. Up to eight results can be on the map at once.");
            if (!MAP_OUTPUT_MEDIA_TYPES.has(file.mediaType) || job.status !== "ready" || Date.parse(job.expiresAt) <= Date.now()) {
                throw new Error("This result is no longer available. Run the tool again.");
            }
            if (file.mediaType === "image/tiff") {
                const source = {kind: "runArtifact", jobId: job.jobId, artifactId: file.artifactId};
                const metadata = await this.describe(source, abort.signal);
                if (this.destroyed || abort.signal.aborted || !isCurrent()) return;
                if (metadata.version !== file.sha256) throw new Error("This raster result changed. Reopen the run and try again.");
                if (Date.parse(this.runStates.get(job.jobId).expiresAt) <= Date.now()) throw new Error("This raster result expired. Run the tool again.");
                const bbox = metadata.bounds;
                if (!bbox) throw new Error("This raster cannot be placed on the map. Download it or choose it directly as a tool input.");
                if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error("This raster crosses unsupported map bounds.");
                const presentation = this.outputPresentation(job.jobId, file);
                const retained = await this.addRaster({source, version: metadata.version, bbox, ...presentation,
                    capabilities: {pixels: metadata.capabilities.pixels.supported, statistics: metadata.capabilities.statistics.supported,
                        calculations: true, modelInput: true}}, {
                    /** Reopen the source run without putting private identity into a catalog item. @return {void} */
                    info: () => this.openRun(job.jobId),
                    /** Copy source identity and appearance for Undo or another authorized view.
                     * @param {Object} appearance Shared raster appearance. @return {Object} Restoration data.
                     */
                    copy: appearance => ({kind: "model-output-preview", jobId: job.jobId, artifactId: file.artifactId, appearance}),
                    /** Release display membership only; accepted calculations retain their own inputs. @return {void} */
                    removed: () => { this.layers.delete(key); this.schedule(); this.onChange(); },
                }, {...presentation, key, canAddView: true, visible: restore?.visible ?? true, opacity: restore?.opacity ?? 1, appearance: restore?.local.appearance, signal: abort.signal,
                    customName: restore?.customName ?? null,
                    isCurrent: () => !this.destroyed && !abort.signal.aborted && isCurrent() &&
                        this.runStates.get(job.jobId)?.status === "ready" && Date.parse(this.runStates.get(job.jobId).expiresAt) > Date.now()});
                if (retained !== null && !abort.signal.aborted) {
                    const latest = this.runStates.get(job.jobId);
                    this.layers.set(key, {key, jobId: job.jobId, runName: latest.label,
                        file: latest.artifacts.files.find(value => value.artifactId === file.artifactId) ?? file, expiresAt: latest.expiresAt, kind: "raster"});
                    const current = this.outputPresentation(job.jobId, file);
                    if (current.label !== presentation.label || current.group.label !== presentation.group.label) this.updateLayer(key, current);
                }
                this.schedule(); return;
            }
            const data = await this.read(job.jobId, file, abort.signal);
            if (this.destroyed || abort.signal.aborted || !isCurrent()) return;
            if (Date.parse(this.runStates.get(job.jobId).expiresAt) <= Date.now()) throw new Error("This result expired while its preview was loading.");
            const latest = this.runStates.get(job.jobId);
            const state = {key, jobId: job.jobId, runName: latest.label,
                file: latest.artifacts.files.find(value => value.artifactId === file.artifactId) ?? file, expiresAt: latest.expiresAt, kind: data.kind,
                appearance: restore?.local.appearance ?? initialAppearance(data)};
            state.initial = initialAppearance(data);
            state.appearance = this.normalizeAppearance(state, state.appearance);
            layer = this.createLayer(key, data, state.appearance); state.layer = layer;
            this.layers.set(key, state);
            this.addLayer({key, ...this.outputPresentation(job.jobId, file), customName: restore?.customName ?? null,
                visible: restore?.visible ?? true, opacity: restore?.opacity ?? 1}, this.adapter(state));
            this.schedule();
        } catch (error) {
            this.layers.delete(key); layer?.release();
            this.messages.set(sourceKey, error.message);
            if (restore) throw error;
        } finally { this.pending.delete(key); this.onChange(); }
    }

    /** Check copied or restored styles against this preview's supported appearance.
     * @param {Object} state Preview identity and kind.
     * @param {Object} candidate Candidate appearance contract.
     * @return {Object} Normalized compatible appearance.
     * @throws {Error} If type, symbol kind or unsupported field-based vector styling differs.
     */
    normalizeAppearance(state, candidate) {
        if (candidate.kind && candidate.kind !== "vector") throw new Error("Choose a vector style for this result.");
        const style = normalizeVectorStyle(candidate.definition ?? candidate);
        if (style.geometryKind !== state.initial.geometryKind || style.categorical || style.graduated || style.label) {
            throw new Error("Result previews support solid styles for the same geometry type.");
        }
        return style;
    }

    /** Commit an appearance and update the display and legend together.
     * @param {string} key Local preview identity. @param {Object} appearance Candidate existing style contract.
     * @return {Object} Committed normalized style.
     * @throws {Error} If the layer expired or the style is incompatible.
     */
    applyAppearance(key, appearance) {
        const state = this.layers.get(key); if (!state) throw new Error("This result is no longer on the map.");
        state.appearance = this.normalizeAppearance(state, appearance); state.layer.setAppearance(state.appearance);
        this.refreshLayers(); return state.appearance;
    }

    /** Supply the existing local-layer protocol without exposing display data to analysis.
     * @param {Object} state Private preview state owned by this component.
     * @return {Object} Map-layer adapter with style, legend and display-only lifecycle hooks.
     */
    adapter(state) {
        return {
            /** Supply the owner's state for this local layer. @return {Object} Preview state. */
            createState: () => state,
            /** Supply the owner's constructed display. @return {Object} Leaflet layer. */
            createLayer: () => state.layer,
            /** Describe this result without a catalog identity. @return {Object} Neutral layer presentation. */
            snapshot: () => ({datasetKind: state.kind, group: {id: state.jobId, label: state.runName, actionLabel: "Delete run and results"}, legend: this.legend(state)}),
            /** Fit the map to this preview. @return {void} */
            zoom: () => state.layer.zoom(),
            /** Reopen the originating run. @return {void} */
            info: () => this.openRun(state.jobId),
            /** Copy appearance without exporting a private source. @return {Object} Existing clipboard contract. */
            exportSavedState: () => ({kind: "vector", definition: state.appearance}),
            /** Check clipboard compatibility before offering Paste.
             * @param {Object} _record Neutral layer record. @param {Object} candidate Copied style.
             * @return {string|null} Explanation or null when compatible.
             */
            checkSavedStateCompatibility: (_record, candidate) => { try { this.normalizeAppearance(state, candidate); return null; } catch (error) { return error.message; } },
            /** Apply a checked clipboard style to this display.
             * @param {Object} _record Neutral layer record. @param {Object} candidate Copied style.
             * @return {Object} Committed appearance. @throws {Error} If incompatible or unavailable.
             */
            applySavedState: (_record, candidate) => this.applyAppearance(state.key, candidate),
            /** Keep identities and appearance for a fresh authorized Undo. @return {Object} No display bytes or credentials. */
            copyLayerForUndo: () => ({kind: "model-output-preview", jobId: state.jobId, artifactId: state.file.artifactId,
                appearance: structuredClone(state.appearance)}),
            /** Release display memory after its map layer is detached. @return {void} */
            removed: () => { state.layer.release(); this.layers.delete(state.key); this.schedule(); this.onChange(); },
        };
    }

    /** Project the vector preview appearance into the existing map legend contract.
     * @param {Object} state Preview state.
     * @return {Object} Neutral legend presentation.
     */
    legend(state) {
        return vectorStyleLegend(state.appearance);
    }

    /** Reauthorize an Undo or additional view from the server, preserving its copied presentation.
     * @param {Object} snapshot Shared map-view identity and copied presentation.
     * @param {()=>boolean} isCurrent Whether the map action is still current.
     * @return {Promise<void>} Completion after a fresh authorized preview.
     * @throws {Error} If the run or file is unavailable.
     */
    async restore(snapshot, isCurrent) {
        const job = await this.api.getJob(snapshot.local.jobId);
        const file = job.artifacts?.files.find(value => value.artifactId === snapshot.local.artifactId);
        if (!file) throw new Error("This result is no longer available. Run the tool again.");
        if (isCurrent()) await this.show(job, file, snapshot, isCurrent);
    }

    /** Apply authoritative run names, expiry or deletion through composition or status reads.
     * Only a newer authoritative response can restore a deleted run after Undo.
     * @param {Object} job Owned run snapshot from the Processing API.
     * @return {void}
     */
    updateRun(job) {
        const previous = this.runStates.get(job.jobId);
        if (previous && (previous.updatedAt > job.updatedAt || previous.status === "deleted" && job.status !== "deleted" && previous.updatedAt === job.updatedAt)) return;
        this.runStates.set(job.jobId, job);
        let changed = false;
        const available = job.status === "ready" && Date.parse(job.expiresAt) > Date.now();
        for (const pending of this.pending.values()) {
            if (pending.jobId === job.jobId && (!available || !job.artifacts.files.some(file => file.artifactId === pending.artifactId))) pending.abort.abort();
        }
        for (const state of [...this.layers.values()]) {
            if (state.jobId !== job.jobId) continue;
            const file = job.artifacts?.files.find(value => value.artifactId === state.file.artifactId);
            if (available && file?.sha256 === state.file.sha256) {
                if (state.expiresAt !== job.expiresAt) { state.expiresAt = job.expiresAt; changed = true; }
                if (state.runName !== job.label || state.file.displayName !== file.displayName) {
                    state.runName = job.label; state.file = file;
                    this.updateLayer(state.key, this.outputPresentation(job.jobId, file));
                    changed = true;
                }
            }
            else {
                this.messages.set(artifactLayerKey(state.jobId, state.file.artifactId), "Map layer removed because the result is no longer available. Reopen the run to check it.");
                this.removeLayer(state.key);
                changed = true;
            }
        }
        if (changed) { this.schedule(); this.onChange(); }
    }

    /** Schedule expiry and bounded status revalidation even when Models is closed.
     * @return {void}
     */
    schedule() {
        this.clock.clearTimeout(this.timer);
        this.clock.clearTimeout(this.expiryTimer);
        if (!this.layers.size || this.destroyed) return;
        const expires = Math.min(...[...this.layers.values()].map(state => Date.parse(state.expiresAt)));
        this.timer = this.clock.setTimeout(() => void this.refreshAvailability(), 30000);
        this.expiryTimer = this.clock.setTimeout(() => void this.refreshAvailability(), Math.max(0, Math.min(2147483647, expires - Date.now())));
    }

    /** Remove expired, deleted or inaccessible previews; failed revalidation fails closed.
     * @return {Promise<void>} Completion after one batched authoritative status request.
     */
    async refreshAvailability() {
        const captured = [...this.layers.values()];
        const revisions = new Map(captured.map(state => [state.key, this.runStates.get(state.jobId)?.updatedAt]));
        if (!captured.length) { this.schedule(); this.onChange(); return; }
        let jobs = [];
        try { ({jobs} = await this.api.readJobStatuses([...new Set(captured.map(state => state.jobId))], AbortSignal.timeout(15000))); }
        catch { /* A stale display must not survive loss of ownership or status access. */ }
        if (this.destroyed) return;
        for (const job of jobs) {
            this.updateRun(job);
            this.onRunObserved(this.runStates.get(job.jobId));
        }
        for (const state of captured) {
            if (this.layers.get(state.key) !== state) continue;
            if (jobs.some(value => value.jobId === state.jobId)) continue;
            if (this.runStates.get(state.jobId)?.updatedAt !== revisions.get(state.key)) continue;
            this.messages.set(artifactLayerKey(state.jobId, state.file.artifactId), Date.parse(state.expiresAt) <= Date.now()
                ? "This result expired and its map layer was removed. Run the tool again."
                : "Map layer removed because the result is no longer available. Reopen the run to check it.");
            this.removeLayer(state.key);
        }
        this.schedule(); this.onChange();
    }

    /** Cancel pending reads and release every display when the application closes.
     * @return {void}
     */
    destroy() {
        this.destroyed = true; this.clock.clearTimeout(this.timer); this.clock.clearTimeout(this.expiryTimer);
        for (const {abort} of this.pending.values()) abort.abort();
        for (const key of this.layers.keys()) this.removeLayer(key);
    }
}
