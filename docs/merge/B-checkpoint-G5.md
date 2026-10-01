# B checkpoint at G5 — lifecycle and liquidation (after B028–B033)

**Gate status:** G5 not passed (no merge SHA). B coordinates G5; nothing here marks it passed.

## What the B side satisfies alone

| Module | Task | Lane result |
|---|---|---|
| `src/risk/RiskLifecycle.sol` | B028 | stage derived from time each action; floor invalidates order epochs on first action; nonrenewable grace (M-5) |
| `src/risk/FloorLifecycle.sol` | B029 | bounded (<= 32) floor sweep over A's frozen list; takeover only for negative endpoints; reconciled only after the full list; halt abandons |
| `src/risk/LiquidationEligibility.sol` | B030 | eligibility after touch; cancel-first only when eligible; takeover predicates 1/2/3; single-partner pair at common tick with fee-aware predicate both sides |
| `src/risk/LiquidationBookAdapter.sol` | B031 | estimate-sized FORCED reduce-only IOC at the fee-aware worst tick; actual health recomputed; per-block pacing; missing cap disables |
| `src/risk/RiskLiquidation.sol`, `src/risk/RiskView.sol` | B032 | `liquidate()` orchestration, exact takeover authorization; account/market views with unavailable flags and pending-work bits |
| `test/risk/B/LifecycleBoundaries.t.sol` | B033 | no keeper, empty book, stale mark, tiny budget, frozen registry, rollover pause, halt during sweep |

All six acceptance commands exit 0 (`B-evidence/B028..B033.json`).

## Stand-ins / mocks

- A liquidation/floor ports (S-5, S-10): `_acctTakeover`, `_acctPostLiquidationFill`,
  `_acctFloorBegin/TraderAt/Complete` scripted by `MockAccountingPort`.
- CP-BOOK liquidation IOC entry `_liqSubmitIoc` (I-10) via `_mockPlaceWithMode`.
- Fee split half reserve / half keeper is A's (A029); B passes the charged fee and keeper (M-19).

## Combined check to run at merge (G5)

```bash
git switch -c integration/w5 <G4 merge SHA>
git merge <A W5 head> <B W5 head>
cd contracts && forge test --match-path "test/risk/**"
bash scripts/check-gate.sh G5
```

G5 join (coordinator B, `test/gates/G5.t.sol`): real A `TakeoverAccounting`, `LiquidationFees`,
`FreezeAccounting`, `FloorAccounting` behind the port; rerun `LifecycleBoundaries.t.sol` and
`B030–B032` suites against them. Required traces: real pair reduction, bounded book reduction,
NEEDS_MORE_WORK, authorized takeover, floor sweep, and halt during every rollover-page state.
Check: small caller budget never causes positive-equity takeover; both reserve sides and keeper
liabilities correct; `economicHaltAt` distinct from the accrual cutoff; no live mutation inside a
frozen sweep.
