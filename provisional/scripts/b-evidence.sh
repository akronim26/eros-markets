#!/usr/bin/env bash
# B-lane evidence recorder (provisional; replaced by A002 scripts/check-task.sh at merge).
# Usage: provisional/scripts/b-evidence.sh <TASK> <component-status> -- <command...>
# Runs the command from the repo root, captures exit code and output tail, and writes
# docs/merge/B-evidence/<TASK>.json and <TASK>.log. It never edits the result.
set -u
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK="$1"; STATUS="$2"; shift 2
[ "$1" = "--" ] && shift
CMD="$*"
OUT="$ROOT/docs/merge/B-evidence"
mkdir -p "$OUT"
cd "$ROOT"
LOG="$OUT/$TASK.log"
bash -c "$CMD" >"$LOG" 2>&1
CODE=$?
COMMIT="$(git rev-parse HEAD)"
DIRTY="$(git status --porcelain | grep -v '^?? docs/merge/B-evidence/' | wc -l | tr -d ' ')"
python3 - "$TASK" "$CMD" "$CODE" "$COMMIT" "$DIRTY" "$STATUS" "$LOG" <<'EOF'
import json, sys, datetime, pathlib
task, cmd, code, commit, dirty, status, log = sys.argv[1:]
lines = pathlib.Path(log).read_text(errors="replace").splitlines()
rec = {
    "task": task,
    "commit": commit,
    "working_tree_dirty_files": int(dirty),
    "spec_version": "1.1",
    "economic_baseline": "1.0",
    "interface_version": "pre-G0 B-side proposal (no gate recorded in docs/spec/gate_status.json)",
    "command": cmd,
    "exit_code": int(code),
    "output_tail": lines[-25:],
    "component_status": status,
    "recorded_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "gate_credit": "none; lane result only, not a gate pass",
}
pathlib.Path(log).with_suffix(".json").write_text(json.dumps(rec, indent=1) + "\n")
print(json.dumps({"task": task, "exit_code": int(code), "commit": commit}))
EOF
exit $CODE
