"""Protect processing, neutral mechanisms, and existing sibling boundaries."""

import ast
from pathlib import Path
import subprocess
import sys

import yaml


def imports(path: Path) -> set[str]:
    """Read actual static imports for an architectural boundary assertion.

    Args:
        path: Python source module.

    Returns:
        Imported module names, including direct import statements.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return {
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module
    } | {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    }


def test_processing_has_no_histogram_renderer_or_aoi_implementation_dependency() -> (
    None
):
    """Processing consumes source/area values without sibling implementation state."""
    forbidden = (
        "eolab_app.rendering",
        "eolab_app.temporary_aoi",
        "eolab_app.raster.statistics",
        "eolab_app.raster.pixel",
        "eolab_app.raster.geoserver",
        "eolab_app.raster.publication",
        "eolab_app.raster.detail",
        "eolab_app.raster.assessment",
        "eolab_app.catalog.pgstac",
    )
    for path in Path("src/eolab_app/processing").glob("*.py"):
        assert not {
            module for module in imports(path) if module.startswith(forbidden)
        }, path


def test_hydrology_sources_use_neutral_readers_without_sibling_services() -> None:
    """Hydrology source access stays independent of renderer and catalog storage."""
    for name in (
        "prepared_hydrology.py",
        "downstream_calculation.py",
        "downstream_operation.py",
    ):
        dependencies = imports(Path("src/eolab_app/processing") / name)
        assert not {
            module
            for module in dependencies
            if module.startswith(
                (
                    "eolab_app.vector.",
                    "eolab_app.rendering.",
                    "eolab_app.routes.",
                    "eolab_app.catalog.pgstac",
                    "eolab_app.processing.service",
                    "eolab_app.raster.geoserver",
                    "eolab_app.raster.publication",
                )
            )
        }
    reader = imports(Path("src/eolab_app/bounded_vector.py"))
    assert not {
        module for module in reader if module.startswith("eolab_app.processing")
    }
    assert not {
        module
        for module in imports(Path("src/eolab_app/attribute_filter.py"))
        if module.startswith(("eolab_app.processing", "eolab_app.vector"))
    }


def test_shared_worker_does_not_import_downstream_settings() -> None:
    """Keep downstream numerical configuration out of shared execution capabilities."""
    for name in ("worker.py", "operation_context.py"):
        dependencies = imports(Path("src/eolab_app/processing") / name)
        assert not {
            module
            for module in dependencies
            if module.startswith("eolab_app.processing.downstream")
        }, name


def test_mechanisms_and_storage_never_import_application_services() -> None:
    """Keep neutral native execution and storage below their workflow owners."""
    paths = [
        Path("src/eolab_app/execution/bounded_process.py"),
        Path("src/eolab_app/raster/bounded_window.py"),
        Path("src/eolab_app/processing/job_store.py"),
        Path("src/eolab_app/processing/job_notifications.py"),
        Path("src/eolab_app/processing/job_events.py"),
        Path("src/eolab_app/processing/artifacts.py"),
        Path("src/eolab_app/processing/raster_clip.py"),
        Path("src/eolab_app/processing/raster_aggregate.py"),
        Path("src/eolab_app/processing/raster_expression.py"),
        Path("src/eolab_app/processing/raster_input.py"),
        Path("src/eolab_app/processing/ground_area.py"),
        Path("src/eolab_app/processing/area_coverage.py"),
        Path("src/eolab_app/processing/aggregate_windows.py"),
        Path("src/eolab_app/raster/source_contract.py"),
        Path("src/eolab_app/source_files.py"),
        Path("src/eolab_app/raster/source_access.py"),
    ]
    for path in paths:
        assert not {
            module
            for module in imports(path)
            if module.endswith((".service", "_service", ".worker"))
        }, path
    assert not {
        module for module in imports(paths[0]) if module.startswith("eolab_app")
    }
    assert not {
        module
        for module in imports(Path("src/eolab_app/execution/reusable_process.py"))
        if module.startswith("eolab_app")
        and not module.startswith("eolab_app.execution.")
    }
    assert not {
        module
        for module in imports(paths[1])
        if module.startswith(("eolab_app.processing", "eolab_app.temporary_aoi"))
    }


def test_shared_raster_access_has_no_private_storage_or_renderer_dependency() -> None:
    """Source access consumes injected file ports without importing their feature owner."""
    forbidden = (
        "eolab_app.processing",
        "eolab_app.rendering",
        "eolab_app.routes.processing",
        "eolab_app.raster.geoserver",
        "eolab_app.raster.publication",
    )
    for name in (
        "source_files.py",
        "raster/source_access.py",
        "raster/source_models.py",
        "raster/source_contract.py",
        "raster/pixel.py",
        "raster/pixel_service.py",
        "raster/statistics_service.py",
        "routes/raster_analysis.py",
    ):
        path = Path("src/eolab_app") / name
        assert not {
            module for module in imports(path) if module.startswith(forbidden)
        }, path
    assert not {
        module
        for module in imports(Path("src/eolab_app/source_files.py"))
        if module.startswith("eolab_app.")
    }


def test_processing_deployment_preserves_concurrency_without_work_ceilings() -> None:
    """Check Processing's own execution policy without reading Jobs settings."""
    services = yaml.safe_load(Path("docker-compose.yml").read_text())["services"]
    worker = services["processing-worker"]
    assert worker["command"] == ["python", "-m", "eolab_app.worker_cli"]
    assert worker["cpus"] == 2
    assert not {"mem_limit", "memswap_limit", "pids_limit"}.intersection(worker)
    limits = worker.get("deploy", {}).get("resources", {}).get("limits", {})
    assert not {"memory", "pids"}.intersection(limits)
    environment = dict(entry.split("=", 1) for entry in worker["environment"])
    # Processing exposes storage, concurrency and retention,
    # not total calculation budgets. New settings must preserve that policy.
    assert {name for name in environment if name.startswith("PROCESSING_")} == {
        "PROCESSING_DATA_PATH",
        "PROCESSING_WORKER_COUNT",
        "PROCESSING_RESULT_TTL_SECONDS",
        "PROCESSING_METADATA_TTL_SECONDS",
    }
    assert (
        environment["PROCESSING_WORKER_COUNT"] == "${EOLAB_PROCESSING_WORKER_COUNT-1}"
    )
    assert not any(name.startswith("GEOSERVER") for name in environment)


def test_processing_deployment_preserves_source_and_artifact_mount_ownership() -> None:
    """Require read-only source access and writable artifacts only for the worker."""
    services = yaml.safe_load(Path("docker-compose.yml").read_text())["services"]
    worker_mounts = services["processing-worker"]["volumes"]
    source_mounts = [
        mount
        for mount in worker_mounts
        if isinstance(mount, dict) and mount.get("target") == "/scan-source"
    ]
    assert source_mounts == [
        {
            "type": "bind",
            "source": "${EOLAB_SCAN_MOUNT_PATH}",
            "target": "/scan-source",
            "read_only": True,
        }
    ]
    assert "processing-data:/processing-data" in worker_mounts
    assert "habitat-credentials:/run/habitat-credentials:ro" in worker_mounts
    for name, service in services.items():
        if name != "processing-worker":
            assert not any(
                (
                    mount.split(":", 1)[0]
                    if isinstance(mount, str)
                    else mount.get("source")
                )
                == "habitat-credentials"
                for mount in service.get("volumes", ())
            ), name
    for name in ("app", "geoserver"):
        assert "processing-data:/processing-data:ro" in services[name]["volumes"], name


def test_jobs_deployment_keeps_its_own_resource_and_filesystem_limits() -> None:
    """Protect the bounded Jobs service independently of Processing calculations."""
    jobs = yaml.safe_load(Path("docker-compose.yml").read_text())["services"]["jobs"]
    assert jobs["mem_limit"] == "2g"
    assert jobs["memswap_limit"] == "2g"
    assert jobs["cpus"] == 1
    assert jobs["pids_limit"] == 32
    assert jobs["read_only"] is True


def test_processing_schema_is_independent_of_catalog_storage() -> None:
    """Keep Processing tables in their own schema without pgSTAC dependencies."""
    sql = Path("src/eolab_app/processing/schema.sql").read_text()
    assert "pgstac." not in sql.lower()
    assert "CREATE SCHEMA IF NOT EXISTS processing" in sql


def test_spawned_worker_entry_does_not_import_application_composition() -> None:
    """Child startup must not reload web routes, services or their model graphs."""
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import runpy, sys; "
            "runpy.run_module('eolab_app.worker_cli', run_name='__mp_main__'); "
            "assert 'eolab_app.main' not in sys.modules; "
            "assert 'fastapi' not in sys.modules; "
            "assert 'eolab_app.processing.worker' not in sys.modules",
        ],
        check=True,
        timeout=15,
    )


def test_shared_job_models_and_storage_do_not_depend_on_clip_models() -> None:
    """Keep reusable lifecycle contracts independent of any operation's schema."""
    for name in (
        "models.py",
        "ports.py",
        "job_store.py",
        "job_notifications.py",
        "job_events.py",
        "artifacts.py",
        "artifact_manifest.py",
    ):
        dependencies = imports(Path("src/eolab_app/processing") / name)
        assert "eolab_app.processing.clip_models" not in dependencies
        assert "eolab_app.processing.aggregate_models" not in dependencies
        assert not {
            module for module in dependencies if module.startswith("eolab_app.raster")
        }
        assert not {
            module
            for module in dependencies
            if module.startswith(
                (
                    "eolab_app.processing.model_",
                    "eolab_app.catalog",
                    "eolab_app.rendering",
                )
            )
        }


def test_fractional_mask_is_numerical_and_has_no_geometry_or_service_dependency() -> (
    None
):
    """Raster masks consume oriented coordinates rather than pixel geometries."""
    dependencies = imports(Path("src/eolab_app/processing/area_coverage.py"))
    assert not {
        module
        for module in dependencies
        if module.startswith(("eolab_app", "shapely", "rasterio", "pyproj"))
    }


def test_direct_selection_mechanisms_have_no_feature_or_rendering_imports() -> None:
    """Neutral source contracts stay below Catalog, rendering, and numeric owners."""
    pending = [
        Path("src/eolab_app/catalog_selection.py"),
        Path("src/eolab_app/attribute_filter.py"),
        Path("src/eolab_app/bounded_vector.py"),
    ]
    visited = set()
    forbidden = (
        "eolab_app.vector",
        "eolab_app.rendering",
        "eolab_app.processing",
        "eolab_app.routes",
        "eolab_app.raster.statistics",
        "eolab_app.raster.pixel",
        "eolab_app.raster.geoserver",
        "eolab_app.raster.publication",
    )
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        visited.add(path)
        dependencies = imports(path)
        assert not {name for name in dependencies if name.startswith(forbidden)}, path
        for name in dependencies:
            if name.startswith("eolab_app."):
                dependency = Path("src", *name.split(".")).with_suffix(".py")
                if dependency.is_file():
                    pending.append(dependency)


def test_retired_upload_runtime_is_absent() -> None:
    """Keep retired AOI uploads absent while allowing local annotation file imports."""
    assert not list(Path("src/eolab_app/temporary_aoi").glob("*.py"))
    assert not Path("src/eolab_app/routes/temporary_aois.py").exists()
    assert not list(Path("frontend/src/temporary-aoi").glob("*.js"))
    for path in [*Path("src").rglob("*.py"), *Path("frontend/src").rglob("*.js")]:
        source = path.read_text(encoding="utf8")
        assert "TemporaryAoi" not in source, path
        if path != Path("src/eolab_app/processing/service.py"):
            assert "temporaryAoiId" not in source, path
    markup = Path("frontend/index.html").read_text(encoding="utf8")
    for retired_control in ("Upload AOI", "temporary-aoi", "temporaryAoi"):
        assert retired_control not in markup
    compose = Path("docker-compose.yml").read_text()
    assert "TEMPORARY_AOI" not in compose


def test_storage_and_native_mechanisms_do_not_know_model_definitions() -> None:
    """Model dispatch remains above opaque persistence and native execution ports."""
    for path in (
        "src/eolab_app/processing/job_store.py",
        "src/eolab_app/processing/artifacts.py",
        "src/eolab_app/processing/raster_clip.py",
        "src/eolab_app/processing/raster_aggregate.py",
        "src/eolab_app/processing/models.py",
        "src/eolab_app/processing/ports.py",
        "src/eolab_app/execution/reusable_process.py",
        "src/eolab_app/execution/bounded_process.py",
        "src/eolab_app/raster/source_contract.py",
    ):
        assert not {
            name
            for name in imports(Path(path))
            if name.startswith("eolab_app.processing.model_")
        }, path


def test_model_submission_uses_registered_operations_not_native_implementations() -> (
    None
):
    """Recipe binding and result serialization cannot select native algorithms themselves."""
    dependencies = imports(Path("src/eolab_app/processing/model_runs.py"))
    assert not dependencies.intersection(
        {
            "eolab_app.processing.clip_models",
            "eolab_app.processing.aggregate_models",
            "eolab_app.processing.raster_clip",
            "eolab_app.processing.raster_aggregate",
        }
    )


def test_generic_model_contracts_delegate_domain_knowledge_to_operations() -> None:
    """Keep operation-specific schemas and names out of generic recipe and run code."""
    for name in ("model_definitions.py", "model_runs.py", "model_run_contracts.py"):
        path = Path("src/eolab_app/processing") / name
        source = path.read_text(encoding="utf-8").lower()
        for domain_name in ("hydrology", "downstream", "mask_source"):
            assert domain_name not in source, (path, domain_name)
