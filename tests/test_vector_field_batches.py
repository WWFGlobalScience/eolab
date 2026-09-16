"""Exercise the OGR field reader against real format and stream boundaries."""

from dataclasses import replace
from pathlib import Path
from threading import Event
from typing import Any

import fiona
from osgeo import ogr
import pytest

from eolab_app.vector import fields as field_module
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.fields import OgrVectorFieldReader
from eolab_app.vector.filters import VectorFilter
from eolab_app.vector.models import ResolvedVectorSource


@pytest.fixture(params=["geopackage", "shapefile"])
def batch_source(
    tmp_path: Path, request: pytest.FixtureRequest
) -> ResolvedVectorSource:
    """Write enough mixed scalar rows to cross the production batch boundary.

    Args:
        tmp_path: Isolated fixture directory.
        request: Selected supported vector format.

    Returns:
        Exact read-only source descriptor for the fixture.
    """
    is_gpkg = request.param == "geopackage"
    path = tmp_path / ("attributes.gpkg" if is_gpkg else "attributes.shp")
    with fiona.open(
        path,
        "w",
        driver="GPKG" if is_gpkg else "ESRI Shapefile",
        layer="attributes",
        crs="EPSG:4326",
        encoding="UTF-8",
        schema={
            "geometry": "Point",
            "properties": {
                "number": "int64",
                "score": "float",
                "label": "str",
                "observed": "date",
                "ignored": "str",
            },
        },
    ) as dataset:
        dataset.writerecords(
            {
                "geometry": {"type": "Point", "coordinates": (1, 2)},
                "properties": {
                    "number": 2**40 + index,
                    "score": None if index % 3 == 0 else index / 10,
                    "label": None if index % 3 == 0 else "caf\u00e9",
                    "observed": None if index % 3 == 0 else "2026-09-15",
                    "ignored": "not requested",
                },
            }
            for index in range(4101)
        )
    return ResolvedVectorSource(
        source_kind="mounted",
        source_format=request.param,
        source_path=path,
        asset_key="data",
        layer_name="attributes" if is_gpkg else None,
    )


@pytest.mark.parametrize("limit", [1, 4095, 4096, 4100, 4101, 4102])
def test_batch_prefix_and_exact_exhaustion(
    batch_source: ResolvedVectorSource,
    limit: int,
) -> None:
    """Preserve row order, large integers, and exhaustion at either side of a cap.

    Args:
        batch_source: Real mounted GPKG or Shapefile.
        limit: Cap before, on, or after a batch/source boundary.
    """
    result = OgrVectorFieldReader().read_numbers(batch_source, "number", limit, Event())
    count = min(limit, 4101)
    assert result.values == tuple(float(2**40 + index) for index in range(count))
    assert result.scanned_feature_count == count
    assert result.complete is (limit >= 4101)


def test_nullable_scalars_and_empty_field_counts(
    batch_source: ResolvedVectorSource,
) -> None:
    """Keep nulls distinct from zero, decode UTF-8, and count zero-column reads.

    Args:
        batch_source: Real mounted GPKG or Shapefile.
    """
    reader = OgrVectorFieldReader()
    numbers = reader.read_numbers(batch_source, "score", 5000, Event())
    assert numbers.null_count == 1367
    assert numbers.values == tuple(index / 10 for index in range(4101) if index % 3)
    categories = reader.read_categories(batch_source, "label", 5000, Event())
    assert categories.counts == (("caf\u00e9", 2734),)
    assert categories.null_count == 1367
    dates = reader.count_filter(
        batch_source,
        VectorFilter(
            enabled=True,
            rules=[
                {"field": "observed", "operator": "eq", "value": "2026-09-15"},
            ],
        ),
        5000,
        Event(),
    )
    assert dates.complete and dates.matched == 2734 and dates.total == 4101
    whole = reader.count_filter(batch_source, VectorFilter(), 4101, Event())
    assert whole.complete and whole.matched == whole.total == 4101


def test_native_batches_exclude_geometry_and_unselected_fields(
    batch_source: ResolvedVectorSource,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Observe real batch buffers instead of accepting a per-feature substitute.

    Args:
        batch_source: Real mounted GPKG or Shapefile.
        monkeypatch: Scoped OGR stream instrumentation.
    """
    original = ogr.Layer.GetArrowStreamAsNumPy
    sizes: list[int] = []

    def observe(layer: ogr.Layer, options: list[str]) -> Any:
        """Instrument the real stream while preserving its lifetime.

        Args:
            layer: Native source layer.
            options: Production stream options.

        Returns:
            Original context-managed stream with an observed batch read.
        """
        stream = original(layer, options)
        read = stream.GetNextRecordBatch

        def next_batch() -> Any:
            """Read and record one native batch.

            Returns:
                Unmodified NumPy columns or None at EOF.
            """
            batch = read()
            if batch is not None:
                assert set(batch) == {"number"}
                sizes.append(len(batch["number"]))
            return batch

        stream.GetNextRecordBatch = next_batch
        return stream

    monkeypatch.setattr(ogr.Layer, "GetArrowStreamAsNumPy", observe)
    result = OgrVectorFieldReader().read_numbers(batch_source, "number", 5000, Event())
    assert result.complete
    assert sizes == [4096, 5]


def test_cancel_during_batch_releases_stream(
    batch_source: ResolvedVectorSource,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop callbacks immediately and allow a fresh read after cancellation.

    Args:
        batch_source: Real mounted GPKG or Shapefile.
        monkeypatch: Scoped filter callback instrumentation.
    """
    cancel = Event()
    visited = 0

    def cancel_during_visit(
        candidate: VectorFilter, properties: dict[str, Any]
    ) -> bool:
        """Cancel after the first row of the second batch.

        Args:
            candidate: Validated predicate.
            properties: Selected row properties.

        Returns:
            True for the observed row.
        """
        nonlocal visited
        visited += 1
        if visited == 4097:
            cancel.set()
        return True

    monkeypatch.setattr(field_module, "matches_filter", cancel_during_visit)
    reader = OgrVectorFieldReader()
    result = reader.count_filter(batch_source, VectorFilter(), 5000, cancel)
    assert not result.complete and result.total is None
    assert visited == 4097
    assert reader.read_numbers(batch_source, "number", 5000, Event()).complete


def test_missing_sources_and_fields_keep_conflict_contract(
    batch_source: ResolvedVectorSource,
) -> None:
    """Translate native failures without silently selecting a different layer.

    Args:
        batch_source: Real mounted GPKG or Shapefile.
    """
    reader = OgrVectorFieldReader()
    with pytest.raises(VectorConflictError, match="selected field"):
        reader.read_numbers(batch_source, "missing", 10, Event())
    with pytest.raises(VectorConflictError, match="could not be read safely"):
        reader.read_numbers(
            replace(batch_source, layer_name="missing"), "number", 10, Event()
        )
    with pytest.raises(VectorConflictError, match="could not be read safely"):
        reader.read_numbers(
            replace(
                batch_source,
                source_path=batch_source.source_path.with_name("missing.gpkg"),
            ),
            "number",
            10,
            Event(),
        )
    with pytest.raises(ValueError, match="positive"):
        reader.read_numbers(batch_source, "number", 0, Event())


def test_empty_layer_is_complete(tmp_path: Path) -> None:
    """Distinguish a valid empty source from an unreadable layer.

    Args:
        tmp_path: Isolated source directory.
    """
    path = tmp_path / "empty.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="empty",
        schema={"geometry": "Point", "properties": {"number": "int"}},
    ):
        pass
    source = ResolvedVectorSource("mounted", "geopackage", path, "data", "empty")
    result = OgrVectorFieldReader().read_numbers(source, "number", 10, Event())
    assert result.complete and result.scanned_feature_count == 0


def test_boolean_and_binary_values_keep_their_types(tmp_path: Path) -> None:
    """Keep booleans distinct from numbers and binary values distinct from text.

    Args:
        tmp_path: Isolated source directory.
    """
    path = tmp_path / "types.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="types",
        schema={"geometry": "Point", "properties": {"flag": "bool", "blob": "bytes"}},
    ) as dataset:
        dataset.writerecords(
            {
                "geometry": None,
                "properties": {"flag": flag, "blob": blob},
            }
            for flag, blob in [(True, b"text"), (False, b"other"), (None, None)]
        )
    source = ResolvedVectorSource("mounted", "geopackage", path, "data", "types")
    reader = OgrVectorFieldReader()
    flags = reader.read_categories(source, "flag", 10, Event())
    assert flags.counts == ((False, 1), (True, 1))
    assert all(type(value) is bool for value, _ in flags.counts)
    assert flags.null_count == 1
    numeric = reader.read_numbers(source, "flag", 10, Event())
    assert numeric.values == () and numeric.unsupported_value_count == 2
    binary = reader.read_categories(source, "blob", 10, Event())
    assert binary.counts == () and binary.unsupported_value_count == 2
    assert binary.null_count == 1


def test_native_read_error_releases_stream(
    batch_source: ResolvedVectorSource,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Translate a mid-stream failure and release native stream ownership.

    Args:
        batch_source: Real mounted GPKG or Shapefile.
        monkeypatch: Scoped native read failure injection.
    """
    original = ogr.Layer.GetArrowStreamAsNumPy
    streams: list[Any] = []

    def fail_after_first_batch(layer: ogr.Layer, options: list[str]) -> Any:
        """Wrap a real stream with a failure after its first native read.

        Args:
            layer: Native source layer.
            options: Production stream options.

        Returns:
            Original stream with an injected read failure.
        """
        stream = original(layer, options)
        streams.append(stream)
        read = stream.GetNextRecordBatch
        calls = 0

        def next_batch() -> Any:
            """Return the first real batch and fail the next read.

            Returns:
                First batch of NumPy columns.

            Raises:
                RuntimeError: After one successful batch.
            """
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("injected native I/O failure")
            return read()

        stream.GetNextRecordBatch = next_batch
        return stream

    with monkeypatch.context() as patch:
        patch.setattr(ogr.Layer, "GetArrowStreamAsNumPy", fail_after_first_batch)
        with pytest.raises(VectorConflictError, match="could not be read safely"):
            OgrVectorFieldReader().read_numbers(batch_source, "number", 5000, Event())
    assert streams[0].stream is None
    assert (
        OgrVectorFieldReader()
        .read_numbers(batch_source, "number", 5000, Event())
        .complete
    )
