/** Inline annotation controls hosted by the existing map-layer list. */
import { matchingAnnotationPolygons } from "./model.js";

/** Present one local annotation layer and forward edits to its owner. */
export class AnnotationLayerControls {
    /**
     * Build stable layer controls; notes and names are always plain text.
     * @param {Document} document Browser document.
     * @param {import("./model.js").AnnotationLayer} layer Annotation data.
     * @param {Object} actions Named callbacks: add, edit, removePolygon, change, opacity.
     */
    constructor(document, layer, actions) {
        this.document = document;
        this.layer = layer;
        this.actions = actions;
        this.root = document.createElement("div");
        this.root.className = "annotation-layer-controls";
        this.name = this.input("Layer name", "text", layer.name, value => {
            layer.name = value.trim() || "Annotations";
            actions.change(false);
        }, 160);
        this.root.append(this.name);
        const buttons = document.createElement("div");
        buttons.className = "annotation-actions";
        buttons.append(this.button("Add polygon", actions.add));
        const share = this.button("Share", () => {});
        share.disabled = true;
        share.title = "Workshop sharing is coming later. These annotations stay on this device.";
        buttons.append(share);
        this.root.append(buttons);
        this.appearance = this.details("Annotation style");
        this.styleInputs = {};
        for (const [key, label, type] of [["color", "Fill color", "color"], ["outline", "Outline color", "color"],
            ["weight", "Outline width", "number"], ["fillOpacity", "Fill opacity", "number"], ["labels", "Show polygon names", "checkbox"]]) {
            const wrapper = this.input(label, type, layer.style[key], value => {
                layer.style[key] = type === "number" ? Number(value) : value;
                actions.change();
            });
            const input = wrapper.querySelector("input");
            if (type === "number") { input.min = "0"; input.max = key === "weight" ? "10" : "1"; input.step = key === "weight" ? "0.5" : "0.05"; }
            this.styleInputs[key] = input;
            this.appearance.append(wrapper);
        }
        const opacity = this.input("Layer opacity", "range", layer.opacity, value => actions.opacity(Number(value)));
        this.opacity = opacity.querySelector("input");
        this.opacity.min = "0"; this.opacity.max = "1"; this.opacity.step = "0.05";
        this.appearance.append(opacity);
        this.filter = this.details("Filter polygons");
        this.filter.append(this.input("Name or note contains", "search", layer.filter, value => {
            layer.filter = value;
            actions.change();
        }, 300));
        this.polygons = this.details("Polygons");
        this.polygons.open = true;
        this.polygonList = document.createElement("ul");
        this.polygons.append(this.polygonList);
        this.root.append(this.appearance, this.filter, this.polygons);
        this.refresh();
    }

    /**
     * Create a labeled input without using user text as HTML.
     * @param {string} label Accessible and visible label.
     * @param {string} type HTML input type.
     * @param {string|number|boolean} value Initial value.
     * @param {(value:string|boolean)=>void} onChange Change callback.
     * @param {number} [maxLength=300] Text limit.
     * @return {HTMLLabelElement} Label and input.
     */
    input(label, type, value, onChange, maxLength = 300) {
        const wrapper = this.document.createElement("label");
        wrapper.className = "annotation-field";
        const text = this.document.createElement("span");
        text.textContent = label;
        const input = this.document.createElement("input");
        input.type = type;
        input.maxLength = maxLength;
        if (type === "checkbox") input.checked = value;
        else input.value = value;
        input.addEventListener(type === "text" ? "input" : "change", () => {
            if (input.validity && !input.validity.valid) { input.reportValidity(); return; }
            onChange(type === "checkbox" ? input.checked : input.value);
        });
        wrapper.append(text, input);
        return wrapper;
    }

    /**
     * Create a layer action button.
     * @param {string} text Visible action.
     * @param {()=>void} onClick Action callback.
     * @return {HTMLButtonElement} Button.
     */
    button(text, onClick) {
        const button = this.document.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = text;
        button.addEventListener("click", onClick);
        return button;
    }

    /**
     * Create an initially collapsed disclosure.
     * @param {string} text Disclosure heading.
     * @return {HTMLDetailsElement} Disclosure.
     */
    details(text) {
        const details = this.document.createElement("details");
        const summary = this.document.createElement("summary");
        summary.textContent = text;
        details.append(summary);
        return details;
    }

    /**
     * Refresh polygon rows and appearance after a committed edit or undo.
     * @param {string|null} [focusPolygon=null] Polygon whose name should receive focus.
     * @return {void}
     */
    refresh(focusPolygon = null) {
        this.name.querySelector("input").value = this.layer.name;
        for (const [key, input] of Object.entries(this.styleInputs)) {
            if (input.type === "checkbox") input.checked = this.layer.style[key];
            else input.value = this.layer.style[key];
        }
        this.opacity.value = this.layer.opacity;
        const polygons = matchingAnnotationPolygons(this.layer);
        this.polygons.querySelector("summary").textContent = this.layer.filter
            ? `${polygons.length} of ${this.layer.polygons.length} polygons` : `${polygons.length} ${polygons.length === 1 ? "polygon" : "polygons"}`;
        this.polygonList.replaceChildren(...polygons.map(polygon => this.polygonRow(polygon)));
        if (!polygons.length) {
            const empty = this.document.createElement("li");
            empty.textContent = this.layer.filter ? "No polygons match the filter." : "Choose Add polygon to start drawing.";
            this.polygonList.append(empty);
        }
        if (focusPolygon) {
            this.polygons.open = true;
            this.polygonList.querySelector(`[data-polygon-id="${focusPolygon}"] input`)?.focus();
        }
    }

    /**
     * Render a polygon's name, geometry actions and optional text note.
     * @param {import("./model.js").AnnotationPolygon} polygon Saved polygon.
     * @return {HTMLLIElement} Annotation row.
     */
    polygonRow(polygon) {
        const row = this.document.createElement("li");
        row.dataset.polygonId = polygon.id;
        const name = this.input("Polygon name", "text", polygon.name, value => {
            polygon.name = value.trim() || "Polygon";
            this.actions.change(false);
        }, 160);
        const actions = this.document.createElement("div");
        actions.className = "annotation-actions";
        const note = this.document.createElement("label");
        note.className = "annotation-field";
        note.hidden = !polygon.note;
        const label = this.document.createElement("span");
        label.textContent = "Note";
        const textarea = this.document.createElement("textarea");
        textarea.rows = 3;
        textarea.maxLength = 10000;
        textarea.value = polygon.note;
        textarea.addEventListener("input", () => { polygon.note = textarea.value; this.actions.change(false); });
        note.append(label, textarea);
        actions.append(this.button("Edit", () => this.actions.edit(polygon.id)), this.button(polygon.note ? "Edit note" : "Add note", () => {
            note.hidden = false; textarea.focus();
        }), this.button("Delete", () => this.actions.removePolygon(polygon.id)));
        row.append(name, actions, note);
        return row;
    }

    /**
     * Reveal a requested layer control in place, without opening another panel.
     * @param {"style"|"filter"|"info"} control Requested control.
     * @return {void}
     */
    open(control) {
        const details = control === "style" ? this.appearance : control === "filter" ? this.filter : this.polygons;
        details.open = true;
        details.scrollIntoView({ block: "nearest" });
        (details.querySelector("input") ?? details.querySelector("summary"))?.focus();
    }
}
