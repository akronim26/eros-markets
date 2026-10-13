#!/usr/bin/env bash
# Keep a native-priced engine usable (NM-J02): sample the perp book on a fixed cadence, run the hourly
# accounting rollover when it opens, and keep the perp maker's quotes centred on the native INDEX
# (perp samples far from INDEX are not eligible, so a stale quote makes PERP unavailable).
# Quoting and sampling run sequentially in this one loop, so a sample never sees a half-updated book.
# Stops on low keeper balance. Never touches the INDEX publisher or spot maker.
# Env: R, ENG, KEEPER_KEY, PERP_MAKER_KEY; optional HALF=10 (ticks), LOTS=150000, FOLLOW=8 (ticks),
#      EVERY=90 (s), MIN_MON=2, RF (comma-separated read fallbacks, tried in order when R fails),
#      LIQUIDATE=1 (0 disables the liquidation scan), LIQ_SCAN=32 (trader ids simulated per loop).
# Transactions and the rollover simulation (an eth_call from the keeper) always use R.
set -uo pipefail
: "${R:?rpc}" "${ENG:?engine}" "${KEEPER_KEY:?keeper key}" "${PERP_MAKER_KEY:?perp maker key}"
HERE=$(cd "$(dirname "$0")" && pwd); PP="bash $HERE/perp.sh"
HALF=${HALF:-10}; LOTS=${LOTS:-150000}; FOLLOW=${FOLLOW:-8}; EVERY=${EVERY:-90}; MIN_MON=${MIN_MON:-2}
KA=$(cast wallet address "$KEEPER_KEY")
ts() { date -u +%H:%M:%SZ; }
rd() { local u out; for u in "$R" ${RF:+${RF//,/ }}; do out=$(cast "$@" --rpc-url "$u" 2>/dev/null) && { printf '%s\n' "$out"; return 0; }; done; return 1; }
# perp.sh's estimate-then-send helper as the keeper.
keeper_tx() { KEY=$KEEPER_KEY ENG=$ENG R=$R bash -c "eval \"\$(sed -n '1,14p' '$HERE/perp.sh')\"; tx \"\$@\"" _ "$@"; }
# Forced-book liquidation (LIQUIDATE=1, the default): the scan stops after one read when the listing has
# no liquidation budget (maxLiqLotsPerBlock 0), so a 1x market costs a single eth_call per loop.
. "$HERE/liquidation.sh"
# Orders rest in a market epoch: after a rollover (or on start) the maker's old quotes no longer count as
# depth, so no book sample is valid and the MARK stays unavailable. Re-quote whenever the epoch moved.
quoted_epoch=""
while true; do
  bal=$(rd balance "$KA" --ether || echo 0)
  if awk "BEGIN{exit !($bal < $MIN_MON)}"; then echo "$(ts) keeper balance $bal MON < $MIN_MON: stopping"; exit 3; fi
  if cast call "$ENG" 'beginRollover()' --from "$KA" --rpc-url "$R" >/dev/null 2>&1; then
    echo "$(ts) rollover due"
    KEY=$KEEPER_KEY $PP rollover && echo "$(ts) rollover done"
  fi
  # A fresh engine starts in bootstrap pricing (mode 0); switch to normal pricing as soon as the
  # engine accepts it (complete INDEX/book windows). Permissionless; simulated before sending.
  if [ "$(cast call "$ENG" 'pricingMode()(uint8)' --rpc-url "$R" 2>/dev/null)" = 0 ] \
     && cast call "$ENG" 'activatePricing()' --from "$KA" --rpc-url "$R" >/dev/null 2>&1; then
    KEY=$KEEPER_KEY $PP activate && echo "$(ts) pricing activated"
  fi
  # Liquidation runs before re-quoting: an unhealthy account is closed against the book as it stands.
  [ "${LIQUIDATE:-1}" = 0 ] || liquidation_scan
  # perp.sh's tx() is loaded with eval, not `. <(...)`: bash 3.2 (macOS) sources nothing from a process substitution.
  # Perp maker follows the native INDEX: re-quote at INDEX +/- HALF ticks when a side is empty or the
  # perp mid is >= FOLLOW ticks away from INDEX. Uses cancelAll (perp maker's own orders) then quote.
  now=$(rd block latest -f timestamp)
  idx=$(rd call "$ENG" 'indexTwap300(uint64)((bool,int256,uint256,int256))' "$now" | tr -d '()' | awk -F', ' '$1=="true"{print $2}' | awk '{print $1}')
  read -r bid ask < <(rd call "$ENG" 'bestBidAsk()(uint16,uint16)' | tr '\n' ' ')
  epoch=$(rd call "$ENG" 'marketOrderEpoch()(uint64)' || echo "")
  # INDEX is a WAD price below 1e18, so 64-bit shell arithmetic is exact; rounds half up to a tick.
  if [ -n "$idx" ] && [ -z "${idx//[0-9]/}" ]; then
    target=$(( (idx + 500000000000000) / 1000000000000000 ))
    pb=$((target - HALF)); pa=$((target + HALF))
    if [ -n "$epoch" ] && [ "$epoch" != "$quoted_epoch" ] || [ "${bid:-0}" = 0 ] || [ "${ask:-0}" = 0 ] || [ $(( (bid + ask) / 2 - target )) -ge "$FOLLOW" ] || [ $(( target - (bid + ask) / 2 )) -ge "$FOLLOW" ]; then
      echo "$(ts) perp quotes ${bid:-?}/${ask:-?} (epoch ${epoch:-?}, quoted ${quoted_epoch:-none}) vs INDEX tick $target: re-quoting $pb/$pa x $LOTS lots"
      KEY=$PERP_MAKER_KEY ENG=$ENG R=$R bash -c "eval \"\$(sed -n '1,14p' '$HERE/perp.sh')\"; tx \"\$ENG\" 'cancelAll()'" >/dev/null 2>&1 || true
      if KEY=$PERP_MAKER_KEY $PP quote $pb $pa "$LOTS" >/dev/null; then quoted_epoch=$epoch; else echo "$(ts) perp quote failed (retry next loop)"; fi
    fi
  fi
  if KEY=$KEEPER_KEY ENG=$ENG R=$R bash -c "eval \"\$(sed -n '1,14p' '$HERE/perp.sh')\"; tx \"\$ENG\" 'samplePerp()'" >/dev/null 2>&1; then s=ok; else s=fail; fi
  now=$(rd block latest -f timestamp)
  echo "$(ts) sample=$s perp=$(rd call "$ENG" 'perpTwap60(uint64)((bool,int256,uint256,int256))' "$now" | cut -c2-6) index=$(rd call "$ENG" 'indexTwap300(uint64)((bool,int256,uint256,int256))' "$now" | cut -c2-6) mode=$(rd call "$ENG" 'pricingMode()(uint8)') keeperMON=$bal"
  sleep "$EVERY"
done
