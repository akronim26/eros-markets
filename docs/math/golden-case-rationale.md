# Golden case rationale (B002)

`reference/fixtures/golden_cases.json` holds 20 hand-derived cases. Each case names the spec rule
it comes from in `derivation`. No expected value was produced by B or A implementation code:
exact cases are integer arithmetic done by hand from the spec, and interval cases are the spec's
formulas evaluated with 60-digit `Decimal` and then widened to a bracket.

## Two kinds of expected value

- **exact** — ledger values. Integers as strings. Q = one atom × 1e18. These must match
  bit-for-bit in both the reference and Solidity.
- **interval** — risk values that involve square roots (k, sigma, MM, IM). Stored as `[lo, hi]`
  decimal strings that bracket the true real value. An implementation passes when its
  upward-rounded result is `>= lo` (it is an upper bound of the true value, so it can never be
  below `lo`) and it stays within the task's declared tolerance of `hi`. Where a branch makes a
  value exact (the cap branch gives IM = 120 USDC), the case says `exact`.

## Cases

| ID | What it pins | Rule |
|---|---|---|
| G01 | 17 lots at tick 613 move 10,421 atoms, ±17 lots | §2.1 |
| G02, G03, G04 | long, short and flat endpoint values E0/E1, mark equity, deficits | §2.1, §6.1 |
| G05 | zero equity selects fee-free takeover; reserve slack changes by max(e_y, 0) | §3.1, §5.2 |
| G06 | NO / YES / INVALID 0.5 payouts and reserve residual for the bilateral fixture | §11.1 |
| G07 | 29-day direct 5x long: h = 360 s, MM ≈ 63.929058, IM = 120 exactly | §7.9, V18 |
| G08 | same fixture short: IM ≈ 95.893712; 80 USDC fails, 100 passes | §11.1, V20 |
| G09 | missing calibration: full backing, 1x | DEC-09, §4.2 |
| G10 | oversized ask 2.3 claims at 0.55 from long 1 claim / cash 0: YES deficit 35,000 atoms | §7.9 table |
| G11 | cancel 7@400 from 7@400 + 11@600 leaves 11 lots / 6,600 atoms | §7.3 |
| G12 | direct 5x bid: Emin = 120 USDC; prohibited rectangle would give −480 | §7.3 |
| G13 | 30 s freshness boundary and a delayed observation that is stale on arrival | §4.1 |
| G14 | inclusive stage boundaries T−12h30m, T−12h, T−1h, T | §5.1 |
| G15 | early INVALID waits for T; complete TWAP 0.42; incomplete waits to T+1h then 0.5 (new listing) or BLOCKED (legacy) | §8.4, DEC-08 |
| G16 | funding rate clamp and truncation toward zero, both signs | §4.4 |
| G17 | common pair tick clamp | §5.2 |
| G18 | fee-aware bankruptcy tick for a long full close: t ≥ 541 | §5.2 |
| G19 | positive equity plus a tiny caller budget gives NEEDS_MORE_WORK, never takeover | DEC-13 |
| G20 | mark median and linear band clamp b(t) | §4.1 |

## Assumptions used

- G13 uses assumption M-3 in `docs/merge/B-assumptions.md`: a sample is usable for a window end
  up to `observedAt + 30` inclusive; strictly later is stale.
- G07/G08 widen the Decimal result by about 1e-9 USDC; this width is the fixture bracket, not an
  implementation tolerance. The Solidity tolerance is declared in B015.

## What these cases do not prove

They check the spec's arithmetic for single points. They are not a proof of monotone envelopes,
not a Solidity result, and not calibration evidence.
