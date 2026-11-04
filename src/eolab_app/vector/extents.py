"""Measure filtered vector bounds without retaining display geometry."""

import math
from time import monotonic
from typing import Any

import fiona
from fiona.model import to_dict
from rasterio.errors import RasterioError
from rasterio.warp import transform_bounds

from eolab_app.attribute_filter import matches_filter, validate_filter
from eolab_app.bounded_geometry import (
    GeometryValidationError,
    _iter_geometry_coordinates,
)
from eolab_app.bounded_vector import VectorReadLimits, _source_collection
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)


def read_selected_extent(
    resolved: ResolvedCatalogSelection, *, limits: VectorReadLimits = VectorReadLimits()
) -> dict[str, Any]:
    """Return matching-feature count and combined projected feature envelopes.

    Read the authorized original layer once, using its exact typed predicate.
    Each native feature envelope is transformed with the same 21-point edge
    densification used for catalog/upload bounds to sample curved projected edges.
    Only one feature is retained at a time; no outline or geometry snapshot is
    returned. Null or empty geometries count as matches but add no coordinates.
    The worker supervisor interrupts blocked native calls and abandoned reads.

    Args:
        resolved: Authorized immutable source, native layer and compiled predicate.
        limits: Existing interactive vector time, feature and coordinate budgets.

    Returns:
        Matched count and combined WGS84 feature envelopes, or null when no
        coordinates matched. Antimeridian crossings use the full longitude range.

    Raises:
        GeometryValidationError: Missing CRS, invalid coordinates or exhausted budget.
        SelectionUnavailableError: A native source or projection cannot be read.
        ValueError: The source predicate no longer matches its admitted fields.
    """
    deadline = monotonic() + limits.seconds
    matched = 0
    bounds = None
    with fiona.Env(OGR_CT_FORCE_TRADITIONAL_GIS_ORDER="YES"):
        with _source_collection(resolved) as dataset:
            validate_filter(
                resolved.selection.filter, dataset.schema.get("properties", {})
            )
            if not dataset.crs:
                raise GeometryValidationError(
                    "The selected vector has no coordinate reference system"
                )
            options = {"where": resolved.where} if resolved.where else {}
            for count, feature in enumerate(dataset.filter(**options), 1):
                if count > limits.features:
                    raise GeometryValidationError(
                        f"Vector reading exceeded its {limits.features:,}-feature budget"
                    )
                if monotonic() > deadline:
                    raise GeometryValidationError(
                        "Vector extent reading exceeded its time budget"
                    )
                if not matches_filter(resolved.selection.filter, feature.properties):
                    continue
                matched += 1
                if feature.geometry is None:
                    continue
                raw = to_dict(feature.geometry)
                native_bounds = None
                for positions, (x, y) in enumerate(
                    _iter_geometry_coordinates(raw, validate_wgs84_bounds=False), 1
                ):
                    if positions > limits.coordinates_per_feature:
                        raise GeometryValidationError(
                            "A source feature exceeds the bounded coordinate buffer"
                        )
                    native_bounds = (
                        [x, y, x, y]
                        if native_bounds is None
                        else [
                            min(native_bounds[0], x),
                            min(native_bounds[1], y),
                            max(native_bounds[2], x),
                            max(native_bounds[3], y),
                        ]
                    )
                if native_bounds is None:
                    continue
                try:
                    west, south, east, north = transform_bounds(
                        dataset.crs_wkt, "EPSG:4326", *native_bounds
                    )
                except (RasterioError, ValueError) as error:
                    raise SelectionUnavailableError(
                        "The selected vector bounds could not be projected."
                    ) from error
                if not all(
                    math.isfinite(value) for value in (west, south, east, north)
                ):
                    raise GeometryValidationError(
                        "The selected vector bounds could not be projected."
                    )
                if west > east:
                    west, east = -180.0, 180.0
                bounds = (
                    [west, south, east, north]
                    if bounds is None
                    else [
                        min(bounds[0], west),
                        min(bounds[1], south),
                        max(bounds[2], east),
                        max(bounds[3], north),
                    ]
                )
                if monotonic() > deadline:
                    raise GeometryValidationError(
                        "Vector extent reading exceeded its time budget"
                    )
    return {"matched": matched, "bbox": bounds}
