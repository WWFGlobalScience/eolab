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
- a Job service for optional vector map outlines; and
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
| `EOLAB_RASTER_PIXEL_READ_CONCURRENCY` | `2` | Concurrent interactive pixel reads |
| `EOLAB_RASTER_STATISTICS_READ_CONCURRENCY` | `1` | Concurrent bounded statistics reads |
| `EOLAB_SCAN_WORKER_COUNT` | `8` | Concurrent metadata workers |
| `EOLAB_SCAN_WRITER_COUNT` | `4` | Concurrent Catalog bulk writes |
| `EOLAB_SCAN_BATCH_SIZE` | `100` | Items in each bulk write |

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

Deploy the app and Processing worker together. Current Catalog-vector jobs require
worker claim protocol 5; older workers cannot claim them. Before rolling back to
code that cannot read these job formats, finish or cancel the affected jobs and
remove them through the supported API. Do not drop compatibility database triggers.
An old unsubmitted upload plan can report `legacy_selection_plan`; choose a Catalog
vector and make a new plan. Completed results retain their usual expiry.

A graceful worker stop interrupts its active job. After an abrupt worker failure,
the queue can wait about ten minutes for the previous execution deadline before
starting another attempt. Interrupted jobs require a new plan/job; partial results
are not resumed. App health and map exploration can remain available while
Processing reports its database or storage unavailable.

Job updates use same-origin server-sent events with a two-second polling fallback.
Allow streaming through the reverse proxy without buffering. Losing that stream
does not cancel accepted jobs. The stream reconnects periodically; polling still
recovers updates if streaming is unavailable.

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
