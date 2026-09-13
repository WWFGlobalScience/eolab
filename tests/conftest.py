"""Shared application-factory fixtures for route and composition tests."""

from pathlib import Path

import pytest


DEFAULT_ENVIRONMENT = {
    "APP_TITLE": "EOLab",
    "APP_SUBTITLE": "Explore, visualize, and analyze Earth observation data",
    "CATALOG_URL": "/stac",
    "CATALOG_INTERNAL_URL": "http://stac-api:8080",
    "WMS_URL": "/geoserver/eolab/wms",
    "GEOSERVER_INTERNAL_URL": "http://geoserver:8080/geoserver",
    "GEOSERVER_METRICS_INTERNAL_URL": "http://geoserver:9404/metrics",
    "GEOSERVER_WMS_RENDER_COUNT": "2",
    "COMPOSITE_TILE_CACHE_BYTES": "134217728",
    "RASTER_PIXEL_READ_CONCURRENCY": "2",
    "RASTER_STATISTICS_READ_CONCURRENCY": "1",
    "RASTER_STATISTICS_CACHE_ENTRIES": "32",
    "GEOSERVER_ADMIN_USER": "eolab",
    "GEOSERVER_ADMIN_PASSWORD": "valid-admin-password",
    "JOBS_TOKEN": "test-outline-" + "a" * 40,
    "SCAN_MOUNT_PATH": str(Path.cwd()),
    "SCAN_PATHS_WITHIN_MOUNT": '["."]',
    "SCAN_DISPLAY_PATH_PREFIX": "bigboi -- Z:\\bigbucket",
    "SCAN_WORKER_COUNT": "8",
    "SCAN_WRITER_COUNT": "4",
    "SCAN_BATCH_SIZE": "100",
    "SCAN_ERROR_DETAIL_LIMIT": "100",
    "SCAN_RECONCILIATION_PAGE_SIZE": "500",
    "SCAN_RECONCILIATION_CONCURRENCY": "8",
    "SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES": "1048576",
    "SCAN_CATALOG_WRITE_TIMEOUT_SECONDS": "120",
    "SCAN_CATALOG_ERROR_DETAIL_LIMIT": "500",
    "BASEMAP_URL": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    "BASEMAP_ATTRIBUTION": "&copy; OpenStreetMap contributors",
    "INITIAL_LATITUDE": "20",
    "INITIAL_LONGITUDE": "0",
    "INITIAL_ZOOM": "2",
}


def pytest_addoption(parser: pytest.Parser) -> None:
    """Expose an explicit disposable database for real processing tests.

    Args:
        parser: Pytest command-line option registrar.
    """
    parser.addoption("--processing-dsn", default=None,
                     help="Disposable PostgreSQL DSN; database name must start eolab_processing_test")


@pytest.fixture
def configured_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set the complete default deployment environment for a test.

    Args:
        monkeypatch: Pytest environment mutation fixture.
    """
    for environment_variable_name, environment_variable_value in (
        DEFAULT_ENVIRONMENT.items()
    ):
        monkeypatch.setenv(
            environment_variable_name,
            environment_variable_value,
        )


@pytest.fixture
def version_file_path(tmp_path: Path) -> Path:
    """Create a representative Git-derived application version file.

    Args:
        tmp_path: Isolated test directory.

    Returns:
        Path to a nonempty version file.
    """
    version_path = tmp_path / "version"
    version_path.write_text("0.5.0-2-gabcdef0\n", encoding="utf-8")
    return version_path
