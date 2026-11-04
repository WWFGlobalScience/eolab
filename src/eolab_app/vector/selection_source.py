"""Locate vector files and prepare the filter used to select features.

VectorCatalog supplies the Item and MountedVectorResolver locates its dataset.
Private uploads are located through their owning browser's upload store. Filters
are checked against the source fields; feature readers apply them later.
"""

import asyncio

from eolab_app.catalog_selection import (
    CatalogSelection,
    ResolvedCatalogSelection,
    UploadedSelection,
    UploadedVectorFilterRequest,
)
from eolab_app.attribute_filter import ogr_predicate
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.filters import (
    CatalogVectorFilterRequest,
    VectorFilter,
    validate_filter,
)
from eolab_app.vector.metadata import catalog_vector_fields
from eolab_app.vector.ports import VectorCatalog
from eolab_app.vector.sources import MountedVectorResolver, resolve_uploaded_vector
from eolab_app.vector_uploads import VectorUploadError, VectorUploadStore


async def resolve_selection(
    catalog: VectorCatalog,
    resolver: MountedVectorResolver,
    request: (
        CatalogVectorFilterRequest | CatalogSelection | UploadedVectorFilterRequest
    ),
    uploads: VectorUploadStore | None = None,
    upload_owner: str | None = None,
) -> ResolvedCatalogSelection:
    """Locate an authorized vector dataset and prepare its attribute filter.

    No geometries are loaded or filtered here. The returned OGR WHERE expression
    narrows candidates during reading; original-source readers also apply the exact
    attribute rules so driver-specific string comparisons cannot change results.

    Args:
        catalog: Reader that fetches the requested STAC Item.
        resolver: Maps the Item's data Asset to an
            allowed dataset path and native layer inside the read-only mount.
        request: Catalog collection/item IDs or upload ID and attribute filter.
            Callers never supply a filesystem path; the server locates the file.
        uploads: Browser-owned storage, required for uploaded selections.
        upload_owner: Server-derived browser identity for private uploads.

    Returns:
        Server-only dataset path, driver, layer/filter selection, compiled OGR
        WHERE expression.

    Raises:
        VectorFeatureError: If identity, source or predicate is unavailable.
        VectorUploadError: If the upload is unavailable to this browser.
    """
    if isinstance(request, UploadedVectorFilterRequest):
        if uploads is None or upload_owner is None:
            raise VectorUploadError(
                404, "This upload is not available to this browser."
            )
        metadata, source = await asyncio.to_thread(
            resolve_uploaded_vector, uploads, upload_owner, request.uploadId
        )
        validated_filter = validate_filter(request.filter, metadata.fields)
        return ResolvedCatalogSelection(
            UploadedSelection(
                uploadId=request.uploadId,
                layerName=metadata.layer_name,
                filter=validated_filter,
            ),
            source.source_path,
            "GPKG",
            ogr_predicate(validated_filter),
        )
    item = await catalog.get_item(request)
    source = resolver.resolve(item)
    if (
        source.source_format not in {"geopackage", "shapefile"}
        or source.source_path is None
    ):
        raise VectorConflictError(
            f"The selected source is {source.source_kind} {source.source_format}; "
            "reading original features requires a mounted Shapefile or GeoPackage layer."
        )
    validated_filter = validate_filter(request.filter, catalog_vector_fields(item))
    selection = CatalogSelection(
        collectionId=request.collection_id,
        itemId=request.item_id,
        assetKey=source.asset_key,
        layerName=source.layer_name,
        filter=validated_filter,
    )
    return ResolvedCatalogSelection(
        selection,
        source.source_path,
        "GPKG" if source.source_format == "geopackage" else "ESRI Shapefile",
        ogr_predicate(validated_filter),
    )
