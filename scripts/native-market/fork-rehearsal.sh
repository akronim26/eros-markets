#!/usr/bin/env bash
# One-command native-market rehearsal on a LOCAL anvil fork of Monad testnet (NM-J06 rehearsal).
# Real testnet registry/factory/oracle/Timelock/TestUSDC/Kuru state; NO public transactions.
# Fork-only shortcuts: the registry lister is impersonated (public: LISTER_KEY), anvil test keys play
# maker/observer/keeper/trader, time is advanced for the 300 s Timelock delay, 1 s interval mining.
#   bash scripts/native-market/fork-rehearsal.sh            # starts and stops its own fork
#   KEEP=1 bash scripts/native-market/fork-rehearsal.sh     # leave the fork running at the end
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
PORT=${PORT:-18611}; export R=http://127.0.0.1:$PORT
FORGE=${FORK_FORGE:-forge}   # forge 1.8.3 rejects anvil's "Prague" for chain 10143; the default forge 1.5.x works on the fork
MN="test test test test test test test test test test test junk"; k() { cast wallet private-key --mnemonic "$MN" --mnemonic-index "$1"; }
DEPLOYER=$(k 0) OBSERVER=$(k 1) MAKER=$(k 2) PERP_MAKER=$(k 3) TRADER=$(k 4) KEEPER=$(k 6) ARB=$(k 7)
LISTER=0xFf49aD13c59592cCCa53552FE09dAcA43cbcF190 TIMELOCK=0x9fe0cF0DD3d190347548c2dC71cdbb4aAAC211F5
TUSDC=0x82C7236A14B635AFB6dC825115570aFE4C23c1DB TEMPLATE=0x86c606de50da38158856aabc7fbb9337d30a3f9cd50f34a855272a32332d1522
NAME=fork-$(date +%s); OUT=$ROOT/tmp/native-fork/$NAME; mkdir -p "$OUT" oracle/deployments/native
log() { printf '\n== %s\n' "$*"; }
FORKPID=""
cleanup() {
  [ -n "${PUBPID:-}" ] && kill "$PUBPID" 2>/dev/null || true
  rm -f oracle/deployments/native/$NAME.*
  rm -rf oracle/broadcast/*NativeMarket.s.sol oracle/cache/*NativeMarket.s.sol
  if [ -n "$FORKPID" ] && [ "${KEEP:-0}" != 1 ]; then kill "$FORKPID" 2>/dev/null || true; fi
}
trap cleanup EXIT

log "fork (port $PORT)"
anvil --fork-url "${FORK_URL:-https://testnet-rpc.monad.xyz}" --port "$PORT" --chain-id 10143 --code-size-limit 200000 --silent & FORKPID=$!
for _ in $(seq 1 60); do cast chain-id --rpc-url "$R" >/dev/null 2>&1 && break; sleep 1; done
cast rpc evm_setIntervalMining 1 --rpc-url "$R" >/dev/null
for key in $DEPLOYER $OBSERVER $MAKER $PERP_MAKER $TRADER $KEEPER $ARB; do
  a=$(cast wallet address "$key"); cast rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url "$R" >/dev/null
  cast send $TUSDC 'mint(address,uint256)' "$a" 50000000000 --private-key "$key" --rpc-url "$R" >/dev/null
done
cast rpc anvil_impersonateAccount $LISTER --rpc-url "$R" >/dev/null

log "1. deploy vault + Kuru books"
T=$(( $(cast block latest -f timestamp --rpc-url "$R") + 172800 ))
RULES="FORK REHEARSAL $NAME. YES if the rehearsal condition holds at T; NO otherwise. Test collateral; sandbox adjudication."
P=oracle/deployments/native/$NAME.params.json
jq -n --arg m "$(cast keccak "eros-native:$NAME")" --arg r "$RULES" --argjson t $T --arg o "deployments/native/$NAME.json" \
  '{registry:"0x780E73dDc65113F8C9C506daa25A0404Ed9f3E33",marketId:$m,collateral:"0x82C7236A14B635AFB6dC825115570aFE4C23c1DB",rules:$r,scheduledT:$t,
    issuanceCap:10000000000,yesSymbol:"eYES",noSymbol:"eNO",kuruRouter:"0x7EFbE105Ca7415dE98F96622173458ac1c054630",
    kuru:{pricePrecision:1000,sizePrecision:1000,tickSize:1,minSize:1,maxSize:1000000000,takerFeeBps:0,makerFeeBps:0,ammSpread:100},out:$o}' > "$P"
(cd oracle && NATIVE_PARAMS=deployments/native/$NAME.params.json $FORGE script script/native/DeployNativeMarket.s.sol \
  --skip UmaImports --skip 'test/**' --rpc-url "$R" --broadcast --private-key "$DEPLOYER" >"$OUT/deploy.log" 2>&1) || { tail -20 "$OUT/deploy.log"; exit 1; }
export D=oracle/deployments/native/$NAME.json; cp "$D" "$OUT/deployment.json"; jq -c '{outcomeVault,yesBook,noBook}' "$D"

log "2. native rules"
(cd packages/pricefeed && node dist/scripts/native-rules.js "../../$D" "$(cast wallet address "$OBSERVER")" 100000 50000000000000000 "$OUT/rules.json") > "$OUT/rules-out.json"
jq -n --arg r "$RULES" --arg tm $TEMPLATE --slurpfile e "$OUT/rules-out.json" \
  '{question:"Fork rehearsal: does the rehearsal condition hold at T?",rules:$r,templateMarketId:$tm,oiCapLots:1000000,
    indexSourceId:$e[0].engineListing.indexSourceId,indexSigner:$e[0].engineListing.indexSigner,indexRulesHash:$e[0].engineListing.indexRulesHash,
    depthNLots:100000,maxSpreadWad:50000000000000000}' > oracle/deployments/native/$NAME.listing.json
cp oracle/deployments/native/$NAME.listing.json "$OUT/listing.json"

log "3. list + bind (impersonated lister), activate via real Timelock"
(cd oracle && NATIVE_DEPLOYMENT=deployments/native/$NAME.json NATIVE_LISTING=deployments/native/$NAME.listing.json $FORGE script \
  script/native/ListNativeMarket.s.sol --skip UmaImports --skip 'test/**' --rpc-url "$R" --broadcast --unlocked --sender $LISTER >"$OUT/list.log" 2>&1) \
  || { tail -20 "$OUT/list.log"; exit 1; }
export ENG=$(grep -oE "engine 0x[0-9a-fA-F]{40}" "$OUT/list.log" | tail -1 | cut -d' ' -f2); echo "engine $ENG"
OP=$(cd oracle && ENGINE=$ENG $FORGE script script/native/ActivateNativeMarket.s.sol --skip UmaImports --skip 'test/**' --rpc-url "$R" 2>&1)
PROPOSE=$(echo "$OP" | awk '/data = propose/{getline; print $1}'); EXECUTE=$(echo "$OP" | awk '/anyone: execute/{getline; print $1}')
cast send $TIMELOCK "$PROPOSE" --unlocked --from $LISTER --rpc-url "$R" >/dev/null
cast rpc evm_increaseTime 301 --rpc-url "$R" >/dev/null; cast rpc evm_mine --rpc-url "$R" >/dev/null
cast send $TIMELOCK "$EXECUTE" --unlocked --from $LISTER --rpc-url "$R" >/dev/null
echo "active=$(cast call "$ENG" 'active()(bool)' --rpc-url "$R")"

log "4. native spot: maker splits and quotes, trader buys YES"
S="bash scripts/native-market/spot.sh"
KEY=$MAKER $S split 1000000000 >/dev/null
for t in yes no; do KEY=$MAKER $S deposit $t 500000000 >/dev/null; done; KEY=$MAKER $S deposit usdc 1000000000 >/dev/null
KEY=$MAKER $S quote yes 550 580 200000 >/dev/null; KEY=$MAKER $S quote no 420 450 200000 >/dev/null
KEY=$TRADER $S deposit usdc 100000000 >/dev/null; KEY=$TRADER $S buy yes 29000 0 >/dev/null
KEY=$TRADER $S status | sed -n 2,3p

log "5. native INDEX publisher (background)"
(cd packages/pricefeed && NATIVE_OBSERVER_KEY=$OBSERVER node dist/scripts/native-publish.js "$R" "$OUT/rules.json" "$ENG" 400 3000 latest) > "$OUT/publisher.log" 2>&1 & PUBPID=$!
for _ in $(seq 1 60); do
  NOW=$(cast block latest -f timestamp --rpc-url "$R")
  [ "$(cast call "$ENG" 'indexTwap300(uint64)((bool,int256,uint256,int256))' "$NOW" --rpc-url "$R" | cut -c1-6)" = "(true," ] && break; sleep 3
done
echo "INDEX $(cast call "$ENG" 'indexTwap300(uint64)((bool,int256,uint256,int256))' "$NOW" --rpc-url "$R" | cut -c1-48)"

log "6. native-priced perp: quote, keeper, activate pricing, 1x trade"
PP="bash scripts/native-market/perp.sh"
KEY=$PERP_MAKER $PP fund 500000000 >/dev/null; KEY=$PERP_MAKER $PP quote 555 575 150000 >/dev/null
KEY=$KEEPER $PP keeper 80 2
KEY=$TRADER $PP fund 100000000 >/dev/null; KEY=$TRADER $PP buy 575 20000; KEY=$TRADER $PP status | sed -n 2p

log "7. complete-set arbitrage (deliberately staged mispricing; controlled team activity, not organic demand)"
A="bash scripts/native-market/arb.sh"
# buy-merge: asks 0.56 (YES) + 0.43 (NO) = 0.99 < 1, each above its book's best bid (0.55 / 0.42)
KEY=$MAKER $S ask yes 560 20000 >/dev/null; KEY=$MAKER $S ask no 430 20000 >/dev/null
KEY=$ARB $A buy-merge 20
# split-sell: bids 0.57 (YES) + 0.44 (NO) = 1.01 > 1, each below its book's best ask (0.58 / 0.45)
KEY=$MAKER $S bid yes 570 20000 >/dev/null; KEY=$MAKER $S bid no 440 20000 >/dev/null
KEY=$ARB $A split-sell 20

log "summary"
echo "artifacts: $OUT"; tail -c 250 "$OUT/publisher.log"; echo
grep -c '"sequence"' "$OUT/publisher.log" | xargs echo "observations accepted:"
