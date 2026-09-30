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
| Clearing seam | `_takerStart`, `_makerFill`, `_takerFill`, `_takerDone`, `_onRest`, `_onUnrest` | §9.8 |

External API: `placeOrder`, `cancel`, `batch`, `bestBidAsk`, `getLevel`, `getOrder`, `traderId`.
Events: `TraderRegistered`, `OrderPlaced`, `OrderCancelled(reason)`, `Fill`. Indexers rebuild
depth from these; there is no on-chain depth getter (§9.10).

## Where this differs from the spec

1. **`_onRest` / `_onUnrest` take `market`.** The spec's signatures omit it, but reservations
   (R_buy, R_sell) belong to a (trader, market) account.
2. **New `_takerStart(ctx, size) → allowed` hook.** This is the spec's "load the taker and settle
   funding once" setup step. It also clips a reduce-only taker to its position before matching.
3. **Generation wrap.** A slot whose generation reaches 255 is retired, not recycled, so an order
   id is never reissued. That settles the master spec's open point that an 8-bit generation wraps
   after 256 reuses. The cost is one fresh slot per 256 reuses.
4. **Protocol cap `MAX_FILLS = 64`** (the master spec's placeholder). The UI should request about 8.
5. A reduce-only maker with nothing left to reduce comes back from `_makerFill` as 0 and is
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
| `BookGas` | gas per operation, written to `snapshots/BookGas.json`; CI fails if it changes |

Every suite was checked with injected bugs (bit left set, crossed remainder rested, no
retirement, broken prev link, no clip cancel, overfilled request, steps not counted, no
self-trade prevention). Each bug made at least one test fail.

## Gas: read this before quoting numbers

Foundry 1.8.3 has `--network monad`, but it **does not implement MIP-8 page pricing**. A second
fresh slot on an already touched page costs the same as the first (checked 30 Sep 2026: 27,941
gas each). The snapshots therefore measure regressions, not Monad cost. They also exclude the
21k base cost and Clearing's account writes. Under Ethereum pricing a recycled slot saves about
14.7k gas per placed order (103.3k → 88.6k). Take the spec §9.9 figures from testnet
measurements.
