# Unified Risk and Order Book workflow

Effective 2026-10-03. Item: GOV-01.

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

The old scripts still enforce the former review workflow. Their last recorded G7
result is exit 2 at A043; this document does not turn that historical failure into
a pass. Migrating those scripts is an outstanding engineering task, not a request
for a nonexistent Person A or Person B to review code.

The migration must retain the A043/B043 adversarial regression suites and all other
G7 technical checks, replace mandatory peer signatures with clearly labeled unified
technical evidence, and test failure/empty-suite handling. Do not simply regenerate
old review hashes, disable tests or relabel technical results as peer approval.

G7's human acceptance record remains separate: no accepted SHA, main merge or
production readiness is manufactured by this policy change. Counterparts can remain
explicitly blocked where actual integration has not been validated.

## RB-I11 decision

Using this delegated authority, select the strict INDEX-prefix seal described in
`docs/questions/RB-I11-index-prefix-seal.md`: publish a book capture only after the
pinned authenticated INDEX source has observed a strictly later timestamp. Preserve
valid waiting captures, their original timestamp, expiry and all eligibility guards.

This prevents subsequent accepted corrections from changing the capture's historical
INDEX prefix under the existing monotone ingress rule. It adds a feed-update delay;
continuous normal pricing needs a cadence comfortably below 30 seconds. Ten seconds
is a test cadence, not an invented production service guarantee. Fully backed startup
must remain usable before PERP warm-up. Implementation and regression validation are
still pending; the policy decision no longer awaits a user or teammate response.

## Current scope of this update

Documentation/governance only. No runtime, gate-runner, oracle or deployment changes.
Next engineering work: implement and test RB-I11, migrate legacy G7 review enforcement,
then rerun the affected technical checks before proposing acceptance or redeployment.
