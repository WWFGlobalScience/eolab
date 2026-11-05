/** Browser-owned annotation data and isolated polygon editing drafts. */
import { annotationFilterRules, filterAnnotationPolygons } from "./summary-area.js";
import { polygonValidationMessage } from "./geometry.js";
import { EMPTY_VECTOR_FILTER } from "../vector/filter.js";

/**
 * @typedef {{color:string,outline:string,weight:number,fillOpacity:number,labels:boolean}} AnnotationStyle
 * @typedef {{id:string,name:string,note:string,vertices:number[][],contributor?:string,contributorColor?:string}} AnnotationPolygon
 * Annotation positions are zero-based indices in the complete top-first map-layer stack.
 * @typedef {{id:string,name:string,position:number,visible:boolean,opacity:number,style:AnnotationStyle,filter:Object,polygons:AnnotationPolygon[]}} AnnotationLayer
 * @typedef {{version:1,layers:AnnotationLayer[]}} AnnotationDocument
 * @typedef {{layerId:string,polygon:AnnotationPolygon,isNew:boolean,outlineClosed:boolean}} PolygonDraft
 */

/** Maximum annotation layers saved on this device for this app. @type {number} */
export const MAX_ANNOTATION_LAYERS = 32;
export const MAX_POLYGON_VERTICES = 2000;
/** Maximum saved polygons in one annotation layer. @type {number} */
export const MAX_POLYGONS_PER_LAYER = 500;
/** Maximum UTF-8 bytes saved for all annotation layers on this device. @type {number} */
export const MAX_ANNOTATION_DOCUMENT_BYTES = 8 * 1024 * 1024;
/** Maximum characters in a layer or polygon name. @type {number} */
export const MAX_ANNOTATION_NAME_LENGTH = 160;
/** Maximum characters in a polygon note. @type {number} */
export const MAX_ANNOTATION_NOTE_LENGTH = 10000;
export const DEFAULT_ANNOTATION_STYLE = Object.freeze({ color: "#1686b0", outline: "#202020", weight: 1, fillOpacity: 0.25, labels: true });

/**
 * Validate appearance, combining legacy name/note switches into one label switch.
 * Either old switch being on keeps the combined label visible; both off keeps it hidden.
 * @param {AnnotationStyle & {notes?:boolean}} style Fill, outline, width, fill opacity and text visibility.
 * @return {AnnotationStyle} Independent validated appearance.
 * @throws {Error} If any appearance setting is invalid.
 */
export function validateAnnotationStyle(style) {
    if (!style || !/^#[\da-f]{6}$/i.test(style.color) || !/^#[\da-f]{6}$/i.test(style.outline) ||
        !Number.isFinite(style.weight) || style.weight < 0 || style.weight > 10 ||
        !Number.isFinite(style.fillOpacity) || style.fillOpacity < 0 || style.fillOpacity > 1 ||
        typeof style.labels !== "boolean" || (style.notes !== undefined && typeof style.notes !== "boolean")) throw new Error("Layer style is invalid.");
    return { color: style.color, outline: style.outline, weight: style.weight, fillOpacity: style.fillOpacity, labels: style.labels || style.notes === true };
}

/**
 * Validate device storage before allowing it into the editor.
 * Older documents without positions retain their annotation order at the top of the stack.
 * Unreadable filters are cleared without changing drawings or supported filters.
 * @param {AnnotationDocument} document Versioned annotation document.
 * @param {(layerId:string)=>void} [onFilterCleared] Receives each layer whose unreadable filter was cleared.
 * @return {AnnotationLayer[]} Independent, validated annotation layers.
 * @throws {Error} If stored data is unsupported, malformed or too large.
 */
export function readAnnotationLayers(document, onFilterCleared = () => {}) {
    if (!document || document.version !== 1 || !Array.isArray(document.layers) || document.layers.length > MAX_ANNOTATION_LAYERS ||
        new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_ANNOTATION_DOCUMENT_BYTES) throw new Error("Saved polygons have an unsupported format or exceed the storage limit.");
    const layers = structuredClone(document.layers);
    const identifiers = new Set();
    for (const [index, layer] of layers.entries()) {
        if (layer.position === undefined) layer.position = index;
        if (!Number.isSafeInteger(layer.position) || layer.position < 0) throw new Error("Saved polygon layer position is invalid.");
        requireIdentifier(layer.id, identifiers);
        requireText(layer.name, MAX_ANNOTATION_NAME_LENGTH, false);
        try { layer.filter = annotationFilterRules(layer.filter); }
        catch {
            layer.filter = structuredClone(EMPTY_VECTOR_FILTER);
            onFilterCleared(layer.id);
        }
        if (typeof layer.visible !== "boolean" || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1 ||
            !Array.isArray(layer.polygons) || layer.polygons.length > MAX_POLYGONS_PER_LAYER) throw new Error("Saved polygon layer is invalid.");
        layer.style = validateAnnotationStyle(layer.style);
        for (const polygon of layer.polygons) {
            requireIdentifier(polygon.id, identifiers);
            requireText(polygon.name, MAX_ANNOTATION_NAME_LENGTH, false);
            requireText(polygon.note, MAX_ANNOTATION_NOTE_LENGTH, true);
            if (polygon.contributor !== undefined) requireText(polygon.contributor, MAX_ANNOTATION_NAME_LENGTH, true);
            if (polygon.contributorColor !== undefined) {
                requireText(polygon.contributor, MAX_ANNOTATION_NAME_LENGTH, false);
                if (!/^#[\da-f]{6}$/i.test(polygon.contributorColor)) throw new Error("Saved contributor color is invalid.");
            }
            if (!Array.isArray(polygon.vertices) || polygon.vertices.length > MAX_POLYGON_VERTICES || polygonValidationMessage(polygon.vertices)) {
                throw new Error("Saved polygons contain an invalid polygon.");
            }
        }
    }
    return layers;
}

/**
 * Check a persistent identifier for uniqueness and safe local key use.
 * @param {string} id Candidate identifier.
 * @param {Set<string>} identifiers Already admitted identifiers.
 * @return {void}
 * @throws {Error} If duplicated or malformed.
 */
function requireIdentifier(id, identifiers) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id) || identifiers.has(id)) throw new Error("Saved layer identifiers are invalid.");
    identifiers.add(id);
}

/**
 * Check bounded user text at the storage boundary.
 * @param {string} text User text.
 * @param {number} maximum Maximum character count.
 * @param {boolean} allowEmpty Whether blank text is allowed.
 * @return {void}
 * @throws {Error} If text is missing or too long.
 */
function requireText(text, maximum, allowEmpty) {
    if (typeof text !== "string" || text.length > maximum || (!allowEmpty && !text.trim())) throw new Error("Polygon text is empty or too long.");
}

/**
 * Match annotation field conditions with case-sensitive text comparisons.
 * @param {AnnotationLayer} layer Annotation layer.
 * @return {Object[]} Matching polygons in their original order.
 */
export function matchingAnnotationPolygons(layer) {
    return filterAnnotationPolygons(layer.polygons, layer.filter);
}

/** Own committed annotations, an isolated editing draft and one deletion undo. */
export class AnnotationModel {
    /**
     * Create a local collection of annotation layers.
     * @param {AnnotationLayer[]} [layers=[]] Validated stored layers.
     * @param {()=>string} [newId] Stable identifier generator.
     */
    constructor(layers = [], newId = () => globalThis.crypto.randomUUID()) {
        this.layers = layers;
        this.newId = newId;
        this.draft = null;
        this.deleted = null;
    }

    /** @return {AnnotationDocument} Versioned saved document excluding unfinished edits and undo. */
    document() { return { version: 1, layers: structuredClone(this.layers) }; }

    /**
     * Find a layer owned by this collection.
     * @param {string} id Layer identifier.
     * @return {AnnotationLayer} Annotation layer.
     * @throws {Error} If the layer no longer exists.
     */
    layer(id) {
        const layer = this.layers.find(candidate => candidate.id === id);
        if (!layer) throw new Error("This polygon layer no longer exists.");
        return layer;
    }

    /**
     * Create an empty private polygon layer at the top of the device collection.
     * @return {AnnotationLayer} New layer named Polygon layer followed by its number.
     * @throws {Error} If the device collection is at its layer limit.
     */
    createLayer() {
        if (this.layers.length >= MAX_ANNOTATION_LAYERS) throw new Error(`This device already has ${MAX_ANNOTATION_LAYERS} polygon layers.`);
        const layer = { id: this.newId(), name: `Polygon layer ${this.layers.length + 1}`, position: 0, visible: true, opacity: 1,
            style: { ...DEFAULT_ANNOTATION_STYLE }, filter: structuredClone(EMPTY_VECTOR_FILTER), polygons: [] };
        this.layers.unshift(layer);
        return layer;
    }

    /**
     * Add a validated GeoJSON import as a new layer with fresh local IDs.
     * Check collection capacity before changing existing data; importing never overwrites a layer.
     * @param {import("./geojson.js").ImportedAnnotationLayer} imported Validated file contents.
     * @return {AnnotationLayer} Newly added layer using default appearance and no filter.
     * @throws {Error} If editing is in progress or the layer/document limit would be exceeded.
     */
    importLayer(imported) {
        if (this.draft) throw new Error("Save or cancel the current polygon before importing.");
        if (this.layers.length >= MAX_ANNOTATION_LAYERS) throw new Error(`This device already has ${MAX_ANNOTATION_LAYERS} polygon layers.`);
        const layer = { id: this.newId(), name: imported.name, position: 0, visible: true, opacity: 1,
            style: { ...DEFAULT_ANNOTATION_STYLE }, filter: structuredClone(EMPTY_VECTOR_FILTER),
            polygons: imported.polygons.map(polygon => ({ ...structuredClone(polygon), id: this.newId() })) };
        const document = { version: 1, layers: [layer, ...this.layers] };
        if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_ANNOTATION_DOCUMENT_BYTES) {
            throw new Error("Import would exceed the 8 MiB polygon storage limit. Export and remove an existing layer first.");
        }
        this.layers.unshift(layer);
        return layer;
    }

    /**
     * Restore committed data from this tab's layer-removal snapshot without changing IDs.
     * @param {AnnotationLayer} snapshot Previously owned layer data.
     * @return {AnnotationLayer} Independent layer added to the collection.
     * @throws {Error} If its ID is already present or the current collection would exceed storage limits.
     */
    restoreRemovedLayer(snapshot) {
        if (this.layers.some(layer => layer.id === snapshot.id)) throw new Error("This polygon layer is already on the map.");
        if (this.layers.length >= MAX_ANNOTATION_LAYERS) throw new Error(`This device already has ${MAX_ANNOTATION_LAYERS} polygon layers.`);
        const layer = structuredClone(snapshot);
        const document = { version: 1, layers: [layer, ...this.layers] };
        if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_ANNOTATION_DOCUMENT_BYTES) {
            throw new Error("Restoring this layer would exceed the 8 MiB polygon storage limit. Export and remove another layer first.");
        }
        this.layers.unshift(layer);
        return layer;
    }

    /**
     * Start a new polygon or copy an existing one into an editing draft.
     * @param {string} layerId Owning layer.
     * @param {string|null} [polygonId=null] Polygon to edit, or a new drawing.
     * @return {void}
     * @throws {Error} If another draft is open, a polygon is missing or a limit is reached.
     */
    beginPolygon(layerId, polygonId = null) {
        if (this.draft) throw new Error("Save or cancel the current polygon first.");
        const layer = this.layer(layerId);
        const polygon = polygonId === null ? { id: this.newId(), name: `Polygon ${layer.polygons.length + 1}`, note: "", vertices: [] }
            : layer.polygons.find(candidate => candidate.id === polygonId);
        if (!polygon) throw new Error("This polygon no longer exists.");
        if (polygonId === null && layer.polygons.length >= MAX_POLYGONS_PER_LAYER) throw new Error(`This polygon layer already has ${MAX_POLYGONS_PER_LAYER} polygons.`);
        this.draft = { layerId, polygon: structuredClone(polygon), isNew: polygonId === null, outlineClosed: polygonId !== null };
    }

    /**
     * Change the draft's name and notes without touching saved or shared polygons.
     * Blank names remain editable and become Polygon on Save.
     * @param {string} name Polygon name, at most 160 characters.
     * @param {string} note Polygon notes, at most 10,000 characters.
     * @return {void}
     * @throws {Error} If no draft exists or either text value exceeds its limit.
     */
    updateDraftText(name, note) {
        if (!this.draft) throw new Error("Start editing a polygon before changing its name or notes.");
        requireText(name, MAX_ANNOTATION_NAME_LENGTH, true);
        requireText(note, MAX_ANNOTATION_NOTE_LENGTH, true);
        Object.assign(this.draft.polygon, { name, note });
    }

    /**
     * Close a valid outline without saving; vertices, name and notes remain editable.
     * @return {void}
     * @throws {Error} If the draft is missing or its outline is invalid.
     */
    closePolygonOutline() {
        if (!this.draft) throw new Error("Start a polygon before closing its outline.");
        const message = polygonValidationMessage(this.draft.polygon.vertices);
        if (message) throw new Error(message);
        this.draft.outlineClosed = true;
    }

    /**
     * Add a vertex to the current draft, inserting before an index or appending when omitted.
     * Saved geometry is unchanged until the draft is saved.
     * @param {number[]} position Longitude and latitude.
     * @param {number} [index] Insertion index, from zero through the current vertex count.
     * @return {void}
     * @throws {Error} If no draft exists, the index is invalid or the vertex limit is reached.
     */
    addVertex(position, index = this.draft?.polygon.vertices.length) {
        if (!this.draft) throw new Error("Start a polygon before adding vertices.");
        if (this.draft.polygon.vertices.length >= MAX_POLYGON_VERTICES) throw new Error(`A polygon can have at most ${MAX_POLYGON_VERTICES} vertices.`);
        if (!Number.isInteger(index) || index < 0 || index > this.draft.polygon.vertices.length) {
            throw new Error("Choose an edge on the current polygon before inserting a vertex.");
        }
        this.draft.polygon.vertices.splice(index, 0, [...position]);
    }

    /**
     * Save a polygon's shape, name and notes together, retaining the previous polygon on failure.
     * @return {AnnotationPolygon} Saved polygon.
     * @throws {Error} If the draft is missing, its geometry/text is invalid, or the saved polygon is gone.
     */
    savePolygon() {
        if (!this.draft) throw new Error("No polygon is being edited.");
        const message = polygonValidationMessage(this.draft.polygon.vertices);
        if (message) throw new Error(message);
        const { layerId, polygon, isNew } = this.draft;
        requireText(polygon.name, MAX_ANNOTATION_NAME_LENGTH, true);
        requireText(polygon.note, MAX_ANNOTATION_NOTE_LENGTH, true);
        const layer = this.layer(layerId);
        const saved = isNew ? polygon : layer.polygons.find(candidate => candidate.id === polygon.id);
        if (!saved) throw new Error("This polygon is no longer available to edit.");
        Object.assign(saved, { vertices: polygon.vertices, name: polygon.name.trim() || "Polygon", note: polygon.note });
        if (isNew) layer.polygons.push(saved);
        this.draft = null;
        return saved;
    }

    /** Discard draft geometry, name and notes without changing saved polygons. @return {void} */
    cancelPolygon() { this.draft = null; }

    /**
     * Delete a saved polygon or drawing and retain one undo snapshot.
     * @param {string} layerId Owning layer.
     * @param {string} polygonId Polygon identifier.
     * @return {void}
     */
    deletePolygon(layerId, polygonId) {
        const layer = this.layer(layerId);
        const index = layer.polygons.findIndex(polygon => polygon.id === polygonId);
        const draft = this.draft?.polygon.id === polygonId ? structuredClone(this.draft) : null;
        this.deleted = index >= 0 ? { layerId, polygon: structuredClone(layer.polygons[index]), index }
            : draft ? { layerId, draft } : null;
        if (index >= 0) layer.polygons.splice(index, 1);
        if (draft) this.draft = null;
    }

    /**
     * Restore the last deletion; an unfinished drawing reopens as a draft.
     * @return {boolean} Whether a deletion was undone.
     * @throws {Error} If a draft is open or the owning layer has been removed.
     */
    undoDeletion() {
        if (!this.deleted) return false;
        if (this.draft) throw new Error("Save or cancel the current polygon first.");
        const { layerId, polygon, index, draft } = this.deleted;
        const layer = this.layer(layerId);
        if (draft) this.draft = draft;
        else {
            if (layer.polygons.length >= MAX_POLYGONS_PER_LAYER) throw new Error(`Remove a polygon before undoing: this layer already has ${MAX_POLYGONS_PER_LAYER} polygons.`);
            layer.polygons.splice(index, 0, polygon);
        }
        this.deleted = null;
        return true;
    }
}
