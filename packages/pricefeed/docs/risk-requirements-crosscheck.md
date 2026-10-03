# Pricefeed requirements cross-check against risk

Reviewed 03 October 2026 against the current local risk sources, risk specification,
handoff, B016/B017/B019 tests and existing package behavior. This is a code/doc
review, not a new Solidity test run or production acceptance.

| Requirement | Already fixed by risk | Remaining pricefeed/listing work |
|---|---|---|
| Wire/authentication | Exact eleven fields, raw ABI/Keccak observation digest, chain/engine domain, pinned signer/source, increasing sequence | Durable packet allocation, signing and relay |
| Q02 pricing | Both depths >= listing N; 0 < bid <= ask < WAD; spread <= listing maximum; valid price equals floor((bid + ask)/2) | User-selected before-fee VWAP and displayed-depth normalization are producer policies; risk does not walk venue books or certify fees/depth |
| Q03 clocks | Unix seconds; observedAt <= publishedAt <= acceptance block time; observedAt nondecreasing; freshness uses observedAt | Vendor timestamp meaning; enforce selected packet freeze and pre-send policy in production pipeline |
| Q04 hash | Listing indexRulesHash pinned to source state; signed sourceRulesHash must equal it | Canonical manifest and listing dossier; no missing risk hashing implementation |
| Q05 units | Price WAD is USDC per claim; depths are lots; one lot = 0.001 claim | Provider quote equivalence, precision and executable-size normalization |
| Q06 mapping | Eros market/source identity and immutable scheduledT are pinned | Exact Polymarket question/outcome/exception equivalence and closure handling; category labels do not establish equivalence |
| Q07 timing | 30-second carry; independent index TWAP requires full 300-second coverage | Poll/metadata/sign/relay budgets need measurements; 30 seconds is not an approved poll interval |
| Q08 invalid depth | Authenticated, ordered packets with failed depth/spread validity are accepted with depthValid=false and emitted midpoint zero; invalid checkpoints supply no coverage | Producer field representation and delivery priority; unavailable/untrusted source time cannot be invented |
| Q09 environment | Digest and signer interface fixed; sourceState and events support reconciliation | Actual chain/RPC/engine/key backend, finality, spend budget and send authority |
| Q10 lifecycle/release | Engine owns mark/funding and unpruned [T-24h,T] INVALID index record; disclosed fallback is engine-owned | Continuous collection through required window, calibrated N/spread, soak/recovery/operations and production release |

## Precision that matters

- `PriceIngress` does not reject a packet solely for being older than 30 seconds.
  It can accept delayed history with its original observedAt. Store validity and
  carry determine usable coverage. Our policy to stop stale valid-price sends is
  a conservative producer policy, not an additional ingress revert.
- The engine permits equal observedAt with a higher sequence. Same-second store
  samples replace the prior checkpoint without adding elapsed weight; repeated
  time never resets the 30-second carry. The collector also checks raw vendor
  milliseconds, so it can detect regressions hidden by flooring to seconds.
- Invalid depth is not an authentication failure or an oracle INVALID outcome.
  PriceIngress still enforces identity, signature, order and price bounds. It
  computes depthValid itself; that boolean is not an input field. The emitted
  zero midpoint is not a usable zero-priced observation.
- Silence permits only the existing bounded carry; an invalid checkpoint can
  terminate coverage at its observed time. Therefore “drop every invalid book”
  is not automatically equivalent to delivering invalid transitions.
- Risk does not recompute Polymarket VWAP, fees or rules manifests. Successful
  ingress proves conformance to the signed envelope and engine checks, not the
  external data's semantic truth.

## Evidence locations

- `contracts/src/interfaces/IPriceSource.sol`: wire fields, units, event.
- `contracts/src/pricing/PriceIngress.sol`: digest, authentication, ordering,
  depth handling and source pin.
- `contracts/src/pricing/ObservationStore.sol`: same-second replacement, carry,
  TWAP coverage and INVALID history.
- `contracts/src/math/PricingMath.sol`: impactMid and validity-weighted integrals.
- `contracts/src/risk/RiskContextPort.sol` and `interfaces/IMarketConfig.sol`:
  listing initialization, units/parameters and immutable pins.
- `contracts/src/settlement/InvalidPrice.sol`: engine-owned capture/fallback.
- `docs/spec/risk_spec.md` section 4.1 and `docs/risk/HANDOFF.md`: ownership and
  local-versus-production integration boundaries.

Risk-side answers above need no new design decision. The remaining external
mapping, policy and deployment inputs must not be described as unfinished risk
code. Package-only implementation can proceed against the fixed contract while
production inputs remain explicitly unfilled.
