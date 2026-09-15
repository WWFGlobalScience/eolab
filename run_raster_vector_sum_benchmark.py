"""Run the app's native sum(a) over the Peru/Brazil polygons, without HTTP/jobs.

Run with the repository's Python 3.12+ environment and installed dependencies.
Defaults point at the local audit data; use --raster/--vector on another machine.
This trusted local harness supplies file capabilities instead of using Catalog
authorization. It does not change the application's path-free API or execute a
second implementation of filtering, clipping, raster reading, or summation.
JSON goes to stdout; progress goes to stderr. Ctrl+C interrupts the direct call.
"""

from __future__ import annotations

import time

_STARTED = time.perf_counter()

import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
from typing import Any

# Always benchmark this checkout, even if an older EOLab is installed.
_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT / "src"))

import fiona
import numpy
import rasterio

from eolab_app.attribute_filter import VectorFilter, VectorFilterRule, validate_filter
from eolab_app.bounded_vector import selection_summary
from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateSpec,
    NamedCalculation,
    RasterAggregateLimits,
)
from eolab_app.processing.raster_aggregate import (
    calculate_raster_statistics_for_area,
    plan_aggregate,
)
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.selection_source import ogr_predicate
from eolab_app.vector.sources import vector_source_signature

_IMPORT_SECONDS = time.perf_counter() - _STARTED
DEFAULT_RASTER = Path(
    "D:/wwf-connectivity/processed/human-footprint/"
    "human-footprint_hfp_2018_wgs84_cog.tif"
)
DEFAULT_VECTOR = Path(
    "D:/easy_to_find_data_i_always_use/countries_without_antarctica.gpkg"
)


def prepare_selection(path: Path, layer: str) -> ResolvedCatalogSelection:
    """Bind an explicit local GeoPackage to the app's exact predicate reader.

    Args:
        path: Closed, read-only local input selected by the benchmark operator.
        layer: Native polygon layer containing a string iso3 field.

    Returns:
        File-signature-fenced selection using the production predicate compiler.

    Raises:
        OSError: If the source cannot be inspected.
        ValueError: If the source or predicate is incompatible.
        fiona.errors.FionaError: If the native layer cannot be opened.
    """
    source = ResolvedVectorSource(
        source_kind="mounted",
        source_format="geopackage",
        source_path=path,
        asset_key="data",
        layer_name=layer,
    )
    signature = vector_source_signature(source)
    candidate = VectorFilter(
        match="any",
        rules=tuple(
            VectorFilterRule(field="iso3", operator="eq", value=code)
            for code in ("PER", "BRA")
        ),
    )
    with fiona.open(path, layer=layer, enabled_drivers=["GPKG"]) as dataset:
        candidate = validate_filter(candidate, dataset.schema["properties"])
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="benchmark-countries",
        assetKey="data",
        layerName=layer,
        sourceSignature=hashlib.sha256(json.dumps(signature).encode()).hexdigest(),
        filter=candidate,
    )
    return ResolvedCatalogSelection(
        selection=selection,
        path=path,
        driver="GPKG",
        components=tuple((path, tuple(values)) for _, *values in signature),
        where=ogr_predicate(candidate),
    )


def run_benchmark(raster: Path, vector: Path, layer: str) -> dict[str, Any]:
    """Run selection, planning and execution once through production functions.

    Args:
        raster: Explicit local native raster; no overview substitution.
        vector: Explicit local countries GeoPackage.
        layer: Native layer name; exactly two features must match PER/BRA.

    Returns:
        Result, source/grid identities and nested wall-clock stage measurements.

    Raises:
        ValueError: If the selection does not contain exactly two features.
        OSError: If an input or temporary artifact cannot be accessed.
        Exception: Production validation, admission and execution errors propagate.
    """
    started = time.perf_counter()
    limits = RasterAggregateLimits()
    signature = tuple(RasterSourceIdentity.read(raster).to_catalog())
    resolved = prepare_selection(vector, layer)
    source_ready = time.perf_counter()
    print("Selecting Peru and Brazil...", file=sys.stderr, flush=True)
    summary = selection_summary(resolved)
    if summary["matched"] != 2:
        raise ValueError(
            f"Expected exactly two PER/BRA features; found {summary['matched']}"
        )
    selected = time.perf_counter()
    area = AggregateArea(
        kind="catalogSelection",
        bounds=summary["bbox"],
        catalogSelection=resolved.selection,
        resolved=resolved,
    )
    calculations = (NamedCalculation(label="Sum", expression="sum(a)"),)
    print("Planning native raster reads...", file=sys.stderr, flush=True)
    grid = plan_aggregate(raster, area, calculations, "a", limits)
    planned = time.perf_counter()
    calculation_plan = AggregateSpec(
        sources={
            "a": CatalogRasterRequest(
                collectionId="eolab-mounted-geotiffs",
                itemId="geotiff-"
                + hashlib.sha256(str(raster).encode()).hexdigest()[:24],
            )
        },
        sourceSignature=signature,
        area=area,
        calculations=calculations,
        grid=grid,
    )
    print(
        "Summing native pixels inside the two polygons...", file=sys.stderr, flush=True
    )
    with tempfile.TemporaryDirectory(prefix="eolab-sum-benchmark-") as directory:
        execution_started = time.perf_counter()
        artifact = calculate_raster_statistics_for_area(
            raster,
            calculation_plan=calculation_plan,
            directory=Path(directory),
            limits=limits,
        )
        execution_finished = time.perf_counter()
        # Keep numerical semantics/counts and provenance in the report; the
        # kernel's temporary CSV/progress/provenance files are cleaned up.
        result = {
            "rows": artifact.rows,
            "csvSha256": artifact.sha256,
            "performance": artifact.performance,
        }
    finished = time.perf_counter()
    return {
        "inputs": {
            "raster": str(raster),
            "rasterSignature": signature,
            "vector": str(vector),
            "vectorComponents": [
                {"path": str(path), "signature": values}
                for path, values in resolved.components
            ],
            "selection": resolved.selection.model_dump(by_alias=True),
        },
        "selectionSummary": summary,
        "grid": grid.model_dump(),
        "limits": asdict(limits),
        "timing": {
            "sourceBindingSeconds": source_ready - started,
            "vectorSelectionSeconds": selected - source_ready,
            "planningSeconds": planned - selected,
            "executionSeconds": execution_finished - execution_started,
            "harnessOverheadSeconds": (
                execution_started - planned + finished - execution_finished
            ),
            "totalSeconds": finished - started,
        },
        **result,
    }


def main() -> None:
    """Parse local inputs, run repetitions and print one JSON benchmark report.

    Raises:
        SystemExit: For invalid CLI arguments or unavailable local input files.
        Exception: Production validation/execution errors propagate without retry.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raster", type=Path, default=DEFAULT_RASTER)
    parser.add_argument("--vector", type=Path, default=DEFAULT_VECTOR)
    parser.add_argument("--layer", default="countries_without_antarctica")
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be at least 1")
    for name in ("raster", "vector"):
        path = getattr(args, name).expanduser().resolve()
        if not path.is_file():
            parser.error(f"{name} not found: {path}; provide --{name} PATH")
        setattr(args, name, path)
    try:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain", "--untracked-files=no"],
                cwd=_ROOT,
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )
    except (OSError, subprocess.CalledProcessError):
        revision, dirty = None, None
    runs = []
    for index in range(args.repeat):
        print(f"Run {index + 1}/{args.repeat}", file=sys.stderr, flush=True)
        runs.append(run_benchmark(args.raster, args.vector, args.layer))
    print(
        json.dumps(
            {
                "checkout": {"commit": revision, "trackedChanges": dirty},
                "runtime": {
                    "python": platform.python_version(),
                    "platform": platform.platform(),
                    "rasterio": rasterio.__version__,
                    "gdal": rasterio.__gdal_version__,
                    "fiona": fiona.__version__,
                    "numpy": numpy.__version__,
                },
                "importSeconds": _IMPORT_SECONDS,
                "notes": [
                    "Each run repeats selection, planning and native execution; caches are not cleared.",
                    "Outer timing stages sum to totalSeconds; importSeconds is separate.",
                    "performance is nested inside executionSeconds; its stages are not additive to parents.",
                    "selectionMaskSeconds includes vector reads, validation, projection and rasterization.",
                    "selectionMaskBreakdown is nested inside selectionMaskSeconds; do not add it again.",
                    "featureReadingSeconds includes tile bounds lookup, source opening, iteration, filtering, validation and closing.",
                    "No HTTP, catalog lookup, queue, process pool, SSE or browser timing is included.",
                    "Inputs are read-only; temporary kernel artifacts are removed after each run.",
                    "Compare only matching input identities, grid, limits, runtime and returned values.",
                ],
                "runs": runs,
            },
            indent=2,
            allow_nan=False,
        )
    )


if __name__ == "__main__":
    main()
