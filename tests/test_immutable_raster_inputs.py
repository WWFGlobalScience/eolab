"""Regression coverage for immutable raster planning and execution."""

import csv
from pathlib import Path

import numpy as np
import pytest
import rasterio

from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.clip_models import ClipArea
from eolab_app.processing.raster_aggregate import (
    calculate_raster_statistics_for_area,
    plan_aggregate,
)
from eolab_app.processing.raster_clip import create_clip, plan_clip
from eolab_app.raster.source_identity import RasterSourceIdentity
from test_raster_aggregates import make_spec as aggregate_spec
from test_raster_clips import LIMITS, make_spec as clip_spec, write_source


@pytest.mark.parametrize("operation", ["summary", "clip"])
@pytest.mark.parametrize("missing", [False, True])
def test_native_operations_use_catalog_identity_without_file_rechecks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str, missing: bool
) -> None:
    """Keep real planning/reads and missing-file errors without signature polling.

    Args:
        tmp_path: Isolated source and output directory.
        monkeypatch: Fixture replacing only the filesystem identity reader.
        operation: Native summary or clipping operation.
        missing: Whether the source is removed after its plan is saved.
    """
    path = write_source(tmp_path / "source.tif", np.ones((32, 32), dtype="uint16"))
    if operation == "summary":
        spec = aggregate_spec(path, ["sum(a)"])
        limits = RasterAggregateLimits()
    else:
        spec = clip_spec(path, ClipArea(kind="bounds", bounds=(0.01, 9.8, 0.2, 9.99)))
        limits = LIMITS

    def forbidden_identity_read(source_path: Path) -> RasterSourceIdentity:
        """Fail if planning or execution tries to poll filesystem identity.

        Args:
            source_path: Source whose identity must come from the saved catalog.

        Raises:
            AssertionError: On any attempted filesystem identity read.
        """
        raise AssertionError(f"Unexpected raster mutation check: {source_path}")

    monkeypatch.setattr(RasterSourceIdentity, "read", forbidden_identity_read)
    if operation == "summary":
        grid = plan_aggregate(path, spec.area, spec.calculations, "a", limits)
        execute = calculate_raster_statistics_for_area
    else:
        grid = plan_clip(path, spec.area, limits)
        execute = create_clip
    assert grid == spec.grid
    # Historical identity remains provenance; it is not an execution precondition.
    spec = spec.model_copy(update={"sourceSignature": (0, 0, 0, 0)})
    if missing:
        path.unlink()
        with pytest.raises(rasterio.errors.RasterioIOError):
            execute(path, spec, tmp_path, limits)
    else:
        execute(path, spec, tmp_path, limits)
        if operation == "summary":
            with (tmp_path / "result.csv").open(newline="") as result:
                assert float(next(csv.DictReader(result))["value"]) == 1024
        else:
            with rasterio.open(tmp_path / "result.tif") as dataset:
                assert np.all(dataset.read(1, masked=True).compressed() == 1)
