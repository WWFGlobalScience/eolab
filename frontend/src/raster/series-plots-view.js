/** Plot cards and legends for area statistics; calculation state stays with the controller. */
import { formatSeriesNumber, renderOrdinalSeriesChart } from "../charts/series-chart.js";
import { createChartTooltip } from "../charts/chart-presentation.js";

/** Default color and distinguishable dash/marker for each of the five statistics. */
// The calculator accepts at most five formulas per raster. The controller
// assigns each active formula one of these five styles and reuses a freed style
// when a formula is removed; a growing formula ID is not a palette index.
export const STATISTIC_STYLES = Object.freeze([
    { color: "#0072b2", dash: "none", marker: "circle", symbol: "●" },
    { color: "#d55e00", dash: "7 3", marker: "square", symbol: "■" },
    { color: "#009e73", dash: "2 3", marker: "diamond", symbol: "◆" },
    { color: "#b34a91", dash: "9 3 2 3", marker: "triangle", symbol: "▲" },
    { color: "#947000", dash: "12 4", marker: "cross", symbol: "+" },
]);

/** Create the same color, dash and marker sample used by a statistic's plot.
 * @param {Document} documentContext Owning document.
 * @param {number} styleIndex Controller-assigned index from 0 to 4, stable for the statistic's lifetime.
 * @param {string|null} [color=null] User-selected color, or the default style color.
 * @return {SVGElement} Decorative legend sample; its containing control supplies the name.
 */
export function createStatisticSwatch(documentContext, styleIndex, color = null) {
    const style = STATISTIC_STYLES[styleIndex];
    const svg = documentContext.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 40 18");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("raster-statistic-swatch");
    const line = documentContext.createElementNS(svg.namespaceURI, "line");
    for (const [key, value] of Object.entries({ x1: 1, x2: 39, y1: 9, y2: 9, stroke: color ?? style.color, "stroke-width": 2, "stroke-dasharray": style.dash })) line.setAttribute(key, String(value));
    const marker = documentContext.createElementNS(svg.namespaceURI, "text");
    for (const [key, value] of Object.entries({ x: 20, y: 13, fill: color ?? style.color, "text-anchor": "middle", "font-size": 14 })) marker.setAttribute(key, String(value));
    marker.textContent = style.symbol;
    svg.append(line, marker);
    return svg;
}

/**
 * @typedef {Object} RasterSeriesPlotCard
 * @property {HTMLElement} card Retained plot section.
 * @property {HTMLElement} title Plot heading.
 * @property {HTMLFieldSetElement} options Retained axis controls.
 * @property {import("./series-view.js").SeriesPresentation["plots"][number]} plot Current display options.
 * @property {HTMLSelectElement} scale Y-axis scale control.
 * @property {Record<"x"|"y",{group:HTMLDivElement,range:HTMLSelectElement,bounds:HTMLDivElement,fields:HTMLInputElement[]}>} axes Axis bounds controls.
 * @property {Record<string,HTMLInputElement>} appearance Tick, point and font controls.
 * @property {HTMLParagraphElement} error Axis-edit error message.
 * @property {HTMLDivElement} legend Statistic legend.
 * @property {HTMLParagraphElement} note Units and omitted-value explanation.
 * @property {SVGSVGElement} chart Current chart.
 * @property {HTMLParagraphElement} empty Non-calculating empty state.
 * @property {HTMLDivElement} pendingProgress Shared-job progress for this pending plot.
 * @property {HTMLParagraphElement} pendingDetail Current authoritative calculation message.
 * @property {HTMLProgressElement} pendingBar Measured shared-job progress.
 * @property {ReturnType<typeof createChartTooltip>} tooltip Chart inspection tooltip.
 * @property {string|null} signature Last chart-input signature.
 * @property {ReturnType<typeof renderOrdinalSeriesChart>} [domains] Last rendered chart domains.
 * @property {Record<"x"|"y",string>} [rangeModes] Retained automatic/custom bounds choices.
 */

/** Display statistic plots and their shared calculation's pending state. */
export class RasterSeriesPlotsView {
    /** Connect the plot container to presentation-only actions.
     * @param {Document} documentContext Owning document.
     * @param {{onRemovePlot:(id:number)=>void,onPlotOptions:(id:number,change:Object)=>void}} actions Plot controls; axis changes redraw retained results.
     */
    constructor(documentContext, actions) {
        this.document = documentContext;
        this.container = documentContext.querySelector("#raster-series-plots");
        this.axisOptions = documentContext.querySelector("#raster-series-plot-options");
        this.actions = actions;
        /** @type {Map<number,RasterSeriesPlotCard>} Plot-owned retained DOM and chart settings. */
        this.cards = new Map();
    }

    /** Create a plot's controls once so result updates preserve focus and scroll position.
     * @param {import("./series-view.js").SeriesPresentation["plots"][number]} plot Plot settings.
     * @return {RasterSeriesPlotCard} Retained controls, chart and pending-state elements.
     */
    createPlotCard(plot) {
        const plotLabel = `Plot ${plot.displayNumber}`;
        const card = this.document.createElement("section");
        card.className = "raster-series-plot";
        card.setAttribute("aria-label", plotLabel);
        const header = this.document.createElement("div"); header.className = "raster-series-plot-header";
        const title = this.document.createElement("strong"); title.textContent = plotLabel;
        const options = this.document.createElement("fieldset"); options.className = "raster-series-axis-options";
        const caption = this.document.createElement("legend"); caption.textContent = plotLabel;
        options.append(caption); this.axisOptions.append(options);
        const label = this.document.createElement("label"); label.textContent = "Y scale ";
        const scale = this.document.createElement("select"); scale.setAttribute("aria-label", `${plotLabel} Y axis`);
        for (const value of ["linear", "log"]) {
            const option = this.document.createElement("option"); option.value = value; option.textContent = value === "log" ? "Log" : "Linear"; scale.append(option);
        }
        label.append(scale); options.append(label); header.append(title);
        const axes = {};
        for (const axis of ["x", "y"]) {
            const group = this.document.createElement("div"); group.className = "raster-series-axis-range";
            const rangeLabel = this.document.createElement("label"); rangeLabel.textContent = axis === "x" ? "Time (UTC) " : "Y bounds ";
            const range = this.document.createElement("select"); range.setAttribute("aria-label", `${plotLabel} ${axis.toUpperCase()} bounds`);
            for (const [value, text] of [["auto", "Automatic"], ["custom", "Custom"]]) {
                const option = this.document.createElement("option"); option.value = value; option.textContent = text; range.append(option);
            }
            range.value = "auto"; rangeLabel.append(range);
            const bounds = this.document.createElement("div"); bounds.className = "raster-series-axis-bounds"; bounds.hidden = true;
            const fields = ["Minimum", "Maximum"].map(name => {
                const field = this.document.createElement("label"); field.textContent = axis === "x" ? (name === "Minimum" ? "From (UTC)" : "To (UTC)") : name;
                const input = this.document.createElement("input"); input.type = axis === "x" ? "text" : "number";
                input.step = "any";
                if (axis === "x") input.placeholder = "YYYY-MM-DD HH:mm";
                input.setAttribute("aria-label", `${plotLabel} ${axis.toUpperCase()} ${name.toLowerCase()}`);
                field.append(input); bounds.append(field); return input;
            });
            group.append(rangeLabel, bounds); options.append(group);
            axes[axis] = {group, range, bounds, fields};
        }
        const appearance = {};
        for (const [name, caption, value, min, max] of [
            ["pointSize", "Point size (px)", 5, 1, 24], ["xTickCount", "X tick count", 5, 2, 30],
            ["yTickCount", "Y tick count", 5, 2, 30], ["axisFontSize", "Axis font size (px)", 11, 8, 24],
        ]) {
            const label = this.document.createElement("label"); label.textContent = caption;
            const input = this.document.createElement("input"); input.type = "number"; input.min = String(min); input.max = String(max);
            input.step = "1"; input.value = String(plot[name] ?? value);
            input.setAttribute("aria-label", `${plotLabel} ${caption}`);
            label.append(input); options.append(label); appearance[name] = input;
        }
        const error = this.document.createElement("p"); error.className = "raster-series-axis-error"; error.setAttribute("role", "status"); error.hidden = true;
        options.append(error);
        if (plot.id !== 1) {
            const remove = this.document.createElement("button"); remove.type = "button"; remove.className = "secondary-button"; remove.textContent = "×";
            remove.setAttribute("aria-label", `Remove ${plotLabel}; move statistics to Plot 1`);
            remove.title = "Remove plot; move statistics to Plot 1";
            remove.addEventListener("click", () => this.actions.onRemovePlot(plot.id)); header.append(remove);
        }
        const legend = this.document.createElement("div"); legend.className = "raster-series-legend";
        const note = this.document.createElement("p"); note.className = "raster-series-plot-note";
        const chart = this.document.createElementNS("http://www.w3.org/2000/svg", "svg");
        chart.classList.add("raster-series-statistics-chart"); chart.setAttribute("role", "group");
        const empty = this.document.createElement("p"); empty.className = "raster-series-empty-plot";
        const pendingProgress = this.document.createElement("div");
        pendingProgress.className = "raster-series-empty-plot raster-series-pending-plot";
        pendingProgress.hidden = true;
        const pendingMessage = this.document.createElement("div"); pendingMessage.className = "raster-series-progress-message";
        const pendingHeading = this.document.createElement("strong"); pendingHeading.textContent = "Calculating statistics";
        const pendingDetail = this.document.createElement("p");
        const pendingBar = this.document.createElement("progress");
        pendingBar.setAttribute("aria-label", `Calculation progress for ${plotLabel}`);
        pendingMessage.append(pendingHeading, pendingDetail, pendingBar); pendingProgress.append(pendingMessage);
        card.append(header, legend, note, chart, empty, pendingProgress);
        const tooltip = createChartTooltip(this.document, card);
        this.container.append(card);
        const elements = { card, title, options, plot, scale, axes, appearance, error, legend, note, chart, empty,
            pendingProgress, pendingDetail, pendingBar, tooltip, signature: null };
        for (const input of [scale, ...Object.values(appearance), ...Object.values(axes).flatMap(axis => [axis.range, ...axis.fields])]) {
            input.addEventListener(input.tagName.toLowerCase() === "input" ? "input" : "change", () => this.editPlotOptions(plot.id, elements));
        }
        return elements;
    }

    /** Validate plot-option edits, then request a display-only update.
     * Incomplete or invalid drafts keep the last valid figure. Automatic values
     * seed custom fields when first opened; result/progress updates never replace drafts.
     * @param {number} id Plot identity.
     * @param {Object} elements Retained axis controls and last rendered domains.
     * @return {void}
     */
    editPlotOptions(id, elements) {
        const change = {scale: elements.scale.value, bounds: null, xBounds: elements.plot.xBounds ?? null};
        let message = "";
        for (const [axis, controls] of Object.entries(elements.axes)) {
            controls.bounds.hidden = controls.range.value !== "custom";
            if (controls.group.hidden) continue;
            change[axis === "x" ? "xBounds" : "bounds"] = null;
            if (controls.range.value !== "custom") continue;
            const domain = elements.domains?.[axis === "x" ? "xDomain" : "yDomain"];
            if (elements.rangeModes?.[axis] !== "custom" && domain) controls.fields.forEach((field, index) => {
                if (!field.value) field.value = axis === "x" ? new Date(domain[index]).toISOString().slice(0, 16).replace("T", " ") : String(domain[index]);
            });
            const bounds = controls.fields.map(field => axis === "x" ? Date.parse(field.value.replace(" ", "T") + "Z") : Number(field.value));
            if (controls.fields.some(field => !field.value) || bounds.some(value => !Number.isFinite(value))) message = "Enter both axis bounds.";
            else if (axis === "x" && controls.fields.some((field, index) => !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(field.value) || new Date(bounds[index]).toISOString().slice(0, 16).replace("T", " ") !== field.value)) message = "Use YYYY-MM-DD HH:mm for UTC bounds.";
            else if (bounds[0] >= bounds[1]) message = "The maximum must be greater than the minimum.";
            else if (axis === "y" && change.scale === "log" && bounds[0] <= 0) message = "Logarithmic bounds must be greater than zero.";
            change[axis === "x" ? "xBounds" : "bounds"] = bounds;
        }
        for (const [name, input] of Object.entries(elements.appearance)) {
            const value = Number(input.value);
            if (!input.value || !Number.isInteger(value) || value < Number(input.min) || value > Number(input.max)) {
                message = `${input.getAttribute("aria-label")}: enter a whole number from ${input.min} to ${input.max}.`;
            }
            change[name] = value;
        }
        elements.rangeModes = Object.fromEntries(Object.entries(elements.axes).map(([axis, controls]) => [axis, controls.range.value]));
        elements.error.hidden = !message; elements.error.textContent = message;
        if (!message) this.actions.onPlotOptions(id, change);
    }

    /** Add or remove plot cards and refresh those whose settings or results changed.
     * All cards use the same current or previous calculation results. Each card
     * is passed to renderPlot() only when its displayed content needs updating.
     * Newly added secondary plots are revealed once; updates preserve scrolling.
     * Progress updates change pending placeholders without redrawing retained figures.
     * @param {import("./series-view.js").SeriesPresentation} state Authoritative result and job-progress snapshot.
     * @return {boolean} Whether a visible pending plot presents the shared calculation's progress.
     */
    renderPlots(state) {
        let hasPendingPlot = false;
        for (const [id, elements] of this.cards) {
            if (state.plots.some(plot => plot.id === id)) continue;
            const hadFocus = elements.card.contains(this.document.activeElement);
            elements.card.remove(); elements.options.remove(); this.cards.delete(id);
            if (hadFocus) this.document.querySelector("#raster-series-add-plot").focus();
        }
        for (const plot of state.plots) {
            const added = !this.cards.has(plot.id);
            if (added) this.cards.set(plot.id, this.createPlotCard(plot));
            const elements = this.cards.get(plot.id);
            elements.title.parentElement.hidden = state.plots.length === 1;
            elements.plot = plot;
            if (elements.error.hidden && elements.scale.value !== plot.scale) elements.scale.value = plot.scale;
            elements.axes.x.group.hidden = !state.temporal;
            const statistics = state.statistics.filter(statistic => statistic.plotId === plot.id && statistic.visible);
            const series = statistics.map(statistic => ({
                id: String(statistic.id), label: `${statistic.label || "Custom statistic"} · ${statistic.expression}`,
                ...STATISTIC_STYLES[statistic.styleIndex],
                color: statistic.color ?? STATISTIC_STYLES[statistic.styleIndex].color,
                points: (state.showingPrevious ? statistic.previousRows : statistic.rows).map(row => ({
                    xLabel: row.label, xValue: row.xValue, yValue: row.state === "value" ? row.value : null, rawValue: row.rawValue, unit: row.unit,
                })),
            }));
            // Only chart inputs belong here: progress and catalog metadata do not change a figure.
            const signature = JSON.stringify([elements.chart.clientWidth, plot, state.direction, state.chartType, state.showingPrevious, !!state.temporal, series]);
            if (elements.signature !== signature) {
                elements.signature = signature;
                this.renderPlot(elements, plot, statistics, state, series);
            }
            if (this.renderPendingProgress(elements, state, statistics)) hasPendingPlot = true;
            if (added && plot.id !== 1) elements.card.scrollIntoView({ block: "start", inline: "nearest" });
        }
        return hasPendingPlot;
    }

    /**
     * Show the shared temporal job's current progress inside a plot awaiting values.
     * Completed NoData/error rows, hidden statistics and unassigned plots keep their existing empty states.
     * This display uses the supplied snapshot and never starts or observes a separate job.
     * @param {RasterSeriesPlotCard} elements Retained plot presentation.
     * @param {import("./series-view.js").SeriesPresentation} state Authoritative result and progress snapshot.
     * @param {import("./series-view.js").SeriesStatistic[]} statistics Visible statistics assigned to this plot.
     * @return {boolean} Whether the pending progress presentation is visible.
     */
    renderPendingProgress(elements, state, statistics) {
        const waiting = statistics.some(statistic => {
            const rows = state.showingPrevious ? statistic.previousRows : statistic.rows;
            return rows.length === 0 || rows.some(row => row.state === "waiting");
        });
        const pending = Boolean(state.temporal && state.busy && waiting && elements.chart.hidden);
        if (elements.pendingProgress.hidden !== !pending) elements.pendingProgress.hidden = !pending;
        if (!pending) {
            if (elements.chart.hidden && elements.empty.hidden) elements.empty.hidden = false;
            return false;
        }
        if (!elements.empty.hidden) elements.empty.hidden = true;
        if (elements.pendingDetail.textContent !== state.message) elements.pendingDetail.textContent = state.message;
        const total = state.workProgress?.total;
        if (total > 0) {
            for (const [name, value] of [["max", total], ["value", state.workProgress.completed ?? 0]]) {
                if (elements.pendingBar.getAttribute(name) !== String(value)) elements.pendingBar.setAttribute(name, String(value));
            }
        } else if (elements.pendingBar.getAttribute("value") !== null) elements.pendingBar.removeAttribute("value");
        return true;
    }

    /** Update one existing plot card's chart, legend, value details and empty-state message.
     * Values its scale cannot represent stay in the result table and CSV.
     * @param {Object} elements Retained card elements.
     * @param {import("./series-view.js").SeriesPlot} plot Plot settings.
     * @param {Object[]} statistics Visible statistics assigned to this plot.
     * @param {{showingPrevious:boolean,chartType:string,temporal:Object|null}} state Current presentation settings.
     * @param {import("../charts/series-chart.js").ChartSeries[]} series Chart-only observations and styles.
     * @return {void}
     */
    renderPlot(elements, plot, statistics, state, series) {
        const { chart, tooltip, legend, note, empty } = elements;
        legend.hidden = !statistics.length;
        const focused = this.document.activeElement;
        const hadChartFocus = chart.contains(focused);
        const focusSeries = focused?.closest?.("[data-series-id]")?.getAttribute("data-series-id");
        const focusPoint = focused?.getAttribute?.("data-point-index");
        const focusLegend = legend.contains(focused) ? focused?.dataset?.statisticId : null;
        chart.replaceChildren(); legend.replaceChildren(); tooltip.hide();
        const values = series.flatMap(item => item.points).filter(point => Number.isFinite(point.yValue));
        const units = [...new Set(values.map(point => point.unit || "unit unspecified"))];
        const excluded = plot.scale === "log" ? values.filter(point => point.yValue <= 0).length : 0;
        const unitsText = units.length > 1 ? `Mixed units: ${units.join(", ")}. Assign statistics to separate plots if needed.` : "";
        note.textContent = [unitsText, excluded ? `Log scale omits ${excluded} zero or negative ${excluded === 1 ? "value" : "values"}; see the table or CSV.` : "",
            state.chartType === "bar" && (plot.scale === "log" || plot.bounds && (plot.bounds[0] > 0 || plot.bounds[1] < 0)) ? "Bars start at the displayed axis bound." : ""].filter(Boolean).join(" ");
        note.hidden = !note.textContent;
        for (const statistic of statistics) {
            const button = this.document.createElement("button"); button.type = "button";
            button.dataset.statisticId = String(statistic.id); button.className = "raster-series-legend-item";
            button.setAttribute("aria-label", `Highlight ${statistic.label || statistic.expression}`);
            button.append(createStatisticSwatch(this.document, statistic.styleIndex, statistic.color));
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
        if (!chart.hidden) elements.domains = renderOrdinalSeriesChart({
            documentContext: this.document, chart, series, chartType: state.chartType, yScale: plot.scale,
            width: chart.clientWidth, height: 260 + Math.max(0, (plot.axisFontSize ?? 11) - 11) * 5,
            pointSize: plot.pointSize ?? 5, xTickCount: plot.xTickCount ?? 5, yTickCount: plot.yTickCount ?? 5, axisFontSize: plot.axisFontSize ?? 11,
            yBounds: plot.bounds ?? null, xBounds: state.temporal ? plot.xBounds ?? null : null,
            xReverse: !!state.temporal && state.direction === "reverse",
            xScale: state.temporal ? "numeric" : "ordinal", xAxisLabel: state.temporal ? "Time (UTC)" : "Raster",
            yAxisLabel: (units.length === 1 && units[0] !== "unit unspecified" ? `Value (${units[0]})` : "Value") + (plot.scale === "log" ? " · log" : ""),
            yAxisLabelPosition: "top",
            ariaLabel: `Plot ${plot.displayNumber}${state.showingPrevious ? "; previous results" : ""}: ${series.map(item => item.label).join("; ")}`,
            pointAccessibleLabel: (point, item, index) => this.describePoint(series, index, plot.scale, state.showingPrevious),
            onInspect: inspection => {
                if (inspection?.point) tooltip.show(this.describePoint(series, inspection.index, plot.scale, state.showingPrevious));
                else tooltip.hide();
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
