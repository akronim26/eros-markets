#!/usr/bin/env bash
# Native spot market services (NM-S11): maker, daily trader and oracle lifecycle for ONE market.
#   spot-ops.sh start|stop|status
# Private config: $SPOT_OPS_ENV (default tmp/native-spot/<slug>/ops.env, mode 600, never committed):
#   RPC, D (DeployNativeMarket JSON), FEED (oracle/listings/native/<m>/feed.json), OPEN_TICK,
#   MAKER_KEY, TRADER_KEY, KEEPER_KEY, SPORTSDATA_API_KEY_VALUE. Optional bot knobs: see each script.
# The CRE listener (oracle/workflows/listen/supervise.sh) runs separately; it needs the CRE CLI.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
SLUG=${SPOT_SLUG:-nba-gsw-mia-20261105-spot}
RUN=tmp/native-spot/$SLUG; mkdir -p "$RUN"; chmod 700 "$RUN"
ENVF=${SPOT_OPS_ENV:-$RUN/ops.env}
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
start_one() { # name script [args]
  local name=$1; shift
  if [ -f "$RUN/$name.pid" ] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then echo "$name already running"; return; fi
  ( set -a; . "$ENVF"; set +a; export D="$ROOT/$D" FEED="$ROOT/$FEED"
    cd packages/pricefeed && exec nohup bun "scripts/native-spot/$1" >>"$ROOT/$RUN/$name.log" 2>&1 ) &
  echo $! > "$RUN/$name.pid"; echo "$name started (pid $(cat "$RUN/$name.pid"), log $RUN/$name.log)"
}
case "${1:-status}" in
  start)
    [ -f "$ENVF" ] || { echo "missing private config $ENVF (see header)"; exit 2; }
    [ "$(mode "$ENVF")" = 600 ] || { echo "$ENVF must be mode 600"; exit 2; }
    start_one maker maker.ts; start_one trader daily-trader.ts; start_one lifecycle lifecycle.ts;;
  stop)
    for n in lifecycle trader maker; do
      [ -f "$RUN/$n.pid" ] && kill "$(cat "$RUN/$n.pid")" 2>/dev/null && echo "$n stopped"; rm -f "$RUN/$n.pid"
    done;;
  status)
    for n in maker trader lifecycle; do
      if [ -f "$RUN/$n.pid" ] && kill -0 "$(cat "$RUN/$n.pid")" 2>/dev/null; then s="up (pid $(cat "$RUN/$n.pid"))"; else s=down; fi
      echo "$n: $s"; [ -f "$RUN/$n.log" ] && tail -n 2 "$RUN/$n.log" | sed 's/^/    /'
    done;;
  *) echo "usage: spot-ops.sh start|stop|status" >&2; exit 2;;
esac
