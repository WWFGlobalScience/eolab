import { buildLegendContents, buildLegendSymbol } from "./legend-view.js";

/** Present the retained layers' symbol keys on the map without owning their styles. */
export class OnMapLegend {
    /**
     * Attach an upper-left legend and connect the map's show/hide command.
     * @param {Object} leaflet Leaflet namespace.
     * @param {Object} map Leaflet map.
     * @param {Object} options Composition callbacks and controls.
     * @param {HTMLButtonElement} options.toggleButton Persistent show/hide command in More.
     * @param {(key:string,included:boolean)=>void} options.onInclusion Change one layer's legend setting.
     * @param {()=>void} options.onChange Remember legend visibility or collapse changes.
     */
    constructor(leaflet, map, { toggleButton, onInclusion, onChange }) {
        this.document = map.getContainer().ownerDocument;
        this.onInclusion = onInclusion;
        this.onChange = onChange;
        this.toggleButton = toggleButton;
        this.visible = true;
        this.collapsed = false;
        this.signature = null;
        this.root = this.document.createElement("section");
        this.root.className = "on-map-legend";
        this.root.setAttribute("aria-label", "Map legend");
        const header = this.document.createElement("header");
        this.collapse = this.document.createElement("button");
        this.collapse.type = "button";
        this.collapse.className = "on-map-legend-heading";
        this.collapse.addEventListener("click", () => {
            this.collapsed = !this.collapsed;
            this.refreshVisibility();
            this.onChange();
        });
        const hide = this.document.createElement("button");
        hide.type = "button";
        hide.textContent = "×";
        hide.title = "Hide legend; restore from More";
        hide.setAttribute("aria-label", "Hide map legend");
        hide.addEventListener("click", () => {
            this.visible = false;
            this.refreshVisibility();
            this.toggleButton.closest("details").open = true;
            this.toggleButton.focus();
            this.onChange();
        });
        header.append(this.collapse, hide);
        this.body = this.document.createElement("div");
        this.body.className = "on-map-legend-body";
        this.chooser = this.document.createElement("details");
        const summary = this.document.createElement("summary");
        summary.textContent = "Choose layers";
        this.choices = this.document.createElement("div");
        this.choices.className = "on-map-legend-choices";
        this.chooser.append(summary, this.choices);
        this.contents = this.document.createElement("div");
        this.contents.className = "on-map-legend-entries";
        this.body.append(this.chooser, this.contents);
        this.root.append(header, this.body);
        this.onToggle = () => {
            this.visible = !this.visible;
            this.refreshVisibility();
            if (this.visible) this.collapse.focus();
            this.toggleButton.closest("details").open = false;
            this.onChange();
        };
        toggleButton.addEventListener("click", this.onToggle);
        leaflet.DomEvent.disableClickPropagation(this.root);
        leaflet.DomEvent.disableScrollPropagation(this.root);
        this.root.addEventListener("keydown", event => event.stopPropagation());
        this.control = leaflet.control({ position: "topleft" });
        /** Return the legend DOM to Leaflet. @return {HTMLElement} Legend root. */
        this.control.onAdd = () => this.root;
        this.control.addTo(map);
        this.map = map;
        this.resize = () => this.updateLayout();
        map.on("resize", this.resize);
        this.updateLayout();
        this.refreshVisibility();
    }

    /**
     * Display visible, included layers in map order; keep all loaded layers in the chooser.
     * Layer snapshots contain only presentation data from their owning adapters.
     * @param {Object[]} layers Top-first retained layer snapshots.
     * @return {void}
     */
    update(layers) {
        const entries = layers.filter(layer => layer.legend).map(layer => ({
            key: layer.key, label: layer.label, visible: layer.visible,
            included: layer.legendIncluded !== false,
            opacity: layer.effectiveOpacity ?? layer.opacity, legend: layer.legend,
        }));
        const signature = JSON.stringify(entries);
        if (signature === this.signature) return;
        this.signature = signature;
        const focusedKey = this.document.activeElement?.dataset?.legendKey;
        const choices = [];
        const legends = [];
        for (const layer of entries) {
            const label = this.document.createElement("label");
            const input = this.document.createElement("input");
            input.type = "checkbox";
            input.checked = layer.included;
            input.dataset.legendKey = layer.key;
            input.addEventListener("change", () => this.onInclusion(layer.key, input.checked));
            const name = this.document.createElement("span");
            name.textContent = `${layer.label}${layer.visible ? "" : " (hidden on map)"}`;
            label.append(input, name);
            choices.push(label);
            if (!layer.visible || !layer.included) continue;
            const section = this.document.createElement("section");
            section.className = "on-map-legend-layer";
            const title = this.document.createElement("strong");
            title.textContent = layer.label;
            if (layer.legend.kind === "fixed" && layer.legend.symbol) {
                section.classList.add("on-map-legend-layer--fixed");
                const swatch = this.document.createElement("span");
                swatch.className = "map-layer-legend-swatch";
                swatch.setAttribute("aria-hidden", "true");
                swatch.append(buildLegendSymbol(this.document, layer.legend.symbol, layer.opacity));
                section.append(swatch, title);
            } else {
                section.append(title, buildLegendContents(this.document, layer.legend, layer.opacity, true));
            }
            legends.push(section);
        }
        this.choices.replaceChildren(...choices);
        this.contents.replaceChildren(...legends);
        if (!legends.length) {
            const empty = this.document.createElement("p");
            empty.textContent = entries.length ? "Choose visible layers to include in the legend." : "Add a map layer to see its legend.";
            this.contents.append(empty);
        }
        for (const label of choices) {
            if (label.children[0].dataset.legendKey === focusedKey) label.children[0].focus({ preventScroll: true });
        }
        this.updateLayout();
    }

    /** Update disclosure and the persistent More command. @return {void} */
    refreshVisibility() {
        this.root.hidden = !this.visible;
        this.body.hidden = this.collapsed;
        this.collapse.textContent = `${this.collapsed ? "▸" : "▾"} Legend`;
        this.collapse.setAttribute("aria-expanded", String(!this.collapsed));
        this.toggleButton.textContent = this.visible ? "Hide legend" : "Show legend";
        this.toggleButton.setAttribute("aria-pressed", String(this.visible));
        this.updateLayout();
    }

    /** Use extra columns only when the keys grow tall; leave room for map tools. @return {void} */
    updateLayout() {
        const { x: width, y: height } = this.map.getSize();
        const available = Math.max(80, Math.min(660, width - (width >= 900 ? 400 : 40)));
        const contentHeight = [...this.contents.children].reduce((total, node) => total + node.offsetHeight + 12, 0);
        const columns = Math.min(Math.max(1, Math.floor(available / 216)), Math.max(1, Math.ceil(contentHeight / Math.max(180, height * 0.45))));
        this.root.style.maxWidth = `${available}px`;
        this.root.style.width = this.collapsed ? "auto" : `${columns * 216}px`;
        this.contents.style.columnCount = String(columns);
        this.root.style.marginTop = width < 900 ? "70px" : "10px";
    }

    /** @return {{visible:boolean,collapsed:boolean}} Portable legend presentation preferences. */
    snapshot() { return { visible: this.visible, collapsed: this.collapsed }; }

    /**
     * Restore validated presentation preferences from the saved-map owner.
     * @param {{visible:boolean,collapsed:boolean}} state Validated legend preferences.
     * @return {void}
     */
    restore(state) {
        this.visible = state.visible;
        this.collapsed = state.collapsed;
        this.refreshVisibility();
    }

    /** Remove the map control and its external event listener. @return {void} */
    remove() {
        this.map.off("resize", this.resize);
        this.toggleButton.removeEventListener("click", this.onToggle);
        this.control.remove();
    }
}
