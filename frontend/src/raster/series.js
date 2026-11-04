/** Plot Processing formulas across original raster sources. */
import { rasterSourceReference, rasterSourceKey } from "../raster-source.js";
import { vectorSelectionsEqual } from "../selected-area.js";
import { isCanonicalWgs84Position } from "./geometry.js";
import { getTemporalMonthBoundaries, temporalPeriodError } from "../temporal-period.js";
import { csvParse, csvFormat } from "d3";

const SERIES_STATISTICS = Object.freeze({
    pixel: { label: "Pixel value", expression: "pixelValue(a)" },
    mean: { label: "Mean", expression: "mean(a)" },
    stdev: { label: "Standard deviation", expression: "stdev(a)" },
    min: { label: "Minimum", expression: "min(a)" },
    max: { label: "Maximum", expression: "max(a)" },
    sum: { label: "Sum", expression: "sum(a)" },
    area: { label: "Area above zero", expression: "areaha(a > 0)" },
    count: { label: "Count above 10", expression: "count(a > 10)" },
    "area-threshold": { label: "Area above 10", expression: "areaha(a > 10)" },
    "area-class": { label: "Area in class 4", expression: "areaha(a == 4)" },
    percent: { label: "Percent above 10", expression: "100 * count(a > 10) / count(a)" },
    range: { label: "Range", expression: "max(a) - min(a)" },
    custom: { label: "Custom", expression: "" },
});

/**
 * Encode one CSV field, keeping user-supplied text from becoming a spreadsheet formula.
 * @param {string|number|null} value Text, a measured number, or a missing value.
 * @return {string} Quoted CSV field.
 */
function csvField(value) {
    let text = value == null ? "" : String(value);
    if (typeof value === "string") text = spreadsheetText(text);
    return '"' + text.replaceAll('"', '""') + '"';
}

/** Keep a user-entered CSV label from executing as a spreadsheet formula.
 * @param {string} text User label. @return {string} Literal spreadsheet text.
 */
function spreadsheetText(text) { return /^[=+@\-\t\r\n]/.test(text) ? "'" + text : text; }

/** Find the captured formula supplying a statistic's exact expression.
 * Display identities can differ when another statistic reuses a completed result.
 * The captured job remains unchanged and retains its original formula labels.
 * @param {{calculationInputs:{calculations:{label:string,expression:string}[]}}|null|undefined} result Captured result, or none while waiting.
 * @param {{expression:string}} formula Current statistic to display or export.
 * @return {string|undefined} Original formula label, or undefined when not calculated.
 */
function getCapturedStatisticLabel(result, formula) {
    return result?.calculationInputs.calculations.find(calculation => calculation.expression === formula.expression.trim())?.label;
}

/** Compare immutable polygon-area or original-source selection identities.
 * Labels and feature counts do not identify a predicate.
 * @param {Object|null|undefined} left Catalog-selection or polygon-area descriptor.
 * @param {Object|null|undefined} right Catalog-selection or polygon-area descriptor.
 * @return {boolean} Whether both descriptors select the same polygons.
 * @throws {TypeError} If a catalog selection violates its descriptor contract.
 */
function vectorAreasEqual(left, right) {
    return left?.kind === "polygonArea" ? left.polygonArea.id === right?.polygonArea?.id
        : left?.kind === "catalogSelection" && vectorSelectionsEqual(left.catalogSelection, right?.catalogSelection);
}

/** Own raster choices, formulas and presentation settings for Raster series. */
export class RasterSeriesController {
    /**
     * Connect the plot to Processing calculations and its own view.
     * @param {Object} options Collaborators.
     * @param {import("./series-view.js").RasterSeriesView} options.view Plot controls.
     * @param {import("../processing/raster-series-calculations.js").RasterSeriesCalculations} options.areaStatistics Area formulas and Processing client.
     * @param {()=>void} options.onClose Request that composition close this tool.
     * @param {()=>void} [options.onOpenArea] Open the composed floating area controls.
     * @param {(choice:"selection"|"vector"|"whole")=>void} [options.onAreaChoice] Start or cancel polygon selection after an explicit area choice.
     * @param {(source:Object)=>Promise<Object>} options.getTemporalItem Read Catalog metadata for a selected dataset.
     */
    constructor({ view, onClose, areaStatistics, onAreaChoice = () => {}, onOpenArea = () => {}, getTemporalItem }) {
        this.view = view;
        this.getTemporalItem = getTemporalItem;
        this.areaStatistics = areaStatistics;
        this.onAreaChoice = onAreaChoice;
        this.areaStatistics.setProgressListener(() => this.render());
        this.formulas = [{ id: 1, ...SERIES_STATISTICS.mean }];
        this.formulaSerial = 1;
        this.areaChoice = "selection";
        this.plots = [{ id: 1, scale: "linear", bounds: null, xBounds: null }];
        this.plotSerial = 1;
        this.statisticDisplay = new Map([[1, { plotId: 1, visible: true, styleIndex: 0 }]]);
        this.selectedArea = null;
        this.selectedAreaLabel = "";
        this.vectorArea = null;
        this.vectorAreaLabel = "";
        /** @type {{area:Object,label:string}|null} Latest selection ignored while preserving captured work. */
        this.pendingVectorArea = null;
        /** @type {Set<object>} In-flight map filter updates that must not replace captured polygons. */
        this.vectorFilterHolds = new Set();
        /** @type {Set<"map"|"vector">} Passive preparations preserving captured polygon inputs. */
        this.preservedVectorPreparations = new Set();
        /** @type {Map<"map"|"vector",number>} Last start sequence from each existing selection producer. */
        this.vectorPreparationSequences = new Map();
        this.sources = [];
        this.selectedKeys = new Set();
        /** @type {Map<string, boolean>} Explicit checklist choices for retained rasters. */
        this.selectionOverrides = new Map();
        this.position = null;
        this.active = false;
        this.order = "map";
        this.direction = "forward";
        this.chartType = "line";
        this.sourceMode = "layers";
        this.temporal = {datasets: [], datasetKey: "", item: null, variable: "", periodMode: "month",
            startTime: "", endTime: "", loading: false, error: ""};
        view.bind({
            onClose,
            onOpenArea,
            onArea: choice => this.chooseArea(choice),
            onAddFormula: preset => this.addFormula(preset),
            onEditFormula: (id, change) => this.editFormula(id, change),
            onRemoveFormula: id => this.removeFormula(id),
            onStatisticDisplay: (id, change) => this.changeStatisticDisplay(id, change),
            onAddPlot: () => this.addPlot(),
            onRemovePlot: id => this.removePlot(id),
            onPlotOptions: (id, change) => this.setPlotOptions(id, change),
            onRetry: () => this.retryFailedCalculations(),
            onCancel: () => this.areaStatistics.cancelRemainingRasters(true),
            onRecover: () => void this.areaStatistics.retryInterruptedCalculations(),
            onSelect: (key, selected) => this.selectRaster(key, selected),
            onTimeRange: key => void this.chooseTimeRange(key),
            onTemporalVariable: variable => {
                this.temporal.variable = variable; this.updateAreaInputs();
            },
            onTemporalEdit: change => { Object.assign(this.temporal, change); this.updateAreaInputs(); },
            onOrder: (order, direction) => {
                this.order = order; this.direction = direction; this.render();
            },
            onChartType: type => { this.chartType = type; this.render(); },
            onDownload: () => view.downloadCsv(this.exportCsv()),
        });
        this.render();
    }

    /** Restore submitted calculations and their results after reload.
     * Recovered inputs
     * remain selected even if their sources are no longer in Map layers.
     * @return {Promise<void>} Saved jobs and any temporal metadata have been retrieved.
     */
    async start() {
        const area = this.areaStatistics;
        const started = area.start();
        if (area.hasCapturedInputs) {
            this.formulas = area.formulas.map(formula => ({...formula}));
            this.formulaSerial = Math.max(...this.formulas.map(formula => formula.id));
            this.statisticDisplay = new Map(this.formulas.map((formula, index) =>
                [formula.id, {plotId: 1, visible: true, styleIndex: index}]));
            this.selectedArea = area.area;
            this.selectedAreaLabel = area.areaLabel;
            this.areaChoice = {wholeRaster: "whole", selectedArea: "selection", catalogSelection: "vector", polygonArea: "vector"}[area.area.kind];
            if (this.areaChoice === "vector") {
                this.vectorArea = area.area; this.vectorAreaLabel = area.areaLabel;
            }
            this.position = area.pixelPoint;
            this.sources = area.sources;
            this.selectedKeys = new Set(area.sources.map(source => source.key));
            this.selectionOverrides = new Map(area.sources.map(source => [source.key, true]));
            if (area.temporalMode) {
                this.sourceMode = "temporal";
                const source = area.temporalSource;
                const dataset = {key: rasterSourceKey({collectionId: source.collectionId, itemId: source.itemId}),
                    ...source, label: source.itemId};
                Object.assign(this.temporal, {datasets: [dataset], datasetKey: dataset.key, variable: source.variable,
                    periodMode: "times", startTime: source.startTime.replace(/Z$/, ""), endTime: source.endTime.replace(/Z$/, "")});
                try { this.temporal.item = await this.getTemporalItem(dataset); }
                catch (error) { this.temporal.error = `Dataset could not be loaded: ${error.message} Refresh to try again.`; }
            }
        }
        await started;
        this.render();
    }

    /** Retry failed rows using the existing captured inputs and request lifecycle.
     * @return {void} Results arrive through the existing progress listener.
     */
    retryFailedCalculations() {
        this.selectionOverrides = new Map(this.sources.map(source => [source.key, this.selectedKeys.has(source.key)]));
        this.updateAreaInputs();
        this.areaStatistics.calculateRemainingRasters();
    }

    /** Select an existing view of an original raster, or add the source when it is not listed.
     * @param {Object} source Labeled original-source descriptor, including hidden sources.
     * @param {Object} [area] Explicit histogram area; omission retains the chosen scope.
     * @param {string|null} [viewKey=null] Originating retained view, when the action came from Map layers or its histogram.
     * @return {void}
     */
    selectSource(source, area, viewKey = null) {
        const sourceKey = rasterSourceKey(source);
        const existing = this.sources.find(item => item.key === viewKey) ??
            this.sources.find(item => rasterSourceKey(item) === sourceKey);
        const key = existing?.key ?? sourceKey;
        if (!existing) this.sources.push({key, source, label: source.label});
        this.sourceMode = "layers";
        this.selectedKeys = new Set([key]);
        this.selectionOverrides = new Map(this.sources.map(item => [item.key, item.key === key]));
        if (area !== undefined) {
            this.areaChoice = area?.kind === "wholeRaster" ? "whole" : "selection";
            this.selectedArea = area;
            this.selectedAreaLabel = "Selected histogram area";
        }
        this.updateAreaInputs();
    }

    /** Adopt polygon features, or explain a newer filter while captured work is hidden.
     * Captured background inputs remain unchanged until an explicit area choice.
     * @param {Object} info Catalog selection or owned polygon-area reference and display label.
     * @return {void}
     */
    setVectorSamplingArea(info) {
        const keepCalculation = this.keepCapturedVectorInputs;
        const area = info.polygonArea ? {kind: "polygonArea", polygonArea: info.polygonArea}
            : {kind: "catalogSelection", catalogSelection: info.selection};
        if (keepCalculation) {
            this.pendingVectorArea = {area, label: info.label};
            this.render(); return;
        }
        this.pendingVectorArea = null;
        this.vectorArea = area;
        this.vectorAreaLabel = info.label;
        this.areaChoice = "vector";
        this.updateAreaInputs();
    }

    /** Retain a map filter's passive origin until composition finishes committing it.
     * The policy applies to polygon calculations captured now or before the reply;
     * it does not affect whole-raster or box inputs. Call the returned release in
     * the filter operation's finally block, including after failure or cancellation.
     * @return {()=>void} Release this operation's hold, including after failure or cancellation.
     */
    preserveCapturedVectorArea() {
        const hold = {};
        this.vectorFilterHolds.add(hold);
        return () => { this.vectorFilterHolds.delete(hold); };
    }

    /** Whether an incoming map/vector update must leave captured inputs unchanged.
     * A passive read retains the policy established when it began, even if this
     * panel is reopened before its filter or area response arrives.
     * @return {boolean} Captured inputs must be retained for this update.
     */
    get keepCapturedVectorInputs() {
        const polygon = ["catalogSelection", "polygonArea"].includes(this.getSelectedArea()?.kind);
        return this.areaStatistics.hasCapturedInputs && (!this.active || polygon &&
            (this.preservedVectorPreparations.size > 0 || this.vectorFilterHolds.size > 0));
    }

    /** Apply a producer's explicit area choice or retain a passive preparation's captured inputs.
     * Map preparations affect selectedArea and are passive for statistics. Vector
     * choices affect this panel's vectorArea; a new explicit sequence supersedes
     * passive preparations. In-flight map filters retain their own origin until
     * they settle. Repeated progress renders are not new intent.
     * @param {{phase:string,explicit:boolean,sequence:number}} selection Preparation state, user intent and the producer's existing cancellation sequence.
     * @param {"map"|"vector"} [channel="vector"] Existing area-input owner supplied by composition.
     * @return {void}
     */
    setVectorSelectionState(selection, channel = "vector") {
        const newSequence = selection.sequence !== this.vectorPreparationSequences.get(channel);
        if (newSequence && (selection.phase === "reading" || selection.explicit)) {
            this.vectorPreparationSequences.set(channel, selection.sequence);
            if (channel === "vector" && selection.explicit) {
                this.preservedVectorPreparations.clear();
                this.pendingVectorArea = null;
                if (this.areaChoice === "vector") {
                    this.vectorArea = null; this.vectorAreaLabel = "";
                    this.updateAreaInputs();
                    return;
                }
            } else if (selection.phase === "reading" && this.keepCapturedVectorInputs &&
                ["catalogSelection", "polygonArea"].includes(this.getSelectedArea()?.kind)) {
                this.preservedVectorPreparations.add(channel);
            }
        }
        if (selection.phase !== "reading") { this.preservedVectorPreparations.delete(channel); return; }
        if (channel === "vector" && this.areaChoice === "vector") {
            if (this.keepCapturedVectorInputs) { this.render(); return; }
            this.vectorArea = null;
            this.updateAreaInputs();
        }
    }

    /** Release changed polygons through the caller's existing area-input channel.
     * Captured passive updates survive foreground changes; other active inputs
     * using the invalidated area are cancelled.
     * @param {Object} area Catalog-selection or polygon-area descriptor being invalidated.
     * @param {"all"|"map"} [channel="all"] Map updates invalidate selectedArea only; the statistics owner also invalidates vectorArea.
     * @return {void}
     */
    invalidateArea(area, channel = "all") {
        const keepCalculation = this.keepCapturedVectorInputs;
        if (vectorAreasEqual(area, this.pendingVectorArea?.area)) this.pendingVectorArea = null;
        if (keepCalculation) { this.render(); return; }
        if (channel !== "map" && vectorAreasEqual(area, this.vectorArea)) this.vectorArea = null;
        if (vectorAreasEqual(area, this.selectedArea)) this.selectedArea = null;
        this.updateAreaInputs();
    }

    /**
     * Update available rasters and reconcile their default selections.
     * Untouched sources follow map visibility; explicit checklist choices override
     * that default. Background calculations retain their captured inputs through map
     * changes; hidden rasters remain selectable.
     * @param {Object[]} sources Ordered map snapshots with original-source references.
     * @param {Object[]} [datasets=[]] Distinct temporal Catalog identities retained in Map layers.
     * @return {void}
     */
    updateAvailableRasters(sources, datasets = []) {
        if (this.areaStatistics.hasCapturedInputs && !this.active) {
            sources = [...sources, ...this.sources.filter(source => this.selectedKeys.has(source.key) && !sources.some(item => item.key === source.key))];
            datasets = [...datasets, ...this.temporal.datasets.filter(dataset => dataset.key === this.temporal.datasetKey && !datasets.some(item => item.key === dataset.key))];
        }
        this.temporal.datasets = datasets;
        if (this.temporal.datasetKey && !datasets.some(dataset => dataset.key === this.temporal.datasetKey)) {
            this.temporalAbort?.abort();
            Object.assign(this.temporal, {datasetKey: "", item: null, variable: "", loading: false, error: ""});
            this.sourceMode = "layers";
        }
        const newKeys = new Set(sources.map(source => source.key));
        this.selectionOverrides = new Map([...this.selectionOverrides].filter(([key]) => newKeys.has(key)));
        this.selectedKeys = new Set(sources.filter(source => this.selectionOverrides.get(source.key) ?? source.visible)
            .map(source => source.key));
        this.sources = sources.map(source => ({ ...source }));
        const snapshot = this.sourceMode === "temporal" && this.sources.find(source => source.key === this.temporal.viewKey);
        const variable = snapshot && rasterSourceReference(snapshot).variable;
        if (this.active && variable && variable !== this.temporal.variable) {
            this.temporal.variable = variable;
            this.updateAreaInputs();
        } else if (this.areaStatistics.hasCapturedInputs && !this.active) this.render();
        else this.updateAreaInputs();
    }

    /** Select a named source's time range, initially using its displayed variable.
     * Named views supply their variable; choosing another view preserves the
     * requested period. A dataset without a snapshot keeps its own variable choice.
     * Turning the range off restores the remembered individual raster choices.
     * @param {string|null} key Retained raster view or dataset key; null returns to the individual raster choices.
     * @return {Promise<void>} Selected variable metadata has finished loading.
     */
    async chooseTimeRange(key) {
        if (key === null) { this.sourceMode = "layers"; this.updateAreaInputs(); return; }
        const snapshot = this.sources.find(source => source.key === key);
        const reference = snapshot ? rasterSourceReference(snapshot) : null;
        const dataset = reference ? this.temporal.datasets.find(source =>
            source.collectionId === reference.collectionId && source.itemId === reference.itemId) :
            this.temporal.datasets.find(source => source.key === key);
        const sameDataset = this.temporal.datasetKey === dataset.key;
        const sameView = this.temporal.viewKey === key;
        this.sourceMode = "temporal";
        this.temporal.viewKey = key;
        if (sameDataset && sameView) { this.updateAreaInputs(); return; }
        this.temporalAbort?.abort();
        Object.assign(this.temporal, {datasetKey: dataset.key, item: sameDataset ? this.temporal.item : null,
            variable: reference?.variable ?? (sameDataset ? this.temporal.variable : ""),
            loading: false, error: ""});
        this.updateAreaInputs();
        if (!this.temporal.startTime && reference?.time) Object.assign(this.temporal, getTemporalMonthBoundaries(reference.time.slice(0, 7)));
        if (!sameDataset || !this.temporal.item) await this.loadTemporalItem();
        else this.updateAreaInputs();
    }

    /** Describe named snapshot and time-range choices without changing their selections.
     * Retained datasets remain usable even when no displayed observation is available.
     * Individual checkmarks remain selected while disabled. A recovered range
     * marks the first matching view when the job has no map-view identity.
     * @return {import("./series-view.js").SeriesPresentation["sources"]} Named snapshot and dataset rows with their active intent.
     */
    sourceChoices() {
        const represented = new Set();
        const choices = this.sources.map(source => {
            const reference = rasterSourceReference(source);
            const dataset = this.temporal.datasets.find(item => item.collectionId === reference.collectionId && item.itemId === reference.itemId);
            if (dataset) represented.add(dataset.key);
            return {...source, selected: this.selectedKeys.has(source.key),
                temporalDatasetKey: dataset?.key, rangeSelected: false};
        });
        choices.push(...this.temporal.datasets.filter(dataset => !represented.has(dataset.key)).map(dataset =>
            ({...dataset, hasSnapshot: false, selected: false, temporalDatasetKey: dataset.key,
                rangeSelected: false})));
        if (this.sourceMode === "temporal") {
            const selected = choices.find(source => source.key === this.temporal.viewKey) ??
                choices.find(source => source.temporalDatasetKey === this.temporal.datasetKey);
            if (selected) selected.rangeSelected = true;
        }
        return choices;
    }

    /** Read the selected dataset's variable metadata, also used by explicit Catalog refresh.
     * Superseded selections ignore late replies. Availability listings are not
     * needed to choose a year, month, day range or exact UTC interval.
     * @return {Promise<void>} Metadata loaded or an actual Catalog error displayed.
     */
    async loadTemporalItem() {
        const temporal = this.temporal;
        const source = temporal.datasets.find(dataset => dataset.key === temporal.datasetKey);
        if (!source) return;
        this.areaStatistics.discardTemporalResults();
        this.temporalAbort?.abort();
        const abort = this.temporalAbort = new AbortController();
        Object.assign(temporal, {loading: true, error: ""}); this.render();
        try {
            const item = await this.getTemporalItem(source);
            if (abort.signal.aborted) return;
            temporal.item = item;
            const variables = Object.keys(item.properties["cube:variables"]);
            if (!temporal.variable && variables.length === 1) temporal.variable = variables[0];
        } catch (error) {
            if (!abort.signal.aborted) temporal.error = `Dataset could not be loaded: ${error.message} Reload to try again.`;
        } finally {
            if (!abort.signal.aborted) { temporal.loading = false; this.updateAreaInputs(); }
        }
    }

    /** Explain incomplete temporal input before an automatic calculation.
     * @return {string} User-facing guidance, or an empty string for a complete selection.
     */
    temporalSelectionError() {
        const temporal = this.temporal;
        if (!temporal.datasetKey) return temporal.datasets.length ? "Choose a temporal dataset." : "Add a temporal dataset from Catalog to Map layers.";
        if (temporal.loading) return "Loading dataset variables…";
        if (temporal.error) return temporal.error;
        if (!temporal.item?.properties["cube:variables"][temporal.variable]) return "Choose a variable.";
        return temporalPeriodError(temporal);
    }

    /**
     * Remember a completed map click and refresh only while this tool is active.
     * Clicks outside the canonical map world clear the point instead of sending an invalid request.
     * @param {{longitude:number,latitude:number}|null} position Map click in WGS 84 degrees, or a cleared click.
     * @return {void}
     */
    setPosition(position) {
        if (!this.active && this.areaStatistics.hasCapturedInputs) return;
        if (this.position?.longitude === position?.longitude && this.position?.latitude === position?.latitude) return;
        this.position = isCanonicalWgs84Position(position) ? Object.freeze({ ...position }) : null;
        this.updateAreaInputs();
    }

    /**
     * Start automatic calculations when shown; keep submitted work running when hidden.
     * Completed values and settings remain available when the panel is reopened.
     * @param {boolean} panelVisible Whether Raster series is the visible, active tool.
     * @return {void}
     */
    updateSamplingForPanelVisibility(panelVisible) {
        if (this.active === panelVisible) return;
        this.active = panelVisible;
        this.areaStatistics.updateCalculationForPanelVisibility(panelVisible);
        this.render();
    }

    /**
     * Include or exclude one raster explicitly and refresh calculations.
     * The choice overrides the map-visibility default while this source is retained.
     * Selecting a snapshot returns from a time range to the retained raster checklist.
     * @param {string} key Available raster identity.
     * @param {boolean} selected Whether to include this raster.
     * @return {void}
     */
    selectRaster(key, selected) {
        if (!this.sources.some(source => source.key === key)) return;
        this.sourceMode = "layers";
        this.selectionOverrides.set(key, selected);
        if (selected) this.selectedKeys.add(key);
        else this.selectedKeys.delete(key);
        this.updateAreaInputs();
    }

    /**
     * Read selected sources in plot order without changing sampling or source identity.
     * @return {{key:string,label:string,item:Object,visible:boolean}[]} Plot sources.
     */
    orderedSources() {
        const sources = this.sources.filter(source => this.selectedKeys.has(source.key));
        if (this.order === "name") sources.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
        if (this.direction === "reverse") sources.reverse();
        return sources;
    }

    /** Keep submitted observations attached to their values while live views change.
     * @return {Object[]} Result sources in the selected display order.
     */
    orderedResultSources() {
        return this.orderedSources().map(source => {
            const captured = this.areaStatistics.hasCapturedInputs && this.areaStatistics.sources.find(item => item.key === source.key);
            return captured && rasterSourceKey(captured) !== rasterSourceKey(source) ? captured : source;
        });
    }

    /** Adopt a committed map area without forgetting this calculation's area during map refresh.
     * A null map snapshot means no new selection. Explicit source invalidation
     * clears affected polygon areas through invalidateArea(). Hidden work and
     * passive polygon preparations retain their captured inputs through foreground changes.
     * @param {Object|null} area Newly selected Processing area, or null when the map has no selection to publish.
     * @param {string} [label="Current sampling area"] Area description. @return {void}
     */
    setArea(area, label = "Current sampling area") {
        const keepCalculation = this.keepCapturedVectorInputs;
        if (area === null || keepCalculation) {
            if (keepCalculation && this.areaChoice === "selection" && ["catalogSelection", "polygonArea"].includes(area?.kind)) this.pendingVectorArea = {area, label};
            this.render(); return;
        }
        this.selectedArea = area; this.selectedAreaLabel = label;
        this.updateAreaInputs();
    }

    /** Read the latest area selected for the next calculation.
     * @return {Object|null} Whole raster, polygon selection, map area, or no selection.
     */
    getSelectedArea() {
        return this.areaChoice === "whole" ? {kind: "wholeRaster"}
            : this.areaChoice === "vector" ? this.vectorArea : this.selectedArea;
    }

    /** Whether live map observations differ from captured raster inputs.
     * @return {boolean} The controls differ from the captured calculation inputs.
     */
    get hasPendingInputs() {
        if (this.sourceMode !== "layers" || !this.areaStatistics.hasCapturedInputs) return false;
        const identities = [this.orderedSources(), this.areaStatistics.sources]
            .map(sources => sources.map(source => [source.key, rasterSourceKey(source)]).sort());
        return JSON.stringify(identities[0]) !== JSON.stringify(identities[1]);
    }

    /** Whether a prepared source/predicate differs from this calculation's captured polygons.
     * @return {boolean} The latest polygon filter needs an explicit area choice.
     */
    get hasPendingVectorArea() {
        const pending = this.pendingVectorArea, selected = this.getSelectedArea();
        return !!pending && ["catalogSelection", "polygonArea"].includes(selected?.kind) && !vectorAreasEqual(pending.area, selected);
    }

    /** Explain a newer polygon filter without relabeling captured calculation inputs.
     * @return {string} Guidance for explicitly adopting the latest filter, or empty when unchanged.
     */
    get pendingVectorAreaMessage() {
        if (!this.hasPendingVectorArea) return "";
        const pending = this.pendingVectorArea;
        const label = this.areaChoice === "vector" ? this.vectorAreaLabel : this.selectedAreaLabel;
        const action = this.areaChoice === "vector" ? "Use current polygon filter to update these statistics."
            : "Choose polygon layer, then select the layer and filter for these statistics.";
        return `These statistics use the previous filter: ${label}. The polygon layer now selects ${pending.label}. ${action}`;
    }

    /** Supply the area calculator with chosen original sources, independent of chart order. @return {void} */
    updateAreaInputs() {
        const area = this.getSelectedArea();
        const label = this.areaChoice === "vector" ? this.vectorAreaLabel : this.selectedAreaLabel;
        if (this.sourceMode === "temporal") {
            const temporal = this.temporal;
            const source = this.temporalSelectionError() ? null : {collectionId: temporal.item.collection, itemId: temporal.item.id,
                variable: temporal.variable, startTime: new Date(`${temporal.startTime}Z`).toISOString(), endTime: new Date(`${temporal.endTime}Z`).toISOString()};
            this.areaStatistics.updateTemporalInputs(source, area, label, this.formulas, this.position);
            return;
        }
        this.areaStatistics.updateCalculationInputs(this.sources.filter(source => this.selectedKeys.has(source.key)),
            area, label, this.formulas, this.position);
    }

    /** Commit an explicit area choice and start or cancel polygon selection through composition.
     * This intent replaces captured inputs even while a filter editor hides this panel.
     * Replacement calculations start when the panel is active. Choosing Vector again
     * retries selection without reusing the previous polygons.
     * @param {"selection"|"vector"|"whole"} choice Area source. @return {void}
     */
    chooseArea(choice) {
        this.preservedVectorPreparations.clear();
        this.pendingVectorArea = null;
        this.areaChoice = choice;
        if (choice === "vector") this.vectorArea = null;
        if (choice === "selection" && this.selectedArea?.kind !== "selectedArea") {
            this.selectedArea = null; this.selectedAreaLabel = "";
        }
        // Present the new sampling intent before composition selects a map box.
        this.render();
        this.onAreaChoice(choice);
        this.updateAreaInputs();
        this.preservedVectorPreparations.clear();
    }

    /** Add one editable formula, up to the backend's five-calculation limit.
     * @param {string} preset Key in SERIES_STATISTICS. @return {void}
     */
    addFormula(preset) {
        if (!SERIES_STATISTICS[preset] || this.formulas.length === 5) return;
        this.formulas.push({ id: ++this.formulaSerial, ...SERIES_STATISTICS[preset] });
        const usedStyles = new Set([...this.statisticDisplay.values()].map(display => display.styleIndex));
        this.statisticDisplay.set(this.formulaSerial, {
            plotId: 1, visible: true, styleIndex: [0, 1, 2, 3, 4].find(index => !usedStyles.has(index)),
        });
        this.updateAreaInputs();
    }

    /** Edit a formula or its display name; names never change calculation identity.
     * @param {number} id Formula identity.
     * @param {{label?:string,expression?:string}} change Editor values. @return {void}
     */
    editFormula(id, change) {
        const formula = this.formulas.find(item => item.id === id);
        if (!formula) return;
        const oldExpression = formula.expression;
        Object.assign(formula, change);
        if (oldExpression !== formula.expression) this.updateAreaInputs();
        else this.render();
    }

    /** Remove a formula while keeping at least one statistic.
     * @param {number} id Formula identity. @return {void}
     */
    removeFormula(id) {
        if (this.formulas.length === 1) return;
        this.formulas = this.formulas.filter(formula => formula.id !== id);
        this.statisticDisplay.delete(id);
        this.updateAreaInputs();
    }

    /** Change only where a statistic is displayed, without requesting calculations.
     * @param {number} id Statistic identity.
     * @param {{visible?:boolean,plotId?:number}} change Visibility, destination plot or user-selected color.
     * @return {void}
     */
    changeStatisticDisplay(id, change) {
        const display = this.statisticDisplay.get(id);
        if (!display || (change.plotId !== undefined && !this.plots.some(plot => plot.id === change.plotId))) return;
        Object.assign(display, change);
        this.render();
    }

    /** Add an empty plot with a linear Y axis; retain all calculation results. @return {void} */
    addPlot() {
        this.plots.push({ id: ++this.plotSerial, scale: "linear", bounds: null, xBounds: null });
        this.render();
    }

    /** Remove a secondary plot and move its statistics to Plot 1.
     * @param {number} id Plot identity; Plot 1 cannot be removed. @return {void}
     */
    removePlot(id) {
        if (id === 1) return;
        this.plots = this.plots.filter(plot => plot.id !== id);
        for (const display of this.statisticDisplay.values()) if (display.plotId === id) display.plotId = 1;
        this.render();
    }

    /** Change validated plot appearance without changing calculation inputs or values.
     * @param {number} id Plot identity.
     * @param {{scale:"linear"|"log",bounds:[number,number]|null,xBounds:[number,number]|null,pointSize?:number,xTickCount?:number,yTickCount?:number,axisFontSize?:number}} change Display-only settings validated by the axis editor.
     * @return {void}
     */
    setPlotOptions(id, change) {
        const plot = this.plots.find(item => item.id === id);
        Object.assign(plot, change);
        this.render();
    }

    /** Present every statistic, keeping previous-area plots separate from current results. @return {void} */
    render() {
        const area = this.areaStatistics;
        if (this.sourceMode === "temporal") { this.renderTemporalResults(); return; }
        const sources = this.orderedResultSources();
        /** Join one result set to plot order without mixing current and previous areas.
         * @param {Map<string,Object>} results Per-source calculation outcomes.
         * @param {{id:number,label:string,expression:string}} formula Statistic to match.
         * @return {Object[]} Ordered chart/table rows.
         */
        const rowsFor = (results, formula) => sources.map(source => {
            const result = results.get(source.key);
            const capturedLabel = getCapturedStatisticLabel(result, formula);
            const row = result?.job?.result?.rows.find(row => row.label === capturedLabel);
            const sameFormula = capturedLabel !== undefined;
            return { key: source.key, label: source.label, statisticId: formula.id, statisticLabel: formula.label || formula.expression || "Custom statistic",
                state: row?.state === "ok" && sameFormula ? "value" : result?.error ? "error" : sameFormula ? row?.state ?? "waiting" : "waiting",
                value: !sameFormula || row?.value == null ? null : Number(row.value), rawValue: sameFormula ? row?.value : null, unit: row?.unit ?? "",
                errorMessage: area.commonError ? "Not calculated. See the message above." : result?.error ?? area.progress.get(source.key)?.message ?? (!result ? "Waiting" : ""), cached: !!result?.job?.result?.cacheHit };
        });
        const statistics = this.formulas.map(formula => ({ ...formula, ...this.statisticDisplay.get(formula.id), rows: rowsFor(area.results, formula) }));
        const rows = sources.flatMap((source, index) => statistics.map(statistic => statistic.rows[index]));
        const showingPrevious = !!(area.busy && !rows.some(row => row.state === "value") && area.previousResults);
        for (const statistic of statistics) statistic.previousRows = showingPrevious ? rowsFor(area.previousResults, statistic) : null;
        this.view.render({
            active: this.active, area: { formulas: this.formulas, sources: area.sources, areaChoice: this.areaChoice,
                area: this.getSelectedArea(), areaLabel: this.areaChoice === "vector" ? this.vectorAreaLabel : this.selectedAreaLabel,
                results: area.results, hasPendingVectorArea: this.hasPendingVectorArea,
                recoverable: area.needsRecovery, hasErrors: area.hasErrors }, statistics, plots: this.plots,
            sources: this.sourceChoices(),
            rows, previousRows: showingPrevious ? statistics.flatMap(statistic => statistic.previousRows) : null,
            showingPrevious, busy: area.busy, chartType: this.chartType, direction: this.direction,
            message: area.results.size + " of " + sources.length + " rasters complete. " + area.message +
                (this.hasPendingInputs ? " Results use the previous inputs." : "") +
                (this.pendingVectorAreaMessage ? " " + this.pendingVectorAreaMessage : ""),
            canDownload: area.results.size > 0 && !area.busy,
        });
    }

    /** Present saved temporal values through the same statistic, chart and table contract.
     * Plot-only edits never resubmit a calculation or reread its source rasters.
     * @return {void}
     */
    renderTemporalResults() {
        const area = this.areaStatistics, showingPrevious = !!(area.busy && !area.temporalResult && area.previousTemporalResult);
        const result = area.temporalResult ?? (showingPrevious ? area.previousTemporalResult : null);
        const observations = result?.observations ?? [];
        const statistics = this.formulas.map(formula => ({...formula, ...this.statisticDisplay.get(formula.id), previousRows: null,
            rows: observations.map(({time, rows}) => {
                const capturedLabel = getCapturedStatisticLabel(result, formula);
                const row = rows.find(value => value.label === capturedLabel);
                const matches = capturedLabel !== undefined;
                return {key: time, xValue: Date.parse(time), label: new Date(time).toISOString().replace("T", " ").replace(/(\.000)?Z$/, " UTC"),
                    statisticId: formula.id, statisticLabel: formula.label || formula.expression, state: !matches ? "waiting" : row?.state === "ok" ? "value" : row?.state ?? "waiting",
                    value: !matches || row?.value == null ? null : Number(row.value), rawValue: matches ? row?.value : null, unit: row?.unit ?? ""};
            })}));
        if (showingPrevious) for (const statistic of statistics) {statistic.previousRows = statistic.rows; statistic.rows = [];}
        this.view.render({active: this.active, temporal: {...this.temporal,
            variableBound: this.sources.some(source => source.key === this.temporal.viewKey), selectionError: this.temporalSelectionError()},
            area: {formulas: this.formulas, sources: [], areaChoice: this.areaChoice, area: this.getSelectedArea(),
                areaLabel: this.areaChoice === "vector" ? this.vectorAreaLabel : this.selectedAreaLabel,
                results: area.results, hasPendingVectorArea: this.hasPendingVectorArea, recoverable: area.needsRecovery, hasErrors: area.hasErrors},
            statistics, plots: this.plots, sources: this.sourceChoices(), rows: showingPrevious ? [] : observations.flatMap((_, index) => statistics.map(statistic => statistic.rows[index])),
            previousRows: showingPrevious ? statistics.flatMap(statistic => statistic.previousRows) : null,
            showingPrevious, busy: area.busy, workProgress: area.temporalWork, chartType: this.chartType, direction: this.direction,
            message: (this.temporalSelectionError() || area.message) +
                (this.pendingVectorAreaMessage ? " " + this.pendingVectorAreaMessage : ""),
            canDownload: !!result && !area.busy});
    }

    /** Export every current statistic with exact values and its captured source/area metadata.
     * Repeated expressions receive separate rows with their current names, in statistic order;
     * the original completed jobs and temporal CSV remain unchanged.
     * @return {string} CSV document, or an empty string before results are available.
     */
    exportCsv() {
        const area = this.areaStatistics;
        if (this.sourceMode === "temporal") {
            if (area.busy || !area.temporalResult) return "";
            const rows = csvParse(area.temporalResult.csv);
            /** Native JavaScript lookups keyed by UTC time, then captured calculation label.
             * @type {Map<string, Map<string, Record<string, string>>>}
             */
            const rowsByTime = new Map();
            for (const row of rows) {
                if (!rowsByTime.has(row.time_utc)) rowsByTime.set(row.time_utc, new Map());
                rowsByTime.get(row.time_utc).set(row.calculation, row);
            }
            const statistics = this.formulas.map(formula => ({label: getCapturedStatisticLabel(area.temporalResult, formula),
                name: spreadsheetText(formula.label || formula.expression)}));
            const exported = [...rowsByTime.values()].flatMap(rowsByCalculationLabel => statistics.map(({label, name}) =>
                ({...rowsByCalculationLabel.get(label), calculation: name})));
            return csvFormat(exported, rows.columns) + "\r\n";
        }
        if (area.busy || !area.results.size) return "";
        const lines = [["raster", "collection_id", "item_id", "statistic", "formula", "value", "unit", "status", "error", "area", "job_id", "cached", "pixel_point", "source"]];
        for (const source of this.orderedResultSources()) {
            const result = area.results.get(source.key);
            const reference = rasterSourceReference(source);
            for (const formula of this.formulas) {
                const capturedLabel = getCapturedStatisticLabel(result, formula);
                const row = result?.job?.result?.rows.find(row => row.label === capturedLabel);
                // Values are validated decimal strings from Processing, not user text.
                const scalar = row?.value == null ? "" : { scalar: row.value };
                lines.push([source.label, reference.collectionId ?? "", reference.itemId ?? "", formula.label, formula.expression,
                    scalar, row?.unit ?? "", row?.state ?? (result?.error ? "error" : "waiting"), result?.error ?? "",
                    JSON.stringify(result?.calculationInputs.area ?? (this.areaChoice === "whole" ? {kind:"wholeRaster"} : area.area)),
                    result?.job?.jobId ?? "", result?.job?.result?.cacheHit ? "true" : "false",
                    result?.calculationInputs.pixelPoint ? JSON.stringify(result.calculationInputs.pixelPoint) : "", JSON.stringify(reference)]);
            }
        }
        return lines.map(line => line.map(value => typeof value === "object" && value !== null ? '"' + value.scalar + '"' : csvField(value)).join(",")).join("\r\n") + "\r\n";
    }

}
