/** Local display controls shared by ordinary histograms and paired marginals. */
import { defaultHistogramAxisOptions, resolveHistogramAxis } from "./histogram-axis-scale.js";
import { formatRasterPixelValue } from "./value-format.js";

/**
 * Display controls for choosing histogram axis limits and linear or log scales.
 * Validate entered settings and notify the chart to redraw when they are valid.
 * The caller retains settings so they can be reapplied when the sample changes.
 */
export class HistogramAxisControls {
    /**
     * @param {Document} documentContext Element factory.
     * @param {Object[]} definitions Axis key, label and histogram distribution.
     * @param {{options?:Object,open?:boolean}} state Owner-retained display settings.
     * @param {(axes:Object)=>void} onChange Redraw only the existing sample.
     */
    constructor(documentContext, definitions, state, onChange) {
        this.documentContext = documentContext;
        this.definitions = definitions;
        this.state = state;
        this.state.options ??= {};
        this.onChange = onChange;
        this.timer = null;
        this.enabled = true;
        this.root = documentContext.createElement("details");
        this.root.className = "histogram-axis-controls";
        this.root.open = state.open ?? false;
        this.root.addEventListener("toggle", () => { state.open = this.root.open; });
        const summary = documentContext.createElement("summary");
        summary.textContent = "Axes & scale";
        this.summary = summary;
        this.root.append(summary);
        this.rows = new Map();
        for (const definition of definitions) {
            state.options[definition.key] ??= defaultHistogramAxisOptions();
            this.#addRow(definition);
        }
        const help = documentContext.createElement("p");
        help.className = "histogram-axis-help";
        help.textContent = "Values use the labeled axis units. Value percentiles are estimated from sampled bins. " +
            "Bar-height percentiles interpolate the sorted non-empty bar heights; empty bins are excluded. " +
            "These controls change the display only, not sampling, binning or raster colors.";
        help.textContent += " Off-scale style markers are pinned to the plot edge; nonpositive markers cannot appear on log axes.";
        this.root.append(help);
        const reset = documentContext.createElement("button");
        reset.type = "button";
        reset.className = "secondary-button";
        reset.textContent = "Reset axes";
        this.reset = reset;
        reset.addEventListener("click", () => {
            if (!this.enabled) return;
            clearTimeout(this.timer);
            for (const definition of this.definitions) {
                this.state.options[definition.key] = defaultHistogramAxisOptions();
                this.#writeRow(definition.key);
            }
            this.axes = this.#resolve();
            this.onChange(this.axes);
        });
        this.root.append(reset);
        this.axes = this.#resolve();
    }

    /**
     * Add the Scale and Range dropdowns, Min/Max number inputs, and status text
     * for one axis. Standard HTML select and input elements provide keyboard
     * navigation and editing without custom key handlers.
     * @param {Object} definition Axis key, label and distribution.
     * @return {void}
     */
    #addRow(definition) {
        const doc = this.documentContext;
        const fieldset = doc.createElement("fieldset");
        const legend = doc.createElement("legend");
        legend.textContent = definition.label;
        fieldset.append(legend);
        const fields = {};
        for (const [name, label, choices] of [
            ["scale", "Scale", [["linear", "Linear"], ["log", "Log"]]],
            ["bounds", "Range", [["auto", "Auto"], ["values", "Values"], ["percentiles", "Percentiles"]]],
            ["minimum", "Min", null], ["maximum", "Max", null],
        ]) {
            const wrapper = doc.createElement("label");
            const text = doc.createElement("span");
            text.textContent = label;
            const input = doc.createElement(choices ? "select" : "input");
            input.setAttribute("aria-label", `${definition.label}: ${label}`);
            if (choices) {
                for (const [value, caption] of choices) {
                    const option = doc.createElement("option");
                    option.value = value;
                    option.textContent = caption;
                    input.append(option);
                }
            } else {
                input.type = "number";
                input.step = "any";
            }
            input.addEventListener("change", () => {
                if (name === "bounds" && input.value !== "auto") {
                    const axis = this.axes[definition.key];
                    fields.minimum.input.value = input.value === "percentiles" ? "0" : String(axis.minimum);
                    fields.maximum.input.value = input.value === "percentiles" ? "100" : String(axis.maximum);
                }
                this.#edit();
            });
            if (!choices) input.addEventListener("input", () => {
                clearTimeout(this.timer);
                this.timer = setTimeout(() => this.#edit(), 200);
            });
            wrapper.append(text, input);
            fieldset.append(wrapper);
            fields[name] = { input, wrapper };
        }
        const status = doc.createElement("p");
        status.className = "histogram-axis-status";
        status.setAttribute("role", "status");
        fieldset.append(status);
        this.rows.set(definition.key, { fields, status });
        this.root.append(fieldset);
        this.#writeRow(definition.key);
    }

    /**
     * Restore one row from accepted settings.
     * @param {string} key Axis key.
     * @return {void}
     */
    #writeRow(key) {
        const { fields } = this.rows.get(key);
        for (const name of Object.keys(fields)) fields[name].input.value = this.state.options[key][name];
        this.#rangeFields(key);
    }

    /**
     * Show min/max only for explicit limits, labeling percentile inputs.
     * @param {string} key Axis key.
     * @return {void}
     */
    #rangeFields(key) {
        const { fields } = this.rows.get(key);
        const mode = fields.bounds.input.value;
        for (const name of ["minimum", "maximum"]) {
            fields[name].wrapper.hidden = mode === "auto";
            fields[name].input.placeholder = mode === "percentiles" ? (name === "minimum" ? "P0" : "P100") : "";
        }
    }

    /**
     * Resolve stored settings for a new sample. If no valid domain remains,
     * use Auto/Linear for that axis and explicitly report the temporary fallback.
     * @return {Object} Resolved axes by key.
     */
    #resolve() {
        let fallback = false;
        const axes = Object.fromEntries(this.definitions.map(definition => {
            const { status } = this.rows.get(definition.key);
            let axis, warning = "";
            try {
                axis = resolveHistogramAxis(definition, this.state.options[definition.key]);
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                fallback = true;
                warning = `${error.message} Showing Auto/Linear for this sample. `;
                axis = resolveHistogramAxis(definition);
            }
            status.textContent = warning + this.#describe(axis);
            return [definition.key, axis];
        }));
        this.#labelSummary(axes, fallback);
        return axes;
    }

    /**
     * Keep display changes and temporary fallback visible when controls are closed.
     * @param {Object} axes Resolved transforms.
     * @param {boolean} [fallback=false] Whether a requested range failed for this sample.
     * @return {void}
     */
    #labelSummary(axes, fallback = false) {
        const notes = [];
        if (fallback) notes.push("using Auto/Linear");
        if (Object.values(axes).some(axis => axis.scale === "log")) notes.push("log");
        if (Object.values(axes).some(axis => axis.notice.includes("clipped"))) notes.push("clipped");
        this.summary.textContent = "Axes & scale" + (notes.length ? " · " + notes.join(" · ") : "");
    }

    /**
     * Explain resolved numeric limits and any clipped or omitted data.
     * @param {Object} axis Resolved display transform.
     * @return {string} User-visible axis description.
     */
    #describe(axis) {
        return `${axis.scale === "log" ? "Log" : "Linear"}: ${formatRasterPixelValue(axis.minimum)} to ` +
            `${formatRasterPixelValue(axis.maximum)}. ${axis.notice}`;
    }

    /** Validate an edit before redrawing; preserve the usable chart on error. @return {void} */
    #edit() {
        clearTimeout(this.timer);
        if (!this.enabled) return;
        const options = {}, axes = {};
        let invalid = false;
        for (const definition of this.definitions) {
            const { fields, status } = this.rows.get(definition.key);
            this.#rangeFields(definition.key);
            const option = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.input.value]));
            try {
                const axis = resolveHistogramAxis(definition, option);
                axes[definition.key] = axis;
                options[definition.key] = option;
                status.textContent = this.#describe(axis);
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                status.textContent = error.message + " Chart unchanged.";
                invalid = true;
            }
        }
        if (invalid) {
            for (const { status } of this.rows.values()) {
                if (!status.textContent.endsWith("Chart unchanged.")) status.textContent += " Chart unchanged.";
            }
            return;
        }
        this.state.options = options;
        this.axes = axes;
        this.#labelSummary(axes);
        this.onChange(axes);
    }

    /**
     * Disable edits while the owning histogram awaits a new sample.
     * @param {boolean} enabled Whether the current chart can be edited.
     * @return {void}
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) clearTimeout(this.timer);
        for (const { fields } of this.rows.values()) {
            for (const { input } of Object.values(fields)) input.disabled = !enabled;
        }
        this.reset.disabled = !enabled;
    }

    /** Stop pending edits when the owning chart is replaced or cleared. @return {void} */
    dispose() {
        this.setEnabled(false);
        clearTimeout(this.timer);
        this.onChange = () => {};
    }
}
