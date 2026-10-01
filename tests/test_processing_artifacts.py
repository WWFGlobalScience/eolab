"""Artifact-volume accounting at the worker storage boundary."""

from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.models import ProcessingError, ProcessingLimits


def test_prepare_counts_retained_and_orphaned_files(tmp_path: Path) -> None:
    """Preserve the disk ceiling across published, active and orphaned attempts.

    Args:
        tmp_path: Isolated private result volume.
    """
    artifacts = LocalJobArtifacts(tmp_path)
    artifacts.initialize()
    expected_bytes = 0
    for index in range(200):
        parent = "results" if index % 2 else "attempts"
        directory = tmp_path / parent / f"{index:032x}"
        directory.mkdir()
        for name, size in (("result.csv", 3), ("provenance.json", 7)):
            (directory / name).write_bytes(b"x" * size)
            expected_bytes += size
    # The established layout counts only files at parent/attempt/file depth.
    (tmp_path / "metadata").write_bytes(b"x" * 100)
    (tmp_path / "results" / "metadata").write_bytes(b"x" * 100)
    (tmp_path / "results" / f"{1:032x}" / "nested-directory").mkdir()
    limits = replace(
        ProcessingLimits(), free_space_floor=0, max_stored_bytes=expected_bytes + 2
    )
    with pytest.raises(ProcessingError) as rejected:
        artifacts.prepare("f" * 32, 3, limits)
    assert rejected.value.code == "storage_full"
    assert not (tmp_path / "attempts" / ("f" * 32)).exists()
    assert artifacts.prepare("f" * 32, 2, limits).is_dir()


def test_prepare_preserves_physical_free_space_floor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Disk reservations still need physical free space above the configured floor.

    Args:
        tmp_path: Isolated private result volume.
        monkeypatch: Controlled disk free-space response.
    """
    artifacts = LocalJobArtifacts(tmp_path)
    artifacts.initialize()
    monkeypatch.setattr(
        "eolab_app.processing.artifacts.shutil.disk_usage",
        lambda path: SimpleNamespace(free=20),
    )
    limits = replace(ProcessingLimits(), free_space_floor=15)
    with pytest.raises(ProcessingError) as rejected:
        artifacts.prepare("a" * 32, 6, limits)
    assert rejected.value.code == "storage_full"
    assert artifacts.prepare("a" * 32, 5, limits).is_dir()


def test_prepare_fails_if_volume_cannot_be_inspected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Do not admit a write based on an incomplete storage measurement.

    Args:
        tmp_path: Isolated private result volume.
        monkeypatch: Simulated unreadable storage.
    """
    artifacts = LocalJobArtifacts(tmp_path)
    artifacts.initialize()

    def denied(path: object) -> None:
        """Reject directory access as an unavailable filesystem would.

        Args:
            path: Requested storage directory.

        Raises:
            PermissionError: Storage cannot be inspected.
        """
        raise PermissionError("unreadable storage")

    monkeypatch.setattr("eolab_app.processing.artifacts.os.scandir", denied)
    with pytest.raises(PermissionError):
        artifacts.prepare("a" * 32, 1, ProcessingLimits())
