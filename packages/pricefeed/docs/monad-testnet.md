# Monad testnet integration

The user selected testnet on 04 October 2026 and moved this work ahead of the
storage/backup drills. Implemented pieces are a **read-only preflight** and a
**durable lifecycle monitor**. They do not connect the signing/publication
pipeline to an external chain.

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
   The local pricefeed demo is also a fixture, not the actual Eros deployment.
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
   currently authorize deployments or editing the risk team's deployment wiring.

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

The config/ABI options must be supplied together. No engine address, hash, market
or signer has been fabricated or deployed by this implementation.

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
