"""Focused collaborator contracts used by raster application services."""

from pathlib import Path
from typing import Any, Protocol

from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogRasterRequest,
)


class RasterCatalog(Protocol):
    """Authoritative catalog operations required by raster workflows."""

    async def get_item(
        self,
        request: CatalogRasterRequest,
    ) -> dict[str, Any]:
        """Load the authoritative Item matching a validated request.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Authoritative STAC Item.
        """
        ...

class RasterPublisher(Protocol):
    """Rendering adapter required by the publication use case."""

    async def publish(self, resource_name: str, source_path: Path) -> None:
        """Publish and style one mounted GeoTIFF.

        Args:
            resource_name: Stable GeoServer resource name.
            source_path: Canonical mounted GeoTIFF path.

        Raises:
            RasterUpstreamError: If publication or styling fails.
        """
        ...


class RasterSourceResolver(Protocol):
    """Resolve authoritative catalog Items to mounted raster sources."""

    def resolve(self, item: dict[str, Any]) -> Path:
        """Resolve one scanner-owned data Asset inside its configured mount.

        Args:
            item: Authoritative scanner-owned STAC Item.

        Returns:
            Canonical mounted GeoTIFF path.

        Raises:
            RasterFeatureError: If the Asset is absent, invalid, unavailable,
                or outside the configured mount.
        """
        ...


class RasterSourceAuthorizer(Protocol):
    """Authorize mounted catalog sources for rendering-independent analysis."""

    async def authorize(
        self,
        request: CatalogRasterRequest,
    ) -> AuthorizedRaster:
        """Resolve one current scanner-owned source.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Current mounted source authorization.

        Raises:
            RasterFeatureError: If catalog, mount, or source identity
                validation fails.
        """
        ...
