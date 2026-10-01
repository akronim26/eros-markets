# B checkpoint at G3 — storage and risk context (after B016–B021)

**Gate status:** G3 not passed (no merge SHA). B coordinates G3; nothing here marks it passed.
User-directed solo mode (P-1): these stateful B modules were built before G2 was recorded.

## What the B side satisfies alone

| Module | Task | Lane result |
|---|---|---|
| `src/interfaces/IPriceSource.sol`, `src/pricing/PriceIngress.sol` | B016 | domain/signer/source/rules auth, strict sequence, observedAt order, future tolerance 0, delayed samples keep observedAt |
| `src/pricing/ObservationStore.sol` | B017 | INDEX/PERP/BASIS rings (1,024, log-time queries), O(1) INVALID [T-24h, T] record that survives ring wrap |
| `src/pricing/RiskPricing.sol` | B018 | RiskContext (prices/stage/versions only), exactly-backed bootstrap in index band, NORMAL only at epoch opening |
| `src/interfaces/{IMarketConfig,IBookRiskHooks,IResolutionIngress}.sol`, `src/risk/RiskContextPort.sol` | B019 | listing validation + one-time init, roles, versioned calibration, oracle enum map, cutoffs, release decision port |
| `test/mocks/B/*`, `test/harness/B/RiskHarness.sol` | B020 | scripted A port with sequencing reverts, mock book, mock oracle authority |
| `src/pricing/SourceGuards.sol`, `src/risk/MonitorPolicy.sol` | B021 | freshness latch, 30 s stale, movement trigger, monitor raise-only hazards, expired calibration -> 1x |

All six acceptance commands exit 0 (`B-evidence/B016..B021.json`).

## Stand-ins / mocks in these results

- A accounting port: `contracts/provisional/IAccountingPort.sol` (S-5) implemented by
  `test/mocks/B/MockAccountingPort.sol` (S-6).
- A epoch-opening call into `_riskEpochOpened()` / `_riskEpochOpenedWithGuards()` (S-4).
- A freshness hook `_onFreshnessAdvance` (S-7).
- CP-PRICE: test signer keys; CP-ORACLE: `MockResolutionAuthority`; CP-BOOK: `MockBookAdapter`.
  Live joins: BLOCKED_BY_COUNTERPART.

## Combined check to run at merge (G3)

```bash
git switch -c integration/w3 <G2 merge SHA>
git merge <A W3 head> <B W3 head>
cd contracts && forge test --match-path "test/risk/**"
bash scripts/check-gate.sh G3
```

G3 join to write (coordinator B, `test/gates/G3.t.sol`): compose A `RiskStorage`/`AccountRegistry`/
`CollateralVault`/`Accounting`/`ReserveAccounting`/`AccountingPort` with B `MonitorPolicy`
(which includes RiskContextPort, SourceGuards, RiskPricing, ObservationStore, PriceIngress);
replace `MockAccountingPort` by A's real port; allocate collateral; feed signed index + perp
depth; open an epoch through A's rollover commit calling `_riskEpochOpenedWithGuards()`; compute
context and margin from stored account values; run the bootstrap exactly-backed release and a
guarded release through `_riskReleaseDecision`. Book/oracle stay mocked.

Interface items to freeze at G3: every S-5 port function name/signature, the RiskContext field
set (A consumes it), the release-decision input, the freshness hook, the epoch-opening hook.
