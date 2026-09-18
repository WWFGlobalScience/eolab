/** Name and note labels shared by saved polygons and their editing drafts. */

/**
 * Keep a polygon's plain-text label at its current center after any geometry change.
 * Detached shapes get their label position from Leaflet when added to the map.
 * @param {Object} shape Leaflet polygon with tooltip support.
 * @param {import("./model.js").AnnotationPolygon} polygon Name, note and polygon identity.
 * @param {import("./model.js").AnnotationStyle} style Name and note visibility.
 * @param {Document} document Document that owns the map.
 * @param {HTMLElement|string} pane Leaflet pane for this label.
 * @return {void}
 */
export function updatePolygonLabel(shape, polygon, style, document, pane) {
    const showNote = style.notes && !!polygon.note.trim();
    if (!style.labels && !showNote) { shape.unbindTooltip(); return; }
    let label = shape.getTooltip()?.getContent();
    if (!label) {
        label = document.createElement("div");
        for (const name of ["name", "note"]) {
            const text = document.createElement("span");
            text.className = `annotation-polygon-${name}`;
            label.append(text);
        }
        shape.bindTooltip(label, { permanent: true, direction: "center", pane, className: "annotation-polygon-label" });
    }
    const name = label.querySelector(".annotation-polygon-name");
    const note = label.querySelector(".annotation-polygon-note");
    name.hidden = !style.labels;
    note.hidden = !showNote;
    if (name.textContent !== polygon.name) name.textContent = polygon.name;
    if (note.textContent !== polygon.note) note.textContent = polygon.note;
    if (shape.isTooltipOpen()) shape.getTooltip().setLatLng(shape.getCenter());
    shape.getTooltip().update();
}
