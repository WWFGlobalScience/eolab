/** Own model setup and run navigation while accepted work remains on the server. */
import { ACTIVE_JOB_STATES } from "../processing/jobs.js";
import { ProcessingRequestError } from "../processing/api.js";
import { createModelDraft, captureModelSubmission, modelSourceKey, modelAreaInput, modelViewportArea, modelResultSources, getModelRasterFields, getRasterPreparationSources, getHabitatEarthEngineInput } from "./inputs.js";
import { getTemporalStatistics } from "./temporal-inputs.js";
import { snapTemporalHour, getTemporalMonthBoundaries } from "../temporal-period.js";

const RECOVERY_KEY = "eolab.models.pending.v1";
const DELETIONS_KEY = "eolab.models.deletions.v1";

/** Keep editable model drafts separate from accepted, session-owned runs. */
export class ModelsController {
    /** Connect the Models view to API transport and composed catalog inputs.
     * @param {Object} dependencies Component dependencies.
     * @param {Object} dependencies.api Processing API client.
     * @param {Object} dependencies.jobs Existing shared Processing job observer.
     * @param {Object} dependencies.view Models view.
     * @param {()=>Object} dependencies.getContext Catalog/map suggestions and plain viewport bounds, independent of rendering.
     * @param {(identity:{collectionId:string,itemId:string})=>Promise<Object>} dependencies.getTemporalItem Read the selected dataset's current Catalog metadata.
     * @param {(source:Object,signal:AbortSignal,targetCrs?:string|null)=>Promise<Object>} dependencies.describeSource Read source grid metadata in the chosen CRS.
     * @param {(item:Object,variable:string,month?:string,signal?:AbortSignal)=>Promise<Object>} dependencies.loadTemporalTimes Read actual observation labels for one month.
     * @param {(source:Object,signal:AbortSignal)=>Promise<Object>} dependencies.prepareVector Read a captured vector predicate and counts.
     * @param {(request:{key:string,host:HTMLElement,source:Object,filter:Object,isCurrent:()=>boolean,apply:(filter:Object)=>Promise<Object|null>,complete:()=>void,cancel:()=>void,close:()=>void})=>Promise<void>|void} dependencies.editVectorFilter Open the composed filter editor inside model setup.
     * @param {()=>void} dependencies.closeVectorFilter Close the composed inline editor.
     * @param {(source:Object,area:Object)=>Promise<Object|null>} dependencies.applyMapFilter Commit checked features to their vector view before updating its rendering; display failure must not block analysis.
     * @param {Storage|null} [dependencies.storage=null] Per-tab submission recovery storage.
     * @param {()=>void} dependencies.onOpen Open the composed Analysis panel.
     * @param {()=>void} dependencies.onClose Hide the panel without cancelling jobs.
     * @param {(job:Object,file:Object)=>Promise<void>} [dependencies.showOutput] Show one chosen file through composition.
     * @param {(jobId:string,artifactId:string,file:Object)=>Object} [dependencies.outputState] Display-only map capability, inclusion and feedback.
     * @param {(job:Object)=>void} [dependencies.onRunChange] Notify composition of authoritative run availability and expiry.
     * @param {(jobId:string)=>Object[]} [dependencies.captureRunLayers] Capture display state through composition before deletion.
     * @param {(layers:Object[],isCurrent:()=>boolean)=>Promise<void>} [dependencies.restoreRunLayers] Restore captured displays through their existing owners.
     * @param {Object} [dependencies.clock=globalThis] Timeout scheduler for deletion notices.
     * @param {()=>string} [dependencies.newId] Generate draft and request identities.
     */
    constructor({api, jobs, view, getContext, getTemporalItem, loadTemporalTimes, describeSource, prepareVector, editVectorFilter, closeVectorFilter, applyMapFilter, storage = null, onOpen, onClose,
        showOutput = async () => {}, outputState = () => ({}), onRunChange = () => {},
        captureRunLayers = () => [], restoreRunLayers = async () => {}, clock = globalThis,
        newId = () => globalThis.crypto.randomUUID().replaceAll("-", "")}) {
        Object.assign(this, {api, jobs, view, getContext, prepareVector, editVectorFilter, closeVectorFilter, applyMapFilter, storage, onOpen, onClose, newId});
        Object.assign(this, {getTemporalItem, loadTemporalTimes});
        this.describeSource = describeSource;
        this.outputState = outputState;
        this.onRunChange = onRunChange;
        Object.assign(this, {captureRunLayers, restoreRunLayers, clock});
        this.deletions = new Map();
        this.state = {page: "library", active: false, library: [], loading: false, error: "", query: "", draft: null,
            runs: [], nextCursor: null, historyLoading: false, selectedRun: null, invocation: null, invocationError: "", yaml: null,
            pending: null, submitting: false, actionBusy: false, renamingRun: null, deleteConfirmation: null, actionMessage: ""};
        this.runSnapshots = new Map(); this.revision = 0; this.historyRevision = 0; this.temporalRevision = 0;
        this.vectorSelectionRequests = new Map();
        this.tracked = new Set(); this.destroyed = false;
        this.unsubscribe = jobs.subscribe(() => this.observeJobs());
        view.bind({onOpen: () => this.open(), onClose, onPage: page => this.navigate(page),
            onQuery: query => { this.state.query = query; this.render(); }, onChoose: model => this.chooseModel(model),
            onEdit: change => this.editDraft(change), onInput: (name, change) => this.editInput(name, change),
            onRefreshGrid: () => this.refreshRasterPreparation(true),
            onRefreshHabitat: name => void this.loadHabitatOptions(this.state.draft, name),
            onArea: (name, mode) => this.chooseArea(name, mode),
            onTemporalDataset: key => void this.chooseTemporalDataset(key),
            onTemporalVariable: variable => void this.chooseTemporalVariable(variable),
            onTemporalMonth: month => void this.loadTemporalDates(month),
            onRefreshTemporal: () => void this.loadTemporalDates(undefined, true),
            onUseTemporalMonth: () => this.useTemporalMonth(),
            onTemporalEdit: change => {
                Object.assign(this.state.draft.temporal, change); this.editDraft({});
            },
            onVector: (name, key) => void this.chooseVector(name, key), onEditFilter: name => void this.openVectorFilter(name),
            onSubmit: () => void this.submit(), onRetry: () => void this.submit(true), onRefresh: () => void this.loadLibrary(),
            onRefreshRuns: () => void this.loadRuns(), onMore: () => void this.loadRuns(true), onRun: id => void this.showRun(id),
            onCancel: () => void this.cancelRun(), onDuplicate: () => void this.duplicateRun(), onYaml: () => void this.showYaml(),
            onRename: label => this.renameRun(label),
            onRenew: () => void this.renewRun(), onDelete: () => this.requestRunDeletion(), onConfirmDelete: () => void this.deleteRun(),
            onUndoDelete: id => void this.resolveDeletion(id, true), onDismissDelete: id => void this.resolveDeletion(id, false),
            onKeepRun: () => { this.state.deleteConfirmation = null; this.render(); this.view.focusRunDelete?.(); },
            onShowOutput: artifactId => {
                const job = this.runSnapshots.get(this.state.selectedRun);
                const file = job?.artifacts?.files.find(value => value.artifactId === artifactId);
                if (file) void showOutput(job, file);
            }});
    }

    /** Recover an unconfirmed request without automatically executing it.
     * @return {void}
     */
    start() {
        try {
            const value = JSON.parse(this.storage?.getItem(RECOVERY_KEY) ?? "null");
            if (value && typeof value.requestId === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(value.requestId) && value.model && value.inputs && value.parameters) {
                this.state.pending = value;
                this.state.error = "A previous submission needs recovery. Retry with its original inputs to find or create the same run.";
            }
        } catch { this.state.error = "The previous submission could not be read from this tab's storage."; }
        void this.recoverDeletions();
        this.render();
    }

    /** Open the retained Models page and refresh its library and history.
     * @return {void}
     */
    open() { this.onOpen(); void this.loadLibrary(); void this.loadRuns(); }

    /** Change visibility and refresh a map-linked setup without changing server work.
     * @param {boolean} active Whether Models is the visible Analysis tool.
     * @return {void}
     */
    setActive(active) {
        this.state.active = active;
        if (!active) this.closeVectorFilter();
        if (active) { this.refreshMapLayers(); this.refreshMapArea(); }
        for (const job of this.runSnapshots.values()) this.rememberRun(job);
        this.jobs.schedule(); this.render();
    }

    /** Load installed recipes whose inputs this setup form can edit.
     * Other recipes remain available through the API and existing run history.
     * @return {Promise<void>}
     */
    async loadLibrary() {
        if (this.state.loading) return;
        this.state.loading = true; this.render();
        try {
            this.state.library = (await this.api.discoverModels()).filter(model =>
                Object.values(model.inputs).every(input =>
                    ["raster", "catalog_raster", "optional_raster", "summary_area", "clip_area", "mask_source", "habitat_references", "habitat_stack", "raster_preparation", "temporal_interval", "temporal_reduction", "area_statistic"].includes(input.type)));
        }
        catch (error) { this.state.error = `Model library unavailable: ${error.message}`; }
        finally { this.state.loading = false; this.render(); }
    }

    /** Switch pages without discarding setup or cancelling accepted work.
     * @param {string} page Library, setup, runs or run.
     * @return {void}
     */
    navigate(page) { if (page !== "setup") this.closeVectorFilter(); this.revision += 1; this.state.page = page; this.state.error = ""; if (page === "setup") this.refreshMapArea(); this.render(); if (page === "runs") void this.loadRuns(); }

    /** Create a draft with the supplied area and load model-specific choices.
     * @param {Object} model Installed recipe chosen by the user.
     * @return {void}
     */
    chooseModel(model) {
        this.resetRasterPreparation();
        this.closeVectorFilter();
        this.cancelVectorSelections(); this.revision += 1;
        this.temporalAbort?.abort(); this.temporalRevision += 1;
        this.state.draft = createModelDraft(model, this.inputContext(model), this.newId());
        this.state.page = "setup"; this.state.error = ""; this.state.yaml = null; this.render(); this.view.focusHeading();
        const draft = this.state.draft;
        if (draft.temporal?.datasets.length === 1) void this.chooseTemporalDataset(modelSourceKey(draft.temporal.datasets[0]));
        for (const name of Object.keys(draft.inputs)) {
            if (draft.model.inputs[name].type === "habitat_stack") void this.loadHabitatOptions(draft, name);
        }
    }

    /** Stop vector checks when their entire model draft is replaced or destroyed.
     * @return {void}
     */
    cancelVectorSelections() {
        for (const request of this.vectorSelectionRequests.values()) request.abort();
        this.vectorSelectionRequests.clear();
    }

    /** Load Habitat's year choices and suggested grid from its scientific configuration.
     * Manual raster setup remains usable if this request fails. Replaced drafts
     * ignore late replies; a duplicated run keeps its saved year and output grid.
     * @param {Object} draft Draft requesting the configuration.
     * @param {string} name Habitat stack input declared by that recipe.
     * @return {Promise<void>} Resolves after choices or retry guidance are displayed.
     */
    async loadHabitatOptions(draft, name) {
        const input = draft.inputs[name];
        if (input.loading) return;
        input.loading = true; input.error = ""; this.render();
        try {
            const options = await this.api.getHabitatEarthEngineOptions();
            if (this.destroyed || this.state.draft !== draft) return;
            input.configuration = options; input.year ??= options.defaultYear;
        } catch (error) {
            if (this.destroyed || this.state.draft !== draft) return;
            input.error = `Could not load Earth Engine choices: ${error.message}`;
        } finally {
            input.loading = false;
            if (!this.destroyed && this.state.draft === draft) { this.refreshRasterPreparation(); this.render(); }
        }
    }

    /** Change one named input and update its dependent grid or area choices.
     * @param {string} name Input name declared by the recipe.
     * @param {Object} change Edited source, acquisition mode, mask or grid fields.
     * @return {void}
     */
    editInput(name, change) {
        if (!this.state.draft || this.state.submitting) return;
        const input = this.state.draft.inputs[name];
        if (this.state.draft.model.inputs[name].type === "raster_preparation") {
            if (change.crs !== undefined && change.crs !== input.crs) {
                Object.assign(input, {pixelSize: [null, null], origin: [0, 0], unit: "", choices: []});
            }
            if (change.mode === "custom") input.origin = [0, 0];
            if (change.mode === "source") {
                const choice = input.choices.find(value => value.key === change.sourceKey);
                Object.assign(input, {pixelSize: [...choice.grid.pixelSize], origin: [...choice.grid.origin], unit: choice.grid.unit});
            }
        }
        Object.assign(input, change);
        if (this.state.draft.model.inputs[name].type === "habitat_stack" && change.kind) {
            const draft = this.state.draft;
            for (const [key, definition] of Object.entries(draft.model.inputs)) {
                if (definition.type === "raster_preparation") Object.assign(draft.inputs[key], {mode: "auto", sourceKey: ""});
                if (change.kind === "earthEngine" && definition.type === "summary_area" && draft.inputs[key].area?.kind === "wholeRaster")
                    this.chooseArea(key, "viewport");
            }
        }
        this.editDraft({});
    }

    /** Stop obsolete grid requests when replacing the model draft.
     * @return {void}
     */
    resetRasterPreparation() {
        this.preparationAbort?.abort(); this.preparationKey = null;
    }

    /** Offer the model's acquisition grid and active source grids without replacing explicit choices.
     * Requests run sequentially within the source metadata service's concurrency limit.
     * @param {boolean} [retry=false] Retry failed lookups at the user's request.
     * @return {void}
     */
    refreshRasterPreparation(retry = false) {
        const draft = this.state.draft;
        const name = draft && Object.keys(draft.model.inputs).find(key => draft.model.inputs[key].type === "raster_preparation");
        if (!name) return;
        const input = draft.inputs[name];
        const sources = [...new Map(getRasterPreparationSources(draft).filter(value => value.raster.available !== false)
            .map(value => [modelSourceKey(value.raster), value.raster])).values()];
        const earthEngine = getHabitatEarthEngineInput(draft);
        const grid = earthEngine?.configuration?.grid;
        const choices = grid ? [{key: "earthEngine", label: "Earth Engine inputs", sourceCrs: grid.crs, grid}] : [];
        const key = JSON.stringify([draft.id, input.crs, earthEngine?.kind, grid, sources.map(modelSourceKey)]);
        if (!retry && key === this.preparationKey) return;
        this.preparationAbort?.abort();
        const abort = new AbortController(); this.preparationAbort = abort; this.preparationKey = key;
        input.choices = choices; input.loading = Boolean(sources.length && (input.crs || input.projectionMode !== "custom")); input.error = "";
        if (grid) input.unit = grid.unit;
        if (input.mode === "auto" && grid) {
            Object.assign(input, {pixelSize: [...grid.pixelSize], origin: [...grid.origin], sourceKey: "earthEngine", unit: grid.unit});
        } else if (input.mode === "auto" && input.sourceKey !== (sources[0] ? modelSourceKey(sources[0]) : "")) {
            Object.assign(input, {pixelSize: [null, null], origin: [0, 0], sourceKey: ""});
        }
        if (input.loading) void this.loadRasterPreparation(draft, input, sources, abort);
        this.render();
    }

    /** Read native/projected source grids and retain errors as optional-choice feedback.
     * @param {Object} draft Draft that requested the metadata.
     * @param {Object} input Its shared grid state.
     * @param {Object[]} sources Distinct available raster identities in input order.
     * @param {AbortController} abort Request ownership, cancelled when the selection changes.
     * @return {Promise<void>} Completion after the current choices or errors are displayed.
     */
    async loadRasterPreparation(draft, input, sources, abort) {
        const isCurrent = () => !abort.signal.aborted && !this.destroyed && this.state.draft === draft;
        const choices = [...input.choices], errors = [];
        const defaultKey = choices[0]?.key ?? modelSourceKey(sources[0]);
        for (const source of sources) {
            try {
                if (!input.crs) {
                    const native = await this.describeSource(source, abort.signal);
                    if (!isCurrent()) return;
                    input.crs = native.crs;
                    const earthEngine = getHabitatEarthEngineInput(draft);
                    this.preparationKey = JSON.stringify([draft.id, input.crs, earthEngine?.kind, earthEngine?.configuration?.grid, sources.map(modelSourceKey)]);
                }
                const key = modelSourceKey(source);
                const metadata = await this.describeSource(source, abort.signal, input.crs);
                if (!isCurrent()) return;
                choices.push({key, label: source.label, sourceCrs: metadata.crs, grid: metadata.projectedGrid});
            } catch (error) {
                if (!isCurrent()) return;
                errors.push(`${source.label}: ${error.message}`);
            }
        }
        if (!isCurrent()) return;
        input.choices = choices; input.loading = false; input.error = errors.join(" ");
        if (choices.length) input.unit = choices[0].grid.unit;
        const selected = choices.find(value => value.key === (input.mode === "auto" ? defaultKey : input.sourceKey));
        if (selected && (input.mode === "auto" || input.mode === "source" && input.pixelSize.some(value => value === null))) {
            Object.assign(input, {pixelSize: [...selected.grid.pixelSize], origin: [...selected.grid.origin], sourceKey: selected.key});
        }
        this.render();
    }

    /** Update draft fields without changing a pending or accepted submission.
     * Selecting Precipitation total rounds the visible period to whole UTC hours.
     * @param {Object} change Edited model choices, including the statistic or parameters.
     * @return {void}
     */
    editDraft(change) {
        if (!this.state.draft || this.state.submitting) return;
        Object.assign(this.state.draft, change);
        if (change.reduction?.reducer === "precipitation_total") {
            const temporal = this.state.draft.temporal;
            temporal.startTime = snapTemporalHour(temporal.startTime);
            temporal.endTime = snapTemporalHour(temporal.endTime);
        }
        this.refreshMapLayers();
        for (const job of this.runSnapshots.values()) this.rememberRun(job);
        this.jobs.schedule();
        this.state.error = ""; this.render();
    }

    /** Load a chosen dataset without inheriting the map's displayed variable or date.
     * @param {string} key Dataset choice identity, or empty to clear it.
     * @return {Promise<void>} Completion after Catalog metadata is available or its error is displayed.
     */
    async chooseTemporalDataset(key) {
        const temporal = this.state.draft?.temporal;
        if (!temporal || this.state.submitting) return;
        this.temporalAbort?.abort(); this.temporalRevision += 1;
        Object.assign(temporal, {datasetKey: key, item: null, variable: "", choices: null, loading: false, error: "", datesError: ""});
        this.state.error = ""; this.render();
        if (key) await this.loadTemporalDates(undefined, true);
    }

    /** Choose a variable and its supported statistic, then load date guidance.
     * @param {string} variable Catalog variable identifier from the setup control.
     * @return {Promise<void>} Completion after monthly guidance or a visible discovery error.
     */
    async chooseTemporalVariable(variable) {
        const temporal = this.state.draft?.temporal;
        if (!temporal || this.state.submitting) return;
        Object.assign(temporal, {variable, choices: null, error: "", datesError: ""});
        this.configureTemporalVariable(this.state.draft);
        await this.loadTemporalDates();
    }

    /** Keep the selected statistic or choose Mean when the new variable does not support it.
     * Refreshing guidance and copying a saved run preserve their existing choices instead.
     * @param {Object} draft Current temporal model setup with its chosen variable.
     * @return {void}
     */
    configureTemporalVariable(draft) {
        const temporal = draft.temporal, variable = temporal.item.properties["cube:variables"][temporal.variable];
        const statistics = getTemporalStatistics(variable, temporal);
        if (statistics.length && !statistics.some(choice => choice.value === draft.reduction.reducer))
            draft.reduction.reducer = statistics[0].value;
    }

    /** Read one month's actual dates, optionally reloading the current Catalog metadata.
     * This guidance does not preflight the requested interval or submit a calculation.
     * Refresh preserves the chosen variable and period, including removed choices that
     * need the user's attention. Superseded replies cannot change a later draft.
     * @param {string} [month] UTC month to inspect; omission asks for the latest available month.
     * @param {boolean} [reloadItem=false] Whether to reload Catalog metadata before reading dates.
     * @return {Promise<void>} Completion after the guidance or read error is shown.
     */
    async loadTemporalDates(month, reloadItem = false) {
        const draft = this.state.draft, temporal = draft?.temporal;
        if (!temporal?.datasetKey || this.state.submitting) return;
        const source = temporal.datasets.find(value => modelSourceKey(value) === temporal.datasetKey);
        this.temporalAbort?.abort(); const revision = ++this.temporalRevision;
        const abort = new AbortController(); this.temporalAbort = abort;
        const isCurrent = () => !this.destroyed && this.state.draft === draft && this.temporalRevision === revision;
        temporal.loading = true; temporal.error = ""; temporal.datesError = ""; this.render();
        try {
            if (reloadItem) {
                const item = await this.getTemporalItem(source);
                if (!isCurrent()) return;
                temporal.item = item;
                if (!temporal.variable) {
                    const variables = Object.keys(item.properties["cube:variables"]);
                    if (variables.length === 1) {
                        temporal.variable = variables[0];
                        this.configureTemporalVariable(draft);
                    }
                }
            }
            const variable = temporal.item.properties["cube:variables"][temporal.variable];
            if (!variable) { temporal.choices = null; return; }
            try {
                const choices = await this.loadTemporalTimes(temporal.item, temporal.variable, month, abort.signal);
                if (isCurrent()) temporal.choices = choices;
            } catch (error) {
                if (isCurrent() && !abort.signal.aborted) {
                    temporal.choices = null;
                    temporal.datesError = `Available dates could not be loaded: ${error.message} You can still enter a period.`;
                }
            }
        } catch (error) {
            if (isCurrent()) temporal.error = `Dataset could not be loaded: ${error.message} Refresh to try again.`;
        } finally { if (isCurrent()) { temporal.loading = false; this.render(); } }
    }

    /** Replace the period only after the user explicitly chooses the displayed month.
     * Missing dates within that calendar month remain valid; the calculation uses available observations.
     * @return {void}
     */
    useTemporalMonth() {
        const temporal = this.state.draft?.temporal;
        if (!temporal?.choices || this.state.submitting) return;
        Object.assign(temporal, {periodMode: "month", ...getTemporalMonthBoundaries(temporal.choices.month)});
        this.editDraft({});
    }

    /** Choose whether setup uses the live map area, vector features or a fixed area.
     * @param {string} name Input name declared by the recipe.
     * @param {string} mode Whole raster, viewport, samplingArea, mapPolygons, vector, starting raster or captured run area.
     * @return {void}
     */
    chooseArea(name, mode) {
        const draft = this.state.draft; if (!draft || this.state.submitting) return;
        const input = draft.inputs[name];
        if (input.filterEditing) this.closeVectorFilter();
        this.vectorSelectionRequests.get(name)?.abort(); this.vectorSelectionRequests.delete(name); input.selecting = false;
        input.areaMode = mode; input.vectorInfo = null; input.vectorKey = ""; input.selectionError = ""; this.state.error = "";
        if (mode === "whole") input.area = {kind: "wholeRaster"};
        else if (mode === "captured") input.area = structuredClone(input.capturedArea);
        else if (["viewport", "samplingArea", "mapPolygons"].includes(mode)) { this.refreshMapArea(); return; }
        else input.area = null;
        this.editDraft({});
    }

    /** Refresh a map-linked setup from composition's latest area and viewport.
     * Called after map changes and immediately before Run. Pending submissions,
     * duplicated fixed areas and explicitly selected vector views remain unchanged.
     * @return {void}
     */
    refreshMapArea() {
        const draft = this.state.draft;
        if (!draft || this.destroyed || this.state.page !== "setup" || this.state.submitting || this.state.pending) return;
        const context = this.getContext();
        for (const input of Object.values(draft.inputs)) {
            if (!["viewport", "samplingArea", "mapPolygons"].includes(input.areaMode)) continue;
            input.area = null; input.selectionError = "";
            try {
                if (input.areaMode === "viewport") {
                    input.area = modelViewportArea(context.viewportBounds);
                    input.areaDescription = "Visible map area";
                } else {
                    const kinds = input.areaMode === "samplingArea" ? ["selectedArea", "samplingBox"] : ["polygonArea"];
                    if (!kinds.includes(context.area?.kind)) throw new Error(input.areaMode === "samplingArea"
                        ? "Click the map to choose a sampling area for this analysis."
                        : "Select polygons on the map to choose an area for this analysis.");
                    input.area = modelAreaInput(context.area);
                    input.areaDescription = input.areaMode === "samplingArea" ? "Sampling area" : "Polygons selected on map";
                }
            } catch (error) { input.selectionError = error.message; }
        }
        this.render();
    }

    /** Read a vector view's current filter and show any feature-selection failure in setup.
     * @param {string} name Input name declared by the recipe.
     * @param {string} key Choice-list identity, or empty to clear the choice.
     * @return {Promise<void>}
     */
    async chooseVector(name, key) {
        try { await this.selectVectorFeatures(name, key); }
        catch { /* The selection owner has already put the failure in setup. */ }
    }

    /** Read matching features and commit their predicate only after a successful selection.
     * Failed candidate edits preserve the previous selection. A changed view filter
     * invalidates the old selection until its replacement has been read successfully.
     * @param {string} name Input name declared by the recipe.
     * @param {string} key Map view identity from the vector choice list.
     * @param {Object|null} [filter=null] Candidate edited filter, otherwise the view's current filter.
     * @return {Promise<Object|null>} Reviewed selection, or null for a cleared or superseded request.
     * @throws {Error} If reading or validating the selected features fails.
     */
    async selectVectorFeatures(name, key, filter = null) {
        const draft = this.state.draft;
        if (!draft) return null;
        const input = draft.inputs[name];
        const source = input.vectors.find(value => value.key === key);
        if (input.vectorKey !== key) { if (input.filterEditing) this.closeVectorFilter(); input.mapFilterMessage = ""; }
        this.vectorSelectionRequests.get(name)?.abort(); this.vectorSelectionRequests.delete(name);
        const previous = input.vectorKey === key && (filter !== null ||
            JSON.stringify(input.area?.selection?.filter) === JSON.stringify(source?.filter))
            ? {area: input.area, info: input.vectorInfo} : {area: null, info: null};
        input.vectorKey = source ? key : ""; input.area = source ? previous.area : null; input.vectorInfo = source ? previous.info : null; input.selectionError = "";
        if (!source) { input.selecting = false; this.render(); return null; }
        const abort = new AbortController(); this.vectorSelectionRequests.set(name, abort);
        const isCurrent = () => this.vectorSelectionRequests.get(name) === abort && this.state.draft === draft;
        input.selecting = true; this.render();
        try {
            const area = await this.prepareVector({...structuredClone(source), filter: structuredClone(filter ?? source.filter)}, abort.signal);
            if (!isCurrent()) return null;
            if (abort.signal.aborted) {
                input.area = previous.area; input.vectorInfo = previous.info; return null;
            }
            input.area = modelAreaInput({kind: "catalogSelection", catalogSelection: area.selection});
            input.vectorInfo = {label: source.label, matched: area.matched, total: area.total};
            if (filter !== null) void this.updateMapFilter(source, area, draft, name, abort);
            else input.mapFilterMessage = "";
            return area;
        } catch (error) {
            if (!isCurrent()) return null;
            input.area = previous.area; input.vectorInfo = previous.info;
            if (abort.signal.aborted) return null;
            input.selectionError = `${error.message}${previous.area ? " The previous selection is unchanged." : ""}`;
            throw error;
        } finally { if (isCurrent()) { input.selecting = false; this.render(); } }
    }

    /** Share a checked selection with its vector view and report rendering separately.
     * @param {Object} source Chosen vector view and its Catalog or uploaded source identity.
     * @param {Object} area Checked source predicate and exact feature counts.
     * @param {Object} draft Setup that requested this change.
     * @param {string} name Input whose selected filter changed.
     * @param {AbortController} request Selection request, used to ignore obsolete display feedback.
     * @return {Promise<void>}
     */
    async updateMapFilter(source, area, draft, name, request) {
        const input = draft.inputs[name];
        input.mapFilterMessage = "Updating the map filter…"; this.render();
        let message;
        try {
            const applied = await this.applyMapFilter(structuredClone(source), structuredClone(area));
            if (!applied) this.refreshMapLayers();
            message = applied ? "Filter applied to the map layer." : "The map filter changed before this update finished.";
        } catch (error) { message = `Features selected for this model. Could not update the map filter: ${error.message}`; }
        if (this.state.draft === draft && this.vectorSelectionRequests.get(name) === request) {
            input.mapFilterMessage = message; this.render();
        }
    }

    /** Open the rule editor inside model setup, using fields already supplied by Map layers.
     * Editing is available while the initial geometry check runs. Applying rules
     * checks the selection, then updates the map separately without submitting a run.
     * @param {string} name Input whose vector filter will be edited.
     * @return {Promise<void>}
     */
    async openVectorFilter(name) {
        const draft = this.state.draft;
        if (!draft) return;
        const input = draft.inputs[name];
        const source = input.vectors.find(value => value.key === input.vectorKey);
        if (!source || input.filterEditing || this.state.submitting) return;
        this.closeVectorFilter();
        const key = input.vectorKey, openingRequest = this.vectorSelectionRequests.get(name);
        const isCurrent = () => !this.destroyed && this.state.draft === draft && this.state.page === "setup" &&
            input.areaMode === "vector" && input.vectorKey === key && !this.state.submitting;
        input.filterOpening = true; input.filterEditing = true; this.state.error = ""; this.render();
        try {
            await this.editVectorFilter({key: `model:${draft.id}:${name}:${key}`, host: this.view.getVectorFilterHost(name), source: structuredClone(source),
                filter: structuredClone(input.area?.selection?.filter ?? source.filter), isCurrent: () => isCurrent() && this.state.active,
                apply: candidate => {
                    if (!isCurrent()) throw new Error("This model setup changed. Open its filter again.");
                    return this.selectVectorFeatures(name, key, candidate);
                },
                complete: () => { if (isCurrent()) { input.filterEditing = false; this.render(); } },
                cancel: () => {
                    if (!isCurrent()) return;
                    if (this.vectorSelectionRequests.get(name) !== openingRequest) this.vectorSelectionRequests.get(name)?.abort();
                },
                close: () => {
                    if (!isCurrent()) return;
                    if (this.vectorSelectionRequests.get(name) !== openingRequest) this.vectorSelectionRequests.get(name)?.abort();
                    input.filterEditing = false; this.render();
                },
            });
        } catch (error) {
            if (isCurrent()) { input.filterEditing = false; this.state.error = `Could not open the vector filter: ${error.message}`; }
        } finally { input.filterOpening = false; this.render(); }
    }

    /** Combine map inputs with this session's published raster results.
     * @param {Object} model Recipe whose input contract controls eligible choices.
     * @return {Object} Existing map context with available completed-run inputs.
     */
    inputContext(model) {
        const context = this.getContext();
        const acceptsResults = Object.values(model.inputs).some(input => ["raster", "optional_raster", "habitat_references", "habitat_stack"].includes(input.type));
        const choices = [...(context.rasters ?? []).filter(source => acceptsResults || source.kind !== "runArtifact"),
            ...(acceptsResults ? modelResultSources([...this.runSnapshots.values()]) : [])];
        return {...context, rasters: [...new Map(choices.map(source => [modelSourceKey(source), source])).values()]};
    }

    /** Refresh map choices and recheck live vector inputs when their view filter changes.
     * Captured run areas and accepted submissions retain their original predicates.
     * Removed live inputs must be added to the map again or replaced before a new run.
     * @return {void}
     */
    refreshMapLayers() {
        const draft = this.state.draft;
        if (!draft || this.destroyed || this.state.submitting || this.state.pending) return;
        const context = this.inputContext(draft.model);
        if (draft.temporal) {
            draft.temporal.datasets = structuredClone(context.temporalDatasets ?? []);
            if (draft.temporal.datasetKey && !draft.temporal.datasets.some(source => modelSourceKey(source) === draft.temporal.datasetKey)) {
                this.temporalAbort?.abort(); this.temporalRevision += 1;
                Object.assign(draft.temporal, {datasetKey: "", item: null, choices: null, loading: false,
                    error: "Add the temporal dataset to Map layers, or choose another dataset."});
            }
        }
        draft.sources = structuredClone(context.rasters ?? []);
        for (const {state, field, optional} of getModelRasterFields(draft)) {
            const selected = state[field];
            state[field] = draft.sources.find(source => selected && modelSourceKey(source) === modelSourceKey(selected)) ?? null;
            if (!state[field] && selected && (optional || selected.kind === "runArtifact")) {
                state[field] = {...selected, available: false,
                    label: selected.label ?? (selected.kind === "runArtifact" ? "Raster from original run" : `${selected.collectionId} / ${selected.itemId}`)};
                draft.sources.push(state[field]);
            }
        }
        for (const [name, input] of Object.entries(draft.inputs)) {
            const type = draft.model.inputs[name].type;
            if (["raster", "catalog_raster", "optional_raster"].includes(type)) {
                input.sourceReason = draft.sources.length ? "Choose a raster from Map layers." : "Add a raster to Map layers to use this model.";
                if (type !== "catalog_raster") input.sourceReason = "Choose a raster from Map layers or a completed run. Results do not need to be shown on the map.";
                if (input.raster?.available === false) input.sourceReason = "This raster is no longer available. Choose another input.";
                continue;
            }
            if (["habitat_stack", "raster_preparation"].includes(type)) continue;
            const previous = input.vectors.find(source => source.key === input.vectorKey);
            input.vectors = structuredClone(context.vectors ?? []);
            const selected = input.vectors.find(source => source.key === input.vectorKey);
            if (input.vectorKey && !selected) {
                if (input.filterEditing) this.closeVectorFilter();
                this.vectorSelectionRequests.get(name)?.abort(); this.vectorSelectionRequests.delete(name);
                input.vectorKey = ""; input.area = null; input.vectorInfo = null; input.selecting = false;
                input.selectionError = "Add the vector layer to Map layers, or choose another layer.";
            } else if (input.areaMode === "vector" && selected &&
                JSON.stringify(previous?.filter) !== JSON.stringify(selected.filter) &&
                JSON.stringify(input.area?.selection?.filter) !== JSON.stringify(selected.filter)) {
                void this.chooseVector(name, selected.key);
            }
        }
        this.refreshRasterPreparation(); this.render();
    }

    /** Submit once, or recover an uncertain response using its original request ID.
     * @param {boolean} [retry=false] Retry the saved immutable request.
     * @return {Promise<void>}
     */
    async submit(retry = false) {
        if (this.state.submitting || this.state.pending && !retry) return;
        const draft = this.state.draft; const revision = this.revision;
        this.state.error = "";
        try {
            if (!retry && Object.values(draft.inputs).some(input => input.filterEditing)) throw new Error("Apply or close the filter before running the model.");
            if (!retry) { this.refreshMapLayers(); this.refreshMapArea(); }
            const submission = retry ? this.state.pending : captureModelSubmission(draft, this.newId());
            if (!submission) return;
            if (!this.storage) throw new Error("Enable session storage to submit a recoverable model run.");
            const serialized = JSON.stringify(submission);
            if (new TextEncoder().encode(serialized).length > 16384) throw new Error("Model inputs exceed the 16 KiB submission limit.");
            this.storage.setItem(RECOVERY_KEY, serialized);
            this.state.pending = submission; this.state.submitting = true; this.render();
            const job = await this.api.submitModelRun(submission);
            this.state.pending = null;
            try { this.storage.removeItem(RECOVERY_KEY); } catch { /* The saved ID still safely recovers this same accepted run. */ }
            this.rememberRun(job); this.jobs.accept(job);
            if (revision === this.revision) await this.showRun(job.jobId);
        } catch (error) {
            // A definite rejection allows editing. Transport/5xx failures retain
            // the exact request because the server may already have accepted it.
            if (error instanceof ProcessingRequestError && error.status >= 400 && error.status < 500) {
                this.state.pending = null; try { this.storage?.removeItem(RECOVERY_KEY); } catch { /* Retry identity remains harmless. */ }
            }
            this.state.error = `${error.message}${this.state.pending ? " Use Recover submission to retry the same request." : ""}`;
        } finally { this.state.submitting = false; this.render(); }
    }

    /** Retain authoritative run state while hiding deleted runs from the interface.
     * @param {Object} job Authoritative run status.
     * @return {void}
     */
    rememberRun(job) {
        if (job.operation !== "model.run.v1") return;
        const previous = this.runSnapshots.get(job.jobId);
        if (previous && (previous.updatedAt > job.updatedAt || previous.status === "deleted" && job.status !== "deleted" && previous.updatedAt === job.updatedAt)) return;
        this.runSnapshots.set(job.jobId, job);
        this.rememberDeletion(job);
        this.onRunChange(job);
        if (job.status === "deleted" && this.state.selectedRun === job.jobId) {
            this.revision += 1;
            this.state.selectedRun = null; this.state.invocation = null; this.state.invocationError = "";
            this.state.yaml = null; this.state.deleteConfirmation = null;
            if (this.state.page === "run") { this.state.page = "runs"; this.view.focusHeading(); }
        }
        if (ACTIVE_JOB_STATES.has(job.status) || this.state.active && (this.state.page === "run" && this.state.selectedRun === job.jobId || this.state.page === "setup" &&
            this.state.draft && getModelRasterFields(this.state.draft).some(({state, field}) => state[field]?.jobId === job.jobId))) {
            this.jobs.tracked.add(job.jobId); this.tracked.add(job.jobId);
        } else { this.jobs.tracked.delete(job.jobId); this.tracked.delete(job.jobId); }
        this.state.runs = [...this.runSnapshots.values()].filter(value => value.status !== "deleted")
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId));
    }

    /** Apply observed progress without editing the current setup.
     * @return {void}
     */
    observeJobs() {
        for (const job of this.jobs.jobs) if (job.operation === "model.run.v1") this.rememberRun(job);
        this.refreshMapLayers();
        this.state.observationError = this.jobs.error; this.render();
    }

    /** Load recoverable run history with explicit pagination.
     * @param {boolean} [more=false] Append the next page instead of refreshing the first.
     * @return {Promise<void>}
     */
    async loadRuns(more = false) {
        if (this.state.historyLoading) return;
        const revision = ++this.historyRevision;
        this.state.historyLoading = true; this.render();
        try {
            const page = await this.api.listModelRuns(more ? this.state.nextCursor : null);
            if (revision !== this.historyRevision || this.destroyed) return;
            for (const job of page.jobs) {
                const current = this.runSnapshots.get(job.jobId);
                if (!current || current.updatedAt <= job.updatedAt) this.rememberRun(job);
            }
            this.state.nextCursor = page.nextCursor; this.jobs.schedule();
        } catch (error) { this.state.error = `Model runs unavailable: ${error.message}`; }
        finally { this.state.historyLoading = false; this.refreshMapLayers(); this.render(); }
    }

    /** Open one run and read its saved setup, discarding late navigation replies.
     * @param {string} id Model run identity.
     * @return {Promise<void>}
     */
    async showRun(id) {
        if (this.runSnapshots.get(id)?.status === "deleted") { this.navigate("runs"); return; }
        this.closeVectorFilter();
        const revision = ++this.revision;
        const previous = this.state.selectedRun;
        if (previous && !ACTIVE_JOB_STATES.has(this.runSnapshots.get(previous)?.status)) {
            this.jobs.tracked.delete(previous); this.tracked.delete(previous);
        }
        this.state.selectedRun = id; this.state.page = "run"; this.state.invocation = null; this.state.invocationError = "";
        this.state.deleteConfirmation = null; this.state.actionMessage = "";
        this.state.error = ""; this.state.yaml = null; this.jobs.tracked.add(id); this.tracked.add(id); this.jobs.schedule();
        this.render(); this.view.focusHeading();
        try {
            const [job, invocation] = await Promise.all([this.api.getJob(id), this.api.readModelInvocation(id).catch(error => ({readError: error.message}))]);
            if (revision !== this.revision || this.destroyed) return;
            this.rememberRun(job);
            if (this.runSnapshots.get(id)?.status === "deleted") this.state.invocation = null;
            else if (invocation.readError) this.state.invocationError = invocation.readError;
            else this.state.invocation = invocation;
        } catch (error) { if (revision === this.revision) this.state.invocationError = `This run is unavailable: ${error.message}`; }
        this.render();
    }

    /** Cancel only the run whose Cancel button the user selected.
     * @return {Promise<void>}
     */
    async cancelRun() {
        const id = this.state.selectedRun; if (!id || this.state.actionBusy) return;
        this.state.actionBusy = true; this.render();
        try { const job = await this.jobs.action(id, "cancel"); if (job) this.rememberRun(job); }
        catch (error) { this.state.error = `Cancellation could not be confirmed: ${error.message}`; }
        finally { this.state.actionBusy = false; this.render(); }
    }

    /** Ask for confirmation before deleting the selected run and every output.
     * @return {void}
     */
    requestRunDeletion() {
        const job = this.runSnapshots.get(this.state.selectedRun);
        if (!job || this.state.actionBusy || ACTIVE_JOB_STATES.has(job.status) || job.status === "deleted") return;
        this.state.deleteConfirmation = job.jobId; this.state.actionMessage = ""; this.render();
        this.view.focusDeleteConfirmation?.();
    }

    /** Renew the selected run without changing another run if navigation changes.
     * @return {Promise<void>} Completion after renewal or visible failure.
     */
    async renewRun() {
        const id = this.state.selectedRun;
        if (!id || this.state.actionBusy) return;
        this.state.actionBusy = true; this.state.actionMessage = ""; this.state.error = ""; this.render();
        try {
            const job = await this.api.renewModelRun(id);
            this.jobs.accept(job); this.rememberRun(job); this.refreshMapLayers();
            if (this.state.selectedRun === id) this.state.actionMessage = `Results kept until ${new Date(job.expiresAt).toLocaleString()}.`;
        } catch (error) { this.state.error = `Could not extend this run: ${error.message}`; }
        finally { this.state.actionBusy = false; this.render(); }
    }

    /** Rename the selected run and refresh its existing output labels through composition.
     * @param {string} label New user-entered name without the creation timestamp.
     * @return {Promise<boolean>} Whether renaming succeeded, allowing the view to close its editor.
     */
    async renameRun(label) {
        const id = this.state.selectedRun;
        if (!id || this.state.actionBusy) return false;
        this.state.actionBusy = true; this.state.renamingRun = id; this.state.actionMessage = ""; this.state.error = ""; this.render();
        try {
            if (!label.trim() || [...label.trim()].length > 80) throw new Error("Name this run using 1–80 characters.");
            const job = await this.api.renameModelRun(id, label.trim());
            this.jobs.accept(job); this.rememberRun(job); this.refreshMapLayers();
            if (this.state.selectedRun === id) {
                const current = this.runSnapshots.get(id);
                if (this.state.invocation) this.state.invocation = {...this.state.invocation, label: current.name};
                this.state.actionMessage = "Run renamed.";
            }
            return true;
        } catch (error) {
            if (this.state.selectedRun === id) this.state.error = `Could not rename this run: ${error.message}`;
            return false;
        } finally { this.state.actionBusy = false; this.state.renamingRun = null; this.render(); }
    }

    /** Delete the confirmed run and offer server-backed Undo for thirty seconds.
     * @return {Promise<void>} Completion after deletion or visible failure.
     */
    async deleteRun() {
        const id = this.state.deleteConfirmation;
        if (!id || id !== this.state.selectedRun || this.state.actionBusy) return;
        this.state.actionBusy = true; this.state.error = ""; this.render();
        try {
            const layers = this.captureRunLayers(id);
            const job = await this.api.deleteModelRun(id);
            this.jobs.accept(job); this.rememberRun(job);
            const notice = this.deletions.get(id);
            if (notice) notice.layers = layers;
            this.refreshMapLayers();
        } catch (error) { this.state.error = `Deletion could not be confirmed: ${error.message}`; }
        finally { this.state.actionBusy = false; this.render(); }
    }

    /** Keep one Undo notice per deletion, using only the server's original deadline.
     * @param {Object} job Authoritative model run, possibly deleted.
     * @return {void}
     */
    rememberDeletion(job) {
        const offer = job.status === "deleted" ? job.deletionUndo : null;
        if (offer && Date.parse(offer.expiresAt) > Date.now()) {
            const previous = this.deletions.get(job.jobId);
            if (previous?.deletionId !== offer.deletionId) this.deletions.set(job.jobId,
                {jobId: job.jobId, label: job.label, ...offer, busy: false, layers: []});
        } else this.deletions.delete(job.jobId);
        this.scheduleDeletions();
    }

    /** Remove expired notices and save only identities needed to recover offers after reload.
     * Server cleanup owns the deadline; browser timers never extend file lifetime.
     * @return {void}
     */
    scheduleDeletions() {
        this.clock.clearTimeout(this.deletionTimer);
        for (const [id, notice] of this.deletions) {
            if (Date.parse(notice.expiresAt) <= Date.now()) this.deletions.delete(id);
        }
        try {
            if (this.deletions.size) this.storage?.setItem(DELETIONS_KEY, JSON.stringify([...this.deletions.values()]
                .map(({jobId, expiresAt}) => ({jobId, expiresAt}))));
            else this.storage?.removeItem(DELETIONS_KEY);
        } catch { /* The current notice still works when tab storage is unavailable. */ }
        if (this.deletions.size && !this.destroyed) this.deletionTimer = this.clock.setTimeout(() => {
            this.scheduleDeletions(); this.render();
        }, Math.max(1, Math.min(...[...this.deletions.values()].map(value => Date.parse(value.expiresAt))) - Date.now()));
    }

    /** Recover unexpired Undo offers from the server after this tab reloads.
     * Saved identifiers do not grant access; the normal session check still applies.
     * @return {Promise<void>} Completion after recovery or a visible retry message.
     */
    async recoverDeletions() {
        try {
            const saved = JSON.parse(this.storage?.getItem(DELETIONS_KEY) ?? "[]");
            if (!Array.isArray(saved)) return;
            const ids = saved.filter(value => /^[A-Za-z0-9_-]{16,80}$/.test(value?.jobId) && Date.parse(value.expiresAt) > Date.now())
                .map(value => value.jobId);
            for (let offset = 0; offset < ids.length; offset += 100) {
                const result = await this.api.readJobStatuses(ids.slice(offset, offset + 100));
                if (this.destroyed) return;
                for (const job of result.jobs) this.rememberRun(job);
            }
            this.scheduleDeletions();
        } catch { this.state.error = "Could not recover deletion Undo. Reload to retry before its 30 seconds end."; }
        this.render();
    }

    /** Undo or dismiss one exact deletion without changing another run or its expiry.
     * @param {string} id Run identified by the notice.
     * @param {boolean} restore Whether to restore instead of dismissing Undo.
     * @return {Promise<void>} Completion after the server action and optional display restoration.
     */
    async resolveDeletion(id, restore) {
        const notice = this.deletions.get(id);
        if (!notice || notice.busy) return;
        notice.busy = true; this.state.error = ""; this.render();
        try {
            const job = restore ? await this.api.undoModelDeletion(id, notice.deletionId)
                : await this.api.dismissModelDeletion(id, notice.deletionId);
            this.jobs.accept(job); this.rememberRun(job); this.refreshMapLayers();
            const isCurrent = () => !this.destroyed && this.runSnapshots.get(id)?.status === "ready" &&
                this.runSnapshots.get(id)?.updatedAt === job.updatedAt;
            if (restore && isCurrent()) {
                try { await this.restoreRunLayers(notice.layers, isCurrent); }
                catch (error) { this.state.error = `Run restored. Some map layers could not be restored: ${error.message} Open the run to show them again.`; }
            }
        } catch (error) { this.state.error = `${restore ? "Could not undo deletion" : "Could not dismiss Undo"}: ${error.message}`; }
        finally { notice.busy = false; this.scheduleDeletions(); this.render(); }
    }

    /** Copy a run into a new draft, retaining its exact area and filter.
     * The exact recipe must be available. Choosing a vector view explicitly switches
     * a captured area to that view's current filter.
     * @return {Promise<void>}
     */
    async duplicateRun() {
        const saved = this.state.invocation; if (!saved) return;
        this.resetRasterPreparation();
        this.closeVectorFilter();
        const model = this.state.library.find(value => value.id === saved.model.id && value.version === saved.model.version &&
            value.definitionSha256 === saved.model.definitionSha256);
        if (!model) { this.state.error = "This model version is not available in model setup. Its YAML remains available until metadata expires."; this.render(); return; }
        this.cancelVectorSelections(); this.revision += 1;
        this.temporalAbort?.abort(); this.temporalRevision += 1;
        const draft = createModelDraft(model, this.inputContext(model), this.newId());
        this.state.draft = draft; this.state.page = "setup"; this.state.error = ""; this.state.yaml = null;
        draft.label = this.runSnapshots.get(this.state.selectedRun)?.name ?? saved.label; draft.parameters = structuredClone(saved.parameters);
        for (const [name, definition] of Object.entries(model.inputs)) {
            const input = draft.inputs[name];
            if (["raster", "catalog_raster", "optional_raster"].includes(definition.type)) {
                input.raster = structuredClone(saved.inputs[name]);
                input.sourceReason = "Copied from the original run; choose another raster to change it.";
            } else if (definition.type === "habitat_stack") {
                const value = saved.inputs[name];
                if (value.kind === "earthEngine") Object.assign(input, {kind: value.kind, year: value.year});
                else {
                    input.kind = "manual";
                    input.predictors = value.predictors.map(row => ({name: row.name, raster: structuredClone(row.source)}));
                    input.responses = value.responses.map(row => ({name: row.name, raster: structuredClone(row.source)}));
                    input.categoricalPredictor = value.categoricalPredictor;
                }
            } else if (definition.type === "raster_preparation") {
                const {crs, pixelSize, origin} = saved.inputs[name];
                Object.assign(input, {crs, pixelSize: [...pixelSize], origin: [...origin], mode: "saved"});
            } else if (definition.type === "temporal_interval") {
                const value = saved.inputs[name];
                Object.assign(draft.temporal, {datasetKey: modelSourceKey(value), variable: value.variable,
                    periodMode: "times", startTime: new Date(value.startTime).toISOString().slice(0, -1), endTime: new Date(value.endTime).toISOString().slice(0, -1)});
            } else if (definition.type === "temporal_reduction") {
                draft.reduction = {...draft.reduction, ...saved.inputs[name]};
            } else if (definition.type === "area_statistic") {
                draft.reduction.reducer = saved.inputs[name];
            } else if (definition.type === "mask_source" && saved.inputs[name].kind === "catalogRaster" ||
                definition.type === "habitat_references" && saved.inputs[name].kind === "raster") {
                input.area = null; input.areaMode = "raster";
                input.maskRaster = structuredClone(saved.inputs[name].source);
            } else if (["summary_area", "clip_area", "mask_source", "habitat_references"].includes(definition.type)) {
                input.area = definition.type === "habitat_references" ? {kind: "catalogSelection", selection: structuredClone(saved.inputs[name].selection)} : structuredClone(saved.inputs[name]);
                input.capturedArea = structuredClone(input.area); input.areaMode = input.area.kind === "wholeRaster" ? "whole" : "captured"; input.areaOrigin = "run";
                input.areaDescription = "Exact area and filter copied from the original run.";
            }
        }
        const preparationName = Object.keys(model.inputs).find(name => model.inputs[name].type === "raster_preparation");
        if (preparationName) {
            for (const source of getRasterPreparationSources(draft)) source.state.resampling = saved.inputs[preparationName].resampling[source.key];
        }
        this.refreshMapLayers();
        this.render(); this.view.focusHeading();
        for (const [name, definition] of Object.entries(model.inputs)) {
            if (definition.type === "habitat_stack") await this.loadHabitatOptions(draft, name);
        }
        if (draft.temporal?.datasetKey) await this.loadTemporalDates(undefined, true);
    }

    /** Show the reusable YAML for the current draft or accepted run.
     * @return {Promise<void>}
     */
    async showYaml() {
        const revision = this.revision;
        const run = this.state.page === "run" ? this.runSnapshots.get(this.state.selectedRun) : null;
        const model = run?.model ?? this.state.draft?.model; if (!model) return;
        try { const yaml = await this.api.readModelYaml(model, run?.jobId ?? null); if (revision === this.revision) this.state.yaml = yaml; }
        catch (error) { if (revision === this.revision) this.state.error = error.message; }
        this.render();
    }

    /** Present state without allowing a disposed component to update the page.
     * @return {void}
     */
    render() {
        if (this.destroyed) return;
        const job = this.runSnapshots.get(this.state.selectedRun);
        this.view.render({...this.state, deletions: [...this.deletions.values()], outputPreviews: Object.fromEntries((job?.artifacts?.files ?? [])
            .map(file => [file.artifactId, this.outputState(job.jobId, file.artifactId, file)]))});
    }

    /** Release UI observation only; accepted jobs continue until explicit cancellation.
     * @return {void}
     */
    destroy() {
        this.resetRasterPreparation();
        this.closeVectorFilter();
        this.destroyed = true; this.revision += 1; this.cancelVectorSelections();
        this.temporalAbort?.abort(); this.temporalRevision += 1;
        this.clock.clearTimeout(this.deletionTimer);
        this.unsubscribe(); for (const id of this.tracked) this.jobs.tracked.delete(id); this.view.destroy();
    }
}
