"""Ellipsoidal-area jobs through real HTTP, PostgreSQL and supervised execution."""

import asyncio
import csv
from io import StringIO
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
import pytest
from shapely.geometry import box

from test_ground_area import reference_area
from test_processing_jobs import boundary, store, HEADERS
from test_processing_calculations import ENDPOINT, plan_calculation, submit_calculation
from test_raster_clips import SOURCE


def test_area_review_result_provenance_and_older_worker_fence(
    boundary: Any, store: Any
) -> None:
    """A fractional area job is owned, immutable, and requires an area-capable worker.

    Args:
        boundary: Real Processing API, authorized source, worker and artifacts.
        store: Disposable real PostgreSQL adapter.
    """
    client, worker, source, artifacts, app = boundary
    selected = {"west": 0.001, "south": 9.995, "east": 0.004, "north": 9.999}
    body = {
        "sources": {"a": SOURCE},
        "selectedBounds": selected,
        "calculations": [
            {"label": "Ground area", "expression": "areaha(a == a)"},
            {"label": "Centered pixels", "expression": "count(a)"},
        ],
    }
    review = client.post(ENDPOINT + "/plan", json=body, headers=HEADERS)
    assert review.status_code == 200, review.text
    plan = review.json()
    assert plan["inclusion"] == "per_function"
    method = plan["grid"]["groundArea"]
    assert method["ellipsoid"] == "WGS84" and method["units"] == "ha"
    assert method["inclusion"] == "fractional_cell_intersection"
    assert method["edgeToleranceMetres"] == 0.1
    assert plan["limits"]["maxAreaGeometryCells"] == 2_000_000
    request_key = uuid4().hex
    job = submit_calculation(client, plan, request_key)
    assert submit_calculation(client, plan, request_key)["jobId"] == job["jobId"]
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT minimum_claim_version FROM processing.jobs WHERE id=%s",
            (job["jobId"],),
        ).fetchone() == (6,)
        assert (
            connection.execute(
                "SELECT id FROM processing.jobs WHERE status='queued' AND minimum_claim_version<=2"
            ).fetchall()
            == []
        )
    # Even an older worker with a broad UPDATE cannot acquire an area job.
    with pytest.raises(psycopg.errors.CheckViolation):
        with psycopg.connect(store.conninfo) as connection:
            connection.execute("SET LOCAL eolab.processing_claim_version = '2'")
            connection.execute(
                "UPDATE processing.jobs SET status='running' WHERE id=%s",
                (job["jobId"],),
            )
    assert asyncio.run(worker.run_once())
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    area, count = ready["result"]["rows"]
    assert float(area["value"]) == pytest.approx(
        reference_area(box(0.001, 9.995, 0.004, 9.999)), rel=1e-8
    )
    assert area["unit"] == "ha"
    assert count["state"] == "no_valid_data" and count["value"] is None
    assert ready["grid"]["groundArea"] == method
    provenance = client.get(ready["result"]["provenanceUrl"])
    assert provenance.json()["grid"]["groundArea"] == method
    assert (
        provenance.json()["functionInclusion"]["areaha"]
        == "fractional_cell_intersection"
    )
    assert str(source) not in provenance.text
    csv_rows = list(csv.DictReader(StringIO(client.get(ready["result"]["url"]).text)))
    assert csv_rows[0]["unit"] == "ha" and csv_rows[0]["value"] == area["value"]
    with TestClient(app, base_url="https://testserver") as stranger:
        assert stranger.get(ready["result"]["url"]).status_code == 404
    # New numeric plans also carry immutable execution metadata and reserve mask storage and require v6.
    numeric = plan_calculation(client)
    assert "groundArea" not in numeric["grid"]
    numeric_job = submit_calculation(client, numeric)
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT minimum_claim_version FROM processing.jobs WHERE id=%s",
            (numeric_job["jobId"],),
        ).fetchone() == (6,)
    assert asyncio.run(worker.run_once())
