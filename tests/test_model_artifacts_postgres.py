"""Multiple real model files across HTTP, PostgreSQL, native execution and cleanup."""

from dataclasses import replace
from datetime import timedelta
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy
import psycopg
import pytest
import rasterio
from fastapi.testclient import TestClient

from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.artifact_manifest import read_artifact_manifest
from eolab_app.processing.models import Artifact, PreparedJobPlan, ProcessingError
from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.processing.model_definitions import ModelRegistry
from eolab_app.processing.model_yaml import parse_yaml
from eolab_app.processing.raster_clip import create_clip, clip_process_target
from eolab_app.routes.processing import COOKIE
from model_recipe_support import multiple_output_recipe
from test_model_runs_postgres import model_boundary, model_request, submit
from test_processing_jobs import boundary, store, HEADERS, AREA
from raster_source_support import SOURCE
from uuid import uuid4


@pytest.mark.parametrize("resolution", ["undo", "dismiss", "timeout"])
def test_model_deletion_hold_preserves_files_and_reader_protection(
    multiple_boundary: Any, store: PostgresJobStore, resolution: str
) -> None:
    """Undo restores all files; dismissal and timeout use the existing reader-safe cleanup.

    Args:
        multiple_boundary: Native multi-output model, HTTP client and worker.
        store: Isolated PostgreSQL lifecycle authority.
        resolution: Restore within thirty seconds, dismiss early, or expire the hold.
    """
    client, worker, _, body = multiple_boundary
    run = submit(client, body)
    identifier = run["jobId"]
    base = f"/api/processing/jobs/{identifier}"
    assert client.portal.call(worker.run_once)
    ready = client.get(base).json()
    files = ready["artifacts"]["files"]
    contents = {file["artifactId"]: client.get(file["url"]).content for file in files}
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    record, lease = store.acquire_transfer(identifier, owner)
    path = worker.artifacts.artifact_path(record["attempt_id"], "result.tif")
    response = client.delete(base + "?undo=true", headers=HEADERS)
    assert response.status_code == 200, response.text
    deleted = response.json()
    offer = deleted["deletionUndo"]
    with psycopg.connect(store.conninfo) as connection:
        remaining, retained = connection.execute(
            "SELECT s.deletion_undo_until-clock_timestamp(),j.reserved_bytes "
            "FROM processing.job_subscribers s JOIN processing.jobs j ON j.id=s.job_id WHERE s.id=%s",
            (identifier,),
        ).fetchone()
    assert timedelta(seconds=25) < remaining <= timedelta(seconds=30)
    assert retained == record["reserved_bytes"]
    assert (
        client.delete(base + "?undo=true", headers=HEADERS).json()["deletionUndo"]
        == offer
    )
    assert identifier not in {
        item["jobId"]
        for item in client.get("/api/processing/model-runs").json()["jobs"]
    }
    assert client.get(base + "/invocation").status_code == 410
    for file in files:
        assert client.get(file["url"]).status_code == 409
    client.portal.call(worker.cleanup)
    assert path.exists()
    action = {"deletionId": offer["deletionId"]}
    if resolution == "undo":
        response = client.post(base + "/deletion/undo", json=action, headers=HEADERS)
        assert response.status_code == 200, response.text
        restored = response.json()
        assert restored["status"] == "ready" and restored["deletionUndo"] is None
        assert restored["expiresAt"] == ready["expiresAt"]
        assert restored["metadataExpiresAt"] == ready["metadataExpiresAt"]
        assert restored["artifacts"] == ready["artifacts"]
        assert (
            client.post(base + "/deletion/undo", json=action, headers=HEADERS).json()
            == restored
        )
        assert (
            client.post(base + "/deletion/dismiss", json=action, headers=HEADERS).json()
            == restored
        )
        for file in files:
            assert client.get(file["url"]).content == contents[file["artifactId"]]
        assert client.get(base + "/invocation").status_code == 200
        store.transfer_heartbeat(lease, release=True)
        client.portal.call(worker.cleanup)
        assert path.exists()
        newer = client.delete(base + "?undo=true", headers=HEADERS).json()[
            "deletionUndo"
        ]
        assert newer["deletionId"] != offer["deletionId"]
        for operation in ("undo", "dismiss"):
            assert (
                client.post(
                    base + f"/deletion/{operation}", json=action, headers=HEADERS
                ).status_code
                == 409
            )
    else:
        if resolution == "dismiss":
            response = client.post(
                base + "/deletion/dismiss", json=action, headers=HEADERS
            )
            assert response.status_code == 200, response.text
            assert response.json()["deletionUndo"] is None
        else:
            with psycopg.connect(store.conninfo) as connection:
                connection.execute(
                    "UPDATE processing.job_subscribers SET deletion_undo_until=now()-interval '1 second' WHERE id=%s",
                    (identifier,),
                )
        assert (
            client.post(
                base + "/deletion/undo", json=action, headers=HEADERS
            ).status_code
            == 409
        )
        client.portal.call(worker.cleanup)
        assert path.exists(), "Existing transfers retain their usual protection"
        store.transfer_heartbeat(lease, release=True)
        client.portal.call(worker.cleanup)
        assert not path.exists()
        assert client.get(base).json()["status"] == "deleted"


def test_undo_does_not_revive_results_expiring_during_its_window(
    multiple_boundary: Any, store: PostgresJobStore
) -> None:
    """Restore history after normal expiry without renewing or exposing expired files.

    Args:
        multiple_boundary: Native multi-output model, HTTP client and worker.
        store: Isolated lifecycle authority used to advance the result deadline.
    """
    client, worker, _, body = multiple_boundary
    run = submit(client, body)
    base = f"/api/processing/jobs/{run['jobId']}"
    assert client.portal.call(worker.run_once)
    files = client.get(base).json()["artifacts"]["files"]
    offer = client.delete(base + "?undo=true", headers=HEADERS).json()["deletionUndo"]
    with psycopg.connect(store.conninfo) as connection:
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
            (run["jobId"],),
        )
    client.portal.call(worker.cleanup)
    restored = client.post(
        base + "/deletion/undo",
        json={"deletionId": offer["deletionId"]},
        headers=HEADERS,
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["status"] == "expired"
    for file in files:
        assert client.get(file["url"]).status_code == 409


def test_renewal_keeps_all_outputs_and_details_without_copying_files(
    multiple_boundary: Any, store: Any
) -> None:
    """Renew a real multi-output run atomically without changing bytes or ownership.

    Args:
        multiple_boundary: Native multi-output model, HTTP client and worker.
        store: Isolated PostgreSQL retention and accounting authority.
    """
    client, worker, _, body = multiple_boundary
    run = submit(client, body)
    identifier = run["jobId"]
    base = f"/api/processing/jobs/{identifier}"
    with psycopg.connect(store.conninfo) as connection:
        before = connection.execute("SELECT clock_timestamp()").fetchone()[0]
    assert client.portal.call(worker.run_once)
    ready = client.get(base).json()
    assert ready["expiresAt"] == ready["metadataExpiresAt"]
    with psycopg.connect(store.conninfo) as connection:
        expiry, retained, attempt = connection.execute(
            "SELECT expires_at,reserved_bytes,attempt_id FROM processing.jobs WHERE id=%s",
            (identifier,),
        ).fetchone()
        assert expiry >= before + timedelta(days=7)
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()+interval '1 hour',"
            "metadata_expires_at=now()+interval '1 hour' WHERE id=%s",
            (identifier,),
        )
    original_files = ready["artifacts"]["files"]
    paths = sorted(
        worker.artifacts.artifact_path(attempt, "result.tif").parent.iterdir()
    )
    original_bytes = {path.name: path.read_bytes() for path in paths if path.is_file()}
    assert "scratch.bin" not in original_bytes
    cookie = client.cookies.get(COOKIE)
    response = client.post(base + "/renew", headers=HEADERS)
    assert response.status_code == 200, response.text
    renewed = response.json()
    assert (
        renewed["expiresAt"]
        == renewed["metadataExpiresAt"]
        == renewed["artifacts"]["expiresAt"]
    )
    assert renewed["artifacts"]["files"] == original_files
    assert client.cookies.get(COOKIE) == cookie
    assert "Max-Age=604800" in response.headers["set-cookie"]
    assert client.get(base + "/run-yaml").status_code == 200
    assert client.get(base + "/artifacts").json() == renewed["artifacts"]
    assert {
        path.name: path.read_bytes() for path in paths if path.is_file()
    } == original_bytes
    with psycopg.connect(store.conninfo) as connection:
        result = connection.execute(
            "SELECT reserved_bytes,expires_at-clock_timestamp() FROM processing.jobs WHERE id=%s",
            (identifier,),
        ).fetchone()
        assert result[0] == retained
        assert timedelta(days=7, seconds=-15) < result[1] <= timedelta(days=7)
        connection.execute(
            "UPDATE processing.jobs SET expires_at=now()+interval '14 days' WHERE id=%s",
            (identifier,),
        )
        later = connection.execute(
            "SELECT expires_at FROM processing.jobs WHERE id=%s", (identifier,)
        ).fetchone()[0]
    for _ in range(2):
        repeated = client.post(base + "/renew", headers=HEADERS).json()
        assert repeated["expiresAt"] == repeated["metadataExpiresAt"]
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute(
                "SELECT expires_at FROM processing.jobs WHERE id=%s", (identifier,)
            ).fetchone()[0]
            == later
        )
    restarted = PostgresJobStore(store.limits, store.conninfo)
    restarted.open()
    try:
        owner = hashlib.sha256(cookie.encode()).hexdigest()
        assert restarted.get(identifier, owner)["expires_at"] == later
    finally:
        restarted.close()
    client.portal.call(worker.cleanup)
    for file in original_files:
        assert client.get(file["url"]).status_code == 200
    deleted = client.delete(base, headers=HEADERS)
    assert deleted.status_code == 200
    for file in original_files:
        assert client.get(file["url"]).status_code == 409
    assert client.post(base + "/renew", headers=HEADERS).status_code == 409
    client.portal.call(worker.cleanup)
    assert not paths[0].exists()


def multiple_files_target(
    queue: ProcessResultWriter, action: str, arguments: tuple[Any, ...]
) -> None:
    """Run a real clip and write a coverage GeoTIFF plus a totals CSV.

    Args:
        queue: Native result transport.
        action: Trusted clip operation stage.
        arguments: Source, prepared clip specification, workspace and limits.
    """
    if action != "clip":
        clip_process_target(queue, action, arguments)
        return
    artifact = create_clip(*arguments)
    directory = arguments[2]
    with rasterio.open(directory / "result.tif") as source:
        mask = source.read_masks(1) > 0
        profile = {**source.profile, "dtype": "uint8", "nodata": 0}
        with rasterio.open(directory / "coverage.tif", "w", **profile) as destination:
            destination.write(mask.astype("uint8"), 1)
        total = numpy.sum(source.read(1)[mask])
    (directory / "totals.csv").write_text(f"sum\n{total}\n", encoding="utf-8")
    (directory / "scratch.bin").write_bytes(b"working-only")
    outputs = []
    for name, filename, media_type in (
        ("coverage", "coverage.tif", "image/tiff"),
        ("totals", "totals.csv", "text/csv"),
    ):
        data = (directory / filename).read_bytes()
        outputs.append(
            ProducedFile(
                name=name,
                storage_name=filename,
                filename=filename,
                media_type=media_type,
                size=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
            )
        )
    queue.put(("ok", replace(artifact, additional_outputs=tuple(outputs))))


@pytest.fixture
def multiple_boundary(model_boundary: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Install a test-only multi-output recipe using the actual operation boundary.

    Args:
        model_boundary: Real HTTP, PostgreSQL and worker composition.
        monkeypatch: Scoped native target and registered operation replacement.

    Returns:
        Client, worker, service and submitted model request.
    """
    client, worker, service = model_boundary
    definition = multiple_output_recipe(monkeypatch)
    service.model_registry = ModelRegistry((definition,))
    monkeypatch.setattr(
        "eolab_app.processing.raster_operations.clip_process_target",
        multiple_files_target,
    )
    body = model_request(
        client,
        definition.id,
        inputs={
            "habitat": SOURCE,
            "region": {"kind": "selectedArea", "selectedBounds": AREA},
        },
    )
    return client, worker, service, body


def test_multiple_files_owned_downloads_and_exact_accounting(
    multiple_boundary: Any, store: Any
) -> None:
    """Publish real rasters and a table with immutable identities and private leases.

    Args:
        multiple_boundary: Real multi-output recipe composition.
        store: PostgreSQL lifecycle and accounting authority.
    """
    client, worker, _, body = multiple_boundary
    job = submit(client, body)
    base = f"/api/processing/jobs/{job['jobId']}"
    pending = client.get(base + "/artifacts").json()
    assert pending["availability"] == "pending" and pending["files"] == []
    assert client.portal.call(worker.run_once)
    ready = client.get(base).json()
    assert ready["status"] == "ready", ready
    manifest = client.get(base + "/artifacts").json()
    assert manifest == ready["artifacts"]
    assert manifest["availability"] == "available"
    assert {file["name"] for file in manifest["files"]} == {
        "habitat_result",
        "inspected_coverage",
        "habitat_totals",
        "provenance",
    }
    assert submit(client, body)["artifacts"] == manifest
    assert "storage_name" not in json.dumps(manifest) and str(
        worker.artifacts.root
    ) not in json.dumps(manifest)
    for file in manifest["files"]:
        download = client.get(file["url"])
        assert download.status_code == 200
        assert len(download.content) == file["bytes"]
        assert hashlib.sha256(download.content).hexdigest() == file["sha256"]
        assert "no-store" in download.headers["cache-control"]
        partial = client.get(file["url"], headers={"Range": "bytes=0-3"})
        assert partial.status_code == 206 and partial.content == download.content[:4]
        assert client.head(file["url"]).headers["content-length"] == str(file["bytes"])
        if file["mediaType"] == "image/tiff":
            with (
                rasterio.MemoryFile(download.content) as memory,
                memory.open() as raster,
            ):
                assert raster.width > 0 and raster.height > 0
        with TestClient(client.app, base_url="https://testserver") as other:
            assert other.get(file["url"]).status_code == 404
            assert other.get(base + "/artifacts").status_code == 404
            assert other.delete(base, headers=HEADERS).status_code == 404
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    row = store.get(job["jobId"], owner)
    directory = worker.artifacts.root / "results" / row["attempt_id"]
    assert {file.name for file in directory.iterdir()} == {
        "result.tif",
        "coverage.tif",
        "totals.csv",
        "provenance.json",
        "manifest.json",
    }
    disk_bytes = sum(file.stat().st_size for file in directory.iterdir())
    assert row["reserved_bytes"] == disk_bytes == manifest["totalBytes"]
    assert client.get(ready["result"]["url"]).status_code == 200
    assert client.get(ready["result"]["provenanceUrl"]).status_code == 200
    exported = parse_yaml(client.get(base + "/run-yaml").content, run=True)
    assert len(exported["execution"]["outcome"]["artifacts"]) == 4
    assert "storage_name" not in json.dumps(exported)
    unknown = client.get(base + "/artifacts/" + "0" * 32)
    assert unknown.status_code == 404
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute("SELECT count(*) FROM processing.transfers").fetchone()[
                0
            ]
            == 0
        )


@pytest.mark.parametrize("terminal", ["delete", "expire"])
def test_transfer_retains_all_files_until_cleanup(
    multiple_boundary: Any, store: Any, terminal: str
) -> None:
    """Deletion/expiry blocks new downloads while an existing lease protects every file.

    Args:
        multiple_boundary: Completed native multi-output run fixture.
        store: Real ownership, transfer and cleanup records.
        terminal: Explicit deletion or retention expiry.
    """
    client, worker, service, body = multiple_boundary
    job = submit(client, body)
    assert client.portal.call(worker.run_once)
    base = f"/api/processing/jobs/{job['jobId']}"
    files = client.get(base + "/artifacts").json()["files"]
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    active = client.portal.call(
        service.download_model_artifact, owner, job["jobId"], files[1]["artifactId"]
    )
    row = store.get(job["jobId"], owner)
    directory = active.path.parent
    if terminal == "delete":
        assert client.delete(base, headers=HEADERS).status_code == 200
    else:
        with psycopg.connect(store.conninfo) as connection:
            connection.execute(
                "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
                (row["job_id"],),
            )
    for file in files:
        assert client.get(file["url"]).status_code == 409
    assert client.get(base + "/artifacts").json()["files"] == []
    client.portal.call(worker.cleanup)
    assert len(list(directory.iterdir())) == 5 and active.path.exists()
    assert client.portal.call(service.transfer_heartbeat, active.lease_id, True)
    client.portal.call(worker.cleanup)
    assert not directory.exists()


def test_missing_declared_intermediate_never_publishes(
    multiple_boundary: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A native primary result alone cannot satisfy a multi-output recipe.

    Args:
        multiple_boundary: Recipe requesting primary, coverage and totals files.
        monkeypatch: Restore the ordinary clip target which lacks the extra outputs.
    """
    client, worker, _, body = multiple_boundary
    monkeypatch.setattr(
        "eolab_app.processing.raster_operations.clip_process_target",
        clip_process_target,
    )
    job = submit(client, body)
    assert client.portal.call(worker.run_once)
    status = client.get(f"/api/processing/jobs/{job['jobId']}").json()
    assert (
        status["status"] == "failed"
        and status["error"]["code"] == "invalid_model_result"
    )
    assert status["artifacts"]["files"] == [] and status["result"] is None
    client.portal.call(worker.cleanup)
    assert not list((worker.artifacts.root / "results").iterdir())
    assert not list((worker.artifacts.root / "attempts").iterdir())


def test_file_ids_cannot_cross_runs_and_finish_records_actual_bytes(
    multiple_boundary: Any, store: Any
) -> None:
    """Scope IDs to their run, record actual bytes and reject late publication.

    Args:
        multiple_boundary: Actual model execution producing several retained files.
        store: Durable file-ownership and attempt-fencing authority.
    """
    client, worker, _, body = multiple_boundary
    first = submit(client, body)
    assert client.portal.call(worker.run_once)
    first_base = f"/api/processing/jobs/{first['jobId']}"
    manifest = client.get(first_base + "/artifacts").json()
    second = submit(client, {**body, "requestId": uuid4().hex})
    assert client.portal.call(worker.run_once)
    other_base = f"/api/processing/jobs/{second['jobId']}"
    for file in manifest["files"]:
        assert (
            client.get(other_base + "/artifacts/" + file["artifactId"]).status_code
            == 404
        )
    owner = hashlib.sha256(client.cookies.get(COOKIE).encode()).hexdigest()
    row = store.get(first["jobId"], owner)
    stored = row["artifact"]
    artifact = Artifact(
        stored["size"],
        stored["sha256"],
        stored["filename"],
        media_type=stored["media_type"],
        manifest=read_artifact_manifest(stored["manifest"]),
    )
    identifier = store.submit(
        "fixture-owner",
        uuid4().hex,
        PreparedJobPlan(
            {}, {}, artifact.manifest.total_bytes - 1, operation="fixture.files.v1"
        ),
        uuid4().hex,
    )["id"]
    claimed = store.claim_next_job()
    assert claimed["id"] == identifier
    assert claimed["reserved_bytes"] == 0
    assert not store.finish(identifier, "0" * 32, artifact)
    assert store.finish(identifier, claimed["attempt_id"], artifact)
    completed = store.get(identifier, "fixture-owner")
    assert completed["status"] == "ready"
    assert completed["reserved_bytes"] == artifact.manifest.total_bytes
    assert not store.finish(identifier, claimed["attempt_id"], artifact)
    identifier = store.submit(
        "fixture-owner", uuid4().hex,
        PreparedJobPlan({}, {}, 0, operation="fixture.files.v1"), uuid4().hex,
    )["id"]
    claimed = store.claim_next_job()
    assert claimed["id"] == identifier
    assert store.finish(
        identifier,
        claimed["attempt_id"],
        None,
        {"code": "fixture_failure", "detail": "Stopped"},
    )
    assert not store.finish(identifier, claimed["attempt_id"], artifact)
    assert store.get(identifier, "fixture-owner")["artifact"] is None
