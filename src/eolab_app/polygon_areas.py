"""Validate, identify and load temporary browser-owned polygon areas."""

import asyncio
import hashlib
import json
from collections.abc import Callable
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator
from shapely.geometry import Polygon

MAX_POLYGON_AREA_BYTES = 8 * 1024 * 1024
MAX_POLYGON_AREA_COORDINATES = 100_000
Coordinate = tuple[
    Annotated[float, Field(strict=True, ge=-180, le=180, allow_inf_nan=False)],
    Annotated[
        float, Field(strict=True, ge=-85.05112878, le=85.05112878, allow_inf_nan=False)
    ],
]


class SummaryPolygon(BaseModel):
    """A browser-supplied, closed WGS84 polygon without holes."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    type: Literal["Polygon"] = "Polygon"
    coordinates: tuple[
        Annotated[tuple[Coordinate, ...], Field(min_length=4, max_length=2001)]
    ]

    @model_validator(mode="after")
    def validate_ring(self) -> Self:
        """Check that the ring is closed and has usable, non-crossing edges.

        Returns:
            This polygon when it encloses a valid area.

        Raises:
            ValueError: If the ring is open, self-crossing or has zero area.
        """
        ring = self.coordinates[0]
        if ring[0] != ring[-1]:
            raise ValueError("A summary polygon must end at its starting vertex.")
        polygon = Polygon(ring)
        if not polygon.is_valid or polygon.area == 0:
            raise ValueError(
                "A summary polygon must have three distinct vertices and must not cross itself."
            )
        return self


class PolygonSummaryInput(BaseModel):
    """Committed, filtered polygons; names, notes and styles are not calculation inputs."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    polygons: Annotated[tuple[SummaryPolygon, ...], Field(min_length=1, max_length=500)]

    @model_validator(mode="after")
    def limit_coordinates(self) -> Self:
        """Bound total geometry work before storing or projecting the selection.

        Returns:
            This input when its coordinate count fits the calculation budget.

        Raises:
            ValueError: If more than 100,000 coordinates were supplied.
        """
        if (
            sum(len(p.coordinates[0]) for p in self.polygons)
            > MAX_POLYGON_AREA_COORDINATES
        ):
            raise ValueError(
                "The summary area exceeds 100,000 coordinates. Filter to fewer polygons."
            )
        return self

    def geometry_hash(self) -> str:
        """Identify this exact polygon set independently of feature ordering.

        Returns:
            SHA-256 of sorted, deduplicated geometry, excluding presentation data.
        """
        polygons = sorted(
            {
                json.dumps(p.model_dump(), sort_keys=True, separators=(",", ":"))
                for p in self.polygons
            }
        )
        return hashlib.sha256(
            json.dumps(polygons, separators=(",", ":")).encode()
        ).hexdigest()

    def bounds(self) -> tuple[float, float, float, float]:
        """Return the longitude/latitude envelope of the complete polygon set.

        Returns:
            West, south, east and north coordinates.
        """
        points = [
            point for polygon in self.polygons for point in polygon.coordinates[0]
        ]
        return (
            min(p[0] for p in points),
            min(p[1] for p in points),
            max(p[0] for p in points),
            max(p[1] for p in points),
        )


class PolygonAreaReference(BaseModel):
    """An expiring browser-owned input ID and the hash of its exact geometry."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    id: Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]
    sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class PolygonAreaUploadResponse(BaseModel):
    """Private summary-area reference and selection size returned after upload."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    polygonArea: PolygonAreaReference
    bbox: tuple[float, float, float, float]
    matched: Annotated[int, Field(ge=1, le=500)]


async def read_polygon_area_input(
    get_input: Callable[[str, str, str], dict[str, Any]],
    owner: str,
    reference: PolygonAreaReference,
) -> PolygonSummaryInput:
    """Read the validated polygons stored under an unexpired, owned reference.

    Storage errors propagate to the caller for translation.

    Args:
        get_input: Storage read that checks owner, expiry and content identity.
        owner: Server-derived browser-session hash.
        reference: Temporary input ID and expected geometry hash.

    Returns:
        Immutable polygon coordinates validated at the storage boundary.

    Raises:
        ValueError: If persisted geometry violates the polygon contract.
    """

    def load_polygons() -> PolygonSummaryInput:
        """Validate an owned polygon payload off the event loop.

        Returns:
            Immutable polygon input from the store.

        Raises:
            ValueError: If the stored geometry is invalid.
        """
        return PolygonSummaryInput.model_validate(
            get_input(owner, reference.id, reference.sha256)
        )

    return await asyncio.to_thread(load_polygons)
