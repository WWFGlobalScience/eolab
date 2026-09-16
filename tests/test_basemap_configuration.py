"""Verify the public basemap configuration and optional CARTO provider."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from eolab_app.main import create_app
from eolab_app.settings import load_settings


@pytest.mark.parametrize("key", [None, "", "   "])
def test_unconfigured_carto_is_absent(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    key: str | None,
) -> None:
    """Omit CARTO while preserving the existing default tile configuration.

    Args:
        configured_environment: Baseline application environment.
        version_file_path: Test version file.
        monkeypatch: Environment overrides.
        key: Missing or blank optional provider key.
    """
    if key is None:
        monkeypatch.delenv("CARTO_BASEMAP_API_KEY", raising=False)
    else:
        monkeypatch.setenv("CARTO_BASEMAP_API_KEY", key)
    response = TestClient(create_app(version_file_path)).get("/api/config")
    assert response.status_code == 200
    assert response.json()["basemap"] == {
        "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "attribution": "&copy; OpenStreetMap contributors",
    }


def test_carto_key_builds_attributed_browser_tile_url(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Encode the key as one query value and publish only provider configuration.

    Args:
        configured_environment: Baseline application environment.
        version_file_path: Test version file.
        monkeypatch: Environment overrides.
    """
    monkeypatch.setenv("CARTO_BASEMAP_API_KEY", "  test-key&other=unsafe/#  ")
    response = TestClient(create_app(version_file_path)).get("/api/config")
    assert response.status_code == 200
    basemap = response.json()["basemap"]
    carto = basemap["carto"]
    assert carto["url"] == (
        "https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png"
        "?key=test-key%26other%3Dunsafe%2F%23"
    )
    assert carto["maxNativeZoom"] == 20
    assert "openstreetmap.org/copyright" in carto["attribution"]
    assert "carto.com/attributions" in carto["attribution"]
    assert basemap["url"].startswith("https://{s}.tile.openstreetmap.org/")
    assert "test-key" not in repr(load_settings(version_file_path))
