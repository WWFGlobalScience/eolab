"""Read published GeoTIFF observations and available dates from their catalog."""

import json
import math
import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from affine import Affine
from rasterio.crs import CRS
import yaml

from eolab_app.raster.errors import RasterAssetError, RasterConflictError
from eolab_app.raster.source_models import (
    TemporalIntervalSelection,
    TemporalRasterSelection,
    TemporalTimeChoices,
    TemporalTimeQuery,
    TemporalVariableSelection,
)
from eolab_app.raster.temporal import TemporalObservation


@contextmanager
def open_temporal_catalog(
    item: dict[str, Any], selection: TemporalVariableSelection, mount: Path
) -> Iterator[tuple[Path, sqlite3.Connection]]:
    """Open the selected variable's producer catalog inside its authorized mount.

    Args:
        item: Authoritative admitted temporal Catalog Item.
        selection: Validated dataset identity and variable.
        mount: Source mount enclosing the descriptor and archive.

    Yields:
        Confined archive directory and a read-only SQLite connection.

    Raises:
        RasterAssetError: If the variable is unknown or a source escapes its mount.
        RasterConflictError: If the descriptor, catalog or returned metadata cannot be read.
    """
    variables = item["properties"]["cube:variables"]
    if selection.variable not in variables:
        raise RasterAssetError("This dataset does not contain the selected variable.")
    try:
        mount = mount.resolve()
        uri = urlsplit(item["assets"]["eolab:temporal-source"]["href"])
        mount_uri = urlsplit(mount.as_uri())
        prefix = unquote(mount_uri.path).rstrip("/") + "/"
        uri_path = unquote(uri.path)
        if (
            uri.scheme != "file"
            or uri.netloc != mount_uri.netloc
            or uri.query
            or uri.fragment
            or not uri_path.startswith(prefix)
        ):
            raise RasterAssetError("The temporal dataset is outside the source mount.")
        descriptor = (mount / uri_path[len(prefix) :]).resolve()
        if not descriptor.is_relative_to(mount):
            raise RasterAssetError("The temporal dataset is outside the source mount.")
        description = yaml.safe_load(descriptor.read_text(encoding="utf-8"))
        root = descriptor.parent
        catalog = (root / description["source"]["catalog"]).resolve()
        if not catalog.is_relative_to(root):
            raise RasterAssetError("The temporal catalog is outside its archive.")
        catalog_uri = catalog.as_uri()
        if catalog.drive.startswith("\\\\"):
            catalog_uri = catalog_uri.replace("file://", "file:////", 1)
        with closing(sqlite3.connect(f"{catalog_uri}?mode=ro", uri=True)) as connection:
            yield root, connection
    except (OSError, sqlite3.Error, yaml.YAMLError, ValueError, OverflowError) as error:
        raise RasterConflictError(
            "The temporal dataset metadata could not be read."
        ) from error


def observation_datetime(seconds: int) -> datetime:
    """Return an aware UTC time for epoch seconds, including dates before 1970.

    Args:
        seconds: Admitted observation or interval time since the Unix epoch.

    Returns:
        A timezone-aware UTC datetime.
    """
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=seconds)


def get_temporal_observations(
    item: dict[str, Any],
    selection: TemporalRasterSelection | TemporalIntervalSelection,
    mount: Path,
) -> tuple[TemporalObservation, ...]:
    """Return selected GeoTIFF paths and their declared observation intervals.

    Catalog admission establishes the grid and metadata contract. Query actual
    per-variable coverage to distinguish absent observations from present rasters
    whose cells are all NoData. The archive stays unchanged during calculation.

    Args:
        item: Authoritative Catalog Item for the requested dataset.
        selection: Validated variable and observation label or requested period.
        mount: Source mount enclosing the admitted descriptor and archive.

    Returns:
        Observations in increasing label order, sharing their immutable admitted
        grid metadata. Intervals may have gaps or be empty; an exact observation
        request returns one observation.

    Raises:
        RasterAssetError: If the variable is unknown or a source escapes its mount.
        RasterConflictError: If an observation is absent or metadata cannot be read.
    """
    variables = item["properties"]["cube:variables"]
    with open_temporal_catalog(item, selection, mount) as (root, connection):
        if isinstance(selection, TemporalRasterSelection):
            condition = "valid_time = ?"
            parameters = (selection.time.timestamp(),)
        elif variables[selection.variable]["eolab:time_support"] == "instantaneous":
            condition = "valid_time >= ? AND valid_time < ?"
            parameters = (
                selection.start_time.timestamp(),
                selection.end_time.timestamp(),
            )
        else:
            condition = "interval_start < ? AND interval_end > ?"
            parameters = (
                selection.end_time.timestamp(),
                selection.start_time.timestamp(),
            )
        rows = connection.execute(
            "SELECT path, valid_time, reference_time, interval_start, interval_end, "
            "transform, crs, nodata, width FROM observations "
            f"WHERE variable = ? AND {condition} ORDER BY valid_time",
            (selection.variable, *parameters),
        )
        observations: list[TemporalObservation] = []
        for path, time, reference, start, end, grid, projection, nodata, width in rows:
            member = Path(path)
            raster_path = (root / member).resolve()
            if member.is_absolute() or not raster_path.is_relative_to(root):
                raise RasterAssetError("The selected raster is outside its archive.")
            if not observations:
                transform = Affine.from_gdal(*json.loads(grid))
                crs = CRS.from_user_input(projection)
                cyclic_x = crs.is_geographic and math.isclose(width * transform.a, 360)
            observations.append(
                TemporalObservation(
                    path=raster_path,
                    time=observation_datetime(time),
                    reference_time=(
                        None if reference is None else observation_datetime(reference)
                    ),
                    interval_start=observation_datetime(start),
                    interval_end=observation_datetime(end),
                    transform=transform,
                    crs=crs,
                    nodata=None if nodata is None else float(nodata),
                    cyclic_x=cyclic_x,
                )
            )
    if isinstance(selection, TemporalRasterSelection) and not observations:
        raise RasterConflictError(
            "No observation is available for this variable at the selected time."
        )
    return tuple(observations)


def get_temporal_time_choices(
    item: dict[str, Any], query: TemporalTimeQuery, mount: Path
) -> TemporalTimeChoices:
    """List available months and observation labels without opening rasters.

    Labels come from published observations, including partial months and
    variable-specific gaps. They are distinct from physical support intervals.

    Args:
        item: Authoritative temporal Catalog Item.
        query: Variable and optional requested UTC month.
        mount: Configured source mount enclosing the archive.

    Returns:
        Available months and ordered labels for the requested or latest month.
        An explicit unavailable month returns no times without changing month.

    Raises:
        RasterAssetError: If the variable is unknown or a source escapes its mount.
        RasterConflictError: If metadata cannot be read or the variable has no observations.
    """
    with open_temporal_catalog(item, query, mount) as (_, connection):
        months = tuple(
            month
            for (month,) in connection.execute(
                "SELECT DISTINCT strftime('%Y-%m', valid_time, 'unixepoch') "
                "FROM observations WHERE variable = ? ORDER BY 1",
                (query.variable,),
            )
        )
        if not months:
            raise RasterConflictError(
                "No observations are available for this variable."
            )
        selected_month = query.month if query.month is not None else months[-1]
        year, month = map(int, selected_month.split("-"))
        start = datetime(year, month, 1, tzinfo=timezone.utc)
        end = datetime(year + month // 12, month % 12 + 1, 1, tzinfo=timezone.utc)
        times = tuple(
            observation_datetime(time)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
            for (time,) in connection.execute(
                "SELECT valid_time FROM observations WHERE variable = ? "
                "AND valid_time >= ? AND valid_time < ? ORDER BY valid_time",
                (query.variable, start.timestamp(), end.timestamp()),
            )
        )
    return TemporalTimeChoices(months, selected_month, times)
