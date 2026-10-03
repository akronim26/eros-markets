# Q02: impact-price decision for owner review

Status: OPEN. Prepared 03 October 2026. Owners: risk and CP-PRICE.
No production method, N, spread or fee convention is approved by this document.

The existing engine accepts signed depth summaries; it does not walk the
Polymarket book or choose VWAP versus marginal pricing. Both methods are
implemented and tested as explicit diagnostic branches in `src/book.ts`.
The selection must be versioned in the reviewed source policy and bound by the
engine-pinned rules hash. The same selected policy must be used for both sides.

## Concrete difference

Illustrative plan vector: N = 10 claims (10,000 lots), spread limit 0.05.
Sell against bids: 6 claims at 0.60, then 4 at 0.58.
Buy against asks: 6 claims at 0.62, then 4 at 0.64.

| Method | Meaning | Impact bid | Impact ask | Arithmetic midpoint | Spread | Valid at 0.05 |
|---|---|---|---|---|---|---|
| VWAP | Average execution price of all N claims | 0.592 | 0.628 | 0.610 | 0.036 | Yes |
| Marginal | Price of the level that completes N | 0.580 | 0.640 | 0.610 | 0.060 | No |

The marginal arithmetic midpoint in this comparison is not a valid output price:
the engine records midpoint zero and `depthValid=false` when its spread/depth
checks fail. Operational invalid-packet representation still requires Q08.
Neither N nor the spread limit in this example is a production recommendation.

Independent Python Fraction arithmetic gives VWAP bid 74/125, ask 157/250,
midpoint 61/100 and spread 9/250; marginal spread is 3/50. The existing package
arithmetic tests reproduce both branches and the differing validity result.

## Answers required to close Q02

1. Select VWAP or marginal at depth N for the approved source policy.
2. Confirm directed rounding: the diagnostic VWAP branch floors bids, ceils asks
   and floors midpoint; the marginal branch uses the exact completing level.
3. Define executable depth, source minimum-size constraints and fee treatment.
   Quote/quantity normalization is also tracked under Q05.
4. Record approving owner, date and policy version. Calibration of actual N/spread
   follows measurements under Q10 and is not settled by selecting the method.

Verification on 03 October 2026: `npm run test:reference` exited 0 (144 independent
Fraction vectors, seed 20261002); the existing compiled math suite exited 0 with
147 tests and zero failed/skipped/cancelled/todo tests. The 144 vector cases are
included within those 147 tests, not 144 additional tests. No source code changed.
