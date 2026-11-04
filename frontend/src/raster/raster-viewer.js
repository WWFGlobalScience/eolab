/**
 * Coordinate ordinary raster styling, analysis presentation and map interactions.
 *
 * This module connects publication, Leaflet layers, raster controls,
 * statistics, selected-area sampling, styling, and exact point values. It owns
 * their shared lifecycle and stale-work rules while delegating domain logic,
 * HTTP access, DOM presentation, and Leaflet construction to focused modules.
 */
import { samplingBoxBounds } from "../sampling-box.js";
import { rasterSourceKey, rasterSourceReference } from "../raster-source.js";
import { publishRasterSource } from "./api.js";
import { loadTemporalTimes } from "./temporal-api.js";
import { TemporalControlsView } from "./temporal-controls-view.js";
import {
    loadRasterStatistics,
    loadRasterPairedStatistics,
    RasterAnalysisRequestError,
    isRasterStatisticsCapacityError,
    sampleRasterPixel,
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
    setRasterWmsStyle,
} from "./leaflet.js";
import { MapLayerController } from "../map-layers/controller.js";
import { MapLayerStackView } from "../map-layers/layer-stack-view.js";
import { RasterCursorSamplesController } from "./cursor-samples.js";
import { RasterPointSamplesController } from "./point-samples.js";
import {
    formatRasterPixelValue,
    getRasterDisplayName,
    getRasterDisplayStem,
} from "./value-format.js";
import { RasterSampleWindowController } from "./sample-window-controller.js";
import {
    DEFAULT_RASTER_PERCENTILES,
    normalizeRasterSamplingArea,
    rasterStatisticsMatchesSelection,
    WHOLE_RASTER_SAMPLING_AREA,
} from "./statistics.js";
import { rasterStatisticsMatchCategories } from "./categorical-statistics.js";
import { RasterStatisticsController } from "./statistics-controller.js";
import { requestRasterStatistics } from "./statistics-request.js";
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
} from "./style.js";
import { buildRasterStyleEnvironment, buildCategoricalRasterStyleParameter } from "./wms.js";
import { normalizeRasterAppearanceState } from "./appearance-state.js";
import {
    buildCategoricalRasterLegend,
    presentRasterPixelSnapshot,
    presentCategoricalRasterDistribution,
} from "./categorical-presentation.js";
import { RasterControlsView } from "./controls-view.js";

/**
 * Statistics and sampling state owned by a single raster, with or without WMS.
 *
 * @typedef {Object} RasterAnalysisState
 * @property {Object|null} rasterStatistics Last presented statistics, possibly stale.
 * @property {boolean} rasterStatisticsIsApplicable Whether percentiles may be applied.
 * @property {Object|null} wholeRasterStatistics Last successful whole-raster result.
 * @property {"idle"|"loading"|"ready"|"error"} wholeRasterStatisticsState Request status.
 * @property {Error|null} wholeRasterStatisticsError Current whole-raster failure.
 * @property {Readonly<Object>|null} selectedRasterBounds Read-window envelope; a box retains its separate center and size.
 * @property {Readonly<Object>|null} selectedCatalogSelection Catalog predicate and label.
 * @property {Readonly<{longitude:number,latitude:number}>|null} selectedRasterCenter Original click.
 * @property {number|null} selectedRasterWindowSizeKm Selected map-window side length.
 * @property {Object|null} selectedRasterStatistics Last successful selected-area result.
 * @property {"idle"|"loading"|"ready"|"error"} selectedRasterStatisticsState Request status.
 * @property {Error|null} selectedRasterStatisticsError Current selected-area failure.
 * @property {string|null} statisticsCategoryIdentity Category codes used by the latest request.
 */

const RASTER_STYLE_DEBOUNCE_MILLISECONDS = 200;
const MAXIMUM_VISIBLE_RASTER_HISTOGRAMS = 16;
const CATEGORICAL_HISTOGRAM_MESSAGE = "Categorical areas need a matching native raster sample.";
export const RASTER_SAMPLE_WINDOW_RESIZE_DEBOUNCE_MILLISECONDS = 350;
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
        normalizeRasterAppearanceState(savedState);
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
 * @property {(raster:import('../raster-source.js').RasterDescriptor,lifecycle:Object,presentation?:Object)=>Promise<Object|null>}
 * showSource Retain an authorized original raster through the same controls.
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
 * @property {()=>Readonly<Object>|null} selectSamplingBox Capture a geodesic box at the map center,
 * returning null when its pole/date-line boundary is unsupported.
 * @property {(area:Object|null)=>void} setSamplingActivity Mark the matching committed box or rectangle
 * while a calculation uses it, without changing the selected geometry.
 * @property {(item:Object,selection?:Object,presentation?:Object)=>Promise<Object|null>} showTemporal Retain an independent temporal view.
 * @property {()=>Promise<void>} refreshTemporalLayers Reload retained temporal availability after server refresh.
 * @property {(item:Object)=>string|null} temporalLayerKey First retained view of this Catalog dataset.
 * @property {(item:Object)=>boolean} containsTemporal Whether a temporal view is retained.
 * @property {(item:Object,allowUndo?:boolean)=>void} removeTemporal Remove the first view of a dataset.
 * @property {(record:Object)=>Object|null} exportTemporal Copy one temporal selection and appearance for a saved map.
 * @property {(layer:Object,item:Object,isCurrent:()=>boolean)=>Promise<string|null>} restoreTemporal Restore an explicit saved observation.
 * @property {() => void} destroy Permanently detach viewer listeners; the
 * viewer must not be reused afterward.
 * @property {boolean} isDisplayed Whether any raster layer is visible.
 */

/**
 * @typedef {Object} RasterViewerConfiguration
 * @property {string} wmsUrl Browser-facing GeoServer WMS endpoint.
 * @property {Object} leafletMap Initialized Leaflet-compatible map.
 * @property {Object} leaflet Leaflet namespace with WMS and polygon factories.
 * @property {(message: string, item: Object) => void} onTileError Reports a
 * layer-specific tile error.
 * @property {(item:Object)=>void} [onTemporalInfo] Open Catalog details for a retained temporal dataset.
 * @property {(layers: Object[]) => void} [onLayersChange] Receives retained
 * layer snapshots after state changes.
 * @property {() => void} [onHistogramRequested] Notifies the composition root
 * that an explicit analysis action should reveal its presentation workspace.
 * @property {(snapshot:{state:string,message:string,source:string,scope:string}|null)=>void} [onHistogramChange]
 * Receives current histogram participation, owned source/area labels and status without exposing analysis state.
 * @property {(method:"box"|"whole"|"vector")=>void} [onSamplingMethodChange]
 * Notify composition when the user chooses an area method, so obsolete vector reads can be cancelled.
 * @property {(key:string) => void} [onStyleRequested] Notifies the composition
 * root that a histogram action should open one retained layer's style editor.
 * @property {(item:Object,area:Readonly<Object>|null,label:string)=>void} [onDownloadRequested]
 * Notify composition of a raster, its explicit selected area and originating view name.
 * @property {(item:Object,area:Readonly<Object>|null,label:string,key:string)=>void} [onCalculateRequested]
 * Calculate the original raster with its explicit area and originating view name/key.
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
 * @property {(item:Object,variable:string,month?:string,signal?:AbortSignal)=>Promise<Object>}
 * [loadTimes=loadTemporalTimes] Fetch admitted months and actual observation times.
 * @property {(callbacks:Object)=>TemporalControlsView} [temporalControlsFactory] Create retained variable and time controls.
 * @property {(identity:{collection:string,id:string})=>Promise<Object>} [getTemporalItem] Read refreshed Catalog metadata.
 * @property {(item:Object,fetcher?:Function,signal?:AbortSignal)=>Promise<Object>}
 * [publishRaster=publishRasterSource] Publishes one original raster.
 * @property {(item: Object, samplingArea:Object, signal:AbortSignal)
 * => Promise<Object>} [loadStatistics=loadRasterStatistics] Loads whole
 * or selected statistics.
 * @property {(item: Object, point: Object, signal: AbortSignal)
 * => Promise<Object>} [samplePixel=sampleRasterPixel] Samples one raster
 * pixel.
 * @property {(item: Object, point: Object, signal: AbortSignal)
 * => Promise<Object>} [sampleCursorPixel=samplePixel] Samples one transient
 * cursor participant independently from retained click analysis.
 * @property {{render:(snapshot:Object)=>void,clear:()=>void,move?:Function,
 * setEnabled?:Function,bind?:Function,unbind?:Function,
 * refreshPresentation?:(projectSnapshot:(snapshot:Object)=>Object)=>void}|null}
 * [cursorValuesView=null] Transient pixel-picker presentation adapter.
 * @property {(xItem:Object,yItem:Object,area:Object,signal:AbortSignal)
 * =>Promise<Object>} [loadPairedStatistics=loadRasterPairedStatistics]
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
        onTemporalInfo = /** @param {Object} _item Temporal Catalog Item. @return {void} */ (_item) => {},
        onCalculateRequested = /** @param {Object} _item Original raster. @param {Object|null} _area Histogram scope. @param {string} _label View name. @param {string} _key View identity. @return {void} */ (_item, _area, _label, _key) => {},
        onHistogramChange = () => {},
        onSamplingAreaChange = () => {},
        onSamplingMethodChange = () => {},
        onDownloadRequested = /** @param {Object} _item Catalog source. @param {Object|null} _area Explicit selection. @param {string} _label View name. @return {void} */ (_item, _area, _label) => {},
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
        publishRaster = publishRasterSource,
        loadTimes = loadTemporalTimes,
        temporalControlsFactory = callbacks => new TemporalControlsView(callbacks),
        getTemporalItem,
        loadStatistics = loadRasterStatistics,
        samplePixel = sampleRasterPixel,
        sampleCursorPixel = samplePixel,
        loadPairedStatistics = loadRasterPairedStatistics,
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
    /**
     * Request ordinary statistics independently, retrying temporary server overload.
     * @param {Object} item Catalog raster to analyze.
     * @param {Object} area Normalized whole, bounds, or polygon selection sampling area.
     * @param {AbortSignal} signal Controller-owned cancellation signal.
     * @param {Object|null} [session] Owning view, or the active renderer-independent analysis session.
     * @return {Promise<Object>} Statistics or the final read/abort failure.
     */
    function loadStatisticsWithRetry(item, area, signal, session = mapLayers.getRecord(activeLayerKey)?.state ?? analysisRasterSession) {
        const codes = sessionCategoryValues(session);
        if (session) session.analysis.statisticsCategoryIdentity = JSON.stringify(codes === null ? null : [...codes].sort((a, b) => a - b));
        return requestRasterStatistics(() => loadStatistics(item, area, signal, undefined, codes), signal, clock);
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
    let editingAppearanceMode = "continuous";
    let followsVisibleLayers = false;
    let visibleHistogramSignature = null;
    let clearing = false;
    let mapDragging = false;
    let pixelPickerEnabled = true;
    let pointerInspectionEnabled = true;
    let rasterCursorPosition = null;
    let rasterStyleCommitTimeout = null;
    const histogramStyleTimers = new Map();
    let bivariateStyleTimeout = null;
    /** @type {Map<string, import("./percentile-controls-view.js").HistogramPercentileSettings>} Pair-local settings by retained view identity. */
    const bivariatePercentiles = new Map();
    let rasterSampleWindowResizeTimeout = null;
    let rasterStyleWasEdited = false;
    let activeRasterItem = null;
    let rasterAnalysis = createRasterAnalysisState();
    const bivariateMode = new BivariateRasterMode();
    let bivariateCandidates = [];
    let bivariateStatistics = null;
    let pairedHistogramState = "idle";
    let bivariateSelectedBounds = null;
    let bivariateCatalogSelection = null;
    let vectorSelection = null;
    let invalidVectorSamplingId = null;
    let pendingVectorSelection = false;
    let bivariateSelectedCenter = null;
    let bivariateSelectedWindowSizeKm = null;

    /**
     * Create the authoritative statistics and sampling state for one raster.
     *
     * Whole-raster and selected-area results are separate caches. The presented
     * result may remain visible as a reference while a replacement is pending.
     *
     * @param {Readonly<Object>|null} [selection=null] Initial catalog selection.
     * @return {RasterAnalysisState} Mutable state owned by one raster session.
     */
    function createRasterAnalysisState(selection = null) {
        return {
            rasterStatistics: null,
            rasterStatisticsIsApplicable: false,
            wholeRasterStatistics: null,
            wholeRasterStatisticsState: "idle",
            wholeRasterStatisticsError: null,
            // Bounds only screen/read candidate sources; box membership uses its
            // captured center and size, independently of the display outline.
            selectedRasterBounds: null,
            selectedCatalogSelection: selection,
            selectedRasterCenter: null,
            selectedRasterWindowSizeKm: null,
            selectedRasterStatistics: null,
            selectedRasterStatisticsState: "idle",
            selectedRasterStatisticsError: null,
            statisticsCategoryIdentity: null,
        };
    }

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
     * Create interaction state shared by catalog and private raster layers.
     *
     * @param {Object} entry Pure stack entry.
     * @param {Object} publishedRaster Display metadata, including original geographic bounds.
     * @return {Object} Per-layer state restored on activation.
     */
    function createLayerSession(entry, publishedRaster) {
        return {
            key: entry.key,
            item: entry.item,
            label: entry.label,
            publishedRaster,
            appearanceMode: "continuous",
            categoricalStyle: null,
            rasterStyle: { ...DEFAULT_RASTER_STYLE },
            paletteName: DEFAULT_RASTER_PALETTE_NAME,
            rasterStyleWasEdited: false,
            histogramPercentiles: { ...DEFAULT_RASTER_PERCENTILES, rescale: false },
            histogramPercentileError: "",
            analysis: createRasterAnalysisState(initialPolygonSamplingArea()),
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
            key: `analysis:${rasterSourceKey(item)}`,
            item,
            label: getRasterDisplayName(item),
            rasterStyle: { ...DEFAULT_RASTER_STYLE },
            paletteName: DEFAULT_RASTER_PALETTE_NAME,
            rasterStyleWasEdited: false,
            histogramPercentiles: { ...DEFAULT_RASTER_PERCENTILES, rescale: false },
            histogramPercentileError: "",
            analysis: createRasterAnalysisState(initialPolygonSamplingArea()),
        };
    }

    /**
     * Hand the same raster's sampling state and results to another owner.
     *
     * The analysis object follows the active owner; controllers and Leaflet
     * resources stay with their existing session.
     *
     * @param {Object} target New renderer or detached raster session.
     * @param {Object} source Existing session for the same raster.
     * @return {void}
     */
    function adoptRasterInteractionState(target, source) {
        target.analysis = source.analysis;
        target.rasterStyle = { ...source.rasterStyle };
        target.paletteName = source.paletteName;
        target.rasterStyleWasEdited = source.rasterStyleWasEdited;
        target.histogramPercentiles = { ...source.histogramPercentiles, rescale: false };
    }

    /**
     * Detach renderer-neutral state from a renderer session.
     *
     * @param {Object} source Active WMS session.
     * @return {Object} Analysis-only session with the same area and controls.
     */
    function detachAnalysisSession(source) {
        const session = createAnalysisSession(source.item);
        adoptRasterInteractionState(session, source);
        return session;
    }

    /**
     * Return analysis-only state when it belongs to one Catalog raster.
     *
     * @param {Object} item Candidate Catalog raster Item.
     * @return {Object|null} Matching analysis session or null.
     */
    function matchingAnalysisSession(item) {
        const expectedKey = `analysis:${rasterSourceKey(item)}`;
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
     * @param {string} key Catalog source identity or retained view key.
     * @return {Object|null} Current raster session or null.
     */
    function getBivariateCandidateSession(key) {
        const retainedSession = mapLayers.getRecord(key)?.state ?? mapLayers.retainedRecords.find(record =>
            record.adapter === rasterMapLayerAdapter && rasterSourceKey(record.state.item) === key)?.state ?? null;
        if (retainedSession !== null) {
            return retainedSession;
        }
        const session = analysisRasterSession;
        if (
            session !== null &&
            (rasterSourceKey(session.item) === key || session.key === key)
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
        const key = rasterSourceKey(session.item);
        const candidate = bivariateCandidates.find(current => current.key === session.key) ?? bivariateCandidates.find(
            /**
             * Match a Catalog-selected candidate by source identity.
             * @param {Object} current Candidate with a stable key.
             * @return {boolean} Whether it belongs to the session being saved.
             */
            (current) => current.key === key
        );
        if (candidate === undefined) {
            return;
        }
        candidate.item = session.item;
        candidate.label = session.label;
        candidate.appearanceMode = session.appearanceMode ?? "continuous";
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
        const key = rasterSourceKey(item);
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
            label: liveSession?.label ?? getRasterDisplayName(item),
            appearanceMode: liveSession?.appearanceMode ?? "continuous",
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
     * Retain active appearance edits and refresh the session's presentations.
     *
     * Analysis changes already belong to the session and need no synchronization.
     *
     * @return {void}
     */
    function refreshActiveSessionPresentation() {
        if (activeLayerKey === null) {
            return;
        }
        const session = activeDetachedRasterSession() ??
            requireLayerSession(activeLayerKey);
        session.rasterStyle = { ...rasterStyle };
        session.paletteName = activePaletteName;
        session.rasterStyleWasEdited = rasterStyleWasEdited;
        syncBivariateCandidate(session);
        refreshStyle();
        if (session.analysis.rasterStatistics && session.appearanceMode !== "categorical") {
            controlsView.renderHistogram(session.analysis.rasterStatistics, session.rasterStyle,
                getHistogramValueLabel(session.item), getHistogramPercentileContext(session));
        }
        publishHistogramPresentation();
    }

    /**
     * Select a session's authoritative analysis state and its appearance controls.
     *
     * @param {Object} session Renderer or detached raster session.
     * @return {void}
     */
    function selectActiveRasterSession(session) {
        activeLayerKey = session.key;
        activeRasterItem = session.item;
        rasterAnalysis = session.analysis;
        rasterStyle = { ...session.rasterStyle };
        activePaletteName = session.paletteName;
        rasterStyleWasEdited = session.rasterStyleWasEdited;
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
     * Create one passive preview or committed sampling outline.
     *
     * @param {Array} bounds Leaflet rectangle bounds.
     * @param {"preview"|"selection"} layerKind Layer purpose.
     * @param {import("../sampling-box.js").SamplingBox|null} samplingBox Captured geodesic geometry.
     * @return {Object} Leaflet polygon with display-only geometry updates.
     */
    function createSampleWindowLayer(bounds, layerKind, samplingBox) {
        return createRasterSampleWindowLayer(leaflet, bounds, layerKind, samplingBox, leafletMap);
    }

    const pointSamplesController = new RasterPointSamplesController(
        samplePixel,
        highlightPairedHistogramPoint
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
        loadStatisticsWithRetry,
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
        (pair, samplingArea, signal) => requestRasterStatistics(() => loadPairedStatistics(
            pair.xItem,
            pair.yItem,
            samplingArea,
            signal
        ), signal, clock),
        /**
         * Announce a new paired request; target, area, and context are unused.
         *
         * @return {void}
         */
        () => {
            cancelBivariateStyleUpdate();
            bivariateStatistics = null;
            pairedHistogramState = "loading";
            publishHistogramPresentation();
            updateBivariatePercentileValues();
            controlsView.setPairedStatisticsLoading?.(
                "Calculating the 2D histogram..."
            );
        },
        /**
         * Retain paired statistics and initialize or match pair-local percentile ranges.
         * Ignores the response if 2D mode or its pair is no longer available.
         *
         * @param {Object} statistics Validated paired histogram and its marginal distributions.
         * @return {void}
         */
        (statistics) => {
            if (!bivariateMode.active) return;
            bivariateStatistics = statistics;
            pairedHistogramState = "ready";
            if (getBivariatePairCandidates() === null) return;
            if (applyBivariatePercentileRanges(true)) {
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
     * @return {{state:string,statistics:Object|null,scope:string,error:Error|null}}
     * One sampling scope's result, lifecycle and failure for analysis/style presentation.
     */
    function getLayerHistogramPresentation(session) {
        if (session.analysis.selectedCatalogSelection !== null) {
            return {
                state: session.analysis.selectedRasterStatisticsState,
                statistics: session.analysis.selectedRasterStatistics,
                scope: `Selected polygons · ${session.analysis.selectedCatalogSelection.filename}`,
                error: session.analysis.selectedRasterStatisticsError,
            };
        }
        if (session.analysis.selectedRasterBounds !== null) {
            return {
                state: session.analysis.selectedRasterStatisticsState,
                statistics: session.analysis.selectedRasterStatistics,
                scope: session.analysis.selectedRasterWindowSizeKm === null
                    ? "Sampling box"
                    : `Sampling box · ${session.analysis.selectedRasterWindowSizeKm} × ${session.analysis.selectedRasterWindowSizeKm} km`,
                error: session.analysis.selectedRasterStatisticsError,
            };
        }
        return {
            state: session.analysis.wholeRasterStatisticsState,
            statistics: session.analysis.wholeRasterStatistics,
            scope: "Whole raster",
            error: session.analysis.wholeRasterStatisticsError,
        };
    }

    /**
     * Describe percentile inspection and whether this view can rescale now.
     * Pending samples retain their style but cannot recolor from older results.
     * @param {Object} session Raster session owning the sample and style.
     * @return {{key:string,settings:import("./percentile-controls-view.js").HistogramPercentileSettings,canRescale:boolean,message:string}} Histogram controls context.
     */
    function getHistogramPercentileContext(session) {
        const presentation = getLayerHistogramPresentation(session);
        let message = "";
        if (session.appearanceMode === "categorical" || bivariateMode.contains(session.key)) {
            message = "Color rescaling is available for continuous raster colors.";
        } else if (rasterSampleWindowResizeTimeout !== null || pendingVectorSelection ||
            presentation.state !== "ready" || !session.analysis.rasterStatisticsIsApplicable) {
            message = "Waiting for a usable histogram for this area. Current colors are unchanged.";
        } else {
            try {
                deriveRasterStyleFromStatistics(session.rasterStyle, presentation.statistics, session.histogramPercentiles);
            } catch (error) {
                message = error.message;
            }
        }
        if (!message && !session.layer) message = "Add this raster to the map to rescale its colors.";
        if (!message) message = session.histogramPercentileError;
        return { key: session.key, settings: session.histogramPercentiles, canRescale: !message, message };
    }

    /**
     * Cancel a queued color update for one view without changing its last style.
     * @param {string} key View identity.
     * @return {void}
     */
    function cancelHistogramStyleUpdate(key) {
        const pending = histogramStyleTimers.get(key);
        if (!pending) return;
        clock.clearTimeout(pending.timer);
        histogramStyleTimers.delete(key);
    }

    /**
     * Coalesce one view's percentile edits while continuing to update during dragging.
     * The timer keeps its original deadline and reads the latest settings and colors.
     * Replacement samples and removed views cannot receive an older queued update.
     * @param {Object} session Raster view owning the accepted histogram.
     * @return {void}
     */
    function scheduleHistogramStyleUpdate(session) {
        if (!session.histogramPercentiles.rescale || !getHistogramPercentileContext(session).canRescale) {
            cancelHistogramStyleUpdate(session.key);
            return;
        }
        const statistics = getLayerHistogramPresentation(session).statistics;
        const pending = histogramStyleTimers.get(session.key);
        if (pending) {
            pending.statistics = statistics;
            return;
        }
        const update = { statistics, timer: null };
        update.timer = clock.setTimeout(() => {
            histogramStyleTimers.delete(session.key);
            if (mapLayers.getRecord(session.key)?.state !== session ||
                !session.histogramPercentiles.rescale || !getHistogramPercentileContext(session).canRescale ||
                getLayerHistogramPresentation(session).statistics !== update.statistics) return;
            const style = deriveRasterStyleFromStatistics(
                session.rasterStyle, update.statistics, session.histogramPercentiles
            );
            try {
                applySessionStyle(session, style, session.paletteName, true);
                if (editingLayerKey === session.key) controlsView.setStyle(style, session.paletteName);
            } catch (error) {
                session.histogramPercentileError = `Could not rescale this raster: ${error.message}`;
            }
            renderLayerStack();
        }, RASTER_STYLE_DEBOUNCE_MILLISECONDS);
        histogramStyleTimers.set(session.key, update);
    }

    /**
     * Keep one histogram's percentile choices and optionally update its map colors.
     * Inspection never selects the global style editor or starts a statistics read.
     * @param {string} key Retained or detached histogram identity.
     * @param {{lower:number,middle:number,upper:number,rescale:boolean}} settings User choices.
     * @return {void}
     */
    function handleHistogramPercentiles(key, settings) {
        const session = key === analysisRasterSession?.key
            ? analysisRasterSession : mapLayers.getRecord(key)?.state;
        if (!session) return;
        session.histogramPercentileError = "";
        session.histogramPercentiles = { ...settings };
        scheduleHistogramStyleUpdate(session);
        if (session.key === activeLayerKey && session.analysis.rasterStatistics) {
            refreshActiveSessionPresentation();
        }
        renderLayerHistogramSummaries();
    }

    /**
     * Build one presentation-ready histogram summary for a retained raster.
     *
     * @param {Object} session Raster-owned retained interaction state.
     * @return {{key:string,label:string,state:string,
     * counts:number[]|null,automatic:boolean,valueLabel:string,
     * statistics:Object|null,style:Object,
     * canRetry:boolean,canCalculate:boolean,errorMessage:string}} Histogram view model with cached
     * counts, ready-only statistics, coloring, calculation capability and retry state.
     */
    function buildLayerHistogramSummary(session) {
        const presentation = getLayerHistogramPresentation(session);
        const percentiles = getHistogramPercentileContext(session);
        const categorical = session.appearanceMode === "categorical";
        const counts = presentation.statistics?.histogram?.counts;
        const error = session.analysis.selectedCatalogSelection !== null || session.analysis.selectedRasterBounds !== null
            ? session.analysis.selectedRasterStatisticsError : session.analysis.wholeRasterStatisticsError;
        return {
            key: session.key,
            label: session.label,
            state: presentation.state,
            counts: !categorical && Array.isArray(counts) && (!followsVisibleLayers || presentation.state === "ready")
                ? [...counts] : null,
            automatic: followsVisibleLayers,
            valueLabel: getHistogramValueLabel(session.item),
            statistics: !categorical && presentation.state === "ready" ? presentation.statistics : null,
            categorical: categorical && presentation.state === "ready" &&
                rasterStatisticsMatchCategories(presentation.statistics, sessionCategoryValues(session))
                ? presentCategoricalRasterDistribution(presentation.statistics, session.categoricalStyle) : null,
            ...(categorical && presentation.state === "ready" &&
                !rasterStatisticsMatchCategories(presentation.statistics, sessionCategoryValues(session))
                ? { unavailableMessage: CATEGORICAL_HISTOGRAM_MESSAGE } : {}),
            style: session.rasterStyle,
            ...(!categorical ? { percentileSettings: percentiles.settings } : {}),
            canRescale: percentiles.canRescale,
            percentileMessage: percentiles.message,
            errorMessage: presentation.state === "error" ? error?.message ?? "" : "",
            canRetry: presentation.state === "error" && canRetryRasterStatistics(error),
            canCalculate: session.item.capabilities?.calculations !== false,
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
             * Select visible layers owned by the ordinary raster controls.
             * @param {{adapter:Object,entry:Object}} record Retained layer record.
             * @return {boolean} Whether this is a visible raster layer.
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
     * @return {Object[]} Catalog identities and custom names, falling back to filename stems.
     */
    function rasterCursorSampleParticipants() {
        return allVisibleRasterRecords().filter(({state}) => state.item.capabilities?.pixels !== false)
            .map(({ entry, state }) => ({
                key: entry.key,
                label: entry.item === null ? entry.label : entry.customName ?? getRasterDisplayStem(state.item),
                item: state.item,
            }));
    }

    /**
     * Return the bounded raster-histogram inputs in top-first map order.
     *
     * Ordinary mode includes up to 16 visible rasters; 2D mode includes only
     * its top-two pair. Layers below the cap still render independently.
     *
     * @return {Object[]} At most 16 ordinary or two 2D raster records.
     */
    function visibleRasterRecords() {
        return allVisibleRasterRecords().filter(({state}) => state.item.capabilities?.statistics !== false).slice(0, bivariateMode.active ? 2 : MAXIMUM_VISIBLE_RASTER_HISTOGRAMS);
    }

    /**
     * Return raster participants for click coverage and paired-cell highlighting.
     *
     * Visible-layer mode uses the top two rasters in map order. Detached Catalog
     * analysis uses its active raster without consulting rendering state. In
     * 2D mode the current axis assignment, including a swap, defines order and
     * badges without changing the Catalog identities passed to analysis. Ordinary
     * mode uses these identities only to decide whether to open a histogram.
     *
     * @return {import("./point-samples.js").RasterPointSampleParticipant[]} Zero, one, or two raster participants.
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
            return allVisibleRasterRecords().filter(({state}) => state.item.capabilities?.pixels !== false).slice(0, 2).map(({ entry, state }) => ({
                key: entry.key,
                label: entry.label,
                item: state.item,
                axis: null,
            }));
        }
        if (activeRasterItem === null || activeLayerKey === null) {
            return [];
        }
        return [{
            key: activeLayerKey,
            label: mapLayers.getRecord(activeLayerKey)?.entry.label ?? getRasterDisplayName(activeRasterItem),
            item: activeRasterItem,
            axis: null,
        }];
    }

    /**
     * Decide whether a click should open the histogram using published extents.
     * Ordinary visible-layer mode considers every visible raster extent; 2D
     * mode and detached Catalog analysis retain their click participants.
     * This presentation decision does not restrict backend pixel requests.
     *
     * @param {Array<{key:string}>} participants Current click participants.
     * @param {{longitude:number,latitude:number}} position Canonical point.
     * @return {boolean} Whether any published extent covers the point, or a
     * participant has no retained renderer.
     */
    function shouldOpenRasterHistogram(participants, position) {
        const coverageParticipants = followsVisibleLayers && !bivariateMode.active
            ? allVisibleRasterRecords().filter(({state}) => state.item.capabilities?.statistics !== false).map(({ entry }) => entry)
            : participants;
        return coverageParticipants.some(({ key }) => {
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
        bivariatePercentiles.clear();
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
     * bounded top 16 ordinary rasters. While 2D mode is active, its top-two pair
     * migrates with visibility and order. Does nothing during clear(). Never
     * call this to choose a style target.
     *
     * Label changes refresh existing results without resampling.
     * @return {void}
     */
    function syncVisibleLayers() {
        if (clearing) return;
        for (const record of mapLayers.retainedRecords) {
            if (record.adapter === rasterMapLayerAdapter) record.state.label = record.entry.label;
        }
        let pairLabelsChanged = false;
        for (const candidate of bivariateCandidates) {
            const label = mapLayers.getRecord(candidate.key)?.entry.label;
            if (label !== undefined && label !== candidate.label) {
                candidate.label = label;
                pairLabelsChanged = true;
            }
        }
        if (pairLabelsChanged && bivariateMode.active) {
            const presentation = getBivariatePresentation();
            controlsView.renderBivariateMode?.({ active: true, ...presentation });
            if (bivariateStatistics) controlsView.renderPairedStatistics?.(bivariateStatistics, presentation);
        }
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
            pointSamplesController.synchronize(rasterPointSampleParticipants());
            if (records[0]) controlsView.setActiveLayer(records[0].entry.label);
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
        bivariateCandidates = records.slice(0, 2).map(
            /**
             * Snapshot a visible raster's identity and ordinary range for 2D use.
             * @param {{entry:Object,state:Object}} record Visible raster and state.
             * @return {Object} Candidate with key, Item, label, copied style, and
             * a rasterRangeResolved flag indicating a non-placeholder range.
             */
            ({ entry, state }) => ({
                key: entry.key, item: state.item, label: entry.label,
                appearanceMode: state.appearanceMode ?? "continuous",
                rasterStyle: { ...state.rasterStyle },
                rasterRangeResolved: !hasDefaultRasterRange(
                    state.rasterStyle, state.rasterStyleWasEdited
                ),
            })
        );
        let migratedPair = false;
        if (bivariateMode.active && (records.length !== 2 || bivariateCandidates.some(candidate => candidate.appearanceMode === "categorical"))) {
            leaveBivariateMode(
                "The 2D histogram requires two continuous raster layers.",
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
        if (!bivariateMode.active && !pendingVectorSelection) {
            for (const { entry, state } of records.slice(1)) {
                if (getLayerHistogramPresentation(state).state === "idle") {
                    const area = currentRasterSamplingArea();
                    setSessionSamplingArea(state, area);
                    void requireLayerHistogramController(state).activate(state.item, area);
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
        if (pendingVectorSelection) {
            controlsView.renderLayerHistograms([], null);
            onHistogramChange(null);
            return;
        }
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
        if (pendingVectorSelection) { onHistogramChange(null); return; }
        const detached = activeDetachedRasterSession();
        const sessions = detached ? [detached] : followsVisibleLayers
            ? visibleRasterRecords().map(record => record.state)
            : activeLayerKey === null ? [] : [mapLayers.getRecord(activeLayerKey)?.state].filter(Boolean);
        if (sessions.length === 0) { onHistogramChange(null); return; }
        const presentations = sessions.map(getLayerHistogramPresentation);
        const states = bivariateMode.active ? [pairedHistogramState] : presentations.map(item => item.state);
        const resizing = rasterSampleWindowResizeTimeout !== null;
        const loading = resizing || states.some(state => state === "loading" || state === "idle");
        const failures = states.filter(state => state === "error").length;
        const state = loading ? "loading" : failures ? "error" : "ready";
        const selection = bivariateMode.active ? bivariateCatalogSelection : rasterAnalysis.selectedCatalogSelection;
        const scope = bivariateMode.active
            ? selection ? `Selected polygons · ${selection.filename}` : bivariateSelectedBounds ? "Sampling box · 2D comparison" : "Whole overlap · 2D comparison"
            : presentations[0].scope;
        const visibleCount = followsVisibleLayers ? allVisibleRasterRecords().length : sessions.length;
        const participation = visibleCount > sessions.length
            ? `Top ${sessions.length} of ${visibleCount} visible rasters`
            : `${sessions.length} raster layer${sessions.length === 1 ? "" : "s"}`;
        const progress = resizing ? "Resizing box; results show the previous area…" : loading ? "Updating for this selection…" : failures
            ? "Some histograms unavailable — see details" : "Ready";
        onHistogramChange(Object.freeze({state, source: participation, scope, message: `${participation} · ${scope} · ${progress}`}));
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
            session.analysis.selectedRasterBounds = null;
            session.analysis.selectedCatalogSelection = null;
            session.analysis.selectedRasterCenter = null;
            session.analysis.selectedRasterWindowSizeKm = null;
            session.analysis.selectedRasterStatistics = null;
            session.analysis.selectedRasterStatisticsState = "idle";
            session.analysis.selectedRasterStatisticsError = null;
            return;
        }
        session.analysis.selectedRasterBounds = samplingArea.kind === "samplingBox"
            ? samplingBoxBounds(samplingArea.samplingBox)
            : samplingArea.kind === "selectedArea" ? samplingArea.selectedBounds : null;
        session.analysis.selectedCatalogSelection = samplingArea.kind === "catalogSelection"
            ? rasterAnalysis.selectedCatalogSelection
            : null;
        session.analysis.selectedRasterCenter = samplingArea.kind === "samplingBox"
            ? samplingArea.samplingBox.center
            : null;
        session.analysis.selectedRasterWindowSizeKm = samplingArea.kind === "samplingBox"
            ? samplingArea.samplingBox.sideLengthKm
            : null;
        session.analysis.selectedRasterStatistics = null;
        session.analysis.selectedRasterStatisticsState = "idle";
        session.analysis.selectedRasterStatisticsError = null;
        session.analysis.rasterStatisticsIsApplicable = false;
    }

    /**
     * Mark one raster's requested scope as loading without discarding prior data.
     *
     * @param {RasterAnalysisState} analysis Authoritative per-raster state.
     * @param {"wholeRaster"|"selectedArea"|"samplingBox"|"catalogSelection"} scope Requested scope.
     * @return {void}
     */
    function markRasterStatisticsLoading(analysis, scope) {
        if (scope === "wholeRaster") {
            analysis.wholeRasterStatisticsState = "loading";
            analysis.wholeRasterStatisticsError = null;
        } else {
            analysis.selectedRasterStatisticsState = "loading";
            analysis.selectedRasterStatisticsError = null;
        }
    }

    /**
     * Cache a successful result in its whole-raster or selected-area scope.
     *
     * @param {RasterAnalysisState} analysis Authoritative per-raster state.
     * @param {Object} statistics Validated current response.
     * @param {"wholeRaster"|"selectedArea"|"samplingBox"|"catalogSelection"} scope Response scope.
     * @return {void}
     */
    function storeRasterStatisticsResult(analysis, statistics, scope) {
        if (scope === "wholeRaster") {
            analysis.wholeRasterStatistics = statistics;
            analysis.wholeRasterStatisticsState = "ready";
            analysis.wholeRasterStatisticsError = null;
        } else {
            analysis.selectedRasterStatistics = statistics;
            analysis.selectedRasterStatisticsState = "ready";
            analysis.selectedRasterStatisticsError = null;
        }
    }

    /**
     * Retain a scope's request failure without erasing its previous result.
     *
     * @param {RasterAnalysisState} analysis Authoritative per-raster state.
     * @param {Error} error Current non-abort request failure.
     * @param {"wholeRaster"|"selectedArea"|"samplingBox"|"catalogSelection"} scope Failed scope.
     * @return {void}
     */
    function storeRasterStatisticsError(analysis, error, scope) {
        if (scope === "wholeRaster") {
            analysis.wholeRasterStatisticsState = "error";
            analysis.wholeRasterStatisticsError = error;
        } else {
            analysis.selectedRasterStatisticsState = "error";
            analysis.selectedRasterStatisticsError = error;
        }
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
        storeRasterStatisticsResult(session.analysis, statistics, samplingArea.kind);
        session.analysis.rasterStatistics = statistics;
        session.analysis.rasterStatisticsIsApplicable = true;
        session.histogramPercentileError = "";
        if (samplingArea.kind === "wholeRaster" && session.appearanceMode !== "categorical") {
            const style = deriveInitialRasterStyleFromStatistics(
                session.rasterStyle, statistics, session.rasterStyleWasEdited || session.temporal?.preserveRange === true
            );
            if (style !== null) {
                applySessionStyle(session, style, session.paletteName, false);
                if (editingLayerKey === session.key) {
                    controlsView.setStyle(style, session.paletteName);
                }
            }
        }
        scheduleHistogramStyleUpdate(session);
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
        storeRasterStatisticsError(session.analysis, error, samplingArea.kind);
        session.analysis.rasterStatisticsIsApplicable = false;
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
            /** Load this view's numeric categories even when another view shares its source.
             * @param {Object} item Original raster source.
             * @param {Object} area Requested sampling area.
             * @param {AbortSignal} signal Cancellation for this view's request.
             * @return {Promise<Object>} Statistics for this view's classification.
             */
            (item, area, signal) => loadStatisticsWithRetry(item, area, signal, session),
            /**
             * Mark this inactive session's requested scope busy and inapplicable.
             *
             * @param {Object} _ Requested Item; the captured session owns identity.
             * @param {Object} samplingArea Normalized whole-raster, bounds, or polygon selection area.
             * @return {void}
             */
            (_, samplingArea) => {
                markRasterStatisticsLoading(session.analysis, samplingArea.kind);
                session.analysis.rasterStatisticsIsApplicable = false;
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
        resetPendingRasterStatisticsState(session.analysis);
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
        if (pendingVectorSelection) return;
        refreshActiveSessionPresentation();
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

    /** Build a captured box or retain an explicit rectangle's existing meaning.
     * @param {Object|null} bounds Geographic read-window envelope.
     * @param {Readonly<{longitude:number,latitude:number}>|null} center Original box center, absent for a rectangle.
     * @param {number|null} size Captured box side length, absent for a rectangle.
     * @return {Readonly<Object>|null} Normalized descriptor, or null without a selection.
     */
    function samplingAreaForWindow(bounds, center, size) {
        if (bounds === null) return null;
        return normalizeRasterSamplingArea(center !== null && size !== null
            ? {kind: "samplingBox", samplingBox: {center, sideLengthKm: size}}
            : {kind: "selectedArea", selectedBounds: bounds});
    }

    /** Restore the presented descriptor without replacing a box by its envelope.
     * @param {Object} bounds Geographic read-window envelope to display.
     * @return {void}
     */
    function restoreRasterSampleWindow(bounds) {
        const [, size, center] = getPresentedSampleWindow();
        rasterSampleWindowController.restoreSelection(bounds,
            center !== null && size !== null ? {center, sideLengthKm: size} : null);
    }

    /**
     * Return the normalized area selected by the parent viewer.
     *
     * @return {Readonly<Object>} Strict whole-raster, rectangle, geodesic-box or vector-selection area.
     */
    function currentRasterSamplingArea() {
        if (rasterAnalysis.selectedCatalogSelection !== null) {
            return normalizeRasterSamplingArea({
                kind: "catalogSelection",
                catalogSelection: rasterAnalysis.selectedCatalogSelection.selection
            });
        }
        if (rasterAnalysis.selectedRasterBounds !== null) {
            return samplingAreaForWindow(rasterAnalysis.selectedRasterBounds,
                rasterAnalysis.selectedRasterCenter,rasterAnalysis.selectedRasterWindowSizeKm);
        }
        return WHOLE_RASTER_SAMPLING_AREA;
    }

    /**
     * Snapshot the presented area or a named 1D raster's area without reading results.
     * Whole-raster/overlap sampling deliberately has no clip selection.
     * @param {string|null} [key=null] Optional 1D session key.
     * @param {"presented"|"1d"|"2d"} [mode="presented"] Selection owner.
     * @return {Readonly<Object>|null} Frozen rectangle, geodesic box or vector descriptor, or no explicit area.
     */
    function getSelectedArea(key = null, mode = "presented") {
        if (pendingVectorSelection) return null;
        if (invalidVectorSamplingId && (bivariateMode.active ? bivariateCatalogSelection : rasterAnalysis.selectedCatalogSelection)?.id === invalidVectorSamplingId) return null;
        if (mode === "2d" || (mode === "presented" && bivariateMode.active)) {
            if (bivariateCatalogSelection) return normalizeRasterSamplingArea({ kind: "catalogSelection", catalogSelection: bivariateCatalogSelection.selection });
            return samplingAreaForWindow(bivariateSelectedBounds,bivariateSelectedCenter,bivariateSelectedWindowSizeKm);
        }
        const analysis = key === null || key === activeLayerKey
            ? rasterAnalysis : getBivariateCandidateSession(key)?.analysis;
        if (!analysis) return null;
        if (analysis.selectedCatalogSelection) return normalizeRasterSamplingArea({
            kind: "catalogSelection", catalogSelection: analysis.selectedCatalogSelection.selection,
        });
        return samplingAreaForWindow(analysis.selectedRasterBounds,analysis.selectedRasterCenter,analysis.selectedRasterWindowSizeKm);
    }

    /** Forward a 1D calculation intent. @param {string} key Source key. @return {void} */
    function calculateHistogram(key) {
        const session = key === activeLayerKey ? { item: activeRasterItem } : getBivariateCandidateSession(key);
        if (session?.item) onCalculateRequested(session.item, getSelectedArea(key, "1d"),
            mapLayers.getRecord(key)?.entry.label ?? getRasterDisplayName(session.item), key);
    }

    /** Forward one paired axis for single-raster calculations. @param {string} axis X/Y. @return {void} */
    function calculatePairedHistogram(axis) {
        const pair = getBivariatePairCandidates();
        if (pair) onCalculateRequested(pair[`${axis}Candidate`].item, getSelectedArea(null, "2d"), pair[`${axis}Candidate`].label, pair[`${axis}Candidate`].key);
    }

    /** Forward the exact 1D source and area through composition. @param {string} key Histogram session. @return {void} */
    function downloadHistogram(key) {
        const session = key === activeLayerKey ? { item: activeRasterItem } : getBivariateCandidateSession(key);
        if (session?.item) onDownloadRequested(session.item, getSelectedArea(key, "1d"),
            mapLayers.getRecord(key)?.entry.label ?? getRasterDisplayName(session.item));
    }

    /** Forward the selected X/Y source with the 2D box. @param {"x"|"y"} axis Histogram axis. @return {void} */
    function downloadPairedHistogram(axis) {
        const pair = getBivariatePairCandidates();
        if (pair) onDownloadRequested(pair[`${axis}Candidate`].item, getSelectedArea(null, "2d"), pair[`${axis}Candidate`].label);
    }

    /**
     * Release cancelled loading markers while preserving completed results.
     *
     * @param {RasterAnalysisState} [analysis=rasterAnalysis] Cancelled raster state.
     * @return {void}
     */
    function resetPendingRasterStatisticsState(analysis = rasterAnalysis) {
        if (analysis.wholeRasterStatisticsState === "loading") {
            analysis.wholeRasterStatisticsState = "idle";
        }
        if (analysis.selectedRasterStatisticsState === "loading") {
            analysis.selectedRasterStatisticsState = "idle";
        }
    }

    /**
     * Return whether the active raster uses a non-whole sampling area.
     *
     * @return {boolean} Whether bounds or a catalog selection owns the histogram.
     */
    function hasSelectedRasterSamplingArea() {
        return rasterAnalysis.selectedRasterBounds !== null || rasterAnalysis.selectedCatalogSelection !== null;
    }

    /**
     * Return the active sampling-area discriminator for control presentation.
     *
     * @return {"wholeRaster"|"selectedArea"|"catalogSelection"} Active
     * mode.
     */
    function getRasterSamplingAreaMode() {
        if (rasterAnalysis.selectedCatalogSelection !== null) {
            return "catalogSelection";
        }
        return rasterAnalysis.selectedRasterBounds === null ? "wholeRaster" : "selectedArea";
    }

    /**
     * Return the sampling window presented by the current histogram mode.
     *
     * @return {[Object|null,number|null,Object|null]} Bounds, committed side length,
     * and original WGS 84 click coordinates.
     */
    function getPresentedSampleWindow() {
        if (pendingVectorSelection) return [null, null, null];
        return bivariateMode.active
            ? [bivariateSelectedBounds, bivariateSelectedWindowSizeKm, bivariateSelectedCenter]
            : [rasterAnalysis.selectedRasterBounds, rasterAnalysis.selectedRasterWindowSizeKm, rasterAnalysis.selectedRasterCenter];
    }

    /** Preserve an active vector area when adding a raster. @return {Object|null} Initial area. */
    function initialPolygonSamplingArea() {
        const area = bivariateMode.active ? bivariateCatalogSelection : rasterAnalysis.selectedCatalogSelection;
        return area;
    }

    /** Synchronize histogram-area choices with lifecycle state. @return {void} */
    function renderRasterSamplingAreaControls() {
        onSamplingAreaChange(getSelectedArea());
        if (pendingVectorSelection) {
            controlsView.setSamplingAreaMode("vector", "Polygon layer");
            renderRasterSampleWindowGuidance("");
            return;
        }
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
        const presentedSelection = bivariateMode.active ? bivariateCatalogSelection : rasterAnalysis.selectedCatalogSelection;
        const samplingLabel = presentedSelection?.id === invalidVectorSamplingId ? "Polygon selection changed · choose a sample area" : presentedMode === "selectedArea"
            ? presentedWindowSizeKm === null
                ? "Sampling box"
                : `Sampling box · ${presentedWindowSizeKm} × ${presentedWindowSizeKm} km`
            : presentedMode === "catalogSelection"
                ? `Selected polygons · ${presentedSelection.filename}`
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
            xLabel: mapLayers.getRecord(candidates.xCandidate.key)?.entry.label ?? candidates.xCandidate.label,
            yLabel: mapLayers.getRecord(candidates.yCandidate.key)?.entry.label ?? candidates.yCandidate.label,
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
        return samplingAreaForWindow(bivariateSelectedBounds,bivariateSelectedCenter,bivariateSelectedWindowSizeKm)
            ?? WHOLE_RASTER_OVERLAP_SAMPLING_AREA;
    }

    /**
     * Present current bivariate eligibility or a transition-specific message.
     *
     * @param {string|null} [message=null] Optional transition guidance.
     * @return {void}
     */
    function renderBivariateAvailability(message = null) {
        const eligible = bivariateCandidates;
        const hasCategorical = eligible.some(candidate => candidate.appearanceMode === "categorical");
        const canEnter = eligible.length === 2 && !hasCategorical;
        const hasSuppressedLayers = mapLayers.visibleCount > 2;
        const extraGuidance = hasSuppressedLayers
            ? " Other visible layers are temporarily hidden in 2D mode."
            : "";
        const guidance = message ?? (
            bivariateMode.active
                ? "2D analyzes the X/Y-badged rasters with coordinated colors " +
                  "and blending at 100% opacity. Reorder Map layers to change " +
                  `the pair.${extraGuidance}`
                : hasCategorical
                    ? "2D comparison is not available for categorical layers."
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
                record.publication === null ||
                layer === null ||
                !mapLayers.isAttached(candidate.key)
            ) continue;
            setRasterWmsStyle(layer, { env: buildRasterStyleEnvironment(style) });
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
            if (record === null || record.publication === null || layer === null) continue;
            setRasterWmsStyle(layer, buildRasterSessionWmsParameters(record.state));
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
        if (!bivariateMode.active || pendingVectorSelection) return;
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
        if (eligible.length !== 2 || eligible.some(candidate => candidate.appearanceMode === "categorical")) {
            renderBivariateAvailability(
                "The 2D histogram requires two continuous single-band rasters."
            );
            controlsView.renderBivariateMode?.({ active: false });
            return;
        }
        if (rasterStyleCommitTimeout !== null) {
            commitRasterStyle();
        }
        cancelSampleWindowResize();
        refreshActiveSessionPresentation();
        bivariateCatalogSelection = rasterAnalysis.selectedCatalogSelection;
        bivariateSelectedBounds = rasterAnalysis.selectedRasterBounds === null
            ? null
            : { ...rasterAnalysis.selectedRasterBounds };
        bivariateSelectedCenter = rasterAnalysis.selectedRasterCenter;
        bivariateSelectedWindowSizeKm = rasterAnalysis.selectedRasterWindowSizeKm;
        rasterStatisticsController.clear();
        resetPendingRasterStatisticsState();
        refreshActiveSessionPresentation();
        for (const record of mapLayers.retainedRecords) {
            if (record.adapter === rasterMapLayerAdapter) cancelLayerHistogramRequest(record.state);
        }
        bivariatePercentiles.clear();
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
        cancelSampleWindowResize();
        const keys = [bivariateMode.xKey, bivariateMode.yKey];
        cancelBivariateStyleUpdate();
        bivariatePercentiles.clear();
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
        if (!pendingVectorSelection && rasterAnalysis.selectedRasterBounds !== null) {
            restoreRasterSampleWindow(
                rasterAnalysis.selectedRasterBounds
            );
        }
        if (restoreAnalysis && activeRasterItem !== null) {
            restoreActiveLayerStatistics();
            refreshRetainedLayerHistograms(currentRasterSamplingArea(), true);
        } else if (restoreAnalysis) {
            rasterSampleWindowController.clear();
            controlsView.setControlsVisible(false);
        }
        renderLayerStack();
        renderBivariateAvailability(message);
    }

    /** Feature-owned adapter consumed by the neutral map-layer controller. */
    const rasterMapLayerAdapter = {
        /** Fit a non-catalog raster to its source extent. @param {Object} record Raster record. @return {void} */
        zoom(record) {
            const [west, south, east, north] = record.state.item.bbox;
            leafletMap.fitBounds([[south, west], [north, east]], {maxZoom: 15});
        },
        /** Open source details through composition. @param {Object} record Raster record. @return {void} */
        info: record => record.state.temporal ? onTemporalInfo(record.state.temporal.item) : record.state.lifecycle?.info(),
        /** Copy source lifetime identity and shared appearance for authorized Undo.
         * @param {Object} record Raster record. @return {Object} Source owner's restoration descriptor.
         */
        copyLayerForUndo: record => record.state.temporal ? {kind: "temporal", layer: exportTemporal(record)} :
            record.state.lifecycle.copy(rasterMapLayerAdapter.exportSavedState(record)),
        tileErrorMessage: "Map tiles could not be rendered.",
        label: getRasterDisplayName,
        publish: publishRaster,
        /**
         * Create raster control state, preserving matching original-source analysis.
         *
         * @param {Object} context Neutral controller's publication context.
         * @param {Object} context.entry Stable stack entry and display label.
         * @param {Object} [context.publication] Catalog GeoServer publication response.
         * @param {Object} [context.item] Catalog raster Item being retained.
         * @param {Object} [context.source] Non-catalog raster descriptor, lifecycle callbacks and optional appearance.
         * @return {Object} New raster session with any prior interaction state.
         */
        createState({ entry, publication, item, source }) {
            item ??= source.raster;
            const analysisSession = matchingAnalysisSession(item);
            if (analysisSession !== null) {
                refreshActiveSessionPresentation();
            }
            const session = createLayerSession(entry, publication ?? {bbox: item.bbox});
            session.item = item;
            session.lifecycle = source?.lifecycle ?? null;
            session.temporal = source?.temporal ?? null;
            if (source?.appearance) {
                const appearance = normalizeRasterAppearanceState(source.appearance);
                session.appearanceMode = appearance.mode; session.categoricalStyle = appearance.categorical;
                session.rasterStyle = appearance.continuous.definition; session.paletteName = appearance.continuous.paletteName;
                session.rasterStyleWasEdited = appearance.continuous.styleWasEdited;
            }
            if (analysisSession !== null) {
                adoptRasterInteractionState(session, analysisSession);
                session.analysis = { ...session.analysis };
            }
            return session;
        },
        /**
         * Construct the raster through the ordinary GeoServer WMS tile adapter.
         *
         * @param {Object} record Record containing publication and raster state.
         * @param {() => void} reportTileError Controller-owned failure callback.
         * @return {Object} Leaflet-compatible raster layer, not yet attached.
         */
        createLayer(record, reportTileError) {
            if (record.publication === null) {
                record.state.layer = null;
                const empty = leaflet.layerGroup();
                /** Empty retained rows have no imagery to fade. @param {number} _opacity Stack opacity. @return {void} */
                empty.setOpacity = (_opacity) => {};
                /** Empty retained rows have no imagery to order. @param {number} _index Stack position. @return {void} */
                empty.setZIndex = (_index) => {};
                return empty;
            }
            const layer = createRasterLayer(record.publication, record.state.rasterStyle, reportTileError);
            record.state.layer = layer;
            if (record.state.appearanceMode === "categorical") {
                setRasterWmsStyle(layer, buildRasterSessionWmsParameters(record.state));
            }
            return layer;
        },
        /**
         * Describe the current authorized raster appearance for composition.
         *
         * @param {Object} record Retained raster publication and style state.
         * @return {{layerName:string,styleName:string,styleEnvironment?:string,styleDefinition?:Object}}
         * Complete feature-owned composite descriptor.
         */
        renderDescriptor(record) {
            return {
                layerName: record.publication.layerName,
                styleName: "dynamic-raster",
                ...(record.state.appearanceMode === "categorical"
                    ? { styleDefinition: record.state.categoricalStyle }
                    : { styleEnvironment: buildRasterStyleEnvironment(record.state.rasterStyle) }),
            };
        },
        /**
         * Describe effective opacity and legend, including paired-mode styling.
         * Saves shared analysis state first when this record is active.
         *
         * @param {Object} record Retained raster entry and interaction state.
         * @return {{datasetKind:"raster",opacityLocked:boolean,effectiveOpacity:number,
         * roleBadge:({label:"X"|"Y",description:string}|null),
         * legend:import("../map-layers/layer-stack-view.js").LayerLegend}}
         * Opacity in [0, 1], an optional paired-axis badge, and either a
         * discrete categorical legend or a continuous gradient legend.
         */
        snapshot(record) {
            if (activeLayerKey === record.entry.key) {
                refreshActiveSessionPresentation();
            }
            const source = rasterSourceReference(record.state.item);
            const metadata = {source, bounds: record.state.item.bbox,
                ...(record.state.temporal ? {controls: record.state.temporal.controls.element} : {}),
                group: record.state.item.group,
                capabilities: record.state.item.capabilities ?? {pixels: true, statistics: true, calculations: true, modelInput: true}};
            let presentationStyle = record.state.rasterStyle;
            if (record.state.appearanceMode === "categorical") {
                return {
                    ...metadata, datasetKind: "raster", opacityLocked: false,
                    effectiveOpacity: record.entry.opacity,
                    roleBadge: null,
                    legend: buildCategoricalRasterLegend(record.state.categoricalStyle),
                };
            }
            const opacityLocked = bivariateMode.contains(record.entry.key);
            if (opacityLocked) {
                const presentation = getBivariatePresentation();
                presentationStyle = record.entry.key === bivariateMode.xKey
                    ? presentation.xStyle
                    : presentation.yStyle;
            }
            const definition = buildRasterLegend(presentationStyle);
            return {
                ...metadata, datasetKind: "raster",
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
                    label: opacityLocked
                        ? `${record.entry.key === bivariateMode.xKey ? "X" : "Y"} color contribution; combines with the other raster on the map.`
                        : "Raster values",
                    labels: [
                        presentationStyle.minimum,
                        presentationStyle.midpoint,
                        presentationStyle.maximum,
                    ],
                },
            };
        },
        /**
         * Export the selected mode and both validated appearance configurations.
         *
         * @param {Object} record Neutral retained-layer record.
         * @return {import("./appearance-state.js").RasterAppearanceState}
         * Portable raster style state.
         */
        exportSavedState(record) {
            if (activeLayerKey === record.entry.key) {
                refreshActiveSessionPresentation();
            }
            return normalizeRasterAppearanceState({
                kind: "raster",
                appearanceVersion: 1,
                mode: record.state.appearanceMode ?? "continuous",
                continuous: {
                    definition: record.state.rasterStyle,
                    paletteName: record.state.paletteName,
                    styleWasEdited: record.state.rasterStyleWasEdited || record.state.temporal?.preserveRange === true,
                },
                categorical: record.state.categoricalStyle ?? null,
            });
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
            const appearance = normalizeRasterAppearanceState(savedState);
            const session = record.state;
            session.appearanceMode = appearance.mode;
            session.categoricalStyle = appearance.categorical;
            applySessionStyle(session, appearance.continuous.definition,
                appearance.continuous.paletteName, appearance.continuous.styleWasEdited);
            if (bivariateMode.contains(session.key) && appearance.mode === "categorical") {
                leaveBivariateMode("2D comparison is not available for categorical layers.");
            }
            if (editingLayerKey === session.key) presentSessionAppearance(session);
            refreshSessionStatisticsForAppearance(session);
            renderBivariateAvailability();
        },
        /**
         * Adopt matching detached analysis state before activating a renderer.
         *
         * @param {Object} record Retained raster record to prepare in place.
         * @return {void}
         */
        prepare(record) {
            const analysisSession = matchingAnalysisSession(record.state.item);
            if (analysisSession !== null) {
                refreshActiveSessionPresentation();
                adoptRasterInteractionState(record.state, analysisSession);
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
            cancelHistogramStyleUpdate(record.entry.key);
            if (editingLayerKey === record.entry.key) closeStyle();
            if (record.state.temporal) {
                record.state.temporal.request?.abort();
                record.state.temporal.controls.destroy();
                if (wasActive) deactivateActiveLayer();
                return undefined;
            }
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
            record.state.layer?.release?.();
            record.state.lifecycle?.removed();
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
            refreshActiveSessionPresentation();
            controlsView.setActiveLayer(record.entry.label);
            renderRasterSampleWindowGuidance("");
            refreshActiveSessionPresentation();
            renderBivariateAvailability();
        },
        /**
         * Report one raster's tile failure through the application callback.
         *
         * @param {Object} record Failed record containing error text and its Item.
         * @return {void}
         */
        tileError(record) {
            if (record.state.temporal) {
                record.state.temporal.error = "This observation's map tiles are unavailable. Retry to load them again.";
                renderTemporalControls(record);
                return;
            }
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
        cancelRasterSampleWindowResize();
        rasterStatisticsController.clear();
        rasterSampleWindowController.clear();
        pointSamplesController.clear();
        resetPendingRasterStatisticsState();
        refreshActiveSessionPresentation();
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
        if (pendingVectorSelection) { clearRasterStatisticsPresentation(); return; }
        const codes = sessionCategoryValues(mapLayers.getRecord(activeLayerKey)?.state);
        if (hasSelectedRasterSamplingArea()) {
            if (rasterAnalysis.selectedRasterStatisticsState === "ready" && !rasterStatisticsMatchCategories(rasterAnalysis.selectedRasterStatistics, codes)) {
                rasterAnalysis.selectedRasterStatisticsState = "idle";
            }
            if (rasterAnalysis.selectedRasterStatisticsState === "ready") {
                renderRasterStatistics(rasterAnalysis.selectedRasterStatistics);
            } else if (rasterAnalysis.selectedRasterStatisticsState === "error") {
                renderSelectedRasterStatisticsError(
                    rasterAnalysis.selectedRasterStatisticsError
                );
            } else {
                rasterAnalysis.selectedRasterStatisticsState = "idle";
                void rasterStatisticsController.activate(
                    activeRasterItem,
                    currentRasterSamplingArea()
                );
            }
        } else if (rasterAnalysis.wholeRasterStatisticsState === "ready" && !rasterStatisticsMatchCategories(rasterAnalysis.wholeRasterStatistics, codes)) {
            void rasterStatisticsController.activate(activeRasterItem, WHOLE_RASTER_SAMPLING_AREA);
        } else if (rasterAnalysis.wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(rasterAnalysis.wholeRasterStatistics);
        } else if (rasterAnalysis.wholeRasterStatisticsState === "error") {
            renderRasterStatisticsError(
                rasterAnalysis.wholeRasterStatisticsError,
                "wholeRaster"
            );
        } else {
            rasterAnalysis.wholeRasterStatisticsState = "idle";
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
        selectActiveRasterSession(session);
        if (matchingAnalysisSession(session.item) !== null) {
            analysisRasterSession = null;
        }
        controlsView.setControlsVisible(true);
        presentActiveRenderingAvailability(true);
        controlsView.setActiveLayer(entry.label);
        presentActiveStyle(rasterStyle, session.paletteName);

        if (!bivariateMode.active) {
            rasterSampleWindowController.setWindowSize(
                rasterAnalysis.selectedRasterWindowSizeKm ??
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
            restoreRasterSampleWindow(
                presentedBounds
            );
        }
        if (bivariateMode.active) {
            controlsView.setAppearanceEnabled?.(false);
            controlsView.setUnivariateHistogramVisible?.(false);
            refreshActiveSessionPresentation();
            applyBivariatePresentation();
            renderRasterSampleWindowGuidance("");
            return;
        }
        renderRasterSampleWindowGuidance("");

        restoreActiveLayerStatistics();
        refreshActiveSessionPresentation();
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
        selectActiveRasterSession(session);
        controlsView.setControlsVisible(true);
        presentActiveRenderingAvailability(false);
        controlsView.setActiveLayer(session.label);
        presentActiveStyle(rasterStyle, session.paletteName);
        if (!bivariateMode.active) {
            rasterSampleWindowController.setWindowSize(
                rasterAnalysis.selectedRasterWindowSizeKm ??
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
            restoreRasterSampleWindow(
                presentedBounds
            );
        }
        renderRasterSamplingAreaControls();
        if (bivariateMode.active) {
            controlsView.setAppearanceEnabled?.(false);
            controlsView.setUnivariateHistogramVisible?.(false);
            refreshActiveSessionPresentation();
            applyBivariatePresentation();
            renderRasterSampleWindowGuidance("");
            renderLayerStack();
            return;
        }
        renderRasterSampleWindowGuidance("");
        restoreActiveLayerStatistics();
        refreshActiveSessionPresentation();
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
        const catalogKey = rasterSourceKey(item);
        if (bivariateMode.active && !bivariateMode.contains(catalogKey)) {
            leaveBivariateMode(
                "A different raster analysis was selected; bivariate mode ended."
            );
        }
        rememberBivariateCandidate(item);
        mapLayers.recordIntent();
        const retainedKey = mapLayers.findLayerKey(item);
        const existingSession = matchingAnalysisSession(item);
        if (existingSession !== null && isActiveAnalysisRaster()) {
            return;
        }
        const retainedSession = mapLayers.getRecord(retainedKey)?.state;
        if (retainedSession !== undefined) {
            const analysisSession = matchingAnalysisSession(item);
            if (analysisSession !== null) {
                refreshActiveSessionPresentation();
                adoptRasterInteractionState(retainedSession, analysisSession);
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
                restoreRasterSampleWindow(presentedBounds);
            }
            renderRasterSamplingAreaControls();
            renderRasterSampleWindowGuidance("");
            applyBivariatePresentation();
            renderLayerStack();
        } else {
            controlsView.setControlsVisible(false);
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
     * Label the displayed result independently of a newer sampling request.
     *
     * @param {Object} statistics Actual distribution being displayed.
     * @param {{state:string,statistics:Object|null,scope:string,error:Error|null}}
     * presentation Current requested scope and its lifecycle.
     * @return {string} Current scope or explicitly previous result scope.
     */
    function styleHistogramScopeLabel(statistics, presentation) {
        if (presentation.state === "ready" && statistics === presentation.statistics) return presentation.scope;
        const scope = statistics.scope === "catalogSelection"
            ? `Selected polygons · ${statistics.catalogSelection.layerName}`
            : ["selectedArea", "samplingBox"].includes(statistics.scope) ? "Sampling box" : "Whole raster";
        return `Previous histogram · ${scope}`;
    }

    /**
     * Render the categorical style target's sample with scope-specific lifecycle feedback.
     * Current ready distributions take precedence. Compatible previous distributions
     * remain available for reference, labeled separately from the current request.
     *
     * @return {void}
     */
    function renderEditingStyleHistogram() {
        const session = editingSession();
        if (editingLayerKey === null || session === null ||
            bivariateMode.contains(session.key) || editingAppearanceMode !== "categorical") {
            controlsView.clearStyleHistogram?.();
            return;
        }
        const presentation = getLayerHistogramPresentation(session);
        const candidate = presentation.state === "ready" ? presentation.statistics : session.analysis.rasterStatistics;
        const statistics = (session.appearanceMode !== "categorical" ||
            !rasterStatisticsMatchCategories(candidate, sessionCategoryValues(session))) ? null : candidate;
        let message = "";
        if (presentation.state === "loading") {
            message = "Calculating categorical ground areas…";
        } else if (presentation.state === "error") {
            message = `Histogram unavailable: ${presentation.error?.message ?? "Unknown error"}`;
        } else if (presentation.state !== "ready" || statistics === null) {
            message = CATEGORICAL_HISTOGRAM_MESSAGE;
        }
        const feedback = { message: message ? `${presentation.scope}: ${message}` : "", isBusy: presentation.state === "loading" };
        if (statistics === null) {
            controlsView.renderStyleHistogramState?.(presentation.scope, feedback.message, feedback.isBusy);
        } else {
            controlsView.renderCategoricalStyleHistogram?.(
                presentCategoricalRasterDistribution(statistics, session.categoricalStyle),
                styleHistogramScopeLabel(statistics, presentation), feedback);
        }
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
     * Hydrate an editor and clear stale action feedback when its target or saved state changes.
     * @param {Object} session Retained layer and both committed configurations.
     * @return {void}
     */
    function presentSessionAppearance(session) {
        editingAppearanceMode = session.appearanceMode ?? "continuous";
        controlsView.setStyle(session.rasterStyle, session.paletteName);
        controlsView.setCategoricalStyle?.(session.categoricalStyle ?? null);
        controlsView.setAppearanceMode?.(editingAppearanceMode);
        controlsView.setAppearanceStatus("");
    }

    /**
     * Build mutually exclusive WMS parameters for the session's active style.
     * @param {Object} session Layer-owned style state.
     * @return {{env?:string,raster_style?:string}} Validated WMS parameters.
     * @throws {Error} If the active style is invalid.
     */
    function buildRasterSessionWmsParameters(session) {
        return session.appearanceMode === "categorical"
            ? { raster_style: buildCategoricalRasterStyleParameter(session.categoricalStyle) }
            : { env: buildRasterStyleEnvironment(session.rasterStyle) };
    }

    /**
     * Identify categorical presentation for the active map-layer analysis context.
     * Detached catalog analysis keeps its independent numeric presentation.
     * @return {boolean} Whether the active retained layer is categorical.
     */
    function activeAppearanceIsCategorical() {
        return mapLayers.getRecord(activeLayerKey)?.state.appearanceMode === "categorical";
    }

    /**
     * Present category areas using the current layer appearance and matching result.
     * @return {void}
     */
    function presentCategoricalHistogram() {
        controlsView.clearHistogram();
        controlsView.setStatisticsBusy(false);
        const session = mapLayers.getRecord(activeLayerKey)?.state;
        if (rasterAnalysis.rasterStatisticsIsApplicable &&
            rasterStatisticsMatchCategories(rasterAnalysis.rasterStatistics, sessionCategoryValues(session))) {
            controlsView.renderCategoricalHistogram?.(
                presentCategoricalRasterDistribution(rasterAnalysis.rasterStatistics, session.categoricalStyle));
            controlsView.setStatisticsStatus("Estimated categorical ground area; percentages include Unmapped and exclude NoData.");
        } else {
            controlsView.setStatisticsStatus(CATEGORICAL_HISTOGRAM_MESSAGE);
        }
    }

    /**
     * Read committed numeric classification without exposing appearance to analysis.
     * @param {Object|undefined} session Retained layer session, or detached analysis.
     * @return {number[]|null} Category codes, or continuous analysis.
     */
    function sessionCategoryValues(session) {
        return session?.appearanceMode === "categorical"
            ? session.categoricalStyle.categories.map((row) => row.value) : null;
    }

    /**
     * Refresh only numeric classification changes, canceling stale controller work.
     * Label, color, opacity and table ordering changes reuse matching results or
     * the matching pending request. Scope changes remain owned by area controls.
     * @param {Object} session Retained style target.
     * @return {void}
     */
    function refreshSessionStatisticsForAppearance(session) {
        if (pendingVectorSelection || !mapLayers.getRecord(session.key)) return;
        if (session.key === activeLayerKey) refreshActiveSessionPresentation();
        const codes = sessionCategoryValues(session);
        const presentation = getLayerHistogramPresentation(session);
        const identity = JSON.stringify(codes === null ? null : [...codes].sort((a, b) => a - b));
        if (["loading", "error"].includes(presentation.state) && session.analysis.statisticsCategoryIdentity === identity) return;
        if (presentation.state === "ready" && rasterStatisticsMatchCategories(presentation.statistics, codes)) {
            if (session.key === activeLayerKey) renderRasterStatistics(presentation.statistics);
            return;
        }
        if (session.key === activeLayerKey) {
            void rasterStatisticsController.activate(activeRasterItem, currentRasterSamplingArea());
        } else {
            void requireLayerHistogramController(session).activate(session.item,
                getSelectedArea(session.key, "1d") ?? WHOLE_RASTER_SAMPLING_AREA);
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
        refreshActiveSessionPresentation();
        editingLayerKey = key;
        presentSessionAppearance(session);
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
     * Flush any pending valid edit, cancel an uncommitted category import, and
     * release the explicit editing target.
     * The floating editor's DOM lifecycle is owned by MapLayerStyleEditor.
     *
     * @return {void}
     */
    function closeStyle() {
        if (rasterStyleCommitTimeout !== null) commitRasterStyle();
        controlsView.cancelCategoricalImport?.();
        editingLayerKey = null;
        editingAppearanceMode = "continuous";
        controlsView.clearStyleHistogram?.();
    }

    /**
     * Refresh style availability and categorical feedback for the editing target.
     * Cancels pending edits/imports and clears the target if its session was removed;
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
            controlsView.cancelCategoricalImport?.();
            editingLayerKey = null;
            return;
        }
        controlsView.setRenderingControlsAvailable(true);
        controlsView.setAppearanceEnabled(!bivariateMode.contains(editingLayerKey));
        renderEditingStyleHistogram();
    }

    /**
     * Apply a style to the target's renderer and session, not its list position.
     * Synchronize owned analysis controls and re-present retained pixel values
     * using the committed appearance without requesting new samples.
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
        if (session.layer) setRasterWmsStyle(session.layer,
            session.appearanceMode === "categorical"
                ? buildRasterSessionWmsParameters(session) : { env: environment });
        session.rasterStyle = { ...style };
        session.paletteName = paletteName;
        session.rasterStyleWasEdited = wasEdited;
        if (session.key === activeLayerKey) {
            rasterStyle = { ...style };
            activePaletteName = paletteName;
            rasterStyleWasEdited = wasEdited;
            if (session.appearanceMode === "categorical") {
                presentCategoricalHistogram();
            } else if (rasterAnalysis.rasterStatistics === null) {
                controlsView.setStatisticsStatus("");
            }
            refreshActiveSessionPresentation();
        }
        syncBivariateCandidate(session);
        refreshRasterPixelPresentation();
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
        if (editingAppearanceMode === "categorical") {
            commitCategoricalStyle();
            return;
        }
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
        renderEditingStyleHistogram();
        renderLayerStack();
    }

    /**
     * Commit the latest valid style after rapid edits settle.
     *
     * @return {void}
     */
    function scheduleRasterStyleCommit() {
        const candidate = editingAppearanceMode === "categorical"
            ? null : validateRasterStyleControls();
        if (candidate !== null) {
            renderEditingStyleHistogram();
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
        const style = session?.analysis.wholeRasterStatistics == null
                ? { ...DEFAULT_RASTER_STYLE }
                : deriveRasterStyleFromStatistics(
                    DEFAULT_RASTER_STYLE, session.analysis.wholeRasterStatistics
                );
        controlsView.setStyle({
            ...style, minimumOpacity: 1, midpointOpacity: 1, maximumOpacity: 1
        }, DEFAULT_RASTER_PALETTE_NAME);
    }

    /**
     * Remove histogram data and controls belonging to a previous layer.
     *
     * @return {void}
     */
    function clearRasterStatisticsPresentation() {
        rasterAnalysis.rasterStatistics = null;
        rasterAnalysis.rasterStatisticsIsApplicable = false;
        controlsView.clearStatistics();
        refreshActiveSessionPresentation();
    }

    /**
     * Present one bounded statistics request without blocking manual styling.
     *
     * @param {"wholeRaster"|"selectedArea"|"samplingBox"} scope Statistics request scope.
     * @return {void}
     */
    function renderRasterStatisticsLoading(scope) {
        clearRasterStatisticsPresentation();
        controlsView.setStatisticsBusy(true);
        controlsView.setStatisticsStatus(
            activeAppearanceIsCategorical() ? "Calculating categorical ground areas…" :
            ["selectedArea", "samplingBox"].includes(scope)
                ? "Calculating a bounded histogram for the selected area..."
                : "Calculating a bounded whole-raster histogram..."
        );
        refreshActiveSessionPresentation();
    }

    /**
     * Apply the initial whole-raster range unless a manual edit superseded it.
     *
     * @param {Object} statistics Validated whole-raster statistics.
     * @return {boolean} Whether the bounded initial range was applied.
     */
    function applyInitialWholeRasterStyle(statistics) {
        if (activeAppearanceIsCategorical() || mapLayers.getRecord(activeLayerKey)?.state.temporal?.preserveRange) return false;
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
        rasterAnalysis.rasterStatistics = statistics;
        rasterAnalysis.rasterStatisticsIsApplicable =
            allowApply &&
            rasterStatisticsMatchesSelection(
                statistics,
                currentRasterSamplingArea()
            );
        controlsView.setStatisticsBusy(false);
        controlsView.setStatisticsRetryVisible(false);
        if (activeAppearanceIsCategorical()) {
            presentCategoricalHistogram();
            refreshActiveSessionPresentation();
            return;
        }
        const session = activeDetachedRasterSession() ?? mapLayers.getRecord(activeLayerKey)?.state;
        if (session) session.histogramPercentileError = "";
        if (session) scheduleHistogramStyleUpdate(session);

        const excludedCount =
            statistics.sampledPixelCount - statistics.validSampleCount;
        const usesSampleGrid = statistics.samplingMethod === "sampleGrid";
        const sourceDescription = statistics.scope === "wholeRaster"
            ? "source raster"
            : "source-cell window";
        const approximation = statistics.estimated ? "approximate" : "exact";
        const scopeDescription = statistics.scope === "catalogSelection"
            ? `Vector selection ${rasterAnalysis.selectedCatalogSelection?.filename ?? "area"}, ` +
              `layer ${rasterAnalysis.selectedCatalogSelection?.selectedDataset ?? "selected"}, ` +
              `${approximation} bounded histogram`
            : ["selectedArea", "samplingBox"].includes(statistics.scope)
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
        refreshActiveSessionPresentation();
    }

    /**
     * Keep manual rendering usable after one statistics failure.
     *
     * @param {Error} error Statistics request failure.
     * @param {"wholeRaster"|"selectedArea"|"samplingBox"} scope Failed request scope.
     * @return {void}
     */
    function renderRasterStatisticsError(error, scope) {
        rasterAnalysis.rasterStatistics = null;
        rasterAnalysis.rasterStatisticsIsApplicable = false;
        controlsView.setStatisticsBusy(false);
        controlsView.clearHistogram();
        controlsView.setStatisticsRetryVisible(
            canRetryRasterStatistics(error)
        );
        controlsView.setStatisticsStatus(
            `${["selectedArea", "samplingBox"].includes(scope) ? "Selected-area" : "Whole-raster"} ` +
            `histogram unavailable: ${error.message} ` +
            "Manual appearance controls remain available."
        );
        refreshActiveSessionPresentation();
    }

    /**
     * Record and present the start of a whole-raster statistics request.
     *
     * @return {void}
     */
    function renderWholeRasterStatisticsLoading() {
        markRasterStatisticsLoading(rasterAnalysis, "wholeRaster");
        if (!hasSelectedRasterSamplingArea()) {
            renderRasterStatisticsLoading("wholeRaster");
        }
        refreshActiveSessionPresentation();
    }

    /**
     * Retain a successful whole-raster distribution and initialize its style.
     *
     * @param {Object} statistics Validated whole-raster statistics.
     * @return {void}
     */
    function renderWholeRasterStatistics(statistics) {
        storeRasterStatisticsResult(rasterAnalysis, statistics, "wholeRaster");
        const initialRangeApplied = hasSelectedRasterSamplingArea()
            ? false
            : applyInitialWholeRasterStyle(statistics);
        if (!hasSelectedRasterSamplingArea()) {
            renderRasterStatistics(statistics, initialRangeApplied);
        }
        refreshActiveSessionPresentation();
    }

    /**
     * Retain and present a recoverable whole-raster statistics failure.
     *
     * @param {Error} error Statistics request failure.
     * @return {void}
     */
    function renderWholeRasterStatisticsError(error) {
        storeRasterStatisticsError(rasterAnalysis, error, "wholeRaster");
        if (!hasSelectedRasterSamplingArea()) {
            renderRasterStatisticsError(error, "wholeRaster");
        }
        refreshActiveSessionPresentation();
    }

    /**
     * Present the start of a bounded map-window or polygon selection statistics request.
     *
     * @return {void}
     */
    function renderSelectedRasterStatisticsLoading() {
        markRasterStatisticsLoading(rasterAnalysis, "selectedArea");
        rasterAnalysis.rasterStatisticsIsApplicable = false;
        controlsView.setStatisticsBusy(true);
        if (activeAppearanceIsCategorical()) controlsView.clearHistogram();
        controlsView.setStatisticsRetryVisible(false);
        controlsView.setStatisticsStatus(
            activeAppearanceIsCategorical()
                ? "Calculating categorical ground areas for the selected area…"
            : rasterAnalysis.rasterStatistics === null
                ? selectedRasterStatisticsLoadingMessage()
                : selectedRasterStatisticsLoadingMessage() + " " +
                  "The previous histogram remains visible for reference and " +
                  "cannot be applied to this selection."
        );
        refreshActiveSessionPresentation();
    }

    /**
     * Describe the active bounded statistics request without map-move chatter.
     *
     * @return {string} Accessible loading announcement for bounds or polygon selection.
     */
    function selectedRasterStatisticsLoadingMessage() {
        if (rasterAnalysis.selectedCatalogSelection === null) {
            return "Calculating a bounded histogram for the selected area...";
        }
        return (
            `Calculating a bounded histogram for vector layer ` +
            `${rasterAnalysis.selectedCatalogSelection.filename}, layer ` +
            `${rasterAnalysis.selectedCatalogSelection.selectedDataset}...`
        );
    }

    /**
     * Present one successful bounded map-window or polygon selection response.
     *
     * @param {Object} statistics Validated map-window or polygon selection statistics.
     * @return {void}
     */
    function renderSelectedRasterStatistics(statistics) {
        storeRasterStatisticsResult(rasterAnalysis, statistics, "selectedArea");
        renderRasterStatistics(statistics);
    }

    /**
     * Present a map-window or polygon selection failure while retaining prior context.
     *
     * @param {Error} error Statistics request failure.
     * @return {void}
     */
    function renderSelectedRasterStatisticsError(error) {
        storeRasterStatisticsError(rasterAnalysis, error, "selectedArea");
        rasterAnalysis.rasterStatisticsIsApplicable = false;
        if (rasterAnalysis.rasterStatistics === null && rasterAnalysis.wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(rasterAnalysis.wholeRasterStatistics, false, false);
        }
        controlsView.setStatisticsBusy(false);
        controlsView.setStatisticsRetryVisible(
            canRetryRasterStatistics(error)
        );
        if (activeAppearanceIsCategorical()) controlsView.clearHistogram();
        const areaName = rasterAnalysis.selectedCatalogSelection === null
            ? "Selected-area"
            : `Vector selection ${rasterAnalysis.selectedCatalogSelection.filename}, layer ` +
              rasterAnalysis.selectedCatalogSelection.selectedDataset;
        controlsView.setStatisticsStatus(
            activeAppearanceIsCategorical()
                ? `Categorical ground areas unavailable: ${error.message}`
            : rasterAnalysis.rasterStatistics === null
                ? `${areaName} histogram unavailable: ${error.message} ` +
                  "Manual appearance controls remain available."
                : `${areaName} histogram unavailable: ${error.message} ` +
                  "The previous histogram remains visible for reference but " +
                  "cannot be applied to this selection. Your appearance was " +
                  "preserved."
        );
        refreshActiveSessionPresentation();
    }

    /**
     * Restore whole-raster statistics after clearing a map window or polygon selection.
     *
     * @return {void}
     */
    function restoreWholeRasterStatistics() {
        rasterSampleWindowController.clearPreview();
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
        rasterAnalysis.selectedRasterBounds = null;
        rasterAnalysis.selectedCatalogSelection = null;
        rasterAnalysis.selectedRasterCenter = null;
        rasterAnalysis.selectedRasterWindowSizeKm = null;
        rasterAnalysis.selectedRasterStatistics = null;
        rasterAnalysis.selectedRasterStatisticsState = "idle";
        rasterAnalysis.selectedRasterStatisticsError = null;
        rasterSampleWindowController.clearSelection();
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        if (rasterAnalysis.wholeRasterStatisticsState === "ready" &&
            !rasterStatisticsMatchCategories(rasterAnalysis.wholeRasterStatistics, sessionCategoryValues(mapLayers.getRecord(activeLayerKey)?.state))) {
            void rasterStatisticsController.activate(activeRasterItem, WHOLE_RASTER_SAMPLING_AREA);
        } else if (rasterAnalysis.wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(rasterAnalysis.wholeRasterStatistics);
        } else if (rasterAnalysis.wholeRasterStatisticsState === "error") {
            renderRasterStatisticsError(
                rasterAnalysis.wholeRasterStatisticsError,
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
        refreshActiveSessionPresentation();
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
        if (pendingVectorSelection) {
            nextStatus = "";
        } else if (guidance) {
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
                        ? " The paired histogram uses this shared area."
                        : ""
                }`;
        } else if ((bivariateMode.active ? bivariateCatalogSelection : rasterAnalysis.selectedCatalogSelection) !== null) {
            const area = bivariateMode.active ? bivariateCatalogSelection : rasterAnalysis.selectedCatalogSelection;
            nextStatus = `Selected polygons: ${area.filename}. ` +
                "Polygon boundaries and holes define the histogram selection.";
        } else if (bivariateMode.active) {
            nextStatus = "Whole-overlap paired histogram selected. " +
                "Click the map to use one shared WGS 84 window.";
        } else {
            nextStatus = "Whole-raster histogram selected. Click the map to inspect a location.";
        }
        controlsView.setSampleWindowStatus(
            nextStatus, Boolean(guidance) && !pendingVectorSelection
        );
    }

    /**
     * Commit one map rectangle for area consumers, then refresh an active histogram.
     * Geometry selection does not require a raster; histogram reads still do.
     *
     * @param {Object} bounds Canonical selected WGS 84 bounds.
     * @param {Readonly<{longitude:number,latitude:number}>} center Original click.
     * @param {boolean} [openHistogram=true] Whether to reveal the histogram
     * workflow; delayed size edits preserve the user's active workflow.
     * @return {void}
     */
    function selectRasterSampleWindow(bounds, center, openHistogram = true) {
        onSamplingMethodChange("box");
        pendingVectorSelection = false;
        cancelRasterSampleWindowResize();
        if (bivariateMode.active) {
            bivariateCatalogSelection = null;
            bivariateSelectedCenter = center;
            bivariateSelectedBounds = bounds;
            bivariateSelectedWindowSizeKm =
                rasterSampleWindowController.windowSizeKm;
            renderRasterSamplingAreaControls();
            renderRasterSampleWindowGuidance("");
            if (openHistogram) showHistogramWorkspace();
            requestBivariateStatistics();
            return;
        }
        rasterAnalysis.selectedRasterCenter = center;
        rasterAnalysis.selectedRasterBounds = bounds;
        rasterAnalysis.selectedCatalogSelection = null;
        rasterAnalysis.selectedRasterWindowSizeKm = rasterSampleWindowController.windowSizeKm;
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        if (!canUseRasterMapInteractions()) return;
        if (openHistogram) showHistogramWorkspace();
        refreshRetainedLayerHistograms(currentRasterSamplingArea());
        void rasterStatisticsController.activate(
            activeRasterItem,
            currentRasterSamplingArea()
        );
        refreshActiveSessionPresentation();
    }

    /**
     * Explore one composition-owned map position with the current window size.
     *
     * Ordinary mode checks visible extents before selecting a histogram area.
     * 2D mode also reads both pixel values to highlight their paired histogram
     * cell, independently of published extents; the pixel API determines coverage.
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
        if (!canUseRasterMapInteractions() && rasterPointSampleParticipants().length === 0) {
            return false;
        }
        if (vectorSelection && (bivariateMode.active ? bivariateCatalogSelection : rasterAnalysis.selectedCatalogSelection)?.id === vectorSelection.id) {
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
            if (rasterAnalysis.selectedCatalogSelection !== null) {
                restoreWholeRasterStatistics();
            }
            if (rasterSampleWindowController.selectAt(position) === null) {
                // Keep controls available when the requested box is rejected.
                showHistogramWorkspace();
                return true;
            }
        }
        if (bivariateMode.active) pointSamplesController.sample(participants, point);
        if (openHistogram) {
            onSelected(getSelectedArea());
        }
        return openHistogram;
    }

    /** Cancel a pending box-size refresh without changing its current area. @return {void} */
    function cancelRasterSampleWindowResize() {
        if (rasterSampleWindowResizeTimeout === null) {
            return;
        }
        clock.clearTimeout(rasterSampleWindowResizeTimeout);
        rasterSampleWindowResizeTimeout = null;
    }

    /**
     * Commit the displayed box after size input settles, then request results.
     *
     * The mode and bounds identity guard prevents delayed work from replacing a
     * newer map click, polygon selection, active raster, or comparison mode.
     *
     * @param {Object} bounds Current canonical WGS 84 selected bounds.
     * @param {Object} resizedBounds Displayed bounds to commit after the delay.
     * @param {Readonly<{longitude:number,latitude:number}>} center Retained center.
     * @return {void}
     */
    function scheduleRasterSampleWindowResize(bounds, resizedBounds, center) {
        cancelRasterSampleWindowResize();
        const scheduledBivariateMode = bivariateMode.active;
        rasterSampleWindowResizeTimeout = clock.setTimeout(() => {
            rasterSampleWindowResizeTimeout = null;
            const [currentBounds] = getPresentedSampleWindow();
            if (
                bivariateMode.active !== scheduledBivariateMode ||
                currentBounds !== bounds
            ) {
                return;
            }
            selectRasterSampleWindow(resizedBounds, center, false);
        }, RASTER_SAMPLE_WINDOW_RESIZE_DEBOUNCE_MILLISECONDS);
    }

    /**
     * Discard an unfinished resize when leaving a sampling workflow.
     * Restore the committed box and its controls without requesting results.
     * @return {void}
     */
    function cancelSampleWindowResize() {
        if (rasterSampleWindowResizeTimeout === null) return;
        cancelRasterSampleWindowResize();
        const [bounds, size] = getPresentedSampleWindow();
        restoreRasterSampleWindow(bounds);
        rasterSampleWindowController.setWindowSize(size);
        controlsView.setSampleWindowSize(size, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
        renderRasterSampleWindowGuidance("");
        if (bivariateMode.active) updateBivariatePercentileValues();
        refreshActiveSessionPresentation();
        renderLayerHistogramSummaries();
        for (const record of mapLayers.retainedRecords) {
            if (record.adapter === rasterMapLayerAdapter) scheduleHistogramStyleUpdate(record.state);
        }
    }

    /** Select a box at the current map center from the sampling-area control. */
    function useMapCenterForRasterStatistics() {
        if (!canUseRasterMapInteractions()) {
            renderRasterSamplingAreaControls();
            return;
        }
        if (vectorSelection && (rasterAnalysis.selectedCatalogSelection?.id === vectorSelection.id || bivariateCatalogSelection?.id === vectorSelection.id)) {
            rasterAnalysis.selectedCatalogSelection = null; bivariateCatalogSelection = null;
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
        const wasResizing = rasterSampleWindowResizeTimeout !== null;
        const sideLengthKm = Number(value);
        try {
            rasterSampleWindowController.setWindowSize(sideLengthKm);
        } catch {
            cancelSampleWindowResize();
            controlsView.setSampleWindowInvalid(true);
            controlsView.setSampleWindowStatus(
                `Choose a whole-number window size from 1 through ` +
                `${MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM} km.`
            );
            return false;
        }
        controlsView.setSampleWindowInvalid(false);
        controlsView.setSampleWindowSize(sideLengthKm, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
        const [presentedBounds, presentedWindowSizeKm, center] =
            getPresentedSampleWindow();
        if (
            presentedBounds !== null &&
            presentedWindowSizeKm !== sideLengthKm
        ) {
            const resizedBounds = rasterSampleWindowController.resizeSelectionAt({lng: center.longitude, lat: center.latitude});
            if (resizedBounds === null) {
                cancelRasterSampleWindowResize();
                restoreRasterSampleWindow(presentedBounds);
            } else {
                controlsView.setSampleWindowStatus(
                    `Updating the selected map box to ${sideLengthKm} km × ` +
                    `${sideLengthKm} km…`
                );
                scheduleRasterSampleWindowResize(presentedBounds, resizedBounds, center);
            }
        } else {
            cancelRasterSampleWindowResize();
            if (presentedBounds !== null) restoreRasterSampleWindow(presentedBounds);
            renderRasterSampleWindowGuidance("");
        }
        if (bivariateMode.active) updateBivariatePercentileValues();
        refreshActiveSessionPresentation();
        renderLayerHistogramSummaries();
        if (wasResizing && rasterSampleWindowResizeTimeout === null) {
            for (const record of mapLayers.retainedRecords) {
                if (record.adapter === rasterMapLayerAdapter) scheduleHistogramStyleUpdate(record.state);
            }
        }
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
        rasterAnalysis.selectedRasterBounds = null;
        rasterAnalysis.selectedCatalogSelection = null;
        rasterAnalysis.selectedRasterCenter = null;
        rasterAnalysis.selectedRasterWindowSizeKm = null;
        rasterAnalysis.selectedRasterStatistics = null;
        rasterAnalysis.selectedRasterStatisticsState = "idle";
        rasterAnalysis.selectedRasterStatisticsError = null;
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
        cancelRasterSampleWindowResize();
        if (bivariateMode.active) {
            if (!selection) return;
            rasterAnalysis.selectedCatalogSelection = selection;
            rasterAnalysis.selectedRasterBounds = null;
            for (const record of mapLayers.retainedRecords) {
                if (record.adapter === rasterMapLayerAdapter) replaceSessionCatalogSelection(record.state, selection);
            }
            refreshActiveSessionPresentation();
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
        rasterStatisticsController.clear();
        resetPendingRasterStatisticsState();
        rasterAnalysis.selectedRasterBounds = null;
        rasterAnalysis.selectedCatalogSelection = selection;
        rasterAnalysis.selectedRasterCenter = null;
        rasterAnalysis.selectedRasterWindowSizeKm = null;
        rasterAnalysis.selectedRasterStatistics = null;
        rasterAnalysis.selectedRasterStatisticsState = "idle";
        rasterAnalysis.selectedRasterStatisticsError = null;
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
        refreshActiveSessionPresentation();
    }

    /**
     * Highlight the paired histogram cell when both clicked values are available.
     *
     * @param {{position:Readonly<Object>,samples:ReadonlyArray<Object>}|null}
     * snapshot Current point values or null after lifecycle clearing.
     * @return {void}
     */
    function highlightPairedHistogramPoint(snapshot) {
        if (snapshot === null || !bivariateMode.active) return;
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
        cursorValuesView.render(applyPixelCategoryLabels(snapshot));
    }

    /**
     * Resolve only the committed map-specific categorical presentation for a key.
     * Detached analysis and continuous layers retain ordinary numeric display.
     * This lookup never controls sampling membership, authorization, or requests.
     *
     * @param {string} key Catalog participant's retained map-layer key.
     * @return {Readonly<import("./categorical-style.js").CategoricalRasterStyle>|null}
     * Normalized immutable category table, or no categorical presentation.
     */
    function categoricalStyleForPixelPresentation(key) {
        const record = mapLayers.getRecord(key);
        return record?.adapter === rasterMapLayerAdapter &&
            record.state.appearanceMode === "categorical"
            ? record.state.categoricalStyle : null;
    }

    /**
     * Attach immutable display text to numeric results without altering values.
     *
     * @param {Readonly<Object>|null} snapshot Point or cursor result snapshot.
     * @return {Readonly<Object>|null} Prepared presentation preserving raw results.
     */
    function applyPixelCategoryLabels(snapshot) {
        return presentRasterPixelSnapshot(snapshot, categoricalStyleForPixelPresentation);
    }

    /**
     * Re-present cursor values after a committed style change.
     * The cursor view owns the displayed location while another read is pending;
     * its refresh port preserves that location and never invokes a sample request.
     *
     * @return {void}
     */
    function refreshRasterPixelPresentation() {
        cursorValuesView.refreshPresentation?.(applyPixelCategoryLabels);
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
        if (session === null || editingAppearanceMode === "categorical" || bivariateMode.contains(session.key)) return;
        session.rasterStyleWasEdited = true;
        if (session.key === activeLayerKey) rasterStyleWasEdited = true;
        if (isColor) {
            controlsView.setPaletteName("custom");
        }
        scheduleRasterStyleCommit();
    }

    /**
     * Select the editor mode, applying only a complete valid configuration.
     * An empty or invalid category draft leaves the last rendered mode intact.
     * @param {"continuous"|"categorical"} mode Requested appearance editor.
     * @return {void}
     * @throws {TypeError} If the control supplies an unsupported mode.
     */
    function handleAppearanceModeChange(mode) {
        if (mode !== "continuous" && mode !== "categorical") {
            throw new TypeError("Unsupported raster appearance mode.");
        }
        const session = editingSession();
        if (session === null || bivariateMode.contains(session.key)) return;
        if (rasterStyleCommitTimeout !== null) commitRasterStyle();
        editingAppearanceMode = mode;
        controlsView.setAppearanceMode?.(mode);
        if (mode === "categorical") {
            commitCategoricalStyle();
        } else {
            session.appearanceMode = "continuous";
            applySessionStyle(session, session.rasterStyle, session.paletteName,
                session.rasterStyleWasEdited);
            controlsView.setStyle(session.rasterStyle, session.paletteName);
            refreshSessionStatisticsForAppearance(session);
            renderBivariateAvailability();
            renderLayerStack();
            controlsView.setAppearanceStatus("Restored continuous styling with its retained palette and range.");
        }
        refreshStyle();
    }

    /**
     * Validate and apply the editing layer's complete category table atomically.
     * Invalid drafts remain in the editor and never enter rendering or persistence.
     * @return {void}
     */
    function commitCategoricalStyle() {
        const session = editingSession();
        if (session === null || editingAppearanceMode !== "categorical" ||
            bivariateMode.contains(session.key)) return;
        try {
            const style = controlsView.readCategoricalStyle();
            const parameters = { raster_style: buildCategoricalRasterStyleParameter(style) };
            if (session.layer) setRasterWmsStyle(session.layer, parameters);
            session.categoricalStyle = style;
            session.appearanceMode = "categorical";
            controlsView.renderCategoricalError?.();
        } catch (error) {
            controlsView.renderCategoricalError?.(error);
            controlsView.setAppearanceStatus("The map keeps its last valid appearance until every category is valid.");
            return;
        }
        refreshSessionStatisticsForAppearance(session);
        if (session.key === activeLayerKey && rasterAnalysis.rasterStatisticsIsApplicable) presentCategoricalHistogram();
        syncBivariateCandidate(session);
        refreshRasterPixelPresentation();
        renderBivariateAvailability();
        refreshStyle();
        renderLayerStack();
        controlsView.setAppearanceStatus("Applied categorical styling.");
    }

    /**
     * Validate category edits immediately and debounce valid map updates.
     * @return {void}
     */
    function handleCategoricalStyleInput() {
        const session = editingSession();
        if (session === null || editingAppearanceMode !== "categorical" ||
            bivariateMode.contains(session.key)) return;
        try {
            controlsView.readCategoricalStyle();
            controlsView.renderCategoricalError?.();
        } catch (error) {
            controlsView.renderCategoricalError?.(error);
        }
        scheduleRasterStyleCommit();
    }

    /**
     * Apply the palette selected in the controls to the editing session's style.
     *
     * @return {void}
     */
    function handlePaletteChange() {
        if (editingAppearanceMode === "categorical") return;
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
        if (session === null || editingAppearanceMode === "categorical" || bivariateMode.contains(session.key)) return;
        session.rasterStyleWasEdited = true;
        if (session.key === activeLayerKey) rasterStyleWasEdited = true;
        resetRasterStyle();
        commitRasterStyle();
        controlsView.setAppearanceStatus("Restored the initial colors and range.");
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
     * @return {Partial<Record<"x"|"y", {minimum:number,midpoint:number,maximum:number}>>} Applicable numeric ranges indexed by axis.
     */
    function updateBivariatePercentileValues() {
        const ranges = {};
        const available = bivariateMode.active && bivariateStatistics !== null && rasterSampleWindowResizeTimeout === null;
        for (const axis of ["x", "y"]) {
            const percentiles = getBivariatePercentiles(axis);
            const { lower, middle, upper } = percentiles;
            let message = "Waiting for a current 2D histogram.";
            let values = null;
            let invalid = false;
            if (![lower, middle, upper].every(Number.isFinite) ||
                !(0 <= lower && lower < middle && middle < upper && upper <= 100)) {
                message = "Choose increasing percentiles between 0 and 100.";
                invalid = true;
            } else if (available) {
                const estimates = [lower, middle, upper].map((percentile) =>
                    estimateRasterPairedHistogramPercentile(bivariateStatistics, axis, percentile));
                const [minimum, midpoint, maximum] = estimates;
                values = Object.fromEntries(["lower", "middle", "upper"].map((name, index) =>
                    [name, formatRasterPixelValue(estimates[index])]));
                invalid = !(minimum < midpoint && midpoint < maximum);
                message = invalid
                    ? "These percentiles give the same value. Choose a wider range or another sample."
                    : `Estimated from ${bivariateStatistics.scope === "wholeOverlap" ? "whole overlap" : "the selected sample area"}; only pixels valid in both rasters.`;
                if (!invalid) ranges[axis] = { minimum, midpoint, maximum };
            }
            controlsView.renderBivariatePercentiles(axis, {
                values, range: ranges[axis] ?? null, message, invalid, available,
                settings: percentiles, applicable: ranges[axis] !== undefined,
            });
        }
        return ranges;
    }

    /**
     * Return this paired view's retained percentile choices, following axis swaps.
     * New pairs start at 5/50/95 with ongoing map rescaling turned off.
     * Inactive axes return defaults without retaining a view entry.
     * @param {"x"|"y"} axis Current paired axis.
     * @return {import("./percentile-controls-view.js").HistogramPercentileSettings} Pair-local choices.
     */
    function getBivariatePercentiles(axis) {
        const key = bivariateMode[`${axis}Key`];
        const defaults = { ...DEFAULT_RASTER_PERCENTILES, rescale: false };
        if (key === null) return defaults;
        if (!bivariatePercentiles.has(key)) bivariatePercentiles.set(key, defaults);
        return bivariatePercentiles.get(key);
    }

    /**
     * Set usable paired percentile ranges without changing ordinary raster styles.
     * Initial results fill only missing overrides; matching opts an axis into later updates.
     * @param {boolean} initialize Whether missing ranges should receive their first sample.
     * @return {boolean} Whether any committed paired range changed.
     */
    function applyBivariatePercentileRanges(initialize) {
        const ranges = updateBivariatePercentileValues();
        let changed = false;
        for (const axis of ["x", "y"]) {
            const key = bivariateMode[`${axis}Key`];
            const previous = bivariateMode.getRange(key);
            const range = ranges[axis];
            if (!range || !(getBivariatePercentiles(axis).rescale || initialize && previous === null)) continue;
            if (previous && ["minimum", "midpoint", "maximum"].every(name => previous[name] === range[name])) continue;
            bivariateMode.setRange(key, range);
            changed = true;
        }
        return changed;
    }

    /** Cancel an uncommitted paired color update without changing its last range. @return {void} */
    function cancelBivariateStyleUpdate() {
        if (bivariateStyleTimeout === null) return;
        clock.clearTimeout(bivariateStyleTimeout);
        bivariateStyleTimeout = null;
    }

    /**
     * Retain one axis's draft and coalesce opted-in color updates using the current sample.
     * Waiting or replaced samples cannot apply an older range; slider edits never resample.
     * @param {"x"|"y"} axis Axis whose sliders or matching checkbox changed.
     * @return {void}
     */
    function handleBivariatePercentileInput(axis) {
        if (!bivariateMode.active) return;
        bivariatePercentiles.set(bivariateMode[`${axis}Key`], controlsView.readBivariatePercentiles(axis));
        const ranges = updateBivariatePercentileValues();
        if (!["x", "y"].some(name => getBivariatePercentiles(name).rescale && ranges[name])) {
            cancelBivariateStyleUpdate();
            return;
        }
        if (bivariateStyleTimeout !== null) return;
        const statistics = bivariateStatistics;
        bivariateStyleTimeout = clock.setTimeout(() => {
            bivariateStyleTimeout = null;
            if (!bivariateMode.active || statistics !== bivariateStatistics || rasterSampleWindowResizeTimeout !== null) return;
            if (!applyBivariatePercentileRanges(false)) return;
            applyBivariatePresentation();
            renderLayerStack();
        }, RASTER_STYLE_DEBOUNCE_MILLISECONDS);
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
            rasterAnalysis.selectedRasterStatisticsState = "idle";
            void rasterStatisticsController.activate(
                activeRasterItem,
                currentRasterSamplingArea()
            );
        } else {
            rasterAnalysis.wholeRasterStatisticsState = "idle";
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
        onSamplingMethodChange("whole");
        pendingVectorSelection = false;
        cancelRasterSampleWindowResize();
        restoreWholeRasterStatistics();
        if (!bivariateMode.active) {
            refreshRetainedLayerHistograms(WHOLE_RASTER_SAMPLING_AREA);
        }
        renderLayerHistogramSummaries();
        showHistogramWorkspace();
    }

    /**
     * Preview a selected sampling box and request pixel values at the pointer.
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
        if (canUseRasterMapInteractions() && controlsView.isSamplingBoxSelected()) {
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

    /** Refine display-only geodesic segments for the map's new pixel scale.
     * @return {void}
     */
    function handleMapZoomEnd() { rasterSampleWindowController.refreshGeometry(); }

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
     * Remove every retained raster and interaction, including pending category
     * imports that must not outlive their editing target.
     *
     * @return {void}
     */
    function clear() {
        clearing = true;
        for (const key of histogramStyleTimers.keys()) cancelHistogramStyleUpdate(key);
        pendingVectorSelection = false;
        controlsView.cancelCategoricalImport?.();
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
        rasterAnalysis = createRasterAnalysisState();
        bivariateStatistics = null;
        bivariateCandidates = [];
        bivariateSelectedBounds = null;
        bivariateSelectedCenter = null;
        bivariateSelectedWindowSizeKm = null;
        controlsView.setControlsVisible(false);
        controlsView.renderLayerHistograms([], null);
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

    /** Publish and attach a source through ordinary raster tiles, style and analysis.
     * @param {Object} raster Original source, metadata, label, group and capabilities.
     * @param {Object} lifecycle Composition-supplied info, Undo and removal callbacks.
     * @param {Object} [presentation={}] Initial names and group, visibility, opacity, restored appearance, signal and isCurrent callback.
     * @return {Promise<Object|null>} Retained raster record, or null after cancellation.
     * @throws {Error} If identity, appearance or layer construction fails.
     */
    async function showSource(raster, lifecycle, presentation = {}) {
        const publication = await publishRaster(raster, undefined, presentation.signal);
        if (presentation.signal?.aborted || presentation.isCurrent?.() === false) return null;
        const key = rasterSourceKey(raster);
        const record = mapLayers.addLocal({key, label: raster.label, raster, lifecycle, ...presentation, publication}, rasterMapLayerAdapter);
        renderLayerHistogramSummaries();
        return record;
    }

    /** Build the original-source descriptor for one admitted observation.
     * @param {Object} item Catalog temporal Item.
     * @param {{variable:string,time:string}} selection Explicit observation.
     * @param {boolean} available Whether this observation remains admitted.
     * @return {Object} Numerical source and presentation metadata; no rendering identity.
     */
    function temporalRaster(item, selection, available) {
        const variable = item.properties["cube:variables"][selection.variable];
        const timeLabel = new Date(selection.time).toLocaleString(undefined, {timeZone: "UTC", year: "numeric",
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
        return {
            source: {collectionId: item.collection, itemId: item.id, ...selection},
            label: `${item.properties.title ?? item.id} · ${variable?.description ?? selection.variable} · ${timeLabel} UTC`,
            bbox: item.bbox,
            assets: {data: {"raster:bands": [{unit: variable?.unit}]}},
            capabilities: {pixels: available, statistics: available, calculations: available, modelInput: false},
        };
    }

    /** Show actual admitted choices and publication feedback in a retained row.
     * @param {Object} record Temporal raster record.
     * @return {void}
     */
    function renderTemporalControls(record) {
        const temporal = record.state.temporal;
        temporal.controls.render({
            variables: Object.entries(temporal.item.properties["cube:variables"]).map(([id, value]) => ({id, label: value.description ?? id, units: value.unit})),
            ...temporal.selection, months: temporal.months, month: temporal.month,
            times: temporal.times, loading: temporal.loading, error: temporal.error,
        });
    }

    /** Replace source identity and discard results from the previous observation.
     * Keeps the row, its area, appearance, visibility and drawing order.
     * @param {Object} record Retained temporal raster.
     * @param {{variable:string,time:string}} selection Replacement observation.
     * @param {boolean} available Whether numerical readers may use the selection.
     * @return {void}
     */
    function selectTemporalObservation(record, selection, available) {
        const session = record.state, temporal = session.temporal;
        cancelHistogramStyleUpdate(session.key);
        if (rasterStyleCommitTimeout !== null) commitRasterStyle();
        if (activeLayerKey === session.key) deactivateActiveLayer();
        cancelLayerHistogramRequest(session);
        pointSamplesController.clear();
        cursorSamplesController.clear();
        const oldAnalysis = session.analysis;
        const unit = temporal.item.properties["cube:variables"][selection.variable]?.unit;
        if (unit !== temporal.unit) {
            if (bivariateMode.contains(session.key)) leaveBivariateMode("The variable's units changed. Choose the two rasters again for a 2D comparison.", false);
            session.appearanceMode = "continuous";
            session.categoricalStyle = null;
            session.rasterStyle = {...DEFAULT_RASTER_STYLE};
            session.paletteName = DEFAULT_RASTER_PALETTE_NAME;
            session.rasterStyleWasEdited = false;
            temporal.preserveRange = false;
        } else if (oldAnalysis.wholeRasterStatisticsState === "ready") {
            temporal.preserveRange = true;
        }
        temporal.unit = unit;
        temporal.selection = {...selection};
        session.item = temporalRaster(temporal.item, selection, available);
        session.analysis = {...createRasterAnalysisState(oldAnalysis.selectedCatalogSelection),
            selectedRasterBounds: oldAnalysis.selectedRasterBounds,
            selectedRasterCenter: oldAnalysis.selectedRasterCenter,
            selectedRasterWindowSizeKm: oldAnalysis.selectedRasterWindowSizeKm};
        session.publishedRaster = {bbox: session.item.bbox};
        record.publication = null;
        record.error = null;
        mapLayers.replaceLayer(record.entry.key);
        visibleHistogramSignature = null;
        mapLayers.updateLocalPresentation(record.entry.key, {sourceName: session.item.label});
        if (bivariateMode.contains(session.key)) {
            pairedStatisticsController.clear();
            bivariateStatistics = null;
            controlsView.clearPairedStatistics?.();
            syncBivariateCandidate(session);
            requestBivariateStatistics();
        }
        if (editingLayerKey === session.key) presentSessionAppearance(session);
        renderTemporalControls(record);
        mapLayers.render();
    }

    /** Publish the selected observation while analysis reads its original source.
     * Caller owns cancellation across both availability and publication work.
     * @param {Object} record Retained temporal view.
     * @param {AbortController} request Current view request.
     * @return {Promise<void>} Completion, with failures kept on the row for retry.
     */
    async function publishTemporalObservation(record, request) {
        const temporal = record.state.temporal;
        try {
            const publication = await publishRaster(record.state.item, undefined, request.signal);
            if (request.signal.aborted || mapLayers.getRecord(record.entry.key) !== record) return;
            record.publication = publication;
            record.state.publishedRaster = publication;
            record.error = null;
            temporal.error = null;
            mapLayers.replaceLayer(record.entry.key);
            if (bivariateMode.contains(record.entry.key)) applyBivariatePresentation();
        } catch (error) {
            if (request.signal.aborted) return;
            temporal.error = `Could not display this observation: ${error.message}`;
        } finally {
            if (!request.signal.aborted && mapLayers.getRecord(record.entry.key) === record) {
                temporal.loading = false;
                renderTemporalControls(record);
                mapLayers.render();
            }
        }
    }

    /** Load actual choices, retaining a saved or refreshed selection even if absent.
     * @param {Object} record Temporal view.
     * @param {{variable:string,time:string}} selection Requested observation.
     * @param {string|undefined} month Month to browse, or the first admitted month.
     * @param {boolean} chooseFirst Choose the first returned time for an explicit variable/month change.
     * @return {Promise<void>} Completion after choices and any publication.
     */
    async function loadTemporalChoices(record, selection, month, chooseFirst) {
        const temporal = record.state.temporal;
        temporal.request?.abort();
        const request = temporal.request = new AbortController();
        temporal.loading = true;
        temporal.error = null;
        temporal.times = [];
        if (selection.variable !== temporal.selection.variable) temporal.months = [];
        temporal.month = month ?? temporal.month;
        selectTemporalObservation(record, selection, false);
        try {
            const choices = await loadTimes(temporal.item, selection.variable, month, request.signal);
            if (request.signal.aborted || mapLayers.getRecord(record.entry.key) !== record) return;
            temporal.months = choices.months;
            temporal.month = choices.month;
            temporal.times = choices.times;
            const time = chooseFirst ? choices.times[0] : selection.time;
            if (!time || !choices.times.includes(time)) {
                temporal.error = "The selected observation is no longer available. Choose another time or refresh the dataset.";
                return;
            }
            selectTemporalObservation(record, {variable: selection.variable, time}, true);
            await publishTemporalObservation(record, request);
        } catch (error) {
            if (!request.signal.aborted) temporal.error = `Could not load observation times: ${error.message}`;
        } finally {
            if (!request.signal.aborted && mapLayers.getRecord(record.entry.key) === record) {
                temporal.loading = false;
                renderTemporalControls(record);
                mapLayers.render();
            }
        }
    }

    /** Select an actual timestamp from the row without reloading its month.
     * @param {Object} record Retained temporal view.
     * @param {string} time Timestamp supplied by its admitted-time control.
     * @return {Promise<void>} Completion after publication or a row-level failure.
     */
    async function changeTemporalTime(record, time) {
        const temporal = record.state.temporal;
        temporal.request?.abort();
        const request = temporal.request = new AbortController();
        temporal.loading = true;
        temporal.error = null;
        selectTemporalObservation(record, {...temporal.selection, time}, true);
        await publishTemporalObservation(record, request);
    }

    /** Retain one independently styled view of a temporal Catalog dataset.
     * A missing selection uses the first observation in the returned month. Explicit saved
     * selections remain selected when absent so restoration never substitutes data.
     * @param {Object} item Admitted Catalog temporal Item.
     * @param {{variable:string,time:string}|null} [selection=null] Explicit observation.
     * @param {Object} [presentation={}] Key for Undo, names, visibility, opacity, appearance and isCurrent callback.
     * @return {Promise<Object|null>} Retained record, including unavailable rows, or null after cancellation.
     */
    async function showTemporal(item, selection = null, presentation = {}) {
        if (presentation.isCurrent?.() === false) return null;
        const initial = selection ?? {variable: Object.keys(item.properties["cube:variables"])[0], time: item.properties["cube:dimensions"].time.extent[0]};
        const temporal = {item, selection: {...initial}, unit: item.properties["cube:variables"][initial.variable]?.unit,
            months: [], month: initial.time.slice(0, 7), times: [], request: null, loading: true, error: null,
            preserveRange: Boolean(presentation.appearance)};
        let record;
        temporal.controls = temporalControlsFactory({
            onVariableChange: variable => loadTemporalChoices(record, {...temporal.selection, variable}, undefined, true),
            onMonthChange: month => loadTemporalChoices(record, temporal.selection, month, true),
            onTimeChange: time => changeTemporalTime(record, time),
            onRetry: () => loadTemporalChoices(record, temporal.selection, temporal.selection.time.slice(0, 7), false),
        });
        const raster = temporalRaster(item, initial, false);
        record = mapLayers.addLocal({key: presentation.key ?? `local:temporal:${globalThis.crypto.randomUUID()}`, canAddView: true,
            label: raster.label, sourceName: raster.label, raster, temporal, ...presentation}, rasterMapLayerAdapter);
        await loadTemporalChoices(record, initial, selection ? initial.time.slice(0, 7) : undefined, selection === null);
        if (presentation.isCurrent?.() === false) {
            if (mapLayers.getRecord(record.entry.key) === record) mapLayers.removeKey(record.entry.key);
            return null;
        }
        return mapLayers.getRecord(record.entry.key);
    }

    /** Refresh metadata and availability for retained temporal views after a server scan.
     * Keeps explicit selections; missing observations remain visible as unavailable rows.
     * @return {Promise<void>} Completion after every retained view has refreshed.
     */
    async function refreshTemporalLayers() {
        await Promise.all(mapLayers.retainedRecords.filter(record => record.state.temporal).map(async record => {
            const temporal = record.state.temporal;
            temporal.request?.abort();
            const request = temporal.request = new AbortController();
            temporal.loading = true;
            temporal.error = null;
            selectTemporalObservation(record, temporal.selection, false);
            try {
                const item = await getTemporalItem({collection: temporal.item.collection, id: temporal.item.id});
                if (request.signal.aborted || mapLayers.getRecord(record.entry.key) !== record) return;
                temporal.item = item;
                await loadTemporalChoices(record, temporal.selection, temporal.selection.time.slice(0, 7), false);
            } catch (error) {
                if (request.signal.aborted || mapLayers.getRecord(record.entry.key) !== record) return;
                temporal.loading = false;
                temporal.error = `Could not refresh this dataset: ${error.message}`;
                selectTemporalObservation(record, temporal.selection, false);
            }
        }));
    }

    /** Return the first retained view of a Catalog temporal dataset.
     * @param {Object} item Catalog dataset identity.
     * @return {string|null} Retained key, or null when absent.
     */
    function temporalLayerKey(item) {
        return mapLayers.retainedRecords.find(record => record.state.temporal?.item.collection === item.collection &&
            record.state.temporal.item.id === item.id)?.entry.key ?? null;
    }

    /** Remove one dataset view through the ordinary row-removal lifecycle.
     * @param {Object} item Catalog dataset identity.
     * @param {boolean} [allowUndo=false] Offer the existing Undo action.
     * @return {void}
     */
    function removeTemporal(item, allowUndo = false) {
        const key = temporalLayerKey(item);
        if (key !== null) {
            if (allowUndo) mapLayers.removeWithUndo(key);
            else mapLayers.removeKey(key);
        }
    }

    /** Capture one temporal observation and its portable map appearance.
     * @param {Object} record Retained layer from the neutral stack.
     * @return {Object|null} Saved temporal layer, or null for another source owner.
     */
    function exportTemporal(record) {
        if (!record.state.temporal) return null;
        return {temporalSource: rasterSourceReference(record.state.item), visible: record.entry.visible,
            opacity: record.entry.opacity, ...(record.entry.customName ? {customName: record.entry.customName} : {}),
            style: rasterMapLayerAdapter.exportSavedState(record)};
    }

    /** Restore an explicit saved temporal observation through its normal owner.
     * @param {Object} layer Validated temporal saved-layer document.
     * @param {Object} item Current Catalog Item resolved by composition.
     * @param {()=>boolean} isCurrent Whether restoration is still requested.
     * @return {Promise<string|null>} Retained key, or null after supersession.
     */
    async function restoreTemporal(layer, item, isCurrent) {
        const {variable, time} = layer.temporalSource;
        const record = await showTemporal(item, {variable, time}, {visible: layer.visible,
            opacity: layer.opacity, customName: layer.customName, appearance: layer.style, isCurrent});
        return record?.entry.key ?? null;
    }

    /**
     * Publish and construct one raster layer without retaining or attaching it.
     *
     * @param {Object} item Selected mounted GeoTIFF STAC Item.
     * @param {{visible:boolean,opacity:number,customName?:string|null,key?:string}} presentation Initial neutral
     * layer visibility, opacity, optional name and independent view key.
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
        session.analysis.selectedRasterBounds = null;
        session.analysis.selectedCatalogSelection = nextCatalogSelection;
        session.analysis.selectedRasterCenter = null;
        session.analysis.selectedRasterWindowSizeKm = null;
        session.analysis.selectedRasterStatistics = null;
        session.analysis.selectedRasterStatisticsState = "idle";
        session.analysis.selectedRasterStatisticsError = null;
        session.analysis.rasterStatisticsIsApplicable = false;
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
            pendingVectorSelection = false;
            useCatalogSelectionForRasterStatistics(vectorSelection);
            return;
        }
        if (!previous) return;
        pendingVectorSelection = true;
        invalidVectorSamplingId = previous.id;
        const message = "Polygon selection changed. Waiting for the updated features.";
        for (const record of mapLayers.retainedRecords) {
            if (record.state.analysis?.selectedCatalogSelection?.id === previous.id) {
                cancelLayerHistogramRequest(record.state);
                replaceSessionCatalogSelection(record.state, previous);
                record.state.analysis.selectedRasterStatisticsState = "error";
                record.state.analysis.selectedRasterStatisticsError = new Error(message);
            }
        }
        if (rasterAnalysis.selectedCatalogSelection?.id === previous.id) {
            rasterStatisticsController.clear();
            rasterAnalysis.selectedRasterStatistics = null;
            rasterAnalysis.selectedRasterStatisticsState = "error";
            rasterAnalysis.selectedRasterStatisticsError = new Error(message);
            resetPendingRasterStatisticsState();
            controlsView.clearStatistics();
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

    /**
     * Wait for selected vector features without displaying the previous area.
     * Keep completed histogram caches for a later box or whole-raster choice.
     * @return {void}
     */
    function selectVectorSampling() {
        pendingVectorSelection = true;
        cancelRasterSampleWindowResize();
        rasterSampleWindowController.clear();
        rasterStatisticsController.clear();
        resetPendingRasterStatisticsState();
        for (const record of mapLayers.retainedRecords) {
            if (record.adapter === rasterMapLayerAdapter) cancelLayerHistogramRequest(record.state);
        }
        pairedStatisticsController.clear();
        bivariateStatistics = null;
        controlsView.clearPairedStatistics?.();
        clearRasterStatisticsPresentation();
        renderLayerHistogramSummaries();
        renderRasterSamplingAreaControls();
        onSamplingMethodChange("vector");
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
        leafletMap.off("zoomend", handleMapZoomEnd);
        leafletMap.off("resize", handleMapMouseLeave);
    }

    controlsView.populatePalettes(RASTER_COLOR_PALETTES);
    controlsView.bind({
        onStyleInput: handleStyleInput,
        onStyleChange: commitRasterStyle,
        onAppearanceModeChange: handleAppearanceModeChange,
        onCategoricalStyleInput: handleCategoricalStyleInput,
        onCategoricalStyleChange: commitRasterStyle,
        onPaletteChange: handlePaletteChange,
        onResetStyle: handleResetStyle,
        onHistogramPercentiles: handleHistogramPercentiles,
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
        onUseVectorArea: selectVectorSampling,
        onBivariateModeChange: handleBivariateModeChange,
        onBivariatePaletteChange: handleBivariatePaletteChange,
        onBivariateSwapAxes: handleBivariateSwapAxes,
        onBivariatePercentileInput: handleBivariatePercentileInput,
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
    leafletMap.on("zoomend", handleMapZoomEnd);
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
        showSource,
        showTemporal,
        refreshTemporalLayers,
        temporalLayerKey,
        containsTemporal: item => temporalLayerKey(item) !== null,
        removeTemporal,
        exportTemporal,
        restoreTemporal,
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
        // Composition reuses these same map-sampling actions from the floating
        // area form; Processing retains its own polygon selection lifecycle.
        /** Select a map-centered geodesic box without requiring a histogram source.
         * @return {Object|null} Captured samplingBox descriptor, or null near a pole/date line.
         */
        selectSamplingBox: () => rasterSampleWindowController.selectAt(leafletMap.getCenter()) === null
            ? null : rasterSampleWindowController.selectedArea,
        selectWholeRaster: handleClearSampleWindow,
        cancelSampleWindowResize,
        setSamplingActivity: area => rasterSampleWindowController.setActivityArea(area),
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
