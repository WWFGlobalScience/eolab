"""Run the catalog concurrency regressions in the deployment's pinned pgSTAC images."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import io
import os
from pathlib import Path
import re
import signal
import subprocess
import tarfile
import tempfile
import time
from typing import Iterator
from urllib.parse import urlsplit
from uuid import uuid4
import xml.etree.ElementTree as ET

from test_processing_postgres import docker

ROOT = Path(__file__).resolve().parents[1]
LABEL = "org.eolab.catalog-test"


def deployment_images() -> tuple[str, str]:
    """Read the exact database and migration image pins already used by deployment.

    Returns:
        Database and Python migration image references, including their digests.

    Raises:
        ValueError: If either deployment image is missing its expected digest pin.
    """
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    migration_recipe = (ROOT / "Dockerfile.catalog-migrate").read_text(encoding="utf-8")
    database = re.search(
        r"(?m)^\s+image:\s+(ghcr\.io/stac-utils/pgstac-postgres:v0\.9\.12@sha256:[0-9a-f]{64})\s*$",
        compose,
    )
    migration = re.search(
        r"(?m)^FROM (ghcr\.io/stac-utils/pgstac-pypgstac:v0\.9\.12@sha256:[0-9a-f]{64})\s*$",
        migration_recipe,
    )
    if database is None or migration is None:
        raise ValueError(
            "Catalog tests require the deployment's pgSTAC 0.9.12 digest pins"
        )
    return database.group(1), migration.group(1)


def build_test_image() -> str:
    """Build the catalog tests with the application's supported Python and psycopg.

    Returns:
        Unique test-only image tag owned and removed by this launcher.

    Raises:
        ValueError: If the deployment's exact psycopg version cannot be found.
        subprocess.CalledProcessError: If image construction fails.
        subprocess.TimeoutExpired: If the build exceeds ten minutes.
    """
    runtime = (ROOT / "deployment/application-runtime-requirements.txt").read_text(
        encoding="utf-8"
    )
    version = re.search(r"(?m)^psycopg==([0-9.]+)\s", runtime)
    if version is None:
        raise ValueError("Catalog tests require the deployment's exact psycopg pin")
    recipe = (
        "FROM python:3.12-slim-trixie\n"
        "USER root\nWORKDIR /suite\n"
        "RUN python -m pip install --no-cache-dir 'pytest==8.4.2' "
        f"'psycopg[binary]=={version.group(1)}'\n"
        "COPY tests/test_catalog_ingestion_postgres.py /suite/tests/\n"
        "COPY catalog/migrations/ /suite/catalog/migrations/\n"
        "ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 "
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1\n"
        "ENTRYPOINT []\nHEALTHCHECK NONE\n"
    )
    tag = "eolab-catalog-test:" + uuid4().hex
    try:
        with tempfile.TemporaryFile() as context:
            with tarfile.open(fileobj=context, mode="w") as archive:
                encoded = recipe.encode()
                entry = tarfile.TarInfo("Dockerfile")
                entry.size = len(encoded)
                archive.addfile(entry, io.BytesIO(encoded))
                paths = [ROOT / "tests/test_catalog_ingestion_postgres.py"]
                paths.extend((ROOT / "catalog/migrations").glob("*.sql"))
                for path in sorted(paths):
                    archive.add(path, arcname=path.relative_to(ROOT), recursive=False)
            context.seek(0)
            subprocess.run(
                ["docker", "build", "--pull", "--tag", tag, "-"],
                stdin=context,
                check=True,
                timeout=600,
            )
    except BaseException:
        subprocess.run(["docker", "image", "rm", tag], timeout=30, check=False)
        raise
    return tag


@contextmanager
def disposable_database(database_image: str) -> Iterator[tuple[str, str, str]]:
    """Own a private network and tmpfs pgSTAC database, with exact-name cleanup.

    Args:
        database_image: Pinned database image already used by application deployment.

    Yields:
        Unique run name, network name and explicitly disposable connection string.

    Raises:
        RuntimeError: If database startup or cleanup verification fails.
        subprocess.CalledProcessError: If Docker rejects an infrastructure operation.
    """
    name = "eolab_catalog_test_" + uuid4().hex
    network = name + "_network"
    password = uuid4().hex
    print(f"Catalog test run: {name}", flush=True)
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
            "768m",
            "--env",
            f"POSTGRES_DB={name}",
            "--env",
            "POSTGRES_USER=catalog_test",
            "--env",
            f"POSTGRES_PASSWORD={password}",
            database_image,
        )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            ready = subprocess.run(
                [
                    "docker",
                    "exec",
                    name,
                    "pg_isready",
                    "-U",
                    "catalog_test",
                    "-d",
                    name,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            if ready.returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("Disposable pgSTAC database did not become ready")
        yield name, network, (
            f"postgresql://catalog_test:{password}@database:5432/{name}?connect_timeout=3"
        )
    finally:
        for container in (name + "_runner", name + "_migrate", name):
            subprocess.run(
                ["docker", "rm", "--force", "--volumes", container],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
                check=False,
            )
        subprocess.run(
            ["docker", "network", "rm", network],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
        )
        if docker("ps", "-aq", "--filter", f"label={LABEL}={name}") or docker(
            "network", "ls", "-q", "--filter", f"label={LABEL}={name}"
        ):
            raise RuntimeError(f"Disposable catalog resources remain for {name}")
        print(f"Catalog test cleanup verified: {name}", flush=True)


def run_suite(
    image: str, database_image: str, migration_image: str, *, baseline: bool
) -> int:
    """Initialize the real upstream schema and run either the fix or baseline regression.

    On POSIX hosts the test container uses the launcher's user and group so it can
    write the private results directory without Linux capability overrides.

    Args:
        image: Test-only image containing pytest, source tests and application SQL.
        database_image: Pinned deployment database image.
        migration_image: Pinned deployment image used only to initialize upstream SQL.
        baseline: Omit migration 0007 and run the expected-failing cold race alone.

    Returns:
        Pytest's exact exit status after logs are printed and owned resources removed.

    Raises:
        subprocess.CalledProcessError: If schema installation or Docker execution fails.
        subprocess.TimeoutExpired: If a Docker command exceeds its bounded deadline.
    """
    with disposable_database(database_image) as (name, network, dsn):
        docker(
            "run",
            "--name",
            name + "_migrate",
            "--label",
            f"{LABEL}={name}",
            "--network",
            network,
            "--entrypoint",
            "pypgstac",
            "--env",
            "PGHOST=database",
            "--env",
            "PGPORT=5432",
            "--env",
            "PGUSER=catalog_test",
            "--env",
            f"PGPASSWORD={urlsplit(dsn).password}",
            "--env",
            f"PGDATABASE={name}",
            migration_image,
            "migrate",
            timeout=180,
            capture=False,
        )
        command = [
            "-m",
            "pytest",
            "-c",
            "/dev/null",
            "-p",
            "no:cacheprovider",
            "-v",
            "-ra",
            "--tb=short",
            "--junitxml=/results/catalog-results.xml",
            "/suite/tests/test_catalog_ingestion_postgres.py",
        ]
        if baseline:
            command.extend(["-k", "test_parallel_cold_ingestion"])
            print(
                "Running the unpatched baseline; this regression must fail", flush=True
            )
        initializer = (
            "import os,sys; from pathlib import Path; import psycopg; "
            "c=psycopg.connect(os.environ['EOLAB_CATALOG_TEST_DSN'],autocommit=True); "
            "[c.execute(p.read_text(),prepare=False) for p in "
            "sorted(Path('/suite/catalog/migrations').glob('*.sql')) "
            "if not p.name.startswith('0007_')]; c.close(); "
            f"os.execvp(sys.executable,[sys.executable,*{command!r}])"
        )
        with tempfile.TemporaryDirectory(prefix="eolab-catalog-results-") as directory:
            runner_user = (
                f"{os.getuid()}:{os.getgid()}" if os.name == "posix" else "0:0"
            )
            docker(
                "run",
                "--detach",
                "--name",
                name + "_runner",
                "--label",
                f"{LABEL}={name}",
                "--network",
                network,
                "--user",
                runner_user,
                "--read-only",
                "--tmpfs",
                "/tmp:rw,size=128m",
                "--mount",
                f"type=bind,source={Path(directory).resolve()},target=/results",
                "--memory",
                "512m",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--env",
                f"EOLAB_CATALOG_TEST_DSN={dsn}",
                "--env",
                f"EOLAB_CATALOG_TEST_BASELINE={int(baseline)}",
                image,
                "python",
                "-c",
                initializer,
            )
            try:
                status = int(docker("wait", name + "_runner", timeout=180))
            finally:
                docker("logs", name + "_runner", timeout=30, capture=False)
            report = Path(directory) / "catalog-results.xml"
            suites = ET.parse(report).getroot().iter("testsuite")
            if any(int(suite.attrib.get("skipped", "0")) for suite in suites):
                raise RuntimeError("The real catalog suite must not skip any tests")
        return status


def interrupt(signum: int, frame: object) -> None:
    """Unwind the launcher's owned Docker resources after a catchable termination.

    Args:
        signum: Received termination signal.
        frame: Interrupted interpreter frame.

    Raises:
        KeyboardInterrupt: Always, so cleanup runs before the launcher exits.
    """
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    raise KeyboardInterrupt


def main() -> int:
    """Run the authoritative catalog regression command or its unpatched reproduction.

    Returns:
        Zero for a passing fix, pytest failure for the baseline, or 130 if interrupted.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--baseline",
        action="store_true",
        help="Omit migration 0007 and demonstrate the original four-writer failure",
    )
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    database_image, migration_image = deployment_images()
    image = None
    try:
        docker("pull", database_image, timeout=300, capture=False)
        image = build_test_image()
        return run_suite(image, database_image, migration_image, baseline=args.baseline)
    except KeyboardInterrupt:
        return 130
    finally:
        if image:
            docker("image", "rm", image)


if __name__ == "__main__":
    raise SystemExit(main())
