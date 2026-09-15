"""Test rendering-independent catalog raster source authorization."""

import asyncio
import ast
from pathlib import Path
from typing import Any

import pytest

from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.source_authorization import (
    CatalogRasterSourceAuthorizer,
)
from eolab_app.raster.sources import source_signature


class _Catalog:
    """Return one controlled authoritative Item."""

    def __init__(self, item: dict[str, Any]) -> None:
        """Store the controlled Item.

        Args:
            item: Item returned to the source authorizer.
        """
        self.item = item

    async def get_item(self, _: CatalogRasterRequest) -> dict[str, Any]:
        """Return the controlled Item.

        Args:
            _: Ignored validated identity.

        Returns:
            Controlled authoritative Item.
        """
        return self.item


class _Resolver:
    """Return one controlled mounted source path."""

    def __init__(self, source_path: Path) -> None:
        """Store the controlled path.

        Args:
            source_path: Path returned for every Item.
        """
        self.source_path = source_path

    def resolve(self, _: dict[str, Any]) -> Path:
        """Return the controlled path.

        Args:
            _: Ignored authoritative Item.

        Returns:
            Controlled mounted source path.
        """
        return self.source_path


def _item(signature: RasterSourceIdentity) -> dict[str, Any]:
    """Build an Item containing only neutral source identity.

    Args:
        signature: Scanner-owned primary-source identity.

    Returns:
        Item whose source is analyzable without rendering metadata.
    """
    return {
        "assets": {
            "data": {
                "eolab:source": {
                    "source_signature": signature.to_catalog(),
                }
            }
        }
    }


def test_source_authorization_ignores_rendering_and_geoprocessor_state(
    tmp_path: Path,
) -> None:
    """Authorize analysis solely from catalog, mount, and source identity.

    Args:
        tmp_path: Temporary controlled source directory.
    """
    source_path = tmp_path / "independent.tif"
    source_path.write_bytes(b"source")
    signature = source_signature(source_path)
    authorizer = CatalogRasterSourceAuthorizer(
        _Catalog(_item(signature)),
        _Resolver(source_path),
    )
    request = CatalogRasterRequest(
        collectionId="eolab-mounted-geotiffs",
        itemId="geotiff-0123456789abcdef01234567",
    )

    authorized = asyncio.run(authorizer.authorize(request))

    assert authorized.source_path == source_path
    assert authorized.source_signature == signature


def test_source_authorization_accepts_legacy_identity_after_remount(
    tmp_path: Path,
) -> None:
    """Keep analysis authorized when only a legacy device number changed.

    Args:
        tmp_path: Temporary controlled source directory.
    """
    source_path = tmp_path / "independent.tif"
    source_path.write_bytes(b"source")
    signature = source_signature(source_path)
    item = _item(signature)
    metadata = item["assets"]["data"]["eolab:source"]
    assert isinstance(metadata, dict)
    metadata["source_signature"] = [92, *signature.to_catalog()]
    authorizer = CatalogRasterSourceAuthorizer(
        _Catalog(item),
        _Resolver(source_path),
    )
    request = CatalogRasterRequest(
        collectionId="eolab-mounted-geotiffs",
        itemId="geotiff-0123456789abcdef01234567",
    )

    authorized = asyncio.run(authorizer.authorize(request))

    assert authorized.source_signature == signature


def test_source_authorization_retains_catalog_identity_without_file_rechecks(
    tmp_path: Path,
) -> None:
    """Use catalog identity without mutation checks; reject missing identity.

    Args:
        tmp_path: Temporary controlled source directory.
    """
    source_path = tmp_path / "stale.tif"
    source_path.write_bytes(b"first")
    scanned_signature = source_signature(source_path)
    request = CatalogRasterRequest(
        collectionId="eolab-mounted-geotiffs",
        itemId="geotiff-0123456789abcdef01234567",
    )
    source_path.write_bytes(b"replacement source")
    stale_authorizer = CatalogRasterSourceAuthorizer(
        _Catalog(_item(scanned_signature)),
        _Resolver(source_path),
    )

    authorized = asyncio.run(stale_authorizer.authorize(request))
    assert authorized.source_signature == scanned_signature

    missing_signature_item = _item(scanned_signature)
    metadata = missing_signature_item["assets"]["data"][
        "eolab:source"
    ]
    assert isinstance(metadata, dict)
    metadata.pop("source_signature")
    missing_authorizer = CatalogRasterSourceAuthorizer(
        _Catalog(missing_signature_item),
        _Resolver(source_path),
    )
    with pytest.raises(RasterConflictError, match="scan this source again"):
        asyncio.run(missing_authorizer.authorize(request))


def test_paired_analysis_has_no_rendering_or_publication_dependency() -> None:
    """Prevent paired statistics from acquiring WMS publication knowledge.

    Returns:
        None after checking every paired-analysis module import.
    """
    paired_modules = (
        Path("src/eolab_app/raster/paired_statistics.py"),
        Path("src/eolab_app/raster/source_authorization.py"),
        Path("src/eolab_app/raster/statistics_service.py"),
        Path("src/eolab_app/routes/raster_analysis.py"),
    )
    forbidden_prefixes = (
        "eolab_app.rendering",
        "eolab_app.raster.assessment",
        "eolab_app.raster.detail_preview",
        "eolab_app.raster.detail_preview_service",
        "eolab_app.raster.eligibility",
        "eolab_app.raster.exact_detail",
        "eolab_app.raster.geoserver",
        "eolab_app.raster.publication",
        "eolab_app.raster.wms_authorization",
    )

    for source_path in paired_modules:
        source = source_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(source_path))
        imported_modules = {
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module is not None
        } | {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        imported_symbols = {
            (node.module, alias.name)
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module is not None
            for alias in node.names
        }
        assert not {
            imported_module
            for imported_module in imported_modules
            if any(
                imported_module == prefix
                or imported_module.startswith(f"{prefix}.")
                for prefix in forbidden_prefixes
            )
        }
        assert (
            "eolab_app.raster.sources",
            "PublishedRasterRegistry",
        ) not in imported_symbols
