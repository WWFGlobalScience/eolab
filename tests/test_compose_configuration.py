"""Test deployment contracts expressed by Docker Compose."""

import os
import subprocess
from pathlib import Path


COMPOSE_PATH = Path(__file__).parents[1] / "docker-compose.yml"
ENV_EXAMPLE_PATH = Path(__file__).parents[1] / ".env.example"


def test_public_app_variables_are_not_self_referential() -> None:
    """Keep Coolify deployment inputs editable instead of Compose-managed."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    variable_mappings = {
        "APP_TITLE": "EOLAB_APP_TITLE",
        "APP_SUBTITLE": "EOLAB_APP_SUBTITLE",
        "CATALOG_URL": "EOLAB_CATALOG_URL",
        "BASEMAP_URL": "EOLAB_BASEMAP_URL",
        "CARTO_BASEMAP_API_KEY": "EOLAB_CARTO_BASEMAP_API_KEY",
        "BASEMAP_ATTRIBUTION": "EOLAB_BASEMAP_ATTRIBUTION",
        "INITIAL_LATITUDE": "EOLAB_INITIAL_LATITUDE",
        "INITIAL_LONGITUDE": "EOLAB_INITIAL_LONGITUDE",
        "INITIAL_ZOOM": "EOLAB_INITIAL_ZOOM",
    }

    for container_variable, deployment_variable in variable_mappings.items():
        assert f'"{container_variable}=${{{deployment_variable}' in compose
        assert f'"{deployment_variable}=${{{deployment_variable}' not in compose

    assert (
        '"APP_SUBTITLE=${EOLAB_APP_SUBTITLE:-Explore, visualize, and analyze '
        'Earth observation data}"'
        in compose
    )


def test_default_basemap_is_attributed_opentopomap() -> None:
    """Keep the credential-free topographic default and attribution together."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    environment_example = ENV_EXAMPLE_PATH.read_text(encoding="utf-8")
    basemap_url = "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"
    required_attribution = (
        "OpenStreetMap contributors",
        "SRTM",
        "OpenTopoMap",
        "CC-BY-SA",
    )

    assert f"EOLAB_BASEMAP_URL={basemap_url}" in environment_example
    assert f"EOLAB_BASEMAP_URL:-{basemap_url}" in compose
    for attribution_text in required_attribution:
        assert attribution_text in environment_example
        assert attribution_text in compose


def test_scan_paths_share_one_read_only_deployment_mount() -> None:
    """Keep the host mount separate from container-relative scan paths."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert "source: ${EOLAB_SCAN_MOUNT_PATH}" in compose
    assert "target: /scan-source" in compose
    assert "read_only: true" in compose
    assert '"SCAN_MOUNT_PATH=/scan-source"' in compose
    assert '"SCAN_PATHS_WITHIN_MOUNT=${EOLAB_SCAN_PATHS_WITHIN_MOUNT:' in compose
    assert '"SCAN_DISPLAY_PATH_PREFIX=${EOLAB_SCAN_DISPLAY_PATH_PREFIX:' in compose
    assert '"SCAN_WORKER_COUNT=${EOLAB_SCAN_WORKER_COUNT:-8}"' in compose
    assert '"SCAN_WRITER_COUNT=${EOLAB_SCAN_WRITER_COUNT:-4}"' in compose
    assert '"SCAN_BATCH_SIZE=${EOLAB_SCAN_BATCH_SIZE:-100}"' in compose
    assert (
        '"SCAN_ERROR_DETAIL_LIMIT=${EOLAB_SCAN_ERROR_DETAIL_LIMIT:-100}"'
        in compose
    )
    assert (
        '"SCAN_RECONCILIATION_PAGE_SIZE='
        '${EOLAB_SCAN_RECONCILIATION_PAGE_SIZE:-500}"' in compose
    )
    assert (
        '"SCAN_RECONCILIATION_CONCURRENCY='
        '${EOLAB_SCAN_RECONCILIATION_CONCURRENCY:-8}"' in compose
    )
    assert (
        '"SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES='
        '${EOLAB_SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES:-1048576}"' in compose
    )
    assert (
        '"SCAN_CATALOG_WRITE_TIMEOUT_SECONDS='
        '${EOLAB_SCAN_CATALOG_WRITE_TIMEOUT_SECONDS:-120}"' in compose
    )
    assert (
        '"SCAN_CATALOG_ERROR_DETAIL_LIMIT='
        '${EOLAB_SCAN_CATALOG_ERROR_DETAIL_LIMIT:-500}"' in compose
    )
    assert '"EOLAB_SCAN_MOUNT_PATH=${EOLAB_SCAN_MOUNT_PATH' not in compose


def test_raster_capacity_is_deployer_configurable() -> None:
    """Expose safe defaults while allowing explicit deployment overrides."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert (
        '"RASTER_PIXEL_READ_CONCURRENCY='
        '${EOLAB_RASTER_PIXEL_READ_CONCURRENCY:-2}"'
        in compose
    )
    assert (
        '"RASTER_STATISTICS_READ_CONCURRENCY='
        '${EOLAB_RASTER_STATISTICS_READ_CONCURRENCY:-1}"'
        in compose
    )
    assert (
        '"RASTER_STATISTICS_CACHE_ENTRIES='
        '${EOLAB_RASTER_STATISTICS_CACHE_ENTRIES:-32}"'
        in compose
    )
    assert (
        '"COMPOSITE_TILE_CACHE_BYTES='
        '${EOLAB_COMPOSITE_TILE_CACHE_BYTES:-134217728}"'
        in compose
    )


def test_app_and_geoserver_refuse_a_writable_scan_mount() -> None:
    """Verify the effective kernel mode before either long-running service starts."""
    repository_root = COMPOSE_PATH.parent
    app_dockerfile = (repository_root / "Dockerfile.app").read_text(
        encoding="utf-8"
    )
    geoserver_dockerfile = (repository_root / "Dockerfile.geoserver").read_text(
        encoding="utf-8"
    )
    guard = (
        repository_root / "deployment" / "require-read-only-scan-source.sh"
    ).read_text(encoding="utf-8")

    assert 'ENTRYPOINT ["/usr/local/bin/require-read-only-scan-source"]' in (
        app_dockerfile
    )
    assert (
        'ENTRYPOINT ["/usr/local/bin/start-geoserver"]'
        in geoserver_dockerfile
    )
    assert 'CMD ["bash", "/opt/startup.sh"]' in geoserver_dockerfile
    assert (
        "FROM docker.osgeo.org/geoserver:3.0.1@sha256:"
        "7cb827ba3f6d9fc04a6647fc0cfa6c254fc642407f0d99281fdf026d2540b558"
        in geoserver_dockerfile
    )
    assert '/proc/self/mountinfo' in guard
    assert '/scan-source ro(,| )' in guard
    assert 'exec "$@"' in guard


def test_geoserver_requires_supported_vector_datastore_modules(
    tmp_path: Path,
) -> None:
    """Fail the image contract unless both required GeoTools modules exist.

    Args:
        tmp_path: Isolated fake GeoServer library directory.
    """
    repository_root = COMPOSE_PATH.parent
    guard_path = (
        repository_root
        / "deployment"
        / "require-geoserver-vector-datastores.sh"
    )
    (tmp_path / "gt-shapefile-35.1.jar").touch()
    shell_tmp_path = (
        f"/cygdrive/{tmp_path.drive[0].lower()}{tmp_path.as_posix()[2:]}"
        if tmp_path.drive
        else tmp_path.as_posix()
    )

    missing_geopackage = subprocess.run(
        ["sh", str(guard_path), shell_tmp_path],
        capture_output=True,
        text=True,
        check=False,
    )
    (tmp_path / "gt-geopkg-35.1.jar").touch()
    complete = subprocess.run(
        ["sh", str(guard_path), shell_tmp_path],
        capture_output=True,
        text=True,
        check=False,
    )

    assert missing_geopackage.returncode == 1
    assert "GeoPackage datastore module is missing" in missing_geopackage.stderr
    assert complete.returncode == 0


def test_geoserver_has_bounded_tunable_rendering_resources() -> None:
    """Pin render scheduling while leaving its limits deployer-configurable."""
    repository_root = COMPOSE_PATH.parent
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    geoserver_dockerfile = (repository_root / "Dockerfile.geoserver").read_text(
        encoding="utf-8"
    )
    startup = (
        repository_root / "deployment" / "start-geoserver.sh"
    ).read_text(encoding="utf-8")

    assert "cpus: ${EOLAB_GEOSERVER_CPU_LIMIT:-4}" in compose
    assert (
        '"GEOSERVER_MAX_HEAP_SIZE=${EOLAB_GEOSERVER_MAX_HEAP_SIZE:-4g}"'
        in compose
    )
    assert (
        '"GEOSERVER_WMS_RENDER_COUNT=${EOLAB_GEOSERVER_WMS_RENDER_COUNT:-2}"'
        in compose
    )
    assert (
        '"GEOSERVER_GWC_REQUEST_COUNT=${EOLAB_GEOSERVER_GWC_REQUEST_COUNT:-8}"'
        in compose
    )
    assert (
        '"GEOSERVER_WMS_QUEUE_TIMEOUT_SECONDS='
        '${EOLAB_GEOSERVER_WMS_QUEUE_TIMEOUT_SECONDS:-10}"' in compose
    )
    assert "geoserver-3.0.1-control-flow-plugin.zip" in geoserver_dockerfile
    assert (
        "sha256:08e1c95e0f753fa6b63f815d3314764d891d9cf1bee418dcae6"
        "ea5bf25025a1d"
        in geoserver_dockerfile
    )
    assert (
        'export EXTRA_JAVA_OPTS="-Xms256m -Xmx${GEOSERVER_MAX_HEAP_SIZE} '
        in startup
    )
    assert "'^[1-9][0-9]*$'" in startup
    assert "'^[1-9][0-9]*[mMgG]$'" in startup
    assert 'if [ "$heap_megabytes" -lt 256 ]' in startup
    assert "printf 'ows.gwc=%s\\nows.wms.getmap=%s\\ntimeout=%s\\n'" in startup
    assert "ActiveProcessorCount" not in compose
    assert "ActiveProcessorCount" not in geoserver_dockerfile


def test_geoserver_exports_only_allowlisted_jvm_metrics_internally() -> None:
    """Pin JVM instrumentation without publishing its raw Prometheus endpoint."""
    repository_root = COMPOSE_PATH.parent
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    geoserver_dockerfile = (repository_root / "Dockerfile.geoserver").read_text(
        encoding="utf-8"
    )
    startup = (
        repository_root / "deployment" / "start-geoserver.sh"
    ).read_text(encoding="utf-8")
    exporter_configuration = (
        repository_root / "geoserver" / "jmx-exporter.yml"
    ).read_text(encoding="utf-8")
    geoserver_service = compose.split("  geoserver:\n", 1)[1].split(
        "  geoserver-init:\n", 1
    )[0]
    app_service = compose.split("  app:\n", 1)[1].split("\nvolumes:\n", 1)[0]

    assert "jmx_prometheus_javaagent-1.6.0.jar" in geoserver_dockerfile
    assert (
        "sha256:a95983fd96e865d2bcdf911cc500e7c82808c27ab9fd226bf96732b6c3d8c46e"
        in geoserver_dockerfile
    )
    assert "COPY --chmod=0444 geoserver/jmx-exporter.yml" in geoserver_dockerfile
    assert (
        "-javaagent:/opt/eolab-jmx/jmx_prometheus_javaagent-1.6.0.jar="
        "0.0.0.0:9404:/opt/eolab-jmx/jmx-exporter.yml"
        in startup
    )
    assert '"9404"' in geoserver_service
    assert "ports:" not in geoserver_service
    assert (
        '"GEOSERVER_METRICS_INTERNAL_URL=http://geoserver:9404/metrics"'
        in app_service
    )
    assert "/var/run/docker.sock" not in compose

    assert "includeObjectNames:" in exporter_configuration
    assert "excludeJvmMetrics: true" not in exporter_configuration
    assert 'pattern: ".*"' not in exporter_configuration
    for metric_name in (
        "eolab_jvm_heap_used_bytes",
        "eolab_jvm_heap_committed_bytes",
        "eolab_jvm_heap_max_bytes",
        "eolab_jvm_process_cpu_load_ratio",
        "eolab_jvm_live_threads",
        "eolab_jvm_uptime_seconds",
    ):
        assert metric_name in exporter_configuration
    assert "GarbageCollector" not in exporter_configuration
    assert "eolab_jvm_gc_" not in exporter_configuration


def test_geoserver_rejects_invalid_runtime_limits() -> None:
    """Fail startup before Java receives malformed or unusable limits."""
    repository_root = COMPOSE_PATH.parent
    base_environment = os.environ | {
        "GEOSERVER_WMS_RENDER_COUNT": "2",
        "GEOSERVER_GWC_REQUEST_COUNT": "8",
        "GEOSERVER_WMS_QUEUE_TIMEOUT_SECONDS": "10",
        "GEOSERVER_MAX_HEAP_SIZE": "4g",
    }
    invalid_limits = (
        (
            {"GEOSERVER_WMS_RENDER_COUNT": "0"},
            "GEOSERVER_WMS_RENDER_COUNT must be a positive integer",
        ),
        (
            {"GEOSERVER_GWC_REQUEST_COUNT": "0"},
            "GEOSERVER_GWC_REQUEST_COUNT must be a positive integer",
        ),
        (
            {"GEOSERVER_WMS_QUEUE_TIMEOUT_SECONDS": "0"},
            "GEOSERVER_WMS_QUEUE_TIMEOUT_SECONDS must be a positive integer",
        ),
        (
            {"GEOSERVER_MAX_HEAP_SIZE": "4g -XX:ActiveProcessorCount=32"},
            "GEOSERVER_MAX_HEAP_SIZE must be an integer followed by m or g",
        ),
        (
            {"GEOSERVER_MAX_HEAP_SIZE": "128m"},
            "GEOSERVER_MAX_HEAP_SIZE must be at least 256m",
        ),
    )

    for environment_override, expected_error in invalid_limits:
        result = subprocess.run(
            ["sh", "deployment/start-geoserver.sh", "true"],
            cwd=repository_root,
            env=base_environment | environment_override,
            capture_output=True,
            text=True,
            check=False,
        )

        assert result.returncode == 1
        assert result.stderr.strip() == expected_error


def test_app_image_avoids_repeated_gdal_directory_listing() -> None:
    """Avoid enumerating large mounted directories for every dataset open."""
    dockerfile = (COMPOSE_PATH.parent / "Dockerfile.app").read_text(
        encoding="utf-8"
    )

    assert "GDAL_DISABLE_READDIR_ON_OPEN=TRUE" in dockerfile


def test_app_can_inventory_existing_catalog_items() -> None:
    """Give the app database access to classify existing scanner Items."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert '"PGHOST=database"' in compose
    assert '"PGPORT=5432"' in compose
    assert '"PGDATABASE=eolab"' in compose
    assert '"PGUSER=eolab"' in compose
    assert '"PGPASSWORD=${EOLAB_DATABASE_PASSWORD:' in compose


def test_internal_stac_api_enables_writes_for_scanning() -> None:
    """Enable internal transaction routes while the app proxy remains read-only."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert '"ENABLE_TRANSACTIONS_EXTENSIONS=TRUE"' in compose


def test_geoserver_is_internal_persistent_and_reads_the_scan_mount() -> None:
    """Keep GeoServer private while preserving its config and shared datasets."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    geoserver_service = compose.split("  geoserver:\n", 1)[1].split(
        "  geoserver-init:\n", 1
    )[0]

    assert "dockerfile: Dockerfile.geoserver" in geoserver_service
    assert "ports:" not in geoserver_service
    assert '"8080"' in geoserver_service
    assert "source: ${EOLAB_SCAN_MOUNT_PATH}" in geoserver_service
    assert "target: /scan-source" in geoserver_service
    assert "read_only: true" in geoserver_service
    assert "geoserver-data:/opt/geoserver_data" in geoserver_service
    assert '"GEOWEBCACHE_CACHE_DIR=/opt/geoserver_data/gwc-cache"' in (
        geoserver_service
    )
    assert '"RUN_UNPRIVILEGED=true"' in geoserver_service
    assert '"SKIP_DEMO_DATA=true"' in geoserver_service
    assert '"CORS_ENABLED=false"' in geoserver_service
    assert '"JSONP_ENABLED=false"' in geoserver_service
    assert '"JAVA_TOOL_OPTIONS=-XX:+ExitOnOutOfMemoryError"' in geoserver_service
    assert (
        '"PROXY_BASE_URL=$${X-Forwarded-Proto}://$${X-Forwarded-Host}/geoserver '
        'http://geoserver:8080/geoserver"'
        in geoserver_service
    )
    assert '"PROXY_BASE_URL_HEADERS=true"' in geoserver_service
    assert '"GEOSERVER_ADMIN_PASSWORD=${EOLAB_GEOSERVER_ADMIN_PASSWORD:' in (
        geoserver_service
    )
    assert "start_period: 120s" in geoserver_service
    assert "name: ${EOLAB_GEOSERVER_DATA_VOLUME_NAME:-eolab-geoserver-data}" in (
        compose
    )


def test_geoserver_initializer_is_idempotent_image_owned_configuration() -> None:
    """Package bootstrap assets and gate them on a healthy GeoServer."""
    repository_root = COMPOSE_PATH.parent
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    initializer = (repository_root / "geoserver" / "initialize.py").read_text(
        encoding="utf-8"
    )
    initializer_dockerfile = (
        repository_root / "Dockerfile.geoserver-init"
    ).read_text(encoding="utf-8")

    assert "dockerfile: Dockerfile.geoserver-init" in compose
    assert "condition: service_healthy" in compose
    assert '"GEOSERVER_MASTER_PASSWORD=${EOLAB_GEOSERVER_MASTER_PASSWORD:' in compose
    assert "COPY geoserver/ ./" in initializer_dockerfile
    assert (
        "COPY src/eolab_infrastructure/ ./eolab_infrastructure/"
        in initializer_dockerfile
    )
    assert 'client.request("DELETE"' not in initializer
    assert "WORKSPACE_NAME = GEOSERVER_WORKSPACE_NAME" in initializer
    assert 'RASTER_STYLE_NAME = "dynamic-raster"' in initializer
    shared_documents = (
        repository_root
        / "src"
        / "eolab_infrastructure"
        / "geowebcache_documents.py"
    ).read_text(encoding="utf-8")
    assert 'GEOWEBCACHE_GRIDSET_NAME = "EPSG:3857"' in shared_documents
    assert (
        '"GEOWEBCACHE_DISK_QUOTA_GIB='
        '${EOLAB_GEOWEBCACHE_DISK_QUOTA_GIB:-25}"' in compose
    )
    gwc_configuration = (
        repository_root / "geoserver" / "gwc-gs.xml"
    ).read_text(encoding="utf-8")
    assert "<directWMSIntegrationEnabled>true" in gwc_configuration
    assert "<requireTiledParameter>true" in gwc_configuration
    assert "EPSG:3857" in gwc_configuration
    assert "900913" not in gwc_configuration


def test_app_keeps_geoserver_registration_credentials_internal() -> None:
    """Give the backend REST access without exposing the keystore secret."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    app_service = compose.split("  app:\n", 1)[1].split("\nvolumes:\n", 1)[0]

    assert '"WMS_URL=/geoserver/eolab/wms"' in app_service
    assert '"GEOSERVER_INTERNAL_URL=http://geoserver:8080/geoserver"' in app_service
    assert '"GEOSERVER_ADMIN_USER=eolab"' in app_service
    assert '"GEOSERVER_ADMIN_PASSWORD=${EOLAB_GEOSERVER_ADMIN_PASSWORD:' in app_service
    assert "EOLAB_GEOSERVER_MASTER_PASSWORD" not in app_service
    assert "depends_on:" not in app_service


def test_catalog_migrator_packages_application_migrations() -> None:
    """Apply EOLab indexes after the pinned pgSTAC schema migration."""
    repository_root = COMPOSE_PATH.parent
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    dockerfile = (repository_root / "Dockerfile.catalog-migrate").read_text(
        encoding="utf-8"
    )
    migration_script = (repository_root / "catalog" / "migrate.sh").read_text(
        encoding="utf-8"
    )
    index_migration = (
        repository_root
        / "catalog"
        / "migrations"
        / "0001_item_substring_indexes.sql"
    ).read_text(encoding="utf-8")

    assert "dockerfile: Dockerfile.catalog-migrate" in compose
    assert "pypgstac migrate" in migration_script
    assert "psql --set=ON_ERROR_STOP=1" in migration_script
    assert "COPY catalog/migrations/ /catalog/migrations/" in dockerfile
    assert "pgstac.get_version() <> '0.9.12'" in index_migration
    assert "CREATE EXTENSION IF NOT EXISTS pg_trgm" in index_migration
    assert "eolab_items_title_trgm_idx" in index_migration
    assert "eolab_items_description_trgm_idx" in index_migration
    assert index_migration.count("USING GIN") == 2
    assert index_migration.count("gin_trgm_ops") == 2
    assert "upper(pgstac.to_text(content->'properties'->'title'))" in index_migration
    assert (
        "upper(pgstac.to_text(content->'properties'->'description'))"
        in index_migration
    )


def test_catalog_migrator_adds_datetime_substring_queryables() -> None:
    """Expose standard STAC datetime values as indexed text queryables."""
    migration = (
        COMPOSE_PATH.parent
        / "catalog"
        / "migrations"
        / "0003_datetime_substring_indexes.sql"
    ).read_text(encoding="utf-8")

    assert "eolab_datetime_text" in migration
    assert "eolab_end_datetime_text" in migration
    assert "MERGE INTO pgstac.queryables" not in migration
    assert "IF has_datetime_queryable <> has_end_datetime_queryable" in migration
    assert "IF NOT has_datetime_queryable THEN" in migration
    assert "NULLIF(content->'properties'->'datetime', 'null'::jsonb)" in migration
    assert "content->'properties'->'start_datetime'" in migration
    assert "eolab_items_datetime_text_trgm_idx" in migration
    assert "eolab_items_end_datetime_text_trgm_idx" in migration
    assert migration.count("USING GIN") == 2
    assert migration.count("gin_trgm_ops") == 2


def test_catalog_migrator_hides_datetime_paths_from_pgstac_indexes() -> None:
    """Keep application trigram indexes outside pgSTAC's index ownership."""
    migration = (
        COMPOSE_PATH.parent
        / "catalog"
        / "migrations"
        / "0004_datetime_index_wrappers.sql"
    ).read_text(encoding="utf-8")

    assert "eolab_item_datetime_text(item_content jsonb)" in migration
    assert "eolab_item_end_datetime_text" in migration
    assert "property_path = 'content'" in migration
    assert "upper(pgstac.eolab_item_datetime_text(content))" in migration
    assert "upper(pgstac.eolab_item_end_datetime_text(content))" in migration
    assert migration.count("gin_trgm_ops") == 2


def test_catalog_migrator_indexes_data_asset_media_type() -> None:
    """Expose the authoritative nested Asset type as an indexed queryable."""
    migration = (
        COMPOSE_PATH.parent
        / "catalog"
        / "migrations"
        / "0005_data_asset_media_type_queryable.sql"
    ).read_text(encoding="utf-8")

    assert "pgstac.get_version() <> '0.9.12'" in migration
    assert (
        "CREATE OR REPLACE FUNCTION pgstac.eolab_data_asset_media_type"
        not in migration
    )
    assert "DROP FUNCTION pgstac.eolab_data_asset_media_type(jsonb)" in migration
    assert "'eolab_data_asset_media_type'" in migration
    assert "'assets.data.type'" in migration
    assert "existing_queryable.property_path IS NOT NULL" in migration
    assert "existing_queryable.property_wrapper IS NOT NULL" in migration
    assert "property_index_type IS NOT NULL" in migration
    assert "eolab_items_data_asset_media_type_idx" in migration
    assert (
        "pgstac.to_text(content->'assets'->'data'->'type')"
        in migration
    )


def test_stac_api_uses_the_pinned_upstream_image() -> None:
    """Use upstream CQL2 Filter support without a custom API image."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")

    assert "stac-fastapi-pgstac:6.3.1@sha256:" in compose
    assert "dockerfile: Dockerfile.stac-api" not in compose


def test_catalog_random_selection_uses_an_indexed_key_seek() -> None:
    """Seek from a random key without counting, sorting, or skipping rows."""
    migration = (
        COMPOSE_PATH.parent
        / "catalog"
        / "migrations"
        / "0006_random_matching_item.sql"
    ).read_text(encoding="utf-8")

    assert "pgstac.get_version() <> '0.9.12'" in migration
    assert "pgstac.stac_search_to_where(search_request)" in migration
    assert "SET search_path TO pgstac, public" in migration
    assert "pgstac.content_hydrate(item)" in migration
    assert "CREATE INDEX IF NOT EXISTS eolab_items_random_key_idx" in migration
    assert "md5(collection || ':' || id) >= $3" in migration
    assert "md5(collection || ':' || id) < $3" in migration
    assert "count(*)" not in migration
    assert "OFFSET" not in migration
    assert "ORDER BY random()" not in migration


def test_carto_basemap_key_is_optional() -> None:
    """Allow deployment without a CARTO key and document its browser-visible use."""
    compose = COMPOSE_PATH.read_text(encoding="utf-8")
    example = ENV_EXAMPLE_PATH.read_text(encoding="utf-8")
    assert '"CARTO_BASEMAP_API_KEY=${EOLAB_CARTO_BASEMAP_API_KEY:-}"' in compose
    assert "EOLAB_CARTO_BASEMAP_API_KEY=\n" in example
    assert "basemap key is browser-visible" in example
