"""Discover and extract STAC metadata from GeoPackage vector layers."""

import hashlib
import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fiona
from rasterio.crs import CRS
from rasterio.errors import RasterioError
from rasterio.warp import transform_bounds

from eolab_app.catalog.vector import (
    MOUNTED_VECTOR_COLLECTION_ID,
    TABLE_EXTENSION,
    build_vector_source_properties,
    build_vector_table_properties,
)


LOGGER = logging.getLogger(__name__)
PROJECTION_EXTENSION = (
    "https://stac-extensions.github.io/projection/v1.1.0/schema.json"
)
FILE_EXTENSION = "https://stac-extensions.github.io/file/v2.1.0/schema.json"
GEOPACKAGE_MEDIA_TYPE = "application/geopackage+sqlite3"
GEOPACKAGE_LAYER_PROPERTY = "eolab:geopackage_layer"
FALLBACK_DATETIME_DESCRIPTION = (
    "GeoPackage vector layers do not provide a standardized observation or "
    "acquisition timestamp used by EOLab. The Item datetime uses the source "
    "GeoPackage file's filesystem modification time."
)
GEOJSON_GEOMETRY_TYPES = {
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
}


def discover_geopackage_files(
    directory_path: Path,
    file_names: tuple[str, ...],
) -> tuple[Path, ...]:
    """Recognize GeoPackage files in one directory listing.

    Args:
        directory_path: Directory containing the listed files.
        file_names: Sorted child file names from the active directory walk.

    Returns:
        GeoPackage paths in the supplied deterministic file-name order.
    """
    return tuple(
        directory_path / file_name
        for file_name in file_names
        if Path(file_name).suffix.lower() == ".gpkg"
    )


def build_stac_items(
    source_root: Path,
    geopackage_path: Path,
) -> tuple[dict[str, Any], ...]:
    """Build one STAC Item per catalogable GeoPackage vector layer.

    Layer inspection uses Fiona's metadata APIs for names, schemas, counts,
    bounds, and coordinate reference systems. It never iterates through the
    layer's complete feature collection. Nonspatial tables are ignored.
    Expected failures in one layer are logged and do not discard valid sibling
    layers. When every spatial layer fails, the source becomes a normal
    per-dataset scan error.

    Args:
        source_root: Root directory mounted for scanning.
        geopackage_path: GeoPackage file below the mounted root.

    Returns:
        Deterministically ordered Items for valid spatial vector layers, or an
        empty tuple when the container has no spatial vector layers.

    Raises:
        ValueError: If the path escapes the source root or every discovered
            layer fails spatial-vector validation.
        OSError: If filesystem metadata for the GeoPackage cannot be read.
        fiona.errors.FionaError: If GDAL cannot inspect the GeoPackage
            container or list its layers.
    """
    relative_path_text = geopackage_path.relative_to(source_root).as_posix()
    file_status = geopackage_path.stat()
    filesystem_modified_at = datetime.fromtimestamp(
        file_status.st_mtime,
        tz=timezone.utc,
    )
    layer_names = sorted(fiona.listlayers(geopackage_path))
    items: list[dict[str, Any]] = []
    layer_errors: list[tuple[str, Exception]] = []

    for layer_name in layer_names:
        try:
            item = _build_layer_item(
                geopackage_path,
                relative_path_text,
                layer_name,
                filesystem_modified_at,
                file_status.st_size,
            )
        except (
            fiona.errors.FionaError,
            OSError,
            OverflowError,
            RasterioError,
            ValueError,
        ) as error:
            layer_errors.append((layer_name, error))
            LOGGER.warning(
                "Skipping GeoPackage layer %r in %s: %s",
                layer_name,
                relative_path_text,
                error,
            )
            continue
        if item is not None:
            items.append(item)

    if items:
        return tuple(items)
    if layer_errors:
        error_details = "; ".join(
            f"{layer_name}: {error}"
            for layer_name, error in layer_errors
        )
        raise ValueError(
            "GeoPackage has no catalogable spatial vector layers; "
            f"layer errors: {error_details}"
        ) from layer_errors[0][1]
    return ()


def _build_layer_item(
    geopackage_path: Path,
    relative_path_text: str,
    layer_name: str,
    filesystem_modified_at: datetime,
    file_size: int,
) -> dict[str, Any] | None:
    """Inspect one named GeoPackage layer and build its STAC Item.

    Args:
        geopackage_path: GeoPackage container to open.
        relative_path_text: Mount-relative POSIX path used for display and
            stable identity.
        layer_name: Exact GDAL layer name inside the container.
        filesystem_modified_at: Source file modification time in UTC.
        file_size: Source GeoPackage size in bytes.

    Returns:
        A complete spatial-vector Item, or ``None`` for a nonspatial table.

    Raises:
        ValueError: If a spatial layer lacks features, CRS, valid bounds, or a
            supported declared GeoJSON geometry type.
        fiona.errors.FionaError: If GDAL cannot open or inspect the layer.
        rasterio.errors.RasterioError: If the layer CRS or bounds cannot be
            transformed to WGS 84.
    """
    with fiona.open(
        geopackage_path,
        layer=layer_name,
        enabled_drivers=["GPKG"],
    ) as dataset:
        declared_geometry_type = dataset.schema["geometry"]
        if declared_geometry_type in {None, "None"}:
            return None
        geometry_type = str(declared_geometry_type).removeprefix("3D ")
        if geometry_type not in GEOJSON_GEOMETRY_TYPES:
            raise ValueError(
                "GeoPackage layer has unsupported geometry type: "
                f"{declared_geometry_type}"
            )
        if not dataset.crs:
            raise ValueError("GeoPackage layer has no coordinate reference system")

        feature_count = len(dataset)
        if feature_count < 1:
            raise ValueError("GeoPackage layer has no features")
        wkt2 = dataset.crs.to_wkt(version="WKT2_2019")
        native_bbox = list(dataset.bounds)
        bbox = list(
            transform_bounds(CRS.from_wkt(wkt2), "EPSG:4326", *native_bbox)
        )
        if not all(math.isfinite(coordinate) for coordinate in native_bbox + bbox):
            raise ValueError(
                "GeoPackage layer bounds could not be transformed to WGS 84"
            )
        if native_bbox[0] > native_bbox[2] or native_bbox[1] > native_bbox[3]:
            raise ValueError("GeoPackage layer has invalid native bounds")
        # Geographic west > east denotes an antimeridian crossing (RFC 7946).
        if (
            abs(bbox[0]) > 180
            or abs(bbox[2]) > 180
            or bbox[1] < -90
            or bbox[3] > 90
            or bbox[1] > bbox[3]
        ):
            raise ValueError("GeoPackage layer has invalid WGS 84 bounds")

        properties: dict[str, Any] = {
            "datetime": _format_datetime(filesystem_modified_at),
            "title": f"{relative_path_text} — {layer_name}",
            "description": (
                f"GeoPackage spatial vector layer {layer_name!r}. "
                f"{FALLBACK_DATETIME_DESCRIPTION}"
            ),
            GEOPACKAGE_LAYER_PROPERTY: layer_name,
            **build_vector_source_properties(
                "geopackage", "data", layer_name
            ),
            "proj:bbox": native_bbox,
            **build_vector_table_properties(
                feature_count,
                geometry_type,
                (
                    (field_name, str(field_type))
                    for field_name, field_type in dataset.schema[
                        "properties"
                    ].items()
                ),
            ),
        }
        if epsg_code := dataset.crs.to_epsg():
            properties["proj:epsg"] = epsg_code
        else:
            properties["proj:wkt2"] = wkt2

    return {
        "type": "Feature",
        "stac_version": "1.0.0",
        "stac_extensions": [
            PROJECTION_EXTENSION,
            TABLE_EXTENSION,
            FILE_EXTENSION,
        ],
        "id": _build_item_identifier(relative_path_text, layer_name),
        "collection": MOUNTED_VECTOR_COLLECTION_ID,
        "geometry": _build_bbox_geometry(bbox),
        "bbox": bbox,
        "properties": properties,
        "links": [],
        "assets": {
            "data": {
                "href": geopackage_path.resolve().as_uri(),
                "type": GEOPACKAGE_MEDIA_TYPE,
                "title": relative_path_text,
                "roles": ["data"],
                "updated": _format_datetime(filesystem_modified_at),
                "file:size": file_size,
                GEOPACKAGE_LAYER_PROPERTY: layer_name,
            }
        },
    }


def _build_item_identifier(relative_path_text: str, layer_name: str) -> str:
    """Build a stable Item ID from a container path and exact layer name.

    Args:
        relative_path_text: Mount-relative GeoPackage path in POSIX form.
        layer_name: Exact layer name inside the GeoPackage.

    Returns:
        Namespaced identifier with a bounded SHA-256 digest suffix.
    """
    identity_text = f"{relative_path_text}\0{layer_name}"
    identity_digest = hashlib.sha256(identity_text.encode("utf-8")).hexdigest()
    return f"geopackage-{identity_digest[:24]}"


def _build_bbox_geometry(bbox: list[float]) -> dict[str, Any]:
    """Represent a WGS 84 bounding box as a non-null GeoJSON geometry.

    Args:
        bbox: Validated west, south, east, and north coordinates in WGS 84.
            West greater than east denotes an antimeridian crossing.

    Returns:
        A Point for a zero-dimensional extent, a LineString for a
        one-dimensional extent, or a Polygon for an areal extent. Crossing
        extents are split at +/-180 into multipart geometry; zero-width
        polygon parts are omitted. An extent confined to the date line is
        represented at both longitude endpoints for planar spatial queries.
    """
    west, south, east, north = bbox
    if west > east:
        parts = [
            _build_bbox_geometry([left, south, right, north])
            for left, right in ((west, 180), (-180, east))
            if left < right
        ]
        if not parts:
            parts = [
                _build_bbox_geometry([longitude, south, longitude, north])
                for longitude in (180, -180)
            ]
        if len(parts) == 1:
            return parts[0]
        return {
            "type": "Multi" + parts[0]["type"],
            "coordinates": [part["coordinates"] for part in parts],
        }
    if west == east and south == north:
        return {"type": "Point", "coordinates": [west, south]}
    if west == east or south == north:
        return {
            "type": "LineString",
            "coordinates": [[west, south], [east, north]],
        }
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
            ]
        ],
    }


def _format_datetime(value: datetime) -> str:
    """Format a timezone-aware timestamp as UTC RFC 3339 text.

    Args:
        value: Timezone-aware timestamp to normalize.

    Returns:
        UTC timestamp using the STAC-preferred ``Z`` suffix.
    """
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
