import assert from "node:assert/strict";
import test from "node:test";

import { MapLayerStack } from "../../src/map-layers/layer-stack.js";

function catalogItem(collection, id) {
  return { collection, id };
}

test("adding an existing layer is idempotent and activates it in place", () => {
  const stack = new MapLayerStack();
  const firstItem = catalogItem("collection", "first");
  const secondItem = catalogItem("collection", "second");
  const firstResult = stack.add(firstItem, "first.tif");
  stack.add(secondItem, "second.tif");

  const repeatedResult = stack.add(
    { ...firstItem, properties: { changed: true } },
    "replacement.tif",
  );

  assert.equal(firstResult.added, true);
  assert.equal(repeatedResult.added, false);
  assert.equal(repeatedResult.entry, firstResult.entry);
  assert.equal(stack.entries.length, 2);
  assert.deepEqual(
    stack.entries.map((entry) => entry.item.id),
    ["second", "first"],
  );
  assert.equal(stack.activeKey, firstResult.entry.key);
  assert.equal(repeatedResult.entry.label, "first.tif");
});

test("new layers are inserted in top-first drawing order", () => {
  const stack = new MapLayerStack();

  stack.add(catalogItem("collection", "bottom"), "bottom.tif");
  stack.add(catalogItem("collection", "middle"), "middle.tif");
  stack.add(catalogItem("collection", "top"), "top.tif");

  assert.deepEqual(
    stack.entries.map((entry) => entry.item.id),
    ["top", "middle", "bottom"],
  );
});

test("retained map layers may all be visible", () => {
  const stack = new MapLayerStack();
  const first = stack.add(catalogItem("collection", "first"), "first.tif").entry;
  const second = stack.add(
    catalogItem("collection", "second"),
    "second.tif",
  ).entry;
  const third = stack.add(catalogItem("collection", "third"), "third.tif").entry;

  assert.equal(first.visible, true);
  assert.equal(second.visible, true);
  assert.equal(third.visible, true);
  assert.equal(stack.visibleCount, 3);

  stack.setVisible(first.key, false);

  assert.equal(stack.visibleCount, 2);
  assert.equal(first.visible, false);
  assert.equal(third.visible, true);
  stack.setVisible(first.key, true);
  assert.equal(stack.visibleCount, 3);
  assert.throws(() => stack.setVisible(second.key, "yes"), TypeError);
});

test("active selection is independent of layer visibility", () => {
  const stack = new MapLayerStack();
  const first = stack.add(catalogItem("collection", "first"), "first.tif").entry;
  stack.add(catalogItem("collection", "second"), "second.tif");
  const hidden = stack.add(catalogItem("collection", "hidden"), "hidden.tif").entry;
  stack.setVisible(hidden.key, false);

  assert.equal(hidden.visible, false);
  assert.equal(stack.activeKey, hidden.key);

  stack.activate(first.key);
  stack.setVisible(first.key, false);

  assert.equal(stack.activeKey, first.key);
  assert.equal(first.visible, false);

  stack.activate(hidden.key);
  assert.equal(stack.activeKey, hidden.key);
  assert.equal(hidden.visible, false);
  assert.throws(() => stack.activate("missing"), RangeError);
});

test("opacity accepts only finite values in the closed unit interval", () => {
  const stack = new MapLayerStack();
  const entry = stack.add(catalogItem("collection", "item"), "item.tif").entry;

  for (const opacity of [0, 0.375, 1]) {
    assert.equal(stack.setOpacity(entry.key, opacity), entry);
    assert.equal(entry.opacity, opacity);
  }

  for (const opacity of [-0.001, 1.001, NaN, Infinity, -Infinity, "0.5"]) {
    assert.throws(() => stack.setOpacity(entry.key, opacity), RangeError);
  }
  assert.equal(entry.opacity, 1);
});

test("moving directly to an index is atomic and validates its contract", () => {
  const stack = new MapLayerStack();
  const bottom = stack.add(
    catalogItem("collection", "bottom"),
    "bottom.tif",
  ).entry;
  stack.add(catalogItem("collection", "middle"), "middle.tif");
  stack.add(catalogItem("collection", "upper"), "upper.tif");
  stack.add(catalogItem("collection", "top"), "top.tif");

  assert.equal(stack.moveTo(bottom.key, 0), true);
  assert.deepEqual(
    stack.entries.map((entry) => entry.item.id),
    ["bottom", "top", "upper", "middle"],
  );
  assert.equal(stack.moveTo(bottom.key, 0), false);
  assert.equal(stack.moveTo(bottom.key, -1), false);
  assert.equal(stack.moveTo(bottom.key, 4), false);
  assert.throws(() => stack.moveTo(bottom.key, 1.5), TypeError);
  assert.throws(() => stack.moveTo("missing", 0), RangeError);
});

test("removing the active layer chooses a deterministic adjacent fallback", () => {
  const stack = new MapLayerStack();
  const bottom = stack.add(catalogItem("collection", "bottom"), "bottom.tif").entry;
  const middle = stack.add(catalogItem("collection", "middle"), "middle.tif").entry;
  const top = stack.add(catalogItem("collection", "top"), "top.tif").entry;

  stack.activate(middle.key);
  const middleRemoval = stack.remove(middle.key);

  assert.equal(middleRemoval.removed, middle);
  assert.equal(middleRemoval.activeKey, bottom.key);
  assert.equal(stack.activeKey, bottom.key);

  stack.activate(top.key);
  const inactiveRemoval = stack.remove(bottom.key);
  assert.equal(inactiveRemoval.activeKey, top.key);

  const finalRemoval = stack.remove(top.key);
  assert.equal(finalRemoval.activeKey, null);
  assert.equal(stack.activeKey, null);
  assert.throws(() => stack.remove("missing"), RangeError);
});

test("clear removes all entries, visibility, and active selection", () => {
  const stack = new MapLayerStack();
  stack.add(catalogItem("collection", "first"), "first.tif");
  stack.add(catalogItem("collection", "second"), "second.tif");

  stack.clear();

  assert.deepEqual(stack.entries, []);
  assert.equal(stack.visibleCount, 0);
  assert.equal(stack.activeKey, null);
});


test("restoring complete order preserves retained entries and rejects partial or duplicated keys", () => {
  const stack = new MapLayerStack();
  const raster = stack.add(catalogItem("catalog", "raster"), "Raster").entry;
  const local = stack.addLocal("local:annotation:one", "Annotations").entry;
  const vector = stack.add(catalogItem("catalog", "vector"), "Vector").entry;
  stack.setVisible(local.key, false);
  const active = stack.activeKey;
  assert.equal(stack.restoreOrder([local.key, vector.key, raster.key]), true);
  assert.deepEqual(stack.entries, [local, vector, raster]);
  assert.equal(stack.entries[0], local);
  assert.equal(local.visible, false);
  assert.equal(stack.activeKey, active);
  assert.equal(stack.restoreOrder([local.key, vector.key, raster.key]), false);
  for (const invalid of [null, [local.key], [local.key, local.key, raster.key], [local.key, vector.key, "missing"]]) {
    assert.throws(() => stack.restoreOrder(invalid), TypeError);
    assert.deepEqual(stack.entries, [local, vector, raster]);
  }
});
