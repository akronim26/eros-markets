# Pricefeed plan status — 04 October 2026

Source of requirements: `docs/requests/polymarket-event-price-feed-implementation-plan.pdf`,
v1.0, backlog PF001–PF028 (pages 21–27). Updated against commit 0672188 and the
current local recovery/live-campaign additions. This is an implementation/evidence audit, not human gate
acceptance. No PF-G0–PF-G7 acceptance is claimed.

“Built” below describes local code/evidence only. A task with approvals, missing
tests or deployment inputs remains partial even when its core code is present.

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
| PF014 Builder | Raw-book/metadata recomputation, rule/domain binding, frozen times/headroom; joined local builder; selected local fresh invalid-depth checkpoints preserve depths/times with zero price/impacts | Production invalid-policy approval and coalescing/lifecycle semantics; operational admission; unknown time remains unavailable |
| PF015 Signer | Raw digest, recovery, low-s/v/serialization checks; independent durable public local-test signer journal | Approved production key backend, identity policy and risk/security review; test key is not an operational signer |
| PF016 Recovery | Per-engine/source sequences, leases/fences, immutable retry, skipped/exhausted sequence, corrupt archive and lagging restore tests; actual four-journal reopen/resume on owned local chain | Forced OS-kill-at-every-boundary campaign, independent transaction-signing backup reservations/restore checks, production supervisor startup reconciliation |
| PF017 CLI | validate-config, inspect-book, capture, serve, verify-digest, health and verify-evidence; read-only default | build-observation CLI and comprehensive CLI misuse/redaction tests; library builder is not yet exposed as that command |
| PF018 Relay | Joined local pipeline and concrete loopback RPC/test-transaction signer; durable nonces, ordered stream, exact call checks, simulation before nonce reservation, age/spend bounds, unknown sends; two-worker nonce/isolation tests | Production RPC/key adapters, broader measured cross-market campaign, fee replacement/cancellation recovery and approved environment/budgets |
| PF019 Receipts/reorg | Exact raw event/block/digest validation; invalid-depth success distinguished; mined/finalized/orphaned states; local journal/reorg fixtures | Block-labeled authoritative sourceState reconciliation, persistent quarantine of unknown higher state, production finality policy and wider reorg/RPC-disagreement campaign |
| PF020 Real ingress | Four real ingress/store tests; earlier 36-packet live demo; new durable pipeline exercised real local ingress/store, including invalid/gap/recovery fixtures and real crypto source with restart | Full economic/guard composition and expanded negative vectors; see campaign evidence for actual source coverage, not a blanket availability claim |
| PF021 Live soak | Existing category captures and source-time review; new six-minute durable real-data campaigns with actual journal restarts: crypto 236/300, politics at 10 s 294/300, politics at 5 s 300/300 (72 accepted); independent archive/Fraction replay | Approved duration/availability/load targets, longer quiet/active periods and selected-listing soak; one successful diagnostic window is not an availability guarantee |
| PF022 Calibration | Exact arithmetic and capture evidence available | Candidate N/spread comparisons, measured cadence/headroom report and signed risk-owner production calibration |
| PF023 Lifecycle | Engine owns INVALID recorder; config includes requiredFeedUntil; collector detects source closure | Bot record-only lifecycle, early-halt-through-T operation, closure/gap policy and full 24-hour complete/missing cases |
| PF024 Load/chaos | Focused unit tests for source failure, timeouts, slow signing, writer takeover, corruption and reorg decisions | Declared throughput/load targets, integrated slow-RPC/clock/DB/source campaign and measured queue/nonce/headroom limits |
| PF025 Monitoring/runbooks | Read-only per-worker health recalculates freshness; diagnostic states retained | Block-labeled engine health, assigned alerts/metrics dashboard and operational restore/expiry/closure/key-failure runbooks/drills |
| PF026 Security/release | Dependencies pinned, scope guarded, local test keys and production restrictions explicit | Complete reviewed release manifest, real identities, data-terms/security/least-privilege review and all approved inputs |
| PF027 Handoff/live join | Local real-source and real ingress/store evidence clearly separated from mocks | Authorized deployed engine/chain/key and real signed receipts/readiness recovery; full economics needs actual counterparts; no deployment exists in checked handoff |
| PF028 Final review | README, per-commit PROGRESS, decision docs and historical status PDF exist | Independent final review, current task evidence index, clean-environment full replay and accepted handoff/release |

## Current verification and practical boundary

- Latest package suite in this campaign: **210 tests pass**, zero failed/skipped/cancelled/todo.
  This includes **144 Fraction vectors**, seed 20261002; do not add them again.
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

Next implementation work: complete lifecycle behavior under explicit policy,
operator CLI, broader
recovery/load evidence and runbooks. Production mapping, calibration, backend,
environment and independent acceptance must come from the named owners.
