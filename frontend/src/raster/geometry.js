import { validateRasterSelectedBounds } from "../selected-area.js";
export { validateRasterSelectedBounds } from "../selected-area.js";
/**
 * Raster sampling geometry expressed in domain-level WGS 84 values.
 *
 * This module validates selected bounds and sample-window sizes and constructs
 * ground-distance sampling windows. It deliberately has no dependency on
 * Leaflet, browser APIs, rendering services, or the DOM.
 */
/**
 * Canonical non-wrapping WGS 84 raster bounds.
 *
 * @typedef {Object} RasterSelectedBounds
 * @property {number} west Western longitude in degrees.
 * @property {number} south Southern latitude in degrees.
 * @property {number} east Eastern longitude in degrees.
 * @property {number} north Northern latitude in degrees.
 */

/** Default side length for the interactive raster sample window, in kilometers. */
export const DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM = 600;

/** Smallest supported raster sample-window side length, in kilometers. */
const MINIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM = 1;

/** Mean Earth radius used for spherical WGS 84 sample-window calculations. */
const WGS84_MEAN_RADIUS_KM = 6371.0088;

/**
 * Largest integer side whose half-diagonal stays below a quarter circumference.
 * This is the existing non-polar geometry limit at the equator, not a sampling
 * performance limit. A box nearer a pole or date line may need to be smaller.
 */
export const MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM =
    Math.floor(Math.PI * WGS84_MEAN_RADIUS_KM / Math.sqrt(2));

/** Guidance shown when a sample window cannot use the non-wrapping contract. */
export const RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE =
    "This box reaches a pole or date line. Use a smaller box, move it, " +
    "or choose Whole raster / Whole overlap for global sampling. " +
    "The previous selection is unchanged.";

/** Guidance shown when the pointer is outside the canonical map world. */
export const RASTER_SAMPLE_WINDOW_MAP_BOUNDS_GUIDANCE =
    "Move the sample window inside the map bounds.";

/** Identify a valid sample window that crosses an unsupported world boundary. */
export class RasterSampleWindowBoundaryError extends RangeError {}

/**
 * Return whether a position belongs to the canonical non-wrapping WGS 84 world.
 *
 * @param {{longitude: number, latitude: number}|null|undefined} position
 * Candidate WGS 84 position.
 * @return {boolean} Whether both coordinates are finite and within bounds.
 */
export function isCanonicalWgs84Position(position) {
    return Number.isFinite(position?.longitude) &&
        Number.isFinite(position?.latitude) &&
        position.longitude >= -180 && position.longitude <= 180 &&
        position.latitude >= -90 && position.latitude <= 90;
}

/**
 * Enforce the integer size range supported by non-wrapping box geometry.
 *
 * @param {number} sideLengthKm Requested square side length in kilometers.
 * @return {number} The validated side length.
 * @throws {RangeError} If the side length is nonintegral or outside the
 * geometry-supported range.
 */
export function validateRasterSampleWindowSize(sideLengthKm) {
    if (
        !Number.isFinite(sideLengthKm) ||
        !Number.isInteger(sideLengthKm) ||
        sideLengthKm < MINIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM ||
        sideLengthKm > MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM
    ) {
        throw new RangeError(
            `Raster sample size must be between ` +
            `${MINIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM} and ` +
            `${MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM} kilometers.`
        );
    }
    return sideLengthKm;
}

/**
 * Return a destination reached along a spherical WGS 84 geodesic.
 *
 * @param {{longitude: number, latitude: number}} center Starting position.
 * @param {number} distanceKm Distance from the center in kilometers.
 * @param {number} bearingDegrees Clockwise bearing from north in degrees.
 * @return {{longitude: number, latitude: number}} Destination in WGS 84.
 */
function rasterSampleDestination(center, distanceKm, bearingDegrees) {
    const latitude = center.latitude * Math.PI / 180;
    const longitude = center.longitude * Math.PI / 180;
    const bearing = bearingDegrees * Math.PI / 180;
    const angularDistance = distanceKm / WGS84_MEAN_RADIUS_KM;
    const destinationLatitude = Math.asin(
        Math.sin(latitude) * Math.cos(angularDistance) +
        Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const longitudeOffset = Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
        Math.cos(angularDistance) -
            Math.sin(latitude) * Math.sin(destinationLatitude)
    );
    const unwrappedLongitude = longitude + longitudeOffset;
    const normalizedLongitude =
        ((unwrappedLongitude * 180 / Math.PI + 540) % 360) - 180;
    return {
        latitude: destinationLatitude * 180 / Math.PI,
        longitude: normalizedLongitude
    };
}

/**
 * Build an axis-aligned WGS 84 square whose ground dimensions approximate the
 * requested side length. A date-line or polar crossing is deliberately not
 * represented by the selected-bounds API contract.
 *
 * @param {{longitude: number, latitude: number}} center Window center.
 * @param {number} sideLengthKm Approximate ground side length in kilometers.
 * @return {RasterSelectedBounds} Canonical WGS 84 selected bounds.
 * @throws {RangeError} If the center or size violates the selection contract.
 * @throws {RasterSampleWindowBoundaryError} If the window crosses a pole or
 * date line.
 */
export function buildRasterSampleWindowBounds(center, sideLengthKm) {
    if (!isCanonicalWgs84Position(center)) {
        throw new RangeError("Raster sample center must be a WGS 84 position.");
    }
    validateRasterSampleWindowSize(sideLengthKm);

    const halfDiagonalKm = sideLengthKm / Math.sqrt(2);
    const halfDiagonalRadians = halfDiagonalKm / WGS84_MEAN_RADIUS_KM;
    if (
        Math.abs(center.latitude * Math.PI / 180) +
            halfDiagonalRadians >= Math.PI / 2
    ) {
        throw new RasterSampleWindowBoundaryError(
            RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE
        );
    }
    const corners = [315, 45, 135, 225].map((bearing) =>
        rasterSampleDestination(center, halfDiagonalKm, bearing)
    );
    const longitudes = corners.map((corner) => corner.longitude);
    const latitudes = corners.map((corner) => corner.latitude);
    if (Math.max(...longitudes) - Math.min(...longitudes) >= 180) {
        throw new RasterSampleWindowBoundaryError(
            RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE
        );
    }
    return validateRasterSelectedBounds({
        west: Math.min(...longitudes),
        south: Math.min(...latitudes),
        east: Math.max(...longitudes),
        north: Math.max(...latitudes)
    });
}
