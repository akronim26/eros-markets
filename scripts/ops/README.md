# Persistent testnet market workers

See the [testnet operating runbook](../../docs/integration/TESTNET_OPERATIONS.md)
for the current local configuration, RPC/writer policy, prewarming, recovery and
fresh-listing handoff.

`market-supervisor.mjs` runs three existing workers per market: publisher,
market operations (sampling, rollover and configured liquidations), and maker.
Frontend and indexer remain separate. Process uptime does not establish available
INDEX/MARK, leverage, liquidity, or successful trading.

Use the current fast-profile deployment and its private runtime directories. This runner
resumes their journals; it does not initialize wallets, deploy, fund, renew budgets,
clear journals, recover nonces, or remove existing locks. Build the pricefeed before
launching (`npm --prefix packages/pricefeed run build`). Node with `node:sqlite`,
Bun, and installed project dependencies are required.

The prepared configuration is
`tmp/redeploy-20261009/fast-profile/supervisor.json`. Its public market paths and
private journals are shown below. Both groups remain stopped pending operator
funding and maker seeding; do not restart the retired October 7/8 groups.

```json
{
  "schema": 1,
  "rpcEnvFile": "tmp/redeploy-20261009/rpc-pool.env",
  "stateDirectory": "tmp/redeploy-20261009/fast-profile/supervisor",
  "markets": [
    {
      "name": "btc-oct10",
      "publicDirectory": "artifacts/deployments/monad-testnet-20261009-fast-btc-oct10",
      "privateDirectory": "tmp/redeploy-20261009/fast-profile/btc-oct10",
      "keeperMaxGas": 4000000,
      "liquidationEnabled": true
    },
    {
      "name": "eth-oct11",
      "publicDirectory": "artifacts/deployments/monad-testnet-20261009-fast-eth-oct11",
      "privateDirectory": "tmp/redeploy-20261009/fast-profile/eth-oct11",
      "keeperMaxGas": 4000000,
      "liquidationEnabled": true
    }
  ]
}
```

This configuration enables liquidations using the enrolled `gas.liquidate` policy
in each matching market-ops manifest. Funding and pricing readiness must still be
established before use. Optional
`nodeCommand`/`bunCommand` override the binaries; Node defaults to the pricefeed's
bundled runtime. Optional `sourceDnsServers` affects only the workers' existing
Polymarket DNS helper.
Per-market `liquidationIntervalMs` and `maker` fields (`targetLots`,
`maximumPositionLots`, `maxActionsPerEpoch`, `cooldownMs`, `repriceTicks`,
`captureWaitMs`) use the existing workers' bounded policy validation. Omitted maker
settings retain defaults: two million lots per quote, four million position lots,
twelve actions per epoch, thirty seconds between replacements, five ticks of price
movement and fifteen seconds maximum capture wait.

```sh
packages/pricefeed/node_modules/node/bin/node scripts/ops/market-supervisor.mjs check tmp/redeploy-20261009/fast-profile/supervisor.json
packages/pricefeed/node_modules/node/bin/node scripts/ops/market-supervisor.mjs run tmp/redeploy-20261009/fast-profile/supervisor.json
```

`check` performs read-only validation of testnet, deployed engine/listing identity,
current manifest/service pins, project role addresses and existing journal files.
The prepared public-directory path and all six saved service-file hashes must
match; any reviewed policy update must update its preparation record first.
`run` repeats those checks, acquires an exclusive supervisor lock, then starts the
workers in persistent mode. Keep it under a host process manager with a persistent
working directory and private storage. Do not blindly restart after exit code 78.

`status.json` contains the supervisor PID, child PIDs, restart counts and blocked
reasons. Redacted worker logs and `supervisor.jsonl` stay in `stateDirectory`.
Recognized transient child failures retry at most five times with exponential
backoff. Unknown failures, funding/budget exhaustion, identity errors, noncanonical
receipts, pending nonce recovery and existing locks require operator review and
stop the affected market's three workers. Other market groups remain running.

Send SIGTERM to the supervisor PID for graceful shutdown. Pending transactions may
extend shutdown while workers preserve or reconcile their journals. After an abrupt
host crash, inspect retained locks and signer/nonce state before manual recovery;
the supervisor never decides that an old lock is safe to delete. For a hackathon,
prewarm long enough to cross a successful epoch opening and verify contract prices,
caps, fresh funded depth and actual fills before declaring readiness.
