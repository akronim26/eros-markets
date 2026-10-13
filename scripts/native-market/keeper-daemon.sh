#!/usr/bin/env bash
# Keep a native-priced engine usable (NM-J02): sample the perp book on a fixed cadence, run the hourly
# accounting rollover when it opens, and keep the perp maker's quotes centred on the native INDEX
# (perp samples far from INDEX are not eligible, so a stale quote makes PERP unavailable).
# Quoting and sampling run sequentially in this one loop, so a sample never sees a half-updated book.
# Stops on low keeper balance. Never touches the INDEX publisher or spot maker.
# Env: R, ENG, KEEPER_KEY, PERP_MAKER_KEY; optional HALF=10 (ticks), LOTS=150000, FOLLOW=8 (ticks),
#      EVERY=90 (s), MIN_MON=2.
set -uo pipefail
: "${R:?rpc}" "${ENG:?engine}" "${KEEPER_KEY:?keeper key}" "${PERP_MAKER_KEY:?perp maker key}"
HERE=$(cd "$(dirname "$0")" && pwd); PP="bash $HERE/perp.sh"
HALF=${HALF:-10}; LOTS=${LOTS:-150000}; FOLLOW=${FOLLOW:-8}; EVERY=${EVERY:-90}; MIN_MON=${MIN_MON:-2}
KA=$(cast wallet address "$KEEPER_KEY")
ts() { date -u +%H:%M:%SZ; }
while true; do
  bal=$(cast balance "$KA" --rpc-url "$R" --ether 2>/dev/null || echo 0)
  if awk "BEGIN{exit !($bal < $MIN_MON)}"; then echo "$(ts) keeper balance $bal MON < $MIN_MON: stopping"; exit 3; fi
  if cast call "$ENG" 'beginRollover()' --from "$KA" --rpc-url "$R" >/dev/null 2>&1; then
    echo "$(ts) rollover due"
    KEY=$KEEPER_KEY $PP rollover && echo "$(ts) rollover done"
  fi
  # Perp maker follows the native INDEX: re-quote at INDEX +/- HALF ticks when a side is empty or the
  # perp mid is >= FOLLOW ticks away from INDEX. Uses cancelAll (perp maker's own orders) then quote.
  now=$(cast block latest -f timestamp --rpc-url "$R" 2>/dev/null)
  idx=$(cast call "$ENG" 'indexTwap300(uint64)((bool,int256,uint256,int256))' "$now" --rpc-url "$R" 2>/dev/null | tr -d '()' | awk -F', ' '$1=="true"{print $2}' | awk '{print $1}')
  read -r bid ask < <(cast call "$ENG" 'bestBidAsk()(uint16,uint16)' --rpc-url "$R" 2>/dev/null | tr '\n' ' ')
  if [ -n "$idx" ]; then
    target=$(python3 -c "print(round(int('$idx')/10**15))")
    pb=$((target - HALF)); pa=$((target + HALF))
    if [ "${bid:-0}" = 0 ] || [ "${ask:-0}" = 0 ] || [ $(( (bid + ask) / 2 - target )) -ge "$FOLLOW" ] || [ $(( target - (bid + ask) / 2 )) -ge "$FOLLOW" ]; then
      echo "$(ts) perp quotes ${bid:-?}/${ask:-?} vs INDEX tick $target: re-quoting $pb/$pa x $LOTS lots"
      KEY=$PERP_MAKER_KEY ENG=$ENG R=$R bash -c ". <(sed -n '1,14p' '$HERE/perp.sh'); tx \"\$ENG\" 'cancelAll()'" >/dev/null 2>&1 || true
      KEY=$PERP_MAKER_KEY $PP quote $pb $pa "$LOTS" >/dev/null || echo "$(ts) perp quote failed (retry next loop)"
    fi
  fi
  if KEY=$KEEPER_KEY ENG=$ENG R=$R bash -c ". <(sed -n '1,14p' '$HERE/perp.sh'); tx \"\$ENG\" 'samplePerp()'" >/dev/null 2>&1; then s=ok; else s=fail; fi
  now=$(cast block latest -f timestamp --rpc-url "$R" 2>/dev/null)
  echo "$(ts) sample=$s perp=$(cast call "$ENG" 'perpTwap60(uint64)((bool,int256,uint256,int256))' "$now" --rpc-url "$R" 2>/dev/null | cut -c2-6) index=$(cast call "$ENG" 'indexTwap300(uint64)((bool,int256,uint256,int256))' "$now" --rpc-url "$R" 2>/dev/null | cut -c2-6) mode=$(cast call "$ENG" 'pricingMode()(uint8)' --rpc-url "$R" 2>/dev/null) keeperMON=$bal"
  sleep "$EVERY"
done
