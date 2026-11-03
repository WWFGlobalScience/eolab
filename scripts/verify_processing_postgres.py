"""Run the real database suite alongside failure and interruption cleanup checks."""

import argparse
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

from test_processing_postgres import LABEL, ROOT, docker


def verify_run(
    arguments: list[str],
    *,
    interrupt: bool = False,
    check_failure_isolation: bool = False,
) -> tuple[int, str]:
    """Execute a launcher and independently check that its resources disappear.

    Args:
        arguments: Launcher options, including optional failure injection.
        interrupt: Send SIGTERM after its real test container starts.
        check_failure_isolation: Run the existing injected failure after this
            runner starts and require its cleanup to leave this runner alive.

    Returns:
        Launcher exit status and unique run name after verified cleanup.

    Raises:
        RuntimeError: If startup, process completion or cleanup violates the contract.
        subprocess.TimeoutExpired: If a launcher or Docker command exceeds its deadline.
    """
    with tempfile.TemporaryDirectory(
        prefix="eolab-processing-verification-"
    ) as directory:
        log_path = Path(directory) / "launcher.log"
        log = log_path.open("w", encoding="utf-8")
        process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "scripts/test_processing_postgres.py"),
                *arguments,
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            if interrupt or check_failure_isolation:
                deadline = time.monotonic() + 1200
                while process.poll() is None and time.monotonic() < deadline:
                    started = re.search(
                        r"Processing test runner started: "
                        r"(eolab_processing_test_[0-9a-f]{32})",
                        log_path.read_text(encoding="utf-8"),
                    )
                    if started:
                        if interrupt:
                            process.send_signal(signal.SIGTERM)
                        break
                    time.sleep(0.2)
                else:
                    raise RuntimeError(
                        "Test runner did not reach its startup checkpoint"
                    )
                if check_failure_isolation:
                    failure_status, failure_name = verify_run(
                        [*arguments, "--inject-failure"]
                    )
                    if failure_status != 1:
                        raise RuntimeError(
                            "Injected pytest failure did not propagate exit status 1"
                        )
                    name = started[1]
                    if failure_name == name:
                        raise RuntimeError(
                            "Concurrent runs did not use distinct database identities"
                        )
                    if (
                        process.poll() is not None
                        or docker(
                            "inspect",
                            "--format",
                            "{{.State.Running}}",
                            name + "_runner",
                        )
                        != "true"
                    ):
                        raise RuntimeError(
                            "Failure cleanup did not leave the full test runner active"
                        )
                    print(
                        f"Verified concurrent failure cleanup preserved active suite: {name}",
                        flush=True,
                    )
            status = process.wait(timeout=1800)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=90)
            log.close()
            output = log_path.read_text(encoding="utf-8")
            print(output, flush=True)
        names = re.findall(
            r"Processing test run: (eolab_processing_test_[0-9a-f]{32})", output
        )
        if len(names) != 1:
            raise RuntimeError(
                "Expected exactly one uniquely identified disposable database"
            )
        name = names[0]
        if f"Processing test cleanup verified: {name}" not in output:
            raise RuntimeError(f"Cleanup was not confirmed for {name}")
        if docker("ps", "-aq", "--filter", f"label={LABEL}={name}") or docker(
            "network", "ls", "-q", "--filter", f"label={LABEL}={name}"
        ):
            raise RuntimeError(f"Resources survived launcher exit: {name}")
        return status, name


def main() -> int:
    """Exercise the real lifecycle acceptance checks on a Linux Docker host.

    Returns:
        Zero after the complete suite, concurrent failure and SIGTERM checks pass.

    Raises:
        RuntimeError: If any lifecycle acceptance check fails.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--application-image")
    args = parser.parse_args()
    if sys.platform == "win32":
        parser.error(
            "SIGTERM cleanup verification requires Linux; use the normal launcher on Windows"
        )
    options = (
        ["--application-image", args.application_image]
        if args.application_image
        else []
    )
    result = verify_run(options, check_failure_isolation=True)
    if result[0] != 0:
        raise RuntimeError(f"Complete PostgreSQL suite failed: {result}")
    if verify_run(options, interrupt=True)[0] != 130:
        raise RuntimeError("Interrupted launcher did not report exit status 130")
    print("Verified complete suite, concurrent failure isolation and SIGTERM cleanup")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
