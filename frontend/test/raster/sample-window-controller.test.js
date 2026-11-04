import { rasterSamplingAreaBounds } from "../../src/selected-area.js";
import assert from "node:assert/strict";
import test from "node:test";

import { RasterSampleWindowController } from "../../src/raster/sample-window-controller.js";
import {
  createFakeLeafletMap,
  createFakeSampleLayerFactory,
} from "../../test-support/raster/fakes.js";

test("processing activity follows only its exact committed rectangle and clears on replacement", () => {
  const map = createFakeLeafletMap();
  const layers = [];
  const factory = createFakeSampleLayerFactory(layers);
  const flags = [];
  const controller = new RasterSampleWindowController(map, (bounds,kind) => {
    const layer = factory(bounds,kind);
    layer.getElement = () => ({classList:{toggle:(_,enabled)=>flags.push(enabled)}});
    return layer;
  }, () => {}, () => {});
  const bounds = controller.selectAt({lng:78,lat:22});
  const area = controller.selectedArea;
  controller.setActivityArea(controller.selectedArea); assert.equal(flags.at(-1),true);
  controller.selectAt({lng:79,lat:22}); assert.equal(flags.at(-1),false);
  controller.restoreSelection(bounds,area.samplingBox); assert.equal(flags.at(-1),true);
  controller.setActivityArea(null); assert.equal(flags.at(-1),false);
});

test("sample window previews and commits composition-owned positions", () => {
  const map = createFakeLeafletMap();
  const layers = [];
  const selections = [];
  const guidance = [];
  const controller = new RasterSampleWindowController(
    map,
    createFakeSampleLayerFactory(layers),
    (bounds) => selections.push(bounds),
    (message) => guidance.push(message),
  );

  assert.equal(controller.selectAt({ lng: 238, lat: 48 }), null);
  assert.match(guidance.at(-1), /inside the map bounds/);
  assert.equal(selections.length, 0);
  assert.equal(map.layers.length, 0);

  controller.setWindowSize(50);
  assert.equal(controller.previewAt({ lng: -122, lat: 48 }), true);
  assert.equal(selections.length, 0);
  assert.equal(layers[0].kind, "preview");
  assert.equal(map.layers.length, 1);
  assert.equal(controller.previewAt({ lng: -121, lat: 47 }), true);
  assert.equal(layers[0].boundsHistory.length, 2);

  const bounds = controller.selectAt({ lng: -122, lat: 48 });
  assert.equal(selections.length, 1);
  assert.equal(bounds, selections[0]);
  assert.ok(bounds.west < -122);
  assert.ok(bounds.east > -122);
  assert.equal(layers.at(-1).kind, "selection");
  assert.equal(map.layers.length, 2);
  assert.deepEqual(rasterSamplingAreaBounds(controller.selectedArea), bounds);
  assert.equal(guidance.at(-1), "");
  for (const eventName of ["mousemove", "mouseout", "mouseover", "click"]) {
    assert.equal(map.listenerCount(eventName), 0);
  }

  controller.clearPreview();
  assert.equal(map.layers.length, 1);
});

test("sample window restores a retained selection in the canonical world", () => {
  const map = createFakeLeafletMap();
  const layers = [];
  const controller = new RasterSampleWindowController(
    map,
    createFakeSampleLayerFactory(layers),
    () => {},
    () => {},
  );
  const bounds = { west: -123, south: 47, east: -121, north: 49 };

  controller.restoreSelection(bounds);

  assert.deepEqual(rasterSamplingAreaBounds(controller.selectedArea), bounds);
  assert.deepEqual(layers[0].boundsHistory[0], [
    [47, -123],
    [49, -121],
  ]);
});

test("resizing reuses the displayed rectangle without committing another selection", () => {
  const map = createFakeLeafletMap();
  const layers = [], selections = [], activity = [];
  const factory = createFakeSampleLayerFactory(layers);
  const controller = new RasterSampleWindowController(map, (bounds, kind) => {
    const layer = factory(bounds, kind);
    layer.getElement = () => ({classList: {toggle: (_, enabled) => activity.push(enabled)}});
    return layer;
  }, bounds => selections.push(bounds), () => {});
  const center = {lng: 78, lat: 22};

  assert.equal(controller.resizeSelectionAt(center), null);
  assert.equal(layers.length, 0);
  const committed = controller.selectAt(center);
  const committedArea = controller.selectedArea;
  const rectangle = layers[0];
  controller.setActivityArea(committedArea);
  assert.equal(activity.at(-1), true);
  controller.previewAt({lng: 79, lat: 23});
  controller.setWindowSize(90);
  const resized = controller.resizeSelectionAt(center);

  assert.notDeepEqual(resized, committed);
  assert.deepEqual(map.layers, [rectangle]);
  assert.deepEqual(rectangle.boundsHistory.at(-1), [
    [resized.south, resized.west], [resized.north, resized.east],
  ]);
  assert.deepEqual(rasterSamplingAreaBounds(controller.selectedArea), resized);
  assert.deepEqual(selections, [committed]);
  assert.equal(activity.at(-1), false);

  controller.restoreSelection(committed,committedArea.samplingBox);
  assert.deepEqual(map.layers, [rectangle]);
  assert.deepEqual(rasterSamplingAreaBounds(controller.selectedArea), committed);
  assert.deepEqual(selections, [committed]);
  assert.equal(activity.at(-1), true);
});

test("resizing across a pole or date line preserves the displayed rectangle", () => {
  for (const center of [{lng: 179, lat: 0}, {lng: 0, lat: 89}]) {
    const map = createFakeLeafletMap();
    const layers = [], selections = [], guidance = [];
    const controller = new RasterSampleWindowController(map, createFakeSampleLayerFactory(layers),
      bounds => selections.push(bounds), message => guidance.push(message));
    controller.setWindowSize(10);
    const committed = controller.selectAt(center);
  const committedArea = controller.selectedArea;
    controller.setWindowSize(500);

    assert.equal(controller.resizeSelectionAt(center), null);
    assert.deepEqual(rasterSamplingAreaBounds(controller.selectedArea), committed);
    assert.equal(layers[0].boundsHistory.length, 1);
    assert.deepEqual(selections, [committed]);
    assert.match(guidance.at(-1), /previous selection is unchanged/);
  }
});

test("sample window replaces its rectangle and supports complete teardown", () => {
  const map = createFakeLeafletMap();
  const layers = [];
  const selections = [];
  const guidance = [];
  const controller = new RasterSampleWindowController(
    map,
    createFakeSampleLayerFactory(layers),
    (bounds) => selections.push(bounds),
    (message) => guidance.push(message),
  );

  controller.selectAt({ lng: 12, lat: 34 });
  controller.selectAt({ lng: 13, lat: 35 });
  assert.equal(selections.length, 2);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].boundsHistory.length, 2);
  assert.equal(controller.selectAt({ lng: 179.8, lat: 0 }), null);
  assert.match(guidance.at(-1), /pole or date line/);

  controller.clear();
  assert.deepEqual(rasterSamplingAreaBounds(controller.selectedArea), null);
  assert.equal(map.layers.length, 0);
  assert.equal(guidance.at(-1), "");
});

test("large invalid previews and clicks retain the previous selected bounds", () => {
  const map = createFakeLeafletMap();
  const layers = [], selections = [], guidance = [];
  const controller = new RasterSampleWindowController(map, createFakeSampleLayerFactory(layers),
    bounds => selections.push(bounds), message => guidance.push(message));
  controller.setWindowSize(5000);
  const selected = controller.selectAt({lng: 78, lat: 22});
  assert.ok(selected.east - selected.west > 40);
  assert.equal(controller.previewAt({lng: 170, lat: 0}), false);
  assert.equal(controller.selectAt({lng: 0, lat: 70}), null);
  assert.deepEqual(rasterSamplingAreaBounds(controller.selectedArea), selected);
  assert.deepEqual(selections, [selected]);
  assert.match(guidance.at(-1), /previous selection is unchanged/);
  assert.match(guidance.at(-1), /Whole overlap/);
});

test("continental selections report immutable clicked centers independently of their envelopes", () => {
  const map = createFakeLeafletMap();
  const selections = [];
  const controller = new RasterSampleWindowController(map, createFakeSampleLayerFactory([]),
    (bounds, center) => selections.push({bounds, center}), () => {});
  controller.setWindowSize(10000);
  const continental = controller.selectAt({lng: 78, lat: 22});
  assert.ok(continental.east - continental.west > 100);
  assert.deepEqual(controller.selectedArea.samplingBox.center, {longitude:78,latitude:22});
  assert.deepEqual(selections[0].center, {longitude: 78, latitude: 22});
  assert.ok(Object.isFrozen(selections[0].center));
});
