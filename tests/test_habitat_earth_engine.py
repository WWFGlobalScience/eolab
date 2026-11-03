"""Fetch and reuse Habitat tiles with the official offline Earth Engine client."""

from collections.abc import Callable, Iterator
from dataclasses import replace
from functools import partial
from importlib.resources import files
import io
import json
import multiprocessing
from multiprocessing.synchronize import Barrier, Event
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import ee
from google.auth.exceptions import GoogleAuthError
from googleapiclient.http import HttpMockSequence
from httplib2 import Response
from nhi_terrestrial_integrity_modeling.analysis_config import RasterStackConfiguration
import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from shapely.geometry import MultiPolygon, box

from eolab_app.processing.habitat_earth_engine import (
    HabitatCacheCoverage,
    HabitatEarthEngineSettings,
    get_habitat_tiles,
    inspect_habitat_cache,
    load_habitat_stack,
)
from eolab_app.processing import habitat_earth_engine
from eolab_app.raster.read_cancellation import RasterReadCancelled
from eolab_app.settings import load_processing_worker_settings


def test_worker_loads_optional_habitat_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Load private Habitat settings without reading credentials or creating a cache.

    Args:
        tmp_path: Separate source, result and not-yet-mounted credential paths.
        monkeypatch: Isolate the worker environment from developer settings.
    """
    monkeypatch.setenv("CATALOG_INTERNAL_URL", "http://catalog")
    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path / "sources"))
    monkeypatch.setenv("PROCESSING_DATA_PATH", str(tmp_path / "processing"))
    monkeypatch.setenv("VECTOR_UPLOAD_DATA_PATH", str(tmp_path / "uploads"))
    monkeypatch.delenv("HABITAT_EARTH_ENGINE_PROJECT", raising=False)
    monkeypatch.delenv("HABITAT_EARTH_ENGINE_CREDENTIALS_FILE", raising=False)
    assert load_processing_worker_settings().habitat_earth_engine is None
    monkeypatch.setenv("HABITAT_EARTH_ENGINE_PROJECT", "habitat-project")
    with pytest.raises(ValueError, match="CREDENTIALS_FILE"):
        load_processing_worker_settings()
    credentials = tmp_path / "secrets" / "habitat.json"
    monkeypatch.setenv("HABITAT_EARTH_ENGINE_CREDENTIALS_FILE", str(credentials))
    runtime = load_processing_worker_settings().habitat_earth_engine
    assert runtime.connection == HabitatEarthEngineSettings(
        "habitat-project", credentials
    )
    assert runtime.cache_directory == tmp_path / "processing" / "habitat-cache"
    assert not runtime.cache_directory.exists()


def _load_test_stack(year: int) -> RasterStackConfiguration:
    """Use original reference, response and predictor bands on a tiny fixed grid.

    Args:
        year: Source year loaded through the scientific configuration producer.

    Returns:
        Packaged scientific settings with three bands and two-pixel test tiles.
    """
    original = load_habitat_stack(year)
    return replace(
        original,
        bands=tuple(
            next(band for band in original.bands if band.role == role)
            for role in ("reference", "response", "predictor")
        ),
        grid=replace(
            original.grid,
            pixel_size_meters=10,
            tile_size_pixels=2,
            origin_x=7,
            origin_y=11,
        ),
    )


@pytest.fixture
def stack() -> RasterStackConfiguration:
    """Return the 2019 scientific configuration on the small test grid.

    Returns:
        Original reference, predictor and response definitions on two-pixel tiles.
    """
    return _load_test_stack(2019)


@pytest.fixture
def working_directory(tmp_path: Path) -> Path:
    """Create an attempt directory beside the persistent cache.

    Args:
        tmp_path: Parent directory shared by the test's cache and attempt.

    Returns:
        Empty attempt directory on the same filesystem as the cache.
    """
    directory = tmp_path / "attempt"
    directory.mkdir()
    return directory


def _use_offline_earth_engine(
    monkeypatch: pytest.MonkeyPatch,
    responses: list[tuple[dict[str, str], bytes | str]],
    *,
    before_pixel_response: Callable[[], None] | None = None,
) -> Mock:
    """Feed discovery metadata and pixel responses to the official HTTP client.

    Args:
        monkeypatch: Restore client initialization and credential loading afterward.
        responses: HTTP status headers and bodies for pixel requests.
        before_pixel_response: Coordinate concurrent downloads before returning pixels.

    Returns:
        Spy recording HTTP requests handled by the in-memory transport.
    """
    metadata = files(ee).joinpath("tests")
    discovery = metadata.joinpath("cloud_api_discovery_document.json").read_text(
        encoding="utf-8"
    )
    algorithms = metadata.joinpath("algorithms.json").read_text(encoding="utf-8")
    transport = HttpMockSequence(
        [
            ({"status": "200"}, discovery),
            ({"status": "200"}, discovery),
            ({"status": "200"}, algorithms),
            *responses,
        ]
    )
    send_request = transport.request

    def request(uri: str, *args: Any, **kwargs: Any) -> tuple[Response, bytes | str]:
        """Return the controlled HTTP response, coordinating concurrent downloads.

        Args:
            uri: Official Earth Engine API request URL.
            args: Positional arguments passed through to the test transport.
            kwargs: Keyword arguments passed through to the test transport.

        Returns:
            HTTP response metadata and body from the in-memory transport.
        """
        response = send_request(uri, *args, **kwargs)
        if before_pixel_response is not None and "image:computePixels" in uri:
            before_pixel_response()
        return response

    requests = Mock(wraps=request)
    transport.request = requests
    ee.Reset()
    monkeypatch.setattr(ee, "ServiceAccountCredentials", Mock(return_value=None))
    monkeypatch.setattr(
        ee, "Initialize", partial(ee.Initialize, http_transport=transport)
    )
    monkeypatch.setattr(
        "urllib.request.urlopen", lambda *args, **kwargs: io.BytesIO(b"{}")
    )
    return requests


@pytest.fixture(autouse=True)
def reset_earth_engine() -> Iterator[None]:
    """Keep the process-global Earth Engine client isolated between tests.

    Yields:
        No value; reset the client after each test.
    """
    yield
    ee.Reset()


def _tile_bytes(left: float, top: float, *, last_value: float = 3) -> bytes:
    """Create two float bands with valid zeros and different missing pixels.

    Args:
        left: Tile's western grid coordinate.
        top: Tile's northern grid coordinate.
        last_value: Last valid pixel of the first band, distinguishing concurrent writers.

    Returns:
        Complete GeoTIFF bytes in the original acquisition projection.
    """
    with MemoryFile() as memory:
        with memory.open(
            driver="GTiff",
            width=2,
            height=2,
            count=2,
            dtype="float32",
            crs="EPSG:6933",
            transform=from_origin(left, top, 10, 10),
            nodata=-9999,
        ) as dataset:
            dataset.write(
                np.array(
                    [[[0, -9999], [2, last_value]], [[4, 0], [-9999, 7]]],
                    dtype="float32",
                )
            )
        return memory.read()


def test_inspect_missing_cache_counts_only_tiles_intersecting_the_aoi(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stack: RasterStackConfiguration,
) -> None:
    """Inspect disconnected polygons without fetching or creating a cache.

    Args:
        tmp_path: Parent of a persistent cache that does not exist yet.
        monkeypatch: Reject Earth Engine connections, requests and raster reads.
        stack: Scientific configuration on the small acquisition grid.
    """
    for owner, name in (
        (ee, "ServiceAccountCredentials"),
        (ee, "Initialize"),
        (ee.data, "computePixels"),
        (rasterio, "open"),
    ):
        monkeypatch.setattr(owner, name, Mock(side_effect=AssertionError("inspection")))
    cache = tmp_path / "cache"
    area = MultiPolygon([box(7, 31, 27, 51), box(27, 11, 47, 31)])

    coverage = inspect_habitat_cache(area, stack, cache)

    assert coverage == HabitatCacheCoverage(
        configuration_sha256=stack.raster_configuration_sha256,
        year=2019,
        required_tiles=2,
        cached_tiles=0,
        missing_tiles=2,
    )
    assert not cache.exists()


def test_inspect_cache_matches_acquisition_coverage_and_stack_identity(
    tmp_path: Path,
    working_directory: Path,
    monkeypatch: pytest.MonkeyPatch,
    stack: RasterStackConfiguration,
) -> None:
    """Count acquired overlapping tiles while separating years and stack definitions.

    Args:
        tmp_path: Parent of the persistent cache.
        working_directory: Existing private acquisition attempt directory.
        monkeypatch: Download through the offline transport, then reject pixel reads.
        stack: Scientific configuration on the small acquisition grid.
    """
    cache = tmp_path / "cache"
    cached_area = box(7, 31, 47, 51)
    _use_offline_earth_engine(
        monkeypatch,
        [
            ({"status": "200"}, _tile_bytes(7, 51)),
            ({"status": "200"}, _tile_bytes(27, 51)),
        ],
    )
    get_habitat_tiles(
        cached_area,
        stack,
        HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json"),
        cache_directory=cache,
        working_directory=working_directory,
        progress=Mock(),
        check_cancelled=Mock(),
    )
    for owner, name in (
        (ee, "ServiceAccountCredentials"),
        (ee, "Initialize"),
        (ee.data, "computePixels"),
        (rasterio, "open"),
    ):
        monkeypatch.setattr(owner, name, Mock(side_effect=AssertionError("inspection")))
    area = MultiPolygon([box(7, 31, 27, 51), box(27, 11, 47, 31)])

    assert inspect_habitat_cache(area, stack, cache) == HabitatCacheCoverage(
        configuration_sha256=stack.raster_configuration_sha256,
        year=2019,
        required_tiles=2,
        cached_tiles=1,
        missing_tiles=1,
    )
    assert inspect_habitat_cache(cached_area, stack, cache) == HabitatCacheCoverage(
        configuration_sha256=stack.raster_configuration_sha256,
        year=2019,
        required_tiles=2,
        cached_tiles=2,
        missing_tiles=0,
    )
    for other_stack in (
        _load_test_stack(2018),
        replace(stack, bands=tuple(reversed(stack.bands))),
    ):
        assert inspect_habitat_cache(area, other_stack, cache) == HabitatCacheCoverage(
            configuration_sha256=other_stack.raster_configuration_sha256,
            year=other_stack.year,
            required_tiles=2,
            cached_tiles=0,
            missing_tiles=2,
        )


def test_download_preserves_pixels_and_reuses_completed_tiles(
    tmp_path: Path,
    working_directory: Path,
    monkeypatch: pytest.MonkeyPatch,
    stack: RasterStackConfiguration,
) -> None:
    """Publish complete original tiles and reuse them without credentials or reads.

    Args:
        tmp_path: Persistent cache parent directory.
        working_directory: Existing private attempt directory.
        monkeypatch: Install the offline Earth Engine transport.
        stack: Original scientific definitions with a small acquisition grid.
    """
    requests = _use_offline_earth_engine(
        monkeypatch,
        [
            (dict(status="200"), _tile_bytes(7, 51)),
            (dict(status="200"), _tile_bytes(27, 31)),
        ],
    )
    progress = Mock()
    settings = HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json")
    area = MultiPolygon([box(7, 31, 27, 51), box(27, 11, 47, 31)])
    cache = tmp_path / "cache"
    result = get_habitat_tiles(
        area,
        stack,
        settings,
        cache_directory=cache,
        working_directory=working_directory,
        progress=progress,
        check_cancelled=Mock(),
    )
    names = stack.band_names()[1:]
    assert len(result.tiles) == 2
    assert [path.parent.name for path in result.tiles] == ["0_-2", "1_-1"]
    assert tuple(result.bands) == names
    assert tuple(result.bands.values()) == stack.bands[1:]
    assert [call.args for call in progress.call_args_list] == [(0, 2), (1, 2), (2, 2)]
    ee.ServiceAccountCredentials.assert_called_once_with(
        key_file=str(settings.credentials_file)
    )
    pixel_requests = [
        call
        for call in requests.call_args_list
        if "image:computePixels" in call.args[0]
    ]
    assert len(pixel_requests) == 2
    for path, call, (left, top) in zip(
        result.tiles, pixel_requests, [(7, 51), (27, 31)], strict=True
    ):
        assert path.parent.parent == cache / stack.raster_configuration_sha256
        assert "/projects/habitat-test/image:computePixels" in call.args[0]
        request = json.loads(call.kwargs["body"])
        assert request["fileFormat"] == "GEO_TIFF"
        assert request["bandIds"] == list(names)
        assert request["grid"]["dimensions"] == {"width": 2, "height": 2}
        assert request["grid"]["affineTransform"] == {
            "scaleX": 10,
            "shearX": 0,
            "translateX": left,
            "shearY": 0,
            "scaleY": -10,
            "translateY": top,
        }
        assert CRS.from_wkt(request["grid"]["crsWkt"]) == CRS.from_epsg(6933)
        with rasterio.open(path) as dataset:
            assert dataset.descriptions == names
            assert dataset.transform == from_origin(left, top, 10, 10)
            assert dataset.crs == CRS.from_epsg(6933)
            assert dataset.dtypes == ("float32", "float32")
            pixels = dataset.read(masked=True)
            np.testing.assert_array_equal(
                pixels.mask,
                [[[False, True], [False, False]], [[False, False], [True, False]]],
            )
            assert pixels[0, 0, 0] == pixels[1, 0, 1] == 0
            assert pixels[0, 1, 1] == 3
            assert pixels[1, 1, 1] == 7

    ee.Reset()
    with monkeypatch.context() as warm:
        for owner, name in (
            (ee, "ServiceAccountCredentials"),
            (ee, "Initialize"),
            (habitat_earth_engine, "build_earth_engine_stack"),
            (rasterio, "open"),
        ):
            warm.setattr(owner, name, Mock(side_effect=AssertionError("cache hit")))
        progress.reset_mock()
        repeated = get_habitat_tiles(
            area,
            stack,
            HabitatEarthEngineSettings(
                "another-project", tmp_path / "missing-key.json"
            ),
            cache_directory=cache,
            working_directory=working_directory,
            progress=progress,
            check_cancelled=Mock(),
        )
    assert repeated == result
    assert [call.args for call in progress.call_args_list] == [(0, 2), (1, 2), (2, 2)]
    assert list(working_directory.iterdir()) == []


def test_overlap_fetches_only_missing_tiles_and_years_have_separate_entries(
    tmp_path: Path,
    working_directory: Path,
    monkeypatch: pytest.MonkeyPatch,
    stack: RasterStackConfiguration,
) -> None:
    """Reuse an overlapping tile while keeping another source year's pixels separate.

    Args:
        tmp_path: Private cache and working directory parent.
        working_directory: Existing private attempt directory.
        monkeypatch: Install the official client's offline transport.
        stack: Original scientific definitions with a small acquisition grid.
    """
    cache = tmp_path / "cache"
    settings = HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json")
    with monkeypatch.context() as first:
        _use_offline_earth_engine(first, [({"status": "200"}, _tile_bytes(27, 31))])
        initial = get_habitat_tiles(
            box(27, 11, 47, 31),
            stack,
            settings,
            cache_directory=cache,
            working_directory=working_directory,
            progress=Mock(),
            check_cancelled=Mock(),
        )
    with monkeypatch.context() as overlap:
        requests = _use_offline_earth_engine(
            overlap, [({"status": "200"}, _tile_bytes(7, 31))]
        )
        expanded = get_habitat_tiles(
            box(7, 11, 47, 31),
            stack,
            settings,
            cache_directory=cache,
            working_directory=working_directory,
            progress=Mock(),
            check_cancelled=Mock(),
        )
    assert expanded.tiles[1] == initial.tiles[0]
    assert (
        sum("image:computePixels" in call.args[0] for call in requests.call_args_list)
        == 1
    )
    with monkeypatch.context() as another_year:
        _use_offline_earth_engine(
            another_year, [({"status": "200"}, _tile_bytes(27, 31))]
        )
        earlier = get_habitat_tiles(
            box(27, 11, 47, 31),
            _load_test_stack(2018),
            settings,
            cache_directory=cache,
            working_directory=working_directory,
            progress=Mock(),
            check_cancelled=Mock(),
        )
    assert earlier.tiles[0] != initial.tiles[0]
    assert len(list(cache.rglob("tile.tif"))) == 3
    assert list(working_directory.iterdir()) == []


@pytest.mark.parametrize("invalid_raster", ["wrong-grid", "truncated-pixels"])
def test_invalid_download_removes_its_private_directory(
    tmp_path: Path,
    working_directory: Path,
    monkeypatch: pytest.MonkeyPatch,
    stack: RasterStackConfiguration,
    invalid_raster: str,
) -> None:
    """Reject invalid external raster data without retaining a partial download.

    Args:
        tmp_path: Persistent cache parent directory.
        working_directory: Caller directory containing an unrelated file.
        monkeypatch: Install the offline Earth Engine transport.
        stack: Scientific settings used to request one tile.
        invalid_raster: Return an incorrect grid or incomplete pixel data.
    """
    retained = working_directory / "keep.txt"
    retained.write_text("caller-owned", encoding="utf-8")
    payload = (
        _tile_bytes(8, 31)
        if invalid_raster == "wrong-grid"
        else _tile_bytes(7, 31)[:-16]
    )
    _use_offline_earth_engine(monkeypatch, [({"status": "200"}, payload)])
    progress = Mock()
    expected = (
        ValueError if invalid_raster == "wrong-grid" else rasterio.errors.RasterioError
    )
    with pytest.raises(expected):
        get_habitat_tiles(
            box(7, 11, 27, 31),
            stack,
            HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json"),
            cache_directory=tmp_path / "cache",
            working_directory=working_directory,
            progress=progress,
            check_cancelled=Mock(),
        )
    assert retained.read_text(encoding="utf-8") == "caller-owned"
    assert not list((tmp_path / "cache").rglob("tile.tif"))
    assert list(working_directory.iterdir()) == [retained]
    assert [call.args for call in progress.call_args_list] == [(0, 1)]


@pytest.mark.parametrize("cancel", [False, True])
def test_failure_or_cancellation_preserves_completed_tiles(
    tmp_path: Path,
    working_directory: Path,
    monkeypatch: pytest.MonkeyPatch,
    stack: RasterStackConfiguration,
    cancel: bool,
) -> None:
    """Keep completed tiles when another download fails or is cancelled.

    Args:
        tmp_path: Persistent cache parent directory.
        working_directory: Existing private attempt directory.
        monkeypatch: Install the offline Earth Engine transport.
        stack: Scientific settings used to request two tiles.
        cancel: Cancel before publishing the second tile instead of a remote error.
    """
    _use_offline_earth_engine(
        monkeypatch,
        [
            ({"status": "200"}, _tile_bytes(7, 31)),
            (
                ({"status": "200"}, _tile_bytes(27, 31))
                if cancel
                else (
                    {"status": "403"},
                    '{"error":{"code":403,"message":"private-server-detail"}}',
                )
            ),
        ],
    )
    updates: list[tuple[int, int]] = []

    def check_cancelled() -> None:
        """Cancel with one published tile and another in private staging."""
        if (
            cancel
            and updates
            and updates[-1][0] == 1
            and any(working_directory.glob("*/tile.tif"))
        ):
            raise RasterReadCancelled()

    with pytest.raises(RasterReadCancelled if cancel else RuntimeError) as error:
        get_habitat_tiles(
            box(7, 11, 47, 31),
            stack,
            HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json"),
            cache_directory=tmp_path / "cache",
            working_directory=working_directory,
            progress=lambda done, total: updates.append((done, total)),
            check_cancelled=check_cancelled,
        )
    cached = list((tmp_path / "cache").rglob("tile.tif"))
    assert len(cached) == 1
    with rasterio.open(cached[0]) as dataset:
        assert dataset.transform == from_origin(7, 31, 10, 10)
        assert dataset.read(1)[1, 1] == 3
    assert list(working_directory.iterdir()) == []
    assert updates == [(0, 2), (1, 2)]
    assert "private-server-detail" not in str(error.value)


def test_authentication_errors_do_not_expose_credentials(
    tmp_path: Path,
    working_directory: Path,
    monkeypatch: pytest.MonkeyPatch,
    stack: RasterStackConfiguration,
) -> None:
    """Report authentication failures without exposing service-account key contents.

    Args:
        tmp_path: Private attempt and credential locations.
        working_directory: Existing private attempt directory.
        monkeypatch: Supply a rejected credential load.
        stack: Scientific settings used by the download request.
    """
    settings = HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json")
    monkeypatch.setattr(
        ee,
        "ServiceAccountCredentials",
        Mock(side_effect=GoogleAuthError("private-key-content")),
    )
    with pytest.raises(RuntimeError, match="mounted service-account") as error:
        get_habitat_tiles(
            box(7, 11, 27, 31),
            stack,
            settings,
            cache_directory=tmp_path / "cache",
            working_directory=working_directory,
            progress=Mock(),
            check_cancelled=Mock(),
        )
    assert "private-key-content" not in str(error.value)
    assert error.value.__suppress_context__
    assert not list((tmp_path / "cache").rglob("tile.tif"))
    assert list(working_directory.iterdir()) == []


def _fetch_tile_in_process(
    cache: Path, working: Path, barrier: Barrier, published: Event, first: bool
) -> None:
    """Run one cold cache request with a separate official Earth Engine client.

    Args:
        cache: Shared persistent cache directory.
        working: This process's private staging directory.
        barrier: Wait for both processes to request the same missing tile.
        published: Signal when the first process publishes its complete tile.
        first: Publish this process's response before releasing the other download.
    """

    def release_pixels() -> None:
        """Wait for both requests, then hold the second response until publication."""
        barrier.wait(timeout=20)
        if not first and not published.wait(timeout=20):
            raise TimeoutError("The first process did not publish its tile.")

    working.mkdir()
    with pytest.MonkeyPatch.context() as monkeypatch:
        requests = _use_offline_earth_engine(
            monkeypatch,
            [({"status": "200"}, _tile_bytes(7, 31, last_value=3 if first else 9))],
            before_pixel_response=release_pixels,
        )
        result = get_habitat_tiles(
            box(7, 11, 27, 31),
            _load_test_stack(2019),
            HabitatEarthEngineSettings("habitat-test", working / "key.json"),
            cache_directory=cache,
            working_directory=working,
            progress=lambda done, total: (
                published.set() if first and done == 1 else None
            ),
            check_cancelled=Mock(),
        )
        assert (
            sum(
                "image:computePixels" in call.args[0]
                for call in requests.call_args_list
            )
            == 1
        )
        assert len(result.tiles) == 1
        with rasterio.open(result.tiles[0]) as dataset:
            assert dataset.read(1)[1, 1] == 3
        assert list(working.iterdir()) == []
    ee.Reset()


def test_concurrent_downloads_publish_one_complete_entry(tmp_path: Path) -> None:
    """Let two independent acquisition processes finish the same missing tile.

    Args:
        tmp_path: Parent of the shared cache and separate process working directories.
    """
    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(2)
    published = context.Event()
    cache = tmp_path / "cache"
    processes = [
        context.Process(
            target=_fetch_tile_in_process,
            args=(cache, tmp_path / f"attempt-{index}", barrier, published, index == 0),
        )
        for index in range(2)
    ]
    try:
        for process in processes:
            process.start()
        for process in processes:
            process.join(timeout=30)
        assert [process.exitcode for process in processes] == [0, 0]
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)
    cached = list(cache.rglob("tile.tif"))
    assert len(cached) == 1
    with rasterio.open(cached[0]) as dataset:
        assert dataset.read(1)[1, 1] == 3
