"""Public requests, responses, and internal raster value objects."""

from eolab_app.sampling_box import Wgs84SamplingBox
from eolab_app.catalog_selection import VectorSelection
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal, Protocol
import math

from affine import Affine
from numpy import bool_
from numpy.typing import NDArray

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator
from rasterio.windows import Window

from eolab_app.raster.catalog_contract import (
    MOUNTED_GEOTIFF_COLLECTION_ID,
    MOUNTED_GEOTIFF_ITEM_ID_PATTERN,
)
from eolab_app.raster.source_identity import RasterSourceIdentity


CanonicalWgs84Bounds = tuple[float, float, float, float]
RasterStatisticsCacheKey = tuple[
    tuple[object, ...],
    str,
    tuple[object, ...],
    tuple[int, ...],
]
CategoryCode = Annotated[
    int, Field(strict=True, ge=-9_007_199_254_740_991, le=9_007_199_254_740_991)
]
RASTER_STATISTICS_BIN_COUNT = 64
RASTER_STATISTICS_SAMPLE_GRID_MAX_DIMENSION = 127
RASTER_PAIRED_STATISTICS_BIN_COUNT = 32
RASTER_PAIRED_STATISTICS_SAMPLE_GRID_MAX_DIMENSION = 127
def _exclude_none_from_response(value: object) -> bool:
    """Return whether an optional response field should be omitted.

    Args:
        value: Candidate serialized field value.

    Returns:
        True only when the value is absent.
    """
    return value is None


@dataclass(frozen=True)
class AuthorizedRaster:
    """Immutable raster source approved for reading.

    Authorization establishes a confined path and either catalog identity or
    access to a published file. It does not select or approve WMS, sample-grid,
    statistics, or pixel rendering.

    Attributes:
        source_path: Canonical authorized GeoTIFF path.
        source_signature: Captured catalog identity, or None for a published file.
    """

    source_path: Path
    source_signature: RasterSourceIdentity | None


@dataclass(frozen=True)
class SelectedRasterArea:
    """Projected selection geometry and clipped source-pixel envelope.

    Attributes:
        source_window: Integer source-pixel window containing the selection.
        projected_geometries: Bounded polygons or a streaming numeric-mask reader.
    """

    source_window: Window
    projected_geometries: "tuple[dict[str, object], ...] | RasterAreaMask"


class RasterAreaMask(Protocol):
    """A bounded polygon-membership reader independent of its invoking feature."""

    def rasterize(
        self,
        out_shape: tuple[int, int],
        affine: Affine,
        all_touched: bool,
    ) -> NDArray[bool_]:
        """Rasterize selected polygons into a Boolean mask on the supplied grid.

        Args:
            out_shape: Number of rows and columns in the output mask.
            affine: Mapping from output pixel coordinates to the raster CRS.
            all_touched: Include every pixel touched by a polygon when True;
                otherwise use Rasterio's default pixel-center inclusion rule.

        Returns:
            Boolean array with the supplied shape: True for included pixels
            and False for excluded pixels, using the requested inclusion rule.

        Raises:
            ValueError: If source integrity or bounded reading fails.
        """
        ...


class CatalogRasterRequest(BaseModel):
    """Identify one catalog Item without accepting browser-supplied paths."""

    model_config = ConfigDict(extra="forbid")

    collection_id: Literal[MOUNTED_GEOTIFF_COLLECTION_ID] = Field(
        alias="collectionId",
    )
    item_id: str = Field(
        alias="itemId",
        pattern=MOUNTED_GEOTIFF_ITEM_ID_PATTERN,
        strict=True,
    )


class Wgs84Bounds(BaseModel):
    """One non-wrapping longitude/latitude rectangle selected by the user."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    west: float = Field(strict=True, ge=-180, le=180, allow_inf_nan=False)
    south: float = Field(strict=True, ge=-90, le=90, allow_inf_nan=False)
    east: float = Field(strict=True, ge=-180, le=180, allow_inf_nan=False)
    north: float = Field(strict=True, ge=-90, le=90, allow_inf_nan=False)

    @model_validator(mode="after")
    def require_ordered_non_wrapping_bounds(self) -> "Wgs84Bounds":
        """Reject empty and antimeridian-crossing rectangles.

        Returns:
            The validated bounds model.

        Raises:
            ValueError: If either axis is empty, reversed, or wraps across the
                antimeridian.
        """
        if self.west >= self.east:
            raise ValueError(
                "west must be less than east; antimeridian-crossing bounds "
                "are not supported"
            )
        if self.south >= self.north:
            raise ValueError("south must be less than north")
        return self

    def canonical_tuple(self) -> CanonicalWgs84Bounds:
        """Return the stable tuple used for sampling and cache identity.

        Returns:
            West, south, east, and north in canonical order.
        """
        return (self.west, self.south, self.east, self.north)


class RasterStatisticsArea(BaseModel):
    """Choose one sampling area and optional category codes for raster statistics.

    Attributes:
        selected_bounds: Optional canonical WGS 84 rectangle; absence selects
            the whole raster unless another explicit area is present.
        catalog_selection: Optional immutable catalog or uploaded-vector descriptor;
            absence selects the other explicit area or the whole raster.
        sampling_box: Optional kilometer-based geodesic box, exclusive of the other areas.
        category_values: Optional distinct numeric classification codes. Labels,
            colors and opacity remain outside the analysis contract.
    """

    model_config = ConfigDict(extra="forbid")

    selected_bounds: Wgs84Bounds | None = Field(
        default=None,
        alias="selectedBounds",
    )
    catalog_selection: VectorSelection | None = Field(
        default=None, alias="catalogSelection"
    )
    sampling_box: Wgs84SamplingBox | None = Field(default=None, alias="samplingBox")

    category_values: tuple[CategoryCode, ...] | None = Field(
        default=None, alias="categoryValues", min_length=1, max_length=256
    )

    @model_validator(mode="after")
    def require_strict_sampling_area_union(
        self,
    ) -> "RasterStatisticsArea":
        """Require at most one rectangle, geodesic box or vector sampling area.

        Returns:
            Validated request with one optional explicit sampling area.

        Raises:
            ValueError: If more than one sampling area is supplied.
        """
        if (
            sum(
                value is not None
                for value in (
                    self.selected_bounds,
                    self.catalog_selection,
                    self.sampling_box,
                )
            )
            > 1
        ):
            raise ValueError(
                "selectedBounds, samplingBox and catalogSelection are mutually exclusive"
            )
        if self.category_values is not None and len(set(self.category_values)) != len(
            self.category_values
        ):
            raise ValueError("categoryValues must contain distinct codes")
        return self


class CatalogRasterStatisticsRequest(CatalogRasterRequest, RasterStatisticsArea):
    """Identify a catalog raster and its explicit sampling area."""


class CatalogRasterPairRequest(BaseModel):
    """Identify ordered X and Y catalog rasters and their sampling area.

    The X and Y identities are intentionally nested catalog requests so the
    public contract cannot accept paths, publication names, or renderer state.
    Both axes may identify the same source.

    Attributes:
        x_raster: Catalog identity assigned to the reference X grid.
        y_raster: Catalog identity aligned to X with nearest-neighbor
            resampling.
        selected_bounds: Optional canonical WGS 84 rectangle intersected with
            the rasters' geographic overlap.
        catalog_selection: Optional Catalog or uploaded-vector selection used
            instead of rectangular bounds.
        sampling_box: Optional kilometer-based geodesic box, exclusive of other areas.
    """

    model_config = ConfigDict(extra="forbid")

    x_raster: CatalogRasterRequest = Field(alias="xRaster")
    y_raster: CatalogRasterRequest = Field(alias="yRaster")
    selected_bounds: Wgs84Bounds | None = Field(
        default=None,
        alias="selectedBounds",
    )

    catalog_selection: VectorSelection | None = Field(
        default=None, alias="catalogSelection"
    )
    sampling_box: Wgs84SamplingBox | None = Field(default=None, alias="samplingBox")

    @model_validator(mode="after")
    def reject_ambiguous_sampling_area(self) -> "CatalogRasterPairRequest":
        """Require at most one rectangle, geodesic box or vector selection.

        Returns:
            Validated ordered pair request.

        Raises:
            ValueError: If more than one sampling area is supplied.
        """
        if (
            sum(
                value is not None
                for value in (
                    self.selected_bounds,
                    self.catalog_selection,
                    self.sampling_box,
                )
            )
            > 1
        ):
            raise ValueError(
                "selectedBounds, samplingBox and catalogSelection are mutually exclusive"
            )
        return self


class PublishedRaster(BaseModel):
    """Browser-safe identity of one published WMS layer."""

    layer_name: str = Field(alias="layerName")
    bbox: tuple[float, float, float, float]


class CatalogPixelRequest(CatalogRasterRequest):
    """Identify one catalog raster and a WGS 84 position to sample."""

    longitude: float = Field(
        strict=True,
        ge=-180,
        le=180,
        allow_inf_nan=False,
    )
    latitude: float = Field(
        strict=True,
        ge=-90,
        le=90,
        allow_inf_nan=False,
    )


class RasterPixel(BaseModel):
    """One band-1 pixel sampled from an authorized catalog raster."""

    longitude: float
    latitude: float
    row: int | None
    column: int | None
    in_bounds: bool = Field(alias="inBounds")
    value: float | None


class RasterValueRange(BaseModel):
    """Three values accepted by the shared dynamic raster style.

    Ordering is enforced by the owning response or style contract.

    Attributes:
        minimum: Low color-stop value.
        midpoint: Middle color-stop value.
        maximum: High color-stop value.
    """

    minimum: FiniteFloat
    midpoint: FiniteFloat
    maximum: FiniteFloat


class RasterPercentiles(BaseModel):
    """Percentiles calculated from finite, non-nodata sample values.

    Attributes:
        p05: Fifth percentile of valid sampled values.
        p50: Median of valid sampled values.
        p95: Ninety-fifth percentile of valid sampled values.
    """

    p05: FiniteFloat
    p50: FiniteFloat
    p95: FiniteFloat


class RasterHistogram(BaseModel):
    """Fixed-bin histogram calculated from the bounded raster sample.

    Attributes:
        counts: Valid-sample counts for the fixed 64 bins.
        edges: Strictly increasing 65 bin-edge values.
    """

    counts: list[int]
    edges: list[FiniteFloat]


class RasterPairedHistogram(BaseModel):
    """Fixed two-dimensional histogram and its marginal distributions.

    Matrix rows increase along Y and columns increase along X. This explicit
    orientation lets the browser render the lowest Y bin at the visual bottom
    without inferring array semantics.

    Attributes:
        x_edges: Strictly increasing X bin edges.
        y_edges: Strictly increasing Y bin edges.
        counts: Y-major rows containing X-bin paired counts.
        x_marginal_counts: Counts collapsed across every Y row.
        y_marginal_counts: Counts collapsed across every X column.
    """

    x_edges: list[FiniteFloat] = Field(alias="xEdges")
    y_edges: list[FiniteFloat] = Field(alias="yEdges")
    counts: list[list[int]]
    x_marginal_counts: list[int] = Field(alias="xMarginalCounts")
    y_marginal_counts: list[int] = Field(alias="yMarginalCounts")


class RasterPairedStatistics(BaseModel):
    """Bounded paired-raster distribution on the documented X reference grid.

    Attributes:
        scope: Whole overlap, rectangle, geodesic box or vector-selection discriminator.
        selected_bounds: Requested rectangle for ``selectedArea`` only.
        sampling_box: Requested center and size for ``samplingBox`` only.
        reference_grid: Fixed declaration that X owns cell locations.
        resampling: Fixed nearest-neighbor alignment applied to Y.
        source_width: Width of the bounded X reference envelope.
        source_height: Height of the bounded X reference envelope.
        source_pixel_count: Cell count of that X envelope.
        sample_width: Width of the admitted paired grid.
        sample_height: Height of the admitted paired grid.
        sampled_cell_count: Total admitted grid cells before validity masks.
        paired_sample_count: Cells finite and non-nodata in both rasters.
        sampling_method: Exact small X grid or bounded center-sample grid.
        approximate: Whether the X envelope was downsampled.
        x_minimum: Minimum valid paired X value.
        x_maximum: Maximum valid paired X value.
        y_minimum: Minimum valid paired Y value.
        y_maximum: Maximum valid paired Y value.
        histogram: Fixed 32-by-32 paired histogram with marginals.
    """

    scope: Literal["wholeOverlap", "selectedArea", "catalogSelection", "samplingBox"]
    catalog_selection: VectorSelection | None = Field(
        default=None, alias="catalogSelection", exclude_if=_exclude_none_from_response
    )
    selected_bounds: Wgs84Bounds | None = Field(alias="selectedBounds")
    sampling_box: Wgs84SamplingBox | None = Field(
        default=None, alias="samplingBox", exclude_if=_exclude_none_from_response
    )
    reference_grid: Literal["x"] = Field(default="x", alias="referenceGrid")
    resampling: Literal["nearest"] = "nearest"
    source_width: int = Field(alias="sourceWidth", gt=0)
    source_height: int = Field(alias="sourceHeight", gt=0)
    source_pixel_count: int = Field(alias="sourcePixelCount", gt=0)
    sample_width: int = Field(alias="sampleWidth", gt=0)
    sample_height: int = Field(alias="sampleHeight", gt=0)
    sampled_cell_count: int = Field(alias="sampledCellCount", gt=0)
    paired_sample_count: int = Field(alias="pairedSampleCount", gt=0)
    sampling_method: Literal["sampleGrid", "exactReferenceGrid"] = Field(
        alias="samplingMethod"
    )
    approximate: bool
    x_minimum: FiniteFloat = Field(alias="xMinimum")
    x_maximum: FiniteFloat = Field(alias="xMaximum")
    y_minimum: FiniteFloat = Field(alias="yMinimum")
    y_maximum: FiniteFloat = Field(alias="yMaximum")
    histogram: RasterPairedHistogram

    @model_validator(mode="after")
    def require_paired_provenance(self) -> "RasterPairedStatistics":
        """Keep grid, validity, orientation, and histogram totals coherent.

        Returns:
            Validated paired statistics response.

        Raises:
            ValueError: If provenance, dimensions, edges, matrix, or marginals
                violate the bounded public response contract.
        """
        if (self.scope == "samplingBox") != (self.sampling_box is not None):
            raise ValueError("paired statistics scope and sampling box disagree")
        if (self.scope == "selectedArea") != (self.selected_bounds is not None):
            raise ValueError("paired statistics scope and bounds disagree")
        if (self.scope == "catalogSelection") != (self.catalog_selection is not None):
            raise ValueError("paired statistics scope and catalog selection disagree")
        if self.source_pixel_count != self.source_width * self.source_height:
            raise ValueError("paired source pixel count is inconsistent")
        if self.sampled_cell_count != self.sample_width * self.sample_height:
            raise ValueError("paired sampled cell count is inconsistent")
        if (
            self.sample_width > RASTER_PAIRED_STATISTICS_SAMPLE_GRID_MAX_DIMENSION
            or self.sample_height
            > RASTER_PAIRED_STATISTICS_SAMPLE_GRID_MAX_DIMENSION
            or self.sample_width > self.source_width
            or self.sample_height > self.source_height
            or self.paired_sample_count > self.sampled_cell_count
        ):
            raise ValueError("paired sample dimensions exceed fixed limits")
        expected_approximate = self.sampling_method == "sampleGrid"
        if self.approximate != expected_approximate:
            raise ValueError("paired sampling provenance is inconsistent")
        if self.sampling_method == "exactReferenceGrid" and (
            self.sample_width != self.source_width
            or self.sample_height != self.source_height
        ):
            raise ValueError("exact paired sampling must cover the X envelope")
        if self.x_minimum > self.x_maximum or self.y_minimum > self.y_maximum:
            raise ValueError("paired sample ranges are reversed")

        bin_count = RASTER_PAIRED_STATISTICS_BIN_COUNT
        histogram = self.histogram
        if (
            len(histogram.x_edges) != bin_count + 1
            or len(histogram.y_edges) != bin_count + 1
            or len(histogram.counts) != bin_count
            or any(len(row) != bin_count for row in histogram.counts)
            or len(histogram.x_marginal_counts) != bin_count
            or len(histogram.y_marginal_counts) != bin_count
        ):
            raise ValueError("paired histogram dimensions are inconsistent")
        if not all(
            left < right
            for edges in (histogram.x_edges, histogram.y_edges)
            for left, right in zip(edges, edges[1:])
        ):
            raise ValueError("paired histogram edges are not increasing")
        if (
            histogram.x_edges[0] > self.x_minimum
            or histogram.x_edges[-1] < self.x_maximum
            or histogram.y_edges[0] > self.y_minimum
            or histogram.y_edges[-1] < self.y_maximum
        ):
            raise ValueError("paired histogram edges exclude sample values")
        if any(count < 0 for row in histogram.counts for count in row):
            raise ValueError("paired histogram counts cannot be negative")
        x_marginals = [
            sum(row[column] for row in histogram.counts)
            for column in range(bin_count)
        ]
        y_marginals = [sum(row) for row in histogram.counts]
        if (
            x_marginals != histogram.x_marginal_counts
            or y_marginals != histogram.y_marginal_counts
            or sum(x_marginals) != self.paired_sample_count
        ):
            raise ValueError("paired histogram marginals are inconsistent")
        return self


class RasterCategoricalDistribution(BaseModel):
    """Numeric classification areas, independent of labels and rendering.

    Attributes:
        category_values: Canonically sorted exact integer classification codes.
        areas_hectares: Estimated valid selected hectares for each matching code.
        unmapped_area_hectares: Valid selected hectares matching no supplied code.
        valid_area_hectares: Sum of classified and unmapped valid coverage.
        nodata_area_hectares: Selected hectares represented by missing samples.
        area_estimated: Areas and percentages are estimates, including small grids.
        area_method: Fixed WGS84 equal-area sample-cell quadrature method.
        selection_subdivisions: Subcells per sample-cell edge for mask/area weights.
    """

    category_values: tuple[CategoryCode, ...] = Field(
        alias="categoryValues", min_length=1, max_length=256
    )
    areas_hectares: list[Annotated[FiniteFloat, Field(ge=0)]] = Field(
        alias="areasHectares", min_length=1, max_length=256
    )
    unmapped_area_hectares: FiniteFloat = Field(alias="unmappedAreaHectares", ge=0)
    valid_area_hectares: FiniteFloat = Field(alias="validAreaHectares", gt=0)
    nodata_area_hectares: FiniteFloat = Field(alias="nodataAreaHectares", ge=0)
    area_estimated: Literal[True] = Field(default=True, alias="areaEstimated")
    area_method: Literal["sample-cell-equal-area-v1"] = Field(
        default="sample-cell-equal-area-v1", alias="areaMethod"
    )
    selection_subdivisions: Literal[4] = Field(default=4, alias="selectionSubdivisions")

    @model_validator(mode="after")
    def require_area_balance(self) -> "RasterCategoricalDistribution":
        """Validate classification cardinality, code order and area conservation.

        Returns:
            The validated bounded classification result.

        Raises:
            ValueError: If codes, cardinality or valid-area totals are inconsistent.
        """
        if tuple(sorted(set(self.category_values))) != self.category_values:
            raise ValueError("Categorical codes must be distinct and sorted")
        if len(self.areas_hectares) != len(self.category_values):
            raise ValueError("Categorical areas must match the supplied codes")
        if not math.isclose(
            math.fsum(self.areas_hectares) + self.unmapped_area_hectares,
            self.valid_area_hectares,
            rel_tol=1e-9,
            abs_tol=1e-9,
        ):
            raise ValueError("Categorical areas must sum to valid coverage")
        return self


class RasterStatistics(BaseModel):
    """Bounded raster distribution with explicit area and sampling provenance.

    Attributes:
        band: Fixed source band summarized by this response.
        scope: Whole-raster, rectangle, geodesic-box or catalog-selection discriminator.
        selected_bounds: Canonical WGS 84 rectangle for ``selectedArea`` only.
        sampling_box: Requested center and size for ``samplingBox`` only.
        catalog_selection: Catalog or uploaded-vector descriptor for ``catalogSelection``.
        source_width: Width of the integral source envelope in pixels.
        source_height: Height of the integral source envelope in pixels.
        source_pixel_count: Pixel count of the integral source envelope.
        sample_width: Width of the exact or sampled numeric grid.
        sample_height: Height of the exact or sampled numeric grid.
        sampled_pixel_count: Number of cells in the numeric grid.
        valid_sample_count: Finite, non-nodata cells retained by the area mask.
        sampling_method: Exact bounded window or approximate center-sample grid.
        estimated: Whether distribution values come from the sample grid.
        sample_minimum: Minimum valid sampled value.
        sample_maximum: Maximum valid sampled value.
        percentiles: Fixed percentiles of valid sampled values.
        histogram: Fixed 64-bin distribution of valid sampled values.
        suggested_range: Strict range suggested for downstream color controls.
        categorical_distribution: Optional bounded numeric category-area estimate.
    """

    band: Literal[1] = 1
    scope: Literal["wholeRaster", "selectedArea", "catalogSelection", "samplingBox"]
    selected_bounds: Wgs84Bounds | None = Field(alias="selectedBounds")
    sampling_box: Wgs84SamplingBox | None = Field(
        default=None, alias="samplingBox", exclude_if=_exclude_none_from_response
    )
    catalog_selection: VectorSelection | None = Field(
        default=None, alias="catalogSelection", exclude_if=_exclude_none_from_response
    )
    source_width: int = Field(alias="sourceWidth", gt=0)
    source_height: int = Field(alias="sourceHeight", gt=0)
    source_pixel_count: int = Field(alias="sourcePixelCount", gt=0)
    sample_width: int = Field(alias="sampleWidth", gt=0)
    sample_height: int = Field(alias="sampleHeight", gt=0)
    sampled_pixel_count: int = Field(alias="sampledPixelCount", gt=0)
    valid_sample_count: int = Field(alias="validSampleCount", gt=0)
    sampling_method: Literal["sampleGrid", "exactSourceWindow"] = Field(
        alias="samplingMethod"
    )
    estimated: bool
    sample_minimum: FiniteFloat = Field(alias="sampleMinimum")
    sample_maximum: FiniteFloat = Field(alias="sampleMaximum")
    percentiles: RasterPercentiles
    histogram: RasterHistogram
    suggested_range: RasterValueRange = Field(alias="suggestedRange")
    categorical_distribution: RasterCategoricalDistribution | None = Field(
        default=None,
        alias="categoricalDistribution",
        exclude_if=_exclude_none_from_response,
    )

    @model_validator(mode="after")
    def require_scope_provenance(self) -> "RasterStatistics":
        """Keep area, sampling, and distribution provenance self-consistent.

        Returns:
            The validated statistics model.

        Raises:
            ValueError: If scope fields, counts, sampling method, percentiles,
                histogram, or suggested range violate the response contract.
        """
        has_bounds = self.selected_bounds is not None
        has_catalog_selection = self.catalog_selection is not None
        if (self.scope == "samplingBox") != (self.sampling_box is not None):
            raise ValueError("statistics scope and sampling box disagree")
        if self.scope == "samplingBox" and (has_bounds or has_catalog_selection):
            raise ValueError(
                "samplingBox statistics require only a sampling box descriptor"
            )
        if self.scope == "wholeRaster" and (has_bounds or has_catalog_selection):
            raise ValueError("wholeRaster statistics cannot identify a selected area")
        if self.scope == "selectedArea" and (not has_bounds or has_catalog_selection):
            raise ValueError("selectedArea statistics require only selected bounds")
        if self.scope == "catalogSelection" and (
            has_bounds or not has_catalog_selection
        ):
            raise ValueError(
                "catalogSelection statistics require only a catalog selection descriptor"
            )
        if self.estimated != (self.sampling_method == "sampleGrid"):
            raise ValueError(
                "statistics estimate metadata must match its sampling method"
            )
        if self.source_pixel_count != self.source_width * self.source_height:
            raise ValueError("statistics source pixel count is inconsistent")
        if self.sampled_pixel_count != self.sample_width * self.sample_height:
            raise ValueError("statistics sampled pixel count is inconsistent")
        if self.valid_sample_count > self.sampled_pixel_count:
            raise ValueError("statistics valid sample count exceeds the sample")
        if (
            self.sample_width > self.source_width
            or self.sample_height > self.source_height
        ):
            raise ValueError("statistics sample dimensions exceed the source")
        if self.sampling_method == "sampleGrid" and max(
            self.sample_width,
            self.sample_height,
        ) > RASTER_STATISTICS_SAMPLE_GRID_MAX_DIMENSION:
            raise ValueError("statistics sample grid exceeds its fixed dimension")
        if self.sampling_method == "exactSourceWindow" and (
            self.sample_width != self.source_width
            or self.sample_height != self.source_height
        ):
            raise ValueError("exact statistics must cover the source window")
        if not (
            self.sample_minimum
            <= self.percentiles.p05
            <= self.percentiles.p50
            <= self.percentiles.p95
            <= self.sample_maximum
        ):
            raise ValueError("statistics percentiles are not ordered")
        if (
            len(self.histogram.counts) != RASTER_STATISTICS_BIN_COUNT
            or len(self.histogram.edges) != RASTER_STATISTICS_BIN_COUNT + 1
            or any(count < 0 for count in self.histogram.counts)
            or sum(self.histogram.counts) != self.valid_sample_count
        ):
            raise ValueError("statistics histogram counts are inconsistent")
        if not all(
            left < right
            for left, right in zip(
                self.histogram.edges,
                self.histogram.edges[1:],
            )
        ) or (
            self.histogram.edges[0] > self.sample_minimum
            or self.histogram.edges[-1] < self.sample_maximum
        ):
            raise ValueError("statistics histogram edges are inconsistent")
        if not (
            self.suggested_range.minimum
            < self.suggested_range.midpoint
            < self.suggested_range.maximum
        ):
            raise ValueError("statistics suggested range is not ordered")
        return self
