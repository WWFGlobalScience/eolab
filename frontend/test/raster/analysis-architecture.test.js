import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ANALYSIS_MODULES = [
    "analysis-api.js",
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

test("bivariate range presentation depends only on existing raster contracts and helpers", async () => {
    const source = await readFile(
        new URL("../../src/raster/bivariate-controls-view.js", import.meta.url), "utf8"
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
        .map((match) => match[1]).sort();
    assert.deepEqual(imports, [
        "./bivariate.js", "./histogram-axes.js", "./histogram-axis-controls.js", "./paired-statistics.js",
        "./required-control.js", "./value-format.js",
    ]);
});
