"""Physical storage headroom at the worker artifact boundary."""

from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.models import ProcessingError, ProcessingLimits


def test_prepare_does_not_scan_retained_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Preparing a job ignores retained file totals and never walks storage.

    Args:
        tmp_path: Isolated private result volume.
        monkeypatch: Controlled free space and a forbidden directory traversal.
    """
    artifacts = LocalJobArtifacts(tmp_path)
    artifacts.initialize()
    for parent in ("attempts", "results"):
        retained = tmp_path / parent / ("a" * 32)
        retained.mkdir()
        (retained / "result.csv").write_bytes(b"x" * 20)

    def reject_scan(path: object) -> None:
        """Fail if preparation tries to enumerate the result volume.

        Args:
            path: Requested directory.

        Raises:
            AssertionError: Any directory enumeration is a regression.
        """
        raise AssertionError("Preparation must not scan retained outputs")

    monkeypatch.setattr("os.scandir", reject_scan)
    monkeypatch.setattr(
        "eolab_app.processing.artifacts.shutil.disk_usage",
        lambda path: SimpleNamespace(free=100),
    )
    limits = replace(ProcessingLimits(), free_space_floor=15, max_stored_bytes=8)
    assert artifacts.prepare("b" * 32, 5, limits).is_dir()


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


def test_prepare_fails_if_free_space_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Do not start a write when physical free space cannot be checked.

    Args:
        tmp_path: Isolated private result volume.
        monkeypatch: Simulated unavailable disk headroom.
    """
    artifacts = LocalJobArtifacts(tmp_path)
    artifacts.initialize()

    def unavailable(path: object) -> None:
        """Reject a free-space query as an unavailable filesystem would.

        Args:
            path: Requested volume.

        Raises:
            OSError: Filesystem headroom is unavailable.
        """
        raise OSError("free space unavailable")

    monkeypatch.setattr("eolab_app.processing.artifacts.shutil.disk_usage", unavailable)
    with pytest.raises(OSError, match="free space unavailable"):
        artifacts.prepare("a" * 32, 1, ProcessingLimits())
    assert not (tmp_path / "attempts" / ("a" * 32)).exists()
