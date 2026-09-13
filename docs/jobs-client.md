# Python Jobs client

`eolab_jobs.client.JobsClient` handles the existing Job service HTTP protocol.
It is shipped in the existing EOLab wheel through `src` package discovery; no new
distribution, dependency, service or build tool is needed. Importing it loads
HTTPX/Pydantic and standard Python modules, not application services, the Jobs
server, an operation registry or GIS libraries.

The application composition root supplies a dedicated `httpx2.AsyncClient`, the
private caller token. Composition closes
the HTTP pool after its consumers finish. The client owns no scheduler, cache,
persistent store or background observer. The `JOBS_URL` module constant names the
internal Compose endpoint `http://jobs:8080/api/jobs`; credentials never become
operation inputs. Redirects are not followed, even when enabled on the HTTP pool.

## Submit and wait

```python
import asyncio
import getpass
import httpx2
from eolab_jobs.client import JobsClient

async def example(token: str) -> None:
    async with httpx2.AsyncClient(timeout=5, trust_env=False) as http:
        jobs = JobsClient(http, token)
        result = await jobs.run(
            {"operation": "diagnostic.v1", "inputs": {"value": "hello"}},
            timeout_seconds=30,
            delete_on_completion=False,
        )
        print(result.jobId, result.value)
        # Retained until explicitly deleted, expiry, or service restart.
        print(await jobs.result(result.jobId))
        await jobs.delete(result.jobId)

asyncio.run(example(getpass.getpass("Jobs caller token: ")))
```

`run` takes the service's existing submission fields: `operation`, `inputs`,
optional `priority`, `executionTimeoutSeconds` and `queueTimeoutSeconds`. The
service validates those fields and the operation schema. A client result exposes
`jobId` and `value`; callers validate `value` against their own operation contract.
Snapshot projections expose `jobId`, `status`, and `error`, ignoring other server
metadata. These are client projections, not replacements for server wire models.

The required `timeout_seconds` bounds submission, observation and retrieval;
cleanup has a fixed 5-second budget (`CLEANUP_SECONDS`). This does not replace
server queue/execution deadlines. Status checks keep the previous 100 ms cadence.
Requests are bounded at 64 KiB and decoded responses at 512 KiB. UUID validation,
response identity checks and JSON/schema checks happen at the client boundary.

`delete_on_completion` is required so retention is a deliberate choice:

- `True`: delete terminal records after success, failure, timeout or cancellation
  where cleanup succeeds. Outlines use this mode.
- `False`: retain terminal records, including failures/cancellations, for later
  status/result retrieval. Server retention and restart behavior still apply.

In both modes, cancelling the awaiting task or exceeding its wait deadline
requests cancellation of unfinished server work. Retention does not mean detached
execution. If later recovery matters, supply and retain your own `idempotency_key`
and identical payload; repeating `submit` can recover the job ID while its record
exists. Deleting or expiring a record releases its key too, so reusing it afterward
may create new work.

Submission bytes are frozen before the first await. A lost admission response is
recovered during cleanup with those same bytes and key, avoiding a second job.
Cleanup is shielded from caller cancellation and awaited within its budget. If
Jobs is unavailable, cleanup emits a safe warning; server deadlines/retention
remain the backstop. It cannot promise cancellation acknowledgement during an
outage. No automatic successful-result retry is performed.

## Detached work and errors

For a caller that owns its own lifecycle, use:

| Method | Behavior |
| --- | --- |
| `submit(payload, idempotency_key=...)` | Admit work without automatic waiting or cleanup. |
| `status(job_id)` | Fetch authoritative state. |
| `result(job_id)` | Fetch successful inline output without deletion. |
| `cancel(job_id)` | Request cancellation; `cancelling` is not yet process-exit acknowledgement. |
| `delete(job_id)` | Delete a terminal record/result/key; active jobs must be cancelled first. |

These methods preserve HTTP errors, including authentication, capacity, ownership,
conflict and result-not-ready failures. HTTPX handles individual request timeouts;
low-level callers own their overall deadlines and cleanup.

`run` raises `JobFailed` for unsuccessful terminal states; its `snapshot` contains
the status and failure details. HTTP failures remain `httpx2.HTTPError`, malformed
or oversized responses raise `ValueError`, and wait timeout/cancellation retain
Python's `TimeoutError`/`asyncio.CancelledError`. The vector adapter translates
these into its existing map-outline error and keeps numeric analysis independent.

## Diagnostic verification

`tests/test_jobs_client.py` exercises `diagnostic.v1` in normal, delay and
exception modes against the real Jobs HTTP application and native executor.
It also verifies cancellation, deadlines, owner isolation and result retention.
For manual service checks, use the existing `/api/jobs/docs` interface; no
standalone example program is maintained.

## Architectural scope

**Owner:** reusable Jobs protocol/lifecycle client. **Used by:** vector outlines
and diagnostic integration tests. **Depends on:** the existing Jobs API and its
HTTP pool. **Coordinates with:** composition for credentials and pool shutdown.
Issue #410 explicitly approves extraction with one production caller. The vector
adapter retains domain policy. No service imports the client to schedule itself,
and the client has no knowledge of vector/raster/rendering/browser siblings.
Application outline requests use this Jobs client exclusively; selection summaries
retain their independent local execution. See [Job service](job-service.md) for
required caller credentials and deployment rollback.
