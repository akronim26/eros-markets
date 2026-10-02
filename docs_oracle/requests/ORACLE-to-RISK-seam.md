# Seam request: Oracle → Risk & Clearing and the factory owner

Task O01.1 (draft). Plan §3.2, §3.3, §6.2, Appendix C.6; ADJ-24, ADJ-25.

**From:** oracle team. **To:** Risk & Clearing Person A, Person B, and the shared MarketFactory
owner (CP-FACTORY). **Branch:** `feat/oracle` (engine code as of base `0e7a2af`).

The oracle calls only the engine surface that is already built and tested: `IResolutionEngine`
(`contracts/src/interfaces/IResolutionIngress.sol`), `IMarketConfig`
(`contracts/src/interfaces/IMarketConfig.sol`) and `RiskView.marketRiskView()`. We ask for **no
engine change**. We ask you to confirm each row below, or to correct it before gate OG0 freezes the
oracle's types and interfaces (plan Appendix C). After OG0, a change on either side means a new
interface version agreed by both teams.

Please answer per row: `agreed`, `changed: …` or `open: owner, date`.

Status words: `published` = the Risk side already states this in writing in the repository (source in
the Answers table), but nobody has acknowledged this request yet; `agreed` = acknowledged in
writing by the person named; `changed` = agreed with a correction; `open` = waiting on the owner
named in the Answers table.

## Items

| ID | Topic | Engine today | Oracle proposal / ask | Asked of | Status |
| --- | --- | --- | --- | --- | --- |
| S-01 | Oracle outcome enum (I-5) | `OracleOutcomeMap` assumes `{NONE=0, YES=1, NO=2, INVALID=3, VOIDED=4}`; YES → `settle(1)`, NO → `settle(0)`, INVALID/VOIDED → `settleInvalid()` (`IResolutionIngress.sol:64-96`, `B-assumptions.md` I-5) | The oracle enum is `Outcome {NONE, YES, NO, INVALID}` (values 0–3, Appendix C.2). **Voided is a state, not an outcome**: it calls `settleInvalid()`. The oracle never sends 4. B's map works unchanged; please confirm and, if you wish, mark `ORACLE_VOIDED` as unused (ADJ-25). | Person B | published |
| S-02 | Engine calls and their semantics | `halt()`, `settle(uint8)`, `settleInvalid()` only from `_listing.resolutionAuthority`; `materializeScheduledHalt()` permissionless at ≥ T; same outcome → `false`; conflicting outcome reverts `ConflictingFinalOutcome`; Y ∉ {0,1} reverts `BadOutcome`; `settle*` halts first if needed (`ResolutionIngress.sol`) | The oracle calls `halt()` explicitly before any `settle*`, calls `settle*` only in its `_final` step **in the same transaction** as its own Final transition, and lets an engine revert roll the whole transaction back (plan §5.4). | Person B | published |
| S-03 | Clocks | `economicHaltAt = T` for a scheduled halt, the transaction time for an early halt; `haltRecordedAt` is telemetry (`oracle_interface.md:69-80`) | `Resolution.haltedAt` copies `HaltView.economicHaltAt`, never the late keeper time; `voidDeadline = max(haltedAt, T) + voidSecs` (plan D3). | Person B | published |
| S-04 | Halt OI and bond units | `oiHaltLots` is one-sided, includes the reserve; adapter converts `exposureAtoms = oiHaltLots × 1000` (`oracle_interface.md:67`, `counterpart-oracle-fixtures.json`) | Bond `B = max(minBond, venue minimum, ceil(oiHaltLots × 1000 × bondBps / 10 000))` from the **stored** halt snapshot (plan §6.5); never live OI. | Person B | published |
| S-05 | Market id type | `Listing.marketId` is `bytes32` (`IMarketConfig.sol:21`) | The oracle uses `bytes32` everywhere (the Oracle spec's `uint256` is dropped). | Person B, factory | published |
| S-06 | Listing hash | `_listingHash = keccak256(abi.encode(l))` at initialization (`RiskContextPort.sol:80`) | `MarketRegistry.createMarket` requires `IMarketConfig(engine).listingHash() == keccak256(abi.encode(listing))` and `!getHaltSnapshot().halted` right after the factory call (plan §6.3 step 8). Please keep this exact encoding. | Person B, factory | published |
| S-07 | Listing fields the registry sets (I-6) | `Listing` adds `monitor`, `governance`, index fields, `bootstrapBandWad`, `maxLiqLotsPerBlock`, `fundingEnabled` (`B-assumptions.md` I-6) | The registry **overwrites** `marketId`, `registry` (= MarketRegistry), `resolutionAuthority` (= ResolutionOracle), `monitor`, `scheduledT` (= tau), `listedAt` (= now), `rulesHash` (= keccak of the rules text), `sourceHash = keccak256(abi.encode(specHash, keccak256(abi.encode(allowList))))` and `invalidRule = {fallbackListed: true, captureGraceSecs: 3600, fallbackPriceWad: 5e17, voidSecs}`. Every other field (token, governance, template, caps, index source, depth, order bounds, pacing, funding flag) is passed through from the listing pack unchanged. Please confirm none of the overwritten fields needs a different value. | Person B, factory | open |
| S-08 | `voidSecs` (DEP-3) | Comments and docs assume 30 days (`IMarketConfig.sol:17`; `oracle_interface.md:78, 112`); the gate is only `T + captureGraceSecs ≤ listedAt + voidSecs` (`RiskContextPort.sol:43-53`) | Production `voidSecs = 45 days` (plan §14.2: three assertions, DVM rolls). The gate only lower-bounds `voidSecs`, so 45 days lists fine, and A's `RiskStorage` still caps `T ≤ deploy + 2,588,400 s` (`RiskStorage.sol:139`). Asks: (a) confirm no engine logic assumes 30 days; (b) update the "advertised 30-day deadline" wording in `oracle_interface.md` at your convenience (ADJ-24). | Person A, Person B | open |
| S-09 | Monitor flag (DEP-4) | `RiskView.marketRiskView().monitorRestricted` (`RiskView.sol:54, 97`); `requestReduceOnly` / `clearReduceOnly` by `listing.monitor` (`MonitorPolicy.sol:28, 35`) | `ResolutionOracle.requestEarlyCheck` requires `marketRiskView().monitorRestricted == true` and `msg.sender == listing.monitor` (same key on both contracts). Please keep `marketRiskView()` and this field on the production engine. | Person B | published |
| S-10 | Listing horizon | `T ≥ listedAt + 1 day` (`LifecycleMath.sol:20`); `T ≤ deploy + 2,588,400 s` (`RiskStorage.sol:139`) | The registry enforces both bounds itself (globals `minHorizonSecs = 86,400`, `maxListingHorizon = 2,588,400` on mainnet) so the listing fails early with a readable error. Confirm these are the final values. | Person A, Person B | open |
| S-11 | `IMarketFactory` ABI (DEP-2) | No factory exists | `deployMarket(IMarketConfig.Listing calldata listing, bytes calldata engineInit) returns (address engine)` (Appendix C.6). `onlyRegistry`; deploys, initializes and registers one market atomically; binds `resolutionAuthority`, `registry` and `marketId` immutably; reverts on a reused `marketId`. `engineInit` carries the engine's own init data (for example the `RiskParams` profile) and is opaque to the oracle. | Factory owner | open |
| S-12 | Concrete engine (DEP-1) | Only abstract modules composed in tests; G0–G7 not recorded | A deployable `MarketEngine` implementing `IResolutionEngine`, `IMarketConfig` and `RiskView`. Please give an owner and an expected date. Until then the oracle runs on its own testnet stub engine (plan §6.10). | Person A, Person B | open |
| S-13 | Bond token on testnet | `Listing.token` is the engine's collateral; the repo's `MockUSDC` is a test mock with a public `mint` | One USDC everywhere: the oracle bonds in the engine's collateral token. Testnet options: Circle testnet USDC `0x534b2f3A21130d7a60830c2Df862319e593943A3` (faucet amounts are small) or a team-deployed MockUSDC with a faucet. Mainnet: Circle USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`. Which will the engine use on testnet? | Person A, Person B | open |
| S-14 | Disputes Live host (DEP-5) | Not in the repository | Which indexer / frontend will host the Disputes Live page, and when? Until then it lives in `oracle/apps/disputes-live`. | App team | open |
| S-15 | Seam tests | B's `OracleCompatibility.t.sol` and `docs/counterpart-oracle-fixtures.json` mark the live CP-ORACLE join `BLOCKED_BY_COUNTERPART` | The oracle will run B's real `SettlementController` through an oracle-owned `EngineHarness` (plan §11.1, Appendix B.6), importing only non-test sources and mocks via `@eros/` and `@eros-test/` remappings, never a `*.t.sol`. Please avoid moving or renaming `MockBookAdapter`, `MockAccountingPort` and `MockUSDC` without telling us. | Person A, Person B | published |

## Answers

Task O01.2. Recorded 2026-10-02. **No acknowledgement of this request has been received yet** from
Person A (commits as `YASH-ai-bit`), Person B (commits as `0xr10t`) or a factory owner (none named
in the repository). The `published` answers below are what Person B already wrote in the repository
on 2026-10-01; they still need Person B's acknowledgement to become `agreed`.

| ID | Answer so far | Source | Who | Date | Still needed |
| --- | --- | --- | --- | --- | --- |
| S-01 | B's map sends YES → `settle(1)`, NO → `settle(0)`, INVALID → `settleInvalid()`, exactly what the oracle needs; `VOIDED = 4` is B's guess and is never sent. B's I-5 asks CP-ORACLE to confirm: the oracle confirms here. | `IResolutionIngress.sol:64-96`; `B-assumptions.md` I-5 | Person B (published), oracle (confirms) | 2026-10-01 (B, `ffd18ab`) | Person B acknowledgement |
| S-02 | As proposed: oracle-only `halt`/`settle`/`settleInvalid`, permissionless scheduled halt, same outcome → `false`, conflict reverts, delivery in the same transaction as oracle Final. | `oracle_interface.md` "Finality acceptance"; `ResolutionIngress.sol` (B034, `fb3827d`) | Person B (published) | 2026-10-01 | Person B acknowledgement |
| S-03 | As proposed: `Resolution.haltedAt` copies `economicHaltAt`. | `oracle_interface.md:78` (selected integration rule) | Person B (published) | 2026-10-01 | Person B acknowledgement |
| S-04 | As proposed: `exposureAtoms = oiHaltLots × 1000`, from the stored snapshot. | `oracle_interface.md:67, 78`; `counterpart-oracle-fixtures.json` (B037, `c16179e`) | Person B (published) | 2026-10-01 | Person B acknowledgement |
| S-05 | As proposed: `marketId` is `bytes32`. | `IMarketConfig.sol:21` | Person B (published) | 2026-10-01 | Person B acknowledgement |
| S-06 | As proposed: `listingHash = keccak256(abi.encode(listing))`. | `RiskContextPort.sol:80` | Person B (published) | 2026-10-01 | Person B acknowledgement |
| S-07 | No answer. The overwritten values match what `validateListing` accepts (fallback 0.5, grace 3,600 s), but B's I-6 says CP-FACTORY must confirm the field list. | `B-assumptions.md` I-6; `RiskContextPort.sol:43-53` | — | — | Person B and the factory owner |
| S-08 | No answer. | `IMarketConfig.sol:17`; `oracle_interface.md:78, 112` say 30 days | — | — | Person A and Person B |
| S-09 | As proposed: `marketRiskView().monitorRestricted` exists and reflects `requestReduceOnly` / `clearReduceOnly`. Keeping it on the production engine is not yet promised. | `RiskView.sol:54, 97`; `MonitorPolicy.sol:28, 35` | Person B (published) | 2026-10-01 | Person B acknowledgement, including the production engine |
| S-10 | No answer. | `LifecycleMath.sol:20`; `RiskStorage.sol:139` | — | — | Person A and Person B |
| S-11 | No answer; no factory owner is named in the repository. | — | — | — | name the factory owner, then their answer |
| S-12 | No answer; G0–G7 are `not_started` in `docs/spec/gate_status.json`. | `docs/spec/gate_status.json` | — | — | Person A and Person B: owner and date |
| S-13 | No answer. Bond-token decision pending; it feeds X03, X04 and `params.monad-testnet.json`. | — | — | — | Person A and Person B, with the oracle team |
| S-14 | No answer. | — | — | — | the app team |
| S-15 | As proposed: B published the fixture and the compatibility suite for the oracle team to run. | `counterpart-oracle-fixtures.json`, `OracleCompatibility.t.sol` (B037, `c16179e`) | Person B (published) | 2026-10-01 | Person A and Person B acknowledgement |

No Appendix C type changes are needed by any answer recorded so far.
