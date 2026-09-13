"""Environment boundary and startup validation for Job service deployment limits."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from job_service.app import create_app
from job_service.configuration import Settings, load_settings

LIMITS = {
    "JOBS_QUEUE_CAPACITY": ("queue_capacity", "4"),
    "JOBS_RECORD_CAPACITY": ("record_capacity", "12"),
    "JOBS_RETENTION_SECONDS": ("retention_seconds", "120"),
    "JOBS_EXECUTION_TIMEOUT_SECONDS": ("execution_seconds", "7.5"),
    "JOBS_QUEUE_TIMEOUT_SECONDS": ("queue_seconds", "9"),
    "JOBS_MAX_TIMEOUT_SECONDS": ("max_timeout_seconds", "15"),
}


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Clear configured limits and credentials for each configuration test.

    Args:
        monkeypatch: Isolated environment fixture.
    """
    for name in (*LIMITS, "JOBS_CALLERS"):
        monkeypatch.delenv(name, raising=False)


def test_defaults_and_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    """Load all six limits from deployment settings while retaining defaults.

    Args:
        monkeypatch: Environment fixture.
    """
    assert load_settings() == Settings()
    for name, (_, value) in LIMITS.items():
        monkeypatch.setenv(name, value)
    loaded = load_settings()
    for name, (attribute, value) in LIMITS.items():
        assert getattr(loaded, attribute) == float(value)
    with TestClient(create_app()) as client:
        assert client.get("/api/jobs/health").status_code == 200


@pytest.mark.parametrize("name", LIMITS)
@pytest.mark.parametrize("value", ["", "oops", "0", "-1", "nan", "inf", "100000"])
def test_invalid_limits_fail_application_creation(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    """Reject malformed and unsafe settings before the application can start.

    Args:
        monkeypatch: Environment fixture.
        name: Deployment variable.
        value: Invalid text or out-of-range number.
    """
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError):
        create_app()


def test_relationships_and_integer_capacity(monkeypatch: pytest.MonkeyPatch) -> None:
    """Validate relationships after parsing, including programmatic settings.

    Args:
        monkeypatch: Environment fixture.
    """
    monkeypatch.setenv("JOBS_QUEUE_CAPACITY", "1.5")
    with pytest.raises(ValueError, match="JOBS_QUEUE_CAPACITY"):
        load_settings()
    monkeypatch.delenv("JOBS_QUEUE_CAPACITY")
    monkeypatch.setenv("JOBS_RECORD_CAPACITY", "32")
    with pytest.raises(ValueError, match="exceed queue_capacity"):
        load_settings()
    monkeypatch.delenv("JOBS_RECORD_CAPACITY")
    monkeypatch.setenv("JOBS_MAX_TIMEOUT_SECONDS", "20")
    with pytest.raises(ValueError, match="Default queue/execution"):
        load_settings()
    with pytest.raises(ValueError, match="queue_capacity"):
        Settings(queue_capacity=True)


def test_compose_and_environment_template_cover_limits() -> None:
    """Preserve each external-to-internal mapping and blank-value validation."""
    root = Path(__file__).parents[1]
    compose = (root / "docker-compose.yml").read_text()
    example = (root / ".env.example").read_text()
    for name in LIMITS:
        assert f"{name}: ${{EOLAB_{name}-" in compose
        assert f"EOLAB_{name}=" in example


def test_compose_shares_one_eolab_credential() -> None:
    """Wire the app and service to one deployment input, with no duplicate key."""
    root = Path(__file__).parents[1]
    compose = (root / "docker-compose.yml").read_text()
    example = (root / ".env.example").read_text()
    jobs, app = compose.split("  jobs:\n", 1)[1].split("  app:\n", 1)
    assert 'JOBS_CALLERS: \'{"eolab":"${EOLAB_JOBS_TOKEN-}"}\'' in jobs
    assert '"JOBS_TOKEN=${EOLAB_JOBS_TOKEN-}"' in app
    assert example.count("EOLAB_JOBS_TOKEN=") == 1
    for obsolete in ("EOLAB_JOBS_CALLERS", "EOLAB_VECTOR_OUTLINE_JOBS_TOKEN"):
        assert obsolete not in compose
        assert obsolete not in example


def test_injected_settings_do_not_read_unrelated_host_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep embedded/test construction deterministic without changing deployment loading.

    Args:
        monkeypatch: Environment fixture.
    """
    monkeypatch.setenv("JOBS_QUEUE_CAPACITY", "invalid-host-value")
    with pytest.raises(ValueError, match="JOBS_QUEUE_CAPACITY"):
        create_app()
    with TestClient(create_app(Settings())) as client:
        assert client.get("/api/jobs/health").status_code == 200
