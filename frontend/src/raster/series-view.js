/** Controls and chart presentation for raster formula series. */
import { formatSeriesNumber } from "../charts/series-chart.js";
import { createStatisticSwatch, RasterSeriesPlotsView } from "./series-plots-view.js";

const STATES = { waiting: "Waiting", error: "Unavailable", no_matches: "No matches", no_valid_data: "No valid data", invalid_arithmetic: "Invalid arithmetic", overflow: "Overflow" };

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
        this.chartNote = documentContext.querySelector("#raster-series-chart-note");
        this.table = documentContext.querySelector("#raster-series-table-body");
        this.download = documentContext.querySelector("#raster-series-download");
        this.sourceSignature = null;
        this.formulaRows = documentContext.querySelector("#raster-series-formulas");
        this.frame = null;
        this.pendingState = null;
        this.timingReports = new Map();
    }

    /**
     * Connect controls to the series owner.
     * @param {Object} actions User actions.
     * @param {()=>void} actions.onClose Close the plot.
     * @param {(key:string,selected:boolean)=>void} actions.onSelect Change a raster choice.
     * @param {(order:string,direction:string)=>void} actions.onOrder Change plot order.
     * @param {(type:string)=>void} actions.onChartType Change line/scatter presentation.
     * @param {()=>void} actions.onDownload Download the current values.
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
        this.document.querySelector("#raster-series-area").addEventListener("change", event => actions.onArea(event.target.value));
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
     * Schedule the latest presentation for a browser frame, without drawing in a result callback.
     * Multiple updates before that frame replace its pending snapshot. Results
     * remain in the controller; intermediate drawings may be skipped. Closing
     * the panel cancels pending drawing, and reopening supplies current state.
     * @param {Object} state Plot presentation.
     * @param {boolean} state.active Whether the series panel is open.
     * @param {Object[]} state.sources Available rasters with their selected flag.
     * @param {Object[]} state.rows Ordered current statistic results.
     * @param {Object[]|null} state.previousRows Previous input's rows while no new value has arrived.
     * @param {string} state.message Progress, guidance or result summary.
     * @param {boolean} state.busy Whether the current workflow is still running.
     * @param {"line"|"scatter"} state.chartType Plot geometry.
     * @param {boolean} state.canDownload Whether a completed table can be exported.
     * @param {Object} state.area Area calculation presentation.
     * @param {Object[]} state.statistics All statistics with ordered rows and display settings.
     * @param {{id:number,scale:string}[]} state.plots Independent plot settings.
     * @param {boolean} state.showingPrevious Whether all charts use previous results.
     * @return {void}
     */
    render(state) {
        this.pendingState = state;
        if (!state.active) {
            if (this.frame !== null) this.document.defaultView.cancelAnimationFrame(this.frame);
            this.frame = null;
            this.pendingState = null;
            return;
        }
        if (this.frame !== null) return;
        this.frame = this.document.defaultView.requestAnimationFrame(() => {
            this.frame = null;
            const latest = this.pendingState;
            this.pendingState = null;
            this.draw(latest);
        });
    }

    /** Update changed controls and figures from one coalesced snapshot.
     * Unchanged presentation leaves existing DOM nodes and attributes intact.
     * @param {Object} state Latest presentation supplied to render().
     * @return {void}
     */
    draw(state) {
        this.renderAreaControls(state);
        const context = state.area.areaChoice === "whole" ? "Whole extent of each raster" : state.area.areaLabel || "No sampling area selected";
        if (this.context.textContent !== context) this.context.textContent = context;
        if (this.status.textContent !== state.message) this.status.textContent = state.message;
        const busy = String(state.busy);
        if (this.root.getAttribute("aria-busy") !== busy) this.root.setAttribute("aria-busy", busy);
        const sourceCount = `Rasters · ${state.sources.filter(source => source.selected).length} selected`;
        if (this.sourceSummary.textContent !== sourceCount) this.sourceSummary.textContent = sourceCount;
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
        const showingPrevious = state.showingPrevious;
        if (this.chartNote.hidden !== !showingPrevious) this.chartNote.hidden = !showingPrevious;
        const chartNote = showingPrevious ? "Previous results — calculating replacements." : "";
        if (this.chartNote.textContent !== chartNote) this.chartNote.textContent = chartNote;
        this.plotsView.renderPlots(state);
        const tableValues = state.rows.map(row => [row.label, row.statisticLabel,
            row.state === "value" ? (row.rawValue ?? formatSeriesNumber(row.value)) + (row.unit ? " " + row.unit : "") : "-",
            row.errorMessage || (row.state === "value" ? (row.cached ? "Cached" : "Value") : STATES[row.state])]);
        const tableSignature = JSON.stringify(tableValues);
        if (this.tableSignature !== tableSignature) {
            this.tableSignature = tableSignature;
            this.table.replaceChildren(...tableValues.map(values => {
                const tr = this.document.createElement("tr");
                for (const value of values) {
                    const cell = this.document.createElement("td"); cell.textContent = value; tr.append(cell);
                }
                return tr;
            }));
        }
        if (this.download.disabled !== !state.canDownload) this.download.disabled = !state.canDownload;
    }


    /** Update changed formula controls while preserving focused edits and timing disclosures.
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
                    if (input.checked !== formula.visible) input.checked = formula.visible;
                    const label = `Show ${name} on plot`;
                    if (input.getAttribute("aria-label") !== label) input.setAttribute("aria-label", label);
                } else if (input !== this.document.activeElement && input.value !== formula[input.dataset.field]) input.value = formula[input.dataset.field];
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
            const label = `Plot for ${name}`;
            if (plot.getAttribute("aria-label") !== label) plot.setAttribute("aria-label", label);
            if (plot.value !== String(formula.plotId)) plot.value = String(formula.plotId);
        }
        const areaChoice = this.document.querySelector("#raster-series-area");
        if (areaChoice.value !== area.areaChoice) areaChoice.value = area.areaChoice;
        const addFormula = this.document.querySelector("#raster-series-add-formula");
        if (addFormula.disabled !== (area.formulas.length >= 5)) addFormula.disabled = area.formulas.length >= 5;
        const calculate = this.document.querySelector("#raster-series-calculate");
        const cannotCalculate = state.busy || !area.sources.length || (area.areaChoice !== "whole" && !area.area);
        if (calculate.disabled !== cannotCalculate) calculate.disabled = cannotCalculate;
        const hideCalculate = !!area.complete && !area.hasErrors;
        if (calculate.hidden !== hideCalculate) calculate.hidden = hideCalculate;
        if (calculate.textContent !== "Calculate") calculate.textContent = "Calculate";
        const cancel = this.document.querySelector("#raster-series-cancel");
        if (cancel.hidden !== !state.busy) cancel.hidden = !state.busy;
        const recover = this.document.querySelector("#raster-series-recover");
        if (recover.hidden !== !area.recoverable) recover.hidden = !area.recoverable;
        const performance = this.document.querySelector("#raster-series-performance");
        for (const [key, report] of this.timingReports) {
            if (area.results.get(key) === report.result) continue;
            report.details.remove();
            this.timingReports.delete(key);
        }
        for (const [key, result] of area.results) {
            if (!result.job) continue;
            if (!this.timingReports.has(key)) {
                const details = this.document.createElement("details");
                const summary = this.document.createElement("summary");
                details.append(summary);
                for (const line of result.performanceLines) {
                    const p = this.document.createElement("p"); p.textContent = line; details.append(p);
                }
                performance.append(details);
                this.timingReports.set(key, { result, details, summary });
            }
            const summary = this.timingReports.get(key).summary;
            const text = (area.sources.find(source => source.key === key)?.label ?? key) + " — " + result.elapsedSeconds.toFixed(3) + " s";
            if (summary.textContent !== text) summary.textContent = text;
        }
        if (area.elapsedSeconds == null) {
            this.totalTiming?.remove();
            this.totalTiming = null;
        } else {
            if (!this.totalTiming) {
                this.totalTiming = this.document.createElement("p");
                performance.prepend(this.totalTiming);
            }
            const text = "Whole series: " + area.elapsedSeconds.toFixed(3) +
                " s from requesting the series to the last result or error, including debounce, validation and any recovery pauses.";
            if (this.totalTiming.textContent !== text) this.totalTiming.textContent = text;
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
