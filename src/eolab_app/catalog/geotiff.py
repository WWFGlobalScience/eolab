"""Extract STAC metadata from GeoTIFF files."""

import hashlib
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import rasterio
from rasterio.transform import array_bounds
from rasterio.warp import calculate_default_transform, transform_bounds

from eolab_app.raster.catalog_contract import (
    COG_MEDIA_TYPE,
    GEOTIFF_MEDIA_TYPE,
    MOUNTED_GEOTIFF_COLLECTION_ID,
)
from eolab_app.raster.catalog_metadata import (
    RASTER_ASSET_METADATA_KEY,
    RASTER_SOURCE_SIGNATURE_FIELD,
)
from eolab_app.raster.source_identity import RasterSourceIdentity


STAC_RASTER_DATA_TYPES = {
    "complex_int16": "cint16",
    # Rasterio combines GDAL CInt32, CFloat16, and CFloat32 under this name.
    "complex64": "other",
    "complex128": "cfloat64",
}
PROJECTION_EXTENSION = (
    "https://stac-extensions.github.io/projection/v1.1.0/schema.json"
)
RASTER_EXTENSION = "https://stac-extensions.github.io/raster/v1.1.0/schema.json"
FILE_EXTENSION = "https://stac-extensions.github.io/file/v2.1.0/schema.json"
FALLBACK_DATETIME_DESCRIPTION = (
    "No observation or acquisition time was found in the GeoTIFF metadata. "
    "The Item datetime uses the source file's filesystem modification time."
)
ACQUISITION_DATETIME_DESCRIPTION = (
    "The Item datetime uses ACQUISITIONDATETIME from the GeoTIFF's GDAL "
    "IMAGERY metadata domain."
)
SUGGESTED_WARP_BOUNDS_DESCRIPTION = (
    "The spatial footprint is a conservative WGS 84 destination envelope "
    "suggested by GDAL because the raster's rectangular outer boundary "
    "could not be transformed."
)
RFC3339_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def build_stac_item(source_root: Path, geotiff_path: Path) -> dict[str, Any]:
    """Build a STAC Item from one GeoTIFF.

    Args:
        source_root: Root directory mounted for scanning.
        geotiff_path: GeoTIFF below the mounted root.

    Returns:
        A STAC Item containing the raster footprint and spatial metadata.

    Raises:
        OSError: If filesystem metadata for the GeoTIFF cannot be read.
        ValueError: If the path escapes the source root, raster spatial metadata
            is incomplete, or an embedded acquisition time is malformed.
        rasterio.errors.RasterioError: If GDAL cannot read the file.
    """
    relative_path = geotiff_path.relative_to(source_root)
    relative_path_text = relative_path.as_posix()
    file_status = geotiff_path.stat()
    filesystem_modified_at = datetime.fromtimestamp(
        file_status.st_mtime,
        tz=timezone.utc,
    )

    with rasterio.open(geotiff_path) as dataset:
        if dataset.crs is None:
            raise ValueError("GeoTIFF has no coordinate reference system")
        if dataset.width < 1 or dataset.height < 1:
            raise ValueError("GeoTIFF has invalid raster dimensions")

        bbox, used_suggested_warp_bounds = _derive_wgs84_bbox(dataset)

        west, south, east, north = bbox
        footprint = {
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

        acquisition_datetime = dataset.tags(ns="IMAGERY").get(
            "ACQUISITIONDATETIME"
        )
        if acquisition_datetime is None:
            item_datetime = filesystem_modified_at
            description = FALLBACK_DATETIME_DESCRIPTION
        else:
            item_datetime = _parse_acquisition_datetime(acquisition_datetime)
            description = ACQUISITION_DATETIME_DESCRIPTION
        if used_suggested_warp_bounds:
            description = f"{description} {SUGGESTED_WARP_BOUNDS_DESCRIPTION}"

        properties: dict[str, Any] = {
            "datetime": _format_datetime(item_datetime),
            "title": relative_path_text,
            "description": description,
            "proj:shape": [dataset.height, dataset.width],
            "proj:transform": list(dataset.transform)[:6],
        }
        # Curated metadata is opt-in; ordinary rasters retain existing behavior.
        tags = dataset.tags()
        if title := tags.get("EOLAB_TITLE"):
            properties["title"] = title
        if summary := tags.get("TIFFTAG_IMAGEDESCRIPTION"):
            properties["description"] = f"{summary} {description}"
        start = tags.get("EOLAB_START_DATETIME")
        end = tags.get("EOLAB_END_DATETIME")
        if start is not None or end is not None:
            if not start or not end:
                raise ValueError("Both EOLAB_START_DATETIME and EOLAB_END_DATETIME are required")
            start_time = _parse_acquisition_datetime(start)
            end_time = _parse_acquisition_datetime(end)
            if start_time > end_time:
                raise ValueError("GeoTIFF temporal interval is reversed")
            properties.update(datetime=None,start_datetime=_format_datetime(start_time),
                              end_datetime=_format_datetime(end_time))
            properties["description"] = summary or "Raster summarizes the specified temporal interval."
            if used_suggested_warp_bounds:
                properties["description"] += f" {SUGGESTED_WARP_BOUNDS_DESCRIPTION}"
        for tag, key in (("EOLAB_LICENSE", "license"), ("EOLAB_ATTRIBUTION", "eolab:attribution"),
                         ("EOLAB_SOURCE", "eolab:source_url")):
            if value := tags.get(tag):
                properties[key] = value
        if epsg_code := dataset.crs.to_epsg():
            properties["proj:epsg"] = epsg_code
        else:
            properties["proj:wkt2"] = dataset.crs.to_wkt()

        raster_bands = []
        for band_index, (data_type, nodata_value) in enumerate(zip(
            dataset.dtypes,
            dataset.nodatavals,
            strict=True,
        ),start=1):
            band: dict[str, Any] = {
                "data_type": STAC_RASTER_DATA_TYPES.get(data_type, data_type)
            }
            if nodata_value is not None:
                band["nodata"] = _serialize_nodata(nodata_value)
            if band_description := dataset.descriptions[band_index-1]:
                band["description"] = band_description
            if unit := dataset.units[band_index-1]:
                band["unit"] = unit
            raster_bands.append(band)
        source_metadata = {
            RASTER_SOURCE_SIGNATURE_FIELD: (
                RasterSourceIdentity.from_status(file_status).to_catalog()
            )
        }
        media_type = (
            COG_MEDIA_TYPE
            if dataset.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG"
            else GEOTIFF_MEDIA_TYPE
        )

    item_identifier = hashlib.sha256(relative_path_text.encode("utf-8")).hexdigest()
    return {
        "type": "Feature",
        "stac_version": "1.0.0",
        "stac_extensions": [
            PROJECTION_EXTENSION,
            RASTER_EXTENSION,
            FILE_EXTENSION,
        ],
        "id": f"geotiff-{item_identifier[:24]}",
        "collection": MOUNTED_GEOTIFF_COLLECTION_ID,
        "geometry": footprint,
        "bbox": bbox,
        "properties": properties,
        "links": [],
        "assets": {
            "data": {
                "href": geotiff_path.resolve().as_uri(),
                "type": media_type,
                "title": properties["title"],
                "roles": ["data"],
                "updated": _format_datetime(filesystem_modified_at),
                "file:size": file_status.st_size,
                "raster:bands": raster_bands,
                RASTER_ASSET_METADATA_KEY: source_metadata,
            }
        },
    }


def _derive_wgs84_bbox(
    dataset: rasterio.io.DatasetReader,
) -> tuple[list[float], bool]:
    """Derive a WGS 84 bounding box without reading raster pixels.

    Args:
        dataset: Open raster dataset with a coordinate reference system.

    Returns:
        The WGS 84 bounding box and whether GDAL's suggested warp output was
        required.

    Raises:
        ValueError: If GDAL cannot produce a valid WGS 84 destination extent.
    """
    bbox = list(
        transform_bounds(
            dataset.crs,
            "EPSG:4326",
            *dataset.bounds,
        )
    )
    used_suggested_warp_bounds = False
    if not all(math.isfinite(coordinate) for coordinate in bbox):
        destination_transform, destination_width, destination_height = (
            calculate_default_transform(
                dataset.crs,
                "EPSG:4326",
                dataset.width,
                dataset.height,
                *dataset.bounds,
            )
        )

        if (
            destination_width < 1
            or destination_height < 1
            or not all(
                math.isfinite(coefficient)
                for coefficient in destination_transform
            )
        ):
            raise ValueError("GeoTIFF bounds could not be transformed to WGS 84")

        bbox = list(
            array_bounds(
                destination_height,
                destination_width,
                destination_transform,
            )
        )
        used_suggested_warp_bounds = True

    west, south, east, north = bbox
    normalized_bbox = [
        max(west, -180),
        max(south, -90),
        min(east, 180),
        min(north, 90),
    ]
    if not (
        all(math.isfinite(coordinate) for coordinate in normalized_bbox)
        and normalized_bbox[0] < normalized_bbox[2]
        and normalized_bbox[1] < normalized_bbox[3]
    ):
        raise ValueError("GeoTIFF bounds could not be transformed to WGS 84")

    return normalized_bbox, used_suggested_warp_bounds


def _parse_acquisition_datetime(value: str) -> datetime:
    """Parse an unambiguous acquisition timestamp.

    Args:
        value: RFC 3339 timestamp read from GDAL metadata.

    Returns:
        The timestamp normalized to UTC.

    Raises:
        ValueError: If the timestamp is malformed or has no UTC offset.
    """
    if RFC3339_TIMESTAMP.fullmatch(value) is None:
        raise ValueError(
            f"ACQUISITIONDATETIME is not a valid RFC 3339 timestamp: {value}"
        )
    normalized_value = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        acquisition_datetime = datetime.fromisoformat(normalized_value)
    except ValueError as error:
        raise ValueError(
            f"ACQUISITIONDATETIME is not a valid RFC 3339 timestamp: {value}"
        ) from error
    if acquisition_datetime.tzinfo is None:
        raise ValueError(
            "ACQUISITIONDATETIME must include a UTC offset: " f"{value}"
        )
    return acquisition_datetime.astimezone(timezone.utc)


def _format_datetime(value: datetime) -> str:
    """Format a UTC timestamp for STAC."""
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _serialize_nodata(value: float) -> float | str:
    """Serialize a GDAL nodata value using STAC Raster extension values."""
    if math.isnan(value):
        return "nan"
    if math.isinf(value):
        return "inf" if value > 0 else "-inf"
    return value
