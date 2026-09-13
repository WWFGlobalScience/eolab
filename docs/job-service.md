# Job service operation

The `jobs` Compose service executes diagnostic and vector-outline operations.
Map sampling outlines use this service; raster calculations and clips use the
separate Processing worker. Open `/api/jobs/docs` to try it.

## Configure a caller

For the Compose/Coolify stack, generate one private token with
`python -c "import secrets; print(secrets.token_urlsafe(32))"`.
Set **`EOLAB_JOBS_TOKEN`** to that value. Compose supplies it to the app as
`JOBS_TOKEN` and builds the Job service's `JOBS_CALLERS` entry for owner `eolab`
from the same value. Enter the token only once; no outline-specific token or
caller-map variable is needed in Coolify. Both containers reject a blank or
malformed token at startup.

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
Exception tracebacks are available in Docker or Coolify logs; the public response
remains generic. Treat operator logs as private diagnostics.
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

## Check the deployed service

Open `/api/jobs/docs` on the EOLab deployment for the current API and operation
schemas. `/api/jobs/health` reports readiness and whether jobs are accepted;
`/api/jobs/operations` lists installed operations. The events and artifact
endpoints are currently stubs returning 501.

The Compose service runs one worker with one CPU and 2 GiB of memory. Do not
increase replicas or Uvicorn workers: job state is currently in memory. Restarts
lose these jobs and results. This differs from raster calculations and clips,
which still use the durable Processing worker and its artifact volume.

## Map outlines

Outlines use `vector.outline.v1` through the Job service. Verify a filtered polygon
selection after deployment: it should display an outline and still allow raster
analysis. Jobs logs should show accepted work, a successful result read and cleanup.
The outline requests allow 10 seconds in the queue and 15 seconds execution.

If outlines fail, check the app and jobs container logs, the shared token, Catalog
connectivity at `http://stac-api:8080`, and the read-only `/scan-source` mount.
Both services must receive the same source mount and credential. A mismatch in
manually supplied credentials rejects outline requests. Missing or malformed app
credentials prevent startup.

There is no local outline fallback. Outline failure does not block numeric
analysis. Rollback requires a previous compatible release and its configuration,
not a mode switch.
