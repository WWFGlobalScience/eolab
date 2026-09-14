"""Compare legacy and opt-in batching in fresh processes; no CI timing thresholds.

Run ``python tests/benchmark_aggregate_batching.py --scratch D:/eolab-benchmark-360``.
Only unique temporary children of the explicit scratch directory are written.
OS/storage caches are not flushed; first-pass and warm-repeat labels describe
run order, not guaranteed cold-cache conditions. Each run reports process peak
resident memory when the platform exposes it, including interpreter/setup costs.
"""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np
import rasterio
from rasterio.transform import from_origin

from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_aggregate import calculate_raster_statistics_for_area
from test_raster_aggregates import make_spec, LIMITS


def peak_memory() -> int | None:
    """Read this fresh benchmark process's resident high-water mark.

    Returns:
        Peak resident bytes, or None when unsupported.
    """
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            """Windows process memory counters in native pointer-width units."""

            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                *[
                    (name, ctypes.c_size_t)
                    for name in (
                        "PeakWorkingSetSize",
                        "WorkingSetSize",
                        "QuotaPeakPagedPoolUsage",
                        "QuotaPagedPoolUsage",
                        "QuotaPeakNonPagedPoolUsage",
                        "QuotaNonPagedPoolUsage",
                        "PagefileUsage",
                        "PeakPagefileUsage",
                    )
                ],
            ]

        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(Counters),
            wintypes.DWORD,
        ]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if psapi.GetProcessMemoryInfo(
            kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb
        ):
            return counters.PeakWorkingSetSize
        return None
    try:
        import resource

        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(value if sys.platform == "darwin" else value * 1024)
    except ImportError:
        return None


def measure(path: Path, output: Path, case: str, target: int | None) -> dict:
    """Measure one identical source/area/formula intent with a chosen batch size.

    Args:
        path: Closed synthetic native source.
        output: Private artifact directory.
        case: Numeric whole grid or mixed polygon case.
        target: Pixel budget, or legacy default.

    Returns:
        Plan, measured times/calls/memory and lossless results, or admission refusal.
    """
    expressions = ["mean(a)", "sum(a,where=a>10)", "count(a>10)"]
    area = None
    if case == "polygon":
        geometry = {
            "type": "Polygon",
            "coordinates": [
                [
                    [-81.98, -19.9],
                    [-63.1, -19.8],
                    [-62.5, -1.4],
                    [-70, -2],
                    [-81.98, 0],
                    [-81.98, -19.9],
                ],
                [[-75, -15], [-72, -15], [-74, -11], [-75, -15]],
            ],
        }
        area = AggregateArea(
            kind="aoi", bounds=(-81.98, -19.9, -62.5, 0), geometries=(geometry,)
        )
        expressions = ["areaha(a>10)", "count(a>10)"]
    start = time.perf_counter()
    try:
        spec = make_spec(path, expressions, area, target_chunk_pixels=target)
    except ProcessingError as error:
        return {
            "refused": error.code,
            "message": error.detail,
            "planSeconds": time.perf_counter() - start,
        }
    plan_seconds = time.perf_counter() - start
    result = calculate_raster_statistics_for_area(path, spec, output, LIMITS)
    return {
        "planSeconds": plan_seconds,
        "estimatedMemoryBytes": spec.grid.estimatedMemoryBytes,
        "nativeBlocks": spec.grid.nativeBlocks,
        "performance": result.performance,
        "rows": result.rows,
        "peakResidentBytes": peak_memory(),
    }


def main() -> None:
    """Create bounded fixtures, compare runs, and print JSON measurements."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scratch", type=Path)
    parser.add_argument(
        "--worker", nargs=4, metavar=("SOURCE", "OUTPUT", "CASE", "TARGET")
    )
    parser.add_argument("--repeats", type=int, default=2, choices=range(1, 6))
    args = parser.parse_args()
    if args.worker:
        path, output, case, target = args.worker
        print(json.dumps(measure(Path(path), Path(output), case, int(target) or None)))
        return
    if args.scratch is None:
        parser.error("Choose an explicit --scratch directory")
    root = args.scratch.resolve()
    root.mkdir(parents=True, exist_ok=True)
    revision = subprocess.check_output(
        ["git", "describe", "--always", "--dirty"], text=True
    ).strip()
    with tempfile.TemporaryDirectory(prefix="batching-360-", dir=root) as temporary:
        scratch = Path(temporary).resolve()
        assert scratch.is_relative_to(root) and scratch != root
        for case, block in [("numeric", 32), ("numeric", 512), ("polygon", 512)]:
            path = scratch / f"{case}-{block}.tif"
            with rasterio.open(
                path,
                "w",
                driver="GTiff",
                width=2000,
                height=1000,
                count=1,
                dtype="uint16",
                crs="EPSG:4326",
                transform=from_origin(-82, 0, 0.01, 0.02),
                tiled=True,
                blockxsize=block,
                blockysize=block,
                compress="deflate",
                nodata=65535,
            ) as ds:
                ds.write(
                    np.broadcast_to(
                        np.arange(2000, dtype="uint16") % 50, (1000, 2000)
                    ).copy(),
                    1,
                )
            baseline = None
            for repeat in range(args.repeats):
                for target in [0, 65536, 262144, 1048576, 4194304]:
                    output = scratch / f"{case}-{block}-{repeat}-{target}"
                    output.mkdir()
                    measurement = json.loads(
                        subprocess.check_output(
                            [
                                sys.executable,
                                __file__,
                                "--worker",
                                str(path),
                                str(output),
                                case,
                                str(target),
                            ],
                            text=True,
                        )
                    )
                    if "rows" in measurement:
                        if baseline is None:
                            baseline = measurement["rows"]
                        for expected, actual in zip(
                            baseline, measurement["rows"], strict=True
                        ):
                            assert expected["aggregates"] == actual["aggregates"], (
                                case,
                                block,
                                target,
                                expected,
                                actual,
                            )
                            assert np.isclose(
                                float(expected["value"]),
                                float(actual["value"]),
                                rtol=1e-8,
                                atol=1e-8,
                            )
                    print(
                        json.dumps(
                            {
                                "case": case,
                                "nativeBlockShape": [block, block],
                                "dtype": "uint16",
                                "sourcePixels": 2000000,
                                "revision": revision,
                                "targetChunkPixels": target or None,
                                "pass": (
                                    "first-pass"
                                    if repeat == 0
                                    else f"warm-repeat-{repeat}"
                                ),
                                **measurement,
                            }
                        ),
                        flush=True,
                    )


if __name__ == "__main__":
    main()
