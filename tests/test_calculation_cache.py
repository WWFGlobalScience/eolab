"""Cache identity and result-file tests using the production calculation functions."""

from pathlib import Path
import json

import numpy as np
import pytest

import eolab_app.processing.calculation_cache as cache
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateSpec,
    NamedCalculation,
)
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


@pytest.mark.parametrize(
    "change", ["raster", "signature", "area", "formula", "grid", "version"]
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
    elif change == "grid":
        calculation_plan = calculation_plan.model_copy(
            update={
                "grid": calculation_plan.grid.model_copy(update={"nodata": "-9999"})
            }
        )
    else:
        monkeypatch.setattr(cache, "CALCULATION_CACHE_VERSION", 2)
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
    from eolab_app.processing.service import prepare_aggregate_job
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
        "attempt_id": "b" * 32,
        "spec": prepared.specification,
        "reserved_bytes": prepared.reserved_bytes,
        "created_at": now,
        "updated_at": now,
    }
    store.claim.return_value = row
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
    store.claim.return_value = {**row, "id": "c" * 32, "attempt_id": "d" * 32}
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
    store.claim.return_value = {**row, "id": "e" * 32, "attempt_id": "f" * 32}
    assert asyncio.run(worker.run_once())
    assert store.finish.call_args.args[2] is None
    assert calls == ["calculate"]
