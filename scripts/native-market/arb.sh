#!/usr/bin/env bash
# Complete-set arbitrage demonstration (NM-E07). Executes both legs on real books and reports the
# profit from actual collateral balances, not from midpoints.
#   split-sell <claims>: when YES bid + NO bid > 1: split, sell both sides into the bids.
#   buy-merge  <claims>: when YES ask + NO ask < 1: buy both sides at the asks, merge back to collateral.
# Preview uses top-of-book only and refuses if either top level cannot fill the whole size.
# Fees are the books' configured fees (0 in the demo listing); gas is reported separately by the chain.
# Env: R, D, KEY (as spot.sh). Units: claims are whole claims (1 claim = 1000 lots = 1e6 atoms).
set -euo pipefail
: "${R:?rpc}" "${D:?deployment json}" "${KEY:?private key}"
HERE=$(cd "$(dirname "$0")" && pwd); SPOT="bash $HERE/spot.sh"
MA=${KURU_MARGIN:-0xd029C2D98ff85D8F64799017fE00a59B1159CE02}
j() { jq -r ".$1" "$D"; }
C=$(j collateral); YES=$(j yesToken); NO=$(j noToken); YB=$(j yesBook); NB=$(j noBook); ME=$(cast wallet address "$KEY")
L2='getL2Book()(bytes)'
# Top level of one side from getL2Book: prints "<tick> <lots>" (bids: first level; asks: first level after the zero word).
top() { local hex; hex=$(cast call "$1" "$L2" --rpc-url "$R"); python3 -I - "$hex" "$2" <<'P'
import sys
h=sys.argv[1][2:]; w=[int(h[i:i+64],16) for i in range(0,len(h),64)]
i=1; bids=[]
while i<len(w) and w[i]!=0: bids.append((w[i],w[i+1])); i+=2
i+=1; asks=[]
while i<len(w) and w[i]!=0: asks.append((w[i],w[i+1])); i+=2
lv=(max(bids) if bids else (0,0)) if sys.argv[2]=="bid" else (min(asks) if asks else (0,0))
print(lv[0], lv[1])
P
}
coll() { echo $(( $(cast call "$C" 'balanceOf(address)(uint256)' "$ME" --rpc-url "$R" | awk '{print $1}') \
  + $(cast call "$MA" 'getBalance(address,address)(uint256)' "$ME" "$C" --rpc-url "$R" | awk '{print $1}') )); }
claims=${2:?claims}; lots=$((claims * 1000)); atoms=$((claims * 1000000))

case "${1:-}" in
  split-sell)
    read -r yb yl < <(top "$YB" bid); read -r nb nl < <(top "$NB" bid)
    echo "preview: YES bid $yb x $yl lots, NO bid $nb x $nl lots; sum $((yb + nb))/1000 per set"
    [ $((yb + nb)) -gt 1000 ] || { echo "no split-sell opportunity (bids sum <= 1)"; exit 3; }
    [ "$yl" -ge "$lots" ] && [ "$nl" -ge "$lots" ] || { echo "top-of-book too small for $claims sets"; exit 3; }
    echo "expected gross: $claims x ($((yb + nb)) - 1000)/1000 = $((claims * (yb + nb - 1000)))/1000 collateral"
    before=$(coll)
    $SPOT split "$atoms"; $SPOT deposit yes "$atoms"; $SPOT deposit no "$atoms"
    $SPOT sell yes "$lots" 0; $SPOT sell no "$lots" 0
    after=$(coll); echo "realized: collateral (wallet + Kuru) $before -> $after, profit $((after - before)) atoms";;
  buy-merge)
    read -r ya yl < <(top "$YB" ask); read -r na nl < <(top "$NB" ask)
    echo "preview: YES ask $ya x $yl lots, NO ask $na x $nl lots; sum $((ya + na))/1000 per set"
    [ "$ya" -gt 0 ] && [ "$na" -gt 0 ] && [ $((ya + na)) -lt 1000 ] || { echo "no buy-merge opportunity (asks sum >= 1)"; exit 3; }
    [ "$yl" -ge "$lots" ] && [ "$nl" -ge "$lots" ] || { echo "top-of-book too small for $claims sets"; exit 3; }
    echo "expected gross: $claims x (1000 - $((ya + na)))/1000 = $((claims * (1000 - ya - na)))/1000 collateral"
    before=$(coll)
    $SPOT deposit usdc $((claims * (ya + na) * 1000))
    $SPOT buy yes $((claims * ya)) 0; $SPOT buy no $((claims * na)) 0
    $SPOT withdraw yes "$atoms"; $SPOT withdraw no "$atoms"; $SPOT merge "$atoms"
    after=$(coll); echo "realized: collateral (wallet + Kuru) $before -> $after, profit $((after - before)) atoms";;
  *) echo "usage: arb.sh split-sell|buy-merge <claims>" >&2; exit 2;;
esac
