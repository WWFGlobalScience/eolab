/** Processing calculation areas include owned polygon uploads in addition to map selections. */
import { normalizeRasterSamplingArea } from "../selected-area.js";

/** Validate the small reference returned after uploading exact polygons.
 * @param {Object} reference Processing input ID and geometry SHA-256.
 * @return {Readonly<{id:string,sha256:string}>} Independent immutable reference.
 * @throws {TypeError} If the reference contains unexpected or malformed fields.
 */
export function validatePolygonAreaReference(reference) {
    if (!reference || Object.keys(reference).sort().join() !== "id,sha256" ||
        !/^[a-f0-9]{32}$/.test(reference.id) || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
        throw new TypeError("Invalid polygon calculation area.");
    }
    return Object.freeze({ id: reference.id, sha256: reference.sha256 });
}

/** Copy a calculation area without allowing geometry into browser recovery records.
 * @param {Object} area Rectangle, geodesic sampling box, vector selection, polygon reference or whole raster.
 * @return {Readonly<Object>} Validated area.
 * @throws {TypeError|Error} If the area does not match a supported contract.
 */
export function normalizeCalculationArea(area) {
    if (area?.kind === "polygonArea") {
        if (Object.keys(area).sort().join() !== "kind,polygonArea") throw new TypeError("Invalid polygon calculation area.");
        return Object.freeze({ kind: "polygonArea", polygonArea: validatePolygonAreaReference(area.polygonArea) });
    }
    return normalizeRasterSamplingArea(area);
}
