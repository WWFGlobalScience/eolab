"""Verify CI selection through its CLI using independent temporary Git history."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SELECTOR = Path(__file__).resolve().parents[2] / "scripts" / "select_ci_checks.py"
CHECK_NAMES = {"application", "reproducibility", "processing", "catalog"}


class SelectCiChecksTests(unittest.TestCase):
    """Exercise changed-file and event behavior without touching checkout history."""

    def setUp(self) -> None:
        """Create a private repository with an initial documentation commit."""
        temporary = tempfile.TemporaryDirectory(prefix="eolab-ci-selection-")
        self.addCleanup(temporary.cleanup)
        self.repository = Path(temporary.name)
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "CI selection fixture")
        self.git("config", "user.email", "ci-fixture@example.invalid")
        self.baseline = self.commit_files({"README.md": "Initial documentation\n"})

    def git(self, *arguments: str) -> str:
        """Run Git only inside this test's temporary repository.

        Args:
            arguments: Git subcommand and its arguments.

        Returns:
            Standard output with surrounding whitespace removed.

        Raises:
            subprocess.CalledProcessError: If the fixture command fails.
            subprocess.TimeoutExpired: If Git does not finish within 30 seconds.
        """
        return subprocess.run(
            [
                "git",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.autocrlf=false",
                "-C",
                str(self.repository),
                *arguments,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout.strip()

    def commit_files(self, changes: dict[str, str | None]) -> str:
        """Commit specified file contents or deletions in the fixture repository.

        Args:
            changes: Repository-relative paths mapped to contents, or None to delete.

        Returns:
            Commit SHA containing the requested changes.

        Raises:
            OSError: If a fixture file cannot be written or removed.
            subprocess.CalledProcessError: If Git cannot record the changes.
            subprocess.TimeoutExpired: If a Git command exceeds its deadline.
        """
        for name, contents in changes.items():
            path = self.repository / name
            if contents is None:
                path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(contents, encoding="utf-8")
        self.git("add", "--all")
        self.git("commit", "--no-gpg-sign", "-m", "Update fixture inputs")
        return self.git("rev-parse", "HEAD")

    def run_selector(
        self,
        event: str = "pull_request",
        *,
        base: str | None = None,
        head: str = "HEAD",
        reproducibility: bool | None = None,
    ) -> subprocess.CompletedProcess[str]:
        """Execute the public selector CLI against the temporary Git repository.

        Args:
            event: GitHub event supplied to the CLI.
            base: Comparison commit, defaulting to the fixture's initial commit.
            head: Comparison endpoint, defaulting to the current fixture commit.
            reproducibility: Optional manual choice; omit to test the CLI default.

        Returns:
            Completed CLI process, including its exact output and exit status.

        Raises:
            OSError: If the Python interpreter cannot be launched.
            subprocess.TimeoutExpired: If the CLI exceeds 30 seconds.
        """
        command = [
            sys.executable,
            "-B",
            str(SELECTOR),
            "--event",
            event,
            "--base",
            self.baseline if base is None else base,
            "--head",
            head,
        ]
        if reproducibility is not None:
            command.extend(
                ["--reproducibility", "true" if reproducibility else "false"]
            )
        return subprocess.run(
            command,
            cwd=self.repository,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def assert_selection(
        self,
        enabled: set[str],
        event: str = "pull_request",
        *,
        base: str | None = None,
        head: str = "HEAD",
        reproducibility: bool | None = None,
    ) -> None:
        """Check success and the complete four-Boolean public output contract.

        Args:
            enabled: Names of checks expected to be selected.
            event: GitHub event supplied to the CLI.
            base: Comparison commit, defaulting to the initial fixture commit.
            head: Comparison endpoint, defaulting to the current fixture commit.
            reproducibility: Optional manual choice passed unchanged to the CLI.
        """
        result = self.run_selector(
            event, base=base, head=head, reproducibility=reproducibility
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 4, result.stdout)
        decisions = dict(line.split("=", 1) for line in lines)
        self.assertEqual(set(decisions), CHECK_NAMES)
        self.assertTrue(all(value in {"true", "false"} for value in decisions.values()))
        self.assertEqual(
            {name for name, value in decisions.items() if value == "true"}, enabled
        )

    def test_representative_inputs_select_their_owning_checks(self) -> None:
        """Cover omitted runtime paths and independent build/database dependencies."""
        application_processing = {"application", "processing"}
        cases = (
            ("src/eolab_app/raster/models.py", application_processing),
            ("tests/test_temporal_source_access.py", application_processing),
            ("frontend/src/catalog/catalog-pane.js", {"application"}),
            ("frontend/package-lock.json", {"application", "reproducibility"}),
            ("Dockerfile.app", {"application", "reproducibility"}),
            (".dockerignore", {"application", "reproducibility"}),
            ("deployment/application-runtime-requirements.txt", CHECK_NAMES),
            (
                "deployment/application-gdal-requirements.txt",
                {"application", "reproducibility", "processing"},
            ),
            (
                "deployment/build-beneficiaries.py",
                {"application", "reproducibility", "processing"},
            ),
            (
                "catalog/migrations/0007_partition_maintenance_locking.sql",
                {"application", "catalog"},
            ),
            ("Dockerfile.catalog-migrate", {"application", "catalog"}),
            ("docker-compose.yml", {"application", "catalog"}),
            (
                "scripts/test_processing_postgres.py",
                {"application", "processing", "catalog"},
            ),
            ("scripts/test_catalog_postgres.py", {"application", "catalog"}),
            ("docs/model-examples/raster-summary.run.yaml", application_processing),
            (".github/workflows/application-build-inputs.yml", CHECK_NAMES),
            (".github/tests/test_select_ci_checks.py", CHECK_NAMES),
            ("scripts/select_ci_checks.py", CHECK_NAMES),
            ("future-component/input.new-format", {"application"}),
        )
        for name, enabled in cases:
            with self.subTest(path=name):
                base = self.git("rev-parse", "HEAD")
                self.commit_files({name: "Representative changed input\n"})
                self.assert_selection(enabled, base=base)

    def test_documentation_only_changes_and_no_changes_skip_work(self) -> None:
        """Leave prose, screenshots and an unchanged tree out of expensive suites."""
        self.assert_selection(set())
        self.commit_files(
            {
                "README.md": "Updated usage guidance\n",
                "docs/habitat-condition.md": "Model usage notes\n",
                "docs/images/model-card.png": "Screenshot fixture bytes\n",
            }
        )
        self.assert_selection(set())
        self.assert_selection(set(), event="push")

    def test_documentation_does_not_hide_a_runtime_change(self) -> None:
        """Select application coverage when one commit mixes prose and code."""
        self.commit_files(
            {
                "README.md": "Updated usage guidance\n",
                "src/eolab_app/raster/models.py": "Runtime change\n",
            }
        )
        self.assert_selection({"application", "processing"})

    def test_renaming_code_to_documentation_keeps_the_old_path(self) -> None:
        """Treat removing runtime code as relevant even when its new path is prose."""
        base = self.commit_files({"src/eolab_app/retired.py": "Retained contents\n"})
        (self.repository / "docs").mkdir()
        self.git("mv", "src/eolab_app/retired.py", "docs/retired.md")
        self.git("commit", "--no-gpg-sign", "-m", "Move fixture contents")
        self.assert_selection({"application", "processing"}, base=base)

    def test_deleted_code_still_selects_its_checks(self) -> None:
        """Detect deleted files without relying on their presence in the worktree."""
        base = self.commit_files({"src/eolab_app/deleted.py": "Runtime input\n"})
        self.commit_files({"src/eolab_app/deleted.py": None})
        self.assert_selection({"application", "processing"}, base=base)

    def test_pull_requests_use_the_merge_base_when_the_base_advances(self) -> None:
        """Exclude base-only changes for PRs while pushes compare exact endpoints."""
        self.git("checkout", "-b", "fixture-feature")
        feature = self.commit_files({"README.md": "Feature documentation\n"})
        self.git("checkout", "main")
        advanced_base = self.commit_files(
            {"src/eolab_app/raster/models.py": "Base branch runtime change\n"}
        )
        self.assert_selection(set(), base=advanced_base, head=feature)
        self.assert_selection(
            {"application", "processing"},
            event="push",
            base=advanced_base,
            head=feature,
        )

    def test_pushes_include_all_changes_since_the_before_commit(self) -> None:
        """Include earlier code changes when the final pushed commit changes prose."""
        self.commit_files({"src/eolab_app/raster/models.py": "Runtime change\n"})
        self.commit_files({"README.md": "Later documentation change\n"})
        self.assert_selection({"application", "processing"}, event="push")

    def test_manual_dispatch_runs_all_or_omits_only_reproducibility(self) -> None:
        """Preserve full manual verification and the explicit regular-check option."""
        self.assert_selection(CHECK_NAMES, event="workflow_dispatch")
        self.assert_selection(
            {"application", "processing", "catalog"},
            event="workflow_dispatch",
            reproducibility=False,
        )

    def test_manual_reproducibility_choice_does_not_override_changed_inputs(
        self,
    ) -> None:
        """Require build-input checks on PRs and pushes regardless of a manual flag."""
        self.commit_files({"Dockerfile.app": "Changed base image pin\n"})
        for event in ("pull_request", "push"):
            with self.subTest(event=event):
                self.assert_selection(
                    {"application", "reproducibility"},
                    event=event,
                    reproducibility=False,
                )

    def test_missing_or_zero_base_conservatively_selects_all_checks(self) -> None:
        """Avoid skipping coverage for events without a usable comparison commit."""
        for event in ("pull_request", "push"):
            for base in ("", "0" * 40):
                with self.subTest(event=event, base=base):
                    self.assert_selection(CHECK_NAMES, event=event, base=base)

    def test_git_errors_fail_without_emitting_successful_decisions(self) -> None:
        """Propagate invalid comparison references instead of quietly skipping work."""
        for base, head in (("missing-base", "HEAD"), (self.baseline, "missing-head")):
            with self.subTest(base=base, head=head):
                result = self.run_selector(base=base, head=head)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(result.stderr.strip())
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
