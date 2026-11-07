/**
 * Present the shared raster sampling area and contextual box-size controls.
 *
 * This adapter owns sample-window sizing and whole-window/catalog-selection
 * controls. Map exploration is coordinated separately by the composition root.
 * It presents state supplied by the raster coordinator and makes no map, statistics, or request decisions.
 */
import { requireRasterControl } from "./required-control.js";
/** Slider positions are presentation values; callbacks always carry kilometers. */
const SAMPLE_WINDOW_SLIDER_STEPS = 1000;

/**
 * @typedef {Object} RasterSamplingAreaHandlers
 * @property {(value: string) => void} onSampleWindowRangeInput Changes the
 * sample-window size from the range control.
 * @property {(value: string) => void} onSampleWindowNumberInput Changes the
 * sample-window size from the numeric control.
 * @property {(value: string) => void} onSampleWindowNumberChange Commits the
 * numeric sample-window size.
 * @property {() => void} onClearSampleWindow Restores whole-raster statistics.
 * @property {() => void} onUseMapWindow Selects a map-centered sample box.
 * @property {() => void} onUseVectorArea Stops box preview while choosing polygons.
 */

/** Present map sampling choices independently of inspection-panel visibility. */
export class RasterSamplingAreaControlsView {
    #root;
    /** @type {boolean} Whether current spatial guidance is shown visually. */
    #sampleWindowGuidanceVisible = false;

    /**
     * Resolve the required sampling-area elements once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the controls.
     * @throws {Error} If any required sampling-area element is missing.
     */
    constructor(documentContext = globalThis.document) {
        this.#root = requireRasterControl(
            documentContext,
            "#raster-sampling-area-controls"
        );
        this.disclosure = requireRasterControl(documentContext, "#raster-sampling-disclosure");
        this.disclosureSummary = requireRasterControl(documentContext, "#raster-sampling-disclosure > summary");
        this.dimensions = requireRasterControl(documentContext, "#raster-sample-window-dimensions");
        this.areaLabel = "No raster selected";
        this.samplingAreaSummary = requireRasterControl(
            documentContext,
            "#raster-sampling-area-summary"
        );
        this.wholeRasterChoiceLabel = requireRasterControl(
            documentContext,
            "#raster-sampling-area-whole-label"
        );
        this.sampleWindowRange = requireRasterControl(
            documentContext,
            "#raster-sample-window-range"
        );
        this.sampleWindowNumber = requireRasterControl(
            documentContext,
            "#raster-sample-window-number"
        );
        this.clearSampleWindowButton = requireRasterControl(
            documentContext,
            "#clear-raster-sample-window"
        );
        this.sampleWindowRange.min = "0";
        this.sampleWindowRange.max = String(SAMPLE_WINDOW_SLIDER_STEPS);
        this.sampleWindowRange.step = "any";
        this.maximumWindowSizeKm = null;
        this.useMapWindowButton = requireRasterControl(
            documentContext,
            "#use-map-window-for-raster"
        );
        this.mapBoxControls = requireRasterControl(
            documentContext,
            "#raster-map-box-controls"
        );
        this.sampleWindowStatus = requireRasterControl(
            documentContext,
            "#raster-sample-window-status"
        );
        this.vectorChoice = requireRasterControl(documentContext, "#use-vector-for-raster");
        this.vectorControls = requireRasterControl(documentContext, "#vector-sampling");
        this.handlers = null;
        this.boundSampleWindowRangeInput =
            this.#handleSampleWindowRangeInput.bind(this);
        this.boundSampleWindowRangeKeydown =
            this.#handleSampleWindowRangeKeydown.bind(this);
        this.boundSampleWindowNumberInput =
            this.#handleSampleWindowNumberInput.bind(this);
        this.boundSampleWindowNumberChange =
            this.#handleSampleWindowNumberChange.bind(this);
        this.boundClearSampleWindow = this.#handleClearSampleWindow.bind(this);
        this.boundUseMapWindow = this.#handleUseMapWindow.bind(this);
        this.boundUseVectorArea = this.#handleUseVectorArea.bind(this);
        this.boundVisibilityChange = this.#renderSelectedControls.bind(this);
    }

    /**
     * Attach direct sampling-area listeners to semantic handlers.
     *
     * @param {RasterSamplingAreaHandlers} handlers Sampling-area handlers.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        this.disclosure.addEventListener("toggle", this.boundVisibilityChange);
        this.#root.addEventListener("change", this.boundVisibilityChange);
        this.sampleWindowRange.addEventListener(
            "input",
            this.boundSampleWindowRangeInput
        );
        this.sampleWindowRange.addEventListener("keydown", this.boundSampleWindowRangeKeydown);
        this.sampleWindowNumber.addEventListener(
            "input",
            this.boundSampleWindowNumberInput
        );
        this.sampleWindowNumber.addEventListener(
            "change",
            this.boundSampleWindowNumberChange
        );
        this.clearSampleWindowButton.addEventListener(
            "change",
            this.boundClearSampleWindow
        );
        this.useMapWindowButton.addEventListener(
            "change",
            this.boundUseMapWindow
        );
        this.vectorChoice.addEventListener("change", this.boundUseVectorArea);
    }

    /** Remove every direct listener installed by {@link bind}. @return {void} */
    unbind() {
        this.disclosure.removeEventListener("toggle", this.boundVisibilityChange);
        this.#root.removeEventListener("change", this.boundVisibilityChange);
        this.sampleWindowRange.removeEventListener(
            "input",
            this.boundSampleWindowRangeInput
        );
        this.sampleWindowRange.removeEventListener("keydown", this.boundSampleWindowRangeKeydown);
        this.sampleWindowNumber.removeEventListener(
            "input",
            this.boundSampleWindowNumberInput
        );
        this.sampleWindowNumber.removeEventListener(
            "change",
            this.boundSampleWindowNumberChange
        );
        this.clearSampleWindowButton.removeEventListener(
            "change",
            this.boundClearSampleWindow
        );
        this.useMapWindowButton.removeEventListener(
            "change",
            this.boundUseMapWindow
        );
        this.vectorChoice.removeEventListener("change", this.boundUseVectorArea);
        this.handlers = null;
    }

    /**
     * Synchronize both sample-window size controls.
     *
     * @param {number|string} value Valid sample-window side length.
     * @param {number} maximumSizeKm Geometry-owned maximum supplied by the caller.
     * @return {void}
     */
    setSampleWindowSize(value, maximumSizeKm) {
        this.maximumWindowSizeKm = maximumSizeKm;
        this.sampleWindowNumber.max = String(maximumSizeKm);
        this.sampleWindowRange.value = String(
            Math.log(Number(value)) / Math.log(maximumSizeKm) *
                SAMPLE_WINDOW_SLIDER_STEPS
        );
        this.sampleWindowRange.setAttribute("aria-valuetext", `${value} kilometers`);
        this.sampleWindowNumber.value = String(value);
        this.dimensions.textContent = `${value} × ${value} km`;
        this.#renderAreaSummary();
    }

    /** Display a foreground workflow's committed area while it edits its own form.
     * The composition root supplies context; this view does not inspect the workflow.
     * @param {{scope:string,usesSamplingBox:boolean}|null} context Area description, or null for the ordinary map sampler.
     * @return {void}
     */
    setAreaContext(context) {
        this.areaContext = context;
        this.#renderSelectedControls();
    }

    /** Keep vector-area editing available when there is no active raster.
     * @param {boolean} available Whether a raster owns the box and whole-raster actions.
     * @return {void}
     */
    setActiveRasterAvailable(available) {
        this.useMapWindowButton.disabled = !available;
        this.clearSampleWindowButton.disabled = !available;
    }

    /** Return whether Sampling box is selected for pointer preview.
     * @return {boolean} Whether the Sampling box radio is checked.
     */
    isSamplingBoxSelected() {
        return this.areaContext?.usesSamplingBox ?? this.useMapWindowButton.checked;
    }

    /** Open the existing area choices while leaving the current results visible.
     * @return {void}
     */
    openAreaEditor() {
        this.disclosure.open = true;
        this.#renderSelectedControls();
        this.disclosureSummary.focus();
    }

    /** Show subordinate controls only for the chosen area, without applying it.
     * @return {void}
     */
    #renderSelectedControls() {
        const boxSelected = this.areaContext?.usesSamplingBox ?? this.useMapWindowButton.checked;
        this.mapBoxControls.hidden = !boxSelected;
        this.vectorControls.hidden = !this.vectorChoice.checked;
        this.#renderAreaSummary();
    }

    /**
     * Set whether the numeric sample-window size violates its contract.
     *
     * @param {boolean} isInvalid Whether the numeric value is invalid.
     * @return {void}
     */
    setSampleWindowInvalid(isInvalid) {
        this.sampleWindowStatus.classList.toggle(
            "visually-hidden", !isInvalid && !this.#sampleWindowGuidanceVisible
        );
        if (isInvalid) {
            this.sampleWindowNumber.setAttribute("aria-invalid", "true");
        } else {
            this.sampleWindowNumber.removeAttribute("aria-invalid");
        }
    }

    /**
     * Show spatial guidance or announce routine sampling status.
     *
     * @param {string} message Guidance or ordinary selection announcement.
     * @param {boolean} [showMessage=false] Show the message visually even when
     * the numeric size is valid. Routine status remains available to screen readers.
     * @return {void}
     */
    setSampleWindowStatus(message, showMessage = false) {
        this.#sampleWindowGuidanceVisible = showMessage;
        this.sampleWindowStatus.classList.toggle(
            "visually-hidden",
            !showMessage && this.sampleWindowNumber.getAttribute("aria-invalid") !== "true"
        );
        if (this.sampleWindowStatus.textContent !== message) {
            this.sampleWindowStatus.textContent = message;
        }
    }

    /**
     * Label the action that clears a selected histogram window.
     *
     * @param {string} label Whole-raster restore or sampled-histogram clear
     * wording owned by the active rendering mode.
     * @return {void}
     * @throws {TypeError} If the label is empty or non-text.
     */
    setClearSampleWindowLabel(label) {
        if (typeof label !== "string" || label.trim() === "") {
            throw new TypeError("Histogram clear label must not be blank");
        }
        this.wholeRasterChoiceLabel.textContent = label;
    }

    /**
     * Present the current whole-raster, box, or catalog selection.
     * No histogram raster ("none") leaves an explicitly chosen vector editor open.
     *
     * @param {string} mode Selection discriminator.
     * @param {string} [label=""] Readable selected-area description.
     * @return {void}
     * @throws {RangeError} If the mode is outside the sampling-area contract.
     */
    setSamplingAreaMode(mode, label = "") {
        if (!["none", "wholeRaster", "selectedArea", "catalogSelection", "polygonArea", "vector"].includes(mode)) {
            throw new RangeError(`Unknown raster sampling-area mode: ${mode}`);
        }
        this.vectorChoice.checked = ["vector", "catalogSelection", "polygonArea"].includes(mode) ||
            (mode === "none" && this.vectorChoice.checked);
        this.clearSampleWindowButton.checked = mode === "wholeRaster";
        this.useMapWindowButton.checked = mode === "selectedArea";
        this.areaLabel = mode === "none" && this.vectorChoice.checked ? "Polygon layer" :
            label || (mode === "none" ? "No raster selected" : "Whole raster");
        this.#renderSelectedControls();
    }

    /** Describe the collapsed area without repeating dimensions when expanded.
     * @return {void}
     */
    #renderAreaSummary() {
        this.samplingAreaSummary.textContent = this.disclosure.open ? "Sample area" : this.isSamplingBoxSelected()
            ? `Sampling box · ${this.dimensions.textContent}`
            : `Sample area · ${this.areaContext?.scope ?? this.areaLabel}`;
    }

    /** Convert a logarithmic slider edit to integer kilometers. @return {void} */
    #handleSampleWindowRangeInput() {
        const kilometers = Math.round(this.maximumWindowSizeKm ** (
            Number(this.sampleWindowRange.value) / SAMPLE_WINDOW_SLIDER_STEPS
        ));
        this.sampleWindowRange.setAttribute("aria-valuetext", `${kilometers} kilometers`);
        this.handlers.onSampleWindowRangeInput(String(kilometers));
    }

    /**
     * Keep keyboard steps useful after logarithmic positions round to kilometers.
     * Arrow keys move at least one kilometer; Page keys move one tenth of the
     * slider. Home and End select its endpoints.
     *
     * @param {KeyboardEvent} event Slider keyboard event.
     * @return {void}
     */
    #handleSampleWindowRangeKeydown(event) {
        const steps = {ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1,
            PageUp: 100, PageDown: -100};
        if (!(event.key in steps) && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const position = Number(this.sampleWindowRange.value);
        const maximum = this.maximumWindowSizeKm;
        const current = Math.round(maximum ** (position / SAMPLE_WINDOW_SLIDER_STEPS));
        const step = steps[event.key];
        const candidate = event.key === "Home" ? 1 : event.key === "End" ? maximum :
            Math.round(maximum ** ((position + step) / SAMPLE_WINDOW_SLIDER_STEPS));
        const next = Math.min(maximum, Math.max(1,
            step > 0 ? Math.max(current + 1, candidate) :
            step < 0 ? Math.min(current - 1, candidate) : candidate));
        this.setSampleWindowSize(next, maximum);
        this.handlers.onSampleWindowRangeInput(String(next));
    }

    /** Forward a numeric size edit with its current text value. @return {void} */
    #handleSampleWindowNumberInput() {
        this.handlers.onSampleWindowNumberInput(this.sampleWindowNumber.value);
    }

    /** Forward a committed numeric size edit. @return {void} */
    #handleSampleWindowNumberChange() {
        this.handlers.onSampleWindowNumberChange(this.sampleWindowNumber.value);
    }

    /** Forward whole-raster restoration. @return {void} */
    #handleClearSampleWindow() {
        if (this.clearSampleWindowButton.checked) {
            this.handlers.onClearSampleWindow();
        }
    }

    /** Forward map-centered box selection. @return {void} */
    #handleUseMapWindow() {
        if (this.useMapWindowButton.checked) {
            this.handlers.onUseMapWindow();
        }
    }

    /** Forward the choice to edit a vector sampling area. @return {void} */
    #handleUseVectorArea() {
        if (this.vectorChoice.checked) {
            this.handlers.onUseVectorArea();
        }
    }

}
