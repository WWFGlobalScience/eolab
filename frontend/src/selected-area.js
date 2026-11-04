/** Validate and copy geographic areas used by raster sampling and downloads. */
import { normalizeSamplingBox, samplingBoxBounds } from "./sampling-box.js";
/**
 * Build the stable validation error used for malformed selected bounds.
 *
 * @return {Error} User-safe selected-bounds contract error.
 */
function rasterSelectedBoundsContractError() {
    return new Error("Raster statistics returned invalid selected bounds.");
}

/**
 * Validate one server-compatible WGS 84 statistics rectangle.
 *
 * @param {RasterSelectedBounds} bounds Candidate coordinate rectangle.
 * @return {RasterSelectedBounds} The validated non-wrapping WGS 84 bounds.
 * @throws {Error} If fields, ranges, or coordinate ordering are invalid.
 */
export function validateRasterSelectedBounds(bounds) {
    if (bounds === null || typeof bounds !== "object") {
        throw rasterSelectedBoundsContractError();
    }
    const fieldNames = ["west", "south", "east", "north"];
    if (
        Object.keys(bounds).length !== fieldNames.length ||
        !fieldNames.every((fieldName) => Object.hasOwn(bounds, fieldName))
    ) {
        throw rasterSelectedBoundsContractError();
    }
    const { west, south, east, north } = bounds;
    if (
        ![west, south, east, north].every(Number.isFinite) ||
        west < -180 || east > 180 || south < -90 || north > 90 ||
        !(west < east && south < north)
    ) {
        throw rasterSelectedBoundsContractError();
    }
    return bounds;
}

/** Sampling selection that includes the entire raster. */
export const WHOLE_RASTER_SAMPLING_AREA = Object.freeze({
    kind: "wholeRaster"
});

/**
 * Validate and freeze a whole-raster, rectangular, geodesic-box or filtered-vector area.
 *
 * @param {Object} [samplingArea=WHOLE_RASTER_SAMPLING_AREA] Candidate whole,
 * selected-bounds, center/size sampling-box or catalog-selection area.
 * @return {Readonly<Object>} Validated immutable sampling area.
 * @throws {TypeError|RangeError} If the shape is invalid or a sampling box
 * crosses its supported pole/date-line boundary.
 */
export function normalizeRasterSamplingArea(
    samplingArea = WHOLE_RASTER_SAMPLING_AREA
) {
    if (samplingArea === null || typeof samplingArea !== "object") {
        throw new TypeError("Raster statistics sampling area is invalid.");
    }
    const keys = Object.keys(samplingArea).sort();
    if (
        samplingArea.kind === "wholeRaster" &&
        keys.length === 1 && keys[0] === "kind"
    ) {
        return WHOLE_RASTER_SAMPLING_AREA;
    }
    if (
        samplingArea.kind === "selectedArea" &&
        keys.length === 2 &&
        keys[0] === "kind" &&
        keys[1] === "selectedBounds"
    ) {
        return Object.freeze({
            kind: "selectedArea",
            selectedBounds: Object.freeze({
                ...validateRasterSelectedBounds(samplingArea.selectedBounds)
            })
        });
    }
    if (samplingArea.kind === "samplingBox" && keys.join() === "kind,samplingBox") {
        return Object.freeze({
            kind: "samplingBox",
            samplingBox: normalizeSamplingBox(samplingArea.samplingBox)
        });
    }
    if (samplingArea.kind === "catalogSelection" && keys.length === 2 &&
        keys[0] === "catalogSelection" && keys[1] === "kind") {
        return Object.freeze({ kind: "catalogSelection", catalogSelection: validateVectorSelection(samplingArea.catalogSelection) });
    }
    throw new TypeError("Raster statistics sampling area is invalid.");
}

/** Validate and copy the source identity and filter for selected vector features.
 * @param {Object} value Public catalog or upload identity and typed predicate.
 * @return {Readonly<Object>} Deeply immutable source identity, layer and filter.
 * @throws {TypeError} For paths, geometry, malformed identity or filter fields.
 */
export function validateVectorSelection(value) {
    const uploaded = value?.uploadId !== undefined;
    const keys = uploaded ? ["filter", "layerName", "uploadId"] : ["assetKey", "collectionId", "filter", "itemId", "layerName"];
    if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== keys.join() ||
        typeof value.layerName !== "string" || !value.layerName) throw new TypeError("Invalid vector selection identity");
    if (uploaded ? typeof value.uploadId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.uploadId) :
        value.collectionId !== "eolab-mounted-vectors" ||
        typeof value.itemId !== "string" || value.itemId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value.itemId) ||
        typeof value.assetKey !== "string" || !value.assetKey || value.assetKey.length > 256 || value.layerName.length > 256)
        throw new TypeError("Invalid vector selection identity");
    const input = value.filter;
    if (!input || Object.keys(input).sort().join() !== "enabled,match,rules" ||
        typeof input.enabled !== "boolean" || !["all", "any"].includes(input.match) ||
        !Array.isArray(input.rules) || input.rules.length > 12) throw new TypeError("Invalid vector selection filter");
    const rules = input.rules.map(rule => {
        if (!rule || Object.keys(rule).sort().join() !== "field,operator,value" ||
            typeof rule.field !== "string" || !rule.field || rule.field.length > 256 || /[\u0000-\u001f]/.test(rule.field) ||
            !["eq", "ne", "gt", "ge", "lt", "le", "contains", "missing", "present"].includes(rule.operator) ||
            !(rule.value === null || typeof rule.value === "boolean" ||
              typeof rule.value === "number" && Number.isFinite(rule.value) && Math.abs(rule.value) <= Number.MAX_SAFE_INTEGER ||
              typeof rule.value === "string" && rule.value.length <= 256 && !/[\u0000-\u001f]/.test(rule.value))) throw new TypeError("Invalid vector selection rule");
        return Object.freeze({ field: rule.field, operator: rule.operator, value: rule.value });
    });
    const filter = Object.freeze({ enabled: input.enabled, match: input.match, rules: Object.freeze(rules) });
    return Object.freeze(uploaded ? { uploadId: value.uploadId, layerName: value.layerName, filter } : { collectionId: value.collectionId, itemId: value.itemId,
        assetKey: value.assetKey, layerName: value.layerName, filter });
}

/** Compare the source, layer and filter of catalog or uploaded vector selections.
 * @param {Object|null|undefined} left First selection descriptor.
 * @param {Object|null|undefined} right Second selection descriptor.
 * @return {boolean} Whether both descriptors identify the same exact selection.
 * @throws {TypeError} When a present descriptor violates its public contract.
 */
export function vectorSelectionsEqual(left, right) {
    if (left == null || right == null) return false;
    return JSON.stringify(validateVectorSelection(left)) === JSON.stringify(validateVectorSelection(right));
}

/** Return the geographic envelope used only to screen raster source candidates.
 * @param {Object|null} area Validated rectangle, sampling box or another area kind.
 * @return {Object|null} Read-window envelope, or null for a nonrectangular source selection.
 */
export function rasterSamplingAreaBounds(area) {
    return area?.kind === "samplingBox" ? samplingBoxBounds(area.samplingBox)
        : area?.kind === "selectedArea" ? area.selectedBounds : null;
}
