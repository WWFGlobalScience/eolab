"""Expose Habitat's configured years, grid and linked input datasets for setup."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from eolab_app.processing.habitat_earth_engine import load_habitat_stack
from eolab_app.raster.source_models import ProjectedRasterGrid

HABITAT_DATASET_LINKS: dict[str, tuple[str, str]] = {
    "LANDSAT/COMPOSITES/C02/T1_L2_8DAY_NDVI": (
        "Landsat NDVI composites",
        "https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_COMPOSITES_C02_T1_L2_8DAY_NDVI",
    ),
    "MODIS/061/MCD12Q2": (
        "MODIS land-cover dynamics / phenology",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MCD12Q2",
    ),
    "projects/global-pasture-watch/assets/gsvh-30m/v1/short-veg-height_m": (
        "Global Pasture Watch short vegetation height",
        "https://developers.google.com/earth-engine/datasets/catalog/projects_global-pasture-watch_assets_gsvh-30m_v1_short-veg-height_m",
    ),
    "MODIS/061/MOD44B": (
        "MODIS vegetation cover",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD44B",
    ),
    "MODIS/061/MOD15A2H": (
        "MODIS LAI / FPAR",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD15A2H",
    ),
    "MODIS/061/MOD17A3HGF": (
        "MODIS annual productivity",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD17A3HGF",
    ),
    "ECMWF/ERA5/DAILY": (
        "ERA5 daily aggregates",
        "https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_DAILY",
    ),
    "ECMWF/ERA5/MONTHLY": (
        "ERA5 monthly aggregates",
        "https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_MONTHLY",
    ),
    "GRIDMET/DROUGHT": (
        "GRIDMET drought",
        "https://developers.google.com/earth-engine/datasets/catalog/GRIDMET_DROUGHT",
    ),
    "NASA/VIIRS/002/VNP64A1": (
        "VIIRS burned area",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_VIIRS_002_VNP64A1",
    ),
    "JRC/GSW1_4/MonthlyHistory": (
        "JRC monthly water",
        "https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_MonthlyHistory",
    ),
    "MERIT/Hydro/v1_0_1": (
        "MERIT Hydro",
        "https://developers.google.com/earth-engine/datasets/catalog/MERIT_Hydro_v1_0_1",
    ),
    "projects/soilgrids-isric/soc_mean": (
        "SoilGrids organic carbon",
        "https://gee-community-catalog.org/projects/isric/",
    ),
    "NASA/GLDAS/V021/NOAH/G025/T3H": (
        "GLDAS",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_GLDAS_V021_NOAH_G025_T3H",
    ),
    "CSP/ERGo/1_0/Global/SRTM_landforms": (
        "SRTM landforms",
        "https://developers.google.com/earth-engine/datasets/catalog/CSP_ERGo_1_0_Global_SRTM_landforms",
    ),
    "CSP/ERGo/1_0/Global/ALOS_topoDiversity": (
        "ALOS topographic diversity",
        "https://developers.google.com/earth-engine/datasets/catalog/CSP_ERGo_1_0_Global_ALOS_topoDiversity",
    ),
    "MODIS/061/MOD16A2GF": (
        "MODIS evapotranspiration",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD16A2GF",
    ),
    "NASA/SMAP/SPL4SMGP/008": (
        "SMAP",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_SMAP_SPL4SMGP_008",
    ),
}


class HabitatDatasetSource(BaseModel):
    """Describe a linked dataset used by the configured Habitat input bands.

    Attributes:
        label: Human-readable dataset name shown in model setup.
        url: Catalog page describing the configured Earth Engine source.
        roles: Predictor and/or response roles derived from the configured bands.
    """

    label: str
    url: str
    roles: list[Literal["predictor", "response"]]


class HabitatEarthEngineOptions(BaseModel):
    """Scientific source choices available to Habitat model setup.

    Attributes:
        defaultYear: Assessment year selected by the packaged configuration.
        minimumYear: First year supported by the complete input stack.
        maximumYear: Last year supported by the complete input stack.
        grid: Fixed projection, pixel size and origin used to acquire the inputs.
        datasets: Linked sources used by predictor and response bands, excluding
            sources used only to generate upstream reference sites.
    """

    defaultYear: int
    minimumYear: int
    maximumYear: int
    grid: ProjectedRasterGrid
    datasets: list[HabitatDatasetSource]


def create_habitat_router() -> APIRouter:
    """Create the Habitat setup route using its packaged scientific configuration.

    Returns:
        Router exposing public source choices without credentials or GEE requests.
    """
    router = APIRouter(tags=["processing"])

    @router.get("/api/processing/models/habitat-condition/earth-engine-options")
    def get_earth_engine_options() -> HabitatEarthEngineOptions:
        """Return source years, the acquisition grid and linked input datasets.

        Returns:
            Options derived from the original model's scientific configuration.

        Raises:
            OSError: If the installed scientific configuration cannot be read.
            ValueError: If the installed scientific configuration is invalid.
            KeyError: If a configured dataset has no Habitat catalog description.
        """
        configuration = load_habitat_stack()
        grid = configuration.grid
        dataset_roles: dict[str, set[str]] = {}
        for band in configuration.bands:
            if band.role in ("predictor", "response"):
                for key in band.source_dataset_keys:
                    dataset_id = configuration.datasets[key]
                    dataset_roles.setdefault(dataset_id, set()).add(band.role)
        datasets: list[HabitatDatasetSource] = []
        for dataset_id, roles in dataset_roles.items():
            label, url = HABITAT_DATASET_LINKS[dataset_id]
            datasets.append(
                HabitatDatasetSource(
                    label=label,
                    url=url,
                    roles=[role for role in ("predictor", "response") if role in roles],
                )
            )
        return HabitatEarthEngineOptions(
            defaultYear=configuration.year,
            minimumYear=configuration.minimum_year,
            maximumYear=configuration.maximum_year,
            grid=ProjectedRasterGrid(
                crs=grid.crs,
                pixelSize=(grid.pixel_size_meters, grid.pixel_size_meters),
                origin=(grid.origin_x, grid.origin_y),
                unit="metre",
                approximate=False,
            ),
            datasets=datasets,
        )

    return router
