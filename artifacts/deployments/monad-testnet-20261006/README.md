# Fresh Monad testnet deployment — 2026-10-06

Chain 10143. `public-manifest.json` is the frontend/SDK deployment identity.
`receipts.json` contains the 39 deployment and activation receipts. The other
verification files distinguish native role funding, two independent owners and
authentic external-source publication. Local rehearsal addresses are not exported.

`source.json` pins the Polymarket condition, YES token and rules. Calibration is
synthetic. `services/cre-feed-simulation.log` is a successful read-only CRE CLI
simulation; NOT_FINAL is expected for this ongoing event. It is not a completed
resolution or a deployed CRE network workflow.

The bounded publisher run did not establish continuous pricing. The original
9/12 result is preserved; restart reconciled the existing tenth transaction,
with no unresolved signed transaction left. Publication gaps prevent claiming
INDEX300/PERP60/BASIS900 readiness or leveraged fills. See
[progress and next steps](../../../docs/integration/DEPLOYMENT_PROGRESS.md).

Service files contain public addresses/configuration only. Signing keys and
persistent journals stay in the ignored `tmp/fresh-testnet-20261006` run directory;
back them up privately before moving to a host. Do not start a second publisher
against an empty journal using the same signer.
