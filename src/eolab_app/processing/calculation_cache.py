"""Match completed raster statistics to the exact inputs that produced them."""

from dataclasses import asdict
import hashlib
import json

from pydantic import ValidationError

from eolab_app.sampling_box import sampling_box_bounds
from eolab_app.processing.aggregate_models import (
    AggregateSpec,
    AggregateValue,
    AggregatePlanRequest,
    AggregateArea,
)
from eolab_app.processing.raster_expression import compile_expression, walk

# Bump when numerical, nodata, mask or area-inclusion semantics change.
CALCULATION_CACHE_VERSION = 3


def calculation_result_cache_keys(
    calculation: AggregateSpec | AggregatePlanRequest,
    source_signature: tuple[int, int, int, int] | None = None,
    source_checksum: str | None = None,
) -> list[str]:
    """Identify requested values without opening the raster or measuring the area.

    Args:
        calculation: Validated request before planning, or a completed job plan.
        source_signature: Captured metadata for a catalog raster request.
            Private files use their published checksum; stored plans carry the
            identity appropriate to their source.
        source_checksum: Published checksum when the input is a private file.

    Returns:
        One hash per formula. Identity includes the immutable raster, exact
        area/filter, parsed formula, requested batch size and area-weight policy.
        The algorithm version covers grid and reduction defaults; titles,
        formula whitespace and resource estimates do not affect matching.

    Raises:
        ValueError: If a request has neither catalog identity nor a published checksum.
        ProcessingError: If a stored expression is invalid.
    """
    alias, source = next(iter(calculation.sources.items()))
    if isinstance(calculation, AggregateSpec):
        source_signature = calculation.sourceSignature
        source_checksum = calculation.sourceChecksum
        area = calculation.area.model_dump(mode="json", by_alias=True)
        area.pop("resolved", None)
        if calculation.area.kind == "polygons":
            area = {"kind": "polygons", "geometryHash": calculation.area.geometryHash}
        if calculation.area.kind == "catalogSelection":
            area.pop("bounds", None)
        target_chunk_pixels = calculation.grid.execution.targetChunkPixels
    else:
        if source_signature is None and source_checksum is None:
            raise ValueError("Catalog identity or a published checksum is required")
        if calculation.polygonArea is not None:
            area = {"kind": "polygons", "geometryHash": calculation.polygonArea.sha256}
        elif calculation.samplingBox is not None:
            area = AggregateArea(
                kind="samplingBox",
                bounds=sampling_box_bounds(calculation.samplingBox),
                samplingBox=calculation.samplingBox,
            ).model_dump(mode="json", by_alias=True)
        elif calculation.catalogSelection is not None:
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
        "area": area,
        "targetChunkPixels": target_chunk_pixels,
        "usesAreaWeights": any(
            node.op == "areaha" for root in roots for node in walk(root)
        ),
    }
    if source_signature is not None:
        common["sourceSignature"] = source_signature
    if source_checksum is not None:
        common["sourceChecksum"] = source_checksum
    if calculation.pixelPoint is not None and any(
        node.op == "pixelValue" for root in roots for node in walk(root)
    ):
        common["pixelPoint"] = calculation.pixelPoint.model_dump(mode="json")
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
    """Prepare cache entries containing numerical results and their area/grid metadata.

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

    return {
        key: {
            "row": AggregateValue.model_validate(row).model_dump(
                mode="json", exclude={"label", "expression"}
            ),
            "area": (
                calculation_plan.area.model_dump(
                    mode="json", by_alias=True, exclude={"geometries"}
                )
                if calculation_plan.area.kind == "polygons"
                else calculation_plan.area.model_dump(mode="json", by_alias=True)
            ),
            "grid": calculation_plan.grid.model_dump(mode="json"),
        }
        for key, row in zip(
            calculation_result_cache_keys(calculation_plan), rows, strict=True
        )
    }


def restore_cached_calculation_plan(
    request: AggregatePlanRequest,
    source_signature: tuple[int, int, int, int] | None,
    cached_results: dict[str, dict[str, object]],
    polygon_area: AggregateArea | None = None,
    source_checksum: str | None = None,
) -> AggregateSpec | None:
    """Build a result-only job from cached values, without estimating raster work.

    Args:
        request: Validated formulas and area whose sources are authorized.
        source_signature: Captured catalog metadata, or None for a private file.
        cached_results: Unexpired cache entries indexed by requested input hash.
        polygon_area: Authorized polygon input, kept out of shared result-cache records.
        source_checksum: Published identity for a private raster input.

    Returns:
        A plan retaining all requested values, or None for a missing, malformed
        or incompatible entry. Retaining rows prevents later cache expiry from
        turning an approved reuse into an unexpected raster calculation.
    """
    keys = calculation_result_cache_keys(request, source_signature, source_checksum)
    entries = [cached_results.get(key) for key in keys]
    if any(entry is None for entry in entries):
        return None
    try:
        if any(
            entry["area"] != entries[0]["area"] or entry["grid"] != entries[0]["grid"]
            for entry in entries[1:]
        ):
            return None
        plan = AggregateSpec(
            sources=request.sources,
            sourceSignature=source_signature,
            sourceChecksum=source_checksum,
            calculations=request.calculations,
            pixelPoint=request.pixelPoint,
            area=polygon_area if request.polygonArea else entries[0]["area"],
            grid=entries[0]["grid"],
            cachedRows=tuple(
                {
                    **entry["row"],
                    "label": calculation.label,
                    "expression": calculation.expression,
                }
                for entry, calculation in zip(
                    entries, request.calculations, strict=True
                )
            ),
        )
        if calculation_result_cache_keys(plan) != keys:
            return None
        return plan
    except (ValidationError, TypeError, KeyError):
        return None
