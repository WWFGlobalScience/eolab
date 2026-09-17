"""Match completed raster statistics to the exact inputs that produced them."""

from dataclasses import asdict
import hashlib
import json

from pydantic import ValidationError

from eolab_app.processing.aggregate_models import (
    AggregateSpec,
    AggregateValue,
    AggregatePlanRequest,
    AggregateArea,
    AggregateGrid,
)
from eolab_app.processing.raster_expression import compile_expression, walk

# Bump when numerical, nodata, mask or area-inclusion semantics change.
CALCULATION_CACHE_VERSION = 2


def calculation_result_cache_keys(
    calculation: AggregateSpec | AggregatePlanRequest,
    source_signature: tuple[int, int, int, int] | None = None,
) -> list[str]:
    """Identify requested values without opening the raster or measuring the area.

    Args:
        calculation: Validated request before planning, or a completed job plan.
        source_signature: Authorized raster metadata, required for a request.
            Stored plans already contain this metadata.

    Returns:
        One hash per formula. Identity includes the immutable raster, exact
        area/filter, parsed formula, requested batch size and area-weight policy.
        The algorithm version covers grid and reduction defaults; titles,
        formula whitespace and resource estimates do not affect matching.

    Raises:
        ValueError: If a request has no authorized source metadata.
        ProcessingError: If a stored expression is invalid.
    """
    alias, source = next(iter(calculation.sources.items()))
    if isinstance(calculation, AggregateSpec):
        source_signature = calculation.sourceSignature
        area = calculation.area.model_dump(mode="json", by_alias=True)
        area.pop("resolved", None)
        if calculation.area.kind == "catalogSelection":
            area.pop("bounds", None)
        target_chunk_pixels = (
            calculation.grid.execution.targetChunkPixels
            if calculation.grid.execution
            else None
        )
    else:
        if source_signature is None:
            raise ValueError("Authorized raster metadata is required")
        if calculation.catalogSelection is not None:
            area = {
                "kind": "catalogSelection",
                "catalogSelection": calculation.catalogSelection.model_dump(
                    mode="json", by_alias=True
                ),
            }
        else:
            area = AggregateArea(
                kind="wholeRaster" if calculation.wholeRaster else "bounds",
                bounds=(
                    calculation.selectedBounds.canonical_tuple()
                    if calculation.selectedBounds
                    else None
                ),
            ).model_dump(mode="json", by_alias=True)
        target_chunk_pixels = calculation.targetChunkPixels
    roots = [
        compile_expression(item.expression, alias) for item in calculation.calculations
    ]
    common = {
        "version": CALCULATION_CACHE_VERSION,
        "source": source.model_dump(mode="json", by_alias=True),
        "sourceSignature": source_signature,
        "area": area,
        "targetChunkPixels": target_chunk_pixels,
        "usesAreaWeights": any(
            node.op == "areaha" for root in roots for node in walk(root)
        ),
    }
    return [
        hashlib.sha256(
            json.dumps(
                {**common, "expression": asdict(root)},
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        ).hexdigest()
        for root in roots
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
                        **payload["row"],
                        "label": calculation.label,
                        "expression": calculation.expression,
                    }
                ).model_dump(mode="json")
            )
        except (ValidationError, TypeError, KeyError):
            return None
    return rows


def prepare_calculation_values_for_cache(
    calculation_plan: AggregateSpec, rows: list[dict[str, object]]
) -> dict[str, dict[str, object]]:
    """Store numerical values and the metadata needed to skip future planning.

    Args:
        calculation_plan: Inputs used for this completed calculation.
        rows: Result rows in the same order as the plan's formulas.

    Returns:
        Input hashes mapped to numerical rows plus path-free area/grid metadata.
        No titles, formula text, source paths, timings or download links are kept.

    Raises:
        ValueError: If the number of results does not match the formulas.
        ValidationError: If a completed result violates the numerical result contract.
    """
    if calculation_plan.area.kind == "aoi":
        # Historical jobs contain geometry snapshots, which this cache must not retain.
        return {}
    return {
        key: {
            "row": AggregateValue.model_validate(row).model_dump(
                mode="json", exclude={"label", "expression"}
            ),
            "area": calculation_plan.area.model_dump(mode="json", by_alias=True),
            "grid": calculation_plan.grid.model_dump(mode="json"),
        }
        for key, row in zip(
            calculation_result_cache_keys(calculation_plan), rows, strict=True
        )
    }


def restore_cached_calculation_plan(
    request: AggregatePlanRequest,
    source_signature: tuple[int, int, int, int],
    cached_results: dict[str, dict[str, object]],
) -> AggregateSpec | None:
    """Build a result-only job from cached values, without estimating raster work.

    Args:
        request: Validated formulas and area whose sources are authorized.
        source_signature: Current authorized raster metadata.
        cached_results: Unexpired cache entries indexed by requested input hash.

    Returns:
        A plan retaining all requested values, or None for a missing, malformed
        or incompatible entry. Retaining rows prevents later cache expiry from
        turning an approved reuse into an unexpected raster calculation.
    """
    keys = calculation_result_cache_keys(request, source_signature)
    entries = [cached_results.get(key) for key in keys]
    if any(entry is None for entry in entries):
        return None
    try:
        area = AggregateArea.model_validate(entries[0]["area"])
        grid = AggregateGrid.model_validate(entries[0]["grid"])
        if any(
            entry["area"] != entries[0]["area"] or entry["grid"] != entries[0]["grid"]
            for entry in entries[1:]
        ):
            return None
        plan = AggregateSpec(
            sources=request.sources,
            sourceSignature=source_signature,
            calculations=request.calculations,
            area=area,
            grid=grid,
        )
        if calculation_result_cache_keys(plan) != keys:
            return None
        rows = restore_cached_calculation_rows(plan, cached_results)
        if rows is None:
            return None
        return AggregateSpec(
            **{**plan.model_dump(mode="json", by_alias=True), "cachedRows": rows}
        )
    except (ValidationError, TypeError, KeyError):
        return None
