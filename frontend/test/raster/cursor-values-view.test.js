import assert from "node:assert/strict";
import test from "node:test";

import { RasterCursorValuesView } from "../../src/raster/cursor-values-view.js";
import { formatRasterCursorValuesForClipboard } from "../../src/raster/cursor-values-view.js";
import {
  FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";

test("cursor-value view presents progressive values and omits outside rasters", () => {
  const documentContext = new FakeRasterControlDocument();
  const view = new RasterCursorValuesView(documentContext);
  const root = documentContext.querySelector("#raster-cursor-values");
  const list = documentContext.querySelector("#raster-cursor-value-list");
  const limit = documentContext.querySelector("#raster-cursor-value-limit");

  view.render({
    position: { latitude: -2.75, longitude: 36.8 },
    omittedCount: 2,
    samples: [
      { label: "temperature", state: "value", value: 12.5, errorMessage: "" },
      { label: "rainfall", state: "loading", value: null, errorMessage: "" },
      { label: "habitat", state: "nodata", value: null, errorMessage: "" },
      { label: "outside", state: "outside", value: null, errorMessage: "" },
      { label: "broken", state: "error", value: null, errorMessage: "Timed out" },
    ],
  });

  assert.equal(root.hidden, false);
  assert.equal(root.getAttribute("aria-busy"), "true");
  assert.equal(
    documentContext.querySelector("#raster-cursor-position").textContent,
    "Lat -2.75000 · Lng 36.80000",
  );
  assert.equal(list.children.length, 4);
  assert.deepEqual(
    list.children.map(row => [
      row.children[0].textContent,
      row.children[1].textContent,
    ]),
    [
      ["temperature", "1.250e+1"],
      ["rainfall", "Reading…"],
      ["habitat", "No data"],
      ["broken", "Unavailable: Timed out"],
    ],
  );
  assert.equal(limit.hidden, false);
  assert.equal(limit.textContent, "2 additional rasters omitted.");

  view.clear();
  assert.equal(root.hidden, true);
  assert.equal(root.getAttribute("aria-busy"), "false");
  assert.equal(list.children.length, 0);
});

test("cursor-value view hides when every server result is outside", () => {
  const documentContext = new FakeRasterControlDocument();
  const view = new RasterCursorValuesView(documentContext);

  view.render({
    position: { latitude: 0, longitude: 0 },
    omittedCount: 0,
    samples: [
      { label: "outside", state: "outside", value: null, errorMessage: "" },
    ],
  });

  assert.equal(documentContext.querySelector("#raster-cursor-values").hidden, true);
});

test("pixel picker anchors its marker and readout inside the viewport", () => {
  const documentContext = new FakeRasterControlDocument();
  documentContext.defaultView = { innerWidth: 300, innerHeight: 220 };
  const view = new RasterCursorValuesView(documentContext);
  const root = documentContext.querySelector("#raster-cursor-values");

  view.move({ clientX: 290, clientY: 210 });
  view.render({
    position: { latitude: 1, longitude: 2 },
    omittedCount: 0,
    samples: [
      { label: "elevation", state: "value", value: 50, errorMessage: "" },
    ],
  });

  assert.equal(root.style.left, "156px");
  assert.equal(root.style.top, "148px");
  const marker = documentContext.querySelector("#raster-cursor-marker");
  assert.equal(marker.style.left, "290px");
  assert.equal(marker.style.top, "210px");
  assert.equal(marker.hidden, false);
  view.clear();
  assert.equal(marker.hidden, true);
});

test("replacement loading keeps the old marker, values, and clipboard until a result arrives", async () => {
  const documentContext = new FakeRasterControlDocument();
  const copied = [];
  const view = new RasterCursorValuesView(documentContext, {
    async writeText(text) { copied.push(text); },
  });
  view.bind({ onHide() {}, onShow() {} });
  const root = documentContext.querySelector("#raster-cursor-values");
  const marker = documentContext.querySelector("#raster-cursor-marker");
  const pending = documentContext.querySelector("#raster-cursor-pending");
  const list = documentContext.querySelector("#raster-cursor-value-list");
  const old = {
    position: { latitude: 1, longitude: 2 }, omittedCount: 0,
    samples: [{ label: "rain", state: "value", value: 12, errorMessage: "" }],
  };
  view.move({ clientX: 100, clientY: 100 });
  view.render(old);
  const previousRows = list.children;
  view.move({ clientX: 200, clientY: 200 });
  view.render({ ...old, position: { latitude: 3, longitude: 4 }, samples: [
    { label: "rain", state: "outside", value: null, errorMessage: "" },
    { label: "height", state: "loading", value: null, errorMessage: "" },
  ] });
  assert.equal(root.hidden, false);
  assert.equal(root.style.left, "114px");
  assert.equal(marker.style.left, "100px");
  assert.equal(list.children, previousRows);
  assert.equal(pending.hidden, false);
  const copyEvent = new Event("keydown", { cancelable: true });
  Object.assign(copyEvent, { key: "c", ctrlKey: true });
  documentContext.dispatchEvent(copyEvent);
  await Promise.resolve();
  assert.deepEqual(copied, [formatRasterCursorValuesForClipboard(old)]);
  view.render({ ...old, position: { latitude: 3, longitude: 4 }, samples: [
    { label: "height", state: "nodata", value: null, errorMessage: "" },
  ] });
  assert.equal(marker.style.left, "200px");
  assert.equal(root.style.left, "214px");
  assert.equal(pending.hidden, true);
  assert.equal(list.children[0].children[1].textContent, "No data");
  assert.equal(documentContext.querySelector("#raster-cursor-position").textContent,
    "Lat 3.00000 · Lng 4.00000");
  view.unbind();
});

test("pixel picker shortcuts copy, hide, and restore without owning policy", async () => {
  const documentContext = new FakeRasterControlDocument();
  const copied = [];
  const timers = new Map();
  let nextTimer = 1;
  const clock = {
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const view = new RasterCursorValuesView(documentContext, {
    async writeText(text) { copied.push(text); },
  }, clock);
  const root = documentContext.querySelector("#raster-cursor-values");
  const restore = documentContext.querySelector("#restore-raster-cursor-values");
  const feedback = documentContext.querySelector("#raster-cursor-copy-feedback");
  const state = { hidden: 0, shown: 0 };
  view.bind({
    onHide() { state.hidden += 1; view.setEnabled(false); },
    onShow() { state.shown += 1; view.setEnabled(true); },
  });
  const snapshot = {
    position: { latitude: 4.5, longitude: -7.25 },
    omittedCount: 0,
    samples: [
      { label: "rainfall", state: "value", value: 12.5, errorMessage: "" },
      { label: "mask", state: "nodata", value: null, errorMessage: "" },
      { label: "outside", state: "outside", value: null, errorMessage: "" },
    ],
  };
  view.render(snapshot);

  const copyEvent = new Event("keydown", { cancelable: true });
  Object.assign(copyEvent, { key: "c", ctrlKey: true, metaKey: false, altKey: false });
  documentContext.dispatchEvent(copyEvent);
  await Promise.resolve();
  assert.deepEqual(copied, [formatRasterCursorValuesForClipboard(snapshot)]);
  assert.doesNotMatch(copied[0], /outside/);
  assert.equal(feedback.hidden, false);
  assert.equal(root.classList.contains("is-copy-confirmed"), true);
  assert.equal(timers.size, 1);
  timers.values().next().value();
  assert.equal(feedback.hidden, true);
  assert.equal(root.classList.contains("is-copy-confirmed"), false);

  const hideEvent = new Event("keydown", { cancelable: true });
  Object.assign(hideEvent, { key: "Escape", ctrlKey: false, metaKey: false, altKey: false });
  documentContext.dispatchEvent(hideEvent);
  assert.equal(state.hidden, 1);
  assert.equal(root.hidden, true);
  assert.equal(restore.hidden, false);

  const showEvent = new Event("keydown", { cancelable: true });
  Object.assign(showEvent, { key: "p", ctrlKey: false, metaKey: false, altKey: false });
  documentContext.dispatchEvent(showEvent);
  assert.equal(state.shown, 1);
  assert.equal(restore.hidden, true);

  view.setEnabled(false);
  restore.dispatchEvent(new Event("click"));
  assert.equal(state.shown, 2);
  view.unbind();
});
