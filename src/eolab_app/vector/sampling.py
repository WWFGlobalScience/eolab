"""Authorize vector selections, count features, and request bounds or map outlines.

Source/filter preparation lives in selection_source so readers and installed Jobs
operations use the same rules without constructing this service.
This service retains selection authorization and execution routing;
an unavailable outline does not prevent numeric analysis of the selection.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any
from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.attribute_filter import VectorFilter

from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
    UploadedSelection,
    UploadedVectorFilterRequest,
    VectorSelection,
)
from eolab_app.vector.errors import VectorConflictError, VectorFeatureError
from eolab_app.vector.filters import (
    CatalogVectorFilterRequest,
)
from eolab_app.vector.ports import VectorCatalog
from eolab_app.vector.selection_source import resolve_selection
from eolab_app.vector.sources import MountedVectorResolver
from eolab_app.vector_uploads import VectorUploadStore


class VectorSamplingService:
    """Authorize filtered vector features and request counts, bounds or outlines."""

    def __init__(
        self,
        catalog: VectorCatalog,
        resolver: MountedVectorResolver,
        outline_executor: (
            Callable[[VectorSelection, str | None], Awaitable[dict[str, Any]]] | None
        ) = None,
        *,
        selection_executor: (
            Callable[[VectorSelection, str | None], Awaitable[dict[str, Any]]] | None
        ) = None,
        extent_executor: (
            Callable[[VectorSelection, str | None], Awaitable[dict[str, Any]]] | None
        ) = None,
        uploads: VectorUploadStore | None = None,
    ) -> None:
        """Connect vector source resolution with feature-count, extent and outline jobs.

        Args:
            catalog: Authoritative Catalog reader.
            resolver: Exact mounted vector source resolver.
            outline_executor: Jobs adapter supplied by application composition.
                Omit for selection-only consumers; outline() then reports
                unavailable without starting local display work.
            selection_executor: Jobs adapter for counting filtered features.
                Consumers that only reauthorize descriptors may omit it; select()
                then reports unavailable without launching a local process.
            extent_executor: Jobs adapter for original-source bounds; omit when
                the consumer does not offer filtered map zoom.
            uploads: Original browser-owned GeoPackages and their admission metadata.
        """
        self.catalog = catalog
        self.resolver = resolver
        self._outline_executor = outline_executor
        self._selection_executor = selection_executor
        self._uploads = uploads
        self._extent_executor = extent_executor

    async def resolve_for_sampling(
        self, selection: VectorSelection, upload_owner: str | None = None
    ) -> ResolvedCatalogSelection:
        """Authorize a feature selection against its source identity and filter.

        Args:
            selection: Validated catalog or upload identity and feature filter.
            upload_owner: Server-derived browser identity for private uploads.

        Returns:
            Authorized dataset path and feature filter.

        Raises:
            SelectionUnavailableError: If source identity or predicate is invalid.
            VectorUploadError: If the upload is unavailable to this browser.
        """
        try:
            resolved = await resolve_selection(
                self.catalog, self.resolver, selection, self._uploads, upload_owner
            )
        except (VectorFeatureError, OSError, ValueError) as error:
            raise SelectionUnavailableError(
                "The selected vector is unavailable; select it again."
            ) from error
        if resolved.selection != selection:
            raise SelectionUnavailableError(
                "The selected vector identity changed; select it again."
            )
        return resolved

    async def resolve_source(
        self, source: CatalogVectorRequest
    ) -> ResolvedCatalogSelection:
        """Authorize a current full catalog layer without scanning its features.

        Args:
            source: Configured catalog collection and item.

        Returns:
            Full-layer selection and authorized path for one calculation.

        Raises:
            SelectionUnavailableError: If catalog access or source inspection fails.
        """
        request = CatalogVectorFilterRequest(
            collectionId=source.collection_id,
            itemId=source.item_id,
            filter=VectorFilter(),
        )
        try:
            return await resolve_selection(self.catalog, self.resolver, request)
        except (VectorFeatureError, OSError, ValueError) as error:
            raise SelectionUnavailableError(
                "The configured catalog vector source is missing or unreadable."
            ) from error

    async def select(
        self,
        request: CatalogVectorFilterRequest | UploadedVectorFilterRequest,
        upload_owner: str | None = None,
    ) -> dict[str, Any]:
        """Count filtered features and return the selection for later polygon reads.

        Args:
            request: Catalog or upload identity and typed predicate.
            upload_owner: Server-derived browser identity for private uploads.

        Returns:
            Exact matched/total counts and a path-free selection descriptor.
            Polygon geometry is read by the calculation or optional outline.

        Raises:
            VectorConflictError: If unavailable, empty, over budget or queue-full.
            SelectionUnavailableError: If the source cannot be read.
            VectorUploadError: If the upload is unavailable to this browser.
            asyncio.CancelledError: After the Jobs client cancels abandoned work.
        """
        resolved = await resolve_selection(
            self.catalog, self.resolver, request, self._uploads, upload_owner
        )
        if self._selection_executor is None:
            raise VectorConflictError("The vector selection executor is unavailable")
        if isinstance(resolved.selection, UploadedSelection):
            await asyncio.to_thread(self._uploads.prepare_source_read, resolved.path)
        result = await self._selection_executor(resolved.selection, upload_owner)
        return {
            **result,
            "selection": resolved.selection.model_dump(mode="json", by_alias=True),
            "filter": request.filter.model_dump(mode="json"),
            "label": (
                resolved.selection.layerName
                if isinstance(request, UploadedVectorFilterRequest)
                else request.item_id
            ),
        }

    async def extent(
        self,
        request: CatalogVectorFilterRequest | UploadedVectorFilterRequest,
        upload_owner: str | None = None,
    ) -> dict[str, Any]:
        """Return original-source bounds for the complete accepted filter.

        Args:
            request: Catalog or upload identity and immutable typed predicate.
            upload_owner: Server-derived browser identity for private uploads.

        Returns:
            Matched count and WGS84 bbox, or null when matches have no coordinates.

        Raises:
            VectorConflictError: If execution is unavailable or the read fails.
            SelectionUnavailableError: If the original source cannot be read.
            VectorUploadError: If the upload is unavailable to this browser.
            asyncio.CancelledError: After Jobs cancels and cleans up abandoned work.
        """
        resolved = await resolve_selection(
            self.catalog, self.resolver, request, self._uploads, upload_owner
        )
        if self._extent_executor is None:
            raise VectorConflictError("The vector zoom executor is unavailable")
        if isinstance(resolved.selection, UploadedSelection):
            await asyncio.to_thread(self._uploads.prepare_source_read, resolved.path)
        return await self._extent_executor(resolved.selection, upload_owner)

    async def outline(
        self, selection: VectorSelection, upload_owner: str | None = None
    ) -> dict[str, Any]:
        """Create a simplified map outline of the selected features.

        Args:
            selection: Catalog or upload descriptor returned by selection.
            upload_owner: Server-derived browser identity for private uploads.

        Returns:
            Approximate FeatureCollection for map display only.

        Raises:
            VectorConflictError: If no executor is supplied, or Jobs display work
                is unavailable or over budget.
            SelectionUnavailableError: If the source identity is invalid.
            VectorUploadError: If the upload is unavailable to this browser.
            asyncio.CancelledError: After the executor's bounded cleanup.
        """
        resolved = await self.resolve_for_sampling(selection, upload_owner)
        if self._outline_executor is None:
            raise VectorConflictError("The map outline executor is unavailable")
        if isinstance(selection, UploadedSelection):
            await asyncio.to_thread(self._uploads.prepare_source_read, resolved.path)
        result = await self._outline_executor(selection, upload_owner)
        return result
