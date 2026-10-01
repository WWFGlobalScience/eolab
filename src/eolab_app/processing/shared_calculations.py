"""Match active calculations and preserve each caller's formula labels."""

from dataclasses import asdict
import hashlib
import json
from typing import Any

from eolab_app.processing.aggregate_models import UnpreparedCalculation
from eolab_app.processing.clip_models import UnpreparedClip
from eolab_app.processing.calculation_cache import CALCULATION_CACHE_VERSION
from eolab_app.processing.raster_expression import compile_expression


def identify_shared_calculation(
    inputs: UnpreparedCalculation | UnpreparedClip,
) -> str:
    """Hash the complete computation without caller IDs or display labels.

    Catalog sources are immutable within this deployment and have the same
    authorization policy for every browser. The worker authorizes them before
    producing any result. Polygon uploads must already be owned and loaded by
    the submitting caller; only their validated content hash affects identity.
    Submission retry identifiers are excluded when a calculation request is
    reused directly, so they cannot split otherwise identical shared work.

    Args:
        inputs: Validated clip or summary inputs, with owned polygons resolved.

    Returns:
        A stable hash for matching queued/running work in this deployment.

    Raises:
        ProcessingError: If an expression cannot be compiled.
        ValueError: If inputs cannot be serialized as finite JSON.
    """
    request = inputs.request.model_dump(mode="json", by_alias=True)
    if isinstance(inputs, UnpreparedCalculation):
        request.pop("requestId", None)
        alias = next(iter(inputs.request.sources))
        request["calculations"] = [
            asdict(compile_expression(item.expression, alias))
            for item in inputs.request.calculations
        ]
        if inputs.polygonArea is not None:
            request["polygonArea"] = {"sha256": inputs.polygonArea.geometryHash}
    return hashlib.sha256(
        json.dumps(
            {
                "operation": inputs.operation,
                "version": CALCULATION_CACHE_VERSION,
                "request": request,
            },
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
    ).hexdigest()


def present_calculation_rows(
    rows: list[dict[str, Any]],
    presentation: dict[str, Any],
) -> list[dict[str, Any]]:
    """Apply the subscriber's labels and formula text to shared numerical rows.

    Args:
        rows: Shared result rows in request order.
        presentation: Subscriber's validated calculations in the same order.

    Returns:
        New rows with this caller's labels and expressions.

    Raises:
        ValueError: If persisted result and calculation counts disagree.
    """
    return [
        {**row, "label": calculation["label"], "expression": calculation["expression"]}
        for row, calculation in zip(rows, presentation["calculations"], strict=True)
    ]
