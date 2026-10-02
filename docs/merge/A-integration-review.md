# Person A integration review

Date: 2026-10-02. Baseline: integration/risk at
71576ed4f0befcb5ec8a97154895c4b803d804d6 (also recorded by the runners).
This is an implementation review by Person A's coding agent, not an independent audit.
External counterpart status remains BLOCKED_BY_COUNTERPART.

## Initial G0–G6 review, before fixes

| Gate | Disposition | Evidence and qualification |
| --- | --- | --- |
| G0 | Agree, subject to fresh checks | Real A constants and numeric primitives match B's units, mapped outcomes and directed bounds. The retrospective process exception and recorded toolchain differences remain disclosed. |
| G1 | Agree, subject to fresh checks | Combined reference uses A's real coverage callback and follows actual ledger values through admission, funding, premium, liquidation and payoff. Rerun the combined Python trace as well as the shell gate. |
| G2 | Object pending A-F02 | Per-piece premium ceilings do not satisfy one ceiling of the exact cumulative segment. The frozen less-than-12-Q tolerance is not approval to change the specification. |
| G3 | Agree on state/context composition | Actual allocation, bootstrap and guarded release use real A+B. Rerun after the G4 freshness repair. |
| G4 | Object pending A-B01 | A late observation after an unrolled epoch ends can bypass the old freshness endpoint, then rollover can fund a historical gap. |
| G5 | Object pending A-B02 | B records an order epoch before A's freeze increments it again; the halt view disagrees with the authoritative accounting epoch. |
| G6 | Active-market fixture agreement only | Finality, price and complete allocation gate claims. A-F01 preactivation exit and A-F03 separate protocol-fee classification remain necessary corrections. |

No objection is cleared solely by adding a reviewer name. Final checks must run in
G0–G7 order, with updated source evidence and the affected regression tests.

## Interface decisions

- R-04: object to the existing freshness alias at epoch boundaries. Funding must
  consume its continuous freshness endpoint before any mark-validity substitution.
- R-05: agree with reservation consumption before paired posting. These are internal
  operations in one transaction; coverage is rechecked and a failure rolls back both.
- R-06: use an A-owned checked epoch-bump function and record the epoch returned by
  the actual freeze. A bridge write has no cash effect, but ownership and snapshot
  consistency should be explicit.
- R-09: agree with full-or-waived liquidation fees. The specification permits waiver;
  pair charges remain both-or-neither and the reported amount must be the actual fee.

## Scope

The attached handoff and book-hook request provide integration evidence. They do
not authorize a book rewrite, oracle implementation, deployment, or push. The user's
subsequent request explicitly authorizes task-focused commits of this review work.
This work addresses the A review, accounting requests, and identified integration
defects. Historical evidence is distinguished from fresh executions.

## Final disposition and validation

The recorded objections are resolved in the implementation through `ec14175`;
portable review tooling and production-only ABI exports are committed in `74b9f16`.
R-04 is accepted with the continuous-freshness repair, R-05 is confirmed, R-06 now
uses A's checked epoch port and actual frozen epoch, and R-09 retains full-or-waived
fees while reporting only what A actually charges. All five requested A ports are
implemented. A-F01, A-F02 and A-F03 pass their corrected regression tests.

G0-G6 now include A's review. Official G0-G7 commands ran in order with exit 0
(respective aggregate counts: 67, 152, 117, 78, 74, 62, 55, 102). A043 passes 37
review-directory tests. The full Forge 1.8.3 risk-profile run has **641 passed,
0 failed**, including the three audit reproducers and eight BookGas tests; no
path was excluded. Python A/B/audit/integration suites pass **46/156/8/7** tests.
The final source-bound results are in `artifacts/risk/review-validation.json`.

G7 remains blocked for **B delta review and coordinator acceptance**, not for A043.
No historical B approval is extended to the new fixes. A-I01 global-vault fee-Q
classification remains deferred; real book/oracle/price/factory joins, production
calibration/size/gas, team toolchain confirmation and integration into main remain
open. The 112,865-byte mock-book runtime and 1,000,000-byte test allowance are not
production approval. Nothing is deployed or pushed by this review.
