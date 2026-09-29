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
from eolab_app.processing.service import ProcessingService
from eolab_app.processing.job_preparation import prepare_clip_job
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
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.bounded_vector import selection_summary
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
    if (
        not psycopg.conninfo.conninfo_to_dict(dsn)
        .get("dbname", "")
        .startswith("eolab_processing_test")
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
            "TRUNCATE processing.transfers, processing.jobs, processing.calculation_results, processing.inputs"
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

    async def measure_selection(selection: CatalogSelection) -> dict[str, Any]:
        """Measure fixture polygons at Processing's injected Vector boundary.

        Args:
            selection: Descriptor to reauthorize against the fixture Catalog.

        Returns:
            Native feature measurements; Jobs transport is tested separately.
        """
        return selection_summary(await areas.resolve_for_sampling(selection))

    areas = VectorSamplingService(
        StacVectorCatalog(catalog_client, "http://catalog"),
        MountedVectorResolver(tmp_path),
        selection_executor=measure_selection,
    )
    artifacts = LocalJobArtifacts(tmp_path / "outputs", (path,))
    artifacts.initialize()
    service = ProcessingService(store, artifacts)
    worker = ProcessingWorker(authorizer, store, artifacts, store.limits, areas=areas)
    app = FastAPI()
    app.state.vector_items = vector_items
    app.include_router(create_processing_router(service))
    app.include_router(create_vector_sampling_router(areas))
    with TestClient(app, base_url="https://testserver") as client:
        yield client, worker, path, artifacts, app
    asyncio.run(catalog_client.aclose())


def clip_inputs(
    client: TestClient, aoi: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Return a catalog raster and explicit box or filtered vector for submission.

    Args:
        client: Test client retained for shared fixture call sites.
        aoi: Optional catalog selection; otherwise use the fixture rectangle.

    Returns:
        Path-free inputs accepted by the clip endpoint.
    """
    return {
        **SOURCE,
        **({"catalogSelection": aoi} if aoi else {"selectedBounds": AREA}),
    }


def submitted(
    client: TestClient, inputs: dict[str, Any], request_id: str | None = None
) -> dict[str, Any]:
    """Queue clip inputs through the idempotent HTTP endpoint.

    Args:
        client: Owner session.
        inputs: Catalog raster and explicit clipping area.
        request_id: Optional repeated client key.

    Returns:
        Accepted job state.
    """
    response = client.post(
        "/api/processing/raster-clips",
        json={**inputs, "requestId": request_id or uuid4().hex},
        headers=HEADERS,
    )
    assert response.status_code == 202, response.text
    return response.json()


def test_real_clip_worker_download_ranges_ownership_and_idempotency(
    boundary: Any, tmp_path: Path
) -> None:
    """Exercise a complete native clip via PostgreSQL and real HTTP file delivery.

    Args:
        boundary: Real feature-boundary fixture.
        tmp_path: Download validation storage.
    """
    client, worker, source, artifacts, app = boundary
    plan = clip_inputs(client)
    assert (
        client.post(
            "/api/processing/raster-clips", content=b"x" * 20000, headers=HEADERS
        ).status_code
        == 413
    )
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
                json={**plan, "requestId": uuid4().hex},
                headers=HEADERS,
            ).status_code
            == 202
        )
    assert (
        client.post(
            "/api/processing/raster-clips",
            json={**plan, "requestId": uuid4().hex},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/processing/raster-clips",
            json={**plan, "requestId": uuid4().hex},
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
    plan = clip_inputs(client, selection)
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
        json={**plan, "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert rejected.status_code == 202
    assert asyncio.run(worker.run_once())
    assert (
        client.get(f"/api/processing/jobs/{rejected.json()['jobId']}").json()["status"]
        == "failed"
    )
    assert client.get(f"/api/processing/jobs/{job['jobId']}/result").status_code == 200


def test_queued_cancellation_never_publishes(boundary: Any) -> None:
    """Cancel queued work without executing it or publishing a result.

    Args:
        boundary: Real owners and worker fixture.
    """
    client, worker, source, artifacts, app = boundary
    plan = clip_inputs(client)
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
    with ThreadPoolExecutor(max_workers=6) as pool:
        jobs = list(
            pool.map(
                lambda _: store.submit(
                    "owner", "same-request", spec, "fixture-input-hash"
                ),
                range(6),
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
    queued = store.submit("owner", "next-request", spec, "fixture-input-hash")
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
    submitted_job = store.submit(
        "owner", "summary-request", prepared, "fixture-input-hash"
    )
    assert submitted_job["spec"] == prepared.specification
    assert submitted_job["reserved_bytes"] == 4096
    assert store.get(submitted_job["id"], "owner")["spec"] == prepared.summary
    assert store.list_owned("owner")[0]["spec"] == prepared.summary
    assert (
        store.submit("owner", "summary-request", prepared, "fixture-input-hash")["id"]
        == submitted_job["id"]
    )
    store.limits = replace(store.limits, max_stored_bytes=4096)
    with pytest.raises(ProcessingError) as refused:
        store.submit("owner", "another-request", prepared, "fixture-input-hash")
    assert refused.value.code == "storage_full"
    claimed = store.claim()
    assert claimed["spec"] == prepared.specification
    assert store.heartbeat(
        claimed["id"], claimed["attempt_id"], {"phase": "summarizing"}
    )
    assert store.cancel(claimed["id"], "owner")["status"] == "cancelling"
    assert store.finish(claimed["id"], claimed["attempt_id"], None)
    assert store.get(claimed["id"], "owner")["status"] == "cancelled"


@pytest.mark.parametrize(
    "store", [RasterClipLimits(max_owner_waiting_jobs=2)], indirect=True
)
def test_owner_disk_limits_and_transfer_lease_cleanup(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Do not reclaim active downloads or release budgets before files are gone.

    Args:
        boundary: Real owners and worker fixture.
        store: Real adapter used to simulate time passage without waiting a day.
    """
    client, worker, source, artifacts, app = boundary
    plan = clip_inputs(client)
    first = submitted(client, plan)
    second = submitted(client, plan)
    full = client.post(
        "/api/processing/raster-clips",
        json={**plan, "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert full.status_code == 429
    assert full.json()["detail"]["code"] == "owner_queue_full"
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
        json={**plan, "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert denied.status_code == 202
    assert asyncio.run(worker.run_once())
    assert asyncio.run(worker.run_once())
    failed = client.get(f"/api/processing/jobs/{denied.json()['jobId']}").json()
    assert failed["error"]["code"] == "storage_full"


def _paused_clip(queue: Any, operation: str, arguments: tuple) -> None:
    """Pause a real clip before or after file finalization for race tests.

    Args:
        queue: Supervisor result writer.
        operation: Expected explicit clip operation.
        arguments: Native clip source/spec/directory/limits.
    """
    if operation == "plan":
        from eolab_app.processing.raster_clip import clip_process_target

        clip_process_target(queue, operation, arguments)
        return
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
    job = submitted(client, clip_inputs(client))
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


def test_clip_retry_rejects_changed_inputs(boundary: Any) -> None:
    """Retrying one key recovers the original job and rejects a changed area.

    Args:
        boundary: Real HTTP submission and PostgreSQL providers.
    """
    client, *_ = boundary
    inputs = clip_inputs(client)
    key = uuid4().hex
    job = submitted(client, inputs, key)
    assert submitted(client, inputs, key)["jobId"] == job["jobId"]
    changed = {**inputs, "selectedBounds": {**AREA, "west": 0.2}, "requestId": key}
    response = client.post(
        "/api/processing/raster-clips", json=changed, headers=HEADERS
    )
    assert response.status_code == 409


def test_previously_created_clip_download_retains_its_content_type(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Serve retained clip results whose stored metadata predates media types.

    Args:
        boundary: Real API, worker, and raster output fixture.
        store: Disposable database used to model the earlier metadata format.
    """
    client, worker, source, artifacts, app = boundary
    job = submitted(client, clip_inputs(client))
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
    monkeypatch.setenv("PROCESSING_MAX_WAITING_JOBS", "61")
    monkeypatch.setenv("PROCESSING_MAX_OWNER_WAITING_JOBS", "17")
    monkeypatch.delenv("GEOSERVER_ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("GEOSERVER_INTERNAL_URL", raising=False)
    monkeypatch.setattr(composition, "PostgresJobStore", lambda limits: store)

    pending = store.submit(
        "owner",
        "before-restart",
        PreparedJobPlan({"operation": "test.v1"}, {"label": "Test"}, 4096),
        "a" * 64,
    )

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
        assert worker.limits.max_waiting_jobs == 61
        assert worker.limits.max_owner_waiting_jobs == 17
        assert isinstance(wakeup, composition.PostgresJobWakeup)
        assert store.get(pending["id"], "owner")["status"] == "interrupted"
        await worker.cleanup()
        assert store.get(pending["id"], "owner")["reserved_bytes"] == 0
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
                        store.submit, "owner", "rolled-back", spec, "fixture-input-hash"
                    )
            assert not await listeners[0].wait(0.05)
            assert await asyncio.to_thread(store.claim) is None
            queued = await asyncio.to_thread(
                store.submit, "owner", "committed", spec, "fixture-input-hash"
            )
            assert all(
                await asyncio.gather(*(listener.wait(1) for listener in listeners))
            )
            duplicate = await asyncio.to_thread(
                store.submit, "owner", "committed", spec, "fixture-input-hash"
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


@pytest.mark.parametrize("status", ["queued", "running", "cancelling"])
def test_worker_restart_interrupts_unfinished_jobs(
    store: PostgresJobStore, status: str
) -> None:
    """Discard unfinished work while preserving results, cache and late-write fences.

    Args:
        store: Disposable real PostgreSQL adapter.
        status: Unfinished state retained from the stopped worker.
    """
    prepared = PreparedJobPlan({"operation": "test.v1"}, {"label": "Test"}, 4096)
    completed = store.submit("owner", "completed-request", prepared, "a" * 64)
    claimed = store.claim()
    assert claimed["id"] == completed["id"]
    cached = {"b" * 64: {"value": "1"}}
    assert store.finish(
        claimed["id"],
        claimed["attempt_id"],
        Artifact(1, "checksum", "result.csv"),
        reusable_results=cached,
    )
    ready = store.get(completed["id"], "owner")
    pending = store.submit("other-owner", "unfinished-request", prepared, "a" * 64)
    if status != "queued":
        pending = store.claim()
        if status == "cancelling":
            store.cancel(pending["id"], "other-owner")

    assert store.interrupt_unfinished_jobs_on_restart() == 1
    interrupted = store.get(pending["id"], "other-owner")
    assert interrupted["status"] == "interrupted"
    assert interrupted["error"]["code"] == "worker_restarted"
    assert "Submit a new job" in interrupted["error"]["detail"]
    assert (
        store.find_request("other-owner", "unfinished-request")["status"]
        == "interrupted"
    )
    # Retain reservations until attempt files have been removed by normal cleanup.
    assert interrupted["reserved_bytes"] == 4096
    assert pending["id"] in {row["id"] for row in store.cleanup_candidates()}
    if status != "queued":
        assert not store.heartbeat(pending["id"], pending["attempt_id"], {})
        assert not store.finish(
            pending["id"], pending["attempt_id"], Artifact(1, "late", "late.csv")
        )
    store.cleaned(pending["id"])
    assert store.get(pending["id"], "other-owner")["reserved_bytes"] == 0
    with psycopg.connect(store.conninfo) as conn:
        assert conn.execute(
            "SELECT input_bytes,spec FROM processing.jobs WHERE id=%s", (pending["id"],)
        ).fetchone() == (0, None)
    assert store.get(completed["id"], "owner") == ready
    assert store.get_cached_calculation_results(list(cached)) == cached
    assert store.interrupt_unfinished_jobs_on_restart() == 0
    fresh = store.submit("owner", "fresh-request", prepared, "a" * 64)
    assert store.claim()["id"] == fresh["id"]
