"""Native-grid numerical, geographic, provenance, and work-budget boundaries."""

from dataclasses import replace
import csv
import json
from pathlib import Path

from affine import Affine
import numpy as np
import pytest
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin, xy

from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateSpec,
    NamedCalculation,
    RasterAggregateLimits,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_aggregate import (
    calculate_raster_statistics_for_area,
    plan_aggregate,
)
import eolab_app.processing.raster_aggregate as kernel
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity
from test_raster_clips import SOURCE, write_source

LIMITS = RasterAggregateLimits()


def make_spec(
    path: Path,
    expressions: list[str],
    area: AggregateArea | None = None,
    limits: RasterAggregateLimits = LIMITS,
    target_chunk_pixels: int | None = None,
) -> AggregateSpec:
    """Build an immutable native plan from a real closed fixture.

    Args:
        path: Signed-compatible source fixture.
        expressions: Ordered scalar expressions for alias a.
        area: Explicit selection, defaulting to explicit whole-raster intent.
        limits: Optional reduced admission budget.
        target_chunk_pixels: Optional batch pixel budget.

    Returns:
        JSON-round-tripped specification ready for execution.
    """
    signature = tuple(RasterSourceIdentity.read(path).to_catalog())
    area = area or AggregateArea(kind="wholeRaster")
    calculations = tuple(
        NamedCalculation(label=f"Result {i}", expression=value)
        for i, value in enumerate(expressions)
    )
    spec = AggregateSpec(
        sources={"a": CatalogRasterRequest(**SOURCE)},
        sourceSignature=signature,
        area=area,
        calculations=calculations,
        grid=plan_aggregate(
            path, signature, area, calculations, "a", limits, target_chunk_pixels
        ),
    )
    return AggregateSpec.model_validate_json(spec.model_dump_json(by_alias=True))


def test_native_values_not_overviews_scale_or_histogram_statistics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Real overview-equipped TIFF still reduces every native valid value once.

    Args:
        tmp_path: Isolated native and artifact files.
        monkeypatch: Observe the bounded native-reader boundary.
    """
    values = np.arange(260 * 270, dtype="int32").reshape(260, 270)
    values[10:20, 10:20] = -9999
    path = write_source(tmp_path / "source.tif", values, nodata=-9999)
    with rasterio.open(path, "r+") as dataset:
        dataset.build_overviews([2, 4, 8], Resampling.average)
    spec = make_spec(
        path, ["sum(a)", "count(a>10)", "sum(a,where=a>10)", "mean(a)", "max(a)-min(a)"]
    )
    reads = []
    reader = kernel.read_native_raster_block

    def observed(dataset, window):
        """Read one real native block and retain its identity.

        Args:
            dataset: Open native source.
            window: Admitted native block.

        Returns:
            Actual masked source values.
        """
        reads.append(tuple(window.flatten()))
        return reader(dataset, window)

    monkeypatch.setattr(kernel, "read_native_raster_block", observed)
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    selected = values[values != -9999]
    expected = [
        selected.sum(),
        np.count_nonzero(selected > 10),
        selected[selected > 10].sum(),
        selected.mean(),
        selected.max() - selected.min(),
    ]
    assert [float(row["value"]) for row in artifact.rows] == pytest.approx(expected)
    assert len(reads) == spec.grid.nativeBlocks == len(set(reads))
    assert spec.grid.scale == "2.0" and spec.grid.offset == "-1.0"
    assert artifact.media_type == "text/csv"
    rows = list(
        csv.DictReader((tmp_path / "result.csv").open(newline="", encoding="utf-8"))
    )
    assert rows[1]["value"] == artifact.rows[1]["value"]
    provenance = json.loads((tmp_path / "provenance.json").read_text())
    assert provenance["valueDomain"] == "stored"
    assert provenance["inclusion"] == "cell_center"
    assert provenance["sourceSignature"] == list(spec.sourceSignature)
    assert str(path) not in json.dumps(provenance)


@pytest.mark.parametrize(
    "transform,crs",
    [
        (from_origin(0, 10, 0.01, 0.01), "EPSG:4326"),
        (from_origin(0, 1_000_000, 1000, 1000), "EPSG:3857"),
        (Affine(0.01, 0.002, 0, 0.001, -0.01, 10), "EPSG:4326"),
    ],
)
def test_aoi_hole_center_inclusion_on_rotated_and_projected_grids(
    tmp_path: Path, transform: Affine, crs: str
) -> None:
    """Known pixel-center membership is preserved through AOI reprojection.

    Args:
        tmp_path: Isolated input/output directory.
        transform: Native affine, including rotation.
        crs: Native source CRS.
    """
    from rasterio.warp import transform_geom

    values = np.arange(100, dtype="int16").reshape(10, 10)
    path = write_source(tmp_path / "source.tif", values, transform=transform, crs=crs)
    # Offset edges avoid ambiguous centers; the hole removes rows/columns 4..5.
    outer = [
        transform * point
        for point in [(1.1, 1.1), (8.9, 1.1), (8.9, 8.9), (1.1, 8.9), (1.1, 1.1)]
    ]
    hole = [
        transform * point
        for point in [(4.1, 4.1), (4.1, 5.9), (5.9, 5.9), (5.9, 4.1), (4.1, 4.1)]
    ]
    geometry = transform_geom(
        crs, "EPSG:4326", {"type": "Polygon", "coordinates": [outer, hole]}
    )
    coords = geometry["coordinates"][0]
    bounds = (
        min(p[0] for p in coords),
        min(p[1] for p in coords),
        max(p[0] for p in coords),
        max(p[1] for p in coords),
    )
    area = AggregateArea(kind="aoi", bounds=bounds, geometries=(geometry,))
    spec = make_spec(path, ["count(a)", "sum(a)"], area)
    artifact = calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert artifact.rows[0]["value"] == "60"
    assert (
        float(artifact.rows[1]["value"])
        == values[1:9, 1:9].sum() - values[4:6, 4:6].sum()
    )


def test_bounds_center_policy_missing_values_and_zero(tmp_path: Path) -> None:
    """A partially intersecting cell is excluded unless its center lies inside.

    Args:
        tmp_path: Native source and result directory.
    """
    path = write_source(
        tmp_path / "source.tif",
        np.array([[0, 1, 2], [3, np.nan, 5], [6, 7, 8]], dtype="float32"),
        transform=from_origin(0, 3, 1, 1),
    )
    area = AggregateArea(kind="bounds", bounds=(0.6, 0.6, 2.9, 2.9))
    artifact = calculate_raster_statistics_for_area(
        path, make_spec(path, ["count(a)", "sum(a)"], area), tmp_path, LIMITS
    )
    assert artifact.rows[0]["value"] == "3"
    assert float(artifact.rows[1]["value"]) == 8
    artifact = calculate_raster_statistics_for_area(
        path, make_spec(path, ["count(a)", "min(a)"]), tmp_path, LIMITS
    )
    assert artifact.rows[0]["value"] == "8"
    assert float(artifact.rows[1]["value"]) == 0


def test_metadata_admission_signature_fence_and_csv_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Planning reads metadata only and rejects excess native work before execution.

    Args:
        tmp_path: Source and output files.
        monkeypatch: Fail if planning attempts to read band values.
    """
    path = write_source(tmp_path / "source.tif", np.ones((100, 100), dtype="uint8"))

    def forbidden(*args):
        """Reject unexpected pixel I/O during metadata planning.

        Args:
            args: Unused native-reader arguments.
        """
        pytest.fail("Planning must not read pixels")

    with monkeypatch.context() as patch:
        patch.setattr(kernel, "read_native_raster_block", forbidden)
        spec = make_spec(path, ["count(a)"])
        with pytest.raises(ProcessingError):
            make_spec(path, ["count(a)"], limits=replace(LIMITS, max_native_blocks=1))
        with pytest.raises(ProcessingError):
            make_spec(path, ["count(a)"], limits=replace(LIMITS, max_decoded_bytes=1))
        with pytest.raises(ProcessingError):
            make_spec(path, ["count(a)"], limits=replace(LIMITS, max_memory_bytes=1))
    spec = spec.model_copy(
        update={
            "calculations": (
                NamedCalculation(label="=IMPORTXML(1)", expression="count(a)"),
            )
        }
    )
    calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert "'=IMPORTXML(1)" in (tmp_path / "result.csv").read_text()
    with rasterio.open(path, "r+") as dataset:
        dataset.write(np.zeros((100, 100), dtype="uint8"), 1)
    with pytest.raises(ProcessingError) as error:
        calculate_raster_statistics_for_area(path, spec, tmp_path, LIMITS)
    assert error.value.code == "source_changed"
