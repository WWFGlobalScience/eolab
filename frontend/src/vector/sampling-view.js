/** DOM adapter for selecting a filtered polygon layer as the sampling area. */
export class VectorSamplingView {
    /**
     * Create a view over one placement of the shared vector controls.
     * @param {Document} [documentContext=document] Owning document.
     * @param {Object} [options] Mount selectors supplied by browser composition.
     * @param {string} [options.root="#vector-sampling"] Control container selector.
     * @param {string|null} [options.choice="#use-vector-for-raster"] Optional disclosure opener.
     * @param {string|null} [options.disclosure="#vector-sampling-disclosure"] Optional disclosure.
     */
    constructor(documentContext = document, { root = "#vector-sampling", choice = "#use-vector-for-raster", disclosure = "#vector-sampling-disclosure" } = {}) {
        this.document = documentContext;
        this.root = documentContext.querySelector(root);
        this.elements = Object.fromEntries(["layer", "filter", "use", "confirm", "remove", "status", "predicate"]
            .map(name => [name, documentContext.querySelector(`${root} [data-vector-sampling="${name}"]`)]));
        this.useLabel = this.elements.use.textContent;
        this.choice = choice ? documentContext.querySelector(choice) : null;
        this.disclosure = disclosure ? documentContext.querySelector(disclosure) : null;
        this.abort = new AbortController();
    }
    /** @param {Object} handlers Semantic layer, selection and review handlers. */
    bind(handlers) {
        const on = (element, event, callback) => element.addEventListener(event, callback, { signal: this.abort.signal });
        on(this.elements.layer, "change", () => handlers.onLayer(this.elements.layer.value));
        for (const [name, handler] of [["use", "onUse"], ["confirm", "onConfirm"], ["remove", "onRemove"], ["filter", "onFilter"]]) {
            on(this.elements[name], "click", () => handlers[handler]());
        }
        if (this.choice && this.disclosure) on(this.choice, "change", () => { this.disclosure.open = true; this.elements.layer.focus(); });
    }
    /**
     * Show selection progress or a prominent large-area confirmation.
     * @param {Object} state Current targets, selected layer, phase and message.
     * @return {void}
     */
    render(state) {
        const signature = JSON.stringify(state.targets.map(target => [target.key, target.label]));
        if (signature !== this.signature) {
            this.signature = signature;
            this.elements.layer.replaceChildren(...state.targets.map(target => {
                const option = this.document.createElement("option"); option.value = target.key; option.textContent = target.label; return option;
            }));
        }
        this.elements.layer.value = state.key;
        this.elements.predicate.textContent = state.filterSummary;
        this.elements.status.textContent = state.targets.length ? state.message : "Add a Shapefile or GeoPackage polygon layer to the map first.";
        const reviewing = ["review", "confirm"].includes(state.phase);
        this.elements.status.setAttribute("role", reviewing ? "alert" : "status");
        this.elements.status.classList.toggle("vector-selection-warning", reviewing);
        this.elements.status.classList.toggle("is-working", state.phase === "reading");
        this.elements.use.disabled = !state.key || state.phase === "reading";
        this.elements.use.textContent = state.phase === "reading" ? "Reading selected features…" : this.useLabel;
        this.elements.filter.disabled = !state.key;
        this.elements.use.hidden = !!state.analysis || ["review", "confirm"].includes(state.phase);
        this.elements.confirm.hidden = !["review", "confirm"].includes(state.phase);
        this.elements.confirm.textContent = state.phase === "confirm" ? "Yes, use this near-global selection" : "Continue with these features";
        this.elements.remove.hidden = !state.area && state.phase !== "reading";
        this.elements.remove.textContent = state.phase === "reading" ? "Cancel" : "Clear selection";
        this.root.setAttribute("aria-busy", String(state.phase === "reading"));
    }
    /** Remove listeners installed by this view. */
    unbind() { this.abort.abort(); }
}
