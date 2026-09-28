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

  /** @param {FakeLayerStackElement|null} node Possible descendant. @return {boolean} Whether this subtree contains it. */
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }

  /** Number of child elements, as exposed by the browser DOM. @return {number} Child count. */
  get childElementCount() { return this.children.length; }

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
    for (const child of this.children) child.parentElement = null;
    this.children = children;
    for (const child of children) child.parentElement = this;
  }

  /** Detach this element from its parent. @return {void} */
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }

  /**
   * Move or append a child as the browser does, without cloning its controls.
   * @param {FakeLayerStackElement} child Element to insert.
   * @param {FakeLayerStackElement|null} reference Following sibling, or null to append.
   * @return {void}
   */
  insertBefore(child, reference) {
    child.remove();
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    this.children.splice(index, 0, child);
    child.parentElement = this;
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

  /**
   * Give this control fake document focus and record its scrolling policy.
   * @param {{preventScroll?:boolean}} [options] Browser focus options.
   * @return {void}
   */
  focus(options = {}) {
    this.ownerDocument.activeElement = this;
    this.lastFocusOptions = options;
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
      ["#map-layers-sort", new FakeLayerStackElement("select", this)],
      ["#map-layer-removal", new FakeLayerStackElement("li", this)],
      ["#map-layer-removal-message", new FakeLayerStackElement("p", this)],
      ["#undo-layer-removal", new FakeLayerStackElement("button", this)],
      ["#dismiss-layer-removal", new FakeLayerStackElement("button", this)],
      ["#map-layer-removal-error", new FakeLayerStackElement("p", this)],
      ["#map-filter-indicators", new FakeLayerStackElement("div", this)],
      ["#map-inspection-filter-indicators", new FakeLayerStackElement("div", this)],
    ]);
    this.elements.get("#raster-layer-stack").parentElement =
      this.layerScrollContainer;
    this.elements.get("#raster-layer-stack").hidden = true;
    this.elements.get("#map-layer-removal").hidden = true;
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

  /** @param {string} _namespace SVG namespace. @param {string} tagName Element tag. @return {FakeLayerStackElement} Test SVG element. */
  createElementNS(_namespace, tagName) { return this.createElement(tagName); }

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

test("shared viewer omits removal but retains included-layer interaction tools", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext, { allowRemoval: false });
  const calls = [];
  view.bind({ onStyle: key => calls.push(key), onAllVisibility: visible => calls.push(visible) });
  view.render(LAYERS, LAYERS[0].key);
  const list = documentContext.querySelector("#raster-layer-list");
  assert.equal(elementsByClass(list, "map-layer-remove-button").length, 0);
  actionControl(list.children[0], "style").dispatchEvent(new Event("click"));
  for (const action of ["info", "zoom", "visibility", "copy-style", "paste-style"]) {
    actionControl(list.children[0], action);
  }
  documentContext.querySelector("#map-layers-hide-all").dispatchEvent(new Event("click"));
  assert.deepEqual(calls, [LAYERS[0].key, false]);
  view.showRemoval({ label: "Old removal", index: 0 }, false, null);
  assert.equal(documentContext.querySelector("#map-layer-removal").hidden, true);
});

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

test("inline Rename preserves draft text across refreshes, validates, saves and resets", () => {
  const documentContext = new FakeLayerStackDocument(), view = new MapLayerStackView(documentContext);
  const layer = { ...LAYERS[0], sourceName: "source.tif" }, renamed = [];
  view.bind({ onRename(key, name) {
    if (name === " ") throw new Error("Layer name must contain 1 to 160 characters.");
    renamed.push([key, name]);
    layer.label = name ?? layer.sourceName;
    view.render([layer], layer.key);
  } });
  view.render([layer], layer.key);
  const list = documentContext.querySelector("#raster-layer-list");
  actionControl(list.children[0], "rename").dispatchEvent(new Event("click"));
  let form = elementsByClass(list, "map-layer-name-editor")[0];
  const input = form.children[0].children[0];
  assert.equal(documentContext.activeElement, input);
  input.value = "Draft title";
  view.render([layer], layer.key);
  assert.equal(elementsByClass(list, "map-layer-name-editor")[0], form);
  assert.equal(input.value, "Draft title");
  assert.equal(documentContext.activeElement, input);
  input.value = " ";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  assert.equal(form.children[2].hidden, false);
  input.value = "<b>Forests</b>";
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  assert.deepEqual(renamed, [[layer.key, "<b>Forests</b>"]]);
  assert.equal(elementsByClass(list, "map-layer-name-editor").length, 0);
  assert.equal(elementsByClass(list, "raster-layer-name")[0].textContent, "<b>Forests</b>");
  actionControl(list.children[0], "rename").dispatchEvent(new Event("click"));
  form = elementsByClass(list, "map-layer-name-editor")[0];
  form.children[3].children[1].dispatchEvent(new Event("click"));
  assert.deepEqual(renamed.at(-1), [layer.key, null]);
  actionControl(list.children[0], "rename").dispatchEvent(new Event("click"));
  form = elementsByClass(list, "map-layer-name-editor")[0];
  form.dispatchEvent(interactionEvent("keydown", { key: "Escape" }));
  assert.equal(elementsByClass(list, "map-layer-name-editor").length, 0);
  assert.equal(renamed.length, 2);
  view.render([{ ...layer, item: null, datasetKind: "annotation" }], layer.key);
  assert.equal(elementsByClass(list, "map-layer-name-editor").length, 0);
  assert.equal(elementsByClass(list, "secondary-button").some(button => button.dataset.layerAction === "rename"), false);
});

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
        { label: "≤ 1", symbol: { shape: "polygon", fill: "#f7fbff", fillOpacity: 0.4, stroke: "#222222", strokeOpacity: 0.8, strokeWidth: 2 } },
        { label: "> 1", symbol: { shape: "polygon", fill: "#08306b", fillOpacity: 0.4, stroke: "#222222", strokeOpacity: 0.8, strokeWidth: 2 } },
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
  const polygon = swatches[0].children[0].children[0];
  assert.equal(polygon.getAttribute("fill"), "#f7fbff");
  assert.equal(polygon.getAttribute("stroke"), "#222222");
  assert.equal(polygon.getAttribute("fill-opacity"), String(0.4 * vector.opacity));
  assert.equal(polygon.getAttribute("stroke-opacity"), String(0.8 * vector.opacity));
  legend.open = true;
  actionControl(row, "legend").focus();
  const updated = { ...vector, opacity: 0.2 };
  view.render([updated], null);
  const nextRow = doc.querySelector("#raster-layer-list").children[0];
  assert.equal(elementsByClass(nextRow, "map-layer-legend")[0].open, true);
  assert.equal(doc.activeElement, actionControl(nextRow, "legend"));
  const nextSymbol = elementsByClass(nextRow, "map-layer-legend-swatch")[0].children[0].children[0];
  assert.equal(nextSymbol.getAttribute("fill-opacity"), String(0.4 * 0.2));
  view.render([], null);
  view.render([updated], null);
  assert.equal(elementsByClass(doc.querySelector("#raster-layer-list"), "map-layer-legend")[0].open, false);
});

test("fixed symbols retain their compact key and expose on-map inclusion in Legend", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  for (const [shape, tag] of [["polygon", "RECT"], ["line", "PATH"], ["point", "CIRCLE"]]) {
    view.render([{ ...LAYERS[0], opacity: 0.5, legend: { kind: "fixed", label: shape, symbol: {
      shape, fill: shape === "line" ? null : "#ff00ff", fillOpacity: 0.6,
      stroke: "#333333", strokeOpacity: 0.4, strokeWidth: 2, pointSize: 8,
    } } }], null);
    const row = doc.querySelector("#raster-layer-list").children[0];
    const key = elementsByClass(row, "map-layer-color-key")[0];
    const symbol = key.children[0].children[0];
    assert.equal(symbol.tagName, tag);
    assert.equal(symbol.getAttribute("fill"), shape === "line" ? "none" : "#ff00ff");
    assert.equal(symbol.getAttribute("stroke-opacity"), "0.2");
    assert.equal(key.getAttribute("role"), "img");
    assert.equal(elementsByClass(row, "map-layer-legend").length, 1);
    assert.equal(actionControl(row, "legend-inclusion").checked, true);
  }
});

test("compact class strips include every color in order, including Other and No value", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  for (const count of [1, 5, 52]) {
    for (const shape of ["polygon", "line", "point"]) {
      const entries = Array.from({ length: count }, (_, index) => ({
        label: index === count - 1 ? "No value" : index === count - 2 ? "Other" : `Class ${index}`,
        symbol: { shape, fill: `#${(index + 100).toString(16).padStart(6, "0")}`, fillOpacity: 0.6,
          stroke: `#${(index + 200).toString(16).padStart(6, "0")}`, strokeOpacity: 0.8, strokeWidth: 2, pointSize: 8 },
      }));
      view.render([{ ...LAYERS[0], opacity: 0.5, legend: { kind: "categories", label: "Risk", entries } }], null);
      const row = doc.querySelector("#raster-layer-list").children[0];
      const key = elementsByClass(row, "map-layer-color-key")[0];
      const strip = elementsByClass(key, "map-layer-legend-palette")[0];
      assert.equal(strip.children.length, count);
      assert.deepEqual(strip.children.map(swatch => swatch.style.backgroundColor),
        entries.map(entry => shape === "line" ? entry.symbol.stroke : entry.symbol.fill));
      assert.ok(strip.children.every(swatch => swatch.style.opacity === (shape === "line" ? "0.4" : "0.3")));
      assert.equal(elementsByClass(row, "map-layer-legend-swatch").length, count, "full symbols remain available");
      assert.equal(key.getAttribute("aria-label"), `Risk: ${count} ${count === 1 ? "class" : "classes"}. Expand Legend for all values.`);
    }
  }
});

test("raster ramps expose all three values and use effective opacity", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  view.render([{ ...LAYERS[0], opacity: 0.3, effectiveOpacity: 1 }], null);
  const row = doc.querySelector("#raster-layer-list").children[0];
  const ramps = elementsByClass(row, "map-layer-legend-gradient");
  assert.equal(ramps.length, 2, "compact key and full ramp");
  assert.equal(ramps[0].children[0].style.background, LAYERS[0].legend.gradient);
  assert.equal(ramps[0].children[0].style.opacity, "1");
  const values = elementsByClass(row, "map-layer-legend-values")[0];
  assert.deepEqual(values.children.map(child => child.children[0].textContent), ["Minimum", "Midpoint", "Maximum"]);
  assert.deepEqual(values.children.map(child => child.children[1].textContent), LAYERS[0].legend.labels.map(String));
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

test("visibility and background updates keep the visible row stationary across layout changes", () => {
  const doc = new FakeLayerStackDocument(), view = new MapLayerStackView(doc);
  const list = doc.querySelector("#raster-layer-list"), scroller = doc.layerScrollContainer;
  let extraHeight = 0;
  const createElement = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const element = createElement(tag);
    if (tag === "li") element.getBoundingClientRect = () => {
      const top = Number(element.dataset.layerIndex) * 100 + extraHeight - scroller.scrollTop;
      return { top, bottom: top + 100, height: 100 };
    };
    return element;
  };
  view.render(LAYERS, null);
  scroller.scrollTop = 120;
  const originalTop = list.children[1].getBoundingClientRect().top;
  const replaceChildren = list.replaceChildren.bind(list);
  list.replaceChildren = (...rows) => {
    replaceChildren(...rows);
    scroller.scrollTop = 0; // Detached content can change the browser's scroll range.
  };
  for (const visible of [false, true, false]) {
    actionControl(list.children[1], "visibility").focus();
    view.render(LAYERS.map(layer => ({ ...layer, visible })), null,
      { key: LAYERS[1].key, action: "visibility" });
    assert.equal(scroller.scrollTop, 120);
    assert.equal(list.children[1].getBoundingClientRect().top, originalTop);
    assert.equal(doc.activeElement.dataset.layerAction, "visibility");
    assert.deepEqual(doc.activeElement.lastFocusOptions, { preventScroll: true });
  }
  // A status row above the viewport grows during rebuilding; preserve the row, not just scrollTop.
  list.replaceChildren = (...rows) => { replaceChildren(...rows); extraHeight = 20; scroller.scrollTop = 0; };
  view.render(LAYERS.map((layer, index) => ({ ...layer, error: index === 0 ? "Rendering failed" : null })), null);
  assert.equal(scroller.scrollTop, 140);
  assert.equal(list.children[1].getBoundingClientRect().top, originalTop);
  assert.equal(doc.activeElement.dataset.layerKey, LAYERS[1].key);
  assert.deepEqual(doc.activeElement.lastFocusOptions, { preventScroll: true });
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
  assert.deepEqual(documentContext.activeElement.lastFocusOptions, { preventScroll: false });

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

test("sort is a repeatable one-time action, preserves focus and needs at least two layers", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  const sort = doc.querySelector("#map-layers-sort");
  const received = [];
  view.bind({ onSort: order => { received.push(order); view.render(LAYERS, null); } });
  view.render([], null);
  assert.equal(sort.disabled, true);
  view.render([LAYERS[0]], null);
  assert.equal(sort.disabled, true);
  view.render(LAYERS, null);
  assert.equal(sort.disabled, false);
  sort.focus();
  for (const order of ["name-ascending", "name-descending", "visible-first", "layer-type", "layer-type"]) {
    sort.value = order;
    sort.dispatchEvent(new Event("change"));
    assert.equal(sort.value, "");
    assert.equal(doc.activeElement, sort);
  }
  assert.deepEqual(received, ["name-ascending", "name-descending", "visible-first", "layer-type", "layer-type"]);
  sort.dispatchEvent(new Event("change"));
  view.unbind();
  sort.value = "name-ascending";
  sort.dispatchEvent(new Event("change"));
  assert.equal(received.length, 5, "empty choice and unbound view do not sort");
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

test("Undo removal replaces the final layer and reports busy and retry states", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  let undos = 0;
  view.bind({ onUndoRemove: () => { undos++; } });
  view.render([], null);
  view.showRemoval({ label: "Field notes", index: 0 }, false, null);
  assert.equal(doc.querySelector("#raster-layer-stack").hidden, false);
  assert.equal(doc.querySelector("#map-layer-removal").hidden, false);
  const button = doc.querySelector("#undo-layer-removal");
  assert.equal(button.textContent, "Undo");
  view.showRemoval({ label: "Field notes", index: 0 }, true, null);
  assert.equal(button.disabled, true);
  view.showRemoval({ label: "Field notes", index: 0 }, false, "Device storage is full");
  assert.equal(button.disabled, false);
  assert.match(doc.querySelector("#map-layer-removal-error").textContent, /Device storage is full/);
  button.dispatchEvent(new Event("click"));
  view.showRemoval(null, false, null);
  assert.equal(doc.querySelector("#map-layer-removal").hidden, true);
  assert.equal(doc.querySelector("#raster-layer-stack").hidden, true);
  assert.equal(undos, 1);
});

test("Undo stays at the removed row across rerenders and moves when another layer is removed", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  let dismissals = 0;
  view.bind({ onDismissRemoval: () => { dismissals++; view.showRemoval(null, false, null); } });
  const list = doc.querySelector("#raster-layer-list");
  const notice = doc.querySelector("#map-layer-removal");
  const undo = doc.querySelector("#undo-layer-removal");
  view.render([LAYERS[0], LAYERS[2]], null);
  const firstRow = list.children[0];
  view.showRemoval({ label: "Middle layer", index: 1 }, false, null);
  assert.equal(list.children[1], notice);
  assert.equal(list.children[0], firstRow, "only the placeholder is inserted; live layer controls are not rebuilt");
  assert.equal(list.children.length, 3);
  undo.focus();
  view.render([LAYERS[0], LAYERS[2]], null);
  assert.equal(list.children[1], notice);
  assert.equal(doc.activeElement, undo);
  view.render([LAYERS[2]], null);
  view.showRemoval({ label: "First layer", index: 0 }, false, null);
  assert.equal(list.children[0], notice);
  assert.equal(list.children.length, 2, "there is only one Undo row");
  doc.querySelector("#dismiss-layer-removal").dispatchEvent(new Event("click"));
  assert.equal(dismissals, 1);
  assert.equal(list.children.length, 1);
  assert.equal(doc.querySelector("#raster-layer-stack").hidden, false);
});

test("pointer reorder ignores the Undo row when finding a real layer destination", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  const moves = [];
  view.bind({ onReorder: (key, index) => moves.push([key, index]) });
  view.render(LAYERS, null);
  view.showRemoval({ label: "Removed bottom layer", index: 3 }, false, null);
  const rows = doc.querySelector("#raster-layer-list").children;
  const handle = actionControl(rows[0], "reorder");
  handle.dispatchEvent(interactionEvent("pointerdown", { pointerId: 9, button: 0, clientY: 10 }));
  handle.dispatchEvent(interactionEvent("pointermove", { pointerId: 9, clientY: 300 }));
  handle.dispatchEvent(interactionEvent("pointerup", { pointerId: 9 }));
  assert.deepEqual(moves, [[LAYERS[0].key, 2]], "placeholder must not produce an out-of-range layer index");
});


test("an owner-supplied details control replaces Info and retains focus", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  const editButton = documentContext.createElement("button");
  editButton.textContent = "Edit";
  const layer = { ...LAYERS[0], detailsControl: editButton };
  view.render([layer], null);
  const list = documentContext.querySelector("#raster-layer-list");
  assert.equal(elementsByClass(list, "map-layer-row-actions")[0].children[0], editButton);
  assert.throws(() => actionControl(list.children[0], "info"), "Info must not duplicate Edit");
  assert.ok(elementsByClass(list, "map-layer-primary-row")[0].children.includes(actionControl(list.children[0], "remove")));
  editButton.focus();
  view.render([LAYERS[1], layer], null);
  assert.equal(documentContext.activeElement, editButton);
  assert.equal(elementsByClass(list, "map-layer-row-actions")[1].children[0], editButton);
});

test("layer types and owner style targets distinguish annotations without embedding their editor", () => {
    const doc = new FakeLayerStackDocument();
    const view = new MapLayerStackView(doc);
    const shared = { ...LAYERS[0], key: "shared", item: null, datasetKind: "annotation", typeLabel: "Shared annotation", stylePanelId: "annotations-panel" };
    view.render([shared], null);
    const row = doc.querySelector("#raster-layer-list").children[0];
    assert.equal(elementsByClass(row, "map-layer-type")[0].textContent, "Shared annotation");
    assert.match(row.getAttribute("aria-label"), /shared annotation layer/);
    assert.equal(actionControl(row, "style").getAttribute("aria-controls"), "annotations-panel");
});

test("layer provenance precedes its title and its primary action retains focus", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  const primaryControl = documentContext.createElement("div");
  const draw = documentContext.createElement("button"); primaryControl.append(draw);
  const layer = { ...LAYERS[0], attribution: "Shared by Maria · Watersheds", primaryControl };
  view.render([layer], null);
  const row = documentContext.querySelector("#raster-layer-list").children[0];
  const attribution = elementsByClass(row, "map-layer-attribution")[0];
  const primary = elementsByClass(row, "map-layer-primary-row")[0];
  assert.equal(attribution.textContent, layer.attribution);
  assert.ok(row.children.indexOf(attribution) < row.children.indexOf(primary));
  assert.ok(row.children.includes(primaryControl));
  draw.focus(); view.render([layer], null);
  assert.equal(documentContext.activeElement, draw);
});

test("both legend presentations share all colors, selection, ordering and disclosure state", async () => {
  const { OnMapLegend } = await import("../../src/map-layers/on-map-legend.js");
  const doc = new FakeLayerStackDocument(), toggleButton = doc.createElement("button"), more = doc.createElement("details");
  toggleButton.closest = () => more;
  let changes = 0, removed = false;
  const map = { getContainer: () => ({ ownerDocument: doc }), getSize: () => ({ x: 800, y: 720 }), on() {}, off() {} };
  const leaflet = { DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {} },
    control: () => ({ addTo() {}, remove() { removed = true; } }) };
  let layers = LAYERS.map(layer => ({ ...layer, visible: true }));
  layers[0].label = "<b>Literal layer name</b>";
  layers[0].legend = { ...layers[0].legend, labels: [0.013103712815791368, 12345.678, 0.000012345] };
  const view = new MapLayerStackView(doc);
  const setIncluded = (key, included) => {
    layers = layers.map(layer => layer.key === key ? { ...layer, legendIncluded: included } : layer);
    view.render(layers, null);
    legend.update(layers);
  };
  view.bind({ onLegendInclusion: setIncluded });
  const legend = new OnMapLegend(leaflet, map, { toggleButton, onInclusion: setIncluded, onChange: () => changes++ });
  view.render(layers, null);
  legend.update(layers);
  assert.equal(legend.contents.children.length, layers.length);
  assert.equal(legend.contents.children[0].children[0].textContent, layers[0].label);
  const values = elementsByClass(legend.contents.children[0], "map-layer-legend-values")[0];
  assert.deepEqual(values.children.map(value => value.children[1].textContent), ["0.0131", "1.235e+4", "1.234e-5"]);
  assert.equal(values.children[0].children[1].title, "0.013103712815791368");
  const input = legend.choices.children[0].children[0];
  input.focus(); input.checked = false; input.dispatchEvent(new Event("change"));
  assert.equal(legend.contents.children.length, layers.length - 1);
  assert.equal(doc.activeElement, legend.choices.children[0].children[0]);
  const row = doc.querySelector("#raster-layer-list").children[0];
  const inclusion = actionControl(row, "legend-inclusion");
  assert.equal(inclusion.checked, false);
  inclusion.checked = true; inclusion.dispatchEvent(new Event("change"));
  assert.equal(legend.contents.children.length, layers.length);
  layers.reverse(); layers[0].visible = false;
  legend.update(layers);
  assert.equal(legend.choices.children.length, layers.length);
  assert.equal(legend.contents.children[0].children[0].textContent, layers[1].label);
  legend.collapse.dispatchEvent(new Event("click"));
  assert.equal(legend.body.hidden, true);
  assert.equal(legend.collapse.getAttribute("aria-expanded"), "false");
  legend.root.children[0].children[1].dispatchEvent(new Event("click"));
  assert.equal(legend.root.hidden, true);
  assert.equal(toggleButton.textContent, "Show legend");
  assert.equal(doc.activeElement, toggleButton);
  toggleButton.dispatchEvent(new Event("click"));
  assert.equal(legend.root.hidden, false);
  assert.equal(legend.body.hidden, true, "restoring does not discard collapse preference");
  legend.restore({ visible: false, collapsed: false });
  assert.deepEqual(legend.snapshot(), { visible: false, collapsed: false });
  assert.equal(changes, 3);
  const symbol = { shape: "polygon", fill: "#aabbcc", fillOpacity: 0.6,
    stroke: "#123456", strokeOpacity: 0.8, strokeWidth: 2 };
  const fixed = { key: "pa", label: "PA Category II", visible: true, opacity: 0.5,
    legend: { kind: "fixed", label: "Polygon", symbol } };
  legend.update([fixed]);
  const fixedRow = legend.contents.children[0];
  assert.ok(fixedRow.classList.contains("on-map-legend-layer--fixed"));
  assert.equal(fixedRow.children.length, 2, "the symbol and layer name share one row");
  assert.equal(fixedRow.children[1].textContent, "PA Category II");
  assert.equal(elementsByClass(fixedRow, "map-layer-legend-field").length, 0);
  assert.equal(elementsByClass(fixedRow, "map-layer-legend-list").length, 0);
  const shape = elementsByClass(fixedRow, "map-layer-legend-swatch")[0].children[0].children[0];
  assert.equal(shape.getAttribute("fill"), "#aabbcc");
  assert.equal(shape.getAttribute("stroke"), "#123456");
  assert.equal(shape.getAttribute("fill-opacity"), "0.3");
  legend.update([{ ...fixed, legend: { kind: "categories", label: "Protection class",
    entries: [{ label: "II", symbol }, { label: "III", symbol: { ...symbol, fill: "#ddeeff" } }] } }]);
  const classifiedRow = legend.contents.children[0];
  assert.ok(!classifiedRow.classList.contains("on-map-legend-layer--fixed"));
  assert.equal(elementsByClass(classifiedRow, "map-layer-legend-field")[0].textContent, "Protection class");
  assert.equal(elementsByClass(classifiedRow, "map-layer-legend-swatch").length, 2);
  legend.remove(); assert.equal(removed, true);
});
