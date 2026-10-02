# B review of Person A cash and reserve transitions (B043)

Review status: COMPLETE

Reviewed on `integration/risk` (merged Person A `61be284` + Person B `fecd2fb`, composed through
`contracts/src/engine/RiskAccountingBridge.sol`). Spec v1.1, economic baseline v1.0. This is a
cross-review by Person B's integration agent, not an external audit and not Person A's review of B
(A043, which only Person A can do). B did not edit A files except the two `fix(A)` runner commits
recorded in `docs/merge/integration-progress.md`. Counterparts (book, price feed, oracle, token)
are mocks in every run below.

## Routes and protected liabilities

Every reproducer listed in the earlier BLOCKED version was run on real A modules. "Evidence" names
the test that ran; all listed tests pass on `integration/risk`.

| # | Route (A owner) | Property (spec) | Evidence on merged code | Result |
|---|---|---|---|---|
| 1 | Deposit / allocate (A017) | exact receipt, fee-on-transfer rejected, cashQ += atoms·Q | `test/audit/AuditStateful.t.sol::testFeeOnTransferTokenRejected`; `test/gates/G3.t.sol::test_allocationVisibleToBothLanes` | PASS |
| 2 | Guarded release (A017 + B decision) | release cannot bypass B; missing mark: only exactly backed | `G3::test_guardedReleaseCannotBypassRiskDecision` (usable exact, usable+1 reverts); `test/reviews/B043Review.t.sol::test_route2_missingMarkReleaseOnlyIfExactlyBacked` | PASS |
| 3 | Paired posting (A018) | same Q both legs; fees credited exactly; no lone leg | `AuditSpecVectors::testV01*`, `testPairedFillConservation`; `G4::test_restFillFeesCoveragePermitRelease`; `G4::test_unexpectedAssertionRollsBackAllFills` | PASS |
| 4 | Funding accrual (A022) | reserve payer/receiver slack identity | `AuditSpecVectors::testV09ReserveFundingCases`, `testV10FundingZeroSum`; `G2::test_reserveFundingPayerReceiver` | PASS |
| 5 | Budget / OI change (A022) | old OI first, affordable seconds at new OI, no reauthorization | `AuditSpecVectors::testV11OiChangeBudget`; `AuditStateful::testFundingEpochBudgetAndStop`; `G4::test_fundingOldThenNewOiAndNeutralPremium`; EndToEnd step 4 | PASS |
| 6 | Freshness stop (A022 + B021) | accrue to the old endpoint; no restart in a stopped epoch | `B043Review::test_route6_freshnessGapStopsFundingNoRestart` (stop at start+30; index unchanged after fresh data) | PASS |
| 7 | Premium integral (A023) | neutral touches charge the same cumulative Q | `AuditSpecVectors::testV12V14PremiumExact`, `testV13NeutralTouch`; `G4` and EndToEnd twin-account checks | PASS, with A-F02 (Low): rounding per piece, up to +4 Q vs ceil(exact) |
| 8 | Surcharge / capitalization (A023) | 4x on new principal deficit; capitalized once at rollover | `AuditSpecVectors::testV12V14PremiumExact`; `AuditStateful::testPremiumCapitalizedAtRollover`; repeated `rollPage` after completion touches nobody (cursor == count) | PASS |
| 9 | Account touch (A024) | cushion share removed exactly; contribution replaced once | INV-05 campaign (stored contribution == A deficits of own state, sums exact); B `_touchedIn` once per action | PASS |
| 10 | Rollover (A025) | ≤32/page, one cutoff, clearing and cushion zero; B epoch hook at opening | `G4::test_rolloverBlocksTradingAndInvalidatesOrders`; EndToEnd step 5; bridge `finishRollover` runs B `_riskEpochOpenedWithGuards()` before A opens the epoch | PASS |
| 11 | Takeover (A028) | whole cash + position, slack +max(e_y,0), no fee | `AuditSpecVectors::testV16TakeoverSlackIdentity`; `AuditStateful::testTakeoverEligibilityWholeAccountNoFee`; `G5::test_authorizedTakeoverWholeAccountNoFee` | PASS |
| 12 | Liquidation fee (A029) | 1 atom/lot, half reserve half keeper in Q, residual kept | `G5::test_bookCloseNeedsMoreWorkKeeperFees`; `G5::test_pairReductionBothSidesEligible` (keeper +1,000 atoms); EndToEnd step 6 keeper residual | PASS. A charges the full fee or waives it (no partial); B's allowance is respected (R-09) |
| 13 | Freeze (A030) | cutoff = min(halt, epoch end); OI includes reserve | `G5::test_halt*` (4 rollover states, economicHaltAt ≠ cutoff); `B043Review::test_route13_oiAtHaltIncludesReserve` | PASS |
| 14 | Floor sweep (A031) | frozen registry; price-free endpoint-deficit takeover only | `G5::test_floorSweepTakesOverDeficitsOnly`; seeded campaign (16 reconciled floors, INV-01..10 after every step) | PASS |
| 15 | Snapshot / payout (A034/A035) | once per account; NO/YES/INVALID golden values | `AuditStateful::testBilateral*` (6 runs); `G6`; EndToEnd 4 outcomes | PASS |
| 16 | Fee escrow before LP residual (A035/A038) | fee/keeper Q classified before residual; fractions never LP dust | `G6::test_feeFractionStaysClassified`; A038 | PASS, with A-F03 (Low): protocol fee folded into the reserve-treasury escrow |
| 17 | Recovery (A036) | baseline recovery off; no haircut | `ReleaseDefaults`, `AuditStateful::testRecoveryDisabledFlag`, A036 (counterfactual shortfall) | PASS (flag is a constructor argument; the engine composition passes false) |
| 18 | Claims (A037) | once-only, CEI, blocked recipient isolated; B cash-claim hook | `G6` (second claim reverts), A037 | PASS for claims. B's `_riskBeforeCashClaim()` is not called by A's path (no hook); conversion stays disabled, fence reported conservatively (R-11, request filed) |
| 19 | Reserve claims (A038) | matured notice, frozen denominator, after all escrows | `G6::test_NO_pages1_aliceFirst_lpRedeemsBeforeClaims`; EndToEnd (LP redeems before trader claims, both orders) | PASS |

## Findings carried from the Phase 1 audit (docs/merge/A-audit.md)

- A-F01 (Medium, open): allocations made before activation are locked if T passes without activation.
- A-F02 (Low, open): premium rounding per piece (≤ +4 Q observed).
- A-F03 (Low, open): protocol fee folded into the reserve-treasury dust escrow.

No Critical or High defect was found in A's cash and reserve transitions on the merged code.

---

## Addendum 2026-10-02: B delta review of `71576ed..3b11044`

Review status of this addendum: COMPLETE

- Reviewer: Person B (git identity 0xr10t), through B's coding agent.
- Reviewed range: `71576ed..3b11044` (7 commits: `2790663`, `0820afa`, `034ebab`, `c543434`, `ec14175`,
  `74b9f16`, `3b11044`), all source diffs read, not only test results. The original B043 review
  above is kept as historical evidence for `71576ed`.
- Checked-out source: `3b11044ae2895139570afa8f908e5c932205f7b9`, fast-forwarded from
  `origin/integration/risk`; working tree had only an untracked `docs/.DS_Store` (no source change).
  The runners then rewrote task/gate evidence files, so their records show `worktree_dirty: true`.
- Toolchain: forge 1.8.3 (`cae51ad`, installed for this review; matches the CI pin), solc 0.8.30,
  EVM prague, optimizer 200; Python 3.13.13 (A: 3.12.10); TypeScript 5.9.3 from a local install
  (A: 5.9.2); NumPy 2.5.2 (A: 2.2.6). B confirms forge 1.8.3 / solc 0.8.30 / prague as the shared target.

### Validation (FOUNDRY_PROFILE=risk, FORGE_SNAPSHOT_EMIT=false, no exclusions)

| Command | Result | vs A's expected |
|---|---|---|
| `forge test --match-path 'test/reviews/*.t.sol'` | 37 passed | same |
| `forge test --match-path 'test/audit/findings/*'` | 3 passed | same |
| `forge test` (full) | 641 passed, 0 failed, 0 skipped (incl. 8 BookGas) | same |
| Python A / B / audit / integration | 46 / 156 / 8 / 7 OK | same |
| `python scripts/export-risk-abis.py --check` | exit 0; engine 252, vault 25 | same |
| `bash scripts/check-gate.sh G0..G7` | all exit 0, `checks_passed` | counts 68/152/117/78/74/62/55/102; G0 is +1 (the later line-ending regression A predicted) |
| B's independent checks `contracts/test/audit/DeltaReviewB.t.sol` | 2 passed | new (kept outside `test/reviews` so A043 fingerprints stay valid) |

### Dispositions

| Item | Disposition | Basis |
|---|---|---|
| A-B01 freshness across an unrolled epoch end | Agreed | `_onFreshnessAdvance` and `_acctBeginAction` now accrue whenever live (A clamps to epoch end); `_riskContext().freshThrough` is `now` only if the epoch is stopped or funding freshness reaches `now`. A late mark can no longer fund a gap. B's `B043Review::test_route6` still passes. |
| A-B02 halt metadata epoch | Agreed | `ResolutionIngress` reads `_acctMarketOrderEpoch()` after `_acctFreeze`. |
| A-B03 voluntary reductions (High) | Agreed | `_voluntaryReductionAllowed` applies `LiquidationMath.allowedReduction` (positive equity before, no flip, deficits nonincreasing, E_after ≥ 0, E−MM not worse than min(before, 0)) at the maker tick with the actual fee, for both reduce-only makers (pruned) and voluntary takers (stopped). Independently confirmed: a sell that shrinks both deficits but leaves mark equity ≈ −20 USDC is refused; the same size at a fair bid executes (`DeltaReviewB::test_AB03_*`). |
| A-B04 preview/execution parity | Agreed, with note B-D02 | Admission and previews use `_acctPreviewAccount/_acctPreviewCoverage` (projected funding and premium); at execution the projection is zero because accounts are already touched. |
| A-B05 release quote for negative-cash long | Agreed | Search upper bound is max(E0, E1); execution still runs B's release decision and A's coverage. |
| A-B06 cap on reductions | Agreed | Reduce-only admission is checked before the 2% cap; fill preflight lets a reducing side pass if both deficits do not increase. |
| A-B07 reported fee | Agreed | `_postFillDelta` returns the fee A charged; steps report it. |
| A-B08 profile vs listing | Agreed | `deploymentCapX` in [1, listing cap] and template must match, at init and staging. |
| A-F01 pre-activation exit | Agreed | `_freeze` accepts an unactivated market (epoch set to a zero-length stopped epoch at haltAt); snapshot/payout/LP paths work; allocation and activation after T or after halt are rejected. |
| A-F02 premium rounding | Agreed, with note B-D03 | Exact rationals over one denominator `172800e36 × |lots·rate|`, one final ceiling; checked the trapezoid and triangle scaling and the remainder accumulation bounds. |
| A-F03 protocol fee escrow | Agreed | `protocolFeeEscrowQ` separate from `treasuryQ`; identity includes it; floor-atom withdrawals keep the fraction. |
| Port: shared `AccountingState` | Agreed | File-level enum in `MathTypes.sol`; B re-exports it; no ordinal cast left in the bridge. |
| Port: `_bumpMarketOrderEpoch()` | Agreed | Used by rollover, floor, freeze and the bridge. |
| Port: claims complete | Agreed | `unpaidTraderClaims` counts nonzero trader entitlements; confirmed with a direct vault claim (`DeltaReviewB::test_claimsComplete*`). COMPLETE does not cover LP/keeper/treasury withdrawals. |
| Port: cash-claim hook | Agreed, with note B-D04 | Vault `claim` calls `onCashClaim` before transfer under the vault lock; a failed transfer reverts the counter and claim mode. |
| Port: `_replaceReservations` | Agreed | Same live gate, context, accrual/touch, expected epoch and coverage assertion as `_setReservations`, without the duplicate decision. |
| R-04 shared freshness field | Agree with A's repair | as A-B01 |
| R-05 consume reservations before paired posting | Agree | one transaction; failure reverts everything (G4 rollback test) |
| R-06 direct epoch increment | Agree with replacement by A's port | as above |
| R-09 full-or-waived liquidation fee | Agree | no partial charge; reported fee = charged |

### Findings in the reviewed scope

No Critical, High or Medium finding remains. Informational notes (no repair required for G7):

- **B-D01 (Info, process):** A edited B-owned files (`OrderAdmission`, `BookRiskAdapter`, `TradePreview`,
  `LiquidationBookAdapter`, `RiskContextPort`, `ResolutionIngress`, `RiskTypes`, `IAccountingPort`)
  instead of sending findings for B to fix (ownership map). B has reviewed every one of these edits
  and adopts them as B-owned code. Future B-file changes should come as findings or be pre-agreed.
- **B-D02 (Info):** `_previewAccrual/_previewCharges` in the bridge re-derive A's funding and premium
  accrual for views. They match A's rules today (view-only, no authorization), but duplicated logic
  can drift; an A-owned view such as `_projectedTouch(owner, at)` would be safer.
- **B-D03 (Info):** in `PremiumMath._accumulate` the triangle numerator `p²` uses checked
  multiplication, so a positive-part endpoint above 2^128 Q (≈3.4e14 USDC) reverts. That is far
  outside reachable balances, but the documented `|a| < 2^182` domain should say so.
  *Update 2026-10-02 (resolved, B-D03):* the bound is tighter than stated. In the sign-crossing
  branch the positive endpoint is below |lots·rate|·3600 < 2^112 Q, so the square cannot overflow in
  `cumulative`'s domain at all. Documented on `_accumulate`; checked by
  `contracts/test/audit/BD03PremiumBounds.t.sol` (max-slope crossing plus a domain fuzz).
- **B-D04 (Info):** every vault claim on the engine (trader, LP, treasury, protocol-fee escrow) runs
  B's cash fence, so the first LP or treasury withdrawal also fixes claim mode to CASH. Conservative
  and harmless while conversion is disabled (DEC-10); revisit if conversion is ever enabled.
- **B-D05 (Info):** with no normal mark, a voluntary reduction must leave the account fully backed.
  This blocks deleveraging legacy accounts during a stale-mark period; conservative, spec-consistent.

### Still open (acknowledged)

- **A-I01** global-vault classification of fractional protocol/keeper fee Q. Next owner: A, with B
  review. Proposed decision: move `protocolFeeEscrowQ` and `keeperQ` into per-beneficiary Q escrows
  in `CollateralVault` (recognized custody identity extended with an escrow-Q term; floor-atom
  withdrawals keep fractions), reducing market `allocationQ` exactly at reclassification, as spec §5.5 states.
- Live counterparts (book, oracle, price collector, factory, app) remain BLOCKED_BY_COUNTERPART.
  `origin/feat/oracle` now exists but contains only `docs_oracle/eros-oracle-implementation-plan.md`.
- Production blockers in `artifacts/risk/release-manifest.json` remain; no deployment approval.

### G7 recommendation

B recommends coordinator acceptance of G7 at `3b11044` plus this review commit (no source change
in B's review commit). B's delta review is recorded; coordinator acceptance and a real accepted
merge SHA remain to be recorded by the coordinator.
