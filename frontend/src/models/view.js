/** Present the model library, editable setup and one run's results in Analysis. */
import { ACTIVE_JOB_STATES } from "../processing/jobs.js";
import { processingDownloadUrl } from "../processing/api.js";
import { describeModelProgress } from "../processing/presentation.js";
import { renderModelResult, updateModelFileActions, describeAreaStatistic } from "./result-view.js";
import { modelSourceKey, describeModelFilter, modelSupportsArea, modelHasInput, getHabitatEarthEngineInput } from "./inputs.js";
import { TemporalModelInputsView } from "./temporal-view.js";
import { HabitatStackView } from "./habitat-stack-view.js";
import { RasterGridView } from "./raster-grid-view.js";
import { describeTemporalInterval, describeTemporalReduction, describeTemporalResult } from "./temporal-inputs.js";

const RESAMPLING_LABELS = {nearest: "Nearest neighbor", bilinear: "Bilinear interpolation", cubic: "Cubic interpolation",
    average: "Average", mode: "Most common value (mode)"};

/** Show the creation time in the timezone captured when this run was started.
 * @param {Object} job Model run with its fixed naming timestamp.
 * @return {string} Readable date and time, without changing the stored suffix.
 */
function formatModelRunCreatedTime(job) {
    return job.nameTimestamp?.replace(/^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/, "$1-$2-$3 $4:$5:$6") ?? new Date(job.createdAt).toLocaleString();
}

/** Describe the explicit area shown in setup and saved run details.
 * @param {Object|null} area Model area descriptor.
 * @return {string} Source, bounds rounded to four decimal places, or predicate description.
 */
export function describeModelArea(area) {
    if (!area) return "No analysis area selected.";
    if (area.kind === "wholeRaster") return "Whole raster";
    if (area.kind === "samplingBox") return `Sampling box · ${area.samplingBox.sideLengthKm} × ${area.samplingBox.sideLengthKm} km · center ${area.samplingBox.center.latitude.toFixed(4)}°, ${area.samplingBox.center.longitude.toFixed(4)}°`;
    if (area.kind === "selectedArea") {
        const b = Object.fromEntries(Object.entries(area.selectedBounds).map(([key, value]) =>
            [key, Number.isFinite(value) ? value.toFixed(4) : "—"]));
        return `Box · W ${b.west}°, S ${b.south}°, E ${b.east}°, N ${b.north}°`;
    }
    if (area.kind === "catalogSelection") return `${area.selection.layerName} · ${describeModelFilter(area.selection.filter)}`;
    return "Previously selected polygons; the server checks that the input is still available.";
}

/** Describe a saved raster using its Catalog identity or completed-run file label.
 * @param {Object} source Catalog or owned run-file reference.
 * @param {Object[]} runs Loaded run statuses and artifact manifests.
 * @return {string} Readable source identity without a filesystem path.
 */
function describeModelRaster(source, runs) {
    if (source.kind !== "runArtifact") return `${source.collectionId} / ${source.itemId}`;
    const run = runs.find(value => value.jobId === source.jobId);
    const file = run?.artifacts?.files.find(value => value.artifactId === source.artifactId);
    return `${run?.label ?? "Previous run"} · ${file?.displayName ?? file?.label ?? source.artifactId}`;
}

/** Keep setup fields and run controls stable while progress updates arrive. */
export class ModelsView {
    /** Bind the existing Models panel markup.
     * @param {Document} [documentContext=globalThis.document] Owning document.
     */
    constructor(documentContext = globalThis.document) {
        this.document = documentContext; this.listeners = []; this.runCards = new Map();
        this.deletionNotices = new Map();
        this.elements = Object.fromEntries(["heading", "setup-heading", "close", "library", "setup", "run", "runs", "error", "recovery", "recover", "query",
            "library-items", "library-status", "refresh", "runs-list", "runs-status", "more", "refresh-runs", "yaml", "deletions"]
            .map(name => [name, documentContext.querySelector(`#models-${name}`)]));
        this.navigation = Object.fromEntries(["library", "setup", "runs"].map(name => [name, documentContext.querySelector(`#models-nav-${name}`)]));
        this.openers = ["open-models", "open-model-runs"].map(id => documentContext.querySelector(`#${id}`));
    }

    /** Create a text-only element.
     * @param {string} tag HTML tag.
     * @param {string} [text=""] Visible text.
     * @param {string} [className=""] Presentation class.
     * @return {HTMLElement} New element.
     */
    element(tag, text = "", className = "") {
        const node = this.document.createElement(tag); node.textContent = text; node.className = className; return node;
    }

    /** Create a native button for a semantic action.
     * @param {string} label Visible and accessible action name.
     * @param {()=>void} action Click callback.
     * @param {string} [className="secondary-button"] Appearance of this action.
     * @return {HTMLButtonElement} Button.
     */
    button(label, action, className = "secondary-button") { const button = this.element("button", label, className); button.type = "button"; button.addEventListener("click", action); return button; }

    /** Connect navigation and persistent controls to controller actions.
     * @param {Object<string,Function>} handlers Semantic user actions.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        this.listeners = [[this.openers[0], "click", handlers.onOpen], [this.openers[1], "click", () => { handlers.onPage("runs"); handlers.onOpen(); }],
            [this.elements.close, "click", handlers.onClose], [this.elements.query, "input", () => handlers.onQuery(this.elements.query.value)],
            [this.elements.refresh, "click", handlers.onRefresh], [this.elements["refresh-runs"], "click", handlers.onRefreshRuns],
            [this.elements.more, "click", handlers.onMore], [this.elements.recover, "click", handlers.onRetry],
            ...Object.entries(this.navigation).map(([page, node]) => [node, "click", () => handlers.onPage(page)])];
        for (const [node, event, callback] of this.listeners) node.addEventListener(event, callback);
    }

    /** Focus the chosen model or run name, or the Models header on a list page.
     * @param {"library"|"setup"|"runs"|"run"} [page=this.state.page] Destination, including a list transition before its render.
     * @return {void}
     */
    focusHeading(page = this.state.page) {
        const heading = page === "setup" ? this.elements["setup-heading"] : page === "run" ? this.run.title : this.elements.heading;
        heading.focus();
    }

    /** Focus the safe choice when asking to delete a run. @return {void} */
    focusDeleteConfirmation() { this.run?.keep.focus(); }

    /** Return focus to the run's deletion action after dismissing confirmation. @return {void} */
    focusRunDelete() { this.run?.remove.focus(); }

    /** Build a labelled input with a stable ID for keyboard users.
     * @param {string} id Unique control ID.
     * @param {string} caption Field label.
     * @param {HTMLElement} input Native field.
     * @return {HTMLLabelElement} Field wrapper.
     */
    field(id, caption, input) {
        input.id = id; const label = this.element("label", caption, "models-field"); label.htmlFor = id; label.append(input); return label;
    }

    /** Replace choice options only when their labels or values change.
     * @param {HTMLSelectElement} select Native select.
     * @param {{value:string,label:string,group?:string,disabled?:boolean}[]} options Choices, optionally grouped by source.
     * @param {string} selected Selected value.
     * @return {void}
     */
    options(select, options, selected) {
        const signature = JSON.stringify(options);
        if (select.optionsSignature !== signature) {
            const children = [], groups = new Map();
            for (const choice of options) {
                const node = this.element("option", choice.label); node.value = choice.value; node.disabled = Boolean(choice.disabled);
                if (choice.group) {
                    if (!groups.has(choice.group)) { const group = this.element("optgroup"); group.label = choice.group; groups.set(choice.group, group); children.push(group); }
                    groups.get(choice.group).append(node);
                } else children.push(node);
            }
            select.replaceChildren(...children);
            select.optionsSignature = signature;
        }
        select.value = selected;
    }

    /** Build one named raster chooser with its optional resampling control.
     * @param {HTMLElement} fields Owning setup fieldset.
     * @param {string} name Recipe input name.
     * @param {{type:string,label:string}} input Declared raster input.
     * @param {(raster:Object|null)=>void} [onChange] Update a raster nested inside another input; otherwise update this named input.
     * @param {(method:string)=>void} [onResampling] Update this raster's independent preparation method.
     * @return {Object} Stable controls for this input.
     */
    buildRasterInput(fields, name, input, onChange = raster => this.handlers.onInput(name, {raster}), onResampling = resampling => this.handlers.onInput(name, {resampling})) {
        const source = this.element("select"); source.required = input.type !== "optional_raster";
        source.addEventListener("change", () => onChange(this.state.draft.sources.find(value => modelSourceKey(value) === source.value) ?? null));
        const reason = this.element("p", "", "models-help"); reason.id = `models-${name}-source-reason`;
        source.setAttribute("aria-describedby", reason.id);
        fields.append(this.field(`models-${name}-raster`, input.label, source));
        const preparation = this.buildRasterResampling(fields, name, onResampling);
        fields.append(reason);
        return {source, reason, ...preparation};
    }

    /** Build the per-raster resampling choice when the model prepares a grid.
     * @param {HTMLElement} fields Container for this raster's dependent controls.
     * @param {string} name Input identity used for the accessible control label.
     * @param {(method:string)=>void} onChange Update this raster's preparation method.
     * @return {{resampling:HTMLSelectElement|null,resamplingField:HTMLLabelElement|null}} Optional stable controls.
     */
    buildRasterResampling(fields, name, onChange) {
        if (!modelHasInput(this.state.draft.model, "raster_preparation")) return {resampling: null, resamplingField: null};
        const resampling = this.element("select");
        this.options(resampling, Object.entries(RESAMPLING_LABELS).map(([value, label]) => ({value, label})), "nearest");
        resampling.addEventListener("change", () => onChange(resampling.value));
        const resamplingField = this.field(`models-${name}-resampling`, "Resampling", resampling);
        fields.append(resamplingField);
        return {resampling, resamplingField};
    }

    /** Build a direct spatial-source chooser and its active raster or vector controls.
     * @param {HTMLElement} fields Owning setup fieldset.
     * @param {string} name Recipe input name.
     * @param {{type:string,label:string}} input Declared area, mask or reference input.
     * @return {Object} Stable controls for this input only.
     */
    buildSpatialInput(fields, name, input) {
        const references = input.type === "habitat_references";
        const group = this.element("div", "", references ? "models-spatial-input models-spatial-reference" : "models-spatial-input");
        const source = this.element("select"); source.required = true;
        source.addEventListener("change", () => {
            const choice = source.value;
            if (choice.startsWith("vector:")) {
                this.handlers.onArea(name, "vector");
                this.handlers.onVector(name, choice.slice(7));
            } else if (choice.startsWith("raster:")) {
                const raster = this.state.draft.sources.find(value => modelSourceKey(value) === choice.slice(7)) ?? null;
                this.handlers.onArea(name, "raster");
                this.handlers.onInput(name, {maskRaster: raster});
            } else this.handlers.onArea(name, choice || "vector");
        });
        const sourceField = this.field(`models-${name}-source`, input.label, source);
        sourceField.id = `models-${name}-source-label`;
        group.setAttribute("role", "group"); group.setAttribute("aria-labelledby", sourceField.id);
        group.append(sourceField); fields.append(group);
        const maskGroup = this.element("div", "", "models-vector");
        const preparation = references ? this.buildRasterResampling(maskGroup, name,
            resampling => this.handlers.onInput(name, {resampling})) : {resampling: null, resamplingField: null};
        const rasterReason = this.element("p", "", "models-help"); rasterReason.id = `models-${name}-raster-reason`;
        const maskHint = this.element("p", references
            ? "Cells equal to 1 identify reference sites. Other values and NoData are excluded. Only reference sites inside the analysis area are used. Nearest neighbor preserves mask values; interpolation can change which cells equal 1."
            : "Flow starts in valid cells greater than zero. Zero, negative and NoData cells are excluded.", "models-help");
        maskHint.id = `models-${name}-raster-help`;
        maskGroup.append(rasterReason, maskHint);
        maskGroup.hidden = true; group.append(maskGroup);
        const vectorGroup = this.element("div", "", "models-vector");
        const selectionCard = this.element("section", "", "models-selection");
        selectionCard.setAttribute("aria-label", `${input.label}: selected features`);
        const selectionHeader = this.element("div", "", "models-selection-header");
        const selectedCount = this.element("strong"); selectedCount.setAttribute("role", "status");
        const editFilter = this.button("Edit filter", () => this.handlers.onEditFilter(name)); editFilter.classList.add("models-edit-filter");
        editFilter.setAttribute("aria-label", `Edit filter for ${input.label}`);
        editFilter.setAttribute("aria-controls", `models-${name}-filter-editor`);
        selectionHeader.append(selectedCount, editFilter);
        const filterDescription = this.element("p", "", "models-selection-filter");
        const vectorStatus = this.element("p", "", "models-help"); vectorStatus.setAttribute("role", "status");
        const mapFilterStatus = this.element("p", "", "models-help"); mapFilterStatus.setAttribute("role", "status");
        selectionCard.append(selectionHeader, filterDescription, vectorStatus, mapFilterStatus);
        const filterHost = this.element("div", "", "models-filter-editor"); filterHost.id = `models-${name}-filter-editor`;
        vectorGroup.append(selectionCard, filterHost);
        const areaDescription = this.element("p", "", "models-help"); areaDescription.setAttribute("role", "status");
        const mapHelp = this.element("p", "", "models-help");
        group.append(vectorGroup, areaDescription, mapHelp);
        if (input.type === "mask_source") group.append(this.element("p", "All selected features or positive raster cells form one combined starting mask and one overall result. Changing map visibility does not change these choices.", "models-help"));
        return {group, source, maskGroup, rasterReason, maskHint, ...preparation, vectorGroup, selectionCard, selectedCount, editFilter,
            filterDescription, vectorStatus, mapFilterStatus, filterHost, areaDescription, mapHelp};
    }

    /** Construct the editable fields for one draft, retaining their DOM identities.
     * @param {Object} draft New draft.
     * @return {void}
     */
    buildSetup(draft) {
        const form = this.element("form", "", "models-form");
        const fields = this.element("fieldset"); fields.setAttribute("aria-labelledby", "models-setup-heading");
        const description = this.element("p", draft.model.description, "models-help"); fields.append(description);
        const label = this.element("input"); label.type = "text"; label.required = true;
        label.addEventListener("input", () => this.handlers.onEdit({label: label.value}));
        fields.append(this.field("models-run-label", "Run name", label));
        const nameHelp = this.element("p", "The start date and time are added automatically to this name and its output files.", "models-help");
        nameHelp.id = "models-run-name-help"; label.setAttribute("aria-describedby", nameHelp.id); fields.append(nameHelp);
        const temporal = draft.temporal ? new TemporalModelInputsView({element: this.element.bind(this), field: this.field.bind(this),
            button: this.button.bind(this), options: this.options.bind(this), document: this.document}, this.handlers,
            Object.values(draft.model.inputs).find(input => ["temporal_reduction", "area_statistic"].includes(input.type)).label) : null;
        if (temporal) fields.append(temporal.sourceRoot);
        const inputs = {};
        for (const [name, input] of Object.entries(draft.model.inputs)) {
            if (["raster", "catalog_raster", "optional_raster"].includes(input.type)) inputs[name] = this.buildRasterInput(fields, name, input);
            else if (["summary_area", "clip_area", "mask_source", "habitat_references"].includes(input.type)) inputs[name] = this.buildSpatialInput(fields, name, input);
            else if (input.type === "habitat_stack") {
                inputs[name] = new HabitatStackView({element: this.element.bind(this), field: this.field.bind(this),
                    button: this.button.bind(this), options: this.options.bind(this), document: this.document,
                    buildRasterInput: this.buildRasterInput.bind(this), renderRasterInput: this.renderRasterInput.bind(this)}, this.handlers, name, input);
                fields.append(inputs[name].root);
            } else if (input.type === "raster_preparation") {
                inputs[name] = new RasterGridView({element: this.element.bind(this), field: this.field.bind(this),
                    button: this.button.bind(this), options: this.options.bind(this), document: this.document}, this.handlers, name, input);
                fields.append(inputs[name].root);
            }
        }
        if (temporal) fields.append(temporal.reductionRoot);
        const parameters = {};
        for (const [name, parameter] of Object.entries(draft.model.parameters)) {
            const input = this.element(parameter.type === "summary_expression" ? "textarea" : "input");
            if (parameter.type === "summary_expression") { input.rows = 2; input.maxLength = 4096; input.spellcheck = false; }
            else { input.type = "number"; input.step = "any"; input.required = parameter.type !== "optional_number"; if (parameter.minimum != null) input.min = String(parameter.minimum); }
            input.addEventListener("input", () => this.handlers.onEdit({parameters: {...this.state.draft.parameters,
                [name]: parameter.type === "summary_expression" ? input.value : input.value === "" ? null : Number(input.value)}}));
            parameters[name] = input;
            fields.append(this.field(`models-parameter-${name}`, `${parameter.label}${parameter.unit ? ` (${parameter.unit})` : ""}${parameter.type === "optional_number" ? " — optional" : ""}`, input));
            if (modelHasInput(draft.model, "mask_source") && parameter.type === "optional_number") fields.append(this.element("p", "Leave blank for no distance cutoff. Distance is measured in a straight line from the starting cells.", "models-help"));
            if (parameter.type === "summary_expression") fields.append(this.element("p", "a is the selected raster. Examples: sum(a), mean(a), stdev(a), min(a), max(a), count(a), areaha(a > 10), sum(a, where=a > 10).", "models-help"));
        }
        const runLabel = temporal ? "Run analysis" : "Run model";
        const run = this.button(runLabel, () => {}, "models-primary"); run.type = "submit";
        fields.append(run); form.append(fields);
        form.addEventListener("submit", event => { event.preventDefault(); this.handlers.onSubmit(); });
        const details = this.recipeDetails();
        this.elements.setup.replaceChildren(form, details.root);
        this.setup = {id: draft.id, form, fields, label, inputs, parameters, run, details, temporal};
    }

    /** Provide an inline location for the independently owned vector filter editor.
     * @param {string} name Recipe input whose filter will be edited.
     * @return {HTMLElement} Stable host belonging to that input.
     */
    getVectorFilterHost(name) { return this.setup.inputs[name].filterHost; }

    /** Build a collapsed recipe disclosure with YAML preview and download actions.
     * @return {{root:HTMLDetailsElement,preview:HTMLButtonElement,model:HTMLAnchorElement,run:HTMLAnchorElement,message:HTMLParagraphElement}} Stable disclosure and YAML action controls.
     */
    recipeDetails() {
        const root = this.element("details", "", "models-details"); root.append(this.element("summary", "Click to inspect the EOlab model recipe"));
        const actions = this.element("div", "", "models-actions");
        const preview = this.button("View Model YAML", this.handlers.onYaml, "models-action");
        const model = this.element("a", "Download Model YAML"); model.download = "";
        const run = this.element("a", "Download Run YAML"); run.download = "";
        const message = this.element("p", "", "models-help");
        actions.append(preview, model, run); root.append(actions, message);
        return {root, preview, model, run, message};
    }

    /** Refresh one raster chooser without changing another input's source.
     * @param {Object} controls Stable controls for this raster input.
     * @param {{type:string,label:string}} input Declared raster input.
     * @param {Object} value This input's selected raster and help text.
     * @param {Object} state Controller snapshot supplying shared source choices.
     * @return {boolean} Whether an available raster is selected, or an optional input is unset.
     */
    renderRasterInput(controls, input, value, state) {
        const acceptsResults = input.type !== "catalog_raster";
        const optional = input.type === "optional_raster";
        const sources = state.draft.sources.filter(source => acceptsResults || source.kind !== "runArtifact");
        this.options(controls.source, [{value: "", label: optional ? "None" : "Choose a raster…"}, ...sources.map(source => ({value: modelSourceKey(source),
            group: acceptsResults ? source.kind === "runArtifact" ? "Completed runs" : "Map layers" : undefined,
            disabled: source.available === false,
            label: source.label + (source.available === false ? " (unavailable)" : source.visible === false ? " (hidden on map)" : "")}))], value.raster ? modelSourceKey(value.raster) : "");
        controls.reason.textContent = value.raster?.available === false ? "This raster is no longer available. Choose another input." :
            optional ? "Leave None selected to run without this optional input." : value.sourceReason;
        if (controls.resampling) {
            controls.resampling.value = value.resampling;
            controls.resamplingField.hidden = !value.raster;
        }
        return optional && !value.raster || Boolean(value.raster) && value.raster.available !== false;
    }

    /** List eligible concrete spatial sources and show only the selected source's controls.
     * @param {Object} controls Stable controls for this spatial input.
     * @param {{type:string,label:string}} input Declared area, mask or reference input.
     * @param {Object} value This input's area, filter and selection feedback.
     * @param {Object} state Controller snapshot with source choices and result-history status.
     * @return {boolean} Whether this input has a usable area or raster mask.
     */
    renderSpatialInput(controls, input, value, state) {
        const draft = state.draft;
        const references = input.type === "habitat_references";
        const usesRasterOrVector = input.type === "mask_source" || references;
        const runLabel = draft.temporal ? "Run analysis" : "Run model";
        const areaChoices = [{value: "", label: references ? "Choose reference sites…" : input.type === "mask_source" ? "Choose a starting area…" : "Choose an area…"}];
        if (!usesRasterOrVector) areaChoices.push({value: "viewport", label: "Visible map area"}, {value: "samplingArea", label: "Sampling box"});
        if (modelSupportsArea(input.type, {kind: "wholeRaster"}) && !getHabitatEarthEngineInput(draft)) areaChoices.splice(1, 0, {value: "whole", label: "Whole raster"});
        if (value.capturedArea?.kind === "polygonArea" && value.areaOrigin === "map" && modelSupportsArea(input.type, value.capturedArea)) {
            areaChoices.push({value: "mapPolygons", label: "Polygons selected on map"});
        }
        if (value.capturedArea && value.capturedArea.kind !== "wholeRaster" &&
            (value.areaOrigin === "run" || value.capturedArea.kind === "catalogSelection")) {
            areaChoices.push({value: "captured", label: value.areaOrigin === "run" ? "Area from original run" : "Selected features"});
        }
        areaChoices.push(...value.vectors.map(source => ({value: `vector:${source.key}`, label: source.label, group: "Vector layers"})));
        if (usesRasterOrVector) {
            const rasters = draft.sources.filter(source => references || source.kind !== "runArtifact");
            if (value.maskRaster && !rasters.some(source => modelSourceKey(source) === modelSourceKey(value.maskRaster))) rasters.push({...value.maskRaster, available: false});
            areaChoices.push(...rasters.map(source => ({value: `raster:${modelSourceKey(source)}`,
                label: (source.label ?? "Previously selected raster") + (source.available === false ? " (unavailable)" : source.visible === false ? " (hidden on map)" : ""),
                group: source.kind === "runArtifact" ? "Completed runs" : "Raster layers", disabled: source.available === false})));
        }
        const selected = value.areaMode === "vector" ? value.vectorKey ? `vector:${value.vectorKey}` : ""
            : value.areaMode === "raster" ? value.maskRaster ? `raster:${modelSourceKey(value.maskRaster)}` : "" : value.areaMode;
        this.options(controls.source, areaChoices, selected);
        const rasterActive = usesRasterOrVector && value.areaMode === "raster";
        controls.maskGroup.hidden = !rasterActive;
        controls.source.setAttribute("aria-describedby", rasterActive ? `${controls.rasterReason.id} ${controls.maskHint.id}` : "");
        if (controls.resampling) {
            controls.resampling.value = value.resampling;
            controls.resampling.disabled = !rasterActive;
        }
        controls.rasterReason.textContent = value.maskRaster?.available === false ? "This raster is no longer available. Choose another input." : "";
        const rasterReady = Boolean(value.maskRaster) && value.maskRaster.available !== false;
        controls.vectorGroup.hidden = value.areaMode !== "vector";
        controls.mapHelp.hidden = !["viewport", "samplingArea", "mapPolygons", "captured"].includes(value.areaMode);
        controls.mapHelp.textContent = ({
            viewport: `Uses the visible map area when you choose ${runLabel}. Pan or zoom to change it.`,
            samplingArea: `Uses the sampling box shown in Histograms. Click the map to move the box. ${runLabel} uses its latest position and size.`,
            mapPolygons: `Uses the polygons selected on the map when you choose ${runLabel}.`,
            captured: value.capturedArea?.kind !== "catalogSelection"
                ? "Uses the exact area from the original run. Choose another area above to change it."
                : value.areaOrigin === "run"
                    ? "Uses the original area and filter. Choose a vector layer above to use its current filter."
                    : "Uses the selected features. Choose a vector layer above to follow its current filter.",
        })[value.areaMode] ?? "";
        const vectorSource = value.vectors.find(source => source.key === value.vectorKey);
        controls.selectionCard.hidden = !vectorSource;
        controls.editFilter.disabled = !vectorSource || Boolean(value.filterEditing);
        controls.editFilter.textContent = value.filterOpening ? "Opening filter…" : "Edit filter";
        controls.editFilter.setAttribute("aria-expanded", String(Boolean(value.filterEditing)));
        controls.filterHost.hidden = !value.filterEditing;
        controls.selectedCount.textContent = value.selecting ? "Checking selected features…" : value.vectorInfo ?
            `${value.vectorInfo.matched} of ${value.vectorInfo.total} features selected` : value.area?.kind === "catalogSelection" ? "Features from original run" : "Selection needs checking";
        controls.filterDescription.textContent = vectorSource ? describeModelFilter(value.area?.selection?.filter ?? vectorSource.filter) : "";
        controls.vectorStatus.textContent = value.selecting ? "You can edit the filter while this check runs." : value.selectionError || "";
        controls.mapFilterStatus.textContent = value.mapFilterMessage ?? "";
        controls.areaDescription.hidden = value.areaMode === "vector" && Boolean(vectorSource) || usesRasterOrVector && value.areaMode === "raster";
        controls.areaDescription.textContent = value.selectionError || (value.areaMode === "vector" && !vectorSource
            ? references ? "Choose reference sites above." : input.type === "mask_source" ? "Choose a starting area above." : "Choose an analysis area above." : "") ||
            `${describeModelArea(value.area)}${value.areaMode === "captured" ? ` · ${value.areaDescription}` : ""}`;
        const areaReady = usesRasterOrVector && value.areaMode === "raster" ? rasterReady : Boolean(value.area);
        return areaReady && !value.selecting && !value.filterEditing;
    }

    /** Update named form inputs while leaving the field being typed into untouched.
     * @param {Object} state Controller snapshot.
     * @return {void}
     */
    renderSetup(state) {
        const draft = state.draft; if (!draft) return;
        if (this.setup?.id !== draft.id) this.buildSetup(draft);
        const setupControls = this.setup;
        const temporalError = setupControls.temporal?.render(draft.temporal, draft.reduction) ?? "";
        const runLabel = draft.temporal ? "Run analysis" : "Run model";
        setupControls.fields.disabled = state.submitting;
        if (this.document.activeElement !== setupControls.label) setupControls.label.value = draft.label;
        let inputsReady = !temporalError;
        for (const [name, input] of Object.entries(draft.model.inputs)) {
            if (["raster", "catalog_raster", "optional_raster"].includes(input.type)) inputsReady = this.renderRasterInput(setupControls.inputs[name], input, draft.inputs[name], state) && inputsReady;
            else if (["summary_area", "clip_area", "mask_source", "habitat_references"].includes(input.type)) inputsReady = this.renderSpatialInput(setupControls.inputs[name], input, draft.inputs[name], state) && inputsReady;
            else if (input.type === "habitat_stack") inputsReady = setupControls.inputs[name].render(draft, state) && inputsReady;
            else if (input.type === "raster_preparation") inputsReady = setupControls.inputs[name].render(draft.inputs[name], draft) && inputsReady;
        }
        for (const [name, input] of Object.entries(setupControls.parameters)) if (this.document.activeElement !== input) input.value = draft.parameters[name] ?? "";
        const supported = Object.values(draft.model.inputs).every(input => ["raster", "catalog_raster", "optional_raster", "summary_area", "clip_area", "mask_source", "habitat_references", "habitat_stack", "raster_preparation", "temporal_interval", "temporal_reduction", "area_statistic"].includes(input.type));
        setupControls.run.disabled = state.submitting || Boolean(state.pending) || !inputsReady || !supported;
        setupControls.run.textContent = state.submitting ? "Submitting…" : runLabel;
        setupControls.details.model.href = `/api/processing/models/${draft.model.id}/versions/${draft.model.version}/yaml`;
        setupControls.details.run.hidden = true;
        setupControls.details.message.textContent = supported ? `Model version ${draft.model.version}. Results are temporary.` : "This model requires input controls not yet available in this interface.";
    }

    /** Build stable run controls with deletion confirmation at its action's location.
     * @param {string} id Run identity.
     * @return {void}
     */
    buildRun(id) {
        const heading = this.element("div", "", "models-run-heading");
        const title = this.element("h3", "", "models-name"); title.tabIndex = -1;
        const rename = this.button("", () => this.openRunNameEditor(), "models-action models-rename");
        rename.title = "Rename run"; rename.setAttribute("aria-label", "Rename run");
        const pencil = this.document.createElementNS("http://www.w3.org/2000/svg", "svg");
        pencil.setAttribute("viewBox", "0 0 24 24"); pencil.setAttribute("aria-hidden", "true"); pencil.setAttribute("focusable", "false");
        const pencilPath = this.document.createElementNS("http://www.w3.org/2000/svg", "path");
        pencilPath.setAttribute("d", "m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z");
        pencilPath.setAttribute("fill", "none"); pencilPath.setAttribute("stroke", "currentColor");
        pencilPath.setAttribute("stroke-width", "1.7"); pencilPath.setAttribute("stroke-linecap", "round"); pencilPath.setAttribute("stroke-linejoin", "round");
        pencil.append(pencilPath); rename.append(pencil); heading.append(title, rename);
        const created = this.element("p", "", "models-help");
        const nameEditor = this.element("form", "", "models-run-name-editor"); nameEditor.hidden = true;
        const nameInput = this.element("input"); nameInput.type = "text"; nameInput.required = true;
        const saveName = this.element("button", "Save name", "secondary-button"); saveName.type = "submit";
        const cancelName = this.button("Cancel", () => this.closeRunNameEditor(), "models-action");
        const nameActions = this.element("div", "", "models-actions"); nameActions.append(saveName, cancelName);
        nameEditor.append(this.field("models-edit-run-name", "Run name", nameInput), nameActions);
        nameEditor.addEventListener("submit", event => { event.preventDefault(); void this.saveRunName(); });
        nameEditor.addEventListener("keydown", event => {
            if (event.key === "Escape" && !this.state.actionBusy) { event.preventDefault(); event.stopPropagation(); this.closeRunNameEditor(); }
        });
        const status = this.element("p"); status.setAttribute("role", "status");
        const progress = this.element("progress"); progress.setAttribute("aria-label", "Current model stage progress");
        const error = this.element("p", "", "models-error"); const result = this.element("div", "", "models-results");
        const actions = this.element("div", "", "models-actions");
        const cancel = this.button("Cancel run", this.handlers.onCancel, "models-action"); const duplicate = this.button("Duplicate with changes", this.handlers.onDuplicate, "models-action");
        const renew = this.button("Keep for another 7 days", this.handlers.onRenew, "models-action");
        actions.append(cancel, duplicate, renew);
        const deletion = this.element("div", "", "models-delete");
        const remove = this.button("Delete run and results", this.handlers.onDelete, "models-action models-action-danger");
        const confirmation = this.element("div", "", "models-delete-confirmation"); confirmation.setAttribute("role", "group");
        confirmation.setAttribute("aria-label", "Confirm run deletion");
        const warning = this.element("p");
        warning.id = "models-delete-warning"; confirmation.setAttribute("aria-describedby", warning.id);
        const confirmActions = this.element("div", "", "models-delete-actions");
        const confirm = this.button("Delete run and results", this.handlers.onConfirmDelete, "models-action models-action-danger models-delete-confirm");
        const keep = this.button("Keep run", this.handlers.onKeepRun, "models-action");
        confirmActions.append(keep, confirm); confirmation.append(warning, confirmActions);
        confirmation.addEventListener("keydown", event => {
            if (event.key === "Escape" && !this.state.actionBusy) {
                event.preventDefault(); event.stopPropagation(); this.handlers.onKeepRun();
            }
        });
        deletion.append(remove, confirmation);
        const feedback = this.element("p", "", "models-help"); feedback.setAttribute("role", "status");
        const expiry = this.element("p", "", "models-help");
        const inputs = this.element("details", "", "models-details"); inputs.append(this.element("summary", "Inputs used for this run"));
        const inputsBody = this.element("div"); inputs.append(inputsBody);
        const details = this.recipeDetails();
        this.elements.run.replaceChildren(heading, created, nameEditor, status, progress, error, result, actions, deletion, feedback, expiry, inputs, details.root);
        this.run = {id, title, created, rename, nameEditor, nameInput, saveName, cancelName, editingName: false,
            status, progress, error, result, cancel, duplicate, renew, deletion, remove, confirmation, warning, confirm, keep, feedback, expiry, inputs, inputsBody, details};
    }

    /** Open the selected run's name while keeping its creation timestamp fixed.
     * @return {void}
     */
    openRunNameEditor() {
        const job = this.state.runs.find(run => run.jobId === this.run?.id);
        if (!job || this.state.actionBusy) return;
        this.run.editingName = true; this.run.nameInput.value = job.name ?? job.label;
        this.renderRun(this.state); this.run.nameInput.focus(); this.run.nameInput.select?.();
    }

    /** Discard an unsaved name and return focus to its Rename action.
     * @return {void}
     */
    closeRunNameEditor() {
        if (!this.run) return;
        this.run.editingName = false; this.renderRun(this.state); this.run.rename.focus();
    }

    /** Save the entered name and keep the editor open if the server rejects it.
     * @return {Promise<void>} Completion after saving and restoring focus when still on this run.
     */
    async saveRunName() {
        const run = this.run;
        if (!run?.editingName || this.state.actionBusy) return;
        const saved = await this.handlers.onRename(run.nameInput.value);
        if (saved && this.run === run) this.closeRunNameEditor();
    }

    /** Render run progress, results, saved inputs and deletion confirmation without replacing controls.
     * @param {Object} state Controller snapshot.
     * @return {void}
     */
    renderRun(state) {
        const id = state.selectedRun; if (!id) return;
        if (this.run?.id !== id) this.buildRun(id);
        const r = this.run; const job = state.runs.find(run => run.jobId === id);
        r.title.textContent = job?.label ?? "Model run"; r.title.title = job?.label ?? "Model run";
        r.title.setAttribute("aria-label", job?.label ?? "Model run");
        r.created.textContent = job ? `Created ${formatModelRunCreatedTime(job)}` : "";
        r.rename.hidden = !job || job.status === "deleted" || r.editingName;
        r.rename.disabled = Boolean(state.actionBusy);
        r.nameEditor.hidden = !r.editingName || !job || job.status === "deleted";
        r.nameInput.disabled = r.saveName.disabled = r.cancelName.disabled = Boolean(state.actionBusy);
        r.saveName.textContent = state.renamingRun === id ? "Saving…" : "Save name";
        r.status.textContent = job ? describeModelProgress(job) : "Reading run…";
        r.error.textContent = state.invocationError || job?.error?.message || job?.error?.detail || ""; r.error.hidden = !r.error.textContent;
        r.cancel.hidden = !job || !ACTIVE_JOB_STATES.has(job.status); r.cancel.disabled = state.actionBusy || job?.status === "cancelling";
        r.duplicate.disabled = !state.invocation || Boolean(state.actionBusy);
        r.progress.hidden = job?.status !== "running";
        if (job?.progress.total > 0) { r.progress.max = job.progress.total; r.progress.value = job.progress.completed ?? 0; }
        else r.progress.removeAttribute("value");
        const available = job?.status === "ready" && Date.parse(job.expiresAt) > Date.now();
        r.renew.hidden = !available; r.renew.disabled = Boolean(state.actionBusy);
        r.remove.hidden = !job || ACTIVE_JOB_STATES.has(job.status) || job.status === "deleted" || state.deleteConfirmation === job.jobId;
        r.remove.disabled = Boolean(state.actionBusy);
        r.confirmation.hidden = !job || job.status === "deleted" || state.deleteConfirmation !== job.jobId;
        r.deletion.hidden = r.remove.hidden && r.confirmation.hidden;
        r.warning.textContent = `Delete “${job?.label ?? "this run"}” and all its result files? Its outputs will be removed from the map. Undo is available for 30 seconds.`;
        r.confirmation.setAttribute("aria-busy", String(Boolean(state.actionBusy)));
        r.confirm.textContent = state.actionBusy ? "Please wait…" : "Delete run and results";
        r.confirm.disabled = Boolean(state.actionBusy); r.keep.disabled = Boolean(state.actionBusy);
        r.feedback.textContent = state.actionMessage ?? ""; r.feedback.hidden = !r.feedback.textContent;
        const invocation = state.invocation;
        let result = job?.result;
        if (result?.kind === "raster" && invocation) {
            const inputs = Object.entries(invocation.model.definition.inputs);
            const interval = inputs.find(([, input]) => input.type === "temporal_interval");
            const reduction = inputs.find(([, input]) => input.type === "temporal_reduction");
            if (interval && reduction) result = {...result, label: describeTemporalResult(invocation.inputs[interval[0]], invocation.inputs[reduction[0]])};
        }
        const signature = JSON.stringify([available, result, job?.artifacts]);
        if (r.resultSignature !== signature) {
            r.resultSignature = signature; r.result.replaceChildren();
            r.fileActions = [];
            if (available && result) r.fileActions = renderModelResult(r.result, result,
                job.artifacts?.availability === "available" ? job.artifacts : null, this.element.bind(this), this.handlers.onShowOutput);
        }
        updateModelFileActions(r.fileActions, state.outputPreviews);
        r.expiry.hidden = job?.status === "deleted";
        r.inputs.hidden = job?.status === "deleted";
        r.expiry.textContent = job ? `Temporary run in this browser. Clearing cookies or losing this browser session loses access.${job.expiresAt ? ` Result files expire ${new Date(job.expiresAt).toLocaleString()}.` : ""}` +
            (job.metadataExpiresAt ? ` Saved inputs expire ${new Date(job.metadataExpiresAt).toLocaleString()}.` : "") : "";
        if (invocation && r.invocation !== invocation) {
            r.invocation = invocation;
            const list = this.element("dl");
            for (const [name, input] of Object.entries(invocation.model.definition.inputs)) {
                const value = invocation.inputs[name];
                if (input.type === "habitat_stack") {
                    if (value.kind === "earthEngine") {
                        list.append(this.element("dt", input.label), this.element("dd", `Original model inputs from Earth Engine · Assessment year ${value.year}`));
                        continue;
                    }
                    for (const [role, label] of [["predictors", "Predictor"], ["responses", "Observed response"]]) {
                        for (const row of value[role]) list.append(this.element("dt", `${label}: ${row.name}${role === "predictors" && row.name === value.categoricalPredictor ? " (categorical)" : ""}`),
                            this.element("dd", describeModelRaster(row.source, state.runs)));
                    }
                    continue;
                }
                if (input.type === "raster_preparation") {
                    list.append(this.element("dt", input.label), this.element("dd", `${value.crs} · pixel size ${value.pixelSize.join(" × ")} · origin ${value.origin.join(", ")}`));
                    const step = invocation.model.definition.steps.find(item => item.inputs.preparation?.input === name);
                    const stack = invocation.inputs[step.inputs.stack.input];
                    if (stack.kind !== "earthEngine") for (const [role, label] of [["predictors", "Predictor"], ["responses", "Observed response"]]) {
                        stack[role].forEach((row, index) => list.append(this.element("dt", `${label}: ${row.name} resampling`),
                            this.element("dd", RESAMPLING_LABELS[value.resampling[`${role === "predictors" ? "predictor" : "response"}_${index}`]])));
                    }
                    for (const [key, label] of [["reference_mask", "Reference raster resampling"], ["habitat_mask", "Habitat assessment mask resampling"]]) {
                        if (value.resampling[key]) list.append(this.element("dt", label), this.element("dd", RESAMPLING_LABELS[value.resampling[key]]));
                    }
                    continue;
                }
                const description = input.type === "optional_raster" ? value ? describeModelRaster(value, state.runs) : "None" :
                    input.type === "habitat_references" ? value.kind === "raster" ? `${describeModelRaster(value.source, state.runs)} · cells equal to 1` :
                        describeModelArea({kind: "catalogSelection", selection: value.selection}) :
                    input.type === "mask_source" && value.kind === "catalogRaster" ?
                    `${value.source.collectionId} / ${value.source.itemId} · valid cells greater than zero` :
                    ["raster", "catalog_raster"].includes(input.type) ? describeModelRaster(value, state.runs) :
                        input.type === "temporal_interval" ? describeTemporalInterval(value) :
                            input.type === "temporal_reduction" ? describeTemporalReduction(value) :
                                input.type === "area_statistic" ? describeAreaStatistic(value) : describeModelArea(value);
                list.append(this.element("dt", input.label), this.element("dd", description));
            }
            for (const [name, parameter] of Object.entries(invocation.model.definition.parameters)) list.append(this.element("dt", parameter.label),
                this.element("dd", invocation.parameters[name] === null ? "Not set" : `${invocation.parameters[name]}${parameter.unit ? ` ${parameter.unit}` : ""}`));
            r.inputsBody.replaceChildren(list);
        } else if (!invocation) { r.inputsBody.textContent = state.invocationError || "Reading saved inputs…"; r.invocation = null; }
        const metadataAvailable = job && job.status !== "deleted" && (!job.metadataExpiresAt || Date.parse(job.metadataExpiresAt) > Date.now());
        r.details.preview.disabled = !metadataAvailable; r.details.model.hidden = r.details.run.hidden = !metadataAvailable;
        r.details.model.href = processingDownloadUrl(`/api/processing/jobs/${id}/model-yaml`, id, "model-yaml");
        r.details.run.href = processingDownloadUrl(`/api/processing/jobs/${id}/run-yaml`, id, "run-yaml");
        r.details.message.textContent = metadataAvailable ? `Recipe ${job.model.title} · ${job.model.version}` : "Saved recipe and inputs are no longer available.";
    }

    /** Present compact, separate Undo status rows while keeping focused buttons stable.
     * @param {Object[]} notices Unexpired server-backed deletion offers.
     * @return {void}
     */
    renderDeletions(notices) {
        const ids = new Set(notices.map(value => value.deletionId));
        for (const [id, notice] of this.deletionNotices) {
            if (ids.has(id)) continue;
            if (notice.root.contains(this.document.activeElement)) this.focusHeading();
            notice.root.remove(); this.deletionNotices.delete(id);
        }
        for (const deletion of notices) {
            let notice = this.deletionNotices.get(deletion.deletionId);
            if (!notice) {
                const root = this.element("div", "", "models-deletion-notice");
                const message = this.element("p");
                message.setAttribute("role", "status");
                const actions = this.element("div", "", "models-delete-actions");
                const undo = this.button("Undo", () => this.handlers.onUndoDelete(deletion.jobId), "models-action");
                const dismiss = this.button("Dismiss", () => this.handlers.onDismissDelete(deletion.jobId), "models-action");
                undo.setAttribute("aria-label", `Undo deletion of ${deletion.label}`);
                dismiss.setAttribute("aria-label", `Dismiss Undo for ${deletion.label}`);
                actions.append(undo, dismiss); root.append(message, actions);
                notice = {root, message, undo, dismiss}; this.deletionNotices.set(deletion.deletionId, notice);
                this.elements.deletions.append(root);
            }
            const message = `“${deletion.label}” deleted. Undo available for 30 seconds.${deletion.busy ? " Updating…" : ""}`;
            if (notice.message.textContent !== message) notice.message.textContent = message;
            notice.root.setAttribute("aria-busy", String(Boolean(deletion.busy)));
            notice.undo.disabled = deletion.busy; notice.dismiss.disabled = deletion.busy;
        }
    }

    /** Present the selected Models page while retaining drafts, controls and run cards.
     * @param {Object} state Controller snapshot.
     * @return {void}
     */
    render(state) {
        this.state = state;
        for (const page of ["library", "setup", "runs", "run"]) this.elements[page].hidden = state.page !== page;
        for (const [page, node] of Object.entries(this.navigation)) node.setAttribute("aria-pressed", String(state.page === page || page === "runs" && state.page === "run"));
        this.navigation.setup.disabled = !state.draft;
        this.elements["setup-heading"].hidden = state.page !== "setup";
        this.elements["setup-heading"].textContent = state.draft?.model.title ?? "";
        const error = state.error || (state.page === "setup" ? "" : state.observationError) || "";
        this.elements.error.textContent = error; this.elements.error.hidden = !error;
        this.renderDeletions(state.deletions ?? []);
        this.elements.recovery.hidden = !state.pending; this.elements.recover.disabled = state.submitting;
        const filtered = state.library.filter(model => `${model.title} ${model.description}`.toLowerCase().includes(state.query.toLowerCase()));
        const signature = JSON.stringify(filtered);
        if (signature !== this.librarySignature) {
            this.librarySignature = signature;
            this.elements["library-items"].replaceChildren(...filtered.map(model => {
                const card = this.element("article", "", "models-card");
                const heading = this.element("h3");
                const open = this.button(model.title, () => this.handlers.onChoose(model), "models-card-open models-name");
                open.setAttribute("aria-label", `Set up ${model.title}`); heading.append(open);
                card.append(heading, this.element("p", model.description),
                    this.element("p", `Inputs: ${Object.values(model.inputs).map(input => input.label).join(", ")}`, "models-help"),
                    this.element("p", `Outputs: ${Object.entries(model.outputs).map(([name, output]) => `${name} (${output.presentation})`).join(", ")}`, "models-help"),
                    this.element("span", "Set up model →", "models-card-hint")); return card;
            }));
        }
        this.elements["library-status"].textContent = state.loading ? "Loading model library…" : filtered.length ? "" : "No matching models.";
        this.elements.refresh.disabled = state.loading;
        this.renderSetup(state); this.renderRun(state);
        const retainedRuns = new Set(state.runs.map(job => job.jobId));
        for (const [id, card] of this.runCards) {
            if (retainedRuns.has(id)) continue;
            card.root.remove(); this.runCards.delete(id);
        }
        for (const job of state.runs) {
            let card = this.runCards.get(job.jobId);
            if (!card) {
                const root = this.element("article", "", "models-card");
                const heading = this.element("h3"); const button = this.button(job.label, () => this.handlers.onRun(job.jobId), "models-card-open models-name");
                heading.append(button);
                const status = this.element("small", "", "models-help"); root.append(heading, status); card = {root, button, status}; this.runCards.set(job.jobId, card);
                this.elements["runs-list"].append(root);
            }
            card.button.textContent = job.label; card.button.title = job.label; card.button.setAttribute("aria-label", job.label);
            card.status.textContent = `${describeModelProgress(job)} · ${formatModelRunCreatedTime(job)}`;
        }
        // Move retained nodes only when ordering changes, keeping focus during status reads.
        const order = state.runs.map(job => job.jobId).join();
        if (order !== this.runOrder) { this.runOrder = order; for (const job of state.runs) this.elements["runs-list"].append(this.runCards.get(job.jobId).root); }
        this.elements["runs-status"].textContent = state.historyLoading ? "Loading runs…" : state.runs.length ? "Runs belong to this browser session. Closing Models does not cancel them." : "No model runs in this browser session yet.";
        this.elements.more.hidden = !state.nextCursor; this.elements.more.disabled = state.historyLoading;
        this.elements["refresh-runs"].disabled = state.historyLoading;
        this.elements.yaml.hidden = !state.yaml; this.elements.yaml.textContent = state.yaml ?? "";
    }

    /** Detach persistent event listeners.
     * @return {void}
     */
    destroy() { for (const [node, event, callback] of this.listeners) node.removeEventListener(event, callback); }
}
