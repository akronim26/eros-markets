# CP-PRICE: Polymarket bot implementation preflight

Item: PF001-PF003 / CP-PRICE. Date: 2026-10-02.
Baseline: `250623536768101511999fd2223ba4ce38a6bdd3`.
Working branch: `pricefeed` (created at the human's explicit request).
Status: **OPEN / BLOCKED FOR BOT IMPLEMENTATION**. No approval is implied by this request.

## Purpose and scope

The human requested implementation of the Polymarket event price-feed plan on a
separate branch. The intended output is one configurable offchain collector and
signing service for explicitly approved sports, politics and crypto event-outcome
books, delivering observations through the existing `submitObservation` API.

CLAUDE.md currently excludes price-feed internals from this risk-team agent's
scope. Before bot code is created, the human must confirm the separate CP-PRICE
owner and permitted paths. Proposed paths: `packages/pricefeed/` and dedicated
price-feed documentation. This request itself follows CLAUDE.md's existing
`docs/requests/` route. It does not amend CLAUDE.md or authorize deployment.

Do not change risk contracts, internal A/B reviews, A043 fingerprints, gate
acceptance, the shared risk STATUS record, CLOB internals or oracle internals as
part of this proposed workstream. Do not push or merge this branch as a risk-team
handoff without explicit coordination.

## Verified destination contract

Sources: `contracts/src/interfaces/IPriceSource.sol`,
`contracts/src/pricing/PriceIngress.sol`, `docs/merge/B-assumptions.md` I-3,
`docs/spec/risk_spec.md` price authority and CP-PRICE boundary.

The input tuple, in order, is:

| Solidity type | Field |
|---|---|
| bytes32 | marketId |
| bytes32 | sourceId |
| uint64 | sequence |
| uint64 | observedAt |
| uint64 | publishedAt |
| uint256 | priceWad |
| uint256 | impactBidWad |
| uint256 | impactAskWad |
| uint256 | bidDepthLots |
| uint256 | askDepthLots |
| bytes32 | sourceRulesHash |

Times are Unix seconds, prices WAD, and one lot is 0.001 claim. `acceptedAt`,
`depthValid` and `payloadDigest` are emitted by the engine, not bot input fields.
The domain includes chain ID and the destination engine address.

The exact type string is one line with no added whitespace:

```text
Observation(bytes32 marketId,bytes32 sourceId,uint64 sequence,uint64 observedAt,uint64 publishedAt,uint256 priceWad,uint256 impactBidWad,uint256 impactAskWad,uint256 bidDepthLots,uint256 askDepthLots,bytes32 sourceRulesHash,uint256 chainId,address engine)
```

The digest is `keccak256(abi.encode(TYPEHASH, the eleven fields above, chainId,
engineAddress))`. It is not `abi.encodePacked`, personal-message signing,
EIP-191-prefixed signing or EIP-712 typed-data signing. The pinned source signer
must recover from that raw digest. No key or deployment address is proposed here.

Sequence increases strictly per source; observation time cannot go backwards;
`observedAt <= publishedAt <= acceptedAt`, with zero future tolerance. Delayed
acceptance does not refresh old data. A valid summary requires both sides to
cover the configured N, interior ordered prices and spread within the configured
limit. Its signed `priceWad` must equal `floor((impactBidWad + impactAskWad)/2)`.

The risk engine, not this bot, maintains the 300-second index TWAP, 30-second
sample freshness and separate INVALID history. The bot must not send BTC/USD,
scores or polling percentages in place of an event-outcome price.

## Required decisions and owners

All entries are OPEN. Record the deciding human/team, date, evidence and exact
policy; do not infer acceptance from this table or from an example fixture.

| ID | Owner to confirm | Required answer |
|---|---|---|
| Q01 | Human / CP-PRICE owner | Confirm the separate scope exception, owner, branch and permitted implementation paths. |
| Q02 | Risk + CP-PRICE | Is depth-N impact price quantity-weighted execution price or the marginal Nth-lot price? Specify bid/ask rounding, fee treatment and available-depth definition. |
| Q03 | Risk + CP-PRICE | Define evidence for Polymarket source time and conversion to observedAt; define publishedAt and handling of unchanged, delayed, future or untrusted-time snapshots. Never manufacture freshness. |
| Q04 | Risk + factory | Identify the canonical rules/mapping document and hashing format; distinguish sourceHash, rulesHash and indexRulesHash. |
| Q05 | Risk + CP-PRICE | Approve source quote normalization, price/size precision, executable minimum-size semantics and conservative claim-to-lot conversion. |
| Q06 | Oracle + listing | Approve the first exact event/outcome-token mapping, deadline and exception comparison, including cancellation/50-50, draws, runoff and rules clarification. |
| Q07 | Risk + operator | Approve measured capture/signing/relay headroom, metadata-age bound, cadence and delayed/coalesced-delivery policy. |
| Q08 | Risk + CP-PRICE | Specify invalid-summary fields and priority; determine safe handling of unavailable/untrusted source time without fabricating an observation timestamp. |
| Q09 | Production / factory | Provide the authorized chain/RPC, actual engine/code/ABI identity, signer backend, relay budget and finality/reorg policy before any live sends. |
| Q10 | Risk + production | Set source-soak/load/availability and retention targets, approve calibrated N/spread and operator ownership, and keep audit/release authorization separate. |

Please confirm I-3 explicitly. Existing code supplies the concrete wire format;
confirmation does not require inventing a new signature protocol.

## First implementation slice after the applicable approvals

1. Record scope and ownership; resolve the wire/method/time/hash/unit questions
   necessary for the item being started. Dependent items remain blocked until
   their decisions are recorded.
2. Create the independently derived fixtures and pinned package/test tooling in
   the authorized price-feed paths, with test-first development.
3. Add disabled category configurations, exact decimal/integer normalization and
   the approved impact calculator. No production N or spread default.
4. Add read-only complete-book capture, identity/time validation and evidence.
5. Add durable sequence/outbox state, raw signing and local real-ingress tests.
6. Only after separate approval, add relay/receipt recovery, source soak,
   calibration, hardening and counterpart handoff.

No incomplete live CLOB/oracle is needed for deterministic fixtures or approved
read-only collection. Their real implementations remain necessary for complete
economic/lifecycle integration. Risk G7 and human acceptance are separate.

## Evidence for this preparation turn

- CLAUDE.md, current risk STATUS, mandatory spec sections 1-5 and section 10,
  the plan's scope/milestones, IPriceSource and PriceIngress were read.
- `git fetch`: initial sandbox attempt exit 255 (read-only `.git/FETCH_HEAD`);
  authorized retry exit 0.
- HEAD and `origin/integration/risk` both resolved to the baseline above.
- `git switch -c pricefeed`: exit 0; only a local branch was created.
- Pre-existing untracked `contracts/foundry.lock` was preserved.
- No bot, signing vectors, risk regressions, live sends or deployments were
  implemented or claimed by this request. Documentation whitespace validation
  is recorded in the session report after it is actually run.

Next action: the human answers Q01; named reviewers resolve the dependent
interface decisions. PF001 is not accepted yet. This is a preparation request,
not a completed PF-G0 milestone or another team's approval.
