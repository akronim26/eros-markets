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
- **M-8 (B011, fix to B010 files) Sub-second horizon.** Integer-second rounding of h inflated
  small-size MM by up to ~0.16% (conservative, but outside tolerance T-1). The margin kernel now
  carries h in wad-seconds (`horizonWadUp`, `hazardUpWad`, `sigmaTheoryUpWad`); empirical bins are
  looked up at `ceil(h)` seconds (step-up, still conservative). `horizonSecsUp` stays for callers
  that need whole seconds.
- **I-3 (B016) Observation signature.** Digest = `keccak256(abi.encode(OBSERVATION_TYPEHASH, fields...,
  block.chainid, address(engine)))`, signed raw (no EIP-191/712 prefix), one pinned signer per
  source, pinned once at initialization. The signed `priceWad` must equal `floor((impactBid +
  impactAsk)/2)` whenever the depth summary is valid. CP-PRICE must confirm this envelope; until
  then the live CP-PRICE join is BLOCKED_BY_COUNTERPART.
- **I-4 (B016) Perp observations** come from this market's own book depth (impact mid at N),
  recorded internally by the engine, not from a signed source; only the independent index is
  signed. The index must never come from this market's book (spec §4.1).
- **M-9 (B018) Bootstrap order band.** "Inside the index order band" has no numeric value in the
  spec. Choice: an immutable listing parameter `bootstrapBandWad` (fixture 0.05) around the
  300 s index TWAP; backed-only orders outside `[I - band, I + band]` are rejected. Question for the
  spec owner / CP-FACTORY listing template.
- **M-10 (B018) Mark availability.** The normal mark is reported only in NORMAL_PRICING; warm-up
  windows that happen to be complete in BOOTSTRAP are not a leveraged mark until an epoch opening
  switches the mode (spec §4.1, DEC-14). `_onEpochOpening()` is the hook Person A's rollover commit
  must call (A025/A026) — interface guess, see S-4.
- **S-4 (B018 onward) Epoch-opening hook.** B exposes `_onEpochOpening()` (applies a staged risk
  profile, may switch BOOTSTRAP -> NORMAL_PRICING). A's `EpochRollover` commit must call it once per
  completed epoch. Until merge, tests call it directly.
- **I-5 (B019) Oracle enum values.** The oracle source enum is taken as `{NONE=0, YES=1, NO=2,
  INVALID=3, VOIDED=4}` (spec §8.1 lists NONE/YES/NO/INVALID; the task text "External YES1/NO2"
  fixes YES/NO; VOIDED=4 is a B guess). `OracleOutcomeMap` maps YES -> `settle(1)` -> local YES(2),
  NO -> `settle(0)` -> local NO(1), INVALID/VOIDED -> `settleInvalid()`. CP-ORACLE must confirm.
- **I-6 (B019) Listing fields.** `IMarketConfig.Listing` adds `monitor`, `governance`,
  `indexSourceId/indexSigner/indexRulesHash`, `bootstrapBandWad`, `maxLiqLotsPerBlock` (0 = not
  measured) and `fundingEnabled` to the spec §2.2 field list. CP-FACTORY must confirm. Validation:
  `T >= listedAt + 24h`, `T + grace <= listedAt + voidSecs`, new-listing fallback exactly 0.5 with
  3,600 s grace, `maxTraders <= 1024`, `maxOrderLots <= uint48.max`.
- **I-7 (B019) Release decision port.** `_riskReleaseDecision(ReleaseInput)` is the B side of A017's
  guarded release: A supplies settled cash after release, lots, reservation sums and its
  order-aware deficits/market check after release. Halted -> no; missing normal mark -> only if
  exactly backed with a valid index; floor window -> only exactly backed; else IM envelope.
- **P-6 (all Solidity tasks) Formatter scope.** `forge fmt` is only run on B paths; a run over
  `src/` reformatted the book team's `Book.sol` once and was reverted before commit (B019).
- **S-5 (B020 onward) `contracts/provisional/IAccountingPort.sol`** is B's guess of Person A's
  internal accounting port (A021 AccountingPort) extended with the job ports B drives. Functions
  and the A task that must provide each:
  `_acctBeginAction` (A026 envelope: global accrual to the legal cutoff), `_acctTouch` (A024),
  `_acctAccount` (A016/A021 view), `_acctCoverage(trader, sums, dCash, dLots)` (A019/A013:
  order-aware deficits incl. fee caps, 2% cap, both reserve inequalities after replacing this
  account's contribution), `_acctReplaceContribution` (A019), `_acctPostFill` (A018/A026 paired
  posting + fees + OI + position version), `_acctAccountingState` (A025),
  `_acctBumpAccountOrderEpoch` / `_acctBumpMarketOrderEpoch` (A016 epoch storage),
  `_acctTakeover` (A028), `_acctPostLiquidationFill` (A029), `_acctFloorBegin/TraderAt/Complete`
  (A031), `_acctAccountCount` (A016), `_acctFreeze` (A030), `_acctPrepareSnapshotChunk` (A034),
  `_acctPreparePayoutChunk` (A035), `_acctFinishPreparation` (A035/A036). At merge, map each to
  A's real name/signature; any semantic difference is a G3/G4/G5 interface issue.
- **S-6 (B020) MockAccountingPort** keeps a scripted account table and applies only the literal
  paired delta of a posted fill (`dx = +-lots`, `dc = -dx*tick*Q - fee`). No funding, premium, fee
  split or coverage logic; coverage comes from a test-side `ICoverageScript` (e.g.
  `FormulaCoverage` in RiskHarness.sol, spec §7.3 formula on fixtures). It reverts on unexpected
  sequencing. Replaced by real A modules at G3/G4.
- **M-11 (B020, B022) Fee-cap attribution on partial fills.** After a partial fill the order's
  remaining fee cap is `floor(feeCap * remainingAfter / remainingBefore)`; Risk consumes the
  difference. The spec requires exact attribution but does not fix the formula. Zero in the
  initial fee-free profile. ASSUMPTION.
- **I-8 (B020) Epoch staleness is reported by Risk.** The mock book checks only expiry and
  self-trade itself; market/account epoch and reduce-version staleness come back from
  `_riskTryMatchedFill` as `PRUNE_MAKER` with `STALE_ORDER`. The spec lets the book skip stale
  epochs using its stored tag; either placement is compatible, CP-BOOK to confirm.
- **M-12 (B021) Freshness latch.** `fundingFreshThrough` = the latched start of the first index gap
  inside the current funding epoch, else the continuous coverage end (last valid observedAt + 30).
  A later valid sample moves continuous coverage but not the latch; the latch resets only at a
  completed epoch opening (`_riskEpochOpenedWithGuards`). An epoch that opens with stale data is
  latched at its start (no funding). An invalid (thin-depth) sample ends coverage at its own time.
- **S-7 (B021) Freshness hook for A.** `_onFreshnessAdvance(oldFreshThrough)` is called before the
  endpoint moves so A's FundingAccounting (A022) can accrue/stop old-epoch funding against the
  previously known endpoint. Default is a no-op in B; A overrides it at merge.
- **M-13 (B021) Movement restriction lifetime.** The 0.10/300 s trigger sets reduce-only until the
  pinned monitor clears it (`clearReduceOnly`, "failed early check restores trading"). The spec
  does not give an automatic expiry. ASSUMPTION.
- **S-8 (B023) Trading fee cap.** `_feeCapQ(lots, tick)` returns 0 (DEC-11 initial profile). The
  worst-limit fee commitment formula is A's FeeMath (A013); at merge override `_feeCapQ` with it.
- **M-14 (B023) Reduce-only admission.** A reduce-only taker is clipped to `|x|` (side must oppose
  the position) and admitted in `VOLUNTARY_REDUCTION` mode iff market coverage holds and neither
  order-aware endpoint deficit rises versus the current commitment set; IM is not required
  (spec §4.3 allows reductions below IM). `FORCED_REDUCTION` is never reachable from user input.
- **M-15 (B023) Bootstrap / final-day admission** uses the exact predicate `d0 == 0 && d1 == 0`
  on the whole commitment set (plus the index band in BOOTSTRAP), via the same halving search.
