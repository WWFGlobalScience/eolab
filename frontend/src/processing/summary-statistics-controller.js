/** Editable statistic cards over the existing durable calculation workflow. */
import { calculationIntent, chunkPixels } from "./calculation-session.js";
import { CalculationExecutor } from "./calculation-executor.js";
import { catalogSelectionsEqual, normalizeRasterSamplingArea } from "../selected-area.js";

export const AUTOMATIC_CALCULATION_LIMITS = Object.freeze({ nativeBlocks: 128, decodedBytes: 64 * 1024 * 1024, geometryCells: 25000 });
export const STATISTIC_PRESETS = Object.freeze({
    mean: { label: "Mean", expression: "mean(a)" }, sum: { label: "Sum", expression: "sum(a)" },
    count: { label: "Count above 10", expression: "count(a > 10)" },
    "area-threshold": { label: "Area above 10", expression: "areaha(a > 10)" },
    "area-class": { label: "Area in class 4", expression: "areaha(a == 4)" },
    percent: { label: "Percent above 10", expression: "100 * count(a > 10) / count(a)" },
    range: { label: "Range", expression: "max(a) - min(a)" }, custom: { label: "", expression: "" },
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sourceKey = source => source ? `${source.collectionId}\n${source.itemId}` : "";

/** Conservative browser policy; backend resource limits still apply to every run. */
export function canAutomaticallyCalculate(plan, intent) {
    const grid = plan?.grid;
    return intent.area.kind === "selectedArea" && !!grid &&
        Number.isFinite(grid.nativeBlocks) && grid.nativeBlocks <= AUTOMATIC_CALCULATION_LIMITS.nativeBlocks &&
        Number.isFinite(grid.decodedBytes) && grid.decodedBytes <= AUTOMATIC_CALCULATION_LIMITS.decodedBytes &&
        (!grid.groundArea || (Number.isFinite(grid.groundArea.estimatedGeometryCells) &&
            grid.groundArea.estimatedGeometryCells <= AUTOMATIC_CALCULATION_LIMITS.geometryCells));
}

/** Own card identities and local validation; serialize native work through one executor. */
export class SummaryStatisticsController {
    /** Wire statistic cards to the existing Processing executor and composed actions.
     * @param {Object} dependencies API, jobs, storage, view, clock and semantic callbacks.
     * @param {Function} [dependencies.onCancelSelection] Cancel an in-progress area selection.
     */
    constructor(dependencies) {
        const { api, jobs, view, getContext, onOpen, onClose, onEditArea, onCancelSelection = () => {}, clock = globalThis, now = () => performance.now() } = dependencies;
        this.now = now;
        Object.assign(this, { api, jobs, view, getContext, onOpen, onClose, onCancelSelection, clock });
        this.serial = 0;
        this.state = { sources: [], statistics: [], area: null, selectedArea: null, areaChoice: "selection",
            active: false, automatic: true, jobs: [], historyError: "", saved: null, undo: false, targetChunkPixels: null };
        this.state.statistics.push(this.makeStatistic(STATISTIC_PRESETS.mean));
        this.executor = new CalculationExecutor({ api, jobs, storage: dependencies.storage,
            onActivity: dependencies.onActivity, requestId: dependencies.requestId, now,
            canAutoSubmit: canAutomaticallyCalculate,
            onChange: snapshot => this.receive(snapshot),
        });
        view.bind({ onOpen: () => this.open(), onClose: () => this.close(), onEditArea,
            onArea: choice => this.chooseArea(choice), onAutomatic: value => this.setAutomatic(value),
            onChunkPixels: value => this.setChunkPixels(value),
            onEdit: (id, change) => this.editStatistic(id, change), onAdd: preset => this.addStatistic(preset),
            onRemove: id => this.removeStatistic(id), onUndo: () => this.undoRemove(),
            onRun: id => this.request(id, "manual"), onStop: id => this.stopStatistic(id),
            onRetry: () => void this.executor.retry(), onRefresh: () => void jobs.refresh(),
            onInspect: id => this.inspect(id), onCancel: id => void this.executor.jobAction(id, "cancel"),
            onDelete: id => void this.executor.jobAction(id, "delete"),
            onCloseSaved: () => { this.state.saved = null; this.render(); },
        });
        this.render();
    }

    makeStatistic(value, source = null) {
        return { id: ++this.serial, label: value.label, expression: value.expression, source,
            version: 0, valid: false, checking: false, requested: null, pending: false,
            message: "Choose a raster", result: null, plan: null, manualRequired: false, error: false };
    }
    label(card) { return card.label.trim() || `Summary statistic ${card.id}`; }
    key(card) { return JSON.stringify([sourceKey(card.source), card.expression.trim(), this.state.area, this.state.targetChunkPixels]); }
    get isActive() { return this.state.active && !this.destroyed; }

    /** Restore cards for a submission saved before reload, then resume tracking that job.
     * Automatic jobs are cancelled on reload; this does not start a new calculation.
     * @return {Promise<void>} Recovery progress.
     */
    async start() {
        const unfinished = this.executor.snapshot.unfinishedCalculation;
        if (unfinished) {
            this.state.targetChunkPixels = unfinished.calculation.targetChunkPixels ?? null;
            this.state.area = this.state.selectedArea = unfinished.calculation.area;
            this.state.areaChoice = unfinished.calculation.area.kind === "wholeRaster" ? "whole" : unfinished.calculation.area.kind === "catalogSelection" ? "vector" : "selection";
            this.state.sources = [unfinished.calculation.source];
            this.state.statistics = unfinished.calculation.calculations.map(value => {
                const card = this.makeStatistic(value, unfinished.calculation.source); card.valid = true; return card;
            });
            this.batch = { automatic: unfinished.automatic, obsolete: unfinished.cancelRequested,
                intent: unfinished.calculation, cards: this.state.statistics.map(card => ({ id: card.id, key: this.key(card) })) };
        }
        await this.executor.start();
        this.receive(this.executor.snapshot);
    }

    /** Opening/reopening is presentation, never an automatic calculation trigger.
     * @param {Object|null} [source=null] Optional catalog raster to bind to the first card.
     * @param {Object|undefined} [area] Explicit area, otherwise use current context.
     * @return {void}
     */
    open(source = null, area) {
        const context = this.getContext();
        const sources = [...(context.sources ?? [])];
        for (const item of [source, ...this.state.statistics.map(card => card.source)]) {
            if (item && !sources.some(other => sourceKey(other) === sourceKey(item))) sources.push(item);
        }
        this.state.sources = sources;
        const selected = area === undefined ? context.area : area;
        if (area !== undefined || (!this.state.area && this.state.areaChoice === "selection")) {
            this.state.areaChoice = this.state.vectorArea && catalogSelectionsEqual(selected?.catalogSelection, this.state.vectorArea.selection) ? "vector" : "selection";
            this.setSelection(selected, false);
            if (this.state.areaChoice === "vector") this.changeArea(selected, false);
        }
        for (const card of this.state.statistics) {
            const next = (source && card === this.state.statistics[0]) ? source : card.source ?? sources[0] ?? null;
            if (sourceKey(next) !== sourceKey(card.source)) this.editStatistic(card.id, { source: next }, false);
            else if (!card.valid && !card.checking) this.validateLater(card, false);
        }
        this.onOpen();
        this.render();
    }

    setActive(active) {
        if (this.state.active === active) return;
        this.state.active = active;
        if (!active) {
            for (const card of this.state.statistics) if (card.requested === "automatic") card.requested = null;
            if (this.batch?.automatic) this.invalidateBatch();
        }
        this.render();
    }
    close() { this.setActive(false); this.onClose(); }
    setAutomatic(value) {
        this.state.automatic = !!value;
        if (!value) {
            for (const card of this.state.statistics) if (card.requested === "automatic") card.requested = null;
            if (this.batch?.automatic) this.invalidateBatch();
        }
        // Enabling affects the next edit/click, not every existing card immediately.
        this.render();
    }

    /** Select an authoritative Catalog descriptor and optionally execute the explicit action.
     * @param {Object} info Catalog selection and presentation label.
     * @param {boolean} [calculate=false] User explicitly requested filter and calculation.
     * @return {void}
     */
    setVectorSamplingArea(info, calculate = false) {
        this.state.vectorSelecting = false;
        this.state.vectorCalculation = calculate;
        this.state.selectionMessage = "";
        this.state.vectorArea = info;
        this.state.areaChoice = "vector";
        this.state.selectedArea = normalizeRasterSamplingArea({ kind: "catalogSelection", catalogSelection: info.selection });
        this.changeArea(this.state.selectedArea, false);
        if (calculate) {
            this.open();
            for (const card of this.state.statistics) this.request(card.id, "manual");
            if (!this.state.statistics.length) this.view.focusAddStatistic?.();
        }
        this.render();
    }
    /** Receive selection lifecycle through composition, without accessing vector state.
     * @param {{phase:string,message:string,analysis:boolean}} selection Public progress snapshot.
     * @return {void}
     */
    setVectorSelectionState(selection) {
        if (!selection.analysis) return;
        const selecting = ["reading", "selected"].includes(selection.phase);
        if (selecting && !this.state.vectorSelecting) {
            this.invalidateBatch();
            this.executor.invalidate();
            this.state.areaChoice = "vector";
            this.changeArea(null, false);
        }
        this.state.vectorSelecting = selecting;
        this.state.selectionMessage = selection.phase === "active" ? "" : selection.message;
        this.render();
    }
    /** Cancel obsolete work even when its panel is no longer active. */
    invalidateSamplingArea(id) {
        if (catalogSelectionsEqual(this.batch?.intent.area?.catalogSelection, id)) this.invalidateBatch();
        if (catalogSelectionsEqual(this.state.area?.catalogSelection, id)) { this.invalidateBatch(); this.changeArea(null, false); }
        if (catalogSelectionsEqual(this.state.selectedArea?.catalogSelection, id)) this.state.selectedArea = null;
        if (catalogSelectionsEqual(this.state.vectorArea?.selection, id)) this.state.vectorArea = null;
        this.render();
    }
    /** Change execution settings without launching a benchmark or invalidating formula syntax.
     * @param {number|null} value Total target pixels; null keeps legacy execution. @return {void}
     */
    setChunkPixels(value) {
        const target = chunkPixels(value);
        if (target === this.state.targetChunkPixels) return;
        this.invalidateBatch();
        this.executor.invalidate();
        this.state.targetChunkPixels = target;
        for (const card of this.state.statistics) {
            card.plan = null; card.manualRequired = false; card.requested = null; card.error = false;
        }
        this.render();
    }
    setSelection(area, automatic = true) {
        const next = area ? normalizeRasterSamplingArea(area) : null;
        if (same(next, this.state.selectedArea)) return;
        this.state.selectedArea = next;
        if (next && this.state.areaChoice === "vector" && this.state.vectorArea && catalogSelectionsEqual(this.state.area?.catalogSelection, this.state.vectorArea.selection) && !catalogSelectionsEqual(next.catalogSelection, this.state.vectorArea.selection)) {
            this.state.areaChoice = "selection";
        }
        if (this.state.areaChoice === "selection") this.changeArea(next, automatic);
    }
    chooseArea(choice) {
        this.state.areaChoice = choice;
        const area = choice === "vector" ? null : choice === "whole" ? { kind: "wholeRaster" } : this.state.selectedArea;
        this.changeArea(area, true);
        this.render();
    }
    /** Replace the current scope and release obsolete reviews before further admission.
     * @param {Object|null} area Neutral sampling area.
     * @param {boolean} automatic Whether normal automatic-update policy applies.
     * @return {void}
     */
    changeArea(area, automatic) {
        if (same(area, this.state.area)) return;
        if (this.batch?.automatic || this.isActive) this.invalidateBatch();
        this.executor.invalidate();
        this.state.area = area;
        for (const card of this.state.statistics) {
            card.plan = null; card.manualRequired = false; card.error = false;
            card.requested = automatic && this.isActive && this.state.automatic && area ? "automatic" : null;
            card.requestStarted = card.requested ? this.now() : null;
            this.validateLater(card, false);
        }
        this.render();
    }
    calculateSelection() {
        if (!this.isActive || !this.state.automatic || this.state.areaChoice !== "selection" || this.state.area?.kind !== "selectedArea") return;
        for (const card of this.state.statistics) this.request(card.id, "automatic", true);
    }

    editStatistic(id, change, automatic = true) {
        const card = this.state.statistics.find(item => item.id === id);
        if (!card) return;
        const oldKey = this.key(card);
        Object.assign(card, change);
        if (oldKey !== this.key(card)) {
            this.invalidateBatch(id);
            card.plan = null; card.manualRequired = false; card.error = false;
            card.requested = automatic && this.isActive && this.state.automatic ? "automatic" : null;
            card.requestStarted = card.requested ? this.now() : null;
            this.validateLater(card, false);
        }
        // Names are presentation only; the immutable original export keeps its run label.
        this.render();
    }
    addStatistic(preset) {
        if (this.state.statistics.length >= 5 || !STATISTIC_PRESETS[preset]) return;
        const card = this.makeStatistic(STATISTIC_PRESETS[preset], this.state.statistics.at(-1)?.source ?? this.state.sources[0] ?? null);
        this.state.statistics.push(card);
        this.validateLater(card, this.isActive && this.state.automatic);
        this.render();
        this.view.focusStatistic?.(card.id);
    }
    removeStatistic(id) {
        const index = this.state.statistics.findIndex(card => card.id === id);
        if (index < 0) return;
        const [card] = this.state.statistics.splice(index, 1);
        this.clock.clearTimeout(card.timer); card.abort?.abort(); card.version++;
        this.removed = { card, index }; this.state.undo = true;
        this.invalidateBatch(id);
        this.render();
        this.view.focusUndo?.();
    }
    undoRemove() {
        if (!this.removed || this.state.statistics.length >= 5) return;
        const { card, index } = this.removed;
        card.pending = false; card.requested = null;
        this.state.statistics.splice(index, 0, card);
        this.removed = null; this.state.undo = false;
        this.validateLater(card, this.isActive && this.state.automatic && card.result?.key !== this.key(card));
        this.render(); this.view.focusStatistic?.(card.id);
    }

    /** Server grammar remains authoritative; one invalid statistic never invalidates its peers.
     * @param {Object} card Owned statistic card.
     * @param {boolean} requestAutomatic Whether a complete edit requests an automatic update.
     * @return {void}
     */
    validateLater(card, requestAutomatic) {
        this.clock.clearTimeout(card.timer); card.abort?.abort();
        const version = ++card.version;
        card.valid = false; card.checking = true; card.error = false;
        card.cancelled = false;
        if (requestAutomatic) { card.requested = "automatic"; card.requestStarted = this.now(); }
        card.message = "Checking formula…";
        card.timer = this.clock.setTimeout(() => void this.validate(card, version), 700);
    }
    async validate(card, version) {
        card.abort = new AbortController();
        try {
            if (!card.expression.trim()) throw new Error("Enter a formula");
            await this.api.validateCalculation([{ label: this.label(card), expression: card.expression }], card.abort.signal);
            if (this.destroyed || version !== card.version || !this.state.statistics.includes(card)) return;
            card.valid = true; card.checking = false; card.message = "Ready to calculate";
            if (card.result?.key === this.key(card)) card.requested = null;
        } catch (error) {
            if (this.destroyed || version !== card.version || error.name === "AbortError" || !this.state.statistics.includes(card)) return;
            card.valid = false; card.checking = false; card.error = !!card.expression.trim();
            card.message = error.message; card.requested = null;
        }
        this.render(); this.schedulePump();
    }
    /** Queue one card; an explicit manual action already authorizes submission.
     * @param {number} id Stable card identity.
     * @param {string} kind Manual or automatic execution intent.
     * @param {boolean} [debounce=false] Whether formula validation must wait for editing.
     * @return {void}
     */
    request(id, kind, debounce = false) {
        const card = this.state.statistics.find(item => item.id === id);
        if (!card || !card.source || !this.state.area) return;
        if (this.batch && !this.batch.obsolete && this.batch.cards.some(entry => entry.id === id && entry.key === this.key(card))) return;
        card.requested = kind; card.error = false; card.cancelled = false;
        card.requestStarted = this.now();
        if (debounce) this.validateLater(card, false);
        else if (!card.valid && !card.checking) this.validateLater(card, false);
        this.render(); this.schedulePump();
    }
    /** Cancel queued calculation or composed selection work without discarding old values.
     * @param {number} id Stable card identity.
     * @return {void}
     */
    stopStatistic(id) {
        if (this.state.vectorSelecting) this.onCancelSelection();
        const card = this.state.statistics.find(item => item.id === id);
        if (card) { card.requested = null; card.cancelled = true; card.message = "Calculation cancelled"; }
        this.invalidateBatch(id);
        this.render();
    }

    /** Cancel a superseded batch, retaining unchanged sibling requests for the next shared scan. */
    invalidateBatch(id) {
        const batch = this.batch;
        if (!batch || (id !== undefined && !batch.cards.some(card => card.id === id))) return;
        if (!batch.obsolete) {
            batch.obsolete = true;
            for (const entry of batch.cards) {
                const card = this.state.statistics.find(item => item.id === entry.id);
                if (card && card.id !== id && id !== undefined && this.key(card) === entry.key &&
                    (!batch.automatic || (this.isActive && this.state.automatic))) card.requested = batch.automatic ? "automatic" : "manual";
            }
            this.executor.stop();
        }
    }
    schedulePump() {
        if (this.pumpScheduled || this.destroyed) return;
        this.pumpScheduled = true;
        queueMicrotask(() => { this.pumpScheduled = false; this.pump(); });
    }
    /** Admit one compatible card batch using the executor status contract.
     * @return {void}
     */
    pump() {
        const execution = this.executor.snapshot;
        if (this.destroyed || this.batch || !execution.isIdle) return;
        const eligible = this.state.statistics.filter(card => card.requested && card.valid && !card.checking && card.source && this.state.area &&
            (["manual", "review"].includes(card.requested) || (this.isActive && this.state.automatic)));
        const first = eligible[0];
        if (!first) return;
        if (execution.admission === "manual" && first.requested === "automatic") {
            for (const card of eligible) { card.requested = null; card.error = true; card.message = "Calculation paused after an error · Calculate to retry"; }
            this.render(); return;
        }
        // Combine distinct labels on one raster into a single native scan. Other rasters wait.
        const labels = new Set();
        const group = eligible.filter(card => {
            const label = this.label(card);
            if (card.requested !== first.requested || sourceKey(card.source) !== sourceKey(first.source) || labels.has(label)) return false;
            labels.add(label); return true;
        });
        const intent = calculationIntent({ source: first.source, area: this.state.area,
            targetChunkPixels: this.state.targetChunkPixels,
            calculations: group.map(card => ({ label: this.label(card), expression: card.expression })) });
        this.batch = { intent, previousJobId: execution.result?.jobId, automatic: first.requested !== "manual", obsolete: false,
            cards: group.map(card => ({ id: card.id, key: this.key(card), requestStarted: card.requestStarted })) };
        for (const card of group) { card.requested = null; card.pending = true; card.error = false; card.message = "Checking calculation size…"; }
        this.executor.executeIntent(intent, this.batch.automatic);
        this.render();
    }

    /** Apply execution progress to the batch that owns it, including terminal results.
     * @param {import("./calculation-executor.js").CalculationExecutionSnapshot} execution Coherent execution status.
     * @return {void}
     */
    receive(execution) {
        if (!this.executor || this.destroyed) return;
        this.state.jobs = execution.jobs;
        this.state.historyError = execution.historyError;
        if (this.state.saved) {
            const saved = execution.jobs.find(job => job.jobId === this.state.saved.jobId) ?? this.state.saved;
            this.state.saved = saved.status === "deleted" ? null : saved;
        }
        this.state.recoverable = execution.recoverable;
        this.state.recoveryMessage = execution.recoverable ? execution.message : "";
        for (const card of this.state.statistics) {
            if (card.result) {
                const job = execution.jobs.find(item => item.jobId === card.result.job.jobId);
                if (job?.status === "deleted") card.result = null;
            }
        }
        const batch = this.batch;
        if (batch) {
            const isIdle = execution.isIdle;
            const job = execution.result;
            const matching = !batch.obsolete && same(execution.resultIntent, batch.intent) && job?.status === "ready" && job.jobId !== batch.previousJobId;
            batch.cards.forEach((entry, index) => {
                const card = this.state.statistics.find(item => item.id === entry.id);
                if (!card) return;
                if (!batch.obsolete && this.key(card) === entry.key) {
                    card.message = execution.message || (execution.current?.status === "running" ? "Calculating…" : "Waiting to calculate…");
                    card.progress = execution.current?.progress ?? null;
                    card.error = execution.phase === "error";
                    if (execution.plan) card.plan = execution.plan;
                    if (isIdle && matching && job.result?.rows[index]) {
                        card.result = { key: entry.key, row: job.result.rows[index], job, source: batch.intent.source, area: batch.intent.area,
                            requestStarted: entry.requestStarted, stageTrace: execution.resultTiming };
                        card.message = "Up to date";
                    } else if (isIdle && execution.manualRequired) {
                        card.manualRequired = true;
                        card.message = "Ready to calculate · explicit confirmation needed";
                    } else if (isIdle && !matching) {
                        card.error = execution.phase === "error" || !batch.obsolete;
                    }
                }
                if (isIdle) { card.pending = false; card.progress = null; }
            });
            if (isIdle) { this.batch = null; this.schedulePump(); }
        }
        this.render();
    }
    inspect(id) {
        const job = this.jobs.jobs.find(item => item.jobId === id && item.operation === "raster.aggregate.v1");
        if (!job) return;
        this.state.saved = job;
        this.onOpen(); this.render();
        this.view.focusSaved?.();
    }
    /** Present matching results and explicit selection/calculation lifecycle feedback.
     * @return {void}
     */
    render() {
        if (this.destroyed) return;
        for (const card of this.state.statistics) {
            card.current = !!card.result && card.result.key === this.key(card) && !card.pending && !card.requested && !card.checking && !card.error && !card.cancelled;
            if (!card.pending && !card.checking && !card.error) {
                card.message = !card.source ? "Choose a raster" : !this.state.area ? "Choose an area" : !card.valid ? "Enter a formula"
                    : card.requested ? "Ready to calculate · queued" : card.current ? "Up to date"
                    : card.manualRequired ? "Ready to calculate · explicit confirmation needed" : "Ready to calculate";
            }
        }
        for (const card of this.state.statistics) {
            if (card.cancelled) card.message = card.pending ? "Cancelling calculation…" : "Calculation cancelled";
            if (this.state.vectorSelecting) card.message = "Calculating · selecting filtered features…";
            else if (!this.state.area && this.state.selectionMessage) card.message = this.state.selectionMessage;
        }
        this.view.render(this.state);
        // Stop after the result DOM has been updated, including the view's work.
        // Keep this browser-local: recovered jobs have no monotonic start time.
        let measured = false;
        for (const card of this.state.statistics) {
            const result = card.result;
            if (result && Number.isFinite(result.requestStarted) && result.totalWaitSeconds === undefined) {
                const displayed = this.now();
                result.totalWaitSeconds = Math.max(0, displayed - result.requestStarted) / 1000;
                const trace = result.stageTrace;
                if (trace && [trace.planningStarted, trace.planningFinished, trace.submissionStarted, trace.submissionFinished].every(Number.isFinite)
                    && result.requestStarted <= trace.planningStarted && trace.planningFinished <= trace.submissionStarted) {
                    result.stages = {
                        beforePlanningSeconds: (trace.planningStarted - result.requestStarted) / 1000,
                        planningSeconds: (trace.planningFinished - trace.planningStarted) / 1000,
                        beforeSubmissionSeconds: (trace.submissionStarted - trace.planningFinished) / 1000,
                        submissionSeconds: (trace.submissionFinished - trace.submissionStarted) / 1000,
                        afterSubmissionSeconds: (displayed - trace.submissionFinished) / 1000,
                        planReused: trace.planReused, serverPlan: trace.serverPlan,
                    };
                }
                measured = true;
            }
        }
        if (measured) this.view.render(this.state);
    }
    destroy() {
        this.destroyed = true;
        for (const card of this.state.statistics) { this.clock.clearTimeout(card.timer); card.abort?.abort(); }
        this.executor.destroy(); this.view.unbind();
    }
}
