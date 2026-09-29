# Deployment and operations

This guide is for the person creating or maintaining an EOLab workspace. The
main [README](../README.md) explains how participants use the application.

## What a deployment contains

The supplied Docker Compose stack runs:

- the EOLab web application;
- PostgreSQL with pgSTAC for persistent Catalog metadata;
- the STAC API for Catalog queries;
- GeoServer for raster and vector rendering;
- a Processing worker for raster calculations and clip downloads;
- a Job service for vector-area measurements and optional map outlines; and
- one-time database migration and GeoServer initialization services.

Source datasets are supplied through a read-only host bind mount. EOLab does
not copy the source files into its database or modify them in place.

## Before you deploy

Prepare:

1. a machine with Docker Compose, or a Coolify project that can deploy a Docker
   Compose repository;
2. different, long random secrets for PostgreSQL, the GeoServer administrator,
   the GeoServer keystore, and the Job service; and
3. an absolute host directory containing the prepared datasets, readable by
   the application container.

Keep the database password stable after the first deployment. PostgreSQL uses
it when initializing the persistent database volume; changing only the
environment variable later does not change the existing database role's
password.

Raster files should already be georeferenced and prepared for interactive map
delivery. Tiled, overviewed, single-band Cloud Optimized GeoTIFFs in Web
Mercator (EPSG:3857) are recommended for the default map. EOLab publishes
mounted rasters as-is and reports reader or CRS failures instead of rewriting
the source.

## Required configuration

Start from [`.env.example`](../.env.example), which is the authoritative list
of settings and defaults. At minimum, set:

```text
EOLAB_DATABASE_PASSWORD=<long random value>
EOLAB_GEOSERVER_ADMIN_PASSWORD=<different long random value>
EOLAB_GEOSERVER_MASTER_PASSWORD=<different long random value>
EOLAB_JOBS_TOKEN=<different long random URL-safe value>
EOLAB_SCAN_MOUNT_PATH=/absolute/host/path/to/data
EOLAB_SCAN_PATHS_WITHIN_MOUNT=["."]
EOLAB_SCAN_DISPLAY_PATH_PREFIX=Workshop data
```

`EOLAB_SCAN_MOUNT_PATH` is a path on the deployment host. Compose mounts it
inside the application at `/scan-source` as read-only. Each entry in
`EOLAB_SCAN_PATHS_WITHIN_MOUNT` is relative to that root; use `.` to scan the
entire mount. `EOLAB_SCAN_DISPLAY_PATH_PREFIX` is the friendly location shown
to users in Item details.

The GeoServer administrator password must contain at least 16 letters,
numbers, hyphens, underscores, or periods. The master password must contain at
least eight characters, have no surrounding whitespace, and differ from the
administrator password.

Generate the Jobs token with
`python -c "import secrets; print(secrets.token_urlsafe(32))"` and set the single
`EOLAB_JOBS_TOKEN` variable. Compose passes it to both the app and Job service.
The app rejects absent, blank or malformed tokens at startup. Keep it private;
see [Job service operation](job-service.md) for a manual diagnostic.

Set nonblank `EOLAB_APP_TITLE` and `EOLAB_APP_SUBTITLE` values for the public
application identity. In Coolify, use the `EOLAB_` variable names from the example;
Compose maps them to the internal container names.

Use distinct persistent volume names when several EOLab deployments share one
Docker host:

```text
EOLAB_DATABASE_VOLUME_NAME=my-workshop-pgstac
EOLAB_GEOSERVER_DATA_VOLUME_NAME=my-workshop-geoserver
EOLAB_PROCESSING_DATA_VOLUME_NAME=my-workshop-processing
```

## Basemap choices

The **Basemap** dropdown sits at the lower-right of the map, above attribution.
**Detailed** uses `EOLAB_BASEMAP_URL` and `EOLAB_BASEMAP_ATTRIBUTION`, and is selected
when the app opens. **Country outlines** uses bundled Natural Earth boundaries.
**None** removes the background. These choices do not change data layers,
map position, sampling, or analysis results. The choice lasts for the open map;
it is not included in saved-map links or browser-local saved views.

To offer **Light (CARTO)**, set this optional deployment variable and redeploy:

```text
EOLAB_CARTO_BASEMAP_API_KEY=<your CARTO basemap key>
```

When the variable is missing or blank, the CARTO choice is absent. Compose passes
it as `CARTO_BASEMAP_API_KEY` inside the app container. The app includes it in
the public tile URL because the browser requests tiles directly. Use a
domain-restricted **basemap** key, not a private CARTO account credential.
Request a key and configure restrictions using
[CARTO's basemap key page](https://carto.com/basemaps/apikey/).
CARTO/OSM attribution stays visible while that background is selected.
CARTO documents that its raster tile service is being retired; this optional
Leaflet raster integration can be disabled by clearing the key. No additional
renderer is required by EOLab.

To offer **Satellite (MapTiler)**, set `EOLAB_MAPTILER_API_KEY` and redeploy.
Missing or blank hides the option. Compose passes it as `MAPTILER_API_KEY` to
the app container. Use a map-access key from
[MapTiler Cloud](https://cloud.maptiler.com/account/keys/), restricted to the
viewer domains. This key is browser-visible; it is not a private account token.
The browser requests `satellite-v2` JPEG tiles directly from MapTiler only when
selected. This is imagery without road or place labels. Native tiles are used
through zoom 22, as advertised by the provider's TileJSON metadata.

MapTiler/OSM attribution and a linked MapTiler logo remain visible while Satellite
is selected, including the logo required by free accounts. Usage counts against
the supplied key's account plan and quota. If imagery cannot load, the basemap
control shows a message; check allowed domains, key validity, quota and network
access. Switching to another basemap and back retries the tile requests.
See [MapTiler attribution requirements](https://docs.maptiler.com/guides/map-design/attribution/add-attribution/).

The outline asset is Natural Earth **1:110m Admin 0 Countries**, version 5.1.2,
[public-domain data](https://www.naturalearthdata.com/about/terms-of-use/).
`frontend/src/assets/country-outlines.geojson` retains the coordinates of all
177 features and removes their unused attributes. Source:
[`ne_110m_admin_0_countries.geojson`](https://github.com/nvkelso/natural-earth-vector/blob/v5.1.2/geojson/ne_110m_admin_0_countries.geojson).
Source SHA-256: `6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f`.
These generalized boundaries are a display background, not analysis geometry.
They load from EOLab on first selection and need no external tile service.

## Deploy with Coolify

1. Create a resource from this repository.
2. Select the **Docker Compose** build pack and `/docker-compose.yml`.
3. Add the required variables above to the intended Coolify environment.
   `EOLAB_SCAN_MOUNT_PATH` must be added manually because it is a bind-mount
   source rather than a container variable.
4. Attach the public domain only to the `app` service at internal port `8000`,
   for example `https://eolab.example.com:8000`. Keep the other services private;
   EOLab provides the public Catalog, rendering and Jobs API routes.
5. In **Advanced**, enable **Include Source Commit in Build** (called **Source
   Commit Availability** in some Coolify versions). This lets the application
   display the deployed Git-derived version.
6. Deploy the resource.

Changing an environment variable requires a redeployment. Persistent Catalog
and GeoServer volumes survive an ordinary redeployment.

## Run locally

Copy `.env.example` to `.env`, set the required values, and start the stack:

```console
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build --detach
```

Open `http://localhost:8000`. The local override exposes GeoServer's
administration interface only on the same machine at
`http://localhost:8081/geoserver/web/`; sign in as `eolab` with
`EOLAB_GEOSERVER_ADMIN_PASSWORD`.

## First-run verification

After the application reports that its services are ready:

1. Open **Status** and run **Scan directories** from the Catalog section.
2. Confirm that the configured user-facing paths appear and the scan completes.
3. Search for and add one representative raster and vector.
4. Verify **Zoom to**, styling, map clicking, and a raster histogram.
5. In the browser network inspector, reload one map tile twice and verify its
   `geowebcache-cache-result` response changes from `MISS` to `HIT`, with both
   `geowebcache-gridset` and `geowebcache-crs` reporting `EPSG:3857`.
6. Open **Rendering diagnostics** while changing zoom levels and check for
   repeated `GetMap` failures, queue saturation, or sustained heap pressure.
7. Copy a map link and open it in another browser tab to verify shared-view
   restoration.
8. Select a small filtered polygon, confirm its outline, and calculate a raster
   mean. Create and download a small clip to verify the Processing artifact mount.

Scanning is repeatable. It creates or updates stable Catalog Items for mounted
datasets and removes Items whose required mounted files no longer exist. A
failure in one dataset is reported without preventing unrelated valid files
from being cataloged.

## Supported mounted data

The scanner recognizes GeoTIFF, GeoPackage, mounted Shapefile, ZIP-contained
Shapefile, GeoJSON FeatureCollection, and Esri File Geodatabase sources.
Mounted GeoTIFFs, mounted Shapefiles, and spatial GeoPackage layers are the
current map-rendering paths. Other recognized vector formats remain useful as
Catalog records and report an actionable message when rendering is unsupported.

The scanner is metadata-oriented. It does not validate raster tiling,
overviews, compression, decoded size, or GeoServer reader compatibility. Data
preparation remains an upstream responsibility.

GeoPackage and File Geodatabase containers can produce one Catalog item per
spatial layer; nonspatial tables are skipped. A bad layer is reported separately
when other layers can be cataloged. GeoJSON must be a FeatureCollection with
WGS84 longitude/latitude coordinates; projected legacy CRS declarations are not
silently reprojected.

GeoPackage layers whose transformed geographic bounds cross the date line can
be cataloged. Their catalog footprint is split at +/-180 degrees while the
source geometry and native CRS remain unchanged. On the single-world map,
zooming to such a layer shows both map edges; feature inspection checks both
longitude intervals. The footprint remains a conservative envelope, not the
exact union of the source polygons. Rescan a previously rejected source after
upgrading. This does not add support for every analysis operation on unsplit
date-line-crossing source polygons.

## Capacity controls

Begin with the defaults in `.env.example` and change them only after observing
the deployed workload. The main controls are:

| Setting | Default | What it bounds |
| --- | ---: | --- |
| `EOLAB_GEOSERVER_CPU_LIMIT` | `4` | CPUs available to GeoServer |
| `EOLAB_GEOSERVER_MAX_HEAP_SIZE` | `4g` | GeoServer Java heap |
| `EOLAB_GEOSERVER_WMS_RENDER_COUNT` | `2` | Concurrent WMS renders |
| `EOLAB_GEOSERVER_GWC_REQUEST_COUNT` | `8` | Concurrent cached-tile requests, including misses |
| `EOLAB_GEOSERVER_WMS_QUEUE_TIMEOUT_SECONDS` | `10` | Seconds a render may wait for capacity |
| `EOLAB_GEOWEBCACHE_DISK_QUOTA_GIB` | `25` | Persistent tile-cache size before LRU cleanup |
| `EOLAB_COMPOSITE_TILE_CACHE_BYTES` | `134217728` | Process-local successful composite PNG response bytes |
| `EOLAB_MAP_RENDER_QUEUE_CAPACITY` | `64` | Additional distinct composite misses and direct WMS GetMap requests waiting per app process; `0` disables waiting |
| `EOLAB_MAP_RENDER_QUEUE_WAIT_SECONDS` | `60` | Maximum wait before upstream dispatch, greater than zero and at most 60 seconds |
| `EOLAB_RASTER_PIXEL_READ_CONCURRENCY` | `2` | Concurrent interactive pixel reads |
| `EOLAB_RASTER_STATISTICS_READ_CONCURRENCY` | `1` | Concurrent bounded statistics reads |
| `EOLAB_RASTER_STATISTICS_QUEUE_CAPACITY` | `32` | Additional distinct 1D/2D histogram reads waiting per app process |
| `EOLAB_RASTER_STATISTICS_QUEUE_WAIT_SECONDS` | `30` | Maximum wait before a histogram read starts, excluding read time |
| `EOLAB_RASTER_STATISTICS_MAX_WAITERS` | `256` | Callers awaiting histogram results per app process, including duplicate requests |
| `EOLAB_SCAN_WORKER_COUNT` | `8` | Concurrent metadata workers |
| `EOLAB_SCAN_WRITER_COUNT` | `4` | Concurrent Catalog bulk writes |
| `EOLAB_SCAN_BATCH_SIZE` | `100` | Items in each bulk write |

Composite cache misses and direct WMS GetMap requests share one FIFO queue per
app process, using `EOLAB_GEOSERVER_WMS_RENDER_COUNT` upstream slots. Successful
composite cache hits bypass the queue. Identical composite misses and identical
ordinary WMS requests each share one queued or running request within their
respective route. Every WMS caller is authorized before joining; all prepared
query parameters (including server-owned filters) and forwarded headers must
match, ignoring query order and parameter-name case. Ordinary WMS sharing retains
no completed responses; GeoWebCache remains responsible for cached tiles.
The default allows 64 additional distinct requests to wait up
to 60 seconds, followed by at most 30 seconds for the upstream response. Configure
the reverse proxy to allow this combined wait. Full or expired queues return 503
with `Retry-After: 1`; the upstream execution deadline returns 504. GeoServer's
own admission limit remains a final guard for traffic outside this app process.
Use one app process per GeoServer with these limits; independent replicas do not
share this queue or its cache.

Disconnecting one caller does not cancel another caller's render. Once every
caller leaves, unused queued work is removed. An ordinary WMS caller can join
an identical render still running after earlier callers left.
A started HTTP request keeps its slot
until its response or deadline, even after its last viewer leaves, because closing
the connection does not prove GeoServer stopped rendering. At timeout or shutdown
the transport is cancelled; native GeoServer work may continue. Capabilities,
feature picking and diagnostics do not wait in the GetMap queue. Frontend tile
loading/recovery feedback is independent of this server-side scheduling.

Ordinary and paired histograms share a FIFO queue in each app process. Identical
requests share one read; cached results bypass the queue. The defaults permit one
active read, 32 additional distinct reads, and 256 waiting callers (including
duplicates). Canceling the last caller drops queued work; an active reader holds
its capacity until it actually exits. Hover pixel picking uses separate capacity.

A full backlog or waiter limit returns 409 `statistics_capacity_busy`; the browser
retries that response up to five times, then offers Retry. A request waiting more
than 30 seconds returns 503 `statistics_queue_timeout` and offers manual Retry.
Both responses include `Retry-After`. The wait limit excludes raster reading;
configure the reverse proxy's response timeout to allow queue wait plus the read.
Info logs separate `queue_wait_seconds` from `read_seconds` (the latter includes
selection rechecks and result caching). These limits are per process, not per user,
and increasing the queue does not increase native execution concurrency.

Vector filter counts use two readers per app process, with up to 32 requests
waiting in FIFO order for at most 30 seconds. The wait is separate from the
existing 21-second read deadline and one-million-feature scan limit. These are
the Vector publication service's constructor defaults. Cached counts and filter
application bypass the count queue. Disconnecting removes a waiting request;
an active read keeps its slot until the reader exits after cancellation.

The `/api/vector-rendering/filter-counts` endpoint returns 429
`filter_count_queue_full` or 503 `filter_count_queue_timeout` in `detail.category`,
with `Retry-After: 2`. The layer stays filtered and displays a message to apply
the filter again to retry counting; the browser does not retry indefinitely.
A successful response with `complete: false` still means the reader could not
provide an exact count, rather than ordinary queue contention. Allow at least
the combined queue and read deadlines in proxy response timeouts.

EOLab abandons queued upstream `GetMap` work when the requesting browser
disconnects, but an already-running GeoServer render may not stop immediately.
Increasing concurrency beyond the storage and CPU available can make latency
worse rather than better.

Source rasters stored in EPSG:3857 avoid reprojection on cache misses; GeoServer
can still reproject other supported CRSs. GeoWebCache tiles live in the persistent
GeoServer volume and are removed least-recently-used first when its quota is
reached. Composite map images use a separate process-local cache, cleared by an
application restart. A new image does not invalidate old persisted tiles: after
a rendering fix, truncate affected layers' GeoWebCache tiles if stale colors
remain, including old NoData colors.

See [clip limits](raster-clips.md#storage-and-limits),
[calculation limits](raster-calculations.md#limits) and
[Jobs limits](job-service.md#lifecycle-and-limits) for the separate processing budgets.

## Processing storage and recovery

The named Processing volume is mounted at `/processing-data`, writable by
`processing-worker` and read-only in the app. Keep it outside the source mount.
The 20 GiB reservation budget does not allocate or cap the underlying disk;
monitor host/volume free space. Processing also requires a 2 GiB free-space floor.
Deleting this volume loses result files even if their database records remain.
Back up persistent database and result storage together when results must be kept.

Deploy the app and Processing worker together, stopping the old containers first.
Every Processing worker startup marks all queued, running and cancelling jobs as
interrupted with a resubmit message before consuming new work. This applies to
upgrades, rollbacks, same-version redeployments and worker container restarts.
No job-format version or compatibility check is needed. Completed results and
cached calculation values survive, subject to their usual expiry. The existing
worker cleanup removes interrupted attempt files before releasing reservations.
Never overlap old and new worker containers with this policy.

Releases predating this policy cannot perform the startup reset. Before rolling
back to one of those releases, stop the app and worker and invalidate unfinished
work in the Processing database (then start the older release):

```sql
UPDATE processing.jobs
SET status = 'interrupted', updated_at = clock_timestamp(),
    error = '{"code":"worker_restarted","detail":"The application restarted before this job finished. Submit a new job to retry."}'::jsonb
WHERE status IN ('queued', 'running', 'cancelling');
```

The older worker's normal cleanup removes those attempts and releases storage.
This intentionally discards unfinished calculations; users must resubmit them.
It does not delete completed results or source data.

A graceful worker stop interrupts its active job. On restart, any other unfinished
jobs are interrupted too. Interrupted jobs require a new submission; partial results
are not resumed. App health and map exploration can remain available while
Processing reports its database or storage unavailable.

Job updates use same-origin server-sent events with a two-second polling fallback.
Allow streaming through the reverse proxy without buffering. Losing that stream
does not cancel accepted jobs. The stream reconnects periodically; polling still
recovers updates if streaming is unavailable.

Current raster summary clients submit complete inputs and a stable `requestId`
to `POST /api/processing/raster-calculations`. The 202 response is the queued job;
no separate plan request or later execution submission is needed. The worker
publishes `progress.phase: preparing`, then stores the prepared `grid` and
`preparation` timing on that job and starts calculating immediately. Job reads
and the existing SSE hints expose these updates. Before preparation, `grid` and
`preparation` are null. Cancellation uses the same job ID throughout. Cached
results still enter the job queue, but skip native preparation and calculation.
Deploy API, worker and frontend together; see the rollback procedure above.

Raster clips use `POST /api/processing/raster-clips` with the catalog source,
explicit box or catalog selection, and a stable `requestId`. The worker prepares
the grid and reserves disk space, publishes these details on that job, then
creates the COG. Downloads shows preparation and clipping progress without a
separate estimate/confirmation step. The job can be cancelled at either stage.
Both operations retain the existing source, memory, work and disk limits.

The independent planning API, database table, queue and native process have been
removed. Reload older browser tabs after deployment. Unsubmitted legacy plan
records are discarded; completed job downloads and calculation caches remain.
Preparation retains a 15-second timeout within the job's overall deadline.
Status reads use the existing owner-scoped SSE hints and polling fallback.

Calculation submissions retry `owner_queue_full` and `queue_full` with the same
request key, using cancellable backoff and `Retry-After`. Downloads retains an
unconfirmed submission for an explicit retry. Retained-input, result-storage and
job-history exhaustion remain explicit errors requiring attention.

### Durable calculation and clip queues

Identical summary or clip requests share one queued/running computation across
browser sessions. Matching includes catalog sources, exact area/filter inputs,
formulas and execution settings; formula labels and browser retry IDs do not
affect it. Each browser receives its own job handle and download permission.
Cancelling one handle withdraws that caller; native work stops only after the
last caller cancels. Deleting one result leaves other callers' downloads intact.
Files expire together using the existing result lifetime. Completed statistics
still use the separate numerical-result cache.

The computation owns its inputs, attempt, progress and files. Small database
subscriber records retain ownership, retry identity and formula labels. Queue
and disk limits count shared computation once; per-session waiting limits and
the record limit count subscriber handles. Shared execution counts as a turn
for each subscribed session. Deploy the app and worker together: this schema
migration moves ownership fields to subscribers and preserves existing handles.

Execution uses one global worker lane. Waiting jobs do not occupy that lane, and
the running job does not count against its session's waiting allowance. The
worker selects the least recently served session, then that session's oldest
queued job. A session without an earlier execution start goes first; ties use
the oldest queued job. Each start counts as a turn even if execution fails or is
cancelled. Running work is never preempted, so another session can still wait
up to the current job's execution deadline. This shares turns, not CPU seconds.
Unfinished jobs are interrupted on worker startup. Deploy the app and worker
together. The migration counts
existing inputs; a database trigger accounts for inserted inputs and their cleanup.

The defaults admit a burst of 32 jobs from one session plus four jobs each from
twelve other sessions (80 waiting jobs), provided storage budgets also fit.
`tests/test_processing_admission_postgres.py` exercises that workload with a held
execution lane, then checks session turns and FIFO order within each session.
Raising the backlog limits does not add workers or make individual jobs faster.

Set these deployment variables in Coolify or `.env`; Compose supplies the same
values without the `EOLAB_` prefix to the app and worker. Blank or invalid values
fail startup. Omitted values use the defaults below.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `EOLAB_PROCESSING_MAX_WAITING_JOBS` | 128 | Global queued jobs, excluding running/cancelling work |
| `EOLAB_PROCESSING_MAX_OWNER_WAITING_JOBS` | 32 | Queued jobs per browser session |
| `EOLAB_PROCESSING_MAX_JOB_RECORDS` | 4096 | Subscriber handles, including retained results and idempotency records |
| `EOLAB_PROCESSING_MAX_JOB_INPUT_BYTES` | 134217728 | Shared job inputs/summaries plus retained subscriber formula labels |
| `EOLAB_PROCESSING_MAX_STORED_BYTES` | 21474836480 | Artifact/scratch disk reservations, unchanged 20 GiB default |
| `EOLAB_PROCESSING_FREE_SPACE_FLOOR_BYTES` | 2147483648 | Physical free space to leave unused; zero disables the floor |
| `EOLAB_PROCESSING_EXECUTION_TIMEOUT_SECONDS` | 600 | Maximum duration of an executing job, excluding queue wait |
| `EOLAB_PROCESSING_RESULT_TTL_SECONDS` | 86400 | Result lifetime starting at completion |

Counts, durations and byte limits must be positive integers (the free-space
floor may be zero; durations cannot exceed one year). Pending input reservations
remain held after cancellation until cleanup succeeds. Small summaries and idempotency records remain bounded
by the record limit after input payloads are removed. Cleaned terminal records
expire after seven days; recent request keys remain recoverable even when new
admission is full. Deleting a result releases its input/artifact reservations
after cleanup, but does not immediately discard its idempotency record.

Submission returns distinct 429 error codes: `owner_queue_full` for the session's
waiting allowance, `queue_full` for the global backlog, `job_record_capacity` for
retained records, `job_input_capacity` for retained input bytes, and `storage_full`
for artifact reservations. These are finite overload limits, not an indication
that the one worker is merely busy. Existing accepted IDs/status/results and
cancellation routes are unchanged. A cached calculation still needs its own
bounded job record and download reservation.

At INFO level, app admission logs report waiting jobs/sessions, session allowance,
record/input usage and artifact reservations. Worker claim logs report remaining
backlog and that job's queue wait. They include no session identities or source
inputs. Existing calculation timing continues to separate queue and execution.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| App fails with a blank-setting error | Required Coolify variables, including title/subtitle and Jobs token; save and redeploy after editing. |
| Scan progress says status is unavailable | Use **Retry status check**. A failed status request does not mean the server scan stopped; do not submit another scan just to recover observation. |
| Raster reader or CRS rejection | Prepare a compatible georeferenced GeoTIFF upstream, rescan, and retry. |
| Rendering connectivity/authentication error | GeoServer health and matching deployment credentials. |
| Rendering configuration error | GeoServer initialization logs and workspace/layer resources; ambiguous partial resources are preserved for administrator inspection. |
| Polygon outline unavailable | Jobs logs, token, Catalog connection and read-only source mount; numeric analysis is independent of the outline. |
| Processing admission or disk-space refusal | Active jobs, result retention and free disk space; wait, cancel unnecessary work or delete finished exports. |
| Vector source changed | Rescan the vector and select it again; accepted jobs require unchanged original vector sources. |

## Build information

The application image targets Linux amd64 and Python 3.12. Pinned runtime wheels
and their hashes are in `deployment/application-runtime-requirements.txt`; build
tools are in `deployment/application-build-requirements.txt`.

The OGR Python bindings are the explicit source-build exception:
`deployment/application-gdal-requirements.txt` pins the GDAL 3.10.3 source archive
and SHA-256. A separate Docker stage builds it with the pinned Python/NumPy build
inputs and Debian `libgdal-dev=3.10.3+dfsg-1`; runtime uses the matching
`libgdal36` version. Compilers and development headers stay in the builder.
The build inventory records OGR's loaded GDAL version and the builder's compiler
and Debian package inventory. No PyArrow dependency is needed.

For local development, install GDAL 3.10.x with NumPy support using your native
package manager (for example, conda-forge), then install `.[dev]`. The batch
reader uses OGR's NumPy stream for selected attributes only; it excludes geometry,
holds at most one 4,096-row batch, and preserves the existing default styling.
The visited-row limit remains unchanged; the native stream may prefetch the
remainder of the final batch when checking whether more rows exist.

For a deployment report, retrieve the installed Python/native versions and build
inputs without starting the app (replace `IMAGE` with the image being inspected):

```sh
docker run --rm --network none --entrypoint cat IMAGE /app/build-environment.json
```

Keep the deployed image and its Git revision for rollback. Recorded input hashes
do not promise byte-identical images; OS package repositories can change between
builds.

## Operations notes

- Keep all secrets out of browser-facing configuration and logs.
- Verify the source mount from a running container with
  `grep ' /scan-source ' /proc/self/mountinfo`; the mount options should begin
  with `ro`.
- Use **Status** and **Rendering diagnostics** before increasing memory, CPU, or
  render concurrency.
- Deleting the volume named by `EOLAB_DATABASE_VOLUME_NAME` permanently deletes
  the Catalog. Do this only when intentionally creating a new empty Catalog.
- Catalog-vector selections read the original mounted source. The web application,
  Processing worker and Job service need the same read-only source mount.

## Immutable raster inputs

Treat every cataloged raster as immutable for its catalog lifetime. Do not overwrite
its data, grid, or embedded metadata in place. This also applies while jobs are
queued, executing, or recoverable, and across deployments that retain those jobs.
Publish changed data as a new asset with a new catalog identity; keep old sources
available until their jobs and recovery lifetimes have ended.

Raster operations authorize the catalog item and resolve its path inside the
configured mount. They do not compare filesystem timestamps or source signatures
to detect edits. Missing or unreadable sources still fail during resolution or
opening. Stored source identities remain in plans, provenance and cache keys;
changing those records is not a substitute for publishing a new asset. Vector
source checks, job ownership, cancellation and output checksum checks are unchanged.


## Named saved maps (API preview)

The first named-map release adds storage APIs under **saved maps** in `/docs`.
It does not yet add the publishing dialog or `/maps/{slug}` viewer pages.
Existing map links and browser autosave still work as before.

`POST /api/saved-maps` accepts `title`, `slug`, and `view`. The view is the existing
`eolab-map-view` version-one JSON document. Slugs are unique within this deployment,
1–80 lowercase letters/digits with single hyphens between words. Titles contain
1–160 characters. Include `X-EOLab-Saved-Maps: 1` when creating a map; this header
prevents cross-origin browser submissions and is not an authentication token.
Anyone with the map link name can read the stored record. Do not store secrets in it.

For a small API test, use this body in Swagger's POST endpoint, setting its header
field to `1` (choose a different slug if the example already exists):

```json
{
  "title": "Amazon priorities",
  "slug": "amazon-priorities-demo",
  "view": {
    "format": "eolab-map-view",
    "schemaVersion": 1,
    "viewer": {"version": "0.6.0", "origin": "https://core-areas.wwfus.science"},
    "createdAt": "2026-09-22T12:00:00.000Z",
    "viewport": {"center": {"latitude": -8, "longitude": -65}, "zoom": 5},
    "layers": []
  }
}
```

A successful POST returns **201**, the stored document plus its database `createdAt`,
and a `Location` header such as `/api/saved-maps/amazon-priorities-demo`.
GET that URL to retrieve it. POSTing the same slug returns **409** and preserves
the original. Missing maps return **404**, invalid input **422**, oversized uploads
**413**, and unavailable storage or full site capacity **503**.

Maps have no automatic expiry. Administrators can list and update them as described
below; public creation never overwrites an existing map. They live in `saved_maps.maps` in the existing
PostgreSQL database; include that schema in backups. Schema setup retries after
database outages without preventing other application routes from starting.

`EOLAB_SAVED_MAP_CAPACITY` controls the per-site record limit (default **1,000**,
passed to the app as `SAVED_MAP_CAPACITY`). Each map retains the existing saved-map
limits of **512 KiB** and **50 catalog layers**; the POST envelope allows **516 KiB**.
The default therefore bounds map documents to roughly 500 MiB before PostgreSQL
overhead. Raise the record limit and redeploy when more named maps are needed.
Database operations have a 3-second connection/lock wait and a 5-second statement
timeout. Stored references do not copy datasets, verify current catalog availability,
or grant data access. Existing capability APIs still resolve their own sources.

## Shared-layer administration

Set `EOLAB_ADMIN_PASSWORD` in Coolify's runtime environment and redeploy. Use a
private password of 16–256 printable ASCII characters without whitespace, for example
one generated by `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
The compose stack passes it only to the app as `ADMIN_PASSWORD`; it is not included
in browser configuration. Leave it blank to disable administration.

Open `/admin-eolab` on your site's **HTTPS** address. Sign in through the browser's
password prompt with username **admin** and that password. This is HTTP Basic
authentication: the browser may retain the login until its session is closed. Use a
private browser window on shared computers; changing the configured password and
redeploying invalidates the old credential.

### Editing published maps

The **Published maps** table on `/admin-eolab` provides **Open** and **Edit** links.
Edit opens the full map builder with the published configuration, without loading or
overwriting your browser's remembered map. Change layers, names, styles, basemap,
view, title or subtitle, then choose **Save changes for everyone**. The URL stays
fixed. **Cancel** returns to administration without saving the map draft.

**Delete** makes a published map unavailable after confirmation. **Undo delete**
restores the same URL and configuration. Both actions leave referenced shared layers
and polygons untouched. Deleted maps remain listed indefinitely, reserve their URL
names and still count toward saved-map capacity. There is no automatic purge.
An already-open visitor keeps its current view until reload. An editor opened before
deletion cannot save over the deleted or restored map without reloading.

Shared polygons are independent: changing which shared layers the map includes does
not replace their contributions. Edits made to actual shared polygons still follow
their normal save behavior and are not undone by cancelling a map draft.

Visitors see the updated configuration on their next open or reload. A failed save
keeps the draft available to retry. If any initial layers or settings failed to restore,
you can still save the current map. The editor explains that unavailable layers will
be omitted and the currently displayed settings will be published. If another administrator saved
first, your save returns a conflict rather than overwriting their changes.

The editor lives at `/admin-eolab/maps/{slug}/edit`. Authenticated
`GET /api/admin/saved-maps` lists map titles, URL names and `deletedAt` timestamps;
`GET /{slug}` loads an active map's draft;
`PUT /{slug}` replaces its configuration with a matching `revision`. The PUT has the
same document and upload limits as creation, requires `X-EOLab-Admin: 1`, and rejects
cross-origin writes and URL renaming. `DELETE /{slug}` hides a map and
`POST /{slug}/restore` restores it, using the same authentication and write protections.
Startup adds revision and deletion timestamp columns to existing maps.
No additional environment variables are required. Public viewers omit the copy-link
and restore-map buttons; the main map builder retains its publishing/reset controls.

### Managing shared layers

The independent page lists this deployment's active and deleted shared layers, their
contributor/polygon counts and share codes. **Copy code** copies an active layer's
invitation code. **Delete** asks for confirmation and blocks new joins, contributor
reads/writes and saved-map invitation reads. Requests authorized before deletion may
finish, and copies already loaded in a browser are not erased. Connected contributors
see the existing unavailable-layer message; normal retries can resume after restoration.
**Undo delete** restores the same layer, code, contributor ownership and polygons.

Deletion is reversible and retains the data indefinitely, including after a restart.
It does **not** free layer, membership or byte capacity. Permanent purge is not part
of this page. Include `shared_annotation_layers` in database backups. Startup adds
the deletion timestamp column without replacing existing records.

The page and `/api/admin/shared-layers` require administrator authentication.
Contributor cookies and share codes do not grant administrator access. The management
API supports GET to list, DELETE `/{id}` to delete and POST `/{id}/restore` to undo;
mutations additionally require `X-EOLab-Admin: 1` and same-origin browser requests.

## Simplified shared viewer (preview)

To try the recipient interface before named-map publishing is available, prepare
a map in the main app, choose **Copy map link**, and insert `?viewer=shared` before
the link's `#view=` fragment. For example, change `https://your-site/#view=...` to
`https://your-site/?viewer=shared#view=...`. Keep the complete fragment.

This mode keeps the included layers, navigation, basemaps, visibility, ordering,
legends, layer details, filters, personal styles, inspection, analysis and downloads.
Catalog browsing, scanning, operational diagnostics, experimental performance
tuning, creation/import/joining of unrelated annotation layers, and layer removal are omitted.
It is a presentation choice, not API authorization; the main app and APIs remain
available at their existing addresses.

**Restore shared map** reloads the opening link's layers, styles, filters, center
and zoom. It also retries layers that failed to load. **Copy map link** includes
personal presentation changes and keeps simplified mode. Private map autosave,
annotation contents and contributor credentials are left alone; this mode does
not restore private annotation layers. Included shared annotation layers show live
contributions. The first **Draw polygon** asks for a name and joins that layer;
returning contributors keep their identity and edit only their own polygons.
Restoring a map resets presentation without replacing contributions or membership.
Named `/maps/{slug}` pages will be added separately. The existing portable map format
does not yet save the basemap selection.

## Shared annotation layers

In **Map layers**, expand **Annotations**, choose **Create shared** and enter a layer
name and your name. **Share** on that layer copies its code. Other people choose
**Join**, enter the code and a name not already used in
that layer. Creators and joiners have the same controls; there is no facilitator
role or separate session panel.

Everyone sees one combined layer containing all contributors' polygons. Expand
the contributor arrow to see names, colors and polygon counts. **Draw polygon**
adds your own polygon. **Edit** opens your editable polygons and a read-only list
of other contributors' polygons. Under **Annotation style**, **Your polygon color**
changes the fill of all your existing and future polygons in that shared layer
for everyone. New members receive the least-used color from the default palette,
in palette order when tied; the picker accepts any custom color, including one
already used by someone else. Your colors in other shared layers are independent.
The layer legend identifies contributors by name and color. Whole-layer opacity,
fill opacity, outlines, labels, visibility and filters affect only your map.
Copying another layer's style does not change shared contributor colors.
Raster summaries use the combined layer and its current filter.

Finished edits and changes to names or notes are saved locally first, then shared
automatically. Unfinished drawings remain local. Removing a layer from your map
does not delete its shared contents or end your membership. Under **Shared layers**,
choose **Your layers**, then **Add to map** to reopen a layer without joining again.
The root app restores shared layers from its last remembered map, not from the full
list of memberships or cached polygons. Opening a published map does not add its
layers to the root map. Published maps restore only their configured layers.
Layers already included in an older remembered root map remain until removed;
the app does not guess which existing layers you meant to keep.
**Import GeoJSON** adds a private layer from a file. Their **Share** action creates a
new shared layer. **Export GeoJSON** saves the combined polygons with contributor
names and colors. EOLab exports mark this metadata with `eolabAnnotations: 1` and
per-feature `contributor` and `contributorColor` properties. Reimporting retains
these labels and colors, but never membership or editing rights. Sharing an import
in a new layer makes all its polygons your contribution, using your color there.
Map links include references to shared layers on this site, including their joining
codes. Anyone with the map link can view those layers and join to contribute.
Links contain neither polygon copies nor private editing credentials. Private,
unshared annotation layers are omitted. Version-two saved-map documents support
these references; version-one catalog-only maps still load. Shared layers from
another EOLab site are not opened.

Shared layers have no automatic expiration. They are stored in the existing
PostgreSQL database under `shared_annotation_layers`; back up that database to
preserve them. No new container is required; optional capacity settings are below. This version
adds a nullable color column to current memberships automatically; older members
without saved colors receive a stable palette color derived from their membership
ID until they choose another color. Existing polygons are not rewritten. This version
does not migrate or display the former `annotation_sessions` records; existing
local polygon copies remain available. Future administrative cleanup is tracked
separately.

There is no per-browser limit on how many shared layers someone can create or join.
These positive integer environment variables configure site-wide admission in Coolify;
redeploy after changing them:

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `EOLAB_SHARED_LAYER_CAPACITY` | 10000 | Retained shared layers, including soft-deleted layers |
| `EOLAB_SHARED_LAYER_CREATION_LIMIT` | 100 | Successful creations across all browsers in one time window |
| `EOLAB_SHARED_LAYER_CREATION_WINDOW_SECONDS` | 60 | Duration of that creation window in seconds |

The creation window starts with its first admitted creation. Its single PostgreSQL
counter is shared across app processes and survives restarts. A full window returns
429 with `Retry-After` and a message saying how many seconds to wait. Failed creations
do not consume the allowance. Changing browsers does not bypass this site-wide rate.
Joining an existing layer does not use creation capacity; the existing protection of
10 join attempts per browser per minute remains. Site capacity errors instead name
the setting to raise; deleting a layer does not free capacity because Undo retains it.
Direct app launches use the same variable names without the `EOLAB_` prefix.

Data limits remain 64 contributors per shared layer, 8 MiB per contributor, 32 MiB per shared layer and
256 MiB of shared polygon JSON per site. Each contributor can provide up to 500
polygons, with 2,000 vertices per polygon and no holes. Metadata refreshes every
five seconds and backs off to 30 seconds after failures. Only changed peer
contributions transfer polygon data. Interrupted uploads retry the same revision;
conflicting edits in another tab preserve the local copy and report the conflict.

Membership uses an automatically generated Secure, HttpOnly, same-site cookie;
only its hash is stored in the database. Serve the application over HTTPS. The
cookie is renewed for one year on use. Clearing cookies or using a different
browser loses access to editing the original contribution: a display name or
join code cannot restore those edit rights. A code permits joining and reading,
but all write authorization comes from the private browser credential. Different
EOLab sites have separate shared layers. Account-based recovery is not provided.
