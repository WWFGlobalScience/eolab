"""Large Processing plans use grid metadata without pre-scanning source work."""

from pathlib import Path
from types import SimpleNamespace

from affine import Affine
import numpy as np
from pydantic import ValidationError
import pytest
from rasterio.crs import CRS
from rasterio.windows import Window

from eolab_app.processing.downstream_calculation import describe_values_grid
from eolab_app.processing.raster_input import count_native_raster_blocks
from eolab_app.processing.clip_models import ClipArea
from eolab_app.processing.aggregate_models import AggregateArea
from raster_clip_support import make_spec as clip_spec
from raster_fixture_support import write_source
from raster_aggregate_support import make_spec as aggregate_spec


@pytest.mark.parametrize("operation", ["calculation", "clip"])
def test_plans_do_not_enumerate_or_size_native_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    """Plan both operations without invoking a source-block work estimate.

    Args:
        tmp_path: Isolated real raster.
        monkeypatch: Detects traversal used only by former admission estimates.
        operation: Existing consumer of the native grid metadata.
    """
    import eolab_app.raster.source_contract as source_contract

    def forbidden(*args: object) -> None:
        """Fail if planning enumerates source work.

        Args:
            args: Unused estimate inputs.
        """
        pytest.fail("Planning must not enumerate or size native block reads")

    monkeypatch.setattr(source_contract, "source_work_for_blocks", forbidden)
    path = write_source(tmp_path / "source.tif", np.ones((34, 35), dtype="uint16"))
    spec = (
        clip_spec(path, ClipArea(kind="bounds", bounds=(0, 9.66, 0.35, 10)))
        if operation == "clip"
        else aggregate_spec(path, ["count(a)"], AggregateArea(kind="wholeRaster"))
    )
    assert spec.grid.nativeBlocks == 4
    serialized = spec.model_dump(mode="json", by_alias=True)
    assert type(spec).model_validate(serialized).grid == spec.grid
    for field in (
        "decodedBytes",
        "reservedBytes" if operation == "clip" else "estimatedMemoryBytes",
    ):
        with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
            type(spec).model_validate(
                {**serialized, "grid": {**serialized["grid"], field: 0}}
            )


def test_billion_cell_downstream_grid_needs_only_metadata() -> None:
    """Accept a grid larger than the reported failure without allocating pixel arrays."""
    width, height = 40_000, 30_000
    transform = Affine(0.001, 0, -80, 0, -0.001, 30)
    dataset = SimpleNamespace(
        width=width,
        height=height,
        transform=transform,
        crs=CRS.from_epsg(4326),
        block_shapes=[(256, 256)],
        dtypes=["float32"],
        nodata=-9999,
        window_transform=lambda window: transform
        * Affine.translation(window.col_off, window.row_off),
    )
    grid = describe_values_grid(dataset)
    assert grid.width * grid.height == 1_200_000_000
    assert type(grid).model_validate_json(grid.model_dump_json()) == grid
    assert count_native_raster_blocks(dataset, Window(0, 0, width, height)) == 157 * 118


def test_summary_plan_has_no_total_read_window_ceiling() -> None:
    """Plan millions of read windows without enumerating or limiting the total work."""
    from eolab_app.processing.aggregate_windows import plan_raster_read_windows

    plan = plan_raster_read_windows(
        Window(0, 0, 40_000, 30_000),
        (16, 16),
        40_000,
        30_000,
        None,
        512,
    )
    assert plan.readWindows == 2_500 * 1_875
    assert plan.readWidth == plan.readHeight == 16
