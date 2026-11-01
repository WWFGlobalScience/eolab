/** Draw ordered numeric observations for vector and raster series with D3. */
import { extent, line as seriesLine, scaleLinear, scaleLog } from "d3";
import { bindChartInspection, createSvgElement, drawChartAxes } from "./chart-presentation.js";

const CHART_WIDTH = 680;
const CHART_HEIGHT = 360;
const CHART_MARGIN = Object.freeze({ top: 20, right: 24, bottom: 92, left: 72 });
const NUMBER_FORMAT = new Intl.NumberFormat("en", { maximumSignificantDigits: 6 });
let clipSerial = 0;

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
 * Draw a line, scatter or grouped bar plot over ordered observations.
 *
 * Null Y values retain their X position and break line segments, so callers can
 * communicate missing observations without inventing numeric values.
 * Linear bars start at zero when it is visible, otherwise the nearest axis bound;
 * log bars start at the lower Y-axis bound. Custom domains clip display marks only.
 *
 * @param {Object} configuration Closed rendering contract.
 * @param {Document} configuration.documentContext Owning document.
 * @param {SVGElement} configuration.chart Empty target SVG element.
 * @param {{xLabel:string,yValue:number|null,xValue?:number}[]} [configuration.points] Single-series ordered points.
 * @param {ChartSeries[]} [configuration.series] Multiple series sharing the same ordered X positions; replaces points.
 * @param {"line"|"scatter"|"bar"} configuration.chartType Plot geometry.
 * @param {"ordinal"|"numeric"} [configuration.xScale="ordinal"] X spacing.
 * @param {"linear"|"log"} [configuration.yScale="linear"] Y spacing; log excludes non-positive values.
 * @param {[number,number]|null} [configuration.xBounds=null] Validated numeric display bounds, or automatic observation extent.
 * @param {[number,number]|null} [configuration.yBounds=null] Validated increasing Y display bounds; positive for log scales.
 * @param {boolean} [configuration.xReverse=false] Reverse the numeric display axis without changing observations.
 * @param {number} [configuration.width=680] Measured SVG width; labels retain their screen size.
 * @param {number} [configuration.height=360] SVG height in screen pixels; explicit tick fonts can add caption space without shrinking the plot.
 * @param {number} [configuration.pointSize=9] Marker diameter in screen pixels.
 * @param {number|null} [configuration.xTickCount=null] Maximum X tick labels; null adapts to chart width.
 * @param {number} [configuration.yTickCount=5] Desired Y tick count, rounded by the numeric scale.
 * @param {number|null} [configuration.axisFontSize=null] Tick font size in screen pixels; axis titles are one pixel larger. Null keeps the caller's CSS.
 * @param {string} configuration.xAxisLabel Horizontal-axis title.
 * @param {string} configuration.yAxisLabel Vertical-axis title.
 * @param {"left"|"top"} [configuration.yAxisLabelPosition="left"] Place the Y title beside or above the plot.
 * @param {string} configuration.ariaLabel Chart-level accessible description.
 * @param {(point:Object,series:ChartSeries,index:number)=>string} configuration.pointAccessibleLabel Accessible point label.
 * @param {((point:Object)=>string)|null} [configuration.pointTooltip=null] Native tooltip text, required unless onInspect is supplied.
 * @param {((point:Object)=>void)|null} [configuration.onPointSelect=null]
 * Optional selection intent callback.
 * @param {((inspection:{series:ChartSeries,point:Object|null,index:number|null}|null)=>void)|null} [configuration.onInspect=null] Pointer/focus details; when supplied, replaces native tooltips.
 * @return {{pointElements:{circle:SVGElement,point:Object}[],xDomain:number[],yDomain:number[]}} Rendered handles and displayed domains, for axis editors.
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
    xBounds = null,
    yBounds = null,
    xReverse = false,
    width = CHART_WIDTH,
    height = CHART_HEIGHT,
    pointSize = 9,
    xTickCount = null,
    yTickCount = 5,
    axisFontSize = null,
    xAxisLabel,
    yAxisLabel,
    yAxisLabelPosition = "left",
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
        !["line", "scatter", "bar"].includes(chartType) ||
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
    const values = finitePoints.map(point => yScale === "log" ? Math.log10(point.yValue) : point.yValue);
    let minimum = Math.min(...values);
    let maximum = Math.max(...values);
    if (chartType === "bar" && yScale === "linear") {
        minimum = Math.min(0, minimum);
        maximum = Math.max(0, maximum);
    }
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
    const eligible = points.map((point, index) => index).filter(index => !xBounds || numericX[index] >= xBounds[0] && numericX[index] <= xBounds[1]);
    const indexes = ordinalTickIndexes(eligible.length, xTickCount ?? (width < 480 ? 4 : 7)).map(index => eligible[index]);
    const fontGrowth = Math.max(0, (axisFontSize ?? 10) - 10);
    const tickLength = Math.max(0, ...indexes.map(index => formatTickLabel(points[index].xLabel, width < 480 ? 18 : 28).length));
    const margin = {...CHART_MARGIN,
        top: yAxisLabelPosition === "top" ? Math.max(CHART_MARGIN.top, (axisFontSize ?? 11) + 17) : CHART_MARGIN.top,
        left: axisFontSize === null ? CHART_MARGIN.left : Math.max(CHART_MARGIN.left, tickLength * axisFontSize * 0.5 + 8),
        bottom: CHART_MARGIN.bottom + fontGrowth * 5};
    if (axisFontSize !== null) {
        // Leave room for rotated monospaced ticks, then the horizontal axis title.
        const captionHeight = Math.ceil(tickLength * axisFontSize * 0.62 * Math.sin(35 * Math.PI / 180) + axisFontSize * 2.5 + 17);
        const extraHeight = Math.max(0, captionHeight - margin.bottom);
        margin.bottom += extraHeight;
        height += extraHeight;
    }
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const sortedX = chartType === "bar" && xScale === "numeric" ? [...new Set(numericX)].sort((a, b) => a - b) : [];
    const spacing = sortedX.length > 1
        ? Math.min(...sortedX.slice(1).map((value, index) => value - sortedX[index])) : 1;
    const xDomain = xScale === "numeric" ? extent(numericX) : [0, points.length - 1];
    const horizontal = scaleLinear()
        .domain(xBounds ?? (chartType === "bar" ? [xDomain[0] - spacing / 2, xDomain[1] + spacing / 2] : xDomain))
        .range(xReverse ? [margin.left + plotWidth, margin.left] : [margin.left, margin.left + plotWidth]);
    const x = index => horizontal(xScale === "numeric" ? numericX[index] : index);
    const groupWidth = Math.min(60, Math.abs(horizontal(xDomain[0] + spacing) - horizontal(xDomain[0])) * 0.8);
    const barWidth = groupWidth / plottedSeries.length;
    const y = (yScale === "log" ? scaleLog() : scaleLinear())
        .domain(yBounds ?? (yScale === "log"
            ? [Math.max(Number.MIN_VALUE, 10 ** minimum), Math.min(Number.MAX_VALUE, 10 ** maximum)]
            : [minimum, maximum]))
        .range([margin.top + plotHeight, margin.top]);
    [minimum, maximum] = y.domain().map(value => yScale === "log" ? Math.log10(value) : value);
    const baselineValue = Math.max(y.domain()[0], Math.min(0, y.domain()[1]));
    const barBaseline = y(baselineValue);
    chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    chart.setAttribute("aria-label", ariaLabel);
    const ticks = (xScale === "numeric" ? indexes.map(index => numericX[index]) : indexes)
        .filter(value => value >= horizontal.domain()[0] && value <= horizontal.domain()[1]);
    // Generate log ticks in exponent space so subnormal or maximum finite
    // values never overflow the library's decimal tick-step calculation.
    const yTicks = yScale === "log" ? scaleLinear([minimum, maximum]).ticks(yTickCount)
        .map(value => Math.min(Number.MAX_VALUE, Math.max(Number.MIN_VALUE, 10 ** value))) : y.ticks(yTickCount);
    const topYTitle = yAxisLabelPosition === "top";
    const yTitleX = topYTitle ? margin.left : axisFontSize === null ? 16 : Math.max(16, axisFontSize + 4);
    const yTitleY = topYTitle ? margin.top - 13 : margin.top + plotHeight / 2;
    drawChartAxes(documentContext, chart, {left: margin.left, top: margin.top, width: plotWidth, height: plotHeight},
        {scale: horizontal, values: [...new Set(ticks)], rotation: -35,
            format: value => formatTickLabel(points[xScale === "numeric" ? numericX.indexOf(value) : value].xLabel, width < 480 ? 18 : 28)},
        {scale: y, values: yTicks, format: formatSeriesNumber}, [
            {text: xAxisLabel, x: margin.left + plotWidth / 2, y: height - 8},
            {text: yAxisLabel, x: yTitleX, y: yTitleY, rotation: topYTitle ? 0 : -90, anchor: topYTitle ? "start" : "middle"},
        ], axisFontSize);
    const clipId = `series-chart-clip-${++clipSerial}`;
    const definitions = createSvgElement(documentContext, "defs", {});
    const clip = createSvgElement(documentContext, "clipPath", { id: clipId });
    clip.append(createSvgElement(documentContext, "rect", { x: margin.left, y: margin.top, width: plotWidth, height: plotHeight }));
    definitions.append(clip); chart.append(definitions);
    const pointElements = [];
    const pointGroups = [];
    const inspectionState = { focused: null, hovered: null };
    const clipAttributes = xBounds || yBounds ? { "clip-path": `url(#${clipId})` } : {};
    for (const [seriesIndex, item] of plottedSeries.entries()) {
        const group = series || xBounds || yBounds ? createSvgElement(documentContext, "g", { ...(series ? { "data-series-id": item.id } : {}), ...clipAttributes }) : chart;
        if (item.color) group.setAttribute("style", `--series-color: ${item.color}`);
        if (group !== chart) chart.append(group);
        const pointGroup = series || xBounds || yBounds ? createSvgElement(documentContext, "g", { ...(series ? { "data-series-id": item.id } : {}), ...clipAttributes }) : chart;
        if (item.color) pointGroup.setAttribute("style", `--series-color: ${item.color}`);
        if (pointGroup !== chart) pointGroups.push(pointGroup);
        if (chartType === "line") {
            const path = seriesLine().defined(canPlot)
                .x((point, index) => x(index)).y(point => y(point.yValue))(item.points);
            const line = createSvgElement(documentContext, "path", {
                class: "series-chart-line",
                d: path,
                "stroke-dasharray": item.dash ?? "none",
            });
            group.append(line);
            if (onInspect) {
                const hit = createSvgElement(documentContext, "path", {
                    class: "series-chart-line-hit", d: path, tabindex: 0, role: "img",
                    "aria-label": item.label, "data-series-line": item.id,
                });
                bindChartInspection(hit, { series: item, point: null, index: null }, onInspect, inspectionState);
                group.append(hit);
            }
        }
        item.points.forEach((point, index) => {
            if (!canPlot(point)) {
                return;
            }
            if (xBounds && (point.xValue < xBounds[0] || point.xValue > xBounds[1])) return;
            if (chartType !== "bar" && yBounds && (point.yValue < yBounds[0] || point.yValue > yBounds[1])) return;
            const selectable = onPointSelect !== null;
            const markerPaths = { square: "M-4,-4h8v8h-8z", diamond: "M0,-6L5,0L0,6L-5,0z",
                triangle: "M0,-6L5,4L-5,4z", cross: "M-5,0h10M0,-5v10" };
            const markerPath = markerPaths[item.marker];
            const barHeight = Math.abs(y(point.yValue) - barBaseline);
            const circle = createSvgElement(documentContext, chartType === "bar" ? "rect" : markerPath ? "path" : "circle", {
                class: chartType === "bar" ? "series-chart-point series-chart-bar" : "series-chart-point",
                cx: x(index),
                cy: y(point.yValue),
                r: pointSize / 2,
                tabindex: 0,
                role: selectable ? "button" : "img",
                ...(selectable ? { "aria-pressed": "false" } : {}),
                ...(chartType === "bar" ? {
                    x: x(index) - groupWidth / 2 + seriesIndex * barWidth,
                    y: barHeight === 0 ? barBaseline - 0.5 : Math.min(y(point.yValue), barBaseline),
                    width: barWidth * 0.9,
                    height: Math.max(1, barHeight),
                } : markerPath ? { d: markerPath, transform: `translate(${x(index)} ${y(point.yValue)}) scale(${pointSize / 9})` } : {}),
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
            if (onInspect) bindChartInspection(circle, { series: item, point, index }, onInspect, inspectionState);
            else circle.append(createSvgElement(
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
    chart.removeAttribute("hidden");
    return { pointElements, xDomain: horizontal.domain(), yDomain: y.domain() };
}
