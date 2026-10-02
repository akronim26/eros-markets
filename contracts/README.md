# EventPerp contracts

Foundry workspace for the EventPerp core. **Book (R1)** is the fully on-chain order book from
design spec §9; it drives Risk & Clearing (R2) through the internal hook seam of
`src/interfaces/IBookRiskHooks.sol` (risk spec §7.5, §7.7; `docs/spec/book_interface.md`).

## Book at a glance

| Piece | Where | Spec |
|---|---|---|
| 999 ticks (0.001–0.999), 4 bitmap words per side, bit 255 kept as a sentinel | `_setBit`, `_bestBid`, `_bestAsk` | §9.2, §9.5 |
| FIFO doubly linked levels; `used` keeps a level slot non-zero | `Level`, `_insert`, `_unlink` | §9.3, §9.5 |
| Dense `orders` array; dead slots stay non-zero tombstones on a free list | `_insert`, `_unlink` | §9.5 |
| Each order keeps risk's record: full `uint64` epochs, reduce version, fee cap | `Order`, `_view` | risk §7.2 |
| Public id `gen << 24 \| slot` | `_id`, `_liveSlot` | §9.5 |
| Bounded match loop; expired makers, self-trades and pruned makers use up steps | `_match`, `_step` | §9.6 |
| LIMIT / IOC / POST_ONLY, reduce-only, no crossed remainder | `_place` | §9.7 |
| Good-til-block expiry: executable while `block.number <= expiryBlock` (0 = none) | `_place`, `_step` | risk §7.6 |
| `batch`: cancels first and idempotent; a crossing post-only order returns id 0 | `batch` | §9.7 |
| Risk seam | see "Integrating other modules" below | §9.8, risk §7.7 |

External API: `placeOrder`, `cancel`, `cancelAll`, `batch`, `bestBidAsk`, `touch`, `getLevel`, `getOrder`, `maxFills`.
Events: `MaxFillsSet`, `OrderPlaced`, `OrderCancelled(reason)`, `AllOrdersCancelled`, `OrderRejected(reason)`, `Fill`
(with both fees). Sizes are lots (0.001 claim). Indexers rebuild
depth from these; there is no on-chain depth getter (§9.10).

## Integrating other modules

Everything lives in one per-market contract (`EventPerp is Book, <risk engine>, ...`), so the
book and risk talk through internal functions with no external calls in the match loop (§9.5
rule 4). `Book is IBookRiskHooks`: it calls the hooks and the risk engine implements them.
`test/BookComposition.t.sol` shows the pattern with minimal modules.

**Hooks the book calls** (risk spec §7.7 order flow):

| Hook | Called | Use |
|---|---|---|
| `_traderOf(account) → id` | every place, batch and cancel | the engine's trader id: the accounting registry's index + 1. The book keeps no registry |
| `_riskBeginAction() → snap` | once per order, per cancel, per batch of cancels | freeze prices and stage for the action; every later hook gets `snap` |
| `_riskPrepareTaker(req, snap, mode) → (permit, reason)` | once per order, post-only included | stage, size and margin gates; a zero permit is a rejection (`OrderRejected`), never a revert |
| `_riskTryMatchedFill(snap, permit, maker, lots) → result` | per examined maker (not self-trades) | re-admit the maker and post both legs at its tick. `FILLED`: the book shrinks the order without an unrest; `PRUNE_MAKER`: removed (`FAILED_CHECK`); `STOP_TAKER`: the match ends, the maker stays |
| `_riskConvertPermitToRest(snap, permit, lots, expiry) → record` | a LIMIT or POST_ONLY remainder | the permit becomes the resting reservation (never reserved twice); the order keeps the returned epochs, reduce version and fee cap |
| `_riskOnUnrest(snap, owner, epochs, side, tick, lots, feeCap)` | an order removed unfilled: cancel, self-trade, prune, reduce-only clip | release exactly those lots at their tick and epoch; never for filled lots |
| `_riskFinishTaker(snap, permit)` | once per admitted order | release the permit and run final checks; a revert rolls back every fill |
| `_riskCancelAll(trader) → epochs` | `cancelAll` | O(1): the account moves to a new order epoch; its old orders stay in the book, never fill, and are pruned when reached |

`_riskTouchAccount` and `_riskAdmitRest` are part of the seam but the book never needs them: risk
touches accounts inside the hooks above, and every rest converts a permit.

**Functions a module calls:**

| Function | For |
|---|---|
| `_initBook(maxFills)` | Markets: open the book with its fill bound (no default) |
| `_setMaxFills(maxFills)` | retune the bound after gas measurements; emits `MaxFillsSet` |
| `_touch() → (bid, bidSize, ask, askSize)` | Pricing: mark inputs with the D_min depth filter |

## Where this differs from the spec

1. **One book per market engine.** Risk & Clearing keeps one isolated ledger per market (risk
   spec §1), so each per-market engine composes exactly one Book and no hook takes a market id.
2. **Risk's seam replaces the design spec's §9.8 hooks.** Each matched pair is posted inside its
   own fill and rechecked there, instead of one deferred taker write, and expected failures come
   back as statuses (`PRUNE_MAKER`, `STOP_TAKER`, rejection codes) instead of reverts.
3. **Generation wrap.** A slot whose generation reaches 255 is retired, not recycled, so an order
   id is never reissued. That settles the master spec's open point that an 8-bit generation wraps
   after 256 reuses. The cost is one fresh slot per 256 reuses.
4. **Orders are three slots.** The topology stays in the first; the other two hold risk's record
   for the order, so an old epoch can never release a newer reservation. There is no protocol
   cancel: liquidation and stage changes invalidate orders by epoch on the risk side, and stale
   orders are pruned when a taker reaches them.
5. **The fill bound is per-market config, not a constant.** The master spec's 64 is a placeholder
   to be set from measured gas, so each book gets its bound at creation (`_initBook`), can be
   retuned (`_setMaxFills`) and is readable (`maxFills`). Orders asking for more revert with
   `BadMaxFills`. It shares `freeHead`'s storage slot, which also keeps that slot non-zero.
   Nothing else is hardcoded: the tick grid (0.001, ticks 1–999) is a locked design decision the
   storage layout is sized from, and the bitmap word count and level array length derive from it.
6. A reduce-only maker with nothing left to reduce is pruned with `FAILED_CHECK`; one that
   reaches zero part-way through a fill has its unfilled rest cancelled with `CLIPPED`. A maker
   reached after its expiry block is cancelled with `EXPIRED` and uses a step; an order whose
   expiry is already past reverts with `BadExpiry`.

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
| `BookSeam` | the risk seam: one snapshot reaches every hook, fills report lots at maker prices, risk's record round-trips with the order, rejections and stops are codes, unrests only for unfilled lots, cancels while halted, `touch` |
| `BookComposition` | a core built like EventPerp from three separate modules (Markets, Clearing posting each pair behind the risk hooks, Pricing depth filter) compiles and trades correctly; use it as the template |
| `BookGas` | gas per operation for Book alone (no-op risk hooks), written to `snapshots/BookGas.json`; CI fails if it changes |

Every suite was checked with injected bugs (bit left set, crossed remainder rested, no
retirement, broken prev link, no clip cancel, overfilled request, steps not counted, no
self-trade prevention). Each bug made at least one test fail.

## Gas: read this before quoting numbers

Foundry 1.8.3 has `--network monad`, but it **does not implement MIP-8 page pricing**. A second
fresh slot on an already touched page costs the same as the first (checked 30 Sep 2026: 27,941
gas each). The snapshots therefore measure regressions, not Monad cost. They also exclude the
21k base cost and risk's account writes. Under Ethereum pricing a recycled slot saves about
14.6k gas per placed order (88.5k → 73.9k). Each examined maker also reads its two record slots,
so the 64-step worst case is about 1.25M gas. Take the spec §9.9 figures from testnet
measurements.
