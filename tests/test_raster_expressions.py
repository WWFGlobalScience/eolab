"""Hand-computed expression semantics and bounded grammar validation."""

import statistics

import numpy as np
import pytest
from pydantic import ValidationError

from eolab_app.processing.aggregate_models import AggregatePlanRequest
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_expression import Calculation, compile_expression
from raster_source_support import SOURCE


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
        ("stdev(a)", statistics.pstdev([-2, 0, 0, 20, 30])),
        ("stdev(a * 2, where=a > 10)", 10),
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
        "stdev(a>0)",
        "stdev(mean(a))",
        "stdev(a,where=stdev(a)>0)",
        "stddev(a)",
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
        "pixelValue(a+1)",
        "pixelValue(1)",
        "pixelValue(a,where=a>0)",
        "pixelValue(mean(a))",
        "mean(pixelValue(a))",
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
    reduction.valid_pixel_count = reduction.matched_pixel_count = 2**53 + 1
    assert calculation.result()["value"] == "9007199254740993"
    assert calculation.result()["valueType"] == "integer"


@pytest.mark.parametrize("tile_size", [1, 2, 7, 256, 1024])
@pytest.mark.parametrize(
    "values",
    [
        [-2.0, 0.0, 0.0, 20.0, 30.0],
        [1e12 + (i % 17) * 0.125 for i in range(513)],
        [1e15 + (i % 17) * 0.125 for i in range(513)],
        [0.0, 1e200, -1e200, 2e200],
        [0.0, 1e-250, -1e-250, 2e-250],
        [1.0, 2.0, 1e308, -1e308, 0.0],
        [np.finfo(np.float64).max, -np.finfo(np.float64).max],
        [1e308] * 19,
        [0.0] * 19,
        [4.0],
    ],
)
def test_stdev_matches_independent_population_reference_across_tiles(
    values: list[float], tile_size: int
) -> None:
    """Preserve population moments for large offsets, extremes and uneven tiles.

    Args:
        values: Finite fixture values with exact-fraction reference arithmetic.
        tile_size: Evaluation batch size, including singleton and partial tiles.
    """
    reference = statistics.pstdev(values)
    calculation = Calculation(compile_expression("stdev(a)", "a"))
    data = np.array(values, dtype=np.float64)
    for start in range(0, len(data), tile_size):
        tile = data[start : start + tile_size]
        calculation.process_tile(tile, np.ones(tile.shape, dtype=bool))
    result = calculation.result()
    assert result["state"] == "ok"
    assert result["valueType"] == "float"
    assert result["unit"] is None
    assert float(result["value"]) == pytest.approx(reference, rel=2e-14, abs=0)
    assert result["aggregates"][0]["matchedPixels"] == len(values)


@pytest.mark.parametrize(
    "values,valid,state,value",
    [
        ([], [], "no_valid_data", None),
        ([np.nan, np.inf], [False, False], "no_valid_data", None),
        ([1, 99, 3], [True, False, True], "ok", "1.0"),
        ([0, 0], [True, True], "ok", "0.0"),
    ],
)
def test_stdev_preserves_missing_masked_zero_and_empty_semantics(
    values: list[float], valid: list[bool], state: str, value: str | None
) -> None:
    """Missing data stays distinct from valid zero-valued population deviation.

    Args:
        values: Stored fixture values, including missing cells.
        valid: Authoritative source/area mask.
        state: Expected public classification.
        value: Expected decimal-string result or missing value.
    """
    result = calculate("stdev(a)", values, valid)
    assert result["state"] == state
    assert result["value"] == value


def test_stdev_where_arithmetic_and_scalar_combinations() -> None:
    """Filtering and arithmetic failures use the established numeric contract."""
    unmatched = calculate("stdev(a,where=a>10)", [0, 2])
    assert unmatched["state"] == "no_matches"
    assert unmatched["value"] is None
    partial = calculate("stdev(10/a)", [0, 2, 5])
    assert float(partial["value"]) == 1.5
    assert partial["aggregates"][0] == {
        "function": "stdev",
        "validPixels": 3,
        "matchedPixels": 2,
        "invalidArithmeticPixels": 1,
    }
    assert calculate("stdev(10/a)", [0, 0])["state"] == "invalid_arithmetic"
    condition = calculate("stdev(a,where=10/a>0)", [0, 2, 4])
    assert float(condition["value"]) == 1.0
    assert condition["aggregates"][0]["invalidArithmeticPixels"] == 1
    assert calculate("stdev(a,where=10/a>0)", [0, 0])["state"] == "invalid_arithmetic"
    assert float(calculate("stdev(a)/mean(a)", [2, 4])["value"]) == pytest.approx(1 / 3)


@pytest.mark.parametrize("pixel_value", [0.0, -7.5, 12.25])
def test_pixel_value_is_one_selected_sample_independent_of_area_tiles(
    pixel_value: float,
) -> None:
    """A selected pixel stays unchanged as unrelated area tiles are processed.

    Args:
        pixel_value: Finite stored value selected by the native raster reader.
    """
    calculation = Calculation(compile_expression("pixelValue(a)", "a"), pixel_value)
    assert float(calculation.result()["value"]) == pixel_value
    for values in ([2.0, 3.0], [100.0, 200.0]):
        calculation.process_tile(np.array(values), np.array([True, True]))
    result = calculation.result()
    assert float(result["value"]) == pixel_value
    assert result["state"] == "ok"
    assert result["valueType"] == "float"
    assert result["aggregates"] == [
        {
            "function": "pixelValue",
            "validPixels": 1,
            "matchedPixels": 1,
            "invalidArithmeticPixels": 0,
        }
    ]


@pytest.mark.parametrize(
    "pixel_value", [None, float("nan"), float("inf"), -float("inf")]
)
def test_missing_or_nonfinite_pixel_does_not_fall_back_to_area_values(
    pixel_value: float | None,
) -> None:
    """Invalid selected samples remain missing even when nearby pixels are valid.

    Args:
        pixel_value: Missing or nonfinite stored sample.
    """
    calculation = Calculation(compile_expression("pixelValue(a)", "a"), pixel_value)
    calculation.process_tile(np.array([9.0]), np.array([True]))
    result = calculation.result()
    assert result["value"] is None
    assert result["state"] == "no_valid_data"
    assert result["aggregates"][0]["validPixels"] == 0
    assert result["aggregates"][0]["matchedPixels"] == 0


def test_pixel_value_combines_with_area_statistics_and_scalar_arithmetic() -> None:
    """Point values share the scalar expression language without changing area counts."""
    calculation = Calculation(
        compile_expression("pixelValue(raster) * 2 - mean(raster)", "raster"), 10.0
    )
    calculation.process_tile(np.array([2.0, 4.0]), np.array([True, True]))
    calculation.process_tile(np.array([6.0, 99.0]), np.array([True, False]))
    result = calculation.result()
    assert float(result["value"]) == 16.0
    assert [row["validPixels"] for row in result["aggregates"]] == [1, 3]
    missing = Calculation(compile_expression("pixelValue(a) + mean(a)", "a"))
    missing.process_tile(np.array([4.0]), np.array([True]))
    assert missing.result()["state"] == "no_valid_data"


@pytest.mark.parametrize(
    "changes",
    [
        {"wholeRaster": None},
        {"wholeRaster": False},
        {"selectedBounds": {"west": 0, "south": 0, "east": 1, "north": 1}},
        {"sources": {"a": SOURCE, "b": SOURCE}},
        {"sources": {"sum": SOURCE}},
        {"sources": {"stdev": SOURCE}},
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
