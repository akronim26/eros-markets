# Reserve-funded leverage integration

The current reproducible integration and frontend entrypoints are in
[INTEGRATION_READINESS.md](INTEGRATION_READINESS.md). The deployment preparation
and pinned-fork procedure are in [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md).
The dated results below describe the earlier RF-06 checkpoint; newer proof files
retain their own source identities rather than replacing that history.

2026-10-05, RF-06 local integration and reserve-funded leverage on `integration/risk`.
Validation was recorded against changes based on `b7b8442`; the evidence retains
the original base commit and dirty-tree metadata from those runs.

The selected bad-debt policy uses capital deposited into each market's reserve.
Winning trader claims remain payable in full. Funding, payout recovery/haircuts and
conversion stay disabled. This change connects the existing risk and reserve rules
to the constructor-bound factory engine and local operations.

## Contract behavior

- Listings permit ceilings from 1x through 5x. A ceiling above 1x requires nonzero,
  bounded liquidation pacing and a funded reserve before activation. The original
  1x configuration retains zero liquidation pacing and needs no reserve seed.
- Every engine starts with an uncalibrated 1x profile. Governance stages calibration;
  activation or the next accounting epoch applies it. Structural validation rejects
  invalid closeout inputs and malformed, unbounded or numerically unsafe envelopes.
  Structural validity does not establish empirical calibration.
- Missing, future or expired calibration requires full backing. Independent INDEX,
  real fully backed book depth, PERP and BASIS windows, an eligible epoch opening,
  freshness, margin and stage checks remain required for leverage.
- Existing template ceilings remain Scheduled 5/5, Continuous 3/3, Deadline 3/1,
  Unscheduled 1/1 for long/short. `leverageCaps()` reports directional ceilings;
  actual account margin, position size and coverage can require more collateral.
- Every admission checks both terminal outcomes. An account's collateral deficit is
  capped at 2% of the reserve seed captured at activation. Later reserve donations
  improve total cover without increasing that per-account cap or minting new shares.
- Liquidation uses the real bounded book path and per-block pacing. Lack of liquidity
  does not authorize confiscating a positive-equity account. Terminal jumps do not
  depend on a liquidator getting a transaction in first.

The new factory regression opens 1,000 YES claims at 0.60 using 120 collateral
(600 position value / 120 = 5x). An immediate NO outcome creates a 480 collateral
deficit. The winner receives 1,000 in full and the 100,000 reserve retains 99,520.
An immediate YES outcome pays the long account 520. These are controlled test values.
If exceptional accounting corruption or a custody shortfall defeats the invariants,
claims stop rather than silently switching to smaller payouts.

## Deployment and compatibility

New engines need a new factory deployment. Existing immutable 1x engines and vaults
are unchanged; there is no migration of balances, proxy or callable initializer.
The local reader accepts old manifests without calling the new `leverageCaps()`
selector against their old bytecode.

The approved engine creation code now exceeds one 128 KiB code-data store. Two
STOP-prefixed stores hold 100,000 bytes and the remaining bytes. The factory verifies
the combined approved creation-code hash and pins both runtime hashes. Each listing
rechecks the hashes, reconstructs the code and runs the existing constructors,
listing-hash check and atomic vault registration. Both chunks are non-executable.
The factory constructor now accepts the first and optional tail store addresses.

The local script explicitly budgets 29M gas for each registry creation call. This
avoids Forge estimator padding producing a transaction above Anvil's unchanged 30M
cap. Canonical receipts, runtime sizes and actual gas limits are audited separately.
Gas measurements for the earlier single-store factory remain historical evidence.

The new isolated size/gas regression keeps the 30M transaction ceiling and forwards
29.5M for the 8 KiB listing. Small/leveraged listings measure 27,591,345/27,591,414
gas including standard calldata allowance; the 8 KiB case measures 29,299,681.
The engine runtime is 121,963 bytes, its full initcode 132,910 bytes, and the stores
are 100,001/31,983 runtime bytes. Oversized 16 KiB listings still roll back.
The tests check the callee frame and caller measurement: the pinned Forge Monad
isolation path reported zero callee gas at the old insufficient 29M budget, so that
result is explicitly rejected rather than counted as a successful gas measurement.

## Local scenario

Keep the existing 1x integration as a reference. No separate rerun of that old
standalone scenario is needed for leverage. The new scenario deploys a fresh 5x demo
and a terminal control market, seeds 100,000 fixture tokens and stages explicitly
synthetic calibration. It waits for the real sampler and epoch worker to produce a
valid mark before opening 100 claims at 0.50 with 10 collateral per trader.

```powershell
git submodule update --init --recursive
Set-Location oracle
bun install --frozen-lockfile
$env:FOUNDRY_PROFILE = 'integration'
forge build --skip UmaImports --skip test/uma
Remove-Item Env:FOUNDRY_PROFILE
Set-Location ../packages/pricefeed
npm ci
npm run build
Set-Location ../..

python scripts/integration/local-stack.py run --scenario leveraged --rpc-port 18556 --read-port 8797 --keep-running
python scripts/integration/local-stack.py status --scenario leveraged
python scripts/integration/local-stack.py stop --scenario leveraged
```

Prerequisites: Python 3.12+, Bun 1.3.13, Foundry 1.8.3, solc 0.8.30 and Node
24.21.0 for pricefeed. Use the pinned Forge for the build command above; that first
online build populates the compiler cache, since the runner compiles offline.
The integration profile excludes legacy UMA sources requiring solc 0.8.16.
The local fixture requires no public RPC, provider credentials or private dotenv.

The runner prefers `tmp/foundry-v1.8.3/forge(.exe)` and `anvil(.exe)` when present,
otherwise `PATH`. `LOCAL_FORGE`/`LOCAL_ANVIL` can select installed 1.8.3 binaries;
`LOCAL_BUN`/`LOCAL_NODE` are optional overrides. Package-local Node is preferred,
and incompatible tool versions are rejected. If using a Forge override, use that
same executable for the initial build. The shell setup above is PowerShell; POSIX
users can prefix the build with `FOUNDRY_PROFILE=integration` instead.

The leverage pointer is `tmp/local-leverage-latest.json`; the earlier
`tmp/local-integration-latest.json` and its processes/journals are preserved. Each
run gets a fresh directory. The original command still defaults to `fully-backed`.
Do not run two deployment orchestrators simultaneously: Forge's shared broadcast
files are copied into the individual run directories after each script completes.
The Forge-only loopback adapter uses RPC port + 1; all selected ports must be free.
Without `--keep-running`, the runner stops its services after a successful proof.
Runtime manifests, journals, reports and disposable fixture state stay under the
ignored `tmp/` directory. The optional private root handoff is not required to
install or run this committed source.

Reports expose the scenario, listing ceilings, current directional ceilings, reserve
seed/cash, terminal coverage slack and recovery flag. `leverage-readiness.json`
records a canonical block where pricing/calibration permit 5x.
`fund-leveraged-receipts.json` records the deposits before warmup;
`trade-leveraged-receipts.json` records the matched orders.
The terminal control still settles the existing 105/95 fixture claims.

## Liquidation operator

`market-ops` supports `liquidate manifest.json journal.json [--broadcast] [--watch]`.
It checks at most 32 participants per tick, persists its circular scan cursor and
simulates the actual contract touch/eligibility/coverage path. Healthy accounts,
unavailable prices and positive equity with no executable liquidity send no
transaction. Productive book reductions and authorized takeovers use the existing
durable signed-transaction/finality workflow. A nonce-low replay is accepted only
when the RPC knows the exact signed transaction hash; the worker still waits for
its canonical finalized receipt. The worker supplies no pair partner;
it relies on book liquidity or the contract's takeover predicates.

Public manifests must include a measured `gas.liquidate` limit. The local wrapper
uses disposable actor 15 and estimates its bounded candidate calls on chain 31337
only. It does not supply a public gas profile, real reserve capital, a market maker,
production calibration, keeper hosting or a source uptime guarantee. The other
operators remain distinct: sampler 11, epoch worker 12, leveraged traders 13/14.
The local sampler records a 300% estimate cushion (still capped at 30M): a new INDEX
can make publication eligible between estimation and inclusion and add checkpoint
writes. A reverted transaction still stops the service. The maturity step supervises
sampler/upkeep liveness and aborts immediately if either exits.
The sampler also pauses while accounting is unfinished and shortly before the
epoch boundary. During local price maturity, artificial timestamp advances stop
near that boundary and the workers poll quickly so the actual begin/page/finish
transactions can complete. Existing observations still expire after 30 seconds;
no stale observation is kept valid. Sampling the temporarily empty book during
rollover would otherwise invalidate the history used at the next epoch opening.
The leveraged fixture also serializes INDEX observation/delivery with book sampling
and receipt reconciliation using a local exclusive lock. A delayed INDEX at or
before a capture's timestamp changes its checkpoint and correctly invalidates it;
coordination avoids creating that race in the synthetic source. Crashed lock owners
fail closed. This local coordination is not a production source-latency guarantee.
The maturity driver may skip idle fixture time to 1,500 seconds before an epoch
boundary, then rebuild every required window. It closes and reopens publisher
journals across that explicit jump and verifies immutable signed history. Lease
expiry and price freshness remain enforced.
The lead allows 300 seconds of INDEX followed by 900 seconds of BASIS and a startup
margin. If delayed publication still misses the boundary, the driver waits for
the following full accounting epoch.
Re-quoting after rollover or changing the book can invalidate a pending capture.
The affected price windows must then rebuild before new leveraged admission resumes;
the fixture does not establish uninterrupted mark availability.
Readiness is inspected after the sampler has had time to publish following each
controlled clock advance. Before the two-order trade, the runner waits for a recent
confirmed sample and holds the same local coordination lock during the script.
This prevents an intermediate book mutation from invalidating the mark between
the two fixture orders. The contract's 30-second expiry still applies throughout.

## Validation

The local proof in `tmp/local-leverage-20261005-161758` completed with two mined
positions of +100,000/-100,000 lots (100 claims each), backed by 10 fixture tokens
per owner. The reserve remains 100,000; both outcome coverage slacks are 99,960.
The audit verifies 103 script receipts, 5 keeper receipts and 20 upkeep receipts,
with a largest script transaction limit of 29M. The owned services were stopped.

This proof resumed the maturity/trade tail after correcting when readiness is
inspected. It reused the already validated deployment, funding and terminal
settlement. `runtime-before-continuation.json`, the original failed step/log and
`continuation-steps.json` preserve that distinction: this is a completed local
proof with continuation, not a claim of an uninterrupted run of the final runner.
The runner now includes the corrected readiness timing and coordinated trade.

Results, validation-time source fingerprints and the later Git-provenance metadata
correction are recorded in `artifacts/integration/reserve-funded-leverage.json`.
Fresh checks include 832
Prague risk/book tests, 12 reserve-funded leverage regressions, 5 isolated factory
gas tests, 51 local/market-ops service tests, 28 Python runner checks and the G3
technical runner. A Windows Node/Bun contention check also completed 1,000 exclusive
updates without lost writes or lock errors. The integration suites cover 56 unique
tests across the recorded runs; overlapping raw totals are not added together. Historical
G7 acceptance and the earlier 1x receipts are not
approval of these new sources. The known Windows pricefeed portability failures and
legacy MonadTen 10,000-gas assertion remain separate limitations.
