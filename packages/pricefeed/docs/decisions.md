# CP-PRICE decisions and authorized scope

The user explicitly authorized building the price-feed component on 2 October
2026, while forbidding edits to the risk engine, CLOB and oracle. Implementation,
tests, reference fixtures and documentation live only in `packages/pricefeed/`.
The existing `pricefeed` branch is preserved. The user performs commits; the agent
supplies reminders every five minutes during active work and suggested messages.
This overrides the risk-team commit/STATUS workflow for this separate workstream.
From 03 October 2026, the user requires suggested commit messages to start with
`feat:`, `test:` or `fix:`. Reminders apply during active work; commits remain manual.

This is the permitted implementation location, not a reviewer approval or a
production authorization. No risk-side fingerprints, gate records, shared STATUS,
counterpart code, existing documents or deployment configuration may be edited.

On 2 October 2026 the user additionally authorized a demo using actual Polymarket
data with a demo market. That permits the separate local-demo runner to create an
owned localhost Anvil chain, instantiate a test composition of real ingress/store,
use public test keys and submit local observations. It does not approve Q02-Q10,
an operational event mapping, deployment to an external network or changes to
risk/CLOB/oracle code. All temporary chain activity stays on chain ID 31337.

| Decision | Status | Implementation consequence |
|---|---|---|
| Q01 separate scope and location | User authorized this workstream; individual owner/reviewer names unassigned | Only this package is implemented |
| Q02 impact method/rounding/depth/fees | USER-SELECTED on 03 October 2026: before-fee VWAP, directed price rounding, validated two-sided displayed depth and floor-total lots; named counterpart review pending | Existing calculator matches pricing-v1; bind the reviewed policy through Q04 and keep other admission dependencies closed until supplied |
| Q03 source/publish timestamp meaning | Conservative handling selected on 03 October 2026; provider timestamp semantics remain OPEN | Preserve vendor time as observedAt; freeze publishedAt before signing; recheck freshness before signing/sending; retries cannot refresh timestamps. Delivery margin remains Q07; production admission remains blocked |
| Q04 canonical source-rules hash | Risk consumer contract IMPLEMENTED; canonical listing/pricefeed dossier and encoding OPEN | Engine pins the supplied bytes32 and rejects mismatches; package-only manifest work can proceed, with the production hash requiring the agreed dossier |
| Q05 quote/quantity/minimum-size normalization | Engine WAD/lot units FIXED; exact fractional aggregation, floor-total lots and source constraints SELECTED; provider quote equivalence/precision OPEN | Before-fee pricing does not approve collateral equivalence or imply arbitrary lot-sized trades meet provider precision |
| Q06 event semantics and exact initial mapping | OPEN | Three real source examples remain disabled for operational output |
| Q07 cadence/headroom/metadata age | Engine 30-second carry and full 300-second index coverage FIXED; producer budgets OPEN | Every diagnostic run declares its own settings; 30 seconds is not a production polling interval |
| Q08 invalid-packet representation/priority | Engine invalid-depth acceptance and zero coverage FIXED; producer representation/priority OPEN | Engine computes depthValid; preserve failure reasons and do not fabricate timestamps for unavailable source data |
| Q09 live chain/engine/key/relay/finality | OPEN | No live transactions or deployment |
| Q10 calibration/soak/retention/release | OPEN | Read-only measurements cannot approve production parameters or release |

The eleven-field ABI and raw digest are fixed by existing `IPriceSource.sol` and
`PriceIngress.sol`; assumption I-3 still needs named counterpart confirmation.
Tests and diagnostic preparation do not accept PF-G0 or any other human gate.

The development runtime is pinned to Node 24.21.0 LTS, TypeScript 5.9.3 and viem
2.57.2, with a package-local lockfile. These are implementation tool choices, not
approved infrastructure capacity, storage, risk parameters or production release.
