"""Test rendering-independent raster statistics and service contracts."""

import asyncio
from pathlib import Path

import numpy
import pytest
import rasterio
from pydantic import ValidationError
from rasterio.enums import MaskFlags, Resampling
from rasterio.features import geometry_mask
from rasterio.transform import Affine, from_bounds, from_origin
from rasterio.warp import transform as transform_coordinates, transform_bounds
from rasterio.windows import Window

from eolab_app.raster.errors import RasterConflictError, RasterStatisticsCapacityError
from eolab_app.raster import paired_statistics
from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogPixelRequest,
    CatalogRasterPairRequest,
    CatalogRasterRequest,
    CatalogRasterStatisticsRequest,
    RasterHistogram,
    RasterPercentiles,
    RasterPixel,
    RasterStatistics,
    RasterValueRange,
    Wgs84Bounds,
)
from eolab_app.raster.paired_statistics import read_raster_paired_statistics
from eolab_app.raster.pixel import read_raster_pixel
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.statistics import (
    NoRasterBoundsOverlapError,
    NoValidRasterSamplesError,
    read_raster_statistics,
    selected_raster_area_for_wgs84_bounds,
    strict_raster_value_range,
)
from eolab_app.raster.statistics_service import RasterStatisticsService
from catalog_selection_support import write_selection
from eolab_app.catalog_selection import CatalogSelection, SelectionUnavailableError
from eolab_app.sampling_area import (
    RasterSamplingArea,
    SelectedBoundsSamplingArea,
    CatalogSelectionSamplingArea,
    WholeRasterSamplingArea,
)

ITEM_ID = "geotiff-0123456789abcdef01234567"


class _SourceAuthorizer:
    """Authorize replaceable catalog sources without rendering state."""

    def __init__(
        self,
        authorizations: dict[str, AuthorizedRaster] | None = None,
    ) -> None:
        """Create an authorizer for controlled Item identities.

        Args:
            authorizations: Optional Item-to-source authorization mapping.
        """
        self.authorizations = authorizations or {
            ITEM_ID: AuthorizedRaster(Path("raster.tif"), (1, 2, 3, 4, 5))
        }
        self.authorization_count = 0

    async def authorize(
        self,
        request: CatalogRasterRequest,
    ) -> AuthorizedRaster:
        """Return the current source for one catalog Item.

        Args:
            request: Validated catalog raster request.

        Returns:
            Current controlled source authorization.
        """
        self.authorization_count += 1
        return self.authorizations[request.item_id]


class _RasterSample:
    """Minimal masked-array contract returned by a fake pixel dataset."""

    def count(self) -> int:
        """Return one valid sampled pixel.

        Returns:
            One valid value.
        """
        return 1

    def __getitem__(self, _: tuple[int, int]) -> float:
        """Return the controlled pixel value.

        Args:
            _: Ignored two-dimensional sample index.

        Returns:
            Controlled finite value.
        """
        return 42.5


class _PixelDataset:
    """Record the exact band and window requested by the pixel reader."""

    crs = "EPSG:3857"
    width = 10
    height = 10

    def __init__(self) -> None:
        """Create an unread controlled pixel source."""
        self.read_arguments: tuple[int, Window, bool] | None = None

    def __enter__(self) -> "_PixelDataset":
        """Enter the fake Rasterio context.

        Returns:
            This dataset.
        """
        return self

    def __exit__(self, *_: object) -> None:
        """Exit the fake Rasterio context.

        Args:
            *_: Ignored exception context.
        """
        return None

    def index(self, x: float, y: float) -> tuple[int, int]:
        """Map the controlled projected position to one pixel.

        Args:
            x: Projected x coordinate.
            y: Projected y coordinate.

        Returns:
            Controlled row and column.
        """
        assert (x, y) == (10, 20)
        return 2, 3

    def read(self, band: int, *, window: Window, masked: bool) -> _RasterSample:
        """Record the bounded pixel read.

        Args:
            band: One-based raster band.
            window: Requested source-pixel window.
            masked: Whether Rasterio validity masking was requested.

        Returns:
            Controlled one-value sample.
        """
        self.read_arguments = (band, window, masked)
        return _RasterSample()


class _NativeStatisticsDataset:
    """Provide native blocks for statistics and reject resampled reads."""

    count = 1

    def __init__(
        self,
        values: numpy.ndarray,
        source_path: Path,
        *,
        transform: Affine | None = None,
        crs: str | None = "EPSG:4326",
        block_shape: tuple[int, int] | None = None,
        nodata: float | None = None,
        extra_files: tuple[Path, ...] = (),
    ) -> None:
        """Create a controlled signed one-band source.

        Args:
            values: Two-dimensional band-one values.
            source_path: Authorized path represented by this dataset.
            transform: Optional source affine transform.
            crs: Optional source CRS.
            block_shape: Optional native block height and width.
            nodata: Optional signed band nodata value.
            extra_files: Additional GDAL dependencies used for rejection tests.
        """
        self.values = values
        self.height, self.width = values.shape
        self.transform = transform or from_origin(0, self.height, 1, 1)
        self.crs = crs
        self.block_shapes = (block_shape or values.shape,)
        self.dtypes = (values.dtype.name,)
        self.nodatavals = (nodata,)
        self.mask_flag_enums = (
            [MaskFlags.nodata] if nodata is not None else [MaskFlags.all_valid],
        )
        self.files = (
            str(source_path.resolve()),
            *(str(path.resolve()) for path in extra_files),
        )
        self.read_windows: list[Window] = []

    def __enter__(self) -> "_NativeStatisticsDataset":
        """Enter the fake Rasterio context.

        Returns:
            This dataset.
        """
        return self

    def __exit__(self, *_: object) -> None:
        """Exit the fake Rasterio context.

        Args:
            *_: Ignored exception context.
        """
        return None

    def block_window(
        self,
        band: int,
        block_row: int,
        block_column: int,
    ) -> Window:
        """Return one clipped native-block window.

        Args:
            band: One-based raster band.
            block_row: Zero-based native block row.
            block_column: Zero-based native block column.

        Returns:
            Integral native-block window.
        """
        assert band == 1
        block_height, block_width = self.block_shapes[0]
        row_offset = block_row * block_height
        column_offset = block_column * block_width
        return Window(
            column_offset,
            row_offset,
            min(block_width, self.width - column_offset),
            min(block_height, self.height - row_offset),
        )

    def read(
        self,
        band: int,
        *,
        window: Window,
        masked: bool,
    ) -> numpy.ndarray:
        """Read one exact native block with no ``out_shape`` escape hatch.

        Args:
            band: One-based raster band.
            window: Exact native block window.
            masked: Rasterio mask request, which must remain false.

        Returns:
            Copy of the exact requested source values.
        """
        assert band == 1
        assert masked is False
        self.read_windows.append(window)
        row_start = int(window.row_off)
        column_start = int(window.col_off)
        return self.values[
            row_start:row_start + int(window.height),
            column_start:column_start + int(window.width),
        ].copy()


def _statistics_result(
    value: float = 1,
    sampling_area: RasterSamplingArea | None = None,
) -> RasterStatistics:
    """Build one valid statistics response for service tests.

    Args:
        value: Single finite response value.
        sampling_area: Optional explicit sampling area; whole raster by default.

    Returns:
        Valid exact bounded statistics for the supplied scope.
    """
    area = sampling_area or WholeRasterSamplingArea()
    selected_bounds = (
        Wgs84Bounds(
            west=area.bounds[0],
            south=area.bounds[1],
            east=area.bounds[2],
            north=area.bounds[3],
        )
        if isinstance(area, SelectedBoundsSamplingArea)
        else None
    )
    catalog_selection = (
        area.resolved.selection
        if isinstance(area, CatalogSelectionSamplingArea)
        else None
    )
    return RasterStatistics(
        scope=area.kind,
        selectedBounds=selected_bounds,
        catalogSelection=catalog_selection,
        sourceWidth=1,
        sourceHeight=1,
        sourcePixelCount=1,
        sampleWidth=1,
        sampleHeight=1,
        sampledPixelCount=1,
        validSampleCount=1,
        samplingMethod="exactSourceWindow",
        estimated=False,
        sampleMinimum=value,
        sampleMaximum=value,
        percentiles=RasterPercentiles(p05=value, p50=value, p95=value),
        histogram=RasterHistogram(
            counts=[1, *([0] * 63)],
            edges=[float(index) for index in range(65)],
        ),
        suggestedRange=RasterValueRange(
            minimum=value - 1,
            midpoint=value,
            maximum=value + 1,
        ),
    )


def _write_raster(
    source_path: Path,
    values: numpy.ndarray,
    *,
    transform: Affine,
    crs: str = "EPSG:4326",
    nodata: float | None = None,
) -> None:
    """Write one small signed GeoTIFF used by geometry integration tests.

    Args:
        source_path: Destination GeoTIFF path.
        values: Two-dimensional band-one values.
        transform: Source affine transform.
        crs: Source coordinate reference system.
        nodata: Optional band nodata value.

    Returns:
        None after writing the source.
    """
    height, width = values.shape
    with rasterio.open(
        source_path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype=values.dtype,
        nodata=nodata,
        crs=crs,
        transform=transform,
    ) as dataset:
        dataset.write(values, 1)


def test_paired_statistics_use_x_reference_grid_and_filter_pairwise_nodata(
    tmp_path: Path,
) -> None:
    """Align Y to X with nearest neighbor and retain only jointly valid cells.

    Args:
        tmp_path: Temporary directory for two controlled GeoTIFF sources.

    Returns:
        None after verifying X-grid alignment and pairwise validity filtering.
    """
    x_path = tmp_path / "x.tif"
    y_path = tmp_path / "y.tif"
    _write_raster(
        x_path,
        numpy.arange(16, dtype=numpy.float32).reshape(4, 4),
        transform=from_origin(0, 4, 1, 1),
    )
    _write_raster(
        y_path,
        numpy.array([[10, 20], [30, -999]], dtype=numpy.float32),
        transform=from_origin(0, 4, 2, 2),
        nodata=-999,
    )

    statistics = read_raster_paired_statistics(x_path, y_path, None)

    assert statistics.reference_grid == "x"
    assert statistics.resampling == "nearest"
    assert statistics.sampling_method == "sampleGrid"
    assert statistics.approximate is True
    assert (statistics.source_width, statistics.source_height) == (4, 4)
    assert (statistics.sample_width, statistics.sample_height) == (3, 3)
    assert statistics.sampled_cell_count == 9
    assert statistics.paired_sample_count == 8
    assert sum(statistics.histogram.x_marginal_counts) == 8
    assert sum(statistics.histogram.y_marginal_counts) == 8
    assert sum(map(sum, statistics.histogram.counts)) == 8


def test_paired_statistics_use_internal_overviews_for_both_sources(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep cold global pairs off the scattered native-block fallback.

    Args:
        tmp_path: Temporary directory for internally overviewed GeoTIFFs.
        monkeypatch: Pytest collaborator for recording the owner boundary.

    Returns:
        None after proving both axes complete through bounded overview reads.
    """
    x_path = tmp_path / "overview-x.tif"
    y_path = tmp_path / "overview-y.tif"
    shape = (1_024, 1_024)
    transform = from_origin(-180, 90, 360 / shape[1], 180 / shape[0])
    for source_path, offset in ((x_path, 0), (y_path, 10)):
        values = (
            numpy.arange(shape[0] * shape[1], dtype=numpy.int32).reshape(shape)
            + offset
        )
        with rasterio.open(
            source_path,
            "w",
            driver="GTiff",
            width=shape[1],
            height=shape[0],
            count=1,
            dtype=values.dtype,
            crs="EPSG:4326",
            transform=transform,
            tiled=True,
            blockxsize=128,
            blockysize=128,
            nodata=-9999,
        ) as destination:
            destination.write(values, 1)
            destination.build_overviews((2, 4, 8), Resampling.nearest)

    overview_sources: list[str] = []
    real_overview_reader = paired_statistics.read_planned_sample_grid_from_overview

    def record_overview_read(
        dataset: rasterio.io.DatasetReader,
        source_window: Window,
        plan: object,
        cancellation_requested: object,
    ) -> numpy.ma.MaskedArray | None:
        """Record and delegate one paired overview read.

        Args:
            dataset: Open paired source.
            source_window: Bounded window containing planned positions.
            plan: Admitted sample-grid plan.
            cancellation_requested: Optional cancellation predicate.

        Returns:
            Delegated bounded overview sample.
        """
        overview_sources.append(Path(dataset.name).name)
        return real_overview_reader(
            dataset,
            source_window,
            plan,  # type: ignore[arg-type]
            cancellation_requested,  # type: ignore[arg-type]
        )

    def reject_native_fallback(*_: object) -> None:
        """Fail if an overviewed paired source reaches native block reads.

        Args:
            *_: Unexpected native-reader arguments.

        Returns:
            None because the controlled call always fails.

        Raises:
            AssertionError: Always, because both sources have suitable
                overviews.
        """
        raise AssertionError("paired overview source used native blocks")

    monkeypatch.setattr(
        paired_statistics,
        "read_planned_sample_grid_from_overview",
        record_overview_read,
    )
    monkeypatch.setattr(
        paired_statistics,
        "read_planned_sample_grid",
        reject_native_fallback,
    )

    statistics = read_raster_paired_statistics(x_path, y_path, None)

    assert overview_sources == [x_path.name, y_path.name]
    assert (statistics.sample_width, statistics.sample_height) == (127, 127)
    assert statistics.paired_sample_count == 127 * 127
    assert statistics.approximate is True


def test_paired_statistics_accept_constant_extreme_float64_values(
    tmp_path: Path,
) -> None:
    """Keep histogram bounds finite at both supported float64 extremes.

    Args:
        tmp_path: Temporary directory for two controlled GeoTIFF sources.

    Returns:
        None after verifying the public paired-statistics result.
    """
    x_path = tmp_path / "maximum-float64.tif"
    y_path = tmp_path / "minimum-float64.tif"
    extreme = numpy.finfo(numpy.float64).max
    transform = from_origin(0, 1, 1, 1)
    _write_raster(
        x_path,
        numpy.full((1, 1), extreme, dtype=numpy.float64),
        transform=transform,
    )
    _write_raster(
        y_path,
        numpy.full((1, 1), -extreme, dtype=numpy.float64),
        transform=transform,
    )

    statistics = read_raster_paired_statistics(x_path, y_path, None)

    assert statistics.x_minimum == statistics.x_maximum == extreme
    assert statistics.y_minimum == statistics.y_maximum == -extreme
    assert numpy.isfinite(statistics.histogram.x_edges).all()
    assert numpy.isfinite(statistics.histogram.y_edges).all()
    assert sum(map(sum, statistics.histogram.counts)) == 1


def test_paired_statistics_admit_both_plans_before_pixel_reads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject Y planning before performing any admitted X pixel read.

    Args:
        tmp_path: Temporary directory for controlled GeoTIFF sources.
        monkeypatch: Pytest collaborator for isolating plan/read order.

    Returns:
        None after verifying both plans are admitted before either source read.
    """
    x_path = tmp_path / "plan-first-x.tif"
    y_path = tmp_path / "plan-first-y.tif"
    values = numpy.arange(9, dtype=numpy.float32).reshape(3, 3)
    _write_raster(x_path, values, transform=from_origin(0, 3, 1, 1))
    _write_raster(y_path, values, transform=from_origin(0, 3, 1, 1))
    read_calls = []

    def reject_y_plan(*_: object) -> None:
        """Represent a Y source whose bounded work cannot be admitted.

        Args:
            *_: Ignored planner arguments supplied by the paired reader.

        Returns:
            None because the controlled planner always rejects the request.

        Raises:
            ValueError: Always, before either source may be read.
        """
        raise ValueError("controlled Y plan rejection")

    def record_unexpected_read(*_: object) -> None:
        """Record an invalid early source read.

        Args:
            *_: Ignored read arguments supplied by the paired reader.

        Returns:
            None because an unexpected source read always fails the test.

        Raises:
            AssertionError: Always, because planning must finish first.
        """
        read_calls.append(True)
        raise AssertionError("source read occurred before both plans")

    monkeypatch.setattr(
        paired_statistics,
        "plan_sample_grid_for_source_positions",
        reject_y_plan,
    )
    monkeypatch.setattr(
        paired_statistics,
        "read_planned_sample_grid",
        record_unexpected_read,
    )

    with pytest.raises(ValueError, match="controlled Y plan rejection"):
        read_raster_paired_statistics(x_path, y_path, None)
    assert read_calls == []


def test_paired_statistics_cross_crs_nearest_alignment_and_orientation(
    tmp_path: Path,
) -> None:
    """Map X centers across CRSs and retain Y-row/X-column orientation.

    Args:
        tmp_path: Temporary directory for controlled GeoTIFF sources.

    Returns:
        None after verifying cross-CRS alignment and matrix orientation.
    """
    x_path = tmp_path / "geographic-x.tif"
    y_path = tmp_path / "mercator-y.tif"
    x_values = numpy.arange(1, 10, dtype=numpy.float32).reshape(3, 3)
    y_values = numpy.arange(90, 0, -10, dtype=numpy.float32).reshape(3, 3)
    _write_raster(
        x_path,
        x_values,
        transform=from_origin(0, 3, 1, 1),
        crs="EPSG:4326",
    )
    mercator_bounds = transform_bounds(
        "EPSG:4326",
        "EPSG:3857",
        0,
        0,
        3,
        3,
    )
    _write_raster(
        y_path,
        y_values,
        transform=from_bounds(*mercator_bounds, 3, 3),
        crs="EPSG:3857",
    )

    statistics = read_raster_paired_statistics(x_path, y_path, None)

    assert statistics.paired_sample_count == 9
    assert statistics.histogram.counts[31][0] == 1
    assert statistics.histogram.counts[0][31] == 1
    assert statistics.histogram.x_marginal_counts[0] == 1
    assert statistics.histogram.x_marginal_counts[31] == 1
    assert statistics.histogram.y_marginal_counts[0] == 1
    assert statistics.histogram.y_marginal_counts[31] == 1


def test_paired_statistics_bounds_nonoverlap_and_xy_swap_are_explicit(
    tmp_path: Path,
) -> None:
    """Echo selected bounds, reject misses, and expose X-grid asymmetry.

    Args:
        tmp_path: Temporary directory for controlled source grids.

    Returns:
        None after verifying bounds, misses, and asymmetric X/Y roles.
    """
    fine_path = tmp_path / "fine-x.tif"
    coarse_path = tmp_path / "coarse-y.tif"
    outside_path = tmp_path / "outside.tif"
    _write_raster(
        fine_path,
        numpy.arange(25, dtype=numpy.float32).reshape(5, 5),
        transform=from_origin(0, 5, 1, 1),
    )
    _write_raster(
        coarse_path,
        numpy.arange(9, dtype=numpy.float32).reshape(3, 3),
        transform=from_origin(0, 5, 5 / 3, 5 / 3),
    )
    _write_raster(
        outside_path,
        numpy.ones((3, 3), dtype=numpy.float32),
        transform=from_origin(20, 25, 1, 1),
    )
    bounds = (1.0, 1.0, 4.0, 4.0)

    selected = read_raster_paired_statistics(
        fine_path,
        coarse_path,
        bounds,
    )
    fine_reference = read_raster_paired_statistics(
        fine_path,
        coarse_path,
        None,
    )
    coarse_reference = read_raster_paired_statistics(
        coarse_path,
        fine_path,
        None,
    )

    assert selected.scope == "selectedArea"
    assert selected.selected_bounds is not None
    assert selected.selected_bounds.canonical_tuple() == bounds
    assert fine_reference.sampled_cell_count == 25
    assert coarse_reference.sampled_cell_count == 9
    with pytest.raises(NoRasterBoundsOverlapError):
        read_raster_paired_statistics(fine_path, outside_path, None)


def test_paired_statistics_bound_large_grids_and_reject_empty_pairs(
    tmp_path: Path,
) -> None:
    """Cap the X reference grid and require at least one jointly valid cell.

    Args:
        tmp_path: Temporary directory for bounded and nodata GeoTIFF sources.

    Returns:
        None after verifying the grid ceiling and empty-pair rejection.
    """
    x_path = tmp_path / "large-x.tif"
    y_path = tmp_path / "large-y.tif"
    empty_path = tmp_path / "empty-y.tif"
    shape = (129, 129)
    transform = from_origin(0, 64.5, 0.5, 0.5)
    values = numpy.arange(129 * 129, dtype=numpy.float32).reshape(shape)
    _write_raster(x_path, values, transform=transform)
    _write_raster(y_path, values + 10, transform=transform)
    _write_raster(
        empty_path,
        numpy.full(shape, -999, dtype=numpy.float32),
        transform=transform,
        nodata=-999,
    )

    statistics = read_raster_paired_statistics(x_path, y_path, None)

    assert (statistics.sample_width, statistics.sample_height) == (127, 127)
    assert statistics.sampled_cell_count == 127 * 127
    assert statistics.paired_sample_count == 127 * 127
    assert statistics.approximate is True
    with pytest.raises(NoValidRasterSamplesError):
        read_raster_paired_statistics(x_path, empty_path, None)


def test_paired_request_forbids_paths_and_duplicate_identities() -> None:
    """Keep the public paired contract limited to two catalog identities.

    Returns:
        None after rejecting duplicate identities and arbitrary paths.
    """
    identity = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
    }
    with pytest.raises(ValidationError):
        CatalogRasterPairRequest.model_validate({
            "xRaster": identity,
            "yRaster": identity,
        })
    with pytest.raises(ValidationError):
        CatalogRasterPairRequest.model_validate({
            "xRaster": identity,
            "yRaster": {
                **identity,
                "itemId": "geotiff-abcdef0123456789abcdef01",
                "path": "file:///untrusted.tif",
            },
        })


def test_pixel_reader_requests_only_band_one_and_its_source_cell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep pixel probing independent and bounded to one source cell."""
    dataset = _PixelDataset()
    monkeypatch.setattr("eolab_app.raster.pixel.rasterio.open", lambda _: dataset)
    monkeypatch.setattr("eolab_app.raster.pixel.transform", lambda *_: ([10], [20]))

    pixel = read_raster_pixel(Path("raster.tif"), -123, 48)

    assert pixel.model_dump(by_alias=True) == {
        "longitude": -123.0,
        "latitude": 48.0,
        "row": 2,
        "column": 3,
        "inBounds": True,
        "value": 42.5,
    }
    assert dataset.read_arguments == (1, Window(3, 2, 1, 1), True)


def test_pixel_reader_treats_an_unprojectable_position_as_outside(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not pass non-finite projected coordinates to Rasterio indexing."""
    dataset = _PixelDataset()
    monkeypatch.setattr("eolab_app.raster.pixel.rasterio.open", lambda _: dataset)
    monkeypatch.setattr(
        "eolab_app.raster.pixel.transform",
        lambda *_: ([float("inf")], [float("inf")]),
    )

    pixel = read_raster_pixel(Path("raster.tif"), 180, 90)

    assert pixel.in_bounds is False
    assert pixel.row is None
    assert pixel.column is None
    assert dataset.read_arguments is None


def test_raster_statistics_exact_read_filters_nodata_and_nonfinite_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Summarize a small source exactly without resampling or ``out_shape``."""
    source_path = Path("projected-raster.tif")
    values = numpy.array(
        [[0.0, 1.0, 2.0, numpy.nan], [99.0, 3.0, 4.0, 5.0]],
        dtype=numpy.float32,
    )
    dataset = _NativeStatisticsDataset(
        values,
        source_path,
        block_shape=(1, 2),
        nodata=99,
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: dataset,
    )

    statistics = read_raster_statistics(
        source_path,
        WholeRasterSamplingArea(),
    )

    assert statistics.scope == "wholeRaster"
    assert statistics.sampling_method == "exactSourceWindow"
    assert statistics.estimated is False
    assert (statistics.source_width, statistics.source_height) == (4, 2)
    assert (statistics.sample_width, statistics.sample_height) == (4, 2)
    assert statistics.valid_sample_count == 6
    assert statistics.sample_minimum == 0
    assert statistics.sample_maximum == 5
    assert statistics.percentiles.model_dump() == {
        "p05": 0.25,
        "p50": 2.5,
        "p95": 4.75,
    }
    assert sum(statistics.histogram.counts) == 6
    assert dataset.read_windows == [
        Window(0, 0, 2, 1),
        Window(2, 0, 2, 1),
        Window(0, 1, 2, 1),
        Window(2, 1, 2, 1),
    ]


def test_raster_statistics_broad_source_uses_fixed_sample_grid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Report approximate provenance for a broad bounded native-block grid."""
    source_path = Path("broad-raster.tif")
    values = numpy.arange(600 * 1_000, dtype=numpy.int32).reshape((600, 1_000))
    dataset = _NativeStatisticsDataset(
        values,
        source_path,
        block_shape=(32, 32),
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: dataset,
    )

    statistics = read_raster_statistics(
        source_path,
        WholeRasterSamplingArea(),
    )

    assert statistics.sampling_method == "sampleGrid"
    assert statistics.estimated is True
    assert (statistics.sample_width, statistics.sample_height) == (127, 75)
    assert statistics.sampled_pixel_count == 127 * 75
    assert statistics.valid_sample_count == 127 * 75
    assert 0 < len(dataset.read_windows) <= statistics.sampled_pixel_count
    assert len(set(dataset.read_windows)) == len(dataset.read_windows)


@pytest.mark.parametrize(
    ("sampling_area", "expected_sampling_method"),
    (
        (WholeRasterSamplingArea(), "sampleGrid"),
        (
            SelectedBoundsSamplingArea((-1.0, -1.0, 1.0, 1.0)),
            "exactSourceWindow",
        ),
    ),
)
def test_raster_statistics_supports_safe_long_strips(
    monkeypatch: pytest.MonkeyPatch,
    sampling_area: RasterSamplingArea,
    expected_sampling_method: str,
) -> None:
    """Produce histograms for the affected layout in sampled and exact modes.

    Args:
        monkeypatch: Rasterio-open replacement fixture.
        sampling_area: Whole-raster or narrow selected-area request.
        expected_sampling_method: Planner mode expected for the request.

    Returns:
        None.
    """
    source_path = Path("barley_N_increase.tif")
    values = numpy.broadcast_to(
        numpy.arange(4_320, dtype=numpy.float32),
        (2_160, 4_320),
    )
    dataset = _NativeStatisticsDataset(
        values,
        source_path,
        transform=from_bounds(-180, -90, 180, 90, 4_320, 2_160),
        block_shape=(1, 4_320),
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: dataset,
    )

    statistics = read_raster_statistics(source_path, sampling_area)

    assert statistics.sampling_method == expected_sampling_method
    assert statistics.valid_sample_count > 0
    assert sum(statistics.histogram.counts) == statistics.valid_sample_count
    assert dataset.read_windows
    assert all(window.width == 4_320 for window in dataset.read_windows)
    assert len(set(dataset.read_windows)) == len(dataset.read_windows)


def test_raster_statistics_rejects_unsafe_native_block_before_pixel_io(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Preserve pre-I/O rejection for one excessive decoded block.

    Args:
        monkeypatch: Rasterio-open replacement fixture.

    Returns:
        None.
    """
    source_path = Path("unsafe-block.tif")
    values = numpy.broadcast_to(
        numpy.zeros(1, dtype=numpy.float32),
        (4_096, 4_096),
    )
    dataset = _NativeStatisticsDataset(
        values,
        source_path,
        block_shape=(4_096, 4_096),
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: dataset,
    )

    with pytest.raises(ValueError, match="each native block to decode"):
        read_raster_statistics(source_path, WholeRasterSamplingArea())

    assert dataset.read_windows == []


@pytest.mark.parametrize(
    "selected_bounds",
    (
        {"west": 10, "south": -1, "east": 10, "north": 1},
        {"west": 10, "south": -1, "east": -10, "north": 1},
        {"west": -1, "south": 10, "east": 1, "north": 10},
        {"west": -1, "south": 10, "east": 1, "north": -10},
        {"west": -181, "south": -1, "east": 1, "north": 1},
        {"west": "-1", "south": -1, "east": 1, "north": 1},
        {
            "west": -1,
            "south": -1,
            "east": 1,
            "north": 1,
            "path": "/scan-source/raster.tif",
        },
    ),
)
def test_raster_statistics_request_rejects_invalid_selected_bounds(
    selected_bounds: dict[str, object],
) -> None:
    """Accept only finite, ordered, non-wrapping WGS 84 rectangles."""
    with pytest.raises(ValidationError):
        CatalogRasterStatisticsRequest.model_validate({
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": ITEM_ID,
            "selectedBounds": selected_bounds,
        })


def test_raster_statistics_request_enforces_the_strict_sampling_area_union() -> None:
    """Accept only whole raster, bounds, or one opaque AOI reference."""
    identity = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
    }
    catalog_selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="polygons",
        assetKey="data",
        layerName="polygons",
        sourceSignature="a" * 64,
        filter={},
    )
    aoi_request = CatalogRasterStatisticsRequest.model_validate(
        {
            **identity,
            "catalogSelection": catalog_selection,
        }
    )

    assert aoi_request.catalog_selection == catalog_selection
    assert aoi_request.selected_bounds is None
    for invalid_document in (
        {**identity, "catalogSelection": "../server/path"},
        {
            **identity,
            "catalogSelection": catalog_selection,
            "selectedBounds": {
                "west": -1,
                "south": -1,
                "east": 1,
                "north": 1,
            },
        },
        {**identity, "catalogSelection": catalog_selection, "geometry": {}},
    ):
        with pytest.raises(ValidationError):
            CatalogRasterStatisticsRequest.model_validate(invalid_document)


def test_selected_bounds_are_densified_padded_and_clipped_before_reading(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Conservatively derive a rotated source window from all four edges."""
    source_path = Path("projected-raster.tif")
    dataset = _NativeStatisticsDataset(
        numpy.zeros((800, 1_000), dtype=numpy.float32),
        source_path,
        transform=(
            Affine.translation(2_000, 8_000)
            * Affine.rotation(25)
            * Affine.scale(10, -10)
        ),
        crs="EPSG:3857",
        block_shape=(64, 64),
    )
    transform_call: tuple[object, ...] | None = None

    def project_ring(
        source_crs: object,
        target_crs: object,
        longitudes: list[float],
        latitudes: list[float],
    ) -> tuple[list[float], list[float]]:
        """Map WGS 84 positions through controlled source-pixel positions.

        Args:
            source_crs: Expected WGS 84 source CRS.
            target_crs: Controlled raster CRS.
            longitudes: Densified longitude sequence.
            latitudes: Densified latitude sequence.

        Returns:
            Projected x and y sequences.
        """
        nonlocal transform_call
        transform_call = (source_crs, target_crs, longitudes, latitudes)
        pixel_coordinates = [
            ((longitude + 1) * 100 - 0.25, 460 - latitude * 140 - 0.25)
            for longitude, latitude in zip(longitudes, latitudes, strict=True)
        ]
        projected = [dataset.transform * point for point in pixel_coordinates]
        return (
            [coordinate[0] for coordinate in projected],
            [coordinate[1] for coordinate in projected],
        )

    monkeypatch.setattr("eolab_app.raster.statistics.transform", project_ring)
    bounds = (-2.0, -1.0, 3.0, 4.0)

    selected = selected_raster_area_for_wgs84_bounds(
        dataset,  # type: ignore[arg-type]
        bounds,
    )

    assert transform_call is not None
    assert transform_call[:2] == ("EPSG:4326", "EPSG:3857")
    transformed_ring = tuple(zip(transform_call[2], transform_call[3], strict=True))
    assert len(transformed_ring) == 89
    assert transformed_ring[0] == transformed_ring[-1] == (-2.0, -1.0)
    assert (-2.0, 4.0) in transformed_ring
    assert (3.0, -1.0) in transformed_ring
    assert (3.0, 4.0) in transformed_ring
    assert selected.source_window == Window(0, 0, 401, 601)
    assert not dataset.read_windows


def test_selected_area_masks_non_axis_aligned_projected_envelope(
    tmp_path: Path,
) -> None:
    """Exclude distinctive cells lying only in a transformed envelope."""
    selected_bounds = (-130.0, 45.0, -60.0, 75.0)
    west, south, east, north = selected_bounds
    denominator = 22
    wgs84_ring: list[tuple[float, float]] = []
    edge_endpoints = (
        ((west, south), (east, south)),
        ((east, south), (east, north)),
        ((east, north), (west, north)),
        ((west, north), (west, south)),
    )
    for edge_index, (start, end) in enumerate(edge_endpoints):
        for step in range(0 if edge_index == 0 else 1, denominator + 1):
            fraction = step / denominator
            wgs84_ring.append((
                start[0] + (end[0] - start[0]) * fraction,
                start[1] + (end[1] - start[1]) * fraction,
            ))

    projected_x, projected_y = transform_coordinates(
        "EPSG:4326",
        "EPSG:3347",
        [coordinate[0] for coordinate in wgs84_ring],
        [coordinate[1] for coordinate in wgs84_ring],
    )
    projected_ring = tuple(zip(projected_x, projected_y, strict=True))
    width = 200
    height = 160
    raster_transform = from_bounds(
        min(projected_x),
        min(projected_y),
        max(projected_x),
        max(projected_y),
        width,
        height,
    )
    inside_selection = geometry_mask(
        [{"type": "Polygon", "coordinates": [projected_ring]}],
        out_shape=(height, width),
        transform=raster_transform,
        all_touched=True,
        invert=True,
    )
    raster_values = numpy.where(inside_selection, 7, 997).astype("float32")
    source_path = tmp_path / "non-axis-aligned-selection.tif"
    _write_raster(
        source_path,
        raster_values,
        transform=raster_transform,
        crs="EPSG:3347",
    )

    statistics = read_raster_statistics(
        source_path,
        SelectedBoundsSamplingArea(selected_bounds),
    )

    assert statistics.sampling_method == "exactSourceWindow"
    assert statistics.valid_sample_count == int(inside_selection.sum())
    assert statistics.sample_minimum == statistics.sample_maximum == 7


def test_catalog_selection_unions_overlapping_polygons_once(tmp_path: Path) -> None:
    """Count each finite source cell once across overlapping AOI polygons."""
    source_path = tmp_path / "aoi-mask.tif"
    values = numpy.arange(1, 25, dtype=numpy.float32).reshape((4, 6))
    transform = from_origin(0, 4, 1, 1)
    _write_raster(source_path, values, transform=transform)
    polygons = (
        {
            "type": "Polygon",
            "coordinates": [[(0.1, 0.1), (3.1, 0.1), (3.1, 3.9), (0.1, 3.9), (0.1, 0.1)]],
        },
        {
            "type": "MultiPolygon",
            "coordinates": [[[(2.1, 0.1), (4.9, 0.1), (4.9, 3.9), (2.1, 3.9), (2.1, 0.1)]]],
        },
    )
    area = CatalogSelectionSamplingArea(
        write_selection(tmp_path / "polygons.gpkg", list(polygons))
    )

    statistics = read_raster_statistics(source_path, area)

    with rasterio.open(source_path) as dataset:
        expected_inside = geometry_mask(
            polygons,
            out_shape=(dataset.height, dataset.width),
            transform=dataset.transform,
            all_touched=True,
            invert=True,
        )
    assert statistics.scope == "catalogSelection"
    assert statistics.catalog_selection == area.resolved.selection
    assert statistics.valid_sample_count == int(expected_inside.sum())
    assert sum(statistics.histogram.counts) == int(expected_inside.sum())
    assert statistics.valid_sample_count < sum(
        int(
            geometry_mask(
                [geometry],
                out_shape=values.shape,
                transform=transform,
                all_touched=True,
                invert=True,
            ).sum()
        )
        for geometry in polygons
    )

    paired_path = tmp_path / "paired-aoi-mask.tif"
    _write_raster(paired_path, values * 2, transform=transform)
    paired = read_raster_paired_statistics(
        source_path, paired_path, None, catalog_selection=area
    )
    assert paired.scope == "catalogSelection"
    assert paired.catalog_selection == area.resolved.selection
    # Paired sampling retains its odd-size bounded grid; 1D uses an exact small window.
    assert 0 < paired.paired_sample_count < statistics.valid_sample_count
    assert sum(paired.histogram.x_marginal_counts) == paired.paired_sample_count
    assert paired.y_minimum == 2 * paired.x_minimum
    assert paired.y_maximum == 2 * paired.x_maximum


def test_catalog_selection_sample_grid_masks_a_large_interior_hole(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exclude a buffered hole sentinel from broad sampled AOI statistics.

    The sentinel core is 25 source pixels inside every hole edge, while one
    coarse sample cell spans fewer than 7 source pixels. This keeps the check
    compatible with the inherited all-touched cell-inclusion policy.

    Args:
        monkeypatch: Rasterio-open replacement fixture.

    Returns:
        None.
    """
    source_path = Path("sampled-aoi-hole.tif")
    values = numpy.full((600, 1_000), 7, dtype=numpy.float32)
    values[200:400, 325:675] = 997
    dataset = _NativeStatisticsDataset(
        values,
        source_path,
        transform=from_origin(-10, 6, 0.02, 0.02),
        block_shape=(32, 32),
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: dataset,
    )
    outer_bounds = (-8.0, -4.0, 8.0, 4.0)
    rectangle = read_raster_statistics(
        source_path,
        SelectedBoundsSamplingArea(outer_bounds),
    )
    area = CatalogSelectionSamplingArea(
        write_selection(
            tmp_path / "H.gpkg",
            (
                {
                    "type": "Polygon",
                    "coordinates": [
                        [(-8, -4), (8, -4), (8, 4), (-8, 4), (-8, -4)],
                        [(-4, -2.5), (-4, 2.5), (4, 2.5), (4, -2.5), (-4, -2.5)],
                    ],
                },
            ),
        )
    )

    statistics = read_raster_statistics(source_path, area)

    assert rectangle.sampling_method == statistics.sampling_method == "sampleGrid"
    assert rectangle.sample_maximum == 997
    assert statistics.sample_minimum == statistics.sample_maximum == 7
    assert statistics.valid_sample_count < rectangle.valid_sample_count


def test_catalog_selection_distinguishes_no_overlap_from_nodata(tmp_path: Path) -> None:
    """Keep absent intersections distinct from all-nodata intersections."""
    source_path = tmp_path / "empty-aoi-mask.tif"
    _write_raster(
        source_path,
        numpy.full((2, 2), -9999, dtype=numpy.float32),
        transform=from_origin(0, 2, 1, 1),
        nodata=-9999,
    )
    inside = CatalogSelectionSamplingArea(
        write_selection(
            tmp_path / "C.gpkg",
            (
                {
                    "type": "Polygon",
                    "coordinates": [[(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)]],
                },
            ),
        )
    )
    outside = CatalogSelectionSamplingArea(
        write_selection(
            tmp_path / "D.gpkg",
            (
                {
                    "type": "Polygon",
                    "coordinates": [[(10, 10), (11, 10), (11, 11), (10, 11), (10, 10)]],
                },
            ),
        )
    )

    with pytest.raises(NoValidRasterSamplesError):
        read_raster_statistics(source_path, inside)
    with pytest.raises(NoRasterBoundsOverlapError):
        read_raster_statistics(source_path, outside)


def test_statistics_reject_external_sidecars_and_missing_crs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Preserve actionable source failures outside bounded statistics."""
    source_path = Path("unsafe.tif")
    values = numpy.ones((2, 2), dtype=numpy.uint8)
    sidecar = _NativeStatisticsDataset(
        values,
        source_path,
        extra_files=(Path("unsafe.tif.ovr"),),
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: sidecar,
    )
    with pytest.raises(ValueError, match="external GDAL sidecars"):
        read_raster_statistics(source_path, WholeRasterSamplingArea())
    assert not sidecar.read_windows

    missing_crs = _NativeStatisticsDataset(values, source_path, crs=None)
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: missing_crs,
    )
    with pytest.raises(ValueError, match="valid source CRS"):
        read_raster_statistics(source_path, WholeRasterSamplingArea())
    assert not missing_crs.read_windows


@pytest.mark.parametrize(
    "non_finite_coefficient",
    (numpy.nan, numpy.inf, -numpy.inf),
    ids=("nan", "positive-infinity", "negative-infinity"),
)
def test_statistics_reject_non_finite_affine_before_native_reads(
    monkeypatch: pytest.MonkeyPatch,
    non_finite_coefficient: float,
) -> None:
    """Reject unsafe affine coefficients at the source-contract boundary.

    Args:
        monkeypatch: Rasterio-open replacement fixture.
        non_finite_coefficient: Controlled NaN or infinite affine value.

    Returns:
        None.
    """
    source_path = Path("non-finite-transform.tif")
    dataset = _NativeStatisticsDataset(
        numpy.ones((2, 2), dtype=numpy.uint8),
        source_path,
        transform=Affine(non_finite_coefficient, 0, 0, 0, -1, 2),
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: dataset,
    )

    with pytest.raises(ValueError, match="finite source transform"):
        read_raster_statistics(source_path, WholeRasterSamplingArea())

    assert not dataset.read_windows


def test_statistics_reject_affine_with_non_finite_inverse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject finite coefficients whose inverse overflows before source reads.

    Args:
        monkeypatch: Rasterio-open replacement fixture.

    Returns:
        None.
    """
    source_path = Path("unsafe-inverse-transform.tif")
    dataset = _NativeStatisticsDataset(
        numpy.ones((2, 2), dtype=numpy.uint8),
        source_path,
        transform=Affine(1e-320, 0, 0, 0, -1, 2),
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: dataset,
    )

    with pytest.raises(ValueError, match="safely invertible source transform"):
        read_raster_statistics(source_path, WholeRasterSamplingArea())

    assert not dataset.read_windows


def test_raster_statistics_make_flat_and_repeated_ranges_renderable() -> None:
    """Keep suggested thresholds strict without rewriting raw percentiles."""
    flat_range = strict_raster_value_range(
        0.0001,
        0.0001,
        0.0001,
        0.0001,
        0.0001,
    )
    repeated_percentile_range = strict_raster_value_range(0, 100, 0, 0, 90)

    assert flat_range.minimum < flat_range.midpoint < flat_range.maximum
    assert flat_range.midpoint == 0.0001
    assert repeated_percentile_range.minimum == pytest.approx(-0.00009)
    assert repeated_percentile_range.midpoint == 0
    assert repeated_percentile_range.maximum == 90


@pytest.mark.parametrize(
    ("read_error", "expected_detail"),
    (
        (
            NoRasterBoundsOverlapError(),
            "The selected area does not overlap the raster",
        ),
        (
            NoValidRasterSamplesError(),
            "No finite, non-nodata pixels were found in the bounded raster sample",
        ),
    ),
)
def test_statistics_service_returns_stable_selection_conflicts(
    read_error: ValueError,
    expected_detail: str,
) -> None:
    """Expose overlap and empty-sample failures as deliberate conflicts."""

    def reader(
        _: Path,
        __: RasterSamplingArea,
        ___: object,
    ) -> RasterStatistics:
        """Raise the controlled reader failure.

        Args:
            _: Ignored authorized source path.
            __: Ignored normalized sampling area.
            ___: Ignored cooperative cancellation predicate.

        Raises:
            ValueError: Always raises the parametrized failure.
        """
        raise read_error

    service = RasterStatisticsService(
        _SourceAuthorizer(),
        1,
        32,
        statistics_reader=reader,  # type: ignore[arg-type]
    )
    request = CatalogRasterStatisticsRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
        "selectedBounds": {"west": -1, "south": -1, "east": 1, "north": 1},
    })

    async def request_statistics() -> None:
        """Assert the mapped public error.

        Returns:
            None.
        """
        with pytest.raises(RasterConflictError) as error:
            await service.get(request)
        assert error.value.detail == expected_detail

    asyncio.run(request_statistics())


def test_pixel_sampler_limits_concurrent_raster_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep independent pixel reads within their supplied process limit."""
    active_reads = 0
    maximum_active_reads = 0
    two_reads_started = asyncio.Event()
    release_reads = asyncio.Event()

    async def to_thread(
        _: object,
        source_path: Path,
        longitude: float,
        latitude: float,
    ) -> RasterPixel:
        """Simulate a bounded synchronous pixel reader.

        Args:
            _: Ignored reader callable.
            source_path: Authorized raster path.
            longitude: Requested longitude.
            latitude: Requested latitude.

        Returns:
            Controlled valid pixel.
        """
        nonlocal active_reads, maximum_active_reads
        assert source_path == Path("raster.tif")
        active_reads += 1
        maximum_active_reads = max(maximum_active_reads, active_reads)
        if active_reads == 2:
            two_reads_started.set()
        await release_reads.wait()
        active_reads -= 1
        return RasterPixel(
            longitude=longitude,
            latitude=latitude,
            row=0,
            column=0,
            inBounds=True,
            value=1,
        )

    monkeypatch.setattr(
        "eolab_app.raster.pixel_service.asyncio.to_thread",
        to_thread,
    )

    async def sample_three_pixels() -> None:
        """Start three independent pixel requests.

        Returns:
            None.
        """
        authorizer = _SourceAuthorizer()
        service = RasterPixelService(authorizer, read_concurrency=2)
        requests = [
            CatalogPixelRequest.model_validate({
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": ITEM_ID,
                "longitude": longitude,
                "latitude": 0,
            })
            for longitude in (1, 2, 3)
        ]
        tasks = [asyncio.create_task(service.get(request)) for request in requests]
        await asyncio.wait_for(two_reads_started.wait(), timeout=1)
        assert maximum_active_reads == 2
        release_reads.set()
        await asyncio.gather(*tasks)
        assert authorizer.authorization_count == 3

    asyncio.run(sample_three_pixels())


def test_cancelled_pixel_request_keeps_its_slot_until_reader_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not release pixel capacity while its synchronous read is active."""
    started_reads = 0
    first_read_started = asyncio.Event()
    release_reads = asyncio.Event()

    async def to_thread(
        _: object,
        __: Path,
        longitude: float,
        latitude: float,
    ) -> RasterPixel:
        """Hold a fake pixel read until explicitly released.

        Args:
            _: Ignored reader callable.
            __: Ignored authorized source path.
            longitude: Requested longitude.
            latitude: Requested latitude.

        Returns:
            Controlled valid pixel.
        """
        nonlocal started_reads
        started_reads += 1
        first_read_started.set()
        await release_reads.wait()
        return RasterPixel(
            longitude=longitude,
            latitude=latitude,
            row=0,
            column=0,
            inBounds=True,
            value=1,
        )

    monkeypatch.setattr(
        "eolab_app.raster.pixel_service.asyncio.to_thread",
        to_thread,
    )

    async def cancel_during_read() -> None:
        """Cancel one waiter while the fake pixel worker remains active.

        Returns:
            None.
        """
        service = RasterPixelService(_SourceAuthorizer(), read_concurrency=1)
        request = CatalogPixelRequest.model_validate({
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": ITEM_ID,
            "longitude": 0,
            "latitude": 0,
        })
        first_request = asyncio.create_task(service.get(request))
        await first_read_started.wait()
        first_request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_request

        second_request = asyncio.create_task(service.get(request))
        await asyncio.sleep(0)
        assert started_reads == 1
        release_reads.set()
        await second_request
        assert started_reads == 2

    asyncio.run(cancel_during_read())


def test_statistics_service_coalesces_caches_and_keys_normalized_areas(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Coalesce one identity and cache whole and bounds scopes separately."""
    authorizer = _SourceAuthorizer()
    read_areas: list[RasterSamplingArea] = []
    read_started = asyncio.Event()
    release_read = asyncio.Event()

    async def to_thread(
        function: object,
        source_path: Path,
        area: RasterSamplingArea,
        cancellation_requested: object,
    ) -> RasterStatistics:
        """Coordinate one asynchronous stand-in for the sync reader.

        Args:
            function: Service-owned statistics reader.
            source_path: Authorized source path.
            area: Normalized sampling area.
            cancellation_requested: Cooperative cancellation predicate.

        Returns:
            Controlled statistics for ``area``.
        """
        assert callable(function)
        assert source_path == Path("raster.tif")
        assert callable(cancellation_requested)
        read_areas.append(area)
        if len(read_areas) == 1:
            read_started.set()
            await release_read.wait()
        return _statistics_result(float(len(read_areas)), area)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.asyncio.to_thread",
        to_thread,
    )
    service = RasterStatisticsService(authorizer, 1, 32)
    whole_request = CatalogRasterStatisticsRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
    })
    bounds_document = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
        "selectedBounds": {"west": -2, "south": -1, "east": 0, "north": 1},
    }
    bounds_request = CatalogRasterStatisticsRequest.model_validate(bounds_document)
    equivalent_bounds_request = CatalogRasterStatisticsRequest.model_validate({
        **bounds_document,
        "selectedBounds": {
            "west": -2.0,
            "south": -1.0,
            "east": 0.0,
            "north": 1.0,
        },
    })

    async def exercise_cache() -> None:
        """Exercise coalescing and normalized cache identities.

        Returns:
            None.
        """
        first_task = asyncio.create_task(service.get(whole_request))
        second_task = asyncio.create_task(service.get(whole_request))
        await read_started.wait()
        release_read.set()
        first, second = await asyncio.gather(first_task, second_task)
        assert first is second
        assert await service.get(whole_request) is first

        selected = await service.get(bounds_request)
        assert await service.get(equivalent_bounds_request) is selected
        assert selected.scope == "selectedArea"

    asyncio.run(exercise_cache())
    assert len(read_areas) == 2
    assert isinstance(read_areas[0], WholeRasterSamplingArea)
    assert read_areas[1] == SelectedBoundsSamplingArea((-2.0, -1.0, 0.0, 1.0))


def test_cancelled_coalesced_waiter_preserves_shared_work_and_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep one shared read alive while another identical waiter remains."""
    read_count = 0
    read_started = asyncio.Event()
    release_read = asyncio.Event()

    async def to_thread(
        _: object,
        __: Path,
        area: RasterSamplingArea,
        cancellation_requested: object,
    ) -> RasterStatistics:
        """Hold one shared worker until the first waiter is canceled.

        Args:
            _: Ignored reader callable.
            __: Ignored authorized source path.
            area: Normalized shared sampling area.
            cancellation_requested: Cooperative last-waiter predicate.

        Returns:
            Controlled statistics for the shared request.
        """
        nonlocal read_count
        assert callable(cancellation_requested)
        read_count += 1
        read_started.set()
        await release_read.wait()
        assert cancellation_requested() is False
        return _statistics_result(float(read_count), area)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.asyncio.to_thread",
        to_thread,
    )
    service = RasterStatisticsService(_SourceAuthorizer(), 1, 32)
    request = CatalogRasterStatisticsRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
    })

    async def exercise_waiters() -> None:
        """Cancel one owner, then complete and cache for the other.

        Returns:
            None.
        """
        first_waiter = asyncio.create_task(service.get(request))
        await read_started.wait()
        second_waiter = asyncio.create_task(service.get(request))

        async def wait_for_coalescing() -> None:
            """Wait until both callers own the same in-flight worker."""
            while next(iter(service._inflight.values())).waiter_count < 2:
                await asyncio.sleep(0)

        await asyncio.wait_for(wait_for_coalescing(), timeout=1)
        work = next(iter(service._inflight.values()))
        assert work.waiter_count == 2

        first_waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_waiter
        assert work.waiter_count == 1
        assert work.cancellation_requested.is_set() is False

        release_read.set()
        statistics = await second_waiter
        assert await service.get(request) is statistics

    asyncio.run(exercise_waiters())
    assert read_count == 1
    assert len(service._cache) == 1
    assert not service._inflight


def test_statistics_service_invalidates_cache_by_source_signature(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Never reuse cached analysis after the catalog source identity changes."""
    authorizer = _SourceAuthorizer()
    read_count = 0

    async def to_thread(
        _: object,
        __: Path,
        area: RasterSamplingArea,
        ___: object,
    ) -> RasterStatistics:
        """Return one incrementing result.

        Args:
            _: Ignored reader callable.
            __: Ignored authorized source path.
            area: Normalized sampling area.
            ___: Ignored cancellation predicate.

        Returns:
            Statistics with an incrementing sample value.
        """
        nonlocal read_count
        read_count += 1
        return _statistics_result(float(read_count), area)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.asyncio.to_thread",
        to_thread,
    )
    service = RasterStatisticsService(authorizer, 1, 32)
    request = CatalogRasterStatisticsRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
    })

    async def exercise_signature() -> None:
        """Replace the authorization after one cached response.

        Returns:
            None.
        """
        first = await service.get(request)
        assert await service.get(request) is first
        original = authorizer.authorizations[ITEM_ID]
        authorizer.authorizations[ITEM_ID] = AuthorizedRaster(
            original.source_path,
            (1, 2, 3, 4, 6),
        )
        replacement = await service.get(request)
        assert replacement.sample_minimum == 2

    asyncio.run(exercise_signature())
    assert read_count == 2


def test_statistics_service_keys_cache_by_fixed_policy_parameters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Recompute when any server-owned statistics policy identity changes."""
    policy_parameters = [(101, 201)]
    read_count = 0

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service."
        "raster_statistics_policy_parameters",
        lambda: policy_parameters[0],
    )

    def statistics_reader(
        _: Path,
        area: RasterSamplingArea,
        __: object,
    ) -> RasterStatistics:
        """Return one result that identifies each fresh bounded read.

        Args:
            _: Ignored authorized source path.
            area: Normalized statistics sampling area.
            __: Ignored cooperative cancellation predicate.

        Returns:
            Controlled statistics with an incrementing sample value.
        """
        nonlocal read_count
        read_count += 1
        return _statistics_result(float(read_count), area)

    service = RasterStatisticsService(
        _SourceAuthorizer(),
        1,
        32,
        statistics_reader=statistics_reader,  # type: ignore[arg-type]
    )
    request = CatalogRasterStatisticsRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
    })

    async def exercise_policy_identity() -> None:
        """Reuse one policy identity, then replace it and recompute.

        Returns:
            None.
        """
        first = await service.get(request)
        assert await service.get(request) is first

        policy_parameters[0] = (101, 202)
        replacement = await service.get(request)
        assert replacement.sample_minimum == 2
        assert replacement is not first

    asyncio.run(exercise_policy_identity())
    assert read_count == 2
    assert len(service._cache) == 2


def test_final_waiter_cancelled_during_postcheck_is_not_cached() -> None:
    """Reject abandoned work canceled after reading and before caching."""
    postcheck_started = asyncio.Event()
    release_postcheck = asyncio.Event()
    read_count = 0

    class BlockingPostcheckService(RasterStatisticsService):
        """Pause after reading so the last request can cancel before caching."""

        async def _require_current_sampling_area(
            self, sampling_area: RasterSamplingArea
        ) -> None:
            """Check the area, then pause after the first read.

            Args:
                sampling_area: Area whose lifecycle must remain valid.
            """
            await super()._require_current_sampling_area(sampling_area)
            if read_count == 1:
                postcheck_started.set()
                await release_postcheck.wait()

    def statistics_reader(
        _: Path,
        area: RasterSamplingArea,
        __: object,
    ) -> RasterStatistics:
        """Return immediately so cancellation occurs after source I/O.

        Args:
            _: Ignored authorized source path.
            area: Normalized statistics sampling area.
            __: Ignored cooperative cancellation predicate.

        Returns:
            Controlled statistics identifying this bounded read.
        """
        nonlocal read_count
        read_count += 1
        return _statistics_result(float(read_count), area)

    service = BlockingPostcheckService(
        _SourceAuthorizer(),
        1,
        32,
        statistics_reader=statistics_reader,  # type: ignore[arg-type]
    )
    request = CatalogRasterStatisticsRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
    })

    async def cancel_during_postcheck() -> None:
        """Abandon the final waiter while its completed read is rechecked.

        Returns:
            None.
        """
        first_waiter = asyncio.create_task(service.get(request))
        await asyncio.wait_for(postcheck_started.wait(), timeout=1)
        first_waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_waiter
        assert not service._cache

        release_postcheck.set()

        async def wait_for_abandoned_work() -> None:
            """Wait until the cooperative worker leaves admission."""
            while service._inflight:
                await asyncio.sleep(0)

        await asyncio.wait_for(wait_for_abandoned_work(), timeout=1)
        assert not service._cache

        replacement = await service.get(request)
        assert replacement.sample_minimum == 2

    asyncio.run(cancel_during_postcheck())
    assert read_count == 2
    assert len(service._cache) == 1


def test_statistics_service_rechecks_catalog_selection(tmp_path: Path) -> None:
    """Source revocation rejects cache hits and mid-read publication independently."""
    resolved = write_selection(
        tmp_path / "area.gpkg",
        [
            {
                "type": "Polygon",
                "coordinates": [[(-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1)]],
            }
        ],
    )

    class Reader:
        available = True

        async def resolve_for_sampling(self, selection: CatalogSelection):
            """Authorize only the current fixture descriptor."""
            if not self.available or selection != resolved.selection:
                raise SelectionUnavailableError("The catalog vector changed")
            return resolved

    reader = Reader()
    calls = []

    def compute(path, area, cancellation):
        """Observe immutable input and optionally revoke it during the read."""
        calls.append(area)
        if len(calls) == 2:
            reader.available = False
        return _statistics_result(float(len(calls)), area)

    service = RasterStatisticsService(
        _SourceAuthorizer(),
        1,
        32,
        catalog_selection_reader=reader,
        statistics_reader=compute,
    )
    request = CatalogRasterStatisticsRequest(
        collectionId="eolab-mounted-geotiffs",
        itemId=ITEM_ID,
        catalogSelection=resolved.selection,
    )

    async def exercise():
        """Exercise cache admission and before-publication reauthorization."""
        first = await service.get(request)
        assert await service.get(request) is first
        reader.available = False
        with pytest.raises(RasterConflictError, match="changed"):
            await service.get(request)
        reader.available = True
        service._cache.clear()
        with pytest.raises(RasterConflictError, match="changed"):
            await service.get(request)

    asyncio.run(exercise())
    assert len(calls) == 2 and not service._cache


def test_cancelled_statistics_request_keeps_admission_until_worker_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject new work while an obsolete worker still owns admission.

    Args:
        monkeypatch: Async thread-boundary replacement fixture.

    Returns:
        None.
    """
    authorizations: dict[str, AuthorizedRaster] = {}
    requests: list[CatalogRasterStatisticsRequest] = []
    for index, source_name in enumerate(("first", "second")):
        item_id = f"geotiff-0123456789abcdef012345{index:02d}"
        authorizations[item_id] = AuthorizedRaster(
            Path(f"{source_name}.tif"),
            (1, 2, 3, 4, index),
        )
        requests.append(CatalogRasterStatisticsRequest.model_validate({
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": item_id,
        }))
    active_reads = 0
    maximum_active_reads = 0
    started_reads = 0
    first_read_started = asyncio.Event()
    release_reads = asyncio.Event()

    async def to_thread(
        _: object,
        __: Path,
        area: RasterSamplingArea,
        ___: object,
    ) -> RasterStatistics:
        """Hold a fake worker until explicitly released.

        Args:
            _: Ignored reader callable.
            __: Ignored authorized source path.
            area: Normalized sampling area.
            ___: Ignored cancellation predicate.

        Returns:
            Controlled statistics.
        """
        nonlocal active_reads, maximum_active_reads, started_reads
        started_reads += 1
        active_reads += 1
        maximum_active_reads = max(maximum_active_reads, active_reads)
        first_read_started.set()
        await release_reads.wait()
        active_reads -= 1
        return _statistics_result(float(started_reads), area)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.asyncio.to_thread",
        to_thread,
    )
    service = RasterStatisticsService(_SourceAuthorizer(authorizations), 1, 32)

    async def cancel_during_read() -> None:
        """Cancel the first waiter while its fake worker remains active.

        Returns:
            None.
        """
        first_request = asyncio.create_task(service.get(requests[0]))
        await first_read_started.wait()
        first_request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_request

        with pytest.raises(RasterStatisticsCapacityError, match="capacity is busy"):
            await service.get(requests[1])
        with pytest.raises(RasterStatisticsCapacityError, match="finishing canceled work"):
            await service.get(requests[0])
        assert started_reads == 1
        release_reads.set()
        while service._inflight:
            await asyncio.sleep(0)
        await service.get(requests[1])

    asyncio.run(cancel_during_read())
    assert started_reads == 2
    assert maximum_active_reads == 1
    assert len(service._cache) == 1


def test_statistics_service_caps_distinct_work_and_coalesces_at_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bound distinct workers while identical callers share admitted work.

    Args:
        monkeypatch: Async thread-boundary replacement fixture.

    Returns:
        None.
    """
    authorizations: dict[str, AuthorizedRaster] = {}
    requests: list[CatalogRasterStatisticsRequest] = []
    for index, source_name in enumerate(("active", "stale", "current")):
        item_id = f"geotiff-0123456789abcdef012345{index:02d}"
        authorizations[item_id] = AuthorizedRaster(
            Path(f"{source_name}.tif"),
            (1, 2, 3, 4, index),
        )
        requests.append(CatalogRasterStatisticsRequest.model_validate({
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": item_id,
        }))
    read_order: list[str] = []
    two_reads_started = asyncio.Event()
    release_reads = asyncio.Event()

    async def to_thread(
        _: object,
        source_path: Path,
        area: RasterSamplingArea,
        __: object,
    ) -> RasterStatistics:
        """Record fake reader order and hold both admitted workers.

        Args:
            _: Ignored reader callable.
            source_path: Authorized source path.
            area: Normalized sampling area.
            __: Ignored cancellation predicate.

        Returns:
            Controlled statistics for ``area``.
        """
        source_name = source_path.stem
        read_order.append(source_name)
        if len(read_order) == 2:
            two_reads_started.set()
        await release_reads.wait()
        return _statistics_result(float(len(read_order)), area)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.asyncio.to_thread",
        to_thread,
    )
    service = RasterStatisticsService(_SourceAuthorizer(authorizations), 2, 32)

    async def exercise_admission() -> None:
        """Fill admission, join existing work, and recover after completion.

        Returns:
            None.
        """
        first_request = asyncio.create_task(service.get(requests[0]))
        second_request = asyncio.create_task(service.get(requests[1]))
        await two_reads_started.wait()
        coalesced_request = asyncio.create_task(service.get(requests[0]))

        with pytest.raises(RasterStatisticsCapacityError, match="capacity is busy"):
            await service.get(requests[2])
        assert len(service._inflight) == 2
        assert len(read_order) == 2

        release_reads.set()
        first, second, coalesced = await asyncio.gather(
            first_request,
            second_request,
            coalesced_request,
        )
        assert first is coalesced
        assert second is not first

        await service.get(requests[2])

    asyncio.run(exercise_admission())
    assert set(read_order[:2]) == {"active", "stale"}
    assert read_order[2:] == ["current"]
