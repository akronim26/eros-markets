# Polymarket price feed

An isolated CP-PRICE package following
[`polymarket-event-price-feed-implementation-plan.pdf`](../../docs/requests/polymarket-event-price-feed-implementation-plan.pdf).
Read [`PROGRESS.md`](PROGRESS.md) for each commit's changes, decisions, checks and
blockers. [`docs/decisions.md`](docs/decisions.md) tracks Q01-Q10.

## Current behavior

One read-only service collects complete Polymarket outcome books for configurable
crypto, sports and politics workers. It verifies event membership, exact market,
condition, token and outcome label; preserves source timestamps and raw bodies;
calculates explicitly selected depth summaries using bigint; and archives
healthy, invalid, degraded and quarantined diagnostics in SQLite.

Workers have independent persisted state. Source failure, stale data, thin/wide
books, changed rules and identity errors are visible in results. No fallback price
is substituted. `health` rechecks source age when queried. Restart preserves
ordering and quarantine. Reusing an archive after a config/rules change may
quarantine the worker; preserve that archive for review rather than deleting the
failure or treating a new database as operational approval.

All examples have `enabled: false`, `destination: null` and unapproved policies.
The diagnostic examples use N=1,000,000 lots and spread=0.05; these are illustrative
inputs only. Enabling a config fails closed until approved runtime policy adapters
exist. No operational observations, signatures or transactions are produced.
Fixture signatures use a public test-only key in a local test VM.

Monad testnet work now includes read-only RPC/engine preflight and a durable
halt/deadline/source-state monitor. See [`docs/monad-testnet.md`](docs/monad-testnet.md) for the commands,
how to obtain the deployment address/ABI and what is still needed for sending.
This does not enable the local publication pipeline on an external chain.

Candidate rules manifests and durable packet/signing library mechanics now live
in `src/rules.ts`, `src/packet-store.ts`, `src/publication.ts` and
`src/local-test-signer.ts`. The builder recomputes observations from raw
book evidence and reviewed metadata. A separately selected development failure
policy emits fresh invalid-depth checkpoints with zero price/impacts and actual
depth/time; unknown or stale source time remains unavailable. Packet/signature bytes remain immutable
across retries; an independent signer journal detects a restored packet archive
behind signing history. These entry points are restricted to local development,
with disabled configs and the public fixture signer on chain 31337. They are not
enabled as production adapters. The CLI's `build-observation` now exposes offline
unsigned replay from a selected raw capture; it does not attach signing or relay.
`LocalPipeline`
joins collection, durable preparation, signing and `LocalRelay`; `localRpcTransport`
supplies the loopback-only adapter. See `docs/rules-hash-proposal.md` and
`docs/risk-requirements-crosscheck.md` for the remaining policy boundaries.

`LocalLifecycle` now supplies an optional durable development recorder gate.
It keeps publishing the same authenticated source samples in RECORD_ONLY after
an engine halt, blocks output on unavailable/inconsistent engine checkpoints,
and stops each worker beyond its explicit recording deadline. A config declaring
requiredFeedUntil must attach that controller. Source closure is archived as a
gap. Deadline crossings during signing/simulation/transaction preparation are
tested. This uses injected block-labeled readers; a concrete approved engine
lifecycle reader and production policy are still required. See
[`docs/lifecycle.md`](docs/lifecycle.md) and run `npm run test:lifecycle` with the
pinned Forge/solc paths. Four signed accelerated 24-hour fixtures import the real
ingress/store/INVALID modules; they are separate from live-source soak evidence.

## Live-data local demo

The separately authorized demo connects real Polymarket data to an owned local
Anvil chain. It creates a demo market using the existing real `PriceIngress` and
`ObservationStore`, polls the chosen source, signs valid depth summaries with a
public test key and sends local transactions through `submitObservation`.
It checks the digest, receipt, accepted event, sequence and index TWAP against
independent time-segment integration after each acceptance.

From this package, with the pinned tools already installed:

```bash
PRICEFEED_FORGE=/path/to/forge-1.8.3 PRICEFEED_SOLC=/path/to/solc-0.8.30 PRICEFEED_ANVIL=/path/to/anvil-1.8.3 npm run demo:live -- --config config/crypto.example.json --duration-seconds 360
```

`--config` selects the real source event/token; the destination is always a fresh
owned localhost chain, ID 31337. The command accepts no RPC, engine or private-key
argument. It requires a disabled source config without an operational destination.
The chain is shut down after the run. A successful source/ingress demo exits 0,
no accepted packet exits 2, and a setup/integrity failure exits 1.

Results and signed packets/receipts are in `artifacts/demo/latest.json`; the first
real book is in `artifacts/demo/source-example.json`. Full event/metadata/book
captures live in the ignored SQLite archive named in the report. Source failures
are retained; they never produce a fabricated observation. A 300-second index
is available only with genuine contiguous source coverage, and the report shows
coverage even when unavailable. No accelerated/repeated timestamp is used to
manufacture a five-minute window.

Demo choices are explicit: the source config's diagnostic impact method/N/spread,
vendor-millisecond flooring, local packet-freeze publication time, unapproved
quote policy, and a hash of the local demo manifest. These are not Q02-Q10
approvals or an approved Eros listing. The receiver demonstrates real ingress and
index storage; it has no complete margin/funding/settlement engine, book or oracle.
External-chain transactions remain zero. Operational admission is unchanged.

## Durable pipeline and restart campaign

The newer `demo:pipeline` runner exercises the actual packet/signer/relay journals
and joined development pipeline against real ingress/store contracts on a fresh
owned Anvil chain. Choose `--source polymarket` explicitly for real source data;
the default is synthetic fixture data for controlled failures.

```bash
PRICEFEED_FORGE=/path/to/forge-1.8.3 PRICEFEED_SOLC=/path/to/solc-0.8.30 PRICEFEED_ANVIL=/path/to/anvil-1.8.3 npm run demo:pipeline -- --source polymarket --config config/crypto.example.json --duration-seconds 360 --restart-after-seconds 180 --require-full-window true
```

`--restart-after-seconds` closes/reopens all five journals and reconstructs every
pipeline object while keeping the owned chain alive. It checks immutable bytes
and resumed chain acceptance. This is a graceful in-process restart, not a forced
OS-process crash or backup-restore drill. `--require-full-window true` fails if
the final independently checked TWAP lacks genuine complete 300-second coverage.
Running for six minutes alone does not guarantee coverage: source gaps, invalid
books or repeated stale timestamps remain failures. Original timestamps and
sequence reservations are preserved; no time acceleration or freshness rewrite
is used. Reports under `artifacts/pipeline/` identify real versus synthetic source,
receipts, restart results and archive hashes. Raw evidence stays in the reported
ignored `var/pipeline-*` directory. Production admission remains closed.

After the runner closes the archives, independently review a retained report:

```bash
python3 scripts/review-pipeline.py artifacts/pipeline/latest.json
```

This offline checker verifies archive hashes, original source times, prices and
depths with Python Fraction, receipt bindings, ordering and the actual available
or unavailable TWAP. It does not certify provider semantics or production finality.

`npm run test:recovery` additionally kills subprocesses with OS SIGKILL at thirteen
journal/signing/relay boundaries. Each restarts from the retained journals and
checks immutable bytes, ordered sequences/nonces and receipt recovery. The drill
uses scripted source and chain responses, alongside the actual journal and relay
classes. It tests stale restores, writer leases and expired reserved nonces;
quarantine blocks new nonce allocation across workers. Evidence is retained in
`artifacts/verification/recovery.json` and `recovery.tap`. See
[`docs/recovery-runbook.md`](docs/recovery-runbook.md) for boundaries, operator steps
and remaining production backup/supervisor work.

`npm run test:pipeline-crash` separately runs the joined continuous pipeline
against an owned Anvil chain with the real ingress/store. Set PRICEFEED_FORGE,
PRICEFEED_ANVIL and PRICEFEED_SOLC to the pinned executables as for the local demo.
It kills the bot at eight boundaries, waits for actual writer leases to expire,
and restarts another process while the chain stays alive. All eight paths continue
with immutable packets and exactly two accepted observations. A separate local
transaction journal preserves nonce/request reservations and raw signed bytes,
including a crash between reserving and signing. The source is a fixture.
Evidence: `artifacts/verification/pipeline-crash.json` and `pipeline-crash.log`.
This does not complete the production transaction-signer or backup work.

`npm run test:transactions` checks exact retries, nonce conflicts, journal
integrity and signer/relay restore mismatches alongside existing relay/pipeline
tests. A missing journal, changed journal identity, history ahead/behind the
other archive, or expired reserved packet cannot enable fresh sending. Adding
the new journal to old relay history requires explicit migration review.

`npm run test:load` exercises seven declared many-market/slow-RPC scenarios, with
actual bot classes and scripted source/chain responses. It tests independent
collection, fifty ordered publications across 25 markets, queue expiry, RPC
timeouts, provider queue pressure and 100-worker shutdown. An unreserved update
that expires while queued is now archived as EXPIRED so fresh samples can continue.
Timing/headroom measurements and limits are in `artifacts/verification/load.json`.
See [`docs/load-evidence.md`](docs/load-evidence.md); these local settings do not
approve production cadence, request limits or capacity.

## Risk output contract

The eventual output is one signed depth-N observation through
`submitObservation(Observation obs, bytes signature)`, with eleven fields:

| Field | Solidity type / meaning |
|---|---|
| marketId | bytes32; Eros market identity |
| sourceId | bytes32; pinned independent source |
| sequence | uint64; durable monotonically increasing source sequence |
| observedAt | uint64; authentic source time, Unix seconds |
| publishedAt | uint64; agreed publication time, Unix seconds |
| priceWad | uint256; depth impact midpoint, floor((bid+ask)/2) when valid |
| impactBidWad | uint256; approved depth-N sell price, WAD |
| impactAskWad | uint256; approved depth-N buy price, WAD |
| bidDepthLots | uint256; conservatively normalized available bid depth |
| askDepthLots | uint256; conservatively normalized available ask depth |
| sourceRulesHash | bytes32; approved canonical mapping/source-rules hash |

One lot is 0.001 claim and WAD is 10^18. Raw digest includes the exact type hash,
all fields, chain ID and engine address. Personal-message and typed-data signing
are incompatible. Risk owns acceptance time, validity, 300-second index TWAP,
mark, funding and INVALID history. The feed does not output final outcomes or
precompute the engine's TWAP/mark. Today's diagnostic `engineObservation` is null;
wire encoding and local signature tests do not implement the production builder.

## Commands

Run these from `packages/pricefeed/`. `npm ci` installs the pinned local runtime
and dependencies. `npm test` builds and runs deterministic package tests; it sends
no network requests. `npm run build` is required before using the CLI.

```bash
npm ci
npm test
npm run cli -- validate-config --config config/crypto.example.json
npm run cli -- inspect-book --config config/crypto.example.json --db var/crypto.sqlite
npm run cli -- capture --configs config/collection.example.json --duration-seconds 600 --db var/capture.sqlite
npm run cli -- serve --configs config/collection.example.json --db var/service.sqlite
npm run cli -- health --db var/capture.sqlite
npm run cli -- verify-evidence --db var/capture.sqlite
npm run cli -- build-observation --config var/replay/config.json --rules var/replay/rules.json --db var/capture.sqlite --capture-id 2 --sequence 1 --published-at-ms 1791059028222
```

`build-observation` requires an explicit disabled local destination, matching
candidate manifest, capture ID, proposed sequence and replay time. It verifies
archive checksums and recomputes from raw bodies without reserving a sequence,
signing or sending. Historical time is never refreshed. Exit 0 means an unsigned
candidate, 2 means unavailable and 1 means a command/integrity failure. See
[`docs/offline-observation.md`](docs/offline-observation.md) for selecting inputs,
output boundaries and SQLite read coordination files.

`inspect-book` makes a bounded public read and prints the diagnostic. Exit 0 means
`COLLECTING` for that snapshot; exit 2 means unavailable/invalid/quarantined, and
exit 1 means a command/storage failure. `capture` polls all configured workers for
the requested duration; its successful exit means collection completed, not that
every sample was healthy. Inspect sample statuses and `health` separately.
Full raw bodies live in the archive, while stdout contains summaries.

`serve` collects complete snapshots continuously until SIGINT/SIGTERM (Ctrl+C).
Each worker follows its configured interval without overlapping its own polls;
slow workers do not impose a global poll barrier. A journal or output-consumer
failure stops the service and drains in-flight bounded requests before closing
the database. Timer waits wake on shutdown. The service remains read-only and
does not sign or send observations. Source freshness is evaluated from vendor
time; a running process is not evidence of fresh prices. Shutdown waits for any
already-running bounded provider request.

Examples are configuration templates for real source tokens, not approved Eros
listings. API access does not establish eligible event semantics. Short-horizon
markets can be readable while failing the listing horizon. Category labels never
alter risk economics or select a risk template.

## Complete local verification

`verify:all` records command exit codes, nonempty test counts, deterministic
fixture/source hashes and protected-component checks in
`artifacts/verification/`. It requires Forge **1.8.3** and Solidity **0.8.30**.
Point it at already installed, verified executables:

```bash
PRICEFEED_FORGE=/path/to/forge-1.8.3 PRICEFEED_SOLC=/path/to/solc-0.8.30 npm run verify:all
```

No global toolchain is changed. Missing/wrong tools or an empty test suite fail
verification. The integration test imports the existing real ingress/store
read-only, with a local initialization harness; it neither changes counterpart
code nor certifies a live counterpart join. Machine reports describe a working
tree and must not be interpreted as human PF gate acceptance.

## Remaining implementation

The [implementation status report](output/pdf/pricefeed-implementation-status-report.pdf)
summarizes the goal, recorded tests, real-source local demo, risk output contract
and remaining work as of 03 October 2026. Its generator is
`scripts/build-status-report.py`; install `scripts/pdf-requirements.txt` in a
separate Python virtual environment before regenerating it from this directory.
The generator checks the retained evidence and fails if the demo has changed,
requiring a review of the report narrative before regeneration.

User-selected pricing/rounding/fees/depth and local invalid checkpoints are
recorded decisions. Remaining production dependencies are provider timestamp
semantics, canonical rules dossier, units/quote/precision, exact event equivalence,
measured operating budgets, production invalid/lifecycle policy,
environment/signer/relay/finality and release/calibration.
The joined development pipeline and concrete loopback adapter are present.
Operational RPC/key/lifecycle readers, approved recording/closure policy, broader recovery/load
campaigns and reviewed production acceptance remain incomplete. The staged
PF001–PF028 audit is in
[`docs/plan-status.md`](docs/plan-status.md).
No deployment or live transaction authority exists. See `PROGRESS.md` before
continuing; update its pending entry before each manual user commit.
