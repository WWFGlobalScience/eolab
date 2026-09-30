import assert from 'node:assert/strict';
import test from 'node:test';
import { MapLayerStyleEditor } from '../../src/map-layers/style-editor.js';
import { MapInspectionController } from '../../src/map-inspection-controller.js';
import { FakeRasterControlDocument } from '../../test-support/raster/fake-controls-document.js';

/** Build connected style and histogram panels with inspectable layer edits. */
function fixture() {
    const doc = new FakeRasterControlDocument();
    const events = new EventTarget();
    doc.addEventListener = events.addEventListener.bind(events);
    doc.removeEventListener = events.removeEventListener.bind(events);
    doc.dispatchEvent = events.dispatchEvent.bind(events);
    const root = doc.querySelector('#layer-style-editor');
    root.hidden = true;
    root.append(doc.querySelector('#close-layer-style'));
    const histogram = doc.querySelector('#map-histogram-panel');
    histogram.hidden = true;
    histogram.append(doc.querySelector('#close-map-histogram'));
    doc.querySelector('#vector-feature-inspector').hidden = true;
    doc.querySelector('#vector-time-series').hidden = true;
    doc.querySelector('#vector-feature-profile').hidden = true;
    doc.querySelector('#vector-filter-panel').hidden = true;
    doc.querySelector('#raster-clips-panel').hidden = true;
    doc.querySelector('#calculations-panel').hidden = true;
    doc.querySelector('#annotations-panel').hidden = true;
    doc.querySelector('#raster-series').hidden = true;
    const surface = doc.querySelector('#map-inspection');
    surface.showPopover = () => { surface.open = true; };
    surface.hidePopover = () => { surface.open = false; };
    const inspection = new MapInspectionController({ documentContext: doc });
    let layers = [{ key: 'a', label: 'a.tif', visible: true, opacity: 0.4 },
        { key: 'b', label: 'b.gpkg', visible: true, opacity: 1 }];
    const styleButtons = ['a', 'b'].map(key => {
        const button = doc.createElement();
        button.dataset = { layerKey: key };
        return button;
    });
    doc.querySelectorAll = () => styleButtons.filter(button => layers.some(layer => layer.key === button.dataset.layerKey));
    const edits = [];
    const pairedStyleRequests = [];
    const vectorStyleEvents = [];
    const editor = new MapLayerStyleEditor({ documentContext: doc, inspection,
        mapLayers: {
            snapshots: () => layers,
            setOpacity(key, value) { layers.find(layer => layer.key === key).opacity = value; edits.push([key, value]); },
        },
        rasterViewer: {
            openStyle: key => key === 'a', closeStyle() {}, refreshStyle() {},
            openPairedStyle(key) {
                pairedStyleRequests.push(key);
                inspection.showHistogram(2);
            },
        },
        vectorStyleControls: {
            show(target) { vectorStyleEvents.push(["show", target.key]); },
            hide() { vectorStyleEvents.push(["hide"]); },
        },
        getVectorStyleTarget: key => key === 'b' ? { key, style: {} } : null,
    });
    return { doc, root, histogram, surface, inspection, layers, styleButtons, edits, editor,
        vectorStyleEvents, pairedStyleRequests,
        setLayers(value) { layers = value; } };
}

test('one editor keeps its layer identity through reorder and persists opacity on close', () => {
    const h = fixture();
    h.editor.open('a');
    assert.equal(h.root.hidden, false);
    assert.equal(h.surface.open, true);
    assert.equal(
        h.doc.querySelector('#map-inspection-tab-style').textContent,
        'Style · a.tif',
    );
    assert.equal(h.doc.activeElement, h.editor.closeButton);
    h.setLayers([...h.layers].reverse());
    h.editor.refresh();
    assert.equal(h.editor.title.textContent, 'a.tif');
    h.editor.opacity.value = '65';
    h.editor.opacity.dispatchEvent(new Event('input'));
    assert.deepEqual(h.edits, [['a', 0.65]]);
    const escape = new Event('keydown', { cancelable: true });
    Object.defineProperty(escape, 'key', { value: 'Escape' });
    h.doc.dispatchEvent(escape);
    assert.equal(h.root.hidden, true);
    assert.equal(h.surface.open, false);
    assert.equal(h.doc.activeElement, h.styleButtons[0]);
    h.editor.open('a');
    assert.equal(h.editor.opacity.value, '65');
    h.editor.destroy();
});

test('renaming a layer refreshes an open style tab without changing the active tool', () => {
    const h = fixture();
    h.editor.open('a');
    h.inspection.showHistogram(1);
    const activeTool = h.inspection.activeTool;
    const focused = h.doc.activeElement;
    h.layers[0].label = 'Human impact';
    h.editor.refresh();
    assert.equal(h.editor.title.textContent, 'Human impact');
    assert.equal(h.doc.querySelector('#map-inspection-tab-style').textContent, 'Style · Human impact');
    assert.equal(h.inspection.activeTool, activeTool);
    assert.equal(h.doc.activeElement, focused);
    h.editor.destroy();
});

test('vector editor explains symbol controls, and removed targets close safely', () => {
    const h = fixture();
    h.editor.open('b');
    assert.equal(h.editor.rasterControls.hidden, true);
    assert.match(h.editor.note.textContent, /geometry-specific colors and size/);
    assert.deepEqual(h.vectorStyleEvents.at(-1), ["show", "b"]);
    h.setLayers([h.layers[0]]);
    h.editor.refresh();
    assert.equal(h.root.hidden, true);
    assert.equal(h.editor.key, null);
    assert.equal(h.doc.activeElement, h.doc.querySelector('#toggle-map-layers'));
    h.editor.destroy();
});

test('catalog and details shortcuts preserve hidden layer state and receive focus on close', () => {
    for (const key of ['a', 'b']) {
        const h = fixture();
        const layer = h.layers.find(layer => layer.key === key);
        layer.visible = false;
        const before = structuredClone(h.layers);
        const shortcut = h.doc.createElement();
        shortcut.isConnected = true;
        shortcut.focus();
        h.editor.open(key);
        assert.equal(h.editor.key, key);
        assert.equal(h.editor.title.textContent, layer.label);
        h.editor.close();
        assert.equal(h.doc.activeElement, shortcut);
        assert.deepEqual(h.layers, before);
        assert.deepEqual(h.edits, []);
        h.editor.destroy();
    }
});

test('closing falls back when a shortcut was removed, hidden, disabled, or in a collapsed pane', () => {
    for (const reason of ['removed', 'hidden', 'disabled', 'collapsed']) {
        const h = fixture();
        const shortcut = h.doc.createElement();
        shortcut.isConnected = true;
        shortcut.focus();
        h.editor.open('a');
        if (reason === 'removed') shortcut.isConnected = false;
        if (reason === 'hidden') shortcut.hidden = true;
        if (reason === 'disabled') shortcut.disabled = true;
        // Native focus is a no-op when a CSS-collapsed ancestor hides a control.
        if (reason === 'collapsed') shortcut.focus = () => {};
        h.editor.close();
        assert.equal(h.doc.activeElement, h.styleButtons[0]);
        h.editor.destroy();
    }
});

test('paired style shortcuts open the histogram without an ordinary style or opacity panel', () => {
    const h = fixture();
    h.layers[0].opacityLocked = true;
    h.layers[0].effectiveOpacity = 1;
    h.editor.open('a');
    assert.equal(h.root.hidden, true);
    assert.equal(h.editor.key, null);
    assert.equal(h.histogram.hidden, false);
    assert.deepEqual(h.pairedStyleRequests, ['a']);
    h.editor.opacity.dispatchEvent(new Event('input'));
    assert.deepEqual(h.edits, []);
    h.editor.destroy();
});

test('entering 2D replaces an open ordinary editor and 1D restores opacity editing', () => {
    const h = fixture();
    h.editor.open('a');
    h.layers[0].opacityLocked = true;
    h.editor.refresh();
    assert.equal(h.root.hidden, true);
    assert.equal(h.editor.key, null);
    assert.deepEqual(h.pairedStyleRequests, ['a']);
    h.layers[0].opacityLocked = false;
    h.editor.open('a');
    assert.equal(h.root.hidden, false);
    assert.equal(h.editor.opacity.disabled, false);
    assert.equal(h.editor.opacity.value, '40');
    h.editor.destroy();
});

test('Escape closes only the focused map tool while its neighbour stays usable', () => {
    const h = fixture();
    h.editor.open('a');
    h.inspection.showHistogram();
    h.doc.querySelector('#close-map-histogram').focus();
    /** Dispatch Escape at the owning document with its current focus. */
    const escape = () => {
        const event = new Event('keydown', { cancelable: true });
        Object.defineProperty(event, 'key', { value: 'Escape' });
        h.doc.dispatchEvent(event);
    };
    escape();
    assert.equal(h.histogram.hidden, true);
    assert.equal(h.root.hidden, false);
    assert.equal(h.editor.key, 'a');
    assert.equal(h.surface.open, true);
    h.inspection.showHistogram();
    h.editor.closeButton.focus();
    escape();
    assert.equal(h.histogram.hidden, false);
    assert.equal(h.root.hidden, true);
    assert.equal(h.surface.open, true);
    h.editor.destroy();
    h.inspection.destroy();
});
