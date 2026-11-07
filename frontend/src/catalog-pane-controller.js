/**
 * Show catalog results and selected-dataset details in the available screen space.
 *
 * In authoring mode, Catalog search and results remain available. The selected
 * Item is revealed only when a result is chosen: CSS presents it as an
 * adjacent column when space permits and as a drill-in view otherwise.
 * A supplied dialog presents only included-layer metadata in a shared viewer.
 */

/**
 * @typedef {Object} CatalogPaneControls
 * @property {(options?: CatalogPaneFocusOptions) => void} showInspector
 * Reveals the selected Item's metadata on explicit request.
 * @property {(options?: CatalogPaneFocusOptions) => void} showResults Hides
 * the selected-Item inspector and returns to the results presentation.
 * @property {() => boolean} isInspectorVisible Reports whether the selected
 * Item is currently presented.
 */

/**
 * @typedef {Object} CatalogPaneFocusOptions
 * @property {boolean} [moveFocus=false] Whether to move focus to the heading
 * of the pane being shown.
 * @property {HTMLElement|null} [returnFocusTarget=null] Result control to focus
 * when returning from details, if it still exists in the current results.
 * @property {() => void} [onDismiss] Notify the caller once when the inspector
 * closes, after any focus restoration.
 */

/**
 * Connect the catalog's results, dataset details and back controls.
 *
 * @param {Document} documentContext Document containing the Catalog workspace.
 * @param {() => void} [onLayoutChange=() => {}] Notifies the composition root
 * when progressive inspector visibility changes the workspace allocation.
 * @param {Object} [options] Presentation options supplied by composition.
 * @param {HTMLDialogElement|null} [options.detailsDialog=null] Present included-layer
 * metadata in this dialog instead of opening the catalog browser.
 * @return {CatalogPaneControls} Controls for opening details or returning to results.
 * @throws {TypeError} When the layout-change notifier is not callable.
 * @throws {Error} When required Catalog pane markup is absent.
 */
export function initializeCatalogPaneControls(
    documentContext = document,
    onLayoutChange = () => {},
    { detailsDialog = null } = {}
) {
    if (typeof onLayoutChange !== "function") {
        throw new TypeError("Catalog layout-change notifier must be callable");
    }
    const requiredElements = {
        layout: "#catalog-layout",
        resultsPane: "#catalog-results-pane",
        resultsBody: "#catalog-results-body",
        resultsHeading: "#catalog-results-heading",
        inspectorPane: "#catalog-item-inspector",
        inspectorBody: "#catalog-inspector-body",
        inspectorHeading: "#catalog-inspector-heading",
        closeItemDetails: "#close-catalog-item-details"
    };
    const elements = Object.fromEntries(
        Object.entries(requiredElements).map(([key, selector]) => [
            key,
            documentContext.querySelector(selector)
        ])
    );
    const missingElement = Object.entries(elements).find(
        ([, element]) => element === null
    );
    if (missingElement !== undefined) {
        throw new Error(
            `Catalog panes require ${requiredElements[missingElement[0]]}`
        );
    }
    let returnFocusTarget = null;
    let onInspectorDismiss = null;
    if (detailsDialog) {
        detailsDialog.append(elements.inspectorPane);
        elements.closeItemDetails.textContent = "×";
        elements.closeItemDetails.title = "Close layer details";
        elements.closeItemDetails.setAttribute("aria-label", "Close layer details");
    }

    /**
     * Apply inspector visibility and notify its caller after closing.
     *
     * @param {boolean} isVisible Whether the inspector is presented.
     * @param {CatalogPaneFocusOptions} [options={}] Focus behavior.
     * @return {void}
     */
    function setInspectorVisible(isVisible, { moveFocus = false } = {}) {
        const visibilityChanged = elements.inspectorPane.hidden === isVisible;
        elements.inspectorPane.hidden = !isVisible;
        elements.inspectorPane.setAttribute(
            "aria-hidden",
            String(!isVisible)
        );
        elements.inspectorBody.hidden = !isVisible;
        elements.layout.classList.toggle(
            "is-catalog-inspector-visible",
            isVisible
        );
        elements.layout.classList.toggle(
            "is-catalog-inspector-collapsed",
            !isVisible
        );
        elements.inspectorBody.scrollTop = 0;
        if (detailsDialog) {
            if (isVisible && !detailsDialog.open) detailsDialog.showModal();
            if (!isVisible && detailsDialog.open) detailsDialog.close();
        }

        if (moveFocus) {
            const target = isVisible
                ? elements.inspectorHeading
                : returnFocusTarget?.isConnected
                    ? returnFocusTarget
                    : detailsDialog ? documentContext.querySelector("#toggle-map-layers") : elements.resultsHeading;
            target.focus();
        }
        if (visibilityChanged) {
            if (!isVisible) {
                const onDismiss = onInspectorDismiss;
                onInspectorDismiss = null;
                onDismiss?.();
            }
            onLayoutChange();
        }
    }

    /**
     * Returns from the active inspector without closing the Catalog workspace.
     *
     * @param {KeyboardEvent} event Keyboard event dispatched within inspector.
     * @return {void}
     */
    function handleInspectorKeydown(event) {
        if (event.key !== "Escape" || elements.inspectorPane.hidden) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        setInspectorVisible(false, { moveFocus: true });
    }

    setInspectorVisible(!elements.inspectorPane.hidden);
    detailsDialog?.addEventListener("cancel", (event) => {
        event.preventDefault();
        setInspectorVisible(false, { moveFocus: true });
    });

    elements.closeItemDetails.addEventListener("click", () => {
        setInspectorVisible(false, { moveFocus: true });
    });
    elements.inspectorPane.addEventListener(
        "keydown",
        handleInspectorKeydown
    );

    return Object.freeze({
        /**
         * Reveal metadata and remember where to return focus and report dismissal.
         *
         * @param {CatalogPaneFocusOptions} [options={}] Focus and dismissal behavior.
         * @return {void}
         */
        showInspector(options = {}) {
            returnFocusTarget = options.returnFocusTarget ?? null;
            onInspectorDismiss = options.onDismiss ?? null;
            setInspectorVisible(true, options);
        },

        /**
         * Returns to results and optionally focuses their heading.
         *
         * @param {CatalogPaneFocusOptions} [options={}] Focus behavior.
         * @return {void}
         */
        showResults(options = {}) {
            setInspectorVisible(false, options);
        },

        /**
         * Reports the current inspector presentation state.
         *
         * @return {boolean} True when the selected-Item pane is visible.
         */
        isInspectorVisible() {
            return !elements.inspectorPane.hidden;
        }
    });
}
