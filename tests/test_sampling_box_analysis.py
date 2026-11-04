"""Verify geodesic sampling boxes across original-source and Processing readers."""

import math
from itertools import product
from pathlib import Path
from numpy.typing import NDArray

import numpy as np
import pytest
import rasterio
from affine import Affine
from pydantic import ValidationError
from pyproj import Geod, Transformer
from rasterio.features import geometry_mask
from rasterio.transform import from_bounds
from shapely.geometry import Polygon, mapping

from eolab_app.sampling_box import Wgs84SamplingBox, sampling_box_bounds
from eolab_app.sampling_area import SamplingBoxArea, SelectedBoundsSamplingArea
from eolab_app.raster.bounded_window import selected_raster_area_for_sampling_box
from eolab_app.raster.models import (
    CatalogRasterStatisticsRequest,
    CatalogRasterPairRequest,
)
from eolab_app.raster.statistics import read_raster_statistics
from eolab_app.raster.paired_statistics import read_raster_paired_statistics
from eolab_app.raster.categorical_statistics import read_raster_categorical_statistics
from eolab_app.processing.aggregate_models import AggregateArea, AggregatePlanRequest
from eolab_app.processing.calculation_cache import calculation_result_cache_keys
from eolab_app.processing.clip_models import ClipArea, ClipInputs, ClipSpec
from eolab_app.processing.raster_aggregate import calculate_raster_statistics_for_area
from eolab_app.processing.raster_clip import create_clip
from eolab_app.processing.raster_operations import bind_area_arguments
from raster_fixture_support import write_source
from raster_source_support import SOURCE
from raster_aggregate_support import LIMITS, make_spec
from raster_clip_support import make_spec as make_clip_spec, LIMITS as CLIP_LIMITS

BOX = Wgs84SamplingBox(center={"longitude": 10.0, "latitude": 60.0}, sideLengthKm=2000)


def reference_box_ring(box: Wgs84SamplingBox) -> tuple[tuple[float, float], ...]:
    """Trace the specified spherical edges independently with PROJ's geodesic solver.

    Args:
        box: Validated center and approximate kilometer side length.

    Returns:
        Closed WGS84 ring with 2,000 intermediate positions on each edge.
    """
    sphere = Geod(a=6371008.8, b=6371008.8)
    corners = [
        sphere.fwd(
            box.center.longitude,
            box.center.latitude,
            bearing,
            box.sideLengthKm * 1000 / math.sqrt(2),
        )[:2]
        for bearing in (315, 45, 135, 225)
    ]
    ring = []
    for start, end in zip(corners, corners[1:] + corners[:1], strict=True):
        ring.extend([start, *sphere.npts(*start, *end, 2000)])
    return tuple([*ring, ring[0]])


def write_box_raster(path: Path) -> tuple[Path, NDArray[np.float64], Affine]:
    """Write a small northern-latitude raster whose envelope exceeds the box.

    Args:
        path: New GeoTIFF within the caller's isolated test directory.

    Returns:
        Closed path, original values and native pixel transform.
    """
    values = np.arange(80 * 100, dtype="float64").reshape(80, 100)
    values[40, 50] = -9999
    transform = from_bounds(-35.13, 35.17, 55.23, 80.34, 100, 80)
    return (
        write_source(path, values, nodata=-9999, transform=transform),
        values,
        transform,
    )


def reference_membership_bounds(
    values: NDArray[np.float64],
    transform: Affine,
    all_touched: bool,
) -> tuple[NDArray[np.bool_], NDArray[np.bool_]]:
    """Bound independent membership by the declared native-edge approximation.

    Args:
        values: Original native pixel values, including the fixture NoData sentinel.
        transform: Actual native affine transform.
        all_touched: Owning reader's pixel inclusion contract.

    Returns:
        Required and possible valid-cell masks. Only cells within 0.0101 pixels
        of PROJ's independently traced geodesic boundary may differ.
    """
    polygon = Polygon([~transform * point for point in reference_box_ring(BOX)])
    masks = tuple(
        geometry_mask(
            [mapping(polygon.buffer(delta))],
            out_shape=values.shape,
            transform=Affine.identity(),
            invert=True,
            all_touched=all_touched,
        )
        & (values != -9999)
        for delta in (-0.0101, 0.0101)
    )
    return masks


def reference_numeric_outcomes(
    values: NDArray[np.float64],
    transform: Affine,
    all_touched: bool,
) -> list[NDArray[np.float64]]:
    """Enumerate the few boundary-cell alternatives allowed by the error contract.

    Args:
        values: Fixture's original native values.
        transform: Actual native affine transform.
        all_touched: Whether a touched cell is selected.

    Returns:
        Independent possible value arrays for the fixture's ambiguous edge cells.
    """
    required, possible = reference_membership_bounds(values, transform, all_touched)
    optional = values[possible & ~required]
    assert len(optional) <= 12, "fixture should isolate a few numerical edge cases"
    return [
        np.concatenate((values[required], optional[np.asarray(bits, dtype=bool)]))
        for bits in product((False, True), repeat=len(optional))
    ]


@pytest.mark.parametrize(
    "crs,affine",
    [
        ("EPSG:4326", Affine(0.04, 0.013, -30, 0.008, -0.08, 90)),
        ("EPSG:3857", Affine(4000, 1300, -3000000, 800, -8000, 16000000)),
        ("EPSG:32632", Affine(4000, 1300, -3000000, 800, -8000, 12000000)),
    ],
)
def test_box_projection_respects_rotated_anisotropic_native_pixels(
    tmp_path: Path,
    crs: str,
    affine: Affine,
) -> None:
    """Bound geodesic approximation error using real pixel coordinates in three CRSs.

    Args:
        tmp_path: Isolated raster output directory.
        crs: Geographic or projected source coordinate system.
        affine: Rotated native grid with unequal axis resolutions.
    """
    path = write_source(
        tmp_path / "grid.tif",
        np.ones((2048, 2048), dtype="uint8"),
        transform=affine,
        crs=crs,
    )
    with rasterio.open(path) as dataset:
        selected = selected_raster_area_for_sampling_box(dataset, BOX, None)
        projector = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        dense = reference_box_ring(BOX)
        x, y = projector.transform(*zip(*dense))
        expected = Polygon([~affine * point for point in zip(x, y, strict=True)])
        actual = Polygon(
            [
                ~affine * point
                for point in selected.projected_geometries[0]["coordinates"][0]
            ]
        )
        assert actual.hausdorff_distance(expected) <= 0.0101
        assert selected.source_window.width < dataset.width


def test_histograms_pair_and_categories_mask_the_box_instead_of_its_envelope(
    tmp_path: Path,
) -> None:
    """Use the same curved box in numeric, paired and fractional category sampling.

    Args:
        tmp_path: Native source rasters and private read outputs.
    """
    path, values, transform = write_box_raster(tmp_path / "values.tif")
    statistics = read_raster_statistics(path, SamplingBoxArea(BOX))
    assert statistics.scope == "samplingBox" and statistics.selected_bounds is None
    assert statistics.sampling_box == BOX
    outcomes = reference_numeric_outcomes(values, transform, True)
    assert (
        min(len(outcome) for outcome in outcomes)
        <= statistics.valid_sample_count
        <= max(len(outcome) for outcome in outcomes)
    )
    medians = [float(np.percentile(outcome, 50)) for outcome in outcomes]
    assert min(medians) <= statistics.percentiles.p50 <= max(medians)
    rectangular = read_raster_statistics(
        path, SelectedBoundsSamplingArea(sampling_box_bounds(BOX))
    )
    assert statistics.valid_sample_count < rectangular.valid_sample_count
    pair = read_raster_paired_statistics(path, path, None, sampling_box=BOX)
    assert (
        pair.scope == "samplingBox"
        and pair.selected_bounds is None
        and pair.sampling_box == BOX
    )
    rectangle_pair = read_raster_paired_statistics(path, path, sampling_box_bounds(BOX))
    assert pair.sample_width == rectangle_pair.sample_width
    assert pair.sample_height == rectangle_pair.sample_height
    assert pair.paired_sample_count < rectangle_pair.paired_sample_count
    assert all(
        value == 0
        for row, counts in enumerate(pair.histogram.counts)
        for column, value in enumerate(counts)
        if row != column
    )
    categories = write_source(
        tmp_path / "classes.tif",
        np.ones(values.shape, dtype="uint8"),
        transform=transform,
    )
    classified = read_raster_categorical_statistics(
        categories, SamplingBoxArea(BOX), category_values=(1,)
    )
    rectangular_classes = read_raster_categorical_statistics(
        categories,
        SelectedBoundsSamplingArea(sampling_box_bounds(BOX)),
        category_values=(1,),
    )
    assert classified.sampling_box == BOX
    assert classified.categorical_distribution.areas_hectares[0] > 0
    assert (
        classified.categorical_distribution.valid_area_hectares
        < rectangular_classes.categorical_distribution.valid_area_hectares
    )


def test_processing_aggregate_clip_and_hectares_use_the_same_box(
    tmp_path: Path,
) -> None:
    """Round-trip exact intent and compare native values, masks and fractional hectares.

    Args:
        tmp_path: Isolated native source, calculation and download directories.
    """
    path, values, transform = write_box_raster(tmp_path / "values.tif")
    bounds = sampling_box_bounds(BOX)
    area = AggregateArea(kind="samplingBox", bounds=bounds, samplingBox=BOX)
    assert AggregateArea.model_validate_json(area.model_dump_json()) == area
    assert not area.geometries and "geometries" not in area.model_dump(
        exclude_defaults=True
    )
    spec = make_spec(path, ["mean(a)", "count(a)", "areaha(a >= 0)"], area)
    aggregate_dir = tmp_path / "aggregate"
    aggregate_dir.mkdir()
    result = calculate_raster_statistics_for_area(path, spec, aggregate_dir, LIMITS)
    ring = reference_box_ring(BOX)
    outcomes = reference_numeric_outcomes(values, transform, False)
    means = [float(outcome.mean()) for outcome in outcomes]
    assert min(means) - 1e-10 <= float(result.rows[0]["value"]) <= max(means) + 1e-10
    assert (
        min(len(outcome) for outcome in outcomes)
        <= int(result.rows[1]["value"])
        <= max(len(outcome) for outcome in outcomes)
    )
    reference_hectares = (
        abs(Geod(ellps="WGS84").polygon_area_perimeter(*zip(*ring))[0]) / 10000
    )
    # One NoData cell is excluded by the owning area contract.
    assert 0 < float(result.rows[2]["value"]) < reference_hectares
    assert float(result.rows[2]["value"]) == pytest.approx(
        reference_hectares, rel=0.002
    )
    clip_area = ClipArea(kind="samplingBox", bounds=bounds, samplingBox=BOX)
    clip = make_clip_spec(path, clip_area)
    clip = ClipSpec.model_validate_json(clip.model_dump_json(by_alias=True))
    clip_dir = tmp_path / "clip"
    clip_dir.mkdir()
    artifact = create_clip(path, clip, clip_dir, CLIP_LIMITS)
    with rasterio.open(clip_dir / "result.tif") as output:
        col, row, width, height = clip.grid.window
        original = values[row : row + height, col : col + width]
        required, possible = reference_membership_bounds(
            original, output.transform, True
        )
        actual = output.read_masks(1) > 0
        assert np.all(~required | actual) and np.all(~actual | possible)
        assert artifact.valid_pixels == int(actual.sum())
        assert np.array_equal(output.read(1)[actual], original[actual])


def test_sampling_box_requests_binding_and_cache_identity_preserve_rectangles() -> None:
    """Admit one path-free area and keep boxes distinct from equal-envelope rectangles."""
    descriptor = BOX.model_dump(mode="json")
    selected_bounds = dict(
        zip(("west", "south", "east", "north"), sampling_box_bounds(BOX), strict=True)
    )
    numeric = CatalogRasterStatisticsRequest(**SOURCE, samplingBox=descriptor)
    paired = CatalogRasterPairRequest(
        xRaster=SOURCE, yRaster=SOURCE, samplingBox=descriptor
    )
    aggregate = AggregatePlanRequest(
        sources={"a": SOURCE},
        calculations=[{"label": "Mean", "expression": "mean(a)"}],
        samplingBox=descriptor,
    )
    clip = ClipInputs(**SOURCE, samplingBox=descriptor)
    assert (
        numeric.sampling_box
        == paired.sampling_box
        == aggregate.samplingBox
        == clip.samplingBox
        == BOX
    )
    assert bind_area_arguments({"kind": "samplingBox", "samplingBox": descriptor}) == {
        "samplingBox": descriptor
    }
    signature = (1, 2, 3, 4, 5)
    keys = calculation_result_cache_keys(aggregate, signature)
    rectangle = AggregatePlanRequest(
        sources={"a": SOURCE},
        calculations=aggregate.calculations,
        selectedBounds=selected_bounds,
    )
    assert keys != calculation_result_cache_keys(rectangle, signature)
    for constructor, fields in [
        (CatalogRasterStatisticsRequest, SOURCE),
        (CatalogRasterPairRequest, {"xRaster": SOURCE, "yRaster": SOURCE}),
        (
            AggregatePlanRequest,
            {"sources": {"a": SOURCE}, "calculations": aggregate.calculations},
        ),
        (ClipInputs, SOURCE),
    ]:
        with pytest.raises(ValidationError):
            constructor(
                **fields, samplingBox=descriptor, selectedBounds=selected_bounds
            )
    with pytest.raises(ValidationError):
        AggregateArea(kind="samplingBox", bounds=(0, 0, 1, 1), samplingBox=BOX)
    with pytest.raises(ValidationError):
        ClipArea(kind="bounds", bounds=sampling_box_bounds(BOX), samplingBox=BOX)
