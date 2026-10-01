"""Integration gate record (integration/risk). Runs Person A's official runner
`bash scripts/check-gate.sh Gn` unchanged, then the same technical checks it would run after its
predecessor-review check (every block task through scripts/check-task.sh, the combined forge gate
suite under FOUNDRY_PROFILE=risk, plus the gate's extra suites), and writes artifacts/gates/Gn.json
with both results. It never marks a gate reviewed by Person A.

usage: python3 scripts/integration/gate-record.py Gn [extra command ...]
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[2]
gate = sys.argv[1]
extras = sys.argv[2:]
if not re.fullmatch(r"G[0-7]", gate):
    sys.exit("usage: gate-record.py G0..G7 [extra shell command ...]")
index = int(gate[1])
blocks = [(1, 2), (3, 9), (10, 15), (16, 21), (22, 27), (28, 33), (34, 39), (40, 44)]
start, end = blocks[index]
tasks = [f"{lane}{n:03d}" for lane in "AB" for n in range(start, end + 1)]
env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}


def run(argv, cwd=root, extra_env=None, shell=False):
    p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, shell=shell,
                       env={**env, **(extra_env or {})})
    tail = (p.stdout + p.stderr).strip().splitlines()[-3:]
    return {"argv": argv, "cwd": str(Path(cwd).relative_to(root)) or ".", "exit_code": p.returncode, "tail": tail}


official = run(["bash", "scripts/check-gate.sh", gate])
official_record = json.loads((root / f"artifacts/gates/{gate}.json").read_text())
technical = []
for t in tasks:
    technical.append(run(["bash", "scripts/check-task.sh", t]))
technical.append(run(["forge", "test", "--match-path", f"test/gates/{gate}.t.sol"], root / "contracts",
                     {"FOUNDRY_PROFILE": "risk"}))
for cmd in extras:
    technical.append(run(cmd, shell=True))
ok = all(c["exit_code"] == 0 for c in technical)
commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()
dirty = bool(subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True).stdout.strip())
record = {
    "gate": gate,
    "recorded_at": datetime.now(timezone.utc).isoformat(),
    "branch": "integration/risk",
    "commit": commit,
    "worktree_dirty_after_runs": dirty,
    "official_runner": {"command": "bash scripts/check-gate.sh " + gate, "exit_code": official["exit_code"],
                        "status": official_record.get("status"), "reason": official_record.get("reason"),
                        "test_count": official_record.get("test_count")},
    "technical_checks": technical,
    "technical_status": "passed" if ok else "failed",
    "components": {"person_a": "real", "person_b": "real", "combined": "real (contracts/test/gates/%s.t.sol)" % gate,
                   "book": "mock (MockBookAdapter)", "price_source": "mock (test-fed observations)",
                   "oracle": "mock (MockResolutionAuthority)", "factory": "constructor fixture", "token": "MockUSDC"},
    "review": {"B": "integration agent for Person B", "A": "pending (not reviewed)"},
}
(root / f"artifacts/gates/{gate}.json").write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps({"gate": gate, "official_exit": official["exit_code"], "technical_status": record["technical_status"],
                  "failed": [c["argv"] for c in technical if c["exit_code"]]}, indent=1))
sys.exit(0 if ok else 1)
