"""Exercise the standalone benchmark through its real CLI and native sources."""

import json
import os
from pathlib import Path
import subprocess
import sys

import fiona
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box, mapping


@pytest.mark.parametrize("codes", [("PER", "BRA"), ("PER", "XXX")])
def test_benchmark_native_sum_and_required_selection(
    tmp_path: Path, codes: tuple[str, str]
) -> None:
    """Use exact polygon masks/native values or reject an incomplete selection.

    Args:
        tmp_path: Isolated input files, working directory and kernel scratch.
        codes: Both requested countries, or an incomplete selection.
    """
    raster = tmp_path / "raster.tif"
    vector = tmp_path / "countries.gpkg"
    values = np.arange(32 * 32, dtype="float32").reshape(32, 32)
    values[0, 0] = -9999
    with rasterio.open(
        raster,
        "w",
        driver="GTiff",
        height=32,
        width=32,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(0, 32, 1, 1),
        nodata=-9999,
        tiled=True,
        blockxsize=16,
        blockysize=16,
    ) as dataset:
        dataset.write(values, 1)
    with fiona.open(
        vector,
        "w",
        driver="GPKG",
        layer="countries_without_antarctica",
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": {"iso3": "str"}},
    ) as dataset:
        for code, polygon in zip(
            (*codes, "OTHER"),
            (box(0, 16, 16, 32), box(16, 0, 32, 16), box(16, 16, 32, 32)),
            strict=True,
        ):
            dataset.write({"properties": {"iso3": code}, "geometry": mapping(polygon)})
    identity_before = [
        (p.stat().st_size, p.stat().st_mtime_ns) for p in (raster, vector)
    ]
    script = Path(__file__).resolve().parents[1] / "run_raster_vector_sum_benchmark.py"
    completed = subprocess.run(
        [
            sys.executable,
            str(script),
            "--raster",
            str(raster),
            "--vector",
            str(vector),
            "--repeat",
            "2",
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "TEMP": str(tmp_path), "TMP": str(tmp_path)},
    )
    assert [
        (p.stat().st_size, p.stat().st_mtime_ns) for p in (raster, vector)
    ] == identity_before
    assert not list(tmp_path.glob("eolab-sum-benchmark-*"))
    if "BRA" not in codes:
        assert completed.returncode != 0
        assert "Expected exactly two PER/BRA features; found 1" in completed.stderr
        assert not completed.stdout
        return
    assert completed.returncode == 0, completed.stderr
    report = json.loads(completed.stdout)
    assert report["importSeconds"] >= 0
    first, second = report["runs"]
    expected = values[:16, :16][values[:16, :16] != -9999].sum(dtype="float64")
    expected += values[16:, 16:].sum(dtype="float64")
    assert float(first["rows"][0]["value"]) == expected
    assert first["rows"] == second["rows"]
    assert first["csvSha256"] == second["csvSha256"]
    assert first["selectionSummary"]["matched"] == 2
    assert first["selectionSummary"]["total"] == 3
    assert first["grid"]["execution"]["targetChunkPixels"] is None
    for run in report["runs"]:
        timing = run["timing"]
        assert sum(
            v for k, v in timing.items() if k != "totalSeconds"
        ) == pytest.approx(timing["totalSeconds"])
        performance = run["performance"]
        assert performance["readWindows"] == 4
        assert performance["stages"]["selectionMaskSeconds"] > 0
        breakdown = performance["stages"]["selectionMaskBreakdown"]
        assert performance["stages"]["selectionSetupSeconds"] > 0
        assert performance["retainedPolygonBytes"] > 0
        assert breakdown["featureReadingSeconds"] == 0
        assert breakdown["projectionSeconds"] == 0
        assert breakdown["rasterizationSeconds"] > 0
        assert sum(breakdown.values()) <= performance["stages"]["selectionMaskSeconds"]
        assert timing["executionSeconds"] >= performance["kernelSeconds"]
