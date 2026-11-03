"""Fetch and reuse the original Habitat predictor and response rasters."""

from collections.abc import Callable
from contextlib import contextmanager
from collections.abc import Iterator
from dataclasses import dataclass
import errno
from importlib.resources import as_file, files
from pathlib import Path
from tempfile import TemporaryDirectory

from affine import Affine
import ee
from google.auth.exceptions import GoogleAuthError
from googleapiclient.errors import HttpError
from httplib2 import HttpLib2Error
from nhi_terrestrial_integrity_modeling.analysis_config import (
    RasterBandDefinition,
    RasterCacheGrid,
    RasterStackConfiguration,
    load_raster_stack_configuration,
)
from nhi_terrestrial_integrity_modeling.earth_engine_stack import (
    build_earth_engine_stack,
)
import rasterio
from rasterio.crs import CRS
from shapely.geometry import box
from shapely.geometry.base import BaseGeometry

from eolab_app.processing.raster_preparation import RasterGrid, calculate_raster_grid


@dataclass(frozen=True)
class HabitatEarthEngineSettings:
    """Server credentials used only by the Habitat acquisition process.

    Attributes:
        project: Google Cloud project registered for Earth Engine.
        credentials_file: Mounted service-account JSON key, outside source mounts.
            Never include its contents in requests, provenance or logs.
    """

    project: str
    credentials_file: Path


@dataclass(frozen=True)
class HabitatTiles:
    """Shared cached Habitat tiles and their scientific variable definitions.

    Attributes:
        tiles: Complete grid tiles in north-to-south, west-to-east order.
            Files belong to the persistent cache, not to a calculation attempt.
        bands: Ordered GeoTIFF band names mapped to the original definitions.
            Contains predictors and responses, never computed reference sites.
    """

    tiles: tuple[Path, ...]
    bands: dict[str, RasterBandDefinition]


@dataclass(frozen=True)
class HabitatCacheCoverage:
    """Count cached input tiles required by one Habitat AOI and source year.

    Attributes:
        configuration_sha256: Scientific stack identity, including year, grid,
            datasets, bands and stack version.
        year: Assessment year selected by the scientific configuration.
        required_tiles: Number of complete acquisition tiles intersecting the AOI.
        cached_tiles: Required tiles observed as published cache entries.
        missing_tiles: Required tiles without a published cache entry.
    """

    configuration_sha256: str
    year: int
    required_tiles: int
    cached_tiles: int
    missing_tiles: int


@dataclass(frozen=True)
class HabitatEarthEngineRuntime:
    """Server-only connection and persistent storage for Habitat input acquisition.

    Attributes:
        connection: Earth Engine project and mounted credential-file path.
        cache_directory: Model-private cache beside Processing attempts/results,
            on the same filesystem for atomic publication. Run cleanup does not
            remove completed cache entries.
    """

    connection: HabitatEarthEngineSettings
    cache_directory: Path


@contextmanager
def prepare_habitat_band_views(
    tiles: HabitatTiles, directory: Path
) -> Iterator[dict[str, Path]]:
    """Expose cached multiband tiles as job-local single-band raster mosaics.

    The views reference cached pixels without copying them. Pass the returned
    paths to ordinary raster preparation; they are not Catalog sources.

    Args:
        tiles: Complete, aligned files admitted by Habitat acquisition.
        directory: Private attempt directory owned by the native supervisor.

    Yields:
        VRT paths keyed by scientific band name, valid inside this context.
        Unsourced gaps are NoData; valid zero and source masks are preserved.

    Raises:
        RuntimeError: If GDAL cannot construct a band mosaic.
        OSError: If temporary view creation or cleanup fails.
    """
    from osgeo import gdal

    with TemporaryDirectory(prefix="habitat-bands-", dir=directory) as temporary:
        paths = {}
        for index, name in enumerate(tiles.bands, start=1):
            path = Path(temporary) / f"band-{index}.vrt"
            with gdal.ExceptionMgr():
                dataset = gdal.BuildVRT(
                    str(path),
                    [str(tile) for tile in tiles.tiles],
                    bandList=[index],
                    VRTNodata="nan",
                )
                dataset.FlushCache()
                dataset = None
            paths[name] = path
        yield paths


def load_habitat_stack(year: int | None = None) -> RasterStackConfiguration:
    """Load the original Habitat variables and acquisition grid for a source year.

    The upstream configuration filename names its original study area, but this
    scientific-only loader does not read that area's geometry or local settings.

    Args:
        year: Source year supported by the packaged scientific configuration,
            or None to use its configured default year.

    Returns:
        Original band computations, datasets and fixed acquisition grid.

    Raises:
        ValueError: If the year is outside the configuration's supported range.
        OSError: If the installed configuration cannot be read.
    """
    resource = files("nhi_terrestrial_integrity_modeling.config").joinpath(
        "south_africa_reference_condition_analysis.toml"
    )
    with as_file(resource) as path:
        return load_raster_stack_configuration(path, year=year)


def _select_tile_grids(
    area: BaseGeometry, grid: RasterCacheGrid
) -> tuple[RasterGrid, ...]:
    """Select full acquisition tiles with positive-area overlap with the AOI.

    Args:
        area: Nonempty AOI already projected into the acquisition CRS.
        grid: Original stack's globally anchored tile and pixel grid.

    Returns:
        Intersecting tile grids ordered north to south, then west to east.
    """
    span = grid.pixel_size_meters * grid.tile_size_pixels
    tiles = calculate_raster_grid(
        area.bounds,
        CRS.from_string(grid.crs),
        (span, span),
        (grid.origin_x, grid.origin_y),
    )
    selected = []
    for row in range(tiles.height):
        for column in range(tiles.width):
            left, top = tiles.transform * (column, row)
            if area.intersection(box(left, top - span, left + span, top)).area > 0:
                selected.append(
                    RasterGrid(
                        tiles.crs,
                        Affine(
                            grid.pixel_size_meters,
                            0,
                            left,
                            0,
                            -grid.pixel_size_meters,
                            top,
                        ),
                        grid.tile_size_pixels,
                        grid.tile_size_pixels,
                    )
                )
    return tuple(selected)


def _get_tile_cache_directory(
    tile: RasterGrid, cache_grid: RasterCacheGrid, stack_directory: Path
) -> Path:
    """Return the deterministic cache directory for one acquisition tile.

    Args:
        tile: Complete tile selected on the scientific acquisition grid.
        cache_grid: Globally anchored tile and pixel grid from the configuration.
        stack_directory: Cache directory for this scientific stack identity.

    Returns:
        Tile directory named by its grid column and row, without creating it.
    """
    span = cache_grid.pixel_size_meters * cache_grid.tile_size_pixels
    column = round((tile.transform.c - cache_grid.origin_x) / span)
    row = round((cache_grid.origin_y - tile.transform.f) / span)
    return stack_directory / f"{column}_{row}"


def inspect_habitat_cache(
    area: BaseGeometry,
    configuration: RasterStackConfiguration,
    cache_directory: Path,
) -> HabitatCacheCoverage:
    """Count published Habitat input tiles for a projected AOI without fetching.

    Use this to inspect preparation needs before submitting acquisition work.
    It uses the acquisition tile planner and trusts completed, immutable cache
    entries without opening raster files or contacting Earth Engine. It does
    not create cache directories or reserve tiles; acquisition checks the cache
    again when it runs.

    Args:
        area: Valid, nonempty AOI projected to configuration.grid.crs.
        configuration: Scientific settings from load_habitat_stack.
        cache_directory: Private persistent Habitat cache, which may not exist yet.

    Returns:
        Stack identity, assessment year and required, cached and missing tile
        counts observed during this call. Concurrent publication may increase
        coverage after an entry is checked.

    Raises:
        OSError: If the filesystem cannot inspect a cache entry.
    """
    grids = _select_tile_grids(area, configuration.grid)
    identity = configuration.raster_configuration_sha256
    stack_directory = cache_directory / identity
    cached = sum(
        _get_tile_cache_directory(grid, configuration.grid, stack_directory).exists()
        for grid in grids
    )
    return HabitatCacheCoverage(
        configuration_sha256=identity,
        year=configuration.year,
        required_tiles=len(grids),
        cached_tiles=cached,
        missing_tiles=len(grids) - cached,
    )


def _name_downloaded_bands(
    path: Path, grid: RasterGrid, names: tuple[str, ...]
) -> None:
    """Check an Earth Engine GeoTIFF against its request and name its bands.

    Args:
        path: Newly downloaded file, not yet returned to the caller.
        grid: Exact pixel grid requested from Earth Engine.
        names: Ordered predictor and response band names sent in the request.

    Raises:
        ValueError: If the downloaded raster does not match the requested stack.
        RasterioError: If the GeoTIFF cannot be read or updated.
    """
    with rasterio.open(path, "r+") as dataset:
        if (
            dataset.driver != "GTiff"
            or dataset.shape != (grid.height, grid.width)
            or dataset.count != len(names)
            or dataset.crs != grid.crs
            or dataset.transform != grid.transform
            or dataset.dtypes != ("float32",) * len(names)
        ):
            raise ValueError(
                "Earth Engine returned a raster that does not match the requested Habitat stack."
            )
        # Decode once at download admission, so truncated pixel data is not
        # returned as a completed tile. Keep the original NoData and masks.
        dataset.read(masked=True)
        dataset.descriptions = names


def _build_habitat_image(
    configuration: RasterStackConfiguration,
    settings: HabitatEarthEngineSettings,
) -> ee.Image:
    """Connect with server credentials and build the original scientific image.

    Args:
        configuration: Scientific settings from load_habitat_stack.
        settings: Server-only Earth Engine project and service-account key path.

    Returns:
        Earth Engine expression for the configured bands, ready for tile requests.

    Raises:
        RuntimeError: If credentials or initialization fail; raw authentication
            errors are omitted to keep credential details private.
    """
    try:
        credentials = ee.ServiceAccountCredentials(
            key_file=str(settings.credentials_file)
        )
        ee.Initialize(credentials, project=settings.project)
    except (
        OSError,
        ValueError,
        GoogleAuthError,
        HttpError,
        HttpLib2Error,
        ee.EEException,
    ):
        raise RuntimeError(
            "Habitat could not connect to Earth Engine. Check the configured project "
            "and the mounted service-account credentials and permissions."
        ) from None
    return build_earth_engine_stack(configuration)


def _publish_tile(directory: Path, entry: Path) -> None:
    """Atomically publish a validated tile, preserving an existing winner.

    Args:
        directory: Private staging directory containing the completed tile.tif.
        entry: Deterministic cache directory on the same filesystem. Every
            published entry is nonempty, so rename cannot overwrite it.

    Raises:
        OSError: If publication fails for a reason other than another writer
            publishing the same tile first, including different filesystems.
    """
    try:
        directory.rename(entry)
    except OSError as error:
        if error.errno not in (errno.EEXIST, errno.ENOTEMPTY):
            raise


def get_habitat_tiles(
    area: BaseGeometry,
    configuration: RasterStackConfiguration,
    settings: HabitatEarthEngineSettings,
    *,
    cache_directory: Path,
    working_directory: Path,
    progress: Callable[[int, int], None],
    check_cancelled: Callable[[], None],
) -> HabitatTiles:
    """Reuse completed Habitat tiles and fetch missing tiles for a projected AOI.

    Run in a dedicated Processing native process: Earth Engine initialization is
    process-global. The upstream scientific configuration digest includes year,
    grid, datasets, bands and stack version; globally anchored tile coordinates
    allow overlapping AOIs to reuse the same pixels. Completed entries are
    immutable and are not reopened or rehashed here. An entirely cached request
    does not connect to Earth Engine.

    Args:
        area: Valid, nonempty AOI already projected to configuration.grid.crs.
        configuration: Scientific settings from load_habitat_stack.
        settings: Server-only project and credentials, used only for cache misses.
        cache_directory: Private persistent cache, outside source mounts and
            attempt/result directories. Its files survive run expiry and restart.
            Administrators may clear it only while no calculations use it.
        working_directory: Existing private attempt directory on the same
            filesystem as the cache, allowing atomic directory publication.
        progress: Receive completed and total tile counts, including cache hits.
        check_cancelled: Raise to cancel between requests or before publication.
            The native supervisor handles cancellation during a blocking request.

    Returns:
        Shared cached files and ordered band definitions. Never remove these
        files when a run ends. Failure/cancellation removes this call's staging;
        previously published tiles remain reusable. After native termination the
        caller cleans the working directory. Concurrent misses may both fetch;
        the first completed publication wins without overwriting cached pixels.

    Raises:
        RuntimeError: If credentials, initialization or an Earth Engine request
            fails. Credential contents and raw authentication errors are omitted.
        ValueError: If a downloaded raster differs from the requested grid/bands.
        RasterioError: If downloaded pixels or metadata cannot be read or written.
        OSError: If local reads, writes, publication or staging cleanup fail.
        Exception: Propagates exceptions from progress and cancellation callbacks.
    """
    grids = _select_tile_grids(area, configuration.grid)
    bands = {
        name: band
        for name, band in zip(configuration.band_names(), configuration.bands)
        if band.role in ("predictor", "response")
    }
    check_cancelled()
    progress(0, len(grids))
    stack_directory = cache_directory / configuration.raster_configuration_sha256
    stack_directory.mkdir(parents=True, exist_ok=True)
    image = None
    paths = []
    for index, grid in enumerate(grids):
        check_cancelled()
        entry = _get_tile_cache_directory(grid, configuration.grid, stack_directory)
        if not entry.exists():
            if image is None:
                image = _build_habitat_image(configuration, settings)
            try:
                pixels = ee.data.computePixels(
                    {
                        "expression": image,
                        "fileFormat": "GEO_TIFF",
                        "bandIds": list(bands),
                        "grid": {
                            "dimensions": {"width": grid.width, "height": grid.height},
                            "affineTransform": {
                                "scaleX": grid.transform.a,
                                "shearX": 0,
                                "translateX": grid.transform.c,
                                "shearY": 0,
                                "scaleY": grid.transform.e,
                                "translateY": grid.transform.f,
                            },
                            "crsWkt": grid.crs.to_wkt(version="WKT1_GDAL"),
                        },
                    }
                )
            except (OSError, GoogleAuthError, HttpError, HttpLib2Error, ee.EEException):
                raise RuntimeError(
                    "Earth Engine could not download a Habitat tile. Check the "
                    "server connection and access to the configured source datasets."
                ) from None
            check_cancelled()
            with TemporaryDirectory(
                prefix="habitat-gee-", dir=working_directory
            ) as temporary:
                directory = Path(temporary)
                path = directory / "tile.tif"
                path.write_bytes(pixels)
                _name_downloaded_bands(path, grid, tuple(bands))
                check_cancelled()
                _publish_tile(directory, entry)
        paths.append(entry / "tile.tif")
        progress(index + 1, len(grids))
    check_cancelled()
    return HabitatTiles(tuple(paths), bands)
