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

Checks: 330 package tests pass after budget renewal and the RPC timing correction.
The preceding focused gas/publication/service run passed 21, included in 330.
Latest evidence: `artifacts/verification/monad-budget-latency-unit.json`. Eight owned-Anvil crash/restart cases,
wire check and 144 Fraction vectors passed for the preceding publication milestone.
The ten receiver Solidity tests are separate from the package suite.

## Estimate-based gas and campaign budget

The relay can use `gasSafetyMarginBps` in an explicitly pinned testnet policy.
It estimates the exact call, rounds the buffered gas upward and simulates again
at that selected limit before reserving a transaction nonce. Missing/invalid
estimates, ceiling breaches and failed selected-limit simulation reject the
submission. Once reserved, retries retain the original limit, nonce and signed
bytes. The initial estimate/margin/limit are archived with the delivery.
Omitting the field preserves the historical policy; this does not migrate it.

An actual fresh-book quote on 04 October 2026 estimated **179,266 gas** and selected
**197,193** with a diagnostic **10% margin**. Both RPC simulations passed. This is
about **75.35% less** than 800,000. At the pilot's historical 102 gwei, the selected
limit implies **0.020113686 test MON/update**, versus 0.0816; the 150 gwei fee ceiling
implies **0.02957895**. These are scenarios based on one valid politics packet,
not optimized paid receipts or production calibration.

The quote consumed observation sequence **4**, retained its signature in the
original journals, and expired it with `GAS_QUOTE_ONLY_NOT_FOR_DELIVERY`.
Sender nonce remained **3**, finalized receiver sequence remained **3**, and
balance was **0.3552 test MON**. No transaction was signed or sent. Future
publication may start at sequence 5; observation sequence gaps do not consume
transaction nonces. The original three-transaction archive is frozen at
`var/monad-testnet/pilot-evidence/` with every original file hash unchanged;
the active history continues at `var/monad-testnet/pilot/`.

The completed quote command was:

```bash
npm run cli -- quote-monad-gas --rpc-env PRICEFEED_MONAD_RPC_URL \
  --config artifacts/monad-testnet/market-config.json \
  --rules artifacts/monad-testnet/rules.json \
  --abi artifacts/monad-testnet/receiver-abi.json \
  --keys-dir var/monad-testnet/keys --journal-dir var/monad-testnet/pilot \
  --policy artifacts/monad-testnet/gas-quote-policy.json
```

Each invocation signs and expires a new quote-only observation. Run while the
publisher is stopped; preserve all five journals. The quote policy is **only
for quoting** and cannot replace the pinned publication policy. A direct
`serve-monad-testnet` restart with a changed policy rejects `RELAY_PROFILE_CHANGED`.

Public evidence: [`gas-quote.json`](../artifacts/monad-testnet/gas-quote.json),
[`gas-quote-review.json`](../artifacts/monad-testnet/gas-quote-review.json), and
[`cost-capacity.json`](../artifacts/monad-testnet/cost-capacity.json).
`npm run report:monad-cost` reproduces capacity scenarios and independent offline
Fraction/source-time/journal/integer-cost checks; it never sends a transaction.

The proposed six-minute campaign polls at five seconds, nominally 72 submissions.
At the quote limit it estimates **1.448185392 test MON** at the historical fee,
or **2.1296844** reserved at the maximum fee. An additional **2.772 test MON**
aggregate reservation envelope and at most **84 additional transactions** allow
some variation. Historical reservations stay counted, yielding a proposed
lifetime cap of **3.132 MON / 87 transactions**. This envelope is a separate
aggregate limit; it does not guarantee all 84 fit if gas estimates rise.
The observed balance falls **2.4168 MON** short of that additional envelope;
a proposed **2.5 test MON** top-up provides a small cushion.

The campaign is **not activated**. An auditable idle-journal budget transition
is now implemented and tested, preserving all packets, reservations and signing
identities. First measure paid gas in the smaller prepared run below; then
fund/authorize the sustained envelope and recheck live state. Do not create new journals or edit SQLite profiles to bypass recovery.
Measure actual cadence/charged fees and independently reconstruct full
300-second coverage at a named finalized block, retaining unsuccessful windows.
At five-second nominal submissions, the one-market daily scenario is about
**347.56 MON/day** at the historical fee: gas savings do not remove ongoing
publication cost. Approved market count/cadence still require these measurements.

## Audited budget renewal and prepared small run

`plan-monad-budget` reads the five existing journals and actual receiver state;
it unlocks no keys and sends nothing. It verifies signatures, immutable requests,
transaction signer identity, historical reservations, all three canonical finalized
receipts and the next sender nonce. Planning does not create or modify journals.
`apply-monad-budget` requires the exact approved plan SHA-256, locks all five
journals, repeats live checks and verifies the unchanged journal snapshot. It
atomically records a checksum-linked budget revision and changes only the relay
profile. It retains all reservations, sequences, nonces, signatures and raw bytes.
Repeated application of the same plan is idempotent; changed plans, active writers,
insufficient funds, journal/chain mismatch and stale publisher profiles reject.
The fee/gas ceilings and signer identities cannot be changed through this command.

Prepared public inputs are
[`small-run-policy.json`](../artifacts/monad-testnet/small-run-policy.json) and
[`small-run-budget-plan.json`](../artifacts/monad-testnet/small-run-budget-plan.json).
They allow **at most eight additional transactions / 0.35 test MON additional
aggregate reservations**. Historical 0.36 reservations remain counted, making
the lifetime caps 11 transactions / 0.71 MON. The measured bot balance is
0.3552 MON, so no transfer from the user's browser wallet is needed for this test.
The plan enables the 10% estimate margin, retaining the old absolute ceilings.
The user **approved this cap**, and budget revision 1 was applied. The attempted
run stopped before broadcast with `RELAY_HEADROOM_EXPIRED`, exit 1. Sequence 5
expired without a nonce; sequence 6 reserved/signed nonce 3 with 197,166 gas and
then persisted QUARANTINED, attempts 0. Its reservation is 0.0295749 MON;
0.3204251 MON remains within the additional envelope. The balance stayed
0.3552 MON, pending/finalized nonce stayed 3 and receiver sequence stayed 3.
**Zero new transactions or gas spend.** The journal next nonce is 4 because
reservation is durable; it cannot be reset to bypass the signed transaction.
See [`stopped-small-run.json`](../artifacts/monad-testnet/stopped-small-run.json)
and [`small-run-budget-application.json`](../artifacts/monad-testnet/small-run-budget-application.json).

The following application/publication commands are **completed-run records**.
Application replay is idempotent. Publication now rejects unresolved signed nonce
3 until an explicit audited recovery is implemented; do not rerun it or edit the
journals to clear quarantine. From this package:

```bash
npm run cli -- apply-monad-budget --rpc-env PRICEFEED_MONAD_RPC_URL \
  --config artifacts/monad-testnet/market-config.json \
  --abi artifacts/monad-testnet/receiver-abi.json \
  --journal-dir var/monad-testnet/pilot \
  --plan artifacts/monad-testnet/small-run-budget-plan.json \
  --plan-sha256 5b528fe69c721fc1f860dd631277ab247450c5d3ce42b77824726a9213fb00df
npm run cli -- serve-monad-testnet --rpc-env PRICEFEED_MONAD_RPC_URL \
  --config artifacts/monad-testnet/market-config.json \
  --rules artifacts/monad-testnet/rules.json \
  --abi artifacts/monad-testnet/receiver-abi.json \
  --keys-dir var/monad-testnet/keys --journal-dir var/monad-testnet/pilot \
  --policy artifacts/monad-testnet/small-run-policy.json \
  --duration-seconds 180 --stop-after-finalized 11 --initialize false
```

The finalized target is lifetime 11, including the original three. No automatic
budget increase or fresh-journal reset is permitted if fewer observations fit.
This small run measures actual paid savings; eight samples do not establish full
300-second coverage. Repeat live checks at application; a changed journal requires
a newly reviewed plan. A quote evidence snapshot is now preserved separately at
`var/monad-testnet/gas-quote-evidence/`, with all five hashes retained in
[`gas-quote-archive.json`](../artifacts/monad-testnet/gas-quote-archive.json), so the
historical quote remains reviewable after the active journals advance.

Verification before the stopped run: full suite **329/329**, focused suite **21/21**, and independent
frozen gas-quote review pass. Five new budget tests cover atomic/idempotent renewal,
history/nonce continuation, invalid approvals and rollback, audit tampering,
competing writers on each journal and two sequential budget revisions. See
[`monad-budget-unit.json`](../artifacts/verification/monad-budget-unit.json).

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

Recover the signed, never-broadcast nonce explicitly and reduce RPC latency,
then resume within the approved bounded envelope and measure paid gas. The final
canonical-block and chain-ID checks now run concurrently, retaining both checks,
fixed error precedence and named finalized blocks. This saves one network round
trip per preflight; real successful cadence remains unmeasured. Then
size/fund/authorize the full 300-second coverage campaign, followed by invalid/gap
recovery, category calibration and operations/review. The standalone receiver,
testnet signers and simulation/send/finalized receipt adapter are already joined.
Full-engine integration still needs that engine's deployment dossier and accepted
counterpart wiring; diagnostic tests do not approve production source policies.

Monad may return a send hash before nonce/balance validation, and a mempool-only
transaction lookup may return null. Exact accepted events and canonical finalized
block-labeled state drive reconciliation; never reuse an uncertain nonce.
Q03-Q10 and human gates remain open as documented.
