import { FakeRasterControlDocument } from "./raster/fake-controls-document.js";

/**
 * Track map backgrounds, controls, and attributions without loading network tiles.
 * @return {Object} Leaflet double, map, DOM, and captured calls.
 */
export function createLeafletDouble() {
    const document = new FakeRasterControlDocument();
    const calls = { map: null, setView: null, zoomControl: null, basemap: null,
        layers: [], controls: [], stoppedClicks: [], stoppedScrolls: [] };
    const panes = new Map(), attached = new Set(), attributions = new Map();
    const leafletMap = {
        attached, attributions,
        setView(center, zoom) { calls.setView = { center, zoom }; return this; },
        getContainer() { return { ownerDocument: document }; },
        getPane(name) { return panes.get(name); },
        createPane(name) { const pane = { style: {} }; panes.set(name, pane); return pane; },
        removeLayer(layer) {
            if (attached.delete(layer) && layer.options.attribution) {
                const text = layer.options.attribution;
                const count = attributions.get(text) - 1;
                if (count) attributions.set(text, count); else attributions.delete(text);
            }
            return this;
        },
    };
    /**
     * Create a background whose attachment updates only its own attribution.
     * @param {string} kind Background type.
     * @param {Object|string} data Geometry or tile URL.
     * @param {Object} options Leaflet layer options.
     * @return {Object} Layer double with tracked attachment.
     */
    function layer(kind, data, options) {
        const result = { kind, data, options, addTo(map) {
            if (!map.attached.has(this) && options.attribution) {
                map.attributions.set(options.attribution, (map.attributions.get(options.attribution) ?? 0) + 1);
            }
            map.attached.add(this);
            if (kind === "tiles") calls.basemap = { url: data, options, map };
            return this;
        } };
        calls.layers.push(result);
        return result;
    }
    const leaflet = {
        map(container, options) { calls.map = { container, options }; return leafletMap; },
        tileLayer(url, options) { return layer("tiles", url, options); },
        geoJSON(geometry, options) { return layer("outlines", geometry, options); },
        control(options) {
            const control = { options,
                addTo(map) { this.map = map; this.root = this.onAdd(map); calls.controls.push(this); return this; },
                getContainer() { return this.root; },
                remove() { this.onRemove(this.map); },
            };
            return control;
        },
        DomEvent: {
            disableClickPropagation(element) { calls.stoppedClicks.push(element); },
            disableScrollPropagation(element) { calls.stoppedScrolls.push(element); },
        },
    };
    leaflet.control.zoom = options => ({ addTo(map) {
        calls.zoomControl = { options, map }; return this;
    } });
    return { calls, leaflet, leafletMap, document };
}
