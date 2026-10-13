# Perp maker re-quote for keeper-daemon.sh (sourced; needs R, ENG, PERP_MAKER_KEY, HERE, rd, ts).
# cancelAll() only moves the maker to a new order epoch: its old orders stay in the book until a taker
# reaches them, so after a move wider than the spread a new post-only quote "crosses" them and reverts
# (PostOnlyCrosses). Re-quote instead with one batch(cancels, places): cancel the maker's own orders by
# id (physically removed), then place both sides. The ids come from the OrderPlaced events of the
# previous re-quote (QUOTE_STATE); without that file they are recovered once from recent logs.
# Env: QUOTE_STATE (default tmp/keeper-quotes-<engine>.ids), QUOTE_LOOKBACK=12000 blocks (~80 min).
QUOTE_STATE=${QUOTE_STATE:-tmp/keeper-quotes-$ENG.ids}
QUOTE_LOOKBACK=${QUOTE_LOOKBACK:-12000}
PLACED_TOPIC=$(cast keccak 'OrderPlaced(uint32,uint32,uint16,uint64,uint8,uint32)')
MAKER_ADDR=$(cast wallet address "$PERP_MAKER_KEY")
BATCH='batch(uint32[],(uint8,bool,bool,uint16,uint64,uint8,uint32)[])'
ORDER='getOrder(uint32)((uint32,uint64,uint32,uint32,uint16,uint8,uint8,uint64,uint64,uint64,uint32,uint256))'

# OrderPlaced ids of trader $1 in the JSON log array on stdin.
_placed_ids() { node -e '
  const [topic, trader] = process.argv.slice(1); let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    let logs; try { logs = JSON.parse(s); } catch { return; } if (!Array.isArray(logs)) logs = logs.logs || [];
    for (const l of logs) if (l.topics && l.topics[0] === topic && BigInt(l.topics[2]) === BigInt(trader)) console.log(Number(BigInt(l.topics[1])));
  });' "$PLACED_TOPIC" "$1"; }

# Keep only ids that are still live orders of trader $1 (getOrder fields: owner, size, ..., flags 6th).
_live_only() { local trader=$1 id owner size flags; while read -r id; do [ -n "$id" ] || continue
  read -r owner size flags < <(rd call "$ENG" "$ORDER" "$id" | tr -d '()' | sed 's/ \[[^]]*\]//g' | awk -F', ' '{print $1, $2, $6}') || continue
  [ "$owner" = "$trader" ] && [ "${size:-0}" != 0 ] && [ $(( ${flags:-0} & 4 )) != 0 ] && echo "$id"
done; return 0; }

maker_live_ids() { local mid; mid=$(rd call "$ENG" 'participantId(address)(uint32)' "$MAKER_ADDR") || return 1
  if [ -s "$QUOTE_STATE" ]; then _live_only "$mid" < "$QUOTE_STATE"; return; fi
  local head from; head=$(rd block-number) || return 1
  for ((from = head - QUOTE_LOOKBACK; from <= head; from += 100)); do
    rd logs --from-block "$from" --to-block $((from + 99 > head ? head : from + 99)) --address "$ENG" --json | _placed_ids "$mid"
  done | _live_only "$mid"; }

# requote <bidTick> <askTick> <lots>: one transaction; records the new order ids.
requote() { local mid cancels out h
  mid=$(rd call "$ENG" 'participantId(address)(uint32)' "$MAKER_ADDR") || return 1
  cancels=$(maker_live_ids | head -6 | paste -sd, -)
  out=$(KEY=$PERP_MAKER_KEY ENG=$ENG R=$R bash -c "eval \"\$(sed -n '1,14p' '$HERE/perp.sh')\"; tx \"\$ENG\" '$BATCH' '[$cancels]' '[(2,true,false,$1,$3,8,0),(2,false,false,$2,$3,8,0)]'") || return 1
  h=$(printf '%s\n' "$out" | awk '$1=="tx"{print $2}')
  mkdir -p "$(dirname "$QUOTE_STATE")"
  cast receipt "$h" --json --rpc-url "$R" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).logs||[])))' \
    | _placed_ids "$mid" > "$QUOTE_STATE.new" && mv "$QUOTE_STATE.new" "$QUOTE_STATE"
  echo "$(ts) re-quoted $1/$2 x $3 lots, cancelled [${cancels}], live ids [$(paste -sd, - < "$QUOTE_STATE")]"
}
