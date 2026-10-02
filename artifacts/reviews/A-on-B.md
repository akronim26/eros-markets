# A043: Person A review of B and the integration bridge

Review status: COMPLETE

Reviewer: Person A's coding agent. Date: 2026-10-02. Baseline:
`71576ed4f0befcb5ec8a97154895c4b803d804d6` on `integration/risk`, plus the local
review fixes. This is an implementation cross-review, not an external security audit.
This review grants no merge, deployment or approval by Person B. The implementation
fixes are committed through `ec141753b7fbb347267f3272f5e372d1449adbf0`.

The completed source-bound record is `artifacts/reviews/A-on-B.json`; the A043
runner checks its source hashes and reruns the review regressions. Changing source
invalidates that evidence. Historical B approval applies to B's baseline, not to
these new local edits.

## Findings and disposition

| ID | Severity | Finding and repair | Reproducer |
| --- | --- | --- | --- |
| A-B01 | Medium | R-04 skipped the old freshness endpoint for observations arriving after an unrolled epoch ended. Rollover could accrue funding across the missing interval. Apply old freshness through epoch end and never substitute a valid mark for an unstopped funding permission. | `A043IntegrationReview.t.sol`: exact/late epoch boundary and direct A entry routes |
| A-B02 | Low | R-06 captured the epoch before A's freeze incremented it again. Halt view, event and snapshot hash now use the actual post-freeze accounting epoch. | `A043IntegrationReview.t.sol`: early, scheduled and interrupted-rollover halts |
| A-B03 | High | Voluntary reduce-only fills checked endpoint deficits but omitted positive equity and the MM shortfall predicate. A long of 1,000,000 lots with cash -480 USDC at mark 0.60 sold 500,000 lots at tick 1, ending at -179.5 USDC equity. Both maker and taker voluntary reductions now apply the shared allowed-reduction predicate at the actual price and fees. | `A043BReview.t.sol`: bad taker stop, bad maker prune, safe at-mark control |
| A-B04 | Medium | Preview decisions used booked balances while execution settled funding and premium first. A real fixture quoted 4,095,792 releasable atoms before touch versus 4,094,125 after touch at the same block. Preview ports now simulate the same global funding and account/coverage touch. | `A043BReview.t.sol` and `A043IntegrationReview.t.sol`: same-block premium/funding/coverage comparisons |
| A-B05 | Low | Negative ledger cash forced a zero release quote even for a positive-equity long that could release safely. Bound the search by terminal equity and search the full supported atom domain. | `A043BReview.t.sol`: negative-cash long release |
| A-B06 | Medium | Accrued deficits above the new-exposure 2% cap blocked safe reductions. A position at the cap followed by 600 seconds of premium reproduced a zero fill. Reduce-only routes may preserve or reduce both deficits while retaining health and coverage checks; new risk remains capped. | `A043BReview.t.sol`: accrued concentration-cap reduction |
| A-B07 | Low | R-09 discarded A's actually charged forced-close fee; a waived partial allowance could be reported as charged. Fill result/event now propagate A's return value. | `A043BReview.t.sol`: partial allowance waived, actual fee and keeper payment zero |
| A-B08 | Medium | Initialization and staged profiles accepted caps/templates that contradicted the immutable listing. Both now reject zero/excess caps and a different template; a lower cap remains allowed. Four failing baseline cases now pass with a valid lower-cap control. | `A043ConfigReview.t.sol`: five configuration regressions |

Fixes live in B's `OrderAdmission`, `BookRiskAdapter`, `LiquidationBookAdapter`,
`TradePreview`, configuration ports, and the integration-owned
`RiskAccountingBridge`/`ResolutionIngress`. Their task boundaries are B019,
B021–B026, B028–B032 and B034–B038. A's accounting still owns all actual cash,
position, reserve and fee postings. Source hashes identify the exact reviewed
implementation; the record names its committed source tip separately from this
review/evidence commit.

All eight findings above are resolved in the reviewed working tree. No open
critical/high finding remains in this review's scope. The limitations below are
retained; COMPLETE does not mean production-ready or independently audited.

## Reviewed routes

| Route | Review evidence |
| --- | --- |
| Units, sign conventions, rounding | G0/G1 compare real A and B primitives, endpoints and quantized funding. G2 and the independent Fraction vectors cover composed admission/coverage/payoffs. A-F02 now requires exact segment ceilings. |
| Margin and concentration | B hazard/horizon/margin libraries use directed bounds and explicit full-backing fallback. Admission, fills and releases consume real A coverage. A-B03 and A-B06 close reduction exceptions. |
| Reservations and pairing | R-05 is accepted: internal reservation consumption precedes A's paired posting in one transaction; coverage and unexpected-failure rollback remain checked. G4 verifies stale epochs and second-fill rollback. |
| Funding and premium | R-04 is accepted only with A-B01's repair. Old OI, continuous freshness, stopped funding and projected premium stop use the same accounting rules. |
| Liquidation | Tiny caller budgets and scarce liquidity do not authorize positive-equity takeover. Pair/book fees remain full-or-waived; A-B07 makes reported fees truthful. Floor takeover remains price-free and whole-account. |
| Pricing ingress | Pinned source/signature domain, market, sequence and observation time are checked; missing windows remain unavailable. Review does not certify a real collector/signing service. |
| Halt and finality | Pinned resolution authority, explicit outcome mapping, immutable earliest halt and idempotent identical finality are retained. Conflicting finality reverts. A-B02 aligns frozen epochs. |
| INVALID and preparation | Scheduled index window and disclosed missing-data fallback remain immutable; price/finality alone do not open claims. Snapshot/payout jobs remain bounded. |
| Cash claims and conversion | Actual vault payments invoke A's hook for both claim routes; counters/claim mode roll back on failed or reentrant transfers. Conversion remains disabled. |
| Deployment defaults | Funding/recovery/conversion remain disabled and cap 1 fixtures are exercised. Configuration mismatch review is included in A-B08. No real deployment exists. |

## A-owned changes reviewed alongside B

`AccountingState` is shared from `MathTypes.sol`; market epoch increments use A's
checked helper. The reservation-replace port retains live/context/epoch/coverage
checks while avoiding a repeated decision callback. Trader entitlement counters
drive COMPLETE, including direct vault claims and excluding zero-atom payouts.

A-F01 now settles an unactivated market through the ordinary authenticated halt,
bounded snapshot/payout and fixed-recipient claims. A-F02 rounds the exact summed
rational premium once. A-F03 keeps protocol fees in a separate fractional-Q engine
escrow, with floor-atom withdrawals to the configured immutable treasury.

## Retained limitations

- A-I01 remains: protocol/keeper fractional Q is classified in the engine's market
  allocation rather than moved into global vault Q escrows. No lost-Q claim or
  full implementation of that storage requirement is made.
- Book, price collector, oracle and factory counterparts are mocks or absent.
  `Book.sol` is unchanged; its ten seam requests remain a counterpart task.
- The monolithic mock-book composition and large test fixtures do not certify
  target-chain deployment size or gas. Production calibration and inputs remain open.
- B's historical review must be supplemented by review of these new A/B fixes,
  then a real accepted commit. Automated technical checks do not grant that approval.

## Reproduction

Use Foundry 1.8.3 as documented in `docs/merge/toolchain-reproduction.md`.
Run `forge test --match-path 'test/reviews/*.t.sol'` with the `risk` profile, all
three `test/audit/findings/*` regressions, then `bash scripts/check-gate.sh G0`
through G7 in order. Fresh command records are retained in `artifacts/gates/` and
`artifacts/tasks/A043.json`; the review cannot pass with stale hashes or unresolved
critical/high findings.
