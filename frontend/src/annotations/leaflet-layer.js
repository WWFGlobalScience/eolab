/** Independent Leaflet rendering for an annotation layer in the map stack. */
import { matchingAnnotationPolygons } from "./model.js";

/**
 * Create a local vector layer with the same opacity/order hooks as tiled layers.
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} map Leaflet map.
 * @param {import("./model.js").AnnotationLayer} annotation Annotation layer data.
 * @return {Object} Leaflet layer supporting refresh, setOpacity and setZIndex.
 */
export function createAnnotationLeafletLayer(leaflet, map, annotation) {
    // Leaflet accepts a pane element, so deleting a layer can release the pane too.
    const pane = leaflet.DomUtil.create("div", "leaflet-pane leaflet-annotation-pane", map.getPane("tilePane"));
    pane.style.pointerEvents = "none";
    const renderer = leaflet.svg({ pane });
    const group = leaflet.featureGroup();
    /**
     * Rebuild shapes and labels after an annotation or filter changes.
     * @return {void}
     */
    group.refresh = () => {
        group.clearLayers();
        for (const polygon of matchingAnnotationPolygons(annotation)) {
            const shape = leaflet.polygon(polygon.vertices.map(([lng, lat]) => [lat, lng]), {
                pane, renderer, interactive: false,
                color: annotation.style.outline, fillColor: annotation.style.color,
                weight: annotation.style.weight, fillOpacity: annotation.style.fillOpacity,
            });
            if (annotation.style.labels) {
                const label = map.getContainer().ownerDocument.createElement("span");
                label.textContent = polygon.name;
                shape.bindTooltip(label, { permanent: true, direction: "center", pane, className: "annotation-polygon-label" });
            }
            group.addLayer(shape);
        }
    };
    /** @param {number} opacity Layer opacity. @return {void} */
    group.setOpacity = opacity => { pane.style.opacity = String(opacity); };
    /** @param {number} zIndex Position among individual map layers. @return {void} */
    group.setZIndex = zIndex => { pane.style.zIndex = String(zIndex); };
    /** Remove the layer's renderer and pane. @return {void} */
    group.release = () => { group.clearLayers(); map.removeLayer(renderer); pane.remove(); };
    group.refresh();
    return group;
}
