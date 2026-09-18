/** Geometry checks for editable, single-ring annotation polygons. */

/**
 * Explain why a draft cannot be saved as a simple polygon.
 * @param {number[][]} vertices Unclosed [longitude, latitude] coordinates.
 * @return {string|null} Correction to show, or null for a valid polygon.
 */
export function polygonValidationMessage(vertices) {
    if (vertices.length < 3 || new Set(vertices.map(point => JSON.stringify(point))).size < 3) {
        return "Invalid polygon: must have at least 3 vertices.";
    }
    if (vertices.some(point => !Array.isArray(point) || point.length !== 2 ||
        !point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 85.05112878)) {
        return "Invalid polygon: keep vertices inside the map bounds.";
    }
    if (new Set(vertices.map(point => JSON.stringify(point))).size !== vertices.length) {
        return "Invalid polygon: two vertices occupy the same position.";
    }
    for (let i = 0; i < vertices.length; i += 1) {
        const a = vertices[i], b = vertices[(i + 1) % vertices.length];
        const previous = vertices[(i + vertices.length - 1) % vertices.length];
        const cross = (previous[0] - a[0]) * (b[1] - a[1]) - (previous[1] - a[1]) * (b[0] - a[0]);
        const dot = (previous[0] - a[0]) * (b[0] - a[0]) + (previous[1] - a[1]) * (b[1] - a[1]);
        if (cross === 0 && dot > 0) return "Invalid polygon: adjacent edges overlap. Move or delete a vertex.";
        for (let j = i + 1; j < vertices.length; j += 1) {
            if (j === i + 1 || (i === 0 && j === vertices.length - 1)) continue;
            if (segmentsIntersect(a, b, vertices[j], vertices[(j + 1) % vertices.length])) {
                return "Invalid polygon: edges cross or touch. Move or delete a vertex.";
            }
        }
    }
    const area = vertices.reduce((sum, point, i) => {
        const next = vertices[(i + 1) % vertices.length];
        return sum + point[0] * next[1] - next[0] * point[1];
    }, 0);
    return Math.abs(area) < 1e-12 ? "Invalid polygon: vertices must enclose an area." : null;
}

/**
 * Test closed line segments, including collinear overlap and endpoint contact.
 * @param {number[]} a First segment start.
 * @param {number[]} b First segment end.
 * @param {number[]} c Second segment start.
 * @param {number[]} d Second segment end.
 * @return {boolean} Whether the segments share any point.
 */
function segmentsIntersect(a, b, c, d) {
    const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const onSegment = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) &&
        Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
    const x = cross(a, b, c), y = cross(a, b, d), z = cross(c, d, a), w = cross(c, d, b);
    return (x === 0 && onSegment(a, b, c)) || (y === 0 && onSegment(a, b, d)) ||
        (z === 0 && onSegment(c, d, a)) || (w === 0 && onSegment(c, d, b)) ||
        ((x > 0) !== (y > 0) && (z > 0) !== (w > 0));
}
