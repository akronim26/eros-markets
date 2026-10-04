# Stream hints and reconnect recovery

Original milestone 4 / PF012 implements public market subscriptions alongside
the existing complete REST collector. REST book and metadata bytes remain the
only inputs to the calculator and observation builder. No incremental book is
merged, and no source timestamp is generated from arrival time or a heartbeat.

## Using it

Streaming is an explicit diagnostic option. Existing commands default to periodic
REST collection. To enable hints for the read-only service:

```sh
./node_modules/.bin/node dist/src/cli.js serve \
  --configs config/collection.example.json --db var/stream-source.sqlite --stream-hints true
```

The configs input is an array of existing validated worker configurations.
The same `--stream-hints true` option is supported by `serve-monad-testnet`, with
its existing required dossier, keys, journals and finite budget. Hints affect
collection only: they do not accelerate the twenty-second diagnostic publisher,
authorize extra transactions or change its spending policy. No paid streaming
campaign is claimed by this milestone.

The standalone public-data probe requires a disabled config and a fresh database:

```sh
./node_modules/.bin/node dist/scripts/probe-market-stream.js \
  artifacts/monad-testnet/market-config.json \
  var/verification/stream/live-source.sqlite 50 22
```

Arguments are config, fresh diagnostic DB, duration seconds (30-300), and deliberate
disconnect time. It imports no RPC or signing adapter and sends no transactions.
It refuses an existing DB, including WAL/SHM files; preserve earlier archives and
use a different diagnostic path when repeating it.

Independent checksum/raw-body/source-time replay is available without Node:

```sh
python3 scripts/review-market-stream.py \
  var/verification/stream/live-source.sqlite artifacts/stream/live-probe.json \
  artifacts/monad-testnet/market-config.json
```

## Transport and refresh policy

The pinned public endpoint is
`wss://ws-subscriptions-clob.polymarket.com/ws/market`. One connection subscribes
to the configured outcome-token set with `assets_ids`, `type: market` and
`custom_feature_enabled: true`. Application `PING` is sent every ten seconds;
an expected `PONG` must arrive within the diagnostic five-second timeout.
These fields follow the current official
[Polymarket market-stream documentation](https://docs.polymarket.com/market-data/realtime-data).

Book, price-change, last-trade and best-bid/ask events wake only workers matching
both condition ID and token ID. Their prices, depth, hashes and timestamps are
not used as authoritative evidence. Tick-size and market lifecycle hints also
invalidate cached publication evidence and require metadata revalidation. A
source resolution message cannot resolve Eros or replace its oracle.

Each worker has one pending refresh slot. Bursts coalesce, polls never overlap,
and diagnostic hints cannot start requests more frequently than once per second.
Periodic collection still runs at the configured interval, including quiet markets
and stream outages; a faster configured periodic interval remains explicit.
The existing shared REST limiter and bounded retry/timeout policy apply to every
request, regardless of its trigger. Slow markets have independent loops.

Each connection attempt increments a generation. Connection/open/disconnect,
timeout, malformed frame and lifecycle uncertainty require a new complete REST
read. Detached callbacks and in-flight results from an earlier resync revision
cannot restore cached eligibility. Reconnect does not clear durable source order,
rule/status baselines, quarantine, signing sequences or transaction nonces.
Healthy REST results may resume during a stream outage; stream transport liveness
is not required to declare a verified REST book fresh.

The native Node 24 WebSocket client is used without an additional dependency.
Frames must be text, at most one million UTF-8 bytes, with at most 1,000 events
or nested changes. The entire routing batch is checked before requesting any
refresh. Unknown event types and unrelated identities are ignored; malformed
known events, binary or oversized frames reconnect conservatively. This limit
applies after the native client receives a frame; it is not a transport-level
preallocation limit. Stream data is untrusted and cannot establish source identity.

Reconnect uses capped exponential backoff with jitter (diagnostic 1-30 seconds).
Opening alone does not reset backoff; an expected PONG must succeed. Connect and
PONG deadlines are bounded. Abort detaches handlers, closes sockets, wakes timers
and drains collection. Worker/callback failures stop the coupled service.

The optional Monad publication guard also checks resync eligibility before
signing, after signing, before nonce reservation and before broadcast. A disconnect
can leave an immutable signed packet awaiting a full refresh. It never retimestamps
or silently deletes that packet. A nonce already reserved before the guard blocks
remains subject to the existing explicit relay recovery policy.

## Verification and limits

`npm run test:transport` covers subscription/routing, heartbeat silence, missed
hints, reconnect generation isolation, malformed batches, burst coalescing,
periodic fallback, cache invalidation and metadata changes. The full Node suite
also exercises the publication guard using real encrypted local signing journals
with scripted chain counterparts. These tests do not spend MON.

Compact results are retained in `artifacts/stream/` and
`artifacts/verification/stream-unit.json`. Raw TAP output and the live REST SQLite
archive stay in ignored `var/verification/stream/`; they are not pushed. The report
records their hashes, and another checkout must rerun the probe/tests to generate
its own local archives. Earlier historical evidence is unchanged.

Actual checks on 05 October 2026: build exit 0, final Node suite **378/378**,
focused transport suite **36/36**, wire compatibility exit 0, **144** independent
impact vectors and **5** independent coverage cases. The 50-second public probe
made two connections around a deliberate disconnect at 22 seconds, received four
PONG replies and routed 450 hint events into 45 REST captures. Forty-four were
COLLECTING; one in-flight capture was correctly DEGRADED as STREAM_RESYNC_REQUIRED.
Independent Python replay verified all 45 checksums/raw representations and all
44 eligible original timestamps; four tamper cases were rejected. The five active
Monad journals remained byte-identical. No MON was spent.

This completes diagnostic stream integration, not production admission or sustained
TWAP certification. Provider clock semantics, approved cadence/load targets,
production mappings/calibration and the deferred 268/300 Monad coverage failure
remain open under their original milestones. The next original milestone is
transaction recovery and signer custody.
