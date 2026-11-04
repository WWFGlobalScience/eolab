"""Reusable bounded sampling-area contracts for raster analysis."""

from eolab_app.sampling_box import Wgs84SamplingBox
from dataclasses import dataclass
from typing import Literal, TypeAlias

from eolab_app.raster.models import CanonicalWgs84Bounds
from eolab_app.catalog_selection import ResolvedCatalogSelection


@dataclass(frozen=True)
class WholeRasterSamplingArea:
    """Select every source cell through the bounded whole-raster grid."""

    kind: Literal["wholeRaster"] = "wholeRaster"

    def cache_identity(self) -> tuple[str]:
        """Return the stable whole-raster cache identity.

        Returns:
            Single whole-raster discriminator.
        """
        return (self.kind,)


@dataclass(frozen=True)
class SelectedBoundsSamplingArea:
    """Select cells intersecting one canonical WGS 84 rectangle.

    Attributes:
        bounds: West, south, east, and north in longitude/latitude order.
        kind: Stable rectangular-area discriminator.
    """

    bounds: CanonicalWgs84Bounds
    kind: Literal["selectedArea"] = "selectedArea"

    def cache_identity(self) -> tuple[str, CanonicalWgs84Bounds]:
        """Return the stable rectangular cache identity.

        Returns:
            Scope discriminator and canonical rectangle.
        """
        return self.kind, self.bounds


@dataclass(frozen=True)
class SamplingBoxArea:
    """Select the geodesic quadrilateral retained by its center and kilometer size.

    Attributes:
        box: Validated nonwrapping WGS84 descriptor; polygon rings remain read-local.
        kind: Public sampling-box discriminator.
    """

    box: Wgs84SamplingBox
    kind: Literal["samplingBox"] = "samplingBox"

    def cache_identity(self) -> tuple[str, float, float, int]:
        """Return the exact center and size used to coalesce identical box reads.

        Returns:
            Scope, longitude, latitude and side length in kilometers.
        """
        return (
            self.kind,
            self.box.center.longitude,
            self.box.center.latitude,
            self.box.sideLengthKm,
        )


@dataclass(frozen=True)
class CatalogSelectionSamplingArea:
    """Select exact polygons read from an immutable catalog descriptor.

    Attributes:
        resolved: Private source capability resolved by the Catalog authority.
        kind: Public selection discriminator.
    """

    resolved: ResolvedCatalogSelection
    kind: Literal["catalogSelection"] = "catalogSelection"

    def cache_identity(self) -> tuple[str, str]:
        """Return the full source, native-layer and predicate identity.

        Returns:
            Scope and deterministic descriptor JSON for cache/coalescing keys.
        """
        return self.kind, self.resolved.selection.model_dump_json(by_alias=True)


RasterSamplingArea: TypeAlias = (
    WholeRasterSamplingArea
    | SelectedBoundsSamplingArea
    | SamplingBoxArea
    | CatalogSelectionSamplingArea
)
