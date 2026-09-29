# Reading Processing job status

`GET /api/processing/jobs` recovers the current browser session's 50 most recent
jobs. It is a history listing, not a complete answer for an active raster stack.

`POST /api/processing/jobs/status` accepts a JSON body:

```json
{"jobIds": ["0123456789abcdef0123456789abcdef"]}
```

Send the existing session cookie and `X-EOLab-Processing: 1` header, using the
same origin. The endpoint reads statuses without submitting or changing work.
It accepts 1–100 IDs (32 lowercase hexadecimal characters each), with the usual
16 KiB request-body limit. Duplicate IDs are returned once.

The response contains `jobs`, using the same public job representation as
individual reads, and `unavailableJobIds`. Every distinct requested ID appears
in exactly one of those lists. Unknown IDs and other sessions' IDs are both
reported as unavailable. Deleted jobs still return their terminal status.
The response is private and cannot be cached. One owner-filtered database query
reads the requested subscriber records; this does not acquire the queue's
admission lock or run expiration cleanup.

The shared browser observer uses this endpoint for tracked and active jobs.
Sets larger than 100 use additional batches, without a raster-count limit or
individual fallback lookups. Recent history already shown remains visible;
idle refreshes recover recent history separately. New submissions and local
cancel/delete responses arriving during a read are preserved by job ID.

SSE remains a hint to fetch authoritative status, not the result itself. A hint
arriving during a refresh schedules one follow-up refresh. The two-second
fallback for active work remains in place for lost notifications or unavailable
SSE. An explicitly unavailable ID is removed from active tracking and reported
to the caller; unrelated completed results are still accepted.
