"""Read native GeoTIFF observations while preserving temporal and cyclic grids."""

import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Literal, Self

import numpy
import rasterio
from affine import Affine
from numpy.typing import NDArray
from rasterio.coords import BoundingBox
from rasterio.crs import CRS
from rasterio.enums import MaskFlags
from rasterio.windows import Window

from eolab_app.raster.source_contract import mask_invalid_raster_values


@dataclass(frozen=True)
class TemporalObservation:
    """Identify an admitted variable observation and its physical time support.

    Attributes:
        path: Confined single-band GeoTIFF containing this observation.
        time: UTC observation label used by public selections.
        reference_time: UTC forecast origin, or None for non-forecast observations.
        interval_start: Beginning of the observation's physical support.
        interval_end: End of its support; equals start for an instant.
        transform: Affine mapping output column/row edges to source CRS coordinates.
        crs: Coordinate reference system of that grid.
        nodata: Invalid cell value, or None when every finite value is valid.
        cyclic_x: Whether point coordinates repeat across the grid's full width.
            False leaves points outside regional grids out of bounds.
    """

    path: Path
    time: datetime
    reference_time: datetime | None
    interval_start: datetime
    interval_end: datetime
    transform: Affine
    crs: CRS
    nodata: float | int | None
    cyclic_x: bool = False


@dataclass(frozen=True)
class ResolvedTemporalInterval:
    """Describe available observations and their admitted variable metadata.

    Attributes:
        observations: Available observations in increasing label order, retaining
            original interval bounds. Missing observations remain absent.
        unit: Unit of the stored values, unchanged from Catalog admission.
        time_support: Whether values describe an instant, a mean rate over an
            interval, or an accumulation over an interval. Calculations use this
            distinction to interpret the values without guessing from names.
    """

    observations: tuple[TemporalObservation, ...]
    unit: str
    time_support: Literal["instantaneous", "mean_rate", "accumulation"]


class TemporalRasterDataset:
    """Read one GeoTIFF with an optional request-local cyclic longitude origin.

    Native blocks, values and masks come from Rasterio. The geographic view
    preserves seam-crossing cells without resampling or creating another file.
    Metadata admission establishes the observation's grid and time semantics.
    """

    def __init__(self, observation: TemporalObservation) -> None:
        """Open the admitted GeoTIFF read-only without reading its pixel values.

        Args:
            observation: Confined source and metadata established by source access.

        Raises:
            rasterio.errors.RasterioError: If the source cannot be opened.
        """
        self.native_dataset = rasterio.open(observation.path, "r", driver="GTiff")
        self.height, self.width = self.native_dataset.shape
        self.count = self.native_dataset.count
        self.dtypes = self.native_dataset.dtypes
        self.name = self.native_dataset.name
        self.driver = self.native_dataset.driver
        self.transform = observation.transform
        self.cyclic_x = observation.cyclic_x
        self._column_offset = 0
        self._column_view_prepared = False
        self.crs = observation.crs
        self.nodata = observation.nodata
        self.nodatavals = (self.nodata,)
        self.mask_flag_enums = self.native_dataset.mask_flag_enums
        self._update_grid_metadata()

    @property
    def files(self) -> list[str]:
        """Read native file dependencies when a source validator needs them.

        Returns:
            GDAL's file list for this open observation, including any sidecars.
        """
        return self.native_dataset.files

    @property
    def scales(self) -> tuple[float, ...]:
        """Read band scales when a statistics grid needs their metadata.

        Returns:
            The scale stored for each native band.
        """
        return self.native_dataset.scales

    @property
    def offsets(self) -> tuple[float, ...]:
        """Read band offsets when a statistics grid needs their metadata.

        Returns:
            The offset stored for each native band.
        """
        return self.native_dataset.offsets

    @property
    def units(self) -> tuple[str | None, ...]:
        """Read band units when a statistics grid needs their metadata.

        Returns:
            The unit stored for each native band, or None when unspecified.
        """
        return self.native_dataset.units

    @property
    def descriptions(self) -> tuple[str | None, ...]:
        """Return the stored band descriptions for this observation.

        Returns:
            One description per band, with None for an unnamed band.
        """
        return self.native_dataset.descriptions

    def tags(self, band: int = 0, *, ns: str | None = None) -> dict[str, str]:
        """Read the observation's original GeoTIFF metadata tags.

        Args:
            band: Zero for dataset tags, or the one-based band number.
            ns: Metadata namespace, or None for the default namespace.

        Returns:
            Metadata stored on the dataset or selected band.

        Raises:
            rasterio.errors.RasterioError: If the band or metadata cannot be read.
        """
        return self.native_dataset.tags(band, ns=ns)

    def _update_grid_metadata(self) -> None:
        """Update the view bounds and logical blocks after a column rotation."""
        corners = [
            self.transform * (column, row)
            for column, row in (
                (0, 0),
                (self.width, 0),
                (0, self.height),
                (self.width, self.height),
            )
        ]
        x, y = zip(*corners)
        self.bounds = BoundingBox(min(x), min(y), max(x), max(y))
        height, width = self.native_dataset.block_shapes[0]
        if self.cyclic_x:
            width = min(width, max(1, self.width // 2))
        if self._column_offset:
            width = math.gcd(width, self._column_offset, self.width)
        self.block_shapes = ((height, width),)

    def prepare_column_view(self, first_column: int) -> None:
        """Choose this read handle's column origin before making window plans.

        Rotate a cyclic grid by an integer number of columns without resampling
        or repeating source cells. The first selection owns the view; later
        polygon masks use that same affine and block grid.

        Args:
            first_column: Column in the original view that will become column
                zero. It may lie outside the original period.
        """
        if self._column_view_prepared:
            return
        self._column_view_prepared = True
        self.transform = self.transform * Affine.translation(first_column, 0)
        self._column_offset = (self._column_offset + first_column) % self.width
        self._update_grid_metadata()

    def __enter__(self) -> Self:
        """Return the open observation for a scoped native read."""
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Close the GeoTIFF after a read, including when native I/O fails.

        Args:
            exc_type: Active exception type, if the read failed.
            exc_value: Active exception, if any.
            traceback: Active exception traceback, if any.
        """
        self.native_dataset.close()

    def native_work_for_blocks(
        self, block_indexes: tuple[tuple[int, int], ...]
    ) -> tuple[int, int]:
        """Count physical TIFF blocks touched by each requested logical block.

        Args:
            block_indexes: Logical row and column indexes read separately.

        Returns:
            Native data/mask read count and decoded bytes, without assuming reuse.
        """
        from eolab_app.raster.source_contract import (
            source_block_indexes_for_window,
            source_work_for_blocks,
        )

        reads = decoded = 0
        for index in block_indexes:
            for window in self._source_windows(self.block_window(1, *index)):
                count, size = source_work_for_blocks(
                    self.native_dataset,
                    source_block_indexes_for_window(
                        window, self.native_dataset.block_shapes[0]
                    ),
                )
                reads += count
                decoded += size
        return reads, decoded

    def index(self, x: float, y: float) -> tuple[int, int]:
        """Return the native row and column containing a point in the source CRS.

        Args:
            x: Horizontal coordinate in the source CRS.
            y: Vertical coordinate in the source CRS.

        Returns:
            Integer row and column. Only cyclic grids wrap columns; other
            coordinates outside the grid retain out-of-range indexes.
        """
        column, row = ~self.transform * (x, y)
        if self.cyclic_x:
            column %= self.width
        return math.floor(row), math.floor(column)

    def block_window(self, band: int, row: int, column: int) -> Window:
        """Return one logical block clipped at the source grid edges.

        Args:
            band: The established single band, 1.
            row: Logical block row.
            column: Logical block column.

        Returns:
            Integral source window wholly inside the virtual raster.
        """
        height, width = self.block_shapes[0]
        y, x = row * height, column * width
        return Window(x, y, min(width, self.width - x), min(height, self.height - y))

    def overviews(self, band: int) -> list[int]:
        """Return no overviews; temporal reads always use original cells.

        Args:
            band: The established single band, 1.

        Returns:
            Empty list, so shared sampling plans select native blocks.
        """
        return []

    def _source_windows(self, window: Window) -> tuple[Window, ...]:
        """Map one logical window to one or two native TIFF windows.

        Args:
            window: Integral window within the request-local grid.

        Returns:
            Native windows in output order, split at the longitude seam if needed.
        """
        start = (int(window.col_off) + self._column_offset) % self.width
        first_width = min(int(window.width), self.width - start)
        first = Window(start, window.row_off, first_width, window.height)
        if first_width == window.width:
            return (first,)
        return (
            first,
            Window(0, window.row_off, window.width - first_width, window.height),
        )

    def read_masks(self, band: int, *, window: Window) -> NDArray[numpy.uint8]:
        """Read original validity bytes in the request-local column order.

        Args:
            band: Established single band, 1.
            window: Integral window inside the logical grid.

        Returns:
            Native mask bytes; zero excludes a cell.

        Raises:
            rasterio.errors.RasterioError: If mask data cannot be read.
        """
        parts = [
            self.native_dataset.read_masks(band, window=part)
            for part in self._source_windows(window)
        ]
        return parts[0] if len(parts) == 1 else numpy.concatenate(parts, axis=1)

    def read(
        self, band: int, *, window: Window, masked: bool = False
    ) -> NDArray[numpy.generic] | numpy.ma.MaskedArray:
        """Read exact native TIFF cells in the request-local column order.

        Args:
            band: Established single band, 1.
            window: Integral window inside the logical grid.
            masked: Whether to exclude nonfinite, NoData and mask-invalid cells.

        Returns:
            Original values, optionally carrying their combined validity mask.

        Raises:
            rasterio.errors.RasterioError: If native data or masks cannot be read.
        """
        parts = [
            self.native_dataset.read(band, window=part)
            for part in self._source_windows(window)
        ]
        values = parts[0] if len(parts) == 1 else numpy.concatenate(parts, axis=1)
        if not masked:
            return values
        validity = (
            self.read_masks(band, window=window)
            if MaskFlags.per_dataset in self.mask_flag_enums[0]
            else None
        )
        return mask_invalid_raster_values(values, self.nodata, validity)
