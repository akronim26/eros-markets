# Risk & Clearing — STATUS

- Shared branch: `integration/risk` (remote `origin/integration/risk`)
- First snapshot taken at `32d30ac`. Last updated by the 2026-10-02 0xr10t turn (see Turn log); the
  current HEAD is whatever `git log -1 origin/integration/risk` shows.
- Working model: shared ownership, turn by turn (rules in `CLAUDE.md`, section "CURRENT MODE").
- Verification marks: facts were checked against the repo on 2026-10-02. **UNVERIFIED** = could not be
  confirmed from the repo; **MISMATCH** = the repo differs from the stated fact (what was found is given).

## Summary

Risk & Clearing code is done and tested. **Changed 2026-10-02 (second turn):** B-D02 and A-I01 changed
`contracts/src`, so G0–G6 pass their technical checks at `ba633ed` but the G7 check now stops at A043
until the teammate reviews those changes and refreshes the A043 fingerprints (`artifacts/gates/G7.json`,
exit 2, reason "reviewed source changed"). At `3b11044` G0–G7 all passed on forge 1.8.3. Both reviews are complete (verified: `artifacts/reviews/A-on-B.md`
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

- G7 acceptance must be recorded by a human at a real commit. `3b11044` + `32d30ac` were acceptable
  before this turn; since B-D02/A-I01 changed `contracts/src`, the natural point is now the commit where
  the teammate's review and fingerprint refresh land and G7's check passes again. G7 stays "blocked" in
  `gate_status.json` (unchanged this turn).
- Open: the teammate's reply to the review checklist, including whether the info notes B-D01 to B-D05
  are accepted. **UNVERIFIED** — no reply is recorded in the repo; the notes are in
  `artifacts/reviews/B-on-A.md` (Addendum 2026-10-02).

## 2. Optional cleanups (not blocking; either of us)

- B-D02: **implemented, pending teammate review** (`fe4c4f7`). `FundingAccounting._fundingStep`,
  `AccountSync._projectedTouch` and `PremiumAccounting._premiumTotalAt` are now shared by execution and
  the bridge preview. Parity fuzz `contracts/test/audit/BD02PreviewParity.t.sol` passes before and after.
- B-D03: **done** (`39205c1`, comment + tests only). The bound is tighter than first noted: the
  sign-crossing endpoint is below 2^112 Q, so the square cannot overflow anywhere in `cumulative`'s
  domain (`contracts/test/audit/BD03PremiumBounds.t.sol`).
- B-D04, B-D05: conservative choices. Revisit only if conversion is enabled, or if users need to
  reduce positions while the mark is stale.
- Any source change needs a fingerprint refresh by the teammate who reviews it (checker:
  `scripts/check_a_review.py`; evidence `artifacts/reviews/A-on-B.json`).

## 3. Fee classification (A-I01)

- **Implemented, pending teammate review** (`a073104`). At payout-scan completion the engine moves exact
  `protocolFeeQ` and `keeperPayableQ` into global per-beneficiary `CollateralVault` fee escrows and
  reduces `allocationQ` by exactly that Q; floor-atom withdrawals keep fractions.
- Six implementation choices the spec leaves open are listed for the reviewer to confirm or reject in
  `docs/questions/A-I01.md`. API change: engine `protocolFeeEscrowQ()` / `withdrawProtocolFees()` removed;
  vault `withdrawFees()` etc. added; ABIs and `docs/risk/HANDOFF.md` updated.

## 4. Merge into main (us, plus the book developer)

- **Prep done 2026-10-02** on local branch `scratch/main-merge-prep` (`8b71ed7`, not pushed):
  `docs/merge/main-merge-prep.md` has the resolutions and results (fmt clean, 653 forge tests, G0–G6
  pass, G7 stops at A043 for the fingerprint reason above). The real merge is still human-only.
- **UNVERIFIED:** main's `foundry.toml` sets Monad's 128 KiB limit citing "spec §11.1"; our spec has no
  such section. A human should confirm the target-chain limit.

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

- Contract size: `CombinedEngine` runtime 112,924 B, initcode 121,706 B at `a073104` (forge 1.8.3).
  Above Ethereum's 24,576 B; below 131,072 B if main's Monad limit is right (UNVERIFIED, see section 4).
  Needs a human decision on the target-chain limit, and a measurement of the real production
  composition once the book seam exists.
- Gas: measured only with Ethereum pricing on a mock book (verified: `artifacts/risk/gas-engine.json`
  `gas_model`). Re-measure with the real book on Monad.
- Invariant campaigns and gas table **rerun at `a073104`** on forge 1.8.3 (`ba633ed`): random 48×64
  and 256×128 pass 9/9 with 0 reverts; 24 seeds pass. Gas figures under forge 1.8.3 are about
  1.2–2.8× the old forge 1.3.5 table for the same source (cause not diagnosed); the comparison is in
  `artifacts/risk/gas-engine.json`. Still Ethereum pricing on a mock book, not Monad.
- Missing production inputs (`artifacts/risk/release-manifest.json`, verified): token/code hashes,
  price signer details and depth N, volatility envelopes, stressed spread, absorption/queue bounds,
  OI and liquidation limits, hazard evidence, governance delay, dependency hashes, premium load as a
  manifest field.
- Then: calibration, an external audit, and an explicit release decision. Launch defaults: 1x leverage;
  funding, recovery and conversion off (verified: `release-manifest.json` `initial_defaults`,
  test `contracts/test/integration/ReleaseDefaults.t.sol`).

## Who does what next

- Teammate (next turn): review B-D02 (`fe4c4f7`) and A-I01 (`a073104`, choices in
  `docs/questions/A-I01.md`); if accepted, refresh the A043 fingerprints (`scripts/check_a_review.py`,
  `artifacts/reviews/A-on-B.json`) and rerun G7; answer B-D01…B-D05.
- Us (either, turn by turn): counterpart reruns when they ship; the real merge once a human asks.
- Humans only: G7 acceptance; the merge into main; confirming the target-chain code-size limit.
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
| A-I01 choices to confirm | `docs/questions/A-I01.md` |
| Main merge prep (dry run) | `docs/merge/main-merge-prep.md` |
| B-D02/B-D03 checks | `contracts/test/audit/BD02PreviewParity.t.sol`, `contracts/test/audit/BD03PremiumBounds.t.sol` |
| A-I01 tests | `contracts/test/integration/AI01FeeEscrow.t.sol` |
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

### 2026-10-02 (second turn) — 0xr10t (with Claude agent) — turn complete

- Started from `d1f0268` (clean, equal to origin). No commits from the teammate since the previous entry;
  `main`, `feat/clob`, `feat/oracle` and `feat/risk` had not moved.
- Done this turn:
  - Outdated docs fixed: `docs/risk/HANDOFF.md` section 10 and the old resume point in
    `docs/merge/integration-progress.md` both said B's delta review was pending.
  - B-D03 done (comment + tests). B-D02 implemented. A-I01 implemented. Both of the last two change
    `contracts/src` and need the teammate's review (see "Who does what next").
  - Invariant campaigns and gas table rerun at `a073104`; engine size re-measured.
  - Gates G0–G7 rerun; evidence committed.
  - Merge prep against `origin/main` on local `scratch/main-merge-prep` (`8b71ed7`, not pushed);
    report `docs/merge/main-merge-prep.md`.
- Commits: `e180c43` (turn marker), `ee42786` (docs), `39205c1` (B-D03), `fe4c4f7` (B-D02),
  `a073104` (A-I01), `ba633ed` (invariant + gas reruns), `e61c8a7` (gate evidence), and the commit
  that adds this entry.
- Tests run (forge 1.8.3, `FORGE_SNAPSHOT_EMIT=false`):
  - `FOUNDRY_PROFILE=risk forge test`: after B-D02 exit 0 (645 passed); after A-I01 exit 0 (653 passed).
    The first A-I01 run failed 2 tests (exit 1): `A036` backstop reruns `_assessAvailable`, and
    `CustodyExit` asserted the old in-market keeper classification. Fixed by moving reclassification
    to payout-scan completion and updating `CustodyExit` to the new classification with exact values.
  - `forge test --match-path test/audit/BD03PremiumBounds.t.sol` exit 0 (2 passed);
    `test/audit/BD02PreviewParity.t.sol` exit 0 at `fe4c4f7` and on the pre-refactor source.
  - Invariants: `risk` 48×64 exit 0 (9/9, 0 reverts); `ci` 256×128 exit 0 (9/9, 0 reverts);
    `test_seededCampaign` exit 0 (8/8, 24 seeds).
  - Gas: `test/gas/integration/EngineGas.t.sol` exit 0 at HEAD, `3b11044` and `f05f076` (comparison).
  - `bash scripts/check-gate.sh` at `ba633ed`: G0–G6 exit 0 (68/152/117/78/74/62/55);
    G7 exit 2 (A043 `pending_peer_review`: "reviewed source changed"). The first G5 run exited 2
    because `tsc` was not on PATH; rerun with the TypeScript 5.9.3 shim exited 0.
  - `check-task.sh` A040, A041, A042, A044, B040–B044 each exit 0; A043 exit 2 (same reason);
    `forge test --match-path 'test/reviews/*.t.sol'` exit 0 (37 passed).
  - Python A/B/audit/integration exit 0 (46/156/8/7); `export-risk-abis.py --check` exit 0.
  - Scratch merge `8b71ed7`: `forge fmt --check` 0; `ci forge build --sizes` 0; `risk forge test` 0
    (653); `ci FORGE_SNAPSHOT_CHECK=true forge test --mc BookGasTest` 0; `ci forge test -vvv` 0 (653);
    G0–G6 0, G7 2 (same A043 reason); Python 0. Scratch gate artifacts discarded.
- Not done / not claimed: no fingerprints or approvals written for my own changes; `gate_status.json`
  untouched; no push to `main`; no deployment.
- Open questions: the teammate's confirmation of A-I01 choices 1–6 (`docs/questions/A-I01.md`) and of
  B-D02; the teammate's answer on B-D01…B-D05; target-chain code-size limit (main cites Monad
  128 KiB "spec §11.1", not in our spec; UNVERIFIED); the cause of the forge 1.3.5 → 1.8.3 gas
  measurement jump (not diagnosed).
- Next turn: teammate (YASH-ai-bit) — review B-D02 and A-I01, refresh A043 fingerprints if accepted,
  rerun G7.
