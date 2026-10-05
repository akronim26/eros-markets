# Real factory, oracle, risk and book integration

Started 2026-10-05 at `db11e46` on `integration/risk`. The user authorized the first
four integration work packages: factory, real-engine keeper, pricing/market operations,
and end-to-end validation. This explicitly extends the older oracle-exclusion scope.
Sponsor adapters and frontend work are excluded. No mainnet release, main merge or
new gate acceptance is inferred. Existing untracked files are preserved.

## Work ledger

For the subsequent complete integration work, use
[INTEGRATION_READINESS.md](INTEGRATION_READINESS.md), the versioned SDK handoff
and the deployment runbook it links. The historical 1x run described below is
stopped; its journals and receipts are preserved. Its Windows pricefeed and
participant-gas failures are historical findings, with current fixes and reruns
recorded separately. Do not assume that its former local API is still running.

The current reserve-funded leverage extension is documented in
[LEVERAGE_INTEGRATION.md](LEVERAGE_INTEGRATION.md). It supersedes the original
single-store deployment sizes and 1x-only constructor restriction below; the dated
measurements remain evidence for their original source revisions.

| ID | Work | Status |
| --- | --- | --- |
| RF-01 | Full atomic factory feasibility, implementation and authorization tests | Done locally; actual listing/deployment estimates remain mandatory |
| RF-02 | Per-market keeper identity and real-engine gas readiness | Guards and tests done; live runtime enrollment/gas profiles pending |
| RF-03 | Sampler, signed INDEX delivery boundary and explicit monitor operations | Real publisher pipeline and book sampler exercised locally; approved external source/hosted operations pending |
| RF-04 | Real registry/oracle/book/risk cash lifecycle and failure regressions | 41 local integration tests pass; actual local transactions through keeper/claims; public lifecycle not performed |
| RF-05 | Enforce registry OI cap and execution-capacity-aware depth | Implemented and regression-tested |
| RF-06 | Reproducible local stack, source bundle and team read interface | Implemented locally; detailed handoff intentionally uncommitted |
| RF-LIVE | Correctly authorized testnet factory switch and real-market lifecycle | Blocked by oracle operator access, actual configuration and independent publisher |

## Joined local execution — 2026-10-05

The combined base is `b7b8442` after fast-forwarding the existing pricefeed branch.
The runner and compatibility changes are included in the RF-06 source checkpoint. Run
`python scripts/integration/local-stack.py run --keep-running` after installing the
pinned dependencies using the [committed setup instructions](LEVERAGE_INTEGRATION.md#local-scenario).
The additional addresses, configuration mapping,
service access and source-sharing procedure are in the deliberately uncommitted
root `LOCAL_INTEGRATION_HANDOFF.md`. No private dotenv files are exported.

The successful local sequence uses actual Timelock/registry/factory/oracle engines,
owner funding, partial fills, cancellation, release/withdrawal, authenticated source
observations, real book sampling, early terminal resolution, actual keeper transactions
and fixed-owner cash claims. Buyer/seller terminal payouts are 105/95 fixture tokens.
The second market remains unhalted. Receipt reconciliation verifies 86 script and
5 keeper transactions against canonical RPC blocks. Script gas limits remain below
the configured 30M cap; see the run's receipt audit for exact measurements.
Pricefeed/sampler receipts are additional.

The final clean run at `tmp/local-integration-verified-20261005/` passes all 19
orchestration steps and 11 real HTTP interface checks. It audits 101 distinct script,
keeper and upkeep transactions in total, with a maximum script gas limit of 28,767,604.
The local read API remains at `http://127.0.0.1:8787`; the committed source lets other
teams reproduce it without sharing private env files or runtime journals.

Hourly accounting maintenance is part of the joined run, not an assumed external job:
the local operator calls `beginRollover`, bounded `rollPage(32)` and `finishRollover`.
Explicit fixture owners batch-cancel stale orders and place fresh POST_ONLY quotes.
A deliberate hour crossing verifies both markets return to READY and sampling resumes;
10 additional canonical upkeep transactions cover both markets. Without this job,
accounting correctly stops new liquidity at the epoch boundary. No READY/pricing guard
is weakened. Public deployment still needs a real epoch operator and owner-authorized
liquidity strategy rather than these disposable fixture signers.

Anvil 1.8.3 uses MonadTen execution, 128 KiB runtime limit and a deterministic local
clock (one-second blocks/timestamp increments, four-block simulated finality).
Virtual timestamp advances test windows/liveness, not measured public-chain latency.
Real INDEX availability and valid book PERP samples are checked; mark availability
still requires its own 900-second basis history. No availability guard is bypassed.
The local read API offers coherent snapshots, ABI discovery and paginated raw events,
not a production indexer. Both normal and one-shot runs require a valid book sample.

Fresh validation includes 832 passing risk/book tests under the accepted Prague
profile, 41 factory/integration tests, 95 keeper tests, 56 oracle SDK tests, 18
market-operation tests and 249 offline oracle service/workflow tests. Python A/B/
audit/integration passes 46/156/8/7. Focused pricefeed checks pass 48 tests. Exact
commands, local harness counts and logs are in the uncommitted handoff.

Two broader-suite limits remain visible: the full risk suite under MonadTen has one
legacy 10,000-gas assertion failure (11,071 observed), and native-Windows pricefeed
testing has 75 failures out of 420 on custody/POSIX/process assumptions. Those guards
are not weakened and a fully green cross-platform release is not claimed.

All source data/evidence/adjudication are controlled fixtures. No supplied public
private keys or paid-provider credentials were required or consumed. Shared public
operator configuration still requires actual role checks and real-source approval.
Root `addresses.md`, public deployments and previous acceptance records are unchanged.

## Implemented factory design

Preserve `BookRiskEngine` and its inherited constructors. Deploy its pinned creation
bytecode in two STOP-prefixed, non-executable code-data contracts. A small factory
verifies and joins that code, appends the existing constructor arguments and creates the engine
atomically inside `MarketRegistry.createMarket`. This is not an upgradeable proxy.
Every engine retains its own immutable configuration and separately authorized reserve.

The factory's approved artifact is `RegistryBookRiskEngine`, a derived composition
in `oracle/src/integration/`. Its constructor runs the original `BookRiskEngine`
constructor unchanged. Registry OI capacity is read from the immutable market record,
with `core.engine == address(this)` verified. Every ordinary/forced book fill must
leave `oiAllLots <= core.oiCapLots`. Direct pair reductions, reserve unwinds and
whole-account takeovers cannot increase one-sided OI. Crossing the cap reverts the
entire order transaction, including earlier fills; this is not a partial-fill limiter.
Existing account/order previews do not model that aggregate capacity: simulate the
actual transaction and expose `marketOiCapLots()` alongside current OI.

PERP depth is unavailable if remaining OI capacity cannot support the full required
depth N. This deliberately avoids inventing executable liquidity at the cap; it can
also exclude potentially safe closing liquidity. The independent INDEX and exactly
backed bootstrap/reducing trades remain governed by the original rules. The only base
engine edit in RF-05 made the internal depth hook virtual. The later leverage
extension adds constructor/profile guards and a ceiling view as documented above.
No existing deployment is upgraded.

The factory creates a dedicated `CollateralVault` with itself as immutable governor.
Its only registration path registers engines it has just created for its pinned registry.
It cannot register arbitrary predeployed engines, withdraw user funds, or change the
collateral token. An old vault does not acquire a new registration authority.
The initial factory accepts empty `engineInit` only; all configuration uses the existing
listing and pinned vault/reserve-treasury dependencies. Registry, resolution authority,
governance and token must match. Market IDs cannot be reused. Any downstream failure
rolls back creation, registration and treasury listing commitment.

The bytecode store avoids embedding the large creation code in factory runtime. It does
not reduce per-market engine code-deposit gas. The previous receipt charged the selected
gas limit; adding that number to a complete stub-listing receipt is not an exact combined
measurement. Full-path measurements and target-chain limits remain deployment gates.
If the measured path does not fit, stop deployment and record the required redesign;
do not silently replace constructors with insecure clone initialization or skip checks.

## Evidence boundaries

- Real book/risk and real oracle contracts in local tests do not establish live CRE,
  external evidence truth, continuous INDEX delivery or live testnet operation.
- Scripted collateral, INDEX observations and assertion-venue decisions remain fixtures.
- Existing G7 acceptance is historical; new factory and operations work needs fresh checks.
- E8, CRE deployment access/E10/E11 and live O42 remain separate unfinished oracle items.
- An external publisher must provide actual source data. No service may manufacture
  liquidity, replace independent INDEX with this book, or enable unvalidated auto-resolution.
- A monitor incident is explicit operator input, not an invented automatic detector.
- Local test results below are not public-chain receipts or a new gate acceptance.

## Measured local feasibility

Contract source: `0255c7b`; combined implementation checkpoint: `0ff2b69`.
Machine-readable evidence: [real-factory-local.json](../../artifacts/integration/real-factory-local.json).
Forge 1.8.3, solc 0.8.30, Prague, optimizer 200, oracle `bytecode_hash = "none"`;
tests execute with `--network monad --hardfork monad:MonadTen --isolate`.
The factory tests explicitly forward **29,000,000 gas** to the complete registry
listing call. Both representative successes fit, including engine/reserve creation,
vault registration, listing storage, treasury commitment and oracle initialization.

| Measurement | Result |
| --- | ---: |
| Small listing isolated registry call | 27,377,990 gas |
| Small listing plus additional standard calldata intrinsic allowance | 27,426,186 gas |
| 8 KiB rendered claim isolated registry call | 28,968,994 gas |
| 8 KiB rendered claim plus additional standard calldata intrinsic allowance | 29,134,522 gas |
| Code-store creation, isolated local deployment measurement | 28,274,895 gas |
| Factory plus dedicated vault creation, isolated local measurement | 2,375,996 gas |
| Registry-bound engine runtime / full engine initcode | 121,195 / 131,330 bytes |
| Code-store runtime / full store initcode | 130,403 / 130,861 bytes |
| Factory runtime / full factory initcode | 3,234 / 11,520 bytes |
| Collateral vault / reserve vault runtime | 6,562 / 2,387 bytes |

These are local harness measurements, not broadcast transaction receipts. The extra
intrinsic allowance is deliberately conservative and is not an exact public-network
estimate. A 16 KiB rendered-claim fixture fails within the same execution budget **and rolls
back every deployment, vault registration, market record and bond commitment**.
An 8 KiB rendered claim is not an unconditional safe limit: source feeds, allow-lists,
groups and current state also affect the full transaction. The code store has only
**669 bytes** of runtime headroom against the tested 131,072-byte limit. Re-measure
after any source/compiler change; a larger artifact may require a multi-store design.

Representative bounded real-engine jobs, measured separately:

| Job | Local isolated gas |
| --- | ---: |
| Scheduled halt | 457,313 |
| Finalize with test assertion venue | 299,947 |
| Snapshot page, 32 traded accounts | 2,996,572 |
| Payout scan page, 32 accounts | 1,570,337 |
| Payout allocation page, 32 accounts | 2,477,255 |
| Finish preparation with 256 reserve holders | 10,653,472 |
| INVALID missing-window fallback | 119,782 |

These do not populate live keeper gas profiles. In particular, mock-venue finalize
gas is not live UMA gas. Unmeasured runtime/job combinations remain refused.

## Validation record

- New integration suite: **37 passed, 0 failed**, four suites: factory authorization/
  rollback, real fills and oracle lifecycle, factory gas/size, bounded clearing gas.
- Lifecycle coverage includes early YES, scheduled NO, INVALID grace/fallback,
  disputes, rejected proposals, caller-funded resolution, void, exclusive groups,
  claims gating, owner-correct transfers, cancellation/release/withdrawal, replay,
  64-byte forwarder metadata, OI-cap rollback and capacity-aware depth sampling.
- Keeper: **87 passed, 0 failed**; market operations: **18 passed, 0 failed**.
  Both TypeScript typechecks and frozen workspace installation exit 0.
- Full existing risk/book baseline: **832 passed / 130 suites**, no failures/skips.
  That full run began before the internal depth hook gained `virtual`; the final
  source's focused book/sampler/smoke/integration checks pass **55/55 / four suites**.
- Base ABI exports check current: 294 concrete-engine, 256 abstract-engine and 35
  vault entries. Only the concrete engine's source digest changed; no base ABI entry
  changed. The factory variant additionally exposes `marketOiCapLots()` and two errors;
  its authoritative ABI is the `RegistryBookRiskEngine` compiler artifact.
- Ordered affected risk gates **G3, G4, G6, G7 all exit 0** at `0ff2b69`, with
  78 / 77 / 55 / 156 checks respectively. Their fresh technical evidence records
  `accepted=false`; historical `docs/spec/gate_status.json` acceptance is untouched.
  These risk gates do not replace the new oracle/factory suite or live OG3b evidence.
- Broader oracle SDK run: **48 passed, 6 failed** on this Windows checkout. Two
  failures compare raw CRLF ABI snapshot/module bytes against LF hashes; four are
  pre-existing test-fixture `URL.pathname` drive-path failures. The production SDK
  root-path fix has its own passing Windows regression. These failures are not
  reported as passes or silently removed; this is not an all-project green-CI claim.
- Existing oracle Solidity CI-profile run: **294 passed, 4 failed, 0 skipped**, 39
  suites, with 10,000 fuzz runs and 256 x 128 invariant settings. The initial run
  explicitly excluded compiling `UmaImports.sol` with solc 0.8.30: UMA needs 0.8.16.
  Consequently three suites failed setup for a missing OOv3 artifact; the fourth
  failure was a raw CRLF claim-vector comparison. All 16 invariant checks passed.
  An isolated retry used the official checksum-verified solc 0.8.16 UMA build and an
  LF-normalized copy of the existing vector, with no test/source modifications:
  **49/49 passed** (gas 29, UMA 18, vectors 2). The original failed run is retained;
  this retry is not mislabeled as a single clean full-suite run.
- New Solidity files pass their scoped format checks; `git diff --check` passes.
  A whole existing base-file formatting check still reports CRLF/style differences;
  unrelated base formatting is not rewritten as part of the one-keyword hook change.
- Assertion decisions, collateral and signed INDEX inputs in local Solidity tests
  remain controlled fixtures. Offchain helpers use fake transports. Neither is a
  substitute for real source, service, wallet and public-chain end-to-end evidence.

## Reproduce locally

Use Forge **1.8.3**, Solidity **0.8.30**, Prague, optimizer 200, and Bun **1.3.13**.
The dedicated oracle `integration` profile pins the compiler and separates Monad gas
tests from the legacy Ethereum/UMA suites. Its larger test-harness code-size allowance
does not exempt deployed contracts: factory gas tests explicitly check actual sizes.

```sh
git submodule update --init --recursive
cd oracle
bun install --frozen-lockfile
FOUNDRY_PROFILE=integration forge test --match-path 'test/integration/*.t.sol' --network monad --hardfork monad:MonadTen --isolate -vv
bun run --cwd services/keeper test
bun run --cwd services/keeper typecheck
bun run --cwd services/market-ops test
bun run --cwd services/market-ops typecheck
```

On PowerShell set `$env:FOUNDRY_PROFILE='integration'` separately; ensure the pinned
Forge directory precedes older system Forge installations on `PATH`. Solidity tests
advance time locally; aggregate suite gas is not a single network transaction.

## Operator handoff: public testnet remains pending

1. Obtain the actual registry governance/Timelock operator and lister. This machine
   has neither key. Do not impersonate those roles, rotate them or deploy a replacement
   oracle stack merely to bypass the missing authority.
2. Freeze the source SHA, compiler settings and source-verified creation-code
   hash for `RegistryBookRiskEngine`. A hash computed from arbitrary supplied bytes
   proves consistency, not approval. Verify registry/oracle/treasury identities on chain.
3. Select the real six-decimal collateral address and reserve-treasury beneficiary.
   The factory creates a new dedicated vault. Existing fixture-vault funds remain where
   they are; this does not migrate balances or create official collateral liquidity.
4. With current artifacts, dry-run `script/integration/DeployRealFactory.s.sol` using
   `run(address,address,address,bytes32)` arguments: registry, collateral token,
   reserve treasury, approved creation-code hash. It is restricted to chain 10143 and
   rejects a mismatched artifact. It does not switch governance, activate a market,
   initialize a feed or broadcast unless the operator explicitly supplies Forge's
   broadcast option. Estimate both store creation and factory/vault creation as full
   transactions before separately authorizing test-MON expenditure.
5. Prepare a new listing pack with empty `engineInit`, pinned actual source ID/signer/
   rules, monitor, governance and collateral. Keep the fully backed 1x/no-funding
   profile. T must be at least 24 hours after inclusion; allow scheduling slack.
   Ensure the disclosed void horizon includes T plus INVALID grace. Use a short
   real question/rules/allow-list; adopt a suitably bounded new globals version for
   future listings (the measured 8 KiB claim fixture is a ceiling candidate, not a
   proof for every feed/allow-list/group combination). Do not copy dummy fixture data.
6. Check listing-time bond commitments, cumulative per-market attempt limits, current
   venue minimum bond, assertion balance and watchdog float at the selected OI cap.
   The OI guard prevents cap overshoot, not treasury exhaustion after lost bonds or
   later venue-minimum changes. Existing listing commitment checks remain in force.
7. Have governance schedule/execute `setFactory` through the existing Timelock. Run
   a fresh complete `createMarket` simulation/estimate against the actual pack and
   state, with deployment/code/gas headroom. The lister then creates the market.
   Verify exact listing hash, registry engine, factory mapping, dedicated vault
   registration, reserve's engine, OI cap and absence of activation/halt/claims.
8. Record actual receipts, blocks, runtime hashes, addresses and source identity in
   the deployment manifest and root `addresses.md`. Do not fill these with predicted
   addresses or fixture hashes. Enroll each actual engine runtime in the keeper's
   `ENGINE_IDENTITIES_FILE`; direct engines differ by constructor immutables.
9. Calibrate real-engine gas on the target network/venue, including snapshot32,
   both payout phases, finish with reserve holders, INVALID capture, halt/finalize
   and both void paths. Add the keeper's runtime/chain-bound measurement provenance.
   Old `SettlementController` harness limits are intentionally rejected. Local
   `MockAssertionVenue` finalization gas is not deployed UMA finalization evidence.
10. Use separate funded operational accounts and manifests for the permissionless
    sampler/relay and the authorized monitor. See `oracle/services/market-ops/README.md`.
    The relay only accepts externally signed observations; it is not the missing
    publisher. No feed/market activation should be called complete without sustained
    independent data and actual two-owner funding, fills, cancellations and exits.
11. Reproduce the real-engine lifecycle on separate ongoing-demo and terminal-test
    markets. Finish live E8, CRE-access-dependent E10/E11, incident drills and O42
    with their owners. Preserve OG3b as unaccepted until its actual criteria pass.

## Configuration added (no secrets or invented addresses)

| Consumer | Required configuration |
| --- | --- |
| Factory deployment script | Registry, token, reserve treasury and approved creation-code hash as explicit arguments; operator supplies their own RPC and Forge account |
| Keeper | Existing deployment/RPC/account inputs plus `ENGINE_IDENTITIES_FILE`; exact per-market runtime hashes and chain-bound gas evidence |
| Market operations | Public deployment manifest, durable ignored journal, `RPC_URL`; `MARKET_OPS_PRIVATE_KEY` only for explicitly requested broadcast |
| INDEX relay | Externally signed chain/engine-bound observation envelope; no source signing key in relay configuration |
| Monitor command | Actual listing.monitor account plus explicit incident ID and reason; no automatic restriction clearing |

No `.env`, keystore, funded-account configuration or deployed-address record is created
by these local implementation changes. All operator secrets remain outside Git.
