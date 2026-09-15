/** Presentation of reviewed native execution sizes and durable wall-time metrics. */
import { formatDownloadBytes } from "./presentation.js";

/** Explain the nested cost of one warm-process invocation.
 * @param {string} label Planning or calculation. @param {Object|undefined} timing Process details.
 * @return {string[]} Lines, absent for older results.
 */
function processDescription(label, timing) {
    if (!timing) return [];
    const seconds = n => `${n.toFixed(3)} s`;
    return [`${label} process: ${timing.reusedProcess ? "reused" : "first operation in this process"}. Readiness wait (including any startup): ${seconds(timing.readyWaitSeconds)}; operation: ${seconds(timing.operationSeconds)}; request/reply, cleanup and recycling: ${seconds(timing.overheadSeconds)}. These split the native-process duration. Prewarming completed before this request is excluded.`];
}

/** Describe the effective execution plan. @param {Object} grid Reviewed grid. @return {string[]} Lines. */
export function executionDescription(grid) {
    const p = grid?.execution;
    if (!p) return [];
    return [
        `Target: ${p.targetChunkPixels == null ? "current behavior" : `${p.targetChunkPixels.toLocaleString()} pixels per batch`}.`,
        `Up to ${p.readWidth.toLocaleString()} × ${p.readHeight.toLocaleString()} pixels per read; ${p.evaluationWidth.toLocaleString()} × ${p.evaluationHeight.toLocaleString()} per calculation tile. Edge tiles may be smaller.`,
        `${grid.nativeBlocks.toLocaleString()} native blocks in ${p.readWindows.toLocaleString()} reads; ${formatDownloadBytes(grid.estimatedMemoryBytes)} estimated working memory.`,
        ...(grid.groundArea?.strategy === "cell_polygons" ? ["This grid requires individual pixel geometry, so calculation tiles stay small."] : []),
    ];
}

/** Describe final timings with precise measurement boundaries.
 * @param {Object} job Completed job.
 * @param {number|undefined} totalWaitSeconds Browser request through result DOM update, if observed.
 * @param {Object|undefined} stages Browser-local stage durations for this request.
 * @return {string[]} Lines.
 */
export function performanceDescription(job, totalWaitSeconds, stages) {
    const p = job.result?.performance;
    const lines = [...(Number.isFinite(totalWaitSeconds) && totalWaitSeconds >= 0
        ? [`Total wait → result displayed: ${totalWaitSeconds.toFixed(3)} s.`,
            "Measured in this tab from the calculation request through the result UI update, including vector selection when requested here, debounce, planning, queueing and result delivery (notifications or polling); excludes earlier confirmation time and the browser's subsequent paint."]
        : ["Total wait unavailable for this result. Request-to-display timing is recorded only for statistic cards completed in this tab, without a page reload."]),
    ...executionDescription(job.grid)];
    const seconds = n => `${n.toFixed(3)} s`;
    if (stages) {
        lines.push(
            `Before planning (selection, debounce, validation or previous-work wait): ${seconds(stages.beforePlanningSeconds)}.`,
            `Planning round trip: ${seconds(stages.planningSeconds)}${stages.planReused ? " (existing plan reused)" : ""}.`,
            `Between planning and submission: ${seconds(stages.beforeSubmissionSeconds)}.`,
            `Submission round trip: ${seconds(stages.submissionSeconds)}.`,
            `Submission response → result displayed: ${seconds(stages.afterSubmissionSeconds)}.`,
            "These browser stages add up to total wait. Server stages below overlap them; do not add the two groups together.",
        );
        if (Number.isFinite(stages.vectorSelectionSeconds)) lines.push(
            `Vector selection before calculation: ${seconds(stages.vectorSelectionSeconds)} (included in Before planning). Includes the selection request/response and source preparation; excludes optional display-outline work.`,
        );
        const plan = stages.serverPlan;
        if (plan && !stages.planReused) lines.push(
            `Inside server planning — admission: ${seconds(plan.reservationSeconds)}; source/selection preparation: ${seconds(plan.preparationSeconds)}; native process (including startup and transfer): ${seconds(plan.nativeProcessSeconds)}; source recheck and plan storage: ${seconds(plan.finalizationSeconds)}.`,
            ...processDescription("Planning", plan.process),
        );
    }
    const execution = job.result?.executionTiming;
    const serverElapsed = job.result?.queuedToReadySeconds;
    if (Number.isFinite(serverElapsed)) lines.push(`Server queued → ready: ${seconds(serverElapsed)} (database timestamps).`);
    if (execution) {
        lines.push(
            `Queue wait: ${seconds(execution.queueSeconds)}.`,
            `Worker preparation (source authorization and scratch): ${seconds(execution.preparationSeconds)}.`,
            `Native process including startup, execution and result transfer: ${seconds(execution.nativeProcessSeconds)}.`,
            `Source recheck and file publication: ${seconds(execution.publicationSeconds)}.`,
            ...processDescription("Calculation", execution.process),
        );
        if (p && execution.nativeProcessSeconds >= p.kernelSeconds) lines.push(
            `Native process outside the kernel: ${seconds(execution.nativeProcessSeconds - p.kernelSeconds)} (includes startup, IPC, final provenance/checks and process exit; not startup alone).`,
        );
        if (Number.isFinite(serverElapsed)) {
            const other = serverElapsed - execution.queueSeconds - execution.preparationSeconds - execution.nativeProcessSeconds - execution.publicationSeconds;
            if (other >= 0) lines.push(`Other server scheduling/completion time (estimated remainder): ${seconds(other)}.`);
        }
    }
    if (stages && Number.isFinite(serverElapsed)) {
        const residual = stages.submissionSeconds + stages.afterSubmissionSeconds - serverElapsed;
        if (residual >= 0) lines.push(`Submission admission + result delivery (estimated remainder): ${seconds(residual)}. Includes request handling before queue insertion, completion/response transfer and notification delivery or fallback polling; not a measurement of network time alone.`);
    }
    lines.push("Server intervals use one database clock or a worker's monotonic clock. Browser intervals use this tab's monotonic clock. Small residual differences can include database transaction timestamp boundaries. Timings are diagnostic and do not change scheduling.");
    if (!p) return [...lines, "Kernel measurements are unavailable for this saved result."];
    if (p.stages) {
        const k = p.stages;
        const setup = k.sourceSetupSeconds + k.selectionSetupSeconds + k.groundAreaSetupSeconds + k.gridCheckSeconds;
        const preparation = Math.max(0, p.calculationSeconds - k.selectionMaskSeconds - k.areaWeightsSeconds - k.reductionSeconds);
        const other = Math.max(0, p.kernelSeconds - setup - p.readSeconds - p.calculationSeconds - p.resultWriteSeconds);
        lines.push(
            `Kernel setup: ${seconds(setup)}. Source opening, checks and expression compilation: ${seconds(k.sourceSetupSeconds)}; selection envelope reading/projection: ${seconds(k.selectionSetupSeconds)}; ground-area setup: ${seconds(k.groundAreaSetupSeconds)}; grid/admission recheck: ${seconds(k.gridCheckSeconds)}.`,
            `Inside Calculation - polygon selection masks: ${seconds(k.selectionMaskSeconds)}; ground-area weights: ${seconds(k.areaWeightsSeconds)}; formula evaluation and reductions: ${seconds(k.reductionSeconds)}; tile preparation and loop overhead (remainder): ${seconds(preparation)}.`,
            `Other kernel work (remainder): ${seconds(other)}. Includes progress writes, source closing/rechecks and loop setup.`,
            "Polygon mask time includes vector reads, geometry projection and rasterization, plus applying the mask. Read/decode includes the raster's own validity mask and I/O waiting; it is not a pure disk-time measurement.",
            "Setup + Read/decode + Calculation + Write CSV + Other kernel work partition Kernel elapsed. Calculation's inner stages are already included in Calculation; do not add them again.",
        );
        const mask = k.selectionMaskBreakdown;
        if (mask) {
            const overhead = Math.max(0, k.selectionMaskSeconds - mask.featureReadingSeconds
                - mask.projectionSeconds - mask.rasterizationSeconds);
            lines.push(
                `Inside polygon selection masks - feature reading: ${seconds(mask.featureReadingSeconds)}; projection: ${seconds(mask.projectionSeconds)}; rasterization: ${seconds(mask.rasterizationSeconds)}; mask allocation, union, application and overhead (remainder): ${seconds(overhead)}.`,
                "Feature reading includes tile bounds lookup, opening, filtering, validation and closing vector sources, including I/O waits. These mask stages are already included in polygon selection masks; do not add them again.",
            );
        } else lines.push("The mask-stage breakdown was not recorded for this saved result.");
    } else lines.push("Detailed kernel stages were not recorded for this saved result.");
    return [...lines,
        `Kernel elapsed: ${seconds(p.kernelSeconds)}. Read/decode and source mask: ${seconds(p.readSeconds)}. Calculation: ${seconds(p.calculationSeconds)}. Write CSV and checksum: ${seconds(p.resultWriteSeconds)}.`,
        `${p.readWindows.toLocaleString()} reads; ${p.evaluationTiles.toLocaleString()} calculation tiles; ${p.reducerUpdates.toLocaleString()} statistic updates.`,
        "Wall times include waiting within each operation. Calculation includes tile preparation, selection masks, area weights and reductions. Kernel elapsed also includes source opening and geometry setup; it ends after the CSV checksum. Queueing, worker startup, provenance writing, publication and browser latency are excluded.",
    ];
}
