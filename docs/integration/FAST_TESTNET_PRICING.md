# Monad testnet pricing windows

Newly compiled engines select these history windows by chain ID:

| Chain | INDEX | PERP | BASIS | Observation carry |
| --- | ---: | ---: | ---: | ---: |
| Monad testnet, 10143 | 60 s | 60 s | 180 s | 30 s |
| Every other chain, including Monad mainnet 143 and local 31337 | 300 s | 60 s | 900 s | 30 s |

`PricingMath.indexWindow()` and `basisWindow()` select the windows. The same
selection applies to the observation views, MARK inputs and capture-time INDEX
checkpoint. `pricingWindows()` returns `(indexWindowSecs, perpWindowSecs,
basisWindowSecs, carryLimitSecs)` for the executing chain. `indexTwap300()` and
`basisTwap900()` retain their existing ABI selectors as compatibility aliases;
their names do not specify the selected testnet window.

This is an experimental testnet timing profile, not validated production risk
calibration. Source authentication, observed timestamps, complete coverage,
30-second carry, funded eligible depth, margins, leverage ceilings, reserve
checks and hourly promotion remain unchanged. With continuous observations,
the initial 60-second INDEX history permits usable depth, followed by 180 seconds
of BASIS history while PERP warms alongside it. That is approximately four
minutes of history building, **plus the wait for a successful hourly rollover**.
A gap or unavailable depth can extend it. Full windows alone do not grant a
MARK before epoch promotion or guarantee an executable leveraged order.

## Deployment and verification

These changes only affect new bytecode. Existing markets keep their original
windows, collateral and positions. There is no environment switch or upgrade
that changes an existing engine.

Use the normal integration build and artifact integrity checks described in
[the deployment runbook](DEPLOYMENT_RUNBOOK.md). The deployable engine remains
`RegistryBookRiskEngine` in `oracle/out`; no generated source overlay or alternate
artifact directory is used. Verify the current source and creation/runtime code
hashes rather than trusting a chain ID or an old market's legacy getter names.

The current factory pins the engine creation code immutably. Deploy replacement
code stores and a factory, authorize the factory through the existing governance
delay, and create fresh listings. The replacement factory creates a **new shared
vault**. Rehearse the exact transactions and measure gas before public execution.
Update deployment manifests, service pins, indexer configuration, frontend
routes and addresses only after canonical verification. Preserve routes and
withdrawal access to old markets/vaults; allocations do not migrate automatically.

Before activating services for each new engine, call `pricingWindows()` on the
actual target chain and require exactly `(60, 60, 180, 30)` on testnet. A missing
getter, unexpected tuple, or mismatched code hash fails deployment verification.
Local rehearsal of testnet timing must explicitly use chain ID 10143; an ordinary
31337 local node intentionally keeps production windows.

Focused coverage lives in `TestnetPricingWindows.t.sol` and the configured-window
checkpoint regression in `BookDepthSampler.t.sol`. They verify 59/60- and
179/180-second boundaries, unchanged production windows, stale-gap rejection,
capture consistency and the unchanged epoch promotion requirement.

## Current frontend cutover

After both public deployment directories contain successful canonical
`market-verification.json`, `source.json` and `calibration.json` files, stage the
selection from the repository root:

```sh
node scripts/e2e/migrate-fast-testnet.mjs stage \
  tmp/redeploy-20261009/fast-profile/public-migration \
  artifacts/deployments/monad-testnet-20261009-fast-btc-oct10 \
  artifacts/deployments/monad-testnet-20261009-fast-eth-oct11
```

Review `migration-stage.json` and the first public directory's
`frontend-selection/` files. The runner pins the public inputs, re-reads the
canonical pricing tuple and runtime, preserves every prior engine with its
original contracts, and exports `pricing-profile.json`. Stop the frontend on
port 3100 before running the same command with `apply` instead of `stage`.
The apply command changes only the four frontend selection files. It never
starts services, moves collateral, edits Privy policies or changes the live indexer.
Caught errors restore the original file bytes. If the process is killed during
`applying`, keep the frontend stopped: inspect `migration-stage.json`, restore its
`beforeText` files if needed, and reconcile the partial application before
manually clearing that process's stale lock. The runner never removes stale locks
or silently resumes a partially applied selection.

After application, synchronize the **repository defaults** with
`node oracle/indexer/scripts/current-config.mjs --write`, then build/restart the
frontend and use the runner's `installed` command for file consistency. The
prepared build/start runner pins the existing Node 22.23.3 executable and reads
the unchanged `frontend/.env.local`:

```sh
node scripts/e2e/restart-fast-frontend.mjs build tmp/redeploy-20261009/fast-profile/public-migration
node scripts/e2e/restart-fast-frontend.mjs start tmp/redeploy-20261009/fast-profile/public-migration
```

These commands refuse an occupied port 3100; they never kill a process. Build
uses `next build --webpack`, including Next's TypeScript validation. Start requires
the exact successful build and configuration fingerprints. Logs and PID records
remain under the private migration directory. After an interrupted build, inspect
the recorded build PID before clearing a stale operation lock.

The running indexer uses `tmp/redeploy-audit-20261007/indexer/config.yaml` and the
`eros_redeployment_20261007_ready` database. Keep that dynamic-discovery
configuration and its database unchanged. Factory/listing events register the
replacement factory, engines, vault and token. Do not run default code generation
over that live indexer's build or use Envio's destructive `-r` reset flag.

The registry factory change temporarily invalidates the old current frontend
manifest; include that interval in the cutover maintenance window. Archived
verification intentionally retains the original factory/vault binding without
requiring that old factory to remain the registry's current factory.

Direct embedded-wallet signing needs no server delegation policy. If trade or
protect delegation is configured, regenerate its reviewed Privy policy from the
new selection, update or replace the hosted policy, and verify the exact engine
allowlist before enabling it. Replacing a policy ID also requires the wallet's
corresponding permission. Preserve pending requests and the automation database.

Archived balances stay on their original engines. Release still requires the
old engine's fresh INDEX even for a flat account; withdrawal only moves existing
free collateral from that old vault. There is no automatic cross-vault migration.
