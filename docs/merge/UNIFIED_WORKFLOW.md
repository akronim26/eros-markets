# Unified Risk and Order Book workflow

Effective 2026-10-03. Items: GOV-01 / GOV-02.

## Integration scope update — 2026-10-06

The user explicitly authorized connecting and testing the order book, risk,
oracle and merged pricefeed, including a genuine external-price local run,
integrated deployment rehearsal, read-only Monad readiness checks and frontend
SDK/read interfaces. Public transactions, frontend implementation and branch
merging remain deferred. This supersedes the older oracle and publisher scope
limits below. The current session also prohibits pushing. No source-data,
empirical calibration, funded reserve or public wallet control is invented.
See [INTEGRATION_READINESS.md](../integration/INTEGRATION_READINESS.md).

## Integration scope update — 2026-10-05

The user now authorizes real factory/oracle/risk/book integration and its local
operational and lifecycle tests (RF-01 through RF-04). This supersedes the older
oracle exclusions below for this work. Sponsor and frontend integration are deferred.
No local account controls the existing oracle deployment; the independent pricefeed
is not yet complete. Live factory switching, actual observations, O42 and OG3b remain
pending. See `../integration/REAL_FACTORY_INTEGRATION.md`. No new gate acceptance,
main merge, external review or production permission is inferred.

The user explicitly merged the Risk and Order Book teams and instructed us to make
our own decisions without mandatory A/B review. This supersedes older ownership,
next-turn and peer-review requirements in handoffs and status documents.

## Decision authority

- One team owns the non-oracle Risk, Clearing and Order Book implementation.
- A/B task IDs, review reports and accepted historical commits remain for provenance.
  They do not represent current separate owners or required signatures.
- Make and document reasonable implementation choices without repeatedly asking for
  policy approval. Preserve the selected economic baseline and explain tradeoffs.
- Oracle remains excluded. Actual production inputs, signer roles and calibration
  cannot be invented. Main merges, deployment and final release acceptance are not
  authorized merely by retiring peer review.

## Required engineering work

1. Identify the defect or requirement and its exact source baseline.
2. Record the chosen behavior and rationale; add failing reproductions where applicable.
3. Implement without weakening custody, coverage, authentication, freshness or rollback.
4. Run affected regressions, reference checks, gates and applicable gas/size checks.
5. Record source-bound results, known limitations and real-versus-mocked dependencies.
6. Update the fix ledger and STATUS, commit by task and push `integration/risk`.

Automated validation is required. Independent peer review is not required by this
development workflow, and these checks must never be represented as an independent
security audit. Historical review documents and fingerprints are not rewritten as
approvals of newly authored code.

## G7 transition

GOV-02 replaces the former signature enforcement with source-bound technical
validation in `artifacts/validation/A043.json` and `B043.json`. The previous G7 exit
2 at A043 remains a historical result; only a new successful run establishes a pass.

The runners retain A043/B043 adversarial regression suites and all other G7 technical
checks. They reject failed, empty, skipped or malformed suites and stale source
fingerprints. Historical review files remain untouched; technical results do not
become peer approval. Historical accepted predecessor SHAs must still be ancestors.

Acceptance runners clear inherited `FOUNDRY_*` / `DAPP_*` overrides before pinning
the risk profile and seed. They reject global `.foundry/foundry.toml` configuration
without reading or changing it, so hidden filters cannot silently omit regressions.
Use an environment without global Foundry configuration for these checks; keep
operator settings and signing credentials private and outside the repository.

G7's human acceptance record remains separate. On 2026-10-03 the user explicitly
answered **"Yes—record G7 acceptance after passing checks"**. This permits recording
the actual passing candidate SHA in `docs/spec/gate_status.json`; it does not approve
production deployment or a merge into main. The technical runner still emits
`accepted=false` and `merge_sha=null`. Unvalidated production counterparts remain
explicitly blocked. Consult the status record for the completed acceptance result.

**Recorded outcome:** all G0-G7 checks pass at `c91acf75ae9770f0bf5ae2238b4018202d57acd8`
(reported checks 88/152/117/78/77/63/55/156; no skips). G7 acceptance is recorded
under the user's authorization at **2026-10-03 17:39:11 UTC**, with no A/B reviewer
identity added. Current CI passes 832 tests, Monad-targeted checks 99, and Python
237; see `artifacts/risk/unified-integration-2026-10-03.json` for exact scope and
overlap. Acceptance names an integration candidate, not a merge into main.

Do not use the historical `scripts/integration/mark-gate.py` helper for this workflow:
it records the retired A/B metadata and its old authorization text. Current acceptance
is recorded separately with the actual candidate, current user authorization and no
invented reviewer identity; `check-gate.sh` only supplies technical evidence.

## RB-I11 decision

Using this delegated authority, select the strict INDEX-prefix seal described in
`docs/questions/RB-I11-index-prefix-seal.md`: publish a book capture only after the
pinned authenticated INDEX source has observed a strictly later timestamp. Preserve
valid waiting captures, their original timestamp, expiry and all eligibility guards.

This prevents subsequent accepted corrections from changing the capture's historical
INDEX prefix under the existing monotone ingress rule. It adds a feed-update delay;
continuous normal pricing needs a cadence comfortably below 30 seconds. Ten seconds
is a test cadence, not an invented production service guarantee. Fully backed startup
must remain usable before PERP warm-up. Implementation is committed in `dcb6b0e`;
all 21 sampler regressions pass, including correction sealing and waiting expiry.

## Current scope of this update

RB-I11 runtime and regression changes, RB-I12 local smoke compatibility, GOV-02
runner migration, current validation and environment/address documentation. Oracle
remains excluded. No new deployment is performed by this update; existing closed
smoke addresses do not contain these repairs.
