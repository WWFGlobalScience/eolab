"""Prepare shared Habitat inputs through the worker and reuse them in model runs."""

import asyncio
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import time
from types import SimpleNamespace
from typing import Any, Literal
from unittest.mock import AsyncMock, Mock

import pytest
from shapely.geometry import box, mapping

from catalog_selection_support import write_selection
from eolab_app.attribute_filter import VectorFilter
from eolab_app.bounded_vector import summary_process
from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.execution.reusable_process import ReusableProcess
from eolab_app.processing import habitat_operation, habitat_preparation
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.habitat_calculation import HabitatSources
from eolab_app.processing.habitat_earth_engine import (
    HabitatEarthEngineRuntime,
    HabitatEarthEngineSettings,
)
from eolab_app.processing.habitat_preparation import (
    build_habitat_input_preparation_submission,
    habitat_input_preparation_process_target,
    prepare_habitat_input_cache,
)
from eolab_app.processing.habitat_preparation_models import (
    OPERATION,
    HabitatInputPreparationRequest,
    HabitatInputPreparationSpec,
    QueuedHabitatInputPreparation,
)
from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.model_run_contracts import ModelRunRequest
from eolab_app.processing.model_runs import (
    build_model_calculation_request,
    build_model_job_submission,
)
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.worker import ProcessingWorker
from test_habitat_earth_engine import _use_offline_earth_engine
from test_habitat_earth_engine_model import (
    _fixture_configuration,
    _fixture_native_target,
    _tile_response,
)
from test_habitat_model import habitat_definition
from test_processing_worker_results import configure_prepared_job_store


def _preparation_fixture_target(
    writer: ProcessResultWriter,
    action: Literal["acquire"],
    arguments: tuple[HabitatSources, HabitatInputPreparationSpec, Path, None],
) -> None:
    """Run real acquisition with controlled Earth Engine responses in its child.

    Args:
        writer: Actual supervisor result channel.
        action: Registered acquisition action.
        arguments: Authorized sources, captured inputs and private attempt directory.
    """
    root = arguments[2].parents[2]
    received = 0

    def record_response() -> None:
        """Count actual pixel requests and optionally block the second download."""
        nonlocal received
        received += 1
        with (root / "pixel-requests.txt").open("a", encoding="utf-8") as stream:
            stream.write("computePixels\n")
        if received == 2 and (root / "cancel-download").exists():
            (root / "download-blocked").touch()
            time.sleep(60)

    responses = [
        ({"status": "200"}, _tile_response(column, row))
        for row in range(2)
        for column in range(3)
    ]
    if (root / "fail-download").exists():
        responses[1] = (
            {"status": "403"},
            '{"error":{"code":403,"message":"private-remote-error"}}',
        )
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(habitat_preparation, "load_habitat_stack", _fixture_configuration)
        _use_offline_earth_engine(
            patch, responses, before_pixel_response=record_response
        )
        habitat_input_preparation_process_target(writer, action, arguments)


def _claimed_job(plan: PreparedJobPlan, number: int) -> dict[str, Any]:
    """Create the ordinary claimed-row fields supplied by durable job storage.

    Args:
        plan: Real operation submission or captured model invocation.
        number: Distinct fixture identifier for this job and attempt.

    Returns:
        Worker-facing row whose preparation is recorded by the existing store fake.
    """
    now = datetime.now(timezone.utc)
    return {
        "id": f"{number:032x}",
        "attempt_id": f"{number + 100:032x}",
        "input_uploads": {},
        "operation": plan.operation,
        "spec": plan.specification,
        "summary": plan.summary,
        "retained_metadata": plan.retained_metadata,
        "presentation": plan.presentation,
        "reserved_bytes": 0,
        "created_at": now,
        "updated_at": now,
        "expires_at": now + timedelta(hours=1),
        "status": "running",
        "progress": {},
        "error": None,
    }


def _consumer_run_plan(
    definition: ModelDefinition,
    area: ResolvedCatalogSelection,
    references: ResolvedCatalogSelection,
) -> PreparedJobPlan:
    """Capture an ordinary Habitat model run consuming the prepared scientific tiles.

    Args:
        definition: Existing small-fixture Habitat recipe.
        area: Original Catalog area also used by acquisition.
        references: Independent reference polygons needed only by model fitting.

    Returns:
        Ordinary model job submission without a preparation-specific rendering path.
    """
    request = ModelRunRequest(
        requestId="prepared-habitat-consumer",
        label="Prepared Habitat inputs",
        utcOffsetMinutes=0,
        model={
            "id": definition.id,
            "version": definition.version,
            "definitionSha256": definition.digest,
        },
        inputs={
            "stack": {"kind": "earthEngine", "year": 2018},
            "area": {
                "kind": "catalogSelection",
                "selection": area.selection.model_dump(mode="json", by_alias=True),
            },
            "references": {
                "kind": "vector",
                "selection": references.selection.model_dump(
                    mode="json", by_alias=True
                ),
            },
            "habitat_mask": None,
            "preparation": {
                "crs": "EPSG:6933",
                "pixelSize": [1000, 1000],
                "origin": [0, 0],
                "resampling": {},
            },
        },
        parameters={},
    )
    calculation, invocation = build_model_calculation_request(
        request, ModelRegistry((definition,))
    )
    operation = get_model_operation("habitat.condition.v1")
    return build_model_job_submission(
        operation.queue(calculation, None), invocation, None, {}
    )


@pytest.mark.parametrize("outcome", ["ready", "cancelled", "failed"])
def test_preparation_worker_publishes_reports_and_preserves_shared_tiles(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    habitat_definition: ModelDefinition,
    outcome: str,
) -> None:
    """Acquire once, reuse in a model, or retain completed tiles after interruption.

    Args:
        tmp_path: Separate source, cache and ordinary worker storage.
        monkeypatch: Bind controlled pixel transport at the native target boundary.
        habitat_definition: Existing recipe configured for small scientific fixtures.
        outcome: Complete acquisition, cancel a blocking request or fail its second tile.
    """
    area = write_selection(
        tmp_path / "areas.gpkg",
        [mapping(box(0, 0, 24000, 16000)), mapping(box(40000, 0, 48000, 8000))],
        crs="EPSG:6933",
        values=[1, 2],
        candidate=VectorFilter(
            rules=[{"field": "selected", "operator": "eq", "value": 1}]
        ),
    )
    references = write_selection(
        tmp_path / "references.gpkg",
        [mapping(box(-2000, 10000, 26000, 18000))],
        crs="EPSG:6933",
    )
    selected = {value.selection.item_id: value for value in (area, references)}
    request = HabitatInputPreparationRequest(
        requestId="prepare-habitat-fixture",
        name="Selected landscape",
        selection=area.selection,
        year=2018,
    )
    monkeypatch.setattr(
        habitat_preparation, "load_habitat_stack", _fixture_configuration
    )
    plan = build_habitat_input_preparation_submission(request)
    captured = {
        "name": request.name,
        "selection": area.selection.model_dump(mode="json", by_alias=True),
        "year": 2018,
        "configurationSha256": _fixture_configuration(2018).raster_configuration_sha256,
    }
    assert plan.summary == captured
    assert plan.retained_metadata == {"inputs": captured}
    assert plan.work_key is None and plan.presentation is None
    assert set(plan.specification) == {"operation", "request"}
    assert set(plan.specification["request"]) == set(captured)
    assert "coordinates" not in json.dumps(plan.specification)
    assert str(tmp_path) not in json.dumps(plan.retained_metadata)

    cache = tmp_path / "habitat-cache"
    runtime = HabitatEarthEngineRuntime(
        HabitatEarthEngineSettings("private-project", tmp_path / "private-key.json"),
        cache,
    )
    authorizer = SimpleNamespace(
        authorize=AsyncMock(side_effect=AssertionError("No Catalog raster is required"))
    )
    areas = SimpleNamespace(
        resolve_for_sampling=AsyncMock(
            side_effect=lambda selection: selected[selection.item_id]
        )
    )
    store = Mock()
    store.finish.return_value = True
    store.heartbeat.side_effect = lambda *args: not (
        tmp_path / "download-blocked"
    ).exists()
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    native = ReusableProcess(
        (_preparation_fixture_target, _fixture_native_target, summary_process),
        recycle_bytes=1024**3,
    )
    monkeypatch.setattr(
        habitat_preparation,
        "habitat_input_preparation_process_target",
        _preparation_fixture_target,
    )
    monkeypatch.setattr(
        habitat_operation, "habitat_process_target", _fixture_native_target
    )
    worker = ProcessingWorker(
        authorizer,
        store,
        artifacts,
        RasterClipLimits(),
        native=native,
        areas=areas,
        operation_settings={OPERATION: runtime, "habitat.condition.v1": runtime},
    )
    if outcome == "cancelled":
        (tmp_path / "cancel-download").touch()
    elif outcome == "failed":
        (tmp_path / "fail-download").touch()

    async def run() -> None:
        """Exercise the real worker, cache publication, cleanup and model consumer."""
        try:
            row = _claimed_job(plan, 1)
            configure_prepared_job_store(store, row)
            store.claim_next_job.return_value = row
            assert await worker.run_once()
            areas.resolve_for_sampling.assert_awaited_once_with(area.selection)
            artifact = store.finish.call_args.args[2]
            if outcome != "ready":
                assert artifact is None
                error = store.finish.call_args.args[3]
                assert error["code"] == (
                    "interrupted"
                    if outcome == "cancelled"
                    else "habitat_earth_engine_failed"
                )
                assert "private-remote-error" not in json.dumps(error)
                assert len(list(cache.rglob("tile.tif"))) == 1
                store.cleanup_candidates.return_value = [row]
                store.active_attempts.return_value = set()
                await worker.cleanup()
                assert not (artifacts.root / "attempts" / row["attempt_id"]).exists()
                assert len(list(cache.rglob("tile.tif"))) == 1
                return

            assert artifact is not None, store.finish.call_args
            assert artifact.media_type == "application/json"
            assert artifact.tile_count == 6
            assert {file.name for file in artifact.manifest.files} == {
                "result",
                "provenance",
            }
            report = json.loads(
                artifacts.result_path(
                    row["attempt_id"], result_name="result.json"
                ).read_text()
            )
            assert report == {**captured, "version": 1, "tileCount": 6}
            assert report["selection"] == area.selection.model_dump(
                mode="json", by_alias=True
            )
            provenance = artifacts.result_path(
                row["attempt_id"], provenance=True
            ).read_text()
            for secret in (str(tmp_path), "private-project", "private-key"):
                assert secret not in json.dumps(report)
                assert secret not in provenance
            assert len((tmp_path / "pixel-requests.txt").read_text().splitlines()) == 6
            assert len(list(cache.rglob("tile.tif"))) == 6

            # Report cleanup leaves the independently owned cache available.
            store.cleanup_candidates.return_value = [row]
            store.active_attempts.return_value = set()
            await worker.cleanup()
            assert not (artifacts.root / "results" / row["attempt_id"]).exists()
            assert len(list(cache.rglob("tile.tif"))) == 6

            # A second preparation and an ordinary model run make no new pixel requests.
            for number, next_plan in (
                (2, plan),
                (3, _consumer_run_plan(habitat_definition, area, references)),
            ):
                row = _claimed_job(next_plan, number)
                configure_prepared_job_store(store, row)
                store.claim_next_job.return_value = row
                assert await worker.run_once()
                assert (
                    store.finish.call_args.args[2] is not None
                ), store.finish.call_args
                assert (
                    len((tmp_path / "pixel-requests.txt").read_text().splitlines()) == 6
                )
                assert len(list(cache.rglob("tile.tif"))) == 6
        finally:
            await native.close()

    asyncio.run(run())
    authorizer.authorize.assert_not_awaited()


def test_changed_scientific_identity_is_rejected_before_reading_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Require a new explicit request when persisted work names another stack.

    Args:
        tmp_path: Native source and cache parent; no acquisition should create it.
        monkeypatch: Change the packaged scientific configuration after admission.
    """
    area = write_selection(tmp_path / "area.gpkg", [mapping(box(0, 0, 1, 1))])
    monkeypatch.setattr(
        habitat_preparation, "load_habitat_stack", _fixture_configuration
    )
    queued = QueuedHabitatInputPreparation.model_validate(
        build_habitat_input_preparation_submission(
            HabitatInputPreparationRequest(
                requestId="prepare-old-scientific-stack",
                name="Original inputs",
                selection=area.selection,
                year=2018,
            )
        ).specification
    )
    configuration = _fixture_configuration(2018)
    # The loader materializes this digest; replacing bands alone preserves it.
    changed = replace(configuration, raster_configuration_sha256="b" * 64)
    monkeypatch.setattr(habitat_preparation, "load_habitat_stack", lambda year: changed)
    monkeypatch.setattr(
        habitat_preparation, "read_habitat_polygons", Mock(side_effect=AssertionError)
    )
    monkeypatch.setattr(
        habitat_preparation, "get_habitat_tiles", Mock(side_effect=AssertionError)
    )
    with pytest.raises(ProcessingError) as failure:
        prepare_habitat_input_cache(
            HabitatSources({}, {"area": area}),
            HabitatInputPreparationSpec(inputs=queued.request),
            tmp_path / "attempt",
        )
    assert failure.value.code == "habitat_configuration_changed"
    assert not (tmp_path / "attempt").exists()


def test_input_preparation_is_not_a_selectable_model_operation() -> None:
    """Keep admin acquisition outside the supported selectable model result kinds."""
    definition = ModelDefinition.model_validate(
        {
            "schema": "eolab.model/v1",
            "id": "habitat-preparation-fixture",
            "version": "1.0.0",
            "title": "Preparation fixture",
            "description": "An admin report must not become a selectable model.",
            "inputs": {"area": {"type": "summary_area", "label": "Area"}},
            "parameters": {
                "year": {
                    "type": "number",
                    "label": "Assessment year",
                    "unit": "year",
                    "minimum": 2015,
                    "default": 2018,
                }
            },
            "steps": [
                {
                    "id": "prepare",
                    "operation": OPERATION,
                    "inputs": {"area": {"input": "area"}},
                    "parameters": {"year": {"parameter": "year"}},
                }
            ],
            "outputs": {
                "report": {
                    "source": "prepare.report",
                    "role": "result",
                    "presentation": "download",
                    "saveEligible": False,
                }
            },
            "executionProfile": get_model_operation(OPERATION).execution_profile,
        }
    )
    with pytest.raises(ProcessingError) as failure:
        ModelRegistry((definition,))
    assert failure.value.code == "unsupported_model_operation"
