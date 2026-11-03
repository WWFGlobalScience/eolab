"""Real model HTTP, catalog, PostgreSQL and supervised aggregate boundaries."""

from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from datetime import datetime, timedelta, timezone
import asyncio
import hashlib
import numpy
import rasterio
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_run_contracts import RunDocument
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.service import ProcessingService
from eolab_app.routes.processing import COOKIE, create_processing_router
from test_processing_jobs import (
    boundary,
    store,
    HEADERS,
    AREA,
    clip_inputs,
    _paused_clip,
)
from raster_source_support import SOURCE
from test_processing_calculations import paused_calculation
from test_polygon_summary_areas import rectangle
from catalog_selection_support import register_selection, write_geopackage_layer
import eolab_app.processing.worker as worker_module
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.processing.job_store import PostgresJobStore


@pytest.mark.parametrize("state", ["cancelled", "failed", "interrupted"])
def test_undo_restores_terminal_run_history(
    model_boundary: Any, store: PostgresJobStore, state: str
) -> None:
    """Undo restores terminal history and saved inputs without restarting any work.

    Args:
        model_boundary: Real model HTTP and worker composition.
        store: Isolated PostgreSQL lifecycle store.
        state: Terminal outcome to restore, including subscriber cancellation.
    """
    client, worker, _ = model_boundary
    run = submit(client, model_request(client))
    base = f"/api/processing/jobs/{run['jobId']}"
    if state == "cancelled":
        assert client.post(base + "/cancel", headers=HEADERS).status_code == 202
    elif state == "interrupted":
        store.interrupt_unfinished_jobs_on_restart()
    else:
        claimed = store.claim_next_job()
        assert store.finish(
            claimed["id"],
            claimed["attempt_id"],
            None,
            {"code": "test_failure", "detail": "Test failure"},
        )
    before = client.get(base).json()
    offer = client.delete(base + "?undo=true", headers=HEADERS).json()["deletionUndo"]
    client.portal.call(worker.cleanup)
    response = client.post(
        base + "/deletion/undo",
        json={"deletionId": offer["deletionId"]},
        headers=HEADERS,
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == state
    assert response.json()["metadataExpiresAt"] == before["metadataExpiresAt"]
    assert client.get(base + "/invocation").status_code == 200
    assert not client.portal.call(worker.run_once)


def test_old_run_history_is_retained_during_undo_without_reviving_metadata(
    model_boundary: Any, store: PostgresJobStore
) -> None:
    """Keep an old history row for Undo even when ordinary record retention has ended.

    Args:
        model_boundary: Real model HTTP and worker composition.
        store: Isolated lifecycle store used to age a cancelled run.
    """
    client, worker, _ = model_boundary
    run = submit(client, model_request(client))
    identifier = run["jobId"]
    base = f"/api/processing/jobs/{identifier}"
    assert client.post(base + "/cancel", headers=HEADERS).status_code == 202
    client.portal.call(worker.cleanup)
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET updated_at=now()-interval '8 days',"
            "expires_at=now()-interval '1 day',metadata_expires_at=now()-interval '1 day' WHERE id=%s",
            (identifier,),
        )
    offer = client.delete(base + "?undo=true", headers=HEADERS).json()["deletionUndo"]
    client.portal.call(worker.cleanup)
    response = client.post(
        base + "/deletion/undo",
        json={"deletionId": offer["deletionId"]},
        headers=HEADERS,
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"
    assert client.get(base + "/invocation").status_code == 410
    assert client.get(base + "/run-yaml").status_code == 410


def test_undo_dismiss_and_cleanup_share_one_lifecycle_transition(
    model_boundary: Any, store: PostgresJobStore
) -> None:
    """Concurrent Undo, dismissal and cleanup never delete a successfully restored result.

    Args:
        model_boundary: Real model execution and HTTP composition.
        store: Isolated store whose transactions share the lifecycle lock.
    """
    client, worker, _ = model_boundary
    run = submit(client, model_request(client))
    assert client.portal.call(worker.run_once)
    identifier = run["jobId"]
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    deleted = store.cancel(identifier, owner, delete=True, undo_seconds=30)
    barrier = Barrier(3)

    def compete(action: str) -> str:
        """Run one lifecycle operation after all race participants are ready.

        Args:
            action: Undo, dismiss or gather cleanup candidates.

        Returns:
            Resulting job status, rejection code, or cleanup marker.
        """
        barrier.wait(timeout=5)
        try:
            if action == "cleanup":
                store.cleanup_candidates()
                return action
            return store.resolve_deletion(
                identifier, owner, deleted["deletion_id"], action == "undo"
            )["status"]
        except ProcessingError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=3) as pool:
        outcomes = list(pool.map(compete, ("undo", "dismiss", "cleanup")))
    assert outcomes[0] in {"ready", "undo_expired"}
    assert outcomes[1] in {"ready", "deleted"}
    assert outcomes[2] == "cleanup"
    client.portal.call(worker.cleanup)
    current = client.get(f"/api/processing/jobs/{identifier}").json()
    assert current["status"] == ("ready" if outcomes[0] == "ready" else "deleted")
    if current["status"] == "ready":
        assert client.get(current["result"]["url"]).status_code == 200


@pytest.mark.parametrize("rejection", ["owner", "origin", "identity", "body", "action"])
def test_model_undo_requires_owner_origin_and_exact_deletion(
    model_boundary: Any, rejection: str
) -> None:
    """Reject forged or stale Undo requests without changing the deletion hold.

    Args:
        model_boundary: Real model HTTP and worker composition.
        rejection: External contract violation to exercise.
    """
    client, worker, _ = model_boundary
    run = submit(client, model_request(client))
    base = f"/api/processing/jobs/{run['jobId']}"
    assert client.delete(base + "?undo=true", headers=HEADERS).status_code == 409
    assert client.portal.call(worker.run_once)
    offer = client.delete(base + "?undo=true", headers=HEADERS).json()["deletionUndo"]
    cookie = client.cookies.get(COOKIE)
    if rejection == "owner":
        client.cookies.clear()
    body = {
        "deletionId": uuid4().hex if rejection == "identity" else offer["deletionId"]
    }
    if rejection == "body":
        body["path"] = "/anything"
    headers = {
        **HEADERS,
        **({"Origin": "https://elsewhere.test"} if rejection == "origin" else {}),
    }
    action = "unknown" if rejection == "action" else "undo"
    response = client.post(base + f"/deletion/{action}", json=body, headers=headers)
    assert (
        response.status_code
        == {"owner": 404, "origin": 403, "identity": 409, "body": 422, "action": 422}[
            rejection
        ]
    ), response.text
    client.cookies.set(COOKIE, cookie)
    assert client.get(base).json()["deletionUndo"] == offer


@pytest.mark.parametrize(
    "state",
    ["queued", "expired", "deleted", "details_expired", "foreign", "cross_origin"],
)
def test_model_renewal_rejects_unavailable_or_unowned_runs(
    model_boundary: Any, store: PostgresJobStore, state: str
) -> None:
    """Reject renewal without reviving expired data or granting another session access.

    Args:
        model_boundary: Real HTTP, worker and lifecycle composition.
        store: Isolated PostgreSQL store.
        state: Unavailable state or rejected request boundary to exercise.
    """
    client, worker, _ = model_boundary
    run = submit(client, model_request(client))
    base = f"/api/processing/jobs/{run['jobId']}"
    if state != "queued":
        assert client.portal.call(worker.run_once)
    if state == "deleted":
        assert client.delete(base, headers=HEADERS).status_code == 200
    if state in {"expired", "details_expired"}:
        column = "expires_at" if state == "expired" else "metadata_expires_at"
        with psycopg.connect(store.conninfo) as connection:
            connection.execute(
                psycopg.sql.SQL(
                    "UPDATE processing.jobs SET {}=now()-interval '1 second' WHERE id=%s"
                ).format(psycopg.sql.Identifier(column)),
                (run["jobId"],),
            )
    if state == "foreign":
        client.cookies.clear()
    headers = {
        **HEADERS,
        **({"Origin": "https://elsewhere.test"} if state == "cross_origin" else {}),
    }
    response = client.post(base + "/renew", headers=headers)
    assert response.status_code == (
        404 if state == "foreign" else 403 if state == "cross_origin" else 409
    ), response.text


def test_model_renewal_serializes_with_delete_and_cleanup(
    model_boundary: Any, store: PostgresJobStore
) -> None:
    """Concurrent renewals do not stack weeks and deletion cannot be reversed.

    Args:
        model_boundary: Real model execution and HTTP composition.
        store: Isolated store sharing the same transaction lock across callers.
    """
    client, worker, _ = model_boundary
    run = submit(client, model_request(client))
    assert client.portal.call(worker.run_once)
    identifier = run["jobId"]
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()+interval '1 minute',metadata_expires_at=now()+interval '1 minute' WHERE id=%s",
            (identifier,),
        )
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(
            pool.map(
                lambda _: store.extend_result_lifetime(identifier, owner, 7 * 86400),
                range(4),
            )
        )
    with psycopg.connect(store.conninfo) as connection:
        remaining = connection.execute(
            "SELECT expires_at-clock_timestamp() FROM processing.jobs WHERE id=%s",
            (identifier,),
        ).fetchone()[0]
    assert timedelta(days=7, seconds=-10) < remaining <= timedelta(days=7)
    assert all(row["expires_at"] == row["metadata_expires_at"] for row in results)
    barrier = Barrier(3)

    def compete(action: str) -> str:
        """Release one lifecycle operation at the shared race boundary.

        Args:
            action: Renew, delete or find expired results.

        Returns:
            The completed action, or its classified lifecycle rejection.
        """
        barrier.wait(timeout=5)
        try:
            if action == "renew":
                store.extend_result_lifetime(identifier, owner, 7 * 86400)
            elif action == "delete":
                store.cancel(identifier, owner, True)
            else:
                store.cleanup_candidates()
            return action
        except ProcessingError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=3) as pool:
        outcomes = list(pool.map(compete, ("renew", "delete", "cleanup")))
    assert outcomes[0] in {"renew", "result_unavailable"}
    assert outcomes[1:] == ["delete", "cleanup"]
    assert store.get(identifier, owner)["status"] == "deleted"
    with pytest.raises(ProcessingError, match="completed run"):
        store.extend_result_lifetime(identifier, owner, 7 * 86400)
    client.portal.call(worker.cleanup)


def test_ordinary_clip_retention_and_renewal_boundary_are_unchanged(
    boundary: Any, store: PostgresJobStore
) -> None:
    """Keep ordinary raster downloads on their configured lifetime without model renewal.

    Args:
        boundary: Real raster clip HTTP and worker fixture.
        store: Isolated PostgreSQL store.
    """
    client, worker, _, _, _ = boundary
    response = client.post(
        "/api/processing/raster-clips",
        json={**clip_inputs(client), "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert response.status_code == 202, response.text
    identifier = response.json()["jobId"]
    assert client.portal.call(worker.run_once)
    with psycopg.connect(store.conninfo) as connection:
        captured, remaining = connection.execute(
            "SELECT result_ttl_seconds,expires_at-clock_timestamp() FROM processing.jobs WHERE id=%s",
            (identifier,),
        ).fetchone()
    assert captured is None
    assert (
        timedelta(seconds=store.limits.result_ttl_seconds - 10)
        < remaining
        <= timedelta(seconds=store.limits.result_ttl_seconds)
    )
    assert (
        client.post(
            f"/api/processing/jobs/{identifier}/renew", headers=HEADERS
        ).status_code
        == 409
    )


def test_application_starts_with_model_hydrology_without_registration(
    configured_environment: None,
    version_file_path: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    store: PostgresJobStore,
) -> None:
    """Start the application with hydrology configured in its installed model YAML.

    Args:
        configured_environment: Complete application environment without production credentials.
        version_file_path: Isolated application version file.
        tmp_path: Empty mounted-source directory and private output storage.
        monkeypatch: Set deployment paths and the disposable database connection.
        store: Migrated disposable PostgreSQL store supplied by the guarded test fixture.
    """
    from eolab_app.main import create_app

    sources = tmp_path / "sources"
    sources.mkdir()
    for parameter, variable in (
        ("host", "PGHOST"),
        ("port", "PGPORT"),
        ("dbname", "PGDATABASE"),
        ("user", "PGUSER"),
        ("password", "PGPASSWORD"),
    ):
        monkeypatch.setenv(
            variable, psycopg.conninfo.conninfo_to_dict(store.conninfo)[parameter]
        )
    monkeypatch.delenv("PREPARED_HYDROLOGY_DIRECTORY", raising=False)
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(sources))
    monkeypatch.setenv("PROCESSING_DATA_PATH", str(tmp_path / "private"))
    with TestClient(create_app(version_file_path)) as client:
        assert client.get("/healthz").status_code == 200
        response = client.get("/api/processing/models")
        assert response.status_code == 200
        model = next(
            item
            for item in response.json()["models"]
            if item["id"] == "downstream-beneficiaries"
        )
        assert set(model["inputs"]) == {"starting_mask", "values"}
        assert set(model["steps"][0]["inputs"]["hydrology"]["value"]) == {
            "dem",
            "watersheds",
            "topology",
        }
        assert (
            "/api/processing/prepared-hydrology"
            not in client.get("/openapi.json").json()["paths"]
        )
    assert not list(sources.iterdir())


@pytest.fixture
def downstream_boundary(tmp_path: Path, store: Any) -> Iterator[Any]:
    """Compose downstream HTTP, real source readers, PostgreSQL and the native worker.

    Args:
        tmp_path: Isolated mounted inputs and private output storage.
        store: Disposable real Processing database.

    Yields:
        Client, worker, captured numerical request, catalog metadata and source paths.
    """
    import httpx2
    from app_support import mounted_geotiff_item
    from catalog_selection_support import FixtureCatalog
    from test_downstream_model import downstream_fixture
    from eolab_app.processing.artifacts import LocalJobArtifacts
    from eolab_app.processing.native_processes import create_native_process
    from eolab_app.raster.catalog import StacRasterCatalog
    from eolab_app.raster.source_authorization import CatalogRasterSourceAuthorizer
    from eolab_app.raster.sources import MountedRasterResolver
    from eolab_app.vector.models import ResolvedVectorSource
    from eolab_app.vector.sampling import VectorSamplingService

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, _ = downstream_fixture(tmp_path / "sources")
    references = {
        "values": request.values,
        "dem": request.hydrology.dem,
        "starting_mask": request.starting_mask.source,
    }
    items = {
        reference.item_id: {
            **mounted_geotiff_item(sources.rasters[name].as_uri()),
            "id": reference.item_id,
        }
        for name, reference in references.items()
    }

    def catalog_request(request: httpx2.Request) -> httpx2.Response:
        """Return authoritative fixture metadata at the ordinary STAC boundary.

        Args:
            request: Catalog Item read issued by source authorization.

        Returns:
            The selected signed source Item, without any renderer state.
        """
        return httpx2.Response(200, json=items[request.url.path.rsplit("/", 1)[-1]])

    catalog = httpx2.AsyncClient(transport=httpx2.MockTransport(catalog_request))
    authorizer = CatalogRasterSourceAuthorizer(
        StacRasterCatalog(catalog, "http://catalog"), MountedRasterResolver(tmp_path)
    )
    vectors = FixtureCatalog(
        ResolvedVectorSource(
            "mounted", "geopackage", sources.network.path, "data", "watersheds"
        )
    )
    reader = VectorSamplingService(vectors, vectors)
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    native = create_native_process(store.limits)
    worker = worker_module.ProcessingWorker(
        authorizer, store, artifacts, store.limits, areas=reader, native=native
    )
    definitions = []
    for document in ModelRegistry.load_installed().list_models():
        document.pop("definitionSha256")
        if document["id"] == "downstream-beneficiaries":
            document["steps"][0]["inputs"]["hydrology"] = {
                "value": request.hydrology.model_dump(mode="json", by_alias=True)
            }
        definitions.append(ModelDefinition.model_validate(document))
    service = ProcessingService(
        store,
        artifacts,
        model_authorizer=authorizer,
        model_registry=ModelRegistry(tuple(definitions)),
    )
    app = FastAPI()
    app.include_router(create_processing_router(service))
    with TestClient(app, base_url="https://testserver") as client:
        try:
            yield client, worker, request, items, sources
        finally:
            client.portal.call(native.close)
            client.portal.call(catalog.aclose)


@pytest.mark.parametrize("change_source", [None, "private_values"])
def test_downstream_http_captures_sources_and_publishes_owned_files(
    downstream_boundary: Any, change_source: str | None
) -> None:
    """A model run captures catalog or published input identities and owns its outputs.

    Args:
        downstream_boundary: Real API, database, source and native worker composition.
        change_source: A private values raster or the original catalog values.
    """
    client, worker, request, items, sources = downstream_boundary
    values = request.values.model_dump(by_alias=True)
    if change_source == "private_values":
        parent = submit(
            client,
            model_request(
                client,
                "raster-clip",
                inputs={
                    "raster": values,
                    "area": {
                        "kind": "selectedArea",
                        "selectedBounds": {
                            "west": 0,
                            "south": 0,
                            "east": 6,
                            "north": 4,
                        },
                    },
                },
            ),
        )
        assert client.portal.call(worker.run_once)
        parent = client.get(f"/api/processing/jobs/{parent['jobId']}").json()
        assert parent["status"] == "ready", parent
        file = next(
            file
            for file in parent["artifacts"]["files"]
            if file["mediaType"] == "image/tiff"
        )
        values = {
            "kind": "runArtifact",
            "jobId": parent["jobId"],
            "artifactId": file["artifactId"],
        }
    body = model_request(
        client,
        "downstream-beneficiaries",
        inputs={
            "starting_mask": request.starting_mask.model_dump(
                mode="json", by_alias=True
            ),
            "values": values,
        },
        parameters={
            "buffer_m": 0,
            "wgs84_pixel_size": 1,
            "travel_time_pixel_size_m": 100000,
        },
    )
    job = submit(client, body)
    identifier = job["jobId"]
    pending = parse_yaml(
        client.get(f"/api/processing/jobs/{identifier}/run-yaml").content, run=True
    )
    assert pending["invocation"]["inputs"] == body["inputs"]
    assert pending["invocation"]["model"]["definition"]["steps"][0]["inputs"][
        "hydrology"
    ]["value"] == request.hydrology.model_dump(mode="json", by_alias=True)
    assert set(pending["execution"]["additionalSources"]) == {"dem", "starting_mask"}
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{identifier}").json()
    assert ready["status"] == "ready", ready
    assert float(ready["result"]["rows"][0]["value"]) == 24
    assert {item["name"] for item in ready["artifacts"]["files"]} == {
        "statistics",
        "coverage",
        "starting_mask",
        "provenance",
        "masked_values",
        "routing_dem_drain_3",
    }
    exported = client.get(f"/api/processing/jobs/{identifier}/run-yaml")
    RunDocument.model_validate(parse_yaml(exported.content, run=True))
    assert str(sources.rasters["dem"]) not in exported.text
    url = ready["result"]["url"]
    assert client.get(url).status_code == 200
    client.cookies.clear()
    assert client.get(url).status_code == 404


@pytest.fixture
def model_boundary(boundary: Any, store: Any) -> Iterator[Any]:
    """Compose model routes over the real existing raster and worker fixture.

    Args:
        boundary: Catalog-authorized raster, native worker and artifact storage.
        store: Disposable real PostgreSQL adapter.

    Yields:
        HTTP client, worker and application service for lifecycle tests.
    """
    _, worker, _, artifacts, _ = boundary
    service = ProcessingService(store, artifacts, model_authorizer=worker.authorizer)
    app = FastAPI()
    app.include_router(create_processing_router(service))
    with TestClient(app, base_url="https://testserver") as client:
        yield client, worker, service


def model_request(
    client: TestClient, model_id: str = "raster-summary", **changes: Any
) -> dict[str, Any]:
    """Bind discovery metadata to the existing mounted-raster fixture.

    Args:
        client: Current browser-session client.
        model_id: Installed recipe to bind; defaults to the original summary model.
        changes: Explicit request replacements for a test case.

    Returns:
        Ready-to-submit path-free model request.
    """
    response = client.get("/api/processing/models")
    assert response.status_code == 200, response.text
    definition = next(
        item for item in response.json()["models"] if item["id"] == model_id
    )
    return {
        "requestId": uuid4().hex,
        "model": {
            key: definition[key] for key in ("id", "version", "definitionSha256")
        },
        "inputs": {
            "raster": SOURCE,
            "area": {"kind": "selectedArea", "selectedBounds": AREA},
        },
        "parameters": {},
        "label": "My model run",
        "utcOffsetMinutes": 0,
        **changes,
    }


def submit(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    """Submit through the actual same-origin HTTP boundary.

    Args:
        client: Authorized browser-session client.
        body: Model submission.

    Returns:
        Accepted Processing job response.
    """
    response = client.post("/api/processing/model-runs", json=body, headers=HEADERS)
    assert response.status_code == 202, response.text
    job = response.json()
    assert response.headers["location"] == f"/api/processing/jobs/{job['jobId']}"
    return job


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_renaming_preserves_execution_and_changes_only_display_names(
    model_boundary: Any,
    store: PostgresJobStore,
    monkeypatch: pytest.MonkeyPatch,
    model_id: str,
) -> None:
    """Names survive preparation and update every download without changing result bytes.

    Args:
        model_boundary: Real model HTTP, native worker and artifact storage.
        store: Disposable PostgreSQL lifecycle owner.
        monkeypatch: Rename after worker preparation but before its stale snapshot is saved.
        model_id: Table or raster model using the common naming contract.
    """
    client, worker, _ = model_boundary
    body = model_request(client, model_id, utcOffsetMinutes=-420)
    submitted = submit(client, body)
    base = f"/api/processing/jobs/{submitted['jobId']}"
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    timestamp = (
        datetime.fromisoformat(submitted["createdAt"])
        .astimezone(timezone(timedelta(minutes=-420)))
        .strftime("%Y_%m_%d_%H_%M_%S")
    )
    assert submitted["name"] == body["label"]
    assert submitted["nameTimestamp"] == timestamp
    assert submitted["label"] == f"{body['label']} · {timestamp}"
    queued = client.patch(
        base + "/name", json={"label": "Queued name"}, headers=HEADERS
    )
    assert queued.status_code == 200, queued.text
    save_prepared = store.save_prepared_job

    def rename_before_saving(
        identifier: str, attempt: str, prepared: PreparedJobPlan
    ) -> dict[str, Any]:
        """Edit a name after its original preparation snapshot has already been captured.

        Args:
            identifier: Claimed calculation identity.
            attempt: Current worker token.
            prepared: Existing calculation plan containing the worker's earlier summary.

        Returns:
            Saved calculation plan with subscriber display settings kept independently.
        """
        renamed = client.patch(
            base + "/name", json={"label": "During preparation"}, headers=HEADERS
        )
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["status"] == "running"
        return save_prepared(identifier, attempt, prepared)

    monkeypatch.setattr(store, "save_prepared_job", rename_before_saving)
    assert client.portal.call(worker.run_once)
    ready = client.get(base).json()
    assert ready["status"] == "ready", ready
    assert ready["name"] == "During preparation"
    before = store.get(submitted["jobId"], owner)
    original_files = {
        file["artifactId"]: client.get(file["url"]).content
        for file in ready["artifacts"]["files"]
    }
    original_result = client.get(base + "/result").content
    original_provenance = client.get(base + "/provenance").content
    renamed_response = client.patch(
        base + "/name", json={"label": "Café biomass / 2021"}, headers=HEADERS
    )
    assert renamed_response.status_code == 200, renamed_response.text
    renamed = renamed_response.json()
    assert renamed["name"] == "Café biomass / 2021"
    assert renamed["createdAt"] == submitted["createdAt"]
    assert renamed["nameTimestamp"] == timestamp
    assert renamed["updatedAt"] > ready["updatedAt"]
    assert submit(client, body)["name"] == renamed["name"]
    assert (
        client.get("/api/processing/model-runs").json()["jobs"][0]["name"]
        == renamed["name"]
    )
    for file in renamed["artifacts"]["files"]:
        assert file["displayName"] == f"{file['label']} · {renamed['label']}"
        assert f"_cafe-biomass-2021_{timestamp}." in file["filename"]
        download = client.get(file["url"])
        assert download.content == original_files[file["artifactId"]]
        assert (
            f'filename="{file["filename"]}"' in download.headers["content-disposition"]
        )
        assert (
            client.head(file["url"]).headers["content-disposition"]
            == download.headers["content-disposition"]
        )
        assert (
            client.get(file["url"], headers={"Range": "bytes=0-3"}).content
            == download.content[:4]
        )
    for suffix, original in (
        ("/result", original_result),
        ("/provenance", original_provenance),
    ):
        download = client.get(base + suffix)
        assert download.content == original
        assert (
            f"_cafe-biomass-2021_{timestamp}."
            in download.headers["content-disposition"]
        )
    for suffix in ("model-yaml", "run-yaml"):
        download = client.get(f"{base}/{suffix}")
        assert (
            f'filename="{suffix}_cafe-biomass-2021_{timestamp}.yaml"'
            in download.headers["content-disposition"]
        )
    assert client.get(base + "/invocation").json()["label"] == renamed["name"]
    assert (
        parse_yaml(client.get(base + "/run-yaml").content, run=True)["invocation"][
            "label"
        ]
        == renamed["name"]
    )
    after = store.get(submitted["jobId"], owner)
    for field in (
        "request_hash",
        "summary",
        "artifact",
        "retained_metadata",
        "retained_outcome",
        "created_at",
        "expires_at",
    ):
        assert after[field] == before[field]
    assert after["retained_metadata"]["invocation"]["label"] == body["label"]


def test_download_lease_keeps_readable_filename_after_result_expiry(
    model_boundary: Any, store: PostgresJobStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An acquired transfer can finish naming and reading its file after the run expires.

    Args:
        model_boundary: Real model API, worker and result storage.
        store: Disposable lifecycle store that grants the original download lease.
        monkeypatch: Pause the service's acquire boundary at an already granted lease.
    """
    client, worker, service = model_boundary
    job = submit(client, model_request(client))
    assert client.portal.call(worker.run_once)
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    row, lease = store.acquire_transfer(job["jobId"], owner)
    with psycopg.connect(store.conninfo) as connection:
        row["expires_at"] = connection.execute(
            "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s RETURNING expires_at",
            (row["job_id"],),
        ).fetchone()[0]

    def acquired_before_expiry(
        identifier: str, requesting_owner: str
    ) -> tuple[dict[str, Any], str]:
        """Return the lease already granted before result expiry.

        Args:
            identifier: Expected public model-run identity.
            requesting_owner: Original session hash.

        Returns:
            The owned result snapshot and active transfer lease.
        """
        assert identifier == job["jobId"] and requesting_owner == owner
        return row, lease

    monkeypatch.setattr(store, "acquire_transfer", acquired_before_expiry)
    try:
        download = client.portal.call(service.download, owner, job["jobId"])
        assert (
            download.filename == f"statistics_my-model-run_{job['nameTimestamp']}.csv"
        )
        assert download.path.is_file()
        assert download.lease_id == lease
    finally:
        store.transfer_heartbeat(lease, True)


@pytest.mark.parametrize(
    "rejection", ["owner", "origin", "deleted", "operation", "blank", "long", "extra"]
)
def test_model_rename_rejects_unowned_or_invalid_edits(
    model_boundary: Any, store: PostgresJobStore, rejection: str
) -> None:
    """Renaming uses the existing same-origin session and model-run ownership boundary.

    Args:
        model_boundary: Real model HTTP and worker composition.
        store: Disposable store for an unrelated operation fixture.
        rejection: Unauthorized, deleted or invalid rename request.
    """
    client, _, _ = model_boundary
    job = submit(client, model_request(client))
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    identifier = job["jobId"]
    body = {"label": "Renamed"}
    headers = HEADERS
    expected = 422
    if rejection == "owner":
        client.cookies.clear()
        expected = 404
    elif rejection == "origin":
        headers = {**HEADERS, "Origin": "https://another.example"}
        expected = 403
    elif rejection == "deleted":
        store.cancel(identifier, owner)
        store.cancel(identifier, owner, delete=True)
        expected = 409
    elif rejection == "operation":
        other = store.submit(
            owner,
            uuid4().hex,
            PreparedJobPlan({}, {}, 0, operation="test.unrelated.v1"),
            "unrelated",
        )
        identifier = other["id"]
        expected = 409
    elif rejection == "blank":
        body["label"] = " "
    elif rejection == "long":
        body["label"] = "x" * 81
    else:
        body["utcOffsetMinutes"] = 60
    response = client.patch(
        f"/api/processing/jobs/{identifier}/name", json=body, headers=headers
    )
    assert response.status_code == expected, response.text
    assert store.get(job["jobId"], owner)["presentation"] == {"utcOffsetMinutes": 0}


@pytest.mark.parametrize("state", ["cancelled", "failed", "interrupted"])
def test_terminal_model_runs_can_be_renamed(
    model_boundary: Any, store: PostgresJobStore, state: str
) -> None:
    """Editing a stopped run names its history without resuming the calculation.

    Args:
        model_boundary: Real model HTTP and worker composition.
        store: Disposable lifecycle store.
        state: Unsuccessful terminal state to preserve through renaming.
    """
    client, worker, _ = model_boundary
    job = submit(client, model_request(client))
    base = f"/api/processing/jobs/{job['jobId']}"
    if state == "cancelled":
        client.post(base + "/cancel", headers=HEADERS)
    elif state == "interrupted":
        store.interrupt_unfinished_jobs_on_restart()
    else:
        claimed = store.claim_next_job()
        assert store.finish(
            claimed["id"],
            claimed["attempt_id"],
            None,
            {"code": "test", "detail": "Test failure"},
        )
    response = client.patch(
        base + "/name", json={"label": "Stopped test"}, headers=HEADERS
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == state
    assert response.json()["name"] == "Stopped test"
    assert not client.portal.call(worker.run_once)


def test_model_executes_real_summary_and_exports_without_installed_definition(
    model_boundary: Any, store: Any
) -> None:
    """Produce the same scalar values as the existing aggregate and retain YAML.

    Args:
        model_boundary: Composed Models API and native worker.
        store: Real job store used for lifecycle assertions.
    """
    client, worker, service = model_boundary
    body = model_request(client)
    job = submit(client, body)
    identifier = job["jobId"]
    assert job["operation"] == "model.run.v1" and job["metadataExpiresAt"] is None
    recipe = client.get(f"/api/processing/jobs/{identifier}/model-yaml")
    assert recipe.status_code == 200
    definition = ModelDefinition.model_validate(parse_yaml(recipe.content))
    assert definition.digest == body["model"]["definitionSha256"]
    pending = client.get(f"/api/processing/jobs/{identifier}/run-yaml")
    captured = parse_yaml(pending.content, run=True)
    invocation_response = client.get(f"/api/processing/jobs/{identifier}/invocation")
    assert invocation_response.status_code == 200
    assert invocation_response.json() == captured["invocation"]
    assert "no-store" in invocation_response.headers["cache-control"]
    assert "source_path" not in invocation_response.text
    assert captured["invocation"]["parameters"] == {"summary": "sum(a)"}
    assert captured["execution"]["state"] == "pending"
    assert "grid" not in captured["execution"]
    assert "source_path" not in pending.text and "://" not in pending.text
    service.model_registry = ModelRegistry(())
    assert submit(client, body)["jobId"] == identifier
    assert (
        client.get(
            "/api/processing/models/raster-summary/versions/1.1.0/yaml"
        ).status_code
        == 404
    )
    assert (
        client.get(f"/api/processing/jobs/{identifier}/model-yaml").content
        == recipe.content
    )
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{identifier}").json()
    assert ready["status"] == "ready", ready
    assert ready["metadataExpiresAt"] is not None
    result = client.get(ready["result"]["url"])
    assert result.status_code == 200 and "My model run" in result.text
    assert client.get(ready["result"]["provenanceUrl"]).status_code == 200
    assert hashlib.sha256(result.content).hexdigest() == ready["result"]["sha256"]
    exported = parse_yaml(
        client.get(f"/api/processing/jobs/{identifier}/run-yaml").content, run=True
    )
    RunDocument.model_validate(exported)
    assert exported["invocation"] == captured["invocation"]
    assert exported["execution"]["state"] == "prepared"
    assert exported["execution"]["sources"] == captured["execution"]["sources"]
    assert exported["execution"]["outcome"]["status"] == "ready"
    assert exported["execution"]["outcome"]["statistics"] == ready["result"]["rows"]
    aggregate = client.post(
        "/api/processing/raster-calculations",
        headers=HEADERS,
        json={
            "requestId": uuid4().hex,
            "sources": {"a": SOURCE},
            "selectedBounds": AREA,
            "calculations": [{"label": "My model run", "expression": "sum(a)"}],
        },
    )
    assert aggregate.status_code == 202, aggregate.text
    assert client.portal.call(worker.run_once)
    legacy = client.get(f"/api/processing/jobs/{aggregate.json()['jobId']}").json()
    assert legacy["result"]["rows"] == ready["result"]["rows"]
    assert exported["execution"]["grid"] == legacy["grid"]
    assert [
        item["operation"] for item in client.get("/api/processing/jobs").json()["jobs"]
    ] == ["raster.aggregate.v1"]
    mixed = client.post(
        "/api/processing/jobs/status",
        headers=HEADERS,
        json={"jobIds": [identifier, legacy["jobId"]]},
    )
    assert mixed.status_code == 200, mixed.text
    assert [item["operation"] for item in mixed.json()["jobs"]] == [
        "model.run.v1",
        "raster.aggregate.v1",
    ]


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_owner_idempotency_pagination_and_cancel(
    model_boundary: Any, store: Any, model_id: str
) -> None:
    """Model history remains owned and independent of more than 50 later jobs.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
        model_boundary: HTTP and native worker fixture.
        store: Real storage for opaque unrelated-job fixtures.
    """
    client, worker, _ = model_boundary
    first_body = model_request(client, model_id)
    first = submit(client, first_body)
    assert submit(client, first_body)["jobId"] == first["jobId"]
    conflict = client.post(
        "/api/processing/model-runs",
        headers=HEADERS,
        json={**first_body, "label": "Changed"},
    )
    assert conflict.status_code == 409
    second = submit(client, model_request(client, model_id, label="Second"))
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    for index in range(55):
        unrelated = store.submit(
            owner,
            uuid4().hex,
            PreparedJobPlan({}, {}, 0, operation="test.unrelated.v1"),
            str(index),
        )
        store.cancel(unrelated["id"], owner)
    page = client.get("/api/processing/model-runs?limit=1").json()
    assert [job["jobId"] for job in page["jobs"]] == [second["jobId"]]
    last = client.get(
        "/api/processing/model-runs", params={"limit": 1, "cursor": page["nextCursor"]}
    ).json()
    assert [job["jobId"] for job in last["jobs"]] == [first["jobId"]]
    assert last["nextCursor"] is None
    assert client.get("/api/processing/model-runs?cursor=bad!").status_code == 422
    assert client.get("/api/processing/model-runs?limit=101").status_code == 422
    with TestClient(client.app, base_url="https://testserver") as stranger:
        assert (
            stranger.get(f"/api/processing/jobs/{first['jobId']}/run-yaml").status_code
            == 404
        )
        assert (
            stranger.get(
                f"/api/processing/jobs/{first['jobId']}/invocation"
            ).status_code
            == 404
        )
        assert stranger.get("/api/processing/model-runs").json()["jobs"] == []
        assert (
            stranger.get(
                "/api/processing/model-runs", params={"cursor": page["nextCursor"]}
            ).json()["jobs"]
            == []
        )
    cancelled = client.post(
        f"/api/processing/jobs/{first['jobId']}/cancel", headers=HEADERS
    )
    assert cancelled.status_code == 202 and cancelled.json()["status"] == "cancelled"
    assert (
        client.get(f"/api/processing/jobs/{first['jobId']}/run-yaml").status_code == 200
    )
    assert client.portal.call(worker.run_once)
    assert (
        client.get(f"/api/processing/jobs/{second['jobId']}").json()["status"]
        == "ready"
    )


def test_model_history_pages_through_more_than_fifty_runs(model_boundary: Any) -> None:
    """Retrieve every retained model run when the session has more than 50.

    Args:
        model_boundary: Model HTTP service and its real PostgreSQL store.
    """
    client, _, _ = model_boundary
    template = model_request(client)
    submitted = []
    for index in range(55):
        job = submit(
            client,
            {**template, "requestId": uuid4().hex, "label": f"Run {index}"},
        )
        submitted.append(job["jobId"])
        # Keep the queue allowance available without deleting history.
        response = client.post(
            f"/api/processing/jobs/{job['jobId']}/cancel", headers=HEADERS
        )
        assert response.status_code == 202, response.text

    collected = []
    cursor = None
    for expected_size in (20, 20, 15):
        params = {"limit": 20}
        if cursor is not None:
            params["cursor"] = cursor
        response = client.get("/api/processing/model-runs", params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        assert len(page["jobs"]) == expected_size
        collected.extend(job["jobId"] for job in page["jobs"])
        cursor = page["nextCursor"]
    assert cursor is None
    assert collected == list(reversed(submitted))


@pytest.mark.parametrize("terminal", ["ready", "interrupted", "cancelled", "failed"])
@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_capture_survives_cleanup_then_expires(
    model_boundary: Any, store: Any, terminal: str, model_id: str
) -> None:
    """Retention starts at the first terminal transition, independent of cleanup.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
        model_boundary: Model application and worker.
        store: Real PostgreSQL adapter.
        terminal: Completion or termination path under test.
    """
    client, worker, _ = model_boundary
    job = submit(client, model_request(client, model_id))
    identifier = job["jobId"]
    if terminal == "ready":
        assert client.portal.call(worker.run_once)
    elif terminal == "interrupted":
        assert store.interrupt_unfinished_jobs_on_restart() == 1
    elif terminal == "cancelled":
        client.post(f"/api/processing/jobs/{identifier}/cancel", headers=HEADERS)
    else:
        claimed = store.claim_next_job()
        assert store.finish(
            claimed["id"],
            claimed["attempt_id"],
            None,
            {"code": "fixture_failure", "detail": "Sanitized fixture failure."},
        )
    initial = client.get(f"/api/processing/jobs/{identifier}").json()
    deadline = initial["metadataExpiresAt"]
    assert initial["status"] == terminal and deadline is not None
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
            (identifier,),
        )
    for candidate in store.cleanup_candidates():
        if candidate["attempt_id"]:
            worker.artifacts.remove(candidate["attempt_id"])
        store.cleaned(candidate["id"])
    exported = client.get(f"/api/processing/jobs/{identifier}/run-yaml")
    assert exported.status_code == 200, exported.text
    assert (
        client.get(f"/api/processing/jobs/{identifier}/invocation").status_code == 200
    )
    document = parse_yaml(exported.content, run=True)
    assert document["execution"]["outcome"]["status"] == terminal
    assert (
        client.get(f"/api/processing/jobs/{identifier}").json()["metadataExpiresAt"]
        == deadline
    )
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute(
                "SELECT spec,retained_metadata FROM processing.jobs WHERE id=%s",
                (identifier,),
            ).fetchone()[0]
            is None
        )
        connection.execute(
            "UPDATE processing.jobs SET metadata_expires_at=now()-interval '1 second' WHERE id=%s",
            (identifier,),
        )
    assert client.get(f"/api/processing/jobs/{identifier}/run-yaml").status_code == 410
    assert (
        client.get(f"/api/processing/jobs/{identifier}/invocation").status_code == 410
    )
    store.cleanup_candidates()
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT retained_metadata,retained_outcome FROM processing.jobs WHERE id=%s",
            (identifier,),
        ).fetchone() == (None, None)


@pytest.mark.parametrize("retention_seconds", [3600, 14 * 86_400])
def test_model_metadata_keeps_the_retention_chosen_at_submission(
    model_boundary: Any, store: Any, retention_seconds: int
) -> None:
    """Keep model details for seven days or a longer configured lifetime.

    Args:
        model_boundary: Model HTTP service and its worker.
        store: Real job storage with replaceable deployment limits.
        retention_seconds: A shorter or longer lifetime than the seven-day default.
    """
    client, _, _ = model_boundary
    store.limits = replace(store.limits, metadata_ttl_seconds=retention_seconds)
    job = submit(client, model_request(client))
    identifier = job["jobId"]
    # A deployment setting changed while this job waits must not alter its promise.
    store.limits = replace(store.limits, metadata_ttl_seconds=2 * 86_400)
    with psycopg.connect(store.conninfo) as connection:
        before = connection.execute("SELECT clock_timestamp()").fetchone()[0]
    cancelled = client.post(
        f"/api/processing/jobs/{identifier}/cancel", headers=HEADERS
    )
    assert cancelled.status_code == 202, cancelled.text
    with psycopg.connect(store.conninfo) as connection:
        after = connection.execute("SELECT clock_timestamp()").fetchone()[0]
    deadline = datetime.fromisoformat(cancelled.json()["metadataExpiresAt"])
    effective_seconds = max(retention_seconds, 7 * 86_400)
    assert before + timedelta(seconds=effective_seconds) <= deadline
    assert deadline <= after + timedelta(seconds=effective_seconds)
    store.cleaned(identifier)
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET updated_at=now()-interval '8 days' WHERE id=%s",
            (identifier,),
        )
    store.cleanup_candidates()
    assert client.get(f"/api/processing/jobs/{identifier}/run-yaml").status_code == 200
    assert (
        client.get(f"/api/processing/jobs/{identifier}").json()["metadataExpiresAt"]
        == cancelled.json()["metadataExpiresAt"]
    )
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET metadata_expires_at=now()-interval '1 second' WHERE id=%s",
            (identifier,),
        )
    store.cleanup_candidates()
    assert client.get(f"/api/processing/jobs/{identifier}").status_code == 404


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_delete_revokes_exports_and_retry_recovers_after_input_loss(
    model_boundary: Any, store: Any, model_id: str
) -> None:
    """Deleting a terminal run revokes its exports while preserving retry tombstones.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
        model_boundary: Composed HTTP and native worker.
        store: Real owned job storage.
    """
    client, worker, service = model_boundary
    body = model_request(client, model_id)
    job = submit(client, body)
    identifier = job["jobId"]
    service.model_authorizer = None
    assert submit(client, body)["jobId"] == identifier
    assert client.portal.call(worker.run_once)
    response = client.delete(f"/api/processing/jobs/{identifier}", headers=HEADERS)
    assert response.status_code == 200, response.text
    assert (
        client.get(f"/api/processing/jobs/{identifier}/model-yaml").status_code == 410
    )
    assert client.get(f"/api/processing/jobs/{identifier}/run-yaml").status_code == 410
    assert submit(client, body)["status"] == "deleted"


def test_model_origin_size_and_metadata_limits(model_boundary: Any, store: Any) -> None:
    """Keep HTTP and retained-record limits at their owning boundaries.

    Args:
        model_boundary: Real model HTTP boundary.
        store: Real generic metadata storage boundary.
    """
    client, _, _ = model_boundary
    body = model_request(client)
    assert client.post("/api/processing/model-runs", json=body).status_code == 403
    assert (
        client.post(
            "/api/processing/model-runs",
            json=body,
            headers={**HEADERS, "Origin": "https://foreign.example"},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/processing/model-runs",
            content=b" " * 16385,
            headers={**HEADERS, "Content-Type": "application/json"},
        ).status_code
        == 413
    )
    with pytest.raises(ProcessingError, match="retained metadata"):
        store.submit(
            "fixture-owner",
            uuid4().hex,
            PreparedJobPlan(
                {}, {}, 0, retained_metadata={"oversized": "x" * (192 * 1024)}
            ),
            "fixture-request",
        )


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_vector_filter_preserves_catalog_selection(
    model_boundary: Any, boundary: Any, tmp_path: Path, model_id: str
) -> None:
    """Run with the filtered catalog descriptor and retain it in the saved inputs.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
        model_boundary: Model API and worker with the neutral selection reader.
        boundary: Existing vector-selection/catalog API fixture.
        tmp_path: Mounted fixture root.
    """
    client, worker, _ = model_boundary
    source_client = boundary[0]
    path = tmp_path / "selection.gpkg"
    write_geopackage_layer(
        path,
        "mask",
        crs="EPSG:4326",
        geometry={
            "type": "Polygon",
            "coordinates": [
                [[0.1, 9.1], [0.9, 9.1], [0.9, 9.9], [0.1, 9.9], [0.1, 9.1]]
            ],
        },
    )
    selection = register_selection(source_client, path)
    selection["filter"] = {
        "enabled": True,
        "match": "all",
        "rules": [
            {"field": "secret", "operator": "eq", "value": "must not reach browser"},
        ],
    }
    body = model_request(
        client,
        model_id,
        inputs={
            "raster": SOURCE,
            "area": {"kind": "catalogSelection", "selection": selection},
        },
    )
    job = submit(client, body)
    assert client.portal.call(worker.run_once)
    status = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert status["status"] == "ready", status
    capture = parse_yaml(
        client.get(f"/api/processing/jobs/{job['jobId']}/run-yaml").content, run=True
    )
    assert capture["invocation"]["inputs"]["area"]["selection"] == selection


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_raster_uses_authorized_catalog_source(
    model_boundary: Any, model_id: str
) -> None:
    """Resolve accepted catalog references without comparing historical fingerprints.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
        model_boundary: HTTP/worker boundary with replaceable catalog provider.
    """
    client, worker, _ = model_boundary
    job = submit(client, model_request(client, model_id))
    original = worker.authorizer

    class ChangedCatalog:
        """Represent an authoritative catalog refresh after admission."""

        async def authorize(self, source: Any) -> AuthorizedRaster:
            """Return the same authorized source with a new catalog identity.

            Args:
                source: Current catalog request.

            Returns:
                Changed catalog signature, without altering the mounted fixture.
            """
            authorized = await original.authorize(source)
            changed = replace(
                authorized.source_signature,
                size_bytes=authorized.source_signature.size_bytes + 1,
            )
            return AuthorizedRaster(authorized.source_path, changed)

    worker.authorizer = ChangedCatalog()
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready


@pytest.mark.parametrize("area_kind", ["wholeRaster", "polygonArea"])
def test_model_whole_raster_and_owned_polygon_inputs(
    model_boundary: Any,
    area_kind: str,
) -> None:
    """Use existing area contracts and preserve accepted private polygon inputs.

    Args:
        model_boundary: Real model API and worker.
        area_kind: Supported non-catalog area variant.
    """
    client, worker, _ = model_boundary
    area = {"kind": area_kind}
    if area_kind == "polygonArea":
        uploaded = client.post(
            "/api/processing/polygon-areas",
            headers=HEADERS,
            json={"polygons": [rectangle(0.1, 9.1, 0.5, 9.5)]},
        )
        assert uploaded.status_code == 200, uploaded.text
        area["reference"] = uploaded.json()["polygonArea"]
        with TestClient(client.app, base_url="https://testserver") as other:
            foreign = model_request(other, inputs={"raster": SOURCE, "area": area})
            assert (
                other.post(
                    "/api/processing/model-runs", headers=HEADERS, json=foreign
                ).status_code
                == 409
            )
    body = model_request(client, inputs={"raster": SOURCE, "area": area})
    job = submit(client, body)
    if area_kind == "polygonArea":
        assert (
            client.delete(
                f"/api/processing/polygon-areas/{area['reference']['id']}",
                headers=HEADERS,
            ).status_code
            == 200
        )
        assert submit(client, body)["jobId"] == job["jobId"]
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    export = client.get(f"/api/processing/jobs/{job['jobId']}/run-yaml")
    assert export.status_code == 200 and "coordinates:" not in export.text


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_model_navigation_progress_and_running_cancel(
    model_boundary: Any, monkeypatch: pytest.MonkeyPatch, model_id: str
) -> None:
    """Recover through a new client and cancel after the real native result is written.

    Args:
        model_id: Summary or clip recipe under the same lifecycle contract.
        model_boundary: Model API, native worker and private result storage.
        monkeypatch: Pause the native process after actual numerical execution.
    """
    client, worker, _ = model_boundary
    job = submit(client, model_request(client, model_id))
    identifier = job["jobId"]
    with TestClient(client.app, base_url="https://testserver") as reloaded:
        reloaded.cookies.update(client.cookies)
        assert (
            reloaded.get(f"/api/processing/jobs/{identifier}").json()["status"]
            == "queued"
        )
    if model_id == "raster-clip":
        (worker.artifacts.root / "pause-after-output").touch()
        monkeypatch.setattr(
            "eolab_app.processing.raster_operations.clip_process_target", _paused_clip
        )
    else:
        monkeypatch.setattr(
            "eolab_app.processing.raster_operations.aggregate_process_target",
            paused_calculation,
        )

    async def exercise() -> None:
        """Wait for the bounded child, observe its counters and explicitly cancel."""
        task = asyncio.create_task(worker.run_once())
        try:
            async with asyncio.timeout(15):
                while not list(
                    (worker.artifacts.root / "attempts").glob("*/checkpoint")
                ):
                    await asyncio.sleep(0.05)
            async with asyncio.timeout(4):
                while True:
                    state = client.get(f"/api/processing/jobs/{identifier}").json()
                    if state["progress"]["total"] is not None:
                        break
                    await asyncio.sleep(0.05)
            assert state["status"] == "running"
            assert 0 <= state["progress"]["completed"] <= state["progress"]["total"]
            assert state["progress"]["unit"] == "blocks"
            assert state["progress"]["description"] == (
                "Finishing download" if model_id == "raster-clip" else "Writing results"
            )
            stopped = client.post(
                f"/api/processing/jobs/{identifier}/cancel", headers=HEADERS
            )
            assert stopped.json()["status"] == "cancelling"
            await task
            state = client.get(f"/api/processing/jobs/{identifier}").json()
            assert state["status"] == "cancelled" and state["result"] is None
            await worker.cleanup()
            assert not list((worker.artifacts.root / "results").iterdir())
            assert not list((worker.artifacts.root / "attempts").iterdir())
            assert (
                client.get(f"/api/processing/jobs/{identifier}/run-yaml").status_code
                == 200
            )
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())


def test_duplicate_saved_model_inputs_creates_an_independent_run(
    model_boundary: Any,
) -> None:
    """Run an edited copy without changing its original inputs or summary result.

    Args:
        model_boundary: Real model HTTP, storage and native worker fixture.
    """
    client, worker, _ = model_boundary
    original = submit(client, model_request(client))
    assert client.portal.call(worker.run_once)
    identifier = original["jobId"]
    saved = client.get(f"/api/processing/jobs/{identifier}/invocation").json()
    copied = submit(
        client,
        {
            "requestId": uuid4().hex,
            "model": {
                key: saved["model"][key]
                for key in ("id", "version", "definitionSha256")
            },
            "inputs": saved["inputs"],
            "parameters": {"summary": "mean(a)"},
            "label": "Edited copy",
            "utcOffsetMinutes": 0,
        },
    )
    assert copied["jobId"] != identifier
    assert client.portal.call(worker.run_once)
    assert (
        client.get(f"/api/processing/jobs/{copied['jobId']}").json()["status"]
        == "ready"
    )
    assert client.get(f"/api/processing/jobs/{identifier}/invocation").json() == saved
    assert (
        client.get(f"/api/processing/jobs/{identifier}").json()["result"]["rows"][0][
            "expression"
        ]
        == "sum(a)"
    )


def test_clip_model_download_matches_existing_clip_and_keeps_ownership(
    model_boundary: Any, boundary: Any, store: Any
) -> None:
    """Download a real COG through Models with native values and owned transfer rules.

    Args:
        model_boundary: Real model HTTP, worker and storage composition.
        boundary: Original clip API and mounted raster fixture.
        store: PostgreSQL lifecycle storage for metadata-expiry checks.
    """
    client, worker, _ = model_boundary
    body = model_request(client, "raster-clip")
    job = submit(client, body)
    assert submit(client, body)["jobId"] == job["jobId"]
    ordinary = client.post(
        "/api/processing/raster-clips",
        json={**clip_inputs(client), "requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert ordinary.status_code == 202
    assert ordinary.json()["jobId"] != job["jobId"]
    assert client.portal.call(worker.run_once)
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    result = ready["result"]
    assert (
        result["kind"] == "raster"
        and result["mediaType"] == "image/tiff"
        and "rows" not in result
    )
    download = client.get(result["url"])
    assert (
        download.status_code == 200 and download.headers["content-type"] == "image/tiff"
    )
    assert hashlib.sha256(download.content).hexdigest() == result["sha256"]
    partial = client.get(result["url"], headers={"Range": "bytes=0-15"})
    assert partial.status_code == 206 and partial.content == download.content[:16]
    legacy = client.get(f"/api/processing/jobs/{ordinary.json()['jobId']}").json()
    assert legacy["status"] == "ready", legacy
    with (
        rasterio.MemoryFile(download.content) as file,
        file.open() as clipped,
        rasterio.MemoryFile(
            client.get(legacy["result"]["url"]).content
        ) as original_file,
        original_file.open() as original,
    ):
        assert clipped.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert clipped.transform == original.transform and clipped.crs == original.crs
        assert (
            clipped.dtypes == original.dtypes
            and clipped.scales == (2,)
            and clipped.offsets == (-1,)
        )
        numpy.testing.assert_array_equal(clipped.read(1), original.read(1))
        numpy.testing.assert_array_equal(clipped.read_masks(1), original.read_masks(1))
        assert int(numpy.count_nonzero(clipped.read_masks(1))) == result["validPixels"]
    with TestClient(client.app, base_url="https://testserver") as stranger:
        for suffix in ("", "/result", "/provenance", "/run-yaml"):
            assert (
                stranger.get(f"/api/processing/jobs/{job['jobId']}{suffix}").status_code
                == 404
            )
    run = parse_yaml(
        client.get(f"/api/processing/jobs/{job['jobId']}/run-yaml").content, run=True
    )
    RunDocument.model_validate(run)
    assert run["execution"]["grid"] == legacy["grid"]
    assert "grid" not in run["execution"]["sources"]["raster"]
    assert run["execution"]["numericalPolicy"]["numericInclusion"] == "all_touched"
    assert run["execution"]["outcome"]["raster"]["sha256"] == result["sha256"]
    assert client.get(result["provenanceUrl"]).json()["operation"] == "raster.clip.v1"
    # A shorter metadata lifetime must not break an otherwise available TIFF.
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET metadata_expires_at=now()-interval '1 second' WHERE id=%s",
            (job["jobId"],),
        )
    store.cleanup_candidates()
    assert (
        client.get(f"/api/processing/jobs/{job['jobId']}/run-yaml").status_code == 410
    )
    assert (
        client.get(f"/api/processing/jobs/{job['jobId']}").json()["result"]["kind"]
        == "raster"
    )
    assert client.get(result["url"]).status_code == 200


@pytest.mark.parametrize("model_id", ["raster-summary", "raster-clip"])
def test_new_yaml_recipe_runs_through_http_storage_and_downloads(
    model_boundary: Any, model_id: str
) -> None:
    """New recipe names and bindings require no API, worker or serializer changes.

    Args:
        model_boundary: Real catalog, HTTP, PostgreSQL and native worker composition.
        model_id: Registered operation to reuse in an unfamiliar recipe.
    """
    from model_recipe_support import custom_recipe

    client, worker, service = model_boundary
    definition = custom_recipe(model_id)
    service.model_registry = ModelRegistry((definition,))
    body = model_request(
        client,
        definition.id,
        inputs={
            "habitat": SOURCE,
            "region": {"kind": "selectedArea", "selectedBounds": AREA},
        },
    )
    job = submit(client, body)
    service.model_registry = ModelRegistry(())
    assert client.portal.call(worker.run_once)
    ready = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    result = ready["result"]
    assert result["name"] == "habitat_result" and result["label"] == "Habitat output"
    downloaded = client.get(result["url"])
    assert downloaded.status_code == 200
    assert hashlib.sha256(downloaded.content).hexdigest() == result["sha256"]
    exported = client.get(f"/api/processing/jobs/{job['jobId']}/run-yaml")
    document = RunDocument.model_validate(parse_yaml(exported.content, run=True))
    assert document.invocation.model.definition == definition
    assert document.invocation.inputs == body["inputs"]
    if model_id == "raster-summary":
        assert result["rows"][0]["expression"] == "mean(a)"
