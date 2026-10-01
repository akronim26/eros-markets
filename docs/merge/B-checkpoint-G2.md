# B checkpoint at G2 — math engine (after B010–B015)

**Gate status:** G2 not passed (no merge SHA recorded). Nothing here marks it passed.

## What the B side satisfies alone

Pure Solidity libraries in `contracts/src/math/` (no storage, no token, no feed, no external call):

| Library | Task | Notes |
|---|---|---|
| `HorizonMath.sol` | B010 | integer and wad-second horizon, sigma theory (sqrtUp), step-up envelope with validity window |
| `HazardMath.sol` | B010 | hazard bound, tail (eps' DOWN, k UP), drift UP; domain failure -> fullBacking with reason |
| `MarginMath.sol` | B011 | MM/IM in Q, caps, full-backing switch, health, display leverage (display only) |
| `OrderAdmissionMath.sol` | B012 | Emin, reach envelope, admit with explicit A coverage values, <= 64 halvings via coverage fn pointer |
| `PricingMath.sol` | B013 | array and cumulative TWAP (fuzz-equal), impact mid, mark median/band, trunc0 funding rate, movement |
| `LiquidationMath.sol` | B014 | allowed reduction, eligibility, takeover (no work input), estimate, bankruptcy tick, fee waiver, pacing |
| `LifecycleMath.sol` | B014 | stages, cutoffs, grace, bootstrap, INVALID readiness, finality, claims status |

Differential: `reference/b/export_vectors.py` (seed 20261001) generates
`contracts/test/math/B/RiskDifferential.t.sol`; `B015.t.sol` runs it plus direct 5x, short 100 vs
80, boundary domains and invalid inputs. Tolerance T-1 (>= reference, at most max(1e3 wad, 1e-12
relative) above). A mutation (dropping `s` from the rate) was caught by `test_diffMargin`.

Commands (all exit 0, stand-ins in use): `cd contracts && forge test --match-path test/math/B/B01{0..5}.t.sol`.

## Stand-ins used (replace at merge)

- `contracts/provisional/QMath.sol` -> A009 `contracts/src/math/QMath.sol` (S-2)
- `contracts/provisional/MathTypes.sol` -> A001 `contracts/src/math/MathTypes.sol` (S-3)
- Admission coverage values in tests are scripted from the spec §7.3 formulas (S-1); real values
  come from A013 `CoverageMath.sol`.

Import rewrite at merge (every B math file):

```
../../provisional/QMath.sol      ->  ./QMath.sol
../../provisional/MathTypes.sol  ->  ./MathTypes.sol
```

## Combined check to run at merge (G2)

```bash
git switch -c integration/w2 <G1 merge SHA>
git merge <A W2 head> <B W2 head>
# rewrite the provisional imports above, delete contracts/provisional/{QMath,MathTypes}.sol
cd contracts && forge test --match-path "test/math/**"
python reference/b/export_vectors.py && git diff --exit-code contracts/test/math/B/RiskDifferential.t.sol
bash scripts/check-gate.sh G2
```

G2 math-harness cases that need both lanes: direct 5x entry with A `LedgerMath` fill deltas feeding
`MarginMath.health`; short 100 vs 80; all-prefix admission with A `CoverageMath` deficits instead
of the scripted coverage; reserve funding payer/receiver (A) with B `PricingMath.fundingRate`;
neutral-touch premium (A); halt cutoffs (`LifecycleMath.accrualCutoff`) feeding A
`FundingMath`/`PremiumMath`; payoff modes (A `SettlementMath`).

Open for G2 review: M-4 (full-backing switch applies to the whole commitment set), M-8 (wad-second
horizon), T-1 tolerance.
