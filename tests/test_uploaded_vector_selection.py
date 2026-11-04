"""Read private polygon selections through HTTP, Jobs, and original-raster analysis."""

import hashlib
import json
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any, TypeAlias
from uuid import uuid4

import fiona
import httpx2
import numpy
import pytest
from fastapi.testclient import TestClient
from rasterio.transform import from_origin

from eolab_app.catalog.geotiff import build_stac_item
from eolab_app.main import create_app
from eolab_app.routes.browser_identity import COOKIE
from tests.test_raster_categorical_statistics import write_categories
from tests.test_vector_uploads import HEADERS, write_layer

FILTER = {
    "enabled": True,
    "match": "all",
    "rules": [
        {"field": "label", "operator": "eq", "value": "Café wetlands"},
        {"field": "count", "operator": "eq", "value": 7},
        {"field": "weight", "operator": "eq", "value": 2.5},
    ],
}
SelectionFixture: TypeAlias = tuple[
    TestClient, TestClient, dict[str, Any], list[dict[str, str]], list[dict[str, Any]]
]


def run_native_job(root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """Run an installed selection or outline operation against the upload volume.

    Args:
        root: Test upload volume, substituted only in deployment configuration.
        payload: Actual Jobs operation and input document.

    Returns:
        The native runner's JSON success or failure envelope.
    """
    command = (
        "from pathlib import Path; "
        "from eolab_app.vector import selection_operation, outline_operation, extent_operation; "
        f"selection_operation.UPLOAD_MOUNT=Path({str(root)!r}); "
        f"outline_operation.UPLOAD_MOUNT=Path({str(root)!r}); "
        f"extent_operation.UPLOAD_MOUNT=Path({str(root)!r}); "
        "from job_service.runner import main; main()"
    )
    result = subprocess.run(
        [sys.executable, "-c", command],
        cwd=Path(__file__).parents[1] / "services/jobs",
        input=json.dumps(payload).encode(),
        capture_output=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr.decode()
    return json.loads(result.stdout)


@pytest.fixture
def uploaded_selection(
    configured_environment: None,
    version_file_path: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[SelectionFixture]:
    """Admit polygons and connect the app to real Jobs operations and raster files.

    Args:
        configured_environment: Isolated application and upload settings.
        version_file_path: Baked application version fixture.
        tmp_path: Original vector, raster, and private upload directories.
        monkeypatch: Select the fixture raster mount for catalog source resolution.

    Yields:
        Owner and unrelated browsers, upload metadata, raster identities, and Jobs
        submissions. GeoServer and vector catalog requests fail immediately.
    """
    path = tmp_path / "original.gpkg"
    write_layer(path, geometry="MultiPolygon")
    with fiona.open(path, "a", layer="areas") as dataset:
        dataset.write(
            {
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [
                        [[(6000, 0), (7000, 0), (7000, 1000), (6000, 1000), (6000, 0)]]
                    ],
                },
                "properties": {"label": "Forest", "count": 14, "weight": 5.5},
            }
        )

    values = numpy.full((40, 280), 7, dtype=numpy.float32)
    values[26:30, 10:14] = 997  # Entirely inside the hole; analysis must omit these.
    values[:, 119:162] = 11
    values[:, 239:] = 23
    items: dict[str, dict[str, Any]] = {}
    for index in range(2):
        raster = write_categories(
            tmp_path / f"values-{index}.tif",
            values * (index + 1),
            from_origin(0, 1000, 25, 25),
            "EPSG:3857",
        )
        item = build_stac_item(tmp_path, raster)
        items[f'/collections/{item["collection"]}/items/{item["id"]}'] = item
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    submissions: list[dict[str, Any]] = []
    results: dict[str, dict[str, Any]] = {}

    def catalog(request: httpx2.Request) -> httpx2.Response:
        """Serve only scanner-produced raster Items; uploads have no catalog Item.

        Args:
            request: App catalog request.

        Returns:
            Authoritative fixture raster metadata.
        """
        assert request.url.path in items, str(request.url)
        return httpx2.Response(200, json=items[request.url.path])

    def jobs(request: httpx2.Request) -> httpx2.Response:
        """Execute native work while preserving the real Jobs client's wire contract.

        Args:
            request: Authenticated submission, status, result, or cleanup request.

        Returns:
            Jobs response containing the actual native runner result.
        """
        assert request.headers["authorization"] == "Bearer test-outline-" + "a" * 40
        if request.method == "POST":
            payload = json.loads(request.content)
            submissions.append(payload)
            identifier = str(uuid4())
            results[identifier] = run_native_job(tmp_path / "vector-uploads", payload)
            assert results[identifier]["ok"], results[identifier]
            return httpx2.Response(
                202, json={"jobId": identifier, "status": "succeeded"}
            )
        identifier = request.url.path.split("/")[3]
        if request.method == "DELETE":
            return httpx2.Response(204)
        if request.url.path.endswith("/result"):
            return httpx2.Response(
                200, json={"jobId": identifier, "value": results[identifier]["value"]}
            )
        return httpx2.Response(200, json={"jobId": identifier, "status": "succeeded"})

    def reject_rendering(request: httpx2.Request) -> httpx2.Response:
        """Fail any dependency on map publication or GeoServer during analysis.

        Args:
            request: Unexpected rendering request.

        Raises:
            AssertionError: Always; the fixture has never published a map layer.
        """
        raise AssertionError(f"Analysis contacted GeoServer: {request.url}")

    app = create_app(
        version_file_path,
        catalog_transport=httpx2.MockTransport(catalog),
        geoserver_transport=httpx2.MockTransport(reject_rendering),
        jobs_transport=httpx2.MockTransport(jobs),
    )
    with TestClient(app, base_url="https://testserver") as owner:
        other = TestClient(app, base_url="https://testserver")
        assert other.get("/api/vector-uploads").json() == []
        response = owner.post(
            "/api/vector-uploads",
            params={"name": "Private wetlands"},
            headers=HEADERS,
            content=path.read_bytes(),
        )
        assert response.status_code == 201, response.text
        if os.name == "posix":
            source = next((tmp_path / "vector-uploads").glob("*/*/source.gpkg"))
            source.chmod(0o600)
            (source.parent / "metadata.json").chmod(0o600)
            source.parent.chmod(0o700)
            source.parent.parent.chmod(0o700)
        references = [
            {"collectionId": item["collection"], "itemId": item["id"]}
            for item in items.values()
        ]
        yield owner, other, response.json(), references, submissions
        other.close()


def test_uploaded_selection_uses_original_polygons_and_owned_jobs(
    uploaded_selection: SelectionFixture,
    tmp_path: Path,
) -> None:
    """Preserve exact geometry and filters across selection, outline, and Jobs access.

    Args:
        uploaded_selection: Real upload and application boundary fixture.
        tmp_path: Private upload volume passed to the native worker.
    """
    owner, other, upload, _, submissions = uploaded_selection
    request = {"uploadId": upload["id"], "filter": FILTER}
    response = owner.post("/api/vector-sampling/areas", headers=HEADERS, json=request)
    assert response.status_code == 200, response.text
    result = response.json()
    descriptor = result["selection"]
    assert descriptor == {**request, "layerName": "areas"}
    assert (result["matched"], result["total"]) == (1, 2)
    assert set(result) == {"matched", "total", "selection", "filter", "label"}
    assert result["label"] == "areas"
    assert response.headers["Cache-Control"] == "private, no-store"
    browser_hash = hashlib.sha256(owner.cookies[COOKIE].encode()).hexdigest()
    assert submissions[-1]["inputs"]["uploadOwner"] == browser_hash
    assert browser_hash not in response.text and str(tmp_path) not in response.text
    if os.name == "posix":
        directory = tmp_path / "vector-uploads" / browser_hash / upload["id"]
        assert directory.stat().st_mode & 0o001
        assert directory.parent.stat().st_mode & 0o001
        for filename in ("source.gpkg", "metadata.json"):
            assert (directory / filename).stat().st_mode & 0o004

    unfiltered = owner.post(
        "/api/vector-sampling/areas",
        headers=HEADERS,
        json={"uploadId": upload["id"], "filter": {}},
    )
    assert unfiltered.status_code == 200, unfiltered.text
    assert unfiltered.json()["matched"] == 2
    outline = owner.post(
        "/api/vector-sampling/outline", headers=HEADERS, json=descriptor
    )
    assert outline.status_code == 200, outline.text
    features = outline.json()["geometry"]["features"]
    assert len(features) == 2
    assert len(features[0]["geometry"]["coordinates"]) == 2

    submitted_count = len(submissions)
    for endpoint, body in (("areas", request), ("outline", descriptor)):
        denied = other.post(
            f"/api/vector-sampling/{endpoint}", headers=HEADERS, json=body
        )
        assert denied.status_code == 404, denied.text
        assert denied.headers["Cache-Control"] == "private, no-store"
        assert (
            owner.post(f"/api/vector-sampling/{endpoint}", json=body).status_code == 403
        )
    assert len(submissions) == submitted_count
    invalid = owner.post(
        "/api/vector-sampling/areas",
        headers=HEADERS,
        json={**request, "uploadOwner": browser_hash},
    )
    assert invalid.status_code == 422

    wrong_owner = hashlib.sha256(other.cookies[COOKIE].encode()).hexdigest()
    for submission in (submissions[0], submissions[-1]):
        rejected = run_native_job(
            tmp_path / "vector-uploads",
            {
                "operation": submission["operation"],
                "inputs": {**submission["inputs"], "uploadOwner": wrong_owner},
            },
        )
        if submission["operation"] == "vector.selection-measurement.v1":
            assert rejected["ok"]
            assert rejected["value"]["measurements"] is None
            assert rejected["value"]["error"]
        else:
            assert rejected == {"ok": False}
        assert str(tmp_path) not in json.dumps(rejected)


@pytest.mark.parametrize("kind", ["continuous", "categorical", "paired"])
def test_uploaded_area_statistics_authorize_before_warm_cache(
    uploaded_selection: SelectionFixture,
    kind: str,
) -> None:
    """Apply exact uploaded polygons and deny cached results after ownership loss.

    Args:
        uploaded_selection: Original private polygons and public raster fixtures.
        kind: Ordinary, categorical, or two-raster analysis through its HTTP route.
    """
    owner, other, upload, rasters, _ = uploaded_selection
    selected = owner.post(
        "/api/vector-sampling/areas",
        headers=HEADERS,
        json={"uploadId": upload["id"], "filter": FILTER},
    )
    assert selected.status_code == 200, selected.text
    descriptor = selected.json()["selection"]
    body = {"catalogSelection": descriptor}
    if kind == "paired":
        endpoint = "/api/raster-analysis/paired-statistics"
        body.update(xRaster=rasters[0], yRaster=rasters[1])
    else:
        endpoint = "/api/raster-analysis/statistics"
        body.update(rasters[0])
        if kind == "categorical":
            body["categoryValues"] = [7, 11, 23, 997]
    response = owner.post(endpoint, headers=HEADERS, json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["catalogSelection"] == descriptor
    assert result["xMaximum" if kind == "paired" else "sampleMaximum"] == 11
    if kind == "paired":
        assert result["yMaximum"] == 22
    elif kind == "categorical":
        areas = result["categoricalDistribution"]["areasHectares"]
        assert areas[0] > 0 and areas[1] > 0
        assert areas[2:] == [0, 0]
    assert owner.post(endpoint, headers=HEADERS, json=body).json() == result

    unfiltered = owner.post(
        endpoint,
        headers=HEADERS,
        json={**body, "catalogSelection": {**descriptor, "filter": {}}},
    )
    assert unfiltered.status_code == 200, unfiltered.text
    assert unfiltered.json()["xMaximum" if kind == "paired" else "sampleMaximum"] == 23
    assert owner.post(endpoint, json=body).status_code == 403
    denied = other.post(endpoint, headers=HEADERS, json=body)
    assert denied.status_code == 404, denied.text
    assert denied.headers["Cache-Control"] == "private, no-store"
    assert (
        owner.delete(f'/api/vector-uploads/{upload["id"]}', headers=HEADERS).status_code
        == 204
    )
    deleted = owner.post(endpoint, headers=HEADERS, json=body)
    assert deleted.status_code == 404, deleted.text
    assert deleted.headers["Cache-Control"] == "private, no-store"


def test_uploaded_extent_reauthorizes_owner_and_reads_original_filter(
    uploaded_selection: SelectionFixture,
) -> None:
    """Measure private original-source coordinates without map publication.

    Args:
        uploaded_selection: Actual admitted upload, unrelated browser and native Jobs.
    """
    owner, other, upload, _, submissions = uploaded_selection
    request = {"uploadId": upload["id"], "filter": FILTER}
    response = owner.post("/api/vector-sampling/extent", headers=HEADERS, json=request)
    assert response.status_code == 200, response.text
    assert response.json()["matched"] == 1
    assert response.json()["bbox"] is not None
    assert set(response.json()) == {"matched", "bbox"}
    assert response.headers["Cache-Control"] == "private, no-store"
    payload = submissions[-1]
    assert payload["operation"] == "vector.selection-extent.v1"
    assert payload["inputs"]["selection"] == {**request, "layerName": "areas"}
    assert (
        payload["inputs"]["uploadOwner"]
        == hashlib.sha256(owner.cookies[COOKIE].encode()).hexdigest()
    )
    admitted = len(submissions)
    assert (
        other.post(
            "/api/vector-sampling/extent", headers=HEADERS, json=request
        ).status_code
        == 404
    )
    assert len(submissions) == admitted
    assert owner.post("/api/vector-sampling/extent", json=request).status_code == 403
    assert (
        owner.post(
            "/api/vector-sampling/extent",
            headers=HEADERS,
            json={**request, "path": "/private"},
        ).status_code
        == 422
    )
    assert len(submissions) == admitted
