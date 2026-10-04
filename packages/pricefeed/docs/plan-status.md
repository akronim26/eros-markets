# Pricefeed plan status — 04 October 2026

Source of requirements: `docs/requests/polymarket-event-price-feed-implementation-plan.pdf`,
v1.0, backlog PF001–PF028 (pages 21–27). Updated against commit fff4013 and the
current crash-recovery additions. This is an implementation/evidence audit, not human gate
acceptance. No PF-G0–PF-G7 acceptance is claimed.

“Built” below describes local code/evidence only. A task with approvals, missing
tests or deployment inputs remains partial even when its core code is present.

Planning estimate requested on 04 October 2026, before the crash-recovery slice:
about **80% of core local bot implementation complete / 20% left**, and about
**65% of the full implementation, operations and reviewed handoff plan complete /
35% left**. These are approximate effort estimates from the audit, not equally
weighted task counts, approved gates or a production release score. Remaining
effort is concentrated in operational adapters, recovery/load/soak evidence,
calibration, monitoring, backup controls and named acceptance.

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
| PF012 Scheduler/stream | Global limiter/backoff, independent polling loops, continuous serve, non-overlap and shutdown/failure tests | Stream subscription/heartbeat/reconnect generations; approved cadence and many-market fairness/load evidence |
| PF013 Storage | Raw valid/invalid/gap archive; fenced WAL/FULL packet journal; atomic sequence allocation, checksums and local delivery journal | Approved retention/migrations and broader permission/storage-failure drills; independent transaction-signer backup/restore controls |
| PF014 Builder | Raw-book/metadata recomputation, rule/domain binding, frozen times/headroom; joined local builder; selected local fresh invalid-depth checkpoints preserve depths/times with zero price/impacts; explicit development lifecycle gates | Production invalid/closure/coalescing/lifecycle policy and concrete lifecycle reader; operational admission; unknown time remains unavailable |
| PF015 Signer | Raw digest, recovery, low-s/v/serialization checks; independent durable public local-test signer journal | Approved production key backend, identity policy and risk/security review; test key is not an operational signer |
| PF016 Recovery | Sequence/lease/fence/immutable retry and lagging-restore tests; real-source/local-chain graceful reopen; thirteen OS SIGKILL journal boundaries with scripted counterparts, stale packet/relay restore and lease/expiry checks | Joined LocalPipeline/owned-Anvil kill campaign, interrupted DB transaction/disk/power-failure drills, production transaction-signer backup controls and supervisor startup reconciliation |
| PF017 CLI | validate-config, inspect-book, capture, serve, verify-digest, health, verify-evidence and offline build-observation; explicit archive/capture/sequence/replay-time inputs, raw recomputation, fixed-code errors and subprocess misuse/redaction tests | Broader operator review of all collection/storage failure paths; production signing/sending commands remain outside authorized scope |
| PF018 Relay | Joined local pipeline/loopback adapter; durable ordered nonces, exact call simulation and age/spend bounds; two-worker isolation; restart/slow-resimulation expiry now persists shared-account quarantine without changing reserved bytes | Production RPC/key adapters, independent transaction-signer backup controls, broader cross-market campaign, fee replacement/cancellation recovery and approved budgets |
| PF019 Receipts/reorg | Exact raw event/block/digest validation; invalid-depth success distinguished; mined/finalized/orphaned states; local journal/reorg fixtures | Block-labeled authoritative sourceState reconciliation, persistent quarantine of unknown higher state, production finality policy and wider reorg/RPC-disagreement campaign |
| PF020 Real ingress | Four wire/short-window tests plus four signed 24-hour lifecycle tests importing real ingress/store/INVALID/risk context with scripted counterparts; earlier live-source campaigns remain separate | Full real counterpart economic/guard composition and expanded negative vectors; fixtures are not authentic oracle or live availability evidence |
| PF021 Live soak | Existing category captures and source-time review; new six-minute durable real-data campaigns with actual journal restarts: crypto 236/300, politics at 10 s 294/300, politics at 5 s 300/300 (72 accepted); independent archive/Fraction replay | Approved duration/availability/load targets, longer quiet/active periods and selected-listing soak; one successful diagnostic window is not an availability guarantee |
| PF022 Calibration | Exact arithmetic and capture evidence available | Candidate N/spread comparisons, measured cadence/headroom report and signed risk-owner production calibration |
| PF023 Lifecycle | Durable local block-labeled record-only/deadline controller joined to scheduler/pipeline; source-closure gap and delayed signing/simulation/transaction guards; restart/quarantine tests; four signed accelerated full-24-hour complete/gapped/legacy/thin cases against real risk modules | Approved concrete engine lifecycle RPC reader and production checkpoint/finality/closure/operating policy; authentic oracle join, selected-listing elapsed soak and named risk/oracle review |
| PF024 Load/chaos | Unit source/timeout/signing/writer/corruption/reorg tests; OS-kill journal drill plus restore/expiry/shared-account regressions | Declared throughput/load targets, joined slow-RPC/clock/disk/source campaign and measured queue/nonce/headroom limits |
| PF025 Monitoring/runbooks | Freshness-aware health; diagnostic states; development recovery runbook and reproducible crash/restore runner | Approved operator procedures, supervisor/backup/storage drills, block-labeled engine health, alerts/metrics ownership and closure/key-failure runbooks |
| PF026 Security/release | Dependencies pinned, scope guarded, local test keys and production restrictions explicit | Complete reviewed release manifest, real identities, data-terms/security/least-privilege review and all approved inputs |
| PF027 Handoff/live join | Local real-source and real ingress/store evidence clearly separated from mocks | Authorized deployed engine/chain/key and real signed receipts/readiness recovery; full economics needs actual counterparts; no deployment exists in checked handoff |
| PF028 Final review | README, per-commit PROGRESS, decision docs and historical status PDF exist | Independent final review, current task evidence index, clean-environment full replay and accepted handoff/release |

## Current verification and practical boundary

- Latest package suite: **251 tests pass**, zero failed/skipped/cancelled/todo,
  including the nine offline CLI cases, seventeen OS-crash/restore tests and
  shared-account expiry regressions. Evidence: `artifacts/verification/recovery-unit.json`.
  This includes **144 Fraction vectors**, seed 20261002; do not add them again.
- Focused recovery/relay runner passes **26 tests**, covering thirteen SIGKILL
  boundaries and restore/lease/expiry checks with scripted source/chain replies.
  `artifacts/verification/recovery.json` and `recovery.tap` retain the results.
  These focused tests are included in 251, not additional tests or a live-chain
  crash certification.
- Separately, the preceding lifecycle commit recorded **8 passing owned Solidity
  tests**: 4 wire/short-window and 4 signed 24-hour fixtures. They were not rerun
  for this CLI-only change. Accounting/book/oracle roles are scripted.
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

Next implementation work: many-worker load/slow-RPC evidence and the joined
owned-chain crash/backup campaign. Production mapping, calibration, backend,
environment, concrete lifecycle reader/policy and independent acceptance must come from the named owners.
