/** Choose Earth Engine inputs or a named raster stack for Habitat condition. */
import { captureHabitatStack } from "./inputs.js";

/** Edit Habitat's input source and keep manual predictor/response rows stable. */
export class HabitatStackView {
    /** Build stack controls using the Models form's existing raster chooser.
     * @param {Object} helpers Models presentation helpers.
     * @param {(tag:string,text?:string,className?:string)=>HTMLElement} helpers.element Create a text-only element.
     * @param {(id:string,caption:string,input:HTMLElement)=>HTMLLabelElement} helpers.field Create a labelled field.
     * @param {(label:string,action:()=>void,className?:string)=>HTMLButtonElement} helpers.button Create a button.
     * @param {(select:HTMLSelectElement,choices:Object[],selected:string)=>void} helpers.options Update select choices.
     * @param {Document} helpers.document Owning document, used to preserve focused edits.
     * @param {(host:HTMLElement,id:string,input:Object,onChange:(raster:Object|null)=>void,onResampling:(method:string)=>void)=>Object} helpers.buildRasterInput Build the ordinary raster chooser with row-specific source and method callbacks.
     * @param {(controls:Object,input:Object,value:Object,state:Object)=>boolean} helpers.renderRasterInput Update that chooser using current source availability.
     * @param {{onInput:(name:string,change:Object)=>void,onRefreshHabitat:(name:string)=>void}} handlers Input edits and Earth Engine configuration retry.
     * @param {string} name Recipe input name for this stack.
     * @param {{label:string}} input Declared stack input.
     */
    constructor({element, field, button, options, document, buildRasterInput, renderRasterInput}, handlers, name, input) {
        Object.assign(this, {element, field, button, options, document, buildRasterInput, renderRasterInput, handlers});
        this.inputName = name;
        this.predictors = []; this.responses = []; this.nextRowId = 0; this.categoricalRow = null;
        this.root = element("section", "", "models-vector");
        this.root.setAttribute("aria-label", input.label);
        this.source = element("select");
        this.source.addEventListener("change", () => handlers.onInput(name, {kind: this.source.value}));
        this.options(this.source, [{value: "earthEngine", label: "Original model inputs (Google Earth Engine)"},
            {value: "manual", label: "Choose raster layers"}], "earthEngine");
        const attribution = element("p", "", "models-help");
        const modelLink = element("a", "NHI Terrestrial Integrity Modeling");
        modelLink.href = "https://github.com/springinnovate/nhi-terrestrial-integrity-modeling";
        modelLink.target = "_blank"; modelLink.rel = "noopener noreferrer";
        attribution.append(element("span", "Based on "), modelLink);
        this.year = element("select");
        this.year.addEventListener("change", () => handlers.onInput(name, {year: Number(this.year.value)}));
        this.automatic = element("fieldset", "", "models-vector");
        this.automatic.append(element("legend", "Earth Engine inputs"), field(`models-${name}-year`, "Assessment year", this.year));
        this.datasetSources = element("div", "", "models-habitat-datasets");
        this.datasetLists = {};
        for (const [role, title] of [["predictor", "Predictor datasets"], ["response", "Observed response datasets"]]) {
            const group = element("section"), list = element("ul");
            group.append(element("h4", title), list); this.datasetSources.append(group);
            this.datasetLists[role] = list;
        }
        this.automatic.append(this.datasetSources);
        this.acquisitionStatus = element("p", "", "models-help"); this.acquisitionStatus.setAttribute("role", "status");
        this.retry = button("Retry Earth Engine year choices", () => handlers.onRefreshHabitat(name), "models-action");
        this.automatic.append(this.acquisitionStatus, this.retry);
        this.manual = element("fieldset", "", "models-vector");
        this.manual.append(element("legend", "Raster layers"));
        this.root.append(attribution, field(`models-${name}-source`, "Input configuration", this.source), this.automatic, this.manual);
        this.help = element("p", "Predictors describe the environment; observed responses describe the habitat condition to model. Each selected raster uses its first band.", "models-help");
        this.help.id = `models-${name}-help`;
        this.manual.append(this.help);
        this.groups = {};
        for (const [role, title, addLabel] of [
            ["predictors", "Predictor rasters", "Add predictor"],
            ["responses", "Observed response rasters", "Add observed response"],
        ]) {
            const group = element("fieldset", "", "models-vector");
            const rows = element("div", "", "models-vector");
            const add = button(addLabel, () => this.addRow(role), "models-action");
            group.append(element("legend", title), rows, add);
            this.groups[role] = {root: group, rows, add};
            this.manual.append(group);
        }
        this.addPredictor = this.groups.predictors.add; this.addResponse = this.groups.responses.add;
        this.categorical = element("select"); this.categorical.required = true;
        this.categorical.addEventListener("change", () => {
            this.categoricalRow = this.categorical.value ? this.predictors.find(row => this.value.predictors[row.index].name === this.categorical.value) : null;
            handlers.onInput(name, {categoricalPredictor: this.categorical.value});
        });
        const categoryHelp = element("p", "Choose the predictor whose values identify categories, such as habitat types. All other predictors are treated as continuous measurements. Nearest neighbor and mode preserve category values; interpolation can create intermediate values.", "models-help");
        categoryHelp.id = `models-${name}-categorical-help`;
        this.categorical.setAttribute("aria-describedby", categoryHelp.id);
        this.status = element("p", "", "models-error"); this.status.setAttribute("role", "status");
        this.manual.append(field(`models-${name}-categorical`, "Categorical predictor", this.categorical), categoryHelp);
        this.root.append(this.status);
    }

    /** Add one explicitly named row without changing the existing choices.
     * @param {"predictors"|"responses"} role Scientific role receiving another raster.
     * @return {void}
     */
    addRow(role) {
        const prefix = role === "predictors" ? "predictor" : "response";
        const names = new Set([...this.value.predictors, ...this.value.responses].map(row => row.name.trim()));
        let number = this.value[role].length + 1;
        while (names.has(`${prefix}_${number}`)) number += 1;
        this.handlers.onInput(this.inputName, {[role]: [...this.value[role], {name: `${prefix}_${number}`, raster: null, resampling: "nearest"}]});
        this[role].at(-1).name.focus();
    }

    /** Replace one row and follow a renamed categorical predictor.
     * @param {"predictors"|"responses"} role Scientific role being edited.
     * @param {Object} controls Stable controls identifying the edited row.
     * @param {{name?:string,raster?:Object|null,resampling?:string}} change New variable name, raster or preparation method.
     * @return {void}
     */
    editRow(role, controls, change) {
        const rows = this.value[role].map((row, index) => index === controls.index ? {...row, ...change} : row);
        const edit = {[role]: rows};
        if (role === "predictors" && controls === this.categoricalRow && change.name !== undefined) edit.categoricalPredictor = change.name;
        this.handlers.onInput(this.inputName, edit);
    }

    /** Remove only the chosen row, preserving other controls and their selections.
     * @param {"predictors"|"responses"} role Scientific role containing the row.
     * @param {Object} controls Stable controls for the removed row.
     * @return {void}
     */
    removeRow(role, controls) {
        const index = controls.index;
        const edit = {[role]: this.value[role].filter((_, position) => position !== index)};
        if (controls === this.categoricalRow) { this.categoricalRow = null; edit.categoricalPredictor = ""; }
        this[role].splice(index, 1); controls.root.remove();
        this.handlers.onInput(this.inputName, edit);
        (this[role][Math.min(index, this[role].length - 1)]?.name ?? this.groups[role].add).focus();
    }

    /** Build a stable row with the shared raster chooser and an editable variable name.
     * @param {"predictors"|"responses"} role Scientific role for the new controls.
     * @return {Object} Row controls; index is updated when earlier rows are removed.
     */
    buildRow(role) {
        const root = this.element("fieldset", "", "models-vector");
        const legend = this.element("legend"); root.append(legend);
        const name = this.element("input"); name.type = "text"; name.required = true; name.spellcheck = false;
        name.setAttribute("aria-describedby", this.help.id);
        const id = `${this.inputName}-${role}-${++this.nextRowId}`;
        root.append(this.field(`models-${id}-name`, "Variable name", name));
        const definition = {type: "raster", label: role === "predictors" ? "Predictor raster" : "Observed response raster"};
        const controls = {root, legend, name, definition, index: this[role].length};
        const raster = this.buildRasterInput(root, id, definition, value => this.editRow(role, controls, {raster: value}),
            resampling => this.editRow(role, controls, {resampling}));
        controls.raster = raster; controls.source = raster.source; controls.resampling = raster.resampling;
        name.addEventListener("input", () => this.editRow(role, controls, {name: name.value}));
        controls.remove = this.button(role === "predictors" ? "Remove predictor" : "Remove response", () => this.removeRow(role, controls), "models-action");
        root.append(controls.remove); this.groups[role].rows.append(root);
        return controls;
    }

    /** Refresh choices and guidance without replacing rows during typing.
     * @param {Object} draft Model setup containing the named stack and shared sources.
     * @param {Object} state Controller snapshot used by the ordinary raster chooser.
     * @return {boolean} Whether the stack can be captured for submission.
     */
    render(draft, state) {
        this.value = draft.inputs[this.inputName];
        const automatic = this.value.kind === "earthEngine", configuration = this.value.configuration;
        this.source.value = this.value.kind;
        this.manual.hidden = this.manual.disabled = automatic;
        this.automatic.hidden = this.automatic.disabled = !automatic;
        this.datasetSources.hidden = !configuration;
        if (configuration && configuration !== this.displayedConfiguration) {
            for (const [role, list] of Object.entries(this.datasetLists)) {
                list.replaceChildren(...configuration.datasets.filter(dataset => dataset.roles.includes(role)).map(dataset => {
                    const item = this.element("li"), link = this.element("a", dataset.label);
                    link.href = dataset.url; link.target = "_blank"; link.rel = "noopener noreferrer";
                    item.append(link); return item;
                }));
            }
            this.displayedConfiguration = configuration;
        }
        this.year.required = automatic;
        this.options(this.year, configuration ? Array.from({length: configuration.maximumYear - configuration.minimumYear + 1},
            (_, index) => ({value: String(configuration.minimumYear + index), label: String(configuration.minimumYear + index)})) :
            [{value: "", label: "Loading years…"}], String(this.value.year ?? ""));
        this.acquisitionStatus.textContent = this.value.loading ? "Loading available years and pixel size…" : this.value.error;
        this.acquisitionStatus.hidden = !this.acquisitionStatus.textContent;
        this.retry.hidden = !this.value.error; this.retry.disabled = this.value.loading;
        for (const role of ["predictors", "responses"]) {
            while (this[role].length < this.value[role].length) this[role].push(this.buildRow(role));
            while (this[role].length > this.value[role].length) this[role].pop().root.remove();
            this[role].forEach((controls, index) => {
                controls.index = index;
                const row = this.value[role][index];
                const label = `${role === "predictors" ? "Predictor" : "Observed response"} ${index + 1}`;
                controls.legend.textContent = label;
                controls.remove.setAttribute("aria-label", `Remove ${label.toLowerCase()}`);
                if (this.document.activeElement !== controls.name) controls.name.value = row.name;
                this.renderRasterInput(controls.raster, controls.definition, {raster: row.raster, resampling: row.resampling,
                    sourceReason: row.raster?.available === false ? "This raster result is no longer available. Choose another input." : "Choose a raster from Map layers or a completed run."}, state);
            });
        }
        if (this.value.categoricalPredictor && this.value.predictors[this.categoricalRow?.index]?.name !== this.value.categoricalPredictor) {
            this.categoricalRow = this.predictors.find(row => this.value.predictors[row.index].name === this.value.categoricalPredictor) ?? null;
        } else if (!this.value.categoricalPredictor && this.categoricalRow && this.value.predictors[this.categoricalRow.index]?.name !== "") {
            this.categoricalRow = null;
        }
        this.options(this.categorical, [{value: "", label: "Choose the categorical predictor…"},
            ...this.value.predictors.filter(row => row.name.trim()).map(row => ({value: row.name, label: row.name}))], this.value.categoricalPredictor);
        let error = "";
        try { captureHabitatStack(this.value, draft.sources); } catch (problem) { error = problem.message; }
        this.status.textContent = error; this.status.hidden = !error;
        return !error;
    }
}
