#!/usr/bin/env bash
# PROVISIONAL stand-in for Person A's A002 `scripts/check-task.sh` (does not exist on feat/risk).
# Runs the checks B defines for its W7 tasks and writes artifacts/acceptance/<TASK>.json with the
# real exit code of every step. A missing suite or artifact is a failure (nonzero exit).
# Usage: bash provisional/scripts/check-task.sh <TASK>
set -u
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK="${1:?task id}"
cd "$ROOT"
TSX="${TSX:-$HOME/.npm/_npx/ef9ef3f50c7d7dc1/node_modules/.bin/tsx}"

steps=()
codes=()
run() { # name, command
  local name="$1"; shift
  bash -c "$*" >"/tmp/check-$TASK-$name.log" 2>&1
  local c=$?
  steps+=("$name"); codes+=("$c")
  echo "[$name] exit $c: $*"
  tail -5 "/tmp/check-$TASK-$name.log"
}
need() { # file
  if [ -f "$1" ]; then steps+=("exists:$1"); codes+=(0); echo "[exists] $1"; else steps+=("exists:$1"); codes+=(1); echo "[missing] $1"; fi
}
json() { # file
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$1" >/dev/null 2>&1
  local c=$?; steps+=("json:$1"); codes+=("$c"); echo "[json] exit $c: $1"
}

case "$TASK" in
  B040)
    run forge "cd contracts && forge test --match-path test/integration/B/FullLifecycle.t.sol"
    need artifacts/risk/counterpart-status.json; json artifacts/risk/counterpart-status.json ;;
  B041)
    run forge "cd contracts && forge test --match-path test/gas/B/AdapterGas.t.sol"
    need artifacts/risk/gas-adapters.json; json artifacts/risk/gas-adapters.json ;;
  B042)
    if [ -x "$TSX" ]; then run sdk "$TSX --test packages/risk-sdk/test/read-model.test.ts"
    else steps+=("sdk"); codes+=(127); echo "[sdk] no TypeScript runner available"; fi
    need packages/risk-sdk/src/index.ts; need docs/app-state-fixtures.json; json docs/app-state-fixtures.json ;;
  B043)
    need artifacts/reviews/B-on-A.md ;;
  B044)
    need artifacts/risk/integration-release.json; json artifacts/risk/integration-release.json
    need docs/runbooks/lifecycle.md ;;
  *) echo "unknown task $TASK"; exit 2 ;;
esac

overall=0
for c in "${codes[@]}"; do [ "$c" -ne 0 ] && overall=1; done
mkdir -p artifacts/acceptance
python3 - "$TASK" "$overall" "$(git rev-parse HEAD)" "${#steps[@]}" "${steps[@]}" "${codes[@]}" <<'EOF'
import json, sys, datetime
task, overall, commit, n = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
names = sys.argv[5:5+n]; codes = [int(c) for c in sys.argv[5+n:5+2*n]]
rec = {
  "task": task,
  "runner": "provisional/scripts/check-task.sh (stand-in for A002 scripts/check-task.sh)",
  "commit": commit,
  "spec_version": "1.1",
  "steps": [{"step": a, "exit_code": b} for a, b in zip(names, codes)],
  "exit_code": overall,
  "counterparts": "all mocked or blocked; see artifacts/risk/counterpart-status.json",
  "person_a": "provisional stand-ins and scripted doubles; no real A module",
  "gate_credit": "none",
  "recorded_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
}
open(f"artifacts/acceptance/{task}.json", "w").write(json.dumps(rec, indent=1) + "\n")
EOF
echo "overall exit $overall"
exit $overall
