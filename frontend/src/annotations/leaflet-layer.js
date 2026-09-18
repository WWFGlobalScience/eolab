/** Independent Leaflet rendering for an annotation layer in the map stack. */
import { matchingAnnotationPolygons } from "./model.js";
import { updatePolygonLabel } from "./polygon-label.js";

/**
 * Create a local vector layer with the same opacity/order hooks as tiled layers.
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} map Leaflet map.
 * @param {import("./model.js").AnnotationLayer} annotation Annotation layer data.
 * @return {Object} Leaflet layer supporting refresh, draft visibility, opacity and drawing order.
 */
export function createAnnotationLeafletLayer(leaflet, map, annotation) {
    // Leaflet accepts a pane element, so deleting a layer can release the pane too.
    const pane = leaflet.DomUtil.create("div", "leaflet-pane leaflet-annotation-pane", map.getPane("tilePane"));
    pane.style.pointerEvents = "none";
    const renderer = leaflet.svg({ pane });
    const group = leaflet.featureGroup();
    const shapes = new Map();
    let editingPolygon = null;
    /**
     * Update retained shapes and labels without restarting tooltip fades while typing.
     * @return {void}
     */
    group.refresh = () => {
        const polygons = matchingAnnotationPolygons(annotation).filter(polygon => polygon.id !== editingPolygon);
        const visibleIds = new Set(polygons.map(polygon => polygon.id));
        for (const [id, { shape }] of shapes) {
            if (!visibleIds.has(id)) { group.removeLayer(shape); shapes.delete(id); }
        }
        for (const polygon of polygons) {
            let retained = shapes.get(polygon.id);
            if (!retained) {
                const shape = leaflet.polygon([], { pane, renderer, interactive: false });
                retained = { shape, vertices: null };
                shapes.set(polygon.id, retained);
                group.addLayer(shape);
            }
            const { shape } = retained;
            if (retained.vertices !== polygon.vertices) {
                shape.setLatLngs(polygon.vertices.map(([lng, lat]) => [lat, lng]));
                retained.vertices = polygon.vertices;
            }
            shape.setStyle({ color: annotation.style.outline, fillColor: annotation.style.color,
                weight: annotation.style.weight, fillOpacity: annotation.style.fillOpacity });
            updatePolygonLabel(shape, polygon, annotation.style, map.getContainer().ownerDocument, pane);
        }
    };
    /**
     * Hide the saved polygon while the editor shows its draft and moving label.
     * @param {string|null} id Edited polygon, or null to show every saved polygon again.
     * @return {void}
     */
    group.setEditingPolygon = id => {
        if (editingPolygon === id) return;
        editingPolygon = id;
        group.refresh();
    };
    /** @param {number} opacity Layer opacity. @return {void} */
    group.setOpacity = opacity => { pane.style.opacity = String(opacity); };
    /** @param {number} zIndex Position among individual map layers. @return {void} */
    group.setZIndex = zIndex => { pane.style.zIndex = String(zIndex); };
    /** Remove the layer's renderer and pane. @return {void} */
    group.release = () => { group.clearLayers(); shapes.clear(); map.removeLayer(renderer); pane.remove(); };
    group.refresh();
    return group;
}
