"""Bounded display-outline algorithm used by the registered Jobs operation."""

from typing import Any

from eolab_app.bounded_vector import (
    polygon_features,
    selection_summary,
    _limit_memory,
)
from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.vector.display_geometry import display_geometry


def build_outline(resolved: ResolvedCatalogSelection) -> dict[str, Any]:
    """Read matching polygons and simplify them into a map display outline.

    The Job service calls this algorithm. Polygons are read from the original
    dataset one at a time; the input does not hold their coordinates.
    The simplified result is for drawing, not analysis.

    Args:
        resolved: Server-resolved dataset path, native layer name, attribute
            filter (for example, iso3 == "PER"), and file signatures used to
            detect source changes while reading.

    Returns:
        A dict with ``geometry`` (a simplified WGS84 FeatureCollection) and
        ``bbox`` (the exact matching polygons' west, south, east, north bounds).

    Raises:
        ValueError: If geometry, source identity or bounded reading fails.
        RuntimeError: If the outline cannot fit its display budget.
    """
    with _limit_memory():
        summary = selection_summary(resolved)
        outline: dict[str, Any] = {"type": "FeatureCollection", "features": []}
        with polygon_features(resolved) as features:
            for geometry in features:
                part = display_geometry(
                    {
                        "type": "FeatureCollection",
                        "features": [
                            {
                                "type": "Feature",
                                "properties": {},
                                "geometry": geometry,
                            }
                        ],
                    },
                    summary["bbox"],
                )
                outline["features"].extend(part["features"])
                outline = display_geometry(outline, summary["bbox"])
    return {"geometry": outline, "bbox": summary["bbox"]}
