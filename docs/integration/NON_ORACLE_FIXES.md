# Non-oracle risk and order-book fixes

Started 2026-10-03 from `1958aef` on `integration/risk`.
Current recorded source: `4a050df`. **RB-I11 remains open; this is not an all-findings-fixed record.**

The user explicitly authorized this turn to fix order-book internals and all Risk & Clearing
work, including Person B's modules. Oracle implementation and oracle-branch integration are
excluded. This extends the older book ownership restriction for this work; it does not authorize
production deployment, invented calibration, another person's approval, or a push to main.

## Fix ledger

| ID | Problem | Work / evidence status |
|---|---|---|
| RB-I02 | A reduce-only maker's own partial fill makes its surviving node stale | Implemented in `857b5c0`; 11 real-ledger regressions pass; refresh only the successfully filled surviving node after accounting and coverage checks |
| RB-I03 | First order from a funded account scans up to 1,024 participants to find its canonical ID | Canonical registry mapping in `bd9d5b9`; four new identity tests plus existing A016 pass; concrete O(1) consumer committed with `3942100` |
| RB-I04 | A bootstrap maker's execution price is not rechecked against the current independent-index band | Implemented in `93e971e`; five actual-book regressions pass, including reduce-only maker depth outside the shifted band; prune only that candidate |
| RB-I05 | No bounded, stale-aware concrete PERP depth observation path | Implemented in `3942100`; 16 sampler tests pass, including the independently identified and repaired unsynchronized backing-floor invalidation boundary; full CI and G0-G6 technical reruns pass at `4a050df`, independent teammate acceptance pending; RB-I11 remains open |
| RB-I06 | Old ordinary maker orders can open new maker exposure after the market enters reduce-only | Implemented in `9c3a2e0`; four actual-book stage regressions pass; explicit reduce-only orders retain their reduction checks |
| RB-I07 | Unsupported hazards or price-band domains can reach downstream arithmetic | Implemented in `0c93b63`; seven domain regressions pass; reject hazards above one wad at initialization, governance staging and monitor raise, and reject listing band/spread above one wad |
| RB-I08 | Whether otherwise safe collateral release is permitted during REDUCE_ONLY is ambiguous | User accepted preserving existing safe-excess-release behavior; committed in `4a050df` with seven passing policy regressions and no production behavior change |
| RB-I09 | Concrete matching and aggregate batch work exceed a bounded transaction budget | Implemented in `be3db1e`, full-history fixtures committed in `1654b9f`: concrete matching cap 8, at most 8 batch actions and 8 total declared matching steps; batch/full-history MonadTen/full CI and G0-G6 technical reruns pass; independent review pending |
| RB-I10 | SDK type-check tooling needs an exact locally reproducible compiler pin | Implemented in `56787d2`: exact local TypeScript 5.9.3 pin and three Python regressions; Python A now 49 and combined Python suites 220 pass; G0 technical rerun passes with 71 tests |
| RB-I11 | Authenticated historical INDEX correction after PERP promotion can leave BASIS based on the former INDEX history | **OPEN: policy confirmation pending, not implemented**; strict INDEX-prefix seal proposed in `docs/questions/RB-I11-index-prefix-seal.md`; current pending-capture fingerprint does not seal already published observations |

Each completed item must record its implementation commit, regression result, affected modules
and remaining limitations here. Failed tests and unfinished work are not marked complete.

RB-I02 changes `IBookRiskHooks.StepResult`, `Book`, `BookRiskAdapter` and matching mocks;
the returned post-fill version applies only to the exact surviving maker node, not other orders.
RB-I03 changes the append-only account registry/storage and its concrete book lookup.
RB-I04 changes `BookRiskAdapter`; RB-I06 changes `OrderAdmission`; RB-I07 changes
`RiskContextPort` and `MonitorPolicy`. Independent teammate acceptance remains pending for
these economic/interface changes; an implementation commit is not reviewer approval.

The approved RB-I05 policy is exact-N VWAP with bid-down/ask-up rounding, a shared 64-node
budget, all reduce-only depth excluded, and later-block promotion with original observation
time and source/account/book provenance rechecked. See the full
[decision record](../questions/RB-I05-book-depth-policy.md). Approval is conditional on
preserving fresh-INDEX fully backed startup placement, matching and cancellation before
PERP warm-up. It does not enable leverage, funding, invented calibration or production release.

RB-I11 is a later review finding, not closed by RB-I05's passing tests. The confirmed numerical
counterexample concerns existing cross-series correction behavior after an authenticated INDEX
replacement; it is not evidence of unauthenticated forgery or demonstrated fund extraction in
the cap-1/funding-disabled engine. The proposed seal would require the pinned INDEX source's
`lastObservedAt` to exceed the capture time before promotion. This changes normal-pricing
availability and needs an explicit user decision; a 30-second-only feed can leave promoted PERP
at its freshness boundary. No production seal or new regression pass is claimed. See the
[finding, proposal and cadence tradeoff](../questions/RB-I11-index-prefix-seal.md).

RB-I09 retains the failed 64-maker characterization: the original call consumed 58,109,534 gas
under default Prague, and **30,994,601 under MonadTen**, exceeding the 30M transaction limit
before intrinsic gas. The concrete engine now sets `maxFills = 8`. Generic Book batches allow
at most `min(32, maxFills)` total cancel/place actions, and the sum of declared `maxFills` for
non-POST_ONLY placements cannot exceed the book's matching cap. Bounds are checked before
any cancellation or placement. POST_ONLY actions still count toward the action bound; their
matching budget is zero. The independent sampler budget remains **64 examined nodes**, not 8.
The batch regression started with five failures and two passing controls, then passed all seven
after repair. This is a supported-work limit, not a claim that 64 concrete fills fit.

## Validation plan

- Reproduce each defect before repair; retain stale-order, no-flip, both-outcome coverage and rollback tests.
- Run targeted suites, the full risk profile, Python reference suites and ordered G0-G7.
- Run current CI fuzz/invariant campaigns and book gas checks; explain any snapshot changes.
- Recheck concrete runtime/initcode sizes and Monad deployment/operation gas after source changes.
- Refresh ABI exports and the living `RISK_BOOK_TRACKER.md` without replacing historical live receipts.
- Record independent implementation review separately from human/team approval. G7 acceptance remains human-only.

## Not silently substituted

- The prior deployed smoke market is closed and immutable; new source does not update its bytecode.
- Real oracle integration is excluded by the user. No oracle mock counts as the live oracle.
- A production independent INDEX collector, calibration data, governance/timelock configuration and
  registry/factory handshake require actual inputs and counterpart decisions, not guessed defaults.
- Funding, leverage and conversion release defaults remain unchanged unless separately approved.

## Final evidence

The full local risk run at `1654b9f` passes **818/818**, **128 suites**, zero failures/skips,
with 1,000 fuzz runs and 48 x 64 invariant settings (`tmp/non-oracle-full-risk.log`). This
precedes the additional RB-I08 policy regressions and RB-I10 tooling work, so it is not the
final all-work count. The subsequent full CI run at `4a050df` passes **825/825**, **129 suites**,
zero failures/skips, with **10,000 fuzz runs**, seed **0x45524f53**, and **256 x 128 invariant
campaigns** in **1,469.81 seconds** (`tmp/non-oracle-full-ci.log`). Command:
`FOUNDRY_PROFILE=ci FORGE_SNAPSHOT_EMIT=false FORGE_SNAPSHOT_CHECK=true forge test --fuzz-seed 0x45524f53 -vv`.
This includes the seven RB-I08 tests but does not implement or close RB-I11.

Ordered **G0-G6 exit 0** at `4a050df`, with **71/152/117/78/77/63/55** tests. G0 includes
the three added SDK-runner regressions. **G7 exits 2 after six tests** because A043 does not
cover the current source and review regressions. No reviewer fingerprint or human acceptance
was manufactured. Separate **A044/B040/B041/B042/B043/B044** technical checks exit 0 with
**44/2/2/3/1/1** tests; direct G7 Solidity tests pass **6 tests / 2 suites**, exit 0. Those
separate passes do not turn the ordered G7 result into a pass or replace economic peer review.

`forge fmt --check` and ABI export/check exit **0**. ABI entries remain **294 concrete-engine /
256 abstract-engine / 35 vault**, with unchanged source digest. Independent source-bound
teammate review and human G7 acceptance remain pending, as does the RB-I11 policy decision.
The subsequent RB-I08 focused run passes **7/7** (`tmp/rb-i08-policy.log`). With RB-I10's
three additional runner regressions, Python A/B/audit/integration pass **49/156/8/7**, total
**220**. These later results do not retroactively change the 818-test Solidity run's source/count.
`tmp/maker-policy-listing-domain-red.log` records RB-I02 11/11, RB-I04 5/5 and RB-I06 4/4
passing while preserving the then-failing listing-domain and concrete gas assertions; the
overall run is not green. The listing-domain source repair is now committed but needs its
final broad rerun. The subsequent `tmp/rb-i05-green.log` bundle passes **83/83**, including
16 sampler and 16 new policy/domain tests; it does not include or resolve the gas finding.
The earlier `tmp/rb-i03-green.log` passes four new identity tests plus existing A016.
Do not sum overlapping targeted runs.

The final targeted MonadTen run at `1654b9f`, `tmp/non-oracle-monad-final.log`, records
**92/92**, **10 suites**: 16 sampler, 7 batch-bound, 9 concrete-engine, 7 other mock-composition,
8 controlled-fixture, 8 smoke and 37 gas cases. This supersedes the earlier 90-test bundle by
adding the two distinct-account sampler gas tests; the bundles overlap and are not additive.

Cold-call benchmarks after all three 1,024-entry price rings have wrapped:

| MonadTen measured call | Gas |
|---|---:|
| Normal-pricing eight-maker fill | 8,077,028 |
| Eight matching actions in one batch | 11,722,715 |
| Seven maximum-size POST_ONLY actions plus an eight-fill IOC | 16,619,933 |
| 64-distinct-account sampler view | 3,143,792 |
| 64-distinct-account sampler capture | 3,383,491 |
| 64-distinct-account sampler promotion | 3,290,777 |

These are local target-EVM call measurements, exclude intrinsic transaction gas, and are not
new live receipts. Read-only QuickNode estimation at block **67,865,259** succeeded with engine
creation gas **27,820,847**. The current artifact has **120,253 runtime**, **129,495 creation**,
**928 constructor-argument**, and **130,423 total initcode bytes**. See
[`non-oracle-deployment-estimate-2026-10-03.json`](../../artifacts/risk/non-oracle-deployment-estimate-2026-10-03.json).
An estimate is state-specific, does not prove future broadcast success, and does not deploy anything.

Historical consolidated evidence is `artifacts/risk/real-book-validation-2026-10-03.json`,
recorded in `20330d8` for validated source `5b82d9f`, not certification of this new delta.
The previously verified Monad market is immutable and closed; none of the new source changes
is present at that deployed address, and this turn has not deployed a replacement.
