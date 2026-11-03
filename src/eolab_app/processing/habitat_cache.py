"""Inspect Habitat input availability using authorized original polygon sources."""

from pathlib import Path
from typing import cast

from rasterio.crs import CRS
from shapely.geometry import shape
from shapely.ops import unary_union

from eolab_app.catalog_selection import (
    CatalogSelection,
    CatalogSelectionReader,
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
    run_bounded_process,
)
from eolab_app.processing.habitat_calculation import read_habitat_polygons
from eolab_app.processing.habitat_earth_engine import (
    HabitatCacheCoverage,
    inspect_habitat_cache,
    load_habitat_stack,
)
from eolab_app.processing.models import ProcessingError


def habitat_cache_coverage_process(
    writer: ProcessResultWriter,
    selection: ResolvedCatalogSelection,
    year: int,
    cache_directory: Path,
) -> None:
    """Read selected polygons and count cached inputs in a supervised child.

    Args:
        writer: Parent-owned result pipe receiving coverage or a safe failure.
        selection: Authorized original Catalog source and exact feature filter.
        year: Requested assessment year, checked by the scientific stack loader.
        cache_directory: Server-controlled persistent Habitat cache root.
    """
    try:
        configuration = load_habitat_stack(year)
        polygons = read_habitat_polygons(
            selection, CRS.from_string(configuration.grid.crs)
        )
        area = unary_union([shape(polygon) for polygon in polygons])
        writer.put(("ok", inspect_habitat_cache(area, configuration, cache_directory)))
    except SelectionUnavailableError as error:
        writer.put(("error", ("selection_unavailable", error.detail, 409)))
    except ValueError as error:
        detail = str(error)
        for path, label in (
            (selection.path, "selected polygon source"),
            (cache_directory, "Habitat input cache"),
        ):
            detail = detail.replace(str(path), label).replace(path.as_posix(), label)
        writer.put(("error", ("invalid_habitat_area", detail, 422)))
    except OSError:
        writer.put(
            (
                "error",
                (
                    "habitat_cache_unavailable",
                    "The selected area or Habitat input cache could not be read. Try again later.",
                    409,
                ),
            )
        )
    except Exception:
        writer.put(
            (
                "error",
                (
                    "habitat_cache_inspection_failed",
                    "Cached Habitat inputs could not be checked. Try again later.",
                    500,
                ),
            )
        )


async def get_habitat_cache_coverage(
    selection: CatalogSelection,
    year: int,
    selections: CatalogSelectionReader,
    cache_directory: Path,
) -> HabitatCacheCoverage:
    """Return current cached input counts for a Catalog polygon selection.

    Resolves the original source through Catalog authorization, then reads exact
    polygons in a child process. Cancellation stops and joins that process before
    returning. No geometry is retained, no pixels are read and no downloads start.

    Args:
        selection: Path-free Catalog source and immutable feature filter.
        year: Requested scientific assessment year.
        selections: Existing Catalog source authorization boundary.
        cache_directory: Server-controlled persistent Habitat cache root.

    Returns:
        Advisory required, cached and missing tile counts for the selected area.

    Raises:
        SelectionUnavailableError: If Catalog identity or source access fails.
        ProcessingError: If polygons, the year, native execution or cache reads fail.
        asyncio.CancelledError: After the native child stops on cancellation.
    """
    resolved = await selections.resolve_for_sampling(selection)
    try:
        status, result = await run_bounded_process(
            habitat_cache_coverage_process, (resolved, year, cache_directory), None
        )
    except ProcessDeadlineError as error:
        raise ProcessingError(
            "habitat_cache_inspection_failed",
            "Cached Habitat inputs could not be checked. Try again later.",
            500,
        ) from error
    if status != "ok":
        raise ProcessingError(*result)
    return cast(HabitatCacheCoverage, result)
