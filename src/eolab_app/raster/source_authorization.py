"""Catalog-owned source authorization for rendering-independent analysis."""

from eolab_app.raster.catalog_metadata import cataloged_source_signature
from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogRasterRequest,
)
from eolab_app.raster.ports import RasterCatalog, RasterSourceResolver

class CatalogRasterSourceAuthorizer:
    """Resolve current mounted raster sources without a rendering dependency."""

    def __init__(
        self,
        catalog: RasterCatalog,
        source_resolver: RasterSourceResolver,
    ) -> None:
        """Create catalog authorization for independent raster analysis.

        Args:
            catalog: Authoritative scanner-owned Item reader.
            source_resolver: Resolver confined to the configured scan mount.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver

    async def authorize(
        self,
        request: CatalogRasterRequest,
    ) -> AuthorizedRaster:
        """Authorize one current catalog source for analysis.

        This boundary deliberately does not inspect WMS publication state,
        visualization eligibility, overview policy, or GeoServer health.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Mounted source path and scanner-approved source identity.

        Raises:
            RasterFeatureError: If the catalog Item or mounted Asset cannot be
                resolved.
            RasterConflictError: If the catalog source identity is missing or invalid.
        """
        item = await self._catalog.get_item(request)
        source_path = self._source_resolver.resolve(item)
        authorized_raster = AuthorizedRaster(
            source_path=source_path,
            source_signature=cataloged_source_signature(item),
        )
        return authorized_raster
