# CP-PRICE decisions and authorized scope

The user explicitly authorized building the price-feed component on 2 October
2026, while forbidding edits to the risk engine, CLOB and oracle. Implementation,
tests, reference fixtures and documentation live only in `packages/pricefeed/`.
The existing `pricefeed` branch is preserved. The user performs commits; the agent
supplies reminders every five minutes during active work and suggested messages.
This overrides the risk-team commit/STATUS workflow for this separate workstream.

This is the permitted implementation location, not a reviewer approval or a
production authorization. No risk-side fingerprints, gate records, shared STATUS,
counterpart code, existing documents or deployment configuration may be edited.

| Decision | Status | Implementation consequence |
|---|---|---|
| Q01 separate scope and location | User authorized this workstream; individual owner/reviewer names unassigned | Only this package is implemented |
| Q02 impact method/rounding/depth/fees | OPEN | Both mathematical branches available for explicit diagnostics; no approved operational method inferred |
| Q03 source/publish timestamp meaning | OPEN | Preserve vendor milliseconds, diagnostic floor to Unix seconds; no local freshness substitution or operational signing |
| Q04 canonical source-rules hash | OPEN | No guessed rules hash; engine pins must match approved manifest |
| Q05 quote/quantity/minimum-size normalization | OPEN | Diagnostic claim-to-lot conversion explicit; no quote equivalence or fee model approved |
| Q06 event semantics and exact initial mapping | OPEN | Three real source examples remain disabled for operational output |
| Q07 cadence/headroom/metadata age | OPEN | Every diagnostic run declares its own settings; no production cadence default |
| Q08 invalid-packet representation/priority | OPEN | Report unavailability and preserve reasons; do not emit fabricated invalid observations |
| Q09 live chain/engine/key/relay/finality | OPEN | No live transactions or deployment |
| Q10 calibration/soak/retention/release | OPEN | Read-only measurements cannot approve production parameters or release |

The eleven-field ABI and raw digest are fixed by existing `IPriceSource.sol` and
`PriceIngress.sol`; assumption I-3 still needs named counterpart confirmation.
Tests and diagnostic preparation do not accept PF-G0 or any other human gate.

The development runtime is pinned to Node 24.21.0 LTS, TypeScript 5.9.3 and viem
2.57.2, with a package-local lockfile. These are implementation tool choices, not
approved infrastructure capacity, storage, risk parameters or production release.
