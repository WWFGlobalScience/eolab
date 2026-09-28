/** Calculate the same area statistics for each raster selected in Raster series. */
import { calculationIntent } from "./calculation-session.js";
import { normalizeCalculationArea } from "./calculation-area.js";
import { AUTOMATIC_CALCULATION_LIMITS, canAutomaticallyCalculate } from "./calculation-policy.js";
import { performanceDescription } from "./calculation-performance.js";
import { describeJobProgress } from "./presentation.js";

/**
 * Calculate up to five formulas over one shared area for each selected raster.
 * Requests run independently through Processing's server queue. This
 * controller keeps per-raster results, pauses for confirmation or recovery, and
 * cancels obsolete work when the inputs change or area statistics is hidden.
 */
export class RasterSeriesCalculations {
    /** Initialize raster-series inputs, results and progress tracking.
     * Creating the controller does not create executors, validate formulas or submit calculations.
     * Composition supplies the area; the Raster series controller supplies selected
     * rasters, formulas and visibility before work can begin.
     * @param {Object} options Providers.
     * @param {import("./api.js").ProcessingApiClient} options.api Formula validator.
     * @param {import("./calculation-requests.js").CalculationRequests} options.requests Independent recoverable requests.
     * @param {Object} [options.clock=globalThis] Debounce timer provider.
     * @param {()=>number} [options.now] Monotonic browser clock in milliseconds.
     */
    constructor({ api, requests, clock = globalThis, now = () => performance.now() }) {
        Object.assign(this, { api, requests, clock, now });
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
        this.confirmation = false;
        this.validated = false;
        this.clients = new Map();
        this.progress = new Map();
    }

    /** Replace the callback that refreshes the plot when calculation state changes.
     * The callback reads this controller's results, progress and confirmation state.
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
     * calculations are scheduled only while area statistics is visible. Changes to
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
        const key = JSON.stringify([sources.map(source => [source.key, source.item.collection, source.item.id]).sort(),
            normalized, formulas.map(({id,expression}) => [id,expression.trim()])]);
        this.formulas = formulas.map(formula => ({ ...formula }));
        this.sources = sources.map(source => ({ ...source }));
        this.area = normalized;
        this.areaLabel = label;
        if (this.inputKey !== key) { this.inputKey = key; this.resetResultsForChangedInputs(); }
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
     * work, clear formula validation and confirmation, and reset the stack's automatic
     * work budget so the new inputs are checked before submission.
     * @return {void}
     */
    resetResultsForChangedInputs() {
        if (this.results.size) this.previousResults = new Map(this.results);
        this.cancelRemainingRasters();
        this.results = new Map();
        this.complete = false;
        this.confirmation = false;
        this.validated = false;
        this.authorized = false;
        this.startedAt = null;
        this.elapsedSeconds = null;
        this.budget = { nativeBlocks: 0, decodedBytes: 0, geometryCells: 0 };
        if (this.active) this.scheduleRemainingCalculations();
        else this.onChange();
    }

    /** Stop the unfinished series after cancellation, input replacement or hiding the plot.
     * Cancel the debounce timer and formula check, ignore late responses, and ask
     * Processing to cancel all of this series' submitted jobs. Completed results
     * remain available; executors retain jobs still needing cancellation recovery.
     * @return {void} Cancellation is requested here and acknowledged asynchronously.
     */
    cancelRemainingRasters() {
        this.version++;
        this.clock.clearTimeout(this.timer);
        this.validation?.abort();
        this.validating = false;
        this.pending.clear();
        this.progress.clear();
        this.busy = false;
        this.confirmation = false;
        for (const client of this.clients.values()) client.stop();
        this.message = "Calculation stopped. Calculate to continue.";
        this.onChange();
    }

    /** Schedule remaining calculations after 700 ms without another edit.
     * Used after input changes or reopening an unfinished area plot. Replace the
     * previous timer and show checking feedback; the delayed request validates the
     * formulas and applies confirmation rules before submitting any raster work.
     * @return {void}
     */
    scheduleRemainingCalculations() {
        this.clock.clearTimeout(this.timer);
        this.startedAt ??= this.now();
        this.message = "Checking formulas…";
        this.busy = true;
        this.timer = this.clock.setTimeout(() => void this.calculateRemainingRasters(false), 700);
        this.onChange();
    }

    /** Validate formulas once and request all unfinished rasters independently.
     * Calculate approves pending large work and retries failed rows. Active requests
     * continue unchanged; uncertain submissions require Recover first.
     * @param {boolean} [authorize=true] Explicit approval of the remaining stack.
     * @return {Promise<void>} Validation and request dispatch, not calculation completion.
     */
    async calculateRemainingRasters(authorize = true) {
        this.clock.clearTimeout(this.timer);
        if (!this.active || this.validating) return;
        if (!this.sources.length || !this.area) {
            this.busy = false;
            this.message = !this.area ? "Choose an area or click the map to calculate." : "Select at least one raster.";
            this.onChange(); return;
        }
        const version = this.version;
        this.startedAt ??= this.now();
        this.authorized ||= authorize;
        if (authorize) {
            for (const [key, result] of this.results) if (result.error) this.results.delete(key);
            for (const [index, request] of this.pending) if (request.phase === "confirmation") this.pending.delete(index);
        }
        this.busy = this.validating = true;
        const validation = this.validation = new AbortController();
        try {
            const formulas = this.formulas.map(formula => ({ label: "stat-" + formula.id, expression: formula.expression.trim() }));
            const firstCalculationInputs = calculationIntent({ source: this.getRasterReference(this.sources[0]), area: this.area, calculations: formulas });
            if (!this.validated) await this.api.validateCalculation(firstCalculationInputs.calculations, validation.signal);
            if (version !== this.version || !this.active) return;
            this.validated = true;
            // Record all identities before prepare() can synchronously notify listeners.
            const additions = [];
            for (const source of this.sources) {
                if (this.results.has(source.key) || [...this.pending.values()].some(request => request.key === source.key)) continue;
                let index = 0;
                while (this.pending.has(index)) index++;
                const client = this.getOrCreateRasterExecutor(index);
                const request = { key: source.key, calculationInputs: calculationIntent({ ...firstCalculationInputs, source: this.getRasterReference(source) }),
                    startedAt: this.now(), submitted: false, phase: "waiting", message: "Waiting for planning…" };
                this.pending.set(index, request);
                additions.push([client, request]);
            }
            for (const [client, request] of additions) client.prepare(request.calculationInputs);
            this.validating = false;
            this.updateSeriesProgress();
        } catch (error) {
            if (version !== this.version || error.name === "AbortError") return;
            this.message = error.message; this.busy = this.validating = false; this.onChange();
        }
    }

    /** Read the catalog IDs and display name used to request one raster calculation.
     * Called while building formula-validation and calculation requests.
     * @param {{label:string,item:{collection:string,id:string}}} source Selected catalog raster.
     * @return {{collectionId:string,itemId:string,label:string}} Raster reference accepted by Processing.
     */
    getRasterReference(source) {
        return { collectionId: source.item.collection, itemId: source.item.id, label: source.label };
    }

    /** Check whether the current raster plan can be submitted without another Calculate click.
     * An earlier explicit Calculate click approves the remaining stack. Cached results
     * also need no confirmation. Otherwise, require a small rectangular selection and
     * check this plan plus work already submitted against the automatic stack budget.
     * This check does not charge the budget; submission does.
     * @param {Object} plan Current raster's server plan with cache status and grid estimates.
     * @param {Object} calculationInputs Validated, immutable inputs for this raster calculation.
     * @param {{collectionId:string,itemId:string,label:string}} calculationInputs.source Catalog raster to read.
     * @param {Object} calculationInputs.area Selected box, polygon reference or whole-raster descriptor.
     * @param {ReadonlyArray<{label:string,expression:string}>} calculationInputs.calculations Named formulas to evaluate.
     * @return {boolean} True if no additional user confirmation is needed.
     */
    canSubmitWithoutConfirmation(plan, calculationInputs) {
        if (this.authorized || plan.cacheHit) return true;
        if (!canAutomaticallyCalculate(plan, calculationInputs)) return false;
        const estimates = { nativeBlocks: plan.grid.nativeBlocks, decodedBytes: plan.grid.decodedBytes,
            geometryCells: plan.grid.groundArea?.estimatedGeometryCells ?? 0 };
        return Object.entries(estimates).every(([key, value]) => (this.budget?.[key] ?? 0) + value <= AUTOMATIC_CALCULATION_LIMITS[key]);
    }

    /** Apply progress only to this executor's current immutable raster request.
     * Failures leave gaps while peers continue. Plans needing confirmation are
     * released immediately so they do not occupy server plan capacity.
     * Completed results include browser timing stages when the executor recorded
     * the full request. The timer stops here, before the view renders the result.
     * @param {number} index Executor position.
     * @param {import("./calculation-executor.js").CalculationExecutionSnapshot} state Execution progress.
     * @return {void}
     */
    handleCalculationProgress(index, state) {
        const request = this.pending.get(index);
        if (!request || request.phase === "confirmation") { this.onChange(); return; }
        const client = this.clients.get(index);
        /** Check that a plan or result belongs to the calculation currently at this position.
         * @param {Object|null} calculationInputs Raster, area and formulas accompanying a plan or result.
         * @return {boolean} True when all inputs match the current request.
         */
        const matchesCalculationInputs = calculationInputs => JSON.stringify(calculationInputs) === JSON.stringify(request.calculationInputs);
        if (state.completedJob && matchesCalculationInputs(state.completedCalculation) && request.submitted &&
            state.completedJob.jobId !== request.previousJobId && !state.unfinishedCalculation && state.isIdle) {
            const receivedAt = this.now();
            const elapsedSeconds = (receivedAt - request.startedAt) / 1000;
            const trace = state.completedTimings;
            let stages;
            if (trace && [trace.planningStartedAtMs, trace.planningFinishedAtMs, trace.submissionStartedAtMs, trace.submissionFinishedAtMs].every(Number.isFinite)
                && request.startedAt <= trace.planningStartedAtMs && trace.planningFinishedAtMs <= trace.submissionStartedAtMs) {
                stages = {
                    beforePlanningSeconds: (trace.planningStartedAtMs - request.startedAt) / 1000,
                    planningSeconds: (trace.planningFinishedAtMs - trace.planningStartedAtMs) / 1000,
                    beforeSubmissionSeconds: (trace.submissionStartedAtMs - trace.planningFinishedAtMs) / 1000,
                    submissionSeconds: (trace.submissionFinishedAtMs - trace.submissionStartedAtMs) / 1000,
                    afterSubmissionSeconds: (receivedAt - trace.submissionFinishedAtMs) / 1000,
                    planReused: trace.planReused, serverPlan: trace.serverPlan,
                };
            }
            this.results.set(request.key, { job: state.completedJob, calculationInputs: request.calculationInputs, elapsedSeconds,
                performanceLines: performanceDescription(state.completedJob, elapsedSeconds, stages,
                    "Measured in this tab from dispatching this raster for planning until its completed result reaches the series controller, including planning, queueing, submission and result delivery (notifications or polling). Excludes earlier area selection, formula debounce and validation, and subsequent UI rendering.") });
            this.pending.delete(index);
        } else if (state.recoverable) {
            request.phase = "recovery"; request.message = state.message;
        } else if (state.admission === "retry" || (request.submitted && state.isIdle && !state.plan && !state.unfinishedCalculation)) {
            this.results.set(request.key, { calculationInputs: request.calculationInputs, error: state.message || "No result returned." });
            this.pending.delete(index);
        } else if (state.plan && state.isIdle && matchesCalculationInputs(state.plannedCalculation)) {
            // An expired, unsubmitted plan may have been replaced after a capacity
            // wait. Replace its estimate rather than counting the same raster twice.
            if (request.budgetCharge) {
                for (const [key, value] of Object.entries(request.budgetCharge)) this.budget[key] -= value;
                request.budgetCharge = null;
            }
            if (!this.canSubmitWithoutConfirmation(state.plan, request.calculationInputs)) {
                request.phase = "confirmation"; request.message = "Waiting for your confirmation.";
                client.discardPendingCalculation();
            } else {
                request.previousJobId = state.completedJob?.jobId;
                request.submitted = true;
                if (!state.plan.cacheHit) {
                    request.budgetCharge = { nativeBlocks: state.plan.grid.nativeBlocks,
                        decodedBytes: state.plan.grid.decodedBytes,
                        geometryCells: state.plan.grid.groundArea?.estimatedGeometryCells ?? 0 };
                    for (const [key, value] of Object.entries(request.budgetCharge)) this.budget[key] += value;
                }
                client.submit(state.plan.planId, { automatic: !this.authorized, client: "raster-series" });
            }
        } else {
            request.phase = state.phase;
            request.message = state.currentJob ? describeJobProgress(state.currentJob) : state.message;
        }
        this.updateSeriesProgress();
    }

    /** Update per-raster progress, whole-series status and the final elapsed time.
     * Read the pending requests and finished results to set the busy, confirmation
     * and completion flags and the overall message, then notify the plot listener.
     * When every raster has a result or error, record time since the series was
     * requested, including debounce, validation and confirmation/recovery pauses.
     * This method uses existing state; it does not request server updates.
     * @return {void}
     */
    updateSeriesProgress() {
        this.progress = new Map([...this.pending.values()].map(request => [request.key, { phase: request.phase, message: request.message }]));
        this.confirmation = [...this.pending.values()].some(request => request.phase === "confirmation");
        this.busy = this.validating || [...this.pending.values()].some(request => !["confirmation", "recovery"].includes(request.phase));
        this.complete = !!this.sources.length && this.results.size === this.sources.length;
        if (this.complete) {
            this.elapsedSeconds = (this.now() - this.startedAt) / 1000;
            this.message = this.hasErrors ? "Some rasters failed. Calculate to retry failed rasters." : "Raster series complete.";
        } else if (this.confirmation) {
            this.message = "This area or stack needs a larger calculation. Calculate the remaining rasters, or choose a smaller area.";
        } else if (this.needsRecovery) {
            this.message = "Recover interrupted requests to confirm or cancel the same jobs safely. Other rasters can continue.";
        } else this.message = this.busy ? "Calculating rasters; results appear as each finishes." : "Calculate to continue.";
        this.onChange();
    }

    /** Check whether any raster has a failed result. @return {boolean} True if at least one result contains an error. */
    get hasErrors() { return [...this.results.values()].some(result => result.error); }

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
        this.validation?.abort();
        for (const client of this.clients.values()) client.destroy();
    }
}
