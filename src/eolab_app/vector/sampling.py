"""Coordinate vector selection checks, summaries, and map display outlines.

Source/filter preparation lives in selection_source so local work and the Jobs
operation use the same rules without the operation constructing this service.
This service retains selection admission, reauthorization, and execution routing;
an unavailable outline does not prevent numeric analysis of the selection.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from eolab_app.catalog_selection import (
    CatalogSelection,
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
    run_bounded_process,
)
from eolab_app.vector.errors import VectorConflictError, VectorFeatureError
from eolab_app.vector.filters import (
    CatalogVectorFilterRequest,
)
from eolab_app.bounded_vector import READ_SECONDS, summary_process
from eolab_app.vector.ports import VectorCatalog
from eolab_app.vector.selection_source import resolve_selection
from eolab_app.vector.sources import MountedVectorResolver


class VectorSamplingService:
    """Authorize direct catalog selections without retaining geometry or IDs."""

    def __init__(
        self,
        catalog: VectorCatalog,
        resolver: MountedVectorResolver,
        outline_executor: (
            Callable[[CatalogSelection], Awaitable[dict[str, Any]]] | None
        ) = None,
    ) -> None:
        """Connect source authority and bounded execution.

        Args:
            catalog: Authoritative Catalog reader.
            resolver: Exact mounted vector source resolver.
            outline_executor: Jobs adapter supplied by application composition.
                Omit for selection-only consumers; outline() then reports
                unavailable without starting local display work.
        """
        self.catalog = catalog
        self.resolver = resolver
        self._slots = asyncio.Semaphore(2)
        self._outline_executor = outline_executor

    async def resolve_for_sampling(
        self, selection: CatalogSelection
    ) -> ResolvedCatalogSelection:
        """Reauthorize descriptor identity, source signature and native layer.

        Args:
            selection: Validated path-free immutable descriptor.

        Returns:
            Current private source capability.

        Raises:
            SelectionUnavailableError: If identity, source or predicate changed.
        """
        try:
            resolved = await resolve_selection(self.catalog, self.resolver, selection)
        except (VectorFeatureError, OSError, ValueError) as error:
            raise SelectionUnavailableError(
                "The catalog vector is unavailable; select it again."
            ) from error
        if resolved.selection != selection:
            raise SelectionUnavailableError(
                "The catalog vector identity changed; select it again."
            )
        return resolved

    async def _run(
        self,
        target: Callable[[ProcessResultWriter, ResolvedCatalogSelection], None],
        resolved: ResolvedCatalogSelection,
    ) -> dict[str, Any]:
        """Run one bounded native selection command without an unbounded queue.

        Args:
            target: Fixed selection-summary process command.
            resolved: Authorized source capability.

        Returns:
            Native result after source reauthorization.

        Raises:
            VectorConflictError: If busy, stale, empty or over actual work budget.
        """
        if self._slots.locked():
            raise VectorConflictError("Vector sampling is busy; retry later")
        async with self._slots:
            try:
                success, result = await run_bounded_process(
                    target, (resolved,), READ_SECONDS
                )
            except ProcessDeadlineError as error:
                raise VectorConflictError(
                    "Vector reading exceeded its time budget"
                ) from error
            if not success:
                raise VectorConflictError(result)
            await self.resolve_for_sampling(resolved.selection)
            return result

    async def select(self, request: CatalogVectorFilterRequest) -> dict[str, Any]:
        """Measure a selection without returning or retaining exact coordinates.

        Args:
            request: Catalog identity and typed predicate.

        Returns:
            Exact counts/bounds and path-free selection descriptor.

        Raises:
            VectorConflictError: If empty, stale, busy or over actual read budget.
        """
        resolved = await resolve_selection(self.catalog, self.resolver, request)
        result = await self._run(summary_process, resolved)
        return {
            **result,
            "selection": resolved.selection.model_dump(mode="json", by_alias=True),
            "filter": request.filter.model_dump(mode="json"),
            "label": request.item_id,
        }

    async def outline(self, selection: CatalogSelection) -> dict[str, Any]:
        """Generate optional presentation geometry independently of analysis.

        Args:
            selection: Previously validated catalog descriptor.

        Returns:
            Approximate FeatureCollection for map display only.

        Raises:
            VectorConflictError: If no executor is supplied, or Jobs display work
                is unavailable or over budget.
            SelectionUnavailableError: If the source changed before or during work.
            asyncio.CancelledError: After the executor's bounded cleanup.
        """
        await self.resolve_for_sampling(selection)
        if self._outline_executor is None:
            raise VectorConflictError("The map outline executor is unavailable")
        result = await self._outline_executor(selection)
        await self.resolve_for_sampling(selection)
        return result
