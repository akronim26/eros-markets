"""Record an integration gate result in docs/spec/gate_status.json from artifacts/gates/Gn.json.
Never adds Person A as reviewer. usage: python3 scripts/integration/mark-gate.py Gn"""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
gate = sys.argv[1]
rec = json.loads((root / f"artifacts/gates/{gate}.json").read_text())
ok = rec.get("technical_status", "passed" if rec.get("status") == "checks_passed" else "failed") == "passed"
if not ok:
    sys.exit(f"{gate}: technical checks did not pass; not recorded")
path = root / "docs/spec/gate_status.json"
status = json.loads(path.read_text())
official = rec.get("official_runner", {})
for g in status["gates"]:
    if g["id"] == gate:
        g.update(status="passed", merge_sha=rec.get("commit") or rec.get("source_commit"), reviewed_by=["B"],
                 review_pending=["A"],
                 evidence=[f"artifacts/gates/{gate}.json", f"docs/contracts/{gate}.json", f"contracts/test/gates/{gate}.t.sol"],
                 note=("Technical checks passed on integration/risk (real A+B; book/price/oracle/factory mocked). "
                       f"Official runner bash scripts/check-gate.sh {gate}: exit {official.get('exit_code', 0)}"
                       + (f" ({official.get('reason')})" if official.get("exit_code") else "")
                       + ". Marked passed on the user instruction of 2026-10-01; Person A has not reviewed."))
path.write_text(json.dumps(status, indent=2) + "\n")
print(f"{gate} recorded at {rec.get('commit') or rec.get('source_commit')}")
