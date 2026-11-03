"""Real native execution, result files and public serialization across lifecycle ports."""

import asyncio
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import numpy as np
import pytest
import rasterio

from eolab_app.processing.aggregate_models import (
    AggregateJobResponse,
    AggregatePlanRequest,
    AggregateSpec,
    UnpreparedCalculation,
)
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.service import serialize_processing_job
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.raster.source_identity import RasterSourceIdentity
from raster_source_support import SOURCE
from raster_fixture_support import write_source


def test_real_plan_worker_and_public_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Native execution trusts catalog metadata and returns path-free durable results.

    Args:
        tmp_path: Isolated source and artifact directories.
        monkeypatch: Reject runtime attempts to recapture catalog file identity.
    """
    path = write_source(tmp_path / "source.tif", np.ones((32, 32), dtype="uint16"))
    authorized = SimpleNamespace(
        source_path=path, source_signature=RasterSourceIdentity.read(path)
    )
    monkeypatch.setattr(
        RasterSourceIdentity,
        "read",
        Mock(side_effect=AssertionError("Catalog files are immutable")),
    )
    authorizer = SimpleNamespace(authorize=AsyncMock(return_value=authorized))
    store = Mock()
    store.get_cached_calculation_results.return_value = {}
    identifier = "a" * 32
    limits = RasterClipLimits()
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    request = AggregatePlanRequest(
        sources={"a": SOURCE},
        wholeRaster=True,
        calculations=[{"label": "Mean", "expression": "mean(a)"}],
    )
    queued = UnpreparedCalculation(request=request)
    operation = get_model_operation(queued.operation)
    assert operation.parse_specification(queued) is queued
    claimed = datetime.now(timezone.utc)
    row = {
        "id": identifier,
        "input_uploads": {},
        "attempt_id": "b" * 32,
        "spec": queued.model_dump(mode="json", by_alias=True),
        "reserved_bytes": 0,
        "created_at": claimed - timedelta(seconds=2),
        "updated_at": claimed,
        "expires_at": claimed + timedelta(hours=1),
        "status": "running",
        "operation": "raster.aggregate.v1",
        "progress": {},
        "error": None,
    }
    configure_prepared_job_store(store, row)
    store.claim_next_job.return_value = row
    store.heartbeat.return_value = True
    store.finish.return_value = True
    worker = ProcessingWorker(authorizer, store, artifacts, limits)
    assert asyncio.run(worker.run_once())
    prepared = AggregateSpec.model_validate(row["spec"])
    assert operation.parse_specification(prepared) is prepared
    authorizer.authorize.assert_awaited_once_with(request.sources["a"])
    artifact = store.finish.call_args.args[2]
    assert artifacts.result_path(row["attempt_id"], result_name="result.csv").exists()
    # Match the adapter's JSON storage, then the HTTP response model.
    ready = {
        **row,
        "status": "ready",
        "artifact": json.loads(json.dumps(asdict(artifact))),
        "updated_at": datetime.now(timezone.utc),
    }
    response = AggregateJobResponse.model_validate(serialize_processing_job(ready))
    assert float(response.result.rows[0].value) == 1
    assert str(path) not in response.model_dump_json()
    ready["status"] = "cancelled"
    assert serialize_processing_job(ready)["result"] is None


def configure_prepared_job_store(store: Mock, row: dict[str, Any]) -> None:
    """Record worker preparation on the claimed fixture job.

    Args:
        store: Isolated lifecycle port; SQL fencing is tested with PostgreSQL.
        row: Mutable job that will receive prepared inputs and disk reservation.
    """

    def save(identifier: str, attempt: str, prepared: Any) -> dict[str, Any]:
        """Return the fields a successful storage reservation publishes.

        Args:
            identifier: Claimed job ID.
            attempt: Current attempt ID.
            prepared: Validated specification, summary and disk reservation.

        Returns:
            Updated job row for execution.
        """
        return {
            **row,
            "spec": prepared.specification,
            "summary": prepared.summary,
            "reserved_bytes": prepared.reserved_bytes,
            "retained_metadata": prepared.retained_metadata,
        }

    store.save_prepared_job.side_effect = save


@pytest.mark.parametrize(
    "model_id,custom",
    [
        ("raster-summary", False),
        ("raster-summary", True),
        ("raster-clip", False),
        ("raster-clip", True),
        ("raster-clip", "multiple"),
    ],
)
def test_model_worker_executes_native_results_and_exports_yaml(
    tmp_path: Path, model_id: str, custom: bool | str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Model dispatch reuses native operations and preserves typed result/YAML contracts.

    Args:
        tmp_path: Private source and output fixtures.
        model_id: Installed summary or clip operation under the model lifecycle.
        custom: Exercise renamed recipe bindings; "multiple" also produces extra files.
        monkeypatch: Scoped operation replacement for the multi-file fixture.
    """
    from eolab_app.processing.model_definitions import ModelRegistry
    from eolab_app.processing.model_run_contracts import (
        ModelJobResponse,
        ModelRunRequest,
        RunDocument,
    )
    from eolab_app.processing.model_runs import (
        build_model_calculation_request,
        build_model_job_submission,
        export_model_job_yaml,
    )
    from eolab_app.processing.model_yaml import parse_yaml
    from eolab_app.processing.model_operations import get_model_operation
    from model_recipe_support import custom_recipe, multiple_output_recipe
    from test_model_artifacts_postgres import multiple_files_target

    values = np.arange(1024, dtype="int16").reshape(32, 32)
    path = write_source(tmp_path / "source.tif", values)
    signature = RasterSourceIdentity.read(path)
    authorizer = SimpleNamespace(
        authorize=AsyncMock(
            return_value=SimpleNamespace(source_path=path, source_signature=signature)
        )
    )
    registry = ModelRegistry.load_installed()
    definition = registry.get(model_id, "1.1.0")
    if custom:
        definition = (
            multiple_output_recipe(monkeypatch)
            if custom == "multiple"
            else custom_recipe(model_id)
        )
        registry = ModelRegistry((definition,))
        if custom == "multiple":
            monkeypatch.setattr(
                "eolab_app.processing.raster_operations.clip_process_target",
                multiple_files_target,
            )
    request = ModelRunRequest(
        utcOffsetMinutes=0,
        model={
            "id": definition.id,
            "version": "1.1.0",
            "definitionSha256": definition.digest,
        },
        requestId="a" * 32,
        label="Native model fixture",
        inputs={
            "habitat" if custom else "raster": SOURCE,
            "region" if custom else "area": {
                "kind": "selectedArea",
                "selectedBounds": {
                    "west": 0.05,
                    "south": 9.8,
                    "east": 0.2,
                    "north": 9.95,
                },
            },
        },
    )
    calculation, invocation = build_model_calculation_request(request, registry)
    operation = get_model_operation(definition.steps[0].operation)
    prepared = build_model_job_submission(
        operation.queue(calculation, None),
        invocation,
        tuple(signature.to_catalog()),
    )
    now = datetime.now(timezone.utc)
    row = {
        "id": "a" * 32,
        "input_uploads": {},
        "attempt_id": "b" * 32,
        "spec": prepared.specification,
        "summary": prepared.summary,
        "retained_metadata": prepared.retained_metadata,
        "reserved_bytes": 0,
        "created_at": now,
        "updated_at": now,
        "expires_at": now + timedelta(hours=1),
        "status": "running",
        "operation": "model.run.v1",
        "presentation": {"utcOffsetMinutes": 0},
        "progress": {},
        "error": None,
    }
    store = Mock()
    configure_prepared_job_store(store, row)
    store.claim_next_job.return_value = row
    store.heartbeat.return_value = True
    store.finish.return_value = True
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    worker = ProcessingWorker(authorizer, store, artifacts, RasterClipLimits())
    assert asyncio.run(worker.run_once())
    artifact = store.finish.call_args.args[2]
    assert artifact is not None, store.finish.call_args
    ready = {
        **row,
        "status": "ready",
        "artifact": asdict(artifact),
        "retained_outcome": {"status": "ready", "artifact": asdict(artifact)},
        # The owned SQL view exposes the public summary, never worker inputs.
        "spec": row["summary"],
    }
    response = ModelJobResponse.model_validate(serialize_processing_job(ready))
    document = RunDocument.model_validate(
        parse_yaml(export_model_job_yaml(ready, run=True), run=True)
    )
    assert document.execution.limits.model_dump() == {"resultTtlSeconds": 86_400}
    store.get_cached_calculation_results.assert_not_called()
    if custom == "multiple":
        assert {file.name for file in response.artifacts.files} == {
            "habitat_result",
            "inspected_coverage",
            "habitat_totals",
            "provenance",
        }
        directory = artifacts.result_path(row["attempt_id"]).parent
        assert response.artifacts.totalBytes == sum(
            file.stat().st_size for file in directory.iterdir()
        )
        assert not (directory / "scratch.bin").exists()
        with rasterio.open(directory / "coverage.tif") as coverage:
            assert coverage.dtypes == ("uint8",) and np.all(coverage.read(1) <= 1)
        assert (directory / "totals.csv").read_text().startswith("sum\n")
        assert len(document.execution.outcome.artifacts) == 4
    if custom:
        assert response.result.name == "habitat_result"
        assert response.result.label == "Habitat output"
        assert document.invocation.inputs == request.inputs
        if model_id == "raster-summary":
            assert response.result.rows[0].expression == "mean(a)"
    assert document.execution.numericalPolicy.version == definition.steps[0].operation
    if model_id == "raster-clip":
        assert response.result.kind == "raster" and response.result.validPixels > 0
        with rasterio.open(artifacts.result_path(row["attempt_id"])) as output:
            assert output.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
            assert output.scales == (2,) and output.offsets == (-1,)
            assert output.dtypes == ("int16",) and output.crs.to_epsg() == 4326
            x, y, width, height = row["spec"]["calculation"]["grid"]["window"]
            mask = output.read_masks(1) > 0
            np.testing.assert_array_equal(
                output.read(1)[mask], values[y : y + height, x : x + width][mask]
            )
        assert document.execution.outcome.raster.sha256 == artifact.sha256
        assert "temporalCoverage" not in response.model_dump(mode="json")["result"]
        ready["retained_metadata"] = None
        assert (
            ModelJobResponse.model_validate(serialize_processing_job(ready)).result.kind
            == "raster"
        )
    else:
        assert response.result.rows and document.execution.outcome.statistics
    # Result names and labels outlive captured YAML metadata.
    ready["retained_metadata"] = None
    assert (
        ModelJobResponse.model_validate(serialize_processing_job(ready)).result
        == response.result
    )
