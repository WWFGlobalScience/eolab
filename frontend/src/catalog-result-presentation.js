/**
 * Compact presentation rules for Catalog search results.
 *
 * Search results preserve descriptive titles and abbreviate dataset paths to
 * their filenames and distinguishing context. Complete STAC metadata remains
 * in the item inspector.
 */

/** Scanner-supported file and container endings that identify path titles. */
const CATALOG_FILE_PATH = /\.(?:tiff?|gpkg|gdb|shp|geojson|zip)[\\/]*$/i;

/**
 * Normalize one optional Catalog label to a non-empty string.
 *
 * @param {unknown} value Candidate label from Item metadata or a type lookup.
 * @return {string|null} Trimmed text, or null for blank or non-string values.
 */
function optionalLabel(value) {
    return typeof value === "string" && value.trim() !== ""
        ? value.trim()
        : null;
}

/**
 * Return the basename of a Catalog path using either path separator.
 *
 * @param {string} path Recognized source path; may end in separators.
 * @return {string} Final path segment after normalizing separators and removing
 * trailing separators; an empty string when no segment remains.
 */
function basename(path) {
    const normalizedPath = path.replaceAll("\\", "/").replace(/\/+$/, "");
    return normalizedPath.split("/").at(-1) ?? normalizedPath;
}

/**
 * Convert a path slug into compact readable context.
 *
 * @param {string} segment One directory name or hazard slug from a source path.
 * @return {string} Trimmed text with runs of hyphens and underscores replaced
 * by single spaces; an empty string when the segment contains only separators
 * or whitespace.
 */
function formatReadablePathSegment(segment) {
    return segment.replaceAll(/[-_]+/g, " ").trim();
}

/**
 * Preserve a descriptive Item title or recognize its dataset path and layer.
 *
 * Only scanner-supported filename endings identify paths. Slashes in units
 * such as L/day and punctuation in curated titles remain ordinary label text.
 * The legacy em-dash layer suffix applies only to vector-container paths.
 *
 * @param {Object} item STAC Item with optional id, properties.title,
 * properties["eolab:layer_name"], and asset titles used to recover its identity.
 * @return {{sourcePath:string|null,fullTitle:string,layerName:string|null}}
 * Identity with a recognized sourcePath for filename extraction, or null for
 * descriptive text; fullTitle preserves the Item title (falling back to its id
 * or "Untitled dataset"). The layerName comes from explicit metadata or a
 * vector-container title suffix, or is null when neither supplies one.
 */
function getCatalogSourceIdentity(item) {
    const itemTitle = optionalLabel(item.properties?.title);
    const itemIdentifier = optionalLabel(item.id) ?? "Untitled dataset";
    const fullTitle = itemTitle ?? itemIdentifier;
    const titleParts = fullTitle.split(" — ");
    const titlePath = titleParts.slice(0, -1).join(" — ");
    const hasContainerLayer = titleParts.length > 1
        && /\.(?:gdb|gpkg)$/i.test(titlePath);
    const layerName = optionalLabel(item.properties?.["eolab:layer_name"])
        ?? optionalLabel(hasContainerLayer ? titleParts.at(-1) : null);

    let sourcePath = hasContainerLayer ? titlePath : fullTitle;
    if (layerName !== null) {
        const assetTitle = Object.values(item.assets ?? {})
            .map((asset) => optionalLabel(asset?.title))
            .find((title) => title !== null);
        if (assetTitle !== undefined) {
            sourcePath = assetTitle;
        } else {
            const pathSegments = sourcePath.replaceAll("\\", "/").split("/");
            if (
                pathSegments.length > 1
                && pathSegments.at(-1) === layerName
                && /\.(?:gdb|gpkg)$/i.test(pathSegments.at(-2))
            ) {
                sourcePath = pathSegments.slice(0, -1).join("/");
            }
        }
    }
    return {
        sourcePath: CATALOG_FILE_PATH.test(sourcePath) ? sourcePath : null,
        fullTitle,
        layerName,
    };
}

/**
 * Derive concise directory context for one source path.
 *
 * @param {string} sourcePath Source path using forward or backward separators.
 * @return {string|null} Readable hazard and historic/future context from the
 * nearest matching ancestor, otherwise the readable immediate parent folder,
 * or null when the path has no parent segment.
 */
function getCatalogPathContext(sourcePath) {
    const pathSegments = sourcePath
        .replaceAll("\\", "/")
        .split("/")
        .filter((segment) => segment !== "");
    if (pathSegments.length < 2) {
        return null;
    }
    const parentSegments = pathSegments.slice(0, -1);
    for (const segment of parentSegments.toReversed()) {
        const hazardPeriod = segment.match(/^(.+?)-(historic|future)(?:-|$)/i);
        if (hazardPeriod !== null) {
            return `${formatReadablePathSegment(hazardPeriod[1])} · ${hazardPeriod[2].toLowerCase()}`;
        }
    }
    return formatReadablePathSegment(parentSegments.at(-1));
}

/**
 * Build the compact and accessible identity for one Catalog result.
 *
 * @param {Object} item STAC Item whose optional title, id, vector layer name,
 * and asset titles supply its readable name or source-file context.
 * @param {string|undefined} datasetType Display label from the mounted dataset
 * type lookup, such as "Raster" or "Vector"; undefined for an unknown type.
 * @return {{filename:string,context:string|null,datasetType:string|null,
 * fullTitle:string,accessibleLabel:string}} Presentation whose filename is the
 * full descriptive title or a recognized path's basename, with optional layer
 * or directory context, a normalized type label, the full Item title (or its
 * fallback), and an accessible details-action label retaining that identity.
 */
export function buildCatalogResultPresentation(item, datasetType) {
    const { sourcePath, fullTitle, layerName } = getCatalogSourceIdentity(item);
    const filename = sourcePath === null ? fullTitle : basename(sourcePath);
    const pathContext = sourcePath === null ? null : getCatalogPathContext(sourcePath);
    const context = layerName === null
        ? pathContext
        : `Layer: ${layerName}`;
    const normalizedDatasetType = optionalLabel(datasetType);
    const accessibleParts = [filename, context, normalizedDatasetType]
        .filter((part) => part !== null);
    if (fullTitle !== filename) {
        accessibleParts.push(`Source: ${fullTitle}`);
    }
    return {
        filename,
        context,
        datasetType: normalizedDatasetType,
        fullTitle,
        accessibleLabel: `More details for ${accessibleParts.join(", ")}`
    };
}

/**
 * Format the concise count shown immediately above Catalog results.
 *
 * @param {Object} itemCollection Validated STAC ItemCollection response.
 * @param {number} itemCollection.numberMatched Matched-Item count to display.
 * @param {boolean} [itemCollection.numberMatchedEstimated=false] Whether the
 * count is an estimate rather than an exact match count.
 * @return {string} Locale-formatted count followed by "result" or "results",
 * with " (est.)" after the number when the count is estimated.
 */
export function formatCatalogResultCount(itemCollection) {
    const resultCount = itemCollection.numberMatched;
    const noun = resultCount === 1 ? "result" : "results";
    const estimate = itemCollection.numberMatchedEstimated ? " (est.)" : "";
    return `${resultCount.toLocaleString()}${estimate} ${noun}`;
}
