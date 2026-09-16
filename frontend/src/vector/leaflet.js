/** Leaflet construction and presentation metadata for bounded vector WMS. */

/** Fixed browser legend colors matching initializer-owned GeoServer SLDs. */
export const VECTOR_DEFAULT_SYMBOLOGY = Object.freeze({
    point: Object.freeze({
        label: "Point",
        fill: "#2b83ba",
        stroke: "#000000",
    }),
    line: Object.freeze({
        label: "Line",
        fill: "transparent",
        stroke: "#2b83ba",
    }),
    polygon: Object.freeze({
        label: "Polygon",
        fill: "#2b83ba",
        stroke: "#000000",
    }),
});

/**
 * Fit validated vector bounds into the application's single Leaflet world.
 *
 * Crossing extents use the full longitude span so both date-line edges can
 * render. This conservative display envelope does not replace catalog bounds.
 *
 * @param {number[]} bbox Validated WGS 84 west, south, east, north bounds.
 * @return {number[][]} Southwest and northeast Leaflet corners.
 */
export function vectorMapBounds(bbox) {
    const [west, south, east, north] = bbox;
    return [[south, west > east ? -180 : west], [north, west > east ? 180 : east]];
}

/**
 * Create one bounded WMS tile layer, retaining both sides of crossing extents.
 *
 * @param {Object} leaflet Leaflet namespace with a WMS factory.
 * @param {string} wmsUrl Browser-facing restricted WMS endpoint.
 * @param {{bbox:number[],layerName:string,geometryKind:string,styleName:string}}
 * publishedVector Validated publication contract.
 * @param {() => void} onTileError Reports the layer's first tile failure.
 * @return {Object} Leaflet-compatible bounded WMS tile layer.
 */
export function createVectorWmsLayer(
    leaflet,
    wmsUrl,
    publishedVector,
    onTileError
) {
    const layer = leaflet.tileLayer.wms(wmsUrl, {
        layers: publishedVector.layerName,
        styles: publishedVector.styleName,
        format: "image/png",
        transparent: true,
        tiled: true,
        tilesorigin: "-20037508.342789244,-20037508.342789244",
        version: "1.3.0",
        noWrap: true,
        bounds: vectorMapBounds(publishedVector.bbox),
    });
    layer.once("tileerror", onTileError);
    return layer;
}
