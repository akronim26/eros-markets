# Price-feed progress and decision log

This is the commit-by-commit record for the separate CP-PRICE workstream. Read it
before continuing work. Update the pending entry **before each user commit** with
what actually changed, why, verification, failures and remaining decisions. After
the user commits, record the real hash, message and timestamp from Git, then start
a new pending entry. Never invent a commit, approval, passing check or resolved
decision. The user makes commits; reminders are every five minutes during active
work. Entries for the first three commits were reconstructed on 2 October 2026
from Git and retained evidence; unavailable historical results are stated below.

## Scope and fixed contract

- Implementation, tests and new documentation belong in `packages/pricefeed/`.
  Read counterpart interfaces without editing risk engine, CLOB or oracle code.
  User authorization takes precedence over the risk-team branch/commit workflow
  for this isolated package; no shared STATUS or gate acceptance is written.
- Plan: `docs/requests/polymarket-event-price-feed-implementation-plan.pdf`, v1.0,
  2 October 2026. Existing risk spec v1.1 and DEC-01 through DEC-14 remain fixed.
- One service supports configurable crypto, sports and politics workers. A
  category label does not select risk parameters or establish event equivalence.
- Intended output is `submitObservation(Observation obs, bytes signature)` with
  exactly eleven fields: `marketId`, `sourceId`, `sequence`, `observedAt`,
  `publishedAt`, `priceWad`, `impactBidWad`, `impactAskWad`, `bidDepthLots`,
  `askDepthLots`, `sourceRulesHash`. IDs identify the Eros market/source; times are
  Unix seconds, prices WAD, and one lot is 0.001 claim. The digest uses raw
  `keccak256(abi.encode(TYPEHASH, fields, chainId, engine))`, without a personal
  message or typed-data prefix. `acceptedAt`, depth validity and payload digest
  are engine outputs, not observation fields. Risk computes TWAP and mark.
- Current collectors emit diagnostics with `engineObservation: null`. Test-only
  signing fixtures do not authorize operational signing, transactions or release.

## Current implementation and blockers

Read-only configuration, exact arithmetic, bounded complete-book reads, metadata
validation, isolated workers, diagnostic archive, restart/quarantine handling and
inspection/health CLI are implemented and locally tested. Operational admission
fails closed, including when arbitrary approval strings are supplied.

| Decision | Actual status / consequence |
|---|---|
| Q01 scope | User authorized this package and manual commits; named counterpart reviewers remain unassigned |
| Q02 impact/depth/fees | OPEN; VWAP and marginal branches are explicit diagnostic choices, not production approval |
| Q03 timestamps | OPEN; preserve vendor milliseconds and diagnostic floor; publish-time policy unapproved |
| Q04 rules hash | OPEN; SHA-256 evidence digests are not the approved Eros rules hash |
| Q05 quote/quantity | OPEN; diagnostic claim-to-lot conversion does not approve collateral or fee equivalence |
| Q06 event mapping | OPEN; example tokens are real, but outcome/deadline/exception equivalence is not approved |
| Q07 operating budget | OPEN; cadence/headroom/metadata settings are illustrative |
| Q08 invalid packets | OPEN; unavailability remains explicit and no operational invalid packet is fabricated |
| Q09 environment | OPEN; chain/engine/signer/relay/finality and transaction authority absent |
| Q10 release | OPEN; calibration, long soak, retention and independent acceptance absent |

Production sequence/outbox, approved observation builder, signer backend,
transaction relay, receipts/reorg handling and full lifecycle recorder remain
unimplemented. Local tests and short captures do not complete these tasks or
accept any PF gate. I-3 still needs counterpart confirmation.

| Plan items | Work present / remaining acceptance |
|---|---|
| PF001-PF003 | Scope recorded and exact wire checked; owner/reviewer agreement and economic/source decisions incomplete |
| PF004-PF008 | Pinned toolchain, evidence runner, disabled configs and exact diagnostic math; approved PF-G0, mappings and impact policy absent |
| PF009-PF012 | Direct event/market lookup, complete-book reads, rules/status/time diagnostics and polling; discovery pagination, WebSocket hints and approved timing budget incomplete |
| PF013-PF016 | Diagnostic archive, writer fencing and worker restore; production sequence/outbox, approved builder/signer and crash-boundary campaign incomplete |
| PF017 | Read-only validate/inspect/capture/health/evidence/digest commands; approved build-observation command incomplete |
| PF018-PF019 | Relay and receipt/reorg reconciliation unimplemented |
| PF020 | Four local real-ingress/store tests; broader differential guards/timing vectors, prerequisites and live counterpart join incomplete |
| PF021-PF022 | Limited source diagnostics retained; approved soak and calibration incomplete |
| PF023-PF028 | Complete lifecycle, load/security/operations/release and authorized live join/review incomplete; no acceptance claimed |

## Commit 563893f — configurable read-only collector

Full hash: `563893fb584f9f2c4c439d489ebd5bb5b14b7523`  
Committed: 2026-10-02 21:02:49 +05:30  
Message: `feat(pricefeed): add configurable read-only Polymarket collector`

**What happened.** Added the isolated package/toolchain, disabled category
examples, bigint decimal/lot arithmetic, independent Fraction vectors, both
impact methods, metadata/book inspection, source-time checks, wire encoding and
SQLite diagnostic journal. The commit also included earlier source-capture
artifacts, the PDF/request document and the pre-existing `contracts/foundry.lock`.
The lockfile was preserved input, not a price-feed change to risk behavior.

**Decisions.** Use Node 24.21.0, TypeScript 5.9.3 and viem 2.57.2 with a local
lockfile. Preserve source times and raw evidence; never derive financial values
with floating point. Do not infer approved impact/time/units/hash policy from
diagnostic settings. All example markets stay disabled and have no destination.

**Evidence and limits.** Initial public smoke check fetched six books across the
three categories, all HTTP 200. The clean 600-second diagnostic probe retained
61 book attempts per category: crypto 42 HTTP 200 / 41 diagnostic eligible;
sports 42 / 42; politics 39 / 25. Total: 123 HTTP 200 of 183 book attempts,
122 fresh at receipt, 108 diagnostic eligible and 60 connection resets.
Metadata requests bring the total to 216. This shows access and failure modes,
not continuous TWAP coverage or production availability. Use only the clean
`artifacts/pricefeed-reverification/timed-run/` dataset for that probe; earlier
overlapped/sandbox runs are not equivalent evidence. No signatures or
transactions were produced by these captures. Historical complete per-commit
test output is unavailable; current-tree checks below must not be attributed to
this older commit.

**Remaining.** Q02-Q10 and reviewer confirmation remained open. Production
delivery, signing and admission were not enabled.

## Commit 16f1903 — wire and scope checks

Full hash: `16f190354ca2ec74fd42849312000871e7e97939`  
Committed: 2026-10-02 21:11:12 +05:30  
Message: `fix(pricefeed): verify wire types and protected component scope`

**What happened.** Fixed TypeScript byte/signature types and added scripts that
compare the eleven-field ABI, type string and raw encoding order against existing
risk sources. Added protected-file hash and working-diff scope checks.

**Decisions.** Read source contracts directly rather than treating a copied ABI as
authoritative. Preserve the original protected baseline. Exclude the former root
PDF path from component protection because the user relocated that review input
into `docs/requests/`; do not recreate or rewrite it.

**Evidence and limits.** Wire comparison and protection of 1,156 existing file
hashes passed during development. Historical complete test output for this exact
commit was not retained. These checks confirm interface/scope, not human approval
or actual onchain submission.

**Remaining.** Raw-signature real-ingress testing and worker/CLI preparation were
next. All economic/source approval questions remained open.

## Commit 12f012b — CLI, worker recovery and health

Full hash: `12f012bd3dd7717455a917c5564a113c82b54626`  
Committed: 2026-10-02 21:19:51 +05:30  
Message: `feat(pricefeed): add read-only CLI, worker recovery and health checks`

**What happened.** Added shared-provider independent workers, namespace/key
deduplication, coalesced polling, durable source-order/rules/config quarantine,
read-only CLI commands and health that re-evaluates age at query time. Added a
three-category collection config, explicit public test-key wire fixtures and the
first isolated Foundry ingress/store harness.

**Decisions.** One source outage must leave other workers able to collect. A
changed mapping/config/rules baseline requires review; restarting must not clear
quarantine. Old archive entries must not appear currently fresh. SQLite fencing
protects diagnostic writers; it is not a signed sequence/outbox implementation.
CLI rejects unsupported commands and sending/key flags.

**Evidence and limits.** Read-only CLI checks collected crypto and politics; the
selected sports market returned an empty book side and correctly became
`DEGRADED` with no engine observation. The Foundry harness initially had import
and TWAP return-type errors; fixes and the passing real-ingress results belong
to the pending entry below, not this committed version. Complete historical
per-commit test logs are unavailable.

**Remaining.** Pin and verify the local engine toolchain; enforce adapter deadlines
independently of transport cancellation; verify event membership explicitly.

## Pending commit — uncommitted work after 12f012b

Base commit: `12f012bd3dd7717455a917c5564a113c82b54626`. No new commit hash is
claimed. Suggested message:
`fix(pricefeed): verify event identity, bound requests and record progress (PF009-PF012, PF020)`.

**What changed and why.** Fixed isolated harness imports and actual TWAP return
type. The harness submits TypeScript raw-signed fixtures through real
`PriceIngress.submitObservation` and `ObservationStore`; it does not bypass
ingress with a feed helper. Tested accepted signature/event, wrong domain and
mutated fields, duplicate rejection, a fully covered 300-second window and its
invalidation after a depth-invalid packet. Harness initialization and chain are
test-only; risk, CLOB and oracle implementations remain untouched.

Enforced fetch/body deadlines even when transport ignores AbortSignal, cancelled
oversized bodies, and tested stuck fetch/stalled body/cancellation. Captured Gamma
market-by-ID responses do not contain event membership, so fetch `/events/{id}`
separately, check the exact configured market belongs to that event, and archive
event/market evidence before validation. Reject duplicate outcome tokens. Track
event and market rules/status evidence together; no evidence hash substitutes
for Q04's Eros sourceRulesHash.

Added a pinned local integration runner and a verification evidence runner. A
zero-test result, wrong tool version, missing tool or failed check is failure or
unverified, never a pass. Added this requested per-commit progress record and
updated reminder interval to five minutes. Added a README with the exact risk
output and command meanings, plus a compact source-report exporter that checks
archive hashes before writing summaries.

**Verification.** `npm run verify:all` with Forge 1.8.3 and Solidity 0.8.30:
exit 0, 164 TypeScript tests, 144 independent Fraction vectors (seed 20261002),
4 actual-ingress/store local tests, exact wire check, and all 1,156 protected file
hashes unchanged. Machine evidence: `artifacts/verification/checks.json` and
`engine.json`, including source/fixture hashes and real-versus-test component
status. These are current working-tree results, not PF acceptance.

A further 30-second three-category capture first encountered sandbox network
failures. It was repeated with network permission using a separate archive;
crypto and politics collected, sports remained `DEGRADED/EMPTY_BOOK_SIDE`.
Raw evidence is in ignored `var/source-review-network.sqlite`; no signatures or
transactions were produced. Each category has three samples: crypto 3 COLLECTING,
politics 3 COLLECTING, sports 3 DEGRADED. Compact evidence including capture times,
diagnostic summaries, source ages and raw-body hashes is retained in
`artifacts/source-soak/review-20261002.json`. Short captures do not certify
continuous coverage. The source-report exporter exited 0 after verifying every
archive record hash.

**Decisions and unresolved work.** Enforce source identity and preserve failures;
do not change event/token to force a passing demonstration. Keep approved builder,
operational signer/relay and lifecycle work blocked by Q02-Q10. No named approval,
release, human gate, production address or production parameters were invented.
Continue only isolated preparatory/read-only work until dependent decisions are
actually supplied.
