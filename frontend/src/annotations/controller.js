/** Connect polygon drawing, editing and local storage to the map's layer list. */
import { ANNOTATION_FIELDS, annotationFilterRules, annotationSummaryTarget } from "./summary-area.js";
import { readAnnotationGeoJSONFile, exportAnnotationGeoJSON, parseAnnotationGeoJSON } from "./geojson.js";
import { AnnotationModel, matchingAnnotationPolygons, validateAnnotationStyle } from "./model.js";
import { AnnotationStorage } from "./storage.js";
import { AnnotationMapEditor } from "./map-editor.js";
import { AnnotationLayerControls } from "./layer-controls.js";
import { createAnnotationLeafletLayer } from "./leaflet-layer.js";
import { PolygonLabelLayout } from "./polygon-label-layout.js";

/** Own local layers, isolated polygon drafts, annotation controls and autosave. */
export class AnnotationController {
    /**
     * Connect annotations to map presentation and explicit interaction-mode callbacks.
     * @param {Object} options Feature dependencies.
     * @param {Object} options.leaflet Leaflet namespace.
     * @param {Object} options.map Leaflet map.
     * @param {Object} options.mapLayers Neutral layer controller.
     * @param {import("./panel-view.js").AnnotationPanelView} options.panel Annotation editor presentation.
     * @param {(editing:boolean)=>void} options.onEditingChange Composition-owned mode change.
     * @param {()=>void} [options.onHoverInvalidated] Clear composed hover after polygon changes.
     * @param {Document} [options.document=globalThis.document] Application document.
     * @param {AnnotationStorage} [options.storage] Device persistence provider.
     * @param {(id:string)=>void} [options.onShare] Composition-owned sharing request.
     * @param {(id:string,color:string)=>void} [options.onColor] Save this contributor's shared polygon color through composition.
     * @param {(id:string)=>void} [options.onRenameContributor] Open contributor-name editing through composition.
     * @param {(key:string)=>void} [options.onFilter] Open the composed field/condition editor.
     * @param {(id:string)=>boolean} [options.requestEditing] Permit editing or open the owning membership prompt.
     * @param {()=>void} [options.onCommittedChange] Notifies composition after successful device persistence.
     */
    constructor({ leaflet, map, mapLayers, panel, onEditingChange, onHoverInvalidated = () => {}, document = globalThis.document, storage = new AnnotationStorage(), onShare = () => {}, onColor = () => {}, onRenameContributor = () => {}, onCommittedChange = () => {}, onFilter = () => {}, requestEditing = () => true }) {
        this.leaflet = leaflet;
        this.map = map;
        this.mapLayers = mapLayers;
        this.document = document;
        this.storage = storage;
        this.onShare = onShare;
        this.onColor = onColor;
        this.onRenameContributor = onRenameContributor;
        this.onCommittedChange = onCommittedChange;
        this.onFilter = onFilter;
        this.requestEditing = requestEditing;
        this.onEditingChange = onEditingChange;
        this.model = new AnnotationModel();
        this.shared = new Map();
        this.controls = new Map();
        this.layers = new Map();
        this.inspectionMatches = [];
        this.inspectedPolygon = null;
        this.onHoverInvalidated = onHoverInvalidated;
        this.loaded = false;
        this.clearedFilterLayerIds = new Set();
        this.savedSharingLayers = [];
        this.orderRestored = false;
        this.dirty = false;
        this.saving = false;
        this.savePromise = null;
        this.restoredLayers = new WeakMap();
        this.pendingSave = false;
        this.panel = panel;
        this.status = document.querySelector("#annotation-save-status");
        this.undoButton = document.querySelector("#undo-annotation-delete");
        this.retryButton = document.querySelector("#retry-annotation-save");
        this.drawButton = document.querySelector("#draw-private-polygon");
        this.importButton = document.querySelector("#import-annotation-geojson");
        this.importInput = document.querySelector("#annotation-geojson-file");
        this.fileStatus = document.querySelector("#annotation-file-status");
        this.importing = false;
        this.drawButton.addEventListener("click", () => this.drawPrivatePolygon());
        this.importButton.addEventListener("click", () => {
            this.importInput.value = "";
            this.importInput.click();
        });
        this.importInput.addEventListener("change", () => {
            const file = this.importInput.files[0];
            if (file) void this.importGeoJSONFile(file);
        });
        this.undoButton.addEventListener("click", () => this.perform(() => {
            const layerId = this.model.deleted?.layerId;
            if (!this.model.undoDeletion()) return;
            this.refreshLayer(layerId);
            this.updateEditor();
            this.save();
        }));
        this.retryButton.addEventListener("click", () => this.save());
        this.beforeUnload = event => { if (this.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ""; } };
        globalThis.addEventListener?.("beforeunload", this.beforeUnload);
        this.labelLayout = new PolygonLabelLayout(map);
        this.editor = new AnnotationMapEditor({ leaflet, map, labelLayout: this.labelLayout,
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
            onSave: drawAnother => this.perform(() => this.finishPolygon(drawAnother)),
            onCloseOutline: () => this.perform(() => {
                this.model.closePolygonOutline();
                this.renderEditor();
                this.editor.save.focus({ preventScroll: true });
            }),
            onCancel: () => { this.model.cancelPolygon(); this.updateEditor(); },
            onTextChange: (name, note) => this.perform(() => {
                this.model.updateDraftText(name, note);
                this.editor.refreshDraftLabels();
            }),
        });
    }

    /**
     * Restore saved polygons without opening their editor or moving focus.
     * Failed loads leave stored data untouched and retain the error in the polygon
     * editor without showing polygon controls over an unrelated map workflow.
     * Recovered filters are identified on their layers until the user applies a filter or reloads.
     * Creating drawing layers and importing files remain disabled until loading succeeds.
     * @param {Object} [options] Startup presentation policy.
     * @param {boolean} [options.attachSavedLayers=true] Display private saved layers; false keeps them off the shared map.
     * @param {string[]} [options.sharedLayerIds=[]] Bookmarked shared layers whose inclusion comes from the remembered map, not polygon storage.
     * @return {Promise<void>} Completion with failed loads retained in the editor's status.
     */
    async load({ attachSavedLayers = true, sharedLayerIds = [] } = {}) {
        try {
            this.model.layers = await this.storage.load(id => this.clearedFilterLayerIds.add(id));
            this.savedSharingLayers = this.model.layers.map(layer => ({ id: layer.id, collection: exportAnnotationGeoJSON(layer) }));
            const shared = new Set(sharedLayerIds);
            if (attachSavedLayers) for (const layer of [...this.model.layers].reverse()) {
                if (!shared.has(layer.id)) this.attachLayer(layer);
            }
            this.loaded = true;
            this.drawButton.disabled = false;
            this.importButton.disabled = false;
            this.status.textContent = "";
        } catch (error) {
            this.status.textContent = `Cannot open saved polygons: ${error.message}`;
        }
    }

    /**
     * Add a private layer and start its first polygon using the ordinary map editor.
     * Save the empty layer on this device; its unfinished polygon stays outside storage
     * until Save. Loading, editing and capacity errors use the existing editor status.
     * @return {void}
     */
    drawPrivatePolygon() {
        this.perform(() => {
            if (!this.loaded) throw new Error(this.status.textContent || "Wait for saved polygons to open before drawing.");
            if (this.model.draft) throw new Error("Save or cancel the current polygon before creating another layer.");
            const layer = this.model.createLayer();
            this.attachLayer(layer);
            this.panel.showLayer(`local:annotation:${layer.id}`);
            void this.save();
            this.beginPolygon(layer.id);
        });
    }

    /** Restore your server contribution as a local editable layer after joining.
     * Report a failed device-storage load before changing local polygons.
     * @param {string} name Shared layer name.
     * @param {Object} collection Server-validated GeoJSON belonging to this contributor.
     * @param {Object} [options] Existing contribution restoration options.
     * @param {string|null} [options.localId=null] Reuse this device layer when present.
     * @param {boolean} [options.replacePolygons=false] Replace a visitor's empty collection after authenticated joining.
     * @return {Promise<string>} Local layer ID after successful device persistence.
     * @throws {Error} If geometry, capacity or device persistence prevents restoration.
     */
    async restoreSharedContribution(name, collection, { localId = null, replacePolygons = false } = {}) {
        if (!this.loaded) throw new Error(this.status.textContent);
        const imported = parseAnnotationGeoJSON(JSON.stringify(collection));
        const existing = this.model.layers.find(layer => layer.id === localId);
        const layer = existing ?? this.model.importLayer({ ...imported, name });
        if (existing && replacePolygons) layer.polygons = imported.polygons;
        layer.name = name;
        if (!this.layers.has(layer.id)) this.attachLayer(layer);
        else this.refreshLayer(layer.id);
        await this.save();
        if (this.dirty) throw new Error(this.status.textContent);
        return layer.id;
    }

    /**
     * Finish saving local drawings before creating or joining a shared layer.
     * Reuse an in-flight save; clean layers do not need another write.
     * @return {Promise<void>} Completion once local layers are loaded and saved.
     * @throws {Error} If loading is incomplete or a local save fails.
     */
    async saveForSharing() {
        if (!this.loaded) throw new Error(this.status.textContent);
        if (this.dirty) await (this.savePromise ?? this.save());
        if (this.dirty) throw new Error(this.status.textContent);
    }

    /** Apply a saved map's local appearance without changing polygons or shared colors.
     * @param {string} id Local annotation layer identifier.
     * @param {Object} savedLayer Validated portable visibility, opacity and appearance.
     * @return {string} Retained map-layer key.
     */
    restoreMapAppearance(id, savedLayer) {
        const layer = this.model.layers.find(layer => layer.id === id);
        layer.style = validateAnnotationStyle({ ...layer.style, ...savedLayer.appearance });
        const key = `local:annotation:${id}`;
        this.mapLayers.setVisible(key, savedLayer.visible);
        this.mapLayers.setOpacity(key, savedLayer.opacity);
        this.refreshLayer(id);
        void this.save();
        return key;
    }

    /** Combine committed polygons and apply the shared colors without changing ownership.
     * @param {import("./model.js").AnnotationLayer} layer Local editable data.
     * @return {Object} Layer snapshot containing everyone's committed polygons.
     */
    displayLayer(layer) {
        const sharing = this.shared.get(layer.id);
        if (!sharing) return layer;
        const own = sharing.contributors.find(person => person.own);
        return { ...layer, polygons: [
            ...layer.polygons.map(polygon => ({ ...polygon, contributor: own?.name, contributorColor: own?.color ?? layer.style.color })),
            ...sharing.polygons.map(polygon => ({ ...polygon,
                contributorColor: sharing.contributors.find(person => person.id === polygon.contributorId)?.color ?? layer.style.color })),
        ] };
    }

    /** Refresh shared polygons and contributor details without replacing local edits.
     * @param {string} id Local editable layer identity.
     * @param {Object} data Session-owned contributor metadata, GeoJSON and save status.
     * @return {boolean} Whether the available summary geometry changed.
     * @throws {Error} If received polygon geometry is unsupported.
     */
    updateSharedLayer(id, data) {
        const layer = this.model.layers.find(candidate => candidate.id === id);
        if (!layer) return false;
        const previous = this.shared.get(id);
        const renamed = data.name && data.name !== layer.name;
        if (renamed) layer.name = data.name;
        const signature = JSON.stringify(data.collections);
        const changed = signature !== previous?.signature;
        const polygons = changed ? data.collections.flatMap(collection => {
            const imported = parseAnnotationGeoJSON(JSON.stringify(collection));
            return imported.polygons.map((polygon, index) => ({ ...polygon, id: collection.features[index].id,
                contributor: collection.features[index].properties.contributor,
                contributorId: collection.features[index].properties.contributorId }));
        }) : previous.polygons;
        this.shared.set(id, { ...data, signature, polygons });
        const own = data.contributors.find(person => person.own);
        const previousOwn = previous?.contributors.find(person => person.own);
        const color = own?.color;
        if (color) layer.style.color = color;
        this.controls.get(id).setCollaboration(data, polygons);
        if (renamed) this.refreshLayer(id, false);
        const colorsChanged = JSON.stringify(data.contributors) !== JSON.stringify(previous?.contributors);
        if (changed || colorsChanged) { this.layers.get(id).refresh(); this.mapLayers.render(); }
        if ((own?.name !== previousOwn?.name || own?.color !== previousOwn?.color) && this.model.draft?.layerId === id) this.renderEditor();
        // Peer IDs currently describe positions within a contribution. A replacement
        // collection must not silently select the polygon that took a deleted one's place.
        if (changed && this.inspectedPolygon?.layerId === id
            && !layer.polygons.some(polygon => polygon.id === this.inspectedPolygon.polygonId)) this.clearInspection();
        if (changed || colorsChanged || renamed || data.canContribute !== previous?.canContribute) this.refreshInspection();
        return changed;
    }

    /**
     * Fit the map to one contributor's saved polygons in this shared layer.
     * Uses current local polygons for you and loaded shared polygons for others,
     * including polygons hidden by filters. Unfinished edits are excluded.
     * Missing contributors or empty/unavailable geometry leave the map unchanged.
     * @param {string} layerId Local shared-layer identifier.
     * @param {string} contributorId Contributor whose polygons should fit in view.
     * @return {void}
     */
    zoomToContributorPolygons(layerId, contributorId) {
        const layer = this.model.layers.find(candidate => candidate.id === layerId);
        const sharing = this.shared.get(layerId);
        const contributor = sharing?.contributors.find(person => person.id === contributorId);
        if (!layer || !contributor) return;
        const polygons = contributor.own ? layer.polygons
            : sharing.polygons.filter(polygon => polygon.contributorId === contributorId);
        const bounds = this.leaflet.latLngBounds([]);
        for (const polygon of polygons) {
            for (const [longitude, latitude] of polygon.vertices) bounds.extend([latitude, longitude]);
        }
        if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
    }

    /**
     * Import a local GeoJSON file as one new layer after validating the whole file.
     * File errors appear in the annotation panel without changing the map. Persistence errors use the existing save/retry controls.
     * @param {File} file File chosen in the annotation panel.
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
            this.panel.showLayer(`local:annotation:${layer.id}`);
            await this.save();
            this.fileStatus.textContent = `Imported ${layer.polygons.length} ${layer.polygons.length === 1 ? "polygon" : "polygons"} into “${layer.name}”.`;
        } catch (error) {
            this.fileStatus.textContent = `Cannot import GeoJSON: ${error.message}`;
            this.fileStatus.classList.add("is-error");
            this.panel.show();
        } finally {
            this.importing = false;
            this.importButton.disabled = false;
            this.importInput.value = "";
        }
    }

    /**
     * Download a layer's committed polygons as GeoJSON without sending data to a server.
     * @param {string} layerId Annotation layer to export, including filtered-out polygons.
     * @return {void} Starts a browser download or reveals the annotation panel to display an error.
     */
    exportGeoJSONFile(layerId) {
        let url;
        const link = this.document.createElement("a");
        this.fileStatus.classList.remove("is-error");
        try {
            const layer = this.model.layer(layerId);
            const collection = exportAnnotationGeoJSON(this.displayLayer(layer), true);
            const text = JSON.stringify(collection);
            url = URL.createObjectURL(new Blob([text], { type: "application/geo+json" }));
            link.href = url;
            link.download = `${layer.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100) || "annotations"}.geojson`;
            this.document.body.append(link);
            link.click();
            this.fileStatus.textContent = `GeoJSON download started for “${layer.name}”. All saved polygons are included; unfinished edits are excluded.`;
        } catch (error) {
            this.fileStatus.textContent = `Cannot export GeoJSON: ${error.message}`;
            this.fileStatus.classList.add("is-error");
            this.panel.show();
        } finally {
            link.remove();
            // Allow the browser to consume the download URL before releasing it.
            if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    /**
     * Run an editing action, showing errors in the map editor or annotation panel without losing data.
     * @param {()=>void} action User-requested action.
     * @return {void}
     */
    perform(action) {
        try { action(); }
        catch (error) {
            if (this.model.draft) this.renderEditor(error.message);
            else {
                this.status.textContent = error.message;
                this.panel.show();
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
            open: () => this.openControls(key, "info"),
            filter: () => this.onFilter(key),
            add: () => this.beginPolygon(layer.id),
            share: () => this.onShare(layer.id),
            color: color => this.onColor(layer.id, color),
            renameContributor: () => this.onRenameContributor(layer.id),
            zoomToContributor: id => this.zoomToContributorPolygons(layer.id, id),
            exportGeoJSON: () => this.exportGeoJSONFile(layer.id),
            edit: (id, field) => this.beginPolygon(layer.id, id, field),
            removePolygon: id => this.perform(() => this.deletePolygon(layer.id, id)),
            change: (rebuild = true) => this.perform(() => {
                validateAnnotationStyle(layer.style);
                this.refreshLayer(layer.id, rebuild);
                this.save();
            }),
            opacity: opacity => this.mapLayers.setOpacity(key, opacity),
        });
        this.controls.set(layer.id, controls);
        const displayLayer = Object.create(layer);
        Object.defineProperty(displayLayer, "polygons", { get: () => this.displayLayer(layer).polygons });
        const rendering = createAnnotationLeafletLayer(this.leaflet, this.map, displayLayer, this.labelLayout);
        this.layers.set(layer.id, rendering);
        const adapter = {
            createState: () => layer,
            createLayer: () => rendering,
            snapshot: () => ({ datasetKind: "annotation", typeLabel: this.shared.has(layer.id) ? "Shared layer" : "Local layer",
                legend: this.layerLegend(layer),
                canFilter: true, detailsControl: controls.edit, primaryControl: controls.drawing, stylePanelId: "annotations-panel",
                filterActive: layer.filter.enabled && !!layer.filter.rules.length,
                filterStatus: this.clearedFilterLayerIds.has(layer.id) ? "Saved filter cleared—all polygons included" : (layer.filter.enabled && layer.filter.rules.length)
                    ? `${matchingAnnotationPolygons(this.displayLayer(layer)).length} of ${this.displayLayer(layer).polygons.length} polygons match` : null }),
            zoom: () => {
                const bounds = rendering.getBounds();
                if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
                else {
                    this.status.textContent = "Add a polygon, or clear the filter, before zooming to this layer.";
                    this.panel.show();
                }
            },
            info: () => this.openControls(key, "info"),
            exportSavedState: () => ({ kind: "annotation", style: { ...layer.style } }),
            checkSavedStateCompatibility: (_record, saved) => {
                if (saved?.kind !== "annotation") return "Copy a style from a shared layer first.";
                validateAnnotationStyle(saved.style);
                return null;
            },
            applySavedState: (_record, saved) => {
                if (saved?.kind !== "annotation") throw new Error("This style is not a shared layer style.");
                const ownColor = layer.style.color;
                layer.style = validateAnnotationStyle(saved.style);
                if (this.shared.has(layer.id)) layer.style.color = ownColor;
                this.refreshLayer(layer.id);
                this.save();
            },
            visibilityChanged: (_record, visible) => {
                layer.visible = visible;
                this.refreshInspection();
                this.save();
            },
            opacityChanged: (_record, opacity) => { layer.opacity = opacity; controls.opacity.value = opacity; this.refreshInspection(); this.save(); },
            copyLayerForUndo: () => {
                if (this.model.draft?.layerId === layer.id) throw new Error("Save or cancel the current polygon before removing this layer.");
                return structuredClone(layer);
            },
            removed: () => {
                this.clearInspection();
                if (this.model.draft?.layerId === layer.id) { this.model.cancelPolygon(); this.updateEditor(); }
                if (this.model.deleted?.layerId === layer.id) this.model.deleted = null;
                this.model.layers = this.model.layers.filter(candidate => candidate.id !== layer.id);
                rendering.release();
                this.layers.delete(layer.id);
                this.controls.delete(layer.id);
                this.panel.removeLayer(key);
                this.undoButton.hidden = !this.model.deleted;
                this.save();
            },
        };
        this.mapLayers.addLocal({ key, label: layer.name, visible: layer.visible, opacity: layer.opacity }, adapter);
        this.panel.registerLayerControls(key, layer.name, controls.root);
    }

    /** Describe the layer's polygon colors for the neutral Map layers legend.
     * @param {import("./model.js").AnnotationLayer} layer Local display settings.
     * @return {Object} Contributor entries for shared layers and imported color metadata, or one fixed local symbol.
     */
    layerLegend(layer) {
        const symbol = { shape: "polygon", fill: layer.style.color, fillOpacity: layer.style.fillOpacity,
            stroke: layer.style.outline, strokeOpacity: 1, strokeWidth: layer.style.weight };
        const sharing = this.shared.get(layer.id);
        if (sharing) return { kind: "categories", label: "Contributors", entries: sharing.contributors.map(person => ({
            label: `${person.name}${person.own ? " (you)" : ""}`, symbol: { ...symbol, fill: person.color ?? layer.style.color },
        })) };
        if (layer.polygons.some(polygon => polygon.contributorColor)) {
            const entries = new Map();
            for (const polygon of layer.polygons) {
                const label = polygon.contributor ?? "Imported polygons";
                const fill = polygon.contributorColor ?? layer.style.color;
                entries.set(JSON.stringify([label, fill]), { label, symbol: { ...symbol, fill } });
            }
            return { kind: "categories", label: "Contributors in file", entries: [...entries.values()] };
        }
        return { kind: "fixed", label: "Polygon", symbol };
    }

    /**
     * Restore annotation contents and drawing position, then wait for device storage.
     * After a storage failure, retry saving the same restored object without overwriting edits or a separately re-added layer.
     * @param {import("../map-layers/controller.js").RemovedMapLayer} snapshot Neutral removal record containing committed annotation data.
     * @param {()=>boolean} isCurrent Whether the user still wants this Undo attempt.
     * @return {Promise<void>} Completion after all pending annotation writes settle.
     * @throws {Error} If Undo is obsolete, capacity/identity conflicts prevent restoration, or saving fails.
     */
    async restoreRemovedLayer(snapshot, isCurrent) {
        if (!isCurrent()) throw new Error("Layer restoration was superseded.");
        const existing = this.model.layers.find(layer => layer.id === snapshot.local.id);
        if (existing) {
            if (existing !== this.restoredLayers.get(snapshot)) throw new Error("This shared layer is already on the map.");
        } else {
            const layer = this.model.restoreRemovedLayer(snapshot.local);
            try {
                this.attachLayer(layer);
            } catch (error) {
                this.model.layers = this.model.layers.filter(candidate => candidate !== layer);
                this.layers.get(layer.id)?.release();
                this.layers.delete(layer.id);
                this.controls.delete(layer.id);
                throw error;
            }
            this.restoredLayers.set(snapshot, layer);
            this.mapLayers.reorder(snapshot.key, Math.min(snapshot.index, this.mapLayers.snapshots().length - 1));
        }
        await this.save();
        if (this.dirty) throw new Error(this.status.textContent);
    }

    /**
     * Read committed polygons for raster summaries; unfinished editing drafts are excluded.
     * @return {Object[]} Layer identities, fields and polygon snapshots.
     */
    summaryTargets() {
        return this.model.layers.filter(layer => this.layers.has(layer.id)).map(layer => annotationSummaryTarget(`local:annotation:${layer.id}`, this.displayLayer(layer)));
    }

    /** Return annotation fields and callbacks for the existing filter dialog.
     * @param {string} key Map-layer identity.
     * @return {Object|null} Field editor target, or null for a different owner.
     */
    filterTarget(key) {
        const layer = this.model.layers.find(layer => `local:annotation:${layer.id}` === key);
        if (!layer) return null;
        return { key, label: layer.name, fields: ANNOTATION_FIELDS, filter: annotationFilterRules(layer.filter),
            status: `${matchingAnnotationPolygons(this.displayLayer(layer)).length} of ${this.displayLayer(layer).polygons.length} polygons match`,
            apply: candidate => {
                layer.filter = annotationFilterRules(candidate);
                this.clearedFilterLayerIds.delete(layer.id);
                this.refreshLayer(layer.id);
                this.save();
            },
            cancelPending: () => {} };
    }

    /** Export the most recently device-saved GeoJSON for sharing.
     * @return {{id:string,collection:Object}[]} Independent saved layer snapshots.
     */
    sharableLayers() {
        return this.savedSharingLayers;
    }

    /** Check map inclusion independently of stored polygons or server membership.
     * @param {string} id Local annotation layer identifier.
     * @return {boolean} Whether the layer is currently attached, including hidden layers.
     */
    isLayerOnMap(id) { return this.layers.has(id); }

    /** Focus a local layer's drawing action in Map layers without entering editing mode.
     * Composition reveals Map layers before calling this method.
     * @param {string} id Local annotation layer identifier. @return {void}
     */
    revealDrawing(id) {
        this.controls.get(id)?.revealDrawing();
    }

    /**
     * Edit a polygon shape, name and notes in one draft; saved polygons stay unchanged until Save.
     * @param {string} layerId Annotation layer identifier.
     * @param {string|null} [polygonId=null] Existing polygon or new drawing.
     * @param {"name"|"note"|null} [field=null] Focus the requested text field; otherwise focus Name on entry.
     * @return {void}
     */
    beginPolygon(layerId, polygonId = null, field = null) {
        if (this.requestEditing && !this.requestEditing(layerId)) return;
        this.perform(() => {
            if (polygonId && this.model.draft?.layerId === layerId && this.model.draft.polygon.id === polygonId) {
                this.editor.focusTextField(field ?? "name", false);
                return;
            }
            this.model.beginPolygon(layerId, polygonId);
            this.mapLayers.setVisible(`local:annotation:${layerId}`, true);
            this.updateEditor();
            if (field) this.editor.focusTextField(field);
        });
    }

    /**
     * Delete one polygon, leave editing mode and show the panel with its single Undo action.
     * @param {string} layerId Owning layer.
     * @param {string} polygonId Polygon identifier.
     * @return {void}
     */
    deletePolygon(layerId, polygonId) {
        this.model.deletePolygon(layerId, polygonId);
        this.updateEditor();
        this.panel.show();
        this.refreshLayer(layerId);
        this.save();
    }

    /** Synchronize map editing presentation and notify composition of the mode. @return {void} */
    updateEditor() {
        this.clearInspection();
        this.onEditingChange(!!this.model.draft);
        for (const [layerId, rendering] of this.layers) {
            rendering.setEditingPolygon(this.model.draft?.layerId === layerId ? this.model.draft.polygon.id : null);
        }
        this.renderEditor();
        this.undoButton.hidden = !this.model.deleted;
        this.undoButton.disabled = !!this.model.draft;
    }

    /**
     * Show the draft with its contributor name, local label visibility and any validation message.
     * @param {string} [message=""] Error shown next to the editing controls.
     * @return {void}
     */
    renderEditor(message = "") {
        const draft = this.model.draft;
        const layer = draft ? this.model.layer(draft.layerId) : null;
        const contributor = this.shared.get(layer?.id)?.contributors.find(person => person.own)?.name;
        this.editor.render(draft, message, layer?.style ?? null, layer?.name ?? "", contributor ?? null);
    }

    /**
     * Save the draft's shape, name and notes together and optionally start another polygon.
     * Validation failures keep the complete draft open for correction; no draft is a no-op.
     * @param {boolean} [drawAnother=false] Start a new draft in the same layer after saving.
     * @return {void}
     * @throws {Error} If the draft is invalid or this contributor can no longer edit it.
     */
    finishPolygon(drawAnother = false) {
        if (!this.model.draft) return;
        const { layerId } = this.model.draft;
        if (this.shared.get(layerId)?.canContribute === false) throw new Error("Join this layer before saving your polygon.");
        const polygon = this.model.savePolygon();
        this.updateEditor();
        this.refreshLayer(layerId, true, polygon.id);
        void this.save();
        if (drawAnother) this.beginPolygon(layerId);
    }

    /** Whether leaving would lose an unfinished polygon or failed/pending save. @return {boolean} */
    hasUnsavedChanges() {
        return !!(this.dirty || this.model.draft);
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
        this.panel.renameLayer(`local:annotation:${id}`, layer.name);
        this.layers.get(id).refresh();
        if (rebuild) this.controls.get(id).refresh(focusPolygon);
        // Polygon text changes do not alter stack controls unless a filter is active.
        if (rebuild || labelChanged || (layer.filter.enabled && layer.filter.rules.length)) this.mapLayers.render();
        this.refreshInspection();
    }

    /**
     * Find visible annotation polygons at a map location without intercepting map events.
     * @param {{lat:number,lng:number}} position Pointer location.
     * @return {{layerId:string,layerName:string,polygon:import("./model.js").AnnotationPolygon,canEdit:boolean}[]} Top-first hits with local edit permission.
     */
    polygonsAt(position) {
        if (this.model.draft) return [];
        return [...this.model.layers].sort((a, b) => a.position - b.position).flatMap(layer => {
            if (!layer.visible || layer.opacity === 0) return [];
            return (this.layers.get(layer.id)?.polygonsAt(position) ?? []).map(polygon => ({
                layerId: layer.id, layerName: layer.name, polygon,
                canEdit: this.shared.get(layer.id)?.canContribute !== false && layer.polygons.some(own => own.id === polygon.id),
            }));
        });
    }

    /**
     * Open annotation details for a map click; composition still handles raster and catalog-vector sampling.
     * @param {{lat:number,lng:number}} position Click location.
     * @return {boolean} Whether a visible annotation polygon was selected.
     */
    inspectAt(position) {
        this.clearInspection();
        this.inspectionMatches = this.polygonsAt(position);
        if (!this.inspectionMatches.length) return false;
        this.selectInspectionMatch(0);
        return true;
    }

    /**
     * Highlight an overlap choice and reveal its owner-supplied controls in the existing panel.
     * @param {number} index Index in the current click's polygon matches.
     * @return {void}
     */
    selectInspectionMatch(index) {
        const hit = this.inspectionMatches[index];
        if (!hit) return;
        for (const controls of this.controls.values()) controls.clearPolygonInspection();
        for (const [id, rendering] of this.layers) rendering.setInspectedPolygon(id === hit.layerId ? hit.polygon.id : null);
        this.inspectedPolygon = { layerId: hit.layerId, polygonId: hit.polygon.id };
        this.controls.get(hit.layerId).showPolygonInspection(hit, this.inspectionMatches, choice => this.selectInspectionMatch(choice), true);
        this.panel.showLayer(`local:annotation:${hit.layerId}`);
        this.controls.get(hit.layerId).inspection.scrollIntoView({ block: "nearest" });
    }

    /** Clear temporary hover, highlight and details without deleting any polygon. @return {void} */
    clearInspection() {
        this.onHoverInvalidated();
        for (const controls of this.controls.values()) controls.clearPolygonInspection();
        for (const rendering of this.layers.values()) rendering.setInspectedPolygon(null);
        this.inspectionMatches = [];
        this.inspectedPolygon = null;
    }

    /**
     * Refresh clicked details after edits or collaboration updates; discard unavailable selections.
     * Never reopen the panel or move focus while background data changes.
     * @return {void}
     */
    refreshInspection() {
        this.onHoverInvalidated();
        if (!this.inspectedPolygon) return;
        this.inspectionMatches = this.inspectionMatches.flatMap(hit => {
            const layer = this.model.layers.find(item => item.id === hit.layerId);
            if (!layer?.visible || layer.opacity === 0 || !this.layers.has(layer.id)) return [];
            const polygon = matchingAnnotationPolygons(this.displayLayer(layer)).find(item => item.id === hit.polygon.id);
            return polygon ? [{ layerId: layer.id, layerName: layer.name, polygon,
                canEdit: this.shared.get(layer.id)?.canContribute !== false && layer.polygons.some(own => own.id === polygon.id) }] : [];
        });
        const hit = this.inspectionMatches.find(item => item.layerId === this.inspectedPolygon.layerId && item.polygon.id === this.inspectedPolygon.polygonId);
        if (!hit) { this.clearInspection(); return; }
        this.controls.get(hit.layerId).showPolygonInspection(hit, this.inspectionMatches, choice => this.selectInspectionMatch(choice));
    }

    /**
     * Open an annotation's panel at its Style, Filter or Info controls if it owns the key.
     * @param {string} key Retained map-layer key.
     * @param {"style"|"filter"|"info"} action Requested control.
     * @return {boolean} Whether annotations handled this intent.
     */
    openControls(key, action) {
        const record = this.mapLayers.getRecord(key);
        if (record?.entry.item !== null) return false;
        const controls = this.controls.get(record?.state?.id);
        if (!controls) return false;
        this.clearInspection();
        this.panel.showLayer(key);
        controls.open(action);
        return true;
    }

    /**
     * Restore each annotation's saved position among all loaded layers without changing Catalog order.
     * Composition calls this after both independent startup loads settle. Missing Catalog layers
     * shorten the stack; annotation positions then stop at its end, retaining their relative order.
     * @param {Object} [options] Startup order policy.
     * @param {boolean} [options.useSavedPositions=true] Restore device positions; false retains the portable map's order.
     * @param {string[]} [options.mapOrderedLayerIds=[]] Layers already ordered by the saved map; only insert other private layers around them.
     * @return {void}
     */
    restoreLayerOrder({ useSavedPositions = true, mapOrderedLayerIds = [] } = {}) {
        if (!this.loaded || this.orderRestored) return;
        if (!useSavedPositions) {
            this.orderRestored = true;
            this.observeLayerOrder(this.mapLayers.snapshots());
            return;
        }
        const mapOrdered = new Set(mapOrderedLayerIds);
        const attached = this.model.layers.filter(layer => this.layers.has(layer.id) && !mapOrdered.has(layer.id));
        const annotationKeys = new Set(attached.map(layer => `local:annotation:${layer.id}`));
        const keys = this.mapLayers.snapshots().map(layer => layer.key).filter(key => !annotationKeys.has(key));
        let nextIndex = 0;
        for (const layer of [...attached].sort((a, b) => a.position - b.position)) {
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
        const order = [...this.model.layers].sort((a, b) => (positions.get(`local:annotation:${a.id}`) ?? a.position) - (positions.get(`local:annotation:${b.id}`) ?? b.position));
        let changed = order.some((layer, index) => layer !== this.model.layers[index]);
        for (const layer of order) {
            const position = positions.get(`local:annotation:${layer.id}`);
            if (position === undefined) continue;
            if (position !== layer.position) { layer.position = position; changed = true; }
        }
        if (changed) {
            this.model.layers = order;
            this.save();
        }
    }

    /**
     * Serialize writes and coalesce pending changes into the latest committed document.
     * A failed save leaves annotations in memory and opens the panel with the error and retry action.
     * @return {Promise<void>} Completion after pending writes settle.
     */
    async save() {
        if (!this.loaded) return;
        this.dirty = true;
        this.pendingSave = true;
        if (this.savePromise) return this.savePromise;
        this.savePromise = this.writePendingSaves();
        try { await this.savePromise; }
        finally { this.savePromise = null; }
    }

    /**
     * Write the latest annotation document until no edits remain pending; keep failures visible and retryable.
     * @return {Promise<void>} Completion after writes finish or a storage error is displayed.
     */
    async writePendingSaves() {
        this.saving = true;
        this.status.textContent = "Saving on this device…";
        this.retryButton.hidden = true;
        try {
            while (this.pendingSave) {
                this.pendingSave = false;
                const document = this.model.document();
                await this.storage.save(document);
                this.savedSharingLayers = document.layers.map(layer => ({ id: layer.id, collection: exportAnnotationGeoJSON(layer) }));
            }
            this.dirty = false;
            this.status.textContent = "";
            this.onCommittedChange?.();
        } catch (error) {
            this.status.textContent = `Not saved: ${error.message} Keep this tab open.`;
            this.retryButton.hidden = false;
            this.panel.show();
        } finally { this.saving = false; }
    }
}
