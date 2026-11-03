"""Protect vector visualization ownership and dependency direction."""

import ast
from pathlib import Path


VECTOR_SOURCE = Path("src/eolab_app/vector")
MAP_LAYER_SOURCE = Path("frontend/src/map-layers")


def imported_modules(source_path: Path) -> set[str]:
    """Return absolute Python modules imported by one source file.

    Args:
        source_path: Python module to parse.

    Returns:
        Absolute import names declared by the module.
    """
    syntax_tree = ast.parse(source_path.read_text(encoding="utf-8"))
    modules: set[str] = set()
    for node in ast.walk(syntax_tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            modules.add(node.module)
    return modules


def test_vector_domain_does_not_depend_on_raster_or_http_delivery() -> None:
    """Keep the vector feature independent of raster and FastAPI modules."""
    imports = {
        module
        for source_path in VECTOR_SOURCE.glob("*.py")
        for module in imported_modules(source_path)
    }

    assert not any(
        module == "eolab_app.raster"
        or module.startswith("eolab_app.raster.")
        or module == "eolab_app.routes"
        or module.startswith("eolab_app.routes.")
        or module == "fastapi"
        or module.startswith("fastapi.")
        for module in imports
    )


def test_map_layer_client_contract_has_no_feature_imports() -> None:
    """Keep the shared browser lifecycle unaware of raster/vector modules."""
    source_text = "\n".join(
        source_path.read_text(encoding="utf-8")
        for source_path in MAP_LAYER_SOURCE.glob("*.js")
    )

    assert "../raster/" not in source_text
    assert "../vector/" not in source_text
