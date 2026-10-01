# Math-first parallel implementation plan

**Execution plan v1.1 replaces the old P0–P5 / R001–R080 schedule.** The economic formulas, units, selected decisions DEC-01–DEC-14, role restrictions and release defaults remain the v1.0 baseline. This revision changes implementation order, task boundaries, module ownership and integration checkpoints. It does not authorize production leverage or deployment.

Start with the math engine. Both developers first build independent parts of a reference model, then the matching pure Solidity libraries. Only after the combined math-engine gate passes do you build custody, stateful accounting, real price ingestion and execution adapters. You do not wait until the end of the project to discover whether A's accounting and B's decisions agree.

## What “math engine first” means

The first executable deliverable has two layers:

1. **Independent reference calculation:** Python `Fraction` for exact ledger/funding/premium/payoff arithmetic; high-precision interval calculations for square roots and conservative risk bounds. It accepts data and returns results or state deltas. It does not hold tokens or fetch prices.
2. **Production calculation kernel:** pure Solidity libraries for those same calculations, with checked integer bounds and directed rounding. They accept immutable inputs and return values/deltas; they do not mutate protocol storage, call a feed, transfer USDC or match orders.

The reference is a test oracle, not a second authoritative production ledger. Expected outputs must be independently derived; do not call Solidity from Python to generate the supposedly independent expected answer. Model math in the reference first, verify its small examples, then port it. Inputs such as price samples, time, OI and hazard profiles are explicit fixture data during this phase. Real feed collectors, vaults and keeper jobs come later.

| Math ownership | Person A | Person B |
|---|---|---|
| Reference engine | Units, paired cash/position changes, endpoint deficits, reserve coverage, fixed-epoch funding, premium integration, fee/payoff/capital allocation | Horizon, hazards, volatility/tail/drift, MM/IM/health/caps, all-prefix order admission, pricing windows, liquidation decisions and clock/readiness predicates |
| Solidity kernel | QMath, LedgerMath, FundingMath, PremiumMath, CoverageMath, FeeMath, SettlementMath | HorizonMath, HazardMath, MarginMath, OrderAdmissionMath, PricingMath, LiquidationMath, LifecycleMath |
| Shared boundary | A produces exact economic state/delta values and directed numeric primitives | B consumes explicit state values and produces requirements/permissions/limits |
| Acceptance | Exact conservation, coverage, funding clearing and premium rounding | Conservative risk bounds, valid domains, monotone envelopes, safe admission and lifecycle decisions |

**Important independence point:** A delivers the common directed integer primitives at G1. B therefore starts the Solidity port with the real stable primitives available. B's W1 reference work does not depend on those Solidity functions. A does not wait for a live mark or book to implement funding or premiums; the agreed input records supply those values.

## Workload and scheduling rules

There are **88 owner-assigned tasks: 44 for A and 44 for B**, plus **eight shared integration stops, G0–G7**. Tasks start as not started. The old 80 tasks all map into the replacement backlog; the packet includes the complete migration table.

Effort points are relative planning estimates, not promised hours or completion dates. A 2-point task is small and bounded; 3 is moderate; 4 combines several correctness boundaries; 5 is a difficult algorithm or broad adversarial check. Each estimate includes its task-level tests and normal review fixes. Each person has 157 task points and an additional estimated 2 points per shared gate: **173 planned points each**. Equality of estimates does not guarantee equal elapsed time or difficulty for your particular skills.

Balance is checked within every work block, not only at the project total. Premium integration and funding reconciliation are deliberately matched with risk/admission and liquidation work of comparable estimated complexity. Both people implement core math, contract code and tests; neither is assigned only documentation or only the difficult math.

At each gate record actual effort and remaining uncertainty. If one lane is taking materially longer, the faster developer reviews difficult cases, writes independent acceptance fixtures or takes a specifically reassigned unstarted task. Update the owner map before that task starts. Do not move half-implemented files between agents silently or split ownership of a cash-mutating function to make the totals look equal.

## How parallel work is enforced

Each numbered work block contains an A lane and a B lane. A task may depend on an earlier task in its own lane and on the previous accepted gate; **there is no same-block dependency on the other person's unfinished task**. Both work from the same accepted interface version. Where the peer implementation is not yet ready, use a scripted test double of that agreed interface. A double checks expected calls and supplied results; it must not grow into a duplicate economic engine.

The gates are real synchronization points. A peer-mocked unit test can complete a lane task, but only real A+B components can clear the corresponding combined gate. G2 is the mandatory math-complete stop before any stateful protocol implementation. Later blocks retain explicit integration gates, with safe preparation work listed for the person who finishes early. Such preparation is not permission to mark a dependency-blocked task accepted.

Only the counterpart order-book, price-collector and resolution internals may remain mocked at the local completion gate. Their real integration is reported separately as pass or blocked. Never call a mock-only run a passed live integration.

## Repository ownership that prevents merge collisions

The proposed paths can be mapped onto an existing repository once, at G0. Keep those mappings in `docs/ownership.json`; do not create a second economic engine merely because an equivalent module already exists.

| Files/modules | Sole implementation editor | Consumption rule |
|---|---|---|
| `reference/a/`, common unit/fixture-result types, QMath and A accounting math libraries | A | B imports the accepted G0/G1 version; changes go through A |
| `reference/b/`, risk-function contracts, B risk/pricing/lifecycle math libraries | B | A consumes pure outputs and agreed values, not B private state |
| RiskStorage, AccountRegistry, vaults, AccountingPort, Accounting/Fee/ReserveAccounting | A | B reads snapshots and calls internal ports; never writes cash storage |
| FundingAccounting, PremiumAccounting, AccountSync, EpochRollover, ClearingCore | A | B supplies decisions/reservation changes; A owns mutation order and posting |
| PriceIngress/ObservationStore/RiskPricing, config/book/oracle interfaces and context port | B | A consumes a frozen RiskContext and explicit continuous-freshness cutoff |
| OrderRisk/OrderAdmission/BookRiskAdapter/OrderLifecycle/TradePreview | B | Calls A accounting port; actual CLOB topology is still the other team's work |
| TakeoverAccounting, LiquidationFees, FreezeAccounting, FloorAccounting, accounting event decoder | A | B authorizes and orchestrates; A moves paired cash/position and records escrow |
| RiskLifecycle/FloorLifecycle/liquidation controllers/RiskView | B | No direct vault transfer or independent cash mutation |
| SnapshotLedger/PayoutLedger/RecoveryAccounting/ClaimEscrow/ReserveClaims | A | Accept immutable finality/price from B; manage frozen liabilities and transfers |
| ResolutionIngress/InvalidPrice/SettlementController/ConversionGate and settlement/SDK facade | B | Controller drives A jobs; oracle outcome is never an instruction to set balances |
| `test/.../A/`, A mocks and A review reports | A | B reviews through findings; A edits |
| `test/.../B/`, B mocks and B review reports | B | A reviews through findings; B edits |
| `test/gates/Gn.t.sol`, `docs/contracts/Gn.json`, `artifacts/gates/Gn.json` | That gate's coordinator | New files per gate; both review. Global gate status has one writer at a time |

`ClearingCore` is the concrete composition module for the specification's Risk & Clearing layer inside MarketEngine. It is not a second independent engine. The book team owns matching topology; this team owns only the internal risk adapter. All economic posting stays in A-owned functions even when B decides the action.

The new task lists provide exact allowed write files. Each developer also owns the listed modules for later bug fixes; a fix must name its affected task/gate and rerun its checks. Do not use a broad “edit anything under contracts/” prompt for either AI agent.

## What to do at every pull stop

1. Each person finishes and tests the assigned block on their own branch or worktree. Commit working changes with task IDs and evidence. Do not discard or overwrite the other person's uncommitted work.
2. The named coordinator opens `integration/wN` from the prior accepted gate commit, merges the reviewed A and B branches, and runs the combined gate suite. Fixes go back through each module's owner; the coordinator does not rewrite their partner's module privately.
3. Both review the combined trace and interface changes. On success, merge the tested result to the shared main branch and record its actual commit hash in the gate record. A document tick or a green mock suite is not an accepted gate.
4. Both fetch and start the next block from that **same recorded commit**. This is the explicit point at which each person pulls the other's accepted work. Do not cherry-pick a selection that omits its fixtures, types or invariant checks.
5. If the combined test fails, the gate remains blocked. Continue the permitted own-module test/documentation preparation while fixing the concrete issue. An interface change invalidates the relevant prior compatibility result and must be versioned and rerun.

For separate checkouts, the next-block pattern is:

```bash
# First commit or otherwise preserve your own current work.
git status --short
git fetch origin
# Replace the placeholders with the accepted gate SHA and your identity.
git switch -c risk/w4-a <G3_MERGE_SHA>
# Person B uses risk/w4-b from the identical G3_MERGE_SHA.
```

For local parallel AI agents, give them separate Git worktrees and the same recorded starting commit. Do not let two agents change branches in one working directory. Review work through commits/PRs, not by copying changed files between folders. These are workflow instructions; this document has not created or merged a repository.

## Task acceptance and evidence

Every task specifies owner, relative effort, allowed write files, dependencies, output, a future acceptance command, acceptance assertions and the gate that consumes its result. Run commands from the repository root unless the command explicitly changes directory. W0/W1 reference suites use Python; W2 ports use the math harness; later task checks use contract or integration harnesses. `scripts/check-task.sh` and `scripts/check-gate.sh` are required deliverables in A002, not existing tools supplied by this PDF.

Record task/gate ID, actual commit, specification and interface versions, command, exit code, fixtures/seeds, artifact paths and real/mock component status. Never generate a passing result merely because the plan names a test. If repository tooling is absent, that task remains unverified until it is installed/pinned and actually run.

The 26 arithmetic checks shipped with the original document remain useful starter fixtures. They are not the new math engine, do not satisfy G1/G2 by themselves, and are not a substitute for the reference/Solidity differential tests in the new backlog. This revision validates the **plan** and preserves those fixtures; it does not claim to have implemented any of the 88 tasks.

## Handling work already started under the old plan

Use `task_migration.csv` or JSON to locate every old R task. Some old tasks split into reference, pure Solidity and stateful wiring; others join one new atomic deliverable. Keep useful code and evidence, but check it against the new boundaries before crediting a new task. Do not treat new IDs as an instruction to throw away existing work or automatically mark its replacement complete. The new A/B assignments and gates are authoritative for scheduling from this revision onward.

## External team dependencies remain explicit


| ID | Counterpart deliverable | Required risk-side contract and local substitute | Join condition |
|---|---|---|---|
| CP-BOOK | CLOB matcher, FIFO/bitmap/slot storage, matching and order cancellation | Internal `IBookRiskHooks` contract; `MockBookAdapter` supports committed limit orders, exact fills, cancellations and bounded liquidation fills | Counterpart passes the same hook vectors; order ID/generation, lot units, fill fees and cancellation epoch are identical |
| CP-PRICE | Spot/index source collector and venue-depth read capability | `IPriceSource` signed/authorized observation envelope and `MockPriceSource`; B implements selected risk aggregation and guards, not Kuru/CRE fetching | Sample sequence, observed/published/accepted times, depth-size units, stale behavior and revision policy match |
| CP-ORACLE | Immutable listed rules, authorized halt, final YES/NO/INVALID, OI-at-halt consumer | `IResolutionIngress` and `MockResolutionAuthority`; no CRE, model, committee or UMA code | Only configured authority can halt/finalize; enum-to-payoff mapping explicit; state/attempt callbacks cannot pay twice |
| CP-FACTORY | Factory/registry wires isolated engines and approved addresses/config | `IMarketConfig` plus immutable fixture/factory harness | Risk bounds, scheduled time, source permissions and INVALID rule match listing and cannot be rewritten by a price callback |
| CP-TOKEN | Native OutcomeVault/YES-NO token behavior, when used by the selected release | `IOutcomeSettlement` mock only; primary cash-settlement implementation does not implement outcome tokens | Optional conversion stays disabled until separate token-accounting integration passes; no inferred requirement to ship it with cash settlement |
| CP-APP | Indexer and frontend consume events/views | JSON/ABI fixtures and `RiskView` schema produced by this team; no web pages or GraphQL server | UI values reproduce contract previews at a named block; pending/unfinalized estimates cannot masquerade as claimable cash |

A missing counterpart deployment is not a reason to stop implementing this package: run the shared interface fixtures against its deterministic mock. It does block the real integration gate. The coding agent must never label a mock-only pass as the live counterpart passing. [B §§16,18, pp.27–33; O §§9–11, pp.18–23; D §§9.8,11, pp.17,21–23.]


## Parallel work blocks and pull stops

Each row is one block of concurrent work. Finish G0, then W1/G1, W2/G2 and so on. G2 is the math-engine completion gate. The exact tasks and their intra-lane order follow later.

| Block | A lane | B lane | Pull stop |
|---|---|---|---|
| W0: Agree the math contract | A001–A002: Units, types and test runners. 4 points. | B001–B002: Function contracts, ownership and golden cases. 4 points. | G0 |
| W1: Build the independent reference engine | A003–A009: Ledger, cover, funding, premiums, payoff; shared QMath. 27 points. | B003–B009: Risk, margin, admission, pricing, liquidation and clocks. 27 points. | G1 |
| W2: Build and verify pure Solidity math | A010–A015: Pure accounting/funding/premium/payoff libraries. 24 points. | B010–B015: Pure risk/admission/pricing/lifecycle libraries. 24 points. | G2 |
| W3: Build state and pricing foundations | A016–A021: Vault, storage, posting, reserve and accounting port. 21 points. | B016–B021: Observation ingress/store, context, ports and mocks. 21 points. | G3 |
| W4: Connect accrual and trading admission | A022–A027: Funding, premium, sync, rollover and clearing. 23 points. | B022–B027: Reservations, admission, internal book hooks and previews. 23 points. | G4 |
| W5: Build lifecycle and liquidation | A028–A033: Takeover, fees, freeze, floor accounting and events. 21 points. | B028–B033: Stages, grace, floor and liquidation controllers. 21 points. | G5 |
| W6: Build resolution and cash settlement | A034–A039: Frozen ledger, payouts, escrow, claims and capital exit. 21 points. | B034–B039: Finality, INVALID capture, jobs, oracle seam and views. 21 points. | G6 |
| W7: Verify and hand off the integrated system | A040–A044: Accounting invariants, gas, custody and peer review. 16 points. | B040–B044: Lifecycle/counterparts, gas, SDK and peer review. 16 points. | G7 |

No same-block peer-task dependency appears in the declared graph. This is a planning property, not a promise that no unexpected interface defect will be found. Defects are resolved at the named gate through the owner map.

## G0 — STOP, integrate and both pull: Math contract frozen

**After:** W0 · **Coordinator:** A · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A units/types and runner; B function contracts, ownership and independently derived fixtures.

**Run together:** Resolve unit/enum/domain differences, compile a shared pure-input smoke fixture, and commit one MathTypes/QMath signature version. Both pull this commit before algorithm implementation.

**Gate passes only when:** Units, fixture schema, pure function signatures, directed-rounding conventions and the owner map are identical on both worktrees. No vault/feed/engine implementation has started.

**Both pull:** the actual merged commit recorded for G0; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G0` on the combined branch. **Frozen output:** G0 math contract and golden-fixture schema.

**If your partner is still finishing:** Review additional hand-derived boundary cases in your own fixture/test area; do not implement algorithms against unagreed types.

## G1 — STOP, integrate and both pull: Reference engines and numeric primitives joined

**After:** W1 · **Coordinator:** B · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A rational ledger/coverage/funding/premium/payoff plus QMath; B high-precision risk/pricing/liquidation/clock references.

**Run together:** Run one combined reference trace: paired trade, margin/admission, funding, premium, liquidation decision, and terminal payoff. Compare QMath with rational bounds; freeze its callable interface for the Solidity port.

**Gate passes only when:** One unified reference engine can calculate both sides of the fixture; no placeholder port remains in the combined reference run. QMath directed-bound tests pass.

**Both pull:** the actual merged commit recorded for G1; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G1` on the combined branch. **Frozen output:** G1 reference outputs, QMath interface and math fixture hashes.

**If your partner is still finishing:** Prepare test cases and documentation for your own W2 library signatures; do not finalize a port against a QMath interface that G1 has not accepted.

## G2 — STOP, integrate and both pull: MATH ENGINE COMPLETE

**After:** W2 · **Coordinator:** A · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A pure Solidity accounting libraries; B pure Solidity risk/pricing/lifecycle libraries and both differential reports.

**Run together:** Compose real A and B pure libraries in the math harness. Run direct5x entry, short100-vs80 margin, all-prefix admission, reserve funding payer/receiver, neutral-touch premium, halt cutoffs and all payoff modes. Freeze stateful internal port schemas for W3.

**Gate passes only when:** The reference and pure Solidity engines agree exactly or within each declared conservative bound. No token/storage/network dependency appears in the math layer. Both approve the backend input/output port contracts. Stateful build is blocked until this gate passes.

**Both pull:** the actual merged commit recorded for G2; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G2` on the combined branch. **Frozen output:** G2 math-engine fixture hashes and backend port contracts.

**If your partner is still finishing:** Add invariant/boundary cases or measure your own pure functions locally. Do not begin vaults, real feed ingress or stateful clearing before G2 passes.

## G3 — STOP, integrate and both pull: Storage and risk context joined

**After:** W3 · **Coordinator:** B · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A real custody/ledger/coverage ports; B real observations/context plus scripted counterparts.

**Run together:** Replace the A/B doubles in a combined harness: allocate collateral, compute a fresh context and margin from actual stored account values, exercise bootstrap and checked release decision. Freeze action/accrual/reservation delta contracts for W4.

**Gate passes only when:** Actual account snapshots and RiskContext use the same Q/lot/version cutoffs. Bootstrap has a valid startup path; guarded release cannot bypass the real risk decision. Book/oracle remain explicitly mocked.

**Both pull:** the actual merged commit recorded for G3; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G3` on the combined branch. **Frozen output:** G3 real state/read ports, accrual/action ABI and book hooks.

**If your partner is still finishing:** Prepare own W4 unit fixtures and mocks against G2-frozen ports; any integration-dependent completion waits for G3. Do not change a peer-owned interface locally.

## G4 — STOP, integrate and both pull: Trading with real accrual joined

**After:** W4 · **Coordinator:** A · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A funding, premium, account sync, rollover and clearing; B reservations, admission, book adapters and previews.

**Run together:** Wire real A account-touch/posting into real B hook orchestration. Run rest→maker touch→paired fill→fees→coverage→permit release, then epoch rollover, cancellation and withdrawal.

**Gate passes only when:** No scripted A/B peer port remains in trading tests. Each fill sees updated OI/cash/coverage; neutral premium touches agree; old epochs cannot release new reservations. Unexpected assertion rolls back all prior fills.

**Both pull:** the actual merged commit recorded for G4; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G4` on the combined branch. **Frozen output:** G4 working trading engine and liquidation/freeze port contracts.

**If your partner is still finishing:** Work on additional own-module fuzz cases and W5 scenario inputs. A takeover or B liquidation implementation may be prepared only against the accepted previous interface, with completion held until G4.

## G5 — STOP, integrate and both pull: Liquidation and freeze joined

**After:** W5 · **Coordinator:** B · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A takeover/fees/freeze/floor accounting; B stage/grace/eligibility/book-close/lifecycle.

**Run together:** Run real pair reduction, bounded book reduction, NEEDS_MORE_WORK, authorized takeover, floor sweep and halt during every rollover-page state. Freeze snapshot and payout job port schemas for W6.

**Gate passes only when:** Small caller budget never causes positive-equity takeover. Both reserve sides and keeper liabilities remain correct; actual economicHaltAt is distinct from the shared accrual cutoff. No live mutation occurs inside a frozen sweep.

**Both pull:** the actual merged commit recorded for G5; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G5` on the combined branch. **Frozen output:** G5 frozen snapshot/job interfaces and real liquidation traces.

**If your partner is still finishing:** Prepare your own W6 payout or finality edge-case vectors against G5-design schemas; do not finalize combined snapshot assumptions before the G5 version is merged.

## G6 — STOP, integrate and both pull: Resolution-to-cash joined

**After:** W6 · **Coordinator:** A · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A frozen-ledger/payout/escrow/claims/reserve exits; B finality/INVALID/controller/readiness.

**Run together:** Use real A settlement ledger with real B controllers through YES, NO and earlyINVALID. Vary pages and claim order; test fee fractions and LP redemption before remaining user claims.

**Gate passes only when:** Finality acceptance is constant work; claims wait for immutable price and complete allocation; retries are exactly once; all trader/fee/keeper/reserve Q stays classified. Conversion/recovery flags remain selected defaults.

**Both pull:** the actual merged commit recorded for G6; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G6` on the combined branch. **Frozen output:** G6 end-to-end cash-settlement engine; frozen ABI for hardening.

**If your partner is still finishing:** Expand own completed settlement tests, documentation and gas fixtures. Do not produce a final all-module report using peer mocks.

## G7 — STOP, integrate and both pull: Integrated handoff accepted

**After:** W7 · **Coordinator:** B · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A accounting invariants/gas/custody evidence and review; B lifecycle/counterpart/gas/SDK evidence and review.

**Run together:** Run both campaigns from one clean merged commit, resolve cross-review findings through the owning developer, and assemble release/counterpart status. Both pull and replay the final commit.

**Gate passes only when:** Local end-to-end tests use real A+B modules and complete evidence. Real external counterpart integration is explicitly PASS or BLOCKED_BY_COUNTERPART with mock status; only a real pass clears the live join. Calibration/audit/deployment remain distinct release gates.

**Both pull:** the actual merged commit recorded for G7; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G7` on the combined branch. **Frozen output:** G7 release manifest and real-vs-mock counterpart status.

**If your partner is still finishing:** Fix findings in your owned modules and rerun affected suites; do not weaken invariants or report mock-only counterpart success as real integration.

## Concrete example: working independently in W4

A builds the real account-touch sequence: funding, premium, cushion retirement, deficit replacement and atomic posting. A tests it against a scripted decision port that returns agreed inputs and accept/reject results. B independently builds reservations, maker re-admission and the bounded book adapter against a scripted accounting port with the same G3 signatures. B does not copy funding/premium logic into its mock; A does not copy margin/admission logic into its mock.

At G4, join the real modules. An incoming order obtains B's risk context and permit; A synchronizes maker/taker to the legal cutoff; B rechecks admission; A posts both legs and fees; B updates the order lifecycle; the combined action verifies reserve coverage and permit cleanup. If the interface or sequencing is wrong, G4 fails even when both separate mock suites were green. Fix it in the owning module, rerun, merge, and both start W5 from that accepted commit.
