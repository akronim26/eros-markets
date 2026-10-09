# Risk + Book configuration and addresses

Inventory date: 2026-10-04. This records actual script inputs and verified deployment
addresses; it does not authorize another transaction or manufacture a production configuration.
The [unified workflow](../merge/UNIFIED_WORKFLOW.md) governs non-oracle engineering.
Oracle implementation/integration remains excluded. Historical review signatures are
not prerequisites under that workflow, and technical validation is not an independent audit.

**Current testnet deployment:** use root [addresses.md](../../addresses.md) for the
October 9 replacement BTC/ETH engines, shared vault, reserves and reused oracle
infrastructure. [Deployment progress](../integration/DEPLOYMENT_PROGRESS.md) and
[the operating runbook](../integration/TESTNET_OPERATIONS.md) record activation and
the pending worker setup. The fixture descriptions and receipts below retain their
October 4 context; their manual authority is not the current resolution oracle.
The historical address table is an older, terminally settled controlled fixture. Do not copy its
addresses into a new active-market configuration or claim newer fixes are deployed there.
Use the [tracker](../integration/RISK_BOOK_TRACKER.md) and
[fix ledger](../integration/NON_ORACLE_FIXES.md) for source-bound validation status.

## Safe local setup

The repository-root [`.env.example`](../../.env.example) contains blank required inputs,
safe test settings, and explicitly labeled operator-only address placeholders. Copy it
to a local `.env` only if that file does not already exist; preserve existing local values.
Root `.gitignore` ignores `.env` and `.env.*`, except `.env.example`. Ignore rules are not
encryption and do not remove previously tracked secrets.

Make needed values available in the **process environment** before running commands.
PowerShell and the Python verification scripts do not load a `.env` file themselves;
do not assume a repository-root file is imported when launching Foundry from `contracts`.
Use the operator's approved local environment loader or secret manager. Do not echo values
to demonstrate they are set, source an untrusted file as shell code, or commit local logs
that include provider credentials.

Keep encrypted keystores and password files outside this repository. Foundry receives their
paths through `--keystore` and `--password-file`; these are CLI options, not Solidity env
inputs. `--sender` is a public address and is not a signing credential. The testnet scripts
use the loaded wallet via `vm.sign(address, digest)` and never read a raw private-key env
variable. This inventory deliberately provides no private-key or password example.

## Environment variables actually consumed

| Name | Consumer and purpose | Requirement / default | Classification |
|---|---|---|---|
| `TESTNET_DEPLOYER` | `DeployTestnetRiskBook`, `ExerciseTestnetRiskBook`, `PrepareTestnetTrade`: `vm.envAddress` | Required, nonzero; must match the loaded controller/index-signing wallet | Public address |
| `LOCAL_SMOKE_SENDER` | `LocalBookRiskSmoke`: `vm.envAddress` | Required only for the chain-31337 local mock script | Public address; not a testnet default |
| `ETH_RPC_URL` | Foundry RPC setting; default env name read by both Python deployment/smoke verifiers | Required for verifier RPC access unless `--rpc-env` selects another env name | Endpoint; treat a credentialed value as secret |
| `FOUNDRY_ETH_RPC_URL` | Alternative Foundry RPC setting | Optional; leave unset unless deliberately selected | Endpoint; potentially secret |
| `FOUNDRY_PROFILE` | Foundry and shell gate/task runners | Template selects `risk`; gate/task scripts also select `risk`; select `ci` explicitly for the CI profile | Public test setting |
| `FORGE_SNAPSHOT_EMIT` | Foundry snapshot behavior | Template `false` avoids incidental snapshot writes during checks | Public test setting |
| `FORGE_SNAPSHOT_CHECK` | Foundry snapshot validation | Set `true` for the documented validation command when applicable | Public test setting |
| `MONAD_GAS_CHECK` | `ConcreteBookBoundedGas.t.sol`: `vm.envOr` | Optional; default `false`; `true` activates gas-budget assertions under the intended Monad execution settings | Public test-only switch |

`PYTHONDONTWRITEBYTECODE` is optional Python runner hygiene, not deployment configuration.
No address placeholder named `RISK_BOOK_*_ADDRESS` in the template is automatically read by
these scripts: it is a local inventory convenience whose value must be passed to the proper
CLI argument. A blank value means **unconfigured**, not the zero address or a usable default.

### Inputs that are CLI arguments, not env cheatcodes

| Tool | Inputs and defaults |
|---|---|
| `DeployTestnetRiskBook.run()` | No function arguments. RPC/wallet/sender/network options are Foundry CLI inputs; chain must be 10143. |
| `ExerciseTestnetRiskBook.setup(address)` | Actual engine address. Creates the coordinator and actors; no address env auto-discovery. |
| `ExerciseTestnetRiskBook.feed/trade/settle(address)` | Actual smoke coordinator address. Do not use remote-fork `trade` broadcasting for the live freshness-sensitive path; see below. |
| `PrepareTestnetTrade.prepare(...)` | Engine, market ID, source ID, source rules hash, first sequence, latest observed timestamp. Explicit offline chain 10143; no engine/RPC call inside the helper. |
| `scripts/monad-preflight.py` | `--rpc` explicitly selects an endpoint; otherwise uses the public testnet RPC default. It does **not** read `ETH_RPC_URL` automatically. `--network-only` omits artifact/constructor estimation. |
| Full preflight estimate | Default artifact `contracts/out/BookRiskEngine.sol/BookRiskEngine.json`; one of `--constructor-args` / `--constructor-args-file`; select the actual `--from` rather than its placeholder `0x000000000000000000000000000000000000dEaD`. Dependencies must already exist at that RPC state. |
| `scripts/verify-monad-deployment.py` | Required `--broadcast` input-log path and `--output`; optional `--rpc-env` defaults to the **name** `ETH_RPC_URL`. Here `--broadcast` is a file argument, not permission to send transactions. |
| `scripts/verify-monad-smoke.py` | Required `--smoke`, `--controller`, `--engine`, `--receipts` ordered nine-hash JSON, and `--output`; optional repeated `--run-log`; `--rpc-env` defaults to `ETH_RPC_URL`. |

All three Python RPC tools default to a 30-second timeout. Preflight's optional
`--allow-local-chain` permits 31337 in addition to 10143; it does not authorize another
public network. The two verifiers are read-only and do not require a wallet. Their artifact
comparisons need compiler artifacts matching the deployment being verified: current-source
artifacts cannot verify older immutable bytecode as if it contained current fixes.

`MONAD_TESTNET_RPC`, `ENGINE`, `SMOKE`, `MARKET_ID`, `SOURCE_ID`, `RULES_HASH`,
`FIRST_SEQUENCE`, `LATEST_AT`, `KEYSTORE_PATH` and `PASSWORD_FILE` in runbook command examples
are **shell substitution variables**. Their names have no automatic contract/script meaning.
Passing an endpoint through `--rpc`/`--rpc-url` can expose it to local process inspection;
keep credentialed command history and unsanitized logs private. Never publish a provider token.

## Phases and address provenance

1. **Deploy fixture dependencies and engine.** `DeployTestnetRiskBook` creates collateral,
   vault, resolution authority and engine, registers the engine in the vault, and binds the
   authority. The engine creates its ReserveVault internally. Record successful receipts and
   `TestnetFixturePrepared`; predicted dry-run addresses are not deployment evidence.
2. **Verify bindings.** Read `engine.collateralVault()`, `engine.reserveVault()`,
   `engine.treasury()`, `engine.listing()`, `vault.token()`, `vault.governor()`,
   `vault.engines(engine)`, and authority `controller()` / `engine()`. Record the block,
   chain, source/artifact hashes and roles. The existing verifier independently compares the
   four top-level deployment runtimes, not the nested ReserveVault runtime.
3. **Set up actors.** `setup(engine)` produces a smoke coordinator, buyer and seller;
   `SmokePrepared` and coordinator `buyer()`, `seller()`, `engine()`, `collateral()`,
   `authority()`, `controller()` identify them. Each actor's `controller()` is the coordinator,
   not the EOA. Setup mints 100 RISK-TEST (100,000,000 six-decimal atoms) per actor,
   deposits/allocates through the real vault, and activates the engine.
4. **Prepare and send one fresh fixture trade.** Read the actual listing and
   `sourceState(listing.indexSourceId)`; use `lastSequence + 1`. Read a fresh chain timestamp
   immediately before offline signing. `PrepareTestnetTrade` generates 11 synthetic samples
   at 30-second intervals spanning 300 seconds; require the new window's first timestamp to
   be at least the source's existing `lastObservedAt`. Clear **both** `ETH_RPC_URL` and
   `FOUNDRY_ETH_RPC_URL` in that child process, omit all RPC/fork/broadcast options, and keep
   chain 10143 explicit. Estimate the exact resulting calldata on the node, enforce elapsed
   and latest-sample-age guards with inclusion headroom, then send to the **coordinator**, not
   the engine. Discard stale calldata; do not change freshness rules or replay old fork output.
5. **Settle and verify.** `settle(smoke)` halts, finalizes YES, and completes bounded snapshot/
   two-phase payout preparation and claims. This is a terminal scenario, not a persistent
   trading demo. Record the nine setup/trade/settlement receipts separately from the six
   deployment receipts and verify balances, claims, custody and immutable finality.

The [executed testnet runbook](monad-risk-book-testnet.md#executed-controlled-smoke-workflow)
contains the proven fresh-calldata procedure. The remote-fork `trade` attempt failed node
estimation with `UnusableIndex` and sent no transaction; do not repeat it as a recommended
live path. The 11-sample synthetic bootstrap window does **not** establish a live feed or
continuous normal pricing. RB-I11 selects a strictly newer authenticated INDEX checkpoint
before PERP promotion; continuous sampling needs feed cadence comfortably below 30 seconds.
Ten seconds is a fixture cadence, not an asserted production feed guarantee.

## Verified historical Monad testnet addresses

Chain **10143**, older closed controlled smoke only. Deployment observations at block
**67,852,726** and completed smoke observations at block **67,852,827** are stored in
[`monad-testnet-deployment.json`](../../artifacts/risk/monad-testnet-deployment.json) and
[`monad-testnet-smoke.json`](../../artifacts/risk/monad-testnet-smoke.json). The deployed engine
belongs to historical source `1077dfa`; the smoke report records source `5b82d9f` for its
verification context. Neither identifies current runtime as deployed.

| Historical role | Verified address |
|---|---|
| Controller/deployer; fixture governance, monitor, registry stand-in, index signer, treasury and vault governor | `0x76765dc99c2c9aed0b2c23b39960f0de0ac5da46` |
| Real BookRiskEngine, older bytecode | `0x4ae742676984d2c383645e4745eaf3943b67de72` |
| Real CollateralVault | `0x1611cb4223833a3f72c37718210d18415475e498` |
| Internally created ReserveVault, later getter/code-presence observation | `0xbb72f3a9417f8b49ccd5c3b2d22264a82dbeec7d` |
| Controlled six-decimal TestnetRiskCollateral | `0x57649a7424df6e96fa4b20598f70f2e7b5d29e62` |
| Controlled TestnetResolutionAuthority | `0x476d707343f8e238ed719d852d817318c576913a` |
| TestnetRiskSmoke coordinator | `0x0d54dd5411d2a036bc40ad854ab14289ff9075af` |
| Buyer actor | `0x8b1ee7a47ca75f9c11a9c3f4b8297e1b1bc42ad3` |
| Seller actor | `0x45b3d75f8a1f47ea2bcd4922b473d527c509637c` |

Historical market ID:
`0xed32bb659cf5269f5ff3de3899fefb4ba04cc39fc935ee8b1c29eeddb0d4a69f`.
At the recorded final block, the engine is halted with YES settlement price 1, all trader
claims paid, buyer/seller token balances 150,000,000 / 50,000,000 atoms, and vault custody zero.
Actor-held test tokens are not production collateral or an operator withdrawal balance.
The nested ReserveVault address was separately read from the historical engine's
`reserveVault()` at chain-10143 block **67,883,304**, observed **2026-10-03T17:00:55.7763840Z**;
`eth_getCode` returned **2,428 bytes**. Evidence:
[`historical-reserve-address-2026-10-03.json`](../../artifacts/risk/historical-reserve-address-2026-10-03.json).
This confirms the getter/address and code presence, not an independent ReserveVault runtime
comparison, current-source deployment, or new broadcast.

## Current testnet and production configuration

The current factory-backed BTC/ETH deployment is recorded in root
[addresses.md](../../addresses.md). Root `.env.example` stays a blank reusable
template. The private root `.env` address inventory selects the current BTC engine,
new shared vault and BTC reserve; it is an operator reference, not an automatically
loaded service configuration. Use the matching public manifest and service pins for
each market. No mainnet deployment configuration has been selected.

| Template field | Current value | Required producer |
|---|---|---|
| `RISK_BOOK_ENGINE_ADDRESS` | See root inventory | Successful engine creation receipt and runtime verification |
| `RISK_BOOK_COLLATERAL_ADDRESS` | See root inventory; test token | Token code/decimals/controller verification |
| `RISK_BOOK_VAULT_ADDRESS` | See root inventory | Vault receipt, token/governor getters and registration |
| `RISK_BOOK_RESERVE_VAULT_ADDRESS` | See root inventory | Engine getter, nested runtime and engine binding verified |
| `RISK_BOOK_RESOLUTION_AUTHORITY_ADDRESS` | See root inventory; shared ResolutionOracle | Oracle and engine authority binding verification |
| `RISK_BOOK_SMOKE_ADDRESS` | Not deployed | Would require separately authorized fixture setup |
| `RISK_BOOK_BUYER_ADDRESS` / `RISK_BOOK_SELLER_ADDRESS` | Not deployed | No actor setup performed |

### Historical controlled fixture configuration

The following describes the older controlled deployment script, not the current
factory-backed markets. The controlled deployment script
hardcodes fixture listing values; adding env names does not parameterize or approve them.
Its deployer is reused for fixture roles, its registry field is an EOA stand-in rather than
a deployed factory/registry, its data/finality hashes identify manual test inputs, and its
ten-day schedule is derived at deployment. The concrete release starts at cap 1, 1,024
participants, funding/recovery disabled and zero liquidation allowance; arbitrary env values
cannot safely enable leverage, funding, conversion or a different calibrated profile.

Still-required real inputs include approved collateral and token behavior, role addresses
and key custody, registry/factory integration, resolution authority integration, authenticated
independent index collection/source/rules identity, feed availability, actual listing times,
and any separately validated calibration/release changes. These are external facts or release
work, not blanks to fill with guessed addresses. Mainnet deployment is not authorized.

The chain-31337 `LocalBookRiskSmoke` uses local mock collateral/oracle and a fixed test-only
index key. RB-I12 now reads `engine.maxFills()` and runs at most two payout passes instead of
using its old hardcoded limit and incomplete one-pass preparation. Both local-script regression
tests pass, including nonlocal-chain rejection; the affected Monad bundle passes 99 tests in
11 suites. The standalone chain-31337 offline script also exits 0 without RPC or broadcast
(`tmp/rb-i12-local-script-green.log`); its aggregate 45,478,303 gas spans multiple virtual
transactions, not a single Monad transaction. None of these is a public-chain receipt.
Never use that local fixture's mock credentials or addresses on a public network.
