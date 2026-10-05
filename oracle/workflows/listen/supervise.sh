#!/usr/bin/env bash
# Runs durable, bounded log polling and invokes the real CRE CLI for each request.
# Checkpoints survive restarts. See README.md for replay and dry-run settings.
#
#   oracle/workflows/listen/supervise.sh [log-dir]
#
#   TARGET        workflow.yaml target (default local-sim)
#   RESTART_SECS  pause before a restart (default 10)
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
workflows="$(dirname "$here")"
logs="${1:-$workflows/listen/logs}"
pause="${RESTART_SECS:-10}"
export CRE_BIN="${CRE_BIN:-$(command -v cre || echo "$HOME/.cre/bin/cre")}"
mkdir -p "$logs"
export STATE_DIR="$(cd "$logs" && pwd)"
logs="$STATE_DIR"
export CRE_ENV_FILE="${CRE_ENV_FILE:-$workflows/.env}"
cd "$workflows" || exit 1

stop=0
trap 'stop=1; if [ -n "${child:-}" ]; then kill "$child" 2>/dev/null || true; fi' INT TERM

while [ "$stop" -eq 0 ]; do
  run="$logs/listen-$(date -u +%Y%m%dT%H%M%SZ).log"
  echo "$(date -u +%FT%TZ) start target=${TARGET:-local-sim} log=$run" | tee -a "$logs/supervisor.log"
  bun --env-file="$CRE_ENV_FILE" run "$here/main.ts" >"$run" 2>&1 &
  child=$!
  code=0
  wait "$child" || code=$?
  child=""
  echo "$(date -u +%FT%TZ) exit code=$code" | tee -a "$logs/supervisor.log"
  if [ "$stop" -eq 0 ]; then sleep "$pause"; fi
done
