"""The editor validates through Processing's grammar without any I/O dependency."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from eolab_app.processing.aggregate_models import (
    AggregatePlanRequest,
    AggregateValidationRequest,
)
from eolab_app.routes.processing import create_processing_router
from test_raster_clips import SOURCE
from pathlib import Path
from html import unescape
import re
from typing import Any
from unittest.mock import patch

from eolab_app.processing import aggregate_models
from eolab_app.processing.aggregate_models import (
    AggregateJobRequest,
    UnpreparedCalculation,
)
from eolab_app.processing.shared_calculations import identify_shared_calculation

from eolab_app.processing.raster_expression import FUNCTIONS, compile_expression


def test_validation_http_needs_no_service_source_storage_or_native_reader() -> None:
    """A router with no service can validate but cannot possibly plan or enqueue."""
    app = FastAPI()
    app.include_router(create_processing_router(None))
    with TestClient(app, base_url="https://testserver") as client:
        url = "/api/processing/raster-calculations/validate"
        body = {
            "alias": "a",
            "calculations": [{"label": "Matches", "expression": "count(a > 10)"}],
        }
        response = client.post(url, json=body, headers={"X-EOLab-Processing": "1"})
        assert response.status_code == 200
        assert response.json() == {"valid": True}
        assert response.headers["cache-control"] == "private, no-store"
        assert client.post(url, json=body).status_code == 403
        assert (
            client.post(
                url,
                json=body,
                headers={"X-EOLab-Processing": "1", "Origin": "https://elsewhere.test"},
            ).status_code
            == 403
        )
        assert client.post(url, content=b"x" * 17000).status_code == 413
        body["calculations"][0]["expression"] = "sum(a[0])"
        invalid = client.post(url, json=body, headers={"X-EOLab-Processing": "1"})
        assert invalid.status_code == 422
        assert (
            "expression" in invalid.text.lower() or "unexpected" in invalid.text.lower()
        )


@pytest.mark.parametrize(
    "expression",
    [
        "count(a > 10)",
        "sum(a, where=a > 10)",
        "mean(a > 10)",
        "sum(b)",
        "areaha(a == 4)",
        "max(min(a))",
        "__import__('os')",
    ],
)
def test_validation_and_planning_use_identical_language(expression: str) -> None:
    """Both entry points accept/reject exactly the same typed language.

    Args:
        expression: A valid or invalid scalar calculation.
    """
    calculations = [{"label": "Result", "expression": expression}]
    accepted = []
    for model, extra in [
        (AggregateValidationRequest, {"alias": "a"}),
        (AggregatePlanRequest, {"sources": {"a": SOURCE}, "wholeRaster": True}),
        (
            AggregateJobRequest,
            {
                "sources": {"a": SOURCE},
                "wholeRaster": True,
                "requestId": "validation-request-616",
            },
        ),
    ]:
        try:
            model(calculations=calculations, **extra)
            accepted.append(True)
        except ValidationError:
            accepted.append(False)
    assert len(set(accepted)) == 1


def test_queued_request_reuses_validation_but_persisted_inputs_are_revalidated() -> (
    None
):
    """Validate raw requests once, including again after storage, without nesting repeats."""
    with patch.object(
        aggregate_models, "compile_expression", wraps=compile_expression
    ) as compiler:
        request = AggregateJobRequest(
            requestId="validation-request-616",
            sources={"a": SOURCE},
            calculations=[{"label": "Mean", "expression": "mean(a)"}],
            wholeRaster=True,
        )
        assert compiler.call_count == 1
        queued = UnpreparedCalculation(request=request)
        assert queued.request is request
        assert compiler.call_count == 1
        stored = queued.model_dump(mode="json", by_alias=True)
        assert "requestId" not in stored["request"]
        restored = UnpreparedCalculation.model_validate(stored)
        assert compiler.call_count == 2
        assert restored.model_dump(mode="json", by_alias=True) == stored
        stored["request"]["calculations"][0]["expression"] = "sum(a[0])"
        with pytest.raises(ValidationError):
            UnpreparedCalculation.model_validate(stored)


def test_reused_submission_keeps_the_same_shared_work_identity() -> None:
    """Retry IDs stay out of shared-work hashes and stored calculation inputs."""
    inputs = {
        "sources": {"a": SOURCE},
        "calculations": [{"label": "Mean", "expression": "mean(a)"}],
        "wholeRaster": True,
    }
    original = UnpreparedCalculation(request=AggregatePlanRequest(**inputs))
    original_key = identify_shared_calculation(original)
    original_spec = original.model_dump(mode="json", by_alias=True)
    for request_id in ("first-request-616", "second-request-616"):
        queued = UnpreparedCalculation(
            request=AggregateJobRequest(**inputs, requestId=request_id)
        )
        assert identify_shared_calculation(queued) == original_key
        assert queued.model_dump(mode="json", by_alias=True) == original_spec


@pytest.mark.parametrize(
    "changes",
    [
        {"sources": {"a": {**SOURCE, "itemId": "not-a-catalog-item"}}},
        {"sources": {"a": SOURCE, "b": SOURCE}},
        {"sources": {"mean": SOURCE}},
        {"wholeRaster": None},
        {"selectedBounds": {"west": 0, "south": 0, "east": 1, "north": 1}},
        {
            "wholeRaster": None,
            "selectedBounds": {"west": 0, "south": 0, "east": 1, "north": 100},
        },
        {"calculations": [{"label": "Bad", "expression": "sum(a[0])"}]},
        {
            "calculations": [
                {"label": "Same", "expression": "mean(a)"},
                {"label": "Same", "expression": "max(a)"},
            ]
        },
        {
            "calculations": [
                {"label": str(i), "expression": "mean(a)" + " " * 2100}
                for i in range(2)
            ]
        },
        {
            "calculations": [
                {
                    "label": str(i),
                    "expression": " + ".join(["sum(a, where=a > 0)"] * 10),
                }
                for i in range(5)
            ]
        },
    ],
)
def test_raw_calculation_inputs_still_validate_at_each_boundary(
    changes: dict[str, Any],
) -> None:
    """Reject malformed raw inputs in HTTP, direct construction and stored jobs.

    Args:
        changes: Source, area or formula contract violation in an otherwise valid input.
    """
    inputs = {
        "sources": {"a": SOURCE},
        "calculations": [{"label": "Mean", "expression": "mean(a)"}],
        "wholeRaster": True,
        **changes,
    }
    submission = {**inputs, "requestId": "validation-request-616"}
    with pytest.raises(ValidationError):
        AggregateJobRequest(**submission)
    with pytest.raises(ValidationError):
        UnpreparedCalculation.model_validate({"request": inputs})
    app = FastAPI()
    app.include_router(create_processing_router(None))
    with TestClient(app, base_url="https://testserver") as client:
        response = client.post(
            "/api/processing/raster-calculations",
            json=submission,
            headers={"X-EOLab-Processing": "1"},
        )
    assert response.status_code == 422


def test_reused_request_still_requires_its_uploaded_polygon_copy() -> None:
    """Reusing validated inputs must not bypass the queued polygon ownership snapshot."""
    request = AggregateJobRequest(
        requestId="validation-request-616",
        sources={"a": SOURCE},
        calculations=[{"label": "Mean", "expression": "mean(a)"}],
        polygonArea={"id": "a" * 32, "sha256": "b" * 64},
    )
    with pytest.raises(ValidationError, match="Saved polygons do not match"):
        UnpreparedCalculation(request=request)


def test_expression_help_lists_every_function_with_valid_examples() -> None:
    """Keep the visible function list complete and its copyable examples accepted."""
    markup = Path("frontend/index.html").read_text(encoding="utf-8")
    help_text = markup.split('id="calculations-help"', 1)[1].split("</details>", 1)[0]
    function_list = help_text.split('<ul class="calculation-functions">', 1)[1].split(
        "</ul>", 1
    )[0]
    examples = [
        unescape(value)
        for value in re.findall(r"<li><code>(.*?)</code>", function_list)
    ]
    assert {value.split("(", 1)[0] for value in examples} == FUNCTIONS
    for value in re.findall(r"<code>(.*?)</code>", help_text):
        expression = unescape(value)
        if "(" in expression:
            compile_expression(expression, "a")
