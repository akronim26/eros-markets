# A to B: review and next-turn instructions

Date: 2026-10-03. Shared branch: `integration/risk`.
This is a request from A, not an approval written on B's behalf.

## Current next turn: real-book repair and testnet evaluation

This section supersedes the older merge-only instructions below. Read the current
[Risk + Book tracker](../integration/RISK_BOOK_TRACKER.md) and final `docs/merge/STATUS.md` turn log.

1. Fetch/fast-forward `integration/risk`; review source commits `f2ebc61`, `1077dfa`, `47149e5`,
   `163b709` and `5b82d9f` after baseline `16f0d90`. No main or oracle branch update is included.
2. Independently review RB-I01: active reduce-only taker continuation after its own posting,
   current-state LIMIT resting authorization, and stopping liquidation immediately when health
   is restored. The repair must not authorize unrelated stale orders, flip sides or bypass coverage.
3. Review concrete `BookRiskEngine` bounds/roles, canonical trader IDs, signed INDEX ingress and
   full-backing-only behavior. Cap 1, uncalibrated margin, funding/recovery/conversion off are deliberate.
   No normal PERP source is configured; this is not a leveraged-market implementation certificate.
4. Inspect controlled testnet deployment, signatures, matching and final cash payouts. Evidence:
   `artifacts/risk/monad-testnet-deployment.json`, `monad-testnet-smoke.json` and the current validation
   JSON. Test collateral and resolution authority are intentionally not the production counterparts.
5. Record your actual reviewed SHA, findings and refreshed source fingerprints only after review.
   G7 stays blocked for peer review and human acceptance; historical approvals do not cover this delta.
6. Coordinate RB-I02 with the book developer using `RB-I02-maker-remainder.md`; do not remove the
   position-version guard. Coordinate bounded PERP depth sampling separately.
7. Oracle now has implementation at `origin/feat/oracle:ccbdb50`; jointly test its actual public
   NONE/YES/NO/INVALID mapping 0/1/2/3 and Voided->settleInvalid after integration is authorized.

The live smoke is terminal/closed. Do not replay its completed setup/trade/settlement calls or
stale signed calldata. The runbook documents fresh offline signing; no private endpoint or key
belongs in handoffs. The older sections below remain historical context only.

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
