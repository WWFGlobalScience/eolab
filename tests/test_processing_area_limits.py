"""New durable selections use small descriptors and remain fenced from old workers."""

import json
import asyncio
import hashlib
from uuid import uuid4
from pathlib import Path
from typing import Any
import psycopg
import pytest
from catalog_selection_support import write_geopackage_layer, register_selection
from test_processing_jobs import boundary, store, HEADERS, AREA
from test_raster_clips import SOURCE


@pytest.mark.parametrize("operation", ["raster-clips", "raster-calculations"])
def test_plan_persists_only_catalog_definition(
    boundary: Any, store: Any, tmp_path: Path, operation: str
) -> None:
    """The database stores no geometry or private paths and requires claim protocol 5."""
    client, *_ = boundary
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
        f"/api/processing/{operation}/plan", json=request, headers=HEADERS
    )
    assert response.status_code == 200, response.text
    from eolab_app.routes.processing import COOKIE
    import hashlib

    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    row = store.get_plan(response.json()["planId"], owner)
    serialized = json.dumps(row["spec"])
    assert "coordinates" not in serialized and str(tmp_path) not in serialized
    assert row["spec"]["area"]["catalogSelection"] == selection
    accepted = client.post(
        f"/api/processing/{operation}",
        json={"planId": response.json()["planId"], "requestId": "a" * 32},
        headers=HEADERS,
    )
    assert accepted.status_code == 202, accepted.text
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT minimum_claim_version FROM processing.jobs"
        ).fetchone()[0] == (5 if operation == "raster-clips" else 6)
    with pytest.raises(psycopg.errors.CheckViolation):
        with psycopg.connect(store.conninfo) as connection:
            connection.execute("SET LOCAL eolab.processing_claim_version = '4'")
            connection.execute("UPDATE processing.jobs SET status='running'")


@pytest.mark.parametrize(
    "operation,whole",
    [
        ("raster-clips", False),
        ("raster-calculations", False),
        ("raster-calculations", True),
    ],
)
def test_historical_box_and_whole_plans_remain_submittable(
    boundary: Any,
    store: Any,
    operation: str,
    whole: bool,
) -> None:
    """The old optional null field does not invalidate previously reviewed plans.

    Args:
        boundary: Real source, HTTP, worker, and artifact owners.
        store: Disposable migrated PostgreSQL adapter.
        operation: Public operation path.
        whole: Whether the historical intent selected the whole raster.
    """
    from eolab_app.routes.processing import COOKIE

    client, worker, *_ = boundary
    request = {"wholeRaster": True} if whole else {"selectedBounds": AREA}
    request.update(
        SOURCE
        if operation == "raster-clips"
        else {
            "sources": {"a": SOURCE},
            "calculations": [{"label": "Count", "expression": "count(a)"}],
        }
    )
    plan = client.post(
        f"/api/processing/{operation}/plan", json=request, headers=HEADERS
    )
    assert plan.status_code == 200, plan.text
    identifier = plan.json()["planId"]
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.plans SET request=(request-'catalogSelection') || "
            "'{\"temporaryAoiId\":null}'::jsonb WHERE id=%s",
            (identifier,),
        )
    response = client.post(
        f"/api/processing/{operation}",
        json={"planId": identifier, "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert response.status_code == 202, response.text
    assert asyncio.run(worker.run_once())
    ready = client.get(f"/api/processing/jobs/{response.json()['jobId']}").json()
    assert ready["status"] == "ready", ready


def test_historical_polygon_job_replays_without_live_area_service(
    boundary: Any,
    store: Any,
) -> None:
    """Accepted geometry jobs/results survive; only new legacy-plan admission fails.

    Args:
        boundary: Real HTTP/source/worker/artifact composition.
        store: Disposable database carrying an actual historical specification.
    """
    from shapely.geometry import box, mapping
    from eolab_app.processing.clip_models import ClipArea
    from eolab_app.processing.service import prepare_clip_job
    from eolab_app.routes.processing import COOKIE
    from test_raster_clips import make_spec

    client, worker, source, *_ = boundary
    client.get("/api/processing/jobs")
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    area = ClipArea(
        kind="aoi",
        bounds=(0.1, 9.1, 0.9, 9.9),
        geometries=(mapping(box(0.1, 9.1, 0.9, 9.9)),),
    )
    prepared = prepare_clip_job(make_spec(source, area))
    identifier = store.reserve_plan(owner, {**SOURCE, "temporaryAoiId": "a" * 32})
    store.finish_plan(identifier, owner, prepared)
    key = uuid4().hex
    job = store.submit(owner, identifier, key, prepared)
    # The existing request identity recovers accepted work before legacy checks.
    recovered = client.post(
        "/api/processing/raster-clips",
        json={"planId": identifier, "requestId": key},
        headers=HEADERS,
    )
    assert recovered.status_code == 202 and recovered.json()["jobId"] == job["id"]
    rejected = client.post(
        "/api/processing/raster-clips",
        json={"planId": identifier, "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["code"] == "legacy_selection_plan"
    worker.areas = None
    assert asyncio.run(worker.run_once())
    ready = client.get(f"/api/processing/jobs/{job['id']}").json()
    assert ready["status"] == "ready", ready
    assert client.get(ready["result"]["url"]).status_code == 200
    provenance = client.get(ready["result"]["provenanceUrl"]).json()
    assert provenance["area"]["kind"] == "aoi"
