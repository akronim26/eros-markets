#!/usr/bin/env bash
# Run from any directory. Python owns discovery/counting so an empty suite fails.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
export PYTHONHASHSEED=0
export PYTHONDONTWRITEBYTECODE=1
exec "${PYTHON:-python}" - "$root" "$@" <<'PY'
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import unittest
from datetime import datetime, timezone

root = Path(sys.argv[1]).resolve()
if len(sys.argv) != 3 or re.fullmatch(r"[AB](00[1-9]|0[1-3][0-9]|04[0-4])", sys.argv[2]) is None:
    print("usage: bash scripts/check-task.sh A001|...|A044|B001|...|B044", file=sys.stderr)
    sys.exit(2)
task = sys.argv[2]
lane, number = task[0], int(task[1:])
os.chdir(root)
sys.path.insert(0, str(root))
random.seed(0x45524F53)

def probe(command):
    try:
        result = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
        return result.stdout.strip() if result.returncode == 0 else None
    except OSError:
        return None

record = {
    "schema_version": "1.0",
    "kind": "task",
    "id": task,
    "scope": "task_checks_only",
    "spec_version": "1.1",
    "economic_baseline": "1.0",
    "interface_version": "risk-math-g0-draft-1",
    "recorded_at": datetime.now(timezone.utc).isoformat(),
    "source_commit": probe(["git", "rev-parse", "HEAD"]),
    "worktree_dirty": None,
    "toolchain": {"python": sys.version.split()[0], "forge": probe(["forge", "--version"]),
                  "solc_declared": "0.8.30", "foundry_profile": "risk",
                  "dependency_status": probe(["git", "submodule", "status"])},
    "seed": "0x45524f53",
    "python_hash_seed": "0",
    "fixture_hashes": {},
    "components": {"selected_suite": "real", "peer_lane": "not_exercised",
                   "external_counterparts": "not_exercised"},
    "commands": [],
    "test_count": 0,
    "skipped_count": 0,
    "status": "failed",
    "exit_code": 2,
    "reason": "",
    "checks": [],
    "artifacts": [f"artifacts/tasks/{task}.json"],
}
dirty = probe(["git", "status", "--porcelain", "--untracked-files=all"])
record["worktree_dirty"] = None if dirty is None else bool(dirty)

def hash_path(path):
    record["fixture_hashes"][path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()

for location in ("reference/common", "reference/fixtures", "contracts/src/math"):
    directory = root / location
    if directory.exists():
        for path in sorted(directory.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                hash_path(path)
for location in ("contracts/foundry.toml", "scripts/check-task.sh", ".gitmodules"):
    if (root / location).is_file():
        hash_path(root / location)

try:
    if number <= 9:
        directory = root / "reference" / "tests" / lane.lower()
        pattern = f"test_{task.lower()}.py"
        suite_path = directory / pattern
        if not suite_path.is_file():
            raise ValueError(f"missing suite: {suite_path.relative_to(root).as_posix()}")
        hash_path(suite_path)
        command = [sys.executable, "-m", "unittest", "discover", "-s",
                   directory.relative_to(root).as_posix(), "-p", pattern]
        suite = unittest.TestLoader().discover(str(directory), pattern=pattern)
        if suite.countTestCases() == 0:
            raise ValueError(f"empty suite: {pattern}")
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = unittest.TextTestRunner(stream=output, verbosity=2).run(suite)
        log = output.getvalue()
        print(log, end="")
        record["test_count"] = result.testsRun
        record["skipped_count"] = len(result.skipped)
        # A skipped, expected-failing or unexpectedly succeeding check is not acceptance.
        passed = result.wasSuccessful() and not result.skipped and not result.expectedFailures
        record["exit_code"] = 0 if passed else 1
        record["commands"].append({"argv": command, "cwd": ".", "exit_code": record["exit_code"],
                                   "execution": "in_process_unittest_discovery", "output": log})
    else:
        if number >= 40:
            # W7 includes campaigns, gas and review deliverables. A generic unit suite
            # cannot stand in for its task-specific acceptance implementation.
            raise ValueError(f"{task}: W7 campaign/review acceptance is not configured yet")
        family = "math" if number <= 15 else "risk"
        relative = f"test/{family}/{lane}/{task}.t.sol"
        suite_path = root / "contracts" / relative
        if not suite_path.is_file():
            raise ValueError(f"missing suite: contracts/{relative}")
        hash_path(suite_path)
        command = ["forge", "test", "--match-path", relative, "--json"]
        env = {**os.environ, "FOUNDRY_PROFILE": "risk"}
        run = subprocess.run(command, cwd=root / "contracts", env=env, capture_output=True, text=True)
        print(run.stdout, end="")
        print(run.stderr, end="", file=sys.stderr)
        record["commands"].append({"argv": command, "cwd": "contracts", "exit_code": run.returncode,
                                   "execution": "subprocess", "output": run.stdout + run.stderr})
        record["exit_code"] = run.returncode
        try:
            payload = json.loads(run.stdout)
        except ValueError:
            if run.returncode == 0:
                raise ValueError("forge returned no machine-readable test results")
            payload = {}
        results = [test for suite in payload.values() if isinstance(suite, dict)
                   for test in suite.get("test_results", {}).values()]
        record["test_count"] = len(results)
        record["skipped_count"] = sum(test.get("status") == "Skipped" for test in results)
        if run.returncode == 0 and (not results or any(test.get("status") != "Success" for test in results)):
            raise ValueError("forge returned no successful complete suite; missing/skipped tests fail")
    record["status"] = "passed" if record["exit_code"] == 0 else "failed"
except (OSError, ValueError, ImportError) as error:
    record["reason"] = str(error)
    record["exit_code"] = 2
    print(str(error), file=sys.stderr)

destination = root / record["artifacts"][0]
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
print(f"{task}: {record['status']}; {record['test_count']} tests; {record['artifacts'][0]}")
sys.exit(record["exit_code"])
PY
