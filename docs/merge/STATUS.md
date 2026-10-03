# Risk & Clearing — STATUS

- Shared branch: `integration/risk`; last updated by YASH-ai-bit's Codex turn on 2026-10-03.
- Unified Risk and Order Book ownership and automated validation: `CLAUDE.md` and `docs/merge/UNIFIED_WORKFLOW.md`.
- Historical reports and accepted G0–G6 SHAs are retained; technical reruns do not grant human acceptance.

## Current summary

**GOV-01 supersedes the earlier review workflow:** the user merged Risk and Order Book and
retired mandatory A/B peer review. We make and document implementation decisions without
waiting for those approvals. Historical review records remain unchanged. The strict INDEX-prefix
seal for RB-I11 is selected, with implementation/tests pending. Legacy G7 review enforcement
still needs migration; the earlier exit-2 result is not relabeled passed. Human G7 acceptance,
main merge and deployment remain separate. Earlier review-pending statements below are the
pre-GOV-01 record, not current teammate dependencies.

A reviewed B's newer work at `2506235`: **B-D02, B-D03 and A-I01 accepted**. All six fee-escrow
choices are confirmed in `docs/questions/A-I01.md`; B-D01 through B-D05 have A dispositions.
B's `32d30ac` review of A's earlier seven commits remains recorded for that historical range.

At the human's explicit request, main `a114d06` was merged **into integration/risk** at `13ca730`.
Main was not changed. The old three-conflict rehearsal is superseded: this merge reconciled five
conflicts and silent canonical-type/helper hazards while retaining the reviewed accounting and
stronger risk predicates. See `docs/merge/main-merge-prep.md`.

The current non-oracle repair turn starts from `1958aef`. The user explicitly extended ownership
to book internals and all Risk & Clearing work, including Person B's modules. Oracle implementation
and oracle-branch integration remain excluded. Main is unchanged. The source commits through
`be3db1e` implement RB-I02–RB-I07 and RB-I09. The user confirmed RB-I08: retain guarded safe
excess-collateral release during REDUCE_ONLY; all seven focused regressions pass.
See `docs/integration/NON_ORACLE_FIXES.md` for the fix ledger and validation scope.

The actual Book, A accounting/custody and B risk now include a bounded, stale-aware real-book
PERP sampler. This does not enable leverage, funding, recovery or conversion: the concrete engine
remains uncalibrated and fully backed at 1x. Matching examines at most eight makers per order;
whole-batch action and aggregate examination bounds also apply. Independent economic review is pending.

**RB-I11 remains OPEN: policy confirmation pending.** Later authenticated INDEX corrections can
leave already published BASIS tied to the earlier INDEX history. A proposed publication condition
would require a strictly newer authenticated INDEX observation to seal the captured prefix; it is
not approved or implemented. See `docs/questions/RB-I11-index-prefix-seal.md`. The new sampler is
not described as having every identified issue fixed.

The earlier Monad testnet deployment, real matching, controlled YES settlement and cash claims
remain historical successes on chain 10143. That smoke market is immutable and closed; none of
this turn's new source has been broadcast. Its test collateral, signed INDEX fixture and manual
resolution authority are not production counterparts. Historical receipts remain in
`artifacts/risk/monad-testnet-deployment.json` and `monad-testnet-smoke.json`.

The prior source `5b82d9f` passed 727 Forge tests and 217 Python tests; those counts do not certify
the new delta. Current full-risk validation at `1654b9f` passes **818 tests / 128 suites**, with
1000 fuzz runs and 48x64 invariants; seven later RB-I08 tests pass separately, not in that count.
ABI export/check passes at **294 concrete / 256 abstract / 35 vault entries**. The expanded
MonadTen bundle passes **92 tests / 10 suites**, including the full-history sampler benchmarks.
Python A/B/audit/integration passes **49/156/8/7 (220 total)**. SDK `npm.cmd test` passes its
strict build, accounting reader and six Node tests. Full CI at `4a050df` passes **825 tests /
129 suites**, zero failed/skipped, with 10000 fuzz cases (seed `0x45524f53`) and 256x128 invariant
campaigns. Ordered G0–G6 pass; G7 exits 2 at stale source-bound A043 after six passing tests.
Independent review/human acceptance and RB-I11's policy decision remain open.
Read-only deployment estimation for current source returns **27,820,847 gas** at block **67865259**:
`artifacts/risk/non-oracle-deployment-estimate-2026-10-03.json`. This is not a deployment receipt.

## Review and gates

- G0–G6: historical accepted records remain in `docs/spec/gate_status.json`; current technical
  reruns at `4a050df` exit 0 with 71/152/117/78/77/63/55 tests; evidence is in `artifacts/gates/`.
- A043's earlier fingerprints cover the reviewed merge, not RB-I01 or the new RB-I02–RB-I09 delta.
  Independent teammate review and source-bound refresh are pending; no self-approval is written.
- **G7 remains blocked for fresh peer review and human acceptance; merge_sha stays null**.
- The current G7 runner exits 2 at A043 after six tests. Direct G7 Solidity tests pass 6/6;
  A044/B040/B041/B042/B043/B044 also pass separately. B043's harness result is not a new peer approval.
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
- **RB-I02: implemented, peer review pending** at `857b5c0`. Refresh only the exact surviving
  reduce-only maker node after its own successful fill; keep unrelated stale-order guards.
- **RB-I03: implemented** at `bd9d5b9`. Canonical participant IDs use the append-only registry's
  constant-time mapping; the concrete consumer is included in the later composition commit.
- **RB-I04: implemented, peer review pending** at `93e971e`. Recheck the actual maker execution
  price against the current bootstrap band, including voluntary reduce-only makers.
- **RB-I05: implemented, peer review pending** at `3942100`. Exact-N depth, directed VWAP rounding,
  shared 64-node scan, reduce-only exclusion and later-block provenance-checked promotion.
  Fresh-INDEX fully backed placement/matching/cancellation remains available before PERP warm-up.
- **RB-I06: implemented, peer review pending** at `9c3a2e0`. During REDUCE_ONLY, prune ordinary
  makers rather than allowing them to open new exposure against a reducing taker.
- **RB-I07: implemented, peer review pending** at `0c93b63`. Reject unsupported hazard and
  listing band/spread domains before staging or initialization can poison later arithmetic.
- **RB-I08: user decision confirmed.** Safe excess release remains available during REDUCE_ONLY
  under the existing guards. Commit `4a050df` clarifies the spec and adds seven passing regressions;
  see `docs/questions/RB-I08-reduce-only-release.md`. No production predicate was changed.
- **RB-I09: implemented and measured; peer review pending** at `be3db1e`. Measured 64-maker matching
  exceeded the transaction budget; the concrete bound is eight, with bounded whole batches.
  Full-history, cold-account and admission-halving gas regressions retain the larger-cap comparisons.
- **RB-I10: implemented** at `56787d2`. Pin the local SDK compiler to TypeScript 5.9.3 and verify
  runner selection rather than trusting an arbitrary global compiler; SDK and runner checks pass.
- **RB-I11: OPEN, policy confirmation pending.** Decide whether book-derived PERP may publish
  only after a strictly newer authenticated INDEX sample seals capture-time history. Existing
  signed same-second/delayed correction semantics remain unchanged; no repair is claimed.
- Next reviewer: B/shared teammate, independently review all new economic/interface deltas and
  prior unreviewed RB-I01/concrete tooling. Do not reimplement the already-shipped sampler or
  maker repair. Current instructions: `docs/requests/A-to-B-merge-followup.md`.

An inherited informational keeper observation is also recorded in `docs/questions/A-I01.md`:
earned fees can be withdrawn after wall-clock T before stored halt is materialized. No custody
failure or new A-I01 regression was found; lifecycle-policy changes require separate review.

## Counterparts and production

- **Book:** actual Book + risk/accounting was exercised on Monad testnet at the older source.
  This turn edits book internals under explicit user authorization; the new repairs and sampler
  are unbroadcast and require independent review, not another implementation handoff.
- **Oracle:** implementation, SDK and tests were observed at `origin/feat/oracle:ccbdb50`.
  Real-engine integration remains excluded and BLOCKED_BY_COUNTERPART; no oracle branch was merged.
  Public enum NONE/YES/NO/INVALID is 0/1/2/3; Voided uses settleInvalid, not enum 4.
- **Price collector/signing service, real factory join, frontend/indexer:** BLOCKED_BY_COUNTERPART.
  Ownership is coordinated within the three existing teams, not assumed additional teams.
- **Conversion:** disabled, NOT_IN_RELEASE.
- Toolchain: forge 1.8.3, solc 0.8.30, Prague, optimizer 200. SDK TypeScript is now pinned locally
  to 5.9.3 by `56787d2`; historical global 5.9.2 results are not the current compiler choice.
  This machine uses Python 3.12.10 and audit NumPy 2.2.6; historical teammate environments differed.
- Main's default code-size setting is 131072; risk/ci fixture limits are 1000000. These settings do
  not certify a target-chain limit. Fixture sizes and limitations are in the release manifest.
- Current concrete artifact: 120253 runtime bytes, 129495 creation bytes plus 928 constructor
  argument bytes, totaling 130423 initcode bytes. The read-only RPC estimate above is separate
  from the historical deployed bytecode and from operation-gas regression results.
- Production configuration, empirical calibration, dependency/code hashes, real-chain gas,
  independent audit and an explicit release decision remain required. Launch defaults remain
  1x leverage with funding/recovery/conversion off.

## Next turn

1. Inspect the completed validation/evidence at `4a050df`; preserve exact source-bound counts
   and distinguish passing technical checks from blocked review or policy decisions.
2. B/shared teammate: independently review RB-I01 and the new RB-I02–RB-I09 source, then refresh
   source-bound review evidence only for work actually reviewed. Inspect RB-I10's pinned compiler
   and reproducible runner selection alongside the current SDK outputs.
3. Humans: confirm RB-I11's proposed INDEX-prefix publication policy before implementation.
   Coordinate factory/collector joins; oracle integration requires separate authorization.
   Review the confirmed RB-I08 guards rather than reopening the user's chosen policy.
4. Humans: G7 acceptance at a real reviewed commit; eventual main update and production release decisions.
5. Never relabel controlled testnet fixtures as production counterpart acceptance.

## Current records

- Initial history report: `docs/merge/history-review-2026-10-03.md`.
- Reviews: `artifacts/reviews/A-on-B.md`, `A-on-B.json`, `B-on-A.md`.
- Current tracker: `docs/integration/RISK_BOOK_TRACKER.md`.
- Current non-oracle work: `docs/integration/NON_ORACLE_FIXES.md`; deployment estimate:
  `artifacts/risk/non-oracle-deployment-estimate-2026-10-03.json`.
- Current structured validation: `artifacts/risk/non-oracle-fixes-2026-10-03.json`; pending
  review and policy decisions remain explicit. RB-I11 question: `docs/questions/RB-I11-index-prefix-seal.md`.
- Historical live validation: `artifacts/risk/real-book-validation-2026-10-03.json`,
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

### 2026-10-03 (non-oracle repair turn) — YASH-ai-bit (with Codex agent) — turn complete; policy/review open

- Started from `1958aef` on `integration/risk`. The user authorized book internals and all Risk &
  Clearing modules, including Person B's work; oracle implementation/integration remains excluded.
  No main update, new deployment, review fingerprint or human gate acceptance is claimed.
  Final fetch still has `origin/integration/risk` at `1958aef`; no remote teammate changes arrived.
- Task commits: `bd9d5b9` RB-I03 canonical IDs; `857b5c0` RB-I02 maker remainder; `93e971e`
  RB-I04 bootstrap execution band; `9c3a2e0` RB-I06 reduce-only makers; `0c93b63` RB-I07 domains;
  `3942100` RB-I05 bounded real-book PERP sampler; `be3db1e` RB-I09 whole-call work bounds.
  Follow-up commits: `1654b9f` full-history gas qualification, `aaf700c` ABI/snapshot refresh,
  `56787d2` SDK compiler/runner work and `4a050df` RB-I08's confirmed policy/spec/tests.
  Final evidence/documentation commits follow these task commits; report their actual SHAs from
  `git log` at handoff rather than inventing a source or acceptance commit.
- Tests first reproduced the maker/version, bootstrap price, stage and domain defects. Repairs
  retain real A+B+Book accounting, fee reservations, both-outcome coverage and atomic rollback.
  Sampler policy is user-approved; implementation review is not independent teammate acceptance.
- Gas regression retained its original failures: 64-maker call 58,109,534 under Prague and
  30,994,601 under MonadTen. Concrete matching now caps examinations at eight; batch actions
  are capped at `min(32, maxFills)` and declared non-POST_ONLY examinations share `maxFills`.
- Expanded MonadTen run: **92 tests / 10 suites pass**, including 32 full-history gas benchmarks.
  The earlier 90-test bundle measured 16,619,933 gas for the eight-action normal-price mixed
  halving/matching call. The 64-distinct-account sampler measures 3,143,792 gas for the view,
  3,383,491 for capture and 3,290,777 for later-block promotion at fixture commit `1654b9f`.
  Full-risk there passes **818 tests / 128 suites**, 1000 fuzz and 48x64 invariants; ABI export/check
  passes **294/256/35**. Python A/B/audit/integration passes **49/156/8/7 (220 total)**; SDK
  `npm.cmd test` passes strict compilation, accounting-reader checks and six Node tests, exit 0.
  Full CI at `4a050df` passes **825 tests / 129 suites**, zero failed/skipped, in 1469.81 seconds.
  Command: `FOUNDRY_PROFILE=ci FORGE_SNAPSHOT_EMIT=false FORGE_SNAPSHOT_CHECK=true forge test --fuzz-seed 0x45524f53 -vv`;
  10000 fuzz cases and 256x128 invariant campaigns; log `tmp/non-oracle-full-ci.log`.
  Ordered G0–G6 exit 0 at `4a050df`: **71/152/117/78/77/63/55** tests. G0 adds three SDK runner
  regressions. G7 exits **2** at stale source-bound A043 after six passing Solidity tests.
  A044/B040/B041/B042/B043/B044 separately exit 0: **44/2/2/3/1/1**; direct G7 Solidity exits 0,
  **6 tests / 2 suites**. `forge fmt --check` and ABI check exit 0, with **294/256/35** unchanged.
  The seven subsequent RB-I08 regressions pass separately in
  `tmp/rb-i08-policy.log`; no expected full-suite count is reported as an observed result.
- Read-only testnet deployment estimate at block 67865259: 27,820,847 gas. Artifact sizes are
  120253 runtime / 129495 creation + 928 arguments = 130423 initcode bytes. Evidence:
  `artifacts/risk/non-oracle-deployment-estimate-2026-10-03.json`; `broadcast` is false.
  No new source exists at the older closed smoke-market address.
- The user confirmed RB-I08 during this turn: retain safe excess collateral release under the
  existing guards. Added narrow spec clarification and seven passing monitor/time, preview/execution,
  backing, stale-price, free-withdrawal and rollover regressions; no production behavior change.
- RB-I11 was subsequently documented as OPEN: authenticated INDEX correction can change the
  historical basis relationship after a PERP observation has been published. The proposed sealed
  INDEX-prefix publication rule awaits policy confirmation; no runtime or fixture changes made.
- Open items: independent teammate review of all new deltas and earlier RB-I01; RB-I11 policy;
  collector/factory roles and inputs; production calibration/security/release decisions.
  G7 remains blocked for current peer review and human acceptance; `merge_sha` stays null.
- Next owner: B/shared teammate, following `docs/requests/A-to-B-merge-followup.md`.
  Review the implemented sampler and maker repair rather than asking another team to rebuild them.

### 2026-10-03 (GOV-01) — unified Risk and Order Book — turn complete

- Started from `507a703`; fetched shared remote at the same commit. Preserved the pre-existing
  untracked handoff and Python caches. No runtime, runner, oracle or deployment changes.
- User merged Risk and Order Book and retired mandatory A/B peer review. Updated CLAUDE and
  current handoff banners; `docs/merge/UNIFIED_WORKFLOW.md` is the governing workflow. Historical
  reviews and their hashes stay unchanged; no independent review is manufactured.
- Selected RB-I11's strict newer-INDEX prefix seal under delegated decision authority, preserving
  bootstrap and documenting feed-cadence costs. This is a policy selection, not an implemented fix.
- G7 review requirements are retired in current status metadata, but the legacy runner still
  enforces them. Its previous exit 2 remains true. Migrating enforcement while retaining A043/B043
  regression suites is pending engineering work; no new technical pass or human acceptance claimed.
- Validation: documentation diff whitespace check and gate-status JSON parse pass. Existing 825-test
  CI and other results remain evidence of the previously recorded source, not new runs this turn.
- Next: unified team implements/tests RB-I11 and migrates legacy G7 review enforcement, recording
  source-bound technical results rather than A/B signatures. Main and deployment permissions remain
  separate. This workflow update is committed and pushed under GOV-01; see `git log` for its SHA.
