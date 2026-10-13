# Fast MARK startup on Monad testnet (FM-01 to FM-08)

Date: 2026-10-10, deployed 2026-10-11. Status: **implemented, validated and deployed on Monad
testnet** (FM-08 below). The October 9 engines were immutable and are retired.

Baseline: `feat/pricefeed` at `1cb19bae2671a066fe948d7781535ff45154119c` plus the uncommitted
AUD-01..AUD-08 repairs. This is unified-team technical validation, not an independent
review, an audit or gate acceptance.

## Why the October 9 markets never reached MARK

See `tmp/startup-latency-20261010/runtime-findings.md` for the canonical evidence. In short:

- `BOOTSTRAP -> NORMAL_PRICING` ran only inside the hourly epoch opening
  (`RiskPricing._onEpochOpening`). All windows became valid 5m52s after launch, then waited
  for 09:00:05. At that opening, PERP carry had just lapsed, so promotion failed and would have
  waited another hour.
- Book history could not start until INDEX had a complete window. `bookDepth()` and order
  admission both required the INDEX TWAP, so the sequence was 60 s INDEX, then 180 s BASIS,
  giving a floor of roughly 240 s plus overhead.
- The maker backed off 15 s whenever INDEX was unavailable.
- Workers later stopped on gas headroom: one maker at 44 min, one keeper at 82 min.

## What changed

### Contracts (FM-01, FM-02, FM-03)

All new behaviour is gated by `PricingMath.fastStartup()` (`block.chainid == 10143`). Other
chains keep spec §4.1 unchanged: 300/60/900/30 windows, promotion only at a completed epoch
opening, and no warm-up quoting.

| Change | Where |
|---|---|
| Testnet BASIS window 180 s -> 60 s (INDEX 60, PERP 60, carry 30 unchanged) | `PricingMath.TESTNET_BASIS_WINDOW` |
| `activatePricing()`: permissionless, one-time BOOTSTRAP -> NORMAL_PRICING when the market is active, accounting READY, not halted and every candidate is valid at this block | `BookRiskEngine.activatePricing`, `RiskPricing._activatePricing` |
| Promotion logic shared by the epoch opening and activation (`_promotePricing`) | `RiskPricing` |
| Warm-up reference: the latest fresh (≤ 30 s), depth-valid authenticated INDEX point, only in BOOTSTRAP before the first complete INDEX window | `RiskPricing._warmupIndexPoint`, view `warmupIndex()` |
| Warm-up quoting: a `POST_ONLY`, non-reduce-only, exactly backed order inside the bootstrap band around the warm-up point may rest | `OrderAdmission._warmupRestDecision`, `BookRiskAdapter._riskPrepareTaker` |
| Funded depth around the warm-up point is sampled, so PERP and BASIS history start with the first INDEX observation | `BookRiskEngine._bookDepth`, `samplePerp` |
| Defensive guard: no matched (non-forced) fill without a valid INDEX window | `BookRiskAdapter._riskTryMatchedFill` |

What activation deliberately does not change:

- **Epoch clock and accounting.** Activation opens no epoch and bumps no order epoch, so resting
  quotes keep depth continuity.
- **Funding.** An epoch that opened in BOOTSTRAP keeps rate 0. Funding can be authorized only at
  a later completed opening, which is the DEC-02 rule, unchanged. Initial engines also have
  funding disabled.
- **Calibration and risk version.** A staged profile activates only at a completed opening.
- **Admission.** Leverage still needs `NORMAL_PRICING` with every candidate valid. Every
  admission, maker readmission, fill preflight and release still runs the same margin, coverage
  and IM checks. The initial profile stays uncalibrated 1x; `leverageCaps()` returns (1, 1)
  after activation.

Why warm-up quotes cannot trade:

- Only `POST_ONLY` reaches the warm-up decision.
- The book never calls `_match` for `POST_ONLY` and rejects a crossing `POST_ONLY`.
- `LIMIT` and `IOC` see `Admission.NONE` and are rejected.
- The fill guard independently stops any non-forced fill without a valid INDEX window.

Halving admits only the fully backed prefix of an underfunded quote, which is existing
bootstrap behaviour.

This is a user-directed testnet amendment of spec §4.1 ("switch to NORMAL_PRICING only at a
completed accounting epoch"). DEC-02 (hourly fixed-rate funding) and DEC-14 (exactly backed
bootstrap before mark windows exist) are unchanged. Production semantics are untouched.

### Workers (FM-04, FM-05, FM-06)

**Keeper** (`scripts/e2e/market-services.ts`, `scripts/e2e/pricing-activation.mjs`,
market-ops `activate` command):
- Probes `warmupIndex()` once at startup. Legacy engines revert on it and keep the epoch-only
  path and the bootstrap rollover deferral.
- Checks activation readiness immediately after every finalized sample, and otherwise at
  most every 2 s.
- Readiness means BOOTSTRAP, READY accounting and all three windows complete at one block.
- When ready, it measures gas, simulates and journals one `activatePricing` transaction.
  `PricingActivationUnavailable` is treated as a normal `no-work` answer.
- Writes `pricing-notice.json` after a finalized activation or rollover step.

**Publisher** (`pricefeed-watch.mjs`): writes `index-notice.json` after every finalized INDEX
observation. The write is best-effort; publication never depends on it.

**Maker** (`makers.mjs`):
- Waits on those coordination notices (`readiness-notifier.mjs`) instead of fixed sleeps. The
  old 15 s / 3 s / 1 s delays remain only as upper bounds.
- Quotes from `warmupIndex()` before INDEX is ready. It skips the taker-only `previewOrder` in
  that state; the exact transaction simulation stays the admission check.
- In BOOTSTRAP it keeps eligible quotes unchanged (`makerBootstrapHold`). Every book change
  discards the pending capture and restarts PERP/BASIS coverage. Empty or thin depth is
  repaired at once, and a quote is repriced only near the band edge.
- After activation, the existing capture-promotion coordination applies unchanged.

All authenticity, depth, spread, freshness, inclusion-reserve and capture-seal checks are
unchanged. No historical observation is manufactured or extended.

**Gas runway** (`scripts/ops/gas-runway.mjs`, supervisor):
- Each role's stopping threshold mirrors its own pre-signing check:
  - publisher: `relay.maxCostWei`;
  - keeper: `maxGas × 150 gwei + 0.1 MON`;
  - each maker: `2M × 150 gwei + 0.1 MON`.
- Projected spend uses gas limits, because Monad charges the limit.
- `market-supervisor.mjs check|run` refuses launch with `GAS_RUNWAY_INSUFFICIENT` and per-role
  top-up amounts unless every role has `launchMinutes` of runway (default 120).
- While running, it records `gasRunwayAlert` events and status when a role falls below
  `alertMinutes` (default 30), before it stops.
- Configure with `gasRunway: { launchMinutes, alertMinutes, checkIntervalMs }` in the
  supervisor config.

## Risk testing of the 60-second BASIS window (FM-02)

`reference/tests/b/test_fast_testnet_basis.py` uses the exact Fraction reference with
hand-derived expected values.

- **Manipulation.** The median already follows the two 60 s book candidates (PERP TWAP and live
  PERP). A book push of any duration moves MARK identically with a 60 s or 180 s BASIS: 0.515
  after 30 s and 0.53 after 90 s for a 0.03 push. The shorter window adds no cheaper attack.
- **Genuine INDEX jump with a lagging book** (0.50 -> 0.60, book reprices 40 s later). The 60 s
  BASIS absorbs the transient basis faster, so MARK lags the new INDEX more. At +50 s it sits at
  the clamp `I - b`, against 0.5611 with 180 s. Both are inside `I ± b(t)` throughout, and the
  extra lag is bounded by the 0.05 band. Both converge once a full post-jump window exists.
- **Book noise.** MARK stays inside the noise envelope for both windows. The 60 s window shows
  slightly larger step changes.

Consequence: during fast genuine moves, MARK-based health can lag INDEX by up to the band.
On testnet this is bounded by 1x uncalibrated admission, plus the unchanged 0.10 / 5 min
movement trigger and reduce-only rules.

## Startup path measurements (FM-07)

`contracts/test/integration/FastStartupTiming.t.sol` runs the real engine with signed
observations, real funded `POST_ONLY` quotes, real `samplePerp`, the keeper's depth precheck and
8 s epoch reserve, and real hourly rollovers. Cadence comes from the October 9 measurements:
first INDEX 10 s after launch, an observation every 12 s with 2 s source lag, a sample 2 s later,
and makers acting 5 s after a reference appears.

| Launch position in the hour | Service launch -> first MARK |
|---|---:|
| :00, :10, :30, :45 | **84 s** |
| 2 min before the hour (MARK before rollover) | 84 s |
| 70 s before the hour (warm-up crosses rollover) | 144 s |
| 40 s before the hour | 108 s |
| 10 s before the hour | 84 s |

Before this change the floor was about 240 s plus the wait for the next hourly opening (up to
60 min). The October 9 run produced no MARK at all.

`contracts/test/integration/FastStartup.t.sol` covers the failure paths:
- **Missing data.** A 45 s publisher/keeper gap removes the reference and depth, and activation
  needs full new 60 s windows after recovery.
- **Quote cancellation.** A cancelled side restarts coverage at the first capture after the
  requote: 130 s instead of 60 s.
- **Delayed delivery.** Observations landing 8 s late keep their `observedAt` and still
  activate in 60–70 s.
- **Restarts.** The 45 s gap above models a publisher/keeper restart; quotes keep resting
  and history is rebuilt, never carried. Worker journal recovery is unchanged and covered by
  the existing script tests, not by a new live restart run.
- **Accounting.** An expired epoch blocks activation; an inactive engine reverts.
- **Collateral.** After activation a thin account's taker fill is capped by collateral, and
  both endpoints stay ≥ 0.
- **Warm-up admission.** Rejects `LIMIT`/`IOC`, crossing, out-of-band, reduce-only and
  underfunded size beyond the backed prefix.

## Findings to carry forward

1. **Hourly MARK gap after activation (existing, not introduced here).** Each rollover
   invalidates resting quotes, and the 8 s sample reserve prevents sealing the last
   pre-boundary capture. With 30 s carry, MARK becomes unavailable about 7 s after the hour and
   returns about 65 s later (simulated). It affects every NORMAL market today. Fixing it needs a
   design change, either a keeper-initiated capture right after the maker requote or a
   rollover-aware capture rule, and is not part of this change.
2. **Market creation gas margin.** The engine runtime is 122,585 B (+810 B, 8.5 KB under
   128 KiB). Creating a market with an 8 KiB claim uses 29.41M frame gas (baseline 29.24M),
   or 29.58M with intrinsic gas, under the 30M transaction limit and the 29.5M forwarded
   budget. Small-text listings use 27.8M. The first version of this change exceeded the
   budget (29.54M); deduplicating the struct copy and promotion code fixed it. Future engine
   growth of about 470 B would exceed the 8 KiB-claim budget.
3. **Funding levels.** At 52 gwei the projections are about 12.5 MON/h per publisher, about
   16.2 MON/h per keeper and about 1.56 MON/h per maker. The October 9 grants (20 MON keeper,
   3 MON maker) are below the new 2-hour launch requirement, consistent with the observed
   82 min and 44 min stops.

## Validation (local; exit codes)

| Command | Result |
|---|---|
| `FOUNDRY_PROFILE=ci forge test` (forge 1.8.3, full CI fuzz depth, snapshot check) | 877/877 (baseline 856/856), exit 0 |
| `FOUNDRY_CODE_SIZE_LIMIT=131072 forge build --sizes` | BookRiskEngine 122,585 B runtime, exit 0 |
| `forge fmt --check` (contracts) | exit 0 |
| `forge test` (oracle) | 345/345, exit 0 |
| `FOUNDRY_PROFILE=integration forge test --match-path 'test/integration/*.t.sol' --network monad --hardfork monad:MonadTen --isolate --gas-limit 10000000000` (oracle) | 82/82, exit 0 |
| `node --test scripts/e2e/*.test.mjs scripts/ops/*.test.mjs` (Node 24.21.0) | 111/111 (baseline 91), exit 0 |
| `bun test` (oracle/services/market-ops) and `tsc --noEmit` | 54/54, exit 0 |
| `bun test` keeper policy scripts (oracle CI set) | 14/14, exit 0 |
| `tsc` over `scripts/e2e/market-services.ts` (market-ops config) | exit 0 |
| Python reference `reference/tests/b/test_*.py` | all OK, including 7 new BASIS risk tests |
| Frontend `tsx --test tests/*.test.mjs` / `tests/integration/*.test.ts` / `tsc --noEmit` | 119/119, 67/67, exit 0 |
| `python3 scripts/export-risk-abis.py --forge <1.8.3>` | regenerated `artifacts/risk/{book-risk-engine,engine}-abi.json` |

Baseline: the same commands on an untouched copy of `contracts/` gave 856/856. The oracle
8 KiB creation test passed on the baseline and failed on the first version of this change,
which is how finding 2 was found.

Not validated: a live run with real workers on a Monad fork or on testnet, live gas prices, and
real wallet flows. All timings above are deterministic simulations on the real engine, not
public-chain measurements.

## FM-08: replacement deployment (performed 2026-10-11)

- Old operator MON recovered first (38.198 MON, eight verified transfers); all project
  contracts held 0 MON.
- New code stores, factory `0x625e323822A74add21837046f61D4AFCAe745f96` and vault
  `0xb251268Ce641D4FE1b1E70067FA644065fE0911E`, with the timelocked `setFactory`.
- Markets: BTC above $82,000 on October 13 (`0x5225228DAcBa2a676a13FAe478Ba919e60869a3d`) and ETH
  above $2,400 on October 14 (`0xe26DE3d7Fd39Bc1B89143649c595fd3dDFdc4cA7`). Every stage was
  rehearsed on an anvil 1.8.3 fork before broadcast.
- Real launch → first finalized MARK: **BTC 95 s** (INDEX 66 s), **ETH 161 s** (INDEX 158 s).
  Both reached NORMAL pricing mid-epoch with 5×/5× caps. ETH's INDEX was slower
  because the publisher waits for a newer Polymarket book update after each capture.
- Keeper spend was higher than projected in the first hour, mainly from the bootstrap
  rollover batch (Monad charges the full gas limit). Watch `gasRunwayAlert`.

Addresses: [addresses.md](../../addresses.md). Operations: [TESTNET_OPERATIONS.md](TESTNET_OPERATIONS.md).

## Lower-cost relaunch (2026-10-11): 120 s / 300 s carries, pacing, wake-on-visit

User decisions of 2026-10-11 (recorded in the `docs/merge/STATUS.md` turn log). Details and the full 30 s audit:
[TESTNET_CARRY_DECISION.md](TESTNET_CARRY_DECISION.md).

- **Carries (chain 10143 only):** INDEX 30 → 120 s, book 90 → 300 s. `pricingWindows()` =
  `(60, 60, 60, 120)`. The INVALID-window integral and the funding freshness latch now use the
  same INDEX carry (the INVALID integral used a fixed 30 s before; reproduced and fixed).
- **Publisher pacing** (`scripts/e2e/index-pacing.mjs`): one publish when the newest finalized
  observation is 70 s old, taking only a source at most 6 s old until 100 s; every source update while the keeper reports `markAvailable: false`
  (warm-up keeps launch → MARK at 84–108 s in the timing model); one early publish after a
  book-change capture, at most one per 20 s. Holding only delays publication.
- **Keeper:** samples while INDEX is ≤ 110 s old; reports `markAvailable` in its heartbeat;
  writes `early-index-request.json` after a book-change capture finalizes. Book-change samples
  are limited to one per 20 s.
- **Supervisor** (`scripts/ops/wake-policy.mjs`): polls `GET /api/market-activity` every 15 s;
  sleeps a market after 10 min without a visitor unless any account has `e0Q < 0` or `e1Q < 0`;
  every read failure keeps or makes it awake; a visitor during shutdown wakes it as soon as the
  workers stop; a fenced publisher (`WRITER_FENCED`) restarts with backoff; a sleeping market no
  longer ends the supervisor; the gas runway projects spend from `publishIntervalSeconds`.
- **Frontend:** visible tabs send a heartbeat every 30 s (`POST /api/market-activity`, Vercel
  Runtime Cache, region `iad1`); a "Market waking up" row shows price → trading → full leverage;
  chart freshness uses the 120 s carry; Release follows `previewRelease` (BAD_STAGE during
  accounting work reads "Market is processing its hourly update"), Withdraw needs only the
  account read.
- **Timing model** (`FastStartupTiming.t.sol`, real engine): with warm-up then 80 s cadence and a
  28 s source lag, MARK never lapsed over 25 min including an hourly rollover (24 publishes
  versus about 125 at source cadence) and through a fill with or without the early publish.
  Publishing at 80 s from launch delays first MARK to 172–252 s, which is why warm-up keeps
  the source cadence.
- **Source qualification:** `selected-source.mjs <dir> <public dir> --paced-testnet` bounds
  source gaps at 30 s instead of 25 s and carries quiet, unsignable polls within that bound.

Live benchmarks B1–B14 are not yet measured; they need the T5 deployment.
