/** Draw ordered numeric observations for vector and raster series with D3. */
import { axisBottom, axisLeft, extent, line as seriesLine, scaleLinear, scaleLog, select } from "d3";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CHART_WIDTH = 680;
const CHART_HEIGHT = 360;
const CHART_MARGIN = Object.freeze({ top: 20, right: 24, bottom: 92, left: 72 });
const NUMBER_FORMAT = new Intl.NumberFormat("en", { maximumSignificantDigits: 6 });

/**
 * @typedef {Object} ChartSeries
 * @property {string} id Stable series identity.
 * @property {string} label Human-readable name and optional description.
 * @property {{xLabel:string,yValue:number|null,xValue?:number}[]} points Aligned observations.
 * @property {string} [color] CSS stroke color.
 * @property {string} [dash] SVG line dash pattern.
 * @property {"circle"|"square"|"diamond"|"triangle"|"cross"} [marker] Point shape.
 */

/**
 * Return compact finite-number text for axes and accessible details.
 *
 * @param {number} value Finite number.
 * @return {string} Compact localized value.
 */
export function formatSeriesNumber(value) {
    return NUMBER_FORMAT.format(value);
}

/**
 * Keep dense ordinal tick labels readable while full values remain available.
 *
 * @param {string} label Full X label.
 * @param {number} [maximum=28] Maximum visible characters.
 * @return {string} Bounded tick label.
 */
function formatTickLabel(label, maximum = 28) {
    return label.length <= maximum
        ? label
        : `${label.slice(0, maximum - 1)}…`;
}

/**
 * Choose bounded ordinal tick indexes including both endpoints.
 *
 * @param {number} count Point count.
 * @param {number} [maximum=7] Maximum labels.
 * @return {number[]} Unique point indexes.
 */
function ordinalTickIndexes(count, maximum = 7) {
    if (count <= maximum) {
        return Array.from({ length: count }, (_, index) => index);
    }
    return [...new Set(Array.from(
        { length: maximum },
        (_, index) => Math.round(index * (count - 1) / (maximum - 1))
    ))];
}

/**
 * Create one namespaced SVG element with string attributes.
 *
 * @param {Document} documentContext Owning document.
 * @param {string} name SVG element name.
 * @param {Record<string,string|number>} attributes SVG attributes.
 * @param {string|null} [text=null] Optional text content.
 * @return {SVGElement} New SVG element.
 */
function svgElement(documentContext, name, attributes, text = null) {
    const element = documentContext.createElementNS(SVG_NAMESPACE, name);
    for (const [attribute, value] of Object.entries(attributes)) {
        element.setAttribute(attribute, String(value));
    }
    if (text !== null) element.textContent = text;
    return element;
}

/**
 * Draw a line or scatter plot over an ordinal sequence.
 *
 * Null Y values retain their X position and break line segments, so callers can
 * communicate missing observations without inventing numeric values.
 *
 * @param {Object} configuration Closed rendering contract.
 * @param {Document} configuration.documentContext Owning document.
 * @param {SVGElement} configuration.chart Empty target SVG element.
 * @param {{xLabel:string,yValue:number|null,xValue?:number}[]} [configuration.points] Single-series ordered points.
 * @param {ChartSeries[]} [configuration.series] Multiple series sharing the same ordered X positions; replaces points.
 * @param {"line"|"scatter"} configuration.chartType Plot geometry.
 * @param {"ordinal"|"numeric"} [configuration.xScale="ordinal"] X spacing.
 * @param {"linear"|"log"} [configuration.yScale="linear"] Y spacing; log excludes non-positive values.
 * @param {string} configuration.xAxisLabel Horizontal-axis title.
 * @param {string} configuration.yAxisLabel Vertical-axis title.
 * @param {string} configuration.ariaLabel Chart-level accessible description.
 * @param {(point:Object,series:ChartSeries,index:number)=>string} configuration.pointAccessibleLabel Accessible point label.
 * @param {((point:Object)=>string)|null} [configuration.pointTooltip=null] Native tooltip text, required unless onInspect is supplied.
 * @param {((point:Object)=>void)|null} [configuration.onPointSelect=null]
 * Optional selection intent callback.
 * @param {((inspection:{series:ChartSeries,point:Object|null,index:number|null}|null)=>void)|null} [configuration.onInspect=null] Pointer/focus details; when supplied, replaces native tooltips.
 * @return {{pointElements:{circle:SVGElement,point:Object}[]}} Rendered point handles.
 * @throws {TypeError} If the chart contract or aligned positions are invalid, or no plottable value exists.
 */
export function renderOrdinalSeriesChart({
    documentContext,
    chart,
    points,
    series = null,
    chartType,
    xScale = "ordinal",
    yScale = "linear",
    xAxisLabel,
    yAxisLabel,
    ariaLabel,
    pointAccessibleLabel,
    pointTooltip = null,
    onPointSelect = null,
    onInspect = null,
}) {
    const plottedSeries = series ?? [{ id: "series", label: ariaLabel, points }];
    points = plottedSeries[0]?.points;
    if (
        !Array.isArray(points) || points.length === 0 ||
        !["line", "scatter"].includes(chartType) ||
        !["ordinal", "numeric"].includes(xScale) ||
        !["linear", "log"].includes(yScale) ||
        typeof xAxisLabel !== "string" || typeof yAxisLabel !== "string" ||
        typeof ariaLabel !== "string" ||
        typeof pointAccessibleLabel !== "function" ||
        (onInspect === null && typeof pointTooltip !== "function") ||
        !(onPointSelect === null || typeof onPointSelect === "function") ||
        !(onInspect === null || typeof onInspect === "function") ||
        !plottedSeries.every(item => Array.isArray(item.points) && item.points.length === points.length &&
            item.points.every((point, index) => point.xLabel === points[index].xLabel && point.xValue === points[index].xValue))
    ) {
        throw new TypeError("Invalid ordinal series chart contract.");
    }
    /** Test whether an observation can appear on this Y scale.
     * @param {Object} point Observation. @return {boolean} Whether to draw it.
     */
    const canPlot = point => typeof point.yValue === "number" && Number.isFinite(point.yValue) &&
        (yScale !== "log" || point.yValue > 0);
    const finitePoints = plottedSeries.flatMap(item => item.points.filter(canPlot));
    if (finitePoints.length === 0) {
        throw new TypeError("An ordinal series chart requires a finite Y value.");
    }
    const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
    const plotHeight = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
    const values = finitePoints.map(point => yScale === "log" ? Math.log10(point.yValue) : point.yValue);
    let minimum = Math.min(...values);
    let maximum = Math.max(...values);
    if (minimum === maximum) {
        const padding = yScale === "log" ? 0.5 : Math.abs(minimum) * 0.1 || 1;
        minimum -= padding;
        maximum += padding;
    }
    if (yScale === "log") {
        minimum = Math.max(Math.log10(Number.MIN_VALUE), minimum);
        maximum = Math.min(Math.log10(Number.MAX_VALUE), maximum);
    }
    const numericX = xScale === "numeric"
        ? points.map((point) => point.xValue)
        : [];
    if (
        xScale === "numeric" &&
        !numericX.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
        throw new TypeError("Numeric series chart X values must be finite.");
    }
    const horizontal = scaleLinear()
        .domain(xScale === "numeric" ? extent(numericX) : [0, points.length - 1])
        .range([CHART_MARGIN.left, CHART_MARGIN.left + plotWidth]);
    const x = index => horizontal(xScale === "numeric" ? numericX[index] : index);
    const y = (yScale === "log" ? scaleLog() : scaleLinear())
        .domain(yScale === "log"
            ? [Math.max(Number.MIN_VALUE, 10 ** minimum), Math.min(Number.MAX_VALUE, 10 ** maximum)]
            : [minimum, maximum])
        .range([CHART_MARGIN.top + plotHeight, CHART_MARGIN.top]);
    const xAxisY = CHART_MARGIN.top + plotHeight;
    chart.setAttribute("viewBox", `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
    chart.setAttribute("aria-label", ariaLabel);
    const xAxis = svgElement(documentContext, "g", {
        class: "series-chart-x-axis", transform: `translate(0 ${xAxisY})`,
    });
    const indexes = ordinalTickIndexes(points.length);
    const ticks = xScale === "numeric" ? indexes.map(index => numericX[index]) : indexes;
    select(xAxis).call(axisBottom(horizontal).tickValues([...new Set(ticks)])
        .tickFormat(value => formatTickLabel(points[xScale === "numeric" ? numericX.indexOf(value) : value].xLabel))
        .tickSizeOuter(0));
    select(xAxis).selectAll("text").attr("transform", "rotate(-35)").attr("text-anchor", "end");
    const yAxis = svgElement(documentContext, "g", {
        class: "series-chart-y-axis", transform: `translate(${CHART_MARGIN.left} 0)`,
    });
    // Generate log ticks in exponent space so subnormal or maximum finite
    // values never overflow the library's decimal tick-step calculation.
    const yTicks = yScale === "log" ? scaleLinear([minimum, maximum]).ticks(5)
        .map(value => Math.min(Number.MAX_VALUE, Math.max(Number.MIN_VALUE, 10 ** value))) : y.ticks(5);
    select(yAxis).call(axisLeft(y).tickValues(yTicks).tickSize(-plotWidth).tickSizeOuter(0)
        .tickFormat(formatSeriesNumber));
    chart.append(xAxis, yAxis);
    const pointElements = [];
    const pointGroups = [];
    const inspectionState = { focused: null, hovered: null };
    for (const item of plottedSeries) {
        const group = series ? svgElement(documentContext, "g", { "data-series-id": item.id }) : chart;
        if (item.color) group.setAttribute("style", `--series-color: ${item.color}`);
        if (series) chart.append(group);
        const pointGroup = series ? svgElement(documentContext, "g", { "data-series-id": item.id }) : chart;
        if (item.color) pointGroup.setAttribute("style", `--series-color: ${item.color}`);
        if (series) pointGroups.push(pointGroup);
        if (chartType === "line") {
            const path = seriesLine().defined(canPlot)
                .x((point, index) => x(index)).y(point => y(point.yValue))(item.points);
            const line = svgElement(documentContext, "path", {
                class: "series-chart-line",
                d: path,
                "stroke-dasharray": item.dash ?? "none",
            });
            group.append(line);
            if (onInspect) {
                const hit = svgElement(documentContext, "path", {
                    class: "series-chart-line-hit", d: path, tabindex: 0, role: "img",
                    "aria-label": item.label, "data-series-line": item.id,
                });
                bindInspection(hit, { series: item, point: null, index: null }, onInspect, inspectionState);
                group.append(hit);
            }
        }
        item.points.forEach((point, index) => {
            if (!canPlot(point)) {
                return;
            }
            const selectable = onPointSelect !== null;
            const markerPaths = { square: "M-4,-4h8v8h-8z", diamond: "M0,-6L5,0L0,6L-5,0z",
                triangle: "M0,-6L5,4L-5,4z", cross: "M-5,0h10M0,-5v10" };
            const markerPath = markerPaths[item.marker];
            const circle = svgElement(documentContext, markerPath ? "path" : "circle", {
                class: "series-chart-point",
                cx: x(index),
                cy: y(point.yValue),
                r: 4.5,
                tabindex: 0,
                role: selectable ? "button" : "img",
                ...(selectable ? { "aria-pressed": "false" } : {}),
                ...(markerPath ? { d: markerPath, transform: `translate(${x(index)} ${y(point.yValue)})` } : {}),
                "data-point-index": index,
                "aria-label": pointAccessibleLabel(point, item, index),
            });
            if (selectable) {
                circle.addEventListener("click", () => onPointSelect(point));
                circle.addEventListener("keydown", (event) => {
                    if (!["Enter", " "].includes(event.key)) return;
                    event.preventDefault();
                    onPointSelect(point);
                });
            }
            if (onInspect) bindInspection(circle, { series: item, point, index }, onInspect, inspectionState);
            else circle.append(svgElement(
                documentContext,
                "title",
                {},
                pointTooltip(point)
            ));
            pointElements.push({ circle, point });
            pointGroup.append(circle);
        });
    }
    chart.append(...pointGroups);
    chart.append(
        svgElement(documentContext, "text", {
            class: "series-chart-axis-title",
            x: CHART_MARGIN.left + plotWidth / 2,
            y: CHART_HEIGHT - 8,
            "text-anchor": "middle",
        }, xAxisLabel),
        svgElement(documentContext, "text", {
            class: "series-chart-axis-title",
            x: 16,
            y: CHART_MARGIN.top + plotHeight / 2,
            transform: `rotate(-90 16 ${CHART_MARGIN.top + plotHeight / 2})`,
            "text-anchor": "middle",
        }, yAxisLabel)
    );
    chart.removeAttribute("hidden");
    return { pointElements };
}

/**
 * Give pointer and keyboard users the same details without a second native tooltip.
 * @param {SVGElement} element Focusable line or point.
 * @param {Object} inspection Series and optional observation to describe.
 * @param {(inspection:Object|null)=>void} onInspect Display or clear the details.
 * @param {{focused:Object|null,hovered:Object|null}} state Shared focus and pointer state for this chart.
 * @return {void}
 */
function bindInspection(element, inspection, onInspect, state) {
    element.addEventListener("focus", () => { state.focused = inspection; onInspect(inspection); });
    // Moving focus can scroll a line under a stationary pointer. Only actual
    // pointer movement should replace the keyboard user's inspected value.
    element.addEventListener("pointermove", () => { state.hovered = inspection; onInspect(inspection); });
    element.addEventListener("pointerleave", () => {
        if (state.hovered === inspection) state.hovered = null;
        onInspect(state.focused);
    });
    element.addEventListener("blur", () => {
        if (state.focused === inspection) state.focused = null;
        onInspect(state.hovered);
    });
    element.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        state.focused = null; state.hovered = null; onInspect(null);
    });
}
