import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { initializeCatalogPaneControls } from "../src/catalog-pane-controller.js";

class FakeClassList {
  constructor() {
    this.tokens = new Set();
  }

  toggle(token, force) {
    if (force) {
      this.tokens.add(token);
    } else {
      this.tokens.delete(token);
    }
  }

  contains(token) {
    return this.tokens.has(token);
  }
}

class FakeElement extends EventTarget {
  constructor(attributes = {}, ownerDocument = null) {
    super();
    this.attributes = new Map(Object.entries(attributes));
    this.classList = new FakeClassList();
    this.hidden = false;
    this.ownerDocument = ownerDocument;
    this.textContent = "";
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

function createCatalogPaneFixture() {
  const document = { activeElement: null, querySelector: null };
  const layout = new FakeElement({}, document);
  const resultsPane = new FakeElement({}, document);
  const resultsBody = new FakeElement({}, document);
  const resultsHeading = new FakeElement({}, document);
  const inspectorPane = new FakeElement(
    { "aria-hidden": "true" },
    document,
  );
  inspectorPane.hidden = true;
  const inspectorBody = new FakeElement({}, document);
  const inspectorHeading = new FakeElement({}, document);
  const closeItemDetails = new FakeElement({}, document);
  const elements = new Map([
    ["#catalog-layout", layout],
    ["#catalog-results-pane", resultsPane],
    ["#catalog-results-body", resultsBody],
    ["#catalog-results-heading", resultsHeading],
    ["#catalog-item-inspector", inspectorPane],
    ["#catalog-inspector-body", inspectorBody],
    ["#catalog-inspector-heading", inspectorHeading],
    ["#close-catalog-item-details", closeItemDetails],
  ]);
  document.querySelector = (selector) => elements.get(selector) ?? null;
  return {
    closeItemDetails,
    document,
    inspectorBody,
    inspectorHeading,
    inspectorPane,
    layout,
    resultsBody,
    resultsHeading,
    resultsPane,
  };
}

test("included-layer details open and close a dialog without revealing catalog results", () => {
  const fixture = createCatalogPaneFixture();
  const dialog = new EventTarget();
  dialog.open = false;
  dialog.append = element => { dialog.content = element; };
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const controls = initializeCatalogPaneControls(fixture.document, () => {}, { detailsDialog: dialog });
  const opener = new FakeElement({}, fixture.document);
  opener.isConnected = true;
  controls.showInspector({ moveFocus: true, returnFocusTarget: opener });
  assert.equal(dialog.open, true);
  assert.equal(dialog.content, fixture.inspectorPane);
  assert.equal(fixture.document.activeElement, fixture.inspectorHeading);
  assert.equal(fixture.closeItemDetails.textContent, "×");
  assert.equal(fixture.closeItemDetails.title, "Close layer details");
  fixture.closeItemDetails.dispatchEvent(new Event("click"));
  assert.equal(dialog.open, false);
  assert.equal(fixture.document.activeElement, opener);
  controls.showInspector({ returnFocusTarget: opener });
  dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  assert.equal(dialog.open, false);
  assert.equal(fixture.inspectorPane.hidden, true);
});

test("Catalog keeps results visible and reveals selection progressively", () => {
  const fixture = createCatalogPaneFixture();
  let layoutChanges = 0;
  const controls = initializeCatalogPaneControls(
    fixture.document,
    () => layoutChanges += 1,
  );

  assert.equal(fixture.resultsBody.hidden, false);
  assert.equal(fixture.inspectorPane.hidden, true);
  assert.equal(fixture.inspectorBody.hidden, true);
  assert.equal(controls.isInspectorVisible(), false);
  assert.equal(layoutChanges, 0);

  controls.showInspector({ moveFocus: true });

  assert.equal(fixture.inspectorPane.hidden, false);
  assert.equal(fixture.inspectorPane.getAttribute("aria-hidden"), "false");
  assert.equal(fixture.inspectorBody.hidden, false);
  assert.equal(
    fixture.layout.classList.contains("is-catalog-inspector-visible"),
    true,
  );
  assert.equal(fixture.document.activeElement, fixture.inspectorHeading);
  assert.equal(controls.isInspectorVisible(), true);
  assert.equal(layoutChanges, 1);

  controls.showInspector();
  assert.equal(layoutChanges, 1);

  controls.showResults();
  assert.equal(fixture.resultsBody.hidden, false);
  assert.equal(layoutChanges, 2);
});

test("Catalog validates its feature-neutral layout-change boundary", () => {
  const fixture = createCatalogPaneFixture();
  assert.throws(
    () => initializeCatalogPaneControls(fixture.document, null),
    /layout-change notifier must be callable/,
  );
});

test("Closing details focuses Catalog results when no originating row exists", () => {
  const fixture = createCatalogPaneFixture();
  const controls = initializeCatalogPaneControls(fixture.document);
  controls.showInspector();

  fixture.closeItemDetails.dispatchEvent(new Event("click"));

  assert.equal(fixture.inspectorPane.hidden, true);
  assert.equal(fixture.inspectorPane.getAttribute("aria-hidden"), "true");
  assert.equal(
    fixture.layout.classList.contains("is-catalog-inspector-visible"),
    false,
  );
  assert.equal(fixture.document.activeElement, fixture.resultsHeading);
});

test("More details reveals metadata immediately with scroll reset", () => {
  const fixture = createCatalogPaneFixture();
  const controls = initializeCatalogPaneControls(fixture.document);
  controls.showInspector();
  fixture.inspectorBody.scrollTop = 250;

  controls.showInspector({ moveFocus: true });

  assert.equal(fixture.inspectorBody.scrollTop, 0);
  assert.equal(controls.isInspectorVisible(), true);
  assert.equal(fixture.document.activeElement, fixture.inspectorHeading);
});

test("Closing details restores its origin, with a stale-row fallback", () => {
  const fixture = createCatalogPaneFixture();
  const controls = initializeCatalogPaneControls(fixture.document);
  const detailsButton = new FakeElement({}, fixture.document);
  detailsButton.isConnected = true;
  controls.showInspector({ moveFocus: true, returnFocusTarget: detailsButton });
  fixture.closeItemDetails.dispatchEvent(new Event("click"));
  assert.equal(fixture.document.activeElement, detailsButton);

  controls.showInspector({ returnFocusTarget: detailsButton });
  detailsButton.isConnected = false;
  fixture.closeItemDetails.dispatchEvent(new Event("click"));
  assert.equal(fixture.document.activeElement, fixture.resultsHeading);
});

test("Escape closes only the progressive inspector and restores results focus", () => {
  const fixture = createCatalogPaneFixture();
  const controls = initializeCatalogPaneControls(fixture.document);
  controls.showInspector();
  const escapeEvent = new Event("keydown", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(escapeEvent, "key", { value: "Escape" });

  fixture.inspectorPane.dispatchEvent(escapeEvent);

  assert.equal(escapeEvent.defaultPrevented, true);
  assert.equal(fixture.inspectorPane.hidden, true);
  assert.equal(fixture.resultsBody.hidden, false);
  assert.equal(fixture.document.activeElement, fixture.resultsHeading);
});

test("Catalog inspector shows requested metadata without a second disclosure", () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  assert.doesNotMatch(markup, /id="toggle-catalog-results"/);
  assert.doesNotMatch(markup, />Data discovery</);
  assert.doesNotMatch(markup, />Catalog results</);
  assert.doesNotMatch(markup, /Selected record|toggle-catalog-inspector/);
  assert.doesNotMatch(markup, /id="catalog-item-details"/);
  assert.ok(markup.indexOf('id="catalog-map-actions"') < markup.indexOf('id="catalog-inspector-content"'));
  assert.match(
    markup,
    /<button\s+class="secondary-button catalog-inspector-close"\s+id="close-catalog-item-details"[\s\S]*aria-label="Close item details"[\s\S]*title="Close item details"/,
  );
  assert.doesNotMatch(markup, /Back to results/);
  assert.match(markup, /id="catalog-item-inspector"[\s\S]*aria-hidden="true"[\s\S]*hidden/);
  assert.match(
    markup,
    /class="visually-hidden" id="catalog-results-heading" tabindex="-1"/,
  );
  assert.match(markup, /id="catalog-inspector-heading" tabindex="-1"/);
  assert.match(markup, /placeholder="Search filenames, hazards, or data types\.\.\."/);
  assert.match(markup, /<details class="catalog-actions">/);
  assert.ok(
    markup.indexOf('id="catalog-search"') <
      markup.indexOf('id="catalog-results-scroll"'),
  );
});

test("Catalog loading summary uses ASCII ellipsis punctuation", () => {
  const mainSource = readFileSync(
    new URL("../src/main.js", import.meta.url),
    "utf8",
  );

  assert.match(
    mainSource,
    /catalogSummaryElement\.textContent = "Loading results\.\.\.";/,
  );
});

test("Catalog layout reserves its height for compact searchable results", () => {
  const stylesheet = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8",
  );

  assert.match(stylesheet, /\.catalog-panel\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(
    stylesheet,
    /\.catalog-results-scroll\s*\{[^}]*overflow-y:\s*auto/s,
  );
  assert.match(
    stylesheet,
    /\.catalog-inspector-body\s*\{[^}]*overflow-y:\s*auto/s,
  );
  assert.match(
    stylesheet,
    /\.catalog-pane-body\[hidden\]\s*\{[^}]*display:\s*none/s,
  );
  assert.match(
    stylesheet,
    /\.catalog-inspector\s*\{[^}]*overflow:\s*hidden/s,
  );
  assert.doesNotMatch(stylesheet, /is-catalog-browser-collapsed/);
  assert.match(stylesheet, /is-catalog-inspector-visible/);
  assert.match(stylesheet, /\.catalog-item-heading h3\s*\{[^}]*font-size:\s*0\.82rem[^}]*text-overflow:\s*ellipsis/s);
  assert.match(stylesheet, /\.catalog-inspector-close\s*\{[^}]*display:\s*inline-grid/s);
  assert.match(stylesheet, /\.catalog-map-actions \.catalog-add-action\s*\{[^}]*background:\s*var\(--brand\)/s);
  assert.match(stylesheet, /\.catalog-on-map\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(stylesheet, /\.catalog-search-toolbar\s*\{/);
  assert.match(stylesheet, /\.catalog-result-count\s*\{/);
  assert.match(
    stylesheet,
    /\.catalog-result\s*\{[^}]*min-height:\s*84px[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s,
  );
  assert.match(stylesheet, /--workspace-catalog-inspector-width:/);
  assert.match(
    stylesheet,
    /@container catalog-workspace \(min-width: 640px\)[\s\S]*?\.catalog-layout\.is-catalog-inspector-visible\s*\{[^}]*grid-template-columns:\s*minmax\(280px, var\(--catalog-results-width\)\)\s*minmax\(320px, var\(--catalog-inspector-width\)\)/s,
  );
  assert.match(
    stylesheet,
    /@container catalog-workspace \(max-width: 639px\)[\s\S]*?\.catalog-layout\.is-catalog-inspector-visible \.catalog-browser\s*\{[^}]*display:\s*none/s,
  );
  assert.match(
    stylesheet,
    /@media \(max-width: 1199px\)[\s\S]*?\.catalog-layout\.is-catalog-inspector-visible \.catalog-browser\s*\{[^}]*display:\s*none/s,
  );
  assert.match(
    stylesheet,
    /\.catalog-map-actions\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s,
  );
});

test("Catalog selection delegates progressive presentation without feature coupling", () => {
  const mainSource = readFileSync(
    new URL("../src/main.js", import.meta.url),
    "utf8",
  );
  const controllerSource = readFileSync(
    new URL("../src/catalog-pane-controller.js", import.meta.url),
    "utf8",
  );
  const clearSelection = mainSource.slice(
    mainSource.indexOf("function clearCatalogSelection"),
    mainSource.indexOf("function selectCatalogItem"),
  );
  const selectItem = mainSource.slice(
    mainSource.indexOf("function selectCatalogItem"),
    mainSource.indexOf("function appendCatalogPage"),
  );

  assert.match(clearSelection, /catalogPaneControls\.showResults\(\)/);
  assert.match(
    selectItem,
    /catalogPaneControls\.showInspector\(\{\s*moveFocus: true, returnFocusTarget: itemButton,/,
  );
  assert.match(
    mainSource,
    /initializeCatalogPaneControls\(\s*document,\s*\(\) => layoutController\?\.notifyLayoutChange\(\)/s,
  );
  assert.doesNotMatch(
    controllerSource,
    /Leaflet|leaflet|raster|renderer|statistics|fetch\(/,
  );
});
