# A043: B decision/callback review handoff

Status: **PENDING_PEER_MERGE**. No B implementation is present or implemented by A.
This is a review-ready boundary checklist, not a completed peer review or an audit.
The user explicitly requested A-only implementation without waiting for B.

| B boundary to review after merge | Existing A-side guard / reproducer |
| --- | --- |
| IM/MM, sign-specific all-prefix envelope and concentration | `Decision` contains before/after values and reservations; A021 checks denied/stale scripted approvals. B math is not reproduced by the mock. |
| Fixed per-action context and freshness cutoff | Context timestamp/version/value validation; A022 stale-stop test; A026 atomic rollback test. B must preserve continuous freshness across source gaps. |
| Pairing and reservation generations | A027 exact old-epoch no-op; A must receive B's exact post-fill aggregate, with no duplicate unrest. |
| Positive-equity liquidation and MM health | A028/A033 reject positive-equity/stale takeover; A029 checks fee waiver. B must additionally prove MM health and permission of every reduction. |
| Halt authentication and immutable finality | A030/A034 freeze once; B must authenticate callers, enforce early/scheduled clock precedence, and call internal `_freeze` only with the actual economic halt. |
| INVALID capture | A035 refuses claims before all allocation; B must supply only its immutable scheduled-window price and cannot authorize arbitrary prices. |
| Oracle final vs claims readiness | A035/A037 check both engine and vault readiness, blocked recipient isolation, and once-only custody payout. |
| Initial deployment defaults | Set immutable funding/recovery flags false; B caps remain 1x until release evidence. The test harness explicitly enables funding for local tests. |

The scripted decision mock is deliberately insufficient for production: its
allow/deny responses test posting order and rejection, not economic permissions.
No production concrete engine or B caller authentication is delivered in A's tree.

Open merge issues:

1. Bind B's functions to `AccountingPort.Context` / `Decision` / `PairInput` and
   reconcile enum/unit schemas. Run real combined G0-G7 tests before acceptance.
2. Adapt the existing book's uint96 sizes and 8-bit generation/24-bit slot IDs
   without changing the protected book in this branch. Confirm lot and cost units.
3. Review final composition size. The test harness deliberately exposes every A
   internal method and exceeds the 24,576-byte EIP-170 limit under the local
   compiler. A's isolated risk test profile permits a 65,536-byte test harness;
   this does not establish deployment compatibility or choose a chain limit.
4. Review the conservative total OI cap of 2^40 lots, which ensures any full-account
   takeover fits the specified reserve position bound. It is a numeric safety
   restriction, not calibrated production open interest.

No B finding has been marked resolved without B source or a real reproducer.
