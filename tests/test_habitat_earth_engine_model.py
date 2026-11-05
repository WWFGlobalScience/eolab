"""Run downloaded Habitat tiles through the existing supervised model pipeline."""

import asyncio
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import time
from types import SimpleNamespace
from typing import Any, Literal
from unittest.mock import AsyncMock, Mock
from zipfile import ZipFile

import numpy as np
from numpy.typing import NDArray
import pytest
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from shapely.geometry import box, mapping

from nhi_terrestrial_integrity_modeling.analysis_config import RasterStackConfiguration
from nhi_terrestrial_integrity_modeling.habitat_training import IntegrityConfiguration
from nhi_terrestrial_integrity_modeling.prepared_rasters import RasterBand
from nhi_terrestrial_integrity_modeling.prepared_runner import run_habitat_condition

from eolab_app.bounded_vector import summary_process
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.execution.reusable_process import ReusableProcess
from eolab_app.processing import habitat_calculation, habitat_operation
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.habitat_earth_engine import (
    HabitatEarthEngineRuntime,
    HabitatEarthEngineSettings,
    load_habitat_stack,
)
from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_operations import get_model_operation
from eolab_app.processing.model_run_contracts import ModelJobResponse, ModelRunRequest
from eolab_app.processing.model_runs import (
    build_model_calculation_request,
    build_model_job_submission,
    export_model_job_yaml,
)
from eolab_app.processing.service import serialize_processing_job
from eolab_app.processing.worker import ProcessingWorker
from catalog_selection_support import write_selection
from test_habitat_earth_engine import _use_offline_earth_engine
from test_habitat_model import habitat_definition
from test_processing_worker_results import configure_prepared_job_store


def _fixture_configuration(year: int) -> RasterStackConfiguration:
    """Use six original variables, including drought, on six acquisition tiles.

    Args:
        year: Supported source year passed by the production operation.

    Returns:
        Scientific definitions with a tiny grid, four predictors and two responses.
    """
    original = load_habitat_stack(year)
    return replace(
        original,
        bands=tuple(
            band
            for band in original.bands
            if band.identifier in {"d02", "d03", "d20", "d28", "d29", "d35"}
        ),
        grid=replace(original.grid, pixel_size_meters=1000, tile_size_pixels=8),
    )


def _fixture_values() -> dict[str, NDArray[np.float32]]:
    """Return input pixels with entirely missing drought predictors.

    Returns:
        Float32 scientific variables and a separate reference mask. Drought
        predictors d28 and d29 contain only NaN; other variables retain valid
        values, including zero, and isolated NoData across tile boundaries.
    """
    rows, columns = np.indices((16, 24))
    environment = rows * 0.3 + columns * 0.07
    category = (rows // 2 + columns // 2) % 3
    references = rows < 6
    values = {
        "d02": 1
        + 0.3 * environment
        + 0.1 * category
        + 0.04 * np.sin(rows + columns)
        + 0.2 * (columns % 3) * ~references,
        "d03": 2
        + 0.2 * environment
        - 0.15 * category
        + 0.03 * np.cos(rows * 2 + columns)
        + 0.1 * (rows % 3) * ~references,
        "d20": environment,
        "d28": np.full_like(environment, np.nan),
        "d29": np.full_like(environment, np.nan),
        "d35": category,
        "references": references,
    }
    values = {name: data.astype("float32") for name, data in values.items()}
    values["d20"][9, 8] = np.nan
    values["d02"][12, 16] = np.nan
    values["d03"][8, 7] = 0
    return values


def _tile_response(column: int, row: int) -> bytes:
    """Encode one controlled GEE response in the configured multiband order.

    Args:
        column: Zero-based tile column in the fixture extent.
        row: Zero-based tile row in the fixture extent.

    Returns:
        Complete float32 GeoTIFF bytes, preserving NaN NoData and valid zero.
    """
    values = _fixture_values()
    configuration = _fixture_configuration(2018)
    with MemoryFile() as memory:
        with memory.open(
            driver="GTiff",
            count=len(configuration.bands),
            width=8,
            height=8,
            dtype="float32",
            crs="EPSG:6933",
            nodata=np.nan,
            transform=from_origin(column * 8000, 16000 - row * 8000, 1000, 1000),
        ) as destination:
            destination.write(
                np.stack(
                    [
                        values[band.identifier][
                            row * 8 : row * 8 + 8, column * 8 : column * 8 + 8
                        ]
                        for band in configuration.bands
                    ]
                )
            )
        return memory.read()


def _fixture_native_target(
    queue: ProcessResultWriter,
    operation: Literal["prepare", "calculate"],
    arguments: tuple[Any, ...],
) -> None:
    """Run the production target with controlled remote pixels in its child process.

    Args:
        queue: Actual native worker result channel.
        operation: Preparation or calculation selected by the Habitat operation.
        arguments: Production arguments; local paths remain private to the worker.
    """
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(habitat_calculation, "load_habitat_stack", _fixture_configuration)
        if operation == "calculate":
            root = arguments[2].parents[2]
            received = 0

            def record_response() -> None:
                """Record each real client pixel request and optionally block the second."""
                nonlocal received
                received += 1
                with (root / "pixel-requests.txt").open("a", encoding="utf-8") as log:
                    log.write("computePixels\n")
                if received == 2 and (root / "cancel-download").exists():
                    (root / "download-blocked").touch()
                    time.sleep(60)

            _use_offline_earth_engine(
                patch,
                [
                    ({"status": "200"}, _tile_response(column, row))
                    for row in range(2)
                    for column in range(3)
                ],
                before_pixel_response=record_response,
            )
        habitat_calculation.habitat_process_target(queue, operation, arguments)


@pytest.mark.parametrize("cancel", [False, True])
def test_earth_engine_run_uses_cache_and_normal_worker_lifecycle(
    tmp_path: Path,
    habitat_definition: ModelDefinition,
    monkeypatch: pytest.MonkeyPatch,
    cancel: bool,
) -> None:
    """Match upstream after screening missing drought bands, or cancel acquisition.

    Args:
        tmp_path: Separate cache, reference polygons and ordinary worker storage.
        habitat_definition: Installed recipe with small-fixture fitting settings.
        monkeypatch: Bind the controlled native transport at the execution boundary.
        cancel: Stop a blocked second tile, preserving the completed first tile.
    """
    aoi = box(0, 0, 24000, 16000)
    area = write_selection(tmp_path / "area.gpkg", [mapping(aoi)], crs="EPSG:6933")
    references = write_selection(
        tmp_path / "references.gpkg",
        [mapping(box(-2000, 10000, 26000, 18000))],
        crs="EPSG:6933",
    )
    selected = {item.selection.item_id: item for item in (area, references)}
    request = ModelRunRequest(
        requestId="earth-engine-model",
        label="Habitat fixture",
        utcOffsetMinutes=0,
        model={
            "id": habitat_definition.id,
            "version": habitat_definition.version,
            "definitionSha256": habitat_definition.digest,
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
        request, ModelRegistry((habitat_definition,))
    )
    operation = get_model_operation("habitat.condition.v1")
    assert operation.source is None and operation.primary_input is None
    assert operation.extra_sources(calculation) == {}
    submission = build_model_job_submission(
        operation.queue(calculation, {}), invocation, None, {}
    )
    cache = tmp_path / "habitat-cache"
    runtime = HabitatEarthEngineRuntime(
        HabitatEarthEngineSettings("private-project", tmp_path / "private-key.json"),
        cache,
    )
    authorizer = SimpleNamespace(
        authorize=AsyncMock(side_effect=AssertionError("No Catalog raster is needed"))
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
        (_fixture_native_target, summary_process), recycle_bytes=1024**3
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
        operation_settings={operation.id: runtime},
    )
    if cancel:
        (tmp_path / "cancel-download").touch()

    async def run() -> dict[str, Any]:
        """Run twice against one cache, or stop the initial download and clean its attempt.

        Returns:
            The last completed or interrupted job, including its artifact when ready.
        """
        try:
            for index in range(1 if cancel else 2):
                now = datetime.now(timezone.utc)
                row = {
                    "id": str(index + 1) * 32,
                    "attempt_id": str(index + 3) * 32,
                    "input_uploads": {},
                    "operation": "model.run.v1",
                    "spec": submission.specification,
                    "summary": submission.summary,
                    "retained_metadata": submission.retained_metadata,
                    "presentation": {"utcOffsetMinutes": 0},
                    "reserved_bytes": 0,
                    "created_at": now,
                    "updated_at": now,
                    "expires_at": now + timedelta(hours=1),
                    "status": "running",
                    "progress": {},
                    "error": None,
                }
                configure_prepared_job_store(store, row)
                store.claim_next_job.return_value = row
                assert await worker.run_once()
                artifact = store.finish.call_args.args[2]
                if cancel:
                    assert artifact is None
                    assert store.finish.call_args.args[3]["code"] == "interrupted"
                    store.cleanup_candidates.return_value = [row]
                    store.active_attempts.return_value = set()
                    await worker.cleanup()
                    assert not (
                        artifacts.root / "attempts" / row["attempt_id"]
                    ).exists()
                    assert len(list(cache.rglob("tile.tif"))) == 1
                else:
                    assert artifact is not None, store.finish.call_args
                    row.update(
                        status="ready",
                        artifact=asdict(artifact),
                        retained_outcome={
                            "status": "ready",
                            "artifact": asdict(artifact),
                        },
                    )
                    assert (
                        len((tmp_path / "pixel-requests.txt").read_text().splitlines())
                        == 6
                    )
                    assert len(list(cache.rglob("tile.tif"))) == 6
            return row
        finally:
            await native.close()

    ready = asyncio.run(run())
    authorizer.authorize.assert_not_awaited()
    if cancel:
        return
    response = ModelJobResponse.model_validate(serialize_processing_job(ready))
    assert response.result.name == "reference_similarity"
    assert {file.name for file in response.artifacts.files} == {
        "reference_similarity",
        "diagnostics",
        "provenance",
    }
    provenance_path = artifacts.artifact_path(ready["attempt_id"], "provenance.json")
    provenance_text = provenance_path.read_text()
    for secret in (str(tmp_path), "private-project", "private-key"):
        assert secret not in provenance_text
        assert secret not in export_model_job_yaml(ready, run=True).decode()
    provenance = json.loads(provenance_text)
    assert provenance["inputs"]["stack"] == {"kind": "earthEngine", "year": 2018}

    configuration = _fixture_configuration(2018)
    assert provenance["earthEngine"]["year"] == 2018
    assert provenance["earthEngine"]["datasets"] == dict(configuration.datasets)
    assert [band["identifier"] for band in provenance["earthEngine"]["bands"]] == [
        band.identifier for band in configuration.bands
    ]
    assert provenance["inputs"]["settings"] == calculation.settings.model_dump(
        mode="json"
    )
    named = list(zip(configuration.band_names(), configuration.bands))
    coverage = {
        item["predictor"]: item for item in provenance["fit"]["predictorCoverage"]
    }
    for name, band in named:
        if band.role != "predictor":
            continue
        predictor = coverage[name]
        if band.identifier in {"d28", "d29"}:
            assert predictor["defined_rows"] == 0
            assert predictor["area_coverage"] == 0
            assert predictor["retained"] is False
        else:
            assert (
                predictor["area_coverage"]
                >= calculation.settings.minimum_predictor_coverage
            )
            assert predictor["retained"] is True
    values = _fixture_values()
    paths = {}
    for name, pixels in values.items():
        path = tmp_path / f"expected-{name}.tif"
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            count=1,
            width=24,
            height=16,
            dtype="float64",
            crs="EPSG:6933",
            nodata=np.nan,
            transform=from_origin(0, 16000, 1000, 1000),
        ) as destination:
            destination.write(pixels.astype("float64"), 1)
        paths[name] = path
    settings = calculation.settings
    expected = run_habitat_condition(
        [
            RasterBand(name, paths[band.identifier])
            for name, band in named
            if band.role == "predictor"
        ],
        [
            RasterBand(name, paths[band.identifier])
            for name, band in named
            if band.role == "response"
        ],
        RasterBand("reference_sites", paths["references"]),
        aoi,
        tmp_path / "expected",
        IntegrityConfiguration(
            **{
                name: getattr(settings, name)
                for name in IntegrityConfiguration.__dataclass_fields__
            }
        ),
        categorical_predictor_name=next(
            name for name, band in named if band.data_type == "categorical"
        ),
        samples_per_class_per_block=settings.samples_per_class_per_block,
        random_seed=settings.random_seed,
        tile_size_pixels=settings.tile_size_pixels,
        tile_origin=settings.tile_origin,
        window_size_pixels=settings.window_size_pixels,
        covariance_shrinkage=settings.covariance_shrinkage,
    )
    with ZipFile(
        artifacts.artifact_path(ready["attempt_id"], "diagnostics.zip")
    ) as archive:
        for name in (
            "reference_similarity",
            "expected_reference",
            "observed_minus_expected",
            "standardized_deviation",
            "inference_status",
        ):
            data = (
                artifacts.artifact_path(ready["attempt_id"], "result.tif").read_bytes()
                if name == "reference_similarity"
                else archive.read(f"{name}.tif")
            )
            with (
                MemoryFile(data) as memory,
                memory.open() as actual,
                rasterio.open(getattr(expected, name)) as direct,
            ):
                assert actual.transform == direct.transform
                assert actual.descriptions == direct.descriptions
                np.testing.assert_array_equal(actual.read(), direct.read())
    assert all(path.is_file() for path in provenance_path.parent.iterdir())
