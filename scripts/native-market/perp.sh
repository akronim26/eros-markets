#!/usr/bin/env bash
# Native-priced Eros perp operations on the bound engine (NM-G01..G04). Thin cast wrappers.
#   Units: collateral atoms (6 decimals); ticks 1..999 = price/1000; sizes in lots (0.001 claim).
# Env: R (rpc), ENG (engine), KEY (signer), CV (CollateralVault; default: Monad testnet deployment).
set -euo pipefail
: "${R:?rpc}" "${ENG:?engine}" "${KEY:?private key}"
CV=${CV:-0x5E53c88eB3dA4C8640BC7AF51F0C5f8CC11205e4}
ME=$(cast wallet address "$KEY")
PLACE='placeOrder((uint8,bool,bool,uint16,uint64,uint8,uint32))'
VIEW='accountRiskView(uint32)((uint32,uint64,uint8,int256,int256,int256,int256,bool,int256,uint256,uint256,uint8,bool,uint64,uint8,uint8,(uint256,uint256,uint256,uint256)))'
# Estimate, then send with a +30% gas-limit margin: keepers/publishers change engine state between
# estimate and inclusion, and an exact estimate can run out of gas (seen as ReentrancySentryOOG).
tx() { local g; g=$(cast estimate --rpc-url "$R" --from "$ME" "$@") || { echo "  estimate failed: $*" >&2; return 1; }
  cast send --rpc-url "$R" --private-key "$KEY" --gas-limit $((g * 13 / 10)) "$@" | awk '/^status/{s=$2} /^transactionHash/{h=$2} END{print "  tx", h, s; if (s!=1) exit 1}'; }

cmd=${1:-status}; shift || true
case "$cmd" in
  fund)     # fund <atoms>: approve + deposit into CollateralVault, allocate to this engine
    C=$(cast call "$ENG" 'listing()((bytes32,address))' --rpc-url "$R" | tr -d '()' | awk -F', ' '{print $2}')
    tx "$C" 'approve(address,uint256)' "$CV" "$1"; tx "$CV" 'deposit(uint256)' "$1"; tx "$CV" 'allocate(address,uint256,bool)' "$ENG" "$1" false;;
  quote)    # quote <bidTick> <askTick> <lots>: fully backed post-only two-sided quote
    tx "$ENG" "$PLACE" "(2,true,false,$1,$3,8,0)"; tx "$ENG" "$PLACE" "(2,false,false,$2,$3,8,0)";;
  buy)      tx "$ENG" "$PLACE" "(1,true,false,$1,$2,8,0)";;   # buy <limitTick> <lots> (IOC)
  sell)     tx "$ENG" "$PLACE" "(1,false,false,$1,$2,8,0)";;  # sell <limitTick> <lots> (IOC)
  close)    # close <limitTick> <lots> <buy|sell>: reduce-only IOC
    [ "$3" = buy ] && b=true || b=false; tx "$ENG" "$PLACE" "(1,$b,true,$1,$2,8,0)";;
  release)  tx "$ENG" 'release(uint256)' "$1";;  # release <atoms> from this market back to free vault balance
  keeper)   # keeper <maxIterations> <sleepSecs>: samplePerp each block until activatePricing succeeds
    for i in $(seq 1 "$1"); do
      tx "$ENG" 'samplePerp()' >/dev/null 2>&1 || true
      if cast call "$ENG" 'activatePricing()' --from "$ME" --rpc-url "$R" >/dev/null 2>&1; then
        echo "  pricing activatable after $i samples"; tx "$ENG" 'activatePricing()'; break; fi
      sleep "$2"
    done
    echo "  pricingMode=$(cast call "$ENG" 'pricingMode()(uint8)' --rpc-url "$R")";;
  rollover) # rollover: hourly accounting sweep (beginRollover -> rollPage(32)... -> finishRollover). Requote afterwards.
    tx "$ENG" 'beginRollover()'
    for i in $(seq 1 64); do
      done_=$(cast call "$ENG" 'rollPage(uint8)(bool)' 32 --from "$ME" --rpc-url "$R"); tx "$ENG" 'rollPage(uint8)' 32
      [ "$done_" = true ] && break
    done
    tx "$ENG" 'finishRollover()';;
  status)
    id=$(cast call "$ENG" 'traderIdOf(address)(uint32)' "$ME" --rpc-url "$R")
    v=$(cast call "$ENG" "$VIEW" "$id" --rpc-url "$R" | tr -d '()' | sed 's/ \[[^]]*\]//g')
    echo "account $ME id=$id"
    echo "$v" | awk -F', ' '{printf "  cashQ=%s positionLots=%s e0Q=%s e1Q=%s markAvailable=%s\n", $4, $5, $6, $7, $8}'
    echo "  pricingMode=$(cast call "$ENG" 'pricingMode()(uint8)' --rpc-url "$R")";;
  *) echo "usage: perp.sh fund|quote|buy|sell|close|release|keeper|rollover|status ..." >&2; exit 2;;
esac
