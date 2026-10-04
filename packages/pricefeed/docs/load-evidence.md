# Many-market and slow-RPC evidence (PF012/PF018/PF024)

The local workload runner exercises real development bot classes with scripted
venue captures and RPC/blocks/receipts. It gives reproducible failure and ordering
checks plus timing samples; it does not establish production capacity or approve
an operating interval, Polymarket request rate or Monad environment.

Run from this package:

```bash
npm run test:load
```

It builds and runs load, pipeline and service tests, then retains command results,
actual TAP counts, scenario measurements, source hashes and limitations in
`artifacts/verification/load.json` and `load.tap`. These focused tests are also
part of the full `npm test` suite; do not add the counts together.

| Scenario | What is checked |
|---|---|
| 25-worker collection, one held book | Other workers complete multiple polls; no worker overlaps its own book read; raw captures and shutdown drain remain intact |
| 25 markets, three categories, two publication rounds | Fifty signed observations validate scripted receipts; each worker has sequences 1/2; shared nonces are exactly 0–49 with one active RPC operation |
| Twelve signed updates held behind a simulation | Injected 31-second ageing expires unreserved packets with no nonce allocation/broadcast; original fields and signatures remain immutable; fresh updates continue at sequence 2 |
| RPC simulation exceeds two-second timeout | No nonce allocated; late completion cannot broadcast; a fresh retry can deliver the same still-fresh signed packet |
| Eight-worker continuous joined service | A shared-queue expiry returns ordinary results; the service continues collecting and every worker reaches fresh acceptance |
| Twenty-worker burst, provider queue cap four | Queue pressure creates archived truthful gaps; workers recover after the burst; no fallback price or signature is manufactured |
| One hundred collection workers | All initial snapshots archive and drain; shutdown wakes long timers; 101 workers are rejected by the service's declared bound |

Each worker has a distinct event/market/condition/token, market/source ID and
rules manifest. Categories rotate crypto/sports/politics but do not change pricing
or risk economics. Disabled local configurations use chain 31337, N=5,000 lots,
spread=0.05 and public fixture keys. Books are six claims on each side at 0.59/0.61,
giving the independently understood 0.60 midpoint. None is a listing recommendation.
Event membership and raw-book identity are checked through actual Worker/builder
logic; the scripted RPC emits receipt data for the existing decoder/validator.
There is no EVM economic execution or external transaction in this runner.

## Declared settings and measured values

The source limiter spacing is one millisecond for this synthetic burst. Its
normal queue limit is 500; the pressure case uses four. Fixture source latency
is zero/one millisecond and per-RPC delay zero/three milliseconds, with a two-second
RPC timeout, 60-second writer leases and one-second minimum source headroom.
Polling examples in this workload use ten milliseconds, or 60-second scheduler
timers for shutdown testing. These are **test inputs**, not selected production
settings or measured provider limits. Fixture bodies are deliberately small.

The fixture clock follows monotonic elapsed milliseconds from its start. Two
expiry cases explicitly add 31,000 milliseconds; they exercise exact-age handling
without sleeping half a minute and do not count as elapsed source soak evidence.
The runner reports total elapsed time, request counts/concurrency, per-worker
polls, source age and remaining headroom at the scripted broadcast, and elapsed
time between signer completion and simulation entry. The last metric includes
local validation, waiting and retries, rather than measuring pure queue length.
Totals include fixture setup, SQLite and cryptographic work. Values are local
diagnostics; host speed and test scheduling affect them. No wall-time throughput
threshold is silently promoted to a production service-level target.

Inspect `load.json` for measured min headroom and maximum source/signature age;
numbers are retained from the actual run rather than inserted as expected values.
The 25-market two-round test checks headroom at every scripted broadcast remains
at least its declared one-second budget. Real inclusion latency, fee pressure,
finality, venue quiet periods, cross-process/IP limits and larger book payloads
require separate calibration and owned-chain/live-source evidence.

## Queue-expiry fix

Source headroom was already checked before signing and inside the relay. The
new regression showed a packet could age out while waiting for the shared relay
queue: refusal at send time then propagated as an error that could stop the
continuous service. LocalPipeline now checks an unreserved packet again when its
queued operation starts and handles relay headroom exhaustion before reservation
as `EXPIRED / UNSENT_HEADROOM_EXPIRED`.

The allocated sequence is burned, the signed packet/time/bytes remain archived,
and it is removed from pending work. New authentic evidence can allocate the next
sequence. There is no timestamp refresh, fabricated replacement, queue coalescing
or new production invalid/closure priority policy. If a delivery already reserved
a nonce, this normal-expiry path cannot discard it; the relay's persisted quarantine
and recovery procedure still apply. See [recovery-runbook.md](recovery-runbook.md).

The standalone CollectionService isolates source requests. LocalPipeline.run
awaits each worker's publication callback and serializes shared RPC work. These
tests do not prove collection is fully decoupled from publication under congestion.
A production design still needs reviewed buffering/coalescing/priority choices,
queue metrics, fairness targets and sustained all-market freshness evidence.
Its internal scheduler and supervision remain the selected operating model.

Next evidence: joined LocalPipeline crashes against owned Anvil, followed by
larger/longer workload and provider/calibration runs under explicit budgets.
Storage pressure, replacement/cancellation, production signer backup controls,
canonical lifecycle reads and reviewed environment/operating decisions remain open.
