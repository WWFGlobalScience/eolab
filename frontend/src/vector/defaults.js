/** Pure initial vector appearance derived from Catalog fields and explicit results. */

import {
    normalizeVectorNumericClassification,
    normalizeVectorStyle,
    sequentialPaletteColors,
    vectorCategoricalFieldKind,
    vectorNumericFields,
} from "./style.js";

/** Readable initial label presentation, shared with the vector Style form. */
export const VECTOR_LABEL_DEFAULTS = Object.freeze({
    fontFamily: "SansSerif",
    fontSize: 12,
    fontWeight: "normal",
    fontColor: "#111827",
    haloColor: "#ffffff",
    haloWidth: 1.5,
    minimumZoom: 0,
});

/** Initial bounded classification and low-to-high palette selection. */
export const VECTOR_NUMERIC_DEFAULTS = Object.freeze({
    method: "percentile-interval",
    classCount: 5,
    palette: "blue-yellow-red",
});

/**
 * Choose a recognizable text name without treating arbitrary codes as labels.
 *
 * @param {ReadonlyArray<{name:string,type:string}>} fields Catalog fields.
 * @return {string|null} Exact field identity, or null if none is unambiguous.
 */
export function defaultVectorLabelField(fields) {
    const textFields = fields.filter(({ type }) =>
        vectorCategoricalFieldKind(type) === "string"
    );
    for (const preferred of ["name", "display_name", "common_name", "label", "title", "nm"]) {
        const matches = textFields.filter(({ name }) => name.toLowerCase() === preferred);
        if (matches.length === 1) return matches[0].name;
        if (matches.length > 1) return null;
    }
    const named = textFields.filter(({ name }) => /(?:^(?:name|nm)[_ ]|[_ ](?:name|nm)$)/i.test(name));
    return named.length === 1 ? named[0].name : null;
}

/**
 * Select a numeric measurement, preferring the latest year over schema order.
 *
 * @param {ReadonlyArray<{name:string,type:string}>} fields Catalog fields.
 * @return {string|null} Latest annual measurement, otherwise the first non-ID
 * numeric Catalog field, or null when none exists. Source field order breaks ties.
 */
export function defaultVectorNumericField(fields) {
    const measurements = vectorNumericFields(fields).filter(({ name }) => {
        const words = name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
        return !/(?:^|[_\s-])(?:id|fid|oid|objectid|ogc_fid|gid|uuid|guid|code|index)(?:$|[_\s-])/.test(words)
            && !/^(?:objectid|fid|oid|gid)\d*$/.test(words);
    });
    let selected = measurements[0] ?? null;
    let selectedYear = -1;
    for (const field of measurements) {
        const years = [...field.name.matchAll(/(?:^|\D)((?:19|20)\d{2})(?=\D|$)/g)];
        const latestYear = Math.max(-1, ...years.map(match => Number(match[1])));
        if (latestYear > selectedYear) {
            selected = field;
            selectedYear = latestYear;
        }
    }
    return selected?.name ?? null;
}

/**
 * Return label placement that preserves the visibility of the underlying symbol.
 *
 * @param {string} geometryKind Validated point, line, or polygon geometry.
 * @return {string} Supported geometry-appropriate label placement.
 */
export function defaultVectorLabelPlacement(geometryKind) {
    return geometryKind === "point" ? "above" : "center";
}

/**
 * Derive a new layer's colors with labels disabled until the user enables them.
 *
 * @param {Object} initial Validated publication's default symbol style.
 * @param {ReadonlyArray<{name:string,type:string}>} fields Catalog fields.
 * @param {Object|null} [classification=null] Explicit bounded classification result.
 * @return {Object} Complete normalized initial style with labels off and optional numeric ranges.
 * @throws {TypeError} If a classification does not match the default request.
 */
export function deriveDefaultVectorStyle(initial, fields, classification = null) {
    const style = normalizeVectorStyle(initial);
    let graduated = null;
    if (classification !== null) {
        const summary = normalizeVectorNumericClassification(classification);
        if (summary.field !== defaultVectorNumericField(fields)
            || summary.method !== VECTOR_NUMERIC_DEFAULTS.method
            || summary.requestedClassCount !== VECTOR_NUMERIC_DEFAULTS.classCount) {
            throw new TypeError("Default numeric classification does not match the request.");
        }
        const colors = sequentialPaletteColors(
            VECTOR_NUMERIC_DEFAULTS.palette, summary.actualClassCount,
        );
        graduated = {
            ...VECTOR_NUMERIC_DEFAULTS,
            field: summary.field,
            rules: summary.classes.map((range, index) => ({
                minimum: range.minimum,
                maximum: range.maximum,
                color: colors[index],
            })),
            missingColor: summary.nullCount > 0 ? "#d1d5db" : null,
        };
    }
    return normalizeVectorStyle({ ...style, label: null, graduated });
}
