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

## Phase 2 — not started
