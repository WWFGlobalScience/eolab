/** Compact, accessible statistic cards. No expression evaluation happens in the view. */
import { calculationValue, renderSavedCalculation } from "./calculation-result-view.js";
import { ACTIVE_JOB_STATES } from "./jobs.js";
import { processingDownloadUrl } from "./api.js";
import { describeClipArea, describeJobProgress, formatDownloadBytes } from "./presentation.js";
import { executionDescription, performanceDescription } from "./calculation-performance.js";

const RESULT_STATES = { no_matches: "No cells matched the condition.", no_valid_data: "No valid cells in this area.",
    invalid_arithmetic: "Undefined arithmetic; no numeric result.", overflow: "Numeric overflow; no finite result." };

/** Keep DOM identities stable during edits, progress, removal, and undo. */
export class SummaryStatisticsView {
    /**
     * Bind statistic presentation and the browser's optional clipboard writer.
     * @param {Document} [documentContext=globalThis.document] Owning document.
     * @param {Object} [browserContext] Browser capabilities supplied at the view boundary.
     * @param {{writeText:(text:string)=>Promise<void>}|null} [browserContext.clipboard]
     * Clipboard writer; unavailable or denied access is presented in the card.
     */
    constructor(documentContext = globalThis.document, { clipboard = documentContext.defaultView?.navigator?.clipboard ?? null } = {}) {
        this.document = documentContext;
        this.elements = Object.fromEntries(["area", "area-description", "rows", "result", "history",
            "refresh", "retry", "close", "edit-area", "template"]
            .map(name => [name, documentContext.querySelector(`#calculations-${name}`)]));
        this.openers = [documentContext.querySelector("#open-calculations")];
        this.listeners = [];
        this.signatures = {};
        this.clipboard = clipboard;
        this.cards = new Map();
        this.vectorAreaControls = documentContext.querySelector("#calculations-vector-area");
        this.extra = Object.fromEntries(["auto", "undo", "undo-button", "saved-result", "close-saved", "recovery-status", "chunk-pixels", "performance-plans"]
            .map(name => [name, documentContext.querySelector(`#summary-${name}`)]));
    }
    /** Make a text-only card node. @param {string} tag HTML tag. @param {string} [text=""] Text. @return {HTMLElement} Node. */
    element(tag, text = "") { const node = this.document.createElement(tag); node.textContent = text; return node; }

    /** Bind the current summary controls to semantic intents. @param {Object<string, Function>} handlers Controller callbacks. @return {void} */
    bind(handlers) {
        this.handlers = handlers;
        const e = this.elements, x = this.extra;
        this.listeners = [
            ...this.openers.map(node => [node, "click", handlers.onOpen]),
            [e.close, "click", handlers.onClose], [e["edit-area"], "click", handlers.onEditArea],
            [e.area, "change", () => handlers.onArea(e.area.value)],
            [x.auto, "change", () => handlers.onAutomatic(x.auto.checked)],
            [x["chunk-pixels"], "change", () => handlers.onChunkPixels(x["chunk-pixels"].value === "" ? null : Number(x["chunk-pixels"].value))],
            [e.template, "change", () => { handlers.onAdd(e.template.value); e.template.value = ""; }],
            [x["undo-button"], "click", handlers.onUndo], [e.retry, "click", handlers.onRetry],
            [e.refresh, "click", handlers.onRefresh], [x["close-saved"], "click", handlers.onCloseSaved],
        ];
        for (const [node, event, callback] of this.listeners) node.addEventListener(event, callback);
    }
    /** Create a stable editable statistic surface. @param {Object} card Controller card with a stable numeric id. @return {Object} Card nodes and clipboard state. */
    createCard(card) {
        const root = this.element("article"); root.className = "summary-statistic";
        root.setAttribute("aria-label", `Summary statistic ${card.id}`);
        const heading = this.element("div"); heading.className = "summary-statistic-heading";
        const label = this.element("input"); label.type = "text"; label.maxLength = 80;
        label.placeholder = "Name this statistic"; label.className = "summary-statistic-name";
        label.setAttribute("aria-label", `Summary statistic ${card.id} name`);
        label.addEventListener("input", () => this.handlers.onEdit(card.id, { label: label.value }));
        const remove = this.element("button", "×"); remove.type = "button"; remove.className = "summary-remove";
        remove.setAttribute("aria-label", `Remove summary statistic ${card.id}`);
        const removeTooltip = this.element("span", "Remove this calculation");
        removeTooltip.className = "summary-remove-tooltip"; removeTooltip.id = `summary-remove-tooltip-${card.id}`;
        removeTooltip.setAttribute("role", "tooltip");
        remove.setAttribute("aria-describedby", removeTooltip.id); remove.append(removeTooltip);
        remove.addEventListener("click", () => this.handlers.onRemove(card.id));
        heading.append(label);
        const binding = this.element("label"); binding.className = "summary-raster-binding";
        const variable = this.element("code", "a"); variable.className = "summary-raster-variable";
        variable.title = "Raster represented by a in the formula";
        const source = this.element("select"); source.setAttribute("aria-label", `Raster for summary statistic ${card.id}`);
        const bindingHelp = this.element("span", "Raster represented by a in the formula");
        bindingHelp.className = "summary-variable-help"; bindingHelp.id = `summary-variable-help-${card.id}`;
        source.setAttribute("aria-describedby", bindingHelp.id);
        source.addEventListener("change", () => this.handlers.onEdit(card.id, { source: this.sources[Number(source.value)] ?? null }));
        binding.append(variable, source, bindingHelp);
        const equation = this.element("div"); equation.className = "summary-equation";
        const expression = this.element("textarea"); expression.rows = 1; expression.maxLength = 4096; expression.spellcheck = false;
        expression.placeholder = "Formula, e.g. mean(a)";
        expression.setAttribute("aria-label", `Summary statistic ${card.id} formula`);
        expression.setAttribute("aria-describedby", `summary-statistic-status-${card.id}`);
        expression.addEventListener("input", () => this.handlers.onEdit(card.id, { expression: expression.value }));
        const valueGroup = this.element("div"); valueGroup.className = "summary-value-group";
        valueGroup.setAttribute("aria-live", "polite");
        const value = this.element("strong"); value.className = "summary-value";
        const valueActions = this.element("div"); valueActions.className = "summary-value-actions"; valueActions.hidden = true;
        const copy = this.element("button"); copy.type = "button"; copy.className = "summary-copy";
        copy.setAttribute("aria-label", `Copy current value for summary statistic ${card.id}`);
        copy.title = "Copy current value (exact)";
        const copyIcon = this.document.createElementNS("http://www.w3.org/2000/svg", "svg");
        for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "15", height: "15", "aria-hidden": "true", focusable: "false" })) copyIcon.setAttribute(name, value);
        const copyPath = this.document.createElementNS("http://www.w3.org/2000/svg", "path");
        for (const [name, value] of Object.entries({ d: "M8 8h12v13H8zM16 8V3H3v13h5", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linejoin": "round" })) copyPath.setAttribute(name, value);
        copyIcon.append(copyPath); copy.append(copyIcon);
        copy.addEventListener("click", () => void this.copyCurrentValue(card.id));
        const copyStatus = this.element("small"); copyStatus.setAttribute("role", "status"); copyStatus.hidden = true;
        valueActions.append(value, copy);
        valueGroup.append(valueActions);
        heading.append(valueGroup); equation.append(expression);
        const statusRow = this.element("div"); statusRow.className = "summary-status-row";
        const status = this.element("span"); status.id = `summary-statistic-status-${card.id}`;
        status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
        const run = this.element("button", "Calculate"); run.type = "button"; run.className = "secondary-button";
        run.addEventListener("click", () => this.handlers.onRun(card.id));
        const stop = this.element("button", "Cancel"); stop.type = "button"; stop.className = "summary-text-button";
        stop.addEventListener("click", () => this.handlers.onStop(card.id));
        statusRow.append(status, run, stop);
        const progress = this.element("progress"); progress.setAttribute("aria-label", `Progress for summary statistic ${card.id}`);
        valueGroup.append(statusRow, progress, copyStatus);
        const details = this.element("details"); details.className = "summary-result-details";
        const detailsTitle = this.element("summary", "Value details & downloads");
        const detailsBody = this.element("div"); details.append(detailsTitle, detailsBody);
        const size = this.element("small"); size.className = "summary-size";
        root.append(heading, equation, binding, size, details, remove);
        return { root, label, source, expression, equation, value, valueActions, copy, copyStatus, copyRevision: 0, status, statusRow, run, stop, progress, details, detailsBody, size, remove };
    }
    /** Present current cards and independently inspected saved jobs.
     * @param {Object} state Summary controller snapshot. @return {void}
     * @throws {TypeError} If a result contains an invalid owned download address.
     */
    render(state) {
        this.sources = state.sources;
        const sourceSignature = JSON.stringify(state.sources);
        const ids = state.statistics.map(card => card.id).join(",");
        for (const card of state.statistics) if (!this.cards.has(card.id)) this.cards.set(card.id, this.createCard(card));
        if (ids !== this.signatures.cardIds) {
            this.elements.rows.replaceChildren(...state.statistics.map(card => this.cards.get(card.id).root));
            // Removed cards can be recreated on Undo; surviving cards retain their actual nodes.
            for (const id of this.cards.keys()) if (!state.statistics.some(card => card.id === id)) this.cards.delete(id);
            this.signatures.cardIds = ids;
        }
        for (const card of state.statistics) {
            const row = this.cards.get(card.id);
            if (row.label.value !== card.label) row.label.value = card.label;
            if (row.expression.value !== card.expression) row.expression.value = card.expression;
            // A hidden, identically styled mirror sizes wrapped and multiline formulas without layout reads.
            if (row.equation.getAttribute("data-expression") !== card.expression) row.equation.setAttribute("data-expression", card.expression);
            if (row.sourceSignature !== sourceSignature) {
                const options = state.sources.map((source, index) => {
                    const option = this.element("option", source.label); option.value = String(index); return option;
                });
                if (!options.length) { const option = this.element("option", "Choose a Catalog raster"); option.value = ""; options.push(option); }
                row.source.replaceChildren(...options); row.sourceSignature = sourceSignature;
            }
            row.source.value = String(state.sources.findIndex(source => source.collectionId === card.source?.collectionId && source.itemId === card.source?.itemId));
            row.source.disabled = !state.sources.length;
            row.expression.setAttribute("aria-invalid", String(card.error && !card.valid));
            row.root.setAttribute("aria-busy", String(!!(card.pending || state.vectorSelecting)));
            row.root.classList.toggle("is-previous", !!card.result && !card.current);
            const message = card.current ? RESULT_STATES[card.result?.row.state] ?? "" : card.message;
            row.status.textContent = state.vectorCalculation && (card.pending || card.requested) && !message.startsWith("Calculating")
                ? `Calculating · ${message}` : message;
            row.status.hidden = !row.status.textContent;
            row.status.classList.toggle("is-error", card.error);
            row.status.classList.toggle("is-awaiting-map", !!card.awaitingMap);
            row.status.classList.toggle("is-working", card.pending || !!card.requested || card.checking);
            row.run.hidden = !state.area || card.current || card.pending || !!card.requested || !!state.vectorSelecting;
            row.run.disabled = !card.valid || card.checking || !card.source || !state.area || state.recoverable;
            row.stop.hidden = !card.pending && !card.requested && !state.vectorSelecting;
            row.statusRow.hidden = row.status.hidden && row.run.hidden && row.stop.hidden;
            const progress = card.progress;
            row.progress.hidden = !(card.pending || card.requested || state.vectorSelecting);
            if (progress?.phase === "calculating" && progress.totalBlocks > 0) {
                row.progress.max = progress.totalBlocks;
                row.progress.value = progress.completedBlocks ?? 0;
            } else {
                row.progress.removeAttribute("value");
            }
            const result = card.result;
            row.valueActions.hidden = !result;
            const text = result ? `${calculationValue(result.row)}${result.row.unit ? ` ${result.row.unit}` : ""}` : "";
            if (row.value.textContent !== text) row.value.textContent = text;
            row.value.title = result?.row.value ?? result?.row.state ?? "";
            row.details.hidden = !result;
            const resultSignature = JSON.stringify([result?.job.jobId, result?.row, result?.totalWaitSeconds]);
            const copyValue = card.current && result?.row.state === "ok" && result.row.value != null ? result.row.value : null;
            const copySignature = JSON.stringify([resultSignature, copyValue]);
            if (row.copySignature !== copySignature) {
                row.copyRevision++; row.copying = false; row.copyValue = copyValue; row.copySignature = copySignature;
                row.copyStatus.textContent = ""; row.copyStatus.hidden = true;
            }
            row.copy.hidden = !result;
            row.copy.disabled = row.copyValue === null || row.copying;
            row.copy.title = row.copyValue === null ? "Only current numeric values can be copied" : "Copy current value (exact)";
            if (result && resultSignature !== row.resultSignature) {
                this.renderValueDetails(row.detailsBody, result); row.resultSignature = resultSignature;
            }
            row.size.hidden = !card.manualRequired || card.current || card.pending || !!card.requested;
            const grid = card.plan?.grid;
            row.size.textContent = card.manualRequired ? grid
                ? `${grid.nativeBlocks.toLocaleString()} source blocks · ${formatDownloadBytes(grid.decodedBytes)} decoded. Calculate to confirm this scan.`
                : "This area requires Calculate to confirm the scan." : "";
        }
        const e = this.elements, x = this.extra;
        const areaSignature = state.areaChoice;
        if (areaSignature !== this.signatures.area) {
            e.area.replaceChildren(...[["selection", "Current map selection"], ["vector", "Vector layer"], ["whole", "Whole raster"]]
                .map(([value, label]) => { const option = this.element("option", label); option.value = value; return option; }));
            this.signatures.area = areaSignature;
        }
        e.area.value = state.areaChoice;
        this.vectorAreaControls.hidden = state.areaChoice !== "vector";
        e["edit-area"].hidden = state.areaChoice === "vector" || state.areaChoice === "whole";
        e["area-description"].textContent = state.area?.catalogSelection && state.area.catalogSelection === state.vectorArea?.id
            ? `Vector selection · ${state.vectorArea.label}` : state.areaChoice === "vector"
                ? "Choose a polygon layer below. Edit its filter, then use the matching features."
                : describeClipArea(state.area);
        x.auto.checked = state.automatic;
        x["chunk-pixels"].value = state.targetChunkPixels == null ? "" : String(state.targetChunkPixels);
        const planSignature = JSON.stringify(state.statistics.map(card => [card.label, card.plan?.grid]));
        if (planSignature !== this.signatures.performance) {
            x["performance-plans"].replaceChildren(...state.statistics.filter(card => card.plan?.grid.execution).map(card => {
                const row = this.element("div");
                row.append(this.element("strong", card.label || "Custom statistic"),
                    ...executionDescription(card.plan.grid).map(text => this.element("p", text)));
                return row;
            }));
            this.signatures.performance = planSignature;
        }
        e.template.disabled = state.statistics.length >= 5;
        x.undo.hidden = !state.undo;
        x["undo-button"].disabled = state.statistics.length >= 5;
        e.retry.hidden = !state.recoverable;
        x["recovery-status"].hidden = !state.recoverable;
        x["recovery-status"].textContent = state.recoveryMessage ?? "";
        x["saved-result"].hidden = !state.saved;
        if (state.saved && this.signatures.saved !== JSON.stringify(state.saved)) {
            renderSavedCalculation(e.result, state.saved, state.sources);
            x["saved-result"].open = true; this.signatures.saved = JSON.stringify(state.saved);
        }
        this.renderHistory(state);
        for (const opener of this.openers) opener.textContent = state.statistics.some(card => card.pending) ? "Summarize · working" : "Summarize";
    }
    /**
     * Copy the exact scalar from the current result, without display rounding or units.
     * Ignore completion if editing, replacement, removal, or teardown changes the card.
     * @param {number} id Stable statistic identifier.
     * @return {Promise<void>} Settles after clipboard feedback is presented, if still relevant.
     */
    async copyCurrentValue(id) {
        const row = this.cards.get(id);
        if (!row || row.copyValue == null || row.copying) return;
        const revision = row.copyRevision;
        row.copying = true; row.copy.disabled = true;
        const stillCurrent = () => this.cards.get(id) === row && row.copyRevision === revision;
        try {
            if (typeof this.clipboard?.writeText !== "function") throw new Error("Clipboard unavailable");
            await this.clipboard.writeText(String(row.copyValue));
            if (stillCurrent()) row.copyStatus.textContent = "Copied exact value";
        } catch {
            if (stillCurrent()) {
                row.copyStatus.textContent = "Could not copy. Select the exact value in Value details below.";
                row.details.open = true;
            }
        } finally {
            if (stillCurrent()) { row.copying = false; row.copy.disabled = false; row.copyStatus.hidden = false; }
        }
    }
    /** Release listeners and invalidate pending clipboard feedback. @return {void} */
    unbind() {
        for (const [node, event, callback] of this.listeners) node.removeEventListener(event, callback);
        this.listeners = [];
        this.cards.clear();
    }
    /** Render immutable context for one live card's result. @param {HTMLElement} root Details container. @param {Object} result Card result with row, job, source and area snapshots. @return {void} */
    renderValueDetails(root, result) {
        const { row, job, source, area } = result;
        root.replaceChildren(this.element("p", `${source.label} · ${describeClipArea(area)}`),
            this.element("code", row.expression), this.element("p", `Exact value: ${row.value ?? "undefined"}.${row.unit ? ` Result unit: ${row.unit}.` : ` Source unit: ${job.grid?.storedUnit || "unspecified"}; expressions may change units.`}`));
        if (RESULT_STATES[row.state]) root.append(this.element("p", RESULT_STATES[row.state]));
        for (const aggregate of row.aggregates ?? []) root.append(this.element("p", `${aggregate.function}: ${aggregate.matchedPixels.toLocaleString()} matched / ${aggregate.validPixels.toLocaleString()} valid cells; ${aggregate.invalidArithmeticPixels.toLocaleString()} excluded by arithmetic.`));
        if (job.grid?.groundArea) {
            const method = job.grid.groundArea;
            root.append(this.element("p", `Ground area: ${method.ellipsoid} ellipsoid, hectares, including partial pixels. ${method.edgeToleranceMetres} m chord-deviation target; at most ${method.maximumSegmentMetres.toLocaleString()} m per segment. Numeric functions select cell centers.`));
        }
        const performance = this.element("details");
        performance.append(this.element("summary", "Performance"), ...performanceDescription(job, result.totalWaitSeconds, result.stages).map(text => this.element("p", text)));
        root.append(performance);
        const links = this.element("div"); links.className = "downloads-actions";
        for (const [kind, label, url] of [["result", "Download CSV", job.result.url], ["provenance", "Download provenance", job.result.provenanceUrl]]) {
            const link = this.element("a", label); link.className = "secondary-button";
            link.href = processingDownloadUrl(url, job.jobId, kind); link.setAttribute("download", ""); links.append(link);
        }
        root.append(this.element("small", "Downloads preserve the formulas and names at the time of calculation."), links);
    }
    /** Render owned history actions when job snapshots change. @param {Object} state Summary snapshot containing jobs and historyError. @return {void} */
    renderHistory(state) {
        const signature = JSON.stringify([state.jobs, state.historyError]);
        if (signature === this.signatures.history) return;
        const children = state.jobs.filter(job => job.status !== "deleted").map(job => {
            const root = this.element("div"); root.className = "calculation-history-row";
            const inspect = this.element("button", `${job.calculations?.map(row => row.label).join(", ") ?? "Summary statistics"} · ${describeJobProgress(job)}`);
            inspect.type = "button"; inspect.className = "secondary-button";
            inspect.addEventListener("click", () => this.handlers.onInspect(job.jobId));
            const active = ACTIVE_JOB_STATES.has(job.status);
            const action = this.element("button", active ? "Cancel" : "Delete"); action.type = "button"; action.className = "secondary-button";
            action.disabled = job.status === "cancelling";
            action.addEventListener("click", () => active ? this.handlers.onCancel(job.jobId) : this.handlers.onDelete(job.jobId));
            root.append(inspect, this.element("small", `${new Date(job.createdAt).toLocaleString()} · ${describeClipArea(job.area)}`), action);
            return root;
        });
        this.elements.history.replaceChildren(this.element("p", state.historyError || "Results remain available for 24 hours in this browser session."), ...children);
        this.signatures.history = signature;
    }
    /** Focus a surviving formula after add/undo. @param {number} id Stable card identity. @return {void} */
    focusStatistic(id) { this.cards.get(id)?.expression.focus(); }
    /** Focus the editor entry point without inventing a statistic. @return {void} */
    focusAddStatistic() { this.elements.template.focus(); }
    /** Focus removal recovery. @return {void} */
    focusUndo() { this.extra["undo-button"].focus(); }
    /** Reveal the immutable saved-job presentation. @return {void} */
    focusSaved() { this.extra["saved-result"].open = true; this.extra["saved-result"].scrollIntoView({ block: "nearest" }); }
}
