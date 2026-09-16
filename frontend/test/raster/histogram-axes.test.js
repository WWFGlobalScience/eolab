import assert from "node:assert/strict";
import test from "node:test";
import { formatHistogramTick, getHistogramValueLabel, histogramScales } from "../../src/raster/histogram-axes.js";
import { RASTER_STATISTICS } from "../../test-support/raster/fixtures.js";

/** Build consistent histogram edges and counts for scale edge cases. */
function distribution(minimum, maximum, counts = new Array(64).fill(1)) {
    return { ...RASTER_STATISTICS, validSampleCount: counts.reduce((a, b) => a + b, 0),
        histogram: { counts, edges: Array.from({ length: 65 }, (_, index) => minimum + (maximum - minimum) * index / 64) } };
}

test("ordinary ticks are decimal, tiny and large ticks stay distinct", () => {
    assert.equal(formatHistogramTick(0.8125, 0.3), "0.81");
    assert.equal(formatHistogramTick(2.099, 0.3), "2.1");
    assert.equal(formatHistogramTick(-1e-17, 0.1), "0");
    assert.equal(formatHistogramTick(1e-12, 1e-13), "1e-12");
    assert.equal(formatHistogramTick(2e12, 1e11), "2e12");
    for (const [minimum, maximum] of [[-10, 30], [0.8125, 2.099], [-2e-12, 3e-12], [1e12, 1e12 + 1], [-1e12, -1e12 + 1]]) {
        const scale = histogramScales(distribution(minimum, maximum), 230);
        assert.equal(new Set(scale.ticks.map(t => t.label)).size, scale.ticks.length);
        assert.ok(scale.ticks.every(t => !/NaN|Infinity/.test(t.label)));
        if (Math.abs(minimum) === 1e12) assert.equal(scale.offset, minimum);
    }
});

test("x ticks adapt to available width and use bin edges, not sample extrema", () => {
    const data = distribution(-0.5, 0.5, [64, ...new Array(63).fill(0)]);
    data.sampleMinimum = data.sampleMaximum = 0;
    const narrow = histogramScales(data, 200), wide = histogramScales(data, 580);
    assert.equal(narrow.ticks.length, 3);
    assert.equal(wide.ticks.length, 5);
    assert.deepEqual([narrow.minimum, narrow.maximum], [-0.5, 0.5]);
    assert.equal(narrow.maximumPercent, 100);
    assert.deepEqual(narrow.ticks.map(t => t.label), ["-0.5", "0", "0.5"]);
});

test("y scale is a zero-based percentage of valid pixels with a readable ceiling", () => {
    assert.equal(histogramScales(distribution(0, 1), 400).maximumPercent, 2);
    const data = distribution(0, 1, [30, 70, ...new Array(62).fill(0)]);
    data.sampledPixelCount = 10000; // Excluded/nodata pixels are not the denominator.
    assert.equal(histogramScales(data, 400).maximumPercent, 100);
});

test("units come only from explicit metadata on the analyzed first data band", () => {
    assert.equal(getHistogramValueLabel(null), "Raster value");
    assert.equal(getHistogramValueLabel({ assets: { data: { "raster:bands": [{ unit: " % " }] } } }), "Raster value (%)");
    assert.equal(getHistogramValueLabel({ assets: { thumbnail: { "raster:bands": [{ unit: "K" }] } } }), "Raster value");
    assert.equal(getHistogramValueLabel({ assets: { data: { "raster:bands": [{ unit: " " }, { unit: "K" }] } } }), "Raster value");
});

test("log tick labels remain positive and distinct across many orders of magnitude", async () => {
    const { createHistogramAxis } = await import("../../src/raster/histogram-axis-scale.js");
    const data = distribution(1e-20, 1e20);
    const axis = createHistogramAxis({ ...data.histogram, total: data.validSampleCount },
        { scale: "log", bounds: "auto", minimum: "", maximum: "" });
    const scales = histogramScales(data, 400, { x: axis });
    assert.equal(new Set(scales.ticks.map(tick => tick.label)).size, scales.ticks.length);
    assert.ok(scales.ticks.every(tick => Number(tick.label) > 0));
});
