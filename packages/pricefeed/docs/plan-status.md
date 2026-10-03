# Pricefeed plan status — 03 October 2026

Source of requirements: `docs/requests/polymarket-event-price-feed-implementation-plan.pdf`,
v1.0, backlog PF001–PF028 (pages 21–27). Includes current working-tree additions
after commit 86b5431. This is an implementation/evidence audit, not human gate
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
| PF014 Builder | Raw-book and metadata recomputation, rule/domain binding, exact valid tuple, frozen publish time and headroom checks | Approved fresh invalid-packet fields/priority and coalescing semantics; integrated operational builder; unknown time remains unavailable |
| PF015 Signer | Raw digest, recovery, low-s/v/serialization checks; independent durable public local-test signer journal | Approved production key backend, identity policy and risk/security review; test key is not an operational signer |
| PF016 Recovery | Per-engine/source sequences, leases/fences, restart, immutable retry, skipped/exhausted sequence, corrupt archive and lagging packet-restore tests | Kill-at-every-boundary campaign, independent transaction-signing reservations/restore checks, production supervisor startup reconciliation |
| PF017 CLI | validate-config, inspect-book, capture, serve, verify-digest, health and verify-evidence; read-only default | build-observation CLI and comprehensive CLI misuse/redaction tests; library builder is not yet exposed as that command |
| PF018 Relay | Local-only injected-transport core: nonce journal, ordered stream, exact raw transaction checks, simulation interface, age/spend/retry bounds and unknown-send handling | Concrete RPC/transaction-signer adapter, full pipeline connection, cross-market nonce campaign, fee replacement/cancellation recovery and approved production environment/budgets |
| PF019 Receipts/reorg | Exact raw event/block/digest validation; invalid-depth success distinguished; mined/finalized/orphaned states; local journal/reorg fixtures | Block-labeled authoritative sourceState reconciliation, persistent quarantine of unknown higher state, production finality policy and wider reorg/RPC-disagreement campaign |
| PF020 Real ingress | Earlier four real ingress/store local tests; earlier live-source demo accepted 36 packets with independent 300-second TWAP verification | New durable builder/signer/relay joined to real ingress/store/guards using pinned tools; expanded negative vectors and full engine composition; no feed() bypass |
| PF021 Live soak | Existing genuine category captures, limited soak and failures retained; source-time review of 45 archived captures | Agreed duration/targets, quiet and active periods and approved selected-market soak; real-data fetching has already been demonstrated |
| PF022 Calibration | Exact arithmetic and capture evidence available | Candidate N/spread comparisons, measured cadence/headroom report and signed risk-owner production calibration |
| PF023 Lifecycle | Engine owns INVALID recorder; config includes requiredFeedUntil; collector detects source closure | Bot record-only lifecycle, early-halt-through-T operation, closure/gap policy and full 24-hour complete/missing cases |
| PF024 Load/chaos | Focused unit tests for source failure, timeouts, slow signing, writer takeover, corruption and reorg decisions | Declared throughput/load targets, integrated slow-RPC/clock/DB/source campaign and measured queue/nonce/headroom limits |
| PF025 Monitoring/runbooks | Read-only per-worker health recalculates freshness; diagnostic states retained | Block-labeled engine health, assigned alerts/metrics dashboard and operational restore/expiry/closure/key-failure runbooks/drills |
| PF026 Security/release | Dependencies pinned, scope guarded, local test keys and production restrictions explicit | Complete reviewed release manifest, real identities, data-terms/security/least-privilege review and all approved inputs |
| PF027 Handoff/live join | Local real-source and real ingress/store evidence clearly separated from mocks | Authorized deployed engine/chain/key and real signed receipts/readiness recovery; full economics needs actual counterparts; no deployment exists in checked handoff |
| PF028 Final review | README, per-commit PROGRESS, decision docs and historical status PDF exist | Independent final review, current task evidence index, clean-environment full replay and accepted handoff/release |

## Current verification and practical boundary

- Latest package suite: **193 tests pass**, zero failed/skipped/cancelled/todo.
  This includes **144 Fraction vectors**, seed 20261002; do not add them again.
- `npm run check:wire` passes against current risk sources, including accepted
  event ABI; `npm run test:reference` passes. Build passes.
- Current source edits stay within `packages/pricefeed/`. The old protected-hash
  checker pins a pre-merge baseline; the user imported risk changes in 08095a8.
  Current HEAD diff isolation is not a claim that the old baseline passes.
- New relay tests use an injected local transport and fixture receipts. They
  do not establish real RPC, new engine execution, external broadcasts or finality.
- The existing real-data demo/engine evidence remains valid historical evidence;
  it did not exercise these new durable publication/relay modules.
- The continuous collector, development publication libraries and local relay
  core are separate. There is **no complete operational collector→signer→relay
  service yet**. Production admission remains closed.

Next implementation work: integrate the development path, complete invalid and
lifecycle behavior under explicit policy, concrete local transport/CLI, broader
recovery/load evidence and runbooks. Production mapping, calibration, backend,
environment and independent acceptance must come from the named owners.
