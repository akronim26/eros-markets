# Price-feed progress and decision log

This is the commit-by-commit record for the separate CP-PRICE workstream. Read it
before continuing work. Update the pending entry **before each user commit** with
what actually changed, why, verification, failures and remaining decisions. After
the user commits, record the real hash, message and timestamp from Git, then start
a new pending entry. Never invent a commit, approval, passing check or resolved
decision. The user makes commits; reminders are every five minutes during active
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

## Pending commit — joined pipeline verification and invalid-depth checkpoints (PF014-PF020)

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
