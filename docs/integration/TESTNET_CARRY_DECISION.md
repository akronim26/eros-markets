# Testnet INDEX and book carry: 120 s and 300 s (Monad testnet only)

Status: implemented 2026-10-11, unified-team technical validation (not independent review).
Authorized by the user on 2026-10-11 as part of the lower-cost single-market relaunch
(recorded in the `docs/merge/STATUS.md` turn log). Applies only where `block.chainid == 10143`. Every other chain keeps the
spec §4.1 values (INDEX and book samples carry 30 s; windows 300/60/900 s).

## Change

| Constant | Before | After | Where |
|---|---|---|---|
| INDEX carry | 30 s | **120 s** (`TESTNET_INDEX_CARRY`, `PricingMath.indexCarry()`) | `ObservationStore._carry`, `pricingWindows()[3]`, INVALID-window integral, `SourceGuards._freshThrough` |
| Book (PERP/BASIS) carry | 90 s | **300 s** (`TESTNET_BOOK_CARRY`, `bookCarry()`) | `ObservationStore._carry`, `samplePerp` pending-capture expiry |

`pricingWindows()` now reports `(60, 60, 60, 120)` on testnet; `fresh-market.ts` checks that.

Why: the publisher sent one transaction per Polymarket update (every 14–26 s) and the keeper one
sample per publish, about 24 MON/h for one market. With a 120 s carry the publisher sends once
per about 70 s (`scripts/e2e/index-pacing.mjs`), and one sample per publish keeps sealed book
samples about 140 s apart, inside the 300 s book carry.

## Every 30 s INDEX assumption, changed or justified

| Location | Decision |
|---|---|
| `ObservationStore._carry` / `_valueAt` / `pricingWindows` | Changed to `indexCarry()`. |
| `ObservationStore._invalidWindowTwap` | **Changed.** It integrated the endpoint checkpoints with a fixed 30 s carry while the checkpoints were accumulated with `_carry(INDEX)`. At an 80 s cadence the start and end lose different amounts, so the 86,400 s INVALID price would be unavailable. Reproduced by `TestnetIndexCarryConsumersTest.testInvalidWindowIsContiguousAtEightySecondCadence` (fails on the old code, passes now). |
| `SourceGuards._freshThrough` (funding freshness latch) | Changed to `indexCarry()`, otherwise every 80 s cadence opens a funding gap and stops funding for the epoch. |
| `RiskPricing._warmupIndexPoint` | Uses `_valueAt`, so it follows the INDEX carry. Warm-up quotes centre on the latest authenticated point up to 120 s old; it never prices fills, margin or release. |
| `BookRiskEngine.samplePerp` pending expiry | Already `bookCarry()`. |
| `PricingMath.movementTrigger` (pure, `STALE_SECS`) | Unchanged; it is used only by tests. The engine's movement check (`SourceGuards._checkMovement`) uses `_valueAt`, so it follows the carry. A 300 s look-back needs a valid INDEX point within 120 s of `t - 300`, which the cadence provides. |
| `scripts/e2e/market-services.ts` keeper gate (`<= 25 s`) | Changed to `KEEPER_INDEX_MAX_AGE_SECS = 110`. With 25 s the keeper would refuse most samples between paced publishes. |
| `sampler-coordination.mjs` `indexFreshCutoff` (−18 s) | **Kept.** It is the maximum source age at send, set by the pricefeed's own 30 s source TTL and 5 s signing headroom, not by the on-chain carry. |
| `sampler-coordination.mjs` `+30n` capture deadline | **Kept.** INDEX regains priority 22 s after the last finalized observation, before the 80 s pacing due time, so a stalled keeper can never delay a paced publish. |
| `source-qualification.mjs` 25 s source gap | Kept as the default; added an explicit `--paced-testnet` mode with a 30 s bound. A source advancing at least every 30 s yields a publishable update by about due + 12 s, about 25 s before the carry ends. A quiet book older than the signing headroom is carried, not failed, within that bound. |
| `book-change-sampling.mjs` 5 s rate | Changed to 20 s: at most one extra sample and early INDEX per 20 s. |
| Frontend `price-chart.ts`, `price-axis.tsx` (30 s "Live"/line breaks) | Changed to `INDEX_CARRY_SECS = 120` (`frontend/src/lib/index-carry.ts`). |
| Frontend and server 30 s chain-head checks | Kept: they bound RPC block-timestamp staleness, not INDEX. |

## Risk trade-offs (testnet only)

- **Prices update about every 70 s** instead of about 15 s. MARK stays clamped to INDEX ± b(t),
  so a held book sample cannot move MARK outside the band (reference
  `BookCarry.test_held_book_sample_is_still_clamped_to_the_index_band`).
- **Dead source:** INDEX and MARK switch off at most 120 s after the last observation (was 30 s).
  Tested on-chain (`testBookGapBeyondBookCarry…`: MARK off at +121 s) and in the reference
  (`IndexCarry.test_dead_source_turns_index_off_within_120_seconds`). Live check: B14.
- **Stalled keeper:** the last sealed book sample still counts for up to 300 s, so MARK and
  leverage can reflect a book up to 5 min old. After 300 s MARK drops and leverage falls to 1×.
  INDEX remains independent.
- **Contract size:** 8 KiB-claim market creation 29,448,268 gas (budget 29,500,000; was
  29,429,503). Engine runtime 123,530 B (limit 131,072).
- No DEC decision, calibration or invariant changes. Production behaviour is unchanged and is
  checked by `testFastWindowsAreExclusiveToMonadTestnet`, `testOtherChainsKeepThirtySecond*`.

## Gas margins and maker ladder (T4): not changed

Measured on the live market (2026-10-11, first 22 publishes and 18 samples):

| Call | Worker estimate at signing | Limit paid (Monad charges the limit) | Margin |
|---|---|---|---|
| `submitObservation` | 203,268–276,238 | 223,595–303,862 | estimate + 10% |
| `samplePerp` | about 458,000–605,000 (from limit = estimate × 1.25 + 10,000) | 582,862–766,728 | + 25% + 10k |

The plan asked for actual execution gas, to choose the smallest safe margin (target about
10%). It can't be measured with the available tools: Monad receipts and
`debug_traceTransaction` report `gasUsed` equal to the limit, the fallback RPCs refuse tracing on
their free tier, and an anvil fork at a past block fails because those RPCs don't serve
historical state for the new engine. Without the real spread between estimate and execution,
cutting the keeper margin from 25% to 10% could run samples out of gas when a seal path or
book change lands between estimate and inclusion. **Decision: keep 25% (keeper) and 10%
(publisher).** Lowering the keeper margin would save about 12% of keeper gas; revisit with a
tracing-capable RPC. The maker ladder is unchanged for the same reason.

## Fresh-source rule after the first hourly rollover (2026-10-11 13:02 UTC)

The first live hour at an 80 s cycle lapsed INDEX for 81 s (13:03:26–13:04:47; MARK off for
the same 81 s, book windows fully covered). The publisher took a source observed 15 s before
the 80 s due time. Under the 30 s source TTL and 5 s signing reserve that left about 10 s to
sign and send; the primary RPC was slow, the delivery was never broadcast
(`RELAY_HEADROOM_EXPIRED`, attempts 0), and the safe nonce cancellation that followed took
about 70 s. Fix in `index-pacing.mjs`: publish due 70 s after the last observation, take only a
source at most 6 s old (at least 18 s of headroom) until 100 s, then any source within the usual
18 s cutoff. Cost rises by about one publish and one sample per 9–10 minutes.

