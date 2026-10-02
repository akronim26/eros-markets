# Risk & Clearing handoff (book, oracle and frontend teams)

Branch `integration/risk` · spec v1.1 · economic baseline v1.0 · local-fixture level only.
Updated 2026-10-02 for Person A's integration-review working tree; final gate/evidence reruns
remain authoritative for acceptance.
**No deployment exists or is authorized.** Every result below uses mock counterparts; the live
join with each of your systems is BLOCKED until your code runs these fixtures
(`artifacts/risk/counterpart-status.json`).

## 1. What the engine is

One isolated engine per market. It is composed of Person B's risk, lifecycle and settlement
controllers and Person A's accounting, custody and settlement ledgers, joined by
`contracts/src/engine/RiskAccountingBridge.sol`. Collateral is held by `CollateralVault` (A017).
The test composition `contracts/test/integration/CombinedEngine.sol` adds a mock order book
(`MockBookAdapter`). Historical composed-engine measurements exceed EIP-170; the review changes
require fresh bytecode measurement. Production contract splitting and target-chain size limits
remain separate release work.

## 2. ABIs

- Engine: `artifacts/risk/engine-abi.json` (generated; mock-book and test-only entries removed).
- Vault: `artifacts/risk/vault-abi.json`.
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
| Keeper / treasury | `withdrawKeeper()`, `withdrawTreasury()`, `withdrawProtocolFees()` | whole atoms; fractional Q retained. Treasury/protocol withdrawals escrow to the same immutable treasury beneficiary |
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
  `allTraderClaimsPaid()`, `protocolFeeEscrowQ()`.
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

The seam the engine needs is `IBookRiskHooks` (nine `_risk*` hooks). `Book.sol` currently exposes a
different hook set; the ten exact mismatches are listed in `docs/requests/B-to-book-hooks.md`.
To run our fixtures against your book:

1. Compose your book with the engine in place of `MockBookAdapter` in
   `contracts/test/integration/CombinedEngine.sol` (same constructor), calling the `_risk*` hooks in
   the order shown by `MockBookAdapter._mockPlaceWithMode` / `_mockRest` / `_mockCancel`.
2. Run:
   ```bash
   cd contracts
   FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/gates/G4.t.sol"
   FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/gates/G5.t.sol"
   FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/integration/EndToEnd.t.sol"
   ```
3. Also replay the B seam vectors: `FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path test/risk/B/BookSeam.t.sol` (scripted
   accounting) and report PASS or the exact failing assertion.

## 8. Oracle team

The engine accepts only the pinned `resolutionAuthority` from the listing. Oracle source enum
{NONE=0, YES=1, NO=2, INVALID=3} is mapped explicitly (`OracleOutcomeMap.engineCallFor`):
YES → `settle(1)`, NO → `settle(0)`, INVALID → `settleInvalid()`, NONE reverts; a VOIDED value
(4, guessed; B assumption I-5, unconfirmed) is treated as INVALID.
`halt()` and finality acceptance perform constant account work; the gate suite compares
finality cost across different participant counts. Read current measurements from the regenerated
gas artifacts rather than reusing pre-review numbers. A repeated identical finality is a no-op; a
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
  G0-G7 technical checks pass in order on Forge 1.8.3. A043 is complete in
  `artifacts/reviews/A-on-B.md`; G7 final acceptance still requires B's delta review.
- Invariant campaign INV-01..INV-10: `artifacts/risk/invariant-campaign.json`.
- Gas (Ethereum/Prague schedule in forge, not Monad): `artifacts/risk/gas-engine.json`.
- Release defaults and missing production inputs: `artifacts/risk/release-manifest.json`.
- A-F01, A-F02 and A-F03 fixes pass their regressions. The complete Forge run has
  641 passes and no failures, including all eight BookGas tests; Python has 217 passes.
  Fresh per-suite evidence is `artifacts/risk/review-validation.json`.
  The original audit is preserved with a dated resolution addendum in `docs/merge/A-audit.md`.
- Protocol fees now remain in separate engine `protocolFeeEscrowQ`; reserve dust stays in
  `treasuryQ`. Both withdrawals pay the same immutable treasury beneficiary. A-I01 remains
  deferred: protocol/keeper fee Q is still held within market allocation until withdrawal,
  rather than immediately reclassified into separate vault-level fee escrows. No complete
  spec-conformance claim is made for that classification.

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
