"""Explicit registration of code-installed operation functions and schemas."""

from dataclasses import dataclass
from typing import Callable

from pydantic import BaseModel

from job_service.models import Operation
from job_service.operations.diagnostic import (
    DiagnosticInput,
    DiagnosticResult,
    diagnostic,
)
from eolab_app.vector.outline_operation import (
    OutlineInput,
    OutlineResult,
    calculate_outline,
)
from eolab_app.vector.extent_operation import (
    SelectionExtentResult,
    measure_selected_extent,
)
from eolab_app.vector.selection_operation import (
    SelectionMeasurementInput,
    SelectionMeasurementResult,
    measure_selected_features,
)


@dataclass(frozen=True)
class InstalledOperation:
    """Code-installed input/result validators and one executable algorithm."""

    name: str
    description: str
    input_model: type[BaseModel]
    result_model: type[BaseModel]
    execute: Callable[[BaseModel], BaseModel]

    def describe(self) -> Operation:
        """Publish JSON schemas for discovery.

        Returns:
            Public operation contract without executable code or paths.
        """
        return Operation(
            name=self.name,
            description=self.description,
            inputSchema=self.input_model.model_json_schema(),
            resultSchema=self.result_model.model_json_schema(),
        )


OPERATIONS = {
    "diagnostic.v1": InstalledOperation(
        "diagnostic.v1",
        "Echo a value, delay then echo, or raise a controlled exception.",
        DiagnosticInput,
        DiagnosticResult,
        diagnostic,
    ),
    "vector.outline.v1": InstalledOperation(
        "vector.outline.v1",
        "Build a simplified display outline from an immutable catalog selection.",
        OutlineInput,
        OutlineResult,
        calculate_outline,
    ),
    "vector.selection-extent.v1": InstalledOperation(
        "vector.selection-extent.v1",
        "Measure original-source bounds of matching catalog or uploaded vector features.",
        SelectionMeasurementInput,
        SelectionExtentResult,
        measure_selected_extent,
    ),
    "vector.selection-measurement.v1": InstalledOperation(
        "vector.selection-measurement.v1",
        "Count matching features in a catalog or uploaded vector layer for an analysis area.",
        SelectionMeasurementInput,
        SelectionMeasurementResult,
        measure_selected_features,
    ),
}
