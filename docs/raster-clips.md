# Raster clips and downloads

Download one single-band numeric GeoTIFF clipped to an explicit sampling box or
filtered [vector selection](vector-sampling.md). The clip keeps the source's
**native resolution, CRS, pixel grid and datatype**. Map colors and histogram
sampling resolution do not change the exported pixels. Reprojection and implicit
whole-raster exports are not offered.

## Browser workflow

Use **Download clip** on a raster in Map layers or an individual 1D histogram.
The 2D histogram has separate **Download X clip** and **Download Y clip** actions.
The **Downloads** toolbar/dock button stays accessible while other tools are open.

Downloads captures the explicit selected histogram area when opened. The 1D and
2D selections remain distinct; whole-raster and whole-overlap sampling do not
become export areas. Choose a box or a filtered Catalog vector in Sampling area.
**Choose sampling area** opens the existing area controls. Reopen Downloads to capture a changed histogram selection. Histogram
results need not be ready or successful before reviewing a clip.

**Review clip** reads metadata and presents the source, geographic area, native
CRS/pixel size, dimensions, datatype, and estimated uncompressed size.
**Create clip** accepts this fixed intent. Later map/filter changes do not change accepted work.
The original Catalog sources must remain available and unchanged until execution
and publication finish. Job cards show measured block progress and named file
preparation phases, plus cancel, download, provenance, delete, size, and expiry.
Downloads go directly through the browser, without a JavaScript Blob buffer.

Owned jobs recover through the session cookie after reload. The per-tab session
storage contains only an unconfirmed plan ID, idempotency key, and display label;
it is saved before dispatch. Reload or **Recover submission** retries that same
request. No cookie, geometry, result file, or processing job is placed in a shared
map link. Disabled session storage prevents submission with a clear explanation.
The existing `/docs#/processing` API page also remains available.

## Raster correctness

The worker reauthorizes the Catalog Item at execution and checks the full scanner
signature (inode, size, mtime, ctime) around native reads and before publication.
Existing signed-source restrictions remain: one supported numeric band, bounded
native blocks, embedded georeferencing and nodata, and no unsigned sidecars,
alpha, or input dataset masks. Supported datatypes are uint8, uint16, int16,
int32, float32, and float64, matching the neutral reader contract.

Bounds edges and polygon selection polygon edges are densified and transformed to the source
CRS using the shared bounded-window mechanisms. The output is an integer native
window with the existing conservative one-pixel envelope padding. Each intersecting
native source block is decoded once, intersected with the window, masked, and
written. Polygon components are unioned; holes are preserved unless another
component covers them. The mask includes cells touched by the selected geometry; numeric summaries instead use cell centers.
The export does not use histogram overviews, percentiles, or approximate grids.

The output preserves valid zero, signed nodata, scale, offset, units, band
description, and supported descriptive metadata. Non-finite data and cells
outside the selected geometry are invalid. An internal mask represents validity
without inventing a nodata value or promoting the datatype. Full-source statistics
are not copied. A lossless DEFLATE COG with nearest-neighbor overviews is reopened
to verify COG layout, native grid/type/CRS/nodata, overviews, and validity count;
then it is checksummed. TIFF tags and the separate JSON document record operation,
Catalog source/signature, geometry, grid, inclusion rule, and result provenance.
No private source or artifact paths are included.

Exported internal-mask COGs are downloads, not automatically published Catalog
assets. Future re-ingestion of those files needs an explicit input-mask policy;
this feature does not weaken the existing source reader to enable that path.

## Storage and limits

Results expire 24 hours after completion. Keep the same browser session to inspect,
cancel, delete or download your jobs; knowing a job ID is not sufficient.
Downloads support resume. An accepted job can continue after the browser closes;
recover it through History & exports. A failed job does not expose a partial TIFF.

| Resource | Limit |
| --- | --- |
| Active native clip jobs | 1 globally, including overlapping worker deployments |
| Waiting jobs | 10 globally; 2 unfinished per browser session |
| Metadata planning | 1 child globally; 15-second inclusive deadline |
| Retained plans | 5 per session, 50 globally, 5-minute lifetime |
| Native output estimate, including validity | 1 GiB |
| Decoded native source work | 4 GiB; at most 65,536 blocks; existing 64 MiB per-block ceiling |
| Retained feature / projected-coordinate buffer | 500,000 positions |
| Clip execution and finalization | 10 minutes |
| Temporary result/scratch reservations | 20 GiB globally |
| Physical free-space floor | 2 GiB, checked again before execution |
| Result lifetime | 24 hours after completion |
| Transfers | 4 per result, 64 globally; renewable 120-second leases; 1-hour response ceiling |

Operators must preserve the separate Processing artifact volume and enough free
disk space. The 20 GiB reservation budget is an admission limit, not a disk quota
or allocated filesystem size. New jobs are refused when capacity is unavailable;
a filesystem-full error fails the job instead of publishing a partial file.
Active downloads delay cleanup within bounded transfer leases. See
[deployment and operations](deployment-and-operations.md) for mounts and recovery.

For scripted use, the deployed application's `/docs#/processing` page provides
request schemas. Use HTTPS, retain the session cookie and retry uncertain
submissions with the same plan/request key to avoid duplicate jobs. Cookie jars
grant access to private results and must not be shared or committed.
