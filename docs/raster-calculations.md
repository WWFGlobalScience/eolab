# Raster calculations

This guide is for people using EOLab to write raster formulas, interpret their
results, and understand the reported timings and limits.

Use **Summarize** to calculate statistics over a sampling box, a filtered
[vector layer](vector-sampling.md), or an explicitly selected whole raster.
Each of the five available cards has a name, formula, raster binding (`a`),
and result. Different cards can use different rasters, but each formula uses
only one raster. **Formula reference** in the panel lists the supported functions.

Calculations read **native pixels**, not histogram samples or COG overviews.
Raster styling, opacity and a simplified map outline do not change the result.

## Running and saving a calculation

Edit a formula or choose an **Add statistic** preset. Formula checks wait for a
700 ms pause in typing. Invalid formulas show an explanation. Choose **Calculate**
when a card is ready. Opening the panel or renaming a card does not run it.

From a histogram, **Summarize this area** opens the cards and runs all configured
valid statistics over that area. The first card
uses that histogram's raster; other cards keep their raster bindings. If no area
has been selected, the result position says **Click the map to calculate**. Click
the map to select a sampling box; the automatic-update policy below then applies.

**Update statistics automatically**, in the dock's **More** menu, is on by default.
With Summarize active, a new map box can update statistics automatically. Plans
above 128 native blocks, 64 MiB decoded values/masks, or 25,000 estimated geometry
cells pause for **Calculate**. Whole-raster and vector areas also require an
explicit action; **Use filtered features & calculate** supplies that action.

A previous value is grayed out while its replacement is pending. Use the copy
button beside a current value to copy it. **Value details & downloads** contains
coverage, method, CSV and provenance. Missing data can produce a completed job
with no numeric result; the states below explain why.

Changing the active calculation cancels obsolete work. Closing or switching away
from the panel cancels automatic work; manually submitted work can continue in
**More → History & exports**. Keep the same browser session to recover jobs after
reload. A shared map link does not grant access to another person's jobs.
If submission is uncertain, use **Recover / retry** instead of creating a second
request. Exported names and formulas describe the submitted calculation even if
you later edit its card.

## Language and numerical meaning

Aliases start with a letter, contain letters/digits/underscores, and have at most
32 characters. One binding is allowed. Function names and keywords are reserved.
Within one API submission, labels must be unique and at most 80 characters.
The UI can submit same-named cards separately. Expressions together have a
4 KiB UTF-8 limit and 256 syntax nodes, with nesting/tree depth limited to 20.

Formulas support finite numeric literals, the bound
raster alias, parentheses, unary `+`/`-`, arithmetic `+ - * /`, comparisons
`< <= > >= == !=`, and boolean `! && ||`. Precedence is unary, multiplication and
division, addition and subtraction, ordered comparisons, equality, AND, then OR.
Arithmetic/comparisons require numbers; boolean operators require conditions.
Strings, paths, URLs, property access, indexing, assignment, arbitrary function
calls, and executable Python are unsupported.

Every calculation must yield a numeric scalar and reference its raster. Pixel
expressions go inside an aggregate; aggregates cannot nest. Arithmetic between
aggregate results is allowed, for example `max(a) - min(a)`.

| Expression | Meaning |
| --- | --- |
| `count(a)` | Count valid selected native cells, including zero |
| `count(a > 10)` or `sum(a > 10)` | Count cells satisfying the condition |
| `sum(a, where=a > 10)` | Sum original values of the matching cells |
| `mean(a * 2, where=a >= 0)` | Pixel-weighted mean of the transformed matching values |
| `min(a)` / `max(a)` | Smallest / largest selected valid value |
| `areaha(a == 4)` | Ground hectares of class 4 intersecting the selection, including boundary fractions |
| `100 * areaha(a > 10) / areaha(a == a)` | Percentage of valid selected ground area satisfying the condition |

`areaha` requires exactly one boolean pixel expression and does not accept `where`.
Numeric functions' optional `where` takes a boolean pixel expression. `mean`, `min`, and `max` take numbers;
`sum` and `count` also accept a condition. Scalar literals within a pixel aggregate
broadcast over valid source cells. Scale/offset metadata is recorded but **not
automatically applied**: calculations use the stored values, matching the current
analysis value domain. Users can explicitly write `a * 2 - 1`. No expression-unit
inference is claimed; the grid's unit is source metadata, not a computed result unit.
A direct `areaha(...)` result explicitly carries `unit: ha`; compound scalar
expressions leave `unit` null, including percentages and user conversions.

By default, each source block is read once, then evaluated in tiles of at most
256 × 256 cells (64 × 64 only for grids requiring individual pixel geometry).
Opt-in batching can combine those reads and enlarge evaluation tiles as described
below. Integers are converted exactly from the supported native integer types to
float64 for pixel arithmetic. Numeric sums use float64 block sums with compensated
combination across blocks; means use scaled block means and weighted combination.
Floating results are not arbitrary-precision decimal arithmetic. Count reductions
remain integer accumulators. All returned values are decimal **strings** with
`valueType: integer | float`, preserving integer counts across JSON/JavaScript.

Numeric aggregates include cells whose centers fall within the selected area.
Holes are respected; overlapping polygons count once.
`areaha` instead measures each matching native cell's intersection with the polygon selection/box
on the WGS84 ellipsoid, preserving fractional boundary cells, holes, and unioned
overlaps. A sliver can have positive area without containing any pixel center.
These are distinct from clipping's all-touched export mask. EPSG:3857 pixel
dimensions are not ground hectares. See [ground-area methods and limits](ground-area-calculations.md).

Source nodata, nonfinite values, and cells outside the selected area are missing,
never zero. Arithmetic/domain errors invalidate the affected cell in that
aggregate. All operands must be valid, including both operands of boolean OR;
there is no short-circuit recovery from missing data. Partially valid calculations
still produce a result and report excluded arithmetic cells. Each row includes
per-aggregate `validPixels` (source-valid selected cells), `matchedPixels` (included
cells after expression validity/condition), and `invalidArithmeticPixels`.
For `areaha`, these diagnostics count cells with positive intersection; they are
not hectare totals. NoData contributes neither area nor numeric values.

| State | Result |
| --- | --- |
| `ok` | Finite result; coverage diagnostics may report excluded arithmetic cells |
| `no_matches` | Valid data exists but nothing matches: count/sum/areaha is zero, mean/min/max is null |
| `no_valid_data` | No valid source cell in the area: null, including count |
| `invalid_arithmetic` | All eligible source cells have invalid expression arithmetic, or final scalar arithmetic is undefined: null |
| `overflow` | A numeric accumulation or final scalar result overflows: null |

Missing aggregate operands propagate to the final scalar result. Nonempty scalar
combinations keep `ok`; `no_matches` propagates when every aggregate reports it.
A job can finish `ready` with null-valued rows: the result explains what happened.
CSV stores label, expression, value, value_type, state, and unit; potentially executable
spreadsheet text is escaped. Provenance retains original expressions, the selected area or Catalog descriptor,
source signature, native grid, value/inclusion policies, typed rows,
coverage, creation time, and the CSV checksum.
Area provenance also retains `grid.groundArea` and `functionInclusion`, distinguishing
numeric centers from fractional area intersections.

## Batch size and timing

**Performance tuning (experimental) → Target pixels per batch** changes how
many native pixels are processed together, not raster resolution. Current behavior
is the default. The other targets are 65,536, 262,144, 1,048,576 and 4,194,304 pixels.
Larger batches can reduce read overhead but need more memory; they are not always
faster. Changing the target waits for **Calculate**. Counts are unchanged across
batch sizes; floating results can differ in last-place rounding.

Performance details show requested and effective read/tile sizes, memory estimates
and timings. These are wall times, including waiting within each operation:

- **Total wait → result displayed** includes vector selection when initiated for the calculation in this tab,
  debounce, planning, queueing and
  result delivery through the UI update. It excludes earlier confirmation time
  and the browser's subsequent paint.
- Browser stages divide that total. Server stages overlap them; do not add the
  browser and server groups together.
- **Kernel elapsed** covers source opening and calculation through the CSV
  checksum. New results also break out source setup, selection-envelope
  reading/projection and ground-area setup.
- **Inside Calculation** splits polygon masking, ground-area weights, formula
  evaluation/reductions, and remaining tile/loop work. Masking includes any vector
  reads, projection and rasterization required for each tile. These are nested
  parts of Calculation, not additional time.
- **Read/decode and source mask** includes native raster I/O, decompression and
  its validity mask. It includes waiting, so it is not pure disk time.
- **Vector selection before calculation** is part of Before planning when that
  selection was observed in this tab. It excludes optional display-outline work.
  A later Calculate click starts a new measurement.
- Kernel setup, read, calculation, CSV/checksum and the labelled remaining kernel
  work partition Kernel elapsed. Progress writes and source closing are
  included in that remainder. Timings describe the entire shared batch when
  several statistic cards run together.
- Native-process time also includes communication and cleanup. Readiness wait
  includes any startup required for this request; earlier prewarming is excluded.
- **Queued → ready** includes server queueing and execution. The estimated
  submission/delivery remainder includes request handling, transfer and result
  observation; it is not a measurement of network time alone.

Old results may lack timing fields. A fast kernel does not guarantee the same
request-to-display time under a busy server or slow connection.

## Limits

| Resource | Limit |
| --- | --- |
| Native decoded source work | 4 GiB, at most 65,536 blocks, with conservative preallocation guard |
| Estimated native/expression working memory | 512 MiB within the existing 2 GiB worker |
| Retained feature / projected-coordinate buffer | 500,000 positions |
| Area polygon-cell work / execution transformations | 2,000,000 fallback cells / 4,000,000 positions; supported rectilinear grids use no pixel polygons |
| Area geometry memory estimate | Additional 128 MiB within the same 512 MiB admission ceiling |
| Working/result reservation | 12 MiB per calculation job |
| Planning / execution | Existing 15-second / 10-minute supervised deadlines |
| Result lifetime | Existing 24-hour lifetime and transfer leases |

A work-limit refusal asks for a smaller area or batch; it never substitutes
coarser pixels. Original raster and vector sources must remain available and
unchanged until the job finishes. Failed or cancelled work does not publish a
partial CSV. See [ground-area calculations](ground-area-calculations.md) for
additional area-method limits and [clip storage](raster-clips.md#storage-and-limits)
for result retention.


### Direct Peru/Brazil sum benchmark

From a checkout with Python 3.12+ and the EOLab dependencies installed, run:

```console
python run_raster_vector_sum_benchmark.py
```

The defaults use the 2018 human-footprint COG in
`D:/wwf-connectivity/processed/human-footprint/` and
`D:/easy_to_find_data_i_always_use/countries_without_antarctica.gpkg`.
The script selects `iso3 == PER OR iso3 == BRA`, requires exactly two features,
and calls the application's `selection_summary`, `plan_aggregate`, and
`calculate_raster_statistics_for_area` for `sum(a)`. It uses the native pixel grid,
source validity mask, cell-center polygon inclusion, normal work limits and default read/tile
sizes. It does not contain its own clipping or summing algorithm.

Use explicit inputs on another machine, and redirect the JSON report to save a baseline:

```console
python run_raster_vector_sum_benchmark.py --raster /scan-source/human-footprint/human-footprint_hfp_2018_wgs84_cog.tif --vector /scan-source/countries_without_antarctica.gpkg --repeat 3 > sum-baseline.json
```

Adjust the mounted paths to match the installation; `--layer` overrides the
default `countries_without_antarctica` native layer name. Progress goes to stderr.
Input files are read-only, and temporary kernel artifacts are deleted after each
run. Ctrl+C interrupts the direct calculation.

The report includes the result, CSV checksum, file identities, grid, limits,
library versions, checkout revision and stage timings. Each repetition plans and
executes again; caches are not cleared, so a first repetition is not necessarily
cold. Compare identical inputs and grids: the local default COG is WGS84 whereas
the current Connectivity deployment uses a Web Mercator copy.

This is an offline kernel benchmark. It supplies explicit local file capabilities
in place of Catalog lookup and job submission. It does not measure authorization,
HTTP, queueing, worker startup, notifications or browser display. The app's
performance details retain those end-to-end measurements. Import time is reported
separately; inner kernel stages overlap the execution time and must not be added
to it.


### Polygon preparation memory

For summaries over a filtered vector layer, EOLab prepares the exact projected
polygons before reading raster blocks, then reuses them for pixel-center masks.
They are released when that calculation finishes or fails; nothing is saved as
a filtered vector copy or shared between jobs. Planning and validation still
read the source separately. Hectare weighting uses its existing separate path.

Retained polygons have a 128 MiB ceiling per calculation, further reduced by the
memory needed for the planned raster buffers. Preparation checks each feature
before projection and counts its projected containers and coordinates afterward.
If it cannot fit, filter the layer more narrowly or use a smaller raster batch.
EOLab does not simplify the analysis polygons to fit.

Selection setup timing includes this preparation. Mask timing measures the
remaining per-tile rasterization. The result's retainedPolygonBytes estimates
retained Python geometry memory in addition to the plan's raster-buffer estimate;
it is not measured process RAM usage.
