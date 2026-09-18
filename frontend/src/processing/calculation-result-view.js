/** Processing-owned immutable saved-job presentation and precise scalar formatting. */
import { performanceDescription } from "./calculation-performance.js";
import { processingDownloadUrl } from "./api.js";
import { describeClipArea, describeJobProgress } from "./presentation.js";

/** Preserve integer precision; raw decimal text remains inspectable. @param {Object} row Typed result. @return {string} Display value. */
export function calculationValue(row) {
    if (row.value === null) return "—";
    if (row.valueType === "integer") return BigInt(row.value).toLocaleString();
    const value = Number(row.value);
    return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumSignificantDigits: 10 }) : row.value;
}

/** Describe the server-reviewed ground-area method. @param {Object} method Area metadata. @return {string} Review/result explanation. */
function describeGroundArea(method) {
    return `Ground area: ${method.ellipsoid} ellipsoid, hectares, including partial pixels. Equal-area boundary intersections; ${method.edgeToleranceMetres} m chord-deviation target, at most ${method.maximumSegmentMetres.toLocaleString()} m per segment. Geometry estimate: up to ${method.estimatedGeometryCells.toLocaleString()} polygon cells${method.strategy === "rectilinear" ? "; row/column area optimization" : ""}.`;
}

/**
 * Render a saved snapshot without binding an editor or changing its current cards.
 * @param {HTMLElement} root Saved-result container in the current summary markup.
 * @param {Object} job Validated owned Processing job, including progress or typed result rows.
 * @param {Object[]} sources Current Catalog identities/labels, used only for display fallback.
 * @return {void}
 * @throws {TypeError} If an artifact URL violates the owned download contract.
 */
export function renderSavedCalculation(root, job, sources) {
    /** Make safe text content in the container's document. @param {string} tag HTML tag. @param {string} [text=""] Text. @return {HTMLElement} Node. */
    const element = (tag, text = "") => { const node = root.ownerDocument.createElement(tag); node.textContent = text; return node; };
    const source = Object.values(job.sources ?? {})[0];
    const label = sources.find(item => item.itemId === source?.itemId && item.collectionId === source?.collectionId)?.label ?? source?.itemId ?? "Raster";
    root.replaceChildren(element("h3", "Previous / saved result"),
        element("p", `${label} · ${describeClipArea(job.area)}`));
    if (job.status !== "ready" || !job.result) { root.append(element("p", job.error?.detail ?? describeJobProgress(job))); return; }
    if (job.result.cacheHit) root.append(element("p", "Reused cached result"));
    const states = { no_matches: "No cells matched the condition.", no_valid_data: "No valid cells in this area.",
        invalid_arithmetic: "Undefined arithmetic; no numeric result.", overflow: "Numeric overflow; no finite result." };
    for (const row of job.result.rows) {
        const card = element("article"); card.className = "calculation-result-row";
        const value = element("strong", `${calculationValue(row)}${row.unit ? ` ${row.unit}` : ""}`); value.title = row.value ?? row.state;
        card.append(element("h4", row.label), value, element("code", row.expression));
        if (states[row.state]) card.append(element("p", states[row.state]));
        const coverage = element("details"); coverage.append(element("summary", "Cell coverage & exact value"));
        coverage.append(element("p", `Exact value: ${row.value ?? "undefined"}. ${row.unit ? `Result unit: ${row.unit}.` : `Source unit: ${job.grid?.storedUnit || "unspecified"}. Expressions may change units.`}`));
        for (const aggregate of row.aggregates) coverage.append(element("p",
            `${aggregate.function}: ${aggregate.matchedPixels.toLocaleString()} matched / ${aggregate.validPixels.toLocaleString()} valid cells; ${aggregate.invalidArithmeticPixels.toLocaleString()} excluded by arithmetic.`));
        card.append(coverage); root.append(card);
    }
    if (job.grid?.groundArea) {
        const method = element("details");
        method.append(element("summary", "Area measurement"), element("p", describeGroundArea(job.grid.groundArea)),
            element("p", "Area coverage counts include any positive pixel intersection; numeric functions use pixel centers. Each areaha term is in hectares. Arithmetic can change final units."));
        root.append(method);
    }
    const performance = element("details");
    performance.append(element("summary", "Performance"), ...performanceDescription(job).map(text => element("p", text)));
    root.append(performance);
    const links = element("div"); links.className = "downloads-actions";
    for (const [kind, label, url] of [["result", "Download CSV", job.result.url], ["provenance", "Download provenance", job.result.provenanceUrl]]) {
        const link = element("a", label); link.className = "secondary-button";
        link.href = processingDownloadUrl(url, job.jobId, kind); link.setAttribute("download", ""); links.append(link);
    }
    root.append(links);
}
