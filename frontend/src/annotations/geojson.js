/** Convert annotation layers to and from ordinary GeoJSON files. */
import { polygonValidationMessage } from "./geometry.js";
import { MAX_POLYGON_VERTICES, MAX_POLYGONS_PER_LAYER, MAX_ANNOTATION_DOCUMENT_BYTES,
    MAX_ANNOTATION_NAME_LENGTH, MAX_ANNOTATION_NOTE_LENGTH } from "./model.js";

/**
 * @typedef {{name:string,note:string,vertices:number[][]}} ImportedAnnotationPolygon
 * @typedef {{name:string,polygons:ImportedAnnotationPolygon[]}} ImportedAnnotationLayer
 */

/**
 * Read a bounded local file and validate all polygons before creating any layer.
 * @param {File} file User-selected GeoJSON file; nothing is uploaded.
 * @return {Promise<ImportedAnnotationLayer>} Names, notes and editable polygon coordinates.
 * @throws {Error} If the file cannot be read, is too large, or contains unsupported data.
 */
export async function readAnnotationGeoJSONFile(file) {
    if (file.size > MAX_ANNOTATION_DOCUMENT_BYTES) throw new Error("GeoJSON file exceeds the 8 MiB import limit.");
    let text;
    try { text = await file.text(); }
    catch { throw new Error("Could not read this GeoJSON file. Choose it again."); }
    const filename = file.name.replace(/\.(geojson|json)$/i, "").slice(0, MAX_ANNOTATION_NAME_LENGTH);
    return parseAnnotationGeoJSON(text, filename || "Imported annotations");
}

/**
 * Validate an entire GeoJSON document and convert it into editable annotation polygons.
 * Accept a FeatureCollection, Feature or Polygon. Only name/title and note/description
 * strings are imported; other properties, feature IDs and styling are ignored.
 * @param {string} text JSON file contents, limited to 8 MiB.
 * @param {string} [fallbackName="Imported annotations"] Layer name when the collection has none.
 * @return {ImportedAnnotationLayer} Validated data with no local IDs or persistence side effects.
 * @throws {Error} If JSON, geometry, coordinates or resource limits are invalid.
 */
export function parseAnnotationGeoJSON(text, fallbackName = "Imported annotations") {
    if (new TextEncoder().encode(text).byteLength > MAX_ANNOTATION_DOCUMENT_BYTES) {
        throw new Error("GeoJSON file exceeds the 8 MiB import limit.");
    }
    let document;
    try { document = JSON.parse(text.replace(/^\uFEFF/, "")); }
    catch { throw new Error("This file is not valid JSON. Choose a GeoJSON file."); }
    if (!document || typeof document !== "object" || Array.isArray(document)) {
        throw new Error("Expected a GeoJSON FeatureCollection, Feature or Polygon object.");
    }
    rejectDeclaredCRS(document, "GeoJSON");
    let features;
    if (document.type === "FeatureCollection") {
        if (!Array.isArray(document.features)) throw new Error("GeoJSON FeatureCollection must contain a features array.");
        features = document.features;
    } else if (document.type === "Feature") features = [document];
    else if (document.type === "Polygon") features = [{ type: "Feature", properties: null, geometry: document }];
    else throw new Error(`Unsupported GeoJSON type: ${String(document.type).slice(0, 80)}. Import Polygon features only.`);
    if (features.length > MAX_POLYGONS_PER_LAYER) {
        throw new Error(`GeoJSON contains ${features.length} features; an annotation layer supports at most ${MAX_POLYGONS_PER_LAYER} polygons.`);
    }
    const name = importAnnotationText([document.type === "FeatureCollection" ? document.name : null, fallbackName],
        "Imported annotations", MAX_ANNOTATION_NAME_LENGTH, "Layer name");
    const polygons = features.map((feature, index) => {
        const context = `Feature ${index + 1}`;
        if (!feature || feature.type !== "Feature") throw new Error(`${context}: expected a GeoJSON Feature object.`);
        rejectDeclaredCRS(feature, context);
        const properties = feature.properties;
        const name = importAnnotationText([properties?.name, properties?.title], `Polygon ${index + 1}`,
            MAX_ANNOTATION_NAME_LENGTH, `${context} name`);
        const note = importAnnotationText([properties?.note, properties?.description], "",
            MAX_ANNOTATION_NOTE_LENGTH, `${context} note`, true);
        return { name, note, vertices: importPolygonVertices(feature.geometry, context) };
    });
    return { name, polygons };
}

/**
 * Choose recognized string text, falling back when optional properties do not match.
 * @param {unknown[]} candidates Recognized properties in preference order.
 * @param {string} fallback Default text when none is a nonblank string.
 * @param {number} maximum Maximum supported character count.
 * @param {string} context Field description for errors.
 * @param {boolean} [allowBlank=false] Preserve empty/whitespace notes instead of applying a fallback.
 * @return {string} Original text, without HTML interpretation or whitespace changes.
 * @throws {Error} If recognized text exceeds the annotation field limit.
 */
function importAnnotationText(candidates, fallback, maximum, context, allowBlank = false) {
    const value = candidates.find(candidate => typeof candidate === "string" && (allowBlank || candidate.trim())) ?? fallback;
    if (value.length > maximum) throw new Error(`${context} exceeds the ${maximum}-character limit.`);
    return value;
}

/**
 * Reject legacy CRS declarations rather than interpreting projected coordinates as degrees.
 * @param {Object} object GeoJSON object at the current boundary.
 * @param {string} context Object description for the error.
 * @return {void}
 * @throws {Error} If a legacy crs member is present.
 */
function rejectDeclaredCRS(object, context) {
    if (Object.hasOwn(object, "crs")) {
        throw new Error(`${context}: CRS declarations are not supported. Export GeoJSON in WGS84 longitude/latitude without a crs member.`);
    }
}

/**
 * Validate a single closed exterior ring and remove its repeated closing coordinate.
 * @param {Object|null} geometry Untrusted GeoJSON geometry.
 * @param {string} context Feature number for descriptive errors.
 * @return {number[][]} Independent two-dimensional vertices accepted by the annotation editor.
 * @throws {Error} If geometry has holes, another type, invalid coordinates or an invalid ring.
 */
function importPolygonVertices(geometry, context) {
    if (!geometry || geometry.type !== "Polygon") {
        throw new Error(`${context}: ${String(geometry?.type ?? "missing geometry").slice(0, 80)} is not supported. Import Polygon features only.`);
    }
    rejectDeclaredCRS(geometry, context);
    const rings = geometry.coordinates;
    if (!Array.isArray(rings) || rings.length === 0) throw new Error(`${context}: Polygon must contain an exterior ring.`);
    if (rings.length > 1) throw new Error(`${context}: polygon has holes. Annotation polygons support one exterior ring without holes.`);
    const ring = rings[0];
    if (!Array.isArray(ring) || ring.length < 4) throw new Error(`${context}: polygon must have at least 3 vertices and a repeated closing coordinate.`);
    if (ring.length > MAX_POLYGON_VERTICES + 1) throw new Error(`${context}: polygon exceeds the ${MAX_POLYGON_VERTICES}-vertex limit.`);
    for (const point of ring) {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
            throw new Error(`${context}: each coordinate must contain exactly two finite numbers: longitude and latitude. Altitude is not supported.`);
        }
        if (Math.abs(point[0]) > 180 || Math.abs(point[1]) > 85.05112878) {
            throw new Error(`${context}: coordinates are outside the editable map bounds. Use WGS84 longitude from -180 to 180 and latitude from -85.05112878 to 85.05112878.`);
        }
    }
    if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) {
        throw new Error(`${context}: polygon ring is not closed. Its last coordinate must equal its first.`);
    }
    const vertices = ring.slice(0, -1).map(point => [...point]);
    const error = polygonValidationMessage(vertices);
    if (error) throw new Error(`${context}: ${error}`);
    return vertices;
}

/**
 * Export every committed polygon in a layer, including polygons hidden by its filter.
 * Names and notes are plain GeoJSON properties; the layer name is a collection member.
 * Exterior rings use counterclockwise winding. Drafts and display settings are excluded.
 * @param {import("./model.js").AnnotationLayer} layer Validated local annotation layer.
 * @return {Object} Independent GeoJSON FeatureCollection ready for JSON serialization.
 */
export function exportAnnotationGeoJSON(layer) {
    return { type: "FeatureCollection", name: layer.name, features: layer.polygons.map(polygon => {
        const ring = polygon.vertices.map(point => [...point]);
        const signedArea = ring.reduce((sum, point, index) => {
            const next = ring[(index + 1) % ring.length];
            return sum + point[0] * next[1] - next[0] * point[1];
        }, 0);
        ring.push([...ring[0]]);
        if (signedArea < 0) ring.reverse();
        return { type: "Feature", id: polygon.id, properties: { name: polygon.name, note: polygon.note },
            geometry: { type: "Polygon", coordinates: [ring] } };
    }) };
}
