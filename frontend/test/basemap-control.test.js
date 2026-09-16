import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { addBasemapControl } from "../src/basemap-control.js";
import { createLeafletDouble } from "../test-support/fake-basemap-leaflet.js";

const configured = { url: "https://tiles.example/{z}/{x}/{y}.png", attribution: "Detailed attribution" };
const bounds = [[-90, -180], [90, 180]];
const carto = { url: "https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=test-key",
    attribution: "CARTO and OSM", maxNativeZoom: 20 };
const geometry = { type: "FeatureCollection", features: [] };

/**
 * Dispatch the user's choice and await pending promise continuations.
 * @param {Object} control Mounted basemap control double.
 * @param {string} value Selected background identifier.
 * @return {Promise<void>} Settles after pending selection callbacks.
 */
async function choose(control, value) {
    const select = control.getContainer().children[0].children[1];
    select.value = value;
    select.dispatchEvent(new Event("change"));
    await new Promise(resolve => setImmediate(resolve));
}

test("basemap control starts with configured tiles and omits unconfigured CARTO", () => {
    const { leaflet, leafletMap: map, calls } = createLeafletDouble();
    const control = addBasemapControl(leaflet, map, configured, bounds);
    const select = control.root.children[0].children[1];
    assert.equal(control.options.position, "bottomright");
    assert.equal(select.getAttribute("aria-label"), "Basemap");
    assert.deepEqual(select.children.map(option => option.value), ["detailed", "outlines", "none"]);
    assert.equal(select.value, "detailed");
    assert.equal(calls.layers.length, 1);
    assert.equal(calls.basemap.url, configured.url);
    assert.equal(calls.basemap.options.maxNativeZoom, 17);
    assert.equal(map.getPane("eolab-basemap-pane").style.zIndex, "150");
    assert.equal(map.getPane("eolab-basemap-pane").style.pointerEvents, "none");
    assert.deepEqual(calls.stoppedClicks, [control.root]);
    assert.deepEqual(calls.stoppedScrolls, [control.root]);
    control.remove();
});

test("switching and None affect only backgrounds and keep other attributions and viewport", async () => {
    const { leaflet, leafletMap: map, calls } = createLeafletDouble();
    const dataLayer = leaflet.tileLayer("data", { attribution: "Data source" }).addTo(map);
    map.setView([12, 34], 7);
    const viewport = calls.setView;
    const control = addBasemapControl(leaflet, map, { ...configured, carto }, bounds);
    assert.equal(calls.layers.length, 2, "CARTO is not requested before selection");
    await choose(control, "carto");
    assert.equal(calls.basemap.url, carto.url);
    assert.equal(calls.basemap.options.maxNativeZoom, 20);
    assert.equal(calls.basemap.options.maxZoom, 22);
    assert.equal(calls.basemap.options.noWrap, true);
    assert.deepEqual(calls.basemap.options.bounds, bounds);
    assert.deepEqual([...map.attributions.keys()], ["Data source", carto.attribution]);
    for (let i = 0; i < 4; i++) {
        await choose(control, "none");
        assert.deepEqual([...map.attached], [dataLayer]);
        assert.deepEqual([...map.attributions.keys()], ["Data source"]);
        await choose(control, "detailed");
        assert.equal(map.attached.size, 2);
        await choose(control, "carto");
    }
    assert.equal(calls.layers.length, 3, "switching reuses at most one layer per background");
    assert.equal(calls.controls.length, 1);
    assert.equal(calls.setView, viewport);
    control.remove();
    assert.deepEqual([...map.attached], [dataLayer]);
    await choose(control, "detailed");
    assert.deepEqual([...map.attached], [dataLayer], "removed controls have no change listener");
});

test("outlines load locally on demand, remain below overlays, and are reused", async () => {
    const { leaflet, leafletMap: map, calls } = createLeafletDouble();
    const requests = [];
    const control = addBasemapControl(leaflet, map, configured, bounds, async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => geometry };
    });
    assert.equal(requests.length, 0);
    await choose(control, "outlines");
    assert.equal(requests.length, 1);
    assert.match(requests[0].url.pathname, /assets\/country-outlines\.geojson$/);
    const layer = [...map.attached][0];
    assert.equal(layer.kind, "outlines");
    assert.equal(layer.options.interactive, false);
    assert.equal(layer.options.pane, "eolab-basemap-pane");
    assert.equal(layer.options.style.fill, false);
    assert.match([...map.attributions.keys()][0], /Natural Earth/);
    await choose(control, "none");
    await choose(control, "outlines");
    assert.equal(requests.length, 1);
    assert.equal(calls.layers.length, 2);
    assert.equal([...map.attached][0], layer);
    control.remove();
});

test("late outline responses cannot replace None or a removed map control", async () => {
    for (const remove of [false, true]) {
        const { leaflet, leafletMap: map, calls } = createLeafletDouble();
        let finish, signal;
        const control = addBasemapControl(leaflet, map, configured, bounds, (url, options) => {
            signal = options.signal;
            return new Promise(resolve => { finish = resolve; });
        });
        await choose(control, "outlines");
        assert.equal(control.root.children[1].textContent, "Loading country outlines…");
        if (remove) control.remove(); else await choose(control, "none");
        assert.equal(signal.aborted, true);
        finish({ ok: true, json: async () => geometry });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(map.attached.size, 0);
        assert.equal(calls.layers.length, 1, "canceled load does not create a vector layer");
    }
});

test("outline load failure shows a retryable message and leaves None selected", async () => {
    const { leaflet, leafletMap: map } = createLeafletDouble();
    let fail = true;
    const control = addBasemapControl(leaflet, map, configured, bounds, async () => {
        if (fail) return { ok: false };
        return { ok: true, json: async () => geometry };
    });
    await choose(control, "outlines");
    assert.equal(control.root.children[0].children[1].value, "none");
    assert.match(control.root.children[1].textContent, /unavailable.*retry/);
    assert.equal(map.attached.size, 0);
    fail = false;
    await choose(control, "outlines");
    assert.equal(map.attached.size, 1);
    assert.equal(control.root.children[1].hidden, true);
    control.remove();
});

test("bundled Natural Earth outlines contain only display polygons in one world", async () => {
    const data = JSON.parse(await readFile(new URL("../src/assets/country-outlines.geojson", import.meta.url), "utf8"));
    assert.equal(data.type, "FeatureCollection");
    assert.equal(data.features.length, 177);
    for (const feature of data.features) {
        assert.deepEqual(feature.properties, {});
        assert.ok(["Polygon", "MultiPolygon"].includes(feature.geometry.type));
        const rings = feature.geometry.type === "Polygon" ? feature.geometry.coordinates : feature.geometry.coordinates.flat();
        for (const ring of rings) {
            assert.deepEqual(ring[0], ring.at(-1));
            for (const [longitude, latitude] of ring) {
                assert.ok(Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90);
            }
        }
    }
});

test("background selection has no catalog, analysis, or data-layer dependencies", async () => {
    const source = await readFile(new URL("../src/basemap-control.js", import.meta.url), "utf8");
    assert.equal([...source.matchAll(/^import\s/gm)].length, 0);
});
