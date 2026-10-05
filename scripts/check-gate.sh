#!/usr/bin/env bash
# A technical gate check never grants reviewer approval or writes an accepted SHA.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
export PYTHONHASHSEED=0
export PYTHONDONTWRITEBYTECODE=1
exec "${PYTHON:-python}" - "$root" "$BASH" "$@" <<'PY'
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
bash = sys.argv[2]
if len(sys.argv) != 4 or re.fullmatch(r"G[0-7]", sys.argv[3]) is None:
    print("usage: bash scripts/check-gate.sh G0|...|G7", file=sys.stderr)
    sys.exit(2)
gate = sys.argv[3]
index = int(gate[1])
blocks = [(1, 2), (3, 9), (10, 15), (16, 21), (22, 27), (28, 33), (34, 39), (40, 44)]
start, end = blocks[index]
tasks = [f"{lane}{n:03d}" for lane in "AB" for n in range(start, end + 1)]
os.chdir(root)

def probe(command):
    try:
        run = subprocess.run(command, cwd=root, capture_output=True, text=True)
        return run.stdout.strip() if run.returncode == 0 else None
    except OSError:
        return None

record = {
    "schema_version": "1.0", "kind": "gate", "id": gate,
    "scope": "combined_technical_checks_only", "spec_version": "1.1", "economic_baseline": "1.0",
    "interface_version": "risk-integration-1", "recorded_at": datetime.now(timezone.utc).isoformat(),
    "source_commit": probe(["git", "rev-parse", "HEAD"]), "worktree_dirty": None,
    "toolchain": {"python": sys.version.split()[0], "forge": probe(["forge", "--version"]),
                  "solc_declared": "0.8.30", "foundry_profile": "risk",
                  "dependency_status": probe(["git", "submodule", "status"])},
    "seed": "0x45524f53", "python_hash_seed": "0", "fixture_hashes": {},
    "components": {"lane_a": "not_exercised", "lane_b": "not_exercised",
                   "combined": "not_exercised", "external_counterparts": "not_exercised"},
    "commands": [], "test_count": 0, "skipped_count": 0,
    "status": "blocked", "exit_code": 2, "reason": "", "checks": [],
    "artifacts": [f"artifacts/gates/{gate}.json"],
    "merge_sha": None, "reviewed_by": [], "accepted": False,
}
dirty = probe(["git", "status", "--porcelain", "--untracked-files=all"])
record["worktree_dirty"] = None if dirty is None else bool(dirty)

def execute(argv, cwd, env=None):
    run = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True)
    print(run.stdout, end="")
    print(run.stderr, end="", file=sys.stderr)
    record["commands"].append({"argv": argv, "cwd": str(cwd.relative_to(root)) or ".",
                               "exit_code": run.returncode, "execution": "subprocess",
                               "output": run.stdout + run.stderr})
    return run

try:
    required = ["reference/common/units.py", "reference/common/result_schema.json",
                "contracts/src/math/MathTypes.sol", "docs/math/units.md",
                "docs/math/risk-function-contracts.json", "docs/ownership.json",
                "docs/counterpart-contracts.md", "reference/fixtures/golden_cases.json",
                "docs/math/golden-case-rationale.md", f"docs/contracts/{gate}.json",
                f"contracts/test/gates/{gate}.t.sol"]
    if gate == "G1":
        required.extend(["reference/integration/combined_trace.py", "reference/tests/integration/test_g1.py"])
    for task in tasks:
        n, lane = int(task[1:]), task[0]
        if n <= 9:
            required.append(f"reference/tests/{lane.lower()}/test_{task.lower()}.py")
        elif n <= 39:
            family = "math" if n <= 15 else "risk"
            required.append(f"contracts/test/{family}/{lane}/{task}.t.sol")
    missing = [path for path in required if not (root / path).is_file()]
    for path in required:
        if (root / path).is_file():
            record["fixture_hashes"][path] = hashlib.sha256((root / path).read_bytes()).hexdigest()
    if missing:
        raise ValueError("missing gate inputs: " + ", ".join(missing))
    if index:
        status_path = root / "docs" / "spec" / "gate_status.json"
        if not status_path.is_file():
            status_path = root / "gate_status.json"
        if not status_path.is_file():
            raise ValueError("missing accepted predecessor record: docs/spec/gate_status.json")
        statuses = json.loads(status_path.read_text(encoding="utf-8"))["gates"]
        previous = next((item for item in statuses if item["id"] == f"G{index - 1}"), None)
        if (not previous or previous.get("status") != "passed"
                or not re.fullmatch(r"[0-9a-f]{40}", previous.get("merge_sha") or "")):
            raise ValueError("previous gate has no accepted commit")
        ancestor = execute(["git", "merge-base", "--is-ancestor", previous["merge_sha"], "HEAD"], root)
        if ancestor.returncode:
            raise ValueError("working tree is not based on the accepted predecessor commit")
    record["status"] = "failed"
    for task in tasks:
        run = execute([bash, "scripts/check-task.sh", task], root)
        if run.returncode:
            raise ValueError(f"{task} acceptance failed (exit {run.returncode})")
        task_record = json.loads((root / f"artifacts/tasks/{task}.json").read_text(encoding="utf-8"))
        if (task_record.get("status") != "passed" or task_record.get("exit_code") != 0
                or task_record.get("test_count", 0) <= 0 or task_record.get("skipped_count", 0)):
            raise ValueError(f"{task} returned failed, empty or skipped checks")
        record["test_count"] += task_record["test_count"]
    record["components"].update(lane_a="real", lane_b="real")
    if gate == "G1":
        reference_run = execute([sys.executable, "-m", "unittest", "discover", "-s",
                                 "reference/tests/integration", "-t", "."], root)
        if reference_run.returncode:
            raise ValueError("combined reference trace failed")
        reference_count = re.search(r"Ran (\d+) tests?", reference_run.stderr)
        if not reference_count or int(reference_count[1]) == 0:
            raise ValueError("combined reference trace suite is empty")
        if not re.search(r"(?:^|\n)OK\s*\Z", reference_run.stderr):
            raise ValueError("combined reference trace suite is failed, skipped or incomplete")
        record["test_count"] += int(reference_count[1])
    sys.path.insert(0, str(root))
    from scripts.check_a_review import forge_environment, forge_results
    run = execute(["forge", "test", "--match-path", f"test/gates/{gate}.t.sol", "--json"],
                  root / "contracts", forge_environment())
    if run.returncode:
        raise ValueError(f"combined forge gate failed (exit {run.returncode})")
    results = [status for suite in forge_results(run.stdout).values() for status in suite.values()]
    if any(status != "Success" for status in results):
        raise ValueError("combined suite is empty, failed or skipped")
    record["test_count"] += len(results)
    record["components"]["combined"] = "real"
    if gate == "G7":
        from scripts.check_a_review import validate_technical_validation
        for task in ("A043", "B043"):
            validation = validate_technical_validation(root, task)
            record["fixture_hashes"].update(validation["source_hashes"])
            relative = validation["evidence"]
            record["fixture_hashes"][relative] = hashlib.sha256((root / relative).read_bytes()).hexdigest()
            record["artifacts"].append(relative)
    record.update(status="checks_passed", exit_code=0,
                  reason="Unified-team technical checks passed; not independent review or audit. Human acceptance remains separate.")
except (OSError, ValueError, KeyError, TypeError) as error:
    record["reason"] = str(error)
    print(str(error), file=sys.stderr)

destination = root / record["artifacts"][0]
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
print(f"{gate}: {record['status']}; accepted=false; {record['artifacts'][0]}")
sys.exit(record["exit_code"])
PY
