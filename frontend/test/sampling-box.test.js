import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    SAMPLING_BOX_EARTH_RADIUS_KM, SamplingBoxBoundaryError,
    normalizeSamplingBox, samplingBoxBounds, samplingBoxCorners,
    interpolateGreatCircle, tessellateSamplingBox,
} from "../src/sampling-box.js";
import { normalizeRasterSamplingArea } from "../src/selected-area.js";

const goldens = JSON.parse(readFileSync(new URL("../../tests/fixtures/sampling-box-geodesics.json", import.meta.url), "utf8"));

/** Compare degree-valued reference coordinates at double-precision accuracy.
 * @param {number[]} actual Calculated position.
 * @param {number[]} expected Shared independent-reference position.
 * @return {void}
 */
function assertPosition(actual, expected) {
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9,
        `${value} differs from ${expected[index]}`));
}

for (const example of goldens.cases) {
    test(`shared spherical geometry: ${example.name}`, () => {
        assert.equal(SAMPLING_BOX_EARTH_RADIUS_KM, goldens.earthRadiusKm);
        const box = normalizeSamplingBox(example.samplingBox);
        const corners = samplingBoxCorners(box);
        corners.forEach((point, index) => {
            assertPosition(point, example.corners[index]);
            assertPosition(interpolateGreatCircle(point, corners[(index + 1) % 4], 0.5), example.edgeMidpoints[index]);
        });
        const bounds = samplingBoxBounds(box);
        ["west", "south", "east", "north"].forEach((field, index) => {
            assert.ok(Math.abs(bounds[field] - example.bounds[index]) < 1e-9);
        });
    });
}

/** Interpolate unit vectors independently of the forward-bearing implementation.
 * @param {number[]} start Geographic start in degrees.
 * @param {number[]} end Geographic end in degrees.
 * @param {number} fraction Fraction of the shorter great-circle edge.
 * @return {number[]} Longitude/latitude position in degrees.
 */
function sphericalReference(start, end, fraction) {
    const vectors = [start, end].map(([longitude, latitude]) => {
        longitude *= Math.PI / 180; latitude *= Math.PI / 180;
        return [Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude)];
    });
    const angle = Math.acos(vectors[0].reduce((sum, value, index) => sum + value * vectors[1][index], 0));
    const weights = [Math.sin((1 - fraction) * angle), Math.sin(fraction * angle)];
    const vector = vectors[0].map((value, index) => (value * weights[0] + vectors[1][index] * weights[1]) / Math.sin(angle));
    return [Math.atan2(vector[1], vector[0]) * 180 / Math.PI,
        Math.atan2(vector[2], Math.hypot(vector[0], vector[1])) * 180 / Math.PI];
}

/** Project to a rotated, anisotropic Web Mercator pixel grid.
 * @param {number[]} position Geographic position in degrees.
 * @return {number[]} Actual pixel coordinates, with unequal rotated axis scales.
 */
function projectedPixel([longitude, latitude]) {
    const x = longitude * Math.PI / 180 * 6378137;
    const y = Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) * 6378137;
    return [x / 1200 + y / 6000, -x / 9000 + y / 500];
}

/** Measure a point's closest distance to the projected polygon boundary.
 * @param {number[]} point Target pixel coordinate.
 * @param {number[][]} ring Closed projected polyline.
 * @return {number} Distance in actual target pixels.
 */
function distanceToRing(point, ring) {
    let minimum = Infinity;
    for (let index = 1; index < ring.length; index++) {
        const start = ring[index - 1], end = ring[index];
        const dx = end[0] - start[0], dy = end[1] - start[1];
        const fraction = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
        minimum = Math.min(minimum, Math.hypot(point[0] - start[0] - fraction * dx, point[1] - start[1] - fraction * dy));
    }
    return minimum;
}

for (const name of ["northern", "high-latitude", "continental"]) {
    test(`display approximation converges on a rotated pixel grid: ${name}`, () => {
        const box = normalizeSamplingBox(goldens.cases.find(value => value.name === name).samplingBox);
        const corners = samplingBoxCorners(box);
        const dense = corners.flatMap((point, edge) => Array.from({length: 501}, (_, index) =>
            projectedPixel(sphericalReference(point, corners[(edge + 1) % 4], index / 500))));
        let previousCount = 0;
        for (const maximumErrorPixels of [0.25, 0.0625]) {
            const ring = tessellateSamplingBox(box, positions => positions.map(projectedPixel), {maximumErrorPixels});
            assert.deepEqual(ring[0], ring.at(-1));
            assert.ok(ring.length >= previousCount);
            const projected = ring.map(projectedPixel);
            const error = Math.max(...dense.map(point => distanceToRing(point, projected)));
            assert.ok(error <= maximumErrorPixels * 1.005, `${error} exceeds ${maximumErrorPixels}`);
            previousCount = ring.length;
        }
    });
}

test("captured box is immutable, path-free and distinct from its rectangle envelope", () => {
    const source = {center: {longitude: 0, latitude: 60}, sideLengthKm: 600};
    const area = normalizeRasterSamplingArea({kind: "samplingBox", samplingBox: source});
    source.center.latitude = 0;
    assert.equal(area.samplingBox.center.latitude, 60);
    assert.ok(Object.isFrozen(area.samplingBox.center));
    assert.deepEqual(Object.keys(area.samplingBox).sort(), ["center", "sideLengthKm"]);
    assert.deepEqual(normalizeRasterSamplingArea(JSON.parse(JSON.stringify(area))), area);
    const rectangle = normalizeRasterSamplingArea({kind: "selectedArea", selectedBounds: samplingBoxBounds(area.samplingBox)});
    assert.equal(rectangle.kind, "selectedArea");
    assert.ok(!Object.hasOwn(rectangle, "samplingBox"));
    assert.throws(() => normalizeSamplingBox({...area.samplingBox, sourcePath: "/source/file"}), TypeError);
});

test("existing pole/date-line limits and caller-owned coordinate capacity are retained", () => {
    for (const center of [{longitude: 0, latitude: 89}, {longitude: 179, latitude: 0}]) {
        assert.throws(() => normalizeSamplingBox({center, sideLengthKm: 600}), SamplingBoxBoundaryError);
    }
    const box = normalizeSamplingBox({center: {longitude: 0, latitude: 60}, sideLengthKm: 2000});
    const project = positions => positions.map(projectedPixel);
    assert.throws(() => tessellateSamplingBox(box, project, {maximumCoordinates: 15}), /capacity/);
    assert.ok(tessellateSamplingBox(box, project, {maximumCoordinates: null}).length > 16);
    assert.throws(() => tessellateSamplingBox(box, project, {maximumErrorPixels: 0}), /accuracy/);
    assert.throws(() => tessellateSamplingBox(box, positions => positions.map(() => [Infinity, 0])), /projected/);
});
