/**
 * Leaflet adapter for raster layers, bounds, and layer lifecycle.
 *
 * This module converts raster domain bounds to Leaflet coordinates, creates
 * WMS and sample-window layers, and manages keyed raster attachment, opacity,
 * and drawing order. It does not fetch publication or statistics data.
 */
import { validateRasterSelectedBounds } from "./geometry.js";
import { tessellateSamplingBox } from "../sampling-box.js";

export const RASTER_SAMPLE_WINDOW_PANE = "rasterSampleWindowPane";
const RASTER_SAMPLE_WINDOW_PANE_Z_INDEX = "450";

/**
 * Ensure sampling preview and selection outlines sit above raster imagery.
 *
 * @param {Object} leafletMap Leaflet-compatible map with pane factories.
 * @return {Object} Existing or created noninteractive sample-window pane.
 * @throws {Error} If Leaflet cannot provide the required styled pane.
 */
export function ensureRasterSampleWindowPane(leafletMap) {
    if (typeof leafletMap.getPane !== "function" ||
        typeof leafletMap.createPane !== "function") {
        throw new Error("Raster sample-window map pane factories are required.");
    }
    let pane = leafletMap.getPane(RASTER_SAMPLE_WINDOW_PANE);
    if (pane === undefined || pane === null) {
        pane = leafletMap.createPane(RASTER_SAMPLE_WINDOW_PANE);
    }
    if (pane === undefined || pane === null || pane.style === undefined) {
        throw new Error("Raster sample-window map pane is required.");
    }
    pane.style.zIndex = RASTER_SAMPLE_WINDOW_PANE_Z_INDEX;
    pane.style.pointerEvents = "none";
    return pane;
}
/**
 * Convert canonical bounds to Leaflet corners in the single visible world.
 *
 * @param {Object} bounds Canonical WGS 84 selected bounds.
 * @return {Array<Array<number>>} Southwest and northeast Leaflet corners.
 * @throws {Error} If bounds violate the selected-bounds contract.
 */
export function rasterSampleBoundsToLeaflet(bounds) {
    validateRasterSelectedBounds(bounds);
    return [
        [bounds.south, bounds.west],
        [bounds.north, bounds.east]
    ];
}
/**
 * Create the Leaflet WMS layer for one published Catalog raster.
 * Render through the map's maximum zoom of 22 instead of Leaflet's default 18.
 *
 * @param {Object} leaflet Leaflet namespace with a WMS tile-layer factory.
 * @param {string} wmsUrl Browser-facing GeoServer WMS endpoint.
 * @param {{bbox: number[], layerName: string}} publishedRaster Published
 * GeoServer layer identity and WGS 84 bounds.
 * @param {string} styleEnvironment Validated dynamic-style WMS environment.
 * @param {() => void} onTileError Reports the layer's first tile failure.
 * @return {Object} Leaflet-compatible WMS layer.
 */
export function createRasterWmsLayer(
    leaflet,
    wmsUrl,
    publishedRaster,
    styleEnvironment,
    onTileError
) {
    const [west, south, east, north] = publishedRaster.bbox;
    const rasterLayer = leaflet.tileLayer.wms(wmsUrl, {
        layers: publishedRaster.layerName,
        styles: "dynamic-raster",
        env: styleEnvironment,
        format: "image/png",
        transparent: true,
        tiled: true,
        tilesorigin: "-20037508.342789244,-20037508.342789244",
        version: "1.3.0",
        noWrap: true,
        maxZoom: 22,
        bounds: [
            [south, west],
            [north, east]
        ]
    });
    rasterLayer.once("tileerror", onTileError);
    return rasterLayer;
}

/**
 * Replace mutually exclusive raster style parameters before redrawing a layer.
 * Leaflet merges WMS parameters, so switching modes must remove the old key.
 * @param {Object} rasterLayer Leaflet WMS layer with mutable wmsParams.
 * @param {{env?:string,raster_style?:string}} parameters Validated style parameters.
 * @return {void}
 */
export function setRasterWmsStyle(rasterLayer, parameters) {
    delete rasterLayer.wmsParams.env;
    delete rasterLayer.wmsParams.raster_style;
    rasterLayer.setParams({ styles: "dynamic-raster", ...parameters });
}

/**
 * Apply or clear the ESOS-C additive compositing mode on one WMS tile layer.
 *
 * @param {Object} rasterLayer Leaflet-compatible WMS tile layer.
 * @param {boolean} isAdditive Whether this is the top additive raster.
 * @return {void}
 * @throws {Error} If Leaflet cannot provide its rendered container.
 */
export function setRasterLayerAdditiveBlend(rasterLayer, isAdditive) {
    const container = rasterLayer?.getContainer?.();
    if (container === undefined || container === null || !container.style) {
        throw new Error("Raster WMS layer container is unavailable.");
    }
    container.style.mixBlendMode = isAdditive ? "plus-lighter" : "normal";
}

/**
 * Draw a captured sampling-box polygon or an explicit geographic rectangle.
 *
 * @param {Object} leaflet Leaflet namespace with a polygon factory.
 * @param {Array<Array<number>>} bounds Visible-world Leaflet corners.
 * @param {"preview"|"selection"} layerKind Preview or committed-selection presentation.
 * @param {import("../sampling-box.js").SamplingBox|null} [samplingBox=null] Geodesic descriptor.
 * @param {Object|null} [leafletMap=null] Map supplying actual display-pixel projection for a box.
 * @return {Object} Leaflet polygon with setSampleWindow() for presentation-only redraws.
 */
export function createRasterSampleWindowLayer(leaflet, bounds, layerKind, samplingBox = null, leafletMap = null) {
    /** Construct Leaflet positions from the captured area on this map's pixel grid.
     * @param {number[][]} envelope Southwest/northeast bounds for rectangular inputs.
     * @param {import("../sampling-box.js").SamplingBox|null} box Optional geodesic descriptor.
     * @return {number[][]} Polygon positions in latitude/longitude order.
     */
    function positions(envelope, box) {
        if (!box) {
            return [envelope[0], [envelope[1][0], envelope[0][1]],
                envelope[1], [envelope[0][0], envelope[1][1]]];
        }
        return tessellateSamplingBox(box, points => points.map(([longitude, latitude]) => {
            const point = leafletMap.project([latitude, longitude]);
            return [point.x, point.y];
        })).map(([longitude, latitude]) => [latitude, longitude]);
    }
    const layer = leaflet.polygon(positions(bounds, samplingBox), layerKind === "preview"
        ? {pane: RASTER_SAMPLE_WINDOW_PANE, color: "#f97316", weight: 2, fill: false, interactive: false, smoothFactor: 0}
        : {pane: RASTER_SAMPLE_WINDOW_PANE, color: "#2563eb", weight: 2, fillColor: "#3b82f6", fillOpacity: 0.12, interactive: false, smoothFactor: 0});
    /** Redraw the captured geometry at the current zoom without changing its area.
     * @param {number[][]} envelope Southwest/northeast read-window envelope.
     * @param {import("../sampling-box.js").SamplingBox|null} box Optional geodesic descriptor.
     * @return {void}
     */
    layer.setSampleWindow = (envelope, box) => { layer.setLatLngs(positions(envelope, box)); };
    return layer;
}
