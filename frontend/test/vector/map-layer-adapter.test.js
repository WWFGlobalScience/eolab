import assert from "node:assert/strict";
import test from "node:test";

import { createVectorMapLayerAdapter } from "../../src/vector/map-layer-adapter.js";

const PUBLICATION = Object.freeze({
  layerName: "eolab:geopackage-0123456789abcdef01234567",
  bbox: [-123, 48, -122, 49],
  geometryKind: "polygon",
  styleName: "vector-polygon",
  style: {
    geometryKind: "polygon",
    fillColor: "#fd8d3c",
    fillOpacity: 1,
    strokeColor: "#800026",
    strokeOpacity: 0,
    strokeWidth: 2,
        pointSize: null,
        categorical: null,
        graduated: null,
        label: null,
  },
});

/**
 * Create a focused adapter fixture with inspectable WMS and fit calls.
 *
 * @param {boolean} fitToBounds Whether new layers should fit the map.
 * @return {{adapter:Object,wmsCalls:Object[],fitCalls:Object[]}} Fixture state.
 */
function createAdapterFixture(fitToBounds, classifyResult = null) {
  const wmsCalls = [];
  const fitCalls = [];
  const tileErrors = [];
  const categoryCalls = [];
  const numericCalls = [];
  const leaflet = {
    tileLayer: {
      wms(url, options) {
        const layer = {
          styleRequests: [],
          once(type, handler) {
            this.errorHandler = { type, handler };
          },
          setParams(parameters) {
            this.styleRequests.push(parameters);
          },
        };
        wmsCalls.push({ url, options, layer });
        return layer;
      },
    },
  };
  const leafletMap = {
    fitBounds(bounds, options) {
      fitCalls.push({ bounds, options });
    },
  };
  return {
    adapter: createVectorMapLayerAdapter({
      leaflet,
      leafletMap,
      wmsUrl: "/geoserver/eolab/wms",
      onTileError(message, item) {
        tileErrors.push({ message, item });
      },
      fitToBounds,
      publish: async () => PUBLICATION,
      style: async (_item, style) => ({
        styleName: style.fillColor === "#00ff00"
          ? "vector-style-0123456789abcdef01234567-aaaaaaaaaaaa"
          : "vector-style-0123456789abcdef01234567-bbbbbbbbbbbb",
        style,
      }),
      summarize: async (item, field) => {
        categoryCalls.push({ item, field });
        return { field, values: [] };
      },
      classify: async (item, field, method, classCount) => {
        numericCalls.push({ item, field, method, classCount });
        if (classifyResult !== null) {
          return structuredClone(classifyResult);
        }
        return { field, method, requestedClassCount: classCount };
      },
    }),
    wmsCalls,
    fitCalls,
    tileErrors,
    categoryCalls,
    numericCalls,
  };
}

test("vector map-layer adapter owns publication, WMS, legend, and optional fit", async () => {
  const fitted = createAdapterFixture(true);
  const item = {
    collection: "eolab-mounted-vectors",
    id: "geopackage-0123456789abcdef01234567",
    properties: {
      title: "Parcels",
      "table:primary_geometry": "geometry",
      "table:columns": [
        { name: "geometry", type: "Polygon" },
        { name: "name", type: "str" },
        { name: "area", type: "float" },
      ],
    },
  };

  const initialized = await fitted.adapter.publish(item);
  assert.equal(initialized.style.label.field, "name");
  assert.match(initialized.defaultStyleNotice, /numeric coloring was unavailable/);
  assert.deepEqual(fitted.numericCalls.splice(0), [{
    item, field: "area", method: "percentile-interval", classCount: 5,
  }]);
  assert.equal(fitted.adapter.label(item), "Parcels");
  const record = {
    publication: PUBLICATION,
    entry: { item },
    error: "Vector map tiles could not be rendered.",
  };
  record.state = fitted.adapter.createState({ item, publication: PUBLICATION });
  assert.deepEqual(record.state.labelFields, [
    { name: "name", type: "str" },
    { name: "area", type: "float" },
  ]);
  const layer = fitted.adapter.createLayer(record, () => {});
  assert.deepEqual(
    await fitted.adapter.summarizeCategories(record, "name"),
    { field: "name", values: [] },
  );
  assert.deepEqual(fitted.categoryCalls, [{ item, field: "name" }]);
  assert.deepEqual(
    await fitted.adapter.classifyNumbers(record, "area", "quantile", 5),
    { field: "area", method: "quantile", requestedClassCount: 5 },
  );
  assert.deepEqual(fitted.numericCalls, [{
    item,
    field: "area",
    method: "quantile",
    classCount: 5,
  }]);
  assert.equal(
    layer.errorHandler.type,
    "tileerror",
  );
  assert.deepEqual(fitted.adapter.snapshot(record), {
    datasetKind: "vector",
    canFilter: true,
    filterActive: false,
    filterStatus: "",
    legend: {
      kind: "fixed",
      label: "Polygon",
      fill: "#fd8d3c",
      stroke: "#800026",
    },
  });
  fitted.adapter.added(record);
  assert.deepEqual(fitted.fitCalls[0].bounds, [[48, -123], [49, -122]]);
  fitted.adapter.tileError(record);
  assert.deepEqual(fitted.tileErrors, [{ message: record.error, item }]);
  const appliedStyle = {
    ...PUBLICATION.style,
    fillColor: "#00ff00",
    fillOpacity: 0.6,
  };
  assert.deepEqual(
    await fitted.adapter.applyStyle(record, appliedStyle),
    appliedStyle,
  );
  assert.deepEqual(layer.styleRequests, [{
    styles: "vector-style-0123456789abcdef01234567-aaaaaaaaaaaa",
  }]);
  assert.equal(fitted.adapter.snapshot(record).legend.fill, "#00ff00");
  const reappliedStyle = {
    ...appliedStyle,
    fillColor: "#ff0000",
  };
  assert.deepEqual(
    await fitted.adapter.applyStyle(record, reappliedStyle),
    reappliedStyle,
  );
  assert.deepEqual(layer.styleRequests, [
    {
      styles: "vector-style-0123456789abcdef01234567-aaaaaaaaaaaa",
    },
    {
      styles: "vector-style-0123456789abcdef01234567-bbbbbbbbbbbb",
    },
  ]);
  assert.equal(fitted.adapter.snapshot(record).legend.fill, "#ff0000");
  assert.deepEqual(fitted.adapter.exportSavedState(record), {
    kind: "vector",
    definition: reappliedStyle,
  });
  assert.equal(
    fitted.adapter.checkSavedStateCompatibility(record, {
      kind: "vector",
      definition: reappliedStyle,
    }),
    null,
  );
  assert.match(
    fitted.adapter.checkSavedStateCompatibility(record, {
      kind: "raster",
      definition: {},
    }),
    /Only copied vector styles/,
  );
  assert.match(
    fitted.adapter.checkSavedStateCompatibility(record, {
      kind: "vector",
      definition: {
        ...reappliedStyle,
        geometryKind: "point",
        pointSize: 8,
      },
    }),
    /point style cannot be pasted onto a polygon layer/,
  );
  assert.match(
    fitted.adapter.checkSavedStateCompatibility(record, {
      kind: "vector",
      definition: {
        ...reappliedStyle,
        label: {
          field: "missing-name",
          fontFamily: "SansSerif",
          fontSize: 12,
          fontWeight: "normal",
          fontColor: "#111111",
          haloColor: "#ffffff",
          haloWidth: 1,
          placement: "center",
          minimumZoom: 0,
        },
      },
    }),
    /does not contain label field/,
  );
  assert.match(
    fitted.adapter.checkSavedStateCompatibility(record, {
      kind: "vector",
      definition: {
        ...reappliedStyle,
        categorical: {
          field: "area",
          limit: 20,
          rules: [{
            value: { kind: "string", value: "large" },
            color: "#ff0000",
          }],
          otherColor: null,
          missingColor: null,
        },
      },
    }),
    /does not contain compatible category field/,
  );
  await fitted.adapter.applySavedState(record, {
    kind: "vector",
    definition: appliedStyle,
  });
  assert.equal(record.state.style.fillColor, "#00ff00");
  await assert.rejects(
    () => fitted.adapter.applySavedState(record, {
      kind: "vector",
      definition: { ...appliedStyle, sld: "<StyledLayerDescriptor/>" },
    }),
    /unsupported fields/,
  );

  const unfitted = createAdapterFixture(false);
  unfitted.adapter.added(record);
  assert.deepEqual(unfitted.fitCalls, []);
  assert.throws(
    () => createVectorMapLayerAdapter({
      leaflet: {},
      leafletMap: {},
      wmsUrl: "/wms",
      onTileError() {},
      fitToBounds: "yes",
    }),
    TypeError,
  );
});

test("copied graduated styles use the target vector classification", async () => {
  const targetClassification = {
    field: "score",
    fieldType: "float",
    method: "quantile",
    requestedClassCount: 5,
    actualClassCount: 2,
    classes: [
      { minimum: null, maximum: 12, count: 6 },
      { minimum: 12, maximum: null, count: 4 },
    ],
    observedMinimum: 2,
    observedMaximum: 20,
    numericValueCount: 10,
    scannedFeatureCount: 10,
    featureCount: 10,
    nullCount: 0,
    unsupportedValueCount: 0,
    complete: true,
    defaultClassCount: 5,
    minimumClassCount: 2,
    maximumClassCount: 9,
  };
  const fixture = createAdapterFixture(false, targetClassification);
  const item = {
    collection: "eolab-mounted-vectors",
    id: "shapefile-target",
    properties: {
      title: "Target points",
      "table:primary_geometry": "geometry",
      "table:columns": [
        { name: "geometry", type: "Point" },
        { name: "score", type: "float" },
      ],
    },
  };
  const targetStyle = {
    geometryKind: "point",
    fillColor: "#2563eb",
    fillOpacity: 0.7,
    strokeColor: "#1e3a8a",
    strokeOpacity: 1,
    strokeWidth: 1,
    pointSize: 8,
    categorical: null,
    graduated: null,
    label: null,
  };
  const copiedStyle = {
    ...targetStyle,
    fillColor: "#a855f7",
    graduated: {
      field: "score",
      method: "quantile",
      classCount: 5,
      palette: "viridis",
      rules: [
        { minimum: null, maximum: 3, color: "#440154" },
        { minimum: 3, maximum: 7, color: "#21918c" },
        { minimum: 7, maximum: null, color: "#fde725" },
      ],
      missingColor: "#d1d5db",
    },
  };
  const publication = {
    ...PUBLICATION,
    geometryKind: "point",
    style: targetStyle,
  };
  const record = { publication, entry: { item } };
  record.state = fixture.adapter.createState({ item, publication });
  fixture.adapter.createLayer(record, () => {});

  await fixture.adapter.applySavedState(record, {
    kind: "vector",
    definition: copiedStyle,
  });

  assert.deepEqual(fixture.numericCalls, [{
    item,
    field: "score",
    method: "quantile",
    classCount: 5,
  }]);
  assert.deepEqual(record.state.style.graduated, {
    field: "score",
    method: "quantile",
    classCount: 5,
    palette: "viridis",
    rules: [
      { minimum: null, maximum: 12, color: "#440154" },
      { minimum: 12, maximum: null, color: "#fde725" },
    ],
    missingColor: null,
  });
  assert.equal(record.state.style.fillColor, "#a855f7");
});

test("adding a crossing vector shows both map edges and preserves its catalog bounds", () => {
    const fixture = createAdapterFixture(true);
    const publication = { ...PUBLICATION, bbox: [170, -10, -170, 10] };
    fixture.adapter.added({ publication });
    assert.deepEqual(fixture.fitCalls[0].bounds, [[-10, -180], [10, 180]]);
    assert.deepEqual(publication.bbox, [170, -10, -170, 10]);
    fixture.adapter.added({ publication }, { fitToBounds: false });
    assert.equal(fixture.fitCalls.length, 1);
});
