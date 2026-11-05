/** Choose one output projection and pixel grid for a model's raster inputs. */
import { captureRasterPreparation } from "./inputs.js";

/** Present source-derived grid choices and explicit custom pixel sizes. */
export class RasterGridView {
    /** Build controls using the Models form's existing presentation helpers.
     * @param {Object} helpers Models form helpers and owning document.
     * @param {(tag:string,text?:string,className?:string)=>HTMLElement} helpers.element Create a text-only element.
     * @param {(id:string,caption:string,input:HTMLElement)=>HTMLLabelElement} helpers.field Create a labelled field.
     * @param {(label:string,action:()=>void,className?:string)=>HTMLButtonElement} helpers.button Create a button.
     * @param {(select:HTMLSelectElement,choices:Object[],selected:string)=>void} helpers.options Update select choices.
     * @param {Document} helpers.document Owning document for focused-field preservation.
     * @param {{onInput:(name:string,change:Object)=>void,onRefreshGrid:()=>void}} handlers Draft edits and metadata retry.
     * @param {string} name Declared preparation input name.
     * @param {{label:string}} input Model-provided field label.
     */
    constructor({element, field, button, options, document}, handlers, name, input) {
        Object.assign(this, {options, document});
        this.root = element("fieldset", "", "models-vector");
        this.root.append(element("legend", input.label));
        this.projection = element("select");
        this.projection.addEventListener("change", () => handlers.onInput(name, this.projection.value === "custom"
            ? {projectionMode: "custom"} : {projectionMode: "source", crs: this.projection.value}));
        this.customCrs = element("input"); this.customCrs.type = "text";
        this.customCrs.placeholder = "For example, EPSG:6933";
        this.customCrs.addEventListener("change", () => handlers.onInput(name, {crs: this.customCrs.value.trim()}));
        this.customField = field(`models-${name}-custom-crs`, "Custom projection", this.customCrs);
        this.requirement = element("p", "", "models-help");
        this.resolution = element("select");
        this.resolution.addEventListener("change", () => {
            if (this.resolution.value === "custom") handlers.onInput(name, {mode: "custom"});
            else if (this.resolution.value !== "saved" && this.resolution.value) handlers.onInput(name, {mode: "source", sourceKey: this.resolution.value});
        });
        this.pixelX = element("input"); this.pixelY = element("input");
        for (const [index, control] of [this.pixelX, this.pixelY].entries()) {
            control.type = "number"; control.step = "any"; control.min = "0"; control.required = true;
            control.addEventListener("input", () => {
                const pixelSize = [...this.value.pixelSize];
                pixelSize[index] = control.value === "" ? null : Number(control.value);
                handlers.onInput(name, {mode: "custom", pixelSize});
            });
        }
        this.unit = element("p", "", "models-help");
        this.unit.id = `models-${name}-pixel-unit`;
        this.pixelX.setAttribute("aria-describedby", this.unit.id); this.pixelY.setAttribute("aria-describedby", this.unit.id);
        this.description = element("p", "", "models-help");
        this.status = element("p", "", "models-help"); this.status.setAttribute("role", "status");
        this.retry = button("Retry pixel-size choices", handlers.onRefreshGrid, "models-action");
        this.root.append(field(`models-${name}-projection`, "Output projection", this.projection), this.requirement, this.customField,
            field(`models-${name}-resolution`, "Pixel size", this.resolution),
            field(`models-${name}-pixel-x`, "Pixel width (X)", this.pixelX),
            field(`models-${name}-pixel-y`, "Pixel height (Y)", this.pixelY), this.unit, this.description, this.status, this.retry);
    }

    /** Display the effective grid without overwriting a field while it is being edited.
     * @param {Object} value Preparation draft, choices and optional metadata feedback.
     * @param {Object} draft Model draft used to check the captured grid.
     * @return {boolean} Whether explicit grid values are ready for submission.
     */
    render(value, draft) {
        this.value = value;
        const projections = [...new Set([value.crs, ...value.choices.map(choice => choice.sourceCrs)].filter(Boolean))];
        this.options(this.projection, value.requiredCrs ? [{value: value.requiredCrs, label: value.requiredCrs}] :
            [...projections.map(crs => ({value: crs, label: crs})), {value: "custom", label: "Custom projection…"}],
        value.requiredCrs ?? (value.projectionMode === "custom" ? "custom" : value.crs));
        this.projection.disabled = Boolean(value.requiredCrs);
        this.requirement.hidden = !value.requiredCrs;
        this.requirement.textContent = value.requiredCrs ? `This tool requires ${value.requiredCrs}. Inputs in other projections will be reprojected.` : "";
        this.customField.hidden = Boolean(value.requiredCrs) || value.projectionMode !== "custom";
        this.customCrs.required = !this.customField.hidden;
        if (this.document.activeElement !== this.customCrs) this.customCrs.value = value.crs;
        const format = number => number.toLocaleString(undefined, {maximumSignificantDigits: 6});
        const choices = [{value: "", label: "Choose a source pixel size…", disabled: true},
            ...value.choices.map(choice => ({value: choice.key,
                label: `${choice.label}: ${choice.grid.approximate ? "approximately " : ""}${choice.grid.pixelSize.map(format).join(" × ")} ${choice.grid.unit}`})),
            {value: "custom", label: "Custom pixel size"}];
        if (value.mode === "saved" || value.mode === "source" && !value.choices.some(choice => choice.key === value.sourceKey)) {
            choices.push({value: "saved", label: "Chosen grid (values below)"});
        }
        const selected = value.mode === "custom" ? "custom" : value.mode === "saved" ||
            value.mode === "source" && !value.choices.some(choice => choice.key === value.sourceKey) ? "saved" : value.sourceKey;
        this.options(this.resolution, choices, selected);
        [this.pixelX, this.pixelY].forEach((control, index) => {
            control.readOnly = !["custom", "saved"].includes(value.mode);
            if (this.document.activeElement !== control) control.value = value.pixelSize[index] ?? "";
        });
        this.unit.textContent = value.unit ? `Unit: ${value.unit}.` : "Pixel sizes use the output projection's coordinate units.";
        const choice = value.choices.find(option => option.key === value.sourceKey);
        this.description.textContent = ["auto", "source"].includes(value.mode) && choice?.grid.approximate
            ? "This pixel size is an approximation at the source's center, not a uniform conversion across the source." : "";
        this.description.hidden = !this.description.textContent;
        let error = "";
        try { captureRasterPreparation(value, draft); } catch (problem) { error = problem.message; }
        this.status.textContent = value.loading ? "Loading pixel-size choices…" : value.error ?
            `Some pixel-size choices could not be loaded. Retry or enter a custom size. ${value.error}` : error;
        this.status.hidden = !this.status.textContent;
        this.retry.hidden = !value.error; this.retry.disabled = value.loading;
        return !error;
    }
}
