# EventPerp contracts

Foundry workspace for the EventPerp core. Built so far: **Book (R1)**, the fully on-chain order
book from design spec §9. Clearing (R2) plugs into its internal hooks.

## Book at a glance

| Piece | Where | Spec |
|---|---|---|
| 999 ticks (0.001–0.999), 4 bitmap words per side, bit 255 kept as a sentinel | `_setBit`, `_bestBid`, `_bestAsk` | §9.2, §9.5 |
| FIFO doubly linked levels; `used` keeps a level slot non-zero | `Level`, `_rest`, `_unlink` | §9.3, §9.5 |
| Dense `orders` array; dead slots stay non-zero tombstones on a free list | `_rest`, `_unlink` | §9.5 |
| Public id `gen << 24 \| slot` | `_id`, `_liveSlot` | §9.5 |
| Bounded match loop; self-trades and failed makers use up steps | `_match`, `_step` | §9.6 |
| LIMIT / IOC / POST_ONLY, reduce-only, no crossed remainder | `_place` | §9.7 |
| `batch`: cancels first and idempotent; a crossing post-only order returns id 0 | `batch` | §9.7 |
| Clearing seam | see "Integrating other modules" below | §9.8 |

External API: `placeOrder`, `cancel`, `batch`, `bestBidAsk`, `touch`, `getLevel`, `getOrder`, `traderId`.
Events: `TraderRegistered`, `OrderPlaced`, `OrderCancelled(reason)`, `Fill`. Indexers rebuild
depth from these; there is no on-chain depth getter (§9.10).

## Integrating other modules

Everything lives in one contract (`EventPerp is Book, Clearing, ...`), so modules talk through
internal functions with no external calls in the match loop (§9.5 rule 4).

**Hooks a module overrides** (all `internal virtual`):

| Hook | Called | Owner | Use |
|---|---|---|---|
| `_admit(market, trader, place)` | first, for every new order | Markets / oracle (R4) | stage gate (Halted: nothing; ReduceOnly: reduce-only only), price band, minimum size. Revert to reject. Cancels are never gated |
| `_takerStart(ctx, size) → allowed` | once per taker order | Clearing (R2) | load the taker, settle funding, fill `ctx.risk`, clip a reduce-only taker |
| `_makerFill(ctx, maker, makerBuys, tick, size, flags) → filled` | per examined maker | Clearing | stage, reduce-only, IM at q and I, stress; 0 cancels the order, less than `size` clips it |
| `_takerFill(ctx, takerBuys, tick, size)` | per fill | Clearing | taker side in memory |
| `_takerDone(ctx)` | once, after matching | Clearing | final IM / OI / stress checks and the single taker write; revert rolls back every fill |
| `_onRest(market, trader, tick, size, flags)` / `_onUnrest(market, trader, size, flags)` | when units start / stop resting | Clearing | R_buy / R_sell for IM+; `_onRest` may revert |

**Context:** `Ctx` carries `market`, `taker`, `takerBuys` and `flags`, plus two totals Book keeps
for `_takerDone`: `filled` and `cost` (Σ size × tick, in 0.001 USDC). It also holds
`risk`, a `RiskSnapshot` (`src/RiskSnapshot.sol`). Clearing owns that struct and can change its
fields without touching Book.

**Functions a module calls:**

| Function | For |
|---|---|
| `_initBook(market)` | Markets: create a market's book |
| `_traderOf(address) → id` | Clearing: the trader id accounts are keyed by |
| `_touch(market) → (bid, bidSize, ask, askSize)` | Pricing: mark inputs with the D_min depth filter |
| `_forceCancel(market, id, RISK \| STAGE) → bool` | liquidation, stage changes, keepers; no owner check, stale ids return false |

## Where this differs from the spec

1. **`_onRest` / `_onUnrest` take `market`.** The spec's signatures omit it, but reservations
   (R_buy, R_sell) belong to a (trader, market) account.
2. **New hooks `_takerStart` and `_admit`, and `Ctx` carries `filled`, `cost` and `risk`.** The
   spec's `Ctx` holds a snapshot but doesn't define it, and Solidity can't extend a struct from a
   derived contract, so the snapshot has its own file. `_takerStart` is the spec's "load the taker
   and settle funding once" step and also clips a reduce-only taker to its position. `_admit` is
   where market stages, the price band and the minimum size are enforced.
3. **Generation wrap.** A slot whose generation reaches 255 is retired, not recycled, so an order
   id is never reissued. That settles the master spec's open point that an 8-bit generation wraps
   after 256 reuses. The cost is one fresh slot per 256 reuses.
4. **`_onRest` / `_onUnrest` receive the order's flags** (side and reduce-only), and
   `_forceCancel` plus two cancel reasons (`RISK`, `STAGE`) let other modules remove orders.
5. **Protocol cap `MAX_FILLS = 64`** (the master spec's placeholder). The UI should request about 8.
6. A reduce-only maker with nothing left to reduce comes back from `_makerFill` as 0 and is
   cancelled with `FAILED_CHECK`. A partial clip is cancelled with `CLIPPED`.

## Tests

```sh
forge test                      # fast profile: 1k fuzz runs, 48×64 invariant
FOUNDRY_PROFILE=ci forge test   # 10k fuzz runs, 256×128 invariant (~6–8 min)
```

| Suite | What it proves |
|---|---|
| `BookBitmap` | word/bit mapping at ticks 1, 250, 251, 500, 501, 750, 751, 999; sentinels are never returned; fuzzed against a full scan |
| `BookRest` | FIFO links; head/middle/tail cancel; tombstones; LIFO slot reuse; stale ids; retirement at generation 255 |
| `BookMatch` | price-time priority; partial fills; limits; order types; self-trade; failed makers; `maxFills` counting; crossed remainders; reduce-only on both sides; atomic taker rejection |
| `BookBatch` | cancels run before places; stale and duplicate cancels do nothing; crossing post-only returns id 0; bad input reverts the whole batch |
| `BookInvariant` | INV-8 under random traffic: bit ⇔ non-empty level, level size = sum of its orders, links agree, each live order linked once, free list complete, reservations match, bid < ask; positions net to zero; ids never reissued |
| `BookDifferential` | the same random operations in Book and in a naive linear-scan reference give identical fills, sizes, best prices and positions |
| `BookSeam` | the integration surface: the snapshot reaches every hook, `filled`/`cost` totals, stage gates, cancels while halted, protocol cancels, `touch` |
| `BookGas` | gas per operation for Book alone (no-op hooks), written to `snapshots/BookGas.json`; CI fails if it changes |

Every suite was checked with injected bugs (bit left set, crossed remainder rested, no
retirement, broken prev link, no clip cancel, overfilled request, steps not counted, no
self-trade prevention). Each bug made at least one test fail.

## Gas: read this before quoting numbers

Foundry 1.8.3 has `--network monad`, but it **does not implement MIP-8 page pricing**. A second
fresh slot on an already touched page costs the same as the first (checked 30 Sep 2026: 27,941
gas each). The snapshots therefore measure regressions, not Monad cost. They also exclude the
21k base cost and Clearing's account writes. Under Ethereum pricing a recycled slot saves about
14.7k gas per placed order (80.7k → 66.0k). Take the spec §9.9 figures from testnet
measurements.
