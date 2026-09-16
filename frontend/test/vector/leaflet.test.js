import assert from "node:assert/strict";
import test from "node:test";

import {
    createVectorWmsLayer,
    VECTOR_DEFAULT_SYMBOLOGY,
} from "../../src/vector/leaflet.js";

test("vector WMS uses one bounded layer and no raster environment", () => {
    let capturedRequest;
    let tileErrorHandler;
    const wmsLayer = {
        once(type, handler) {
            assert.equal(type, "tileerror");
            tileErrorHandler = handler;
        },
    };
    const leaflet = {
        tileLayer: {
            wms(url, options) {
                capturedRequest = { url, options };
                return wmsLayer;
            },
        },
    };
    let failures = 0;

    assert.equal(createVectorWmsLayer(
        leaflet,
        "/geoserver/eolab/wms",
        {
            layerName: "eolab:roads",
            bbox: [-123, 48, -122, 49],
            geometryKind: "line",
            styleName: "vector-line",
        },
        () => { failures += 1; }
    ), wmsLayer);
    assert.deepEqual(capturedRequest, {
        url: "/geoserver/eolab/wms",
        options: {
            layers: "eolab:roads",
            styles: "vector-line",
            format: "image/png",
            transparent: true,
            tiled: true,
            tilesorigin: "-20037508.342789244,-20037508.342789244",
            version: "1.3.0",
            noWrap: true,
            bounds: [[48, -123], [49, -122]],
        },
    });
    assert.equal("env" in capturedRequest.options, false);
    tileErrorHandler();
    assert.equal(failures, 1);
});

test("default vector geometry families use blue symbols with black outlines", () => {
    assert.deepEqual(VECTOR_DEFAULT_SYMBOLOGY, {
        point: { label: "Point", fill: "#2b83ba", stroke: "#000000" },
        line: { label: "Line", fill: "transparent", stroke: "#2b83ba" },
        polygon: { label: "Polygon", fill: "#2b83ba", stroke: "#000000" },
    });
});

test("crossing vector WMS retains both map edges without wrapping world copies", () => {
    let options;
    const layer = { once() {} };
    createVectorWmsLayer(
        { tileLayer: { wms(_url, candidate) { options = candidate; return layer; } } },
        "/geoserver/eolab/wms",
        { layerName: "eolab:pacific", styleName: "vector-polygon", bbox: [170, -10, -170, 10] },
        () => {},
    );
    assert.deepEqual(options.bounds, [[-10, -180], [10, 180]]);
    assert.equal(options.noWrap, true);
});
