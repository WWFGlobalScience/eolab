"""Protect application boundaries against architectural drift."""

import ast
from pathlib import Path


APPLICATION_SOURCE = Path("src/eolab_app")
GEOSERVER_INITIALIZER = Path("geoserver/initialize.py")
SHARED_GEOWEBCACHE_DOCUMENTS = Path(
    "src/eolab_infrastructure/geowebcache_documents.py"
)
ROOT_GENERIC_MODULE_NAMES = {
    "constants.py",
    "helpers.py",
    "utilities.py",
    "utils.py",
}


def imported_modules(source_path: Path) -> set[str]:
    """Return absolute modules imported by one Python source file.

    Args:
        source_path: Python module to parse.

    Returns:
        Absolute import names declared by the module.
    """
    syntax_tree = ast.parse(source_path.read_text(encoding="utf-8"))
    modules = set()
    for node in ast.walk(syntax_tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            modules.add(node.module)
    return modules


def reads_process_environment(source_path: Path) -> bool:
    """Report whether a module reads ``os.environ`` or calls ``os.getenv``.

    Both direct imports and aliased imports are recognized so the guardrail
    expresses the configuration boundary rather than one import style.

    Args:
        source_path: Python module to inspect.

    Returns:
        Whether the module contains a process-environment access.
    """
    syntax_tree = ast.parse(source_path.read_text(encoding="utf-8"))
    os_module_names = {"os"}
    environment_names: set[str] = set()
    for node in syntax_tree.body:
        if isinstance(node, ast.Import):
            os_module_names.update(
                alias.asname or alias.name
                for alias in node.names
                if alias.name == "os"
            )
        elif isinstance(node, ast.ImportFrom) and node.module == "os":
            environment_names.update(
                alias.asname or alias.name
                for alias in node.names
                if alias.name in {"environ", "getenv"}
            )

    for node in ast.walk(syntax_tree):
        if isinstance(node, ast.Name) and node.id in environment_names:
            return True
        if not isinstance(node, ast.Attribute):
            continue
        if (
            isinstance(node.value, ast.Name)
            and node.value.id in os_module_names
            and node.attr in {"environ", "getenv"}
        ):
            return True
    return False


def test_settings_is_the_only_application_environment_boundary() -> None:
    """Require features to receive validated dependencies from composition."""
    environment_readers = {
        source_path.relative_to(APPLICATION_SOURCE).as_posix()
        for source_path in APPLICATION_SOURCE.rglob("*.py")
        if reads_process_environment(source_path)
    }

    assert environment_readers == {"settings.py"}
    settings_consumers = {
        source_path.relative_to(APPLICATION_SOURCE).as_posix()
        for source_path in APPLICATION_SOURCE.rglob("*.py")
        if "eolab_app.settings" in imported_modules(source_path)
    }
    assert settings_consumers == {"main.py"}


def test_deployment_and_asset_tools_do_not_enter_the_runtime_package() -> None:
    """Keep standalone GeoServer and icon programs outside application code."""
    application_imports = {
        imported_module
        for source_path in APPLICATION_SOURCE.rglob("*.py")
        for imported_module in imported_modules(source_path)
    }

    assert not any(
        imported_module == "geoserver"
        or imported_module.startswith("geoserver.")
        or imported_module == "icon"
        or imported_module.startswith("icon.")
        for imported_module in application_imports
    )
    assert not any(
        imported_module == "eolab_app"
        or imported_module.startswith("eolab_app.")
        for imported_module in imported_modules(GEOSERVER_INITIALIZER)
    )
    assert not (APPLICATION_SOURCE / "icon.py").exists()
    assert not (APPLICATION_SOURCE / "icon").exists()


def test_geowebcache_documents_are_neutral_shared_infrastructure() -> None:
    """Keep the shared cache contract free of either caller's dependencies."""
    assert imported_modules(SHARED_GEOWEBCACHE_DOCUMENTS) == {"xml.etree"}
    assert "eolab_infrastructure.geowebcache_documents" in imported_modules(
        GEOSERVER_INITIALIZER
    )
    for publisher_path in (
        APPLICATION_SOURCE / "rendering" / "geoserver.py",
        APPLICATION_SOURCE / "rendering" / "geowebcache.py",
    ):
        assert "eolab_infrastructure.geowebcache_documents" in imported_modules(
            publisher_path
        )


def test_application_root_has_no_generic_shared_module() -> None:
    """Keep unrelated feature constants and helpers out of a common sink."""
    assert not {
        source_path.name
        for source_path in APPLICATION_SOURCE.glob("*.py")
    }.intersection(ROOT_GENERIC_MODULE_NAMES)


def test_jobs_client_has_no_application_server_or_operation_dependencies() -> None:
    """Keep the reusable client importable without service, feature or GIS code."""
    for path in Path("src/eolab_jobs").rglob("*.py"):
        roots = {name.split(".")[0] for name in imported_modules(path)}
        assert roots <= {
            "asyncio", "json", "logging", "math", "re", "typing", "uuid",
            "httpx2", "pydantic", "eolab_jobs",
        }
        assert not reads_process_environment(path)
    assert "eolab_jobs.client" in imported_modules(
        APPLICATION_SOURCE / "vector" / "outline_jobs.py"
    )


def test_outline_algorithm_is_not_a_local_execution_dependency() -> None:
    """Keep local selection execution separate from the Jobs outline algorithm."""
    assert "eolab_app.vector.geometry" not in imported_modules(
        APPLICATION_SOURCE / "vector" / "sampling.py"
    )
    assert "eolab_app.execution.bounded_process" not in imported_modules(
        APPLICATION_SOURCE / "vector" / "geometry.py"
    )
