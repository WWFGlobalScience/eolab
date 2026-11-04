/** Neutral center/size sampling-box contracts and spherical geodesic geometry. */

/** Mean radius retained by the existing kilometer-based corner construction. */
export const SAMPLING_BOX_EARTH_RADIUS_KM = 6371.0088;
/** Largest integer side whose half-diagonal stays below a quarter circumference. */
export const MAXIMUM_SAMPLING_BOX_SIDE_KM = Math.floor(Math.PI * SAMPLING_BOX_EARTH_RADIUS_KM / Math.sqrt(2));
/** Boundary failure reason for the existing nonwrapping, nonpolar box contract. */
export const SAMPLING_BOX_BOUNDARY_ERROR = "Sampling box reaches a pole or crosses the date line";

/**
 * @typedef {Object} SamplingBox
 * @property {Readonly<{longitude:number,latitude:number}>} center Canonical WGS 84 center.
 * @property {number} sideLengthKm Approximate integer ground side length.
 */

/** A sampling box cannot cross a pole or the date line under its current contract. */
export class SamplingBoxBoundaryError extends RangeError {}

/**
 * Travel along a spherical geodesic from a degree-valued position.
 * @param {number} longitude Starting longitude in degrees.
 * @param {number} latitude Starting latitude in degrees.
 * @param {number} angularDistance Travel distance divided by the mean Earth radius.
 * @param {number} bearing Clockwise starting bearing from north in radians.
 * @return {[number,number]} Longitude/latitude, with longitude in [-180,180).
 */
function destination(longitude, latitude, angularDistance, bearing) {
    latitude *= Math.PI / 180;
    longitude *= Math.PI / 180;
    const destinationLatitude = Math.asin(Math.sin(latitude) * Math.cos(angularDistance) +
        Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing));
    const offset = Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
        Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(destinationLatitude));
    return [((longitude + offset) * 180 / Math.PI + 540) % 360 - 180,
        destinationLatitude * 180 / Math.PI];
}

/**
 * Return the established northwest, northeast, southeast and southwest corners.
 * @param {SamplingBox} box Descriptor whose field ranges have been validated.
 * @return {Array<[number,number]>} Four longitude/latitude positions on the mean-radius sphere.
 */
export function samplingBoxCorners(box) {
    const distance = box.sideLengthKm / Math.sqrt(2) / SAMPLING_BOX_EARTH_RADIUS_KM;
    return [315, 45, 135, 225].map(bearing => destination(box.center.longitude,
        box.center.latitude, distance, bearing * Math.PI / 180));
}

/**
 * Validate and freeze a captured center/size descriptor at its owning input boundary.
 * @param {Object} box Candidate path-free sampling-box descriptor.
 * @return {Readonly<SamplingBox>} Independent immutable center and integer size.
 * @throws {TypeError} For unexpected fields, invalid coordinates or noninteger/out-of-range size.
 * @throws {SamplingBoxBoundaryError} When its cap reaches a pole or corners cross the date line.
 */
export function normalizeSamplingBox(box) {
    if (!box || Object.keys(box).sort().join() !== "center,sideLengthKm" ||
        !box.center || Object.keys(box.center).sort().join() !== "latitude,longitude" ||
        !Number.isFinite(box.center.longitude) || Math.abs(box.center.longitude) > 180 ||
        !Number.isFinite(box.center.latitude) || Math.abs(box.center.latitude) > 90 ||
        !Number.isInteger(box.sideLengthKm) || box.sideLengthKm < 1 ||
        box.sideLengthKm > MAXIMUM_SAMPLING_BOX_SIDE_KM) {
        throw new TypeError("A sampling box needs a WGS 84 center and a supported integer kilometer size.");
    }
    const value = Object.freeze({
        center: Object.freeze({...box.center}),
        sideLengthKm: box.sideLengthKm
    });
    const distance = value.sideLengthKm / Math.sqrt(2) / SAMPLING_BOX_EARTH_RADIUS_KM;
    if (Math.abs(value.center.latitude * Math.PI / 180) + distance >= Math.PI / 2) {
        throw new SamplingBoxBoundaryError(SAMPLING_BOX_BOUNDARY_ERROR);
    }
    const longitudes = samplingBoxCorners(value).map(point => point[0]);
    if (Math.max(...longitudes) - Math.min(...longitudes) >= 180) {
        throw new SamplingBoxBoundaryError(SAMPLING_BOX_BOUNDARY_ERROR);
    }
    return value;
}

/**
 * Locate a fraction of the shorter great-circle arc between adjacent box corners.
 * @param {[number,number]} start Starting longitude/latitude from a validated box.
 * @param {[number,number]} end Adjacent non-antipodal corner.
 * @param {number} fraction Edge fraction from zero through one.
 * @return {[number,number]} Geographic position, preserving the exact endpoints at zero/one.
 */
export function interpolateGreatCircle(start, end, fraction) {
    if (fraction === 0) return start;
    if (fraction === 1) return end;
    const latitudeA = start[1] * Math.PI / 180;
    const latitudeB = end[1] * Math.PI / 180;
    const longitudeDelta = (end[0] - start[0]) * Math.PI / 180;
    const x = Math.sin(longitudeDelta) * Math.cos(latitudeB);
    const y = Math.cos(latitudeA) * Math.sin(latitudeB) -
        Math.sin(latitudeA) * Math.cos(latitudeB) * Math.cos(longitudeDelta);
    const dot = Math.sin(latitudeA) * Math.sin(latitudeB) +
        Math.cos(latitudeA) * Math.cos(latitudeB) * Math.cos(longitudeDelta);
    return destination(start[0], start[1], fraction * Math.atan2(Math.hypot(x, y), dot), Math.atan2(x, y));
}

/**
 * Return the complete nonwrapping envelope of the four geodesic edges.
 * Top/bottom latitude extrema occur at endpoints or midpoints; side-arc latitude
 * and every nonpolar shorter arc's longitude are monotonic under the box guard.
 * @param {SamplingBox} box Validated nonwrapping, nonpolar descriptor.
 * @return {{west:number,south:number,east:number,north:number}} Read-window envelope, never replacement membership geometry.
 */
export function samplingBoxBounds(box) {
    const corners = samplingBoxCorners(box);
    const positions = [...corners, ...corners.map((point, index) =>
        interpolateGreatCircle(point, corners[(index + 1) % 4], 0.5))];
    return {
        west: Math.min(...positions.map(point => point[0])),
        south: Math.min(...positions.map(point => point[1])),
        east: Math.max(...positions.map(point => point[0])),
        north: Math.max(...positions.map(point => point[1]))
    };
}
/**
 * Measure geometric deviation from a finite chord in the caller's pixel coordinates.
 * @param {[number,number]} point Projected geodesic position.
 * @param {[number,number]} start Projected chord start.
 * @param {[number,number]} end Projected chord end.
 * @return {number} Distance to the closest point of the finite chord.
 */
function distanceToSegment(point, start, end) {
    const dx = end[0] - start[0], dy = end[1] - start[1];
    const squared = dx * dx + dy * dy;
    const fraction = squared ? Math.min(1, Math.max(0,
        ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / squared)) : 0;
    return Math.hypot(point[0] - start[0] - fraction * dx, point[1] - start[1] - fraction * dy);
}

/**
 * Approximate a box's four great-circle edges on a caller's actual pixel grid.
 * Quarter, midpoint and three-quarter positions test each chord; inaccurate segments
 * are bisected until they converge. Geometry is derived for this operation, while
 * only the center/size descriptor belongs in captured requests or persisted jobs.
 * The default display approximation is 0.25 pixels; callers needing tighter
 * analysis accuracy specify their tolerance on the actual target pixel grid.
 * @param {SamplingBox} box Validated immutable descriptor.
 * @param {(positions:Array<[number,number]>)=>Array<[number,number]>} projectPositions
 * Transform longitude/latitude batches to equally sized pixel-coordinate batches.
 * @param {{maximumErrorPixels?:number,maximumCoordinates?:number|null}} [options] Accuracy and caller-owned coordinate capacity.
 * @return {Array<[number,number]>} Closed longitude/latitude ring approximating the geodesic edges.
 * @throws {RangeError} For invalid accuracy, nonfinite projection, exhausted coordinate capacity or numerical nonconvergence.
 * @throws {Error} Projection callback failures propagate to the caller.
 */
export function tessellateSamplingBox(
    box, projectPositions, {maximumErrorPixels = 0.25, maximumCoordinates = null} = {}
) {
    if (!Number.isFinite(maximumErrorPixels) || maximumErrorPixels <= 0) {
        throw new RangeError("Sampling-box accuracy must be a positive finite pixel value");
    }
    const corners = samplingBoxCorners(box);
    const projected = new Map();
    /** Project unseen coordinates under this caller's capacity.
     * @param {Array<[number,number]>} positions Required geographic positions.
     * @return {void}
     * @throws {RangeError} For exhausted capacity or a nonfinite projected coordinate.
     */
    function projectMissing(positions) {
        const missing = new Map();
        for (const point of positions) {
            const key = point.join(",");
            if (!projected.has(key)) missing.set(key, point);
        }
        if (!missing.size) return;
        if (maximumCoordinates !== null && projected.size + missing.size > maximumCoordinates) {
            throw new RangeError("Sampling-box boundary exceeds the transformed-coordinate capacity");
        }
        const pixels = projectPositions([...missing.values()]);
        [...missing.keys()].forEach((key, index) => {
            const pixel = pixels[index];
            if (!Number.isFinite(pixel[0]) || !Number.isFinite(pixel[1])) {
                throw new RangeError("Sampling-box boundary could not be projected");
            }
            projected.set(key, pixel);
        });
    }
    projectMissing(corners);
    let pending = [0, 1, 2, 3].map(edge => [edge, 0, 1]);
    const accepted = [];
    while (pending.length) {
        const probes = pending.map(([edge, start, stop]) => [0, 0.25, 0.5, 0.75, 1].map(fraction =>
            interpolateGreatCircle(corners[edge], corners[(edge + 1) % 4], start + (stop - start) * fraction)));
        projectMissing(probes.flat());
        const next = [];
        pending.forEach(([edge, start, stop], index) => {
            const positions = probes[index];
            const first = projected.get(positions[0].join(","));
            const last = projected.get(positions.at(-1).join(","));
            const error = Math.max(...positions.slice(1, -1).map(point =>
                distanceToSegment(projected.get(point.join(",")), first, last)));
            if (error <= maximumErrorPixels) accepted.push([edge, stop, positions.at(-1)]);
            else {
                const middle = (start + stop) / 2;
                if (middle === start || middle === stop) {
                    throw new RangeError("Sampling-box boundary accuracy did not converge");
                }
                next.push([edge, start, middle], [edge, middle, stop]);
            }
        });
        pending = next;
    }
    accepted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return [corners[0], ...accepted.map(value => value[2])];
}

/** Compare validated sampling-box identities without consulting a derived outline.
 * @param {SamplingBox|null|undefined} left First captured descriptor.
 * @param {SamplingBox|null|undefined} right Second captured descriptor.
 * @return {boolean} Whether both identify the same center and kilometer size.
 */
export function samplingBoxesEqual(left, right) {
    return Boolean(left && right && left.sideLengthKm === right.sideLengthKm &&
        left.center.longitude === right.center.longitude && left.center.latitude === right.center.latitude);
}
