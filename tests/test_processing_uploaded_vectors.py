"""Use admitted private GeoPackages across Processing HTTP, PostgreSQL and workers."""

import asyncio
from collections.abc import Iterator
from dataclasses import replace
import hashlib
from pathlib import Path
from threading import Event
from typing import Any, TypeAlias
from uuid import uuid4

import fiona
from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx2
import numpy
import pytest
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

from eolab_app.catalog.geopackage import build_stac_items
from eolab_app.catalog_selection import VectorSelection
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.clip_models import ClipInputs, ClipJobRequest, UnpreparedClip
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing import model_definitions, model_operations
from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.native_processes import create_native_process
from eolab_app.processing.models import JobSubmission, PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext
from eolab_app.processing.service import ProcessingService
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.raster.catalog import StacRasterCatalog
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_authorization import CatalogRasterSourceAuthorizer
from eolab_app.raster.sources import MountedRasterResolver
from eolab_app.routes.processing import COOKIE, create_processing_router
from eolab_app.routes.browser_identity import COOKIE as UPLOAD_COOKIE
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from eolab_app.vector.catalog import StacVectorCatalog
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.sources import MountedVectorResolver
from eolab_app.vector_uploads import VectorUploadStore
from app_support import mounted_geotiff_item
from test_model_runs_postgres import downstream_boundary, model_request
from test_processing_jobs import HEADERS, _paused_clip, store
from raster_source_support import SOURCE
from raster_fixture_support import write_source
from test_vector_uploads import HEADERS as UPLOAD_HEADERS, write_layer

UploadBoundary: TypeAlias = tuple[
    TestClient, ProcessingWorker, ProcessingService, VectorUploadStore, dict[str, Any]
]


@pytest.fixture
def upload_boundary(
    tmp_path: Path, store: PostgresJobStore
) -> Iterator[UploadBoundary]:
    """Compose real private uploads and Processing without a map or GeoServer.

    Args:
        tmp_path: Isolated raster, upload and result files.
        store: Explicit disposable PostgreSQL database.

    Yields:
        Owner browser, native worker, application service, upload store and selection.
    """
    original = tmp_path / "polygons.gpkg"
    write_layer(original, geometry="MultiPolygon")
    with fiona.open(original, "a", layer="areas") as dataset:
        dataset.write(
            {
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [
                        [[(6000, 0), (7000, 0), (7000, 1000), (6000, 1000), (6000, 0)]]
                    ],
                },
                "properties": {"label": "Forest", "count": 14, "weight": 5.5},
            }
        )
    values = numpy.full((40, 280), 7, dtype="int16")
    values[26:30, 10:14] = 997  # Inside the polygon hole.
    values[:, 119:162] = 11  # The selected feature's separate second polygon.
    values[:, 239:] = 23  # A different feature, excluded by its attribute filter.
    path = write_source(
        tmp_path / "values.tif",
        values,
        transform=from_origin(0, 1000, 25, 25),
        crs="EPSG:3857",
    )
    item = mounted_geotiff_item(path.as_uri())
    vector_item = build_stac_items(tmp_path, original)[0]

    def catalog_request(request: httpx2.Request) -> httpx2.Response:
        """Serve scanner-built raster and vector Items for the mounted fixture files.

        Args:
            request: Catalog HTTP request from the real raster authorizer.

        Returns:
            Scanner-produced metadata for the requested mounted raster or vector.
        """
        assert request.url.host == "catalog"
        if request.url.path.endswith(f"/items/{vector_item['id']}"):
            return httpx2.Response(200, json=vector_item)
        assert request.url.path.endswith(f"/items/{SOURCE['itemId']}")
        return httpx2.Response(200, json=item)

    catalog = httpx2.AsyncClient(transport=httpx2.MockTransport(catalog_request))
    uploads = VectorUploadStore(tmp_path / "uploads", None)
    reader = VectorSamplingService(
        StacVectorCatalog(catalog, "http://catalog"),
        MountedVectorResolver(tmp_path),
        uploads=uploads,
    )
    authorizer = CatalogRasterSourceAuthorizer(
        StacRasterCatalog(catalog, "http://catalog"), MountedRasterResolver(tmp_path)
    )
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    native = create_native_process(store.limits)
    worker = ProcessingWorker(
        authorizer,
        store,
        artifacts,
        store.limits,
        areas=reader,
        uploads=uploads,
        native=native,
    )
    service = ProcessingService(
        store,
        artifacts,
        model_authorizer=authorizer,
        areas=reader,
        uploads=uploads,
    )
    app = FastAPI()
    app.state.vector_item = vector_item
    app.include_router(create_vector_uploads_router(uploads))
    app.include_router(create_processing_router(service))
    with TestClient(app, base_url="https://testserver") as owner:
        response = owner.post(
            "/api/vector-uploads",
            params={"name": "Private wetlands"},
            headers=UPLOAD_HEADERS,
            content=original.read_bytes(),
        )
        assert response.status_code == 201, response.text
        selection = {
            "uploadId": response.json()["id"],
            "layerName": "areas",
            "filter": {
                "enabled": True,
                "match": "all",
                "rules": [{"field": "count", "operator": "eq", "value": 7}],
            },
        }
        try:
            yield owner, worker, service, uploads, selection
        finally:
            owner.portal.call(native.close)
            owner.portal.call(catalog.aclose)


def processing_request(
    owner: TestClient, selection: dict[str, Any], operation: str
) -> tuple[str, dict[str, Any]]:
    """Build an ordinary clip, calculation or model request using an uploaded area.

    Args:
        owner: Browser used for installed-model discovery.
        selection: Path-free private vector and attribute predicate.
        operation: Clip, summary, model-clip or model-summary.

    Returns:
        HTTP endpoint and complete request, including its retry identifier.
    """
    if operation.startswith("model-"):
        model_id = "raster-" + operation.removeprefix("model-")
        return "/api/processing/model-runs", model_request(
            owner,
            model_id,
            inputs={
                "raster": SOURCE,
                "area": {"kind": "catalogSelection", "selection": selection},
            },
            parameters=(
                {"summary": "min(a) + max(a)"} if model_id == "raster-summary" else {}
            ),
        )
    if operation == "clip":
        return "/api/processing/raster-clips", {
            **SOURCE,
            "catalogSelection": selection,
            "requestId": uuid4().hex,
        }
    return "/api/processing/raster-calculations", {
        "sources": {"a": SOURCE},
        "catalogSelection": selection,
        "calculations": [{"label": "Range sum", "expression": "min(a) + max(a)"}],
        "requestId": uuid4().hex,
    }


class ClipWithReferenceRequest(ClipJobRequest):
    """Add an independent reference selection to the fixture's ordinary clip request."""

    catalogSelection: VectorSelection
    reference_sites: VectorSelection


class QueuedClipWithReference(UnpreparedClip):
    """Persist both fixture selections until the worker prepares the clip."""

    request: ClipWithReferenceRequest


@pytest.fixture
def reference_clip(
    upload_boundary: UploadBoundary, monkeypatch: pytest.MonkeyPatch
) -> dict[str, list[int]]:
    """Install a fixture recipe that reads two selections before ordinary clipping.

    Args:
        upload_boundary: Actual upload, HTTP, PostgreSQL and worker components.
        monkeypatch: Restore the installed operation and recipe after this test.

    Returns:
        Feature attribute values read independently for each named input by the worker.
    """
    _, _, service, _, _ = upload_boundary
    document = service.model_registry.get("raster-clip", "1.1.0").to_document()
    original = model_operations.get_model_operation("raster.clip.v1")
    observed: dict[str, list[int]] = {}

    def bind_reference_clip(
        inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
    ) -> ClipWithReferenceRequest:
        """Bind the fixture's independent reference sites alongside its clip area.

        Args:
            inputs: Raster, clip area and reference-site area from the model request.
            parameters: Ordinary clip parameters.
            request_id: Browser retry identifier.
            label: Requested run label.

        Returns:
            Clip request carrying both validated vector descriptors.

        Raises:
            ValueError: If either input is not a vector selection.
        """
        request = original.bind(inputs, parameters, request_id, label)
        return ClipWithReferenceRequest(
            **request.model_dump(by_alias=True),
            reference_sites=inputs["reference_sites"]["selection"],
        )

    def queue_reference_clip(
        request: ClipWithReferenceRequest, polygons: None
    ) -> PreparedJobPlan:
        """Save both vector descriptors with the ordinary queued clip plan.

        Args:
            request: Fixture request with independently named selections.
            polygons: Unused owned-polygon input, as required by ordinary clipping.

        Returns:
            Queued plan whose persisted request retains both selections.
        """
        clip = ClipJobRequest.model_validate(
            request.model_dump(exclude={"reference_sites"}, by_alias=True)
        )
        return replace(
            original.queue(clip, polygons),
            specification=QueuedClipWithReference(request=request).model_dump(
                mode="json", by_alias=True
            ),
        )

    async def prepare_reference_clip(
        context: OperationContext,
        queued: QueuedClipWithReference,
        authorized: AuthorizedRaster,
    ) -> PreparedJobPlan:
        """Read each persisted selection's exact features, then prepare the clip.

        Args:
            context: Real worker capabilities, including its retained vector reader.
            queued: Both descriptors restored from the database.
            authorized: Ordinary raster authorization for this worker attempt.

        Returns:
            Native clip plan prepared by the existing operation.

        Raises:
            SelectionUnavailableError: If a saved vector selection cannot be read.
            ProcessingError: If ordinary clip preparation fails.
        """
        assert context.areas is not None
        for name, selection in operation.vector_selections(queued.request).items():
            resolved = await context.areas.resolve_for_sampling(selection)
            with fiona.open(resolved.path, layer=selection.layerName) as dataset:
                observed[name] = [
                    feature["properties"]["count"]
                    for feature in dataset.filter(where=resolved.where)
                ]
        clip = ClipInputs.model_validate(
            queued.request.model_dump(
                exclude={"reference_sites", "requestId"}, by_alias=True
            )
        )
        return await original.prepare(context, UnpreparedClip(request=clip), authorized)

    operation = replace(
        original,
        inputs=(*original.inputs, ("reference_sites", "clip_area")),
        queued_type=QueuedClipWithReference,
        bind=bind_reference_clip,
        queue=queue_reference_clip,
        prepare=prepare_reference_clip,
        vector_selections=lambda request: {
            "area": request.catalogSelection,
            "reference_sites": request.reference_sites,
        },
    )
    operations = {**model_operations.OPERATIONS, operation.id: operation}
    monkeypatch.setattr(model_operations, "OPERATIONS", operations)
    monkeypatch.setattr(model_definitions, "OPERATIONS", operations)
    document["id"] = "reference-clip"
    document["inputs"]["reference_sites"] = {
        "type": "clip_area",
        "label": "Reference sites",
    }
    document["steps"][0]["inputs"]["reference_sites"] = {"input": "reference_sites"}
    registry = ModelRegistry((ModelDefinition.model_validate(document),))
    service.model_registry = registry
    monkeypatch.setattr(
        ModelRegistry, "load_installed", classmethod(lambda cls: registry)
    )
    return observed


@pytest.mark.parametrize("reference_source", ["upload", "catalog", "same_upload"])
def test_model_keeps_independent_vector_inputs_after_upload_deletion(
    upload_boundary: UploadBoundary,
    reference_clip: dict[str, list[int]],
    store: PostgresJobStore,
    reference_source: str,
) -> None:
    """Restore each selected predicate through the ordinary worker after upload deletion.

    Args:
        upload_boundary: Real upload, HTTP, PostgreSQL and native worker boundary.
        reference_clip: Attribute values read by the fixture operation during preparation.
        store: Disposable database retaining all accepted upload identities.
        reference_source: A second upload, a mounted vector or the first upload again.
    """
    owner, worker, service, uploads, selection = upload_boundary
    reference = {
        **selection,
        "filter": {
            "enabled": True,
            "match": "all",
            "rules": [{"field": "count", "operator": "eq", "value": 14}],
        },
    }
    if reference_source == "upload":
        reference_path = uploads.root.parent / "reference_sites.gpkg"
        write_layer(reference_path, geometry="MultiPolygon")
        with fiona.open(reference_path, layer="areas") as dataset:
            geometry = next(iter(dataset)).geometry
        with fiona.open(reference_path, "a", layer="areas") as dataset:
            dataset.write(
                {
                    "geometry": geometry,
                    "properties": {
                        "label": "Reference sites",
                        "count": 28,
                        "weight": 1.0,
                    },
                }
            )
        response = owner.post(
            "/api/vector-uploads",
            params={"name": "Reference sites"},
            headers=UPLOAD_HEADERS,
            content=reference_path.read_bytes(),
        )
        assert response.status_code == 201, response.text
        reference["uploadId"] = response.json()["id"]
        reference["filter"]["rules"][0]["value"] = 28
    elif reference_source == "catalog":
        item = owner.app.state.vector_item
        reference.pop("uploadId")
        reference.update(
            collectionId=item["collection"], itemId=item["id"], assetKey="data"
        )
    body = model_request(
        owner,
        "reference-clip",
        inputs={
            "raster": SOURCE,
            "area": {"kind": "catalogSelection", "selection": selection},
            "reference_sites": {"kind": "catalogSelection", "selection": reference},
        },
    )
    response = owner.post("/api/processing/model-runs", json=body, headers=HEADERS)
    assert response.status_code == 202, response.text
    job = response.json()
    tokens = store.active_input_uploads()
    upload_ids = {
        value["uploadId"] for value in (selection, reference) if "uploadId" in value
    }
    assert len(tokens) == len(upload_ids)
    assert len(list(uploads.root.glob(".retained/*.gpkg"))) == len(tokens)
    retained = [uploads.get_retained_source(token) for token in tokens]
    for upload_id in upload_ids:
        assert (
            owner.delete(
                f"/api/vector-uploads/{upload_id}", headers=UPLOAD_HEADERS
            ).status_code
            == 204
        )
    owner.portal.call(service.reconcile_upload_inputs)
    assert all(path.is_file() for path in retained)
    restarted = ProcessingWorker(
        worker.authorizer,
        store,
        worker.artifacts,
        store.limits,
        areas=worker.areas,
        uploads=VectorUploadStore(uploads.root, None),
        native=worker.native,
    )
    assert owner.portal.call(restarted.run_once)
    ready = owner.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    assert reference_clip == {
        "area": [7],
        "reference_sites": [28 if reference_source == "upload" else 14],
    }
    invocation = owner.get(f"/api/processing/jobs/{job['jobId']}/invocation").json()
    assert invocation["inputs"] == body["inputs"]
    assert str(uploads.root) not in str(invocation)
    assert not any(token in str(invocation) for token in tokens)
    owner.portal.call(service.reconcile_upload_inputs)
    assert not store.active_input_uploads()
    assert all(not path.exists() for path in retained)


@pytest.mark.parametrize("rejection", ["foreign_upload", "invalid_filter"])
def test_second_vector_input_rejection_releases_unused_retention(
    upload_boundary: UploadBoundary,
    reference_clip: dict[str, list[int]],
    store: PostgresJobStore,
    rejection: str,
) -> None:
    """Reject the whole run when its second input is inaccessible or has an invalid filter.

    Args:
        upload_boundary: Real upload and Processing submission components.
        reference_clip: Fixture recipe that declares two independent selections.
        store: Disposable job store used to verify that rejection admits no uploads.
        rejection: Foreign upload or invalid second predicate on the first upload.
    """
    owner, _, service, uploads, selection = upload_boundary
    reference = dict(selection)
    if rejection == "foreign_upload":
        with TestClient(owner.app, base_url="https://testserver") as other:
            response = other.post(
                "/api/vector-uploads",
                params={"name": "Other browser's sites"},
                headers=UPLOAD_HEADERS,
                content=(uploads.root.parent / "polygons.gpkg").read_bytes(),
            )
            assert response.status_code == 201, response.text
            reference["uploadId"] = response.json()["id"]
    else:
        reference["filter"] = {
            "enabled": True,
            "match": "all",
            "rules": [{"field": "nonexistent", "operator": "eq", "value": 7}],
        }
    body = model_request(
        owner,
        "reference-clip",
        inputs={
            "raster": SOURCE,
            "area": {"kind": "catalogSelection", "selection": selection},
            "reference_sites": {"kind": "catalogSelection", "selection": reference},
        },
    )
    response = owner.post("/api/processing/model-runs", json=body, headers=HEADERS)
    assert response.status_code == (
        404 if rejection == "foreign_upload" else 409
    ), response.text
    assert not reference_clip
    assert not store.active_input_uploads()
    retained = list(uploads.root.glob(".retained/*.gpkg"))
    assert len(retained) == 1
    owner.portal.call(service.reconcile_upload_inputs)
    assert all(not path.exists() for path in retained)


@pytest.mark.parametrize(
    "operation", ["clip", "summary", "model-clip", "model-summary"]
)
def test_accepted_upload_survives_deletion_and_worker_restart(
    upload_boundary: UploadBoundary,
    store: PostgresJobStore,
    operation: str,
) -> None:
    """Retain exact filtered polygons for accepted work without granting new access.

    Args:
        upload_boundary: Actual upload, HTTP and native Processing components.
        store: Disposable durable job database.
        operation: Public submission contract exercised with the same polygons.
    """
    owner, worker, service, uploads, selection = upload_boundary
    endpoint, body = processing_request(owner, selection, operation)
    with TestClient(owner.app, base_url="https://testserver") as other:
        denied = other.post(endpoint, json=body, headers=HEADERS)
        assert denied.status_code == 404, denied.text
    response = owner.post(endpoint, json=body, headers=HEADERS)
    assert response.status_code == 202, response.text
    job = response.json()
    (token,) = store.active_input_uploads()
    retained = uploads.get_retained_source(token)
    assert retained.is_file()
    assert token not in response.text and str(uploads.root) not in response.text
    assert (
        owner.delete(
            f"/api/vector-uploads/{selection['uploadId']}",
            headers=UPLOAD_HEADERS,
        ).status_code
        == 204
    )
    assert (
        owner.post(endpoint, json=body, headers=HEADERS).json()["jobId"] == job["jobId"]
    )
    rejected = owner.post(
        endpoint, json={**body, "requestId": uuid4().hex}, headers=HEADERS
    )
    assert rejected.status_code == 404, rejected.text
    owner.portal.call(service.reconcile_upload_inputs)
    assert retained.is_file()
    restarted = ProcessingWorker(
        worker.authorizer,
        store,
        worker.artifacts,
        store.limits,
        areas=worker.areas,
        uploads=VectorUploadStore(uploads.root, None),
        native=worker.native,
    )
    assert owner.portal.call(restarted.run_once)
    ready = owner.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert ready["status"] == "ready", ready
    if operation.endswith("clip"):
        url = ready["result"]["url"]
        if operation.startswith("model-"):
            url = next(
                file["url"]
                for file in ready["artifacts"]["files"]
                if file["mediaType"] == "image/tiff"
            )
        with MemoryFile(owner.get(url).content) as memory, memory.open() as clipped:
            pixels = clipped.read(1, masked=True)
            assert set(numpy.unique(pixels.compressed())) == {7, 11}
            assert pixels.mask[clipped.index(300, 300)]
            assert pixels[clipped.index(500, 500)] == 7
            assert pixels[clipped.index(3500, 500)] == 11
    else:
        assert float(ready["result"]["rows"][0]["value"]) == 18
    assert not store.active_input_uploads()
    owner.portal.call(service.reconcile_upload_inputs)
    assert not retained.exists()
    assert (
        owner.post(endpoint, json=body, headers=HEADERS).json()["jobId"] == job["jobId"]
    )


def test_batch_keeps_accepted_upload_and_rejects_foreign_neighbor(
    upload_boundary: UploadBoundary,
    store: PostgresJobStore,
) -> None:
    """Authorize each batch item without preventing valid neighbors from running.

    Args:
        upload_boundary: Actual private upload and Processing components.
        store: Disposable job database containing the accepted batch.
    """
    owner, worker, service, uploads, selection = upload_boundary
    endpoint, body = processing_request(owner, selection, "summary")
    missing = {**selection, "uploadId": str(uuid4())}
    response = owner.post(
        endpoint + "/batch",
        headers=HEADERS,
        json={
            "items": [
                body,
                {**body, "requestId": uuid4().hex, "catalogSelection": missing},
            ]
        },
    )
    assert response.status_code == 200, response.text
    accepted, denied = response.json()["items"]
    assert denied["error"]["status"] == 404
    assert accepted["job"]["status"] == "queued"
    assert len(store.active_input_uploads()) == 1
    assert (
        owner.delete(
            f"/api/vector-uploads/{selection['uploadId']}", headers=UPLOAD_HEADERS
        ).status_code
        == 204
    )
    assert owner.portal.call(worker.run_once)
    ready = owner.get(f"/api/processing/jobs/{accepted['job']['jobId']}").json()
    assert ready["status"] == "ready", ready
    assert float(ready["result"]["rows"][0]["value"]) == 18
    owner.portal.call(service.reconcile_upload_inputs)
    assert not store.active_input_uploads()


def test_cancelled_admission_blocks_cleanup_until_database_commit(
    upload_boundary: UploadBoundary,
    store: PostgresJobStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Finish an interrupted admission before cleanup decides which links are unused.

    Args:
        upload_boundary: Real upload and Processing API composition.
        store: Durable job database, paused immediately before its transaction.
        monkeypatch: Add test checkpoints without replacing storage behavior.
    """
    owner, worker, service, uploads, selection = upload_boundary
    _, body = processing_request(owner, selection, "clip")
    assert owner.get("/api/processing/jobs").status_code == 200
    processing_owner = hashlib.sha256(owner.cookies[COOKIE].encode()).hexdigest()
    upload_owner = hashlib.sha256(owner.cookies[UPLOAD_COOKIE].encode()).hexdigest()
    reached, release, cleanup_started = Event(), Event(), Event()
    tokens: list[str] = []
    retain = uploads.retain_source
    submit_batch = store.submit_batch

    def record_retention(path: Path) -> str:
        """Record the real file token before admission reaches its database checkpoint.

        Args:
            path: Already authorized original GeoPackage.

        Returns:
            Real retained-source token.
        """
        token = retain(path)
        tokens.append(token)
        return token

    def pause_admission(
        owner_hash: str, submissions: list[JobSubmission]
    ) -> list[dict[str, Any] | ProcessingError]:
        """Pause at the database boundary, then execute the actual admission transaction.

        Args:
            owner_hash: Processing session owning these requests.
            submissions: Retained inputs ready for durable admission.

        Returns:
            Real job rows or per-item errors.
        """
        reached.set()
        assert release.wait(10)
        return submit_batch(owner_hash, submissions)

    async def admit() -> dict[str, Any]:
        """Submit the validated request using the actual browser identities."""
        return await service.submit_raster_clip(
            processing_owner,
            ClipJobRequest.model_validate(body),
            upload_owner=upload_owner,
        )

    async def reconcile() -> None:
        """Mark cleanup's attempt before it waits on the admission lock."""
        cleanup_started.set()
        await service.reconcile_upload_inputs()

    monkeypatch.setattr(uploads, "retain_source", record_retention)
    monkeypatch.setattr(store, "submit_batch", pause_admission)
    admission = owner.portal.start_task_soon(admit)
    try:
        assert reached.wait(10)
        retained = uploads.get_retained_source(tokens[0])
        assert not store.active_input_uploads()
        admission.cancel()
        cleanup = owner.portal.start_task_soon(reconcile)
        assert cleanup_started.wait(10)
        assert not cleanup.done()
        assert retained.is_file()
    finally:
        release.set()
    cleanup.result(timeout=10)
    accepted = store.find_request(processing_owner, body["requestId"])
    assert accepted["status"] == "queued"
    assert retained.is_file()
    assert owner.portal.call(worker.run_once)
    owner.portal.call(service.reconcile_upload_inputs)
    assert not retained.exists()


def test_cancellation_keeps_upload_until_native_exit(
    upload_boundary: UploadBoundary,
    store: PostgresJobStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep a cancelled worker's source available until its native process exits.

    Args:
        upload_boundary: Real HTTP, uploads, native worker and files.
        store: PostgreSQL lifecycle owner.
        monkeypatch: Pause only the existing native clip target.
    """
    owner, worker, service, uploads, selection = upload_boundary
    endpoint, body = processing_request(owner, selection, "clip")
    job = owner.post(endpoint, json=body, headers=HEADERS).json()
    (token,) = store.active_input_uploads()
    retained = uploads.get_retained_source(token)
    assert (
        owner.delete(
            f"/api/vector-uploads/{selection['uploadId']}", headers=UPLOAD_HEADERS
        ).status_code
        == 204
    )
    monkeypatch.setattr(
        "eolab_app.processing.raster_operations.clip_process_target", _paused_clip
    )
    worker.native = (
        None  # The paused test target uses the ordinary one-shot supervisor.
    )

    async def exercise() -> None:
        """Cancel at the native checkpoint and reconcile while the job still owns files."""
        running = asyncio.create_task(worker.run_once())
        try:
            async with asyncio.timeout(10):
                while not list(
                    (worker.artifacts.root / "attempts").glob("*/checkpoint")
                ):
                    await asyncio.sleep(0.02)
            # The store transition is the same boundary used by the HTTP cancel route.
            processing_owner = hashlib.sha256(
                owner.cookies[COOKIE].encode()
            ).hexdigest()
            assert (
                store.cancel(job["jobId"], processing_owner)["status"] == "cancelling"
            )
            await service.reconcile_upload_inputs()
            assert retained.is_file()
            assert token in store.active_input_uploads()
            assert await running
            await service.reconcile_upload_inputs()
            assert not retained.exists()
        finally:
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)

    owner.portal.call(exercise)
    assert (
        owner.get(f"/api/processing/jobs/{job['jobId']}").json()["status"]
        == "cancelled"
    )


def test_downstream_reads_retained_uploaded_starting_mask(
    downstream_boundary: Any,
    store: PostgresJobStore,
    tmp_path: Path,
) -> None:
    """Route downstream from the uploaded filtered basin after its original is deleted.

    Args:
        downstream_boundary: Existing real hydrology, catalog and native worker fixture.
        store: Disposable job database.
        tmp_path: Private upload volume for the browser's copy of the basin polygons.
    """
    discovery, existing_worker, request, _, sources = downstream_boundary
    uploads = VectorUploadStore(tmp_path / "uploads", None)
    reader = VectorSamplingService(
        existing_worker.areas.catalog,
        existing_worker.areas.resolver,
        uploads=uploads,
    )
    documents = discovery.get("/api/processing/models").json()["models"]
    definitions = []
    for document in documents:
        document.pop("definitionSha256")
        definitions.append(ModelDefinition.model_validate(document))
    service = ProcessingService(
        store,
        existing_worker.artifacts,
        model_authorizer=existing_worker.authorizer,
        model_registry=ModelRegistry(tuple(definitions)),
        areas=reader,
        uploads=uploads,
    )
    worker = ProcessingWorker(
        existing_worker.authorizer,
        store,
        existing_worker.artifacts,
        store.limits,
        areas=reader,
        uploads=uploads,
        native=existing_worker.native,
    )
    app = FastAPI()
    app.include_router(create_vector_uploads_router(uploads))
    app.include_router(create_processing_router(service))
    with TestClient(app, base_url="https://testserver") as owner:
        uploaded = owner.post(
            "/api/vector-uploads",
            params={"name": "My starting basins"},
            headers=UPLOAD_HEADERS,
            content=sources.network.path.read_bytes(),
        )
        assert uploaded.status_code == 201, uploaded.text
        selection = {
            "uploadId": uploaded.json()["id"],
            "layerName": uploaded.json()["layer_name"],
            "filter": {
                "enabled": True,
                "match": "all",
                "rules": [{"field": "id", "operator": "eq", "value": 1}],
            },
        }
        body = model_request(
            owner,
            "downstream-beneficiaries",
            inputs={
                "starting_mask": {"kind": "catalogSelection", "selection": selection},
                "values": request.values.model_dump(by_alias=True),
            },
            parameters={
                "buffer_m": 0,
                "wgs84_pixel_size": 1,
                "travel_time_pixel_size_m": 100000,
            },
        )
        response = owner.post("/api/processing/model-runs", json=body, headers=HEADERS)
        assert response.status_code == 202, response.text
        job = response.json()
        assert (
            owner.delete(
                f"/api/vector-uploads/{selection['uploadId']}", headers=UPLOAD_HEADERS
            ).status_code
            == 204
        )
        assert owner.portal.call(worker.run_once)
        ready = owner.get(f"/api/processing/jobs/{job['jobId']}").json()
        assert ready["status"] == "ready", ready
        assert float(ready["result"]["rows"][0]["value"]) == 24
        mask = next(
            file
            for file in ready["artifacts"]["files"]
            if file["name"] == "starting_mask"
        )
        with (
            MemoryFile(owner.get(mask["url"]).content) as memory,
            memory.open() as dataset,
        ):
            assert numpy.count_nonzero(dataset.read(1) == 1) == 8
        saved = owner.get(f"/api/processing/jobs/{job['jobId']}/invocation")
        assert saved.json()["inputs"]["starting_mask"]["selection"] == selection
        assert str(uploads.root) not in saved.text
        owner.portal.call(service.reconcile_upload_inputs)
        assert not store.active_input_uploads()
