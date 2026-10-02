# Person A lane audit (Phase 1, read-only on A's code)

Auditor: Person B's coding agent. Date: 2026-10-01. Spec v1.1, economic baseline v1.0.

## What was audited and how

| Item | Value |
|---|---|
| A's last commit (A lane tip) | `61be284` (YASH-ai-bit, "test(risk): finish A invariant campaigns and accounting handoff evidence") |
| Tree that was run | `feat/risk` at `ffc9f52` (merge of B `fecd2fb` + A `61be284`). `git diff 61be284 ffc9f52 -- <every A file>` is empty, so A's files are byte-identical to A's tip. |
| A's recorded evidence commit | `4c52854` (an earlier A commit; see A-I11) |
| A's code changed during the audit | No. New files only: `contracts/test/audit/**`, `reference/tests/audit/**`. |
| B decisions in A tests | A's scripted `MockRiskDecision` (allow/deny lists). No real B margin/admission/pricing code is exercised by any A suite or by `AuditStateful.t.sol`. |
| Toolchain | Python 3.13.13 (`python`), 3.13.1 (`python3`); forge 1.3.5-stable; solc 0.8.30; Solady `2afba69` (v0.1.26-36); forge-std `f3dae6e` (v1.17.0); node 18.20.8; `tsc` not installed |

A's own local toolchain was Python 3.12.10 and forge 1.5.1; this audit reproduced A's results
on forge 1.3.5 (CI pins 1.8.3; nothing here ran on 1.8.3).

## 1. Coverage table A001–A044

Every task's `write_files` exist at `61be284` (checked with `git cat-file -e`; none missing).
"Observed" is the exact `acceptance_command` from `docs/spec/tasks_A.json`, run from the
repository root on `ffc9f52`. Logs: scratch run, summarized here; the A040–A044 runner rewrote
A's tracked evidence files, which were restored with `git checkout -- artifacts` afterwards.

Status key: **verified** = exact command exit 0 and no peer double involved; **mock-only** = exact
command exit 0, but B (peer lane) is A's scripted `MockRiskDecision`/harness context, so it is a
lane pass, not a combined pass; **failing** = nonzero exit; **missing** = files absent.

| Task | Acceptance command (exact) | Exit | Tests observed | A's claim (artifacts/tasks) | Status |
|---|---|---:|---:|---|---|
| A001 | `python -m unittest discover -s reference/tests/a -p "test_a001.py"` | 0 | 12 | passed, 12 | verified |
| A002 | `... -p "test_a002.py"` | 0 | 15 | passed, 15 | verified |
| A003 | `... -p "test_a003.py"` | 0 | 2 | passed, 2 | verified |
| A004 | `... -p "test_a004.py"` | 0 | 2 | passed, 2 | verified |
| A005 | `... -p "test_a005.py"` | 0 | 3 | passed, 3 | verified |
| A006 | `... -p "test_a006.py"` | 0 | 2 | passed, 2 | verified |
| A007 | `... -p "test_a007.py"` | 0 | 2 | passed, 2 | verified |
| A008 | `... -p "test_a008.py"` | 0 | 2 | passed, 2 | verified |
| A009 | `... -p "test_a009.py"` | 0 | 2 | passed, 2 | verified |
| A010 | `cd contracts && forge test --match-path test/math/A/A010.t.sol` | 0 | 3 | passed, 3 | verified |
| A011 | `... test/math/A/A011.t.sol` | 0 | 2 | passed, 2 | verified |
| A012 | `... test/math/A/A012.t.sol` | 0 | 2 | passed, 2 | verified (see A-F02) |
| A013 | `... test/math/A/A013.t.sol` | 0 | 1 | passed, 1 | verified |
| A014 | `... test/math/A/A014.t.sol` | 0 | 1 | passed, 1 | verified |
| A015 | `... test/math/A/A015.t.sol` | 0 | 2 | passed, 2 | verified (tolerates +11 Q premium, A-F02) |
| A016 | `... test/risk/A/A016.t.sol` | 0 | 1 | passed, 1, peer scripted | mock-only |
| A017 | `... test/risk/A/A017.t.sol` | 0 | 2 | passed, 2 | mock-only |
| A018 | `... test/risk/A/A018.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A019 | `... test/risk/A/A019.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A020 | `... test/risk/A/A020.t.sol` | 0 | 3 | passed, 3 | mock-only |
| A021 | `... test/risk/A/A021.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A022 | `... test/risk/A/A022.t.sol` | 0 | 2 | passed, 2 | mock-only |
| A023 | `... test/risk/A/A023.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A024 | `... test/risk/A/A024.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A025 | `... test/risk/A/A025.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A026 | `... test/risk/A/A026.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A027 | `... test/risk/A/A027.t.sol` | 0 | 2 | passed, 2 (1,000-run fuzz) | mock-only |
| A028 | `... test/risk/A/A028.t.sol` | 0 | 2 | passed, 2 | mock-only |
| A029 | `... test/risk/A/A029.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A030 | `... test/risk/A/A030.t.sol` | 0 | 2 | passed, 2 | mock-only |
| A031 | `... test/risk/A/A031.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A032 | `... test/risk/A/A032.t.sol` | 0 | 1 | passed, 2 (forge 1 + SDK reader 1) | mock-only. A's runner `bash scripts/check-task.sh A032` exits 2 here because `tsc` is not installed; the SDK reader test itself passes when run with the cached `tsx` (exit 0). |
| A033 | `... test/risk/A/A033.t.sol` | 0 | 2 | passed, 2 | mock-only |
| A034 | `... test/risk/A/A034.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A035 | `... test/risk/A/A035.t.sol` | 0 | 2 | passed, 2 | mock-only |
| A036 | `... test/risk/A/A036.t.sol` | 0 | 2 | passed, 2 | mock-only |
| A037 | `... test/risk/A/A037.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A038 | `... test/risk/A/A038.t.sol` | 0 | 1 | passed, 1 | mock-only |
| A039 | `... test/risk/A/A039.t.sol` | 0 | 1 | passed, 1 (1,000-run fuzz) | mock-only |
| A040 | `bash scripts/check-task.sh A040` | 0 | 2 (+ Python trace exit 0) | passed, 2; invariant 48 runs × depth 64 | mock-only |
| A041 | `bash scripts/check-task.sh A041` | 0 | 2 | passed, 2; gas table | mock-only. Regenerated `gas-accounting.json` measurements identical to A's committed values (only commit/toolchain metadata differed). Prague EVM, not Monad. |
| A042 | `bash scripts/check-task.sh A042` | 0 | 2 | passed, 2 | mock-only |
| A043 | `bash scripts/check-task.sh A043` | 2 | 1 | blocked: "B implementation is absent" | failing (blocked by design: peer review of B not done) |
| A044 | `bash scripts/check-task.sh A044` | 0 | 44 checks | passed, 44 | mock-only (handoff assembler; reports gates pending) |

Counts: **15 verified** (A001–A015), **28 mock-only** (A016–A042, A044), **1 failing/blocked** (A043),
**0 missing**. Whole A suites: Forge 53/53 pass (35 suites) under both the default and `risk`
profiles; Python `reference/tests/a` 42/42 pass. These match A's `RISK_PROGRESS.md` claims.

## 2. Ownership

A changed 164 files between baseline `3cfa48d` and `61be284`. 106 are in A's task `write_files`.
The other 58 are A evidence or A-test support, all A-owned by the ownership map:

- Evidence/plan: `RISK_PROGRESS.md`, `artifacts/tasks/A001.json`–`A044.json`,
  `artifacts/validation/{A-final,W0}.json`, `artifacts/risk/reference-campaign.json`,
  `docs/implementation/{authority,backlog}.json`.
- `artifacts/gates/G0.json` — a gate record; A is G0 coordinator. It records
  `status: blocked`, `accepted: false`, `merge_sha: null` (no gate claimed).
- A test support: `contracts/test/risk/A/AccountingTestBase.sol`, `contracts/test/mocks/A/MockUSDC.sol`,
  `contracts/test/math/A/ReferenceVectors.sol`, `contracts/test/invariant/A/IntegratedVectors.sol`,
  `packages/risk-sdk/test/accounting.test.ts`, `reference/fixtures/a/vectors.json`, `scripts/check-a-handoff.py`.

**No B-owned file and no counterpart internal was changed** (Book.sol, RiskSnapshot.sol, book
tests and `contracts/snapshots/BookGas.json` have an empty diff against `3cfa48d`).
`contracts/foundry.toml` is in A002's write_files (A added `[profile.risk]` with
`code_size_limit = 65536` and a `[fmt] ignore` list).

Outside A's branch: `origin/main` contains `253ebd5` (book developer) that reformatted 11
B-owned sources and the generated `contracts/test/math/B/RiskDifferential.t.sol`, and
`2db4e08`/`c5db208` that edited A-owned `contracts/foundry.toml`. These are not on `feat/clob`
or `feat/risk`; recorded in `integration-progress.md` as a merge risk.

## 3. Spec conformance

Tests named `Audit*` are new in `contracts/test/audit/`; `A0xx` are A's tests. All audit tests
named here pass unless the row says otherwise.

| Requirement | Implementation (file:line) | Proving test | Holds? |
|---|---|---|---|
| Q = atom × 1e18; PAYOFF_Q_PER_LOT = 1000·Q (DEC-01) | `src/math/MathTypes.sol:8-15` | `AuditSpecVectors.testUnitsConstants` | Yes |
| E0 = c, E1 = c + 1000Q·n; E(p) = c + 1000·n·pWad, no second WAD division | `src/math/LedgerMath.sol:14-23` (`:18`) | `testEndpointsAndMarkEquityScale` (1,000-run fuzz), `testV01PairedFillExactSameQ`, A010 | Yes |
| Paired fill moves the same Q both sides | `LedgerMath.sol:25-43`; `src/risk/Accounting.sol:12-30` | `testV01PairedFillExactSameQ`, `testPairedFillConservation` (fuzz), A018, A027 | Yes |
| Payers round up / receivers down; equal debit and credit | Premium: `PremiumMath.sol:22-65` (ceil), posted equal both sides `PremiumAccounting.sol:18-25`. Funding: integer index, exact `AccountSync.sol:10-14`, `FundingAccounting.sol:16-22`. Liquidation fee split `FeeMath.sol:23-27`, `LiquidationFees.sol:84-86` | `testV10FundingZeroSum`, `testPremiumNeutralTouchStateful` (reserve credit == trader debits), `testLiquidationFeeOneAtomPerLot` | Yes (premium ceiling granularity: A-F02) |
| Dust never becomes withdrawable atoms | Release whole atoms `ClearingCore.sol:67,75`; keeper floor `FeeAccounting.sol:14-17`; payouts floor `SettlementMath.sol:11-13`; residual dust to treasury `ReserveClaims.sol:27` | bilateral tests (residual exact), A038, `CustodyExit` | Yes |
| Funding: one rate per epoch, truncated toward zero | `FundingMath.sol:16-23` (`/` truncates toward 0); stored once `EpochRollover.sol:26` | `testFundingRateTruncatesTowardZero`, `testFundingEpochBudgetAndStop` | Yes |
| Budget = min(OI·\|r\|·secs, min slack); consumed by current OI | `FundingMath.sol:25-31,33-51`; `EpochRollover.sol:20-24`; `FundingAccounting.sol:16-20` | `testV11OiChangeBudget`, `testFundingEpochBudgetAndStop` (old OI 20 s, then new OI, stop at affordable second) | Yes |
| OI = 0 branch | `FundingMath.sol:39-42`; epoch opened with OI 0 disabled `EpochRollover.sol:23` | `testFundingZeroOiOrRateStops`, `testFundingEpochBudgetAndStop` (first trade does not start funding) | Yes |
| fundingClearingQ contra ledger; zero after full sweep | `FundingAccounting.sol:22`, `AccountSync.sol:13`; asserted `EpochRollover.sol:58`, `FloorAccounting.sol:40`, `SnapshotLedger.sol:30` | `testV09ReserveFundingCases`, `testPremiumCapitalizedAtRollover`, A022, A025 | Yes |
| Freeze at floor; no catch-up | cutoff capped at T−12h and stopped `FundingAccounting.sol:13-14,23-26`; disabled after floor `EpochRollover.sol:23`; one stop per epoch `FundingAccounting.sol:9` | `testFundingEpochBudgetAndStop` (no restart), A022 | Yes |
| Premium integrates funding-affine principal deficits | `PremiumMath.sol:35-65`; segment `PremiumAccounting.sol:10-16` | `testV12V14PremiumExact` (exact), `testV15PositivePartCrossing` | Yes (rounding A-F02) |
| Current-epoch premium excluded from its base | `PremiumAccounting.sol:29,35` (principal = cash + premiumPaid) | A023, `testPremiumNeutralTouchStateful` | Yes |
| Capitalized at rollover | `EpochRollover.sol:51-55` | `testPremiumCapitalizedAtRollover` | Yes (storage-order note A-I02) |
| Account-wide 4x renewal on new deficit | `PremiumAccounting.sol:32-38` | `testV12V14PremiumExact`, `testPremiumNeutralTouchStateful` (surchargeUntil set) | Yes |
| No premium on fully backed accounts or reserve | zero principal deficit → zero integral; reserve not a participant | `testNoPremiumWhenFullyBacked` | Yes |
| INV-04 R_y ≥ Dbar_y + B after every mutation | `CoverageMath.sol:23-31`; `ReserveAccounting.sol:19-23`; called at end of every posting path (`ClearingCore.sol:37,56,77,97,131,156,189`, `TakeoverAccounting.sol:42`, `LiquidationFees.sol:46,90`, `FundingAccounting.sol:27`, `EpochRollover.sol:29,59`, `FloorAccounting.sol:44`, `SnapshotLedger.sol:39`) | `testTwoWalletReserve480Suffices`, `testTwoWalletReserveBelow480Rejected`, `_assertInvariants` in every stateful audit test, A019, A027 | Yes |
| Dbar includes live order prefixes | `CoverageMath.sol:15-21` (all-bids-fill for NO, all-asks-fill for YES, fee cap subtracted) | `testV07OversizedAskYesDeficit`, `testV08CancelExactContribution` | Yes for the aggregates A receives; A trusts B's post-fill aggregates (A-I14) |
| Dbar includes unmaterialized payer funding | cushion `FundingAccounting.sol:20`, retired `AccountSync.sol:14`, in slack `CoverageMath.sol:29-30` | `testV09ReserveFundingCases`, `testFundingEpochBudgetAndStop` | Yes |
| Takeover: whole account, no fee, slack +max(e_y,0), no bad-debt cash | `TakeoverAccounting.sol:8-45`; floor `FloorAccounting.sol:36` | `testV16TakeoverSlackIdentity`, `testTakeoverEligibilityWholeAccountNoFee`, A028 | Yes |
| Positive-equity takeover never from shortage (DEC-13) | eligibility `TakeoverAccounting.sol:15-19` | `testTakeoverEligibilityWholeAccountNoFee` (mark 0.60 rejected), A028, A033 | Yes |
| Vault rejects fee-on-transfer | `CollateralVault.sol:59-68`, `:119-127` | `testFeeOnTransferTokenRejected`, A017 | Yes |
| INV-03 recognized ≤ custody | `CollateralVault.sol:126` + exact-receipt deposits | `_assertInvariants`, A042 `CustodyExit` | Yes |
| CEI and reentrancy guards | vault `lock` `:43-48`; engine `nonReentrant` `RiskStorage.sol:129-134`; state before transfer `ClearingCore.sol:75-78`, `FeeAccounting.sol:14-18` | A017 `testDepositReentryRejected` | Yes |
| No public arbitrary ledger mutator | only vault may call `onAllocate`/`onReserveAllocate` (`ClearingCore.sol:27,41`); other externals act on `msg.sender` or fixed recipients | `testNoPublicLedgerMutatorFromNonVault` | Yes (the harness's privileged entry points are test-only) |
| INV-10 one frozen cutoff | `FreezeAccounting.sol:10-25`; `SnapshotLedger.sol:22` | bilateral tests, A030, A034 | Yes |
| INV-09 claims once-only, order independent, only after allocation | `ReserveClaims.sol:31`; `CollateralVault.sol:99-107` | bilateral tests (both orders, second claim reverts), `testClaimsNotEnabledBeforeAllocation`, A035, A037 | Yes |
| Fee escrow keeps fractional Q | keeper `FeeAccounting.sol:14-17`; treasury `ReserveClaims.sol:46-52` | A038, `CustodyExit` | Yes; protocol fee classification A-F03 |
| Recovery disabled by default | immutable flag `RiskStorage.sol:88,144`; gate `RecoveryAccounting.sol:36` | `testRecoveryDisabledFlag`, A036 | Holds only if the deployer passes `false` (A-I05) |
| LP issuance only before activation; residual after claims allocated; 7-day notice (DEC-06) | `ReserveVault.sol:27-35,58-65`; `ReserveClaims.sol:14` | `testNoShareIssuanceAfterActivationAndNoticeGate`, A020, A038 | Yes |
| Conversion off (DEC-10) | A has no conversion path (B `ConversionGate`) | — | Yes (n/a to A) |
| Registry 1,024, never deleting | `AccountRegistry.sol:6-19` | `testRegistryCapAndBatchBound`, A016 | Yes |
| Batch ≤ 32 | `EpochRollover.sol:46`, `FloorAccounting.sol:29`, `SnapshotLedger.sol:17`, `PayoutLedger.sol:39,62`, `ReserveClaims.sol:14` | `testRegistryCapAndBatchBound` | Yes |
| \|cashQ\| < 2^180; \|position\| ≤ 2^40 | `QMath.sol:20-28` used on every posting | `testCashBoundEnforced`, A010 | Yes |
| Checked arithmetic | solc 0.8.30; only `QMath.abs` is `unchecked` (safe for int256.min) | — | Yes |
| Reference independence | `reference/a/*.py` use `fractions`/`isqrt` only; `export_vectors.py:1` "Never execute Solidity here"; no subprocess/forge import | grep of `reference/a` | Yes |

## 4. Spec worked arithmetic against A's real code

| Check | Result |
|---|---|
| `verify_spec_vectors.py` (26 checks) | Run from a temp copy (the script rewrites `spec_vector_results.json`): exit 0, 26/26 passed — `reference/tests/audit/test_spec_vectors.py::SpecScript`. These are spec arithmetic, not A code. |
| V01–V17 on A's Solidity libraries | `AuditSpecVectors.t.sol`: 21/21 pass. V18–V20 (margin) are B's kernel and out of A's scope. |
| Two-wallet case | Interpreted as: Alice 120 long 1,000 @ 0.60 vs Bob 100 short; the reserve needed is the per-outcome maximum 480 USDC, not 480 + 300. With a 480 USDC seed the fill passes (slack NO = 0, YES = 180); with 479.999999 it reverts `Coverage()`. The prompt said "480 vs 800"; the spec's figures are 480 vs 780 (risk_spec §11 "Do not add 480+300"). |
| Resting-ask counterexample | Long 1 claim, cash 0, ask 2.3 claims @ 0.55: A's `CoverageMath.deficits` returns YES deficit 35,000 atoms (−0.035 USDC), NO 0 (`testV07OversizedAskYesDeficit`). A computes the exposure correctly. The 1x rejection itself is B's admission decision; A alone (with an allow-all scripted decision) does not reject it. Must be rechecked with real B at G4. |
| Section 11 bilateral position | Real A modules, page sizes 1 and 32, both claim orders: NO payouts 0 / 700, reserve residual 99,520; YES 520 / 0, residual 99,700; INVALID p = 0.5: 20 / 200, residual 100,000 USDC. Market cash 100,220 USDC. Second claim reverts. All 6 runs pass. The INVALID price was supplied directly; B's capture rule was not exercised. |

## 5. Findings

No Critical or High finding was found.

| ID | Severity | Where | Spec | Reproducer | Summary |
|---|---|---|---|---|---|
| A-F01 | Medium | `src/risk/ClearingCore.sol:11-16,62`; `src/risk/EpochRollover.sol:17`; `src/risk/FreezeAccounting.sol:9` | §2.3 custody, §5.5, role matrix | `contracts/test/audit/findings/AF01PreActivationLock.t.sol` (fails) | Allocations made before activation (trader cash and reserve seed) have no exit if T passes without activation. |
| A-F02 | Low | `src/math/PremiumMath.sol:58-62` | §5.3 premium rounding | `contracts/test/audit/findings/AF02PremiumRounding.t.sol` (fails: 18/32 vectors differ, max +4 Q) | Premium is rounded up per sub-interval and per outcome, not once per cumulative segment. |
| A-F03 | Low | `src/settlement/ReserveClaims.sol:27-28` | §5.5 fee escrow | `contracts/test/audit/findings/AF03ProtocolFeeEscrow.t.sol` (fails: treasuryQ = 2e18) | Protocol fee Q is folded into the reserve-treasury dust escrow. |

### A-F01 (Medium): pre-activation allocations are locked if the market never activates before T

- Evidence: `release` calls `_live()`, which reverts unless `active` (`ClearingCore.sol:12`).
  `_activate` → `_openEpoch` reverts when `now >= scheduledT` (`EpochRollover.sol:17`).
  `_freeze` reverts unless `active` (`FreezeAccounting.sol:9`), so no snapshot/claims path exists.
  `onAllocate` and `onReserveAllocate` both accept allocations before activation
  (`ClearingCore.sol:26-59`).
- Reproducer: allocate 100 USDC before activation, warp past T; `release`, `activate` and
  `freeze(T)` all revert, so the test's "some exit path" assertion fails.
- Impact: trader collateral and reserve seed recognized by this engine stay locked forever; no
  attacker gain; requires the activation step not to happen before T.
- Proposed fix (A-owned): allow a terminal path for a never-activated market at or after T (or
  on an authenticated halt): either let `release` run without a risk decision while `!active`
  (no positions can exist before activation), plus a seed-refund path in `ReserveVault`, or let
  `_freeze` accept `!active` and settle a zero-position snapshot. Medium, so left open in
  Phase 2 unless it blocks a gate.

### A-F02 (Low): premium rounding is coarser than the spec rule

- Spec §5.3: "Charge `ceil_Q(cumulativeSegmentIntegral(now)) - alreadyPostedForSegment`" and
  "total rounding error is less than one Q per nonzero rounded segment".
- A rounds each of up to 3 intervals × 2 outcomes separately (`mulDivUp` at `PremiumMath.sol:61-62`,
  plus `positiveIntegralUp`). A's own Fraction vectors store ceil(exact); A's differential test
  accepts `actual - expected < 12` (`test/math/A/AccountingDifferential.t.sol:23`).
- Reproducer result: 18 of A's 32 vectors differ; maximum overcharge 4 Q (4e-18 atom).
  Neutral-touch invariance still holds (the cumulative is recomputed from the segment origin).
- Fix: accumulate the exact rational sum over all pieces and outcomes with one final
  `mulDivUp`, or have the spec owner accept a per-segment bound of 12 Q.

### A-F03 (Low): protocol fee folded into the reserve-treasury escrow

- Spec §5.5: before the reserve residual is assigned, move exact `protocolFeeQ` and
  `keeperPayableQ` into separately recognized fee escrows; reserve-owned sub-atom remainders
  go to the reserve treasury escrow.
- A sets `treasuryQ = reserveResidualQ - lpAtoms*Q + protocolFeeQ; protocolFeeQ = 0`
  (`ReserveClaims.sol:27-28`). Q stays recognized (`ReserveClaims.sol:32` identity holds) and LPs
  do not receive it, but the protocol-fee liability is no longer a separate escrow and goes to
  the reserve treasury address. Baseline v1 fee is zero (DEC-11), so the amount is 0 at launch.
- Fix: keep a `protocolFeeEscrowQ` with its own beneficiary and floor-atom withdrawal.

### Info and needs-confirmation items (no reproducing failure)

- **A-I01** Keeper and protocol fee Q stay inside the market's `allocationQ`
  (`FeeAccounting.sol:12-20`) instead of moving to vault-level escrows. Classification is preserved
  (`ReserveClaims.sol:32`). Info.
- **A-I02** Rollover pages clear `premiumPaid` and set the next base per page
  (`EpochRollover.sol:51-55`) instead of staging until the global commit (§5.8 storage
  discipline). No observable effect found: trading/release are paused until the commit, and a halt
  reuses the same cutoff (`testPremiumCapitalizedAtRollover`, A030). Info.
- **A-I03** A halt during a rollover or floor sweep restarts the cursor at 0
  (`FreezeAccounting.sol:24`). Revisits are idempotent (same cutoff: zero funding, zero premium; A030).
- **A-I04 (needs confirmation)** `_freeze` reverts if `haltAt < epoch.start` or `< epoch.last`
  (`FreezeAccounting.sol:9-11`). Safe only if B passes the acceptance time (early halt) or T.
  Check against B's `ResolutionIngress` at G5.
- **A-I05** `recoveryEnabled` and `fundingFeatureEnabled` are constructor arguments
  (`RiskStorage.sol:136-145`), not fixed false. The composed engine and release manifest must pin
  both false.
- **A-I06 (needs confirmation)** `_chargeCloseFee` requires exactly one position change since
  `beforeVersion` (`LiquidationFees.sol:75`). A multi-maker IOC close must charge per fill. Reconcile
  with B's per-fill `_acctPostLiquidationFill` in Phase 2.
- **A-I07 (resolved)** The constructor rejects `scheduledT > now + 2,588,400 s`
  (~29.96 days) (`RiskStorage.sol:138-139`). This equals `max_listing_horizon_seconds` in
  `docs/spec/local_fixture_manifest.json`, so it is a spec fixture bound, not an A invention.
- **A-I08** Total OI is capped at 2^40 lots (`Accounting.sol:21`). A's documented assumption.
- **A-I09** A does not enforce the 2% per-account deficit cap (`CoverageMath.concentration` is
  unused in A's state code). B's admission must receive `reserveCapBaseQ`. Phase 2 interface item.
- **A-I10** Acceptance suites are thin: 17 of A's 30 Solidity task suites (A010–A039) contain exactly one test. A027,
  A039 (fuzz) and A040 (invariant) partly compensate.
- **A-I11** A's task evidence records `source_commit 4c52854` and G0 records `worktree_dirty: true`.
  This audit re-ran everything on `ffc9f52` with identical outcomes.
- **A-I12** `AccountingHarness` exceeds EIP-170 (A sets `code_size_limit = 65536` in the risk
  profile). Production composition size is unmeasured; `origin/main` already edits
  `foundry.toml` to a "monad" limit outside this lane.
- **A-I13** A's A032 runner requires `tsc`, which is not installed here. The SDK test passes
  under `tsx`.
- **A-I14** `_pairedFill` installs B's post-fill order aggregates without checking that they did
  not grow (`ClearingCore.sol:92-93`). `_releaseOldReservation` does check (`:149-153`). A wrong
  B aggregate would undercount Dbar silently. Recommend the same monotonic check (A-owned).

## 6. What A built in place of B outputs (Person A's stand-ins for B)

- `contracts/test/mocks/A/MockRiskDecision.sol` — scripted allow/deny for every B decision
  (trade, release, reservation, liquidation, takeover, reserve unwind).
- `AccountingHarness` context (`setContext`) — scripted B price/freshness context.
- Harness `freeze` / `finalPrice` — scripted B halt authentication and settlement price
  (including INVALID).
- A's internal ports B must implement: `_riskContext()` and `_riskAccept(Decision)`
  (`AccountingPort.sol:8-9`).

No provisional copy of B math exists in A's tree.

B's provisional port (`contracts/provisional/IAccountingPort.sol`, `_acct*` functions) and A's
port are different shapes: A exposes posting functions plus two decision hooks; B expected about
20 `_acct*` functions and four A→B hooks. Reconciling them is the main Phase 2 work and is not
judged here.

## 7. Commands (reproduce)

```bash
python -m unittest discover -s reference/tests/a -p "test_a0*.py"
cd contracts && forge test --match-path "test/*/A/*"
cd contracts && FOUNDRY_PROFILE=risk forge test --match-path "test/*/A/*"
bash scripts/check-task.sh A040   # also A041..A044; rewrites A evidence files (restore afterwards)
python -m unittest discover -s reference/tests/audit -t .
cd contracts && forge test --match-path "test/audit/Audit*"            # 41 pass
cd contracts && forge test --match-path "test/audit/findings/*"       # 3 reproducers, all fail by design
```

## 8. Person A resolution addendum — 2026-10-02

The preceding audit is preserved as Person B's historical report on the named 2026-10-01
tree. Its file positions, toolchain, counts and failing-reproducer descriptions are historical.
The implementation now includes the following fixes; all three finding regressions and the
ordered G0-G7 technical checks pass. `artifacts/risk/review-validation.json` records 641 Forge
passes and 217 Python passes. This addendum does not assign a new accepted merge or overwrite
the original audit observations.

| Finding | Implementation in the review working tree | Regression |
|---|---|---|
| A-F01, Medium | `FreezeAccounting._freeze` supports an unactivated funded market by creating a terminal stopped, zero-rate epoch at the authenticated halt. The bridge supplies a scheduled bound before activation and reports the halted accounting state. Scheduled/early halt can proceed through ordinary snapshot, finality, payout and noticed reserve redemption; activation after halt and allocations at/after T are rejected. | [AF01PreActivationLock.t.sol](../../contracts/test/audit/findings/AF01PreActivationLock.t.sol) exercises the real combined A+B engine, including trader and reserve exits after T. |
| A-F02, Low | `PremiumMath.cumulative` accumulates rational sub-interval/outcome charges and applies one ceiling at the cumulative segment boundary. Funding-affine principal, surcharge boundaries and neutral-touch subtraction remain unchanged. | [AF02PremiumRounding.t.sol](../../contracts/test/audit/findings/AF02PremiumRounding.t.sol) requires equality with the cumulative rational vectors; A012/A015 and the affected reference/differential suites must also rerun. |
| A-F03, Low | `ReserveClaims` assigns protocol fees to separate engine `protocolFeeEscrowQ`; reserve rounding stays in `treasuryQ`. `withdrawProtocolFees()` floors whole atoms and retains fractional Q, independently of reserve dust. Both use the existing immutable treasury beneficiary; no new beneficiary-setting authority was introduced. | [AF03ProtocolFeeEscrow.t.sol](../../contracts/test/audit/findings/AF03ProtocolFeeEscrow.t.sol) checks classification/withdrawal; [G6.t.sol](../../contracts/test/gates/G6.t.sol) checks fractional fees through combined settlement. |

**A-I01 remains deferred.** Protocol/keeper fee Q remains recognized within market allocation
until its existing withdrawal/escrow path executes. The A-F03 change separates engine ledger
categories; it does not implement the spec's separate vault-level fee reclassification, nor
claim complete conformance on that point. The shared immutable treasury beneficiary also
remains an explicit deployment choice.

The five A-owned interface requests are implemented: one shared `AccountingState`, A-owned
market-epoch increment, unpaid trader-entitlement counter, a cash-claim fence covering direct
vault payouts, and a reservation replacement port without a repeated B decision. See
[B-to-A-integration.md](../requests/B-to-A-integration.md) and
[interface-reconciliation.md](interface-reconciliation.md).

Additional combined regressions are
[A043IntegrationReview.t.sol](../../contracts/test/reviews/A043IntegrationReview.t.sol) for
freshness gaps, halt epochs and projected accrual/release, and
[AClaimIntegrationReview.t.sol](../../contracts/test/reviews/AClaimIntegrationReview.t.sol) for
successful/failed claims, direct vault calls, cash-mode selection and trader completion.
Counterpart components remain mocks; these changes do not approve a live deployment.

Current local reproduction uses Forge **1.8.3**, matching `.github/workflows/contracts.yml`,
with solc **0.8.30** and the **Prague** EVM selected in `contracts/foundry.toml`:

```bash
cd contracts
FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/audit/findings/*"
FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test --match-path "test/reviews/A*Review.t.sol"
```

The `risk`/`ci` code-size allowance is for oversized local fixtures, including test contracts
that embed multiple engine deployments. It is not evidence of target-chain deployability.

**A-I01 update (2026-10-02, shared ownership):** implemented by 0xr10t: global per-beneficiary vault
fee escrows, exact `allocationQ` reduction at payout-scan completion, floor withdrawals with retained
fractions. Choices and evidence: `docs/questions/A-I01.md`. Pending teammate review; this note does
not close the finding.
