# Pricefeed plan status — 04 October 2026

Source of requirements: `docs/requests/polymarket-event-price-feed-implementation-plan.pdf`,
v1.0, backlog PF001–PF028 (pages 21–27). Updated against commit a373a64 plus
the pending estimate-based gas and cost-capacity milestone. This is an
implementation/evidence audit, not human gate acceptance. No PF-G0–PF-G7 acceptance is claimed.

“Built” below describes the stated local or diagnostic testnet code/evidence only. A task with approvals, missing
tests or deployment inputs remains partial even when its core code is present.

Latest planning estimate on 04 October 2026, after external publication/restart
and gas measurement: about **95% of core bot implementation complete / 5% left**,
and about **75–80% of the full implementation, operations and reviewed handoff
plan complete / 20–25% left**. These are approximate effort estimates from the audit, not equally
weighted task counts, approved gates or a production release score. Remaining
effort is concentrated in sustained external coverage, recovery/load/soak evidence,
calibration, monitoring, backup controls and named acceptance.

The user's current priority is Monad **testnet**, ahead of storage/backup drills.
RPC preflight, durable halt/deadline/source-progress monitoring and explicit
diagnostic signing/publication are implemented. A standalone receiver is deployed,
and three authentic observations finalized, including new-process restart.
The full economic engine remains separate.
See [monad-testnet.md](monad-testnet.md) for the setup and deployment dossier.
The pilot verifies external signing/sending and publication-boundary lifecycle
checks; sustained 300-second coverage and a full economic engine join remain.

| Plan item | Implemented / verified | Exactly what remains |
|---|---|---|
| PF001 Scope/ownership | User-approved package-only scope, separate branch and manual commits documented | Named owner/review roster; original protected-hash checker needs explicit post-user-merge provenance handling |
| PF002 Wire/signing freeze | Exact eleven-field ABI, type string, raw digest, domain/prefix negatives and accepted-event ABI checked | Named I-3 confirmation; approved invalid-summary policy |
| PF003 Decisions | User-selected VWAP/rounding/fees/depth and conservative timestamp handling; candidate rules schema; risk cross-check | Provider clock semantics, canonical hash dossier, quote/precision, exact mapping/exceptions, invalid-transition policy and reviewer agreement |
| PF004 Toolchain/evidence | Pinned Node/TypeScript/viem, lockfile, bigint code, reference and evidence runner | Current complete verify:all replay with pinned Forge/solc; scope-check baseline reconciliation; refresh historical machine reports only after actual rerun |
| PF005 Config/admission | Typed configs, duplicate/domain checks, listing comparisons, disabled operational admission | Approved runtime policy adapters and actual production pins/dossier; placeholder approval strings must not enable output |
| PF006 Category dossiers | Disabled real-token crypto/politics/sports examples and identity checks | Reviewed Eros/Polymarket outcome/deadline/exception equivalence; negative-risk decisions and selected eligible listing |
| PF007 Decimal/lots | Exact bounded decimal parsing, fractional aggregation, floor-total lots; 144 independently derived Fraction vectors | Approved provider quote equivalence and trade precision policy |
| PF008 Impact calculator | Before-fee VWAP, directed rounding, full-depth validation, duplicate/partial/min-size/rounding boundary tests | Named review and calibrated production N/spread; fixture values are not production defaults |
| PF009 Metadata | Direct event/market lookup, membership/outcome mapping, cached metadata and rules/status monitoring | Pagination/discovery, approved API/schema/cache policy and complete null/negative-risk policy |
| PF010 Book adapter | Bounded complete REST reads; exact raw evidence; identity, normalization, sorting/duplicates, schema/error tests | Accepted source-schema review and approved dependent quote/mapping policies; no live incremental book reconstruction implemented |
| PF011 Source time | Vendor ms retained, seconds floored, skew/headroom/repetition checks and timestamp evidence | Provider timestamp-generation interpretation and measured/approved end-to-end budget |
| PF012 Scheduler/stream | Global limiter/backoff, independent polling loops; 25-worker slow-source isolation, 100-worker drain, provider-burst gaps/recovery and continuous joined queue-expiry tests | Stream subscription/heartbeat/reconnect generations; approved cadence, sustained fairness targets and buffering/coalescing policy; collection/publication decoupling not certified |
| PF013 Storage | Raw valid/invalid/gap archive; fenced WAL/FULL packet journal; atomic sequence allocation, checksums and local delivery journal | Approved retention/migrations and broader permission/storage-failure drills; independent transaction-signer backup/restore controls |
| PF014 Builder | Raw-book/metadata recomputation, rule/domain binding, frozen times/headroom; joined local builder; selected local fresh invalid-depth checkpoints preserve depths/times with zero price/impacts; explicit development lifecycle gates | Production invalid/closure/coalescing/lifecycle policy and concrete lifecycle reader; operational admission; unknown time remains unavailable |
| PF015 Signer | Raw digest, recovery, low-s/v/serialization checks; independent durable local/testnet signer journals; separate encrypted private testnet keys and fixed-chain/receiver transaction signing | Approved production key backend, identity policy and risk/security review; test key is not an operational signer |
| PF016 Recovery | Sequence/lease/fence/immutable retry and lagging-restore tests; real-source/local-chain graceful reopen; thirteen OS SIGKILL journal boundaries with scripted counterparts; eight joined LocalPipeline.run/owned-Anvil kill boundaries (all resume with checked durable transaction journal); signer/relay snapshot mismatch, stale restore and lease/expiry checks | interrupted DB transaction/disk/power-failure drills, production transaction-signer backup controls and supervisor startup reconciliation |
| PF017 CLI | validate-config, inspect-book, capture, serve, verify-digest, health, verify-evidence, offline build-observation, preflight-monad, watch-monad-lifecycle, finite budgeted serve-monad-testnet, quote-monad-gas and plan/apply-monad-budget; explicit archive/capture/sequence/replay-time inputs, raw recomputation, fixed-code errors and subprocess misuse/redaction tests | Broader operator review of all collection/storage failure paths; production signing/sending commands remain outside authorized scope |
| PF018 Relay | Joined local pipeline/loopback adapter; durable ordered nonces, exact simulation/age/spend checks and shared-account quarantine; independent public local transaction journal, pinned ID and exact request/raw-byte reconciliation; 25-market two-round scripted RPC delivery with exact nonces 0–49; queue-expired unreserved packets become EXPIRED without service failure; owned-chain crash recovery verifies immutable sends, actual receipt recovery and nonce continuation; Monad testnet HTTPS adapter with finalized-block pins, simulation, durable nonces, persistent spend caps and three actual finalized transactions; exact estimate-based upward-rounded gas sizing and selected-limit simulation; one actual fresh quote without sending; audited idle-journal budget renewal preserving history | Production RPC/key adapters, transaction-signer backup controls, real-chain/cross-market inclusion/load evidence, fee replacement/cancellation and approved budgets |
| PF019 Receipts/reorg | Exact raw event/block/digest validation; invalid-depth success distinguished; mined/finalized/orphaned states; local journal/reorg fixtures; Monad finalized checkpoint/source progress; actual exact accepted logs; signed packet/signer/transaction journal reconciliation and persistent unknown-higher-state quarantine; new-process sequence/nonce continuation | Production finality policy and wider reorg/RPC-disagreement campaign |
| PF020 Real ingress | Four wire/short-window tests plus four signed 24-hour lifecycle tests importing real ingress/store/INVALID/risk context with scripted counterparts; earlier live-source campaigns remain separate | Full real counterpart economic/guard composition and expanded negative vectors; fixtures are not authentic oracle or live availability evidence |
| PF021 Live soak | Existing category captures and source-time review; new six-minute durable real-data campaigns with actual journal restarts: crypto 236/300, politics at 10 s 294/300, politics at 5 s 300/300 (72 accepted); independent archive/Fraction replay | Approved duration/availability/load targets, longer quiet/active periods and selected-listing soak; one successful diagnostic window is not an availability guarantee |
| PF022 Calibration | Exact arithmetic/captures; measured 179,266 gas estimate and 197,193 buffered limit, independent integer cost/capacity scenarios and six-minute budget proposal | Candidate N/spread comparisons, measured cadence/headroom report and signed risk-owner production calibration |
| PF023 Lifecycle | Durable local block-labeled record-only/deadline controller joined to scheduler/pipeline; source-closure gap and delayed signing/simulation/transaction guards; restart/quarantine tests; four signed accelerated full-24-hour complete/gapped/legacy/thin cases against real risk modules; durable read-only Monad finalized-block halt/deadline/source-progress monitor, pinned concrete reader, CLI/SQLite process restart and graceful fenced handoff | Actual standalone receiver preflight/monitoring and publication-boundary integration verified; approved production checkpoint/finality/closure/operating policy; authentic oracle join, selected-listing elapsed soak and named risk/oracle review |
| PF024 Load/chaos | OS-kill journal/restore/expiry drills; seven declared load cases with 3/8/12/20/25/100 workers, RPC timeout/late completion, 31-second queued ageing and fresh recovery, source pressure/drain; timing and headroom measurements retained; joined eight-boundary Anvil crash campaign and signer/relay restore mismatch guards | Approved throughput/fairness/availability targets; sustained owned-chain/cross-market load, larger books, sustained real-source/RPC calibration, disk/permissions/power-pressure campaign and operational queue/priority design |
| PF025 Monitoring/runbooks | Freshness-aware health; diagnostic states; development recovery runbook, reproducible crash/restore runner and readonly Monad watch/health/archive commands | Approved operator procedures, supervisor/backup/storage drills, block-labeled engine health, alerts/metrics ownership and closure/key-failure runbooks |
| PF026 Security/release | Dependencies pinned, scope guarded, local test keys and production restrictions explicit | Complete reviewed release manifest, real identities, data-terms/security/least-privilege review and all approved inputs |
| PF027 Handoff/live join | Local real-source and real ingress/store evidence clearly separated from mocks | Standalone testnet receiver deployed and pins verified; three authentic finalized receipts and new-process restart verified; sustained coverage remains. Full economics still needs an authorized concrete engine and actual counterparts |
| PF028 Final review | README, per-commit PROGRESS, decision docs and historical status PDF exist | Independent final review, current task evidence index, clean-environment full replay and accepted handoff/release |

## Current verification and practical boundary

- Latest package suite: **330 tests pass**, zero failed/skipped/cancelled/todo.
  Five budget-renewal tests and one final-check concurrency test are included. Earlier focused
  gas/publication/service suite: **21 pass**, included in 330.
  Latest evidence: `artifacts/verification/monad-budget-latency-unit.json` and retained TAP.
  The earlier 329-test budget evidence and stopped-run logs remain retained.
  The preceding 324-test gas evidence remains historical.
  The preceding 318-test publication evidence remains historical.
  The first sandboxed full run failed twelve CLI subprocess tests due to EPERM;
  the unrestricted rerun passed. Eight owned-Anvil crash/restart cases also passed.
  Older reports retain their original source hashes and remain historical.
  Wire check and **144 Fraction vectors**, seed 20261002, pass separately.
- Actual testnet publication: three raw-book-derived valid prices finalized with
  sequences 1–3 / nonces 0–2. Two submissions, clean stop, new-process third
  submission; previous packets/signatures/raw transactions remain identical.
  Exact accepted logs, finalized source state and independent Fraction math pass.
  Actual cost **0.2448 test MON** within the 0.36 reservation cap. Public evidence:
  `artifacts/monad-testnet/publication-pilot.json`. Three samples do not establish
  continuous 300-second coverage or approved operating policy.
- Focused load/pipeline/service runner passes **26 tests** and retains seven
  measured cases in `artifacts/verification/load.json` and `load.tap`. The 25-market
  two-round fixture accepted fifty observations with exact shared nonces and
  measured minimum broadcast headroom 25,711 ms in this run. These are small-book
  scripted source/RPC measurements, not production request/inclusion capacity.
- Focused recovery/relay runner passes **26 tests**, covering thirteen SIGKILL
  boundaries and restore/lease/expiry checks with scripted source/chain replies.
  `artifacts/verification/recovery.json` and `recovery.tap` retain the results.
  That historical 26-test run is included in the current 306-test suite; the
  added reserved-nonce restart test also passes. It used scripted counterparts.
- Separately, `npm run test:pipeline-crash` passes eight joined continuous-pipeline
  OS-kill boundaries against owned Anvil: all eight accept exactly two ordered
  observations after checked independent transaction-journal recovery.
  Canonical events, immutable packets/raw sends and actual nonce continuation
  are checked. This fixture-source campaign is outside the 306 unit tests.
  Evidence: `artifacts/verification/pipeline-crash.json` and `pipeline-crash.log`.
- Focused `test:transactions` passes **42 tests**, all included in 306. The
  three-second fixture-source demo reopens five journals, preserves five packets
  and accepts thirteen overall. Independent archive/Fraction replay passes and
  correctly reports only 3/300 seconds coverage. No new real-source soak is claimed.
- Separately, the preceding lifecycle commit recorded **8 passing owned Solidity
  tests**: 4 wire/short-window and 4 signed 24-hour fixtures. They were not rerun
  for these bot-side relay/pipeline changes. Accounting/book/oracle roles are scripted.
- `npm run check:wire` passes against current risk sources, including accepted
  event ABI; `npm run test:reference` passes. Build passes.
- Current source edits stay within `packages/pricefeed/`. The old protected-hash
  checker pins a pre-merge baseline; the user imported risk changes in 08095a8.
  Current HEAD diff isolation is not a claim that the old baseline passes.
- Unit relay tests use injected transports/receipts. Separate local campaigns
  exercise actual loopback RPC and real ingress/store. Neither establishes
  external broadcasts or production finality.
- The existing real-data demo/engine evidence remains valid historical evidence;
  it did not exercise these new durable publication/relay modules.
- The development collector→builder→signer→relay path is joined and running in
  owned-local-chain tests; **no approved production pipeline is enabled**.
  Fresh invalid checkpoints use the selected local policy. Production admission
  remains closed.

- The latest durable real-data campaign passed 300/300-second coverage and
  graceful four-journal restart at five-second diagnostic polling. Two earlier
  ten-second campaigns failed strict coverage and remain retained as evidence.
  `artifacts/pipeline/live-review.json` independently reconstructs all three.
  This adds real-source evidence to PF016/PF020/PF021 without approving cadence,
  a production listing, provider semantics or human gates.

## Next steps, in priority order

The user clarified that completing the **pricefeed component** takes priority.
Full-engine/CLOB release issues are separate owner work; they do not block a
standalone receiver using real signature ingress and observation storage.

1. **Standalone receiver deployment — done.** The user signed the temporary-folder
   diagnostic deployment. Receiver `0xd2d82fed32fb9a911300e7d928607755bd101773`
   and concrete ABI/runtime/listing/source pins are verified on Monad testnet.
2. **Connect testnet publication — done for the diagnostic pilot.** Separate
   encrypted observation/sender keys, five journals, HTTPS submission/simulation,
   ordered nonces, persisted reservation caps, finalized receipts, signed-history
   recovery and publication-boundary lifecycle checks are connected. Two real
   observations finalized, followed by a new process submitting the third.
   Local chain-31337 restrictions and closed production admission remain.
3. **Prove one complete feed — next.** Estimate-based gas sizing is built and one
   real fresh quote verified: 197,193 selected gas versus the old 800,000 limit,
   with zero transactions sent. Cost/capacity scenarios and a finite six-minute
   campaign proposal are retained in `artifacts/monad-testnet/cost-capacity.json`.
   Explicit idle-journal budget renewal is built and tested, retaining all signed
   history and historical reservations. A smaller eight-update / 0.35 MON additional
   reservation plan was approved/applied. Its attempted run stopped before broadcast
   on source-age protection, spending zero MON; signed nonce 3 now needs explicit
   recovery. Its original pilot budget is exhausted;
   do not delete journals or silently enlarge that pinned policy. Establish actual
   submission cadence and complete 300-second TWAP coverage, with invalid/gap and
   restart behavior. The seven-day receiver deadline/mapping/N/spread are diagnostic.
4. **Expand and calibrate.** Run longer category/quiet/active/load soaks and
   settle measured cadence/headroom, N/spread and source/mapping policies.
5. **Finish operations and reviewed handoff.** Exercise storage/backup and
   supervisor recovery; choose hosting, alerts and release records. The PDF's
   PF027 accepted live join follows PF026, then PF028 independent review. Full
   Eros economic integration additionally needs accepted engine/book/oracle/
   factory wiring, including the engine team's existing RB-I01 disposition.

Next concrete deliverable: implement/test explicit recovery of the signed,
never-broadcast nonce 3 and reduce publication RPC latency. The small 0.35 MON
cap is approved/applied; its first run stopped safely before sending and balance
remains 0.3552 MON. Existing funds cover the test; browser funds can stay put.
Then resume within the approved remaining envelope and measure paid gas before
sizing/funding/authorizing the sustained 300-second coverage campaign. Quote-only sequence 4 is expired; sender nonce 3
and receiver sequence 3 are unchanged. Frozen pilot evidence remains separate
from the continued active journals. Gas savings are simulated, not paid receipts. The completed three-transaction pilot proves external publication
and clean restart, with no production listing/calibration or gate acceptance.
