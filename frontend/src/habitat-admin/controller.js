/** Prepare named Catalog areas and observe administrator-owned Habitat jobs. */
import { ACTIVE_PREPARATION_STATES } from "./api.js";
import { validateVectorSelection } from "../selected-area.js";
import { EMPTY_VECTOR_FILTER, normalizeVectorFilter, vectorFilterSummary } from "../vector/filter.js";

const PENDING_KEY = "eolab.habitatAdmin.pending.v1";
const RETRY_STATES = new Set(["failed", "cancelled", "interrupted", "expired"]);

/** Identify one exact Catalog predicate and assessment year, independently of its label.
 * @param {Object} selection Validated immutable Catalog selection.
 * @param {number} year Assessment year.
 * @returns {string} Stable local queue identity, never a server source locator.
 */
function preparationKey(selection, year) { return JSON.stringify([selection, year]); }

/** Own explicit cache inventory/coverage reads, recoverable submissions and preparation history. */
export class HabitatAdminController {
    /** Connect the Habitat admin view to existing source and job APIs.
     * @param {Object} dependencies Feature-local dependencies.
     * @param {import("./api.js").HabitatAdminApi} dependencies.api Authenticated admin transport.
     * @param {{bind:(handlers:Object)=>void,render:(state:Object)=>void,destroy?:()=>void}} dependencies.view Presentation boundary.
     * @param {Document} [dependencies.documentContext=globalThis.document] Visibility event source.
     * @param {Window} [dependencies.windowContext=globalThis.window] Page lifecycle event source.
     * @param {{setTimeout:Function,clearTimeout:Function}} [dependencies.clock=globalThis] Polling scheduler.
     * @param {()=>string} [dependencies.newId] Generate stable command and local area identities.
     * @param {Storage|null} [dependencies.storage] Browser storage for exact uncertain commands; defaults to this window's localStorage, excluding credentials.
     */
    constructor({ api, view, documentContext = globalThis.document, windowContext = globalThis.window,
        clock = globalThis, newId = () => globalThis.crypto.randomUUID().replaceAll("-", ""), storage }) {
        Object.assign(this, { api, view, clock, newId, storage });
        this.document = documentContext; this.window = windowContext;
        if (storage === undefined) {
            try { this.storage = windowContext?.localStorage ?? null; } catch { this.storage = null; }
        }
        this.state = { options: null, sources: [], searching: false, searchError: "", nextSearch: null,
            areas: [], years: [], coverageRows: [], checking: false, submissions: [], jobs: [], nextCursor: null,
            inventory: null, inventoryLoading: false, inventoryError: "", inventoryCheckedAt: null,
            historyLoading: false, historyError: "", error: "", submitting: false, canPrepare: false, requestedJobs: 0, completedJobs: 0 };
        this.jobs = new Map(); this.jobMutations = new Map(); this.mutationRevision = 0;
        this.readControllers = new Set(); this.mutationControllers = new Set();
        this.searchRevision = 0; this.coverageRevision = 0; this.historyRevision = 0; this.inventoryRevision = 0;
        this.started = false; this.destroyed = false; this.pageHidden = false; this.yearsEdited = false;
        this.historyPaged = false; this.timer = null; this.query = "";
        this.onVisibility = () => this.isVisible() ? this.resume() : this.suspend();
        this.onPageHide = () => { this.pageHidden = true; this.suspend(); };
        this.onPageShow = () => { this.pageHidden = false; this.resume(); };
        view.bind({ search: query => this.search(query), searchMore: () => this.searchMore(),
            addArea: (name, key, filter) => this.addArea(name, key, filter), removeArea: id => this.removeArea(id),
            setYears: years => this.setYears(years), check: () => this.check(), prepare: () => this.prepare(),
            recover: key => this.recover(key), refreshHistory: () => this.refreshHistory(), loadMore: () => this.loadMore(),
            cancel: id => this.cancel(id), retry: id => this.retry(id), refreshInventory: () => this.refreshInventory() });
    }

    /** Restore uncertain commands without posting them and load visible metadata/history.
     * @returns {Promise<void>} Resolves after initial visible reads settle.
     */
    async start() {
        if (this.started || this.destroyed) return;
        this.started = true; this.restorePending();
        this.document?.addEventListener("visibilitychange", this.onVisibility);
        this.window?.addEventListener("pagehide", this.onPageHide);
        this.window?.addEventListener("pageshow", this.onPageShow);
        this.render();
        await this.resume();
    }

    /** Determine whether browser-owned reads should run.
     * @returns {boolean} True while the page is visible and has not been disposed.
     */
    isVisible() { return !this.destroyed && !this.pageHidden && this.document?.visibilityState !== "hidden" && !this.document?.hidden; }

    /** Refresh after visibility returns without resubmitting accepted or uncertain work.
     * @returns {Promise<void>} Resolves when current options and history reads settle.
     */
    async resume() {
        if (!this.started || !this.isVisible()) return;
        await Promise.all([this.state.options ? Promise.resolve() : this.loadOptions(), this.readHistory()]);
    }

    /** Stop page-owned reads and timers while leaving server jobs and saved commands intact.
     * @returns {void}
     */
    suspend() {
        this.clock.clearTimeout(this.timer); this.timer = null;
        for (const controller of this.readControllers) controller.abort();
        this.readControllers.clear();
        this.searchRevision++; this.coverageRevision++; this.historyRevision++; this.inventoryRevision++;
        this.searchRequest = null; this.coverageRequest = null; this.historyRequest = null; this.optionsRequest = null; this.inventoryRequest = null;
        this.state.searching = this.state.checking = this.state.historyLoading = this.state.inventoryLoading = false;
        this.render();
    }

    /** Read a cache-wide snapshot only after an explicit Refresh action.
     * Existing snapshots remain visible on a read failure. Hiding the page aborts
     * the read; returning to the page never schedules another inventory request.
     * @returns {Promise<void>} Resolves after the current snapshot or error is shown.
     */
    async refreshInventory() {
        if (!this.isVisible() || this.inventoryRequest) return;
        const revision = ++this.inventoryRevision, controller = new AbortController();
        this.inventoryRequest = controller; this.readControllers.add(controller);
        this.state.inventoryLoading = true; this.state.inventoryError = ""; this.render();
        try {
            const rows = await this.api.inventory(controller.signal);
            if (this.destroyed || controller.signal.aborted || revision !== this.inventoryRevision) return;
            this.state.inventory = rows; this.state.inventoryCheckedAt = new Date().toISOString();
        } catch (error) {
            if (!this.destroyed && !controller.signal.aborted && revision === this.inventoryRevision) this.state.inventoryError = error.message;
        } finally {
            this.readControllers.delete(controller);
            if (this.inventoryRequest === controller) {
                this.inventoryRequest = null; this.state.inventoryLoading = false; this.render();
            }
        }
    }

    /** Read packaged scientific choices without initiating coverage or acquisition.
     * @returns {Promise<void>} Resolves after choices or an actionable error are shown.
     */
    async loadOptions() {
        if (this.optionsRequest) { await this.optionsPromise.catch(() => {}); return; }
        const controller = new AbortController(); this.readControllers.add(controller); this.optionsRequest = controller;
        try {
            const options = await (this.optionsPromise = this.api.getOptions(controller.signal));
            if (this.destroyed || controller.signal.aborted || this.optionsRequest !== controller) return;
            this.state.options = options;
            if (!this.yearsEdited && !this.state.years.length) this.state.years = [options.defaultYear];
            this.rebuildRows();
        } catch (error) {
            if (!this.destroyed && !controller.signal.aborted) this.state.error = `Available Habitat years could not be loaded: ${error.message}`;
        } finally {
            this.readControllers.delete(controller);
            if (this.optionsRequest === controller) this.optionsRequest = null;
            this.render();
        }
    }

    /** Search Catalog area metadata after an explicit user action.
     * @param {string} query User's Catalog search text.
     * @returns {Promise<void>} Resolves after current search results or error are displayed.
     */
    search(query) { this.query = query.trim(); return this.searchPage(false); }

    /** Request the next page of the current Catalog search.
     * @returns {Promise<void>} Resolves after another result page, or immediately without a next page.
     */
    searchMore() { return this.state.nextSearch && !this.state.searching ? this.searchPage(true) : Promise.resolve(); }

    /** Replace or append Catalog choices, discarding obsolete search responses.
     * @param {boolean} more Whether to follow the current continuation link.
     * @returns {Promise<void>} Resolves once the current search request settles.
     */
    async searchPage(more) {
        if (!this.isVisible()) return;
        this.searchRequest?.abort();
        const revision = ++this.searchRevision, controller = new AbortController();
        this.searchRequest = controller; this.readControllers.add(controller);
        this.state.searching = true; this.state.searchError = ""; this.render();
        try {
            const page = await this.api.searchAreas(this.query, more ? this.state.nextSearch : null, controller.signal);
            if (revision !== this.searchRevision || controller.signal.aborted || this.destroyed) return;
            this.state.sources = [...new Map([...(more ? this.state.sources : []), ...page.sources].map(source => [source.key, source])).values()];
            this.state.nextSearch = page.next;
        } catch (error) {
            if (revision === this.searchRevision && !this.destroyed && !controller.signal.aborted) this.state.searchError = error.message;
        } finally {
            this.readControllers.delete(controller);
            if (this.searchRequest === controller) { this.searchRequest = null; this.state.searching = false; this.render(); }
        }
    }

    /** Capture a named Catalog predicate without reading geometry or checking coverage.
     * @param {string} name Administrator's readable area name.
     * @param {string} sourceKey Catalog choice supplied by the search API.
     * @param {Object} [filter=EMPTY_VECTOR_FILTER] Explicit portable filter draft.
     * @returns {boolean} Whether a new immutable area was added.
     */
    addArea(name, sourceKey, filter = EMPTY_VECTOR_FILTER) {
        if (this.destroyed) return false;
        try {
            const source = this.state.sources.find(value => value.key === sourceKey);
            if (!source) throw new Error("Choose a Catalog polygon layer before adding an area.");
            const label = name.trim();
            if (!label || [...label].length > 80) throw new Error("Name this area using between 1 and 80 characters.");
            const selection = validateVectorSelection({ ...source.selection, filter: normalizeVectorFilter(filter, source.fields) });
            if (this.state.areas.some(area => JSON.stringify(area.selection) === JSON.stringify(selection))) throw new Error("This Catalog area and filter have already been added.");
            this.state.areas.push({ id: this.newId(), name: label, selection, filterSummary: vectorFilterSummary(selection.filter) });
            this.state.error = ""; this.invalidateCoverage(); return true;
        } catch (error) { this.state.error = error.message; this.render(); return false; }
    }

    /** Remove one draft area without cancelling accepted server work.
     * @param {string} id Local area identity.
     * @returns {void}
     */
    removeArea(id) { if (!this.destroyed) { this.state.areas = this.state.areas.filter(area => area.id !== id); this.invalidateCoverage(); } }

    /** Choose supported numeric years and invalidate advisory coverage after changes.
     * @param {number[]} years Assessment years selected in the view.
     * @returns {void}
     */
    setYears(years) {
        if (this.destroyed) return;
        try {
            const options = this.state.options;
            if (!options) throw new Error("Wait for the available assessment years to load.");
            if (years.some(year => !Number.isInteger(year) || year < options.minimumYear || year > options.maximumYear)) throw new Error("Choose assessment years supported by the Habitat inputs.");
            this.yearsEdited = true; this.state.years = [...new Set(years)].sort((a, b) => a - b);
            this.state.error = ""; this.invalidateCoverage();
        } catch (error) { this.state.error = error.message; this.render(); }
    }

    /** Discard obsolete coverage and cancel an exact polygon check after draft edits.
     * @returns {void}
     */
    invalidateCoverage() {
        this.coverageRevision++; this.coverageRequest?.abort(); this.coverageRequest = null;
        this.state.checking = false; this.rebuildRows(); this.render();
    }

    /** Expand the chosen areas and years into independent advisory coverage rows.
     * @returns {void}
     */
    rebuildRows() {
        this.state.coverageRows = this.state.areas.flatMap(area => this.state.years.map(year => ({ key: preparationKey(area.selection, year),
            name: area.name, selection: area.selection, year, coverage: null, checkedAt: null, error: "" })));
    }

    /** Check current coverage only after an explicit request, continuing independent row failures.
     * @returns {Promise<void>} Resolves after checks complete or become obsolete.
     */
    async check() {
        if (!this.isVisible() || this.state.checking) return;
        const revision = ++this.coverageRevision, controller = new AbortController();
        this.coverageRequest = controller; this.readControllers.add(controller);
        this.state.checking = true; this.render();
        try {
            for (const row of this.state.coverageRows) {
                try {
                    const coverage = await this.api.coverage(row.selection, row.year, controller.signal);
                    if (this.destroyed || revision !== this.coverageRevision || controller.signal.aborted) return;
                    row.coverage = coverage; row.checkedAt = new Date().toISOString(); row.error = "";
                } catch (error) {
                    if (this.destroyed || revision !== this.coverageRevision || controller.signal.aborted) return;
                    row.error = error.message;
                }
                this.render();
            }
        } finally {
            this.readControllers.delete(controller);
            if (this.coverageRequest === controller) { this.coverageRequest = null; this.state.checking = false; this.render(); }
        }
    }

    /** Queue each requested area/year once; a coverage snapshot is never required.
     * @returns {Promise<void>} Resolves after independently accepted or failed admissions.
     */
    async prepare() {
        if (this.destroyed || this.state.submitting) return;
        const rows = this.state.coverageRows.filter(row => !this.state.submissions.some(item => item.key === row.key && item.status !== "failed"));
        const submissions = rows.map(row => ({ key: row.key, name: row.name, year: row.year, kind: "prepare",
            status: "submitting", request: { requestId: this.newId(), name: row.name, selection: row.selection, year: row.year }, jobId: null, error: "" }));
        this.state.submissions = [...this.state.submissions.filter(item => !submissions.some(row => row.key === item.key)), ...submissions];
        await this.sendSubmissions(submissions);
    }

    /** Recover one uncertain command using its saved body and original request ID.
     * @param {string} key Local preparation or retry-command identity.
     * @returns {Promise<void>} Resolves after acceptance, definite rejection or another uncertain response.
     */
    async recover(key) {
        const row = this.state.submissions.find(item => item.key === key);
        if (!this.destroyed && !this.state.submitting && row?.status === "uncertain") await this.sendSubmissions([row]);
    }

    /** Persist commands before POSTing, preserving uncertain outcomes independently.
     * @param {Object[]} rows Captured submission or explicit-retry commands.
     * @returns {Promise<void>} Resolves after all current commands settle or the page is destroyed.
     */
    async sendSubmissions(rows) {
        if (!rows.length) return;
        this.state.submitting = true; this.state.error = "";
        for (const row of rows) { row.status = "submitting"; row.error = ""; }
        try { this.persistPending(); }
        catch (error) {
            for (const row of rows) { row.status = "failed"; row.error = error.message; }
            this.state.submitting = false; this.render(); return;
        }
        this.render();
        try {
            for (const row of rows) {
                if (this.destroyed) return;
                const controller = new AbortController(); this.mutationControllers.add(controller);
                try {
                    const job = row.kind === "retry" ? await this.api.retry(row.sourceJobId, row.request.requestId, controller.signal) : await this.api.submit(row.request, controller.signal);
                    if (this.destroyed) return;
                    row.status = "accepted"; row.jobId = job.jobId; row.error = ""; this.mergeJob(job, true);
                } catch (error) {
                    if (this.destroyed) return;
                    const uncertain = typeof error.uncertain === "boolean" ? error.uncertain : error.name === "AbortError" || error.status == null || error.status >= 500;
                    row.status = uncertain ? "uncertain" : "failed";
                    row.error = error.message;
                } finally { this.mutationControllers.delete(controller); }
                try { this.persistPending(); } catch { /* The retained original IDs still recover the same accepted commands. */ }
                this.render();
            }
        } finally { if (!this.destroyed) { this.state.submitting = false; this.render(); this.schedule(); } }
    }

    /** Store only exact unresolved commands, excluding passwords and all accepted job state.
     * @returns {void}
     * @throws {Error} If browser storage cannot preserve a recoverable admission.
     */
    persistPending() {
        if (!this.storage) throw new Error("Enable browser storage to submit recoverable input preparations.");
        const rows = this.state.submissions.filter(row => ["uncertain", "submitting"].includes(row.status));
        if (rows.length) this.storage.setItem(PENDING_KEY, JSON.stringify(rows.map(({ key, name, year, kind, sourceJobId, request }) => ({ key, name, year, kind, sourceJobId, request }))));
        else this.storage.removeItem(PENDING_KEY);
    }

    /** Restore saved commands as uncertain rows without initiating any mutation.
     * @returns {void}
     */
    restorePending() {
        try {
            const saved = JSON.parse(this.storage?.getItem(PENDING_KEY) ?? "[]");
            if (!Array.isArray(saved)) throw new Error("Invalid saved preparation commands.");
            this.state.submissions = saved.map(row => {
                if (!row || !["prepare", "retry"].includes(row.kind) || typeof row.name !== "string" || !Number.isInteger(row.year) ||
                    !/^[A-Za-z0-9_-]{16,80}$/.test(row.request?.requestId)) throw new Error("Invalid saved preparation command.");
                let request, key;
                if (row.kind === "prepare") {
                    if (Object.keys(row.request).sort().join() !== "name,requestId,selection,year" || typeof row.request.name !== "string" ||
                        !row.request.name.trim() || [...row.request.name].length > 80 || !Number.isInteger(row.request.year) || row.request.selection?.uploadId !== undefined) throw new Error("Invalid saved preparation inputs.");
                    const selection = validateVectorSelection(row.request.selection);
                    request = { ...row.request, selection }; key = preparationKey(selection, request.year);
                } else {
                    if (!/^[a-f0-9]{32}$/.test(row.sourceJobId) || Object.keys(row.request).join() !== "requestId") throw new Error("Invalid saved preparation retry.");
                    request = { requestId: row.request.requestId }; key = `retry:${row.sourceJobId}`;
                }
                return { key, name: row.name, year: row.year, kind: row.kind, sourceJobId: row.sourceJobId, request,
                    status: "uncertain", jobId: null, error: "Recover this submission to check whether it was accepted." };
            });
        } catch (error) { this.state.error = "Saved pending preparations could not be read. Check server history before starting them again."; }
    }

    /** Retain authoritative job state without allowing an older read to undo a mutation.
     * @param {Object} job Validated admin job snapshot.
     * @param {boolean} [mutation=false] Whether submission, cancellation or retry returned it.
     * @param {number} [readRevision=this.mutationRevision] Mutation revision captured before a history read.
     * @returns {void}
     */
    mergeJob(job, mutation = false, readRevision = this.mutationRevision) {
        if (!mutation && (this.jobMutations.get(job.jobId) ?? 0) > readRevision) return;
        if (mutation) this.jobMutations.set(job.jobId, ++this.mutationRevision);
        const current = this.jobs.get(job.jobId);
        if (!current || current.updatedAt <= job.updatedAt) this.jobs.set(job.jobId, job);
    }

    /** Explicitly refresh the first server-history page while preserving already displayed jobs.
     * @returns {Promise<void>} Resolves after history refresh settles.
     */
    refreshHistory() { return this.readHistory(false, true); }

    /** Load another page of retained server history.
     * @returns {Promise<void>} Resolves after the next page, or immediately at the end.
     */
    loadMore() { return this.state.nextCursor ? this.readHistory(true) : Promise.resolve(); }

    /** Read paginated history and loaded active jobs without overlapping another history request.
     * @param {boolean} [more=false] Append older history rather than refresh the newest page.
     * @param {boolean} [reset=false] Reset pagination after an explicit user refresh.
     * @returns {Promise<void>} The current or newly started history read.
     */
    readHistory(more = false, reset = false) {
        if (!this.isVisible()) return Promise.resolve();
        if (this.historyRequest) return this.historyPromise;
        const controller = new AbortController(), revision = ++this.historyRevision, mutations = this.mutationRevision;
        const active = more ? [] : [...this.jobs.values()].filter(job => ACTIVE_PREPARATION_STATES.has(job.status)).map(job => job.jobId);
        this.historyRequest = controller; this.readControllers.add(controller);
        this.state.historyLoading = true; this.state.historyError = ""; this.render();
        this.historyPromise = (async () => {
            try {
                const page = await this.api.list({ cursor: more ? this.state.nextCursor : null, limit: 50, signal: controller.signal });
                if (revision !== this.historyRevision || controller.signal.aborted || this.destroyed) return;
                for (const job of page.jobs) this.mergeJob(job, false, mutations);
                if (reset) this.historyPaged = false;
                if (more || !this.historyPaged) this.state.nextCursor = page.nextCursor;
                if (more) this.historyPaged = true;
                const listed = new Set(page.jobs.map(job => job.jobId));
                for (const id of active.filter(id => !listed.has(id))) {
                    try {
                        const job = await this.api.get(id, controller.signal);
                        if (revision !== this.historyRevision || controller.signal.aborted || this.destroyed) return;
                        this.mergeJob(job, false, mutations);
                    } catch (error) {
                        if (error.status !== 404) throw error;
                        if ((this.jobMutations.get(id) ?? 0) <= mutations) this.jobs.delete(id);
                    }
                }
            } catch (error) {
                if (revision === this.historyRevision && !controller.signal.aborted && !this.destroyed) this.state.historyError = `Preparation history could not be refreshed: ${error.message}`;
            } finally {
                this.readControllers.delete(controller);
                if (this.historyRequest === controller) { this.historyRequest = null; this.state.historyLoading = false; this.render(); this.schedule(); }
            }
        })();
        return this.historyPromise;
    }

    /** Cancel one job through its existing server lifecycle and retain the response over older reads.
     * @param {string} id Public preparation handle.
     * @returns {Promise<void>} Resolves after cancellation acknowledgement or an actionable error.
     */
    async cancel(id) {
        if (this.destroyed || this.state.submitting) return;
        const controller = new AbortController(); this.mutationControllers.add(controller); this.state.submitting = true; this.render();
        try {
            const job = await this.api.cancel(id, controller.signal);
            if (!this.destroyed) { this.mergeJob(job, true); this.state.error = ""; }
        } catch (error) { if (!this.destroyed) this.state.error = `${error.message} Refresh history to check the cancellation.`; }
        finally { this.mutationControllers.delete(controller); if (!this.destroyed) { this.state.submitting = false; this.render(); this.schedule(); } }
    }

    /** Capture a recoverable explicit retry without modifying or reviving the original job.
     * @param {string} id Failed, cancelled, interrupted or expired preparation handle.
     * @returns {Promise<void>} Resolves after retry acceptance or an independent error.
     */
    async retry(id) {
        if (this.destroyed || this.state.submitting) return;
        const job = this.jobs.get(id), key = `retry:${id}`;
        const status = job?.status === "ready" && Date.parse(job.expiresAt) <= Date.now() ? "expired" : job?.status;
        if (job?.metadataExpiresAt && Date.parse(job.metadataExpiresAt) <= Date.now()) {
            this.state.error = "This preparation's saved inputs have expired. Choose the area and year again."; this.render(); return;
        }
        if (!job?.inputs || !RETRY_STATES.has(status)) { this.state.error = "Choose a failed, cancelled, interrupted or expired preparation with saved inputs."; this.render(); return; }
        const previous = this.state.submissions.find(row => row.key === key);
        if (previous && previous.status !== "failed") return;
        const row = { key, kind: "retry", sourceJobId: id, name: job.inputs.name, year: job.inputs.year,
            request: { requestId: this.newId() }, status: "submitting", jobId: null, error: "" };
        this.state.submissions = [...this.state.submissions.filter(value => value.key !== key), row];
        await this.sendSubmissions([row]);
    }

    /** Schedule status polling using the existing active and idle Processing cadence.
     * @returns {void}
     */
    schedule() {
        this.clock.clearTimeout(this.timer); this.timer = null;
        if (this.started && this.isVisible()) this.timer = this.clock.setTimeout(() => this.readHistory(),
            [...this.jobs.values()].some(job => ACTIVE_PREPARATION_STATES.has(job.status)) ? 2000 : 30000);
    }

    /** Present a stable snapshot without starting coverage or server mutations.
     * @returns {void}
     */
    render() {
        if (this.destroyed) return;
        this.state.jobs = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId));
        const requested = new Set(this.state.submissions.filter(row => row.jobId).map(row => row.jobId));
        this.state.requestedJobs = requested.size;
        this.state.completedJobs = [...requested].filter(id => ["ready", "expired"].includes(this.jobs.get(id)?.status)).length;
        this.state.canPrepare = !this.state.submitting && this.state.coverageRows.some(row => !this.state.submissions.some(item => item.key === row.key && item.status !== "failed"));
        this.view.render(this.state);
    }

    /** Release page-owned work and listeners without cancelling accepted server jobs.
     * @returns {void}
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true; this.suspend();
        this.document?.removeEventListener("visibilitychange", this.onVisibility);
        this.window?.removeEventListener("pagehide", this.onPageHide);
        this.window?.removeEventListener("pageshow", this.onPageShow);
        for (const controller of this.mutationControllers) controller.abort();
        this.mutationControllers.clear(); this.view.destroy?.();
    }
}
