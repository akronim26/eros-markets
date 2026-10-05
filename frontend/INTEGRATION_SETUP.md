# Running the integrated frontend locally

## Frontend

The existing public App ID is configured in `.env.local`. Run `npm run dev -- --port 3100`, or build and then run `npm run start -- --port 3100`. **Stop an existing production preview before rebuilding its `.next` directory**; otherwise old pages can request chunks removed by the new build and appear unstyled.

`NEXT_PUBLIC_INDEXER_URL=http://localhost:8081/v1/graphql` points to the isolated local trading indexer. Public variables are compiled into the browser bundle, so changes require restarting development or rebuilding production. For a hosted frontend, replace localhost with a hosted HTTPS GraphQL read endpoint. Never put a Hasura admin secret in this variable.

The read client batches contract calls and polls head every four seconds to reduce public RPC load. Transactions still revalidate and simulate before signing. Use a suitable authenticated/dedicated RPC for a multi-user deployment; the shared public endpoint can rate-limit.

## Local Envio services

- Existing `envio-postgres` remains on port 5433; original oracle database preserved.
- Existing oracle Hasura remains on port 8080.
- New `eros-trading-hasura` exposes the isolated `eros-trading` database at port 8081, bound to localhost.
- The ignored `oracle/indexer/.env.integration` contains this local service configuration; the supplied token remains in `.env`.

To resume the configured local trading indexer:

```sh
cd oracle/indexer
node scripts/start-integration.mjs
```

Docker must be running with `envio-postgres` and `eros-trading-hasura` started. The launcher validates the isolated database/endpoint and does not reset data. For another machine, create equivalent isolated services and local environment values first. Do not use `envio start -r` against an existing database to resolve schema changes; back up and migrate or create a separate database.

Both testnet and mainnet configs include trading event definitions. Mainnet deployment addresses and a start block preceding factory registration remain operator inputs; no mainnet deployment was performed.

## Local contract smoke check

The smoke script uses mock collateral/oracle on Anvil only and refuses other chain IDs. Use an Anvil instance with chain 31337, port 8547, code size limit 131072, and gas limit 200000000. Its signed historical index window assumes a fixed clock:

```sh
cast rpc anvil_setBlockTimestampInterval 0 --rpc-url http://127.0.0.1:8547
cd contracts
LOCAL_SMOKE_SENDER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 forge script script/LocalBookRiskSmoke.s.sol:LocalBookRiskSmoke --rpc-url http://127.0.0.1:8547 --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --disable-code-size-limit --gas-limit 200000000 --slow
cd ../frontend
npx tsx scripts/check-local-chain.ts
```

The final check uses frontend ABIs against actual local receipts/state and the deployless MarginLens. A successful Forge simulation or transaction status alone does not prove an order filled.

## Live demo dependencies

The configured public fixture is inactive and uses a manual authority. A funded public demo needs operator activation, test collateral, fresh signed index observations and counterpart liquidity. Oracle-backed trading needs the governance/factory deployment described in `docs/integration/REAL_FACTORY_INTEGRATION.md`. Verified leveraged profiles are intentionally absent until approved calibration is supplied.

Optional Privy server signing has separate setup in `services/automation/README.md`. Basic Privy wallet transactions do not require those optional server credentials.
