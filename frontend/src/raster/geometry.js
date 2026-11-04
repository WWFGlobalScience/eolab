import { normalizeRasterSamplingArea } from "../selected-area.js";
import { MAXIMUM_SAMPLING_BOX_SIDE_KM } from "../sampling-box.js";
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

/**
 * Largest integer side whose half-diagonal stays below a quarter circumference.
 * This is the existing non-polar geometry limit at the equator, not a sampling
 * performance limit. A box nearer a pole or date line may need to be smaller.
 */
export const MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM =
    MAXIMUM_SAMPLING_BOX_SIDE_KM;

/** Guidance shown when a sample window cannot use the non-wrapping contract. */
export const RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE =
    "This box reaches a pole or date line. Use a smaller box, move it, " +
    "or choose Whole raster / Whole overlap for global sampling. " +
    "The previous selection is unchanged.";

/** Guidance shown when the pointer is outside the canonical map world. */
export const RASTER_SAMPLE_WINDOW_MAP_BOUNDS_GUIDANCE =
    "Move the sample window inside the map bounds.";

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

/** Capture a map-centered geodesic box independently of its display tessellation.
 * @param {{longitude:number,latitude:number}} center Canonical map position.
 * @param {number} sideLengthKm Approximate integer ground side length.
 * @return {Readonly<Object>} Immutable samplingBox area descriptor.
 * @throws {TypeError|RangeError} If the center, size or boundary crosses the current contract.
 */
export function buildRasterSampleWindowArea(center, sideLengthKm) {
    return normalizeRasterSamplingArea({
        kind: "samplingBox",
        samplingBox: {center, sideLengthKm}
    });
}
