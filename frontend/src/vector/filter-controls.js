/** Focused, debounced vector filter editor; composition supplies map actions. */

import {
    EMPTY_VECTOR_FILTER, MAX_VECTOR_FILTER_RULES, normalizeVectorFilter,
    vectorFilterFieldKind, vectorFilterOperators, vectorFilterSummary,
} from "./filter.js";
import { getVectorFieldValues } from "./api.js";
import { VectorFilterValuePicker } from "./filter-value-picker.js";

/** Own a rule-builder panel without reaching into style or inspection peers. */
export class VectorFilterControls {
    /**
     * Bind a dedicated non-modal vector Filter panel.
     * @param {Object} options Panel dependencies.
     * @param {(key:string)=>(Object & {source?:import("./api.js").VectorFieldValueSource})|null} options.getTarget Composition-owned target lookup; an immutable source identity enables prepared values.
     * @param {Object} options.inspection Neutral dock presentation.
     * @param {HTMLElement|null} [options.host=null] Inline container; keeps editing in the caller's panel.
     * @param {Document} [options.documentContext=document] Owning document.
     * @param {Function} [options.setTimer] Debounce scheduler.
     * @param {Function} [options.clearTimer] Debounce canceller.
     * @param {typeof getVectorFieldValues} [options.loadValues=getVectorFieldValues] Prepared-value lookup; targets with a path-free source enable suggestions.
     */
    constructor({ getTarget, inspection, host = null, documentContext = document,
        setTimer = (handler, delay) => globalThis.setTimeout(handler, delay),
        clearTimer = (timer) => globalThis.clearTimeout(timer), loadValues = getVectorFieldValues }) {
        this.document = documentContext;
        this.getTarget = getTarget;
        this.inspection = inspection;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.host = host;
        this.loadValues = loadValues;
        this.valuePickers = [];
        const template = documentContext.querySelector("#vector-filter-panel");
        this.root = host ? template.cloneNode(true) : template;
        const controls = {title: "vector-filter-title", rules: "vector-filter-rules", enabled: "vector-filter-enabled",
            match: "vector-filter-match", status: "vector-filter-status", applied: "vector-filter-applied",
            count: "vector-filter-count", add: "vector-filter-add", clear: "vector-filter-clear",
            closeButton: "close-vector-filter", applyButton: "vector-filter-apply", cancelButton: "vector-filter-cancel", help: "vector-filter-help"};
        for (const [name, id] of Object.entries(controls)) {
            this[name] = host ? this.root.querySelector(`#${id}`) : documentContext.querySelector(`#${id}`);
            if (host) this[name].id = `${host.id}-${name}`;
        }
        if (host) {
            this.root.id = `${host.id}-panel`; this.root.className = "vector-filter-inline";
            this.root.setAttribute("role", "group"); this.root.removeAttribute("aria-labelledby");
            this.root.setAttribute("aria-label", "Filter features");
            this.title.hidden = this.applied.hidden = this.count.hidden = true;
            host.replaceChildren(this.root);
        }
        this.attempt = 0;
        this.key = null;
        this.timer = null;
        this.generation = 0;
        this.listeners = [];
        this.#listen(this.enabled, "change", () => { this.draft.enabled = this.enabled.checked; this.#changed(); });
        this.#listen(this.match, "change", () => { this.draft.match = this.match.value; this.#changed(); });
        this.#listen(this.add, "click", () => {
            const target = this.getTarget(this.key);
            if (!target || this.draft.rules.length >= MAX_VECTOR_FILTER_RULES) return;
            const field = target.fields[0];
            this.draft.rules.push({ field: field?.name ?? "", operator: vectorFilterOperators(field?.type)[0].value, value: "" });
            this.#renderRules(); this.#changed();
            this.rules.lastElementChild?.querySelector("select")?.focus();
        });
        this.#listen(this.clear, "click", () => {
            this.draft = structuredClone(EMPTY_VECTOR_FILTER);
            this.#renderDraft(); this.#changed(true);
        });
        this.#listen(this.closeButton, "click", () => this.close());
        this.#listen(this.applyButton, "click", () => { this.#cancelTimer(); void this.#apply(); });
        this.#listen(this.cancelButton, "click", () => {
            this.attempt++;
            this.action?.cancel();
            this.cancelButton.hidden = true;
            this.applyButton.disabled = false;
            this.status.textContent = "Selection cancelled. Edit the conditions or apply again.";
        });
        this.#listen(this.root, "keydown", (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault(); event.stopPropagation(); this.close();
        });
    }

    /**
     * Edit the chosen vector's current filter, discarding unapplied edits from a closed editor.
     * @param {string} key Layer or composed analysis-target identity.
     * @param {Object|null} [action=null] Explicit analysis action supplied by composition.
     * @param {Function} action.apply Apply a complete predicate and return success or null.
     * @param {Function} action.complete Present the successfully selected area.
     * @param {Function} action.cancel Cancel the explicitly applied selection.
     * @param {Object|null} action.filter Current analysis predicate, if selected.
     * @param {string} [action.applyLabel] Action label; defaults to selecting features and calculating statistics.
     * @param {string} [action.help] Description of the action's effect.
     * @param {string} [action.filterLabel] Name for the action's applied predicate.
     * @param {()=>void} [action.onClose] Release action-owned preparation when the panel closes or changes targets.
     * @param {Object} [options={}] Callbacks for this opening of the ordinary map filter.
     * @param {unknown} [options.applyContext] Opaque caller value forwarded unchanged to the ordinary target's apply callback.
     * @param {()=>void} [options.onApplied] Commit a caller-owned intent after changed rules are accepted.
     * Not called for analysis actions, unchanged rules, closed/replaced editors, failures or stale replies.
     * @return {void}
     */
    open(key, action = null, {onApplied = () => {}, applyContext} = {}) {
        const target = this.getTarget(key);
        if (!target) return;
        if (this.key !== null) {
            this.action?.onClose?.();
            if (this.timer !== null) void this.#apply();
        }
        this.#cancelTimer();
        this.key = key;
        this.action = action;
        this.onApplied = onApplied;
        this.applyContext = applyContext;
        this.cancelButton.hidden = true;
        this.generation++;
        this.applyButton.textContent = action?.applyLabel ?? (action ? "Use filtered features & calculate" : "Apply filter");
        this.help.textContent = action?.help ?? (action
            ? "Use every matching polygon as the sampling area and calculate configured statistics. The sampling filter is independent of map styling and visibility."
            : "Counts cover the whole layer. Filtering also applies to labels, feature inspection, and new feature plots. Colors and class ranges stay the same.");
        this.opener = this.document.activeElement;
        this.draft = structuredClone(action?.filter ?? target.filter ?? EMPTY_VECTOR_FILTER);
        this.title.textContent = target.label;
        this.#renderDraft();
        this.refresh();
        this.#validate();
        if (this.host) this.root.hidden = false;
        else this.inspection.showFilter(target.label);
        this.closeButton.focus();
    }

    /** Refresh the layer name, applied state and counts without disrupting typing or activating the panel. @return {void} */
    refresh() {
        if (this.key === null) return;
        const target = this.getTarget(this.key);
        if (!target) { this.close(); return; }
        this.title.textContent = target.label;
        if (!this.host) this.inspection.updateLayerEditorName("filter", target.label);
        this.applied.textContent = this.action
            ? `${this.action.filterLabel ?? "Sampling filter"}: ${vectorFilterSummary(this.action.filter ?? target.filter)}`
            : `Applied: ${vectorFilterSummary(target.filter)}`;
        this.count.textContent = this.action ? "The complete selection is checked when you apply." : target.status || "All features are included.";
        this.add.disabled = target.fields.length === 0 || this.draft.rules.length >= MAX_VECTOR_FILTER_RULES;
    }

    /** Apply pending map edits, release action preparation, hide the panel and restore focus. @return {void} */
    close() {
        if (this.key === null) return;
        this.#clearValuePickers();
        if (this.timer !== null) { this.#cancelTimer(); if (!this.action) void this.#apply(); }
        this.action?.onClose?.();
        this.key = null;
        if (this.host) this.root.hidden = true;
        else this.inspection.hideFilter();
        if (this.opener?.isConnected && !this.opener.disabled) this.opener.focus();
    }

    /** Detach panel listeners and cancel timers on teardown. @return {void} */
    destroy() {
        this.destroyed = true;
        this.pendingAction?.cancel();
        this.#cancelTimer();
        this.#clearValuePickers();
        this.generation++;
        for (const [element, type, listener] of this.listeners) element.removeEventListener(type, listener);
        this.listeners = [];
    }

    /**
     * Track a fixed DOM listener for teardown.
     * @param {Element} element Event target.
     * @param {string} type Event type.
     * @param {Function} listener Event listener.
     * @return {void}
     */
    #listen(element, type, listener) {
        element.addEventListener(type, listener);
        this.listeners.push([element, type, listener]);
    }

    /** Cancel scheduled edits without changing the applied filter. @return {void} */
    #cancelTimer() {
        if (this.timer !== null) this.clearTimer(this.timer);
        this.timer = null;
    }

    /**
     * Validate input and schedule only complete rules.
     * @param {boolean} [immediate=false] Apply a complete clear/disable action now.
     * @return {void}
     */
    #changed(immediate = false) {
        this.generation++;
        if (!this.action) this.getTarget(this.key)?.cancelPending();
        this.#cancelTimer();
        if (!this.#validate()) return;
        if (this.action) { this.refresh(); return; }
        this.status.textContent = "Changes will apply automatically…";
        if (immediate) void this.#apply();
        else this.timer = this.setTimer(() => { this.timer = null; void this.#apply(); }, 450);
        this.refresh();
    }

    /** Validate the draft and explain any retained prior filter. @return {Object|null} */
    #validate() {
        const target = this.getTarget(this.key);
        if (!target) return null;
        try {
            const candidate = normalizeVectorFilter(this.draft, target.fields);
            this.status.textContent = this.action ? "Apply when all conditions are ready. Text comparisons are case-sensitive." : "Changes apply automatically. Text comparisons are case-sensitive.";
            this.status.classList.remove("is-error");
            this.applyButton.disabled = false;
            return candidate;
        } catch (error) {
            this.status.textContent = `${error.message} The previous applied filter remains in use.`;
            this.status.classList.add("is-error");
            this.applyButton.disabled = true;
            return null;
        }
    }

    /** Apply a captured target; stale replies cannot overwrite another draft. @return {Promise<void>} */
    async #apply() {
        const target = this.getTarget(this.key);
        const candidate = this.#validate();
        if (!target || !candidate) return;
        const key = this.key, generation = this.generation;
        const action = this.action, onApplied = this.onApplied, applyContext = this.applyContext;
        const previousFilter = JSON.stringify(target.filter);
        const attempt = ++this.attempt;
        this.pendingAction = action;
        this.status.textContent = "Applying filter…";
        this.applyButton.disabled = true;
        this.cancelButton.hidden = !action;
        try {
            const result = await (action ? action.apply(candidate) : target.apply(candidate, applyContext));
            if (result === null || attempt !== this.attempt || this.destroyed) return;
            if (action) {
                if (key === this.key && generation === this.generation) this.close();
                action.complete(result);
                return;
            }
            if (key !== this.key || generation !== this.generation) return;
            const accepted = this.getTarget(key);
            if (accepted && previousFilter !== JSON.stringify(accepted.filter)) onApplied();
            this.status.textContent = "Filter applied. Changes apply automatically.";
            this.refresh();
        } catch (error) {
            if (key !== this.key || generation !== this.generation || attempt !== this.attempt || error.name === "AbortError") return;
            this.status.textContent = action ? `${error.message} No new sampling area was selected.`
                : `${error.message} The previous applied filter remains in use.`;
            this.status.classList.add("is-error");
        } finally {
            if (attempt === this.attempt) this.pendingAction = null;
            if (attempt === this.attempt) this.cancelButton.hidden = true;
            if (key === this.key && generation === this.generation && attempt === this.attempt) this.applyButton.disabled = false;
        }
    }

    /** Render fixed options and rule rows for a newly selected draft. @return {void} */
    #renderDraft() {
        this.enabled.checked = this.draft.enabled;
        this.match.value = this.draft.match;
        this.#renderRules();
    }

    /** Release suggestions when closing, replacing a source or rebuilding rules. @return {void} */
    #clearValuePickers() {
        for (const picker of this.valuePickers) picker.destroy();
        this.valuePickers = [];
    }

    /** Render accessible field/operator/value rows; input edits keep focus. @return {void} */
    #renderRules() {
        this.#clearValuePickers();
        const target = this.getTarget(this.key);
        const fields = target?.fields ?? [];
        const source = target?.source, key = this.key;
        this.rules.replaceChildren(...this.draft.rules.map((rule, index) => {
            const row = this.document.createElement("div"); row.className = "vector-filter-rule";
            const select = (label, options, selected) => {
                const element = this.document.createElement("select");
                element.setAttribute("aria-label", `Condition ${index + 1} ${label}`);
                for (const { value, label: text } of options) {
                    const option = this.document.createElement("option"); option.value = value; option.textContent = text; element.append(option);
                }
                element.value = selected;
                return element;
            };
            const field = select("field", fields.map(({ name }) => ({ value: name, label: name })), rule.field);
            const type = fields.find(({ name }) => name === rule.field)?.type;
            const operator = select("comparison", vectorFilterOperators(type), rule.operator);
            field.addEventListener("change", () => {
                rule.field = field.value;
                const options = vectorFilterOperators(fields.find(({ name }) => name === rule.field)?.type);
                rule.operator = options[0].value; rule.value = "";
                this.#renderRules(); this.#changed();
                this.rules.children[index]?.querySelectorAll("select")[1]?.focus();
            });
            operator.addEventListener("change", () => {
                rule.operator = operator.value;
                rule.value = ["missing", "present"].includes(rule.operator) ? null : "";
                this.#renderRules(); this.#changed();
                this.rules.children[index]?.querySelectorAll("select")[1]?.focus();
            });
            row.append(field, operator);
            if (!["missing", "present"].includes(rule.operator)) {
                const kind = vectorFilterFieldKind(type);
                const input = kind === "boolean" ? select("value", [
                    { value: "", label: "Choose value" }, { value: "true", label: "True" }, { value: "false", label: "False" },
                ], String(rule.value)) : this.document.createElement("input");
                if (kind !== "boolean") {
                    input.type = kind === "number" ? "number" : kind === "date" ? "date" : "text";
                    input.step = "any"; input.maxLength = 256; input.value = rule.value ?? "";
                    input.placeholder = kind === "number" ? "Enter number" : "Enter value";
                    input.setAttribute("aria-label", `Condition ${index + 1} value`);
                }
                input.addEventListener(kind === "boolean" ? "change" : "input", () => {
                    rule.value = kind === "number" ? (input.value.trim() === "" ? "" : Number(input.value)) :
                        kind === "boolean" ? (input.value === "" ? "" : input.value === "true") : input.value;
                    this.#changed();
                });
                row.append(input);
                if (kind === "string" && source) {
                    const picker = new VectorFilterValuePicker({documentContext: this.document, input,
                        field: rule.field, condition: index + 1, setTimer: this.setTimer, clearTimer: this.clearTimer,
                        isCurrent: () => !this.destroyed && this.key === key && this.getTarget(key) !== null,
                        loadValues: (query, signal) => this.loadValues(source, query, signal),
                        acceptsValue: value => {
                            try {
                                normalizeVectorFilter({enabled: true, match: "all", rules: [{...rule, value}]}, fields);
                                return true;
                            } catch { return false; }
                        },
                        selectValue: value => { rule.value = value; input.value = value; this.#changed(); },
                    });
                    input.addEventListener("input", () => picker.close());
                    this.valuePickers.push(picker); row.append(picker.root);
                }
            }
            const remove = this.document.createElement("button"); remove.type = "button"; remove.className = "secondary-button";
            remove.textContent = "Remove"; remove.setAttribute("aria-label", `Remove condition ${index + 1}`);
            remove.addEventListener("click", () => { this.draft.rules.splice(index, 1); this.#renderRules(); this.#changed(); this.add.focus(); });
            row.append(remove);
            return row;
        }));
        this.add.disabled = fields.length === 0 || this.draft.rules.length >= MAX_VECTOR_FILTER_RULES;
    }
}
