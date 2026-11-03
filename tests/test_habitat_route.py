"""Read Habitat source choices without requiring an Earth Engine connection."""

from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock

import ee
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.main import create_app
from eolab_app.processing.habitat_earth_engine import load_habitat_stack
from eolab_app.routes import habitat


def test_habitat_options_use_the_packaged_configuration_without_credentials(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Expose linked input sources and their roles without credentials or GEE calls.

    Args:
        configured_environment: Application settings without a live deployment.
        version_file_path: File containing the application's test version.
        monkeypatch: Prevent credential loading and Earth Engine initialization.
    """
    monkeypatch.delenv("HABITAT_EARTH_ENGINE_PROJECT", raising=False)
    monkeypatch.delenv("HABITAT_EARTH_ENGINE_CREDENTIALS_FILE", raising=False)
    monkeypatch.setattr(
        ee, "Initialize", Mock(side_effect=AssertionError("No GEE initialization"))
    )
    monkeypatch.setattr(
        ee,
        "ServiceAccountCredentials",
        Mock(side_effect=AssertionError("No credential loading")),
    )

    with TestClient(create_app(version_file_path)) as client:
        response = client.get(
            "/api/processing/models/habitat-condition/earth-engine-options"
        )

    assert response.status_code == 200
    options = response.json()
    datasets = options.pop("datasets")
    assert options == {
        "defaultYear": 2018,
        "minimumYear": 2015,
        "maximumYear": 2019,
        "grid": {
            "crs": "EPSG:6933",
            "pixelSize": [500.0, 500.0],
            "origin": [0.0, 0.0],
            "unit": "metre",
            "approximate": False,
        },
    }
    assert len(datasets) == 18
    sources_by_label = {source["label"]: source for source in datasets}
    assert len(sources_by_label) == 18
    assert {
        role: sum(role in source["roles"] for source in datasets)
        for role in ("predictor", "response")
    } == {"predictor": 13, "response": 6}
    assert sources_by_label["MODIS land-cover dynamics / phenology"] == {
        "label": "MODIS land-cover dynamics / phenology",
        "url": "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MCD12Q2",
        "roles": ["predictor", "response"],
    }
    assert sources_by_label["Landsat NDVI composites"]["roles"] == ["response"]
    assert sources_by_label["ERA5 daily aggregates"]["roles"] == ["predictor"]
    assert sources_by_label["SoilGrids organic carbon"]["url"] == (
        "https://gee-community-catalog.org/projects/isric/"
    )
    assert all(
        reference_source not in source["url"]
        for source in datasets
        for reference_source in ("nat-semi-grassland_p", "HMv20240801", "HII")
    )


def test_habitat_options_follow_configured_band_sources_and_roles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Describe only datasets used by the current predictor and response bands.

    Args:
        monkeypatch: Supply a subset of real packaged bands to the options route.
    """
    configuration = load_habitat_stack()
    configuration = replace(
        configuration,
        bands=tuple(
            band
            for band in configuration.bands
            if band.identifier in ("d01", "d04", "d25")
        ),
    )
    monkeypatch.setattr(habitat, "load_habitat_stack", lambda: configuration)
    app = FastAPI()
    app.include_router(habitat.create_habitat_router())
    with TestClient(app) as client:
        response = client.get(
            "/api/processing/models/habitat-condition/earth-engine-options"
        )

    assert response.status_code == 200
    assert {
        source["label"]: source["roles"] for source in response.json()["datasets"]
    } == {
        "MODIS land-cover dynamics / phenology": ["predictor", "response"],
        "ERA5 daily aggregates": ["predictor"],
    }
