const CATALOG_PAGE_SIZE = 20;
const CATALOG_SUBSTRING_PROPERTIES = [
    "title",
    "description",
    "eolab_datetime_text",
    "eolab_end_datetime_text"
];
const CATALOG_COLLECTION_PROPERTY = "collection";
const CATALOG_FILTER_FIELD_PATTERN = /^[a-z][a-z0-9_-]*$/i;
const CATALOG_DATE_PERIOD_PATTERN =
    /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const CATALOG_DATE_SYNTAX_ERROR =
    "Use date:YYYY, date:YYYY-MM, date:YYYY-MM-DD, or a range " +
    "between two of these values.";
export const MOUNTED_GEOTIFF_COLLECTION_ID = "eolab-mounted-geotiffs";
export const MOUNTED_VECTOR_COLLECTION_ID = "eolab-mounted-vectors";
/** @type {string} Catalog collection for admitted raster time series. */
export const TEMPORAL_COLLECTION_ID = "eolab-temporal-datasets";

/**
 * User-facing Catalog field filters accepted by `buildCatalogSearch`.
 *
 * Keeping insertion text and presentation metadata beside the parser's field
 * and value contract prevents the search assistant from documenting syntax
 * that the Catalog cannot execute.
 *
 * @type {ReadonlyArray<Readonly<{
 *   field:string,
 *   token:string,
 *   value:string|null,
 *   label:string,
 *   description:string,
 *   keywords:ReadonlyArray<string>,
 *   searchImmediately:boolean,
 *   collectionId?:string
 * }>>}
 */
export const CATALOG_SEARCH_FILTERS = Object.freeze([
    Object.freeze({
        field: "type",
        token: "type:raster",
        value: "raster",
        label: "Raster items",
        description: "Only mounted raster Items.",
        keywords: Object.freeze(["type", "datatype", "raster", "image"]),
        searchImmediately: true,
        collectionId: MOUNTED_GEOTIFF_COLLECTION_ID
    }),
    Object.freeze({
        field: "type",
        token: "type:vector",
        value: "vector",
        label: "Vector items",
        description: "Only mounted vector Items.",
        keywords: Object.freeze(["type", "datatype", "vector", "feature"]),
        searchImmediately: true,
        collectionId: MOUNTED_VECTOR_COLLECTION_ID
    }),
    Object.freeze({
        field: "type",
        token: "type:temporal",
        value: "temporal",
        label: "Raster time series",
        description: "Raster datasets with variables and observation times.",
        keywords: Object.freeze(["type", "datatype", "temporal", "time", "series"]),
        searchImmediately: true,
        collectionId: TEMPORAL_COLLECTION_ID
    }),
    Object.freeze({
        field: "date",
        token: "date:",
        value: null,
        label: "Observation date or range",
        description: "Use YYYY, YYYY-MM, YYYY-MM-DD, or FROM..TO.",
        keywords: Object.freeze(["date", "time", "year", "range"]),
        searchImmediately: false
    })
]);

const CATALOG_SEARCH_FILTERS_BY_FIELD = new Map(
    [...new Set(CATALOG_SEARCH_FILTERS.map((filter) => filter.field))]
        .map((field) => [
            field,
            CATALOG_SEARCH_FILTERS.filter((filter) => filter.field === field)
        ])
);
const VECTOR_RENDERING_POLICY = "vector-v1";
export const MOUNTED_DATASET_TYPES = new Map([
    [MOUNTED_GEOTIFF_COLLECTION_ID, "Raster"],
    [MOUNTED_VECTOR_COLLECTION_ID, "Vector"],
    [TEMPORAL_COLLECTION_ID, "Raster time series"]
]);

/**
 * Identify a mounted GeoTIFF or a raster dataset with observation times.
 *
 * @param {Object|null} item Selected STAC Item.
 * @return {{temporal?:boolean}|null} Raster metadata identifying time series, or null for a non-raster.
 */
export function getRasterVisualization(item) {
    if (item?.collection === TEMPORAL_COLLECTION_ID) return { temporal: true };
    if (item?.collection !== MOUNTED_GEOTIFF_COLLECTION_ID) {
        return null;
    }
    return {};
}

/**
 * Return the scanner-owned visualization decision for a catalog vector.
 *
 * @param {Object|null} item Selected STAC Item.
 * @return {Object|null|undefined} Rendering metadata, null for a non-vector
 * Item, or undefined when the vector has not been assessed.
 */
export function getVectorVisualization(item) {
    if (item?.collection !== MOUNTED_VECTOR_COLLECTION_ID) {
        return null;
    }
    const renderingMetadata = item.properties?.["eolab:vector_rendering"];
    return renderingMetadata?.policy === VECTOR_RENDERING_POLICY
        ? renderingMetadata
        : undefined;
}

/**
 * Classify one Item through the supported visualization contracts.
 *
 * @param {Object|null} item Selected STAC Item.
 * @return {{kind:"raster"|"vector",metadata:Object|undefined}|null}
 * Supported visualization descriptor or null.
 */
export function getCatalogVisualization(item) {
    const rasterMetadata = getRasterVisualization(item);
    if (rasterMetadata !== null) {
        return { kind: "raster", metadata: rasterMetadata };
    }
    const vectorMetadata = getVectorVisualization(item);
    return vectorMetadata === null
        ? null
        : { kind: "vector", metadata: vectorMetadata };
}

/**
 * Return a filename-safe label from scanner-owned Catalog display metadata.
 *
 * Asset and Item titles may include a mounted-relative directory prefix. This
 * formatter deliberately ignores the Asset URL so a browser diagnostic never
 * exposes or depends on a server filesystem path.
 *
 * @param {Object|null} item Selected STAC Item.
 * @return {string} Basename-like display label or a stable generic fallback.
 */
function getCatalogDisplayBasename(item) {
    const candidate = [
        item?.properties?.title,
        item?.assets?.data?.title,
        item?.id,
    ].find((value) => typeof value === "string" && value.trim() !== "") ??
        "selected item";
    const segments = candidate.trim().split(/[\\/]/).filter(Boolean);
    return segments.at(-1) ?? "selected item";
}

/**
 * Format backend-owned visualization feedback for Catalog presentation.
 *
 * The underlying reason remains unchanged diagnostic evidence. This adds only
 * filename-safe display context to the standard generic prefix;
 * already-contextualized or otherwise nonstandard reasons are preserved.
 *
 * @param {Object|null} item Selected STAC Item.
 * @param {string|null|undefined} rawReason Backend-owned visualization reason.
 * @return {string} Contextual unavailability reason, or an empty string when
 * no reason is supplied.
 */
export function formatCatalogVisualizationReason(item, rawReason) {
    if (typeof rawReason !== "string" || rawReason.trim() === "") {
        return "";
    }
    const reasonPrefix = "Visualization unavailable:";
    const trimmedReason = rawReason.trim();
    if (!trimmedReason.startsWith(reasonPrefix)) {
        return trimmedReason;
    }
    return `Visualization for ${getCatalogDisplayBasename(item)} unavailable: ` +
        trimmedReason.slice(reasonPrefix.length).trim();
}

/** Format a byte count without implying decimal storage units. */
function formatByteSize(byteCount) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = byteCount;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toLocaleString(undefined, {
        maximumFractionDigits: 1
    })} ${units[unitIndex]}`;
}

/**
 * Formats a duration at a useful precision for a live scan.
 *
 * @param {number} seconds Duration in seconds.
 * @return {string} Human-readable duration.
 */
function formatDuration(seconds) {
    if (seconds < 1) {
        return `${Math.round(seconds * 1000).toLocaleString()} ms`;
    }
    if (seconds < 60) {
        return `${seconds.toFixed(1)} s`;
    }

    const totalSeconds = Math.round(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;
    return hours === 0
        ? `${minutes}m ${remainingSeconds}s`
        : `${hours}h ${minutes}m ${remainingSeconds}s`;
}

/**
 * Formats a scanner timestamp for compact visible UTC display.
 *
 * @param {string|null} timestamp Scanner-provided UTC timestamp.
 * @return {string} Timestamp rendered to whole UTC seconds, or a fallback.
 */
function formatScanTimestamp(timestamp) {
    if (timestamp === null) {
        return "time unavailable";
    }
    const parsedTimestamp = new Date(timestamp);
    if (Number.isNaN(parsedTimestamp.getTime())) {
        return "time unavailable";
    }
    const isoTimestamp = parsedTimestamp.toISOString();
    return `${isoTimestamp.slice(0, 10)} ${isoTimestamp.slice(11, 19)} UTC`;
}

/**
 * Formats the compact mounted-directory scan recency or live progress.
 *
 * @param {Object} scanStatus Scan progress returned by the backend.
 * @return {string} Human-readable scan summary.
 */
export function formatScanStatusSummary(scanStatus) {
    switch (scanStatus.state) {
        case "not_started":
            return "No scan has run since startup";
        case "discovering":
            return "Scanning now · Discovering datasets";
        case "scanning":
            return (
                "Scanning now · " +
                `${scanStatus.sourceDatasetsProcessed.toLocaleString()} of ` +
                `${scanStatus.sourceDatasetsDiscovered.toLocaleString()} ` +
                "datasets processed"
            );
        case "completed": {
            const lastScanned =
                `Last scanned at ${formatScanTimestamp(scanStatus.finishedAt)}`;
            if (scanStatus.failed === 0) {
                return lastScanned;
            }
            const errorNoun = scanStatus.failed === 1 ? "error" : "errors";
            return (
                `${lastScanned} · ${scanStatus.failed.toLocaleString()} ` +
                `dataset ${errorNoun}`
            );
        }
        case "failed":
            return (
                "Last scan failed at " +
                formatScanTimestamp(scanStatus.finishedAt)
            );
        default:
            throw new Error(`Unknown scan state: ${scanStatus.state}`);
    }
}

/**
 * Formats distinct source-dataset and catalog-Item progress counts.
 *
 * @param {Object} scanStatus Scan progress returned by the backend.
 * @return {string} Human-readable source and output counts.
 */
export function formatScanProgressCounts(scanStatus) {
    const newlyWritten =
        scanStatus.catalogItemsWritten -
        scanStatus.catalogItemsAlreadyPresent;
    return (
        `${scanStatus.sourceDatasetsDiscovered.toLocaleString()} source ` +
        "datasets discovered · " +
        `${scanStatus.sourceDatasetsProcessed.toLocaleString()} source ` +
        "datasets processed · " +
        `${scanStatus.catalogItemsProduced.toLocaleString()} catalog Items ` +
        "produced · " +
        `${scanStatus.catalogItemsWritten.toLocaleString()} catalog Items ` +
        `written (${newlyWritten.toLocaleString()} new, ` +
        `${scanStatus.catalogItemsAlreadyPresent.toLocaleString()} existing) · ` +
        `${scanStatus.failed.toLocaleString()} failed`
    );
}

/**
 * Formats scanner-owned catalog reconciliation progress.
 *
 * @param {Object} reconciliation Reconciliation state from scan status.
 * @return {string} Human-readable cleanup status.
 */
export function formatScanReconciliation(reconciliation) {
    const counts =
        `${reconciliation.checked.toLocaleString()} checked · ` +
        `${reconciliation.missing.toLocaleString()} missing · ` +
        `${reconciliation.removed.toLocaleString()} removed`;
    switch (reconciliation.state) {
        case "not_started":
            return "Catalog cleanup: Not started";
        case "checking":
            return `Catalog cleanup: Checking · ${counts}`;
        case "deleting":
            return `Catalog cleanup: Removing missing Items · ${counts}`;
        case "completed":
            return `Catalog cleanup: Complete · ${counts}`;
        case "failed":
            return (
                `Catalog cleanup: Failed · ${counts} · ` +
                reconciliation.error
            );
        default:
            throw new Error(
                `Unknown reconciliation state: ${reconciliation.state}`
            );
    }
}

/**
 * Formats the performance clocks in a scan-status response.
 *
 * @param {Object} timing Scan timing values in seconds.
 * @param {number} workerCount Number of concurrent metadata processes.
 * @param {number} writerCount Number of concurrent catalog writers.
 * @param {number} batchSize Maximum Items in one catalog write.
 * @return {Object[]} Human-readable timing labels and values.
 */
export function formatScanTiming(timing, workerCount, writerCount, batchSize) {
    return [
        { label: "Elapsed wall time", seconds: timing.elapsedSeconds },
        {
            label: "Catalog inventory",
            seconds: timing.catalogInventorySeconds
        },
        { label: "Dataset discovery", seconds: timing.discoverySeconds },
        {
            label: "Waiting for metadata results",
            seconds: timing.metadataResultWaitSeconds
        },
        {
            label: `Metadata workers (${workerCount}, cumulative)`,
            seconds: timing.metadataWorkerSeconds
        },
        {
            label: "Metadata I/O wait (estimated, cumulative)",
            seconds: timing.metadataIoWaitSeconds
        },
        {
            label: "Metadata processing CPU (cumulative)",
            seconds: timing.metadataProcessingSeconds
        },
        {
            label:
                `Catalog writes (${writerCount} writers, ${batchSize} ` +
                "Items/batch, cumulative)",
            seconds: timing.catalogWriteSeconds
        },
        {
            label: "Catalog cleanup",
            seconds: timing.reconciliationSeconds
        },
        {
            label: "Search-count refresh",
            seconds: timing.cacheInvalidationSeconds
        }
    ].map(({ label, seconds }) => ({
        label,
        value: formatDuration(seconds)
    }));
}

/**
 * Formats the matched total from a STAC ItemCollection.
 *
 * @param {Object} itemCollection STAC ItemCollection response.
 * @param {boolean} isFiltered Whether the Item Search includes a filter.
 * @return {string} Human-readable matched Item count.
 */
export function formatCatalogItemCount(itemCollection, isFiltered) {
    const matchedItemCount = itemCollection.numberMatched;
    const qualifier = isFiltered ? "matching " : "";
    const itemNoun = matchedItemCount === 1 ? "Item" : "Items";
    const estimatedLabel = itemCollection.numberMatchedEstimated
        ? " (est.)"
        : "";
    return `${matchedItemCount.toLocaleString()}${estimatedLabel} ${qualifier}${itemNoun}`;
}

/**
 * Builds a standard CQL2 substring filter for Item text and datetime values.
 * The EOLab queryables expose standard STAC datetime fields as text because
 * pgSTAC's native datetime queryables are timestamps rather than strings.
 *
 * @param {string} searchText Text entered in the Catalog search field.
 * @return {Object|null} CQL2 JSON filter, or null for no filter.
 * @example
 * // "2004" becomes the CQL2 equivalent of:
 * // casei(title) LIKE casei("%2004%")
 * // OR casei(description) LIKE casei("%2004%"), and so on.
 * buildSubstringFilter("2004");
 */
export function buildSubstringFilter(searchText) {
    const normalizedSearchText = searchText.normalize("NFKC").trim();
    if (normalizedSearchText === "") {
        return null;
    }
    const literalPattern = normalizedSearchText
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");
    const pattern = { op: "casei", args: [`%${literalPattern}%`] };
    return {
        op: "or",
        args: CATALOG_SUBSTRING_PROPERTIES.map((propertyName) => ({
            op: "like",
            args: [{ op: "casei", args: [{ property: propertyName }] }, pattern]
        }))
    };
}

/** Error raised when user-entered Catalog filter syntax is not supported. */
export class CatalogSearchSyntaxError extends Error {
    constructor(message) {
        super(message);
        this.name = "CatalogSearchSyntaxError";
    }
}

/**
 * Expand one UTC calendar date or shortened period to inclusive dates.
 *
 * @param {string} dateText Candidate YYYY, YYYY-MM, or YYYY-MM-DD value.
 * @return {{startDate: string, endDate: string}} First and final dates in the
 * represented calendar period.
 * @throws {CatalogSearchSyntaxError} If the value is not a real UTC calendar
 * date or period.
 */
function parseCatalogDatePeriod(dateText) {
    const match = CATALOG_DATE_PERIOD_PATTERN.exec(dateText);
    if (match === null) {
        throw new CatalogSearchSyntaxError(CATALOG_DATE_SYNTAX_ERROR);
    }
    const year = Number(match[1]);
    const month = match[2] === undefined ? null : Number(match[2]);
    const day = match[3] === undefined ? null : Number(match[3]);
    const daysInMonth = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
            ? 29
            : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31
    ];
    if (
        year === 0 ||
        (month !== null && (month < 1 || month > 12)) ||
        (day !== null && (day < 1 || day > daysInMonth[month - 1]))
    ) {
        throw new CatalogSearchSyntaxError(
            `${dateText} is not a valid UTC calendar date.`
        );
    }
    if (month === null) {
        return {
            startDate: `${match[1]}-01-01`,
            endDate: `${match[1]}-12-31`
        };
    }
    if (day === null) {
        return {
            startDate: `${match[1]}-${match[2]}-01`,
            endDate:
                `${match[1]}-${match[2]}-` +
                String(daysInMonth[month - 1]).padStart(2, "0")
        };
    }
    return { startDate: dateText, endDate: dateText };
}

/**
 * Parse text and field syntax into one standard STAC Item Search request.
 *
 * A date field becomes an inclusive UTC Item Search datetime interval. The
 * provider applies temporal-intersection semantics to instant and interval
 * Items. Literal terms remain CQL2 substring filters.
 *
 * @param {string} searchText Text and field filters entered by the user.
 * @return {{filter: Object|null, datetime: string|null}} Parsed search fields.
 * @throws {CatalogSearchSyntaxError} If a field filter is unsupported.
 */
export function buildCatalogSearch(searchText) {
    const normalizedSearchText = searchText.normalize("NFKC").trim();
    if (normalizedSearchText === "") {
        return { filter: null, datetime: null };
    }

    const literalTokens = [];
    let datasetCollectionId = null;
    let datetime = null;
    for (const token of normalizedSearchText.split(/\s+/)) {
        if (token === "&") {
            throw new CatalogSearchSyntaxError(
                "Use spaces instead of &: search terms and filters are " +
                "combined automatically."
            );
        }
        const separatorIndex = token.indexOf(":");
        const fieldName = token.slice(0, separatorIndex);
        const fieldValue = token.slice(separatorIndex + 1);
        if (
            separatorIndex < 1 ||
            !CATALOG_FILTER_FIELD_PATTERN.test(fieldName) ||
            (fieldName.length === 1 && /^[\\/]/.test(fieldValue))
        ) {
            literalTokens.push(token);
            continue;
        }

        const normalizedFieldName = fieldName.toLowerCase();
        const normalizedFieldValue = fieldValue.toLowerCase();
        const supportedFilters = CATALOG_SEARCH_FILTERS_BY_FIELD.get(
            normalizedFieldName
        );
        if (
            normalizedFieldName === "date" &&
            supportedFilters !== undefined
        ) {
            if (datetime !== null) {
                throw new CatalogSearchSyntaxError(
                    "The date filter may appear only once."
                );
            }
            const dateParts = fieldValue.split("..");
            if (
                dateParts.length > 2 ||
                dateParts.some((datePart) => datePart === "")
            ) {
                throw new CatalogSearchSyntaxError(CATALOG_DATE_SYNTAX_ERROR);
            }
            const { startDate } = parseCatalogDatePeriod(dateParts[0]);
            const { endDate } = parseCatalogDatePeriod(dateParts.at(-1));
            if (startDate > endDate) {
                throw new CatalogSearchSyntaxError(
                    "The date range start must not be after its end."
                );
            }
            datetime =
                `${startDate}T00:00:00Z/` +
                `${endDate}T23:59:59.999999Z`;
            continue;
        }
        if (
            normalizedFieldName === "type" &&
            supportedFilters !== undefined
        ) {
            const typeFilter = supportedFilters.find(
                (filter) => normalizedFieldValue === filter.value
            );
            if (typeFilter === undefined) {
                throw new CatalogSearchSyntaxError(
                    "Use type:raster, type:vector, or type:temporal."
                );
            }
            if (datasetCollectionId !== null) {
                throw new CatalogSearchSyntaxError(
                    "The type filter may appear only once."
                );
            }
            datasetCollectionId = typeFilter.collectionId;
            continue;
        }
        throw new CatalogSearchSyntaxError(
            `Unsupported Catalog filter: ${fieldName}`
        );
    }

    const filters = literalTokens.map((token) => buildSubstringFilter(token));
    if (datasetCollectionId !== null) {
        filters.push({
            op: "=",
            args: [
                { property: CATALOG_COLLECTION_PROPERTY },
                datasetCollectionId
            ]
        });
    }
    const filter = filters.length === 0
        ? null
        : filters.length === 1
            ? filters[0]
            : { op: "and", args: filters };
    return { filter, datetime };
}

/**
 * Build the shared STAC fields used by result and random-discovery requests.
 *
 * @param {string} searchText Text and field filters entered by the user.
 * @param {number|null} limit Optional Item Search page size.
 * @return {Object} Standard STAC Item Search fields.
 */
export function buildCatalogSearchRequest(searchText, limit = null) {
    const searchRequest = {};
    if (limit !== null) {
        searchRequest.limit = limit;
    }
    const catalogSearch = buildCatalogSearch(searchText);
    if (catalogSearch.filter !== null) {
        searchRequest["filter-lang"] = "cql2-json";
        searchRequest.filter = catalogSearch.filter;
    }
    if (catalogSearch.datetime !== null) {
        searchRequest.datetime = catalogSearch.datetime;
    }
    return searchRequest;
}

/**
 * Creates a restartable delayed action for server-backed search. Native search
 * inputs emit each change immediately and do not provide this delay.
 *
 * @param {Function} action Action to invoke after the delay.
 * @param {number} delayMilliseconds Quiet period before invocation.
 * @param {{setTimeout: Function, clearTimeout: Function}} timer Timer provider.
 * @return {Function} Function that restarts the delay whenever it is called.
 */
export function createDebouncedAction(
    action,
    delayMilliseconds,
    timer = globalThis
) {
    let timeoutIdentifier = null;
    return (...actionArguments) => {
        if (timeoutIdentifier !== null) {
            timer.clearTimeout(timeoutIdentifier);
        }
        timeoutIdentifier = timer.setTimeout(() => {
            timeoutIdentifier = null;
            action(...actionArguments);
        }, delayMilliseconds);
    };
}

/**
 * Returns a pagination link from a STAC ItemCollection.
 *
 * @param {Object} itemCollection STAC ItemCollection response.
 * @param {string[]} relations Accepted link relation names.
 * @return {Object|null} Matching STAC link or null when unavailable.
 */
export function findPaginationLink(itemCollection, relations) {
    if (!Array.isArray(itemCollection.links)) {
        return null;
    }
    return (
        itemCollection.links.find((link) => relations.includes(link.rel)) ??
        null
    );
}

/**
 * Builds display details for a STAC Item, including its identity, datetime or
 * datetime range, geometry, bounding box, projection, raster dimensions,
 * assets, vector fields, and raster bands. Temporal datasets show their variables,
 * observation-label extent and month count instead of individual monthly assets.
 *
 * @param {Object} item STAC Item selected in the result list.
 * @param {Object[]} collections STAC Collections available to the Catalog.
 * @param {string} scanDisplayPathPrefix User-facing root for mounted files.
 * @return {{title:string,description:string|null,metadata:Object[],fields:Object[],assets:Object[]|null}}
 * Text-only inspector metadata; null assets means their summary is already in metadata.
 */
export function buildCatalogItemDetails(
    item,
    collections,
    scanDisplayPathPrefix
) {
    const properties = item.properties;
    const collection = collections.find(
        (candidateCollection) => candidateCollection.id === item.collection
    );
    const collectionLabel = collection?.title
        ? `${collection.title} (${item.collection})`
        : item.collection;
    const metadata = [
        { label: "Item ID", value: item.id },
        { label: "Collection", value: collectionLabel }
    ];
    const datasetType = MOUNTED_DATASET_TYPES.get(item.collection);
    if (datasetType !== undefined) {
        metadata.push({ label: "Dataset type", value: datasetType });
    }
    const isTemporal = item.collection === TEMPORAL_COLLECTION_ID;
    if (isTemporal) {
        metadata.push({
            label: "Observation times (UTC)",
            value: properties["cube:dimensions"].time.extent.join(" – ")
        }, {
            label: "Variables",
            value: Object.entries(properties["cube:variables"]).map(
                ([name, variable]) => `${variable.description} (${name}; ${variable.unit})`
            ).join("; ")
        }, {
            label: "Months with data",
            value: String(Object.values(item.assets).filter(
                (asset) => asset.roles.includes("data")
            ).length)
        });
    } else if (properties.datetime === null) {
        metadata.push({
            label: "Item datetime range",
            value: `${properties.start_datetime} – ${properties.end_datetime}`
        });
    } else {
        metadata.push({ label: "Item datetime", value: properties.datetime });
    }
    if (item.geometry !== null) {
        metadata.push({
            label: "Footprint geometry",
            value: item.geometry.type
        });
    }
    if (item.bbox !== undefined) {
        metadata.push({ label: "Bounding box", value: item.bbox.join(", ") });
    }
    if (properties["proj:epsg"] !== undefined) {
        metadata.push({
            label: "Coordinate reference system",
            value: `EPSG:${properties["proj:epsg"]}`
        });
    } else if (properties["proj:wkt2"] !== undefined) {
        metadata.push({
            label: "Coordinate reference system",
            value: properties["proj:wkt2"]
        });
    }
    if (properties["proj:shape"] !== undefined) {
        const [height, width] = properties["proj:shape"];
        metadata.push({
            label: "Raster dimensions",
            value: `${width} × ${height} pixels`
        });
    }
    const vectorDetails = buildVectorInspectorDetails(properties);
    metadata.push(...vectorDetails.metadata);
    const fields = vectorDetails.fields;

    const assets = isTemporal ? null : Object.entries(item.assets).map(([assetKey, asset]) => {
        const isMountedFile =
            datasetType !== undefined && asset.href.startsWith("file:");
        let location = asset.href;
        if (isMountedFile) {
            const separator = scanDisplayPathPrefix.includes("\\") ? "\\" : "/";
            const relativePath = (
                asset.title ??
                properties.title ??
                item.id
            ).replaceAll("/", separator);
            const joiner =
                scanDisplayPathPrefix.endsWith("/") ||
                scanDisplayPathPrefix.endsWith("\\")
                    ? ""
                    : separator;
            location = `${scanDisplayPathPrefix}${joiner}${relativePath}`;
        }
        const assetMetadata = [
            {
                label: isMountedFile ? "Original location" : "Location",
                value: location
            }
        ];
        if (asset.type !== undefined) {
            assetMetadata.push({ label: "Media type", value: asset.type });
        }
        if (asset.roles !== undefined) {
            assetMetadata.push({
                label: "Roles",
                value: asset.roles.join(", ")
            });
        }
        if (asset.updated !== undefined) {
            assetMetadata.push({
                label: "File modified",
                value: asset.updated
            });
        }
        if (asset["file:size"] !== undefined) {
            assetMetadata.push({
                label: "File size",
                value: formatByteSize(asset["file:size"])
            });
        }
        if (asset.type?.startsWith("image/tiff")) {
            assetMetadata.push({
                label: "Storage profile",
                value: asset.type.includes("profile=cloud-optimized")
                    ? "Cloud Optimized GeoTIFF"
                    : "GeoTIFF"
            });
        }

        const bands = (asset["raster:bands"] ?? []).map((band, bandIndex) => {
            const bandMetadata = [
                { label: "Data type", value: band.data_type }
            ];
            if (Object.hasOwn(band, "nodata")) {
                bandMetadata.push({
                    label: "Nodata",
                    value: String(band.nodata)
                });
            }
            return { title: `Band ${bandIndex + 1}`, metadata: bandMetadata };
        });

        return {
            key: assetKey,
            title: asset.title ?? assetKey,
            metadata: assetMetadata,
            bands
        };
    });

    return {
        title: properties.title ?? item.id,
        description: properties.description ?? null,
        metadata,
        fields,
        assets
    };
}

/**
 * Builds format-neutral vector details from STAC Table Extension properties.
 * Missing properties add no empty format-specific inspector rows.
 *
 * @param {Object} properties STAC Item properties.
 * @return {{metadata: Object[], fields: Object[]}} Vector summary rows and
 * attribute fields.
 */
function buildVectorInspectorDetails(properties) {
    const metadata = [];
    if (properties["eolab:layer_name"] !== undefined) {
        metadata.push({
            label: "Layer name",
            value: properties["eolab:layer_name"]
        });
    }
    if (properties["eolab:layer_alias"] !== undefined) {
        metadata.push({
            label: "Layer alias",
            value: properties["eolab:layer_alias"]
        });
    }
    if (properties["table:row_count"] !== undefined) {
        metadata.push({
            label: "Feature count",
            value: properties["table:row_count"].toLocaleString()
        });
    }
    const columns = properties["table:columns"] ?? [];
    const primaryGeometryName = properties["table:primary_geometry"];
    const primaryGeometryColumn = columns.find(
        (column) => column.name === primaryGeometryName
    );
    if (primaryGeometryColumn?.type !== undefined) {
        metadata.push({
            label: "Declared feature geometry type",
            value: primaryGeometryColumn.type
        });
    }
    const fields = columns
        .filter((column) => column.name !== primaryGeometryName)
        .map((column) => ({
            label: column.name,
            value: column.type ?? "Not provided"
        }));
    return { metadata, fields };
}

/**
 * Issues standard STAC Item Search requests while cancelling stale work.
 */
export class CatalogSearchClient {
    /**
     * @param {string} catalogUrl Browser-facing STAC root URL.
     * @param {Function} fetchImplementation Fetch-compatible request function.
     */
    constructor(catalogUrl, fetchImplementation = globalThis.fetch) {
        this.catalogUrl = catalogUrl.replace(/\/$/, "");
        this.fetchImplementation = fetchImplementation.bind(globalThis);
        this.activeAbortController = null;
        this.requestSequence = 0;
        this.numberMatchedEstimated = null;
    }

    /**
     * Starts the first page of a standard STAC text and datetime search.
     *
     * @param {string} searchText User-entered search text.
     * @return {Promise<Object|null>} ItemCollection, or null when superseded.
     */
    search(searchText) {
        this.numberMatchedEstimated = null;
        const searchBody = buildCatalogSearchRequest(
            searchText,
            CATALOG_PAGE_SIZE
        );
        return this.request({
            href: `${this.catalogUrl}/search`,
            method: "POST",
            body: searchBody
        });
    }

    /**
     * Follows a STAC pagination link without reconstructing provider tokens.
     *
     * @param {Object} paginationLink STAC next or previous link.
     * @return {Promise<Object|null>} ItemCollection, or null when superseded.
     */
    follow(paginationLink) {
        return this.request(paginationLink);
    }

    /**
     * Executes one GET or POST STAC link.
     *
     * @param {Object} stacLink STAC link containing href and optional request data.
     * @return {Promise<Object|null>} ItemCollection, or null when superseded.
     */
    async request(stacLink) {
        if (typeof stacLink?.href !== "string") {
            throw new TypeError("STAC pagination link has no href");
        }
        const method = (stacLink.method ?? "GET").toUpperCase();
        if (!new Set(["GET", "POST"]).has(method)) {
            throw new TypeError(
                `Unsupported STAC pagination method: ${method}`
            );
        }

        this.activeAbortController?.abort();
        const abortController = new AbortController();
        this.activeAbortController = abortController;
        const requestSequence = ++this.requestSequence;
        const requestHeaders = new Headers(stacLink.headers ?? {});
        requestHeaders.set("Accept", "application/geo+json");
        const requestOptions = {
            method,
            headers: requestHeaders,
            signal: abortController.signal
        };
        if (method === "POST") {
            requestHeaders.set("Content-Type", "application/json");
            requestOptions.body = JSON.stringify(stacLink.body ?? {});
        }

        let searchResponse;
        try {
            searchResponse = await this.fetchImplementation(
                stacLink.href,
                requestOptions
            );
        } catch (requestError) {
            if (abortController.signal.aborted) {
                return null;
            }
            throw requestError;
        }
        if (requestSequence !== this.requestSequence) {
            return null;
        }
        if (!searchResponse.ok) {
            throw new Error(
                `STAC Item Search returned ${searchResponse.status}`
            );
        }

        const itemCollection = await searchResponse.json();
        if (requestSequence !== this.requestSequence) {
            return null;
        }
        if (!Array.isArray(itemCollection.features)) {
            throw new Error("STAC Item Search response has no features array");
        }
        if (
            !Number.isInteger(itemCollection.numberMatched) ||
            itemCollection.numberMatched < itemCollection.features.length
        ) {
            throw new Error(
                "STAC Item Search response has no valid numberMatched"
            );
        }
        const estimateHeader = searchResponse.headers.get(
            "X-EOLab-Number-Matched-Estimated"
        );
        if (estimateHeader !== null) {
            if (estimateHeader !== "true" && estimateHeader !== "false") {
                throw new Error(
                    "Catalog response has an invalid count estimate header"
                );
            }
            this.numberMatchedEstimated = estimateHeader === "true";
        }
        if (this.numberMatchedEstimated === null) {
            throw new Error("Catalog response has no count estimate header");
        }
        itemCollection.numberMatchedEstimated = this.numberMatchedEstimated;
        return itemCollection;
    }
}

/**
 * Selects a random Item through the application Catalog discovery endpoint.
 */
export class CatalogSurpriseClient {
    /**
     * @param {string} endpoint Random Catalog discovery endpoint.
     * @param {Function} fetchImplementation Fetch-compatible request function.
     */
    constructor(
        endpoint = "/api/catalog/surprise",
        fetchImplementation = globalThis.fetch
    ) {
        this.endpoint = endpoint;
        this.fetchImplementation = fetchImplementation.bind(globalThis);
        this.activeAbortController = null;
        this.requestSequence = 0;
    }

    /**
     * Return one Item matching the current search and avoid the prior Item.
     *
     * @param {string} searchText Current Catalog search text.
     * @param {Object|null} excludedItem Most recently selected STAC Item.
     * @return {Promise<Object|null>} Item, or null when superseded.
     */
    async surprise(searchText, excludedItem = null) {
        const requestBody = {
            search: buildCatalogSearchRequest(searchText)
        };
        if (excludedItem !== null) {
            requestBody.exclude = {
                collection: excludedItem.collection,
                id: excludedItem.id
            };
        }

        this.activeAbortController?.abort();
        const abortController = new AbortController();
        this.activeAbortController = abortController;
        const requestSequence = ++this.requestSequence;
        let response;
        try {
            response = await this.fetchImplementation(this.endpoint, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(requestBody),
                signal: abortController.signal
            });
        } catch (requestError) {
            if (abortController.signal.aborted) {
                return null;
            }
            throw requestError;
        }
        if (requestSequence !== this.requestSequence) {
            return null;
        }
        if (!response.ok) {
            let errorDetail = `Random Catalog discovery returned ${response.status}`;
            try {
                const errorBody = await response.json();
                if (typeof errorBody.detail === "string") {
                    errorDetail = errorBody.detail;
                }
            } catch {
                // Preserve the status-based fallback for a non-JSON response.
            }
            throw new Error(errorDetail);
        }
        const responseBody = await response.json();
        if (requestSequence !== this.requestSequence) {
            return null;
        }
        const item = responseBody.item;
        if (
            item?.type !== "Feature" ||
            typeof item.id !== "string" ||
            typeof item.collection !== "string"
        ) {
            throw new Error("Random Catalog discovery returned no valid Item");
        }
        return item;
    }
}

/**
 * Tracks one progressively loaded Catalog search and its provider-supplied
 * next-page link.
 */
export class CatalogResultStream {
    /** @param {CatalogSearchClient} searchClient STAC Item Search client. */
    constructor(searchClient) {
        this.searchClient = searchClient;
        this.bufferedPage = null;
        this.prefetchPromise = null;
        this.nextLink = null;
        this.isLoading = false;
        this.searchSequence = 0;
    }

    /** @return {boolean} Whether another provider page is available. */
    get hasNextPage() {
        return (
            this.bufferedPage !== null ||
            this.prefetchPromise !== null ||
            this.nextLink !== null
        );
    }

    /**
     * Replaces the active result stream with a new search.
     *
     * @param {string} searchText User-entered search text.
     * @return {Promise<Object|null>} First ItemCollection, or null if superseded.
     */
    async restart(searchText) {
        const searchSequence = ++this.searchSequence;
        this.bufferedPage = null;
        this.prefetchPromise = null;
        this.nextLink = null;
        this.isLoading = true;
        try {
            const itemCollection = await this.searchClient.search(searchText);
            if (
                searchSequence !== this.searchSequence ||
                itemCollection === null
            ) {
                return null;
            }
            this.nextLink = findPaginationLink(itemCollection, ["next"]);
            return itemCollection;
        } finally {
            if (searchSequence === this.searchSequence) {
                this.isLoading = false;
            }
        }
    }

    /**
     * Fetches and retains the next page without adding it to the displayed list.
     * Concurrent callers share the same provider request.
     *
     * @return {Promise<Object|null>} Buffered ItemCollection, or null when the
     *     stream has ended or the request was superseded.
     */
    async prefetchNextPage() {
        if (this.bufferedPage !== null) {
            return this.bufferedPage;
        }
        if (this.prefetchPromise !== null) {
            return this.prefetchPromise;
        }
        if (this.nextLink === null) {
            return null;
        }

        const searchSequence = this.searchSequence;
        const nextLink = this.nextLink;
        const prefetchPromise = (async () => {
            const itemCollection = await this.searchClient.follow(nextLink);
            if (
                searchSequence !== this.searchSequence ||
                itemCollection === null
            ) {
                return null;
            }
            this.nextLink = findPaginationLink(itemCollection, ["next"]);
            this.bufferedPage = itemCollection;
            return itemCollection;
        })();
        this.prefetchPromise = prefetchPromise;
        try {
            return await prefetchPromise;
        } finally {
            if (
                searchSequence === this.searchSequence &&
                this.prefetchPromise === prefetchPromise
            ) {
                this.prefetchPromise = null;
            }
        }
    }

    /**
     * Takes the prepared next page once, retaining its link when fetching fails.
     *
     * @return {Promise<Object|null>} Next ItemCollection, or null when no load
     *     was needed or the request was superseded.
     */
    async loadNextPage() {
        if (this.isLoading || !this.hasNextPage) {
            return null;
        }

        const searchSequence = this.searchSequence;
        this.isLoading = true;
        try {
            const itemCollection = await this.prefetchNextPage();
            if (
                searchSequence !== this.searchSequence ||
                itemCollection === null
            ) {
                return null;
            }
            this.bufferedPage = null;
            return itemCollection;
        } finally {
            if (searchSequence === this.searchSequence) {
                this.isLoading = false;
            }
        }
    }
}

/**
 * Manages the persistent selected footprint and transient preview footprint.
 */
export class CatalogFootprintController {
    /**
     * @param {Object} leafletMap Leaflet-compatible map.
     * @param {Function} layerFactory Creates a layer for an Item and visual state.
     */
    constructor(leafletMap, layerFactory) {
        this.leafletMap = leafletMap;
        this.layerFactory = layerFactory;
        this.selectedItemKey = null;
        this.selectedLayer = null;
        this.previewLayer = null;
    }

    /**
     * Displays and zooms to the selected Item footprint.
     *
     * @param {Object} item STAC Item selected in the result list.
     * @return {void}
     */
    select(item) {
        this.clear();
        this.selectedItemKey = this.itemKey(item);
        this.selectedLayer = this.layerFactory(item, "selected").addTo(
            this.leafletMap
        );
        const selectedBounds = this.selectedLayer.getBounds();
        if (selectedBounds.isValid()) {
            this.leafletMap.fitBounds(selectedBounds.pad(0.2), { maxZoom: 9 });
        }
    }

    /**
     * Displays a temporary lighter footprint for a non-selected Item.
     *
     * @param {Object} item STAC Item under pointer or keyboard focus.
     * @return {void}
     */
    preview(item) {
        this.clearPreview();
        if (this.itemKey(item) !== this.selectedItemKey) {
            this.previewLayer = this.layerFactory(item, "preview").addTo(
                this.leafletMap
            );
        }
    }

    /** Removes the temporary preview footprint. */
    clearPreview() {
        this.removeLayer(this.previewLayer);
        this.previewLayer = null;
    }

    /**
     * Remove the solid outline and allow the item to show a preview again.
     * @return {void}
     */
    clearSelectedFootprint() {
        this.removeLayer(this.selectedLayer);
        this.selectedLayer = null;
        this.selectedItemKey = null;
    }

    /** Remove both Catalog footprints. @return {void} */
    clear() {
        this.clearPreview();
        this.clearSelectedFootprint();
    }

    /**
     * @param {Object|null} layer Leaflet-compatible layer.
     * @return {void}
     */
    removeLayer(layer) {
        if (layer !== null) {
            this.leafletMap.removeLayer(layer);
        }
    }

    /**
     * @param {Object} item STAC Item.
     * @return {string} Identifier unique across Collections.
     */
    itemKey(item) {
        return `${item.collection ?? ""}/${item.id}`;
    }
}
