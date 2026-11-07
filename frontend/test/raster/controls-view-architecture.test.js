import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FOCUSED_VIEW_IMPORTS = {
    "appearance-controls-view.js": [
        "./categorical-editor-view.js", "./required-control.js", "./style.js",
    ],
    "sampling-area-controls-view.js": ["./required-control.js"],
    "histogram-controls-view.js": [
        "./categorical-histogram-view.js",
        "./histogram-axis-controls.js",
        "./histogram-view.js",
        "./percentile-controls-view.js",
        "./required-control.js",
    ],
    "percentile-controls-view.js": ["./statistics.js", "./value-format.js"],
    "style-histogram-view.js": [
        "./categorical-histogram-view.js",
        "./required-control.js",
    ],
    "bivariate-controls-view.js": [
        "./bivariate.js",
        "./histogram-axes.js",
        "./histogram-axis-controls.js",
        "./histogram-threshold-markers.js",
        "./paired-statistics.js",
        "./required-control.js",
        "./value-format.js",
    ],
};

test("histogram and series drawing share presentation code that knows no raster workflow", async () => {
    const root = new URL("../../src/", import.meta.url);
    for (const path of ["raster/histogram-view.js", "charts/series-chart.js"]) {
        const source = await readFile(new URL(path, root), "utf8");
        assert.match(source, /from ["'][^"']*chart-presentation\.js["']/);
    }
    const source = await readFile(new URL("charts/chart-presentation.js", root), "utf8");
    assert.deepEqual([...source.matchAll(/from ["']([^"']+)["']/g)].map(match => match[1]), ["d3"]);
});

test("focused raster-control views depend only on presentation and explicit result helpers", async () => {
    for (const [moduleName, expectedImports] of Object.entries(
        FOCUSED_VIEW_IMPORTS
    )) {
        const source = await readFile(
            new URL(`../../src/raster/${moduleName}`, import.meta.url),
            "utf8"
        );
        const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
            .map((match) => match[1])
            .sort();

        assert.deepEqual(
            imports,
            [...expectedImports].sort(),
            `${moduleName} imports only its lower-level presentation providers`
        );
    }
});

test("RasterControlsView delegates DOM ownership to focused views", async () => {
    const source = await readFile(
        new URL("../../src/raster/controls-view.js", import.meta.url),
        "utf8"
    );

    for (const moduleName of Object.keys(FOCUSED_VIEW_IMPORTS)) {
        if (moduleName === "percentile-controls-view.js") continue;
        assert.match(source, new RegExp(`from ["']\\./${moduleName}["']`));
    }
    assert.doesNotMatch(source, /requireRasterControl/);
    assert.doesNotMatch(source, /querySelector|addEventListener|removeEventListener/);
    assert.doesNotMatch(
        source,
        /"#raster-(palette|histogram|percentile|sample-window)/
    );
});

test("focused raster views validate only their semantic subgroup roots", async () => {
    const appearanceSource = await readFile(
        new URL(
            "../../src/raster/appearance-controls-view.js",
            import.meta.url
        ),
        "utf8"
    );
    const samplingSource = await readFile(
        new URL(
            "../../src/raster/sampling-area-controls-view.js",
            import.meta.url
        ),
        "utf8"
    );
    const histogramSource = await readFile(
        new URL(
            "../../src/raster/histogram-controls-view.js",
            import.meta.url
        ),
        "utf8"
    );
    const percentileSource = await readFile(
        new URL(
            "../../src/raster/percentile-controls-view.js",
            import.meta.url
        ),
        "utf8"
    );
    const styleHistogramSource = await readFile(
        new URL(
            "../../src/raster/style-histogram-view.js",
            import.meta.url
        ),
        "utf8"
    );
    const bivariateSource = await readFile(
        new URL(
            "../../src/raster/bivariate-controls-view.js",
            import.meta.url
        ),
        "utf8"
    );

    assert.match(appearanceSource, /"#raster-appearance-controls"/);
    assert.match(samplingSource, /"#raster-sampling-area-controls"/);
    assert.match(histogramSource, /"#raster-histogram"/);
    assert.doesNotMatch(histogramSource, /"#raster-percentile/);
    assert.doesNotMatch(histogramSource, /"#apply-raster-percentiles"/);
    assert.doesNotMatch(percentileSource, /requireRasterControl|fetch\(|GeoServer/);
    assert.doesNotMatch(percentileSource, /"#raster-histogram"/);
    assert.match(styleHistogramSource, /"#raster-style-histogram"/);
    assert.doesNotMatch(styleHistogramSource, /"#raster-percentile-controls"/);
    assert.match(bivariateSource, /"#raster-bivariate-controls"/);
    assert.match(bivariateSource, /"#raster-bivariate-statistics"/);
    assert.doesNotMatch(bivariateSource, /"#raster-appearance-controls"/);
});

test("histogram axis controls, transforms and markers have only local presentation dependencies", async () => {
    for (const [moduleName, expected] of [
        ["histogram-axis-controls.js", ["./histogram-axis-scale.js", "./value-format.js"]],
        ["histogram-axis-scale.js", []],
        ["histogram-threshold-markers.js", []],
    ]) {
        const source = await readFile(
            new URL(`../../src/raster/${moduleName}`, import.meta.url), "utf8"
        );
        const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
            .map(match => match[1]).sort();
        assert.deepEqual(imports, expected);
    }
});

test("category editor depends only on its local input contract and DOM lookup", async () => {
    const source = await readFile(
        new URL("../../src/raster/categorical-editor-view.js", import.meta.url), "utf8"
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
        .map(match => match[1]).sort();
    assert.deepEqual(imports, ["./categorical-csv.js", "./categorical-style.js", "./required-control.js"]);
    assert.match(source, /"#raster-categorical-editor"/);
    assert.doesNotMatch(source, /"#raster-(histogram|percentile|style-controls)/);
    assert.doesNotMatch(source, /fetch\(|localStorage|Leaflet/);
});

test("raster category CSV depends on its appearance owner and neutral bounded syntax", async () => {
    const source = await readFile(
        new URL("../../src/raster/categorical-csv.js", import.meta.url), "utf8"
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
        .map(match => match[1]);
    assert.deepEqual(imports, ["./categorical-style.js", "../category-csv.js"]);
    assert.doesNotMatch(source, /fetch\(|localStorage|document\.|FileReader|GeoServer/);
});
