# RB-I02: preserve a reduce-only maker's own partial remainder

Status: implemented on `integration/risk`, pending independent teammate review. Severity: Low,
conservative liveness limitation. Order-book and Risk & Clearing changes were explicitly authorized
for this turn; no main merge, production release or review approval is implied.

## Observed mechanism

A's position version increments after every posting. RB-I01 now refreshes an active
reduce-only taker permit only after that permit's own successful posting and rechecks.
It also validates a new LIMIT remainder before resting it.

An existing maker node is different: Book updates its remaining size and fee cap after
a fill, but its stored `reduceVersion` remains the admission version. The next taker
therefore encounters a stale maker and prunes it, even if the surviving position still
permits a safe same-direction reduction. This does not authorize an unsafe fill or lose
funds, but it prevents useful remaining liquidity from executing.

Example: a trader long 1,000,000 lots rests a reduce-only sale of 500,000. One buyer
takes 250,000. A second buyer cannot consume the remaining 250,000 because the first
posting advanced the seller's position version. The seller is still long 750,000.

## Implemented coordinated repair

1. Extend the internal matched-fill result with the accepted maker post-fill version.
2. Risk returns it only after successful real accounting and post-fill checks.
3. Book updates only that surviving, successfully filled maker node. Preserve its exact
   slot/generation identity; do not update any other resting order.
4. Keep existing current-version checks before every fill. Never remove the equality
   guard, revive unrelated orders, or let Risk mutate Book topology directly.
5. Test repeated partial maker fills, exhausted reductions, unrelated intervening
   trades, a close/reopen lifecycle, stale epochs, fees, and second-fill rollback.
6. Obtain independent economic review and rerun the real-book and gate suites.

`StepResult.makerPostFillVersion` now carries the accepted version after actual paired accounting
and both post-fill rechecks. Book updates only the same surviving, non-clipped reduce-only node;
the mock adapter mirrors that handoff. No position-version or epoch guard was removed, and the
book storage layout did not change.

Tests-first evidence: `contracts/test/integration/MakerRemainder.t.sol` produced eight failures
and three passing controls before the repair (`tmp/rb-i02-red.log`), then all eleven passed with
pinned Forge 1.8.3 (`tmp/maker-policy-domain-red.log`; that combined run's remaining failures are
the separate RB-I07 domain regressions). Coverage includes long/short partial makers across
independent takers, unrelated stale orders and trades, close/reopen, account and halt epochs,
fee-cap conservation/cancel, no flip at flat, slot generation reuse and second-post rollback.
The independent review and broader gates remain separate acceptance steps; these local logs
are reproduction breadcrumbs, not checked-in release evidence or teammate approval.

An alternative separate sign-lifecycle nonce would affect A accounting and liquidation
fee bookkeeping more broadly. Do not change that counter casually as a shortcut.

## Separate release dependency

The concrete initial-1x engine has authenticated independent INDEX ingress, but no
reviewed production PERP depth sampler. A sampler must exclude stale/expired/unexecutable
orders, bound all examined nodes and levels, and reject insufficient provable depth.
Raw `touch()` or aggregated level sizes are not sufficient. Until that adapter exists,
the concrete engine intentionally remains fully backed/bootstrap-only.
