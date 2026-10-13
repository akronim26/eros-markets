#!/usr/bin/env bash
# Keep a native-priced engine usable (NM-J02): sample the perp book on a fixed cadence, run the hourly
# accounting rollover when it opens, then re-post the perp maker's quotes (rollover invalidates old
# perp orders). Stops on low keeper balance. Never touches the INDEX publisher or spot maker.
# Env: R, ENG, KEEPER_KEY, PERP_MAKER_KEY; optional QUOTE="490 510 150000", EVERY=90 (s), MIN_MON=2.
set -uo pipefail
: "${R:?rpc}" "${ENG:?engine}" "${KEEPER_KEY:?keeper key}" "${PERP_MAKER_KEY:?perp maker key}"
HERE=$(cd "$(dirname "$0")" && pwd); PP="bash $HERE/perp.sh"
QUOTE=${QUOTE:-"490 510 150000"}; EVERY=${EVERY:-90}; MIN_MON=${MIN_MON:-2}
KA=$(cast wallet address "$KEEPER_KEY")
ts() { date -u +%H:%M:%SZ; }
while true; do
  bal=$(cast balance "$KA" --rpc-url "$R" --ether 2>/dev/null || echo 0)
  if awk "BEGIN{exit !($bal < $MIN_MON)}"; then echo "$(ts) keeper balance $bal MON < $MIN_MON: stopping"; exit 3; fi
  if cast call "$ENG" 'beginRollover()' --from "$KA" --rpc-url "$R" >/dev/null 2>&1; then
    echo "$(ts) rollover due"
    KEY=$KEEPER_KEY $PP rollover && echo "$(ts) rollover done"
  fi
  # Re-quote only when the perp book is missing a side (bestBidAsk returns 0 for an empty side);
  # resting quotes that survive the rollover are kept, so depth does not stack every hour.
  read -r bid ask < <(cast call "$ENG" 'bestBidAsk()(uint16,uint16)' --rpc-url "$R" 2>/dev/null | tr '\n' ' ')
  if [ "${bid:-0}" = 0 ] || [ "${ask:-0}" = 0 ]; then
    echo "$(ts) perp book side empty (bid=${bid:-?} ask=${ask:-?}); quoting: $QUOTE"
    # shellcheck disable=SC2086
    KEY=$PERP_MAKER_KEY $PP quote $QUOTE || echo "$(ts) quote failed (INDEX may be stale; retry next loop)"
  fi
  if KEY=$KEEPER_KEY ENG=$ENG R=$R bash -c ". <(sed -n '1,14p' '$HERE/perp.sh'); tx \"\$ENG\" 'samplePerp()'" >/dev/null 2>&1; then s=ok; else s=fail; fi
  now=$(cast block latest -f timestamp --rpc-url "$R" 2>/dev/null)
  echo "$(ts) sample=$s perp=$(cast call "$ENG" 'perpTwap60(uint64)((bool,int256,uint256,int256))' "$now" --rpc-url "$R" 2>/dev/null | cut -c2-6) index=$(cast call "$ENG" 'indexTwap300(uint64)((bool,int256,uint256,int256))' "$now" --rpc-url "$R" 2>/dev/null | cut -c2-6) mode=$(cast call "$ENG" 'pricingMode()(uint8)' --rpc-url "$R" 2>/dev/null) keeperMON=$bal"
  sleep "$EVERY"
done
