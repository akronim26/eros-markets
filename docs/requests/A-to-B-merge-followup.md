# A to B: review and next-turn instructions

Date: 2026-10-03. Shared branch: `integration/risk`.
This is a request from A, not an approval written on B's behalf.

## Current next turn: independently review the implemented non-oracle delta

This section supersedes the older merge-only instructions below. Read the current
[Risk + Book tracker](../integration/RISK_BOOK_TRACKER.md) and final `docs/merge/STATUS.md` turn log.

The user extended scope to book internals and all Risk & Clearing modules, including Person B's
work. Oracle implementation/integration remains excluded. See
`docs/integration/NON_ORACLE_FIXES.md`; this is not a request to reimplement completed work.

1. Fetch/fast-forward `integration/risk`, preserve local changes and inspect the completed turn log.
   New source starts after `1958aef`: `bd9d5b9` RB-I03 IDs, `857b5c0` RB-I02 maker remainders,
   `93e971e` RB-I04 bootstrap bands, `9c3a2e0` RB-I06 reduce-only makers, `0c93b63` RB-I07 domains,
   `3942100` RB-I05 real-book PERP sampler and `be3db1e` RB-I09 work bounds. Later `4a050df` records
   the confirmed RB-I08 release policy and regressions; `56787d2` pins TypeScript 5.9.3 and checks
   runner selection for RB-I10. Review the final source
   and evidence commits too; no main or oracle branch update is included.
2. Review the earlier unapproved RB-I01/concrete/tooling source (`f2ebc61`, `1077dfa`, `47149e5`,
   `163b709`, `5b82d9f`) as well as the new delta. RB-I01 covers active reduce-only continuation,
   current-state LIMIT resting authorization, and stopping liquidation immediately when health
   is restored. The repair must not authorize unrelated stale orders, flip sides or bypass coverage.
3. Review RB-I02's exact-node maker version refresh, RB-I04's actual fill-price band, RB-I06's
   maker-side stage enforcement and RB-I07's atomic profile/listing validation. Keep fee attribution,
   reservation-before-posting, stale epochs, no-flip, coverage, preview parity and rollback intact.
4. Review RB-I05's exact-N directed VWAP, shared 64-node scan, exclusion of all reduce-only depth,
   later-block promotion, original observation time, backing-floor invalidation and source/account/
   book provenance. Fresh-INDEX fully backed startup must still work before PERP warm-up.
   Review RB-I03 canonical IDs and RB-I09's concrete eight-step bound plus whole-batch action and
   aggregate examination budgets. The larger-cap diagnostic harness is not the production setting.
5. Reconcile final validation against its actual source SHA. Full-risk at `1654b9f` passes 818 tests
   in 128 suites; seven later RB-I08 tests pass separately. ABI check passes 294/256/35. The expanded
   MonadTen bundle passes 92 tests/10 suites, including 32 full-history gas benchmarks. Python passes
   49/156/8/7 (220 total); SDK strict build, accounting reader and six Node tests pass. Inspect the
   local TypeScript 5.9.3 lockfile/runner checks rather than assuming a global compiler.
   Full CI at `4a050df` passes 825 tests/129 suites, zero failed/skipped, with 10000 fuzz cases
   (seed `0x45524f53`) and 256x128 invariant campaigns. Ordered G0–G6 pass with
   71/152/117/78/77/63/55 tests; G7 exits 2 at stale source-bound A043 after six passing tests.
   Direct G7 and A044/B040–B044 pass separately; formatting and unchanged ABI checks pass.
   The read-only estimate is 27,820,847 gas at block
   67865259, not a broadcast; see `artifacts/risk/non-oracle-deployment-estimate-2026-10-03.json`.
   Concrete bytes are 120253 runtime, 129495 creation plus 928 arguments = 130423 initcode.
6. Preserve the historical controlled testnet deployment, matching and final cash-payout evidence:
   `artifacts/risk/monad-testnet-deployment.json`, `monad-testnet-smoke.json` and historical
   `real-book-validation-2026-10-03.json`. That closed market has older bytecode and does not contain
   this turn's changes. Fixture
   collateral, synthetic signed INDEX and manual authority are not the production counterparts.
7. Record your actual reviewed SHA, findings and refreshed source fingerprints only after review.
   G7 stays blocked for peer review and human acceptance; historical approvals do not cover this delta.
8. The user confirmed RB-I08 (`docs/questions/RB-I08-reduce-only-release.md`): keep safe excess release
   available under the existing guards. Review its spec clarification and seven passing tests, not a changed
   production predicate. Coordinate collector/factory roles and
   calibration inputs without inventing them. Oracle integration requires separate authorization;
   its observed enum is NONE/YES/NO/INVALID = 0/1/2/3, with Voided using settleInvalid, not enum 4.
9. RB-I11 remains **OPEN / policy confirmation pending**. Read
   `docs/questions/RB-I11-index-prefix-seal.md`: later authenticated INDEX corrections can leave
   retained BASIS tied to the former INDEX history. Strictly newer authenticated INDEX before
   promotion is a proposed policy, not an implemented fix. Do not silently change observation
   semantics or treat the existing sampler as fully resolved before that policy is confirmed.

The live smoke is terminal/closed. Do not replay its completed setup/trade/settlement calls or
stale signed calldata. The runbook documents fresh offline signing; no private endpoint or key
belongs in handoffs. The new source remains unbroadcast; no replacement deployment is authorized
by this review request. Cap 1, uncalibrated margin and funding/recovery/conversion off remain
deliberate. The older sections below are historical context only, including superseded open-item,
oracle-enum and test-count statements; they are not the current instructions.

## Historical merge-only handoff

## Completed

1. Reviewed your work through `2506235`: B-D02, B-D03 and A-I01 are accepted.
   All six A-I01 choices are confirmed in `docs/questions/A-I01.md`.
2. Answered B-D01 through B-D05 in the dated addendum to `artifacts/reviews/A-on-B.md`.
   Your `32d30ac` review of A's earlier repairs remains valid for its stated source range.
3. Added eight independent funding/fee review regressions. Focused runs pass.
4. At the human's explicit request, merged main `a114d06` into this branch at `13ca730`.
   Main itself was not updated. Five conflicts and silent type/helper hazards were reconciled;
   see `docs/merge/main-merge-prep.md`. The original three-conflict plan is historical.
5. Added a test-only composition of real Book + real A accounting/vault + real B controllers.
   Unlike main's `BookRiskEngine`, it does not use `MockAccountingPort`. External price feed,
   oracle, token and deployment configuration remain fixtures, not live integrations.

Final command results and exact validation source are in
`artifacts/risk/merge-validation-2026-10-03.json`; current gate evidence is in `artifacts/gates/`.
The existing `review-validation.json` is historical (641 tests), not this merge's result.

Current validation: 692/692 Forge, 217/217 Python, 17/17 real-book integration tests, all ordered
G0–G7 checks exit 0. ABI check (254 engine / 35 vault entries), formatting, CI-profile build and
all eight BookGas snapshot checks exit 0. G7 is still not human-accepted; RB-I01 is still open.

## First: review the merge delta

- Fetch and fast-forward the shared branch; preserve local work and inspect the final Turn log.
- Review `13ca730` against both parents. Keep our stronger voluntary-reduction predicate,
  projected release balances, reservation-before-posting and actual forced-fee reporting.
- Confirm main's `e643b4c` health recheck after pairing: spare budget must not liquidate a
  healthy remainder. `_snapAt` is now the common identical snapshot helper.
- Book's local changes are canonical type/import compatibility, not a rewrite of its matcher.
  The concrete real-book adapter is a test fixture; production registry/factory wiring is still open.
- Record your own reviewed source SHA and findings. Do not copy A's fingerprints as B approval.

## Second: triage RB-I01, reduction-permit version liveness

Observed in the real A+B+Book fixture, and inherited from the risk seam rather than introduced
by the merge: A increments `positionVersion` after a successful fill, but the active reduce-only
taker permit retains its admission-time `reduceVersion`.

Consequences reproduced by three characterization tests in `RealBookIntegration.t.sol`:

- `testReductionPermitStopsAfterOwnPositionVersionChanges`: a 500,000-lot IOC against two
  250,000-lot makers fills the first and stops before the second.
- `testForcedReductionAlsoStopsAfterItsFirstMakerChangesPositionVersion`: a 10-lot liquidation
  against two 5-lot bids closes only 5 and returns NEEDS_MORE_WORK, despite remaining budget.
- `testPartiallyFilledReduceOnlyLimitRestKeepsItsAdmissionVersion`: its resting remainder has
  the old version and is pruned on the next match without filling.

This is conservative under-execution, not evidence of an unauthorized fill or lost funds. It
reduces liquidation throughput and makes partial reduce-only LIMIT remainders ineffective;
do not describe the join as production-complete. No version checks were weakened this turn.

Required next work:

1. Decide the intended per-action/per-order version semantics against the frozen book contract.
2. Add intended-behavior regressions before repair; distinguish a permit's own authorized fill
   from genuinely stale orders, sign flips, epoch invalidation and external position changes.
3. If continuing across makers is intended, carry forward only the version caused by a
   successful authorized posting; retain the per-fill health/no-flip/capacity checks. Re-admit
   any resting remainder against current state. Do not just remove the version guard.
4. Prove bounded work, safe partial success, fee/reservation reconciliation and atomic rollback.
   Keep unsafe maker pruning and unsafe taker STOP regressions intact.
5. Rerun the real-book suite, G4/G5, the full suite and relevant invariants. Economic repair needs
   A's independent review on the next turn before refreshing its approval fingerprints.

## Third: remaining integration and human decisions

- Human only: record G7 acceptance at an actual reviewed commit; keep `merge_sha` null until then.
- No merge into main, deployment, production calibration or chain-size approval was granted here.
- Book team: inspect canonical-type reconciliation and agree RB-I01 seam semantics. The ten old
  structural hook requests already shipped on main; do not ask them to implement those again.
- Oracle team: provide implementation and confirm terminal enum mapping, including VOIDED = 4.
- Price team: collector/signing service and signed observation contract. Factory/app owners:
  authenticated deployment wiring, registry IDs, indexer and UI consumers.
- Shared compiler target is agreed: forge 1.8.3, solc 0.8.30, Prague, optimizer 200. Python/TS/NumPy
  patch versions still differ locally; record actual versions rather than copying B's environment.
- Confirm target-chain size limits and benchmark the final production composition on that chain.

## Reproduction

Use the pinned forge binary on PATH, `FOUNDRY_PROFILE=risk`, `FORGE_SNAPSHOT_EMIT=false`:

```sh
cd contracts
forge test --match-path 'test/integration/RealBookIntegration.t.sol'
forge test --match-path 'test/reviews/*.t.sol'
forge test
cd ..
python -m unittest discover -s reference/tests/a
python -m unittest discover -s reference/tests/b
python -m unittest discover -s reference/tests/audit -t .
python -m unittest discover -s reference/tests/integration -t .
python scripts/export-risk-abis.py --check
for gate in G0 G1 G2 G3 G4 G5 G6 G7; do bash scripts/check-gate.sh "$gate" || break; done
```

The audit Python suite requires NumPy. On Windows use Git Bash for the gate scripts. Do not
replace missing tools with invented passes, and do not treat technical passes as human acceptance.
