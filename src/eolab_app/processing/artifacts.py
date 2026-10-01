"""Confined private artifact storage, atomic publication, and disk accounting."""

from concurrent.futures import Future
import json
import os
from pathlib import Path
import re
import shutil
import time
from threading import Lock
from typing import Any

from eolab_app.processing.models import ProcessingError, ProcessingLimits


def write_progress(directory: Path, phase: str, complete: int, total: int) -> None:
    """Atomically expose bounded native-kernel progress to its supervisor.

    Args:
        directory: Confined private attempt directory.
        phase: Operation-owned named phase.
        complete: Processed native block count.
        total: Admitted native block count.
    """
    temporary = directory / "progress.tmp"
    temporary.write_text(
        json.dumps({"phase": phase, "completedBlocks": complete, "totalBlocks": total})
    )
    temporary.replace(directory / "progress.json")


class LocalJobArtifacts:
    """Store processing attempts on one persistent volume outside mounted inputs."""

    def __init__(self, root: Path, forbidden_roots: tuple[Path, ...] = ()) -> None:
        """Validate separation before any file operation.

        Args:
            root: Absolute processing-owned volume root.
            forbidden_roots: Source/application roots that must never contain it.

        Raises:
            ValueError: If the volume overlaps another owner's filesystem root.
        """
        if not root.is_absolute():
            raise ValueError("Processing storage must be an absolute path")
        self.root = root.resolve()
        self._usage_lock = Lock()
        self._pending_usage: Future[int] | None = None
        for forbidden in forbidden_roots:
            other = forbidden.resolve()
            if self.root.is_relative_to(other) or other.is_relative_to(self.root):
                raise ValueError(
                    "Processing storage must be separate from source and application roots"
                )

    def initialize(self) -> None:
        """Initialize private directories in the writable worker container.

        Raises:
            OSError: If the configured volume is not writable.
        """
        self.root.mkdir(parents=True, exist_ok=True)
        for name in ("attempts", "results"):
            (self.root / name).mkdir(exist_ok=True)

    def _directory(self, attempt: str, published: bool) -> Path:
        """Resolve a strict internal attempt ID and prove path confinement.

        Args:
            attempt: Worker-generated 32-character hexadecimal attempt ID.
            published: Select finished results rather than private attempts.

        Returns:
            Confined path without following an existing symlink out of storage.

        Raises:
            ValueError: If an ID or resolved path escapes the owned volume.
        """
        if not re.fullmatch(r"[a-f0-9]{32}", attempt):
            raise ValueError("Invalid internal job attempt ID")
        parent = self.root / ("results" if published else "attempts")
        candidate = parent / attempt
        if candidate.resolve().parent != parent or parent.resolve().parent != self.root:
            raise ValueError("Job path escapes its owned storage")
        return candidate

    def prepare(self, attempt: str, reservation: int, limits: ProcessingLimits) -> Path:
        """Check actual disk headroom and create one unique private attempt.

        Args:
            attempt: Fenced worker attempt ID.
            reservation: Admitted worst-case scratch/output byte reservation.
            limits: Free-space floor and global on-disk ceiling.

        Returns:
            Empty attempt directory.

        Raises:
            ProcessingError: If physical disk headroom is insufficient.
        """
        used = self._stored_file_bytes()
        if (
            shutil.disk_usage(self.root).free < reservation + limits.free_space_floor
            or used + reservation > limits.max_stored_bytes
        ):
            raise ProcessingError(
                "storage_full",
                "There is not enough temporary storage for this job.",
                429,
            )
        path = self._directory(attempt, False)
        path.mkdir(exist_ok=False)
        return path

    def _stored_file_bytes(self) -> int:
        """Share an in-progress volume measurement between concurrent workers.

        No completed measurement is retained for future calls. The shared scan
        is a filesystem snapshot, not a reservation: each caller still checks
        its own physical free space, and PostgreSQL serializes disk reservations.
        Errors wake every waiting caller and allow the next call to try again.

        Returns:
            Bytes measured by this call or an overlapping scan of this volume.

        Raises:
            OSError: If the shared volume scan fails.
        """
        with self._usage_lock:
            pending = self._pending_usage
            starts_scan = pending is None
            if pending is None:
                pending = self._pending_usage = Future()
        if not starts_scan:
            return pending.result()
        try:
            total = self._scan_stored_file_bytes()
            pending.set_result(total)
            return total
        except BaseException as error:
            pending.set_exception(error)
            raise
        finally:
            with self._usage_lock:
                self._pending_usage = None

    def _scan_stored_file_bytes(self) -> int:
        """Measure files in the private volume without repeated path metadata reads.

        Count files at the parent/attempt/file depth used by scratch and results,
        including orphaned attempts until cleanup removes them. Directory entries
        supply file types and reuse cached metadata instead of constructing Path
        objects and asking for each file's metadata twice. Concurrent publication
        and cleanup may move/remove directories, as with the previous glob scan;
        database reservations remain the authority for concurrent admission.

        Returns:
            Actual bytes in files at the artifact depth.

        Raises:
            OSError: If storage cannot be inspected, other than a concurrently
                removed file or directory.
        """
        total = 0
        with os.scandir(self.root) as parents:
            for parent in parents:
                if not parent.is_dir():
                    continue
                try:
                    with os.scandir(parent.path) as attempts:
                        for attempt in attempts:
                            if not attempt.is_dir():
                                continue
                            try:
                                with os.scandir(attempt.path) as entries:
                                    for entry in entries:
                                        try:
                                            if entry.is_file():
                                                total += entry.stat().st_size
                                        except FileNotFoundError:
                                            continue
                            except FileNotFoundError:
                                continue
                except FileNotFoundError:
                    continue
        return total

    def publish(self, attempt: str, reservation: int) -> None:
        """Atomically rename a closed, validated attempt on the same volume.

        Args:
            attempt: Fenced attempt whose native operation completed successfully.
            reservation: Admitted scratch/output ceiling, checked before publish.

        Raises:
            ProcessingError: If the completed output exceeds its reservation.
            OSError: If atomic publication fails.
        """
        path = self._directory(attempt, False)
        size = sum(child.stat().st_size for child in path.iterdir() if child.is_file())
        if size > reservation:
            raise ProcessingError(
                "output_too_large",
                "The completed result exceeds its storage reservation.",
                413,
            )
        path.replace(self._directory(attempt, True))

    def result_path(
        self, attempt: str, provenance: bool = False, result_name: str = "result.tif"
    ) -> Path:
        """Locate a finished file after the caller verifies owner and transfer lease.

        Args:
            attempt: Job-owned published attempt ID.
            provenance: Select the immutable provenance JSON instead of GeoTIFF.
            result_name: Server-owned artifact name; defaults for legacy clips.

        Returns:
            Confined, existing artifact path.

        Raises:
            ProcessingError: If the immutable artifact is absent or not a file.
        """
        directory = self._directory(attempt, True)
        if not re.fullmatch(r"result\.[a-z0-9]{1,8}", result_name):
            raise ProcessingError(
                "invalid_artifact", "Invalid processing result descriptor.", 500
            )
        path = directory / ("provenance.json" if provenance else result_name)
        if not path.is_file() or path.resolve().parent != directory:
            raise ProcessingError(
                "result_missing",
                "This clip file is no longer available. Create a new clip.",
                410,
            )
        return path

    def progress(self, attempt: str) -> dict[str, Any]:
        """Read only bounded progress fields from the private child output.

        Args:
            attempt: Current fenced execution ID.

        Returns:
            Latest complete phase/progress record, or an empty mapping.
        """
        try:
            path = self._directory(attempt, False) / "progress.json"
            if path.stat().st_size > 1024:
                return {}
            return json.loads(path.read_text())
        except (OSError, ValueError):
            return {}

    def remove(self, attempt: str) -> None:
        """Remove only one verified attempt after native and transfer leases end.

        Args:
            attempt: Terminal job's strict internal attempt ID.

        Raises:
            OSError: If cleanup failed; the caller must retain its reservation.
        """
        for published in (False, True):
            directory = self._directory(attempt, published)
            if directory.exists():
                shutil.rmtree(directory)

    def remove_orphans(self, retained: set[str], minimum_age_seconds: float) -> None:
        """Reap abandoned attempts only after their maximum possible runtime.

        Args:
            retained: IDs that still own database reservations or transfer leases.
            minimum_age_seconds: Conservative hard-deadline plus exit grace.
        """
        for parent in ("attempts", "results"):
            for path in (self.root / parent).iterdir():
                if (
                    path.name not in retained
                    and re.fullmatch(r"[a-f0-9]{32}", path.name)
                    and path.is_dir()
                    and time.time() - path.stat().st_mtime > minimum_age_seconds
                ):
                    self.remove(path.name)
