# Risk & Clearing — STATUS

- Shared branch: `integration/risk` (remote `origin/integration/risk`)
- HEAD at the start of this snapshot: `32d30acf4098d7dfacb95fc010717eea9383aea4` (local = remote, clean tree)
- Working model: shared ownership, turn by turn (rules in `CLAUDE.md`, section "CURRENT MODE").
- Verification marks: facts were checked against the repo on 2026-10-02. **UNVERIFIED** = could not be
  confirmed from the repo; **MISMATCH** = the repo differs from the stated fact (what was found is given).

## Summary

Risk & Clearing code is done and tested. G0–G7 pass their technical checks on forge 1.8.3
(verified: `artifacts/gates/G0.json`…`G7.json`, status `checks_passed`, exit 0, source `3b11044`;
local forge is 1.8.3 `cae51ad`). Both reviews are complete (verified: `artifacts/reviews/A-on-B.md`
and `artifacts/reviews/B-on-A.md` incl. the 2026-10-02 addendum). Every audit finding is fixed
(verified: the three reproducers in `contracts/test/audit/findings/` pass under forge 1.8.3).
Remaining work: sign-off, the merge to main, other teams' work, production inputs. From now on the
two of us share ownership of everything and work turn by turn.

Gate record (`docs/spec/gate_status.json`, verified):

| Gate | Status | merge_sha | reviewed_by |
|---|---|---|---|
| G0 | passed | `966444d` | B, A |
| G1 | passed | `9c55836` | B, A |
| G2 | passed | `c190774` | B, A |
| G3 | passed | `c1d241c` | B, A |
| G4 | passed | `d01f0ee` | B, A |
| G5 | passed | `c236e5e` | B, A |
| G6 | passed | `ec5a22b` | B, A |
| G7 | blocked | null | A, B (acceptance pending, human only) |

## 1. Close the current handoff

- G7 acceptance must be recorded by a human at a real commit (`3b11044` plus review commit `32d30ac`;
  both verified present on the branch). G7 stays "blocked" until then (verified in `gate_status.json`).
- Open: the teammate's reply to the review checklist, including whether the info notes B-D01 to B-D05
  are accepted. **UNVERIFIED** — no reply is recorded in the repo; the notes are in
  `artifacts/reviews/B-on-A.md` (Addendum 2026-10-02).

## 2. Optional cleanups (not blocking; either of us)

- B-D02: the bridge's preview code (`_previewAccrual` / `_previewCharges` in
  `contracts/src/engine/RiskAccountingBridge.sol`) re-derives the funding/premium accrual. Replace it
  with a shared view function in the accounting module.
- B-D03: document that the new premium math (`contracts/src/math/PremiumMath.sol`, `_accumulate`)
  reverts above about 3.4e14 USDC (positive-part endpoint > 2^128 Q; unreachable in practice).
- B-D04, B-D05: conservative choices. Revisit only if conversion is enabled, or if users need to
  reduce positions while the mark is stale.
- Any source change needs a fingerprint refresh by the teammate who reviews it (checker:
  `scripts/check_a_review.py`; evidence `artifacts/reviews/A-on-B.json`).

## 3. Fee classification (A-I01, the last open accounting item)

- Spec (`docs/spec/risk_spec.md`, section "Fee escrow and exceptional recovery"): protocol and keeper fees,
  including sub-atom fractions, sit in separate vault-level escrows.
- Current code: they stay inside the market allocation, as separate ledgers (`protocolFeeEscrowQ`,
  `keeperQ` / `keeperPayableQ` in the engine). Verified; A-I01 listed open in `docs/merge/A-audit.md`.
- Proposal: per-beneficiary fee escrows in `CollateralVault` (`contracts/src/vaults/CollateralVault.sol`).
  Whoever implements it, the other reviews.

## 4. Merge into main (us, plus the book developer)

- The dry run (`git merge-tree --write-tree HEAD origin/main`, run 2026-10-02 against `origin/main` =
  `c5db208`) shows 3 conflicts: `contracts/foundry.toml`, `contracts/src/risk/TradePreview.sol`,
  `contracts/test/mocks/B/MockBookAdapter.sol`. Verified.
- main carries the book developer's earlier reformat of our files (`253ebd5`). **MISMATCH**: the
  stated fact was "it merges automatically except in TradePreview.sol"; found that `253ebd5` also
  reformatted `contracts/test/mocks/B/MockBookAdapter.sol`, which conflicts too. The other reformatted
  files merge automatically. `foundry.toml` conflicts with `2db4e08` / `c5db208` (Monad size limit).
- After the merge: rerun the formatter with forge 1.8.3, rerun all gates, refresh review fingerprints.

## 5. Real counterpart integration (all live connections still blocked)

Status file: `artifacts/risk/counterpart-status.json` (all live joins BLOCKED_BY_COUNTERPART; verified).

- Order book: `contracts/src/Book.sol` cannot host our risk hooks. The book team must fix 10
  mismatches (`docs/requests/B-to-book-hooks.md`, verified 10 rows): lots vs claims units, trader
  IDs, per-order epoch tags, atomic per-fill posting, cancel-all, and a forced-reduction order type,
  among others. After that, rerun G4, G5 and the end-to-end tests on the real book.
- Oracle: `origin/feat/oracle` has only a plan document (verified: commit `0e7a2af`, single file
  `docs_oracle/eros-oracle-implementation-plan.md`). When code ships, run G6 and the oracle
  compatibility tests (`contracts/test/risk/B/OracleCompatibility.t.sol`). VOIDED = 4 is our guess
  (verified: `ORACLE_VOIDED = 4` in `contracts/src/interfaces/IResolutionIngress.sol`) and needs their
  confirmation.
- Price feed: needs a real collector and signing service, plus agreement on the signed observation
  format (`contracts/src/interfaces/IPriceSource.sol`).
- Factory/registry and frontend/indexer: wire to our listing config, views and events per
  `docs/risk/HANDOFF.md`.

## 6. Production readiness (no deployment authorized)

- Contract size: the combined engine is about 108–113 KB versus Ethereum's 24,576-byte limit
  (verified: `CombinedEngine` runtime 112,865 B at `32d30ac` with forge 1.8.3; 108,270 B in
  `artifacts/risk/gas-engine.json` from the earlier forge 1.3.5 build). Need a decision on the target
  chain's limit, or a split.
- Gas: measured only with Ethereum pricing on a mock book (verified: `artifacts/risk/gas-engine.json`
  `gas_model`). Re-measure with the real book on Monad.
- Re-run the invariant campaigns (they predate the latest accounting changes; verified:
  `artifacts/risk/invariant-campaign.json` base commit `860793d`, before `71576ed..3b11044`) and
  refresh the gas table (`gas-engine.json` source `95213ba`).
- Missing production inputs (`artifacts/risk/release-manifest.json`, verified): token/code hashes,
  price signer details and depth N, volatility envelopes, stressed spread, absorption/queue bounds,
  OI and liquidation limits, hazard evidence, governance delay, dependency hashes, premium load as a
  manifest field.
- Then: calibration, an external audit, and an explicit release decision. Launch defaults: 1x leverage;
  funding, recovery and conversion off (verified: `release-manifest.json` `initial_defaults`,
  test `contracts/test/integration/ReleaseDefaults.t.sol`).

## Who does what next

- Us (either, turn by turn): A-I01 fee escrows plus cross-review; B-D02 view function; B-D03 docs;
  the checklist reply; merge prep and gate reruns; invariant and gas reruns; counterpart reruns when
  they ship.
- Humans only: G7 acceptance and the merge into main.
- Book team: the 10 hook fixes. Oracle team: code, plus confirming VOIDED = 4.

## Referenced documents

| Document | Path |
|---|---|
| Team rules | `CLAUDE.md` |
| Spec | `docs/spec/risk_spec.md` |
| Gates and status | `docs/spec/integration_gates.json`, `docs/spec/gate_status.json`, `artifacts/gates/G0.json`…`G7.json`, `docs/contracts/G0.json`…`G7.json`, `contracts/test/gates/G0.t.sol`…`G7.t.sol` |
| Reviews | `artifacts/reviews/A-on-B.md`, `artifacts/reviews/A-on-B.json`, `artifacts/reviews/B-on-A.md` |
| A's integration review / handoff record | `docs/merge/A-integration-review.md` |
| Audit of A's lane | `docs/merge/A-audit.md` |
| Interface reconciliation (R-01…R-21) | `docs/merge/interface-reconciliation.md` |
| Integration log (history) | `docs/merge/integration-progress.md` |
| Toolchain reproduction | `docs/merge/toolchain-reproduction.md` |
| Handoff for other teams | `docs/risk/HANDOFF.md`, `artifacts/risk/engine-abi.json`, `artifacts/risk/vault-abi.json` |
| Requests | `docs/requests/B-to-book-hooks.md`, `docs/requests/B-to-A-integration.md` (historical) |
| Counterparts / release / campaigns / gas | `artifacts/risk/counterpart-status.json`, `artifacts/risk/release-manifest.json`, `artifacts/risk/invariant-campaign.json`, `artifacts/risk/gas-engine.json` |
| Historical per-person lanes | `docs/spec/tasks_A.json`, `docs/spec/tasks_B.json`, `docs/ownership.json`, `RISK_PROGRESS.md`, `docs/merge/B-*.md` |

## Turn log

### 2026-10-02 — 0xr10t (with Claude agent) — turn complete

- Done this turn:
  - Pulled the teammate's 7 commits `71576ed..3b11044` (fast-forward; no local changes lost).
  - Installed forge 1.8.3 (`cae51ad`) to match the CI pin; 1.3.5 remains selectable via `foundryup -u`.
  - Delta review of `71576ed..3b11044` with dispositions for A-B01…A-B08, A-F01…A-F03, the five
    accounting ports and R-04/R-05/R-06/R-09; info notes B-D01…B-D05; A-I01 acknowledged with a
    proposal; independent checks `contracts/test/audit/DeltaReviewB.t.sol`.
  - Recorded the B delta review in `docs/spec/gate_status.json` (G7 left blocked, merge_sha null).
  - Switched the team to shared, turn-by-turn ownership: `CLAUDE.md` rules and this `STATUS.md`.
- Commits: `32d30ac` (delta review + fresh evidence); this commit ("docs: shared-ownership rules +
  STATUS snapshot"; its SHA is shown by `git log -1` and reported to the human). No source file changed.
- Tests run this turn (forge 1.8.3, FOUNDRY_PROFILE=risk, FORGE_SNAPSHOT_EMIT=false, at `3b11044`):
  - `forge test --match-path 'test/reviews/*.t.sol'` exit 0 (37 passed)
  - `forge test --match-path 'test/audit/findings/*'` exit 0 (3 passed)
  - `forge test` exit 0 (641 passed)
  - Python A / B / audit / integration: exit 0 (46 / 156 / 8 / 7)
  - `python scripts/export-risk-abis.py --check` exit 0 (engine 252, vault 25)
  - `bash scripts/check-gate.sh G0`…`G7` each exit 0 (68/152/117/78/74/62/55/102)
  - `forge test --match-path test/audit/DeltaReviewB.t.sol` exit 0 (2 passed)
  - A043 fingerprint check (`scripts/check_a_review.py` `validate_review`) valid after `32d30ac`
  - No source change in this snapshot commit, so no gates were rerun for it.
- Open questions: teammate's acceptance of B-D01…B-D05 (UNVERIFIED in repo); who takes A-I01; human
  acceptance of G7.
- Next turn: open.

### 2026-10-02 — 0xr10t (with Claude agent) — IN PROGRESS

- Started from `d1f0268` (clean, equal to origin). Planned: outdated-doc fixes, B-D03, B-D02, A-I01,
  invariant and gas reruns, local merge prep. Teammate: please do not start a turn until this entry
  says "turn complete".
