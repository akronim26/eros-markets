#!/usr/bin/env bash
# Keeps `cre workflow simulate --listen --broadcast` running against Monad testnet: the stand-in for a deployed
# workflow until CRE deploy access exists. Every ResolutionRequested log from the oracle runs the resolution
# workflow once, and a YES/NO result is written through the MockKeystoneForwarder by the sim relayer
# (CRE_ETH_PRIVATE_KEY in oracle/workflows/.env, git-ignored). The simulator is restarted when it exits.
#
#   oracle/workflows/listen/supervise.sh [log-dir]
#
#   TARGET        workflow.yaml target (default local-sim)
#   RESTART_SECS  pause before a restart (default 10)
set -u
here="$(cd "$(dirname "$0")" && pwd)"
workflows="$(dirname "$here")"
logs="${1:-$workflows/listen/logs}"
target="${TARGET:-local-sim}"
pause="${RESTART_SECS:-10}"
cre="${CRE_BIN:-$(command -v cre || echo "$HOME/.cre/bin/cre")}"
mkdir -p "$logs"
cd "$workflows" || exit 1

stop=0
trap 'stop=1; kill "${child:-0}" 2>/dev/null' INT TERM

while [ "$stop" -eq 0 ]; do
  run="$logs/listen-$(date -u +%Y%m%dT%H%M%SZ).log"
  echo "$(date -u +%FT%TZ) start target=$target log=$run" | tee -a "$logs/supervisor.log"
  "$cre" workflow simulate resolution --target "$target" --limits default --trigger-index 0 \
    --listen --broadcast --non-interactive -e .env >"$run" 2>&1 &
  child=$!
  wait "$child"
  code=$?
  echo "$(date -u +%FT%TZ) exit code=$code" | tee -a "$logs/supervisor.log"
  [ "$stop" -eq 0 ] && sleep "$pause"
done
