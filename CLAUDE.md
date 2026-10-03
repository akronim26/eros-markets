# CLAUDE.md — Eros Markets Risk & Clearing (shared ownership)

Put this file at the repository root. Claude Code reads it at the start of every session.

## Who you are working for
You are the coding agent for one of the two developers of the Risk & Clearing team for Eros Markets / EventPerp (Paper 1 only). Both developers own every Risk & Clearing file and work on one shared branch, one turn at a time (see "CURRENT MODE"). The order book (1 person) and the three-layer resolution oracle (2 people) are separate teams; price feed and factory/registry are counterparts too.

## CURRENT MODE: shared, turn-by-turn
- One shared working branch: `integration/risk`. Both teammates' agents work only there. `main` is updated only by an explicit merge that a human asks for.
- Start of every turn: `git fetch`; check that the working tree is clean; fast-forward or rebase onto the latest shared branch; read `docs/merge/STATUS.md` (especially the last Turn log entry). If the remote moved during your turn, integrate before pushing. Never force-push or rewrite pushed history.
- One turn at a time. If the last Turn log entry says the other person is mid-turn, stop and tell the human.
- Anyone may edit any Risk & Clearing file. Commit messages say what changed and cite the item ID (A-I01, B-D02, G4, etc.).
- Review rule: work that changes economic behavior (accounting, funding, premium, coverage, liquidation, settlement, custody) is reviewed by the teammate who did NOT make it, on their next turn. The reviewer refreshes review fingerprints. An agent never writes fingerprints or approvals for its own changes.
- Any source change: rerun the affected gates and tests, and list them in the Turn log.
- End of every turn: update `docs/merge/STATUS.md` (item statuses plus a new Turn log entry: who, what, commits, tests run with exit codes, open questions, next turn), commit, push.
- Gate acceptance (G7 and later) is recorded only by a human. Never by an agent.
- Never edit other teams' internals; write requests in `docs/requests/`.

Current state, open items and the turn log: `docs/merge/STATUS.md`.

## Source of truth (in this order)
1. `docs/spec/risk_spec.md` (spec v1.1, economic baseline v1.0). Sections 1–5 and the math-first plan (section 10) are mandatory reading before any edit.
2. `docs/spec/integration_gates.json`, `docs/spec/gate_status.json`; open items in `docs/merge/STATUS.md`.
3. `docs/spec/book_interface.md`, `docs/spec/oracle_interface.md` (counterpart contracts).
4. `docs/spec/implementation_plan.md` (module map; its A/B ownership column is historical, see below).

The selected decisions DEC-01 to DEC-14 are closed. Do not reopen them.

Optional background: `docs/background/full-risk-analysis.pdf` ("Binary event perpetuals: corrected theory, risk mathematics, and contract requirements"). It is the upstream proof document the spec was built from. Use it only to understand *why* a rule exists and to borrow adversarial test cases. It is **not** a requirements list: where it leaves a choice open (product modes, ADL, haircut rules, funding design options), the spec's DEC rules have already chosen. Notation map: its `b` = spec cash `c` (cashQ), its `z` = spec signed position `n`/`x` (positionLots), its `U_y` / `D_y` bound = spec `Dbar_y`, its `R` = reserve outcome value `R_y`. If it seems to contradict the spec, the spec wins; log the difference in `docs/questions/`.
The master document (`Eros_Markets_Master.pdf`, 305 tasks, conflict register C01–C46) is **historical context only**. Never implement an alternative from it (for example D's 6-hour floor, dual-index liquidation, insurance-fund cash bad debt, 0.5 INVALID, whole-unit sizes). **Task IDs collide:** master "B001 Freeze payoff and market semantics" is NOT the packet's B001; packet task IDs mean `tasks_A.json` / `tasks_B.json`.

## Historical: per-person lanes (kept for traceability, no longer binding)
- `docs/spec/tasks_A.json` and `docs/spec/tasks_B.json` (A001–A044, B001–B044), their `write_files` limits, the Person A / Person B ownership columns in `docs/spec/implementation_plan.md` and `docs/ownership.json`, and the `fix(A)` / `fix(B)` commit prefixes describe how the two lanes were built and merged. Keep the files; do not delete them. Do not use them to restrict who edits what.
- Lane records: `docs/merge/B-*.md`, `RISK_PROGRESS.md`, `docs/merge/A-audit.md`, `artifacts/reviews/A-on-B.md`, `artifacts/reviews/B-on-A.md`, `docs/merge/integration-progress.md`.

## What you may edit
- Any Risk & Clearing file (contracts under `contracts/src/{math,risk,pricing,settlement,vaults,engine,interfaces}`, their tests, `reference/`, `scripts/`, `packages/risk-sdk/`, `docs/`, `artifacts/`), following the CURRENT MODE rules (item IDs in commits, cross-review of economic changes, gates/tests rerun).
- Never edit the order-book, oracle, price-feed or factory teams' internals (for example `contracts/src/Book.sol`, `contracts/src/RiskSnapshot.sol`, book tests and `contracts/snapshots/BookGas.json`). Write requests in `docs/requests/` instead.
- Never implement the CLOB, Kuru/CRE fetching, AI panel, committee or UMA logic. Build their interfaces and deterministic mocks only.
- Mocks are scripted doubles of an agreed interface. They must not re-implement counterpart economic logic.

## How to do one work item
1. Pick an open item from `docs/merge/STATUS.md` (or the one the human names). If it depends on another team or on human acceptance, stop and report.
2. Read the item's spec sections and the existing evidence.
3. Tests first. Reference expected values must be derived independently (hand arithmetic, spec worked examples, `Fraction`). Never call Solidity from Python to produce an expected value.
4. Implement. Run the affected gates (`bash scripts/check-gate.sh Gn`) and tests. If a command or tool does not exist, the item stays unverified; say so.
5. Record evidence: item ID, commit, spec/interface version, command, exit code, seeds/fixtures, real-vs-mock component status.
6. Commit on the shared branch with the item ID in the message; update STATUS.md; push. Then stop and summarize.

## Gates (G0–G7)
- Gates are recorded in `docs/spec/gate_status.json`. Technical checks may be run by anyone; acceptance (G7 and later) is recorded only by a human.
- Never mark a blocked item done. Never manufacture a merge SHA or another person's review.
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
- If the spec is ambiguous, write the question to `docs/questions/<item>.md`, pick nothing silently, and stop that item.
- Production/mainnet deployment is not authorized. The user's controlled Monad testnet evaluation
  authorization of 2026-10-03 is recorded in `docs/integration/RISK_BOOK_TRACKER.md`; it does not
  grant production release, gate acceptance or permission to broaden the deployment scope.

## End-of-session report (always)
Items attempted; status of each (done / unverified / blocked, and why); commands run with exit codes; files changed; open questions; what is needed from the teammate, a counterpart team or a human; next turn.
