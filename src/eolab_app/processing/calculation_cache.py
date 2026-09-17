"""Match completed raster statistics to the exact inputs that produced them."""

from dataclasses import asdict
import hashlib
import json

from pydantic import ValidationError

from eolab_app.processing.aggregate_models import AggregateSpec, AggregateValue
from eolab_app.processing.raster_expression import compile_expression

# Bump when numerical, nodata, mask or area-inclusion semantics change.
CALCULATION_CACHE_VERSION = 1


def calculation_result_cache_keys(calculation_plan: AggregateSpec) -> list[str]:
    """Identify each formula's result independently of its title or whitespace.

    Args:
        calculation_plan: Validated source, selected area, formulas and grid.
            Raster inputs are immutable under the catalog's source contract.

    Returns:
        One SHA-256 key per formula, in the same order. Keys include source
        identity, exact area/filter, numerical grid and expression syntax tree.
        Execution dimensions remain part of the key because reduction order can
        affect floating-point rounding. Resource estimates and labels do not.

    Raises:
        ProcessingError: If a stored formula no longer passes language validation.
    """
    alias, source = next(iter(calculation_plan.sources.items()))
    grid = calculation_plan.grid.model_dump(mode="json")
    for estimate in ("estimatedMemoryBytes", "decodedBytes", "nativeBlocks"):
        grid.pop(estimate, None)
    common = {
        "version": CALCULATION_CACHE_VERSION,
        "source": source.model_dump(mode="json", by_alias=True),
        "sourceSignature": calculation_plan.sourceSignature,
        "area": calculation_plan.area.model_dump(mode="json", by_alias=True),
        "grid": grid,
    }
    return [
        hashlib.sha256(
            json.dumps(
                {
                    **common,
                    "expression": asdict(compile_expression(item.expression, alias)),
                },
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        ).hexdigest()
        for item in calculation_plan.calculations
    ]


def restore_cached_calculation_rows(
    calculation_plan: AggregateSpec,
    cached_results: dict[str, dict[str, object]],
) -> list[dict[str, object]] | None:
    """Restore all requested values with this request's labels and formulas.

    Args:
        calculation_plan: Currently authorized calculation inputs.
        cached_results: Unexpired database payloads indexed by input hash.

    Returns:
        Validated result rows, or None if any value is missing or malformed.
        Partial hits intentionally fall back to the normal combined calculation.
    """
    rows = []
    for key, calculation in zip(
        calculation_result_cache_keys(calculation_plan),
        calculation_plan.calculations,
        strict=True,
    ):
        payload = cached_results.get(key)
        if payload is None:
            return None
        try:
            rows.append(
                AggregateValue.model_validate(
                    {
                        **payload,
                        "label": calculation.label,
                        "expression": calculation.expression,
                    }
                ).model_dump(mode="json")
            )
        except (ValidationError, TypeError):
            return None
    return rows


def prepare_calculation_values_for_cache(
    calculation_plan: AggregateSpec, rows: list[dict[str, object]]
) -> dict[str, dict[str, object]]:
    """Remove presentation text before storing completed numerical results.

    Args:
        calculation_plan: Inputs used for this completed calculation.
        rows: Result rows in the same order as the plan's formulas.

    Returns:
        Input hashes mapped to small result payloads, without titles, formula
        text, source paths, job ownership, timings or download links.

    Raises:
        ValueError: If the number of results does not match the formulas.
        ValidationError: If a completed result violates the numerical result contract.
    """
    return {
        key: AggregateValue.model_validate(row).model_dump(
            mode="json", exclude={"label", "expression"}
        )
        for key, row in zip(
            calculation_result_cache_keys(calculation_plan), rows, strict=True
        )
    }
