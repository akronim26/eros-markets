# Hackathon service verification — 6 October 2026 (IST)

**CRE's simulation route works without deployment access. The local service is
running again. This is not yet a public frontend-to-real-engine settlement demo.**

## What was verified

The actual CRE CLI v1.36.0 compiled and executed `resolution/main.ts`, read the
deployed oracle's FeedSpec, fetched the public MLB API for game 849835, evaluated
the finished game's home score against zero, produced YES and submitted its report.
The oracle accepted it. An assertion succeeded, the local clock advanced through
120 seconds of liveness, and the engine accepted final YES with claims enabled.

These new transactions were on an **isolated local fork of Monad testnet at block
68,172,097**. No public market was changed by the verification. The engine is the
deployed `ResolutionEngineStub`, which holds no trader positions or cash. This
test demonstrates real CRE orchestration and contract acceptance; it does not
demonstrate a trader payout from the live frontend's book.

- [CLI output](cre-simulation.log) and [complete run](run.json)
- [On-chain FeedSpec and allowed source](feed-spec.json)
- [Previously successful public report receipt and current roles](live-roles.json)
- [Live factory and indexed market state checks](live-market-state.json)

The historical public CRE report receipt was independently verified as successful:
`0xeb0b9e751e27c7c627fb03585035129d7078a5cb2259c97eb87f129fe18dadb1`.
The new `reportTx`, `assertion` and `finalization` in `run.json` are **fork-only**
hashes, not new public explorer transactions.

## Service repair and current setup

The old supervisor and listener ran from a separate Desktop checkout. The CLI was
repeatedly failing with Monad's `eth_getLogs is limited to a 100 range` error and
never exiting, so its supervisor never recovered it.

Replaced that process with this checkout's listener:

- Every scan covers at most 100 finalized blocks.
- Cursor and pending requests are saved together; restarts retain them.
- Each queued event runs through the real CRE CLI using its transaction hash and
  receipt-local event index. The wrapper does not construct or sign oracle reports.
- Chain state is checked before retries; already handled requests are skipped.
- A chain/oracle/target/mode mismatch or changed checkpoint block fails closed.
- The public-data local target no longer requires an unused SportsData secret.

The wrapper itself executed CRE successfully on the fork. A later pass resumed
the checkpoint without repeating the report: [listener evidence](listener-fork.log).

The replacement live supervisor started as PID 58105. Its persistent directory is
`oracle/workflows/listen/logs/`. It caught up with the testnet head with zero queued
requests and survived a deliberate graceful child restart:
[before restart](listener-live.log), [after restart](listener-live-after-restart.log),
[supervisor log](listener-supervisor.log), [checkpoint](listener-live-checkpoint.json).
PIDs and balances are observations from this run and can change.

On-chain checks confirmed simulation mode, the expected simulation forwarder,
an authorized relayer, and positive MON balances for relayer, keeper and lister.
Of 68 indexed IDs checked, 67 were Final and one returned None; none was L1Pending.
The registry factory remains the test stub factory. The existing keeper and panel
runner were preserved; a live watchdog process was not found. Local watchdog
tests pass, but this does not establish an active public watchdog service.

## Automated checks

| Check | Result |
| --- | --- |
| First-party TypeScript workflow, package and service tests | 555 passed |
| Local keeper lifecycle and concurrent keeper tests | 6 passed |
| Local committee / watchdog / panel lifecycle tests | 2 / 2 / 4 passed |
| Oracle Solidity, UMA, seam, fuzz and invariant suites | All 39 suites passed; pinned runner reports 342 tests |
| Real factory + book + risk + oracle under Monad execution rules | 37 passed |
| Frontend unit / server integration tests | 28 / 7 passed |
| Envio indexer tests | 38 passed |
| Workflow, listener, keeper and frontend typechecks | Passed |
| Listener shell syntax, lockfile install, changed Solidity formatting, diff whitespace | Passed |

Foundry v1.8.3 (the CI pin) was downloaded from the official release and checked
against its published SHA-256. Its Monad integration command was:

```sh
FOUNDRY_PROFILE=integration forge test \
  --match-path 'test/integration/*.t.sol' \
  --network monad --hardfork monad:MonadTen --isolate
```

It was used from `/tmp/eros-foundry-v1.8.3`; the global v1.5.1 installation was not
replaced. The older binary lacks the Monad flags; running the integration gas test
with ordinary EVM rules failed. The pinned Monad run passed. Its newer aggregate
test counting differs from v1.5.1, which reported 357 passing oracle tests; all
named invariants also passed in the pinned run.

Additional issues fixed during verification:

- Installed locked Bun dependencies and initialized pinned Solidity submodules.
- Corrected macOS `/var` versus `/private/var` path expectations in an SDK test.
- Corrected separately compiled UMA artifact paths in two test fixtures.
- Fixed keeper fixture enrollment to derive its runtime hash from a created local
  engine before restoring the unlisted baseline. Runtime checks remain enabled.
- The initial broad Bun filter accidentally selected vendored UMA JavaScript
  tests. Final unit results use explicit first-party test-file paths and exclude
  fork suites, which are reported separately above.

Raw logs are in this directory. Model-provider calls in the panel service tests
use fixtures; they do not establish live availability of every LLM provider.

## Repeat the demo test

```sh
cd oracle/e2e
CRE_BIN="$HOME/.cre/bin/cre" bun src/verify-cre-fork.ts
```

The script starts its own loopback-only fork, uses the configured relayer key only
on that fork, runs the real CLI, verifies the full lifecycle, saves evidence, and
cleans up its temporary signing env file and Anvil process. Port 8559 must be free
or set `CRE_TEST_PORT`. Public RPC/archive access, the public MLB API and an existing
CRE CLI login must remain available. No SportsData key is needed for this feed.

For listener operation and recovery, see [the service README](../../../oracle/workflows/listen/README.md).

## Remaining hackathon work

1. Record and submit the required video, up to two minutes, showing the successful
   CRE CLI simulation and explaining its orchestration. No submission video was
   created or verified in this task.
2. If the demo promises a live trader-to-oracle-to-payout flow, activate/list a real
   oracle-backed market and verify it through the frontend. The current live
   factory is still the test stub factory. The 37 local integration tests do not
   perform public activation.
3. Keep this machine and supervisor running for a local demo, or deploy the service
   to an always-on host for unattended public availability. This task did not
   provision hosting or an operating-system boot service.

The supplied bounty explicitly accepts successful CLI simulation. Chainlink DON
deployment approval is therefore not needed for that submission route. Existing
Privy/Envio configuration does not need to be supplied again. Earlier frontend
activation and optional delegated-signing requirements remain in
[the frontend progress report](../../../frontend/INTEGRATION_PROGRESS.md).
