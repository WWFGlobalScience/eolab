"""Test mounted raster resolution and process-local authorization."""

from pathlib import Path

import pytest

from eolab_app.raster.errors import RasterAssetError
from eolab_app.rendering.errors import (
    PublishedLayerNotAuthorizedError,
)
from eolab_app.raster.sources import (
    MountedRasterResolver,
    PublishedRasterRegistry,
    source_signature,
)


def _item(asset_href: str) -> dict[str, object]:
    """Build the minimal scanner-owned Asset contract."""
    return {
        "assets": {
            "data": {
                "href": asset_href,
                "type": "image/tiff; application=geotiff",
                "roles": ["data"],
            }
        }
    }


def test_mounted_raster_resolver_confines_assets_to_the_scan_mount(
    tmp_path: Path,
) -> None:
    """Resolve mounted files while rejecting remote and outside Assets."""
    scan_mount = tmp_path / "scan"
    scan_mount.mkdir()
    raster_path = scan_mount / "nested" / "raster.tif"
    raster_path.parent.mkdir()
    raster_path.write_bytes(b"raster")
    outside_path = tmp_path / "outside.tif"
    outside_path.write_bytes(b"outside")
    resolver = MountedRasterResolver(scan_mount)

    assert resolver.resolve(_item(raster_path.as_uri())) == raster_path.resolve()
    for unsafe_href in (
        "https://example.test/raster.tif",
        outside_path.as_uri(),
        f"{scan_mount.as_uri()}/../outside.tif",
    ):
        with pytest.raises(RasterAssetError):
            resolver.resolve(_item(unsafe_href))


def test_registry_requires_an_approved_layer(tmp_path: Path) -> None:
    """Reject unknown layers and retain the recorded catalog identity."""
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"first")
    layer_name = "eolab:geotiff-0123456789abcdef01234567"
    registry = PublishedRasterRegistry()

    with pytest.raises(PublishedLayerNotAuthorizedError):
        registry.require_current(layer_name)

    approved_signature = source_signature(source_path)
    registry.authorize(layer_name, source_path, approved_signature)
    assert registry.require_current(layer_name).source_signature == (
        approved_signature
    )

    source_path.write_bytes(b"replacement source")
    assert registry.require_current(layer_name).source_signature == approved_signature
