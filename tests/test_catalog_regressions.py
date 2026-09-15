"""Preserve end-to-end mounted-catalog scan regression coverage."""

import asyncio
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Barrier, Event, Lock
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx2
import fiona
import numpy
import psycopg
import pytest
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.shutil import copy as copy_raster
from rasterio.transform import from_bounds, from_origin

from tests.catalog_support import (
    RecordingCatalogDatabase,
    RecordingCatalogSession,
    RecordingCatalogWriter,
)

from eolab_app.catalog.handlers import (
    DatasetHandler,
    DatasetHandlerRegistry,
    create_default_dataset_handler_registry,
)
from eolab_app.catalog.metadata import build_dataset_metadata, create_metadata_executor
from eolab_app.catalog.models import CatalogItemSource, DatasetCandidate
from eolab_app.catalog.pgstac import (
    PgStacCatalogDatabase,
    catalog_item_source,
)
from eolab_app.catalog.reconciliation import (
    MissingItemReconciler,
    catalog_item_is_missing,
)
from eolab_app.catalog.scanner import ScanManager
from eolab_app.catalog.shapefile import (
    FALLBACK_DATETIME_DESCRIPTION as SHAPEFILE_DATETIME_DESCRIPTION,
    build_stac_item as build_shapefile_stac_item,
    discover_shapefile_datasets,
)
from eolab_app.catalog.stac_api import StacApiWriter
from eolab_app.catalog.geotiff import (
    ACQUISITION_DATETIME_DESCRIPTION,
    FALLBACK_DATETIME_DESCRIPTION,
    FILE_EXTENSION,
    SUGGESTED_WARP_BOUNDS_DESCRIPTION,
    build_stac_item as build_geotiff_stac_item,
)
from eolab_app.raster.catalog_contract import (
    COG_MEDIA_TYPE,
    GEOTIFF_MEDIA_TYPE,
)
from eolab_app.raster.sources import source_signature


DATASET_ITEM_BUILDERS = {
    ".tif": build_geotiff_stac_item,
    ".tiff": build_geotiff_stac_item,
    ".shp": build_shapefile_stac_item,
}


def build_test_registry_items(
    source_root: Path,
    candidate: DatasetCandidate,
) -> tuple[dict[str, Any], ...]:
    """Adapt historical single-Item test doubles to the handler contract.

    Args:
        source_root: Root directory mounted for scanning.
        candidate: Dataset and grouped components selected by discovery.

    Returns:
        One Item built by the active per-extension regression double.

    Raises:
        Exception: Propagates the configured builder's failure.
    """
    builder_arguments: list[Any] = [source_root, candidate.path]
    if candidate.component_paths:
        builder_arguments.append(candidate.component_paths)
    return (
        DATASET_ITEM_BUILDERS[candidate.path.suffix.lower()](*builder_arguments),
    )


def create_test_dataset_handler_registry() -> DatasetHandlerRegistry:
    """Create production discovery handlers with test-controlled builders.

    Returns:
        Explicit registry whose builders remain visible to thread workers.
    """
    return DatasetHandlerRegistry(handlers=tuple(
        DatasetHandler(
            name=handler.name,
            discover=handler.discover,
            build_items=build_test_registry_items,
        )
        for handler in create_default_dataset_handler_registry().handlers
    ))


@pytest.fixture(autouse=True)
def use_thread_executor_for_scan_unit_tests(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep parent-process test doubles visible to scan workers."""
    monkeypatch.setattr(
        "eolab_app.catalog.metadata.create_metadata_executor",
        ThreadPoolExecutor,
    )
    monkeypatch.setattr(
        "eolab_app.catalog.scanner.create_default_dataset_handler_registry",
        create_test_dataset_handler_registry,
    )


def write_geotiff(
    path: Path,
    acquisition_datetime: str | None = None,
    *,
    crs: str | None = "EPSG:4326",
    transform: Affine | None = None,
    width: int = 3,
    height: int = 2,
) -> None:
    """Write a small spatially valid GeoTIFF fixture."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if transform is None:
        transform = from_origin(-123, 49, 0.1, 0.1)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="uint8",
        crs=crs,
        transform=transform,
        nodata=0,
    ) as dataset:
        dataset.write(numpy.ones((1, height, width), dtype="uint8"))
        if acquisition_datetime is not None:
            dataset.update_tags(
                ns="IMAGERY",
                ACQUISITIONDATETIME=acquisition_datetime,
            )


def write_shapefile(
    path: Path,
    *,
    crs: str = "EPSG:3857",
    geometry: dict[str, Any] | None = None,
    write_feature: bool = True,
) -> tuple[Path, tuple[Path, ...]]:
    """Write and discover a small projected Shapefile fixture."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if geometry is None:
        geometry = {
            "type": "Polygon",
            "coordinates": [[
                [0, 0],
                [1_000, 0],
                [1_000, 1_000],
                [0, 1_000],
                [0, 0],
            ]],
        }
    with fiona.open(
        path,
        "w",
        driver="ESRI Shapefile",
        crs=crs,
        schema={
            "geometry": "Polygon",
            "properties": {"name": "str:40", "rank": "int"},
        },
    ) as dataset:
        if write_feature:
            dataset.write({
                "geometry": geometry,
                "properties": {"name": "fixture", "rank": 1},
            })
    datasets = discover_shapefile_datasets(path.parent, os.listdir(path.parent))
    assert len(datasets) == 1
    return datasets[0]


def test_geotiff_uses_embedded_acquisition_datetime(tmp_path: Path) -> None:
    """Prefer an unambiguous GDAL acquisition timestamp over file metadata."""
    geotiff_path = tmp_path / "nested" / "observation.tif"
    write_geotiff(geotiff_path, "2024-06-15T13:20:04-07:00")

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["properties"]["datetime"] == "2024-06-15T20:20:04Z"
    assert item["properties"]["description"] == ACQUISITION_DATETIME_DESCRIPTION
    assert item["properties"]["proj:epsg"] == 4326
    assert item["properties"]["proj:shape"] == [2, 3]
    assert item["bbox"] == pytest.approx([-123, 48.8, -122.7, 49])
    assert item["assets"]["data"]["raster:bands"] == [
        {"data_type": "uint8", "nodata": 0.0}
    ]
    assert item["assets"]["data"]["type"] == GEOTIFF_MEDIA_TYPE
    assert FILE_EXTENSION in item["stac_extensions"]
    assert item["assets"]["data"]["file:size"] > 0
    assert item["assets"]["data"]["eolab:source"] == {
        "source_signature": source_signature(geotiff_path).to_catalog(),
    }
    assert "eolab:rendering" not in item["assets"]["data"]
    json.dumps(item)


def test_cog_profile_is_recorded_from_gdal_layout_metadata(
    tmp_path: Path,
) -> None:
    """Identify a COG from GDAL metadata rather than its filename."""
    source_path = tmp_path / "source.tif"
    cog_path = tmp_path / "optimized.tif"
    write_geotiff(source_path, width=512, height=2048)
    copy_raster(source_path, cog_path, driver="COG", compress="DEFLATE")

    item = build_geotiff_stac_item(tmp_path, cog_path)

    assert item["assets"]["data"]["type"] == COG_MEDIA_TYPE
    assert item["assets"]["data"]["eolab:source"]["source_signature"] == (
        source_signature(cog_path).to_catalog()
    )


def test_cog_filename_does_not_define_the_storage_profile(tmp_path: Path) -> None:
    """Do not classify an ordinary GeoTIFF from a suggestive filename."""
    geotiff_path = tmp_path / "looks_like_a_cog.tif"
    write_geotiff(geotiff_path)

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["assets"]["data"]["type"] == GEOTIFF_MEDIA_TYPE


@pytest.mark.parametrize(
    ("rasterio_data_type", "stac_data_type"),
    (
        ("complex_int16", "cint16"),
        ("complex64", "other"),
        ("complex128", "cfloat64"),
    ),
)
def test_complex_geotiff_data_types_use_stac_names(
    tmp_path: Path,
    rasterio_data_type: str,
    stac_data_type: str,
) -> None:
    """Map Rasterio's complex names to the Raster Extension vocabulary."""
    geotiff_path = tmp_path / f"{rasterio_data_type}.tif"
    with rasterio.open(
        geotiff_path,
        "w",
        driver="GTiff",
        width=1,
        height=1,
        count=1,
        dtype=rasterio_data_type,
        crs="EPSG:4326",
        transform=from_origin(-123, 49, 1, 1),
    ):
        pass

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["assets"]["data"]["raster:bands"] == [
        {"data_type": stac_data_type}
    ]


def test_geotiff_discloses_filesystem_timestamp_fallback(tmp_path: Path) -> None:
    """Use and disclose file modification time when observation time is absent."""
    geotiff_path = tmp_path / "model-output.tiff"
    write_geotiff(geotiff_path)
    modified_at = datetime(2025, 2, 11, 17, 31, 52, tzinfo=timezone.utc)
    os.utime(geotiff_path, (modified_at.timestamp(), modified_at.timestamp()))

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["properties"]["datetime"] == "2025-02-11T17:31:52Z"
    assert item["properties"]["description"] == FALLBACK_DATETIME_DESCRIPTION
    assert item["assets"]["data"]["updated"] == "2025-02-11T17:31:52Z"


def test_geotiff_without_crs_is_a_dataset_error(
    tmp_path: Path,
) -> None:
    """Reject missing spatial metadata without guessing a CRS."""
    geotiff_path = tmp_path / "missing-crs.tif"
    write_geotiff(geotiff_path, crs=None)

    with pytest.raises(ValueError, match="no coordinate reference system"):
        build_geotiff_stac_item(tmp_path, geotiff_path)


def test_geotiff_uses_crs_from_gdal_pam_sidecar(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep targeted sidecar discovery when directory listing is disabled."""
    geotiff_path = tmp_path / "sidecar-crs.tif"
    write_geotiff(geotiff_path, crs=None)
    geotiff_path.with_suffix(".tif.aux.xml").write_text(
        f"<PAMDataset><SRS>{CRS.from_epsg(4326).to_wkt()}</SRS></PAMDataset>",
        encoding="utf-8",
    )
    monkeypatch.setenv("GDAL_DISABLE_READDIR_ON_OPEN", "TRUE")

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["properties"]["proj:epsg"] == 4326
    assert item["bbox"] == pytest.approx([-123, 48.8, -122.7, 49])
    assert item["geometry"]["type"] == "Polygon"


def test_geotiff_transforms_bounds_with_an_invalid_projected_corner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catalog a valid raster whose rectangular extent exceeds its CRS domain."""
    monkeypatch.setattr(
        "eolab_app.catalog.geotiff.calculate_default_transform",
        lambda *args, **kwargs: pytest.fail("Suggested warp fallback was called"),
    )
    geotiff_path = tmp_path / "partial-eckert-iv.tif"
    projected_bounds = (
        -10834025.0233928,
        5015601.46147158,
        -2980025.0233928,
        8432601.46147158,
    )
    width = height = 10
    write_geotiff(
        geotiff_path,
        crs="+proj=eck4 +lon_0=0 +ellps=GRS80 +units=m +no_defs",
        transform=from_bounds(*projected_bounds, width, height),
        width=width,
        height=height,
    )

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["bbox"] == pytest.approx(
        [-178.045549, 40.049153, -35.118271, 86.417527]
    )
    assert item["geometry"] == {
        "type": "Polygon",
        "coordinates": [[
            [item["bbox"][0], item["bbox"][1]],
            [item["bbox"][2], item["bbox"][1]],
            [item["bbox"][2], item["bbox"][3]],
            [item["bbox"][0], item["bbox"][3]],
            [item["bbox"][0], item["bbox"][1]],
        ]],
    }


def test_geotiff_uses_suggested_warp_bounds_for_global_projection(
    tmp_path: Path,
) -> None:
    """Catalog the representative global raster without reading its pixels."""
    geotiff_path = tmp_path / "global-eckert-iv.tif"
    geotiff_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        geotiff_path,
        "w",
        driver="GTiff",
        width=16_923,
        height=8_462,
        count=1,
        dtype="uint8",
        crs="+proj=eck4 +lon_0=0 +datum=WGS84 +units=m +no_defs",
        transform=Affine(
            2_000,
            0,
            -16_921_202.923,
            0,
            -2_000,
            8_461_398.539,
        ),
        compress="DEFLATE",
        tiled=True,
    ):
        pass

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["bbox"] == pytest.approx(
        [-180, -89.987236406, 180, 90]
    )
    assert item["properties"]["description"] == (
        f"{FALLBACK_DATETIME_DESCRIPTION} "
        f"{SUGGESTED_WARP_BOUNDS_DESCRIPTION}"
    )


def test_geotiff_normalizes_global_cog_pixel_edge_bounds(
    tmp_path: Path,
) -> None:
    """Clip the representative global COG's pixel edges to valid WGS 84."""
    geotiff_path = tmp_path / "cog_HMv20240801_2022s_AA_300.tif"
    bounds = (
        -180.000823370733,
        -90.0004116853666,
        180.000823370733,
        90.0004116853666,
    )
    write_geotiff(
        geotiff_path,
        transform=from_bounds(*bounds, 10, 10),
        width=10,
        height=10,
    )

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["bbox"] == [-180, -90, 180, 90]


@pytest.mark.parametrize(
    "suggested_output",
    [
        (Affine.identity(), 0, 10),
        (Affine(float("nan"), 0, 0, 0, 1, 0), 10, 10),
        (from_bounds(-200, -90, -181, 90, 10, 10), 10, 10),
        (from_bounds(10, 0, 0, 10, 10, 10), 10, 10),
    ],
    ids=("empty-grid", "non-finite-transform", "outside-longitude", "reversed"),
)
def test_geotiff_rejects_invalid_suggested_warp_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    suggested_output: tuple[Affine, int, int],
) -> None:
    """Reject malformed suggested grids instead of publishing invalid STAC."""
    geotiff_path = tmp_path / "invalid-suggested-grid.tif"
    write_geotiff(geotiff_path)
    monkeypatch.setattr(
        "eolab_app.catalog.geotiff.transform_bounds_to_wgs84",
        lambda *args, **kwargs: (float("inf"),) * 4,
    )
    monkeypatch.setattr(
        "eolab_app.catalog.geotiff.calculate_default_transform",
        lambda *args, **kwargs: suggested_output,
    )

    with pytest.raises(ValueError, match="could not be transformed"):
        build_geotiff_stac_item(tmp_path, geotiff_path)


def test_geotiff_rejects_fully_untransformable_bounds(tmp_path: Path) -> None:
    """Reject a raster when no finite WGS 84 extent can be produced."""
    geotiff_path = tmp_path / "invalid-eckert-iv-extent.tif"
    width = height = 10
    write_geotiff(
        geotiff_path,
        crs="+proj=eck4 +lon_0=0 +ellps=GRS80 +units=m +no_defs",
        transform=from_bounds(
            30_000_000,
            30_000_000,
            31_000_000,
            31_000_000,
            width,
            height,
        ),
        width=width,
        height=height,
    )

    with pytest.raises(
        rasterio._err.CPLE_AppDefinedError,
        match="unable to compute output bounds",
    ):
        build_geotiff_stac_item(tmp_path, geotiff_path)


def test_geotiff_rejects_ambiguous_acquisition_datetime(tmp_path: Path) -> None:
    """Reject an acquisition value with no UTC offset instead of guessing."""
    geotiff_path = tmp_path / "ambiguous.tif"
    write_geotiff(geotiff_path, "2024-06-15T13:20:04")

    with pytest.raises(ValueError, match="valid RFC 3339 timestamp"):
        build_geotiff_stac_item(tmp_path, geotiff_path)


def test_item_identifier_is_stable_for_relative_path(tmp_path: Path) -> None:
    """Generate the same identifier whenever the mounted path is rescanned."""
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_path = first_root / "models" / "result.tif"
    second_path = second_root / "models" / "result.tif"
    write_geotiff(first_path)
    write_geotiff(second_path)

    first_item = build_geotiff_stac_item(first_root, first_path)
    second_item = build_geotiff_stac_item(second_root, second_path)

    assert first_item["id"] == second_item["id"]


def test_geotiff_title_preserves_relative_filename(tmp_path: Path) -> None:
    """Preserve the literal relative path used by Catalog substring search."""
    geotiff_path = tmp_path / "Model Outputs" / "grassland_2002.tif"
    write_geotiff(geotiff_path)

    item = build_geotiff_stac_item(tmp_path, geotiff_path)

    assert item["properties"]["title"] == "Model Outputs/grassland_2002.tif"
    assert "keywords" not in item["properties"]


def test_shapefile_builds_one_projected_vector_item(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catalog Shapefile components without listing their directory."""
    shapefile_path, component_paths = write_shapefile(
        tmp_path / "nested" / "habitat.shp"
    )
    modified_at = datetime(2025, 4, 3, 12, 30, tzinfo=timezone.utc)
    for component_path in component_paths:
        os.utime(
            component_path,
            (modified_at.timestamp(), modified_at.timestamp()),
        )
    monkeypatch.setenv("GDAL_DISABLE_READDIR_ON_OPEN", "TRUE")

    item = build_shapefile_stac_item(
        tmp_path,
        shapefile_path,
        component_paths,
    )

    assert item["collection"] == "eolab-mounted-vectors"
    assert item["properties"]["title"] == "nested/habitat.shp"
    assert item["properties"]["datetime"] == "2025-04-03T12:30:00Z"
    assert item["properties"]["description"] == SHAPEFILE_DATETIME_DESCRIPTION
    assert item["properties"]["proj:epsg"] == 3857
    assert item["properties"]["proj:bbox"] == pytest.approx([0, 0, 1000, 1000])
    assert item["bbox"] == pytest.approx(
        [0, 0, 0.008983152841, 0.008983152804]
    )
    assert item["properties"]["table:row_count"] == 1
    assert [
        column["name"] for column in item["properties"]["table:columns"]
    ] == ["geometry", "name", "rank"]
    assert item["properties"]["table:primary_geometry"] == "geometry"
    assert {"shp", "shx", "dbf", "prj"} <= item["assets"].keys()
    assert item["assets"]["shp"]["type"] == "application/vnd.shp"
    assert item["assets"]["dbf"]["title"] == "nested/habitat.dbf"
    json.dumps(item)


def test_shapefile_matches_component_extensions_case_insensitively(
    tmp_path: Path,
) -> None:
    """Group uppercase companion extensions under one logical dataset."""
    _, component_paths = write_shapefile(tmp_path / "roads.shp")
    for component_path in component_paths:
        temporary_path = component_path.with_name(f"{component_path.name}.rename")
        component_path.rename(temporary_path)
        temporary_path.rename(
            component_path.with_suffix(component_path.suffix.upper())
        )
    datasets = discover_shapefile_datasets(tmp_path, os.listdir(tmp_path))

    assert len(datasets) == 1
    shapefile_path, uppercase_component_paths = datasets[0]
    item = build_shapefile_stac_item(
        tmp_path,
        shapefile_path,
        uppercase_component_paths,
    )

    assert item["properties"]["title"] == "roads.SHP"
    assert {"shp", "shx", "dbf", "prj"} <= item["assets"].keys()


def test_shapefile_reports_missing_required_component(tmp_path: Path) -> None:
    """Reject one incomplete logical dataset before asking GDAL to open it."""
    write_shapefile(tmp_path / "incomplete.shp")
    (tmp_path / "incomplete.dbf").unlink()
    [(shapefile_path, component_paths)] = discover_shapefile_datasets(
        tmp_path,
        os.listdir(tmp_path),
    )

    with pytest.raises(ValueError, match=r"required components: \.dbf"):
        build_shapefile_stac_item(
            tmp_path,
            shapefile_path,
            component_paths,
        )


def test_shapefile_catalogs_multipart_polygon_layer(tmp_path: Path) -> None:
    """Accept multipart records using the Shapefile layer's Polygon type."""
    polygon = [[
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
        [0, 0],
    ]]
    shapefile_path, component_paths = write_shapefile(
        tmp_path / "multipart.shp",
        geometry={"type": "MultiPolygon", "coordinates": [polygon, polygon]},
    )

    item = build_shapefile_stac_item(
        tmp_path,
        shapefile_path,
        component_paths,
    )

    assert item["properties"]["table:columns"][0] == {
        "name": "geometry",
        "type": "Polygon",
    }
    assert item["properties"]["table:row_count"] == 1


def test_empty_shapefile_has_no_spatial_extent(tmp_path: Path) -> None:
    """Do not invent a zero-area footprint for a dataset with no features."""
    shapefile_path, component_paths = write_shapefile(
        tmp_path / "empty.shp",
        write_feature=False,
    )

    item = build_shapefile_stac_item(
        tmp_path,
        shapefile_path,
        component_paths,
    )

    assert item["properties"]["table:row_count"] == 0
    assert item["geometry"] is None
    assert "bbox" not in item
    assert "proj:bbox" not in item["properties"]


def test_shapefile_serializes_non_epsg_projection_as_wkt2(tmp_path: Path) -> None:
    """Use the Projection extension's WKT2 field for a custom CRS."""
    shapefile_path, component_paths = write_shapefile(
        tmp_path / "custom-projection.shp",
        crs="+proj=eck4 +lon_0=0 +datum=WGS84 +units=m +no_defs",
    )

    item = build_shapefile_stac_item(
        tmp_path,
        shapefile_path,
        component_paths,
    )

    assert "proj:epsg" not in item["properties"]
    assert item["properties"]["proj:wkt2"].startswith("PROJCRS[")


class ConcurrentRecordingCatalogSession(RecordingCatalogSession):
    """Hold writes until the configured concurrency has been observed."""

    def __init__(self, expected_concurrent_writes: int) -> None:
        super().__init__()
        self.expected_concurrent_writes = expected_concurrent_writes
        self.active_writes = 0
        self.maximum_concurrent_writes = 0
        self.all_writers_started = asyncio.Event()

    async def upsert_items(self, items: list[dict[str, Any]]) -> None:
        self.active_writes += 1
        self.maximum_concurrent_writes = max(
            self.maximum_concurrent_writes,
            self.active_writes,
        )
        if self.active_writes == self.expected_concurrent_writes:
            self.all_writers_started.set()
        try:
            await asyncio.wait_for(self.all_writers_started.wait(), 2)
            await super().upsert_items(items)
        finally:
            self.active_writes -= 1


class FailingConcurrentCatalogSession(RecordingCatalogSession):
    """Fail one write after all writer slots are occupied."""

    def __init__(self, expected_concurrent_writes: int) -> None:
        super().__init__()
        self.expected_concurrent_writes = expected_concurrent_writes
        self.active_writes = 0
        self.maximum_concurrent_writes = 0
        self.cancelled_writes = 0
        self.all_writers_started = asyncio.Event()

    async def upsert_items(self, items: list[dict[str, Any]]) -> None:
        write_index = len(self.item_batches)
        self.item_batches.append(items)
        self.active_writes += 1
        self.maximum_concurrent_writes = max(
            self.maximum_concurrent_writes,
            self.active_writes,
        )
        if self.active_writes == self.expected_concurrent_writes:
            self.all_writers_started.set()
        try:
            await asyncio.wait_for(self.all_writers_started.wait(), 2)
            if write_index == 0:
                raise RuntimeError("catalog unavailable")
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.cancelled_writes += 1
                raise
        finally:
            self.active_writes -= 1


def test_scan_status_reports_worker_count_before_start(tmp_path: Path) -> None:
    """Construct the initial status from the configured worker count."""
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        17,
        3,
        100,
    )

    assert scan_manager.status()["workerCount"] == 17
    assert scan_manager.status()["writerCount"] == 3


def test_metadata_executor_uses_spawned_processes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Isolate GDAL workers from app threads and Python interpreters."""
    executor_arguments: dict[str, Any] = {}

    class RecordingProcessPoolExecutor:
        def __init__(self, **arguments: Any) -> None:
            executor_arguments.update(arguments)

    monkeypatch.setattr(
        "eolab_app.catalog.metadata.ProcessPoolExecutor",
        RecordingProcessPoolExecutor,
    )

    executor = create_metadata_executor(8)

    assert isinstance(executor, RecordingProcessPoolExecutor)
    assert executor_arguments["max_workers"] == 8
    assert executor_arguments["mp_context"].get_start_method() == "spawn"


def test_pgstac_database_pages_scanner_assets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Read only scanner Collections through a bounded keyset query."""
    first_cursor = AsyncMock()
    first_cursor.fetchall.return_value = [
        (
            "eolab-mounted-geotiffs",
            "geotiff-1",
            {"data": {"href": "file:///scan-source/one.tif"}},
        )
    ]
    empty_cursor = AsyncMock()
    empty_cursor.fetchall.return_value = []
    connection = AsyncMock()
    connection.__aenter__.return_value = connection
    connection.execute.side_effect = [first_cursor, empty_cursor]
    monkeypatch.setattr(
        psycopg.AsyncConnection,
        "connect",
        AsyncMock(return_value=connection),
    )

    async def read_pages() -> list[list[CatalogItemSource]]:
        return [
            page
            async for page in PgStacCatalogDatabase().scanner_item_pages(
                ("eolab-mounted-geotiffs", "eolab-mounted-vectors"),
                500,
            )
        ]

    pages = asyncio.run(read_pages())

    assert pages == [[
        CatalogItemSource(
            "eolab-mounted-geotiffs",
            "geotiff-1",
            ("file:///scan-source/one.tif",),
        )
    ]]
    assert connection.execute.await_count == 2
    assert "(collection, id) >" in connection.execute.await_args_list[1].args[0]


def test_pgstac_database_deletes_batches_in_one_transaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Use bounded delete statements without committing between batches."""
    first_cursor = SimpleNamespace(rowcount=2)
    second_cursor = SimpleNamespace(rowcount=1)
    connection = AsyncMock()
    connection.__aenter__.return_value = connection
    connection.execute.side_effect = [first_cursor, second_cursor]
    connect = AsyncMock(return_value=connection)
    monkeypatch.setattr(psycopg.AsyncConnection, "connect", connect)

    removed = asyncio.run(PgStacCatalogDatabase().delete_item_batches([
        [("collection-a", "same-id"), ("collection-b", "same-id")],
        [("collection-a", "another-id")],
    ]))

    assert removed == 3
    connect.assert_awaited_once_with()
    assert connection.execute.await_count == 2
    assert connection.execute.await_args_list[0].args[1] == (
        ["collection-a", "collection-b"],
        ["same-id", "same-id"],
    )


def test_spawned_metadata_process_builds_dataset_items(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Load GDAL and exchange raster and vector Items between processes."""
    geotiff_path = tmp_path / "spawned.tif"
    write_geotiff(geotiff_path)
    shapefile_path, component_paths = write_shapefile(tmp_path / "spawned.shp")
    monkeypatch.setenv("GDAL_DISABLE_READDIR_ON_OPEN", "TRUE")

    with create_metadata_executor(1) as executor:
        results = [
            executor.submit(
                build_dataset_metadata,
                tmp_path,
                dataset_candidate,
            ).result(timeout=15)
            for dataset_candidate in (
                DatasetCandidate(geotiff_path, "geotiff"),
                DatasetCandidate(
                    shapefile_path,
                    "shapefile",
                    component_paths,
                ),
            )
        ]

    assert all(result.error is None for result in results)
    assert [result.items[0]["properties"]["title"] for result in results] == [
        "spawned.tif",
        "spawned.shp",
    ]


def test_scan_continues_after_an_invalid_geotiff(tmp_path: Path) -> None:
    """Index valid files, report invalid files, and keep stable upsert results."""
    write_geotiff(tmp_path / "valid.TIF")
    write_geotiff(tmp_path / "missing-crs.tif", crs=None)
    (tmp_path / "invalid.tiff").write_text("not a raster", encoding="utf-8")
    catalog_writer = RecordingCatalogWriter()
    catalog_database = RecordingCatalogDatabase(catalog_writer)
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        catalog_database,
        8,
        2,
        100,
    )

    async def run_twice() -> tuple[dict[str, Any], dict[str, Any]]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        first_status = scan_manager.status()
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return first_status, scan_manager.status()

    first_status, second_status = asyncio.run(run_twice())

    assert first_status["state"] == "completed"
    assert first_status["discovered"] == 3
    assert first_status["processed"] == 3
    assert first_status["indexed"] == 1
    assert first_status["alreadyInCatalog"] == 0
    assert first_status["failed"] == 2
    assert set(first_status["timing"]) == {
        "elapsedSeconds",
        "catalogInventorySeconds",
        "discoverySeconds",
        "metadataResultWaitSeconds",
        "metadataWorkerSeconds",
        "metadataProcessingSeconds",
        "metadataIoWaitSeconds",
        "catalogWriteSeconds",
        "reconciliationSeconds",
        "cacheInvalidationSeconds",
    }
    assert first_status["timing"]["metadataWorkerSeconds"] == pytest.approx(
        first_status["timing"]["metadataProcessingSeconds"]
        + first_status["timing"]["metadataIoWaitSeconds"]
    )
    assert {error["path"] for error in first_status["errors"]} == {
        "invalid.tiff",
        "missing-crs.tif",
    }
    assert second_status["indexed"] == 1
    assert second_status["alreadyInCatalog"] == 1
    assert len(catalog_writer.write_session.collections) == 2
    assert len(catalog_writer.write_session.items) == 1
    assert catalog_database.search_count_cache_invalidations == 2


def test_scan_reports_null_geometry_before_catalog_write(tmp_path: Path) -> None:
    """Treat an empty dataset as one failure instead of rejecting its batch."""
    write_shapefile(tmp_path / "empty.shp", write_feature=False)
    write_geotiff(tmp_path / "valid.tif")
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        2,
        2,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["discovered"] == 2
    assert status["processed"] == 2
    assert status["indexed"] == 1
    assert status["failed"] == 1
    assert status["errors"] == [
        {
            "path": "empty.shp",
            "error": (
                "Dataset has no spatial footprint; pgSTAC requires Item geometry"
            ),
        }
    ]
    assert all(
        item["geometry"] is not None
        for batch in catalog_writer.write_session.item_batches
        for item in batch
    )


def test_scan_combines_multiple_directories_under_one_mount(tmp_path: Path) -> None:
    """Scan configured directories while retaining mount-relative Item paths."""
    observations_path = tmp_path / "observations"
    model_outputs_path = tmp_path / "model_outputs"
    write_geotiff(observations_path / "result.tif")
    write_geotiff(model_outputs_path / "result.tif")
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (observations_path, model_outputs_path),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        8,
        2,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["indexed"] == 2
    assert {
        item["properties"]["title"]
        for item in catalog_writer.write_session.items.values()
    } == {"observations/result.tif", "model_outputs/result.tif"}


def test_scan_catalogs_raster_and_shapefile_datasets_together(
    tmp_path: Path,
) -> None:
    """Share progress while retaining Collection-safe, idempotent batches."""
    write_geotiff(tmp_path / "rasters" / "observation.tif")
    write_shapefile(tmp_path / "vectors" / "habitat.shp")
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        4,
        2,
        100,
    )

    async def run_twice() -> tuple[dict[str, Any], dict[str, Any]]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        first_status = scan_manager.status()
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return first_status, scan_manager.status()

    first_status, second_status = asyncio.run(run_twice())

    assert first_status["state"] == "completed"
    assert first_status["discovered"] == 2
    assert first_status["processed"] == 2
    assert first_status["indexed"] == 2
    assert first_status["alreadyInCatalog"] == 0
    assert second_status["indexed"] == 2
    assert second_status["alreadyInCatalog"] == 2
    assert set(catalog_writer.write_session.collections) == {
        "eolab-mounted-geotiffs",
        "eolab-mounted-vectors",
    }
    assert {
        item["collection"]
        for item in catalog_writer.write_session.items.values()
    } == {"eolab-mounted-geotiffs", "eolab-mounted-vectors"}
    assert all(
        len({item["collection"] for item in item_batch}) == 1
        for item_batch in catalog_writer.write_session.item_batches
    )


def test_scan_removes_missing_raster_without_pruning_unscanned_paths(
    tmp_path: Path,
) -> None:
    """Reconcile stored Assets independently of configured discovery subsets."""
    scanned_path = tmp_path / "scanned"
    unscanned_path = tmp_path / "unscanned"
    stale_path = unscanned_path / "old raster.tif"
    present_path = unscanned_path / "still present.tif"
    write_geotiff(scanned_path / "current.tif")
    write_geotiff(stale_path)
    write_geotiff(present_path)
    stale_item = build_geotiff_stac_item(tmp_path, stale_path)
    present_item = build_geotiff_stac_item(tmp_path, present_path)
    same_id_vector = {
        "collection": "eolab-mounted-vectors",
        "id": stale_item["id"],
        "assets": {
            key: {"href": present_path.resolve().as_uri()}
            for key in ("shp", "shx", "dbf", "prj")
        },
    }
    stale_path.unlink()
    catalog_writer = RecordingCatalogWriter()
    catalog_writer.write_session.items.update({
        (stale_item["collection"], stale_item["id"]): stale_item,
        (present_item["collection"], present_item["id"]): present_item,
        (same_id_vector["collection"], same_id_vector["id"]): same_id_vector,
        ("external-collection", "external-item"): {
            "collection": "external-collection",
            "id": "external-item",
            "assets": present_item["assets"],
        },
    })
    catalog_database = RecordingCatalogDatabase(catalog_writer)
    scan_manager = ScanManager(
        tmp_path,
        (scanned_path,),
        catalog_writer,
        catalog_database,
        2,
        2,
        100,
    )

    async def run_twice() -> tuple[dict[str, Any], dict[str, Any]]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        first_status = scan_manager.status()
        restarted_scan_manager = ScanManager(
            tmp_path,
            (scanned_path,),
            catalog_writer,
            catalog_database,
            2,
            2,
            100,
        )
        await restarted_scan_manager.start()
        while restarted_scan_manager.status()["state"] in {
            "discovering",
            "scanning",
        }:
            await asyncio.sleep(0.01)
        return first_status, restarted_scan_manager.status()

    status, repeated_status = asyncio.run(run_twice())

    assert status["state"] == "completed"
    assert status["reconciliation"] == {
        "state": "completed",
        "checked": 3,
        "missing": 1,
        "removed": 1,
        "error": None,
    }
    assert (stale_item["collection"], stale_item["id"]) not in (
        catalog_writer.write_session.items
    )
    assert (present_item["collection"], present_item["id"]) in (
        catalog_writer.write_session.items
    )
    assert (same_id_vector["collection"], same_id_vector["id"]) in (
        catalog_writer.write_session.items
    )
    assert ("external-collection", "external-item") in (
        catalog_writer.write_session.items
    )
    assert repeated_status["reconciliation"]["missing"] == 0
    assert repeated_status["reconciliation"]["removed"] == 0


@pytest.mark.parametrize("missing_extension", [".shp", ".shx", ".dbf", ".prj"])
def test_scan_removes_shapefile_when_a_required_component_is_missing(
    tmp_path: Path,
    missing_extension: str,
) -> None:
    """Treat every required Shapefile component as source availability."""
    shapefile_path, component_paths = write_shapefile(tmp_path / "habitat.shp")
    item = build_shapefile_stac_item(
        tmp_path,
        shapefile_path,
        component_paths,
    )
    next(
        path
        for path in component_paths
        if path.suffix.lower() == missing_extension
    ).unlink()
    catalog_writer = RecordingCatalogWriter()
    item_key = (item["collection"], item["id"])
    catalog_writer.write_session.items[item_key] = item
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        2,
        2,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["reconciliation"]["removed"] == 1
    assert item_key not in catalog_writer.write_session.items


def test_reconciliation_failure_never_deletes_candidates(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep every Item when any source check reports an access failure."""
    missing_href = (tmp_path / "missing.tif").resolve().as_uri()
    catalog_writer = RecordingCatalogWriter()
    item_key = ("eolab-mounted-geotiffs", "geotiff-missing")
    catalog_writer.write_session.items[item_key] = {
        "collection": item_key[0],
        "id": item_key[1],
        "assets": {"data": {"href": missing_href}},
    }
    catalog_database = RecordingCatalogDatabase(catalog_writer)
    monkeypatch.setattr(
        "eolab_app.catalog.reconciliation.catalog_item_is_missing",
        lambda *_: (_ for _ in ()).throw(PermissionError("NFS unavailable")),
    )
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        catalog_database,
        2,
        2,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["reconciliation"]["state"] == "failed"
    assert status["reconciliation"]["error"] == "NFS unavailable"
    assert status["reconciliation"]["removed"] == 0
    assert catalog_database.deleted_batches == []
    assert item_key in catalog_writer.write_session.items


def test_missing_asset_does_not_hide_a_later_access_error(tmp_path: Path) -> None:
    """Complete every required-Asset check before classifying one Item."""
    directory_asset = tmp_path / "not-a-file"
    directory_asset.mkdir()
    item = CatalogItemSource(
        "eolab-mounted-vectors",
        "shapefile-incomplete",
        (
            (tmp_path / "missing.shp").resolve().as_uri(),
            directory_asset.resolve().as_uri(),
        ),
    )

    with pytest.raises(OSError, match="not a mounted file"):
        catalog_item_is_missing(item, tmp_path)


def test_changed_mount_aborts_reconciliation_before_delete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Require one stable mounted-root identity across the read-only pass."""
    catalog_writer = RecordingCatalogWriter()
    item_key = ("eolab-mounted-geotiffs", "geotiff-missing")
    catalog_writer.write_session.items[item_key] = {
        "collection": item_key[0],
        "id": item_key[1],
        "assets": {
            "data": {"href": (tmp_path / "missing.tif").resolve().as_uri()}
        },
    }
    catalog_database = RecordingCatalogDatabase(catalog_writer)
    signatures = iter([(1, 2), (3, 4)])
    monkeypatch.setattr(
        "eolab_app.catalog.reconciliation.source_signature",
        lambda *_: next(signatures),
    )
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        catalog_database,
        1,
        1,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["reconciliation"]["state"] == "failed"
    assert status["reconciliation"]["missing"] == 1
    assert status["reconciliation"]["removed"] == 0
    assert catalog_database.deleted_batches == []
    assert item_key in catalog_writer.write_session.items


def test_reconciliation_checks_and_deletes_in_bounded_batches(
    tmp_path: Path,
) -> None:
    """Bound catalog pages, NFS checks, and delete statements for large scans."""
    catalog_writer = RecordingCatalogWriter()
    for item_index in range(205):
        item_id = f"geotiff-missing-{item_index:03}-café"
        catalog_writer.write_session.items[
            ("eolab-mounted-geotiffs", item_id)
        ] = {
            "collection": "eolab-mounted-geotiffs",
            "id": item_id,
            "assets": {
                "data": {
                    "href": (
                        tmp_path / f"missing file {item_index:03}.tif"
                    ).resolve().as_uri()
                }
            },
        }
    catalog_database = RecordingCatalogDatabase(catalog_writer)
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        catalog_database,
        2,
        2,
        40,
        reconciler=MissingItemReconciler(
            tmp_path,
            catalog_database,
            40,
            page_size=37,
            concurrency=3,
            spool_memory_bytes=128,
        ),
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["reconciliation"]["checked"] == 205
    assert status["reconciliation"]["missing"] == 205
    assert status["reconciliation"]["removed"] == 205
    assert catalog_database.requested_page_sizes == [37]
    assert list(map(len, catalog_database.deleted_batches)) == [40] * 5 + [5]


def test_reconciliation_overlaps_metadata_extraction(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Start source verification while metadata workers are still active."""
    dataset_path = tmp_path / "current.tif"
    dataset_path.touch()
    metadata_started = Event()
    reconciliation_started = Event()

    def build_item(source_root: Path, path: Path) -> dict[str, Any]:
        metadata_started.set()
        assert reconciliation_started.wait(2)
        return {
            "collection": "eolab-mounted-geotiffs",
            "id": "geotiff-current",
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        }

    def check_item(*_: object) -> bool:
        assert metadata_started.wait(2)
        reconciliation_started.set()
        return False

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", build_item)
    monkeypatch.setattr(
        "eolab_app.catalog.reconciliation.catalog_item_is_missing",
        check_item,
    )
    catalog_writer = RecordingCatalogWriter()
    catalog_writer.write_session.items[
        ("eolab-mounted-geotiffs", "geotiff-existing")
    ] = {
        "collection": "eolab-mounted-geotiffs",
        "id": "geotiff-existing",
        "assets": {"data": {"href": dataset_path.resolve().as_uri()}},
    }
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        1,
        1,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["indexed"] == 1
    assert status["reconciliation"]["checked"] == 1


def test_catalog_delete_failure_rolls_back_reconciliation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Report a destructive-phase failure without claiming an Item removal."""
    catalog_writer = RecordingCatalogWriter()
    item_key = ("eolab-mounted-geotiffs", "geotiff-missing")
    catalog_writer.write_session.items[item_key] = {
        "collection": item_key[0],
        "id": item_key[1],
        "assets": {
            "data": {"href": (tmp_path / "missing.tif").resolve().as_uri()}
        },
    }
    catalog_database = RecordingCatalogDatabase(catalog_writer)

    async def reject_deletes(item_batches) -> int:
        list(item_batches)
        raise RuntimeError("catalog delete failed")

    monkeypatch.setattr(
        catalog_database,
        "delete_item_batches",
        reject_deletes,
    )
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        catalog_database,
        1,
        1,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["reconciliation"]["state"] == "failed"
    assert status["reconciliation"]["missing"] == 1
    assert status["reconciliation"]["removed"] == 0
    assert item_key in catalog_writer.write_session.items


def test_scan_continues_after_an_incomplete_shapefile(tmp_path: Path) -> None:
    """Report one logical vector error while cataloging other datasets."""
    write_geotiff(tmp_path / "valid.tif")
    (tmp_path / "incomplete.shp").touch()
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        2,
        2,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["discovered"] == 2
    assert status["processed"] == 2
    assert status["indexed"] == 1
    assert status["failed"] == 1
    assert status["errors"] == [{
        "path": "incomplete.shp",
        "error": "Shapefile is missing required components: .dbf, .prj, .shx",
    }]


def test_scan_continues_after_an_unreadable_shapefile(tmp_path: Path) -> None:
    """Reject a corrupt attribute table even when geometry remains readable."""
    write_geotiff(tmp_path / "valid.tif")
    write_shapefile(tmp_path / "corrupt.shp")
    (tmp_path / "corrupt.dbf").write_bytes(b"not a dBASE table")
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        2,
        2,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["indexed"] == 1
    assert status["failed"] == 1
    assert status["errors"][0]["path"] == "corrupt.shp"
    assert status["errors"][0]["error"]


def test_scan_continues_after_item_finalization_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Write successful pending Items when one external assessment fails."""
    for filename in ("accepted.tif", "rejected.tif"):
        (tmp_path / filename).touch()

    def build_item(source_root: Path, dataset_path: Path) -> dict[str, Any]:
        return {
            "id": dataset_path.stem,
            "collection": "eolab-mounted-geotiffs",
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        }

    class SelectiveFinalizer:
        async def finalize(self, item: dict[str, Any]) -> dict[str, Any]:
            if item["id"] == "rejected":
                raise RuntimeError("GeoServer rejected this assessment")
            return item

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", build_item)
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        2,
        1,
        100,
        item_finalizer=SelectiveFinalizer(),
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["processed"] == 2
    assert status["indexed"] == 1
    assert status["failed"] == 1
    assert status["errors"] == [{
        "path": "rejected.tif",
        "error": "GeoServer rejected this assessment",
    }]


def test_existing_items_are_classified_by_collection_and_identifier(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not conflate equal Item identifiers from different Collections."""
    (tmp_path / "raster.tif").touch()
    (tmp_path / "vector.shp").touch()

    def build_item(
        source_root: Path,
        dataset_path: Path,
        *component_paths: tuple[Path, ...],
    ) -> dict[str, Any]:
        collection = (
            "eolab-mounted-vectors"
            if dataset_path.suffix.lower() == ".shp"
            else "eolab-mounted-geotiffs"
        )
        return {
            "id": "same-id",
            "collection": collection,
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        }

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", build_item)
    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".shp", build_item)
    catalog_writer = RecordingCatalogWriter()
    catalog_writer.write_session.items[
        ("eolab-mounted-geotiffs", "same-id")
    ] = {"id": "same-id", "collection": "eolab-mounted-geotiffs"}
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        2,
        2,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["indexed"] == 2
    assert status["alreadyInCatalog"] == 1
    assert [
        {item["collection"] for item in item_batch}
        for item_batch in catalog_writer.write_session.item_batches
    ] == [{"eolab-mounted-geotiffs"}, {"eolab-mounted-vectors"}]


def test_scan_reads_metadata_concurrently_and_bulk_upserts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Honor concurrency and keep large raster/vector batches separate."""
    for item_index in range(105):
        (tmp_path / f"item-{item_index:03}.tif").touch()
        (tmp_path / f"item-{item_index:03}.shp").touch()

    active_metadata_calls = 0
    maximum_metadata_calls = 0
    metadata_barrier = Barrier(3)
    metadata_lock = Lock()

    def build_item(
        source_root: Path,
        dataset_path: Path,
        *component_paths: tuple[Path, ...],
    ) -> dict[str, Any]:
        nonlocal active_metadata_calls, maximum_metadata_calls
        with metadata_lock:
            active_metadata_calls += 1
            maximum_metadata_calls = max(
                maximum_metadata_calls,
                active_metadata_calls,
            )
        try:
            metadata_barrier.wait(timeout=5)
            relative_path = dataset_path.relative_to(source_root).as_posix()
            return {
                "id": relative_path,
                "collection": (
                    "eolab-mounted-vectors"
                    if dataset_path.suffix.lower() == ".shp"
                    else "eolab-mounted-geotiffs"
                ),
                "geometry": {"type": "Point", "coordinates": [0, 0]},
            }
        finally:
            with metadata_lock:
                active_metadata_calls -= 1

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", build_item)
    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".shp", build_item)
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        3,
        2,
        40,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert maximum_metadata_calls == 3
    assert sorted(
        (item_batch[0]["collection"], len(item_batch))
        for item_batch in catalog_writer.write_session.item_batches
    ) == [
        ("eolab-mounted-geotiffs", 25),
        ("eolab-mounted-geotiffs", 40),
        ("eolab-mounted-geotiffs", 40),
        ("eolab-mounted-vectors", 25),
        ("eolab-mounted-vectors", 40),
        ("eolab-mounted-vectors", 40),
    ]
    assert status["processed"] == 210
    assert status["indexed"] == 210
    assert status["alreadyInCatalog"] == 0
    assert status["failed"] == 0


def test_scan_runs_the_configured_number_of_catalog_writers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Run four bounded bulk writes concurrently and flush the remainder."""
    for item_index in range(405):
        (tmp_path / f"item-{item_index:03}.tif").touch()

    def build_item(source_root: Path, geotiff_path: Path) -> dict[str, Any]:
        relative_path = geotiff_path.relative_to(source_root).as_posix()
        return {
            "id": relative_path,
            "collection": "eolab-mounted-geotiffs",
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        }

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", build_item)
    catalog_writer = RecordingCatalogWriter()
    concurrent_session = ConcurrentRecordingCatalogSession(4)
    catalog_writer.write_session = concurrent_session
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        8,
        4,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["indexed"] == 405
    assert concurrent_session.maximum_concurrent_writes == 4
    assert sorted(map(len, concurrent_session.item_batches)) == [
        5,
        100,
        100,
        100,
        100,
    ]


def test_scan_cancels_concurrent_writers_after_one_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop the scan and cancel other writes after one writer fails."""
    for item_index in range(400):
        (tmp_path / f"item-{item_index:03}.tif").touch()

    def build_item(source_root: Path, geotiff_path: Path) -> dict[str, Any]:
        relative_path = geotiff_path.relative_to(source_root).as_posix()
        return {
            "id": relative_path,
            "collection": "eolab-mounted-geotiffs",
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        }

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", build_item)
    catalog_writer = RecordingCatalogWriter()
    concurrent_session = FailingConcurrentCatalogSession(4)
    catalog_writer.write_session = concurrent_session
    catalog_database = RecordingCatalogDatabase(catalog_writer)
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        catalog_database,
        8,
        4,
        100,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "failed"
    assert status["indexed"] == 0
    assert concurrent_session.maximum_concurrent_writes == 4
    assert concurrent_session.cancelled_writes == 3
    assert catalog_database.search_count_cache_invalidations == 0


def test_dataset_metadata_timing_separates_cpu_from_wait(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Derive estimated I/O wait from worker elapsed and thread CPU time."""
    dataset_path = tmp_path / "item.tif"
    dataset_path.touch()

    def build_item(source_root: Path, path: Path) -> dict[str, Any]:
        return {
            "id": path.name,
            "collection": "eolab-mounted-geotiffs",
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        }

    elapsed_clock = iter([10.0, 12.5])
    processing_clock = iter([3.0, 3.4])
    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", build_item)
    monkeypatch.setattr(
        "eolab_app.catalog.metadata.perf_counter",
        lambda: next(elapsed_clock),
    )
    monkeypatch.setattr(
        "eolab_app.catalog.metadata.process_time",
        lambda: next(processing_clock),
    )

    result = build_dataset_metadata(
        tmp_path,
        DatasetCandidate(dataset_path, "geotiff"),
        create_test_dataset_handler_registry(),
    )

    assert result.elapsed_seconds == 2.5
    assert result.processing_seconds == pytest.approx(0.4)


def test_scan_caps_error_details_without_losing_failure_count(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep status polling bounded when many files cannot be read."""
    for item_index in range(105):
        (tmp_path / f"invalid-{item_index:03}.tif").touch()

    def reject_item(source_root: Path, geotiff_path: Path) -> dict[str, Any]:
        raise ValueError("invalid raster")

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", reject_item)
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        8,
        2,
        100,
        error_detail_limit=7,
    )

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "completed"
    assert status["processed"] == 105
    assert status["failed"] == 105
    assert len(status["errors"]) == 7
    assert status["errorsTruncated"] is True


def test_scan_stops_after_a_bulk_catalog_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Stop and cancel queued work after a systemic catalog failure."""
    for item_index in range(500):
        (tmp_path / f"item-{item_index:03}.tif").touch()

    def build_item(source_root: Path, geotiff_path: Path) -> dict[str, Any]:
        relative_path = geotiff_path.relative_to(source_root).as_posix()
        return {
            "id": relative_path,
            "collection": "eolab-mounted-geotiffs",
            "geometry": {"type": "Point", "coordinates": [0, 0]},
        }

    monkeypatch.setitem(DATASET_ITEM_BUILDERS, ".tif", build_item)
    catalog_writer = RecordingCatalogWriter(
        RuntimeError("catalog unavailable")
    )
    catalog_database = RecordingCatalogDatabase(catalog_writer)
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        catalog_database,
        8,
        1,
        100,
    )
    caplog.set_level(logging.ERROR, logger="eolab_app.catalog.scanner")

    async def run_scan() -> dict[str, Any]:
        await scan_manager.start()
        while scan_manager.status()["state"] in {"discovering", "scanning"}:
            await asyncio.sleep(0.01)
        return scan_manager.status()

    status = asyncio.run(run_scan())

    assert status["state"] == "failed"
    assert status["processed"] == 100
    assert status["indexed"] == 0
    assert status["failed"] == 0
    assert status["reconciliation"]["state"] == "completed"
    assert len(catalog_writer.write_session.item_batches) == 1
    assert status["errors"][-1] == {
        "path": None,
        "error": "Scan stopped: catalog unavailable",
    }
    assert "Catalog scan stopped unexpectedly" in caplog.text
    assert "RuntimeError: catalog unavailable" in caplog.text
    assert catalog_database.search_count_cache_invalidations == 0


def test_scan_prevents_overlap(tmp_path: Path) -> None:
    """Reject a second start while directory discovery is still running."""
    catalog_writer = RecordingCatalogWriter()
    scan_manager = ScanManager(
        tmp_path,
        (tmp_path,),
        catalog_writer,
        RecordingCatalogDatabase(catalog_writer),
        8,
        2,
        100,
    )

    async def start_twice() -> None:
        await scan_manager.start()
        with pytest.raises(RuntimeError, match="already running"):
            await scan_manager.start()

    asyncio.run(start_twice())


def test_catalog_writer_uses_standard_bulk_upserts() -> None:
    """Upsert a batch without per-Item existence requests."""
    requests: list[tuple[str, str, object | None]] = []

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        request_body = json.loads(request.content) if request.content else None
        requests.append((request.method, request.url.path, request_body))
        if request.method == "GET" and request.url.path.endswith(
            "/eolab-mounted-geotiffs"
        ):
            return httpx2.Response(404)
        return httpx2.Response(200, json="written")

    writer = StacApiWriter(
        "http://stac-api:8080",
        httpx2.MockTransport(catalog_response),
    )

    async def write_records() -> None:
        async with writer.session() as session:
            await session.upsert_collection(
                {"id": "eolab-mounted-geotiffs"}
            )
            await session.upsert_items(
                [{
                    "id": "geotiff-123",
                    "collection": "eolab-mounted-geotiffs",
                }]
            )

    asyncio.run(write_records())

    assert requests == [
        (
            "GET",
            "/collections/eolab-mounted-geotiffs",
            None,
        ),
        (
            "POST",
            "/collections",
            {"id": "eolab-mounted-geotiffs"},
        ),
        (
            "POST",
            "/collections/eolab-mounted-geotiffs/bulk_items",
            {
                "method": "upsert",
                "items": {
                    "geotiff-123": {
                        "id": "geotiff-123",
                        "collection": "eolab-mounted-geotiffs",
                    }
                },
            },
        ),
    ]
