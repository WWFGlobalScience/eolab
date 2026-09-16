/** Presentation-only axis ranges for 1D histograms and 2D marginal distributions. */

/**
 * @typedef {{scale:"linear"|"log", bounds:"auto"|"values"|"percentiles",
 * minimum:string, maximum:string}} HistogramAxisOptions
 */

/** Return independent editable axis defaults. @return {HistogramAxisOptions} */
export function defaultHistogramAxisOptions() {
    return { scale: "linear", bounds: "auto", minimum: "", maximum: "" };
}

/**
 * Estimate the raster value at a requested percentile of sampled pixels.
 * Use bin counts to find the containing bin, then estimate the value assuming
 * pixels are evenly distributed within that bin. P0 and P100 use the outer
 * edges of the first and last occupied bins; empty bins carry no weight.
 * @param {number[]} edges Ascending raster-value bin boundaries.
 * @param {number[]} counts Sampled pixel count for each bin.
 * @param {number} percentile Requested percentile from 0 to 100.
 * @return {number} Estimated percentile in the raster's value units.
 */
function estimateRasterValuePercentile(edges, counts, percentile) {
    const target = counts.reduce((sum, count) => sum + count, 0) * percentile / 100;
    let accumulated = 0;
    for (let i = 0; i < counts.length; i++) {
        if (counts[i] > 0 && accumulated + counts[i] >= target) {
            return edges[i] + (edges[i + 1] - edges[i]) * (target - accumulated) / counts[i];
        }
        accumulated += counts[i];
    }
    return edges.at(-1);
}

/**
 * Calculate a percentile of non-empty histogram bar heights.
 * P0 is the smallest height and P100 is the largest. Between them, use the
 * zero-based position (sortedHeights.length - 1) * percentile / 100 and
 * interpolate between the two neighboring heights when the position is fractional.
 * For example, heights [2, 6] have P25 = 3 and P50 = 4.
 * @param {number[]} sortedHeights Nonempty ascending bar heights, each expressed
 * as a percentage of sampled pixels. Zero-height bins have already been removed.
 * @param {number} percentile Requested percentile from 0 to 100.
 * @return {number} Bar height in percentage-of-sampled-pixels units.
 */
function calculateBarHeightPercentile(sortedHeights, percentile) {
    const position = (sortedHeights.length - 1) * percentile / 100;
    const lower = Math.floor(position), upper = Math.ceil(position);
    return sortedHeights[lower] + (sortedHeights[upper] - sortedHeights[lower]) * (position - lower);
}

/**
 * Resolve one histogram axis without changing bins, counts or normalization.
 * Log value axes omit entire bins whose lower edge is nonpositive, including
 * bins crossing zero: their within-bin positive counts are unknown.
 *
 * @param {{edges:number[],counts:number[],total:number,frequency?:boolean,
 * nice?:boolean}} distribution Validated histogram or marginal; frequency axes
 * use percentages of total and ignore empty bars when resolving percentiles.
 * @param {HistogramAxisOptions} options User display settings.
 * @return {{minimum:number,maximum:number,scale:string,offset:number,
 * position:(value:number)=>number,valueAt:(fraction:number)=>number,
 * interval:(lower:number,upper:number)=>number[]|null,
 * notice:string}} Resolved transform and display limitations.
 * @throws {RangeError} If settings or the positive domain cannot form an axis.
 */
export function resolveHistogramAxis(distribution, options = defaultHistogramAxisOptions()) {
    const { edges, counts, total, frequency = false, nice = false } = distribution;
    const positiveHeights = counts.filter(count => count > 0).map(count => count / total * 100).sort((a, b) => a - b);
    if (!(total > 0) || positiveHeights.length === 0) throw new RangeError("No sampled pixels to display.");
    if (!["linear", "log"].includes(options.scale) ||
        !["auto", "values", "percentiles"].includes(options.bounds)) {
        throw new RangeError("Choose a supported scale and range mode.");
    }
    const log = options.scale === "log";
    let minimum = frequency ? 0 : edges[0];
    let maximum = frequency ? positiveHeights.at(-1) : edges.at(-1);
    if (frequency && nice) {
        const power = 10 ** Math.floor(Math.log10(maximum));
        maximum = Math.min(100, [1, 2, 5, 10].find(factor => factor * power >= maximum) * power);
    }
    let omitted = 0;
    if (log && !frequency) {
        const first = edges.slice(0, -1).findIndex(edge => edge > 0);
        if (first < 0 || !counts.some((count, index) => index >= first && count > 0)) {
            throw new RangeError("Log needs a populated bin with positive edges. Use Linear.");
        }
        minimum = edges[first];
        omitted = counts.slice(0, first).reduce((sum, count) => sum + count, 0);
    } else if (log) {
        minimum = positiveHeights[0] / 10;
    }
    if (options.bounds !== "auto") {
        if (options.minimum.trim() === "" || options.maximum.trim() === "") {
            throw new RangeError("Enter both a minimum and a maximum.");
        }
        const lower = Number(options.minimum), upper = Number(options.maximum);
        if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
            throw new RangeError("Minimum must be a finite number below maximum.");
        }
        if (options.bounds === "percentiles") {
            if (lower < 0 || upper > 100) throw new RangeError("Percentiles must be between 0 and 100.");
            minimum = frequency ? calculateBarHeightPercentile(positiveHeights, lower) : estimateRasterValuePercentile(edges, counts, lower);
            maximum = frequency ? calculateBarHeightPercentile(positiveHeights, upper) : estimateRasterValuePercentile(edges, counts, upper);
        } else {
            minimum = lower;
            maximum = upper;
        }
    }
    if (frequency && (minimum < 0 || maximum > 100)) {
        throw new RangeError("Bar-height limits must be between 0 and 100% of sampled pixels.");
    }
    if (!(minimum < maximum)) {
        throw new RangeError("These percentiles resolve to the same value. Choose Values or Auto.");
    }
    if (log && minimum <= 0) throw new RangeError("Log requires a positive minimum. Choose Auto or positive limits.");
    const transform = log ? Math.log10 : value => value;
    const lower = transform(minimum), span = transform(maximum) - lower;
    if (!Number.isFinite(span) || !(span > 0)) throw new RangeError("Axis range is too small or too large.");
    const position = value => log && value <= 0 ? -Infinity : (transform(value) - lower) / span;
    const valueAt = fraction => log ? 10 ** (lower + fraction * span) : minimum + fraction * span;
    const interval = (start, end) => {
        if ((log && start <= 0) || end <= minimum || start >= maximum) return null;
        return [Math.max(0, position(start)), Math.min(1, position(end))];
    };
    const clipped = frequency
        ? positiveHeights.some(height => height < minimum || height > maximum)
        : edges[0] < minimum || edges.at(-1) > maximum;
    const notice = [
        log ? frequency ? "Log: zero-height bars are not drawn." :
            `Log omits bins with nonpositive edges (${omitted.toLocaleString()} sampled pixels); crossing-zero bins are omitted whole.` : "",
        clipped ? "Display is clipped to these limits; original counts and percentages are unchanged." : "",
    ].filter(Boolean).join(" ");
    const offset = !log && Math.max(Math.abs(minimum), Math.abs(maximum)) / (maximum - minimum) > 1e5 ? minimum : 0;
    return { minimum, maximum, scale: options.scale, offset, position, valueAt, interval, notice };
}
