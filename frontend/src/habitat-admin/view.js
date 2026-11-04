/** Present selected Habitat input coverage and administrator preparation history. */
import { VectorFilterControls } from "../vector/filter-controls.js";
import { EMPTY_VECTOR_FILTER, vectorFilterSummary } from "../vector/filter.js";
import { ACTIVE_PREPARATION_STATES } from "./api.js";

/** Format a retained server timestamp without inventing an unfinished job's deadline.
 * @param {string|null|undefined} value Server timestamp.
 * @return {string} Local date and time, or an unfinished-lifetime label.
 */
function timeLabel(value) { return value ? new Date(value).toLocaleString() : "After completion"; }

/** Present a preparation's lifecycle and last measured tile counts when available.
 * @param {Object} job Administrator job snapshot.
 * @return {string} Readable status, without estimating overall tile coverage.
 */
function jobStatus(job) {
    const status = job.status === "ready" && Date.parse(job.expiresAt) <= Date.now() ? "expired" : job.status;
    const labels = {queued: "Queued", running: "Preparing inputs", cancelling: "Cancelling…", ready: "Completed",
        failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", expired: "Report expired"};
    const progress = job.progress;
    return `${labels[status] ?? status}${progress?.completed != null && progress.total != null
        ? ` · ${progress.completed} of ${progress.total} tiles` : ""}`;
}

/** Own the standalone page's controls and stable rows without map dependencies. */
export class HabitatAdminView {
    /** Build administrator controls in the protected page's existing root.
     * @param {Document} [documentContext=globalThis.document] Owning page document.
     */
    constructor(documentContext = globalThis.document) {
        this.document = documentContext;
        this.root = documentContext.querySelector("#habitat-admin");
        this.listeners = []; this.cards = new Map(); this.yearControls = new Map();
        this.filter = structuredClone(EMPTY_VECTOR_FILTER); this.sourceKey = ""; this.sources = [];
        this.error = this.element("p", "", "habitat-error"); this.error.setAttribute("role", "alert");
        this.root.append(this.error);
        const selection = this.section("Choose areas and assessment years");
        selection.append(this.element("p", "Choose Catalog polygon layers and optional attribute conditions. Choosing inputs never starts a download."));
        this.searchForm = this.element("form", "", "habitat-inline");
        this.query = this.element("input"); this.query.type = "search";
        this.searchButton = this.button("Search polygon layers", () => this.handlers.search(this.query.value));
        this.searchForm.append(this.field("habitat-query", "Find polygon layers", this.query), this.searchButton);
        selection.append(this.searchForm);
        this.searchStatus = this.element("p"); this.searchStatus.setAttribute("role", "status"); selection.append(this.searchStatus);
        this.source = this.element("select");
        this.searchMore = this.button("Load more polygon layers", () => this.handlers.searchMore());
        selection.append(this.field("habitat-source", "Polygon layer", this.source), this.searchMore);
        this.name = this.element("input"); this.name.type = "text"; this.name.maxLength = 80;
        selection.append(this.field("habitat-area-name", "Area name (1–80 characters)", this.name));
        this.filterSummary = this.element("p");
        this.editFilter = this.button("Choose area conditions", () => this.openFilter());
        this.filterHost = this.element("div"); this.filterHost.id = "habitat-area-filter";
        this.addArea = this.button("Add area", () => this.handlers.addArea(this.name.value.trim(), this.sourceKey, structuredClone(this.filter)));
        selection.append(this.filterSummary, this.editFilter, this.filterHost, this.addArea);
        this.areas = this.element("div", "", "habitat-cards"); selection.append(this.areas);
        this.years = this.element("fieldset", "", "habitat-years"); this.years.append(this.element("legend", "Assessment years"));
        selection.append(this.years);
        const actions = this.element("div", "", "habitat-actions");
        this.check = this.button("Check cached inputs", () => this.handlers.check());
        this.prepare = this.button("Prepare inputs", () => this.handlers.prepare()); actions.append(this.check, this.prepare); selection.append(actions);
        const coverage = this.section("Checked area coverage");
        coverage.append(this.element("p", "Coverage is a snapshot for these areas and years, not a complete cache inventory. Cached tiles do not guarantee valid observations in every dataset."));
        this.coverageStatus = this.element("p"); this.coverageStatus.setAttribute("role", "status");
        this.coverage = this.element("div", "", "habitat-cards"); coverage.append(this.coverageStatus, this.coverage);
        const preparation = this.section("Requested preparations");
        preparation.append(this.element("p", "Each area and year is a separate job. Completed jobs are counted separately even when their areas overlap."));
        this.submissionStatus = this.element("p"); this.submissionStatus.setAttribute("role", "status");
        this.submissions = this.element("div", "", "habitat-cards"); preparation.append(this.submissionStatus, this.submissions);
        const history = this.section("Preparation history");
        history.append(this.element("p", "Accepted work continues after you leave this page. Interrupted jobs need an explicit retry; completed tiles are reused. History records completed work, not current cache coverage."));
        this.refresh = this.button("Refresh history", () => this.handlers.refreshHistory());
        this.historyStatus = this.element("p"); this.historyStatus.setAttribute("role", "status");
        this.history = this.element("div", "", "habitat-cards");
        this.more = this.button("Load older preparations", () => this.handlers.loadMore()); history.append(this.refresh, this.historyStatus, this.history, this.more);
        this.listen(this.source, "change", () => this.changeSource());
        this.listen(this.name, "input", () => this.updateAreaControls());
        this.listen(this.searchForm, "submit", event => { event.preventDefault(); this.handlers.search(this.query.value); });
    }

    /** Create an element using text content only.
     * @param {string} tag Element tag.
     * @param {string} [text=""] Visible text.
     * @param {string} [className=""] Scoped presentation class.
     * @return {HTMLElement} New element.
     */
    element(tag, text = "", className = "") {
        const node = this.document.createElement(tag); node.textContent = text; node.className = className; return node;
    }

    /** Append a named section to the page.
     * @param {string} title Section heading.
     * @return {HTMLElement} Section ready for its controls.
     */
    section(title) { const section = this.element("section"); section.append(this.element("h2", title)); this.root.append(section); return section; }

    /** Label a stable input control.
     * @param {string} id Unique input ID.
     * @param {string} title Visible label.
     * @param {HTMLElement} control Labelled control.
     * @return {HTMLElement} Label containing the control.
     */
    field(id, title, control) { control.id = id; const label = this.element("label", title); label.htmlFor = id; label.append(control); return label; }

    /** Bind a DOM listener that teardown can release.
     * @param {HTMLElement} node Event target.
     * @param {string} event Event name.
     * @param {Function} callback User action.
     * @return {void}
     */
    listen(node, event, callback) { node.addEventListener(event, callback); this.listeners.push([node, event, callback]); }

    /** Make an explicit action button.
     * @param {string} label Visible action.
     * @param {Function} callback User action.
     * @return {HTMLButtonElement} Bound button.
     */
    button(label, callback) { const button = this.element("button", label); button.type = "button"; this.listen(button, "click", callback); return button; }

    /** Connect controls to the owning controller's semantic actions.
     * @param {Object<string,Function>} handlers Search, selection, coverage and job actions.
     * @return {void}
     */
    bind(handlers) { this.handlers = handlers; }

    /** Reset the predicate and suggest a valid name when the area name is blank.
     * Use the last nonempty part of a Catalog label, limited to 80 Unicode characters.
     * Preserve names already entered in the form and the original Catalog source identity.
     * @return {void}
     */
    changeSource() {
        this.filterControls?.destroy(); this.filterControls = null; this.filterHost.replaceChildren(); this.editingFilter = false;
        this.sourceKey = this.source.value; this.filter = structuredClone(EMPTY_VECTOR_FILTER);
        const source = this.sources.find(source => source.key === this.sourceKey);
        if (!this.name.value.trim() && source) {
            const label = source.label.split(/[\\/]/).map(part => part.trim()).filter(Boolean).at(-1) || "Area";
            this.name.value = [...label].slice(0, 80).join("");
        }
        this.updateAreaControls();
    }

    /** Enable area admission only for a named source with no unapplied editor draft.
     * @return {void}
     */
    updateAreaControls() {
        const selected = this.sources.some(source => source.key === this.sourceKey);
        this.addArea.disabled = !selected || !this.name.value.trim() || this.editingFilter || this.busy;
        this.editFilter.disabled = !selected || this.busy;
        this.filterSummary.textContent = vectorFilterSummary(this.filter);
    }

    /** Edit a Catalog predicate with the existing feature-rule controls.
     * Applying only stores the predicate in this form; it does not inspect or download data.
     * @return {void}
     */
    openFilter() {
        const source = this.sources.find(source => source.key === this.sourceKey);
        if (!source) return;
        this.filterControls?.destroy(); this.editingFilter = true; this.updateAreaControls();
        const target = {label: source.label, fields: source.fields, source: source.selection, filter: this.filter};
        this.filterControls = new VectorFilterControls({host: this.filterHost, documentContext: this.document,
            getTarget: key => key === source.key ? target : null});
        this.filterControls.open(source.key, {filter: this.filter,
            apply: async filter => filter,
            complete: filter => { this.filter = structuredClone(filter); this.editingFilter = false; this.updateAreaControls(); },
            cancel() {}, onClose: () => { this.editingFilter = false; this.updateAreaControls(); },
            applyLabel: "Use these area conditions", filterLabel: "Area conditions",
            help: "Save these conditions for the area you will add. This does not check cached inputs or start preparation."});
    }

    /** Keep keyed cards and their focused controls stable during status updates.
     * @param {string} group Row category.
     * @param {HTMLElement} host Card container.
     * @param {Object[]} values Current rows.
     * @param {(value:Object)=>string} key Row identity.
     * @param {(value:Object)=>Object} create Construct a card and its controls.
     * @param {(card:Object,value:Object)=>void} update Refresh existing text and state.
     * @return {void}
     */
    renderCards(group, host, values, key, create, update) {
        const retained = new Set();
        for (const [index, value] of values.entries()) {
            const id = `${group}:${key(value)}`; retained.add(id);
            let card = this.cards.get(id);
            if (!card) { card = create(value); this.cards.set(id, card); host.append(card.root); }
            const focused = this.document.activeElement;
            if (host.children[index] !== card.root) {
                host.insertBefore(card.root, host.children[index] ?? null);
                if (card.root.contains(focused)) focused.focus();
            }
            update(card, value);
            if (card.root.contains(focused) && (focused.hidden || focused.disabled)) card.title.focus();
        }
        for (const [id, card] of this.cards) if (id.startsWith(`${group}:`) && !retained.has(id)) {
            if (card.root.contains(this.document.activeElement)) this.refresh.focus();
            this.listeners = this.listeners.filter(([node, event, callback]) => {
                if (!card.root.contains(node)) return true;
                node.removeEventListener(event, callback); return false;
            });
            card.root.remove(); this.cards.delete(id);
        }
    }

    /** Create a text card for a selected area, coverage snapshot or submission.
     * @return {Object} Card elements ready for content and optional actions.
     */
    textCard() {
        const root = this.element("article", "", "habitat-card"), title = this.element("h3"), detail = this.element("p"), error = this.element("p", "", "habitat-error");
        title.tabIndex = -1; root.append(title, detail, error); return {root, title, detail, error};
    }

    /** Create a job card whose buttons remain stable while progress changes.
     * @param {Object} job Administrator job with a fixed public ID.
     * @return {Object} Card elements and bound lifecycle actions.
     */
    jobCard(job) {
        const card = this.textCard(); card.times = this.element("p", "", "habitat-times");
        card.cancel = this.button("Cancel", () => this.handlers.cancel(job.jobId));
        card.retry = this.button("Retry missing inputs", () => this.handlers.retry(job.jobId));
        card.report = this.element("a", "Download report"); card.provenance = this.element("a", "Download provenance");
        const actions = this.element("div", "", "habitat-actions"); actions.append(card.cancel, card.retry, card.report, card.provenance);
        card.root.append(card.times, actions); return card;
    }

    /** Refresh state without replacing active form edits or focused history controls.
     * @param {Object} state Controller snapshot with sources, selected areas, checks and jobs.
     * @return {void}
     */
    render(state) {
        this.busy = Boolean(state.submitting); this.sources = state.sources;
        this.error.textContent = state.error; this.error.hidden = !state.error;
        const choices = [["", "Choose a polygon layer…"], ...state.sources.map(source => [source.key, source.label])];
        const signature = JSON.stringify(choices);
        if (signature !== this.sourceSignature) {
            this.sourceSignature = signature;
            this.source.replaceChildren(...choices.map(([value, label]) => { const option = this.element("option", label); option.value = value; return option; }));
            this.source.value = this.sourceKey;
        }
        this.searchButton.disabled = Boolean(state.searching); this.searchMore.hidden = !state.nextSearch; this.searchMore.disabled = Boolean(state.searching);
        this.searchStatus.textContent = state.searchError || (state.searching ? "Searching polygon layers…" : `${state.sources.length} polygon layers available.`);
        this.updateAreaControls();
        this.renderCards("area", this.areas, state.areas, area => area.id, area => {
            const card = this.textCard(); card.remove = this.button("Remove area", () => this.handlers.removeArea(area.id)); card.root.append(card.remove); return card;
        }, (card, area) => { card.title.textContent = area.name; card.detail.textContent = area.filterSummary; card.error.hidden = true; card.remove.disabled = this.busy; });
        if (state.options && !this.yearControls.size) for (let year = state.options.minimumYear; year <= state.options.maximumYear; year++) {
            const input = this.element("input"); input.type = "checkbox"; input.value = String(year);
            this.listen(input, "change", () => this.handlers.setYears([...this.yearControls].filter(([, control]) => control.checked).map(([value]) => value)));
            this.yearControls.set(year, input); this.years.append(this.field(`habitat-year-${year}`, String(year), input));
        }
        for (const [year, input] of this.yearControls) { input.checked = state.years.includes(year); input.disabled = this.busy; }
        this.check.disabled = !state.areas.length || !state.years.length || state.checking || this.busy;
        this.check.textContent = state.checking ? "Checking cached inputs…" : "Check cached inputs";
        this.prepare.disabled = !state.canPrepare || this.busy; this.prepare.textContent = this.busy ? "Submitting preparations…" : "Prepare inputs";
        this.coverageStatus.textContent = state.checking ? "Checking selected areas and years…" : state.coverageRows.length ? "Last checks for selected areas and years" : "No cache checks yet.";
        this.renderCards("coverage", this.coverage, state.coverageRows, row => row.key, () => this.textCard(), (card, row) => {
            card.title.textContent = `${row.name} · ${row.year}`;
            card.detail.textContent = row.coverage ? `${row.coverage.cachedTiles} cached · ${row.coverage.missingTiles} missing · ${row.coverage.requiredTiles} required tiles. Checked ${timeLabel(row.checkedAt)}.` : "Not checked yet.";
            card.error.textContent = row.error || ""; card.error.hidden = !row.error;
        });
        this.submissionStatus.textContent = state.requestedJobs ? `${state.completedJobs} of ${state.requestedJobs} requested jobs completed.` :
            state.submissions.length ? "No preparations have been confirmed yet. Review the submissions below." : "No preparations requested from this page yet.";
        this.renderCards("submission", this.submissions, state.submissions, row => row.key, row => {
            const card = this.textCard(); card.recover = this.button("Recover submission", () => this.handlers.recover(row.key)); card.root.append(card.recover); return card;
        }, (card, row) => {
            card.title.textContent = `${row.name} · ${row.year}`;
            card.detail.textContent = ({submitting: "Submitting…", uncertain: "The submission result is unknown. Recover it using the original request.", accepted: "Accepted; see preparation history for progress.",
                failed: row.kind === "retry" ? "Submission failed. Address the error, then use Retry missing inputs on the original job." : "Submission failed. Address the error, then use Prepare inputs to try again."})[row.status] ?? row.status;
            card.error.textContent = row.error || ""; card.error.hidden = !row.error;
            card.recover.hidden = row.status !== "uncertain"; card.recover.disabled = this.busy;
        });
        this.historyStatus.textContent = state.historyError || (state.historyLoading ? "Loading preparation history…" : state.jobs.length ? "Preparation history is up to date." : "No retained preparations yet.");
        this.refresh.disabled = Boolean(state.historyLoading); this.more.hidden = !state.nextCursor; this.more.disabled = Boolean(state.historyLoading);
        this.renderCards("job", this.history, state.jobs, job => job.jobId, job => this.jobCard(job), (card, job) => {
            const inputs = job.metadataExpiresAt != null && Date.parse(job.metadataExpiresAt) <= Date.now() ? null : job.inputs;
            const status = job.status === "ready" && Date.parse(job.expiresAt) <= Date.now() ? "expired" : job.status;
            card.title.textContent = inputs ? `${inputs.name} · ${inputs.year}` : "Preparation details expired";
            card.detail.textContent = jobStatus(job); card.error.textContent = job.error?.detail ?? ""; card.error.hidden = !job.error;
            const reportExpiry = ACTIVE_PREPARATION_STATES.has(job.status) ? "After completion" : timeLabel(job.expiresAt);
            card.times.textContent = `Updated ${timeLabel(job.updatedAt)} · Report expires ${reportExpiry} · Saved inputs expire ${timeLabel(job.metadataExpiresAt)}`;
            card.cancel.hidden = !ACTIVE_PREPARATION_STATES.has(job.status); card.cancel.disabled = this.busy || job.status === "cancelling";
            card.cancel.setAttribute("aria-label", `Cancel preparation for ${inputs?.name ?? "this area"} ${inputs?.year ?? ""}`.trim());
            const retryCommand = state.submissions.find(row => row.kind === "retry" && row.sourceJobId === job.jobId && ["accepted", "uncertain", "submitting"].includes(row.status));
            const retryLabel = retryCommand ? ({accepted: "Retry requested", uncertain: "Retry needs recovery", submitting: "Submitting retry…"})[retryCommand.status] : "Retry missing inputs";
            card.retry.hidden = !inputs || !["failed", "cancelled", "interrupted", "expired"].includes(status); card.retry.disabled = this.busy || Boolean(retryCommand);
            card.retry.textContent = retryLabel;
            card.retry.setAttribute("aria-label", `${retryLabel} for ${inputs?.name ?? "this area"} ${inputs?.year ?? ""}`.trim());
            card.report.setAttribute("aria-label", `Download report for ${inputs?.name ?? "this preparation"} ${inputs?.year ?? ""}`.trim());
            card.provenance.setAttribute("aria-label", `Download provenance for ${inputs?.name ?? "this preparation"} ${inputs?.year ?? ""}`.trim());
            const available = job.status === "ready" && job.result && Date.parse(job.expiresAt) > Date.now();
            card.report.hidden = card.provenance.hidden = !available;
            if (available) { card.report.href = job.result.url; card.provenance.href = job.result.provenanceUrl; }
        });
    }

    /** Release filter suggestions and every view-owned action listener.
     * @return {void}
     */
    destroy() {
        this.filterControls?.destroy();
        for (const [node, event, callback] of this.listeners) node.removeEventListener(event, callback);
        this.listeners = [];
    }
}
