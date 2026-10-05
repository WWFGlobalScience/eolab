import assert from "node:assert/strict";
import test from "node:test";

import { VectorStyleControls } from "../../src/vector/style-controls.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

/**
 * Create a deterministic timeout queue for debounce assertions.
 *
 * @return {Object} Injectable timer functions and test inspection helpers.
 */
function debounceClock() {
    let nextHandle = 0;
    const callbacks = new Map();
    return {
        /**
         * Retain one callback until the clock is flushed.
         * @param {() => void} callback Scheduled callback.
         * @return {number} Opaque timeout handle.
         */
        schedule(callback) {
            assert.equal(this, undefined);
            const handle = ++nextHandle;
            callbacks.set(handle, callback);
            return handle;
        },
        /**
         * Remove one scheduled callback.
         * @param {number} handle Opaque timeout handle.
         * @return {void}
         */
        cancel(handle) {
            assert.equal(this, undefined);
            callbacks.delete(handle);
        },
        /** Run every currently scheduled callback once. @return {void} */
        flush() {
            const current = [...callbacks.values()];
            callbacks.clear();
            for (const callback of current) callback();
        },
        /**
         * Return the number of callbacks waiting for the quiet period.
         * @return {number} Pending callback count.
         */
        pendingCount() {
            return callbacks.size;
        },
    };
}

/**
 * Flush the debounce clock and promise continuations.
 * @param {Object} fixture Style control test fixture.
 * @return {Promise<void>} Resolves after automatic style application settles.
 */
async function settleStyle(fixture) {
    fixture.clock.flush();
    await new Promise(resolve => setTimeout(resolve, 0));
}

function styleFixture() {
    const documentContext = new FakeRasterControlDocument();
    const clock = debounceClock();
    const controls = new VectorStyleControls(documentContext, {
        schedule: clock.schedule,
        cancel: clock.cancel,
        debounceMilliseconds: 450,
    });
    const applied = [];
    return {
        controls,
        documentContext,
        clock,
        applied,
        target(geometryKind, style) {
            return {
                key: geometryKind,
                style,
                fields: [
                    { name: "name", type: "str" },
                    { name: "value", type: "float" },
                ],
                async summarize(field) {
                    return {
                        field,
                        fieldType: field === "value" ? "float" : "str",
                        values: [
                            { value: { kind: "string", value: "A" }, count: 4 },
                            { value: { kind: "string", value: "B" }, count: 3 },
                            { value: { kind: "string", value: "C" }, count: 1 },
                            { value: { kind: "string", value: "D" }, count: 1 },
                        ],
                        observedDistinctCount: 4,
                        distinctCount: 4,
                        scannedFeatureCount: 10,
                        featureCount: 10,
                        nullCount: 1,
                        unsupportedValueCount: 0,
                        complete: true,
                        defaultLimit: 20,
                        maximumLimit: 50,
                    };
                },
                async classify(field, method, classCount) {
                    return {
                        field,
                        fieldType: "float",
                        method,
                        requestedClassCount: classCount,
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
                },
                async apply(nextStyle) {
                    applied.push(nextStyle);
                    return nextStyle;
                },
            };
        },
    };
}

test("vector style controls show fields owned by each geometry", () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("line", {
        geometryKind: "line",
        strokeColor: "#f97316",
        strokeOpacity: 1,
        strokeWidth: 3,
    }));
    assert.equal(fixture.controls.fillGroup.hidden, true);
    assert.equal(fixture.controls.pointGroup.hidden, true);
    assert.equal(fixture.controls.heading.textContent, "Line style");
    assert.equal(fixture.controls.labelEnabled.checked, false);
    assert.equal(fixture.controls.labelField.children.length, 2);
    assert.equal(fixture.controls.labelFontFamily.value, "SansSerif");
    assert.equal(fixture.controls.labelFontSize.value, "12");
    assert.equal(fixture.controls.labelFontWeight.value, "normal");
    assert.equal(fixture.controls.labelFontColor.value, "#111827");
    assert.equal(fixture.controls.labelHaloColor.value, "#ffffff");
    assert.equal(fixture.controls.labelHaloWidth.value, "1.5");
    assert.equal(fixture.controls.labelMinimumZoom.value, "0");

    fixture.controls.show(fixture.target("point", {
        geometryKind: "point",
        fillColor: "#06b6d4",
        fillOpacity: 1,
        strokeColor: "#083344",
        strokeOpacity: 1,
        strokeWidth: 1.5,
        pointSize: 9,
    }));
    assert.equal(fixture.controls.fillGroup.hidden, false);
    assert.equal(fixture.controls.pointGroup.hidden, false);
    fixture.controls.destroy();
});

test("vector style controls apply one complete validated state", async () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("polygon", {
        geometryKind: "polygon",
        fillColor: "#a855f7",
        fillOpacity: 0.38,
        strokeColor: "#581c87",
        strokeOpacity: 1,
        strokeWidth: 2,
    }));
    fixture.controls.fillColor.value = "#00ff00";
    fixture.controls.fillOpacity.value = "55";
    fixture.controls.strokeWidth.value = "4";
    fixture.controls.strokeWidth.dispatchEvent(new Event("input"));
    assert.equal(fixture.controls.status.textContent, "Changes pending...");
    assert.equal(fixture.applied.length, 0);
    await settleStyle(fixture);

    assert.deepEqual(fixture.applied, [{
        geometryKind: "polygon",
        fillColor: "#00ff00",
        fillOpacity: 0.55,
        strokeColor: "#581c87",
        strokeOpacity: 1,
        strokeWidth: 4,
        pointSize: null,
        categorical: null,
        graduated: null,
        label: null,
    }]);
    assert.equal(fixture.controls.status.textContent, "Style updated on the map.");
    fixture.controls.destroy();
});

test("vector controls start labels off, suggest a name field, and allow labels on", async () => {
    const { deriveDefaultVectorStyle } = await import("../../src/vector/defaults.js");
    const fixture = styleFixture();
    const style = deriveDefaultVectorStyle({
        geometryKind: "polygon", fillColor: "#2b83ba", fillOpacity: 0.7,
        strokeColor: "#000000", strokeOpacity: 1, strokeWidth: 0.75,
    }, [{ name: "name", type: "str" }]);
    const target = { ...fixture.target("polygon", style), notice: "Numeric coloring unavailable." };
    fixture.controls.show(target);
    assert.equal(fixture.controls.labelEnabled.checked, false);
    assert.equal(fixture.controls.labelField.value, "name");
    assert.equal(fixture.controls.labelMinimumZoom.value, "0");
    assert.equal(fixture.controls.graduatedPalette.value, "blue-yellow-red");
    assert.equal(fixture.controls.graduatedMethod.value, "percentile-interval");
    assert.equal(fixture.controls.status.textContent, target.notice);
    fixture.controls.labelEnabled.checked = true;
    fixture.controls.labelEnabled.dispatchEvent(new Event("change"));
    await settleStyle(fixture);
    assert.equal(fixture.applied[0].label.field, "name");
    assert.equal(fixture.applied[0].strokeWidth, 0.75);
    fixture.controls.destroy();
});

test("vector style controls coalesce rapid edits into the latest style", async () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("line", {
        geometryKind: "line",
        strokeColor: "#f97316",
        strokeOpacity: 1,
        strokeWidth: 2,
    }));

    fixture.controls.strokeWidth.value = "3";
    fixture.controls.strokeWidth.dispatchEvent(new Event("input"));
    fixture.controls.strokeWidth.value = "4";
    fixture.controls.strokeWidth.dispatchEvent(new Event("input"));

    assert.equal(fixture.clock.pendingCount(), 1);
    assert.equal(fixture.applied.length, 0);
    await settleStyle(fixture);
    assert.equal(fixture.applied.length, 1);
    assert.equal(fixture.applied[0].strokeWidth, 4);
    fixture.controls.destroy();
});

test("vector style controls apply a field-backed optional label", async () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("line", {
        geometryKind: "line",
        strokeColor: "#f97316",
        strokeOpacity: 1,
        strokeWidth: 3,
    }));
    fixture.controls.labelEnabled.checked = true;
    fixture.controls.labelEnabled.dispatchEvent(new Event("change"));
    fixture.controls.labelField.value = "value";
    fixture.controls.labelFontFamily.value = "Monospaced";
    fixture.controls.labelFontSize.value = "14";
    fixture.controls.labelFontWeight.value = "bold";
    fixture.controls.labelFontColor.value = "#112233";
    fixture.controls.labelHaloColor.value = "#ffffff";
    fixture.controls.labelHaloWidth.value = "2";
    fixture.controls.labelPlacement.value = "follow-line";
    fixture.controls.labelMinimumZoom.value = "7";
    fixture.controls.labelMinimumZoom.dispatchEvent(new Event("input"));
    await settleStyle(fixture);

    assert.deepEqual(fixture.applied[0].label, {
        field: "value",
        fontFamily: "Monospaced",
        fontSize: 14,
        fontWeight: "bold",
        fontColor: "#112233",
        haloColor: "#ffffff",
        haloWidth: 2,
        placement: "follow-line",
        minimumZoom: 7,
    });
    assert.equal(
        fixture.controls.labelNote.textContent,
        "Labels use value at zoom 7 and closer. Labels may overlap to keep names visible. " +
            "Centered and point labels wrap across lines and stay anchored as you zoom.",
    );
    fixture.controls.destroy();
});

test("vector category controls preserve colors as the bounded limit changes", async () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("polygon", {
        geometryKind: "polygon",
        fillColor: "#a855f7",
        fillOpacity: 0.38,
        strokeColor: "#581c87",
        strokeOpacity: 1,
        strokeWidth: 2,
    }));
    fixture.controls.mode.value = "categories";
    fixture.controls.mode.dispatchEvent(new Event("change"));
    await new Promise(resolve => setTimeout(resolve, 0));

    fixture.controls.categoryLimit.value = "2";
    fixture.controls.categoryLimit.dispatchEvent(new Event("input"));
    const firstColor = fixture.controls.categoryList.children[0].children[0];
    firstColor.value = "#123456";
    firstColor.dispatchEvent(new Event("input"));
    fixture.controls.categoryLimit.value = "3";
    fixture.controls.categoryLimit.dispatchEvent(new Event("input"));

    assert.equal(
        fixture.controls.categoryList.children[0].children[0].value,
        "#123456",
    );
    assert.equal(fixture.controls.categoryList.children.length, 5);
    await settleStyle(fixture);

    assert.equal(fixture.applied[0].categorical.field, "name");
    assert.equal(fixture.applied[0].categorical.limit, 3);
    assert.equal(fixture.applied[0].categorical.rules.length, 3);
    assert.equal(fixture.applied[0].categorical.rules[0].color, "#123456");
    assert.equal(fixture.applied[0].categorical.otherColor, "#9ca3af");
    assert.equal(fixture.applied[0].categorical.missingColor, "#d1d5db");
    fixture.controls.destroy();
});

test("same-layer refresh preserves an in-flight category discovery", async () => {
    const fixture = styleFixture();
    const baseTarget = fixture.target("polygon", {
        geometryKind: "polygon",
        fillColor: "#a855f7",
        fillOpacity: 0.38,
        strokeColor: "#581c87",
        strokeOpacity: 1,
        strokeWidth: 2,
    });
    const summary = await baseTarget.summarize("name");
    let finishSummary;
    fixture.controls.show({
        ...baseTarget,
        summarize: () => new Promise(resolve => { finishSummary = resolve; }),
    });
    fixture.controls.mode.value = "categories";
    fixture.controls.mode.dispatchEvent(new Event("change"));

    fixture.controls.show(baseTarget);
    finishSummary(summary);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(fixture.controls.categoryList.children.length, 5);
    assert.equal(fixture.clock.pendingCount(), 1);
    fixture.controls.destroy();
});

test("graduated controls classify, palette, and optionally style missing values", async () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("polygon", {
        geometryKind: "polygon",
        fillColor: "#a855f7",
        fillOpacity: 0.38,
        strokeColor: "#581c87",
        strokeOpacity: 1,
        strokeWidth: 2,
    }));
    fixture.controls.mode.value = "graduated";
    fixture.controls.graduatedClassCount.value = "3";
    fixture.controls.mode.dispatchEvent(new Event("change"));
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(fixture.controls.graduatedField.value, "value");
    assert.equal(fixture.controls.graduatedList.children.length, 4);
    const firstBoundary = fixture.controls.graduatedList.children[0].children[1].children[1];
    const secondBoundary = fixture.controls.graduatedList.children[1].children[1].children[1];
    firstBoundary.value = "0.75";
    firstBoundary.dispatchEvent(new Event("input"));
    secondBoundary.value = "2.25";
    secondBoundary.dispatchEvent(new Event("input"));
    assert.match(fixture.controls.graduatedStatus.textContent, /Exact custom ranges/);
    assert.equal(fixture.controls.graduatedList.children[0].children[2].textContent, "—");
    assert.equal(
        fixture.controls.graduatedList.children[2].children[1].children[0].textContent,
        "Values > 2.25",
    );
    fixture.controls.graduatedPalette.value = "viridis";
    fixture.controls.graduatedPalette.dispatchEvent(new Event("change"));
    const missing = fixture.controls.graduatedList.children[3];
    missing.children[0].checked = true;
    missing.children[0].dispatchEvent(new Event("change"));
    missing.children[1].value = "#abcdef";
    missing.children[1].dispatchEvent(new Event("input"));
    await settleStyle(fixture);

    assert.deepEqual(fixture.applied[0].graduated, {
        field: "value",
        method: "percentile-interval",
        classCount: 3,
        palette: "viridis",
        rules: [
            { minimum: null, maximum: 0.75, color: "#440154" },
            { minimum: 0.75, maximum: 2.25, color: "#21918c" },
            { minimum: 2.25, maximum: null, color: "#fde725" },
        ],
        missingColor: "#abcdef",
    });
    assert.equal(fixture.applied[0].categorical, null);
    fixture.controls.destroy();
});

test("graduated controls reject incomplete or non-increasing custom breaks", async () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("polygon", {
        geometryKind: "polygon",
        fillColor: "#a855f7",
        fillOpacity: 0.38,
        strokeColor: "#581c87",
        strokeOpacity: 1,
        strokeWidth: 2,
    }));
    fixture.controls.mode.value = "graduated";
    fixture.controls.graduatedClassCount.value = "3";
    fixture.controls.mode.dispatchEvent(new Event("change"));
    await new Promise(resolve => setTimeout(resolve, 0));

    const firstBoundary = fixture.controls.graduatedList.children[0].children[1].children[1];
    firstBoundary.value = "";
    firstBoundary.dispatchEvent(new Event("input"));
    assert.equal(fixture.clock.pendingCount(), 0);
    assert.equal(
        fixture.controls.graduatedStatus.textContent,
        "Enter a finite number for every class break.",
    );
    assert.equal(firstBoundary.getAttribute("aria-invalid"), "true");

    firstBoundary.value = "2";
    firstBoundary.dispatchEvent(new Event("input"));
    assert.equal(fixture.clock.pendingCount(), 0);
    assert.equal(
        fixture.controls.graduatedStatus.textContent,
        "Class breaks must increase from top to bottom.",
    );

    firstBoundary.value = "0.5";
    firstBoundary.dispatchEvent(new Event("input"));
    assert.equal(fixture.clock.pendingCount(), 1);
    assert.equal(firstBoundary.getAttribute("aria-invalid"), null);
    fixture.controls.destroy();
});

test("graduated controls retain exact applied breaks when reopened", async () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("polygon", {
        geometryKind: "polygon",
        fillColor: "#a855f7",
        fillOpacity: 0.38,
        strokeColor: "#581c87",
        strokeOpacity: 1,
        strokeWidth: 2,
        graduated: {
            field: "value",
            method: "percentile-interval",
            classCount: 3,
            palette: "blue-yellow-red",
            rules: [
                { minimum: null, maximum: 0.25, color: "#2b83ba" },
                { minimum: 0.25, maximum: 2.75, color: "#ffffbf" },
                { minimum: 2.75, maximum: null, color: "#d7191c" },
            ],
            missingColor: null,
        },
    }));
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(
        fixture.controls.graduatedList.children[0].children[1].children[1].value,
        "0.25",
    );
    assert.equal(
        fixture.controls.graduatedList.children[1].children[1].children[1].value,
        "2.75",
    );
    assert.match(fixture.controls.graduatedStatus.textContent, /Exact custom ranges/);
    fixture.controls.destroy();
});

test("closing during an apply cannot disable or overwrite a reopened form", async () => {
    const fixture = styleFixture();
    let finishApply;
    const style = {
        geometryKind: "line",
        strokeColor: "#f97316",
        strokeOpacity: 1,
        strokeWidth: 3,
    };
    fixture.controls.show({
        key: "line",
        style,
        fields: [{ name: "name", type: "str" }],
        apply: () => new Promise(resolve => { finishApply = resolve; }),
    });
    fixture.controls.strokeWidth.value = "4";
    fixture.controls.strokeWidth.dispatchEvent(new Event("input"));
    fixture.clock.flush();
    assert.equal(fixture.controls.strokeWidth.disabled, false);
    assert.equal(fixture.controls.status.textContent, "Updating map...");
    fixture.controls.hide();
    fixture.controls.show(fixture.target("line", style));
    assert.equal(fixture.controls.strokeWidth.disabled, false);
    fixture.controls.status.textContent = "New target";
    finishApply(style);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(fixture.controls.status.textContent, "New target");
    assert.equal(fixture.controls.strokeWidth.disabled, false);
    fixture.controls.destroy();
});

test("edits remain enabled and the newest style follows an in-flight update", async () => {
    const fixture = styleFixture();
    const requested = [];
    let finishFirst;
    const style = {
        geometryKind: "line",
        strokeColor: "#f97316",
        strokeOpacity: 1,
        strokeWidth: 2,
    };
    fixture.controls.show({
        ...fixture.target("line", style),
        async apply(nextStyle) {
            requested.push(nextStyle);
            if (requested.length === 1) {
                return new Promise(resolve => { finishFirst = resolve; });
            }
            return nextStyle;
        },
    });

    fixture.controls.strokeWidth.value = "3";
    fixture.controls.strokeWidth.dispatchEvent(new Event("input"));
    fixture.clock.flush();
    fixture.controls.strokeWidth.value = "5";
    fixture.controls.strokeWidth.dispatchEvent(new Event("input"));
    assert.equal(fixture.controls.strokeWidth.disabled, false);
    fixture.clock.flush();
    assert.equal(fixture.controls.status.textContent, "Latest changes queued...");

    finishFirst(requested[0]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(requested.map(({ strokeWidth }) => strokeWidth), [3, 5]);
    assert.equal(fixture.controls.status.textContent, "Style updated on the map.");
    fixture.controls.destroy();
});

test("a failed automatic update reports the error and permits another edit", async () => {
    const fixture = styleFixture();
    fixture.controls.show({
        ...fixture.target("line", {
            geometryKind: "line",
            strokeColor: "#f97316",
            strokeOpacity: 1,
            strokeWidth: 2,
        }),
        async apply() {
            throw new Error("Vector renderer unavailable.");
        },
    });

    fixture.controls.strokeWidth.value = "3";
    fixture.controls.strokeWidth.dispatchEvent(new Event("input"));
    await settleStyle(fixture);
    assert.equal(fixture.controls.status.textContent, "Vector renderer unavailable.");
    assert.equal(fixture.controls.root.getAttribute("aria-busy"), null);

    fixture.controls.strokeWidth.value = "4";
    fixture.controls.strokeWidth.dispatchEvent(new Event("input"));
    assert.equal(fixture.clock.pendingCount(), 1);
    fixture.controls.destroy();
});

test("closing before the quiet period cancels the pending update", () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("line", {
        geometryKind: "line",
        strokeColor: "#f97316",
        strokeOpacity: 1,
        strokeWidth: 2,
    }));
    fixture.controls.strokeWidth.value = "3";
    fixture.controls.strokeWidth.dispatchEvent(new Event("input"));

    fixture.controls.hide();
    fixture.clock.flush();
    assert.equal(fixture.applied.length, 0);
    fixture.controls.destroy();
});
