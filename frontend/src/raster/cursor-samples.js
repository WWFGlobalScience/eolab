/**
 * Debounced, bounded raster-stack sampling for one transient cursor position.
 *
 * This controller receives an already ordered set of Catalog participants. It
 * owns dwell timing, a fixed worker pool, cancellation, stale-result rejection,
 * and immutable progressive snapshots. Map-layer policy,
 * Leaflet, DOM presentation, rendering, and GeoServer remain outside it.
 */
import { isCanonicalWgs84Position } from "./geometry.js";

export const RASTER_CURSOR_SAMPLE_DEBOUNCE_MILLISECONDS = 200;
export const MAXIMUM_RASTER_CURSOR_SAMPLE_PARTICIPANTS = 50;
export const RASTER_CURSOR_SAMPLE_CONCURRENCY = 2;

/**
 * @typedef {Object} RasterCursorSampleParticipant
 * @property {string} key Stable Catalog or retained-session identity.
 * @property {string} label Concise raster label prepared by the owner.
 * @property {Object} item Catalog raster Item passed to the analysis client.
 */

/**
 * Validate and copy one ordered cursor participant list.
 *
 * The controller applies its server-owned-style fixed participant ceiling; the
 * caller cannot expand it through a UI or request parameter.
 *
 * @param {RasterCursorSampleParticipant[]} participants Ordered candidates.
 * @return {{participants:RasterCursorSampleParticipant[],omittedCount:number}}
 * Bounded participants and the number omitted below the fixed ceiling.
 */
function normalizeParticipants(participants) {
    if (!Array.isArray(participants)) {
        throw new TypeError("Raster cursor participants must be an array");
    }
    const keys = new Set();
    const normalized = participants.map((participant) => {
        if (
            participant === null ||
            typeof participant !== "object" ||
            typeof participant.key !== "string" ||
            participant.key === "" ||
            typeof participant.label !== "string" ||
            participant.label === "" ||
            participant.item === null ||
            typeof participant.item !== "object"
        ) {
            throw new TypeError("Raster cursor sample participant is invalid");
        }
        if (keys.has(participant.key)) {
            throw new TypeError("Raster cursor participants must be distinct");
        }
        keys.add(participant.key);
        return { ...participant };
    });
    return {
        participants: normalized.slice(
            0,
            MAXIMUM_RASTER_CURSOR_SAMPLE_PARTICIPANTS
        ),
        omittedCount: Math.max(
            0,
            normalized.length - MAXIMUM_RASTER_CURSOR_SAMPLE_PARTICIPANTS
        ),
    };
}

/**
 * Normalize one pixel response to the cursor-result state union.
 *
 * @param {unknown} pixel Candidate Catalog pixel response.
 * @return {{state:"value"|"nodata"|"outside",value:number|null,errorMessage:string}}
 * Presentation-neutral result fields.
 */
function normalizePixel(pixel) {
    if (
        pixel === null ||
        typeof pixel !== "object" ||
        typeof pixel.inBounds !== "boolean"
    ) {
        throw new TypeError("Raster cursor sample response is invalid");
    }
    if (!pixel.inBounds) {
        return { state: "outside", value: null, errorMessage: "" };
    }
    if (pixel.value === null) {
        return { state: "nodata", value: null, errorMessage: "" };
    }
    if (!Number.isFinite(pixel.value)) {
        throw new TypeError("Raster cursor value must be finite or null");
    }
    return { state: "value", value: pixel.value, errorMessage: "" };
}

/** Own one ephemeral cursor stack operation at a time. */
export class RasterCursorSamplesController {
    /**
     * Create a cursor sampler around the existing Catalog pixel client.
     *
     * @param {(item:Object,position:Object,signal:AbortSignal)=>Promise<Object>}
     * samplePoint Catalog-authorized pixel client.
     * @param {(snapshot:Object|null)=>void} onChange Immutable snapshot observer.
     * @param {{setTimeout:Function,clearTimeout:Function}} [clock=globalThis]
     * Injectable timer boundary.
     */
    constructor(samplePoint, onChange, clock = globalThis) {
        if (
            typeof samplePoint !== "function" ||
            typeof onChange !== "function" ||
            typeof clock?.setTimeout !== "function" ||
            typeof clock?.clearTimeout !== "function"
        ) {
            throw new TypeError("Raster cursor collaborators are incomplete");
        }
        this.samplePoint = samplePoint;
        this.onChange = onChange;
        this.clock = clock;
        this.abortController = null;
        this.generation = 0;
        this.omittedCount = 0;
        this.participants = [];
        this.position = null;
        this.results = [];
        this.timeoutId = null;
    }

    /**
     * Retain only the latest pointer position and sample it after one dwell.
     * Keep the previous presentation available until replacement sampling starts
     * or an empty participant set settles. The view owns the visual handoff.
     *
     * @param {RasterCursorSampleParticipant[]} participants Visible
     * rasters in top-first map order.
     * @param {{longitude:number,latitude:number}} position Canonical WGS 84 point.
     * @return {void}
     */
    move(participants, position) {
        const normalized = normalizeParticipants(participants);
        if (!isCanonicalWgs84Position(position)) {
            throw new TypeError("Raster cursor position must be canonical WGS 84");
        }
        this.#cancelWork();
        this.position = Object.freeze({ ...position });
        this.participants = normalized.participants;
        this.omittedCount = normalized.omittedCount;
        this.results = [];
        const generation = this.generation;
        this.timeoutId = this.clock.setTimeout(() => {
            this.timeoutId = null;
            this.#start(generation);
        }, RASTER_CURSOR_SAMPLE_DEBOUNCE_MILLISECONDS);
    }

    /**
     * Reapply current map participation at the retained pointer position.
     * Changed order, visibility, or membership restarts the bounded dwell.
     *
     * @param {RasterCursorSampleParticipant[]} participants Current candidates.
     * @return {void}
     */
    synchronize(participants) {
        if (this.position === null) {
            return;
        }
        const normalized = normalizeParticipants(participants);
        const sameParticipants =
            normalized.omittedCount === this.omittedCount &&
            normalized.participants.length === this.participants.length &&
            normalized.participants.every(
                (participant, index) =>
                    participant.key === this.participants[index].key &&
                    participant.label === this.participants[index].label
            );
        if (!sameParticipants) {
            const position = this.position;
            this.clear();
            this.move(participants, position);
        }
    }

    /** Cancel queued/in-flight work and remove the readout. @return {void} */
    clear() {
        const hadPresentation = this.position !== null;
        this.#cancelWork();
        this.omittedCount = 0;
        this.participants = [];
        this.position = null;
        this.results = [];
        if (hadPresentation) {
            this.onChange(null);
        }
    }

    /**
     * Start no more than the fixed worker count after the pointer dwell.
     *
     * @param {number} generation Current operation generation.
     * @return {void}
     */
    #start(generation) {
        if (generation !== this.generation || this.position === null) {
            return;
        }
        if (this.participants.length === 0) {
            this.clear();
            return;
        }
        this.results = this.participants.map((participant) => ({
            key: participant.key,
            label: participant.label,
            state: "loading",
            value: null,
            errorMessage: "",
        }));
        const abortController = new AbortController();
        this.abortController = abortController;
        this.#emit();
        const workerCount = Math.min(
            RASTER_CURSOR_SAMPLE_CONCURRENCY,
            this.participants.length
        );
        const queue = { nextIndex: 0 };
        for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
            void this.#runWorker(queue, generation, abortController);
        }
    }

    /**
     * Resolve queued participants serially within one fixed worker slot.
     *
     * @param {{nextIndex:number}} queue Shared operation queue cursor.
     * @param {number} generation Current operation generation.
     * @param {AbortController} abortController Shared cancellation owner.
     * @return {Promise<void>}
     */
    async #runWorker(queue, generation, abortController) {
        while (
            generation === this.generation &&
            !abortController.signal.aborted &&
            queue.nextIndex < this.participants.length
        ) {
            const index = queue.nextIndex;
            queue.nextIndex += 1;
            const participant = this.participants[index];
            try {
                const pixel = await this.samplePoint(
                    participant.item,
                    this.position,
                    abortController.signal
                );
                if (generation !== this.generation) {
                    return;
                }
                this.results[index] = {
                    ...this.results[index],
                    ...normalizePixel(pixel),
                };
            } catch (error) {
                if (
                    generation !== this.generation ||
                    error?.name === "AbortError"
                ) {
                    return;
                }
                this.results[index] = {
                    ...this.results[index],
                    state: "error",
                    value: null,
                    errorMessage: error instanceof Error && error.message !== ""
                        ? error.message
                        : "Raster value request failed.",
                };
            }
            this.#emit();
        }
        if (
            generation === this.generation &&
            this.results.every((result) => result.state !== "loading")
        ) {
            this.abortController = null;
        }
    }

    /** Invalidate timers, queued work, and active fetches. */
    #cancelWork() {
        this.generation += 1;
        if (this.timeoutId !== null) {
            this.clock.clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.abortController?.abort();
        this.abortController = null;
    }

    /** Publish a deeply immutable, presentation-neutral snapshot. */
    #emit() {
        this.onChange(Object.freeze({
            position: this.position,
            omittedCount: this.omittedCount,
            samples: Object.freeze(this.results.map(
                (result) => Object.freeze({ ...result })
            )),
        }));
    }
}
