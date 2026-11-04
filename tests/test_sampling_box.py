"""Prove the shared geodesic box contract independently of its feature consumers."""

import json
import math
from pathlib import Path
from typing import Any

from affine import Affine
import numpy
from pydantic import ValidationError
from pyproj import Geod, Transformer
import pytest
from shapely import distance, points
from shapely.geometry import LineString

from eolab_app.sampling_box import (
    BoxProjection,
    MEAN_EARTH_RADIUS_KM,
    SamplingBoxCoordinateLimitError,
    Wgs84SamplingBox,
    interpolate_great_circle,
    sampling_box_bounds,
    sampling_box_corners,
    tessellate_sampling_box,
)

GOLDENS = json.loads(
    (Path(__file__).parent / "fixtures/sampling-box-geodesics.json").read_text()
)
SPHERE = Geod(a=MEAN_EARTH_RADIUS_KM * 1000, b=MEAN_EARTH_RADIUS_KM * 1000)


def _box(case: dict[str, Any]) -> Wgs84SamplingBox:
    """Read one shared browser/server descriptor through its owning boundary.

    Args:
        case: A numerical case from the cross-language fixture.

    Returns:
        Validated immutable sampling box.
    """
    return Wgs84SamplingBox.model_validate(case["samplingBox"])


def _projector(crs: str, grid: Affine) -> BoxProjection:
    """Create a native-pixel projection with independent PROJ and affine transforms.

    Args:
        crs: Actual projected coordinate system.
        grid: Native pixel-to-CRS affine, including rotation and unequal scales.

    Returns:
        Batch callback from WGS 84 positions to the actual native pixel grid.
    """
    transformer = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    inverse = ~grid

    def project_positions(
        positions: tuple[tuple[float, float], ...],
    ) -> tuple[tuple[float, ...], ...]:
        """Project a geographic batch into this native pixel grid.

        Args:
            positions: Longitude/latitude pairs.

        Returns:
            Pixel column/row positions in the same order.
        """
        longitude, latitude = zip(*positions, strict=True)
        x, y = transformer.transform(longitude, latitude)
        return tuple(inverse * point for point in zip(x, y, strict=True))

    return project_positions


def _dense_boundary(box: Wgs84SamplingBox) -> tuple[tuple[float, float], ...]:
    """Generate an independent, dense great-circle reference using PROJ.

    Args:
        box: Validated descriptor.

    Returns:
        Closed reference ring with 2,000 interior points per edge.
    """
    corners = sampling_box_corners(box)
    positions = []
    for edge, start in enumerate(corners):
        end = corners[(edge + 1) % 4]
        positions.extend((start, *SPHERE.npts(*start, *end, 2000)))
    return (*positions, corners[0])


@pytest.mark.parametrize("case", GOLDENS["cases"], ids=lambda case: case["name"])
def test_corners_midpoints_and_envelope_match_shared_goldens_and_proj(
    case: dict[str, Any],
) -> None:
    """Retain the original corners and include the complete great-circle envelope."""
    box = _box(case)
    corners = sampling_box_corners(box)
    numpy.testing.assert_allclose(corners, case["corners"], rtol=0, atol=1e-10)
    for index, bearing in enumerate((315, 45, 135, 225)):
        longitude, latitude, _ = SPHERE.fwd(
            box.center.longitude,
            box.center.latitude,
            bearing,
            box.sideLengthKm * 1000 / math.sqrt(2),
        )
        numpy.testing.assert_allclose(
            corners[index], (longitude, latitude), rtol=0, atol=1e-9
        )
        midpoint = interpolate_great_circle(
            corners[index], corners[(index + 1) % 4], 0.5
        )
        numpy.testing.assert_allclose(
            midpoint, case["edgeMidpoints"][index], rtol=0, atol=1e-9
        )
        numpy.testing.assert_allclose(
            midpoint,
            SPHERE.npts(*corners[index], *corners[(index + 1) % 4], 1)[0],
            rtol=0,
            atol=1e-8,
        )
    bounds = sampling_box_bounds(box)
    numpy.testing.assert_allclose(bounds, case["bounds"], rtol=0, atol=1e-8)
    dense = numpy.array(_dense_boundary(box))
    assert dense[:, 0].min() >= bounds[0] - 1e-8
    assert dense[:, 0].max() <= bounds[2] + 1e-8
    assert dense[:, 1].min() >= bounds[1] - 1e-8
    assert dense[:, 1].max() <= bounds[3] + 1e-8


@pytest.mark.parametrize(
    "name", ["northern", "high-latitude", "continental", "near-limit"]
)
def test_adaptive_projection_error_and_refinement_on_rotated_anisotropic_grid(
    name: str,
) -> None:
    """Meet actual native-pixel accuracy against independent dense geodesics."""
    box = _box(next(case for case in GOLDENS["cases"] if case["name"] == name))
    project = _projector("EPSG:3857", Affine(1200, 300, -2e6, -100, 500, 1e7))
    dense = points(numpy.array(project(_dense_boundary(box))))
    previous_count = 0
    for tolerance in (0.25, 0.0625):
        ring = tessellate_sampling_box(box, project, maximum_error_pixels=tolerance)
        assert ring[0] == ring[-1]
        assert len(ring) >= previous_count
        previous_count = len(ring)
        error = numpy.max(distance(LineString(project(ring)), dense))
        assert error <= tolerance * 1.005, (name, tolerance, error)


def test_combined_native_and_ground_area_accuracy_metrics() -> None:
    """A concatenated metric preserves both pixel and equal-area tolerances."""
    box = _box(next(case for case in GOLDENS["cases"] if case["name"] == "northern"))
    native = _projector("EPSG:3857", Affine(1200, 300, -2e6, -100, 500, 1e7))
    equal_area = _projector("EPSG:6933", Affine.identity())
    metre_tolerance = 0.1

    def combined(
        positions: tuple[tuple[float, float], ...],
    ) -> tuple[tuple[float, ...], ...]:
        """Scale metre coordinates so the common metric enforces both accuracies.

        Args:
            positions: Geographic batch to measure.

        Returns:
            Native pixel pairs followed by scaled equal-area metre pairs.
        """
        return tuple(
            (*pixel, *(value * 0.25 / metre_tolerance for value in metre))
            for pixel, metre in zip(
                native(positions), equal_area(positions), strict=True
            )
        )

    ring = tessellate_sampling_box(box, combined)
    dense = _dense_boundary(box)
    assert (
        numpy.max(
            distance(LineString(native(ring)), points(numpy.array(native(dense))))
        )
        <= 0.251
    )
    assert (
        numpy.max(
            distance(
                LineString(equal_area(ring)), points(numpy.array(equal_area(dense)))
            )
        )
        <= metre_tolerance * 1.005
    )


def test_boundary_capacity_and_explicit_unlimited_work() -> None:
    """Keep caller-owned interactive budgets without imposing a Processing ceiling."""
    box = _box(next(case for case in GOLDENS["cases"] if case["name"] == "northern"))
    project = _projector("EPSG:3857", Affine.scale(100, 100))
    with pytest.raises(SamplingBoxCoordinateLimitError):
        tessellate_sampling_box(box, project, maximum_coordinates=15)
    assert len(tessellate_sampling_box(box, project, maximum_coordinates=None)) > 16
    with pytest.raises(ValueError, match="positive finite"):
        tessellate_sampling_box(box, project, maximum_error_pixels=0)
    with pytest.raises(ValueError, match="projected"):
        tessellate_sampling_box(
            box, lambda values: tuple((math.inf, 0) for _ in values)
        )


@pytest.mark.parametrize(
    "center,size",
    [
        ({"longitude": 0, "latitude": 48}, 6742),
        ({"longitude": 179.5, "latitude": 0}, 200),
        ({"longitude": 0, "latitude": 89.5}, 200),
    ],
)
def test_existing_polar_and_date_line_rejections(
    center: dict[str, float], size: int
) -> None:
    """Retain the approved nonwrapping/nonpolar admission boundary."""
    with pytest.raises(ValidationError, match="pole|date line"):
        Wgs84SamplingBox(center=center, sideLengthKm=size)


def test_path_free_capture_and_immutable_identity() -> None:
    """Capture only center and size, never a generated polygon or source path."""
    box = _box(GOLDENS["cases"][1])
    captured = box.model_dump(mode="json")
    assert set(captured) == {"center", "sideLengthKm"}
    assert Wgs84SamplingBox.model_validate(captured) == box
    tessellate_sampling_box(box, lambda values: values)
    assert box.model_dump(mode="json") == captured
    with pytest.raises(ValidationError):
        Wgs84SamplingBox.model_validate({**captured, "sourcePath": "/tmp/a.tif"})
    with pytest.raises(ValidationError):
        box.sideLengthKm = 1000
