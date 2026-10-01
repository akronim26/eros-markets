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
