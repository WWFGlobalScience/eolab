"""Private map previews through real Processing ownership, storage and HTTP boundaries."""

from collections.abc import Iterator
from dataclasses import replace
import hashlib
import json
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
import psycopg
import pytest

from eolab_app.rendering.artifact_preview import ArtifactPreviewService
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_operations import OperationOutput
from eolab_app.processing.raster_clip import create_clip, clip_process_target
from eolab_app.processing.source_access import create_model_source_files
import eolab_app.processing.model_definitions as definitions
import eolab_app.processing.model_operations as operation_registry
from eolab_app.routes.processing import (
    COOKIE,
    create_processing_router,
    get_processing_session_owner_hash,
)
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.raster.source_access import RasterSourceAccess
from test_temporary_raster_publication import (
    attach_output_rendering,
    OutputGeoServer,
    map_query,
    plan_request,
)
from test_composite_map import _tile_url
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.statistics_service import RasterStatisticsService
from test_model_runs_postgres import model_boundary, model_request, submit
from test_processing_jobs import boundary, store, HEADERS, AREA
from raster_source_support import SOURCE


@pytest.fixture
def preview_boundary(model_boundary: Any) -> Iterator[Any]:
    """Compose the actual renderer over the existing file delivery authority.

    Args:
        model_boundary: Real model service, native worker and PostgreSQL store.

    Yields:
        Connected preview client, worker and service.
    """
    _, worker, service = model_boundary
    app = FastAPI()
    files = create_model_source_files(service)
    renderer = ArtifactPreviewService(files)
    sources = RasterSourceAccess(worker.authorizer, files)
    app.include_router(
        create_raster_analysis_router(
            RasterPixelService(sources, 2),
            RasterStatisticsService(sources, 2, 8),
            source_access=sources,
            session_owner=lambda request, response: get_processing_session_owner_hash(
                request, response, 7 * 86_400
            ),
        )
    )
    publication, _ = attach_output_rendering(
        app,
        sources,
        service.model_artifact_is_available,
        lambda request, response: get_processing_session_owner_hash(
            request, response, 7 * 86_400
        ),
        OutputGeoServer(),
    )
    app.state.output_publication = publication
    app.include_router(
        create_processing_router(service, preview_artifact=renderer.read)
    )
    with TestClient(app, base_url="https://testserver") as client:
        yield client, worker, service


def clip_with_vector_target(
    writer: ProcessResultWriter, action: str, arguments: tuple[Any, ...]
) -> None:
    """Produce a real clip with a registered GeoJSON output for preview delivery.

    Args:
        writer: Supervised native result transport.
        action: Trusted clip operation stage.
        arguments: Source, prepared clip specification, workspace and limits.
    """
    if action != "clip":
        clip_process_target(writer, action, arguments)
        return
    artifact = create_clip(*arguments)
    data = json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"html": "<script>bad()</script>"},
                    "geometry": {"type": "Point", "coordinates": [0.5, 9.5]},
                }
            ],
        }
    ).encode()
    (arguments[2] / "area.geojson").write_bytes(data)
    output = ProducedFile(
        name="area",
        storage_name="area.geojson",
        filename="area.geojson",
        media_type="application/geo+json",
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
    )
    writer.put(("ok", replace(artifact, additional_outputs=(output,))))


@pytest.mark.parametrize("terminal", ["delete", "expire"])
def test_geojson_preview_and_download_share_owned_file_lifetimes(
    preview_boundary: Any,
    store: Any,
    monkeypatch: pytest.MonkeyPatch,
    terminal: str,
) -> None:
    """Deliver real published GeoJSON only to its owner while the run remains available.

    Args:
        preview_boundary: Actual HTTP, native worker, publication and file access.
        store: Disposable PostgreSQL lifecycle authority.
        monkeypatch: Register one test-only vector output on the clip operation.
        terminal: Explicit deletion or retention expiry after successful delivery.
    """
    client, worker, service = preview_boundary
    original = operation_registry.get_model_operation("raster.clip.v1")
    registry = {
        **operation_registry.OPERATIONS,
        original.id: replace(
            original,
            additional_outputs=(
                OperationOutput(
                    "area",
                    "vector",
                    "map",
                    "application/geo+json",
                    "Starting area",
                    "intermediate",
                ),
            ),
        ),
    }
    monkeypatch.setattr(operation_registry, "OPERATIONS", registry)
    monkeypatch.setattr(definitions, "OPERATIONS", registry)
    document = ModelRegistry.load_installed().get("raster-clip", "1.1.0").to_document()
    document["outputs"]["starting_area"] = {
        "source": "clip.area",
        "type": "vector",
        "role": "intermediate",
        "presentation": "map",
        "saveEligible": False,
    }
    service.model_registry = ModelRegistry((ModelDefinition.model_validate(document),))
    monkeypatch.setattr(
        "eolab_app.processing.raster_operations.clip_process_target",
        clip_with_vector_target,
    )
    job = submit(
        client,
        model_request(
            client,
            "raster-clip",
            inputs={
                "raster": SOURCE,
                "area": {"kind": "selectedArea", "selectedBounds": AREA},
            },
        ),
    )
    base = f"/api/processing/jobs/{job['jobId']}"
    assert client.portal.call(worker.run_once)
    ready = client.get(base).json()
    assert ready["status"] == "ready", ready
    file = next(
        file
        for file in ready["artifacts"]["files"]
        if file["mediaType"] == "application/geo+json"
    )
    url = file["url"] + "/preview"
    response = client.get(url)
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["jobId"] == job["jobId"]
    assert preview["artifactId"] == file["artifactId"]
    assert preview["sha256"] == file["sha256"]
    assert preview["kind"] == "vector" and preview["geometryKind"] == "point"
    assert preview["bounds"] == [0.5, 9.5, 0.5, 9.5]
    assert preview["geojson"]["features"] == [
        {
            "type": "Feature",
            "properties": {},
            "geometry": {"type": "Point", "coordinates": [0.5, 9.5]},
        }
    ]
    assert "no-store" in response.headers["cache-control"]
    assert str(worker.artifacts.root) not in response.text
    download = client.get(file["url"])
    assert download.status_code == 200
    assert hashlib.sha256(download.content).hexdigest() == file["sha256"]
    assert download.json()["features"][0]["properties"] == {
        "html": "<script>bad()</script>"
    }
    with TestClient(client.app, base_url="https://testserver") as foreign:
        assert foreign.get(url).status_code == 404
        assert foreign.get(file["url"]).status_code == 404
    if terminal == "delete":
        assert client.delete(base, headers=HEADERS).status_code == 200
    else:
        with psycopg.connect(store.conninfo) as connection:
            connection.execute(
                "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
                (job["jobId"],),
            )
    assert client.get(url).status_code == 409
    assert client.get(file["url"]).status_code == 409
    client.portal.call(worker.cleanup)
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute("SELECT count(*) FROM processing.transfers").fetchone()[
                0
            ]
            == 0
        )


@pytest.mark.parametrize("terminal", ["delete", "expire"])
def test_retired_tiff_preview_preserves_ordinary_raster_lifetimes(
    preview_boundary: Any, store: Any, terminal: str
) -> None:
    """Reject TIFF previews while ordinary rendering, analysis and downloads remain usable.

    Args:
        preview_boundary: Actual HTTP, rendering, worker and store composition.
        store: Disposable PostgreSQL authority.
        terminal: Explicit deletion or expiry after ordinary raster access succeeds.
    """

    client, worker, service = preview_boundary
    request = model_request(
        client,
        "raster-clip",
        inputs={
            "raster": SOURCE,
            "area": {"kind": "selectedArea", "selectedBounds": AREA},
        },
    )
    job = submit(client, request)
    base = f"/api/processing/jobs/{job['jobId']}"
    assert client.portal.call(worker.run_once)
    ready = client.get(base).json()
    file = next(
        file
        for file in ready["artifacts"]["files"]
        if file["mediaType"] == "image/tiff"
    )
    url = file["url"] + "/preview"
    response = client.get(url)
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == (
        "GeoTIFF outputs use ordinary raster rendering. "
        "Download the file or use Show on map."
    )
    assert "no-store" in response.headers["cache-control"]
    assert str(worker.artifacts.root) not in response.text
    reference = {
        "kind": "runArtifact",
        "jobId": job["jobId"],
        "artifactId": file["artifactId"],
    }
    publication_request = {"source": reference}
    window = client.post(
        "/api/rendering/layers", json=publication_request, headers=HEADERS
    )
    assert window.status_code == 200, window.text
    assert (
        window.json()["layerName"] == f"eolab:model_{job['jobId']}_{file['artifactId']}"
    )
    assert "no-store" in window.headers["cache-control"]
    assert str(worker.artifacts.root) not in window.text
    assert (
        client.post("/api/rendering/layers", json=publication_request).status_code
        == 403
    )
    assert (
        client.post(
            "/api/rendering/layers",
            json=publication_request,
            headers={**HEADERS, "Origin": "https://foreign.test"},
        ).status_code
        == 403
    )
    layer = window.json()["layerName"]
    assert (
        client.get("/geoserver/eolab/wms", params=map_query(layer)).status_code == 200
    )
    plan = client.post(
        "/api/map-rendering/plans", json=plan_request(layer), headers=HEADERS
    )
    assert plan.status_code == 200, plan.text
    tile_url = _tile_url(plan.json()["wmsUrl"])
    assert client.get(tile_url).status_code == 200
    pixel_request = {"source": reference, "longitude": 0.5, "latitude": 9.5}
    pixel = client.post(
        "/api/raster-analysis/pixels", json=pixel_request, headers=HEADERS
    )
    assert pixel.status_code == 200, pixel.text
    assert pixel.json()["inBounds"] and pixel.json()["value"] is not None
    assert "no-store" in pixel.headers["cache-control"]
    description = client.post(
        "/api/raster-analysis/sources", json={"source": reference}, headers=HEADERS
    )
    assert description.status_code == 200, description.text
    assert description.json()["version"] == file["sha256"]
    assert description.json()["capabilities"]["pixels"]["supported"]
    assert description.json()["capabilities"]["statistics"]["supported"]
    assert str(worker.artifacts.root) not in description.text
    statistics_request = {"source": reference}
    statistics = client.post(
        "/api/raster-analysis/statistics", json=statistics_request, headers=HEADERS
    )
    assert statistics.status_code == 200, statistics.text
    assert statistics.json()["validSampleCount"] == ready["result"]["validPixels"]
    assert "no-store" in statistics.headers["cache-control"]
    assert (
        client.post("/api/raster-analysis/pixels", json=pixel_request).status_code
        == 403
    )
    assert (
        client.post(
            "/api/raster-analysis/pixels",
            json=pixel_request,
            headers={**HEADERS, "Origin": "https://foreign.test"},
        ).status_code
        == 403
    )
    with TestClient(client.app, base_url="https://testserver") as foreign:
        denied_window = foreign.post(
            "/api/rendering/layers", json=publication_request, headers=HEADERS
        )
        assert denied_window.status_code == 404
        assert "no-store" in denied_window.headers["cache-control"]
        assert foreign.get(tile_url).status_code == 404
        assert (
            foreign.get("/geoserver/eolab/wms", params=map_query(layer)).status_code
            == 404
        )
        denied = foreign.get(url)
        assert denied.status_code == 404
        assert denied.json()["detail"]["code"] == "job_not_found"
        assert "no-store" in denied.headers["cache-control"]
        denied_pixel = foreign.post(
            "/api/raster-analysis/pixels", json=pixel_request, headers=HEADERS
        )
        assert denied_pixel.status_code == 404
        assert "no-store" in denied_pixel.headers["cache-control"]
        assert (
            foreign.post(
                "/api/raster-analysis/statistics",
                json=statistics_request,
                headers=HEADERS,
            ).status_code
            == 404
        )
    assert client.get(base + "/artifacts/" + "0" * 32 + "/preview").status_code == 404
    provenance = next(
        file for file in ready["artifacts"]["files"] if file["role"] == "provenance"
    )
    assert client.get(provenance["url"] + "/preview").status_code == 422
    assert client.get(file["url"]).status_code == 200
    if terminal == "delete":
        assert client.delete(base, headers=HEADERS).status_code == 200
    else:
        with psycopg.connect(store.conninfo) as connection:
            connection.execute(
                "UPDATE processing.jobs SET expires_at=now()-interval '1 second' WHERE id=%s",
                (job["jobId"],),
            )
    assert client.get(tile_url).status_code == 409
    assert (
        client.get("/geoserver/eolab/wms", params=map_query(layer)).status_code == 409
    )
    assert not client.portal.call(
        service.model_artifact_is_available, job["jobId"], file["artifactId"]
    )
    client.portal.call(client.app.state.output_publication.cleanup)
    assert client.get(url).status_code == 409
    assert (
        client.post(
            "/api/rendering/layers", json=publication_request, headers=HEADERS
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/raster-analysis/statistics", json=statistics_request, headers=HEADERS
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/raster-analysis/pixels", json=pixel_request, headers=HEADERS
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/raster-analysis/sources", json={"source": reference}, headers=HEADERS
        ).status_code
        == 409
    )
    with psycopg.connect(store.conninfo) as connection:
        assert (
            connection.execute("SELECT count(*) FROM processing.transfers").fetchone()[
                0
            ]
            == 0
        )
