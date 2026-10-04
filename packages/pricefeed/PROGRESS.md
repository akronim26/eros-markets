# Price-feed progress and decision log

This is the commit-by-commit record for the separate CP-PRICE workstream. Read it
before continuing work. Update the pending entry **before each user commit** with
what actually changed, why, verification, failures and remaining decisions. After
the user commits, record the real hash, message and timestamp from Git, then start
a new pending entry. Never invent a commit, approval, passing check or resolved
decision. The user makes commits; reminders are every ten minutes during active
work. From 03 October 2026, suggested messages must start with `feat:`, `test:`
or `fix:` as explicitly requested by the user. Entries for the first three commits
were reconstructed on 2 October 2026
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

The separately authorized local demo now fetches actual Polymarket books, signs
valid summaries with a public test key and submits them to real ingress/store on
an owned local chain. Its 36-packet run produced genuinely covered 300-second
index results matching independent integration. It does not implement full
margin/funding/settlement or enable operational admission.

| Decision | Actual status / consequence |
|---|---|
| Q01 scope | User authorized this package and manual commits; named counterpart reviewers remain unassigned |
| Q02 impact/depth/fees | USER-SELECTED on 03 October 2026: before-fee VWAP, directed price rounding, validated two-sided displayed depth and floor-total lots; named counterpart review and Q04 rules binding pending |
| Q03 timestamps | Conservative handling selected; preserve vendor time, freeze publish time and recheck freshness; provider semantics and Q07 delivery budget remain OPEN |
| Q04 rules hash | Risk consumer contract IMPLEMENTED; canonical listing/pricefeed dossier and encoding OPEN; SHA-256 evidence digests are not the approved Eros rules hash |
| Q05 quote/quantity | PARTIALLY SELECTED: fractional aggregation and floor-total lots with source constraints; quote equivalence/provider precision remain OPEN |
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
| PF020 | Four local real-ingress/store tests plus 36 live-source packets accepted on an owned local chain with independently verified 300-second index; broader guards/timing vectors, prerequisites and production counterpart join incomplete |
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

## Commit 1e72467 — event identity, deadlines and progress record

Full hash: `1e7246730d4da3425d8d3bfe0f736e4e01cbee53`

Committed: 2026-10-02 21:36:30 +05:30

Message: `fix(pricefeed): verify event identity, bound requests and record progress`

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
status. Results describe the tree checked before this commit, not PF acceptance.

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

## Commit cd18c91 — metadata age and health timestamps

Full hash: `cd18c919e77b7be72d720fa8c41b14aa75c5f8ae`

Committed: 2026-10-02 21:40:34 +05:30

Message: `fix(pricefeed): check event metadata age and future health timestamps`

**What changed.** Check metadata freshness against the older of the event and
market captures so a new market response cannot disguise an expired event
association. Health now compares the original source milliseconds against query
time, rejecting future skew hidden by flooring to seconds. Added regression
checks for both cases. Recorded the actual `1e72467` commit above rather than
leaving already committed work in a pending entry. Updated verification evidence.

**Decisions.** Source and metadata age stay conservative. No timestamp is
refreshed, no policy is approved, and no operational output is enabled by these
diagnostic checks. The health work is preparation for PF025, not completion of
its production monitoring/runbook dependencies.

**Verification.** `npm run verify:all` with the pinned local Forge/Solidity paths
exited 0: 165 TypeScript tests, zero skipped/cancelled/todo tests, 144 independent
Fraction vectors (seed 20261002), 4 actual-ingress/store local tests, wire match
and 1,156 protected hashes unchanged. `git diff --check` exited 0. Full evidence
is in `artifacts/verification/checks.json`; no live source run was repeated after
these final two fixes. The preceding source capture remains limited evidence of
the earlier read-only code, not a claim of a continuously operating production
service. Q02-Q10, I-3 confirmation and all human gates remain open.

## Commit c6f8e12 — actual Polymarket data into a local demo market

Full hash: `c6f8e12d1c141638fa59b98d31562caa8c480adb`

Committed: 2026-10-03 12:58:33 +05:30

Message: `feat(pricefeed): add live-data local demo and status report`

Base commit: `cd18c919e77b7be72d720fa8c41b14aa75c5f8ae`. Suggested message:
`feat(pricefeed): add live-data local demo and status report (PF020)`.

**Authorization and decisions.** The user requested a demo event/market using
actual Polymarket data. Keep the real source but create only a fresh, owned local
test chain. Start with the existing Bitcoin October outcome; its config remains
disabled for operational output. Demo policies are explicit diagnostic choices,
not production approvals: config N/spread/impact method, preserved vendor time,
local packet-freeze publication time, unapproved quote convention and a hash of
the demo manifest. Use public Anvil/source test keys only. No external RPC,
engine-address or key argument is accepted. Q02-Q10 remain OPEN.

**What changed.** Added `demo:live`, pinned local compile/start runner, a
constructor-only test composition importing real ingress/store, demo observation
builder and independent TWAP integration. The command polls real complete books,
preserves raw evidence, signs only trustworthy valid summaries, freezes each
packet before local sending, matches the actual accepted event/digest/sequence
and checks genuine 300-second coverage. Invalid/stale/missing/changed sources are
recorded without fabricated packets. No accelerated source time or repeated old
timestamp is used to create coverage. The local chain is stopped after the run.
The demo receiver has no complete margin/funding/settlement, book or oracle.

**Verification so far.** TypeScript build and 170 tests passed, including five
demo builder/TWAP regression tests. Wrong global Forge 1.5.1 was correctly rejected;
the verified temporary Forge/Anvil 1.8.3 and Solidity 0.8.30 are used instead.
Local-chain compilation passed. Sandbox localhost binding failed with EPERM;
the authorized demo was repeated with localhost/network permission. A bounded
360-second real-source/local-ingress run completed with exit 0: **36 of 36**
real-source observations accepted, no unavailable attempts. The last observation
had impact bid 0.76, impact ask 0.77, midpoint 0.765, bid depth 397,038,460 lots,
ask depth 158,155,350 lots, source time 1790960232, publication/acceptance time
1790960233 and sequence 36. Actual engine index reached full 300-second coverage;
the final TWAP was exactly 0.765. Every digest, receipt/event, sequence and TWAP
comparison passed; the archive integrity check passed. No external-chain
transactions were sent, and the owned local chain shut down after the run.

`artifacts/demo/latest.json` retains the exact signed observations, local receipt
events, raw-body hashes, policies and engine/reference index results.
`source-example.json` preserves the first actual complete book. Full raw captures
are in ignored `var/live-demo-1790959881522.sqlite`. The summary generator exited
0 and wrote `artifacts/demo/REPORT.md`. The captured source question was
"Will Bitcoin reach $87,500 in October?", selected outcome Yes. It is an event
claim price, not raw BTC/USD, a bot prediction or a final outcome.

The complete local verification command exited 0: 170 package tests, 144
independent Fraction vectors (seed 20261002), four existing real-ingress/store
tests, exact wire comparison and all 1,156 protected-file hashes unchanged.
`git diff --check` also exited 0. The summary script was added after that test
run and checked separately against the completed archive/report; no repeated
network run or additional production readiness is implied.

**Status report added 03 October 2026.** The user requested a PDF explaining the
intended work, achievements with tests, and remaining implementation. Added the
five-page `output/pdf/pricefeed-implementation-status-report.pdf` and reproducible
`scripts/build-status-report.py` with pinned `scripts/pdf-requirements.txt`.
The report reads the retained demo and verification evidence, checks their
integrity, distinguishes 170 package tests from the included 144 arithmetic
vectors and four separate ingress/store tests, and documents the exact risk
observation contract and local-only readiness boundary. It also records the
earlier category captures and failures without implying continuous availability.
Report libraries were installed in an isolated temporary virtual environment;
project runtime dependencies were not changed. Generation exited 0. All five
rendered pages were visually inspected; text, page bounds, page count and footers
were checked. The PDF SHA-256 is
`55541c5c2b50f8d4ca77594f6b5975b7df7951cff01ffbd826299ba6e4e3328e`.
No package test or live network demo was repeated for this documentation change.
Final documentation checks passed: `git diff --check` exited 0 and
`npm run check:scope` confirmed all 1,156 protected hashes unchanged with the
working diff confined to `packages/pricefeed/`.

**Remaining.** Production builder/signing/relay/recovery, approved mapping and release remain
incomplete; this demo is local integration evidence only, not PF acceptance.

## Imported merge 08095a8 — updated risk integration baseline

Full hash: `08095a802ec503dfd24eea2e0acc253d11db7742`

Committed: 2026-10-03 12:59:12 +05:30

Message: `Merge remote-tracking branch 'origin/integration/risk' into pricefeed`

The user merged risk commit `16f0d90` and its Book/A/B integration changes.
Those counterpart changes were imported by this pre-existing merge, not edited by
the pricefeed agent. The exact `IPriceSource`, `PriceIngress` and `ObservationStore`
sources are unchanged from the earlier checked baseline. The old scope checker
still pins the original pre-merge protected hashes; its earlier pass must not be
claimed as a current post-merge pass. No baseline was silently refreshed.

## Commit 72eef61 — wire confirmation and Q02 decision review

Full hash: `72eef61d149e74c63e4839200518db6309ba21a1`

Committed: 2026-10-03 15:01:19 +05:30

Message: `test: record pricefeed wire and impact verification`

Base commit: `08095a802ec503dfd24eea2e0acc253d11db7742`.
Suggested message: `test: record pricefeed wire and impact verification (PF002-PF003)`.

**What happened.** The user requested sequential resolution of requirements.
Added `docs/wire-contract.md` recording the existing eleven-field/raw-signature
contract and current technical compatibility, and `docs/impact-decision.md`
explaining the next unresolved VWAP/marginal choice using the plan's multi-level
example. Neither record invents human acceptance or production policy approval.
Recorded the actual demo commit and imported merge above.

**Verification.** Current wire comparison exited 0. `npm run test:reference`
exited 0 with 144 Fraction vectors, seed 20261002. The existing compiled math
suite exited 0: 147 tests, zero failed/skipped/cancelled/todo cases. Independent
Fraction arithmetic confirmed VWAP 0.592/0.628 and marginal 0.58/0.64, with
spreads 0.036 and 0.06 respectively. No runtime code changed or new chain/network
demo was run. These checks do not re-certify full economic integration.

**Decisions.** Wire engineering compatibility is confirmed; named acceptance
remains separate. Q02 method/rounding/depth/fees remains OPEN until an explicit
owner decision. Q03-Q10 remain OPEN. Only package documentation changed.

## Commit 52ad9f2 — user-selected VWAP, fee and depth policies

Full hash: `52ad9f2cc0a15f8439242b1bbfed9e420adf2b4f`

Committed: 2026-10-03 15:24:33 +05:30

Message: `feat: select VWAP pricing, fee and depth policies`

Base commit: `72eef61d149e74c63e4839200518db6309ba21a1`.
Suggested message: `feat: select VWAP pricing, fee and depth policies (PF003)`.

**Decision.** On 03 October 2026, the user accepted the recommendation to use
VWAP at N with bid floored, ask ceiled and valid midpoint floored. Recorded the
explicit selection in the impact decision and current decision summaries. This
is a real user decision, not a manufactured named risk/factory review, approved
source-rules hash, PF gate, production parameter or transaction authorization.

**What changed.** Updated package decision documentation and recorded the actual
`72eef61` commit. The existing VWAP arithmetic implements the selected method;
no runtime code change was required. The current diagnostic fee-free book-price
calculation and quantity/minimum-size treatment remain review inputs. Q02 is
partially decided; executable-depth/fees remain OPEN. Q03-Q10 remain OPEN.

**Verification.** Documentation-only change; no arithmetic, wire or live-source
test was repeated. Existing passing arithmetic evidence is recorded above.
`git diff --check` exited 0; the working diff is confined to package documentation.

**Subsequent fee/depth decision.** The user accepted before-fee quoted-price VWAP
and complete validated two-sided displayed depth, preserving fractional quantities
and flooring total depth to lots. Added the selected pricing-v1 definition to
`docs/impact-decision.md` and updated current summaries. This resolves the user's
Q02 method/rounding/fee/depth choices; named counterpart review, canonical rules
binding, provider quantity precision and calibrated N/spread remain separate.
Source minimum size applies to the N-sized order, not a filter discarding every
small residual resting level. No external execution is performed or promised.

**Additional verification.** Added two package arithmetic tests: minimum-size
equality and one-lot boundaries, and fractional residuals that cannot cover the
next whole lot. `npm test` exited 0 with 172 tests and zero failed/skipped/
cancelled/todo cases; `npm run test:reference` exited 0 with 144 independently
derived vectors, seed 20261002; `npm run check:wire` exited 0. Vectors are included
in the 172 package tests. No runtime calculator changes, live-source rerun or new
engine-test run were made. All edits remain inside `packages/pricefeed/`.
Final checks exited 0: `git diff --check` and
`git diff --exit-code HEAD -- . ':!packages/pricefeed'`. The latter checks this
turn's counterpart files against current HEAD; it does not refresh or certify
the original pre-merge protected-hash baseline.


## Commit a728b4f — timestamp review, candidate manifest and durable packet signing

Full hash: `a728b4f8cb0d98f7a0deb6186f5167e78a2eae88`

Committed: 2026-10-03 15:59:27 +05:30

Message: `feat: add pricefeed rules manifest and durable packet signing`

Base commit: `52ad9f2cc0a15f8439242b1bbfed9e420adf2b4f`.
Suggested message: `test: record timestamp policy and evidence (PF011)`.

**Decision.** On 03 October 2026, the user agreed to move to the next requirement
following the conservative timestamp recommendation. Preserve vendor milliseconds
and derive observedAt by flooring to Unix seconds. Finalize publishedAt before
signing and freeze the signed packet across retries. Recheck freshness before
signing and sending, leaving delivery headroom within the engine's 30-second carry
window; the exact operational budget remains Q07. Repeated source timestamps do
not renew freshness. Missing, future, backwards or expired timestamps prevent
valid-price publication. This selects handling, not a claim that Polymarket's
precise timestamp-generation semantics have been confirmed. That external fact
remains open for production; no operational admission or human gate is approved.

**Evidence.** Retained `artifacts/timestamps/review-20261003.json` from the preceding
investigation: 45 existing captures, payload integrity checked, no new source
requests. Repeated timestamps and unchanged displayed fields with advancing
timestamps were observed. Neither proves the provider's timestamp semantics.
The preceding targeted config-time/demo test run passed 9 tests (a subset of the
172 previously passing package tests). No runtime changes or new test run in this
documentation turn. Durable signing/retry enforcement remains future work.

**Next requirement.** Q04: agree the canonical rules/mapping document and exact
hash encoding, and distinguish sourceHash, rulesHash and indexRulesHash. The
signed sourceRulesHash must match the engine's configured indexRulesHash. A raw
capture's SHA-256 evidence digest is not a substitute for that agreement.

**Q04 documentation review.** Checked the implementation-plan PDF's hash/change
policy and Q04, CP-PRICE-to-risk, counterpart contracts, risk specification,
IMarketConfig, RiskContextPort and PriceIngress. The index hash equality is
specified and enforced, but no canonical document/field encoding was found.
Listing.sourceHash and Listing.rulesHash remain distinct from indexRulesHash;
sourceState.rulesHash is the index ingress pin. Added
`docs/rules-hash-proposal.md` proposing a versioned typed ABI/Keccak manifest,
following existing listing/profile hash conventions, with owner agreement and
remaining policy inputs explicitly pending. Demo/test placeholder hashes do
not establish production rules. No runtime change or new test run was needed
for this documentation review.

**Risk responsibility recheck.** At the user's request, reread the risk handoff,
B016/B019 task definitions, implementations and tests, B assumptions, and release
and counterpart-status records. Risk already pins the supplied indexRulesHash
and signs/checks sourceRulesHash as part of its fixed observation digest. B016
contains a wrong-rules-hash rejection test. Q04 must not be represented as a
missing risk hashing implementation or a blocker to package-only development;
the open part is defining the shared dossier producing the supplied hash.
Current compiled wire comparison exited 0 after this recheck. No new Solidity
tests were run; the existing risk tests were inspected, not re-certified.

**Broader requirements cross-check.** Added `docs/risk-requirements-crosscheck.md`
covering Q02-Q10 and wire/authentication. Corrected current decision summaries:
engine units, carry/TWAP coverage and invalid-depth handling are fixed already.
Remaining producer/provider/deployment inputs are distinguished from risk code.
Clarified delayed-history acceptance, same-second replacement and the difference
between invalid depth and oracle INVALID. No runtime changes or additional test
run; this is source/doc review. Current diff whitespace and package-only scope
checks passed.

**Code included in this user commit.** Added candidate typed rules-manifest
encoding, development-only observation preparation from raw book and reviewed
metadata, packet sequence/fencing journal, and raw signer interface with recovery,
canonical signature and freshness checks. The first five targeted publication
tests and build passed. These additions are isolated library mechanics: no
collector CLI change, production signer or relay was enabled. The candidate
manifest is not the owners' approved Q04 format; builder/signing are restricted
to disabled development configurations / chain 31337. This entry was finalized
after detecting the user's actual commit, rather than fabricating its hash.

## Commit 86b5431 — signing retries and restore protection (PF013-PF016)

Full hash: `86b5431e5f8177ec99c5bd40d6b3a74da4f672e4`

Committed: 2026-10-03 16:07:24 +05:30

Message: `fix: protect pricefeed signing retries and archive recovery`

Base commit: `a728b4f8cb0d98f7a0deb6186f5167e78a2eae88`.
Suggested message: `fix: protect pricefeed signing retries and archive recovery (PF015-PF016)`.

**What changed.** Added a separate durable local-test signer journal, with the
public fixture key only and chain-31337 restriction. A reservation fixes one
identity/digest before signing; retries reproduce the same signature. Startup
reconciliation checks independent signer reservations against the packet archive
and rejects a restored archive behind the signer. Writer fences are enforced
before and after signing. Added signature checksums to packet integrity checks
and an explicit version-domain word to candidate rules encoding. Production
approval and transaction paths remain disabled.

**Verification so far.** Build exited 0 and targeted publication tests exited 0
with 10 cases. Cases cover raw-body recomputation, changed rules, fresh/headroom
bounds, restart/skipped sequences, independent domains, immutable packet copies,
signing timeout/retry, overlapping calls, wrong personal-message signing, writer
takeover, source-state mismatch, corrupt archive/counter rejection, and restoration
behind an independent signer journal. These are local deterministic tests; no
new source capture, external transaction or Solidity test run is claimed.

**Remaining.** Ordered transaction outbox/nonce allocation, simulation/spend
budgets, receipt/reorg/finality reconciliation, continuous pipeline/lifecycle and
operational evidence remain. The valid-only development builder does not resolve
Q08's invalid-transition delivery policy, provider quote/time semantics, canonical
Q04 approval or Q09 production key/environment inputs. PF gates remain unaccepted.


**Additional verified boundaries.** Added uint64 sequence-exhaustion and signature
serialization tests plus explicit refusal of the prior candidate packet schema,
requiring review/migration rather than silent archive mutation. The complete
package suite passed 184 tests after these changes (12 publication tests plus
172 earlier tests); Fraction vectors (144, seed 20261002, included in the suite)
and wire compatibility also passed. No new Solidity test or source request ran.

## Commit 42b4df5 — continuous collection and local relay (PF012-PF019)

Full hash: `42b4df578e075cab13c01c069c995b7e6918c90c`

Committed by the user: 2026-10-04 00:41:10 +05:30

Message: `feat: add continuous collection and local relay verification`

The entries below preserve the staged implementation/evidence history. The
commit hash was recorded after observing the actual user commit. Additional
local pipeline/adapter additions in that commit are noted in the 04 October
decision update below; historical test counts are not re-certified by this edit.

Base commit: `86b5431e5f8177ec99c5bd40d6b3a74da4f672e4`.
Suggested message: `feat: add continuous pricefeed collection service (PF012-PF017)`.

**What changed.** Added CollectionService and the `serve --configs --db` CLI
command. Independent periodic complete-book loops run until SIGINT/SIGTERM,
without overlapping a worker's polls. The existing global provider limiter still
bounds requests. Shutdown wakes interval timers, drains in-flight bounded
provider calls, and then closes the archive. A journal/callback failure stops
collection instead of returning false success. No WebSocket/incremental-book
logic, operational signer or transaction output was enabled.

**Verification.** Two service tests cover slow-worker isolation, no overlapping
polls, long-timer shutdown, duplicate run rejection, writer failure and draining.
`npm test` exited 0 with 186 tests, zero failures/skips/cancellations/todo cases.
Full package count includes the 144 Fraction vectors. Documentation updated and
actual user commits a728b4f and 86b5431 recorded. Scope/diff checks are confined
to packages/pricefeed; no new live-network or engine test is claimed.

**Remaining.** Continuous source availability and lifecycle behavior still need
the plan's soak/operating-budget evidence. This service runs read-only collection,
not the integrated signer/relay pipeline. PF018-PF019 relay/receipt/reorg mechanics,
Q08 invalid transitions, production inputs, reviewed rules/mapping/calibration and
release acceptance remain incomplete.


**Receipt-verification addition (PF019 partial).** Added raw-log verification
against the exact engine event: transaction/block identity, source, sequence,
original times, digest, depth flag and emitted midpoint must match. Reverted,
missing, duplicated, removed or mismatched acceptance logs cannot report mined
success. Explicit confirmation policy distinguishes MINED/FINALIZED/ORPHANED;
missing canonical block data establishes neither orphaning nor finality. Valid
and invalid-depth accepted samples are distinguished from TWAP/mark readiness.
The wire checker now compares the accepted-event ABI with IPriceSource too.

**Latest verification.** Build and full suite passed 189 tests (3 new receipt
cases plus 186 earlier tests), with no failures/skips/cancellations/todo cases.
The accepted-event/wire comparison passed. A TypeScript event-input union typing
error was corrected before the passing run; no risk source changes were needed.
These are pure local receipt fixtures, not new chain receipts or a complete
receipt/reorg polling worker. Suggested message for the combined current batch:
`feat: add continuous collection and receipt verification (PF012-PF019)`.


**Local relay mechanics (PF018/PF019 partial).** Added a local-chain-only relay
core with injected transport: serialized durable shared nonce allocation,
per-stream ordering, identity/listing preflight, exact transaction to/data/nonce/
chain/sender validation, gas/fee/age bounds, immutable signed raw transaction
storage before broadcast, bounded attempts, unknown-send receipt reconciliation
and mined/finalized/orphaned journal states. No concrete network adapter is
constructed and no actual RPC broadcast ran. Reserved-nonce failures require
recovery rather than nonce reuse. Fee replacement/cancellation and independent
transaction-signing restore controls remain incomplete.

**Verification.** Four relay tests cover timeout/identical retry, stream ordering,
restart nonce preservation, wrong-call rejection, spending-policy admission,
expired signing headroom and receipt/finality/orphan transitions. Reused an
explicit test fixture module instead of importing a test suite. Full package
suite exited 0 with 193 tests, zero failed/skipped/cancelled/todo cases; current
wire/event-ABI check and 144-vector Fraction reference check exited 0. This is
injected-transport evidence, not a new real-chain integration test.

**Plan audit.** At the user's request, reread PDF backlog PF001–PF028 and added
`docs/plan-status.md`, enumerating code, evidence and remaining acceptance for
every task. Updated README's obsolete 'unimplemented' wording to distinguish
new local mechanics from absent concrete adapters/integrated operational
pipeline. No human gates or counterpart files changed. Suggested combined
current-batch message:
`feat: add continuous collection and local relay verification (PF012-PF019)`.

## Progress update — 2026-10-04: operations and RPC clarification (before commit 42b4df5)

**Git status.** The current branch remains `pricefeed`; reading project-wide
documentation did not switch branches. HEAD is still
`86b5431e5f8177ec99c5bd40d6b3a74da4f672e4`. The continuous collection,
receipt-verification, local relay and plan-audit batch above remains uncommitted.
No new commit hash is assigned to this update. Other existing workspace changes
outside this package were observed and left untouched.

**Hosting and project boundaries.** Reviewed CLAUDE.md, the project implementation
plan, counterpart contracts, risk handoff, keeper runbook, oracle interface and
the pricefeed PDF. No hosting provider, specific server or production capacity
was selected in the reviewed documents. Book/risk/accounting/settlement belong
to onchain market contracts; Monad is referenced by project/interface documents.
The pricefeed is an offchain service. Keepers submit bounded maintenance
transactions; oracle infrastructure and frontend/indexer consumers belong to
their respective owners. Their interfaces/jobs do not constitute a hosting
decision. AWS EC2 and DigitalOcean were explanatory examples, not approved
infrastructure or deployments. No continuously running production bot or server
was configured. The plan proposes one service with isolated market workers,
single-active-writer operation, durable storage, monitoring and tested recovery.
Hosting and RPC are separate: an RPC provider does not run the bot process.

**Polymarket rate limits and request accounting.** Checked the official
[rate-limit documentation](https://docs.polymarket.com/api-reference/rate-limits)
on 2026-10-03: `/book` allows 1,500 requests per sliding 10-second window,
Gamma `/markets` listings 300 and `/events` listings 500. These are IP-based
Cloudflare limits; excess requests may be delayed/queued. Listing limits must
not be silently treated as separately documented limits for individual-ID routes.
Small live tests below these limits establish connectivity at the recorded
workload, not production throughput. Most unit tests use injected responses.

The current CLI shares `RequestLimiter(100, 200)` across workers: request starts
are spaced 100 ms apart, with a bounded pending queue. This coordinates one
process, not all processes sharing a public IP. Provider calls use timeouts and
bounded exponential retries; `Retry-After` handling and coordination across
processes remain production work. Each successful first poll makes three calls
(event, market metadata, complete book). Cached-metadata polls make one book
call; refreshing metadata adds two calls. Example settings poll every 10 seconds
and refresh after half the 90-second metadata-age bound, normally around
50 seconds. A normal five-cycle pattern is 3 + 1 + 1 + 1 + 1 = 7 requests,
approximately 1.4 per poll, excluding retries, errors and timing variation.
One complete-book response contains all returned bid/ask levels and quantities.
Authentic source time must still be checked after any throttling or delay.

**Monad RPC requirement (Q09).** The user reported obtaining an Alchemy Monad RPC
through Monad Metropolis; no actual endpoint or credentials were supplied or
validated. Alchemy's official
[supported-network documentation](https://www.alchemy.com/docs/reference/node-supported-chains)
lists Monad testnet and mainnet. An endpoint is a candidate only after checking
the network matches the approved engine deployment, supported methods, quotas
and the reviewed relay/finality policy. Polymarket collection alone needs no
Monad RPC. A live connection uses RPC to verify engine/listing state, send signed
observations and reconcile receipts. RPC does not supply the observation signer
or replace the deployed engine/configuration. Current signing/relay mechanics
remain development-only on local chain 31337; plugging in an Alchemy URL does
not activate them. Concrete RPC/key adapters, the integrated pipeline and Q09
approved inputs/transaction authority remain incomplete. No external send,
funding, deployment or production approval occurred.

**Verification for this update.** Read-only Git/source/document checks and official
provider-documentation review; only this progress file was edited. No tests were
rerun for this documentation-only change. The last recorded full package result
remains 193 passing tests, with wire/event-ABI and 144-vector Fraction checks
passing as documented above; those are historical results, not a new campaign.
Suggested message for the combined pending implementation batch remains
`feat: add continuous collection and local relay verification (PF012-PF019)`.

## Pending commit — consolidate requirements decisions (PF003)

Date: 2026-10-04. Base commit:
`42b4df578e075cab13c01c069c995b7e6918c90c`.
Suggested message: `test: document pricefeed requirements decisions (PF003)`.

**What changed.** Expanded `docs/decisions.md` to preserve the agreed before-fee
VWAP, directed rounding, two-sided displayed depth, exact fractional aggregation,
floor-total lot conversion and source-constraint policy; conservative authentic
source-time/frozen-retry handling; and the existing risk wire/output and
ownership boundaries. Recorded the candidate typed ABI/Keccak manifest as a
proposal, not canonical Q04 approval. Distinguished shared category configuration
from approved event mappings and engine invalid-depth behavior from unfinished
Q08 producer policy. Recorded hosting as undecided, example cadence/request
accounting as diagnostic settings, and the reported Alchemy Monad RPC as an
unvalidated candidate. Named review, provider semantics/units, actual mapping,
calibration, operational budgets/key backend/finality and release remain open.

**New user commit observed.** Recorded actual commit 42b4df5 above. It also
contains `src/pipeline.ts`, `src/local-rpc.ts`, `scripts/pipeline-local.ts` and
pipeline tests/demo additions. Source inspection confirms a joined development
path and concrete loopback RPC adapter restricted to disabled configs, public
fixture keys and chain 31337. This supersedes the earlier operational update's
claim that no local integrated path/concrete adapter existed. Production adapters
and an operational approved pipeline remain absent. No runtime or test-pass
claim is added merely because these files were committed. The preceding
'uncommitted' operations entry was written before this user commit and is now
part of it; its historical HEAD/status statement is not the current Git state.

**Verification.** Documentation/source/Git review only; no new package, live
source or engine tests run for this decision update. Only package decision/progress
documents edited; existing unrelated workspace changes left untouched.

**Operating-model clarification — 04 October 2026.** At the user's request,
reread all of this progress log, `docs/decisions.md` and root `CLAUDE.md` before
continuing. The pricefeed-specific scope overrides the risk team's branch and
commit workflow: stay on `pricefeed`, edit only this package, leave risk/CLOB/oracle
internals untouched and keep commits manual. Existing Q02 pricing choices and
conservative Q03 handling remain selected; do not reopen them as unanswered.

The user withdrew the once-per-minute proposal. Recorded continuous operation
with independent internal worker scheduling and supervisor-managed restarts.
The current 10-second example remains an initial test cadence; Q07 production
cadence/headroom requires measured source/signing/inclusion latency and genuine
30-second carry / complete 300-second coverage. Hosting remains undecided.
The local joined pipeline and loopback adapter are present, while Monad adapter,
operational key/configuration, invalid-transition and full lifecycle work remain.
No external transaction or deployment is implied by this clarification.

This is a documentation-only clarification; no new tests or network/chain runs
were performed. The preceding PDF/code review in this conversation ran `npm test`
with exit 0 and 200 passing tests, zero failures/skips/cancellations/todo cases;
that result is separate from the older staged counts above and does not establish
a new real-chain pipeline pass.

## Commit dbe6a48 — joined pipeline verification and invalid-depth checkpoints (PF014-PF020)

Full hash: `dbe6a48dc84767697329f0d7d0f0875e425196d9`.
Committed by the user: 2026-10-04 01:07:36 +05:30.
Message: `feat: add invalid-depth checkpoints and pipeline recovery`.

Date: 2026-10-04. Base commit: `42b4df578e075cab13c01c069c995b7e6918c90c`.
Suggested message: `feat: add invalid-depth checkpoints and pipeline recovery (PF014-PF020)`.

**Decision.** The user selected a local-development invalid-checkpoint policy:
for fresh, verified but invalid-depth books, preserve authentic source/publish
times and actual depths; set price and both impact prices to zero so ingress
records depthValid=false. Preserve computed impacts and failure reasons in the
source archive. This changes the versioned failure-policy hash. Canonical Q04
review, production Q08 acceptance and operational admission remain separate.

**Verification in progress.** The existing joined pipeline successfully ran with
fixture source data and a real owned Anvil chain: 15 observations accepted,
exact receipts verified and independent time-segment TWAP matched (three seconds
covered, full 300-second window unavailable as expected). Pinned Forge/Anvil
1.8.3 and solc 0.8.30 were used. First sandbox run failed with localhost EPERM;
the permitted local-only run with socket access exited 0. No external-chain
transaction occurred. Evidence: `artifacts/pipeline/latest.json` and its retained
four SQLite journals; this is synthetic source evidence, not a new live-source
soak or full economic composition.

Two tests added before implementation exposed an old-valid retry on new invalid
evidence and a fixed-timestamp test-receipt fixture. The retry now reconciles
pending receipts independently and suppresses the old-valid broadcast on invalid
input. The test transport decodes submitted sequence and labels its acceptance
time consistently. All nine targeted pipeline tests passed, including unsent
allocation expiry/restart with a burned sequence. New invalid-builder tests
and integrated policy verification are still in progress; no passing result
is claimed for unfinished checks.

**Further verified integration.** The invalid-policy builder suite passed all 14
tests; the joined pipeline suite passed all 12 then-current tests. Fresh verified
thin/wide/crossed/endpoint books produce zero price/impacts with real depth/time;
untrusted, missing, closed and stale source evidence remains unavailable.
The policy is explicitly selected for local development and changes the rules
hash; valid-only manifests retain their previous behavior.

## Pending follow-up — simulation, source isolation and reviewable evidence (PF016-PF020)

Date: 2026-10-04. Suggested message:
`fix: preserve worker isolation and relay headroom (PF016-PF019)`.

**Failure and correction.** The new fixture transition scenario first failed
after the missing-time gap with actual ingress `FutureTimestamp()` (selector
0x0ff02cef): a quiet automining Anvil chain's latest block timestamp predates new
authentic evidence. The loopback adapter now simulates the next pending block;
mined ingress still enforces zero future tolerance. No source/publish timestamp
was changed to make the packet pass. Simulation precedes nonce reservation, so
a rejected simulation does not burn the shared transaction nonce.

The repeated real local-contract transition run exited 0: 28 packets accepted,
including invalid checkpoints, missing-time gaps retained and valid recovery at
the independently known fixture price 0.63. Full 300-second availability was
not claimed for the six-second fixture. Reports now retain signed packets,
delivery data, verified tool versions and SHA-256 hashes of closed SQLite
archives. Fixture scenario and genuine-source evidence are stored separately.

**Source isolation.** A quarantined worker returns an explicit QUARANTINED status
and stays quarantined in its pipeline instance while independent workers keep
running. The real collector persists quarantine across restart. Shared storage,
fencing and integrity failures still stop the service. Source outages/invalid
evidence suppress old-valid rebroadcast; matching pending receipts can still be
reconciled. An unresolved reserved nonce cannot be discarded to skip ahead.

**Verification in progress.** The 18 targeted pipeline/relay tests passed,
including source isolation, rejected simulation without nonce consumption and
outage receipt reconciliation. A new post-simulation headroom test and complete
package verification are in progress. Monad operational adapters, full lifecycle,
fee replacement/cancellation and production acceptance remain unfinished.

## Live-source campaign — durable pipeline and journal restart (PF016/PF020/PF021)

Date: 2026-10-04. Observed HEAD:
`06721884e31668affe0c5f669d269a42141dd11f`, committed by the user on
2026-10-04 01:17:40 +05:30 as
`feat: add invalid-depth checkpoints and pipeline recovery`.
Existing uncommitted simulation/isolation fixes were retained.
Suggested message: `test: add live pricefeed journal restart checks (PF016-PF021)`.

**Authorized next step.** The user requested completion of the proposed real
Polymarket / owned-local-engine campaign, including full 300-second coverage and
restart/recovery. No Monad/external-chain send or production deployment is part
of this campaign. All implementation/evidence remains within this package.

**Changes.** Extended `scripts/pipeline-local.ts` with an optional timed restart
and a required-full-window assertion. The restart closes all four SQLite
journals and reconstructs the worker, signer, packet store, relay and pipeline
on the same owned chain. It verifies persisted packet/digest/signature/raw
transaction/nonce bytes remain unchanged and that chain acceptance advances
after resuming. This is a graceful in-process reconstruction, not a forced OS
kill or restored-backup drill. Source time and chain time are never accelerated.

**Verification so far.** Real-source six-second preflight exited 0 with one
accepted valid observation through the durable pipeline. Eight-second fixture
restart smoke exited 0 with 44 accepted packets. Initial sandbox localhost
listen failed with EPERM; authorized socket/network execution was then used.
An unused-variable TypeScript error was fixed before the passing build/runs.
Current `npm test` exited 0: 210 tests, zero failures/skips/cancellations/todo.
The six-minute real-source run with restart at 180 seconds is IN PROGRESS;
no full-window result or production readiness is claimed before it finishes.

**Ten-second live campaigns completed.** The crypto run accepted 25 packets;
its midway restart preserved 12 immutable packets and chain sequence advanced
to 25. Independent full-window integration matched the real contract but only
236 of 300 seconds were valid: the required-full-window command exited 1.
Polymarket repeated a source timestamp until it was stale; unavailable samples
were archived, never refreshed with receipt time. Retained report:
`artifacts/pipeline/pipeline-1791058126551-8d2f22ef-a576-4dbc-b233-3d1874d4706f.json`.

The separate politics run used the YES token for "Will Flávio Bolsonaro win
the 2026 Brazilian presidential election?" (event 45915, market 601826).
It accepted 35 packets; 17 immutable packets survived restart and acceptance
advanced to sequence 35. Its strict final check exited 1 with 294/300 seconds
of valid coverage. Report:
`artifacts/pipeline/pipeline-1791058598817-15fa26af-16b0-4f30-a2e2-019799de5efe.json`.
These are distinct configured demo markets, not a fallback price substitution.

**Evidence hardening.** Each new run now retains a uniquely named report as well
as latest pointers, preventing later runs from replacing its evidence. Final
TWAP is checked at a named, ordinary final local block mined at the real clock;
quiet-chain evaluation cannot hide a current gap. Packet/receipt records are
saved even if the strict coverage assertion fails. Added an offline
`scripts/review-pipeline.py` checker: closed-file archive hashes, authentic source
time, independently derived Fraction VWAP/depth/rounding, receipt bindings,
unique nonces/increasing sequences and independent 30-second-carry/300-second
segment integration. Both failed-coverage archives passed this independent
review. Four malformed report cases were rejected (false full coverage, wrong
archive hash, wrong accepted count and external-chain claim). This validates
recorded local evidence, not provider timestamp semantics or production finality.
Review output: `artifacts/pipeline/live-review.json`.

**Diagnostic cadence investigation.** A separate repeat uses a temporary disabled
politics config at five-second polling. N/spread/mapping/policies and authentic
timestamps remain unchanged. This investigates a six-second coverage gap; it
does not select production Q07 cadence or weaken full-coverage requirements.
The six-minute repeat and its 180-second journal restart are IN PROGRESS.
README and the staged PF audit now distinguish the implemented local path from
unfinished production adapters/lifecycle/acceptance. Wire/event-ABI and all
144 independent reference vectors passed; external-chain transactions remain zero.

## Commit 7d95587 — initial live journal restart checks (PF016-PF021)

Full hash: `7d95587da17f2cc3f7084d45f04de7afc6fe1c4f`.
Committed by the user: 2026-10-04 01:39:52 +05:30.
Message: `test: add live pricefeed journal restart checks`.

This commit contains the optional journal restart/full-window check and the
initial preflight/smoke evidence, plus the preceding simulation/headroom/isolation
fixes. It was detected during the longer campaigns. Later six-minute reports,
independent checker, unique report retention and final block-labeled evaluation
are follow-up work and are not attributed to that commit.

## Pending follow-up — live coverage evidence and independent reconstruction

Base: `7d95587da17f2cc3f7084d45f04de7afc6fe1c4f`.
Suggested message: `test: record live pricefeed coverage and independent replay (PF020-PF021)`.
The five-second diagnostic repeat is still running. Its result, exact coverage,
archive hashes and restart verification will be recorded after completion.

**Final real-source result — PASS.** The five-second politics repeat exited 0
after 360,134 ms of actual polling time. It accepted 72 signed observations on
the owned local engine, with no source-gap/invalid result during this run.
The source archive contains 73 COLLECTING samples including the initial probe.
The actual YES question was "Will Flávio Bolsonaro win the 2026 Brazilian
presidential election?"; event 45915, market 601826. This is an explicitly
disabled demo mapping, not a production listing approval.

The 180-second restart reopened all four journals and reconstructed the worker,
signer, relay and pipeline. All 36 pre-restart packet/digest/signature/raw
transaction/nonce records stayed unchanged; source-state acceptance advanced
from sequence 36 to 72. Unique transaction nonces, increasing sequences and
nondecreasing original source milliseconds passed. The longest accepted source
timestamp gap was 21,593 ms; sampled source ages ranged from 212 to 17,641 ms.
Receiving/publishing/mining did not replace the source timestamp. This verifies
graceful reconstruction; forced OS crashes and backup-restore drills remain
separate work.

The strict final engine view had **300/300 valid seconds**, with
`twapWad=600060705566666666` (0.600060705566666666) and
`integral=180018211670000000000`. Independent segment integration and the offline
Python Fraction/raw-book review matched exactly. Evaluation block 74, timestamp
1791059387, hash
`0xe98eaaa13cbb907fbe8cc5fa6d92461787eda655dd0bdafa0973780d3422e550`.
Pinned Forge/Anvil 1.8.3, solc 0.8.30, Node 24.21.0 and the package lockfile were
used. No risk/CLOB/oracle/factory code was changed, no source/chain time warped,
and external-chain transactions remained zero. The temporary owned chain was
shut down by the runner after verification.

**Retained evidence.** Successful immutable report:
`artifacts/pipeline/pipeline-1791059026500-8d4428c3-17e5-43ee-ad4d-3079a66f6039.json`.
Latest pointers contain the same result. Report SHA-256:
`25797feb07fb27eb047a5a21c184207fe87e76a5052041df810967198c1516f1`.
Raw source/packet/signer/relay SQLite archives remain under
`var/pipeline-1791059026500-8d4428c3-17e5-43ee-ad4d-3079a66f6039`; these raw files
are intentionally ignored by Git and must accompany an independent replay of
the retained capture. Each closed-file hash is recorded in the report.
`artifacts/pipeline/live-review.json` independently verifies all three live
campaigns, including both unavailable windows; SHA-256:
`e8429a31917de01e582835eaca6e32287563fe86f13bd24c17a2133d7f354940`.

**Reproduce.** For the same diagnostic cadence, copy the disabled politics example
to a local config and set only `poll.intervalMs` to 5000. The temporary config in
this run was `var/politics-five-second.json`. Run:

```bash
PRICEFEED_FORGE=/tmp/eros-foundry-v1.8.3/forge PRICEFEED_ANVIL=/tmp/eros-foundry-v1.8.3/anvil PRICEFEED_SOLC=/home/mihir/.local/share/svm/0.8.30/solc-0.8.30 npm run demo:pipeline -- --source polymarket --config var/politics-five-second.json --duration-seconds 360 --restart-after-seconds 180 --require-full-window true
python3 scripts/review-pipeline.py artifacts/pipeline/pipeline-1791058126551-8d2f22ef-a576-4dbc-b233-3d1874d4706f.json artifacts/pipeline/pipeline-1791058598817-15fa26af-16b0-4f30-a2e2-019799de5efe.json artifacts/pipeline/pipeline-1791059026500-8d4428c3-17e5-43ee-ad4d-3079a66f6039.json
```

Run from this package with the pinned tools already installed. A later live run
may have different prices/coverage; passing once does not guarantee availability.

**Verification and remaining scope.** Current package suite: 210 passing tests,
zero failures/skips/cancellations/todo; wire/event-ABI comparison and the 144
Fraction vectors pass. Both failed coverage results and their exit-1 status are
preserved; the five-second run alone passed the full-window gate. The offline
checker passed all three archives and rejected the four malformed claims noted
above. Diff whitespace and outside-package change checks passed. This completes
the requested local real-data/full-window/graceful-restart campaign, not PF human
acceptance or full pricefeed production release. Five seconds is measured demo
evidence, not approved production cadence. Provider timestamp/quote semantics,
canonical rules/mapping approval, calibrated N/spread, full lifecycle/24-hour
recording, broader load/crash/restore/operations, production Monad/key/backend
configuration and independent release acceptance remain open.

## Commit 849576c — live coverage evidence and independent reconstruction

Full hash: `849576c71c3ac70da696a59c31d75c71059af284`.
Committed by the user: 2026-10-04 02:08:32 +05:30.
Message: `test: record live pricefeed coverage and independent replay`.
The preceding pending real-source campaign, independent reviewer, retained
success/failure reports and final coverage documentation are now committed.
This is observed Git history; no agent commit or human gate acceptance is claimed.

## e37d19b — durable recorder lifecycle and signed 24-hour fixtures (PF023)

Observed commit: `e37d19b675bf4b6582271f5d8a8e950e012fd4b8`,
04 October 2026 02:45:41 +05:30.
Message: `feat: add durable record-only pricefeed lifecycle`.
The following implementation and verification were recorded before this user
commit. No new test results or human gate acceptance are implied by recording it.

Base: `849576c71c3ac70da696a59c31d75c71059af284`.
Suggested message: `feat: add durable record-only pricefeed lifecycle (PF023)`.
Authorization: user requested the next step; all changes stay in this package.
Requirements read: plan pages 16/26, current oracle interface's fixed INVALID
window and existing risk ingress/store/capture/context code. No risk, CLOB,
oracle, factory, shared STATUS, fingerprint or approval files were modified.

**Implemented.** LocalLifecycle persists pinned, canonical block-labeled engine
decisions in a fenced checksum-protected journal before permitting output.
Disabled configs on chain 31337 only; explicit requiredFeedUntil >= scheduledT
and listing horizon checks. Early engine halt enters RECORD_ONLY, continuing
the same independently sourced observation path. The exact deadline is included;
a verified fresh block beyond it enters persistent STOPPED. RPC/stale/future
checkpoint failures block output. Wrong pins, backwards/inconsistent blocks,
reorgs and disappearing halts persist QUARANTINED. Config or checkpoint-age policy
changes require review; corrupt/fenced archives cannot grant output. Returned
checkpoint objects cannot mutate internal trusted state; overlapping checks coalesce.

The scheduler checks lifecycle before fetching and lets each stopped worker
exit independently. LocalPipeline requires a controller when a config declares
requiredFeedUntil and verifies the exact config digest. It gates allocation/
observation signing and rechecks after signing. Relay checks after simulation
before nonce reservation and after transaction preparation before broadcast.
Deadline crossings produce no broadcast. If a nonce was already reserved,
retain the exact raw transaction in QUARANTINED state: never reuse/skip it.
Approved cancellation/replacement and operational nonce recovery remain PF018.
Receipt reconciliation in process() remains read-only before publication gating;
completion retains unresolved evidence rather than reporting delivery success.
Existing deadline-free diagnostic demos are preserved.

Source lifecycle stays separate: closed/untradeable metadata creates archived
unavailable/gap diagnostics while recording is required. No new final-result
0/1/0.5 sample, fresh timestamp or oracle callback is invented. The bot exposes
no halt, settle or INVALID-capture actions. Read-only health now recognizes
lifecycle records alongside source captures and rechecks block freshness.

**Decisions/boundaries.** The fixed [T-86400,T] window and no post-halt economic
resume come from existing risk docs, not a newly selected payoff rule. The
reader in this step is injected fixture data, explicitly distinct from venue
status. A concrete approved engine lifecycle RPC reader remains open; the
existing localRpcTransport reads listing/sourceState but not halt state.
Checkpoint-age bounds, exact-deadline inclusion and persistent conservative
reorg quarantine are explicit local development behavior, not production
finality/closure/operating approval. A new archive writer respects the existing
lease; no forced takeover or OS-kill certification is claimed. Q08 documentation
was corrected to describe the already implemented local fresh invalid-depth
tuple while leaving production priority/coalescing/closure approval open.

**Verification.** npm test exits 0: 223 tests, no failures/skips/cancellations/todo;
this includes 144 Fraction vectors (seed 20261002); do not add them again.
Wire/event ABI check and test:reference both exit 0. Build passes.
The focused controller/pipeline/service suite (27 tests) and four signed lifecycle
tests pass under npm run test:lifecycle with pinned Forge 1.8.3/solc 0.8.30.
Eight package-owned Solidity tests pass under npm run test:engine, filtered to
the two owned test contracts so imported risk tests do not inflate the count.
Four are existing wire/short-window cases; four are the new lifecycle cases.

The signed 24-hour fixtures use accelerated Foundry VM time, real PriceIngress,
ObservationStore, InvalidPrice and risk context, with existing scripted
accounting/book/oracle counterparts imported read-only. Only the test actor
drives the mock oracle. Independent expectations: 4,321 samples at 20-second
fixture cadence provide 86,400 seconds and TWAP 0.52 from equal 0.42/0.62
half-windows; capture/provenance stay immutable after live-ring wrap and later
samples. A 100-second inter-sample gap gives exactly 86,330 seconds (30-second
carry, 70 missing); 4,317 packets remain, and only the engine applies its listed
fallback at T+3600. Legacy missing history remains BLOCKED. An authenticated
thin checkpoint yields 86,380 seconds with no fabricated coverage. All four
retain HALTED/no-admission, original funding cutoff and once-only freeze.
Machine evidence: artifacts/verification/lifecycle.json, lifecycle-unit.json and
engine.json. The unit summary parses the actual final 223-test TAP log and binds
the tested package sources by SHA-256; it does not claim a future commit hash.

Full suite regressions cover truthful closure gaps, stop/quarantine restoration,
clock rollback/skew, corrupt/expired archives, policy changes, worker isolation,
and slow observation signer/relay simulation/transaction preparation crossing
the deadline. Slow awaited lifecycle guards also recheck source headroom/writer ownership
before nonce reservation and broadcast; both expiry boundaries are tested.
Outside-package diff and whitespace checks pass. External-chain
transactions: zero. These are fixtures, not an elapsed 24-hour live-source soak
or an authentic oracle join. PF023 remains partial for its prerequisite owner
decisions, concrete production reader, approved closure/operating policy,
selected-listing availability and named risk/oracle review. README, decisions,
plan-status and docs/lifecycle.md record this distinction.

Next independent work: operator build-observation CLI and broader process-crash,
restore/load evidence/runbooks. Production RPC/key/listing/calibration and
independent acceptance remain owner inputs; this work does not authorize launch.

## 47b442b — unsigned archive replay CLI (PF017)

Observed commit: `47b442b663455086c0041f15803adc8db3f28405`,
04 October 2026 10:54:24 +05:30.
Message: `feat: add offline observation replay CLI`.
The user committed the code, tests, README, command docs and machine verification
while the final detailed progress/plan-status notes were being written. Those
two documentation updates remain pending after this commit. This records actual
Git history; the agent did not commit or alter the user's included sponsor files.

Base: `e37d19b675bf4b6582271f5d8a8e950e012fd4b8`.
Pre-commit suggested message: `feat: add offline observation replay CLI (PF017)`.
The user requested continued implementation and commit messages every ten minutes
on 04 October 2026. Current reminder policy and decisions now reflect that interval;
earlier five-minute entries remain historical. Commits remain manual on pricefeed.
The previously pending PF023 entry is now linked to its observed actual user commit.

**Implemented.** `build-observation` exposes the existing pure development builder
through an offline command. All config/rules/archive/capture-ID/proposed-sequence/
replay-time arguments are explicit. Configs stay disabled with a destination on
chain 31337. A read-only SQLite transaction streams capture checksum verification
and selects the requested record. Worker/category, collection/persistence times,
raw-body/parsed-data agreement, event membership, source rules, tradeability,
source/metadata age and headroom are checked before recomputing the packet.
Persistence may lag collection slightly; it cannot precede it. Archived summaries
cannot replace arithmetic, and degraded/quarantined selected captures are unavailable.

Output shows configured pins, capture provenance, recomputed impacts/reasons,
eleven fields, raw digest and evidence hash. Selected fresh invalid-depth policy
preserves real depth/time with zero packet prices; valid-only policy remains
unavailable. Exit 0 is an unsigned candidate at declared historical time, 2 is
unavailable and 1 is a command/integrity failure. Listing/lifecycle verification,
allocated sequence, readiness for signing and operational output are explicitly
false; signatures/transactions are zero. No signer, relay or provider call occurs.
Configured engine/code/ABI/signer pins are not claimed verified. Fixed-code CLI
errors avoid reflecting JSON input, paths, unknown option values or stack traces.
README and docs/offline-observation.md describe usage and these boundaries.

**Verification.** Tests-first CLI coverage was added before implementation.
Initial sandbox subprocess runs failed with EPERM on output pipes; approved
outside-sandbox execution allowed the actual tests. The initial real run caught
an incorrect test assumption about SQLite read-only WAL/SHM creation; assertions
now check unchanged database bytes and records rather than absence of SQLite
coordination files. A subsequent test exposed shared fixture mutation; raw fixture
objects are now cloned per test. Neither failure was relabeled as a passing run.

Final `npm test` exits 0: **232 tests**, no failures/skips/cancellations/todo,
including nine CLI subprocess cases and the existing 144 Fraction vectors
(seed 20261002). Build, `npm run check:wire` and `npm run test:reference` exit 0.
`git diff --check` passes. CLI tests cover exact unsigned fields, raw invalid impacts,
archive/representation corruption, stale/missing/future timestamps, closure,
quarantine, identity/rule mismatch, persistence latency, sequence bounds, external
chain rejection, malformed JSON, redaction, duplicate/unknown options and missing DB.
No owned Solidity test was rerun for this CLI-only slice; prior evidence remains
historical rather than being claimed a fresh pass.

The command also replayed capture 2 from the retained successful real-source
politics campaign `pipeline-1791059026500-8d4428c3-17e5-43ee-ad4d-3079a66f6039`.
Explicit replay time 1791059028222 ms and proposed sequence 1 reproduced the
original observation, source time, evidence hash and digest exactly:
`0x2c430f80906f6f1f735ae712ebeb9bcfe8bc02cd6df23cfbe47e7b2873d5f4b7`.
This used retained books, not new public requests or chain activity. Machine
evidence: artifacts/verification/offline-observation.json, with command results,
actual TAP counts/log hash, replay inputs/output and tested source SHA-256 hashes.
No future commit hash or human gate acceptance is claimed.

**Remaining/next.** PF017 still needs broader operator review of collection/storage
failure paths; no operational signing/sending command is authorized. The next
independent slice is a forced process-crash/restore campaign and its recovery
runbook, beyond the existing graceful four-journal reopen tests. Production
mapping/calibration/key/RPC/finality, concrete lifecycle reader, policies and named
acceptance remain open. Edits stay in packages/pricefeed; unrelated sponsor-plan
and root output work is left untouched. External-chain transactions: zero.

## 13e92b7 — PF017 final progress and verification notes

Observed commit: `13e92b7c35a4668bb6ccc36f493127edeb636c3a`,
04 October 2026 10:58:28 +05:30.
Message: `test: record offline observation replay verification`.

Base: `47b442b663455086c0041f15803adc8db3f28405`.
Suggested message: `test: record offline observation replay verification (PF017)`.
Only PROGRESS.md and docs/plan-status.md were updated to record the observed user
commit, final 232-test result, real-capture packet/digest/evidence-hash match and
next recovery work. No source changed after the successful suite; historical
Solidity evidence is explicitly distinguished from freshly run CLI checks.

## fff4013 — process-crash fixtures added during PF016 work

Observed commit: `fff4013a76a7879a9b77fdd333c182ffc5053b5b`,
04 October 2026 11:09:50 +05:30.
Message: `fix: quarantine expired relay reservations after restart`.
The observed diff contains recovery-child.ts and recovery.test.ts only. The
actual relay fix was applied in the working tree afterward; this commit message
alone does not mean the expiry regression passes in that committed snapshot.

## 987c6fc — expiry quarantine fix, crash evidence and recovery runbook

Observed commit: `987c6fc4428e656ca8171383b4049972d502fd6e`,
04 October 2026 11:20:40 +05:30.
Message: `fix: persist expired relay quarantine and recovery evidenc`.
The actual relay change, recovery runner/runbook and retained results are now in
the observed user commit. The recorded message is preserved exactly from Git.

Base: `fff4013a76a7879a9b77fdd333c182ffc5053b5b`.
Suggested message: `fix: persist expired relay quarantine and recovery evidence (PF016)`.
User requested remaining-plan percentage then the next implementation step.
Planning estimate before this slice: core bot implementation about 80% complete
(20% left); full implementation/operations/review plan about 65% complete
(35% left). These are approximate effort estimates from the PF001–PF028 audit,
not a count of accepted tasks, measured schedule or production release score.

**Implemented.** Thirteen OS SIGKILL boundaries exercise actual source,
packet, observation-signer and relay journals with scripted source/transaction-
signer/chain counterparts. Initial seventeen-test recovery suite passed after
correcting a fixture JSON formatting assertion. The enhanced expiry regression
then failed: a restarted expired reserved packet was refused but its delivery
remained PREPARING instead of persistent quarantine. LocalRelay now persists
RESERVED_NONCE_HEADROOM_EXPIRED before refusing previously reserved states,
including after delayed simulation/guard reads. It preserves packet/raw bytes
and invokes the existing shared-account allocation block. The focused expiry
case now passes for PREPARING/READY/UNKNOWN. The complete recovery/relay and
package suites subsequently passed as recorded below.

Additional tests cover immediate lease contention, packet snapshots behind
independent signer reservations, relay snapshots behind consumed chain nonce,
precise signer reservation/signature crash stages, another worker blocked by
quarantine and slow resimulation. Added test:recovery runner records commands,
actual TAP results, thirteen case reports and source hashes. The recovery runbook
distinguishes scripted crash evidence from real-source/Anvil graceful restarts,
and names backup, receipt, expiry and unresolved-nonce limitations. All work stays
inside packages/pricefeed; no deployment or external transaction occurs.

**Final verification.** `npm run test:recovery` exits 0 with 26 passing tests,
including thirteen boundary cases and four additional lease/restore/expiry
tests (some run multiple scenarios), plus nine relay tests. The complete
`npm test` exits 0 with **251 tests**, no failures/skips/cancellations/todo.
The 144 independent Fraction vectors (seed 20261002) and focused 26 tests are
already included; do not add the counts. Build, `npm run check:wire`,
`npm run test:reference` and `git diff --check` exit 0. The first sandbox full run
reported 242/251 passing because nine CLI subprocess outputs were unavailable;
the approved outside-sandbox repeat passed all 251. The isolated expiry test
failed before the relay fix and passed afterward. Actual failure/pass results
are retained in the progress and machine summaries, not rewritten as first-run
success. Owned Solidity tests were not rerun for this bot journal/relay change;
earlier evidence remains historical.

Machine evidence: artifacts/verification/recovery.json and recovery.tap retain
the focused command, thirteen per-boundary reports, actual TAP counts, tested
source hashes and explicit fixture/clock limitations. recovery-unit.json records
the final full-suite counts/log SHA-256, actual base commit and source hashes,
wire/reference results and earlier failure reasons. No future commit or human
acceptance is manufactured. Each resumed boundary preserves archived packet,
digest and stored signature, reuses the exact reserved transaction, recovers
already accepted receipts without another broadcast, and continues sequences
1/2 with nonces 0/1. Tests independently inspect signature-null reservation
versus persisted signer signature. Immediate lease takeover, lagging packet
snapshot, lagging relay nonce snapshot and expired sends remain blocked.

**Remaining/next.** Crash fixtures manually compose existing journals; source,
transaction-signer reservations, blocks/receipts/acceptance and elapsed clock are
scripted. This is real OS termination, not a joined LocalPipeline/Anvil kill,
disk/power-loss, production supervisor or production-backup certification.
Next independent work is many-worker load/slow-RPC evidence and an owned-chain
joined crash campaign. Production transaction-signer backup/reservations,
canonical block-labeled reads, nonce replacement/cancellation, approved budgets,
supervisor/monitoring, mapping/calibration and named acceptance remain open.

## 7b112bd — many-market load and queue-expiry handling (PF024)

Base: `987c6fc4428e656ca8171383b4049972d502fd6e`.
Committed together with the joined crash slice as
`7b112bd017d7990190961cb325385301e547f19b`, 04 October 2026
12:03:17 +05:30, actual message `test: verify joined pipeline crash recovery on Anvil`.
User requested the next step after the simple four-commit explanation. Scope
remains packages/pricefeed on pricefeed; commits are manual and reminders every
ten minutes. This slice measures declared local fixture workloads, not approved
Polymarket/RPC capacity or production cadence.

**Implemented.** Added mixed crypto/sports/politics worker fixtures with distinct
mapping/rules/domain identity, actual Worker/Journal/PacketStore/LocalTestSigner/
LocalRelay/LocalPipeline and a shared RequestLimiter. Source and RPC/receipts are
scripted; monotonic elapsed time drives the fixture clock, with explicitly
injected 31-second offset for deterministic expiry cases. No network client,
external transaction or production adapter is constructed.

Initial six-case load suite passed five and failed queued expiry: twelve signed
unreserved packets became stale behind one gated simulation and process()
rejected them rather than returning normal EXPIRED results. LocalPipeline now
rechecks source headroom at queue execution and converts pre-reservation relay
headroom exhaustion into durable UNSENT_HEADROOM_EXPIRED. Sequence is burned,
original signed packet/time/bytes are retained, and pending work is removed.
Existing reserved deliveries remain subject to relay quarantine/recovery.
No timestamp rewrite, unsigned replacement or production coalescing policy is
introduced. After the fix, the six load cases plus existing pipeline suite pass
23/23. Added a seventh case proving the continuous joined service survives the
same expiry, archives new source captures and reaches fresh acceptance for each
worker. Added test:load runner and docs/load-evidence.md with explicit fixture
budgets, what is measured and production limits. README/decisions/plan-status
describe the new behavior and its boundaries.

**Final verification.** `npm run test:load` exits 0 with 26 focused tests (seven
load, seventeen existing pipeline and two service tests). Complete `npm test`
exits 0: **258 tests**, zero failures/skips/cancellations/todo, including 144
Fraction vectors (seed 20261002). Build, `npm run check:wire`,
`npm run test:reference` and `git diff --check` exit 0. The initial 5/6 failure is
retained as the regression that drove the fix; it is not described as a pass.
Full suite runs outside the sandbox under the existing authorization for CLI
subprocess output pipes. No owned Solidity test was rerun for this bot-side
queue change; prior signed lifecycle/ingress evidence remains historical.

Declared workloads: 25 collectors with one gated book (other workers poll at
least twice, no per-worker overlap); two rounds of 25 distinct mapped/domain
workers across crypto/sports/politics (50 scripted accepted receipts, shared
nonces 0–49, per-source sequences 1/2); twelve signed packets aged 31 seconds
before nonce reservation (EXPIRED, no broadcast, unchanged fields/signatures,
fresh replacements at sequence 2 with nonces 0–11); a two-second simulation
timeout followed by harmless late completion and immutable retry; eight-worker
continuous service expiry/recovery; queue-cap-four burst across 20 workers
(16 truthful degraded gaps, subsequent recovery); and 100-worker initial drain/
shutdown with explicit rejection of 101 workers. Provider queue saturation never
manufactures an observation. Packet/source archives verify in all scenarios.

Measured focused-run examples: 25-market two-round scenario elapsed 8,084.047 ms
including setup, crypto, SQLite/source/RPC work; maximum fixture source age at
broadcast 3,575 ms, minimum source headroom 25,711 ms, maximum elapsed since
signer completion at simulation 1,919 ms. Raw arrays and all scenario timings
are retained, rather than converted into an approved throughput SLA. Source
spacing one ms, source delay zero/one ms, RPC delay zero/three ms, two-second
RPC timeout, 60-second writer leases and one-second headroom are test settings.
The fixture clock uses monotonic elapsed ms plus the explicit 31,000-ms offset
in expiry cases; this is not elapsed soak. Actual network inclusion/finality,
IP-wide request coordination and production queue fairness remain unmeasured.

Evidence: artifacts/verification/load.json and load.tap bind the actual command,
seven measured cases, tested source SHA-256 and limitations; load-unit.json binds
the final 258-test TAP count/log hash, actual base commit, source hashes, wire/
reference results and original failing regression. No future commit, named
gate acceptance, capacity guarantee or new external transaction is claimed.
The seven load/focused 26/reference 144 counts are already included in 258.

**Remaining/next.** These are short small-book fixtures with scripted source/RPC
and actual bot/journal classes. CollectionService source isolation is separate
from LocalPipeline.run, which still awaits publication per worker and serializes
shared RPC work; full collection/publication decoupling is not certified.
No queue coalescing, closure/invalid priority or operational policy is silently
selected. Next independent work is a joined LocalPipeline crash campaign against
owned Anvil. Sustained/larger-book/load/availability and calibration budgets,
disk/permissions/power pressure, production signer/backup/RPC/lifecycle reads,
nonce recovery, supervisor/monitoring and named acceptance remain open.

## 7b112bd — joined continuous-pipeline Anvil crash campaign (PF016/PF018)

Base: `987c6fc4428e656ca8171383b4049972d502fd6e`. Committed with the
preceding load slice as `7b112bd017d7990190961cb325385301e547f19b`,
04 October 2026 12:03:17 +05:30, actual message
`test: verify joined pipeline crash recovery on Anvil`.
User requested continuation after the seven-major-work-block explanation.
Scope remains package-only on pricefeed, with manual commits and ten-minute
reminders. No production or external-network transaction is authorized.

**Implemented.** Added test:pipeline-crash, its pinned Python runner, an owned
Anvil parent and a separate bot child. The child uses actual LocalPipeline.run,
Worker, all four existing journals, LocalTestSigner, LocalRelay and the concrete
loopback RPC adapter. Parent creates the existing package-owned receiver importing
real PriceIngress/ObservationStore and keeps Anvil alive through OS SIGKILL.
Source event/metadata/book responses, public keys and listing inputs are fixtures.
No risk/CLOB/oracle source, deployment configuration or shared gate was changed.

Seven boundaries: SIGNED, PREPARING, TX_SIGNED, UNKNOWN before network I/O,
BROADCAST after actual EVM acceptance but before the bot receives the result,
MINED, FINALIZED. Five cases recover immutable packet/digest/signature and any
saved raw transaction/hash, accept sequences 1/2 exactly once, and continue the
next transaction nonce. Parent independently checks actual ObservationAccepted
logs, payload digest, transaction hashes, fixture midpoint 0.60 and valid depth.
Already accepted cases broadcast only the new sequence on restart. An immediate
replacement is rejected; later restart waits actual stored lease deadlines
(approximately ten seconds here), without time warp or lease edits.

PREPARING and TX_SIGNED safely block PIPELINE_DELIVERY_RECOVERY_REQUIRED because
the local transaction signer has no independently durable raw transaction
journal. Both preserve packet and delivery bytes, consume no chain nonce and
produce zero acceptance events. These are expected safety blocks, not automatic
recovery passes. Also added a unit regression verifying that a lagging pending
nonce RPC cannot lower the relay's reserved nonce high-water mark on repeated
startup. The existing implementation passes; no relay fix was necessary.

**Verification.** Final test:pipeline-crash exits 0: seven boundaries, five
continuations and two expected blocks; report/log bind tool versions, actual base
commit, source SHA-256, archive location, command and exit code. Pinned Foundry
1.8.3 tools were restored to /tmp because the earlier temporary directory was
gone; global 1.5.1 was not substituted. solc 0.8.30 and package Node 24.21.0
remain pinned. Sandbox localhost bind returned EPERM, so the owned-chain run
used scoped external-sandbox execution. A first seven-case run also passed;
additional parent receipt checks initially used the wrong event field name,
causing compilation failure, then were corrected to payloadDigest before the
final successful rerun. No assertion was weakened.

Complete npm test exits 0: **259 tests**, zero failures/skips/cancellations/todo,
including the added nonce regression and the existing 144 Fraction vectors.
Build, check:wire, test:reference and diff whitespace checks exit 0. The seven
Anvil boundaries are a separate campaign and are not counted inside 259. Evidence:
artifacts/verification/pipeline-crash.json, pipeline-crash.log and
pipeline-crash-unit.json; final unit TAP retained in var/pipeline-crash-full-suite.tap.
README, decisions, recovery-runbook and plan-status now distinguish this joined
EVM crash campaign from the previous manually composed scripted-chain drill.

**Remaining/next.** Local joined crash behavior is now measured. Next recovery
work is independently durable transaction-signer reservation/raw-byte storage
and coordinated backup/restart controls, so currently blocked signing boundaries
can be reconciled safely. Interrupted database transactions, disk/power failures,
actual supervisor startup, production keys/Monad/lifecycle readers/finality,
longer source/load/calibration campaigns and named review remain open. This
short fixture-source campaign does not establish production availability or
complete counterpart economics. No human gate or deployment is claimed.

## 558f234 — durable local transaction-signer foundation (PF016/PF018)

Commit `558f234cb846615e9873114859c1beace9b6675f`, 04 October 2026
12:15:04 +05:30, actual message `feat: persist transaction signatures for crash recovery`.
The user committed during active work after the ten-minute reminder. This commit
contains the independent public-key transaction journal, nonce/request/raw/hash
bindings, local RPC preparation hook, relay journal identity/reconciliation and
checked PREPARING startup path, nine signer tests and the additional TX_RESERVED
kill boundary. It also retains the pre-fix regression report/log, where a signer
journal existed but PREPARING startup still failed until recovery was enabled.
Final complete verification and additional restore/demo integration are recorded
in the pending follow-up below; no later result is attributed to this earlier
commit's exact tree.

## 5a3c4d1 — transaction-journal restore guards and demo integration (PF016/PF018/PF025)

Committed 04 October 2026 at 12:30:36 +05:30, as
`feat: complete durable transaction journal integration`.
Base: `558f234cb846615e9873114859c1beace9b6675f`.
The user requested continuation of the recovery gap. Changes stay package-only
on pricefeed. Commits remain manual; reminders were supplied at ten and twenty
minutes. Actual earlier commits and their timestamps above were refreshed from
git, not invented.

**Implemented.** A separate transactions.sqlite stores a stable identity plus
each exact nonce/destination/calldata/gas/fee request before signing, then raw
transaction/hash before returning. Relay reservations now retain their original
request and pin the backend journal ID. Startup checks both complete histories;
an older relay behind independent signer history, older signer behind retained
raw bytes, changed identity, disabled/missing journal or conflicting request
blocks startup. Existing relay history cannot adopt an empty journal silently.
Added metadata-account and reservation-nonce consistency checks. Canonical
request fields are retained across retries and remain constrained by current
spend/headroom gates. Public test key and chain 31337 restrictions remain fixed.

LocalPipeline may resume PREPARING only after the independent journal has passed
relay startup reconciliation. A reserved-but-unsigned request completes the same
signature; an already signed request returns exactly the saved raw bytes. The
durable backend never broadcasts. Source times and observation sequences are
unchanged. Expired reservations still quarantine and block account-wide new
nonce allocation; lifecycle/identity/source guards still precede sending.

Added six relay/signer snapshot/admission/expiry tests using closed-database
snapshots and explicit checkpoint reconstruction for the expired TX_SIGNED case.
Nine backend tests cover exact reopen/retry, nonce conflicts across calldata/
destination/gas/fees, history mismatch, missing journal, metadata identity,
checksum corruption, a checksummed signature from the wrong key, malformed
requests and concurrent identical requests. Added test:transactions runner.
The local demo now opens/closes/reopens all five base journals; its report hashes
the transaction journal, and independent review optionally verifies that fifth
archive while remaining compatible with the older four-journal reports.

**Verification.** Final test:pipeline-crash exits 0: **eight** real SIGKILL
boundaries in LocalPipeline.run with owned Anvil, actual loopback RPC and real
ingress/store. SIGNED, PREPARING, TX_RESERVED, TX_SIGNED, UNKNOWN, BROADCAST,
MINED and FINALIZED all resume sequences 1/2 with exactly two accepted events
and two independent transaction reservations each. Parent checks null versus
saved signer raw bytes at crash, preserved requests/raw/hash, original packet/
digest/signature, exact events/price/depth and consecutive nonces. Already mined
cases broadcast only the new update after restart. Leases expire at actual host
time; no time warp or forced writer takeover is used.

`npm run test:transactions` exits 0 with **42 focused tests**. Complete npm test
exits 0 with **274 tests**, no failures/skips/cancellations/todo; these include
all fifteen new backend/restore tests and the existing 144 Fraction vectors.
Build, check:wire, test:reference and whitespace checks exit 0. The eight Anvil
boundaries are separate from 274. Pinned tool versions remain Foundry 1.8.3,
solc 0.8.30, Node 24.21.0, TypeScript 5.9.3 and viem 2.57.2. Local chain and
full CLI suite use the existing scoped external-sandbox execution permissions.

The three-second fixture-source graceful restart demo exits 0: five journals,
five immutable packets preserved, chain sequence 5 to 13, thirteen total
accepted updates and unique ordered transaction nonces. Independent archive/
Fraction replay exits 0 and correctly reports only **3/300 seconds** valid TWAP
coverage; this was a restart smoke test, not full-window readiness or a new
real-source soak. Historical genuine-source campaign evidence remains unchanged.

Evidence: artifacts/verification/pipeline-crash.json/log (current eight-case
campaign), transaction-recovery-baseline.json/log (retained failed PREPARING
regression), transaction-recovery-unit.json (274/42 counts, source/log hashes,
wire/reference and demo linkage), transaction-demo-review.json; unique demo
report artifacts/pipeline/pipeline-1791096736866-fca7e807-d987-46ec-b26d-4b85e33b9557.json.
Full/focused TAP logs remain in var/transaction-full-suite.tap and
var/transaction-focused.tap. README, decisions, plan-status and recovery runbook
now distinguish local independent journaling from production signer/backup work.
The preceding seven-case/259-test section records its earlier commit; the latest
pipeline-crash report is refreshed here, with its previous content retained in git.

**Remaining/next.** Interrupted database transactions, disk-full/permissions/
power loss and coordinated multi-journal backup/restore are the next independent
storage work. Production key/backend, real Monad/engine/lifecycle/finality
adapters, nonce replacement/cancellation policies, supervisor/monitoring,
sustained load/calibration and named review remain open. Local closed-snapshot
mismatch checks do not certify a production backup system or loss of all history.
No external transaction, economic counterpart join, gate acceptance or deployment
is claimed.

## Pending — Monad testnet read-only preflight (PF017/PF018/PF023)

Base: `5a3c4d180c5bc3a996b1c520f52ae0f0e9c94edd`.
Suggested message: `feat: add Monad testnet read-only preflight (PF018/PF023)`.
The user moved Monad integration ahead of storage/backup work, selected testnet
and reported that no deployed engine address or concrete ABI is available.
All changes stay in packages/pricefeed on pricefeed; commits remain manual.

**Implemented.** New monad-preflight.ts exposes only read methods. The CLI's
preflight-monad command takes an RPC environment-variable name and optionally
paired config/ABI files. It verifies chain 10143, a fresh finalized block and a
matching named-block hash/timestamp on re-read. With supplied engine pins, it
checks runtime code, exact ABI hash and production listing tuple shape, every
existing listing pin, configured source signer/rules/sequence/time and halted().
All engine reads use one named block. RPC exceptions become fixed diagnostic
codes; endpoint values never appear in output. Config/ABI inputs are snapshotted
before awaiting. Unsupported finalized/state reads do not fall back to latest.

The checkpoint is one-shot read evidence, not persistent lifecycle admission.
The 30-second age guard and 5-second request timeout are diagnostic settings.
No signing, sending, nonce/sequence allocation, journal creation, operational
policy admission or external deployment is added. Existing local publication,
relay, lifecycle and public-key backends still enforce chain 31337.

**Verified.** Actual public Monad testnet RPC preflight passed: chain 10143,
finalized block 68053460, hash
0xabcbfb68bbdf0f51fed5f94016547c3e716c4070a465db43a3f01615705aa2d8,
block timestamp 1791098220, checkedAtMs 1791098221700. It correctly returned
NETWORK_VERIFIED_ENGINE_NOT_CONFIGURED with zero signatures/transactions.
The sandbox request failed with MONAD_RPC_CHAIN_FAILED; the scoped read-only
network escalation succeeded. This validates connectivity, not an actual engine.

Twelve focused Monad tests pass (exit 0): network-only and engine-pin checks,
changed/wrong chain, block disagreement, stale/future/slow checkpoints, missing
or mismatched code/ABI, all listing pins, malformed/conflicting source/halt
state, fixed-code errors and read-only HTTPS restrictions. A mocked HTTP test
also exercises real viem ABI encoding/decoding with the complete production
listing, sourceState and halted layouts at the exact block. These engine replies
are fixtures, not Monad engine state. One new CLI subprocess test covers env
names, paired inputs, credential redaction and no journal creation.

Build exits 0. The final npm test TAP records **287 passing tests**, zero
failures/skips/cancellations/todo (274 previous plus thirteen new). The shell
session was unavailable after the user interrupted the turn, so its final shell
exit code was not recovered; the completed TAP counts are retained. A preceding
full run passed 286 before the final HTTP encoding test was added. Whitespace
checks passed. Evidence: artifacts/verification/monad-network.json,
monad-unit.json and var/monad-unit.tap. Older recovery/crash reports remain
historical; their source hashes are not attributed to this new CLI tree.

**Remaining/next.** Obtain the risk/deployment owner's concrete testnet engine
composition, authorized deployment address, exact ABI/build artifact and agreed
listing/source/rules dossier. The existing artifacts/risk/engine-abi.json is an
abstract interface, not a deployable contract; CombinedEngine and the local
pricefeed demo use test counterparts. No actual engine was supplied or checked.
docs/monad-testnet.md explains where the address/ABI come from, how to configure
the public or Alchemy RPC, and where to obtain test MON when sending is needed.
Then verify the deployed pins and implement testnet signer/relay, durable
lifecycle integration and finalized receipt/source-state recovery with explicit
identities, budgets and transaction authority. Q03-Q10 and human gates remain
open. Storage/backup work is deferred by the user's priority, not completed.

## Pending — durable Monad lifecycle monitor (PF017/PF019/PF023/PF025)

Base: `5a3c4d180c5bc3a996b1c520f52ae0f0e9c94edd`, following the uncommitted
Monad preflight slice above. The user requested continuation and ongoing records.
Suggested message: `feat: persist Monad testnet lifecycle monitoring (PF023)`.

**Implemented.** A read-only Monad monitor reuses the durable lifecycle
transition logic through a fixed chain-10143 wrapper. LocalLifecycle retains
its fixed chain-31337 wrapper. The concrete Monad reader repeats complete
engine preflight at one finalized block and retains source sequence/time in
its checkpoint. Config/ABI snapshots remain fixed. Halt/deadline decisions
and source progress survive journal reopen. Contradictory identity, halt or
source state quarantine; outages/stale checkpoints degrade with fixed redacted
reasons. Different source state in the same block, or changed observedAt at the
same sequence, quarantine. A newer sequence can retain its original observedAt.
No publication, signing, sending or operational admission is enabled.

New watch-monad-lifecycle CLI validates the dossier/policies before opening
an explicitly selected archive, performs serial checks on a monotonic schedule
for declared duration/interval/age inputs and drains on SIGINT/SIGTERM. It
archives before callbacks/output, exits at STOPPED/QUARANTINED, and reports exit
2 for final DEGRADED/QUARANTINED. The monitor watches engine facts, not source
books; COLLECTING here grants no publication permission or venue-data readiness.
Existing health/verify-evidence commands work with its lifecycle records.

Journal.release clears only the exact owned fenced lease, preserving its
counter; it cannot release a newer owner or let stale writers append. Controllers
refuse release during an in-flight check. The new watch CLI releases on clean
shutdown, enabling immediate new-process startup. A crash still requires the
existing lease to expire, with no forced takeover. The local pipeline does not
call the new release API. Docs explain the diagnostic boundary and restart rules.

**Verification.** Typecheck/build exit 0. npm run test:monad exits 0 with
**66 passing tests**. Full npm test exits 0 with **306 passing tests**, no
failures/skips/cancellations/todo. This is 287 previous tests plus seventeen
monitor/lease tests and two CLI tests. The focused 66 are included in 306;
144 independently derived Fraction vectors remain included, seed 20261002.
Wire-format, independent reference and whitespace checks also exit 0.

Tests cover persisted early halt through original T/later horizon, included
exact deadline and durable stop; RPC/stale recovery with redacted retained
halt; disappearing halt; source sequence/time regression across database reopen;
same-block/source-state contradictions; unchanged observedAt at a newer sequence;
identity changes; reader input snapshots; incompatible config/horizon/policy;
corrupt archives and expired writers; watch abort/outage/recovery/terminal behavior;
graceful handoff, stale release/append and in-flight release refusal.

A subprocess test runs the actual watch CLI and viem ABI encoding with scripted
HTTPS replies, reopens the same real SQLite archive in a new process, verifies
fence increment/lease release and queries health. An admission test confirms
invalid policies/missing or wrong-network dossiers do not create an archive.
No external network transaction is produced. All engine responses remain
fixtures; this does not verify an actual deployed Monad engine or elapsed soak.

Evidence: artifacts/verification/monad-lifecycle-unit.json, retained full/focused
logs var/monad-lifecycle-full.tap and var/monad-lifecycle-unit.tap. The report
records source/runner/ABI/log hashes, actual exit codes and counterpart status.
Earlier preflight/recovery reports retain their historical counts/hashes; this
new report certifies the latest TypeScript tree. The earlier 287-test shell
exit-code gap remains documented; the current full 306-test exit was captured.
No Solidity/Anvil crash campaign was rerun in this read-only monitor slice.
Changes remain package-only, on pricefeed and uncommitted for the user.

**Remaining/next.** The concrete testnet engine deployment address, exact ABI/
build artifact and listing/source/rules dossier are still missing. Run real
engine checks when supplied, then integrate an approved observation signer,
durable transaction signer, relay and finalized receipt/source-state reconciliation
against the signed journals. The new monitor must be joined at publication
boundaries after those testnet controls exist. It does not detect unknown higher
chain state against production signer history by itself. Production budgets,
closure/finality/nonce policies, source calibration, hosting/storage/backup and
named review remain open; none is approved by these diagnostic tests.

## 04 October 2026 — corrected next-step dependency audit

Reviewed project CLAUDE/spec/handoff/merge/release records, the original pricefeed
PDF, package decisions/status/Monad docs and implementation boundaries at
`85799ea`. The preceding preflight/monitor entries were written before commit;
both are now committed in `85799ea`. Their historical verification counts remain
unchanged. The untracked project atomic-task CSV was read as reference only;
its "Not started" labels do not override implementation evidence.

Corrected plan-status's stale storage-first next step: the user's priority is
real-engine testnet deployment preparation, then deployment verification and
publication integration. Documented that a real-book test composition exists,
but test helpers, open RB-I01, build/chain feasibility and initialization inputs
still need deployment-owner work. An abstract ABI is insufficient. Testnet
signing/relay/admission and signed-journal receipt reconciliation remain unbuilt;
read-only preflight/monitoring does not enable them. Adapter development can
proceed offline after interfaces/policies are fixed; actual integration requires
a deployment. PF026/PF027/PF028 release dependencies remain intact.

Next deliverable: deployment-readiness handoff with concrete artifacts, missing
listing/key/backend inputs and owner actions, following docs/plan-status.md.
This audit changes documentation only. No deployment, broadcast or runtime
change occurred; tests were not rerun. Latest recorded package suite remains
306 passing tests. Suggested commit: `docs: clarify pricefeed deployment and integration sequence`.

## 04 October 2026 — standalone pricefeed receiver deployed on Monad testnet

**Scope/authorization.** The user clarified that pricefeed completion should not
wait for CLOB economic release work, explicitly requested deployment in a
temporary folder, supplied a funded public wallet and selected browser signing.
This supersedes the earlier no-external-deployment state for this diagnostic
receiver. Shared contracts/deployment configs and human gate records were not
edited. Work stayed on pricefeed; user commits manually.

**Built and deployed.** `/tmp/eros-pricefeed-monad` contains the standalone
PricefeedTestnetReceiver and unchanged snapshots of real Eros ingress/store and
dependencies. It authenticates the same signed observation domain/fields,
retains index history/TWAP and exposes the full listing tuple/source state/halt
reads required by current preflight. It has no trading/custody/oracle economics.
Owner-only irreversible diagnostic halt and scheduled T leave recording available.
Constructor limits it to chain 10143 and validates identities/depth/horizon.

The user signed creation through the localhost MetaMask/Rabby page; no deployer
private key was accessed. A separate testnet observation signer was generated
and encrypted in owner-only temporary files, excluded from public artifacts and
HTTP routes. Its backend/durable key custody are still integration work.

Receiver: `0xd2d82fed32fb9a911300e7d928607755bd101773`.
Transaction: `0xd3d23d6a6c301ebe79431987d900690ea623ad1dddf6364bd234664def2a77ea`.
Source signer: `0xF26e7995D8421A8cd16Af704C360c7928F76bb8e`.
The receiver uses existing diagnostic politics mapping/rules, a new market domain
and seven-day test deadline; this is not approved source/event equivalence.

**Verification.** Pinned Foundry 1.8.3, solc 0.8.30, optimizer 200, Prague,
network=monad. Ten separate receiver tests pass, command exit 0. An initial test
run had two test-order failures because signature computation called a view
after expectRevert; signatures were computed first and the full rerun passed.
Tests cover listing/source pins, authentic exact acceptance event, replay,
wrong signer/chain/receiver/rules, mutation, future/backward time, complete
300-second TWAP, zero invalid checkpoints, 30-second gap carry, owner-only
irreversible halt/continued recording, scheduled halt and constructor rejection.

Real public testnet RPC estimated 2,093,134 deployment gas. The submitted limit
was 2,511,761; actual charged gas at 102 gwei cost 0.256199622 test MON. The
successful receipt is finalized/canonical. Verified exact deployment input,
sender/nonce-derived address, compiled runtime including immutable owner,
owner/kind, complete listing/source pins and actual preflight. Runtime 7,646
bytes; creation bytecode 8,838 bytes. Source state was sequence 0/time 0.
The existing watch CLI then ran 16 seconds against the real receiver: exit 0,
four COLLECTING checkpoints, valid persistent journal and clean completion.
This is chain-monitor health, not source freshness or publication permission.
Local page route/host/token checks and JS syntax checks passed. No observation
was signed/submitted; one external contract-creation transaction was user-signed.

**Records/next.** Public build/source/ABI/config/rules/receipt/preflight/monitor
evidence retained under artifacts/monad-testnet; secrets remain private in /tmp.
Updated decisions, Monad setup and plan-status to make testnet signer/relay/
receipt recovery the immediate next work, with a separate unattended sender
backend and durable private signer custody. Local chain-31337 restrictions and
production admission remain unchanged. No full-engine deployment, production
mapping/calibration or human acceptance is claimed. Package TypeScript was not
changed and its 306-test suite was not rerun; the ten receiver tests are separate.
Suggested commit: `feat: record verified Monad pricefeed receiver deployment`.

## Pending — 04 October 2026: diagnostic Monad publication and live restart

Base: `85799ea` on `pricefeed`; includes the preceding uncommitted receiver
deployment records. User funded the automatic sender and instructed continuing
the pricefeed plan. No shared risk/CLOB/oracle/engine source was edited.

**Result.** The bot now fetches authentic Polymarket books, computes prices,
signs observations, sends transactions to the deployed standalone receiver and
verifies finalized acceptance on Monad testnet. Two observations finalized,
the process exited, then a new process reopened the same journals and finalized
the third. Sequence/nonce pairs were 1/0, 2/1 and 3/2. Earlier packet bytes,
signatures and raw transactions were unchanged after restart. Finalized source
state equals sequence 3 and its real observedAt. This is an actual external
diagnostic join, with real ingress/store and no full trading engine.

**Implementation.** Extracted existing durable local mechanics into shared
cores with fixed-chain public wrappers; existing Local APIs remain 31337-only.
Added explicit 10143 observation/transaction signers, HTTPS RPC adapter,
publication lifecycle controller, testnet relay/pipeline and finite
`serve-monad-testnet` CLI. Separate encrypted private keys are in ignored
owner-only `var/monad-testnet/keys/`; private material was not exposed or committed.
The browser deployer remains separate from the automatic sender.

The service uses five persistent journals for source evidence, packets,
observation signing, transaction signing and relay. It checks concrete
receiver/listing/rules/code pins, exact raw signatures/calls, gas/fee ceilings,
source age and lifecycle gates before signing/reservation/sending. Canonical
finalized blocks drive receipt confirmation. Uncertain send retries retain
the same bytes/nonce. Restored signing-history mismatches and unknown higher
source state persistently quarantine. Clean shutdown releases only owned leases.
The testnet spend policy is pinned and counted across restarts; exhausted
budget cannot allocate a fourth packet. Missing/closed/stale source still emits
no fabricated sample; fresh invalid-depth policy preserves real time/depth.

**Actual pilot.** Sender `0x1D7a477FDEaeb7c93E58cd1870e3B35eE4a7d071`
was funded with 0.6 test MON. Three-transaction reservation cap: 0.36 test MON;
per-transaction cap: 0.12. Actual cost **0.2448 test MON**, three times 800,000
charged gas at 102 gwei. Accepted midpoint prices were 0.633371815,
0.633371815 and 0.633158895; all three had valid two-sided depth.

- Sequence 1: `0x34a68a4dbe45f22a3ad3e03a220e4df30edaf6507acd09e5ab1410544abd981a`.
- Sequence 2: `0x01e811955edd9e282ef500dd16f1a4a57c89c981283a93c2d381814dd75e71c9`.
- Sequence 3 after restart: `0x0c089ebea85e3bfc5bc80d391680c7f4295261833ea9ac98374b849a1a985141`.

Both live CLI runs and read-only verification exited 0. Exact accepted event,
canonical finalized block, source state, recovered observation/transaction
signer, transaction hash/nonce/chain/value and actual cost were checked.
Independent Python Fraction review matched prices/depths to original archived
books and verified source times/checksums. Public records:
`artifacts/monad-testnet/publication-pilot.json` (raw captures/receipts/restart),
`publication-fraction-review.json` and `publication-policy.json`.
Private closed journals remain under `var/monad-testnet/pilot/`.

**Checks and failures.** Build passes. Full package suite **318/318**, exit 0;
focused `test:monad-publication` **12/12**, exit 0, included in 318. The first
sandboxed full suite failed twelve CLI tests because spawnSync was blocked with
EPERM; it did not justify changing test expectations. The unrestricted rerun
passed. Eight joined owned-Anvil SIGKILL recovery paths passed, exit 0. Wire
check and 144 Fraction vectors (seed 20261002) passed, exit 0. The ten receiver
Solidity tests are separate. Retained TAP/source hashes are in
`artifacts/verification/monad-publication-unit.json`; rerun crash evidence is
in `pipeline-crash.json`/log. Read-only evidence scripts were compiled and run
after the full suite; no publication behavior changed afterward.

**Next according to the plan.** Complete the sustained-feed proof before
hosting work: measure/tighten gas limits and actual submission cadence, prepare
an explicitly bounded campaign retaining existing signed history, then verify
full 300-second TWAP coverage and invalid/gap recovery. The pilot's budget is
exhausted; preserve journals and its immutable policy. Its three samples and
restart interval do not establish sustained coverage. Follow with category
calibration/soaks, supervisor/backup/alerts and reviewed handoff. Testnet mapping,
provider semantics, operating policy and production release remain unapproved;
no PF gate acceptance or full-engine join is claimed.

Suggested commit: `feat: integrate Monad testnet pricefeed publication and restart`.

### Branch workflow clarification — 04 October 2026

User will continue local work on `pricefeed`, keep it updated with `origin/main`,
and create/push remote `feat/pricefeed` themselves.
Fetched origin branches; main advanced to `5f8e8a4`. Simulated merges against
main, integration/risk, feat/clob, feat/oracle and feat/risk all passed without
conflicts for both committed HEAD and a temporary snapshot including uncommitted
work. Main has 33 commits absent from local pricefeed, which has 25 commits
absent from main. No merge, branch switch or push was performed. Incorporating
main is still pending; current working changes must be preserved.

## Pending — 04 October 2026: measured Monad gas sizing and cost capacity

Base: `a373a64` on `pricefeed`. User authorized gas optimization and the next
useful plan tasks. Changes remain within `packages/pricefeed/`; no push or
shared engine/book/oracle changes were made.

**What changed.** Added exact-call gas estimates, integer upward-rounded safety
margins and a second simulation at the selected limit before nonce reservation.
The diagnostic policy accepts a pinned `gasSafetyMarginBps`; the quote uses
1000 bps (10%). Missing/invalid estimates, margin/cap failures and selected-limit
simulation failures reserve no transaction nonce. Initial estimate/margin/limit
are archived. Retries and process restarts preserve the original gas limit and
raw transaction even when a later estimate differs. Historical policies omitting
the field remain compatible; their persisted budget is not silently changed.

Added `quote-monad-gas`: on an idle journal set, it checks finalized receiver
pins and known signed history, fetches authentic source evidence, signs one
durable quote-only observation, simulates twice and expires it. It does not
construct the transaction signer or call broadcast. Added integer-only capacity
planning, a reproducible cost report and independent Python Fraction/source-time/
journal/integer-cost review. Strengthened the fixture to distinguish observation
sequence from transaction nonce across a skipped quote and two later restarts.

**Real measured result.** Fresh politics observation sequence 4 estimated
**179,266 gas**, selecting **197,193 gas** with 10% margin. Both actual testnet RPC
simulations passed. Selected limit is **75.35% lower** than the pilot's 800,000.
At the pilot's historical 102 gwei this implies **0.020113686 test MON/update**;
at the 150 gwei fee ceiling, **0.02957895**. No optimized paid receipt or approved
operating margin is claimed. Actual source time/depth/price match independent
Fraction replay. Quote packet 4 is durably EXPIRED; next observation may use
sequence 5. Sender nonce remained 3, finalized receiver sequence remained 3,
and measured balance was 0.3552 test MON. **Zero external transactions**, zero
transaction reservations. Relay and transaction journal file hashes are unchanged.

**Evidence preserved.** Copied the closed original five journals to private
`var/monad-testnet/pilot-evidence/` before quoting; all original file hashes match.
Only the public pilot report's archive location/preservation metadata changed;
its captures, packets, receipts, signatures and original costs remain intact.
The original active journals continue under `var/monad-testnet/pilot/`; the signer
history was not forked into another active publisher. Frozen pilot Fraction review
still passes. Public quote/policy/review/cost files are under `artifacts/monad-testnet/`.

**Next campaign prepared, not activated.** The six-minute five-second diagnostic
proposal has 72 nominal submissions: estimated **1.448185392 MON** at the
historical price or **2.1296844 MON** reserved at the quote limit/maximum fee.
Proposal allows at most 84 additional transactions and **2.772 MON** additional
aggregate reservations; historical 0.36 reservations remain counted, yielding
a proposed lifetime **87 transactions / 3.132 MON** cap. If gas rises, fewer
transactions can fit; the envelope is not 84 times the per-transaction cap.
Measured funding gap is **2.4168 MON**, with **2.5 test MON** suggested as a
future top-up. No funding, policy transition or spend increase was performed.
The unchanged historical gas ceiling permits reconciliation of old signed
requests; each new request still uses its verified buffered estimate.

The immediate next work is an auditable, tested transition of the idle relay's
pinned policy/budget preserving reservations and both signing journals. Then
fund/authorize the finite campaign, recheck live state and measure actual charged
cost/cadence plus full 300-second coverage at a named finalized block. Invalid/gap
and restart behavior, category calibration and operations/review still remain.
The five-second scenario still costs about **347.56 MON/market/day** at the
historical price, so production market count and cadence need explicit economics.

**Verification.** Full package suite **324/324**, exit 0. Final focused
`npm run test:gas` **16/16**, exit 0, included in 324. Wire check, reproducible
cost report, independent gas/source review and preserved pilot review exit 0.
Retained TAP/log/file hashes: `artifacts/verification/monad-gas-unit.json`.
An initial quote fixture failed because its config field order did not match
the canonical config digest; the fixture now uses `parseConfig`. Strengthening
the nonce fixture initially exposed a TypeScript optional-nonce type error;
the signed-transaction fixture guard was corrected before rerunning the checks.
Earlier crash/engine/144-vector campaigns retain their historical evidence;
they were not rerun for this gas/cost batch. No production admission or human
gate acceptance is claimed.

Suggested commit: `fix: estimate Monad publication gas and record feed cost budgets`.

## Pending — 04 October 2026: auditable budget renewal; small paid run prepared

Base: `c909e0d` on `pricefeed`. User continued the gas-cost work and confirmed
that their 1.6 test MON remains in the browser wallet. All changes remain within
`packages/pricefeed/`; no push or shared engine/book/oracle change.

**Built.** Added read-only `plan-monad-budget` and exact-plan-hash
`apply-monad-budget`. The transition preserves both signing histories, observation
sequence, sender nonce, original deliveries and all historical spend reservations.
It verifies canonical finalized receipts, receiver/source pins, signatures/raw
transactions, signer identity, exact journal snapshot, idle leases and current
funding. Application locks all five journals and atomically changes only the relay
profile plus a checksum-linked revision audit. Duplicate application is idempotent;
a changed approval, active writer, insufficient funds, chain/journal disagreement,
missing/tampered audit or stale cached publisher rejects. Policy renewal cannot
change signing identities or existing fee/gas ceilings; it can enable the verified
estimate margin and explicitly increase count/aggregate reservation caps.

**Prepared, not activated.** Read-only actual RPC checks verified all three old
receipts, receiver sequence 3 and sender nonce 3. Bot balance remains **0.3552 MON**.
`small-run-budget-plan.json` proposes **eight additional transactions / 0.35 MON
additional reservations**, with lifetime caps 11 transactions / 0.71 MON counting
historical 0.36 reservations. Funding gap is zero; browser funds can stay put for
this small test. Plan hash is
`5b528fe69c721fc1f860dd631277ab247450c5d3ce42b77824726a9213fb00df`.
This is not approval: original three-transaction authority is exhausted. No policy
application, additional signature, nonce reservation or chain transaction occurred.
The next action is approval/application of this envelope and actual paid gas
measurement, then sizing/funding/approval of sustained 300-second coverage.

**Evidence.** Before any active-history transition, froze the closed quote journals
at private `var/monad-testnet/gas-quote-evidence/`; all five original hashes match
the public manifest. Independent quote review now reads that frozen snapshot,
remaining reproducible when active history advances. Frozen original pilot
history remains separate and intact. No alternative active signing history exists.

**Verification.** Full package suite **329/329**, exit 0; focused gas/publication/
service suite **21/21**, exit 0, included in 329. Five new renewal tests verify
history/nonce continuation, exact approval/rollback, audit integrity, stale profiles,
all-five-journal writer exclusion, idempotence and consecutive revisions. Independent
preserved gas-quote review passes. Retained TAP and tested file hashes:
`artifacts/verification/monad-budget-unit.json`. An initial build exposed an
implicit-any delivery list, corrected with explicit typing. An initial rejection
fixture used an invalid gas/fee combination and reached policy validation first;
the fixture now uses a valid out-of-scope gas ceiling. Final checks pass without
weakening validation. Earlier owned-chain crash/Solidity/Fraction campaigns were
not rerun for this batch and retain their historical evidence.

Eight additional samples will measure paid gas, not full 300-second coverage.
Sustained coverage, invalid/gap recovery, category calibration and approved
operations/review remain. Production admission and human gates remain closed.

Suggested commit: `feat: add audited Monad pricefeed budget renewal`.

**Approved-run outcome (same milestone).** User approved the exact eight-update /
0.35 MON cap. Applying revision 1 succeeded with unchanged signed history,
historical reservations, receiver sequence 3 and sender nonce 3; application sent
nothing. The finite publisher exited **1** with `RELAY_HEADROOM_EXPIRED` before
broadcast. Sequence 5 expired unreserved. Sequence 6 signed/reserved nonce 3,
selected gas **197,166** from estimate **179,241**, then persisted QUARANTINED,
attempts **0**. New reservation **0.0295749 MON** remains counted; additional
reservation room is **0.3204251 MON**. The live pending/finalized nonce is still 3,
receiver sequence still 3, no receipt exists, balance still **0.3552 MON**.
**Zero additional transactions / zero gas paid.** Local next nonce is correctly 4;
no nonce reset, force-send or replacement was performed.

Frozen the closed five journals at private
`var/monad-testnet/stopped-small-run-evidence/`. Independently verified checksums,
unchanged original packets/signatures/raw transactions, authentic sequence-6
raw-book Fraction price/depth and zero recorded broadcast attempts. Public outcome:
`artifacts/monad-testnet/stopped-small-run.json`; successful application record:
`small-run-budget-application.json`. Retained failure logs are under verification.
The failed run is not optimized paid-gas or sustained-coverage evidence.

**Latency correction and next work.** Source 6 was already six seconds old when
built, and serial RPC gates consumed the remaining publication headroom. Final
canonical-block and chain-ID checks now run concurrently, retaining both checks,
fixed error precedence and named-block/freshness validation. Added a barrier test
for actual concurrency, completion and failure precedence. Prepared read-only
receipt-cost/Fraction/TWAP report scripts for a later finalized optimized run;
they compile but have no live optimized receipts to review yet. Their first build
caught a sender string/Hex typing issue, corrected before the successful build.
The next required work is explicit tested recovery/cancellation of the signed,
never-broadcast nonce, preserving both transactions and cumulative budgets; then
resume the approved cap. Routine restart is intentionally blocked. No extra
funding is currently needed, and source-age validation remains unchanged.

**Final verification after latency correction.** Full suite **330/330**, exit 0,
zero failed/skipped/cancelled/todo; the earlier focused 21 is included in 330.
Frozen pilot and gas-quote reviews still pass after the active journals advanced.
Receipt report TypeScript builds and the independent report Python parses; neither
has optimized live receipts yet, so no report execution success is claimed.
Latest tested file hashes/TAP/outcome metadata:
`artifacts/verification/monad-budget-latency-unit.json`.

Suggested commit: `feat: add audited Monad pricefeed budget renewal`.

## Completed — 04 October 2026: explicit nonce recovery and paid gas savings

Base: `80032eb` on `pricefeed`. User instructed recovery and completion. Reused
only the existing keys/journals and approved 0.35 MON envelope. Changes stay
inside `packages/pricefeed/`; no push or shared component change.

**Built and verified recovery.** Added `recover-monad-nonce`, constrained to the
latest expired, signed but never-broadcast price reservation. It pins exact old
hash/nonce, signer journal identity, current policy, idle leases, canonical known
history and chain nonce. It signs only a 21,000-gas, zero-value, empty-data self
transaction on testnet; no arbitrary transfer/call/signing route. Original price
request/raw bytes/signature remain unchanged. Cancellation request/raw bytes and
uncertain send attempts are durable; retries use identical bytes. Canonical
finalized success marks only the original delivery CANCELLED. Publisher startup
verifies recovery signatures/receipts/finality and skips that price. Unknown,
missing/corrupt or noncanonical recovery evidence blocks startup. Both abandoned
price and cancellation reservations/counts stay charged to the cumulative cap.
Audited future budget renewal now reconciles cancelled history as well.

Removed one duplicate pre-sign lifecycle read only across the synchronous builder
path within 50 ms and the same whole second. Delays/time boundaries still recheck;
post-signing, pre-reservation and pre-broadcast gates are unchanged. Source age,
receiver/source/listing/ABI/code pins and spend limits were not loosened.

**Actual chain result.** Zero-value cancellation nonce **3** finalized in block
**68167766**, hash
`0x8d7958cb431e51f9010d2131d485fd4e053062d3e7404e932230fecf296688f8`,
charging **0.002142 MON**. Then six authentic prices **sequences 7–12 / nonces 4–9**
finalized. Gas limits **197,059–197,180**; total price cost **0.120617754 MON**,
average **0.020102959 MON**, **75.36% below** the original 0.0816/update.
All new charged gas including cancellation: **0.122759754 MON**. Additional
reservations including abandoned request/cancellation: **0.21010395 MON**, within
approved **0.35 MON**. Lifetime conservative reservation count **11** is exhausted;
no extra transaction, nonce reuse, journal reset or budget increase occurred.

The resumed service exited **0**, nine finalized prices total. A separate cold
process reopened the same five journals and exited **0** at target nine, sending
nothing. Every stored packet/signature/request/raw transaction/receipt matched.
Original pilot and quote evidence still independently pass their frozen reviews.
Closed optimized journals are frozen under private
`var/monad-testnet/optimized-run-evidence/`; active history remains unchanged in
location, with final source sequence 12 and next sender nonce 10.

**Independent proof.** Read-only verifier checks exact signed requests, canonical
finalized accepted logs, cancellation scope/receipt, gas margin and charged cost.
Python independently replays authentic raw books with Fraction, source times,
depths/invalidity, integer gas/cap arithmetic and the 300-second segment integral.
At named block **68169207** / timestamp **1791133182**, coverage is **134/300**,
`available: false`. This short stopped test does not prove sustained coverage.
Acceptance intervals **20/18/17/23/28 seconds**, source ages at acceptance **12–20
seconds**, remain diagnostic. Public evidence: `nonce-recovery.json`,
`optimized-small-run.json`, `optimized-small-run-review.json`,
`optimized-restart-review.json` under `artifacts/monad-testnet/`.

**Verification.** Final full compiled suite **336/336**, exit 0; latest focused
`npm run test:gas` **27/27**, exit 0, included in 336. Five new recovery tests cover
history/nonce continuation, cumulative count caps, uncertain-send immutable retry,
invalid limits/identities/active writers/already-attempted sends, missing finalized
proof and rewritten signer pins. One new gate-reuse test retains all later gates.
The preceding full 335 run passed before the final signer-pin strengthening/test;
336 verifies the final sources. Build, real receipt report, independent optimized
Fraction/TWAP review, frozen pilot and quote reviews all pass. Retained tested file
hashes/TAP/logs: `artifacts/verification/monad-nonce-recovery-unit.json`.
Early fixtures used a one-millisecond receipt timeout or changed a mock block's
timestamp without advancing it; fixtures were corrected rather than relaxing
recovery/finality checks. A misplaced gate timestamp caused an initial TypeScript
scope error and was corrected before the passing runs. Earlier owned-chain
crash/Solidity/category campaigns were not rerun for this milestone.

**Next according to the plan.** Recovery and the bounded paid-gas test are done.
Next renew/fund/authorize a sustained campaign using actual cost/cadence, prove
full 300-second coverage plus invalid/gap behavior, then category calibration and
supervisor/backup/hosting/alerts/review. General already-broadcast replacement,
production policies/listing/operating inputs and human gate acceptance remain open.

Suggested commit: `feat: recover expired Monad nonce within feed budget`.

**Final state check.** Read-only pinned Monad preflight confirms receiver source
sequence **12**, pending sender nonce **10** and remaining bot balance
**0.232440246 MON**. No new transaction was sent during verification. Public
record: `artifacts/monad-testnet/optimized-final-state.json`. All edited/untracked
files remain inside `packages/pricefeed/`; `git diff --check` passes. No push.

## 04 October 2026 — sustained Monad coverage campaign prepared

**Requested next step.** User requested the next planned milestone: a real
300-second Monad window, deliberate publication gap and recovery. Base commit
`80032eb`, alongside the existing pending nonce-recovery milestone. Preparation
does not claim the actual sustained test has passed.

**Built.** A read-only named-block capture command validates current and historical
runtime/ABI/listing/source pins, finalized height and canonical block hash before
reading `indexTwap300` at that block's actual timestamp. The sustained verifier
checks a closed five-journal archive, the applied budget audit, observation and
transaction signatures, canonical receipts, cancellation proofs, original signed
history and exact gas/cap arithmetic. It retains candidate receipt windows,
including failures. Separate bigint and independent Python/Fraction replays
filter by receipt block before same-second replacement, preventing a later valid
or invalid sample from rewriting a historical window. Required phases are full
initial coverage, unavailable gap with unchanged source progress, and a full
window built after restart. Failed requirements are recorded and exit nonzero.
Real invalid books retain the selected zero-price policy; no artificial source
book is submitted to manufacture live invalid evidence.

**Concrete finite proposal.** `coverage-proposal.json` and `coverage-policy.json`
allow at most **44 additional reservations**, including any cancellation, and
**1.35 MON total remaining reservation allowance**. Two publication phases each
have a 600-second duration cap / at most 22 new finalized prices, separated by
at least 60 seconds stopped. Both reuse the existing keys and active journals.
The maximum count is not a guaranteed coverage outcome; failed phases stop
without increasing limits. At the measured six-price average, 44 paid prices
would cost about **0.884530196 MON**, subject to gas/fee changes.

The exact lifetime cap becomes **1.92010395 MON** at revision **2** / count **55**:
historical reservations 0.57010395 plus the new 1.35 envelope. The policy ceiling
increase is only **1.21010395 MON**, since the old ceiling had 0.13989605 unused.
The remaining envelope is capped at 1.35, not 1.35 plus that old unused allowance.

**Read-only live checks.** `coverage-budget-plan.json` verifies the idle history,
source sequence **12**, pending sender nonce **10**, and balance
**0.232440246 MON**. Funding gap: **1.117559754 MON**; suggested browser-wallet
transfer **1.15 test MON** to the existing sender. Plan approval hash:
`1156fe89042918b4d1c5d194fc9ca625b6b3ac56e133d086f9df665bc0efd904`.
`coverage-preparation-review.json` independently checks the plan hash and unchanged
active journal snapshot. **No budget application, new signature or transaction**
occurred. The prior eight-slot authorization is exhausted; this new concrete
envelope requires user approval and funding before execution.

**Verification.** Build exit 0. Full compiled Node suite **341/341**, no failures,
skips or cancellations, exit 0; five new coverage cases are included. Independent
Python reference suite **4/4**, exit 0, verifies hand-derived windows and reproduces
the historical real **134/300** unavailable result. First sandboxed full attempt
failed in existing CLI subprocess fixtures; the identical compiled suite passed
with approved local fixture access. Failed TAP is retained separately. Tested
source/report hashes and results are in
`artifacts/verification/monad-coverage-preparation-unit.json`. No additional
Forge, owned-chain crash or category soak campaign was run for this preparation.

**Still pending.** Fund/approve/apply the exact finite plan, run and retain both
full windows plus the intervening gap, freeze the new archive, and execute the
canonical receipt and independent Fraction phase review. Named-block capture and
the complete sustained verifier compile, but their actual new campaign execution
remains unverified. Follow with category calibration, remaining recovery/custody
work and supervisor/backup/hosting/alerts/review. Docs/plan-status and the Monad
runbook reflect this distinction. No commits or pushes were made.

Suggested preparation commit: `test: prepare sustained Monad coverage and gap recovery`.
After the real proof passes: `test: verify sustained Monad coverage and gap recovery`.

## 04 October 2026 — coverage authorization and funding check

User replied **“proceed”** to the concrete 44-reservation / 1.35 test MON capped
request. This authorizes that exact finite diagnostic; no repeat approval is
needed within those limits. Public record: `coverage-authorization.json`, binding
the same budget plan hash. Base now `0e42823` on the existing pricefeed branch.

Fresh read-only finalized preflight confirms receiver pins, source sequence 12,
sender nonce 10 and balance **0.232440246 MON**. The needed transfer has **not**
arrived: remaining funding gap **1.117559754 MON**, suggested top-up **1.15 test
MON**. Public record: `coverage-funding-check.json`. The user was asked to transfer
to the existing sender and provide the public transaction hash or funding status.
The approved cap is not activated before the full remaining envelope is funded.

The prepared named-block capture was actually run against block **68169207**.
Runtime/listing/source/finality/canonical checks pass and the live contract view
matches the preserved **134/300** window and integral **83147000000000000000**
exactly. Evidence: `coverage-historical-read-check.json` and
`coverage-historical-read-review.json`; command exit 0. This verifies the reader,
not a new complete window. Exact plan hash and active journal fingerprint also
still match. No source-code change, new signature, nonce reservation, budget
application or transaction occurred; no test suite rerun was needed for these
read-only checks and documentation records.

Next: once funding arrives, recheck balance and apply the already approved exact
plan, run the initial full window, deliberate stopped interval and recovered full
window, then freeze/review receipts and costs. No commit or push performed.

## 04 October 2026 — funded reduced coverage campaign started

User reported funding complete. Fresh pinned preflight verifies the transfer was
**1 MON**, bringing the bot balance to **1.232440246 MON** at source sequence 12 /
nonce 10. The originally suggested 1.15 transfer was not received in full. Rather
than requiring another transfer, the campaign is narrowed within the user's
existing maximum approval: **1.20 MON** total remaining reservation envelope,
at most 44 additional reservation slots, with actual price targets **20 per
phase / 40 total**. Duration caps remain 600 seconds per phase and stopped gap
at least 60 seconds. Gas/fee ceilings and all keys/journals stay the same.

Original exact policy/plan are preserved as `coverage-policy-original.json` and
`coverage-budget-plan-original.json`; the original `coverage-proposal.json` is
historical. `coverage-funded-proposal.json` records the smaller funded plan.
Lifetime reservation ceiling: **1.77010395 MON**, revision 2 / count 55. The exact
funded plan hash is
`78f981cab2df863f211dbab9204d49626078969ec0a0368666afa9479032bd17`.
Its live proof has zero funding gap and unchanged idle signing history. Audited
atomic application exits 0 and sends zero transactions; evidence is retained in
`coverage-funded-check.json`, `coverage-budget-plan.json` and
`coverage-budget-application.json`. `coverage-authorization.json` records that
this smaller envelope falls within the user's approved 1.35 maximum.

The first actual live phase is running with lifetime finalized-price target 29
(existing 9 plus 20), duration cap 600 and `--initialize false`. Its stdout/stderr
are retained under `artifacts/verification/monad-coverage-initial-live.*`.
No full-window result is claimed yet; a source timestamp interval of 39 seconds
is being retained as a real missing-coverage interval, not filled or retimestamped.
The exact completed outcome, paid costs and gap/restart proof will follow here.

## 05 October 2026 — initial coverage failed; timing fix tested, retry prepared

**Actual paid outcome.** The initial process completed its 20-new-price target
(29 lifetime finalized prices), exit 0 with valid archive evidence. Sequences
13–36 include four signed but unreserved expired packets; accepted nonces are
10–29. New actual gas **0.404203764 MON**, new conservative reservations
**0.5944173 MON**. Block **68183973**, timestamp **1791137641**, returns
**268/300 seconds**, unavailable, integral **168170000000000000000**. Canonical
receipts, real-source Fraction math, signatures/raw bytes, previous history and
the closed five-journal archive all verify. Coverage remains failed: the canonical
verifier and independent initial-only reviewer exit **2**. No gap/recovery phase
or further paid attempt ran. Public failed reports and the owner-only
`coverage-initial-evidence/` snapshot remain retained without resetting history.

**Timing issue and fix.** The original per-worker callback waited on RPC reads
before collecting again; repeated/old source clocks and intervals above 30 seconds
created real uncovered segments. A free 150-second probe retained 30 complete
REST books / 57 WebSocket frames with zero transport errors and no signing or
transactions. Incremental frames are diagnostic only; stream reconstruction
remains its planned milestone. `SourceSnapshotBuffer` now lets the existing
archiving collector run independently, exposing only a cloned latest result from
the same worker/config. After receipt/lifecycle reads the publisher reselects and
recomputes a complete raw book, without changing vendor clocks or already-signed
retry packets. Missing/degraded/quarantined/foreign data fails closed. Shutdown
drains both loops before releasing the source lease. Testnet collection remains
five seconds; the separate publication scheduler uses a nominal twenty seconds.
This setting is diagnostic, not production cadence/coalescing approval or a claim
that all live windows will succeed.

**Verification.** Build exit 0; complete compiled Node suite **349/349**, no
failures/skips/cancellations, including latest-book selection after delayed chain
reads, lifecycle refresh, unsafe binding/cadence, degraded data and collector
drain cases. Focused suite **33/33**. Independent coverage reference **5/5**, exit
0, includes authentic failed 268/300 and historical 134/300. Wire check exit 0.
The independent actual initial-only archive review reran with the expected exit
2 (valid evidence, failed coverage). Initial new-test failures and the first full
suite's four clock/block fixture failures are retained separately; the test
fixture now gives canonical blocks immutable timestamps and advances its height
when deliberately advancing time. Final passing TAP/source hashes are recorded
under `artifacts/verification/monad-coverage-source-fix-*`. No new Forge, owned-chain
crash, category soak or live publication pass is claimed.

**Concrete retry, not activated.** Read-only proof verifies source 36 / nonce 30,
balance **0.828236482 MON** and all active journals byte-identical to the closed
initial archive. Active policy has only **24 slots / 0.6055827 MON** left.
`coverage-retry-proposal.json`, policy and hashed budget plan prepare at most
**38 further reservations / 1.13 MON remaining cap**, including at most 17 prices
per phase / 34 prices plus four recovery slots. Phase targets 46 then 63, duration
600 seconds each, stopped gap at least 60 seconds. Lifetime revision 3 would cap
count at 69 and reservations at **2.29452125 MON**. This exceeds the original
44-slot / 1.35 MON campaign approval by **14 slots / 0.3744173 MON**, so it needs
new explicit authorization; no budget application or key unlock occurred.
Funding gap **0.301763518 MON**, suggested top-up **0.35 test MON**. Estimated
34-price charge at the latest measured average: **0.6871463988 MON**; not a promise.
Plan hash `46cd1f57466a685e172f223925b991b71bf1cac48fa3b218c923967b6a5ca07a`.
The independent preparation review validates hash/arithmetic and unchanged
journals. Separate `--retry` evidence paths preserve the failed original campaign
and bind retry verification to its own policy and baseline. Fresh chain/funding
checks remain required before applying or running.

**Commit tracking.** User requested only the original nine remaining milestones,
with a commit message when each is actually complete. Current milestone is
**2 — sustained Monad coverage and gap recovery**, still open; this fix and failed
evidence stay within that milestone. No extra preparation/record-only commit
message is offered. No commit, branch switch or push was performed; no change
was made to decisions.md. Next: get the finite retry authorization/funding, verify
both complete windows and gap recovery, then report that milestone's commit message.

The exact retry approval was requested after completing local fixes, verification,
read-only proof and the reviewable proposal. Until that reply and funding arrive,
the bot stays stopped and revision 2 remains active. No additional spending is
authorized by a general continue message sent before the new cap was presented.

## 05 October 2026 — coverage proof deferred by user; discovery next

User asked to move forward and remember the current issue. Treat the paid full
window/gap proof as **deferred**, not passed or approved for another paid retry.
Keep the authentic 268/300 failure, tested timing fix, proposal and original
spend limits. Revision 3 stays inactive and the bot stays stopped. Required before
coverage milestone 2 can close: authorize/fund a finite retry and independently
verify both full windows plus gap/restart. Revisit it after the other component
milestones; deferral does not establish production readiness.

Continue original milestone **3: market discovery and metadata validation**,
covering bounded provider pagination, category-tag candidates, exact outcome/token
identity and explicit unsupported/null/negative-risk metadata. Discovery is read
only and never auto-enables workers. No additional milestone or paid transaction
is introduced. Work stays on pricefeed; manual commit messages are offered only
for completed milestones. Existing uncommitted coverage work is preserved.

## 05 October 2026 — milestone 3: discovery and metadata validation complete

**Built.** `discover-markets` resolves an explicit tag slug and performs bounded
Gamma keyset pagination, maintaining the filter and URL-encoding opaque cursors.
Limits and duplicate event/market/condition/token checks fail closed; incomplete
scans report their remaining cursor. Candidates retain both original outcome
labels/token IDs and raw response evidence, choose no YES outcome and remain
disabled/unapproved. Missing/null/schema-invalid fields, non-binary mappings,
negative-risk/augmented/Other flags, unknown trading status, incomplete rules,
invalid UTC/calendar dates and unverified tag membership produce explicit
rejection reasons. Source endDate never overwrites Eros scheduledT. No risk,
oracle, CLOB, factory or contract change was made.

Metadata identity now shares the strict outcome parser and validates known
field types and duplicate/conflicting event membership. A failed cache refresh
clears the previous healthy interpretation and retries validation before another
book can be healthy. Rules changes quarantine before another book fetch. Separate
persisted status evidence quarantines changed trading/negative-risk flags and
does not silently reopen after restart. Old-format histories derive their status
baseline from retained raw bytes; original capture/sequence/signing history and
the existing rules-digest encoding stay unchanged. The joined early-halt fixture
now checks this explicit source quarantine while preserving RECORD_ONLY, archived
closure and no extra/final-price submissions. Engine lifecycle stays separate.

**Actual source checks.** Three CLI runs, each `--page-size 2 --max-pages 2`, exit
0: sports tag 1 / 123 candidates, politics tag 2 / 14 candidates, crypto tag 21 /
23 candidates. All 160 remain BLOCKED with recorded reasons, including incomplete
structured rules, closed markets and negative-risk flags. All scans are incomplete
at the declared page bound; these batches do not establish complete inventory,
eligible mappings, source suitability or calibration. Raw bodies and SHA records
are retained in `artifacts/discovery/*-live.json`. Independent Python review
checks original page bytes, cursor/filter continuity, IDs/tokens, source fields,
all disabled flags and rejection reasons; `live-review.json` passes all three.
The Python HTTP probe initially received 403; the bot's normal Node transport
then succeeded without proxying, header spoofing or restriction bypass. Official
documentation was checked; advertised schema URLs could not be read by the web
tool, so only the selected tested response contract is claimed as pinned.

**Verification.** Build exit 0. Final complete compiled Node suite **361/361**,
exit 0, no failures/skips/cancellations. New discovery cases and metadata refresh/
status/restore cases are included. Focused discovery/collector/worker **22/22**;
CLI **13/13** (also in the full suite). Initial focused failure and first full
suite's one old closure-state expectation remain retained; the integration
expectation was updated to the new persistent status quarantine with its original
no-extra-price/history invariants. Independent three-category live review exit
0, wire compatibility exit 0 and independent coverage reference **5/5**, exit 0.
Current command/results/source hashes: `artifacts/verification/discovery-unit.json`.
No new Forge/owned-chain crash campaign, paid publication, source soak/calibration
or human gate acceptance is claimed. Active Monad journals are unchanged and no
key was accessed by discovery. Git diff check passes; changes remain package-only.

**Remaining scope.** Diagnostic discovery/validation implementation is complete.
Production mapping, negative-risk semantics, cache/closure/time policy, terms,
calibration and named acceptance stay open for the existing later milestones.
The genuine 268/300 coverage/gap proof is **deferred**, with retry revision 3
inactive; no additional spending is authorized or requested by this milestone.
Next original milestone **4: stream hints, heartbeat and reconnect/resync
recovery**, with complete REST books authoritative under the PDF plan. No extra
commit milestone is added; no commit, push, branch change or decisions.md edit
was performed.

Commit message for completed milestone 3:
`feat: complete market discovery and metadata validation`
