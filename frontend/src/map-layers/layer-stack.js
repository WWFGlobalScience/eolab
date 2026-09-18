/**
 * Domain state and invariants for the retained map-layer stack.
 *
 * This module owns active selection, visibility, opacity, and top-first
 * ordering keyed by Catalog identities or explicit local layer identifiers. It performs no publication,
 * DOM, Leaflet, statistics, or styling work.
 */

import { getCatalogItemKey } from "../catalog-item-identity.js";

/**
 * @typedef {Object} MapLayerStackEntry
 * @property {string} key Stable Catalog Item key or local layer identifier.
 * @property {Object|null} item Catalog STAC Item; null for browser-owned layers.
 * @property {string} label Readable layer label.
 * @property {number} retentionOrder Monotonic add-intent order.
 * @property {boolean} visible Whether the layer is attached to the map.
 * @property {number} opacity Ordinary-overlay opacity from zero through one.
 */

/** Own retained map-layer order and cross-entry invariants. */
export class MapLayerStack {
    /** Create an empty stack with no active layer. */
    constructor() {
        /** @type {MapLayerStackEntry[]} */
        this.entries = [];
        /** @type {string|null} */
        this.activeKey = null;
        this.nextRetentionOrder = 1;
    }

    /**
     * Add one unique Item at the top and make it active.
     *
     * A new entry is visible by default. Adding an existing Item is
     * idempotent and merely activates it.
     *
     * @param {Object} item Catalog STAC Item.
     * @param {string} label Readable layer label.
     * @param {number} [retentionOrder=this.nextRetentionOrder] Monotonic
     * add-intent order used to make asynchronous completion deterministic.
     * @return {{entry: MapLayerStackEntry, added: boolean}} Result entry
     * and whether the stack changed.
     */
    add(item, label, retentionOrder = this.nextRetentionOrder) {
        return this.#addEntry(getCatalogItemKey(item), item, label, retentionOrder);
    }

    /**
     * Retain a browser-owned layer without fabricating a Catalog identity.
     * @param {string} key Local identifier beginning with "local:".
     * @param {string} label Readable layer name.
     * @param {number} [retentionOrder=this.nextRetentionOrder] Add-intent order.
     * @return {{entry:MapLayerStackEntry,added:boolean}} Retained entry.
     * @throws {TypeError|Error} If identity, presentation or order is invalid.
     */
    addLocal(key, label, retentionOrder = this.nextRetentionOrder) {
        if (typeof key !== "string" || !key.startsWith("local:") || key.length > 200) {
            throw new TypeError("Local map layers require a local: identifier.");
        }
        return this.#addEntry(key, null, label, retentionOrder);
    }

    /**
     * Insert presentation state for a Catalog or local layer.
     * @param {string} key Stable layer identity.
     * @param {Object|null} item Catalog Item, or null for a local layer.
     * @param {string} label Readable name.
     * @param {number} retentionOrder Monotonic add-intent order.
     * @return {{entry:MapLayerStackEntry,added:boolean}} Retained entry.
     * @throws {TypeError|Error} If presentation or order is invalid.
     */
    #addEntry(key, item, label, retentionOrder) {
        if (typeof label !== "string" || label.length === 0) {
            throw new TypeError("Map layer labels must be non-empty strings.");
        }
        if (!Number.isSafeInteger(retentionOrder) || retentionOrder < 1) {
            throw new TypeError(
                "Map layer retention order must be a positive safe integer."
            );
        }
        const existingEntry = this.get(key);
        if (existingEntry !== null) {
            this.activeKey = key;
            return { entry: existingEntry, added: false };
        }
        if (
            this.entries.some(
                (entry) => entry.retentionOrder === retentionOrder
            )
        ) {
            throw new Error(
                `Map layer retention order is already used: ${retentionOrder}`
            );
        }
        const entry = {
            key,
            item,
            label,
            retentionOrder,
            visible: true,
            opacity: 1,
        };
        const insertionIndex = this.entries.findIndex(
            (candidate) => candidate.retentionOrder < retentionOrder
        );
        if (insertionIndex < 0) {
            this.entries.push(entry);
        } else {
            this.entries.splice(insertionIndex, 0, entry);
        }
        this.nextRetentionOrder = Math.max(
            this.nextRetentionOrder,
            retentionOrder + 1
        );
        this.activeKey = key;
        return { entry, added: true };
    }

    /**
     * Return an entry by stable key.
     *
     * @param {string} key Stable layer key.
     * @return {MapLayerStackEntry|null} Matching entry or null.
     */
    get(key) {
        return this.entries.find((entry) => entry.key === key) ?? null;
    }

    /**
     * Return whether a Catalog Item is retained.
     *
     * @param {Object} item Catalog STAC Item.
     * @return {boolean} Whether its composite identity exists in the stack.
     */
    hasItem(item) {
        return this.get(getCatalogItemKey(item)) !== null;
    }

    /**
     * Select the retained layer presented as active by its owning adapter.
     *
     * @param {string} key Stable layer key.
     * @return {MapLayerStackEntry} Newly active entry.
     * @throws {RangeError} If key is not retained.
     */
    activate(key) {
        const entry = this.#require(key);
        this.activeKey = entry.key;
        return entry;
    }

    /**
     * Change one retained layer's visibility.
     *
     * @param {string} key Stable layer key.
     * @param {boolean} visible Requested visibility.
     * @return {MapLayerStackEntry} Updated entry.
     */
    setVisible(key, visible) {
        if (typeof visible !== "boolean") {
            throw new TypeError("Map layer visibility must be boolean.");
        }
        const entry = this.#require(key);
        entry.visible = visible;
        return entry;
    }

    /**
     * Change ordinary-overlay opacity.
     *
     * @param {string} key Stable layer key.
     * @param {number} opacity Finite opacity from zero through one.
     * @return {MapLayerStackEntry} Updated entry.
     * @throws {RangeError} If opacity is outside its closed interval.
     */
    setOpacity(key, opacity) {
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
            throw new RangeError(
                "Map layer opacity must be from zero through one."
            );
        }
        const entry = this.#require(key);
        entry.opacity = opacity;
        return entry;
    }

    /**
     * Move an entry atomically to one top-first drawing-order index.
     *
     * @param {string} key Stable layer key.
     * @param {number} targetIndex Zero-based top-first destination.
     * @return {boolean} Whether the entry moved.
     * @throws {TypeError} If targetIndex is not an integer.
     * @throws {RangeError} If the key is not retained.
     */
    moveTo(key, targetIndex) {
        if (!Number.isInteger(targetIndex)) {
            throw new TypeError("Map layer positions must be integers.");
        }
        const index = this.entries.findIndex((entry) => entry.key === key);
        if (index < 0) {
            throw new RangeError(`Unknown map layer key: ${key}`);
        }
        if (targetIndex < 0 || targetIndex >= this.entries.length) {
            return false;
        }
        if (targetIndex === index) return false;
        const [entry] = this.entries.splice(index, 1);
        this.entries.splice(targetIndex, 0, entry);
        return true;
    }

    /**
     * Remove one retained layer and choose a deterministic active fallback.
     *
     * @param {string} key Stable layer key.
     * @return {{removed: MapLayerStackEntry, activeKey: string|null}}
     * Removed entry and resulting active key.
     */
    remove(key) {
        const index = this.entries.findIndex((entry) => entry.key === key);
        if (index < 0) {
            throw new RangeError(`Unknown map layer key: ${key}`);
        }
        const [removed] = this.entries.splice(index, 1);
        if (this.activeKey === key) {
            this.activeKey =
                this.entries[index]?.key ??
                this.entries[index - 1]?.key ??
                null;
        }
        return { removed, activeKey: this.activeKey };
    }

    /**
     * Remove every retained entry and active selection.
     *
     * @return {void}
     */
    clear() {
        this.entries.length = 0;
        this.activeKey = null;
        this.nextRetentionOrder = 1;
    }

    /** @return {number} Number of map-attached layers. */
    get visibleCount() {
        return this.entries.filter((entry) => entry.visible).length;
    }

    /**
     * Require one retained entry.
     *
     * @param {string} key Stable layer key.
     * @return {MapLayerStackEntry} Matching entry.
     * @throws {RangeError} If key is not retained.
     */
    #require(key) {
        const entry = this.get(key);
        if (entry === null) {
            throw new RangeError(`Unknown map layer key: ${key}`);
        }
        return entry;
    }
}
