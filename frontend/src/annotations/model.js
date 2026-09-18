/** Browser-owned annotation data and isolated polygon editing drafts. */
import { polygonValidationMessage } from "./geometry.js";

/**
 * @typedef {{color:string,outline:string,weight:number,fillOpacity:number,labels:boolean}} AnnotationStyle
 * @typedef {{id:string,name:string,note:string,vertices:number[][]}} AnnotationPolygon
 * @typedef {{id:string,name:string,visible:boolean,opacity:number,style:AnnotationStyle,filter:string,polygons:AnnotationPolygon[]}} AnnotationLayer
 * @typedef {{version:1,layers:AnnotationLayer[]}} AnnotationDocument
 * @typedef {{layerId:string,polygon:AnnotationPolygon,isNew:boolean}} PolygonDraft
 */

export const MAX_POLYGON_VERTICES = 2000;
export const DEFAULT_ANNOTATION_STYLE = Object.freeze({ color: "#1686b0", outline: "#202020", weight: 1, fillOpacity: 0.25, labels: true });

/**
 * Validate a stored or copied annotation appearance.
 * @param {AnnotationStyle} style Fill, outline, width, fill opacity and label settings.
 * @return {AnnotationStyle} Independent validated appearance.
 * @throws {Error} If any appearance setting is invalid.
 */
export function validateAnnotationStyle(style) {
    if (!style || !/^#[\da-f]{6}$/i.test(style.color) || !/^#[\da-f]{6}$/i.test(style.outline) ||
        !Number.isFinite(style.weight) || style.weight < 0 || style.weight > 10 ||
        !Number.isFinite(style.fillOpacity) || style.fillOpacity < 0 || style.fillOpacity > 1 ||
        typeof style.labels !== "boolean") throw new Error("Annotation style is invalid.");
    return { color: style.color, outline: style.outline, weight: style.weight, fillOpacity: style.fillOpacity, labels: style.labels };
}

/**
 * Validate device storage before allowing it into the editor.
 * @param {AnnotationDocument} document Versioned annotation document.
 * @return {AnnotationLayer[]} Independent, validated annotation layers.
 * @throws {Error} If stored data is unsupported, malformed or too large.
 */
export function readAnnotationLayers(document) {
    if (!document || document.version !== 1 || !Array.isArray(document.layers) || document.layers.length > 32 ||
        new TextEncoder().encode(JSON.stringify(document)).byteLength > 8 * 1024 * 1024) throw new Error("Saved annotations have an unsupported format or exceed the storage limit.");
    const layers = structuredClone(document.layers);
    const identifiers = new Set();
    for (const layer of layers) {
        requireIdentifier(layer.id, identifiers);
        requireText(layer.name, 160, false);
        requireText(layer.filter, 300, true);
        if (typeof layer.visible !== "boolean" || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1 ||
            !Array.isArray(layer.polygons) || layer.polygons.length > 500) throw new Error("Saved annotation layer is invalid.");
        layer.style = validateAnnotationStyle(layer.style);
        for (const polygon of layer.polygons) {
            requireIdentifier(polygon.id, identifiers);
            requireText(polygon.name, 160, false);
            requireText(polygon.note, 10000, true);
            if (!Array.isArray(polygon.vertices) || polygon.vertices.length > MAX_POLYGON_VERTICES || polygonValidationMessage(polygon.vertices)) {
                throw new Error("Saved annotations contain an invalid polygon.");
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
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id) || identifiers.has(id)) throw new Error("Saved annotation identifiers are invalid.");
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
    if (typeof text !== "string" || text.length > maximum || (!allowEmpty && !text.trim())) throw new Error("Annotation text is empty or too long.");
}

/**
 * Match polygon names and notes against a layer's case-insensitive text filter.
 * @param {AnnotationLayer} layer Annotation layer.
 * @return {Object[]} Matching polygons in their original order.
 */
export function matchingAnnotationPolygons(layer) {
    const text = layer.filter.trim().toLocaleLowerCase();
    return layer.polygons.filter(polygon => `${polygon.name}\n${polygon.note}`.toLocaleLowerCase().includes(text));
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
        if (!layer) throw new Error("This annotation layer no longer exists.");
        return layer;
    }

    /**
     * Create an empty named annotation layer at the top of the collection.
     * @return {AnnotationLayer} New layer.
     * @throws {Error} If the device collection is at its layer limit.
     */
    createLayer() {
        if (this.layers.length >= 32) throw new Error("This device already has 32 annotation layers.");
        const layer = { id: this.newId(), name: `Annotations ${this.layers.length + 1}`, visible: true, opacity: 1,
            style: { ...DEFAULT_ANNOTATION_STYLE }, filter: "", polygons: [] };
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
        if (polygonId === null && layer.polygons.length >= 500) throw new Error("This annotation layer already has 500 polygons.");
        this.draft = { layerId, polygon: structuredClone(polygon), isNew: polygonId === null };
    }

    /**
     * Append a vertex to the current draft without changing saved geometry.
     * @param {number[]} position Longitude and latitude.
     * @return {void}
     * @throws {Error} If no draft exists or its vertex limit is reached.
     */
    addVertex(position) {
        if (!this.draft) throw new Error("Start a polygon before adding vertices.");
        if (this.draft.polygon.vertices.length >= MAX_POLYGON_VERTICES) throw new Error(`A polygon can have at most ${MAX_POLYGON_VERTICES} vertices.`);
        this.draft.polygon.vertices.push([...position]);
    }

    /**
     * Save valid draft geometry, retaining the previous polygon on failure.
     * @return {AnnotationPolygon} Saved polygon.
     * @throws {Error} If the draft is missing or geometrically invalid.
     */
    savePolygon() {
        if (!this.draft) throw new Error("No polygon is being edited.");
        const message = polygonValidationMessage(this.draft.polygon.vertices);
        if (message) throw new Error(message);
        const { layerId, polygon, isNew } = this.draft;
        const layer = this.layer(layerId);
        const saved = isNew ? polygon : layer.polygons.find(candidate => candidate.id === polygon.id);
        if (isNew) layer.polygons.push(saved);
        else saved.vertices = polygon.vertices;
        this.draft = null;
        return saved;
    }

    /** Discard draft geometry without changing saved polygons. @return {void} */
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
            if (layer.polygons.length >= 500) throw new Error("Remove a polygon before undoing: this layer already has 500 polygons.");
            layer.polygons.splice(index, 0, polygon);
        }
        this.deleted = null;
        return true;
    }
}
