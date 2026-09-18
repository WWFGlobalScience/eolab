/**
 * Application coordinator for one interactive Catalog raster viewer.
 *
 * This module connects publication, Leaflet layers, raster controls,
 * statistics, selected-area sampling, styling, and exact point values. It owns
 * their shared lifecycle and stale-work rules while delegating domain logic,
 * HTTP access, DOM presentation, and Leaflet construction to focused modules.
 */
import { getCatalogItemKey } from "../catalog-item-identity.js";
import { publishCatalogRaster } from "./api.js";
import {
    loadCatalogRasterStatistics,
    loadCatalogRasterPairedStatistics,
    RasterAnalysisRequestError,
    isRasterStatisticsCapacityError,
    sampleCatalogRasterPixel,
} from "./analysis-api.js";
import {
    BivariateRasterMode,
    getBivariateAxisStyles,
} from "./bivariate.js";
import {
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
    MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM,
    isCanonicalWgs84Position,
} from "./geometry.js";
import {
    createRasterSampleWindowLayer,
    createRasterWmsLayer,
    ensureRasterSampleWindowPane,
    setRasterLayerAdditiveBlend,
} from "./leaflet.js";
import { MapLayerController } from "../map-layers/controller.js";
import { MapLayerStackView } from "../map-layers/layer-stack-view.js";
import { RasterCursorSamplesController } from "./cursor-samples.js";
import { RasterPointSamplesController } from "./point-samples.js";
import {
    formatRasterPixelValue,
    getCatalogRasterBasename,
    getCatalogRasterStem,
} from "./value-format.js";
import { RasterSampleWindowController } from "./sample-window-controller.js";
import {
    DEFAULT_RASTER_PERCENTILES,
    estimateRasterHistogramPercentile,
    normalizeRasterSamplingArea,
    rasterStatisticsMatchesSelection,
    WHOLE_RASTER_SAMPLING_AREA,
} from "./statistics.js";
import { RasterStatisticsController } from "./statistics-controller.js";
import { RasterStatisticsRequestQueue } from "./statistics-request-queue.js";
import { getHistogramValueLabel } from "./histogram-axes.js";
import {
    estimateRasterPairedHistogramPercentile,
    normalizeRasterPairedSamplingArea,
    WHOLE_RASTER_OVERLAP_SAMPLING_AREA,
} from "./paired-statistics.js";
import {
    applyRasterColorPalette,
    DEFAULT_RASTER_PALETTE_NAME,
    DEFAULT_RASTER_STYLE,
    deriveInitialRasterStyleFromStatistics,
    deriveRasterStyleFromStatistics,
    RASTER_COLOR_PALETTES,
    buildRasterLegend,
    validateRasterStyle,
} from "./style.js";
import { buildRasterStyleEnvironment } from "./wms.js";
import { RasterControlsView } from "./controls-view.js";

const RASTER_STYLE_DEBOUNCE_MILLISECONDS = 200;
export const RASTER_SAMPLE_WINDOW_RESIZE_DEBOUNCE_MILLISECONDS = 350;
const PORTABLE_RASTER_STYLE_FIELDS = Object.freeze([
    "minimum",
    "midpoint",
    "maximum",
    "minimumColor",
    "midpointColor",
    "maximumColor",
    "minimumOpacity",
    "midpointOpacity",
    "maximumOpacity",
]);

/**
 * Copy and strictly validate one untrusted portable raster style.
 *
 * @param {unknown} candidate Candidate saved style definition.
 * @return {Object} Canonical raster style containing only owned fields.
 */
function normalizePortableRasterStyle(candidate) {
    if (candidate === null || typeof candidate !== "object" ||
        Array.isArray(candidate)) {
        throw new TypeError("Saved raster style must be an object.");
    }
    const keys = Object.keys(candidate).sort();
    if (JSON.stringify(keys) !==
        JSON.stringify([...PORTABLE_RASTER_STYLE_FIELDS].sort())) {
        throw new TypeError(
            "Saved raster style contains missing or unsupported fields."
        );
    }
    return validateRasterStyle(Object.fromEntries(
        PORTABLE_RASTER_STYLE_FIELDS.map((field) => [field, candidate[field]])
    ));
}

/**
 * Check one copied style against the portable raster appearance contract.
 *
 * @param {Object} savedState Candidate portable style envelope.
 * @return {string|null} Null when compatible or a user-facing reason.
 */
function checkPortableRasterStyleCompatibility(savedState) {
    if (savedState?.kind !== "raster") {
        return "Only copied raster styles can be pasted onto raster layers.";
    }
    try {
        normalizePortableRasterStyle(savedState.definition);
        if (
            savedState.paletteName !== "custom" &&
            !Object.hasOwn(RASTER_COLOR_PALETTES, savedState.paletteName)
        ) {
            throw new TypeError("Copied raster palette is invalid.");
        }
        return null;
    } catch (error) {
        return error instanceof Error
            ? `Copied raster style is invalid: ${error.message}`
            : "Copied raster style is invalid.";
    }
}

/**
 * Return whether repeating a failed statistics request may change its result.
 *
 * Unclassified client/conflict responses describe invalid or unsupported
 * intent. Classified capacity conflicts may recover after waiting. Unknown
 * transport failures, timeouts, rate limits, and server failures remain
 * retryable without coupling the viewer to backend error-message text.
 *
 * @param {Error} error Statistics request failure.
 * @return {boolean} Whether the controls should offer the Retry action.
 */
function canRetryRasterStatistics(error) {
    if (!(error instanceof RasterAnalysisRequestError)) {
        return true;
    }
    return (
        isRasterStatisticsCapacityError(error) || error.status === 408 ||
        error.status === 429 ||
        error.status >= 500
    );
}

/**
 * @typedef {Object} RasterViewer
 * @property {() => void} clear Remove all retained raster interactions.
 * @property {() => void} reset Clear the raster and restore default styling.
 * @property {(item: Object) => Promise<Object|null>} show Publish and retain
 * one selected raster Item.
 * @property {() => void} syncVisibleLayers Opt into histogram selection from
 * the top visible rasters and synchronize analysis without choosing a style target.
 * @property {(position:{lng:number,lat:number}, options?:{onSelected?:(area:Object|null)=>void}) => boolean} exploreAt Select
 * one validated, in-bounds map window and request its histogram when analysis
 * is active.
 * @property {(key:string) => boolean} openStyle Select a retained raster for
 * editing; return false when the key has no raster session.
 * @property {(key:string) => boolean} openPairedStyle Reveal the shared 2D
 * controls for a current pair member; return false for any other key.
 * @property {() => void} closeStyle Flush a pending edit and release its target.
 * @property {() => void} refreshStyle Refresh the editing target's availability
 * and percentile controls, discarding pending work if the target disappeared.
 * @property {(item:Object) => void} activateAnalysis Start independent raster
 * analysis controls without requiring a renderer.
 * @property {(item:Object|null) => void} deactivateAnalysis Remove a matching
 * analysis-only session and restore retained map-layer controls.
 * @property {(item: Object) => boolean} contains Return whether an Item is
 * retained in the layer stack.
 * @property {(item: Object) => void} remove Remove one Item from the stack.
 * @property {(key?:string|null,mode?:string)=>Readonly<Object>|null} getSelectedArea
 * Read an immutable explicit selection, independently of statistics readiness.
 * @property {() => void} destroy Permanently detach viewer listeners; the
 * viewer must not be reused afterward.
 * @property {boolean} isDisplayed Whether any raster layer is visible.
 */

/**
 * @typedef {Object} RasterViewerConfiguration
 * @property {string} wmsUrl Browser-facing GeoServer WMS endpoint.
 * @property {Object} leafletMap Initialized Leaflet-compatible map.
 * @property {Object} leaflet Leaflet namespace with WMS and rectangle factories.
 * @property {(message: string, item: Object) => void} onTileError Reports a
 * layer-specific tile error.
 * @property {(layers: Object[]) => void} [onLayersChange] Receives retained
 * layer snapshots after state changes.
 * @property {() => void} [onHistogramRequested] Notifies the composition root
 * that an explicit analysis action should reveal its presentation workspace.
 * @property {(snapshot:{state:string,message:string}|null)=>void} [onHistogramChange]
 * Receives current histogram participation and status without exposing analysis state.
 * @property {(key:string) => void} [onStyleRequested] Notifies the composition
 * root that a histogram action should open one retained layer's style editor.
 * @property {(item:Object,area:Readonly<Object>|null)=>void} [onDownloadRequested]
 * Notify composition of a raster and its explicit selected area.
 * @property {(selectedKeys:string[]|null)=>void}
 * [onBivariateRenderingChange] Requests isolated source rendering for selected
 * catalog keys, or ordinary composite rendering for null.
 */

/**
 * @typedef {Object} RasterViewerDependencies
 * @property {RasterControlsView|null} [controlsView=null] Raster-control DOM
 * adapter; null constructs the application view.
 * @property {MapLayerStackView|null} [layerStackView=null] Layer-list DOM
 * adapter created only when the viewer owns its neutral controller.
 * @property {MapLayerController|null} [mapLayerController=null] Neutral shared
 * retained-layer controller supplied by application composition.
 * @property {(item: Object) => Promise<Object>}
 * [publishRaster=publishCatalogRaster] Publishes one Catalog raster.
 * @property {(item: Object, samplingArea:Object, signal:AbortSignal)
 * => Promise<Object>} [loadStatistics=loadCatalogRasterStatistics] Loads whole
 * or selected statistics.
 * @property {(item: Object, point: Object, signal: AbortSignal)
 * => Promise<Object>} [samplePixel=sampleCatalogRasterPixel] Samples one raster
 * pixel.
 * @property {(item: Object, point: Object, signal: AbortSignal)
 * => Promise<Object>} [sampleCursorPixel=samplePixel] Samples one transient
 * cursor participant independently from retained click analysis.
 * @property {{render:(snapshot:Object)=>void,clear:()=>void,move?:Function,
 * setEnabled?:Function,bind?:Function,unbind?:Function}|null}
 * [cursorValuesView=null] Transient pixel-picker presentation adapter.
 * @property {(xItem:Object,yItem:Object,area:Object,signal:AbortSignal)
 * =>Promise<Object>} [loadPairedStatistics=loadCatalogRasterPairedStatistics]
 * Loads paired X-reference statistics.
 * @property {{setTimeout: (callback: () => void, delay: number) => *,
 * clearTimeout: (identifier: *) => void}} [clock=globalThis] Timer
 * implementation.
 */

/**
 * Connect raster appearance, statistics, sampling, and Leaflet interactions.
 *
 * The returned feature boundary owns isolated raster state and controls while
 * consuming the neutral retained map-layer controller.
 *
 * @param {RasterViewerConfiguration} configuration Viewer configuration.
 * @param {RasterViewerDependencies} [dependencies={}] Injectable
 * collaborators.
 * @return {RasterViewer} Raster visualization boundary used by the Catalog.
 * @throws {Error} If the DOM, Leaflet, or injected collaborator contracts are
 * incomplete.
 */
export function initializeRasterViewer(
    {
        wmsUrl,
        leafletMap,
        leaflet,
        onTileError,
        onCalculateRequested = () => {},
        onHistogramChange = () => {},
        onSamplingAreaChange = () => {},
        onDownloadRequested = /** @param {Object} _item Catalog source. @param {Object|null} _area Explicit selection. @return {void} */ (_item, _area) => {},
        onLayersChange = /**
         * Ignore layer snapshots when no application observer is supplied.
         * Accepts no parameters; callback arguments are intentionally unused.
         *
         * @return {void}
         */ () => {},
        onHistogramRequested = /**
         * Leave workspace visibility unchanged without a presentation callback.
         *
         * @return {void}
         */ () => {},
        onStyleRequested = /**
         * Leave style presentation unchanged without a composition callback.
         *
         * @param {string} _key Retained raster identity supplied by the view.
         * @return {void}
         */ (_key) => {},
        onBivariateRenderingChange = /**
         * Keep ordinary composite rendering without a composition callback.
         *
         * @return {void}
         */ () => {},
    },
    {
        controlsView = null,
        layerStackView = null,
        mapLayerController = null,
        publishRaster = publishCatalogRaster,
        loadStatistics = loadCatalogRasterStatistics,
        samplePixel = sampleCatalogRasterPixel,
        sampleCursorPixel = samplePixel,
        loadPairedStatistics = loadCatalogRasterPairedStatistics,
        cursorValuesView = null,
        clock = globalThis,
    } = {}
) {
    if (typeof onHistogramRequested !== "function") {
        throw new TypeError("Histogram presentation callback must be callable");
    }
    if (typeof onStyleRequested !== "function") {
        throw new TypeError("Style presentation callback must be callable");
    }
    if (typeof onBivariateRenderingChange !== "function") {
        throw new TypeError("Bivariate rendering callback must be callable");
    }
    controlsView ??= new RasterControlsView();
    cursorValuesView ??= { render() {}, clear() {} };
    if (
        typeof cursorValuesView.render !== "function" ||
        typeof cursorValuesView.clear !== "function"
    ) {
        throw new TypeError("Raster cursor-value view is incomplete");
    }
    const statisticsRequests = new RasterStatisticsRequestQueue(clock);
    /**
     * Queue ordinary reads alongside paired reads for this viewer.
     * @param {Object} item Catalog raster to analyze.
     * @param {Object} area Normalized whole, bounds, or polygon selection sampling area.
     * @param {AbortSignal} signal Controller-owned cancellation signal.
     * @return {Promise<Object>} Statistics or the final read/abort failure.
     */
    function loadQueuedStatistics(item, area, signal) {
        return statisticsRequests.run(() => loadStatistics(item, area, signal), signal);
    }
    ensureRasterSampleWindowPane(leafletMap);
    const ownsMapLayerController = mapLayerController === null;
    const mapLayers = mapLayerController ?? new MapLayerController({
        leafletMap,
        view: layerStackView ?? new MapLayerStackView(),
        onLayersChange,
    });
    let analysisRasterSession = null;
    let activeLayerKey = null;
    let rasterStyle = { ...DEFAULT_RASTER_STYLE };
    let activePaletteName = DEFAULT_RASTER_PALETTE_NAME;
    let editingLayerKey = null;
    let followsVisibleLayers = false;
    let visibleHistogramSignature = null;
    let clearing = false;
    let mapDragging = false;
    let pixelPickerEnabled = true;
    let pointerInspectionEnabled = true;
    let rasterCursorPosition = null;
    let rasterStyleCommitTimeout = null;
    let rasterSampleWindowResizeTimeout = null;
    let rasterStyleWasEdited = false;
    let rasterStatistics = null;
    let rasterStatisticsIsApplicable = false;
    let wholeRasterStatistics = null;
    let wholeRasterStatisticsState = "idle";
    let wholeRasterStatisticsError = null;
    let selectedRasterBounds = null;
    let selectedCatalogSelection = null;
    let selectedRasterCenter = null;
    let selectedRasterWindowSizeKm = null;
    let activeRasterItem = null;
    let selectedRasterStatistics = null;
    let selectedRasterStatisticsState = "idle";
    let selectedRasterStatisticsError = null;
    const bivariateMode = new BivariateRasterMode();
    let bivariateCandidates = [];
    let bivariateStatistics = null;
    let pairedHistogramState = "idle";
    let bivariateSelectedBounds = null;
    let bivariateCatalogSelection = null;
    let vectorSelection = null;
    let invalidVectorSamplingId = null;
    let bivariateSelectedCenter = null;
    let bivariateSelectedWindowSizeKm = null;

    /**
     * Return whether shared controls own a renderer-independent session.
     *
     * @return {boolean} Whether analysis-only controls are active.
     */
    function isActiveAnalysisRaster() {
        return analysisRasterSession !== null &&
            activeLayerKey === analysisRasterSession.key;
    }

    /**
     * Return the active non-WMS session, if one owns the shared controls.
     *
     * @return {Object|null} Analysis-only session.
     */
    function activeDetachedRasterSession() {
        return isActiveAnalysisRaster() ? analysisRasterSession : null;
    }

    /**
     * Create retained interaction state for one successfully published layer.
     *
     * @param {Object} entry Pure stack entry.
     * @param {Object} publishedRaster GeoServer publication response.
     * @return {Object} Per-layer state restored on activation.
     */
    function createLayerSession(entry, publishedRaster) {
        return {
            key: entry.key,
            item: entry.item,
            label: entry.label,
            publishedRaster,
            rasterStyle: { ...DEFAULT_RASTER_STYLE },
            paletteName: DEFAULT_RASTER_PALETTE_NAME,
            rasterStyleWasEdited: false,
            rasterStatistics: null,
            rasterStatisticsIsApplicable: false,
            wholeRasterStatistics: null,
            wholeRasterStatisticsState: "idle",
            wholeRasterStatisticsError: null,
            selectedRasterBounds: null,
            selectedCatalogSelection: initialPolygonSamplingArea(),
            selectedRasterCenter: null,
            selectedRasterWindowSizeKm: null,
            selectedRasterStatistics: null,
            selectedRasterStatisticsState: "idle",
            selectedRasterStatisticsError: null,
            layerHistogramController: null,
            layer: null,
            error: null,
        };
    }

    /**
     * Create renderer-independent interaction state for one Catalog raster.
     *
     * The session is deliberately not inserted into the map-layer stack. It
     * gives point-value and statistics analysis an owner while the selected raster
     * has no WMS presentation.
     *
     * @param {Object} item Selected Catalog raster Item.
     * @return {Object} Analysis-only interaction state.
     */
    function createAnalysisSession(item) {
        return {
            key: `analysis:${getCatalogItemKey(item)}`,
            item,
            label: getCatalogRasterBasename(item),
            rasterStyle: { ...DEFAULT_RASTER_STYLE },
            paletteName: DEFAULT_RASTER_PALETTE_NAME,
            rasterStyleWasEdited: false,
            rasterStatistics: null,
            rasterStatisticsIsApplicable: false,
            wholeRasterStatistics: null,
            wholeRasterStatisticsState: "idle",
            wholeRasterStatisticsError: null,
            selectedRasterBounds: null,
            selectedCatalogSelection: initialPolygonSamplingArea(),
            selectedRasterCenter: null,
            selectedRasterWindowSizeKm: null,
            selectedRasterStatistics: null,
            selectedRasterStatisticsState: "idle",
            selectedRasterStatisticsError: null,
        };
    }

    /**
     * Copy renderer-neutral controls and analysis state between sessions.
     *
     * @param {Object} target Newly established renderer session.
     * @param {Object} source Existing analysis-only session for the same Item.
     * @param {boolean} [includeAppearance=true] Whether style and palette state
     * can transfer to the target renderer.
     * @return {void}
     */
    function copyRasterInteractionState(
        target,
        source,
        includeAppearance = true
    ) {
        Object.assign(target, {
            rasterStatistics: source.rasterStatistics,
            rasterStatisticsIsApplicable:
                source.rasterStatisticsIsApplicable,
            wholeRasterStatistics: source.wholeRasterStatistics,
            wholeRasterStatisticsState: source.wholeRasterStatisticsState,
            wholeRasterStatisticsError: source.wholeRasterStatisticsError,
            selectedRasterBounds: source.selectedRasterBounds,
            selectedCatalogSelection: source.selectedCatalogSelection,
            selectedRasterCenter: source.selectedRasterCenter,
            selectedRasterWindowSizeKm: source.selectedRasterWindowSizeKm,
            selectedRasterStatistics: source.selectedRasterStatistics,
            selectedRasterStatisticsState: source.selectedRasterStatisticsState,
            selectedRasterStatisticsError: source.selectedRasterStatisticsError,
        });
        if (includeAppearance) {
            Object.assign(target, {
                rasterStyle: { ...source.rasterStyle },
                paletteName: source.paletteName,
                rasterStyleWasEdited: source.rasterStyleWasEdited,
            });
        }
    }

    /**
     * Detach renderer-neutral state from a renderer session.
     *
     * @param {Object} source Active WMS session.
     * @return {Object} Analysis-only session with the same area and controls.
     */
    function detachAnalysisSession(source) {
        const session = createAnalysisSession(source.item);
        copyRasterInteractionState(session, source);
        return session;
    }

    /**
     * Return analysis-only state when it belongs to one Catalog raster.
     *
     * @param {Object} item Candidate Catalog raster Item.
     * @return {Object|null} Matching analysis session or null.
     */
    function matchingAnalysisSession(item) {
        const expectedKey = `analysis:${getCatalogItemKey(item)}`;
        return analysisRasterSession?.key === expectedKey
            ? analysisRasterSession
            : null;
    }

    /**
     * Return the renderer or detached session for one catalog candidate.
     *
     * Rendering state is consulted only for the candidate's current style; it
     * never determines whether paired analysis is available.
     *
     * @param {string} key Catalog-owned collection and Item identity.
     * @return {Object|null} Current raster session or null.
     */
    function getBivariateCandidateSession(key) {
        const retainedSession = mapLayers.getRecord(key)?.state ?? null;
        if (retainedSession !== null) {
            return retainedSession;
        }
        const session = analysisRasterSession;
        if (
            session !== null &&
            (getCatalogItemKey(session.item) === key || session.key === key)
        ) {
            return session;
        }
        return null;
    }

    /**
     * Return whether one unedited candidate still has placeholder thresholds.
     *
     * @param {Object} style Candidate ordinary raster style.
     * @param {boolean} wasEdited Whether the user changed its appearance.
     * @return {boolean} Whether paired ranges may replace the placeholder.
     */
    function hasDefaultRasterRange(style, wasEdited) {
        return !wasEdited &&
            style.minimum === DEFAULT_RASTER_STYLE.minimum &&
            style.midpoint === DEFAULT_RASTER_STYLE.midpoint &&
            style.maximum === DEFAULT_RASTER_STYLE.maximum;
    }

    /**
     * Preserve the latest renderer-neutral state for one paired candidate.
     *
     * @param {Object} session Raster interaction session to snapshot.
     * @return {void}
     */
    function syncBivariateCandidate(session) {
        const key = getCatalogItemKey(session.item);
        const candidate = bivariateCandidates.find(
            /**
             * Match a paired candidate by catalog or renderer-session identity.
             * @param {Object} current Candidate with a stable key.
             * @return {boolean} Whether it belongs to the session being saved.
             */
            (current) => current.key === key || current.key === session.key
        );
        if (candidate === undefined) {
            return;
        }
        candidate.item = session.item;
        candidate.label = getCatalogRasterBasename(session.item);
        const sessionRangeResolved = !hasDefaultRasterRange(
            session.rasterStyle,
            session.rasterStyleWasEdited
        );
        if (
            sessionRangeResolved ||
            candidate.rasterRangeResolved !== true
        ) {
            candidate.rasterStyle = { ...session.rasterStyle };
            candidate.rasterRangeResolved = sessionRangeResolved;
        }
    }

    /**
     * Add one catalog-selected raster to the ordered analysis pair.
     *
     * The two most recently selected distinct catalog rasters are retained in
     * top-first X/Y order. WMS publication, map visibility, and renderer type
     * are deliberately absent from this contract. Once syncVisibleLayers opts
     * into visible-layer analysis, this function does nothing; stack order and
     * visibility determine the candidates instead.
     *
     * @param {Object} item Selected Catalog raster Item.
     * @return {void}
     */
    function rememberBivariateCandidate(item) {
        if (followsVisibleLayers) return;
        const key = getCatalogItemKey(item);
        const existing = bivariateCandidates.find(
            /**
             * Locate prior paired-analysis state for this catalog selection.
             * @param {Object} candidate Previously remembered candidate.
             * @return {boolean} Whether its key matches the selected Item.
             */
            (candidate) => candidate.key === key
        );
        const liveSession = getBivariateCandidateSession(key);
        const liveSessionRangeResolved = liveSession !== null &&
            !hasDefaultRasterRange(
                liveSession.rasterStyle,
                liveSession.rasterStyleWasEdited
            );
        const preserveExistingRange =
            existing?.rasterRangeResolved === true &&
            !liveSessionRangeResolved;
        const styleSource = preserveExistingRange
            ? existing
            : liveSession ?? existing;
        const candidate = {
            key,
            item,
            label: getCatalogRasterBasename(item),
            rasterStyle: {
                ...(styleSource?.rasterStyle ?? DEFAULT_RASTER_STYLE),
            },
            rasterRangeResolved:
                preserveExistingRange || liveSessionRangeResolved,
        };
        bivariateCandidates = [
            candidate,
            ...bivariateCandidates.filter(
                /**
                 * Keep other candidates after moving this Item to the front.
                 * @param {Object} current Previously remembered candidate.
                 * @return {boolean} Whether its key differs from this Item.
                 */
                (current) => current.key !== key
            ),
        ].slice(0, 2);
        renderBivariateAvailability();
    }

    /**
     * Require the retained session paired with one stack entry.
     *
     * @param {string} key Stable retained layer key.
     * @return {Object} Matching per-layer interaction state.
     * @throws {Error} If stack and session state have diverged.
     */
    function requireLayerSession(key) {
        const session = mapLayers.getRecord(key)?.state ?? null;
        if (session === null) {
            throw new Error(`Raster layer session is missing: ${key}`);
        }
        return session;
    }

    /**
     * Persist the shared active-control state into its retained session.
     *
     * @return {void}
     */
    function saveActiveLayerSession() {
        if (activeLayerKey === null) {
            return;
        }
        const session = activeDetachedRasterSession() ??
            requireLayerSession(activeLayerKey);
        Object.assign(session, {
            rasterStyle: { ...rasterStyle },
            paletteName: activePaletteName,
            rasterStyleWasEdited,
            rasterStatistics,
            rasterStatisticsIsApplicable,
            wholeRasterStatistics,
            wholeRasterStatisticsState,
            wholeRasterStatisticsError,
            selectedRasterBounds,
            selectedCatalogSelection,
            selectedRasterCenter,
            selectedRasterWindowSizeKm,
            selectedRasterStatistics,
            selectedRasterStatisticsState,
            selectedRasterStatisticsError,
        });
        syncBivariateCandidate(session);
        refreshStyle();
        publishHistogramPresentation();
    }

    /**
     * Load one retained session into the shared active-control state.
     *
     * @param {Object} session Retained per-layer interaction state.
     * @return {void}
     */
    function loadActiveLayerSession(session) {
        activeLayerKey = session.key;
        activeRasterItem = session.item;
        rasterStyle = { ...session.rasterStyle };
        activePaletteName = session.paletteName;
        rasterStyleWasEdited = session.rasterStyleWasEdited;
        rasterStatistics = session.rasterStatistics;
        rasterStatisticsIsApplicable = session.rasterStatisticsIsApplicable;
        wholeRasterStatistics = session.wholeRasterStatistics;
        wholeRasterStatisticsState = session.wholeRasterStatisticsState;
        wholeRasterStatisticsError = session.wholeRasterStatisticsError;
        selectedRasterBounds = session.selectedRasterBounds;
        selectedCatalogSelection = session.selectedCatalogSelection;
        selectedRasterCenter = session.selectedRasterCenter;
        selectedRasterWindowSizeKm = session.selectedRasterWindowSizeKm;
        selectedRasterStatistics = session.selectedRasterStatistics;
        selectedRasterStatisticsState = session.selectedRasterStatisticsState;
        selectedRasterStatisticsError = session.selectedRasterStatisticsError;
    }

    /**
     * Create one Leaflet WMS layer from a successful publication response.
     *
     * @param {{bbox: number[], layerName: string}} publishedRaster Published
     * GeoServer layer details.
     * @param {Object} style Retained style for this layer.
     * @param {() => void} reportTileError Owned tile-error callback.
     * @return {Object} Leaflet-compatible WMS layer.
     */
    function createRasterLayer(publishedRaster, style, reportTileError) {
        return createRasterWmsLayer(
            leaflet,
            wmsUrl,
            publishedRaster,
            buildRasterStyleEnvironment(style),
            reportTileError
        );
    }

    /**
     * Create one passive preview or committed sample-window rectangle.
     *
     * @param {Array} bounds Leaflet rectangle bounds.
     * @param {"preview"|"selection"} layerKind Rectangle purpose.
     * @return {Object} Leaflet-compatible rectangle layer.
     */
    function createSampleWindowLayer(bounds, layerKind) {
        return createRasterSampleWindowLayer(leaflet, bounds, layerKind);
    }

    const pointSamplesController = new RasterPointSamplesController(
        samplePixel,
        renderRasterPointSamples
    );
    const cursorSamplesController = new RasterCursorSamplesController(
        sampleCursorPixel,
        renderRasterCursorSamples,
        clock
    );
    const rasterSampleWindowController = new RasterSampleWindowController(
        leafletMap,
        createSampleWindowLayer,
        selectRasterSampleWindow,
        renderRasterSampleWindowGuidance
    );
    const rasterStatisticsController = new RasterStatisticsController(
        loadQueuedStatistics,
        /**
         * Present the start of the active raster's request in its correct scope.
         *
         * @param {Object} _ Requested Catalog Item; active state owns its identity.
         * @param {Object} samplingArea Normalized whole-raster, bounds, or polygon selection area.
         * @return {void}
         */
        (_, samplingArea) => {
            resetPendingRasterStatisticsState();
            if (samplingArea.kind === "wholeRaster") {
                renderWholeRasterStatisticsLoading();
            } else {
                renderSelectedRasterStatisticsLoading();
            }
            renderLayerHistogramSummaries();
        },
        /**
         * Route current active-raster statistics to the whole or selected view.
         *
         * @param {Object} statistics Validated statistics response.
         * @param {Object} _ Requested Catalog Item; active state owns its identity.
         * @param {Object} samplingArea Normalized area used for this response.
         * @return {void}
         */
        (statistics, _, samplingArea) => {
            if (samplingArea.kind === "wholeRaster") {
                renderWholeRasterStatistics(statistics);
            } else {
                renderSelectedRasterStatistics(statistics);
            }
            renderLayerHistogramSummaries();
        },
        /**
         * Present an active-raster failure in the matching histogram scope.
         *
         * @param {Error} error Current non-abort statistics failure.
         * @param {Object} _ Requested Catalog Item; active state owns its identity.
         * @param {Object} samplingArea Normalized area of the failed request.
         * @return {void}
         */
        (error, _, samplingArea) => {
            if (samplingArea.kind === "wholeRaster") {
                renderWholeRasterStatisticsError(error);
            } else {
                renderSelectedRasterStatisticsError(error);
            }
            renderLayerHistogramSummaries();
        }
    );
    const pairedStatisticsController = new RasterStatisticsController(
        /**
         * Adapt the controller's ordered pair to the paired-statistics API.
         *
         * @param {{xItem:Object,yItem:Object}} pair Catalog Items in X/Y order.
         * @param {Object} samplingArea Normalized whole-overlap or bounds area.
         * @param {AbortSignal} signal Cancellation signal for superseded work.
         * @return {Promise<Object>} Validated paired statistics; rejects on failure.
         */
        (pair, samplingArea, signal) => statisticsRequests.run(() => loadPairedStatistics(
            pair.xItem,
            pair.yItem,
            samplingArea,
            signal
        ), signal),
        /**
         * Announce a new paired request; target, area, and context are unused.
         *
         * @return {void}
         */
        () => {
            bivariateStatistics = null;
            pairedHistogramState = "loading";
            publishHistogramPresentation();
            updateBivariatePercentileValues();
            controlsView.setPairedStatisticsLoading?.(
                "Calculating the 2D histogram..."
            );
        },
        /**
         * Retain paired statistics and resolve still-automatic axis ranges.
         * Ignores the response if 2D mode or its pair is no longer available.
         *
         * @param {Object} statistics Validated paired histogram with X/Y bin edges.
         * @return {void}
         */
        (statistics) => {
            if (!bivariateMode.active) return;
            bivariateStatistics = statistics;
            pairedHistogramState = "ready";
            const candidates = getBivariatePairCandidates();
            if (candidates === null) return;
            let rasterRangesChanged = false;
            for (const [candidate, edges] of [
                [candidates.xCandidate, statistics.histogram.xEdges],
                [candidates.yCandidate, statistics.histogram.yEdges],
            ]) {
                const style = candidate.rasterStyle;
                if (candidate.rasterRangeResolved !== true) {
                    candidate.rasterStyle = {
                        ...style,
                        minimum: edges[0],
                        midpoint: edges[Math.floor(edges.length / 2)],
                        maximum: edges.at(-1),
                    };
                    candidate.rasterRangeResolved = true;
                    rasterRangesChanged = true;
                }
            }
            if (rasterRangesChanged) {
                applyBivariatePresentation();
            } else {
                controlsView.renderPairedStatistics?.(
                    statistics,
                    getBivariatePresentation()
                );
            }
            updateBivariatePercentileValues();
            renderLayerStack();
        },
        /**
         * Show a current paired request failure and its retry availability.
         *
         * @param {Error} error Non-abort paired-statistics failure.
         * @return {void}
         */
        (error) => {
            if (!bivariateMode.active) return;
            bivariateStatistics = null;
            pairedHistogramState = "error";
            publishHistogramPresentation();
            updateBivariatePercentileValues();
            controlsView.renderPairedStatisticsError?.(
                error,
                canRetryRasterStatistics(error)
            );
        },
        normalizeRasterPairedSamplingArea
    );

    /**
     * Return the statistics state associated with a retained session's current
     * sampling area.
     *
     * @param {Object} session Raster-owned retained interaction state.
     * @return {{state:string,statistics:Object|null,scope:string}} Compact
     * presentation state for the raster-analysis summary view.
     */
    function getLayerHistogramPresentation(session) {
        if (session.selectedCatalogSelection !== null) {
            return {
                state: session.selectedRasterStatisticsState,
                statistics: session.selectedRasterStatistics,
                scope: `Vector selection · ${session.selectedCatalogSelection.filename}`,
            };
        }
        if (session.selectedRasterBounds !== null) {
            return {
                state: session.selectedRasterStatisticsState,
                statistics: session.selectedRasterStatistics,
                scope: session.selectedRasterWindowSizeKm === null
                    ? "Map sample"
                    : `${session.selectedRasterWindowSizeKm} km map sample`,
            };
        }
        return {
            state: session.wholeRasterStatisticsState,
            statistics: session.wholeRasterStatistics,
            scope: "Whole raster",
        };
    }

    /**
     * Build one presentation-ready histogram summary for a retained raster.
     *
     * @param {Object} session Raster-owned retained interaction state.
     * @return {{key:string,label:string,state:string,scope:string,
     * counts:number[]|null,automatic:boolean,valueLabel:string,
     * statistics:Object|null,style:Object,
     * canRetry:boolean,errorMessage:string}} Histogram view model with cached
     * counts, ready-only statistics, coloring, failure reason, and retry state.
     */
    function buildLayerHistogramSummary(session) {
        const presentation = getLayerHistogramPresentation(session);
        const counts = presentation.statistics?.histogram?.counts;
        const error = session.selectedCatalogSelection !== null || session.selectedRasterBounds !== null
            ? session.selectedRasterStatisticsError : session.wholeRasterStatisticsError;
        return {
            key: session.key,
            label: session.label,
            state: presentation.state,
            scope: presentation.scope,
            counts: Array.isArray(counts) && (!followsVisibleLayers || presentation.state === "ready")
                ? [...counts] : null,
            automatic: followsVisibleLayers,
            valueLabel: getHistogramValueLabel(session.item),
            statistics: presentation.state === "ready" ? presentation.statistics : null,
            style: session.rasterStyle,
            errorMessage: presentation.state === "error" ? error?.message ?? "" : "",
            canRetry: presentation.state === "error" && canRetryRasterStatistics(error),
        };
    }

    /**
     * Return all visible raster records in top-first map order.
     *
     * Hidden layers and non-raster adapters are excluded.
     *
     * @return {Object[]} Retained records with entry, state, and adapter
     * fields; empty when no raster is visible.
     */
    function allVisibleRasterRecords() {
        const records = mapLayers.retainedRecords.filter(
            /**
             * Exclude hidden layers and layers owned by another renderer.
             * @param {{adapter:Object,entry:Object}} record Retained layer record.
             * @return {boolean} Whether this is a visible WMS raster.
             */
            ({ adapter, entry }) => adapter === rasterMapLayerAdapter && entry.visible
        );
        return records;
    }

    /**
     * Return whether authoritative published bounds contain one map position.
     *
     * @param {number[]} bbox Published WGS 84 west/south/east/north bounds.
     * @param {{longitude:number,latitude:number}} position Canonical point.
     * @return {boolean} Whether the point lies inside or on the bounds.
     */
    function publishedBoundsContainPosition(bbox, position) {
        if (
            !Array.isArray(bbox) ||
            bbox.length !== 4 ||
            !bbox.every(Number.isFinite)
        ) {
            return false;
        }
        const [west, south, east, north] = bbox;
        return west <= position.longitude && position.longitude <= east &&
            south <= position.latitude && position.latitude <= north;
    }

    /**
     * Build visible cursor participants in top-first map order.
     * The pixel API determines coverage from the actual raster grid.
     * @return {Object[]} Catalog identities and concise filename stems.
     */
    function rasterCursorSampleParticipants() {
        return allVisibleRasterRecords()
            .map(({ entry }) => ({
                key: entry.key,
                label: getCatalogRasterStem(entry.item),
                item: entry.item,
            }));
    }

    /**
     * Return the bounded top-two raster-analysis inputs in map order.
     *
     * Rendering remains independent: visible rasters below this pair stay on
     * the map but never enter automatic histogram or bivariate requests.
     *
     * @return {Object[]} Zero, one, or two visible raster records.
     */
    function visibleRasterRecords() {
        return allVisibleRasterRecords().slice(0, 2);
    }

    /**
     * Build the bounded Catalog participants for exact click-value analysis.
     *
     * Visible-layer mode reuses the top-two histogram order. Detached Catalog
     * analysis uses its active raster without consulting rendering state. In
     * 2D mode the current axis assignment, including a swap, defines order and
     * badges without changing the Catalog identities passed to analysis.
     *
     * @return {Object[]} Zero, one, or two point-sample participants.
     */
    function rasterPointSampleParticipants() {
        if (bivariateMode.active) {
            const candidates = getBivariatePairCandidates();
            if (candidates === null) {
                return [];
            }
            return [
                { ...candidates.xCandidate, axis: "X" },
                { ...candidates.yCandidate, axis: "Y" },
            ];
        }
        if (followsVisibleLayers) {
            return visibleRasterRecords().map(({ entry }) => ({
                key: entry.key,
                label: entry.label,
                item: entry.item,
                axis: null,
            }));
        }
        if (activeRasterItem === null || activeLayerKey === null) {
            return [];
        }
        return [{
            key: activeLayerKey,
            label: getCatalogRasterBasename(activeRasterItem),
            item: activeRasterItem,
            axis: null,
        }];
    }

    /**
     * Decide whether a click should open the histogram using published extents.
     * This presentation decision does not restrict backend pixel requests.
     *
     * @param {Object[]} participants Current bounded click participants.
     * @param {{longitude:number,latitude:number}} position Canonical point.
     * @return {boolean} Whether any published extent covers the point, or a
     * participant has no retained renderer.
     */
    function shouldOpenRasterHistogram(participants, position) {
        return participants.some(({ key }) => {
            const record = mapLayers.getRecord(key);
            return record === null || publishedBoundsContainPosition(
                record.state.publishedRaster.bbox,
                position
            );
        });
    }

    /**
     * Move an active 2D analysis to the newly derived top-two raster pair.
     *
     * The current axis orientation and bounded sample are preserved. Pending
     * work for the old pair is canceled before its ordinary presentation is
     * restored, so stale responses cannot repaint the new pair.
     *
     * @param {Object[]} previousCandidates Previous top-two candidates.
     * @return {void}
     */
    function migrateBivariatePair(previousCandidates) {
        const previousKeys = [bivariateMode.xKey, bivariateMode.yKey];
        const axesWereSwapped = previousCandidates.length === 2 &&
            bivariateMode.xKey === previousCandidates[1].key &&
            bivariateMode.yKey === previousCandidates[0].key;
        pairedStatisticsController.clear();
        pointSamplesController.clear();
        bivariateStatistics = null;
        controlsView.clearPairedStatistics?.();
        restoreOrdinaryRasterPresentation(previousKeys);
        bivariateMode.enter(bivariateCandidates.map(
            /** @param {Object} candidate Newly derived analysis candidate. */
            (candidate) => candidate.key
        ));
        onBivariateRenderingChange([
            bivariateMode.xKey,
            bivariateMode.yKey,
        ]);
        if (axesWereSwapped) bivariateMode.swap();
        applyBivariatePresentation();
        requestBivariateStatistics();
    }

    /**
     * Application policy: histograms follow visible map rasters. Catalog-only
     * analysis remains available to other callers of this reusable viewer.
     * Activates the top raster and starts missing statistics only for the
     * bounded top-two analysis pair. While 2D mode is active, pair membership
     * migrates with visibility and order. Does nothing during clear(). Never
     * call this to choose a style target.
     *
     * @return {void}
     */
    function syncVisibleLayers() {
        if (clearing) return;
        followsVisibleLayers = true;
        const records = visibleRasterRecords();
        if (rasterCursorPosition !== null) {
            cursorSamplesController.synchronize(
                rasterCursorSampleParticipants()
            );
        }
        const analyzedKeys = new Set(records.map(({ entry }) => entry.key));
        for (const record of mapLayers.retainedRecords) {
            if (
                record.adapter === rasterMapLayerAdapter &&
                !analyzedKeys.has(record.entry.key)
            ) cancelLayerHistogramRequest(record.state);
        }
        const signature = JSON.stringify(records.map(
            /**
             * Extract identity while preserving top-first histogram order.
             * @param {{entry:Object}} record Visible raster record.
             * @return {string} Stable retained raster key.
             */
            ({ entry }) => entry.key
        ));
        const primaryKey = records[0]?.entry.key ?? null;
        const primaryIsRetained = mapLayers.getRecord(primaryKey) !== null;
        if (signature === visibleHistogramSignature && activeLayerKey === primaryKey &&
            (!primaryIsRetained || mapLayers.activeKey === primaryKey)) {
            renderLayerHistogramSummaries();
            refreshStyle();
            return;
        }
        visibleHistogramSignature = signature;
        const previousCandidates = bivariateCandidates;
        const pairChanged = bivariateMode.active && (
            records.length !== 2 ||
            records.some(
                /**
                 * Detect a visible raster outside the current 2D pair.
                 * @param {{entry:Object}} record Visible raster record.
                 * @return {boolean} Whether pair membership must be reset.
                 */
                ({ entry }) => !bivariateMode.contains(entry.key)
            )
        );
        bivariateCandidates = records.map(
            /**
             * Snapshot a visible raster's identity and ordinary range for 2D use.
             * @param {{entry:Object,state:Object}} record Visible raster and state.
             * @return {Object} Candidate with key, Item, label, copied style, and
             * a rasterRangeResolved flag indicating a non-placeholder range.
             */
            ({ entry, state }) => ({
                key: entry.key, item: entry.item, label: entry.label,
                rasterStyle: { ...state.rasterStyle },
                rasterRangeResolved: !hasDefaultRasterRange(
                    state.rasterStyle, state.rasterStyleWasEdited
                ),
            })
        );
        let migratedPair = false;
        if (bivariateMode.active && records.length !== 2) {
            leaveBivariateMode(
                "Show at least two raster layers to resume 2D analysis.",
                false
            );
        } else if (pairChanged) {
            migrateBivariatePair(previousCandidates);
            migratedPair = true;
        }
        if (primaryKey !== activeLayerKey ||
            (primaryIsRetained && mapLayers.activeKey !== primaryKey)) {
            deactivateActiveLayer();
            analysisRasterSession = null;
            if (primaryIsRetained) mapLayers.activate(primaryKey);
            else {
                controlsView.setControlsVisible(false);
                controlsView.clearStatistics();
            }
        }
        if (!bivariateMode.active) {
            for (const { entry, state } of records.slice(1)) {
                if (getLayerHistogramPresentation(state).state === "idle") {
                    const area = currentRasterSamplingArea();
                    setSessionSamplingArea(state, area);
                    void requireLayerHistogramController(state).activate(entry.item, area);
                }
            }
        }
        renderLayerHistogramSummaries();
        pointSamplesController.synchronize(rasterPointSampleParticipants());
        renderBivariateAvailability();
        refreshStyle();
        if (migratedPair) renderLayerStack();
    }

    /**
     * Render histogram summaries for visible rasters in automatic mode, or
     * all retained rasters otherwise, with the current analysis key marked.
     *
     * @return {void}
     */
    function renderLayerHistogramSummaries() {
        const summaries = (followsVisibleLayers
            ? visibleRasterRecords() : mapLayers.retainedRecords)
            .filter(
                /**
                 * Keep only records owned by the raster analysis adapter.
                 * @param {{adapter:Object}} record Candidate retained layer.
                 * @return {boolean} Whether this viewer owns the record.
                 */
                ({ adapter }) => adapter === rasterMapLayerAdapter
            )
            .map(
                /**
                 * Convert retained interaction state to histogram presentation.
                 * @param {{state:Object}} record Raster record with session state.
                 * @return {Object} Histogram summary from buildLayerHistogramSummary.
                 */
                ({ state }) => buildLayerHistogramSummary(state)
            );
        const activeRetainedKey = summaries.some(
            /**
             * Check whether active analysis appears among the displayed summaries.
             * @param {{key:string}} summary Histogram view model.
             * @return {boolean} Whether this summary owns active analysis.
             */
            ({ key }) => key === activeLayerKey
        )
            ? activeLayerKey
            : null;
        controlsView.renderLayerHistograms(summaries, activeRetainedKey);
        publishHistogramPresentation();
    }

    /** Publish display-only status for the current histogram targets and area.
     * Uses the same owned sessions as the charts; no additional reads or timers.
     * @return {void}
     */
    function publishHistogramPresentation() {
        const detached = activeDetachedRasterSession();
        const sessions = detached ? [detached] : followsVisibleLayers
            ? visibleRasterRecords().map(record => record.state)
            : activeLayerKey === null ? [] : [mapLayers.getRecord(activeLayerKey)?.state].filter(Boolean);
        if (sessions.length === 0) { onHistogramChange(null); return; }
        const presentations = sessions.map(getLayerHistogramPresentation);
        const states = bivariateMode.active ? [pairedHistogramState] : presentations.map(item => item.state);
        const loading = states.some(state => state === "loading" || state === "idle");
        const failures = states.filter(state => state === "error").length;
        const state = loading ? "loading" : failures ? "error" : "ready";
        const selection = bivariateMode.active ? bivariateCatalogSelection : selectedCatalogSelection;
        const scope = bivariateMode.active
            ? selection ? `Vector selection · ${selection.filename}` : bivariateSelectedBounds ? "Map box · 2D comparison" : "Whole overlap · 2D comparison"
            : presentations[0].scope;
        const visibleCount = followsVisibleLayers ? allVisibleRasterRecords().length : sessions.length;
        const participation = visibleCount > sessions.length
            ? `Top ${sessions.length} of ${visibleCount} visible rasters`
            : `${sessions.length} raster layer${sessions.length === 1 ? "" : "s"}`;
        const progress = loading ? "Updating for this selection…" : failures
            ? "Some histograms unavailable — see details" : "Ready";
        onHistogramChange(Object.freeze({state, message: `${participation} · ${scope} · ${progress}`}));
    }

    /**
     * Apply one shared user-selected sampling area to an inactive raster
     * session before its independent statistics request starts.
     *
     * @param {Object} session Inactive retained raster session.
     * @param {Readonly<Object>} samplingArea Validated sampling-area union.
     * @return {void}
     */
    function setSessionSamplingArea(session, samplingArea) {
        if (samplingArea.kind === "wholeRaster") {
            session.selectedRasterBounds = null;
            session.selectedCatalogSelection = null;
            session.selectedRasterCenter = null;
            session.selectedRasterWindowSizeKm = null;
            session.selectedRasterStatistics = null;
            session.selectedRasterStatisticsState = "idle";
            session.selectedRasterStatisticsError = null;
            return;
        }
        session.selectedRasterBounds = samplingArea.kind === "selectedArea"
            ? samplingArea.selectedBounds
            : null;
        session.selectedCatalogSelection = samplingArea.kind === "catalogSelection"
            ? selectedCatalogSelection
            : null;
        session.selectedRasterCenter = samplingArea.kind === "selectedArea"
            ? selectedRasterCenter
            : null;
        session.selectedRasterWindowSizeKm = samplingArea.kind === "selectedArea"
            ? selectedRasterWindowSizeKm
            : null;
        session.selectedRasterStatistics = null;
        session.selectedRasterStatisticsState = "idle";
        session.selectedRasterStatisticsError = null;
        session.rasterStatisticsIsApplicable = false;
    }

    /**
     * Store an inactive retained session's successful statistics response.
     *
     * @param {Object} session Retained raster session.
     * @param {Object} statistics Validated statistics response.
     * @param {Readonly<Object>} samplingArea Request sampling area.
     * @return {void}
     */
    function storeLayerHistogramResult(session, statistics, samplingArea) {
        if (samplingArea.kind === "wholeRaster") {
            session.wholeRasterStatistics = statistics;
            session.wholeRasterStatisticsState = "ready";
            session.wholeRasterStatisticsError = null;
        } else {
            session.selectedRasterStatistics = statistics;
            session.selectedRasterStatisticsState = "ready";
            session.selectedRasterStatisticsError = null;
        }
        session.rasterStatistics = statistics;
        session.rasterStatisticsIsApplicable = true;
        if (samplingArea.kind === "wholeRaster") {
            const style = deriveInitialRasterStyleFromStatistics(
                session.rasterStyle, statistics, session.rasterStyleWasEdited
            );
            if (style !== null) {
                applySessionStyle(session, style, session.paletteName, false);
                if (editingLayerKey === session.key) {
                    controlsView.setStyle(style, session.paletteName);
                }
            }
        }
        renderLayerStack();
        if (editingLayerKey === session.key) refreshStyle();
    }

    /**
     * Store an inactive retained session's independent statistics failure.
     *
     * @param {Object} session Retained raster session.
     * @param {Error} error Current non-abort request failure.
     * @param {Readonly<Object>} samplingArea Request sampling area.
     * @return {void}
     */
    function storeLayerHistogramError(session, error, samplingArea) {
        if (samplingArea.kind === "wholeRaster") {
            session.wholeRasterStatisticsState = "error";
            session.wholeRasterStatisticsError = error;
        } else {
            session.selectedRasterStatisticsState = "error";
            session.selectedRasterStatisticsError = error;
        }
        session.rasterStatisticsIsApplicable = false;
        renderLayerStack();
        if (editingLayerKey === session.key) refreshStyle();
    }

    /**
     * Return a request controller dedicated to one inactive layer summary.
     *
     * @param {Object} session Retained raster session.
     * @return {RasterStatisticsController} Independent stale-safe controller.
     */
    function requireLayerHistogramController(session) {
        session.layerHistogramController ??= new RasterStatisticsController(
            loadQueuedStatistics,
            /**
             * Mark this inactive session's requested scope busy and inapplicable.
             *
             * @param {Object} _ Requested Item; the captured session owns identity.
             * @param {Object} samplingArea Normalized whole-raster, bounds, or polygon selection area.
             * @return {void}
             */
            (_, samplingArea) => {
                if (samplingArea.kind === "wholeRaster") {
                    session.wholeRasterStatisticsState = "loading";
                    session.wholeRasterStatisticsError = null;
                } else {
                    session.selectedRasterStatisticsState = "loading";
                    session.selectedRasterStatisticsError = null;
                }
                session.rasterStatisticsIsApplicable = false;
                renderLayerStack();
                if (editingLayerKey === session.key) refreshStyle();
            },
            /**
             * Store a current response in the captured inactive raster session.
             *
             * @param {Object} statistics Validated statistics response.
             * @param {Object} _ Requested Item; the captured session owns identity.
             * @param {Object} samplingArea Normalized area used for this response.
             * @return {void}
             */
            (statistics, _, samplingArea) => {
                storeLayerHistogramResult(session, statistics, samplingArea);
            },
            /**
             * Store a current failure in the captured inactive raster session.
             *
             * @param {Error} error Non-abort statistics request failure.
             * @param {Object} _ Requested Item; the captured session owns identity.
             * @param {Object} samplingArea Normalized area of the failed request.
             * @return {void}
             */
            (error, _, samplingArea) => {
                storeLayerHistogramError(session, error, samplingArea);
            }
        );
        return session.layerHistogramController;
    }

    /**
     * Cancel a secondary read without leaving an orphaned loading state.
     * @param {Object} session Retained raster interaction state.
     * @return {void}
     */
    function cancelLayerHistogramRequest(session) {
        session.layerHistogramController?.clear();
        if (session.wholeRasterStatisticsState === "loading") session.wholeRasterStatisticsState = "idle";
        if (session.selectedRasterStatisticsState === "loading") session.selectedRasterStatisticsState = "idle";
    }

    /**
     * Refresh inactive retained rasters for one explicit histogram area.
     *
     * The active raster continues through the existing shared controller so
     * detailed status, retries, and percentile applicability remain unchanged.
     * Hidden records are skipped when following visible-layer analysis.
     *
     * @param {Readonly<Object>} samplingArea Validated sampling-area union.
     * @param {boolean} [onlyMissing=false] Resume canceled work without replacing ready results.
     * @return {void}
     */
    function refreshRetainedLayerHistograms(samplingArea, onlyMissing = false) {
        saveActiveLayerSession();
        const analyzedKeys = followsVisibleLayers
            ? new Set(visibleRasterRecords().map(({ entry }) => entry.key))
            : null;
        for (const record of mapLayers.retainedRecords) {
            if (
                record.adapter !== rasterMapLayerAdapter ||
                (analyzedKeys !== null && !analyzedKeys.has(record.entry.key)) ||
                record.entry.key === activeLayerKey
            ) {
                continue;
            }
            const session = record.state;
            if (onlyMissing && getLayerHistogramPresentation(session).state !== "idle") continue;
            setSessionSamplingArea(session, samplingArea);
            void requireLayerHistogramController(session).activate(
                session.item,
                samplingArea
            );
        }
    }

    /**
     * Return the normalized area selected by the parent viewer.
     *
     * @return {Readonly<Object>} Strict whole/bounds/polygon selection sampling-area union.
     */
    function currentRasterSamplingArea() {
        if (selectedCatalogSelection !== null) {
            return normalizeRasterSamplingArea({
                kind: "catalogSelection",
                catalogSelection: selectedCatalogSelection.selection
            });
        }
        if (selectedRasterBounds !== null) {
            return normalizeRasterSamplingArea({
                kind: "selectedArea",
                selectedBounds: selectedRasterBounds
            });
        }
        return WHOLE_RASTER_SAMPLING_AREA;
    }

    /**
     * Snapshot the presented area or a named 1D raster's area without reading results.
     * Whole-raster/overlap sampling deliberately has no clip selection.
     * @param {string|null} [key=null] Optional 1D session key.
     * @param {"presented"|"1d"|"2d"} [mode="presented"] Selection owner.
     * @return {Readonly<Object>|null} Frozen box/polygon selection selection or no explicit area.
     */
    function getSelectedArea(key = null, mode = "presented") {
        if (invalidVectorSamplingId && (bivariateMode.active ? bivariateCatalogSelection : selectedCatalogSelection)?.id === invalidVectorSamplingId) return null;
        if (mode === "2d" || (mode === "presented" && bivariateMode.active)) {
            if (bivariateCatalogSelection) return normalizeRasterSamplingArea({ kind: "catalogSelection", catalogSelection: bivariateCatalogSelection.selection });
            return bivariateSelectedBounds === null ? null : normalizeRasterSamplingArea({
                kind: "selectedArea", selectedBounds: bivariateSelectedBounds,
            });
        }
        const session = key === null || key === activeLayerKey ? {
            selectedCatalogSelection, selectedRasterBounds,
        } : getBivariateCandidateSession(key);
        if (!session) return null;
        if (session.selectedCatalogSelection) return normalizeRasterSamplingArea({
            kind: "catalogSelection", catalogSelection: session.selectedCatalogSelection.selection,
        });
        return session.selectedRasterBounds === null ? null : normalizeRasterSamplingArea({
            kind: "selectedArea", selectedBounds: session.selectedRasterBounds,
        });
    }

    /** Forward a 1D calculation intent. @param {string} key Source key. @return {void} */
    function calculateHistogram(key) {
        const session = key === activeLayerKey ? { item: activeRasterItem } : getBivariateCandidateSession(key);
        if (session?.item) onCalculateRequested(session.item, getSelectedArea(key, "1d"));
    }

    /** Forward one paired axis for single-raster calculations. @param {string} axis X/Y. @return {void} */
    function calculatePairedHistogram(axis) {
        const pair = getBivariatePairCandidates();
        if (pair) onCalculateRequested(pair[`${axis}Candidate`].item, getSelectedArea(null, "2d"));
    }

    /** Forward the exact 1D source and area through composition. @param {string} key Histogram session. @return {void} */
    function downloadHistogram(key) {
        const session = key === activeLayerKey ? { item: activeRasterItem } : getBivariateCandidateSession(key);
        if (session?.item) onDownloadRequested(session.item, getSelectedArea(key, "1d"));
    }

    /** Forward the selected X/Y source with the 2D box. @param {"x"|"y"} axis Histogram axis. @return {void} */
    function downloadPairedHistogram(axis) {
        const pair = getBivariatePairCandidates();
        if (pair) onDownloadRequested(pair[`${axis}Candidate`].item, getSelectedArea(null, "2d"));
    }

    /**
     * Release a superseded controller request's loading marker.
     *
     * @return {void}
     */
    function resetPendingRasterStatisticsState() {
        if (wholeRasterStatisticsState === "loading") {
            wholeRasterStatisticsState = "idle";
        }
        if (selectedRasterStatisticsState === "loading") {
            selectedRasterStatisticsState = "idle";
        }
    }

    /**
     * Return whether the active raster uses a non-whole sampling area.
     *
     * @return {boolean} Whether bounds or a catalog selection owns the histogram.
     */
    function hasSelectedRasterSamplingArea() {
        return selectedRasterBounds !== null || selectedCatalogSelection !== null;
    }

    /**
     * Return the active sampling-area discriminator for control presentation.
     *
     * @return {"wholeRaster"|"selectedArea"|"catalogSelection"} Active
     * mode.
     */
    function getRasterSamplingAreaMode() {
        if (selectedCatalogSelection !== null) {
            return "catalogSelection";
        }
        return selectedRasterBounds === null ? "wholeRaster" : "selectedArea";
    }

    /**
     * Return the sampling window presented by the current histogram mode.
     *
     * @return {[Object|null,number|null,Object|null]} Bounds, committed side length,
     * and original WGS 84 click coordinates.
     */
    function getPresentedSampleWindow() {
        return bivariateMode.active
            ? [bivariateSelectedBounds, bivariateSelectedWindowSizeKm, bivariateSelectedCenter]
            : [selectedRasterBounds, selectedRasterWindowSizeKm, selectedRasterCenter];
    }

    /** Preserve an active vector area when adding a raster. @return {Object|null} Initial area. */
    function initialPolygonSamplingArea() {
        const area = bivariateMode.active ? bivariateCatalogSelection : selectedCatalogSelection;
        return area;
    }

    /** Synchronize histogram-area choices with lifecycle state. @return {void} */
    function renderRasterSamplingAreaControls() {
        onSamplingAreaChange(getSelectedArea());
        const samplingMode = getRasterSamplingAreaMode();
        const [presentedBounds, presentedWindowSizeKm] =
            getPresentedSampleWindow();
        controlsView.setClearSampleWindowLabel(
            bivariateMode.active ? "Whole overlap" : "Whole raster"
        );
        const presentedMode = !canUseRasterMapInteractions()
            ? "none"
            : bivariateMode.active
                ? (bivariateCatalogSelection ? "catalogSelection" : presentedBounds === null ? "wholeRaster" : "selectedArea")
                : samplingMode;
        const presentedSelection = bivariateMode.active ? bivariateCatalogSelection : selectedCatalogSelection;
        const samplingLabel = presentedSelection?.id === invalidVectorSamplingId ? "Vector selection changed · choose an area" : presentedMode === "selectedArea"
            ? presentedWindowSizeKm === null
                ? "Map box"
                : `${presentedWindowSizeKm} km × ` +
                  `${presentedWindowSizeKm} km map box`
            : presentedMode === "catalogSelection"
                ? `Vector selection · ${presentedSelection.filename}`
                : presentedMode === "none"
                    ? "No raster selected"
                : bivariateMode.active
                    ? "Whole overlap"
                    : "Whole raster";
        const vectorSelected = presentedSelection && (presentedSelection.id === vectorSelection?.id || presentedSelection.id === invalidVectorSamplingId);
        controlsView.setSamplingAreaMode(vectorSelected ? "vector" : presentedMode, samplingLabel);
    }

    /**
     * Return whether the current analysis target can receive map inputs.
     *
     * Renderer visibility is presentation-only. The basemap remains available
     * for bounds selection and pixel positions with WMS, adaptive detail, or
     * no renderer.
     *
     * @return {boolean} Whether an ordered pair or one raster owns map input.
     */
    function canUseRasterMapInteractions() {
        return bivariateMode.active
            ? getBivariatePairCandidates() !== null
            : activeRasterItem !== null;
    }

    /**
     * Return the two catalog candidates currently assigned to X and Y.
     *
     * @return {{xCandidate:Object,yCandidate:Object}|null} Current pair or
     * null when mode is inactive or its identities are no longer retained.
     */
    function getBivariatePairCandidates() {
        if (!bivariateMode.active) return null;
        const xCandidate = bivariateCandidates.find(
            /**
             * Locate the current X-axis candidate by stable identity.
             * @param {Object} candidate Remembered paired-analysis candidate.
             * @return {boolean} Whether its key owns the X axis.
             */
            (candidate) => candidate.key === bivariateMode.xKey
        );
        const yCandidate = bivariateCandidates.find(
            /**
             * Locate the current Y-axis candidate by stable identity.
             * @param {Object} candidate Remembered paired-analysis candidate.
             * @return {boolean} Whether its key owns the Y axis.
             */
            (candidate) => candidate.key === bivariateMode.yKey
        );
        return xCandidate === undefined || yCandidate === undefined
            ? null
            : { xCandidate, yCandidate };
    }

    /**
     * Build the single presentation contract shared by map, legend, histogram,
     * and exact click values.
     *
     * @return {Object} Current labels, catalog ranges, coordinated styles,
     * palette identity, and Catalog Items.
     * @throws {Error} If either paired candidate is no longer available.
     */
    function getBivariatePresentation() {
        const candidates = getBivariatePairCandidates();
        if (candidates === null) {
            throw new Error("Bivariate raster pair is no longer available.");
        }
        const axisStyles = getBivariateAxisStyles(
            bivariateMode.paletteName,
            { ...candidates.xCandidate.rasterStyle, ...bivariateMode.getRange(bivariateMode.xKey) },
            { ...candidates.yCandidate.rasterStyle, ...bivariateMode.getRange(bivariateMode.yKey) }
        );
        return {
            paletteName: bivariateMode.paletteName,
            xLabel: candidates.xCandidate.label,
            yLabel: candidates.yCandidate.label,
            xStyle: axisStyles.xStyle,
            yStyle: axisStyles.yStyle,
            xItem: candidates.xCandidate.item,
            yItem: candidates.yCandidate.item,
        };
    }

    /**
     * Return the paired request area without accepting catalog selection state.
     *
     * @return {Object} Whole-overlap or selected-bounds paired area.
     */
    function currentBivariateSamplingArea() {
        if (bivariateCatalogSelection) return normalizeRasterSamplingArea({ kind: "catalogSelection", catalogSelection: bivariateCatalogSelection.selection });
        return bivariateSelectedBounds === null
            ? WHOLE_RASTER_OVERLAP_SAMPLING_AREA
            : normalizeRasterSamplingArea({
                kind: "selectedArea",
                selectedBounds: bivariateSelectedBounds,
            });
    }

    /**
     * Present current bivariate eligibility or a transition-specific message.
     *
     * @param {string|null} [message=null] Optional transition guidance.
     * @return {void}
     */
    function renderBivariateAvailability(message = null) {
        const eligible = bivariateCandidates;
        const canEnter = eligible.length === 2;
        const hasSuppressedLayers = mapLayers.visibleCount > 2;
        const extraGuidance = hasSuppressedLayers
            ? " Other visible layers are temporarily hidden in 2D mode."
            : "";
        const guidance = message ?? (
            bivariateMode.active
                ? "2D analyzes the X/Y-badged rasters with coordinated colors " +
                  "and blending at 100% opacity. Reorder Map layers to change " +
                  `the pair.${extraGuidance}`
                : canEnter
                    ? "2D analyzes the top two visible rasters. Reorder Map " +
                      `layers to choose the pair.${extraGuidance}`
                    : "Show at least two single-band raster layers to enable " +
                      "the 2D histogram."
        );
        controlsView.setBivariateAvailability?.(canEnter, guidance);
    }

    /**
     * Apply coordinated axis ramps, 100% opacity, and ESOS-C compositing.
     *
     * @return {void}
     */
    function applyBivariatePresentation() {
        const candidates = getBivariatePairCandidates();
        if (candidates === null) return;
        const presentation = getBivariatePresentation();
        const renderedRecords = [];
        for (const [candidate, style] of [
            [candidates.xCandidate, presentation.xStyle],
            [candidates.yCandidate, presentation.yStyle],
        ]) {
            const record = mapLayers.getRecord(candidate.key);
            const layer = mapLayers.getLeafletLayer(candidate.key);
            if (
                record === null ||
                layer === null ||
                !mapLayers.isAttached(candidate.key)
            ) continue;
            layer.setParams({
                styles: "dynamic-raster",
                env: buildRasterStyleEnvironment(style),
            });
            layer.setOpacity(1);
            setRasterLayerAdditiveBlend(layer, false);
            renderedRecords.push(record);
        }
        const topRecord = renderedRecords.length === 2
            ? mapLayers.retainedRecords.find(
                /**
                 * Find the top attached pair renderer for additive blending.
                 * @param {Object} record Retained record in top-first stack order.
                 * @return {boolean} Whether the attached layer belongs to the pair.
                 */
                (record) => bivariateMode.contains(record.entry.key) &&
                    mapLayers.isAttached(record.entry.key)
            )
            : undefined;
        if (topRecord !== undefined) {
            setRasterLayerAdditiveBlend(
                mapLayers.getLeafletLayer(topRecord.entry.key),
                true
            );
        }
        controlsView.renderBivariateMode?.({
            active: true,
            ...presentation,
        });
        updateBivariatePercentileValues();
        if (bivariateStatistics !== null) {
            controlsView.renderPairedStatistics?.(
                bivariateStatistics,
                presentation
            );
        }
    }

    /**
     * Restore ordinary retained style, opacity, and normal CSS blending.
     *
     * @param {string[]} keys Retained raster keys to restore when available.
     * @return {void}
     */
    function restoreOrdinaryRasterPresentation(keys) {
        for (const key of keys) {
            const record = mapLayers.getRecord(key);
            const layer = mapLayers.getLeafletLayer(key);
            if (record === null || layer === null) continue;
            layer.setParams({
                styles: "dynamic-raster",
                env: buildRasterStyleEnvironment(record.state.rasterStyle),
            });
            layer.setOpacity(record.entry.opacity);
            if (mapLayers.isAttached(key)) {
                setRasterLayerAdditiveBlend(layer, false);
            }
        }
    }

    /**
     * Request paired statistics for the current ordered roles and area.
     *
     * @return {void}
     */
    function requestBivariateStatistics() {
        if (!bivariateMode.active) return;
        const presentation = getBivariatePresentation();
        bivariateStatistics = null;
        controlsView.clearPairedStatistics?.();
        void pairedStatisticsController.activate(
            {
                xItem: presentation.xItem,
                yItem: presentation.yItem,
            },
            currentBivariateSamplingArea()
        );
    }

    /**
     * Enter explicit bivariate mode with the two current catalog candidates.
     *
     * @return {void}
     */
    function enterBivariateMode() {
        const eligible = bivariateCandidates;
        if (eligible.length !== 2) {
            renderBivariateAvailability(
                "The 2D histogram requires two selected single-band catalog " +
                "rasters."
            );
            controlsView.renderBivariateMode?.({ active: false });
            return;
        }
        if (rasterStyleCommitTimeout !== null) {
            commitRasterStyle();
        }
        saveActiveLayerSession();
        bivariateCatalogSelection = selectedCatalogSelection;
        bivariateSelectedBounds = selectedRasterBounds === null
            ? null
            : { ...selectedRasterBounds };
        bivariateSelectedCenter = selectedRasterCenter;
        bivariateSelectedWindowSizeKm = selectedRasterWindowSizeKm;
        rasterStatisticsController.clear();
        resetPendingRasterStatisticsState();
        saveActiveLayerSession();
        for (const record of mapLayers.retainedRecords) {
            if (record.adapter === rasterMapLayerAdapter) cancelLayerHistogramRequest(record.state);
        }
        bivariateMode.enter(eligible.map(
            /**
             * Preserve candidate order as the initial X/Y axis assignment.
             * @param {Object} candidate Eligible paired-analysis candidate.
             * @return {string} Stable candidate key.
             */
            (candidate) => candidate.key
        ));
        onBivariateRenderingChange([
            bivariateMode.xKey,
            bivariateMode.yKey,
        ]);
        controlsView.setAppearanceEnabled?.(false);
        controlsView.setUnivariateHistogramVisible?.(false);
        renderRasterSamplingAreaControls();
        showHistogramWorkspace();
        requestBivariateStatistics();
        applyBivariatePresentation();
        pointSamplesController.synchronize(rasterPointSampleParticipants());
        renderLayerStack();
        renderBivariateAvailability();
    }

    /**
     * Leave bivariate mode, restoring both retained ordinary presentations.
     *
     * @param {string|null} [message=null] Transition-specific guidance.
     * @param {boolean} [restoreAnalysis=true] Whether to resume single analysis.
     * @return {void}
     */
    function leaveBivariateMode(message = null, restoreAnalysis = true) {
        if (!bivariateMode.active) {
            renderBivariateAvailability(message);
            return;
        }
        const keys = [bivariateMode.xKey, bivariateMode.yKey];
        pairedStatisticsController.clear();
        pointSamplesController.synchronize([]);
        bivariateStatistics = null;
        restoreOrdinaryRasterPresentation(keys);
        bivariateMode.leave();
        onBivariateRenderingChange(null);
        bivariateSelectedBounds = null;
        bivariateSelectedCenter = null;
        bivariateSelectedWindowSizeKm = null;
        controlsView.renderBivariateMode?.({ active: false });
        controlsView.clearPairedStatistics?.();
        controlsView.setAppearanceEnabled?.(true);
        controlsView.setUnivariateHistogramVisible?.(true);
        renderRasterSamplingAreaControls();
        rasterSampleWindowController.clearSelection();
        if (selectedRasterBounds !== null) {
            rasterSampleWindowController.restoreSelection(
                selectedRasterBounds
            );
        }
        if (restoreAnalysis && activeRasterItem !== null) {
            restoreActiveLayerStatistics();
            refreshRetainedLayerHistograms(currentRasterSamplingArea(), true);
        } else if (restoreAnalysis) {
            rasterSampleWindowController.clear();
            controlsView.clearPointSamples();
            controlsView.setControlsVisible(false);
        }
        renderLayerStack();
        renderBivariateAvailability(message);
    }

    /** Feature-owned adapter consumed by the neutral map-layer controller. */
    const rasterMapLayerAdapter = {
        tileErrorMessage: "Map tiles could not be rendered.",
        label: getCatalogRasterBasename,
        publish: publishRaster,
        /**
         * Create a published layer's state, preserving matching analysis data.
         *
         * @param {Object} context Neutral controller's publication context.
         * @param {Object} context.entry Stable stack entry and display label.
         * @param {Object} context.publication GeoServer publication response.
         * @param {Object} context.item Catalog raster Item being retained.
         * @return {Object} New raster session with any prior interaction state.
         */
        createState({ entry, publication, item }) {
            const analysisSession = matchingAnalysisSession(item);
            if (analysisSession !== null) {
                saveActiveLayerSession();
            }
            const session = createLayerSession(entry, publication);
            if (analysisSession !== null) {
                copyRasterInteractionState(session, analysisSession);
            }
            return session;
        },
        /**
         * Construct the retained raster's WMS layer with its current style.
         *
         * @param {Object} record Record containing publication and raster state.
         * @param {() => void} reportTileError Controller-owned failure callback.
         * @return {Object} Leaflet-compatible WMS layer, not yet attached.
         */
        createLayer(record, reportTileError) {
            const layer = createRasterLayer(
                record.publication,
                record.state.rasterStyle,
                reportTileError
            );
            record.state.layer = layer;
            return layer;
        },
        /**
         * Describe the current authorized raster appearance for composition.
         *
         * @param {Object} record Retained raster publication and style state.
         * @return {{layerName:string,styleName:string,styleEnvironment:string}}
         * Complete feature-owned composite descriptor.
         */
        renderDescriptor(record) {
            return {
                layerName: record.publication.layerName,
                styleName: "dynamic-raster",
                styleEnvironment: buildRasterStyleEnvironment(
                    record.state.rasterStyle
                ),
            };
        },
        /**
         * Describe effective opacity and legend, including paired-mode styling.
         * Saves shared analysis state first when this record is active.
         *
         * @param {Object} record Retained raster entry and interaction state.
         * @return {{datasetKind:"raster",opacityLocked:boolean,effectiveOpacity:number,
         * legend:Object}} Opacity in [0, 1] and a gradient legend containing
         * its kind, CSS gradient, description, and three numeric labels.
         */
        snapshot(record) {
            if (activeLayerKey === record.entry.key) {
                saveActiveLayerSession();
            }
            let presentationStyle = record.state.rasterStyle;
            const opacityLocked = bivariateMode.contains(record.entry.key);
            if (opacityLocked) {
                const presentation = getBivariatePresentation();
                presentationStyle = record.entry.key === bivariateMode.xKey
                    ? presentation.xStyle
                    : presentation.yStyle;
            }
            const definition = buildRasterLegend(presentationStyle);
            return {
                datasetKind: "raster",
                opacityLocked,
                effectiveOpacity: opacityLocked ? 1 : record.entry.opacity,
                roleBadge: opacityLocked ? {
                    label: record.entry.key === bivariateMode.xKey ? "X" : "Y",
                    description: record.entry.key === bivariateMode.xKey
                        ? "X axis raster"
                        : "Y axis raster",
                } : null,
                legend: {
                    kind: "gradient",
                    gradient: definition.gradient,
                    description: definition.description,
                    labels: [
                        presentationStyle.minimum,
                        presentationStyle.midpoint,
                        presentationStyle.maximum,
                    ],
                },
            };
        },
        /**
         * Export only this raster's validated appearance and palette identity.
         *
         * @param {Object} record Neutral retained-layer record.
         * @return {{kind:string,definition:Object,paletteName:string}}
         * Portable raster style state.
         */
        exportSavedState(record) {
            if (activeLayerKey === record.entry.key) {
                saveActiveLayerSession();
            }
            return {
                kind: "raster",
                definition: { ...validateRasterStyle(record.state.rasterStyle) },
                paletteName: record.state.paletteName,
            };
        },
        /**
         * Check one copied appearance before offering a raster paste action.
         *
         * @param {Object} record Target retained raster record.
         * @param {Object} savedState Candidate portable style envelope.
         * @return {string|null} Null when compatible or a user-facing reason.
         */
        checkSavedStateCompatibility(record, savedState) {
            return checkPortableRasterStyleCompatibility(savedState);
        },
        /**
         * Validate and apply one portable raster appearance to its WMS layer.
         *
         * @param {Object} record Neutral retained-layer record.
         * @param {Object} savedState Candidate saved style envelope.
         * @return {void}
         */
        applySavedState(record, savedState) {
            if (savedState?.kind !== "raster") {
                throw new TypeError("Saved style does not belong to a raster.");
            }
            const style = { ...normalizePortableRasterStyle(
                savedState.definition
            ) };
            const paletteName = savedState.paletteName;
            if (paletteName !== "custom" &&
                !Object.hasOwn(RASTER_COLOR_PALETTES, paletteName)) {
                throw new TypeError("Saved raster palette is invalid.");
            }
            applySessionStyle(record.state, style, paletteName, true);
        },
        /**
         * Copy matching detached analysis state before activating a renderer.
         *
         * @param {Object} record Retained raster record to prepare in place.
         * @return {void}
         */
        prepare(record) {
            const analysisSession = matchingAnalysisSession(record.entry.item);
            if (analysisSession !== null) {
                saveActiveLayerSession();
                copyRasterInteractionState(record.state, analysisSession);
            }
        },
        /**
         * Release shared controls only if this record owns active analysis.
         *
         * @param {Object} record Retained raster being deactivated.
         * @return {void}
         */
        deactivate(record) {
            if (activeLayerKey === record.entry.key) {
                deactivateActiveLayer();
                analysisRasterSession = null;
            }
        },
        /**
         * Transfer a retained raster from background to shared analysis.
         * In automatic mode, only the top visible raster may take ownership.
         *
         * @param {Object} record Retained raster entry and interaction state.
         * @return {void}
         */
        activate(record) {
            if (followsVisibleLayers && visibleRasterRecords()[0]?.entry.key !== record.entry.key) return;
            cancelLayerHistogramRequest(record.state);
            activateRasterSession(record.entry, record.state);
            renderBivariateAvailability();
        },
        /**
         * Release this style target and preserve active analysis before removal.
         *
         * @param {Object} record Raster record about to leave the stack.
         * @param {Object} context Neutral controller's removal context.
         * @param {boolean} context.wasActive Whether the record owned analysis.
         * @return {{activateFallback:boolean}|undefined} A false fallback flag
         * preserves detached analysis; undefined keeps normal inactive removal.
         */
        beforeRemove(record, { wasActive }) {
            if (editingLayerKey === record.entry.key) closeStyle();
            if (!wasActive) {
                return undefined;
            }
            deactivateActiveLayer();
            analysisRasterSession = detachAnalysisSession(record.state);
            return { activateFallback: false };
        },
        /**
         * Cancel removed-layer requests and restore detached or paired analysis.
         *
         * @param {Object} record Removed raster record and retained state.
         * @param {Object} context Neutral controller's removal context.
         * @param {boolean} context.wasActive Whether the removed record was active.
         * @return {void}
         */
        removed(record, { wasActive }) {
            record.state.layerHistogramController?.clear();
            if (wasActive && analysisRasterSession !== null) {
                activateDetachedSession(analysisRasterSession);
            } else if (bivariateMode.active) {
                applyBivariatePresentation();
            }
            renderBivariateAvailability();
        },
        /**
         * Refresh paired rendering and active-raster guidance after a toggle.
         * Analysis ownership is synchronized separately by syncVisibleLayers.
         *
         * @param {Object} record Raster record whose visibility changed.
         * @param {boolean} visible Whether the map layer is now visible.
         * @return {void}
         */
        visibilityChanged(record, visible) {
            if (!visible && followsVisibleLayers) cancelLayerHistogramRequest(record.state);
            if (bivariateMode.contains(record.entry.key)) {
                applyBivariatePresentation();
            }
            if (activeLayerKey !== record.entry.key) {
                renderBivariateAvailability();
                return;
            }
            saveActiveLayerSession();
            controlsView.setActiveLayer(record.entry.label, visible);
            renderRasterSampleWindowGuidance("");
            saveActiveLayerSession();
            renderBivariateAvailability();
        },
        /**
         * Report one raster's tile failure through the application callback.
         *
         * @param {Object} record Failed record containing error text and its Item.
         * @return {void}
         */
        tileError(record) {
            onTileError(record.error, record.entry.item);
        },
        /**
         * Synchronize a newly retained pair renderer with 2D presentation.
         *
         * @param {Object} record Newly retained raster layer record.
         * @return {void}
         */
        added(record) {
            if (bivariateMode.contains(record.entry.key)) {
                syncBivariateCandidate(record.state);
                applyBivariatePresentation();
            }
            renderBivariateAvailability();
        },
        /**
         * Restore coordinated opacity after a retained opacity change.
         *
         * @param {Object} record Updated raster layer record.
         * @return {void}
         */
        opacityChanged(record) {
            if (bivariateMode.contains(record.entry.key)) {
                applyBivariatePresentation();
            }
        },
        /**
         * Reapply coordinated blending after stack reordering in 2D mode.
         *
         * @return {void}
         */
        orderChanged() {
            if (bivariateMode.active) {
                applyBivariatePresentation();
            }
        },
    };

    /**
     * Render and publish the current retained-layer state.
     *
     * @param {{key:string,action:string}|null} [requestedFocus=null] Optional
     * focus target after a destructive or ordering transition.
     * @return {void}
     */
    function renderLayerStack(requestedFocus = null) {
        refreshStyle();
        renderLayerHistogramSummaries();
        if (activeDetachedRasterSession() !== null) {
            mapLayers.deactivatePresentation();
            renderBivariateAvailability();
            return;
        }
        mapLayers.render(requestedFocus);
        renderBivariateAvailability();
    }

    /**
     * Reveal the detailed histogram in the map-side panel without changing
     * sidebar allocation or sampling state.
     *
     * @return {void}
     */
    function showHistogramWorkspace() {
        onHistogramRequested();
        controlsView.showHistogramWidget();
    }

    /**
     * Activate the retained raster selected from an analysis summary.
     *
     * @param {string} key Opaque retained-layer identity.
     * @return {void}
     */
    function handleSelectLayerHistogram(key) {
        mapLayers.activate(key, {
            key,
            action: "analysis-histogram",
        });
        renderLayerHistogramSummaries();
        showHistogramWorkspace();
    }

    /**
     * Stop shared active interactions while preserving completed layer state.
     *
     * @return {void}
     */
    function deactivateActiveLayer() {
        if (activeLayerKey === null) {
            return;
        }
        rasterStatisticsController.clear();
        rasterSampleWindowController.clear();
        pointSamplesController.clear();
        if (wholeRasterStatisticsState === "loading") {
            wholeRasterStatisticsState = "idle";
        }
        if (selectedRasterStatisticsState === "loading") {
            selectedRasterStatisticsState = "idle";
        }
        saveActiveLayerSession();
        activeLayerKey = null;
        activeRasterItem = null;
    }

    /**
     * Present cached active statistics or start missing Catalog analysis.
     *
     * Renderer type and visibility never participate in this decision.
     *
     * @return {void}
     */
    function restoreActiveLayerStatistics() {
        if (hasSelectedRasterSamplingArea()) {
            if (selectedRasterStatisticsState === "ready") {
                renderRasterStatistics(selectedRasterStatistics);
            } else if (selectedRasterStatisticsState === "error") {
                renderSelectedRasterStatisticsError(
                    selectedRasterStatisticsError
                );
            } else {
                selectedRasterStatisticsState = "idle";
                void rasterStatisticsController.activate(
                    activeRasterItem,
                    currentRasterSamplingArea()
                );
            }
        } else if (wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(wholeRasterStatistics);
        } else if (wholeRasterStatisticsState === "error") {
            renderRasterStatisticsError(
                wholeRasterStatisticsError,
                "wholeRaster"
            );
        } else {
            wholeRasterStatisticsState = "idle";
            void rasterStatisticsController.activate(
                activeRasterItem,
                WHOLE_RASTER_SAMPLING_AREA
            );
        }
    }

    /**
     * Restore one retained raster session after neutral activation.
     *
     * @param {Object} entry Neutral retained-layer entry.
     * @param {Object} session Raster-owned interaction session.
     * @return {void}
     */
    function activateRasterSession(entry, session) {
        if (activeLayerKey === entry.key) {
            return;
        }
        loadActiveLayerSession(session);
        controlsView.setControlsVisible(true);
        presentActiveRenderingAvailability(true);
        controlsView.setActiveLayer(entry.label, entry.visible);
        presentActiveStyle(rasterStyle, session.paletteName);
        resetRasterPercentileControls();

        if (!bivariateMode.active) {
            rasterSampleWindowController.setWindowSize(
                selectedRasterWindowSizeKm ??
                    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM
            );
        }
        controlsView.setSampleWindowSize(
            rasterSampleWindowController.windowSizeKm,
            MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM
        );
        controlsView.setSampleWindowInvalid(false);
        renderRasterSamplingAreaControls();
        const [presentedBounds] = getPresentedSampleWindow();
        if (presentedBounds === null) {
            rasterSampleWindowController.clearSelection();
        } else {
            rasterSampleWindowController.restoreSelection(
                presentedBounds
            );
        }
        if (bivariateMode.active) {
            controlsView.setAppearanceEnabled?.(false);
            controlsView.setUnivariateHistogramVisible?.(false);
            saveActiveLayerSession();
            applyBivariatePresentation();
            renderRasterSampleWindowGuidance("");
            return;
        }
        renderRasterSampleWindowGuidance("");

        restoreActiveLayerStatistics();
        saveActiveLayerSession();
    }

    /**
     * Ask the neutral controller to activate one retained raster.
     *
     * @param {string} key Stable retained-layer key.
     * @param {{key:string,action:string}|null} [requestedFocus=null] Focus hint.
     * @return {void}
     */
    function activateLayer(key, requestedFocus = null) {
        mapLayers.activate(key, requestedFocus);
        renderLayerHistogramSummaries();
    }

    /**
     * Restore one renderer-detached session into shared viewer controls.
     *
     * @param {Object} session Analysis-only interaction state.
     * @return {void}
     */
    function activateDetachedSession(session) {
        loadActiveLayerSession(session);
        controlsView.setControlsVisible(true);
        presentActiveRenderingAvailability(false);
        controlsView.setActiveLayer(session.label, true);
        presentActiveStyle(rasterStyle, session.paletteName);
        resetRasterPercentileControls();
        if (!bivariateMode.active) {
            rasterSampleWindowController.setWindowSize(
                selectedRasterWindowSizeKm ??
                    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM
            );
        }
        controlsView.setSampleWindowSize(
            rasterSampleWindowController.windowSizeKm,
            MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM
        );
        controlsView.setSampleWindowInvalid(false);
        const [presentedBounds] = getPresentedSampleWindow();
        if (presentedBounds === null) {
            rasterSampleWindowController.clearSelection();
        } else {
            rasterSampleWindowController.restoreSelection(
                presentedBounds
            );
        }
        renderRasterSamplingAreaControls();
        if (bivariateMode.active) {
            controlsView.setAppearanceEnabled?.(false);
            controlsView.setUnivariateHistogramVisible?.(false);
            saveActiveLayerSession();
            applyBivariatePresentation();
            renderRasterSampleWindowGuidance("");
            renderLayerStack();
            return;
        }
        renderRasterSampleWindowGuidance("");
        restoreActiveLayerStatistics();
        saveActiveLayerSession();
        renderLayerStack();
    }

    /**
     * Activate renderer-independent analysis for one selected Catalog raster.
     *
     * A retained WMS layer remains the parent session when one exists.
     * Otherwise this method presents the same click-value, area-selection,
     * histogram, percentile, and color controls without
     * publishing or constructing a map raster layer.
     * In visible-layer mode, ignores the catalog selection and synchronizes
     * analysis from the map stack instead.
     *
     * @param {Object} item Selected Catalog raster Item.
     * @return {void}
     */
    function activateAnalysis(item) {
        if (followsVisibleLayers) {
            syncVisibleLayers();
            return;
        }
        const catalogKey = getCatalogItemKey(item);
        if (bivariateMode.active && !bivariateMode.contains(catalogKey)) {
            leaveBivariateMode(
                "A different raster analysis was selected; bivariate mode ended."
            );
        }
        rememberBivariateCandidate(item);
        mapLayers.recordIntent();
        const retainedKey = catalogKey;
        const existingSession = matchingAnalysisSession(item);
        if (existingSession !== null && isActiveAnalysisRaster()) {
            return;
        }
        const retainedSession = mapLayers.getRecord(retainedKey)?.state;
        if (retainedSession !== undefined) {
            const analysisSession = matchingAnalysisSession(item);
            if (analysisSession !== null) {
                saveActiveLayerSession();
                copyRasterInteractionState(retainedSession, analysisSession);
            }
            activateLayer(retainedKey);
            return;
        }
        deactivateActiveLayer();
        analysisRasterSession = existingSession ?? createAnalysisSession(item);
        activateDetachedSession(analysisRasterSession);
    }

    /**
     * Remove a matching renderer-independent analysis session.
     *
     * @param {Object|null} item Catalog raster to match, or null to remove any
     * analysis-only selection.
     * @return {void}
     */
    function deactivateAnalysis(item) {
        if (analysisRasterSession === null) {
            return;
        }
        if (item !== null && matchingAnalysisSession(item) === null) {
            return;
        }
        mapLayers.recordIntent();
        const wasActive = isActiveAnalysisRaster();
        if (wasActive) {
            deactivateActiveLayer();
        }
        analysisRasterSession = null;
        if (!wasActive) {
            return;
        }
        if (mapLayers.activeKey !== null) {
            activateLayer(mapLayers.activeKey);
        } else if (bivariateMode.active) {
            controlsView.setControlsVisible(true);
            const [presentedBounds] = getPresentedSampleWindow();
            if (presentedBounds !== null) {
                rasterSampleWindowController.restoreSelection(presentedBounds);
            }
            renderRasterSamplingAreaControls();
            renderRasterSampleWindowGuidance("");
            applyBivariatePresentation();
            renderLayerStack();
        } else {
            controlsView.setControlsVisible(false);
            controlsView.clearPointSamples();
            renderLayerStack();
        }
    }

    /**
     * Find the session that owns style edits, independently of analysis.
     *
     * An explicit editing key takes precedence. Without one, legacy callers
     * use the active detached or retained analysis session.
     *
     * @return {Object|null} Mutable raster session, or null when the target
     * is absent; does not fall back from a missing explicit editing key.
     */
    function editingSession() {
        return editingLayerKey === null
            ? activeDetachedRasterSession() ??
                mapLayers.getRecord(activeLayerKey)?.state ?? null
            : mapLayers.getRecord(editingLayerKey)?.state ?? null;
    }

    /**
     * Describe the statistics scope retained by one keyed style target.
     *
     * @param {Object} session Retained raster session being styled.
     * @return {string} Readable whole-raster, map-sample, or polygon selection scope.
     */
    function styleHistogramScopeLabel(session) {
        const scope = session.rasterStatistics?.scope;
        if (scope === "catalogSelection" || (
            scope === undefined && session.selectedCatalogSelection !== null
        )) {
            return session.selectedCatalogSelection === null
                ? "Historical polygon selection"
                : `Vector selection · ${session.selectedCatalogSelection.filename} · ` +
                    session.selectedCatalogSelection.selectedDataset;
        }
        if (scope === "selectedArea" || (
            scope === undefined && session.selectedRasterBounds !== null
        )) {
            return session.selectedRasterWindowSizeKm === null
                ? "Map sample"
                : `Map sample · ${session.selectedRasterWindowSizeKm} km × ` +
                    `${session.selectedRasterWindowSizeKm} km`;
        }
        return "Whole raster";
    }

    /**
     * Return the lifecycle state associated with a style target's sample.
     *
     * @param {Object} session Retained raster session being styled.
     * @return {{state:string,error:Error|null}} Statistics state and failure.
     */
    function styleHistogramLifecycle(session) {
        const selected = session.selectedRasterBounds !== null ||
            session.selectedCatalogSelection !== null;
        return selected
            ? {
                state: session.selectedRasterStatisticsState,
                error: session.selectedRasterStatisticsError,
            }
            : {
                state: session.wholeRasterStatisticsState,
                error: session.wholeRasterStatisticsError,
            };
    }

    /**
     * Render histogram context for the explicitly keyed style target.
     *
     * @param {Object|null} [style=null] Candidate style preview. The session's
     * committed style is used when omitted.
     * @param {{lower:number,middle:number,upper:number}|null}
     * [percentiles=null] Draft percentile positions, when applicable.
     * @return {void}
     */
    function renderEditingStyleHistogram(style = null, percentiles = null) {
        const session = editingSession();
        if (editingLayerKey === null || session === null ||
            bivariateMode.contains(session.key)) {
            controlsView.clearStyleHistogram?.();
            return;
        }
        const scopeLabel = styleHistogramScopeLabel(session);
        if (session.rasterStatistics === null) {
            const lifecycle = styleHistogramLifecycle(session);
            const message = lifecycle.state === "loading"
                ? "Calculating this raster's histogram…"
                : lifecycle.state === "error"
                    ? `Histogram unavailable: ${lifecycle.error?.message ?? "Unknown error"}`
                    : "Histogram not available yet. Open full analysis to calculate it.";
            controlsView.renderStyleHistogramState?.(
                scopeLabel,
                message,
                lifecycle.state === "loading"
            );
            return;
        }
        controlsView.renderStyleHistogram?.(
            session.rasterStatistics,
            style ?? session.rasterStyle,
            scopeLabel,
            getHistogramValueLabel(session.item),
            percentiles
        );
    }

    /**
     * Update rendering availability without overwriting another style target.
     *
     * @param {boolean} available Whether the active analysis raster has a renderer.
     * @return {void}
     */
    function presentActiveRenderingAvailability(available) {
        if (editingLayerKey === null || editingLayerKey === activeLayerKey) {
            controlsView.setRenderingControlsAvailable(available);
        }
    }

    /**
     * Show the active analysis style only when another raster is not being edited.
     *
     * @param {Object} style Active raster's numeric range and color stops.
     * @param {string} paletteName Registered palette identity or "custom".
     * @return {void}
     */
    function presentActiveStyle(style, paletteName) {
        if (editingLayerKey === null || editingLayerKey === activeLayerKey) {
            controlsView.setStyle(style, paletteName);
        }
    }

    /**
     * Select a style target without transferring histogram or click ownership.
     * Flushes any pending edit on the previous target before looking up the key.
     *
     * @param {string} key Retained raster key.
     * @return {boolean} True after initializing the target's style controls;
     * false for missing or non-raster targets, leaving no explicit style target.
     */
    function openStyle(key) {
        closeStyle();
        const record = mapLayers.getRecord(key);
        const session = record?.adapter === rasterMapLayerAdapter
            ? record.state : null;
        if (session === null) return false;
        saveActiveLayerSession();
        editingLayerKey = key;
        controlsView.setStyle(session.rasterStyle, session.paletteName);
        controlsView.resetPercentiles(DEFAULT_RASTER_PERCENTILES);
        refreshStyle();
        return true;
    }

    /**
     * Open the current pair's style disclosure without selecting or sampling.
     * Uses the existing histogram navigation callback and controls adapter.
     *
     * @param {string} key Catalog identity of either current paired raster.
     * @return {boolean} Whether this key belongs to the active 2D pair.
     */
    function openPairedStyle(key) {
        if (!bivariateMode.contains(key)) return false;
        showHistogramWorkspace();
        controlsView.openBivariateStyle();
        return true;
    }

    /**
     * Flush any pending valid edit and release the explicit editing target.
     * The floating editor's DOM lifecycle is owned by MapLayerStyleEditor.
     *
     * @return {void}
     */
    function closeStyle() {
        if (rasterStyleCommitTimeout !== null) commitRasterStyle();
        editingLayerKey = null;
        controlsView.clearStyleHistogram?.();
    }

    /**
     * Refresh style availability and percentile feedback for the editing target.
     * Cancels pending edits and clears the target if its session was removed;
     * otherwise preserves input values while applying current 2D restrictions.
     *
     * @return {void}
     */
    function refreshStyle() {
        if (editingLayerKey === null) return;
        const session = editingSession();
        if (session === null) {
            if (rasterStyleCommitTimeout !== null) {
                clock.clearTimeout(rasterStyleCommitTimeout);
                rasterStyleCommitTimeout = null;
            }
            editingLayerKey = null;
            return;
        }
        controlsView.setRenderingControlsAvailable(true);
        controlsView.setAppearanceEnabled(!bivariateMode.contains(editingLayerKey));
        controlsView.setPercentileControlsVisible(
            session.rasterStatistics !== null
        );
        updateRasterPercentileValues();
        if (session.rasterStatistics === null) {
            renderEditingStyleHistogram(session.rasterStyle);
        }
    }

    /**
     * Apply a style to the target's renderer and session, not its list position.
     * Also synchronizes shared state if this target owns active analysis.
     *
     * @param {Object} session Retained WMS raster session.
     * @param {Object} style Numeric range and color stops to validate and apply.
     * @param {string} paletteName Registered palette identity or "custom".
     * @param {boolean} wasEdited Whether a user edit should block automatic ranges.
     * @return {void}
     * @throws {Error} If style validation or the renderer update fails.
     */
    function applySessionStyle(session, style, paletteName, wasEdited) {
        const environment = buildRasterStyleEnvironment(style);
        session.layer?.setParams({
            styles: "dynamic-raster", env: environment,
        });
        session.rasterStyle = { ...style };
        session.paletteName = paletteName;
        session.rasterStyleWasEdited = wasEdited;
        if (session.key === activeLayerKey) {
            rasterStyle = { ...style };
            activePaletteName = paletteName;
            rasterStyleWasEdited = wasEdited;
            if (rasterStatistics !== null) {
                controlsView.renderHistogram(rasterStatistics, rasterStyle, getHistogramValueLabel(activeRasterItem));
            }
            saveActiveLayerSession();
        }
        syncBivariateCandidate(session);
    }

    /**
     * Validate current style inputs and build their GeoServer environment.
     *
     * @return {{style:Object,environment:string}|null} Valid candidate and WMS
     * environment, or null after displaying the validation error.
     */
    function validateRasterStyleControls() {
        const candidateStyle = controlsView.readStyle();
        try {
            const environment = buildRasterStyleEnvironment(candidateStyle);
            controlsView.renderStyleError();
            return { style: candidateStyle, environment };
        } catch (styleError) {
            controlsView.renderStyleError(styleError);
            return null;
        }
    }

    /**
     * Commit valid inputs to the editing session's WMS renderer.
     * Cancels the debounce timer; missing targets, paired-mode targets, and
     * invalid input produce no style update. Failures are shown in the controls.
     *
     * @return {void}
     */
    function commitRasterStyle() {
        if (rasterStyleCommitTimeout !== null) {
            clock.clearTimeout(rasterStyleCommitTimeout);
            rasterStyleCommitTimeout = null;
        }
        const session = editingSession();
        if (session === null || bivariateMode.contains(session.key)) return;
        const candidate = validateRasterStyleControls();
        if (candidate === null) return;
        try {
            applySessionStyle(
                session, candidate.style, controlsView.getPaletteName(),
                session.rasterStyleWasEdited
            );
        } catch (error) {
            controlsView.renderStyleError(error);
            return;
        }
        controlsView.renderLegend(candidate.style);
        renderEditingStyleHistogram(candidate.style);
        renderLayerStack();
    }

    /**
     * Commit the latest valid style after rapid edits settle.
     *
     * @return {void}
     */
    function scheduleRasterStyleCommit() {
        const candidate = validateRasterStyleControls();
        if (candidate !== null) {
            renderEditingStyleHistogram(candidate.style);
        }
        if (rasterStyleCommitTimeout !== null) {
            clock.clearTimeout(rasterStyleCommitTimeout);
        }
        rasterStyleCommitTimeout = clock.setTimeout(
            commitScheduledRasterStyle,
            RASTER_STYLE_DEBOUNCE_MILLISECONDS
        );
    }

    /**
     * Clear the pending identifier and commit its retained style candidate.
     *
     * @return {void}
     */
    function commitScheduledRasterStyle() {
        rasterStyleCommitTimeout = null;
        commitRasterStyle();
    }

    /**
     * Populate controls with the editing target's initial colors and range.
     * Uses whole-raster percentiles or defaults. Does not commit the style to
     * its renderer.
     *
     * @return {void}
     */
    function resetRasterStyle() {
        const session = editingSession();
        const style = session?.wholeRasterStatistics == null
                ? { ...DEFAULT_RASTER_STYLE }
                : deriveRasterStyleFromStatistics(
                    DEFAULT_RASTER_STYLE, session.wholeRasterStatistics
                );
        controlsView.setStyle({
            ...style, minimumOpacity: 1, midpointOpacity: 1, maximumOpacity: 1
        }, DEFAULT_RASTER_PALETTE_NAME);
    }

    /**
     * Restore percentile selectors to defaults unless another layer is being edited.
     *
     * @return {void}
     */
    function resetRasterPercentileControls() {
        if (editingLayerKey === null || editingLayerKey === activeLayerKey) {
            controlsView.resetPercentiles(DEFAULT_RASTER_PERCENTILES);
        }
    }

    /**
     * Update percentile values and applicability for the editing session, or
     * the active analysis session when no explicit style target is set.
     *
     * @return {{lower: number, middle: number, upper: number}|null} Ordered
     * percentiles, null for invalid ordering or absent statistics.
     */
    function updateRasterPercentileValues() {
        const session = editingSession();
        const statistics = editingLayerKey === null
            ? rasterStatistics : session?.rasterStatistics ?? null;
        const applicable = editingLayerKey === null
            ? rasterStatisticsIsApplicable
            : session?.rasterStatisticsIsApplicable === true;
        if (statistics === null) {
            return null;
        }
        const percentiles = controlsView.readPercentiles();
        const isOrdered =
            percentiles.lower < percentiles.middle &&
            percentiles.middle < percentiles.upper;
        const approximateValues = {};
        for (const percentileName of ["lower", "middle", "upper"]) {
            approximateValues[percentileName] = formatRasterPixelValue(
                estimateRasterHistogramPercentile(
                    statistics,
                    percentiles[percentileName]
                )
            );
        }
        controlsView.renderPercentileValues(
            percentiles,
            approximateValues,
            isOrdered,
            applicable
        );
        if (editingLayerKey !== null && session !== null) {
            let previewStyle = session.rasterStyle;
            if (isOrdered) {
                previewStyle = deriveRasterStyleFromStatistics(
                    controlsView.readStyle(),
                    statistics,
                    percentiles
                );
            }
            renderEditingStyleHistogram(
                previewStyle,
                isOrdered ? percentiles : null
            );
        }
        return isOrdered ? percentiles : null;
    }

    /**
     * Remove histogram data and controls belonging to a previous layer.
     *
     * @return {void}
     */
    function clearRasterStatisticsPresentation() {
        rasterStatistics = null;
        rasterStatisticsIsApplicable = false;
        controlsView.clearStatistics();
        resetRasterPercentileControls();
        saveActiveLayerSession();
    }

    /**
     * Present one bounded statistics request without blocking manual styling.
     *
     * @param {"wholeRaster"|"selectedArea"} scope Statistics request scope.
     * @return {void}
     */
    function renderRasterStatisticsLoading(scope) {
        clearRasterStatisticsPresentation();
        controlsView.setStatisticsBusy(true);
        controlsView.setStatisticsStatus(
            scope === "selectedArea"
                ? "Calculating a bounded histogram for the selected area..."
                : "Calculating a bounded whole-raster histogram..."
        );
        saveActiveLayerSession();
    }

    /**
     * Apply the initial whole-raster range unless a manual edit superseded it.
     *
     * @param {Object} statistics Validated whole-raster statistics.
     * @return {boolean} Whether the bounded initial range was applied.
     */
    function applyInitialWholeRasterStyle(statistics) {
        const initialStyle = deriveInitialRasterStyleFromStatistics(
            rasterStyle,
            statistics,
            rasterStyleWasEdited
        );
        if (initialStyle === null) {
            return false;
        }
        rasterStyle = initialStyle;
        const session = activeDetachedRasterSession() ??
            mapLayers.getRecord(activeLayerKey)?.state;
        if (session) applySessionStyle(
            session, rasterStyle, activePaletteName, rasterStyleWasEdited
        );
        // A retained raster changes the composite descriptor, while detached
        // Catalog analysis has no map presentation to invalidate.
        if (session && !isActiveAnalysisRaster()) {
            renderLayerStack();
        }
        presentActiveStyle(rasterStyle, activePaletteName);
        return true;
    }

    /**
     * Present one current whole-raster, map-window, or polygon selection histogram.
     *
     * @param {Object} statistics Validated raster statistics.
     * @param {boolean} [initialRangeApplied=false] Whether its range was
     * applied.
     * @param {boolean} [allowApply=true] Whether percentiles apply to the
     * selection.
     * @return {void}
     */
    function renderRasterStatistics(
        statistics,
        initialRangeApplied = false,
        allowApply = true
    ) {
        rasterStatistics = statistics;
        rasterStatisticsIsApplicable =
            allowApply &&
            rasterStatisticsMatchesSelection(
                statistics,
                currentRasterSamplingArea()
            );
        controlsView.setStatisticsBusy(false);
        controlsView.setStatisticsRetryVisible(false);
        controlsView.renderHistogram(statistics, rasterStyle, getHistogramValueLabel(activeRasterItem));
        controlsView.setPercentileControlsVisible(true);
        resetRasterPercentileControls();
        updateRasterPercentileValues();

        const excludedCount =
            statistics.sampledPixelCount - statistics.validSampleCount;
        const usesSampleGrid = statistics.samplingMethod === "sampleGrid";
        const sourceDescription = statistics.scope === "wholeRaster"
            ? "source raster"
            : "source-cell window";
        const approximation = statistics.estimated ? "approximate" : "exact";
        const scopeDescription = statistics.scope === "catalogSelection"
            ? `Vector selection ${selectedCatalogSelection?.filename ?? "area"}, ` +
              `layer ${selectedCatalogSelection?.selectedDataset ?? "selected"}, ` +
              `${approximation} bounded histogram`
            : statistics.scope === "selectedArea"
                ? `Selected-area ${approximation} bounded histogram`
                : `Whole-raster ${approximation} bounded histogram`;
        const provenance = usesSampleGrid
            ? `${statistics.validSampleCount.toLocaleString()} finite values ` +
              `from a ${statistics.sampleWidth.toLocaleString()} × ` +
              `${statistics.sampleHeight.toLocaleString()} bounded center ` +
              `grid over the ${statistics.sourceWidth.toLocaleString()} × ` +
              `${statistics.sourceHeight.toLocaleString()} ${sourceDescription}`
            : `${statistics.validSampleCount.toLocaleString()} valid pixels ` +
              `from the exact ${statistics.sampleWidth.toLocaleString()} × ` +
              `${statistics.sampleHeight.toLocaleString()} bounded ` +
              sourceDescription;
        const excluded = excludedCount === 0
            ? ""
            : `; ${excludedCount.toLocaleString()} masked, nodata, or ` +
              "nonfinite sample pixels excluded";

        controlsView.setStatisticsStatus(
            initialRangeApplied
                ? `${scopeDescription}: ${provenance}${excluded}. ` +
                  "The 5th, 50th, and 95th percentile range was " +
                  "applied."
                : `${scopeDescription}: ${provenance}${excluded}. ` +
                  "Your current appearance was preserved."
        );
        if (initialRangeApplied) {
            controlsView.setAppearanceStatus(
                "Initialized the color range from the whole-raster histogram."
            );
        }
        saveActiveLayerSession();
    }

    /**
     * Keep manual rendering usable after one statistics failure.
     *
     * @param {Error} error Statistics request failure.
     * @param {"wholeRaster"|"selectedArea"} scope Failed request scope.
     * @return {void}
     */
    function renderRasterStatisticsError(error, scope) {
        rasterStatistics = null;
        rasterStatisticsIsApplicable = false;
        controlsView.setStatisticsBusy(false);
        controlsView.clearHistogram();
        controlsView.setPercentileControlsVisible(false);
        controlsView.setStatisticsRetryVisible(
            canRetryRasterStatistics(error)
        );
        controlsView.setStatisticsStatus(
            `${scope === "selectedArea" ? "Selected-area" : "Whole-raster"} ` +
            `histogram unavailable: ${error.message} ` +
            "Manual appearance controls remain available."
        );
        saveActiveLayerSession();
    }

    /**
     * Record and present the start of a whole-raster statistics request.
     *
     * @return {void}
     */
    function renderWholeRasterStatisticsLoading() {
        wholeRasterStatisticsState = "loading";
        wholeRasterStatisticsError = null;
        if (!hasSelectedRasterSamplingArea()) {
            renderRasterStatisticsLoading("wholeRaster");
        }
        saveActiveLayerSession();
    }

    /**
     * Retain a successful whole-raster distribution and initialize its style.
     *
     * @param {Object} statistics Validated whole-raster statistics.
     * @return {void}
     */
    function renderWholeRasterStatistics(statistics) {
        wholeRasterStatistics = statistics;
        wholeRasterStatisticsState = "ready";
        wholeRasterStatisticsError = null;
        const initialRangeApplied = hasSelectedRasterSamplingArea()
            ? false
            : applyInitialWholeRasterStyle(statistics);
        if (!hasSelectedRasterSamplingArea()) {
            renderRasterStatistics(statistics, initialRangeApplied);
        }
        saveActiveLayerSession();
    }

    /**
     * Retain and present a recoverable whole-raster statistics failure.
     *
     * @param {Error} error Statistics request failure.
     * @return {void}
     */
    function renderWholeRasterStatisticsError(error) {
        wholeRasterStatisticsState = "error";
        wholeRasterStatisticsError = error;
        if (!hasSelectedRasterSamplingArea()) {
            renderRasterStatisticsError(error, "wholeRaster");
        }
        saveActiveLayerSession();
    }

    /**
     * Present the start of a bounded map-window or polygon selection statistics request.
     *
     * @return {void}
     */
    function renderSelectedRasterStatisticsLoading() {
        selectedRasterStatisticsState = "loading";
        selectedRasterStatisticsError = null;
        rasterStatisticsIsApplicable = false;
        controlsView.setStatisticsBusy(true);
        controlsView.setStatisticsRetryVisible(false);
        controlsView.setApplyPercentilesEnabled(false);
        controlsView.setStatisticsStatus(
            rasterStatistics === null
                ? selectedRasterStatisticsLoadingMessage()
                : selectedRasterStatisticsLoadingMessage() + " " +
                  "The previous histogram remains visible for reference and " +
                  "cannot be applied to this selection."
        );
        saveActiveLayerSession();
    }

    /**
     * Describe the active bounded statistics request without map-move chatter.
     *
     * @return {string} Accessible loading announcement for bounds or polygon selection.
     */
    function selectedRasterStatisticsLoadingMessage() {
        if (selectedCatalogSelection === null) {
            return "Calculating a bounded histogram for the selected area...";
        }
        return (
            `Calculating a bounded histogram for catalog vector ` +
            `${selectedCatalogSelection.filename}, layer ` +
            `${selectedCatalogSelection.selectedDataset}...`
        );
    }

    /**
     * Present one successful bounded map-window or polygon selection response.
     *
     * @param {Object} statistics Validated map-window or polygon selection statistics.
     * @return {void}
     */
    function renderSelectedRasterStatistics(statistics) {
        selectedRasterStatistics = statistics;
        selectedRasterStatisticsState = "ready";
        selectedRasterStatisticsError = null;
        renderRasterStatistics(statistics);
    }

    /**
     * Present a map-window or polygon selection failure while retaining prior context.
     *
     * @param {Error} error Statistics request failure.
     * @return {void}
     */
    function renderSelectedRasterStatisticsError(error) {
        selectedRasterStatisticsState = "error";
        selectedRasterStatisticsError = error;
        rasterStatisticsIsApplicable = false;
        if (rasterStatistics === null && wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(wholeRasterStatistics, false, false);
        }
        controlsView.setStatisticsBusy(false);
        controlsView.setStatisticsRetryVisible(
            canRetryRasterStatistics(error)
        );
        controlsView.setApplyPercentilesEnabled(false);
        const areaName = selectedCatalogSelection === null
            ? "Selected-area"
            : `Vector selection ${selectedCatalogSelection.filename}, layer ` +
              selectedCatalogSelection.selectedDataset;
        controlsView.setStatisticsStatus(
            rasterStatistics === null
                ? `${areaName} histogram unavailable: ${error.message} ` +
                  "Manual appearance controls remain available."
                : `${areaName} histogram unavailable: ${error.message} ` +
                  "The previous histogram remains visible for reference but " +
                  "cannot be applied to this selection. Your appearance was " +
                  "preserved."
        );
        saveActiveLayerSession();
    }

    /**
     * Restore whole-raster statistics after clearing a map window or polygon selection.
     *
     * @return {void}
     */
    function restoreWholeRasterStatistics() {
        if (bivariateMode.active) {
            bivariateCatalogSelection = null;
            bivariateSelectedBounds = null;
            bivariateSelectedCenter = null;
            bivariateSelectedWindowSizeKm = null;
            rasterSampleWindowController.clearSelection();
            renderRasterSamplingAreaControls();
            renderRasterSampleWindowGuidance("");
            requestBivariateStatistics();
            return;
        }
        rasterStatisticsController.clear();
        resetPendingRasterStatisticsState();
        selectedRasterBounds = null;
        selectedCatalogSelection = null;
        selectedRasterCenter = null;
        selectedRasterWindowSizeKm = null;
        selectedRasterStatistics = null;
        selectedRasterStatisticsState = "idle";
        selectedRasterStatisticsError = null;
        rasterSampleWindowController.clearSelection();
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        if (wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(wholeRasterStatistics);
        } else if (wholeRasterStatisticsState === "error") {
            renderRasterStatisticsError(
                wholeRasterStatisticsError,
                "wholeRaster"
            );
        } else {
            clearRasterStatisticsPresentation();
            if (canUseRasterMapInteractions()) {
                void rasterStatisticsController.activate(
                    activeRasterItem,
                    WHOLE_RASTER_SAMPLING_AREA
                );
            }
        }
        saveActiveLayerSession();
    }

    /**
     * Describe a persistent sample selection or transient edge guidance.
     *
     * @param {string} guidance Transient controller guidance, if any.
     * @return {void}
     */
    function renderRasterSampleWindowGuidance(guidance) {
        const [presentedBounds, presentedWindowSizeKm] =
            getPresentedSampleWindow();
        let nextStatus;
        if (guidance) {
            nextStatus = guidance;
        } else if (presentedBounds !== null) {
            const { west, south, east, north } = presentedBounds;
            nextStatus =
                `Approximately ${presentedWindowSizeKm} km × ` +
                `${presentedWindowSizeKm} km window selected: ` +
                `W ${west.toFixed(3)}, S ${south.toFixed(3)}, ` +
                `E ${east.toFixed(3)}, N ${north.toFixed(3)}. ` +
                `Click the map again to replace it.${
                    bivariateMode.active
                        ? " The paired distribution uses this shared area."
                        : ""
                }`;
        } else if ((bivariateMode.active ? bivariateCatalogSelection : selectedCatalogSelection) !== null) {
            const area = bivariateMode.active ? bivariateCatalogSelection : selectedCatalogSelection;
            nextStatus = `Vector selection selected: ${area.filename}. ` +
                "Polygon boundaries and holes define the histogram selection.";
        } else if (bivariateMode.active) {
            nextStatus = "Whole-overlap paired distribution selected. " +
                "Click the map to use one shared WGS 84 window.";
        } else {
            nextStatus = "Whole-raster histogram selected. Click the map or " +
                "use Analysis tools to analyze the map center.";
        }
        controlsView.setSampleWindowStatus(nextStatus);
    }

    /**
     * Commit one map rectangle and replace selected-area statistics.
     *
     * @param {Object} bounds Canonical selected WGS 84 bounds.
     * @param {Readonly<{longitude:number,latitude:number}>} center Original click.
     * @return {void}
     */
    function selectRasterSampleWindow(bounds, center) {
        if (!canUseRasterMapInteractions()) {
            return;
        }
        cancelRasterSampleWindowResize();
        if (bivariateMode.active) {
            bivariateCatalogSelection = null;
            bivariateSelectedCenter = center;
            bivariateSelectedBounds = bounds;
            bivariateSelectedWindowSizeKm =
                rasterSampleWindowController.windowSizeKm;
            renderRasterSamplingAreaControls();
            renderRasterSampleWindowGuidance("");
            showHistogramWorkspace();
            requestBivariateStatistics();
            return;
        }
        selectedRasterCenter = center;
        selectedRasterBounds = bounds;
        selectedCatalogSelection = null;
        selectedRasterWindowSizeKm = rasterSampleWindowController.windowSizeKm;
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        showHistogramWorkspace();
        refreshRetainedLayerHistograms(currentRasterSamplingArea());
        void rasterStatisticsController.activate(
            activeRasterItem,
            currentRasterSamplingArea()
        );
        saveActiveLayerSession();
    }

    /**
     * Explore one composition-owned map position with the current window size.
     *
     * Request pixel values independently of the published-extent check that
     * controls histogram selection. The pixel API determines actual coverage.
     * Catalog-vector analysis returns to ordinary raster scope before selecting
     * a box. Reject noncanonical coordinates before requesting either analysis.
     *
     * @param {{lng:number,lat:number}} position Leaflet map position.
     * @param {Object} [options] Composition-owned selection notification.
     * @param {function(Object|null):void} [options.onSelected] Called synchronously
     * with the committed sampling area only when the box is accepted.
     * @return {boolean} Whether raster coverage makes the histogram workspace
     * relevant, including guidance when the requested box cannot be selected.
     */
    function exploreAt(position, { onSelected = () => {} } = {}) {
        if (!canUseRasterMapInteractions()) {
            return false;
        }
        if (vectorSelection && (bivariateMode.active ? bivariateCatalogSelection : selectedCatalogSelection)?.id === vectorSelection.id) {
            onSelected(getSelectedArea());
            return true;
        }
        const point = {
            longitude: position.lng,
            latitude: position.lat,
        };
        if (!isCanonicalWgs84Position(point)) {
            pointSamplesController.clear();
            return false;
        }
        const participants = rasterPointSampleParticipants();
        const openHistogram = shouldOpenRasterHistogram(participants, point);
        if (openHistogram) {
            if (selectedCatalogSelection !== null) {
                restoreWholeRasterStatistics();
            }
            if (rasterSampleWindowController.selectAt(position) === null) {
                // Keep controls available when the requested box is rejected.
                showHistogramWorkspace();
                return true;
            }
        }
        pointSamplesController.sample(participants, point);
        if (openHistogram) {
            onSelected(getSelectedArea());
        }
        return openHistogram;
    }

    /** Cancel a pending box-size refresh without changing its current area. */
    function cancelRasterSampleWindowResize() {
        if (rasterSampleWindowResizeTimeout === null) {
            return;
        }
        clock.clearTimeout(rasterSampleWindowResizeTimeout);
        rasterSampleWindowResizeTimeout = null;
    }

    /**
     * Rebuild the selected map box around its retained center after size edits.
     *
     * The mode and bounds identity guard prevents delayed work from replacing a
     * newer map click, polygon selection selection, active raster, or comparison mode.
     *
     * @param {Object} bounds Current canonical WGS 84 selected bounds.
     * @return {void}
     */
    function scheduleRasterSampleWindowResize(bounds) {
        cancelRasterSampleWindowResize();
        const scheduledBivariateMode = bivariateMode.active;
        const [, , center] = getPresentedSampleWindow();
        rasterSampleWindowResizeTimeout = clock.setTimeout(() => {
            rasterSampleWindowResizeTimeout = null;
            const [currentBounds] = getPresentedSampleWindow();
            if (
                bivariateMode.active !== scheduledBivariateMode ||
                currentBounds !== bounds ||
                !canUseRasterMapInteractions()
            ) {
                return;
            }
            rasterSampleWindowController.selectAt({lng: center.longitude, lat: center.latitude});
        }, RASTER_SAMPLE_WINDOW_RESIZE_DEBOUNCE_MILLISECONDS);
    }

    /** Select a box at the current map center from the sampling-area control. */
    function useMapCenterForRasterStatistics() {
        if (!canUseRasterMapInteractions()) {
            renderRasterSamplingAreaControls();
            return;
        }
        if (vectorSelection && (selectedCatalogSelection?.id === vectorSelection.id || bivariateCatalogSelection?.id === vectorSelection.id)) {
            selectedCatalogSelection = null; bivariateCatalogSelection = null;
        }
        exploreAt(leafletMap.getCenter());
    }

    /**
     * Apply one valid size from either synchronized sample-window control.
     *
     * @param {string|number} value Candidate side length in kilometers.
     * @return {boolean} Whether the candidate satisfied the size contract.
     */
    function setRasterSampleWindowSize(value) {
        const sideLengthKm = Number(value);
        try {
            rasterSampleWindowController.setWindowSize(sideLengthKm);
        } catch {
            cancelRasterSampleWindowResize();
            controlsView.setSampleWindowInvalid(true);
            controlsView.setSampleWindowStatus(
                `Choose a whole-number window size from 1 through ` +
                `${MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM} km.`
            );
            return false;
        }
        controlsView.setSampleWindowInvalid(false);
        controlsView.setSampleWindowSize(sideLengthKm, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
        const [presentedBounds, presentedWindowSizeKm] =
            getPresentedSampleWindow();
        if (
            presentedBounds !== null &&
            presentedWindowSizeKm !== sideLengthKm
        ) {
            controlsView.setSampleWindowStatus(
                `Updating the selected map box to ${sideLengthKm} km × ` +
                `${sideLengthKm} km…`
            );
            scheduleRasterSampleWindowResize(presentedBounds);
        } else {
            cancelRasterSampleWindowResize();
            renderRasterSampleWindowGuidance("");
        }
        saveActiveLayerSession();
        return true;
    }

    /**
     * Restore sample controls and map interaction for a changed Item.
     *
     * @return {void}
     */
    function resetRasterSampleWindow() {
        cancelRasterSampleWindowResize();
        rasterSampleWindowController.clear();
        rasterStatisticsController.clear();
        resetPendingRasterStatisticsState();
        selectedRasterBounds = null;
        selectedCatalogSelection = null;
        selectedRasterCenter = null;
        selectedRasterWindowSizeKm = null;
        selectedRasterStatistics = null;
        selectedRasterStatisticsState = "idle";
        selectedRasterStatisticsError = null;
        setRasterSampleWindowSize(DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM);
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
    }

    /**
     * Select an explicit catalog vector and disable pointer-window previews.
     *
     * @param {Readonly<Object>} selection Catalog descriptor and display label.
     *
     * @return {void}
     */
    function useCatalogSelectionForRasterStatistics(selection) {
        invalidVectorSamplingId = null;
        if (bivariateMode.active) {
            if (!selection) return;
            selectedCatalogSelection = selection;
            selectedRasterBounds = null;
            for (const record of mapLayers.retainedRecords) {
                if (record.adapter === rasterMapLayerAdapter) replaceSessionCatalogSelection(record.state, selection);
            }
            saveActiveLayerSession();
            bivariateCatalogSelection = selection;
            bivariateSelectedBounds = null;
            rasterSampleWindowController.clear();
            renderRasterSamplingAreaControls();
            showHistogramWorkspace();
            requestBivariateStatistics();
            return;
        }
        if (
            selection === null ||
            activeRasterItem === null
        ) {
            renderRasterSamplingAreaControls();
            return;
        }
        cancelRasterSampleWindowResize();
        rasterStatisticsController.clear();
        resetPendingRasterStatisticsState();
        selectedRasterBounds = null;
        selectedCatalogSelection = selection;
        selectedRasterCenter = null;
        selectedRasterWindowSizeKm = null;
        selectedRasterStatistics = null;
        selectedRasterStatisticsState = "idle";
        selectedRasterStatisticsError = null;
        rasterSampleWindowController.clear();
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        showHistogramWorkspace();
        refreshRetainedLayerHistograms(currentRasterSamplingArea());
        if (canUseRasterMapInteractions()) {
            void rasterStatisticsController.activate(
                activeRasterItem,
                currentRasterSamplingArea()
            );
        }
        saveActiveLayerSession();
    }

    /**
     * Present one immutable exact-value snapshot in Analysis tools.
     *
     * When both bivariate axes have finite values, the same snapshot also
     * identifies their cell in the existing paired histogram. Presentation
     * visibility remains owned by the map-inspection controller.
     *
     * @param {{position:Readonly<Object>,samples:ReadonlyArray<Object>}|null}
     * snapshot Current point values or null after lifecycle clearing.
     * @return {void}
     */
    function renderRasterPointSamples(snapshot) {
        if (snapshot === null) {
            controlsView.clearPointSamples();
            return;
        }
        controlsView.renderPointSamples(snapshot);
        if (!bivariateMode.active) {
            return;
        }
        const x = snapshot.samples.find((sample) => sample.axis === "X");
        const y = snapshot.samples.find((sample) => sample.axis === "Y");
        if (x?.state === "value" && y?.state === "value") {
            controlsView.highlightPairedStatistics?.(x.value, y.value);
        }
    }

    /**
     * Present or clear one transient cursor-stack snapshot on the map.
     *
     * @param {{samples:ReadonlyArray<Object>,omittedCount:number}|null}
     * snapshot Current progressive cursor values or null after clearing.
     * @return {void}
     */
    function renderRasterCursorSamples(snapshot) {
        if (snapshot === null) {
            cursorValuesView.clear();
            return;
        }
        if (!pixelPickerEnabled || !pointerInspectionEnabled) return;
        cursorValuesView.render(snapshot);
    }

    /**
     * Enable pointer inspection when composition returns to map exploration.
     * Disabling cancels transient reads without changing the user's picker preference.
     * @param {boolean} enabled Whether pointer movement may request raster values.
     * @return {void}
     */
    function setPointerInspectionEnabled(enabled) {
        pointerInspectionEnabled = enabled;
        if (!enabled) handleMapMouseLeave();
    }

    /** Hide the pixel picker and cancel its transient sampling operation. */
    function hidePixelPicker() {
        pixelPickerEnabled = false;
        rasterCursorPosition = null;
        cursorSamplesController.clear();
        cursorValuesView.setEnabled?.(false);
    }

    /** Restore pixel sampling for the next settled map-pointer position. */
    function showPixelPicker() {
        pixelPickerEnabled = true;
        cursorValuesView.setEnabled?.(true);
    }

    /**
     * Mark the editing session's manual change and schedule its renderer update.
     * Missing sessions and paired-mode targets are ignored.
     *
     * @param {boolean} isColor Whether a color input changed.
     * @return {void}
     */
    function handleStyleInput(isColor) {
        const session = editingSession();
        if (session === null || bivariateMode.contains(session.key)) return;
        session.rasterStyleWasEdited = true;
        if (session.key === activeLayerKey) rasterStyleWasEdited = true;
        if (isColor) {
            controlsView.setPaletteName("custom");
        }
        scheduleRasterStyleCommit();
    }

    /**
     * Apply the palette selected in the controls to the editing session's style.
     *
     * @return {void}
     */
    function handlePaletteChange() {
        const paletteName = controlsView.getPaletteName();
        if (paletteName === "custom") {
            return;
        }
        const session = editingSession();
        if (session === null || bivariateMode.contains(session.key)) return;
        session.rasterStyleWasEdited = true;
        if (session.key === activeLayerKey) rasterStyleWasEdited = true;
        const candidate = validateRasterStyleControls();
        if (candidate === null) {
            controlsView.setPaletteName("custom");
            return;
        }
        controlsView.setStyle(
            applyRasterColorPalette(candidate.style, paletteName),
            paletteName
        );
        commitRasterStyle();
        controlsView.setAppearanceStatus(
            `Applied the ${RASTER_COLOR_PALETTES[paletteName].label} palette.`
        );
    }

    /**
     * Reset and commit the editing session's initial colors and reference range.
     * Missing sessions and paired-mode targets are ignored.
     *
     * @return {void}
     */
    function handleResetStyle() {
        const session = editingSession();
        if (session === null || bivariateMode.contains(session.key)) return;
        session.rasterStyleWasEdited = true;
        if (session.key === activeLayerKey) rasterStyleWasEdited = true;
        resetRasterStyle();
        commitRasterStyle();
        controlsView.setAppearanceStatus("Restored the initial colors and range.");
        resetRasterPercentileControls();
        updateRasterPercentileValues();
    }

    /**
     * Switch explicitly between one- and two-dimensional histogram modes.
     *
     * @param {string} mode Explicit mode identity.
     * @return {void}
     */
    function handleBivariateModeChange(mode) {
        if (mode === "bivariate") {
            enterBivariateMode();
            return;
        }
        if (mode === "overlay") {
            leaveBivariateMode();
            return;
        }
        throw new Error(`Unknown raster histogram mode: ${mode}`);
    }

    /**
     * Apply one of the eight shared ESOS-C coordinated palettes.
     *
     * @param {string} paletteName Registered bivariate palette identity.
     * @return {void}
     */
    function handleBivariatePaletteChange(paletteName) {
        if (!bivariateMode.active) return;
        bivariateMode.setPalette(paletteName);
        applyBivariatePresentation();
        renderLayerStack();
    }

    /**
     * Swap X/Y roles, including reference-grid statistics and retained values.
     *
     * @return {void}
     */
    function handleBivariateSwapAxes() {
        if (!bivariateMode.active) return;
        bivariateStatistics = null;
        bivariateMode.swap();
        applyBivariatePresentation();
        pointSamplesController.synchronize(rasterPointSampleParticipants());
        renderLayerStack();
        requestBivariateStatistics();
    }

    /**
     * Retry the current ordered pair and bounded area while 2D mode is active.
     *
     * @return {void}
     */
    function handleRetryPairedStatistics() {
        if (!bivariateMode.active) return;
        void pairedStatisticsController.retry();
    }

    /**
     * Preview both axes from the current paired marginals. Missing statistics,
     * invalid percentile ordering, and constant/collapsed ranges cannot apply.
     *
     * @return {Object<string,Object>} Applicable numeric ranges indexed by axis.
     */
    function updateBivariatePercentileValues() {
        const ranges = {};
        for (const axis of ["x", "y"]) {
            const percentiles = controlsView.readBivariatePercentiles(axis);
            const { lower, middle, upper } = percentiles;
            let message = "Waiting for a current 2D histogram.";
            let values = null;
            let invalid = false;
            if (![lower, middle, upper].every(Number.isFinite) ||
                !(0 <= lower && lower < middle && middle < upper && upper <= 100)) {
                message = "Choose increasing percentiles between 0 and 100.";
                invalid = true;
            } else if (bivariateMode.active && bivariateStatistics !== null) {
                const estimates = [lower, middle, upper].map((percentile) =>
                    estimateRasterPairedHistogramPercentile(bivariateStatistics, axis, percentile));
                const [minimum, midpoint, maximum] = estimates;
                values = Object.fromEntries(["lower", "middle", "upper"].map((name, index) =>
                    [name, formatRasterPixelValue(estimates[index])]));
                invalid = !(minimum < midpoint && midpoint < maximum);
                message = invalid
                    ? "These percentiles give the same value. Choose a wider range or another sample."
                    : `Estimated from ${bivariateStatistics.scope === "wholeOverlap" ? "whole overlap" : "the map sample"}; only pixels valid in both rasters.`;
                if (!invalid) ranges[axis] = { minimum, midpoint, maximum };
            }
            controlsView.renderBivariatePercentiles(axis, {
                values, range: ranges[axis] ?? null, message, invalid,
                applicable: ranges[axis] !== undefined,
            });
        }
        return ranges;
    }

    /**
     * Apply a current paired-histogram range only to the selected 2D axis.
     * Updates all color presentations together without requesting more samples.
     *
     * @param {"x"|"y"} axis Paired axis whose draft controls should be applied.
     * @return {void}
     */
    function handleApplyBivariatePercentiles(axis) {
        if (!bivariateMode.active) return;
        const range = updateBivariatePercentileValues()[axis];
        if (range === undefined) return;
        bivariateMode.setRange(bivariateMode[`${axis}Key`], range);
        applyBivariatePresentation();
        renderLayerStack();
    }

    /**
     * Apply the editing session's ordered histogram-estimated percentile range.
     * Requires applicable statistics and an ordinary, non-paired style target.
     *
     * @return {void}
     */
    function handleApplyPercentiles() {
        const session = editingSession();
        const percentiles = updateRasterPercentileValues();
        if (session === null || percentiles === null ||
            !session.rasterStatisticsIsApplicable ||
            bivariateMode.contains(session.key)) return;
        session.rasterStyleWasEdited = true;
        if (session.key === activeLayerKey) rasterStyleWasEdited = true;
        const style = deriveRasterStyleFromStatistics(
            session.rasterStyle, session.rasterStatistics, percentiles
        );
        controlsView.setStyle(style, session.paletteName);
        commitRasterStyle();
        controlsView.setAppearanceStatus("Applied the histogram percentile range.");
    }

    /**
     * Retry statistics for the current selected or whole-raster scope.
     *
     * @return {void}
     */
    function handleRetryStatistics() {
        showHistogramWorkspace();
        refreshRetainedLayerHistograms(currentRasterSamplingArea());
        if (hasSelectedRasterSamplingArea()) {
            selectedRasterStatisticsState = "idle";
            void rasterStatisticsController.activate(
                activeRasterItem,
                currentRasterSamplingArea()
            );
        } else {
            wholeRasterStatisticsState = "idle";
            void rasterStatisticsController.activate(
                activeRasterItem,
                WHOLE_RASTER_SAMPLING_AREA
            );
        }
    }

    /**
     * Restore the last valid sample-window size after a completed invalid edit.
     *
     * @param {string} value Candidate numeric side length.
     * @return {void}
     */
    function handleSampleWindowNumberChange(value) {
        if (!setRasterSampleWindowSize(value)) {
            setRasterSampleWindowSize(rasterSampleWindowController.windowSizeKm);
        }
    }

    /**
     * Restore whole-raster statistics from an explicit control action and
     * reveal the contextual histogram that receives the restored result.
     *
     * @return {void}
     */
    function handleClearSampleWindow() {
        cancelRasterSampleWindowResize();
        restoreWholeRasterStatistics();
        if (!bivariateMode.active) {
            refreshRetainedLayerHistograms(WHOLE_RASTER_SAMPLING_AREA);
        }
        showHistogramWorkspace();
    }

    /**
     * Preview the histogram sample window for one Leaflet map position.
     *
     * @param {Object} mapEvent Leaflet mousemove event in the single map world.
     * @return {void}
     */
    function handleMapMouseMove(mapEvent) {
        if (!pointerInspectionEnabled) return;
        const point = {
            longitude: mapEvent.latlng.lng,
            latitude: mapEvent.latlng.lat,
        };
        if (!isCanonicalWgs84Position(point)) {
            rasterSampleWindowController.clearPreview();
            rasterCursorPosition = null;
            cursorSamplesController.clear();
            return;
        }
        if (canUseRasterMapInteractions()) {
            rasterSampleWindowController.previewAt(mapEvent.latlng);
        } else {
            rasterSampleWindowController.clearPreview();
        }
        if (mapDragging) {
            return;
        }
        if (!pixelPickerEnabled) {
            return;
        }
        cursorValuesView.move?.({
            clientX: mapEvent.originalEvent?.clientX,
            clientY: mapEvent.originalEvent?.clientY,
        });
        rasterCursorPosition = Object.freeze(point);
        cursorSamplesController.move(
            rasterCursorSampleParticipants(),
            point
        );
    }

    /**
     * Remove the sample-window preview after the pointer leaves the map.
     *
     * @return {void}
     */
    function handleMapMouseLeave() {
        rasterSampleWindowController.clearPreview();
        rasterCursorPosition = null;
        cursorSamplesController.clear();
    }

    /** Suspend reads and clear screen anchors while the map moves. @return {void} */
    function handleMapDragStart() {
        mapDragging = true;
        rasterCursorPosition = null;
        cursorSamplesController.clear();
    }

    /** Resume dwell-based sampling after map movement completes. @return {void} */
    function handleMapDragEnd() {
        mapDragging = false;
    }

    /**
     * Remove one Catalog Item from the retained layer stack.
     *
     * @param {Object} item Catalog STAC Item.
     * @return {void}
     */
    function remove(item) {
        mapLayers.remove(item);
        renderLayerHistogramSummaries();
    }

    /**
     * Remove every retained raster and interaction.
     *
     * @return {void}
     */
    function clear() {
        clearing = true;
        editingLayerKey = null;
        cancelRasterSampleWindowResize();
        if (rasterStyleCommitTimeout !== null) {
            clock.clearTimeout(rasterStyleCommitTimeout);
            rasterStyleCommitTimeout = null;
        }
        leaveBivariateMode(null, false);
        deactivateActiveLayer();
        mapLayers.deactivatePresentation();
        analysisRasterSession = null;
        mapLayers.removeOwned(rasterMapLayerAdapter);
        pointSamplesController.clear();
        cursorSamplesController.clear();
        rasterStatisticsController.clear();
        pairedStatisticsController.clear();
        rasterSampleWindowController.clear();
        activeRasterItem = null;
        activeLayerKey = null;
        rasterStyle = { ...DEFAULT_RASTER_STYLE };
        rasterStyleWasEdited = false;
        rasterStatistics = null;
        rasterStatisticsIsApplicable = false;
        wholeRasterStatistics = null;
        wholeRasterStatisticsState = "idle";
        wholeRasterStatisticsError = null;
        selectedRasterBounds = null;
        selectedCatalogSelection = null;
        selectedRasterCenter = null;
        selectedRasterWindowSizeKm = null;
        selectedRasterStatistics = null;
        selectedRasterStatisticsState = "idle";
        selectedRasterStatisticsError = null;
        bivariateStatistics = null;
        bivariateCandidates = [];
        bivariateSelectedBounds = null;
        bivariateSelectedCenter = null;
        bivariateSelectedWindowSizeKm = null;
        controlsView.setControlsVisible(false);
        controlsView.renderLayerHistograms([], null);
        controlsView.clearPointSamples();
        cursorValuesView.clear();
        controlsView.renderBivariateMode?.({ active: false });
        controlsView.setAppearanceEnabled?.(true);
        controlsView.setUnivariateHistogramVisible?.(true);
        controlsView.setSamplingAreaMode("none", "No raster selected");
        renderBivariateAvailability();
        visibleHistogramSignature = null;
        rasterCursorPosition = null;
        mapDragging = false;
        clearing = false;
        onHistogramChange(null);
    }

    /**
     * Clear all retained raster interactions and restore default style inputs.
     *
     * @return {void}
     */
    function reset() {
        clear();
        resetRasterStyle();
    }

    /**
     * Publish and retain one selected Catalog raster.
     *
     * @param {Object} item Selected mounted GeoTIFF STAC Item.
     * @return {Promise<Object|null>} Published raster or null after invalidation.
     * @throws {Error} If publication or Leaflet layer construction fails.
     */
    async function show(item) {
        const publication = await mapLayers.show(item, rasterMapLayerAdapter);
        renderLayerHistogramSummaries();
        return publication;
    }

    /**
     * Publish and construct one raster layer without retaining or attaching it.
     *
     * @param {Object} item Selected mounted GeoTIFF STAC Item.
     * @param {{visible:boolean,opacity:number}} presentation Initial neutral
     * layer visibility and opacity.
     * @return {Promise<{key:string,record:Object,layer:Object}>} Detached raster
     * layer prepared by the neutral retained-layer owner.
     */
    function stage(item, presentation) {
        return mapLayers.stage(item, rasterMapLayerAdapter, presentation);
    }

    /**
     * Validate a descriptor and label received from browser composition.
     *
     * @param {Readonly<Object>|null} value Candidate descriptor and display label.
     * @return {Readonly<Object>|null} Validated immutable snapshot or null.
     * @throws {TypeError} If identity or predicate fields are invalid.
     */
    function validateCatalogSelectionSamplingSnapshot(value) {
        if (value === null) return null;
        const area = normalizeRasterSamplingArea({ kind: "catalogSelection", catalogSelection: value.selection });
        return Object.freeze({ selection: area.catalogSelection, id: JSON.stringify(area.catalogSelection),
            filename: value.label, selectedDataset: area.catalogSelection.layerName });
    }

    /**
     * Invalidate a session's result when its catalog selection changes.
     *
     * @param {Object} session Retained raster-layer interaction session.
     * @param {Readonly<Object>|null} nextCatalogSelection Replacement descriptor and label, or null for whole-raster sampling.
     * @return {void}
     */
    function replaceSessionCatalogSelection(session, nextCatalogSelection) {
        session.selectedRasterBounds = null;
        session.selectedCatalogSelection = nextCatalogSelection;
        session.selectedRasterCenter = null;
        session.selectedRasterWindowSizeKm = null;
        session.selectedRasterStatistics = null;
        session.selectedRasterStatisticsState = "idle";
        session.selectedRasterStatisticsError = null;
        session.rasterStatisticsIsApplicable = false;
    }

    /**
     * Adopt or invalidate a composition-supplied catalog vector selection.
     *
     * @param {Object|null} selection Catalog descriptor and label, or null to invalidate.
     * @return {void}
     */
    function setVectorSelection(selection) {
        const previous = vectorSelection;
        vectorSelection = validateCatalogSelectionSamplingSnapshot(selection);
        if (selection) {
            useCatalogSelectionForRasterStatistics(vectorSelection);
            return;
        }
        if (!previous) return;
        invalidVectorSamplingId = previous.id;
        const message = "Vector selection changed. Use these features again, or choose another sampling area.";
        for (const record of mapLayers.retainedRecords) {
            if (record.state.selectedCatalogSelection?.id === previous.id) {
                cancelLayerHistogramRequest(record.state);
                replaceSessionCatalogSelection(record.state, previous);
                record.state.selectedRasterStatisticsState = "error";
                record.state.selectedRasterStatisticsError = new Error(message);
            }
        }
        if (selectedCatalogSelection?.id === previous.id) {
            rasterStatisticsController.clear();
            selectedRasterStatistics = null;
            selectedRasterStatisticsState = "error";
            selectedRasterStatisticsError = new Error(message);
            resetPendingRasterStatisticsState();
            if (activeLayerKey) loadActiveLayerSession(activeDetachedRasterSession() ?? requireLayerSession(activeLayerKey));
            controlsView.clearStatistics();
            controlsView.setStatisticsStatus(message);
        }
        if (bivariateCatalogSelection?.id === previous.id) {
            pairedStatisticsController.clear();
            bivariateStatistics = null;
            controlsView.clearPairedStatistics?.();
            controlsView.setSampleWindowStatus(message);
        }
        renderLayerHistogramSummaries();
        renderRasterSamplingAreaControls();
    }

    /** @param {Object} item Catalog Item. @return {boolean} Whether it is retained. */
    function contains(item) {
        return mapLayers.contains(item);
    }

    /**
     * Permanently detach the viewer from DOM and Leaflet event sources.
     * The viewer must not be reused after this call.
     *
     * @return {void}
     */
    function destroy() {
        clear();
        controlsView.unbind();
        if (ownsMapLayerController) {
            mapLayers.destroy();
        }
        cursorValuesView.unbind?.();
        mapContainer.removeEventListener("mouseleave", handleMapMouseLeave);
        leafletMap.off("mousemove", handleMapMouseMove);
        leafletMap.off("dragstart", handleMapDragStart);
        leafletMap.off("dragend", handleMapDragEnd);
        leafletMap.off("movestart", handleMapDragStart);
        leafletMap.off("moveend", handleMapDragEnd);
        leafletMap.off("resize", handleMapMouseLeave);
    }

    controlsView.populatePalettes(RASTER_COLOR_PALETTES);
    controlsView.bind({
        onStyleInput: handleStyleInput,
        onStyleChange: commitRasterStyle,
        onPaletteChange: handlePaletteChange,
        onResetStyle: handleResetStyle,
        onPercentileInput: updateRasterPercentileValues,
        onApplyPercentiles: handleApplyPercentiles,
        onOpenHistogram: showHistogramWorkspace,
        onRetryStatistics: handleRetryStatistics,
        /**
         * Retry the active histogram or a visible secondary raster's request.
         * Missing or hidden secondary targets are ignored.
         *
         * @param {string} key Stable raster key supplied by the histogram view.
         * @return {void}
         */
        onRetryHistogram: (key) => {
            if (key === activeLayerKey) handleRetryStatistics();
            else {
                const record = visibleRasterRecords().find(
                    /**
                     * Match the requested histogram to a visible raster.
                     * @param {{entry:Object}} record Visible raster record.
                     * @return {boolean} Whether this record owns the retry action.
                     */
                    ({ entry }) => entry.key === key
                );
                if (record) void requireLayerHistogramController(record.state).retry();
            }
        },
        onSelectHistogram: handleSelectLayerHistogram,
        onStyleHistogram: onStyleRequested,
        onDownloadHistogram: downloadHistogram,
        onCalculateHistogram: calculateHistogram,
        onCalculatePairedHistogram: calculatePairedHistogram,
        onDownloadPairedHistogram: downloadPairedHistogram,
        onSampleWindowRangeInput: setRasterSampleWindowSize,
        onSampleWindowNumberInput: setRasterSampleWindowSize,
        onSampleWindowNumberChange: handleSampleWindowNumberChange,
        onClearSampleWindow: handleClearSampleWindow,
        onUseMapWindow: useMapCenterForRasterStatistics,
        onBivariateModeChange: handleBivariateModeChange,
        onBivariatePaletteChange: handleBivariatePaletteChange,
        onBivariateSwapAxes: handleBivariateSwapAxes,
        onBivariatePercentileInput: updateBivariatePercentileValues,
        onApplyBivariatePercentiles: handleApplyBivariatePercentiles,
        onRetryPairedStatistics: handleRetryPairedStatistics,
    });
    const mapContainer = leafletMap.getContainer();
    cursorValuesView.bind?.({
        onHide: hidePixelPicker,
        onShow: showPixelPicker,
    });
    cursorValuesView.setEnabled?.(true);
    leafletMap.on("mousemove", handleMapMouseMove);
    leafletMap.on("dragstart", handleMapDragStart);
    leafletMap.on("dragend", handleMapDragEnd);
    leafletMap.on("movestart", handleMapDragStart);
    leafletMap.on("moveend", handleMapDragEnd);
    leafletMap.on("resize", handleMapMouseLeave);
    mapContainer.addEventListener("mouseleave", handleMapMouseLeave);

    resetRasterSampleWindow();
    resetRasterStyle();
    controlsView.renderBivariateMode?.({ active: false });
    renderBivariateAvailability();
    return {
        clear,
        reset,
        show,
        stage,
        syncVisibleLayers,
        setPointerInspectionEnabled,
        exploreAt,
        openStyle,
        openPairedStyle,
        closeStyle,
        refreshStyle,
        activateAnalysis,
        deactivateAnalysis,
        contains,
        remove,
        setVectorSelection,
        getSelectedArea,
        setSamplingActivity: area => rasterSampleWindowController.setActivityBounds(area?.kind === "selectedArea" ? area.selectedBounds : null),
        destroy,
        /**
         * Return whether at least one raster layer is currently displayed.
         *
         * @return {boolean} Whether any raster layer is displayed.
         */
        get isDisplayed() {
            return mapLayers.visibleCountFor(rasterMapLayerAdapter) > 0;
        },
    };
}
