# Standalone Job service

The `jobs` Compose service executes installed diagnostic and vector-outline
operations. All map outline requests use this service;
raster and Processing workloads remain unchanged. Open `/api/jobs/docs` to try it.

## Configure a caller

For the Compose/Coolify stack, generate one private token with
`python -c "import secrets; print(secrets.token_urlsafe(32))"`.
Set **`EOLAB_JOBS_TOKEN`** to that value. Compose supplies it to the app as
`JOBS_TOKEN` and builds the Job service's `JOBS_CALLERS` entry for owner `eolab`
from the same value. Enter the token only once; no outline-specific token or
caller-map variable is needed in Coolify. Future EOLab operations can use this
same caller identity. Both containers reject a blank or malformed token at startup.

When upgrading an existing deployment, replace its separate caller-map and
outline-token settings with `EOLAB_JOBS_TOKEN`, then redeploy both services.
Caller names identify job ownership; restarting the current in-memory service
discards its old jobs, results and idempotency keys.

For standalone Docker or Python use outside this Compose stack, the Job service
still accepts `JOBS_CALLERS` directly as a JSON map of caller names to tokens:

```json
{"reviewer":"REPLACE_WITH_A_GENERATED_RANDOM_TOKEN"}
```

Each standalone caller's token must be a unique 32–256-character
URL-safe string; at most 32 named callers are supported. Empty configuration
leaves docs/health/discovery available but disables job access. Invalid
configuration fails startup without printing submitted secrets.

The Job service receives the entire caller map as one JSON-valued environment
variable. `load_settings()` parses it at startup and hashes each token
into `Settings.callers`. `create_app()` passes that same settings object to the
manager and retains it for authentication. This is not a mutable global registry
or an API users can edit; updating callers requires restarting the service.

In Swagger, click **Authorize** and paste just the token. Each caller owns only
its own jobs. Sharing a token means sharing ownership: this is not yet integrated
with browser sessions. Do not put an administrator token in frontend code. Use
HTTPS remotely. The service authenticates configured callers; it never accepts
an arbitrary owner field/header. It trusts those callers to select priorities.

## Try the diagnostic

Use **POST `/api/jobs`** with a fresh `Idempotency-Key` header for each new job,
such as `review-normal-1`:

```json
{
  "operation": "diagnostic.v1",
  "inputs": {"mode": "normal", "value": {"message": "hello", "number": 42}}
}
```

The **202** response contains a `jobId` and status `Location`. Poll
GET `/api/jobs/{job_id}` until `succeeded`, then GET
`/api/jobs/{job_id}/result`. Its `value` contains
`{"value":{"message":"hello","number":42}}`: the outer result field is generic;
the inner `value` is the diagnostic echo field. JSON objects, arrays, strings,
numbers, booleans and null are supported, capped at 8 KiB after serialization.

For a delay, use a new key and:

```json
{
  "operation": "diagnostic.v1",
  "inputs": {"mode": "delay", "seconds": 20, "value": "finished waiting"},
  "executionTimeoutSeconds": 30,
  "queueTimeoutSeconds": 60,
  "priority": 0
}
```

- Submit another normal job; it remains `queued` until the worker is free.
- POST `/{job_id}/cancel` on the delay. It reports `cancelling`, then `cancelled`
  after its child is stopped and reaped. The waiting job then runs.
- Use `executionTimeoutSeconds: 1` with the delay to observe `timed_out`.
- Keep a delay running and submit another job with `queueTimeoutSeconds: 1`.
  That queued job becomes `expired` without executing.
- Queue several jobs and PATCH one with `{"priority":10}`. Higher priority starts
  first; ties retain arrival order. Priority never interrupts running work.

For failure, submit with another new key:

```json
{"operation":"diagnostic.v1","inputs":{"mode":"exception"}}
```

This raises in the child; the job becomes `failed` with a safe error. Subsequent
jobs still run. No traceback, credentials or input values are returned in errors.
The runner writes exception tracebacks to the service's stderr (visible in Docker
or Coolify logs); the public response remains generic. Stderr is inherited rather
than captured in memory, and Compose rotates retained logs. Treat operator logs
as private diagnostics; installed operations should not put sensitive values in
exception messages. Traceback logging does not capture local variables.
`seconds` must be positive and at most 300 in delay mode, and zero/omitted in other
modes. The default mode is `normal`.

## Lifecycle and limits

Set these `EOLAB_JOBS_*` variables in Compose/Coolify (without `EOLAB_` for
standalone Python/Docker). Values are read once at startup; restart after editing.

| Deployment variable | Default |
|---|---:|
| `EOLAB_JOBS_QUEUE_CAPACITY` | 32 |
| `EOLAB_JOBS_RECORD_CAPACITY` | 128 |
| `EOLAB_JOBS_RETENTION_SECONDS` | 3600 |
| `EOLAB_JOBS_EXECUTION_TIMEOUT_SECONDS` | 60 |
| `EOLAB_JOBS_QUEUE_TIMEOUT_SECONDS` | 60 |
| `EOLAB_JOBS_MAX_TIMEOUT_SECONDS` | 300 |

Explicitly empty, malformed, nonfinite or out-of-range limits fail startup.
Record capacity must exceed queue capacity, and default timeouts must not exceed
the configured maximum. Request timeouts stay within that maximum. The diagnostic
operation independently caps its requested delay at 300 seconds.
The following are the default values, not fixed deployment settings:

Startup also imposes policy ceilings of 10,000 retained records and one day for
retention/deadlines. These guard against accidentally unbounded memory/scan work
and very long-lived state; they are not measured safe capacities for every
container. The record limit must leave room beyond the waiting queue for running
and retained finished work. Choose actual limits for the container's resources.

- One running job, **32 waiting**, **128 retained records** across all callers.
  Retained records include active jobs.
- Queue/execution deadlines separately default to **60 seconds**; clients may
  request 1–300 seconds. Execution includes process startup and result transfer.
  Queue expiry reconciliation has up to 100 ms granularity. Cleanup can finish
  after a deadline; capacity is never released before the child exits.
- Terminal records/results/idempotency keys expire together **one hour after
  completion**. DELETE removes terminal state earlier. Full capacity returns
  **503 / Retry-After: 1**; that is retry advice, not a capacity guarantee.
- State is **in memory per service process**. Restart loses all jobs, results and
  idempotency keys. There is no replay or automatic retry after restart. Run one
  service replica and one Uvicorn worker; the image explicitly sets `--workers 1`.
  Persistence and horizontal scaling are future work.
- Same caller, key and request return the retained job; changed inputs/settings
  return **409**. JSON object-key order is ignored. Delete, expiry or restart
  permits key reuse.
- Cancellation is immediate for queued work. Running cancellation publishes its
  final state only after process cleanup. Cancellation processed before completion
  publication wins; terminal jobs stay terminal.
- HTTP disconnect does not cancel an admitted job. Retry uncertain submission
  with the same idempotency key; cancel explicitly by job ID.
- Priorities trust configured callers; fairness is not promised. This is not an
  anonymous execution endpoint.
- Shutdown stops admission, cancels queued/running work and waits for cleanup.
  Hard container termination discards all ephemeral state.

## API

`API_VERSION` in `models.py` is the manually maintained Job service HTTP contract
version, shared by health and OpenAPI. It is independent of EOLab's package
version in `pyproject.toml` and the Git build revision; it does not select a route
or imply a separately deployed release. This contract moved from 0.1.0 stubs to
0.2.0 authenticated execution.

Job-specific endpoints require bearer authentication. Wrong-owner IDs return the
same **404** as missing jobs. Responses use `Cache-Control: no-store`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/jobs/health` | Public readiness, ephemeral mode, acceptsJobs |
| GET | `/api/jobs/operations` | Public installed-operation schemas |
| POST | `/api/jobs` | Submit/idempotent retry; 202 and status Location |
| GET | `/api/jobs` | Owned listing; status filter, limit 1–100, cursor |
| GET | `/api/jobs/{job_id}` | Authoritative current status |
| PATCH | `/api/jobs/{job_id}` | Change queued priority |
| POST | `/api/jobs/{job_id}/cancel` | Request cancellation |
| GET | `/api/jobs/{job_id}/result` | Successful inline JSON; 409 otherwise |
| DELETE | `/api/jobs/{job_id}` | Delete terminal state/result/key; 204 |
| GET | `/api/jobs/{job_id}/events` | Owned-job check then 501; no SSE yet |
| GET | `/api/jobs/{job_id}/artifacts/{artifact_id}` | Owned-job check then 501 |
| GET | `/api/jobs/docs` | Public Swagger UI |
| GET | `/api/jobs/openapi.json` | Public OpenAPI 0.2.0 |

Listing is admission-ordered. Cursors refer to the last retained owned record and
become invalid after it is deleted/expires. Pages reflect current state, not a
frozen snapshot. No artifact files exist yet. The outline adapter uses bounded
status polling; notification delivery will be designed separately.

Requests and subprocess inputs are bounded to 64 KiB before decoding;
subprocess results are bounded to 512 KiB.
The proxy retains its 1 MiB response bound and 10-second timeout: requests return
state without holding HTTP connections through execution. Errors use the existing
`{"error":{"code":"...","message":"..."}}` envelope.

## Ownership and architecture

**Owner:** `services/jobs/job_service`. `app.py` owns HTTP/authentication;
`manager.py` owns ephemeral state/admission/priority/lifecycle; `executor.py`
owns subprocess cleanup and transport; `operations_registry.py` registers the diagnostic, whose algorithm and
input/result models live together in `operations/diagnostic.py`. `runner.py` is a private child entry point, not an
API accepting module names or paths.

**Used by:** REST/Swagger through EOLab's proxy. **Depends on:** the existing web
stack and Python standard-library processes. **Coordinates with:** Compose and
the existing proxy. That HTTP edge now carries Authorization to the fixed
`http://jobs:8080` endpoint. Cookies/arbitrary identity headers are not forwarded.
The outline adapter uses the vector-to-Jobs execution edge. Registration
imports the installed domain operation, which reuses existing source/outline
functions and GIS dependencies. The scheduler never imports application services.
No database connection is added; raster/Processing execution remains unchanged.

The first version uses a fresh child per job for isolation/hard stopping; it does
not prewarm native processes. Only installed code runs. Child environments omit
caller credentials and other service secrets.
The runner uses an absolute interpreter path, a fixed module directory and binary
JSON, so PATH, PYTHONPATH and locale settings are not needed. Only Windows OS
locations and the bytecode-write setting are retained. This avoids casually
exposing caller/database credentials to algorithms; it is not a security sandbox.
Neither installed operation spawns descendant processes. Outline work preserves
source authorization and the existing 2 GiB native address-space ceiling. Docker
is non-root, read-only, capability-dropped, one CPU and 2 GiB, with only the
read-only source bind. Future operations that spawn children need process-tree
handling before installation.

## Local verification

Set `JOBS_CALLERS`, then run:

```sh
python -m uvicorn job_service.app:create_app --factory --app-dir services/jobs --host 127.0.0.1 --port 8082 --workers 1
```

Or, with Docker and the same environment variable:

```sh
docker build --platform linux/amd64 -f services/jobs/Dockerfile -t eolab-jobs:diagnostic .
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 2g --mount type=bind,src=/your/source,dst=/scan-source,readonly --env JOBS_CALLERS -p 127.0.0.1:8082:8080 eolab-jobs:diagnostic
```

Open http://127.0.0.1:8082/api/jobs/docs and authorize. To smoke-test HTTP, set
`JOBS_SMOKE_TOKEN` to one configured token and run
`python services/jobs/smoke.py http://127.0.0.1:8082`.

```sh
python -m pytest tests/test_job_service.py tests/test_job_lifecycle.py
python -m pytest tests/test_compose_configuration.py tests/test_application_boundaries.py
```

Tests cover real subprocesses, API/proxy composition, ownership, priority/FIFO,
cancellation, deadlines, failure recovery and retention. The existing build
workflow smoke-tests the container with temporary credentials. No new workflow
or production deployment is introduced.


## Vector map outlines

`vector.outline.v1` accepts `{ "selection": <CatalogSelection> }`. Its result is
`{ "geometry": <approximate FeatureCollection>, "bbox": [west,south,east,north] }`.
The operation resolves the immutable descriptor against the internal Catalog,
checks the mounted source signature, runs the bounded outline algorithm,
then rechecks source/Catalog identity. Inputs never carry paths, URLs or
complete geometry. The scheduler knows only the registered schema/function.

Before upgrading, set the single `EOLAB_JOBS_TOKEN` described above, then restart
both services. Compose wires it to both the app and the `eolab` Jobs caller.
The app validates its internal `JOBS_TOKEN` setting and rejects an
absent, blank or malformed token at startup (32–256 URL-safe characters required).
It does not contact Jobs during startup; a credential mismatch in a manually
configured deployment fails outline requests through Jobs authentication.
This is a server credential,
never browser settings.

The execution-mode switch and local outline process have been removed. A Jobs
failure is an outline failure, with no local fallback. Verify a filtered polygon
outline in the deployed app before accepting the rollout. Rollback means deploying
the previous compatible release and its configuration, not changing a mode switch.

Only optional outline calls change: local selection, raster analysis and durable
Processing remain independent. The adapter uses priority -10, 10 seconds waiting,
15 seconds execution and bounded 100 ms status polling while the outline request
is connected. This is temporary status observation using the existing Jobs API;
no new SSE lifecycle is added. Cancellation recovers uncertain submissions with
the same idempotency key before cancelling; terminal records are deleted. A
cleanup outage is logged and Jobs deadlines/retention remain the backstop.

The outline adapter composes the reusable Python `eolab_jobs.client.JobsClient`
for bounded transport, observation and cancellation. It retains outline-specific
inputs, priority, deadlines, result validation and error translation. The client
imports no Jobs server, scheduler, operation registry or GIS code. The existing
browser proxy still forwards individual requests; it does not own their job
lifetimes and must not cancel/delete them when forwarding completes.
See [Python Jobs client](jobs-client.md) for retention policy and diagnostic tests.

The image now includes existing application modules and the reviewed application
runtime wheels, including GIS libraries; no application server, GeoServer client
or database connection is started by the operation. Reusing that resolution keeps
packaging simple but includes some dependencies this operation does not use.
The fixed Compose contracts are `http://stac-api:8080` and `/scan-source`, mounted
read-only and verified by the existing startup guard. No source data is copied.
Jobs health/diagnostic work does not require the Catalog to be online. The service
gets 2 GiB rather than the diagnostic image's 256 MiB; it still executes one child
at a time. The application two-child selection budget remains, so deployments
can have two local vector selections plus one Jobs operation.

Requests remain limited to 64 KiB. Inline process results are bounded at 512 KiB,
allowing the existing 256 KiB compact GeoJSON display budget plus JSON spacing and
envelope. Retained record count is unchanged; operators must budget memory for
larger retained values if increasing it. Outline output is presentation-only and
never substitutes for the exact original-source masks used in calculations.
