# EOLab

EOLab is a shared browser workspace for exploring prepared raster and vector
data. It turns a folder of geospatial files into a searchable Catalog where a
group can build maps, inspect features and pixels, compare rasters, make plots,
and share the exact view with a link.

It is especially useful for workshops and collaborative analysis. A facilitator
can publish the participants' datasets once, and everyone can explore the same
material in real time without installing a desktop GIS or creating an account.

![EOLab showing Catalog results beside a map of a vector dataset](docs/images/eolab-catalog-map.png)

## What can you do with EOLab

- Search a shared Catalog by filename, path, date, or dataset type.
- Add several rasters and vectors to one map, reorder them, and control which
  are visible.
- Style rasters with color ramps and opacity.
- Style points, lines, and polygons with one symbol, categories, or graduated
  numeric classes; add labels when useful.
- Click the map to inspect vector attributes and sample raster pixels.
- Draw a sampling window and compare raster distributions with 1D or 2D
  histograms.
- Plot several fields from one feature, or one numeric field across all
  features found at a location.
- Copy a link that recreates the layers, styles, order, visibility, opacity,
  viewport, and viewer version.

For example, a landscape-connectivity workshop can combine annual resistance
rasters with corridor or node vectors. Participants can compare raster values
at a location, inspect the attributes of overlapping features, plot how a
metric changes across years, and send a colleague a link to the resulting map.

## A quick tour

### Find a dataset

Use **Catalog search** to enter any part of a filename, path, description, or
date. Ordinary words can be combined with these filters:

- `type:raster` — only raster datasets
- `type:vector` — only vector datasets
- `format:cog` — only Cloud Optimized GeoTIFFs
- `date:2020`, `date:2020-06`, or `date:2020-06-15` — a year, month, or day
- `date:2020-01..2020-03` — an inclusive date range

For example, `resistance type:raster date:2020` finds raster records containing
“resistance” from 2020. Suggestions appear while you type. Clear the search to
show the complete Catalog, or use **Surprise me** to open a random matching
item.

Each result shows the source filename and the actions you are most likely to
need:

- **Add to map** publishes and displays the dataset.
- **More details** opens its Catalog metadata.

After an item is on the map, the same row also offers **Remove**, **Zoom to**,
and **Style** without making you leave the search results.

### Build the map

Open **Map layers** to see the current stack. The first layer in the list draws
on top. Drag a row by its handle to reorder it, or use the keyboard controls on
the same handle.

Use **Upload polygons…** beside **Shared layers** to add a GeoPackage containing
one polygon layer. It is stored on this server and available only to this browser.
Uploaded layers support styling, filters and attribute inspection. They are not
yet restored after a page reload or included in saved/shared maps, analyses or
model inputs. Removing a layer from the map does not delete the stored file.

Each layer row keeps its frequent actions visible:

- the checkbox shows or hides the layer;
- **Style** changes its appearance;
- **Summarize** opens raster analysis;
- the color swatch opens the full legend in place of the swatch, including its
  values and its inclusion in the map legend;
- **×** removes the layer from the map.

The utility icons provide **Filter** (supported layers), **Zoom to**, **Rename**,
Catalog **Info**, **Copy style**, **Paste style**, and raster **Download clip**.
Each has a tooltip and a layer-specific accessible name. All controls use normal
Tab navigation; collapse the legend with its upward chevron or Escape to return
to the swatch. Long names, errors and expanded legends grow the row instead of
being clipped. Touch layouts use larger targets and wrap the utility icons.

![Map Layers and a raster style editor in EOLab](docs/images/eolab-layer-styling.png)

Raster styles offer minimum, midpoint, and maximum colors and opacities. Vector
styles adapt to point, line, or polygon geometry. They support a single symbol,
categorical values with CSV category tables, graduated numeric classes with editable exact break values,
and optional labels. New catalog vectors start with labels off; enable **Show
labels** in **Style** to display them. Valid vector edits update the map automatically after a
short pause, with the current state reported beside the controls. Appearance
changes affect only the current map; they never edit the source data.

### Explore what is under the pointer

A normal click explores the visible data at that location. Dragging still pans
the map.

For visible vectors, EOLab highlights the features under the click and opens
their attributes in **Feature inspector**. Use **Previous** and **Next** when
several features overlap. Clicking empty space does not open an empty result.

For visible rasters, EOLab samples the pixel values and shows them in **Histograms**. A
bounded sample window can be moved or resized to explore a local distribution:

- **1D** mode shows distributions for the active visible rasters.
- **2D** mode compares the top two visible rasters and marks them **X** and
  **Y** in Map layers. Reorder those layers to change the pair, or swap the axes
  in the analysis panel. Other layers stay in Map layers but are temporarily
  hidden from the map while 2D mode is active.

![A map pointer and sample window linked to raster values and a two-dimensional distribution](docs/images/eolab-raster-analysis.jpg)

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

### Share your map

Use **Copy map link** to copy the current map as a URL. The link contains a
compressed map-view document in its URL fragment, so opening it recreates the
shared viewport and layers without uploading a separate file. Every referenced
Catalog item is revalidated before use; the source data itself is not embedded
in the link.

The browser also remembers the last valid map on that deployment. **Reset
view** returns to an empty map and the configured starting position. **Undo
reset** restores the immediately previous map.

Shared links and the locally remembered map do not include sampling areas,
histogram results, feature plots or processing jobs. They refer to the deployment's
current Catalog, so missing sources can prevent full restoration.

## Add your own data

EOLab deployments read from a configured, read-only data directory. Treat admitted
datasets as immutable; publish changed data under a new identity.

1. Prepare georeferenced GeoTIFFs and vector datasets before the session.
2. Copy them into the deployment's mounted data directory.
3. Open **Status**, find the Catalog section, and select **Scan directories**.
4. Review any dataset-specific errors without interrupting successful files.
5. Search for a representative raster and vector, add both to the map, and
   verify their bounds and appearance.

To prepare single-band rasters, run [prepare_rasters.py](scripts/prepare_rasters.py)
with a Python environment containing GDAL's `osgeo` bindings (GDAL 3.10 or newer):

```sh
python scripts/prepare_rasters.py "input/*.tif" another.tif --destination prepared
```

It creates EPSG:3857 Cloud Optimized GeoTIFFs named `<name>_cog_epsg3857.tif`,
with compression and overviews. Existing outputs are skipped. Quote glob patterns
so the script expands them consistently across shells; multiple files and patterns
can be combined. From the `scripts` directory, use `python prepare_rasters.py`.
Nearest-neighbor resampling is the default; use `--resampling bilinear` for
continuous data when appropriate. GDAL chooses the projected pixel size and
retains the input data type. Failed conversions are reported and can be retried
by rerunning the command. Distinct inputs must have distinct filename stems.
The destination filesystem must support hard links (for example, NTFS or ext4)
so completed files can be published without overwriting another batch's output.

Scanning again updates files that are still present and removes Catalog items
whose mounted source files have disappeared. The source mount remains
read-only; EOLab stores Catalog metadata and generated GeoServer configuration
elsewhere.

Temporal archives contain prepared GeoTIFF observations and a read-only SQLite
catalog exposing the `observations` view. Copy the complete archive into the
mount with its [dataset.yaml descriptor](docs/dataset-examples/dataset.yaml),
using `source.format: temporal_cog` and a unique dataset `id`, then scan.
The archive appears as one temporal Catalog item; its folder contents are not
indexed separately. Admission reads observation metadata without opening each
GeoTIFF. Missing observations are valid.

The catalog supplies each observation's relative `path`, single `band`,
`variable`, human-readable `name`, `units`, Unix-second `valid_time`,
nullable `reference_time`, `interval_start`, `interval_end`, and
`temporal_type` (`instant`, `mean`, or `accumulation`). Raster metadata
includes `dtype`, `nodata`, `crs`, a JSON `transform` in GDAL order,
`height` and `width`. Observations share one north-up grid; the producer
publishes completed GeoTIFFs before exposing them in the view.

Update files only between calculations and rescan before using the updated
data. A failed refresh reports an error and keeps the last valid metadata;
correct the source and complete a successful scan before continuing.

Temporal observations can be read through the raster-analysis API. Wrap an
[observation selection](docs/dataset-examples/era5.selections.json) in `source`
for `/api/raster-analysis/sources`, `/api/raster-analysis/pixels` or
`/api/raster-analysis/statistics`; pixels also need `longitude` and `latitude`,
and statistics accept `selectedBounds`. Paired statistics accept selections in
`xRaster` and `yRaster`. Choose a variable and UTC time listed in the dataset
coverage. In the browser, add the temporal Catalog item to the map and choose a
variable, month and UTC time in its Map layers row. **Add another view** lets you
compare observations independently. Under **Tools → Models**, choose **Map for a period**
to summarize observations into a map, or **Time series for an area** to download a
CSV with one spatial statistic per observation. The [API tests](tests/test_temporal_source_access.py) provide runnable
requests against a small archive.

Rendering mounted rasters expects prepared, georeferenced, single-band GeoTIFFs.
EOLab does not rewrite or optimize them during scanning. Temporal map views
publish the selected original GeoTIFF through the same GeoServer pipeline. Mounted
Shapefiles and spatial GeoPackage layers can be added to the map. Other
recognized vector containers may be searchable in the Catalog even when they
are not yet renderable.

For polygon-based analysis, choose a mounted Catalog vector layer and apply an
attribute filter in **Sampling area → Vector layer**. The selection reads the
original source directly.

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

### Upgrade an older published map

Maps saved before removal of Catalog `sourceRevision` fields need a one-time
conversion. The [migration command](src/eolab_app/saved_maps/migrate.py) previews
one named map by default. It removes only those fields, preserves the map URL,
layer order, styles and shared-polygon invitations, and never changes polygons
or contributor ownership. Other incompatible formats cause an error with no
changes; this command does not convert historical raster styles or URL-fragment
links. Run it separately for each affected published map.

For `/maps/nhi-site-condition-mapper`, use the following during a maintenance
window. Have contributors finish saving first. Keep the same database volume,
domain and browser cookies. Build the new application image containing this
command, but stop the old app and worker before applying it: the old app still
requires the removed fields.

```sh
docker compose stop app processing-worker
docker compose exec -T database pg_dump -U eolab -d eolab --format=custom --file=/tmp/eolab-before-map-upgrade.dump
docker compose cp database:/tmp/eolab-before-map-upgrade.dump ./eolab-before-map-upgrade.dump
docker compose run --rm --no-deps --entrypoint python app -m eolab_app.saved_maps.migrate --slug nhi-site-condition-mapper
```

Keep the backup outside container storage and test restoring it to a separate
database before proceeding. The preview reports `changed_layers`, `revision`
and `applied: false`. Review the count, then replace `REVISION` below with that
preview's revision. A conflicting edit requires a new preview. A successful
change increments the map revision once; repeating it is a no-op.

```sh
docker compose run --rm --no-deps --entrypoint python app -m eolab_app.saved_maps.migrate --slug nhi-site-condition-mapper --apply --expected-revision REVISION
```

Complete the deployment using the new images, then open the original shared-map
URL and check its layers, polygon counts and contributor editing access before
reopening the workshop. In Coolify, use the equivalent commands in the existing
deployment with its original persistent volumes; do not create a new deployment
with an empty database. Keep the old image available for rollback.

If verification fails while the maintenance window is still closed, stop the
new app and worker, restore the database backup, and restart the old images.
For example, after copying the backup back into the database container:

```sh
docker compose cp ./eolab-before-map-upgrade.dump database:/tmp/eolab-before-map-upgrade.dump
docker compose exec -T database pg_restore -U eolab -d eolab --clean --if-exists --single-transaction --exit-on-error /tmp/eolab-before-map-upgrade.dump
```

A full restore replaces changes made since the backup, so do not use this
rollback after contributors have resumed editing without reconciling that work.

## Model library

Use **Tools → Models** to run **Raster summary** or **Raster clip**, then inspect
progress, results and YAML in the right-hand Analysis panel. Raster summary
returns values and a CSV; Raster clip returns a GeoTIFF for the selected area.

The downstream model's DEM, watershed layer and topology fields are configured
in its [bundled YAML recipe](src/eolab_app/processing/recipes/downstream-beneficiaries.yaml),
under `steps[0].inputs.hydrology.value`. Set these Catalog references for your
deployment before building it. The pit-filling search cutoff is in
`steps[0].inputs.settings.value.pit_fill_search_limit` in the same recipe;
-1 and 0 allow unlimited searches. This replaces the former
`PROCESSING_DOWNSTREAM_PIT_FILL_SEARCH_LIMIT` environment setting.

Habitat condition can fetch its original scientific inputs from Earth Engine
inside a model run. Set `EOLAB_HABITAT_EARTH_ENGINE_PROJECT` and
`EOLAB_HABITAT_EARTH_ENGINE_CREDENTIALS_FILE` in Compose. Place the service-account
JSON key in the dedicated `habitat-credentials` volume, readable by the worker's
`eolab` user. Compose mounts that volume read-only at `/run/habitat-credentials`
in `processing-worker` only. For a file named `service-account-key.json`, set the
credential path to `/run/habitat-credentials/service-account-key.json`. Use a
separate `EOLAB_HABITAT_CREDENTIALS_VOLUME_NAME` for each deployment. Keep the key
outside Catalog data and the repository; never put it in browser configuration.
Leave the project and credential-path settings blank to use only manually
selected rasters.

In **Tools → Models → Habitat condition**, choose **Original model inputs from
Earth Engine** as the input source, select the assessment year, then choose an
explicit **Analysis area** and **Reference sites** before selecting **Run model**.
Use a representative Montana area and 2018 for the first demonstration, with
enough reference coverage for the configured spatial validation. **Choose raster
layers** remains available for manually selected inputs.

The first run downloads the original predictor and response tiles; later runs
reuse matching completed tiles. The preparation grid remains explicit; downloaded
bands use nearest-neighbor resampling, while selected masks use their requested
methods. Follow progress and inspect or download results in **Runs**. **Duplicate
with changes** restores the chosen inputs, including the source mode and year.
See the [model integration tests](tests/test_habitat_earth_engine_model.py) for an
executable request and result example.

Habitat keeps completed input tiles under `PROCESSING_DATA_PATH/habitat-cache`,
beside run files on the same filesystem for atomic publication. Tiles survive run
expiry and restart; administrators may remove the cache only while no calculations
use it. Concurrent cold requests may both download a tile; the first completed
publication wins. Run cleanup removes temporary band views and aligned rasters,
not cached tiles.

EOLab is open-source software under the [Apache License 2.0](LICENSE). Bivariate
palette definitions originate in the
[ESOS-C data viewer](https://github.com/springinnovate/esos-c-dataviewer), also under
the [Apache License 2.0](https://github.com/springinnovate/esos-c-dataviewer/blob/main/LICENSE).
