/** Plot cards and legends for area statistics; calculation state stays with the controller. */
import { formatSeriesNumber, renderOrdinalSeriesChart } from "../charts/series-chart.js";

// The calculator accepts at most five formulas per raster. The controller
// assigns each active formula one of these five styles and reuses a freed style
// when a formula is removed; a growing formula ID is not a palette index.
const STATISTIC_STYLES = Object.freeze([
    { color: "#0072b2", dash: "none", marker: "circle", symbol: "●" },
    { color: "#d55e00", dash: "7 3", marker: "square", symbol: "■" },
    { color: "#009e73", dash: "2 3", marker: "diamond", symbol: "◆" },
    { color: "#b34a91", dash: "9 3 2 3", marker: "triangle", symbol: "▲" },
    { color: "#947000", dash: "12 4", marker: "cross", symbol: "+" },
]);

/** Create the same color, dash and marker sample used by a statistic's plot.
 * @param {Document} documentContext Owning document.
 * @param {number} styleIndex Controller-assigned index from 0 to 4, stable for the statistic's lifetime.
 * @return {SVGElement} Decorative legend sample; its containing control supplies the name.
 */
export function createStatisticSwatch(documentContext, styleIndex) {
    const style = STATISTIC_STYLES[styleIndex];
    const svg = documentContext.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 40 18");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("raster-statistic-swatch");
    const line = documentContext.createElementNS(svg.namespaceURI, "line");
    for (const [key, value] of Object.entries({ x1: 1, x2: 39, y1: 9, y2: 9, stroke: style.color, "stroke-width": 2, "stroke-dasharray": style.dash })) line.setAttribute(key, String(value));
    const marker = documentContext.createElementNS(svg.namespaceURI, "text");
    for (const [key, value] of Object.entries({ x: 20, y: 13, fill: style.color, "text-anchor": "middle", "font-size": 14 })) marker.setAttribute(key, String(value));
    marker.textContent = style.symbol;
    svg.append(line, marker);
    return svg;
}

/** Render independent plots of already calculated statistics. */
export class RasterSeriesPlotsView {
    /** Connect the plot container to presentation-only actions.
     * @param {Document} documentContext Owning document.
     * @param {{onRemovePlot:(id:number)=>void,onPlotScale:(id:number,scale:string)=>void}} actions Plot controls.
     */
    constructor(documentContext, actions) {
        this.document = documentContext;
        this.container = documentContext.querySelector("#raster-series-plots");
        this.actions = actions;
        this.cards = new Map();
    }

    /** Create a plot's controls once so result updates preserve focus and scroll position.
     * @param {{id:number,scale:string}} plot Plot settings.
     * @return {Object} Card elements and its last drawn data signature.
     */
    createPlotCard(plot) {
        const card = this.document.createElement("section");
        card.className = "raster-series-plot";
        card.setAttribute("aria-label", `Plot ${plot.id}`);
        const header = this.document.createElement("div"); header.className = "raster-series-plot-header";
        const title = this.document.createElement("strong"); title.textContent = `Plot ${plot.id}`;
        const label = this.document.createElement("label"); label.textContent = "Y axis ";
        const scale = this.document.createElement("select"); scale.setAttribute("aria-label", `Plot ${plot.id} Y axis`);
        for (const value of ["linear", "log"]) {
            const option = this.document.createElement("option"); option.value = value; option.textContent = value === "log" ? "Log" : "Linear"; scale.append(option);
        }
        scale.addEventListener("change", () => this.actions.onPlotScale(plot.id, scale.value));
        label.append(scale); header.append(title, label);
        if (plot.id !== 1) {
            const remove = this.document.createElement("button"); remove.type = "button"; remove.className = "secondary-button"; remove.textContent = "×";
            remove.setAttribute("aria-label", `Remove Plot ${plot.id}; move statistics to Plot 1`);
            remove.title = "Remove plot; move statistics to Plot 1";
            remove.addEventListener("click", () => this.actions.onRemovePlot(plot.id)); header.append(remove);
        }
        const legend = this.document.createElement("div"); legend.className = "raster-series-legend";
        const note = this.document.createElement("p"); note.className = "raster-series-plot-note";
        const chart = this.document.createElementNS("http://www.w3.org/2000/svg", "svg");
        chart.classList.add("raster-series-statistics-chart"); chart.setAttribute("role", "group");
        const empty = this.document.createElement("p"); empty.className = "raster-series-empty-plot";
        const tooltip = this.document.createElement("div"); tooltip.className = "raster-series-plot-tooltip"; tooltip.hidden = true;
        card.append(header, legend, note, chart, empty, tooltip);
        this.container.append(card);
        return { card, scale, legend, note, chart, empty, tooltip, signature: null };
    }

    /** Add or remove plot cards and refresh those whose settings or results changed.
     * All cards use the same current or previous calculation results. Each card
     * is passed to renderPlot() only when its displayed content needs updating.
     * @param {Object} state Series view snapshot.
     * @param {{id:number,scale:string}[]} state.plots Plot settings.
     * @param {Object[]} state.statistics Formulas, display settings and ordered result rows.
     * @param {boolean} state.showingPrevious Whether every plot uses the previous area.
     * @param {"line"|"scatter"} state.chartType Plot geometry.
     * @return {void}
     */
    renderPlots(state) {
        for (const [id, elements] of this.cards) {
            if (state.plots.some(plot => plot.id === id)) continue;
            const hadFocus = elements.card.contains(this.document.activeElement);
            elements.card.remove(); this.cards.delete(id);
            if (hadFocus) this.document.querySelector("#raster-series-add-plot").focus();
        }
        for (const plot of state.plots) {
            if (!this.cards.has(plot.id)) this.cards.set(plot.id, this.createPlotCard(plot));
            const elements = this.cards.get(plot.id);
            elements.scale.value = plot.scale;
            const statistics = state.statistics.filter(statistic => statistic.plotId === plot.id && statistic.visible);
            const series = statistics.map(statistic => ({
                id: String(statistic.id), label: `${statistic.label || "Custom statistic"} · ${statistic.expression}`,
                ...STATISTIC_STYLES[statistic.styleIndex],
                points: (state.showingPrevious ? statistic.previousRows : statistic.rows).map(row => ({
                    xLabel: row.label, yValue: row.state === "value" ? row.value : null, rawValue: row.rawValue, unit: row.unit,
                })),
            }));
            // Only chart inputs belong here: progress and catalog metadata do not change a figure.
            const signature = JSON.stringify([plot.scale, state.chartType, state.showingPrevious, series]);
            if (elements.signature === signature) continue;
            elements.signature = signature;
            this.renderPlot(elements, plot, statistics, state, series);
        }
    }

    /** Update one existing plot card's chart, legend, value details and empty-state message.
     * Values its scale cannot represent stay in the result table and CSV.
     * @param {Object} elements Retained card elements.
     * @param {{id:number,scale:string}} plot Plot settings.
     * @param {Object[]} statistics Visible statistics assigned to this plot.
     * @param {{showingPrevious:boolean,chartType:string}} state Current presentation settings.
     * @param {import("../charts/series-chart.js").ChartSeries[]} series Chart-only observations and styles.
     * @return {void}
     */
    renderPlot(elements, plot, statistics, state, series) {
        const { chart, tooltip, legend, note, empty } = elements;
        const focused = this.document.activeElement;
        const hadChartFocus = chart.contains(focused);
        const focusSeries = focused?.closest?.("[data-series-id]")?.getAttribute("data-series-id");
        const focusPoint = focused?.getAttribute?.("data-point-index");
        const focusLegend = legend.contains(focused) ? focused?.dataset?.statisticId : null;
        chart.replaceChildren(); legend.replaceChildren(); tooltip.hidden = true;
        const values = series.flatMap(item => item.points).filter(point => Number.isFinite(point.yValue));
        const units = [...new Set(values.map(point => point.unit || "unit unspecified"))];
        const excluded = plot.scale === "log" ? values.filter(point => point.yValue <= 0).length : 0;
        const unitsText = units.length > 1 ? `Mixed units: ${units.join(", ")}. Assign statistics to separate plots if needed.`
            : units[0] === "unit unspecified" ? "Units are not specified by these formulas."
            : units.length ? `Values in ${units[0]}.` : "";
        note.textContent = [unitsText, excluded ? `Log scale omits ${excluded} zero or negative ${excluded === 1 ? "value" : "values"}; see the table or CSV.` : ""].filter(Boolean).join(" ");
        for (const statistic of statistics) {
            const button = this.document.createElement("button"); button.type = "button";
            button.dataset.statisticId = String(statistic.id); button.className = "raster-series-legend-item";
            button.setAttribute("aria-label", `Highlight ${statistic.label || statistic.expression}`);
            button.append(createStatisticSwatch(this.document, statistic.styleIndex));
            const name = this.document.createElement("span"); name.textContent = statistic.label || statistic.expression || "Custom statistic"; button.append(name);
            for (const event of ["pointerenter", "focus"]) button.addEventListener(event, () => this.highlightStatistic(statistic.id));
            for (const event of ["pointerleave", "blur"]) button.addEventListener(event, () => this.highlightStatistic(null));
            legend.append(button);
        }
        chart.classList.toggle("is-previous", state.showingPrevious);
        chart.hidden = !values.some(point => plot.scale !== "log" || point.yValue > 0);
        if (chart.hidden) chart.setAttribute("hidden", "");
        empty.hidden = !chart.hidden;
        empty.textContent = !statistics.length ? "Choose this plot beside a statistic to show it here."
            : excluded && excluded === values.length ? "No positive values to plot. Choose Linear to see these results."
            : "Waiting for statistic values.";
        if (!chart.hidden) renderOrdinalSeriesChart({
            documentContext: this.document, chart, series, chartType: state.chartType, yScale: plot.scale,
            xAxisLabel: "Raster", yAxisLabel: (units.length === 1 && units[0] !== "unit unspecified" ? units[0] : "Value") + (plot.scale === "log" ? " (log)" : ""),
            ariaLabel: `Plot ${plot.id}${state.showingPrevious ? "; previous results" : ""}: ${series.map(item => item.label).join("; ")}`,
            pointAccessibleLabel: (point, item, index) => this.describePoint(series, index, plot.scale, state.showingPrevious),
            onInspect: inspection => {
                tooltip.hidden = inspection === null;
                tooltip.textContent = !inspection ? "" : inspection.point
                    ? this.describePoint(series, inspection.index, plot.scale, state.showingPrevious)
                    : `${state.showingPrevious ? "Previous results\n" : ""}${inspection.series.label}`;
                this.highlightStatistic(inspection ? Number(inspection.series.id) : null);
            },
        });
        if (hadChartFocus && focusSeries) {
            // Replaced SVG nodes lose focus. Restore the same observation only in this plot.
            const selector = focusPoint !== null ? `[data-series-id="${focusSeries}"] [data-point-index="${focusPoint}"]` : `[data-series-line="${focusSeries}"]`;
            chart.querySelector(selector)?.focus({ preventScroll: true });
        }
        if (focusLegend) legend.querySelector(`[data-statistic-id="${focusLegend}"]`)?.focus({ preventScroll: true });
    }

    /** Describe all visible, plottable statistics at a raster position, including overlaps.
     * @param {Object[]} series Drawn series and exact scalar strings.
     * @param {number} index Shared raster position.
     * @param {string} scale Plot's Y scale.
     * @param {boolean} previous Whether these values belong to the previous area.
     * @return {string} Multiline tooltip and keyboard-accessible text.
     */
    describePoint(series, index, scale, previous) {
        return [previous ? "Previous results" : "", series[0].points[index].xLabel,
            ...series.filter(item => Number.isFinite(item.points[index].yValue) && (scale !== "log" || item.points[index].yValue > 0)).map(item => {
                const point = item.points[index];
                return `${item.label}: ${point.rawValue ?? formatSeriesNumber(point.yValue)}${point.unit ? " " + point.unit : ""}`;
            })].filter(Boolean).join("\n");
    }

    /** Emphasize a statistic wherever it is drawn; other plots keep their usual contrast.
     * @param {number|null} id Statistic identity, or null to clear highlighting.
     * @return {void}
     */
    highlightStatistic(id) {
        for (const { chart } of this.cards.values()) {
            const groups = [...chart.querySelectorAll("[data-series-id]")];
            const present = groups.some(group => group.getAttribute("data-series-id") === String(id));
            for (const group of groups) group.classList.toggle("is-muted", present && group.getAttribute("data-series-id") !== String(id));
        }
    }
}
