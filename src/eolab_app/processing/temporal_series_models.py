"""Describe a per-observation area summary and its downloadable CSV."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from eolab_app.catalog_selection import VectorSelection
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.models import Artifact
from eolab_app.polygon_areas import PolygonAreaReference
from eolab_app.processing.temporal_grid import TemporalReadGrid
from eolab_app.sampling_box import Wgs84SamplingBox
from eolab_app.raster.models import Wgs84Bounds
from eolab_app.raster.source_models import TemporalIntervalSelection

AreaStatistic = Literal["count", "sum", "mean", "min", "max", "stdev"]
"""Exact spatial statistics supported by the existing scalar calculation engine."""


class TemporalSeriesRequest(BaseModel):
    """Capture a variable, period and statistic for the model's validated area.

    The model input contract and area binder supply exactly one area choice.
    This internal request does not impose additional limits on the calculation.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    source: TemporalIntervalSelection
    statistic: AreaStatistic
    selectedBounds: Wgs84Bounds | None = None
    samplingBox: Wgs84SamplingBox | None = None
    catalogSelection: VectorSelection | None = None
    polygonArea: PolygonAreaReference | None = None
    wholeRaster: Literal[True] | None = None


class QueuedTemporalSeries(BaseModel):
    """Retain the submitted choices and owned polygons until a worker is available."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["temporal.series.v1"] = "temporal.series.v1"
    request: TemporalSeriesRequest
    polygonArea: AggregateArea | None = None


class TemporalSeriesSpec(BaseModel):
    """Store the path-free area plan, source support and actual observation coverage.

    File locations stay in worker memory. Each observation is summarized
    independently in its original units; count reports cells instead.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["temporal.series.v1"] = "temporal.series.v1"
    source: TemporalIntervalSelection
    statistic: AreaStatistic
    area: AggregateArea
    grid: TemporalReadGrid
    unit: str
    timeSupport: Literal["instantaneous", "mean_rate", "accumulation"]
    observationCount: int
    firstObservation: datetime
    lastObservation: datetime


@dataclass(frozen=True)
class TemporalSeriesArtifact(Artifact):
    """Identify the completed CSV and the number of observation rows it contains."""

    row_count: int
    result_name: str = field(default="result.csv", kw_only=True)
    media_type: str = field(default="text/csv", kw_only=True)
