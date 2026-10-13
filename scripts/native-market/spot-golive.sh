#!/usr/bin/env bash
# Go-live for the native spot NBA market (NM-S12). Run from the repo root with your own keys:
#   RPC=https://testnet-rpc.monad.xyz LISTER_KEY=0x.. bash scripts/native-market/spot-golive.sh
# LISTER_KEY is the registry lister, which is also the Timelock proposer (roles.lister/teamSafe).
# Steps (each stops on failure; reruns skip finished steps):
#   1 deploy SpotMarketFactory        2 Timelock op "enable" (providers, authRef, feed timing, factory)
#   3 deploy vault + Kuru YES/NO books 4 list the spot market and bind the vault
#   5 Timelock op "restore" (perp MarketFactory back)
set -euo pipefail
: "${RPC:?rpc}" "${LISTER_KEY:?lister / timelock proposer key}"
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT/oracle"
SLUG=nba-gsw-mia-20261105-spot
LISTING=listings/native/$SLUG/listing.json PARAMS=deployments/native/$SLUG.params.json OUT=deployments/native/$SLUG.json
SFJ=deployments/native/spot-market-factory.json
TL=$(jq -r .roles.timelock deployments/monad-testnet.json); REG=$(jq -r .contracts.MarketRegistry.address deployments/monad-testnet.json)
FS=(--rpc-url "$RPC" --private-key "$LISTER_KEY" --skip UmaImports --skip 'test/**')
# Reads retry: the public RPC drops connections, and an empty read must never be taken as chain state.
c() { local out i; for i in 1 2 3 4 5 6; do out=$(cast "$@" --rpc-url "$RPC" 2>/dev/null) && [ -n "$out" ] && { echo "$out"; return 0; }; sleep 4; done
  echo "RPC read failed after retries: cast $*" >&2; exit 1; }

timelock() { # op-name env...: simulate, propose, wait the delay, execute
  local log; log=$(env "$@" forge script script/native/SpotMarketGovernance.s.sol --rpc-url "$RPC" --skip UmaImports --skip 'test/**' 2>&1) || { echo "$log"; exit 1; }
  local p e d; p=$(grep -oE "0x$(cast sig 'propose(bytes32,bytes,uint256)' | cut -c3-)[0-9a-f]+" <<<"$log" | head -1)
  e=$(grep -oE "0x$(cast sig 'execute(bytes32,bytes)' | cut -c3-)[0-9a-f]+" <<<"$log" | head -1)
  d=$(grep -oE "with delay [0-9]+" <<<"$log" | grep -oE "[0-9]+$")
  [ -n "$p" ] && [ -n "$e" ] || { echo "$log"; echo "could not parse the Timelock operation"; exit 1; }
  cast send "$TL" "$p" --rpc-url "$RPC" --private-key "$LISTER_KEY" >/dev/null && echo "  proposed; waiting ${d}s"
  sleep $((d + 15))
  cast send "$TL" "$e" --rpc-url "$RPC" --private-key "$LISTER_KEY" >/dev/null && echo "  executed"
}

echo "1/5 SpotMarketFactory"
if [ -f "$SFJ" ] && [ "$(c codesize "$(jq -r .spotMarketFactory "$SFJ")")" = 0 ]; then rm -f "$SFJ"; fi
[ -f "$SFJ" ] || forge script script/native/DeploySpotMarketFactory.s.sol "${FS[@]}" --broadcast >/dev/null
SF=$(jq -r .spotMarketFactory "$SFJ"); echo "  $SF"

echo "2/5 Timelock: enable spot listing"
if [ "$(c call "$REG" 'factory()(address)')" != "$SF" ]; then timelock OP=enable SPOT_FACTORY="$SF" SPOT_LISTING="$LISTING"; else echo "  already enabled"; fi

echo "3/5 vault + Kuru books"
# forge writes $OUT while simulating, before broadcasting: trust it only if the vault has code.
if [ -f "$OUT" ] && [ "$(c codesize "$(jq -r .outcomeVault "$OUT")")" = 0 ]; then echo "  stale record (no code): removing"; rm -f "$OUT"; fi
[ -f "$OUT" ] || NATIVE_PARAMS=$PARAMS forge script script/native/DeployNativeMarket.s.sol "${FS[@]}" --broadcast --gas-estimate-multiplier 105 >/dev/null
jq -c '{outcomeVault, yesBook, noBook}' "$OUT"

echo "4/5 list + bind"
MID=$(jq -r .marketId "$OUT")
if [ "$(c call "$REG" 'isListed(bytes32)(bool)' "$MID")" != true ]; then
  NATIVE_DEPLOYMENT=$OUT SPOT_LISTING=$LISTING forge script script/native/ListNativeSpotMarket.s.sol "${FS[@]}" --broadcast --gas-estimate-multiplier 105 | grep -E "spot anchor|vault bound"
else echo "  already listed"; fi

echo "5/5 Timelock: restore perp factory"
[ "$(c call "$REG" 'factory()(address)')" = "$SF" ] && timelock OP=restore || echo "  already restored"
echo "done: anchor $(c call "$(jq -r .outcomeVault "$OUT")" 'engine()(address)')"
