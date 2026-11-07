/** Processing calculation areas include owned polygon uploads in addition to map selections. */
import { normalizeRasterSamplingArea } from "../selected-area.js";

/** Copy a calculation area without allowing geometry into browser recovery records.
 * @param {Object} area Rectangle, geodesic sampling box, vector selection, polygon reference or whole raster.
 * @return {Readonly<Object>} Validated area.
 * @throws {TypeError|Error} If the area does not match a supported contract.
 */
export function normalizeCalculationArea(area) {
    if (area?.kind === "polygonArea" && Object.keys(area).sort().join() !== "kind,polygonArea") {
        throw new TypeError("Invalid polygon calculation area.");
    }
    return normalizeRasterSamplingArea(area);
}
