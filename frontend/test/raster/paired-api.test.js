import assert from "node:assert/strict";
import test from "node:test";

import {
  loadRasterPairedStatistics,
} from "../../src/raster/analysis-api.js";

const X_ITEM = { collection: "rasters", id: "temperature" };
const Y_ITEM = { collection: "rasters", id: "moisture" };

function pairedResponse() {
  const size = 32;
  const counts = Array.from({ length: size }, () => Array(size).fill(0));
  counts[0][0] = 1;
  return {
    scope: "wholeOverlap",
    selectedBounds: null,
    referenceGrid: "x",
    resampling: "nearest",
    sourceWidth: 1,
    sourceHeight: 1,
    sourcePixelCount: 1,
    sampleWidth: 1,
    sampleHeight: 1,
    sampledCellCount: 1,
    pairedSampleCount: 1,
    samplingMethod: "exactReferenceGrid",
    approximate: false,
    xMinimum: 4,
    xMaximum: 4,
    yMinimum: 9,
    yMaximum: 9,
    histogram: {
      xEdges: Array.from({ length: size + 1 }, (_, index) => 3.5 + index / 32),
      yEdges: Array.from({ length: size + 1 }, (_, index) => 8.5 + index / 32),
      counts,
      xMarginalCounts: [1, ...Array(size - 1).fill(0)],
      yMarginalCounts: [1, ...Array(size - 1).fill(0)],
    },
  };
}

test("paired statistics request sends only two catalog identities and area", async () => {
  let request = null;
  const signal = new AbortController().signal;
  const result = await loadRasterPairedStatistics(
    X_ITEM,
    Y_ITEM,
    { kind: "wholeOverlap" },
    signal,
    async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify(pairedResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.equal(result.pairedSampleCount, 1);
  assert.equal(request.url, "/api/raster-analysis/paired-statistics");
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body, {
    xRaster: { collectionId: "rasters", itemId: "temperature" },
    yRaster: { collectionId: "rasters", itemId: "moisture" },
  });
  assert.equal(JSON.stringify(body).includes("path"), false);
  assert.equal(request.options.signal, signal);
});

test("paired statistics retain the uploaded polygon filter and browser owner", async () => {
  const selection = { uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", layerName: "areas",
    filter: { enabled: true, match: "all", rules: [{ field: "count", operator: "ge", value: 7 }] } };
  let request;
  const result = await loadRasterPairedStatistics(X_ITEM, Y_ITEM, { kind: "catalogSelection", catalogSelection: selection },
    new AbortController().signal, async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ ...pairedResponse(), scope: "catalogSelection", catalogSelection: selection }));
    });
  assert.deepEqual(result.catalogSelection, selection);
  assert.deepEqual(JSON.parse(request.options.body), {
    xRaster: { collectionId: X_ITEM.collection, itemId: X_ITEM.id },
    yRaster: { collectionId: Y_ITEM.collection, itemId: Y_ITEM.id }, catalogSelection: selection,
  });
  assert.equal(request.options.headers["X-EOLab-Uploads"], "1");
  assert.equal(request.options.headers["X-EOLab-Processing"], "1");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.cache, "no-store");
});


test("paired sampling-box analysis keeps the same descriptor and rejects mismatched geometry", async () => {
  const area = {kind: "samplingBox", samplingBox: {center: {longitude: 0, latitude: 60}, sideLengthKm: 600}};
  const response = {...pairedResponse(), scope: "samplingBox", samplingBox: area.samplingBox};
  let body;
  await loadRasterPairedStatistics(X_ITEM, Y_ITEM, area, undefined, async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify(response));
  });
  assert.deepEqual(body, {xRaster: {collectionId: X_ITEM.collection, itemId: X_ITEM.id},
    yRaster: {collectionId: Y_ITEM.collection, itemId: Y_ITEM.id}, samplingBox: area.samplingBox});
  await assert.rejects(loadRasterPairedStatistics(X_ITEM, Y_ITEM, area, undefined,
    async () => new Response(JSON.stringify({...response, samplingBox: {...area.samplingBox, sideLengthKm: 601}}))));
  await assert.rejects(loadRasterPairedStatistics(X_ITEM, Y_ITEM, area, undefined,
    async () => new Response(JSON.stringify(pairedResponse()))));
});
