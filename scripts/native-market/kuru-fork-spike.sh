#!/usr/bin/env bash
# Kuru x Eros TestUSDC compatibility spike on a LOCAL anvil fork of Monad testnet (no public txs).
set -uo pipefail
# Start the fork first: anvil --fork-url https://testnet-rpc.monad.xyz --port 18611 --chain-id 10143 --code-size-limit 200000
R=${R:-http://127.0.0.1:18611}
RT=0x7EFbE105Ca7415dE98F96622173458ac1c054630
MA=0xd029C2D98ff85D8F64799017fE00a59B1159CE02
Q=0x82C7236A14B635AFB6dC825115570aFE4C23c1DB          # Eros TestUSDC (real, forked)
YES=0x00000000000000000000000000000000000E5E51         # clone of TestUSDC runtime = stand-in outcome token
MK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  # anvil key 0 (maker)
MKA=$(cast wallet address $MK)
TK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a  # anvil key 2 (taker)
TKA=$(cast wallet address $TK)
s() { cast send --rpc-url $R --private-key "$@" >/dev/null 2>&1 || { echo "  !! send failed: ${*:2}"; cast send --rpc-url $R --private-key "$@" 2>&1 | tail -3; }; }
bal() { cast call $MA 'getBalance(address,address)(uint256)' $1 $2 --rpc-url $R | awk '{print $1}'; }
wb()  { cast call $2 'balanceOf(address)(uint256)' $1 --rpc-url $R | awk '{print $1}'; }

echo "maker=$MKA taker=$TKA"
cast rpc anvil_setCode $YES "$(cast code $Q --rpc-url $R)" --rpc-url $R >/dev/null
for a in $MKA $TKA; do cast rpc anvil_setBalance $a 0x56BC75E2D63100000 --rpc-url $R >/dev/null; done

echo "1. faucet mint"
s $MK $YES 'mint(address,uint256)' $MKA 1000000000
s $MK $Q   'mint(address,uint256)' $MKA 1000000000
s $TK $Q   'mint(address,uint256)' $TKA 1000000000
s $TK $YES 'mint(address,uint256)' $TKA 1000000000

echo "2. deployProxy YES/tUSDC (type 0, sizePrec 1000 => 1 unit = 0.001 claim, pricePrec 1000 tick 1 => 0.001)"
SIG='deployProxy(uint8,address,address,uint96,uint32,uint32,uint96,uint96,uint256,uint256,uint96)'
ARGS="0 $YES $Q 1000 1000 1 1 1000000000 30 10 100"
OB=$(cast call $RT "$SIG(address)" $ARGS --from $MKA --rpc-url $R)
s $MK $RT "$SIG" $ARGS
echo "   market=$OB code=$(( ($(cast code $OB --rpc-url $R | wc -c)-3)/2 ))B"
echo "   params: $(cast call $OB 'getMarketParams()(uint32,uint96,address,uint256,address,uint256,uint32,uint96,uint96,uint256,uint256)' --rpc-url $R | tr '\n' ' ')"

echo "3. maker approve + deposit 500 YES & 500 tUSDC into margin"
s $MK $YES 'approve(address,uint256)' $MA 1000000000
s $MK $Q   'approve(address,uint256)' $MA 1000000000
s $MK $MA 'deposit(address,address,uint256)' $MKA $YES 500000000
s $MK $MA 'deposit(address,address,uint256)' $MKA $Q   500000000
echo "   maker margin YES=$(bal $MKA $YES) tUSDC=$(bal $MKA $Q)"

echo "4. maker posts bid 0.400 x 100 claims and ask 0.600 x 100 claims (post-only)"
s $MK $OB 'addBuyOrder(uint32,uint96,bool)'  400 100000 true
s $MK $OB 'addSellOrder(uint32,uint96,bool)' 600 100000 true
echo "   bestBidAsk: $(cast call $OB 'bestBidAsk()(uint256,uint256)' --rpc-url $R | tr '\n' ' ')"
echo "   maker margin after resting: YES=$(bal $MKA $YES) tUSDC=$(bal $MKA $Q)"
echo "   L2 bytes: $(cast call $OB 'getL2Book()(bytes)' --rpc-url $R | head -c 200)..."

if [ "${KEEP_BOOK:-0}" = 1 ]; then echo "KEEP_BOOK=1: leaving maker quotes resting; market=$OB yes=$YES"; exit 0; fi

echo "5. taker deposits 100 tUSDC, market-buys YES with margin"
s $TK $Q  'approve(address,uint256)' $MA 1000000000
s $TK $MA 'deposit(address,address,uint256)' $TKA $Q 100000000
TB0=$(bal $TKA $Q); TY0=$(bal $TKA $YES)
s $TK $OB 'placeAndExecuteMarketBuy(uint96,uint256,bool,bool)' 30000 0 true false
echo "   taker margin: tUSDC $TB0 -> $(bal $TKA $Q) ; YES $TY0 -> $(bal $TKA $YES)"
echo "   maker margin: YES=$(bal $MKA $YES) tUSDC=$(bal $MKA $Q)"
echo "   bestBidAsk: $(cast call $OB 'bestBidAsk()(uint256,uint256)' --rpc-url $R | tr '\n' ' ')"

echo "6. taker market-sells 10 YES into the bid (wallet->margin first)"
s $TK $YES 'approve(address,uint256)' $MA 1000000000
s $TK $MA 'deposit(address,address,uint256)' $TKA $YES 10000000
TB1=$(bal $TKA $Q)
s $TK $OB 'placeAndExecuteMarketSell(uint96,uint256,bool,bool)' 10000 0 true false
echo "   taker margin tUSDC $TB1 -> $(bal $TKA $Q) ; YES=$(bal $TKA $YES)"

echo "7. maker cancels resting orders (ids from OrderCreated logs)"
IDS=$(B=$(cast block-number --rpc-url $R); cast logs --from-block $((B-60)) --to-block $B --address $OB 'OrderCreated(uint40,address,uint96,uint32,bool)' --rpc-url $R --json \
  | python3 -I -c 'import json,sys; print(",".join(str(int(l["data"][2:66],16)) for l in json.load(sys.stdin)))')
echo "   order ids: [$IDS]"
s $MK $OB 'batchCancelOrders(uint40[])' "[$IDS]"
echo "   bestBidAsk after cancel: $(cast call $OB 'bestBidAsk()(uint256,uint256)' --rpc-url $R | tr '\n' ' ')"

echo "8. withdraw everything back to wallets"
for k in $MK $TK; do a=$(cast wallet address $k); for t in $YES $Q; do b=$(bal $a $t); [ "$b" != 0 ] && s $k $MA 'withdraw(uint256,address)' $b $t; done; done
echo "   maker wallet YES=$(wb $MKA $YES) tUSDC=$(wb $MKA $Q) margin YES=$(bal $MKA $YES) tUSDC=$(bal $MKA $Q)"
echo "   taker wallet YES=$(wb $TKA $YES) tUSDC=$(wb $TKA $Q) margin YES=$(bal $TKA $YES) tUSDC=$(bal $TKA $Q)"
echo "   in Kuru MarginAccount (fees): YES=$(wb $MA $YES)"
echo "   total YES=$(( $(wb $MKA $YES)+$(wb $TKA $YES) )) (minted 2000000000) total tUSDC=$(( $(wb $MKA $Q)+$(wb $TKA $Q) )) (minted 2000000000)"
