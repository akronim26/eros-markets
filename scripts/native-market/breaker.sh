# Movement-breaker reset for keeper-daemon.sh (sourced; needs R, ENG, rd, ts).
# The engine latches reduce-only when INDEX moves more than 0.10 within 300 s, until the market monitor
# calls clearReduceOnly. With MONITOR_KEY set, the keeper clears it once INDEX has been stable: at least
# STABLE_SECS since the latch was seen, and the INDEX TWAP now within 0.10 of the TWAP STABLE_SECS ago.
# clearReduceOnly also clears a deliberate monitor restriction (requestReduceOnly, e.g. an early event
# check), so the keeper never clears while such a request is in the recent logs; that needs an operator.
# Env: MONITOR_KEY (unset: the keeper only reports the latch), STABLE_SECS=300, BREAKER_LOOKBACK=3000 blocks.
STABLE_SECS=${STABLE_SECS:-300}
BREAKER_LOOKBACK=${BREAKER_LOOKBACK:-3000}
MOVE_MAX_WAD=100000000000000000
RESTRICTION_TOPIC=$(cast keccak 'MonitorRestriction(bool,bytes32,uint64)')
breaker_since=""

# Prints "1" when a requestReduceOnly (MonitorRestriction(true, ...)) is in the JSON log array on stdin.
_monitor_requested() { node -e '
  const topic = process.argv[1]; let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    let logs; try { logs = JSON.parse(s); } catch { return; }
    if (logs.some(l => l.topics && l.topics[0] === topic && BigInt("0x" + l.data.slice(2, 66)) === 1n)) console.log(1);
  });' "$RESTRICTION_TOPIC"; }

_twap_at() { rd call "$ENG" 'indexTwap300(uint64)((bool,int256,uint256,int256))' "$1" | tr -d '()' | awk -F', ' '$1=="true"{print $2}' | awk '{print $1}'; }

breaker_check() {
  local moved now a b head from req
  moved=$(rd call "$ENG" 'freshness()(uint64,uint64,bool)' | tail -1) || return 0
  if [ "$moved" != true ]; then breaker_since=""; return 0; fi
  now=$(rd block latest -f timestamp) || return 0
  if [ -z "$breaker_since" ]; then
    breaker_since=$now
    echo "$(ts) movement restriction: reduce-only$([ -n "${MONITOR_KEY:-}" ] && echo "; clearing after ${STABLE_SECS}s of stable INDEX" || echo "; no MONITOR_KEY, an operator must clearReduceOnly")"
  fi
  [ -n "${MONITOR_KEY:-}" ] && [ $((now - breaker_since)) -ge "$STABLE_SECS" ] || return 0
  a=$(_twap_at "$now"); b=$(_twap_at $((now - STABLE_SECS)))
  [ -n "$a" ] && [ -n "$b" ] || return 0
  [ $(( a > b ? a - b : b - a )) -le $MOVE_MAX_WAD ] || return 0
  head=$(rd block-number) || return 0
  for ((from = head - BREAKER_LOOKBACK; from <= head; from += 100)); do
    rd logs --from-block "$from" --to-block $((from + 99 > head ? head : from + 99)) --address "$ENG" --json | _monitor_requested
  done | grep -q 1 && { echo "$(ts) movement restriction kept: a monitor reduce-only request is recent; operator review needed"; return 0; }
  if KEY=$MONITOR_KEY ENG=$ENG R=$R bash -c "eval \"\$(sed -n '1,14p' '$HERE/perp.sh')\"; tx \"\$ENG\" 'clearReduceOnly(bytes32)' $(cast format-bytes32-string keeper-index-stable)" >/dev/null; then
    echo "$(ts) movement restriction cleared (INDEX $b -> $a over ${STABLE_SECS}s)"; breaker_since=""
  fi
}
