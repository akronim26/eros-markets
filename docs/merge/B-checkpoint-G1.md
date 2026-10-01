# B checkpoint at G1 (after B003–B009)

**Gate status:** G1 not passed (no merge SHA in `docs/spec/gate_status.json`). B is the G1
coordinator; nothing here marks it passed.

## What the B side satisfies alone

Independent high-precision reference engine in `reference/b/` (Fraction exact values, directed
square-root intervals, no floats):

| Module | Task | Covers |
|---|---|---|
| `horizon_volatility.py` | B003 | h = h0 + queue + \|x\|/v, sqrt intervals, step-up empirical envelope, rejects nonmonotone bins, running-max conversion |
| `hazards.py` | B004 | linear hazard bound, directional adverse probability, eps', Cantelli k interval, drift ≥ source drift |
| `margin.py` | B005 | MM/IM intervals, full-backing switch, template/deployment caps, health, display leverage; long IM 120, short IM ≈ 95.8937 |
| `order_admission.py` | B006 | Emin lower bound, reachable sign envelope, generic envelope for uncertified kernels, halving cap, enumeration of fill mixtures |
| `pricing.py` | B007 | validity-weighted TWAP, 30 s carry, basis, median + band clamp, trunc0 funding rate, movement trigger |
| `liquidation.py` | B008 | eligibility, takeover authorization without work-budget input, x-free size estimate, bankruptcy tick, fee waiver, pacing |
| `lifecycle.py` | B009 | stages, cutoffs, grace, bootstrap, INVALID readiness, finality, claims status |

All seven acceptance commands exit 0 (see `B-evidence/B003..B009.json`).

Stand-in used: the coverage port in `order_admission.admit` (S-1) is scripted in tests; real
order-aware deficits come from A004.

## Combined check to run at merge (G1)

```bash
git switch -c integration/w1 <G0 merge SHA>
git merge <A W1 head> <B W1 head>
python -m unittest discover -s reference/tests/a -p "test_a*.py"
python -m unittest discover -s reference/tests/b -p "test_b*.py"
bash scripts/check-gate.sh G1
```

Combined reference trace required by G1 (write in `test/gates` per coordinator ownership):
1. A003 paired trade 1,000 claims at tick 600 (Alice 120, Bob 100) -> B005 `health` for both
   (long IM 120 HEALTHY at 5x; short IM ≈ 95.894 HEALTHY with 100).
2. B006 `admit` with the coverage port replaced by A004 `coverage.py` (d0/d1/cap/market).
3. A005 funding step then B005 health again; A006/A007 premium then B008 `eligibility`.
4. A008 terminal payoff for NO/YES/INVALID(0.5) = golden G06.
5. Compare A009 QMath `sqrtUp`/`mulDivUp` with `horizon_volatility.sqrt_bounds` brackets.

Replace in B at merge: nothing in `reference/b` imports A code yet; after G1 the scripted coverage
port in tests is swapped for A004 (tests only).
