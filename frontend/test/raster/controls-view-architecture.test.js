import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FOCUSED_VIEW_IMPORTS = {
    "appearance-controls-view.js": ["./required-control.js", "./style.js"],
    "sampling-area-controls-view.js": ["./required-control.js"],
    "histogram-controls-view.js": [
        "./histogram-axis-controls.js",
        "./histogram-view.js",
        "./required-control.js",
        "./value-format.js",
    ],
    "percentile-controls-view.js": ["./required-control.js"],
    "style-histogram-view.js": [
        "./histogram-view.js",
        "./required-control.js",
    ],
    "bivariate-controls-view.js": [
        "./bivariate.js",
        "./histogram-axes.js",
        "./histogram-axis-controls.js",
        "./paired-statistics.js",
        "./required-control.js",
        "./value-format.js",
    ],
};

test("focused raster-control views depend only on DOM presentation providers", async () => {
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

test("RasterControlsView owns only composite DOM while composing focused views", async () => {
    const source = await readFile(
        new URL("../../src/raster/controls-view.js", import.meta.url),
        "utf8"
    );

    for (const moduleName of Object.keys(FOCUSED_VIEW_IMPORTS)) {
        assert.match(source, new RegExp(`from ["']\\./${moduleName}["']`));
    }
    assert.match(
        source,
        /import \{ requireRasterControl \} from "\.\/required-control\.js"/
    );
    assert.match(source, /"#raster-style-controls"/);
    assert.match(source, /"#raster-active-layer-label"/);
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
    assert.doesNotMatch(appearanceSource, /"#raster-style-controls"/);
    assert.doesNotMatch(appearanceSource, /"#raster-active-layer-label"/);
    assert.match(samplingSource, /"#raster-sampling-area-controls"/);
    assert.match(histogramSource, /"#raster-histogram"/);
    assert.doesNotMatch(histogramSource, /"#raster-percentile/);
    assert.doesNotMatch(histogramSource, /"#apply-raster-percentiles"/);
    assert.match(percentileSource, /"#raster-percentile-controls"/);
    assert.doesNotMatch(percentileSource, /"#raster-histogram"/);
    assert.match(styleHistogramSource, /"#raster-style-histogram"/);
    assert.doesNotMatch(styleHistogramSource, /"#raster-style-controls"/);
    assert.doesNotMatch(styleHistogramSource, /"#raster-percentile-controls"/);
    assert.match(bivariateSource, /"#raster-bivariate-controls"/);
    assert.match(bivariateSource, /"#raster-bivariate-statistics"/);
    assert.doesNotMatch(bivariateSource, /"#raster-(appearance|style-controls)"/);
});

test("histogram axis controls and transforms have only local presentation dependencies", async () => {
    for (const [moduleName, expected] of [
        ["histogram-axis-controls.js", ["./histogram-axis-scale.js", "./value-format.js"]],
        ["histogram-axis-scale.js", []],
    ]) {
        const source = await readFile(
            new URL(`../../src/raster/${moduleName}`, import.meta.url), "utf8"
        );
        const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
            .map(match => match[1]).sort();
        assert.deepEqual(imports, expected);
    }
});
