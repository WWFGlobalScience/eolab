"""Protect the Habitat administration page and its independent frontend entry."""

from importlib.resources import files
from importlib.resources.abc import Traversable
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.annotation_sessions.store import AnnotationSessionStore
from eolab_app.routes import shared_layer_admin

PASSWORD = "habitat-admin-page-test-password"


@pytest.mark.parametrize("password,expected", [("", 404), (PASSWORD, 401)])
def test_habitat_page_and_entry_require_administrator(
    password: str, expected: int
) -> None:
    """Protect the new page and script with the existing disabled/auth policy.

    Args:
        password: Existing administration setting, blank when disabled.
        expected: Rejection status before any frontend files are read.
    """
    app = FastAPI()
    app.include_router(
        shared_layer_admin.create_shared_layer_admin_router(
            AnnotationSessionStore(), password
        )
    )
    client = TestClient(app)
    for path in ("/admin-eolab/habitat", "/assets/habitat-admin.js"):
        response = client.get(path)
        assert response.status_code == expected
        assert response.headers["cache-control"] == "private, no-store"
        if password:
            assert response.headers["www-authenticate"] == (
                'Basic realm="EOLab administration"'
            )


def test_habitat_page_uses_protected_bundle_and_preserves_site_administration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Serve the built entry privately while retaining maps/layers administration.

    Args:
        tmp_path: Stand-in installed package containing the frontend entry asset.
        monkeypatch: Redirect only the bundle package to that explicit fixture.
    """
    asset = tmp_path / "static" / "assets" / "habitat-admin.js"
    asset.parent.mkdir(parents=True)
    asset.write_text("// installed Habitat administration bundle\n", encoding="utf-8")

    def package_files(package: str) -> Traversable:
        """Return real administration templates or the installed-bundle fixture.

        Args:
            package: Python package whose resource root is requested.

        Returns:
            The matching template or build-output resource directory.
        """
        return tmp_path if package == "eolab_app" else files(package)

    monkeypatch.setattr(shared_layer_admin, "files", package_files)
    app = FastAPI()
    app.include_router(
        shared_layer_admin.create_shared_layer_admin_router(
            AnnotationSessionStore(), PASSWORD
        )
    )
    client = TestClient(app)
    client.auth = ("admin", PASSWORD)
    page = client.get("/admin-eolab/habitat")
    assert page.status_code == 200
    assert "/assets/habitat-admin.js" in page.text
    assert "/admin-eolab/admin.css" in page.text
    assert page.headers["cache-control"] == "private, no-store"
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert PASSWORD not in page.text
    script = client.get("/assets/habitat-admin.js")
    assert script.status_code == 200
    assert script.text == asset.read_text(encoding="utf-8")
    assert script.headers["content-type"].startswith("text/javascript")
    assert script.headers["cache-control"] == "private, no-store"
    administration = client.get("/admin-eolab")
    assert administration.status_code == 200
    assert 'href="/admin-eolab/habitat"' in administration.text
    assert "Published maps" in administration.text
    assert "Shared layers" in administration.text
