/** Local annotation workflow, composed with neutral map-layer services. */
import { readAnnotationGeoJSONFile, exportAnnotationGeoJSON } from "./geojson.js";
import { AnnotationModel, matchingAnnotationPolygons, validateAnnotationStyle } from "./model.js";
import { AnnotationStorage } from "./storage.js";
import { AnnotationMapEditor } from "./map-editor.js";
import { AnnotationLayerControls } from "./layer-controls.js";
import { createAnnotationLeafletLayer } from "./leaflet-layer.js";

/** Own local layers, isolated polygon drafts, annotation controls and autosave. */
export class AnnotationController {
    /**
     * Connect annotations to map presentation and explicit interaction-mode callbacks.
     * @param {Object} options Feature dependencies.
     * @param {Object} options.leaflet Leaflet namespace.
     * @param {Object} options.map Leaflet map.
     * @param {Object} options.mapLayers Neutral layer controller.
     * @param {(editing:boolean)=>void} options.onEditingChange Composition-owned mode change.
     * @param {Document} [options.document=globalThis.document] Application document.
     * @param {AnnotationStorage} [options.storage] Device persistence provider.
     */
    constructor({ leaflet, map, mapLayers, onEditingChange, document = globalThis.document, storage = new AnnotationStorage() }) {
        this.leaflet = leaflet;
        this.map = map;
        this.mapLayers = mapLayers;
        this.document = document;
        this.storage = storage;
        this.onEditingChange = onEditingChange;
        this.model = new AnnotationModel();
        this.controls = new Map();
        this.layers = new Map();
        this.loaded = false;
        this.orderRestored = false;
        this.dirty = false;
        this.saving = false;
        this.pendingSave = false;
        this.toolsDisclosure = document.querySelector("#annotation-tools");
        this.createButton = document.querySelector("#create-annotation-layer");
        this.status = document.querySelector("#annotation-save-status");
        this.undoButton = document.querySelector("#undo-annotation-delete");
        this.retryButton = document.querySelector("#retry-annotation-save");
        this.importButton = document.querySelector("#import-annotation-geojson");
        this.importInput = document.querySelector("#annotation-geojson-file");
        this.fileStatus = document.querySelector("#annotation-file-status");
        this.importing = false;
        this.importButton.addEventListener("click", () => {
            this.importInput.value = "";
            this.importInput.click();
        });
        this.importInput.addEventListener("change", () => {
            const file = this.importInput.files[0];
            if (file) void this.importGeoJSONFile(file);
        });
        this.createButton.disabled = true;
        this.createButton.addEventListener("click", () => this.perform(() => {
            const layer = this.model.createLayer();
            this.attachLayer(layer);
            this.save();
            this.controls.get(layer.id).name.querySelector("input").select();
        }));
        this.undoButton.addEventListener("click", () => this.perform(() => {
            const layerId = this.model.deleted?.layerId;
            if (!this.model.undoDeletion()) return;
            this.refreshLayer(layerId);
            this.updateEditor();
            this.save();
        }));
        this.retryButton.addEventListener("click", () => this.save());
        this.beforeUnload = event => { if (this.dirty || this.model.draft) { event.preventDefault(); event.returnValue = ""; } };
        globalThis.addEventListener?.("beforeunload", this.beforeUnload);
        this.editor = new AnnotationMapEditor({ leaflet, map,
            onAdd: point => this.perform(() => { this.model.addVertex(point); this.renderEditor(); }),
            onInsert: (index, point) => this.perform(() => {
                this.model.addVertex(point, index);
                this.renderEditor();
                this.editor.vertexMarkers[index].getElement().focus({ preventScroll: true });
            }),
            onMove: (index, point) => this.perform(() => {
                this.model.draft.polygon.vertices[index] = point;
                this.renderEditor();
            }),
            onDelete: index => this.perform(() => {
                const draft = this.model.draft;
                if (index === 0) this.deletePolygon(draft.layerId, draft.polygon.id);
                else { draft.polygon.vertices.splice(index, 1); this.renderEditor(); }
            }),
            onSave: () => this.perform(() => {
                const layerId = this.model.draft.layerId;
                const polygon = this.model.savePolygon();
                this.updateEditor();
                this.refreshLayer(layerId, true, polygon.id);
                this.save();
            }),
            onCancel: () => { this.model.cancelPolygon(); this.updateEditor(); },
        });
    }

    /**
     * Restore local layers once storage validation completes; expand tools if loading fails.
     * @return {Promise<void>} Completion, including a visible storage error if needed.
     */
    async load() {
        try {
            this.model.layers = await this.storage.load();
            for (const layer of [...this.model.layers].reverse()) this.attachLayer(layer);
            this.loaded = true;
            this.createButton.disabled = false;
            this.importButton.disabled = false;
            this.status.textContent = "Saved on this device.";
        } catch (error) {
            this.status.textContent = `Cannot open saved annotations: ${error.message}`;
            this.toolsDisclosure.open = true;
        }
    }

    /**
     * Import a local GeoJSON file as one new layer after validating the whole file.
     * File errors expand the tools without changing the map. Persistence errors use the existing save/retry controls.
     * @param {File} file File chosen in Map layers.
     * @return {Promise<void>} Completion with a visible success or error message.
     */
    async importGeoJSONFile(file) {
        if (this.importing || !this.loaded) return;
        this.importing = true;
        this.importButton.disabled = true;
        this.fileStatus.textContent = "Reading GeoJSON…";
        this.fileStatus.classList.remove("is-error");
        try {
            const imported = await readAnnotationGeoJSONFile(file);
            const layer = this.model.importLayer(imported);
            this.attachLayer(layer);
            await this.save();
            this.fileStatus.textContent = `Imported ${layer.polygons.length} ${layer.polygons.length === 1 ? "polygon" : "polygons"} into “${layer.name}”.`;
        } catch (error) {
            this.fileStatus.textContent = `Cannot import GeoJSON: ${error.message}`;
            this.fileStatus.classList.add("is-error");
            this.toolsDisclosure.open = true;
        } finally {
            this.importing = false;
            this.importButton.disabled = false;
            this.importInput.value = "";
        }
    }

    /**
     * Download a layer's committed polygons as GeoJSON without sending data to a server.
     * @param {string} layerId Annotation layer to export, including filtered-out polygons.
     * @return {void} Starts a browser download or expands the tools to display an error.
     */
    exportGeoJSONFile(layerId) {
        let url;
        const link = this.document.createElement("a");
        this.fileStatus.classList.remove("is-error");
        try {
            const layer = this.model.layer(layerId);
            const text = JSON.stringify(exportAnnotationGeoJSON(layer));
            url = URL.createObjectURL(new Blob([text], { type: "application/geo+json" }));
            link.href = url;
            link.download = `${layer.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100) || "annotations"}.geojson`;
            this.document.body.append(link);
            link.click();
            this.fileStatus.textContent = `GeoJSON download started for “${layer.name}”. All saved polygons are included; unfinished edits are excluded.`;
        } catch (error) {
            this.fileStatus.textContent = `Cannot export GeoJSON: ${error.message}`;
            this.fileStatus.classList.add("is-error");
            this.toolsDisclosure.open = true;
        } finally {
            link.remove();
            // Allow the browser to consume the download URL before releasing it.
            if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    /**
     * Run an editing action, showing errors in the draft editor or expanded tools without losing data.
     * @param {()=>void} action User-requested action.
     * @return {void}
     */
    perform(action) {
        try { action(); }
        catch (error) {
            if (this.model.draft) this.renderEditor(error.message);
            else {
                this.status.textContent = error.message;
                this.toolsDisclosure.open = true;
            }
        }
    }

    /**
     * Attach a local annotation layer using the shared layer-list lifecycle.
     * @param {import("./model.js").AnnotationLayer} layer Validated annotation data.
     * @return {void}
     */
    attachLayer(layer) {
        const key = `local:annotation:${layer.id}`;
        const controls = new AnnotationLayerControls(this.document, layer, {
            add: () => this.beginPolygon(layer.id),
            exportGeoJSON: () => this.exportGeoJSONFile(layer.id),
            edit: id => this.beginPolygon(layer.id, id),
            removePolygon: id => this.perform(() => this.deletePolygon(layer.id, id)),
            change: (rebuild = true) => this.perform(() => {
                validateAnnotationStyle(layer.style);
                this.refreshLayer(layer.id, rebuild);
                this.save();
            }),
            opacity: opacity => this.mapLayers.setOpacity(key, opacity),
        });
        this.controls.set(layer.id, controls);
        const rendering = createAnnotationLeafletLayer(this.leaflet, this.map, layer);
        this.layers.set(layer.id, rendering);
        const adapter = {
            createState: () => layer,
            createLayer: () => rendering,
            snapshot: () => ({ datasetKind: "annotation", legend: null, canFilter: true, controls: controls.root,
                filterActive: !!layer.filter.trim(), filterStatus: layer.filter.trim()
                    ? `${matchingAnnotationPolygons(layer).length} of ${layer.polygons.length} polygons match` : null }),
            zoom: () => {
                const bounds = rendering.getBounds();
                if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
                else {
                    this.status.textContent = "Add a polygon, or clear the filter, before zooming to this layer.";
                    this.toolsDisclosure.open = true;
                }
            },
            info: () => controls.open("info"),
            exportSavedState: () => ({ kind: "annotation", style: { ...layer.style } }),
            checkSavedStateCompatibility: (_record, saved) => {
                if (saved?.kind !== "annotation") return "Copy a style from an annotation layer first.";
                validateAnnotationStyle(saved.style);
                return null;
            },
            applySavedState: (_record, saved) => {
                if (saved?.kind !== "annotation") throw new Error("This style is not an annotation style.");
                layer.style = validateAnnotationStyle(saved.style);
                this.refreshLayer(layer.id);
                this.save();
            },
            visibilityChanged: (_record, visible) => {
                layer.visible = visible;
                if (!visible && this.model.draft?.layerId === layer.id) { this.model.cancelPolygon(); this.updateEditor(); }
                this.save();
            },
            opacityChanged: (_record, opacity) => { layer.opacity = opacity; controls.opacity.value = opacity; this.save(); },
            removed: () => {
                if (this.model.draft?.layerId === layer.id) { this.model.cancelPolygon(); this.updateEditor(); }
                if (this.model.deleted?.layerId === layer.id) this.model.deleted = null;
                this.model.layers = this.model.layers.filter(candidate => candidate.id !== layer.id);
                rendering.release();
                this.layers.delete(layer.id);
                this.controls.delete(layer.id);
                this.undoButton.hidden = !this.model.deleted;
                this.save();
            },
        };
        this.mapLayers.addLocal({ key, label: layer.name, visible: layer.visible, opacity: layer.opacity }, adapter);
    }

    /**
     * Enter drawing or geometry editing; saved polygons remain unchanged until Save.
     * @param {string} layerId Annotation layer identifier.
     * @param {string|null} [polygonId=null] Existing polygon or new drawing.
     * @return {void}
     */
    beginPolygon(layerId, polygonId = null) {
        this.perform(() => {
            this.model.beginPolygon(layerId, polygonId);
            this.mapLayers.setVisible(`local:annotation:${layerId}`, true);
            this.updateEditor();
        });
    }

    /**
     * Delete one polygon, leave editing mode and expand tools to expose the single Undo action.
     * @param {string} layerId Owning layer.
     * @param {string} polygonId Polygon identifier.
     * @return {void}
     */
    deletePolygon(layerId, polygonId) {
        this.model.deletePolygon(layerId, polygonId);
        this.updateEditor();
        this.toolsDisclosure.open = true;
        this.refreshLayer(layerId);
        this.save();
    }

    /** Synchronize map editing presentation and notify composition of the mode. @return {void} */
    updateEditor() {
        this.onEditingChange(!!this.model.draft);
        for (const [layerId, rendering] of this.layers) {
            rendering.setEditingPolygon(this.model.draft?.layerId === layerId ? this.model.draft.polygon.id : null);
        }
        this.renderEditor();
        this.undoButton.hidden = !this.model.deleted;
        this.undoButton.disabled = !!this.model.draft;
    }

    /**
     * Show the current draft with its layer's name/note settings and any validation message.
     * @param {string} [message=""] Error shown next to the editing controls.
     * @return {void}
     */
    renderEditor(message = "") {
        const draft = this.model.draft;
        this.editor.render(draft, message, draft ? this.model.layer(draft.layerId).style : null);
    }

    /**
     * Refresh annotation shapes and controls; text edits keep existing stack rows in place.
     * @param {string} id Annotation layer identifier.
     * @param {boolean} [rebuild=true] Whether to rebuild name/note controls.
     * @param {string|null} [focusPolygon=null] Saved polygon to focus.
     * @return {void}
     */
    refreshLayer(id, rebuild = true, focusPolygon = null) {
        const layer = this.model.layer(id);
        const record = this.mapLayers.getRecord(`local:annotation:${id}`);
        const labelChanged = record.entry.label !== layer.name;
        record.entry.label = layer.name;
        this.layers.get(id).refresh();
        if (rebuild) this.controls.get(id).refresh(focusPolygon);
        // Polygon text changes do not alter stack controls unless a filter is active.
        if (rebuild || labelChanged || layer.filter) this.mapLayers.render();
    }

    /**
     * Open an annotation's inline Style, Filter or Info controls if it owns the key.
     * @param {string} key Retained map-layer key.
     * @param {"style"|"filter"|"info"} action Requested control.
     * @return {boolean} Whether annotations handled this intent.
     */
    openControls(key, action) {
        const record = this.mapLayers.getRecord(key);
        if (record?.entry.item !== null) return false;
        const controls = this.controls.get(record?.state?.id);
        if (!controls) return false;
        controls.open(action);
        return true;
    }

    /**
     * Restore each annotation's saved position among all loaded layers without changing Catalog order.
     * Composition calls this after both independent startup loads settle. Missing Catalog layers
     * shorten the stack; annotation positions then stop at its end, retaining their relative order.
     * @return {void}
     */
    restoreLayerOrder() {
        if (!this.loaded || this.orderRestored) return;
        const annotationKeys = new Set(this.model.layers.map(layer => `local:annotation:${layer.id}`));
        const keys = this.mapLayers.snapshots().map(layer => layer.key).filter(key => !annotationKeys.has(key));
        let nextIndex = 0;
        for (const layer of [...this.model.layers].sort((a, b) => a.position - b.position)) {
            const index = Math.min(keys.length, Math.max(nextIndex, layer.position));
            keys.splice(index, 0, `local:annotation:${layer.id}`);
            nextIndex = index + 1;
        }
        this.mapLayers.restoreOrder(keys);
        this.orderRestored = true;
        this.observeLayerOrder(this.mapLayers.snapshots());
    }

    /**
     * Remember annotation positions in the full stack, including hidden Catalog layers.
     * Startup insertion events must not overwrite saved positions; an explicit reorder may.
     * @param {Object[]} snapshots Complete top-first map-layer snapshots.
     * @param {boolean} [explicitReorder=false] Whether the user requested a reorder while loading.
     * @return {void}
     */
    observeLayerOrder(snapshots, explicitReorder = false) {
        if (!this.loaded || (!this.orderRestored && !explicitReorder)) return;
        const positions = new Map(snapshots.map((layer, index) => [layer.key, index]));
        const order = [...this.model.layers].sort((a, b) => positions.get(`local:annotation:${a.id}`) - positions.get(`local:annotation:${b.id}`));
        let changed = order.some((layer, index) => layer !== this.model.layers[index]);
        for (const layer of order) {
            const position = positions.get(`local:annotation:${layer.id}`);
            if (position !== layer.position) { layer.position = position; changed = true; }
        }
        if (changed) {
            this.model.layers = order;
            this.save();
        }
    }

    /**
     * Serialize writes and coalesce pending changes into the latest committed document.
     * A failed save leaves annotations in memory and expands tools to show the error and retry action.
     * @return {Promise<void>} Completion after pending writes settle.
     */
    async save() {
        if (!this.loaded) return;
        this.dirty = true;
        this.pendingSave = true;
        if (this.saving) return;
        this.saving = true;
        this.status.textContent = "Saving on this device…";
        this.retryButton.hidden = true;
        try {
            while (this.pendingSave) {
                this.pendingSave = false;
                const document = this.model.document();
                await this.storage.save(document);
            }
            this.dirty = false;
            this.status.textContent = "Saved on this device.";
        } catch (error) {
            this.status.textContent = `Not saved: ${error.message} Keep this tab open.`;
            this.retryButton.hidden = false;
            this.toolsDisclosure.open = true;
        } finally { this.saving = false; }
    }
}
