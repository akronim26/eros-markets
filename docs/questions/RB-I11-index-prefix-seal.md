# RB-I11: seal INDEX history before publishing book-derived PERP

Date: 2026-10-03. Status: **IMPLEMENTED at `dcb6b0e`; sampler 21/21, full CI 832/832 and Monad 99/99 pass; G0–G7 pass and user-authorized G7 acceptance is recorded.**

The user retired separate A/B ownership and mandatory peer review and delegated implementation
decisions to the unified Risk and Order Book team. We select the strict INDEX-prefix seal below,
with unchanged bootstrap availability and the documented feed-cadence tradeoff. This is our
documented engineering decision, not a claim that the user explicitly reviewed this algorithm.
See `docs/merge/UNIFIED_WORKFLOW.md`. This is unified-team technical work, not an independent
security audit, production approval or a new deployment.

## Historical defect and scope

The following describes the pre-fix source at `4a050df`; the concrete sampler now applies the
strict publication condition described below. Generic observation-store semantics are unchanged.

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
   allowed by the pre-fix prior-block policy on a subsecond chain; it leaves no newer pending
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

## Implemented concrete-sampler policy

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
window endpoint has zero elapsed weight under the existing integral semantics; this change
does not silently change that rule or restart a stopped funding epoch.

The generic `ObservationStore` retains its monotone per-series append/same-second-replacement
model and does not retroactively correct historical BASIS. This change prevents the discrepancy on the
concrete engine's only production PERP publication route; it does not claim a general correction
algorithm for other compositions or test harnesses that call `_recordPerp` directly. It neither
changes existing authenticated INDEX ingress semantics nor alters accounting/funding rules.

## Accepted engineering tradeoff

The sampler must wait for an INDEX observation strictly later than the captured second. A source
publishing only every 30 seconds can leave a promoted PERP already at age 30, usable only at that
boundary second and stale immediately afterward. Continuous normal pricing therefore needs an
operational cadence comfortably below 30 seconds, with time left for later-block promotion; the
existing 10-second fixture cadence is one test example, not a production service guarantee.

Fresh-INDEX fully backed startup placement, matching and cancellation must remain available
before any PERP promotion. Waiting for a seal may delay normal-pricing warm-up but must not gate
bootstrap startup. No calibration, leverage, funding or production approval follows.

## Regression scope

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

## Implementation and evidence

`BookRiskEngine.samplePerp` evaluates the existing block, age, Book revision, market/risk epoch,
capture-time INDEX checkpoint and current eligible-depth guards before considering a wait.
Only an otherwise publishable candidate may return false while retaining its exact pending state
when the pinned source has not advanced strictly past its capture time. This return writes no
PERP/BASIS checkpoint and does not take a new capture. Invalid/expired candidates still record
unavailability at their original time; halted markets discard pending state. No external calls,
new caller-controlled fields or changes to authenticated INDEX ingress were added.

Tests were added before the source repair. `tmp/rb-i11-red.log` records **18 passing / 3 failing**
sampler tests: old code prematurely published an unsealed capture, published while a capture was
waiting before mutation, and failed to preserve the original waiting/expiry semantics. The first
green run (`tmp/rb-i11-green.log`) passes **21/21**. A separate Monad targeted run passes **99 tests
in 11 suites**, including gas fixtures with a genuinely signed newer INDEX checkpoint outside the
measured sampler call. These checks are local and do not sum to a separate unique-test total.

The sealed-publication test also rejects authenticated corrections at and before capture, then
accepts a replacement at the newer seal timestamp. It compares the original BASIS's ten covered
seconds and zero integral before/after, with unchanged PERP/BASIS checkpoint counts; the 900-second
window is explicitly unavailable, not falsely described as warmed. The strengthened rerun passes
**21/21** (`tmp/rb-i11-final.log`), and the source/tests are committed at `dcb6b0e`.

The completed validation baseline is `e05bbbb8ac632b35ba15ac2da0e56bd63eec21e4`, with Solidity
unchanged from `dcb6b0e`. Full CI passes **832 tests / 130 suites**, zero failed/skipped, in
1,461.88 seconds (`tmp/unified-full-ci.log`): 10,000 fuzz runs, seed `0x45524f53`, and invariants
configured for 256 runs at depth 128. The final separate Monad bundle passes **99 tests / 11
suites** in 3.04 seconds (`tmp/unified-monad-final.log`). Python passes **237 tests** across
A/B/audit/integration (66/156/8/7); SDK compilation and six Node tests pass. Format and ABI
export/check exit zero, with 294 concrete / 256 abstract / 35 vault entries. Counts are not additive.

Current compiled runtime is **120,402 bytes**; creation bytecode is **129,644 bytes** plus **928
constructor bytes**, giving **130,572-byte initcode**. Read-only public-testnet estimation using
the historical fixture dependencies succeeds at **27,853,253 gas**, block **67,886,057**;
see `artifacts/risk/unified-deployment-estimate-2026-10-03.json`. No new deployment was broadcast.
Ordered G0–G7 exit zero with no skipped checks at `c91acf75ae9770f0bf5ae2238b4018202d57acd8`,
with counts **88/152/117/78/77/63/55/156**. Source-bound A043/B043 checks pass **68/3** respectively.
The user's explicitly authorized G7 acceptance is recorded in `docs/spec/gate_status.json` at
**2026-10-03 17:39:11 UTC**, with `reviewed_by: []`. Aggregate evidence:
`artifacts/risk/unified-integration-2026-10-03.json`. Technical runners still emit
`accepted=false` and `merge_sha=null`; human acceptance is a separate record, not peer approval.
The accepted scope is the unified non-oracle local integration candidate. Production inputs
remain unresolved, oracle integration remains excluded, and no main merge or new deployment occurred.
