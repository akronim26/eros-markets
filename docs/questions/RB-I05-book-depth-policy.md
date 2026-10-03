# RB-I05 — bounded book-derived PERP observation policy

Status: **IMPLEMENTED LOCALLY, RB-I11 OPEN — post-publication INDEX correction coherence is unresolved; proposed prefix-sealing policy awaits user confirmation.**
Date: 2026-10-03. Base: `1958aef`, `integration/risk`.

## Existing contract and the missing choice

Spec section 4.1 requires an impact-mid PERP observation with both sides able to price immutable
depth N, valid spread, 30-second freshness, PERP 60-second and basis 900-second time integrals.
The independent INDEX remains separate. Normal pricing activates only at a completed accounting
epoch with every required window valid. The concrete engine at `1958aef` had no book-to-PERP sampler.

The spec does not freeze (a) executable-depth VWAP versus the terminal Nth-lot tick as the meaning
of impact bid/ask, (b) the sampler's examined-node cap, or (c) a prior-block publication rule.
These affect observed prices and availability and must not be chosen silently.

## Accepted conservative initial policy

1. **Exact depth VWAP:** scan price-time priority, consume exactly N lots per side, and compute
   executable notional divided by N. Round impact bid down and impact ask up to wad precision,
   then apply the existing spread/impact-mid validity rule. Missing N on either side is invalid,
   never extrapolated from a smaller displayed quantity or a midpoint of best levels.
2. **64 total examined orders:** a fixed shared budget across bid and ask FIFO traversal; stale,
   expired, rejected and eligible nodes all count. Bitmap traversal is bounded by the fixed four
   words per side; each visited populated level must consume an examined node. Exhaustion before
   both sides reach N yields invalid depth, not an optimistic quote. Bid-first ordering is explicit
   and may conservatively suppress observations when dirty bid queues exhaust the budget.
3. **Conservative executable subset:** exclude dead/unregistered/expired orders, mismatched full
   market/account epochs, and makers whose projected current reservation envelope is not fully
   backed or market-covered. Initially exclude every reduce-only order instead of independently
   counting several orders against the same shared reducible position. Exclude observations when
   the engine is inactive, halted, in a reconciliation sweep or in a stronger reduce-only stage.
   This may report unavailable despite some executable liquidity; it must never invent liquidity.
4. **Capture, then later-block promotion:** capture a bounded quote from actual engine storage,
   with no caller-supplied price, depth or timestamp. Promote only in a later block, at age at most
   30 seconds, after confirming unchanged book mutation generation and market/risk epoch and
   re-evaluating current eligibility/depth. Any intervening book-side mutation invalidates the
   pending capture, even if an aggregate displayed price later returns to the same value.
5. **No freshness laundering:** accepted `observedAt` remains the original capture timestamp,
   not promotion time. BASIS uses the contemporaneous independent index at capture; a new index,
   profile, accrued balance or release must not silently validate an old ineligible capture.
   Store/compare capture provenance and recheck current eligibility. Invalid or expired captures
   must not extend valid TWAP coverage, and no sample can revive a stopped funding epoch.
6. **No release expansion:** keep immutable cap 1, funding/recovery disabled, zero trading fees
   and missing-calibration full backing. Completing normal PERP price windows does not authorize
   leverage, calibrated liquidation, production oracle/feed use, or a production deployment.

## Alternatives requiring an explicit decision

- Terminal Nth-lot impact tick instead of VWAP changes the price rather than just rounding it.
- A per-side 64-node cap doubles worst-case examinations relative to the proposed total cap.
- Counting reduce-only liquidity requires bounded per-owner shared reduction budgeting and the
  same no-flip, positive-equity, maintenance-shortfall and fee predicates as execution. Independent
  per-order clipping is insufficient and can count one position several times.
- Immediate same-block publication has a smaller keeper workflow but permits a single transaction
  to create depth, publish its own price and consume it. Prior-block maturity is a proposed defense,
  not a previously specified economic requirement or complete manipulation resistance.

## Required evidence before enabling

- Independent hand-derived multi-level VWAP/rounding vectors; exact N and insufficient-depth cases.
- Stale market/account epochs, expiry boundaries, canceled/recycled nodes, under-backed makers,
  reduce-only exclusion, and dirty-queue budget exhaustion without a 65th node examination.
- Same-block capture/promotion rejection; capture invalidated by either-side book mutation and
  relevant account/source/profile changes; expiry retains original observation time.
- Full INDEX/PERP/BASIS warm-up, missing-data gaps, epoch-only normal-mode transition and no
  unintended leverage/funding enablement; no caller-selected prices or external callbacks.
- Actual composed runtime/initcode and Monad deployment/sampling gas measured with the pinned
  toolchain. Existing engine baseline is 114,546 runtime bytes and 27,904,929 deployment gas;
  remaining headroom below 131,072 bytes / 30,000,000 gas is a hard constraint, not assumed.
- Independent teammate review of economic effects and source-bound evidence. No approval or
  review fingerprint is created by this proposal.

## Decision record

The user accepted the conservative policy on 2026-10-03, conditional on preserving basic startup:
fully backed bootstrap placement, matching and cancellation remain available with a fresh valid
independent INDEX before PERP windows exist. Sampler readiness gates normal pricing, not startup.
The accepted choices are VWAP, 64 total examined nodes, later-block promotion and exclusion of
reduce-only depth. No calibration, leverage/funding activation or production approval follows.

To avoid starvation when collectors publish before keepers, promotion compares the INDEX
checkpoint at the original capture timestamp, not the latest source sequence. Later observations
with newer observedAt may coexist; replacing or backfilling the capture-time checkpoint rejects
promotion. Current projected account/depth eligibility and book/market/risk versions are still
rechecked. These guards cover pending captures, not INDEX corrections accepted after publication;
the open issue below limits the guarantee.

## Open follow-up: RB-I11 INDEX/BASIS coherence

At source `4a050df`, authenticated ingress still permits same-time INDEX replacement and delayed
checkpoints after the latest source time. A correction arriving after PERP publication can alter
INDEX history at that capture time without recomputing already stored BASIS. Passing existing
tests does not resolve this known coherence issue. See the exact reference counterexample and
decision request in `docs/questions/RB-I11-index-prefix-seal.md`.

The proposed additional rule is `INDEX source.lastObservedAt > pending.observedAt` before
publication, preserving an otherwise valid, unexpired pending capture while waiting. Existing
monotone ingress would then prevent later corrections to the sealed capture-time prefix.
**This rule is not implemented or approved yet.** No sampler source was changed for RB-I11.

This proposal requires INDEX updates comfortably faster than 30 seconds for continuous normal
pricing, for example a tested 10-second cadence with inclusion slack. A source updating exactly
every 30 seconds can seal a capture only as it reaches the age limit, leaving it stale the next
second. The proposed delay gates normal-pricing warm-up, not fresh-INDEX fully backed bootstrap
placement, matching or cancellation. The full CI pass below does not resolve this known issue.
Ordered G0-G6 now pass, but G7 is blocked by stale source-bound A043 review. Independent economic
review and human gate acceptance remain pending; no production approval or fingerprint is implied.

## Local implementation evidence

`contracts/src/pricing/BookDepthSampler.sol` implements the bounded traversal, and
`contracts/src/engine/BookRiskEngine.sol` exposes permissionless `bookDepth()` and `samplePerp()`.
Implementation commit: `3942100`. Follow-up execution/batch bounds: `be3db1e`.
The first floor-boundary invalidation is predicted without sampling liquidity that the next Book
action must invalidate. Captures use strictly increasing seconds, so a second call at the same
timestamp cannot later replace an already published historical observation.

With pinned Forge 1.8.3, the affected-suite run in `tmp/rb-i05-green.log` exits zero:
83 passed, zero failed/skipped, including all 16 dedicated `BookDepthSamplerTest` cases.
Coverage includes independent N=3 floor/ceil vectors, cold-start place/match/cancel, multi-level
VWAP, bounded dirty queues, original observation time, source replacement, account mutation,
first-floor exclusion and a full-window epoch transition followed by thin-book fallback.
The original nine concrete-engine tests remain separate, not inherited duplicate test runs.

That initial sampler run measured 119,929 runtime bytes and 129,170 creation bytes before
constructor arguments. After the execution/batch bound repair, the concrete engine measures
**120,253 runtime bytes**, **129,495 creation bytes**, and **130,423 initcode bytes** including
928 constructor bytes. The read-only public-testnet estimate at block **67,865,259** succeeds
at **27,820,847 gas**; evidence is `artifacts/risk/non-oracle-deployment-estimate-2026-10-03.json`.
This is an estimate for the rebuilt source and selected constructor state, not a deployment receipt.

The final targeted Monad run passes **92/92** at validation source `1654b9f`
(`tmp/non-oracle-monad-final.log`); production code is unchanged from `be3db1e`. The two added
full-history sampler tests cover 64-node bootstrap and normal modes with populated observation
rings. Measured worst cases are **3,383,491 gas for capture**, **3,290,777 for promotion**, and
**3,143,792 for the view** under Monad execution. These are local call measurements, not receipts.
The full risk run at `1654b9f`, before later RB-I08 additions, passes 818 tests in 128 suites.
Full CI at `4a050df` passes **825 tests in 129 suites**, zero failed/skipped, in 1,469.81 seconds
(`tmp/non-oracle-full-ci.log`): 10,000 fuzz runs with seed `0x45524f53`, invariant runs 256 and
depth 128. Ordered G0-G6 at `4a050df` exit 0 with counts 71/152/117/78/77/63/55. G7 exits 2
after six tests because A043 does not cover the current source and review regressions.
Separate A044/B040/B041/B042/B043/B044 checks exit 0 (44/2/2/3/1/1 tests), and direct G7 Solidity
passes six tests in two suites. These are not an ordered G7 pass or new peer approval.
Format and ABI checks exit 0. ABI export/check passes at `aaf700c` (294 concrete,
256 abstract, 35 vault entries). Do not sum overlapping runs or treat ABI export as peer review.
Independent teammate economic review and human G7 acceptance remain outstanding.
Current consolidated evidence: `artifacts/risk/non-oracle-fixes-2026-10-03.json`.

The sampler's **64-node** read budget is separate from concrete matching's `maxFills() == 8`.
The concrete Book batch accepts at most eight total cancel/place actions and an aggregate
requested non-POST_ONLY `maxFills` of at most eight. Split larger execution work across separate
transactions, not a multicall that assumes each individually bounded call fits the combined
transaction gas ceiling. None of these execution limits changes immutable depth N or sampler64.

The previously deployed, terminal smoke engine does not acquire these changes. No replacement
was broadcast. Operational maintenance is in `docs/runbooks/monad-risk-book-testnet.md`; the
current non-oracle work and qualification ledger is `docs/integration/NON_ORACLE_FIXES.md`.
