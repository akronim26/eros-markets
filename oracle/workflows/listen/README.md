# CRE simulation service (Monad testnet)

The listener polls finalized `ResolutionRequested` logs in ranges of at most 100
blocks, saves a durable queue and cursor, and invokes **the real CRE CLI** for each
request. CRE reads the market's FeedSpec, fetches the external API, evaluates it,
creates the report and sends it through the configured simulation forwarder.
This is a self-hosted simulator, not a deployed CRE DON workflow.

The older direct `cre ... --listen` loop could become permanently stuck after its
cursor fell more than 100 blocks behind the Monad RPC. Restarting it also lost the
cursor. The new wrapper bounds every log read and resumes its saved queue.

## Start

Install pinned dependencies with `bun install --frozen-lockfile` in `oracle/` and
`oracle/workflows/resolution/`. Install and log in to the CRE CLI. The workflow env
file needs `MONAD_TESTNET_RPC` and `CRE_ETH_PRIVATE_KEY`; the key's public address
must be an authorized, funded sim relayer on the deployed oracle.

```sh
oracle/workflows/listen/supervise.sh /absolute/path/to/cre-service-state
```

Stop an existing listener before starting another against the same relayer.
The state directory contains `checkpoint.json`, a process lock, supervisor logs
and per-execution CRE logs. Keep this directory on persistent storage.

On first start, the default `fresh-testnet` service scans from the current verified
oracle's deployment block. The explicit historical `local-sim` target starts at
the most recent 100 finalized blocks. For a
known outage, set `START_BLOCK` to the earliest unprocessed block on the first
start. It is ignored once a checkpoint exists. Only markets still in `L1Pending`
are executed. Events for resolved/escalated markets are skipped. Pending requests
are retried after 60 seconds, with chain state checked before each attempt.
If the process dies during broadcast, this same state check avoids replaying an
already accepted report. The contract also rejects reports outside `L1Pending`.
The wrapper does not bypass the market's escalation or finality rules.

`BROADCAST=0` executes without submitting reports. Use a **separate state directory**
for this mode. `RUN_ONCE=1` performs one bounded intake/processing pass. `CRE_BIN`
and `CRE_ENV_FILE` override the binary and env-file locations. `TARGET=local-sim`
selects the historical deployment; `fresh-testnet` is the default and selects the
current verified frontend deployment. Startup rejects a workflow config whose
oracle differs from that manifest. Both are restricted to chain 10143. Use a separate state directory
when changing deployment/target. The public MLB demo uses `secrets.local-sim.yaml` and
requires no SportsData API key. For private SportsData feeds, configure that key
and select `../secrets.yaml` in the workflow target before running.

`RUN_ONCE` exits nonzero if the pass fails or requests remain queued; a zero exit
does not mean historical catch-up is complete if more than 2,000 blocks remain.

A normal SIGTERM removes the lock. After a forced kill, inspect the PID recorded
in `listener.lock/pid` and remove that directory only after confirming it is dead.
A checkpoint from a different chain, oracle, target or broadcast mode is rejected.
A changed checkpoint block hash stops progress for operator investigation.

## Health and demo evidence

- `tick` logs must keep advancing `nextBlock` with the finalized head.
- `pending` should drain; repeated `request-retry` or `poll-retry` needs attention.
- A `cre-*.log` must show a `proposed:<market>:YES|NO:<transaction>` result for a
  successful binary proposal. Check the transaction receipt and oracle state.
- The keeper must separately assert and finalize the proposal after liveness.
  A CRE proposal alone does not mean the market has settled.
- Record a successful CLI simulation in the required submission video. Tests and
  a self-hosted process do not themselves create that video.

The service does not install a host boot service, provision a server or configure
the keeper. The supervisor runs while its host process is kept alive.

## Repeat the complete CLI verification

From `oracle/e2e`, run `bun src/verify-cre-fork.ts`. It starts its own loopback-only
Anvil on port 8559, forks the deployed testnet stack just before a historical CRE
report, runs the real CLI against the public MLB API, checks report acceptance,
asserts the proposal, advances the local clock through liveness, and checks final
YES settlement with claims enabled. All writes are confined to this fork. It
stops Anvil and deletes the temporary signing env file when done.

Use `CRE_TEST_PORT` if 8559 is occupied and `CRE_BIN` if `cre` is outside PATH.
Evidence goes to a new directory under `oracle/deployments/dryrun/` unless
`EVIDENCE_DIR` is set. This verifies the deployed **test engine**. It does not
activate the real factory or settle a frontend user's position on the public chain.
