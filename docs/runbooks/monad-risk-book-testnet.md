# Risk + Book: Monad testnet workflow

Scope: testnet evaluation of the concrete `contracts/src/engine/BookRiskEngine.sol`,
not a mainnet release. A successful estimate is not a deployment or release approval.
Economic changes require source-bound unified-team regression and invariant evidence under
`docs/merge/UNIFIED_WORKFLOW.md`; mandatory A/B peer review is retired. These checks are not an
independent audit. G7 acceptance for `c91acf7` is recorded after passing checks under the user's
explicit authorization; it does not authorize a new deployment or production release. Future
gate acceptance still requires authorization. Confirm network, wallet and spending scope before any broadcast.

## What is real, and what remains missing

The concrete engine composes the real Book, A accounting/custody/settlement, and B risk
controllers. It has no fixture `feed()` or failure-injection entry points. It enforces
initial cap 1, an uncalibrated profile, funding and recovery disabled, premium load 1,
zero ordinary trading fees, and disabled conversion. IDs come from A's allocated-account
registry; only the internal liquidation path can issue forced IOC orders.

Signed `submitObservation` feeds the independent index, not the perpetual book history.
The current source adds a bounded Book depth sampler under the user-approved RB-I05 policy and
implements RB-I11's strict INDEX-prefix seal at `dcb6b0e` under delegated unified-team authority.
The strengthened sampler rerun passes 21/21 (`tmp/rb-i11-final.log`); full CI passes 832 tests in
130 suites, and the final separate Monad bundle passes 99 tests in 11 suites, all with zero
failures/skips. Current Python (237 tests), SDK, format, ABI and read-only creation-estimate checks pass;
details follow below. Ordered G0–G7 pass, and user-authorized G7 acceptance is recorded for the
non-oracle local integration candidate. Do not apply the older
`4a050df` validation/deployment estimate to this new bytecode. The pre-fix source allowed later
authenticated INDEX corrections to change capture-time INDEX while stored BASIS retained the
old value. Current publication waits for a strictly newer authenticated INDEX timestamp, so
existing monotone ingress prevents that historical correction after publication. See
`docs/questions/RB-I11-index-prefix-seal.md` for the proof's scope and test evidence.
Fresh, fully covered 300-second index history and the listing's index price band permit fully
backed bootstrap exposure before PERP warm-up. The historical deployed smoke engine has no
sampler and remains terminally closed. Do not describe local sampler tests as live leveraged
trading, live funding or normal-mark liquidation validation.

The price collector, production resolution oracle and registry/factory remain counterpart
dependencies. A controlled testnet authority, token or observation signer must be identified
as such in evidence, not relabeled as the completed production counterpart. Never deploy
`RealBookEngine` or `CombinedEngine` from `contracts/test/`.

## Network and execution limits

Official Monad testnet uses chain ID **10143**, RPC `https://testnet-rpc.monad.xyz`,
native MON, [MonadVision](https://testnet.monadvision.com) and
[Monadscan](https://testnet.monadscan.com). Use the [official faucet](https://faucet.monad.xyz)
for test MON. Testnet was reset on 2025-12-16; do not assume older deployments survived.
[Network information](https://docs.monad.xyz/developer-essentials/testnet)

Runtime must fit **131,072 bytes**, and initcode **including constructor arguments** must
fit **262,144 bytes**. A large Forge test-harness size override does not change these limits.
[VM differences](https://docs.monad.xyz/developer-essentials/differences)

The transaction gas ceiling is **30,000,000**. Published block gas capacity is 150,000,000;
read the actual RPC block during preflight. Monad charges the submitted gas limit, not only
gas consumed. The published minimum base fee is 100 MON-gwei; obtain a fresh fee quote.
Prague-targeted bytecode is within the currently documented Fusaka opcode support.
[Deployment summary](https://docs.monad.xyz/developer-essentials/summary)

MIP-8 changes storage access/write pricing, not Solidity accounting semantics. Ethereum-mode
Forge gas measurements are not Monad measurements. Check current activation metadata in
[`networks.json`](https://docs.monad.xyz/networks.json) and the
[release log](https://docs.monad.xyz/developer-essentials/changelog/releases).
[Opcode pricing](https://docs.monad.xyz/developer-essentials/opcode-pricing)

Use pinned Forge 1.8.3 / solc 0.8.30 / Prague / optimizer 200, with Monad execution enabled:

```sh
forge test --network monad
anvil --network monad
anvil --fork-url https://testnet-rpc.monad.xyz
```

The current Monad execution revision is MonadTen. A local run may pin
`network = "monad"` and `hardfork = "monad:MonadTen"`; live forks select their revision
from chain ID and block timestamp. Do not substitute the legacy Monad Foundry fork,
which lacks MonadTen/MIP-8. [Official Foundry guide](https://docs.monad.xyz/tooling-and-infra/toolkits/foundry)

## Required inputs

- Confirm testnet rather than mainnet, the RPC, deployer address, test MON budget and signer
  mechanism. Use a local keystore/hardware wallet or protected environment; never paste keys
  into chat, commit them, or put them in a report. Preflight needs no signing key.
- Select the six-decimal collateral token and vault governor. Verify token behavior and code;
  record clearly whether this is a test token. The engine's listing token must equal the vault token.
- Specify the immutable reserve treasury, governance, monitor, registry and resolution authority.
  The concrete engine requires deployed vault/token/authority code and a nonzero registry.
  The registry field alone is not an implementation of the missing production registry.
- Supply market/source/rules hashes, the index signer and source identity, depth N, spread limit,
  bootstrap band, template, order bounds and liquidation pacing policy. Do not invent calibration
  or sign fabricated observations as if they were live external data.
- Choose actual `listedAt` and `scheduledT`: at deployment T must be at least one day away and
  at most 2,588,400 seconds away; also preserve the listing's void/fallback horizon constraints.
- Fix cap 1 and funding false. Supply collateral budgets for traders and any reserve seeding.
  Real public-chain time cannot be warped: a live source needs 300 seconds of continuously covered
  index history, with freshness at most 30 seconds per observation; reserve withdrawal notice is
  seven days. The controlled smoke below explicitly signs synthetic historical observations;
  this does not demonstrate elapsed-time collection from a live source.

## Read-only checks

From the repository root:

```sh
python scripts/monad-preflight.py --network-only --output artifacts/risk/monad-network-preflight.json
```

The script permits only chain ID 10143. An explicit `--allow-local-chain` also permits 31337;
mainnet and other chains are rejected. A fork may itself report 10143, so retain the RPC origin,
fork block and local-node configuration to distinguish a rehearsal from public testnet.

Build the concrete production-path artifact with the pinned toolchain before estimating:

```sh
cd contracts
forge build src/engine/BookRiskEngine.sol --skip-lint
cd ..
```

Prepare ABI-encoded constructor arguments for `(vault, reserveTreasury, Listing)` without a
function selector. `Listing` field order is defined by `IMarketConfig.sol` and the artifact ABI.
For example, in Git Bash, with the actual addresses and tuple already populated:

```sh
cast abi-encode 'constructor(address,address,(bytes32,address,address,address,address,address,uint64,uint64,bytes32,bytes32,(bool,uint64,uint256,uint64),uint8,uint256,uint32,bytes32,address,bytes32,uint256,uint256,uint256,uint64,uint64,uint64,bool))' \
  "$VAULT" "$TREASURY" "$LISTING" > constructor-args.hex
python scripts/monad-preflight.py --from "$DEPLOYER" --constructor-args-file constructor-args.hex \
  --output artifacts/risk/monad-engine-preflight.json
```

`--artifact` can select an explicit Foundry artifact. The script rejects test compositions,
wrong compiler settings, unresolved library links and oversized runtime/initcode. It reads
network metadata and estimates creation at the reported block under the 30M allowance.
Constructor dependencies must already exist at that RPC: use a local Monad fork to rehearse
their deployment before estimating the engine. For example add `--rpc http://127.0.0.1:8545`
and, only if its chain ID is 31337, `--allow-local-chain`.

The report includes artifact/initcode hashes, byte counts, block identity, gas estimate and
headroom. An artifact's runtime template still contains immutable placeholders and is not
the final deployed code hash. Rebuild after source edits; metadata alone cannot prove freshness.
No script mode signs or broadcasts. Failure exits nonzero and must not be relabeled a pass.

Completed validation baseline **`e05bbbb8ac632b35ba15ac2da0e56bd63eec21e4`** has Solidity unchanged
from `dcb6b0e`. Runtime is **120,402 bytes**, creation bytecode **129,644 bytes**, constructor
arguments **928 bytes**, and complete initcode **130,572 bytes**. Read-only public-testnet
`eth_estimateGas` returns **27,853,253 gas** at block **67,886,057**, using the historical fixture
dependencies, not newly deployed production counterparts. Evidence:
`artifacts/risk/unified-deployment-estimate-2026-10-03.json`. This leaves 2,146,747 gas below the
30M ceiling for that specific request/state; it is not a deployment, receipt or reusable gas limit.
Re-estimate the actual constructor inputs and current state before any authorized broadcast.

Full CI passes **832 tests / 130 suites**, zero failed/skipped, in **1,461.88 seconds**
(`tmp/unified-full-ci.log`), using 10,000 fuzz runs, seed `0x45524f53`, and invariants configured
for 256 runs at depth 128. The final separate Monad run passes **99 tests / 11 suites** in
**3.04 seconds** (`tmp/unified-monad-final.log`). Python A/B/audit/integration passes
**66/156/8/7**, total **237**, and SDK compilation/six Node tests pass. Format and ABI export/check
exit zero; current ABI counts are **294 concrete / 256 abstract / 35 vault**. Do not add
overlapping Forge runs or Python/Node tests to the full Forge total. Ordered G0–G7 pass at
`c91acf75ae9770f0bf5ae2238b4018202d57acd8`, with counts **88/152/117/78/77/63/55/156** and no
skipped checks. Source-bound A043/B043 checks pass **68/3**. The user's explicitly authorized
G7 acceptance is recorded in `docs/spec/gate_status.json` at **2026-10-03 17:39:11 UTC**, with
`reviewed_by: []`. Technical runners still emit `accepted=false` / `merge_sha=null`; their output
is not the human acceptance record. Aggregate evidence:
`artifacts/risk/unified-integration-2026-10-03.json`. This accepts the non-oracle local integration
candidate only: actual production inputs remain missing, oracle integration remains excluded,
and no main merge, production approval or new deployment follows.

Historical pre-RB-I11 qualification after sampler `3942100` and execution bounds `be3db1e` is recorded
in `docs/integration/NON_ORACLE_FIXES.md`. Targeted Monad checks pass **92/92** at validation source
`1654b9f` (production code unchanged from `be3db1e`). The engine artifact
is **120,253 runtime bytes**, **129,495 creation bytes**, and **130,423 initcode bytes** including
928 constructor bytes. The actual read-only public-testnet `eth_estimateGas` at block
**67,865,259** returns **27,820,847 gas**; see
`artifacts/risk/non-oracle-deployment-estimate-2026-10-03.json`. This estimate does not broadcast
or update the older immutable contract; re-estimate the selected source/constructor state before
any separately authorized deployment. The earlier engine's 114,546-byte runtime and 27,904,929
receipt gas are historical measurements of different bytecode, not these changes.

## Concrete execution bounds

Read `maxFills()` from the actual deployment; the current concrete constructor sets it to **8**.
This counts examined makers, including stale/expired candidates, not only successful fills.
`maxBatchActions()` is **8**, counting cancel requests plus place requests. A batch also rejects
aggregate requested `maxFills` above eight across its non-POST_ONLY placements, even if some of
those requests would finish early. These checks happen before executing the batch's actions.

Use `maxFills=0` for POST_ONLY requests or otherwise obey the actual deployment's request bounds.
Split larger matching/cancel/replace work across separate transactions; do not bundle repeated
individually bounded calls through a multicall and assume the entire transaction is qualified.
The abstract Book can support other bounds; its 64-node fixture is not this concrete deployment's
gas guarantee. The **sampler's separate 64-node read budget** remains unchanged.

Pre-RB-I11 full-history, 64-node sampler benchmarks cover bootstrap and normal mode. Worst measured calls
use **3,383,491 gas for capture**, **3,290,777 for promotion**, and **3,143,792 for `bookDepth()`**
under Monad execution. They are local call measurements, not public-chain receipts or a fixed
gas limit to copy. Re-estimate the current deployment/state and include bounded inclusion slack.

Historical pre-RB-I11 full CI at `4a050df` passes **825 tests across 129 suites**, zero failed/skipped, in 1,469.81
seconds. It uses 10,000 fuzz runs with seed `0x45524f53` and invariants configured for 256 runs
at depth 128. The earlier `risk`-profile result at `1654b9f` is 818 tests / 128 suites, before
the seven RB-I08 regressions. These are separate source/profile results, not additive counts.
The completed CI command, from `contracts`, is:

```sh
FOUNDRY_PROFILE=ci FORGE_SNAPSHOT_EMIT=false FORGE_SNAPSHOT_CHECK=true \
  forge test --fuzz-seed 0x45524f53 -vv
```

Log: `tmp/non-oracle-full-ci.log`. This local CI run is not a new Monad deployment, peer approval
or proof that RB-I11 is fixed. Separate ordered gate results at `4a050df` are G0-G6 exit 0,
with counts **71/152/117/78/77/63/55**, and G7 exit 2 after six tests because A043's source-bound
review is stale. Separately run A044/B040/B041/B042/B043/B044 checks exit 0 with counts
44/2/2/3/1/1; direct G7 Solidity passes six tests in two suites. Format and ABI checks exit 0,
with ABI entries 294/256/35. These downstream technical checks did not constitute an ordered G7
pass. GOV-01 subsequently retired mandatory peer approval; the old exit 2 remains historical
evidence, not a requirement for a nonexistent separate owner. The unified runner migration and
current G7 acceptance are recorded separately above. Historical evidence:
`artifacts/risk/non-oracle-fixes-2026-10-03.json`.

## Maintaining book-derived PERP observations

This section applies only to a newly validated, qualified deployment containing RB-I05/RB-I11. It is
not an instruction to reuse the old closed smoke market or permission to deploy/broadcast again.
Policy and local regression evidence are in `docs/questions/RB-I05-book-depth-policy.md`.
The current-source mechanics below include RB-I11's implemented seal; their final validation
does not follow merely from historical RB-I05 gas tests or the older deployed smoke receipts.

`bookDepth()` is a read-only view returning bid/ask VWAP, accepted lots per side, examined-node
count and a state fingerprint. It consumes exactly listing depth N on each side, with bid rounded
down and ask rounded up. The shared budget is 64 examined nodes, bid first; dirty/expired nodes
consume the same budget as eligible ones. A zero price or missing N means unavailable, not a
best-price quote. Reduce-only orders are deliberately excluded; shown liquidity is not assumed
executable when account/market epochs, projected full backing or accounting readiness disagree.

`samplePerp()` is permissionless and accepts no caller price, timestamp or depth. Each call:

1. Attempts to promote the previous capture, only in a later block and at age at most 30 seconds.
2. Rechecks current bounded depth/account eligibility, Book mutation revision, market/risk epochs,
   and the original independent INDEX checkpoint. A changed or expired capture records an
   unavailable observation rather than extending valid coverage.
3. Requires the pinned authenticated INDEX source's `lastObservedAt` to be strictly newer than
   capture time before valid publication. An otherwise eligible, unchanged capture waits without
   writing PERP/BASIS or replacing its original timestamp; the 30-second expiry still applies.
4. After resolving the old candidate, captures current eligible depth for a later call, provided
   this is a strictly newer timestamp. A waiting candidate is not replaced by a moving target.

Do not call twice in one block: the second call reverts `SameBlockBookSample()`. Repeated blocks
with the same timestamp cannot create replacement captures for an already sampled second.
Use `BookDepthCaptured` for capture time/block and `PerpObservationRecorded` for actual promotion
time provenance; transaction submission or a new capture is not proof of a valid PERP sample.
Accepted observations retain the **original capture timestamp**, not the later promotion time.

A keeper should maintain fresh authenticated independent INDEX history, then call the sampler
on later blocks at a cadence comfortably below 30 seconds, allowing inclusion/confirmation slack.
For an explicitly authorized rehearsal, a 10-second cadence is an operational starting point,
not a freshness bypass or guaranteed inclusion policy. Estimate calls against the actual chain,
enforce the qualified transaction gas limit and spending budget, and stop/back off on failures.
Avoid simultaneous keepers and repeated paid-RPC polling. Newer INDEX samples need not be paused:
promotion compares the checkpoint at capture time, so a replacement/backfill affecting that
checkpoint invalidates a **pending** capture. Publication additionally waits until the strictly
newer authenticated checkpoint seals that prefix. Existing monotone ingress then rejects later
corrections at or before the published capture. Intervening Book mutations invalidate a pending capture;
continuous mutation or insufficient eligible depth can therefore prevent successful promotion.

RB-I11 requires an accepted INDEX observation strictly newer than the pending capture, retaining
the unchanged capture while waiting rather than renewing its timestamp. Continuous normal pricing
therefore needs INDEX cadence **below 30 seconds**,
such as 10 seconds with inclusion headroom; an exactly 30-second feed can produce a sample
already at its age limit. This is an implemented freshness constraint, not permission to edit
signed timestamps or a production feed-service guarantee. Fresh-INDEX fully backed bootstrap
startup remains independent of PERP publication. Retain new regression and gas evidence for the
actual source/deployment rather than reusing pre-seal measurements.

Normal pricing additionally needs continuous PERP 60-second and BASIS 900-second coverage,
the required INDEX window and a completed accounting epoch. Maintain both sides' eligible N,
fresh INDEX and timely captures throughout warm-up; one successful promotion is insufficient.
Complete due accounting work through the engine's bounded rollover/reconciliation ports. Missing
windows, stale samples or thin books do not fabricate marks: eligible fully backed bootstrap
place/match/cancel remains available with fresh INDEX, subject to the existing stage/band rules.
The sampler never enables leverage, funding, calibration, recovery or production counterpart roles.

Record each capture/promotion transaction, original observed time, receipt, actual gas/fee,
depth availability, mode and accounting epoch. Existing local full-window tests are not evidence
of a continuously maintained live public-chain market. The 2026-10-03 smoke receipts below cover
the earlier bootstrap-only deployment, not this sampler's runtime or keeper workflow.

## Deployment sequence and acceptance evidence

1. Review the exact source and deployment manifest. Re-run relevant economic/Book regressions,
   including RB-I01/RB-I11 behavior, and affected gates. Technical passes alone do not grant
   production approval or fabricate an independent audit or gate-acceptance record.
2. Rehearse on Monad execution or a pinned Monad fork without oversized-contract or transaction
   limit bypasses. Estimate the full engine constructor, including its internally created ReserveVault.
   Runtime size alone does not establish deployability; splitting may be needed if gas exceeds 30M.
3. After explicit broadcast authorization, deploy/verify selected dependencies and the engine,
   register the engine through the vault governor, and verify listing hash, token, treasury and roles.
   Follow the chosen oracle's authenticated binding procedure; do not copy unrestricted mock binding.
4. Fund via token approval, vault deposit and allocation, seed reserve if selected, activate through
   governance, and supply authenticated index observations with the correct chain/engine domain.
5. Exercise real user placement, multi-maker fills, cancellation, invalid/stale reductions, release,
   authenticated halt/finality, bounded preparation and actual fixed-recipient claims. Record which
   paths need elapsed public-chain time and which remain untested. A bootstrap-only market cannot
   substitute for normal-mark liquidation or leveraged-risk evidence.
6. Retain chain ID, RPC/fork distinction, source/tool versions, constructor inputs and listing hash,
   deployment/interaction transaction hashes, final receipts, actual runtime code/hash, gas/fee costs,
   conservation assertions, and real-versus-simulated counterpart status. Verify receipt success and
   actual bytecode rather than inferring success from an address or transaction submission.

This runbook does not select a wallet, collateral asset, production authority, calibrated parameters,
or spending limit. It does not authorize a mainnet deployment or close missing counterpart work.

## Controlled testnet fixture deployment

`contracts/script/DeployTestnetRiskBook.s.sol` prepares a deliberately controlled demonstration,
not the production oracle/feed/factory. It refuses every chain except 10143 and requires the
public `TESTNET_DEPLOYER` address from the environment. The script never reads a private key.

It creates four top-level contracts: permissioned six-decimal `RISK-TEST` collateral, the real
CollateralVault, a permissioned test resolution authority, and the real BookRiskEngine. The
engine additionally creates its ReserveVault. The script registers the engine in the vault and
binds the authority once. It does **not** mint, deposit, allocate, activate, trade or resolve.

The deployer controls fixture minting and resolution, and is the listing's governance, monitor,
treasury and signed-index signer. Its registry field is an explicit fixture stand-in, not a factory.
The listing hashes identify test-only manual data/finality. The fixture uses a ten-day horizon,
cap 1, 1,024 traders, depth 500 lots, 0.05 spread/band, zero liquidation pacing allowance and
funding disabled. These are demonstration inputs, not empirical calibration recommendations.

Both fixture constructors accept only 10143 or local 31337; the deployment script is stricter.
Only the controller can mint or bind/halt/finalize. The authority accepts binary payoff 0/1 via
`finalize`, and separate `finalizeInvalid`; it implements no evidence, disputes or oracle voting.
The engine, not this controller wrapper, enforces finality immutability and preparation gates.

With the private RPC stored locally as `MONAD_TESTNET_RPC`, a simulation without broadcasting is:

```sh
cd contracts
FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false forge script \
  script/DeployTestnetRiskBook.s.sol:DeployTestnetRiskBook \
  --network monad --rpc-url "$MONAD_TESTNET_RPC" --sender "$TESTNET_DEPLOYER"
```

There is deliberately no `--broadcast` in this example. The risk profile's large size allowance
is for the script/test harness only; enforce real runtime/initcode and 30M per-transaction limits
on every resulting deployment. Fund/activate/trade only under an explicitly approved scenario.

## Executed controlled smoke workflow

Use the [integration tracker](../integration/RISK_BOOK_TRACKER.md) for current addresses, ownership,
remaining work and transaction links. The 2026-10-03 public-chain records are the
[verified deployment](../../artifacts/risk/monad-testnet-deployment.json),
[ordered smoke transactions](../../artifacts/risk/monad-testnet-smoke-transactions.json), and
[verified completed smoke](../../artifacts/risk/monad-testnet-smoke.json). These records distinguish
actual successful receipts and runtime comparisons from rehearsals. They are not production
release approval, independent economic review, or evidence for the missing live counterparts.

The successful sequence uses the already authorized encrypted keystore outside Git. The
`TESTNET_DEPLOYER` environment value is only its public address. Keep the keystore, password file,
private RPC URL and unsanitized command output outside committed evidence. Never put a password
or private key in a command example, shell history, chat or source file.

### 1. Deploy, verify, then set up actors

Run the reviewed `DeployTestnetRiskBook` deployment only after its simulation, size/gas checks
and explicit spending authorization. Verify all six successful transactions, deployed code,
vault registration and authority binding with `scripts/verify-monad-deployment.py` before setup.

`ExerciseTestnetRiskBook.setup(address engine)` then performs five authorized transactions:
create the smoke coordinator and two trader actors, mint 100 `RISK-TEST` (100,000,000 six-decimal
atoms) to each actor, fund both through token approval plus the actual vault deposit/allocation path,
and activate through engine governance. Use `SmokePrepared` to identify the coordinator and
actors. Actors accept only their coordinator; the coordinator accepts only the controller.
There is no arbitrary-call helper or accounting authorization bypass.

Retain and verify the five setup receipts before trading. Confirm the deployed coordinator's
controller and engine, `funded=true`, `traded=false`, `completed=false`, exactly two participants,
200 USDC-equivalent allocation, and an active, non-halted engine. Use the actual listing and
source state; do not reuse predicted addresses or constructor inputs from an earlier dry run.

### 2. Prepare fresh trade calldata without a remote fork

**Do not use the forked `ExerciseTestnetRiskBook.trade(address)` broadcast path for this live
workflow.** In the observed attempt, remote-fork storage reads outlasted the 30-second price
freshness bound. Local simulation succeeded at its old fork time, but node gas estimation
reverted with `UnusableIndex()` (`0x4044fef1`); no trade transaction was sent. Replaying that
`trade-latest.json` calldata cannot refresh its signed timestamps.

The successful route uses `contracts/script/PrepareTestnetTrade.s.sol:PrepareTestnetTrade`.
It neither forks nor calls an engine/RPC nor broadcasts. It generates **11** synthetic samples
at **30-second** intervals spanning `[latestAt - 300, latestAt]`, each with depth 500, price 0.5,
impact bid 0.49 and ask 0.51. It signs the canonical raw observation digest with the loaded
controller keystore through `vm.sign(address, digest)`. The digest remains bound to chain 10143,
the actual engine, market and source/rules identity. No EIP-191 prefix is added.

Before the timed section, finish compilation, check the keystore/controller address, verify
RPC chain ID 10143, and read the engine listing/source state. Match the market/source/rules
values to the deployed fixture. Set `FIRST_SEQUENCE = source.lastSequence + 1`; the prepared
window requires `source.lastObservedAt <= latestAt - 300`. The initial successful smoke had
no previously accepted samples. Do not send a backwards window into an already updated source.

Then start an elapsed-time guard and read a **fresh latest RPC block timestamp**, not the host
clock or a previous fork timestamp, into `LATEST_AT`. Immediately run the offline helper. This
Git Bash example assumes pinned Forge is on PATH and the public inputs plus private local paths
are already populated; it deliberately clears both inherited fork URL variables for that child:

```sh
cd contracts
env -u ETH_RPC_URL -u FOUNDRY_ETH_RPC_URL \
  FOUNDRY_PROFILE=risk FORGE_SNAPSHOT_EMIT=false \
  forge script script/PrepareTestnetTrade.s.sol:PrepareTestnetTrade \
  --chain 10143 --network monad --hardfork monad:MonadTen \
  --sender "$TESTNET_DEPLOYER" --keystore "$KEYSTORE_PATH" --password-file "$PASSWORD_FILE" \
  --sig 'prepare(address,bytes32,bytes32,bytes32,uint64,uint64)' \
  "$ENGINE" "$MARKET_ID" "$SOURCE_ID" "$RULES_HASH" "$FIRST_SEQUENCE" "$LATEST_AT" \
  --json > "$PREPARED_JSON" 2> "$PRIVATE_PREPARE_LOG"
```

There must be **no** `--rpc-url`, fork option or `--broadcast` on this command. In PowerShell,
clear `Env:ETH_RPC_URL` and `Env:FOUNDRY_ETH_RPC_URL` in the child environment too; merely omitting
`--rpc-url` is insufficient. Restore the parent environment without printing either value.
Require exit zero and JSON `success=true`; the returned hex is `returns.callData.value`.
Signatures and calldata are public transaction data, but do not publish unsanitized logs.

### 3. Estimate once and send the exact fresh bytes

Immediately ask the actual node for `eth_estimateGas` with `from=TESTNET_DEPLOYER`, `to=SMOKE`,
`value=0` and the prepared bytes as `data`. An estimate failure is a stop condition, not a reason
to disable checks. Select a bounded gas limit from this fresh estimate, below 30M and within
the approved MON budget; do not copy old gas prices or oversized harness limits.

Before sending, require both elapsed preparation time and the signed latest sample's age at
a newly read latest block to be **less than 20 seconds**, with no future timestamp. This leaves
inclusion headroom but does not guarantee inclusion within 30 seconds. If the guard fails,
discard the calldata, reread source sequence/time and regenerate from a fresh block. Keep retries
bounded; do not re-sign or resend blindly after an ambiguous send without checking its receipt.

Send the exact bytes directly with the same authorized encrypted keystore, for example:

```sh
cast send "$SMOKE" --data "$CALLDATA" --chain 10143 --rpc-url "$MONAD_TESTNET_RPC" \
  --keystore "$KEYSTORE_PATH" --password-file "$PASSWORD_FILE" \
  --gas-limit "$APPROVED_GAS_LIMIT" --json > "$TRADE_RECEIPT_JSON" 2> "$PRIVATE_SEND_LOG"
```

`--data` takes literal hex; load the file's returned value into the variable rather than assuming
`@file` syntax. Check exit status, transaction hash and successful mined receipt. In one transaction
the coordinator relays authenticated observations, rests the seller's 100,000-lot limit at tick 500,
and submits the buyer's matching IOC. It asserts the consumed order, positions `+100,000/-100,000`,
cash `50/150` USDC-equivalent and zero protocol fees. A late inclusion still fails the original
freshness checks and rolls back observations and both orders atomically; no stale-price bypass exists.

### 4. Halt, finalize YES, prepare and claim

After verifying the trade, `ExerciseTestnetRiskBook.settle(address smoke)` uses three controller
transactions: authority halt, authority `finalize(1)`, and coordinator `completeSettlement()`.
Matching repeated YES finality is accepted for retry; conflicting finality still reverts. The
script refuses an untraded or already completed coordinator before starting its broadcast.

Preparation is bounded: two one-account snapshot pages, then four one-account payout pages
(two scans and two allocations), followed by `finishPreparation` and actual vault-backed claims.
The coordinator checks **150/50 USDC-equivalent** actor token balances, every trader claim paid,
and zero recognized/token custody remaining in the vault. Inspect all three successful receipts;
finality alone is not proof that preparation or claims completed.

This is a terminal smoke: the engine remains halted/complete, not a reusable continuous-trading
demo. Claimed fixture tokens remain in the actor contracts, which deliberately have no withdrawal
or arbitrary-send port. They are not real collateral or user wallet balances. The index is synthetic,
finality controller-operated, funding/recovery disabled, and no normal-PERP pricing claim is made.

Run `scripts/verify-monad-smoke.py` with the expected controller/engine/coordinator and the ordered
setup-five/trade-one/settlement-three receipt list. It is read-only: it checks code, successful
transactions and final state without signing or broadcasting. Update the linked tracker/evidence
only after verification; preserve failed estimation attempts as failed operational evidence, not
failed mined transactions or successful trades.

## Wallet and QuickNode cost controls

The public address and funded test MON balance do not provide a signer. Use the approved
encrypted local keystore outside Git, with its password entered privately when needed, or an
explicitly supported hardware/wallet-app signing workflow. `vm.startBroadcast(address)` merely
selects the sender; it does not import keys or unlock a wallet. Never export a wallet-app seed to
make a script work. Keep key files, passwords, RPC authentication tokens and unredacted RPC logs
out of source, chat, reports and commits. Retain only public addresses and sanitized evidence.

Do not infer QuickNode account entitlements or remaining credits from a working endpoint.
The public pricing page currently lists Build with 80M monthly API credits and 50 requests/second,
but the user's dashboard, legacy plan and endpoint-specific controls determine actual limits.
Overage can be billed; there is no assumption that requests stop automatically at the allowance.
[QuickNode pricing](https://www.quicknode.com/pricing),
[monthly usage limits](https://support.quicknode.com/articles/5364861616-monthly-usage-limits)

Read-only RPC calls consume provider credits too; method costs differ and batching does not make
individual requests free. Review Usage & Billing plus endpoint Metrics before and after work.
Do not enable auto-scaling, upgrade plans or add paid services as part of a test run.
[Credit rate limits](https://support.quicknode.com/articles/7146659276-error-credits-limited-to-x-sec),
[dashboard controls](https://www.quicknode.com/guides/quicknode-products/how-to-use-the-quicknode-dashboard)

Use serial low-rate calls, one active rehearsal, and a pinned local fork for repeated tests rather
than running fuzz suites directly against the paid endpoint. Begin manual polling at roughly one
request/second, avoid overlapping deployments/estimates, and back off or stop on rate-limit errors.
Keep retries bounded; honor provider retry guidance and the approved credit budget. RPC credits
and on-chain test MON gas are separate budgets. Successful preflight proves neither affordability
of an unbounded scenario nor authorization to spend more.
