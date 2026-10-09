# Risk & Clearing — STATUS

Current deployed addresses and operator status are recorded in
[addresses.md](../../addresses.md) and
[DEPLOYMENT_PROGRESS.md](../integration/DEPLOYMENT_PROGRESS.md). The October 9
replacement BTC/ETH markets supersede the fixture and earlier integration
deployments below. This file retains source-bound engineering history; old
deployment addresses and authorization boundaries describe their recorded turns.

- Shared branch: `integration/risk`; integration follow-up updated on 2026-10-06.
- Unified Risk and Order Book ownership and automated validation: `CLAUDE.md` and `docs/merge/UNIFIED_WORKFLOW.md`.
- Historical reports and accepted G0–G6 SHAs are retained; technical reruns do not grant human acceptance.

## Historical integration summary — October 6

**Integrated backend follow-up, 2026-10-06:** current entrypoints and boundaries
are documented in [INTEGRATION_READINESS.md](../integration/INTEGRATION_READINESS.md),
with a versioned frontend SDK/read handoff and the integrated deployment runbook.
The current work includes generic bounded rollover, real-engine oracle service
adapters, genuine-source local execution, owner transaction builders, canonical
receipt/state audits and deployment preparation for two code stores plus the
factory/vault/registry sequence. Final validation is recorded separately from the
historical checkpoints below. Public deployment and frontend branch merging
remain deferred; no prior human gate approval is renewed.

The leveraged settlement proof exposed a reporting-only defect: the accounting
ledger paid full claims, but the status/event omitted the reserve-funded deficit.
The bridge now derives exact final deficit and net whole reserve contribution
from frozen accounting aggregates. Original claims, custody and coverage rules
remain enforced. Because this changes engine bytecode, final deployment/live
proofs must identify the rebuilt runtime, rather than reuse an earlier address.

**Reserve-funded leverage, 2026-10-05 (RF-06 checkpoint):** constructor-bound listings
now support up to 5x under the existing template, margin and reserve rules. Reserve
capital must precede activation; the frozen 2% account deficit cap and full winner
payouts remain enforced. Calibration/fresh prices gate leverage; funding, recovery
haircuts and conversion stay disabled. Deployment uses two pinned code stores.
A separate leverage scenario and persistent bounded liquidator are documented in
[LEVERAGE_INTEGRATION.md](../integration/LEVERAGE_INTEGRATION.md). Fresh risk/book
832/832, leverage 12/12 and isolated deployment gas 5/5 checks pass. Earlier 1x
receipts remain historical references. No new gate acceptance or public deployment.

**Local joined stack, 2026-10-05:** `integration/risk` now contains the existing
pricefeed checkpoint `b7b8442` by fast-forward. RF-06 integration additions join
the actual factory, registry, oracle, book/risk engines, vault, pricefeed pipeline,
sampler and keeper on an isolated chain 31337. A full run deploys two markets, funds
two owners, partially fills/cancels orders, exercises release/withdrawal, and resolves
and pays the terminal market while leaving the demo active. Canonical receipt audit:
86 script transactions plus 5 keeper transactions; no public-chain transactions.
Longer-running checks exposed a missing hourly operational step: the local stack now
performs bounded epoch rollover and explicit fixture-owner re-quoting, with 10 actual
transactions across the two markets in its deliberate hour-boundary regression.
External price data, collateral and assertion adjudication are explicitly fixtures.
See the new local execution section of
[REAL_FACTORY_INTEGRATION.md](../integration/REAL_FACTORY_INTEGRATION.md).
The detailed root `LOCAL_INTEGRATION_HANDOFF.md` is intentionally uncommitted and
shared in a source bundle, not published by Git. No new G7/OG3b acceptance is inferred.

**RF-01 through RF-05, local implementation:** after pulling the oracle work, the user
authorized real factory/oracle/risk/book integration, deferring sponsors and frontend.
`0255c7b` adds the constructor-preserving code-store factory, dedicated collateral vault,
registry-bound OI cap, depth-capacity guard and real-contract integration tests.
`0ff2b69` adds per-market keeper identity/gas checks and simulation-first market-operation
helpers. See [REAL_FACTORY_INTEGRATION.md](../integration/REAL_FACTORY_INTEGRATION.md)
for measurements, evidence limits and the operator checklist. This explicitly supersedes
historical oracle-excluded statements below for this integration work.

The local atomic listing path fits representative bounded packs; it is no longer blocked
on a presumed need for proxies or clones. Each actual pack still needs a full estimate,
and creation-code-store headroom is narrow. Registry OI cap enforcement is required to
keep halted exposure within the listing's resolution-bond sizing assumptions.

**RF-LIVE remains blocked:** control of the required public governance/lister roles and
approved continuous real-source INDEX publication have not been established. The
publisher code is now present and locally exercised; this is not live feed approval. No live factory
switch, deployment, oracle administration, address update, O42 completion or new gate
acceptance is performed. Existing deployment addresses and historical G7 acceptance
remain unchanged. The new relay is not a fabricated or substitute pricefeed.

**GOV-01 supersedes the earlier review workflow:** the user merged Risk and Order Book and
retired mandatory A/B peer review. We make and document implementation decisions without
waiting for those approvals. Historical review records remain unchanged. The strict INDEX-prefix
seal for RB-I11 is implemented in `dcb6b0e`, with 21 passing sampler regressions. G7 technical
runner migration is implemented in `bee683b` plus `e05bbbb`, with 17 mocked regressions passing;
ordered G0-G7 all exit 0 at metadata `c91acf7`. Earlier exit-2 records remain historical.
The user's explicit conditional G7 acceptance is now satisfied and recorded at
**2026-10-03 17:39:11 UTC** for that source. On 2026-10-04 the user separately authorized committing
the sponsor plan, fast-forwarding `main` to `integration/risk`, and pushing both branches (MAIN-01).
The local fast-forward succeeded without conflicts; the publication checkpoint is recorded below.
The user separately authorized the current-source Monad testnet foundation deployment; it succeeded.
Historical turn-log review blockers are not current dependencies.

**RB-DEPLOY complete:** source `162ac92`, Solidity unchanged at `dcb6b0e`, now deployed as engine
`0x58c63bfd94c13acb6f1da665406cc16cf80d1b69` on chain **10143**. Six successful transactions;
five runtimes and vault/authority/reserve bindings verified. The [October 4 deployment report](../../artifacts/risk/monad-testnet-deployment-2026-10-04.json)
preserves this historical fixture's address handoff. At this checkpoint the market was **unactivated**, with no minted collateral,
trading, halt or settlement. Frontend/oracle integration and demo setup are delegated to their team.
This fixture's immutable manual authority cannot be replaced with the real oracle in place.

A reviewed B's newer work at `2506235`: **B-D02, B-D03 and A-I01 accepted**. All six fee-escrow
choices are confirmed in `docs/questions/A-I01.md`; B-D01 through B-D05 have A dispositions.
B's `32d30ac` review of A's earlier seven commits remains recorded for that historical range.

At the human's explicit request, main `a114d06` was merged **into integration/risk** at `13ca730`.
Main was not changed by that earlier merge. The old three-conflict rehearsal is superseded: it reconciled five
conflicts and silent canonical-type/helper hazards while retaining the reviewed accounting and
stronger risk predicates. See `docs/merge/main-merge-prep.md`.

The historical non-oracle repair turn started from `1958aef`. The user explicitly extended ownership
to book internals and all Risk & Clearing work, including Person B's modules. Oracle implementation
and oracle-branch integration were excluded in that turn. Main stayed unchanged during that repair series. The source commits through
`be3db1e` implement RB-I02–RB-I07 and RB-I09. RB-I10's SDK pin is `56787d2`. The user confirmed
RB-I08: retain guarded safe excess-collateral release during REDUCE_ONLY; `4a050df` records
seven focused regressions. Latest source `dcb6b0e` also includes RB-I11 and RB-I12.
See `docs/integration/NON_ORACLE_FIXES.md` for the fix ledger and validation scope.

The actual Book, A accounting/custody and B risk now include a bounded, stale-aware real-book
PERP sampler. This does not enable leverage, funding, recovery or conversion: the concrete engine
remains uncalibrated and fully backed at 1x. Matching examines at most eight makers per order;
whole-batch action and aggregate examination bounds also apply. Evidence is unified-team
technical validation, not an independent security audit.

**RB-I11 is implemented in `dcb6b0e`.** A strictly newer authenticated INDEX checkpoint must seal
the capture prefix before PERP publication. Valid unsealed captures wait without renewed age;
expiry, mutation, checkpoint replacement and eligibility guards remain active. All 21 sampler
tests pass. See `docs/questions/RB-I11-index-prefix-seal.md` for the cadence/availability tradeoff.
**RB-I12 is implemented in `29c5f87`.** Local smoke reads `engine.maxFills()` and completes
bounded two-phase payout preparation. Two regressions and standalone offline chain-31337 script
pass; neither is a public-chain deployment or a live production-counterpart test.

The earlier Monad testnet deployment, real matching, controlled YES settlement and cash claims
remain historical successes on chain 10143. That smoke market is immutable and closed; it does
not contain the new source. The separate current-source foundation is recorded above. Test
collateral, signed INDEX fixture and manual resolution authority are not production counterparts.
Historical receipts remain in
`artifacts/risk/monad-testnet-deployment.json` and `monad-testnet-smoke.json`.

The prior source `5b82d9f` passed 727 Forge tests and 217 Python tests; those counts do not certify
the new delta. Historical full-risk validation at `1654b9f` passes **818 tests / 128 suites**, with
1000 fuzz runs and 48x64 invariants; seven later RB-I08 tests pass separately, not in that count.
ABI export/check passes at **294 concrete / 256 abstract / 35 vault entries**. The expanded
MonadTen bundle passes **92 tests / 10 suites**, including the full-history sampler benchmarks.
Python A/B/audit/integration passes **49/156/8/7 (220 total)**. SDK `npm.cmd test` passes its
strict build, accounting reader and six Node tests. Full CI at `4a050df` passes **825 tests /
129 suites**, zero failed/skipped, with 10000 fuzz cases (seed `0x45524f53`) and 256x128 invariant
campaigns. Ordered G0–G6 pass; G7 exits 2 at stale source-bound A043 after six passing tests.
Those are historical checks under the former review workflow, not current-source reruns.
At unchanged Solidity `dcb6b0e`, full CI passes **832 tests / 130 suites**, zero failed/skipped,
in **1,461.88 seconds**, with 10,000 fuzz, seed `0x45524f53`, 256 x 128 invariants and strict
snapshots (`tmp/unified-full-ci.log`). Final candidate `e05bbbb` MonadTen passes **99 tests /
11 suites** in **3.04 seconds** (`tmp/unified-monad-final.log`). Sampler **21/21** and local
smoke **2/2** overlap those totals. Python A/B/audit/integration pass **66/156/8/7**, total **237**;
A includes 17 mocked GOV runner regressions. SDK strict build/accounting reader and six Node tests
pass. Format and ABI export/check exit **0**, entries **294/256/35**, concrete source digest
`40e05c0e8034dcdba2a14fc19a97f2323412e69f92dc2146cac913ef8695cbb3`.
The standalone local script exits 0 (`tmp/rb-i12-local-script-green.log`), reporting
**45,478,303 aggregate gas across multiple virtual transactions**, not a single Monad call.
Migrated ordered **G0-G7 all exit 0**, zero skipped, at
`c91acf75ae9770f0bf5ae2238b4018202d57acd8`, with reported counts
**88/152/117/78/77/63/55/156**. G0 adds 17 mocked GOV tests; G7 now counts actual Forge tests
rather than subprocesses. A043/B043 source-bound technical checks pass **68/3**; counts overlap
CI and are not independent audit signatures. G7 integration acceptance is recorded from the
user's authorization, `reviewed_by: []`; runner artifacts retain false/null acceptance fields.
Current runtime/creation/args/initcode are
**120,402/129,644/928/130,572 bytes**. Read-only chain-10143 estimate **27,853,253 gas**, headroom
**2,146,747**, passes at block **67,886,057** in `artifacts/risk/unified-deployment-estimate-2026-10-03.json`.
It uses historical public fixture dependencies/listing, not a fresh deployment configuration or
receipt. The earlier non-oracle estimate remains historical at its original source.

## Review and gates

- G0–G6: historical accepted records remain in `docs/spec/gate_status.json`; earlier technical
  reruns at `4a050df` exit 0 with 71/152/117/78/77/63/55 tests; evidence is in `artifacts/gates/`.
- A043's earlier fingerprints cover their original source, not subsequent repairs. Preserve
  historical reviews; migration retains adversarial regression suites without mandatory signatures.
- **Current G0-G7 all pass; G7 integration is accepted** at source
  `c91acf75ae9770f0bf5ae2238b4018202d57acd8`, recorded 2026-10-03 17:39:11 UTC after the
  user's required condition was satisfied. `reviewed_by` remains empty: no A/B signature invented.
- Runner artifacts retain `accepted: false` and null acceptance SHA; only `docs/spec/gate_status.json`
  records human-authorized acceptance. Its accepted source does not represent an actual main merge.
- The earlier G7 runner exited 2 at A043 after six tests. Direct G7 Solidity tests passed 6/6;
  A044/B040/B041/B042/B043/B044 also pass separately. B043's harness result is not a new peer approval.
- B's acceptance recommendation at `3b11044 + 32d30ac` is historical, not a blanket approval of
  later source. It is not a required new signoff under GOV-01.
- Monad testnet evaluation is explicitly authorized by the user. No mainnet release, merge into
  main or calibration approval is authorized. Recorded G7 integration acceptance does not authorize them.

## Completed review items

| Item | Status |
| --- | --- |
| A-B01–A-B08 / A-F01–A-F03 | Earlier repairs retained; B delta review complete at `32d30ac`. |
| B-D01 | Historically acknowledged; GOV-01 now supersedes both per-file lanes and mandatory peer review. |
| B-D02 | Accepted shared execution/preview funding and premium helpers; four independent edge regressions added. |
| B-D03 | Accepted domain-bound explanation and both existing bound tests. |
| B-D04 | Accepted cash-only policy; global protocol/keeper fee withdrawals now bypass engine cash-claim fencing. |
| B-D05 | Accepted fully backed result requirement when normal mark is unavailable. |
| A-I01 | Accepted exact global-vault fee classification, all six choices, plus four independent custody/recovery regressions. |
| Main reconciliation | Merged at `13ca730`; main's healthy-after-pair liquidation stop retained. |

## Integration repairs and open work

- **RB-I01: implemented** at `f2ebc61`. Refresh only the active reduce-only
  taker's authorization after its own successful posting. Validate LIMIT permit-to-rest against
  current state. Forced matching stops when a favorable fill restores health. Tests first exposed
  the old behavior and the coupled over-liquidation risk; 60 targeted tests pass after repair.
- **RB-I02: implemented** at `857b5c0`. Refresh only the exact surviving
  reduce-only maker node after its own successful fill; keep unrelated stale-order guards.
- **RB-I03: implemented** at `bd9d5b9`. Canonical participant IDs use the append-only registry's
  constant-time mapping; the concrete consumer is included in the later composition commit.
- **RB-I04: implemented** at `93e971e`. Recheck the actual maker execution
  price against the current bootstrap band, including voluntary reduce-only makers.
- **RB-I05: implemented** at `3942100`. Exact-N depth, directed VWAP rounding,
  shared 64-node scan, reduce-only exclusion and later-block provenance-checked promotion.
  Fresh-INDEX fully backed placement/matching/cancellation remains available before PERP warm-up.
- **RB-I06: implemented** at `9c3a2e0`. During REDUCE_ONLY, prune ordinary
  makers rather than allowing them to open new exposure against a reducing taker.
- **RB-I07: implemented** at `0c93b63`. Reject unsupported hazard and
  listing band/spread domains before staging or initialization can poison later arithmetic.
- **RB-I08: user decision confirmed.** Safe excess release remains available during REDUCE_ONLY
  under the existing guards. Commit `4a050df` clarifies the spec and adds seven passing regressions;
  see `docs/questions/RB-I08-reduce-only-release.md`. No production predicate was changed.
- **RB-I09: implemented and measured** at `be3db1e`. Measured 64-maker matching
  exceeded the transaction budget; the concrete bound is eight, with bounded whole batches.
  Full-history, cold-account and admission-halving gas regressions retain the larger-cap comparisons.
- **RB-I10: implemented** at `56787d2`. Pin the local SDK compiler to TypeScript 5.9.3 and verify
  runner selection rather than trusting an arbitrary global compiler; SDK and runner checks pass.
- **RB-I11: implemented** at `dcb6b0e`. Require strict INDEX-prefix sealing before publishing
  captured PERP; preserve original pending expiry and reject mutated checkpoint/book state.
  Twenty-one sampler regressions pass; generic signed ingress semantics stay unchanged.
- **RB-I12: implemented** at `29c5f87`. Dynamic matching cap and bounded two-phase payout
  preparation restore local smoke; two tests and a no-RPC/no-broadcast script rehearsal pass.
- Ordered gates and consolidated technical evidence are complete; the user's conditional G7
  acceptance is recorded. Preserve historical reviews and remaining production-counterpart limits.

An inherited informational keeper observation is also recorded in `docs/questions/A-I01.md`:
earned fees can be withdrawn after wall-clock T before stored halt is materialized. No custody
failure or new A-I01 regression was found; lifecycle-policy changes require separate review.

## Counterparts and production

- **Book:** actual Book + risk/accounting was exercised on Monad testnet at the older source.
  This turn edits book internals under explicit user authorization; the new repairs and sampler
  are unbroadcast; validate them as unified-team work, not another ownership handoff.
- **Oracle:** implementation, SDK and tests were observed at `origin/feat/oracle:ccbdb50`.
  Real-engine integration remains excluded and BLOCKED_BY_COUNTERPART; no oracle branch was merged.
  Public enum NONE/YES/NO/INVALID is 0/1/2/3; Voided uses settleInvalid, not enum 4.
- **Price collector/signing service, real factory join, frontend/indexer:** BLOCKED_BY_COUNTERPART.
  Ownership is coordinated with actual counterparts, not assumed additional teams.
- **Conversion:** disabled, NOT_IN_RELEASE.
- Toolchain: forge 1.8.3, solc 0.8.30, Prague, optimizer 200. SDK TypeScript is now pinned locally
  to 5.9.3 by `56787d2`; historical global 5.9.2 results are not the current compiler choice.
  This machine uses Python 3.12.10 and audit NumPy 2.2.6; historical teammate environments differed.
- Main's default code-size setting is 131072; risk/ci fixture limits are 1000000. These settings do
  not certify a target-chain limit. Fixture sizes and limitations are in the release manifest.
- Current concrete runtime/creation/args/initcode: 120402/129644/928/130572 bytes. Current
  source-bound ABI checks and read-only fixture creation estimate pass. Revalidate actual selected
  constructor dependencies/state for each deployment. The authorized current-source foundation
  is now verified; engine creation receipt gas is **29,245,915**, including the selected gas margin.
- Safe configuration: root `addresses.md` contains verified current public addresses; root
  `.env.example` stays blank and `docs/runbooks/RISK_BOOK_ENV_AND_ADDRESSES.md` distinguishes
  actual env consumers, CLI arguments, current fixtures and historical closed-market addresses.
- Production configuration, empirical calibration, dependency/code hashes, real-chain gas,
  independent audit and an explicit release decision remain required. Launch defaults remain
  1x leverage with funding/recovery/conversion off.

## Next turn

1. Preserve accepted non-oracle integration at `c91acf7`, Solidity `dcb6b0e` and source-bound
   gate evidence. Current-source foundation deployment is complete; do not rerun it blindly.
2. Frontend/oracle integration team uses root `addresses.md` for the current unactivated fixture.
   Coordinate test funding, authorized activation and fresh signed INDEX before trading; the
   ten-day schedule expires at **2026-10-13 19:39:36 UTC**, regardless of activation time.
3. A real oracle needs a new immutable listing/deployment with the actual authority, collector
   and factory inputs. Do not invent production addresses, feed guarantees or calibration.
4. Keep old closed-market receipts and new inactive-market evidence distinct. No smoke actors
   or settlement were created/executed for the new instance; ongoing demo setup is delegated.
5. Main updates, further broadcasts and production release need appropriate separate authority;
   never relabel controlled fixtures as production-counterpart acceptance.

## Current records

- Initial history report: `docs/merge/history-review-2026-10-03.md`.
- Reviews: `artifacts/reviews/A-on-B.md`, `A-on-B.json`, `B-on-A.md`.
- Current tracker: `docs/integration/RISK_BOOK_TRACKER.md`.
- Current deployed addresses: root `addresses.md`; six-receipt verification and nested reserve/
  inactive-state supplement: `artifacts/risk/monad-testnet-deployment-2026-10-04.json` and
  `artifacts/risk/monad-testnet-foundation-state-2026-10-04.json`.
- Current non-oracle work: `docs/integration/NON_ORACLE_FIXES.md`; deployment estimate:
  `artifacts/risk/non-oracle-deployment-estimate-2026-10-03.json`.
- Current aggregate path: `artifacts/risk/unified-integration-2026-10-03.json`. Earlier structured
  validation `artifacts/risk/non-oracle-fixes-2026-10-03.json` retains its historical source scope.
  RB-I11 decision: `docs/questions/RB-I11-index-prefix-seal.md`.
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

### 2026-10-03 (GOV-01 follow-through) — unified Risk and Order Book — validation complete; evidence ready to commit/push

- Source commits: `29c5f87` repairs RB-I12's local matching/payout smoke; `dcb6b0e` implements
  RB-I11's selected strict INDEX-prefix seal. Oracle remains excluded; no main update or broadcast.
- Tests first reproduce unsealed publication, waiting expiry and mutation failures. Final sampler
  suite passes 21/21, including capture-checkpoint replacement before sealing. Valid waiting
  captures retain original age; all invalidation guards and fully backed bootstrap remain active.
- Local smoke regressions pass 2/2; standalone `LocalBookRiskSmoke` dry run exits 0 on chain 31337
  without RPC/broadcast (`tmp/rb-i12-local-script-green.log`). The reported 45,478,303 gas is an
  aggregate across multiple virtual transactions, not a single Monad transaction estimate.
- Final MonadTen bundle passes 99 tests / 11 suites in 3.04 seconds at candidate `e05bbbb`
  (`tmp/unified-monad-final.log`). Full CI at unchanged Solidity `dcb6b0e` passes 832 tests /
  130 suites, zero failed/skipped, 1461.88 seconds, 10000 fuzz / seed 0x45524f53 / 256x128 invariant
  settings / strict snapshots (`tmp/unified-full-ci.log`). Targeted counts overlap, not additive.
- Python 66/156/8/7 = 237 tests, SDK strict build/accounting reader and six Node tests pass.
  Format and ABI export/check exit 0, 294/256/35 entries; concrete source digest is recorded above.
- Current runtime/creation/args/initcode: 120402/129644/928/130572 bytes. Read-only fixture creation
  estimate passes at chain 10143 block 67886057: 27853253 gas, 2146747 headroom, no broadcast.
- G7 technical migration `bee683b` plus global-config guard `e05bbbb` retain adversarial suites,
  provenance and failure/empty-suite checks, retire mandatory signatures, and pass all 17 new mocked
  regressions. Historical reviews stay untouched. Ordered G0-G7 all exit 0 at metadata
  `c91acf75ae9770f0bf5ae2238b4018202d57acd8`, source unchanged and manifests frozen before B044.
  Counts 88/152/117/78/77/63/55/156, zero skipped; G0 adds 17 GOV tests, G7 counts actual Forge
  tests rather than subprocesses. A043/B043 source-bound technical checks pass 68/3. Counts overlap CI.
- User-authorized G7 integration acceptance recorded in `docs/spec/gate_status.json` at
  2026-10-03 17:39:11 UTC, accepted source `c91acf7`, `reviewed_by: []`. Runner artifacts retain
  accepted false/null; no self-acceptance, peer signature, main merge or deployment is claimed.
- Final aggregate evidence: `artifacts/risk/unified-integration-2026-10-03.json`. This accepted
  non-oracle scope does not invent production oracle/collector/factory integration or inputs.
- Added safe configuration inventory, root blank `.env.example` and local-env ignore rules.
  Actual env consumers, CLI arguments, historical closed-market addresses and unresolved new
  addresses are explicit. No secret env, wallet, keystore or password content was read or recorded.
- Final task-wise evidence and documentation accompany this handoff on `integration/risk`.
  Next release work needs actual oracle/collector/factory inputs; main and new deployment need
  separate authorization. No source repair was redeployed to the historical closed smoke market.

### 2026-10-04 (RB-DEPLOY) — unified Risk and Order Book — turn complete

- User authorized deploying current contracts and recording addresses at repository root; frontend/
  oracle integration and ongoing demo/settlement handling are delegated to their integration team.
  Started at `162ac929d1b8bbb577ecc1fdcdb07816416b0e31`; fetched shared remote and preserved the
  pre-existing untracked handoff/caches. Main, Solidity, gate evidence and oracle branch unchanged.
- Pinned Forge 1.8.3, solc 0.8.30 Prague optimizer 200. Fresh command from `contracts`:
  `FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false FORGE_SNAPSHOT_CHECK=true forge test --match-contract 'TestnetRiskFixturesTest|BookRiskEngineTest|BookDepthSamplerTest' --network monad --hardfork monad:MonadTen -vv`
  exits **0**, **45 passed / 4 suites**, zero failed/skipped (`tmp/deploy-2026-10-04-tests.log`).
  `python scripts/export-risk-abis.py --check` exits **0**, ABI counts **294/256/35**, unchanged digest.
  Existing full CI/G0-G7 evidence was not rerun or reclassified as fresh live testing.
- Chain/nonce/balance preflight and full dry-run `DeployTestnetRiskBook` exit **0**. Broadcast used
  `--network monad --slow --gas-estimate-multiplier 105 --with-gas-price 110gwei
  --priority-gas-price 2gwei --confirmations 3 --skip-simulation --broadcast`, with existing encrypted
  keystore and private RPC. The prior full rehearsal passed; skipping the second simulation forces
  Forge 1.8.3 to estimate each sequential transaction via RPC rather than reuse underestimates for
  the two storage-binding calls. No contract checks were weakened; all receipt gas limits <30M.
- Broadcast exits **0**, six transactions at nonces **15..20** all status **1**. Engine plus nested
  reserve, collateral vault, test collateral and test authority deployed; engine registered and
  authority bound. Receipt gas total **32,073,366** across six transactions; engine **29,245,915**.
  Actual cost **3.271483332 test MON**, below the **4 MON** internal ceiling; balance after
  **2.504629348592266817 MON**, reconciled exactly to fees at block **67,915,348**.
- `python scripts/verify-monad-deployment.py --broadcast contracts/broadcast/DeployTestnetRiskBook.s.sol/10143/run-latest.json --output artifacts/risk/monad-testnet-deployment-2026-10-04.json`
  exits **0**. Read-only supplementary artifact/getter checks also exit **0**: nested ReserveVault
  runtime matches and engine binding is correct; active/halted/claims/price-ready false; token
  supply, allocations, reserve shares/holders and settlement account count zero. Source/runtimes,
  block hashes, views and balance reconciliation recorded in the dated foundation-state JSON.
- No token mint, actor/coordinator deployment, activation, trade, halt, finality or settlement this
  turn. New engine is `0x58c63bfd94c13acb6f1da665406cc16cf80d1b69`; `addresses.md` contains every
  actual contract address, market/source/rules IDs, schedule, roles, ABIs and transaction links.
  This is an immutable controller-oracle test fixture, not the real oracle integration or audit.
- Final local evidence/receipt/address/ABI/fee/link consistency checks and credential-pattern checks
  exit **0**; `git diff --check` exits **0**. Final fetch matches the starting shared source;
  `git diff c91acf7 -- contracts` is empty. Unrelated untracked files are not staged.
- Secrets stay outside Git/chat; a user-only temporary keystore-password file was removed after
  broadcasting. Raw RPC/broadcast/cache logs stay ignored. Public evidence and documentation are
  the task-wise RB-DEPLOY commit on `integration/risk`; historical manifests remain unchanged.
- Next owner: frontend/oracle integration team for activation/feed/UI and a correctly configured
  real-oracle market. Current fixture halt time is **2026-10-13 19:39:36 UTC**. No further broadcast
  or main update is included; see root `addresses.md` rather than the old closed-market ledger.

### 2026-10-04 (SP-00 / MAIN-01) — unified Risk and Order Book — turn complete; checkpoint ready for publication

- User explicitly confirmed: commit `SPONSOR_INTEGRATION_PLAN.md`, fast-forward `main` to
  `integration/risk`, and push both branches. This is separate from the earlier G7 authorization;
  it does not authorize production release, oracle integration or sponsor implementation.
- Fresh fetch: `origin/main` was `a114d06`, an ancestor of `integration/risk@c3510b8`, with
  zero main-only and 91 integration-only commits. Local main was also an ancestor of origin/main.
- `dcad454` commits the root sponsor plan: all 21 bounty entries, shared work, difficulty,
  blockers, current-source corrections and evidence boundaries. No implementation/configuration
  changes or new deployment accompany it. Unrelated untracked handoff and Python caches remain local.
- Document checks pass: 21 unique bounty sections, valid local links, no detected credential
  patterns; staged whitespace check exits 0. `git diff --quiet c91acf7 HEAD -- contracts scripts
  reference packages` exits 0: executable source remains the accepted candidate. Existing test/gate
  evidence is preserved; no fresh test suite or new peer approval is claimed for this promotion.
- Local `git merge --ff-only integration/risk` succeeds on main at `dcad454`; no conflict resolution,
  merge commit, force-push or rewritten history. This status-only commit accompanies the promotion;
  both branches are to be advanced to it and published together using an atomic, non-forced push.
- Scope remains the completed non-oracle risk/book checkpoint and controlled testnet foundation.
  Actual oracle/factory/INDEX services, active product demo and selected sponsor integrations remain
  future work. Branch equality and remote publication are verified after pushing; Git refs identify
  the published checkpoint without changing historical gate acceptance SHAs.

### 2026-10-05 — RF-01–RF-05 local real-factory integration

- User scope: real factory, oracle, risk and book only; sponsor/frontend work deferred.
  Oracle changes are already present at baseline `db11e46`. User confirms no local
  account controls the existing oracle stack and independent pricefeed is unfinished.
- `0255c7b`: STOP-prefixed creation-code store and registry-only factory, dedicated
  vault, original constructors, listing handshake and rollback tests; registry-bound
  OI cap and conservative capacity-aware sampler. No clone/proxy initialization.
- `0ff2b69`: runtime/chain-bound keeper classification and gas checks, Windows SDK
  root-path repair, sampler/explicit monitor/external-signature relay helpers with
  durable signed-transaction journals; CI integration job and service typechecks.
- Commands: pinned MonadTen/isolate integration suite exits 0 (37/37); keeper test
  exits 0 (87/87); operations test exits 0 (18/18); both typechecks and frozen install
  exit 0; final focused base book/sampler suites exit 0 (55/55); ABI check exits 0.
  Full risk baseline before the virtual-hook edit exits 0 (832/832, 130 suites).
- Ordered affected G3/G4/G6/G7 reruns exit 0 with 78/77/55/156 checks. New technical
  artifacts remain unaccepted; historical acceptance SHAs are unchanged. The artifact
  refresh also records the now-present pinned oracle submodules and checkout hashes.
- Local atomic registry listing succeeds for small and 8 KiB claim fixtures under
  a 29M forwarded execution budget; oversized claim failure rolls back completely.
  Code-store runtime headroom is 669 bytes. No universal listing-size or live-gas
  guarantee is inferred. Details are in `docs/integration/REAL_FACTORY_INTEGRATION.md`
  and `artifacts/integration/real-factory-local.json`.
- Broader SDK Windows check exits 1 (48 pass, six existing CRLF/test-fixture-path
  failures). Do not describe the whole repository as green. Separate oracle suite
  run: 294 pass/four setup/vector failures; isolated environment-corrected retries
  pass 49/49 with unchanged tests. All oracle invariant checks pass. Details are
  recorded in the integration document; the original failure evidence is retained.
- Open: actual authorized factory switch/listing, exact pack/network estimates,
  source/publisher, roles/trust/treasury setup, per-market runtime/gas enrollment,
  hosted operations and live O42/OG3b. No broadcast, credentials, `.env` edits,
  deployed-address edits, main merge or new gate acceptance in this turn.
- Next: hand the pinned implementation and operator checklist to the existing
  oracle governance/lister operator; complete the independent source before a live demo.

### 2026-10-05 — RF-06 local stack and reserve-funded leverage checkpoint

- User requested committing the completed integration and its dependencies. This
  checkpoint includes the local stack, Windows compatibility fixes, reserve-funded
  leverage, two-store factory deployment, liquidation operations, tests, ABI exports
  and evidence. The private handoff, runtime data and unrelated historical A-to-B
  review draft remain outside this commit. No push or main merge is performed.
- Validation already recorded for the implementation: 832 risk/book tests, 56 unique
  integration tests across the documented runs, 51 local/market-ops tests and 28
  focused runner checks. G3 technical checks and ABI freshness pass; historical gate
  acceptance and known broader-suite failures are unchanged. These suites were not
  repeated solely to commit their unchanged sources.
- Canonical leveraged proof: 103 script, 5 keeper and 20 upkeep receipts; two
  100-claim positions at 0.50 with 10 fixture tokens per owner, 100,000 reserve and
  99,960 coverage slack for either outcome. Owned services are stopped. The proof
  resumed its maturity/trade tail after a readiness timing repair; it does not prove
  an uninterrupted run of the final orchestrator.
- Commit preparation adds committed setup instructions and runtime/cache ignores,
  and corrects the runner's Git-state label. All 40 integration-script discovery
  tests pass after that metadata-only correction. The original 119 validation
  fingerprints and their single metadata delta are retained in
  `artifacts/integration/reserve-funded-leverage.json`.
- Next: run the final leveraged scenario uninterrupted from this checkpoint.
  Public activation still needs empirical calibration, reserve funding, continuous
  real-source INDEX, authorized operator roles and network-specific gas evidence.
  Owner-correct transaction client/frontend and selected sponsor work remain the
  subsequent product scope; unrelated earlier 1x evidence can be reused.
### 2026-10-06 — CI-01: push failures on feat/pricefeed

- User requested investigation and repair of failing GitHub CI. Baseline
  `b2c9100931e63aa285a2e5eb5c4d1465e235b758`; fetched origin and verified the current
  feature branch matches its remote. Earlier CRE/service edits remain separate.
- Latest runs `37366215962` (oracle) and `37366215860` (contracts) could not acquire
  hosted runners for most jobs. No test step ran in those jobs. The oracle Forge
  and real-integration jobs both passed. GitHub confirmed the runner-assignment
  incident at https://www.githubstatus.com/incidents/3q1yb5m7ltvb. Retried only the
  jobs that had failed to start; hosting availability is outside this patch.
- Earlier contracts run `37246660727` failed `forge fmt --check`. Reproduced on
  the current tree with CI-pinned Foundry 1.8.3: `BookRiskEngine.sol`, `MarginLens.sol`
  and its test needed formatting. Applied the pinned formatter; no economic rule
  or assertion was changed.
- Set `FORGE_SNAPSHOT_EMIT=false` for the contracts job so its test step cannot
  overwrite the committed gas baseline before the later comparison. An isolated
  verification accepted the committed snapshot, rejected a one-unit mismatch,
  and left both files byte-for-byte unchanged. No gas baseline was refreshed.
- Local validation: contracts and oracle formatting checks exit 0; contracts
  `FOUNDRY_PROFILE=ci forge build --sizes` exits 0; snapshot check exits 0 (12 tests);
  deliberate snapshot mismatch exits 1 as expected. Full CI contract tests exit 0:
  834 passed, 0 failed, 0 skipped across 131 suites, including 10,000-run fuzz
  campaigns and 256-run invariants. Restored the test-generated newline-only
  snapshot change; the committed baseline remains byte-for-byte unchanged.
- This is CI maintenance on the user's active feature branch. No main merge,
  deployment, contract permission change or gate-acceptance update is included.

### 2026-10-06 — FE-AUDIT: frontend audit and repair

- User requested a frontend audit, extending the historical deferred frontend
  scope for this turn. Baseline `8c73266e39d188e1cd052edaad7189b5f3fe481e` on
  `feat/pricefeed`; initial working tree clean and fetched origin matched HEAD.
- Fixed depth-bar scaling, wide-spread sampling and cached depth after all orders
  disappear. Three reproductions failed with the prior geometry/sample logic and
  pass with the repairs. Added query-observer coverage for populated-to-empty books.
- Preserve network failures during market resolution and action simulation;
  provide retry UI instead of false 404/no-action states. Balance/list screens
  distinguish missing reads from unfunded accounts. Cancel-all no longer depends
  on successful order discovery; signing and simulation guards remain unchanged.
- Correct animated-heading/number accessibility and terminal tab relationships,
  keyboard focus and selection. Preserve the compact terminal and existing themes.
- Added frontend-only CI checks: locked dependency install, high/critical audit
  gate, unit/server tests, production build and typecheck. A scoped ws 8.x override
  fixes the high advisory; 23 moderate package entries in inherited wallet
  dependencies remain documented for a tested upstream upgrade.
- Validation exit 0: clean temporary checkout install/tests/build/typecheck;
  final working-tree `npm ci`, 31 unit tests, 10 integration tests, webpack build,
  typecheck and high/critical dependency audit. Build retains upstream dependency
  warnings. `git diff --check` exits 0. No contract source/economic changes.
- Chrome: 50 route/theme/width checks pass, no overflow/runtime exceptions/failed
  responses on normal paths; all nine terminal panels, keyboard navigation,
  All markets return link, system themes, reduced motion and interactive demo
  pass. Axe reports zero WCAG A/AA violations on tested public pages in both
  themes. Blocked RPC/history requests show errors and recover through retry.
- Rebuilt and restarted the production preview on port 3100 after stopping its
  prior process, preserving other local services. Privy dialogs checked in dark
  desktop and light mobile; no real login, signature, public-chain write or new
  deployment. Live activation, funded-wallet demo and optional signer/worker/
  calibration configuration remain external dependencies.
- Full findings and remaining work: `frontend/AUDIT.md`; integration progress
  updated. This is technical validation, not independent security review or new
  gate acceptance. Commit/push scoped to the active feature branch; main untouched.


### 2026-10-06 — CI-02: verify repeated GitHub failures

- User reported CI still failing. Baseline `0112a099dd467952481c2e8b361c0de9c84b5c71`
  on `feat/pricefeed`; fetched origin and verified a clean, synchronized tree.
- Inspected current runs and individual check annotations, rather than assuming
  the earlier formatting defect persisted. Latest oracle run `37370979597` at
  `8c73266` passed Forge (format/build/full suite), real integration and the CRE
  resolution workflow (install/test/typecheck/build/outcome-path check).
- Its four remaining jobs (packages, indexer, validation, dryrun) never started:
  every check records `The job was not acquired by Runner of type hosted even
  after multiple attempts`. Failed-log download exits 0 with no test log because
  no runner executed these jobs. Preceding oracle run `37370813833` has the same
  runner-assignment error on its unstarted jobs; its five executed jobs passed.
- GitHub's official status API still reports Actions degraded and incident
  `3q1yb5m7ltvb` investigating hosted-runner assignment delays, as checked at
  2026-10-05 21:02 UTC (2026-10-06 02:32 IST):
  https://www.githubstatus.com/api/v2/summary.json.
- `gh run rerun 37370979597 --failed` exits 0; attempt 2 retries only the four
  jobs that lacked runners and preserves the three successful jobs. The retry
  is queued at this checkpoint. No obsolete run was retried.
- Contracts run `37370813810` passed formatting and build; its full test step is
  still running. Frontend run `37372711259` is queued awaiting its first runner.
  These are pending, not successful remote validations. The earlier local
  CI-01/FE-AUDIT test results remain the local evidence; no redundant local test
  run or application/workflow change was made for a hosting failure.
- Commands to inspect runs/check annotations, download logs and request retry
  exit 0. Documentation-only checkpoint; no checks weakened, gas baselines
  refreshed, deployments performed or new gate acceptance recorded.
- Remaining dependency: GitHub must assign runners and finish the pending jobs.
  Historical red runs remain historical failures; retry progress is available
  at https://github.com/akronim26/eros-markets/actions/runs/37370979597.


### 2026-10-06 — CI-03: simplify checks and repair Node 22 installation

- User authorized completing CI repairs and removing unnecessary checks, and
  explicitly reserved pushing for themselves. Baseline `2b135b2` on
  `feat/pricefeed`, initially clean. All changes in this turn remain uncommitted
  and unpushed; this overrides the historical end-of-turn commit/push instruction.
- Reproduced a real frontend failure in a clean temporary checkout using CI's
  Node 22: `npm ci` rejects `ws@8.22.0` against the partial-range 8.21.3 override.
  Local Node 25/npm 11 previously accepted this lockfile. Pin all ws 8.x consumers
  to the patched 8.21.3, preserve ws 7.x consumers, and regenerate the affected
  lock entries with Node 22.23.3/npm 10.9.9. Preserve existing platform metadata;
  no unrelated package versions or application source are changed.
- Removed formatting-only push gates and the separate frontend npm audit gate.
  Dependency audit remains available locally; the vulnerability repair remains.
  Removed the duplicate frontend typecheck because the Next.js production build
  already checks application/generated-route TypeScript. Test files still execute
  in CI; preserve the standalone local script for their static checking as well.
- Folded gas comparison into the full contracts test step with snapshot emission
  disabled. Removed only the redundant second run of BookGasTest; snapshot values
  and full fuzz/invariant settings are unchanged.
- Consolidated oracle real integration with its Forge job, and the two CRE builds
  with the packages job: seven runner allocations become four. Retain separate
  frozen installs for the CRE lockfiles, all tests/typechecks/builds, and one
  outcome-default scan covering both workflows and packages. The scan also rejects
  missing source paths and grep errors. No failing test is skipped or suppressed.
- Added workflow/ref concurrency cancellation to all three workflows so a newer
  relevant push cancels an obsolete run of the same workflow on that ref.
- Verification so far: actionlint 1.7.12 and `git diff --check` exit 0; clean Node
  22 install and all 41 frontend tests exit 0; final lockfile dry-run validation
  with the committed `.npmrc` exits 0 on Node 22/npm 10 and local Node 25/npm 11.
  Oracle packages/services: 534 tests pass; both integration-service typechecks
  pass; CRE resolution/dryrun: 12/9 tests, typechecks and WASM builds pass.
  Outcome guard positive/negative cases pass, including each protected path and
  missing-directory rejection. Frontend production build, including application
  and generated-route typechecking, exits 0 on Node 22. The combined oracle Forge
  job sequence exits 0: build, 342 CI-profile tests across 39 suites, then 37
  Monad integration tests across four suites; zero failures/skips in both. The
  full contracts CI-profile run with gas checking exits 0: 834 tests across 131
  suites, zero failures/skips, 800.73 seconds. The committed gas baseline is
  unchanged. Full 10,000-run fuzz and 256-by-128 invariant settings are retained.
- Existing frontend run `37372711259` ultimately failed before executing any step;
  its check annotation reports the hosted runner was never acquired. Oracle retry
  `37370979597` was still awaiting remaining runners at the last inspection.
  Contracts run `37370813810` subsequently completed successfully on GitHub; it
  validates the earlier committed workflow, not these unpushed simplifications.
  Local changes cannot repair GitHub's runner allocation or update a remote check
  before the user pushes them. No remote retry of the known stale lockfile was made.
- Local logs: `/tmp/eros-ci03-*`; clean checkout path is in
  `/tmp/eros-ci03-path`. The running frontend preview and operator services are
  untouched. This is technical CI validation, not a deployment or gate acceptance.


### 2026-10-06 — FE-404: branded missing-page view

- User requested a custom website 404, with design discretion. Baseline `5c8f785`
  on `feat/pricefeed`, initially clean. Changes remain local, uncommitted/unpushed.
- Added the root Next.js not-found page and scoped CSS: pixel 404, orange chart
  illustration, concise copy and links to markets/home. Uses existing theme
  tokens and shared navigation; supports missing routes and invalid market URLs.
- Production build (including TypeScript) exits 0; retains the existing upstream
  viem/ox dynamic-import warning. Production unknown URL returns HTTP 404 with
  a custom title and noindex metadata.
- Chrome verification passes in development and production: light/dark at
  320/768/1024/1440 px without horizontal overflow, both navigation links,
  keyboard navigation, reduced motion and invalid-market fallback. Axe WCAG A/AA
  checks show zero violations in both themes; no runtime exceptions recorded.
- Rebuilt and restarted the production preview at localhost:3100. Other services
  unchanged. Removed only the temporary Next dev-generated agent instruction
  files; no dependencies or global styles changed. Evidence: `/tmp/eros-404-*`.

### 2026-10-06 — FE-TERMINAL: interactive landing-page console

- User requested more interaction in TERMINAL.SYS, with design discretion.
  Baseline `5c8f785` on `feat/pricefeed`; preserved the uncommitted FE-404 work.
  All changes remain local, uncommitted and unpushed.
- Replaced the static typed terminal with a read-only command console: status,
  book, risk, help and clear; clickable shortcuts, Enter submission, Tab
  completion, arrow-key history/draft restoration, Escape and an open-market link.
  Commands use the existing market query, with no additional RPC polling,
  transactions, dependencies or arbitrary code execution. Output/history are bounded.
- Results identify the snapshot block, distinguish missing data from zero, and
  label cached data after connection failures. Risk output reports the deployment
  ceiling without promising available leverage. Removed the continuous typing
  timer; added brief entry/hover effects with reduced-motion support.
- Final production build, including TypeScript, exits 0; the existing upstream
  viem/ox dynamic-import warning remains. Production Chrome checks pass for all
  commands, unknown input, history/draft restoration, Tab/Shift+Tab, Escape, clear,
  bounded output and navigation. Light/dark at 320/768/1024/1440 px have no
  horizontal overflow; console axe WCAG A/AA checks report zero violations and
  no runtime exceptions were recorded. Reduced-motion checks pass.
- Development RPC fault tests pass for cached-data warnings, fresh unavailable
  state without invented values, and automatic recovery after restoring access.
  Production preview rebuilt and running at localhost:3100. Evidence:
  `/tmp/eros-terminal-sys-*`; no operator services or global styles changed.

### 2026-10-06 — FE-PANELS: simplify testnet section

- Removed MARKET.METRICS and LIFECYCLE.STATUS from the landing page at the user's
  request, along with their unused deadline calculations and imports. The grid
  now contains TERMINAL.SYS and MARK.DITHER only, side by side on desktop and
  stacked on mobile. Preserved prior local changes; nothing committed or pushed.
- Production build with TypeScript exits 0. Chrome checks confirm both removed
  panels are absent, both remaining panels render, 320/1440 px layouts have no
  horizontal overflow, and no runtime exceptions occur. Production preview
  restarted at localhost:3100. Evidence: `/tmp/eros-panel-removal-*`.

### 2026-10-06 — FE-STATES: feedback, confirmation and policy pages

- User requested loading states, form errors, a thank-you page, privacy policy,
  terms and a cookie banner. Baseline `a0823dc` on `feat/pricefeed`, initially
  clean. Changes are local and uncommitted/unpushed. Leverage/deployment work
  remains paused; this item changes frontend presentation and validation feedback.
- Added shared skeleton/pending/retry components and a root route error boundary.
  Loading feedback covers markets, terminal, portfolio, oracle, reserve, order
  history, open orders, wallet permissions and protection configuration. Pending
  configuration reads no longer prematurely claim a service is unconfigured.
- Added blur-triggered field errors with accessible associations and invalid
  styling for price, size, expiry, collateral, reserve, protection and evidence
  fields. Errors clear on correction; protection submission reveals errors and
  focuses the first invalid field. Existing contract preview/signing guards remain.
- Unified transaction progress/error/result feedback. Successful, non-rejected
  results link to `/thank-you?tx=...`; no automatic trading-flow redirect. The
  page checks Monad receipts, distinguishes missing/invalid/reverted results,
  and does not equate transaction confirmation with a filled order. Direct
  `/thank-you` visits show a general thank-you with no transaction-success claim.
- Added `/privacy` and `/terms`, a shared footer, and Privy modal policy links.
  Policy copy reflects the current testnet, manual fixture, local storage,
  third-party providers and optional automation database. No legal compliance
  certification is claimed. Public operator identity/contact email were requested
  but not supplied; copy currently directs requests to the project access channel.
- Added a dismissible cookies/storage notice, 180-day acknowledgement, footer
  reopen, keyboard focus restoration, cross-tab acknowledgement sync and blocked
  storage fallback. No optional trackers are configured or added, so this is an
  informational notice rather than an ineffective accept/reject tracking switch.
- Verification: production build including TypeScript exits 0 (existing upstream
  viem/ox warning); 31 unit and 10 integration tests pass. Browser checks pass for
  all three pages in light/dark at 320/768/1024/1440 px, no horizontal overflow,
  zero axe WCAG A/AA violations, cookie persistence/reopen/focus, input errors and
  correction, actual Privy modal policy links, and no runtime exceptions.
- Recovery checks pass: an existing real testnet receipt confirms; missing or
  malformed hashes never confirm; a mocked reverted receipt shows failure;
  blocked RPC shows loading then error and recovers after retry; reduced motion
  disables loading animation; blocked local storage still permits dismissal.
  No transactions were submitted. Evidence: `/tmp/eros-states-*`. Production
  preview is rebuilt and running at localhost:3100.

### 2026-10-06 — MERGE-RISK: refresh frontend branch from integration/risk

- User explicitly requested merging the new integration/risk pushes into the
  current branch. Fetched `origin/integration/risk` at `5fc751d` and merged its
  eight missing commits into `feat/pricefeed`, starting at `3671ec0` with a clean
  working tree. The merge is conflict-free; both branches' status entries survive.
- Frontend, risk-sdk and automation source trees match the pre-merge frontend
  branch exactly. Backend source matches the incoming integration branch; only
  the retained frontend work and combined status log differ from that branch.
  No deployment addresses, environment files or running services are changed.
- Post-merge verification: `git diff --cached --check`, 31 frontend unit tests,
  10 frontend integration tests and TypeScript all exit 0. The backend lifecycle
  evidence is imported from integration/risk, not claimed as rerun here. Logs:
  `/tmp/eros-merge-risk-{unit,integration,types}.log`.
- A local merge commit completes the requested branch merge. No push or public
  transaction is performed. Deployment/frontend integration policies remain in
  `docs/integration/FRONTEND_TEAM_HANDOFF.md` and `DEPLOYMENT_RUNBOOK.md`.

### 2026-10-06 — CI-04: build deployment artifacts before package tests

- Investigated the failed oracle packages job on merged head `8f76670` (run
  `37391302446`). The same failure appears in incoming run `37390379727`:
  integrated-preflight tests load `RegistryBookRiskEngine.json`, but the packages
  job never compiles it. The separate forge job cannot share its filesystem.
- Added an integration-profile `forge build --skip test --skip script` before
  package tests. Retained all test assertions and existing CI checks.
- Reproduced the missing-artifact failure in a clean archive of `8f76670`, with
  no environment files, dependencies or build outputs copied in. With pinned
  Foundry 1.8.3 and Bun 1.3.13, the new build exits 0 and all 668 workspace tests
  pass. Keeper and market-ops typechecks exit 0. Both independent CRE projects
  install from frozen lockfiles, pass 21 tests combined, typecheck and compile
  to WASM with exit 0. The outcome-path guard and actionlint also exit 0.
- Evidence: `/tmp/eros-ci04-{repro,artifacts,packages,service-types}.log` and the
  clean archive identified by `/tmp/eros-ci04-clean-path`. Validation was local
  on macOS; the updated workflow has not yet run on GitHub. At the last check,
  GitHub validation/indexer jobs passed and both long-running Forge jobs were
  still in progress. No full-suite green result is claimed.
- Changes remain local and uncommitted; nothing pushed or deployed. Reviewed
  the deployment handoff: deterministic backend leverage/settlement evidence
  exists, but frontend manifest/caps/SDK wiring, actual public signer roles and
  funding, integrated deployment, persistent operators, and public wallet-flow
  validation remain. Authentic-source leveraged endurance is still incomplete.


### 2026-10-06 — fresh public deployment and frontend integration

- User authorized a fresh Monad testnet deployment with the root `.env` key,
  selected a real Polymarket event, and deferred hosting until after wiring.
  No Git push or commit was made.
- Deployed and verified the integrated factory/shared vault, oracle/UMA testnet
  stack and first engine through 39 finalized deployment/activation transactions.
  Deployment gas cost: 10.10233296 MON. Published credential-free manifests,
  canonical receipts, external-source identity and exact synthetic calibration.
- Frontend selects the fresh manifest, validates chain/code/bindings, reads live
  directional caps, offers integer leverage sizing, uses SDK owner builders,
  waits for exact canonical finalized receipts, and isolates unmatched history.
  Test collateral faucet and accurate testnet disclosures are connected.
- Two independently funded owners passed faucet/approve/deposit/allocate on the
  public contracts. One bounded public epoch rollover finalized. A five-minute
  source run recorded nine finalized observations; journal recovery finalized
  its existing tenth transaction with no unresolved signed transaction left.
  Contiguous pricing and real-source leveraged fills remain unproven; stale
  pricing correctly blocked a rehearsal order and release. No cutoff was relaxed.
- Fresh CRE CLI FeedSpec simulation succeeded with NOT_FINAL for the ongoing
  Polymarket event. No new-market terminal resolution or CRE network deployment
  is claimed. Fresh listener and Envio configuration is prepared, hosting absent.
- Validation: clean Node 22 npm ci, frontend production build, 35 frontend unit
  + 12 integration tests, 248 affected oracle/SDK/CRE/market-ops tests, 38 indexer
  tests/codegen/typecheck, five deployment-runner tests and focused typecheck.
  Browser checks: 320/768/1024/1440px light/dark, no overflow/runtime errors/failed
  resources, no axe violations on the loaded dark terminal; Privy modal opens.
  Real authenticated Privy contract signing is not yet validated.
- Full progress, artifacts and remaining operational gates:
  `docs/integration/DEPLOYMENT_PROGRESS.md` and `FRESH_TESTNET_SERVICES.md`.
