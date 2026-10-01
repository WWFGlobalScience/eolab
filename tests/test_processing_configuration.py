"""Shared app/worker configuration for durable Processing queue and storage limits."""

from pathlib import Path
import pytest

from eolab_app.main import create_app
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.settings import load_processing_limits

OVERRIDES = {
    "PROCESSING_WORKER_COUNT": ("worker_count", 2),
    "PROCESSING_PROCESS_MEMORY_BYTES": ("process_memory_bytes", 1024**3),
    "PROCESSING_MAX_EXECUTION_MEMORY_BYTES": (
        "max_execution_memory_bytes",
        4 * 1024**3,
    ),
    "PROCESSING_MAX_WAITING_JOBS": ("max_waiting_jobs", 64),
    "PROCESSING_MAX_OWNER_WAITING_JOBS": ("max_owner_waiting_jobs", 16),
    "PROCESSING_MAX_JOB_RECORDS": ("max_job_records", 512),
    "PROCESSING_MAX_STORED_BYTES": ("max_stored_bytes", 5 * 1024**3),
    "PROCESSING_FREE_SPACE_FLOOR_BYTES": ("free_space_floor", 0),
    "PROCESSING_EXECUTION_TIMEOUT_SECONDS": ("runtime_seconds", 120),
    "PROCESSING_RESULT_TTL_SECONDS": ("result_ttl_seconds", 3600),
}


@pytest.fixture(autouse=True)
def isolated_processing_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep developer deployment overrides out of configuration tests.

    Args:
        monkeypatch: Restores the original environment after each test.
    """
    for name in OVERRIDES:
        monkeypatch.delenv(name, raising=False)


def test_defaults_and_all_environment_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Preserve defaults while allowing operators to size independent budgets.

    Args:
        monkeypatch: Supplies explicit deployment settings.
    """
    assert load_processing_limits() == RasterClipLimits()
    for name, (_, value) in OVERRIDES.items():
        monkeypatch.setenv(name, str(value))
    limits = load_processing_limits()
    for attribute, value in OVERRIDES.values():
        assert getattr(limits, attribute) == value


@pytest.mark.parametrize(
    "name,value",
    [
        ("PROCESSING_WORKER_COUNT", "0"),
        ("PROCESSING_WORKER_COUNT", "33"),
        ("PROCESSING_PROCESS_MEMORY_BYTES", "1"),
        ("PROCESSING_MAX_EXECUTION_MEMORY_BYTES", str(1024**3)),
        ("PROCESSING_MAX_WAITING_JOBS", ""),
        ("PROCESSING_MAX_OWNER_WAITING_JOBS", "0"),
        ("PROCESSING_MAX_JOB_RECORDS", "1.5"),
        ("PROCESSING_MAX_STORED_BYTES", str(2**63)),
        ("PROCESSING_FREE_SPACE_FLOOR_BYTES", "-1"),
        ("PROCESSING_EXECUTION_TIMEOUT_SECONDS", "oops"),
        ("PROCESSING_RESULT_TTL_SECONDS", "0"),
        ("PROCESSING_RESULT_TTL_SECONDS", "31536001"),
    ],
)
def test_bad_budget_names_its_variable_before_app_starts(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: str,
) -> None:
    """Fail startup instead of silently using defaults or failing on first submit.

    Args:
        configured_environment: Otherwise valid app configuration.
        version_file_path: Existing version file.
        monkeypatch: Supplies an invalid Processing override.
        name: Environment variable under test.
        value: Invalid setting text.
    """
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=name):
        create_app(version_file_path)


def test_compose_shares_each_budget_with_app_and_worker() -> None:
    """Keep both processes on the same deployment policy, with strict blank handling."""
    root = Path(__file__).parents[1]
    compose = (root / "docker-compose.yml").read_text()
    example = (root / ".env.example").read_text()
    worker = compose.split("  processing-worker:\n", 1)[1].split("  jobs:\n", 1)[0]
    app = compose.split("  app:\n", 1)[1].split("\nvolumes:", 1)[0]
    defaults = RasterClipLimits()
    for name, (attribute, _) in OVERRIDES.items():
        value = getattr(defaults, attribute)
        entry = f'"{name}=${{EOLAB_{name}-{value}}}"'
        assert entry in worker and entry in app
        assert f"EOLAB_{name}={value}" in example
