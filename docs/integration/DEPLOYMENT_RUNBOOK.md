# Integrated deployment preparation

Current deployed contracts are listed in [addresses.md](../../addresses.md).
For the October 9 replacement BTC/ETH profile and current operator paths, use
[FAST_TESTNET_PRICING.md](FAST_TESTNET_PRICING.md) and
[TESTNET_OPERATIONS.md](TESTNET_OPERATIONS.md). The dated October 6 rehearsal
addresses, code hashes and unsigned bundles below remain historical evidence.

The deployable composition is `MarketRegistry → MarketFactory → RegistryBookRiskEngine + CollateralVault`, with the existing `ResolutionOracle`, `BondTreasury`, and Timelock. The factory reconstructs the current engine creation code from two immutable code stores. A direct `BookRiskEngine` deployment or an oracle stub factory does not verify this composition.

The commands below prepare unsigned transactions and optionally execute them on a disposable local Anvil. They never load a private key or send a public transaction. Frontend integration consumes the final deployment manifest and owner-correct SDK after this deployment path and the local lifecycle have passed.

## Build and inspect

Use the repository-pinned Foundry 1.8.3, Solidity 0.8.30, optimizer 200 and Prague compiler target. Compile the integration artifacts from `oracle/` with its integration profile. Existing local-stack preparation also builds these artifacts. Do not compile concurrently with another Forge build against the same output directory.

```powershell
$env:FOUNDRY_PROFILE = 'integration'
Push-Location oracle
forge build
Pop-Location
Remove-Item Env:FOUNDRY_PROFILE

python scripts/integration/preflight-integrated.py --output tmp/integrated-monad-preflight.json
```

The default command uses the public Monad testnet RPC with a read-method allowlist. `--rpc` or `--rpc-env NAME` selects another endpoint. Chain ID must be 10143 or 31337 and match the deployment manifest; mainnet is refused. Endpoint credentials and private dotenv files are not loaded.

The report pins its inspection block and manifest hash. It checks deployed code hashes, reciprocal registry/oracle/treasury/token/governance bindings, active trust-set configuration, collateral code, and existing assertion commitments. Artifact metadata must match current source contents and the pinned compiler settings. `existing-stack-verified-inputs-required` means the existing contracts were inspected, not that the integrated engine is deployed or its listing is approved. `passed` remains false until an explicit local sequential rehearsal passes.

## Prepare the exact unsigned bundle

Put a reviewed input JSON under `tmp/` and reference a complete current `MarketInput`/`engineListing` pack. Use decimal strings for large integers; unsafe JSON numbers are rejected. The historical example pack's short horizon and encoded stub `engineInit` are unsuitable for the real engine. The current pack must use `engineInit: "0x"`.

Required input fields:

| Field | Meaning |
| --- | --- |
| `schema` | `eros-integrated-deployment-input/1` |
| `listingPack` | Pack path relative to this input file |
| `deployer` | Sender for the two stores, factory and optional rollover helper |
| `proposer`, `executor` | Timelock operators; default to manifest teamSafe and deployer respectively |
| `reserveTreasury` | Factory's protocol/reserve beneficiary |
| `reserveFunder` | Owner of the actual collateral to deposit |
| `reserveAtoms` | Seed in 6-decimal collateral atoms, as a decimal string |
| `expectedCreationCodeHash` | Current engine creation hash shown by the inspection report |
| `riskParams` | Complete `MarginMath.RiskParams` tuple; required above 1x |
| `calibrationEvidence` | Above 1x: `{ "kind": "empirical" or "fixture", "hash": "0x…32 bytes…" }`; identifies evidence without claiming a fixture is empirical calibration |
| `globals` | Optional complete registry Globals tuple, only when an explicit governed change is needed |
| `rolloverHelper` | Optional `{ "expectedCreationCodeHash": "0x…" }`; explicitly reviews the current permissionless `RolloverBatcher` deployment |

The input must name wallets with the required onchain roles and enough collateral. No collateral is minted by preparation or rehearsal. A nonzero seed and explicit profile are mandatory above 1x. The registry's configured providers, bond rules, time bounds and available assertion funding must also admit the listing; sequential rehearsal verifies those contract guards. New markets using a 29-day schedule require sufficient `maxVoidSecs`; existing public testnet globals may require an explicit governed update. The tool does not silently relax these constraints.

Check the treasury again for every additional listing: `ASSERTION` must cover
`totalCommitted + bondAtCap`. The lifetime `maxPerMarket` allowance must cover
the intended assertion attempts; returned bonds do not reset `fundedTotal`.
Three full-cap attempts require three times the largest applicable bond, and
covering repeated losses across markets requires additional assertion funding.
`WATCHDOG_FLOAT` is a separate ledger and needs its own dispute funding.
Funding transactions consume sender nonces; retain any unexecuted plan and
prepare a fresh deployment plan afterward.

After each confirmed public contract deployment, update the root
[`addresses.md`](../../addresses.md) with its chain, address, transaction and
deployment block. Record factory-created engines and vaults after verifying
their bindings and runtime code. This file lists only the current V1 deployment;
remove superseded addresses when switching deployments. Historical evidence stays
in deployment artifacts. Never enter fork-only predicted addresses as deployed contracts.

```powershell
python scripts/integration/preflight-integrated.py --config tmp/integrated-input.json --output tmp/integrated-unsigned.json
```

The bundle contains, in order: store deployments, factory deployment (which creates the shared vault), Timelock proposal/execution authorizing that factory and any explicit globals update, registry listing, funder approval/deposit/reserve allocation, then governed risk staging and activation. When the registry lister is the Timelock, listing is itself proposed and executed. Predictions depend on the pinned deployer nonce; a pending deployer transaction or changed nonce requires rebuilding the bundle.

When `rolloverHelper` is supplied, its deployment follows the factory, adding one transaction. It leaves the factory's vault/engine CREATE addresses unchanged. The bundle records the predicted helper address and runtime hash; rehearsal verifies that runtime. Omission preserves the existing bundle exactly. The helper has no owner, funds or economic permissions; it composes the engine's existing bounded rollover calls and preserves their checks.

## Rehearse locally

Use a **separate disposable Anvil instance**, optionally forked from a pinned public or local block. Do not point rehearsal at a local stack whose actors are running: the final snapshot restore would undo concurrent work. Use the same Monad network/hardfork settings as local-stack and an explicit loopback URL. The RPC's reported client must identify Anvil. Public URLs, proxies, signing methods and raw-transaction broadcasts are rejected.

```powershell
python scripts/integration/preflight-integrated.py --rehearse-local --rpc http://127.0.0.1:18580 --deployments tmp/local-run/contracts.json --config tmp/integrated-input.json --output tmp/integrated-rehearsal.json
```

The helper impersonates the configured local role owners, tops up **native gas balances only**, measures and executes every transaction below the 30M gas limit, waits for Timelock delays, checks canonical receipts, verifies resulting registry/engine/vault/seed bindings, and restores the initial snapshot. Local receipt hashes remain historical rehearsal evidence after that restore. The report distinguishes local broadcasts from zero public transactions, records measured gas, and reports whether restoration succeeded. Its `passed: true` means the local deployment rehearsal passed; `readyForPublicActivation` remains false because wallet custody, continuous source publication and operator enrollment are separate requirements.

For a public-state fork, route Anvil's upstream through the included read-only proxy. In a separate local terminal, set `INTEGRATED_PREFLIGHT_RPC` to the public RPC and run `bun --no-env-file oracle/e2e/src/fork-rpc.ts 18582 tmp/fork-rpc-audit.json`. Start the disposable Anvil with `--fork-url http://127.0.0.1:18582 --fork-block-number <pinned block> --network monad --hardfork monad:MonadTen --chain-id 10143`, using a separate listening port. The proxy allowlist admits only reads and records method counts; signing and state-changing RPC methods never reach its upstream. Preflight verifies the fork's source block/hash, deployer nonce and reserve token balance against its read-only source. Use a clean fork at the specified block, without prior local transactions.

The original 2026-10-06 diagnostic rehearsal forked actual Monad testnet block **68483161** and passed all 11 deployment/configuration/funding/activation transactions locally, including the existing 300-second Timelock delays. The largest listing transaction used **27,265,742 gas**, below 30M. The proposed 100-USDC seed from the team wallet was correctly rejected because its balance was zero. A separate, explicitly diagnostic run used 50 TestUSDC from keeper 1's recorded 62.16 TestUSDC balance; token funding was not fabricated. Native gas was topped up locally, and roles were impersonated. The state snapshot was restored, no public transactions were sent, and the separately prepared unsigned bundle still requires reviewed market/source/calibration inputs and a chosen funded reserve wallet. This verifies deployment against the existing public contracts on a local fork; it does not prove public signer custody or a persistent deployed market.

The original fork report is `tmp/integrated-monad-fork-rehearsal-final-20261006.json`, with read-only upstream method counts in `tmp/integrated-monad-fork-final-rpc-audit.json`. The prior reciprocal-check unsent bundle is embedded in `tmp/integrated-monad-unsigned-reciprocal-final-20261006.json`: its read-only inspection passed all **15 checks** at Monad block **68501121**, hash `0xbdeb20af40a54ae68d82356c729478d02da99612846e5abaa018dda06ed5eab8`, including all five reciprocal binding reads. These reports include the settlement deficit-reporting fix and pin engine creation hash `0x9169fa825e51d55e608d113aa3733b59f2ca562cb578e6a2875c50a3983d8b2a`. The fork remains pinned to its separate source block 68483161, hash `0x3c3908f727a8e174604faa82eae16de81f1ae9f9cee87d066e5ebc30b47bb14e`; the newer inspection did not rerun or publish its transactions. Final formatting left engine and factory creation bytecode unchanged, as recorded in `tmp/integration-oracle-format-runtime-equivalence-20261006.json`. Local fork and proxy processes were stopped after verification.

## Activation and frontend handoff acceptance

The subsequent helper-inclusive rehearsal passed **12 local transactions** at actual Monad block **68522967**, hash `0x0243963bed0e4f48a35c6fba2097a51615acf212b66a58ebf06eb563d961853b`. Its report is `tmp/integrated-monad-helper-20261006.rehearsal.json`; the newest unsigned bundle is `tmp/integrated-monad-helper-20261006.unsigned.json`. All 15 read-only checks passed. Helper deployment used 624,879 gas, its runtime hash matched, and the largest listing transaction remained 27,265,742 gas. This separate rehearsal used the same explicit fixture calibration, actual collateral balance, local role/native-gas assumptions, and snapshot restoration; its 12 canonical local receipts do not replace or relabel the original 11-receipt evidence. Its read-only proxy audit and process execution record use the same prefix; both owned processes were stopped, with zero public transactions.

- Re-run the deterministic full lifecycle and external-source local path using the main local-stack runner. Confirm leveraged fills, rollback/no-op safety, oracle finality, bounded settlement preparation, owner claims and vault custody. Retain the successful contract liquidation scenarios alongside the runtime operator checks.
- Enroll the new engine address, runtime hash, listing hash and deployment block in publisher, keeper, monitor and market-ops manifests. Measure gas for the actual selectors; stub gas evidence is unsuitable. Direct `rollover` uses the measured `beginRollover`, `rollPage`, and `finishRollover` keys and fixed 32-entry pages. With an enrolled `rolloverHelper` address/runtime hash, the operator estimates bounded batches against a pinned block and requires a 20% gas margin plus 10,000 gas within 30M. Validity of the opening price windows remains an independent requirement; successful accounting completion can correctly retain BOOTSTRAP 1x when observations are stale.
- Confirm signed INDEX publication and complete executable PERP/BASIS history. Staging a risk profile and activating a market do not alone create usable leverage.
- Preserve a manifest and evidence report for the exact build, chain, contract addresses, seed, profile and roles. Connect the frontend SDK to that manifest and read API; use owner wallets for order/vault transactions.
- Public deployment requires the actual signer custody, reviewed empirical calibration/market specification, funded role wallets and reserves, continuous operators, and a verified production oracle forwarding configuration. A local fixture or unsigned bundle does not establish these external facts.

Liquidation evidence has two scopes. The factory integration suite successfully liquidates an under-margined positive-equity account through the real book, enforces same-block pacing, resumes in the next block, and credits keeper fees. It also checks that missing liquidity or a stale mark cannot confiscate a position. Its NO-resolution test pays the winner the full 1,000 collateral tokens while the reserve absorbs a 480-token deficit, without recovery or reduced payouts. These are executed contract scenarios with controlled market inputs. The local service run's healthy-account liquidator performs bounded scans and sends no transaction; that verifies safe operator behavior, not a mined liquidation of an unhealthy live account. Successful reserve loss and owner payouts in the deployed deterministic closure require that run's separate receipt audit.

The historical 2026-10-06 read-only inspection of the then-current Monad manifest found the registry still using `StubMarketFactory`, active simulation trust set 1, and an adequately funded existing assertion ledger. It did not deploy the integrated engine, verify production CRE delivery, or authorize public activation. Inspect again before preparing an actual deployment because state and nonces change.
