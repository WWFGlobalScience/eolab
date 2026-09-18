/** Leaflet drawing gestures and visible editing-mode instructions. */

/** Render one polygon draft and forward editing gestures to its owner. */
export class AnnotationMapEditor {
    /**
     * Attach the editing strip and map listeners without entering editing mode.
     * @param {Object} options Editor dependencies and intent callbacks.
     * @param {Object} options.leaflet Leaflet namespace.
     * @param {Object} options.map Leaflet map.
     * @param {(point:number[])=>void} options.onAdd Add a longitude/latitude vertex.
     * @param {(index:number,point:number[])=>void} options.onMove Move a vertex.
     * @param {(index:number)=>void} options.onDelete Delete a vertex or the first-vertex polygon.
     * @param {()=>void} options.onSave Save the current draft.
     * @param {()=>void} options.onCancel Discard the current draft.
     */
    constructor({ leaflet, map, onAdd, onMove, onDelete, onSave, onCancel }) {
        this.leaflet = leaflet;
        this.map = map;
        this.onMove = onMove;
        this.onDelete = onDelete;
        this.onSave = onSave;
        this.onCancel = onCancel;
        this.draft = null;
        this.polygonDrag = null;
        this.suppressClick = false;
        this.vertexMarkers = [];
        this.drawing = leaflet.layerGroup();
        this.document = map.getContainer().ownerDocument;
        this.strip = this.document.createElement("section");
        this.strip.className = "annotation-editor-strip";
        this.strip.setAttribute("aria-label", "Polygon editor");
        this.strip.hidden = true;
        this.heading = this.document.createElement("strong");
        this.heading.textContent = "Layer editing";
        this.instruction = this.document.createElement("p");
        this.instruction.setAttribute("role", "status");
        this.error = this.document.createElement("p");
        this.error.className = "annotation-error";
        this.error.setAttribute("role", "alert");
        const actions = this.document.createElement("div");
        actions.className = "annotation-actions";
        this.save = this.button("Finish polygon", onSave);
        this.cancel = this.button("Cancel", onCancel);
        this.remove = this.button("Delete polygon", () => onDelete(0));
        actions.append(this.save, this.cancel, this.remove);
        const help = this.document.createElement("details");
        const summary = this.document.createElement("summary");
        summary.textContent = "Drawing help";
        const text = this.document.createElement("p");
        text.textContent = "Left-click to add vertices. Drag a vertex to reshape, or drag inside the polygon to move it. Drag outside the polygon to pan. Scroll to zoom. Right-click a gray vertex to delete it. Click the blue first vertex to finish; right-click it to delete the polygon and return to inspection. Keyboard: Tab to a vertex, arrows to move it, Delete to remove it, Enter on the first vertex to finish. Escape cancels.";
        help.append(summary, text);
        this.strip.append(this.heading, this.instruction, actions, this.error, help);
        map.getContainer().append(this.strip);
        leaflet.DomEvent.disableClickPropagation(this.strip);
        leaflet.DomEvent.disableScrollPropagation(this.strip);
        this.click = event => {
            if (this.draft && !this.polygonDrag && !this.suppressClick) onAdd([event.latlng.lng, event.latlng.lat]);
        };
        this.keydown = event => {
            if (this.draft && event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
            }
        };
        this.cancelDrag = () => {
            if (this.polygonDrag) { this.finishPolygonDrag(true); this.render(this.draft); }
        };
        map.on("zoomstart", this.cancelDrag);
        this.document.defaultView.addEventListener("blur", this.cancelDrag);
        map.on("click", this.click);
        this.document.addEventListener("keydown", this.keydown, true);
    }

    /**
     * Create an accessible editing-strip button.
     * @param {string} label Visible action label.
     * @param {()=>void} action Editing intent.
     * @return {HTMLButtonElement} Button.
     */
    button(label, action) {
        const button = this.document.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = label;
        button.addEventListener("click", action);
        return button;
    }

    /**
     * Draw editable vertices and a draggable polygon interior; leave outside-map gestures available.
     * @param {import("./model.js").PolygonDraft|null} draft Polygon draft, or null to return to inspection.
     * @param {string} [message=""] Validation error to show beside the controls.
     * @return {void}
     */
    render(draft, message = "") {
        const entering = !this.draft && !!draft;
        const leaving = !!this.draft && !draft;
        if (entering) {
            this.restoreDoubleClickZoom = this.map.doubleClickZoom.enabled();
            this.map.doubleClickZoom.disable();
            this.previousFocus = this.document.activeElement;
        }
        if (leaving && this.restoreDoubleClickZoom) this.map.doubleClickZoom.enable();
        this.finishPolygonDrag(true);
        this.draft = draft;
        this.strip.hidden = !draft;
        this.map.getContainer().classList.toggle("is-editing-annotation", !!draft);
        this.drawing.clearLayers();
        this.vertexMarkers = [];
        this.error.textContent = message;
        if (!draft) {
            this.map.removeLayer(this.drawing);
            if (leaving && this.previousFocus?.isConnected) this.previousFocus.focus();
            return;
        }
        this.drawing.addTo(this.map);
        const vertices = draft.polygon.vertices;
        this.save.textContent = draft.isNew ? "Finish polygon" : "Save changes";
        this.remove.disabled = vertices.length === 0;
        this.instruction.textContent = vertices.length === 0 ? "Click on the map to start a polygon."
            : vertices.length < 3 ? `${vertices.length} ${vertices.length === 1 ? "vertex" : "vertices"} — click to add more; drag to adjust.`
            : "Click the blue first vertex to finish. Drag inside to move the polygon; drag outside to pan.";
        const latlngs = vertices.map(([lng, lat]) => [lat, lng]);
        if (vertices.length > 0) {
            const draggable = vertices.length >= 3;
            const options = { color: "#087fbe", weight: 2, fillOpacity: 0.15, dashArray: "5 4",
                interactive: draggable, bubblingMouseEvents: false, className: "annotation-draft-polygon" };
            const shape = draggable ? this.leaflet.polygon(latlngs, options) : this.leaflet.polyline(latlngs, options);
            shape.addTo(this.drawing);
            if (draggable) {
                const element = shape.getElement();
                element.addEventListener("pointerdown", event => this.startPolygonDrag(event, shape));
                element.addEventListener("pointermove", event => this.movePolygon(event));
                element.addEventListener("pointerup", event => {
                    if (this.polygonDrag?.pointerId !== event.pointerId) return;
                    this.movePolygon(event);
                    const moved = this.polygonDrag.moved;
                    this.finishPolygonDrag(false);
                    // Keep the original target until its click arrives; a drag is never an added vertex.
                    if (moved) this.render(this.draft);
                });
                element.addEventListener("pointercancel", this.cancelDrag);
                element.addEventListener("lostpointercapture", this.cancelDrag);
                shape.on("click", this.click);
            }
        }
        vertices.forEach((point, index) => this.addVertexMarker(point, index));
        if (entering) this.cancel.focus({ preventScroll: true });
    }

    /**
     * Add one draggable, keyboard-operable vertex to the draft display.
     * @param {number[]} point Longitude and latitude.
     * @param {number} index Vertex index; zero is the blue closing vertex.
     * @return {void}
     */
    addVertexMarker(point, index) {
        const marker = this.leaflet.marker([point[1], point[0]], {
            draggable: true, keyboard: true, bubblingMouseEvents: false,
            zIndexOffset: 1000,
            icon: this.leaflet.divIcon({ className: `annotation-vertex${index === 0 ? " is-first" : ""}`,
                iconSize: [18, 18], iconAnchor: [9, 9], html: "" }),
        }).addTo(this.drawing);
        this.vertexMarkers.push(marker);
        const element = marker.getElement();
        element.setAttribute("aria-label", index === 0 ? "First vertex: activate to finish; Delete removes polygon" : `Vertex ${index + 1}`);
        element.title = index === 0 ? "Click to finish. Right-click to delete polygon." : "Drag to move. Right-click to delete vertex.";
        marker.on("click", event => { this.leaflet.DomEvent.stopPropagation(event); if (index === 0) this.onSave(); });
        marker.on("contextmenu", event => {
            this.leaflet.DomEvent.stop(event.originalEvent);
            this.onDelete(index);
        });
        marker.on("drag", () => {
            const position = marker.getLatLng();
            // Update only the draft; rebuilding markers during drag loses pointer capture.
            this.draft.polygon.vertices[index] = [position.lng, position.lat];
            this.drawing.eachLayer(layer => {
                if (layer.setLatLngs) layer.setLatLngs(this.draft.polygon.vertices.map(([lng, lat]) => [lat, lng]));
            });
        });
        marker.on("dragend", () => {
            const position = marker.getLatLng();
            this.onMove(index, [position.lng, position.lat]);
        });
        element.addEventListener("keydown", event => {
            if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault(); event.stopPropagation(); this.onDelete(index);
            } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                const position = this.map.latLngToContainerPoint(marker.getLatLng());
                position.x += event.key === "ArrowLeft" ? -4 : event.key === "ArrowRight" ? 4 : 0;
                position.y += event.key === "ArrowUp" ? -4 : event.key === "ArrowDown" ? 4 : 0;
                const moved = this.map.containerPointToLatLng(position);
                this.onMove(index, [moved.lng, moved.lat]);
                this.vertexMarkers[index]?.getElement()?.focus();
            }
        });
    }

    /**
     * Capture a primary pointer inside the polygon and temporarily suspend map dragging.
     * @param {PointerEvent} event Pointer press on the draft's filled interior.
     * @param {Object} shape Leaflet polygon that will preview the translation.
     * @return {void}
     */
    startPolygonDrag(event, shape) {
        if (event.button !== 0 || !event.isPrimary || this.polygonDrag) return;
        event.preventDefault();
        event.stopPropagation();
        const zoom = this.map.getZoom();
        const vertices = this.draft.polygon.vertices;
        this.polygonDrag = { pointerId: event.pointerId, element: event.currentTarget, shape,
            start: this.map.mouseEventToContainerPoint(event), zoom, vertices,
            projected: vertices.map(([lng, lat]) => this.map.project([lat, lng], zoom)),
            restoreMapDragging: this.map.dragging.enabled(), moved: false };
        this.map.dragging.disable();
        this.polygonDrag.element.setPointerCapture(event.pointerId);
        this.map.getContainer().classList.add("is-dragging-annotation");
    }

    /**
     * Translate all draft vertices by the same map-pixel offset, preserving its displayed shape.
     * @param {PointerEvent} event Movement of the captured pointer.
     * @return {void}
     */
    movePolygon(event) {
        const drag = this.polygonDrag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const offset = this.map.mouseEventToContainerPoint(event).subtract(drag.start);
        if (!drag.moved && Math.hypot(offset.x, offset.y) < 3) return;
        drag.moved = true;
        const positions = drag.projected.map(point => this.map.unproject(point.add(offset), drag.zoom));
        this.draft.polygon.vertices = positions.map(point => [point.lng, point.lat]);
        drag.shape.setLatLngs(positions);
        positions.forEach((point, index) => this.vertexMarkers[index].setLatLng(point));
    }

    /**
     * End a polygon drag, restoring pointer ownership and optionally undoing just this gesture.
     * Saved polygons remain unchanged until the user finishes editing.
     * @param {boolean} cancelled Whether to restore the vertices from before the drag.
     * @return {void}
     */
    finishPolygonDrag(cancelled) {
        const drag = this.polygonDrag;
        if (!drag) return;
        this.polygonDrag = null;
        if (cancelled) this.draft.polygon.vertices = drag.vertices;
        if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
        if (drag.restoreMapDragging) this.map.dragging.enable();
        this.map.getContainer().classList.remove("is-dragging-annotation");
        if (drag.moved) {
            this.suppressClick = true;
            clearTimeout(this.clickReset);
            this.clickReset = setTimeout(() => { this.suppressClick = false; }, 0);
        }
    }

    /** Release map listeners, draft markers and editing-mode presentation. @return {void} */
    destroy() {
        this.render(null);
        this.map.off("click", this.click);
        this.map.off("zoomstart", this.cancelDrag);
        this.document.defaultView.removeEventListener("blur", this.cancelDrag);
        clearTimeout(this.clickReset);
        this.document.removeEventListener("keydown", this.keydown, true);
        this.strip.remove();
    }
}
