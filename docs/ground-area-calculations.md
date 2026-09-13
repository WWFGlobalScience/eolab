# Ground-area calculations

`areaha(a > 10)` returns the ground area in hectares where the native raster
condition holds inside the selected box, Catalog-vector selection, or explicit whole raster.
`areaha(a == 4)` measures one class. `areaha(a == a)` measures all valid selected
ground coverage. NoData and invalid expression arithmetic contribute no area.
Zero matches returns zero; no valid coverage returns null with `no_valid_data`.

Each matching cell contributes its **intersection** with the selection. Fractions
at boundaries and slivers count; holes are excluded and overlapping selection polygons
are unioned before intersection. The area function does not change numeric
aggregates' existing center-cell inclusion. For example, a narrow box may yield
positive `areaha(a == 4)` and a null `count(a)` because it contains no cell center.

## Measurement method

Only boundaries are transformed. Every value still comes from its original native
pixel, with no warping or COG-overview substitution. Boundaries are intersected in
[PROJ's ellipsoidal cylindrical equal-area projection](https://proj.org/en/stable/operations/projections/cea.html)
on WGS84, with `lat_ts=0` and central meridian 0. Projected polygon area is the
corresponding ellipsoid surface area; square metres are divided by 10,000.
This is surface area on the ellipsoid, not terrain-slope surface area.

The initial supported source policy is geographic or projected **WGS84**, within
a continuous longitude domain from -180 to 180. Other datums, unavailable precise
transformations, invalid topology, and wrapped/undefined footprints fail explicitly.
No approximate datum substitution is attempted: pyproj transformers require
`allow_ballpark=False`, `only_best=True`, conventional x/y order and unwrapped
longitudes. See the [Transformer contract](https://pyproj4.github.io/pyproj/stable/api/transformer.html).
Selections keep the existing WGS84 selection contract and straight edges in that CRS.

For unrotated EPSG:4326, EPSG:3857 and EPSG:6933 grids, a cached vertical stack of
equal-area row heights and cached column widths give ground hectares per pixel.
Each processing block slices these same axes and multiplies those weights by its
fractional selection coverage and native raster condition/validity masks. Block sizes
do not change the grid, resolution or area method. Whole-world geographic grids
have no signed-geodesic-polygon half-globe ambiguity. Web Mercator area varies
with latitude; a nominal square kilometre near 60° latitude covers about 25 ha.

Polygon masks are numerical. Catalog selections stream exact candidates for each
bounded tile, union overlapping candidates once, and compile the resulting
exterior/hole edges. For each row strip, a clipped boundary integral
evaluated at column edges gives cumulative area; differences give fractional cell
coverage. Analytic edge crossings identify empty cells without rounding away thin
slivers. No pixel polygons, per-pixel projection, or GEOS pixel intersections are
constructed on these grids, even for border pixels. Map rectangles use direct
row/column clipping. This is mask-and-weight processing, not a coarser raster or
an average of COG overview values.

Other native cell edges and nonrectangular selection edges use adaptive densification.
Quarter, midpoint and three-quarter probes must deviate no more than **0.1 m**
from the transformed chord, and a chord must be at most **10 km**. Refinement
stops after 20 subdivision passes or fails its coordinate budget. These are
tested chord-deviation and length targets in the equal-area plane, **not a
certified bound on total hectare error**. Independent densely sampled geodesic
references test geographic, projected and rotated cases. Very thin curved
features near the tolerance scale may need a future stricter area policy.

Projected selection windows are conservatively padded after separate refinement
to 0.01 native pixel chord deviation (maximum chord 64 pixels). Numeric masks
retain their existing transformation contract. Ground-area intersection decides
the contribution of every boundary cell in the admitted window.

## Limits and result details

Plans inspect source metadata and geometry without reading band values. They
retain method, ellipsoid, hectare units, fractional inclusion, refinement settings,
strategy and estimated polygon-cell work in `grid.groundArea`. Execution verifies
the same reviewed grid and measurement settings before reading values. Provenance
also records `functionInclusion`; per-aggregate diagnostic counts remain cell
counts. Direct `areaha(...)` rows carry `unit: ha`. General scalar expressions
have no inferred unit, including `100 * areaha(a > 10) / areaha(a == a)`.

The existing 4 GiB decoded-native-work, 65,536-block, 512 MiB estimated-memory,
15-second planning and 10-minute supervised execution ceilings still apply.
Area jobs include an additional 128 MiB geometry/mask memory allowance in that same
admission estimate. Mask-and-weight calculations use bounded 256 × 256 expression
tiles, independently of native TIFF block size; other grids retain bounded
64 × 64 geometry tiles. Rectilinear axes use at
most 500,000 cached coordinates. Catalog planning and execution each enforce
a cumulative 4,000,000 transformed-position work budget while streaming original
features. Each retained feature and the exact candidate union for one tile are
bounded to 500,000 coordinates. No full Catalog selection is retained as coordinates.

All selections on supported rectilinear grids use **zero pixel polygons** and
report `estimatedGeometryCells: 0`. The polygon-cell ceiling therefore does not
restrict those windows, including large country polygons. Their native-read,
coordinate, memory, geometry-input and supervised runtime limits still apply.
Other grids conservatively estimate the **entire selected window** against the
existing 2,000,000-cell geometry ceiling. The fallback is explicit; it never
pretends that one latitude-only weight applies to a rotated or unsupported grid.
Planning estimates do not promise all refinement will fit: execution can still
stop at its cumulative transformation limit or supervised deadline. Failures ask
for a smaller area or simpler selection; they never return sampled area as exact area.
