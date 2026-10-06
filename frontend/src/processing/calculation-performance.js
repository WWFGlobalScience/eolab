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

/** Explain browser result delivery, retaining shared activity as shared evidence.
 * @param {Object|undefined} delivery Executor timestamps and bounded diagnostic snapshot.
 * @return {string[]} Request details and handoff timings; absent for historical results.
 */
function deliveryDescription(delivery) {
    if (!delivery) return [];
    const seconds = n => `${n.toFixed(3)} s`;
    const lines = [`Calculation trace: ${delivery.planId ? `plan ${delivery.planId}; ` : ""}job ${delivery.jobId ?? "unavailable"}.`,
        `Submission attempts: ${delivery.submissionAttempts ?? 1}; capacity backoff: ${seconds(delivery.capacityWaitSeconds ?? 0)} (included in Submission round trip).`];
    if (Number.isFinite(delivery.cleanupFinishedAtMs)) lines.push(
        `Plan cleanup request: ${seconds((delivery.cleanupFinishedAtMs - delivery.cleanupStartedAtMs) / 1000)}. The executor awaits this request before continuing; it can overlap server execution and status refreshes.`);
    if (Number.isFinite(delivery.executorReadyAtMs) && Number.isFinite(delivery.controllerReceivedAtMs)) lines.push(
        `Executor ready → result consumer: ${seconds(Math.max(0, delivery.controllerReceivedAtMs - delivery.executorReadyAtMs) / 1000)}.`);
    const snapshot = delivery.deliveryDiagnostics;
    if (!snapshot) return lines;
    const events = snapshot.events;
    const ofKind = kind => events.filter(event => event.kind === kind);
    const received = ofKind("ready-received").find(event => event.jobId === delivery.jobId);
    const accepted = ofKind("ready-accepted").find(event => event.jobId === delivery.jobId);
    if (received) lines.push(`Ready job first received at +${seconds(received.afterSubmissionSeconds)} from ${received.trigger}${received.refreshNumber ? ` refresh #${received.refreshNumber}` : ""}.`);
    if (received && accepted) lines.push(`Ready response received → accepted by observer: ${seconds(Math.max(0, accepted.atMs - received.atMs) / 1000)}. An update for this job may be skipped if a newer local action arrived during the read.`);
    if (received && Number.isFinite(delivery.executorReadyAtMs)) lines.push(`Ready response received → executor ready: ${seconds(Math.max(0, delivery.executorReadyAtMs - received.atMs) / 1000)} (includes observer acceptance and any remaining cleanup).`);
    const refreshes = ofKind("refresh-start");
    lines.push(`Shared job observer: ${refreshes.length} refreshes (${refreshes.filter(e => e.trigger === "sse").length} SSE, ${refreshes.filter(e => e.trigger === "sse-follow-up").length} SSE follow-up, ${refreshes.filter(e => e.trigger === "timer").length} timer, ${refreshes.filter(e => e.trigger === "explicit").length} explicit); ${ofKind("refresh-coalesced").length} triggers joined an in-flight refresh; ${ofKind("refresh-discarded").length} responses discarded; ${ofKind("refresh-error").length} refresh failures.`,
        `Updates skipped for this job to preserve newer local changes: ${ofKind("job-update-skipped").length}. Unrelated job updates are still accepted.`,
        "Active jobs are refreshed together by requested ID, in batches of up to 100. Idle refreshes recover recent history.");
    const finishes = ofKind("refresh-finish");
    const coalescedWaits = ofKind("refresh-coalesced").flatMap(event => {
        const finish = finishes.find(item => item.refreshNumber === event.refreshNumber);
        return finish ? [(finish.atMs - event.atMs) / 1000] : [];
    });
    lines.push(`Longest shared refresh: ${finishes.length ? seconds(Math.max(...finishes.map(e => e.seconds))) : "not observed"}; longest trigger wait behind a completed in-flight refresh: ${coalescedWaits.length ? seconds(Math.max(...coalescedWaits)) : "not observed"}.`);
    const starts = ofKind("http-start");
    lines.push(`Processing HTTP activity in this tab: ${starts.length} requests started; up to ${Math.max(0, ...events.filter(e => e.kind.startsWith("http-")).map(e => e.inFlight))} concurrently in flight. Includes other calculations; excludes tiles and non-Processing APIs.`);
    const timers = ofKind("fallback-timer");
    lines.push(`Shared SSE connection: ${ofKind("sse-open").length} open/reopen events, ${ofKind("sse-error").length} errors, ${ofKind("sse-close").length} closes, ${ofKind("sse-hint").length} hints during this interval. Zero open events can mean the connection was already open.`,
        `Browser visibility at measured events: ${events.some(e => e.hidden) ? "hidden at least once" : "visible"}. Maximum fallback timer lateness: ${timers.length ? seconds(Math.max(...timers.map(e => e.lateSeconds))) : "not observed"}. Visibility between events is not sampled.`);
    const serverHints = ofKind("sse-server-timing");
    if (serverHints.length) lines.push(`Shared server notification timing: maximum listener receipt → SSE handoff ${seconds(Math.max(...serverHints.map(e => e.listenerToStreamSeconds)))}; maximum reported previous ASGI send ${seconds(Math.max(...serverHints.map(e => e.previousSendSeconds)))}. These are shared, coalesced hints, not timings for this job alone.`);
    lines.push("Database commit → notification receipt is not measured. ASGI handoff does not measure proxy transfer or browser receipt. Durations below overlap; do not add them to total wait.");
    const relevant = events.filter(event => event.kind === "http-finish" &&
        (event.shared || (delivery.planId && event.planId === delivery.planId) || event.jobId === delivery.jobId));
    if (snapshot.partial) lines.push("Trace is partial: the bounded event buffer dropped older activity. Counts below and above cover retained events only.");
    for (const event of relevant.slice(-24)) {
        const server = Object.entries(event.serverTiming).map(([name, value]) => `${name} ${seconds(value)}`).join(", ");
        lines.push(`HTTP #${event.requestNumber} ${event.method} ${event.path} completed at +${seconds(event.afterSubmissionSeconds)}: ${event.status ?? "transport error"}, ${seconds(event.seconds)} total; headers ${event.headersSeconds == null ? "unavailable" : seconds(event.headersSeconds)}, body/JSON ${event.bodySeconds == null ? "unavailable" : seconds(event.bodySeconds)}${server ? `; server: ${server}` : "; server timing unavailable"}.`);
        if (event.requestId) lines.push(`Request trace: ${event.requestId} (matches processing_http in the application log).`);
        const network = event.networkTiming;
        if (network) lines.push(
            `Browser network (${network.protocol}): before request ${seconds(network.beforeRequestSeconds)}; request → first byte ${seconds(network.firstByteSeconds)}; download ${seconds(network.downloadSeconds)}; download finished → JSON received ${seconds(network.afterDownloadSeconds)}. Response bytes: ${network.encodedBytes} encoded, ${network.decodedBytes} decoded.`,
            `Connection detail (overlaps before request): DNS ${seconds(network.dnsSeconds)}; connection ${seconds(network.connectSeconds)}; TLS ${seconds(network.tlsSeconds)} (included in connection). Reused connections may report zero.`,
        );
        else lines.push("Exact browser network timing unavailable for this response; no timing from another request was substituted.");
    }
    if (relevant.length > 24) lines.push(`Showing the last 24 of ${relevant.length} relevant HTTP completions.`);
    lines.push("Server processing includes route handling and serialization; admissionChecks includes source/area validation; queueAdmission includes database admission, commit and thread scheduling; submissionObservation includes waiting for committed job states; jobRead includes database access and thread scheduling, including reads during submission observation. These server stages overlap HTTP durations. Any remaining time is unaccounted for, not identified as network latency.");
    lines.push("appToHeaders measures application entry → response headers; beforeRoute and afterRoute surround the existing route timer. eventLoopLag is maximum observed 50-ms timer lateness during this request, not an additive stage. Final send durations are logged after delivery and cannot appear in these response headers. Application entry excludes socket/proxy waiting; ASGI send completion is transport handoff, not browser receipt. Browser before-request includes connection setup and scheduling; first-byte time includes server work and proxy/network transit. Download-to-JSON includes parsing and browser scheduling. Proxy-internal waiting is not measured here.");
    return lines;
}

/** Describe final timings with precise measurement boundaries.
 * @param {Object} job Completed job.
 * @param {number|undefined} totalWaitSeconds Browser-measured wait, if observed.
 * @param {Object|undefined} stages Browser-local durations and optional planningObservation
 * counters identifying SSE-triggered and timer-triggered planning status reads.
 * @param {string} [waitDescription] Explanation of the caller's timer boundaries;
 * defaults to the summary panel's request-through-display interval.
 * @return {string[]} Lines.
 */
export function performanceDescription(job, totalWaitSeconds, stages, waitDescription =
    "Measured in this tab from the calculation request through the result UI update, including vector selection when requested here, debounce, planning, queueing and result delivery (notifications or polling); excludes earlier confirmation time and the browser's subsequent paint.") {
    const p = job.result?.performance;
    const lines = [...(Number.isFinite(totalWaitSeconds) && totalWaitSeconds >= 0
        ? [`Total measured wait: ${totalWaitSeconds.toFixed(3)} s.`, waitDescription]
        : ["Total wait unavailable for this result. A complete request-to-display interval was not recorded in this tab."]),
    ...(job.result?.cacheHit ? ["Reused cached result; no raster pixels were read or calculated for this job."] : executionDescription(job.grid))];
    const seconds = n => `${n.toFixed(3)} s`;
    if (stages) {
        if (Number.isFinite(stages.planningSeconds)) lines.push(
            `Before planning: ${seconds(stages.beforePlanningSeconds)}.`,
            `Planning round trip: ${seconds(stages.planningSeconds)}${stages.planReused ? " (existing plan reused)" : ""}.`,
            `Between planning and submission: ${seconds(stages.beforeSubmissionSeconds)}.`,
        );
        else lines.push(`Before submission: ${seconds(stages.beforeSubmissionSeconds)}.`);
        lines.push(
            `Submission round trip: ${seconds(stages.submissionSeconds)}.`,
            `Submission response → result observed: ${seconds(stages.afterSubmissionSeconds)}.`,
            "These browser stages add up to total wait. Server stages below overlap them; do not add the two groups together.",
        );
        if (Number.isFinite(stages.vectorSelectionSeconds)) lines.push(
            `Vector selection before calculation: ${seconds(stages.vectorSelectionSeconds)} (included before submission). Includes the selection request/response and source preparation; excludes optional display-outline work.`,
        );
        const plan = stages.serverPlan;
        const observation = stages.planningObservation;
        if (observation && !stages.planReused) {
            const trigger = {submission: "the submission response", recovery: "the admission-recovery status read",
                sse: "an SSE-triggered status read", timer: "a two-second fallback status read"}[observation.readyResponse];
            lines.push(
                `Planning notifications: ${observation.sseHints} SSE hints received; ${observation.sseRefreshes} SSE-triggered status reads; ${observation.timerRefreshes} two-second fallback status reads.`,
                `Plan ready was first observed in ${trigger}.`,
                "These counts cover the successful planning attempt. SSE hints are shared across your plans and jobs and include the initial connection hint; receiving one does not prove this plan changed. These counts do not measure calculation-result delivery after submission.",
            );
        }
        if (plan && !stages.planReused) lines.push(
            `Inside server planning - admission: ${seconds(plan.reservationSeconds)}; source/selection preparation: ${seconds(plan.preparationSeconds)}; native process (including startup and transfer): ${seconds(plan.nativeProcessSeconds)}; selection recheck and plan storage: ${seconds(plan.finalizationSeconds)}.`,
            ...processDescription("Planning", plan.process),
            ...(plan.queueSeconds == null ? [] : [`Waiting for the native planner: ${seconds(plan.queueSeconds)} (included in Planning round trip).`]),
        );
    }
    const execution = job.result?.executionTiming;
    const serverElapsed = job.result?.queuedToReadySeconds;
    if (Number.isFinite(serverElapsed)) lines.push(`Server queued → ready: ${seconds(serverElapsed)} (database timestamps).`);
    if (execution) {
        lines.push(
            `Queue wait: ${seconds(execution.queueSeconds)}.`,
            `Worker preparation (calculation planning, source authorization and scratch): ${seconds(execution.preparationSeconds)}.`,
            `Native process including startup, execution and result transfer: ${seconds(execution.nativeProcessSeconds)}.`,
            `Selection recheck and file publication: ${seconds(execution.publicationSeconds)}.`,
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
    if (job.preparation) lines.push(
        `Calculation preparation: ${seconds(job.preparation.seconds)}${execution ? " (included in Worker preparation)" : ""}.${job.preparation.cacheHit ? " Reused cached preparation and result." : ""}`,
        ...processDescription("Preparation", job.preparation.process),
    );
    if (stages && Number.isFinite(serverElapsed)) {
        const residual = stages.submissionSeconds + stages.afterSubmissionSeconds - serverElapsed;
        if (residual >= 0) lines.push(`Submission admission + result delivery (estimated remainder): ${seconds(residual)}. Includes request handling before queue insertion, completion/response transfer and notification delivery or fallback polling; not a measurement of network time alone.`);
    }
    lines.push("Server intervals use one database clock or a worker's monotonic clock. Browser intervals use this tab's monotonic clock. Small residual differences can include database transaction timestamp boundaries. Timings are diagnostic and do not change scheduling.");
    lines.push(...deliveryDescription(stages?.delivery));
    if (job.result?.cacheHit) return lines;
    if (!p) return [...lines, "Kernel measurements are unavailable for this saved result."];
    if (p.stages) {
        const k = p.stages;
        const setup = k.sourceSetupSeconds + k.selectionSetupSeconds + k.groundAreaSetupSeconds + k.gridCheckSeconds + (k.maskPreparationSeconds ?? 0);
        const preparation = Math.max(0, p.calculationSeconds - k.selectionMaskSeconds - k.areaWeightsSeconds - k.reductionSeconds);
        const other = Math.max(0, p.kernelSeconds - setup - p.readSeconds - p.calculationSeconds - p.resultWriteSeconds);
        lines.push(
            `Kernel setup: ${seconds(setup)}. Source opening, checks and expression compilation: ${seconds(k.sourceSetupSeconds)}; selection envelope reading/projection: ${seconds(k.selectionSetupSeconds)}; ground-area setup: ${seconds(k.groundAreaSetupSeconds)}; historical grid/admission recheck: ${seconds(k.gridCheckSeconds)}.`,
            `Inside Calculation - polygon selection masks: ${seconds(k.selectionMaskSeconds)}; ground-area weights: ${seconds(k.areaWeightsSeconds)}; formula evaluation and reductions: ${seconds(k.reductionSeconds)}; tile preparation and loop overhead (remainder): ${seconds(preparation)}.`,
            `Other kernel work (remainder): ${seconds(other)}. Includes progress writes, source closing and loop setup.`,
            k.maskPreparationSeconds != null
                ? "The temporary polygon mask is rasterized once during setup. Calculation reads its windows and applies them. Source read/decode includes the raster's own validity mask and I/O waiting."
                : "Polygon mask time includes vector reads, geometry projection and rasterization, plus applying the mask. Read/decode includes the raster's own validity mask and I/O waiting; it is not a pure disk-time measurement.",
            "Setup + Read/decode + Calculation + Write CSV + Other kernel work partition Kernel elapsed. Calculation's inner stages are already included in Calculation; do not add them again.",
        );
        if (k.maskPreparationSeconds != null) lines.push(
            `Temporary polygon mask preparation: ${seconds(k.maskPreparationSeconds)} (included in Kernel setup). Mask window reads: ${seconds(k.maskReadSeconds ?? 0)} (included in polygon selection masks).`,
        );
        const mask = k.selectionMaskBreakdown;
        if (mask) {
            const overhead = Math.max(0, k.selectionMaskSeconds - mask.featureReadingSeconds
                - mask.projectionSeconds - mask.rasterizationSeconds);
            lines.push(
                `Inside polygon selection masks - feature reading: ${seconds(mask.featureReadingSeconds)}; projection: ${seconds(mask.projectionSeconds)}; rasterization: ${seconds(mask.rasterizationSeconds)}; mask allocation, union, application and overhead (remainder): ${seconds(overhead)}.`,
                "Feature reading includes tile bounds lookup, opening, filtering, validation and closing vector sources, including I/O waits. These mask stages are already included in polygon selection masks; do not add them again.",
            );
        } else if (k.maskPreparationSeconds == null) lines.push("The mask-stage breakdown was not recorded for this saved result.");
    } else lines.push("Detailed kernel stages were not recorded for this saved result.");
    return [...lines,
        `Kernel elapsed: ${seconds(p.kernelSeconds)}. Read/decode and source mask: ${seconds(p.readSeconds)}. Calculation: ${seconds(p.calculationSeconds)}. Write CSV and checksum: ${seconds(p.resultWriteSeconds)}.`,
        `${p.readWindows.toLocaleString()} reads; ${p.evaluationTiles.toLocaleString()} calculation tiles; ${p.reducerUpdates.toLocaleString()} statistic updates.`,
        "Wall times include waiting within each operation. Calculation includes tile preparation, selection masks, area weights and reductions. Kernel elapsed also includes source opening and geometry setup; it ends after the CSV checksum. Queueing, worker startup, provenance writing, publication and browser latency are excluded.",
    ];
}
