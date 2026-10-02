# Risk & Clearing integration progress (A + B)

Branch: `integration/risk`, cut from `origin/feat/clob`. `feat/risk` and Person A's work are
never rewritten or force-pushed. Commits on this branch are plain commits from the user's git
identity (no co-author trailer).

## Step 0 — orientation record (2026-10-01)

### Branch heads

| Ref | SHA | Note |
|---|---|---|
| `origin/feat/clob` (base) | `5cbd0cb` "docs: note configurable fill bound" | integration/risk starts here |
| `origin/feat/risk` / `feat/risk` | `ffc9f52` "merging the risk work" | merge commit, parents B `fecd2fb` + A `61be284` |
| Person B lane tip | `fecd2fb` "docs: B progress final status" | B001–B044 |
| Person A lane tip | `61be284` "test(risk): finish A invariant campaigns and accounting handoff evidence" | A001–A044; Person A used `feat/risk` too, no separate branch |
| merge-base(feat/clob, feat/risk) | `3cfa48d` | |
| merge-base(A tip, B tip) | `3cfa48d` | |
| `origin/main` | `c5db208` | contains `ffc9f52` (merged by the book developer in `494dc72`) plus `253ebd5`, `2db4e08`, `c5db208` — see risks |

`feat/clob` has 2 commits not in `feat/risk` (`ff05f0c` "feat: make fill bound configurable",
`5cbd0cb` docs). `feat/risk` has 115 commits not in `feat/clob`.

### Toolchain (installed, recorded, not chosen)

| Tool | Version |
|---|---|
| python (`python`, conda) | 3.13.13 |
| python3 (`python3`) | 3.13.1 |
| forge | 1.3.5-stable (`9979a41`) — CI pins 1.8.3; nothing here ran on 1.8.3 |
| solc | 0.8.30 (svm; `foundry.toml` `solc_version = "0.8.30"`, `evm_version = "prague"`) |
| Solady | `2afba69` (v0.1.26-36), submodule pin identical on feat/clob, feat/risk, main |
| forge-std | `f3dae6e` (v1.17.0) |
| node | 18.20.8; `tsc` not installed; cached `tsx` 4.20.6 used for TS tests |

Person A recorded Python 3.12.10 and forge 1.5.1. Toolchain agreement remains an open G0 item.

### Documents read

- `CLAUDE.md` in full. **It has no "CURRENT MODE: integration" section** on feat/risk,
  feat/clob or main. The integration rules in the user's 2026-10-01 instruction are followed instead.
- `docs/spec/risk_spec.md` sections 1–5, 10–11 in full; sections 6–7 (book/oracle seams) from
  the B lane work and spot reads.
- `docs/spec/tasks_A.json`, `tasks_B.json`, `integration_gates.json`, `gate_status.json`
  (all gates `not_started`, `merge_sha: null`).
- B lane: `docs/merge/B-progress.md`, `B-assumptions.md`, `B-merge-guide.md`, `B-checkpoint-G0..G7.md`.
  `docs/questions/` does not exist (no open B questions files).
- A lane: `RISK_PROGRESS.md`, `artifacts/tasks/A001..A044.json`, `artifacts/validation/{A-final,W0}.json`,
  `artifacts/gates/G0.json` (blocked, not accepted), `artifacts/reviews/A-on-B.md` (pending),
  `docs/implementation/{authority,backlog}.json`, `docs/runbooks/accounting.md`.

### Stand-ins found

- B's: `contracts/provisional/{QMath,MathTypes,IAccountingPort}.sol`, `provisional/scripts/*`,
  `contracts/test/mocks/B/*`, scripted coverage in `RiskHarness`/`BookSeam` (see `B-merge-guide.md` §1).
- A's (stand-ins for B outputs): `contracts/test/mocks/A/MockRiskDecision.sol` (scripted B
  decisions), harness context/freeze/finalPrice (scripted B price, halt and finality),
  `MockUSDC`. No provisional files in A's `src/`; no copy of B math.
- Port shapes differ: A exposes posting functions plus `_riskContext()` / `_riskAccept(Decision)`;
  B expected ~20 `_acct*` functions and four A→B hooks. Main Phase 2 reconciliation item.

### Integration risks noted before merging

1. `origin/main` `253ebd5` (book developer) reformatted 11 B-owned sources and the generated
   `contracts/test/math/B/RiskDifferential.t.sol`; `2db4e08`/`c5db208` edited A-owned
   `contracts/foundry.toml` ("monad size limit"). Not on feat/clob; integration/risk does not
   include them. Merging integration/risk into main later will conflict with these edits.
2. B's Book.sol hook mismatch (I-1, I-10) and A's note on book uint96 sizes / 8-bit generation.
3. `validate_parallel_plan.py` still needs `docs/spec/task_migration.json` (P-4).

## Phase 1 — audit of Person A's lane (read-only)

How it ran: the user declined extra git worktrees, so the audit ran in the main checkout on
`feat/risk` at `ffc9f52` (A's files byte-identical to `61be284`). A's tracked evidence that
A's runner rewrites (`artifacts/tasks/A040..A044.json`, `artifacts/acceptance/A04*.json`,
`artifacts/risk/*.json`) was restored with `git checkout -- artifacts` after each run. New audit
files were created untracked there and committed on `integration/risk`. They import A's code and
compile only once Phase 2 brings A's modules onto this branch.

Results (full detail in `docs/merge/A-audit.md`):

| Command | Exit | Result |
|---|---:|---|
| 44 exact `acceptance_command`s of tasks_A.json | 0 for 43, 2 for A043 | A001–A015 verified; A016–A042, A044 mock-only (B scripted); A043 blocked (peer review pending) |
| `forge test --match-path "test/*/A/*"` (default and `FOUNDRY_PROFILE=risk`) | 0 | 53/53 |
| `python -m unittest discover -s reference/tests/a -p "test_a*.py"` | 0 | 42/42 |
| `bash scripts/check-task.sh A032` | 2 | `tsc` missing locally; SDK reader passes under `tsx` (exit 0) |
| `python -m unittest discover -s reference/tests/audit -t .` | 0 | 8/8 incl. `verify_spec_vectors.py` 26/26 |
| `forge test --match-path "test/audit/Audit*"` | 0 | 41/41 |
| `forge test --match-path "test/audit/findings/*"` | 1 | 3 reproducers fail by design (A-F01..A-F03) |

Findings: Critical 0, High 0, Medium 1 (A-F01), Low 2 (A-F02, A-F03), Info/needs-confirmation 14.

**STOP after Phase 1** (user instruction). Phase 2 starts only after the user says "go".

## Phase 2 — merge and gates (user said "go", 2026-10-01)

| Step | Commit | Result |
|---|---|---|
| Merge A lane `61be284` | `8cc0be2` | no conflicts |
| Merge `feat/risk` `ffc9f52` | `8f98985` | no conflicts (no file overlap; the 2 newer `feat/clob` book commits were already in the base) |
| Remove provisional stand-ins; rewire to A QMath/MathTypes (R-01, R-02) | `73ecb17` fix(B) | forge 518 pass / 8 BookGas fail (local forge 1.3.5 lacks a cheatcode the book's gas test uses; book-owned, pre-existing on feat/clob); RiskDifferential regenerates byte-identical |
| Adapt B to A's real interface (R-05, R-07, R-09, R-15) | `af1643f` fix(B) | B 317/317 |
| Compose A+B: `RiskAccountingBridge`, CombinedEngine harness, smoke | `41e32ec` | smoke passes: bootstrap fill, rollover into NORMAL_PRICING, direct 5x posted by A |
| G0 record + test | `966444d`, `8f564c8` | `bash scripts/check-gate.sh G0` exit 0 (checks_passed) |
| fix(A) runner path | `90e7518` | check-gate.sh now reads docs/spec/gate_status.json |
| G1 | `9c55836`, `c69264f` | technical checks passed; official runner exit 2 ("previous gate has no reviewed accepted commit": Person A has not reviewed) |
| G2 | `c190774`, `ce43245` | technical checks passed; official runner exit 2 (same reason) |

| G3 storage + context | `c1d241c`, `84c0864` | technical passed; official exit 2 (A review) |
| G4 trading with accrual | `d01f0ee`, `9dc2084` | technical passed; official exit 2 (A review) |
| G5 liquidation + freeze | `c236e5e`, `52ff05e` | technical passed; official exit 2 (A review). A032 runner needs `tsc`: run with a locally installed TypeScript 5.9.3 (`/Users/sohamvijay/Desktop/Capsule/node_modules/typescript`) on PATH; no repo pin |
| G6 resolution to cash | `ec5a22b`, `819ff2a` | technical passed; official exit 2 (A review) |
| G7 | — | needs W7 inputs (Phase 3): B040–B044 are not configured in A's `scripts/check-task.sh`; A043 (A's review of B) can only be done by Person A |

Gate review: A's runner requires the previous gate to be reviewed by A and B. Person A has not
reviewed anything; gates are recorded with `reviewed_by: ["B"]`, `review_pending: ["A"]`, and
the official runner result is kept in each `artifacts/gates/Gn.json` next to the technical
result (`scripts/integration/gate-record.py`). Once Person A reviews, rerun
`bash scripts/check-gate.sh Gn` in order.

## Phase 3 — complete the layer (2026-10-01)

| Step | Commit | Result |
|---|---|---|
| Invariant campaign INV-01..INV-10 on CombinedEngine | `a2af6a8` | random: risk 48×64 and ci 256×128, 9/9 pass, 0 reverts, no counterexample; seeded 24 seeds × (64 actions + settlement), every invariant after every step. Book-close reductions did not occur in random runs (covered by G5). `artifacts/risk/invariant-campaign.json` |
| §11 minimum end-to-end scenario | `95213ba` | 5/5 pass: NO (halt mid-rollover, pages 1, reverse claims), YES (halt at T, pages 32), early INVALID TWAP (pages 7), early INVALID fallback (pages 3, reverse), step-6 shortfall fixtures |
| Gas (forge EVM, Ethereum/Prague schedule; not Monad) | `f05f076` | 24 entry points, `artifacts/risk/gas-engine.json` |
| Counterparts | `4a848c4` | Book.sol present: 10 exact hook mismatches, fixtures not runnable (`docs/requests/B-to-book-hooks.md`); oracle, price collector, factory absent: BLOCKED_BY_COUNTERPART |
| Release manifest (local fixture, no deployment) | `cb36161` | defaults tested (`test/integration/ReleaseDefaults.t.sol`); `artifacts/risk/release-manifest.json` |
| fix(A) runner B040–B044 | `ea2140f` | B040–B044 pass through A's `scripts/check-task.sh` |
| B043 review of A, B042 SDK on A032 | `3f5b030` | COMPLETE: 19 routes with results; no Critical/High |
| HANDOFF + ABIs | `3089a1a` | `docs/risk/HANDOFF.md`, `artifacts/risk/{engine,vault}-abi.json` |
| G7 | `bdc9cd5`, `8f11beb` | blocked only on A043 (Person A's review of B, Person A only) |

Final regression on integration/risk: forge 609 pass, 8 fail (book-owned `BookGas.t.sol`, local
forge 1.3.5 lacks cheatcode 0x04eedcdf; same on feat/clob); audit finding reproducers 3/3 fail by
design; Python A 42, B 156, audit 8, integration 7 OK.

Nothing pushed. `origin/main` still has the book developer's edits to B sources and A's
`foundry.toml` (`253ebd5`, `2db4e08`, `c5db208`); merging integration/risk into main will conflict
there.

### Resume point (if a new session starts)

Remaining work needs other people: Person A's reviews (G0–G6 `review_pending`, A043), the book
team's seam (docs/requests/B-to-book-hooks.md), the oracle/price/factory implementations, the
production inputs in `artifacts/risk/release-manifest.json`, and toolchain agreement. Open audit
findings A-F01 (Medium), A-F02/A-F03 (Low) are A-owned.

## Phase 4 — Person A review and repairs (2026-10-02)

The earlier resume point and counts are historical. The user requested a full
history report first; that report is `docs/merge/history-review-2026-10-02.md`.
The working branch remains `integration/risk`, based on `71576ed`.

| Task | Commit | Outcome |
|---|---|---|
| Source-bound review tooling and CI-compatible fixtures | `2790663` | Real A043 checks replace the permanent pending stub; G1 runs the combined reference; Windows SDK runner repaired |
| A-F02 exact premium ceiling | `0820afa` | Exact rational accumulation and regression/fuzz coverage |
| Immutable listing profile constraints, A-B08 | `034ebab` | Reject incompatible cap/template configuration; five regression tests |
| Accounting ports, lifecycle and settlement | `c543434` | Five requested A ports; A-F01/A-F03; freshness and frozen epoch repairs; actual claim callbacks/counters |
| Admission, projections and actual fee reporting | `ec14175` | A-B03 through A-B07 repaired with maker/taker, preview and fee regressions |
| Production ABI exports and portable source fingerprints | `74b9f16` | No mock constructor/book methods; canonical-LF dependency/review hashes |
| A043, gate evidence and handoff | This evidence commit | Completed review, fresh validation and retained limitations |

Official G0-G7 commands pass in order on Forge 1.8.3. A043 passes 37 review tests.
The complete risk-profile Forge suite passes 641 tests with no failures, including
all BookGas and audit-finding tests. Python A/B/audit/integration pass 46/156/8/7.
See `artifacts/risk/review-validation.json` for per-suite counts, execution
provenance and the exact toolchain. Earlier gas and CI invariant measurements
remain historical; they are not relabeled as fresh measurements.

### Current resume point

Person B must review the new delta before G7 receives coordinator acceptance and
an accepted merge SHA. A-F01/A-F02/A-F03 and A043 are no longer open. A-I01's global
vault fractional-fee classification remains deferred and explicitly disclosed.
The real book seam, oracle/price/factory implementations, production calibration,
target-chain size/gas and main-branch conflict reconciliation remain separate.
No book code was changed, no deployment occurred, and no review commits were pushed.
