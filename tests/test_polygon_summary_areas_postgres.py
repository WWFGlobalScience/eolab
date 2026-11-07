"""Polygon summary inputs through real HTTP routes, workers and PostgreSQL."""

import asyncio
from contextlib import closing
from pathlib import Path
from uuid import uuid4
from typing import Any

import httpx2
import numpy
import pytest
from fastapi.testclient import TestClient

from eolab_app.main import create_app
from eolab_app.processing.job_events import PostgresJobEvents
from eolab_app.processing.job_store import PostgresJobStore
from app_support import mounted_geotiff_item
from raster_fixture_support import write_source
from raster_source_support import SOURCE
from test_processing_jobs import boundary, store, HEADERS
from test_processing_calculations import calculation_inputs, submit_calculation
from test_polygon_summary_areas import rectangle


def test_drawn_polygon_histograms_authorize_before_serving_cached_results(
    store: PostgresJobStore,
    configured_environment: None,
    version_file_path: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sample saved drawings through real application and PostgreSQL boundaries.

    Args:
        store: Migrated disposable PostgreSQL store for temporary inputs.
        configured_environment: Isolated application settings.
        version_file_path: Application version fixture.
        tmp_path: Original raster mount and writable processing directory.
        monkeypatch: Inject the disposable store and fixture deployment paths.
    """
    values = numpy.full((100, 100), 7, dtype=numpy.int16)
    values[:, 50:] = 23
    sources = tmp_path / "sources"
    sources.mkdir()
    path = write_source(sources / "histogram.tif", values)
    item = mounted_geotiff_item(path.as_uri())
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(sources))
    monkeypatch.setenv("PROCESSING_DATA_PATH", str(tmp_path / "processing"))
    monkeypatch.setattr("eolab_app.main.PostgresJobStore", lambda _: store)
    monkeypatch.setattr(
        "eolab_app.main.PostgresJobEvents", lambda: PostgresJobEvents(store.conninfo)
    )

    def catalog(request: httpx2.Request) -> httpx2.Response:
        """Serve the fixture's raster without admitting a vector source.

        Args:
            request: Source authorization request.

        Returns:
            The Catalog item's original raster identity and asset.
        """
        assert (
            request.url.path
            == f"/collections/{SOURCE['collectionId']}/items/{SOURCE['itemId']}"
        )
        return httpx2.Response(200, json=item)

    def reject_geoserver(request: httpx2.Request) -> httpx2.Response:
        """Fail if polygon statistics contact the renderer.

        Args:
            request: Unexpected GeoServer request.

        Raises:
            AssertionError: Always because the fixture has no published layer.
        """
        raise AssertionError(f"Histogram contacted GeoServer: {request.url}")

    app = create_app(
        version_file_path,
        catalog_transport=httpx2.MockTransport(catalog),
        geoserver_transport=httpx2.MockTransport(reject_geoserver),
    )
    with (
        TestClient(app, base_url="https://testserver") as owner,
        closing(TestClient(app, base_url="https://testserver")) as other,
    ):
        upload = owner.post(
            "/api/processing/polygon-areas",
            headers=HEADERS,
            json={"polygons": [rectangle(0.1, 9.1, 0.3, 9.5)]},
        )
        assert upload.status_code == 200, upload.text
        reference = upload.json()["polygonArea"]
        ordinary = {**SOURCE, "polygonArea": reference}
        cases = [
            ("statistics", ordinary, "sampleMaximum"),
            ("statistics", {**ordinary, "categoryValues": [7, 23]}, "sampleMaximum"),
            (
                "paired-statistics",
                {"xRaster": SOURCE, "yRaster": SOURCE, "polygonArea": reference},
                "xMaximum",
            ),
        ]
        for endpoint, body, value_field in cases:
            url = f"/api/raster-analysis/{endpoint}"
            response = owner.post(url, headers=HEADERS, json=body)
            assert response.status_code == 200, response.text
            result = response.json()
            assert result["scope"] == "polygonArea"
            assert result["polygonArea"] == reference
            assert result[value_field] == 7
            assert response.headers["Cache-Control"] == "private, no-store"
            assert owner.post(url, headers=HEADERS, json=body).json() == result
            assert owner.post(url, json=body).status_code == 403
            assert (
                owner.post(
                    url,
                    headers=HEADERS,
                    json={
                        **body,
                        "selectedBounds": {
                            "west": 0.1,
                            "south": 9.1,
                            "east": 0.3,
                            "north": 9.5,
                        },
                    },
                ).status_code
                == 422
            )
            other_response = other.post(url, headers=HEADERS, json=body)
            assert other_response.status_code == 409
            assert other_response.headers["Cache-Control"] == "private, no-store"

        with store._transaction() as cursor:
            cursor.execute(
                "UPDATE processing.inputs SET expires_at=now()-interval '1 second' WHERE id=%s",
                (reference["id"],),
            )
        for endpoint, body, _ in cases:
            expired = owner.post(
                f"/api/raster-analysis/{endpoint}", headers=HEADERS, json=body
            )
            assert expired.status_code == 409, expired.text
            assert "Choose the polygon layer again" in expired.json()["detail"]


def test_polygon_upload_ownership_release_and_cached_reuse(
    boundary: Any, store: Any
) -> None:
    """Different sessions can reuse numbers only after supplying their own area.

    Args:
        boundary: Real HTTP routes, raster authorizer, worker and output store.
        store: Disposable PostgreSQL job store.
    """
    client, worker, _, _, app = boundary
    endpoint = "/api/processing/polygon-areas"
    body = {"polygons": [rectangle(0.1, 9.1, 0.5, 9.5)]}
    denied = client.post(endpoint, json=body)
    assert denied.status_code == 403
    uploaded = client.post(endpoint, json=body, headers=HEADERS)
    assert uploaded.status_code == 200, uploaded.text
    reference = uploaded.json()["polygonArea"]
    plan = calculation_inputs(client, polygonArea=reference)
    first = submit_calculation(client, plan)
    with TestClient(app, base_url="https://testserver") as other:
        from test_processing_calculations import ENDPOINT, request_body

        response = other.post(
            ENDPOINT,
            json={**request_body(polygonArea=reference), "requestId": uuid4().hex},
            headers=HEADERS,
        )
        assert response.status_code == 409
        assert (
            other.delete(endpoint + "/" + reference["id"], headers=HEADERS).status_code
            == 200
        )
    assert (
        client.delete(endpoint + "/" + reference["id"], headers=HEADERS).status_code
        == 200
    )
    assert asyncio.run(worker.run_once())
    finished = client.get(f"/api/processing/jobs/{first['jobId']}").json()
    assert finished["status"] == "ready", finished
    with store._transaction() as cursor:
        cursor.execute("SELECT payload FROM processing.calculation_results")
        entries = cursor.fetchall()
        assert entries and all(
            "geometries" not in row["payload"]["area"] for row in entries
        )
    with TestClient(app, base_url="https://testserver") as other:
        own = other.post(endpoint, json=body, headers=HEADERS).json()["polygonArea"]
        assert own["id"] != reference["id"] and own["sha256"] == reference["sha256"]
        plan = calculation_inputs(other, polygonArea=own)
        second = submit_calculation(other, plan)
        assert asyncio.run(worker.run_once())
        result = other.get(f"/api/processing/jobs/{second['jobId']}").json()
        assert result["status"] == "ready", result
        assert result["result"]["rows"] == finished["result"]["rows"]
        assert other.get(finished["result"]["url"]).status_code == 404


def test_polygon_input_expiration_capacity_and_changed_geometry(
    boundary: Any, store: Any
) -> None:
    """Bound retained uploads and reject expired or mismatched geometry references.

    Args:
        boundary: Real same-origin HTTP routes and worker.
        store: Disposable PostgreSQL input store.
    """
    from test_processing_calculations import ENDPOINT, request_body

    client, _, _, _, _ = boundary
    endpoint = "/api/processing/polygon-areas"
    first = client.post(
        endpoint, headers=HEADERS, json={"polygons": [rectangle(0.1, 9.1, 0.5, 9.5)]}
    ).json()["polygonArea"]
    changed = client.post(
        endpoint, headers=HEADERS, json={"polygons": [rectangle(0.2, 9.1, 0.5, 9.5)]}
    ).json()["polygonArea"]
    assert first["sha256"] != changed["sha256"]
    invalid = {**first, "sha256": changed["sha256"]}
    assert (
        client.post(
            ENDPOINT,
            headers=HEADERS,
            json={**request_body(polygonArea=invalid), "requestId": uuid4().hex},
        ).status_code
        == 409
    )
    with store._transaction() as cursor:
        cursor.execute(
            "UPDATE processing.inputs SET expires_at=now()-interval '1 second' WHERE id=%s",
            (first["id"],),
        )
    assert (
        client.post(
            ENDPOINT,
            headers=HEADERS,
            json={**request_body(polygonArea=first), "requestId": uuid4().hex},
        ).status_code
        == 409
    )
    for _ in range(31):
        assert (
            client.post(
                endpoint,
                headers=HEADERS,
                json={"polygons": [rectangle(0.1, 9.1, 0.5, 9.5)]},
            ).status_code
            == 200
        )
    assert (
        client.post(
            endpoint,
            headers=HEADERS,
            json={"polygons": [rectangle(0.1, 9.1, 0.5, 9.5)]},
        ).status_code
        == 429
    )
    client.delete(endpoint + "/" + changed["id"], headers=HEADERS)
    assert (
        client.post(
            endpoint,
            headers=HEADERS,
            json={"polygons": [rectangle(0.1, 9.1, 0.5, 9.5)]},
        ).status_code
        == 200
    )


def test_polygon_upload_has_its_own_body_limit(boundary: Any, store: Any) -> None:
    """Allow polygon uploads beyond command size while retaining both request ceilings.

    Args:
        boundary: HTTP routes with body-size limits enabled.
        store: Disposable PostgreSQL input store.
    """
    import json
    from test_processing_calculations import ENDPOINT

    client, _, _, _, _ = boundary
    polygon = rectangle(0.1, 9.1, 0.5, 9.5)
    body = json.dumps({"polygons": [polygon] * 500})
    assert len(body) > 16384
    headers = {**HEADERS, "Content-Type": "application/json"}
    assert (
        client.post(
            "/api/processing/polygon-areas", headers=headers, content=body
        ).status_code
        == 200
    )
    assert client.post(ENDPOINT, headers=headers, content=body).status_code == 413
    assert (
        client.post(
            "/api/processing/polygon-areas",
            headers=headers,
            content=" " * (8 * 1024 * 1024 + 1),
        ).status_code
        == 413
    )
