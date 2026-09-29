"""Polygon summary inputs through real HTTP routes, workers and PostgreSQL."""

import asyncio
from typing import Any
from fastapi.testclient import TestClient
from test_processing_jobs import boundary, store, HEADERS
from test_processing_calculations import plan_calculation, submit_calculation
from test_polygon_summary_areas import rectangle


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
    plan = plan_calculation(client, polygonArea=reference)
    first = submit_calculation(client, plan)
    with TestClient(app, base_url="https://testserver") as other:
        from test_processing_calculations import ENDPOINT, request_body

        response = other.post(
            ENDPOINT + "/plan",
            json=request_body(polygonArea=reference),
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
        plan = plan_calculation(other, polygonArea=own)
        assert plan["cacheHit"] is True
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
            ENDPOINT + "/plan", headers=HEADERS, json=request_body(polygonArea=invalid)
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
            ENDPOINT + "/plan", headers=HEADERS, json=request_body(polygonArea=first)
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
    assert (
        client.post(ENDPOINT + "/plan", headers=headers, content=body).status_code
        == 413
    )
    assert (
        client.post(
            "/api/processing/polygon-areas",
            headers=headers,
            content=" " * (8 * 1024 * 1024 + 1),
        ).status_code
        == 413
    )
