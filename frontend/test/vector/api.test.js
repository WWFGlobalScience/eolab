import assert from "node:assert/strict";
import test from "node:test";

import {
    assessCatalogVector,
    classifyVectorNumbers,
    countVectorFilter,
    getVectorFieldValues,
    getVectorFilterExtent,
    publishVector,
    styleVector,
    summarizeVectorCategories,
    VectorRenderingRequestError,
} from "../../src/vector/api.js";

const VECTOR_ITEM = Object.freeze({
    collection: "eolab-mounted-vectors",
    id: "geopackage-0123456789abcdef01234567",
});

test("prepared field values send only Catalog identity and matching page, preserving exact strings", async () => {
    const source = { collectionId: "vectors", itemId: "countries", path: "must-not-send", filter: {} };
    const query = { field: "name", search: " ß ", offset: 50 };
    const controller = new AbortController();
    const page = { field: "name", values: ["", "  literal  ", "NULL", "é", "a\nb", "x".repeat(257)], nextOffset: 56, truncated: true };
    assert.deepEqual(await getVectorFieldValues(source, query, controller.signal, async (url, options) => {
        assert.equal(url, "/api/catalog/vector-field-values");
        assert.equal(options.method, "POST"); assert.equal(options.signal, controller.signal);
        assert.equal(options.cache, "no-store"); assert.equal(options.credentials, "same-origin");
        assert.deepEqual(JSON.parse(options.body), { collectionId: "vectors", itemId: "countries", ...query, limit: 50 });
        return Response.json(page);
    }), page);
});

test("prepared upload values use the browser cookie and encode exact search text", async () => {
    const source = { uploadId: "owned/id" }, query = { field: "Group & name", search: "a+b &é", offset: 0 };
    const page = { field: query.field, values: ["a+b &é"], nextOffset: null, truncated: false };
    assert.deepEqual(await getVectorFieldValues(source, query, undefined, async (url, options) => {
        const parsed = new URL(url, "https://eolab.test");
        assert.equal(parsed.pathname, "/api/vector-uploads/owned%2Fid/field-values");
        assert.deepEqual(Object.fromEntries(parsed.searchParams), { field: query.field, search: query.search, offset: "0", limit: "50" });
        assert.equal(options.method, "GET"); assert.equal(options.body, undefined);
        assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
        return Response.json(page);
    }), page);
    await assert.rejects(getVectorFieldValues(source, query, undefined, async () => new Response("", { status: 404 })), /browser that uploaded/);
});

test("prepared value lookup rejects malformed pages and preserves unavailable, transport and abort failures", async () => {
    const source = { collectionId: "vectors", itemId: "countries" }, query = { field: "name", search: "", offset: 0 };
    const valid = { field: "name", values: ["exact"], nextOffset: null, truncated: false };
    for (const page of [null, {...valid, field: "other"}, {...valid, values: [null]}, {...valid, values: [1]},
        {...valid, values: Array(51).fill("a")}, {...valid, nextOffset: 0}, {...valid, nextOffset: 2},
        {...valid, values: [], nextOffset: 1}, {...valid, truncated: "false"}, {...valid, truncated: undefined},
        {field: "name", values: []}]) {
        await assert.rejects(getVectorFieldValues(source, query, undefined, async () => Response.json(page)), /invalid response/);
    }
    await assert.rejects(getVectorFieldValues(source, query, undefined, async () => new Response("not JSON")), /invalid response/);
    await assert.rejects(getVectorFieldValues(source, query, undefined, async () => Response.json({detail: "Choose a string field with prepared values."}, {status: 409})), /prepared values/);
    await assert.rejects(getVectorFieldValues(source, query, undefined, async () => { throw Error("offline"); }), /connection/);
    await assert.rejects(getVectorFieldValues(source, query, undefined, async () => { throw new DOMException("Cancelled", "AbortError"); }), {name: "AbortError"});
});

test("filter count distinguishes queue saturation and expiry from incomplete counts", async () => {
    const controller = new AbortController();
    for (const [status, category] of [[429, "filter_count_queue_full"], [503, "filter_count_queue_timeout"]]) {
        await assert.rejects(countVectorFilter(VECTOR_ITEM, {}, controller.signal, async (url, options) => {
            assert.equal(url, "/api/vector-rendering/filter-counts");
            assert.equal(options.signal, controller.signal);
            return new Response(JSON.stringify({ detail: { category, message: "Apply filter again to retry counting." } }), { status });
        }), error => error instanceof VectorRenderingRequestError && error.category === category);
    }
    const incomplete = { matched: null, total: null, complete: false };
    assert.deepEqual(await countVectorFilter(VECTOR_ITEM, {}, undefined, async () =>
        new Response(JSON.stringify(incomplete))), incomplete);
    await assert.rejects(countVectorFilter(VECTOR_ITEM, {}, controller.signal, async () => {
        throw new DOMException("Canceled", "AbortError");
    }), { name: "AbortError" });
});

test("vector assessment sends only the selected Catalog identity", async () => {
    const requests = [];
    const assessedItem = { ...VECTOR_ITEM, properties: {} };

    assert.deepEqual(await assessCatalogVector(
        VECTOR_ITEM,
        async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify(assessedItem), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
    ), assessedItem);
    assert.deepEqual(requests, [{
        url: "/api/vector-rendering/assessments",
        options: {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                collectionId: VECTOR_ITEM.collection,
                itemId: VECTOR_ITEM.id,
            }),
        },
    }]);
});

test("vector publication validates exact fixed-style WMS metadata", async () => {
    const publication = {
        layerName: `eolab:${VECTOR_ITEM.id}`,
        bbox: [-123, 48, -122, 49],
        geometryKind: "polygon",
        styleName: "vector-polygon",
        style: {
            geometryKind: "polygon",
            fillColor: "#a855f7",
            fillOpacity: 0.38,
            strokeColor: "#581c87",
            strokeOpacity: 1,
            strokeWidth: 2,
            pointSize: null,
            label: null,
        },
    };

    assert.deepEqual(await publishVector(
        VECTOR_ITEM,
        async () => new Response(JSON.stringify(publication), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })
    ), publication);

    await assert.rejects(
        publishVector(
            VECTOR_ITEM,
            async () => new Response(JSON.stringify({
                ...publication,
                styleName: "dynamic-raster",
            }), { status: 200 })
        ),
        /invalid layer contract/
    );
});

test("vector styling sends complete symbol state and accepts an opaque approval", async () => {
    const requests = [];
    const style = {
        geometryKind: "line",
        fillColor: null,
        fillOpacity: null,
        strokeColor: "#f97316",
        strokeOpacity: 0.75,
        strokeWidth: 4,
        pointSize: null,
        label: {
            field: "name",
            fontFamily: "SansSerif",
            fontSize: 12,
            fontWeight: "bold",
            fontColor: "#112233",
            haloColor: "#ffffff",
            haloWidth: 1.5,
            placement: "follow-line",
            minimumZoom: 6,
        },
    };
    const result = {
        styleName: "opaque-style-approval",
        style,
    };

    assert.deepEqual(await styleVector(
        VECTOR_ITEM,
        style,
        async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify(result), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        },
    ), result);
    assert.equal(requests[0].url, "/api/vector-rendering/styles");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        collectionId: VECTOR_ITEM.collection,
        itemId: VECTOR_ITEM.id,
        style,
    });
});

test("vector category summary sends identity and field then validates limits", async () => {
    const requests = [];
    const summary = {
        field: "risk",
        fieldType: "str:40",
        values: [
            { value: { kind: "string", value: "high" }, count: 7 },
            { value: { kind: "string", value: "low" }, count: 3 },
        ],
        observedDistinctCount: 2,
        distinctCount: 2,
        scannedFeatureCount: 10,
        featureCount: 10,
        nullCount: 0,
        unsupportedValueCount: 0,
        complete: true,
        defaultLimit: 20,
        maximumLimit: 50,
    };

    assert.deepEqual(await summarizeVectorCategories(
        VECTOR_ITEM,
        "risk",
        async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify(summary), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        },
    ), summary);
    assert.equal(requests[0].url, "/api/vector-rendering/category-summaries");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        collectionId: VECTOR_ITEM.collection,
        itemId: VECTOR_ITEM.id,
        field: "risk",
    });
});

test("vector numeric classification sends bounded options and rejects invalid HTTP responses", async () => {
    const requests = [];
    const summary = {
        field: "score",
        fieldType: "float",
        method: "equal-interval",
        requestedClassCount: 3,
        actualClassCount: 3,
        classes: [
            { minimum: null, maximum: 1, count: 4 },
            { minimum: 1, maximum: 2, count: 3 },
            { minimum: 2, maximum: null, count: 2 },
        ],
        observedMinimum: 0,
        observedMaximum: 3,
        numericValueCount: 9,
        scannedFeatureCount: 10,
        featureCount: 10,
        nullCount: 1,
        unsupportedValueCount: 0,
        complete: true,
        defaultClassCount: 5,
        minimumClassCount: 2,
        maximumClassCount: 9,
    };

    assert.deepEqual(await classifyVectorNumbers(
        VECTOR_ITEM,
        "score",
        "equal-interval",
        3,
        async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify(summary), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        },
    ), summary);
    assert.equal(requests[0].url, "/api/vector-rendering/numeric-classifications");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        collectionId: VECTOR_ITEM.collection,
        itemId: VECTOR_ITEM.id,
        field: "score",
        method: "equal-interval",
        classCount: 3,
    });
    // Reject malformed or mismatched HTTP replies before returning a classification.
    for (const invalid of [
        { field: "other" }, { method: "quantile" },
        { requestedClassCount: 4 }, { classes: [] },
    ]) {
        await assert.rejects(classifyVectorNumbers(
            VECTOR_ITEM, "score", "equal-interval", 3,
            async () => new Response(JSON.stringify({ ...summary, ...invalid })),
        ), VectorRenderingRequestError);
    }
});

test("vector publication preserves actionable upstream categories", async () => {
    const request = publishVector(
        VECTOR_ITEM,
        async () => new Response(JSON.stringify({
            detail: {
                category: "configuration",
                message: "The vector style is not initialized.",
            },
        }), { status: 503, headers: { "Content-Type": "application/json" } })
    );

    await assert.rejects(request, (error) => {
        assert.equal(error instanceof VectorRenderingRequestError, true);
        assert.equal(error.category, "configuration");
        assert.equal(error.message, "The vector style is not initialized.");
        return true;
    });
});


test("filtered extents send only original-source identity and accepted predicate with private upload ownership", async () => {
    const predicate = {enabled: true, match: "all", rules: [{field: "year", operator: "eq", value: 2026}]};
    for (const source of [{collectionId: "vectors", itemId: "points", path: "/private"}, {uploadId: "owned-id", path: "/private"}]) {
        const controller = new AbortController();
        const result = {matched: 1, bbox: [5, 10, 5, 10]};
        assert.deepEqual(await getVectorFilterExtent(source, predicate, controller.signal, async (url, options) => {
            assert.equal(url, "/api/vector-sampling/extent");
            assert.equal(options.signal, controller.signal);
            assert.equal(options.credentials, "same-origin");
            assert.equal(options.cache, "no-store");
            assert.deepEqual(JSON.parse(options.body), {...("uploadId" in source ? {uploadId: source.uploadId} : {collectionId: source.collectionId, itemId: source.itemId}), filter: predicate});
            assert.equal(options.headers["X-EOLab-Uploads"], "uploadId" in source ? "1" : undefined);
            return Response.json(result);
        }), result);
    }
});

test("filtered extents preserve empty success and reject malformed bounds, read failures and cancellation", async () => {
    const source = {collectionId: "vectors", itemId: "points"};
    for (const value of [{matched: 0, bbox: null}, {matched: 2, bbox: null}, {matched: 2, bbox: [-180, -90, 180, 90]}]) {
        assert.deepEqual(await getVectorFilterExtent(source, {}, undefined, async () => Response.json(value)), value);
    }
    for (const value of [null, {}, {matched: -1, bbox: null}, {matched: 1.5, bbox: null},
        {matched: 0, bbox: [0, 0, 1, 1]}, {matched: 1, bbox: [2, 0, 1, 1]},
        {matched: 1, bbox: [-181, 0, 1, 1]}, {matched: 1, bbox: [0, 2, 1, 1]},
        {matched: 1, bbox: [0, 0, 1, 91]}, {matched: 1, bbox: [0, 0, 1]}]) {
        await assert.rejects(getVectorFilterExtent(source, {}, undefined, async () => Response.json(value)), /invalid bounds/);
    }
    await assert.rejects(getVectorFilterExtent(source, {}, undefined, async () => new Response("bad")), /invalid bounds/);
    await assert.rejects(getVectorFilterExtent(source, {}, undefined, async () => Response.json({detail: "This upload is not available to this browser."}, {status: 404})), /not available/);
    await assert.rejects(getVectorFilterExtent(source, {}, undefined, async () => { throw Error("offline"); }), /connection/);
    await assert.rejects(getVectorFilterExtent(source, {}, undefined, async () => { throw new DOMException("Cancelled", "AbortError"); }), {name: "AbortError"});
});
