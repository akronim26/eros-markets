# Monad testnet integration

The user selected testnet on 04 October 2026 and moved this work ahead of the
storage/backup drills. A **standalone diagnostic receiver is now deployed**,
alongside preflight, a durable lifecycle monitor and automated diagnostic
publication. Three real Polymarket observations are finalized on testnet,
including a new-process restart from the five saved journals.

## Completed publication pilot

The bot sender is `0x1D7a477FDEaeb7c93E58cd1870e3B35eE4a7d071`.
The user funded it with 0.6 test MON. Separate encrypted observation and
transaction keys now live in ignored owner-only `var/monad-testnet/keys/`.
Preserve this private directory; do not commit or send its unlock material.
The observation key remains pinned by the receiver.

The finite pilot reserved at most three transactions, each capped at 0.12 test
MON, with a total reservation cap of 0.36. Two observations finalized, the
process stopped cleanly, and a new process finalized the third using sequence
3 and nonce 2. Existing signed packets and raw transactions remained identical.
Actual total gas cost was **0.2448 test MON**. Each transaction charged the
800,000 gas limit at 102 gwei; estimate a tighter limit before a longer campaign.
All accepted prices match independent Fraction recomputation of archived raw
books. Exact signatures, digests, accepted logs, canonical finalized blocks and
final source state were verified. See
[`publication-pilot.json`](../artifacts/monad-testnet/publication-pilot.json) and
[`publication-fraction-review.json`](../artifacts/monad-testnet/publication-fraction-review.json).

`serve-monad-testnet` is an explicit disabled-config diagnostic path, fixed to
chain 10143. It requires concrete receiver pins, separate encrypted keys, an
explicit spend policy, complete journal set and lifecycle recording horizon.
It preserves source time, freezes publication time, rechecks lifecycle/freshness
at publication boundaries, simulates before reserving nonces, retains immutable
transactions on uncertain sends and confirms against **finalized** blocks.
Unknown on-chain signed history or inconsistent restored journals fail closed.
The selected policy and total reservation budget persist across restarts.

The completed runs, from this package, were:

```bash
export PRICEFEED_MONAD_RPC_URL=https://testnet-rpc.monad.xyz
npm run cli -- serve-monad-testnet --rpc-env PRICEFEED_MONAD_RPC_URL \
  --config artifacts/monad-testnet/market-config.json \
  --rules artifacts/monad-testnet/rules.json \
  --abi artifacts/monad-testnet/receiver-abi.json \
  --keys-dir var/monad-testnet/keys --journal-dir var/monad-testnet/pilot \
  --policy artifacts/monad-testnet/publication-policy.json \
  --duration-seconds 120 --stop-after-finalized 2 --initialize true
# Second process: same inputs, --stop-after-finalized 3 --initialize false.
```

These are completed-run records: initialization now refuses those existing
journals, and their three-transaction budget is exhausted. Reopening with target
3 exits without another submission. Never delete journals or enlarge the pinned
policy to bypass a used budget. A longer campaign needs a separately recorded
budget and recovery plan retaining the receiver's existing signed history.

The service schedules repeated polls itself; run it as a persistent process
under a supervisor for the sustained campaign. Cron can start/check a service,
but an invocation every minute would miss the consumer's 30-second carry limit.
Diagnostic polling here is five seconds; real RPC work makes actual submissions
slower, so cadence must be measured. Three samples do **not** prove complete
300-second TWAP coverage. Sustained coverage is the next planned proof, followed
by category calibration and hosting/backup/monitoring work.

Checks: 318 package tests, 12 focused new tests included in that count, eight
owned-Anvil crash/restart cases, wire check and 144 Fraction vectors passed.
The ten receiver Solidity tests are separate from the package suite.

## Current standalone deployment

The user requested this pricefeed-only receiver in `/tmp` and signed its creation
with the browser wallet on 04 October 2026.

- Chain: Monad testnet, `10143`.
- Receiver: `0xd2d82fed32fb9a911300e7d928607755bd101773`.
- Transaction: `0xd3d23d6a6c301ebe79431987d900690ea623ad1dddf6364bd234664def2a77ea`.
- Pinned observation signer: `0xF26e7995D8421A8cd16Af704C360c7928F76bb8e`.
- Preparation directory: `/tmp/eros-pricefeed-monad`.
- Public manifest/config/ABI/build/source archive/evidence:
  [`artifacts/monad-testnet/`](../artifacts/monad-testnet/).

Ten separate receiver tests pass under Foundry 1.8.3 with `network=monad` and
solc 0.8.30. Monad RPC estimated gas before submission. The successful finalized
receipt and exact constructor transaction, expected created address, runtime
including the owner immutable, owner/receiver kind and preflight pins were checked.
Actual gas charge: 2,511,761 gas at 102 gwei = 0.256199622 test MON.
Runtime is 7,646 bytes. No observation has been submitted by this deployment step.

This receiver uses the existing real signature ingress and TWAP/observation
storage, without trading economics. The full listing read ABI is compatible;
unrelated trading fields are zero/disabled. Its owner can irreversibly request a
diagnostic halt and scheduled halt starts at T; signed recording stays available.
The politics mapping/rules and seven-day deadline are diagnostic, not a reviewed
production listing. Production admission and chain-31337 pipeline restrictions
remain unchanged. Testnet signing/relay/receipt/recovery and publication-boundary
lifecycle checks are now connected through the separate diagnostic adapters.

The generated observation key is encrypted under the temporary directory's
owner-only `secrets/`, with separate owner-only unlock material. Neither is served
by the local deployment page or included in public artifacts. The keys have since
been moved into ignored owner-only durable package storage; the receiver pins
this signer and has no rotation path. The browser wallet signed deployment and
funded the separately generated unattended transaction sender.

## What works now

`preflight-monad` verifies chain ID 10143, reads a fresh finalized block, and
checks that the same named block still has the same hash and timestamp. With
an engine config and ABI, it also verifies runtime bytecode hash, complete
listing pins, configured source signer/rules, source sequence/time and the
engine's `halted()` fact. Every contract read uses that exact block number.
It returns a labeled lifecycle checkpoint, not a durable lifecycle decision.
Failures return fixed diagnostic codes without exposing RPC credentials.
No wallet, signing, broadcasting, journal creation or sequence allocation is
part of this command. A successful check always says `operationalOutput: false`.

The implementation requires finalized reads; unsupported or unavailable state
fails without falling back to latest. A 30-second checkpoint-age limit and
5-second HTTP timeout with no automatic retries are **diagnostic settings**,
not approval of production finality or delivery budgets. One provider's stable
answer does not prove provider honesty, disagreement handling or upgrade safety.

## Run it before an engine exists

From `packages/pricefeed/`:

```bash
npm run build
export PRICEFEED_MONAD_RPC_URL=https://testnet-rpc.monad.xyz
npm run cli -- preflight-monad --rpc-env PRICEFEED_MONAD_RPC_URL
```

Expect `NETWORK_VERIFIED_ENGINE_NOT_CONFIGURED`, not engine readiness.
The public endpoint is sufficient for this one-shot diagnostic. To use the
Alchemy endpoint, configure its **Monad testnet** URL locally under the same
environment variable. Share the variable name with the agent, not its value.
No private key or test MON is needed for read-only checks.

Official [network facts](https://docs.monad.xyz/ai/current-facts) identify
testnet chain 10143, its public endpoint and
[test MON faucet](https://faucet.monad.xyz). Official
[RPC documentation](https://docs.monad.xyz/reference/json-rpc/overview)
distinguishes speculative latest from finalized and notes that old state reads
can be unavailable. Facts were checked on 04 October 2026; provider behavior
must also be measured against the selected endpoint.

## How to obtain the engine address and ABI

1. Ask the risk/deployment owner for the **concrete testnet engine composition**
   and its deployment procedure. It must include authenticated PriceIngress
   and the agreed counterpart wiring. This repository's
   `artifacts/risk/engine-abi.json` exports the **abstract RiskAccountingBridge**
   interface; it cannot be deployed by itself. The concrete CombinedEngine in
   `contracts/test/integration/` uses a mock book and test-only entry points.
   RealBookEngine in `contracts/test/integration/RealBookIntegration.t.sol`
   already composes real Book/accounting/risk, but also exposes unrestricted
   feed and failure-injection helpers. It remains a test fixture. The deployment
   owner must supply a reviewed concrete artifact and check target-chain size/gas
   feasibility and the open RB-I01 disposition. The local pricefeed demo is also
   a fixture, not the actual Eros deployment.
2. The owner supplies the testnet listing/source/rules/signing-address dossier
   and dependency addresses/parameters. A deployer needs their own testnet wallet
   funded with MON from the faucet. Do not reuse the public local fixture keys.
   A separate testnet fixture deployment is an alternative only if explicitly
   selected and labeled as a fixture; it does not certify the real engine join.
3. After an authorized deployment, get the **created contract address** from
   its successful receipt/deployment manifest, and the **exact concrete build
   artifact** from the deployer. Its `abi` array is what this command needs.
   Foundry artifacts are typically under `out/<source.sol>/<contract>.json`
   in that deployer's build directory. A verified explorer's ABI can corroborate
   the build, but an abstract ABI or guessed address is not deployment evidence.
4. Record the deployment transaction, chain ID, concrete source/build identity,
   listing dossier and runtime code hash. The pricefeed workstream does not
   authorize editing the risk team's deployment wiring. The subsequently
   authorized standalone receiver above is a completed diagnostic deployment,
   not evidence that the full Eros engine is deployed.

For the deployed engine, prepare a disabled MarketConfig with these pins:

| Config input | Obtain it from |
|---|---|
| `destination.chainId` | `10143`, checked against the RPC |
| `engineAddress` | Created contract address and verified deployment manifest |
| `engineCodeHash` | Keccak-256 of deployed runtime `eth_getCode` bytes, including deployed immutables; not creation bytecode |
| `abiHash` | Keccak-256 of UTF-8 `JSON.stringify(artifact.abi)`; not the artifact wrapper or pretty-printed file |
| `marketId`, `sourceId`, `sourceRulesHash`, `signerAddress` | Agreed listing/source dossier; compare listing and sourceState |
| `listedAt`, `scheduledT`, `invalidRule`, pricing N/spread | Agreed listing dossier, cross-checked against engine listing |
| Mapping, policies and recording horizon | Source/engine equivalence dossier and explicit policy decisions |

Both raw ABI arrays and objects containing `abi` are accepted. The exact full
ABI array is pinned, and the three read functions' types and tuple order must
match the production interface. The shortened local demo listing ABI is rejected.
Do not automatically adopt values returned by an untrusted endpoint as approved
pins. If the deployment is upgradeable, runtime code at the proxy alone does
not pin implementation/admin identity; additional checks are needed before
operational integration.

```bash
npm run cli -- preflight-monad --rpc-env PRICEFEED_MONAD_RPC_URL \
  --config var/monad-testnet-market.json --abi /path/to/concrete-engine-artifact.json
```

The config/ABI options must be supplied together. The standalone receiver's
actual address/pins are retained in its public config; full-engine deployment
inputs must still come from that engine's deployer.

## Persistently monitor halt, deadline and source progress

With the actual deployment dossier, a disabled config and an explicit
`requiredFeedUntil >= scheduledT`, run from the package:

```bash
npm run cli -- watch-monad-lifecycle --rpc-env PRICEFEED_MONAD_RPC_URL \
  --config var/monad-testnet-market.json --abi /path/to/concrete-engine-artifact.json \
  --db var/monad-lifecycle.sqlite --interval-ms 5000 \
  --max-checkpoint-age-ms 30000 --duration-seconds 300
```

All interval/age/duration inputs are explicit diagnostics, not approved operating
settings. One process makes serial checks using a monotonic scheduler. Engine
checks pass the same complete pinned finalized-block preflight each time.
The monitor archives its decision before printing it, with source sequence/time
and the named block. It classifies engine state as COLLECTING, RECORD_ONLY,
DEGRADED, QUARANTINED or STOPPED. **COLLECTING is a chain-monitor status here;
it never authorizes price publication or claims venue-data freshness.** This
command watches the engine; it does not fetch or record Polymarket books.

An early halt remains RECORD_ONLY through the original scheduled T and the
explicit later recording horizon. The horizon itself is included; a verified
block beyond it stops the monitor. Missing RPC/future/stale blocks degrade and
can recover after a fresh consistent read. Changed identity, disappearing halt,
canonical disagreement or source sequence/time regression persist quarantine.
Different source state in the same block, or a changed observedAt at the same
sequence, also quarantine. A newer sequence with the same original observedAt
is permitted by the consumer; polling does not invent new source time.

Config/policy changes and checksum-corrupt archives reject startup. STOPPED and
QUARANTINED survive reconstruction and do not reset themselves. A clean exit
releases only the owned fenced lease, preserving its counter for the next owner.
A crash retains the lease until expiry (currently 60 seconds); there is no
forced takeover. Preserve the archive when investigating a quarantine.
SIGINT/SIGTERM or the declared duration stop scheduling, drain the in-flight
check, release the lease and close the journal. Final DEGRADED/QUARANTINED status
returns exit 2; validation/storage failures return exit 1.

Inspect the archive with the existing commands:

```bash
npm run cli -- health --db var/monad-lifecycle.sqlite
npm run cli -- verify-evidence --db var/monad-lifecycle.sqlite
npm run test:monad
```

Health recalculates block age when queried and always reports
`operationalOutput: false`. The focused test runner uses scripted RPC/source
fixtures and a real CLI/SQLite restart; it does not contact or certify an actual
Monad engine. This monitor remains independent of the local publishing pipeline.

## What comes next

Once the deployment dossier exists, run the pinned engine check against it.
Then add an approved testnet observation signer and durable transaction signer,
relay simulation/send/receipt adapter, publication-boundary lifecycle integration and
finalized receipt/source-state reconciliation. The local pipeline, publication
builder, lifecycle controller and transaction backend still enforce chain 31337.
Changing only a chain ID or RPC URL cannot make them operational.

Testnet sending also needs an explicit signing backend, sender and observation
signer identities, test MON, spend/fee limits, replacement/recovery policy,
approved source/rules/operating inputs and external transaction authority.
Monad may return a send hash before nonce/balance validation, and a mempool-only
transaction lookup may return null; neither is acceptance or evidence that a
nonce is safe to reuse. Real engine events and finalized block-labeled state
must drive reconciliation. Q03-Q10 and human gates remain open as documented.
