"""Durable catalog selections use small descriptors without stored geometry."""

import json
import asyncio
import hashlib
from uuid import uuid4
from pathlib import Path
from typing import Any
import psycopg
import pytest
from catalog_selection_support import write_geopackage_layer, register_selection
from test_processing_jobs import boundary, store, HEADERS
from test_raster_clips import SOURCE


@pytest.mark.parametrize("operation", ["raster-clips", "raster-calculations"])
def test_prepared_job_persists_only_catalog_definition(
    boundary: Any, store: Any, tmp_path: Path, operation: str
) -> None:
    """Store only the catalog selection descriptor, without geometry or private paths.

    Args:
        boundary: Real HTTP routes and source authorizers.
        store: Disposable PostgreSQL adapter.
        tmp_path: Directory for the source vector fixture.
        operation: Clip or calculation endpoint to exercise.
    """
    client, worker, *_ = boundary
    vector = tmp_path / "area.gpkg"
    geometry = {
        "type": "Polygon",
        "coordinates": [[[0.1, 9.1], [0.9, 9.1], [0.9, 9.9], [0.1, 9.9], [0.1, 9.1]]],
    }
    write_geopackage_layer(vector, "area", crs="EPSG:4326", geometry=geometry)
    selection = register_selection(client, vector)
    request = {"catalogSelection": selection}
    request.update(
        SOURCE
        if operation == "raster-clips"
        else {
            "sources": {"a": SOURCE},
            "calculations": [{"label": "Count", "expression": "count(a)"}],
        }
    )
    response = client.post(
        f"/api/processing/{operation}",
        json={**request, "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert response.status_code == 202, response.text
    from eolab_app.routes.processing import COOKIE
    import hashlib

    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    assert asyncio.run(worker.run_once())
    with psycopg.connect(store.conninfo) as connection:
        row = {
            "spec": connection.execute(
                "SELECT spec FROM processing.jobs WHERE id=%s",
                (response.json()["jobId"],),
            ).fetchone()[0]
        }
    serialized = json.dumps(row["spec"])
    assert "coordinates" not in serialized and str(tmp_path) not in serialized
    assert row["spec"]["area"]["catalogSelection"] == selection
