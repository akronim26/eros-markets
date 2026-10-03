# Q02: impact-price decision for owner review

Status: USER-SELECTED POLICY; named counterpart review pending.
Prepared 03 October 2026. Owners: risk and CP-PRICE. Policy version: pricing-v1.
The user selected VWAP with conservative rounding on 03 October 2026 in the
conversation: "ok we will go with that". This closes the user-facing method and
price-rounding selection. The user subsequently accepted quoted book prices
before fees and validated two-sided displayed depth: "ok we will proceed with that".
The selected method/rounding/fee/depth definition is recorded below. Production
N/spread, named counterpart acceptance and release approval remain separate.

## Selected method and rounding

Use the quantity-weighted average execution price for exactly N claims on each
side, walking bids descending and asks ascending with a partial final level when
needed. Floor impact bid, ceil impact ask and floor the valid midpoint. This is
the existing diagnostic `vwap` branch in `src/book.ts`; no calculator code change
is required by this selection. Marginal remains available for comparison only.

## Selected fee and depth definition

Use quoted book prices before venue fees in signed impact summaries. Excluding
fees from the index does not assume the venue charges zero: venue fees remain
separate execution-cost/calibration evidence and are not deducted from displayed
claim quantities. The service is a collector, not a Polymarket trading bot.

Depth means the validated positive displayed quantity on each side of a fresh,
complete book for the approved outcome token. Sort bids descending and asks
ascending; aggregate equal-price levels exactly, preserving fractional claims.
Consume exactly N claims, including a partial final level. Floor each side's total
claims multiplied by 1,000 only when reporting depth lots. Do not floor each level
before aggregation or round total depth upward. Both sides must support N.

N must satisfy the source's applicable minimum order size and quantity constraints;
prices must satisfy its tick grid. Keep minimum/tick data market-specific rather
than hardcoding a category default. Sub-minimum residual levels are not discarded
merely because a new order has a minimum-size requirement: the selected check is
on the complete N-sized quantity walk. Malformed/incomplete books do not produce
trustworthy valid depth. Reported depth is snapshot evidence, not a later-fill
guarantee.

`src/book.ts` already implements before-fee VWAP, complete two-sided quantity
walks, duplicate aggregation, partial final levels, minimum-size/tick checks and
floor-total lot conversion. Provider-specific tradable quantity precision still
belongs in the Q05 normalization contract; the parser's 18-decimal limit alone
does not certify the venue accepts every possible N-sized order.

Provider references checked 03 October 2026:
[fees](https://docs.polymarket.com/trading/fees) and
[order books](https://docs.polymarket.com/market-data/prices-order-books).
These document provider inputs; the before-fee index treatment is the explicit
user-selected Eros policy, not a provider requirement.

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

## Selected answers and remaining integration

1. Method/rounding selected by the user: VWAP, floor bid, ceil ask, floor midpoint.
2. Fee/depth selected by the user: before-fee quoted prices, complete two-sided
   displayed depth, fractional aggregation and floor-total lots, with source
   minimum-size/tick/quantity constraints respected. Quote normalization and
   provider-specific quantity precision are tracked separately under Q05.
3. Bind the complete policy to the Q04 canonical rules document and record named
   counterpart review. Calibration of actual N/spread
   follows measurements under Q10 and is not settled by selecting the method.

Verification on 03 October 2026: `npm run test:reference` exited 0 (144 independent
Fraction vectors, seed 20261002); the existing compiled math suite exited 0 with
147 tests and zero failed/skipped/cancelled/todo tests. The 144 vector cases are
included within those 147 tests, not 144 additional tests. No source code changed.

After fee/depth selection, added explicit source-minimum checks at N=4,999/5,000/
5,001 lots and a fractional-residual case proving 5.0008 claims cannot be reported
as 5,001 lots. `npm test` exited 0: 172 package tests, zero failed/skipped/
cancelled/todo tests. Fraction reference check and current wire comparison also
exited 0. The 144 arithmetic vectors are included in the package count. No new
local-chain or live-source demo was run and no runtime calculator change was needed.
