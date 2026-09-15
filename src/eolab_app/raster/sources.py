"""Mounted raster resolution and process-local source authorization."""

from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from eolab_app.raster.catalog_contract import GEOTIFF_MEDIA_TYPES
from eolab_app.raster.errors import (
    RasterAssetError,
    RasterConflictError,
)
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.rendering.errors import (
    PublishedLayerNotAuthorizedError,
)
from eolab_app.raster.wms_authorization import PublishedRasterAuthorization


def source_signature(source_path: Path) -> RasterSourceIdentity:
    """Identify one mounted file by content-relevant filesystem metadata.

    Args:
        source_path: Mounted GeoTIFF to identify.

    Returns:
        Typed inode, size, modification-time, and metadata-change identity.

    Raises:
        OSError: If the source metadata cannot be read.
    """
    return RasterSourceIdentity.read(source_path)


class MountedRasterResolver:
    """Resolve scanner-owned STAC Assets within one read-only mount."""

    def __init__(self, scan_mount_path: Path) -> None:
        """Create a resolver confined to a configured scan mount.

        Args:
            scan_mount_path: Read-only root shared by scanner and GeoServer.
        """
        self._scan_mount_path = scan_mount_path

    def resolve(self, item: dict[str, Any]) -> Path:
        """Resolve an Item's data Asset to a readable mounted GeoTIFF.

        Args:
            item: Authoritative STAC Item from the catalog.

        Returns:
            Canonical path to the mounted GeoTIFF.

        Raises:
            RasterAssetError: If the data Asset is missing, unavailable, not
                a GeoTIFF, or outside the scan mount.
        """
        assets = item.get("assets")
        data_asset = assets.get("data") if isinstance(assets, dict) else None
        if not isinstance(data_asset, dict) or (
            data_asset.get("type") not in GEOTIFF_MEDIA_TYPES
            or data_asset.get("roles") != ["data"]
            or not isinstance(data_asset.get("href"), str)
        ):
            raise RasterAssetError(
                "The Item has no supported GeoTIFF data Asset"
            )

        asset_uri = urlsplit(data_asset["href"])
        mount_uri = urlsplit(self._scan_mount_path.resolve().as_uri())
        mount_uri_path = unquote(mount_uri.path).rstrip("/")
        asset_uri_path = unquote(asset_uri.path)
        if (
            asset_uri.scheme != "file"
            or asset_uri.netloc != mount_uri.netloc
            or asset_uri.query
            or asset_uri.fragment
            or not asset_uri_path.startswith(f"{mount_uri_path}/")
        ):
            raise RasterAssetError(
                "The GeoTIFF Asset is outside the mounted scan source"
            )

        relative_path = Path(asset_uri_path[len(mount_uri_path) + 1 :])
        try:
            source_path = (
                self._scan_mount_path / relative_path
            ).resolve(strict=True)
        except OSError as error:
            raise RasterConflictError(
                "The cataloged GeoTIFF is no longer available"
            ) from error
        resolved_mount_path = self._scan_mount_path.resolve()
        if (
            not source_path.is_relative_to(resolved_mount_path)
            or not source_path.is_file()
            or source_path.suffix.lower() not in {".tif", ".tiff"}
        ):
            raise RasterAssetError(
                "The GeoTIFF Asset is outside the mounted scan source"
            )
        return source_path


class PublishedRasterRegistry:
    """Allow WMS access only to raster layers approved by this app process."""

    def __init__(self) -> None:
        """Create an empty process-local raster authorization registry."""
        self._sources: dict[str, tuple[Path, RasterSourceIdentity]] = {}

    def authorize(
        self,
        layer_name: str,
        source_path: Path,
        inspected_signature: RasterSourceIdentity,
    ) -> None:
        """Record authorization for a published immutable raster.

        Args:
            layer_name: Workspace-qualified GeoServer layer name.
            source_path: Mounted GeoTIFF backing the layer.
            inspected_signature: Source identity recorded in the catalog.
        """
        self._sources[layer_name] = (source_path, inspected_signature)

    def require_current(self, layer_name: str) -> PublishedRasterAuthorization:
        """Look up an authorized raster layer.

        Args:
            layer_name: Workspace-qualified GeoServer layer name.

        Returns:
            Canonical path and approved signature for the mounted GeoTIFF.

        Raises:
            PublishedLayerNotAuthorizedError: If the layer is not authorized.
        """
        authorization = self._sources.get(layer_name)
        if authorization is None:
            raise PublishedLayerNotAuthorizedError(
                "The WMS layer has not been approved for visualization"
            )
        source_path, approved_signature = authorization
        return PublishedRasterAuthorization(source_path, approved_signature)
