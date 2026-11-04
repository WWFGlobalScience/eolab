"""Measure filtered original-source bounds in a Jobs execution process."""

import asyncio
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt, model_validator

from eolab_app.catalog_selection import SelectionUnavailableError
from eolab_app.vector.selection_operation import SelectionMeasurementInput

CATALOG_URL = "http://stac-api:8080"
SCAN_MOUNT = Path("/scan-source")
UPLOAD_MOUNT = Path("/vector-uploads")

Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)]
Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)]


class FeatureExtent(BaseModel):
    """Exact matching-feature count and combined projected source-feature envelopes.

    Bounds are WGS84 envelopes with densified native edges, not simplified
    display outlines. Null bounds mean no matching feature contains coordinates. Point and other
    zero-area extents are valid; display padding belongs to the map consumer.
    """

    model_config = ConfigDict(extra="forbid")
    matched: NonNegativeInt
    bbox: tuple[Longitude, Latitude, Longitude, Latitude] | None

    @model_validator(mode="after")
    def check_bounds(self) -> "FeatureExtent":
        """Reject unordered bounds or coordinates for an empty selection.

        Returns:
            The validated measurement.

        Raises:
            ValueError: If the completed read returned inconsistent bounds.
        """
        if self.bbox is not None:
            west, south, east, north = self.bbox
            if self.matched == 0 or west > east or south > north:
                raise ValueError("Invalid selected-feature extent")
        return self


class SelectionExtentResult(BaseModel):
    """Completed original-source extent or a readable expected read failure."""

    model_config = ConfigDict(extra="forbid")
    extent: FeatureExtent | None = None
    error: str | None = Field(default=None, min_length=1, max_length=1024)

    @model_validator(mode="after")
    def require_extent_or_error(self) -> "SelectionExtentResult":
        """Require exactly one completed extent or readable error.

        Returns:
            The validated operation result.

        Raises:
            ValueError: If both alternatives are present or both are absent.
        """
        if (self.extent is None) == (self.error is None):
            raise ValueError("Expected an extent or a vector read error")
        return self


def measure_selected_extent(inputs: SelectionMeasurementInput) -> SelectionExtentResult:
    """Read all matching original coordinates in an isolated, bounded worker.

    Args:
        inputs: Path-free immutable selection and private upload owner if needed.

    Returns:
        Combined source-feature envelopes, including empty success, or a safe
        expected read failure.

    Raises:
        VectorFeatureError: Catalog cannot authorize the layer or predicate.
        OSError: A source or process memory limit cannot be inspected.
        ValueError: Native results do not match the operation contract.
    """
    from eolab_app.bounded_geometry import GeometryValidationError
    from eolab_app.vector_uploads import VectorUploadError

    try:
        return asyncio.run(_measure_selected_extent(inputs))
    except (
        GeometryValidationError,
        SelectionUnavailableError,
        VectorUploadError,
    ) as error:
        return SelectionExtentResult(error=str(error))


async def _measure_selected_extent(
    inputs: SelectionMeasurementInput,
) -> SelectionExtentResult:
    """Reauthorize source identity before reading its original filtered extent.

    Args:
        inputs: Immutable source descriptor established at the vector boundary.

    Returns:
        Completed original-source extent with no retained geometry.

    Raises:
        SelectionUnavailableError: Source identity changed or reading failed.
        VectorUploadError: The upload is unavailable to the submitted owner.
        GeometryValidationError: Actual native read work exceeds its budget.
        VectorFeatureError: Catalog cannot authorize the source or predicate.
        OSError: A source or process memory limit cannot be inspected.
        ValueError: Native results do not match the operation contract.
    """
    # Keep GIS libraries out of operation discovery in the Jobs HTTP process.
    import httpx2
    from eolab_app.bounded_vector import _limit_memory
    from eolab_app.vector.catalog import StacVectorCatalog
    from eolab_app.vector.extents import read_selected_extent
    from eolab_app.vector.selection_source import resolve_selection
    from eolab_app.vector.sources import MountedVectorResolver
    from eolab_app.vector_uploads import VectorUploadStore

    async with httpx2.AsyncClient(
        timeout=5, trust_env=False, follow_redirects=False
    ) as client:
        resolved = await resolve_selection(
            StacVectorCatalog(client, CATALOG_URL),
            MountedVectorResolver(SCAN_MOUNT),
            inputs.selection,
            VectorUploadStore(UPLOAD_MOUNT, max_bytes=None),
            inputs.uploadOwner,
        )
        if resolved.selection != inputs.selection:
            raise SelectionUnavailableError(
                "The selected vector identity changed; select it again."
            )
        with _limit_memory():
            extent = FeatureExtent.model_validate(read_selected_extent(resolved))
        return SelectionExtentResult(extent=extent)
