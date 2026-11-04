/** Calculate formulas for selected rasters or one temporal interval through Processing. */
import { labeledRasterSource, rasterSourceKey } from "../raster-source.js";
import { calculationIntent, calculationPixelPoint } from "./calculation-session.js";
import { normalizeCalculationArea } from "./calculation-area.js";
import { describeJobProgress, describeClipArea } from "./presentation.js";

/** Identify calculation inputs independently of display names and raster order.
 * @param {Object[]} sources Selected original sources.
 * @param {Object|null} area Normalized Processing area.
 * @param {Object[]} formulas Named formulas with numeric IDs.
 * @param {Object|null} point Relevant pixel location.
 * @param {Object|null|undefined} temporalSource Temporal interval, or undefined for ordinary rasters.
 * @return {string} Comparable input identity.
 */
function calculationInputKey(sources, area, formulas, point, temporalSource) {
    return JSON.stringify([temporalSource === undefined ? "rasters" : "temporal", temporalSource,
        sources.map(source => [source.key, rasterSourceKey(source)]).sort(), area,
        formulas.map(({id, expression}) => [id, expression.trim()]), point]);
}

/**
 * Calculate up to five formulas over selected rasters or a temporal interval.
 * Ordinary rasters use independent requests; a temporal interval uses one model run.
 * Input changes cancel obsolete work. Submitted calculations continue in the
 * background and recover after reload; display settings never change their inputs.
 */
export class RasterSeriesCalculations {
    /** Initialize independent multi-raster inputs, results and progress tracking.
     * Creating the controller does not create executors, validate formulas or submit calculations.
     * The owning Processing controller supplies sources, formulas and query activation;
     * composition supplies the area. No browser sibling state is read here.
     * @param {Object} options Providers.
     * @param {import("./calculation-requests.js").CalculationRequests} options.requests Independent recoverable requests.
     * @param {import("./api.js").ProcessingApiClient} [options.api] Temporal model discovery and owned CSV reader.
     * @param {Object} [options.clock=globalThis] Debounce timer provider.
     */
    constructor({ requests, api, clock = globalThis }) {
        Object.assign(this, { requests, api, clock });
        this.onChange = () => {};
        this.formulas = [];
        this.sources = [];
        this.area = null;
        this.areaLabel = "";
        this.active = false;
        this.hasCapturedInputs = false;
        this.paused = false;
        this.version = 0;
        this.results = new Map();
        this.previousResults = null;
        this.pending = new Map();
        this.message = "";
        this.busy = false;
        this.clients = new Map();
        this.progress = new Map();
        this.temporalMode = false;
        this.temporalSource = null;
        this.temporalResult = null;
        this.previousTemporalResult = null;
        /** @type {{completed?:number|null,total?:number|null,unit?:string|null}|null} Measured work for the active temporal request. */
        this.temporalWork = null;
        this.resultAbort = null;
    }

    /** Replace the callback that refreshes the plot when calculation state changes.
     * The callback reads this controller's results and progress.
     * Register it when connecting Raster series to this calculation controller.
     * @param {()=>void} onChange Plot refresh callback; no initial notification is sent.
     * @return {void}
     */
    setProgressListener(onChange) { this.onChange = onChange; }

    /** Restore submitted requests and their finished peers after reload.
     * Inputs are restored synchronously before the first server lookup. The UI can
     * then display the captured sources, area and formulas while recovery proceeds.
     * @return {Promise<void>} Initial observation or recovery of saved requests.
     */
    async start() {
        const clients = this.requests.savedClientNames()
            .map(name => [Number(name.split(":")[1]), this.getOrCreateRasterExecutor(Number(name.split(":")[1]))]);
        const retained = clients.filter(([, client]) => {
            const saved = client.snapshot.unfinishedCalculation;
            return !saved.cancelRequested && !saved.context.automatic;
        });
        if (retained.length) {
            const first = retained[0][1].snapshot.unfinishedCalculation;
            const intent = first.calculation;
            this.formulas = intent.calculations.map((formula, index) => ({id: Number(formula.label.slice(5)),
                label: first.context.presentation.names[index], expression: formula.expression}));
            this.sources = retained.filter(([, client]) => client.snapshot.unfinishedCalculation.calculation.kind !== "temporal")
                .map(([, client]) => {
                    const saved = client.snapshot.unfinishedCalculation;
                    return {key: saved.context.presentation.key, label: saved.calculation.source.label, source: saved.calculation.source};
                });
            this.area = intent.area;
            this.areaLabel = describeClipArea(intent.area);
            this.pixelPoint = intent.pixelPoint ?? null;
            this.temporalMode = intent.kind === "temporal";
            this.temporalSource = this.temporalMode ? intent.source : undefined;
            this.inputKey = calculationInputKey(this.sources, this.area, this.formulas, this.pixelPoint, this.temporalSource);
            this.hasCapturedInputs = true;
            this.temporalModel = intent.model;
            for (const [index, client] of retained) {
                const saved = client.snapshot.unfinishedCalculation;
                this.pending.set(index, {key: saved.context.presentation.key, calculationInputs: saved.calculation,
                    submitted: true, phase: "recovering", message: "Recovering calculation…"});
            }
            this.updateSeriesProgress();
        }
        for (const [, client] of clients) if (!retained.some(([, current]) => current === client)) client.stop();
        await Promise.all(clients.map(([, client]) => client.start()));
    }

    /** Get the executor for a raster request position, creating it on first use.
     * Each position retains its own recovery record and waits only for its own
     * previous cancellation. The server decides when calculations execute.
     * @param {number} index Nonnegative integer position.
     * @return {import("./calculation-executor.js").CalculationExecutor} Reusable executor.
     * @throws {TypeError} If the position is not a nonnegative safe integer.
     */
    getOrCreateRasterExecutor(index) {
        if (!this.clients.has(index)) {
            const client = this.requests.createClient("raster-series:" + index,
                state => this.handleCalculationProgress(index, state));
            this.clients.set(index, client);
        }
        return this.clients.get(index);
    }

    /** Replace the selected rasters, area and formulas after a user edit.
     * Changed calculation inputs cancel old work and clear current results; new
     * calculations are scheduled only while the owning query is active. Formula
     * changes wait for editing to pause; committed areas and sources start next turn. Changes to
     * names, raster order or the area label refresh the display without recalculating.
     * Completed results also supply repeated expressions while source, area and
     * relevant point inputs match. Captured jobs and their formula identities stay unchanged.
     * @param {{key:string,label:string,item:{collection:string,id:string}}[]} sources Selected catalog rasters.
     * @param {Object|null} area Map box, filtered catalog selection, uploaded polygon reference,
     * whole-raster descriptor, or null when no area has been chosen.
     * @param {string} label Area description displayed beside the plot.
     * @param {{id:number,label:string,expression:string}[]} formulas Formulas with stable numeric identities.
     * @param {{longitude:number,latitude:number}|null} [pixelPoint=null] Exact committed map click for pixelValue formulas.
     * @param {Object|null} [temporalSource] Catalog interval; null retains temporal mode while inputs are incomplete.
     * @return {void}
     * @throws {TypeError|Error} If the area is not a supported Processing descriptor.
     */
    updateCalculationInputs(sources, area, label, formulas, pixelPoint = null, temporalSource) {
        const normalized = area ? normalizeCalculationArea(area) : null;
        const point = calculationPixelPoint(formulas, pixelPoint);
        const formulaKey = formulas.map(({id,expression}) => [id,expression.trim()]);
        const formulasChanged = JSON.stringify(formulaKey) !==
            JSON.stringify(this.formulas.map(({id,expression}) => [id,expression.trim()]));
        const key = calculationInputKey(sources, normalized, formulas, point, temporalSource);
        const inputsChanged = this.inputKey !== key;
        const capturedResults = this.temporalMode ? [this.temporalResult] : [...this.results.values()];
        const reuseCompleted = this.complete && !this.busy && !this.hasErrors && !this.needsRecovery &&
            calculationInputKey(sources, normalized, [], point, temporalSource) ===
                calculationInputKey(this.sources, this.area, [], this.pixelPoint, this.temporalSource) &&
            formulas.every(({expression}) => capturedResults.every(result =>
                result.calculationInputs.calculations.some(calculation => calculation.expression === expression.trim())));
        this.inputKey = key;
        this.temporalMode = temporalSource !== undefined;
        this.temporalSource = temporalSource;
        this.formulas = formulas.map(formula => ({ ...formula }));
        this.sources = sources.map(source => ({ ...source }));
        this.area = normalized;
        this.areaLabel = label;
        this.pixelPoint = point;
        if (inputsChanged && !reuseCompleted) this.resetResultsForChangedInputs(formulasChanged);
        else this.onChange();
    }

    /** Replace a temporal slice and automatically calculate valid active inputs.
     * @param {Object|null} sourceInterval Catalog variable and UTC interval, or null while incomplete.
     * @param {Object|null} area Shared sampling area or whole raster.
     * @param {string} label Readable sampling-area description.
     * @param {{id:number,label:string,expression:string}[]} formulas Existing Raster stack formulas.
     * @param {{longitude:number,latitude:number}|null} [pixelPoint=null] Clicked point when used by a formula.
     * @return {void}
     */
    updateTemporalInputs(sourceInterval, area, label, formulas, pixelPoint = null) {
        this.updateCalculationInputs([], area, label, formulas, pixelPoint, sourceInterval);
    }

    /** Replace temporal results after an explicit dataset refresh.
     * An active panel recalculates newly admitted observations even when its interval is unchanged.
     * @return {void}
     */
    discardTemporalResults() {
        if (this.temporalMode) this.resetResultsForChangedInputs(false);
    }

    /** Start incomplete inputs when shown and keep submitted work running when hidden.
     * Call when the Raster series panel opens or closes.
     * Cancellation stays paused until inputs change; completed values remain available.
     * @param {boolean} visible Whether the Raster series panel is active.
     * @return {void}
     */
    updateCalculationForPanelVisibility(visible) {
        if (this.active === visible) return;
        this.active = visible;
        if (visible && !this.complete && !this.hasCapturedInputs && !this.paused) this.scheduleRemainingCalculations();
    }

    /** Retain previous values and schedule replacement calculations for changed inputs.
     * Keep completed values separately for the faded previous plot. Cancel pending
     * work so each replacement is validated by its submission endpoint.
     * @param {boolean} debounce Whether changed formulas must wait for editing to pause.
     * @return {void}
     */
    resetResultsForChangedInputs(debounce) {
        if (this.results.size) this.previousResults = new Map(this.results);
        if (this.temporalResult) this.previousTemporalResult = this.temporalResult;
        this.temporalResult = null;
        this.cancelRemainingRasters();
        this.results = new Map();
        this.complete = false;
        if (this.active) this.scheduleRemainingCalculations(debounce || this.temporalMode);
        else this.onChange();
    }

    /** Stop unfinished work after cancellation or input replacement.
     * Cancel the debounce timer, ignore late responses, and ask
     * Processing to cancel all of this series' submitted jobs. Completed results
     * remain available; executors retain jobs still needing cancellation recovery.
     * @param {boolean} [pause=false] User cancellation waits for another input edit before restarting.
     * @return {void} Cancellation is requested here and acknowledged asynchronously.
     */
    cancelRemainingRasters(pause = false) {
        this.hasCapturedInputs = false;
        this.paused = pause;
        this.version++;
        this.clock.clearTimeout(this.timer);
        this.resultAbort?.abort();
        this.dispatching = false;
        this.pending.clear();
        this.temporalWork = null;
        this.progress.clear();
        this.busy = false;
        for (const client of this.clients.values()) client.stop();
        this.message = "Calculation cancelled. Change inputs to start again.";
        this.onChange();
    }

    /** Coalesce committed inputs on the next turn, or wait 700 ms for formula edits.
     * Used after input changes or reopening an unfinished area plot. Replacing the
     * timer preserves cancellation before dispatch and includes server formula validation.
     * @param {boolean} [debounce=false] Whether changed formulas require an editing pause.
     * @return {void}
     */
    scheduleRemainingCalculations(debounce = false) {
        this.clock.clearTimeout(this.timer);
        this.paused = false;
        this.message = debounce ? "Waiting for edits to finish…" : "Submitting calculations…";
        this.busy = true;
        this.timer = this.clock.setTimeout(() => void this.calculateRemainingRasters(false), debounce ? 700 : 0);
        this.onChange();
    }

    /** Calculate a temporal interval or submit all unfinished ordinary rasters.
     * An explicit retry replaces failed rows. Active requests
     * continue unchanged; uncertain submissions require Recover first.
     * @param {boolean} [retryFailures=true] Retry failed rows when explicitly requested.
     * @return {void} Request dispatch, not calculation completion.
     */
    calculateRemainingRasters(retryFailures = true) {
        this.clock.clearTimeout(this.timer);
        if (!this.active || this.dispatching) return;
        this.paused = false;
        if (this.temporalMode) { void this.calculateTemporalInterval(); return; }
        if (!this.sources.length || !this.area) {
            this.busy = false;
            this.message = !this.area ? "Choose an area or click the map to calculate." : "Select at least one raster.";
            this.onChange(); return;
        }
        if (!this.pixelPoint && this.formulas.some(({expression}) => /\bpixelValue\s*\(/.test(expression))) {
            this.busy = false;
            this.message = "Click the map to choose a pixel for pixelValue(a).";
            this.onChange(); return;
        }
        const version = this.version;
        this.hasCapturedInputs = true;
        if (retryFailures) {
            for (const [key, result] of this.results) if (result.error) this.results.delete(key);
        }
        this.busy = this.dispatching = true;
        try {
            const formulas = this.formulas.map(formula => ({ label: "stat-" + formula.id, expression: formula.expression.trim() }));
            const firstCalculationInputs = calculationIntent({ source: this.getRasterReference(this.sources[0]), area: this.area,
                calculations: formulas, pixelPoint: this.pixelPoint });
            // Record all identities before submission can synchronously notify listeners.
            const additions = [];
            for (const source of this.sources) {
                if (this.results.has(source.key) || [...this.pending.values()].some(request => request.key === source.key)) continue;
                const index = this.sources.map(source => source.key).sort().indexOf(source.key);
                const client = this.getOrCreateRasterExecutor(index);
                const request = { key: source.key, calculationInputs: calculationIntent({ ...firstCalculationInputs, source: this.getRasterReference(source) }),
                    submitted: true, previousJobId: client.snapshot.completedJob?.jobId,
                    phase: "submitting", message: "Submitting calculation…" };
                this.pending.set(index, request);
                additions.push([client, request]);
            }
            for (const [client, request] of additions) {
                if (version !== this.version) return;
                client.submit(request.calculationInputs, {automatic: false,
                    presentation: {key: request.key, names: this.formulas.map(formula => formula.label)}});
            }
            this.dispatching = false;
            this.updateSeriesProgress();
        } catch (error) {
            if (version !== this.version || error.name === "AbortError") return;
            this.message = error.message; this.busy = this.dispatching = false; this.onChange();
        }
    }

    /** Submit one temporal model run through the existing recoverable executor.
     * Model discovery occurs once per controller; retries retain the captured identity.
     * @return {Promise<void>} Submission dispatch or a visible input/discovery failure.
     */
    async calculateTemporalInterval() {
        if (this.pending.size || this.temporalResult || this.needsRecovery) { this.updateSeriesProgress(); return; }
        const unreadResult = this.results.get("temporal");
        if (unreadResult?.job) {
            this.hasCapturedInputs = true;
            const request = {...unreadResult, key: "temporal", submitted: true, phase: "reading", message: "Reading calculated observations…"};
            this.pending.set(0, request);
            this.updateSeriesProgress();
            await this.readTemporalResult(0, request, unreadResult.job);
            return;
        }
        if (!this.temporalSource || !this.area) {
            this.busy = false;
            this.message = !this.temporalSource ? "Choose a dataset, variable and period." : "Choose an area or click the map to calculate.";
            this.onChange(); return;
        }
        if (!this.pixelPoint && this.formulas.some(({expression}) => /\bpixelValue\s*\(/.test(expression))) {
            this.busy = false;
            this.message = "Click the map to choose a pixel for pixelValue(a)."; this.onChange(); return;
        }
        const version = this.version;
        this.hasCapturedInputs = true;
        this.results.delete("temporal");
        this.busy = this.dispatching = true;
        this.message = "Submitting temporal calculation…"; this.onChange();
        try {
            this.temporalModel ??= (await this.api.discoverModels()).find(model => model.id === "temporal-raster-stack");
            if (version !== this.version) return;
            if (!this.temporalModel) throw new Error("Temporal Raster stack is not installed on this server.");
            const calculationInputs = calculationIntent({kind: "temporal", model: this.temporalModel,
                source: this.temporalSource, area: this.area, pixelPoint: this.pixelPoint,
                calculations: this.formulas.map(formula => ({label: "stat-" + formula.id, expression: formula.expression.trim()})),
                utcOffsetMinutes: -new Date().getTimezoneOffset()});
            const client = this.getOrCreateRasterExecutor(0);
            this.pending.set(0, {key: "temporal", calculationInputs, submitted: true,
                previousJobId: client.snapshot.completedJob?.jobId, phase: "submitting", message: "Submitting temporal calculation…"});
            client.submit(calculationInputs, {automatic: false,
                presentation: {key: "temporal", names: this.formulas.map(formula => formula.label)}});
            this.dispatching = false;
            this.updateSeriesProgress();
        } catch (error) {
            if (version !== this.version || error.name === "AbortError") return;
            this.message = error.message; this.busy = this.dispatching = false; this.onChange();
        }
    }

    /** Capture the original raster reference and label for one calculation.
     * Called while building calculation requests.
     * @param {Object} source Selected raster snapshot with its original reference.
     * @return {Readonly<Object>} Labeled raster reference accepted by Processing.
     * @throws {TypeError} If the source identity or label is invalid.
     */
    getRasterReference(source) {
        return labeledRasterSource(source, source.label);
    }

    /** Apply progress only to this executor's current immutable raster request.
     * Failures leave gaps while peers continue.
     * @param {number} index Executor position.
     * @param {import("./calculation-executor.js").CalculationExecutionSnapshot} state Execution progress.
     * @return {void}
     */
    handleCalculationProgress(index, state) {
        const request = this.pending.get(index);
        if (!request) { this.onChange(); return; }
        /** Check that a result belongs to the calculation currently at this position.
         * @param {Object|null} calculationInputs Raster, area and formulas accompanying a result.
         * @return {boolean} True when all inputs match the current request.
         */
        const matchesCalculationInputs = calculationInputs => JSON.stringify(calculationInputs) === JSON.stringify(request.calculationInputs);
        if (state.completedJob && matchesCalculationInputs(state.completedCalculation) && request.submitted &&
            state.completedJob.jobId !== request.previousJobId && !state.unfinishedCalculation && state.isIdle) {
            if (request.calculationInputs.kind === "temporal") {
                if (request.phase !== "reading") {
                    request.work = null;
                    request.phase = "reading"; request.message = "Reading calculated observations…";
                    void this.readTemporalResult(index, request, state.completedJob);
                }
                this.updateSeriesProgress(); return;
            }
            this.results.set(request.key, { job: state.completedJob, calculationInputs: request.calculationInputs });
            this.pending.delete(index);
        } else if (state.recoverable) {
            request.phase = "recovery"; request.message = state.message;
        } else if (state.admission === "retry" || (request.submitted && state.isIdle && !state.unfinishedCalculation)) {
            this.results.set(request.key, { calculationInputs: request.calculationInputs, error: state.message || "No result returned." });
            this.pending.delete(index);
        } else {
            request.phase = state.phase;
            request.message = state.currentJob ? describeJobProgress(state.currentJob) : state.message;
            request.work = state.phase === "cancelling" ? null : state.currentJob?.progress ?? null;
        }
        this.updateSeriesProgress();
    }

    /** Load one completed temporal CSV, discarding replies after input replacement or cancellation.
     * @param {number} index Executor holding this request.
     * @param {Object} request Captured inputs and current request identity.
     * @param {Object} job Completed owned model run.
     * @return {Promise<void>} Result rows or a visible download error.
     */
    async readTemporalResult(index, request, job) {
        const abort = this.resultAbort = new AbortController();
        try {
            const result = await this.api.readTemporalStackRows(job, abort.signal);
            if (this.pending.get(index) !== request) return;
            this.temporalResult = {job, calculationInputs: request.calculationInputs, ...result};
            this.results.delete("temporal");
            this.pending.delete(index);
        } catch (error) {
            if (this.pending.get(index) !== request || error.name === "AbortError") return;
            this.results.set(request.key, {job, calculationInputs: request.calculationInputs, error: error.message});
            this.pending.delete(index);
        }
        this.updateSeriesProgress();
    }

    /** Update per-raster progress and whole-series status.
     * Read pending requests and finished results to set busy and completion flags and the overall message, then notify the plot listener.
     * This method uses existing state; it does not request server updates.
     * @return {void}
     */
    updateSeriesProgress() {
        this.temporalWork = this.temporalMode ? [...this.pending.values()][0]?.work ?? null : null;
        this.progress = new Map([...this.pending.values()].map(request => [request.key, { phase: request.phase, message: request.message }]));
        this.busy = this.dispatching || [...this.pending.values()].some(request => request.phase !== "recovery");
        this.complete = this.temporalMode ? !!this.temporalResult : !!this.sources.length && this.results.size === this.sources.length;
        if (this.temporalMode) {
            this.message = this.complete ? `${this.temporalResult.observations.length} observations calculated.`
                : this.needsRecovery ? "Recover the interrupted request to confirm or cancel the same job."
                : this.pending.size ? [...this.pending.values()][0].message
                : this.results.get("temporal")?.error ?? "Choose a dataset, variable, period and area.";
            this.onChange(); return;
        }
        if (this.complete) {
            this.message = this.commonError || (this.hasErrors ? "Some rasters failed. Retry failed rasters to try again." : "Raster series complete.");
        } else if (this.needsRecovery) {
            this.message = "Recover interrupted requests to confirm or cancel the same jobs safely. Other rasters can continue.";
        } else this.message = this.busy ? "Calculating rasters; results appear as each finishes." : "Choose rasters and a sample area.";
        this.onChange();
    }

    /** Check whether any raster has a failed result. @return {boolean} True if at least one result contains an error. */
    get hasErrors() { return [...this.results.values()].some(result => result.error); }

    /** Show an identical failure for the entire stack once, above the results.
     * @return {string} Shared error only when every selected raster failed identically.
     */
    get commonError() {
        if (!this.complete) return "";
        const errors = [...this.results.values()].map(result => result.error);
        return errors[0] && errors.every(error => error === errors[0]) ? errors[0] : "";
    }

    /** Whether a current or cancelled submission needs safe recovery. @return {boolean} */
    get needsRecovery() { return [...this.clients.values()].some(client => client.snapshot.recoverable); }

    /** Retry unresolved submissions with their original request keys.
     * @return {Promise<void>} Retry attempts; recovered jobs may still be running.
     */
    async retryInterruptedCalculations() {
        await Promise.all([...this.clients.values()].filter(client => client.snapshot.recoverable).map(client => client.retry()));
        if (this.active && !this.paused && !this.complete && !this.pending.size && !this.needsRecovery) this.scheduleRemainingCalculations();
        else this.updateSeriesProgress();
    }

    /** Detach observers, preserving unfinished submissions for recovery after reload.
     * @return {void}
     */
    destroy() {
        this.clock.clearTimeout(this.timer);
        this.resultAbort?.abort();
        for (const client of this.clients.values()) client.destroy();
    }
}
