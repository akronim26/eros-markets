# Market factory: what remains before a real-engine market

## 2026-10-05 implementation update (supersedes the design assumptions below)

`contracts/src/factory/MarketFactory.sol` and `EngineCodeStore.sol` implement a small,
registry-only factory using a pinned, STOP-prefixed creation-code store. Every engine
runs its normal constructors and gets its own reserve. The factory owns a dedicated
collateral vault and can register only the engines it creates. No clones, proxy
initializers, registry redesign or arbitrary predeployed-engine binding are needed.

The factory artifact is `oracle/src/integration/RegistryBookRiskEngine.sol`, derived
from the real `BookRiskEngine`. It enforces the registry's immutable `oiCapLots` on
fills; otherwise the listing bond commitment and actual halted exposure could diverge.
Its sampler conservatively requires remaining OI capacity for a full depth sample.

The old gas arithmetic below is not a proof of impossibility: deployment receipts
bill the selected limit, and factory listings load engine bytecode from chain rather
than resending it as transaction calldata. New local MonadTen full-path tests prove
representative small and 8 KiB claim listings fit; a 16 KiB claim can exhaust the budget
and are tested to roll back completely. Exact current measurements, source identities,
code-store headroom, tests and the operator checklist are recorded in
`../docs/integration/REAL_FACTORY_INTEGRATION.md`. A fresh complete estimate is required
for each actual pack; the representative test is not a universal listing-size proof.

Keeper runtime identity is now per-market and fail-closed. Actual engine gas needs
runtime/chain-bound provenance; old seam-harness measurements no longer authorize real
engine jobs. Local batch measurements do not calibrate the deployed UMA venue.

The user confirms there is no local account controlling the existing oracle testnet
deployment, and the independent publisher is unfinished. No factory switch, new public
deployment, live O42 completion or new OG3b acceptance is recorded. Scheduled scenarios
need T at least 24 hours away, but early valid YES/NO finality can finish before T.
INVALID uses a complete historical INDEX window when available, or the disclosed
fallback only after T plus the missing-data grace; it is not unconditionally 0.5.

## Original design handoff (retained for historical context)

Status on 5 Oct 2026. The oracle runs end to end on Monad testnet with the oracle team's `ResolutionEngineStub`
(through `StubMarketFactory`). Listing a market on the risk team's `BookRiskEngine` needs a real market factory
(dependency DEP-2, risk plan SP-03, oracle task O42). This page lists what is already compatible, what blocks the
factory, and what the oracle team still has to do.

## Already compatible (checked in code)

- **Oracle → engine calls.** `halt`, `settle`, `settleInvalid`, `getHaltSnapshot`, `getSettlementStatus`,
  `listingHash` and `marketRiskView` exist on `BookRiskEngine` with the signatures the oracle uses
  (`artifacts/risk/book-risk-engine-abi.json`).
- **Keeper's post-Final settlement jobs.** `captureInvalidPrice()`, `prepareSnapshotChunk(uint256)`,
  `preparePayoutChunk(uint256)` and `finishPreparation()` match `BookRiskEngine` selector for selector
  (`oracle/services/keeper/src/engineAbi.ts`).
- **Order book halt.** A market counts as halted from T, or from the early halt time the oracle's `halt()` sets
  (`LifecycleMath.deriveStage`); order admission then rejects every order with `HALTED`
  (`contracts/src/risk/OrderAdmission.sol`). The scheduled and early halts need no extra wiring.
- **Listing format and halt/settle semantics.** Unchanged since the oracle's seam decisions; the oracle's seam
  tests pass against the risk team's real `SettlementController`.

## Blockers (factory design: shared CP-FACTORY work, engine and vault owned by the risk team)

### 1. A real market cannot be listed in one transaction

`MarketRegistry.createMarket` deploys the engine through the factory and checks it (listing hash, not halted) in
the same transaction. Deploying `BookRiskEngine` alone used **29,245,915 gas** (the risk team's deploy receipt,
`addresses.md`); Monad's per-transaction limit is **30,000,000**, and the registry's own work (checks and SSTORE2
writes) adds roughly 3 to 4 M (about 3.7 M measured for a whole testnet listing with the stub engine). The current
atomic flow therefore does not fit.

| Option | Who changes what | Oracle work |
| --- | --- | --- |
| **Factory clones a pre-deployed engine template** (minimal proxy) | Risk side: `BookRiskEngine` moves from constructor setup to an `initialize(listing, engineInit)` function, since clones cannot run constructors | **None.** This is the oracle's existing `IMarketFactory.deployMarket(listing, engineInit)` contract (deploy, then initialize); a clone costs a few hundred thousand gas |
| **Shrink the engine** | Risk side only | **None**, as long as deploy + registry work fits under 30 M |
| **Two-step deploy** (deploy the engine first, bind and check it later) | Shared | **Real oracle changes:** `MarketRegistry.createMarket` accepts a pre-deployed engine and checks it came from the trusted factory; the factory interface agreed at gate OG0 changes; a new registry deployment, because the registry's links are constructor immutables |

From the oracle's side, the clone approach is the cleanest: the oracle contracts stay as they are.

### 2. Vault registration

An engine only works once its `CollateralVault` registers it, and `CollateralVault.registerEngine` is restricted to
the vault's `governor`. A factory cannot register engines unless it is the vault's governor, the vault trusts the
factory, or registration becomes a separate governance step. This is risk-side and factory-side only: the oracle
never calls the vault, and an unregistered engine affects trading, not resolution.

## Oracle-side tasks, needed whichever option is chosen

1. **Keeper gas on the real engine.** Measure `haltScheduled`, `finalizeMarket` and the four settlement jobs on
   `BookRiskEngine` and add their limits to `oracle/deployments/gas.json`. Today the settlement jobs have no limit,
   so the keeper refuses them, and the real-engine halt and finalize figures were measured on a smaller test
   harness, not `BookRiskEngine`.
2. **Per-market engine detection in the keeper.** The keeper decides "real engine" for the whole deployment from
   whether `StubMarketFactory` is in the deployment record (`oracle/services/keeper/src/main.ts`), so stub and real
   markets cannot run side by side. It needs a per-market, validated engine identity (risk plan SP-03 item 6).
3. **Collateral token in listing packs.** The registry passes the pack's token to the engine unchanged, and
   `BookRiskEngine` requires it to equal the vault's token. The packs use TestUSDC (the oracle's bond token); they
   must use the collateral the risk side chooses.
4. **Switch the registry to the real factory.** A Timelock operation (`setFactory`) with the existing governance
   scripts, then task O42.1: list one market through the real factory and check its `listing()` against the pack.

## Notes for real-engine testing

- `BookRiskEngine` requires T at least 24 hours after listing (`LifecycleMath.MIN_LISTING_HORIZON`); the oracle's
  testnet scenarios use 10 minutes, so each real-engine scenario takes over a day. The engine enforces this itself;
  no oracle globals change is needed.
- The engine prices INVALID from its INDEX feed over the 24 hours before T. Without the risk team's INDEX publisher
  (SP-04), every INVALID market settles at the listed 0.5 fallback.
- The early-check path (scenario E6) needs a monitor service that calls the engine's `requestReduceOnly`, then the
  oracle's `requestEarlyCheck`; none exists yet (the testnet run played the monitor by hand).
