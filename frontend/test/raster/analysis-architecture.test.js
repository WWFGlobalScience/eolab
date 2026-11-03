import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ANALYSIS_MODULES = [
    "analysis-api.js",
    "categorical-statistics.js",
    "cursor-samples.js",
    "paired-statistics.js",
    "point-samples.js",
    "statistics-controller.js",
    "statistics.js",
    "value-format.js",
];
const RENDERING_IMPORTS = [
    "../map-layers/",
    "./api.js",
    "./leaflet.js",
    "./wms.js",
    "../map.js",
];

test("raster analysis remains independent from rendering implementations", async () => {
    for (const moduleName of ANALYSIS_MODULES) {
        const source = await readFile(
            new URL(`../../src/raster/${moduleName}`, import.meta.url),
            "utf8"
        );
        const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
            .map((match) => match[1]);

        assert.equal(
            imports.find((modulePath) => RENDERING_IMPORTS.some(
                (prefix) => modulePath.startsWith(prefix)
            )),
            undefined,
            `${moduleName} does not import a raster-rendering implementation`
        );
    }
});

test("statistics reuse Processing execution without importing raster-stack UI or rendering owners", async () => {
    for (const moduleName of ["raster-series-calculations.js"]) {
        const source = await readFile(new URL(`../../src/processing/${moduleName}`, import.meta.url), "utf8");
        const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
        assert.equal(imports.find(path => path.startsWith("../raster/") || path.startsWith("../map-layers/") ||
            path.endsWith("-view.js") || path.includes("map-inspection") || path.endsWith("/map.js")), undefined,
        `${moduleName} uses Processing providers and composed inputs, not sibling implementation state`);
    }
});

test("numeric raster analysis does not depend on categorical appearance or presentation", async () => {
    const presentationModules = new Set([
        "./categorical-presentation.js",
        "./categorical-style.js",
        "./appearance-state.js",
        "./style.js",
        "./raster-viewer.js",
    ]);
    for (const moduleName of ANALYSIS_MODULES) {
        const source = await readFile(
            new URL(`../../src/raster/${moduleName}`, import.meta.url), "utf8"
        );
        const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
            .map(match => match[1]);
        assert.equal(
            imports.find(modulePath => presentationModules.has(modulePath) ||
                modulePath.endsWith("-view.js")),
            undefined,
            `${moduleName} keeps numeric results independent of appearance and DOM views`
        );
    }
});

test("cursor readout owns only DOM presentation and neutral value formatting", async () => {
    const source = await readFile(
        new URL("../../src/raster/cursor-values-view.js", import.meta.url),
        "utf8"
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
        .map((match) => match[1]).sort();
    assert.deepEqual(imports, ["./required-control.js", "./value-format.js"]);
    const markup = await readFile(new URL("../../index.html", import.meta.url), "utf8");
    assert.match(markup, /id="raster-cursor-marker"[^>]*aria-hidden="true"[^>]*hidden/);
    assert.match(markup, /id="raster-cursor-pending"/);
});
