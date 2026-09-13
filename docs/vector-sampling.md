# Sampling with a filtered Catalog vector

In **Summarize → Area → Vector layer**, choose a mounted Shapefile or GeoPackage
polygon layer. **Edit filter → Use filtered features & calculate** commits the
typed predicate, selects its Catalog descriptor, returns to Summarize, and runs
configured valid statistics in one action. Cancelling or closing a draft does
not submit it. Cancel remains available during selection and calculation. If
there are no statistic cards, the editor opens without inventing a calculation.

**Use these features** also remains available. Accepting a reviewed selection
in Summarize runs configured statistics, even with automatic updates disabled;
accepting it in Explore only changes the sampling area. Both placements share
the selection. The analysis predicate is independent of the map rendering filter.
All matching source features contribute regardless of viewport or map visibility.

Selections drive 1D and 2D histograms, native summaries, calculations, fractional
ground areas, and clips. Each feature keeps its existing numeric policy:
histogram all-touched masks, native calculation cell centers, clip all-touched
masks, or fractional ellipsoidal intersections. Overlapping polygons count once
and holes remain excluded. Histogram modes keep their own grid policies and can
report different sample counts.

An unfiltered multi-feature selection or envelope exceeding 5 million km²
requires review for direct **Use these features**; an envelope over 100 million km² requires another near-global
confirmation. These envelope checks do not estimate polygon area or bypass
resource limits. Source/filter changes invalidate pending selection work.
Summarize's explicit filter action skips envelope confirmations while retaining
server limits. Obsolete selection transports are aborted; the next bounded
request waits for the prior one to settle. No server identity needs cleanup.
No matches is an explicit error, never an unfiltered or bounding-box fallback.

## Public descriptor

`POST /api/vector-sampling/areas` accepts the existing `collectionId`, `itemId`,
and typed `filter`. It resolves Catalog metadata and the exact mounted source,
validates native fields, and returns counts, exact bounds, scalar work measures,
and a `selection` descriptor:

```json
{
  "collectionId": "eolab-mounted-vectors",
  "itemId": "scanner-owned-item-id",
  "assetKey": "data",
  "layerName": "native-layer-name",
  "sourceSignature": "<64 lowercase hexadecimal characters>",
  "filter": {
    "enabled": true,
    "match": "all",
    "rules": [{"field": "NEXT_SINK", "operator": "eq", "value": 6060007000}]
  }
}
```

Use that entire descriptor as `catalogSelection` in raster-statistics,
paired-statistics, clip-plan, and calculation-plan requests. A selection is
exclusive of a rectangle or explicit whole-raster intent. Requests accept no
paths, arbitrary SQL, browser geometry, or opaque area IDs. Single/paired
statistics use scope `catalogSelection` and echo the descriptor; whole/rectangle
response fields retain their prior shape.

`POST /api/vector-sampling/outline` accepts the descriptor separately and returns
an approximate map outline. It may omit small components/holes to fit its
256 KiB / 10,000-position display budget. Failure, cancellation, or hiding that
outline does not invalidate numeric selection. Zoom uses exact measured bounds.

## Ownership and dependencies

- **Owner:** Catalog vector selection (`vector/sampling.py`) validates Catalog
  identity, native asset/layer, immutable source signature, and typed predicates.
  **Used by:** the selection route and injected analysis/Processing read port.
  **Depends on:** Catalog metadata, mounted resolution, neutral predicate/source
  contracts, and bounded process execution. It retains no geometry registry.
- `catalog_selection.py` owns path-free descriptors and private resolved-source
  capabilities. `attribute_filter.py` owns the existing rule semantics shared
  with vector filtering. `bounded_vector.py` owns streaming original-source
  reads, conservative candidate bounds, and bounded exact-mask mechanics.
  These mechanisms have no rendering, GeoServer, or feature workflow.
- Raster analysis owns histogram grids, numeric policy, cancellation, cache
  identity, and source reauthorization. Processing owns native plans, durable
  job descriptors, exact/fractional algorithms, and publication. Both depend on
  neutral source contracts without importing each other's implementation.
  **Coordinates with:** browser peers through composition and immutable values;
  neither feature inspects rendering state.
- The existing browser composition root connects vector selection, its optional
  outline adapter, analysis selection, and Processing. No new coordinator,
  top-level service, source copy, storage mount, or selection database is added.

## Bounded direct reading

Every read opens the original native layer. Numeric/null predicates use quoted,
server-compiled OGR WHERE clauses; exact Python evaluation follows candidate
reads. String/date rules remain post-filtered because driver collation differs.
An OR with a post-filtered rule cannot prune its other native candidates.

Spatial pruning is conservative: canonical separable EPSG:4326/3857/6933 grids
can bound EPSG:4326 source candidates using padded corner envelopes. Wrapped
world edges and unproven CRS transformations use the unrestricted predicate
stream. Exact projected geometry always determines final membership.

Selection reads admit two native children per application process, each with a
15-second supervised deadline and a 2 GiB Linux address-space ceiling. Streams
check source signatures, cancellation, a 15-second work deadline, and at most
one million candidate features. Each retained native/transformed feature is
limited to 500,000 coordinates. There is no 7 MiB complete-selection JSON limit,
10,000-match limit, TTL, or aggregate retained-selection budget.

Projection preserves the existing selection-wide densification rate for
previously supported geometry. It retains one feature at a time; masks union
per-feature membership on admitted grids. Fractional calculations union exact
tile candidates before measuring intersections, retaining at most 500,000
coordinates per tile and enforcing the existing 4-million transformed-position
work limit. Unsupported transformations and exceeded actual work limits fail
explicitly. Raster block, decoded-byte, output, concurrency, and operation
deadlines remain independently enforced. Full selected geometry is never copied
into requests, jobs, or provenance.

## Persisted compatibility

New `ClipArea` / `AggregateArea` values use `kind: "catalogSelection"`, measured
bounds, and the descriptor. A resolved local capability exists only during
planning/execution and is excluded from serialization. The dedicated worker
reauthorizes both Catalog sources before execution and before publication.
Source removal or mutation fails pending work; completed results remain readable.

The existing database claim fence requires protocol 5 for these jobs, so older
workers cannot execute them. Rectangle/whole jobs retain their older claim
versions and wire shape. No destructive data migration is performed.

Historical accepted `kind: "aoi"` jobs retain their operation-owned geometry
reader, including queued execution, result/provenance access, and idempotent
submission recovery. An old unsubmitted plan with a non-null `temporaryAoiId`
returns `legacy_selection_plan`; choose a Catalog vector and review a new plan.
Old rectangle/whole plans containing a null retired field remain submittable.
These historical schema checks do not restore upload, storage, expiry, or any
live area service. Existing result expiry/cleanup policies are unchanged.

Selection state is not added to shared map links. A page reload can recover
owned Processing jobs with the existing session cookie. Removed upload intents
cannot be restored as live browser selections.


### Jobs outline execution

Application composition always injects the vector-owned Jobs adapter for outlines.
The registered operation uses `selection_source.resolve_selection` and
`geometry.build_outline`; there is no local outline wrapper, second geometry
algorithm or selection storage. Selection summaries retain their local process
and two-slot semaphore, using the neutral source reader's `READ_SECONDS` deadline.
Selection-only consumers may omit the outline executor; an outline call on such
an instance reports unavailable instead of starting local work.
A remote outline never acquires a local selection slot. Jobs failure is
an optional-outline failure and does not authorize, gate or cancel analysis.
See `docs/job-service.md` for caller credentials, source mount, deadlines and
rollback. The existing outline HTTP response and disconnect handling are retained.
