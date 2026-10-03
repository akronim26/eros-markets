# Risk & Clearing — STATUS

- Shared branch: `integration/risk`; last updated by YASH-ai-bit's Codex turn on 2026-10-03.
- Shared, turn-by-turn ownership and independent economic review: `CLAUDE.md`.
- Historical reports and accepted G0–G6 SHAs are retained; technical reruns do not grant human acceptance.

## Current summary

A reviewed B's newer work at `2506235`: **B-D02, B-D03 and A-I01 accepted**. All six fee-escrow
choices are confirmed in `docs/questions/A-I01.md`; B-D01 through B-D05 have A dispositions.
B's `32d30ac` review of A's earlier seven commits remains recorded for that historical range.

At the human's explicit request, main `a114d06` was merged **into integration/risk** at `13ca730`.
Main was not changed. The old three-conflict rehearsal is superseded: this merge reconciled five
conflicts and silent canonical-type/helper hazards while retaining the reviewed accounting and
stronger risk predicates. See `docs/merge/main-merge-prep.md`.

The earlier 692-test merge baseline is historical. The current work repairs RB-I01, adds a
guarded concrete `contracts/src/engine/BookRiskEngine.sol`, stateful real-book invariants, and
controlled Monad testnet deployment/exercise tooling. Real A accounting/custody and real B risk
are joined to the real Book; counterpart token, INDEX and resolution remain explicit test fixtures.

The user authorized Monad testnet evaluation and funded its test-only signer. Foundation
deployment, two-account funding/activation, actual matching, YES settlement and cash claims have
succeeded on chain 10143. Exact addresses, verification and current test results are recorded in
`docs/integration/RISK_BOOK_TRACKER.md` and `artifacts/risk/real-book-validation-2026-10-03.json`.
This is a completed, closed smoke market, not a production market or live oracle integration.

Current validation at `5b82d9f`: **727 Forge tests / 117 suites and 217 Python tests pass**.
Eight focused smoke tests also pass under MonadTen. ABI export/check and formatting pass.
Ordered G0–G6 pass; G7 exits 2 at stale A043. Separately, A044/B040–B044 and the six-test
direct G7 suite pass; these technical passes do not manufacture a current review or gate acceptance.

## Review and gates

- G0–G6: historical accepted records remain in `docs/spec/gate_status.json`; current technical
  reruns are separate evidence in `artifacts/gates/`.
- A043's earlier fingerprints cover the reviewed merge, not the new RB-I01/concrete-engine source.
  Independent teammate review and source-bound refresh are pending; no self-approval is written.
- **G7 remains blocked for fresh peer review and human acceptance; merge_sha stays null**.
- B's acceptance recommendation at `3b11044 + 32d30ac` is historical, not a blanket approval of
  later source. B should inspect this merge and any subsequent repair on the next turn.
- Monad testnet evaluation is explicitly authorized by the user. No mainnet release, merge into
  main, calibration approval or human G7 acceptance is authorized.

## Completed review items

| Item | Status |
| --- | --- |
| A-B01–A-B08 / A-F01–A-F03 | Earlier repairs retained; B delta review complete at `32d30ac`. |
| B-D01 | Acknowledged; later shared ownership supersedes per-file lanes, not peer review. |
| B-D02 | Accepted shared execution/preview funding and premium helpers; four independent edge regressions added. |
| B-D03 | Accepted domain-bound explanation and both existing bound tests. |
| B-D04 | Accepted cash-only policy; global protocol/keeper fee withdrawals now bypass engine cash-claim fencing. |
| B-D05 | Accepted fully backed result requirement when normal mark is unavailable. |
| A-I01 | Accepted exact global-vault fee classification, all six choices, plus four independent custody/recovery regressions. |
| Main reconciliation | Merged at `13ca730`; main's healthy-after-pair liquidation stop retained. |

## Integration repairs and open work

- **RB-I01: implemented, peer review pending** at `f2ebc61`. Refresh only the active reduce-only
  taker's authorization after its own successful posting. Validate LIMIT permit-to-rest against
  current state. Forced matching stops when a favorable fill restores health. Tests first exposed
  the old behavior and the coupled over-liquidation risk; 60 targeted tests pass after repair.
- **RB-I02: open, Low.** A partially filled reduce-only maker retains its old version and is pruned
  on the next taker. A coordinated book-hook return/node-update change is required, not removing
  stale-order protection. See `docs/requests/RB-I02-maker-remainder.md`.
- **PERP sampler: open.** A bounded, stale-aware real book-depth adapter is missing. The concrete
  engine deliberately remains uncalibrated, fully backed 1x bootstrap with funding/recovery off.
- Next reviewer: B/shared teammate, independently review RB-I01 and the concrete engine plus
  deployment tooling. Current instructions: `docs/requests/A-to-B-merge-followup.md`.

An inherited informational keeper observation is also recorded in `docs/questions/A-I01.md`:
earned fees can be withdrawn after wall-clock T before stored halt is materialized. No custody
failure or new A-I01 regression was found; lifecycle-policy changes require separate review.

## Counterparts and production

- **Book:** actual Book + risk/accounting deployed and exercised on Monad testnet. RB-I01 needs
  review; RB-I02 and the production PERP sampler remain open. Book internals were not edited.
- **Oracle:** fetched `origin/feat/oracle` is now `ccbdb50`, with implementation, SDK and tests,
  not merely a plan. Real-engine integration remains BLOCKED_BY_COUNTERPART; this branch was not
  merged. Public enum NONE/YES/NO/INVALID is 0/1/2/3; Voided uses settleInvalid, not enum 4.
- **Price collector/signing service, real factory join, frontend/indexer:** BLOCKED_BY_COUNTERPART.
  Ownership is coordinated within the three existing teams, not assumed additional teams.
- **Conversion:** disabled, NOT_IN_RELEASE.
- Toolchain agreed by both teammates: forge 1.8.3, solc 0.8.30, Prague, optimizer 200. This machine:
  Python 3.12.10, TypeScript 5.9.2, audit NumPy 2.2.6. B used different Python/TS/NumPy versions.
- Main's default code-size setting is 131072; risk/ci fixture limits are 1000000. These settings do
  not certify a target-chain limit. Fixture sizes and limitations are in the release manifest.
- Production configuration, empirical calibration, dependency/code hashes, real-chain gas,
  independent audit and an explicit release decision remain required. Launch defaults remain
  1x leverage with funding/recovery/conversion off.

## Next turn

1. B: independently review RB-I01 and the concrete engine, then refresh source-bound review evidence.
2. Book and Risk: agree RB-I02 maker-remainder semantics and a bounded PERP sampler.
3. Oracle and Risk: jointly test the implemented oracle against the real engine after authorizing integration.
4. Humans: G7 acceptance at a real reviewed commit; eventual main update and production release decisions.
5. Never relabel controlled testnet fixtures as production counterpart acceptance.

## Current records

- Initial history report: `docs/merge/history-review-2026-10-03.md`.
- Reviews: `artifacts/reviews/A-on-B.md`, `A-on-B.json`, `B-on-A.md`.
- Current tracker: `docs/integration/RISK_BOOK_TRACKER.md`.
- Current validation: `artifacts/risk/real-book-validation-2026-10-03.json`,
  `monad-testnet-deployment.json`, `monad-testnet-smoke.json` under `artifacts/risk/`.
  `merge-validation-2026-10-03.json` and `review-validation.json` retain historical 692/641-test scope.
- Counterparts/release: `artifacts/risk/counterpart-status.json`, `release-manifest.json`.
- Merge resolution: `docs/merge/main-merge-prep.md`; six fee choices: `docs/questions/A-I01.md`.

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

### 2026-10-03 — YASH-ai-bit (with Codex agent) — turn complete

- Started at `2506235`, equal to the fetched shared branch; tracked source is clean. Existing
  untracked A-to-B handoff and Python caches are preserved, not incorporated as new evidence.
- Reported branch history to the human before changes. `origin/main` is now `a114d06`: the old
  `c5db208` merge rehearsal and the claim that no book-hook implementation exists are stale.
  Main has a real-book/real-B fixture, but its A accounting is still scripted.
- Scope: cross-review B-D02, B-D03 and A-I01; answer B-D01 through B-D05; add independent
  regression evidence as needed; refresh A043 only after review and rerun the gates.
- The human explicitly requested merging current `origin/main` into `integration/risk` and
  validating the real-book integration. No merge into main, G7 acceptance or deployment is authorized.
- Completed B-D02/B-D03/A-I01 review; accepted all six fee choices and answered B-D01 through B-D05.
  No economic rewrite of B's newer work was required. Eight independent review regressions added.
- Main reconciled with canonical types, the common snapshot helper and reviewed reduction/preview
  semantics. Retained main's fix stopping liquidation after a pair restores health.
- Added 17 real A+B+Book integration tests. Initial run: 16 pass, one failed because the proposed
  pair partner was healthy and correctly skipped. Corrected the fixture using actual trades at
  different entry prices; all 17 pass without changing production behavior or weakening assertions.
- Found RB-I01 (three passing characterization tests): first-fill position-version changes stop
  further reduce-only/forced fills and invalidate partial LIMIT remainders. Open, not repaired.
- Task commits: `0a70b55` history/scope; `a9d8ae7` independent B-delta review; `13ca730` main merge;
  `96cf262` real-book tests; `ad85941` source-bound A043 and ABI/metadata refresh. Final evidence
  and handoff commits follow these; no new branch, force-push or main update is part of this turn.
- Validation (forge 1.8.3 / solc 0.8.30 / Prague / optimizer 200): full risk-profile Forge 692/692,
  0 failed or skipped (113 suites); Python A/B/audit/integration 46/156/8/7, all exit 0.
  G0–G7 ordered exits all 0. ABI check: engine 254 / vault 35 entries, exit 0. Review directory:
  45/45. CI-profile BookGas snapshot check, formatter check and build-with-sizes exit 0;
  snapshots not rewritten. The build still emits non-fatal lint warnings.
  The full CI-profile fuzz/invariant campaign was not rerun; do not relabel the older campaign.
- Solidity sources/tests stayed unchanged during the final full run; review/docs metadata was
  committed during it. Gate runners retain their actual `ad85941` starting HEAD and dirty flags.
- Sizes of test fixtures: CombinedEngine runtime/initcode 112723/121505 bytes; RealBookEngine
  114737/123964. No target-chain or production deployment approval follows from fixture sizes.
- Structured next-turn instructions: `docs/requests/A-to-B-merge-followup.md`. Next owner B/shared
  turn: review the merge, triage/repair RB-I01 with intended-behavior tests; A reviews any economic
  repair independently. Humans retain G7 acceptance; oracle/feed/factory/app owners retain their joins.

### 2026-10-03 (testnet turn) — YASH-ai-bit (with Codex agent) — turn complete

- Started from shared branch `16f0d90`; preserved the existing untracked A-to-B handoff and Python
  caches. Final fetch still has that remote risk head. Main remains `a114d06`; fetched oracle is
  now `ccbdb50` with real implementation, not a plan-only branch. No main/oracle merge or push.
- The user authorized real-book/risk testing and implementation, Monad testnet evaluation, a local
  test-only deployment wallet, and a living Markdown tracker. The user funded the public signer
  with 10 test MON. Encrypted keystore and Windows-protected password/RPC remain outside Git;
  no credential, private key or password is included in reports.
- Implemented RB-I01 with failing tests first: safe active reduce-only taker continuation,
  current-version LIMIT rest conversion, and forced-fill stop after restored health. Initial
  liquidation regression exposed 648734 lots closed instead of 300000; fixed without weakening
  genuine stale-order, no-flip, coverage, ownership or rollback checks. Peer review remains pending.
- Added the guarded concrete 1x `BookRiskEngine`, controlled collateral/authority fixtures,
  deployment/verification scripts, offline fresh signing and a stateful real-book invariant handler.
  Did not edit book or oracle internals. RB-I02 maker remainder and the PERP sampler stay open.
- Task commits: `f2ebc61` RB-I01; `1077dfa` concrete engine/preflight; `47149e5` stateful invariants;
  `163b709` signed lifecycle/verification; `5b82d9f` fresh offline signing and final-state verifier;
  `20330d8` full/gate/ABI and live-chain evidence. This final docs commit adds the living tracker,
  reconciled handoffs/manifests and this turn log; its SHA is available from `git log -1`.
- Validation at `5b82d9f`, Forge 1.8.3 / solc 0.8.30 / Prague / optimizer 200:
  - `FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge test -vv`: exit 0, **727/727**,
    117 suites, zero failed/skipped. Includes 23 real-book, 9 concrete-engine and 8 smoke tests.
  - Focused smoke under `--network monad --hardfork monad:MonadTen`: exit 0, **8/8**.
  - Python A/B/audit/integration: exits 0, **46/156/8/7** (217 total).
  - New real-book invariants: 48 runs x 64 depth, 3072 calls, zero reverts; fuzz 1000 and
    deterministic eight-fill checks. Full CI 10000-fuzz/256x128 campaign not rerun.
  - ABI export/check: exit 0, concrete/abstract/vault **285/254/35**; `forge fmt --check`: exit 0.
  - Ordered G0–G6 exit 0 (**68/152/117/78/77/63/55**). G7 exits **2** after six tests at A043:
    current source is not covered by historical fingerprints. No fingerprints or approval invented.
  - A044/B040/B041/B042/B043/B044 separately exit 0 (**44/2/2/3/1/1**); direct G7 Solidity suite
    exit 0 (**6/6**). B043 harness success is not new independent peer review or G7 acceptance.
- Live Monad chain 10143: foundation six transactions, setup five, direct trade one, settlement
  three; **15 successful receipts**. Engine `0x4aE742676984D2C383645E4745Eaf3943b67DE72` has
  114546 runtime / 124593 initcode bytes; engine creation receipt gas **27904929**, below 30M.
  Seven final smoke runtimes and expected roles/immutables compared with local artifacts. Nested
  ReserveVault runtime was not independently compared; RPC/artifact verification is not an audit.
- Actual vault-backed deposits and allocation total 200 test tokens; matching posts +/-100000 lots
  at tick 500. Manual YES finality, bounded preparation and claims leave actor balances **150/50**,
  zero unpaid trader claims, and zero actual/recognized vault custody. Market is terminally closed.
  Fixture collateral, synthetic signed INDEX and manual authority are not production counterparts.
- Operational finding: fork-based trade simulation outlasted the 30-second freshness window;
  node gas estimation rejected it and **no trade transaction was broadcast** by that attempt.
  Fresh offline preparation and direct estimated send succeeded, without bypassing freshness.
  Local Anvil launch was unavailable; no local-node execution is claimed in place of the live run.
- Actual total fee **4.223887319407733183 test MON**; remaining signer balance
  **5.776112680592266817 test MON**. No more broadcasts planned. Receipts/state evidence:
  `artifacts/risk/monad-testnet-deployment.json`, `monad-testnet-smoke.json` and
  `real-book-validation-2026-10-03.json`; runbook includes bounded fresh-signing reproduction.
- Current shared planning file: `docs/integration/RISK_BOOK_TRACKER.md`. Review source/evidence,
  limits and owner-specific next steps there before changing behavior. Generated lane-A handoff
  artifacts retain lane-local mock labels; they do not supersede combined/live evidence.
- Next turn: independent Risk teammate reviews RB-I01/concrete source and refreshes review evidence;
  Risk + Book agree RB-I02 and bounded PERP depth; Risk + Oracle coordinate actual-engine finality
  tests. Collector/factory/app joins and production calibration remain open. G7 human acceptance,
  production/mainnet deployment and main update are not authorized or claimed.
