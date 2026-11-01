/** Draw chart axes and present inspected values without knowing their data source. */
import { axisBottom, axisLeft, select } from "d3";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** @typedef {{left:number,top:number,width:number,height:number}} ChartPlot */
/** @typedef {{scale:import("d3").AxisScale<number>,values:number[],format:(value:number)=>string,rotation?:number,edgeLabels?:boolean}} ChartAxis */
/** @typedef {{text:string,x:number,y:number,rotation?:number,anchor?:string}} ChartAxisTitle */

/** Create an SVG element with serialized attributes and optional text.
 * @param {Document} documentContext Owning document.
 * @param {string} name SVG tag name.
 * @param {Record<string,string|number>} attributes SVG attributes.
 * @param {string|null} [text=null] Text content, if any.
 * @return {SVGElement} Detached element.
 */
export function createSvgElement(documentContext, name, attributes, text = null) {
    const element = documentContext.createElementNS(SVG_NAMESPACE, name);
    for (const [attribute, value] of Object.entries(attributes)) element.setAttribute(attribute, String(value));
    if (text !== null) element.textContent = text;
    return element;
}

/** Draw axes, horizontal grid lines and titles from the caller's display scales.
 * Callers choose tick values and formatters so bins, dates and categories keep
 * their own meaning. This function owns only SVG placement and axis drawing.
 * @param {Document} documentContext Owning document.
 * @param {SVGSVGElement} chart Target chart.
 * @param {ChartPlot} plot Plot rectangle in SVG pixels.
 * @param {ChartAxis} horizontal Horizontal scale, ticks and labels.
 * @param {ChartAxis} vertical Vertical scale, ticks and labels.
 * @param {ChartAxisTitle[]} titles Positioned axis titles.
 * @param {number|null} [fontSize=null] Tick font size; titles are one pixel larger. Null uses CSS.
 * @return {SVGGElement} Appended group containing both axes and their titles.
 */
export function drawChartAxes(documentContext, chart, plot, horizontal, vertical, titles, fontSize = null) {
    const axes = createSvgElement(documentContext, "g", {class: "chart-axes", "aria-hidden": "true"});
    const xAxis = createSvgElement(documentContext, "g", {
        class: "series-chart-x-axis", transform: `translate(0 ${plot.top + plot.height})`,
    });
    select(xAxis).call(axisBottom(horizontal.scale).tickValues(horizontal.values)
        .tickFormat(horizontal.format).tickSizeInner(4).tickSizeOuter(0).tickPadding(6));
    const xLabels = select(xAxis).selectAll("text");
    if (horizontal.rotation) xLabels.attr("transform", `rotate(${horizontal.rotation})`).attr("text-anchor", "end");
    else if (horizontal.edgeLabels) xLabels.attr("text-anchor", (_, index, nodes) =>
        index === 0 ? "start" : index === nodes.length - 1 ? "end" : "middle");
    const yAxis = createSvgElement(documentContext, "g", {
        class: "series-chart-y-axis", transform: `translate(${plot.left} 0)`,
    });
    select(yAxis).call(axisLeft(vertical.scale).tickValues(vertical.values).tickFormat(vertical.format)
        .tickSize(-plot.width).tickSizeOuter(0).tickPadding(8));
    axes.append(xAxis, yAxis);
    if (fontSize !== null) select(axes).selectAll("text").style("font-size", `${fontSize}px`);
    for (const title of titles) axes.append(createSvgElement(documentContext, "text", {
        class: "series-chart-axis-title", x: title.x, y: title.y, "text-anchor": title.anchor ?? "middle",
        ...(title.rotation ? {transform: `rotate(${title.rotation} ${title.x} ${title.y})`} : {}),
        ...(fontSize === null ? {} : {style: `font-size: ${fontSize + 1}px`}),
    }, title.text));
    chart.append(axes);
    return axes;
}

/** Create a hidden tooltip in an SVG chart or an HTML plot container.
 * SVG tooltips fit inside the chart width; HTML tooltips wrap using CSS. Both
 * use the same theme and show/hide contract. Call after the SVG viewBox is set.
 * @param {Document} documentContext Owning document.
 * @param {SVGSVGElement|HTMLElement} host Chart or positioned plot container.
 * @return {{element:SVGElement|HTMLElement,show:(text:string,anchorX?:number)=>void,hide:()=>void}} Tooltip and its display operations.
 */
export function createChartTooltip(documentContext, host) {
    const svg = host.namespaceURI === SVG_NAMESPACE;
    const element = svg ? createSvgElement(documentContext, "g", {"aria-hidden": "true"})
        : documentContext.createElement("div");
    element.classList.add("chart-tooltip");
    element.setAttribute("hidden", "");
    host.append(element);
    return {
        element,
        /** Show exact caller-formatted text beside an inspected value.
         * @param {string} text Tooltip text, with newlines separating rows.
         * @param {number} [anchorX=0] SVG anchor in chart pixels; HTML placement stays in CSS.
         * @return {void}
         */
        show(text, anchorX = 0) {
            if (svg) {
                const chartWidth = Number(host.getAttribute("viewBox").split(/\s+/)[2]);
                const width = Math.min(360, chartWidth - 8);
                const lines = text.split("\n");
                element.replaceChildren(createSvgElement(documentContext, "rect", {width, height: 10 + lines.length * 16, rx: 3}),
                    ...lines.map((line, index) => createSvgElement(documentContext, "text", {x: 8, y: 16 + index * 16}, line)));
                element.setAttribute("transform", `translate(${Math.max(4, Math.min(anchorX - width / 2, chartWidth - width - 4))} 4)`);
            } else element.textContent = text;
            element.removeAttribute("hidden");
        },
        /** Hide the tooltip without changing chart data. @return {void} */
        hide() { element.setAttribute("hidden", ""); },
    };
}

/** Give pointer and keyboard inspection one state and dismissal behavior.
 * A focused value remains inspected when the pointer leaves. Only pointer
 * movement replaces it, avoiding changes caused by scrolling under the pointer.
 * @template T
 * @param {SVGElement} element Focusable chart datum.
 * @param {T} inspection Caller-owned datum description.
 * @param {(inspection:T|null)=>void} onInspect Show or clear its details.
 * @param {{focused:T|null,hovered:T|null}} state Shared inspection state for this chart.
 * @return {void}
 */
export function bindChartInspection(element, inspection, onInspect, state) {
    element.addEventListener("focus", () => { state.focused = inspection; onInspect(inspection); });
    element.addEventListener("pointermove", () => { state.hovered = inspection; onInspect(inspection); });
    element.addEventListener("pointerleave", () => {
        if (state.hovered === inspection) state.hovered = null;
        onInspect(state.hovered ?? state.focused);
    });
    element.addEventListener("blur", () => {
        if (state.focused === inspection) state.focused = null;
        onInspect(state.focused ?? state.hovered);
    });
    element.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        state.focused = null; state.hovered = null; onInspect(null);
    });
}
