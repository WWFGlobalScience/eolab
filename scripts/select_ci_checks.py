"""Select GitHub Actions checks from the files changed in a pull request or push."""

import argparse
from collections.abc import Iterable, Sequence
import fnmatch
import os
from pathlib import PurePosixPath
import subprocess
from typing import Literal

CHECK_NAMES = ("application", "reproducibility", "processing", "catalog")
DOCUMENTATION_FILES = {"README.md", "LICENSE", "AGENTS.md", ".gitignore"}
DOCUMENTATION_SUFFIXES = {
    ".md",
    ".markdown",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp",
    ".avif",
}
REPRODUCIBILITY_FILES = {
    "Dockerfile.app",
    ".dockerignore",
    "pyproject.toml",
    "frontend/package.json",
    "frontend/package-lock.json",
    "deployment/application-build-report.py",
    "deployment/build-beneficiaries.py",
    "deployment/beneficiaries-source.json",
}
PROCESSING_FILES = {
    "pyproject.toml",
    "deployment/build-beneficiaries.py",
    "deployment/beneficiaries-source.json",
    "scripts/processing_postgres_suite.py",
    "scripts/test_processing_postgres.py",
    "scripts/verify_processing_postgres.py",
}
CATALOG_FILES = {
    "docker-compose.yml",
    "Dockerfile.catalog-migrate",
    "deployment/application-runtime-requirements.txt",
    "tests/test_catalog_ingestion_postgres.py",
    "scripts/test_catalog_postgres.py",
    "scripts/test_processing_postgres.py",
}


def is_documentation_path(path: str) -> bool:
    """Identify prose and screenshot changes that do not need application tests.

    Args:
        path: Repository-relative Git path, using forward slashes.

    Returns:
        Whether the path is an explicitly named root document or a Markdown or
        image file under docs. Executable model examples remain test inputs.
    """
    return path in DOCUMENTATION_FILES or (
        path.startswith("docs/")
        and not path.startswith("docs/model-examples/")
        and PurePosixPath(path).suffix.lower() in DOCUMENTATION_SUFFIXES
    )


def select_checks(paths: Iterable[str]) -> dict[str, bool]:
    """Choose application, reproducibility and database checks for changed files.

    Application tests run for every non-documentation path, including unfamiliar
    paths. Reproducibility and database suites follow their existing build inputs
    and test launchers. Changes to CI selection itself run every check.

    Args:
        paths: Changed repository-relative Git paths, including deleted paths and
            both names of renamed files.

    Returns:
        Four Boolean choices named application, reproducibility, processing and
        catalog. An empty or documentation-only change selects no checks.
    """
    checks = dict.fromkeys(CHECK_NAMES, False)
    for path in paths:
        if path.startswith((".github/workflows/", ".github/tests/")) or path == (
            "scripts/select_ci_checks.py"
        ):
            return dict.fromkeys(CHECK_NAMES, True)
        if is_documentation_path(path):
            continue
        checks["application"] = True
        application_requirements = fnmatch.fnmatchcase(
            path, "deployment/application-*-requirements.txt"
        )
        if path in REPRODUCIBILITY_FILES or application_requirements:
            checks["reproducibility"] = True
        if (
            path.startswith(("src/", "tests/", "docs/model-examples/"))
            or path in PROCESSING_FILES
            or application_requirements
        ):
            checks["processing"] = True
        if path.startswith("catalog/") or path in CATALOG_FILES:
            checks["catalog"] = True
    return checks


def get_changed_paths(
    event: Literal["pull_request", "push"], base: str, head: str
) -> list[str]:
    """Read changed paths from the current Git checkout without rename detection.

    Pull requests compare the branch with its merge base; pushes compare the two
    revisions directly. Disabling rename detection includes both the old and new
    paths so moving code into a documentation directory cannot skip its tests.

    Args:
        event: GitHub event whose comparison semantics apply.
        base: Base revision available in the checkout's full history.
        head: Revision being tested, normally HEAD.

    Returns:
        Changed file paths, decoded with the filesystem's filename handling.

    Raises:
        subprocess.CalledProcessError: If Git cannot compare the revisions.
        OSError: If Git cannot be started.
    """
    revisions = [f"{base}...{head}"] if event == "pull_request" else [base, head]
    result = subprocess.run(
        ["git", "diff", "--name-only", "-z", "--no-renames", *revisions, "--"],
        check=True,
        stdout=subprocess.PIPE,
    )
    return [os.fsdecode(path) for path in result.stdout.split(b"\0") if path]


def main(argv: Sequence[str] | None = None) -> int:
    """Print four lowercase key=value choices suitable for GITHUB_OUTPUT.

    Missing or all-zero base revisions conservatively select every check. Manual
    dispatch also selects every check, with an option to omit the two cold builds.
    A real Git comparison failure exits unsuccessfully rather than skipping work.

    Args:
        argv: Command-line arguments, or None to read the process arguments.

    Returns:
        Zero after printing choices, or Git's nonzero comparison exit status.

    Raises:
        OSError: If Git cannot be started.
        SystemExit: If command-line arguments are invalid.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--event", required=True, choices=("pull_request", "push", "workflow_dispatch")
    )
    parser.add_argument("--base", default="")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--reproducibility", choices=("true", "false"), default="true")
    args = parser.parse_args(argv)
    if args.event == "workflow_dispatch":
        checks = dict.fromkeys(CHECK_NAMES, True)
        checks["reproducibility"] = args.reproducibility == "true"
    elif not args.base or not args.base.strip("0"):
        checks = dict.fromkeys(CHECK_NAMES, True)
    else:
        try:
            checks = select_checks(get_changed_paths(args.event, args.base, args.head))
        except subprocess.CalledProcessError as error:
            return error.returncode
    for name in CHECK_NAMES:
        print(f"{name}={str(checks[name]).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
