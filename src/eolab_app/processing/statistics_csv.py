"""Encode statistics results for worker files and subscriber downloads."""

import csv
import io
from typing import Any


def csv_text(value: str) -> str:
    """Keep user-provided labels/expressions inert in spreadsheet applications.

    Args:
        value: Bounded user-provided text field.

    Returns:
        Text escaped against spreadsheet formula interpretation.
    """
    return (
        "'" + value
        if value.lstrip().startswith(("=", "+", "-", "@"))
        or value.startswith(("\t", "\r", "\n"))
        else value
    )


def statistics_csv(rows: list[dict[str, Any]]) -> bytes:
    """Encode a small statistics download with spreadsheet-safe labels.

    Args:
        rows: Validated numerical results carrying the caller's labels.

    Returns:
        UTF-8 CSV bytes matching the calculation's ordinary file format.
    """
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["label", "expression", "value", "value_type", "state", "unit"])
    for row in rows:
        writer.writerow(
            [
                csv_text(row["label"]),
                csv_text(row["expression"]),
                row["value"],
                row["valueType"],
                row["state"],
                row["unit"],
            ]
        )
    return stream.getvalue().encode("utf-8")
