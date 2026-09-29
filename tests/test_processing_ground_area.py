"""Ellipsoidal-area jobs through real HTTP, PostgreSQL and supervised execution."""

import asyncio
import csv
from io import StringIO
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from shapely.geometry import box

from test_ground_area import reference_area
from test_processing_jobs import boundary, store
from test_processing_calculations import (
    calculation_inputs,
    submit_calculation,
)
from test_raster_clips import SOURCE


def test_area_review_result_and_provenance(boundary: Any, store: Any) -> None:
    """A fractional area job preserves ownership, its grid and result provenance.

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
    plan = body
    request_key = uuid4().hex
    job = submit_calculation(client, plan, request_key)
    assert submit_calculation(client, plan, request_key)["jobId"] == job["jobId"]
    assert asyncio.run(worker.run_once())
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    method = ready["grid"]["groundArea"]
    assert method["ellipsoid"] == "WGS84" and method["units"] == "ha"
    assert method["inclusion"] == "fractional_cell_intersection"
    assert method["edgeToleranceMetres"] == 0.1
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
    # Numeric plans also carry execution metadata and reserve mask storage.
    numeric = calculation_inputs(client)
    numeric_job = submit_calculation(client, numeric)
    assert asyncio.run(worker.run_once())
    assert (
        "groundArea"
        not in client.get(f"/api/processing/jobs/{numeric_job['jobId']}").json()["grid"]
    )
