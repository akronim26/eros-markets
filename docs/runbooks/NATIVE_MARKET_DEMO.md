# Native market demo runbook (Monad testnet)

Tracker: [NATIVE_MARKET_TRACKER.md](../implementation/NATIVE_MARKET_TRACKER.md). Every step below was rehearsed on a fork and then **run publicly on 2026-10-12** for the BTC > $82,500 market: see the [public run record](../../artifacts/native-market/public-20261012-btc-82500/README.md) for addresses and transactions.

The demo uses test collateral (tUSDC), a 1× perp, funding off, team-controlled liquidity, a single trusted observer key and sandbox adjudication. Say so on stage.

## 0. Inputs you must supply

| Input | Used for | Notes |
| --- | --- | --- |
| `LISTER_KEY` | deploy, `createMarket`, Timelock `propose`/`execute` | The registry lister `0xFf49…F190` is a plain wallet, and it also holds Timelock PROPOSER/EXECUTOR (delay 300 s). Needs MON. |
| `OBSERVER_KEY` | INDEX signer and relayer | Its address is pinned in the listing as `indexSigner`; it cannot be rotated afterwards. Needs MON; never trades. |
| `MAKER_KEY` | native spot maker (split + Kuru quotes) | MON + tUSDC (faucet) |
| `PERP_MAKER_KEY`, `KEEPER_KEY`, `TRADER_KEY` | perp quotes, `samplePerp`/rollover, user trades | MON (+ tUSDC for maker/trader). Each `samplePerp` call costs ~7.3M gas |
| Event text | question and rules | One unambiguous binary event. `T` must be at least 24 h after listing (engine minimum); use about 48 h. |

Keep keys in a private, gitignored env file (`secrets.md` is already ignored); never in `artifacts/` or the tracker.

```bash
export RPC=https://testnet-rpc.monad.xyz            # or a private RPC
export F=$PWD/packages/pricefeed/var/tools/foundry-v1.8.3/forge   # pinned forge for the public chain
export TUSDC=0x82C7236A14B635AFB6dC825115570aFE4C23c1DB TIMELOCK=0x9fe0cF0DD3d190347548c2dC71cdbb4aAAC211F5
cast send $TUSDC 'mint(address,uint256)' <addr> 100000000000 --rpc-url $RPC --private-key <key>   # faucet: <=100,000 tUSDC per call
(cd packages/pricefeed && npm run build)
```

## 1. Deploy the vault and Kuru books (NM-D02/D03)

Create `oracle/deployments/native/<name>.params.json`:

```json
{"registry":"0x780E73dDc65113F8C9C506daa25A0404Ed9f3E33","marketId":"<cast keccak 'eros-native:<slug>'>",
 "collateral":"0x82C7236A14B635AFB6dC825115570aFE4C23c1DB","rules":"<EXACT rules text>","scheduledT":<unix T>,
 "issuanceCap":10000000000,"yesSymbol":"eYES","noSymbol":"eNO","kuruRouter":"0x7EFbE105Ca7415dE98F96622173458ac1c054630",
 "kuru":{"pricePrecision":1000,"sizePrecision":1000,"tickSize":1,"minSize":1,"maxSize":1000000000,"takerFeeBps":0,"makerFeeBps":0,"ammSpread":100},
 "out":"deployments/native/<name>.json"}
```

```bash
cd oracle && NATIVE_PARAMS=deployments/native/<name>.params.json $F script script/native/DeployNativeMarket.s.sol \
  --skip UmaImports --skip 'test/**' --rpc-url $RPC --broadcast --private-key $LISTER_KEY
```

The script refuses to run again if `out` exists. Kuru precision 1000/1000 makes 1 Kuru size unit = 1 Eros lot and 1 price unit = 1 tick.

## 2. Rules hash and listing fields (NM-F02)

```bash
cd packages/pricefeed && node dist/scripts/native-rules.js ../../oracle/deployments/native/<name>.json \
  $(cast wallet address $OBSERVER_KEY) 100000 50000000000000000 ../../oracle/deployments/native/<name>.rules.json
```

Copy the printed `engineListing` values into `oracle/deployments/native/<name>.listing.json`:

```json
{"question":"<question>","rules":"<EXACT same rules text>","templateMarketId":"0x86c606de50da38158856aabc7fbb9337d30a3f9cd50f34a855272a32332d1522",
 "oiCapLots":1000000,"indexSourceId":"<printed>","indexSigner":"<observer address>","indexRulesHash":"<printed>",
 "depthNLots":100000,"maxSpreadWad":50000000000000000}
```

N = 100 claims with a 0.05 spread. Both native YES depth and Eros perp depth must cover N on each side.

## 3. List, bind and activate (NM-D04/D05, NM-G01)

```bash
cd oracle && NATIVE_DEPLOYMENT=deployments/native/<name>.json NATIVE_LISTING=deployments/native/<name>.listing.json \
  $F script script/native/ListNativeMarket.s.sol --skip UmaImports --skip 'test/**' --rpc-url $RPC --broadcast --slow \
  --gas-estimate-multiplier 105 --private-key $LISTER_KEY   # createMarket ~27.9M gas; Monad's 30M tx cap rejects forge's default 1.3x
# prints `engine <addr>`; export ENGINE=<addr>
ENGINE=$ENGINE $F script script/native/ActivateNativeMarket.s.sol --skip UmaImports --skip 'test/**' --rpc-url $RPC
cast send $TIMELOCK <printed propose calldata> --rpc-url $RPC --private-key $LISTER_KEY
sleep 310; cast send $TIMELOCK <printed execute calldata> --rpc-url $RPC --private-key $LISTER_KEY
cast call $ENGINE 'active()(bool)' --rpc-url $RPC      # true
```

## 4. Native spot: split, quote, trade (NM-E02/E04/E06)

```bash
export R=$RPC D=oracle/deployments/native/<name>.json
KEY=$MAKER_KEY bash scripts/native-market/spot.sh split 1000000000           # 1,000 complete sets
KEY=$MAKER_KEY bash scripts/native-market/spot.sh deposit yes 500000000
KEY=$MAKER_KEY bash scripts/native-market/spot.sh deposit no 500000000
KEY=$MAKER_KEY bash scripts/native-market/spot.sh deposit usdc 1000000000
KEY=$MAKER_KEY bash scripts/native-market/spot.sh quote yes 550 580 200000    # 0.550/0.580 x 200 claims
KEY=$MAKER_KEY bash scripts/native-market/spot.sh quote no 420 450 200000
KEY=$TRADER_KEY bash scripts/native-market/spot.sh deposit usdc 100000000
KEY=$TRADER_KEY bash scripts/native-market/spot.sh buy yes 29000 0          # spend 29 tUSDC on YES
KEY=$TRADER_KEY bash scripts/native-market/spot.sh status
```

The maker's quotes come from its own judgement or external information, **never** from the perp's MARK or the native INDEX.

## 5. Native INDEX publisher (NM-F08)

```bash
cd packages/pricefeed && NATIVE_OBSERVER_KEY=$OBSERVER_KEY nohup node dist/scripts/native-publish.js $RPC \
  ../../oracle/deployments/native/<name>.rules.json $ENGINE 100000 15000 finalized > native-publish.log 2>&1 &
```

- Run exactly **one** publisher. A second one fails with `DuplicateOrOldSequence`.
- A 15 s cadence stays below the 120 s testnet INDEX carry.
- A thin, crossed or empty book publishes invalid-depth checkpoints, and INDEX becomes unavailable.

## 6. Native-priced perp (NM-G02–G04)

```bash
export ENG=$ENGINE
KEY=$PERP_MAKER_KEY bash scripts/native-market/perp.sh fund 500000000
KEY=$PERP_MAKER_KEY bash scripts/native-market/perp.sh quote 600 620 150000   # around the current native INDEX
KEY=$KEEPER_KEY     bash scripts/native-market/perp.sh keeper 60 2           # samplePerp until activatePricing succeeds
KEY=$TRADER_KEY     bash scripts/native-market/perp.sh fund 100000000
KEY=$TRADER_KEY     bash scripts/native-market/perp.sh buy 620 20000          # 1x long 20 claims
KEY=$TRADER_KEY     bash scripts/native-market/perp.sh status
KEY=$TRADER_KEY     bash scripts/native-market/perp.sh close 600 20000 sell
```

- **Every hour:** run `KEY=$KEEPER_KEY perp.sh rollover`, then re-quote the perp maker and run `perp.sh keeper` until PERP is valid again. Old perp orders do not survive a rollover. Avoid demoing across xx:00.
- **Gas:** the CLIs add a 30% gas-limit margin, because exact estimates go stale while the keeper and publisher are running.

### Keep it running

```bash
R=$RPC ENG=$ENGINE KEEPER_KEY=$KEEPER_KEY PERP_MAKER_KEY=$PERP_MAKER_KEY \
  setsid nohup bash scripts/native-market/keeper-daemon.sh > tmp/native-public/keeper.log 2>&1 &
```

- The keeper loop samples every 90 s (about 0.063 MON per sample, so about 2.5 MON/h).
- When the hourly rollover opens, it runs the rollover and re-posts the perp maker's quotes.
- It stops itself when the keeper balance drops below 2 MON.

## 7. Settlement (NM-H)

A market listed today cannot reach T during the demo. Show the local real-stack proof, labelled as local:

```bash
cd oracle && FOUNDRY_PROFILE=integration $F test --skip UmaImports --skip 'test/uma/**' --match-path test/integration/NativeSettlement.t.sol
```

It covers YES, NO, a rejected proposal, INVALID at the 0.5 fallback, and INVALID at 0.63 from a complete history. Native redemption equals the engine's settlement price, and perp claims are paid separately.

The live market later follows `spot.sh sync` → `spot.sh redeem <yes> <no>`. Cancel and withdraw Kuru-held tokens first.

## 8. Shutdown

- Cancel maker orders: `spot.sh cancel yes|no <ids>`; perp orders are cancelled through the engine.
- Withdraw Kuru margin with `spot.sh withdraw`.
- Stop the publisher.
- Record remaining positions and who keeps rollover and resolution running until settlement.
