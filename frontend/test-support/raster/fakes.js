/**
 * Build isolated resize-observer doubles for chart lifecycle tests.
 * @return {Object} Observer constructor and created instances.
 */
export function createFakeResizeObservers() {
  const instances = [];
  class ResizeObserver {
    /** Retain the browser callback without automatically measuring layout. */
    constructor(callback) { this.callback = callback; this.disconnected = false; instances.push(this); }
    /** Track the observed SVG. @param {Object} target Chart element. */
    observe(target) { this.target = target; }
    /** Record teardown; tests can still simulate a stale queued callback. */
    disconnect() { this.disconnected = true; }
    /** Deliver one synthetic measured content width. @param {number} width CSS pixels. */
    resize(width) { this.callback([{ target: this.target, contentRect: { width } }]); }
  }
  return { ResizeObserver, instances };
}

/**
 * Build a Leaflet-compatible event map for controller tests.
 *
 * @param {{lng:number,lat:number}} [center] Initial map center.
 * @return {Object} Map fake with event and layer bookkeeping.
 */
export function createFakeLeafletMap(center = { lng: 0, lat: 0 }) {
  const handlers = new Map();
  return {
    center,
    layers: [],
    removedLayers: [],
    on(eventName, handler) {
      const eventHandlers = handlers.get(eventName) ?? new Set();
      eventHandlers.add(handler);
      handlers.set(eventName, eventHandlers);
    },
    off(eventName, handler) {
      handlers.get(eventName)?.delete(handler);
    },
    emit(eventName, event = {}) {
      for (const handler of handlers.get(eventName) ?? []) {
        handler(event);
      }
    },
    getCenter() {
      return this.center;
    },
    removeLayer(layer) {
      this.removedLayers.push(layer);
      this.layers = this.layers.filter((candidate) => candidate !== layer);
    },
    listenerCount(eventName) {
      return handlers.get(eventName)?.size ?? 0;
    },
  };
}

/**
 * Build a rectangle factory that records created preview/selection layers.
 *
 * @param {Array<Object>} createdLayers Destination for created layer fakes.
 * @return {Function} Leaflet-compatible rectangle factory.
 */
export function createFakeSampleLayerFactory(createdLayers) {
  return (bounds, kind) => {
    const layer = {
      kind,
      boundsHistory: [bounds],
      addTo(map) {
        map.layers.push(this);
        return this;
      },
      setBounds(nextBounds) {
        this.boundsHistory.push(nextBounds);
      },
    };
    createdLayers.push(layer);
    return layer;
  };
}

/**
 * Build a deterministic setTimeout clock for asynchronous controller tests.
 *
 * @return {Object} Injectable clock with explicit time advancement.
 */
export function createFakeClock() {
  return {
    time: 0,
    nextTimerId: 1,
    timers: new Map(),
    setTimeout(callback, delay) {
      const timerId = this.nextTimerId++;
      this.timers.set(timerId, { callback, at: this.time + delay });
      return timerId;
    },
    clearTimeout(timerId) {
      this.timers.delete(timerId);
    },
    advanceTo(time) {
      this.time = time;
      for (const [timerId, timer] of this.timers) {
        if (timer.at <= time) {
          this.timers.delete(timerId);
          timer.callback();
        }
      }
    },
  };
}
