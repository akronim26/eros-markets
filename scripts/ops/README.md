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

The current configuration is `tmp/redeploy-20261011/supervisor.json` (one market,
7 November 2026). Retired groups (October 13/14 and earlier) carry retirement markers and
must not be restarted.

```json
{
  "schema": 1,
  "rpcEnvFile": "tmp/redeploy-20261009/rpc-pool.env",
  "stateDirectory": "tmp/redeploy-20261011/supervisor",
  "gasRunway": { "launchMinutes": 60, "alertMinutes": 15, "checkIntervalMs": 60000, "publishIntervalSeconds": 80 },
  "wake": { "url": "http://127.0.0.1:3100/api/market-activity", "pollMs": 15000, "idleMs": 600000 },
  "markets": [
    {
      "name": "nov7-dem-white-women",
      "publicDirectory": "artifacts/deployments/monad-testnet-20261011-nov7-dem-white-women",
      "privateDirectory": "tmp/redeploy-20261011/nov7-dem-white-women",
      "keeperMaxGas": "4000000",
      "liquidationEnabled": true,
      "maker": { "cooldownMs": 90000, "repriceTicks": 8, "maxActionsPerEpoch": 8 }
    }
  ]
}
```

`wake` enables wake-on-visit (`wake-policy.mjs`): the supervisor polls the frontend's
`GET /api/market-activity` and stops a market's three workers after `idleMs` without a
visitor heartbeat, unless any account is leveraged (`e0Q < 0` or `e1Q < 0`). A visitor
restarts them on the same journals. Every failed activity or leverage read keeps the market
awake. The URL must be https, or loopback for a local frontend; point it at the Vercel
deployment once one exists. Without `wake`, markets stay awake. `publishIntervalSeconds`
makes the runway projection follow the paced publisher (default 12 s source cadence).

`autoTopUp` (optional) refills operator wallets from the root deployer whose key is read from
`rootEnvFile` (a private, ignored `tmp/` file containing only `PRIVATE_KEY`). Defaults: refill
when under `triggerMinutes` 90 of runway, `amountsMon` keeper 30 / publisher 15 / makers 5,
`cooldownMinutes` 30 per wallet, `dailyCapMon` 200, `rootReserveMon` 10. Refills go only to the
configured markets' operator addresses and are logged to `<stateDirectory>/topups.jsonl`. Run
from the command line on macOS, the supervisor also posts desktop notifications for low gas,
stopped markets and refills that fail or that root cannot afford.

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
packages/pricefeed/node_modules/node/bin/node scripts/ops/market-supervisor.mjs check tmp/redeploy-20261011/supervisor.json
packages/pricefeed/node_modules/node/bin/node scripts/ops/market-supervisor.mjs run tmp/redeploy-20261011/supervisor.json
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

`gasRunway` (optional) sets the launch requirement and alert level. `check`/`run` refuse to start with `GAS_RUNWAY_INSUFFICIENT` (and per-role top-up amounts) unless every publisher, keeper and maker wallet has `launchMinutes` of conservatively projected runway above its own stopping threshold; while running, the supervisor records `gasRunwayAlert` events when a role drops below `alertMinutes`.
