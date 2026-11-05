import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationSessionsView } from "../../src/annotation-sessions/view.js";

/** DOM test element supporting retained forms and movable status messages. */
class Element extends EventTarget {
    /** @param {Object} document Owner tracking focus. @param {string} tag HTML tag. */
    constructor(document, tag) {
        super(); this.ownerDocument = document; this.tagName = tag; this.children = [];
        this.attributes = new Map(); this.classes = new Set(); this.textContent = "";
        this.hidden = false; this.value = ""; this.open = false;
        this.classList = { toggle: (name, force) => force ? this.classes.add(name) : this.classes.delete(name) };
    }
    /** @param {...Element} nodes Elements to move into this parent. @return {void} */
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    /** Remove this element from its current parent. @return {void} */
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
    /** @param {...Element} nodes New child elements. @return {void} */
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    /** @return {Element|undefined} First child. */
    get firstChild() { return this.children[0]; }
    /** @param {string} name Attribute name. @param {string} value Attribute value. @return {void} */
    setAttribute(name, value) { this.attributes.set(name, value); }
    /** Show the modal. @return {void} */
    showModal() { this.open = true; }
    /** Close the modal. @return {void} */
    close() { this.open = false; }
    /** Focus this element. @return {void} */
    focus() { this.ownerDocument.activeElement = this; }
}

/** @return {Object} Dialog and connection calls through its public actions. */
function setup() {
    const document = { createElement: tag => new Element(document, tag) };
    document.body = document.createElement("body");
    const buttons = new Map();
    document.querySelector = key => { if (!buttons.has(key)) buttons.set(key, document.createElement("button")); return buttons.get(key); };
    const calls = [];
    const view = new AnnotationSessionsView(document, { connect: (...args) => calls.push(args), rename: (...args) => calls.push(["rename", ...args]),
        listLayers: () => calls.push(["list"]), addLayer: layer => calls.push(["add", layer]) });
    return { view, document, calls };
}

test("Your layers lists explicit Add actions with busy and already-on-map states", () => {
    const { view, document, calls } = setup();
    document.querySelector("#open-joined-annotation-layers").dispatchEvent(new Event("click"));
    assert.deepEqual(calls, [["list"]]);
    view.open("library");
    assert.equal(view.name.hidden, true);
    assert.equal(view.submit.hidden, true);
    assert.equal(view.code.input.disabled, true);
    assert.equal(view.cancel.textContent, "Close");
    view.showLayers([{ id: "one", name: "<Layer>", joinCode: "ABCDEFGH", onMap: false },
        { id: "two", name: "Already here", joinCode: "BCDEFGHJ", onMap: true }]);
    assert.equal(view.library.children[0].children[0].textContent, "<Layer>");
    view.busy(true);
    assert.equal(view.layerButtons.every(({ button }) => button.disabled), true);
    view.busy(false);
    assert.equal(view.layerButtons[0].button.disabled, false);
    assert.equal(view.layerButtons[1].button.disabled, true);
    view.layerButtons[0].button.dispatchEvent(new Event("click"));
    assert.deepEqual(calls.at(-1), ["add", { id: "one", joinCode: "ABCDEFGH" }]);
    view.open("join");
    assert.equal(view.library.hidden, true);
    assert.equal(view.name.input.disabled, false);
    assert.equal(view.submit.hidden, false);
});

test("first drawing asks only for a name and submits the map's fixed invitation", () => {
    const { view, document, calls } = setup();
    view.open("contribute", "included-layer", "ABCDEFGH");
    assert.equal(view.layerName.hidden, true);
    assert.equal(view.code.hidden, true);
    assert.equal(view.code.input.disabled, true);
    assert.equal(document.activeElement, view.name.input);
    assert.equal(view.submit.textContent, "Join and draw polygon");
    view.name.input.value = "Visitor";
    view.form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.deepEqual(calls[0], ["contribute", "ABCDEFGH", "Visitor", "included-layer"]);
});

test("create and join ask for a real display name and only the relevant connection field", () => {
    const { view, document, calls } = setup();
    document.querySelector("#create-shared-annotation-layer").dispatchEvent(new Event("click"));
    assert.equal(view.dialog.open, true);
    assert.equal(view.heading.textContent, "Create shared layer");
    assert.equal(view.submit.textContent, "Create shared layer");
    assert.equal(view.code.input.disabled, true);
    assert.equal(view.name.input.required, true);
    view.layerName.input.value = "Watersheds"; view.name.input.value = " Maria ";
    view.form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.deepEqual(calls[0], ["create", "Watersheds", "Maria", null]);
    view.connected(); assert.equal(view.dialog.open, false);
    view.open("join");
    assert.equal(view.heading.textContent, "Join shared layer");
    assert.equal(view.layerName.input.disabled, true);
    assert.equal(view.code.input.disabled, false);
    view.code.input.value = "ABCDEFGH";
    view.form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.deepEqual(calls[1], ["join", "ABCDEFGH", "Maria", null]);
});

test("failed joins retain values and pending connections cannot dismiss the dialog", () => {
    const { view } = setup(); view.open("join");
    view.name.input.value = "Rich"; view.busy(true);
    let prevented = false; view.dialog.oncancel({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(view.cancel.disabled, true);
    view.message("That name is already used"); view.busy(false);
    assert.equal(view.dialog.open, true); assert.equal(view.name.input.value, "Rich");
    assert.equal(view.status.textContent, "That name is already used");
    assert.equal(view.submit.disabled, false);
});

test("changing your name prefills only the name and saves to the chosen layer", () => {
    const { view, document, calls } = setup();
    view.open("rename", "layer-one", "Rich");
    assert.equal(view.name.input.value, "Rich");
    assert.equal(document.activeElement, view.name.input);
    assert.equal(view.layerName.input.disabled, true);
    assert.equal(view.code.input.disabled, true);
    assert.equal(view.heading.textContent, "Change your name");
    assert.equal(view.submit.textContent, "Save name");
    view.name.input.value = " Richard ";
    view.form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.deepEqual(calls, [["rename", "layer-one", "Richard"]]);
    view.message("That name is already used");
    assert.equal(view.name.input.value, " Richard ");
    assert.equal(view.dialog.open, true);
    view.cancel.dispatchEvent(new Event("click"));
    assert.equal(view.dialog.open, false);
    assert.equal(calls.length, 1, "cancel does not submit another change");
    view.open("join");
    assert.equal(view.submit.textContent, "Join shared layer");
    assert.match(view.help.textContent, /Everyone with the code/);
});
