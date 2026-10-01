"""Protect processing, neutral mechanisms, and existing sibling boundaries."""

import ast
from pathlib import Path
import subprocess
import sys


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


def test_processing_deployment_is_separate_bounded_and_source_read_only() -> None:
    """Protect worker isolation and private artifact-volume ownership."""
    compose = Path("docker-compose.yml").read_text()
    worker = compose.split("  processing-worker:\n", 1)[1].split("\n  app:\n", 1)[0]
    app = compose.split("\n  app:\n", 1)[1].split("\nvolumes:\n", 1)[0]
    assert 'command: ["python", "-m", "eolab_app.worker_cli"]' in worker
    assert "mem_limit: 2g" in worker
    assert "cpus: 2" in worker
    assert "read_only: true" in worker
    assert "processing-data:/processing-data" in worker
    assert "processing-data:/processing-data:ro" in app
    assert "GEOSERVER" not in worker
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
    ):
        dependencies = imports(Path("src/eolab_app/processing") / name)
        assert "eolab_app.processing.clip_models" not in dependencies
        assert "eolab_app.processing.aggregate_models" not in dependencies
        assert not {
            module for module in dependencies if module.startswith("eolab_app.raster")
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
