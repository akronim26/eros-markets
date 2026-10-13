#!/usr/bin/env bash
# Native market operator runtime (NM-J01 / NM-J02): one host, explicit commands, exclusive writers.
#   ops.sh check   read-only: deployment verification, role balances and gas runway; sends nothing
#   ops.sh start   start the INDEX publisher and the keeper loop, each under a bounded restart supervisor
#   ops.sh stop    stop both (supervisor first, then its child)
#   ops.sh status  pids, restarts, last log lines, INDEX/MARK availability
#
# Private config: $NATIVE_OPS_ENV (default tmp/native-public/ops.env, mode 600, never committed) with
#   MONAD_RPC_URL, NATIVE_OBSERVER_PRIVATE_KEY, NATIVE_KEEPER_PRIVATE_KEY, NATIVE_PERP_MAKER_PRIVATE_KEY,
#   NATIVE_DEPLOYMENT (DeployNativeMarket JSON), NATIVE_RULES (rules JSON), NATIVE_ENGINE.
# Optional: PUBLISH_MS (60000), KEEPER_EVERY (90), MAX_RESTARTS (5), MIN_GAS_MON (0.5), LOW_GAS_MON (3).
# Keys are only read from that file (never argv). Each service holds an flock, so a second copy of the
# same service cannot start: the INDEX signer and keeper never have two concurrent writers.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
RUN=tmp/native-public; mkdir -p "$RUN"; chmod 700 "$RUN"
ENVF=${NATIVE_OPS_ENV:-$RUN/ops.env}
[ -f "$ENVF" ] || { echo "missing private config $ENVF (see header)"; exit 2; }
[ "$(stat -c %a "$ENVF")" = 600 ] || { echo "$ENVF must be mode 600"; exit 2; }
set -a; . "$ENVF"; set +a
: "${MONAD_RPC_URL:?}" "${NATIVE_OBSERVER_PRIVATE_KEY:?}" "${NATIVE_KEEPER_PRIVATE_KEY:?}" "${NATIVE_PERP_MAKER_PRIVATE_KEY:?}"
: "${NATIVE_DEPLOYMENT:?}" "${NATIVE_RULES:?}" "${NATIVE_ENGINE:?}"
PUBLISH_MS=${PUBLISH_MS:-60000}; KEEPER_EVERY=${KEEPER_EVERY:-90}; MAX_RESTARTS=${MAX_RESTARTS:-5}
MIN_GAS_MON=${MIN_GAS_MON:-0.5}; LOW_GAS_MON=${LOW_GAS_MON:-3}
R=$MONAD_RPC_URL; ENG=$NATIVE_ENGINE
ts() { date -u +%FT%TZ; }
addr() { cast wallet address "$1"; }

# Measured burn (MON/hour) at ~102 gwei: publisher ~3.1 at 30 s (so ~1.55 at 60 s), keeper ~3.0 at 90 s.
runway() { python3 -c "b=float('$1'); r=float('$2'); print(f'{b:.2f} MON, ~{b/r:.1f} h at {r} MON/h')"; }

check() {
  echo "== deployment verification (read-only)"
  (cd packages/pricefeed && node dist/scripts/native-verify.js "$R" "$ROOT/$NATIVE_DEPLOYMENT" "$ROOT/$NATIVE_RULES") | grep -E "FAIL|\"failed\"" ; echo "   (any FAIL above blocks start)"
  echo "== roles and gas runway"
  local pub_rate; pub_rate=$(python3 -c "print(round(3.1*30000/$PUBLISH_MS,2))")
  echo "   observer   $(addr "$NATIVE_OBSERVER_PRIVATE_KEY")  $(runway "$(cast balance "$(addr "$NATIVE_OBSERVER_PRIVATE_KEY")" --rpc-url "$R" --ether)" "$pub_rate")"
  echo "   keeper     $(addr "$NATIVE_KEEPER_PRIVATE_KEY")  $(runway "$(cast balance "$(addr "$NATIVE_KEEPER_PRIVATE_KEY")" --rpc-url "$R" --ether)" 3.0)"
  echo "   perp maker $(addr "$NATIVE_PERP_MAKER_PRIVATE_KEY")  $(cast balance "$(addr "$NATIVE_PERP_MAKER_PRIVATE_KEY")" --rpc-url "$R" --ether | cut -c1-6) MON (spent only when re-quoting)"
  local now; now=$(cast block latest -f timestamp --rpc-url "$R")
  echo "== engine: $(cast call "$ENG" 'marketRiskView()((uint64,uint8,uint8,uint8,bool,uint256,bool,uint256,uint64,bytes32,uint64,bool,uint64,uint8,uint64,uint64,uint64,uint64,uint8))' --rpc-url "$R" | tr -d '()' | awk -F', ' '{split("TRADING BACKING_GRACE BACKING_FLOOR REDUCE_ONLY HALTED CLAIMS_READY",s," "); print "stage="s[$2+1]" pricingMode="$3" index="$5" mark="$7" monitorRestricted="$12}')"
}

# Bounded restart supervisor: restarts on exit with backoff 10, 20, 40... s (cap 300), at most MAX_RESTARTS
# consecutive failures, then stops and records why. Holds an flock for the service's lifetime (exclusive writer).
# An empty signer wallet is not a crash: the supervisor waits (polling every 60 s) until the wallet holds
# MIN_GAS_MON, without spending restarts, and logs a FUND alert. A run that stayed up 10 minutes resets the count.
gas_mon() { cast balance "$1" --rpc-url "$R" --ether 2>/dev/null || echo -1; }
below() { python3 -c "import sys; sys.exit(0 if float('$1') < float('$2') else 1)"; }
wait_for_gas() {
  local name=$1 who=$2 since=0 bal
  while :; do
    [ -f "$RUN/$name.stop" ] && return 1
    bal=$(gas_mon "$who")
    # -1 means the balance read failed; let the service start and surface the RPC error itself.
    if [ "$bal" = -1 ] || ! below "$bal" "$MIN_GAS_MON"; then
      below "$bal" "$LOW_GAS_MON" && [ "$bal" != -1 ] && echo "$(ts) supervisor: LOW GAS $name signer $who has $bal MON (< $LOW_GAS_MON); fund soon" >> "$RUN/$name.log"
      return 0
    fi
    [ $(( $(date +%s) - since )) -ge 600 ] && { echo "$(ts) supervisor: FUND $name signer $who: $bal MON < $MIN_GAS_MON; waiting for funds" >> "$RUN/$name.log"; since=$(date +%s); }
    sleep 60
  done
}
supervise() {
  local name=$1; shift
  # Secrets reach children only through the environment (never argv, which `ps` shows).
  local who
  case $name in
    publisher) export NATIVE_OBSERVER_KEY="$NATIVE_OBSERVER_PRIVATE_KEY" NATIVE_RPC="$R"; who=$(addr "$NATIVE_OBSERVER_PRIVATE_KEY") ;;
    keeper) export R ENG KEEPER_KEY="$NATIVE_KEEPER_PRIVATE_KEY" PERP_MAKER_KEY="$NATIVE_PERP_MAKER_PRIVATE_KEY" EVERY="$KEEPER_EVERY"; who=$(addr "$NATIVE_KEEPER_PRIVATE_KEY") ;;
  esac
  exec 9>"$RUN/$name.lock"
  flock -n 9 || { echo "$(ts) $name already running (lock held); not starting a second writer"; exit 3; }
  echo $$ > "$RUN/$name.supervisor.pid"
  local n=0
  while :; do
    wait_for_gas "$name" "$who" || { rm -f "$RUN/$name.stop"; echo "$(ts) supervisor: stop requested" >> "$RUN/$name.log"; break; }
    echo "$(ts) supervisor: starting $name (restart $n)" >> "$RUN/$name.log"
    local began; began=$(date +%s)
    "$@" >> "$RUN/$name.log" 2>&1 & echo $! > "$RUN/$name.pid"; wait $!; local code=$?
    echo "$(ts) supervisor: $name exited code $code" >> "$RUN/$name.log"
    [ -f "$RUN/$name.stop" ] && { rm -f "$RUN/$name.stop"; echo "$(ts) supervisor: stop requested" >> "$RUN/$name.log"; break; }
    [ $(( $(date +%s) - began )) -ge 600 ] && n=0
    # Out of gas: wait for funding at the top of the loop instead of burning restarts.
    local bal; bal=$(gas_mon "$who")
    if [ "$bal" != -1 ] && below "$bal" "$MIN_GAS_MON"; then continue; fi
    n=$((n + 1)); [ "$n" -gt "$MAX_RESTARTS" ] && { echo "$(ts) supervisor: $name exceeded $MAX_RESTARTS restarts; operator review required" >> "$RUN/$name.log"; break; }
    local wait_s=$((10 * (1 << (n - 1)))); [ "$wait_s" -gt 300 ] && wait_s=300; sleep "$wait_s"
  done
  rm -f "$RUN/$name.pid" "$RUN/$name.supervisor.pid"
}

start() {
  local report; report=$(check)   # capture first: `check | grep -q` + pipefail fails on SIGPIPE
  grep -q '"failed": 0' <<<"$report" || { echo "$report"; echo "verification failed; not starting"; exit 4; }
  for svc in publisher keeper; do
    [ -f "$RUN/$svc.supervisor.pid" ] && kill -0 "$(cat "$RUN/$svc.supervisor.pid")" 2>/dev/null && { echo "$svc already running"; continue; }
    rm -f "$RUN/$svc.stop"
    case $svc in
      publisher) setsid nohup bash "$0" _run publisher node packages/pricefeed/dist/scripts/native-publish.js env "$NATIVE_RULES" "$ENG" 1000000 "$PUBLISH_MS" finalized > /dev/null 2>&1 < /dev/null & ;;
      keeper) setsid nohup bash "$0" _run keeper bash scripts/native-market/keeper-daemon.sh > /dev/null 2>&1 < /dev/null & ;;
    esac
    echo "$svc: started"
  done
}

stop() {
  for svc in publisher keeper; do
    touch "$RUN/$svc.stop"
    [ -f "$RUN/$svc.pid" ] && kill "$(cat "$RUN/$svc.pid")" 2>/dev/null
    echo "$svc: stop requested"
  done
}

status() {
  for svc in publisher keeper; do
    local sp cp; sp=$(cat "$RUN/$svc.supervisor.pid" 2>/dev/null); cp=$(cat "$RUN/$svc.pid" 2>/dev/null)
    local up="stopped"; [ -n "$sp" ] && kill -0 "$sp" 2>/dev/null && up="running (supervisor $sp, child ${cp:-?})"
    echo "== $svc: $up; starts: $(grep -c 'supervisor: starting' "$RUN/$svc.log" 2>/dev/null || echo 0)"
    tail -n 2 "$RUN/$svc.log" 2>/dev/null | sed -E 's/0x[0-9a-fA-F]{64}/<redacted>/g' | cut -c1-160
  done
  local now; now=$(cast block latest -f timestamp --rpc-url "$R")
  echo "== INDEX $(cast call "$ENG" 'indexTwap300(uint64)((bool,int256,uint256,int256))' "$now" --rpc-url "$R" | cut -c1-30)"
}

case "${1:-}" in
  check) check;; start) start;; stop) stop;; status) status;;
  _run) shift; supervise "$@";;
  *) echo "usage: ops.sh check|start|stop|status"; exit 2;;
esac
