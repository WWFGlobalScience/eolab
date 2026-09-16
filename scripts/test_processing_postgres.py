"""Provision isolated Docker resources for the real Processing PostgreSQL tests."""

import argparse
from contextlib import contextmanager
import io
from pathlib import Path
import signal
import subprocess
import tarfile
import tempfile
import time
from typing import Iterator
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
LABEL = "org.eolab.processing-test"
POSTGRES_IMAGE = "postgres:16-bookworm"


def docker(*args: str, timeout: int = 120, capture: bool = True) -> str:
    """Run one bounded Docker command without shell interpolation.

    Args:
        args: Docker CLI arguments.
        timeout: Maximum command duration in seconds.
        capture: Capture output instead of streaming build/test logs.

    Returns:
        Captured standard output, or an empty string for streamed commands.

    Raises:
        subprocess.CalledProcessError: If Docker reports failure.
        subprocess.TimeoutExpired: If the command exceeds its deadline.
    """
    result = subprocess.run(
        ["docker", *args],
        check=True,
        text=True,
        timeout=timeout,
        stdout=subprocess.PIPE if capture else None,
    )
    return (result.stdout or "").strip()


def build_image(application_image: str | None) -> str:
    """Build a uniquely tagged test image from an allowlisted tar context.

    Args:
        application_image: Optional installed application image to verify unchanged.

    Returns:
        Test-only image tag; the caller must remove it after use.

    Raises:
        ValueError: If the image reference contains Dockerfile control characters.
        subprocess.CalledProcessError: If image construction fails.
    """
    if application_image and any(c.isspace() for c in application_image):
        raise ValueError("Application image must be a single Docker image reference")
    base = application_image or "python:3.12-slim-trixie"
    recipe = f"FROM {base}\nUSER root\nWORKDIR /suite\n"
    if not application_image:
        recipe += (
            "RUN apt-get update && apt-get install -y --no-install-recommends "
            "libexpat1 g++ libgdal-dev=3.10.3+dfsg-1 "
            "&& rm -rf /var/lib/apt/lists/*\n"
            "COPY pyproject.toml README.md LICENSE ./\nCOPY src/ ./src/\n"
            "RUN python -m pip install --no-cache-dir .\n"
        )
    recipe += (
        "RUN python -m venv --system-site-packages /test-venv "
        "&& /test-venv/bin/python -m pip install --no-cache-dir 'pytest==8.4.2'\n"
        "COPY pyproject.toml ./\nCOPY tests/ ./tests/\nCOPY scripts/ ./scripts/\n"
        "ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1\n"
        'ENV PYTHONPATH="" PYTEST_ADDOPTS=""\n'
        "USER 65534:65534\nENTRYPOINT []\nHEALTHCHECK NONE\n"
    )
    tag = f"eolab-processing-test:{uuid4().hex}"
    try:
        with tempfile.TemporaryFile() as context:
            with tarfile.open(fileobj=context, mode="w") as archive:
                encoded = recipe.encode()
                entry = tarfile.TarInfo("Dockerfile")
                entry.size = len(encoded)
                archive.addfile(entry, io.BytesIO(encoded))
                paths = [
                    ROOT / name for name in ("pyproject.toml", "README.md", "LICENSE")
                ]
                paths += list((ROOT / "tests").rglob("*.py"))
                paths += [ROOT / "scripts" / "processing_postgres_suite.py"]
                if not application_image:
                    paths += list((ROOT / "src").rglob("*.py"))
                    paths += list((ROOT / "src").rglob("*.sql"))
                for path in sorted(paths):
                    if path.is_symlink():
                        raise ValueError(
                            f"Test build input must not be a symlink: {path}"
                        )
                    archive.add(path, arcname=path.relative_to(ROOT), recursive=False)
            context.seek(0)
            subprocess.run(
                ["docker", "build", "--tag", tag, "-"],
                stdin=context,
                check=True,
                timeout=900,
            )
    except BaseException:
        subprocess.run(["docker", "image", "rm", tag], timeout=30, check=False)
        raise
    return tag


@contextmanager
def disposable_database() -> Iterator[tuple[str, str, str]]:
    """Own one private network and PostgreSQL container, including failed startup.

    Yields:
        Unique run name, network name and explicit disposable DSN.

    Raises:
        RuntimeError: If PostgreSQL is not ready within sixty seconds.
        subprocess.CalledProcessError: If provisioning or verified cleanup fails.
    """
    name = f"eolab_processing_test_{uuid4().hex}"
    network = name + "_network"
    password = uuid4().hex
    print(f"Processing test run: {name}", flush=True)
    try:
        docker("network", "create", "--internal", "--label", f"{LABEL}={name}", network)
        docker(
            "run",
            "--detach",
            "--name",
            name,
            "--label",
            f"{LABEL}={name}",
            "--network",
            network,
            "--network-alias",
            "database",
            "--tmpfs",
            "/var/lib/postgresql/data:rw",
            "--memory",
            "512m",
            "--env",
            f"POSTGRES_DB={name}",
            "--env",
            "POSTGRES_USER=processing_test",
            "--env",
            f"POSTGRES_PASSWORD={password}",
            POSTGRES_IMAGE,
        )
        for _ in range(60):
            ready = subprocess.run(
                [
                    "docker",
                    "exec",
                    name,
                    "pg_isready",
                    "-U",
                    "processing_test",
                    "-d",
                    name,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Disposable PostgreSQL did not become ready")
        yield name, network, (
            f"postgresql://processing_test:{password}@database:5432/{name}?connect_timeout=3"
        )
    finally:
        # Removal is limited to exact, generated names; never prune shared resources.
        for container in (name + "_runner", name):
            subprocess.run(
                ["docker", "rm", "--force", "--volumes", container],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
            )
        subprocess.run(
            ["docker", "network", "rm", network],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
        if docker("ps", "-aq", "--filter", f"label={LABEL}={name}") or docker(
            "network", "ls", "-q", "--filter", f"label={LABEL}={name}"
        ):
            raise RuntimeError(f"Disposable resources remain for {name}")
        print(f"Processing test cleanup verified: {name}", flush=True)


def run_suite(image: str, *, inject_failure: bool = False) -> int:
    """Run the installed application tests within one disposable database lifetime.

    Args:
        image: Prepared test image.
        inject_failure: Exercise failure cleanup with a deliberately failing command.

    Returns:
        Container exit status.

    Raises:
        subprocess.CalledProcessError: If Docker execution fails.
    """
    with disposable_database() as (name, network, dsn):
        command = [
            "/test-venv/bin/python",
            "/suite/scripts/processing_postgres_suite.py",
            "--dsn",
            dsn,
        ]
        if inject_failure:
            command = [
                "/test-venv/bin/python",
                "-c",
                "from pathlib import Path; import pytest; "
                "p=Path('/tmp/test_injected.py'); "
                "p.write_text('def test_injected_failure():\\n    assert False\\n'); "
                "raise SystemExit(pytest.main(['-p','no:cacheprovider',str(p)]))",
            ]
        docker(
            "run",
            "--detach",
            "--name",
            name + "_runner",
            "--label",
            f"{LABEL}={name}",
            "--network",
            network,
            "--read-only",
            "--tmpfs",
            # Keep capacity above Processing's existing 2 GiB free-space floor.
            "/tmp:rw,exec,size=4g",
            "--memory",
            "2g",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            image,
            *command,
        )
        print(f"Processing test runner started: {name}", flush=True)
        status = int(docker("wait", name + "_runner", timeout=600))
        docker("logs", name + "_runner", capture=False)
        return status


def interrupt(signum: int, frame: object) -> None:
    """Unwind owned resources on a catchable termination signal.

    Args:
        signum: Received signal number.
        frame: Interrupted interpreter frame.

    Raises:
        KeyboardInterrupt: Always, allowing finally blocks to clean up.
    """
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    raise KeyboardInterrupt


def main() -> int:
    """Build and execute the authoritative disposable PostgreSQL command.

    Returns:
        Zero for success, nonzero for test, infrastructure or interruption failure.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--application-image", help="Verify this installed application image"
    )
    parser.add_argument("--inject-failure", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    image = None
    try:
        image = build_image(args.application_image)
        docker("pull", POSTGRES_IMAGE, timeout=300, capture=False)
        return run_suite(image, inject_failure=args.inject_failure)
    except KeyboardInterrupt:
        return 130
    finally:
        if image:
            docker("image", "rm", image)


if __name__ == "__main__":
    raise SystemExit(main())
