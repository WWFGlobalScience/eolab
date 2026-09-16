"""Bounded geometry-free OGR batch field reads for vector styling."""

from collections.abc import Callable, Mapping
from time import monotonic
from eolab_app.vector.filters import VectorFilter, VectorFilterCount, matches_filter
from dataclasses import dataclass
from datetime import date
from math import isfinite
from threading import Event
from typing import Any

from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import (
    ResolvedVectorSource,
    VECTOR_CATEGORY_TEXT_LIMIT,
    VectorCategoryRead,
    VectorCategoryScalar,
    VectorNumericRead,
)


_UNSUPPORTED = object()
_FIELD_BATCH_SIZE = 4096


@dataclass(frozen=True)
class _BoundedFieldValues:
    """Raw values and completion state from one neutral bounded field read."""

    values: tuple[Any, ...]
    complete: bool


class OgrVectorFieldReader:
    """Read bounded scalar properties from exact mounted vector layers."""

    def read_categories(
        self,
        source: ResolvedVectorSource,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorCategoryRead:
        """Count safe typed category values without reading geometry.

        Args:
            source: Catalog-derived exact mounted source and native layer.
            field: Authoritative attribute field identity.
            feature_limit: Maximum features whose values may be counted.
            cancel_event: Cooperative cancellation signal checked per feature.

        Returns:
            Deterministically ordered bounded counts and completion metadata.

        Raises:
            VectorConflictError: If the source format, layer, or field cannot
                satisfy the field-summary contract.
        """
        bounded = self._read_values(source, field, feature_limit, cancel_event)
        counts: dict[tuple[type[Any], Any], list[Any]] = {}
        null_count = 0
        unsupported_value_count = 0
        for value in bounded.values:
            if value is None:
                null_count += 1
                continue
            category_value = _bounded_category_value(value)
            if category_value is _UNSUPPORTED:
                unsupported_value_count += 1
                continue
            identity = (type(category_value), category_value)
            entry = counts.get(identity)
            if entry is None:
                counts[identity] = [category_value, 1]
            else:
                entry[1] += 1
        ordered_counts = sorted(
            ((entry[0], entry[1]) for entry in counts.values()),
            key=lambda entry: (-entry[1], _category_sort_key(entry[0])),
        )
        return VectorCategoryRead(
            counts=tuple(ordered_counts),
            scanned_feature_count=len(bounded.values),
            null_count=null_count,
            unsupported_value_count=unsupported_value_count,
            complete=bounded.complete,
        )

    def read_numbers(
        self,
        source: ResolvedVectorSource,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorNumericRead:
        """Collect finite numeric values without reading geometry.

        Args:
            source: Catalog-derived exact mounted source and native layer.
            field: Authoritative numeric attribute field identity.
            feature_limit: Maximum features whose values may be inspected.
            cancel_event: Cooperative cancellation signal checked per feature.

        Returns:
            Bounded finite values, missing/unsupported counts, and completion.

        Raises:
            VectorConflictError: If the source format, layer, or field cannot
                satisfy the field-summary contract.
        """
        bounded = self._read_values(source, field, feature_limit, cancel_event)
        values: list[float] = []
        null_count = 0
        unsupported_value_count = 0
        for value in bounded.values:
            if value is None:
                null_count += 1
            elif type(value) in {int, float} and isfinite(value):
                values.append(float(value))
            else:
                unsupported_value_count += 1
        return VectorNumericRead(
            values=tuple(values),
            scanned_feature_count=len(bounded.values),
            null_count=null_count,
            unsupported_value_count=unsupported_value_count,
            complete=bounded.complete,
        )

    def _read_values(
        self,
        source: ResolvedVectorSource,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> _BoundedFieldValues:
        """Read one exact property through the shared bounded mechanism.

        Args:
            source: Catalog-derived exact mounted source and native layer.
            field: Authoritative attribute field identity.
            feature_limit: Maximum features whose values may be inspected.
            cancel_event: Cooperative cancellation signal checked per feature.

        Returns:
            Raw bounded property values and source-exhaustion state.

        Raises:
            ValueError: If ``feature_limit`` is not positive.
            VectorConflictError: If the source or selected field cannot be read.
        """
        values: list[Any] = []
        complete = self._visit_properties(
            source, (field,), feature_limit, cancel_event,
            lambda properties: values.append(properties.get(field)),
        )
        return _BoundedFieldValues(values=tuple(values), complete=complete)

    def count_filter(
        self, source: ResolvedVectorSource, candidate: VectorFilter,
        feature_limit: int, cancel_event: Event,
    ) -> VectorFilterCount:
        """Count an entire filtered view without retaining feature data.

        Args:
            source: Exact Catalog-derived mounted source.
            candidate: Validated scalar predicate.
            feature_limit: Maximum rows visited, plus one exhaustion probe.
            cancel_event: Cooperative cancellation checked per row.

        Returns:
            Exact matched/total counts only when the bounded read is complete.
        """
        total = matched = 0
        deadline = monotonic() + 20

        def visit(properties: Mapping[str, Any]) -> None:
            """Accumulate counts and enforce the time budget.

            Args:
                properties: Selected scalar properties from one row.

            Returns:
                None.
            """
            nonlocal total, matched
            total += 1
            matched += int(matches_filter(candidate, properties))
            if monotonic() >= deadline:
                cancel_event.set()

        complete = self._visit_properties(
            source, tuple(dict.fromkeys(rule.field for rule in candidate.rules)),
            feature_limit, cancel_event, visit,
        )
        return VectorFilterCount(matched=matched, total=total, complete=True) if complete else VectorFilterCount()

    def _visit_properties(
        self,
        source: ResolvedVectorSource,
        fields: tuple[str, ...],
        feature_limit: int,
        cancel_event: Event,
        visit: Callable[[Mapping[str, Any]], None],
    ) -> bool:
        """Visit scalar properties in bounded, geometry-free OGR batches.

        The callback sees at most feature_limit rows in native source order.
        One additional row determines exhaustion. Native reads may prefetch the
        rest of that row's batch, bounded by 4,096 rows; only one batch is held.
        Cancellation is checked before each native read and each callback.

        Args:
            source: Catalog-derived mounted file and exact native layer.
            fields: Unique authoritative non-geometry fields.
            feature_limit: Maximum visited rows.
            cancel_event: Cooperative cancellation signal.
            visit: Owner-provided scalar accumulator; must not retain geometry.

        Returns:
            Whether the source was exhausted without cancellation.

        Raises:
            ValueError: If the feature limit is not positive.
            VectorConflictError: If the source, layer, or fields cannot be read.
        """
        if (
            source.source_kind != "mounted"
            or source.source_path is None
            or source.source_format not in {"shapefile", "geopackage"}
        ):
            raise VectorConflictError(
                "Field summary unavailable: unsupported mounted layer."
            )
        if feature_limit < 1:
            raise ValueError("feature_limit must be positive")
        # Keep native OGR loading local to field reads, including in spawned
        # Processing interpreters that import application modules.
        from osgeo import gdal, ogr

        try:
            with gdal.ExceptionMgr(), ogr.ExceptionMgr():
                with gdal.OpenEx(
                    str(source.source_path),
                    gdal.OF_VECTOR | gdal.OF_READONLY,
                ) as dataset:
                    layer = (
                        dataset.GetLayerByName(source.layer_name)
                        if source.layer_name is not None
                        else dataset.GetLayer(0)
                    )
                    if layer is None:
                        raise ValueError("The exact source layer is missing")
                    definition = layer.GetLayerDefn()
                    field_types: dict[str, str] = {}
                    for index in range(definition.GetFieldCount()):
                        field_definition = definition.GetFieldDefn(index)
                        field_types[field_definition.GetName()] = (
                            field_definition.GetTypeName()
                        )
                    if any(field not in field_types for field in fields):
                        raise VectorConflictError(
                            "Field summary unavailable: the selected field is "
                            "not present in the current source layer."
                        )
                    layer.SetIgnoredFields(
                        [
                            "OGR_GEOMETRY",
                            *(field for field in field_types if field not in fields),
                        ]
                    )
                    options = [
                        f"MAX_FEATURES_IN_BATCH={min(_FIELD_BATCH_SIZE, feature_limit + 1)}",
                        # With no selected fields the FID supplies the row count.
                        f"INCLUDE_FID={'NO' if fields else 'YES'}",
                    ]
                    visited = 0
                    with layer.GetArrowStreamAsNumPy(options) as stream:
                        while not cancel_event.is_set():
                            batch = stream.GetNextRecordBatch()
                            if batch is None:
                                return not cancel_event.is_set()
                            row_count = len(next(iter(batch.values())))
                            columns = {field: batch[field].tolist() for field in fields}
                            for index in range(row_count):
                                if cancel_event.is_set():
                                    return False
                                if visited == feature_limit:
                                    return False
                                visit(
                                    {
                                        field: _property_value(
                                            columns[field][index], field_types[field]
                                        )
                                        for field in fields
                                    }
                                )
                                visited += 1
                            # Drop buffers before allocating the next batch.
                            del batch, columns
                    return False
        except VectorConflictError:
            raise
        except (RuntimeError, OSError, ValueError) as error:
            raise VectorConflictError(
                "Field summary unavailable: the current vector source "
                "could not be read safely."
            ) from error


def _property_value(value: Any, field_type: str) -> Any:
    """Normalize OGR batch scalars for the existing property consumer contract.

    Args:
        value: Python scalar from a NumPy column, with masked values as None.
        field_type: OGR schema type, distinguishing text from binary values.

    Returns:
        Native Python scalars, UTF-8 text, or an ISO date string.

    Raises:
        UnicodeDecodeError: If a text column contains invalid UTF-8.
    """
    if field_type == "String" and isinstance(value, bytes):
        return value.decode("utf-8")
    if field_type == "Date" and isinstance(value, date):
        return value.isoformat()
    return value


def _bounded_category_value(value: Any) -> VectorCategoryScalar | object:
    """Return one safe strict JSON scalar or the unsupported sentinel.

    Args:
        value: Normalized property value from the selected source field.

    Returns:
        A bounded bool, int, float, or string; otherwise ``_UNSUPPORTED``.
    """
    if type(value) is bool:
        return value
    if type(value) is int:
        return value
    if type(value) is float:
        return value if isfinite(value) else _UNSUPPORTED
    if type(value) is str:
        if len(value) > VECTOR_CATEGORY_TEXT_LIMIT:
            return _UNSUPPORTED
        if any(
            ord(character) < 32 and character not in "\t\n\r"
            for character in value
        ):
            return _UNSUPPORTED
        return value
    return _UNSUPPORTED


def _category_sort_key(value: VectorCategoryScalar) -> tuple[int, str]:
    """Build a deterministic type-aware tie-break key for one category.

    Args:
        value: Validated scalar category value.

    Returns:
        Type rank and stable textual representation.
    """
    type_rank = {bool: 0, int: 1, float: 2, str: 3}[type(value)]
    if type(value) is bool:
        serialized = "1" if value else "0"
    elif type(value) is float:
        serialized = format(value, ".17g")
    else:
        serialized = str(value)
    return type_rank, serialized
