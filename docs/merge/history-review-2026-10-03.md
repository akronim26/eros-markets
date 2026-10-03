# Cross-branch history review — 2026-10-03

This report was delivered to the user before review edits began. Remote refs were fetched and
checked; no branch was switched or merged. Existing untracked handoff and Python cache files
were preserved. Recorded test results below are attributed to their original runs, not a fresh
test execution by this inspection.

## Branch snapshot

| Ref | Head | Position |
| --- | --- | --- |
| `integration/risk` / `origin/integration/risk` | `2506235` | Shared Risk & Clearing branch; the local checkout matched the remote. |
| `origin/main` | `a114d06` | New book integration work and three risk-related changes. |
| `origin/feat/clob` | `5cbd0cb` | Historical book branch; recent book work is on main, not this ref. |
| `origin/feat/oracle` | `0e7a2af` | Oracle plan document only beyond its main-derived base. |
| `origin/feat/risk` | `ffc9f52` | Historical raw risk-lane merge. |
| Local `main` | `3cfa48d` | Behind remote main; not the source for a current integration decision. |

Main and integration have 17 and 53 unique commits respectively, with merge base `ffc9f52`.
Commit-count divergence includes historical merges; it is not a count of unresolved features.

## Risk & Clearing since the previous handoff

| Commit | Delivered work | Review consequence |
| --- | --- | --- |
| `32d30ac` | B's independent review of all seven `71576ed..3b11044` commits and fresh evidence. | Confirms the earlier A fixes; does not approve later source changes. |
| `d1f0268` | Shared, turn-by-turn ownership rules and STATUS. | Either teammate may implement risk work; the other reviews economic changes. G7 acceptance remains human-only. |
| `39205c1` | B-D03 premium-domain bound explanation and two tests. | Review the corrected bound; no arithmetic implementation change. |
| `fe4c4f7` | B-D02 common funding/touch/premium projection helpers. | Removes duplicated preview arithmetic; needs A's review. |
| `a073104` | A-I01 global vault fee-Q escrows and exact allocation reclassification. | Implemented, not merely proposed; six choices need A's review. |
| `ba633ed` | Refreshed invariant/gas evidence at `a073104`. | Recorded risk/CI invariant passes; gas is still mock-book, local EVM pricing. |
| `e61c8a7` | Ordered gate reruns. | G0-G6 pass; G7 exits 2 at stale A043 source fingerprints. |
| `2506235` | Merge-preparation report and completed turn log. | Hands the next review turn to YASH-ai-bit. |

B recorded 653 passing Forge tests after A-I01, Python 46/156/8/7, and passing production ABI
checks. The earlier 641-test report belongs to `3b11044`. G7's historical `checks_passed` note
in the status JSON is not the outcome of the latest runner: new source must be reviewed before
the A043 fingerprints are refreshed.

## Order book and main

Main has 13 new commits since `c5db208`:

- `e643b4c`: recheck liquidation continuation after a pair restores health.
- `f651b63`: share the snapshot-at-time helper with order admission.
- `8441aaf`: voluntary reduce-only health predicate, overlapping the fixes already on integration.
- `42232a2`: owner-directed book-work instructions.
- `9fc6f0b`, `c997e3d`, `299039e`: single-market book, uint64 lots, engine trader IDs.
- `b9642b3`, `61836cb`: replace old protocol-cancel hooks with the risk hook contract, order epoch/
  reduction/fee records, exact unrest, paired postings and status-based matching decisions.
- `4e865fd`, `6ffc90c`, `63729d8`: cancel-all, block expiry and forced-reduction IOC.
- `a114d06`: seven real-book/real-B-risk integration tests.

The ten old structural hook requests have implementations on main. This supersedes the claim
that no book-side work has landed. It does not certify the complete join: main's
`contracts/test/BookRiskEngine.t.sol` composes `RiskView`, `Book` and `MockAccountingPort`.
Our branch composes real A+B with `MockBookAdapter`. Real A+B+Book remains to be composed and
tested together.

## Other sections

- Oracle: `0e7a2af` adds the plan in `docs_oracle/`; no oracle implementation is delivered there.
- Price collector/signing service and factory/registry: no corresponding implementation in the
  inspected changes. Existing interfaces and mocks remain the integration evidence.
- App/indexer: `packages/risk-sdk` and state fixtures exist; no live consumer integration is
  demonstrated by these commits.
- Production: target-chain size/gas, complete calibration/deployment inputs and external audit
  remain separate requirements. Local fixture success is not deployment approval.

## Current merge assessment

The old dry run used main `c5db208`. A read-only `git merge-tree` against current main `a114d06`
finds five conflicts: `CLAUDE.md`, `contracts/foundry.toml`, `OrderAdmission.sol`,
`TradePreview.sol`, and `MockBookAdapter.sol`.

Automatic resolution is not enough. Main's new Book and four book fixtures still import
provisional types that integration removed; the shared types need explicit reconciliation.
The snapshot helper relocation and overlapping reduction predicates also require semantic
review. Preserve integration's projected accounting, reduction/cap checks, reservation posting
order and actual-fee reporting. Main's post-pair liquidation-health recheck is a distinct fix
to retain, not formatting noise.

At the time of this initial inspection, no working-tree merge had been performed. The immediate
review was B-D02/B-D03/A-I01; a current-main merge and G7 acceptance required separate decisions.

## Subsequent human direction

After this report, the human explicitly requested merging current main into `integration/risk`
and validating the real-book integration. That merge is `13ca730`; reconciliation and fresh
evidence are recorded in `docs/merge/main-merge-prep.md` and
`artifacts/risk/merge-validation-2026-10-03.json`. Main itself is unchanged. G7 acceptance remains
human-only and was not granted by that merge instruction.
