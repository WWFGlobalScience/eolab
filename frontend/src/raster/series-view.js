/** Controls and chart presentation for raster pixel and area series. */
import { formatSeriesNumber, renderOrdinalSeriesChart } from "../charts/series-chart.js";
import { createStatisticSwatch, RasterSeriesPlotsView } from "./series-plots-view.js";

const STATES = { waiting: "Not sampled", loading: "Reading…", nodata: "No data", outside: "Outside raster", error: "Unavailable", no_matches: "No matches", no_valid_data: "No valid data", invalid_arithmetic: "Invalid arithmetic", overflow: "Overflow" };

/** Display Raster series without accessing map, renderer or request state. */
export class RasterSeriesView {
    /**
     * Find the plot's existing markup.
     * @param {Document} [documentContext=document] Owning browser document.
     */
    constructor(documentContext = document) {
        this.document = documentContext;
        this.root = documentContext.querySelector("#raster-series");
        this.context = documentContext.querySelector("#raster-series-context");
        this.status = documentContext.querySelector("#raster-series-status");
        this.sources = documentContext.querySelector("#raster-series-sources");
        this.sourceSummary = documentContext.querySelector("#raster-series-source-summary");
        this.chart = documentContext.querySelector("#raster-series-chart");
        this.chartNote = documentContext.querySelector("#raster-series-chart-note");
        this.table = documentContext.querySelector("#raster-series-table-body");
        this.download = documentContext.querySelector("#raster-series-download");
        this.retry = documentContext.querySelector("#raster-series-retry");
        this.sourceSignature = null;
        this.areaControls = documentContext.querySelector("#raster-series-area-controls");
        this.formulaRows = documentContext.querySelector("#raster-series-formulas");
    }

    /**
     * Connect controls to the series owner.
     * @param {Object} actions User actions.
     * @param {()=>void} actions.onClose Close the plot.
     * @param {(key:string,selected:boolean)=>void} actions.onSelect Change a raster choice.
     * @param {(order:string,direction:string)=>void} actions.onOrder Change plot order.
     * @param {(type:string)=>void} actions.onChartType Change line/scatter presentation.
     * @param {()=>void} actions.onRetry Retry the selected pixels.
     * @param {()=>void} actions.onDownload Download the current values.
     * @param {(mode:string)=>void} actions.onMode Pixel or area statistics.
     * @param {(choice:string)=>void} actions.onArea Sampling area or whole raster.
     * @param {()=>void} actions.onEditArea Open existing area controls.
     * @param {(preset:string)=>void} actions.onAddFormula Add statistic.
     * @param {(id:number,change:Object)=>void} actions.onEditFormula Update formula/name.
     * @param {(id:number)=>void} actions.onRemoveFormula Remove statistic.
     * @param {(id:number,change:{visible?:boolean,plotId?:number})=>void} actions.onStatisticDisplay Change visibility or plot assignment.
     * @param {()=>void} actions.onAddPlot Add a linear plot.
     * @param {(id:number)=>void} actions.onRemovePlot Remove a secondary plot.
     * @param {(id:number,scale:string)=>void} actions.onPlotScale Change one Y scale.
     * @param {()=>void} actions.onCalculate Calculate remaining sources.
     * @param {()=>void} actions.onCancel Cancel remaining work.
     * @param {()=>void} actions.onRecover Recover uncertain submission.
     * @return {void}
     */
    bind(actions) {
        this.actions = actions;
        this.plotsView = new RasterSeriesPlotsView(this.document, actions);
        this.document.querySelector("#close-raster-series").addEventListener("click", actions.onClose);
        const order = this.document.querySelector("#raster-series-order");
        const direction = this.document.querySelector("#raster-series-direction");
        for (const input of [order, direction]) input.addEventListener("change", () => actions.onOrder(order.value, direction.value));
        this.document.querySelector("#raster-series-chart-type").addEventListener("change", event => actions.onChartType(event.target.value));
        this.download.addEventListener("click", actions.onDownload);
        this.retry.addEventListener("click", actions.onRetry);
        for (const [id, action] of [["mode", actions.onMode], ["area", actions.onArea]]) {
            this.document.querySelector("#raster-series-" + id).addEventListener("change", event => action(event.target.value));
        }
        this.document.querySelector("#raster-series-add-formula").addEventListener("change", event => {
            actions.onAddFormula(event.target.value); event.target.value = "";
        });
        this.document.querySelector("#raster-series-add-plot").addEventListener("click", actions.onAddPlot);
        for (const [id, action] of [["edit-area", actions.onEditArea], ["calculate", actions.onCalculate],
            ["cancel", actions.onCancel], ["recover", actions.onRecover]]) {
            this.document.querySelector("#raster-series-" + id).addEventListener("click", action);
        }
    }

    /**
     * Refresh values while preserving keyboard focus and the raster checklist disclosure.
     * @param {Object} state Plot presentation.
     * @param {Object[]} state.sources Available rasters with their selected flag.
     * @param {Object[]} state.rows Ordered current pixel or statistic results.
     * @param {Object[]|null} state.previousRows Previous input's rows while no new value has arrived.
     * @param {{longitude:number,latitude:number}|null} state.position Current click.
     * @param {string} state.message Progress, guidance or result summary.
     * @param {boolean} state.busy Whether the current workflow is still running.
     * @param {"line"|"scatter"} state.chartType Plot geometry.
     * @param {boolean} state.canDownload Whether a completed table can be exported.
     * @param {boolean} state.canRetry Whether the current selection can be sampled.
     * @param {"pixel"|"area"} state.mode Series mode.
     * @param {Object} [state.area] Area calculation presentation.
     * @param {Object[]} [state.statistics] All statistics with ordered rows and display settings.
     * @param {{id:number,scale:string}[]} [state.plots] Independent plot settings.
     * @param {boolean} [state.showingPrevious] Whether all area charts use previous results.
     * @return {void}
     */
    render(state) {
        const areaMode = state.mode === "area";
        this.areaControls.hidden = !areaMode;
        this.document.querySelector("#raster-series-mode").value = state.mode ?? "pixel";
        this.retry.hidden = areaMode;
        if (!areaMode) this.status.classList.remove("raster-series-confirmation");
        this.document.querySelector("#raster-series-value-heading").textContent = areaMode ? "Value" : "Pixel value";
        this.document.querySelector("#raster-series-statistic-heading").hidden = !areaMode;
        this.document.querySelector("#raster-series-plots").hidden = !areaMode;
        this.document.querySelector("#raster-series-add-plot").hidden = !areaMode;
        if (areaMode) this.renderAreaControls(state);
        this.context.textContent = areaMode ? (state.area.areaChoice === "whole" ? "Whole extent of each raster" : state.area.areaLabel || "No sampling area selected") : state.position
            ? `Pixel values at ${state.position.latitude.toFixed(5)}, ${state.position.longitude.toFixed(5)}`
            : "Pixel values across raster layers";
        this.status.textContent = state.message;
        this.root.setAttribute("aria-busy", String(state.busy));
        this.sourceSummary.textContent = `Rasters · ${state.sources.filter(source => source.selected).length} selected`;
        const signature = JSON.stringify(state.sources.map(({ key, label, selected }) => [key, label, selected]));
        if (signature !== this.sourceSignature) {
            this.sourceSignature = signature;
            const focusedKey = this.document.activeElement?.dataset?.rasterKey;
            this.sources.replaceChildren(...state.sources.map(source => {
                const label = this.document.createElement("label");
                const checkbox = this.document.createElement("input");
                checkbox.type = "checkbox"; checkbox.checked = source.selected;
                checkbox.dataset.rasterKey = source.key;
                checkbox.addEventListener("change", () => this.actions.onSelect(source.key, checkbox.checked));
                const name = this.document.createElement("span"); name.textContent = source.label;
                label.append(checkbox, name);
                return label;
            }));
            if (focusedKey) {
                for (const input of this.sources.querySelectorAll("input")) {
                    if (input.dataset.rasterKey === focusedKey) input.focus({ preventScroll: true });
                }
            }
        }
        this.chart.replaceChildren();
        const plottedRows = state.previousRows?.some(row => row.state === "value") ? state.previousRows : state.rows;
        const showingPrevious = areaMode ? state.showingPrevious : plottedRows === state.previousRows;
        this.chart.classList.toggle("is-previous", showingPrevious);
        this.chartNote.hidden = !showingPrevious;
        this.chartNote.textContent = showingPrevious ? (areaMode ? "Previous results — calculating replacements." : "Previous plot — reading the new click.") : "";
        this.chart.hidden = areaMode || !plottedRows.some(row => row.state === "value");
        if (this.chart.hidden) this.chart.setAttribute("hidden", "");
        if (areaMode) this.plotsView.renderPlots(state);
        if (!this.chart.hidden) {
            renderOrdinalSeriesChart({
                documentContext: this.document, chart: this.chart,
                points: plottedRows.map(row => ({ xLabel: row.label, yValue: row.state === "value" ? row.value : null })),
                chartType: state.chartType, xAxisLabel: "Raster", yAxisLabel: "Pixel value",
                ariaLabel: showingPrevious ? "Previous raster series; replacements are pending" : "Pixel values across selected rasters",
                pointAccessibleLabel: point => `${point.xLabel}: ${formatSeriesNumber(point.yValue)}`,
                pointTooltip: point => `${point.xLabel}\nPixel value: ${formatSeriesNumber(point.yValue)}`,
            });
        }
        this.table.replaceChildren(...state.rows.map(row => {
            const tr = this.document.createElement("tr");
            for (const value of [row.label, ...(areaMode ? [row.statisticLabel] : []), row.state === "value" ? (row.rawValue ?? formatSeriesNumber(row.value)) + (row.unit ? " " + row.unit : "") : "-",
                row.errorMessage || (row.state === "value" ? (row.cached ? "Cached" : "Value") : STATES[row.state])]) {
                const cell = this.document.createElement("td"); cell.textContent = value; tr.append(cell);
            }
            return tr;
        }));
        this.download.disabled = !state.canDownload;
        this.retry.disabled = !state.canRetry;
    }


    /** Update formula controls without replacing focused inputs during progress.
     * @param {Object} state Area-series presentation. @return {void}
     */
    renderAreaControls(state) {
        const area = state.area;
        const signature = area.formulas.map(formula => formula.id).join(",");
        if (this.formulaSignature !== signature) {
            this.formulaSignature = signature;
            this.formulaRows.replaceChildren(...state.statistics.map(formula => {
                const row = this.document.createElement("div"); row.className = "raster-series-formula";
                row.dataset.formulaId = String(formula.id);
                const legend = this.document.createElement("label"); legend.className = "raster-series-formula-legend";
                const visible = this.document.createElement("input"); visible.type = "checkbox"; visible.dataset.field = "visible";
                visible.addEventListener("change", () => this.actions.onStatisticDisplay(formula.id, { visible: visible.checked }));
                legend.append(visible, createStatisticSwatch(this.document, formula.styleIndex)); row.append(legend);
                for (const event of ["pointerenter", "focusin"]) legend.addEventListener(event, () => this.plotsView.highlightStatistic(formula.id));
                for (const event of ["pointerleave", "focusout"]) legend.addEventListener(event, () => this.plotsView.highlightStatistic(null));
                for (const [field, label, limit] of [["label", "Statistic name", 80], ["expression", "Formula", 4096]]) {
                    const input = this.document.createElement("input");
                    input.dataset.field = field; input.setAttribute("aria-label", label); input.placeholder = label; input.maxLength = limit;
                    input.addEventListener("input", () => this.actions.onEditFormula(formula.id, { [field]: input.value }));
                    row.append(input);
                }
                const plot = this.document.createElement("select"); plot.dataset.field = "plotId";
                plot.addEventListener("change", () => this.actions.onStatisticDisplay(formula.id, { plotId: Number(plot.value) }));
                row.append(plot);
                const remove = this.document.createElement("button"); remove.type = "button"; remove.textContent = "×";
                remove.setAttribute("aria-label", "Remove statistic"); remove.className = "secondary-button";
                remove.disabled = area.formulas.length === 1;
                remove.addEventListener("click", () => this.actions.onRemoveFormula(formula.id));
                row.append(remove); return row;
            }));
        }
        for (const row of this.formulaRows.children) {
            const formula = state.statistics.find(item => item.id === Number(row.dataset.formulaId));
            const name = formula.label || formula.expression || "Custom statistic";
            for (const input of row.querySelectorAll("input")) {
                if (input.dataset.field === "visible") {
                    input.checked = formula.visible; input.setAttribute("aria-label", `Show ${name} on plot`);
                } else if (input !== this.document.activeElement) input.value = formula[input.dataset.field];
            }
            const plot = row.querySelector("select");
            const plotsKey = state.plots.map(item => item.id).join(",");
            if (plot.dataset.optionsKey !== plotsKey) {
                plot.dataset.optionsKey = plotsKey;
                plot.replaceChildren(...state.plots.map(item => {
                    const option = this.document.createElement("option"); option.value = String(item.id);
                    option.textContent = `Plot ${item.id}`; return option;
                }));
            }
            plot.setAttribute("aria-label", `Plot for ${name}`); plot.value = String(formula.plotId);
        }
        this.document.querySelector("#raster-series-area").value = area.areaChoice;
        this.document.querySelector("#raster-series-add-formula").disabled = area.formulas.length >= 5;
        const calculate = this.document.querySelector("#raster-series-calculate");
        calculate.disabled = (state.busy && !area.confirmation) || !area.sources.length || (area.areaChoice !== "whole" && !area.area);
        calculate.hidden = area.complete && !area.hasErrors;
        calculate.textContent = area.confirmation ? "Calculate remaining " + (area.sources.length - area.results.size) + " rasters" : "Calculate";
        this.document.querySelector("#raster-series-cancel").hidden = !state.busy;
        this.document.querySelector("#raster-series-recover").hidden = !area.recoverable;
        this.status.classList.toggle("raster-series-confirmation", area.confirmation);
        const performance = this.document.querySelector("#raster-series-performance");
        const completedKey = JSON.stringify([area.elapsedSeconds, [...area.results].map(([key, result]) => [key, result.job?.jobId, result.error])]);
        if (this.performanceKey !== completedKey) {
            this.performanceKey = completedKey;
            performance.replaceChildren(...[...area.results].filter(([,result]) => result.job).map(([key, result]) => {
                const details = this.document.createElement("details");
                const summary = this.document.createElement("summary");
                summary.textContent = (area.sources.find(source => source.key === key)?.label ?? key) + " — " + result.elapsedSeconds.toFixed(3) + " s";
                details.append(summary);
                for (const line of result.performanceLines) {
                    const p = this.document.createElement("p"); p.textContent = line; details.append(p);
                }
                return details;
            }));
            if (area.elapsedSeconds != null) {
                const total = this.document.createElement("p");
                total.textContent = "Whole series: " + area.elapsedSeconds.toFixed(3) +
                    " s from requesting the series to the last result or error, including debounce, validation and any confirmation or recovery pauses.";
                performance.prepend(total);
            }
        }
    }

    /**
     * Download the completed table as a UTF-8 CSV file.
     * @param {string} csv CSV content supplied by the series owner.
     * @return {void}
     */
    downloadCsv(csv) {
        if (!csv) return;
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const link = this.document.createElement("a");
        link.href = url; link.download = "raster-series.csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}
