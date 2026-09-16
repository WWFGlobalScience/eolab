import assert from "node:assert/strict";
import test from "node:test";
import { defaultHistogramAxisOptions, createHistogramAxis } from "../../src/raster/histogram-axis-scale.js";

const distribution = { edges: [0, 1, 2, 3, 4], counts: [0, 1, 3, 6], total: 10 };
const frequency = { ...distribution, frequency: true };
/** @param {Object} changes Nondefault settings. @return {Object} Axis settings. */
const options = changes => ({ ...defaultHistogramAxisOptions(), ...changes });

test("bar-height values use percentage units and percentiles exclude empty bins", () => {
    const fixed = createHistogramAxis(frequency, options({ bounds: "values", minimum: "0", maximum: "5" }));
    assert.equal(fixed.position(5), 1);
    assert.match(fixed.notice, /clipped/);
    const quantile = createHistogramAxis(frequency, options({ bounds: "percentiles", minimum: "25", maximum: "75" }));
    assert.equal(quantile.minimum, 20);
    assert.equal(quantile.maximum, 45);
    const values = createHistogramAxis(distribution, options({ bounds: "percentiles", minimum: "0", maximum: "50" }));
    assert.equal(values.minimum, 1);
    assert.ok(Math.abs(values.maximum - (3 + 1 / 6)) < 1e-12);
});

test("log coordinates and clipping retain original bins without an offset", () => {
    const data = { edges: [-10, -1, 1, 10, 100], counts: [1, 2, 3, 4], total: 10 };
    const original = structuredClone(data);
    const axis = createHistogramAxis(data, options({ scale: "log" }));
    assert.equal(axis.minimum, 1);
    assert.equal(axis.position(10), 0.5);
    assert.equal(axis.valueAt(0.5), 10);
    assert.equal(axis.interval(-1, 1), null);
    assert.deepEqual(axis.interval(1, 10), [0, 0.5]);
    assert.match(axis.notice, /3 sampled pixels/);
    assert.deepEqual(data, original);
    const logFrequency = createHistogramAxis(frequency, options({ scale: "log" }));
    assert.equal(logFrequency.minimum, 1);
    assert.equal(logFrequency.position(0), -Infinity);
    assert.match(logFrequency.notice, /zero-height/);
});

test("invalid, empty and degenerate ranges fail locally", () => {
    for (const [minimum, maximum] of [["", "5"], ["4", "4"], ["8", "2"], ["NaN", "4"], ["0", "Infinity"]]) {
        assert.throws(() => createHistogramAxis(frequency, options({ bounds: "values", minimum, maximum })), RangeError);
    }
    assert.throws(() => createHistogramAxis(frequency, options({ bounds: "values", minimum: "-1", maximum: "5" })), /between 0 and 100/);
    assert.throws(() => createHistogramAxis(frequency, options({ bounds: "percentiles", minimum: "1", maximum: "101" })), /Percentiles/);
    assert.throws(() => createHistogramAxis({ ...frequency, counts: [0, 0, 0, 0], total: 0 }), /No sampled/);
    assert.throws(() => createHistogramAxis({ ...frequency, counts: [0, 0, 0, 1], total: 1 },
        options({ bounds: "percentiles", minimum: "0", maximum: "100" })), /same value/);
    assert.throws(() => createHistogramAxis({ edges: [-3, -2, -1], counts: [1, 1], total: 2 }, options({ scale: "log" })), /positive edges/);
    assert.throws(() => createHistogramAxis(distribution,
        options({ scale: "log", bounds: "values", minimum: "0", maximum: "4" })), /positive minimum/);
    assert.equal(createHistogramAxis({ edges: [1, 2], counts: [1], total: 1 }).maximum, 2);
});

test("percentiles resolve with each sample while explicit limits stay fixed", () => {
    const next = { ...frequency, counts: [0, 2, 2, 6] };
    const fixed = options({ bounds: "values", minimum: "1", maximum: "50" });
    const percentile = options({ bounds: "percentiles", minimum: "0", maximum: "100" });
    assert.equal(createHistogramAxis(next, fixed).minimum, createHistogramAxis(frequency, fixed).minimum);
    assert.notEqual(createHistogramAxis(next, percentile).minimum, createHistogramAxis(frequency, percentile).minimum);
});
