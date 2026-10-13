#!/usr/bin/env bash
# Forced-book liquidation scan for a native-priced engine. Sourced by
# keeper-daemon.sh so liquidation shares the keeper's single signer and loop (one nonce sequence).
# Same selection as the operations worker (oracle/services/market-ops/src/operations.ts): skip unless
# accounting is open and the per-block liquidation budget is non-zero, then walk trader ids 1..N from a
# rotating cursor, eth_call `liquidate(trader, capLots, 8, 0)` (the engine's own touch, eligibility and
# coverage path) and send only a productive result. A no-effect call never costs a transaction.
# Needs: R, ENG, KA (keeper address), ts, rd (read with fallbacks) and keeper_tx (perp.sh tx as the keeper).
# Optional LIQ_SCAN=32 (trader ids simulated per loop).

LIQ_RESULT='(uint8,uint8,uint8,uint64,uint64,int256,uint64,uint8)'   # LiquidationResult
LIQ_MARKET_VIEW='marketRiskView()((uint64,uint8,uint8,uint8,bool,uint256,bool,uint256,uint64,bytes32,uint64,bool,uint64,uint8,uint64,uint64,uint64,uint64,uint8))'
LIQ_EXAMINATIONS=8
liq_cursor=${liq_cursor:-1}

# Strip cast's tuple parentheses and "[1e5]" annotations: "(1, 2, 3 [3e0])" -> "1, 2, 3".
liq_fields() { printf '%s\n' "$1" | tr -d '()' | sed 's/ \[[^]]*\]//g'; }

# liq_productive "<LiquidationResult as printed by cast>": exit 0 when sending it would do work.
# reason == 0 and (TAKEOVER authorized, or any book or paired lots closed).
liq_productive() {
  liq_fields "$1" | awk -F', *' 'NF < 8 { exit 1 }
    { result=$1; mode=$2; paired=$4; book=$5; reason=$8 }
    reason == 0 && ((mode == 2 && result == 3) || book > 0 || paired > 0) { ok=1 }
    END { exit !ok }'
}

# liq_ids <cursor> <participants> <limit>: trader ids to examine this pass, wrapping 1..participants.
# The last line is the next cursor.
liq_ids() {
  awk -v c="$1" -v n="$2" -v l="$3" 'BEGIN {
    if (n < 1) { print 1; exit }
    if (c < 1 || c > n) c = 1
    m = (l < n) ? l : n
    for (i = 0; i < m; i++) { print c; c = (c == n) ? 1 : c + 1 }
    print c }'
}

# liq_state: prints "<accountingState> <liquidationCapLots> <liquidationRemainingLots>".
liq_state() {
  local v; v=$(rd call "$ENG" "$LIQ_MARKET_VIEW") || return 1
  liq_fields "$v" | awk -F', *' 'NF >= 18 { print $4, $17, $18; ok=1 } END { exit !ok }'
}

# liquidation_scan: at most one liquidation sent per call. Prints one log line when it does anything.
liquidation_scan() {
  local st acct cap rem n ids id sim
  st=$(liq_state) || { echo "$(ts) liquidation: market view unavailable"; return 0; }
  read -r acct cap rem <<<"$st"
  [ "$acct" = 0 ] && [ "${cap:-0}" != 0 ] && [ "${rem:-0}" != 0 ] || return 0
  n=$(rd call "$ENG" 'participantCount()(uint256)' | awk '{print $1}') || return 0
  [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null || return 0
  ids=$(liq_ids "$liq_cursor" "$n" "${LIQ_SCAN:-32}")
  liq_cursor=$(tail -n1 <<<"$ids")
  for id in $(sed '$d' <<<"$ids"); do
    # Simulated from the keeper on the primary RPC: the same state the transaction will see first.
    sim=$(cast call "$ENG" "liquidate(uint32,uint64,uint16,uint32)($LIQ_RESULT)" "$id" "$cap" "$LIQ_EXAMINATIONS" 0 \
      --from "$KA" --rpc-url "$R" 2>/dev/null) || continue
    liq_productive "$sim" || continue
    echo "$(ts) liquidation: trader $id productive ($(liq_fields "$sim")); sending"
    if keeper_tx "$ENG" 'liquidate(uint32,uint64,uint16,uint32)' "$id" "$cap" "$LIQ_EXAMINATIONS" 0; then
      echo "$(ts) liquidation: trader $id sent"
      liq_cursor=$id   # re-examine the same account first: a large position can need several passes
    else
      echo "$(ts) liquidation: trader $id send failed (rescanned next pass)"
    fi
    return 0
  done
}
