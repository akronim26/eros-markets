# Non-oracle risk and order-book fixes

**GOV-01 update (2026-10-03):** the merged Risk and Order Book team no longer requires A/B
peer review. RB-I11's selected strict INDEX-prefix seal is implemented in `dcb6b0e` with 21
passing sampler regressions. Automated checks stay mandatory, and old review records remain
historical. See `docs/merge/UNIFIED_WORKFLOW.md`; G7 technical-runner migration is implemented
in `bee683b` plus guard `e05bbbb`, with all 17 mocked runner regressions passing. Ordered
gates all exit 0 at metadata commit `c91acf7` with unchanged source. After those checks passed,
the user's authorized G7 acceptance was recorded at **2026-10-03 17:39:11 UTC** for `c91acf7`.
This is integration acceptance, not a main merge, new deployment or production approval.

Started 2026-10-03 from `1958aef` on `integration/risk`.
Current Solidity source: `dcb6b0e`; validation candidate `e05bbbb`, pre-gate metadata `c91acf7`.
**Full CI and ordered G0-G7 pass; user-authorized G7 acceptance is recorded. No new deployment is recorded.**

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
| RB-I05 | No bounded, stale-aware concrete PERP depth observation path | Implemented in `3942100`; original 16 sampler tests and historical full CI/G0-G6 at `4a050df` pass; RB-I11 extends source to sealed-prefix promotion, with 21 current sampler tests passing |
| RB-I06 | Old ordinary maker orders can open new maker exposure after the market enters reduce-only | Implemented in `9c3a2e0`; four actual-book stage regressions pass; explicit reduce-only orders retain their reduction checks |
| RB-I07 | Unsupported hazards or price-band domains can reach downstream arithmetic | Implemented in `0c93b63`; seven domain regressions pass; reject hazards above one wad at initialization, governance staging and monitor raise, and reject listing band/spread above one wad |
| RB-I08 | Whether otherwise safe collateral release is permitted during REDUCE_ONLY is ambiguous | User accepted preserving existing safe-excess-release behavior; committed in `4a050df` with seven passing policy regressions and no production behavior change |
| RB-I09 | Concrete matching and aggregate batch work exceed a bounded transaction budget | Implemented in `be3db1e`, full-history fixtures committed in `1654b9f`: concrete matching cap 8, at most 8 batch actions and 8 total declared matching steps; historical batch/full-history MonadTen/full CI/G0-G6 evidence retained; current affected Monad bundle passes |
| RB-I10 | SDK type-check tooling needs an exact locally reproducible compiler pin | Implemented in `56787d2`: exact local TypeScript 5.9.3 pin and three Python regressions; original evidence was Python A 49 / combined 220 and G0 71; current combined validation below is Python 237 and G0 88 |
| RB-I11 | Authenticated historical INDEX correction after PERP promotion can leave BASIS based on the former INDEX history | Implemented in `dcb6b0e`; strict newer-INDEX seal, original pending timestamp/expiry and invalidation guards retained; 21 sampler regressions pass, including changed capture checkpoint while awaiting seal |
| RB-I12 | Local smoke script uses an obsolete matching limit and incomplete single-pass payout preparation | Implemented in `29c5f87`; reads actual `maxFills()` and runs at most two payout passes; 2 regressions pass and standalone chain-31337 offline dry run exits 0 |

Each completed item must record its implementation commit, regression result, affected modules
and remaining limitations here. Failed tests and unfinished work are not marked complete.

RB-I02 changes `IBookRiskHooks.StepResult`, `Book`, `BookRiskAdapter` and matching mocks;
the returned post-fill version applies only to the exact surviving maker node, not other orders.
RB-I03 changes the append-only account registry/storage and its concrete book lookup.
RB-I04 changes `BookRiskAdapter`; RB-I06 changes `OrderAdmission`; RB-I07 changes
`RiskContextPort` and `MonitorPolicy`. These are unified-team implementation and technical
validation records, not independent security-review approvals.

The approved RB-I05 policy is exact-N VWAP with bid-down/ask-up rounding, a shared 64-node
budget, all reduce-only depth excluded, and later-block promotion with original observation
time and source/account/book provenance rechecked. See the full
[decision record](../questions/RB-I05-book-depth-policy.md). Approval is conditional on
preserving fresh-INDEX fully backed startup placement, matching and cancellation before
PERP warm-up. It does not enable leverage, funding, invented calibration or production release.

RB-I11 was a later review finding, not closed by RB-I05's original passing tests. The confirmed numerical
counterexample concerns existing cross-series correction behavior after an authenticated INDEX
replacement; it is not evidence of unauthenticated forgery or demonstrated fund extraction in
the cap-1/funding-disabled engine. The implemented seal requires the pinned INDEX source's
`lastObservedAt` to exceed the capture time before promotion. An otherwise valid unsealed
capture waits without renewing its timestamp; expiry, mutation, checkpoint replacement and
eligibility changes still invalidate it. This changes normal-pricing availability: a 30-second-only
feed can leave promoted PERP at its freshness boundary. Use cadence comfortably below 30 seconds;
the 10-second fixture cadence is not an invented production service guarantee. Fresh-INDEX
fully backed startup remains independent of PERP warm-up. See the
[finding, decision and cadence tradeoff](../questions/RB-I11-index-prefix-seal.md).

RB-I12 restores the local mock smoke path without changing accounting or matching policy.
Its standalone offline script exits 0 (`tmp/rb-i12-local-script-green.log`) on chain 31337,
without RPC or broadcast. Reported aggregate gas **45,478,303** spans multiple virtual
transactions; it is not a single Monad transaction or a public-chain receipt.

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
- Record unified technical evidence without rewriting historical reviewer fingerprints. Apply the user's conditional G7 acceptance only after required checks pass; main/deployment authorization remains separate.

## Not silently substituted

- The prior deployed smoke market is closed and immutable; new source does not update its bytecode.
- Real oracle integration is excluded by the user. No oracle mock counts as the live oracle.
- A production independent INDEX collector, calibration data, governance/timelock configuration and
  registry/factory handshake require actual inputs and counterpart decisions, not guessed defaults.
- Funding, leverage and conversion release defaults remain unchanged unless separately approved.

## Current validation

The full CI run at unchanged Solidity `dcb6b0e` passes **832 tests / 130 suites**, zero
failed/skipped, in **1,461.88 seconds** (`tmp/unified-full-ci.log`): 10,000 fuzz runs, seed
`0x45524f53`, 256 x 128 invariant settings and strict snapshots. Final candidate `e05bbbb`
MonadTen validation passes **99 tests / 11 suites** in **3.04 seconds**
(`tmp/unified-monad-final.log`). Sampler **21/21** and local smoke **2/2** are overlapping
targeted counts, not additive to the full total.

Python A/B/audit/integration pass **66/156/8/7**, total **237**; A includes all **17** new mocked
GOV runner regressions. SDK strict build/accounting reader and six Node tests pass. Format and
current ABI export/check exit **0**, entries **294 concrete / 256 abstract / 35 vault**; concrete
source digest `40e05c0e8034dcdba2a14fc19a97f2323412e69f92dc2146cac913ef8695cbb3`.

Current runtime/creation/constructor/initcode sizes are **120,402 / 129,644 / 928 / 130,572 bytes**.
Read-only chain-10143 estimation at block **67,886,057** passes with **27,853,253 gas** and
**2,146,747** headroom: [current estimate](../../artifacts/risk/unified-deployment-estimate-2026-10-03.json).
This uses historical public fixture dependencies/listing, not a fresh deployment configuration,
receipt or broadcast. It supersedes the older estimate only for this source/fixture state.

Ordered **G0-G7 all exit 0**, zero skipped, at
`c91acf75ae9770f0bf5ae2238b4018202d57acd8`, with manifests frozen and source unchanged.
Reported check counts are **88/152/117/78/77/63/55/156**. G0 increases from 71 to 88 through
17 mocked GOV regressions; G7 reports actual Forge test counts rather than subprocess counts.
Counts overlap CI and must not be summed as unique tests. A043/B043 validate **68/3**
source-bound technical checks, not independent peer signatures.

The user's conditional acceptance is now satisfied and recorded in `docs/spec/gate_status.json`
at **2026-10-03 17:39:11 UTC**, accepted source `c91acf7`, `reviewed_by: []`. Runner artifacts
retain `accepted: false` and null acceptance SHA: they report technical outcomes and do not
self-accept. This does not merge main or authorize deployment/production. Current aggregate:
[`unified-integration-2026-10-03.json`](../../artifacts/risk/unified-integration-2026-10-03.json).

Configuration inventory and blank current-deployment placeholders are in
[`RISK_BOOK_ENV_AND_ADDRESSES.md`](../runbooks/RISK_BOOK_ENV_AND_ADDRESSES.md) and root
`.env.example`. Historical verified addresses remain explicitly closed-market evidence.

## Historical validation through `4a050df`

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
cover the then-current source and review regressions. No reviewer fingerprint or human acceptance
was manufactured. Separate **A044/B040/B041/B042/B043/B044** technical checks exit 0 with
**44/2/2/3/1/1** tests; direct G7 Solidity tests pass **6 tests / 2 suites**, exit 0. Those
separate passes do not turn that historical ordered G7 result into a pass. GOV-01 subsequently
retired mandatory peer signatures; runner migration must preserve its technical regressions.

`forge fmt --check` and ABI export/check exit **0**. ABI entries remain **294 concrete-engine /
256 abstract-engine / 35 vault**, with the then-unchanged source digest. These are historical
artifact checks, not checks of `dcb6b0e` or a new acceptance record.
The subsequent RB-I08 focused run passes **7/7** (`tmp/rb-i08-policy.log`). With RB-I10's
three additional runner regressions, Python A/B/audit/integration pass **49/156/8/7**, total
**220**. These later results do not retroactively change the 818-test Solidity run's source/count.
`tmp/maker-policy-listing-domain-red.log` records RB-I02 11/11, RB-I04 5/5 and RB-I06 4/4
passing while preserving the then-failing listing-domain and concrete gas assertions; the
overall run is not green. The listing-domain repair was subsequently covered by the recorded
full runs. The subsequent `tmp/rb-i05-green.log` bundle passes **83/83**, including
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
creation gas **27,820,847**. That historical artifact has **120,253 runtime**, **129,495 creation**,
**928 constructor-argument**, and **130,423 total initcode bytes**. See
[`non-oracle-deployment-estimate-2026-10-03.json`](../../artifacts/risk/non-oracle-deployment-estimate-2026-10-03.json).
An estimate is state-specific, does not prove future broadcast success, and does not deploy anything.

Historical consolidated evidence is `artifacts/risk/real-book-validation-2026-10-03.json`,
recorded in `20330d8` for validated source `5b82d9f`, not certification of this new delta.
The previously verified Monad market is immutable and closed; none of the new source changes
is present at that deployed address, and this turn has not deployed a replacement.
