import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MARKUP = readFileSync(
    new URL("../index.html", import.meta.url),
    "utf8"
);
const STYLESHEET = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8"
);
const COMPOSITION_SOURCE = readFileSync(
    new URL("../src/main.js", import.meta.url),
    "utf8"
);
const CATALOG_ACTION_SOURCE = readFileSync(
    new URL("../src/catalog-map-actions.js", import.meta.url),
    "utf8"
);

/**
 * Find one stable ID's byte position in the application markup.
 *
 * @param {string} identifier Stable DOM identifier.
 * @return {number} Zero-based byte position.
 * @throws {Error} If the identifier is absent.
 */
function requireMarkupPosition(identifier) {
    const position = MARKUP.indexOf(`id="${identifier}"`);
    if (position < 0) {
        throw new Error(`Required markup ID is missing: ${identifier}`);
    }
    return position;
}

/**
 * Count exact occurrences of one stable DOM ID.
 *
 * @param {string} identifier Stable DOM identifier.
 * @return {number} Number of exact ID attributes.
 */
function countMarkupId(identifier) {
    return MARKUP.match(new RegExp(`id="${identifier}"`, "g"))?.length ?? 0;
}

/**
 * Find the complete source range for one non-void element with a stable ID.
 *
 * Matching tags are balanced so nested sections do not truncate a workspace.
 *
 * @param {string} identifier Stable DOM identifier.
 * @return {{start: number, end: number, source: string}} Complete element
 * range and source, including its opening and closing tags.
 * @throws {Error} If the element or its matching closing tag is absent.
 */
function requireElementRange(identifier) {
    const openingPattern = new RegExp(
        `<([a-z][\\w-]*)\\b[^>]*\\bid="${identifier}"[^>]*>`,
        "i"
    );
    const openingMatch = openingPattern.exec(MARKUP);
    if (openingMatch === null) {
        throw new Error(`Required markup element is missing: ${identifier}`);
    }
    const tagName = openingMatch[1];
    const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
    tagPattern.lastIndex = openingMatch.index;
    let depth = 0;
    for (const tagMatch of MARKUP.matchAll(tagPattern)) {
        depth += tagMatch[0].startsWith("</") ? -1 : 1;
        if (depth === 0) {
            const end = tagMatch.index + tagMatch[0].length;
            return {
                start: openingMatch.index,
                end,
                source: MARKUP.slice(openingMatch.index, end),
            };
        }
    }
    throw new Error(`Required markup element is not closed: ${identifier}`);
}

test("one sidebar owns the workspace disclosures and compact status", () => {
    const panel = requireElementRange("control-panel");
    const operationalStatus = requireElementRange(
        "eomap-operational-status-region"
    );
    const catalogState = requireMarkupPosition("system-state");
    const renderingState = requireMarkupPosition("rendering-diagnostics");

    assert.ok(panel.start < operationalStatus.start);
    assert.ok(operationalStatus.start < catalogState);
    assert.ok(catalogState < renderingState);
    assert.ok(renderingState < operationalStatus.end);
    assert.match(
        panel.source,
        /class="panel-content workspace-disclosures"[^>]*id="eomap-tools-workbench"[^>]*aria-label="EOMap workspaces"/s
    );
    assert.doesNotMatch(panel.source, /role="tab(?:list|panel)?"/);
    assert.match(
        panel.source,
        /id="toggle-operational-status"[^>]*aria-label="Show status details"[^>]*aria-controls="eomap-operational-status-body"[^>]*aria-expanded="false"[^>]*>[\s\S]*?<span class="panel-header-action-label">Status<\/span>\s*<\/button>/s
    );
    assert.match(
        panel.source,
        /id="eomap-operational-status-body"[^>]*aria-hidden="true"[^>]*hidden/s
    );
});

test("compact header owns branding and actions while alerts stay outside hidden details", () => {
    const header = requireElementRange("app-header");
    const status = requireElementRange("eomap-operational-status-region");
    const body = requireElementRange("eomap-operational-status-body");
    for (const id of ["app-title", "app-subtitle", "toggle-operational-status", "collapse-panel"]) {
        assert.match(header.source, new RegExp(`id="${id}"`));
    }
    assert.match(header.source, /class="panel-identity"/);
    assert.match(header.source, /class="panel-header-actions"/);
    assert.doesNotMatch(MARKUP, /Earth observation workspace|operational-status-heading/);
    assert.ok(header.end < status.start);
    for (const id of ["catalog-state-announcement", "rendering-state-announcement"]) {
        const announcement = requireElementRange(id);
        assert.ok(status.start < announcement.start && announcement.end < body.start);
        assert.match(announcement.source, /role="status"[^>]*aria-live="polite"/s);
        assert.doesNotMatch(announcement.source, /aria-hidden|\shidden(?:\s|>)/);
    }
    assert.match(STYLESHEET, /\.panel-header\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
    assert.match(STYLESHEET, /\.panel-identity\s*\{[^}]*min-width:\s*0/s);
    assert.match(STYLESHEET, /\.panel-header-actions\s*\{[^}]*display:\s*flex[^}]*flex-shrink:\s*0/s);
    assert.doesNotMatch(STYLESHEET, /\.panel-header \.subtitle\s*\{[^}]*display:\s*none/s);
    assert.match(STYLESHEET, /\.operational-status-notice:not\(\.visually-hidden\)/);
});

test("Catalog and Map layers are independent sibling disclosures", () => {
    const panel = requireElementRange("control-panel");
    const catalogRegion = requireElementRange("eomap-catalog-region");
    const renderingRegion = requireElementRange("eomap-map-layers-region");
    const disclosures = [
        ["toggle-catalog-workspace", "eomap-catalog-region", "true"],
        ["toggle-map-layers", "eomap-map-layers-region", "false"],
    ];

    for (const [toggle, region, expanded] of disclosures) {
        assert.match(
            panel.source,
            new RegExp(
                `class="workspace-disclosure"[^>]*id="${toggle}"[^>]*aria-controls="${region}"[^>]*aria-expanded="${expanded}"`,
                "s"
            )
        );
    }
    const catalogToggle = requireMarkupPosition("toggle-catalog-workspace");
    const renderingToggle = requireMarkupPosition("toggle-map-layers");
    assert.ok(catalogToggle < catalogRegion.start);
    assert.ok(catalogRegion.end < renderingToggle);
    assert.ok(renderingToggle < renderingRegion.start);
    for (const [region, toggle] of [
        [catalogRegion.source, "toggle-catalog-workspace"],
        [renderingRegion.source, "toggle-map-layers"],
    ]) {
        assert.match(region, /role="region"/);
        assert.match(region, new RegExp(`aria-labelledby="${toggle}"`));
    }
    assert.doesNotMatch(
        catalogRegion.source.match(/<section\b[^>]*>/)?.[0] ?? "",
        /aria-hidden="true"|hidden/
    );
    assert.match(renderingRegion.source, /aria-hidden="true"/);
    assert.match(renderingRegion.source, /hidden/);
    assert.doesNotMatch(MARKUP, /toggle-raster-interpretation/);
    assert.doesNotMatch(MARKUP, /eomap-raster-interpretation-region/);
    assert.match(
        MARKUP,
        /id="collapse-panel"[^>]*aria-controls="control-panel"[^>]*aria-expanded="true"/s
    );
    assert.match(
        MARKUP,
        /id="open-panel"[^>]*aria-controls="control-panel"[^>]*aria-expanded="false"[^>]*hidden/s
    );
});

test("Catalog owns discovery, inspection, and its explicit layer action only", () => {
    const catalogRegion = requireElementRange("eomap-catalog-region");
    const catalogInspector = requireElementRange("catalog-item-inspector");
    const catalogActions = requireElementRange("catalog-map-actions");

    assert.match(catalogRegion.source, /id="catalog-results-pane"/);
    assert.match(catalogRegion.source, /id="catalog-search"/);
    assert.match(catalogRegion.source, /id="catalog-item-inspector"/);
    assert.match(catalogInspector.source, /id="toggle-catalog-layer"/);
    assert.match(catalogInspector.source, />\s*Add to map\s*</);
    assert.match(catalogActions.source, /id="catalog-map-action-status"/);
    assert.match(
        catalogActions.source,
        /id="toggle-catalog-layer"[\s\S]*aria-describedby="catalog-map-action-status"/
    );
    assert.match(catalogInspector.source, /id="catalog-inspector-content"/);
    for (const foreignControl of [
        "catalog-layer-status",
        "map-layer-rendering-announcement",
        "raster-layer-stack",
        "raster-sampling-area-controls",
        "raster-histogram",
    ]) {
        assert.doesNotMatch(
            catalogInspector.source,
            new RegExp(`id="${foreignControl}"`)
        );
    }
});

test("Map layers owns compact rows; the bounded map-tool dock owns styling", () => {
    const rendering = requireElementRange("eomap-map-layers-region");
    const editor = requireElementRange("layer-style-editor");
    const panel = requireElementRange("control-panel");
    assert.ok(editor.start > panel.end, "Style editor must be outside sidebar overflow");
    const inspection = requireElementRange("map-inspection");
    assert.ok(editor.start > inspection.start && editor.end < inspection.end);
    assert.match(inspection.source, /popover="manual"/);
    assert.match(editor.source, /role="tabpanel"/);
    assert.match(inspection.source, /id="map-inspection-tabs"[^>]+role="tablist"/);
    assert.match(inspection.source, /id="map-inspection-dock-title"[^>]*>Explore data/);
    assert.match(inspection.source, /class="map-inspection-raster-analysis" aria-label="Analysis results"/);
    assert.match(inspection.source, /id="open-raster-series-dock"[\s\S]*?aria-controls="raster-series"/);
    assert.doesNotMatch(inspection.source, /popovertarget="workspace-tool-actions"/);
    assert.match(
        inspection.source,
        /id="style-inspected-vector-layer"[\s\S]*?aria-controls="layer-style-editor"/
    );
    for (const [tab, panelId] of [
        ["time-series", "vector-time-series"],
        ["feature-profile", "vector-feature-profile"],
        ["raster-clips", "raster-clips-panel"],
        ["annotations", "annotations-panel"],
        ["style", "layer-style-editor"],
    ]) {
        assert.match(
            inspection.source,
            new RegExp(`id="map-inspection-tab-${tab}"[\\s\\S]*?role="tab"[\\s\\S]*?aria-controls="${panelId}"`)
        );
    }
    for (const id of [
        "layer-style-opacity", "raster-appearance-controls",
    ]) {
        assert.match(editor.source, new RegExp(`id="${id}"`));
        assert.doesNotMatch(rendering.source, new RegExp(`id="${id}"`));
    }
    const histogram = requireElementRange("map-histogram-panel");
    const pairedStyle = requireElementRange("raster-bivariate-style-ranges");
    assert.ok(pairedStyle.start > histogram.start && pairedStyle.end < histogram.end);
    for (const id of [
        "raster-bivariate-panel", "raster-bivariate-palette", "raster-bivariate-legend",
        "swap-raster-bivariate-axes",
    ]) {
        assert.match(pairedStyle.source, new RegExp(`id="${id}"`));
        assert.doesNotMatch(editor.source, new RegExp(`id="${id}"`));
        assert.doesNotMatch(rendering.source, new RegExp(`id="${id}"`));
    }
    assert.match(rendering.source, /id="raster-layer-stack"/);
    assert.doesNotMatch(MARKUP, /id="open-histogram-map-layers"/);
    assert.match(STYLESHEET, /#map-inspection\s*\{[^}]*position:\s*fixed/s);
    assert.match(STYLESHEET, /#map-inspection\s*\{[^}]*height:\s*calc\(100dvh - 32px - var\(--map-tools-height, 42px\)\)/s);
    assert.match(STYLESHEET, /\.map-inspection-panels\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    assert.match(STYLESHEET, /\.map-inspection-tabs\s*\{[^}]*flex-wrap:\s*wrap[^}]*overflow:\s*visible/s);
    assert.match(STYLESHEET, /#map-inspection\[data-minimized="true"\] \.map-inspection-tabs\s*\{[^}]*display:\s*none/s);
    assert.match(STYLESHEET, /#map-inspection\s*\{[^}]*pointer-events:\s*none/s);
    assert.match(
        STYLESHEET,
        /#map-inspection-tab-style\s*\{[^}]*text-overflow:\s*ellipsis/s
    );
    assert.match(STYLESHEET, /#map-histogram-panel,\s*#raster-series,\s*#annotations-panel,\s*#models-panel,\s*#raster-clips-panel,\s*#layer-style-editor,\s*#vector-filter-panel,\s*#vector-feature-inspector,\s*#vector-time-series,\s*#vector-feature-profile\s*\{[^}]*height:\s*100%[^}]*overflow-y:\s*auto/s);
    assert.doesNotMatch(STYLESHEET, /\.map-inspection-panels:has\(/);
});

test("Map layers has one heading and collapse control with no nested list widget", () => {
    const rendering = requireElementRange("eomap-map-layers-region");
    const stack = requireElementRange("raster-layer-stack");
    assert.doesNotMatch(rendering.source, /<h[1-6]\b|workspace-region-heading/);
    assert.match(rendering.source, /aria-labelledby="toggle-map-layers"/);
    assert.match(rendering.source, /No map layers yet\. Add an item from Catalog, upload polygons, or draw your own polygon\./);
    assert.match(stack.source, /id="raster-layer-list" aria-label="Map layers"/);
    assert.match(stack.source, /id="raster-layer-stack-status"[^>]*role="status"/s);
    assert.doesNotMatch(stack.source, /aria-expanded|aria-controls/);
    for (const obsolete of [
        "eomap-map-layers-heading", "open-map-layer-histograms",
        "raster-layer-stack-heading", "map-layer-widget", "raster-layer-stack-body",
        "raster-layer-widget-count",
    ]) {
        assert.doesNotMatch(MARKUP, new RegExp(obsolete));
        assert.doesNotMatch(STYLESHEET, new RegExp(obsolete));
    }
    assert.doesNotMatch(MARKUP, /Layers on this map|Hide list/);
});


test("successful catalog additions reveal Map layers through composition", () => {
    assert.match(
        COMPOSITION_SOURCE,
        /onAdded:\s*onRenderingWorkspaceRequested/
    );
    assert.match(
        COMPOSITION_SOURCE,
        /\(\) => layoutController\.showWorkspace\("map-layers"\)/
    );
    assert.match(
        COMPOSITION_SOURCE,
        /onHistogramRequested: \(\) => mapInspection\.showHistogram\([\s\S]*?activate: !selectingMapClick && !\["raster-series", "raster-clips", "models"\]\.includes\(mapInspection\.activeTool\)/
    );
    assert.match(
        COMPOSITION_SOURCE,
        /onLayersChange: \(layers\) => \{[\s\S]*?!layers\.some\(\(layer\) =>[\s\S]*?layer\.capabilities\?\.statistics && layer\.visible[\s\S]*?mapInspection\.closeHistogram\(false\);/
    );
    assert.doesNotMatch(COMPOSITION_SOURCE, /layoutController\.showWorkspace\("histogram"\)/);
    assert.match(COMPOSITION_SOURCE, /new MapInspectionController\(/);
    assert.doesNotMatch(COMPOSITION_SOURCE, /stopSampleWindowSelection|onHistogramClose/);
});

test("Catalog action state exists before the layer controller's synchronous initial render", () => {
    const actionOwner = COMPOSITION_SOURCE.indexOf("new CatalogMapActions(");
    const actionElements = COMPOSITION_SOURCE.indexOf("const catalogMapActionElements =");
    const layerController = COMPOSITION_SOURCE.indexOf("new MapLayerController(");
    assert.ok(actionOwner >= 0 && actionElements >= 0 && layerController >= 0);
    assert.ok(actionOwner < layerController);
    assert.ok(actionElements < layerController);
});

test("Catalog action lifecycle does not import or inspect map, analysis, style or DOM implementations", () => {
    assert.doesNotMatch(CATALOG_ACTION_SOURCE,
        /from\s+["'][^"']*(?:\/(?:map|layer-style-editor|catalog-map-action-view)\.js|\/(?:map-layers|raster|vector|processing)\/[^"']*)["']/);
    assert.doesNotMatch(CATALOG_ACTION_SOURCE,
        /\b(?:document|window|leafletMap|catalogState|mapLayerController|rasterVisualization|layerStyleEditor)\b/);
    assert.doesNotMatch(CATALOG_ACTION_SOURCE,
        /\b(?:querySelector|addEventListener|createElement|textContent|classList)\b/);
});

test("composition forwards inspection layout and CSS does not infer it from changing tool contents", () => {
    assert.match(COMPOSITION_SOURCE, /onLayoutChange: layout => layoutController\.setInspectionLayout\(layout\)/);
    assert.doesNotMatch(STYLESHEET, /#app:has\(#map-inspection/);
    assert.doesNotMatch(STYLESHEET, /#map-inspection:has\(/);
    assert.match(STYLESHEET, /#app\[data-inspection-expanded="true"\]/);
    assert.match(STYLESHEET, /#app\[data-inspection-wide="true"\]/);
    assert.match(STYLESHEET, /#app \.panel-opener\s*\{\s*inset: calc\(16px \+ var\(--map-tools-height, 42px\)\) auto auto 16px;/);
});

test("composition forwards compatible map areas and closes inspection when no raster accepts a click", () => {
    assert.match(
        COMPOSITION_SOURCE,
        /rasterClickSelected = rasterVisualization\.exploreAt\(event\.latlng, \{\s*onSelected: area => \{\s*if \(area\?\.kind === "polygonArea"\) return;\s*updateRasterSeriesArea\(area, [^;]+\);\s*\},\s*\}\);\s*if \(!rasterClickSelected\) \{\s*mapInspection\.closeHistogram\(false\);\s*updateRasterSeriesArea\(null, ""\);/
    );
    assert.match(COMPOSITION_SOURCE, /vectorFeatureInspector\.inspect\(event\)/);
});

test("map-layer Info can reveal Catalog through composition", () => {
    assert.match(
        COMPOSITION_SOURCE,
        /onCatalogWorkspaceRequested\(\);\s*selectCatalogItem\(item\);/
    );
    assert.match(
        COMPOSITION_SOURCE,
        /\(\) => layoutController\.showWorkspace\("catalog"\)/
    );
});

test("one collapsed sampling control stays outside the inspection panel and results column", () => {
    const panel = requireElementRange("control-panel");
    const exploration = requireElementRange("map-histogram-panel");
    const disclosure = requireElementRange("raster-sampling-disclosure");
    const sampling = requireElementRange("raster-sampling-area-controls");
    const toolbar = requireElementRange("map-tools-toolbar");
    const box = requireElementRange("raster-map-box-controls");
    const inspection = requireElementRange("map-inspection");
    assert.ok(disclosure.start > toolbar.start && disclosure.end < toolbar.end,
        "persistent map tools retain sampling independently of the inspection popover");
    assert.ok(disclosure.end < inspection.start);
    assert.ok(box.start > disclosure.start && box.end < disclosure.end, "one disclosure exposes box sizing and area choices");
    assert.doesNotMatch(exploration.source, /id="raster-sampling-/);
    assert.ok(exploration.start > panel.end);
    assert.match(exploration.source, /role="region"/);
    assert.match(exploration.source, /aria-labelledby="map-click-histogram"/);
    for (const id of [
        "raster-comparison-mode",
        "raster-histogram-list",
        "raster-histogram",
        "raster-bivariate-statistics",
    ]) {
        assert.match(exploration.source, new RegExp(`id="${id}"`));
        assert.doesNotMatch(panel.source, new RegExp(`id="${id}"`));
    }
    assert.match(disclosure.source, /^\s*<details[^>]*>/);
    assert.doesNotMatch(disclosure.source, /^\s*<details[^>]*\bopen\b/);
    assert.match(disclosure.source, /id="raster-sampling-area-summary"/);
    assert.match(disclosure.source, /class="raster-disclosure-chevron"[^>]*aria-hidden="true"/);
    assert.match(sampling.source, /role="radiogroup" aria-label="Sample area"/);
    assert.equal((disclosure.source.match(/<details\b/g) ?? []).length, 1);
    assert.doesNotMatch(disclosure.source, /raster-active|raster-style-controls|Sample by vector layer|<small>Use all/);
    for (const choice of [
        "clear-raster-sample-window",
        "use-map-window-for-raster",
        "use-vector-for-raster",
    ]) {
        assert.match(
            sampling.source,
            new RegExp(`id="${choice}"[^>]*type="radio"[^>]*name="raster-sampling-area"`, "s")
        );
    }
    assert.ok(requireMarkupPosition("use-map-window-for-raster") < box.start);
    assert.ok(box.end < requireMarkupPosition("clear-raster-sample-window"));
    const vector = requireElementRange("vector-sampling");
    assert.ok(requireMarkupPosition("use-vector-for-raster") < vector.start);
    assert.ok(vector.end < sampling.end);
    assert.match(vector.source, /aria-label="Polygon sample area" hidden/);
    assert.match(box.source, /id="raster-map-box-controls"[^>]*hidden/);
    assert.match(exploration.source, /1D – visible rasters/);
    assert.match(exploration.source, /2D – compare rasters/);
    assert.match(exploration.source, /No visible raster layers/);
    assert.match(requireElementRange("raster-histogram-list").source,
        /aria-label="Raster histograms"/);
    assert.doesNotMatch(MARKUP, /analysis-aoi-disclosure|toggle-analysis-aoi/);
});

test("analysis destinations share one compact navigation above the selected result", () => {
    const navigation = requireElementRange("map-inspection-raster-analysis");
    const histogram = requireElementRange("map-histogram-panel");
    for (const [id, panel, caption] of [
        ["map-click-histogram", "map-histogram-panel", "Histograms"],
        ["open-raster-series-dock", "raster-series", "Raster statistics"],
        ["map-inspection-tab-feature", "vector-feature-inspector", "Features"],
    ]) {
        const control = requireElementRange(id);
        assert.ok(control.start > navigation.start && control.end < navigation.end);
        assert.ok(control.source.includes(`aria-controls="${panel}"`));
        assert.match(control.source, /aria-pressed="false"/);
        assert.ok(control.source.includes(`>${caption}</button>`));
    }
    assert.ok(navigation.end < histogram.start);
    for (const id of ["close-map-histogram", "close-raster-series", "close-vector-inspector"]) {
        const close = requireElementRange(id);
        assert.equal(countMarkupId(id), 1);
        assert.ok(close.start > navigation.start && close.end < navigation.end, `${id} is in the common result header`);
        assert.match(close.source, /analysis-result-close/);
    }
    assert.doesNotMatch(requireElementRange("raster-series").source, /About Raster statistics|map-histogram-toolbar/);
    assert.doesNotMatch(navigation.source, /<strong/);
    for (const removed of ["map-click-navigation", "map-click-summary", "map-click-feature", "open-raster-series-histogram", "map-histogram-heading"]) {
        assert.equal(countMarkupId(removed), 0);
    }
    const features = requireElementRange("vector-feature-inspector");
    const point = requireElementRange("map-click-context");
    assert.ok(point.start > features.start && point.end < features.end);
    assert.doesNotMatch(STYLESHEET, /max-height: 45%|\.map-click-results|\.map-click-summary/);
});

test("histogram charts precede optional help, point details and mode controls", () => {
    assert.match(requireElementRange("close-map-histogram").source,
        /aria-label="Close raster histograms">×/);
    assert.match(requireElementRange("map-click-histogram").source,
        />Histograms</);
    const mode = requireElementRange("raster-bivariate-controls");
    assert.match(mode.source, /class="visually-hidden">Histogram mode/);
    assert.match(mode.source, /aria-describedby="raster-bivariate-status"/);
    for (const id of ["raster-histogram-list", "raster-histogram", "raster-bivariate-statistics"]) {
        assert.ok(requireElementRange(id).end < mode.start, `${id} precedes mode controls`);
    }
    assert.ok(requireMarkupPosition("raster-bivariate-histogram") < requireMarkupPosition("raster-bivariate-statistics-status"));
    assert.match(STYLESHEET, /#map-inspection\s*\{[^}]*inset:\s*calc\(16px \+ var\(--map-tools-height, 42px\)\) 20px 16px auto[^}]*height:\s*calc\(100dvh - 32px - var\(--map-tools-height, 42px\)\)/s);
    assert.match(STYLESHEET, /#map-inspection\s*\{[^}]*overflow:\s*visible/s);
    assert.match(STYLESHEET, /#map-histogram-panel,[^{]*\{[^}]*height:\s*100%[^}]*overflow-y:\s*auto/s);
    assert.match(STYLESHEET, /\.map-histogram-toolbar\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*space-between/s);
    assert.match(STYLESHEET, /\.map-histogram-toolbar h2\s*\{[^}]*font-size:\s*1rem/s);
    assert.match(STYLESHEET, /\.raster-disclosure-chevron\s*\{[^}]*border:\s*1px solid var\(--border-1\)[^}]*border-radius:\s*50%/s);
    assert.match(STYLESHEET, /details\[open\] > summary > \.raster-disclosure-chevron::before\s*\{[^}]*rotate\(45deg\)/s);
    assert.match(STYLESHEET, /#map-histogram-panel \.raster-bivariate-statistics,\s*#map-histogram-panel \.raster-histogram\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
    assert.doesNotMatch(MARKUP, /Inspect features|Select map window|Sample map center/);
});

test("sidebar panels own deliberate, independent scrolling", () => {
    assert.match(
        STYLESHEET,
        /\.control-panel\s*\{[^}]*width:\s*var\(--active-workspace-width\)[^}]*grid-template-columns:\s*minmax\(0, 1fr\)[^}]*overflow:\s*hidden/s
    );
    assert.match(
        STYLESHEET,
        /\.panel-content\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:[^}]*var\(--workspace-column-rail-width\)[^}]*var\(--workspace-catalog-track\)[^}]*var\(--workspace-map-layers-track\)[^}]*overflow:\s*hidden/s
    );
    assert.match(
        STYLESHEET,
        /\.workspace-disclosure\s*\{[^}]*width:\s*var\(--workspace-column-rail-width\)[^}]*writing-mode:\s*vertical-rl/s
    );
    assert.match(
        STYLESHEET,
        /\.workspace-disclosure\[aria-expanded="true"\]\s*\{[^}]*width:\s*100%[^}]*grid-row:\s*1[^}]*box-shadow:\s*inset 0 3px 0 var\(--brand\)[^}]*writing-mode:\s*horizontal-tb/s
    );
    assert.match(
        STYLESHEET,
        /\.catalog-panel\s*\{[^}]*overflow:\s*hidden/s
    );
    assert.match(
        STYLESHEET,
        /\.map-layers-region\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s
    );
    assert.match(
        STYLESHEET,
        /\.catalog-results-scroll\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s
    );
    assert.match(
        STYLESHEET,
        /\.catalog-inspector-body\s*\{[^}]*overflow-y:\s*auto/s
    );
    assert.match(
        STYLESHEET,
        /\.catalog-panel\[hidden\],\s*\.map-layers-region\[hidden\]\s*\{[^}]*display:\s*none/s
    );
});

test("CSS allocates wide space and intentional medium and narrow overlays", () => {
    assert.match(
        STYLESHEET,
        /#app\s*\{[^}]*--workspace-column-rail-width:\s*44px[^}]*--active-workspace-width:\s*clamp\([^}]*--workspace-maximum-width/s
    );
    for (const [className, allocation] of [
        ["catalog", "catalog"],
        ["map-layers", "map-layers"],
    ]) {
        assert.match(
            STYLESHEET,
            new RegExp(
                `#app\\.is-expanded-${className}-workspace\\s*\\{[^}]*--workspace-${allocation}-allocation:`,
                "s"
            )
        );
    }
    for (const [identifier, column] of [
        ["toggle-catalog-workspace", 1],
        ["eomap-catalog-region", 1],
        ["toggle-map-layers", 2],
        ["eomap-map-layers-region", 2],
    ]) {
        assert.match(
            STYLESHEET,
            new RegExp(`#${identifier}\\s*\\{[^}]*grid-column:\\s*${column}`, "s")
        );
    }
    assert.doesNotMatch(STYLESHEET, /workspace-histogram|is-expanded-histogram/);
    assert.match(
        STYLESHEET,
        /#map\s*\{[^}]*inset:[^}]*var\(--active-workspace-width\)[^}]*transition:\s*left 220ms ease/s
    );
    assert.match(
        STYLESHEET,
        /#app\.is-control-panel-collapsed #map\s*\{[^}]*left:\s*var\(--workspace-edge\)/s
    );
    assert.match(
        STYLESHEET,
        /#app\.is-expanded-catalog-workspace:has\([\s\S]*?\.catalog-layout\.is-catalog-inspector-visible[\s\S]*?--workspace-catalog-allocation:\s*var\(--workspace-catalog-inspector-width\)/s
    );
    assert.match(
        STYLESHEET,
        /@container catalog-workspace \(max-width: 639px\)\s*\{[\s\S]*?\.catalog-layout\.is-catalog-inspector-visible \.catalog-browser\s*\{[^}]*display:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /@media \(max-width: 1199px\)\s*\{[\s\S]*?#map\s*\{[^}]*inset:\s*0/s
    );
    assert.match(
        STYLESHEET,
        /@media \(max-width: 699px\)\s*\{[\s\S]*?\.control-panel\s*\{[^}]*inset:\s*auto 8px 8px[^}]*height:\s*min\(76dvh, 680px\)/s
    );
    assert.match(
        STYLESHEET,
        /@media \(max-width: 899px\)\s*\{[\s\S]*?\.panel-content\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[\s\S]*?\.workspace-disclosure\s*\{[^}]*width:\s*100%[^}]*writing-mode:\s*horizontal-tb/s
    );
    assert.match(
        STYLESHEET,
        /\.panel-opener\s*\{[^}]*top:\s*auto[^}]*bottom:\s*var\(--workspace-edge\)/s
    );
    assert.match(
        STYLESHEET,
        /@media \(max-width: 1199px\) and \(max-height: 480px\)\s*\{[\s\S]*?\.control-panel\s*\{[^}]*inset:\s*8px[^}]*height:\s*auto/s
    );
    assert.match(
        STYLESHEET,
        /#app:not\(\.is-control-panel-collapsed\) \.map-position\s*\{[^}]*display:\s*none/s
    );
    assert.doesNotMatch(STYLESHEET, /min-height:\s*720px/);
    assert.match(
        STYLESHEET,
        /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition-duration:\s*0\.01ms !important/s
    );
});

test("former map widgets are bounded sections inside their owning panel", () => {
    assert.match(
        STYLESHEET,
        /\.raster-layer-stack\s*\{[^}]*position:\s*static[^}]*width:\s*100%[^}]*max-height:\s*none[^}]*box-shadow:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-appearance-controls\s*\{[^}]*position:\s*static[^}]*width:\s*100%[^}]*max-height:\s*none[^}]*box-shadow:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-histogram\s*\{[^}]*position:\s*static[^}]*width:\s*100%[^}]*max-height:\s*none[^}]*box-shadow:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-histogram-list\s*\{[^}]*display:\s*grid[^}]*gap:\s*8px/s
    );
});

test("map overlays retain explicit non-reparenting region ownership", () => {
    assert.match(
        MARKUP,
        /id="map"[^>]*role="region"[^>]*data-eomap-region="map-layers"/s
    );
    assert.match(
        MARKUP,
        /id="map-histogram-panel"[^>]*role="region"/s
    );
});

test("workspace overflow shares one native action list", () => {
    const actions = requireElementRange("workspace-tool-actions");
    assert.match(actions.source, /popover="auto"/);
    assert.doesNotMatch(actions.source, /role="menu(?:item)?"/);
    for (const id of ["open-raster-series", "open-raster-clips", "toggle-map-legend"]) {
        assert.match(actions.source, new RegExp(`id="${id}"`));
        assert.equal(countMarkupId(id), 1);
    }
    for (const id of ["map-tools-more-summary"]) {
        assert.match(requireElementRange(id).source, /<button[\s\S]*popovertarget="workspace-tool-actions"[\s\S]*>Tools <span aria-hidden="true">▾<\/span><\/button>/);
    }
    assert.doesNotMatch(MARKUP, /id="(?:map-tools-more|map-inspection-more|open-raster-clips-dock)"/);
});

test("one persistent toolbar owns Tools, minimize and active filters outside retained panels", () => {
    const toolbar = requireElementRange("map-tools-toolbar");
    const dock = requireElementRange("map-inspection");
    assert.ok(toolbar.end < dock.start);
    for (const id of ["map-tools-more-summary", "toggle-map-inspection-dock", "map-filter-indicators"]) {
        const control = requireElementRange(id);
        assert.ok(control.start > toolbar.start && control.end < toolbar.end);
        assert.equal(countMarkupId(id), 1);
    }
    assert.equal(countMarkupId("map-inspection-more-summary"), 0);
    assert.equal(countMarkupId("map-inspection-filter-indicators"), 0);
    assert.doesNotMatch(COMPOSITION_SOURCE, /\.append\(document\.querySelector\("\.map-tool-openers"\)\)/);
});

test("supporting analysis controls preserve native buttons, clear names and disclosure targets", () => {
    for (const [id, label] of [
        ["open-models", "Data tools"],
        ["open-model-runs", "Data tool runs"],
        ["map-inspection-tab-models", "Data tools"],
        ["models-nav-library", "Choose a tool"],
    ]) {
        assert.ok(requireElementRange(id).source.endsWith(`>${label}</button>`), `${id} names its destination`);
    }
    assert.match(requireElementRange("models-heading").source, />Data tools<\/h2>$/);
    assert.match(requireElementRange("models-panel").source, /<nav class="models-navigation" aria-label="Data tools">/);
    for (const id of ["map-tools-more-summary"]) {
        const {source} = requireElementRange(id);
        assert.match(source, /^<button\b[^>]*\btype="button"/);
        assert.match(source, /aria-label="Map and analysis tools"/);
        assert.match(source, /aria-controls="workspace-tool-actions"/);
        assert.match(source, /popovertarget="workspace-tool-actions"/);
        assert.match(source, />Tools <span aria-hidden="true">▾<\/span><\/button>$/);
    }
    const minimize = requireElementRange("toggle-map-inspection-dock").source;
    assert.match(minimize, /^<button\b[^>]*\btype="button"/);
    assert.match(minimize, /aria-expanded="true"/);
    assert.match(minimize, /aria-controls="map-inspection"/);
    assert.match(minimize, />Minimize<\/button>$/);
    for (const id of ["workspace-tool-actions", "map-inspection-raster-analysis", "map-inspection-tabs", "map-inspection-panels"]) {
        assert.equal(countMarkupId(id), 1, `supporting control target ${id} exists once`);
    }
    for (const [id, accessibleName] of [
        ["models-close", "Close Data tools"],
        ["close-annotations", "Close polygon editor"],
        ["close-raster-series", "Close raster statistics"],
        ["raster-clips-close", "Close raster download"],
        ["close-vector-inspector", "Close feature inspector"],
        ["close-vector-time-series", "Close vector series"],
        ["close-vector-feature-profile", "Close feature-field plot"],
        ["close-map-histogram", "Close raster histograms"],
        ["close-vector-filter", null],
        ["close-layer-style", "Close style editor"],
    ]) {
        const {source} = requireElementRange(id);
        assert.match(source, /^<button\b[^>]*\btype="button"/, `${id} remains keyboard-operable`);
        assert.equal(countMarkupId(id), 1);
        if (accessibleName) assert.ok(source.includes(`aria-label="${accessibleName}"`), `${id} names its panel`);
        if (id === "close-vector-filter" || id === "close-layer-style") assert.match(source, />Close<\/button>$/);
        else assert.match(source, />(?:×|&times;)<\/button>$/);
        assert.doesNotMatch(source, /\btabindex="-1"|\sdisabled(?:\s|>)/, `${id} remains reachable`);
    }
});

test("semantic regions preserve one DOM instance of every owned control", () => {
    const uniqueIdentifiers = [
        "control-panel",
        "system-state",
        "rendering-diagnostics",
        "toggle-operational-status",
        "eomap-operational-status-body",
        "toggle-catalog-workspace",
        "eomap-catalog-region",
        "catalog-search",
        "catalog-results",
        "catalog-item-inspector",
        "toggle-catalog-layer",
        "toggle-map-layers",
        "eomap-map-layers-region",
        "raster-layer-stack",
        "raster-appearance-controls",
        "raster-appearance-layer",
        "raster-sampling-disclosure",
        "raster-sampling-disclosure-body",
        "raster-sampling-area-summary",
        "raster-sampling-area-controls",
        "use-map-window-for-raster",
        "raster-map-box-controls",
        "raster-sample-window-range",
        "raster-histogram-list",
        "raster-histogram",
        "raster-histogram-detail-layer",
        "raster-cursor-values",
        "raster-cursor-position",
        "raster-cursor-value-list",
        "raster-cursor-value-limit",
        "raster-cursor-copy-feedback",
        "restore-raster-cursor-values",
        "map-inspection",
        "map-inspection-panels",
        "map-inspection-tabs",
        "map-inspection-tab-feature",
        "map-inspection-tab-time-series",
        "map-inspection-tab-feature-profile",
        "map-inspection-raster-analysis",
        "map-click-histogram",
        "open-raster-series-dock",
        "open-raster-series-dock",
        "map-inspection-tab-style",
        "toggle-map-inspection-dock",
        "map-histogram-panel",
        "close-map-histogram",
        "layer-style-editor",
    ];

    for (const identifier of uniqueIdentifiers) {
        assert.equal(countMarkupId(identifier), 1, identifier);
    }
    const allIdentifiers = [...MARKUP.matchAll(/id="([^"]+)"/g)].map(
        (match) => match[1]
    );
    const duplicateIdentifiers = allIdentifiers.filter(
        (identifier, index) => allIdentifiers.indexOf(identifier) !== index
    );
    assert.deepEqual(duplicateIdentifiers, []);
});

test("compact bulk visibility buttons sit above the map layer list", () => {
    const body = requireElementRange("eomap-map-layers-body");
    const list = requireMarkupPosition("raster-layer-list");
    for (const [id, text] of [
        ["map-layers-show-all", "Show all"], ["map-layers-hide-all", "Hide all"],
    ]) {
        const button = requireElementRange(id);
        assert.ok(body.start < button.start && button.end < list);
        assert.equal(countMarkupId(id), 1);
        assert.match(button.source, /type="button"/);
        assert.ok(button.source.includes(`aria-label="${text} map layers"`));
        assert.ok(button.source.includes(`disabled>${text}</button>`));
    }
    assert.match(STYLESHEET, /\.map-layer-visibility-actions\s*\{[^}]*flex-wrap: wrap/s);
});

test("shared layer creation and joining live in Map layers without a session toolbar panel", () => {
    const layers = requireElementRange("eomap-map-layers-region");
    const annotations = requireElementRange("annotations-panel");
    const inspection = requireElementRange("map-inspection-panels");
    const header = requireElementRange("app-header");
    assert.doesNotMatch(header.source, /id="open-annotations"/);
    assert.doesNotMatch(MARKUP, /id="annotation-sessions"/);
    assert.match(layers.source, /id="create-shared-annotation-layer"/);
    assert.match(layers.source, /id="join-shared-annotation-layer"/);
    assert.doesNotMatch(layers.source, /id="open-annotations"/);
    assert.doesNotMatch(MARKUP, /id="create-annotation-layer"/);
    assert.match(layers.source, /id="import-annotation-geojson"/);
    assert.ok(annotations.start > inspection.start && annotations.end < inspection.end);
    for (const id of ["annotation-save-status", "annotation-panel-content"]) {
        assert.match(annotations.source, new RegExp(`id="${id}"`));
        assert.doesNotMatch(layers.source, new RegExp(`id="${id}"`));
    }
    assert.match(annotations.source, /<details class="annotation-help"><summary>Help<\/summary>/);
    assert.doesNotMatch(MARKUP, /id="annotation-tools"/);
});
