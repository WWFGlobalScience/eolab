"""Real warm planning/execution across source identities and durable results."""

import asyncio
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import numpy as np
import rasterio

from eolab_app.processing.aggregate_models import (
    AggregatePlanRequest,
    AggregatePlanResponse,
    AggregateJobResponse,
)
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.clip_models import ClipArea, ClipSpec, RasterClipLimits
from eolab_app.processing.raster_clip import clip_process_target
from eolab_app.processing.native_processes import create_native_process
from eolab_app.processing.service import ProcessingService, public_job
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.raster.source_identity import RasterSourceIdentity
from test_raster_clips import SOURCE, write_source


def test_warm_service_and_worker_reopen_sources_and_preserve_timing(tmp_path: Path):
    """A retained interpreter must not retain another request's raster or values.

    Args:
        tmp_path: Separate synthetic sources and confined output storage.
    """

    async def scenario():
        """Plan and execute two source versions with real warm children."""
        limits = RasterClipLimits(free_space_floor=0)
        planner, executor = create_native_process(limits), create_native_process(limits)
        planner.warm()
        executor.warm()
        authorizer = SimpleNamespace(authorize=AsyncMock())
        store = Mock()
        store.finish_plan.return_value = {
            "expires_at": datetime.now(timezone.utc) + timedelta(minutes=5)
        }
        store.heartbeat.return_value = store.finish.return_value = True
        artifacts = LocalJobArtifacts(tmp_path / "artifacts")
        artifacts.initialize()
        service = ProcessingService(
            authorizer, None, store, artifacts, limits, native=planner
        )
        worker = ProcessingWorker(authorizer, store, artifacts, limits, native=executor)
        try:
            for index, number in enumerate([1, 7]):
                values = np.full((32, 32), number, dtype="int16")
                if index == 0:
                    values[0, 0] = -9999
                path = write_source(
                    tmp_path / f"source-{index}.tif",
                    values,
                    nodata=-9999 if index == 0 else None,
                )
                authorized = SimpleNamespace(
                    source_path=path, source_signature=RasterSourceIdentity.read(path)
                )
                authorizer.authorize.return_value = authorized
                identifier = str(index + 1) * 32
                store.reserve_plan.return_value = identifier
                plan = AggregatePlanResponse.model_validate(
                    await service.plan_raster_calculation(
                        "owner",
                        AggregatePlanRequest(
                            sources={"a": SOURCE},
                            wholeRaster=True,
                            calculations=[
                                {"label": "Mean", "expression": "mean(a)"},
                                {"label": "Area", "expression": "areaha(a > 0)"},
                            ],
                        ),
                    )
                )
                assert plan.timing.process.reusedProcess is bool(index)
                prepared = store.finish_plan.call_args.args[2]
                now = datetime.now(timezone.utc)
                row = dict(
                    id=identifier,
                    attempt_id=str(index + 3) * 32,
                    # Retained identity is provenance, not a worker precondition.
                    spec={**prepared.specification, "sourceSignature": [0, 0, 0, 0]},
                    reserved_bytes=prepared.reserved_bytes,
                    created_at=now,
                    updated_at=now,
                    expires_at=now + timedelta(hours=1),
                    status="running",
                    operation="raster.aggregate.v1",
                    progress={},
                    error=None,
                )
                store.claim.return_value = row
                assert await worker.run_once()
                artifact = store.finish.call_args.args[2]
                response = AggregateJobResponse.model_validate(
                    public_job(
                        {
                            **row,
                            "status": "ready",
                            "artifact": json.loads(json.dumps(asdict(artifact))),
                            "updated_at": datetime.now(timezone.utc),
                        }
                    )
                )
                assert float(response.result.rows[0].value) == number
                assert (
                    response.result.rows[0].aggregates[0]["validPixels"] == 1023 + index
                )
                assert float(response.result.rows[1].value) > 0
                timing = response.result.executionTiming
                assert timing.process.reusedProcess is bool(index)
                assert (
                    timing.process.operationSeconds
                    >= response.result.performance.kernelSeconds
                )
                assert (
                    abs(
                        timing.nativeProcessSeconds
                        - sum(
                            (
                                timing.process.readyWaitSeconds,
                                timing.process.operationSeconds,
                                timing.process.overheadSeconds,
                            )
                        )
                    )
                    < 0.1
                )
                assert str(tmp_path) not in response.model_dump_json()
            assert authorizer.authorize.await_count == 4
        finally:
            await planner.close()
            await executor.close()

    asyncio.run(scenario())


def test_warm_clip_plan_and_execution_preserve_pixels(tmp_path: Path):
    """The same lane supports clip requests without leaking native file handles.

    Args:
        tmp_path: Disposable raster and artifact directory.
    """

    async def scenario():
        """Plan then create a COG on the retained process and inspect every pixel."""
        values = np.arange(1024, dtype="int16").reshape(32, 32)
        path = write_source(tmp_path / "clip.tif", values)
        signature = tuple(RasterSourceIdentity.read(path).to_catalog())
        area = ClipArea(kind="bounds", bounds=(0, 9.68, 0.32, 10))
        limits = RasterClipLimits()
        lane = create_native_process(limits)
        output = tmp_path / "clip-output"
        output.mkdir()
        try:
            planned = await lane.run(
                clip_process_target, ("plan", (path, area, limits)), 15
            )
            assert planned.value[0] == "ok"
            spec = ClipSpec(
                source=SOURCE,
                sourceSignature=signature,
                area=area,
                grid=planned.value[1],
            )
            result = await lane.run(
                clip_process_target, ("clip", (path, spec, output, limits)), 30
            )
            assert result.value[0] == "ok"
            assert result.timing.reusedProcess
            with rasterio.open(output / "result.tif") as dataset:
                assert dataset.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
                assert np.array_equal(dataset.read(1), values)
            path.rename(tmp_path / "closed-source.tif")
        finally:
            await lane.close()

    asyncio.run(scenario())
