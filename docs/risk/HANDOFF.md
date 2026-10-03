# Risk & Clearing handoff (book, oracle and frontend teams)

Branch `integration/risk` · spec v1.1 · economic baseline v1.0 · testnet evaluation only.
Updated 2026-10-03 through `5b82d9f` and the completed authorized Monad testnet evaluation.
**The authorized testnet foundation, real-book trade, YES settlement and cash exit are verified complete.**
This test market is now closed. The real Book + real A accounting/vault + real B
risk composition runs on chain 10143. Token, resolution authority, synthetic INDEX and listing/role inputs remain controlled
test fixtures, not production counterparts. RB-I01 repair `f2ebc61` awaits independent teammate
review; RB-I02 maker-remainder liveness and a production PERP depth sampler remain open.
Production approval is false; G7 human acceptance remains blocked. The consolidated planning
index is [RISK_BOOK_TRACKER.md](../integration/RISK_BOOK_TRACKER.md).

## 1. What the engine is

One isolated engine per market. It is composed of Person B's risk, lifecycle and settlement
controllers and Person A's accounting, custody and settlement ledgers, joined by
`contracts/src/engine/RiskAccountingBridge.sol`. Collateral is held by `CollateralVault` (A017).
The test composition `contracts/test/integration/CombinedEngine.sol` adds a mock order book
(`MockBookAdapter`). `RealBookIntegration.t.sol:RealBookEngine` composes the real book instead.
Both are test-only compositions; their `96cf262` sizes in the release manifest are historical.
Do not deploy their unrestricted feed or failure-injection helpers.

`contracts/src/engine/BookRiskEngine.sol` is the concrete composition without those helpers.
It enforces initial 1x, uncalibrated full backing, funding/recovery disabled and zero trading fees,
with premium load 1. Signed INDEX ingress is wired; a production PERP book-depth sampler is not,
so this composition supports **fully backed bootstrap evaluation only**, not normal leveraged
PERP pricing. Its runtime is 114,546 bytes; creation code 123,665 bytes plus 928 constructor bytes
gives 124,593-byte initcode. These fit the verified Monad testnet limits (131,072/262,144 bytes),
but exceed Ethereum EIP-170. See section 12 for simulation scope and remaining release checks.

## 2. ABIs

- Concrete deployment ABI: `artifacts/risk/book-risk-engine-abi.json` (**285 entries**, including
  constructor/public book methods); compiler artifact `contracts/out/BookRiskEngine.sol/BookRiskEngine.json`.
- Abstract engine: `artifacts/risk/engine-abi.json` (**254 entries**; no deployment constructor).
- Vault: `artifacts/risk/vault-abi.json` (**35 entries**). All three exports/checks passed on the
  current source; this does not refresh economic review or approve production use.
- Book seam (internal, not an ABI): `contracts/src/interfaces/IBookRiskHooks.sol`.
- Oracle seam: `contracts/src/interfaces/IResolutionIngress.sol` (`IResolutionEngine`).
- Price observations: `contracts/src/interfaces/IPriceSource.sol` (`submitObservation(obs, sig)`).
- Market config: `contracts/src/interfaces/IMarketConfig.sol` (`Listing`, `validateListing`).

Mutating entry points:

| Who | Function | Notes |
|---|---|---|
| User (via vault) | `CollateralVault.deposit(atoms)`, `allocate(engine, atoms, false)`, `withdraw(atoms)` | exact-receipt deposits only (fee-on-transfer rejected). The first allocation registers the trader; engine trader id = registry index + 1 (`traderIdAt(i)`, `traderIdOf(addr)`) |
| User | `release(atoms)` | guarded by B's release decision and A's coverage; `previewRelease` / `previewAccount.usableReleaseAtoms` gives the exact usable amount at this block |
| LP / capital authority | `CollateralVault.allocate(engine, atoms, true)` | shares 1:1 only before activation; afterwards a donation (no shares) |
| LP | `ReserveVault.notice()` then `redeemReserve(owner)` | 7-day notice; only after claims are prepared |
| Governance | `activateMarket()`, `stageRiskParams(params)` | activation opens the first accounting epoch |
| Monitor | `requestReduceOnly(reason)`, `clearReduceOnly(reason)`, `raiseHazards(h0, h1)` | cannot halt, finalize or lower hazards |
| Anyone (keepers) | `beginRollover()`, `rollPage(n<=32)`, `finishRollover()` | hourly accounting epochs; trading pauses from epoch end until the last page |
| Anyone | `floorSweep(n<=32)` | backing floor at T-12h |
| Anyone | `liquidate(trader, maxLots, maxExaminations<=64, partner)` | book close, pair reduction (partner != 0) or takeover; zero-effect calls pay nothing |
| Anyone | `materializeScheduledHalt()` at or after T | |
| Pinned oracle | `halt()`, `settle(Y)`, `settleInvalid()` | see section 8 |
| Anyone | `captureInvalidPrice()`, `prepareSnapshotChunk(n)`, `preparePayoutChunk(n)`, `finishPreparation()` | bounded jobs (n <= 32) |
| Anyone (pays the owner) | `claimTrader(owner)` or `CollateralVault.claim(engine, owner)` | equivalent payout entry points; the wrapper already calls the vault. Recipient fixed; each escrowed entitlement paid once |
| Keeper / treasury | `withdrawKeeper()`, `withdrawTreasury()`, `CollateralVault.withdrawFees()` | whole atoms; fractional Q retained. When the payout scan completes, protocol and keeper fee Q move to global per-beneficiary vault fee escrows (A-I01). After that, `withdrawKeeper()` moves the keeper's exact Q to their vault escrow and pays its whole atoms to their free balance; the protocol fee beneficiary (the immutable treasury) calls `CollateralVault.withdrawFees()`. `withdrawTreasury()` pays reserve-owned dust only |
| Price adapter | `submitObservation(obs, sig)` | authenticated; see `IPriceSource` |
| Disabled | `selectConversionMode()` | reverts: conversion is disabled (DEC-10) |

Internal integration ports now use one `AccountingState` enum from `MathTypes.sol`. The bridge
delegates market invalidation to A's `_bumpMarketOrderEpoch()` and reservation replacement to
`_replaceReservations()`, retaining live/context/touch/epoch/coverage checks. Cash claims invoke
the vault-authenticated engine callback `onCashClaim(owner, atoms)`, which calls
`_beforeCashClaim()` / B's `_riskBeforeCashClaim()` before transfer. Both the direct vault path
and `claimTrader` update the same cash-mode fence and unpaid trader counter; a failed callback
or token transfer rolls back those changes.

The reviewed freshness adapter preserves the old funding endpoint until the epoch has stopped,
including observation recovery after epoch end. A valid recovered mark cannot authorize funding
through an earlier gap. Liquidation fees remain full or waived, and forced-book fill results
report the fee A actually charged.

## 3. Units

| Field | Unit |
|---|---|
| `*Q` (cash, fees, premium, budgets) | Q = one USDC atom × 1e18 (`cashQ` int256, \|cashQ\| < 2^180) |
| atoms (custody, payouts, claims) | 1e-6 USDC |
| lots / `positionLots` | 1 lot = 0.001 claim; \|position\| ≤ 2^40 |
| tick | 1..999, price = tick / 1000 |
| `*Wad` (prices, probabilities) | 1e18 = 1.0 |
| payoff | `PAYOFF_Q_PER_LOT = 1000 Q`; E0 = cash, E1 = cash + 1000 Q × lots, mark equity = cash + 1000 × lots × markWad (no second WAD division) |
| fill cash | `lots × tick × Q` on both legs |
| funding | `rateQPerLotSec` (Q per lot per second), index `fundingFQ` (Q per lot) |
| time | uint64 Unix seconds |

## 4. Events

Accounting (A): `CashAllocated`, `AccountRegistered`, `AccountSynced(owner, fundingPaymentQ, premiumQ, cutoff)`,
`PairedPosting(buyer, seller, lots, tick, feesQ)`, `FundingAdvanced`, `EpochOpened`, `SweepProgress`,
`AccountTakenOver`, `EconomicHalt`, `ClaimsPrepared`, `AccountBalance(owner, lots, cashQ, fundingCheckpointQ)`,
`MarketBalance(allocationQ, reserveLots, reserveCashQ, protocolFeeQ, keeperPayableQ, fundingClearingQ, cushionQ, budgetQ, oiAllLots)`.
The last `AccountBalance` per trader and the last `MarketBalance` reconstruct the ledger (tested in
`contracts/test/integration/EndToEnd.t.sol`, step 10).

Risk / lifecycle / settlement (B): `ReservationChanged`, `MakerPruned`, `OrdersInvalidated`,
`MarketOrdersInvalidated`, `FloorOrdersInvalidated`, `GraceStarted`, `GraceCleared`,
`LiquidationOutcome`, `PairReduction`, `PairSkipped`, `BookCloseAttempt`, `FloorSweepProgress`,
`PricingModeChanged`, `RiskProfileActivated`, `ObservationAccepted`, `PerpObservationRecorded`,
`FreshnessGap`, `MovementRestriction`, `MonitorRestriction`, `HazardRaiseRequested`, `MarketHalted`,
`OracleFinalityAccepted`, `InvalidPriceCaptured`, `SnapshotPreparationProgress`,
`PayoutPreparationProgress`, `ClaimsEnabled`, `RecoveryRequired`, `ClaimModeSelected`.
Vault: `Deposit`, `Allocation`, `Released`, `Escrowed`, `Paid`.

## 5. Reason codes and errors

Order and admission outcomes are returned, not reverted (`RejectCode` in `src/math/RiskTypes.sol`):
`NONE, HALTED, BAD_STAGE, OUTSIDE_BAND, BELOW_MIN_SIZE, NO_REDUCIBLE_POSITION, MAKER_BELOW_IM,
MAKER_BELOW_MM, TAKER_CAPACITY, ACCOUNT_DEFICIT_CAP, MARKET_COVERAGE, INVALID_PRICE_OR_SIZE, STALE_ORDER`.
Book steps return `StepStatus {FILLED, PRUNE_MAKER, STOP_TAKER}`. Liquidation returns
`LiquidationMath.Result` (DONE, NEEDS_MORE_WORK, TAKEOVER_AUTHORIZED, …) and `Mode` (NONE, REDUCE, TAKEOVER).
Reverts are kept for authorization, arithmetic and invariant failures: `RiskUnauthorized`,
`Unauthorized`, `Rejected` (A refused an action B did not authorize), `Coverage` (INV-04),
`BadState`, `Stale`, `BadUnits`, `Bounds`, `UnexpectedCoverageFailure`, `OutcomeOrPricePending`,
`PreparationIncomplete`, `ConflictingFinalOutcome`, `ConversionDisabled`; the full list is in the ABI.

## 6. View schemas

- `previewAccount(trader)` → identity (block, time, risk version, mark availability), projected
  `cashQ`, `positionLots`, `projectedFundingQ`, `projectedPremiumQ` (already included in `cashQ`),
  `e0Q`, `e1Q`, `markEquityQ`, `mmQ`, `imQ`, `fullBackingRequired`, `status`, `orders`, `usableReleaseAtoms`.
- `previewOrder(trader, side, limitTick, lots, reduceOnly)` → `rejection`, `acceptedCapLots`, `feeCapQ`,
  `mode`, `fullBackingRequired`, `eMinQ`, `requiredImQ`, `d0AfterQ`, `d1AfterQ`, `marketCoverageAfter`, `halvingSteps`.
- `accountRiskView(trader)`, `marketRiskView()`: stage, pricing mode, accounting state, index/mark
  (availability flags; an unavailable mark is never 0), pending work bits, floor progress.
- `getSettlementStatus()` → `SettlementView` {phase, halted, finalOutcome, oracleFinalityAccepted,
  invalidPriceReady, settlementPriceE18, snapshotId, cursors, accountCount, totals, claimsEnabled,
  accountingComplete, recoveryRequired}. Show `ORACLE_FINAL_PRICE_PENDING`, `ORACLE_FINAL_PREPARING`
  and `CLAIMABLE` distinctly. Only `claimsEnabled` makes a payout button live.
- `getHaltSnapshot()` → `HaltView` {halted, economicHaltAt, haltRecordedAt, accrualCutoff, oiHaltLots, …}.
- Ledger views: `account(owner)`, `reserve()`, `coverageSlacks()`, `allocationQ()`, `traderAtoms(owner)`,
  `claimableAtoms(owner)`, `unpaidTraderClaims()`, `traderClaimed(owner)`, `anyCashClaim()`,
  `allTraderClaimsPaid()`, `feesReclassified()`, `reclassifiedProtocolFeeQ()`, `reclassifiedKeeperQ()`.
- Vault fee views (A-I01): `feeEscrowQ(owner)`, `keeperPoolQ(engine)`, `marketDebitQ(engine)`,
  `totalFeeEscrowQ()`. A market's vault allocation in Q is `marketAtoms * 1e18 - marketDebitQ`.
  Vault events `FeesReclassified`, `KeeperFeeAssigned`, `FeesPaid`; engine event `FeesReclassified`.
- SDK: `packages/risk-sdk` (`decodeAccount`, `decodeMarket`, `decodeSettlementStatus`, `isClaimable`,
  `AccountingReplay`). SDK values are never authoritative; fixtures in `docs/app-state-fixtures.json`.

Previews simulate the funding stop/budget, account touch, premium and coverage for the current
block. Their `cashQ`, equity, health and usable release use those projected values; `account(owner)`
remains the stored accounting snapshot. Execution repeats the checks. A positive-equity long may
have negative stored cash and still have a permitted release.

`ClearingPhase.COMPLETE` is now reported once claims are enabled and every nonzero trader
entitlement has been paid. LP, keeper and treasury withdrawals remain independent; COMPLETE
does not mean those liabilities have been withdrawn. `anyCashClaim` records an actual successful
payout, not merely claims readiness. Conversion eligibility remains `DISABLED`.

## 7. Book team

The book now implements `IBookRiskHooks`; the ten old structural requests shipped on main
through `a114d06` and were merged at `13ca730`. The original request remains historical in
`docs/requests/B-to-book-hooks.md`. Current local source-integration evidence:

1. Inspect `contracts/test/integration/RealBookIntegration.t.sol`: real Book + real A+B, with
   authenticated A-registry lookup and forced IOC wiring. Do not deploy its unrestricted feed or
   failure-injection helpers. The older book-team test composition uses mocked A accounting;
   do not confuse it with the new `contracts/src/engine/BookRiskEngine.sol` real A+B composition.
2. Run:
   ```bash
   cd contracts
   FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/integration/RealBookIntegration.t.sol"
   FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/gates/G4.t.sol"
   FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/gates/G5.t.sol"
   FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/integration/EndToEnd.t.sol"
   ```
3. Also replay B's scripted seam vectors, G4/G5 mock-book suites and the complete suite.
   RB-I01's taker-permit version repair is implemented at `f2ebc61`, with independent teammate
   review pending. **RB-I02 remains open:** a partially filled reduce-only maker remainder becomes
   stale after the fill. Coordinate its intended semantics and repair with the book team; do not
   modify book internals without that coordination. A bounded stale-aware PERP depth sampler is
   also absent. See `docs/requests/A-to-B-merge-followup.md` and the integration tracker.

## 8. Oracle team

The engine accepts only the pinned `resolutionAuthority` from the listing. Oracle source enum
{NONE=0, YES=1, NO=2, INVALID=3} is mapped explicitly (`OracleOutcomeMap.engineCallFor`):
YES → `settle(1)`, NO → `settle(0)`, INVALID → `settleInvalid()`, NONE reverts. Read-only inspection
of `origin/feat/oracle` at `ccbdb50` confirms those ordinals in `oracle/src/types/OracleTypes.sol`.
Its `docs_oracle/seam-decisions.md` S-01 says Voided calls `settleInvalid()` and never sends 4;
the risk mapping's historical VOIDED=4 compatibility case is not an oracle outcome requirement.

That branch now contains `ResolutionOracle`, `MarketRegistry`, `BondTreasury`, `KeeperRouter`,
venue adapters and an SDK. Its own `docs_oracle/gates.json` records OG0/OG1 passed, while
OG2/OG3/OG3b remain not started. These are counterpart-recorded results, not an independent
oracle audit or a real-engine integration pass. The oracle branch has not been merged into this
risk composition; its testnet engine/factory are stubs, and the real-engine/factory join remains
open. Do not ask the oracle team to rebuild implementations already present on that branch.
`halt()` and finality acceptance perform constant account work; the gate suite compares
finality cost across different participant counts. `gas-engine.json` retains earlier source-bound
mock-book measurements, not this merge's or Monad's gas. A repeated identical finality is a no-op; a
conflicting one reverts. INVALID waits for the scheduled [T-24h, T] index window, or the disclosed
0.5 fallback one hour after T if data is missing. To run our fixtures against your oracle:
replace `MockResolutionAuthority` (`contracts/test/mocks/B/MockResolutionAuthority.sol`) with your
contract bound to the engine, then run
`cd contracts`, then
`FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/gates/G6.t.sol"` and
`FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path test/risk/B/OracleCompatibility.t.sol`. Fixture data:
`docs/counterpart-oracle-fixtures.json`.

Halting before activation now supports the same frozen settlement path, so funded traders and
noticed reserve holders can exit even if activation never occurred. New allocation at/after T
and activation after halt are rejected. `HaltView.frozenBookEpoch` is read after A's freeze and
matches the engine's authoritative epoch.

The authorized testnet evaluation instead uses the controller-only, bind-once
`TestnetResolutionAuthority` from `contracts/test/mocks/integration/TestnetRiskFixtures.sol`.
It manually forwards halt and binary/INVALID finality to the agreed engine API; it implements no
oracle consensus, disputes or outcome discovery and does not confirm the external oracle enum.

## 9. Frontend / indexer

Read views at one block and label every value with that block (`PreviewIdentity`). Reconstruct
balances from `AccountBalance` / `MarketBalance` events or the views; never keep an alternative
ledger. `previewAccount.cashQ` already includes projected funding and premium;
the component fields explain that projection and must not be subtracted again.
Only `usableReleaseAtoms` identifies
an amount that passes the current release preview. It is checked again at execution. Run the SDK fixtures:
`bash scripts/check-task.sh B042` (needs `tsc` on PATH).

## 10. Status and limits

- Gate acceptance and exact run status: `docs/spec/gate_status.json` and `artifacts/gates/`.
  At `5b82d9f`, ordered **G0-G6 exited 0**, with counts **68/152/117/78/77/63/55**.
  **G7 exited 2 after six tests**: `A review does not cover the current source and review regressions`.
  Separate downstream runs **A044/B040/B041/B042/B043/B044 exited 0** with **44/2/2/3/1/1** tests;
  direct `test/gates/G7.t.sol` also passed **six** tests, exit 0. These are separately verified
  technical results, not an ordered G7 pass; B043's harness pass is not a new teammate review.
  Evidence: `artifacts/risk/real-book-validation-2026-10-03.json` (evidence commit `20330d8`,
  validated source `5b82d9f`). A043 is recorded in
  `artifacts/reviews/A-on-B.md`, but its old fingerprints are stale after the new source changes.
  Do not refresh approvals for one's own economic repair. Independent teammate review and the
  subsequent G7 rerun are pending; G7 has empty `reviewed_by` and null `merge_sha`.
  B's delta review of `71576ed..3b11044` is complete
  (`artifacts/reviews/B-on-A.md`, addendum 2026-10-02, commit `32d30ac`). G7 acceptance and an
  accepted merge SHA are still pending and can be recorded only by a human. Current state and
  open items: `docs/merge/STATUS.md`.
- Historical invariant campaign INV-01..INV-10: `artifacts/risk/invariant-campaign.json`.
- Historical gas (Ethereum/Prague schedule, not Monad): `artifacts/risk/gas-engine.json`.
- Release defaults and missing production inputs: `artifacts/risk/release-manifest.json`.
- A-F01, A-F02 and A-F03 repairs remain. The 692-test
  `artifacts/risk/merge-validation-2026-10-03.json` records the earlier merged source; the 641-test
  `artifacts/risk/review-validation.json` is older still. Neither certifies the current source.
  At `5b82d9f`, the full risk suite passed **727 tests in 117 suites**, zero failed/skipped
  (`tmp/full-risk-final.log`); the earlier `47149e5` baseline was 719/116.
  Python A/B/audit/integration passed **46/156/8/7**. Included focused legacy/Ethereum-mode checks
  passed 23 real-book, 9 concrete-engine and 8 fixture tests. Eight later-added/updated testnet smoke
  regressions passed separately under MonadTen (`tmp/monad-smoke-tests.log`), including offline
  prepared 11-sample calldata and stale-window rollback/retry; they are included in the 727-test total.
  Do not add overlapping counts to full-suite totals.
  The original audit is preserved with a dated resolution addendum in `docs/merge/A-audit.md`.
- A-I01 (implemented by B 2026-10-02; reviewed and accepted by A 2026-10-03): at payout-scan completion the engine
  moves exact `protocolFeeQ` and `keeperPayableQ` into the vault's global fee escrows and reduces
  `allocationQ` by exactly that Q; reserve dust stays in `treasuryQ`. The removed engine
  `protocolFeeEscrowQ()` / `withdrawProtocolFees()` are replaced by the vault escrow. All six
  choices are confirmed in `docs/questions/A-I01.md`.

## 11. Toolchain and review regressions

Use Forge **1.8.3**, matching `.github/workflows/contracts.yml`; solc **0.8.30**, optimizer
settings and **Prague** EVM remain pinned by `contracts/foundry.toml`. Earlier results used
Forge 1.3.5 or 1.5.1 and are historical evidence, not the current shared reproduction baseline.
Set `FORGE_SNAPSHOT_EMIT=false` when reviewing to avoid rewriting book-team gas snapshots.

The `risk` and `ci` profiles allow **1,000,000 bytes for local test code**. `CombinedBase`
embeds multiple engine deployment variants, and Forge 1.8.3 enforces the test contract's size
as well as the fixture engine's size. This allowance is not a production or target-chain limit.

From the repository root, with the pinned Forge on PATH:

```bash
cd contracts
FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/reviews/A*Review.t.sol"
FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/audit/findings/*"
```

- [A043IntegrationReview.t.sol](../../contracts/test/reviews/A043IntegrationReview.t.sol): funding
  gaps at/after rollover, direct accounting paths, halt epoch metadata and projected accrual/release.
- [A043BReview.t.sol](../../contracts/test/reviews/A043BReview.t.sol): reduction admission,
  fee reporting and preview consistency.
- [AClaimIntegrationReview.t.sol](../../contracts/test/reviews/AClaimIntegrationReview.t.sol):
  direct/wrapper claims, unpaid trader counter, cash fence and rollback.
- [AF01PreActivationLock.t.sol](../../contracts/test/audit/findings/AF01PreActivationLock.t.sol),
  [AF02PremiumRounding.t.sol](../../contracts/test/audit/findings/AF02PremiumRounding.t.sol) and
  [AF03ProtocolFeeEscrow.t.sol](../../contracts/test/audit/findings/AF03ProtocolFeeEscrow.t.sol):
  the original audit reproducers now assert the corrected behavior.

Run the official `bash scripts/check-gate.sh G0` through `G7` from the repository root in order
after their review requirements are met. Those scripts write evidence; refer to the resulting
artifacts for actual counts, source state and counterpart status.

## 12. Authorized Monad testnet evaluation

- Target: chain **10143**, Forge **1.8.3**, `--network monad`, `monad:MonadTen`; compiler remains
  solc **0.8.30**, Prague, optimizer 200. The 1,000,000-byte local test allowance is not a chain limit.
- `artifacts/risk/monad-testnet-preflight-2026-10-03.json` records the successful in-process fork
  deployment rehearsal at source `1077dfa`, using the user's QuickNode endpoint with credentials
  omitted. This is simulation, not a receipt or deployed-code verification.
- The earlier engine gas plan was **27,683,989**; the successful deployment receipt reports
  **27,904,929 gas used**, below Monad's **30,000,000 per-transaction** ceiling. The earlier six-
  transaction simulation total **30,414,787** is not one transaction or actual receipt gas total.
  Broader operational gas and production qualification remain open.
- `contracts/script/DeployTestnetRiskBook.s.sol` prepares controller-only test collateral, vault,
  manual resolution authority and concrete engine, then registers/binds them. It does not activate
  or fund the market. Evaluation uses synthetic signed INDEX and explicit test listing/roles,
  not production oracle logic, collector calibration or a factory/registry implementation.
- Live foundation evidence: `artifacts/risk/monad-testnet-deployment.json`, six successful receipts,
  four top-level runtime comparisons outside immutable regions, reported immutable values and
  verified role/binding getters. Nested `ReserveVault` runtime is not independently compared.
  Engine: [0x4aE742676984D2C383645E4745Eaf3943b67DE72](https://testnet.monadscan.com/address/0x4aE742676984D2C383645E4745Eaf3943b67DE72).
- Controlled smoke setup succeeded; coordinator:
  [0x0D54dd5411d2a036Bc40aD854aB14289FF9075AF](https://testnet.monadscan.com/address/0x0D54dd5411d2a036Bc40aD854aB14289FF9075AF).
  The [direct real-book trade](https://testnet.monadscan.com/tx/0x0bbc3efecc17f366040d259759767d3e608a7a8d29521763271c886cff8d5dce)
  succeeded. Manual [halt](https://testnet.monadscan.com/tx/0x0f33901e3c005a114aaef028c59a7e518d3c8e7b67a37c9bdeb581cefb81c66b),
  [YES finality](https://testnet.monadscan.com/tx/0xf9a6e5b76a848ff111a390e207d2c8eddb87e45f8a4e1b9883ca793beea4127a) and
  [settlement/cash exit](https://testnet.monadscan.com/tx/0x9193a7ce574c51bb2e83f7f2be521add1b9bfb70098b0cca16382ba2743b6f25)
  also succeeded. `artifacts/risk/monad-testnet-smoke.json` verifies all nine phase receipts,
  seven runtime comparisons and final state at block **67,852,827**: buyer/seller actors hold
  **150/50 six-decimal test tokens**, vault token and recognized balances are zero, both trader
  claims are paid, and the market is halted/closed. These are controlled test tokens, not real USDC.
  Trusted-RPC/artifact comparisons do not independently authenticate finality or reproduce source.
  This one scenario does not certify live funding, leverage, liquidation, LP exits or INVALID.
- All **15** foundation and lifecycle receipts succeeded, using **40,887,693 total gas** and
  **4.223887319407733183 test MON** in actual fees. The deployer retains
  **5.776112680592266817 test MON** from its original 10; no further broadcasts are planned.
- The earlier fork-simulated trade window expired during estimation, with **no broadcast**.
  `PrepareTestnetTrade.s.sol` prepares calldata offline using 11 synthetic signed observations,
  spaced 30 seconds across 300 seconds. Prompt submission is still required; no freshness check
  was relaxed to obtain the successful direct transaction.
- Reproduction, wallet handling and low-rate RPC guidance:
  [monad-risk-book-testnet.md](../runbooks/monad-risk-book-testnet.md). Public limits and current
  execution behavior: [Monad differences](https://docs.monad.xyz/developer-essentials/differences),
  [network summary](https://docs.monad.xyz/developer-essentials/summary), and
  [Foundry support](https://docs.monad.xyz/tooling-and-infra/toolkits/foundry).
