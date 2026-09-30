# Person B — stand-ins, interface guesses and assumptions

Written as work happens, not at the end. Each entry: ID, task, what was assumed, why it is the
conservative spec-consistent choice, and what replaces it at merge. `ASSUMPTION` entries are
open questions for Person A, the counterpart teams or the spec owner.

## Process

- **P-1 (all tasks) Solo mode, user-directed.** The user instructed (chat, 2026-10-01) to build all
  44 B tasks without waiting for G0–G7 merges, using stand-ins for A outputs. This overrides the
  CLAUDE.md "stop at gate" and "stop the task on ambiguity" rules for this session only. Effects:
  no task is marked `accepted` (tasks_B.json statuses are not edited; status lives in
  `B-progress.md`); no gate is marked passed; every result that uses a stand-in or mock says so.
- **P-2 Stand-in locations.** Python stand-ins live in `provisional/` (repo root). Solidity
  stand-ins live in `contracts/provisional/`, because Foundry only allows imports inside the
  project root (`contracts/`) and `contracts/foundry.toml` is A-owned (A002), so `allow_paths`
  cannot be changed by B. Both directories are deleted at merge.
- **P-3 Evidence runner.** `provisional/scripts/b-evidence.sh` runs a task's exact acceptance
  command and writes `docs/merge/B-evidence/<TASK>.json|.log`. It is a stand-in for A002's
  `scripts/check-task.sh`, which does not exist on this branch.
- **P-4 Starter checks.** `python docs/spec/verify_spec_vectors.py`: exit 0, 26 checks passed.
  `python docs/spec/validate_parallel_plan.py`: exit 1, `FileNotFoundError:
  docs/spec/task_migration.json` (the file is not in the packet). Not a B file; reported to the
  spec owner, not fixed. The plan-validation result is therefore **not available**.
- **P-5 Toolchain (open G0 item, nothing chosen by B).** Installed now: forge 1.3.5-stable
  (9979a41, 2025-09-09); CI workflow pins foundry v1.8.3; `foundry.toml` pins solc 0.8.30,
  evm prague; submodules forge-std f3dae6e, solady 2afba69 (initialized this session with
  `git submodule update --init --recursive`). `python` = 3.13.13 (conda) with NumPy 2.5.2;
  `python3` = 3.13.1 with NumPy 2.4.1. Node 18.20.8, npm 10.8.2, no TypeScript compiler.
  Versions are agreed at G0; B only records them.

## Interfaces and counterpart findings

- **I-1 (B001) Book.sol hook set differs from spec §7.5.** Details in
  `docs/counterpart-contracts.md` (no tick on `_onUnrest`, unrest on filled size, no epochs,
  expiry or reduce version, no STOP_TAKER, size unit likely claims not lots). B builds to the spec
  hook set against its own mock book. Live CP-BOOK join is BLOCKED_BY_COUNTERPART.
- **I-2 (B001) `contracts/src/RiskSnapshot.sol`** is a book-team file whose comment says Clearing
  owns its content. It is in neither task list. B does not edit it; B's per-action context is a
  separate struct in `RiskContextPort.sol` (B019). Merge decision: A/B/book agree whether
  `Ctx.risk` becomes the spec §7.2 `RiskSnapshot`.

## Math assumptions

- **M-1 (B001, B005, B011) Displayed leverage** divides by equity. CLAUDE.md forbids dividing by
  x or equity. Choice: leverage is a display-only value computed only when E > 0, returned with an
  `available` flag, and never read by a safety decision. All safety checks compare
  `notional <= L * E` style products instead. ASSUMPTION.
- **M-2 (B001, B007, B013, B035) TWAP rounding** is not stated by the spec (only "rounds to pE18"
  for INVALID). Choice: floor (DOWN) the time integral divided by the window. ASSUMPTION.
- **M-3 (B002, B007, B013, B016) Freshness boundary.** A sample observed at `t` is usable for any
  window end `<= t + 30` (it covers `[t, t+30)`); it is stale for `now > t + 30`. The spec says
  "carries forward only up to its 30-second freshness limit" without the inclusive/exclusive
  edge. Choosing inclusive at exactly 30 s is the only reading where a window ending at `t+30`
  has full measure; one second later is a gap. ASSUMPTION.
- **M-4 (B006, B012, B023) Full-backing switch in order admission.** If either sign's IM envelope
  (at that sign's maximum reachable size) reports `fullBackingRequired`, the whole commitment set
  must satisfy the exact predicate `d0 == 0 && d1 == 0` (A's order-aware deficits incl. fee caps).
  The spec says a full-backing result makes the caller check both exact endpoints; applying it to
  the whole account rather than one side is the conservative reading. ASSUMPTION.
- **S-1 (B006) Coverage port stand-in.** `order_admission.admit` takes endpoint deficits,
  deficit cap and market coverage through a `coverage_port` callable. In tests it is a scripted
  fixture (spec §7.3 formulas for fixed inputs). Replaced at G1 by A004 `reference/a/coverage.py`.
- **M-5 (B009, B014, B028) Grace length and anchor.** The spec says an account between MM and IM
  has a "nonrenewable grace anchored to the risk epoch" but gives no length outside the final
  day. Choice: per-account anchor = `effectiveAt` of the risk epoch in which the account is first
  observed below IM; grace ends at `min(anchor + graceSecs, T - 12h)`; `graceSecs` is a profile
  parameter (fixture 3600 s = one risk epoch). The anchor is cleared only when the account is
  observed at or above IM; touching a deficient account never moves it. Below MM has no grace.
  ASSUMPTION (question for spec owner: grace length).
- **M-6 (B009, B014, B028) Stage precedence.** `CLAIMS_READY > HALTED > REDUCE_ONLY (T-1h or
  monitor) > BACKING_FLOOR > BACKING_GRACE > TRADING`. The monitor flag can make a floor market
  REDUCE_ONLY; the time flags (`fullBackingByTime`, `fundingFrozen`, legacy takeover window) are
  reported separately so REDUCE_ONLY never hides floor rules.
- **S-2 (B010–B015) `contracts/provisional/QMath.sol`** stands in for A009 `contracts/src/math/QMath.sol`.
  Guessed signatures: `mulDivDown`, `mulDivUp` (512-bit via solady `fullMulDiv[Up]`), `divUp`,
  `sqrtDown`, `sqrtUp`, `sDivFloor`, `sDivCeil`, `toInt`, `abs`, `min`, `max`. At merge: delete the
  file, repoint `import {QMath} from "../../provisional/QMath.sol"` to `./QMath.sol`, and rename
  any call whose A name differs. Rerun B010–B015.
- **S-3 (B010 onward) `contracts/provisional/MathTypes.sol`** stands in for A001 `MathTypes.sol`:
  constants `Q`, `WAD`, `PAYOFF_Q_PER_LOT`, `Q_PER_USDC`, tick bounds, and the spec enums `Side`,
  `Stage`, `AccountingState`, `PricingMode`, `FinalOutcome`, `ClearingPhase`, `AdmissionMode`,
  `StepStatus`, `RejectCode`, `RemovalReason` with spec §5.3/§7.2/§8.1 member order. At merge use
  A's declarations; any member-order difference changes ABI and must be reconciled at G0.
- **M-7 (B010) eps' floor.** With wad inputs, `eps - a_adv >= 1 wei` so `floor((eps-a) WAD/(WAD-a)) >= 1`;
  the "eps' rounds to 0" branch is kept but is unreachable. A tiny eps' gives a huge k and the
  margin's worst-loss cap then yields full backing.
- **T-1 (B010, B015) Differential tolerance.** Solidity upper bounds must be `>=` the reference
  upper bracket and exceed it by at most `max(1e3 wad, 1e-12 relative)`.
