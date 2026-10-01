import { MapFeatureHover } from "./map-feature-hover.js";
import { findVectorLayerAtPointer } from "./vector/feature-hover.js";
import { getFeatureInfoViewport } from "./vector/feature-info-viewport.js";
import { annotationSummaryPolygons } from "./annotations/summary-area.js";
import { VectorSelectionOverlay } from "./vector/selection-overlay.js";
/**
 * Browser entry point and application composition root for EOLab.
 *
 * This module initializes the map, Catalog explorer, scanner controls, and
 * rendering diagnostics, then connects those features to the page. Raster
 * domain rules and raster-viewer behavior live under `raster/`; this file only
 * coordinates them with the rest of the application.
 */
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
    buildCatalogItemDetails,
    CatalogFootprintController,
    CatalogResultStream,
    CatalogSearchClient,
    CatalogSearchSyntaxError,
    CatalogSurpriseClient,
    createDebouncedAction,
    formatCatalogItemCount,
    formatCatalogVisualizationReason,
    formatScanReconciliation,
    formatScanProgressCounts,
    formatScanTiming,
    formatScanStatusSummary,
    getCatalogVisualization,
    MOUNTED_DATASET_TYPES,
} from "./catalog.js";
import { CatalogSearchSuggestions } from "./catalog-search-suggestions.js";
import { AnnotationPanelView } from "./annotations/panel-view.js";
import { AnnotationController } from "./annotations/controller.js";
import "./annotations/style.css";
import { AnnotationSessionsController } from "./annotation-sessions/controller.js";
import "./annotation-sessions/style.css";
import { CatalogVisualizationCoordinator } from "./catalog-visualization.js";
import { initializeCatalogPaneControls } from "./catalog-pane-controller.js";
import { CatalogScanControls } from "./catalog-scan-controls.js";
import { getCatalogItemKey } from "./catalog-item-identity.js";
import {
    buildCatalogResultPresentation,
    formatCatalogResultCount,
} from "./catalog-result-presentation.js";
import { createCatalogResultView } from "./catalog-result-view.js";
import { EomapLayoutController } from "./eomap-layout-controller.js";
import { MapInspectionController } from "./map-inspection-controller.js";
import {
    applyCatalogSystemState,
    renderScanLocations,
    synchronizeScanDisclosureState,
} from "./catalog-system-state.js";
import {
    createSingleWorldMap,
    observeMapViewportSize,
    getCatalogItemMapBounds,
    formatSingleWorldPosition
} from "./map.js";
import { addMapCoordinateGuide } from "./map-coordinate-guide.js";
import { MapLayerStyleEditor } from "./map-layers/style-editor.js";
import { MapLayerController } from "./map-layers/controller.js";
import { MapLayerStackView } from "./map-layers/layer-stack-view.js";
import { OnMapLegend } from "./map-layers/on-map-legend.js";
import { LeafletLayerSet } from "./map-layers/leaflet-layer-set.js";
import { CompositeMapPlanClient } from "./map-layers/composite-api.js";
import {
    CompositeLeafletRenderer,
} from "./map-layers/composite-leaflet-renderer.js";
import { addMapRenderStatus } from "./map-layers/map-render-status.js";
import {
    catalogItemsMatch,
    CatalogMapActionRegistry,
    CatalogVectorAssessmentCache,
} from "./catalog-map-actions.js";
import { initializeRasterViewer } from "./raster/raster-viewer.js";
import { RasterSeriesCalculations } from "./processing/raster-series-calculations.js";
import { RasterSeriesController } from "./raster/series.js";
import { RasterSeriesView } from "./raster/series-view.js";
import { sampleCatalogRasterPixel } from "./raster/analysis-api.js";
import "./raster/series.css";
import { RasterCursorValuesView } from "./raster/cursor-values-view.js";
import { SavedMapViewCatalogClient } from "./saved-map-view/catalog-client.js";
import { SavedMapViewController } from "./saved-map-view/controller.js";
import { SavedMapApiClient, namedMapSlugFromPath, editableMapSlugFromPath } from "./saved-map-view/api-client.js";
import { SavedMapViewDomView } from "./saved-map-view/dom-view.js";
import { createSavedMapLeafletViewport } from "./saved-map-view/leaflet-viewport.js";
import { SavedMapViewLocalStorage } from "./saved-map-view/local-storage.js";
import { VectorFeatureInspectorController } from "./vector/feature-inspector.js";
import { VectorFeatureProfileController } from "./vector/feature-profile.js";
import {
    validateVectorFeatureFocus,
} from "./vector/inspection-observation.js";
import { VectorFilterControls } from "./vector/filter-controls.js";
import { vectorFilterStatus } from "./vector/filter.js";
import { createVectorMapLayerAdapter } from "./vector/map-layer-adapter.js";
import { VectorStyleControls } from "./vector/style-controls.js";
import { vectorLabelFields } from "./vector/style.js";
import { VectorTimeSeriesController } from "./vector/time-series.js";
import { VectorSamplingController, createVectorSamplingArea } from "./vector/sampling.js";
import { VectorSamplingView } from "./vector/sampling-view.js";
import { ProcessingApiClient } from "./processing/api.js";
import { SummaryStatisticsController } from "./processing/summary-statistics-controller.js";
import { SummaryStatisticsView } from "./processing/summary-statistics-view.js";
import { CalculationRequests } from "./processing/calculation-requests.js";
import { CalculationSessionStorage } from "./processing/calculation-session.js";
import { ProcessingJobs } from "./processing/jobs.js";
import { RasterClipsController } from "./processing/raster-clips-controller.js";
import { RasterClipsView } from "./processing/raster-clips-view.js";
import { PendingSubmissionStorage } from "./processing/pending-submission.js";

/** Copy the Catalog identity and map label for a processing intent.
 * @param {Object} item Catalog Item.
 * @param {string} [label] Map-specific display name; defaults to the catalog title.
 * @return {Object} Source identity and presentation label.
 */
function clipSource(item, label = item.properties?.title ?? item.id) {
    return { collectionId: item.collection, itemId: item.id, label };
}

/** Access session storage without making restricted browsers lose the map. @return {Storage|null} Storage or unavailable. */
function browserSessionStorage() {
    try { return globalThis.sessionStorage; } catch { return null; }
}
import {
    applyRenderingDiagnosticsViewModel,
    buildRenderingDiagnosticsViewModel,
    buildUnavailableRenderingDiagnosticsViewModel,
    loadRenderingDiagnostics,
    RenderingDiagnosticsPoller,
} from "./rendering-diagnostics.js";
import "./style.css";
import "./processing/summary-statistics.css";

const CATALOG_SEARCH_DEBOUNCE_MILLISECONDS = 300;
const CATALOG_LOAD_ROOT_MARGIN = "300px 0px";

/** Presentation mode only; API permissions and source authorization are unchanged.
 * Read the named-map URL before choosing authoring or recipient controls.
 * @type {string|null}
 */
const editableMapSlug = editableMapSlugFromPath(globalThis.location.pathname);
const namedMapSlug = editableMapSlug ?? namedMapSlugFromPath(globalThis.location.pathname);
/** @type {boolean} Named maps and older shared links use recipient controls. */
const isSharedViewer = editableMapSlug === null && (namedMapSlug !== null || new URL(globalThis.location.href).searchParams.get("viewer") === "shared");
/** @type {Object|null} Public basemap selection interface supplied by the map owner. */
let basemapControl = null;

/**
 * Browser-safe application settings loaded from the backend.
 *
 * @typedef {Object} AppGlobalConfiguration
 * @property {string} appTitle Application title.
 * @property {string} appSubtitle Application subtitle.
 * @property {string} appVersion Deployed application version.
 * @property {string} catalogUrl Browser-facing STAC catalog URL.
 * @property {string} wmsUrl Browser-facing WMS endpoint.
 * @property {string} scanDisplayPathPrefix User-facing root for mounted files.
 * @property {string[]} scanDisplayPaths User-facing directories scanned recursively.
 * @property {{url:string,attribution:string,carto?:{url:string,attribution:string,maxNativeZoom:number},maptiler?:{url:string,attribution:string,maxNativeZoom:number}}} basemap Background tile settings; optional providers are present only when configured.
 * @property {{latitude: number, longitude: number, zoom: number}} initialView Initial map view.
 */

/**
 * Loads the browser-safe application settings.
 *
 * @return {Promise<AppGlobalConfiguration>} The application settings.
 * @throws {Error} If the settings endpoint does not return a successful response.
 */
async function loadAppGlobalConfiguration() {
    const configurationResponse = await fetch("/api/config", {
        headers: { Accept: "application/json" }
    });

    if (!configurationResponse.ok) {
        throw new Error(
            `Runtime configuration returned ${configurationResponse.status}`
        );
    }

    return configurationResponse.json();
}

/**
 * Create the map, coordinate guide and viewport resize observation.
 * Place map controls inside that viewport so docked panels cannot cover them.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @return {L.Map} The initialized Leaflet map.
 */
function initializeMap(appGlobalConfiguration) {
    const leafletMap = createSingleWorldMap(L, appGlobalConfiguration, control => { basemapControl = control; });
    observeMapViewportSize(leafletMap);
    addMapCoordinateGuide(L, leafletMap);

    // These presentation controls follow the map's allocated viewport.
    leafletMap.getContainer().append(document.querySelector(".map-tool-openers"));
    L.DomEvent.disableClickPropagation(document.querySelector(".map-tool-openers"));
    L.DomEvent.disableScrollPropagation(document.querySelector(".map-tool-openers"));
    L.DomEvent.on(document.querySelector(".map-tool-openers"), "keydown", L.DomEvent.stopPropagation);

    const mapPositionElement = document.querySelector("#map-position");
    leafletMap.getContainer().append(mapPositionElement);

    /**
     * Displays a geographic position reported by Leaflet.
     *
     * @param {{latlng: L.LatLng}} mapPositionEvent Leaflet position event.
     * @return {void}
     */
    function updateMapPosition(mapPositionEvent) {
        mapPositionElement.textContent = formatSingleWorldPosition(
            mapPositionEvent.latlng
        );
    }

    updateMapPosition({ latlng: leafletMap.getCenter() });
    leafletMap.on("mousemove", updateMapPosition);

    return leafletMap;
}

/**
 * Applies application identity and catalog state to the interface.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @return {void}
 */
function applyAppGlobalConfiguration(appGlobalConfiguration) {
    applyMapHeading(appGlobalConfiguration.appTitle, appGlobalConfiguration.appSubtitle);
    document.querySelector("#app-version").textContent = appGlobalConfiguration.appVersion;
    const catalogLinkElement = document.querySelector("#catalog-link");
    applyCatalogSystemState(
        {
            disclosure: document.querySelector("#system-state"),
            stateText: document.querySelector("#system-state-text"),
            stateAnnouncement: document.querySelector("#catalog-state-announcement")
        },
        "Catalog: connecting"
    );
    renderScanLocations(document.querySelector("#scan-locations"), appGlobalConfiguration.scanDisplayPaths);
    catalogLinkElement.href = appGlobalConfiguration.catalogUrl;
}

/**
 * Set map titles and accessible names, hiding an omitted optional subtitle.
 * @param {string} title Site title or published map title.
 * @param {string} subtitle Site subtitle or the creator's optional subtitle.
 * @return {void}
 */
function applyMapHeading(title, subtitle) {
    document.title = title;
    document.querySelector("#app-title").textContent =
        title;
    document.querySelector("#app-title").title =
        title;
    document.querySelector("#app-subtitle").textContent =
        subtitle;
    document.querySelector("#app-subtitle").title =
        subtitle;
    document.querySelector("#app-subtitle").hidden = !subtitle;
    document
        .querySelector("#map")
        .setAttribute(
            "aria-label",
            `${title} interactive map`
        );
    document
        .querySelector("#control-panel")
        .setAttribute(
            "aria-label",
            `${title} controls`
        );
    document.querySelector("#open-panel").textContent =
        `Open ${title}`;
}

/**
 * Bind the rendering diagnostics disclosure and visibility-aware poller.
 *
 * @return {void}
 */
function initializeRenderingDiagnostics() {
    const disclosureElement = document.querySelector(
        "#rendering-diagnostics"
    );
    const stateTextElement = document.querySelector("#rendering-state-text");
    const stateAnnouncementElement = document.querySelector(
        "#rendering-state-announcement"
    );
    const observedElement = document.querySelector("#rendering-observed");
    const observedVerbElement = document.querySelector(
        "#rendering-observed-verb"
    );
    const observedAtElement = document.querySelector(
        "#rendering-observed-at"
    );
    const diagnosticsElements = {
        disclosure: disclosureElement,
        stateText: stateTextElement,
        stateAnnouncement: stateAnnouncementElement,
        observed: observedElement,
        observedVerb: observedVerbElement,
        observedAt: observedAtElement,
        values: {
            heap: document.querySelector("#rendering-heap"),
            cpu: document.querySelector("#rendering-cpu"),
            requests: document.querySelector("#rendering-requests"),
            latestGetMap: document.querySelector(
                "#rendering-latest-get-map"
            ),
            failures: document.querySelector("#rendering-failures"),
            garbageCollection: document.querySelector(
                "#rendering-garbage-collection"
            ),
            threads: document.querySelector("#rendering-threads"),
            uptime: document.querySelector("#rendering-uptime")
        }
    };

    const poller = new RenderingDiagnosticsPoller(
        loadRenderingDiagnostics,
        (diagnostics) => {
            applyRenderingDiagnosticsViewModel(
                diagnosticsElements,
                buildRenderingDiagnosticsViewModel(diagnostics)
            );
        },
        () => {
            applyRenderingDiagnosticsViewModel(
                diagnosticsElements,
                buildUnavailableRenderingDiagnosticsViewModel()
            );
        }
    );

    /**
     * Match polling frequency to page visibility and disclosure state.
     *
     * @return {void}
     */
    function synchronizePollingMode() {
        poller.setMode({
            pageVisible: document.visibilityState === "visible",
            expanded: disclosureElement.open
        });
    }

    disclosureElement.addEventListener("toggle", synchronizePollingMode);
    document.addEventListener("visibilitychange", synchronizePollingMode);
    synchronizePollingMode();
}

/**
 * Creates a selected or preview Leaflet layer for one STAC Item.
 *
 * @param {Object} item STAC Item.
 * @param {string} visualState Either selected or preview.
 * @return {L.GeoJSON} Leaflet footprint layer.
 */
function createCatalogFootprintLayer(item, visualState) {
    return L.geoJSON(item, {
        style: { className: `catalog-footprint is-${visualState}` }
    });
}

/**
 * Loads and validates the catalog's STAC Collections document.
 *
 * @param {string} catalogUrl Browser-facing STAC root URL.
 * @return {Promise<Object>} Validated Collections response.
 */
async function loadCatalogCollections(catalogUrl) {
    const collectionsResponse = await fetch(`${catalogUrl}/collections`, {
        headers: { Accept: "application/json" }
    });
    if (!collectionsResponse.ok) {
        throw new Error(
            `STAC Collections returned ${collectionsResponse.status}`
        );
    }
    const collectionsDocument = await collectionsResponse.json();
    if (!Array.isArray(collectionsDocument.collections)) {
        throw new Error("STAC Collections response has no collections array");
    }
    return collectionsDocument;
}

/**
 * Creates a semantic metadata list whose labels are application display text
 * and whose values come from the selected STAC Item and Collection.
 *
 * @param {{label: string, value: string}[]} metadata Inspector metadata.
 * @return {HTMLDListElement} Definition list containing the metadata.
 */
function createCatalogMetadataList(metadata) {
    const metadataList = document.createElement("dl");
    metadataList.className = "catalog-metadata";
    for (const metadataEntry of metadata) {
        const metadataTerm = document.createElement("dt");
        metadataTerm.textContent = metadataEntry.label;
        const metadataDescription = document.createElement("dd");
        metadataDescription.textContent = metadataEntry.value;
        metadataList.append(metadataTerm, metadataDescription);
    }
    return metadataList;
}

/**
 * Displays the selected STAC Item in the inspector.
 *
 * @param {Object|null} item Selected STAC Item, or null for the empty state.
 * @param {Object[]} collections STAC Collections available to the Catalog.
 * @param {string} scanDisplayPathPrefix User-facing root for mounted files.
 * @return {void}
 */
function renderCatalogItemInspector(
    item,
    collections,
    scanDisplayPathPrefix
) {
    const inspectorHeading = document.querySelector(
        "#catalog-inspector-heading"
    );
    const inspectorContent = document.querySelector(
        "#catalog-inspector-content"
    );
    const inspectorStatus = document.querySelector(
        "#catalog-inspector-status"
    );
    const inspectorContext = document.querySelector("#catalog-item-context");
    inspectorContent.replaceChildren();

    // Render the empty state when no Item is selected.
    if (item === null) {
        inspectorHeading.textContent = "Selected item";
        inspectorHeading.removeAttribute("title");
        inspectorContext.textContent = "";
        const emptyInspector = document.createElement("div");
        emptyInspector.className = "catalog-inspector-empty";
        const emptyHeading = document.createElement("strong");
        emptyHeading.textContent = "No item selected";
        const emptyMessage = document.createElement("p");
        emptyMessage.textContent =
            "Select a Catalog result to inspect its metadata.";
        emptyInspector.append(emptyHeading, emptyMessage);
        inspectorContent.append(emptyInspector);
        inspectorStatus.textContent = "No Catalog Item is selected.";
        return;
    }

    // Render the Item's identity, description, and core metadata.
    const inspector = buildCatalogItemDetails(
        item,
        collections,
        scanDisplayPathPrefix
    );
    const presentation = buildCatalogResultPresentation(
        item,
        MOUNTED_DATASET_TYPES.get(item.collection)
    );
    inspectorHeading.textContent = presentation.filename;
    inspectorHeading.title = presentation.fullTitle;
    inspectorContext.textContent = [presentation.datasetType, presentation.context]
        .filter((label) => label !== null)
        .join(" · ");
    if (inspector.description !== null) {
        const description = document.createElement("p");
        description.className = "catalog-inspector-description";
        description.textContent = inspector.description;
        inspectorContent.append(description);
    }
    inspectorContent.append(createCatalogMetadataList([
        { label: "Item title", value: inspector.title },
        ...inspector.metadata,
    ]));

    if (inspector.fields.length > 0) {
        const fieldsHeading = document.createElement("h4");
        fieldsHeading.textContent = "Fields";
        inspectorContent.append(
            fieldsHeading,
            createCatalogMetadataList(inspector.fields)
        );
    }

    // Introduce the Item's Asset records or their empty state.
    const assetsHeading = document.createElement("h4");
    assetsHeading.textContent = "Assets";
    inspectorContent.append(assetsHeading);
    if (inspector.assets.length === 0) {
        const noAssetsMessage = document.createElement("p");
        noAssetsMessage.className = "catalog-inspector-note";
        noAssetsMessage.textContent = "No Assets are recorded for this Item.";
        inspectorContent.append(noAssetsMessage);
    }

    // Render the metadata for each Asset.
    for (const asset of inspector.assets) {
        const assetCard = document.createElement("article");
        assetCard.className = "catalog-asset";
        const assetHeading = document.createElement("h5");
        assetHeading.textContent = asset.title;
        const assetKey = document.createElement("p");
        assetKey.className = "catalog-asset-key";
        assetKey.textContent = `Asset key: ${asset.key}`;
        assetCard.append(
            assetHeading,
            assetKey,
            createCatalogMetadataList(asset.metadata)
        );

        // Render Raster extension band metadata when the Asset supplies it.
        if (asset.bands.length > 0) {
            const bandsHeading = document.createElement("strong");
            bandsHeading.className = "catalog-bands-heading";
            bandsHeading.textContent = "Raster bands";
            const bandList = document.createElement("ul");
            bandList.className = "catalog-band-list";
            for (const band of asset.bands) {
                const bandItem = document.createElement("li");
                const bandHeading = document.createElement("strong");
                bandHeading.textContent = band.title;
                const bandDetails = document.createElement("span");
                bandDetails.textContent = band.metadata
                    .map(
                        (metadataEntry) =>
                            `${metadataEntry.label}: ${metadataEntry.value}`
                    )
                    .join(" · ");
                bandItem.append(bandHeading, bandDetails);
                bandList.append(bandItem);
            }
            assetCard.append(bandsHeading, bandList);
        }
        inspectorContent.append(assetCard);
    }

    // Announce the selected Item to assistive technologies.
    inspectorStatus.textContent = `Selected item: ${inspector.title}.`;
}

/**
 * Connects Catalog search, progressive loading, selection, and refresh controls.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @param {L.Map} leafletMap The initialized Leaflet map.
 * @param {(viewer: import("./raster/raster-viewer.js").RasterViewer) => void}
 * [onRasterViewerReady=() => {}] Receives the raster public boundary before
 * asynchronous catalog loading begins.
 * @param {import("./catalog-pane-controller.js").CatalogPaneControls}
 * catalogPaneControls Catalog-owned progressive inspector presentation.
 * @param {MapInspectionController} mapInspection Shared map-side tools.
 * @param {() => void} [onRenderingWorkspaceRequested=() => {}] Reveals Map
 * layers after a successful catalog addition or an explicit shared-layer request.
 * @param {() => void} [onCatalogWorkspaceRequested=() => {}] Reveals Catalog
 * when retained-layer details are requested.
 * @param {() => void} [onLayoutChange=() => {}] Updates map size after editing-mode layout changes.
 * @return {Promise<Function>} Function that reloads the active catalog search.
 * @throws {TypeError} If the rendering-workspace callback is not callable.
 */
async function initializeCatalog(
    appGlobalConfiguration,
    leafletMap,
    onRasterViewerReady = () => {},
    catalogPaneControls,
    mapInspection,
    onRenderingWorkspaceRequested = () => {},
    onCatalogWorkspaceRequested = () => {},
    onLayoutChange = () => {}
) {
    if (
        typeof onRenderingWorkspaceRequested !== "function" ||
        typeof onCatalogWorkspaceRequested !== "function" ||
        typeof onLayoutChange !== "function"
    ) {
        throw new TypeError(
            "Workspace presentation callbacks must be callable"
        );
    }
    const catalogSystemStateElements = {
        disclosure: document.querySelector("#system-state"),
        stateText: document.querySelector("#system-state-text"),
        stateAnnouncement: document.querySelector(
            "#catalog-state-announcement"
        )
    };
    const catalogMessageElement = document.querySelector("#catalog-message");
    const catalogSummaryElement = document.querySelector("#catalog-summary");
    const catalogResultsElement = document.querySelector("#catalog-results");
    const catalogResultsScrollElement = document.querySelector(
        "#catalog-results-scroll"
    );
    const catalogSearchInput = document.querySelector("#catalog-search");
    new CatalogSearchSuggestions(document);
    const catalogSearchError = document.querySelector("#catalog-search-error");
    const surpriseCatalogButton = document.querySelector(
        "#surprise-catalog"
    );
    const catalogSurpriseStatus = document.querySelector(
        "#catalog-surprise-status"
    );
    const refreshCatalogButton = document.querySelector("#refresh-catalog");
    const streamStatusElement = document.querySelector(
        "#catalog-stream-status"
    );
    const retryPageButton = document.querySelector("#retry-catalog-page");
    const loadSentinelElement = document.querySelector(
        "#catalog-load-sentinel"
    );
    const streamAnnouncementElement = document.querySelector(
        "#catalog-stream-announcement"
    );
    const catalogMapActionsElement = document.querySelector(
        "#catalog-map-actions"
    );
    const catalogLayerToggle = document.querySelector(
        "#toggle-catalog-layer"
    );
    const catalogLayerStyle = document.querySelector("#style-catalog-layer");
    const catalogLayerZoom = document.querySelector("#zoom-catalog-layer");
    const catalogOnMap = document.querySelector("#catalog-on-map");
    const catalogMapActionStatus = document.querySelector(
        "#catalog-map-action-status"
    );
    const catalogLayerStatus = document.querySelector(
        "#catalog-layer-status"
    );
    const mapLayerRenderingAnnouncement = document.querySelector(
        "#map-layer-rendering-announcement"
    );
    const catalogUrl = appGlobalConfiguration.catalogUrl.replace(/\/$/, "");
    const resultStream = new CatalogResultStream(
        new CatalogSearchClient(catalogUrl)
    );
    const surpriseClient = new CatalogSurpriseClient();
    const footprintController = new CatalogFootprintController(
        leafletMap,
        createCatalogFootprintLayer
    );
    const catalogState = {
        collectionsDocument: null,
        resultViews: new Map(),
        mapActionFeedback: new Map(),
        searchSequence: 0,
        searchText: "",
        selectedButton: null,
        selectedItem: null,
        pendingMapActions: new CatalogMapActionRegistry(),
        vectorAssessments: new CatalogVectorAssessmentCache(),
        // Generation token: filter/search changes invalidate older async
        // Surprise responses so they cannot select an Item from stale criteria.
        surpriseRequestGeneration: 0,
    };

    /**
     * Report one layer-specific tile failure in Map layers.
     *
     * @param {string} message User-facing raster tile failure.
     * @param {Object} item Affected Catalog Item.
     * @return {void}
     */
    function reportMapTileError(message, item) {
        if (catalogItemsMatch(catalogState.selectedItem, item)) {
            catalogLayerStatus.textContent = message;
            mapLayerRenderingAnnouncement.textContent = message;
        }
    }

    /**
     * Refresh result rows and the inspector from each Item's own map state.
     *
     * @return {void}
     */
    function refreshCatalogMapAction() {
        for (const view of catalogState.resultViews.values()) {
            view.update({
                supported: getCatalogVisualization(view.item) !== null,
                retained: catalogVisualization.contains(view.item),
                canZoom: getCatalogItemMapBounds(view.item) !== null,
                pendingAction: catalogState.pendingMapActions.get(view.item),
                feedback: getCatalogMapActionFeedback(view.item),
            });
        }
        updateCatalogMapAction(catalogState.selectedItem);
    }

    /**
     * Read feedback only while it describes the Item's current membership.
     *
     * @param {Object|null} item Catalog Item or no current selection.
     * @return {{message:string,isError:boolean}|null} Relevant action feedback.
     */
    function getCatalogMapActionFeedback(item) {
        if (item === null) return null;
        const key = getCatalogItemKey(item);
        const feedback = catalogState.mapActionFeedback.get(key);
        if (feedback && feedback.retained !== catalogVisualization.contains(item)) {
            catalogState.mapActionFeedback.delete(key);
            return null;
        }
        return feedback ?? null;
    }

    /**
     * Publish outcome feedback to this Item's row and matching inspector.
     *
     * @param {Object} item Item whose action completed.
     * @param {string} message Accessible outcome or error text.
     * @param {boolean} [isError=false] Show failures beside the row action.
     * @return {void}
     */
    function setCatalogMapActionFeedback(item, message, isError = false) {
        catalogState.mapActionFeedback.set(getCatalogItemKey(item), {
            message, isError, retained: catalogVisualization.contains(item),
        });
        refreshCatalogMapAction();
    }

    /**
     * Begin one assessment or publication action for an Item.
     *
     * @param {Object} item Catalog Item owning the action.
     * @param {string} buttonText In-progress action label.
     * @param {string} statusText In-progress status explanation.
     * @return {{item:Object,key:string,buttonText:string,statusText:string}}
     * Identity token for matching completion.
     * @throws {Error} If the Item already owns an in-flight action.
     */
    function beginCatalogMapAction(item, buttonText, statusText) {
        catalogState.mapActionFeedback.delete(getCatalogItemKey(item));
        const pendingAction = catalogState.pendingMapActions.begin(
            item,
            buttonText,
            statusText
        );
        refreshCatalogMapAction();
        return pendingAction;
    }

    /**
     * Finish only the action that still owns this Item's controls.
     *
     * @param {{item:Object,key:string}} pendingAction Action identity returned
     * at start.
     * @return {void}
     */
    function finishCatalogMapAction(pendingAction) {
        if (!catalogState.pendingMapActions.finish(pendingAction)) {
            return;
        }
        refreshCatalogMapAction();
    }

    let annotations = null;
    let annotationSessions = null;
    let mapInteractionMode = "inspection";
    let rasterVisualization = null;
    let rasterSeries = null;
    let rasterSeriesArea = null;
    let rasterSeriesAreaLabel = "";
    /** Send committed sampling-area changes to the raster-series component.
     * @param {Object|null} area Path-free Processing area.
     * @param {string} label Selection description. @return {void}
     */
    const updateRasterSeriesArea = (area, label) => {
        rasterSeriesArea = area; rasterSeriesAreaLabel = label;
        rasterSeries?.setArea(area, label);
    };
    let layerStyleEditor = null;
    let savedMapViewController = null;
    let calculations = null;
    let vectorFeatureInspector = null;
    let mapFeatureHover = null;
    let vectorFilterControls = null;
    let vectorSampling = null;
    let summarySampling = null;
    let selectingMapClick = false;
    let rasterClickSelected = false;
    let latestHistogramPresentation = null;
    const mapLayerStackView = new MapLayerStackView(document, { allowRemoval: !isSharedViewer });
    const mapLegend = new OnMapLegend(L, leafletMap, {
        toggleButton: document.querySelector("#toggle-map-legend"),
        onInclusion: (key, included) => mapLayerController.setLegendIncluded(key, included),
        onChange: () => savedMapViewController?.scheduleRemember(),
    });
    const mapRenderStatus = addMapRenderStatus(
        L, leafletMap, () => {
            compositeLeafletRenderer.retryFailedTiles();
            leafletLayers.retryFailedTiles();
        },
    );
    const compositeLeafletRenderer = new CompositeLeafletRenderer({
        leaflet: L,
        leafletMap,
        client: new CompositeMapPlanClient(),
        onStatus: (status) => mapRenderStatus.update(status),
    });
    const leafletLayers = new LeafletLayerSet(leafletMap, compositeLeafletRenderer, {
        onStatus: status => mapRenderStatus.update(status),
        onLayerStatus: (key, status) => mapLayerController.updateTileStatus(key, status),
    });
    const mapLayerController = new MapLayerController({
        leafletMap,
        view: mapLayerStackView,
        leafletLayers,
        onLayersChange: (layers) => {
            mapLegend.update(layers);
            refreshCatalogMapAction();
            annotations?.observeLayerOrder(layers);
            rasterSeries?.updateAvailableRasters(layers.filter(layer => layer.datasetKind === "raster"));
            rasterVisualization?.syncVisibleLayers();
            layerStyleEditor?.refresh();
            vectorFeatureInspector?.syncVisibleLayers();
            mapFeatureHover?.hide();
            vectorFilterControls?.refresh();
            vectorSampling?.refresh();
            summarySampling?.refresh();
            calculations?.refreshSourceNames();
            if (!layers.some((layer) =>
                layer.visible && layer.datasetKind === "raster"
            )) {
                rasterClickSelected = false;
                mapInspection.setClickResult("histogram", null);
                mapInspection.closeHistogram(false);
            }
            savedMapViewController?.scheduleRemember();
        },
        onOrderChange: layers => { annotations?.observeLayerOrder(layers, true); mapFeatureHover?.hide(); },
        onItemZoom: zoomRetainedMapLayer,
        onItemInfo: inspectRetainedMapLayer,
        restoreRemovedLayer: (snapshot, isCurrent) => snapshot.item === null
            ? annotations.restoreRemovedLayer(snapshot, isCurrent)
            : catalogVisualization.restoreRemovedLayer(snapshot, identity => catalogItemClient.get(identity), isCurrent),
    });
    const processingApi = new ProcessingApiClient();
    const processingJobs = new ProcessingJobs(processingApi);
    /** Read current raster identities and sampling area. @return {{sources: Object[], area: Object|null}} Current Processing context. */
    const processingContext = () => ({
        sources: mapLayerController.snapshots().filter(layer => layer.datasetKind === "raster")
            .map(layer => clipSource(layer.item, layer.label)),
        area: rasterVisualization?.getSelectedArea() ?? null,
    });
    /** Open and focus the shared sampling controls. @return {void} */
    const editProcessingArea = () => {
        mapInspection.showHistogram();
        document.querySelector("#raster-sampling-disclosure").open = true;
        document.querySelector("#raster-sampling-vector-disclosure").open = true;
        document.querySelector("#raster-sampling-disclosure summary").focus();
    };
    const calculationRequests = new CalculationRequests({
        api: processingApi, jobs: processingJobs, storage: new CalculationSessionStorage(browserSessionStorage()),
        onActivity: area => rasterVisualization?.setSamplingActivity(area),
    });
    calculations = new SummaryStatisticsController({
        api: processingApi, jobs: processingJobs, view: new SummaryStatisticsView(),
        calculationRequests,
        onAreaChange: updateRasterSeriesArea, getContext: processingContext,
        onOpen: () => mapInspection.showCalculations(), onClose: () => mapInspection.hideCalculations(),
        onEditArea: editProcessingArea,
        onCancelSelection: () => summarySampling.invalidate("Selection cancelled"),
    });
    mapInspection.subscribeActiveTool(tool => calculations.setActive(tool === "calculations"));
    const rasterClips = new RasterClipsController({
        api: processingApi, jobs: processingJobs, view: new RasterClipsView(),
        storage: new PendingSubmissionStorage(browserSessionStorage()),
        getContext: processingContext,
        onOpen: () => mapInspection.showRasterClips(),
        onClose: () => mapInspection.hideRasterClips(),
        onEditArea: editProcessingArea,
    });
    mapInspection.subscribeActiveTool(tool => rasterClips.setActive(tool === "raster-clips"));
    mapLayerController.onDownload = (key) => {
        const record = mapLayerController.getRecord(key);
        if (record) rasterClips.open(clipSource(record.entry.item, record.entry.label));
    };
    mapLayerController.onCalculate = (key) => {
        const record = mapLayerController.getRecord(key);
        if (record) calculations.open(clipSource(record.entry.item, record.entry.label));
    };
    void rasterClips.start();

    rasterVisualization = initializeRasterViewer({
        wmsUrl: appGlobalConfiguration.wmsUrl,
        leafletMap,
        leaflet: L,
        onTileError: reportMapTileError,
        onDownloadRequested: (item, area) => rasterClips.open(clipSource(item, mapLayerController.getRecord(getCatalogItemKey(item))?.entry.label), area),
        onCalculateRequested: (item, area) => {
            calculations.open(clipSource(item, mapLayerController.getRecord(getCatalogItemKey(item))?.entry.label), area);
            calculations.calculateSelection(true);
        },
        onSamplingAreaChange: area => {
            calculations.setSelection(area);
            updateRasterSeriesArea(area, area?.kind === "catalogSelection" ? "Selected vector features" : "Current map sampling box");
        },
        onHistogramRequested: () => mapInspection.showHistogram(null, {
            activate: !selectingMapClick && !calculations.isActive,
        }),
        onHistogramChange: snapshot => {
            latestHistogramPresentation = snapshot;
            if (rasterClickSelected) mapInspection.setClickResult("histogram", snapshot);
        },
        onStyleRequested: (key) => layerStyleEditor?.open(key),
        onBivariateRenderingChange: (selectedKeys) =>
            mapLayerController.setIndividualRendering(selectedKeys),
    }, {
        mapLayerController,
        cursorValuesView: new RasterCursorValuesView(),
    });
    const vectorMapLayerAdapter = createVectorMapLayerAdapter({
        onFilterChange: () => mapLayerController.render(),
        leaflet: L,
        leafletMap,
        wmsUrl: appGlobalConfiguration.wmsUrl,
        onTileError: reportMapTileError,
    });
    vectorFilterControls = new VectorFilterControls({
        inspection: mapInspection,
        getTarget: (key) => {
            const annotation = annotations?.filterTarget(key);
            if (annotation) return annotation;
            const record = mapLayerController.getRecord(key);
            if (record === null || record.adapter !== vectorMapLayerAdapter) return null;
            return {
                key, label: record.entry.label, fields: record.state.labelFields,
                filter: record.state.filter, status: vectorFilterStatus(record.state),
                apply: (candidate) => record.adapter.applyFilterState(record, candidate),
                cancelPending: () => record.adapter.cancelPendingFilter(record),
            };
        },
    });
    mapLayerController.onFilter = key => vectorFilterControls.open(key);
    const vectorSamplingOverlay = new VectorSelectionOverlay(leafletMap, L);
    /** Read catalog polygon targets for histogram and summary controls.
     * @return {Object[]} Retained catalog identities and applied filter snapshots.
     */
    const catalogPolygonTargets = () => mapLayerController.retainedRecords
        .filter(record => record.adapter === vectorMapLayerAdapter && record.state.style?.geometryKind === "polygon")
        .map(record => ({ key: record.entry.key, label: record.entry.label, item: record.entry.item,
            filter: record.adapter.exportFilterState(record) }));
    vectorSampling = new VectorSamplingController({
        view: new VectorSamplingView(),
        getTargets: catalogPolygonTargets,
        createArea: createVectorSamplingArea,
        onEditFilter: key => vectorFilterControls.open(key, calculations.isActive ? {
            filter: vectorSampling.selectedFilter(key),
            apply: candidate => vectorSampling.use({ key, filter: candidate, analysis: true }),
            complete: area => vectorSampling.activate(area.selection, true),
            cancel: () => vectorSampling.invalidate("Selection cancelled"),
        } : null),
        onSelectionState: selection => calculations.setVectorSelectionState(selection),
        /** Accept reviewed features and run configured statistics when accepting from Summarize.
         * @param {Object} area Authoritative catalog descriptor and selection metadata.
         * @param {boolean} calculate Explicit calculation intent from the filter action.
         * @return {void}
         */
        onActivate: (area, calculate) => {
            const returnToSummary = calculations.isActive;
            void vectorSamplingOverlay.load(area);
            const label = `${area.label} · ${area.matched} of ${area.total} features`;
            rasterVisualization.setVectorSelection({ ...area, label });
            calculations.setVectorSamplingArea({ selection: area.selection, label }, calculate || returnToSummary);
            if (returnToSummary) mapInspection.showCalculations();
        },
        onInvalidate: id => {
            vectorSamplingOverlay.clear();
            rasterVisualization.setVectorSelection(null);
            calculations.invalidateSamplingArea(id);
        },
    });
    summarySampling = new VectorSamplingController({
        view: new VectorSamplingView(document, { root: "#calculations-vector-area", choice: null, disclosure: null }),
        getTargets: () => [...catalogPolygonTargets(), ...(annotations?.summaryTargets() ?? [])],
        /** Select catalog features or upload the exact matched annotation polygons.
         * @param {Object|null} item Catalog item, absent for browser-owned annotations.
         * @param {Object} filter Applied field conditions.
         * @param {AbortSignal} signal Superseded catalog selection.
         * @param {Object} target Committed layer snapshot supplied above.
         * @return {Promise<Object>} Area reference, bounds and feature counts.
         * @throws {Error} If no polygons match, upload fails or catalog selection fails.
         */
        createArea: async (item, filter, signal, target) => {
            if (item) return createVectorSamplingArea(item, filter, signal);
            const polygons = annotationSummaryPolygons(target.polygons, filter, target.savedFilter);
            if (!polygons.length) throw new Error("No polygons match this filter. Add a polygon or change the conditions.");
            // Let an accepted upload reply settle so an obsolete input can be released.
            const area = await processingApi.uploadPolygonArea(polygons);
            return { ...area, label: target.label, total: target.polygons.length, filter };
        },
        onSourceChange: (target, filter, wasActive) => {
            if (target?.polygons && wasActive && calculations.followsVectorChanges) {
                // The selection controller applies its normal large-area review policy again.
                void summarySampling.use({ key: target.key, filter });
            }
        },
        releaseArea: area => { if (area.polygonArea) void processingApi.discardPolygonArea(area.polygonArea.id).catch(() => {}); },
        onEditFilter: key => vectorFilterControls.open(key, {
            filter: summarySampling.selectedFilter(key),
            apply: filter => summarySampling.use({ key, filter, analysis: true }),
            complete: area => summarySampling.activate(area.polygonArea ?? area.selection, true),
            cancel: () => summarySampling.invalidate("Selection cancelled"),
        }),
        onSelectionState: selection => calculations.setVectorSelectionState({ ...selection, analysis: true }),
        onActivate: area => {
            const label = `${area.label} · ${area.matched} of ${area.total} features`;
            if (area.selection) void vectorSamplingOverlay.load(area);
            else vectorSamplingOverlay.clear();
            calculations.setVectorSamplingArea({ selection: area.selection, polygonArea: area.polygonArea, label }, true);
            mapInspection.showCalculations();
        },
        onInvalidate: (selection, area) => {
            if (area.polygonArea) calculations.invalidatePolygonArea(area.polygonArea.id);
            else calculations.invalidateSamplingArea(selection);
        },
    });
    const vectorStyleControls = new VectorStyleControls();
    layerStyleEditor = new MapLayerStyleEditor({
        mapLayers: mapLayerController, rasterViewer: rasterVisualization,
        inspection: mapInspection,
        vectorStyleControls,
        onFilterRequested: (key) => vectorFilterControls.open(key),
        getVectorStyleTarget: (key) => {
            const record = mapLayerController.getRecord(key);
            if (record === null || record.adapter !== vectorMapLayerAdapter) {
                return null;
            }
            return {
                key,
                style: record.state.style,
                fields: record.state.labelFields,
                notice: record.state.defaultStyleNotice,
                summarize: (field) =>
                    record.adapter.summarizeCategories(record, field),
                classify: (field, method, classCount) =>
                    record.adapter.classifyNumbers(record, field, method, classCount),
                apply: async (style) => {
                    const applied = await record.adapter.applyStyle(record, style);
                    mapLayerController.render();
                    return applied;
                },
            };
        },
    });
    mapLayerController.onStyle = key => {
        if (!annotations?.openControls(key, "style")) layerStyleEditor.open(key);
    };
    rasterVisualization.syncVisibleLayers();
    const catalogVisualization = new CatalogVisualizationCoordinator(
        rasterVisualization,
        mapLayerController,
        vectorMapLayerAdapter
    );
    const catalogItemClient = new SavedMapViewCatalogClient(catalogUrl);
    savedMapViewController = new SavedMapViewController({
        view: new SavedMapViewDomView(),
        viewport: createSavedMapLeafletViewport(leafletMap),
        mapLayers: mapLayerController,
        catalogVisualization,
        catalogItems: catalogItemClient,
        viewerVersion: appGlobalConfiguration.appVersion,
        viewerOrigin: globalThis.location.origin,
        storage: isSharedViewer || editableMapSlug !== null ? null : new SavedMapViewLocalStorage(),
        restoreSharedMap: isSharedViewer,
        publicationApi: new SavedMapApiClient(),
        namedMapSlug,
        editPublishedMap: editableMapSlug !== null,
        allowPublishing: !isSharedViewer && editableMapSlug === null,
        publicationDefaults: { title: appGlobalConfiguration.appTitle, subtitle: appGlobalConfiguration.appSubtitle },
        applyMapHeading,
        basemap: basemapControl,
        mapLegend,
        initialViewport: {
            center: {
                latitude: appGlobalConfiguration.initialView.latitude,
                longitude: appGlobalConfiguration.initialView.longitude,
            },
            zoom: appGlobalConfiguration.initialView.zoom,
        },
        beforeRestore: clearCatalogSelection,
        exportAnnotation: record => {
            const sharedAnnotation = annotationSessions?.getMapReference(record.state.id);
            if (!sharedAnnotation) return null;
            const { outline, weight, fillOpacity, labels } = record.adapter.exportSavedState(record).style;
            return { sharedAnnotation, visible: record.entry.visible, opacity: record.entry.opacity,
                // Keep saved-map v1 fields in sync with the single local label setting.
                appearance: { outline, weight, fillOpacity, labels, notes: labels } };
        },
        restoreAnnotation: async (layer, isCurrent) => {
            const id = await annotationSessions.openMapReference(layer.sharedAnnotation, isCurrent);
            return id && isCurrent() ? annotations.restoreMapAppearance(id, layer) : null;
        },
    });
    leafletMap.on("moveend", () =>
        savedMapViewController?.scheduleRemember()
    );
    leafletMap.on("basemapchange", () => savedMapViewController?.scheduleRemember());
    const rasterAreaSeries = new RasterSeriesCalculations({ requests: calculationRequests });
    rasterSeries = new RasterSeriesController({
        areaStatistics: rasterAreaSeries,
        onEditArea: () => calculations.open(),
        samplePoint: sampleCatalogRasterPixel,
        view: new RasterSeriesView(),
        onClose: () => { mapInspection.hideRasterSeries(); leafletMap.getContainer().focus(); },
    });
    rasterSeries.setArea(rasterSeriesArea, rasterSeriesAreaLabel);
    void rasterAreaSeries.recoverAndCancelPreviousSeriesCalculations();
    void calculations.start();
    document.querySelector("#open-raster-series-summary").addEventListener("click", () => {
        rasterSeries.setMode("area");
        mapInspection.showRasterSeries();
    });
    rasterSeries.updateAvailableRasters(mapLayerController.snapshots().filter(layer => layer.datasetKind === "raster"));
    mapInspection.subscribeActiveTool(tool => rasterSeries.updateSamplingForPanelVisibility(tool === "raster-series"));
    for (const id of ["open-raster-series", "open-raster-series-dock", "open-raster-series-histogram"]) {
        document.querySelector(`#${id}`).addEventListener("click", () => mapInspection.showRasterSeries());
    }
    const vectorTimeSeries = new VectorTimeSeriesController({
        onVisibilityChange: (visible, moveFocus) => {
            if (visible) mapInspection.showVectorTimeSeries();
            else mapInspection.hideVectorTimeSeries(moveFocus);
        },
        onPresentationChange: (identity) =>
            mapInspection.setVectorTimeSeriesIdentity(identity),
        onFeatureZoom: zoomInspectedVectorFeature,
    });
    const vectorFeatureProfile = new VectorFeatureProfileController({
        onVisibilityChange: (visible, moveFocus) => {
            if (visible) mapInspection.showVectorFeatureProfile();
            else mapInspection.hideVectorFeatureProfile(moveFocus);
        },
        onPresentationChange: (identity) =>
            mapInspection.setVectorFeatureProfileIdentity(identity),
        onNavigateFeature: (direction) =>
            vectorFeatureInspector?.navigateResult(direction),
        onFeatureZoom: zoomInspectedVectorFeature,
    });
    /**
     * Supply the same top-first published vector targets to click and hover queries.
     * @return {import("./vector/feature-info.js").VectorFeatureInspectionTarget[]} Visible targets.
     */
    function visibleVectorInspectionTargets() {
        return mapLayerController.retainedRecords
            .filter((record) =>
                record.entry.visible && record.adapter === vectorMapLayerAdapter
            )
            .map((record) => ({
                sourceId: record.entry.key,
                label: record.entry.label,
                opacity: record.entry.opacity,
                bbox: [...record.entry.item.bbox],
                publication: {
                    layerName: record.publication.layerName,
                    styleName: record.publication.styleName,
                },
                geometryKind: record.state.style.geometryKind,
                propertyNames: vectorLabelFields(record.state.item).map(
                    ({ name }) => name
                ),
                primaryGeometry:
                    record.state.item.properties?.["table:primary_geometry"] ?? null,
            }));
    }
    vectorFeatureInspector = new VectorFeatureInspectorController({
        leaflet: L,
        leafletMap,
        getVisibleTargets: () => visibleVectorInspectionTargets(),
        wmsUrl: appGlobalConfiguration.wmsUrl,
        onInspectionChange: (visible) => {
            if (visible) mapInspection.showFeatureInspector({ activate: false });
            else {
                mapInspection.hideFeatureInspector();
                mapInspection.setClickResult("feature", null);
            }
        },
        onSampleChange: (sample) => {
            vectorTimeSeries.setSample(sample);
            const returned = sample.observations.length;
            const featureCount = `${returned} feature${returned === 1 ? "" : "s"} returned`;
            const layerCount = new Set(sample.observations.map(observation => observation.sourceId)).size;
            const message = sample.state === "loading"
                ? `Updating for this click… ${featureCount}`
                : sample.state === "ready"
                    ? `${featureCount} across ${layerCount} layer${layerCount === 1 ? "" : "s"}` +
                        (sample.failedLayers ? ` · ${sample.failedLayers} layer${sample.failedLayers === 1 ? "" : "s"} unavailable` : " · Ready")
                    : sample.message;
            mapInspection.setClickResult("feature", {
                state: sample.failedLayers && sample.state !== "loading" ? "error" : sample.state,
                message,
            });
            if (sample.state === "loading" || sample.state === "ready") {
                mapInspection.setFeatureResultCount(
                    sample.observations.length,
                    { loading: sample.state === "loading" }
                );
            }
        },
        onCurrentObservationChange: (observation, navigation) =>
            vectorFeatureProfile.setCurrentObservation(observation, navigation),
        onFeatureProfileRequested: () => {
            vectorTimeSeries.close();
            vectorFeatureProfile.open();
        },
        onTimeSeriesRequested: () => {
            vectorFeatureProfile.close();
            vectorTimeSeries.open();
        },
        onStyleRequested: (sourceId) => layerStyleEditor.open(sourceId),
        onFilterRequested: (sourceId) => vectorFilterControls.open(sourceId),
        onFeatureZoomRequested: zoomInspectedVectorFeature,
    });
    /**
     * Sample rasters and catalog vectors, then foreground any clicked annotation's details.
     * Leaflet emits this event only for a completed click, not a drag-pan.
     *
     * @param {{latlng:{lng:number,lat:number},containerPoint?:{x:number,y:number}}}
     * event Leaflet map-click shape.
     * @return {void}
     */
    function exploreMap(event) {
        if (mapInteractionMode !== "inspection") return;
        mapInspection.beginMapClick(event.latlng);
        rasterSeries.setPosition({ longitude: event.latlng.lng, latitude: event.latlng.lat });
        rasterClickSelected = false;
        selectingMapClick = true;
        try {
            rasterClickSelected = rasterVisualization.exploreAt(event.latlng, {
                onSelected: area => {
                    calculations.setSelection(area);
                    updateRasterSeriesArea(area, area?.kind === "catalogSelection" ? "Selected vector features" : "Current map sampling box");
                    calculations.calculateSelection();
                },
            });
            if (!rasterClickSelected) {
                mapInspection.closeHistogram(false);
                calculations.setSelection(null);
                updateRasterSeriesArea(null, "");
            }
            mapInspection.setClickResult("histogram", rasterClickSelected ? latestHistogramPresentation : null);
            void vectorFeatureInspector.inspect(event);
            annotations?.inspectAt(event.latlng);
        } finally {
            selectingMapClick = false;
        }
    }
    /**
     * Open analysis tools at the map center through the pointer-click path.
     *
     * @return {void}
     */
    function openAnalysisToolsAtMapCenter() {
        const latlng = leafletMap.getCenter();
        exploreMap({
            latlng,
            containerPoint: leafletMap.latLngToContainerPoint(latlng),
        });
    }
    {
        const annotationPanel = new AnnotationPanelView({ document,
            onOpen: () => mapInspection.showAnnotations(),
            onClose: () => { annotations.clearInspection(); mapInspection.hideAnnotations(); } });
        annotations = new AnnotationController({
            panel: annotationPanel,
            leaflet: L,
            map: leafletMap,
            mapLayers: mapLayerController,
            onShare: id => annotationSessions.shareLayer(id),
            onColor: (id, color) => annotationSessions.setContributorColor(id, color),
            onRenameContributor: id => annotationSessions.editContributorName(id),
            requestEditing: id => annotationSessions.requestDrawing(id),
            onCommittedChange: () => { annotationSessions?.committedLayersChanged(); summarySampling.refresh(); vectorFilterControls.refresh(); },
            onFilter: key => vectorFilterControls.open(key),
            onHoverInvalidated: () => mapFeatureHover?.hide(),
            onEditingChange: editing => {
                mapFeatureHover?.setEnabled(!editing);
                mapInteractionMode = editing ? "layer-editing" : "inspection";
                document.querySelector("main").classList.toggle("is-editing-map-layer", editing);
                rasterVisualization.setPointerInspectionEnabled(!editing);
                onLayoutChange();
            },
        });
        annotationSessions = new AnnotationSessionsController({
            document,
            createLayer: (name, collection, options) => annotations.restoreSharedContribution(name, collection, options),
            revealLayer: id => { onRenderingWorkspaceRequested(); annotations.revealDrawing(id); },
            drawAfterJoining: id => annotations.beginPolygon(id),
            getLayers: () => annotations.sharableLayers(),
            isLayerOnMap: id => annotations.isLayerOnMap(id),
            present: (id, data) => {
                if (annotations.updateSharedLayer(id, data)) { summarySampling.refresh(); vectorFilterControls.refresh(); }
            },
        });
        void annotationSessions.start({ restoreBindings: false, refreshImmediately: false }).then(async () => {
            await annotations.load({ attachSavedLayers: !isSharedViewer && editableMapSlug === null,
                sharedLayerIds: annotationSessions.bookmarkedLayerIds() });
            summarySampling.refresh();
            await savedMapViewController.restoreStartupView(globalThis.location.hash);
            annotations.restoreLayerOrder({ useSavedPositions: !isSharedViewer && editableMapSlug === null && !globalThis.location.hash,
                mapOrderedLayerIds: annotationSessions.bookmarkedLayerIds() });
            void annotationSessions.refresh();
        });
    }
    mapFeatureHover = new MapFeatureHover(leafletMap, {
        findLocalText: event => {
            const hit = annotations.polygonsAt(event.latlng)[0];
            return hit ? `${hit.layerName}\n${hit.polygon.name}${hit.polygon.contributor ? ` — ${hit.polygon.contributor}` : ""}` : null;
        },
        findRemoteText: (event, signal) => findVectorLayerAtPointer({
            targets: visibleVectorInspectionTargets().filter(target => target.opacity > 0),
            viewport: getFeatureInfoViewport(leafletMap, event.containerPoint),
            wmsUrl: appGlobalConfiguration.wmsUrl,
            signal,
        }),
    });
    leafletMap.getContainer().classList.add("leaflet-crosshair");
    leafletMap.on("click", exploreMap);
    document.querySelector("#open-analysis-tools").addEventListener(
        "click",
        openAnalysisToolsAtMapCenter
    );
    onRasterViewerReady(rasterVisualization, rasterClips, calculations);
    /**
     * Apply the scanner-owned visualization decision to the map action.
     *
     * @param {Object|null} item Selected Catalog Item.
     * @return {void}
     */
    function updateCatalogMapAction(item) {
        const visualization = getCatalogVisualization(item);
        const isRetained = item !== null && catalogVisualization.contains(item);
        const pendingAction = item === null
            ? null
            : catalogState.pendingMapActions.get(item);
        catalogMapActionsElement.hidden = visualization === null;
        catalogMapActionsElement.setAttribute(
            "aria-busy",
            String(pendingAction !== null)
        );
        catalogLayerToggle.disabled = pendingAction !== null;
        catalogLayerToggle.hidden = false;
        catalogLayerStyle.hidden = !isRetained;
        catalogLayerStyle.disabled = pendingAction !== null;
        const canZoom = getCatalogItemMapBounds(item) !== null;
        catalogLayerZoom.hidden = !isRetained;
        catalogLayerZoom.disabled = pendingAction !== null || !canZoom;
        catalogLayerZoom.title = canZoom ? "Zoom to this item's bounding box."
            : "Zoom unavailable: this item has no usable bounding box.";
        const actionStatus = pendingAction?.statusText ??
            getCatalogMapActionFeedback(item)?.message ?? "";
        if (catalogMapActionStatus.textContent !== actionStatus) {
            catalogMapActionStatus.textContent = actionStatus;
        }
        catalogOnMap.hidden = !isRetained;
        catalogLayerToggle.classList.toggle("catalog-add-action", !isRetained);
        catalogLayerToggle.textContent = pendingAction?.buttonText ?? (
            isRetained
                ? "Remove from map"
                : "Add to map"
        );
        const fullVisualizationReason = formatCatalogVisualizationReason(
            item,
            visualization?.metadata?.reason
        );
        catalogLayerStatus.textContent = [
            fullVisualizationReason,
            isRetained
                ? visualization?.kind === "vector"
                    ? "This vector is on the map."
                    : "This raster is on the map."
                : "",
        ].filter((message) => message !== "").join(" ");
    }

    /**
     * Clear the selected result, analysis session, footprint, and inspector.
     *
     * @return {void}
     */
    function clearCatalogSelection() {
        if (catalogState.selectedItem !== null) {
            rasterVisualization.deactivateAnalysis(
                catalogState.selectedItem
            );
        }
        catalogState.selectedButton?.classList.remove("is-selected");
        catalogState.selectedButton?.setAttribute("aria-pressed", "false");
        footprintController.clear();
        catalogState.selectedButton = null;
        catalogState.selectedItem = null;
        catalogMapActionStatus.textContent = "";
        updateCatalogMapAction(null);
        renderCatalogItemInspector(
            null,
            catalogState.collectionsDocument?.collections ?? [],
            appGlobalConfiguration.scanDisplayPathPrefix
        );
        catalogPaneControls.showResults();
    }

    /**
     * Select one result and activate analysis when it is a Catalog raster.
     *
     * @param {Object} item Catalog Item selected from results or discovery.
     * @param {HTMLElement|null} [requestedButton=null] Optional matching result
     * button when the Item is already present in the current page.
     * @return {void}
     */
    function selectCatalogItem(item, requestedButton = null) {
        catalogState.vectorAssessments.apply(item);
        const itemButton = requestedButton ??
            catalogState.resultViews.get(getCatalogItemKey(item))?.detailsButton ?? null;
        if (catalogState.selectedButton !== null) {
            catalogState.selectedButton.classList.remove("is-selected");
            catalogState.selectedButton.setAttribute("aria-pressed", "false");
        }
        catalogState.selectedButton = itemButton;
        catalogState.selectedItem = item;
        catalogMapActionStatus.textContent = "";
        itemButton?.classList.add("is-selected");
        itemButton?.setAttribute("aria-pressed", "true");
        footprintController.select(item);
        renderCatalogItemInspector(
            item,
            catalogState.collectionsDocument.collections,
            appGlobalConfiguration.scanDisplayPathPrefix
        );
        if (getCatalogVisualization(item)?.kind !== "raster") {
            rasterVisualization.deactivateAnalysis(null);
        } else {
            rasterVisualization.activateAnalysis(item);
        }
        updateCatalogMapAction(item);
        catalogPaneControls.showInspector({
            moveFocus: true, returnFocusTarget: itemButton,
        });
    }

    /**
     * Appends one successful Item Search page to the active result stream.
     *
     * @param {Object} itemCollection STAC ItemCollection response.
     * @param {boolean} isInitialPage Whether this starts a new result stream.
     * @return {void}
     */
    function appendCatalogPage(itemCollection, isInitialPage) {
        const returnedItemCount = itemCollection.features.length;
        if (isInitialPage) {
            const isFiltered = catalogState.searchText.trim() !== "";
            const itemCountLabel = formatCatalogItemCount(
                itemCollection,
                isFiltered
            );
            const resultCountLabel = formatCatalogResultCount(itemCollection);
            applyCatalogSystemState(
                catalogSystemStateElements,
                `Catalog: connected · ${itemCountLabel}`,
                "is-connected"
            );
            catalogMessageElement.textContent = `${resultCountLabel} available.`;
            catalogSummaryElement.textContent = resultCountLabel;

            const pageBounds = L.geoJSON(itemCollection).getBounds();
            if (pageBounds.isValid()) {
                leafletMap.fitBounds(pageBounds.pad(0.15), { maxZoom: 8 });
            }
        }

        for (const item of itemCollection.features) {
            catalogState.vectorAssessments.apply(item);
            const presentation = buildCatalogResultPresentation(
                item,
                MOUNTED_DATASET_TYPES.get(item.collection)
            );
            const view = createCatalogResultView({
                item, presentation,
                id: `catalog-result-${catalogState.searchSequence}-${catalogState.resultViews.size}`,
                onDetails: selectCatalogItem,
                onMapAction: (requestedItem) => toggleCatalogLayer(requestedItem),
                onStyle: styleCatalogLayer,
                onZoom: zoomCatalogLayer,
                onPreview: (previewItem) => footprintController.preview(previewItem),
                onClearPreview: () => footprintController.clearPreview(),
            });
            const itemButton = view.detailsButton;
            catalogState.resultViews.set(getCatalogItemKey(item), view);
            if (
                catalogState.selectedItem !== null &&
                getCatalogItemKey(catalogState.selectedItem) ===
                    getCatalogItemKey(item)
            ) {
                catalogState.selectedButton = itemButton;
                itemButton.classList.add("is-selected");
                itemButton.setAttribute("aria-pressed", "true");
            }
            catalogResultsElement.append(view.element);
        }
        refreshCatalogMapAction();

        if (catalogResultsElement.childElementCount === 0) {
            const emptyCatalogMessage = document.createElement("p");
            emptyCatalogMessage.className = "catalog-empty";
            emptyCatalogMessage.textContent = catalogState.searchText.trim()
                ? `No Items matched “${catalogState.searchText.trim()}”.`
                : "The catalog is connected but has no Items.";
            catalogResultsElement.append(emptyCatalogMessage);
        }

        if (!isInitialPage) {
            streamAnnouncementElement.textContent =
                `${returnedItemCount.toLocaleString()} additional Items loaded.`;
        }
    }

    /** Prepare one page ahead, then watch for the user to reach it. */
    async function prefetchNextCatalogPage() {
        const searchSequence = catalogState.searchSequence;
        retryPageButton.hidden = true;
        streamStatusElement.textContent = "Preparing more Catalog Items…";
        try {
            const bufferedPage = await resultStream.prefetchNextPage();
            if (
                searchSequence !== catalogState.searchSequence ||
                bufferedPage === null
            ) {
                return;
            }
            streamStatusElement.textContent =
                "More Items are ready as you scroll.";
            if (!resultStream.isLoading) {
                pageObserver.observe(loadSentinelElement);
            }
        } catch (catalogError) {
            if (searchSequence !== catalogState.searchSequence) {
                return;
            }
            pageObserver.unobserve(loadSentinelElement);
            streamStatusElement.textContent =
                `Additional Items could not be prepared: ${catalogError.message}`;
            retryPageButton.hidden = false;
        }
    }

    /** Prepare another page or display the end of the active stream. */
    function observeNextCatalogPage() {
        pageObserver.unobserve(loadSentinelElement);
        retryPageButton.hidden = true;
        if (!resultStream.hasNextPage) {
            streamStatusElement.textContent = "End of results.";
            return;
        }
        void prefetchNextCatalogPage();
    }

    /** Start a new search and replace every result from the previous stream. */
    async function loadCatalog(reloadCollections = false) {
        const searchSequence = ++catalogState.searchSequence;
        catalogState.vectorAssessments.clear();
        catalogState.surpriseRequestGeneration += 1;
        catalogState.searchText = catalogSearchInput.value;
        catalogSearchInput.removeAttribute("aria-invalid");
        catalogSearchError.textContent = "";
        pageObserver.unobserve(loadSentinelElement);
        retryPageButton.hidden = true;
        clearCatalogSelection();
        catalogState.resultViews.clear();
        catalogState.mapActionFeedback.clear();
        catalogResultsElement.replaceChildren();
        catalogResultsElement.setAttribute("aria-busy", "true");
        applyCatalogSystemState(
            catalogSystemStateElements,
            "Catalog: searching"
        );
        catalogMessageElement.textContent =
            "Requesting Collections and Items from the STAC API.";
        catalogSummaryElement.textContent = "Loading results...";
        streamStatusElement.textContent = "Loading Catalog Items…";
        refreshCatalogButton.disabled = true;
        surpriseCatalogButton.disabled = true;
        surpriseCatalogButton.setAttribute("aria-busy", "false");
        catalogSurpriseStatus.textContent = "";

        try {
            const collectionsRequest =
                reloadCollections || catalogState.collectionsDocument === null
                    ? loadCatalogCollections(catalogUrl)
                    : Promise.resolve(catalogState.collectionsDocument);
            const [collectionsDocument, itemCollection] = await Promise.all([
                collectionsRequest,
                resultStream.restart(catalogState.searchText)
            ]);
            if (
                searchSequence !== catalogState.searchSequence ||
                itemCollection === null
            ) {
                return;
            }
            catalogState.collectionsDocument = collectionsDocument;
            appendCatalogPage(itemCollection, true);
            observeNextCatalogPage();
        } catch (catalogError) {
            if (searchSequence !== catalogState.searchSequence) {
                return;
            }
            if (catalogError instanceof CatalogSearchSyntaxError) {
                catalogSearchInput.setAttribute("aria-invalid", "true");
                catalogSearchError.textContent = catalogError.message;
                applyCatalogSystemState(
                    catalogSystemStateElements,
                    "Catalog: search needs correction"
                );
                catalogMessageElement.textContent =
                    "Correct the field filter and try again.";
                catalogSummaryElement.textContent = "Search needs correction";
                streamStatusElement.textContent = "Catalog search was not sent.";
                return;
            }
            applyCatalogSystemState(
                catalogSystemStateElements,
                "Catalog: unavailable",
                "is-warning"
            );
            catalogMessageElement.textContent =
                "Check the catalog services and try again.";
            catalogSummaryElement.textContent = "Catalog unavailable";
            streamStatusElement.textContent = "Catalog search failed.";
        } finally {
            if (searchSequence === catalogState.searchSequence) {
                catalogResultsElement.setAttribute("aria-busy", "false");
                refreshCatalogButton.disabled = false;
                surpriseCatalogButton.disabled = false;
            }
        }
    }

    /** Append the provider's next page while retaining existing results. */
    async function loadNextCatalogPage() {
        if (resultStream.isLoading || !resultStream.hasNextPage) {
            return;
        }

        const searchSequence = catalogState.searchSequence;
        pageObserver.unobserve(loadSentinelElement);
        retryPageButton.hidden = true;
        streamStatusElement.textContent = "Loading more Catalog Items…";
        catalogResultsElement.setAttribute("aria-busy", "true");
        try {
            const itemCollection = await resultStream.loadNextPage();
            if (
                searchSequence !== catalogState.searchSequence ||
                itemCollection === null
            ) {
                return;
            }
            appendCatalogPage(itemCollection, false);
            observeNextCatalogPage();
        } catch (catalogError) {
            if (searchSequence !== catalogState.searchSequence) {
                return;
            }
            streamStatusElement.textContent =
                `Additional Items could not be loaded: ${catalogError.message}`;
            retryPageButton.hidden = false;
        } finally {
            if (searchSequence === catalogState.searchSequence) {
                catalogResultsElement.setAttribute("aria-busy", "false");
            }
        }
    }

    const pageObserver = new IntersectionObserver(
        (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                void loadNextCatalogPage();
            }
        },
        {
            root: catalogResultsScrollElement,
            rootMargin: CATALOG_LOAD_ROOT_MARGIN,
        }
    );

    const scheduleCatalogSearch = createDebouncedAction(
        loadCatalog.bind(null, false),
        CATALOG_SEARCH_DEBOUNCE_MILLISECONDS,
        window
    );
    catalogSearchInput.addEventListener("input", () => {
        // Invalidate immediately rather than waiting for the debounced search.
        catalogState.surpriseRequestGeneration += 1;
        surpriseCatalogButton.disabled = true;
        catalogSurpriseStatus.textContent = "";
        scheduleCatalogSearch();
    });
    surpriseCatalogButton.addEventListener("click", async () => {
        const requestGeneration = ++catalogState.surpriseRequestGeneration;
        surpriseCatalogButton.disabled = true;
        surpriseCatalogButton.setAttribute("aria-busy", "true");
        catalogSurpriseStatus.textContent = "Finding a random match…";
        catalogSearchInput.removeAttribute("aria-invalid");
        catalogSearchError.textContent = "";
        try {
            const item = await surpriseClient.surprise(
                catalogState.searchText,
                catalogState.selectedItem
            );
            if (
                requestGeneration !== catalogState.surpriseRequestGeneration ||
                item === null
            ) {
                return;
            }
            selectCatalogItem(item);
            const itemTitle = item.properties?.title ?? item.id;
            catalogSurpriseStatus.textContent = `Selected ${itemTitle}.`;
        } catch (catalogError) {
            if (requestGeneration !== catalogState.surpriseRequestGeneration) {
                return;
            }
            if (catalogError instanceof CatalogSearchSyntaxError) {
                catalogSearchInput.setAttribute("aria-invalid", "true");
                catalogSearchError.textContent = catalogError.message;
                catalogSurpriseStatus.textContent =
                    "Correct the Catalog search before trying again.";
                return;
            }
            catalogSurpriseStatus.textContent = catalogError.message;
        } finally {
            if (requestGeneration === catalogState.surpriseRequestGeneration) {
                surpriseCatalogButton.disabled = false;
                surpriseCatalogButton.setAttribute("aria-busy", "false");
            }
        }
    });
    refreshCatalogButton.addEventListener(
        "click",
        loadCatalog.bind(null, true)
    );
    retryPageButton.addEventListener("click", prefetchNextCatalogPage);
    /**
     * Add or remove one explicitly requested Catalog Item independently of selection.
     *
     * Prepared rasters publish directly. Vector add attempts retain their
     * authoritative capability assessment before publication. Successful adds
     * open Map layers so the user can find the added layer's controls.
     *
     * @param {Object|null} item Item requested by a row or inspector action.
     * @return {Promise<void>} Completion after this Item's action settles.
     */
    async function toggleCatalogLayer(item) {
        const visualization = catalogVisualization.describe(item);
        if (visualization === null || catalogState.pendingMapActions.get(item) !== null) {
            return;
        }
        const datasetNoun = catalogVisualization.noun(item);
        if (catalogVisualization.contains(item)) {
            catalogVisualization.remove(item, true);
            if (visualization.kind === "raster" && catalogItemsMatch(catalogState.selectedItem, item)) {
                rasterVisualization.activateAnalysis(item);
            }
            const removalStatus =
                `${datasetNoun[0].toUpperCase()}${datasetNoun.slice(1)} ` +
                "removed from the map.";
            setCatalogMapActionFeedback(item, removalStatus);
            return;
        }

        const pendingAction = beginCatalogMapAction(
            item,
            "Adding to map...",
            visualization.kind === "vector"
                ? "Checking whether this vector layer can be rendered."
                : "Publishing this prepared raster."
        );
        try {
            const preparedItem = await catalogVisualization.prepare(item);
            if (visualization.kind === "vector") {
                catalogState.vectorAssessments.record(item, preparedItem);
            }
            const currentVisualization = catalogVisualization.describe(preparedItem);
            if (catalogItemsMatch(catalogState.selectedItem, item)) {
                catalogState.vectorAssessments.apply(catalogState.selectedItem);
                if (currentVisualization?.kind === "raster") {
                    rasterVisualization.activateAnalysis(catalogState.selectedItem);
                }
                renderCatalogItemInspector(
                    catalogState.selectedItem,
                    catalogState.collectionsDocument.collections,
                    appGlobalConfiguration.scanDisplayPathPrefix
                );
            }
            if (
                currentVisualization?.kind === "vector" &&
                currentVisualization.metadata?.eligible !== true
            ) {
                setCatalogMapActionFeedback(item,
                    formatCatalogVisualizationReason(
                        item,
                        currentVisualization?.metadata?.reason
                    ) ||
                    "Visualization is unavailable for this item.", true);
                return;
            }

            const publication = await catalogVisualization.show(preparedItem);
            if (publication === null) return;
            const successStatus =
                `${datasetNoun[0].toUpperCase()}${datasetNoun.slice(1)} ` +
                "added to the map.";
            setCatalogMapActionFeedback(item, successStatus);
            onRenderingWorkspaceRequested();
        } catch (visualizationError) {
            setCatalogMapActionFeedback(item, formatCatalogVisualizationReason(
                item, visualizationError.message
            ), true);
        } finally {
            finishCatalogMapAction(pendingAction);
        }
    }
    /**
     * Open the shared editor for a retained Item without selecting or showing it.
     *
     * @param {Object|null} item Item requested by a result or details shortcut.
     * @return {void}
     */
    function styleCatalogLayer(item) {
        if (item === null || !catalogVisualization.contains(item) ||
            catalogState.pendingMapActions.get(item) !== null) return;
        layerStyleEditor.open(getCatalogItemKey(item));
    }

    /**
     * Fit a retained Item's bounds without changing selection or layer state.
     *
     * @param {Object|null} item Item requested by a result or details shortcut.
     * @return {boolean} Whether the retained Item could be fitted.
     */
    function zoomCatalogLayer(item) {
        const bounds = getCatalogItemMapBounds(item);
        if (bounds === null || !catalogVisualization.contains(item) ||
            catalogState.pendingMapActions.get(item) !== null) return false;
        leafletMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 9 });
        return true;
    }

    /**
     * Fit the map to one retained layer through its authoritative Catalog Item.
     *
     * @param {Object|null} item Authoritative retained Catalog Item.
     * @return {boolean} Whether the retained Item could be fitted.
     */
    function zoomRetainedMapLayer(item) {
        return zoomCatalogLayer(item);
    }

    /**
     * Focus the map on a geometry-neutral selected-feature target.
     *
     * Already-returned line and polygon bounds fit with proportional padding.
     * Points and geometry-free feature results use a neighborhood-scale center
     * so bounded inspection never needs to request full feature geometry.
     *
     * @param {Object} focus Validated center and optional WGS 84 bounds.
     * @return {boolean} Whether the map accepted the focus target.
     */
    function zoomInspectedVectorFeature(focus) {
        try {
            validateVectorFeatureFocus(focus);
        } catch {
            return false;
        }
        const [longitude, latitude] = focus.center;
        const bounds = focus.bounds;
        if (
            bounds === null ||
            bounds[0] === bounds[2] && bounds[1] === bounds[3]
        ) {
            leafletMap.setView([latitude, longitude], 14);
            return true;
        }
        const [west, south, east, north] = bounds;
        leafletMap.fitBounds(
            L.latLngBounds([[south, west], [north, east]]).pad(0.15),
            { maxZoom: 14 }
        );
        return true;
    }

    /**
     * Open Catalog details for one retained layer without coupling its view to
     * Catalog presentation or navigation.
     *
     * @param {Object|null} item Authoritative retained Catalog Item.
     * @return {void}
     */
    function inspectRetainedMapLayer(item) {
        if (item === null) return;
        if (isSharedViewer) {
            renderCatalogItemInspector(item, [], appGlobalConfiguration.scanDisplayPathPrefix);
            catalogPaneControls.showInspector({ moveFocus: true, returnFocusTarget: document.activeElement });
            return;
        }
        onCatalogWorkspaceRequested();
        selectCatalogItem(item);
    }

    catalogLayerZoom.addEventListener("click", () => {
        zoomCatalogLayer(catalogState.selectedItem);
    });
    catalogLayerStyle.addEventListener("click", () => {
        styleCatalogLayer(catalogState.selectedItem);
    });
    catalogLayerToggle.addEventListener("click", () => {
        void toggleCatalogLayer(catalogState.selectedItem);
    });
    if (!isSharedViewer) await loadCatalog(true);
    return loadCatalog.bind(null, true);
}

/**
 * Displays the current mounted-directory scan state.
 *
 * @param {Object} scanStatus Scan progress returned by the backend.
 * @return {void}
 */
function renderScanStatus(scanStatus) {
    const startScanButton = document.querySelector("#start-scan");
    const catalogStateDisclosureElement = document.querySelector(
        "#system-state"
    );
    const scanStatusDisclosureElement = document.querySelector(
        "#scan-status-disclosure"
    );
    const scanStatusSummaryElement = document.querySelector(
        "#scan-status-summary"
    );
    const scanStatusElement = document.querySelector("#scan-status");
    const scanProgressElement = document.querySelector("#scan-progress");
    const scanCountsElement = document.querySelector("#scan-counts");
    const scanReconciliationElement = document.querySelector(
        "#scan-reconciliation"
    );
    const scanTimingElement = document.querySelector("#scan-timing");
    const scanTimingValuesElement = document.querySelector(
        "#scan-timing-values"
    );
    const scanErrorsDisclosureElement = document.querySelector(
        "#scan-errors-disclosure"
    );
    const scanErrorsSummaryElement = document.querySelector(
        "#scan-errors-summary"
    );
    const scanErrorsElement = document.querySelector("#scan-errors");
    const isRunning = ["discovering", "scanning"].includes(scanStatus.state);
    const wasRunning = scanStatusDisclosureElement.dataset.running === "true";

    startScanButton.disabled = isRunning;
    startScanButton.textContent = isRunning ? "Scanning…" : "Scan directories";
    scanStatusSummaryElement.textContent = formatScanStatusSummary(scanStatus);
    // Set defaults only when a scan starts or stops so polling does not
    // override a user's disclosure choices during the same run.
    synchronizeScanDisclosureState(
        {
            catalogState: catalogStateDisclosureElement,
            scanStatus: scanStatusDisclosureElement
        },
        isRunning,
        wasRunning
    );
    scanStatusDisclosureElement.dataset.running = String(isRunning);
    scanProgressElement.hidden = scanStatus.state === "not_started";
    scanProgressElement.max = Math.max(
        scanStatus.sourceDatasetsDiscovered,
        1
    );
    scanProgressElement.value = scanStatus.sourceDatasetsProcessed;
    scanCountsElement.textContent =
        scanStatus.state === "not_started"
            ? ""
            : formatScanProgressCounts(scanStatus);
    scanReconciliationElement.hidden = scanStatus.state === "not_started";
    scanReconciliationElement.textContent = formatScanReconciliation(
        scanStatus.reconciliation
    );
    scanReconciliationElement.classList.toggle(
        "is-error",
        scanStatus.reconciliation.state === "failed"
    );

    scanTimingElement.hidden = scanStatus.state === "not_started";
    scanTimingValuesElement.replaceChildren();
    for (const timingRow of formatScanTiming(
        scanStatus.timing,
        scanStatus.workerCount,
        scanStatus.writerCount,
        scanStatus.batchSize
    )) {
        const timingLabel = document.createElement("dt");
        timingLabel.textContent = timingRow.label;
        const timingValue = document.createElement("dd");
        timingValue.textContent = timingRow.value;
        scanTimingValuesElement.append(timingLabel, timingValue);
    }

    const statusMessages = {
        not_started: "No scan has run since EOLab started.",
        discovering:
            "Discovering geospatial datasets in the mounted directories.",
        scanning: scanStatus.currentFile
            ? `Latest file: ${scanStatus.currentFile}`
            : "Preparing discovered geospatial datasets.",
        completed: "Scan completed.",
        failed: "The scan stopped before it could complete."
    };
    scanStatusElement.textContent =
        statusMessages[scanStatus.state] ??
        `Unknown scan state: ${scanStatus.state}`;

    scanErrorsDisclosureElement.hidden =
        scanStatus.state === "not_started" || scanStatus.errors.length === 0;
    scanErrorsSummaryElement.textContent = scanStatus.errorsTruncated
        ? `Error details (${scanStatus.errors.length.toLocaleString()} shown)`
        : `Error details (${scanStatus.errors.length.toLocaleString()})`;
    scanErrorsElement.replaceChildren();
    for (const scanError of scanStatus.errors) {
        const errorItem = document.createElement("li");
        errorItem.textContent = scanError.path
            ? `${scanError.path}: ${scanError.error}`
            : scanError.error;
        scanErrorsElement.append(errorItem);
    }
    if (scanStatus.errorsTruncated) {
        const truncatedErrorsMessage = document.createElement("li");
        truncatedErrorsMessage.textContent =
            "Additional file failures are not shown.";
        scanErrorsElement.append(truncatedErrorsMessage);
    }
}

/**
 * Connects the mounted-directory scanner controls.
 *
 * @param {() => Promise<void>} refreshCatalog Reloads the active Catalog search.
 * @return {Promise<void>} Resolves after a snapshot or recoverable status error.
 */
async function initializeScanner(refreshCatalog) {
    const controls = new CatalogScanControls({
        documentContext: document, windowContext: window,
        renderStatus: renderScanStatus, refreshCatalog,
    });
    await controls.observe();
}

/**
 * Starts the browser application from its runtime contract.
 *
 * @return {Promise<void>} Resolves after the interface is initialized.
 */
async function startApplication() {
    /** @type {EomapLayoutController|null} */
    let layoutController = null;
    const catalogPaneControls = initializeCatalogPaneControls(
        document,
        () => layoutController?.notifyLayoutChange(),
        { detailsDialog: isSharedViewer ? document.querySelector("#shared-layer-details") : null }
    );
    document.querySelector(".annotation-layer-tools").hidden = isSharedViewer;
    document.querySelector("#summary-performance").hidden = isSharedViewer;
    if (isSharedViewer || editableMapSlug !== null) {
        document.querySelector("#reset-map-view").hidden = true;
        document.querySelector("#copy-map-link").hidden = true;
        if (isSharedViewer) document.querySelector(".map-layers-empty-state").textContent = "No layers loaded. Reload to retry, or ask the author for a complete map link.";
        if (editableMapSlug !== null) document.querySelector("#published-map-editor").hidden = false;
    } else {
        document.querySelector("#copy-map-link-label").textContent = "Publish map";
        document.querySelector("#copy-map-link").title = "Publish a map for others to explore";
        document.querySelector("#copy-map-link svg").innerHTML =
            '<path d="m12 5-3-1-6 3v14l6-3 6 3 6-3v-6M9 4v14m6-5v8"></path>' +
            '<path d="M15 3h6v6m0-6-8 8"></path>';
    }
    const appGlobalConfiguration = await loadAppGlobalConfiguration();
    applyAppGlobalConfiguration(appGlobalConfiguration);
    if (!isSharedViewer) initializeRenderingDiagnostics();
    const leafletMap = initializeMap(appGlobalConfiguration);
    layoutController = new EomapLayoutController({
        documentContext: document,
        schedule: window.setTimeout.bind(window),
        invalidateMapSize: () => leafletMap.invalidateSize(),
        allowCatalog: !isSharedViewer,
        allowOperationalStatus: !isSharedViewer,
        workspaceStorage: isSharedViewer || editableMapSlug !== null
            ? null
            : new SavedMapViewLocalStorage(undefined, "eolab.workspace-panels.v1"),
    });
    if (isSharedViewer) layoutController.showWorkspace("map-layers");
    const mapInspection = new MapInspectionController({
        onLayoutChange: layout => layoutController.setInspectionLayout(layout),
    });
    const refreshCatalog = await initializeCatalog(
        appGlobalConfiguration,
        leafletMap,
        () => {},
        catalogPaneControls,
        mapInspection,
        () => layoutController.showWorkspace("map-layers"),
        () => layoutController.showWorkspace("catalog"),
        () => layoutController.notifyLayoutChange()
    );
    if (!isSharedViewer) await initializeScanner(refreshCatalog);
}

startApplication();
