/**
 * Leaflet adapter for EOLab's single canonical WGS 84 world.
 *
 * This module owns map and basemap options so horizontal bounds and tile
 * wrapping cannot drift apart as the application composition changes.
 */

import { addBasemapControl } from "./basemap-control.js";

export const SINGLE_WORLD_BOUNDS = [
    [-90, -180],
    [90, 180]
];

/**
 * Convert a STAC Item's 2D/3D bbox to Leaflet's latitude/longitude corners.
 *
 * RFC 7946 section 5 orders all lower axes before all upper axes. A crossing
 * bbox (west > east) needs the full longitude span to show both sides within
 * this application's single, non-wrapping world.
 *
 * @param {Object|null} item Catalog Item with a WGS 84 bounding box.
 * @return {number[][]|null} Map corners, or null for missing/invalid bounds.
 */
export function getCatalogItemMapBounds(item) {
    const bbox = item?.bbox;
    if (!Array.isArray(bbox) || ![4, 6].includes(bbox.length) ||
        !bbox.every(Number.isFinite)) return null;
    const dimensions = bbox.length / 2;
    const [west, south] = bbox;
    const [east, north] = bbox.slice(dimensions);
    if (south < -90 || north > 90 || south > north ||
        Math.abs(west) > 180 || Math.abs(east) > 180 ||
        (dimensions === 3 && bbox[2] > bbox[5])) return null;
    return [[south, west > east ? -180 : west], [north, west > east ? 180 : east]];
}

/**
 * Format a pointer position only when it belongs to the canonical world.
 *
 * At low zoom, a viewport can be wider than Leaflet's zoom-zero world. The
 * unused area is intentionally blank and must not display noncanonical
 * longitude values.
 *
 * @param {{lat: number, lng: number}} position Leaflet geographic position.
 * @return {string} Canonical coordinate text or an outside-bounds label.
 */
export function formatSingleWorldPosition(position) {
    if (
        !Number.isFinite(position?.lat) ||
        !Number.isFinite(position?.lng) ||
        position.lat < -90 ||
        position.lat > 90 ||
        position.lng < -180 ||
        position.lng > 180
    ) {
        return "Outside map bounds";
    }
    return `${position.lat.toFixed(3)}, ${position.lng.toFixed(3)}`;
}

/**
 * Create the application map and basemap without repeated world copies.
 *
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} appGlobalConfiguration Browser-safe application settings.
 * @return {Object} Initialized Leaflet-compatible map.
 */
export function createSingleWorldMap(leaflet, appGlobalConfiguration) {
    const leafletMap = leaflet.map("map", {
        zoomControl: false,
        minZoom: 0,
        maxZoom: 22,
        maxBounds: SINGLE_WORLD_BOUNDS,
        maxBoundsViscosity: 1,
        worldCopyJump: false
    }).setView(
        [
            appGlobalConfiguration.initialView.latitude,
            appGlobalConfiguration.initialView.longitude
        ],
        appGlobalConfiguration.initialView.zoom
    );

    leaflet.control.zoom({ position: "bottomleft" }).addTo(leafletMap);
    addBasemapControl(leaflet, leafletMap, appGlobalConfiguration.basemap, SINGLE_WORLD_BOUNDS);

    return leafletMap;
}
