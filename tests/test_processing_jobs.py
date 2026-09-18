"""Real PostgreSQL, source authorization, AOI, worker, and HTTP boundaries."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx2
import numpy
import psycopg
import pytest
import rasterio

from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.job_notifications import PostgresJobWakeup
from eolab_app.processing.models import (
    Artifact,
    PreparedJobPlan,
    ProcessingError,
)
from eolab_app.processing.clip_models import ClipArea, RasterClipLimits
from eolab_app.processing.service import ProcessingService, prepare_clip_job
from eolab_app.processing.worker import ProcessingWorker
import eolab_app.processing.worker as worker_module
from eolab_app.processing.raster_clip import create_clip
from eolab_app.raster.catalog import StacRasterCatalog
from eolab_app.raster.source_authorization import CatalogRasterSourceAuthorizer
from eolab_app.raster.sources import MountedRasterResolver
from eolab_app.routes.processing import COOKIE, create_processing_router
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.vector.catalog import StacVectorCatalog
from eolab_app.vector.sources import MountedVectorResolver
from eolab_app.vector.sampling import VectorSamplingService
from app_support import mounted_geotiff_item
from test_raster_clips import SOURCE, make_spec, write_source
from catalog_selection_support import write_geopackage_layer, register_selection

HEADERS = {"X-EOLab-Processing": "1"}
AREA = {"west": 0.1, "south": 9.1, "east": 0.9, "north": 9.9}


@pytest.fixture
def store(request: pytest.FixtureRequest) -> PostgresJobStore:
    """Use only an explicitly named disposable PostgreSQL database.

    Args:
        request: Pytest command-line and fixture context, optionally parametrized
            with the Processing limits used to compose this test's providers.

    Returns:
        Migrated, empty real processing adapter.

    Raises:
        pytest.fail.Exception: If the explicit or connected database is unsafe.
    """
    dsn = request.config.getoption("--processing-dsn")
    if dsn is None:
        pytest.skip("Pass --processing-dsn for real PostgreSQL integration tests")
    if not psycopg.conninfo.conninfo_to_dict(dsn).get("dbname", "").startswith(
        "eolab_processing_test"
    ):
        pytest.fail(
            "Processing tests require an explicit disposable eolab_processing_test* database"
        )
    with psycopg.connect(dsn) as connection:
        if not connection.info.dbname.startswith("eolab_processing_test"):
            pytest.fail(
                "Processing tests require a disposable eolab_processing_test* database"
            )
    result = PostgresJobStore(getattr(request, "param", RasterClipLimits()), dsn)
    result.migrate()
    result.migrate()  # Exercise redeployment of an already initialized schema.
    with psycopg.connect(dsn) as connection:
        connection.execute(
            "TRUNCATE processing.transfers, processing.jobs, processing.plans, processing.calculation_results"
        )
    return result


@pytest.fixture
def boundary(tmp_path: Path, store: PostgresJobStore) -> Any:
    """Compose real raster/AOI/processing owners without viewer or GeoServer.

    Args:
        tmp_path: Isolated mounted source and writable result roots.
        store: Real disposable PostgreSQL adapter.

    Yields:
        Client, worker, source, artifact adapter, and catalog mock boundary.
    """
    path = write_source(
        tmp_path / "source.tif", numpy.arange(10_000, dtype="int16").reshape(100, 100)
    )
    item = mounted_geotiff_item(path.as_uri())
    vector_items = {}

    def catalog(request: httpx2.Request) -> httpx2.Response:
        """Serve only the authoritative catalog Item, with no rendering state.

        Args:
            request: Catalog get-item HTTP request.

        Returns:
            Scanner-signed mounted Item.
        """
        assert request.url.host == "catalog"
        if "/eolab-mounted-vectors/" in request.url.path:
            selected = vector_items.get(request.url.path.rsplit("/", 1)[-1])
            return (
                httpx2.Response(200, json=selected)
                if selected
                else httpx2.Response(404)
            )
        return httpx2.Response(200, json=item)

    catalog_client = httpx2.AsyncClient(transport=httpx2.MockTransport(catalog))
    authorizer = CatalogRasterSourceAuthorizer(
        StacRasterCatalog(catalog_client, "http://catalog"),
        MountedRasterResolver(tmp_path),
    )
    areas = VectorSamplingService(
        StacVectorCatalog(catalog_client, "http://catalog"),
        MountedVectorResolver(tmp_path),
    )
    artifacts = LocalJobArtifacts(tmp_path / "outputs", (path,))
    artifacts.initialize()
    service = ProcessingService(authorizer, areas, store, artifacts, store.limits)
    worker = ProcessingWorker(authorizer, store, artifacts, store.limits, areas=areas)
    app = FastAPI()
    app.state.vector_items = vector_items
    app.include_router(create_processing_router(service))
    app.include_router(create_vector_sampling_router(areas))
    with TestClient(app, base_url="https://testserver") as client:
        yield client, worker, path, artifacts, app
    asyncio.run(catalog_client.aclose())


def planned(client: TestClient, aoi: dict[str, Any] | None = None) -> dict[str, Any]:
    """Create a real bounded metadata plan through HTTP.

    Args:
        client: Owned HTTPS test client.
        aoi: Optional ready AOI ID, otherwise the explicit fixture rectangle.

    Returns:
        Reviewed native clip plan.
    """
    selection = {"catalogSelection": aoi} if aoi else {"selectedBounds": AREA}
    response = client.post(
        "/api/processing/raster-clips/plan",
        json={**SOURCE, **selection},
        headers=HEADERS,
    )
    assert response.status_code == 200, response.text
    return response.json()


def submitted(
    client: TestClient, plan: dict[str, Any], request_id: str | None = None
) -> dict[str, Any]:
    """Durably submit a plan through its idempotent HTTP contract.

    Args:
        client: Owner session.
        plan: Existing plan result.
        request_id: Optional repeated client key.

    Returns:
        Accepted job state.
    """
    response = client.post(
        "/api/processing/raster-clips",
        json={"planId": plan["planId"], "requestId": request_id or uuid4().hex},
        headers=HEADERS,
    )
    assert response.status_code == 202, response.text
    return response.json()


def test_real_plan_worker_download_ranges_ownership_and_idempotency(
    boundary: Any, tmp_path: Path
) -> None:
    """Exercise a complete native clip via PostgreSQL and real HTTP file delivery.

    Args:
        boundary: Real feature-boundary fixture.
        tmp_path: Download validation storage.
    """
    client, worker, source, artifacts, app = boundary
    plan = planned(client)
    assert (
        client.post(
            "/api/processing/raster-clips/plan", content=b"x" * 20000, headers=HEADERS
        ).status_code
        == 413
    )
    assert plan["grid"]["estimatedRawBytes"] > 0
    assert "Set-Cookie" not in plan
    key = uuid4().hex
    job = submitted(client, plan, key)
    identifier = job["jobId"]
    assert submitted(client, plan, key)["jobId"] == identifier
    assert asyncio.run(worker.run_once())
    ready = client.get(f"/api/processing/jobs/{identifier}").json()
    assert ready["status"] == "ready", ready
    assert client.get("/api/processing/jobs").json()["jobs"][0]["jobId"] == identifier
    url = ready["result"]["url"]
    complete = client.get(url)
    assert complete.status_code == 200
    assert complete.headers["content-type"] == "image/tiff"
    assert "attachment" in complete.headers["content-disposition"]
    assert int(complete.headers["content-length"]) == len(complete.content)
    assert hashlib.sha256(complete.content).hexdigest() == ready["result"]["sha256"]
    partial = client.get(
        url, headers={"Range": "bytes=10-99", "If-Range": complete.headers["etag"]}
    )
    assert partial.status_code == 206
    assert partial.content == complete.content[10:100]
    assert (
        client.head(url).headers["content-length"] == complete.headers["content-length"]
    )
    assert client.get(url, headers={"Range": "bytes=99999999999-"}).status_code == 416
    assert client.get(url, headers={"Range": "bytes=0-1,3-4"}).status_code == 416
    provenance = client.get(ready["result"]["provenanceUrl"])
    assert provenance.status_code == 200
    assert provenance.json()["source"] == SOURCE
    assert str(source) not in provenance.text
    downloaded = tmp_path / "download.tif"
    downloaded.write_bytes(complete.content)
    with rasterio.open(downloaded) as raster:
        assert raster.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert raster.read(1, masked=True).count() == ready["result"]["validPixels"]
    with TestClient(app, base_url="https://testserver") as stranger:
        assert stranger.get(url).status_code == 404
        assert stranger.get(f"/api/processing/jobs/{identifier}").status_code == 404
        assert stranger.get("/api/processing/jobs").json() == {"jobs": []}
        assert (
            stranger.post(
                f"/api/processing/jobs/{identifier}/cancel", headers=HEADERS
            ).status_code
            == 404
        )
        assert (
            stranger.delete(
                f"/api/processing/jobs/{identifier}", headers=HEADERS
            ).status_code
            == 404
        )
        assert (
            stranger.post(
                "/api/processing/raster-clips",
                json={"planId": plan["planId"], "requestId": uuid4().hex},
                headers=HEADERS,
            ).status_code
            == 404
        )
    assert (
        client.post(
            "/api/processing/raster-clips",
            json={"planId": plan["planId"], "requestId": uuid4().hex},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/processing/raster-clips",
            json={"planId": plan["planId"], "requestId": uuid4().hex},
            headers={**HEADERS, "Origin": "https://other.example"},
        ).status_code
        == 403
    )


def test_catalog_job_reauthorizes_after_restart_and_preserves_ready_result(
    boundary: Any,
    tmp_path: Path,
    store: PostgresJobStore,
) -> None:
    """Durable jobs contain descriptors; ready artifacts outlive source removal."""
    client, worker, source, artifacts, app = boundary
    vector = tmp_path / "selection.gpkg"
    geometry = {
        "type": "Polygon",
        "coordinates": [[[0.1, 9.1], [0.9, 9.1], [0.9, 9.9], [0.1, 9.9], [0.1, 9.1]]],
    }
    write_geopackage_layer(
        vector, "area", crs="EPSG:4326", geometry_type="Polygon", geometry=geometry
    )
    selection = register_selection(client, vector)
    plan = planned(client, selection)
    job = submitted(client, plan)
    # A fresh worker receives no geometry, source handle, or selection registry.
    restarted = ProcessingWorker(
        worker.authorizer, store, artifacts, store.limits, areas=worker.areas
    )
    assert asyncio.run(restarted.run_once())
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    assert ready["area"]["kind"] == "catalogSelection"
    app.state.vector_items.clear()
    rejected = client.post(
        "/api/processing/raster-clips",
        json={"planId": plan["planId"], "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert rejected.status_code == 409
    assert client.get(f"/api/processing/jobs/{job['jobId']}/result").status_code == 200


def test_queued_cancellation_never_publishes(boundary: Any) -> None:
    """Cancel queued work without executing it or publishing a result.

    Args:
        boundary: Real owners and worker fixture.
    """
    client, worker, source, artifacts, app = boundary
    plan = planned(client)
    cancelled = submitted(client, plan)
    identifier = cancelled["jobId"]
    assert (
        client.post(
            f"/api/processing/jobs/{identifier}/cancel", headers=HEADERS
        ).json()["status"]
        == "cancelled"
    )
    assert not asyncio.run(worker.run_once())
    assert not list((artifacts.root / "results").iterdir())


def test_global_admission_concurrency_fencing_and_restart_recovery(
    store: PostgresJobStore, tmp_path: Path
) -> None:
    """Exercise actual concurrent transactions across independent worker adapters.

    Args:
        store: Disposable real PostgreSQL adapter.
        tmp_path: Source grid for a real plan specification.
    """
    path = write_source(tmp_path / "source.tif", numpy.ones((100, 100), dtype="uint8"))
    spec = prepare_clip_job(
        make_spec(path, ClipArea(kind="bounds", bounds=(0.1, 9.1, 0.9, 9.9)))
    )
    plan_id = store.reserve_plan("owner", SOURCE)
    with pytest.raises(ProcessingError) as capacity:
        store.reserve_plan("another", SOURCE)
    assert capacity.value.code == "plan_capacity"
    store.finish_plan(plan_id, "owner", spec)
    with ThreadPoolExecutor(max_workers=6) as pool:
        jobs = list(
            pool.map(
                lambda _: store.submit("owner", plan_id, "same-request", spec), range(6)
            )
        )
    assert len({job["id"] for job in jobs}) == 1
    other_store = PostgresJobStore(store.limits, store.conninfo)
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda adapter: adapter.claim(), (store, other_store)))
    assert sum(claim is not None for claim in claims) == 1
    claim = next(claim for claim in claims if claim)
    assert not store.heartbeat(claim["id"], "stale-token", {})
    assert not store.finish(claim["id"], "stale-token", Artifact(1, "x", "x.tif"))
    store.cancel(claim["id"], "owner")
    assert not store.finish(claim["id"], claim["attempt_id"], Artifact(1, "x", "x.tif"))
    assert store.finish(claim["id"], claim["attempt_id"], None)
    assert store.get(claim["id"], "owner")["status"] == "cancelled"
    queued = store.submit("owner", plan_id, "next-request", spec)
    lost = other_store.claim()
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET lease_until=now()-interval '1 minute' WHERE id=%s",
            (lost["id"],),
        )
    # Even after lease loss, no replacement child starts before the old hard
    # deadline; this protects against overlapping deployments/DB outages.
    assert store.claim() is None
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET deadline_at=now()-interval '1 minute' WHERE id=%s",
            (lost["id"],),
        )
    assert store.claim() is None
    assert store.get(lost["id"], "owner")["status"] == "interrupted"


def test_job_store_admits_operation_data_without_raster_fields(
    store: PostgresJobStore,
) -> None:
    """Apply shared scheduling and storage policy to operation-owned opaque data.

    Args:
        store: Disposable real PostgreSQL adapter with no raster collaborators.
    """
    prepared = PreparedJobPlan(
        specification={"operation": "test.summary.v1", "fields": ["year"]},
        summary={"operation": "test.summary.v1", "label": "Year summary"},
        reserved_bytes=4096,
    )
    plan_id = store.reserve_plan("owner", {"fields": ["year"]})
    store.finish_plan(plan_id, "owner", prepared)
    submitted_job = store.submit("owner", plan_id, "summary-request", prepared)
    assert submitted_job["spec"] == prepared.specification
    assert submitted_job["reserved_bytes"] == 4096
    assert store.get(submitted_job["id"], "owner")["spec"] == prepared.summary
    assert store.list_owned("owner")[0]["spec"] == prepared.summary
    assert (
        store.submit("owner", plan_id, "summary-request", prepared)["id"]
        == submitted_job["id"]
    )
    store.limits = replace(store.limits, max_stored_bytes=4096)
    with pytest.raises(ProcessingError) as refused:
        store.submit("owner", plan_id, "another-request", prepared)
    assert refused.value.code == "storage_full"
    claimed = store.claim()
    assert claimed["spec"] == prepared.specification
    assert store.heartbeat(
        claimed["id"], claimed["attempt_id"], {"phase": "summarizing"}
    )
    assert store.cancel(claimed["id"], "owner")["status"] == "cancelling"
    assert store.finish(claimed["id"], claimed["attempt_id"], None)
    assert store.get(claimed["id"], "owner")["status"] == "cancelled"


def test_owner_disk_limits_and_transfer_lease_cleanup(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Do not reclaim active downloads or release budgets before files are gone.

    Args:
        boundary: Real owners and worker fixture.
        store: Real adapter used to simulate time passage without waiting a day.
    """
    client, worker, source, artifacts, app = boundary
    plan = planned(client)
    first = submitted(client, plan)
    second = submitted(client, plan)
    full = client.post(
        "/api/processing/raster-clips",
        json={"planId": plan["planId"], "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert full.status_code == 429
    assert full.json()["detail"]["code"] == "queue_full"
    assert asyncio.run(worker.run_once())
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    row, lease = store.acquire_transfer(first["jobId"], owner)
    result = artifacts.result_path(row["attempt_id"])
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
            (first["jobId"],),
        )
    assert client.get(f"/api/processing/jobs/{first['jobId']}").json()["result"] is None
    asyncio.run(worker.cleanup())
    assert result.exists()
    assert store.transfer_heartbeat(lease)
    store.transfer_heartbeat(lease, release=True)
    asyncio.run(worker.cleanup())
    assert not result.exists()
    cleaned = store.get(first["jobId"], owner)
    assert cleaned["spec"] is None and cleaned["reserved_bytes"] == 0
    store.limits = replace(store.limits, max_stored_bytes=1)
    denied = client.post(
        "/api/processing/raster-clips",
        json={"planId": plan["planId"], "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert denied.status_code == 429
    assert denied.json()["detail"]["code"] == "storage_full"


def _paused_clip(queue: Any, operation: str, arguments: tuple) -> None:
    """Pause a real clip before or after file finalization for race tests.

    Args:
        queue: Supervisor result writer.
        operation: Expected explicit clip operation.
        arguments: Native clip source/spec/directory/limits.
    """
    path, spec, directory, limits = arguments
    assert operation == "clip"
    artifact = None
    if (directory.parent.parent / "pause-after-output").exists():
        artifact = create_clip(*arguments)
    (directory / "checkpoint").write_text("paused")
    time.sleep(5)
    if artifact is None:
        artifact = create_clip(*arguments)
    queue.put(("ok", artifact))


@pytest.mark.parametrize(
    "phase,shutdown", [("reading", False), ("finalizing", False), ("reading", True)]
)
def test_worker_cancellation_and_shutdown_join_child_before_cleanup(
    boundary: Any,
    monkeypatch: pytest.MonkeyPatch,
    phase: str,
    shutdown: bool,
) -> None:
    """Never publish a cancelled file or free its capacity before child exit.

    Args:
        boundary: Real HTTP, worker, and database boundary fixture.
        monkeypatch: Replace only the lower-level target with a controllable pause.
        phase: Pause before native reading or after private output finalization.
        shutdown: Simulate worker shutdown instead of a browser cancel request.
    """
    client, worker, source, artifacts, app = boundary
    job = submitted(client, planned(client))
    if phase == "finalizing":
        (artifacts.root / "pause-after-output").touch()
    monkeypatch.setattr(worker_module, "clip_process_target", _paused_clip)

    async def exercise() -> None:
        """Cancel only after the real native child reaches the test checkpoint."""
        task = asyncio.create_task(worker.run_once())
        try:
            async with asyncio.timeout(10):
                while not list((artifacts.root / "attempts").glob("*/checkpoint")):
                    await asyncio.sleep(0.05)
            url = f"/api/processing/jobs/{job['jobId']}"
            assert client.get(f"{url}/result").status_code == 409
            if shutdown:
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                assert (
                    client.post(f"{url}/cancel", headers=HEADERS).json()["status"]
                    == "cancelling"
                )
                assert await task
            status = client.get(url).json()["status"]
            assert status == ("interrupted" if shutdown else "cancelled")
            assert not list((artifacts.root / "results").iterdir())
            await worker.cleanup()
            assert not list((artifacts.root / "attempts").iterdir())
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())


def test_expired_plan_and_idempotency_key_conflict(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Expiration blocks new admission while an accepted request remains recoverable.

    Args:
        boundary: Real application boundary.
        store: Disposable PostgreSQL adapter for deterministic expiry.
    """
    client, worker, source, artifacts, app = boundary
    plan = planned(client)
    key = uuid4().hex
    job = submitted(client, plan, key)
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.plans SET expires_at=now()-interval '1 second' WHERE id=%s",
            (plan["planId"],),
        )
    assert submitted(client, plan, key)["jobId"] == job["jobId"]
    assert (
        client.post(
            "/api/processing/raster-clips",
            json={"planId": plan["planId"], "requestId": uuid4().hex},
            headers=HEADERS,
        ).status_code
        == 404
    )
    another = planned(client)
    conflict = client.post(
        "/api/processing/raster-clips",
        json={"planId": another["planId"], "requestId": key},
        headers=HEADERS,
    )
    assert conflict.status_code == 409


def test_previously_created_clip_download_retains_its_content_type(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Serve retained clip results whose stored metadata predates media types.

    Args:
        boundary: Real API, worker, and raster output fixture.
        store: Disposable database used to model the earlier metadata format.
    """
    client, worker, source, artifacts, app = boundary
    job = submitted(client, planned(client))
    assert asyncio.run(worker.run_once())
    url = f"/api/processing/jobs/{job['jobId']}/result"
    current = client.get(url)
    assert current.status_code == 200
    assert current.headers["content-type"] == "image/tiff"
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET artifact=artifact-'media_type' WHERE id=%s",
            (job["jobId"],),
        )
    previous = client.get(url)
    assert previous.status_code == 200
    assert previous.content == current.content
    assert previous.headers["content-type"] == "image/tiff"


def test_worker_composition_requires_only_catalog_and_processing_configuration(
    tmp_path: Path,
    store: PostgresJobStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep the settings boundary while avoiding web/AOI/rendering initialization.

    Args:
        tmp_path: Independent source and artifact roots.
        store: Real migrated processing database.
        monkeypatch: Supply only the worker's validated dependencies.
    """
    import eolab_app.main as composition

    mount = tmp_path / "mount"
    mount.mkdir()
    monkeypatch.setenv("CATALOG_INTERNAL_URL", "http://catalog")
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(mount))
    monkeypatch.setenv("PROCESSING_DATA_PATH", str(tmp_path / "outputs"))
    monkeypatch.delenv("GEOSERVER_ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("GEOSERVER_INTERNAL_URL", raising=False)
    monkeypatch.setattr(composition, "PostgresJobStore", lambda limits: store)

    def unexpected(*args: Any, **kwargs: Any) -> None:
        """Fail if worker composition constructs an unrelated feature.

        Args:
            args: Unexpected positional construction arguments.
            kwargs: Unexpected keyword construction arguments.
        """
        pytest.fail("Worker composition entered an unrelated web/AOI/rendering feature")

    async def consume(worker: ProcessingWorker, wakeup: Any) -> None:
        """Check the composed worker without starting an endless test loop.

        Args:
            worker: Composed, migrated processing owner.
            wakeup: Processing-owned notification adapter, constructed without I/O.
        """
        assert isinstance(worker, ProcessingWorker)
        assert isinstance(wakeup, composition.PostgresJobWakeup)
        assert not await worker.run_once()

    monkeypatch.setattr(composition, "create_app", unexpected)
    monkeypatch.setattr(composition, "GeoServerRasterPublisher", unexpected)
    monkeypatch.setattr(composition, "serve_processing", consume)
    asyncio.run(composition.run_processing_worker())


def test_queue_notification_is_committed_with_admission(store, tmp_path, monkeypatch):
    """Notify only committed admissions and retain the durable single-worker fence.

    Args:
        store: Explicitly disposable PostgreSQL store.
        tmp_path: Real raster for a supported operation specification.
        monkeypatch: Inject one transaction rollback after INSERT and NOTIFY.
    """
    path = write_source(tmp_path / "source.tif", numpy.ones((100, 100), dtype="uint8"))
    spec = prepare_clip_job(
        make_spec(path, ClipArea(kind="bounds", bounds=(0.1, 9.1, 0.9, 9.9)))
    )
    plan_id = store.reserve_plan("owner", SOURCE)
    store.finish_plan(plan_id, "owner", spec)

    async def scenario():
        """Check two listeners, commit/rollback delivery, and durable claims."""
        listeners = [PostgresJobWakeup(store.conninfo) for _ in range(2)]
        try:
            for listener in listeners:
                await listener.arm()
                assert listener.reader is not None
            assert await asyncio.to_thread(store.claim) is None
            transaction = store._transaction

            @contextmanager
            def rolled_back(*args, **kwargs):
                """Abort after admission's INSERT/NOTIFY but before commit.

                Args:
                    args: Store transaction positional options.
                    kwargs: Store transaction keyword options.

                Yields:
                    The real PostgreSQL transaction cursor.
                """
                with transaction(*args, **kwargs) as cursor:
                    yield cursor
                    raise RuntimeError("rollback admission")

            with monkeypatch.context() as patch:
                patch.setattr(store, "_transaction", rolled_back)
                with pytest.raises(RuntimeError, match="rollback admission"):
                    await asyncio.to_thread(
                        store.submit, "owner", plan_id, "rolled-back", spec
                    )
            assert not await listeners[0].wait(0.05)
            assert await asyncio.to_thread(store.claim) is None
            queued = await asyncio.to_thread(
                store.submit, "owner", plan_id, "committed", spec
            )
            assert all(
                await asyncio.gather(*(listener.wait(1) for listener in listeners))
            )
            duplicate = await asyncio.to_thread(
                store.submit, "owner", plan_id, "committed", spec
            )
            assert duplicate["id"] == queued["id"]
            claims = await asyncio.gather(
                *(asyncio.to_thread(store.claim) for _ in listeners)
            )
            assert sum(claim is not None for claim in claims) == 1
            assert next(claim for claim in claims if claim)["id"] == queued["id"]
        finally:
            await asyncio.gather(*(listener.close() for listener in listeners))

    # Psycopg asynchronous connections require a selector loop on Windows too.
    with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
        runner.run(scenario())
