# B checkpoint at G4 — trading admission and book seam (after B022–B027)

**Gate status:** G4 not passed (no merge SHA). Nothing here marks it passed.

## What the B side satisfies alone

| Module | Task | Lane result |
|---|---|---|
| `src/risk/OrderRisk.sol` | B022 | exact tick/value/fee reservations, full uint64 epoch tags, stale-epoch no-op, clear-once, slot sidecar with generation guard |
| `src/risk/OrderAdmission.sol` | B023 | all-prefix taker permits (<= 64 halvings), maker readmission (own margin/cap only), reduce-only mode, bootstrap/final-day exact backing, fill preflight (maker cap -> prune; taker cap or global -> stop) |
| `src/risk/BookRiskAdapter.sol` | B024 | the spec §7.5 hook set: frozen per-action context, single touch per account per action, one A posting per fill, post-fill recheck, permit convert/release, no external calls |
| `src/risk/OrderLifecycle.sol` | B025 | inclusive expiry (re-checked in the fill hook), positionVersion no-revival, cancel-all, market invalidation, size-down with priority, replace for widened permissions |
| `src/risk/TradePreview.sol` | B026 | previewOrder/previewAccount/previewRelease on the same decision code; labelled projections; unavailable != 0 |
| `test/risk/B/BookSeam.t.sol` | B027 | spec §7.8 rows 1,2,3,4,5,8,9,10,14,15,16,17,20,22,27,29,34 + G4 call sequence |

Rows covered elsewhere: 6/7/11/12/19 (B025), 13/21/23/25 (B023/B024/B012), 24 (B023 bootstrap),
26 (B010), 28 (B022). Rows needing real A: 30 floor materialization (W5), 31 exact premium
principal, 32 new-deficit loading, 33 no external calls (by construction: every hook is internal;
the only external calls in traces are the test coverage scripts).

All six acceptance commands exit 0 on the committed tree (`B-evidence/B022..B027.json`). Two
intermediate B025/B027 runs failed and were fixed (rows kept in `B-progress.md`).

## Stand-ins / mocks in these results

- Person A: `MockAccountingPort` (scripted; S-5/S-6), `FormulaCoverage` / `MarketCoverage` test
  scripts for A's order-aware deficits and reserve inequalities, `_feeCapQ`/`_tradeFeeQ` zero or
  test schedules (S-8), virtually-settled views requirement (S-9).
- CP-BOOK: `MockBookAdapter` (the real `Book.sol` hook set differs, I-1). Live join
  BLOCKED_BY_COUNTERPART.

## G4 call sequence B issues (for A's real port)

Direct 5x fill, one maker (from `B-evidence/B027.log`, lines `G4-SEQ`):
`BEGIN; TOUCH taker; REPLACE taker; REPLACE taker; TOUCH maker; POST_FILL; REPLACE maker;
REPLACE taker; REPLACE taker` (I-9).

## Combined check to run at merge (G4)

```bash
git switch -c integration/w4 <G3 merge SHA>
git merge <A W4 head> <B W4 head>
cd contracts && forge test --match-path "test/risk/**"
bash scripts/check-gate.sh G4
```

G4 join (coordinator A): replace `MockAccountingPort` by A's `ClearingCore`/`AccountSync`/
`FundingAccounting`/`PremiumAccounting`/`EpochRollover` behind the S-5 port, keep the mock book,
and rerun `BookSeam.t.sol` against real A (the scripted `FormulaCoverage`/`MarketCoverage` go
away; A's `_acctCoverage` answers). Then run rest -> maker touch -> paired fill -> fees -> coverage
-> permit release, epoch rollover (calls `_riskEpochOpenedWithGuards`), cancellation and
withdrawal (`_riskReleaseDecision`). Check: neutral premium touches agree (A), old epochs cannot
release new reservations (B022), an injected A assertion rolls back all prior fills (B024).
