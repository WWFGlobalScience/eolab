"""Operation-owned, streaming grouping of an admitted native block rectangle."""

from collections.abc import Iterator
from math import ceil

from rasterio.windows import Window

from eolab_app.processing.aggregate_models import AggregateExecutionPlan


def block_extent(
    window: Window, block_shape: tuple[int, int]
) -> tuple[int, int, int, int]:
    """Find the exclusive native block rectangle already admitted for a selection.

    Args:
        window: Integral, nonempty selection inside the source.
        block_shape: Native block height and width.

    Returns:
        First column, first row, exclusive last column and exclusive last row.
    """
    bh, bw = block_shape
    return (
        int(window.col_off) // bw,
        int(window.row_off) // bh,
        ceil((window.col_off + window.width) / bw),
        ceil((window.row_off + window.height) / bh),
    )


def execution_plan(
    window: Window,
    block_shape: tuple[int, int],
    source_width: int,
    source_height: int,
    target: int | None,
    tile_side: int,
) -> AggregateExecutionPlan:
    """Expand width first, then height, without enlarging admitted block coverage.

    Args:
        window: Integral admitted selection inside the source.
        block_shape: Native block height and width.
        source_width: Full source width for clipping edge blocks.
        source_height: Full source height for clipping edge blocks.
        target: Total target pixels, or None for one-block legacy reads.
        tile_side: Existing tile ceiling; 64 keeps the geometry fallback bounded.

    Returns:
        Maximum effective dimensions and exact read count for this selection.
    """
    c0, r0, c1, r1 = block_extent(window, block_shape)
    bh, bw = block_shape
    columns = min(c1 - c0, max(1, target // (bh * bw))) if target else 1
    rows = min(r1 - r0, max(1, target // (columns * bw * bh))) if target else 1
    width = min(columns * bw, source_width - c0 * bw)
    height = min(rows * bh, source_height - r0 * bh)
    if target is None:
        ew, eh = min(tile_side, width), min(tile_side, height)
    elif tile_side == 64:
        ew = min(tile_side, width, target)
        eh = min(tile_side, height, max(1, target // ew))
    else:
        ew = min(width, target)
        eh = min(height, max(1, target // ew))
    return AggregateExecutionPlan(
        targetChunkPixels=target,
        readWidth=width,
        readHeight=height,
        evaluationWidth=ew,
        evaluationHeight=eh,
        readWindows=ceil((c1 - c0) / columns) * ceil((r1 - r0) / rows),
    )


def iter_raster_read_windows(
    window: Window,
    block_shape: tuple[int, int],
    source_width: int,
    source_height: int,
    plan: AggregateExecutionPlan,
) -> Iterator[tuple[Window, int]]:
    """Yield nonoverlapping raster read windows without reading pixel values.

    Args:
        window: The original admitted selection.
        block_shape: Native block height and width.
        source_width: Full source width.
        source_height: Full source height.
        plan: Read dimensions from the raster batch plan.

    Yields:
        A source-edge-clipped window and the number of native blocks it covers.
    """
    c0, r0, c1, r1 = block_extent(window, block_shape)
    bh, bw = block_shape
    columns, rows = ceil(plan.readWidth / bw), ceil(plan.readHeight / bh)
    for row in range(r0, r1, rows):
        for col in range(c0, c1, columns):
            nc, nr = min(columns, c1 - col), min(rows, r1 - row)
            yield Window(
                col * bw,
                row * bh,
                min(nc * bw, source_width - col * bw),
                min(nr * bh, source_height - row * bh),
            ), nc * nr
