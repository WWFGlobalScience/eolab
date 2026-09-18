/** Local annotation workflow, composed with neutral map-layer services. */
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
        this.dirty = false;
        this.saving = false;
        this.pendingSave = false;
        this.createButton = document.querySelector("#create-annotation-layer");
        this.status = document.querySelector("#annotation-save-status");
        this.undoButton = document.querySelector("#undo-annotation-delete");
        this.retryButton = document.querySelector("#retry-annotation-save");
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
            onAdd: point => this.perform(() => { this.model.addVertex(point); this.editor.render(this.model.draft); }),
            onMove: (index, point) => this.perform(() => {
                this.model.draft.polygon.vertices[index] = point;
                this.editor.render(this.model.draft);
            }),
            onDelete: index => this.perform(() => {
                const draft = this.model.draft;
                if (index === 0) this.deletePolygon(draft.layerId, draft.polygon.id);
                else { draft.polygon.vertices.splice(index, 1); this.editor.render(draft); }
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
     * Restore local layers once storage validation completes.
     * @return {Promise<void>} Completion, including a visible storage error if needed.
     */
    async load() {
        try {
            this.model.layers = await this.storage.load();
            for (const layer of [...this.model.layers].reverse()) this.attachLayer(layer);
            this.loaded = true;
            this.createButton.disabled = false;
            this.status.textContent = "Saved on this device.";
        } catch (error) {
            this.status.textContent = `Cannot open saved annotations: ${error.message}`;
        }
    }

    /**
     * Run an editing action and keep errors visible without losing the draft.
     * @param {()=>void} action User-requested action.
     * @return {void}
     */
    perform(action) {
        try { action(); }
        catch (error) {
            if (this.model.draft) this.editor.render(this.model.draft, error.message);
            else this.status.textContent = error.message;
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
                else this.status.textContent = "Add a polygon, or clear the filter, before zooming to this layer.";
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
     * Delete one polygon, leave editing mode and expose a single Undo action.
     * @param {string} layerId Owning layer.
     * @param {string} polygonId Polygon identifier.
     * @return {void}
     */
    deletePolygon(layerId, polygonId) {
        this.model.deletePolygon(layerId, polygonId);
        this.updateEditor();
        this.refreshLayer(layerId);
        this.save();
    }

    /** Synchronize map editing presentation and notify composition of the mode. @return {void} */
    updateEditor() {
        this.onEditingChange(!!this.model.draft);
        this.editor.render(this.model.draft);
        this.undoButton.hidden = !this.model.deleted;
        this.undoButton.disabled = !!this.model.draft;
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
     * Preserve relative annotation ordering after layer-stack changes.
     * @param {Object[]} snapshots Complete top-first map-layer snapshots.
     * @return {void}
     */
    observeLayerOrder(snapshots) {
        if (!this.loaded) return;
        const positions = new Map(snapshots.map((layer, index) => [layer.key, index]));
        const order = [...this.model.layers].sort((a, b) => positions.get(`local:annotation:${a.id}`) - positions.get(`local:annotation:${b.id}`));
        if (order.some((layer, index) => layer !== this.model.layers[index])) {
            this.model.layers = order;
            this.save();
        }
    }

    /**
     * Serialize writes and coalesce pending changes into the latest committed document.
     * A failed save leaves annotations in memory and visibly marked unsaved.
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
        } finally { this.saving = false; }
    }
}
