import assert from "node:assert/strict";
import test from "node:test";

import {
  publishRasterSource,
  RenderingRequestError,
} from "../../src/raster/api.js";
import {
  loadRasterStatistics,
  RasterAnalysisRequestError,
  isRasterStatisticsCapacityError,
  sampleRasterPixel,
} from "../../src/raster/analysis-api.js";
import {
  MOUNTED_GEOTIFF_ITEM,
  RASTER_STATISTICS,
  SELECTED_BOUNDS,
  SELECTED_RASTER_STATISTICS,
  CATALOG_SELECTION,
  CATALOG_SELECTION_RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

test("publishRasterSource sends only the STAC Item identity", async () => {
  const requests = [];
  const publishedRaster = await publishRasterSource(
    MOUNTED_GEOTIFF_ITEM,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({
          layerName: `eolab:${MOUNTED_GEOTIFF_ITEM.id}`,
          bbox: [-123, 48, -122, 49],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );

  assert.deepEqual(publishedRaster, {
    layerName: `eolab:${MOUNTED_GEOTIFF_ITEM.id}`,
    bbox: [-123, 48, -122, 49],
  });
  assert.deepEqual(requests, [
    {
      url: "/api/rendering/layers",
      options: {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: undefined,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-EOLab-Processing": "1",
        },
        body: JSON.stringify({
          collectionId: "eolab-mounted-geotiffs",
          itemId: "geotiff-0123456789abcdef01234567",
        }),
      },
    },
  ]);
});

test("publishRasterSource reports the backend detail", async () => {
  await assert.rejects(
    publishRasterSource(
      MOUNTED_GEOTIFF_ITEM,
      async () => new Response(
        JSON.stringify({ detail: "Catalog Item not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    ),
    /Catalog Item not found/,
  );
});

test("publishRasterSource preserves an actionable failure category", async () => {
  const publication = publishRasterSource(
    MOUNTED_GEOTIFF_ITEM,
    async () => new Response(
      JSON.stringify({
        detail: {
          category: "reader_rejection",
          message: "GeoServer could not read this raster.",
        },
      }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    ),
  );

  await assert.rejects(publication, (error) => {
    assert.equal(error instanceof RenderingRequestError, true);
    assert.equal(error.category, "reader_rejection");
    assert.equal(error.status, 422);
    assert.equal(error.message, "GeoServer could not read this raster.");
    return true;
  });
});

test("loadRasterStatistics sends only Item identity and validates data", async () => {
  const requests = [];
  const abortController = new AbortController();

  assert.deepEqual(
    await loadRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      { kind: "wholeRaster" },
      abortController.signal,
      async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify(RASTER_STATISTICS), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    ),
    RASTER_STATISTICS,
  );
  assert.deepEqual(requests, [
    {
      url: "/api/raster-analysis/statistics",
      options: {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: undefined,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-EOLab-Processing": "1",
          "X-EOLab-Processing": "1",
        },
        credentials: "same-origin", cache: "no-store",
        body: JSON.stringify({
          collectionId: "eolab-mounted-geotiffs",
          itemId: "geotiff-0123456789abcdef01234567",
        }),
        signal: abortController.signal,
      },
    },
  ]);
});

test("loadRasterStatistics adds only validated selected bounds", async () => {
  const requests = [];
  const abortController = new AbortController();

  assert.deepEqual(
    await loadRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      { kind: "selectedArea", selectedBounds: SELECTED_BOUNDS },
      abortController.signal,
      async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify(SELECTED_RASTER_STATISTICS), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    ),
    SELECTED_RASTER_STATISTICS,
  );
  assert.deepEqual(
    JSON.parse(requests[0].options.body),
    {
      collectionId: "eolab-mounted-geotiffs",
      itemId: "geotiff-0123456789abcdef01234567",
      selectedBounds: SELECTED_BOUNDS,
    },
  );
  assert.equal(requests[0].options.signal, abortController.signal);

  await assert.rejects(
    loadRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      { kind: "selectedArea", selectedBounds: SELECTED_BOUNDS },
      abortController.signal,
      async () => new Response(JSON.stringify({
        ...SELECTED_RASTER_STATISTICS,
        selectedBounds: { ...SELECTED_BOUNDS, west: -124 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
    /invalid selected-area response bounds/,
  );
});

test("loadRasterStatistics sends a path-free catalog selection without geometry", async () => {
  const requests = [];
  const abortController = new AbortController();

  const statistics = await loadRasterStatistics(
    MOUNTED_GEOTIFF_ITEM,
    { kind: "catalogSelection", catalogSelection: CATALOG_SELECTION },
    abortController.signal,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify(CATALOG_SELECTION_RASTER_STATISTICS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.deepEqual(statistics.catalogSelection, CATALOG_SELECTION);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    collectionId: "eolab-mounted-geotiffs",
    itemId: "geotiff-0123456789abcdef01234567",
    catalogSelection: CATALOG_SELECTION,
  });
  assert.equal("geometry" in JSON.parse(requests[0].options.body), false);
  await assert.rejects(
    loadRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      {
        kind: "selectedArea",
        selectedBounds: SELECTED_BOUNDS,
        catalogSelection: CATALOG_SELECTION,
      },
      abortController.signal,
      async () => new Response(),
    ),
    /sampling area is invalid/,
  );
});

test("uploaded polygon statistics send their selection and both private-source headers", async () => {
  const selection = { uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", layerName: "areas", filter: CATALOG_SELECTION.filter };
  const raster = { kind: "runArtifact", jobId: "a".repeat(32), artifactId: "b".repeat(32) };
  let request;
  const result = await loadRasterStatistics(raster, { kind: "catalogSelection", catalogSelection: selection },
    new AbortController().signal, async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ ...CATALOG_SELECTION_RASTER_STATISTICS, catalogSelection: selection }));
    });
  assert.deepEqual(result.catalogSelection, selection);
  assert.deepEqual(JSON.parse(request.options.body), { source: raster, catalogSelection: selection });
  assert.equal(request.options.headers["X-EOLab-Uploads"], "1");
  assert.equal(request.options.headers["X-EOLab-Processing"], "1");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.cache, "no-store");
});

test("statistics capacity is classified without matching user-facing message text", async () => {
  for (const code of ["statistics_capacity_busy", "invalid_area", null]) {
    await assert.rejects(loadRasterStatistics(
      MOUNTED_GEOTIFF_ITEM, { kind: "wholeRaster" }, new AbortController().signal,
      async () => new Response(JSON.stringify({ detail: { code, message: "Server guidance" } }),
        { status: 409, headers: { "Content-Type": "application/json" } }),
    ), error => {
      assert.equal(error.message, "Server guidance");
      assert.equal(isRasterStatisticsCapacityError(error), code === "statistics_capacity_busy");
      return true;
    });
  }
  assert.equal(isRasterStatisticsCapacityError(new RasterAnalysisRequestError(
    "Raster statistics capacity is busy; retry after the current bounded read finishes.", 409)), false);
});

test("loadRasterStatistics reports backend and response errors", async () => {
  await assert.rejects(
    loadRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      { kind: "wholeRaster" },
      new AbortController().signal,
      async () => new Response(
        JSON.stringify({ detail: "No valid sampled pixels were found" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    ),
    /No valid sampled pixels/,
  );
  for (const errorResponse of [
    new Response("upstream unavailable", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    }),
    new Response(JSON.stringify({ detail: [{ type: "missing" }] }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    }),
  ]) {
    await assert.rejects(
      loadRasterStatistics(
        MOUNTED_GEOTIFF_ITEM,
        { kind: "wholeRaster" },
        new AbortController().signal,
        async () => errorResponse,
      ),
      new RegExp(
        `Raster statistics request failed \\(${errorResponse.status}\\)`,
      ),
    );
  }
  await assert.rejects(
    loadRasterStatistics(
      MOUNTED_GEOTIFF_ITEM,
      { kind: "wholeRaster" },
      new AbortController().signal,
      async () => new Response(JSON.stringify({
        ...RASTER_STATISTICS,
        band: 2,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
    /invalid band identity/,
  );
});

test("sampleRasterPixel sends only Item identity and WGS 84 position", async () => {
  const requests = [];
  const abortController = new AbortController();
  const pixel = await sampleRasterPixel(
    MOUNTED_GEOTIFF_ITEM,
    { longitude: -122.25, latitude: 48.75 },
    abortController.signal,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({
          longitude: -122.25,
          latitude: 48.75,
          row: 2,
          column: 4,
          inBounds: true,
          value: 12.5,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );

  assert.equal(pixel.value, 12.5);
  assert.deepEqual(requests, [
    {
      url: "/api/raster-analysis/pixels",
      options: {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: undefined,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-EOLab-Processing": "1",
          "X-EOLab-Processing": "1",
        },
        credentials: "same-origin", cache: "no-store",
        body: JSON.stringify({
          collectionId: "eolab-mounted-geotiffs",
          itemId: "geotiff-0123456789abcdef01234567",
          longitude: -122.25,
          latitude: 48.75,
        }),
        signal: abortController.signal,
      },
    },
  ]);
});

test("pixel analysis preserves catalog-source failures", async () => {
  const request = sampleRasterPixel(
    MOUNTED_GEOTIFF_ITEM,
    { longitude: -122.25, latitude: 48.75 },
    new AbortController().signal,
    async () => new Response(
      JSON.stringify({
        detail: "The cataloged raster changed; scan it again before analysis.",
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ),
  );

  await assert.rejects(request, (error) => {
    assert.equal(error instanceof RasterAnalysisRequestError, true);
    assert.equal(error.status, 409);
    assert.match(error.message, /scan it again/);
    return true;
  });
});


test("sampling-box analysis captures center/size and rejects stale or rectangular results", async () => {
  const area = {kind: "samplingBox", samplingBox: {center: {longitude: 0, latitude: 60}, sideLengthKm: 600}};
  const response = {...RASTER_STATISTICS, scope: "samplingBox", samplingBox: area.samplingBox};
  let body;
  const result = await loadRasterStatistics(MOUNTED_GEOTIFF_ITEM, area, undefined, async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify(response));
  });
  assert.deepEqual(body, {collectionId: MOUNTED_GEOTIFF_ITEM.collection, itemId: MOUNTED_GEOTIFF_ITEM.id, samplingBox: area.samplingBox});
  assert.deepEqual(result.samplingBox, area.samplingBox);
  for (const stale of [{...response, samplingBox: {...area.samplingBox, sideLengthKm: 601}},
      {...response, selectedBounds: SELECTED_BOUNDS}, SELECTED_RASTER_STATISTICS]) {
    await assert.rejects(loadRasterStatistics(MOUNTED_GEOTIFF_ITEM, area, undefined,
      async () => new Response(JSON.stringify(stale))));
  }
});
