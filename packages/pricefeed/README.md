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
npm run cli -- health --db var/capture.sqlite
npm run cli -- verify-evidence --db var/capture.sqlite
```

`inspect-book` makes a bounded public read and prints the diagnostic. Exit 0 means
`COLLECTING` for that snapshot; exit 2 means unavailable/invalid/quarantined, and
exit 1 means a command/storage failure. `capture` polls all configured workers for
the requested duration; its successful exit means collection completed, not that
every sample was healthy. Inspect sample statuses and `health` separately.
Full raw bodies live in the archive, while stdout contains summaries.

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

Q02-Q10 block dependent production behavior: impact/rounding/depth/fees, timestamp
semantics, rules hash, units/quote, event equivalence, operating budget, invalid
packet policy, environment/signer/relay/finality and release/calibration.
The production builder, signed sequence/outbox, signer backend, nonce relay,
receipt/reorg recovery and complete lifecycle recorder remain unimplemented.
No deployment or live transaction authority exists. See `PROGRESS.md` before
continuing; update its pending entry before each manual user commit.
