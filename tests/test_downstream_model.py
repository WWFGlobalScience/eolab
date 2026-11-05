"""Reference grids and real Processing boundaries for downstream model execution."""

import asyncio
import json
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from eolab_app.processing.downstream_calculation import (
    DownstreamSources,
    calculate_downstream,
    plan_downstream,
)
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.downstream_models import DownstreamRequest, DownstreamSettings
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.prepared_hydrology import HydrologySources
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_identity import RasterSourceIdentity
from test_prepared_hydrology import prepare_sources


def scaled_downstream_fixture(
    directory: Path, width: int, height: int
) -> tuple[DownstreamSources, DownstreamRequest, RasterClipLimits]:
    """Generate the same three-basin reference at a larger native resolution.

    Args:
        directory: Isolated sources for cancellation and resource measurements.
        width: Bounded native column count.
        height: Bounded native row count.

    Returns:
        Configured terrain, captured inputs and shared job lifecycle settings.
    """
    sources, request, limits = downstream_fixture(directory)
    for name in ("dem", "starting_mask", "values"):
        data = np.ones((height, width), dtype="float32")
        if name == "dem":
            data[:] = np.arange(width, 0, -1)
        elif name == "starting_mask":
            data[:, 1:] = 0
        with rasterio.open(
            sources.rasters[name],
            "w",
            driver="GTiff",
            width=width,
            height=height,
            count=1,
            dtype="float32",
            nodata=-9999,
            crs="EPSG:4326",
            transform=from_origin(0, 4, 6 / width, 4 / height),
            tiled=True,
            blockxsize=256,
            blockysize=256,
        ) as target:
            target.write(data, 1)
    return (
        sources,
        request.model_copy(update={"wgs84_pixel_size": 6 / width}),
        limits,
    )


def downstream_fixture(
    directory: Path,
    *,
    values: np.ndarray | None = None,
    formula: str = "sum(a)",
    records: list[dict[str, Any]] | None = None,
    pit_fill_search_limit: int = 1000,
) -> tuple[DownstreamSources, DownstreamRequest, RasterClipLimits]:
    """Create a prepared three-basin eastward slope and a first-column raster mask.

    Args:
        directory: Isolated fixture files.
        values: Optional native 4-by-6 values raster.
        formula: Scalar result formula.
        records: Optional complete network with different coverage or connections.
        pit_fill_search_limit: Numerical pit-search cutoff captured in the request.

    Returns:
        Native sources, captured request and shared job lifecycle settings.
    """
    definition, dem, network, _ = prepare_sources(directory, records=records)
    hydrology = HydrologySources(
        dem=definition.dem,
        watersheds=definition.watersheds,
        topology=definition.topology,
    )
    for name, data in (
        ("mask", np.tile([1, 0, 0, 0, 0, 0], (4, 1)).astype("int16")),
        ("values", np.ones((4, 6), dtype="int16") if values is None else values),
    ):
        with rasterio.open(
            directory / (name + ".tif"),
            "w",
            driver="GTiff",
            width=6,
            height=4,
            count=1,
            dtype=data.dtype,
            crs="EPSG:4326",
            transform=from_origin(0, 4, 1, 1),
            nodata=-9999,
        ) as target:
            target.write(data, 1)
    request = DownstreamRequest(
        requestId="a" * 32,
        label="Beneficiaries",
        starting_mask={
            "kind": "catalogRaster",
            "source": {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": "geotiff-" + "3" * 24,
            },
        },
        hydrology=hydrology,
        settings=DownstreamSettings(pit_fill_search_limit=pit_fill_search_limit),
        values={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-" + "2" * 24,
        },
        buffer_m=0,
        cutoff_m=None,
        summary=formula,
        wgs84_pixel_size=1.0,
        travel_time_pixel_size_m=100000,
    )
    sources = DownstreamSources(
        {
            "dem": dem.source_path,
            "starting_mask": directory / "mask.tif",
            "values": directory / "values.tif",
        },
        network,
        None,
    )
    return sources, request, RasterClipLimits()


@pytest.mark.parametrize(
    "problem", ["cycle", "missing", "sink", "null_id", "duplicate"]
)
def test_configured_network_is_delegated_without_a_suitability_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, problem: str
) -> None:
    """Let the original model read configured hydrology without a separate network gate.

    Args:
        tmp_path: Native fixture sources and calculation directory.
        monkeypatch: Observe the model boundary without executing invalid routing.
        problem: Network data that the application previously rejected in preflight.
    """
    from shapely.geometry import box, mapping
    from eolab_app.processing.aggregate_models import AggregateArtifact

    records = [
        {
            "id": i,
            "next": i + 1 if i < 3 else 0,
            "sink": 3,
            "geometry": mapping(box((i - 1) * 2, 0, i * 2, 4)),
        }
        for i in range(1, 4)
    ]
    if problem == "cycle":
        records[1]["next"] = 1
    elif problem == "missing":
        records[1]["next"] = 99
    elif problem == "sink":
        records[1]["sink"] = 2
    elif problem == "null_id":
        records[0]["id"] = None
    else:
        records.append(dict(records[0]))
    sources, request, limits = downstream_fixture(tmp_path, records=records)
    reader = Mock(side_effect=AssertionError("Unexpected watershed preflight"))
    monkeypatch.setattr(
        "eolab_app.processing.downstream_calculation.polygon_records", reader
    )
    expected = AggregateArtifact(
        filename="result.csv", size=1, sha256="a" * 64, rows=[]
    )
    original_model = Mock(return_value=expected)
    monkeypatch.setattr(
        "eolab_app.processing.downstream_runner.run_original_downstream", original_model
    )
    plan = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    assert calculate_downstream(sources, plan, directory, limits) is expected
    original_model.assert_called_once()
    assert original_model.call_args.args[0] is sources
    reader.assert_not_called()


def test_configured_network_runs_despite_unrelated_duplicate_ids(
    tmp_path: Path,
) -> None:
    """Route a valid selected drainage without scanning unrelated duplicate basin records.

    Args:
        tmp_path: Original sources and calculation outputs.
    """
    from shapely.geometry import box, mapping

    records = [
        {
            "id": i,
            "next": i + 1 if i < 3 else 0,
            "sink": 3,
            "geometry": mapping(box((i - 1) * 2, 0, i * 2, 4)),
        }
        for i in range(1, 4)
    ]
    records.extend(
        [{"id": 10, "next": 999, "sink": 10, "geometry": mapping(box(20, 0, 22, 4))}]
        * 2
    )
    sources, request, limits = downstream_fixture(tmp_path, records=records)
    plan = plan_downstream(sources, request)
    assert plan.watershedSelection == sources.network.selection
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, plan, directory, limits)
    assert float(artifact.rows[0]["value"]) == 24


@pytest.mark.parametrize("pit_fill_search_limit", [100, 1000])
def test_downstream_mask_crosses_watersheds_and_sums_upstream_positive_values(
    tmp_path: Path,
    pit_fill_search_limit: int,
) -> None:
    """The original model masks positive values on its coverage grid.

    Args:
        tmp_path: Isolated prepared sources and calculation artifacts.
        pit_fill_search_limit: Numerical cutoff captured during preparation.
    """
    pytest.importorskip("ecoshard.geoprocessing.routing")
    data = np.arange(-12, 12, dtype="int16").reshape(4, 6)
    sources, request, limits = downstream_fixture(
        tmp_path / "sources", values=data, pit_fill_search_limit=pit_fill_search_limit
    )
    spec = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == float(data[data > 0].sum())
    assert spec.watershedSelection == sources.network.selection
    provenance = json.loads((directory / "provenance.json").read_text())
    assert provenance["numericalPolicy"]["pitFillSearchLimit"] == pit_fill_search_limit
    assert provenance["numericalPolicy"]["pitFillTreatNodataAsClosed"] is True
    assert provenance["ecoshardRevision"] == "6bd106862a2cb2517f91f9bd7ca8bb071ccb6013"
    assert (
        provenance["beneficiariesRevision"]
        == "3f577e27deb347cd4520977eb99474fb81e990fc"
    )
    with rasterio.open(directory / "starting_mask.tif") as mask:
        assert np.count_nonzero(mask.read(1) == 1) == 4
    with rasterio.open(directory / "coverage.tif") as coverage:
        assert np.all(coverage.read(1) == 1)
    assert {item.name for item in artifact.additional_outputs} == {
        "coverage",
        "starting_mask",
        "masked_values",
        "routing_dem_drain_3",
    }


def test_downstream_progress_counts_drainage_groups(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Report both native drainage stages in groups through private progress files.

    Args:
        tmp_path: Native source fixtures and private calculation outputs.
        monkeypatch: Capture each progress snapshot after its atomic write.
    """
    from shapely.geometry import box, mapping
    from eolab_app.processing.artifacts import LocalJobArtifacts, write_progress

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(
        tmp_path / "sources",
        records=[
            {
                "id": index + 1,
                "next": 0,
                "sink": index + 1,
                "geometry": mapping(box(0, index * 2, 6, (index + 1) * 2)),
            }
            for index in range(2)
        ],
    )
    spec = plan_downstream(sources, request)
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    attempt = "a" * 32
    directory = artifacts.prepare(attempt)
    snapshots: list[dict[str, Any]] = []

    def capture_progress(
        directory: Path,
        phase: str,
        complete: int,
        total: int,
        *,
        unit: str = "blocks",
    ) -> None:
        """Capture the native snapshot through the worker's ordinary artifact reader.

        Args:
            directory: Private attempt output directory.
            phase: Native stage reported by the model.
            complete: Number of work units already completed.
            total: Number of work units for this stage.
            unit: Operation-owned unit for the stage count.
        """
        write_progress(directory, phase, complete, total, unit=unit)
        snapshots.append(artifacts.progress(attempt))

    monkeypatch.setattr(
        "eolab_app.processing.downstream_runner.write_progress", capture_progress
    )
    artifact = calculate_downstream(sources, spec, directory, limits)

    assert (
        sum(
            item.name.startswith("routing_dem_") for item in artifact.additional_outputs
        )
        == 2
    )
    assert [
        snapshot
        for snapshot in snapshots
        if snapshot["phase"] in {"routing_downstream", "buffering_downstream_coverage"}
    ] == [
        {
            "phase": phase,
            "completed": completed,
            "total": 2,
            "unit": "drainage groups",
        }
        for completed in range(2)
        for phase in ("routing_downstream", "buffering_downstream_coverage")
    ]


def test_nodata_values_preserve_original_zero_total(tmp_path: Path) -> None:
    """Missing values retain the original model's zero sum and nonempty coverage.

    Args:
        tmp_path: Isolated model sources and outputs.
    """
    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(
        tmp_path / "sources", values=np.full((4, 6), -9999, dtype="int16")
    )
    spec = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert artifact.rows[0]["state"] == "ok"
    assert float(artifact.rows[0]["value"]) == 0
    with rasterio.open(directory / "coverage.tif") as dataset:
        assert np.all(dataset.read(1) == 1)


def test_empty_starting_raster_is_rejected_before_routing(tmp_path: Path) -> None:
    """A raster with no positive seed cells fails when constructing the model's AOI.

    Args:
        tmp_path: Isolated native sources.
    """
    sources, request, limits = downstream_fixture(tmp_path)
    with rasterio.open(sources.rasters["starting_mask"], "r+") as dataset:
        dataset.write(np.zeros((4, 6), dtype="int16"), 1)
    plan = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    with pytest.raises(ProcessingError, match="no positive valid cells"):
        calculate_downstream(sources, plan, directory, limits)


@pytest.mark.parametrize("pit_fill_search_limit", [100, 1000, -1, 0, 2**63 - 1])
def test_closed_edge_policy_records_current_filling_settings(
    tmp_path: Path, pit_fill_search_limit: int
) -> None:
    """Record the configured filling behavior in the current numerical policy.

    Args:
        tmp_path: Isolated native source metadata for a prepared plan.
        pit_fill_search_limit: EcoShard search cutoff from the model settings.
    """
    from eolab_app.processing.downstream_operation import describe_downstream_policy
    from eolab_app.processing.downstream_models import (
        ClosedEdgeDownstreamNumericalPolicy,
    )

    sources, request, _ = downstream_fixture(
        tmp_path, pit_fill_search_limit=pit_fill_search_limit
    )
    policy = describe_downstream_policy(plan_downstream(sources, request))
    saved = policy.model_dump(mode="json")
    assert saved["version"] == "hydrology.downstream_beneficiaries.v3"
    assert saved["pitFillSearchLimit"] == pit_fill_search_limit
    assert saved["pitFillTreatNodataAsClosed"] is True
    assert saved["ecoshardRevision"] == "6bd106862a2cb2517f91f9bd7ca8bb071ccb6013"
    assert saved["beneficiariesRevision"] == "3f577e27deb347cd4520977eb99474fb81e990fc"
    assert (
        ClosedEdgeDownstreamNumericalPolicy.model_validate(saved).model_dump(
            mode="json"
        )
        == saved
    )


def test_saved_model_settings_reach_downstream_execution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pass the model's saved pit-search cutoff to execution and numerical provenance.

    Args:
        tmp_path: Isolated prepared sources and run directory.
        monkeypatch: Observe the plan sent across the upstream model boundary.
    """
    from eolab_app.processing.downstream_models import DownstreamPlan
    from eolab_app.processing.downstream_operation import describe_downstream_policy

    sources, request, limits = downstream_fixture(
        tmp_path / "sources", pit_fill_search_limit=17
    )
    planned = plan_downstream(sources, request)
    saved = DownstreamPlan.model_validate_json(planned.model_dump_json(by_alias=True))
    assert saved.inputs.settings.pit_fill_search_limit == 17
    runner = Mock(side_effect=RuntimeError("observed saved plan"))
    monkeypatch.setattr(
        "eolab_app.processing.downstream_runner.run_original_downstream", runner
    )
    directory = tmp_path / "run"
    directory.mkdir()
    with pytest.raises(RuntimeError, match="observed saved plan"):
        calculate_downstream(sources, saved, directory, limits)
    assert runner.call_args.args[1].inputs.settings.pit_fill_search_limit == 17
    assert describe_downstream_policy(saved).pitFillSearchLimit == 17


@pytest.mark.parametrize("value", [True, "100", 1.5, -2, 2**63])
def test_saved_pit_fill_cutoff_rejects_invalid_values(
    tmp_path: Path, value: Any
) -> None:
    """Reject malformed or unrepresentable cutoffs in persisted plans and policies.

    Args:
        tmp_path: Isolated sources for otherwise valid saved contracts.
        value: Invalid value supplied by stored JSON.
    """
    from pydantic import ValidationError

    from eolab_app.processing.downstream_models import (
        DownstreamPlan,
        ClosedEdgeDownstreamNumericalPolicy,
    )
    from eolab_app.processing.downstream_operation import describe_downstream_policy

    sources, request, limits = downstream_fixture(tmp_path)
    plan = plan_downstream(sources, request)
    saved_plan = plan.model_dump(mode="json", by_alias=True)
    saved_plan["inputs"]["settings"]["pit_fill_search_limit"] = value
    with pytest.raises(ValidationError, match="pit_fill_search_limit"):
        DownstreamPlan.model_validate(saved_plan)
    saved_policy = describe_downstream_policy(plan).model_dump(mode="json")
    saved_policy["pitFillSearchLimit"] = value
    with pytest.raises(ValidationError, match="pitFillSearchLimit"):
        ClosedEdgeDownstreamNumericalPolicy.model_validate(saved_policy)


@pytest.mark.parametrize("pit_fill_search_limit", [1000, -1, 0])
def test_upstream_relative_scratch_stays_in_run_after_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pit_fill_search_limit: int
) -> None:
    """Upstream relative scratch stays private and the worker's directory is restored.

    Args:
        tmp_path: Original inputs and an isolated run workspace.
        monkeypatch: Inject a failure at the external model boundary.
        pit_fill_search_limit: Configured cutoff passed unchanged to the native model.
    """
    from eolab_app.processing.downstream_runner import load_beneficiaries

    sources, request, limits = downstream_fixture(
        tmp_path / "inputs", pit_fill_search_limit=pit_fill_search_limit
    )
    spec = plan_downstream(sources, request)
    workspace = tmp_path / "attempt"
    workspace.mkdir()
    previous = Path.cwd()

    def fail_with_relative_scratch(*args: Any, **kwargs: Any) -> None:
        """Simulate an upstream helper's relative scratch and subsequent I/O failure.

        Args:
            *args: Arguments passed unchanged to the original flow function.
            **kwargs: Original optional function settings.

        Raises:
            OSError: Always, after creating a run-local scratch marker.
        """
        assert Path.cwd() == workspace.resolve()
        assert kwargs["max_pixel_fill_count"] == pit_fill_search_limit
        assert kwargs["treat_nodata_as_closed"] is True
        Path("upstream-relative-scratch").write_text("private")
        raise OSError("upstream fixture failure")

    monkeypatch.setattr(
        load_beneficiaries(), "calc_flow_dir", fail_with_relative_scratch
    )
    with pytest.raises(OSError, match="upstream fixture failure"):
        calculate_downstream(sources, spec, workspace, limits)
    assert Path.cwd() == previous
    assert (workspace / "upstream-relative-scratch").read_text() == "private"


@pytest.mark.parametrize(
    "formula,expected",
    [("sum(a)", 24), ("count(a)", 24), ("mean(a)", 1), ("sum(a, where=a > 0)", 24)],
)
def test_formulas_summarize_the_original_masked_values_grid(
    tmp_path: Path, formula: str, expected: float
) -> None:
    """EOlab formulas read the original model's resampled, masked values output.

    Args:
        tmp_path: Isolated native model sources.
        formula: Existing scalar grammar expression to evaluate.
        expected: Reference result across the 24 cells in the upstream output grid.
    """
    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources", formula=formula)
    with rasterio.open(
        sources.rasters["values"],
        "w",
        driver="GTiff",
        width=12,
        height=4,
        count=1,
        dtype="int16",
        nodata=-9999,
        crs="EPSG:4326",
        transform=from_origin(0, 4, 0.5, 1),
    ) as target:
        target.write(np.ones((4, 12), dtype="int16"), 1)
    spec = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == expected


def test_cutoff_is_measured_from_original_seeds(tmp_path: Path) -> None:
    """A small straight-line cutoff retains seed cells and excludes downstream cells.

    Args:
        tmp_path: Native reference sources and results.
    """
    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources")
    request = request.model_copy(update={"cutoff_m": 1000})
    spec = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == 4


def test_filtered_vectors_form_one_mask_without_expanded_seeds(tmp_path: Path) -> None:
    """A filter selecting the first watershed seeds only it while flow reaches all three.

    Args:
        tmp_path: Native vector, terrain and result fixtures.
    """
    from eolab_app.vector.filters import VectorFilter
    from eolab_app.catalog_selection import ResolvedCatalogSelection

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources")
    selection = sources.network.selection.model_copy(
        update={
            "filter": VectorFilter.model_validate(
                {
                    "enabled": True,
                    "match": "all",
                    "rules": [{"field": "id", "operator": "eq", "value": 1}],
                }
            )
        }
    )
    selected = replace(sources.network, selection=selection, where='"id" = 1')
    sources = DownstreamSources(sources.rasters, sources.network, selected)
    request = DownstreamRequest.model_validate(
        {
            **request.model_dump(mode="json", by_alias=True),
            "starting_mask": {"kind": "catalogSelection", "selection": selection},
        }
    )
    spec = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == 24
    with rasterio.open(directory / "starting_mask.tif") as mask:
        assert np.count_nonzero(mask.read(1) == 1) == 8


def test_model_worker_publishes_downstream_outputs_and_run_yaml(tmp_path: Path) -> None:
    """Execute YAML-configured pit filling and publish its results and numerical policy.

    Args:
        tmp_path: Isolated catalog and owned artifact fixtures.
    """
    from eolab_app.processing.artifacts import LocalJobArtifacts
    from eolab_app.processing.worker import ProcessingWorker
    from eolab_app.processing.native_processes import create_native_process
    from eolab_app.processing.model_definitions import ModelRegistry
    from eolab_app.processing.model_operations import get_model_operation
    from eolab_app.processing.model_run_contracts import (
        ModelRunRequest,
        ModelJobResponse,
        RunDocument,
    )
    from eolab_app.processing.model_runs import (
        build_model_calculation_request,
        build_model_job_submission,
        export_model_job_yaml,
    )
    from eolab_app.processing.model_yaml import parse_yaml
    from eolab_app.processing.service import serialize_processing_job
    from test_processing_worker_results import configure_prepared_job_store

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources")
    registry = ModelRegistry.load_installed()
    from eolab_app.processing.model_definitions import ModelDefinition

    document = registry.get("downstream-beneficiaries", "4.0.0").to_document()
    document["steps"][0]["inputs"]["hydrology"]["value"] = request.hydrology.model_dump(
        mode="json", by_alias=True
    )
    document["steps"][0]["inputs"]["settings"]["value"]["pit_fill_search_limit"] = 17
    definition = ModelDefinition.model_validate(document)
    registry = ModelRegistry((definition,))
    submitted = ModelRunRequest(
        requestId=request.requestId,
        label=request.label,
        utcOffsetMinutes=0,
        model={
            "id": definition.id,
            "version": definition.version,
            "definitionSha256": definition.digest,
        },
        inputs={
            "starting_mask": request.starting_mask.model_dump(
                mode="json", by_alias=True
            ),
            "values": request.values.model_dump(by_alias=True),
        },
        parameters={
            "buffer_m": 0,
            "cutoff_m": None,
            "summary": "sum(a)",
            "wgs84_pixel_size": 1,
            "travel_time_pixel_size_m": 100000,
        },
    )
    calculation, invocation = build_model_calculation_request(submitted, registry)
    assert calculation.settings.pit_fill_search_limit == 17
    operation = get_model_operation(definition.steps[0].operation)
    identities = {
        name: tuple(RasterSourceIdentity.read(path).to_catalog())
        for name, path in sources.rasters.items()
    }
    prepared = build_model_job_submission(
        operation.queue(calculation, {}),
        invocation,
        identities["values"],
        {name: identities[name] for name in ("dem", "starting_mask")},
    )
    references = {
        request.values.item_id: sources.rasters["values"],
        request.hydrology.dem.item_id: sources.rasters["dem"],
        request.starting_mask.source.item_id: sources.rasters["starting_mask"],
    }

    async def authorize(reference: Any) -> AuthorizedRaster:
        """Resolve a fixture catalog reference to its current native source identity.

        Args:
            reference: Path-free raster source requested by the worker.

        Returns:
            Native path and current stat identity.
        """
        path = references[reference.item_id]
        return AuthorizedRaster(path, RasterSourceIdentity.read(path))

    now = datetime.now(timezone.utc)
    row = {
        "id": "a" * 32,
        "input_uploads": {},
        "attempt_id": "b" * 32,
        "operation": "model.run.v1",
        "spec": prepared.specification,
        "summary": prepared.summary,
        "retained_metadata": prepared.retained_metadata,
        "presentation": {"utcOffsetMinutes": 0},
        "reserved_bytes": 0,
        "created_at": now,
        "updated_at": now,
        "expires_at": now + timedelta(hours=1),
        "status": "running",
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
    native = create_native_process(limits)
    worker = ProcessingWorker(
        SimpleNamespace(authorize=authorize),
        store,
        artifacts,
        limits,
        native=native,
        areas=SimpleNamespace(
            resolve_for_sampling=AsyncMock(return_value=sources.network),
            resolve_source=AsyncMock(return_value=sources.network),
        ),
    )

    async def execute() -> bool:
        """Run one production-composed worker attempt and close its process lane.

        Returns:
            Whether the existing worker handled the queued attempt.
        """
        try:
            return await worker.run_once()
        finally:
            await native.close()

    assert asyncio.run(execute())
    artifact = store.finish.call_args.args[2]
    assert artifact is not None, store.finish.call_args
    provenance_file = next(
        file for file in artifact.manifest.files if file.name == "provenance"
    )
    provenance = json.loads(
        artifacts.artifact_path(
            row["attempt_id"], provenance_file.storage_name
        ).read_text()
    )
    assert provenance["numericalPolicy"]["pitFillSearchLimit"] == 17
    ready = {
        **row,
        "status": "ready",
        "artifact": asdict(artifact),
        "retained_outcome": {"status": "ready", "artifact": asdict(artifact)},
    }
    response = ModelJobResponse.model_validate(serialize_processing_job(ready))
    assert float(response.result.rows[0].value) == 24
    assert {file.name for file in response.artifacts.files} == {
        "statistics",
        "coverage",
        "starting_mask",
        "provenance",
        "masked_values",
        "routing_dem_drain_3",
    }
    routing_dem = next(
        file for file in response.artifacts.files if file.name == "routing_dem_drain_3"
    )
    assert routing_dem.role == "intermediate"
    assert routing_dem.mediaType == "image/tiff"
    assert routing_dem.label == "Routing DEM (pit-filled) · Drain 3"
    document = RunDocument.model_validate(
        parse_yaml(export_model_job_yaml(ready, run=True), run=True)
    )
    assert set(document.execution.additionalSources) == {"dem", "starting_mask"}
    policy = document.execution.numericalPolicy.model_dump(mode="json")
    assert policy["version"] == "hydrology.downstream_beneficiaries.v3"
    assert policy["pitFillSearchLimit"] == 17
    assert policy["pitFillTreatNodataAsClosed"] is True
    assert str(tmp_path) not in export_model_job_yaml(ready, run=True).decode()


def test_cancel_reaps_real_downstream_native_work_before_cleanup(
    tmp_path: Path,
) -> None:
    """Cancel a real routing calculation and verify no child or published files remain.

    Args:
        tmp_path: Original sources and Processing-owned attempt storage.
    """
    from multiprocessing import active_children
    from eolab_app.processing.artifacts import LocalJobArtifacts
    from eolab_app.processing.native_processes import create_native_process
    from eolab_app.processing.downstream_calculation import downstream_process_target

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = scaled_downstream_fixture(
        tmp_path / "sources", 1500, 1000
    )
    spec = plan_downstream(sources, request)
    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    attempt = "d" * 32
    directory = artifacts.prepare(attempt)

    async def cancel_during_routing() -> None:
        """Wait for actual routing, then use the same cancellation boundary as the worker."""
        native = create_native_process(limits)
        task = asyncio.create_task(
            native.run(
                downstream_process_target,
                ("calculate", (sources, spec, directory, limits)),
                60,
            )
        )
        try:
            async with asyncio.timeout(45):
                while artifacts.progress(attempt).get(
                    "phase"
                ) != "routing_downstream" or not any(
                    (directory / "upstream").rglob("flow.tif")
                ):
                    assert not task.done(), task.result() if task.done() else None
                    await asyncio.sleep(0.01)
            pids = {child.pid for child in active_children()}
            assert pids
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert not pids.intersection(child.pid for child in active_children())
            assert not (directory / "result.csv").exists()
            artifacts.remove(attempt)
            assert not directory.exists()
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await native.close()

    asyncio.run(cancel_during_routing())


def test_overlapping_starting_features_count_each_value_once(tmp_path: Path) -> None:
    """Combined overlapping vector features create one seed mask and one native total.

    Args:
        tmp_path: Original starting features, prepared terrain and run directory.
    """
    from catalog_selection_support import write_selection
    from shapely.geometry import box, mapping

    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources")
    starting = write_selection(
        tmp_path / "starts.gpkg", [mapping(box(0, 0, 2, 4)), mapping(box(1, 0, 3, 4))]
    )
    sources = replace(sources, starting=starting)
    request = DownstreamRequest.model_validate(
        {
            **request.model_dump(mode="json", by_alias=True),
            "starting_mask": {
                "kind": "catalogSelection",
                "selection": starting.selection,
            },
        }
    )
    spec = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == 24
    with rasterio.open(directory / "starting_mask.tif") as dataset:
        assert np.count_nonzero(dataset.read(1) == 1) == 12


def test_native_seed_mask_excludes_zero_negative_and_nodata(tmp_path: Path) -> None:
    """Only valid positive cells seed routing even when nearby mask values exist.

    Args:
        tmp_path: Native mask values and run outputs.
    """
    pytest.importorskip("ecoshard.geoprocessing.routing")
    sources, request, limits = downstream_fixture(tmp_path / "sources")
    with rasterio.open(sources.rasters["starting_mask"], "r+") as dataset:
        dataset.write(np.tile([1, 0, -1, -9999, 0, 0], (4, 1)).astype("int16"), 1)
    spec = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    calculate_downstream(sources, spec, directory, limits)
    with rasterio.open(directory / "starting_mask.tif") as dataset:
        assert np.count_nonzero(dataset.read(1) == 1) == 4


@pytest.mark.parametrize("outside", ["north", "east"])
def test_regional_dem_runs_with_network_extending_beyond_it(
    tmp_path: Path, outside: str
) -> None:
    """Route a covered drainage even when other network basins exceed the DEM extent.

    Args:
        tmp_path: Native source and result files.
        outside: Direction in which an unused basin extends beyond terrain coverage.
    """
    from shapely.geometry import box, mapping

    records = [
        {
            "id": i,
            "next": i + 1 if i < 3 else 0,
            "sink": 3,
            "geometry": mapping(box((i - 1) * 2, 0, i * 2, 4)),
        }
        for i in range(1, 4)
    ]
    records.append(
        {
            "id": 4,
            "next": 0,
            "sink": 4,
            "geometry": mapping(
                box(0, 5, 2, 6) if outside == "north" else box(8, 0, 10, 4)
            ),
        }
    )
    sources, request, limits = downstream_fixture(tmp_path, records=records)
    spec = plan_downstream(sources, request)
    assert spec.watershedSelection == sources.network.selection
    directory = tmp_path / "run"
    directory.mkdir()
    artifact = calculate_downstream(sources, spec, directory, limits)
    assert float(artifact.rows[0]["value"]) == 24


@pytest.mark.parametrize(
    "width,height,west,north", [(5, 4, 0, 4), (6, 3, 0, 3), (6, 4, 10, 4)]
)
def test_configured_dem_extent_is_left_to_the_original_model(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    width: int,
    height: int,
    west: float,
    north: float,
) -> None:
    """Pass a configured regional DEM unchanged without a separate coverage scan.

    Args:
        tmp_path: Isolated sources and private attempt directory.
        monkeypatch: Observe the original-model call without routing missing terrain.
        width: Restricted DEM column count.
        height: Restricted DEM row count.
        west: DEM western edge.
        north: DEM northern edge.
    """
    from eolab_app.processing.aggregate_models import AggregateArtifact

    sources, request, limits = downstream_fixture(tmp_path)
    with rasterio.open(
        sources.rasters["dem"],
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        nodata=-9999,
        transform=from_origin(west, north, 1, 1),
    ) as dataset:
        dataset.write(np.ones((height, width), dtype="float32"), 1)
    expected = AggregateArtifact(
        filename="result.csv", size=1, sha256="a" * 64, rows=[]
    )
    original_model = Mock(return_value=expected)
    monkeypatch.setattr(
        "eolab_app.processing.downstream_runner.run_original_downstream", original_model
    )
    plan = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    assert calculate_downstream(sources, plan, directory, limits) is expected
    assert original_model.call_args.args[0].rasters["dem"] == sources.rasters["dem"]


@pytest.mark.parametrize("invalid", [-9999, float("nan"), float("inf"), "mask"])
@pytest.mark.parametrize("selected", [True, False])
def test_run_delegates_terrain_values_without_reading_dem_pixels(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    invalid: float | str,
    selected: bool,
) -> None:
    """Pass the unchanged DEM to the model without separately checking its pixels.

    Args:
        tmp_path: Isolated sources and result files.
        monkeypatch: Observe source reads and replace the original-model boundary.
        invalid: NoData, nonfinite elevation or an embedded mask hole.
        selected: Whether the watershed containing the bad cell is needed by this run.
    """
    from shapely.geometry import box, mapping
    from eolab_app.processing import downstream_calculation
    from eolab_app.processing.aggregate_models import AggregateArtifact

    records = [
        {
            "id": i,
            "next": i + 1 if selected and i < 3 else 0,
            "sink": 3 if selected else i,
            "geometry": mapping(box((i - 1) * 2, 0, i * 2, 4)),
        }
        for i in range(1, 4)
    ]
    sources, request, limits = downstream_fixture(tmp_path, records=records)
    with (
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True),
        rasterio.open(sources.rasters["dem"], "r+") as dataset,
    ):
        if invalid == "mask":
            validity = np.full((4, 6), 255, dtype="uint8")
            validity[1, 4] = 0
            dataset.write_mask(validity)
        else:
            elevations = dataset.read(1)
            elevations[1, 4] = invalid
            dataset.write(elevations, 1)
    pixel_reader = Mock(wraps=downstream_calculation.read_native_raster_window)
    monkeypatch.setattr(
        downstream_calculation, "read_native_raster_window", pixel_reader
    )
    expected = AggregateArtifact(
        filename="result.csv", size=1, sha256="a" * 64, rows=[]
    )
    original_model = Mock(return_value=expected)
    monkeypatch.setattr(
        "eolab_app.processing.downstream_runner.run_original_downstream", original_model
    )
    spec = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    assert calculate_downstream(sources, spec, directory, limits) is expected
    original_model.assert_called_once()
    assert original_model.call_args.args[0] is sources
    read_paths = {Path(call.args[0].name) for call in pixel_reader.call_args_list}
    assert sources.rasters["dem"] not in read_paths
    assert sources.rasters["starting_mask"] in read_paths


@pytest.mark.parametrize("tiny", [False, True])
def test_configured_watershed_boundaries_are_left_to_the_original_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tiny: bool
) -> None:
    """Pass configured polygon boundaries to the model without a separate gap check.

    Args:
        tmp_path: Native sources and private result directory.
        monkeypatch: Replace the original-model boundary for subpixel terrain.
        tiny: Use a subpixel basin instead of a disconnected downstream boundary.
    """
    from shapely.geometry import box, mapping
    from eolab_app.processing.aggregate_models import AggregateArtifact

    records = [
        {
            "id": i,
            "next": i + 1 if i < 3 else 0,
            "sink": 3,
            "geometry": mapping(box((i - 1) * 2, 0, i * 2, 4)),
        }
        for i in range(1, 4)
    ]
    records[1]["geometry"] = mapping(
        box(2.9, 1, 3.1, 1.2) if tiny else box(2, 0, 2.4, 4)
    )
    sources, request, limits = downstream_fixture(tmp_path, records=records)
    expected = AggregateArtifact(
        filename="result.csv", size=1, sha256="a" * 64, rows=[]
    )
    original_model = Mock(return_value=expected)
    monkeypatch.setattr(
        "eolab_app.processing.downstream_runner.run_original_downstream",
        original_model,
    )
    spec = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    assert calculate_downstream(sources, spec, directory, limits) is expected
    original_model.assert_called_once()


@pytest.mark.parametrize("missing", ["dem", "values"])
def test_missing_configured_raster_names_the_runtime_input(
    tmp_path: Path, missing: str
) -> None:
    """Source failures identify the absent input without requesting registration.

    Args:
        tmp_path: Native sources for the calculation.
        missing: Raster input removed before native preparation.
    """
    sources, request, limits = downstream_fixture(tmp_path)
    absent = tmp_path / "absent.tif"
    sources = replace(sources, rasters={**sources.rasters, missing: absent})
    label = "configured DEM" if missing == "dem" else "values raster"
    with pytest.raises(ProcessingError, match=label) as failure:
        plan_downstream(sources, request)
    assert failure.value.code == "source_unavailable"
    assert str(absent) not in failure.value.detail
    assert "validat" not in failure.value.detail


def test_worker_captures_configured_watershed_then_keeps_that_identity(
    tmp_path: Path,
) -> None:
    """Fresh runs capture configured sources and execution resolves those descriptors.

    Args:
        tmp_path: Real source files and current catalog descriptors.
    """
    from eolab_app.catalog_selection import SelectionUnavailableError
    from eolab_app.processing.downstream_operation import (
        resolve_downstream_sources,
        resolve_downstream_execution_inputs,
    )

    sources, request, limits = downstream_fixture(tmp_path)
    reader = SimpleNamespace(
        resolve_source=AsyncMock(return_value=sources.network),
        resolve_for_sampling=AsyncMock(return_value=sources.network),
    )
    context = SimpleNamespace(
        areas=reader,
        rasters={
            name: AuthorizedRaster(path, RasterSourceIdentity.read(path))
            for name, path in sources.rasters.items()
            if name != "values"
        },
    )
    values = AuthorizedRaster(
        sources.rasters["values"], RasterSourceIdentity.read(sources.rasters["values"])
    )
    resolved = asyncio.run(resolve_downstream_sources(context, request, values))
    reader.resolve_source.assert_awaited_once_with(request.hydrology.watersheds)
    reader.resolve_for_sampling.assert_not_awaited()
    plan = plan_downstream(resolved, request)
    assert plan.watershedSelection == sources.network.selection
    restored = type(plan).model_validate_json(plan.model_dump_json(by_alias=True))
    assert restored.watershedSelection == sources.network.selection
    execution_sources, _ = asyncio.run(
        resolve_downstream_execution_inputs(context, restored, values)
    )
    assert execution_sources.network == sources.network
    reader.resolve_for_sampling.assert_awaited_once_with(sources.network.selection)
    reader.resolve_for_sampling.side_effect = SelectionUnavailableError("unavailable")
    with pytest.raises(ProcessingError, match="watershed layer"):
        asyncio.run(resolve_downstream_execution_inputs(context, restored, values))
    assert reader.resolve_source.await_count == 1


def test_missing_configured_watershed_names_the_runtime_input(tmp_path: Path) -> None:
    """A missing watershed reports the model's configured input without private paths.

    Args:
        tmp_path: Source fixtures for a failed current-layer resolution.
    """
    from eolab_app.catalog_selection import SelectionUnavailableError
    from eolab_app.processing.downstream_operation import resolve_downstream_sources

    sources, request, _ = downstream_fixture(tmp_path)
    context = SimpleNamespace(
        areas=SimpleNamespace(
            resolve_source=AsyncMock(
                side_effect=SelectionUnavailableError("private path")
            )
        ),
        rasters={},
    )
    values = AuthorizedRaster(
        sources.rasters["values"], RasterSourceIdentity.read(sources.rasters["values"])
    )
    with pytest.raises(ProcessingError, match="configured watershed layer") as failure:
        asyncio.run(resolve_downstream_sources(context, request, values))
    assert failure.value.code == "watershed_unavailable"
    assert "private path" not in failure.value.detail


@pytest.mark.parametrize("input_name", ["watersheds", "dem"])
def test_native_source_failure_identifies_configured_input(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, input_name: str
) -> None:
    """Translate actual native reads into useful errors without a suitability preflight.

    Args:
        tmp_path: Source and run directories.
        monkeypatch: Fail the original model at its source-reading boundary.
        input_name: Native source-reading operation that fails.
    """
    from shapely.geometry import box
    from eolab_app.processing import downstream_runner

    sources, request, limits = downstream_fixture(tmp_path / "sources")
    spec = plan_downstream(sources, request)
    directory = tmp_path / "run"
    directory.mkdir()
    upstream = Mock()
    if input_name == "watersheds":
        upstream.partition_subwatersheds_by_terminal_drain.side_effect = RuntimeError(
            "private path"
        )
    else:
        upstream.partition_subwatersheds_by_terminal_drain.return_value = {
            "drain_3": "partition.gpkg"
        }
        upstream.align_and_resize_raster_on_vector.side_effect = RuntimeError(
            "private path"
        )
    monkeypatch.setattr(
        downstream_runner, "load_beneficiaries", Mock(return_value=upstream)
    )
    monkeypatch.setattr(
        downstream_runner,
        "prepare_starting_inputs",
        Mock(
            return_value=(
                directory / "starting.geojson",
                sources.rasters["starting_mask"],
            )
        ),
    )
    expected_code = (
        "watershed_read_failed" if input_name == "watersheds" else "dem_read_failed"
    )
    with pytest.raises(ProcessingError) as failure:
        downstream_runner.run_original_downstream(
            sources, spec, directory, limits, box(0, 0, 1, 4)
        )
    assert failure.value.code == expected_code
    assert "configured" in failure.value.detail
    assert "private path" not in failure.value.detail
