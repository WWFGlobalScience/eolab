"""Protect Habitat preparation commands independently of browser Processing sessions."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import Mock, create_autospec

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.catalog_selection import SelectionUnavailableError
from eolab_app.main import create_app
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.service import HABITAT_PREPARATION_OWNER, ProcessingService
from eolab_app.routes.habitat_preparation import create_habitat_preparation_router

PASSWORD = "test-habitat-preparation-admin"
BASE = "/api/admin/habitat/input-preparations"
HEADERS = {"X-EOLab-Admin": "1"}
IDENTIFIER = "a" * 32
BODY = {
    "requestId": "initial-preparation-0001",
    "name": "Montana reference area",
    "year": 2018,
    "selection": {
        "collectionId": "eolab-mounted-vectors",
        "itemId": "montana",
        "assetKey": "data",
        "layerName": "polygons",
        "filter": {"enabled": True, "match": "all", "rules": []},
    },
}


@pytest.fixture
def service() -> Mock:
    """Provide an interface-constrained substitute at the Processing service boundary.

    Returns:
        Async-aware service mock without constructing external storage or workers.
    """
    return create_autospec(ProcessingService, instance=True)


def _client(service: ProcessingService | Mock, password: str = PASSWORD) -> TestClient:
    """Compose the real protected router without unrelated application services.

    Args:
        service: Existing lifecycle service or an interface-constrained substitute.
        password: Existing administration credential, or blank to disable routes.

    Returns:
        Independent browser client for the preparation HTTP boundary.
    """
    app = FastAPI()
    app.include_router(create_habitat_preparation_router(service, password))
    return TestClient(app)


@pytest.mark.parametrize("password,expected", [("", 404), (PASSWORD, 401)])
def test_all_preparation_endpoints_require_enabled_administration(
    service: Mock, password: str, expected: int
) -> None:
    """Protect commands, history and report files before any service work occurs.

    Args:
        service: Substitute that must not receive unauthorized lifecycle calls.
        password: Disabled or configured administrator credential.
        expected: Disabled-route or authentication response status.
    """
    client = _client(service, password)
    for method, suffix in [
        ("POST", ""),
        ("GET", ""),
        ("GET", f"/{IDENTIFIER}"),
        ("POST", f"/{IDENTIFIER}/cancel"),
        ("POST", f"/{IDENTIFIER}/retry"),
        ("GET", f"/{IDENTIFIER}/report"),
        ("HEAD", f"/{IDENTIFIER}/report"),
        ("GET", f"/{IDENTIFIER}/provenance"),
    ]:
        response = client.request(method, BASE + suffix, json={}, headers=HEADERS)
        assert response.status_code == expected
        assert response.headers["cache-control"] == "private, no-store"
    assert service.mock_calls == []


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {**HEADERS, "Origin": "https://other.test"},
        {**HEADERS, "Sec-Fetch-Site": "cross-site"},
    ],
)
def test_preparation_mutations_require_same_origin_admin_requests(
    service: Mock, headers: dict[str, str]
) -> None:
    """Prevent browser-managed Basic credentials from authorizing cross-site work.

    Args:
        service: Substitute that must not receive rejected commands.
        headers: Missing admin header or explicit foreign-origin browser request.
    """
    client = _client(service)
    for suffix in ["", f"/{IDENTIFIER}/cancel", f"/{IDENTIFIER}/retry"]:
        response = client.post(
            BASE + suffix, json=BODY, headers=headers, auth=("admin", PASSWORD)
        )
        assert response.status_code == 403
        assert response.headers["cache-control"] == "private, no-store"
    assert service.mock_calls == []


@pytest.mark.parametrize("kind", ["year", "path", "upload", "emptyName"])
def test_preparation_admission_rejects_invalid_external_inputs(
    service: Mock, kind: str
) -> None:
    """Admit only named Catalog descriptors and strictly typed assessment years.

    Args:
        service: Substitute that must not receive invalid requests.
        kind: Invalid year type, extra filesystem path, upload or empty job name.
    """
    payload = {**BODY}
    if kind == "year":
        payload["year"] = "2018"
    elif kind == "path":
        payload["path"] = "/private/source.gpkg"
    elif kind == "upload":
        payload["selection"] = {
            "uploadId": "090aca16-b62a-4572-b4a4-142853ca6f30",
            "layerName": "polygons",
            "filter": BODY["selection"]["filter"],
        }
    else:
        payload["name"] = "   "
    response = _client(service).post(
        BASE, json=payload, headers=HEADERS, auth=("admin", PASSWORD)
    )
    assert response.status_code == 422
    assert response.headers["cache-control"] == "private, no-store"
    service.submit_habitat_input_preparation.assert_not_called()


@pytest.mark.parametrize("suffix", ["", f"/{IDENTIFIER}/retry"])
def test_preparation_commands_keep_the_existing_metadata_body_limit(
    service: Mock, suffix: str
) -> None:
    """Reject oversized metadata before JSON parsing while retaining private errors.

    Args:
        service: Substitute that must not receive oversized external commands.
        suffix: Initial submission or explicit retry endpoint.
    """
    response = _client(service).post(
        BASE + suffix,
        content=b" " * (16 * 1024 + 1),
        headers={**HEADERS, "Content-Type": "application/json"},
        auth=("admin", PASSWORD),
    )
    assert response.status_code == 413
    assert response.headers["cache-control"] == "private, no-store"
    assert service.mock_calls == []


@pytest.mark.parametrize(
    "failure,expected",
    [
        (
            ProcessingError(
                "unavailable", "Job storage is temporarily unavailable.", 503
            ),
            503,
        ),
        (SelectionUnavailableError("The selected Catalog area is unavailable."), 409),
    ],
)
def test_preparation_errors_remain_actionable_and_private(
    service: Mock, failure: Exception, expected: int
) -> None:
    """Translate owning-boundary failures without losing administration cache policy.

    Args:
        service: Substitute failing at source authorization or job admission.
        failure: Sanitized exception returned by the real owning boundary.
        expected: Public status corresponding to the failure category.
    """
    service.submit_habitat_input_preparation.side_effect = failure
    response = _client(service).post(
        BASE, json=BODY, headers=HEADERS, auth=("admin", PASSWORD)
    )
    assert response.status_code == expected
    assert response.json() == {"detail": str(failure)}
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("metadata", [{}, {"inputs": "/private/source.gpkg"}])
def test_malformed_saved_preparation_metadata_returns_a_private_failure(
    metadata: dict[str, Any],
) -> None:
    """Validate the persisted inputs envelope before serializing an admin response.

    Args:
        metadata: Unexpired stored document with missing or incorrectly shaped inputs.
    """
    now = datetime.now(timezone.utc)
    jobs = Mock()
    jobs.get.return_value = {
        "id": IDENTIFIER,
        "operation": "habitat.prepare-inputs.v1",
        "status": "failed",
        "created_at": now,
        "updated_at": now,
        "expires_at": now + timedelta(days=1),
        "metadata_expires_at": now + timedelta(days=7),
        "retained_metadata": metadata,
        "artifact": None,
        "progress": {},
        "error": None,
    }
    lifecycle = ProcessingService(jobs, Mock(), model_registry=Mock())
    response = _client(lifecycle).get(f"{BASE}/{IDENTIFIER}", auth=("admin", PASSWORD))
    assert response.status_code == 500
    assert response.json() == {
        "detail": "This preparation's saved details could not be read."
    }
    assert response.headers["cache-control"] == "private, no-store"
    assert "/private/source.gpkg" not in response.text
    jobs.get.assert_called_once_with(IDENTIFIER, HABITAT_PREPARATION_OWNER)


def test_preparation_administration_is_wired_into_the_application(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Compose optional preparation access without exposing server credentials.

    Args:
        configured_environment: Complete isolated application settings.
        version_file_path: Baked application version fixture.
        monkeypatch: Enable and then disable the existing administrator password.
    """
    monkeypatch.setenv("ADMIN_PASSWORD", PASSWORD)
    client = TestClient(create_app(version_file_path))
    response = client.get(BASE)
    assert response.status_code == 401
    assert response.headers["cache-control"] == "private, no-store"
    assert PASSWORD not in client.get("/api/config").text
    monkeypatch.delenv("ADMIN_PASSWORD")
    response = TestClient(create_app(version_file_path)).get(BASE)
    assert response.status_code == 404
    assert response.headers["cache-control"] == "private, no-store"
