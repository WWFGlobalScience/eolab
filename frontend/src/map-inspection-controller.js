/** Shared non-modal presentation surface for independent map-side tools. */
export class MapInspectionController {
    /**
     * Bind independent close controls for the shared exploration surface.
     *
     * @param {Object} dependencies Presentation dependencies.
     * @param {Document} [dependencies.documentContext=document] Owning document.
     */
    constructor({ documentContext = document } = {}) {
        this.document = documentContext;
        this.root = documentContext.querySelector("#map-inspection");
        this.panels = documentContext.querySelector("#map-inspection-panels");
        this.dockTitle = documentContext.querySelector("#map-inspection-dock-title");
        this.tabList = documentContext.querySelector("#map-inspection-tabs");
        this.clickSummary = documentContext.querySelector("#map-click-summary");
        this.clickLabel = "";
        this.clickResults = ["histogram", "feature"].map(name => ({
            name, button: documentContext.querySelector(`#map-click-${name}`),
            status: documentContext.querySelector(`#map-click-${name}-status`),
            snapshot: null, unread: false,
        }));
        this.hasClick = false;
        this.onSummaryClick = event => {
            const entry = this.clickResults.find(({button}) => button === event.currentTarget);
            if (entry && !entry.button.disabled) this.#showTool(entry.name);
        };
        for (const {button} of this.clickResults) button.addEventListener("click", this.onSummaryClick);
        this.minimizeButton = documentContext.querySelector(
            "#toggle-map-inspection-dock"
        );
        this.histogram = documentContext.querySelector("#map-histogram-panel");
        this.style = documentContext.querySelector("#layer-style-editor");
        this.filter = documentContext.querySelector("#vector-filter-panel");
        this.downloads = documentContext.querySelector("#downloads-panel");
        this.calculations = documentContext.querySelector("#calculations-panel");
        this.feature = documentContext.querySelector("#vector-feature-inspector");
        this.featureDetails = documentContext.querySelector(
            "#vector-feature-inspector-details"
        );
        this.featureDetailsToggle = documentContext.querySelector(
            "#toggle-vector-inspector-details"
        );
        this.vectorTimeSeries = documentContext.querySelector(
            "#vector-time-series"
        );
        this.vectorFeatureProfile = documentContext.querySelector(
            "#vector-feature-profile"
        );
        this.analysisToolsButton = documentContext.querySelector(
            "#open-analysis-tools"
        );
        this.map = documentContext.querySelector("#map");
        this.closeButton = documentContext.querySelector("#close-map-histogram");
        this.tools = [
            { name: "calculations", label: "Summarize", panel: this.calculations,
                tab: documentContext.querySelector("#map-inspection-tab-calculations") },
            {
                name: "downloads", label: "History & exports", panel: this.downloads,
                tab: documentContext.querySelector("#map-inspection-tab-downloads"),
            },
            {
                name: "histogram",
                label: "Raster histograms",
                panel: this.histogram,
                tab: documentContext.querySelector("#map-inspection-tab-histogram"),
            },
            {
                name: "feature",
                label: "Features",
                panel: this.feature,
                tab: documentContext.querySelector("#map-inspection-tab-feature"),
            },
            {
                name: "time-series",
                label: "Field across features",
                panel: this.vectorTimeSeries,
                tab: documentContext.querySelector("#map-inspection-tab-time-series"),
            },
            {
                name: "feature-profile",
                label: "Fields from feature",
                panel: this.vectorFeatureProfile,
                tab: documentContext.querySelector("#map-inspection-tab-feature-profile"),
            },
            {
                name: "filter",
                label: "Filter",
                panel: this.filter,
                tab: documentContext.querySelector("#map-inspection-tab-filter"),
            },
            {
                name: "style",
                label: "Style",
                panel: this.style,
                tab: documentContext.querySelector("#map-inspection-tab-style"),
            },
        ];
        this.isOpen = false;
        this.activeTool = null;
        this.activationOrder = [];
        this.minimized = false;
        this.activityListeners = new Set();
        this.reportedActiveTool = null;
        this.onClose = () => this.closeHistogram();
        this.onMinimize = () => {
            this.minimized = !this.minimized;
            this.#renderDock();
        };
        this.onTabClick = (event) => {
            const tool = this.tools.find(({ tab }) => tab === event.currentTarget);
            if (tool !== undefined) this.#activateTool(tool.name);
        };
        this.onTabKeydown = (event) => this.#moveTabFocus(event);
        this.onToggleFeatureDetails = () =>
            this.setFeatureInspectorExpanded(this.featureDetails.hidden);
        this.onKeydown = (event) => {
            if (event.key !== "Escape" || this.histogram.hidden ||
                !this.histogram.contains(this.document.activeElement)) return;
            event.preventDefault();
            event.stopPropagation();
            this.closeHistogram();
        };
        this.closeButton.addEventListener("click", this.onClose);
        this.minimizeButton.addEventListener("click", this.onMinimize);
        for (const { tab } of this.tools) {
            tab.addEventListener("click", this.onTabClick);
            tab.addEventListener("keydown", this.onTabKeydown);
        }
        this.featureDetailsToggle.addEventListener(
            "click", this.onToggleFeatureDetails
        );
        this.document.addEventListener("keydown", this.onKeydown);
        this.#renderDock();
    }

    /**
     * Reveal histogram results and identify how many visible rasters participated.
     *
     * @param {number|null} [resultCount=null] Visible raster result count.
     * @param {Object} [options] Presentation options.
     * @param {boolean} [options.activate=true] Whether to activate the tab.
     * @return {void}
     */
    showHistogram(resultCount = null, options = {}) {
        if (resultCount !== null) {
            this.#validateCount(resultCount);
        }
        this.#setToolLabel(
            "histogram",
            "Raster histograms",
            resultCount === null ? "" : String(resultCount) + " raster results"
        );
        this.#showTool("histogram", options);
    }

    /**
     * Hide histogram results and optionally return focus to the map.
     *
     * @param {boolean} [moveFocus=true] Whether to restore focus to the map.
     * @return {void}
     */
    closeHistogram(moveFocus = true) {
        if (this.histogram.hidden) return;
        this.#hideTool("histogram");
        if (moveFocus) this.map.focus();
    }

    /**
     * Reveal styling alongside retained inspection results.
     *
     * @param {string|null} [layerLabel=null] User-facing style target label.
     * @return {void}
     */
    showStyle(layerLabel = null) {
        if (layerLabel !== null && (
            typeof layerLabel !== "string" || layerLabel.trim().length === 0
        )) {
            throw new TypeError("Style layer label must be a non-empty string.");
        }
        this.#setToolLabel(
            "style",
            layerLabel === null ? "Style" : `Style · ${layerLabel}`,
            layerLabel === null ? "" : `Style ${layerLabel}`
        );
        this.#showTool("style");
    }

    /**
     * Reveal a dedicated layer filter editor.
     * @param {string} layerLabel User-facing retained layer label.
     * @return {void}
     */
    showFilter(layerLabel) {
        this.#setToolLabel("filter", `Filter · ${layerLabel}`, `Filter ${layerLabel}`);
        this.#showTool("filter");
    }

    /** Reveal calculations independently of peer tools. @return {void} */
    showCalculations() { this.#showTool("calculations"); }

    /** Hide calculations without changing peer panels. @return {void} */
    hideCalculations() { this.#hideTool("calculations"); }

    /** Reveal the Downloads tool while retaining peer panels. @return {void} */
    showDownloads() { this.#showTool("downloads"); }

    /** Close Downloads without cancelling server work. @return {void} */
    hideDownloads() { this.#hideTool("downloads"); }

    /** Hide the filter editor without closing other tools. @return {void} */
    hideFilter() {
        this.#hideTool("filter");
        this.#resetToolLabel("filter");
    }

    /** Hide styling without closing an open histogram or changing its sample. @return {void} */
    hideStyle() {
        this.#hideTool("style");
        this.#resetToolLabel("style");
    }

    /**
     * Reveal vector feature results without changing retained map layers.
     *
     * @param {Object} [options] Presentation options.
     * @param {boolean} [options.activate=true] Whether to activate the tab.
     * @return {void}
     */
    showFeatureInspector(options = {}) {
        this.#setToolLabel("feature", "Features…", "Inspecting vector features");
        this.#showTool("feature", options);
    }

    /** Begin one click's presentation without changing the user's foreground tool.
     * Result owners retain cancellation and data; this stores only display state.
     * @param {{lng:number,lat:number}} position Accepted map-click position.
     * @return {void}
     */
    beginMapClick(position) {
        this.hasClick = true;
        this.clickLabel = `Map click · ${position.lat.toFixed(4)}, ${position.lng.toFixed(4)}`;
        for (const entry of this.clickResults) {
            entry.snapshot = null;
            entry.unread = false;
        }
        this.#renderDock();
    }

    /** Present an owning analysis stream's current, already stale-checked status.
     * @param {"histogram"|"feature"} name Result stream.
     * @param {{state:"loading"|"ready"|"empty"|"error"|"invalidated",message:string}|null} snapshot
     * Display-only state, or null when this click has no participating layer.
     * @return {void}
     * @throws {TypeError} For an invalid stream or presentation snapshot.
     */
    setClickResult(name, snapshot) {
        const entry = this.clickResults.find(result => result.name === name);
        if (!entry || (snapshot !== null && (![
            "loading", "ready", "empty", "error", "invalidated",
        ].includes(snapshot.state) || typeof snapshot.message !== "string"))) {
            throw new TypeError("Invalid map-click result presentation.");
        }
        if (!this.hasClick) return;
        const changed = JSON.stringify(entry.snapshot) !== JSON.stringify(snapshot);
        entry.snapshot = snapshot === null ? null : {...snapshot};
        if (snapshot === null || snapshot.state === "loading") entry.unread = false;
        if (changed && snapshot !== null && ["ready", "error"].includes(snapshot.state)) {
            entry.unread = snapshot !== null && (this.activeTool !== name || this.minimized);
        }
        this.#synchronize();
    }

    /** Render both streams without moving focus or interpreting analysis data.
     * @return {void}
     */
    #renderClickSummary() {
        this.clickSummary.hidden = !this.hasClick || this.minimized;
        for (const entry of this.clickResults) {
            const {name, button, status, snapshot} = entry;
            const loading = snapshot?.state === "loading";
            button.hidden = snapshot === null;
            button.disabled = snapshot === null || ["empty", "invalidated"].includes(snapshot.state);
            button.setAttribute("data-unread", String(entry.unread));
            button.setAttribute("data-loading", String(loading));
            button.setAttribute("aria-pressed", String(this.activeTool === name && !this.minimized));
            status.textContent = snapshot === null ? "" : snapshot.message + (entry.unread ? " · New results" : "");
            const tool = this.#tool(name);
            tool.tab.setAttribute("data-unread", String(entry.unread));
            tool.panel.setAttribute("data-inspection-loading", String(loading));
        }
    }

    /**
     * Present the number of features returned by the current map click.
     *
     * @param {number} resultCount Number of inspected vector features.
     * @param {Object} [options] Presentation options.
     * @param {boolean} [options.loading=false] Whether peer requests remain active.
     * @return {void}
     */
    setFeatureResultCount(resultCount, { loading = false } = {}) {
        this.#validateCount(resultCount);
        if (typeof loading !== "boolean") {
            throw new TypeError("Feature loading state must be boolean.");
        }
        if (this.feature.hidden) return;
        if (loading && resultCount === 0) {
            this.#setToolLabel(
                "feature", "Features…", "Inspecting vector features"
            );
            return;
        }
        const noun = resultCount === 1 ? "feature" : "features";
        this.#setToolLabel(
            "feature",
            `Features · ${resultCount}${loading ? "…" : ""}`,
            loading
                ? `${resultCount} ${noun} found; vector inspection continues`
                : `${resultCount} ${noun} at the selected map location`
        );
    }

    /**
     * Hide vector feature results without changing any other map-side tool.
     *
     * @return {void}
     */
    hideFeatureInspector() {
        this.#hideTool("feature");
        this.#resetToolLabel("feature");
    }

    /**
     * Collapse or expand Feature Inspector details without changing its data.
     *
     * @param {boolean} expanded Whether detailed inspector content is visible.
     * @return {void}
     */
    setFeatureInspectorExpanded(expanded) {
        this.featureDetails.hidden = !expanded;
        this.featureDetailsToggle.setAttribute(
            "aria-expanded", String(expanded)
        );
        this.featureDetailsToggle.textContent = expanded ? "Collapse" : "Expand";
    }

    /** Reveal selected-feature analysis as the active series presentation. @return {void} */
    showVectorTimeSeries() {
        this.#closeToolState("feature-profile");
        this.#showTool("time-series");
    }

    /**
     * Identify the field-across-features presentation in its retained dock tab.
     *
     * @param {{label:string,title:string}|null} identity Plot identity, or null
     * to restore the stable base label.
     * @return {void}
     */
    setVectorTimeSeriesIdentity(identity) {
        this.#setToolIdentity("time-series", identity);
    }

    /**
     * Hide vector time-series analysis without clearing its retained settings.
     *
     * @param {boolean} [moveFocus=false] Restore focus to the map.
     * @return {void}
     */
    hideVectorTimeSeries(moveFocus = false) {
        this.#hideTool("time-series");
        if (moveFocus) this.map.focus();
    }

    /** Reveal feature-field analysis as the active series presentation. @return {void} */
    showVectorFeatureProfile() {
        this.#closeToolState("time-series");
        this.#showTool("feature-profile");
    }

    /**
     * Identify the single-feature field presentation in its retained dock tab.
     *
     * @param {{label:string,title:string}|null} identity Plot identity, or null
     * to restore the stable base label.
     * @return {void}
     */
    setVectorFeatureProfileIdentity(identity) {
        this.#setToolIdentity("feature-profile", identity);
    }

    /**
     * Hide feature-field analysis without clearing its per-source settings.
     *
     * @param {boolean} [moveFocus=false] Restore focus to the map.
     * @return {void}
     */
    hideVectorFeatureProfile(moveFocus = false) {
        this.#hideTool("feature-profile");
        if (moveFocus) this.map.focus();
    }

    /**
     * Reveal and activate one retained map tool.
     *
     * @param {string} name Stable presentation name from this controller's tool set.
     * @param {Object} [options] Presentation options.
     * @param {boolean} [options.activate=true] Activate, or retain the current foreground tool.
     * @return {void}
     */
    #showTool(name, { activate = true } = {}) {
        if (typeof activate !== "boolean") throw new TypeError("Tool activation must be boolean.");
        const tool = this.#tool(name);
        tool.panel.hidden = false;
        if (activate) this.#activateTool(name);
        else this.#synchronize();
    }

    /**
     * Close one retained map tool and activate the most recently used survivor.
     *
     * @param {string} name Stable presentation name from this controller's tool set.
     * @return {void}
     */
    #hideTool(name) {
        this.#closeToolState(name);
        this.#synchronize();
    }

    /**
     * Update closed-tool state without synchronizing the native surface.
     *
     * This permits the two mutually exclusive series presentations to exchange
     * one dock position without briefly closing the shared popover.
     *
     * @param {string} name Stable presentation name from this controller's tool set.
     * @return {void}
     */
    #closeToolState(name) {
        const tool = this.#tool(name);
        tool.panel.hidden = true;
        this.activationOrder = this.activationOrder.filter(
            (candidate) => candidate !== name
        );
        if (this.activeTool !== name) return;
        this.activeTool = this.#fallbackToolName();
    }

    /**
     * Activate one open tool and expand the dock without changing peer state.
     *
     * @param {string} name Stable presentation name from this controller's tool set.
     * @return {void}
     */
    #activateTool(name) {
        const tool = this.#tool(name);
        if (tool.panel.hidden) return;
        if (name !== "downloads" && !this.downloads.hidden) {
            this.#closeToolState("downloads");
        }
        this.activeTool = name;
        const result = this.clickResults.find(entry => entry.name === name);
        if (result) result.unread = false;
        this.activationOrder = this.activationOrder.filter(
            (candidate) => candidate !== name
        );
        this.activationOrder.push(name);
        this.minimized = false;
        this.#synchronize();
    }

    /**
     * Resolve one controller-owned presentation descriptor.
     *
     * @param {string} name Stable presentation name.
     * @return {{name:string,label:string,panel:HTMLElement,tab:HTMLButtonElement}}
     * Tool descriptor.
     * @throws {RangeError} When the controller receives an unknown tool name.
     */
    #tool(name) {
        const tool = this.tools.find((candidate) => candidate.name === name);
        if (tool === undefined) {
            throw new RangeError(`Unknown map inspection tool: ${name}`);
        }
        return tool;
    }

    /**
     * Validate a result count at the presentation boundary.
     *
     * @param {number} count Candidate non-negative integer count.
     * @return {void}
     * @throws {TypeError} When count is not a non-negative integer.
     */
    #validateCount(count) {
        if (!Number.isInteger(count) || count < 0) {
            throw new TypeError(
                "Map inspection result count must be a non-negative integer."
            );
        }
    }

    /**
     * Set the visible and accessible label for one dock tool.
     *
     * @param {string} name Stable presentation name.
     * @param {string} label Visible tab label.
     * @param {string} [title=""] Optional full hover label.
     * @return {void}
     */
    #setToolLabel(name, label, title = "") {
        const { tab } = this.#tool(name);
        tab.textContent = label;
        tab.title = title;
    }

    /**
     * Restore one dock tool's stable base label.
     *
     * @param {string} name Stable presentation name.
     * @return {void}
     */
    #resetToolLabel(name) {
        const tool = this.#tool(name);
        this.#setToolLabel(name, tool.label);
    }

    /**
     * Apply one analysis-owned identity without exposing analysis data here.
     *
     * @param {string} name Stable presentation name.
     * @param {{label:string,title:string}|null} identity Presentation identity.
     * @return {void}
     */
    #setToolIdentity(name, identity) {
        if (identity === null) {
            this.#resetToolLabel(name);
            return;
        }
        if (
            typeof identity !== "object" ||
            typeof identity.label !== "string" ||
            identity.label.trim().length === 0 ||
            typeof identity.title !== "string" ||
            identity.title.trim().length === 0
        ) {
            throw new TypeError(
                "Map tool identity requires non-empty label and title strings."
            );
        }
        this.#setToolLabel(name, identity.label, identity.title);
    }

    /**
     * Return all tools whose retained presentation is open.
     *
     * @return {Array<{name:string,panel:HTMLElement,tab:HTMLButtonElement}>}
     * Open tool descriptors in stable dock order.
     */
    #openTools() {
        return this.tools.filter(({ panel }) => !panel.hidden);
    }

    /**
     * Choose the most recently activated tool that remains open.
     *
     * @return {string|null} Stable tool name, or null when the dock is empty.
     */
    #fallbackToolName() {
        const openNames = new Set(this.#openTools().map(({ name }) => name));
        return this.activationOrder.findLast((name) => openNames.has(name)) ??
            this.#openTools()[0]?.name ?? null;
    }

    /**
     * Apply horizontal tab-list keyboard navigation to currently open tools.
     *
     * @param {KeyboardEvent} event Keyboard event dispatched by one dock tab.
     * @return {void}
     */
    #moveTabFocus(event) {
        const openTools = this.#openTools().filter(({tab}) => !tab.hidden);
        const currentIndex = openTools.findIndex(
            ({ tab }) => tab === event.currentTarget
        );
        if (currentIndex < 0) return;
        let targetIndex;
        if (event.key === "Home") targetIndex = 0;
        else if (event.key === "End") targetIndex = openTools.length - 1;
        else if (event.key === "ArrowRight") {
            targetIndex = (currentIndex + 1) % openTools.length;
        } else if (event.key === "ArrowLeft") {
            targetIndex = (currentIndex - 1 + openTools.length) % openTools.length;
        } else return;
        event.preventDefault();
        const target = openTools[targetIndex];
        this.#activateTool(target.name);
        target.tab.focus();
    }

    /**
     * Synchronize the bounded dock and its one native top-layer surface.
     *
     * @return {void}
     */
    #synchronize() {
        const shouldOpen = this.#openTools().length > 0 ||
            (this.hasClick && this.clickResults.some(entry => entry.snapshot !== null));
        if (shouldOpen && (this.activeTool === null ||
            this.#tool(this.activeTool).panel.hidden)) {
            this.activeTool = this.#fallbackToolName();
        }
        if (!shouldOpen) {
            this.activeTool = null;
            this.activationOrder = [];
            this.minimized = false;
        }
        this.#renderDock();
        this.analysisToolsButton.hidden = shouldOpen;
        if (shouldOpen === this.isOpen) return;
        this.isOpen = shouldOpen;
        if (shouldOpen) this.root.showPopover();
        else this.root.hidePopover();
    }

    /** Report expanded foreground presentation without knowing any tool's behavior.
     * @param {function(string|null):void} listener Receives the active tool or null.
     * @return {function():void} Unsubscribe callback.
     */
    subscribeActiveTool(listener) {
        this.activityListeners.add(listener);
        listener(this.minimized ? null : this.activeTool);
        return () => this.activityListeners.delete(listener);
    }

    /**
     * Render the combined header, unique navigation, and active-panel visibility.
     * Result cards replace their tabs; other open tools retain keyboard navigation.
     * Hide the panel surface when no tool is active so the retained result header
     * cannot leave an invisible container intercepting map input below it.
     *
     * @return {void}
     */
    #renderDock() {
        this.panels.hidden = this.minimized || this.activeTool === null;
        this.root.setAttribute("data-minimized", String(this.minimized));
        this.root.setAttribute("data-active-tool", this.activeTool ?? "");
        const activeLabel = this.activeTool === null
            ? ""
            : this.#tool(this.activeTool).label;
        this.dockTitle.textContent = this.minimized && activeLabel
            ? "Map tools \u00b7 " + activeLabel
            : this.hasClick ? this.clickLabel : "Map tools";
        this.dockTitle.title = this.dockTitle.textContent;
        this.minimizeButton.textContent = this.minimized ? "Expand" : "Minimize";
        this.minimizeButton.setAttribute(
            "aria-expanded", String(!this.minimized)
        );
        this.minimizeButton.setAttribute(
            "aria-label", this.minimized ? "Expand map tools" : "Minimize map tools"
        );
        for (const { name, panel, tab } of this.tools) {
            const open = !panel.hidden;
            const active = open && this.activeTool === name;
            const result = this.clickResults.find(entry => entry.name === name);
            const hasCard = this.hasClick && result?.snapshot != null;
            tab.hidden = !open || hasCard;
            tab.setAttribute("aria-selected", String(active));
            tab.tabIndex = active ? 0 : -1;
            panel.setAttribute("data-map-inspection-active", String(active));
            panel.setAttribute(
                "aria-hidden", String(!active || this.minimized)
            );
            panel.setAttribute("aria-labelledby", hasCard ? result.button.id : tab.id);
        }
        const visibleTabs = this.tools.filter(({tab}) => !tab.hidden);
        this.tabList.hidden = visibleTabs.length === 0 || this.minimized;
        if (!visibleTabs.some(({tab}) => tab.tabIndex === 0) && visibleTabs.length > 0) {
            visibleTabs[0].tab.tabIndex = 0;
        }
        const active = this.minimized ? null : this.activeTool;
        this.#renderClickSummary();
        if (active !== this.reportedActiveTool) {
            this.reportedActiveTool = active;
            for (const listener of this.activityListeners) listener(active);
        }
    }

    /** Release presentation listeners without changing retained analysis state. @return {void} */
    destroy() {
        for (const {button} of this.clickResults) button.removeEventListener("click", this.onSummaryClick);
        this.hasClick = false;
        this.closeButton.removeEventListener("click", this.onClose);
        this.minimizeButton.removeEventListener("click", this.onMinimize);
        for (const { tab } of this.tools) {
            tab.removeEventListener("click", this.onTabClick);
            tab.removeEventListener("keydown", this.onTabKeydown);
        }
        this.featureDetailsToggle.removeEventListener(
            "click", this.onToggleFeatureDetails
        );
        this.document.removeEventListener("keydown", this.onKeydown);
        this.histogram.hidden = true;
        this.style.hidden = true;
        this.filter.hidden = true;
        this.downloads.hidden = true;
        this.calculations.hidden = true;
        this.feature.hidden = true;
        this.vectorTimeSeries.hidden = true;
        this.vectorFeatureProfile.hidden = true;
        for (const { name } of this.tools) this.#resetToolLabel(name);
        this.activeTool = null;
        this.activationOrder = [];
        this.minimized = false;
        this.setFeatureInspectorExpanded(true);
        this.#synchronize();
        this.activityListeners.clear();
    }
}
