# PF023 lifecycle behavior

The plan (pages 16 and 26) and `docs/spec/oracle_interface.md` require the
independent index recorder to continue after an early economic halt through the
fixed `[T-86400, T]` INVALID window. Feed packets cannot resume economics or
choose an outcome, capture job or fallback. Category and venue resolution do
not establish an engine halt.

## Implemented development path

`LocalLifecycle` accepts only disabled chain-31337 configurations with an
explicit `requiredFeedUntil >= scheduledT` and valid listing horizons. A reader
must supply pinned engine/market/source/code/rules/T facts and a canonical named
block with its number, hash and timestamp. This step uses injected fixture
readers; an approved concrete engine lifecycle RPC reader is still required for
production. The existing `localRpcTransport` listing/source-state adapter alone
does not read the engine's halt snapshot.

| Lifecycle mode | Behavior |
|---|---|
| COLLECTING | Before T with a fresh consistent engine checkpoint, use the existing authenticated observation path |
| RECORD_ONLY | Actual engine halt or scheduled T: keep that same independent source path through the configured recording deadline |
| DEGRADED | RPC failure or stale/future checkpoint: archive the problem and block signing/sending |
| QUARANTINED | Pin mismatch, backwards/inconsistent block, reorg or disappearing halt: preserve quarantine across restart; require review |
| STOPPED | A verified block strictly beyond requiredFeedUntil stops source polling and publication; retain all evidence |

The deadline itself is included. Local wall time checks checkpoint freshness;
it cannot by itself declare completion. A later recording deadline must be
explicit in the config. These fixture age/deadline choices are not an approved
production cadence, finality or grace policy.

Lifecycle and source availability are separate. A source that starts
closed/untradeable produces DEGRADED/gap diagnostics. A subsequent trading-status
change is now archived and persistently quarantined for review; reopening does
not silently restart prices. Source diagnostics continue while the recorder is
required, and the lifecycle scheduler still stops at its verified deadline.
This produces no substituted 0, 1 or 0.5 price, invented timestamp or
oracle callback. Raw book pricing and source timestamps remain unchanged in
RECORD_ONLY. Engine windows decide actual coverage/readiness.

Attach the lifecycle controller to the corresponding `PipelineWorker`. Its
config digest must match. A non-null requiredFeedUntil now requires the controller;
legacy deadline-free diagnostic demos remain available. The continuous scheduler
checks lifecycle before polling; a stopped worker exits independently. The
pipeline rechecks before observation signing, after signing, after relay
simulation before nonce reservation, and after transaction preparation before
broadcast. Receipt reconciliation remains read-only and occurs before publication
gating when `process()` is called.
Source headroom and writer ownership are rechecked after awaited lifecycle reads;
a slow checkpoint lookup cannot authorize an expired source packet.

If transaction preparation crosses the deadline after reserving a nonce, the
immutable raw transaction is retained in QUARANTINED state and is never broadcast
by this path. The shared relay then requires nonce recovery; it must not reuse
that nonce, silently skip it or send a fabricated cancellation. Approved
replacement/cancellation policy remains PF018. Automatic source polling stops
at completion; unresolved delivery needs explicit read-only reconciliation and
operator review, not renewed signing.

## Persistence and verification

Decisions are checksum-protected in a dedicated `lifecycle:` namespace in the
existing fenced WAL/FULL journal. Config/checkpoint-age policy changes and corrupt archives fail
closed. Checkpoint permissions are persisted before returning; expired writer
leases cannot grant output. STOPPED and QUARANTINED survive reconstruction and
clock rollback. A crashed owner's lease must expire before a new owner starts.
The controller now exposes graceful release of its exact owned fence, preserving
the fence counter; a stale owner cannot release a successor. The existing local
pipeline does not call this new method. There is no forced takeover.
Read-only health recognizes lifecycle records alongside source captures and
recalculates block freshness at query time; it does not report old collecting
checkpoints as currently healthy.

## Monad testnet diagnostic monitor

`MonadTestnetLifecycleMonitor` shares the transition/persistence implementation
through a separate fixed chain-10143 wrapper. `LocalLifecycle` remains restricted
to chain 31337. The new concrete reader performs the Monad preflight at one
finalized named block, verifies all existing pins and reads authoritative
`halted()` plus sourceState. It archives source sequence/time; regressions,
same-block changes and a changed observedAt at the same sequence quarantine.
RPC messages are redacted before persistence. This is a read-only monitor,
not permission to publish or a join to Polymarket collection. The Monad watch
CLI releases its owned lease on clean shutdown. See
[monad-testnet.md](monad-testnet.md) for explicit diagnostic settings, commands
and the missing deployment dossier. Actual deployed-engine verification,
publication integration and approved policies/review remain open.

Run from the package with pinned tools:

```bash
PRICEFEED_FORGE=/path/to/forge-1.8.3 PRICEFEED_SOLC=/path/to/solc-0.8.30 npm run test:lifecycle
```

The TypeScript fixtures exercise controller, scheduler and joined publication
boundaries. Four signed Solidity fixtures import existing risk code read-only,
using scripted accounting/book/oracle counterparts. The test actor triggers the
mock oracle; feed samples enter through actual submitObservation with raw
domain-bound signatures. VM time is accelerated, explicitly separate from
Polymarket captures and a real elapsed 24-hour soak.

- Complete history: 4,321 samples at 20-second fixture cadence, 86,400 valid
  seconds, exact TWAP 0.52 from equal 0.42/0.62 half-windows. The unpruned record
  survives the 1,024-entry live ring wrapping; capture/provenance remain immutable.
- Missing history: 4,317 samples, a 100-second inter-sample gap and exactly
  86,330 valid seconds after the existing 30-second carry. Capture stays pending
  until the listed grace; the engine alone applies its disclosed fallback.
- Legacy missing history remains BLOCKED and acquires no unlisted fallback.
- An authenticated thin checkpoint contributes no valid coverage: 86,380 seconds.
- All four retain HALTED/no-admission state, the original funding cutoff and
  once-only freeze; post-halt samples do not resume economics.

Evidence: `artifacts/verification/lifecycle.json`. PF023 remains partial for
named risk/oracle review, authentic oracle/deployed-engine integration, approved
reader/closure/operating policies and actual selected-listing availability.
