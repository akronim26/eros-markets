# Historical service setup — October 6 deployment

This deployment is superseded. Its addresses, budgets, private directories and
startup commands below are retained as historical evidence. Do not use them to
start current workers. Use [TESTNET_OPERATIONS.md](TESTNET_OPERATIONS.md) for the
October 9 fast-profile BTC/ETH supervisor, [addresses.md](../../addresses.md) for
current contracts, and `frontend/src/config/public-manifest.json` for the selected
markets. The live retained indexer uses a different database and endpoint; keep
its configuration intact.

Deployment: `artifacts/deployments/monad-testnet-20261006/public-manifest.json`.
Chain: **10143**. Frontend and backend use the same registry, factory, engine,
shared vault and token. The frontend reads current state directly from RPC.
No cloud resource has been created; the user requested hosting after wiring.

## Files and custody

Public service configuration is under the deployment's `services/` directory:

- `pricefeed-config.json`, `pricefeed-rules.json`, `engine-abi.json`: exact source,
  listing, signer and runtime pins. `enabled:false` selects the explicit testnet
  publication path; it is not production approval.
- `pricefeed-policy.json`: finite budget, initially 12 transactions / maximum
  reservation of 1.44 MON. Ten observations have finalized. This policy is a
  bounded check, not an unlimited hosting budget.
- `market-ops.json`, `market-ops-gas.json`: book sampler and adaptive bounded
  rollover helper. Sample gas was measured against the actual deployed engine.
  Remeasure for the intended book state. Liquidation gas is not fabricated.
- `oracle-deployments.json`, `engine-identities.json`: fresh oracle deployment
  and exact integrated-engine identity for keeper enrollment. These replace
  historical defaults when supplied through `DEPLOYMENTS_FILE` and
  `ENGINE_IDENTITIES_FILE`.

Private local files are in `tmp/fresh-testnet-20261006/` (gitignored):

- `roles.env`: generated operator and maker keys, owner-only permissions.
- `services/keys/`: encrypted publisher/observation keys and separate password files.
- `services/pricefeed-journals/`: all five durable SQLite journals; preserve WAL/SHM
  files during an offline backup. Never clear or initialize them on restart.
- `services/market-ops-journal.json`: market-ops state, if created. Keep its lock
  and pending transaction rules; do not run competing processes.

The root `.env` deployment key was used only by the deployment/funding runner.
Browser manifests contain no private keys or RPC credentials. The ten publisher
transactions are reconciled and no signed transaction remains unresolved.

## Hosting layout

Use persistent storage, one active instance per signer/journal, and supervised
processes. Existing pricefeed deployment guidance is in
[`packages/pricefeed/docs/deployment.md`](../../packages/pricefeed/docs/deployment.md).
Its current Render blueprint is for the pricefeed package; it does not deploy the
entire oracle, keeper or indexer stack. Do not interpret a running web server or
worker as healthy prices.

Use separate sending accounts for the price publisher, book/epoch operator,
resolution keeper and CRE simulation relayer. The prepared market-ops sender is
also this market's authorized monitor. Do not start the ordinary resolution keeper
with that same key while market-ops is running. Enroll/fund a separate resolution
keeper before starting both. Observation signing and panel attestation keys need
not hold native gas; actual transaction senders do.

Native gas has been allocated to publisher (1.5 MON), market-ops/monitor (0.75 MON)
and two independent maker owners (0.35 MON each), less their subsequent transaction
costs. The CRE simulation relayer and a separate resolution keeper still need
native funding at service activation. Maker owners each hold 2,000 test tokens
allocated to the market; they currently have no admitted resting order or fill.

## Pricefeed: resume the existing journal

From `packages/pricefeed`, using its pinned Node 24.21.0:

```sh
npm ci
npm run build
export EROS_TESTNET_RPC=https://testnet-rpc.monad.xyz
node_modules/node/bin/node dist/src/cli.js serve-monad-testnet \
  --rpc-env EROS_TESTNET_RPC \
  --config ../../artifacts/deployments/monad-testnet-20261006/services/pricefeed-config.json \
  --rules ../../artifacts/deployments/monad-testnet-20261006/services/pricefeed-rules.json \
  --abi ../../artifacts/deployments/monad-testnet-20261006/services/engine-abi.json \
  --keys-dir ../../tmp/fresh-testnet-20261006/services/keys \
  --journal-dir ../../tmp/fresh-testnet-20261006/services/pricefeed-journals \
  --policy ../../artifacts/deployments/monad-testnet-20261006/services/pricefeed-policy.json \
  --duration-seconds 300 --stop-after-finalized 12 --initialize false
```

This can send the remaining budgeted updates and stops at the target/time limit.
Move paths to the persistent volume on a host. Before extending the campaign, use
the existing `plan-monad-budget` / `apply-monad-budget` workflow and preserve its
revision/transition evidence. Do not edit away spent reservations or restart from
empty journals. The local check missed continuous coverage: accepted observations
alone do not certify INDEX300 readiness. Measure source timestamp advancement,
end-to-end RPC latency, inclusion/finality and publication gaps on the host.
Never substitute current timestamps for stale external observations.

## Book, epochs and resolution

`oracle/services/market-ops` already supplies read-only-by-default `sample`,
`rollover`, `liquidate` and `early-check` commands. Select the exported fresh
manifest and preserve a single journal. Supply `MARKET_OPS_PRIVATE_KEY` securely;
its address must match the manifest. Start with simulation. Add `--broadcast`
only for the intended action after its current gas check. Do not run several
`--watch` processes against one sender; serialize sampling and epoch maintenance.
The helper estimates bounded rollover batches with margin below 30M gas.

Price readiness requires independent INDEX300, PERP60 and BASIS900 windows and
eligible two-sided depth. Maker orders are explicit owner transactions; book
sampling does not create liquidity. After pricing is ready, confirm actual
`previewOrder` results, place quotes, sample continuously, advance epochs and
verify caps/fills. The current full 5× real-source demonstration remains incomplete.

The resolution keeper additionally requires measured future-state gas entries for
its selected engine/actions. Do not reuse the historical stub's table as evidence
for this engine. The optional price/risk liquidation operators must also be tested
in their intended states before unattended operation. Keep oracle finality,
settlement preparation and owner claims as separate observed steps.

For the CRE listener, use `TARGET=fresh-testnet`, a new persistent `STATE_DIR`,
and a private `CRE_ENV_FILE` containing `MONAD_TESTNET_RPC` and the authorized
`SIM_RELAYER_PRIVATE_KEY` value under the CRE name `CRE_ETH_PRIVATE_KEY`.
Run `BROADCAST=0 RUN_ONCE=1` first to verify intake. The listener defaults to
broadcasting when `BROADCAST` is omitted. It is a self-hosted CRE CLI simulator,
not a live CRE network workflow. Historical `local-sim` remains separate.

The new `fresh-testnet` targets for `resolution` and `dryrun` select the fresh
oracle/FeedSpec. The read-only FeedSpec CLI check has already passed. Panel maps
remain explicitly placeholder calibration below the automatic confidence gate;
do not present automatic AI resolution as validated. Configure model providers,
committee/watchdog custody and their operating policy before using those paths.

## Envio and frontend history

From `oracle/indexer`:

```sh
ENVIO_DEPLOYMENT=monad-testnet-20261006 \
  pnpm exec envio --config config.fresh-testnet.yaml codegen
```

Provision a fresh database/indexer for this deployment. Start it with the same
`ENVIO_DEPLOYMENT` and `--config` values, using server-only `ENVIO_API_TOKEN`.
The matching config and address filters cover the factory, vault, token, trading
engine and oracle. Code generation, typechecking and local handler tests passed;
no hosted GraphQL endpoint has been created or certified.

Once its read-only GraphQL endpoint is available, set in the frontend:

```text
NEXT_PUBLIC_INDEXER_URL=<public read-only GraphQL endpoint>
NEXT_PUBLIC_INDEXER_DEPLOYMENT=10143:0x9be1d595ac9b6c1109a4dcaa056ce5efdaf06f45
```

Rebuild/restart the frontend. Until then it intentionally reports history as
unavailable and uses direct RPC for current state. An Envio API token alone does
not provision the GraphQL service.

## Wallet demo gate

The Privy public App ID is already configured locally. Validate real embedded and
external wallet signing after fresh prices/liquidity permit admission. Basic
owner-confirmed mint/approve/deposit/allocate/order/release/withdraw calls do not
require server-side Privy credentials. Optional delegated trading/protection does:
configure separate policies for the **new** engine addresses and their supervised
worker. See [`services/automation/README.md`](../../services/automation/README.md).
