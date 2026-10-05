# Integrated application handoff

`integration/risk` includes the frontend merged from `origin/feat/pricefeed`
at `a0823dc1f4c5511c575ce5ec295cf047d711b728`. Public deployment belongs to the
frontend/deployment team. This work sends no public transactions. Local addresses
are disposable and must never be copied into a testnet deployment configuration.
The merged frontend retains its historical testnet configuration. Connecting it to
the integrated backend is frontend-team work; the proposed local manifest selector
and injected-wallet adapter are not part of the committed frontend.

## Start the backend locally

Use the pinned tools and dependencies in [LEVERAGE_INTEGRATION.md](LEVERAGE_INTEGRATION.md).
From the repository root:

```sh
python scripts/integration/local-stack.py run --scenario leveraged --rpc-port 18556 --read-port 8797 --keep-running
```

The command prints the new run directory and writes `tmp/local-leverage-latest.json`.
Use a run that reports `passed`. Its `public-manifest.json` is the verified,
credential-free deployment description. Check the backend and read API from the
repository root:

```sh
python scripts/integration/local-stack.py status --scenario leveraged
python scripts/integration/probe-local-api.py --scenario leveraged
```

The read API runs on loopback port 8797 in this example and never signs. Its
block-pinned states, pagination and SDK transaction builders are described in the
[versioned interface](../../oracle/packages/oracle-sdk/FRONTEND_HANDOFF.md) and
[SDK examples](../../oracle/packages/oracle-sdk/README.md). Each owner must fund,
approve, deposit and allocate their own collateral; the backend SDK smoke step
exercises that sequence with an independent guarded local fixture owner.

Stop only the selected run when done:

```sh
python scripts/integration/local-stack.py stop --directory tmp/<run>
```

## Frontend connection work

Start from the existing [frontend setup](../../frontend/README.md). Its historical
testnet fixture is not the integrated factory deployment. Wire the verified public
manifest into `frontend/src/config/deployment.ts` and `chain.ts`; the merged chain
configuration currently fixes chain 10143 and must be adapted before local use.
Use the actual manifest's registry, resolution oracle, factory, vault, token and
market identities together, and validate them against the selected RPC. Local
integration uses chain 31337 and a loopback RPC; never reuse its addresses on testnet.

The browser entry of `@eros-oracle/oracle-sdk` supplies the public-manifest schema,
concrete ABIs and owner transaction builders. Preserve manifest provenance and
verification metadata while keeping RPC credentials and signing keys out of public
configuration. Clear a previous testnet indexer when selecting local contracts;
history requires an indexer for the same chain and deployment. Current state can
be read directly or through the backend read API.

The team must connect the selected wallet to that same chain, bind each transaction
sequence to its owner and connector, and handle finality before dependent steps.
An injected local-wallet path is not implemented by this backend handoff. Account
for the absence of Multicall3 on a fresh local chain and preserve block-pinned reads
when using direct calls. Restart/rebuild the frontend after public configuration
changes. Frontend build, browser and wallet validation are deferred at the user's
request; backend checks do not certify the merged UI's integration.

## Deployment inputs and operating policy

Use the [deployment runbook](DEPLOYMENT_RUNBOOK.md) for the actual sequence:
two engine code stores, factory/shared vault, governance factory authorization,
registry listing, reserve funding, calibration configuration, then activation.
The optional `RolloverBatcher` is a stateless helper for bounded epoch maintenance.
Do not use the historical direct-engine deployment as evidence for this sequence.

Before selecting a public manifest, verify chain ID, canonical deployment receipts,
runtime code hashes, registry/factory/vault bindings, listing hashes and source IDs.
Export addresses only from that verified deployment. The existing public registry
uses a stub factory; local fork rehearsal does not change it or prove wallet control.
The runbook contains unsigned call generation and clearly separates simulated roles
from actual signer custody. No public RPC credential belongs in a browser manifest;
use a credential-free public endpoint or a separately operated RPC proxy.

Keep governance/lister, price publisher, keeper/market operator, reserve owner and
maker/trader roles explicit. Enroll operators against the exact deployed identities.
Run collector/builder/signer/relay, book sampler, keeper and epoch maintenance
continuously. Maker liquidity comes from separately funded owner wallets. A running
web server alone cannot keep prices, epochs or settlement preparation current.
Preserve journals across restart; reconcile pending signed bytes and receipts before
retrying. Never clear a journal to bypass a failed or partially completed operation.

The backend does not require Privy. The merged frontend's wallet setup and its
behavior without a Privy App ID are documented in its README. Public embedded/delegated trading
needs the separate trade and protection policies in
[services/automation/README.md](../../services/automation/README.md). Server secrets,
authorization keys and claim-delivery keys stay server-side. Keep deposits,
withdrawals and other custody changes under explicit owner wallet confirmation;
the bounded delegated trading path supports only its allowlisted engine actions.
Do not start the workflow listener casually: its default configuration broadcasts.

## Decisions the UI must preserve

| Decision | UI behavior |
| --- | --- |
| Bad debt is absorbed by funded reserves | Show full owner claim entitlements after preparation; do not apply an invented payout haircut. Coverage and admission checks remain authoritative. |
| Leverage is dynamic | Display directional `leverageCaps()` and current previews. A 5x deployment cap is not a promise of 5x availability; bootstrap, stale prices, risk stages and reserve coverage can restrict admission. |
| Prices have independent availability | Show unavailable INDEX/mark as unavailable, not zero. A fresh INDEX alone does not establish the mark. Preserve stale cached data labels and retry states. |
| Calibration and price source are separate | Genuine Polymarket prices do not make synthetic test calibration empirical. Label test collateral, synthetic calibration and mocked resolution separately. |
| Oracle finality precedes withdrawals | Show bounded settlement preparation and cursor progress. Enable claims only when `claimsEnabled` and that owner's positive claim are both present. |
| Owners hold their own balances | Bind signing to the selected owner, connector and chain; stop a multi-step flow if any changes. Release credits vault free balance; withdrawal transfers it to the wallet. |
| A successful transaction can contain no fill | Decode rejection/fill/resting-order events and refresh state. Do not equate a submitted transaction or returned order ID with a filled order. |
| History and current state differ | Pin reads to a canonical block; paginate/deduplicate events. Display unavailable history when no matching indexer is configured. |

Exact units, enums, claim states, errors and transaction sequences are in the
[versioned SDK interface](../../oracle/packages/oracle-sdk/FRONTEND_HANDOFF.md).
Use its browser export and concrete ABIs. When wiring the frontend, refresh its
generated ABIs with `npm run gen:abis` after compiling `MarginLens`; it is a read-only deployless
display helper. Missing exact risk-profile parameters must leave its estimate
unavailable rather than substitute fabricated calibration.

## Validation boundary

See [INTEGRATION_READINESS.md](INTEGRATION_READINESS.md) and the committed
`artifacts/integration/` reports for exact results, source fingerprints and limitations.
Completed risk/book, oracle, SDK/service, pricefeed and deterministic lifecycle
evidence is retained. The extended high-count risk rerun was cancelled under the
user's hackathon scope reduction; earlier default Prague/MonadTen suites passed.
The full authentic-source leveraged endurance proof remains incomplete and is not
a public-readiness claim. Real-source partial archives and failures remain visible.
No actual testnet deployment or public operator enrollment was performed here.
Uncommitted frontend adaptation was set aside when the user limited the remaining
work to backend flow. It is not presented as shipped or validated integration.
