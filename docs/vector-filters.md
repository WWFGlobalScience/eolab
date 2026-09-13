# Vector filters and numeric classes

Each retained vector layer has a dedicated **Filter** panel. Add up to 12
field/comparison/value conditions, then choose Match all (AND) or Match any (OR).
Complete edits apply after 450 ms. Invalid drafts show a message and leave the
previous applied filter in use. Disable preserves rules; Clear removes them.
The layer row and the map's top controls link back to the filter. With map tools
open, the summary appears above the dock so the panel cannot cover it. Active counts
describe the whole layer, never the current viewport or a sampled estimate.

The initial operators are numeric comparisons, case-sensitive text equality,
inequality and literal substring matching, Boolean equality/inequality, ISO
calendar-date comparisons for Catalog `date` columns, and explicit missing/not
missing checks. Other field types offer missing checks only. Nonmissing
comparisons exclude nulls, including inequality. A text value is a literal, not
an expression, wildcard pattern, regular expression, SQL fragment, or function.
Nested condition groups and a raw expression editor are not supported.

Filters affect rendered geometry, labels, GetFeatureInfo, and highlights. Changing
the rendering identity invalidates the existing feature sample and its plots;
the next click produces plots from the filtered sample. Filtering preserves the
applied style, class boundaries, and label configuration. Saved maps retain
enabled or disabled rules separately from style, and reauthorize them against the
current Catalog on restore. Style copy/paste never copies a filter. A failed
filter restore skips that layer with an explanation rather than displaying it
unfiltered.

Counts describe the complete layer, not the viewport. Very large layers can show
**Count unavailable** while their display filter remains applied; partial counts
are not shown as complete counts. Filtering for analysis is a separate explicit
selection under [Sampling area](vector-sampling.md).

## Interpreting numeric classes

Numeric styling reads up to 100,000 features and reports whether the read was
complete. Class suggestions use finite values from that read:

- **Equal interval** divides the observed minimum-to-maximum span equally.
- **Quantile** uses nearest-rank breaks to group observations by their rank.
- **Percentile interval** divides the nearest-rank 5th-to-95th percentile span
  equally, retaining the tails in the first and last classes.

Repeated breaks collapse, so fewer classes than requested may be returned.
Internal upper bounds are inclusive and the next class's lower bound is exclusive.
The first and last classes extend beyond the observed range; missing values are
styled separately. Editing a break hides the old class counts because they no
longer describe the custom thresholds. Styles change presentation, not values or
the analysis selection.
