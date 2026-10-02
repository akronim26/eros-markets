# CLAUDE.md — Eros Markets Risk & Clearing, Person B lane

Put this file at the repository root. Claude Code reads it at the start of every session.

## Who you are working for
You are the coding agent for **Person B** of the two-person Risk & Clearing team for Eros Markets / EventPerp (Paper 1 only). Person A is a different developer (possibly with their own agent) working in a separate worktree. The order book (1 person) and the three-layer resolution oracle (2 people) are separate teams.

## Source of truth (in this order)
1. `docs/spec/risk_spec.md` (spec v1.1, economic baseline v1.0). Sections 1–5 and the math-first plan (section 10) are mandatory reading before any edit.
2. `docs/spec/tasks_B.json` (your 44 tasks), `docs/spec/integration_gates.json`, `docs/spec/gate_status.json`.
3. `docs/spec/book_interface.md`, `docs/spec/oracle_interface.md` (counterpart contracts).
4. `docs/spec/implementation_plan.md` (ownership map, pull stops).

The selected decisions DEC-01 to DEC-14 are closed. Do not reopen them.

Optional background: `docs/background/full-risk-analysis.pdf` ("Binary event perpetuals: corrected theory, risk mathematics, and contract requirements"). It is the upstream proof document the spec was built from. Use it only to understand *why* a rule exists and to borrow adversarial test cases. It is **not** a requirements list: where it leaves a choice open (product modes, ADL, haircut rules, funding design options), the spec's DEC rules have already chosen. Notation map: its `b` = spec cash `c` (cashQ), its `z` = spec signed position `n`/`x` (positionLots), its `U_y` / `D_y` bound = spec `Dbar_y`, its `R` = reserve outcome value `R_y`. If it seems to contradict the spec, the spec wins; log the difference in `docs/questions/`.
The master document (`Eros_Markets_Master.pdf`, 305 tasks, conflict register C01–C46) is **historical context only**. Never implement an alternative from it (for example D's 6-hour floor, dual-index liquidation, insurance-fund cash bad debt, 0.5 INVALID, whole-unit sizes). **Task IDs collide:** master "B001 Freeze payoff and market semantics" is NOT your B001. Your task IDs always mean `tasks_B.json`.

## What you may edit
- Only the `write_files` listed on the task you are currently doing, plus Person-B-owned modules for bug fixes that name the task/gate.
- Never edit Person A files (`reference/a/`, `reference/common/`, `MathTypes.sol`, QMath, Ledger/Funding/Premium/Coverage/Fee/Settlement math, vaults, storage, AccountingPort, ClearingCore, snapshot/payout/claims, `scripts/check-*.sh`, `contracts/foundry.toml`). If you need a change there, write it up in `docs/requests/B-to-A-<topic>.md` and stop that thread.
- Never implement the CLOB (except owner-directed book work, below), Kuru/CRE fetching, AI panel, committee or UMA logic. Build their interfaces and deterministic mocks only.
- Mocks are scripted doubles of an agreed interface. They must not re-implement peer economic logic.

## Book lane (repository owner)
The repository owner also owns the order book: `contracts/src/Book.sol`, `contracts/src/RiskSnapshot.sol`, `contracts/test/Book*.sol`, `contracts/snapshots/BookGas.json` and `contracts/README.md`. Book work the owner directs in a session may edit those paths. The book must meet `src/interfaces/IBookRiskHooks.sol` and `docs/spec/book_interface.md`; every other rule here still applies.

## How to do one task
1. Pick the lowest-numbered `not_started` task in `tasks_B.json` whose `depends_on` are all accepted (tasks accepted, gates recorded with a merge SHA in `gate_status.json`). If none, stop and report.
2. Read the task's `action`, `read_contract`, `source` and `acceptance`, and the spec sections they cite.
3. Tests first. Reference (W1) expected values must be derived independently (hand arithmetic, spec worked examples, `Fraction`). Never call Solidity from Python to produce an expected value.
4. Implement. Run the task's exact `acceptance_command`. If the command or tooling does not exist yet, the task stays unverified; say so.
5. Record evidence in the task's artifact/test path: task ID, commit, spec/interface version, command, exit code, seeds/fixtures, real-vs-mock component status.
6. Commit on your own branch with the task ID in the message. One task per commit series. Then stop and summarize.

## Gates (G0–G7) are hard stops
- After finishing the last B task before a gate, STOP. Do not start the next block until `gate_status.json` shows that gate `passed` with a recorded `merge_sha`, and you have been told to rebase/branch from that SHA.
- While waiting, only do the gate's listed `safe_while_waiting` work. Never mark a blocked task done.
- No stateful vault/feed/clearing/lifecycle code before G2 passes.
- A mock-only pass never counts as a live counterpart pass. Report counterpart status as PASS or BLOCKED_BY_COUNTERPART.

## Math and units rules (non-negotiable)
- Q = one USDC atom × 1e18; 1 lot = 0.001 claim; tick 1..999 = price tick/1000; `PAYOFF_Q_PER_LOT = 1000*Q`; E0 = c, E1 = c + 1000Q·n. Do not divide by WAD twice.
- Pure risk formulas use claims/USDC/days; convert explicitly at the kernel boundary.
- No floating point anywhere in reference or contracts. Reference uses Python `fractions.Fraction`; square roots and other irrational bounds use integer/interval methods with directed rounding (stdlib `decimal` with explicit ROUND_CEILING/ROUND_FLOOR, or exact integer isqrt) unless G0 records another library.
- Requirements, hazards, k, adverse probabilities round UP; epsilon' and usable assets/payouts round DOWN. Any domain failure (a0+a1>=1, adverse>=epsilon, epsilon' rounds to 0, missing/expired calibration) returns `fullBackingRequired`.
- Never divide by x or by equity. x = 0 returns zero margin.
- Checked arithmetic, explicit signed floor/ceil helpers; truncation toward zero is not a rounding policy.

## Honesty rules
- Never invent calibration inputs, addresses, command output or test results.
- A failed invariant stays failed until fixed. Do not weaken a test to make it pass.
- If the spec is ambiguous, write the question to `docs/questions/B-<task>.md`, pick nothing silently, and stop that task.
- No deployment of any kind is authorized.

## End-of-session report (always)
Tasks attempted; status of each (accepted / unverified / blocked, and why); commands run with exit codes; files changed; open questions; what is needed from Person A or a counterpart; next task.
