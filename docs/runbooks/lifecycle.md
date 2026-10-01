# Lifecycle runbook — Risk & Clearing, Person B modules (B044)

Local replay and operations notes for the B side of the engine. **No deployment of any kind is
implied or authorized by this document.** Production needs the release gates in spec §5.4 and
§10 (calibration, gas on the target chain, audit, real counterparts), none of which exist yet.

## 1. Replay the local lifecycle

```bash
git switch feat/risk
git submodule update --init --recursive
python docs/spec/verify_spec_vectors.py                              # 26 spec arithmetic checks
python -m unittest discover -s reference/tests/b -p "test_b*.py"     # B reference (156 tests)
cd contracts
forge test --match-path "test/*/B/*.t.sol"                           # all B suites (317 tests)
forge test --match-path test/integration/B/FullLifecycle.t.sol -vv   # end-to-end campaign
forge test --match-path test/gas/B/AdapterGas.t.sol -vv              # gas markers
cd .. && bash provisional/scripts/check-task.sh B040                 # stand-in runner (A002 absent)
```

The campaign (`FullLifecycle.t.sol`) runs: bootstrap with an index-only empty book ->
exactly backed trade -> epoch opening to NORMAL_PRICING -> stale maker -> direct 5x entry
(fixture leverage) -> price drop and keeper liquidation -> no keeper until the floor -> floor
sweep -> late scheduled halt -> YES -> preparation -> claims; plus early NO, early INVALID with
capture at T, and the disabled conversion. Person A is the scripted `MockAccountingPort`; the book
and oracle are mocks. Every result is a lane result, not an integration pass.

## 2. Keeper jobs (all permissionless, bounded)

| Job | Entry point | Bound | When | Retry |
|---|---|---|---|---|
| Floor sweep | `floorSweep(n)` | n <= 32 accounts | from T - 12h until reconciled | idempotent; resumes at cursor; halts abandon |
| Liquidation | `liquidate(trader, maxLots, maxExaminations, partner)` | maxExaminations <= 64; per-block lot cap | any account with mode REDUCE/TAKEOVER in `accountRiskView` | NEEDS_MORE_WORK -> call again; no reward without effect |
| Scheduled halt | `materializeScheduledHalt()` | constant | at/after T | idempotent; economicHaltAt stays T |
| INVALID capture | `captureInvalidPrice()` | constant | at/after T (fallback after T + 1h for disclosed listings) | idempotent once captured |
| Snapshot prep | `prepareSnapshotChunk(n)` | n <= 32 | after halt (may precede finality) | retry after interruption; no partial progress |
| Payout prep | `preparePayoutChunk(n)` | n <= 32 | after finality and price | same |
| Finish | `finishPreparation()` | constant | both cursors done | RECOVERY_REQUIRED keeps claims disabled |
| Epoch opening | A's rollover commit calls `_riskEpochOpenedWithGuards()` | constant | every completed accounting epoch | A-owned job |

Alert on: `pendingWork != 0` in `marketRiskView()` for longer than one epoch; liquidation calls
returning NEEDS_MORE_WORK repeatedly with an empty book (positive equity stays reserve-covered,
but the account must be followed); `ORACLE_FINAL_PRICE_PENDING` after T + 1h on a disclosed
listing (capture job not run).

## 3. Pending states and what to do

| UI / view state | Meaning | Operator action |
|---|---|---|
| Pricing `BOOTSTRAP`, mark unavailable | no normal mark yet; only exactly backed orders inside the index band | wait for full windows and the next epoch opening |
| Stage `BACKING_GRACE` | new exposure must be exactly backed | none (derived from time) |
| Stage `BACKING_FLOOR`, pending FLOOR_SWEEP | legacy deficient accounts await takeover | run `floorSweep(32)` until reconciled |
| AccountingState `ROLLOVER_SWEEP` | trading/releases paused | run A's rollover pages |
| `HALTED_AWAITING_OUTCOME` | halted, no oracle outcome | snapshot prep may run; wait for the oracle |
| `ORACLE_FINAL_PRICE_PENDING` | INVALID latched, price not captured | after T: `captureInvalidPrice()`; legacy listing BLOCKED needs governance outside this code |
| `ORACLE_FINAL_PREPARING` | outcome final, jobs running | run snapshot/payout chunks, then `finishPreparation()` |
| `RECOVERY_REQUIRED` | liabilities exceed recognized assets | claims stay disabled; baseline has no haircut; escalate outside the market-local path |
| `CLAIMABLE` | claims enabled | users claim (A's ClaimEscrow) |

## 4. Disabled features (baseline defaults)

- Token conversion (`ConversionGate._conversionEnabled()` = false, DEC-10).
- Recovery haircut (A036, `recoveryEnabled=false`).
- Funding (`fundingEnabled=false` in the initial manifest; local fixtures enable it).
- Leverage (initial deployment caps 1x; fixtures use the simulated cap 5).
- Forced-book liquidation when `maxLiqLotsPerBlock` is not measured (`liquidate` returns DISABLED
  for the book close; price-free floor takeovers and settlement remain available).

## 5. Blocked live integrations

See `artifacts/risk/counterpart-status.json`: CP-BOOK, CP-PRICE, CP-ORACLE, CP-FACTORY, CP-APP are
BLOCKED_BY_COUNTERPART; CP-TOKEN is not in the release; Person A is not integrated (stand-ins).
