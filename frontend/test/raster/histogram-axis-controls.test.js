import assert from "node:assert/strict";
import test from "node:test";
import { HistogramAxisControls } from "../../src/raster/histogram-axis-controls.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

const definition = { key: "y", label: "Bar height (% of pixels)", frequency: true,
    edges: [0, 1, 2, 3], counts: [1, 3, 6], total: 10 };

/**
 * Change a field through the same DOM event as a user edit.
 * @param {HistogramAxisControls} view Display editor.
 * @param {string} name Field name.
 * @param {string} value Input value.
 * @return {void}
 */
function edit(view, name, value) {
    const input = view.rows.get("y").fields[name].input;
    input.value = value;
    input.dispatchEvent(new Event("change"));
}

test("axis editor redraws accepted edits, retains a chart for invalid edits, and resets", () => {
    const doc = new FakeRasterControlDocument(), state = {}, updates = [];
    const view = new HistogramAxisControls(doc, [definition], state, axes => updates.push(axes));
    assert.equal(view.root.open, false);
    const { fields, status } = view.rows.get("y");
    assert.equal(fields.minimum.wrapper.hidden, true);
    edit(view, "bounds", "values");
    assert.equal(fields.minimum.wrapper.hidden, false);
    edit(view, "maximum", "5");
    assert.equal(updates.at(-1).y.maximum, 5);
    const count = updates.length;
    edit(view, "minimum", "6");
    assert.equal(updates.length, count);
    assert.equal(state.options.y.minimum, "0");
    assert.match(status.textContent, /Chart unchanged/);
    view.reset.dispatchEvent(new Event("click"));
    assert.equal(updates.at(-1).y.minimum, 0);
    assert.equal(state.options.y.bounds, "auto");
    assert.equal(fields.minimum.wrapper.hidden, true);
});

test("axis editor retains settings across samples and explicitly falls back for unusable log domains", () => {
    const doc = new FakeRasterControlDocument(), state = {};
    const positive = { ...definition, key: "y", frequency: false, edges: [1, 2, 3, 4] };
    const first = new HistogramAxisControls(doc, [positive], state, () => {});
    edit(first, "scale", "log");
    first.root.open = true;
    first.root.dispatchEvent(new Event("toggle"));
    first.dispose();
    const next = new HistogramAxisControls(doc, [{ ...positive, edges: [-4, -3, -2, -1] }], state, () => {});
    assert.equal(next.root.open, true);
    assert.equal(state.options.y.scale, "log");
    assert.equal(next.axes.y.scale, "linear");
    assert.match(next.summary.textContent, /using Auto\/Linear/);
    assert.match(next.rows.get("y").status.textContent, /positive edges/);
});

test("disabled or disposed editors cannot redraw a stale sample after delayed input", async () => {
    const doc = new FakeRasterControlDocument(), updates = [];
    const view = new HistogramAxisControls(doc, [definition], {}, axes => updates.push(axes));
    edit(view, "bounds", "values");
    const field = view.rows.get("y").fields.maximum.input;
    field.value = "20";
    field.dispatchEvent(new Event("input"));
    view.dispose();
    const count = updates.length;
    await new Promise(resolve => setTimeout(resolve, 230));
    view.reset.dispatchEvent(new Event("click"));
    assert.equal(updates.length, count);
    assert.equal(field.disabled, true);
});
