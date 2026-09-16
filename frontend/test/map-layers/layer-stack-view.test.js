import assert from "node:assert/strict";
import test from "node:test";

import { MapLayerStackView } from "../../src/map-layers/layer-stack-view.js";

/** Minimal DOM element used by the raster layer-stack view tests. */
class FakeLayerStackElement extends EventTarget {
  /**
   * Create one mutable DOM-like element.
   *
   * @param {string} tagName HTML tag name.
   * @param {FakeLayerStackDocument} documentContext Owning fake document.
   */
  constructor(tagName, documentContext) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = documentContext;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.textContent = "";
    this.title = "";
    this.type = "";
    this.name = "";
    this.scrollTop = 0;
    this.capturedPointerId = null;
    this._classNames = new Set();
    this.classList = {
      add: (...classNames) => {
        for (const className of classNames) this._classNames.add(className);
      },
      contains: (className) => this._classNames.has(className),
      remove: (...classNames) => {
        for (const className of classNames) this._classNames.delete(className);
      },
      toggle: (className, force) => {
        const shouldAdd = force ?? !this._classNames.has(className);
        if (shouldAdd) {
          this._classNames.add(className);
        } else {
          this._classNames.delete(className);
        }
        return shouldAdd;
      },
    };
  }

  /** Space-separated CSS classes, kept in sync with classList. */
  get className() {
    return [...this._classNames].join(" ");
  }

  set className(value) {
    this._classNames = new Set(value.split(/\s+/).filter(Boolean));
  }

  /**
   * Append child nodes.
   *
   * @param {...FakeLayerStackElement} children Child nodes.
   * @return {void}
   */
  append(...children) {
    this.children.push(...children);
  }

  /**
   * Replace all child nodes.
   *
   * @param {...FakeLayerStackElement} children Replacement nodes.
   * @return {void}
   */
  replaceChildren(...children) {
    this.children = children;
  }

  /**
   * Store one element attribute.
   *
   * @param {string} name Attribute name.
   * @param {string} value Attribute value.
   * @return {void}
   */
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  /**
   * Return one element attribute.
   *
   * @param {string} name Attribute name.
   * @return {string|null} Attribute value or null.
   */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  /** Give this control fake document focus. */
  focus() {
    this.ownerDocument.activeElement = this;
  }

  /** Capture subsequent synthetic pointer events. */
  setPointerCapture(pointerId) {
    this.capturedPointerId = pointerId;
  }

  /** Release one synthetic pointer capture. */
  releasePointerCapture(pointerId) {
    if (this.capturedPointerId === pointerId) this.capturedPointerId = null;
  }

  /** Return deterministic vertical geometry for pointer sorting tests. */
  getBoundingClientRect() {
    const isRow = this.tagName === "LI";
    const top = isRow ? Number(this.dataset.layerIndex) * 52 : 0;
    const height = isRow ? 48 : 156;
    return { top, bottom: top + height, height };
  }
}

/** Minimal text node used for visible label suffixes. */
class FakeTextNode {
  /** @param {string} text Text node content. */
  constructor(text) {
    this.textContent = text;
  }
}

/** Fixed layer-stack markup plus an element factory. */
class FakeLayerStackDocument {
  /** Create the required semantic layer-stack markup. */
  constructor() {
    this.activeElement = null;
    this.layerScrollContainer = new FakeLayerStackElement("div", this);
    this.elements = new Map([
      ["#raster-layer-stack", new FakeLayerStackElement("div", this)],
      ["#raster-layer-list", new FakeLayerStackElement("ol", this)],
      ["#raster-layer-stack-status", new FakeLayerStackElement("p", this)],
      ["#map-layer-counts", new FakeLayerStackElement("span", this)],
      ["#map-layers-show-all", new FakeLayerStackElement("button", this)],
      ["#map-layers-hide-all", new FakeLayerStackElement("button", this)],
      ["#map-filter-indicators", new FakeLayerStackElement("div", this)],
      ["#map-inspection-filter-indicators", new FakeLayerStackElement("div", this)],
    ]);
    this.elements.get("#raster-layer-stack").parentElement =
      this.layerScrollContainer;
    this.elements.get("#raster-layer-stack").hidden = true;
  }

  /**
   * Resolve one required fixed element.
   *
   * @param {string} selector Element ID selector.
   * @return {FakeLayerStackElement|null} Registered element or null.
   */
  querySelector(selector) {
    return this.elements.get(selector) ?? null;
  }

  /**
   * Create one fake HTML element.
   *
   * @param {string} tagName HTML tag name.
   * @return {FakeLayerStackElement} New fake element.
   */
  createElement(tagName) {
    return new FakeLayerStackElement(tagName, this);
  }

  /**
   * Create one fake text node.
   *
   * @param {string} text Node content.
   * @return {FakeTextNode} New fake text node.
   */
  createTextNode(text) {
    return new FakeTextNode(text);
  }
}

/**
 * Return every descendant with one CSS class.
 *
 * @param {FakeLayerStackElement} element Search root.
 * @param {string} className CSS class.
 * @return {FakeLayerStackElement[]} Matching descendants.
 */
function elementsByClass(element, className) {
  const matches = [];
  for (const child of element.children) {
    if (child instanceof FakeLayerStackElement) {
      if (child.classList.contains(className)) {
        matches.push(child);
      }
      matches.push(...elementsByClass(child, className));
    }
  }
  return matches;
}

/**
 * Find one row control by its stable action identity.
 *
 * @param {FakeLayerStackElement} row Rendered layer row.
 * @param {string} action Layer action.
 * @return {FakeLayerStackElement} Matching control.
 */
function actionControl(row, action) {
  const controls = [];
  const visit = (element) => {
    for (const child of element.children) {
      if (child instanceof FakeLayerStackElement) {
        if (child.dataset.layerAction === action) {
          controls.push(child);
        }
        visit(child);
      }
    }
  };
  visit(row);
  assert.equal(controls.length, 1, `expected one ${action} control`);
  return controls[0];
}

/**
 * Create a cancelable synthetic event with read-only interaction fields.
 *
 * @param {string} type Event type.
 * @param {Object} fields Pointer or keyboard fields.
 * @return {Event} Synthetic interaction event.
 */
function interactionEvent(type, fields) {
  const event = new Event(type, { cancelable: true });
  for (const [name, value] of Object.entries(fields)) {
    Object.defineProperty(event, name, { value });
  }
  return event;
}

/**
 * Build the neutral gradient-legend contract emitted by a layer owner.
 *
 * @param {Object} style Test ramp with numeric stops and CSS colors.
 * @return {{kind:"gradient",gradient:string,description:string,labels:number[]}}
 * Presentation-only legend consumed by the map-layer view.
 */
function gradientLegend(style) {
  const midpointPosition =
    ((style.midpoint - style.minimum) /
      (style.maximum - style.minimum)) * 100;
  return {
    kind: "gradient",
    gradient: `linear-gradient(90deg, ${style.minimumColor} 0%, ` +
      `${style.midpointColor} ${midpointPosition}%, ` +
      `${style.maximumColor} 100%)`,
    description:
      `Color ramp: ${style.minimum} at ${style.minimumColor}, ` +
      `${style.midpoint} at ${style.midpointColor}, and ` +
      `${style.maximum} at ${style.maximumColor}.`,
    labels: [style.minimum, style.midpoint, style.maximum],
  };
}

test("active filter summaries remain actionable in map and dock slots", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  const opened = [];
  view.bind({ onFilter: (key) => opened.push(key) });
  const layer = { ...LAYERS[0], canFilter: true, filterActive: true,
    filterStatus: "5 of 100 features match" };
  view.render([layer], layer.key);
  for (const selector of ["#map-filter-indicators", "#map-inspection-filter-indicators"]) {
    const slot = documentContext.querySelector(selector);
    assert.equal(slot.hidden, false);
    assert.equal(slot.children.length, 1);
    assert.match(slot.children[0].textContent, /5 of 100 features match/);
    slot.children[0].dispatchEvent(new Event("click"));
  }
  assert.deepEqual(opened, [layer.key, layer.key]);
  view.render([{ ...layer, visible: false }], layer.key);
  for (const selector of ["#map-filter-indicators", "#map-inspection-filter-indicators"]) {
    assert.equal(documentContext.querySelector(selector).hidden, true);
    assert.equal(documentContext.querySelector(selector).children.length, 0);
  }
});

const LAYERS = [
  {
    key: "temperature",
    datasetKind: "raster",
    item: { collection: "climate", id: "temperature-annual" },
    label: "Global surface temperature anomaly (1981–2010 baseline)",
    visible: true,
    opacity: 0.42,
    styleClipboard: {
      canCopy: true,
      canPaste: false,
      sourceLabel: null,
      pasteReason: "Copy a layer style before pasting.",
    },
    error: null,
    legend: gradientLegend({
      minimum: -10,
      midpoint: 0,
      maximum: 15,
      minimumColor: "#0000ff",
      midpointColor: "#ffffff",
      maximumColor: "#ff0000",
    }),
  },
  {
    key: "vegetation",
    datasetKind: "raster",
    item: { collection: "vegetation", id: "health-index" },
    label: "Vegetation health index",
    visible: true,
    opacity: 1,
    styleClipboard: {
      canCopy: true,
      canPaste: false,
      sourceLabel: null,
      pasteReason: "Copy a layer style before pasting.",
    },
    error: null,
    legend: gradientLegend({
      minimum: 0,
      midpoint: 50,
      maximum: 100,
      minimumColor: "#30123b",
      midpointColor: "#a4fc3c",
      maximumColor: "#7a0403",
    }),
  },
  {
    key: "moisture",
    datasetKind: "raster",
    item: { collection: "soil", id: "moisture-anomaly" },
    label: "Soil moisture anomaly",
    visible: false,
    opacity: 0.75,
    styleClipboard: {
      canCopy: true,
      canPaste: false,
      sourceLabel: null,
      pasteReason: "Copy a layer style before pasting.",
    },
    error: "Statistics unavailable.",
    legend: gradientLegend({
      minimum: -5,
      midpoint: 1,
      maximum: 9,
      minimumColor: "#5e4fa2",
      midpointColor: "#ffffbf",
      maximumColor: "#9e0142",
    }),
  },
];

test("heading counts retained types through mixed, hidden, single-type, and empty maps", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  const counts = doc.querySelector("#map-layer-counts");
  const vector = { ...LAYERS[0], datasetKind: "vector", key: "boundaries" };
  const otherVector = { ...vector, key: "points", visible: false };

  view.render([], null);
  assert.equal(counts.textContent, "· Empty");
  view.render([...LAYERS, vector, otherVector], null);
  assert.equal(counts.textContent, "· 3 rasters · 2 vectors");
  view.render([otherVector, vector, ...LAYERS].map(layer => ({ ...layer, visible: false })), null);
  assert.equal(counts.textContent, "· 3 rasters · 2 vectors");
  view.render([LAYERS[0], vector], null);
  assert.equal(counts.textContent, "· 1 raster · 1 vector");
  view.render([vector, otherVector], null);
  assert.equal(counts.textContent, "· 2 vectors");
  view.render([LAYERS[0]], null);
  assert.equal(counts.textContent, "· 1 raster");
  view.render([], null);
  assert.equal(counts.textContent, "· Empty");
});

test("rows expose two-row identity, map, style, clipboard, and removal actions", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  view.render(LAYERS, "vegetation");
  const rows = doc.querySelector("#raster-layer-list").children;
  assert.equal(rows.length, 3);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.tagName, "LI");
    assert.equal(row.classList.contains("is-active"), false);
    assert.equal(elementsByClass(row, "raster-layer-name")[0].textContent, LAYERS[index].label);
    assert.equal(elementsByClass(row, "raster-layer-legend").length, 0);
    assert.equal(elementsByClass(row, "raster-layer-opacity").length, 0);
    assert.equal(actionControl(row, "style").getAttribute("aria-haspopup"), "dialog");
    assert.equal(actionControl(row, "style").textContent, "Style");
    assert.equal(actionControl(row, "zoom").textContent, "Zoom to");
    assert.equal(actionControl(row, "info").textContent, "Info");
    assert.equal(actionControl(row, "copy-style").disabled, false);
    assert.match(actionControl(row, "copy-style").title, /Copy style and opacity/);
    assert.equal(
      elementsByClass(actionControl(row, "copy-style"), "map-layer-style-copy-icon").length,
      1,
    );
    assert.equal(actionControl(row, "paste-style").disabled, true);
    assert.equal(
      actionControl(row, "paste-style").title,
      "Copy a layer style before pasting.",
    );
    assert.equal(
      elementsByClass(actionControl(row, "paste-style"), "map-layer-style-paste-icon").length,
      1,
    );
    assert.match(actionControl(row, "reorder").getAttribute("aria-label"), /position \d of 3/);
    assert.equal(actionControl(row, "reorder").getAttribute("aria-pressed"), "false");
    assert.equal(actionControl(row, "visibility").type, "checkbox");
    assert.equal(actionControl(row, "visibility").checked, LAYERS[index].visible);
  }
  assert.equal(actionControl(rows[2], "visibility").disabled, false);
  assert.throws(() => actionControl(rows[0], "move-up"));
  assert.throws(() => actionControl(rows[2], "move-down"));
  assert.equal(actionControl(rows[0], "remove").textContent, "×");
  assert.match(actionControl(rows[0], "remove").title, /Remove from map/);
  assert.equal(elementsByClass(rows[0], "map-layer-primary-row").length, 1);
  assert.equal(elementsByClass(rows[0], "map-layer-row-actions").length, 1);
  assert.equal(elementsByClass(rows[0], "raster-layer-actions").length, 0);
  assert.equal(elementsByClass(rows[2], "raster-layer-error")[0].textContent, "Statistics unavailable.");
  assert.equal(doc.querySelector("#raster-layer-stack").hidden, false);
});

test("raster and vector rows use the same compact action layout", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  const vector = { ...LAYERS[0], legend: { kind: "fixed", label: "Polygon" } };
  view.render([vector, { ...LAYERS[1], opacityLocked: true, effectiveOpacity: 1 }], null);
  for (const row of doc.querySelector("#raster-layer-list").children) {
    assert.equal(actionControl(row, "style").textContent, "Style");
    assert.equal(elementsByClass(row, "map-layer-row-actions").length, 1);
    assert.equal(elementsByClass(row, "raster-layer-legend").length, 0);
  }
});

test("optional analysis role badges are visible and accessible", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  view.render([
    {
      ...LAYERS[0],
      roleBadge: { label: "X", description: "X axis raster" },
    },
    {
      ...LAYERS[1],
      roleBadge: { label: "Y", description: "Y axis raster" },
    },
  ], null);

  const rows = doc.querySelector("#raster-layer-list").children;
  const badges = rows.map((row) => elementsByClass(row, "map-layer-role-badge")[0]);
  assert.deepEqual(badges.map((badge) => badge.textContent), ["X", "Y"]);
  assert.deepEqual(
    badges.map((badge) => badge.getAttribute("aria-label")),
    ["X axis raster", "Y axis raster"],
  );
});

test("neutral classified legends render as compact layer disclosures", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  const vector = {
    ...LAYERS[0],
    legend: {
      kind: "graduated",
      label: "risk score",
      entries: [
        { label: "≤ 1", color: "#f7fbff" },
        { label: "> 1", color: "#08306b" },
      ],
    },
  };

  view.render([vector], null);
  const row = doc.querySelector("#raster-layer-list").children[0];
  const legend = elementsByClass(row, "map-layer-legend")[0];
  const swatches = elementsByClass(legend, "map-layer-legend-swatch");

  assert.equal(legend.tagName, "DETAILS");
  assert.equal(elementsByClass(legend, "map-layer-legend-field")[0].textContent, "risk score");
  assert.equal(swatches.length, 2);
  assert.equal(swatches[0].style.backgroundColor, "#f7fbff");
});

test("direct row actions forward stable identity", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  const received = [];
  view.bind({
    onStyle: key => received.push(["style", key]),
    onZoom: key => received.push(["zoom", key]),
    onInfo: key => received.push(["info", key]),
    onCopyStyle: key => received.push(["copy-style", key]),
    onPasteStyle: key => received.push(["paste-style", key]),
    onVisibility: (key, visible) => received.push(["visibility", key, visible]),
    onReorder: (key, targetIndex) => received.push(["reorder", key, targetIndex]),
    onRemove: key => received.push(["remove", key]),
  });
  view.render([
    {
      ...LAYERS[0],
      styleClipboard: {
        canCopy: true,
        canPaste: true,
        sourceLabel: "Vegetation health index",
        pasteReason: "Paste the copied style.",
      },
    },
    ...LAYERS.slice(1),
  ], null);
  const [first, second, third] = doc.querySelector("#raster-layer-list").children;
  actionControl(first, "style").dispatchEvent(new Event("click"));
  actionControl(first, "zoom").dispatchEvent(new Event("click"));
  actionControl(first, "info").dispatchEvent(new Event("click"));
  actionControl(first, "copy-style").dispatchEvent(new Event("click"));
  actionControl(first, "paste-style").dispatchEvent(new Event("click"));
  const visibility = actionControl(first, "visibility");
  visibility.checked = false;
  visibility.dispatchEvent(new Event("change"));
  actionControl(third, "remove").dispatchEvent(new Event("click"));
  assert.deepEqual(received, [
    ["style", "temperature"],
    ["zoom", "temperature"],
    ["info", "temperature"],
    ["copy-style", "temperature"],
    ["paste-style", "temperature"],
    ["visibility", "temperature", false],
    ["remove", "moisture"],
  ]);
  assert.equal(doc.querySelector("#raster-layer-stack").hidden, false);
  view.unbind();
  actionControl(third, "remove").dispatchEvent(new Event("click"));
  assert.equal(received.length, 7);
});

test("pointer dragging emits one atomic reorder with insertion feedback", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  const received = [];
  view.bind({
    onStyle() {},
    onVisibility() {},
    onReorder: (key, targetIndex) => received.push([key, targetIndex]),
    onRemove() {},
  });
  view.render(LAYERS, null);
  const list = documentContext.querySelector("#raster-layer-list");
  const handle = actionControl(list.children[0], "reorder");
  const down = interactionEvent("pointerdown", {
    button: 0,
    isPrimary: true,
    pointerId: 7,
  });
  handle.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  assert.equal(handle.capturedPointerId, 7);
  assert.equal(list.children[0].classList.contains("is-dragging"), true);

  handle.dispatchEvent(interactionEvent("pointermove", {
    pointerId: 7,
    clientY: 150,
  }));
  assert.equal(list.children[2].classList.contains("is-drop-after"), true);
  assert.ok(documentContext.layerScrollContainer.scrollTop > 0);
  assert.equal(list.scrollTop, 0);
  assert.deepEqual(received, []);

  handle.dispatchEvent(interactionEvent("pointerup", { pointerId: 7 }));
  assert.deepEqual(received, [["temperature", 2]]);
  assert.equal(list.classList.contains("is-reordering"), false);
  assert.equal(list.children[2].classList.contains("is-drop-after"), false);
});

test("pointer dragging onto the top row moves a lower layer to the top", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  const received = [];
  view.bind({
    onStyle() {},
    onVisibility() {},
    onReorder: (key, targetIndex) => received.push([key, targetIndex]),
    onRemove() {},
  });
  view.render(LAYERS, null);
  const list = documentContext.querySelector("#raster-layer-list");
  const handle = actionControl(list.children[2], "reorder");
  handle.dispatchEvent(interactionEvent("pointerdown", {
    button: 0,
    isPrimary: true,
    pointerId: 8,
  }));

  // The lower half of the first row is still an unambiguous top-row drop.
  handle.dispatchEvent(interactionEvent("pointermove", {
    pointerId: 8,
    clientY: 40,
  }));
  assert.equal(list.children[0].classList.contains("is-drop-before"), true);

  handle.dispatchEvent(interactionEvent("pointerup", { pointerId: 8 }));
  assert.deepEqual(received, [["moisture", 0]]);
});

test("keyboard reorder moves through the owner and Escape restores the origin", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  let layers = [...LAYERS];
  const received = [];
  view.bind({
    onStyle() {},
    onVisibility() {},
    onReorder: (key, targetIndex) => {
      received.push([key, targetIndex]);
      const sourceIndex = layers.findIndex((layer) => layer.key === key);
      const [layer] = layers.splice(sourceIndex, 1);
      layers.splice(targetIndex, 0, layer);
      view.render(layers, null, { key, action: "reorder" });
    },
    onRemove() {},
  });
  view.render(layers, null);
  let handle = actionControl(
    documentContext.querySelector("#raster-layer-list").children[1],
    "reorder",
  );
  handle.focus();
  handle.dispatchEvent(interactionEvent("keydown", { key: " " }));
  assert.equal(handle.getAttribute("aria-pressed"), "true");
  handle.dispatchEvent(interactionEvent("keydown", { key: "ArrowUp" }));
  assert.deepEqual(layers.map((layer) => layer.key), [
    "vegetation", "temperature", "moisture",
  ]);
  handle = documentContext.activeElement;
  assert.equal(handle.dataset.layerAction, "reorder");
  assert.equal(handle.getAttribute("aria-pressed"), "true");

  handle.dispatchEvent(interactionEvent("keydown", { key: "Escape" }));
  assert.deepEqual(layers.map((layer) => layer.key), [
    "temperature", "vegetation", "moisture",
  ]);
  assert.deepEqual(received, [["vegetation", 0], ["vegetation", 1]]);
  assert.equal(handle.getAttribute("aria-pressed"), "false");
  assert.equal(
    documentContext.querySelector("#raster-layer-stack-status").textContent,
    "Vegetation health index reordering cancelled.",
  );
});

test("the layer list leaves Escape to its owning workspace", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  view.bind({
    onStyle() {},
    onVisibility() {},
    onReorder() {},
    onRemove() {},
  });
  view.render([LAYERS[0]], LAYERS[0].key);
  const root = documentContext.querySelector("#raster-layer-stack");
  const list = documentContext.querySelector("#raster-layer-list");
  const rows = [...list.children];
  const escapeEvent = new Event("keydown", { cancelable: true });
  Object.defineProperty(escapeEvent, "key", { value: "Escape" });

  root.dispatchEvent(escapeEvent);

  assert.equal(escapeEvent.defaultPrevented, false);
  assert.equal(escapeEvent.cancelBubble, false);
  assert.equal(root.hidden, false);
  assert.equal(root.classList.contains("is-collapsed"), false);
  assert.deepEqual(list.children, rows);
  view.unbind();
});

test("MapLayerStackView announces status and retains stable action focus", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  view.render(LAYERS, "temperature");
  const list = documentContext.querySelector("#raster-layer-list");
  const focusedBeforeRender = actionControl(list.children[2], "remove");
  focusedBeforeRender.focus();

  view.render([LAYERS[2], LAYERS[0], LAYERS[1]], "temperature");

  assert.notEqual(documentContext.activeElement, focusedBeforeRender);
  assert.equal(documentContext.activeElement.dataset.layerKey, "moisture");
  assert.equal(documentContext.activeElement.dataset.layerAction, "remove");

  view.render(
    [LAYERS[0], LAYERS[1]],
    "vegetation",
    { key: "vegetation", action: "reorder" },
  );
  assert.equal(documentContext.activeElement.dataset.layerKey, "vegetation");
  assert.equal(documentContext.activeElement.dataset.layerAction, "reorder");

  view.render(
    [LAYERS[1], LAYERS[0]],
    "vegetation",
    { key: "vegetation", action: "reorder" },
  );
  assert.equal(documentContext.activeElement.dataset.layerKey, "vegetation");
  assert.equal(documentContext.activeElement.dataset.layerAction, "reorder");

  view.setStatus("Soil moisture anomaly removed.");
  assert.equal(
    documentContext.querySelector("#raster-layer-stack-status").textContent,
    "Soil moisture anomaly removed.",
  );
  assert.equal(
    documentContext.querySelector("#raster-layer-stack-status")
      .classList.contains("visually-hidden"),
    false,
  );

  view.announceStatus("Vegetation index was added and is visible.");
  assert.equal(
    documentContext.querySelector("#raster-layer-stack-status").textContent,
    "Vegetation index was added and is visible.",
  );
  assert.equal(
    documentContext.querySelector("#raster-layer-stack-status")
      .classList.contains("visually-hidden"),
    true,
  );

  view.render([], null);
  assert.equal(documentContext.querySelector("#raster-layer-stack").hidden, true);
  assert.equal(list.children.length, 0);
  assert.equal(
    documentContext.activeElement,
    documentContext.querySelector("#raster-layer-stack-status"),
  );
});

test("bulk visibility actions track empty, mixed, all shown and all hidden states", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  const show = doc.querySelector("#map-layers-show-all");
  const hide = doc.querySelector("#map-layers-hide-all");
  const intents = [];
  const shown = LAYERS.map(layer => ({ ...layer, visible: true }));
  view.bind({ onAllVisibility: visible => intents.push(visible) });
  view.render([], null);
  assert.equal(show.disabled, true);
  assert.equal(hide.disabled, true);

  view.render(shown, null);
  assert.equal(show.disabled, true);
  assert.equal(hide.disabled, false);
  hide.focus();
  hide.dispatchEvent(new Event("click"));
  const hidden = LAYERS.map(layer => ({ ...layer, visible: false }));
  view.render(hidden, null);
  assert.equal(show.disabled, false);
  assert.equal(hide.disabled, true);
  assert.equal(doc.activeElement, show);
  assert.ok(doc.querySelector("#raster-layer-list").children.every(
    row => !actionControl(row, "visibility").checked,
  ));

  show.dispatchEvent(new Event("click"));
  view.render(shown, null);
  assert.equal(doc.activeElement, hide);
  assert.ok(doc.querySelector("#raster-layer-list").children.every(
    row => actionControl(row, "visibility").checked,
  ));
  view.render([LAYERS[0], hidden[1]], null);
  assert.equal(show.disabled, false);
  assert.equal(hide.disabled, false);
  assert.deepEqual(intents, [false, true]);
  view.unbind();
  show.dispatchEvent(new Event("click"));
  assert.deepEqual(intents, [false, true], "Destroyed views stop forwarding intent");
});
