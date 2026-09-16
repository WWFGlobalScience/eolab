"""Load and validate EOLab application settings from the environment."""

import json
import math
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote


APPLICATION_VERSION_PATH = Path("/app/version")


@dataclass(frozen=True)
class ProcessingWorkerSettings:
    """Validated configuration for the worker's Catalog and storage dependencies.

    Attributes:
        catalog_internal_url: Internal read-only Catalog API address.
        scan_mount_path: Absolute read-only mounted input root.
        processing_data_path: Absolute private writable artifact volume.
    """

    catalog_internal_url: str
    scan_mount_path: Path
    processing_data_path: Path

    def __post_init__(self) -> None:
        """Validate the worker's independent configuration boundary.

        Raises:
            ValueError: If Catalog URL is blank or either storage root is relative.
        """
        if not self.catalog_internal_url:
            raise ValueError("CATALOG_INTERNAL_URL must not be blank")
        if not self.scan_mount_path.is_absolute() or not self.processing_data_path.is_absolute():
            raise ValueError("Worker source and processing paths must be absolute")


def load_processing_worker_settings() -> ProcessingWorkerSettings:
    """Read only the environment values needed by the processing worker.

    Returns:
        Worker configuration with no rendering credentials or viewer settings.

    Raises:
        KeyError: If a required worker environment value is absent.
        ValueError: If a supplied value violates its owned contract.
    """
    return ProcessingWorkerSettings(
        catalog_internal_url=os.environ["CATALOG_INTERNAL_URL"].strip(),
        scan_mount_path=Path(os.environ["SCAN_MOUNT_PATH"]),
        processing_data_path=Path(os.environ["PROCESSING_DATA_PATH"]),
    )


@dataclass(frozen=True)
class Settings:
    """Validated runtime settings for the EOLab application.

    Attributes:
        app_title: Browser and API application title.
        app_subtitle: Browser and API application subtitle.
        app_version: Git-derived application version.
        catalog_url: Browser-facing STAC API URL.
        catalog_internal_url: Application-facing STAC API URL.
        wms_url: Browser-facing WMS URL.
        geoserver_internal_url: Application-facing GeoServer URL.
        geoserver_metrics_internal_url: Internal GeoServer metrics URL.
        geoserver_wms_render_count: Maximum concurrent WMS renders.
        composite_tile_cache_bytes: Composite PNG response cache capacity.
        raster_pixel_read_concurrency: Maximum concurrent raster pixel reads.
        raster_statistics_read_concurrency: Maximum concurrent statistics reads.
        raster_statistics_cache_entries: Completed statistics cache capacity.
        geoserver_admin_user: GeoServer administrator username.
        geoserver_admin_password: GeoServer administrator password.
        scan_mount_path: Read-only mounted dataset root.
        scan_paths_within_mount: Relative mounted directories to scan.
        scan_display_path_prefix: User-facing mounted-source prefix.
        scan_worker_count: Concurrent dataset metadata workers.
        scan_writer_count: Concurrent catalog writers.
        scan_batch_size: Maximum catalog Items per bulk write.
        scan_error_detail_limit: Scan failure details retained in memory.
        scan_reconciliation_page_size: Catalog Items per reconciliation page.
        scan_reconciliation_concurrency: Concurrent mounted-file checks.
        scan_reconciliation_spool_memory_bytes: Reconciliation in-memory limit.
        scan_catalog_write_timeout_seconds: Per-operation catalog write timeout.
        scan_catalog_error_detail_limit: Upstream catalog error text limit.
        basemap_url: Browser basemap tile URL template.
        basemap_attribution: Browser basemap attribution.
        carto_basemap_api_key: Optional browser-visible CARTO basemap key.
            Blank disables the CARTO option; use a domain-restricted basemap key.
        initial_latitude: Initial map-center latitude.
        initial_longitude: Initial map-center longitude.
        initial_zoom: Initial map zoom level.
        processing_data_path: Persistent private clip volume shared with the worker.
        jobs_token: Server-only bearer credential identifying the
            application as a Jobs caller. Jobs uses that identity to restrict
            status, result, cancellation and deletion to the owning caller.
            Required at application startup; never sent to the browser.
    """

    app_title: str
    app_subtitle: str
    app_version: str
    catalog_url: str
    catalog_internal_url: str
    wms_url: str
    geoserver_internal_url: str
    geoserver_metrics_internal_url: str
    geoserver_wms_render_count: int
    composite_tile_cache_bytes: int
    raster_pixel_read_concurrency: int
    raster_statistics_read_concurrency: int
    raster_statistics_cache_entries: int
    geoserver_admin_user: str
    geoserver_admin_password: str = field(repr=False)
    scan_mount_path: Path
    scan_paths_within_mount: tuple[Path, ...]
    scan_display_path_prefix: str
    scan_worker_count: int
    scan_writer_count: int
    scan_batch_size: int
    scan_error_detail_limit: int
    scan_reconciliation_page_size: int
    scan_reconciliation_concurrency: int
    scan_reconciliation_spool_memory_bytes: int
    scan_catalog_write_timeout_seconds: float
    scan_catalog_error_detail_limit: int
    basemap_url: str
    basemap_attribution: str
    initial_latitude: float
    initial_longitude: float
    initial_zoom: float
    processing_data_path: Path = Path("/processing-data").absolute()
    jobs_token: str = field(default="", repr=False)
    carto_basemap_api_key: str = field(default="", repr=False)

    def __post_init__(self) -> None:
        """Validate the application settings contract.

        Raises:
            ValueError: If required text is blank, the Jobs credential is invalid,
                or a resource, path or map setting violates its contract.
        """
        required_text_settings = {
            "APP_TITLE": self.app_title,
            "APP_SUBTITLE": self.app_subtitle,
            "application version": self.app_version,
            "CATALOG_URL": self.catalog_url,
            "CATALOG_INTERNAL_URL": self.catalog_internal_url,
            "WMS_URL": self.wms_url,
            "GEOSERVER_INTERNAL_URL": self.geoserver_internal_url,
            "GEOSERVER_METRICS_INTERNAL_URL": self.geoserver_metrics_internal_url,
            "GEOSERVER_ADMIN_USER": self.geoserver_admin_user,
            "GEOSERVER_ADMIN_PASSWORD": self.geoserver_admin_password,
            "SCAN_DISPLAY_PATH_PREFIX": self.scan_display_path_prefix,
            "BASEMAP_URL": self.basemap_url,
            "BASEMAP_ATTRIBUTION": self.basemap_attribution,
        }
        if re.fullmatch(
            r"[A-Za-z0-9._~-]{32,256}", self.jobs_token
        ) is None:
            raise ValueError("JOBS_TOKEN must be a configured 32–256 character URL-safe Jobs credential")
        for environment_variable_name, setting_value in required_text_settings.items():
            if not setting_value:
                raise ValueError(f"{environment_variable_name} must not be blank")

        if not -90 <= self.initial_latitude <= 90:
            raise ValueError("INITIAL_LATITUDE must be between -90 and 90")
        if not self.processing_data_path.is_absolute():
            raise ValueError("PROCESSING_DATA_PATH must be an absolute path")
        if not -180 <= self.initial_longitude <= 180:
            raise ValueError("INITIAL_LONGITUDE must be between -180 and 180")
        if not 0 <= self.initial_zoom <= 22:
            raise ValueError("INITIAL_ZOOM must be between 0 and 22")
        if self.scan_worker_count < 1:
            raise ValueError("SCAN_WORKER_COUNT must be greater than zero")
        if self.geoserver_wms_render_count < 1:
            raise ValueError("GEOSERVER_WMS_RENDER_COUNT must be greater than zero")
        if self.composite_tile_cache_bytes < 1:
            raise ValueError(
                "COMPOSITE_TILE_CACHE_BYTES must be greater than zero"
            )
        if self.raster_pixel_read_concurrency < 1:
            raise ValueError(
                "RASTER_PIXEL_READ_CONCURRENCY must be greater than zero"
            )
        if self.raster_statistics_read_concurrency < 1:
            raise ValueError(
                "RASTER_STATISTICS_READ_CONCURRENCY must be greater than zero"
            )
        if self.raster_statistics_cache_entries < 1:
            raise ValueError(
                "RASTER_STATISTICS_CACHE_ENTRIES must be greater than zero"
            )
        if self.scan_writer_count < 1:
            raise ValueError("SCAN_WRITER_COUNT must be greater than zero")
        if self.scan_batch_size < 1:
            raise ValueError("SCAN_BATCH_SIZE must be greater than zero")
        positive_scan_settings = {
            "SCAN_ERROR_DETAIL_LIMIT": self.scan_error_detail_limit,
            "SCAN_RECONCILIATION_PAGE_SIZE": self.scan_reconciliation_page_size,
            "SCAN_RECONCILIATION_CONCURRENCY": (
                self.scan_reconciliation_concurrency
            ),
            "SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES": (
                self.scan_reconciliation_spool_memory_bytes
            ),
            "SCAN_CATALOG_WRITE_TIMEOUT_SECONDS": (
                self.scan_catalog_write_timeout_seconds
            ),
            "SCAN_CATALOG_ERROR_DETAIL_LIMIT": (
                self.scan_catalog_error_detail_limit
            ),
        }
        for environment_variable_name, setting_value in positive_scan_settings.items():
            if not math.isfinite(setting_value) or setting_value <= 0:
                raise ValueError(
                    f"{environment_variable_name} must be greater than zero"
                )
        if not self.scan_mount_path.is_absolute():
            raise ValueError("SCAN_MOUNT_PATH must be an absolute path")
        if not self.scan_mount_path.is_dir():
            raise ValueError("SCAN_MOUNT_PATH must be an existing directory")
        if not self.scan_paths_within_mount:
            raise ValueError("SCAN_PATHS_WITHIN_MOUNT must contain at least one path")

        resolved_mount_path = self.scan_mount_path.resolve()
        source_paths: list[Path] = []
        for relative_path in self.scan_paths_within_mount:
            if relative_path.is_absolute():
                raise ValueError("SCAN_PATHS_WITHIN_MOUNT paths must be relative")
            if ".." in relative_path.parts:
                raise ValueError("SCAN_PATHS_WITHIN_MOUNT paths must not contain '..'")
            source_path = (resolved_mount_path / relative_path).resolve()
            if not source_path.is_relative_to(resolved_mount_path):
                raise ValueError(
                    "SCAN_PATHS_WITHIN_MOUNT paths must remain within the mount"
                )
            if not source_path.is_dir():
                raise ValueError(
                    "SCAN_PATHS_WITHIN_MOUNT paths must identify existing directories"
                )
            source_paths.append(source_path)

        if len(source_paths) != len(set(source_paths)):
            raise ValueError("SCAN_PATHS_WITHIN_MOUNT paths must not be duplicated")
        for source_index, source_path in enumerate(source_paths):
            for other_source_path in source_paths[source_index + 1 :]:
                if (
                    source_path in other_source_path.parents
                    or other_source_path in source_path.parents
                ):
                    raise ValueError("SCAN_PATHS_WITHIN_MOUNT paths must not overlap")

    def as_public_dict(self) -> dict[str, object]:
        """Serialize settings for the public browser configuration endpoint.

        Returns:
            Browser configuration containing application identity strings,
            the browser-facing catalog and WMS URLs, user-facing scan paths,
            basemap URL and attribution strings, and numeric initial-view
            latitude, longitude, and zoom values. When configured, basemap.carto
            contains a tile URL with the browser-visible CARTO key, attribution,
            and native zoom limit. Internal service URLs are not exposed.
        """
        basemap: dict[str, object] = {
            "url": self.basemap_url,
            "attribution": self.basemap_attribution,
        }
        if self.carto_basemap_api_key:
            basemap["carto"] = {
                "url": (
                    "https://basemaps.cartocdn.com/rastertiles/light_all/"
                    "{z}/{x}/{y}.png?key=" + quote(self.carto_basemap_api_key, safe="")
                ),
                "attribution": (
                    '&copy; <a href="https://www.openstreetmap.org/copyright">'
                    "OpenStreetMap contributors</a> &copy; "
                    '<a href="https://carto.com/attributions">CARTO</a>'
                ),
                "maxNativeZoom": 20,
            }
        return {
            "appTitle": self.app_title,
            "appSubtitle": self.app_subtitle,
            "appVersion": self.app_version,
            "catalogUrl": self.catalog_url,
            "wmsUrl": self.wms_url,
            "scanDisplayPathPrefix": self.scan_display_path_prefix,
            "scanDisplayPaths": list(self.scan_display_paths()),
            "basemap": basemap,
            "initialView": {
                "latitude": self.initial_latitude,
                "longitude": self.initial_longitude,
                "zoom": self.initial_zoom,
            },
        }

    def scan_display_paths(self) -> tuple[str, ...]:
        """Build user-facing locations for the configured scan directories.

        Returns:
            Display prefix joined to each mount-relative scan directory using
            the path separator implied by the configured display prefix. A
            root scan path is represented by the display prefix alone.
        """
        separator = "\\" if "\\" in self.scan_display_path_prefix else "/"
        display_paths: list[str] = []
        for relative_path in self.scan_paths_within_mount:
            relative_path_text = relative_path.as_posix()
            if relative_path_text == ".":
                display_paths.append(self.scan_display_path_prefix)
                continue
            normalized_relative_path = relative_path_text.replace("/", separator)
            joiner = (
                ""
                if self.scan_display_path_prefix.endswith(("/", "\\"))
                else separator
            )
            display_paths.append(
                f"{self.scan_display_path_prefix}{joiner}"
                f"{normalized_relative_path}"
            )
        return tuple(display_paths)


def load_settings(
    version_file_path: Path = APPLICATION_VERSION_PATH,
) -> Settings:
    """Load application settings from the environment and baked version file.

    Args:
        version_file_path: File containing the Git-derived application version.

    Returns:
        Validated settings with surrounding whitespace removed from text,
        map values parsed as floating-point numbers, and the application
        version read from the baked version file.

    Raises:
        FileNotFoundError: If the baked version file does not exist.
        KeyError: If a required environment variable is missing.
        ValueError: If a setting violates its type or range contract.
    """
    scan_paths = json.loads(os.environ["SCAN_PATHS_WITHIN_MOUNT"])
    if not isinstance(scan_paths, list) or not all(
        isinstance(scan_path, str) and scan_path for scan_path in scan_paths
    ):
        raise ValueError("SCAN_PATHS_WITHIN_MOUNT must be a JSON array of paths")

    return Settings(
        jobs_token=os.environ.get("JOBS_TOKEN", ""),
        app_title=os.environ["APP_TITLE"].strip(),
        app_subtitle=os.environ["APP_SUBTITLE"].strip(),
        app_version=version_file_path.read_text(encoding="utf-8").strip(),
        catalog_url=os.environ["CATALOG_URL"].strip(),
        catalog_internal_url=os.environ["CATALOG_INTERNAL_URL"].strip(),
        wms_url=os.environ["WMS_URL"].strip(),
        geoserver_internal_url=os.environ["GEOSERVER_INTERNAL_URL"].strip(),
        geoserver_metrics_internal_url=os.environ[
            "GEOSERVER_METRICS_INTERNAL_URL"
        ].strip(),
        geoserver_wms_render_count=int(os.environ["GEOSERVER_WMS_RENDER_COUNT"]),
        composite_tile_cache_bytes=int(
            os.environ["COMPOSITE_TILE_CACHE_BYTES"]
        ),
        raster_pixel_read_concurrency=int(
            os.environ["RASTER_PIXEL_READ_CONCURRENCY"]
        ),
        raster_statistics_read_concurrency=int(
            os.environ["RASTER_STATISTICS_READ_CONCURRENCY"]
        ),
        raster_statistics_cache_entries=int(
            os.environ["RASTER_STATISTICS_CACHE_ENTRIES"]
        ),
        geoserver_admin_user=os.environ["GEOSERVER_ADMIN_USER"].strip(),
        geoserver_admin_password=os.environ["GEOSERVER_ADMIN_PASSWORD"],
        scan_mount_path=Path(os.environ["SCAN_MOUNT_PATH"]),
        scan_paths_within_mount=tuple(Path(scan_path) for scan_path in scan_paths),
        scan_display_path_prefix=os.environ["SCAN_DISPLAY_PATH_PREFIX"].strip(),
        scan_worker_count=int(os.environ["SCAN_WORKER_COUNT"]),
        scan_writer_count=int(os.environ["SCAN_WRITER_COUNT"]),
        scan_batch_size=int(os.environ["SCAN_BATCH_SIZE"]),
        scan_error_detail_limit=int(os.environ["SCAN_ERROR_DETAIL_LIMIT"]),
        scan_reconciliation_page_size=int(
            os.environ["SCAN_RECONCILIATION_PAGE_SIZE"]
        ),
        scan_reconciliation_concurrency=int(
            os.environ["SCAN_RECONCILIATION_CONCURRENCY"]
        ),
        scan_reconciliation_spool_memory_bytes=int(
            os.environ["SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES"]
        ),
        scan_catalog_write_timeout_seconds=float(
            os.environ["SCAN_CATALOG_WRITE_TIMEOUT_SECONDS"]
        ),
        scan_catalog_error_detail_limit=int(
            os.environ["SCAN_CATALOG_ERROR_DETAIL_LIMIT"]
        ),
        basemap_url=os.environ["BASEMAP_URL"].strip(),
        basemap_attribution=os.environ["BASEMAP_ATTRIBUTION"].strip(),
        carto_basemap_api_key=os.environ.get("CARTO_BASEMAP_API_KEY", "").strip(),
        initial_latitude=float(os.environ["INITIAL_LATITUDE"]),
        initial_longitude=float(os.environ["INITIAL_LONGITUDE"]),
        initial_zoom=float(os.environ["INITIAL_ZOOM"]),
        processing_data_path=Path(os.environ.get("PROCESSING_DATA_PATH", str(Path("/processing-data").absolute()))),
    )
