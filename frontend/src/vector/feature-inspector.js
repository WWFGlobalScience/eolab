/** One-shot feature inspection for visible published vector layers. */

import {
    fetchVectorFeatureInfo,
    VectorFeatureInfoError,
} from "./feature-info.js";

const HIGHLIGHT_STYLE = Object.freeze({
    color: "#111827",
    weight: 3,
    opacity: 1,
    fillColor: "#facc15",
    fillOpacity: 0.35,
});
const TIME_SERIES_AVAILABLE_HELP =
    "Plot one numeric field across all features found at this location.";
const TIME_SERIES_UNAVAILABLE_HELP =
    "Select at least two features at this location to plot one field across them.";
const MAX_ATTRIBUTE_VALUE_CHARACTERS = 1000;
const MAX_FEATURE_FOCUS_COORDINATE_ARRAYS = 20_000;

/**
 * Format elapsed inspection time without implying unavailable precision.
 *
 * @param {number} elapsedMilliseconds Monotonic elapsed milliseconds.
 * @return {string} Concise duration for progressive and final status text.
 */
function formatInspectionDuration(elapsedMilliseconds) {
    const boundedMilliseconds = Math.max(0, elapsedMilliseconds);
    if (boundedMilliseconds < 100) return "under 0.1 s";
    return `${(boundedMilliseconds / 1000).toFixed(1)} s`;
}

/**
 * Derive finite WGS 84 bounds from geometry already present in a bounded
 * feature-info response.
 *
 * The traversal is capped and does not cause another geometry request. Empty,
 * malformed, out-of-world, or antimeridian-spanning geometry returns no bounds
 * so callers can use the inspected map position instead.
 *
 * @param {Object|null} geometry Optional GeoJSON geometry.
 * @return {number[]|null} West, south, east, north bounds, or null.
 */
function vectorFeatureGeometryBounds(geometry) {
    if (geometry === null || typeof geometry !== "object") return null;
    const geometryStack = [geometry];
    const coordinateStack = [];
    let visitedCoordinateArrays = 0;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    let foundCoordinate = false;
    let visitedGeometries = 0;
    while (geometryStack.length > 0) {
        const current = geometryStack.pop();
        visitedGeometries += 1;
        if (visitedGeometries > MAX_FEATURE_FOCUS_COORDINATE_ARRAYS) {
            return null;
        }
        if (
            current?.type === "GeometryCollection" &&
            Array.isArray(current.geometries)
        ) {
            if (
                visitedGeometries + geometryStack.length +
                current.geometries.length >
                MAX_FEATURE_FOCUS_COORDINATE_ARRAYS
            ) {
                return null;
            }
            for (const nestedGeometry of current.geometries) {
                geometryStack.push(nestedGeometry);
            }
        } else if (Array.isArray(current?.coordinates)) {
            coordinateStack.push(current.coordinates);
        }
    }
    while (coordinateStack.length > 0) {
        const coordinates = coordinateStack.pop();
        visitedCoordinateArrays += 1;
        if (visitedCoordinateArrays > MAX_FEATURE_FOCUS_COORDINATE_ARRAYS) {
            return null;
        }
        if (
            coordinates.length >= 2 &&
            Number.isFinite(coordinates[0]) &&
            Number.isFinite(coordinates[1])
        ) {
            const [longitude, latitude] = coordinates;
            if (
                longitude < -180 || longitude > 180 ||
                latitude < -90 || latitude > 90
            ) {
                return null;
            }
            west = Math.min(west, longitude);
            south = Math.min(south, latitude);
            east = Math.max(east, longitude);
            north = Math.max(north, latitude);
            foundCoordinate = true;
            continue;
        }
        if (!coordinates.every(Array.isArray)) return null;
        if (
            visitedCoordinateArrays + coordinateStack.length +
            coordinates.length > MAX_FEATURE_FOCUS_COORDINATE_ARRAYS
        ) {
            return null;
        }
        for (const nestedCoordinates of coordinates) {
            coordinateStack.push(nestedCoordinates);
        }
    }
    if (!foundCoordinate || east - west > 180) return null;
    return [west, south, east, north];
}

/**
 * Build an immutable geometry-neutral map target for one inspected feature.
 *
 * @param {Object} configuration Focus inputs.
 * @param {Object} configuration.feature Bounded GeoJSON feature result.
 * @param {{lng:number,lat:number}} configuration.inspectionPosition Accepted
 * WGS 84 map-click position.
 * @return {Readonly<Object>} Center and optional already-returned feature bounds.
 * @throws {TypeError} If the inspection position is outside WGS 84.
 */
function vectorFeatureFocus({ feature, inspectionPosition }) {
    const longitude = inspectionPosition?.lng;
    const latitude = inspectionPosition?.lat;
    if (
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
        !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    ) {
        throw new TypeError("Invalid vector feature inspection position.");
    }
    const bounds = vectorFeatureGeometryBounds(feature?.geometry ?? null);
    const center = bounds !== null &&
        bounds[0] === bounds[2] && bounds[1] === bounds[3]
        ? [bounds[0], bounds[1]]
        : [longitude, latitude];
    return Object.freeze({
        center: Object.freeze(center),
        bounds: bounds === null ? null : Object.freeze(bounds),
    });
}

/**
 * @typedef {Object} VectorFeatureInspectionTarget
 * @property {string} sourceId Opaque retained-source identity from composition.
 * @property {string} label User-facing retained-layer label.
 * @property {number[]} bbox Authoritative Catalog Item west, south, east, north
 * bounds.
 * @property {{layerName:string,styleName:string}} publication Authorized WMS
 * publication identity.
 * @property {"point"|"line"|"polygon"} geometryKind Geometry style family.
 * @property {string[]} propertyNames Catalog-declared non-geometry fields.
 * @property {string|null} primaryGeometry Catalog-declared geometry field.
 */

/**
 * Return an immutable scalar-only observation for sibling analysis tools.
 *
 * Geometry and nested values stay owned by the feature inspector. The analysis
 * boundary contains only chart fields and the small geometry-neutral map focus
 * needed to navigate back to an inspected row.
 *
 * @param {{feature:Object,target:VectorFeatureInspectionTarget,
 * inspectionPosition:{lng:number,lat:number}}} result Result.
 * @return {Readonly<Object>} Closed inspection-observation contract.
 */
export function vectorInspectionObservation({ feature, target, inspectionPosition }) {
    const properties = {};
    for (const [name, value] of Object.entries(feature.properties)) {
        if (
            value === null ||
            typeof value === "string" ||
            typeof value === "boolean" ||
            typeof value === "number"
        ) {
            properties[name] = value;
        }
    }
    return Object.freeze({
        sourceId: target.sourceId,
        layerLabel: target.label,
        featureId: typeof feature.id === "string" || typeof feature.id === "number"
            ? feature.id
            : null,
        focus: vectorFeatureFocus({ feature, inspectionPosition }),
        properties: Object.freeze(properties),
    });
}

/**
 * Return whether one WGS 84 position is inside an authoritative Item extent.
 *
 * Inclusive edges preserve inspection of features whose coordinates coincide
 * with a Catalog bounding-box boundary. Crossing extents contain either
 * longitude interval adjacent to the date line.
 *
 * @param {number[]} bbox West, south, east, north Catalog Item bounds.
 * @param {{lng:number,lat:number}} position Leaflet WGS 84 click position.
 * @return {boolean} Whether the target can contain the clicked feature.
 */
function vectorBoundsContainPosition(bbox, position) {
    const [west, south, east, north] = bbox;
    const longitudeInside = west <= east
        ? position.lng >= west && position.lng <= east
        : position.lng >= west || position.lng <= east;
    return longitudeInside && position.lat >= south && position.lat <= north;
}

/**
 * Format an arbitrary GeoJSON property as bounded display text.
 *
 * @param {*} value GeoJSON property value.
 * @return {string} Safe text capped at the presentation limit.
 */
export function formatVectorFeatureAttribute(value) {
    let text;
    if (value === null || value === undefined) {
        return "No value";
    }
    if (typeof value === "boolean") {
        return value ? "True" : "False";
    }
    if (typeof value === "object") {
        try {
            text = JSON.stringify(value);
        } catch {
            text = String(value);
        }
    } else {
        text = String(value);
    }
    return text.length <= MAX_ATTRIBUTE_VALUE_CHARACTERS
        ? text
        : `${text.slice(0, MAX_ATTRIBUTE_VALUE_CHARACTERS - 1)}…`;
}

/**
 * Return user-facing properties while excluding geometry metadata.
 *
 * @param {Object} feature Validated GeoJSON Feature.
 * @param {string|null} primaryGeometry Catalog-declared geometry field.
 * @return {{name:string,value:string}[]} Bounded display attributes.
 */
export function vectorFeatureAttributes(feature, primaryGeometry = null) {
    const geometryNames = new Set(
        [primaryGeometry, "geometry", "the_geom", "boundedBy", "bbox"]
            .filter((name) => typeof name === "string")
    );
    const attributes = Object.entries(feature.properties)
        .filter(([name]) => !geometryNames.has(name))
        .map(([name, value]) => ({
            name,
            value: formatVectorFeatureAttribute(value),
        }));
    if (typeof feature.id === "string" || typeof feature.id === "number") {
        attributes.unshift({
            name: "Feature ID",
            value: formatVectorFeatureAttribute(feature.id),
        });
    }
    return attributes;
}

/** Own vector-inspection requests, results, and map highlight. */
export class VectorFeatureInspectorController {
    /**
     * @param {Object} configuration Collaborators.
     * @param {Object} configuration.leaflet Leaflet namespace.
     * @param {Object} configuration.leafletMap Initialized Leaflet map.
     * @param {() => VectorFeatureInspectionTarget[]}
     * configuration.getVisibleTargets Current visible vectors from composition.
     * @param {string} configuration.wmsUrl Restricted browser WMS URL.
     * @param {(visible:boolean) => void} configuration.onInspectionChange
     * Requests presentation changes without knowing the presentation owner.
     * @param {(sample:Readonly<Object>)=>void} configuration.onSampleChange
     * Publishes immutable bounded observations through application composition.
     * @param {(observation:Readonly<Object>|null,navigation:Readonly<Object>|null)=>void}
     * configuration.onCurrentObservationChange Publishes the current paged
     * result and its immutable position within the inspector-owned result set.
     * @param {()=>void} configuration.onFeatureProfileRequested Publishes
     * single-feature plotting intent without knowing its implementation.
     * @param {()=>void} configuration.onTimeSeriesRequested Publishes analysis
     * intent for all selected features without knowing its implementation.
     * @param {(sourceId:string)=>void} configuration.onStyleRequested Publishes
     * styling intent with the selected feature's opaque source identity.
     * @param {(focus:Readonly<Object>)=>boolean}
     * configuration.onFeatureZoomRequested Publishes current-feature map
     * navigation intent without owning viewport movement.
     * @param {Document} [configuration.documentContext=document] DOM owner.
     * @param {typeof fetch} [configuration.fetchImplementation=globalThis.fetch]
     * HTTP implementation.
     * @param {()=>number} [configuration.now] Monotonic clock used only for
     * user-facing request progress.
     */
    constructor({
        leaflet,
        leafletMap,
        getVisibleTargets,
        wmsUrl,
        onInspectionChange,
        onSampleChange,
        onCurrentObservationChange,
        onFeatureProfileRequested,
        onTimeSeriesRequested,
        onStyleRequested,
        onFilterRequested = () => {},
        onFeatureZoomRequested,
        documentContext = document,
        fetchImplementation = globalThis.fetch,
        now = () => globalThis.performance.now(),
    }) {
        if (typeof getVisibleTargets !== "function") {
            throw new TypeError("getVisibleTargets must be a function.");
        }
        if (typeof onInspectionChange !== "function") {
            throw new TypeError("onInspectionChange must be a function.");
        }
        if (typeof onSampleChange !== "function") {
            throw new TypeError("onSampleChange must be a function.");
        }
        if (typeof onCurrentObservationChange !== "function") {
            throw new TypeError("onCurrentObservationChange must be a function.");
        }
        if (typeof onFeatureProfileRequested !== "function") {
            throw new TypeError("onFeatureProfileRequested must be a function.");
        }
        if (typeof onTimeSeriesRequested !== "function") {
            throw new TypeError("onTimeSeriesRequested must be a function.");
        }
        if (typeof onStyleRequested !== "function") {
            throw new TypeError("onStyleRequested must be a function.");
        }
        if (typeof onFeatureZoomRequested !== "function") {
            throw new TypeError("onFeatureZoomRequested must be a function.");
        }
        if (typeof now !== "function") {
            throw new TypeError("now must be a function.");
        }
        this.leaflet = leaflet;
        this.map = leafletMap;
        this.getVisibleTargets = getVisibleTargets;
        this.wmsUrl = wmsUrl;
        this.onInspectionChange = onInspectionChange;
        this.onSampleChange = onSampleChange;
        this.onCurrentObservationChange = onCurrentObservationChange;
        this.onFeatureProfileRequested = onFeatureProfileRequested;
        this.onTimeSeriesRequested = onTimeSeriesRequested;
        this.onStyleRequested = onStyleRequested;
        this.onFilterRequested = onFilterRequested;
        this.filterButton = documentContext.querySelector("#filter-inspected-vector-layer");
        this.onFeatureZoomRequested = onFeatureZoomRequested;
        this.document = documentContext;
        this.fetchImplementation = fetchImplementation;
        this.now = now;
        this.panel = documentContext.querySelector("#vector-feature-inspector");
        this.closeButton = documentContext.querySelector("#close-vector-inspector");
        this.timeSeriesButton = documentContext.querySelector(
            "#open-vector-time-series"
        );
        this.timeSeriesHelp = documentContext.querySelector(
            "#vector-time-series-action-help"
        );
        this.featureProfileButton = documentContext.querySelector(
            "#open-vector-feature-profile"
        );
        this.styleButton = documentContext.querySelector(
            "#style-inspected-vector-layer"
        );
        this.zoomFeatureButton = documentContext.querySelector(
            "#zoom-inspected-vector-feature"
        );
        this.status = documentContext.querySelector("#vector-feature-status");
        this.result = documentContext.querySelector("#vector-feature-result");
        this.layerName = documentContext.querySelector("#vector-feature-layer");
        this.position = documentContext.querySelector("#vector-feature-position");
        this.attributes = documentContext.querySelector("#vector-feature-attributes");
        this.previous = documentContext.querySelector("#previous-vector-feature");
        this.next = documentContext.querySelector("#next-vector-feature");
        this.results = [];
        this.resultIndex = 0;
        this.highlightLayer = null;
        this.abortController = null;
        this.requestGeneration = 0;
        this.sampleTargetSignature = null;
        this.mapContainer = this.map.getContainer();
        this.onClose = () => this.close({ moveFocus: true });
        this.onOpenFeatureProfile = () => {
            if (!this.featureProfileButton.disabled) {
                this.onFeatureProfileRequested();
            }
        };
        this.onOpenTimeSeries = () => {
            if (!this.timeSeriesButton.disabled) this.onTimeSeriesRequested();
        };
        this.onOpenFilter = () => {
            const selected = this.results[this.resultIndex];
            if (selected !== undefined) this.onFilterRequested(selected.target.sourceId);
        };
        this.filterButton?.addEventListener("click", this.onOpenFilter);
        this.onOpenStyle = () => {
            const selected = this.results[this.resultIndex];
            if (selected !== undefined && !this.styleButton.disabled) {
                this.onStyleRequested(selected.target.sourceId);
            }
        };
        this.onZoomFeature = () => {
            const selected = this.results[this.resultIndex];
            if (selected === undefined || this.zoomFeatureButton.disabled) return;
            const observation = vectorInspectionObservation(selected);
            if (!this.onFeatureZoomRequested(observation.focus)) {
                this.zoomFeatureButton.disabled = true;
            }
        };
        this.onPrevious = () => this.navigateResult("previous");
        this.onNext = () => this.navigateResult("next");
        this.onKeydown = (event) => {
            if (event.key !== "Escape" || this.panel.hidden || !(
                this.panel.contains(this.document.activeElement) ||
                this.document.activeElement === this.mapContainer
            )) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            this.close({ moveFocus: true });
        };
        this.closeButton.addEventListener("click", this.onClose);
        this.featureProfileButton.addEventListener(
            "click",
            this.onOpenFeatureProfile
        );
        this.timeSeriesButton.addEventListener("click", this.onOpenTimeSeries);
        this.styleButton.addEventListener("click", this.onOpenStyle);
        this.zoomFeatureButton.addEventListener("click", this.onZoomFeature);
        this.previous.addEventListener("click", this.onPrevious);
        this.next.addEventListener("click", this.onNext);
        this.document.addEventListener("keydown", this.onKeydown);
        if (this.filterButton) this.filterButton.hidden = true;
        this.styleButton.hidden = true;
        this.styleButton.disabled = true;
        this.zoomFeatureButton.disabled = true;
        this.#updateTimeSeriesAction(0);
        this.syncVisibleLayers();
    }

    /**
     * Return validated visible vector targets in top-first map order.
     *
     * @return {VectorFeatureInspectionTarget[]} Current inspection targets.
     * @throws {TypeError} If composition violates the target contract.
     */
    visibleTargets() {
        const targets = this.getVisibleTargets();
        if (!Array.isArray(targets)) {
            throw new TypeError("getVisibleTargets must return an array.");
        }
        for (const target of targets) {
            if (
                typeof target?.sourceId !== "string" ||
                target.sourceId.length === 0 ||
                typeof target?.label !== "string" ||
                target.label.length === 0 ||
                !Array.isArray(target?.bbox) ||
                target.bbox.length !== 4 ||
                !target.bbox.every(Number.isFinite) ||
                Math.abs(target.bbox[0]) > 180 ||
                Math.abs(target.bbox[2]) > 180 ||
                target.bbox[1] < -90 ||
                target.bbox[3] > 90 ||
                target.bbox[1] > target.bbox[3] ||
                typeof target?.publication?.layerName !== "string" ||
                typeof target?.publication?.styleName !== "string" ||
                !["point", "line", "polygon"].includes(target?.geometryKind) ||
                !Array.isArray(target?.propertyNames) ||
                !target.propertyNames.every((name) =>
                    typeof name === "string" && name.length > 0
                ) ||
                !(
                    target?.primaryGeometry === null ||
                    typeof target?.primaryGeometry === "string"
                )
            ) {
                throw new TypeError("Invalid vector feature inspection target.");
            }
        }
        return targets;
    }

    /**
     * Close orphaned results after the last visible vector leaves the map.
     *
     * @return {void}
     */
    syncVisibleLayers() {
        const targets = this.visibleTargets();
        const available = targets.length > 0;
        const signature = this.#targetSignature(targets);
        if (
            this.sampleTargetSignature !== null &&
            signature !== this.sampleTargetSignature
        ) {
            this.requestGeneration += 1;
            this.abortController?.abort();
            this.abortController = null;
            this.clearResults();
            this.sampleTargetSignature = null;
            this.status.textContent = available
                ? "Visible vector layers changed. Click the map to sample again."
                : "Show a vector layer, then click the map to inspect features.";
            this.#publishSample(
                "invalidated",
                [],
                "Visible vector layers changed. Click the map to sample again."
            );
        }
        if (!available && (
            !this.panel.hidden || this.abortController !== null ||
            this.results.length > 0
        )) {
            this.close();
        }
    }

    /**
     * Project the Leaflet map click into the neutral WMS viewport contract.
     *
     * @param {{x:number,y:number}} containerPoint Click position in map pixels.
     * @return {{bbox:number[],width:number,height:number,x:number,y:number}}
     * Current WGS 84 viewport and click position.
     */
    mapViewport(containerPoint) {
        const size = this.map.getSize();
        const bounds = this.map.getBounds();
        const southwest = bounds.getSouthWest();
        const northeast = bounds.getNorthEast();
        return {
            bbox: [
                southwest.lng,
                southwest.lat,
                northeast.lng,
                northeast.lat,
            ],
            width: size.x,
            height: size.y,
            x: containerPoint.x,
            y: containerPoint.y,
        };
    }

    /**
     * Hide inspection, cancel work, clear results, and optionally focus the map.
     *
     * @param {Object} [options] Close options.
     * @param {boolean} [options.moveFocus=false] Restore focus to the map.
     * @return {void}
     */
    close({ moveFocus = false } = {}) {
        this.requestGeneration += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.clearResults();
        this.status.textContent = "Click the map to inspect visible vector features.";
        this.onInspectionChange(false);
        if (moveFocus) this.mapContainer.focus();
    }

    /**
     * Inspect every currently visible vector target at one map click.
     *
     * @param {Object} event Leaflet map-click event.
     * @return {Promise<boolean>} Whether visible vector targets were inspected.
     */
    async inspect(event) {
        const visibleTargets = this.visibleTargets();
        if (visibleTargets.length === 0) {
            return false;
        }
        this.abortController?.abort();
        this.abortController = null;
        const generation = ++this.requestGeneration;
        this.sampleTargetSignature = this.#targetSignature(visibleTargets);
        this.clearResults();
        const targets = visibleTargets.filter((target) =>
            vectorBoundsContainPosition(target.bbox, event.latlng)
        );
        if (targets.length === 0) {
            const message = "No vector feature was found at that location.";
            this.status.textContent =
                "Click the map to inspect visible vector features.";
            if (!this.panel.hidden) this.onInspectionChange(false);
            this.#publishSample("empty", [], message);
            return true;
        }
        const abortController = new AbortController();
        this.abortController = abortController;
        const startedAt = this.now();
        const targetResults = targets.map(() => ({
            complete: false,
            results: [],
            failure: null,
        }));
        const initialMessage = `Inspecting ${targets.length} visible vector ` +
            `layer${targets.length === 1 ? "" : "s"}…`;
        this.status.textContent = initialMessage;
        // Composition reveals availability; the inspection workspace owns focus.
        this.onInspectionChange(true);
        this.#publishSample(
            "loading",
            [],
            initialMessage
        );
        const containerPoint = event.containerPoint ??
            this.map.latLngToContainerPoint(event.latlng);
        const viewport = this.mapViewport(containerPoint);
        await Promise.all(targets.map(async (target, targetIndex) => {
            let results = [];
            let failure = null;
            try {
                const features = await fetchVectorFeatureInfo({
                    wmsUrl: this.wmsUrl,
                    publication: target.publication,
                    propertyNames: target.propertyNames,
                    viewport,
                    signal: abortController.signal,
                }, this.fetchImplementation);
                results = features.map((feature) => ({
                    feature,
                    target,
                    inspectionPosition: Object.freeze({
                        lng: event.latlng.lng,
                        lat: event.latlng.lat,
                    }),
                }));
            } catch (error) {
                failure = error;
            }
            if (generation !== this.requestGeneration) return;
            targetResults[targetIndex] = {
                complete: true,
                results,
                failure,
            };
            this.#presentProgress({ targetResults, startedAt });
        }));
        if (generation !== this.requestGeneration) {
            return false;
        }
        this.abortController = null;
        return true;
    }

    /**
     * Merge one or more completed target slots and update progressive UI state.
     *
     * Slots retain visible-layer order even when network responses complete out
     * of order. If a late result belongs before the selected feature, selection
     * follows the same result object instead of unexpectedly changing feature.
     *
     * @param {Object} progress Current inspection progress.
     * @param {Object[]} progress.targetResults Ordered per-target result slots.
     * @param {number} progress.startedAt Monotonic inspection start time.
     * @return {void}
     */
    #presentProgress({ targetResults, startedAt }) {
        const previouslySelected = this.results[this.resultIndex] ?? null;
        this.results = targetResults.flatMap((targetResult) =>
            targetResult.results
        );
        if (this.results.length > 0) {
            const retainedIndex = previouslySelected === null
                ? 0
                : this.results.indexOf(previouslySelected);
            this.showResult(retainedIndex < 0 ? 0 : retainedIndex);
        }
        this.#updateTimeSeriesAction(this.results.length);

        const completedCount = targetResults.filter(
            (targetResult) => targetResult.complete
        ).length;
        const pendingCount = targetResults.length - completedCount;
        const failureResults = targetResults.filter((targetResult) =>
            targetResult.complete &&
            targetResult.failure !== null &&
            targetResult.failure?.name !== "AbortError"
        );
        const duration = formatInspectionDuration(this.now() - startedAt);
        if (pendingCount > 0) {
            const featureSummary = this.results.length === 0
                ? ""
                : `${this.results.length} feature` +
                  `${this.results.length === 1 ? "" : "s"} found; `;
            this.status.textContent = featureSummary +
                `${completedCount} of ${targetResults.length} vector layers ` +
                `inspected in ${duration}; waiting for ${pendingCount} more…`;
            this.#publishSample("loading", this.results, this.status.textContent, failureResults.length);
            return;
        }
        if (this.results.length > 0) {
            const failureSummary = failureResults.length === 0
                ? ""
                : `; ${failureResults.length} of ${targetResults.length} vector ` +
                  `layers could not be inspected`;
            this.status.textContent = `${this.results.length} feature` +
                `${this.results.length === 1 ? "" : "s"} found in ${duration}` +
                `${failureSummary}.`;
            this.#publishSample("ready", this.results, this.status.textContent, failureResults.length);
            return;
        }
        const failure = failureResults[0]?.failure;
        const message = failure instanceof VectorFeatureInfoError
            ? failure.message
            : failure ? "Vector inspection failed. Click the map to retry."
                : "No vector feature was found at that location.";
        if (failure) {
            this.status.textContent = `${message} Inspection finished in ${duration}.`;
        } else {
            this.status.textContent =
                "Click the map to inspect visible vector features.";
            if (!this.panel.hidden) this.onInspectionChange(false);
        }
        this.#publishSample("empty", [], message, failureResults.length);
    }

    /**
     * Return a stable set identity independent of drawing order and styling.
     *
     * @param {VectorFeatureInspectionTarget[]} targets Visible vector targets.
     * @return {string} Stable visible-publication signature.
     */
    #targetSignature(targets) {
        return targets.map((target) => target.publication.layerName)
            .sort()
            .join("\u0000");
    }

    /**
     * Publish one frozen inspection sample through application composition.
     *
     * @param {"loading"|"ready"|"empty"|"invalidated"} state Sample state.
     * @param {Object[]} results Inspector-owned feature results.
     * @param {string} message Browser-safe sample status.
     * @param {number} [failedLayers=0] Completed layers whose inspection failed.
     * @return {void}
     */
    #publishSample(state, results, message, failedLayers = 0) {
        const observations = Object.freeze(
            results.map(vectorInspectionObservation)
        );
        this.onSampleChange(Object.freeze({ state, observations, message, failedLayers }));
    }

    /**
     * Keep selected-feature action eligibility and its explanation together.
     *
     * @param {number} featureCount Number of results at the inspected location.
     * @return {void}
     */
    #updateTimeSeriesAction(featureCount) {
        const available = featureCount >= 2;
        this.timeSeriesButton.disabled = !available;
        this.timeSeriesHelp.textContent = available
            ? TIME_SERIES_AVAILABLE_HELP
            : TIME_SERIES_UNAVAILABLE_HELP;
    }

    /**
     * Move to an adjacent result while retaining ownership of selection state.
     *
     * @param {"previous"|"next"} direction Adjacent result to select.
     * @return {void}
     */
    navigateResult(direction) {
        if (direction !== "previous" && direction !== "next") {
            throw new TypeError("Feature navigation direction must be previous or next.");
        }
        if (this.results.length === 0) return;
        const offset = direction === "previous" ? -1 : 1;
        const nextIndex = this.resultIndex + offset;
        if (nextIndex < 0 || nextIndex >= this.results.length) return;
        this.showResult(nextIndex);
    }

    /**
     * Present one result and replace its map highlight.
     *
     * @param {number} index Zero-based result index.
     * @return {void}
     */
    showResult(index) {
        if (this.results.length === 0) {
            return;
        }
        this.resultIndex = Math.min(this.results.length - 1, Math.max(0, index));
        const { feature, target } = this.results[this.resultIndex];
        const observation = vectorInspectionObservation(
            this.results[this.resultIndex]
        );
        const navigation = Object.freeze({
            position: this.resultIndex + 1,
            total: this.results.length,
            canPrevious: this.resultIndex > 0,
            canNext: this.resultIndex < this.results.length - 1,
        });
        this.result.hidden = false;
        this.layerName.textContent = target.label;
        if (this.filterButton) this.filterButton.hidden = false;
        this.styleButton.hidden = false;
        this.styleButton.disabled = false;
        this.zoomFeatureButton.disabled = false;
        this.styleButton.setAttribute("aria-label", `Style ${target.label}`);
        this.position.textContent = `${navigation.position} of ${navigation.total}`;
        this.previous.disabled = !navigation.canPrevious;
        this.next.disabled = !navigation.canNext;
        this.featureProfileButton.disabled = Object.values(
            observation.properties
        ).filter((value) =>
            typeof value === "number" && Number.isFinite(value)
        ).length < 2;
        this.onCurrentObservationChange(observation, navigation);
        this.attributes.replaceChildren();
        const entries = vectorFeatureAttributes(feature, target.primaryGeometry);
        if (entries.length === 0) {
            const term = this.document.createElement("dt");
            term.textContent = "Attributes";
            const description = this.document.createElement("dd");
            description.textContent = "No user-facing attributes were returned.";
            this.attributes.append(term, description);
        } else {
            for (const entry of entries) {
                const term = this.document.createElement("dt");
                term.textContent = entry.name;
                const description = this.document.createElement("dd");
                description.textContent = entry.value;
                this.attributes.append(term, description);
            }
        }
        this.clearHighlight();
        if (typeof feature.id === "string" && feature.id.length > 0) {
            const highlightLayer = this.leaflet.tileLayer.wms(this.wmsUrl, {
                layers: target.publication.layerName,
                styles: `vector-highlight-${target.geometryKind}`,
                format: "image/png",
                transparent: true,
                version: "1.1.1",
                featureid: feature.id,
            });
            this.highlightLayer = highlightLayer.addTo(this.map);
        } else if (feature.geometry !== null) {
            this.highlightLayer = this.leaflet.geoJSON(feature, {
                style: HIGHLIGHT_STYLE,
                pointToLayer: (_pointFeature, latlng) =>
                    this.leaflet.circleMarker(latlng, HIGHLIGHT_STYLE),
            }).addTo(this.map);
        }
    }

    /**
     * Clear result DOM and map highlight.
     *
     * @return {void}
     */
    clearResults() {
        this.results = [];
        this.resultIndex = 0;
        this.result.hidden = true;
        this.#updateTimeSeriesAction(0);
        this.featureProfileButton.disabled = true;
        if (this.filterButton) this.filterButton.hidden = true;
        this.styleButton.hidden = true;
        this.styleButton.disabled = true;
        this.zoomFeatureButton.disabled = true;
        this.styleButton.setAttribute(
            "aria-label", "Style selected vector layer"
        );
        this.onCurrentObservationChange(null, null);
        this.attributes.replaceChildren();
        this.clearHighlight();
    }

    /**
     * Remove the selected feature overlay if one exists.
     *
     * @return {void}
     */
    clearHighlight() {
        if (this.highlightLayer !== null) {
            this.map.removeLayer(this.highlightLayer);
            this.highlightLayer = null;
        }
    }

    /**
     * Permanently release listeners and transient state.
     *
     * @return {void}
     */
    destroy() {
        this.close();
        this.closeButton.removeEventListener("click", this.onClose);
        this.featureProfileButton.removeEventListener(
            "click",
            this.onOpenFeatureProfile
        );
        this.timeSeriesButton.removeEventListener("click", this.onOpenTimeSeries);
        this.styleButton.removeEventListener("click", this.onOpenStyle);
        this.filterButton?.removeEventListener("click", this.onOpenFilter);
        this.zoomFeatureButton.removeEventListener("click", this.onZoomFeature);
        this.previous.removeEventListener("click", this.onPrevious);
        this.next.removeEventListener("click", this.onNext);
        this.document.removeEventListener("keydown", this.onKeydown);
    }
}
