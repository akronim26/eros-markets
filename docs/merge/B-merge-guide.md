# Person B merge guide (feat/risk -> integration with Person A)

Spec v1.1, economic baseline v1.0. All 44 B tasks were built in user-directed solo mode (P-1)
without any recorded gate. **No gate is passed.** Every B result used B stand-ins for Person A
and mocks for the counterpart teams. Use this guide when the two lanes merge.

## 1. Provisional files and what replaces them

| Provisional file (B) | Replaced by (Person A) | Merge action |
|---|---|---|
| `contracts/provisional/QMath.sol` | A009 `contracts/src/math/QMath.sol` | delete; rewrite imports `../../provisional/QMath.sol` -> `./QMath.sol` (math) or `../math/QMath.sol`; rename any call whose A name differs (S-2) |
| `contracts/provisional/MathTypes.sol` | A001 `contracts/src/math/MathTypes.sol` | delete; rewrite imports; reconcile enum member order (ABI) at G0 (S-3) |
| `contracts/provisional/IAccountingPort.sol` | A021 `AccountingPort.sol`, with A022–A038 behind it | delete; map every `_acct*` function to A's real name (table in §2); B modules then inherit A's port |
| `contracts/test/mocks/B/MockAccountingPort.sol` | real A modules in gate/integration tests | keep for B unit tests; replace in G3–G7 joint suites (S-6) |
| `FormulaCoverage`, `MarketCoverage` (test scripts in `RiskHarness.sol`, `BookSeam.t.sol`) | A019 `ReserveAccounting` / A013 `CoverageMath` via `_acctCoverage` | drop when A's port answers coverage (S-1) |
| `provisional/scripts/check-task.sh` | A002 `scripts/check-task.sh` | delete; rerun B040–B044 with A's runner |
| `provisional/scripts/b-evidence.sh`, `b-task.sh` | A002 runners / CI | delete after merge (evidence history stays in `docs/merge/B-evidence/`) |
| `packages/risk-sdk/src/index.ts` `AccountingFields` | A032 `packages/risk-sdk/src/accounting.ts` | replace the provisional interface with A's export (S-13) |
| `_feeCapQ`, `_tradeFeeQ` (zero) in `OrderAdmission` / `BookRiskAdapter` | A013 `FeeMath` | override in the composed engine (S-8) |
| `MockBookAdapter._mockPlaceWithMode` used by `_liqSubmitIoc` | CP-BOOK internal IOC entry | book team must expose an equivalent (I-10) |

Files importing a provisional path (rewrite at merge): every `contracts/src/math/*.sol` B library,
every `contracts/src/{pricing,risk,settlement}/*.sol` B module, `contracts/src/interfaces/
{IBookRiskHooks,IResolutionIngress}.sol`, and the B test/mocks. `grep -rl provisional/ contracts/src contracts/test`
lists them (51 files at hand-off; build output under `contracts/out` also matches and is ignored).

## 2. Accounting-port functions B calls (A must provide)

| B call | A task | Called from |
|---|---|---|
| `_acctBeginAction()` | A026 | `BookRiskAdapter._riskBeginAction` |
| `_acctTouch(trader)` | A024 | `BookRiskAdapter._touch` (once per account per action) |
| `_acctAccount(trader)` (virtually settled, S-9) | A016/A021 | everywhere |
| `_acctCoverage(trader, sums, dCash, dLots)` | A019/A013 | admission, preflight, recheck, previews, pair |
| `_acctReplaceContribution(trader, sums)` | A019 | `OrderRisk`, permits |
| `_acctPostFill(delta)` | A018/A026 | fills |
| `_acctAccountingState()` | A025 | gates |
| `_acctBumpAccountOrderEpoch`, `_acctBumpMarketOrderEpoch`, `_acctMarketOrderEpoch` | A016 | cancel-all, invalidation |
| `_acctProjectedAccrual` | A022/A023 | previews |
| `_acctTakeover(auth)` | A028 | floor sweep, liquidation |
| `_acctPostLiquidationFill(delta, fee, keeper)` | A029 | pair and book liquidation |
| `_acctFloorBegin/TraderAt/Complete`, `_acctAccountCount` | A031/A016 | floor sweep (S-10) |
| `_acctFreeze(haltAt, cutoff)`, `_acctEpochBounds()` | A030/A025 | halt (S-11) |
| `_acctPrepareSnapshotChunk`, `_acctPreparePayoutChunk`, `_acctFinishPreparation` | A034/A035/A036 | settlement controller |
| `_acctClaimsComplete`, `_acctAnyCashClaim`, `_acctAllFullyBackedAtHalt` | A037/A034 | phases, conversion fence |

Hooks A must call into B: `_riskEpochOpenedWithGuards()` at each completed epoch (A025, S-4);
override `_onFreshnessAdvance(old)` (A022, S-7); `_riskReleaseDecision(...)` before every release
(A017, I-7); `_riskBeforeCashClaim()` before the first cash payout (A037, S-12). The expected call
sequence for one fill is in I-9.

## 3. Every assumption (detail in `docs/merge/B-assumptions.md`)

Process: P-1 solo mode; P-2 stand-in locations; P-3 evidence runner; P-4 starter checks
(`task_migration.json` missing); P-5 toolchain recorded, not chosen; P-6 formatter scope; P-7 cached
`tsx` used only to run SDK tests.

Interfaces / counterparts: I-1 Book.sol hook set differs; I-2 `RiskSnapshot.sol` not edited; I-3
observation signature envelope; I-4 perp observations from own book; I-5 oracle enum values (VOIDED
= 4 guessed); I-6 listing field additions; I-7 release decision port; I-8 epoch staleness reported
by Risk; I-9 G4 call sequence; I-10 liquidation IOC entry on the book.

Stand-ins: S-1 coverage port; S-2 QMath; S-3 MathTypes; S-4 epoch-opening hook; S-5 accounting
port; S-6 accounting double; S-7 freshness hook; S-8 fee functions; S-9 virtually settled views;
S-10 floor port; S-11 settlement-side views; S-12 cash-claim hook; S-13 SDK accounting fields.

Math / policy: M-1 display leverage only for E > 0; M-2 TWAP floors; M-3 freshness boundary
inclusive at 30 s; M-4 full-backing switch applies to the whole commitment set; M-5 grace length
3,600 s anchored to the risk epoch (question for spec owner); M-6 stage precedence; M-7 eps' floor
branch unreachable in wad; M-8 wad-second horizon; M-9 bootstrap band 0.05 (listing parameter); M-10
mark only in NORMAL_PRICING; M-11 pro-rata fee-cap attribution; M-12 freshness latch per epoch;
M-13 movement restriction cleared by monitor; M-14 reduce-only admission; M-15 bootstrap/final-day
exact predicate; M-16 usable-release search; M-17 maker vs global preflight; M-18 maker readmission
scope; M-19 liquidation fee/posting; M-20 halt bumps book epoch. Tolerance: T-1.

## 4. Task status at hand-off

- Lane-pass (exact acceptance command exit 0, with stand-ins/mocks): B001–B039.
- needs-merge (the exact command `bash scripts/check-task.sh B0xx` exits 127 because A002's
  runner does not exist; the provisional runner exits 0): B040, B041, B042, B044.
- blocked: **B043** — no Person A code to review; the review lists 19 routes with reproducers, all
  NOT RUN; the provisional runner exits 1 by design until the review is redone on merged code.
- Intermediate failures that were fixed and rerun (rows kept in `B-progress.md`): B010 test
  arithmetic, B025 revival scenario, B027 maker-vs-global preflight (real defect, M-17/M-18).

## 5. Order of combined checks after merging (G0 -> G7)

Run each on an `integration/wN` branch from the previous recorded gate SHA; fix through file owners;
record the SHA in `docs/spec/gate_status.json` only after both reviewers agree.

1. **G0** — `B-checkpoint-G0.md`: unit/enum/domain reconciliation of A001 MathTypes/units with
   `docs/math/risk-function-contracts.json`; toolchain pins (P-5); `bash scripts/check-gate.sh G0`.
2. **G1** — `B-checkpoint-G1.md`: combined reference trace (A ledger/coverage/funding/premium/
   payoff + B reference); swap the scripted coverage port for A004 in `test_b006.py`.
3. **G2** — `B-checkpoint-G2.md`: delete provisional QMath/MathTypes, rewrite imports, run
   `test/math/**` and regenerate `RiskDifferential.t.sol` (`python reference/b/export_vectors.py`
   must leave it byte-identical).
4. **G3** — `B-checkpoint-G3.md`: replace `MockAccountingPort` with A's port in a joint harness;
   allocate, feed, open epoch, release decisions.
5. **G4** — `B-checkpoint-G4.md`: rerun `BookSeam.t.sol` against real A; verify the I-9 sequence.
6. **G5** — `B-checkpoint-G5.md`: rerun B030–B033 against real takeover/fee/freeze/floor modules.
7. **G6** — `B-checkpoint-G6.md`: rerun B034–B039 against real snapshot/payout/claims; then
   **redo B043** on the merged code.
8. **G7** — `B-checkpoint-G7.md`: rerun B040–B042, B044 with `bash scripts/check-task.sh`; update
   `artifacts/risk/counterpart-status.json` only with real counterpart results.

## 6. Known risks to look at during merge

- CP-BOOK hook mismatch (I-1, I-10): the real `Book.sol` cannot host B's hooks without an agreed
  adapter or book changes.
- Gas: the 64-node dirty traversal measured 22.1M gas with the mock book's linear scan; B's
  per-maker readmission (margin with square roots, coverage calls) is part of it. Measure again
  with the production book and A's port before setting `MAX_FILLS`.
- Formatter: B files are formatted with local forge 1.3.5; CI pins 1.8.3 (`forge fmt --check`
  may differ). Run the pinned formatter on B paths only.
- `validate_parallel_plan.py` cannot run until `docs/spec/task_migration.json` is supplied.
