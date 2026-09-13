# Comparing two rasters

The 2D histogram compares the top two visible single-band rasters. The top raster
starts as X and the next as Y. Axis labels identify both sources. Use **Swap X/Y**
to reverse them, and choose a box, filtered [vector area](vector-sampling.md), or
the whole overlap.

## What is paired

X defines the reference grid. Each X cell center is transformed to Y's grid and
paired with the containing Y cell (nearest-neighbor sampling). NoData,
non-finite values, and positions outside either source or the selected polygon
are excluded. Different source grids can therefore give different positions and
counts after swapping axes.

The sampling grid has at most 127 cells on its longest edge. Each raster uses a
suitable embedded overview where possible and otherwise a bounded native-block
read, as described in [raster histograms](raster-analysis.md). This is a sampled
comparison, not full-resolution raster arithmetic.

The chart groups valid pairs into 32 × 32 bins. Hover a cell for the two value
ranges, paired count and percentage. The horizontal and vertical histograms are
the marginal distributions of those same valid pairs; they can differ from
standalone 1D histograms because a pair is excluded when either raster is missing.
Hover guides connect the cells and marginals. Keyboard focus also exposes cell
details.

## Colors and density

The coordinated palette supplies the X and Y colors used by the chart and map.
Palette definitions originate in the
[ESOS-C data viewer](https://github.com/springinnovate/esos-c-dataviewer), under
the [Apache License 2.0](https://github.com/springinnovate/esos-c-dataviewer/blob/main/LICENSE).

The map combines the two raster colors additively. Finite color precision and
channel clipping mean that different value pairs can have the same color; inspect
the reported values rather than treating a color as a unique numeric pair.
Histogram density also changes cell inset, saturation and lightness. Marginal
histograms use their respective axis colors.

Use the chart's raster style controls to set each raster's lower, middle and upper
range separately. Changing these colors or ranges does not change the sampled
values, bin counts or missing-data rules. Paired analysis can still work when
the map tiles are unavailable.
