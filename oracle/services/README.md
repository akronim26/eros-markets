# Oracle service configuration and recovery

The keeper, panel runner, watchdog and committee console default to
`frontend/src/config/public-manifest.json` on `NETWORK=monad-testnet`. They use its
verified contract addresses, deployment blocks and collateral token. Set
`DEPLOYMENT_MANIFEST` to select another verified public manifest, or
`DEPLOYMENTS_FILE` to select an explicit legacy deployment record; never set both.
Historical deployment records and evidence have not been rewritten. The keeper
still requires a compatible `ENGINE_IDENTITIES_FILE` and its existing gas table.
Deploy from a checkout that includes `frontend/src/config/public-manifest.json`,
the oracle SDK/ABI files and the selected gas table. If packaging the services
without the frontend directory, copy that reviewed public manifest into the runtime
image and set `DEPLOYMENT_MANIFEST` to its absolute readable path. The indexer
configuration tools currently require the checkout's frontend manifest path.

From each service directory, `bun run start` runs the keeper, panel or watchdog;
the committee console remains an operator command (`bun run console ...`). Install
the pinned oracle workspace dependencies first. Keys, models, calibration maps,
gas limits and evidence sources must match the selected deployment's on-chain
configuration. Selecting a manifest does not authorize a key or validate those
operational settings against the live chain.

## Panel runner

Keep `SNAPSHOT_DIR` on persistent storage. Alongside evidence and model answers,
`submissions/<chainId>-<oracle>/<marketId>.json` records the attempt before sending,
then the transaction hash, and finally confirmed or reverted execution. The runner
only marks a submission complete after a successful, canonical finalized receipt
contains its oracle's matching `PanelResultAccepted` event (market, phase and
evidence hash). Pending receipts and RPC failures are reconciled on subsequent
polls, including after a restart or after the market leaves its panel state. A
finalized revert permits a fresh run on the next poll. Missing or replaced
transactions remain pending and require investigation, rather than automatic
resubmission.

The process lock prevents two writers using the same deployment journal. After a
forced kill, confirm the recorded PID is dead before removing `runner.lock`.
Use one active process and a dedicated sending key; separate storage directories
do not coordinate nonces. Back up the evidence and submission journal together.

A crash or RPC failure during broadcast may leave `status: "broadcasting"`
without a hash. The runner stops sending for that market. Reconcile the relayer's
transaction and nonce with the chain. If the matching transaction is found, stop
the runner, preserve the original record, set its `result.sent` to that hash and
its status to `pending`, then restart so receipt verification can finish. Do not
delete the marker or mark it reverted merely because a receipt is unavailable.
An unresolved broadcast needs operator recovery; this is not a signed-transaction
outbox capable of automatically recovering a missing hash.

State-change scans use finalized blocks in inclusive ranges of at most 100 and
resume at the actual last block plus one. A failed poll commits no cursor advance.
The cursor itself is in memory: restart replays from the deployment block (or an
explicit `FROM_BLOCK`), while durable submissions prevent duplicate completed or
pending work. Set a later `FROM_BLOCK` only after accounting for older unprocessed
markets.

## Watchdog testnet timing

The default dispute margin remains 600 seconds. The current testnet listings use
120/120/300-second L1/automatic/reviewed assertion windows. For this deployment,
explicitly set `WATCHDOG_TESTNET_DISPUTE_MARGIN_SECS=30`; the example environment
includes it. Overrides are restricted to 30–599 seconds and require both the
configured deployment and actual RPC to be Monad testnet chain 10143. They are
rejected for production and every other network.

Startup validates every market in the selected public manifest; newly discovered
proposals validate all three immutable windows again. Each window must exceed the
margin. An incompatible startup fails; incompatible runtime proposals page and
do not dispute. No listing durations are changed. The deadline is checked again
after dispute simulation so elapsed RPC time cannot silently consume the margin.

Short-margin mode limits each model check to one 20-second attempt. Ordinary mode
retains its existing model timeout and retries. The service still checks the live
assertion expiry before sending, and pages when too late. Polling, provider latency,
queued work and transaction inclusion can still consume a 120-second window;
this testnet setting is not a guarantee that every contradiction can be disputed.

## CRE and indexer

The CRE listener now defaults to `TARGET=fresh-testnet`, checks the workflow oracle
against the same manifest and starts first-time replay at the oracle deployment
block. Keep its state directory on persistent storage. `TARGET=local-sim` explicitly
selects the historical deployment. See `../workflows/listen/README.md`.

In `oracle/indexer`, the default config, fresh-testnet config and handler filters
select the current frontend deployment, including all its trading engines. The
shared external simulation forwarder is a separate network constant, not a
contract deployed by the frontend manifest. `pnpm run config:check` rejects stale
contract filters or start blocks. After deliberately changing the public manifest,
run `pnpm run config:sync`, review the generated address changes, then
`pnpm run codegen` before starting an indexer against its correctly selected
database. Default `codegen`, `dev` and `start` commands perform the consistency
check and set `ENVIO_DEPLOYMENT=current`. Existing historical databases are not
reset or migrated by this change; use an isolated database for a new deployment.
