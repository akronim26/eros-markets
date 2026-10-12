#!/usr/bin/env bash
# Native spot operations on the bound NativeOutcomeVault and its Kuru YES/NO books (NM-E02/E04/E06).
# Thin cast wrappers: every amount is an explicit integer; nothing is inferred.
#   Units: collateral/outcome atoms (6 decimals); Kuru price units = tick/1000; Kuru size units = lots (0.001 claim).
# Env: R (rpc), D (DeployNativeMarket JSON), KEY (signer private key for the action).
set -euo pipefail
: "${R:?rpc}" "${D:?deployment json}" "${KEY:?private key}"
MA=${KURU_MARGIN:-0xd029C2D98ff85D8F64799017fE00a59B1159CE02}
j() { jq -r ".$1" "$D"; }
V=$(j outcomeVault); YES=$(j yesToken); NO=$(j noToken); C=$(j collateral); YB=$(j yesBook); NB=$(j noBook)
ME=$(cast wallet address "$KEY")
tx() { cast send --rpc-url "$R" --private-key "$KEY" "$@" | awk '/^status/{s=$2} /^transactionHash/{h=$2} END{print "  tx", h, s; if (s!=1) exit 1}'; }
book() { case "$1" in yes) echo "$YB";; no) echo "$NB";; *) echo "bad side $1" >&2; exit 2;; esac; }
bal() { cast call "$1" 'balanceOf(address)(uint256)' "$2" --rpc-url "$R" | awk '{print $1}'; }
mbal() { cast call "$MA" 'getBalance(address,address)(uint256)' "$1" "$2" --rpc-url "$R" | awk '{print $1}'; }

cmd=${1:-status}; shift || true
case "$cmd" in
  split)    # split <atoms>: pull collateral, mint equal YES+NO to me
    tx "$C" 'approve(address,uint256)' "$V" "$1"; tx "$V" 'split(uint256,address)' "$1" "$ME";;
  merge)    tx "$V" 'merge(uint256,address)' "$1" "$ME";;
  redeem)   tx "$V" 'redeem(uint256,uint256,address)' "$1" "$2" "$ME";;
  sync)     tx "$V" 'syncResolution()';;
  deposit)  # deposit <yes|no|usdc> <atoms>: wallet -> Kuru margin account
    t=$([ "$1" = usdc ] && echo "$C" || ([ "$1" = yes ] && echo "$YES" || echo "$NO"))
    tx "$t" 'approve(address,uint256)' "$MA" "$2"; tx "$MA" 'deposit(address,address,uint256)' "$ME" "$t" "$2";;
  withdraw) # withdraw <yes|no|usdc> <atoms>: Kuru margin -> wallet
    t=$([ "$1" = usdc ] && echo "$C" || ([ "$1" = yes ] && echo "$YES" || echo "$NO"))
    tx "$MA" 'withdraw(uint256,address)' "$2" "$t";;
  quote)    # quote <yes|no> <bidTick> <askTick> <lots>: post-only two-sided resting quote (margin funded)
    b=$(book "$1"); tx "$b" 'addBuyOrder(uint32,uint96,bool)' "$2" "$4" true; tx "$b" 'addSellOrder(uint32,uint96,bool)' "$3" "$4" true;;
  buy)      # buy <yes|no> <quoteAtoms/1000 units> <minOutLots>: margin-funded market buy
    tx "$(book "$1")" 'placeAndExecuteMarketBuy(uint96,uint256,bool,bool)' "$2" "$3" true false;;
  sell)     # sell <yes|no> <lots> <minOutUnits>
    tx "$(book "$1")" 'placeAndExecuteMarketSell(uint96,uint256,bool,bool)' "$2" "$3" true false;;
  cancel)   # cancel <yes|no> <orderId,...>
    tx "$(book "$1")" 'batchCancelOrders(uint40[])' "[$2]";;
  status)
    echo "account $ME"
    echo "  wallet  usdc=$(bal "$C" "$ME") yes=$(bal "$YES" "$ME") no=$(bal "$NO" "$ME")"
    echo "  kuru    usdc=$(mbal "$ME" "$C") yes=$(mbal "$ME" "$YES") no=$(mbal "$ME" "$NO")"
    echo "  vault   sets=$(cast call "$V" 'outstandingSets()(uint256)' --rpc-url "$R" | awk '{print $1}') issuanceOpen=$(cast call "$V" 'issuanceOpen()(bool)' --rpc-url "$R") resolved=$(cast call "$V" 'resolved()(bool)' --rpc-url "$R")"
    for s in yes no; do echo "  $s book bestBidAsk: $(cast call "$(book $s)" 'bestBidAsk()(uint256,uint256)' --rpc-url "$R" | awk '{print $1}' | tr '\n' ' ')"; done;;
  *) echo "usage: spot.sh split|merge|redeem|sync|deposit|withdraw|quote|buy|sell|cancel|status ..." >&2; exit 2;;
esac
