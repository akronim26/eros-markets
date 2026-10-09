# Monad testnet integration

This page preserves the standalone diagnostic receiver pilot and its operating
procedures. Its receiver and sender addresses are not the current trading market
deployment. Use [the current address register](../../../addresses.md) and
[testnet operating runbook](../../../docs/integration/TESTNET_OPERATIONS.md) for the
replacement BTC/ETH engines and their market-specific publisher journals.

The user selected testnet on 04 October 2026 and moved this work ahead of the
storage/backup drills. A **standalone diagnostic receiver is now deployed**,
alongside preflight, a durable lifecycle monitor and automated diagnostic
publication. Nine real Polymarket observations have finalized on testnet.
Explicit recovery of an unsent nonce enabled six gas-optimized prices, followed
by a cold restart retaining every signed packet.

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
local `publication-pilot.json` (see [evidence storage](evidence-storage.md)) and
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

Checks: 336 package tests pass after explicit nonce recovery. Focused
gas/publication/service suite: 27 pass, included in 336. Latest evidence:
`artifacts/verification/monad-nonce-recovery-unit.json`. Eight owned-Anvil crash/restart cases,
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

Public evidence: local `gas-quote.json` (see [evidence storage](evidence-storage.md)),
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
This describes the **retained initial failed attempt**, which sent nothing.
Recovery and the successful six-price run are recorded below. At that stop,
the journal next nonce was 4 because
reservation is durable; it cannot be reset to bypass the signed transaction.
See [`stopped-small-run.json`](../artifacts/monad-testnet/stopped-small-run.json)
and [`small-run-budget-application.json`](../artifacts/monad-testnet/small-run-budget-application.json).

The following application/publication commands are **completed-run records**.
Application replay is idempotent. The original target 11 cannot be reached after
counting the abandoned reservation and cancellation. Use the recovery/current
run records below; do not edit journals or raise the exhausted count cap.
From this package:

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

## Sustained coverage campaign (first phase failed, retry prepared)

The optimized paid run proves lower transaction cost and restart/nonce recovery;
its named window covers only 134/300 seconds. The next diagnostic proves a full
300-second window, pauses publication for at least 60 seconds, then starts a new
process using the same five active journals and builds another full window.
The pause must make the TWAP unavailable while source sequence/time stay unchanged.
No fabricated thin/wide book or source timestamp is submitted.

Prepared public files: `coverage-proposal.json`, `coverage-policy.json`, and
`coverage-budget-plan.json` in `artifacts/monad-testnet/`. The read-only plan pins
the current journal history and receiver state. The original policy and plan are
retained as `coverage-policy-original.json` and `coverage-budget-plan-original.json`.
The actual **1 MON** transfer funded a reduced **1.20 MON** remaining allowance;
`coverage-funded-proposal.json` records this narrowing within the user's approval.
The reduced plan was applied. Its initial phase completed and failed the full
window requirement, so publication stopped before the gap/recovery phases.

| Bound | Prepared value |
|---|---|
| Additional transaction reservation slots | 44 total, including any cancellation |
| All remaining reservations allowed after transition | 1.20 test MON |
| Lifetime reservations including historical 0.57010395 MON | 1.77010395 MON |
| Lifetime count / budget revision | 55 / 2 |
| Balance checked by the funded plan | 1.232440246 MON |
| Funding gap | Zero |
| Actual price targets | At most 20 per phase / 40 total |
| Historical-average cost if all 40 prices finalize | About 0.80412 MON; estimate, not guaranteed |

The lifetime policy ceiling increases by **1.06010395 MON**, because the old
policy still had 0.13989605 MON of unused reservation allowance. Combining that
unused allowance with the increase yields the exact new **1.20 MON remaining
envelope**; there is no extra allowance beyond it. The count and reservation
limits both apply, and the run stops on either limit. Existing gas/fee ceilings,
signer identities, timestamps, sequences and nonces remain unchanged.

Budget plan hash:
`78f981cab2df863f211dbab9204d49626078969ec0a0368666afa9479032bd17`.
Sender: `0x1D7a477FDEaeb7c93E58cd1870e3B35eE4a7d071`.

The user approved a maximum 1.35 MON / 44-slot envelope by replying “proceed”;
the funded 1.20 MON envelope stays below that ceiling. Authorization and narrowing
are recorded in `coverage-authorization.json`. `coverage-funded-check.json` and
`coverage-budget-application.json` retain funding/preflight and atomic renewal
proofs. The original larger proposal was never applied. Never initialize new journals, reset
nonces or reuse a frozen evidence directory as the active publisher.

The bounded procedure is:

1. Run `serve-monad-testnet` with the coverage policy, existing keys and
   `var/monad-testnet/pilot`, `--initialize false`, duration cap 600 seconds and
   lifetime finalized-price target 29 (existing 9 plus at most 20).
2. After the process exits and every delivery is resolved, capture `initial` at
   the last finalized price's block. A full window is required before stage 2.
   Preserve a failed window and stop if this requirement is not met.
3. Leave publishing stopped for at least 60 seconds. Capture `gap` at a current
   finalized block; require unavailable TWAP and unchanged source sequence/time.
4. Restart with the same journals and duration cap, lifetime target 49. Capture
   `recovered` at its last finalized price block. Require full 300-second coverage
   entirely after the first fresh post-pause source observation. Cancellation
   reservations reduce the available price count and never extend the envelope.
5. Close/checkpoint all five databases and copy a coordinated, owner-only frozen
   snapshot to `var/monad-testnet/coverage-run-evidence/`. Keep it separate from
   the active publisher. Verify no uncheckpointed WAL remains in the snapshot.

From the package, capture named blocks using the pinned RPC environment:

```bash
./node_modules/.bin/node dist/scripts/capture-monad-coverage.js initial BLOCK_NUMBER \
  > artifacts/monad-testnet/coverage-initial.json
./node_modules/.bin/node dist/scripts/capture-monad-coverage.js gap \
  > artifacts/monad-testnet/coverage-gap.json
./node_modules/.bin/node dist/scripts/capture-monad-coverage.js recovered BLOCK_NUMBER \
  > artifacts/monad-testnet/coverage-recovered.json
./node_modules/.bin/node dist/scripts/verify-monad-coverage.js
python3 scripts/review-monad-coverage.py
```

Capture validates current and named-block runtime/listing/source pins, finalized
height, canonical hash and exact block timestamp. It does not access wallets or
journals. Receipt verification checks signatures, immutable raw requests, gas,
canonical acceptance and the applied budget audit against the frozen history.
Both replayers filter by receipt block **before** replacing same-second samples,
so later observations cannot repair a historical gap. Candidate receipt windows,
including failed windows, remain in `coverage-run.json`. Failed required phases
exit nonzero; no successful live coverage result is claimed by preparation.

Local checks: `dist/test/monad-coverage.test.js` and
`python3 test/monad-coverage-reference.py`. These cover hand-derived full/gapped
windows, invalid-depth interruption and historical block filtering; the Python
replay also reproduces the original real 134/300 window and new failed 268/300
window. Actual initial receipt verification and independent replay agree on
268/300. Gap and recovered phase verification remain pending. This diagnostic is one politics
listing; category calibration and production cadence approval remain separate.

### Initial result and collection timing fix

Twenty additional prices finalized with source sequences 13–36 (four unreserved
packets expired) and sender nonces 10–29. Named block **68183973**, timestamp
**1791137641**, returns `available: false`, `coveredSecs: 268`, integral
`168170000000000000000`. Real source intervals over 30 seconds leave **32 seconds
uncovered**. New charged gas was **0.404203764 MON**; conservative reservations
were **0.5944173 MON**. Every receipt/signature/raw transaction and unchanged old
history verified. Both campaign reviews exit **2**, intentionally preserving the
failed coverage result. No recovery phase or further paid attempt ran.

Evidence: `coverage-initial.json`, `coverage-initial-run.json`,
`coverage-initial-run-review.json` and the closed owner-only archive
`var/monad-testnet/coverage-initial-evidence/`. Preserve these files when recording
a retry. Active journals remain `var/monad-testnet/pilot`.

A separate 150-second source probe captured 30 REST books and 57 WebSocket frames
without transport errors, signatures or transactions (`coverage-source-probe.json`).
It exposed fresher updates while the original joined loop was waiting on chain
checks. A WebSocket price-change message is not a verified full book; stream
reconstruction remains its separate planned milestone.

The testnet service now runs the existing full REST collector independently.
It archives on the existing five-second policy and buffers the latest complete
result; the publisher selects that result after receipt/lifecycle reads, then
recomputes from raw bodies and applies every existing signing/broadcast gate.
Source timestamps and immutable retry packets are never refreshed. Missing,
degraded or quarantined results cannot become healthy cached prices. Both loops
drain before the source lease/journals close; a stopped or failed publisher stops
collection too. Diagnostic publication is scheduled every **20 seconds**, separately
from collection. This is a nominal interval, not a guarantee of inclusion, full
coverage or an approved production/coalescing policy.

### Prepared finite retry (not approved or applied)

**Deferred by the user on 05 October 2026.** Continue the other original component
milestones first. This proposal remains inactive; a general request to move past
the coverage issue is not approval to spend under the increased cap. Preserve
the failed 268/300 evidence and revisit the complete proof before release.

`coverage-retry-policy.json`, `coverage-retry-proposal.json` and the read-only
`coverage-retry-budget-plan.json` prepare revision **3**. The failed run left only
24 reservation slots and **0.6055827 MON** in the active budget. Two new full
windows at twenty-second publication need more slots/reservation room than that.

The retry proposes **at most 38 more reservations**, including at most 17 prices
per phase / 34 prices total and four recovery slots, within a **1.13 MON remaining
reservation cap**. Duration caps are 600 seconds each with at least 60 seconds
stopped between phases; lifetime finalized-price targets are **46**, then **63**.
Lifetime limits become count **69** and **2.29452125 MON** reserved. Compared with
the originally approved 44-slot / 1.35 MON campaign, this increases the maximum
by **14 slots / 0.3744173 MON**. It requires new explicit authorization; the
original approval does not cover it. No budget has been applied.

Fresh read-only proof verifies source sequence **36**, sender nonce **30** and
balance **0.828236482 MON**. Funding gap for the remaining reservation cap:
**0.301763518 MON**; suggested top-up **0.35 test MON**. Expected charge for 34
prices at the failed run's average is **0.6871463988 MON**; an estimate, whereas
1.13 is the hard reservation cap. Plan hash:
`46cd1f57466a685e172f223925b991b71bf1cac48fa3b218c923967b6a5ca07a`.

Keep retry captures under `coverage-retry-initial.json`,
`coverage-retry-gap.json`, and `coverage-retry-recovered.json`. Its coordinated
frozen archive belongs in `var/monad-testnet/coverage-retry-run-evidence/`.
Use `verify-monad-coverage.js --retry` and `review-monad-coverage.py --retry`;
they bind the retry policy/plan and compare against the failed initial run's
frozen history. For a failed retry initial phase, use a separate
`coverage-retry-initial-evidence/` archive and `--retry --initial-only`. Never
overwrite the original failed report or raise caps automatically after a failure.

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

## Explicit recovery of a signed, never-broadcast nonce

`recover-monad-nonce` supports only the latest expired price reservation with
zero recorded broadcast attempts. It requires the exact old transaction hash,
idle five-journal set, pinned identities/policy, known canonical finalized price
history, the unchanged chain nonce, and an EOA sender. Other recovery cases fail
closed. It signs only a zero-value, empty-data self transaction on chain 10143
with 21,000 gas, using the existing sender's encrypted key. It cannot sign a
transfer, contract call or a new price at the same nonce.

Both original signed price bytes and the cancellation bytes persist separately;
unknown sends retry the same cancellation. Sender/fee pins and checksums bind
the cancellation record. Canonical finalized success marks the original delivery
CANCELLED; the original price packet and transaction signing journal are retained.
Publisher startup verifies the cancellation receipt/signature/canonical block
and skips the cancelled price. Missing/corrupt/unknown recovery evidence blocks
restart. Cancellation reservation and count remain in the original cumulative
budget, as does the abandoned price reservation; no budget is reset or enlarged.

The approved recovery command for the stopped run is:

```bash
npm run cli -- recover-monad-nonce --rpc-env PRICEFEED_MONAD_RPC_URL \
  --config artifacts/monad-testnet/market-config.json \
  --abi artifacts/monad-testnet/receiver-abi.json \
  --keys-dir var/monad-testnet/keys --journal-dir var/monad-testnet/pilot \
  --policy artifacts/monad-testnet/small-run-policy.json --nonce 3 \
  --original-hash 0x9d15860802ff8d75877fd614e96a2e01a1cbf183cc0242d7c324555076bea497 \
  --max-cost-wei 3150000000000000 --wait-ms 120000
```

The cancellation ceiling is **0.00315 test MON**, counted within the already
approved 0.35 MON additional envelope. The abandoned reservation and cancellation
consume two conservative slots, leaving at most **six new price transactions**.
The subsequent service uses the same journals/policy, `--initialize false` and
`--stop-after-finalized 9` (three original + six new prices). The former target 11
is no longer attainable within the same transaction count budget. A larger run
requires a separately approved renewal; recovery cannot authorize one.

## Completed recovery and optimized paid run

Cancellation nonce **3** finalized at block **68167766**:
`0x8d7958cb431e51f9010d2131d485fd4e053062d3e7404e932230fecf296688f8`.
It charged **21,000 gas × 102 gwei = 0.002142 MON**. Original price sequence 6,
request/raw bytes and transaction signer reservation remain intact; its delivery
is CANCELLED. Recovery sends no price to the engine.

The resumed service finalized prices **7–12 / nonces 4–9** and exited 0 at
lifetime **nine finalized prices**. Gas limits were 197,059–197,180, averaging
**0.020102959 MON/update**, **75.36% lower** than the pilot's 0.0816. Six prices
cost **0.120617754 MON**; including recovery, new gas cost was **0.122759754 MON**.
Additional reservations, including the abandoned request and cancellation, total
**0.21010395 MON**, within the **0.35 MON** envelope. The final read-only chain check confirms the sender's
remaining balance is **0.232440246 MON** and pending nonce **10**;
the conservative transaction count is exhausted and requires explicit renewal.

A separate process reopened all five journals, checked cancelled-nonce finality
and signed source history, and exited at target 9 with no new transaction.
All packets/signatures/requests/raw bytes/receipts matched the completed run.
Closed evidence is frozen at `var/monad-testnet/optimized-run-evidence/`;
the original active journals remain the only publishing history.

Read-only canonical receipt/signature/request verification and independent
raw-book Fraction/time/depth/cost/TWAP review pass. The named evaluation block
**68169207**, timestamp **1791133182**, has **134/300 seconds** coverage and
`available: false`, as expected for a short stopped run. No full coverage claimed.
Acceptance intervals were **20, 18, 17, 23, 28 seconds**; acceptance ages **12–20
seconds**. These are measurements, not approval of cadence or margin.

Evidence:
[`nonce-recovery.json`](../artifacts/monad-testnet/nonce-recovery.json),
local `optimized-small-run.json` (see [evidence storage](evidence-storage.md)),
[`optimized-small-run-review.json`](../artifacts/monad-testnet/optimized-small-run-review.json),
[`optimized-restart-review.json`](../artifacts/monad-testnet/optimized-restart-review.json).
Full package suite **336/336** and focused suite **27/27** pass. The focused set
is included in 336; no new Solidity/crash/category campaign or gate acceptance
is claimed. The full 300-second campaign, category calibration and operations
remain after this completed gas/recovery milestone.

## What comes next

Recovery and the approved six-price run are complete. Renew the exhausted
count budget explicitly before the next campaign. The final canonical-block and chain-ID checks run concurrently. A fresh
packet can reuse its immediately preceding lifecycle check only across the
synchronous builder path within 50 ms and the same whole second; delayed paths
recheck. Post-signing, pre-reservation and pre-broadcast checks still run. Source
age, named finalized blocks, runtime/source/listing pins and budget checks remain.
Real cadence and actual savings must be measured rather than inferred from tests.

Then size/fund/authorize the 300-second coverage campaign, followed by invalid/gap
recovery, category calibration and operations/review. The standalone receiver,
testnet signers and simulation/send/finalized receipt adapter are already joined.
Full-engine integration still needs that engine's deployment dossier and accepted
counterpart wiring; diagnostic tests do not approve production source policies.
Q03-Q10 and human gates remain open as documented.
