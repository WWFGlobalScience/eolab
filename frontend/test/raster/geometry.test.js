import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRasterSampleWindowBounds,
  DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
  MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM,
  isCanonicalWgs84Position,
  validateRasterSampleWindowSize,
  validateRasterSelectedBounds,
} from "../../src/raster/geometry.js";

test("canonical WGS 84 positions stay inside the single map world", () => {
  assert.equal(
    isCanonicalWgs84Position({ longitude: -180, latitude: -90 }),
    true,
  );
  assert.equal(
    isCanonicalWgs84Position({ longitude: 180, latitude: 90 }),
    true,
  );
  assert.equal(
    isCanonicalWgs84Position({ longitude: 180.001, latitude: 0 }),
    false,
  );
  assert.equal(
    isCanonicalWgs84Position({ longitude: 0, latitude: -90.001 }),
    false,
  );
  assert.equal(
    isCanonicalWgs84Position({ longitude: Number.NaN, latitude: 0 }),
    false,
  );
  assert.equal(isCanonicalWgs84Position(null), false);
});

test("sample windows use ground distance instead of projected map metres", () => {
  const equatorial = buildRasterSampleWindowBounds(
    { longitude: 0, latitude: 0 },
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
  );
  const highLatitude = buildRasterSampleWindowBounds(
    { longitude: 0, latitude: 60 },
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
  );

  assert.ok(Math.abs(equatorial.south + 2.6970) < 0.01);
  assert.ok(Math.abs(equatorial.north - 2.6970) < 0.01);
  assert.ok(Math.abs(equatorial.west + 2.7000) < 0.01);
  assert.ok(Math.abs(equatorial.east - 2.7000) < 0.01);
  assert.ok(highLatitude.east - highLatitude.west > 11.5);
  assert.equal(validateRasterSelectedBounds(equatorial), equatorial);
});

test("sample window contract rejects invalid sizes and unsupported crossings", () => {
  assert.equal(validateRasterSampleWindowSize(1), 1);
  assert.equal(validateRasterSampleWindowSize(300), 300);
  for (const value of [0, 1.5, NaN, Infinity, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM + 1]) {
    assert.throws(() => validateRasterSampleWindowSize(value), /between 1 and/);
  }
  assert.throws(
    () => buildRasterSampleWindowBounds(
      { longitude: 179.5, latitude: 0 },
      200,
    ),
    /pole or date line/,
  );
  assert.throws(
    () => buildRasterSampleWindowBounds(
      { longitude: 0, latitude: 89.5 },
      200,
    ),
    /pole or date line/,
  );
});

test("continental boxes grow beyond 300 km while retaining the non-wrapping contract", () => {
  let previous = null;
  for (const size of [301, 1000, 5000, 10000, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM]) {
    assert.equal(validateRasterSampleWindowSize(size), size);
    const bounds = buildRasterSampleWindowBounds({ longitude: 0, latitude: 0 }, size);
    assert.ok(bounds.west > -180 && bounds.east < 180);
    assert.ok(bounds.south > -90 && bounds.north < 90);
    assert.ok(bounds.west < 0 && bounds.east > 0);
    assert.ok(bounds.south < 0 && bounds.north > 0);
    if (previous) {
      assert.ok(bounds.east > previous.east);
      assert.ok(bounds.north > previous.north);
    }
    previous = bounds;
  }
  const india = buildRasterSampleWindowBounds({ longitude: 78, latitude: 22 }, 5000);
  assert.ok(india.east - india.west > 40);
  assert.ok(india.north - india.south > 40);
  for (const center of [{longitude: 170, latitude: 0}, {longitude: 0, latitude: 70}]) {
    assert.throws(() => buildRasterSampleWindowBounds(center, 5000), /Whole raster/);
  }
});
