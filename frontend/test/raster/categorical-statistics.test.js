import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCategoryValues, validateCategoricalDistribution } from "../../src/raster/categorical-statistics.js";
import { loadRasterStatistics } from "../../src/raster/analysis-api.js";
import { presentCategoricalRasterDistribution } from "../../src/raster/categorical-presentation.js";
import { createCategoricalRasterHistogram } from "../../src/raster/categorical-histogram-view.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { MOUNTED_GEOTIFF_ITEM, RASTER_STATISTICS } from "../../test-support/raster/fixtures.js";

const distribution = { categoryValues: [0, 41], areasHectares: [10, 20], unmappedAreaHectares: 5,
    validAreaHectares: 35, nodataAreaHectares: 3, areaEstimated: true,
    areaMethod: "sample-cell-equal-area-v1", selectionSubdivisions: 4 };
const style = { categories: [{ value: 41, label: "Forest <b>literal</b>", color: "#228b22", opacity: 0.75 },
    { value: 0, label: "Background", color: "#000000", opacity: 0 }], unmapped: { color: "#808080", opacity: 0.25 } };

test("numeric category boundary canonicalizes exact bounded codes and validates area balances", () => {
    assert.deepEqual(normalizeCategoryValues([41, 0]), [0, 41]);
    for (const codes of [[], [1, 1], [1.5], ["1"], [NaN], [2 ** 53], Array.from({ length: 257 }, (_, i) => i)]) {
        assert.throws(() => normalizeCategoryValues(codes), TypeError);
    }
    assert.equal(validateCategoricalDistribution(distribution), distribution);
    for (const patch of [{ areaEstimated: false }, { validAreaHectares: 0 }, { areasHectares: [10, -20] },
        { areasHectares: [10] }, { categoryValues: [41, 0] }, { nodataAreaHectares: Infinity }, { unmappedAreaHectares: 6 }]) {
        assert.throws(() => validateCategoricalDistribution({ ...distribution, ...patch }), /invalid categorical/);
    }
});

test("category API sends only sorted codes and rejects stale or missing classifications", async () => {
    const requests = [];
    const signal = new AbortController().signal;
    const response = { ...RASTER_STATISTICS, categoricalDistribution: distribution };
    const result = await loadRasterStatistics(MOUNTED_GEOTIFF_ITEM, { kind: "wholeRaster" }, signal,
        async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify(response)); }, [41, 0]);
    assert.deepEqual(result.categoricalDistribution, distribution);
    assert.deepEqual(requests[0], { collectionId: MOUNTED_GEOTIFF_ITEM.collection, itemId: MOUNTED_GEOTIFF_ITEM.id, categoryValues: [0, 41] });
    for (const codes of [[0, 42], null]) await assert.rejects(loadRasterStatistics(MOUNTED_GEOTIFF_ITEM,
        { kind: "wholeRaster" }, signal, async () => new Response(JSON.stringify(response)), codes), /different category classification/);
    await assert.rejects(loadRasterStatistics(MOUNTED_GEOTIFF_ITEM, { kind: "wholeRaster" }, signal,
        async () => new Response(JSON.stringify(RASTER_STATISTICS)), [0, 41]), /different category classification/);
});

test("a categorical histogram sends the drawing reference and rejects stale polygon provenance", async () => {
    const polygonArea = {id: "a".repeat(32), sha256: "b".repeat(64)};
    const area = {kind: "polygonArea", polygonArea};
    const response = {...RASTER_STATISTICS, scope: "polygonArea", polygonArea, categoricalDistribution: distribution};
    const result = await loadRasterStatistics(MOUNTED_GEOTIFF_ITEM, area, undefined, async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), {
            collectionId: MOUNTED_GEOTIFF_ITEM.collection, itemId: MOUNTED_GEOTIFF_ITEM.id,
            polygonArea, categoryValues: [0, 41],
        });
        assert.equal(options.headers["X-EOLab-Processing"], "1");
        assert.equal(options.credentials, "same-origin");
        return Response.json(response);
    }, [41, 0]);
    assert.deepEqual(result.polygonArea, polygonArea);
    assert.deepEqual(result.categoricalDistribution, distribution);
    await assert.rejects(loadRasterStatistics(MOUNTED_GEOTIFF_ITEM, area, undefined,
        async () => Response.json({...response, polygonArea: {...polygonArea, sha256: "c".repeat(64)}}), [0, 41]),
        /polygon-area response identity/);
});

test("category presentation sorts area, retains transparent data and uses valid-area denominator", () => {
    const model = presentCategoricalRasterDistribution({ ...RASTER_STATISTICS, categoricalDistribution: distribution }, style);
    assert.deepEqual(model.rows.map(row => row.label), ["Forest <b>literal</b>", "Background", "Unmapped"]);
    assert.deepEqual(model.rows.map(row => row.opacity), [0.75, 0, 0.25]);
    assert.equal(model.rows[0].percentage, 100 * 20 / 35);
    assert.equal(model.nodataHectares, 3);
    const document = new FakeRasterControlDocument();
    const root = createCategoricalRasterHistogram(model, document);
    const row = root.children[1].children[0];
    assert.equal(row.children[0].textContent, "Forest <b>literal</b> (41)");
    const fill = row.children[1].children[0].children[0];
    assert.equal(fill.style.backgroundColor, "#228b22");
    assert.equal(fill.style.opacity, "0.75");
    assert.equal(root.children[1].children[1].children[1].children[0].children[0].style.opacity, "0");
    assert.match(root.children[3].textContent, /NoData excluded: 3 ha/);
});

test("all 256 categories expand with aggregated remainder and preserved keyboard focus", () => {
    const document = new FakeRasterControlDocument();
    const rows = Array.from({ length: 256 }, (_, code) => ({ label: "Category " + code, code,
        color: "#ff0000", opacity: 0.5, hectares: 1, percentage: 100 / 256 }));
    const root = createCategoricalRasterHistogram({ rows, validHectares: 256, nodataHectares: 0, sampledPixelCount: 256 }, document);
    const list = root.children[1], toggle = root.children[2];
    assert.equal(list.children.length, 13);
    assert.equal(list.children[12].children[0].textContent, "244 more categories");
    toggle.focus(); toggle.dispatchEvent(new Event("click"));
    assert.equal(list.children.length, 256);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(document.activeElement, toggle);
    toggle.dispatchEvent(new Event("click"));
    assert.equal(list.children.length, 13);
});


test("categorical sampling-box analysis preserves geometry and category identities together", async () => {
    const area = {kind: "samplingBox", samplingBox: {center: {longitude: 0, latitude: 60}, sideLengthKm: 600}};
    let body;
    const response = {...RASTER_STATISTICS, scope: "samplingBox", samplingBox: area.samplingBox, categoricalDistribution: distribution};
    const result = await loadRasterStatistics(MOUNTED_GEOTIFF_ITEM, area, undefined, async (_url, options) => {
        body = JSON.parse(options.body); return new Response(JSON.stringify(response));
    }, [41, 0]);
    assert.deepEqual(body.samplingBox, area.samplingBox);
    assert.deepEqual(body.categoryValues, [0, 41]);
    assert.equal(Object.hasOwn(body, "selectedBounds"), false);
    assert.deepEqual(result.categoricalDistribution, distribution);
});
