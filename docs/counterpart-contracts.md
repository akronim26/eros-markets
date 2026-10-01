# Counterpart contracts (Risk & Clearing, Person B view)

Task B001. Spec v1.1, economic baseline v1.0. This file lists every boundary between the
Risk & Clearing layer and the teams that are not part of it. It is a B-side proposal. It becomes
frozen only when G0 is recorded with a merge SHA in `docs/spec/gate_status.json`.

The rule for every boundary: Risk & Clearing builds the interface and a deterministic mock. It
never builds the counterpart's internals (no CLOB, no Kuru/CRE fetching, no AI panel, committee
or UMA logic). A pass against a mock is reported as `BLOCKED_BY_COUNTERPART` for the live join,
never as a live pass.

## Units at every boundary

| Quantity | Unit | Source |
|---|---|---|
| Order size, position | lots (1 lot = 0.001 claim); orders `uint64`, positions `int128`, abs position at most 2^40 | spec §2.1, §7.2 |
| Price | tick `uint16` 1..999 = tick/1000 USDC per claim; `pWad = tick * 1e15` | spec §2.1 |
| Cash | Q = one USDC atom × 1e18; external transfers are whole atoms | DEC-01 |
| One lot's YES payoff | exactly 1,000 atoms = `1000*Q` | spec §8.2 |
| Probability, mark, index | `wad` in [0, 1e18]; live risk needs an interior price | spec §2.1 |
| Time | `uint64` Unix seconds UTC | spec §2.1 |
| Halt OI | unsigned lots, one-sided, includes the reserve | spec §8.2 |
| Oracle bond exposure | adapter converts `oiHaltLots * 1000` atoms; the engine never computes bonds | spec §8.2 |

## CP-BOOK — order book team

**Risk side (B):** `contracts/src/interfaces/IBookRiskHooks.sol` (B019) and the book adapter
(B024). Test double `contracts/test/mocks/B/MockBookAdapter.sol` (B020).

Contract: the spec §7.5 hook set, all internal calls in one per-market engine, no external call,
token transfer or callback inside the matching loop:

- `_riskBeginAction() -> RiskSnapshot`
- `_riskTouchAccount(trader, snap)`
- `_riskPrepareTaker(req, snap, mode) -> (TakerPermit, RejectCode)`
- `_riskTryMatchedFill(snap, permit, makerView, proposedLots) -> StepResult`
  (`FILLED`, `PRUNE_MAKER`, `STOP_TAKER`)
- `_riskAdmitRest(...)`, `_riskConvertPermitToRest(...)` -> `(EpochTag, reduceVersion, feeCapQ)`
- `_riskOnUnrest(snap, owner, admittedAt, side, tick, removedLots, releasedFeeCapQ)` (tick is required)
- `_riskCancelAll(trader) -> EpochTag`
- `_riskFinishTaker(snap, permit)`

The book must expose a lossless `OrderView`: owner, slot/generation, side, tick, remaining lots,
expiry block, full `uint64` market and account epochs, reduce-only version and remaining fee cap.
`maxFills` means maximum examined makers (stale, expired, self and failed makers all count).
Expiry is inclusive: executable while `block.number <= expiryBlock`; 0 means no expiry.

### Differences found in the book already on this branch (`contracts/src/Book.sol`)

The book team's current code uses a different hook set. Recorded here; not changed by B.

| Spec §7 requirement | Current `Book.sol` | Effect |
|---|---|---|
| `_riskOnUnrest` receives `tick`; removing lots removes exactly `lots*tick*Q` | `_onUnrest(market, trader, size, flags)` has no tick | Risk cannot maintain `Vb/Va` from this call alone. Spec §7.5 says a size-only callback cannot maintain them. |
| Filled lots are unreserved by Risk inside the fill; book must not call unrest again | `_step` calls `_onUnrest` for filled size after `_makerFill` | Adapter must treat filled-size unrest as a no-op, or double release happens. |
| Full `uint64` market/account epoch sidecar per order | No epochs, no sidecar | Stage and cancel-all invalidation cannot be enforced by the book. |
| Order size `uint64` lots, reject > configured max before cast | `uint96 size`, unit not stated as lots | Unit must be pinned to lots. `Ctx.cost` is documented as "units of 0.001 USDC" (size × tick), which matches 1 unit = 1 claim, not 1 lot. Needs confirmation. |
| Expiry block per order | none | Expiry cases (spec §7.6) not supported. |
| Reduce-only `reduceVersion` | flag only | Long→flat→short→long revival case cannot be caught by the book. |
| `StepResult` with `PRUNE_MAKER` / `STOP_TAKER` | `_makerFill` returns filled size, 0 = cancel maker | No way to stop the taker while keeping a valid maker. |
| `_riskFinishTaker(snap, permit)` | `_takerDone(ctx)` | Equivalent role; permit is not carried. |
| `RiskSnapshot` fields per spec §7.2 | `contracts/src/RiskSnapshot.sol` holds index/slowIndex/mark/stage/tier | Field set differs (slowIndex, tier are not in this spec). |

Selected handling (spec §14, "report the exact incompatible field and provide a versioned
adapter"): B builds against the spec hook set and its own mock book. Live CP-BOOK join is
`BLOCKED_BY_COUNTERPART` until the book exposes tick on unrest, epochs, expiry, reduce version and
the three-way step status, or an agreed versioned adapter is written.

## CP-PRICE — price collector team

**Risk side (B):** `contracts/src/interfaces/IPriceSource.sol`, `PriceIngress.sol` (B016).

Observation envelope: `marketId, sourceId, sequence, observedAt, publishedAt, acceptedAt,
bid/ask depth summaries (lots), impact bid/ask (wad) at depth N, priceWad, source/rules hash,
payload digest`, authenticated by a pinned signer over a domain that includes chain id and engine
address. Rejected: duplicates, backwards sequence or time, future timestamps (tolerance 0 s), wrong
market/source, unauthorized signer. Freshness uses `observedAt`, never `acceptedAt`. B implements
aggregation, TWAPs and guards only.

## CP-ORACLE — resolution oracle team

**Risk side (B):** `contracts/src/interfaces/IResolutionIngress.sol`, `ResolutionIngress.sol`
(B034), `InvalidPrice.sol` (B035), `SettlementController.sol` (B036).

- Only the pinned `ResolutionOracle` may call `halt()`, `settle(uint8 Y)`, `settleInvalid()`.
- `settle(1)` = YES, `settle(0)` = NO; any other Y reverts. Oracle `INVALID` and `Voided` both call
  `settleInvalid()`. The engine-local `FinalOutcome {UNSET, NO, YES, INVALID}` is never ABI-cast
  from the oracle enum `{NONE, YES, NO, INVALID}`.
- Same outcome again returns `newlyAccepted=false`; a different outcome reverts
  `ConflictingFinalOutcome`.
- `materializeScheduledHalt()` is permissionless at/after T.
- `settle*` does constant work: no account loop, no token transfer, no TWAP requirement.
- Halt snapshot reports `oiHaltLots` (includes reserve); bond adapter uses `oiHaltLots * 1000`
  atoms. `Resolution.haltedAt` must copy `economicHaltAt`, not the keeper's late block time.
- The oracle never supplies a price. INVALID price comes from `captureInvalidPrice()` over the
  listed `[T-24h, T]` window, or the disclosed 0.5 fallback after `T+1h` for new listings only.

## CP-FACTORY — shared registry/factory

**Risk side (B):** `contracts/src/interfaces/IMarketConfig.sol` (B019) and an immutable fixture
harness. Immutable: marketId, token, registry, resolution authority, scheduledT, listedAt,
source/rules hashes, INVALID rule (fallback flag, grace, fallback price), template, activation
caps, account bound. Listing gate: `T - listedAt >= 24h` and `T + invalidCaptureGraceSecs <=
listedAt + voidSecs` (voidSecs = 30 days). Mutable calibration is a versioned risk input with a
profile hash; no price or oracle callback can rewrite any immutable field.

## CP-TOKEN — OutcomeVault

**Risk side (B):** `ConversionGate.sol` (B038). Conversion is disabled (DEC-10). It can only ever
activate market-wide, before any cash claim, when every account including the reserve is fully
backed at the halt snapshot. No outcome-token code is written here.

## CP-APP — indexer and frontend

**Risk side (B):** `RiskView` (B032), `packages/risk-sdk` (B038, B042), `docs/app-state-fixtures.json`
(B042). Every value carries units and block/config/price/cutoff identity. Unavailable is never 0.
`ORACLE_FINAL_PRICE_PENDING`, `ORACLE_FINAL_PREPARING` and `CLAIMABLE` are distinct. The UI enables
payouts only from `claimsEnabled`.

## Person A (same team, separate lane)

B never writes A files. B consumes A's accounting port, account snapshots and settlement jobs
through the interfaces frozen at G2/G3/G5. Until those exist, B uses provisional stand-ins under
`provisional/` and `contracts/provisional/`, each listed in `docs/merge/B-assumptions.md` with the A
module that replaces it.
