# Deployed contract addresses

Updated **2026-10-04 (Asia/Calcutta)**. Network: **Monad testnet**, chain ID **10143**.
This is the current deployment inventory; the older smoke market is separate and closed.

**Status: deployed and verified, not activated.** The six foundation transactions succeeded.
No collateral was minted, no actors/coordinator were deployed, and no trading, halt or settlement
was executed. Frontend and oracle integration are left to their integration team as requested.
These are testnet fixtures, not production collateral or a production oracle integration.

## Current addresses

| Contract / role | Verified address |
|---|---|
| **BookRiskEngine: order book and risk engine together** | [`0x58c63bfd94c13acb6f1da665406cc16cf80d1b69`](https://testnet.monadscan.com/address/0x58c63bfd94c13acb6f1da665406cc16cf80d1b69) |
| CollateralVault | [`0xa8341d0343bc71b0f28e82dba2302c528608898d`](https://testnet.monadscan.com/address/0xa8341d0343bc71b0f28e82dba2302c528608898d) |
| ReserveVault, created inside the engine constructor | [`0xb4a8ff669f119aa5cad85c767dcbb2bf55813f04`](https://testnet.monadscan.com/address/0xb4a8ff669f119aa5cad85c767dcbb2bf55813f04) |
| TestnetRiskCollateral, controller-minted, 6 decimals | [`0x99f93e9bfe3b2dd75fe27327789bd0a9236ff7b0`](https://testnet.monadscan.com/address/0x99f93e9bfe3b2dd75fe27327789bd0a9236ff7b0) |
| TestnetResolutionAuthority, controller-only fixture | [`0x096545047a7a3a2453a417e21072c8b459d40c7c`](https://testnet.monadscan.com/address/0x096545047a7a3a2453a417e21072c8b459d40c7c) |
| Deployer / fixture controller | [`0x76765dc99c2c9aed0b2c23b39960f0de0ac5da46`](https://testnet.monadscan.com/address/0x76765dc99c2c9aed0b2c23b39960f0de0ac5da46) |

There is **no separate order-book address**. Use the concrete BookRiskEngine ABI for both book
and risk calls. The controller also holds the fixture's governance, monitor, index signer,
treasury and vault-governor roles. The listing's registry address is this EOA stand-in, **not**
a deployed registry/factory. Smoke coordinator, buyer and seller addresses are **not deployed**.

## Configuration for integration

Public address inventory for a local environment file:

```dotenv
TESTNET_DEPLOYER=0x76765dc99c2c9aed0b2c23b39960f0de0ac5da46
RISK_BOOK_ENGINE_ADDRESS=0x58c63bfd94c13acb6f1da665406cc16cf80d1b69
RISK_BOOK_COLLATERAL_ADDRESS=0x99f93e9bfe3b2dd75fe27327789bd0a9236ff7b0
RISK_BOOK_VAULT_ADDRESS=0xa8341d0343bc71b0f28e82dba2302c528608898d
RISK_BOOK_RESERVE_VAULT_ADDRESS=0xb4a8ff669f119aa5cad85c767dcbb2bf55813f04
RISK_BOOK_RESOLUTION_AUTHORITY_ADDRESS=0x096545047a7a3a2453a417e21072c8b459d40c7c
FOUNDRY_PROFILE=risk
FORGE_SNAPSHOT_EMIT=false
```

Set `ETH_RPC_URL` privately in the process environment to the approved Monad testnet endpoint.
It is deliberately omitted here. Keep the wallet/keystore and password outside Git; no private
key is needed for reads. `RISK_BOOK_*_ADDRESS` names are inventory conveniences, **not** automatic
inputs to existing Solidity scripts. Frontend env naming is the frontend team's responsibility.
See [actual env consumers and CLI inputs](docs/runbooks/RISK_BOOK_ENV_AND_ADDRESSES.md).

| Identity / parameter | Deployed value |
|---|---|
| Market ID | `0x75be8f1f39e85b942a81e019e98ae380c65da9a1fc2e90b531fddbe9ad96870a` |
| Listing hash | `0x46a5cee0c75458e355018cde6e76ec94bb529c91489ed152c56ee2a4d597c95f` |
| INDEX source ID | `0xea09db42b6a3544bc07d88277ffc96a2996a24dd665572fd380822ffde0b74a1` |
| INDEX rules hash | `0x81f5651dbea04673391264d511dd19a6c7920ab5301d8d1cb79ac72dff1ac10e` |
| Listed at | `1791056376` = **2026-10-03 19:39:36 UTC** |
| Scheduled halt `T` | `1791920376` = **2026-10-13 19:39:36 UTC** / **2026-10-14 01:09:36 IST** |
| Deployment cap / funding / recovery | **1x fully backed**, funding **off**, recovery **off** |
| Participants / order size | Maximum **1,024** traders; **1..4,294,967,296** lots per order |
| Matching / batch / depth | **8** matching examinations; **8** batch actions; separate sampler cap **64** nodes; required depth **500** lots |
| Spread / bootstrap band | `50000000000000000` WAD each (**0.05**) |
| Liquidation allowance | **0** lots per block in this controlled fixture |

The complete listing, including resolution source/rules hashes and INVALID policy, is in the
[deployment evidence](artifacts/risk/monad-testnet-deployment-2026-10-04.json).
The ten-day schedule starts at deployment, **not** when the integration team activates it.

## State and handoff limits

At verification block **67,915,348**:

- Vault registration and authority-to-engine binding are correct; ReserveVault points to this engine.
- `active=false`, `halted=false`, `claimsEnabled=false`, `priceReady=false`; no accepted finality.
- Collateral `totalSupply=0`, engine `allocationQ=0`, reserve shares/holders **0**, settlement accounts **0**.
- Current book-depth sampling and risk fixes are in the deployed bytecode; no live trade or sampler
  publication is claimed for this new instance.

**Oracle constraint:** the resolution authority and listing are pinned at construction, and this
test authority's controller is immutable. This deployment cannot be repointed to the real oracle
by changing a frontend env value. Real-oracle integration needs a separately configured market
deployment with the correct authority and listing inputs. Do not give integration teams signer secrets.

The team can now connect readers/UI to these addresses. Test collateral funding, authorized
activation and fresh authenticated INDEX delivery are still needed before trading. Keep terminal
settlement testing separate from any ongoing demo; no settlement smoke was run this turn.
Production collateral, factory/registry and production release remain outside this fixture.

## Source, ABIs and verification

- Deployment source: `162ac929d1b8bbb577ecc1fdcdb07816416b0e31` on `integration/risk`.
- Last Solidity change: `dcb6b0e9023f5dab297a233303e5762df8270d09`; unchanged from accepted
  G7 candidate `c91acf75ae9770f0bf5ae2238b4018202d57acd8`. Main was not changed.
- Toolchain: Forge **1.8.3**, solc **0.8.30**, Prague, optimizer **200**.
- [Concrete engine ABI](artifacts/risk/book-risk-engine-abi.json): **294** entries;
  [vault ABI](artifacts/risk/vault-abi.json): **35** entries. Export files wrap the ABI in `abi`.
  Concrete source digest: `40e05c0e8034dcdba2a14fc19a97f2323412e69f92dc2146cac913ef8695cbb3`.
- Fresh targeted Monad tests: **45 passed / 4 suites**, zero failed/skipped; ABI check passed.
  Existing full CI **832/130** and G0-G7 results retain their original source-bound evidence;
  they were not rerun or relabeled as new live tests.
- [Six receipts, four top-level runtime comparisons and bindings](artifacts/risk/monad-testnet-deployment-2026-10-04.json).
- [Nested ReserveVault runtime/binding, inactive state and fee reconciliation](artifacts/risk/monad-testnet-foundation-state-2026-10-04.json).

All five deployed runtimes match compiler artifacts outside recorded immutable references;
relevant bindings were read back. Engine runtime is **120,402 bytes**; initcode **130,572 bytes**.
This is trusted-RPC/artifact verification, not an independent audit or explorer source verification.
Explorer source publication was not performed. Historical G7 manifests and older smoke receipts
are preserved, not overwritten with this deployment's results.

## Successful transactions

| Action | Transaction | Block | Receipt gas |
|---|---|---:|---:|
| Create test collateral | [`0x87c68c16e9ebfff9132a5d2312fc429f19ef2b7d28f22fec46c0fab95c2415a9`](https://testnet.monadscan.com/tx/0x87c68c16e9ebfff9132a5d2312fc429f19ef2b7d28f22fec46c0fab95c2415a9) | 67,914,969 | 619,075 |
| Create collateral vault | [`0xa928c8691399568aa7afe3c9ac716a17a6c74a1628f184d191b56ef514462798`](https://testnet.monadscan.com/tx/0xa928c8691399568aa7afe3c9ac716a17a6c74a1628f184d191b56ef514462798) | 67,914,987 | 1,582,100 |
| Create test authority | [`0xc64477507dae8e5de2a010a43a736cc0738cec20e6ff3024e264c0c5f478e115`](https://testnet.monadscan.com/tx/0xc64477507dae8e5de2a010a43a736cc0738cec20e6ff3024e264c0c5f478e115) | 67,915,003 | 496,886 |
| Create engine + internal reserve vault | [`0x1e00bf376b8261d07735d0692dce30e6f3805a1fd78288242ae351a06fdfbada`](https://testnet.monadscan.com/tx/0x1e00bf376b8261d07735d0692dce30e6f3805a1fd78288242ae351a06fdfbada) | 67,915,021 | 29,245,915 |
| Register engine with vault | [`0x79591f3821f95c8a081d3ba81f62d338badaeafb20582386a4bcbdf36b1e302d`](https://testnet.monadscan.com/tx/0x79591f3821f95c8a081d3ba81f62d338badaeafb20582386a4bcbdf36b1e302d) | 67,915,037 | 64,230 |
| Bind test authority | [`0x9b5d1418f07404036ab1ebfca3a38f0de0ae5ad4490ce11a7c0267073171bcc2`](https://testnet.monadscan.com/tx/0x9b5d1418f07404036ab1ebfca3a38f0de0ae5ad4490ce11a7c0267073171bcc2) | 67,915,052 | 65,160 |

Deployment cost: **3.271483332 test MON**. Controller balance after verification:
**2.504629348592266817 test MON**. Nonces **15..20** succeeded; no pending deployment transaction.

For the older **closed** market (`0x4ae742676984d2c383645e4745eaf3943b67de72`), use the
[historical ledger](docs/integration/RISK_BOOK_TRACKER.md#6-testnet-deployment-ledger).
Do not mix its actors, market ID, ABIs or receipts with this deployment.
