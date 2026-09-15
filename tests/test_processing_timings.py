"""Timing boundaries with real native children/files and isolated lifecycle ports."""

import asyncio
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import numpy as np
import pytest
from pydantic import ValidationError

from eolab_app.processing.aggregate_models import (
    AggregateExecutionTiming,
    AggregateJobResponse,
    AggregatePlanRequest,
    AggregatePlanResponse,
    AggregatePlanTiming,
)
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.service import ProcessingService, public_job
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.raster.source_identity import RasterSourceIdentity
from test_raster_clips import SOURCE, write_source


def test_real_plan_worker_and_public_result_timing(tmp_path: Path) -> None:
    """Timing crosses native execution and public serialization without private paths.

    Args:
        tmp_path: Isolated source and artifact directories.
    """
    path = write_source(tmp_path / "source.tif", np.ones((32, 32), dtype="uint16"))
    authorized = SimpleNamespace(
        source_path=path, source_signature=RasterSourceIdentity.read(path)
    )
    authorizer = SimpleNamespace(authorize=AsyncMock(return_value=authorized))
    store = Mock()
    identifier = "a" * 32
    store.reserve_plan.return_value = identifier
    store.finish_plan.return_value = {
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5)
    }
    limits = RasterClipLimits(free_space_floor=0)
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    service = ProcessingService(authorizer, None, store, artifacts, limits)
    request = AggregatePlanRequest(
        sources={"a": SOURCE},
        wholeRaster=True,
        calculations=[{"label": "Mean", "expression": "mean(a)"}],
    )
    plan = AggregatePlanResponse.model_validate(
        asyncio.run(service.plan_raster_calculation("owner", request))
    )
    assert plan.timing is not None and plan.timing.nativeProcessSeconds > 0
    prepared = store.finish_plan.call_args.args[2]
    claimed = datetime.now(timezone.utc)
    row = {
        "id": identifier,
        "attempt_id": "b" * 32,
        "spec": prepared.specification,
        "reserved_bytes": prepared.reserved_bytes,
        "created_at": claimed - timedelta(seconds=2),
        "updated_at": claimed,
        "expires_at": claimed + timedelta(hours=1),
        "status": "running",
        "operation": "raster.aggregate.v1",
        "progress": {},
        "error": None,
    }
    store.claim.return_value = row
    store.heartbeat.return_value = True
    store.finish.return_value = True
    worker = ProcessingWorker(authorizer, store, artifacts, limits)
    assert asyncio.run(worker.run_once())
    artifact = store.finish.call_args.args[2]
    assert artifact.execution_timing["queueSeconds"] == 2
    assert (
        artifact.execution_timing["nativeProcessSeconds"]
        >= artifact.performance["kernelSeconds"]
    )
    assert artifacts.result_path(row["attempt_id"], result_name="result.csv").exists()
    # Match the adapter's JSON storage, then the HTTP response model.
    ready = {
        **row,
        "status": "ready",
        "artifact": json.loads(json.dumps(asdict(artifact))),
        "updated_at": datetime.now(timezone.utc),
    }
    response = AggregateJobResponse.model_validate(public_job(ready))
    assert response.result.executionTiming.queueSeconds == 2
    assert response.result.queuedToReadySeconds >= 2
    assert float(response.result.rows[0].value) == 1
    assert str(path) not in response.model_dump_json()
    # Older workers/artifacts have no execution stage metadata.
    del ready["artifact"]["execution_timing"]
    assert (
        AggregateJobResponse.model_validate(public_job(ready)).result.executionTiming
        is None
    )
    ready["status"] = "cancelled"
    assert public_job(ready)["result"] is None


@pytest.mark.parametrize("bad", [-1, float("nan"), float("inf")])
def test_stage_contract_rejects_invalid_durations(bad: float) -> None:
    """Do not publish negative or nonfinite measurements.

    Args:
        bad: Invalid duration under test.
    """
    with pytest.raises(ValidationError):
        AggregatePlanTiming(
            reservationSeconds=bad,
            preparationSeconds=0,
            nativeProcessSeconds=0,
            finalizationSeconds=0,
        )
    with pytest.raises(ValidationError):
        AggregateExecutionTiming(
            queueSeconds=bad,
            preparationSeconds=0,
            nativeProcessSeconds=0,
            publicationSeconds=0,
        )
