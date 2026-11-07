/**
 * Compose the raster viewer's DOM controls and readouts.
 *
 * RasterControlsView preserves the viewer-facing contract while delegating
 * subgroup element lookup, direct event listeners, control reads, and
 * presentation to focused appearance, sampling-area, histogram, and percentile
 * adapters. It contains no fetch, Leaflet,
 * rendering, statistics, or lifecycle decisions.
 */
import { RasterAppearanceControlsView } from "./appearance-controls-view.js";
import { BivariateRasterControlsView } from "./bivariate-controls-view.js";
import { RasterHistogramControlsView } from "./histogram-controls-view.js";
import {
    RasterSamplingAreaControlsView,
} from "./sampling-area-controls-view.js";
import { RasterStyleHistogramView } from "./style-histogram-view.js";

/**
 * @typedef {Object} RasterControlHandlers
 * @property {(isColor: boolean) => void} onStyleInput Handles style edits.
 * @property {() => void} onStyleChange Commits a completed style edit.
 * @property {(mode:"continuous"|"categorical")=>void} onAppearanceModeChange Selects the appearance editor.
 * @property {()=>void} onCategoricalStyleInput Validates category drafts.
 * @property {()=>void} onCategoricalStyleChange Commits a valid category draft.
 * @property {() => void} onPaletteChange Applies a selected color palette.
 * @property {() => void} onResetStyle Restores the initial raster style.
 * @property {(key:string,settings:import("./percentile-controls-view.js").HistogramPercentileSettings)=>void}
 * onHistogramPercentiles Updates percentile inspection and optional rescaling for one view.
 * @property {() => void} onOpenHistogram Opens the full raster-analysis view.
 * @property {() => void} onRetryStatistics Retries raster statistics.
 * @property {(key: string) => void} onSelectHistogram Activates one retained
 * raster selected from the histogram summaries.
 * @property {(key: string) => void} onStyleHistogram Opens Style for one
 * retained raster selected from the histogram summaries.
 * @property {(value: string) => void} onSampleWindowRangeInput Changes the
 * sample-window size from the range control.
 * @property {(value: string) => void} onSampleWindowNumberInput Changes the
 * sample-window size from the numeric control.
 * @property {(value: string) => void} onSampleWindowNumberChange Commits the
 * numeric sample-window size.
 * @property {() => void} onClearSampleWindow Restores whole-raster statistics.
 * @property {() => void} onUseMapWindow Selects a map-centered sample box.
 * @property {() => void} onUseVectorArea Stops box preview while choosing polygons.
 * @property {(mode: string) => void} onBivariateModeChange Changes explicit
 * overlay/bivariate mode.
 * @property {(paletteName: string) => void} onBivariatePaletteChange Changes
 * the coordinated two-axis palette.
 * @property {() => void} onBivariateSwapAxes Swaps deterministic X/Y roles.
 * @property {() => void} onRetryPairedStatistics Retries paired statistics.
 * @property {(axis:"x"|"y") => void} onBivariatePercentileInput Updates paired percentiles and optional color matching.
 */

/**
 * Preserve the raster viewer's DOM boundary and own composite presentation by
 * composing focused adapters.
 */
export class RasterControlsView {
    #appearanceView;
    #bivariateView;
    #histogramView;
    #samplingAreaView;
    #styleHistogramView;

    /**
     * Resolve the complete raster-control DOM contract once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the controls.
     * @throws {Error} If any required raster-control element is missing.
     */
    constructor(documentContext = globalThis.document) {
        this.#appearanceView = new RasterAppearanceControlsView(documentContext);
        this.#bivariateView = new BivariateRasterControlsView(documentContext);
        this.#histogramView = new RasterHistogramControlsView(documentContext);
        this.#samplingAreaView = new RasterSamplingAreaControlsView(
            documentContext
        );
        this.#styleHistogramView = new RasterStyleHistogramView(
            documentContext
        );
    }

    /**
     * Add the supported palettes and the user-edited custom option.
     *
     * @param {Object<string, {label: string}>} palettes Palette definitions.
     * @return {void}
     */
    populatePalettes(palettes) {
        this.#appearanceView.populatePalettes(palettes);
        this.#bivariateView.populatePalettes();
    }

    /**
     * Identify the active histogram and enable its analysis actions.
     *
     * @param {string} label Readable raster basename.
     * @return {void}
     */
    setActiveLayer(label) {
        this.#histogramView.setActiveLayer(label);
        this.#histogramView.enableActiveRasterActions();
    }

    /**
     * Render one summary per retained raster without exposing layer-stack DOM.
     *
     * @param {Object[]} summaries Presentation-ready histogram summaries.
     * @param {string|null} activeKey Active retained raster key, or null.
     * @return {void}
     */
    renderLayerHistograms(summaries, activeKey) {
        this.#histogramView.renderLayerHistograms(summaries, activeKey);
    }

    /**
     * Attach every focused adapter to the existing semantic viewer handlers.
     *
     * @param {RasterControlHandlers} handlers Raster-viewer event handlers.
     * @return {void}
     */
    bind(handlers) {
        this.#appearanceView.bind(handlers);
        this.#bivariateView.bind(handlers);
        this.#histogramView.bind(handlers);
        this.#samplingAreaView.bind(handlers);
        this.#styleHistogramView.bind(handlers);
    }

    /** Remove every listener installed by {@link bind}. @return {void} */
    unbind() {
        this.#appearanceView.unbind();
        this.#bivariateView.unbind();
        this.#histogramView.unbind();
        this.#samplingAreaView.unbind();
        this.#styleHistogramView.unbind();
    }

    /**
     * Read a candidate raster style from the appearance controls.
     *
     * @return {Object} Candidate numeric thresholds and color stops.
     */
    readStyle() {
        return this.#appearanceView.readStyle();
    }

    /**
     * Display one committed style and palette in the appearance controls.
     *
     * @param {Object} style Committed numeric thresholds and color stops.
     * @param {string} paletteName Selected palette name.
     * @return {void}
     */
    setStyle(style, paletteName) {
        this.#appearanceView.setStyle(style, paletteName);
    }

    /**
     * Select the appearance editor without changing committed layer state.
     * @param {"continuous"|"categorical"} mode Editor mode.
     * @return {void}
     */
    setAppearanceMode(mode) {
        this.#appearanceView.setAppearanceMode(mode);
    }

    /**
     * Hydrate a category draft when the editing target changes.
     * @param {Object|null} style Validated category table, or a new empty draft.
     * @return {void}
     */
    setCategoricalStyle(style) {
        this.#appearanceView.setCategoricalStyle(style);
    }

    /**
     * Cancel the appearance editor's transient CSV preview and outstanding read.
     * @return {void}
     */
    cancelCategoricalImport() {
        this.#appearanceView.cancelCategoricalImport();
    }

    /**
     * Validate and read the category editor's current draft.
     * @return {Object} Canonical immutable categorical style.
     * @throws {Error} If any category field or table limit is invalid.
     */
    readCategoricalStyle() {
        return this.#appearanceView.readCategoricalStyle();
    }

    /**
     * Present a category field or table validation error.
     * @param {Error|null} [error=null] Error to display or clear.
     * @return {void}
     */
    renderCategoricalError(error = null) {
        this.#appearanceView.renderCategoricalError(error);
    }

    /** Return the currently selected palette name. @return {string} Palette name. */
    getPaletteName() {
        return this.#appearanceView.getPaletteName();
    }

    /**
     * Select one palette without changing any raster style fields.
     *
     * @param {string} paletteName Palette name or `custom`.
     * @return {void}
     */
    setPaletteName(paletteName) {
        this.#appearanceView.setPaletteName(paletteName);
    }

    /**
     * Present a style validation error on the fields it describes.
     *
     * @param {(Error & {fieldGroup?: string})|null} [styleError=null] Error.
     * @return {void}
     */
    renderStyleError(styleError = null) {
        this.#appearanceView.renderStyleError(styleError);
    }

    /**
     * Announce one completed appearance action beside the style controls.
     *
     * @param {string} message Concise result, or an empty string to clear it.
     * @return {void}
     * @throws {TypeError} If the message is not a string.
     */
    setAppearanceStatus(message) {
        this.#appearanceView.setStatus(message);
    }

    /**
     * Render the accessible legend for one committed raster style.
     *
     * @param {Object} style Committed numeric thresholds and color stops.
     * @return {void}
     */
    renderLegend(style) {
        this.#appearanceView.renderLegend(style);
    }

    /**
     * Read draft histogram percentiles and color matching for one 2D axis.
     * @param {"x"|"y"} axis Paired axis.
     * @return {import("./percentile-controls-view.js").HistogramPercentileSettings} Percentile positions and opt-in matching.
     */
    readBivariatePercentiles(axis) {
        return this.#bivariateView.readPercentiles(axis);
    }

    /**
     * Present a 2D axis's estimated values and application availability.
     * @param {"x"|"y"} axis Paired axis.
     * @param {Parameters<BivariateRasterControlsView["renderPercentiles"]>[1]} state Retained choices, estimates and current sample availability.
     * @return {void}
     */
    renderBivariatePercentiles(axis, state) {
        this.#bivariateView.renderPercentiles(axis, state);
    }


    /** Remove histogram content and hide result-only controls. @return {void} */
    clearStatistics() {
        this.#histogramView.clearStatistics();
    }

    /**
     * Set whether the statistics region is awaiting a response.
     *
     * @param {boolean} isBusy Whether statistics are loading.
     * @return {void}
     */
    setStatisticsBusy(isBusy) {
        this.#histogramView.setStatisticsBusy(isBusy);
    }

    /**
     * Replace the current user-facing statistics status.
     *
     * @param {string} message Statistics status message.
     * @return {void}
     */
    setStatisticsStatus(message) {
        this.#histogramView.setStatisticsStatus(message);
    }

    /**
     * Render the fixed-bin histogram using the committed raster style.
     *
     * @param {Object} statistics Validated raster statistics.
     * @param {Object} style Committed raster style.
     * @param {string} [valueLabel="Raster value"] Axis label with known units.
     * @param {{key:string,settings:import("./percentile-controls-view.js").HistogramPercentileSettings,
     * canRescale:boolean,message:string}|null} [percentileContext=null] View identity and rescaling availability.
     * @return {void}
     */
    renderHistogram(statistics, style, valueLabel = "Raster value", percentileContext = null) {
        this.#histogramView.renderHistogram(statistics, style, valueLabel, percentileContext);
    }

    /**
     * Render prepared categorical ground areas for the active analysis.
     * @param {import("./categorical-presentation.js").CategoricalAreaPresentation} presentation Category areas and appearance.
     * @return {void}
     */
    renderCategoricalHistogram(presentation) {
        this.#histogramView.renderCategoricalHistogram(presentation);
    }

    /**
     * Render prepared categorical ground areas in the style editor.
     * @param {import("./categorical-presentation.js").CategoricalAreaPresentation} presentation Category areas and appearance.
     * @param {string} scopeLabel Readable sampling scope.
     * @param {import("./style-histogram-view.js").RasterStyleHistogramFeedback} [feedback] Scoped request feedback alongside the distribution.
     * @return {void}
     */
    renderCategoricalStyleHistogram(presentation, scopeLabel, feedback) {
        this.#styleHistogramView.renderCategorical(presentation, scopeLabel, feedback);
    }

    /**
     * Present style-histogram loading or unavailable guidance.
     *
     * @param {string} scopeLabel Readable sampling scope.
     * @param {string} message Current histogram status.
     * @param {boolean} [isBusy=false] Whether statistics are loading.
     * @return {void}
     */
    renderStyleHistogramState(scopeLabel, message, isBusy = false) {
        this.#styleHistogramView.renderState(scopeLabel, message, isBusy);
    }

    /** Hide and release the keyed style-histogram preview. @return {void} */
    clearStyleHistogram() {
        this.#styleHistogramView.clear();
    }

    /** Hide and empty the fixed-bin histogram chart. @return {void} */
    clearHistogram() {
        this.#histogramView.clearHistogram();
    }

    /**
     * Set whether the statistics retry action is available.
     *
     * @param {boolean} isVisible Whether the retry action should be visible.
     * @return {void}
     */
    setStatisticsRetryVisible(isVisible) {
        this.#histogramView.setStatisticsRetryVisible(isVisible);
    }

    /**
     * Synchronize both sample-window size controls.
     *
     * @param {number|string} value Valid sample-window side length.
     * @param {number} maximumSizeKm Geometry-owned maximum supplied by the caller.
     * @return {void}
     */
    setSampleWindowSize(value, maximumSizeKm) {
        this.#samplingAreaView.setSampleWindowSize(value, maximumSizeKm);
    }

    /**
     * Set whether the numeric sample-window size violates its contract.
     *
     * @param {boolean} isInvalid Whether the numeric value is invalid.
     * @return {void}
     */
    setSampleWindowInvalid(isInvalid) {
        this.#samplingAreaView.setSampleWindowInvalid(isInvalid);
    }

    /**
     * Present sampling status with optional visible spatial guidance.
     *
     * @param {string} message Guidance or ordinary selection announcement.
     * @param {boolean} [showMessage=false] Show the message visually even when
     * the numeric size is valid.
     * @return {void}
     */
    setSampleWindowStatus(message, showMessage = false) {
        this.#samplingAreaView.setSampleWindowStatus(message, showMessage);
    }

    /**
     * Label the action that clears a selected histogram window.
     *
     * @param {string} label Whole-raster restore or sampled-histogram clear.
     * @return {void}
     * @throws {TypeError} If the label is empty or non-text.
     */
    setClearSampleWindowLabel(label) {
        this.#samplingAreaView.setClearSampleWindowLabel(label);
    }

    /**
     * Mark the active histogram-area choice without changing availability.
     *
     * @param {"none"|"wholeRaster"|"selectedArea"|"catalogSelection"|"polygonArea"|"vector"} mode
     * Active area, or no selected histogram area for the raster.
     * @param {string} [label=""] Optional semantic histogram scope label.
     * @return {void}
     */
    setSamplingAreaMode(mode, label = "") {
        this.#samplingAreaView.setSamplingAreaMode(mode, label);
        this.#histogramView.setSamplingAreaMode(mode);
    }

    /** Return whether Sampling box is selected for pointer preview.
     * @return {boolean} Whether the Sampling box radio is checked.
     */
    isSamplingBoxSelected() {
        return this.#samplingAreaView.isSamplingBoxSelected();
    }

    /** Show composed area context without replacing the map sampler's retained selection.
     * @param {{scope:string,usesSamplingBox:boolean}|null} context Foreground workflow area, or ordinary map sampling.
     * @return {void}
     */
    setSamplingAreaContext(context) {
        this.#samplingAreaView.setAreaContext(context);
    }

    /** Focus area choices without opening or recalculating a histogram. @return {void} */
    openSamplingControls() {
        this.#samplingAreaView.openAreaEditor();
    }

    /**
     * Reveal the contextual histogram for an explicit sampling request.
     * The current result remains owned by the histogram adapter.
     *
     * @return {void}
     */
    showHistogramWidget() {
        this.#histogramView.showWidget();
    }

    /**
     * Set whether the active analysis target has a map renderer whose style
     * can be edited. Analysis and histogram visibility remain independent.
     *
     * @param {boolean} isAvailable Whether rendering controls have a target.
     * @return {void}
     */
    setRenderingControlsAvailable(isAvailable) {
        this.#appearanceView.setActiveRasterAvailable(isAvailable);
    }

    /**
     * Show histogram controls and enable sampling actions for an active raster.
     *
     * @param {boolean} isVisible Whether a raster owns the histogram controls.
     * @return {void}
     */
    setControlsVisible(isVisible) {
        this.#samplingAreaView.setActiveRasterAvailable(isVisible);
        this.#histogramView.setActiveRasterAvailable(isVisible);
    }

    /**
     * Set whether ordinary single-raster appearance editing is available.
     *
     * @param {boolean} isEnabled Whether ordinary appearance is editable.
     * @return {void}
     */
    setAppearanceEnabled(isEnabled) {
        this.#appearanceView.setEnabled(isEnabled);
    }

    /**
     * Show the ordinary detailed histogram only in overlay mode.
     *
     * @param {boolean} isVisible Whether the histogram region is compatible.
     * @return {void}
     */
    setUnivariateHistogramVisible(isVisible) {
        this.#histogramView.setModeCompatible(isVisible);
    }

    /**
     * Present current eligibility for explicit bivariate mode.
     *
     * @param {boolean} canEnter Whether two catalog raster candidates exist.
     * @param {string} guidance User-facing eligibility or active guidance.
     * @return {void}
     */
    setBivariateAvailability(canEnter, guidance) {
        this.#bivariateView.setAvailability(canEnter, guidance);
    }

    /**
     * Render explicit bivariate mode, roles, palette, and 2D legend.
     *
     * @param {Object} state Viewer-owned bivariate presentation state.
     * @return {void}
     */
    renderBivariateMode(state) {
        this.#bivariateView.renderMode(state);
    }

    /** Set whether the paired histogram can hand its area to other tools.
     * @param {boolean} available Whether the area is supported by the destination tools.
     * @return {void}
     */
    setPairedAreaActionsAvailable(available) {
        this.#bivariateView.setAreaActionsAvailable(available);
    }

    /** Reveal and focus the paired controls in the histogram. @return {void} */
    openBivariateStyle() {
        this.#bivariateView.openStyle();
    }

    /**
     * Present paired-statistics loading without discarding a current chart.
     *
     * @param {string} message Loading guidance.
     * @return {void}
     */
    setPairedStatisticsLoading(message) {
        this.#bivariateView.setStatisticsLoading(message);
    }

    /**
     * Present a paired-statistics failure and optional retry action.
     *
     * @param {Error} error Current paired request failure.
     * @param {boolean} canRetry Whether retry is useful.
     * @return {void}
     */
    renderPairedStatisticsError(error, canRetry) {
        this.#bivariateView.renderStatisticsError(error, canRetry);
    }

    /**
     * Render the ESOS-C-compatible 2D histogram and colored marginals.
     *
     * @param {Object} statistics Validated paired-statistics response.
     * @param {Object} presentation Current X/Y labels, styles, and palette.
     * @return {void}
     */
    renderPairedStatistics(statistics, presentation) {
        this.#bivariateView.renderStatistics(statistics, presentation);
    }

    /** Clear paired-statistics presentation. @return {void} */
    clearPairedStatistics() {
        this.#bivariateView.clearStatistics();
    }

    /**
     * Mark the paired histogram bin containing a dual click result.
     *
     * @param {number} xValue Finite X sample.
     * @param {number} yValue Finite Y sample.
     * @return {void}
     */
    highlightPairedStatistics(xValue, yValue) {
        this.#bivariateView.highlightPair(xValue, yValue);
    }

}
