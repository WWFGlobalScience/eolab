# EOLab

EOLab is a shared browser workspace for exploring, mapping and analyzing
geospatial data. Search a Catalog, bring your own polygons, compare maps through
time, calculate statistics and run models without installing a desktop GIS.

It is especially useful for workshops and collaborative analysis. A facilitator
can publish the participants' datasets once, and everyone can explore the same
material in real time without installing a desktop GIS or creating an account.

![Green aboveground-biomass shading with orange corridor polygons over Sabah, alongside the map's layers and legend](docs/images/eolab-biomass-corridors.jpg)

*Combine a biomass map with corridor polygons to explore the landscape around
the places you are studying.*

## What can you do with EOLab

**Find data:** Find shared raster, vector and temporal datasets in a searchable
Catalog built on the SpatioTemporal Asset Catalog (STAC) standard.

**Explore data:** Combine layers and change colors, ranges, transparency,
categories and labels to make patterns easier to see. Click to inspect features
and pixels, and compare distributions with histograms. Calculate values, areas
and custom formulas for a box or selected polygons, compare rasters in charts,
and download the results.

**Slice through time:** Explore data time cubes by choosing individual
observations or summarizing a period into a map. Calculate a time series of the
mean, maximum or standard deviation within a custom area, such as a watershed
defined by an uploaded polygon.

**Clip and download data:** Extract raster data for a sampling box or selected
polygons and download a GeoTIFF that preserves the original resolution and
values, ready for further analysis.

**Estimate downstream beneficiaries:** Use a population dataset to estimate how
many people live downstream of selected areas, such as proposed restoration
sites. Map the downstream coverage and summarize the population within it.

**Assess habitat condition:** Compare observed habitat conditions with those
expected from selected reference sites. Map their similarity to identify places
whose condition differs from comparable reference areas.

**Collaborate with others:** Upload and filter project boundaries, or draw
polygons with names and notes. Publish a map link so others can explore your
layers, and use shared polygon layers to collect everyone's contributions.

## A quick tour

### Find a dataset

Use **Catalog search** to enter any part of a filename, path, description, or
date. Ordinary words can be combined with these filters:

- `type:raster` — only raster datasets
- `type:vector` — only vector datasets
- `type:temporal` — datasets containing observations over time
- `format:cog` — only Cloud Optimized GeoTIFFs
- `date:2020`, `date:2020-06`, or `date:2020-06-15` — a year, month, or day
- `date:2020-01..2020-03` — an inclusive date range

For example, `resistance type:raster date:2020` finds raster records containing
“resistance” from 2020. Suggestions appear while you type. Clear the search to
show the complete Catalog, or use **Surprise me** to open a random matching
item.

Each result shows the source filename and the actions you are most likely to
need:

- **Add to map** displays the dataset.
- **More details** opens its Catalog metadata.

After an item is on the map, the same row also offers **Remove**, **Zoom to**,
and **Style** without making you leave the search results.

### Build the map

Open **Map layers** to see the current stack. The first layer in the list draws
on top. Drag a row by its handle to reorder it, or use the keyboard controls on
the same handle.

Use a layer's checkbox to show or hide it, **Zoom to** to find it, and the color
swatch to open its legend. **Add another view** gives the same dataset another
independent set of display choices. **Copy style** and **Paste style** help keep
comparable layers consistent.

Open **Style** to bring out the pattern you care about:

- For continuous rasters, choose a palette and adjust its low, middle and high
  values, colors and transparency. A percentile stretch uses the sampled
  distribution to spread colors across a useful range instead of letting a few
  extreme values dominate.
- For categorical rasters, give classes such as land-cover types their own
  names and colors. Category tables can be imported from CSV.
- For vectors, use one symbol, categories, or numeric classes with editable
  breaks. Turn on **Show labels** when names or values help explain the map.

![Country polygons colored from yellow to red by area, beside their numeric-class styling controls](docs/images/eolab-dynamic-styling.jpg)

*Choose class breaks and colors to reveal differences between polygons.
Styling changes the appearance of your map, leaving the original values intact.*

### Explore what is under the pointer

A normal click explores the visible data at that location. Dragging still pans
the map.

For visible vectors, EOLab highlights the features under the click and opens
their attributes in **Feature inspector**. Use **Previous** and **Next** when
several features overlap. Clicking empty space does not open an empty result.

For rasters, inspect the value at the clicked pixel or open **Histograms** in
**1D** mode to see how values are distributed within a sampling box. Move or
resize the box to explore another area. Each visible raster has its own chart.

Use **Axes & scale** to inspect a useful range or switch to logarithmic axes
when values span several orders of magnitude. These controls change the chart
display. They do not change the sampled data or the map's colors. Categorical
rasters show named classes and their ground areas when a matching sample is
available.

![A magenta drought-severity map over Asia with a blue sampling box and its one-dimensional histogram](docs/images/eolab-histograms.jpg)

*Explore July 2022 drought-severity values across Asia. The box identifies the
sampled area; the histogram shows which values are common there.*

### Compare two rasters

Choose **2D** in Histograms to compare the top two visible continuous rasters.
Map layers marks them **X** and **Y**. Reorder the rasters to choose the pair,
or swap the axes in the analysis panel. Other layers stay in Map layers but are
temporarily hidden while the comparison is active.

The joint histogram shows which pairs of values occur together within the same
sampling area. A coordinated map palette combines both rasters in one color,
helping you locate those combinations on the map.

![A blue-and-rose bivariate map of Sabah beside a joint histogram of human modification and aboveground biomass, with distributions along both axes](docs/images/eolab-bivariate.jpg)

*Compare human modification and biomass in the same 100 km sampling window.
Larger squares show more common combinations; the outer histograms
show each raster's distribution.*

Adjust the palette and each raster's color range to explore the comparison.
Returning to **1D** restores the individual raster styles. Use **Raster
statistics** when you need calculated area totals or formulas.

### Measure an area and compare rasters

Open **Raster statistics** from a layer or **Tools**. Choose the raster inputs,
an area and the statistic you want. One result is shown as a value; several
results can be compared in plots and a table, then downloaded as CSV.

Use a sampling box, selected polygons or each raster's whole extent, depending
on the question. For example, compare mean biomass inside project boundaries,
or measure how many hectares exceed a chosen threshold. Hidden raster layers
can still be selected as calculation inputs.

The built-in choices cover common statistics, counts, areas and percentages.
For a custom formula, `a` means each selected raster in turn:

| Question | Formula |
| --- | --- |
| What is the average valid value in this area? | `mean(a)` |
| How many hectares have values above 10? | `areaha(a > 10)` |
| What percentage of valid pixels have values above 10? | `100 * count(a > 10) / count(a)` |
| What was the value at my last map click? | `pixelValue(a)` |

Choose thresholds in the raster's own units. Missing-data pixels are excluded.
**Pixel value** always refers to the clicked location; changing the analysis
area does not turn it into an average. Up to five formulas can be calculated
together for each raster. The tool's formula reference explains the available
functions.

### Explore data through time

A data time cube brings observations from different dates together as one
dataset. Search with `type:temporal`, add a dataset, and choose its **Variable**,
**Month** and **Date and time (UTC)** in Map layers. Only available observations
are listed. **Add another view** lets you compare dates or variables with
independent styles.

![Blue hourly precipitation over the Atlantic and Africa, with controls for the variable, month and UTC observation time](docs/images/eolab-temporal-map.jpg)

*Follow changing weather by choosing another hour or variable from the same
dataset. Here, blue shading shows rainfall at one available observation time.*

To go beyond one observation, open **Tools → Models**:

- **Map for a period** summarizes observations across your chosen dates into
  a raster, with a second map showing how many observations contributed.
- **Time series for an area** calculates a spatial statistic for each
  observation and returns a CSV. For example, follow mean temperature within a
  watershed over time.

**Raster statistics** also compares observations as a plotted series. Select
the dates for the calculation explicitly; they are independent of the single
observation currently displayed on the map. Missing observations are not filled
in, so check coverage before interpreting a trend or period summary. Ordinary
period statistics weight available observations equally; use **Precipitation
total** when offered to turn rainfall rates into an accumulated depth.

### Make a series plot

After selecting vector features, the inspector offers two complementary plots:

- **Plot fields from this feature** graphs several numeric attributes from the
  current feature. This fits data where fields such as `R2000` through `R2024`
  contain a series within each feature.
- **Plot one field across features** graphs one numeric attribute for every
  feature available through **Previous** and **Next**. Choose the X-axis field
  or filename order, ascending or descending order, and a line or scatter
  chart.

![One selected map feature feeding several fields into a time series](docs/images/eolab-series-one-feature.jpg)

Selecting a chart point identifies its source layer and offers **Zoom to source
layer**. EOLab remembers the plot rules while you inspect other features from
the same layer, so the chart updates instead of making you configure it again.

### Bring your own polygons

Open **Map layers → Polygon uploads…** to add a GeoPackage (`.gpkg`) containing
one polygon layer. Choose the file, give the layer a name, then select **Upload
and add to map**. You can style it, inspect its attributes and filter features,
then use the supported polygon selection in raster analyses or model inputs.

![The polygon upload form with file, layer name and Upload and add to map controls](docs/images/eolab-polygon-uploads.jpg)

*Bring project boundaries into the same workspace as the shared data.*

Files are stored on the server and available only to the browser that uploaded
them, on that site. **Your uploads** lets you reopen a file. Removing its layer
from the map keeps the file; **Delete uploaded file** removes it. Remembered
maps can restore your upload references, but sending someone a map link does
not give their browser access to your private files.

For an existing Catalog vector or uploaded layer, use **Filter** to narrow the
features, then select that polygon layer when choosing your analysis area.
This is useful for working with one country, watershed or project group without
preparing another file.

### Draw and share polygons

Use **Shared layers → Create layer** to start a shared polygon layer, or **Join
layer** with a share code and your contributor name. Draw polygons, edit their
boundaries, and add names and notes. Everyone sees the saved polygons; you can
edit only your own. **Share layer** copies the code for someone else to join.

**Import GeoJSON** brings simple polygons into an editable local layer saved on
your device. It accepts WGS84 longitude/latitude Polygon features without holes,
including names and notes. Other file attributes and styles are not imported.
Use **Polygon uploads…** for a GeoPackage whose attributes you want to retain.

Drawn or imported polygons can define supported analysis areas. Save edits
before calculating or exporting. **Export GeoJSON** downloads all saved
polygons in the layer, including those hidden by its filter, so you can keep a
copy outside EOLab. Private local polygons are not included in map links; share
them in a shared layer when collaborators need to see them.

### Run a model and explore its results

Open **Tools → Models** to clip data, summarize observations or run environmental
models. Choose a model to select its inputs and analysis area.

#### Clip and download data

Use **Raster clip** to extract the part of a raster you need. Choose a raster
and a sampling box or selected polygons, then download the result as a GeoTIFF.
The clip preserves the original pixel resolution and values, ready for further
analysis in GIS software. For example, extract biomass data within a project's
boundary instead of downloading the whole regional dataset.

#### Estimate downstream beneficiaries

Use **Downstream ecosystem beneficiaries** to explore which places lie downstream
of a starting area and summarize what is there. Choose polygons or a raster mask
for **Starting mask**, then a raster for **Values to summarize**, such as a
population dataset. The model follows water flow using elevation and watershed
data. Adjust **Buffer radius** and the optional **Maximum straight-line distance**
to choose the coverage used for the calculation. Values are resampled onto the
model's calculation grid, and only positive values are included.

Results include a downstream coverage map, a map of the selected values within
that coverage, and summary statistics. With population counts as the values and
the default sum, you can estimate how many people live within the modeled
coverage downstream of proposed restoration sites. This identifies potential
beneficiaries; it does not measure how much benefit each person receives. You can
also choose another values raster or summary formula to explore a different
downstream question.

#### Assess habitat condition against reference sites

Use **Habitat condition** to assess how closely a landscape resembles conditions
expected from selected reference sites. Choose an analysis area, reference sites,
environmental predictor rasters and observed habitat-response rasters. The model
learns the relationship between the environment and habitat responses at the
reference sites inside that area, then compares observed responses elsewhere
with those expected under reference conditions.

The **Reference similarity** map shows the result on a scale from 0 to 1: higher
values indicate greater similarity to reference conditions. Downloadable
diagnostics help you examine the expected responses and departures from them.
For example, use the map to identify places whose observed condition differs
from what comparable reference sites suggest. Interpretation depends on your
reference sites and input data.

Choose raster layers yourself, or use **Original model inputs from Earth Engine**
and select an **Assessment year** when that option is configured on your site.
The automatic option downloads the original model's inputs for your area; the
first run can take longer, while later runs reuse matching downloaded tiles.
The current scientific settings come from the Montana Prairie configuration,
and the automatic inputs have not been validated for global coverage. An
optional habitat assessment mask limits where results are calculated while
keeping the reference sites used for training independent of that mask.

#### Summarize a raster or explore change through time

The other models in **Tools → Models** cover common calculations:

- **Raster summary** calculates a statistic or formula for a raster and area,
  such as mean biomass or hectares above a threshold.
- **Map for a period** summarizes observations over a date range into a map,
  with a second map showing how many observations contributed at each pixel.
- **Time series for an area** calculates a statistic for each available
  observation in your chosen area and downloads a CSV, such as mean temperature
  within a watershed over time.

See [Explore data through time](#explore-data-through-time) for choosing dates
and interpreting missing observations.

#### Follow a run and use its outputs

Select **Run model** (or **Run analysis** for the temporal tools). Follow progress
in **Runs** while continuing to use the map. Closing the panel does not cancel
work; use **Cancel run** to stop it.

Download completed results or choose **Show on map** where offered. Some raster
inputs also accept results from earlier runs. **Duplicate with changes** lets
you repeat a run with different choices. Runs belong to your browser session
and have expiry dates: **Keep for another 7 days** extends retention. Download
files you want to keep, since a map link does not preserve the run or share its
private outputs.

### Share your map

Choose **Publish map** in the workspace header, enter a title and link name,
then select **Create map link**. The resulting page opens your chosen layers,
styles, order, visibility and starting view so others can explore the map
without the Catalog panel. Shared polygon layers remain live: collaborators
see saved changes and can join with the layer's share code. Older **Copy map
link** views may use a link that stores the view directly in the URL.

The browser also remembers the last valid map on that deployment. **Reset
view** returns to an empty map and the configured starting position. **Undo
reset** restores the immediately previous map.

Map links do not include private local polygons, editing access,
histogram results, feature plots or processing jobs. Private uploads remain
private, and model-result previews must be reopened from **Runs**. Maps use the
site's current datasets; missing data can prevent full restoration.

## Running your own EOLab workspace

Copy [.env.example](.env.example) to `.env` and fill in its required passwords,
Jobs token and host data-directory path. That file describes the settings;
[docker-compose.yml](docker-compose.yml) defines the services and persistent
volumes. Keep the database password stable after the first deployment and use
distinct volume names for separate deployments.

For a local workspace:

```sh
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build --detach
```

Open `http://localhost:8000`, then scan the data directory from **Status**.
For Coolify, use the repository's Docker Compose build pack and
`docker-compose.yml`, set the variables from `.env.example`, and attach the
public domain to the `app` service on port `8000`. Keep the other services
private. Enable **Include Source Commit in Build** to display the deployed
revision.

Back up persistent volumes before upgrades. Run one `processing-worker`
container and stop the previous one before replacing it: worker startup
interrupts unfinished jobs. Deleting volumes deletes their stored data.

EOLab is open-source software under the [Apache License 2.0](LICENSE). Bivariate
palette definitions originate in the
[ESOS-C data viewer](https://github.com/springinnovate/esos-c-dataviewer), also under
the [Apache License 2.0](https://github.com/springinnovate/esos-c-dataviewer/blob/main/LICENSE).
