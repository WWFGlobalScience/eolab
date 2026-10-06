"""Cache identity and result-file tests using the production calculation functions."""

from pathlib import Path
import json

import numpy as np
import pytest

import eolab_app.processing.calculation_cache as cache
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregatePlanRequest,
    AggregateSpec,
    NamedCalculation,
    PixelPoint,
    UnpreparedCalculation,
)
from eolab_app.processing.shared_calculations import identify_shared_calculation
from eolab_app.processing.raster_aggregate import (
    calculate_raster_statistics_for_area,
    write_statistics_result,
)
from test_raster_aggregates import make_spec, LIMITS
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from test_raster_clips import write_source


@pytest.fixture
def calculation_plan(tmp_path: Path) -> AggregateSpec:
    """Plan two formulas over a small real raster.

    Args:
        tmp_path: Private raster directory.

    Returns:
        Production-validated sum and mean plan.
    """
    path = write_source(
        tmp_path / "source.tif", np.arange(100, dtype="int16").reshape(10, 10)
    )
    return make_spec(path, ["sum(a)", "mean(a)"])


def test_cache_ignores_titles_whitespace_and_formula_order(
    calculation_plan: AggregateSpec,
) -> None:
    """Parsed formulas preserve reuse after edits to labels and spacing.

    Args:
        calculation_plan: Two-formula native plan.
    """
    keys = cache.calculation_result_cache_keys(calculation_plan)
    changed = calculation_plan.model_copy(
        update={
            "calculations": (
                NamedCalculation(label="Other mean", expression=" mean ( a ) "),
                NamedCalculation(label="Other sum", expression="sum (a)"),
            )
        }
    )
    assert cache.calculation_result_cache_keys(changed) == keys[::-1]
    single = calculation_plan.model_copy(
        update={"calculations": calculation_plan.calculations[:1]}
    )
    assert cache.calculation_result_cache_keys(single) == keys[:1]


@pytest.mark.parametrize("mixed", [False, True])
def test_pixel_cache_and_shared_work_retain_exact_location(
    tmp_path: Path, mixed: bool
) -> None:
    """A cached point survives restoration and cannot serve another map click.

    Args:
        tmp_path: Private raster, artifacts and provenance files.
        mixed: Include an area statistic beside the point formula.
    """
    path = write_source(
        tmp_path / "source.tif", np.arange(100, dtype="int16").reshape(10, 10)
    )
    point = PixelPoint(longitude=0.035, latitude=9.955)
    formulas = ["pixelValue(a)", "mean(a)"] if mixed else ["pixelValue(a)"]
    plan = make_spec(path, formulas, pixel_point=point)
    request = AggregatePlanRequest(
        sources=plan.sources,
        calculations=plan.calculations,
        wholeRaster=True,
        pixelPoint=point,
    )
    keys = cache.calculation_result_cache_keys(request, plan.sourceSignature)
    assert keys == cache.calculation_result_cache_keys(plan)
    artifact = calculate_raster_statistics_for_area(path, plan, tmp_path, LIMITS)
    saved = cache.prepare_calculation_values_for_cache(plan, artifact.rows)
    restored = cache.restore_cached_calculation_plan(
        request, plan.sourceSignature, saved
    )
    assert restored is not None
    assert restored.pixelPoint == point
    assert [row.value for row in restored.cachedRows] == [
        row["value"] for row in artifact.rows
    ]
    assert float(restored.cachedRows[0].value) == 43
    assert cache.calculation_result_cache_keys(restored) == keys
    moved = AggregatePlanRequest.model_validate(
        {
            **request.model_dump(mode="json", by_alias=True),
            "pixelPoint": {"longitude": 0.045, "latitude": point.latitude},
        }
    )
    assert cache.calculation_result_cache_keys(moved, plan.sourceSignature) != keys
    assert identify_shared_calculation(
        UnpreparedCalculation(request=moved)
    ) != identify_shared_calculation(UnpreparedCalculation(request=request))
    assert (
        cache.restore_cached_calculation_plan(moved, plan.sourceSignature, saved)
        is None
    )
    cached_directory = tmp_path / "cached"
    cached_directory.mkdir()
    write_statistics_result(
        restored,
        [row.model_dump(mode="json") for row in restored.cachedRows],
        cached_directory,
        cache_hit=True,
    )
    provenance = json.loads((cached_directory / "provenance.json").read_text())
    assert provenance["pixelPoint"] == point.model_dump()
    assert provenance["cache_hit"] is True


@pytest.mark.parametrize(
    "change", ["raster", "signature", "area", "formula", "batch", "version"]
)
def test_changed_inputs_cannot_reuse_results(
    calculation_plan: AggregateSpec, change: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Changing a result-defining input changes its identity.

    Args:
        calculation_plan: Original input plan.
        change: Input or algorithm version to change.
        monkeypatch: Temporary algorithm-version replacement.
    """
    before = cache.calculation_result_cache_keys(calculation_plan)
    if change == "raster":
        source = next(iter(calculation_plan.sources.values())).model_copy(
            update={"item_id": "other"}
        )
        calculation_plan = calculation_plan.model_copy(
            update={"sources": {"a": source}}
        )
    elif change == "signature":
        calculation_plan = calculation_plan.model_copy(
            update={"sourceSignature": (1, 2)}
        )
    elif change == "area":
        calculation_plan = calculation_plan.model_copy(
            update={"area": AggregateArea(kind="bounds", bounds=(0, 0, 1, 1))}
        )
    elif change == "formula":
        calculation_plan = calculation_plan.model_copy(
            update={
                "calculations": (
                    NamedCalculation(label="sum", expression="sum(a > 3)"),
                )
            }
        )
    elif change == "batch":
        calculation_plan = calculation_plan.model_copy(
            update={
                "grid": calculation_plan.grid.model_copy(
                    update={
                        "execution": calculation_plan.grid.execution.model_copy(
                            update={"targetChunkPixels": 1024}
                        )
                    }
                )
            }
        )
    else:
        monkeypatch.setattr(
            cache, "CALCULATION_CACHE_VERSION", cache.CALCULATION_CACHE_VERSION + 1
        )
    assert cache.calculation_result_cache_keys(calculation_plan) != before


def test_cached_csv_has_current_labels_and_no_old_timings(
    calculation_plan: AggregateSpec, tmp_path: Path
) -> None:
    """Reused values produce fresh private files, without old performance data.

    Args:
        calculation_plan: Real sum and mean input plan.
        tmp_path: Private raster and result directories.
    """
    original = tmp_path / "original"
    original.mkdir()
    artifact = calculate_raster_statistics_for_area(
        tmp_path / "source.tif", calculation_plan, original, LIMITS
    )
    values = cache.prepare_calculation_values_for_cache(calculation_plan, artifact.rows)
    assert all(
        "label" not in value and "expression" not in value for value in values.values()
    )
    changed = calculation_plan.model_copy(
        update={
            "calculations": (
                NamedCalculation(label="New sum", expression="sum ( a )"),
                NamedCalculation(label="New mean", expression="mean(a)"),
            )
        }
    )
    rows = cache.restore_cached_calculation_rows(changed, values)
    assert rows is not None
    assert [row["value"] for row in rows] == [row["value"] for row in artifact.rows]
    directory = tmp_path / "cached"
    directory.mkdir()
    reused = write_statistics_result(changed, rows, directory, cache_hit=True)
    assert (
        reused.cache_hit
        and reused.performance is None
        and reused.execution_timing is None
    )
    assert "New sum,sum ( a )" in (directory / "result.csv").read_text()
    provenance = json.loads((directory / "provenance.json").read_text())
    assert provenance["cache_hit"] is True
    assert provenance["performance"] is None
    assert cache.restore_cached_calculation_rows(changed, {}) is None
    values[next(iter(values))] = {"state": "invalid"}
    assert cache.restore_cached_calculation_rows(changed, values) is None


def test_vector_filter_source_and_layer_are_part_of_cache_identity(
    calculation_plan: AggregateSpec,
) -> None:
    """Two vector selections cannot share a value merely because their bounds match.

    Args:
        calculation_plan: Native raster plan whose area is replaced below.
    """
    from eolab_app.catalog_selection import CatalogSelection
    from eolab_app.attribute_filter import VectorFilter

    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="countries",
        assetKey="data",
        layerName="countries",
        sourceSignature="a" * 64,
        filter=VectorFilter(
            enabled=True,
            match="all",
            rules=[{"field": "iso3", "operator": "eq", "value": "PER"}],
        ),
    )
    area = AggregateArea(
        kind="catalogSelection", bounds=(-80, -20, -60, 0), catalogSelection=selection
    )
    plan = calculation_plan.model_copy(update={"area": area})
    expected = cache.calculation_result_cache_keys(plan)
    for update in (
        {"item_id": "different-vector"},
        {"sourceSignature": "b" * 64},
        {"layerName": "other"},
        {
            "filter": VectorFilter(
                enabled=True,
                match="all",
                rules=[{"field": "iso3", "operator": "eq", "value": "BRA"}],
            )
        },
    ):
        changed_area = area.model_copy(
            update={"catalogSelection": selection.model_copy(update=update)}
        )
        assert (
            cache.calculation_result_cache_keys(
                plan.model_copy(update={"area": changed_area})
            )
            != expected
        )


def test_worker_reuses_results_after_authorization(
    calculation_plan: AggregateSpec, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exercise cache lookup and fresh publication through the real worker.

    Args:
        calculation_plan: Production native plan.
        tmp_path: Private source and attempt directories.
        monkeypatch: Replace process transport, retaining the real calculation.
    """
    import asyncio
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock
    from eolab_app.processing.artifacts import LocalJobArtifacts
    from eolab_app.processing.models import ProcessingError
    from eolab_app.processing.job_preparation import prepare_aggregate_job
    from eolab_app.processing.worker import ProcessingWorker
    import eolab_app.processing.worker as worker_module

    artifacts = LocalJobArtifacts(tmp_path / "artifacts")
    artifacts.initialize()
    limits = RasterAggregateLimits(free_space_floor=0)
    authorizer = SimpleNamespace(
        authorize=AsyncMock(
            return_value=SimpleNamespace(source_path=tmp_path / "source.tif")
        )
    )
    store = Mock()
    store.get_cached_calculation_results.return_value = {}
    store.heartbeat.return_value = True
    store.finish.return_value = True
    prepared = prepare_aggregate_job(calculation_plan, limits)
    now = datetime.now(timezone.utc)
    row = {
        "id": "a" * 32,
        "status": "running",
        "attempt_id": "b" * 32,
        "spec": prepared.specification,
        "reserved_bytes": prepared.reserved_bytes,
        "created_at": now,
        "updated_at": now,
    }
    store.claim_next_job.return_value = row
    calls = []

    async def calculate_in_test_process(
        target: object, arguments: tuple, timeout: float, native: object
    ) -> object:
        """Use the real kernel while counting process-dispatch requests.

        Args:
            target: Native operation dispatcher.
            arguments: Action and calculation arguments.
            timeout: Worker time budget.
            native: Optional warm process.

        Returns:
            The production kernel result in the normal transport envelope.
        """
        calls.append(arguments[0])
        value = calculate_raster_statistics_for_area(*arguments[1])
        return SimpleNamespace(value=("ok", value), timing=None)

    monkeypatch.setattr(worker_module, "run_process", calculate_in_test_process)
    worker = ProcessingWorker(authorizer, store, artifacts, limits)
    assert asyncio.run(worker.run_once())
    first = store.finish.call_args.args[2]
    assert first is not None and not first.cache_hit
    store.get_cached_calculation_results.return_value = store.finish.call_args.kwargs[
        "reusable_results"
    ]
    store.claim_next_job.return_value = {**row, "id": "c" * 32, "attempt_id": "d" * 32}
    assert asyncio.run(worker.run_once())
    second = store.finish.call_args.args[2]
    assert second.cache_hit and second.rows == first.rows
    assert second.performance is None
    assert store.finish.call_args.kwargs["reusable_results"] is None
    assert calls == ["calculate"]
    assert authorizer.authorize.await_count == 2
    assert artifacts.result_path("b" * 32, result_name="result.csv").exists()
    assert artifacts.result_path("d" * 32, result_name="result.csv").exists()

    authorizer.authorize.side_effect = ProcessingError(
        "source_unavailable", "Source unavailable", 409
    )
    store.claim_next_job.return_value = {**row, "id": "e" * 32, "attempt_id": "f" * 32}
    assert asyncio.run(worker.run_once())
    assert store.finish.call_args.args[2] is None
    assert calls == ["calculate"]


@pytest.mark.parametrize("area_kind", ["wholeRaster", "bounds", "catalogSelection"])
def test_cache_hit_skips_planning_and_pins_values(
    calculation_plan: AggregateSpec,
    area_kind: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reuse all area types without native planning, including after cache eviction.

    Args:
        calculation_plan: Real raster grid and formulas.
        area_kind: Whole raster, map box or filtered vector to exercise.
        monkeypatch: Forbid native planning and polygon summary reads.
    """
    import asyncio
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock
    from eolab_app.catalog_selection import CatalogSelection
    from eolab_app.processing.aggregate_models import (
        AggregatePlanRequest,
    )
    from eolab_app.processing.models import ProcessingError

    if area_kind == "catalogSelection":
        area = AggregateArea(
            kind=area_kind,
            bounds=(-80, -20, -60, 0),
            catalogSelection=CatalogSelection(
                collectionId="eolab-mounted-vectors",
                itemId="countries",
                assetKey="data",
                layerName="countries",
                sourceSignature="a" * 64,
                filter={"enabled": False, "match": "all", "rules": []},
            ),
        )
        area_input = {"catalogSelection": area.catalogSelection}
    elif area_kind == "bounds":
        area = AggregateArea(kind="bounds", bounds=(-80, -20, -60, 0))
        area_input = {
            "selectedBounds": dict(zip(("west", "south", "east", "north"), area.bounds))
        }
    else:
        area = AggregateArea(kind="wholeRaster")
        area_input = {"wholeRaster": True}
    calculation_plan = calculation_plan.model_copy(update={"area": area})
    request = AggregatePlanRequest(
        sources=calculation_plan.sources,
        calculations=calculation_plan.calculations,
        **area_input,
    )
    rows = [
        {
            "label": item.label,
            "expression": item.expression,
            "value": "42",
            "valueType": "integer",
            "state": "ok",
            "aggregates": [],
        }
        for item in calculation_plan.calculations
    ]
    saved = cache.prepare_calculation_values_for_cache(calculation_plan, rows)
    assert cache.calculation_result_cache_keys(
        request, calculation_plan.sourceSignature
    ) == list(saved)
    authorizer = SimpleNamespace(
        authorize=AsyncMock(
            return_value=SimpleNamespace(
                source_signature=SimpleNamespace(
                    to_catalog=lambda: calculation_plan.sourceSignature
                )
            )
        )
    )
    areas = SimpleNamespace(resolve_for_sampling=AsyncMock())
    store = Mock()
    from test_processing_timings import configure_prepared_job_store
    from eolab_app.processing.aggregate_models import UnpreparedCalculation
    from eolab_app.processing.worker import ProcessingWorker
    import eolab_app.processing.worker as worker_module

    row = {
        "id": "a" * 32,
        "attempt_id": "b" * 32,
        "spec": UnpreparedCalculation(request=request).model_dump(
            mode="json", by_alias=True
        ),
        "updated_at": datetime.now(timezone.utc),
    }
    configure_prepared_job_store(store, row)
    store.get_cached_calculation_results.return_value = saved
    store.heartbeat.return_value = True
    worker = ProcessingWorker(
        authorizer, store, Mock(), RasterAggregateLimits(), areas=areas
    )
    forbidden = AsyncMock(
        side_effect=AssertionError("Cache reuse must not inspect raster metadata")
    )
    monkeypatch.setattr(worker_module, "run_process", forbidden)
    asyncio.run(worker._prepare_calculation(row))
    assert row["preparation"]["cacheHit"]
    forbidden.assert_not_called()
    retained = AggregateSpec.model_validate(row["spec"])
    assert retained.cachedRows[0].value == "42"
    assert row["reserved_bytes"] == worker.aggregate_limits.result_reservation_bytes
    # The prepared copy retains values even after cache eviction.
    store.get_cached_calculation_results.return_value = {}
    assert retained.cachedRows[0].value == "42"
    denied = (
        areas.resolve_for_sampling
        if area_kind == "catalogSelection"
        else authorizer.authorize
    )
    denied.side_effect = ProcessingError(
        "source_unavailable", "Source unavailable", 409
    )
    row["spec"] = UnpreparedCalculation(request=request).model_dump(
        mode="json", by_alias=True
    )
    with pytest.raises(ProcessingError):
        asyncio.run(worker._prepare_calculation(row))


def test_partial_or_malformed_cache_still_requires_normal_planning(
    calculation_plan: AggregateSpec,
) -> None:
    """Missing or corrupt values cannot be promoted to an executable cached plan.

    Args:
        calculation_plan: Two-formula plan.
    """
    from eolab_app.processing.aggregate_models import AggregatePlanRequest

    request = AggregatePlanRequest(
        sources=calculation_plan.sources,
        calculations=calculation_plan.calculations,
        wholeRaster=True,
    )
    assert (
        cache.restore_cached_calculation_plan(
            request, calculation_plan.sourceSignature, {}
        )
        is None
    )
    entries = {
        key: {"row": {}, "area": {}, "grid": {}}
        for key in cache.calculation_result_cache_keys(
            request, calculation_plan.sourceSignature
        )
    }
    assert (
        cache.restore_cached_calculation_plan(
            request, calculation_plan.sourceSignature, entries
        )
        is None
    )
