import { buildLegendSymbol, buildLegendGradient, buildLegendContents } from "./legend-view.js";

/**
 * Accessible DOM presentation for the retained map-layer stack.
 *
 * This adapter renders top-first keyed rows and forwards visibility,
 * styling, ordering, and removal intent. It does not publish
 * datasets, enforce state invariants, or manipulate Leaflet layers.
 */

/**
 * @typedef {Object} LegendSymbol
 * @property {"polygon"|"line"|"point"} shape Geometry represented by the key.
 * @property {string|null} fill Fill color; null for lines.
 * @property {number} fillOpacity Fill opacity before whole-layer opacity.
 * @property {string} stroke Outline or line color.
 * @property {number} strokeOpacity Stroke opacity before whole-layer opacity.
 * @property {number} strokeWidth Stroke width in pixels.
 * @property {number|null} [pointSize] Point diameter in pixels.
 *
 * @typedef {Object} LayerLegend
 * @property {"fixed"|"gradient"|"categories"|"graduated"} kind Legend presentation.
 * @property {string} [label] Geometry name, classified field, or raster context.
 * @property {LegendSymbol} [symbol] Fixed symbol.
 * @property {{label:string,symbol:LegendSymbol}[]} [entries] Class labels and their symbols.
 * @property {string} [gradient] CSS color ramp supplied by the raster owner.
 * @property {number[]} [labels] Minimum, midpoint, and maximum raster values.
 * @property {string} [description] Accessible description of a raster ramp.
 *
 * @typedef {Object} MapLayerStackSnapshot
 * @property {string} key Stable retained-layer identity.
 * @property {string} label Current display name.
 * @property {{collection:string,id:string}|null} item Catalog identity, or null for an owner-supplied layer.
 * @property {string} datasetKind Owner-reported layer type.
 * @property {boolean} visible Independent map visibility.
 * @property {number} opacity Whole-layer opacity.
 * @property {number} [effectiveOpacity] Display opacity when the owner locks opacity.
 * @property {LayerLegend|null} legend Owner-supplied legend appearance.
 * @property {boolean} [legendIncluded] Include in the map legend unless false.
 * @property {{canCopy:boolean,canPaste:boolean,sourceLabel:string|null,pasteReason:string|null}} [styleClipboard] Owner-reported style compatibility.
 * @property {string|null} error Visible layer failure, when present.
 * @property {string|null} [sourceName] Current source name for resetting custom names; null for owner-specific editors.
 * @property {boolean} [canFilter] Owner supports filtering.
 * @property {boolean} [canInfo] Omit the details action when false.
 * @property {boolean} [canAddView] Offer an independent view of the same source.
 * @property {boolean} [addingView] The requested additional view is being prepared.
 * @property {boolean} [filterActive] A filter is currently applied.
 * @property {string} [filterStatus] Actionable filter result summary.
 * @property {{label:string,description:string}|null} [roleBadge] Analysis role supplied by the owner.
 * @property {string} [typeLabel] Owner-supplied type or origin label.
 * @property {string} [attribution] Shared-layer provenance.
 * @property {{id:string,label:string,actionLabel?:string}} [group] Owner-supplied grouping and optional composed action; headers follow contiguous drawing order.
 * @property {string} [stylePanelId] Owning style panel identifier.
 * @property {HTMLElement} [detailsControl] Retained owner action replacing Catalog Info.
 * @property {HTMLElement} [primaryControl] Retained owner main action.
 * @property {HTMLElement} [controls] Retained owner controls below the action strip.
 */

/**
 * Resolve one required stack element.
 *
 * @param {Document} documentContext Application document.
 * @param {string} selector Required selector.
 * @return {Element} Matching element.
 * @throws {Error} If the markup violates the stack view contract.
 */
function requireLayerStackElement(documentContext, selector) {
    const element = documentContext.querySelector(selector);
    if (element === null) {
        throw new Error(`Required map layer-stack element is missing: ${selector}`);
    }
    return element;
}

/**
 * @typedef {Object} MapLayerStackViewHandlers
 * @property {(key: string) => void} onStyle Open one retained layer style editor.
 * @property {(key: string) => void} [onFilter] Open an adapter-supported filter editor.
 * @property {(key: string) => void} [onDownload] Review a raster clip through composition.
 * @property {(key: string) => void} [onCalculate] Open raster summarization through composition.
 * @property {(key: string) => void} [onAddView] Add an independent view of the same source.
 * @property {(key: string) => void} onZoom Fit the map to one retained layer.
 * @property {(key: string) => void} onInfo Open one retained layer's Catalog
 * Item details.
 * @property {(id:string)=>void} [onGroupAction] Open the owner-supplied group action through composition.
 * @property {(key: string) => void} onCopyStyle Copy one retained layer style.
 * @property {(key: string) => void} onPasteStyle Paste onto one retained layer.
 * @property {(key: string, visible: boolean) => void} onVisibility Change
 * map visibility.
 * @property {(key:string,included:boolean)=>void} onLegendInclusion Include a layer in the on-map legend.
 * @property {(visible: boolean) => void} onAllVisibility Show or hide every
 * retained layer.
 * @property {(key: string, targetIndex: number) => void} onReorder Move one
 * layer to a zero-based top-first position.
 * @property {(order:"name-ascending"|"name-descending"|"visible-first"|"layer-type")=>void} onSort Sort the drawing stack once.
 * @property {(key:string,name:string|null)=>void} onRename Set a catalog layer's custom name; null restores its source name.
 * @property {(key: string) => void} onRemove Remove one retained layer.
 * @property {()=>void} onUndoRemove Restore the most recently removed layer.
 * @property {()=>void} onDismissRemoval Forget the layer-removal Undo offer.
 */

/** Own the map layer-list elements and their direct event listeners. */
export class MapLayerStackView {
    /**
     * Resolve the layer-stack markup and persistent map filter strip.
     *
     * @param {Document} [documentContext=globalThis.document] Application
     * document.
     * @param {Object} [options] Layer-list presentation options.
     * @param {boolean} [options.allowRemoval=true] Offer additional views, removal and Undo.
     */
    constructor(documentContext = globalThis.document, { allowRemoval = true } = {}) {
        this.allowRemoval = allowRemoval;
        this.documentContext = documentContext;
        this.filterIndicators = documentContext.querySelector("#map-filter-indicators");
        /** @type {Map<string,{root:HTMLDivElement,label:HTMLElement,summary:HTMLSpanElement,edit:HTMLButtonElement}>} Stable filter controls in the persistent map toolbar. */
        this.filterStrips = new Map();
        this.root = requireLayerStackElement(
            documentContext,
            "#raster-layer-stack"
        );
        this.list = requireLayerStackElement(
            documentContext,
            "#raster-layer-list"
        );
        this.status = requireLayerStackElement(
            documentContext,
            "#raster-layer-stack-status"
        );
        this.counts = requireLayerStackElement(
            documentContext,
            "#map-layer-counts"
        );
        this.showAll = requireLayerStackElement(documentContext, "#map-layers-show-all");
        this.hideAll = requireLayerStackElement(documentContext, "#map-layers-hide-all");
        this.showAll.addEventListener("click", () => this.handlers?.onAllVisibility(true));
        this.hideAll.addEventListener("click", () => this.handlers?.onAllVisibility(false));
        this.sort = requireLayerStackElement(documentContext, "#map-layers-sort");
        this.sort.addEventListener("change", () => {
            const order = this.sort.value;
            this.sort.value = "";
            if (order) this.handlers?.onSort(order);
        });
        this.removalNotice = requireLayerStackElement(documentContext, "#map-layer-removal");
        this.removalMessage = requireLayerStackElement(documentContext, "#map-layer-removal-message");
        this.undoRemove = requireLayerStackElement(documentContext, "#undo-layer-removal");
        this.undoRemove.addEventListener("click", () => this.handlers?.onUndoRemove());
        this.removalError = requireLayerStackElement(documentContext, "#map-layer-removal-error");
        this.dismissRemoval = requireLayerStackElement(documentContext, "#dismiss-layer-removal");
        this.dismissRemoval.addEventListener("click", () => this.handlers?.onDismissRemoval());
        this.removalIndex = 0;
        this.scrollContainer = this.root.parentElement ?? this.list;
        /** @type {MapLayerStackViewHandlers|null} */
        this.handlers = null;
        /** @type {{key:string,sourceIndex:number,targetIndex:number,pointerId:number}|null} */
        this.pointerDrag = null;
        /** @type {{key:string,originIndex:number}|null} */
        this.keyboardDrag = null;
        /** @type {Map<string,{expanded:boolean,trigger:HTMLButtonElement,panel:HTMLDivElement}>} Presentation-owned legend state and controls. */
        this.legends = new Map();
        this.renameEditor = null;
        this.layers = [];
        this.activeKey = null;
    }

    /**
     * Show a compact Undo row in the removed layer's drawing position, including when it was the last layer.
     * @param {{label:string,index:number}|null} removal Removed name and top-first position, or null to dismiss.
     * @param {boolean} busy Whether restoration is in progress.
     * @param {string|null} error Failure explanation; Undo remains available to retry.
     * @return {void}
     */
    showRemoval(removal, busy, error) {
        this.removalNotice.hidden = !this.allowRemoval || removal === null;
        this.removalIndex = removal?.index ?? 0;
        this.undoRemove.disabled = busy;
        this.undoRemove.textContent = busy ? "Restoring…" : "Undo";
        this.removalMessage.textContent = removal === null ? "" : `Removed ${removal.label}`;
        this.removalMessage.title = this.removalMessage.textContent;
        this.removalError.textContent = error === null ? "" : `Could not restore: ${error}`;
        this.removalError.hidden = error === null;
        this.#placeRemovalRow();
    }

    /**
     * Place the Undo row among real layer rows without counting it as a layer or rebuilding their controls.
     * @return {void}
     */
    #placeRemovalRow() {
        const layers = [...this.list.children].filter(row => row !== this.removalNotice);
        if (this.removalNotice.hidden) this.removalNotice.remove();
        else this.list.insertBefore(this.removalNotice, layers[Math.min(this.removalIndex, layers.length)] ?? null);
        this.root.hidden = layers.length === 0 && this.removalNotice.hidden;
    }

    /**
     * Retain the complete interaction contract.
     *
     * @param {MapLayerStackViewHandlers} handlers Stack intent handlers.
     * @return {void}
     * @throws {Error} If handlers are already bound.
     */
    bind(handlers) {
        if (this.handlers !== null) {
            throw new Error("Map layer-stack view is already bound");
        }
        this.handlers = handlers;
    }

    /**
     * Stop forwarding intent after viewer destruction.
     *
     * @return {void}
     */
    unbind() {
        this.pointerDrag = null;
        this.keyboardDrag = null;
        this.handlers = null;
        this.legends.clear();
        this.renameEditor = null;
    }

    /**
     * Render rows while keeping the visible portion of an unchanged layer order stationary.
     * Restore control focus without scrolling during refreshes and visibility changes;
     * explicit focus after reordering or removal may still bring its target into view.
     * Legends retain expansion; focus returns to the visible legend control when
     * its collapsed swatch has been replaced by the full graphic.
     *
     * @param {MapLayerStackSnapshot[]} layers Owner-supplied layer snapshots and retained controls.
     * @param {string|null} activeKey Active layer key.
     * @param {{key:string,action:string}|null} [requestedFocus=null] Optional
     * focus target after a layer action, such as toggling visibility, reordering or removal.
     * @return {void}
     */
    render(layers, activeKey, requestedFocus = null) {
        const preserveViewport = (requestedFocus === null || requestedFocus.action === "visibility") &&
            layers.length === this.layers.length &&
            layers.every((layer, index) => layer.key === this.layers[index].key);
        const scrollTop = this.scrollContainer.scrollTop;
        const viewportTop = this.scrollContainer.getBoundingClientRect().top;
        const anchor = preserveViewport ? [...this.list.children].find(row =>
            row.dataset.layerKey && row.getBoundingClientRect().bottom > viewportTop
        ) : null;
        const anchorTop = anchor?.getBoundingClientRect().top;
        this.layers = layers;
        this.activeKey = activeKey;
        const retainedKeys = new Set(layers.map(layer => layer.key));
        if (this.renameEditor && !retainedKeys.has(this.renameEditor.key)) this.renameEditor = null;
        for (const key of this.legends.keys()) {
            if (!retainedKeys.has(key)) this.legends.delete(key);
        }
        this.#renderVisibilityActions(layers);
        this.sort.disabled = layers.length < 2;
        this.#renderCounts(layers);
        this.#renderFilters(layers);
        if (
            this.keyboardDrag !== null &&
            !layers.some((layer) => layer.key === this.keyboardDrag.key)
        ) {
            this.keyboardDrag = null;
        }
        const focusedControl = this.documentContext.activeElement;
        const retainRemovalFocus = !this.removalNotice.hidden && [this.undoRemove, this.dismissRemoval].includes(focusedControl);
        const retainLocalFocus = !requestedFocus && (this.renameEditor?.form.contains(focusedControl) || layers.some(layer => layer.controls?.contains(focusedControl) || layer.primaryControl?.contains(focusedControl) || layer.detailsControl === focusedControl));
        const retainedFocus = requestedFocus ?? this.#readFocusedAction();
        const focusTargets = new Map();
        const rows = layers.map((layer, index) => this.#buildRow(
            layer,
            index,
            layers.length,
            activeKey,
            focusTargets
        ));
        layers.forEach((layer, index) => {
            if (!layer.group || layers[index - 1]?.group?.id === layer.group.id) return;
            const heading = this.documentContext.createElement("strong");
            heading.className = "map-layer-group-heading";
            const name = this.documentContext.createElement("span");
            name.className = "map-layer-group-name";
            name.textContent = layer.group.label; name.title = layer.group.label;
            name.tabIndex = 0;
            name.dataset.layerKey = layer.key; name.dataset.layerAction = "group-name";
            this.#rememberFocusTarget(focusTargets, name);
            heading.append(name);
            if (layer.group.actionLabel && this.allowRemoval) {
                const action = this.#button(layer.group.actionLabel, `${layer.group.actionLabel}: ${layer.group.label}`,
                    layer.key, "group-action", () => this.handlers?.onGroupAction(layer.group.id), focusTargets);
                heading.append(action);
            }
            rows[index].classList.add("has-group-heading");
            rows[index].prepend(heading);
        });
        this.list.replaceChildren(...rows);
        this.#placeRemovalRow();
        if (preserveViewport) {
            const replacement = rows.find(row => row.dataset.layerKey === anchor?.dataset.layerKey);
            if (replacement) {
                const offset = replacement.getBoundingClientRect().top - anchorTop;
                this.scrollContainer.scrollTop += offset;
            } else {
                this.scrollContainer.scrollTop = scrollTop;
            }
        }
        if (retainRemovalFocus && !requestedFocus) focusedControl.focus({ preventScroll: true });
        else if (retainLocalFocus) focusedControl.focus({ preventScroll: true });
        else if (retainedFocus !== null) {
            let focusTarget = focusTargets.get(
                `${retainedFocus.key}\u0000${retainedFocus.action}`
            );
            if (focusTarget?.disabled) {
                focusTarget = focusTargets.get(
                    `${retainedFocus.key}\u0000style`
                );
            }
            if (focusTarget === undefined && layers.length === 0) {
                focusTarget = this.documentContext.querySelector("#toggle-map-layers") ?? this.status;
            }
            const legend = this.legends.get(retainedFocus.key);
            if (legend?.panel.contains(focusTarget)) this.#toggleLegend(retainedFocus.key, true, false);
            if (legend?.expanded && focusTarget === legend.trigger) {
                focusTarget = focusTargets.get(`${retainedFocus.key}\u0000legend-collapse`);
            }
            focusTarget?.focus({ preventScroll: preserveViewport });
        }
    }

    /**
     * Disable actions with no changes to make and retain keyboard focus nearby.
     *
     * @param {Array<{visible:boolean}>} layers Current retained-layer snapshots.
     * @return {void}
     */
    #renderVisibilityActions(layers) {
        const focused = this.documentContext.activeElement;
        this.showAll.disabled = !layers.some((layer) => !layer.visible);
        this.hideAll.disabled = !layers.some((layer) => layer.visible);
        if (focused === this.showAll && this.showAll.disabled && !this.hideAll.disabled) {
            this.hideAll.focus();
        } else if (focused === this.hideAll && this.hideAll.disabled && !this.showAll.disabled) {
            this.showAll.focus();
        }
    }

    /**
     * Replace the polite stack announcement.
     *
     * @param {string} message User-facing state change or error.
     * @return {void}
     */
    setStatus(message) {
        this.status.classList.remove("visually-hidden");
        this.status.textContent = message;
    }

    /**
     * Describe every retained layer, including hidden layers, in the heading.
     *
     * @param {Array<{datasetKind:"raster"|"vector"|"annotation"}>} layers Current layer
     * presentation snapshots supplied by their owning adapters.
     * @return {void}
     */
    #renderCounts(layers) {
        const parts = ["raster", "vector", "annotation"].flatMap((kind) => {
            const count = layers.filter((layer) => layer.datasetKind === kind).length;
            return count === 0 ? [] : [`${count} ${kind === "annotation" ? "polygon layer" : kind}${count === 1 ? "" : "s"}`];
        });
        this.counts.textContent = `· ${parts.length === 0 ? "Empty" : parts.join(" · ")}`;
    }

    /**
     * Show each active layer filter in the persistent map toolbar.
     * Retain each action while counts change so keyboard focus stays in place.
     * @param {MapLayerStackSnapshot[]} layers Neutral retained-layer presentation snapshots.
     * @return {void}
     */
    #renderFilters(layers) {
        const container = this.filterIndicators;
        if (!container) return;
        const active = layers.filter((layer) => layer.visible && layer.filterActive);
        const activeKeys = new Set(active.map(layer => layer.key));
        for (const [key, strip] of this.filterStrips) {
            if (!activeKeys.has(key)) { strip.root.remove(); this.filterStrips.delete(key); }
        }
        active.forEach((layer, index) => {
            let strip = this.filterStrips.get(layer.key);
            if (!strip) {
                const root = this.documentContext.createElement("div");
                root.className = "map-filter-indicator";
                const information = this.documentContext.createElement("div");
                information.className = "map-filter-information";
                const label = this.documentContext.createElement("strong");
                label.className = "map-filter-layer";
                const summary = this.documentContext.createElement("span");
                summary.className = "map-filter-summary";
                information.append(label, summary);
                const edit = this.documentContext.createElement("button");
                edit.type = "button";
                edit.className = "analysis-panel-action map-filter-edit";
                edit.textContent = "Edit filter";
                edit.addEventListener("click", () => this.handlers?.onFilter?.(layer.key));
                root.append(information, edit);
                strip = {root, label, summary, edit};
                this.filterStrips.set(layer.key, strip);
            }
            strip.label.textContent = layer.label;
            strip.summary.textContent = layer.filterStatus ?? "";
            strip.edit.setAttribute("aria-label", `Edit filter for ${layer.label}`);
            strip.edit.title = `Edit filter for ${layer.label}. Counts cover the whole layer.`;
            if (container.children[index] !== strip.root) {
                const focused = strip.root.contains(this.documentContext.activeElement);
                container.insertBefore(strip.root, container.children[index] ?? null);
                if (focused) strip.edit.focus({preventScroll: true});
            }
        });
        container.hidden = active.length === 0;
    }

    /**
     * Announce a successful state change without retaining visible text.
     *
     * @param {string} message Polite assistive-technology announcement.
     * @return {void}
     */
    announceStatus(message) {
        this.status.classList.add("visually-hidden");
        this.status.textContent = message;
    }

    /**
     * Construct a semantic row with text style/analysis actions, direct utility icons
     * and a swatch that becomes the full legend, retaining stable action identities.
     *
     * @param {MapLayerStackSnapshot} layer Layer presentation snapshot.
     * @param {number} index Top-first row index.
     * @param {number} layerCount Total retained layers.
     * @param {string|null} activeKey Active layer key.
     * @param {Map<string,Element>} focusTargets Rendered focus targets.
     * @return {HTMLLIElement} Complete accessible row.
     */
    #buildRow(
        layer,
        index,
        layerCount,
        activeKey,
        focusTargets
    ) {
        const typeLabel = layer.typeLabel ?? ({ raster: "Raster", vector: "Vector", annotation: "Shared layer" }[layer.datasetKind] ?? "Layer");
        const accessibleName = layer.item === null
            ? `${layer.label}; ${typeLabel.toLowerCase()}${typeLabel.toLowerCase().endsWith("layer") ? "" : " layer"}${layer.group ? ` from ${layer.group.label}` : ""}`
            : `${layer.label}; Catalog Item ${layer.item.collection} / ${layer.item.id}`;
        const row = this.documentContext.createElement("li");
        row.className = "raster-layer-row";
        row.classList.toggle("has-layer-group", Boolean(layer.group));
        row.dataset.layerKey = layer.key;
        row.dataset.layerIndex = String(index);
        row.classList.toggle("is-hidden", !layer.visible);
        row.classList.toggle(
            "is-dragging",
            this.keyboardDrag?.key === layer.key
        );
        row.setAttribute("aria-label", accessibleName);
        const reorder = this.#buildReorderHandle(
            layer,
            index,
            layerCount,
            accessibleName,
            row,
            focusTargets
        );
        const label = this.documentContext.createElement("label");
        label.className = "raster-layer-visibility";
        const visibility = this.documentContext.createElement("input");
        visibility.type = "checkbox";
        visibility.checked = layer.visible;
        visibility.dataset.layerKey = layer.key;
        visibility.dataset.layerAction = "visibility";
        visibility.setAttribute("aria-label", `${accessibleName} visible`);
        visibility.addEventListener("change", () =>
            this.handlers?.onVisibility(layer.key, visibility.checked)
        );
        this.#rememberFocusTarget(focusTargets, visibility);
        const name = this.documentContext.createElement("span");
        name.className = "raster-layer-name";
        name.textContent = layer.label;
        name.title = accessibleName;
        if (layer.group) {
            name.tabIndex = 0;
            name.dataset.layerKey = layer.key; name.dataset.layerAction = "name";
            this.#rememberFocusTarget(focusTargets, name);
        }
        label.append(visibility);
        const title = this.documentContext.createElement("span");
        title.className = "map-layer-title";
        title.append(name);
        label.append(title);
        if (layer.roleBadge !== null && layer.roleBadge !== undefined) {
            const roleBadge = this.documentContext.createElement("span");
            roleBadge.className = "map-layer-role-badge";
            roleBadge.textContent = layer.roleBadge.label;
            roleBadge.title = layer.roleBadge.description;
            roleBadge.setAttribute("aria-label", layer.roleBadge.description);
            label.append(roleBadge);
        }
        const primary = this.documentContext.createElement("div");
        primary.className = "map-layer-primary-row";
        const type = this.documentContext.createElement("span");
        type.className = "map-layer-type";
        type.textContent = typeLabel;
        title.append(type);
        primary.append(label);
        const style = this.#button(
            "Style", `Style ${accessibleName}`, layer.key, "style",
            () => this.handlers?.onStyle(layer.key), focusTargets
        );
        if (layer.stylePanelId) style.setAttribute("aria-controls", layer.stylePanelId);
        else if (!layer.controls) {
            style.setAttribute("aria-haspopup", "dialog");
            style.setAttribute("aria-controls", "layer-style-editor");
        }
        const zoom = this.#iconButton(
            "zoom", `Zoom to ${accessibleName}`, layer.key, "zoom",
            () => this.handlers?.onZoom(layer.key), focusTargets
        );
        zoom.title = `Zoom to ${layer.label}`;
        const info = layer.detailsControl || layer.canInfo === false ? null : this.#iconButton(
            "info", `View details for ${accessibleName}`, layer.key, "info",
            () => this.handlers?.onInfo(layer.key), focusTargets
        );
        if (info) info.title = `View details for ${layer.label}`;
        const clipboard = layer.styleClipboard ?? {
            canCopy: false,
            canPaste: false,
            sourceLabel: null,
            pasteReason: "Style copy and paste is unavailable.",
        };
        const copyStyle = this.#iconButton(
            "copy",
            `Copy style from ${accessibleName}`,
            layer.key,
            "copy-style",
            () => this.handlers?.onCopyStyle(layer.key),
            focusTargets
        );
        copyStyle.title = clipboard.canCopy ? `Copy style and opacity from ${layer.label}`
            : "Copying styles is unavailable for this layer.";
        copyStyle.disabled = !clipboard.canCopy;
        const pasteStyle = this.#iconButton(
            "paste",
            `Paste copied style onto ${accessibleName}`,
            layer.key,
            "paste-style",
            () => this.handlers?.onPasteStyle(layer.key),
            focusTargets
        );
        pasteStyle.title = clipboard.canPaste ? `Paste style and opacity from ${clipboard.sourceLabel}`
            : clipboard.pasteReason;
        pasteStyle.disabled = !clipboard.canPaste;
        const legend = this.#buildLegend(layer, focusTargets);
        if (legend !== null) primary.append(legend.trigger);
        if (this.allowRemoval) {
            const remove = this.#button(
                "×",
                `Remove from map: ${accessibleName}`,
                layer.key,
                "remove",
                () => this.handlers?.onRemove(layer.key),
                focusTargets
            );
            remove.classList.add("map-layer-remove-button");
            remove.title = `Remove from map: ${layer.label}`;
            primary.append(remove);
        }
        const rowActions = this.documentContext.createElement("div");
        rowActions.className = "map-layer-row-actions";
        const filter = layer.canFilter ? this.#iconButton(
            "filter", `${layer.filterActive ? "Edit active filter for" : "Filter"} ${accessibleName}`,
            layer.key, "filter", () => this.handlers?.onFilter?.(layer.key), focusTargets,
        ) : null;
        if (filter) filter.classList.toggle("has-active-filter", Boolean(layer.filterActive));
        // Local editors supply their own Edit/Details action instead of the catalog Info action.
        rowActions.append(
            ...(layer.detailsControl ? [layer.detailsControl] : []),
            style,
            ...(layer.capabilities?.calculations ? [this.#button(
                "Raster statistics", "Calculate statistics for " + accessibleName, layer.key,
                "calculate", () => this.handlers?.onCalculate?.(layer.key), focusTargets,
            )] : [])
        );
        if (this.allowRemoval && layer.canAddView) {
            const addView = this.#button(
                layer.addingView ? "Adding view…" : "Add another view",
                `Add another view of ${accessibleName}`, layer.key, "add-view",
                () => this.handlers?.onAddView(layer.key), focusTargets,
            );
            addView.disabled = layer.addingView === true;
            rowActions.append(addView);
        }
        const utilities = this.documentContext.createElement("div");
        utilities.className = "map-layer-utility-actions";
        utilities.append(
            ...(filter ? [filter] : []),
            zoom,
            ...(layer.item !== null || layer.sourceName ? [this.#iconButton(
                "rename", `Rename ${accessibleName}`, layer.key, "rename",
                () => this.#openRenameEditor(layer), focusTargets,
            )] : []),
            ...(info ? [info] : []),
            copyStyle,
            pasteStyle,
            ...(layer.capabilities?.calculations ? [this.#iconButton(
                "download", `Download clip of ${accessibleName}`, layer.key,
                "download", () => this.handlers?.onDownload?.(layer.key), focusTargets,
            )] : [])
        );
        rowActions.append(utilities);
        row.append(reorder);
        if (layer.attribution) {
            const attribution = this.documentContext.createElement("p");
            attribution.className = "map-layer-attribution";
            attribution.textContent = layer.attribution;
            row.append(attribution);
        }
        row.append(primary);
        if (layer.primaryControl) row.append(layer.primaryControl);
        row.append(rowActions);
        if (legend !== null) row.append(legend.panel);
        if (this.renameEditor?.key === layer.key) row.append(this.renameEditor.form);
        if (layer.filterStatus) {
            const filterStatus = this.#button(
                layer.filterStatus, `Edit filter for ${accessibleName}: ${layer.filterStatus}`,
                layer.key, "filter-status", () => this.handlers?.onFilter?.(layer.key), focusTargets,
            );
            filterStatus.classList.add("map-layer-filter-status");
            row.append(filterStatus);
        }
        if (layer.controls) row.append(layer.controls);
        if (layer.error) {
            const error = this.documentContext.createElement("p");
            error.className = "raster-layer-error";
            error.textContent = layer.error;
            row.append(error);
        }
        return row;
    }

    /**
     * Open a small inline name editor without changing visibility or the selected analysis.
     * Draft text and focus survive unrelated layer updates until Save, Cancel or removal.
     * @param {Object} layer Catalog layer snapshot with its current and original names.
     * @return {void}
     */
    #openRenameEditor(layer) {
        const form = this.documentContext.createElement("form");
        form.className = "map-layer-name-editor";
        const label = this.documentContext.createElement("label");
        label.textContent = "Layer name";
        const input = this.documentContext.createElement("input");
        input.type = "text";
        input.value = layer.label;
        input.setAttribute("aria-label", "Layer name");
        label.append(input);
        const original = this.documentContext.createElement("small");
        original.textContent = `Source: ${layer.sourceName ?? layer.label}`;
        const error = this.documentContext.createElement("p");
        error.setAttribute("role", "alert");
        error.hidden = true;
        const actions = this.documentContext.createElement("div");
        const save = this.documentContext.createElement("button");
        save.type = "submit";
        save.textContent = "Save";
        const reset = this.documentContext.createElement("button");
        reset.type = "button";
        reset.textContent = "Use source name";
        reset.addEventListener("click", () => this.#saveLayerName(null));
        const cancel = this.documentContext.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => this.#closeRenameEditor());
        for (const button of [save, reset, cancel]) button.className = "secondary-button";
        actions.append(save, reset, cancel);
        form.append(label, original, error, actions);
        form.addEventListener("submit", event => { event.preventDefault(); this.#saveLayerName(input.value); });
        form.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                event.preventDefault(); event.stopPropagation(); this.#closeRenameEditor();
            }
        });
        this.renameEditor = { key: layer.key, form, input, error };
        this.render(this.layers, this.activeKey);
        input.focus();
        input.select?.();
    }

    /**
     * Submit a name to the layer owner and retain the editor if validation fails.
     * @param {string|null} name Entered text, or null to restore the source name.
     * @return {void}
     */
    #saveLayerName(name) {
        const editor = this.renameEditor;
        if (!editor) return;
        try {
            this.handlers.onRename(editor.key, name);
            this.#closeRenameEditor();
        } catch (error) {
            editor.error.textContent = error.message;
            editor.error.hidden = false;
            editor.input.focus();
        }
    }

    /** Close the name editor and return focus to its Rename action. @return {void} */
    #closeRenameEditor() {
        const key = this.renameEditor?.key;
        this.renameEditor = null;
        this.render(this.layers, this.activeKey, key ? { key, action: "rename" } : null);
    }

    /**
     * Build one pointer- and keyboard-operable layer-order grip.
     *
     * @param {Object} layer Layer presentation snapshot.
     * @param {number} index Current zero-based top-first position.
     * @param {number} layerCount Total retained layer count.
     * @param {string} accessibleName Layer and Catalog identity label.
     * @param {HTMLLIElement} row Owning rendered row.
     * @param {Map<string,Element>} focusTargets Rendered focus targets.
     * @return {HTMLButtonElement} Reorder handle.
     */
    #buildReorderHandle(
        layer,
        index,
        layerCount,
        accessibleName,
        row,
        focusTargets
    ) {
        const handle = this.documentContext.createElement("button");
        handle.type = "button";
        handle.className = "map-layer-drag-handle";
        handle.textContent = "⠿";
        handle.title = "Drag to reorder. Keyboard: Space, arrow keys, Space.";
        handle.dataset.layerKey = layer.key;
        handle.dataset.layerAction = "reorder";
        const keyboardPickedUp = this.keyboardDrag?.key === layer.key;
        handle.setAttribute(
            "aria-label",
            `Reorder ${accessibleName}, position ${index + 1} of ` +
            `${layerCount}. ${keyboardPickedUp
                ? "Use arrow keys to move, Space to drop, or Escape to cancel."
                : "Press Space to pick up."}`
        );
        handle.setAttribute(
            "aria-pressed",
            String(keyboardPickedUp)
        );
        handle.setAttribute(
            "aria-keyshortcuts",
            "Space Enter ArrowUp ArrowDown Escape"
        );
        handle.addEventListener("pointerdown", (event) =>
            this.#startPointerDrag(event, layer.key, index, row, handle)
        );
        handle.addEventListener("pointermove", (event) =>
            this.#updatePointerDrag(event)
        );
        handle.addEventListener("pointerup", (event) =>
            this.#finishPointerDrag(event, false, handle)
        );
        handle.addEventListener("pointercancel", (event) =>
            this.#finishPointerDrag(event, true, handle)
        );
        handle.addEventListener("lostpointercapture", (event) =>
            this.#finishPointerDrag(event, true, handle)
        );
        handle.addEventListener("keydown", (event) =>
            this.#handleReorderKey(event, layer, index, layerCount, row, handle)
        );
        this.#rememberFocusTarget(focusTargets, handle);
        return handle;
    }

    /**
     * Begin one captured pointer reorder without changing domain order.
     *
     * @param {PointerEvent} event Pointer-down event.
     * @param {string} key Stable layer key.
     * @param {number} sourceIndex Initial top-first index.
     * @param {HTMLLIElement} row Owning rendered row.
     * @param {HTMLButtonElement} handle Capturing reorder handle.
     * @return {void}
     */
    #startPointerDrag(event, key, sourceIndex, row, handle) {
        if (event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        this.keyboardDrag = null;
        this.pointerDrag = {
            key,
            sourceIndex,
            targetIndex: sourceIndex,
            pointerId: event.pointerId,
        };
        row.classList.add("is-dragging");
        this.list.classList.add("is-reordering");
        handle.setAttribute("aria-pressed", "true");
        handle.setPointerCapture?.(event.pointerId);
        handle.focus();
    }

    /**
     * Update the pending destination and insertion marker for a pointer drag.
     *
     * @param {PointerEvent} event Captured pointer-move event.
     * @return {void}
     */
    #updatePointerDrag(event) {
        if (
            this.pointerDrag === null ||
            event.pointerId !== this.pointerDrag.pointerId
        ) {
            return;
        }
        event.preventDefault();
        this.#autoScroll(event.clientY);
        const rows = [...this.list.children].filter(row => row !== this.removalNotice);
        let targetIndex = rows.length - 1;
        for (let index = 0; index < rows.length; index += 1) {
            const bounds = rows[index].getBoundingClientRect();
            if (event.clientY <= bounds.bottom) {
                targetIndex = index;
                break;
            }
        }
        this.pointerDrag.targetIndex = targetIndex;
        this.#showDropTarget(
            rows,
            this.pointerDrag.sourceIndex,
            targetIndex
        );
    }

    /**
     * Complete or cancel one pointer reorder and release its capture.
     *
     * @param {PointerEvent} event Pointer completion event.
     * @param {boolean} cancelled Whether no reorder should be emitted.
     * @param {HTMLButtonElement} handle Capturing reorder handle.
     * @return {void}
     */
    #finishPointerDrag(event, cancelled, handle) {
        const drag = this.pointerDrag;
        if (drag === null || event.pointerId !== drag.pointerId) return;
        this.pointerDrag = null;
        handle.releasePointerCapture?.(event.pointerId);
        handle.setAttribute("aria-pressed", "false");
        this.#clearDragClasses();
        if (!cancelled && drag.targetIndex !== drag.sourceIndex) {
            this.handlers?.onReorder(drag.key, drag.targetIndex);
        }
    }

    /**
     * Apply accessible pickup, move, drop, and cancel keyboard semantics.
     *
     * @param {KeyboardEvent} event Reorder-handle key event.
     * @param {Object} layer Layer presentation snapshot.
     * @param {number} index Current zero-based top-first position.
     * @param {number} layerCount Total retained layer count.
     * @param {HTMLLIElement} row Owning rendered row.
     * @param {HTMLButtonElement} handle Keyboard reorder handle.
     * @return {void}
     */
    #handleReorderKey(event, layer, index, layerCount, row, handle) {
        const isToggle = event.key === " " || event.key === "Enter";
        const isActive = this.keyboardDrag?.key === layer.key;
        if (isToggle) {
            event.preventDefault();
            if (isActive) {
                this.keyboardDrag = null;
                row.classList.remove("is-dragging");
                handle.setAttribute("aria-pressed", "false");
                this.setStatus(
                    `${layer.label} dropped at position ${index + 1} of ` +
                    `${layerCount}.`
                );
            } else {
                this.keyboardDrag = { key: layer.key, originIndex: index };
                row.classList.add("is-dragging");
                handle.setAttribute("aria-pressed", "true");
                this.setStatus(
                    `${layer.label} picked up at position ${index + 1} of ` +
                    `${layerCount}. Use Up and Down arrows, then Space to drop.`
                );
            }
            return;
        }
        if (!isActive) return;
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const targetIndex = Math.max(
                0,
                Math.min(
                    layerCount - 1,
                    index + (event.key === "ArrowUp" ? -1 : 1)
                )
            );
            if (targetIndex !== index) {
                this.handlers?.onReorder(layer.key, targetIndex);
            }
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            const originIndex = this.keyboardDrag.originIndex;
            this.keyboardDrag = null;
            row.classList.remove("is-dragging");
            handle.setAttribute("aria-pressed", "false");
            if (originIndex !== index) {
                this.handlers?.onReorder(layer.key, originIndex);
            }
            this.setStatus(`${layer.label} reordering cancelled.`);
        }
    }

    /**
     * Mark one prospective insertion edge without changing source order.
     *
     * @param {Element[]} rows Current top-first rendered rows.
     * @param {number} sourceIndex Original row index.
     * @param {number} targetIndex Prospective destination index.
     * @return {void}
     */
    #showDropTarget(rows, sourceIndex, targetIndex) {
        for (const row of rows) {
            row.classList.remove("is-drop-before", "is-drop-after");
        }
        if (sourceIndex === targetIndex) return;
        rows[targetIndex]?.classList.add(
            targetIndex < sourceIndex ? "is-drop-before" : "is-drop-after"
        );
    }

    /** Remove all transient pointer-drag presentation classes. @return {void} */
    #clearDragClasses() {
        this.list.classList.remove("is-reordering");
        for (const row of this.list.children) {
            row.classList.remove(
                "is-dragging",
                "is-drop-before",
                "is-drop-after"
            );
        }
    }

    /**
     * Scroll the bounded map-layer panel when a drag approaches either edge.
     *
     * @param {number} clientY Pointer viewport Y coordinate.
     * @return {void}
     */
    #autoScroll(clientY) {
        if (
            typeof this.scrollContainer.getBoundingClientRect !== "function"
        ) {
            return;
        }
        const bounds = this.scrollContainer.getBoundingClientRect();
        const edgeSize = Math.min(44, bounds.height / 4);
        let delta = 0;
        if (clientY < bounds.top + edgeSize) {
            delta = -Math.ceil((bounds.top + edgeSize - clientY) / 4);
        } else if (clientY > bounds.bottom - edgeSize) {
            delta = Math.ceil((clientY - (bounds.bottom - edgeSize)) / 4);
        }
        if (delta !== 0) this.scrollContainer.scrollTop += delta;
    }

    /**
     * Draw the compact color key for the legend trigger, including fixed styles.
     * Class keys include every class color; full symbols and labels are in Legend.
     * @param {LayerLegend|null} legend Adapter-owned appearance.
     * @param {number} opacity Effective whole-layer opacity.
     * @return {HTMLSpanElement|null} Visible key, or null when the adapter has no legend.
     */
    #buildLegendKey(legend, opacity) {
        if (!legend) return null;
        const key = this.documentContext.createElement("span");
        key.className = "map-layer-color-key";
        key.setAttribute("role", "img");
        if (legend.kind === "gradient") {
            key.append(buildLegendGradient(this.documentContext, legend, opacity));
        } else if (legend.entries?.length) {
            key.append(this.#buildClassColorStrip(legend.entries, opacity));
        } else if (legend.symbol) {
            key.append(buildLegendSymbol(this.documentContext, legend.symbol, opacity));
        }
        if (!key.childElementCount) return null;
        const description = legend.description ?? (legend.entries
            ? `${legend.label}: ${legend.entries.length} ${legend.entries.length === 1 ? "class" : "classes"}. Expand Legend for all values.`
            : `${legend.label}: fill ${legend.symbol?.fill ?? "none"}, outline ${legend.symbol?.stroke}.`);
        key.title = description;
        key.setAttribute("aria-label", description);
        return key;
    }

    /**
     * Show every class color in order, dividing the compact strip into equal parts.
     * Use stroke colors for lines and fill colors for polygons and points.
     * @param {{label:string,symbol:LegendSymbol}[]} entries All classified legend entries.
     * @param {number} opacity Effective whole-layer opacity, from zero through one.
     * @return {HTMLSpanElement} Decorative palette; full symbols remain in the expanded legend.
     */
    #buildClassColorStrip(entries, opacity) {
        const strip = this.documentContext.createElement("span");
        strip.className = "map-layer-legend-palette";
        strip.setAttribute("aria-hidden", "true");
        for (const { symbol } of entries) {
            const swatch = this.documentContext.createElement("span");
            const isLine = symbol.shape === "line";
            swatch.style.backgroundColor = isLine ? symbol.stroke : symbol.fill;
            swatch.style.opacity = String((isLine ? symbol.strokeOpacity : symbol.fillOpacity) * opacity);
            strip.append(swatch);
        }
        return strip;
    }

    /**
     * Build a swatch trigger and the full legend that replaces it when expanded.
     * Keep inclusion independent of expansion, with an explicit collapse control
     * and Escape returning focus to the swatch without changing layer visibility.
     *
     * @param {MapLayerStackSnapshot} layer Layer identity, legend and effective opacity.
     * @param {Map<string,Element>} focusTargets Controls retained across style updates.
     * @return {{expanded:boolean,trigger:HTMLButtonElement,panel:HTMLDivElement}|null} Legend controls, or null without a legend.
     */
    #buildLegend(layer, focusTargets) {
        const legend = layer.legend;
        const opacity = layer.effectiveOpacity ?? layer.opacity;
        if (!legend) {
            this.legends.delete(layer.key);
            return null;
        }
        const panel = this.documentContext.createElement("div");
        panel.className = "map-layer-legend";
        panel.id = `map-layer-legend-${encodeURIComponent(layer.key)}`;
        panel.setAttribute("role", "group");
        panel.setAttribute("aria-label", `Legend for ${layer.label}`);
        const trigger = this.#button(
            "", `Show legend for ${layer.label}`, layer.key, "legend",
            () => this.#toggleLegend(layer.key, true), focusTargets,
        );
        trigger.classList.add("map-layer-legend-trigger");
        trigger.title = `Show legend for ${layer.label}`;
        trigger.setAttribute("aria-controls", panel.id);
        const key = this.#buildLegendKey(legend, opacity);
        if (key) trigger.append(key);
        else trigger.textContent = "Legend";
        const collapse = this.#iconButton(
            "collapse", `Collapse legend for ${layer.label}`, layer.key, "legend-collapse",
            () => this.#toggleLegend(layer.key, false), focusTargets,
        );
        collapse.classList.add("map-layer-legend-collapse");
        collapse.setAttribute("aria-controls", panel.id);
        const include = this.documentContext.createElement("label");
        include.className = "map-legend-inclusion";
        const checkbox = this.documentContext.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = layer.legendIncluded !== false;
        checkbox.dataset.layerKey = layer.key;
        checkbox.dataset.layerAction = "legend-inclusion";
        checkbox.addEventListener("change", () => this.handlers?.onLegendInclusion(layer.key, checkbox.checked));
        this.#rememberFocusTarget(focusTargets, checkbox);
        const text = this.documentContext.createElement("span");
        text.textContent = "Include in map legend";
        include.append(checkbox, text);
        panel.append(collapse, buildLegendContents(this.documentContext, legend, opacity), include);
        panel.addEventListener("keydown", event => {
            if (event.key === "Escape" && this.legends.get(layer.key)?.expanded) {
                event.preventDefault();
                event.stopPropagation();
                this.#toggleLegend(layer.key, false);
            }
        });
        const state = { expanded: this.legends.get(layer.key)?.expanded ?? false, trigger, panel };
        this.legends.set(layer.key, state);
        this.#toggleLegend(layer.key, state.expanded, false);
        return state;
    }

    /**
     * Replace a legend swatch with its graphic, or restore the swatch on collapse.
     * @param {string} key Retained layer identity.
     * @param {boolean} expanded Whether the full legend should be visible.
     * @param {boolean} [moveFocus=true] Move focus to the newly visible control for user actions.
     * @return {void}
     */
    #toggleLegend(key, expanded, moveFocus = true) {
        const state = this.legends.get(key);
        if (!state) return;
        state.expanded = expanded;
        state.trigger.hidden = expanded;
        state.trigger.setAttribute("aria-expanded", String(expanded));
        state.panel.hidden = !expanded;
        if (moveFocus) (expanded ? state.panel.children[0] : state.trigger).focus({ preventScroll: true });
    }

    /**
     * Create a direct utility action with a decorative SVG and explicit accessible name.
     * Tooltips describe the same intent; callers may supply a disabled-state reason.
     * @param {"zoom"|"rename"|"info"|"copy"|"paste"|"filter"|"download"|"collapse"} icon Local utility symbol.
     * @param {string} accessibleName Complete layer-specific action description.
     * @param {string} key Stable layer identity.
     * @param {string} action Stable intent/focus identity.
     * @param {()=>void} callback Existing owner intent callback.
     * @param {Map<string,Element>} focusTargets Rendered focus targets.
     * @return {HTMLButtonElement} Named utility button with a tooltip.
     */
    #iconButton(icon, accessibleName, key, action, callback, focusTargets) {
        const paths = {
            zoom: "M8 3H3v5m0-5 5 5m8-5h5v5m0-5-5 5M3 16v5h5m-5 0 5-5m13 0v5h-5m5 0-5-5",
            rename: "m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z",
            info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-11v6m0-10v.1",
            copy: "M8 8h13v13H8ZM16 5V2H2v14h3",
            paste: "M9 4H5v17h14V4h-4M9 2h6v4H9ZM9 11h6m-6 4h6",
            filter: "M3 3h18l-7 8v8l-4 2V11Z",
            download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
            collapse: "m6 15 6-6 6 6",
        };
        const button = this.#button("", accessibleName, key, action, callback, focusTargets);
        button.classList.add("map-layer-icon-button");
        button.title = accessibleName;
        const svg = this.documentContext.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        const path = this.documentContext.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", paths[icon]);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "1.7");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.append(path);
        button.append(svg);
        return button;
    }

    /**
     * Create one named stack action button.
     *
     * @param {string} text Visible short label.
     * @param {string} accessibleName Full accessible name.
     * @param {string} key Stable layer key.
     * @param {string} action Stable focus action.
     * @param {() => void} callback Intent callback.
     * @param {Map<string,Element>} focusTargets Rendered focus targets.
     * @return {HTMLButtonElement} Configured button.
     */
    #button(text, accessibleName, key, action, callback, focusTargets) {
        const button = this.documentContext.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = text;
        button.setAttribute("aria-label", accessibleName);
        button.dataset.layerKey = key;
        button.dataset.layerAction = action;
        button.addEventListener("click", callback);
        this.#rememberFocusTarget(focusTargets, button);
        return button;
    }

    /**
     * Register a rendered control by stable layer/action identity.
     *
     * @param {Map<string,Element>} targets Rendered focus targets.
     * @param {Element} element Focusable stack control.
     * @return {void}
     */
    #rememberFocusTarget(targets, element) {
        targets.set(
            `${element.dataset.layerKey}\u0000${element.dataset.layerAction}`,
            element
        );
    }

    /**
     * Read a stack control's stable focus identity before rebuilding rows.
     *
     * @return {{key:string,action:string}|null} Current stack focus or null.
     */
    #readFocusedAction() {
        const activeElement = this.documentContext.activeElement;
        const key = activeElement?.dataset?.layerKey;
        const action = activeElement?.dataset?.layerAction;
        return typeof key === "string" && typeof action === "string"
            ? { key, action }
            : null;
    }
}
