"""Exercise admin preparation admission, isolation, history and retained report lifecycle."""

import asyncio
from collections.abc import Iterator
from dataclasses import replace
import hashlib
import json
from pathlib import Path
from threading import Event
from typing import Any
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest
from shapely.geometry import box, mapping

from catalog_selection_support import FixtureCatalog, write_selection
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.processing.artifact_manifest import FileDeclaration
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.habitat_preparation import (
    build_habitat_input_preparation_submission,
)
from eolab_app.processing.habitat_preparation_models import (
    HabitatInputPreparationArtifact,
    HabitatInputPreparationRequest,
)
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.models import PreparedJobPlan
from eolab_app.processing.service import HABITAT_PREPARATION_OWNER, ProcessingService
from eolab_app.processing.worker import ProcessingWorker
from eolab_app.routes.habitat_preparation import create_habitat_preparation_router
from eolab_app.routes.processing import COOKIE, create_processing_router
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sampling import VectorSamplingService
from test_processing_jobs import store

PASSWORD = "test-habitat-preparation-admin"
BASE = "/api/admin/habitat/input-preparations"
HEADERS = {"X-EOLab-Admin": "1"}


@pytest.fixture
def preparation_boundary(
    tmp_path: Path, store: PostgresJobStore
) -> Iterator[
    tuple[TestClient, ProcessingService, ResolvedCatalogSelection, LocalJobArtifacts]
]:
    """Compose real Catalog authorization, PostgreSQL and protected preparation APIs.

    Args:
        tmp_path: Isolated mounted GeoPackage and private artifact volume.
        store: Explicit disposable PostgreSQL fixture.

    Yields:
        Admin HTTP client, lifecycle service, real source and artifact adapter.
    """
    source = write_selection(
        tmp_path / "area.gpkg", [mapping(box(-105, 45, -104.9, 45.1))]
    )
    catalog = FixtureCatalog(
        ResolvedVectorSource("mounted", "geopackage", source.path, "data", "polygons")
    )
    areas = VectorSamplingService(catalog, catalog)
    artifacts = LocalJobArtifacts(tmp_path / "processing", (source.path,))
    artifacts.initialize()
    service = ProcessingService(store, artifacts, areas=areas)
    app = FastAPI()
    app.include_router(create_habitat_preparation_router(service, PASSWORD))
    app.include_router(create_processing_router(service))
    with TestClient(app, base_url="https://testserver") as client:
        client.auth = ("admin", PASSWORD)
        yield client, service, source, artifacts


def _body(
    source: ResolvedCatalogSelection, request_id: str | None = None
) -> dict[str, Any]:
    """Capture one named fixture AOI using a fresh or repeated submission identity.

    Args:
        source: Descriptor issued by the real Catalog authorization boundary.
        request_id: Stable submission key, or None to create a new command.

    Returns:
        Path-free external preparation request.
    """
    return {
        "requestId": request_id or uuid4().hex,
        "name": "Montana preparation",
        "year": 2018,
        "selection": source.selection.model_dump(mode="json", by_alias=True),
    }


def _submit(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    """Admit an administrator preparation through the production HTTP endpoint.

    Args:
        client: Authenticated browser with the protected router.
        body: Named area, year and stable request identity.

    Returns:
        Accepted queued job status.
    """
    response = client.post(BASE, json=body, headers=HEADERS)
    assert response.status_code == 202, response.text
    assert response.headers["cache-control"] == "private, no-store"
    return response.json()


def test_preparation_admission_recovers_before_source_and_stack_reads(
    preparation_boundary: Any, store: PostgresJobStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Recover lost responses across browsers and password changes without rereading sources.

    Args:
        preparation_boundary: Real Catalog, admin API and Processing lifecycle.
        store: Disposable database proving one admitted computation and subscriber.
        monkeypatch: Make source and scientific configuration unavailable after acceptance.
    """
    client, service, source, _ = preparation_boundary
    body = _body(source)
    accepted = _submit(client, body)
    assert "set-cookie" not in client.get(BASE).headers
    monkeypatch.setattr(
        service.areas,
        "resolve_for_sampling",
        AsyncMock(side_effect=SelectionUnavailableError("Catalog is unavailable.")),
    )
    monkeypatch.setattr(
        "eolab_app.processing.service.build_habitat_input_preparation_submission",
        Mock(
            side_effect=AssertionError(
                "An accepted submission must not reload the stack"
            )
        ),
    )
    assert _submit(client, body)["jobId"] == accepted["jobId"]
    response = client.post(
        BASE, json={**body, "name": "Different area name"}, headers=HEADERS
    )
    assert response.status_code == 409
    changed_password = "replacement-habitat-admin-password"
    app = FastAPI()
    app.include_router(create_habitat_preparation_router(service, changed_password))
    other = TestClient(app)
    other.auth = ("admin", changed_password)
    assert _submit(other, body)["jobId"] == accepted["jobId"]
    assert other.get(BASE).json()["jobs"][0]["jobId"] == accepted["jobId"]
    with psycopg.connect(store.conninfo) as connection:
        assert connection.execute(
            "SELECT count(*) FROM processing.jobs"
        ).fetchone() == (1,)
        assert connection.execute(
            "SELECT count(*) FROM processing.job_subscribers"
        ).fetchone() == (1,)


def test_admin_history_and_commands_cannot_access_other_job_scopes(
    preparation_boundary: Any, store: PostgresJobStore
) -> None:
    """Keep browser jobs and unrelated admin operations outside preparation access.

    Args:
        preparation_boundary: Real admin and ordinary browser Processing APIs.
        store: Disposable database admitting controlled foreign handles.
    """
    client, _, source, _ = preparation_boundary
    accepted = _submit(client, _body(source))
    prepared = build_habitat_input_preparation_submission(
        HabitatInputPreparationRequest.model_validate(_body(source))
    )
    browser_job = store.submit("b" * 64, uuid4().hex, prepared, "browser-request")
    unrelated = store.submit(
        HABITAT_PREPARATION_OWNER,
        uuid4().hex,
        PreparedJobPlan(
            {"operation": "raster.clip.v1"}, {}, 0, operation="raster.clip.v1"
        ),
        "unrelated-request",
    )
    assert [job["jobId"] for job in client.get(BASE).json()["jobs"]] == [
        accepted["jobId"]
    ]
    for job, expected in [(browser_job, 404), (unrelated, 409)]:
        for method, suffix in [
            ("GET", ""),
            ("POST", "/cancel"),
            ("POST", "/retry"),
            ("GET", "/report"),
            ("GET", "/provenance"),
        ]:
            response = client.request(
                method,
                f"{BASE}/{job['id']}{suffix}",
                json={"requestId": uuid4().hex},
                headers=HEADERS,
            )
            assert response.status_code == expected, response.text
            assert response.headers["cache-control"] == "private, no-store"
    foreign = TestClient(client.app, base_url="https://testserver")
    foreign.cookies.set(COOKIE, HABITAT_PREPARATION_OWNER, path="/")
    assert foreign.get(f"/api/processing/jobs/{accepted['jobId']}").status_code == 404
    assert foreign.get(BASE).status_code == 401


def test_preparation_history_cancellation_and_explicit_retry_are_independent(
    preparation_boundary: Any, store: PostgresJobStore
) -> None:
    """Page history and retry cancelled work without reviving its original handle.

    Args:
        preparation_boundary: Real lifecycle and protected preparation endpoints.
        store: Database authority retaining old handles after cancellation.
    """
    client, _, source, _ = preparation_boundary
    jobs = [_submit(client, _body(source)) for _ in range(3)]
    page = client.get(BASE, params={"limit": 2}).json()
    assert len(page["jobs"]) == 2 and page["nextCursor"]
    older = client.get(BASE, params={"limit": 2, "cursor": page["nextCursor"]}).json()
    assert len(older["jobs"]) == 1 and older["nextCursor"] is None
    assert {job["jobId"] for job in page["jobs"] + older["jobs"]} == {
        job["jobId"] for job in jobs
    }
    base = f"{BASE}/{jobs[0]['jobId']}"
    cancelled = client.post(base + "/cancel", headers=HEADERS)
    assert cancelled.status_code == 202 and cancelled.json()["status"] == "cancelled"
    retry_body = {"requestId": uuid4().hex}
    retried = client.post(base + "/retry", json=retry_body, headers=HEADERS)
    assert retried.status_code == 202, retried.text
    assert retried.json()["jobId"] != jobs[0]["jobId"]
    repeated = client.post(base + "/retry", json=retry_body, headers=HEADERS)
    assert repeated.json()["jobId"] == retried.json()["jobId"]
    assert client.get(base).json()["status"] == "cancelled"
    assert (
        store.get(jobs[0]["jobId"], HABITAT_PREPARATION_OWNER)["status"] == "cancelled"
    )
    active_retry = client.post(
        f"{BASE}/{jobs[1]['jobId']}/retry",
        json={"requestId": uuid4().hex},
        headers=HEADERS,
    )
    assert active_retry.status_code == 409
    assert client.get(BASE, params={"cursor": "not-a-cursor"}).status_code == 422
    assert client.get(BASE, params={"limit": 0}).status_code == 422


def _publish_report(
    store: PostgresJobStore, artifacts: LocalJobArtifacts, identifier: str
) -> bytes:
    """Publish a completion receipt through real artifact and job storage boundaries.

    Args:
        store: Lifecycle authority with exactly one queued preparation.
        artifacts: Confined attempt and immutable-result adapter.
        identifier: Public handle expected to own the queued computation.

    Returns:
        Published report bytes for HTTP transfer assertions.
    """
    claimed = store.claim_next_job()
    assert claimed is not None and claimed["id"] == identifier
    assert store.heartbeat(
        claimed["id"],
        claimed["attempt_id"],
        {
            "phase": "fetching_habitat_tiles",
            "completed": 1,
            "total": 2,
            "unit": "tiles",
        },
    )
    row = store.get(identifier, HABITAT_PREPARATION_OWNER)
    captured = row["retained_metadata"]["inputs"]
    content = json.dumps({**captured, "version": 1, "tileCount": 2}).encode()
    directory = artifacts.prepare(claimed["attempt_id"])
    (directory / "result.json").write_bytes(content)
    (directory / "provenance.json").write_text(
        '{"operation":"habitat.prepare-inputs.v1"}'
    )
    artifact = HabitatInputPreparationArtifact(
        size=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        filename="habitat-input-preparation-report.json",
        year=captured["year"],
        configuration_sha256=captured["configurationSha256"],
        tile_count=2,
    )
    manifest = artifacts.publish(
        claimed["attempt_id"],
        (
            FileDeclaration(
                "result",
                "Preparation report",
                "result",
                "result.json",
                artifact.filename,
                "application/json",
                artifact.size,
                artifact.sha256,
            ),
            FileDeclaration(
                "provenance",
                "Provenance",
                "provenance",
                "provenance.json",
                "habitat-input-preparation-provenance.json",
                "application/json",
            ),
        ),
        Event(),
    )
    assert store.finish(
        claimed["id"], claimed["attempt_id"], replace(artifact, manifest=manifest)
    )
    return content


def test_preparation_reports_tile_progress_and_restart_requires_explicit_retry(
    preparation_boundary: Any, store: PostgresJobStore
) -> None:
    """Expose measured tile work and keep restart recovery an explicit new job.

    Args:
        preparation_boundary: Real protected status and retry endpoints.
        store: Existing lease, progress and restart state authority.
    """
    client, _, source, _ = preparation_boundary
    job = _submit(client, _body(source))
    base = f"{BASE}/{job['jobId']}"
    claimed = store.claim_next_job()
    assert claimed is not None
    progress = {
        "phase": "fetching_habitat_tiles",
        "completed": 1,
        "total": 3,
        "unit": "tiles",
    }
    assert store.heartbeat(claimed["id"], claimed["attempt_id"], progress)
    running = client.get(base).json()
    assert running["progress"] == progress
    assert running["metadataExpiresAt"] is None
    assert running["inputs"]["name"] == "Montana preparation"
    assert store.interrupt_unfinished_jobs_on_restart() == 1
    interrupted = client.get(base).json()
    assert interrupted["status"] == "interrupted"
    assert interrupted["metadataExpiresAt"] is not None
    assert store.claim_next_job() is None
    response = client.post(
        base + "/retry", json={"requestId": uuid4().hex}, headers=HEADERS
    )
    assert response.status_code == 202, response.text
    assert response.json()["jobId"] != job["jobId"]
    assert client.get(base).json()["status"] == "interrupted"


def test_report_expiry_preserves_cache_and_retry_metadata(
    preparation_boundary: Any, store: PostgresJobStore
) -> None:
    """Expire report files independently of shared tiles and saved retry inputs.

    Args:
        preparation_boundary: Real report publication, HTTP transfer and admin lifecycle.
        store: Database authority used to advance only the relevant expiry deadlines.
    """
    client, service, source, artifacts = preparation_boundary
    job = _submit(client, _body(source))
    identifier = job["jobId"]
    report = _publish_report(store, artifacts, identifier)
    base = f"{BASE}/{identifier}"
    completed = client.get(base).json()
    assert completed["result"]["tileCount"] == 2
    assert completed["inputs"]["name"] == "Montana preparation"
    downloaded_report = client.get(base + "/report")
    assert downloaded_report.content == report
    assert (
        "habitat-input-preparation-report.json"
        in downloaded_report.headers["content-disposition"]
    )
    assert client.head(base + "/report").headers["content-length"] == str(len(report))
    assert (
        client.get(base + "/report", headers={"Range": "bytes=0-4"}).content
        == report[:5]
    )
    downloaded_provenance = client.get(base + "/provenance")
    assert downloaded_provenance.json()["operation"] == "habitat.prepare-inputs.v1"
    assert (
        "habitat-input-preparation-provenance.json"
        in downloaded_provenance.headers["content-disposition"]
    )
    tile = (
        artifacts.root
        / "habitat-cache"
        / completed["inputs"]["configurationSha256"]
        / "0_0"
        / "tile.tif"
    )
    tile.parent.mkdir(parents=True)
    tile.write_bytes(b"Immutable cached input")
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
            (identifier,),
        )
    worker = ProcessingWorker(
        Mock(), store, artifacts, store.limits, areas=service.areas
    )
    asyncio.run(worker.cleanup())
    retained = store.get(identifier, HABITAT_PREPARATION_OWNER)
    assert retained["spec"] is None and retained["artifact"] is None
    assert retained["retained_metadata"] is not None
    assert tile.read_bytes() == b"Immutable cached input"
    assert client.get(base + "/report").status_code == 409
    retry_body = {"requestId": uuid4().hex}
    retried = client.post(base + "/retry", json=retry_body, headers=HEADERS)
    assert retried.status_code == 202, retried.text
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET metadata_expires_at=now()-interval '1 second' WHERE id=%s",
            (identifier,),
        )
    assert client.get(base).json()["inputs"] is None
    assert (
        client.post(base + "/retry", json=retry_body, headers=HEADERS).json()["jobId"]
        == retried.json()["jobId"]
    )
    expired = client.post(
        base + "/retry", json={"requestId": uuid4().hex}, headers=HEADERS
    )
    assert expired.status_code == 409
    assert "saved inputs have expired" in expired.json()["detail"]
    assert tile.exists()


def test_explicit_retry_rejects_a_changed_scientific_configuration(
    preparation_boundary: Any, store: PostgresJobStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Require a fresh request when the original preparation's stack identity changes.

    Args:
        preparation_boundary: Real admission and explicit retry endpoints.
        store: Database authority retaining the original cancelled request.
        monkeypatch: Represent a changed installed scientific configuration at admission.
    """
    client, _, source, _ = preparation_boundary
    job = _submit(client, _body(source))
    base = f"{BASE}/{job['jobId']}"
    assert client.post(base + "/cancel", headers=HEADERS).status_code == 202

    def changed_configuration(
        request: HabitatInputPreparationRequest,
    ) -> PreparedJobPlan:
        """Represent the queue producer capturing a new scientific stack identity.

        Args:
            request: Same named area and assessment year as the original preparation.

        Returns:
            Submission whose current configuration digest differs from saved inputs.
        """
        prepared = build_habitat_input_preparation_submission(request)
        return replace(
            prepared, summary={**prepared.summary, "configurationSha256": "f" * 64}
        )

    monkeypatch.setattr(
        "eolab_app.processing.service.build_habitat_input_preparation_submission",
        changed_configuration,
    )
    response = client.post(
        base + "/retry", json={"requestId": uuid4().hex}, headers=HEADERS
    )
    assert response.status_code == 409
    assert "Start a new preparation request" in response.json()["detail"]
    assert len(store.list_owned(HABITAT_PREPARATION_OWNER)) == 1
