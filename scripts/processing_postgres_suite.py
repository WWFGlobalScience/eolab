"""Run the complete real Processing database lane, refusing silent skips."""

import argparse
from pathlib import Path

import pytest

SUITES = (
    "test_processing_jobs.py",
    "test_processing_calculations.py",
    "test_calculation_cache_postgres.py",
    "test_processing_events_postgres.py",
    "test_processing_area_limits.py",
    "test_processing_ground_area.py",
)


class RequiredDatabaseTests:
    """Require all database modules and successful execution without skips."""

    def __init__(self) -> None:
        """Initialize outcome tracking for one pytest invocation."""
        self.skipped = False

    def pytest_collection_finish(self, session: pytest.Session) -> None:
        """Reject missing modules or tests that lost their real store fixture.

        Args:
            session: Completed pytest collection.

        Raises:
            pytest.UsageError: If any required module or database fixture is absent.
        """
        present = {item.path.name for item in session.items}
        if not set(SUITES).issubset(present):
            raise pytest.UsageError(
                "The complete Processing PostgreSQL suite is required"
            )
        if any(
            item.path.name in SUITES and "store" not in item.fixturenames
            for item in session.items
        ):
            raise pytest.UsageError(
                "Every PostgreSQL test must use the real store fixture"
            )

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        """Remember skipped setup, call or teardown, including expected failures.

        Args:
            report: Outcome of a collected test phase.
        """
        self.skipped |= report.skipped

    def pytest_sessionfinish(self, session: pytest.Session) -> None:
        """Make any skipped test fail the automated lane.

        Args:
            session: Pytest result whose exit status is finalized here.
        """
        if self.skipped:
            session.exitstatus = pytest.ExitCode.TESTS_FAILED


def main() -> int:
    """Execute fixed database suites using an explicit disposable DSN.

    Returns:
        Pytest exit code, nonzero for failures, absent coverage or skips.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsn", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    return int(
        pytest.main(
            [
                "-c",
                str(root / "pyproject.toml"),
                "-o",
                "pythonpath=",
                "-o",
                "addopts=",
                "-p",
                "no:cacheprovider",
                "-ra",
                "--tb=short",
                f"--processing-dsn={args.dsn}",
                *(str(root / "tests" / name) for name in SUITES),
                str(root / "tests" / "test_processing_database_safety.py"),
            ],
            plugins=[RequiredDatabaseTests()],
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
