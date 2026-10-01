# B checkpoint at G6 — resolution to cash (after B034–B039)

**Gate status:** G6 not passed (no merge SHA). Nothing here marks it passed.

## What the B side satisfies alone

| Module | Task | Lane result |
|---|---|---|
| `src/settlement/ResolutionIngress.sol` | B034 | pinned-oracle halt/settle(0/1)/settleInvalid, permissionless scheduled halt (economicHaltAt = T), once-only latch, constant work, accrual cutoff = min(halt, epoch end, frozen rollover) |
| `src/settlement/InvalidPrice.sol` | B035 | capture once at/after T from the unpruned window; 0.5 fallback only for disclosed listings after T+1h; legacy BLOCKED |
| `src/settlement/SettlementController.sol` | B036 | bounded snapshot/payout jobs through A, distinct phases, claims only via finishPreparation; RECOVERY_REQUIRED otherwise |
| `test/risk/B/OracleCompatibility.t.sol`, `docs/counterpart-oracle-fixtures.json` | B037 | halt tuple units, OI incl. reserve, bond conversion, enum map, clocks, retries |
| `src/settlement/ConversionGate.sol`, `packages/risk-sdk/src/settlement.ts` | B038 | conversion disabled and fenced; exclusive claim modes; SDK status decoder |
| `test/risk/B/SettlementLifecycle.t.sol` | B039 | rollover/halt cutoffs, delayed and stale windows, duplicates, transient failures |

All six acceptance commands exit 0 (`B-evidence/B034..B039.json`).

## Stand-ins / mocks

- A frozen ledger, payout, finish and claim-state ports (S-5, S-11, S-12) scripted by
  `MockAccountingPort`; A's ClaimEscrow must call `_riskBeforeCashClaim()`.
- CP-ORACLE: `MockResolutionAuthority`; live join BLOCKED_BY_COUNTERPART.
- SDK file executed only with the cached `tsx` (P-7).

## Combined check to run at merge (G6)

```bash
git switch -c integration/w6 <G5 merge SHA>
git merge <A W6 head> <B W6 head>
cd contracts && forge test --match-path "test/risk/**"
bash scripts/check-gate.sh G6
```

G6 join (coordinator A): real A `SnapshotLedger`, `PayoutLedger`, `RecoveryAccounting`,
`ClaimEscrow`, `ReserveClaims` behind the port with real B controllers; run YES, NO and early
INVALID through `SettlementLifecycle.t.sol` and `OracleCompatibility.t.sol`; vary page sizes and
claim order; fee fractions and LP redemption before remaining user claims. Check: finality
acceptance constant work; claims wait for price and complete allocation; retries exactly once;
conversion/recovery flags stay at baseline defaults.
