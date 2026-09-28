import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SavedMapViewLocalStorage } from "../src/saved-map-view/local-storage.js";

import {
    CONTROL_PANEL_TRANSITION_MILLISECONDS,
    EomapLayoutController,
} from "../src/eomap-layout-controller.js";

/** Minimal token-list contract used by the layout controller tests. */
class FakeClassList {
    /** Create a token list with optional initial class names. */
    constructor(...tokens) {
        this.tokens = new Set(tokens);
    }

    /**
     * Force one class token on or off.
     *
     * @param {string} token Class token.
     * @param {boolean} force Whether the class is present.
     * @return {void}
     */
    toggle(token, force) {
        if (force) {
            this.tokens.add(token);
        } else {
            this.tokens.delete(token);
        }
    }

    /**
     * Report whether one class token is present.
     *
     * @param {string} token Class token.
     * @return {boolean} Whether the token is present.
     */
    contains(token) {
        return this.tokens.has(token);
    }
}

/** Minimal focusable DOM element used by layout controller tests. */
class FakeLayoutElement extends EventTarget {
    /**
     * Create one element with mutable presentation state.
     *
     * @param {Object<string, string>} [attributes={}] Initial attributes.
     * @param {string[]} [classes=[]] Initial class tokens.
     * @param {string} [tagName="DIV"] Uppercase element tag name.
     */
    constructor(attributes = {}, classes = [], tagName = "DIV") {
        super();
        this.attributes = new Map(Object.entries(attributes));
        this.classList = new FakeClassList(...classes);
        this.descendants = new Set();
        this.hidden = false;
        this.inert = false;
        this.open = false;
        this.scrollTop = 0;
        this.textContent = "";
        this.focused = false;
        this.ownerDocument = null;
        this.tagName = tagName;
    }

    /**
     * Return one stored attribute.
     *
     * @param {string} name Attribute name.
     * @return {string|null} Attribute value or null when absent.
     */
    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    /**
     * Store one attribute value.
     *
     * @param {string} name Attribute name.
     * @param {string} value Attribute value.
     * @return {void}
     */
    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    /**
     * Remove one stored attribute.
     *
     * @param {string} name Attribute name.
     * @return {void}
     */
    removeAttribute(name) {
        this.attributes.delete(name);
    }

    /** Mark this element as the document focus target. @return {void} */
    focus() {
        this.focused = true;
        if (this.ownerDocument !== null) {
            this.ownerDocument.activeElement = this;
        }
    }

    /**
     * Register one descendant for focus-ownership tests.
     *
     * @param {FakeLayoutElement} element Descendant element.
     * @return {void}
     */
    addDescendant(element) {
        this.descendants.add(element);
    }

    /**
     * Report whether this element recursively contains a candidate.
     *
     * @param {FakeLayoutElement|null|undefined} element Candidate element.
     * @return {boolean} Whether this element contains the candidate.
     */
    contains(element) {
        if (element === this) {
            return true;
        }
        return [...this.descendants].some(
            (descendant) => descendant.contains(element)
        );
    }
}

/** Minimal queryable document and keyboard event target. */
class FakeLayoutDocument extends EventTarget {
    /**
     * Create a document backed by stable selector entries.
     *
     * @param {Map<string, FakeLayoutElement>} elements Selector entries.
     */
    constructor(elements) {
        super();
        this.elements = elements;
        this.activeElement = null;
        for (const element of elements.values()) {
            element.ownerDocument = this;
        }
    }

    /**
     * Resolve one registered layout element.
     *
     * @param {string} selector CSS selector.
     * @return {FakeLayoutElement|null} Registered element or null.
     */
    querySelector(selector) {
        return this.elements.get(selector) ?? null;
    }
}

/** Keyboard event with observable default prevention. */
class FakeKeyboardEvent extends Event {
    /**
     * Create one keyboard event.
     *
     * @param {string} key Keyboard key value.
     */
    constructor(key) {
        super("keydown", { cancelable: true });
        this.key = key;
    }
}

/**
 * Build the complete static layout contract and deterministic timer queue.
 *
 * @return {Object} Layout elements, document, scheduler, and timer queue.
 */
function createLayoutFixture() {
    const app = new FakeLayoutElement();
    const panel = new FakeLayoutElement();
    const collapsePanel = new FakeLayoutElement();
    const openPanel = new FakeLayoutElement();
    openPanel.hidden = true;
    const operationalRegion = new FakeLayoutElement();
    const operationalToggle = new FakeLayoutElement({
        "aria-expanded": "false",
    });
    operationalToggle.textContent = "Status";
    const operationalBody = new FakeLayoutElement({
        "aria-hidden": "true",
    });
    operationalBody.hidden = true;
    operationalRegion.addDescendant(operationalBody);

    const catalogTab = new FakeLayoutElement({ "aria-expanded": "true" });
    const catalogRegion = new FakeLayoutElement();
    const catalogContent = new FakeLayoutElement();
    catalogRegion.addDescendant(catalogContent);
    const renderingTab = new FakeLayoutElement({ "aria-expanded": "false" });
    const renderingRegion = new FakeLayoutElement();
    const renderingContent = new FakeLayoutElement();
    renderingRegion.addDescendant(renderingContent);
    renderingRegion.hidden = true;

    for (const child of [
        collapsePanel,
        operationalToggle,
        operationalRegion,
        catalogTab,
        catalogRegion,
        renderingTab,
        renderingRegion,
    ]) {
        panel.addDescendant(child);
    }
    const elements = new Map([
        ["#app", app],
        ["#control-panel", panel],
        ["#collapse-panel", collapsePanel],
        ["#open-panel", openPanel],
        ["#eomap-operational-status-region", operationalRegion],
        ["#toggle-operational-status", operationalToggle],
        ["#eomap-operational-status-body", operationalBody],
        ["#toggle-catalog-workspace", catalogTab],
        ["#eomap-catalog-region", catalogRegion],
        ["#toggle-map-layers", renderingTab],
        ["#eomap-map-layers-region", renderingRegion],
        ["#eomap-map-layers-body", renderingContent],
    ]);
    const timers = [];
    return {
        app,
        catalogContent,
        catalogRegion,
        catalogTab,
        collapsePanel,
        document: new FakeLayoutDocument(elements),
        openPanel,
        operationalBody,
        operationalRegion,
        operationalToggle,
        panel,
        renderingContent,
        renderingRegion,
        renderingTab,
        schedule(callback, delay) {
            timers.push({ callback, delay });
        },
        timers,
    };
}

test("shared viewer omits catalog and status while retaining layer and sidebar controls", () => {
    const fixture = createLayoutFixture();
    const layout = new EomapLayoutController({
        documentContext: fixture.document, schedule: fixture.schedule,
        invalidateMapSize() {}, allowCatalog: false, allowOperationalStatus: false,
        workspaceStorage: new SavedMapViewLocalStorage({
            getItem: () => '{"catalogOpen":true,"mapLayersOpen":true}',
        }),
    });
    layout.showWorkspace("catalog");
    fixture.catalogTab.dispatchEvent(new Event("click"));
    fixture.operationalToggle.dispatchEvent(new Event("click"));
    assert.equal(fixture.catalogTab.hidden, true);
    assert.equal(fixture.catalogRegion.hidden, true);
    assert.equal(fixture.operationalRegion.hidden, true);
    assert.equal(fixture.operationalToggle.hidden, true);
    layout.showWorkspace("map-layers");
    assert.equal(fixture.renderingRegion.hidden, false);
    layout.setControlPanelCollapsed(true);
    assert.equal(fixture.openPanel.hidden, false);
    layout.setControlPanelCollapsed(false);
    assert.equal(fixture.renderingRegion.hidden, false);
    assert.equal(fixture.catalogRegion.hidden, true);
});

test("workspace disclosures expose independent initial panel states", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });

    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.catalogRegion.getAttribute("aria-hidden"), "false");
    assert.equal(fixture.catalogTab.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.renderingRegion.hidden, true);
    assert.equal(fixture.renderingTab.getAttribute("aria-expanded"), "false");
    assert.equal(
        fixture.app.classList.contains("is-expanded-catalog-workspace"),
        true
    );
    assert.equal(
        fixture.app.classList.contains("is-expanded-map-layers-workspace"),
        false
    );
    assert.equal(fixture.timers.length, 0);
    controller.destroy();
});

test("workspace panels save and restore all four combinations through existing storage", () => {
    for (const catalogOpen of [true, false]) {
        for (const mapLayersOpen of [true, false]) {
            const values = new Map();
            const storage = new SavedMapViewLocalStorage({
                getItem: key => values.get(key) ?? null,
                setItem: (key, value) => values.set(key, value),
            }, "eolab.workspace-panels.v1");
            const fixture = createLayoutFixture();
            const controller = new EomapLayoutController({
                documentContext: fixture.document, schedule: fixture.schedule,
                invalidateMapSize() {}, workspaceStorage: storage,
            });
            assert.equal(storage.read(), null, "startup must not overwrite preferences");
            // Exercise both controls even when the desired state is the default.
            fixture.catalogTab.dispatchEvent(new Event("click"));
            if (catalogOpen) fixture.catalogTab.dispatchEvent(new Event("click"));
            controller.showWorkspace("map-layers");
            if (!mapLayersOpen) {
                fixture.renderingTab.focus();
                fixture.document.dispatchEvent(new FakeKeyboardEvent("Escape"));
            }
            assert.deepEqual(JSON.parse(storage.read()), { catalogOpen, mapLayersOpen });
            controller.destroy();

            const restored = createLayoutFixture();
            const reloaded = new EomapLayoutController({
                documentContext: restored.document, schedule: restored.schedule,
                invalidateMapSize() {}, workspaceStorage: storage,
            });
            assert.equal(restored.timers.length, catalogOpen && !mapLayersOpen ? 0 : 1);
            // Resizing for content that arrives later must retain the restored state.
            reloaded.notifyLayoutChange();
            assert.equal(restored.catalogRegion.hidden, !catalogOpen);
            assert.equal(restored.renderingRegion.hidden, !mapLayersOpen);
            assert.equal(restored.catalogTab.getAttribute("aria-expanded"), String(catalogOpen));
            assert.equal(restored.renderingTab.getAttribute("aria-expanded"), String(mapLayersOpen));
            assert.equal(restored.document.activeElement, null);
            reloaded.destroy();
        }
    }
});

test("missing, invalid, or unavailable panel storage preserves defaults", () => {
    for (const value of [null, "{", "null", "[]", "{}", '{"catalogOpen":false}',
        '{"catalogOpen":"false","mapLayersOpen":true}']) {
        const fixture = createLayoutFixture();
        const controller = new EomapLayoutController({
            documentContext: fixture.document, schedule: fixture.schedule,
            invalidateMapSize() {},
            workspaceStorage: new SavedMapViewLocalStorage({ getItem: () => value }),
        });
        assert.equal(fixture.catalogRegion.hidden, false);
        assert.equal(fixture.renderingRegion.hidden, true);
        controller.destroy();
    }
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document, schedule: fixture.schedule,
        invalidateMapSize() {}, workspaceStorage: new SavedMapViewLocalStorage(null),
    });
    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, true);
    controller.showWorkspace("map-layers");
    assert.equal(fixture.renderingRegion.hidden, false);
    controller.destroy();
});

test("click toggles each workspace without changing its siblings", () => {
    const fixture = createLayoutFixture();
    let invalidationCount = 0;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize: () => invalidationCount += 1,
        schedule: fixture.schedule,
    });

    fixture.renderingTab.dispatchEvent(new Event("click"));

    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, false);
    assert.equal(fixture.renderingTab.getAttribute("aria-expanded"), "true");
    assert.equal(
        fixture.app.classList.contains("is-expanded-map-layers-workspace"),
        true
    );
    assert.equal(fixture.timers.length, 1);
    assert.equal(
        fixture.timers[0].delay,
        CONTROL_PANEL_TRANSITION_MILLISECONDS
    );

    fixture.catalogTab.dispatchEvent(new Event("click"));
    assert.equal(fixture.catalogRegion.hidden, true);
    assert.equal(fixture.renderingRegion.hidden, false);
    assert.equal(fixture.timers.length, 2);
    for (const timer of fixture.timers) {
        timer.callback();
    }
    assert.equal(invalidationCount, 2);
    controller.destroy();
});

test("composition can expand a named workspace without closing siblings", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    fixture.collapsePanel.dispatchEvent(new Event("click"));
    fixture.openPanel.focused = false;

    fixture.renderingContent.scrollTop = 240;
    controller.showWorkspace("map-layers");

    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.openPanel.hidden, true);
    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, false);
    assert.equal(fixture.renderingTab.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.renderingTab.focused, false);
    assert.equal(fixture.renderingContent.scrollTop, 0);
    assert.equal(fixture.timers.length, 3);
    assert.throws(
        () => controller.showWorkspace("statistics"),
        /Unknown EOMap workspace: statistics/
    );
    controller.destroy();
});

test("Map layers collapse and reopen preserve their content", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });

    fixture.renderingTab.dispatchEvent(new Event("click"));
    const layerAction = new FakeLayoutElement({}, [], "BUTTON");
    layerAction.ownerDocument = fixture.document;
    fixture.renderingContent.addDescendant(layerAction);
    fixture.renderingContent.scrollTop = 120;
    layerAction.focus();
    const escape = new FakeKeyboardEvent("Escape");
    fixture.document.dispatchEvent(escape);

    assert.equal(escape.defaultPrevented, true);
    assert.equal(fixture.document.activeElement, fixture.renderingTab);
    assert.equal(fixture.renderingRegion.hidden, true);
    assert.equal(fixture.renderingContent.hidden, false);
    assert.equal(fixture.renderingContent.contains(layerAction), true);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);

    fixture.renderingTab.dispatchEvent(new Event("click"));
    assert.equal(fixture.renderingRegion.hidden, false);
    assert.equal(fixture.renderingTab.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.renderingContent.contains(layerAction), true);
    assert.equal(fixture.renderingContent.scrollTop, 120);

    controller.destroy();
});

test("composition can notify a CSS-driven layout allocation change", () => {
    const fixture = createLayoutFixture();
    let invalidationCount = 0;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize: () => invalidationCount += 1,
        schedule: fixture.schedule,
    });

    controller.notifyLayoutChange();

    assert.equal(fixture.timers.length, 1);
    assert.equal(
        fixture.timers[0].delay,
        CONTROL_PANEL_TRANSITION_MILLISECONDS
    );
    fixture.timers[0].callback();
    assert.equal(invalidationCount, 1);
    controller.destroy();
});

test("operational status disclosure owns hidden state, Escape, and focus", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });

    assert.equal(fixture.operationalBody.hidden, true);
    assert.equal(fixture.operationalToggle.textContent, "Status");
    assert.equal(fixture.operationalToggle.getAttribute("aria-label"), "Show status details");
    fixture.operationalToggle.dispatchEvent(new Event("click"));
    assert.equal(fixture.operationalBody.hidden, false);
    assert.equal(fixture.operationalBody.getAttribute("aria-hidden"), "false");
    assert.equal(fixture.operationalToggle.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.operationalToggle.textContent, "Status");
    assert.equal(fixture.operationalToggle.getAttribute("aria-label"), "Hide status details");
    assert.equal(
        fixture.operationalRegion.classList.contains("is-collapsed"),
        false
    );

    fixture.document.activeElement = fixture.operationalBody;
    const escapeEvent = new FakeKeyboardEvent("Escape");
    fixture.document.dispatchEvent(escapeEvent);
    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(fixture.operationalBody.hidden, true);
    assert.equal(fixture.operationalToggle.focused, true);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.timers.length, 2);
    controller.destroy();
});

test("Escape on the header Status button closes details before the sidebar", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    assert.equal(fixture.operationalRegion.contains(fixture.operationalToggle), false);
    fixture.operationalToggle.dispatchEvent(new Event("click"));
    fixture.operationalToggle.focus();
    const escapeEvent = new FakeKeyboardEvent("Escape");
    fixture.document.dispatchEvent(escapeEvent);

    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(fixture.operationalBody.hidden, true);
    assert.equal(fixture.operationalToggle.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.operationalToggle.getAttribute("aria-label"), "Show status details");
    assert.equal(fixture.document.activeElement, fixture.operationalToggle);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    controller.destroy();
});

test("whole sidebar collapse preserves workspace state, inertness, and focus", () => {
    const fixture = createLayoutFixture();
    let invalidationCount = 0;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize: () => invalidationCount += 1,
        schedule: fixture.schedule,
    });
    fixture.renderingTab.dispatchEvent(new Event("click"));
    fixture.collapsePanel.dispatchEvent(new Event("click"));

    assert.equal(fixture.panel.classList.contains("is-collapsed"), true);
    assert.equal(fixture.panel.getAttribute("aria-hidden"), "true");
    assert.equal(fixture.panel.getAttribute("inert"), "");
    assert.equal(fixture.panel.inert, true);
    assert.equal(
        fixture.app.classList.contains("is-control-panel-collapsed"),
        true
    );
    assert.equal(fixture.openPanel.hidden, false);
    assert.equal(fixture.openPanel.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.collapsePanel.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.openPanel.focused, true);
    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, false);

    fixture.openPanel.dispatchEvent(new Event("click"));
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.panel.getAttribute("aria-hidden"), "false");
    assert.equal(fixture.panel.getAttribute("inert"), null);
    assert.equal(fixture.panel.inert, false);
    assert.equal(fixture.openPanel.hidden, true);
    assert.equal(fixture.openPanel.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.collapsePanel.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.collapsePanel.focused, true);
    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, false);
    assert.equal(fixture.timers.length, 3);
    for (const timer of fixture.timers) {
        timer.callback();
    }
    assert.equal(invalidationCount, 3);
    controller.destroy();
});

test("Escape inside a workspace collapses that panel and restores focus", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    fixture.document.activeElement = fixture.catalogContent;
    const escapeEvent = new FakeKeyboardEvent("Escape");

    fixture.document.dispatchEvent(escapeEvent);

    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.catalogTab.focused, true);
    assert.equal(fixture.catalogTab.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.catalogRegion.hidden, true);
    assert.equal(fixture.timers.length, 1);
    controller.destroy();
});

test("Escape preserves native input handling and ignores outside focus", () => {
    const fixture = createLayoutFixture();
    const rasterInput = new FakeLayoutElement({}, [], "INPUT");
    fixture.renderingRegion.addDescendant(rasterInput);
    rasterInput.ownerDocument = fixture.document;
    const outsideButton = new FakeLayoutElement({}, [], "BUTTON");
    outsideButton.ownerDocument = fixture.document;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });

    fixture.document.activeElement = rasterInput;
    const inputEscape = new FakeKeyboardEvent("Escape");
    fixture.document.dispatchEvent(inputEscape);
    assert.equal(inputEscape.defaultPrevented, false);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);

    fixture.document.activeElement = outsideButton;
    const outsideEscape = new FakeKeyboardEvent("Escape");
    fixture.document.dispatchEvent(outsideEscape);
    assert.equal(outsideEscape.defaultPrevented, false);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.timers.length, 0);
    controller.destroy();
});

test("destroy detaches every workspace-layout listener", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    controller.destroy();

    fixture.renderingTab.dispatchEvent(new Event("click"));
    fixture.operationalToggle.dispatchEvent(new Event("click"));
    fixture.collapsePanel.dispatchEvent(new Event("click"));
    fixture.openPanel.dispatchEvent(new Event("click"));
    fixture.document.activeElement = fixture.catalogContent;
    fixture.document.dispatchEvent(new FakeKeyboardEvent("Escape"));

    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, true);
    assert.equal(fixture.operationalBody.hidden, true);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.timers.length, 0);
});

test("layout controller rejects incomplete DOM and invalid dependencies", () => {
    assert.throws(
        () => new EomapLayoutController({
            documentContext: { querySelector: () => null },
            invalidateMapSize() {},
            schedule() {},
        }),
        /Required EOMap layout element is missing: #app/
    );
    assert.throws(
        () => new EomapLayoutController({ invalidateMapSize: null }),
        /Map-size invalidation must be callable/
    );
    assert.throws(
        () => new EomapLayoutController({
            invalidateMapSize() {},
            schedule: null,
        }),
        /Layout transition scheduling must be callable/
    );
});

test("layout controller retains a feature-neutral dependency boundary", () => {
    const controllerSource = readFileSync(
        new URL("../src/eomap-layout-controller.js", import.meta.url),
        "utf8"
    );
    const controllerImports = [
        ...controllerSource.matchAll(/from\s+["']([^"']+)["']/g),
    ];

    assert.equal(controllerImports.length, 0);
    assert.doesNotMatch(controllerSource, /querySelector\("#catalog-search"/);
    assert.doesNotMatch(controllerSource, /querySelector\("#raster-/);
    assert.doesNotMatch(controllerSource, /fetch\(|L\.|leafletMap/);
    assert.doesNotMatch(
        controllerSource,
        /append\(|appendChild\(|insertBefore\(|replaceChildren\(|matchMedia\(/
    );
    assert.doesNotMatch(
        controllerSource,
        /temporary-aoi|raster-viewer|vector\/sampling/
    );
});
