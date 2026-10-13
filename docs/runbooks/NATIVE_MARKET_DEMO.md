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

### Keep it running: `ops.sh` (NM-J01/J02)

Run the publisher and keeper loop through the operator runtime, not by hand.

**Private config:** create `tmp/native-public/ops.env`. It must be mode 600 (the runner enforces this) and is gitignored. It contains:
- `MONAD_RPC_URL` (the Spectrum endpoint: all transactions, gas estimates and the rollover simulation use it);
- optionally `MONAD_READ_FALLBACK_URLS`: comma-separated HTTPS endpoints (the Alchemy pair from `rpc-pool.env`) that the publisher, keeper and runner try in order for reads when `MONAD_RPC_URL` fails;
- `NATIVE_OBSERVER_PRIVATE_KEY`, `NATIVE_KEEPER_PRIVATE_KEY`, `NATIVE_PERP_MAKER_PRIVATE_KEY`;
- `NATIVE_DEPLOYMENT`, `NATIVE_RULES`, `NATIVE_ENGINE`;
- optionally `PUBLISH_MS` (60000) and `KEEPER_EVERY` (90).

```bash
bash scripts/native-market/ops.sh check    # read-only: 19 on-chain checks, role runway, engine stage
bash scripts/native-market/ops.sh start    # refuses unless verification passes; one writer per service (flock)
bash scripts/native-market/ops.sh status   # supervisors, last log lines, INDEX availability
bash scripts/native-market/ops.sh stop
```

How the services behave:
- **Restarts:** each service restarts with backoff (10 s up to 300 s) and stops for operator review after `MAX_RESTARTS`.
- **Secrets:** keys and the RPC URL reach the processes only through the environment, never through command-line arguments.
- **Keeper loop:** samples every 90 s (≈0.063 MON per sample), runs the hourly rollover, and keeps the perp maker's quotes centred on native INDEX. The perp book has to stay near INDEX or PERP becomes unavailable.
- **Publisher at a 60 s cadence:** ≈1.5 MON/h, still inside the 120 s INDEX carry.

**Verify any deployment, read-only:** `node packages/pricefeed/dist/scripts/native-verify.js <rpc> <deployment.json> <rules.json>`

### Movement guard (important for demos)

If native INDEX moves more than **0.10 within 300 s**, the engine latches `movementRestricted` and the market goes **REDUCE_ONLY**: new perp risk is rejected with `OrderRejected(BAD_STAGE)`. Only the monitor (the listing's monitor key) can lift it, with `clearReduceOnly(reason)`, after a human decides the move is understood. Keep simulated or staged moves gradual; the simulator caps each re-quote at `MAX_STEP_TICKS` (6).

### Simulated activity (demo only)

```bash
RPC=… D=<deployment.json> MAKER_KEY=<spot maker> TAKER_KEYS=<k1,k2,k3> STRIKE=82500 DURATION_MIN=10 \
  node packages/pricefeed/dist/scripts/native-sim.js
```

- **Maker:** quotes around a fair value from outside Eros (Kraken BTC model), skewed by its inventory; rate-limited; posts new quotes before cancelling old ones; cancels its own leftover orders at startup.
- **Takers:** noise, momentum and contrarian bots.
- **Cost:** about 0.1–0.2 MON per maker re-quote and 0.03 MON per taker trade.
- **Label:** everything it produces is controlled team activity.

**Arbitrage demo:** `KEY=<trader> bash scripts/native-market/arb.sh split-sell|buy-merge <claims>`, run after staging a mispricing with `spot.sh bid|ask`.

## 7. Settlement (NM-H)

A market listed today cannot reach T during the demo. Show the local real-stack proof, labelled as local:

```bash
cd oracle && FOUNDRY_PROFILE=integration $F test --skip UmaImports --skip 'test/uma/**' --match-path test/integration/NativeSettlement.t.sol
```

It covers YES, NO, a rejected proposal, INVALID at the 0.5 fallback, and INVALID at 0.63 from a complete history. Native redemption equals the engine's settlement price, and perp claims are paid separately.

The live market later follows `spot.sh sync` → `spot.sh redeem <yes> <no>`. Cancel and withdraw Kuru-held tokens first.

### Early YES resolution (public, proven 2026-10-12)

For an "X happens before T" event that has really happened:

```bash
cd oracle && REGISTRY=0x780E73dDc65113F8C9C506daa25A0404Ed9f3E33 MARKET_ID=<id> PAYER_KEY=<lister> \
  MONITOR_KEY=<monitor> ATTESTOR_KEY=<runner attestor> COMMITTEE_A_KEY=<c1> COMMITTEE_B_KEY=<c2> \
  EVIDENCE_URI=<url> EVIDENCE_HASH=<hash> STAGE=propose $F script script/native/ResolveNativeEarly.s.sol \
  --skip UmaImports --skip 'test/**' --rpc-url $RPC --broadcast --slow
# after the 300 s liveness:
STAGE=finalize ... (same command)
# then: spot.sh sync; holders withdraw from Kuru and spot.sh redeem <yes> <no>
```

Limits:
- **YES only:** NO and at-T conditions wait for T.
- **Time window:** the early check expires after `earlyTtlSecs` (600 s).
- **Not decentralized:** every role key and the sandbox venue are team-controlled.

## 8. Shutdown

- Cancel maker orders: `spot.sh cancel yes|no <ids>`; perp orders are cancelled through the engine.
- Withdraw Kuru margin with `spot.sh withdraw`.
- Stop the publisher.
- Record remaining positions and who keeps rollover and resolution running until settlement.

## 9. Demo freeze: live state and known limitations (NM-J07, 2026-10-13)

**Frozen public identities.**
- **BTC > $82,500 market:** [record](../../artifacts/native-market/public-20261012-btc-82500/README.md). Engine `0xE7C1…D606`, vault `0x17f4…706a`, Kuru YES `0x91e1…30F9` / NO `0x6A40…7AAb`.
- **Block-height market (resolved YES):** [record](../../artifacts/native-market/public-20261012-block-70528000/README.md).
- **Verification:** both pass `native-verify` 19/19.

**Demo sequence (about 10 minutes):**
1. `ops.sh check` (live identities, runway, stage).
2. Kuru books via `spot.sh status`: about 900+ claims per side, 4 levels.
3. Split and merge a complete set.
4. A trade on Kuru, then the INDEX update on the frontend chart.
5. Optional simulator run for price movement.
6. The arbitrage demo.
7. The block-market settlement evidence: oracle → engine → vault → 20 YES redeemed for 20 tUSDC.

**Known limitations (state these on stage):**
- **Controlled activity:** all native liquidity and trading is team-controlled or simulated; native INDEX is not independent price discovery.
- **Trusted parties:** one INDEX signer key; resolution through committee and sandbox-UMA keys held by the team. Test collateral only.
- **1× only:** funding off; no calibration; no leverage on native-priced markets.
- **Movement guard:** a > 0.10 INDEX move within 300 s latches reduce-only until the monitor clears it.
- **Single host:** the bots run on one laptop under `ops.sh`; they stop if it sleeps. There is no redundancy, and the Polymarket supervisor integration was not done.
- **Kuru availability:** Kuru-held tokens must be withdrawn before redemption. Third-party trading on Kuru cannot be halted by Eros.
- **Not built:** the frontend Spot tab (split, merge, redeem, Kuru ticket) and the indexer (chart history beyond the RPC's ~30 s window). Both are tracked as optional.
