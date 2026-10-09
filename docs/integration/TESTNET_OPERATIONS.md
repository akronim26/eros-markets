# Supervised Monad testnet operations

This runbook covers the replacement fast-testnet deployment and its prepared demo
workers. Use the current public manifest, canonical chain state and retained
receipts as the authority for addresses and trading readiness.

**Overnight status:** transaction-producing workers remain stopped to avoid idle
MON expenditure; frontend and the existing persistent indexer are separate. Fresh
operator MON funding, maker collateral seeding and prewarming remain for the next
session. Trading tests are deferred at the user's request. Deployment reserve
collateral is separate from maker funding.
Do not start the supervisor merely because its configuration and journals exist.

## Services and private state

| Service | Scope | Required work |
| --- | --- | --- |
| Price publisher | One per market | Collect authentic Polymarket books, sign and finalize INDEX observations |
| Market operations | One per market | Capture/seal book observations, finish epoch rollover and run enabled liquidation scans |
| Maker | One per market, two separate owners | Maintain funded two-sided depth within position, gas and action limits |
| Indexer | Shared | Serve deployment-bound history from its persistent database |
| Frontend | Shared | Serve the terminal and private read-RPC proxy |
| Supervisor | Shared | Validate service pins, run workers and report bounded restart/block decisions |

For two active markets this is eight application processes plus the supervisor. Resolution
and optional delegated-order services have separate enrollment requirements; this
runner does not enable them. Liquidation remains necessary for exposed accounts;
insurance/reserves handle residual deficits and do not replace liquidation.

The current local supervisor configuration is
`tmp/redeploy-20261009/fast-profile/supervisor.json`, with status/logs under
`tmp/redeploy-20261009/fast-profile/supervisor/` and RPC credentials in
`tmp/redeploy-20261009/rpc-pool.env`. The configuration selects each market's
public deployment directory and private role/journal directory. Keep these private
directories on durable storage, excluded from Git, with restricted file access.
Backups must include all publisher journals and operator/maker outboxes together;
see [publisher operations](../../packages/pricefeed/docs/operations.md).

The user selected two active demo markets: BTC above $82,000 on October 10
(`monad-testnet-20261009-fast-btc-oct10`) and ETH above $2,400 on October 11
(`monad-testnet-20261009-fast-eth-oct11`), under `artifacts/deployments/`.
All four superseded current markets remain accessible through archived frontend
routes, alongside older archives. Their operator MON was recovered after clean
shutdown and their runtime identities are retired. Retain original journals,
retirement evidence and user balances; do not restart the retired supervisor paths
or remove retirement markers. Old-market live prices and trading readiness are
not maintained. Existing allocations remain in their original engines/vaults and
do not migrate to the new shared vault.
The user's prior 20 TUSDC in each superseded BTC/ETH market remains archived;
the new markets require separate user funding before trading.

The frontend manifest is `frontend/src/config/public-manifest.json`. The supervisor
requires matching engine/runtime/listing/source identities, unique sender roles,
and unchanged preparation hashes. Never copy another market's journal to initialize
a listing. Restarting does not replenish gas or renew a publication budget.

Optional read-only inspection tools require an explicit deployment directory:

```sh
mkdir -p tmp/current-btc-keeper-observation
bun scripts/e2e/keeper-observer.ts tmp/current-btc-keeper-observation \
  artifacts/deployments/monad-testnet-20261009-fast-btc-oct10
node scripts/e2e/selected-source.mjs tmp/new-source-candidate \
  artifacts/deployments/monad-testnet-20261009-fast-btc-oct10
```

The keeper observer requires the supplied market to match the current frontend
selection and cannot broadcast. To inspect ETH, use
`artifacts/deployments/monad-testnet-20261009-fast-eth-oct11` and a separate evidence
directory. The source qualifier reads a prepared candidate directory containing
`metadata.json`, `event.json` and `selected-market.json`; the public deployment
provides only its collector configuration template. It collects fresh source
evidence without signing or altering a deployed market. These are manual
inspection tools, not prerequisites to opening the frontend.

## RPC pool and writer safety

Keep these variables in private configuration; never expose provider credentials
through `NEXT_PUBLIC_*` or browser code:

| Variable | Meaning |
| --- | --- |
| `MONAD_TESTNET_RPC` | Primary writer and first read provider |
| `MONAD_READ_FALLBACK_URLS` | Up to seven comma-separated HTTPS read alternatives |
| `MONAD_READ_RPC_CAPACITIES` | Concurrent requests per endpoint, primary first; defaults to eight each |
| `MONAD_FRONTEND_READ_FALLBACK_URLS` | Optional frontend-specific alternatives |
| `MONAD_FRONTEND_READ_RPC_CAPACITIES` | Optional frontend-specific capacity limits |

Each endpoint must pass chain 10143, recent finalized-head and explicit block/hash
checks. Reads use bounded queues, provider cooldowns, request coalescing and supported
batching. A pinned snapshot retains its block hash across failover. Capacity is per
process, not a provider-wide quota: include all workers and frontend processes when
choosing limits. Prefer independent providers; several credentials for one upstream
do not eliminate a shared outage.

Pending nonces, signing balance checks, simulation, gas estimation and transaction
broadcasts retain a coherent primary writer. Read recovery never randomly changes
the writer or signs a replacement transaction. Before changing the primary, stop
the affected group, reconcile exact saved signed bytes and canonical receipts, and
verify sender nonces on the proposed endpoint. Preserve missing-receipt ambiguity;
it is not evidence that a transaction reverted.

Run this isolated read-only drill after building the pricefeed:

```sh
node scripts/ops/check-read-failover.mjs tmp/redeploy-20261009/rpc-pool.env tmp/redeploy-20261009/read-failover-evidence.json
```

The drill checks each provider, pins a finalized block, then injects one synthetic
429 into its own primary read adapter. It verifies the fallback's balance and
original block hash without disturbing workers or sending transactions. The
2026-10-08 21:33:20 UTC run passed across three providers at block 69363145. This is
read-transport evidence, not proof of a real provider outage or writer failover.

## Next session: fund, start and prewarm

1. Complete the reviewed fresh operator MON funding and separate maker collateral
   allocations. Then check current source identities, genuine timestamp continuity, calibration,
   reserve funding, role gas balances and remaining cumulative publication budget.
   Check measured liquidation gas is enrolled when liquidations are enabled.
2. Confirm there are no competing writers for these wallets. Review retained locks,
   pending raw transactions and last receipts before recovering an interrupted run.
   Never clear a lock or journal solely to make startup pass.
3. Build reviewed code and validate deployment/service pins from the repository root:

   ```sh
   npm --prefix packages/pricefeed run build
   packages/pricefeed/node_modules/node/bin/node scripts/ops/market-supervisor.mjs check tmp/redeploy-20261009/fast-profile/supervisor.json
   ```

   `check` is read-only. A policy change requires updating its reviewed preparation
   record; bypassing a hash mismatch is not a recovery procedure.
4. Retain the existing indexer and its `eros_redeployment_20261007_ready` database.
   Its runtime config is `tmp/redeploy-audit-20261007/indexer/config.yaml`; dynamic
   factory/listing discovery includes the replacement vault and engines. The
   repository's `config:check`/`config:sync` commands concern future default builds;
   do not regenerate the live `.envio` build from those defaults or reset its data.
5. Run the supervisor under the chosen host process manager:

   ```sh
   packages/pricefeed/node_modules/node/bin/node scripts/ops/market-supervisor.mjs run tmp/redeploy-20261009/fast-profile/supervisor.json
   ```

   This starts funded workers and can sign authorized upkeep transactions. The
   local runner is not itself installed as an operating-system startup service.
   Prevent host sleep and provide persistent storage and host-level supervision.
6. Build/start the frontend with its private environment and current public manifest:

   ```sh
   npm --prefix frontend run build -- --webpack
   npm --prefix frontend run start -- --port 3100
   ```

   Avoid a second process on an occupied port. Rebuild after changing embedded
   public configuration. Keep production and E2E manifests/builds distinct.
7. Prewarm through an actual successful UTC-hour epoch opening. Verify canonical
   readiness and a real round trip before admitting the demonstration wallet.

The replacement engines on chain 10143 require INDEX 60 seconds, PERP 60 seconds
and BASIS 180 seconds, with only 30 seconds of observation carry. Other chains
retain INDEX300/PERP60/BASIS900/carry30. Verify the new engine's `pricingWindows()`;
the legacy `indexTwap300` and `basisTwap900` ABI names read its configured windows.
INDEX must become valid before eligible funded depth can build the later windows.
History building therefore takes approximately four uninterrupted minutes, plus
the wait for a successful hourly opening. Source gaps and transaction delays can
extend that; elapsed time is never a readiness signal. See the
[fast-profile cutover runbook](FAST_TESTNET_PRICING.md).

Before the boundary, operations must capture and seal valid book evidence. After
rollover, old order epochs are invalid and makers must restore current depth
promptly. Maker cleanup physically removes only journal-proven owned stale orders;
`cancelAll` alone does not unlink stale book entries. Cleanup uses a separate
durable cancel-only outbox, up to eight IDs per batch (also bounded by the contract),
four batches per owner/epoch, and at most two million gas per transaction. It does
not count as quote admission. Larger backlogs wait for the next cleanup budget.
Unknown owner orders remain an explicit intervention case.
The epoch-repair path can combine one proven stale own order's cancellation with
its post-only replacement when full simulation admits the complete batch. It
retains one signed outbox and records both outcomes from the canonical receipt;
a skipped replacement never counts as a resting quote. Unsigned crossing/admission
rejections retain cancel-only fallback. Finalized work yields to the other owner,
and pending receipts use a one-second poll rather than the three-second idle wait.
During cold INDEX recovery, the first owner's pricing backoff can postpone the
second owner's cleanup until INDEX is valid. Recheck both owners afterward;
one owner's completed cleanup does not establish that the whole book is clear.

For a two-owner reprice, the second owner may share the first owner's completed
capture wait after that exact reprice has a canonical successful receipt. This
one-use hint lasts at most ten seconds after the receipt and fifteen seconds
from the first signing attempt; it binds the market epoch, risk profile and source
identity. It never bypasses owner, exposure, cooldown, action, gas, nonce, source
freshness or simulation checks. A restart discards the hint, and the second
transaction cannot extend it. Both transactions still use one serialized durable
outbox. This reduces the chance of splitting a reprice across two book captures;
source delay, finality or a slow second owner can still cause a pricing gap.

Sampling now caps the configured cadence at 24 blocks in steady operation, 12
blocks during the last minute, and one block during the last 20 seconds. It still
requires an outstanding coordinated source request and refuses signing within
eight seconds of the boundary. These are scheduling ceilings, not promises of
continuous observations: source publication, canonical finality and capture sealing
also take time. More productive samples increase keeper spending; measure actual
receipt costs and fund the next operating period before extending runtime. Judge
continuity by accepted PERP/BASIS event timestamps, not transaction counts or the
time since rollover finished. No timestamp or 30-second carry limit is changed.

The publisher protects a known, unsealed book capture by selecting an authentic
source observation strictly after that capture. Its preference expires at the
capture's 30-second lifetime minus an eight-second delivery reserve. Unknown or
newer outstanding captures retain the earlier accepted-INDEX deadline, so an
unavailable keeper cannot freeze publication indefinitely. Publishing an older
source inside this interval can rewrite the capture-time INDEX checkpoint and
invalidate otherwise eligible book evidence. Waiting for a newer source can
briefly make live INDEX unavailable; this scheduling policy does not guarantee
uninterrupted pricing or change source timestamps or contract admission.

The October 8 22:39:55 UTC planned stop drained all six demo workers with exit
code zero. They resumed the same retained journals at 22:40:22 UTC with the
reviewed coordination change. Startup is recovery evidence only; verify subsequent
canonical publications and samples before treating the restart as healthy.

## Health and recovery

Read `status.json` for heartbeat, process PIDs, restart counts and blocked reasons.
A `running` status describes processes only. Monitor independent canonical reports
for source timestamp/sequence, complete pricing windows, current epoch/accounting
work, eligible depth, actual buy/sell caps, reserve/account coverage, gas/budgets,
and indexer lag. Keep these diagnostics in operator reports; they are not additional
terminal UI. Neither MARK availability nor a configured 5× ceiling guarantees
admission of a particular 5× order.

| Symptom | Operator response |
| --- | --- |
| RPC timeout/429 or stale endpoint | Allow bounded read recovery; inspect sanitized provider evidence and aggregate quota. Keep the writer unchanged until its pending work is reconciled. |
| Polymarket timestamp gaps | Inspect archived raw source books and sequence continuity. Additional RPCs cannot manufacture missing external observations. Rebuild coverage or qualify a new source. |
| Supervisor blocked or exit 78 | Read the exact failure and outboxes. Identity, nonce, canonicality, funding and unknown failures require review; repeated restarts do not resolve them. |
| Low worker gas or budget exhausted | Fund the actual sender; reconcile idle journals and use supported `plan-monad-budget` / `apply-monad-budget` for a reviewed cumulative budget extension. Never edit budget journal rows. |
| Maker waits or stale crossing depth | Inspect both owners' physical order IDs, canonical placement receipts, current epochs and cleanup logs. Preserve post-only behavior; do not sweep stale depth with IOC. |
| Missed opening or incomplete history | Restore source/book continuity and bounded rollover, then await a valid subsequent opening. Do not force readiness or lower freshness checks. |

Send SIGTERM to the supervisor for a planned stop. Allow workers to preserve or
reconcile signed pending transactions before exit, then check final stopped/blocked
status and PIDs. An abrupt host failure can leave legitimate locks; inspect process
identity and all signer nonces before manual lock recovery. Do not run two instances
against the same journals or wallets. Automatic transient restart is bounded to
five attempts and never renews budgets.

## Fresh demo listings with the existing infrastructure

Changing an immutable source/listing requires a new market. When bytecode and
pricing constants stay unchanged, first verify that the current factory/vault,
registry/oracle bindings and governed roles can admit the new listing. There is no
automatic requirement to replace stores, factory or vault merely to select a new
event. The current fast profile did require replacement stores, factory, vault and
listings because the engine bytecode changed; existing engines were not upgraded.

1. Qualify the exact event, condition, YES token, rules and settlement schedule using
   fresh source captures. Require sustained authentic timestamp updates, adequate
   two-sided depth and acceptable spread; retain failures as evidence.
2. Prepare a new listing and market identity. Recheck immutable sampling-depth/OI
   limits, risk calibration, reserve collateral and assertion/watchdog funding.
   Rehearse the exact governed listing/funding/profile transactions on a disposable
   pinned fork using the verified existing infrastructure.
3. After authorized public execution, verify canonical receipts, runtime hashes,
   engine/vault/registry bindings and source identity. Record the deployed addresses
   and blocks; fork predictions do not count as deployed contracts.
4. Enroll new publisher/signer/keeper/maker roles, private journals and measured gas
   policies. Generate fresh service pins and preparation hashes. Update the public
   manifest, indexer configuration and supervisor group consistently; preserve old
   users' balances and access to their positions.
5. Repeat prewarming and acceptance on the new addresses. Existing observations and
   transaction proofs do not transfer to the replacement market.

See [deployment preparation](DEPLOYMENT_RUNBOOK.md) for artifact, governance,
collateral and rehearsal requirements, and [E2E testing](E2E_TESTING.md) for the
separate SDK, browser and real-wallet evidence boundaries.

Acceptance requires canonical evidence of continuous normal pricing through an
opening and subsequent rollover, executable current depth, actual directional
leverage admission, and a frontend wallet flow from funding through fill, close,
realized exit value, release and withdrawal. Exercise the four YES/NO long/short
labels against their canonical directions. Record unavailable caps and pending
human login honestly; process uptime, an SDK-only trade or a successful receipt
without its expected fill does not complete the frontend checkpoint.
