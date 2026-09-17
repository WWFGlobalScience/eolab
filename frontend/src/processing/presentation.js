/** Shared Processing job and native-grid presentation. */
/**
 * Summarize an explicit CRS label or root WKT name/authority for display.
 * This reads presentation metadata only; projection remains backend-owned.
 * @param {string} crs Native CRS definition. @return {string} Compact name.
 */
export function describeClipCrs(crs) {
    const name = crs.match(/^(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS|COMPD_CS)\["([^"]+)"/);
    if (!name) return crs;
    const authority = crs.match(/(?:AUTHORITY\["EPSG","(\d+)"\]|ID\["EPSG",(\d+)\])\]$/);
    return authority ? `${name[1]} (EPSG:${authority[1] ?? authority[2]})` : name[1];
}

/** Format file sizes without implying compression precision. @param {number} bytes Byte count. @return {string} Human-readable size. */
export function formatDownloadBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const unit = bytes < 1024 ** 2 ? "KiB" : bytes < 1024 ** 3 ? "MiB" : "GiB";
    const divisor = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[unit];
    return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

/** Describe a public plan/job area. @param {Object|null} area Bounds or polygon selection summary. @return {string} Explicit geographic description. */
export function describeClipArea(area) {
    if (!area) return "No sampling area selected. Choose a box or catalog vector.";
    if (area.kind === "wholeRaster") return "Whole raster";
    if (area.kind === "catalogSelection" && !Array.isArray(area.bounds)) return "Catalog vector selection; review will show its geographic bounds.";
    const values = area.selectedBounds
        ? [area.selectedBounds.west, area.selectedBounds.south, area.selectedBounds.east, area.selectedBounds.north]
        : area.bounds;
    const label = area.kind === "aoi" ? "Historical polygon selection" : area.kind === "catalogSelection" ? "Catalog vector selection" : "Box";
    return `${label} · W ${values[0].toFixed(4)}°, S ${values[1].toFixed(4)}°, E ${values[2].toFixed(4)}°, N ${values[3].toFixed(4)}°`;
}

/** Describe measured blocks or a named phase, without invented percentages. @param {Object} job Server job snapshot. @return {string} User-facing progress. */
export function describeJobProgress(job) {
    if (job.status !== "running") return ({ queued: "Queued", cancelling: "Cancelling…", ready: "Ready",
        failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted — review a new job to retry",
        expired: "Expired — run again to download", deleted: "Deleted" })[job.status] ?? job.status;
    const progress = job.progress;
    if (progress.phase === "calculating") return `Calculating · ${progress.completedBlocks ?? 0} of ${progress.totalBlocks ?? "?"} native source blocks`;
    if (progress.phase === "preparing_selected_polygons") return "Reading and projecting selected polygons…";
    if (progress.phase === "preparing_polygon_mask") return "Creating the polygon mask…";
    if (progress.phase === "writing_results") return "Writing results…";
    if (progress.phase === "clipping") return `Clipping · ${progress.completedBlocks ?? 0} of ${progress.totalBlocks ?? "?"} source blocks`;
    return ({ creating_cog: "Preparing download · creating COG", validating: "Preparing download · validating file",
        checksumming: "Preparing download · verifying checksum" })[progress.phase] ?? "Starting…";
}

