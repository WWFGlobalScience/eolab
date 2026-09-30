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

## Measuring request delivery

Processing JSON responses include a random `X-EOLab-Request-Id` and the same ID
as a `requestId` Server-Timing description. This is a diagnostic identity, not a
job ID or credential. Browser Resource Timing entries are matched by this ID,
even when several requests use the same URL. Missing or evicted entries are
reported as unavailable; diagnostics never delay result delivery to await them.

The report includes browser time before request sending, request-to-first-byte,
download, and download-finished-to-JSON-received intervals. DNS, connection, and
TLS are overlapping details, not additional stages. The last interval includes
parsing and browser scheduling; the first-byte interval includes server work and
proxy/network transit. These measurements do not isolate Cloudflare's internals.

Application middleware adds `appToHeaders`, `beforeRoute`, `afterRoute`, and
`eventLoopLag` durations. The route's existing `processing` timer includes input
reading, validation, application work, and serialization. The surrounding
intervals start only after ASGI invocation; socket/Uvicorn waiting before that
remains unmeasured. The lag metric samples lateness of a 50-ms timer during the
request and is not an additive stage or a CPU profiler.

After response sending, the application's `processing_http` log records that
request ID, route template, status, total application duration, cumulative await
time in ASGI `send`, headers-to-last-body duration, and whether sending completed.
No bodies, query strings, cookies, or raw source paths are logged. Streams and
downloads bypass this instrumentation; request probes are cancelled on errors
and cancellation. Container logs use the existing rotation limits.

Final send time cannot be included in already-sent headers. Match the trace ID
in the report to the application log in Coolify. ASGI handoff is not proof of
browser receipt. A reverse proxy's access-log durations, where available, can
narrow the remaining external interval; this repository does not configure
Coolify's shared proxy or Cloudflare. Never subtract timestamps from separate
machines: compare durations and correlate request IDs instead.
