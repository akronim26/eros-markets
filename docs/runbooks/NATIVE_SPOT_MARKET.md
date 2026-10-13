# Native spot prediction market (NBA: Heat at Warriors, 5 Nov 2026 PT)

A normal prediction market: YES and NO ERC-20 tokens backed 1:1 by tUSDC in a `NativeOutcomeVault`,
traded on two Kuru order books and resolved by the Eros oracle from API-Sports basketball. No perp,
INDEX source, signer, perp keeper or funding exists for this market. Items NM-S01..S12.

| | |
|---|---|
| Event | Miami Heat (147) at Golden State Warriors (141), API-Sports basketball game **519655**, league 12, season `2026-2027` |
| Tip-off (T) | `1793934000` = 2026-11-06T03:00:00Z = 7:00 p.m. PT, 5 Nov |
| YES | Warriors win (overtime included) · NO: Heat win |
| INVALID | postponed/cancelled/not completed, or unresolved at the void deadline: **0.50 per YES and per NO** |
| Market id | `0x8504d173055ab1bce57f6a4f4ac80340157e3cbe7fedf0ac06bfa515e818964c` |
| Feed | `oracle/listings/native/nba-gsw-mia-20261105-spot/feed.json`, specHash `0xc33ab250…9920` |

## How it works

```
tUSDC ──split──▶ NativeOutcomeVault ──▶ YES + NO ──▶ Kuru YES/tUSDC and NO/tUSDC books
                        │ binds to (registry-selected)
                        ▼
MarketRegistry ──▶ SpotResolutionAnchor ◀── ResolutionOracle ◀── CRE workflow ◀── API-Sports
                   (halt at T, final outcome)        (sim forwarder)    game 519655
```

- `SpotResolutionAnchor` (`oracle/src/native/`) is the market's registry "engine": it only records the
  halt at T and the oracle's final outcome. Open interest is 0, so the assertion bond is the 2 tUSDC
  minimum. INVALID reports the registry's fixed 0.5 fallback price, which the vault pays per token.
- The registry has one factory. Governance points it at `SpotMarketFactory` for this listing and back
  to the perp `MarketFactory` afterwards.
- Lifecycle: from T−1 h the lifecycle service reads the game (pre-game check). At T: `haltScheduled`
  stops new splits (existing tokens still trade and merge). From T+2 h the service reads the game every
  10 min; once the shared evaluator sees `FT`/`AOT` it calls `requestResolution`, the CRE listener
  reports YES/NO, the service asserts it (120 s liveness) and finalizes, then calls `vault.syncResolution()`.
  No clean API result within T+6 h: `escalateToL2` hands over to the committee/review route.
- Kuru books are permissionless, so tokens can trade during the game like any prediction market.
  The Eros maker stops quoting 60 s before tip-off.

## Bots

| Service | What it does |
|---|---|
| `maker.ts` | Eros liquidity. Holds complete sets; quotes YES `fair ± H` and NO `(1000−fair) ± H` (H = 15 ticks, 100 claims). YES ask + NO ask > 1 and YES bid + NO bid < 1, so its quotes never offer a split/merge arbitrage. `fair` starts at `OPEN_TICK` and moves only with its own net fills (4 ticks per 100 claims, at most 10 per loop). Stops quoting one side at ±600 net claims. Cancels everything 60 s before T. |
| `daily-trader.ts` | One real taker trade per UTC day at 17:00: market-buys 10 claims, alternating YES/NO, with a 90% minimum fill and a 0.95 price cap. Holds to resolution. State file prevents double trades. |
| `lifecycle.ts` | The oracle calls listed above; never reports outcomes itself. |

There are no simulated takers; volume comes from real users and the daily trader.

## Go live

1. On-chain (lister/Timelock proposer key): `RPC=… LISTER_KEY=0x… bash scripts/native-market/spot-golive.sh`
   deploys the factory, runs the Timelock op (providers `v1.basketball.api-sports.io`, `www.nba.com`,
   `www.espn.com`; authRef `EROS_API_BASKETBALL_V1`; `bufferMaxSecs` 600→7200 and `l1TimeoutMaxSecs`
   3600→21600, every other global unchanged; factory), deploys the vault and books, lists and binds,
   then restores the perp factory. Each Timelock op waits its delay (~5 min).
2. Retire the old perp-linked NBA market: `bash scripts/native-market/ops.sh stop`, stop `native-sim`,
   then for each wallet holding it
   `D=oracle/deployments/native/nba-mia-gsw-20261105.json RPC=… KEY=0x… bun packages/pricefeed/scripts/native-spot/retire.ts`
   (cancel orders, withdraw Kuru margin, merge sets). Mark it `archived` in `frontend/src/config/market-metadata.json`.
3. Oracle listener: install and log in to the CRE CLI, then `oracle/workflows/listen/supervise.sh <state-dir>`.
   `oracle/workflows/.env` (gitignored, 600) needs `MONAD_TESTNET_RPC`, `CRE_ETH_PRIVATE_KEY` (an
   authorized, funded sim relayer) and `SPORTSDATA_API_KEY_VALUE`. The fresh-testnet target now uses
   `secrets.yaml` and the basketball authRef.
4. Services: create `tmp/native-spot/nba-gsw-mia-20261105-spot/ops.env` (mode 600):
   ```
   RPC=https://testnet-rpc.monad.xyz
   D=oracle/deployments/native/nba-gsw-mia-20261105-spot.json
   FEED=oracle/listings/native/nba-gsw-mia-20261105-spot/feed.json
   OPEN_TICK=520            # opening YES price 0.520: carried over from the old market's quoted mid, not a model
   MAKER_KEY=0x…  TRADER_KEY=0x…  KEEPER_KEY=0x…
   SPORTSDATA_API_KEY_VALUE=…
   ```
   then `bash scripts/native-market/spot-ops.sh start|status|stop`.
5. Frontend: add the deployment to `frontend/src/config/native-markets.json` with `"spotOnly": true`
   (opens directly in Spot · Kuru, no perp switch) and a manifest/metadata entry; verify the market
   page against the deployed anchor before announcing it.
6. After resolution: `maker.ts settle` and `daily-trader.ts settle` withdraw and redeem.

## API budget

The key is on the API-Sports Free plan: 100 requests/day, dates limited to ±1 day around today
(lookup by game id is not date-limited). Usage on game day: about 4 pre-game reads, one read every
10 min after T+2 h, plus one CRE read per resolution request. Well under the limit.

## Evidence (2026-10-13)

- `oracle/packages/feedspec`: `bun test`: 162 pass (12 new basketball checks on real captures of
  games 519655 and 519511).
- `forge test --match-path test/native/NativeSpotMarket.t.sol`: 9 pass (YES, NO, rejected report,
  INVALID 0.5, tip-off issuance, buffer, anchor auth).
- `NATIVE_FORK_RPC=https://testnet-rpc.monad.xyz forge test --match-path test/native/NativeSpotFork.t.sol`:
  1 pass on live testnet state (Timelock calls, listing, bind, halt, L1 report, 2 tUSDC assertion).
- `oracle/workflows/resolution` 15 pass; `oracle/workflows/listen` 7 pass; frontend `tsc --noEmit` clean.
- Full `oracle` `forge test`: 335 pass; 3 pre-existing failures load UMA artifacts that need the separate legacy-0.8.16 build (`out/Finder.sol`).
- Simulated (not broadcast) on testnet: SpotMarketFactory, vault, tokens and both Kuru books.
- Lifecycle service pre-game read against the live API: `NOT_READY/SPORTS_NOT_FINAL`, game NS, tip-off matches.
