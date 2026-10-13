# Follow-up deployment: 5x Warriors vs Heat native perp

Status as of 2026-10-14 ~02:35 IST. Monad testnet only. Steps 1–3, 5 and 6 and the maker funding in
step 4 are done (see "Progress"). What is left runs on the operator machine that hosts the supervisor.

## Progress (2026-10-14, cloud session)

On chain (Monad testnet, all `status 1`):

| Step | What | Evidence |
|---|---|---|
| 1 | 5x perp listed, `--gas-estimate-multiplier 104` (29,710,546 gas) | tx `0x62f51351…433c2b`, block 70779079. Engine **`0x0ff5EAE643CB7E303f1726A92C03686674D445C0`** (as predicted at lister nonce 433). `listingHash` `0xcc35d5b3c55ccb74edcd6e6ddf2af1a6eb283ed220518599d2874b1ccb6a67b2`, EXTCODEHASH `0x1b15eb5d5ea820fc0863a803db681bbec991197f112c7d2f85a3518dfc701b4a` |
| 2 | Reserve 100,000 tUSDC: mint, approve, deposit, `allocate(ENG, 1e11, true)` | `0x61ec0bad…5fc78`, `0x8126804e…f8207`, `0x590faeb2…30fc4`, `0x30fa1b5d…12a78`; `marketAtoms(ENG)` = 1e11 before step 4 |
| 3 | Timelock op `0xce82ccac…21b29b`: `stageRiskParams(perp5x calibration)` + `activateMarket()` | propose `0x8b869342…1d9745` (block 70779536), execute `0xb514fc94…4d0c5bf` (block 70780669). `activeProfile()` = version 2, hash `0x1a4bd2261318f3ccfe131d252b39cc284ff6625d8b06cf207968a345a1fc302f` |
| 4 (part) | Perp maker `0x1A54…bbEd` funded on the new engine: mint 2,000 tUSDC, `perp.sh fund 2000000000` | `0xf6dbda12…0236`, `0x307f2b07…f7f6`, `0xdb1de4ee…83d9`; `participantCount` = 1, `marketAtoms(ENG)` = 1.02e11 |

`native-verify.js` against the new engine and the 5x rules: 20/20 PASS (it was 19/20 before the
leverage check below was relaxed). `marketRiskView`: `liquidationCapLots` = `liquidationRemainingLots` = 100000.

Code (uncommitted at the time of writing):

- **Step 5 done:** `scripts/native-market/liquidation.sh`, sourced by `keeper-daemon.sh`. Each keeper loop,
  before re-quoting: if accounting is open and the per-block liquidation budget is non-zero, walk trader ids
  1..`participantCount()` from a rotating cursor (`LIQ_SCAN`, default 32 per loop), `eth_call`
  `liquidate(id, liquidationCapLots, 8, 0)` from the keeper, and send only a productive result (reason 0 and
  book/paired lots > 0 or TAKEOVER authorized), the same rule as the `polymarket-perp` operations worker.
  Same key and loop as sampling and rollover, so one nonce sequence. `LIQUIDATE=0` disables it; on a 1x engine
  (`maxLiqLotsPerBlock` 0) it is two reads per loop. Tests: `node --test scripts/native-market/liquidation.test.mjs`
  (6/6, two mutations each caught); live read-only decode against all three perps; one daemon run on an anvil
  fork of testnet (`liquidate(1, 100000, 8, 0)` simulated, not productive, nothing sent).
- **Supervisor check unblocked:** `native-verify.ts` required 1x (`FAIL engine 1x, funding off`), which would
  have stopped `market-supervisor check` with `NATIVE_VERIFICATION_FAILED`. It now accepts funding off and
  either 1x, or above 1x with `maxLiqLotsPerBlock > 0` and a non-zero `activeProfile().profileHash`
  (`packages/pricefeed/src/native/leverage.ts`, test `native-leverage.test.ts`, 3/3).
- **Step 6 done (config):** `public-manifest.json` has `native-nba-gsw-mia-perp5x-0ff5eae6` (values above,
  `deploymentCapX: 5`, `maxLiqLotsPerBlock: "100000"`, `fundingEnabled: false`); `market-metadata.json` has its
  title and marks `native-nba-gsw-mia-perp-cac9ac9f` archived.

## Remaining (operator machine, in this order)

1. `cp tmp/native-spot-perp/ops.env tmp/native-spot-perp5x/ops.env` (mode 600); set
   `NATIVE_ENGINE=0x0ff5EAE643CB7E303f1726A92C03686674D445C0` and
   `NATIVE_RULES=oracle/deployments/native/nba-gsw-mia-20261105-spot-perp5x.rules.json`. Same three keys (the
   INDEX source id and signer are the same as the 1x perp).
2. Rebuild the pricefeed (`cd packages/pricefeed && npm run build`) so the supervisor runs the new `native-verify`.
3. In `tmp/redeploy-20261011/supervisor.json`: replace the `native-nba-gsw-mia-perp` group with
   `{ "name": "native-nba-gsw-mia-perp5x", "kind": "native-spot-perp", "privateDirectory": "tmp/native-spot-perp5x" }`
   (do `followup_deploysetup.md` §1 first if it is still open), and add
   `0x16923600608b07715ea532a2b05bb1f4881c8fff4dae9f2a140e282682d2afeb` to the spot group's `linkedMarketIds`
   (the old 1x id may stay there so the old market still resolves).
4. Restart the supervisor (SIGTERM, wait for `stopped`, `check`, `run`). Only one keeper may run per key: the 1x
   group must be gone before the 5x group starts, because both use the same keeper and perp maker keys.
5. Retire the 1x perp (its workers are stopped by step 4). With `KEY=<perp maker> ENG=0xCAc9AC9F5720b0b07D3B78925c33906429e16325 R=$R`
   exported: `bash -c "eval \"\$(sed -n '1,14p' scripts/native-market/perp.sh)\"; tx \"\$ENG\" 'cancelAll()'"`, then
   `bash scripts/native-market/perp.sh release 2000000000` (its cash was 2,000 tUSDC; check `perp.sh status` first).
   It has two participants; leave it listed so they can close.
6. Verify: `/m/0x0ff5EAE643CB7E303f1726A92C03686674D445C0` loads; INDEX and MARK become available within a few
   keeper cycles (`pricingMode` 0 → 1 via `activatePricing`); `leverageCaps()` returns `(5, 5)` once MARK is up.
7. Deploy the frontend with the manifest/metadata change.

The original plan follows for reference.

## Historical: plan as written before the cloud session

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
