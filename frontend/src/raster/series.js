/** Plot pixel values or area statistics across catalog rasters. */
import { RasterPointSamplesController, MAXIMUM_POINT_SAMPLE_PARTICIPANTS } from "./point-samples.js";
import { isCanonicalWgs84Position } from "./geometry.js";

const SERIES_STATISTICS = Object.freeze({
    mean: { label: "Mean", expression: "mean(a)" },
    min: { label: "Minimum", expression: "min(a)" },
    max: { label: "Maximum", expression: "max(a)" },
    sum: { label: "Sum", expression: "sum(a)" },
    area: { label: "Area above zero", expression: "areaha(a > 0)" },
    custom: { label: "Custom", expression: "" },
});

/**
 * Encode one CSV field, keeping user-supplied text from becoming a spreadsheet formula.
 * @param {string|number|null} value Text, a measured number, or a missing value.
 * @return {string} Quoted CSV field.
 */
function csvField(value) {
    let text = value == null ? "" : String(value);
    if (typeof value === "string" && /^[=+@\-\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
}

/** Own raster choices, pixel/area mode and presentation settings for Raster series. */
export class RasterSeriesController {
    /**
     * Connect the plot to pixel reading, area calculations and its own view.
     * @param {Object} options Collaborators.
     * @param {import("./point-samples.js").SampleRasterPoint} options.samplePoint Catalog pixel reader.
     * @param {import("./series-view.js").RasterSeriesView} options.view Plot controls.
     * @param {import("../processing/raster-series-calculations.js").RasterSeriesCalculations} options.areaStatistics Area formulas and Processing client.
     * @param {()=>void} options.onEditArea Open existing sampling controls.
     * @param {()=>void} options.onClose Request that composition close this tool.
     */
    constructor({ samplePoint, view, onClose, areaStatistics, onEditArea }) {
        this.view = view;
        this.areaStatistics = areaStatistics;
        this.areaStatistics.setProgressListener(() => this.render());
        this.mode = "pixel";
        this.formulas = [{ id: 1, ...SERIES_STATISTICS.mean }];
        this.formulaSerial = 1;
        this.areaChoice = "selection";
        this.plots = [{ id: 1, scale: "linear" }];
        this.plotSerial = 1;
        this.statisticDisplay = new Map([[1, { plotId: 1, visible: true, styleIndex: 0 }]]);
        this.selectedArea = null;
        this.selectedAreaLabel = "";
        this.sources = [];
        this.selectedKeys = new Set();
        this.position = null;
        this.snapshot = null;
        this.previousSnapshot = null;
        this.active = false;
        this.order = "map";
        this.direction = "forward";
        this.chartType = "line";
        this.sampler = new RasterPointSamplesController(samplePoint, snapshot => {
            if (snapshot === null) return;
            this.snapshot = snapshot;
            this.render();
        });
        view.bind({
            onClose, onEditArea,
            onMode: mode => this.setMode(mode),
            onArea: choice => this.chooseArea(choice),
            onAddFormula: preset => this.addFormula(preset),
            onEditFormula: (id, change) => this.editFormula(id, change),
            onRemoveFormula: id => this.removeFormula(id),
            onStatisticDisplay: (id, change) => this.changeStatisticDisplay(id, change),
            onAddPlot: () => this.addPlot(),
            onRemovePlot: id => this.removePlot(id),
            onPlotScale: (id, scale) => this.setPlotScale(id, scale),
            onCalculate: () => void this.areaStatistics.calculateRemainingRasters(),
            onCancel: () => this.areaStatistics.cancelRemainingRasters(),
            onRecover: () => void this.areaStatistics.retryInterruptedCalculations(),
            onSelect: (key, selected) => this.selectRaster(key, selected),
            onOrder: (order, direction) => {
                this.order = order; this.direction = direction; this.render();
            },
            onChartType: type => { this.chartType = type; this.render(); },
            onRetry: () => this.invalidateResults(),
            onDownload: () => view.downloadCsv(this.exportCsv()),
        });
        this.render();
    }

    /**
     * Update available catalog rasters, preserving user choices for retained sources.
     * Visible newly added rasters are selected by default. Hidden rasters remain selectable.
     * @param {{key:string,label:string,item:Object,visible:boolean}[]} sources Ordered catalog sources.
     * @return {void}
     */
    updateAvailableRasters(sources) {
        const oldKeys = new Set(this.sources.map(source => source.key));
        const oldSelection = [...this.selectedKeys].sort().join("\n");
        const newKeys = new Set(sources.map(source => source.key));
        this.selectedKeys = new Set([...this.selectedKeys].filter(key => newKeys.has(key)));
        for (const source of sources) {
            if (!oldKeys.has(source.key) && source.visible) this.selectedKeys.add(source.key);
        }
        this.sources = sources.map(source => ({ ...source }));
        this.updateAreaInputs();
        if (oldSelection !== [...this.selectedKeys].sort().join("\n")) this.invalidateResults();
        else this.render();
    }

    /**
     * Remember a completed map click and refresh only while this tool is active.
     * Clicks outside the canonical map world clear the point instead of sending an invalid request.
     * @param {{longitude:number,latitude:number}} position Map click in WGS 84 degrees.
     * @return {void}
     */
    setPosition(position) {
        if (this.position?.longitude === position.longitude && this.position?.latitude === position.latitude) return;
        this.position = isCanonicalWgs84Position(position) ? Object.freeze({ ...position }) : null;
        this.invalidateResults();
    }

    /**
     * Start the selected pixel or area workflow when shown; cancel unfinished work when hidden.
     * Completed values and settings remain available when the panel is reopened.
     * @param {boolean} panelVisible Whether Raster series is the visible, active tool.
     * @return {void}
     */
    updateSamplingForPanelVisibility(panelVisible) {
        if (this.active === panelVisible) return;
        this.active = panelVisible;
        this.areaStatistics.updateCalculationForPanelVisibility(panelVisible && this.mode === "area");
        if (!panelVisible) {
            if (this.snapshot?.samples.some(sample => sample.state === "loading")) this.snapshot = null;
            this.sampler.clear();
        } else if (!this.snapshot) this.sampleSelectedRasters();
        this.render();
    }

    /**
     * Include or exclude one raster and refresh the current click.
     * @param {string} key Available raster identity.
     * @param {boolean} selected Whether to include this raster.
     * @return {void}
     */
    selectRaster(key, selected) {
        if (!this.sources.some(source => source.key === key)) return;
        if (selected) this.selectedKeys.add(key);
        else this.selectedKeys.delete(key);
        this.updateAreaInputs();
        this.invalidateResults();
    }

    /** Retain a completed previous plot while the new request replaces it. @return {void} */
    invalidateResults() {
        if (this.snapshot && this.snapshot.samples.every(sample => sample.state !== "loading")) {
            this.previousSnapshot = this.snapshot;
        }
        this.snapshot = null;
        this.sampler.clear();
        if (this.active) this.sampleSelectedRasters();
        else this.render();
    }

    /** Request selected pixels through the bounded point sampler. @return {void} */
    sampleSelectedRasters() {
        const sources = this.sources.filter(source => this.selectedKeys.has(source.key));
        if (!this.active || this.mode !== "pixel" || !this.position || !sources.length || sources.length > MAXIMUM_POINT_SAMPLE_PARTICIPANTS) {
            this.render();
            return;
        }
        this.sampler.sample(sources.map(source => ({ ...source, axis: null })), this.position);
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

    /** Present current results, with separate previous values while replacements are pending. @return {void} */
    render() {
        if (this.mode === "area") { this.renderAreaStatistics(); return; }
        const sources = this.orderedSources();
        const byKey = new Map(this.snapshot?.samples.map(sample => [sample.key, sample]) ?? []);
        const rows = sources.map(source => ({
            ...source, state: this.snapshot ? "loading" : "waiting", value: null, errorMessage: "", ...byKey.get(source.key),
            label: source.label,
        }));
        const busy = !!this.snapshot && rows.some(row => row.state === "loading");
        const completed = rows.filter(row => row.state !== "loading").length;
        let message = !this.sources.length ? "Add raster layers to the map to plot their pixel values."
            : !sources.length ? "Select rasters to plot."
            : sources.length > MAXIMUM_POINT_SAMPLE_PARTICIPANTS ? `Select up to ${MAXIMUM_POINT_SAMPLE_PARTICIPANTS} rasters per plot; ${sources.length} are selected.`
            : !this.position ? "Click the map to plot values across these rasters."
            : !this.snapshot ? "Click the map or retry to read these pixels."
            : busy ? `Reading pixel values: ${completed} of ${rows.length} rasters complete.`
            : `${rows.filter(row => row.state === "value").length} of ${rows.length} rasters returned a pixel value.`;
        const previous = busy && !rows.some(row => row.state === "value") ? this.previousSnapshot : null;
        const previousByKey = new Map(previous?.samples.map(sample => [sample.key, sample]) ?? []);
        this.view.render({
            sources: this.sources.map(source => ({ ...source, selected: this.selectedKeys.has(source.key) })),
            active: this.active, mode: this.mode, rows, position: this.position, message, busy, chartType: this.chartType,
            previousRows: previous ? sources.map(source => ({ ...source, ...previousByKey.get(source.key), label: source.label })) : null,
            canDownload: !!this.snapshot && !busy && rows.length > 0,
            canRetry: !!this.position && sources.length > 0 && sources.length <= MAXIMUM_POINT_SAMPLE_PARTICIPANTS && !busy,
        });
    }

    /**
     * Export the current ordered results with catalog identities, click and missing-data states.
     * @return {string} CSV document, or an empty string when no completed result is available.
     */
    exportCsv() {
        if (this.mode === "area") return this.exportAreaCsv();
        if (!this.snapshot || this.snapshot.samples.some(row => row.state === "loading")) return "";
        const byKey = new Map(this.snapshot.samples.map(row => [row.key, row]));
        const lines = [["raster", "collection_id", "item_id", "longitude", "latitude", "value", "status", "error"]];
        for (const source of this.orderedSources()) {
            const row = byKey.get(source.key);
            lines.push([source.label, source.item.collection, source.item.id,
                this.snapshot.position.longitude, this.snapshot.position.latitude,
                row.value, row.state, row.errorMessage]);
        }
        return lines.map(line => line.map(csvField).join(",")).join("\r\n") + "\r\n";
    }

    /** Switch the data being plotted without changing sources or chart order.
     * @param {"pixel"|"area"} mode Series data mode. @return {void}
     */
    setMode(mode) {
        if (this.mode === mode) return;
        this.mode = mode;
        this.areaStatistics.updateCalculationForPanelVisibility(this.active && mode === "area");
        if (mode === "area") this.sampler.clear();
        else if (!this.snapshot || this.snapshot.samples.some(row => row.state === "loading")) this.sampleSelectedRasters();
        this.render();
    }

    /** Accept an exact area from composition; optional outlines never determine availability.
     * @param {Object|null} area Processing sampling descriptor.
     * @param {string} [label="Current sampling area"] Area description. @return {void}
     */
    setArea(area, label = "Current sampling area") {
        this.selectedArea = area; this.selectedAreaLabel = label; this.updateAreaInputs();
    }

    /** Supply the area calculator with chosen catalog sources, independent of chart order. @return {void} */
    updateAreaInputs() {
        this.areaStatistics.updateCalculationInputs(this.sources.filter(source => this.selectedKeys.has(source.key)),
            this.areaChoice === "whole" ? {kind:"wholeRaster"} : this.selectedArea, this.selectedAreaLabel, this.formulas);
    }

    /** Choose shared sampling or each raster's full extent.
     * @param {"selection"|"whole"} choice Area source. @return {void}
     */
    chooseArea(choice) {
        if (this.areaChoice === choice) return;
        this.areaChoice = choice;
        this.updateAreaInputs();
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
     * @param {{visible?:boolean,plotId?:number}} change Visibility or destination plot.
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
        this.plots.push({ id: ++this.plotSerial, scale: "linear" });
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

    /** Change a plot's Y scale without changing its data or other plots.
     * @param {number} id Plot identity.
     * @param {"linear"|"log"} scale Axis scale. @return {void}
     */
    setPlotScale(id, scale) {
        const plot = this.plots.find(item => item.id === id);
        if (!plot || !["linear", "log"].includes(scale)) return;
        plot.scale = scale;
        this.render();
    }

    /** Present every statistic, keeping previous-area plots separate from current results. @return {void} */
    renderAreaStatistics() {
        const area = this.areaStatistics;
        const sources = this.orderedSources();
        /** Join one result set to plot order without mixing current and previous areas.
         * @param {Map<string,Object>} results Per-source calculation outcomes.
         * @param {{id:number,label:string,expression:string}} formula Statistic to match.
         * @return {Object[]} Ordered chart/table rows.
         */
        const rowsFor = (results, formula) => sources.map(source => {
            const result = results.get(source.key);
            const row = result?.job?.result?.rows.find(row => row.label === "stat-" + formula.id);
            const sameFormula = result?.calculationInputs.calculations.some(item => item.label === "stat-" + formula.id && item.expression === formula.expression.trim());
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
            active: this.active, mode: "area", area: { formulas: this.formulas, sources: area.sources, areaChoice: this.areaChoice,
                area: area.area, areaLabel: area.areaLabel, results: area.results, complete: area.complete,
                recoverable: area.needsRecovery, hasErrors: area.hasErrors,
                elapsedSeconds: area.elapsedSeconds }, statistics, plots: this.plots,
            sources: this.sources.map(source => ({ ...source, selected: this.selectedKeys.has(source.key) })),
            rows, previousRows: showingPrevious ? statistics.flatMap(statistic => statistic.previousRows) : null,
            showingPrevious, busy: area.busy, chartType: this.chartType,
            message: area.results.size + " of " + sources.length + " rasters complete. " + area.message,
            canDownload: area.results.size > 0 && !area.busy, canRetry: false,
        });
    }

    /** Export every statistic with its exact scalar text, unit, source and area provenance.
     * @return {string} CSV document, or an empty string before results are available.
     */
    exportAreaCsv() {
        const area = this.areaStatistics;
        if (area.busy || !area.results.size) return "";
        const lines = [["raster", "collection_id", "item_id", "statistic", "formula", "value", "unit", "status", "error", "area", "job_id", "cached"]];
        for (const source of this.orderedSources()) {
            const result = area.results.get(source.key);
            for (const formula of this.formulas) {
                const row = result?.job?.result?.rows.find(row => row.label === "stat-" + formula.id);
                // Values are validated decimal strings from Processing, not user text.
                const scalar = row?.value == null ? "" : { scalar: row.value };
                lines.push([source.label, source.item.collection, source.item.id, formula.label, formula.expression,
                    scalar, row?.unit ?? "", row?.state ?? (result?.error ? "error" : "waiting"), result?.error ?? "",
                    JSON.stringify(result?.calculationInputs.area ?? (this.areaChoice === "whole" ? {kind:"wholeRaster"} : area.area)),
                    result?.job?.jobId ?? "", result?.job?.result?.cacheHit ? "true" : "false"]);
            }
        }
        return lines.map(line => line.map(value => typeof value === "object" && value !== null ? '"' + value.scalar + '"' : csvField(value)).join(",")).join("\r\n") + "\r\n";
    }

}
