# Raster pixels and histograms

The pixel picker reads the raster value at a point. Histograms describe a
distribution over the selected area. Both use Catalog source data, independently
of map colors or whether GeoServer can draw the raster. Transparent valid pixels
still count as data.

One map click can return both vector features and raster information. The click
summary reports these separately and lets you switch between them. Automatic
histograms use the top two visible rasters. Histogram results describe the sampling
area, not just the clicked pixel or the features returned by feature inspection.

## Choose an area

Use **Sampling area** to choose a map box or a filtered
[Catalog vector](vector-sampling.md). Use **Whole raster** for a global 1D
distribution or **Whole overlap** for a [2D comparison](bivariate-raster.md).
Polygon masks preserve holes and count overlapping features once.

The map box defaults to 200 km. Its slider and integer-kilometer input allow up
to 14,152 km. This is a geometry limit: position-specific pole and date-line
checks still apply. An unsupported selection leaves the previous box intact.
Resizing retains the selected center.

## Exact versus sampled results

A large sampling area does not mean every source pixel is read. EOLab reports
which of these methods produced the histogram:

- **Exact bounded distribution:** reads the selected source envelope when its
  edges are at most 512 pixels, it intersects at most 1,024 native blocks, and
  decoded values plus validity need at most 64 MiB.
- **Approximate sampled distribution:** uses one center observation per grid cell,
  with at most 127 cells along the longest edge. It prefers a suitable embedded
  COG overview. Without one, reading is limited to 16,129 native blocks and 9 GiB
  cumulative decoded source work; only a bounded block is retained at a time.

These limits are fixed. A request that cannot fit them fails instead of starting
an unrestricted read. Histogram polygon masks use all-touched inclusion on the
chosen grid. A sampled distribution may miss small or rare features and its
extremes need not be the full raster's extremes. Use native
[raster calculations](raster-calculations.md) for counts, sums and ground area.

## Reading the chart

The 1D histogram has 64 bins. The x-axis shows raster values; the y-axis shows
each bin's percentage of **valid sampled pixels**. Hover details give bin bounds
and counts. Each chart has its own percentage scale, so equal bar heights on
different charts do not necessarily represent equal percentages.

NoData and non-finite values are excluded, not treated as zero. Units are shown
only when provided by the raster's band metadata. Very large or small values may
use scientific notation or a labeled axis offset. Suggested style ranges use
the sampled 5th, 50th and 95th percentiles; styling does not alter source values.

The analysis reader requires a supported single numeric band, valid CRS and
affine georeferencing, and native block edges no larger than 1,024 pixels.
Georeferencing, nodata and overviews must be embedded in the GeoTIFF. External
masks/overviews/auxiliary files, alpha masks and per-dataset input masks are not
accepted. Prepare a self-contained source upstream if those checks fail.

## Busy or unavailable results

Moving or changing a selection cancels obsolete requests. An already-running
native read may finish its current block before stopping. Capacity conflicts
retry briefly; a persistent error offers **Retry**. Cataloged rasters are immutable;
analysis does not poll file metadata for changes. Failure to draw the optional vector outline does
not invalidate its analysis area.
