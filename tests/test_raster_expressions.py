"""Hand-computed expression semantics and bounded grammar validation."""

import numpy as np
import pytest
from pydantic import ValidationError

from eolab_app.processing.aggregate_models import AggregatePlanRequest
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_expression import Calculation, compile_expression
from test_raster_clips import SOURCE


def calculate(expression: str, data: list, valid: list | None = None) -> dict:
    """Reduce fixture values in two batches to exercise streaming combination.

    Args:
        expression: Single-source scalar calculation.
        data: Stored native values.
        valid: Optional explicit source mask.

    Returns:
        Typed result and coverage diagnostics.
    """
    values = np.array(data, dtype=np.float64)
    masks = np.isfinite(values) if valid is None else np.array(valid, dtype=bool)
    calculation = Calculation(compile_expression(expression, "a"))
    for block, mask in zip(np.array_split(values, 2), np.array_split(masks, 2)):
        calculation.process_tile(block, mask)
    return calculation.result()


@pytest.mark.parametrize(
    "expression,expected",
    [
        ("count(a > 10)", 2),
        ("sum(a > 10)", 2),
        ("sum(a, where=a > 10)", 50),
        ("mean(a)", 9.6),
        ("min(a)", -2),
        ("max(a)", 30),
        ("sum(a * 2 + 1)", 101),
        ("count(!(a < 0) && a < 30 || a == -2)", 4),
        ("100 * count(a > 10) / count(a)", 40),
        ("max(a) - min(a)", 32),
        ("sum(1, where=a > 10)", 2),
    ],
)
def test_numeric_logical_conditional_and_scalar_arithmetic(
    expression: str, expected: float
) -> None:
    """Distinguish counting predicates from summing selected native values.

    Args:
        expression: Grammar under test.
        expected: Hand-computed numerical result.
    """
    result = calculate(expression, [-2, 0, 0, 20, 30, np.nan])
    assert float(result["value"]) == pytest.approx(expected)
    assert result["state"] == "ok"
    assert result["aggregates"][0]["validPixels"] == 5


@pytest.mark.parametrize(
    "expression",
    [
        "",
        "a > 10",
        "sum(b)",
        "sum(a.__class__)",
        "sum(a[0])",
        "sum(__import__('os'))",
        "sum(a); max(a)",
        "eval(a)",
        "sum(sum(a))",
        "sum(a,where=mean(a)>0)",
        "mean(a>0)",
        "sum(a && 1)",
        "sum(!a)",
        "sum(a + (a>0))",
        "sum(a)/0",
        "count(a)>0",
        "sum(a,where=a)",
        "sum(1)",
        "sum(a)+1e999",
        "areaha(a)",
        "areaha(a==4,where=a>0)",
        "sum(" + "(" * 30 + "a" + ")" * 30 + ")",
        "sum(a" + "+a" * 300 + ")",
    ],
)
def test_rejects_unsupported_unsafe_or_unbounded_language(expression: str) -> None:
    """Invalid syntax never reaches a worker or Python evaluation.

    Args:
        expression: Forbidden or invalid input.
    """
    with pytest.raises(ProcessingError, match="."):
        compile_expression(expression, "a")


def test_nodata_empty_selection_and_arithmetic_states() -> None:
    """Missing source data, zero matches, and invalid arithmetic remain distinct."""
    assert calculate("count(a)", [0, 2], [False, False])["state"] == "no_valid_data"
    assert calculate("sum(a>10)", [0, 2])["value"] == "0"
    assert calculate("sum(a>10)", [0, 2])["state"] == "no_matches"
    assert calculate("mean(a,where=a>10)", [0, 2])["value"] is None
    partial = calculate("sum(10/a)", [0, 2])
    assert float(partial["value"]) == 5
    assert partial["aggregates"][0]["invalidArithmeticPixels"] == 1
    assert calculate("sum(10/a)", [0, 0])["state"] == "invalid_arithmetic"
    assert calculate("sum(a * (1 / (2-2)))", [1, 2])["state"] == "invalid_arithmetic"
    assert (
        calculate("sum(a)/(count(a)-count(a))", [1, 2])["state"] == "invalid_arithmetic"
    )
    assert calculate("sum(a)", [1e308, 1e308])["state"] == "overflow"
    assert float(calculate("mean(a)", [1e308, 1e308])["value"]) == 1e308
    # Missing input stays missing even when the other OR operand is true.
    logical = calculate("count((10/a > 1) || a == 0)", [0, 2])
    assert logical["value"] == "1"
    assert logical["aggregates"][0]["invalidArithmeticPixels"] == 1


def test_counts_remain_lossless_decimal_integers() -> None:
    """Counts use integer accumulation and strings at the JSON boundary."""
    calculation = Calculation(compile_expression("count(a)", "a"))
    reduction = next(iter(calculation.reductions.values()))
    reduction.valid = reduction.matched = 2**53 + 1
    assert calculation.result()["value"] == "9007199254740993"
    assert calculation.result()["valueType"] == "integer"


@pytest.mark.parametrize(
    "changes",
    [
        {"wholeRaster": None},
        {"wholeRaster": False},
        {"selectedBounds": {"west": 0, "south": 0, "east": 1, "north": 1}},
        {"sources": {"a": SOURCE, "b": SOURCE}},
        {"sources": {"sum": SOURCE}},
        {"path": "/scan-source/x.tif"},
        {"calculations": [{"label": "bad", "expression": "a>0"}]},
        {"calculations": [{"label": "same", "expression": "count(a)"}] * 2},
    ],
)
def test_request_is_explicit_single_source_and_bounded(changes: dict) -> None:
    """Reject ambiguous scope and untyped expressions before native I/O.

    Args:
        changes: Invalid request modifications.
    """
    request = {
        "sources": {"a": SOURCE},
        "wholeRaster": True,
        "calculations": [{"label": "Count", "expression": "count(a)"}],
        **changes,
    }
    with pytest.raises(ValidationError):
        AggregatePlanRequest.model_validate(request)
