# RB-I11: seal INDEX history before publishing book-derived PERP

Date: 2026-10-03. Status: **POLICY CHOICE PENDING; no production change authorized by this document.**

## Confirmed behavior and scope

`PriceIngress._ingest` authenticates the configured INDEX source, requires increasing sequence
numbers and permits nondecreasing `observedAt`. A higher-sequence sample may therefore replace
the latest INDEX checkpoint at the same observation second. A newly accepted delayed checkpoint
may also fall after the latest INDEX checkpoint but at or before an already published PERP time.

`ObservationStore._recordPerp` computes BASIS once from the INDEX value then known at the PERP
capture time. `_onIndexObservation` updates INDEX, not previously stored BASIS. The sampler's
pending-checkpoint fingerprint detects a correction before promotion, but is no longer checked
after that observation has been published.

Consequently a later authenticated INDEX correction can leave retained BASIS based on the former
INDEX history. This storage behavior predates the sampler: the generic store and same-second
INDEX replacement are existing B017 behavior (`29a9b45`). It is not an unauthenticated feed bypass.
The existing reference `reference/b/pricing.py::basis_samples` recomputes contemporaneous INDEX
from the supplied final history and can produce a different result. The specification does not
explicitly select cross-series correction versus immutable accepted-basis provenance semantics.

## Exact fresh-window counterexample

Use relative times within an already warmed NORMAL_PRICING accounting epoch, sufficiently far
from T that the mark band does not bind. All depth samples have sufficient valid bid/ask depth.

1. INDEX is 0.50 every 30 seconds through time 900.
2. PERP is 0.49 every 30 seconds through time 870, then 0.51 at time 900.
3. Capture time 900 and promote it in a later block with the same integer timestamp. This is
   allowed by the current prior-block policy on a subsecond chain; it leaves no newer pending
   capture at that same timestamp. BASIS at 900 is stored as 0.51 - 0.50 = 0.01.
4. Accept a correctly signed, higher-sequence INDEX replacement with `observedAt = 900` and
   price 0.60. The configured source must authorize this payload; a caller cannot invent it.
5. At time 930 all three required time windows are fully covered, and live PERP has age 30.

The updated INDEX 300-second TWAP is 0.51, PERP 60-second TWAP is 0.50 and live PERP is 0.51.
The stored BASIS window is `(-0.01 * 870 + 0.01 * 30) / 900`; recomputing against corrected
INDEX instead gives `(-0.01 * 870 - 0.09 * 30) / 900`.

| Value, wad with the existing floor rule | Stored BASIS history | Recomputed BASIS history |
|---|---:|---:|
| BASIS 900-second TWAP | -9,333,333,333,333,334 | -12,666,666,666,666,667 |
| Resulting unclamped median mark | 500,666,666,666,666,666 | 500,000,000,000,000,000 |

The price movement is exactly 0.10, so the existing strict-greater-than movement trigger does
not fire. The difference is **666,666,666,666,666 wad units**, approximately 0.00066667 per claim.
These values were independently checked with the existing Python reference using `python -B`
and its `twap`, `basis_samples` and `mark` functions. No new Forge regression or live exploit
execution is claimed by this read-only assessment.

This proves a fresh-mark coherence difference under signer-authorized correction or ordering of
already signed payloads. It does not demonstrate unauthorized fund extraction in the current
immutable-cap-1, funding-disabled, uncalibrated concrete engine. A constant PERP TWAP/live pair
would also mask this particular mark difference through the median. Future calibrated pricing
must not assume the discrepancy is always masked.

## Proposed concrete-sampler policy

Before promoting a pending book capture, additionally require:

```text
configured INDEX source.lastObservedAt > pending.observedAt
```

This seals the entire INDEX prefix through the capture time: ingress cannot subsequently accept
a checkpoint at or before that time because `observedAt` cannot go backwards. Replacing a later
checkpoint at its own second cannot change the sealed predecessor used for capture-time BASIS.
Only the pinned INDEX source matters; an unrelated source must not satisfy this condition.

Retain the existing later-block rule, maximum 30-second capture age, original observation time,
book revision, market/risk epoch, capture-time INDEX fingerprint and current depth/account
eligibility checks. If a still-valid, unchanged capture is merely waiting for its prefix to be
sealed, preserve it rather than marking it invalid or replacing it with a newer moving target.
An expired capture or one invalidated by an existing guard must not be renewed or relabeled fresh.

A later **invalid** INDEX observation still makes the earlier prefix immutable, but is not
evidence that current INDEX is usable. Existing current-context checks and capture-time BASIS
validity remain mandatory. Where an invalid sample affects a positive-duration part of the
current INDEX window, normal pricing remains unavailable. An invalid checkpoint exactly at the
window endpoint has zero elapsed weight under the existing integral semantics; this proposal
does not silently change that rule or restart a stopped funding epoch.

The generic `ObservationStore` retains its monotone per-series append/same-second-replacement
model and does not retroactively correct historical BASIS. This proposal prevents the discrepancy on the
concrete engine's only production PERP publication route; it does not claim a general correction
algorithm for other compositions or test harnesses that call `_recordPerp` directly. It neither
changes existing authenticated INDEX ingress semantics nor alters accounting/funding rules.

## Availability tradeoff requiring approval

The sampler must wait for an INDEX observation strictly later than the captured second. A source
publishing only every 30 seconds can leave a promoted PERP already at age 30, usable only at that
boundary second and stale immediately afterward. Continuous normal pricing therefore needs an
operational cadence comfortably below 30 seconds, with time left for later-block promotion; the
existing 10-second fixture cadence is one test example, not a production service guarantee.

Fresh-INDEX fully backed startup placement, matching and cancellation must remain available
before any PERP promotion. Waiting for a seal may delay normal-pricing warm-up but must not gate
bootstrap startup. No calibration, leverage, funding or production approval follows.

## Bounded regression plan after a decision

- Capture remains unpublished across later blocks until the pinned INDEX prefix is sealed;
  unchanged retries preserve its original time and eventually promote without starvation.
- Capture-time replacement or delayed backfill before sealing invalidates the pending capture;
  after promotion, authenticated attempts at `observedAt <= capture` fail the existing ingress
  backwards-time guard and cannot alter published BASIS provenance.
- Strictly newer valid INDEX permits promotion; a later same-time replacement of that newer
  checkpoint cannot modify the sealed prefix. Newer invalid INDEX must not bypass current
  pricing/window checks or make capture-time invalid BASIS valid.
- Waiting beyond 30 seconds cannot publish or renew the expired capture. Book/account/profile/
  epoch changes while waiting still invalidate it. Preserve no-same-block publication and
  strictly increasing capture seconds.
- Keep cold bootstrap place/fill/cancel controls and full-window, epoch-only normal transition
  tests under a sufficiently frequent signed-INDEX fixture; remeasure bounded sampling gas and
  refresh affected full-suite/gate/ABI evidence without claiming human approval.
