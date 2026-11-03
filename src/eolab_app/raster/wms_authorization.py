"""Raster-owned authorization for dynamic public WMS parameters."""

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass

from eolab_app.raster.categorical_sld import build_categorical_raster_sld
from eolab_app.raster.styles import (
    parse_categorical_raster_style,
    parse_categorical_raster_style_json,
)
from eolab_app.rendering.errors import PublishedLayerRequestError


RASTER_WMS_STYLE_NAME = "dynamic-raster"
_STYLE_ENVIRONMENT_KEYS = frozenset(
    {"min", "med", "max", "cmin", "cmed", "cmax"}
)
_STYLE_COLOR_PATTERN = re.compile(r"#[0-9a-fA-F]{6}")
_STYLE_OPACITY_KEYS = frozenset({"amin", "amed", "amax"})
_STYLE_ENVIRONMENT_ERROR = (
    "env must define ordered finite min, med, and max values plus cmin, "
    "cmed, and cmax six-digit hex colors, optionally followed by amin, "
    "amed, and amax finite opacities from 0 through 1"
)


def parse_raster_style_environment(environment: str) -> dict[str, str]:
    """Parse validated substitutions consumed by the dynamic raster SLD.

    Args:
        environment: Untrusted WMS ``env`` query value.

    Returns:
        Exact validated assignment names and serialized values.

    Raises:
        PublishedLayerRequestError: If the dynamic raster style is malformed.
    """
    fields = environment.split(";")
    if len(environment) > 384 or len(fields) not in (6, 9):
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
    assignments = {}
    for field in fields:
        name, separator, value = field.partition(":")
        if separator == "" or name in assignments:
            raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
        assignments[name] = value
    if assignments.keys() not in (
        _STYLE_ENVIRONMENT_KEYS,
        _STYLE_ENVIRONMENT_KEYS | _STYLE_OPACITY_KEYS,
    ):
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
    try:
        thresholds = tuple(
            float(assignments[name]) for name in ("min", "med", "max")
        )
        opacities = tuple(
            float(assignments.get(name, "1")) for name in _STYLE_OPACITY_KEYS
        )
    except ValueError as error:
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR) from error
    if not (
        all(math.isfinite(value) for value in thresholds)
        and all(math.isfinite(value) and 0 <= value <= 1 for value in opacities)
        and thresholds[0] < thresholds[1] < thresholds[2]
        and all(
            _STYLE_COLOR_PATTERN.fullmatch(assignments[name])
            for name in ("cmin", "cmed", "cmax")
        )
    ):
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
    return assignments


def validate_raster_style_environment(environment: str) -> None:
    """Validate the substitutions consumed by the dynamic raster SLD.

    Args:
        environment: Untrusted WMS ``env`` query value.

    Raises:
        PublishedLayerRequestError: If the value does not contain exactly the
            six threshold/color assignments, with either all three bounded
            opacity assignments or none (legacy fully opaque rendering).
    """
    parse_raster_style_environment(environment)


@dataclass(frozen=True)
class PublishedRasterAuthorization:
    """Raster-owned WMS request policy for an authorized published layer."""

    def is_style_authorized(self, style_name: str) -> bool:
        """Accept only the initialized dynamic raster style.

        Args:
            style_name: Public style identity supplied by the client.

        Returns:
            True for the raster rendering style.
        """
        return style_name == RASTER_WMS_STYLE_NAME

    def composite_buffer(self, style_definition: Mapping[str, object] | None) -> int:
        """Return zero because raster appearances do not draw outside their cells.

        Args:
            style_definition: Already authorized raster appearance.

        Returns:
            Zero extra query pixels.
        """
        return 0

    def validate_parameters(
        self,
        operation: str,
        query: Mapping[str, str],
    ) -> None:
        """Validate raster-owned WMS parameters.

        Args:
            operation: Normalized WMS operation.
            query: Normalized, globally bounded query parameters.

        Raises:
            PublishedLayerRequestError: If the requested representation conflicts
                with the operation or the continuous environment is malformed.
        """
        if "raster_style" in query and (operation != "getmap" or "env" in query):
            raise PublishedLayerRequestError(
                "raster_style requires GetMap without a continuous env"
            )
        if "featureid" in query:
            raise PublishedLayerRequestError(
                "featureid is supported only for vector layers"
            )
        if "vector_style" in query:
            raise PublishedLayerRequestError("vector_style is not supported for raster layers")
        if "env" in query:
            validate_raster_style_environment(query["env"])

    def prepare_query(
        self, operation: str, query: list[tuple[str, str]],
    ) -> list[tuple[str, str]]:
        """Translate authorized public identities into an upstream WMS request.

        Args:
            operation: Validated lowercase WMS operation.
            query: Globally bounded and feature-validated public query entries.

        Returns:
            Server-owned upstream query entries with workspace-qualified
            continuous styles or an inline categorical style.

        Raises:
            PublishedLayerRequestError: If the categorical definition is invalid.
        """
        normalized = {name.lower(): value for name, value in query}
        definition = normalized.get("raster_style")
        if definition is None:
            # Global WMS and GeoWebCache identify workspace styles by their full name.
            return [
                (
                    (name, f"eolab:{RASTER_WMS_STYLE_NAME}")
                    if name.lower() in {"style", "styles"} and value
                    else (name, value)
                )
                for name, value in query
            ]
        style = parse_categorical_raster_style_json(definition)
        document = build_categorical_raster_sld(normalized["layers"], style, 1)
        forwarded = [
            (name, value)
            for name, value in query
            if name.lower() not in {"raster_style", "styles", "tiled", "tilesorigin"}
        ]
        return forwarded + [
            ("styles", ""),
            ("sld_body", document.decode("utf-8")),
            ("interpolations", "nearest neighbor"),
        ]

    def composite_interpolation(
        self, style_definition: Mapping[str, object] | None
    ) -> str | None:
        """Describe resampling for an already authorized composite appearance.

        Args:
            style_definition: Categorical definition, or None for a ramp.

        Returns:
            Nearest-neighbor override for categories, otherwise service default.
        """
        return "nearest neighbor" if style_definition is not None else None

    def build_composite_sld(
        self,
        layer_name: str,
        style_name: str,
        style_environment: str | None,
        style_definition: Mapping[str, object] | None,
        opacity: float,
    ) -> bytes:
        """Build one authorized inline raster layer for composite rendering.

        Args:
            layer_name: Current workspace-qualified raster layer identity.
            style_name: Requested dynamic raster style identity.
            style_environment: Ramp environment, mutually exclusive with a table.
            style_definition: Bounded categorical appearance, or None for a ramp.
            opacity: Neutral retained-layer opacity from zero through one.

        Returns:
            Complete single-layer SLD document.

        Raises:
            PublishedLayerRequestError: If the appearance is not a complete
                authorized dynamic raster style.
        """
        if not self.is_style_authorized(style_name):
            raise PublishedLayerRequestError(
                "Composite raster rendering requires its dynamic raster style"
            )
        if style_definition is not None:
            style = parse_categorical_raster_style(style_definition)
            return build_categorical_raster_sld(layer_name, style, opacity)
        assignments = parse_raster_style_environment(style_environment)
        from eolab_app.raster.composite_sld import build_raster_composite_sld

        return build_raster_composite_sld(layer_name, assignments, opacity)
