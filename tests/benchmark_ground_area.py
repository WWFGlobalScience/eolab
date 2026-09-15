"""Run reproducible synthetic native-area kernel benchmarks without a server.

Execute from the repository root with ``python tests/benchmark_ground_area.py``.
Fixtures and artifacts live only in an automatically cleaned temporary folder.
Reported wall times exclude HTTP, process startup and queue waits.
"""

from dataclasses import dataclass
import json
import math
from pathlib import Path
import sys
import tempfile
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from affine import Affine
import numpy as np
from pyproj import Transformer
from rasterio.transform import from_origin
from shapely.geometry import Polygon, mapping

from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.raster_aggregate import calculate_raster_statistics_for_area
from test_ground_area import reference_area
from test_raster_aggregates import LIMITS, make_spec
from test_raster_clips import write_source


@dataclass
class Case:
    """One deterministic source grid and geographic selection."""

    name: str
    rows: int
    columns: int
    transform: Affine
    crs: str
    area: AggregateArea | None = None


def main() -> None:
    """Measure planning/execution times and publish their input/work metadata."""
    to_wgs = Transformer.from_crs(3857, 4326, always_xy=True)
    west, south = to_wgs.transform(575_400, 4_550_300)
    east, north = to_wgs.transform(950_700, 4_925_200)
    polygon = Polygon(
        [(10.1, 45.1), (12.4, 45.2), (11.6, 47.4), (10.1, 45.1)],
        [[(11, 46), (11.2, 46), (11.1, 46.2), (11, 46)]],
    )
    country = Polygon(
        [(-82, -20), (-62, -20), (-62, 0), (-70, -2), (-82, 0), (-82, -20)],
        [[(-75, -15), (-72, -15), (-74, -11), (-75, -15)]],
    )
    cases = [
        Case(
            "global-geographic",
            720,
            1440,
            from_origin(-180, 90, 0.25, 0.25),
            "EPSG:4326",
        ),
        Case(
            "web-mercator-box",
            512,
            512,
            from_origin(500_000, 5_000_000, 1000, 1000),
            "EPSG:3857",
            AggregateArea(kind="bounds", bounds=(west, south, east, north)),
        ),
        Case(
            "uploaded-polygon-with-hole",
            256,
            256,
            from_origin(10, 47.56, 0.01, 0.01),
            "EPSG:4326",
            AggregateArea(
                kind="aoi", bounds=polygon.bounds, geometries=(mapping(polygon),)
            ),
        ),
        Case(
            "rotated-utm",
            128,
            128,
            Affine(1000, 200, 500_000, 100, -1000, 5_000_000),
            "EPSG:32632",
        ),
        Case(
            "country-scale-polygon-with-hole",
            1000,
            2000,
            from_origin(-82, 0, 0.01, 0.02),
            "EPSG:4326",
            AggregateArea(
                kind="aoi", bounds=country.bounds, geometries=(mapping(country),)
            ),
        ),
    ]
    measurements = []
    with tempfile.TemporaryDirectory(prefix="eolab-area-benchmark-") as temporary:
        root = Path(temporary).resolve()
        assert root.is_relative_to(Path(tempfile.gettempdir()).resolve())
        for case in cases:
            output = root / case.name
            output.mkdir()
            values = (
                np.broadcast_to(
                    np.arange(case.columns, dtype="uint16") % 5,
                    (case.rows, case.columns),
                )
                .astype("uint8")
                .copy()
            )
            path = write_source(
                output / "source.tif", values, transform=case.transform, crs=case.crs
            )
            start = perf_counter()
            spec = make_spec(
                path, ["areaha(a >= 0)", "areaha(a >= 2)", "count(a >= 2)"], case.area
            )
            planned = perf_counter()
            result = calculate_raster_statistics_for_area(path, spec, output, LIMITS)
            end = perf_counter()
            if case.name == "country-scale-polygon-with-hole":
                assert math.isclose(
                    float(result.rows[0]["value"]), reference_area(country), rel_tol=1e-6
                ), "Country-scale area must match independent ellipsoidal integration"
            measurements.append(
                {
                    "case": case.name,
                    "sourcePixels": case.rows * case.columns,
                    "plannedPixels": spec.grid.width * spec.grid.height,
                    "nativeBlocks": spec.grid.nativeBlocks,
                    "decodedBytes": spec.grid.decodedBytes,
                    "geometryCells": spec.grid.groundArea.estimatedGeometryCells,
                    "planSeconds": round(planned - start, 4),
                    "executeSeconds": round(end - planned, 4),
                    "results": [row["value"] for row in result.rows],
                }
            )
    print(json.dumps(measurements, indent=2))


if __name__ == "__main__":
    main()
