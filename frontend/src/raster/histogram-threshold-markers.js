/** Render inspectable percentile markers at the edge of a histogram. */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * @typedef {{id:string,label:string,description:string,position:number,value:number,color:string}} ThresholdMarker
 * A threshold's stable name, short glyph, accessible description, exact chart coordinate, value and style color.
 */

/** Create an SVG element with chart coordinates and presentation attributes.
 * @param {Document} documentContext Owning document.
 * @param {string} name SVG element name.
 * @param {Record<string,string|number>} attributes SVG attributes.
 * @return {SVGElement} Detached element.
 */
function createMarkerElement(documentContext, name, attributes) {
    const element = documentContext.createElementNS(SVG_NAMESPACE, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
}

/**
 * Append keyboard-focusable glyphs, short ticks, and hover/focus guides.
 * Keep adjacent glyphs apart even when their exact guides share a coordinate.
 * @param {Document} documentContext Owning document.
 * @param {SVGElement} group Marker layer.
 * @param {ThresholdMarker[]} markers Thresholds in reading order.
 * @param {{axis:"x"|"y",edge:number,guideEnd:number,minimum:number,maximum:number,glyphSize:number}} layout
 * The plot edge and opposite guide endpoint, label track bounds, and glyph size in SVG units.
 * @return {SVGElement[]} Appended marker targets in reading order.
 */
export function appendHistogramThresholdMarkers(documentContext, group, markers, layout) {
    const {axis, edge, guideEnd, minimum, maximum, glyphSize} = layout;
    const above = axis === "x";
    const gap = glyphSize + 4;
    const ordered = markers.map(marker => ({marker, position: marker.position}))
        .sort((left, right) => left.position - right.position);
    let next = minimum;
    for (const entry of ordered) {
        entry.position = Math.max(next, entry.position);
        next = entry.position + gap;
    }
    next = maximum;
    for (const entry of ordered.toReversed()) {
        entry.position = Math.min(next, entry.position);
        next = entry.position - gap;
    }
    const labelPositions = new Map(ordered.map(({marker, position}) => [marker, position]));
    const tickLength = 4;
    const targetSize = glyphSize + 2;
    const targets = markers.map(marker => {
        const labelPosition = labelPositions.get(marker);
        const target = createMarkerElement(documentContext, "g", {
            class: "raster-histogram-threshold-marker",
            tabindex: 0, role: "img", "aria-label": marker.description,
            "data-threshold-id": `${axis}:${marker.id}`,
            "data-threshold": marker.id, "data-value": marker.value,
        });
        const guide = createMarkerElement(documentContext, "line", {
            class: "raster-histogram-threshold-guide", "aria-hidden": "true",
            ...(above
                ? {x1: marker.position, x2: marker.position, y1: edge, y2: guideEnd}
                : {x1: edge, x2: guideEnd, y1: marker.position, y2: marker.position}),
        });
        const tick = createMarkerElement(documentContext, "line", {
            class: "raster-histogram-threshold-tick", "aria-hidden": "true",
            ...(above
                ? {x1: marker.position, x2: marker.position, y1: edge - tickLength, y2: edge}
                : {x1: edge + tickLength, x2: edge, y1: marker.position, y2: marker.position}),
        });
        guide.style.stroke = tick.style.stroke = marker.color;
        const hitArea = createMarkerElement(documentContext, "rect", {
            class: "raster-histogram-threshold-target", "aria-hidden": "true", rx: 2,
            ...(above
                ? {x: labelPosition - targetSize / 2, y: edge - glyphSize - 5, width: targetSize, height: glyphSize + 5}
                : {x: edge, y: labelPosition - targetSize / 2, width: glyphSize + 7, height: targetSize}),
        });
        const label = createMarkerElement(documentContext, "text", {
            class: "raster-histogram-threshold-label", "aria-hidden": "true", "font-size": glyphSize,
            x: above ? labelPosition : edge + tickLength + glyphSize / 2,
            y: above ? edge - tickLength - 1 : labelPosition + glyphSize / 3,
        });
        label.textContent = marker.label;
        target.append(guide, tick, hitArea, label);
        return target;
    });
    group.append(...targets);
    return targets;
}
