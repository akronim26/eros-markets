# Request to the order-book team: risk hook seam (CP-BOOK)

## Status update — 2026-10-03

The original request below describes the book that remains on `integration/risk` at `2506235`.
The book team has since implemented the ten structural interface changes on `origin/main`
through `a114d06`, including single-market lots/engine IDs, epoch metadata, paired risk hooks,
cancel-all, expiry and forced reduction. Do not ask them to implement these again without
reviewing those commits. Main's real-book/B test still uses `MockAccountingPort`; the remaining
join is real Book + real A accounting + real B risk, followed by fresh integration evidence.
The real-counterpart status remains blocked until that join is validated.

## Original request — historical baseline

From: Risk & Clearing (integration/risk). Status: **BLOCKED_BY_COUNTERPART**. The published hook
fixtures (contracts/test/risk/B/BookSeam.t.sol, contracts/test/gates/G4.t.sol) could not be run
against `contracts/src/Book.sol`, because no adapter can map its hooks onto the risk seam in
risk_spec §6 without changes on the book side. Nothing in Book.sol was edited.

## Exact mismatches (Book.sol at integration/risk; spec §6 / `src/interfaces/IBookRiskHooks.sol`)

| # | Book.sol | Risk seam requires | Consequence |
|---|---|---|---|
| 1 | One contract for many markets: every hook takes `uint256 market`; `_books[market]` (`Book.sol` storage) | One isolated engine per market with one economic ledger (spec §1, §2) | The risk engine cannot be keyed by market inside one Book; needs one Book per engine or a market-scoped composition |
| 2 | Own trader registry `traderId(address)` assigned by the book | Engine trader id = Person A registry index + 1 (assigned at first allocation) | Two id spaces must be bound (or one shared) before any hook call |
| 3 | `uint96 size` "units"; `Ctx.cost` = Σ size × tick "in units of 0.001 USDC" (Book.sol `Ctx`) | Sizes in uint64 **lots** (0.001 claim); cash = lots × tick × Q (atoms × 1e18) | The cost comment implies 1 unit = 1 claim = 1,000 lots. Needs confirmation; an explicit unit conversion and overflow rule are required (spec §6 "no implicit truncation") |
| 4 | Public id = `gen << 24 | slot`, `uint8 gen`, 24-bit slot; `_onRest(market, trader, tick, size, flags)` returns nothing | `_riskAdmitRest` returns an `EpochTag` (uint64 market/account order epochs), reduce version and fee cap that the book must keep per order (generation-bound sidecar) | Without stored epoch tags, a stale order removed after cancel-all or an epoch bump would release a **newer** reservation (spec §6 "old epochs cannot release new reservations") |
| 5 | `_onUnrest(market, trader, size, flags)` has no tick and no order id (Book.sol:376, :435) | Release at the order's exact tick and epoch (`_riskOnUnrest`) | Reservations cannot be released exactly (spec V08: cancel needs the tick, not an average) |
| 6 | Taker flow `_takerStart` → `_makerFill` per maker → `_takerFill` (memory only) → `_takerDone` (single taker account write) | Each matched pair is posted atomically for both legs with a coverage recheck per fill (`_riskTryMatchedFill`, DEC-05, spec §6 transaction pseudocode) | Deferring the taker write to the end breaks "each fill sees updated OI/cash/coverage" |
| 7 | `_admit` reverts to reject; in a batch the whole batch reverts | Expected capacity failures return statuses (`STOP_TAKER`, `PRUNE_MAKER`, reason codes); only invariant violations revert (spec §4.3 reason codes) | Book cannot express maker pruning vs taker stop |
| 8 | No cancel-all hook; a LIMIT remainder is rested through `_onRest` | `_riskCancelAll` (account epoch bump) and `_riskConvertPermitToRest` (the remainder converts the taker permit, never reserved twice) | Double reservation of a LIMIT remainder; no O(1) cancel-all |
| 9 | No forced-reduction entry | Reduce-only IOC with `AdmissionMode.FORCED_REDUCTION` through the same hooks for liquidation (spec §4.2 step 2; B I-10) | Book-close liquidation cannot run on the real book |
| 10 | `RiskSnapshot` in `src/RiskSnapshot.sol` = {index, slowIndex, mark, stage, tier} | `IBookRiskHooks.RiskSnapshot` = {marketOrderEpoch, riskVersion, economicTime, stage, indexWad, markWad, fundingIndex, accountingEpochId, premiumCutoff, premiumTariffHash, feeVersion, parameterVersion} | The file says Clearing owns it and may retype it; Risk did not edit it (B I-2). Please confirm we may replace it with the seam struct |

## What we ask

1. Agree on a versioned adapter: either the book calls the nine `_risk*` hooks of
   `src/interfaces/IBookRiskHooks.sol`, or both teams freeze a mapping for items 3–9 above.
2. Store the returned `EpochTag`, reduce version and fee cap per order (generation-bound), and pass
   tick + order id on every unrest.
3. Post each matched pair through `_riskTryMatchedFill` (no deferred taker write).
4. Add a reduce-only forced IOC entry for liquidation.
5. Confirm the size unit (lot vs claim) and the overflow rule for `uint96` ↔ `uint64` lots.

Fixture to run once a seam exists: `cd contracts && forge test --match-path test/gates/G4.t.sol`
with `MockBookAdapter` replaced by the real book in `test/integration/CombinedEngine.sol`.
