/**
 * Map-background selector. Basemaps stay below data layers and never take part
 * in catalog selection or analysis.
 */

const OUTLINES_URL = new URL("./assets/country-outlines.geojson", import.meta.url);
const ERROR_TILE_URL = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22/%3E";

/**
 * Add a labeled basemap dropdown to the lower-right map corner.
 * The configured detailed map is selected initially. Country outlines are a
 * bundled display asset fetched only when selected; None removes the background.
 *
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} map Initialized Leaflet map.
 * @param {{url:string,attribution:string,carto?:{url:string,attribution:string,maxNativeZoom:number}}} configuration Browser-safe tile settings.
 * @param {number[][]} bounds Canonical single-world bounds.
 * @param {typeof fetch} [fetchAsset=globalThis.fetch] Static outline asset reader.
 * @return {Object} Leaflet control; removing it cancels loading and removes its background.
 */
export function addBasemapControl(leaflet, map, configuration, bounds, fetchAsset = globalThis.fetch) {
    const paneName = "eolab-basemap-pane";
    const pane = map.getPane(paneName) ?? map.createPane(paneName);
    pane.style.zIndex = "150";
    pane.style.pointerEvents = "none";

    const layers = new Map();
    let activeLayer = null;
    let pending = null;
    let select, status;
    const control = leaflet.control({ position: "bottomright" });

    /**
     * Create one single-world tile background from its configured provider.
     * @param {{url:string,attribution:string,maxNativeZoom?:number}} settings Provider settings.
     * @return {Object} Detached Leaflet tile layer.
     */
    function tileBackground(settings) {
        return leaflet.tileLayer(settings.url, {
            attribution: settings.attribution,
            pane: paneName,
            className: "eolab-basemap",
            errorTileUrl: ERROR_TILE_URL,
            maxZoom: 22,
            maxNativeZoom: settings.maxNativeZoom ?? 17,
            noWrap: true,
            bounds,
        });
    }

    /**
     * Replace only this control's background, preserving viewport and all data layers.
     * Cancel obsolete outline loads so late responses cannot restore an old choice.
     * @param {string} id Selected option identifier.
     * @return {Promise<void>} Settles after the background is attached or a load error is shown.
     */
    async function selectBasemap(id) {
        pending?.abort();
        pending = null;
        if (activeLayer) map.removeLayer(activeLayer);
        activeLayer = null;
        status.textContent = "";
        status.hidden = true;
        select.removeAttribute("aria-busy");
        if (id === "none") return;

        if (!layers.has(id)) {
            if (id === "outlines") {
                const request = new AbortController();
                pending = request;
                status.hidden = false;
                status.textContent = "Loading country outlines…";
                select.setAttribute("aria-busy", "true");
                try {
                    const response = await fetchAsset(OUTLINES_URL, { signal: request.signal });
                    if (!response.ok) throw new Error("Outline asset unavailable");
                    const geometry = await response.json();
                    if (request.signal.aborted) return;
                    layers.set(id, leaflet.geoJSON(geometry, {
                        pane: paneName,
                        interactive: false,
                        attribution: '<a href="https://www.naturalearthdata.com/">Natural Earth</a>',
                        style: { color: "#8a9199", weight: 0.8, opacity: 1, fill: false },
                    }));
                } catch {
                    if (request.signal.aborted) return;
                    select.value = "none";
                    status.textContent = "Country outlines unavailable. Select them again to retry.";
                    return;
                } finally {
                    if (pending === request) {
                        pending = null;
                        select.removeAttribute("aria-busy");
                    }
                }
            } else {
                layers.set(id, tileBackground(id === "carto" ? configuration.carto : configuration));
            }
        }
        activeLayer = layers.get(id);
        activeLayer.addTo(map);
        status.textContent = "";
        status.hidden = true;
    }

    /** Apply the dropdown's selected background. @return {void} */
    function applySelectedBasemap() {
        void selectBasemap(select.value);
    }

    /**
     * Keep keyboard interaction with the dropdown from panning the map.
     * @param {KeyboardEvent} event Control key event.
     * @return {void}
     */
    function stopMapKeys(event) {
        event.stopPropagation();
    }

    /** Build the map control with standard labeled HTML inputs. @return {HTMLElement} */
    control.onAdd = function onAdd() {
        const doc = map.getContainer().ownerDocument;
        const root = doc.createElement("div");
        root.className = "eolab-basemap-control";
        const label = doc.createElement("label");
        const caption = doc.createElement("span");
        caption.textContent = "Basemap";
        select = doc.createElement("select");
        select.setAttribute("aria-label", "Basemap");
        const options = [
            ["detailed", "Detailed"],
            ...(configuration.carto ? [["carto", "Light (CARTO)"]] : []),
            ["outlines", "Country outlines"],
            ["none", "None"],
        ];
        for (const [id, text] of options) {
            const option = doc.createElement("option");
            option.value = id;
            option.textContent = text;
            select.append(option);
        }
        select.value = "detailed";
        status = doc.createElement("p");
        status.setAttribute("role", "status");
        status.hidden = true;
        label.append(caption, select);
        root.append(label, status);
        leaflet.DomEvent.disableClickPropagation(root);
        leaflet.DomEvent.disableScrollPropagation(root);
        root.addEventListener("keydown", stopMapKeys);
        select.addEventListener("change", applySelectedBasemap);
        void selectBasemap("detailed");
        return root;
    };

    /** Release pending work, listeners, and the active background. @return {void} */
    control.onRemove = function onRemove() {
        pending?.abort();
        pending = null;
        select.removeEventListener("change", applySelectedBasemap);
        control.getContainer().removeEventListener("keydown", stopMapKeys);
        if (activeLayer) map.removeLayer(activeLayer);
        activeLayer = null;
        layers.clear();
    };
    return control.addTo(map);
}
