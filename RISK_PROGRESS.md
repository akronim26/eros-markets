# Person A risk implementation progress

## Real-book and Monad update — 2026-10-03

The shared living checklist is **[Risk + Book tracker](docs/integration/RISK_BOOK_TRACKER.md)**.
It maps implementations, validation, exact testnet addresses/receipts, limitations, owners and
the checklist to follow when behavior changes. Update it alongside `docs/merge/STATUS.md`.

RB-I01 is repaired, awaiting independent review. A guarded concrete engine combining real Book,
A accounting/vault and B risk is deployed on Monad testnet. Funding, matching, controlled YES settlement and
both cash claims succeeded. This uses test collateral, synthetic signed INDEX and controlled
finality: it is not production approval or actual oracle integration. The smoke market is closed.
RB-I02 maker remainder liveness, the PERP sampler and real counterpart joins remain open.
Current evidence: `artifacts/risk/real-book-validation-2026-10-03.json` and the tracker.
Earlier sections below describe their historical source ranges, not current deployment status.

## Shared integration update — 2026-10-03

Current branch: `integration/risk`. History was inspected and reported before edits; see
`docs/merge/history-review-2026-10-03.md`. B's newer B-D02/B-D03/A-I01 work is reviewed and accepted,
including all six vault-fee choices. B's earlier review of A's fixes is already complete.

The human authorized main `a114d06` into this branch; merge `13ca730` reconciles five conflicts
and the canonical-type/helper hazards. A test-only engine now composes real Book, real A
accounting/vault, and real B controllers. It exposes an inherited reduction-version liveness
limitation (RB-I01); no version safety checks were removed. Main was not updated or deployed.

Current results and next steps: `docs/merge/STATUS.md`,
`artifacts/risk/merge-validation-2026-10-03.json`, and the structured B handoff
`docs/requests/A-to-B-merge-followup.md`. G7 human acceptance and production counterparts remain
separate from technical passes. Earlier entries below are historical, not current blockers.

## Integration review update — 2026-10-02

Current work is on `integration/risk` based on `71576ed`. The initial history report
is `docs/merge/history-review-2026-10-02.md`. A's integration review, eight concrete
B/bridge findings and repairs, five requested accounting ports, and fixes for
A-F01–A-F03 are recorded in `docs/merge/A-integration-review.md` and
`artifacts/reviews/A-on-B.md`. Fresh gate/task artifacts supersede the historical
solo-lane counts below. Foundry validation now targets the existing CI pin 1.8.3.
External counterpart integration and final B review of these new fixes
remain separate. The original solo-lane progress record follows for provenance.

Updated 2026-10-01 on feat/risk. Scope follows the user's latest instruction:
**implement A independently; merge B later; leave the order book untouched.**
The attached packet supplies requirements, not permission to override that scope.

A001-A042 and A044 are implemented and pass their local checks. A043 has a review checklist
and reproducers, but actual B review remains pending until B's code is available.
G0-G7 remain pending. No peer approval or production release is claimed.

## Sources and composition

Selected specification v1.1, economic baseline v1.0. Formula notation follows
risk_spec.md and the clearing specification. Ledger and coverage identities were
checked visually in full-risk-analysis.pdf pages 4-5 and the clearing PDF page 4.
[Unit mapping](docs/math/units.md) distinguishes the analysis PDF's OI symbol Q
from the implementation's fixed-point cash Q.

[A backlog](docs/implementation/backlog.json) and
[execution authority](docs/implementation/authority.json) preserve the scope.
The user's instruction permits local A work before shared gates are accepted.
Real A accounting uses abstract internal decision/context ports. B decisions,
finality and prices are scripted in tests. No B margin, pricing, oracle, lifecycle
or matcher implementation is supplied.

Book.sol, RiskSnapshot.sol, existing book tests and book gas snapshots are
protected against baseline 3cfa48d69e799b73f92a9955fdc7932c08cd925f.

## Implementation ledger

Each task has executable evidence at artifacts/tasks/Axxx.json. Solidity source
paths below are relative to contracts/src; tests live under contracts/test.
These checks establish A-local behavior only.

| Task | Implemented deliverable | Source / evidence |
| --- | --- | --- |
| A001 | Exact units, domains and outcomes | reference/common/units.py, math/MathTypes.sol |
| A002 | Fail-closed task/gate runners and exact evidence schema | scripts/check-task.sh, scripts/check-gate.sh |
| A003 | Rational ledger and terminal equity | reference/a/ledger.py |
| A004 | Order deficits and reserve coverage | reference/a/coverage.py |
| A005 | Fixed-epoch funding reference | reference/a/funding.py |
| A006 | Exact clipped-affine premium integral | reference/a/premium_integral.py |
| A007 | Surcharge and epoch capitalization | reference/a/premium_epochs.py |
| A008 | Payout, fee, capital and backstop arithmetic | reference/a/settlement.py |
| A009 | Directed integer bounds and rounding | reference/a/integer_bounds.py |
| A010 | Checked Solidity ledger/payoff math | math/QMath.sol, math/LedgerMath.sol |
| A011 | Funding budget and payer cushion | math/FundingMath.sol |
| A012 | Analytic premium; conservative <12 Q segment error | math/PremiumMath.sol |
| A013 | Coverage and fee primitives | math/CoverageMath.sol, math/FeeMath.sol |
| A014 | Settlement and capital primitives | math/SettlementMath.sol |
| A015 | Independent Fraction/Solidity differential vectors | reference/a/export_vectors.py, test/math/A |
| A016 | Isolated storage and append-only 1024-account registry | risk/RiskStorage.sol, risk/AccountRegistry.sol |
| A017 | Exact-receipt collateral custody and allocation | vaults/CollateralVault.sol |
| A018 | Atomic paired postings and Q fee ledgers | risk/Accounting.sol, risk/FeeAccounting.sol |
| A019 | Endpoint coverage and stored-deficit accumulation | risk/ReserveAccounting.sol |
| A020 | Locked shares, donations, notices and capped earmarks | vaults/ReserveVault.sol, vaults/BackstopPool.sol |
| A021 | Internal B ports and A-only harness | risk/AccountingPort.sol, test/harness/A |
| A022 | Old-OI funding and immutable feature flag | risk/FundingAccounting.sol |
| A023 | Cumulative premium and surcharge state | risk/PremiumAccounting.sol |
| A024 | Funding/premium/deficit touch sequence | risk/AccountSync.sol |
| A025 | Bounded rollover; no idle catch-up | risk/EpochRollover.sol |
| A026 | Atomic clearing, reservations, reserve unwind | risk/ClearingCore.sol |
| A027 | Fee/release/conservation fuzz checks | test/risk/A/TradeAccountingInvariant.t.sol |
| A028 | Eligible whole-account cash-and-position takeover | risk/TakeoverAccounting.sol |
| A029 | Close fees, waiver and keeper fractions | risk/LiquidationFees.sol |
| A030 | Constant-work halt and separate accrual cutoff | risk/FreezeAccounting.sol |
| A031 | Bounded floor reconciliation | risk/FloorAccounting.sol |
| A032 | Ledger events and bigint SDK reader | risk/AccountingEvents.sol, packages/risk-sdk |
| A033 | Stale-mark and interrupted-liquidation checks | test/risk/A/LiquidationAccounting.t.sol |
| A034 | Immutable frozen account materialization | settlement/SnapshotLedger.sol |
| A035 | Finality-bound price, claims, escrows, residual | settlement/PayoutLedger.sol |
| A036 | Capped backstop custody and prelisted recovery | settlement/RecoveryAccounting.sol |
| A037 | Fixed-recipient once-only claims and rollback | settlement/ClaimEscrow.sol |
| A038 | Mature LP exits, frozen denominator, fee/dust classification | settlement/ReserveClaims.sol |
| A039 | Page, price and claim-order fuzz reconciliation | test/risk/A/SettlementConservation.t.sol |
| A040 | Integrated invariants and independent rational traces | test/invariant/A, reference/a/integrated_traces.py |
| A041 | Local math/touch/sweep/claim gas measurements | test/gas/A/AccountingGas.t.sol |
| A042 | Cross-market custody isolation and capital exits | test/integration/A/CustodyExit.t.sol |
| A043 | Checklist/reproducers ready; **actual B review pending** | [Review handoff](artifacts/reviews/A-on-B.md) |
| A044 | Runbook and local release evidence assembler | [Runbook](docs/runbooks/accounting.md), scripts/check-a-handoff.py |

The A036 counterfactual bad-debt fixture bypasses healthy coverage in test code
only, so recovery arithmetic and actual backstop transfers can be exercised.
No production arbitrary-balance or emergency-loss setter exists.

## Validation

Final regression: **163 Solidity tests passed in 44 suites: 53 A tests and all
110 existing book tests**, with no failures or skips. There are also **42 passing
Python tests** and a passing TypeScript compile/SDK reader test. Trade and
settlement fuzz cases each run 1,000 examples. The A invariant passed
48 runs / 3,072 calls / zero reverts with deposits, releases, fills, liquidation,
funding, premium and rollover. Each invariant run also settles and claims in
its terminal check. Python independently checks 2,000 rational transitions;
64 are replayed in Solidity. Math has another 64 ledger and 32 premium vectors.
All 44 task records and the G0 record pass their JSON schema. A001-A042 and A044
report passed; A043 deliberately exits 2 with pending peer review. G0 likewise
exits 2 for missing B/shared artifacts; G1-G7 have not been accepted.

Final commands: all A task runners, scoped A formatting, build with size reporting,
and the complete Forge suite with risk profile and snapshot emission disabled.
The build and A formatting pass. The diff for every protected book path against
the starting commit is empty. Whole-repository formatting with local Foundry 1.5.1
reports existing book formatting differences; those files remain unchanged.

Evidence: [full regression and protected hashes](artifacts/validation/A-final.json),
[local handoff manifest](artifacts/risk/accounting-release.json),
[task records](artifacts/tasks), [custody reconciliation](artifacts/risk/custody-reconciliation.json).

Actual [local gas measurements](artifacts/risk/gas-accounting.json) use 1024 funded
participants carrying positions, active funding/premium and 32-account pages:

| Operation | Measured gas |
| --- | ---: |
| Rollover start | 82,606 |
| Largest 32-account rollover page | 3,297,328 |
| Halt with 1024 accounts | 72,104 |
| Largest 32-account snapshot page | 2,354,829 |
| Trader claim | 91,541 |
| Premium math | 16,641 |
| Funding/premium account touch | 191,487 |

These are local Prague EVM call measurements, not network transaction ceilings.
The aggregate test harness is 33,617 runtime bytes. Its standard IS_TEST marker
excludes it from production size reports; its actual size remains disclosed.

Local toolchain: Python 3.12, Foundry 1.5.1, Solidity 0.8.30, Prague, optimizer 200.
Repository CI pins Foundry 1.8.3; local results do not claim execution on that
version. Existing forge-std and Solady pins are unchanged. Evidence records actual
source commit, dirty state, seed, commands and source hashes.

## Merge and release boundaries

- Reconcile draft A ports with B, complete A043 and run combined G0-G7. No missing
  gate has been relabeled accepted.
- Bind real token, price source, oracle and matcher counterparts; authenticate
  internal callers and finality in the final engine. A supplies no public
  privileged production orchestrator.
- Baseline funding/recovery flags are immutable false; B must retain conversion
  disabled and leverage caps of 1. Enabled funding fixtures are separate tests.
- Total OI is conservatively capped at 2^40 lots to keep worst-case reserve
  takeover in the position domain. Confirm this numerical limit at merge.
- The test-only aggregate harness exceeds EIP-170's 24,576-byte runtime limit.
  The risk profile allows 65,536 bytes. Final production composition requires
  separate bytecode-size and target-chain gas checks.
- Existing book quantity/key widths and stated cost units differ from the packet.
  Reconcile its adapter at merge; the book stays unchanged.

## Commits

- 7c65d46 — exact A001 units and pure types.
- 10c56cc — A002 task/gate runners.
- 52521c8 — W0 evidence and progress.
- 81a3d0b — A003-A015 reference engine and pure Solidity math.
- 4c52854 — A016-A039 clearing, custody, accrual, settlement, SDK and regression tests.
- Final campaign, handoff and evidence are committed with this progress revision.
