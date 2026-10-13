# Follow-up deployment: 5x Warriors vs Heat native perp

Status as of 2026-10-14 ~01:50 IST. Monad testnet only. Nothing below is committed yet.

## Goal

Replace the 1x Warriors vs Heat perp (`0xCAc9AC9F5720b0b07D3B78925c33906429e16325`, market
`0xdd09f174…eaf56`) with a 5x perp on the same INDEX (the Kuru eGSW-YES2 book `0xcEF5…24b6`).
A listing is immutable, so this is a new market id, not an upgrade. The Polymarket perp
(`0xA3955B47…8068`) stays as is: it is listed 5x but its Polymarket source book is too thin
(impact 0.353 / 0.800 at 1,000 claims vs 0.05 max spread), so it cannot price and stays at 1x in practice.

## Already done

- `oracle/script/native/ListNativeSpotPerp.s.sol`: reads optional `deploymentCapX` (default 1) and
  `maxLiqLotsPerBlock` (default 0) from the listing JSON; refuses a cap above 1 without liquidation.
- `oracle/script/native/ActivateNativeMarket.s.sol`: optional `PROFILE=<calibration.json>` stages
  `stageRiskParams` before `activateMarket()` in the same Timelock operation. Both compile.
- New market id: `0x16923600608b07715ea532a2b05bb1f4881c8fff4dae9f2a140e282682d2afeb`
  (`cast keccak "eros-native-perp:nba-gsw-mia-20261105:leveraged-5x"`).
- INDEX rules: `oracle/deployments/native/nba-gsw-mia-20261105-spot-perp5x.rules.json`
  (same source id `0x349a…74da1` and signer `0x5aE3…8Dd9`; rules hash `0x737e8111…2a781`).
- Listing input: `oracle/listings/native/nba-gsw-mia-20261105-spot-perp5x/listing.json`
  (`deploymentCapX: 5`, `maxLiqLotsPerBlock: 100000`, rules text says synthetic calibration).
- Risk profile: `oracle/deployments/native/nba-gsw-mia-20261105-spot-perp5x.calibration.json`.
  **SYNTHETIC** fixture (RiskFixture.profile(5,true)), the same one the Polymarket market uses,
  approved by the user for testnet on 2026-10-14. Valid 1791923037 → 1793934000 (tip-off). Not empirical.
- Keys: root `.env` `PRIVATE_KEY` = `0xFf49…cF190` (registry lister, Timelock proposer, ~279 MON).

## Not started / interrupted

The first listing broadcast was simulated OK (predicted engine `0x0ff5EAE643CB7E303f1726A92C03686674D445C0`)
but the RPC rejected it: forge's default 1.3x gas margin made it 37.1M gas, above Monad's 30M per-tx cap.
Nothing landed (market id unlisted, lister nonce 433). The retry was not run.

## Remaining steps

All commands from the repo root unless noted. `R=https://testnet-rpc.monad.xyz`.

### 1. List the 5x perp (~6 MON)

```sh
cast call 0x780E73dDc65113F8C9C506daa25A0404Ed9f3E33 'getMarketCore(bytes32)' \
  0x16923600608b07715ea532a2b05bb1f4881c8fff4dae9f2a140e282682d2afeb --rpc-url $R   # must be all zero
cd oracle && bash -c 'set -a; . ../.env; set +a
  NATIVE_DEPLOYMENT=deployments/native/nba-gsw-mia-20261105-spot.json \
  PERP_LISTING=listings/native/nba-gsw-mia-20261105-spot-perp5x/listing.json \
  forge script script/native/ListNativeSpotPerp.s.sol --rpc-url https://testnet-rpc.monad.xyz \
  --broadcast --gas-estimate-multiplier 104 --private-key $PRIVATE_KEY --skip UmaImports --skip "test/**"'
```

Record the printed engine address as `ENG` (expected `0x0ff5…45C0` if the lister nonce is still 433).

### 2. Reserve for the new engine (as in `oracle/e2e/src/fresh-market.ts`)

CollateralVault `0x5E53c88eB3dA4C8640BC7AF51F0C5f8CC11205e4`, tUSDC `0x82C7236A14B635AFB6dC825115570aFE4C23c1DB`.
From the lister key: `mint(lister, 100000e6)`, `approve(vault, 100000e6)`, `deposit(100000e6)`,
`allocate(ENG, 100000e6, true)`.

### 3. Timelock: stage the profile and activate (300 s delay)

```sh
cd oracle && ENGINE=$ENG PROFILE=deployments/native/nba-gsw-mia-20261105-spot-perp5x.calibration.json \
  forge script script/native/ActivateNativeMarket.s.sol --rpc-url $R --skip UmaImports --skip "test/**"
```

It simulates as the Timelock and prints `propose(MODE, EXEC, delay)` / `execute(MODE, EXEC)`.
Send the propose from the lister key to the Timelock `0x9fe0cF0DD3d190347548c2dC71cdbb4aAAC211F5`,
wait 300 s (+15), send the execute (see `timelock()` in `scripts/native-market/spot-golive.sh`).
Check: `cast call $ENG 'activeProfile()' --rpc-url $R` shows the profile hash.

### 4. Workers for the new engine

- Copy `tmp/native-spot-perp/ops.env` (mode 600) to `tmp/native-spot-perp5x/ops.env` and set
  `NATIVE_ENGINE=$ENG`, `NATIVE_RULES=oracle/deployments/native/nba-gsw-mia-20261105-spot-perp5x.rules.json`.
- Fund the perp maker on the new engine (`KEY=<perp maker> ENG=$ENG R=$R bash scripts/native-market/perp.sh fund …`).
- In `tmp/redeploy-20261011/supervisor.json` replace the `native-nba-gsw-mia-perp` group with one for the
  new engine (`kind: native-spot-perp`, `envFile: tmp/native-spot-perp5x/ops.env`), and add the new market
  id to the spot group's `linkedMarketIds` so the spot lifecycle also resolves it.
- Restart the supervisor: SIGTERM, wait for `supervisor/status.json` = `stopped`, then `check` and `run`
  (commands in `docs/integration/TESTNET_OPERATIONS.md`).
- `keeper-daemon.sh` already re-quotes whenever the market epoch changes (see "Fixed this session").
  Without that, every hourly rollover strands the maker's quotes and the MARK goes unavailable.

### 5. Liquidation (gap — required before real leveraged use)

`native-spot-perp` workers (publisher + keeper) do not scan or liquidate. Only the `polymarket-perp`
kind's operations worker does (`liquidationEnabled`). Either reuse that operations worker for the new
engine or add a liquidation scan to the keeper. Until then leveraged accounts on this market have no
automatic liquidation.

### 6. Frontend

- `frontend/src/config/public-manifest.json` → `markets[]`: add the new perp with
  `name, engine, marketId, sourceId, listingHash, codehash, deployBlock, deploymentCapX: 5, template: 0,
  maxLiqLotsPerBlock: "100000", fundingEnabled: false` (`listingHash` from `cast call $ENG 'listingHash()'`,
  `codehash` = EXTCODEHASH of `$ENG`, `deployBlock` from the broadcast receipt).
- `frontend/src/config/market-metadata.json`: title / short for the new engine.
- Retire the old perp: cancel its maker quotes, remove its supervisor group, mark it archived in the manifest.
- Verify: `/m/$ENG` loads, MARK available within a couple of keeper cycles, `leverageCaps()` returns `(5, 5)`
  once mark is up (the 2x–5x buttons unlock).

### 7. Ship

- Commit all session changes (subject-only conventional messages as xipharis, no Co-Authored-By trailer).
- Native env files and maker/trader state (`oracle/deployments/native/*-state.json`) are not in the
  Render hand-off bundle yet.

## Fixed this session (live, uncommitted)

- Spot market page: deployment check verifies spot-only anchors against `SpotMarketFactory`
  (`frontend/src/lib/deployment-check.ts`, `frontend/src/config/native.ts`).
- Mint/redeem pairs: added `split`/`merge` (+ events, errors) to `frontend/src/abi/nativeVault.ts`.
- Markets page: native markets left, event perps right, resolved section removed
  (`frontend/src/components/markets-index.tsx`).
- Warriors perp MARK: `scripts/native-market/keeper-daemon.sh` re-quotes after every epoch change;
  MARK live at 0.524.
- Supervisor restarted; Polymarket publisher recovered its quarantined nonce and the overdue
  accounting rollover completed. All 8 workers running.
- `tmp/native-spot/nba-gsw-mia-20261105-spot/ops.env` created (mode 600, git-ignored).

Other work in the tree (`outcome-chart.tsx`, `spot-terminal.tsx`, CSS, pricefeed and supervisor changes)
is from a concurrent session; review before committing.
