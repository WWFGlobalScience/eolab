"""Describe selected Habitat condition layers and fixed model settings."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator
from rasterio.crs import CRS
from nhi_terrestrial_integrity_modeling.analysis_config import RasterStackConfiguration

from eolab_app.catalog_selection import VectorSelection
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.clip_models import ClipGrid
from eolab_app.processing.polygon_areas import PolygonAreaReference
from eolab_app.raster.models import Wgs84Bounds
from eolab_app.raster.source_models import RasterSourceReference

OPERATION = "habitat.condition.v1"
FiniteNumber = Annotated[float, Field(allow_inf_nan=False)]
Fraction = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
PositiveInteger = Annotated[int, Field(strict=True, gt=0)]
PositiveNumber = Annotated[float, Field(gt=0, allow_inf_nan=False)]
ResamplingMethod = Literal["nearest", "bilinear", "cubic", "average", "mode"]
FITTING_COLUMN_NAMES = frozenset(
    {
        "validation_block_column",
        "validation_block_row",
        "validation_block_id",
        "reference_area_m2",
        "spatial_fold",
        "imputed_predictor_count",
        "missing_predictor_fraction",
        "usable_for_gam",
    }
)
"""Columns upstream fitting writes into the table containing the selected bands."""


class HabitatSchema(BaseModel):
    """Reject unknown Habitat input fields and keep admitted values immutable."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class NamedHabitatRaster(HabitatSchema):
    """A selected raster and the variable name used in fitting and diagnostics."""

    name: Annotated[str, Field(min_length=1)]
    source: RasterSourceReference


class HabitatRasterStack(HabitatSchema):
    """The final predictor and response choices, including one categorical predictor.

    Names are unique across both roles. Inputs are prepared on the run's requested
    grid before sampling and fitting.
    """

    predictors: Annotated[tuple[NamedHabitatRaster, ...], Field(min_length=1)]
    responses: Annotated[tuple[NamedHabitatRaster, ...], Field(min_length=1)]
    categoricalPredictor: str

    @model_validator(mode="after")
    def check_variable_names(self) -> Self:
        """Require unambiguous names that upstream fitting will not overwrite.

        Returns:
            This stack with unambiguous variable roles.

        Raises:
            ValueError: If names repeat, collide with fitting columns, or omit
                the categorical predictor.
        """
        names = [band.name for band in (*self.predictors, *self.responses)]
        if len(names) != len(set(names)):
            raise ValueError("Predictor and response variable names must be unique.")
        collisions = set(names) & FITTING_COLUMN_NAMES
        if collisions:
            raise ValueError(
                "Variable names conflict with fitting columns: "
                + ", ".join(sorted(collisions))
            )
        if self.categoricalPredictor not in {band.name for band in self.predictors}:
            raise ValueError("Choose a categorical predictor from the predictor stack.")
        return self


class HabitatEarthEngineStack(HabitatSchema):
    """An assessment year for the packaged Earth Engine predictor/response stack.

    The scientific configuration loader owns the supported year range. Reference
    sites still come from the user's separate selection, never from Earth Engine.
    """

    kind: Literal["earthEngine"]
    year: Annotated[int, Field(strict=True)]


HabitatStack = HabitatRasterStack | HabitatEarthEngineStack
"""Manual raster choices or the packaged Earth Engine variables for one year."""


class RasterReferenceSites(HabitatSchema):
    """Use cells equal to one after the selected resampling as reference sites."""

    kind: Literal["raster"]
    source: RasterSourceReference


class VectorReferenceSites(HabitatSchema):
    """Use selected Catalog or uploaded polygons as reference sites."""

    kind: Literal["vector"]
    selection: VectorSelection


HabitatReferences = Annotated[
    RasterReferenceSites | VectorReferenceSites, Field(discriminator="kind")
]


class HabitatPreparation(HabitatSchema):
    """Requested output grid and one resampling method for each selected raster.

    Attributes:
        crs: Requested output coordinate system.
        pixelSize: Positive X/Y pixel sizes in the requested CRS's units.
        origin: Grid intersection anchoring the AOI's outward-snapped bounds.
        resampling: Methods keyed by predictor_N, response_N, reference_mask or
            habitat_mask, matching the selected source roles exactly.
            Automatic bands use nearest-neighbor resampling; in automatic mode
            this mapping contains only the user-selected raster masks.
    """

    crs: str
    pixelSize: tuple[PositiveNumber, PositiveNumber]
    origin: tuple[FiniteNumber, FiniteNumber]
    resampling: dict[str, ResamplingMethod]


class HabitatSettings(HabitatSchema):
    """Projection, scientific and sampling settings fixed by the model recipe.

    Attributes:
        required_crs: Equal-area projection required by the current Habitat runner.
        fold_count: Number of spatial cross-validation folds.
        sampling_block_size_meters: Width of equal-area sampling blocks.
        validation_block_size_meters: Width of grouped validation blocks.
        minimum_predictor_coverage: Sampled-area coverage needed to keep a predictor.
        maximum_row_missing_fraction: Largest predictor missing fraction in a modeled row.
        spline_knot_count: Number of spline knots for each continuous predictor.
        minimum_response_coverage: Reference-area coverage needed to fit a response.
        ridge_alpha: Nonnegative L2 regularization strength.
        samples_per_class_per_block: Sample cap for each block and reference class.
        random_seed: Seed for reproducible sample selection.
        tile_size_pixels: Width of virtual sampling tiles.
        window_size_pixels: Width and height of prediction windows.
        covariance_shrinkage: Fraction used to regularize the reference covariance.
        tile_origin: EPSG:6933 origin anchoring the virtual sampling tiles.
    """

    required_crs: Literal["EPSG:6933"]
    fold_count: Annotated[int, Field(strict=True, ge=2)]
    sampling_block_size_meters: PositiveInteger
    validation_block_size_meters: PositiveInteger
    minimum_predictor_coverage: Fraction
    maximum_row_missing_fraction: Fraction
    spline_knot_count: Annotated[int, Field(strict=True, ge=2)]
    minimum_response_coverage: Fraction
    ridge_alpha: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    samples_per_class_per_block: PositiveInteger
    random_seed: Annotated[int, Field(strict=True)]
    tile_size_pixels: PositiveInteger
    window_size_pixels: PositiveInteger
    covariance_shrinkage: Annotated[float, Field(gt=0, lt=1, allow_inf_nan=False)]
    tile_origin: tuple[FiniteNumber, FiniteNumber]


class HabitatRequest(HabitatSchema):
    """Capture layers, assessment area, raster preparation and settings for one run."""

    stack: HabitatStack
    references: HabitatReferences
    habitat_mask: RasterSourceReference | None
    preparation: HabitatPreparation
    settings: HabitatSettings
    selectedBounds: Wgs84Bounds | None = None
    catalogSelection: VectorSelection | None = None
    polygonArea: PolygonAreaReference | None = None
    wholeRaster: Literal[True] | None = None

    def get_raster_sources(self) -> dict[str, RasterSourceReference]:
        """Return all selected rasters under their preparation and retention roles.

        Returns:
            Manually selected predictor and response positions, plus raster
            references and assessment masks in either mode. Downloaded tiles have
            no Catalog identity and are not declared as external raster sources.
        """
        sources = {}
        if isinstance(self.stack, HabitatRasterStack):
            sources = {
                f"predictor_{index}": band.source
                for index, band in enumerate(self.stack.predictors)
            }
            sources.update(
                {
                    f"response_{index}": band.source
                    for index, band in enumerate(self.stack.responses)
                }
            )
        if isinstance(self.references, RasterReferenceSites):
            sources["reference_mask"] = self.references.source
        if self.habitat_mask is not None:
            sources["habitat_mask"] = self.habitat_mask
        return sources

    @model_validator(mode="after")
    def check_preparation(self) -> Self:
        """Require explicit methods for active rasters and the model's projection.

        Returns:
            This request with one method per raster and a supported target CRS.

        Raises:
            ValueError: If a method is missing or names an inactive source, or
                the requested CRS differs from the model's requirement.
        """
        if set(self.preparation.resampling) != set(self.get_raster_sources()):
            raise ValueError("Choose one resampling method for each selected raster.")
        if CRS.from_user_input(self.preparation.crs) != CRS.from_user_input(
            self.settings.required_crs
        ):
            raise ValueError(
                f"Ecosystem Condition requires {self.settings.required_crs}."
            )
        return self

    @model_validator(mode="after")
    def check_area_choice(self) -> Self:
        """Require exactly one assessment-area choice in submitted or saved inputs.

        Returns:
            This request with one explicit assessment area.

        Raises:
            ValueError: If no area or several areas were supplied.
        """
        if (
            sum(
                value is not None
                for value in (
                    self.selectedBounds,
                    self.catalogSelection,
                    self.polygonArea,
                    self.wholeRaster,
                )
            )
            != 1
        ):
            raise ValueError(
                "Choose one box, vector selection, polygon area, or whole raster."
            )
        if isinstance(self.stack, HabitatEarthEngineStack) and self.wholeRaster:
            raise ValueError(
                "Choose an explicit analysis area for Earth Engine inputs."
            )
        return self


class QueuedHabitat(HabitatSchema):
    """Accepted Habitat inputs awaiting worker preparation and source resolution."""

    operation: Literal["habitat.condition.v1"] = OPERATION
    request: HabitatRequest
    polygonArea: AggregateArea | None = None


class HabitatCalculationInputs(HabitatSchema):
    """Captured Habitat inputs, exact area descriptor and the requested output grid.

    Grid datatype and NoData describe the runner's primary Reference similarity
    output: float32 with valid values from 0 to 1 and -9999 for missing values.
    Temporary aligned inputs use float64 and NaN NoData on the same spatial grid.
    The window starts at zero; nativeBlocks counts 512-pixel preparation tiles.
    earthEngine captures the packaged scientific source definitions for automatic
    inputs; it contains no credentials, local paths or generated reference sites.
    """

    operation: Literal["habitat.condition.v1"] = OPERATION
    inputs: HabitatRequest
    area: AggregateArea
    grid: ClipGrid
    earthEngine: RasterStackConfiguration | None = None
