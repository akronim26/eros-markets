# Seam decisions (oracle ↔ engine)

Task O01. Plan §3.2, §3.3, §6.2, Appendix C.6; ADJ-24, ADJ-25, ADJ-29.

The oracle team decides the seam itself for the hackathon (ADJ-29): every decision below conforms to
the engine code already on `feat/oracle` (base `0e7a2af`), needs **no engine change**, and is
revisited only when a real engine and factory exist (task O42, gate OG3b). The engine side
(`contracts/**`) is not edited.

| ID | Topic | Decision | Basis |
| --- | --- | --- | --- |
| S-01 | Outcome enum | The oracle enum is `Outcome {NONE=0, YES=1, NO=2, INVALID=3}` (Appendix C.2). Voided is a state, not an outcome: it calls `settleInvalid()`. The oracle never sends `4`, so the engine's `ORACLE_VOIDED = 4` mapping is harmless and is left as is (ADJ-25). | `IResolutionIngress.sol:64-96`; `B-assumptions.md` I-5 |
| S-02 | Engine calls | YES → `settle(1)`, NO → `settle(0)`, INVALID and Voided → `settleInvalid()`. The oracle calls `halt()` first, then `settle*` only in `_final`, in the same transaction as its own Final transition; an engine revert rolls the whole transaction back. | `ResolutionIngress.sol`; `oracle_interface.md` "Finality acceptance" |
| S-03 | Clocks | `Resolution.haltedAt = HaltView.economicHaltAt` (T for a scheduled halt, the transaction time for an early halt); `voidDeadline = max(haltedAt, T) + voidSecs`. | `oracle_interface.md:78`; plan D3 |
| S-04 | Bond units | `exposureAtoms = oiHaltLots × 1000`, read from the stored halt snapshot, never live OI; `B = max(minBond, venue minimum, ceil(exposureAtoms × bondBps / 10 000))`. | `oracle_interface.md:67`; `counterpart-oracle-fixtures.json`; plan §6.5 |
| S-05 | Market id | `bytes32` everywhere. | `IMarketConfig.sol:21` |
| S-06 | Listing hash | `createMarket` requires `listingHash() == keccak256(abi.encode(listing))` and an unhalted engine right after the factory call. | `RiskContextPort.sol:80`; plan §6.3 step 8 |
| S-07 | Listing fields | The registry overwrites `marketId`, `registry`, `resolutionAuthority`, `monitor`, `scheduledT`, `listedAt`, `rulesHash`, `sourceHash = keccak256(abi.encode(specHash, keccak256(abi.encode(allowList))))` and `invalidRule = {true, 3600, 5e17, voidSecs}`; every other field comes from the listing pack unchanged. These values pass the engine's own `validateListing`. | `RiskContextPort.sol:43-53`; plan §6.3 step 8 |
| S-08 | `voidSecs` | Production 45 days (plan §14.2); testnet with the stub engine 2 h; testnet with the real engine 26 h. The engine gate only lower-bounds `voidSecs`, so no engine logic depends on 30 days; the "30 days" in engine comments and `oracle_interface.md` is left for the Risk owners to update (ADJ-24). | `RiskContextPort.sol:43-53`; plan §14.1, §14.2 |
| S-09 | Monitor flag | `requestEarlyCheck` reads `marketRiskView().monitorRestricted` and requires the caller to be `listing.monitor`. The stub engine implements the same view. | `RiskView.sol:54, 97`; `MonitorPolicy.sol:28, 35`; plan §6.10 |
| S-10 | Listing horizon | Registry globals mirror the engine: `minHorizonSecs = 86,400` and `maxListingHorizon = 2,588,400` with the real engine and on mainnet; `minHorizonSecs = 600` on testnet with the stub engine. | `LifecycleMath.sol:20`; `RiskStorage.sol:139`; plan §14.1 |
| S-11 | Factory ABI | `IMarketFactory.deployMarket(Listing, bytes engineInit) returns (address)` exactly as Appendix C.6: `onlyRegistry`, atomic deploy + initialize + register, binds `resolutionAuthority`/`registry`/`marketId`, reverts on reuse. For the hackathon the only implementation is the oracle-owned testnet `StubMarketFactory` (O19.1); `registry.setFactory` swaps in a real factory later without redeploying anything. | plan §6.2, §6.10, §12.5 |
| S-12 | Engine for the hackathon | The oracle runs end to end on its own `ResolutionEngineStub` (plan §6.10), which copies B's `ResolutionIngress` behaviour; B's real `SettlementController` is still exercised in the seam tests (O17.3). The real-engine re-run (O42, gate OG3b) is out of hackathon scope. | plan §3.4, §6.10, §13.1 |
| S-13 | Testnet bond token | A team-deployed, 6-decimal, faucet-minted test USDC (`oracle/src/testnet/TestUSDC.sol`, TESTNET ONLY, deployed by the sandbox script in O19.3). Circle testnet USDC is not used because its faucet gives too little for the treasury ledgers (1,000+ USDC). The repository's `contracts/test/mocks/A/MockUSDC.sol` is **not** deployed on a public network: its `configure` and `setCallback` have no access control, so anyone could block transfers to the treasury. It stays a test double. Mainnet: Circle USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`. | plan §12.1, §12.5; `MockUSDC.sol` |
| S-14 | Disputes Live host | `oracle/apps/disputes-live`, standalone (ADJ-13). | plan §9.5 |
| S-15 | Seam tests | The oracle's `EngineHarness` (Appendix B.6) imports B's real settlement sources and non-test mocks through the `@eros/` and `@eros-test/` remappings, never a `*.t.sol`. If those files move, the oracle CI breaks on the next run, because `oracle.yml` triggers on `contracts/src/**` and `contracts/test/mocks/**`. | plan §11.1, §12.2a |

No Appendix C type or interface changes as a result of these decisions.
