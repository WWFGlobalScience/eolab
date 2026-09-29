"""Load and validate EOLab application settings from the environment."""

import json
import math
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

from eolab_app.processing.clip_models import RasterClipLimits

APPLICATION_VERSION_PATH = Path("/app/version")


def load_processing_limits() -> RasterClipLimits:
    """Load the same queue, execution and storage budgets for the app and worker.

    Returns:
        Processing limits with validated worker count and resource budgets.

    Raises:
        ValueError: If an override is blank, is not an integer, or is outside
            its supported range. The error names the environment variable.
    """
    defaults = RasterClipLimits()
    settings = {
        "PROCESSING_WORKER_COUNT": ("worker_count", 1),
        "PROCESSING_PROCESS_MEMORY_BYTES": ("process_memory_bytes", 512 * 1024**2),
        "PROCESSING_MAX_EXECUTION_MEMORY_BYTES": (
            "max_execution_memory_bytes",
            512 * 1024**2,
        ),
        "PROCESSING_MAX_WAITING_JOBS": ("max_waiting_jobs", 1),
        "PROCESSING_MAX_OWNER_WAITING_JOBS": ("max_owner_waiting_jobs", 1),
        "PROCESSING_MAX_JOB_RECORDS": ("max_job_records", 1),
        "PROCESSING_MAX_JOB_INPUT_BYTES": ("max_job_input_bytes", 1),
        "PROCESSING_MAX_STORED_BYTES": ("max_stored_bytes", 1),
        "PROCESSING_FREE_SPACE_FLOOR_BYTES": ("free_space_floor", 0),
        "PROCESSING_EXECUTION_TIMEOUT_SECONDS": ("runtime_seconds", 1),
        "PROCESSING_RESULT_TTL_SECONDS": ("result_ttl_seconds", 1),
    }
    values: dict[str, int] = {}
    for environment_name, (attribute, minimum) in settings.items():
        raw = os.environ.get(environment_name, str(getattr(defaults, attribute)))
        try:
            value = int(raw)
        except ValueError as error:
            raise ValueError(f"{environment_name} must be an integer") from error
        if not minimum <= value <= 2**63 - 1:
            raise ValueError(
                f"{environment_name} must be between {minimum} and {2**63 - 1}"
            )
        if (
            attribute in {"runtime_seconds", "result_ttl_seconds"}
            and value > 31_536_000
        ):
            raise ValueError(f"{environment_name} must not exceed one year")
        values[attribute] = value
    if values["worker_count"] > 32:
        raise ValueError("PROCESSING_WORKER_COUNT must not exceed 32")
    if values["max_execution_memory_bytes"] < values["process_memory_bytes"]:
        raise ValueError(
            "PROCESSING_MAX_EXECUTION_MEMORY_BYTES must fit PROCESSING_PROCESS_MEMORY_BYTES"
        )
    return RasterClipLimits(**values)


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
        map_render_queue_capacity: Additional upstream GetMap requests allowed to wait.
        map_render_queue_wait_seconds: Maximum wait before sending a GetMap request.
        raster_pixel_read_concurrency: Maximum concurrent raster pixel reads.
        raster_statistics_read_concurrency: Maximum concurrent statistics reads.
        raster_statistics_cache_entries: Completed statistics cache capacity.
        raster_statistics_queue_capacity: Additional distinct histogram reads allowed to wait.
        raster_statistics_queue_wait_seconds: Maximum histogram wait before reading starts.
        raster_statistics_max_waiters: Maximum callers awaiting histogram results, including duplicates.
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
        maptiler_api_key: Optional browser-visible MapTiler map key.
            Blank disables satellite imagery; restrict the key to viewer domains.
        initial_latitude: Initial map-center latitude.
        initial_longitude: Initial map-center longitude.
        initial_zoom: Initial map zoom level.
        saved_map_capacity: Maximum named maps retained on this site.
        shared_layer_capacity: Maximum retained shared layers, including deleted layers.
        shared_layer_creation_limit: Successful layer creations per site in one window.
        shared_layer_creation_window_seconds: Duration of a site-wide creation window.
        admin_password: Optional server-only password for /admin-eolab (user admin).
            Blank disables administration; never included in browser configuration.
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
    admin_password: str = field(default="", repr=False)
    carto_basemap_api_key: str = field(default="", repr=False)
    maptiler_api_key: str = field(default="", repr=False)
    raster_statistics_queue_capacity: int = 32
    raster_statistics_queue_wait_seconds: float = 30
    raster_statistics_max_waiters: int = 256
    map_render_queue_capacity: int = 64
    map_render_queue_wait_seconds: float = 60
    saved_map_capacity: int = 1000
    shared_layer_capacity: int = 10000
    shared_layer_creation_limit: int = 100
    shared_layer_creation_window_seconds: int = 60

    def __post_init__(self) -> None:
        """Validate the application settings contract.

        Raises:
            ValueError: If required text is blank, an administrator or Jobs credential is invalid,
                or a resource, path or map setting violates its contract.
        """
        if self.admin_password and (
            not 16 <= len(self.admin_password) <= 256
            or not self.admin_password.isascii()
            or any(character.isspace() for character in self.admin_password)
            or not self.admin_password.isprintable()
        ):
            raise ValueError(
                "ADMIN_PASSWORD must be blank or 16-256 printable ASCII characters without whitespace"
            )
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
        if self.saved_map_capacity < 1:
            raise ValueError("SAVED_MAP_CAPACITY must be greater than zero")
        for name, value in (
            ("SHARED_LAYER_CAPACITY", self.shared_layer_capacity),
            ("SHARED_LAYER_CREATION_LIMIT", self.shared_layer_creation_limit),
            (
                "SHARED_LAYER_CREATION_WINDOW_SECONDS",
                self.shared_layer_creation_window_seconds,
            ),
        ):
            if value < 1:
                raise ValueError(f"{name} must be greater than zero")
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
        if self.map_render_queue_capacity < 0:
            raise ValueError("MAP_RENDER_QUEUE_CAPACITY must be nonnegative")
        if (
            not math.isfinite(self.map_render_queue_wait_seconds)
            or not 0 < self.map_render_queue_wait_seconds <= 60
        ):
            raise ValueError("MAP_RENDER_QUEUE_WAIT_SECONDS must be finite and between 0 (exclusive) and 60")
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
        if self.raster_statistics_queue_capacity < 0:
            raise ValueError("RASTER_STATISTICS_QUEUE_CAPACITY must be nonnegative")
        if self.raster_statistics_max_waiters < 1:
            raise ValueError("RASTER_STATISTICS_MAX_WAITERS must be greater than zero")
        if (
            not math.isfinite(self.raster_statistics_queue_wait_seconds)
            or self.raster_statistics_queue_wait_seconds <= 0
        ):
            raise ValueError(
                "RASTER_STATISTICS_QUEUE_WAIT_SECONDS must be finite and greater than zero"
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
            and basemap.maptiler contain tile URLs with browser-visible keys,
            attribution, and native zoom limits. Internal service URLs are not exposed.
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
        if self.maptiler_api_key:
            basemap["maptiler"] = {
                "url": (
                    "https://api.maptiler.com/tiles/satellite-v2/"
                    "{z}/{x}/{y}.jpg?key=" + quote(self.maptiler_api_key, safe="")
                ),
                "attribution": (
                    '<a href="https://www.maptiler.com/">'
                    '<img src="https://api.maptiler.com/resources/logo.svg" '
                    'alt="MapTiler logo" width="88" height="22" '
                    'class="eolab-maptiler-logo"></a> '
                    '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> '
                    '&copy; <a href="https://www.openstreetmap.org/copyright">'
                    "OpenStreetMap contributors</a>"
                ),
                "maxNativeZoom": 22,
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
        saved_map_capacity=int(os.environ.get("SAVED_MAP_CAPACITY", "1000")),
        shared_layer_capacity=int(os.environ.get("SHARED_LAYER_CAPACITY", "10000")),
        shared_layer_creation_limit=int(
            os.environ.get("SHARED_LAYER_CREATION_LIMIT", "100")
        ),
        shared_layer_creation_window_seconds=int(
            os.environ.get("SHARED_LAYER_CREATION_WINDOW_SECONDS", "60")
        ),
        jobs_token=os.environ.get("JOBS_TOKEN", ""),
        admin_password=os.environ.get("ADMIN_PASSWORD", ""),
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
        raster_statistics_queue_capacity=int(
            os.environ.get("RASTER_STATISTICS_QUEUE_CAPACITY", "32")
        ),
        map_render_queue_capacity=int(
            os.environ.get("MAP_RENDER_QUEUE_CAPACITY", "64")
        ),
        map_render_queue_wait_seconds=float(
            os.environ.get("MAP_RENDER_QUEUE_WAIT_SECONDS", "60")
        ),
        raster_statistics_queue_wait_seconds=float(
            os.environ.get("RASTER_STATISTICS_QUEUE_WAIT_SECONDS", "30")
        ),
        raster_statistics_max_waiters=int(
            os.environ.get("RASTER_STATISTICS_MAX_WAITERS", "256")
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
        maptiler_api_key=os.environ.get("MAPTILER_API_KEY", "").strip(),
        initial_latitude=float(os.environ["INITIAL_LATITUDE"]),
        initial_longitude=float(os.environ["INITIAL_LONGITUDE"]),
        initial_zoom=float(os.environ["INITIAL_ZOOM"]),
        processing_data_path=Path(os.environ.get("PROCESSING_DATA_PATH", str(Path("/processing-data").absolute()))),
    )
