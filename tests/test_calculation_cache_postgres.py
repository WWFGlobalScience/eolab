"""Shared-cache lifecycle tests across actual HTTP sessions and PostgreSQL."""

import asyncio
from dataclasses import replace
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.processing.models import ProcessingError
from eolab_app.processing.calculation_cache import calculation_result_cache_keys
from eolab_app.processing.aggregate_models import AggregateSpec
from test_processing_jobs import boundary, store, HEADERS
from test_processing_calculations import (
    ENDPOINT,
    plan_calculation,
    submit_calculation,
    request_body,
)
import eolab_app.processing.worker as worker_module
import eolab_app.processing.service as service_module


def test_other_session_reuses_values_but_not_downloads(
    boundary: Any, store: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A second owner skips execution but receives its own CSV and job.

    Args:
        boundary: Real HTTP, source authorization, worker and artifacts.
        store: Disposable PostgreSQL database.
        monkeypatch: Forbid a second native calculation.
    """
    client, worker, _, _, app = boundary
    first = submit_calculation(client, plan_calculation(client, wholeRaster=True))
    assert asyncio.run(worker.run_once())
    first_url = f"/api/processing/jobs/{first['jobId']}"
    original = client.get(first_url).json()
    assert original["status"] == "ready", original
    assert original["result"]["cacheHit"] is False

    async def unexpected_calculation(*args: Any, **kwargs: Any) -> None:
        """Fail if a cache hit starts native raster work.

        Args:
            args: Native execution arguments.
            kwargs: Native execution options.

        Raises:
            AssertionError: Always; this request must be served from cache.
        """
        raise AssertionError("Cache hit must not run the native calculation")

    monkeypatch.setattr(worker_module, "run_process", unexpected_calculation)
    monkeypatch.setattr(service_module, "run_process", unexpected_calculation)
    with TestClient(app, base_url="https://testserver") as other:
        body = request_body(wholeRaster=True)
        body["calculations"][0]["label"] = "My own title"
        body["calculations"][0]["expression"] = " count (a > 5000) "
        planned = other.post(ENDPOINT + "/plan", json=body, headers=HEADERS)
        assert planned.status_code == 200, planned.text
        assert planned.json()["cacheHit"] is True
        second = submit_calculation(other, planned.json())
        assert asyncio.run(worker.run_once())
        reused = other.get(f"/api/processing/jobs/{second['jobId']}").json()
        assert reused["status"] == "ready", reused
        assert reused["result"]["cacheHit"] is True
        assert reused["result"]["performance"] is None
        assert reused["result"]["executionTiming"] is None
        assert (
            reused["result"]["rows"][0]["value"]
            == original["result"]["rows"][0]["value"]
        )
        csv = other.get(reused["result"]["url"])
        assert csv.status_code == 200 and "My own title" in csv.text
        assert reused["result"]["url"] != original["result"]["url"]
        assert other.get(original["result"]["url"]).status_code == 404
        assert client.get(reused["result"]["url"]).status_code == 404

        # Existing cache entries never waive authorization at execution time.
        denied = submit_calculation(other, plan_calculation(other, wholeRaster=True))

        async def deny_source(source: Any) -> None:
            """Reject the source after planning.

            Args:
                source: Requested catalog raster.

            Raises:
                ProcessingError: The source is no longer accessible.
            """
            raise ProcessingError("source_unavailable", "Source unavailable", 409)

        monkeypatch.setattr(worker.authorizer, "authorize", deny_source)
        assert asyncio.run(worker.run_once())
        assert (
            other.get(f"/api/processing/jobs/{denied['jobId']}").json()["status"]
            == "failed"
        )


def test_cache_expiry_capacity_and_cancelled_attempt(boundary: Any, store: Any) -> None:
    """Expiry, eviction and cancellation bound which numerical values are reusable.

    Args:
        boundary: Real HTTP and worker composition.
        store: Disposable PostgreSQL database.
    """
    client, worker, _, _, _ = boundary
    store.limits = replace(store.limits, calculation_cache_capacity=1)
    job = submit_calculation(client, plan_calculation(client, wholeRaster=True))
    assert asyncio.run(worker.run_once())
    with psycopg.connect(store.conninfo) as connection:
        keys = [
            row[0]
            for row in connection.execute(
                "SELECT cache_key FROM processing.calculation_results"
            )
        ]
        assert len(keys) == 1
        connection.execute(
            "UPDATE processing.calculation_results SET expires_at=now()-interval '1 second'"
        )
    assert store.get_cached_calculation_results(keys) == {}
    # A queued cancellation never executes and cannot repopulate expired entries.
    cancelled = submit_calculation(client, plan_calculation(client, wholeRaster=True))
    client.post(f"/api/processing/jobs/{cancelled['jobId']}/cancel", headers=HEADERS)
    assert not asyncio.run(worker.run_once())
    assert store.get_cached_calculation_results(keys) == {}

    # Even already calculated values cannot be cached if cancellation won publication.
    submitted = submit_calculation(client, plan_calculation(client, wholeRaster=True))
    claimed = store.claim()
    assert claimed["id"] == submitted["jobId"]
    artifact = asyncio.run(worker._execute(claimed))
    store.cancel(claimed["id"], claimed["owner"])
    values = {keys[0]: {"value": "123"}}
    assert not store.finish(
        claimed["id"], claimed["attempt_id"], artifact, reusable_results=values
    )
    assert store.get_cached_calculation_results(keys) == {}


def test_oversized_cache_entry_is_skipped(boundary: Any, store: Any) -> None:
    """Cache size limits do not discard a successfully calculated owned result.

    Args:
        boundary: Real HTTP and worker composition.
        store: Disposable PostgreSQL database.
    """
    client, worker, _, _, _ = boundary
    submitted = submit_calculation(client, plan_calculation(client, wholeRaster=True))
    claimed = store.claim()
    artifact = asyncio.run(worker._execute(claimed))
    key = "f" * 64
    assert store.finish(
        claimed["id"],
        claimed["attempt_id"],
        artifact,
        reusable_results={key: {"value": "x" * 32769}},
    )
    assert store.get_cached_calculation_results([key]) == {}
    assert (
        client.get(f"/api/processing/jobs/{submitted['jobId']}").json()["status"]
        == "ready"
    )


@pytest.mark.parametrize("area_kind", ["bounds", "catalogSelection"])
def test_cached_area_skips_geometry_work_even_after_entry_expires(
    boundary: Any,
    store: Any,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    area_kind: str,
) -> None:
    """Pin cached values before submission and never run planning or masking again.

    Args:
        boundary: Real API, catalog authorization and worker.
        store: Disposable PostgreSQL adapter.
        tmp_path: Vector fixture directory.
        monkeypatch: Forbid native planning and calculation after the first result.
        area_kind: Map box or catalog-vector area.
    """
    from test_processing_jobs import AREA, register_selection, write_geopackage_layer

    client, worker, _, _, _ = boundary
    if area_kind == "catalogSelection":
        vector = tmp_path / "area.gpkg"
        write_geopackage_layer(
            vector,
            "area",
            crs="EPSG:4326",
            geometry_type="Polygon",
            geometry={
                "type": "Polygon",
                "coordinates": [
                    [[0.1, 9.1], [0.9, 9.1], [0.9, 9.9], [0.1, 9.9], [0.1, 9.1]]
                ],
            },
        )
        area = {"catalogSelection": register_selection(client, vector)}
    else:
        area = {"selectedBounds": AREA}
    first = submit_calculation(client, plan_calculation(client, **area))
    assert asyncio.run(worker.run_once())
    original = client.get(f"/api/processing/jobs/{first['jobId']}").json()
    assert original["status"] == "ready", original

    async def forbid_native_work(*args: Any, **kwargs: Any) -> None:
        """Reject raster planning, polygon-envelope reads and execution on cache hits.

        Args:
            args: Native operation arguments.
            kwargs: Native operation options.

        Raises:
            AssertionError: Always, because the requested result is already cached.
        """
        raise AssertionError("Cached area must not run native work")

    monkeypatch.setattr(service_module, "run_process", forbid_native_work)
    monkeypatch.setattr(worker_module, "run_process", forbid_native_work)
    plan = plan_calculation(client, **area)
    assert plan["cacheHit"] is True
    assert plan["timing"]["nativeProcessSeconds"] == 0
    with psycopg.connect(store.conninfo) as connection:
        connection.execute("DELETE FROM processing.calculation_results")
    # The prepared result is retained even after every cache entry was evicted.
    submitted = submit_calculation(client, plan)
    with psycopg.connect(store.conninfo) as connection:
        row = connection.execute(
            "SELECT minimum_claim_version, reserved_bytes FROM processing.jobs WHERE id=%s",
            (submitted["jobId"],),
        ).fetchone()
        assert row == (7, worker.aggregate_limits.result_reservation_bytes)
        assert (
            connection.execute(
                "SELECT id FROM processing.jobs WHERE status='queued' AND minimum_claim_version<=6"
            ).fetchone()
            is None
        )
    assert asyncio.run(worker.run_once())
    ready = client.get(f"/api/processing/jobs/{submitted['jobId']}").json()
    assert ready["status"] == "ready", ready
    assert ready["result"]["cacheHit"] is True
    assert ready["result"]["rows"] == original["result"]["rows"]
