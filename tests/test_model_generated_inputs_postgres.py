"""Run a registered raster-generating model without a pre-existing primary raster."""

from dataclasses import replace
import hashlib
from pathlib import Path
from typing import Any, Literal
from unittest.mock import AsyncMock

import fiona
from fastapi.testclient import TestClient
import numpy
from pydantic import BaseModel, TypeAdapter
import pytest
import rasterio

from eolab_app.catalog_selection import VectorSelection
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing import model_definitions, model_operations
from eolab_app.processing.clip_models import ClipArtifact, ClipGrid
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_run_contracts import RunDocument
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.models import PreparedJobPlan
from eolab_app.processing.operation_context import OperationContext
from eolab_app.raster.source_models import RasterSourceReference
from test_model_runs_postgres import model_request, submit
from test_processing_jobs import HEADERS, store
from test_processing_private_inputs_postgres import input_counts, publish_input
from test_processing_uploaded_vectors import UploadBoundary, upload_boundary
from raster_fixture_support import write_source
from test_vector_uploads import HEADERS as UPLOAD_HEADERS


class GeneratedRasterInputs(BaseModel):
    """Optional comparison raster and reference sites for a generated test raster."""

    comparison: RasterSourceReference | None = None
    references: VectorSelection | None = None


class QueuedGeneratedRaster(BaseModel):
    """Save optional inputs before the worker creates the output grid."""

    operation: Literal["test.generate.v1"] = "test.generate.v1"
    request: GeneratedRasterInputs


class GeneratedRasterPlan(GeneratedRasterInputs):
    """Keep the output grid, optional sources and selected reference count."""

    operation: Literal["test.generate.v1"] = "test.generate.v1"
    grid: ClipGrid
    reference_count: int


class GeneratedRasterPolicy(BaseModel):
    """Identify the test calculation recorded in the completed Run YAML."""

    version: Literal["test.generate.v1"] = "test.generate.v1"


def generate_raster_target(
    writer: ProcessResultWriter, action: str, arguments: tuple[Any, ...]
) -> None:
    """Write a one-pixel raster using any retained comparison source.

    Args:
        writer: Native worker result transport.
        action: Registered generation action.
        arguments: Authorized optional paths, prepared plan, workspace and limits.
    """
    paths, plan, directory, _ = arguments
    value = 42 + plan.reference_count
    for path in paths.values():
        with rasterio.open(path) as raster:
            value += int(raster.read(1, window=((0, 1), (0, 1)))[0, 0])
    path = write_source(directory / "result.tif", numpy.array([[value]], dtype="int16"))
    data = path.read_bytes()
    (directory / "provenance.json").write_text("{}", encoding="utf-8")
    writer.put(
        ("ok", ClipArtifact(len(data), hashlib.sha256(data).hexdigest(), path.name, 1))
    )


@pytest.fixture
def generated_raster_model(
    upload_boundary: UploadBoundary, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Register a test-only generator using the ordinary model and worker contracts.

    Args:
        upload_boundary: Real HTTP, upload storage, PostgreSQL and native worker.
        monkeypatch: Restore operation registration after the test.
    """
    _, worker, service, _, _ = upload_boundary
    monkeypatch.setattr(
        worker.native, "targets", (*worker.native.targets, generate_raster_target)
    )
    original = model_operations.get_model_operation("raster.clip.v1")

    async def prepare_generation(
        context: OperationContext, queued: QueuedGeneratedRaster, primary: None
    ) -> PreparedJobPlan:
        """Read retained reference features and create the generated raster's grid.

        Args:
            context: Attempt capabilities, including retained vector access.
            queued: Optional source descriptors restored from PostgreSQL.
            primary: No primary raster, as declared by this operation.

        Returns:
            Prepared grid and optional input descriptors for native generation.
        """
        assert primary is None
        count = 0
        if queued.request.references is not None:
            resolved = await context.areas.resolve_for_sampling(
                queued.request.references
            )
            with fiona.open(
                resolved.path, layer=resolved.selection.layerName
            ) as dataset:
                count = len(list(dataset.filter(where=resolved.where)))
        plan = GeneratedRasterPlan(
            **queued.request.model_dump(by_alias=True),
            grid=ClipGrid(
                crs="EPSG:4326",
                transform=(0.01, 0, 0, 0, -0.01, 10),
                window=(0, 0, 1, 1),
                width=1,
                height=1,
                dtype="int16",
                nodata=None,
                nativeBlocks=1,
                estimatedRawBytes=2,
            ),
            reference_count=count,
        )
        return PreparedJobPlan(
            plan.model_dump(mode="json", by_alias=True), {}, 0, plan.operation
        )

    async def generation_inputs(
        context: OperationContext, plan: GeneratedRasterPlan, primary: None
    ) -> tuple[dict[str, Path], GeneratedRasterPlan]:
        """Pass authorized optional raster paths to the native process.

        Args:
            context: Attempt capabilities with independently retained raster inputs.
            plan: Prepared generation settings.
            primary: No primary raster, as declared by this operation.

        Returns:
            Optional raster paths and the unchanged prepared plan.
        """
        assert primary is None
        return {
            name: raster.source_path for name, raster in context.rasters.items()
        }, plan

    def comparison_sources(
        value: GeneratedRasterInputs | QueuedGeneratedRaster | GeneratedRasterPlan,
    ) -> dict[str, RasterSourceReference]:
        """Return the optional comparison raster for admission and worker access.

        Args:
            value: Bound request, queued request or prepared plan.

        Returns:
            The named comparison source, or no sources when it was omitted.
        """
        inputs = value.request if isinstance(value, QueuedGeneratedRaster) else value
        return (
            {"comparison": inputs.comparison} if inputs.comparison is not None else {}
        )

    operation = replace(
        original,
        id="test.generate.v1",
        inputs=(("comparison", "optional_raster"), ("references", "optional_vector")),
        input_adapters=(
            ("optional_raster", TypeAdapter(RasterSourceReference | None)),
            ("optional_vector", TypeAdapter(VectorSelection | None)),
        ),
        queued_type=QueuedGeneratedRaster,
        prepared_type=GeneratedRasterPlan,
        policy_type=GeneratedRasterPolicy,
        bind=lambda inputs, parameters, request_id, label: GeneratedRasterInputs(
            **inputs
        ),
        source=None,
        primary_input=None,
        polygon_inputs=lambda request: {},
        vector_selections=lambda request: (
            {"references": request.references} if request.references is not None else {}
        ),
        extra_sources=comparison_sources,
        queue=lambda request, polygons: PreparedJobPlan(
            QueuedGeneratedRaster(request=request).model_dump(
                mode="json", by_alias=True
            ),
            {},
            0,
            "test.generate.v1",
        ),
        prepare=prepare_generation,
        execution_inputs=generation_inputs,
        execution=lambda plan, context: (
            generate_raster_target,
            "generate",
            context.limits,
        ),
        policy=lambda plan: GeneratedRasterPolicy(),
    )
    operations = {**model_operations.OPERATIONS, operation.id: operation}
    monkeypatch.setattr(model_operations, "OPERATIONS", operations)
    monkeypatch.setattr(model_definitions, "OPERATIONS", operations)
    document = service.model_registry.get("raster-clip", "1.1.0").to_document()
    document["id"] = "generated-raster"
    document["inputs"] = {
        name: {"type": kind, "label": name} for name, kind in operation.inputs
    }
    document["steps"][0].update(
        operation=operation.id,
        inputs={name: {"input": name} for name, _ in operation.inputs},
    )
    installed = service.model_registry
    service.model_registry = ModelRegistry(
        (
            *(
                installed.get(item["id"], item["version"])
                for item in installed.list_models()
            ),
            ModelDefinition.model_validate(document),
        )
    )


@pytest.mark.parametrize("private_inputs", [False, True])
def test_generated_raster_publishes_without_a_primary_source(
    upload_boundary: UploadBoundary,
    generated_raster_model: None,
    store: PostgresJobStore,
    monkeypatch: pytest.MonkeyPatch,
    private_inputs: bool,
) -> None:
    """Publish a generated raster, retaining any optional inputs after deletion.

    Args:
        upload_boundary: Actual model, worker, source and artifact boundaries.
        generated_raster_model: Registered raster-generating operation.
        store: Disposable PostgreSQL input-retention authority.
        monkeypatch: Detect any accidental primary-source authorization.
        private_inputs: Include an owned raster result and uploaded reference sites.
    """
    client, worker, service, uploads, selection = upload_boundary
    inputs: dict[str, Any] = {"comparison": None, "references": None}
    expected = 42
    if private_inputs:
        parent, source, path = publish_input(
            upload_boundary[:3], {"kind": "catalogSelection", "selection": selection}
        )
        inputs = {"comparison": source, "references": selection}
        with rasterio.open(path) as raster:
            expected += int(raster.read(1)[0, 0]) + 1
    authorize = AsyncMock(side_effect=AssertionError("No primary source exists"))
    monkeypatch.setattr(worker.authorizer, "authorize", authorize)
    job = submit(client, model_request(client, "generated-raster", inputs=inputs))
    assert input_counts(store) == (int(private_inputs), 0)
    assert len(store.active_input_uploads()) == int(private_inputs)
    if private_inputs:
        client.delete(
            f"/api/processing/jobs/{parent['jobId']}", headers=HEADERS
        ).raise_for_status()
        client.delete(
            f"/api/vector-uploads/{selection['uploadId']}", headers=UPLOAD_HEADERS
        ).raise_for_status()
        client.portal.call(worker.cleanup)
        assert path.exists()
    url = f"/api/processing/jobs/{job['jobId']}"
    pending = parse_yaml(client.get(url + "/run-yaml").content, run=True)
    assert pending["execution"]["sources"] == {}
    assert client.portal.call(worker.run_once)
    ready = client.get(url).json()
    assert ready["status"] == "ready", ready
    with rasterio.MemoryFile(client.get(ready["result"]["url"]).content) as memory:
        with memory.open() as raster:
            assert raster.read(1).tolist() == [[expected]]
    exported = parse_yaml(client.get(url + "/run-yaml").content, run=True)
    RunDocument.model_validate(exported)
    assert exported["execution"]["sources"] == {}
    assert exported["execution"]["grid"]["width"] == 1
    assert exported["execution"]["outcome"]["status"] == "ready"
    assert exported["invocation"]["inputs"] == inputs
    if private_inputs:
        assert set(exported["execution"]["additionalSources"]) == {"comparison"}
    assert input_counts(store) == (0, 0)
    assert not store.active_input_uploads()
    client.portal.call(service.reconcile_upload_inputs)
    assert not list(uploads.root.glob(".retained/*.gpkg"))
    authorize.assert_not_called()


@pytest.mark.parametrize("input_kind", ["raster", "vector"])
def test_generated_raster_rejects_another_browsers_input(
    upload_boundary: UploadBoundary,
    generated_raster_model: None,
    store: PostgresJobStore,
    input_kind: str,
) -> None:
    """Keep private-input ownership checks when no primary source is declared.

    Args:
        upload_boundary: Actual model, worker, upload and artifact boundaries.
        generated_raster_model: Registered raster-generating operation.
        store: Disposable PostgreSQL input-retention authority.
        input_kind: Private optional input owned by a different browser.
    """
    client, _, _, _, selection = upload_boundary
    inputs: dict[str, Any] = {"comparison": None, "references": None}
    if input_kind == "raster":
        _, inputs["comparison"], _ = publish_input(
            upload_boundary[:3], {"kind": "catalogSelection", "selection": selection}
        )
    else:
        inputs["references"] = selection
    with TestClient(client.app, base_url="https://testserver") as other:
        body = model_request(other, "generated-raster", inputs=inputs)
        response = other.post("/api/processing/model-runs", json=body, headers=HEADERS)
        assert response.status_code == 404, response.text
    assert input_counts(store) == (0, 0)
    assert not store.active_input_uploads()
