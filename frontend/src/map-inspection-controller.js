/**
 * @typedef {Object} MapInspectionToolContext
 * @property {string} source Tool-owned source or source-group display label.
 * @property {string} scope Tool-owned spatial or feature scope; empty when inapplicable.
 */

/** Shared non-modal presentation surface for independent map-side tools. */
export class MapInspectionController {
    /**
     * Bind retained task context, navigation, native Tools popover and close controls.
     *
     * @param {Object} dependencies Presentation dependencies.
     * @param {Document} [dependencies.documentContext=document] Owning document.
     * @param {function({open: boolean, expanded: boolean, wide: boolean, toolbarHeight: number}):void}
     * [dependencies.onLayoutChange] Receives initial layout and subsequent changes.
     * Expanded means an open, non-minimized panel has an active tool; wide selects
     * the wider vector-chart presentation. Toolbar height is measured in CSS pixels.
     * Result updates report a change only when they change these states or dimensions.
     */
    constructor({ documentContext = document, onLayoutChange = () => {} } = {}) {
        this.document = documentContext;
        this.onLayoutChange = onLayoutChange;
        this.reportedLayout = null;
        this.root = documentContext.querySelector("#map-inspection");
        this.toolbar = documentContext.querySelector("#map-tools-toolbar");
        this.panels = documentContext.querySelector("#map-inspection-panels");
        this.dockTitle = documentContext.querySelector("#map-inspection-dock-title");
        this.dockContext = documentContext.querySelector("#map-inspection-context");
        this.tabList = documentContext.querySelector("#map-inspection-tabs");
        this.toolActions = documentContext.querySelector("#workspace-tool-actions");
        this.mapToolsButton = documentContext.querySelector("#map-tools-more-summary");
        this.toolActionsOpen = false;
        /** @type {(event:ToggleEvent)=>void} Track native open/closed state synchronously. */
        this.onToolActionsBeforeToggle = event => { this.toolActionsOpen = event.newState === "open"; };
        /** @type {()=>void} Keep toolbar spacing and the opened menu aligned after reflow. */
        this.onToolActionsLayout = () => {
            this.#reportLayoutChange();
            this.#positionToolActions();
        };
        /** @type {(event:MouseEvent)=>void} Dismiss before an action reaches its independent owner. */
        this.onToolActionsCommand = event => {
            const button = /** @type {Element} */ (event.target).closest("button");
            if (button && !button.disabled) this.#closeToolActions();
        };
        this.toolActions.addEventListener("beforetoggle", this.onToolActionsBeforeToggle);
        this.toolActions.addEventListener("toggle", this.onToolActionsLayout);
        this.toolActions.addEventListener("click", this.onToolActionsCommand, true);
        this.document.defaultView?.addEventListener?.("resize", this.onToolActionsLayout);
        this.clickContext = documentContext.querySelector("#map-click-context");
        this.clickLabel = "";
        this.clickResults = ["histogram", "feature"].map(name => ({
            name, button: documentContext.querySelector(name === "feature" ? "#map-inspection-tab-feature" : "#map-click-histogram"),
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
        this.rasterClips = documentContext.querySelector("#raster-clips-panel");
        this.annotations = documentContext.querySelector("#annotations-panel");
        this.rasterSeries = documentContext.querySelector("#raster-series");
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
        this.map = documentContext.querySelector("#map");
        this.closeButton = documentContext.querySelector("#close-map-histogram");
        this.tools = [
            { name: "models", label: "Models", panel: documentContext.querySelector("#models-panel"),
                tab: documentContext.querySelector("#map-inspection-tab-models") },
            { name: "raster-series", label: "Raster statistics", panel: this.rasterSeries, raster: true, resultNavigation: true,
                tab: documentContext.querySelector("#open-raster-series-dock") },
            { name: "annotations", label: "Polygons", panel: this.annotations,
                tab: documentContext.querySelector("#map-inspection-tab-annotations") },
            {
                name: "raster-clips", label: "Download raster clip", panel: this.rasterClips,
                tab: documentContext.querySelector("#map-inspection-tab-raster-clips"),
            },
            {
                name: "histogram",
                label: "Histograms", raster: true, resultNavigation: true,
                panel: this.histogram,
                tab: documentContext.querySelector("#map-click-histogram"),
            },
            {
                name: "feature",
                label: "Features", resultNavigation: true,
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
        const tasks = {
            style: "Appearance", filter: "Data selection",
            "raster-clips": "Export", histogram: "Raster analysis",
            "raster-series": "Raster analysis", feature: "Point inspection",
        };
        for (const tool of this.tools) {
            tool.task = tasks[tool.name] ?? "Analysis";
            tool.context = null;
        }
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
                !(this.histogram.contains(this.document.activeElement) ||
                    this.document.activeElement === this.closeButton)) return;
            event.preventDefault();
            event.stopPropagation();
            this.closeHistogram();
        };
        this.closeButton.addEventListener("click", this.onClose);
        this.minimizeButton.addEventListener("click", this.onMinimize);
        for (const { tab } of this.tools.filter(tool => !tool.resultNavigation)) {
            tab.addEventListener("click", this.onTabClick);
            tab.addEventListener("keydown", this.onTabKeydown);
        }
        this.featureDetailsToggle.addEventListener(
            "click", this.onToggleFeatureDetails
        );
        this.document.addEventListener("keydown", this.onKeydown);
        this.#renderDock();
        const ResizeObserverClass = documentContext.defaultView?.ResizeObserver;
        this.dockObserver = ResizeObserverClass
            ? new ResizeObserverClass(() => {
                this.#reportLayoutChange();
                this.#positionToolActions();
            })
            : null;
        this.dockObserver?.observe(this.root);
        this.dockObserver?.observe(this.toolActions);
        this.dockObserver?.observe(this.toolbar);
    }

    /**
     * Open the Tools menu from its persistent toolbar button.
     * The caller can then focus the command it wants the user to return to.
     * @return {void}
     */
    showToolActions() {
        if (!this.toolActionsOpen) {
            this.mapToolsButton.click();
        }
    }

    /** Close the transient popover without changing any tool's state. @return {void} */
    #closeToolActions() {
        if (this.toolActionsOpen) this.toolActions.hidePopover();
    }

    /**
     * Keep the shared action list near its visible invoker and inside the viewport.
     * Prefer below the button, flip above when necessary and constrain both axes.
     * Native popover focus order and dismissal remain owned by the browser.
     * @return {void}
     */
    #positionToolActions() {
        if (!this.toolActionsOpen) return;
        const { innerWidth, innerHeight } = this.document.defaultView;
        const anchor = this.mapToolsButton.getBoundingClientRect();
        const menu = this.toolActions.getBoundingClientRect();
        const below = anchor.bottom + 6;
        const top = below + menu.height <= innerHeight - 8 ? below : anchor.top - menu.height - 6;
        this.toolActions.style.top = `${Math.max(8, Math.min(top, innerHeight - menu.height - 8))}px`;
        this.toolActions.style.left = `${Math.max(8, Math.min(anchor.right - menu.width, innerWidth - menu.width - 8))}px`;
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
            "Histograms",
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
     * @throws {TypeError} When a supplied layer label is empty or not a string.
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
        this.setToolContext("style", { source: layerLabel ?? "Selected layer", scope: "" });
        this.#showTool("style");
    }

    /**
     * Update an existing layer editor's tab without opening it or changing focus.
     * @param {"style"|"filter"} editor Layer editor whose target was renamed.
     * @param {string} layerLabel Current map-layer display name.
     * @return {void}
     * @throws {TypeError} If the editor or display name is invalid.
     */
    updateLayerEditorName(editor, layerLabel) {
        if (!["style", "filter"].includes(editor) || typeof layerLabel !== "string" || !layerLabel.trim()) {
            throw new TypeError("A style or filter editor and a non-empty layer name are required.");
        }
        const action = editor === "style" ? "Style" : "Filter";
        this.#setToolLabel(editor, `${action} · ${layerLabel}`, `${action} ${layerLabel}`);
        this.setToolContext(editor, { source: layerLabel, scope: "" });
    }

    /**
     * Reveal a dedicated layer filter editor.
     * @param {string} layerLabel User-facing retained layer label.
     * @return {void}
     * @throws {TypeError} When the layer label is not a string.
     */
    showFilter(layerLabel) {
        this.#setToolLabel("filter", `Filter · ${layerLabel}`, `Filter ${layerLabel}`);
        this.setToolContext("filter", { source: layerLabel, scope: "" });
        this.#showTool("filter");
    }

    /**
     * Retain display-only context supplied by a tool owner through composition.
     * Updating an inactive tool does not open it, change analytical scope, or move focus.
     * @param {string} name Existing tool's stable presentation identity.
     * @param {MapInspectionToolContext|null} context Source/scope labels, or null to clear.
     * @return {void}
     * @throws {RangeError} When the tool is unknown.
     * @throws {TypeError} When supplied display labels are not strings.
     */
    setToolContext(name, context) {
        const tool = this.#tool(name);
        if (context !== null && (typeof context !== "object" ||
            typeof context.source !== "string" || typeof context.scope !== "string")) {
            throw new TypeError("Map tool context requires source and scope display strings.");
        }
        if (tool.context?.source === context?.source && tool.context?.scope === context?.scope) return;
        tool.context = context === null ? null : { source: context.source, scope: context.scope };
        this.#renderDock();
    }

    /** Reveal annotation tools without changing other tools or their data. @return {void} */
    showAnnotations() { this.#showTool("annotations"); }

    /** Close annotation tools while retaining their controls. @return {void} */
    hideAnnotations() { this.#hideTool("annotations"); }

    /** Reveal raster-series plotting without changing peer data. @return {void} */
    showRasterSeries() { this.#showTool("raster-series"); }

    /** Close raster-series plotting while retaining its settings. @return {void} */
    hideRasterSeries() { this.#hideTool("raster-series"); }

    /** Reveal Models without changing any model draft or accepted job. @return {void} */
    showModels() { this.#showTool("models"); }

    /** Hide Models while its controller retains setup and run observation. @return {void} */
    hideModels() { this.#hideTool("models"); }


    /** Reveal the raster clip tool while retaining peer panels. @return {void} */
    showRasterClips() { this.#showTool("raster-clips"); }

    /** Close raster clips without cancelling server work. @return {void} */
    hideRasterClips() { this.#hideTool("raster-clips"); }

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
        this.clickLabel = `Point · ${position.lat.toFixed(4)}, ${position.lng.toFixed(4)}`;
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

    /** Present compact result feedback without moving another tool into the foreground.
     * Routine completion belongs to the results; loading and failures remain visible.
     * @return {void}
     */
    #renderResultNavigation() {
        this.clickContext.textContent = this.clickLabel;
        for (const entry of this.clickResults) {
            const {name, button, status, snapshot} = entry;
            const tool = this.#tool(name);
            const loading = snapshot?.state === "loading";
            button.disabled = name === "feature" && tool.panel.hidden && snapshot === null;
            button.setAttribute("data-unread", String(entry.unread));
            button.setAttribute("data-loading", String(loading));
            button.setAttribute("aria-pressed", String(this.activeTool === name && !this.minimized));
            status.textContent = snapshot === null ? "" : snapshot.message + (entry.unread ? " · New results" : "");
            status.hidden = snapshot === null || this.minimized ||
                !(["error", "invalidated"].includes(snapshot.state) ||
                    (loading && this.activeTool === name));
            if (snapshot !== null) button.title = status.textContent;
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
        if (name !== "raster-clips" && !this.rasterClips.hidden) {
            this.#closeToolState("raster-clips");
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
     * @return {{name:string,label:string,task:string,context:MapInspectionToolContext|null,panel:HTMLElement,tab:HTMLButtonElement,raster?:boolean,resultNavigation?:boolean}}
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
     * @param {string} label Visible retained-tab label; raster navigation keeps its stable caption.
     * @param {string} [title=""] Optional full hover label.
     * @return {void}
     */
    #setToolLabel(name, label, title = "") {
        const { tab, raster } = this.#tool(name);
        if (!raster) tab.textContent = label;
        tab.title = title;
    }

    /**
     * Restore one dock tool's stable base label and clear its retained context.
     *
     * @param {string} name Stable presentation name.
     * @return {void}
     */
    #resetToolLabel(name) {
        const tool = this.#tool(name);
        tool.context = null;
        this.#setToolLabel(name, tool.label);
    }

    /**
     * Apply one analysis-owned identity without exposing analysis data here.
     *
     * @param {string} name Stable presentation name.
     * @param {{label:string,title:string}|null} identity Presentation identity.
     * @return {void}
     * @throws {TypeError} When a supplied label or title is empty or not a string.
     */
    #setToolIdentity(name, identity) {
        if (identity === null) {
            this.#resetToolLabel(name);
            this.#renderDock();
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
        this.setToolContext(name, {
            source: identity.title,
            scope: name === "time-series" ? "Across sampled vector features" : "Selected vector feature",
        });
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
        const openTools = this.#openTools().filter(({tab, resultNavigation}) => !resultNavigation && !tab.hidden);
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
     * Synchronize retained panels while keeping Tools above a newly opened dock.
     * Commands dismiss the native menu before their owner runs; passive opening
     * raises an already open menu again and restores its focused command.
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
        const openChanged = shouldOpen !== this.isOpen;
        this.isOpen = shouldOpen;
        this.#renderDock();
        if (openChanged) {
            if (shouldOpen) {
                const restoreMenu = this.toolActionsOpen;
                const focusedCommand = this.toolActions.contains(this.document.activeElement)
                    ? this.document.activeElement : null;
                this.root.showPopover();
                if (restoreMenu) {
                    this.#closeToolActions();
                    this.showToolActions();
                    focusedCommand?.focus({ preventScroll: true });
                }
            }
            else this.root.hidePopover();
            this.#reportLayoutChange();
        }
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
     * Render foreground task/source/scope, retained navigation and active-panel visibility.
     * Raster destinations use stable native buttons; their owners handle opening.
     * Features share the compact result navigation. Raster statistics omits the
     * inactive Style tab while retaining its editor; other tools keep their tabs.
     * Models and polygon editing use their panel headings without another task heading.
     * Opening or updating a tool never replaces its focused raster destination.
     * Hide the panel surface when no tool is active so the retained result header
     * cannot leave an invisible container intercepting map input below it.
     * Return focus to Tools if closing the last panel removes its minimize action.
     *
     * @return {void}
     */
    #renderDock() {
        this.panels.hidden = this.minimized || this.activeTool === null;
        this.root.setAttribute("data-minimized", String(this.minimized));
        this.root.setAttribute("data-active-tool", this.activeTool ?? "");
        const tool = this.activeTool === null ? null : this.#tool(this.activeTool);
        this.dockTitle.textContent = tool === null ? "Explore data" : `${tool.task} · ${tool.label}`;
        this.dockTitle.title = this.dockTitle.textContent;
        this.dockTitle.hidden = ["histogram", "raster-series", "feature", "annotations", "models"].includes(this.activeTool);
        const context = tool?.context ?? (this.activeTool === "feature"
            ? { source: "Visible vector layers", scope: this.clickLabel }
            : { source: "", scope: "" });
        this.dockContext.textContent = [context.source, context.scope].filter(Boolean).join(" · ");
        this.dockContext.hidden = this.dockTitle.hidden || !this.dockContext.textContent;
        const restoreToolbarFocus = !this.isOpen && this.document.activeElement === this.minimizeButton;
        this.minimizeButton.hidden = !this.isOpen;
        if (restoreToolbarFocus) this.mapToolsButton.focus();
        this.minimizeButton.textContent = this.minimized ? "Expand" : "Minimize";
        this.minimizeButton.setAttribute(
            "aria-expanded", String(!this.minimized)
        );
        this.minimizeButton.setAttribute(
            "aria-label", this.minimized ? "Expand map tools" : "Minimize map tools"
        );
        for (const { name, panel, tab, resultNavigation } of this.tools) {
            const open = !panel.hidden;
            const active = open && this.activeTool === name;
            tab.hidden = resultNavigation ? false : !open ||
                (name === "style" && this.activeTool === "raster-series");
            if (resultNavigation) tab.setAttribute("aria-pressed", String(active && !this.minimized));
            else {
                tab.setAttribute("aria-selected", String(active));
                tab.tabIndex = active ? 0 : -1;
            }
            panel.setAttribute("data-map-inspection-active", String(active));
            panel.setAttribute(
                "aria-hidden", String(!active || this.minimized)
            );
            panel.setAttribute("aria-labelledby", tab.id);
        }
        const visibleTabs = this.tools.filter(({tab, resultNavigation}) => !resultNavigation && !tab.hidden);
        this.tabList.hidden = visibleTabs.length === 0 || this.minimized;
        if (!visibleTabs.some(({tab}) => tab.tabIndex === 0) && visibleTabs.length > 0) {
            visibleTabs[0].tab.tabIndex = 0;
        }
        const active = this.minimized ? null : this.activeTool;
        this.#renderResultNavigation();
        if (active !== this.reportedActiveTool) {
            this.reportedActiveTool = active;
            for (const listener of this.activityListeners) listener(active);
        }
        this.#reportLayoutChange();
    }

    /** Position panels below the toolbar and report its height with panel states.
     * The composition root forwards these dimensions and states to the app layout
     * owner so other shell controls can remain clear of the toolbar.
     * @return {void}
     */
    #reportLayoutChange() {
        const toolbarHeight = Math.ceil(this.toolbar.getBoundingClientRect().height);
        const toolbarHeightValue = `${toolbarHeight}px`;
        if (this.root.style.getPropertyValue("--map-tools-height") !== toolbarHeightValue) {
            this.root.style.setProperty("--map-tools-height", toolbarHeightValue);
        }
        const expanded = this.isOpen && !this.minimized && this.activeTool !== null;
        const layout = {
            open: this.isOpen,
            expanded,
            wide: this.activeTool === "time-series" || this.activeTool === "feature-profile",
            toolbarHeight,
        };
        const previous = this.reportedLayout;
        if (previous && previous.open === layout.open &&
            previous.expanded === layout.expanded && previous.wide === layout.wide &&
            previous.toolbarHeight === layout.toolbarHeight) return;
        this.reportedLayout = layout;
        this.onLayoutChange({ ...layout });
    }

    /** Release presentation listeners without changing retained analysis state. @return {void} */
    destroy() {
        this.#closeToolActions();
        this.toolActions.removeEventListener("beforetoggle", this.onToolActionsBeforeToggle);
        this.toolActions.removeEventListener("toggle", this.onToolActionsLayout);
        this.toolActions.removeEventListener("click", this.onToolActionsCommand, true);
        this.document.defaultView?.removeEventListener?.("resize", this.onToolActionsLayout);
        this.dockObserver?.disconnect();
        for (const {button} of this.clickResults) button.removeEventListener("click", this.onSummaryClick);
        this.hasClick = false;
        this.closeButton.removeEventListener("click", this.onClose);
        this.minimizeButton.removeEventListener("click", this.onMinimize);
        for (const { tab } of this.tools.filter(tool => !tool.resultNavigation)) {
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
        this.rasterClips.hidden = true;
        this.annotations.hidden = true;
        this.rasterSeries.hidden = true;
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
