import assert from "node:assert/strict";
import test from "node:test";

import {
    RasterSamplingAreaControlsView,
} from "../../src/raster/sampling-area-controls-view.js";
import {
    FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";
import { MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM } from "../../src/raster/geometry.js";

test("sampling controls expose map boxes and vector selection without an upload choice", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(documentContext);
    const received = [];
    view.bind({ onSampleWindowRangeInput: value => received.push(value),
        onClearSampleWindow: () => received.push("whole"), onUseMapWindow: () => received.push("box") });
    view.setSampleWindowSize(80, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
    view.setSamplingAreaMode("catalogSelection", "Vector selection · countries");
    assert.equal(documentContext.querySelector("#use-vector-for-raster").checked, true);
    assert.equal(documentContext.querySelector("#raster-map-box-controls").hidden, true);
    assert.equal(view.vectorControls.hidden, false);
    assert.equal(view.setTemporaryAoiAvailability, undefined);
    view.setSamplingAreaMode("selectedArea", "80 km box");
    assert.equal(documentContext.querySelector("#raster-map-box-controls").hidden, false);
    assert.equal(view.vectorControls.hidden, true);
    const choice = documentContext.querySelector("#use-map-window-for-raster");
    choice.dispatchEvent(new Event("change"));
    assert.deepEqual(received, ["box"]);
    view.unbind();
    choice.dispatchEvent(new Event("change"));
    assert.deepEqual(received, ["box"]);
    assert.throws(() => view.setSamplingAreaMode("other"), /Unknown raster sampling-area mode/);
});

test("sampling-area adapter requires its semantic subgroup root", () => {
    assert.throws(
        () => new RasterSamplingAreaControlsView({ querySelector: () => null }),
        /Required raster control is missing: #raster-sampling-area-controls/
    );
});

test("showing, editing and minimizing sampling controls never changes the chosen area", () => {
    const document = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(document);
    const edits = [];
    view.bind({ onUseMapWindow: () => edits.push("box"), onClearSampleWindow: () => edits.push("whole"),
        onSampleWindowRangeInput: value => edits.push(value) });
    view.setSampleWindowSize(200, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
    view.setSamplingAreaMode("selectedArea", "200 km box");
    view.setActive(true, true);
    assert.equal(view.tool.hidden, false);
    assert.equal(view.mapBoxControls.hidden, false);
    assert.equal(view.dimensions.textContent, "200 × 200 km");
    assert.equal(view.samplingAreaSummary.textContent, "Sampling box · 200 × 200 km");
    view.disclosure.open = false;
    view.setActive(false, false);
    assert.equal(view.tool.hidden, true);
    view.setActive(true, true);
    assert.equal(view.disclosure.open, false, "the sampling disclosure stays collapsed");
    assert.equal(view.sampleWindowNumber.value, "200");
    view.setActive(true, false);
    assert.equal(view.mapBoxControls.hidden, true, "whole-raster workflows do not show box sizing");
    view.openAreaEditor();
    assert.equal(view.mapBoxControls.hidden, false, "an explicit edit exposes the retained box");
    assert.equal(view.samplingAreaSummary.textContent, "Sample area", "expanded controls show dimensions only beside the slider");
    view.setSampleWindowSize(80, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
    assert.equal(view.samplingAreaSummary.textContent, "Sample area");
    assert.equal(view.dimensions.textContent, "80 × 80 km");
    assert.equal(document.activeElement, view.disclosureSummary);
    view.disclosure.open = false;
    view.disclosure.dispatchEvent(new Event("toggle"));
    assert.equal(view.mapBoxControls.hidden, true);
    assert.equal(view.samplingAreaSummary.textContent, "Sampling box · 80 × 80 km");
    view.setActive(true, true);
    // A radio change hides sizing before a proposed polygon selection is accepted.
    view.useMapWindowButton.checked = false;
    view.vectorChoice.checked = true;
    document.querySelector("#raster-sampling-area-controls").dispatchEvent(new Event("change"));
    assert.equal(view.mapBoxControls.hidden, true);
    assert.equal(view.vectorControls.hidden, false, "the selected radio immediately reveals its controls");
    view.setSamplingAreaMode("vector", "Selected polygons");
    assert.equal(view.mapBoxControls.hidden, true);
    view.setSamplingAreaMode("wholeRaster");
    assert.equal(view.mapBoxControls.hidden, true);
    assert.equal(view.vectorControls.hidden, true);
    assert.deepEqual(edits, []);
    view.unbind();
});

test("area editing keeps vector selection and retained box sizing available without an active histogram", () => {
    const document = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(document);
    view.bind({});
    view.setActiveRasterAvailable(false);
    assert.equal(view.useMapWindowButton.disabled, true);
    assert.equal(view.clearSampleWindowButton.disabled, true);
    assert.equal(view.vectorChoice.disabled, false);
    view.vectorChoice.checked = true;
    document.querySelector("#raster-sampling-area-controls").dispatchEvent(new Event("change"));
    view.openAreaEditor();
    assert.equal(view.vectorControls.hidden, false);
    view.setSamplingAreaMode("selectedArea", "Retained box");
    assert.equal(view.mapBoxControls.hidden, false);
    assert.equal(view.sampleWindowNumber.disabled, false);
    view.setActiveRasterAvailable(true);
    assert.equal(view.useMapWindowButton.disabled, false);
    assert.equal(view.clearSampleWindowButton.disabled, false);
    view.unbind();
});

test("logarithmic box controls preserve exact kilometers and accessible values", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(documentContext);
    const range = documentContext.querySelector("#raster-sample-window-range");
    const number = documentContext.querySelector("#raster-sample-window-number");
    const received = [];
    view.bind({ onSampleWindowRangeInput: value => received.push(Number(value)) });
    view.setSampleWindowSize(200, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
    assert.equal(number.value, "200");
    assert.equal(number.max, String(MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM));
    for (const size of [1, 80, 200, 301, 1000, 5000, 10000, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM]) {
        view.setSampleWindowSize(size, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
        assert.equal(number.value, String(size));
        assert.equal(range.getAttribute("aria-valuetext"), `${size} kilometers`);
        range.dispatchEvent(new Event("input"));
        assert.equal(received.at(-1), size);
    }
    range.value = "500";
    range.dispatchEvent(new Event("input"));
    // Midpoint retains useful local precision instead of being a 7,000 km box.
    assert.ok(received.at(-1) > 100 && received.at(-1) < 150);
    range.value = range.min;
    range.dispatchEvent(new Event("input"));
    assert.equal(received.at(-1), 1);
    range.value = range.max;
    range.dispatchEvent(new Event("input"));
    assert.equal(received.at(-1), MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
    view.unbind();
});

test("keyboard slider steps advance small boxes and support range endpoints", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(documentContext);
    const range = documentContext.querySelector("#raster-sample-window-range");
    const received = [];
    view.bind({onSampleWindowRangeInput: value => received.push(Number(value))});
    view.setSampleWindowSize(1, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
    for (const [key, expected] of [["ArrowRight", 2], ["ArrowUp", 3], ["ArrowLeft", 2],
        ["ArrowDown", 1], ["ArrowLeft", 1], ["End", MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM],
        ["ArrowRight", MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM], ["Home", 1]]) {
        const event = new Event("keydown", {cancelable: true});
        event.key = key;
        range.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(received.at(-1), expected);
        assert.equal(range.getAttribute("aria-valuetext"), `${expected} kilometers`);
    }
    view.unbind();
    const before = received.length;
    const event = new Event("keydown"); event.key = "ArrowRight";
    range.dispatchEvent(event);
    assert.equal(received.length, before);
});

test("composed area context keeps a foreground polygon workflow separate from histogram scope", () => {
    const document = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(document);
    view.setSamplingAreaMode("selectedArea", "Histogram box");
    view.setAreaContext({scope: "Shared reserve drawings", usesSamplingBox: false});
    view.setActive(true, false); view.openAreaEditor();
    assert.equal(view.isSamplingBoxSelected(), false);
    assert.equal(view.mapBoxControls.hidden, true);
    view.disclosure.open = false;
    view.setSamplingAreaMode("wholeRaster", "Whole raster");
    assert.equal(view.samplingAreaSummary.textContent, "Sample area · Shared reserve drawings");
    view.setAreaContext(null);
    assert.equal(view.samplingAreaSummary.textContent, "Sample area · Whole raster");
});

test("spatial guidance is visible independently of numeric validity and clears on recovery", () => {
    const document = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(document);
    view.disclosure.open = false;
    view.setSampleWindowInvalid(false);
    view.setSampleWindowStatus("Whole raster selected.");
    assert.equal(view.sampleWindowStatus.classList.contains("visually-hidden"), true);

    view.setSampleWindowStatus("This box reaches a pole or date line. Use a smaller box.", true);
    assert.equal(view.sampleWindowStatus.classList.contains("visually-hidden"), false);
    assert.equal(view.sampleWindowNumber.getAttribute("aria-invalid"), null);
    view.setSampleWindowInvalid(false);
    assert.equal(view.sampleWindowStatus.classList.contains("visually-hidden"), false);
    assert.equal(view.disclosure.open, false);

    view.setSampleWindowStatus("Selected map window.");
    assert.equal(view.sampleWindowStatus.classList.contains("visually-hidden"), true);
    view.setSampleWindowInvalid(true);
    view.setSampleWindowStatus("Choose a whole-number size.");
    assert.equal(view.sampleWindowStatus.classList.contains("visually-hidden"), false);
    assert.equal(view.sampleWindowNumber.getAttribute("aria-invalid"), "true");
    view.setSampleWindowInvalid(false);
    assert.equal(view.sampleWindowStatus.classList.contains("visually-hidden"), true);
});
