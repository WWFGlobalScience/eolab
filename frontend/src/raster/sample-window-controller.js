/**
 * Interaction controller for the map's raster sample window.
 *
 * This module owns a passive pointer preview, one-shot map-position selection,
 * and outline cleanup. Neutral geodesic geometry and Leaflet conversion are
 * delegated. Selection emits its read-window envelope and original center;
 * captured consumers use the center/size descriptor, never the envelope as its area.
 */
import {
    buildRasterSampleWindowArea,
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
    isCanonicalWgs84Position,
    RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE,
    RASTER_SAMPLE_WINDOW_MAP_BOUNDS_GUIDANCE,
    validateRasterSampleWindowSize
} from "./geometry.js";
import { SamplingBoxBoundaryError, samplingBoxBounds, samplingBoxesEqual } from "../sampling-box.js";
import { rasterSampleBoundsToLeaflet } from "./leaflet.js";

/**
 * Create a preview or committed sampling outline.
 *
 * @callback RasterSampleLayerFactory
 * @param {Array<Array<number>>} bounds Leaflet southwest/northeast corners.
 * @param {"preview"|"selection"} kind Requested layer presentation.
 * @param {import("../sampling-box.js").SamplingBox|null} samplingBox Optional geodesic geometry.
 * @return {{addTo: (map: Object) => Object, setSampleWindow: (bounds: Array<Array<number>>, samplingBox: Object|null) => void}}
 * Leaflet-compatible polygon layer.
 */

/**
 * Receive a committed raster sample window.
 *
 * @callback RasterSampleSelectionHandler
 * @param {Object} bounds Canonical WGS 84 read-window envelope.
 * @param {Readonly<{longitude:number,latitude:number}>} center Original click,
 * retained by the caller with its bounds for subsequent resize and restore.
 * @return {void}
 */

/**
 * Receive user-facing sample-window guidance.
 *
 * @callback RasterSampleGuidanceHandler
 * @param {string} guidance Guidance text, or an empty string when valid.
 * @return {void}
 */

/** Own passive preview and validated one-shot raster sample-window selection. */
export class RasterSampleWindowController {
    /**
     * Create a raster sample-window interaction controller.
     *
     * @param {Object} leafletMap Leaflet-compatible evented map.
     * @param {RasterSampleLayerFactory} layerFactory Creates geodesic or rectangular outlines.
     * @param {RasterSampleSelectionHandler} onSelect Receives committed bounds.
     * @param {RasterSampleGuidanceHandler} onGuidance Receives guidance text.
     */
    constructor(leafletMap, layerFactory, onSelect, onGuidance) {
        this.leafletMap = leafletMap;
        this.layerFactory = layerFactory;
        this.onSelect = onSelect;
        this.onGuidance = onGuidance;
        this.windowSizeKm = DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM;
        this.previewLayer = null;
        this.previewBox = null;
        this.selectionLayer = null;
        this.selectionBounds = null;
        this.selectionBox = null;
        this.activityArea = null;
    }

    /**
     * Change the ground-distance side length used by later selections.
     *
     * @param {number} sideLengthKm Integer side length within the geometry limit.
     * @return {void}
     * @throws {RangeError} If the side length violates the window contract.
     */
    setWindowSize(sideLengthKm) {
        this.windowSizeKm = validateRasterSampleWindowSize(sideLengthKm);
    }

    /**
     * Commit a selection at one composition-owned map position.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {Object|null} Canonical bounds, or null near a pole/date line.
     * @throws {RangeError} If the position or configured size is invalid.
     */
    selectAt(position) {
        return this.#selectAt(position);
    }

    /**
     * Resize an existing sampling box without notifying calculation consumers.
     *
     * @param {{lng:number,lat:number}} position Retained selection center.
     * @return {Object|null} Displayed canonical bounds, or null without a
     * selection or when the resized box crosses a pole or date line.
     */
    resizeSelectionAt(position) {
        if (this.selectionLayer === null) return null;
        const sampleWindow = this.#boundsAt(position);
        if (sampleWindow === null) return null;
        this.clearPreview();
        this.restoreSelection(sampleWindow.bounds, sampleWindow.samplingBox);
        return sampleWindow.bounds;
    }

    /**
     * Preview the current window at one viewer-owned pointer position.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {boolean} Whether a valid preview is visible.
     * @throws {RangeError} If the position or configured size is invalid.
     */
    previewAt(position) {
        const sampleWindow = this.#boundsAt(position);
        if (sampleWindow === null) {
            return false;
        }
        if (this.previewLayer === null) {
            this.previewLayer = this.layerFactory(
                sampleWindow.leafletBounds,
                "preview", sampleWindow.samplingBox
            ).addTo(this.leafletMap);
        } else {
            this.previewLayer.setSampleWindow(sampleWindow.leafletBounds, sampleWindow.samplingBox);
        }
        this.previewBox = sampleWindow.samplingBox;
        return true;
    }

    /** Remove the passive pointer preview if present. @return {void} */
    clearPreview() {
        if (this.previewLayer !== null) {
            this.leafletMap.removeLayer(this.previewLayer);
            this.previewLayer = null;
            this.previewBox = null;
        }
    }

    /**
     * Remove only the committed area, retaining the hover interaction.
     *
     * @return {void}
     */
    clearSelection() {
        if (this.selectionLayer !== null) {
            this.leafletMap.removeLayer(this.selectionLayer);
            this.selectionLayer = null;
        }
        this.selectionBounds = null;
        this.selectionBox = null;
    }

    /**
     * Restore a retained selection without issuing another statistics request.
     *
     * @param {Object} bounds Canonical read-window envelope.
     * @param {import("../sampling-box.js").SamplingBox|null} [samplingBox=null] Captured geodesic box; null preserves a rectangular input.
     * @return {void}
     */
    restoreSelection(bounds, samplingBox = null) {
        const leafletBounds = rasterSampleBoundsToLeaflet(bounds);
        if (this.selectionLayer === null) {
            this.selectionLayer = this.layerFactory(leafletBounds, "selection", samplingBox).addTo(this.leafletMap);
        } else {
            this.selectionLayer.setSampleWindow(leafletBounds, samplingBox);
        }
        this.selectionBounds = bounds;
        this.selectionBox = samplingBox;
        this.renderActivity();
    }

    /** Mark activity only on the matching captured area. @param {Object|null} area Active request descriptor. @return {void} */
    setActivityArea(area) {
        this.activityArea = area;
        this.renderActivity();
    }

    /** Synchronize passive SVG feedback without altering sampling. @return {void} */
    renderActivity() {
        const matches = this.activityArea?.kind === "samplingBox"
            ? samplingBoxesEqual(this.activityArea.samplingBox, this.selectionBox)
            : this.activityArea?.kind === "selectedArea" && !this.selectionBox && this.selectionBounds &&
                ["west", "south", "east", "north"].every(key =>
                    this.activityArea.selectedBounds[key] === this.selectionBounds[key]);
        this.selectionLayer?.getElement?.()?.classList.toggle("is-calculating", !!matches);
    }

    /** Redraw retained geometry for a changed map zoom without notifying consumers.
     * @return {void}
     */
    refreshGeometry() {
        if (this.selectionLayer) {
            this.selectionLayer.setSampleWindow(rasterSampleBoundsToLeaflet(this.selectionBounds), this.selectionBox);
        }
        if (this.previewLayer && this.previewBox) {
            this.previewLayer.setSampleWindow(rasterSampleBoundsToLeaflet(samplingBoxBounds(this.previewBox)), this.previewBox);
        }
    }

    /**
     * Remove all layers, handlers, and pointer state for the active Item.
     *
     * @return {void}
     */
    clear() {
        this.clearPreview();
        this.clearSelection();
        this.onGuidance("");
    }

    /** Return the captured area without storing display vertices. @return {Object|null} Immutable box or rectangle descriptor. */
    get selectedArea() {
        return this.selectionBox ? Object.freeze({kind: "samplingBox", samplingBox: this.selectionBox})
            : this.selectionBounds ? Object.freeze({kind: "selectedArea", selectedBounds: this.selectionBounds}) : null;
    }

    /**
     * Build a captured geodesic box and its single-world read-window envelope.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {{bounds:Object,samplingBox:import("../sampling-box.js").SamplingBox,leafletBounds:number[][]}|null} Sampling window, or
     * null outside the map or when the window crosses a pole or date line.
     * @throws {RangeError} If the configured size is invalid.
     */
    #boundsAt(position) {
        const center = {
            longitude: position.lng,
            latitude: position.lat
        };
        if (!isCanonicalWgs84Position(center)) {
            this.clearPreview();
            this.onGuidance(RASTER_SAMPLE_WINDOW_MAP_BOUNDS_GUIDANCE);
            return null;
        }
        try {
            const {samplingBox} = buildRasterSampleWindowArea(center, this.windowSizeKm);
            const bounds = samplingBoxBounds(samplingBox);
            this.onGuidance("");
            return {
                bounds, samplingBox,
                leafletBounds: rasterSampleBoundsToLeaflet(bounds),
            };
        } catch (error) {
            if (!(error instanceof SamplingBoxBoundaryError)) {
                throw error;
            }
            this.clearPreview();
            this.onGuidance(RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE);
            return null;
        }
    }

    /**
     * Commit and report one sample window at a map position.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {Object|null} Canonical bounds, or null near a pole/date line.
     * @throws {RangeError} If the position or configured size is invalid.
     */
    #selectAt(position) {
        const sampleWindow = this.#boundsAt(position);
        if (sampleWindow === null) {
            return null;
        }
        this.restoreSelection(sampleWindow.bounds, sampleWindow.samplingBox);
        this.onSelect(sampleWindow.bounds, Object.freeze({
            longitude: position.lng,
            latitude: position.lat,
        }));
        return sampleWindow.bounds;
    }

}
