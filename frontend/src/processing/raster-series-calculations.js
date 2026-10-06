/** Calculate the same area statistics for each raster selected in Raster series. */
import { calculationIntent } from "./calculation-session.js";
import { normalizeCalculationArea } from "./calculation-area.js";
import { performanceDescription } from "./calculation-performance.js";
import { describeJobProgress } from "./presentation.js";

/**
 * Calculate up to five formulas over one shared area for each selected raster.
 * Requests run independently through Processing's server queue. This
 * controller keeps per-raster results, pauses for recovery, and
 * cancels obsolete work when the inputs change or area statistics is hidden.
 */
export class RasterSeriesCalculations {
    /** Initialize raster-series inputs, results and progress tracking.
     * Creating the controller does not create executors, validate formulas or submit calculations.
     * Composition supplies the area; the Raster series controller supplies selected
     * rasters, formulas and visibility before work can begin.
     * @param {Object} options Providers.
     * @param {import("./calculation-requests.js").CalculationRequests} options.requests Independent recoverable requests.
     * @param {Object} [options.clock=globalThis] Debounce timer provider.
     * @param {()=>number} [options.now] Monotonic browser clock in milliseconds.
     */
    constructor({ requests, clock = globalThis, now = () => performance.now() }) {
        Object.assign(this, { requests, clock, now });
        this.onChange = () => {};
        this.formulas = [];
        this.sources = [];
        this.area = null;
        this.areaLabel = "";
        this.active = false;
        this.version = 0;
        this.results = new Map();
        this.previousResults = null;
        this.pending = new Map();
        this.message = "";
        this.busy = false;
        this.clients = new Map();
        this.progress = new Map();
    }

    /** Replace the callback that refreshes the plot when calculation state changes.
     * The callback reads this controller's results and progress.
     * Register it when connecting Raster series to this calculation controller.
     * @param {()=>void} onChange Plot refresh callback; no initial notification is sent.
     * @return {void}
     */
    setProgressListener(onChange) { this.onChange = onChange; }

    /** Recover every series calculation saved before reload and request cancellation.
     * Call once during browser startup. The remaining raster list is not saved, so
     * that old series must not resume automatically. If its submission response was
     * lost, the executor recovers the job with the original request key before cancelling.
     * @return {Promise<void>} Initial recovery attempt; cancellation may finish later
     * through the shared job observer.
     */
    async recoverAndCancelPreviousSeriesCalculations() {
        const clients = this.requests.savedClientNames().filter(name => name.startsWith("raster-series:"))
            .map(name => this.getOrCreateRasterExecutor(Number(name.split(":")[1])));
        for (const client of clients) client.stop();
        await Promise.all(clients.map(client => client.start()));
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
     * calculations are scheduled only while area statistics is visible. Formula
     * changes wait for editing to pause; committed areas and sources start next turn. Changes to
     * names, raster order or the area label refresh the display without recalculating.
     * @param {{key:string,label:string,item:{collection:string,id:string}}[]} sources Selected catalog rasters.
     * @param {Object|null} area Map box, filtered catalog selection, uploaded polygon reference,
     * whole-raster descriptor, or null when no area has been chosen.
     * @param {string} label Area description displayed beside the plot.
     * @param {{id:number,label:string,expression:string}[]} formulas Selected formulas and display names.
     * @return {void}
     * @throws {TypeError|Error} If the area is not a supported Processing descriptor.
     */
    updateCalculationInputs(sources, area, label, formulas) {
        const normalized = area ? normalizeCalculationArea(area) : null;
        const formulaKey = formulas.map(({id,expression}) => [id,expression.trim()]);
        const formulasChanged = JSON.stringify(formulaKey) !==
            JSON.stringify(this.formulas.map(({id,expression}) => [id,expression.trim()]));
        const key = JSON.stringify([sources.map(source => [source.key, source.item.collection, source.item.id]).sort(),
            normalized, formulaKey]);
        this.formulas = formulas.map(formula => ({ ...formula }));
        this.sources = sources.map(source => ({ ...source }));
        this.area = normalized;
        this.areaLabel = label;
        if (this.inputKey !== key) { this.inputKey = key; this.resetResultsForChangedInputs(formulasChanged); }
        else this.onChange();
    }

    /** Schedule missing results when area statistics becomes visible; cancel unfinished work when hidden.
     * Call when the Raster series panel opens/closes or switches pixel/area mode.
     * Completed results remain available when the user returns to this mode.
     * @param {boolean} visible True only when both the panel and its area-statistics mode are active.
     * @return {void}
     */
    updateCalculationForPanelVisibility(visible) {
        if (this.active === visible) return;
        this.active = visible;
        if (!visible && (this.busy || this.pending.size)) this.cancelRemainingRasters();
        else if (visible && !this.complete) this.scheduleRemainingCalculations();
    }

    /** Clear results after a calculation input changes and schedule replacements when visible.
     * Keep completed values separately for the faded previous plot. Cancel pending
     * work so each replacement is validated by its submission endpoint.
     * @param {boolean} debounce Whether changed formulas must wait for editing to pause.
     * @return {void}
     */
    resetResultsForChangedInputs(debounce) {
        if (this.results.size) this.previousResults = new Map(this.results);
        this.cancelRemainingRasters();
        this.results = new Map();
        this.complete = false;
        this.startedAt = null;
        this.elapsedSeconds = null;
        if (this.active) this.scheduleRemainingCalculations(debounce);
        else this.onChange();
    }

    /** Stop the unfinished series after cancellation, input replacement or hiding the plot.
     * Cancel the debounce timer, ignore late responses, and ask
     * Processing to cancel all of this series' submitted jobs. Completed results
     * remain available; executors retain jobs still needing cancellation recovery.
     * @return {void} Cancellation is requested here and acknowledged asynchronously.
     */
    cancelRemainingRasters() {
        this.version++;
        this.clock.clearTimeout(this.timer);
        this.dispatching = false;
        this.pending.clear();
        this.progress.clear();
        this.busy = false;
        for (const client of this.clients.values()) client.stop();
        this.message = "Calculation stopped. Calculate to continue.";
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
        this.startedAt ??= this.now();
        this.message = debounce ? "Waiting for edits to finish…" : "Submitting calculations…";
        this.busy = true;
        this.timer = this.clock.setTimeout(() => void this.calculateRemainingRasters(false), debounce ? 700 : 0);
        this.onChange();
    }

    /** Submit all unfinished rasters directly; the server validates each request.
     * Calculate retries failed rows. Active requests
     * continue unchanged; uncertain submissions require Recover first.
     * @param {boolean} [retryFailures=true] Retry failed rows when explicitly requested.
     * @return {void} Request dispatch, not calculation completion.
     */
    calculateRemainingRasters(retryFailures = true) {
        this.clock.clearTimeout(this.timer);
        if (!this.active || this.dispatching) return;
        if (!this.sources.length || !this.area) {
            this.busy = false;
            this.message = !this.area ? "Choose an area or click the map to calculate." : "Select at least one raster.";
            this.onChange(); return;
        }
        const version = this.version;
        this.startedAt ??= this.now();
        if (retryFailures) {
            for (const [key, result] of this.results) if (result.error) this.results.delete(key);
        }
        this.busy = this.dispatching = true;
        try {
            const formulas = this.formulas.map(formula => ({ label: "stat-" + formula.id, expression: formula.expression.trim() }));
            const firstCalculationInputs = calculationIntent({ source: this.getRasterReference(this.sources[0]), area: this.area, calculations: formulas });
            // Record all identities before submission can synchronously notify listeners.
            const additions = [];
            for (const source of this.sources) {
                if (this.results.has(source.key) || [...this.pending.values()].some(request => request.key === source.key)) continue;
                let index = 0;
                while (this.pending.has(index)) index++;
                const client = this.getOrCreateRasterExecutor(index);
                const request = { key: source.key, calculationInputs: calculationIntent({ ...firstCalculationInputs, source: this.getRasterReference(source) }),
                    startedAt: this.now(), submitted: true, previousJobId: client.snapshot.completedJob?.jobId,
                    phase: "submitting", message: "Submitting calculation…" };
                this.pending.set(index, request);
                additions.push([client, request]);
            }
            for (const [client, request] of additions) {
                if (version !== this.version || !this.active) return;
                client.submit(request.calculationInputs, {automatic: true, client: "raster-series"});
            }
            this.dispatching = false;
            this.updateSeriesProgress();
        } catch (error) {
            if (version !== this.version || error.name === "AbortError") return;
            this.message = error.message; this.busy = this.dispatching = false; this.onChange();
        }
    }

    /** Read the catalog IDs and display name used to request one raster calculation.
     * Called while building calculation requests.
     * @param {{label:string,item:{collection:string,id:string}}} source Selected catalog raster.
     * @return {{collectionId:string,itemId:string,label:string}} Raster reference accepted by Processing.
     */
    getRasterReference(source) {
        return { collectionId: source.item.collection, itemId: source.item.id, label: source.label };
    }

    /** Apply progress only to this executor's current immutable raster request.
     * Failures leave gaps while peers continue.
     * Completed results include browser timing stages when the executor recorded
     * the full request. The timer stops here, before the view renders the result.
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
            const receivedAt = this.now();
            const elapsedSeconds = (receivedAt - request.startedAt) / 1000;
            const trace = state.completedTimings;
            let stages;
            if (trace && [trace.submissionStartedAtMs, trace.submissionFinishedAtMs].every(Number.isFinite)) {
                stages = {beforeSubmissionSeconds: (trace.submissionStartedAtMs-request.startedAt)/1000,
                    submissionSeconds: (trace.submissionFinishedAtMs-trace.submissionStartedAtMs)/1000,
                    afterSubmissionSeconds: (receivedAt-trace.submissionFinishedAtMs)/1000,
                    delivery: {...trace, controllerReceivedAtMs: receivedAt}};
            }
            this.results.set(request.key, { job: state.completedJob, calculationInputs: request.calculationInputs, elapsedSeconds,
                performanceLines: performanceDescription(state.completedJob, elapsedSeconds, stages,
                    "Measured in this tab from submitting this raster calculation until its completed result reaches the series controller, including validation, preparation, queueing, submission and result delivery (notifications or polling). Excludes earlier area selection, formula debounce, and subsequent UI rendering.") });
            this.pending.delete(index);
        } else if (state.recoverable) {
            request.phase = "recovery"; request.message = state.message;
        } else if (state.admission === "retry" || (request.submitted && state.isIdle && !state.unfinishedCalculation)) {
            this.results.set(request.key, { calculationInputs: request.calculationInputs, error: state.message || "No result returned." });
            this.pending.delete(index);
        } else {
            request.phase = state.phase;
            request.message = state.currentJob ? describeJobProgress(state.currentJob) : state.message;
        }
        this.updateSeriesProgress();
    }

    /** Update per-raster progress, whole-series status and the final elapsed time.
     * Read pending requests and finished results to set busy and completion flags and the overall message, then notify the plot listener.
     * When every raster has a result or error, record time since the series was
     * requested, including debounce, submission validation and recovery pauses.
     * This method uses existing state; it does not request server updates.
     * @return {void}
     */
    updateSeriesProgress() {
        this.progress = new Map([...this.pending.values()].map(request => [request.key, { phase: request.phase, message: request.message }]));
        this.busy = this.dispatching || [...this.pending.values()].some(request => request.phase !== "recovery");
        this.complete = !!this.sources.length && this.results.size === this.sources.length;
        if (this.complete) {
            this.elapsedSeconds = (this.now() - this.startedAt) / 1000;
            this.message = this.commonError || (this.hasErrors ? "Some rasters failed. Calculate to retry failed rasters." : "Raster series complete.");
        } else if (this.needsRecovery) {
            this.message = "Recover interrupted requests to confirm or cancel the same jobs safely. Other rasters can continue.";
        } else this.message = this.busy ? "Calculating rasters; results appear as each finishes." : "Calculate to continue.";
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
        this.updateSeriesProgress();
    }

    /** Detach observers, preserving unfinished submissions for recovery after reload.
     * @return {void}
     */
    destroy() {
        this.clock.clearTimeout(this.timer);
        for (const client of this.clients.values()) client.destroy();
    }
}
